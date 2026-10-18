//! Findings, outcome publication, and proposal review (ADR 0212 §7). A
//! publication is one idempotent batch with fixed provenance; findings are
//! append-only and attributed. Nothing here edits the brief or resolves the
//! question: an Agent's claim is a record, and a change of direction is a
//! `proposal` entry that waits for a researcher decision.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::models::*;
use super::{
    Change, ENTRY_SELECT, ResearchStore, entry_from_row, insert_entry, load_question, load_round,
};

const PUBLICATION_SELECT: &str = "SELECT id, research_id, key, author_kind, author_ref,
        session_id, team_id, task_id, run_id, round_id, brief_revision, created_at
    FROM research_publications";

const FINDING_SELECT: &str = "SELECT f.id, f.research_id, f.publication_id, f.seq, f.kind,
        f.basis, f.statement, f.evidence_json, f.created_at,
        p.author_kind, p.author_ref, p.session_id, p.team_id, p.task_id, p.run_id,
        p.round_id, p.brief_revision
    FROM research_findings f JOIN research_publications p ON p.id = f.publication_id";

impl ResearchStore {
    /// Records one batch of findings and proposals. Repeating a key returns
    /// the stored batch; reusing it with different content is `KeyReuse`.
    /// The batch, its proposals, the event, and the resolution of a Team's
    /// pending outcome commit together or not at all.
    pub fn publish(
        &self,
        project_id: &str,
        id: &str,
        publication: NewPublication,
    ) -> Result<PublishOutcome, ResearchError> {
        let publication = publication.normalized()?;
        let hash = payload_hash(&publication);
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            if let Some((existing_id, existing_hash)) = tx
                .query_row(
                    "SELECT id, payload_hash FROM research_publications
                     WHERE research_id = ?1 AND key = ?2",
                    params![id, publication.key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
            {
                if existing_hash != hash {
                    return Err(ResearchError::KeyReuse);
                }
                let mut outcome = load_publication_outcome(tx, id, &existing_id)?;
                outcome.created = false;
                return Ok((outcome, None));
            }
            if question.archived {
                return Err(ResearchError::Archived);
            }
            // A round pins the revision its work consumed; capture outside
            // a round is attributed to the revision current at the time.
            let brief_revision = match &publication.round_id {
                Some(round_id) => load_round(tx, id, round_id)?.brief_revision,
                None => question.revision,
            };
            let publication_id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO research_publications
                   (id, research_id, key, payload_hash, author_kind, author_ref, session_id,
                    team_id, task_id, run_id, round_id, brief_revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    publication_id,
                    id,
                    publication.key,
                    hash,
                    publication.author_kind.as_str(),
                    publication.author_ref,
                    publication.producer.session_id,
                    publication.producer.team_id,
                    publication.producer.task_id,
                    publication.producer.run_id,
                    publication.round_id,
                    brief_revision as i64,
                ],
            )?;
            let mut seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM research_findings WHERE research_id = ?1",
                [id],
                |row| row.get(0),
            )?;
            for (ordinal, finding) in publication.findings.iter().enumerate() {
                seq += 1;
                // Only evidence makes an observation; everything else is an
                // attributed interpretation, whatever the author called it.
                let basis = if finding.evidence.is_empty() {
                    FindingBasis::Interpretation
                } else {
                    FindingBasis::Observation
                };
                tx.execute(
                    "INSERT INTO research_findings
                       (id, research_id, publication_id, seq, ordinal, kind, basis, statement,
                        evidence_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        Uuid::new_v4().to_string(),
                        id,
                        publication_id,
                        seq,
                        ordinal as i64,
                        finding.kind.as_str(),
                        basis.as_str(),
                        finding.statement,
                        serde_json::to_string(&finding.evidence)?,
                    ],
                )?;
            }
            for (index, proposal) in publication.proposals.iter().enumerate() {
                insert_entry(
                    tx,
                    &question,
                    EntryKind::Proposal,
                    publication.author_kind,
                    publication.author_ref.as_deref(),
                    proposal,
                    // `~` cannot appear in a client-supplied request id, so these keys
                    // never collide with the browser's own entries.
                    Some(&format!("~p:{publication_id}:{index}")),
                )?;
            }
            if let Some(team_id) = &publication.producer.team_id {
                tx.execute(
                    "UPDATE research_pending_outcomes
                     SET status = 'recorded', publication_id = ?3, resolved_at = CURRENT_TIMESTAMP
                     WHERE team_id = ?1 AND research_id = ?2 AND status = 'pending'",
                    params![team_id, id, publication_id],
                )?;
            }
            tx.execute(
                "UPDATE research_questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id],
            )?;
            let mut outcome = load_publication_outcome(tx, id, &publication_id)?;
            outcome.created = true;
            Ok((
                outcome,
                Some((project_id.to_owned(), id.to_owned(), Change::Finding)),
            ))
        })
    }

    /// Whether a batch with this key was already published. Adapters use it
    /// to answer a retry from the stored record even when the evidence the
    /// first attempt cited has since been removed or changed.
    pub fn has_publication(
        &self,
        project_id: &str,
        id: &str,
        key: &str,
    ) -> Result<bool, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let Some(key) = normalize_client_request_id(Some(key))? else {
            return Ok(false);
        };
        Ok(connection
            .query_row(
                "SELECT 1 FROM research_publications WHERE research_id = ?1 AND key = ?2",
                params![id, key],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn findings(&self, project_id: &str, id: &str) -> Result<Vec<Finding>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        load_findings(&connection, id, None)
    }

    /// One finding, looked up by id inside a Project. A finding in another
    /// Project is reported as not found.
    pub fn finding(&self, project_id: &str, finding_id: &str) -> Result<Finding, ResearchError> {
        let connection = self.connection();
        let research_id: Option<String> = connection
            .query_row(
                "SELECT f.research_id FROM research_findings f
                 JOIN research_questions q ON q.id = f.research_id
                 WHERE f.id = ?1 AND q.project_id = ?2",
                params![finding_id, project_id],
                |row| row.get(0),
            )
            .optional()?;
        let research_id = research_id.ok_or(ResearchError::NotFound)?;
        load_findings(&connection, &research_id, None)?
            .into_iter()
            .find(|finding| finding.id == finding_id)
            .ok_or(ResearchError::NotFound)
    }

    /// Completed Teams linked to the question, newest first, with whether
    /// their results have been recorded, declined, or are still pending.
    pub fn outcomes(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Vec<PendingOutcome>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let mut statement = connection.prepare(
            "SELECT team_id, research_id, round_id, status, publication_id, created_at, resolved_at
             FROM research_pending_outcomes WHERE research_id = ?1
             ORDER BY created_at DESC, team_id",
        )?;
        let rows = statement.query_map([id], |row| {
            let status: String = row.get(3)?;
            Ok(PendingOutcome {
                team_id: row.get(0)?,
                research_id: row.get(1)?,
                round_id: row.get(2)?,
                status: OutcomeStatus::parse(&status).unwrap_or(OutcomeStatus::Pending),
                publication_id: row.get(4)?,
                created_at: row.get(5)?,
                resolved_at: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The researcher states that a completed Team has nothing to record.
    /// Idempotent; a recorded outcome cannot be declined.
    pub fn decline_outcome(
        &self,
        project_id: &str,
        id: &str,
        team_id: &str,
    ) -> Result<PendingOutcome, ResearchError> {
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            let status: String = tx
                .query_row(
                    "SELECT status FROM research_pending_outcomes
                     WHERE team_id = ?1 AND research_id = ?2",
                    params![team_id, id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(ResearchError::OutcomeNotFound)?;
            let mut event = None;
            if status == "pending" {
                if question.archived {
                    return Err(ResearchError::Archived);
                }
                tx.execute(
                    "UPDATE research_pending_outcomes
                     SET status = 'declined', resolved_at = CURRENT_TIMESTAMP
                     WHERE team_id = ?1 AND status = 'pending'",
                    [team_id],
                )?;
                event = Some((project_id.to_owned(), id.to_owned(), Change::Outcome));
            } else if status == "recorded" {
                return Err(ResearchError::RoundState("the outcome is already recorded"));
            }
            let outcome = tx.query_row(
                "SELECT team_id, research_id, round_id, status, publication_id, created_at,
                        resolved_at
                 FROM research_pending_outcomes WHERE team_id = ?1",
                [team_id],
                |row| {
                    let status: String = row.get(3)?;
                    Ok(PendingOutcome {
                        team_id: row.get(0)?,
                        research_id: row.get(1)?,
                        round_id: row.get(2)?,
                        status: OutcomeStatus::parse(&status).unwrap_or(OutcomeStatus::Pending),
                        publication_id: row.get(4)?,
                        created_at: row.get(5)?,
                        resolved_at: row.get(6)?,
                    })
                },
            )?;
            Ok((outcome, event))
        })
    }

    /// Proposal entries with the researcher's decision, oldest first.
    pub fn proposals(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Vec<ProposalView>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let mut statement = connection.prepare(&format!(
            "{ENTRY_SELECT} WHERE research_id = ?1 AND kind = 'proposal' ORDER BY seq"
        ))?;
        let entries = statement
            .query_map([id], entry_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        entries
            .into_iter()
            .map(|entry| {
                let review = load_review(&connection, &entry.id)?;
                Ok(ProposalView { entry, review })
            })
            .collect()
    }

    /// Records the researcher's decision on a proposal, plus a `decision`
    /// entry in the log. Accepting never edits the brief: the researcher
    /// makes that change as an ordinary, revisioned brief edit. Repeating
    /// the same decision is a no-op; a different one is a conflict.
    pub fn review_proposal(
        &self,
        project_id: &str,
        id: &str,
        entry_id: &str,
        decision: ReviewDecision,
        note: Option<&str>,
    ) -> Result<ProposalView, ResearchError> {
        let note = note.map(str::trim).filter(|note| !note.is_empty());
        if note.is_some_and(|note| note.chars().count() > MAX_NOTE_CHARS) {
            return Err(ResearchError::Invalid("the note is too long"));
        }
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            let entry = tx
                .query_row(
                    &format!(
                        "{ENTRY_SELECT} WHERE id = ?1 AND research_id = ?2 AND kind = 'proposal'"
                    ),
                    params![entry_id, id],
                    entry_from_row,
                )
                .optional()?
                .ok_or(ResearchError::EntryNotFound)?;
            if let Some(existing) = load_review(tx, entry_id)? {
                if existing.decision != decision {
                    return Err(ResearchError::ReviewConflict);
                }
                return Ok((
                    ProposalView {
                        entry,
                        review: Some(existing),
                    },
                    None,
                ));
            }
            if question.archived {
                return Err(ResearchError::Archived);
            }
            tx.execute(
                "INSERT INTO research_proposal_reviews (entry_id, research_id, decision, note)
                 VALUES (?1, ?2, ?3, ?4)",
                params![entry_id, id, decision.as_str(), note],
            )?;
            let verb = match decision {
                ReviewDecision::Accepted => "Accepted",
                ReviewDecision::Rejected => "Rejected",
            };
            let mut body = format!("{verb} proposal #{}", entry.seq);
            if let Some(note) = note {
                body.push_str(": ");
                body.push_str(note);
            }
            insert_entry(
                tx,
                &question,
                EntryKind::Decision,
                AuthorKind::Researcher,
                None,
                &body,
                Some(&format!("~review:{entry_id}")),
            )?;
            let review = load_review(tx, entry_id)?;
            Ok((
                ProposalView { entry, review },
                Some((project_id.to_owned(), id.to_owned(), Change::Review)),
            ))
        })
    }
}

fn load_review(
    connection: &Connection,
    entry_id: &str,
) -> Result<Option<ProposalReview>, ResearchError> {
    let row = connection
        .query_row(
            "SELECT decision, note, decided_at FROM research_proposal_reviews WHERE entry_id = ?1",
            [entry_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(|(decision, note, decided_at)| {
        ReviewDecision::parse(&decision).map(|decision| ProposalReview {
            entry_id: entry_id.to_owned(),
            decision,
            note,
            decided_at,
        })
    }))
}

/// A digest of what the caller asked to publish. Evidence is reduced to its
/// identity, because a file's revision is filled in at validation time and a
/// legitimate retry must not look like a different request.
fn payload_hash(publication: &NewPublication) -> String {
    let canonical = serde_json::json!({
        "author": [publication.author_kind.as_str(), publication.author_ref],
        "producer": publication.producer,
        "findings": publication.findings.iter().map(|finding| serde_json::json!({
            "kind": finding.kind.as_str(),
            "statement": finding.statement,
            "evidence": finding.evidence.iter().map(|source| (source.kind.as_str(), &source.id)).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "proposals": publication.proposals,
    });
    hex::encode(Sha256::digest(canonical.to_string().as_bytes()))
}

fn load_publication_outcome(
    tx: &Transaction<'_>,
    research_id: &str,
    publication_id: &str,
) -> Result<PublishOutcome, ResearchError> {
    let publication = tx.query_row(
        &format!("{PUBLICATION_SELECT} WHERE id = ?1 AND research_id = ?2"),
        params![publication_id, research_id],
        publication_from_row,
    )?;
    let findings = load_findings(tx, research_id, Some(publication_id))?;
    let mut statement = tx.prepare(&format!(
        "{ENTRY_SELECT} WHERE research_id = ?1 AND client_request_id LIKE ?2 ESCAPE '\\' ORDER BY seq"
    ))?;
    let pattern = format!("~p:{}:%", escape_like(&publication.id));
    let proposals = statement
        .query_map(params![research_id, pattern], entry_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PublishOutcome {
        publication,
        findings,
        proposals,
        created: true,
    })
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn publication_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Publication> {
    let author: String = row.get(3)?;
    Ok(Publication {
        id: row.get(0)?,
        research_id: row.get(1)?,
        key: row.get(2)?,
        author_kind: AuthorKind::parse(&author).unwrap_or(AuthorKind::System),
        author_ref: row.get(4)?,
        producer: Producer {
            session_id: row.get(5)?,
            team_id: row.get(6)?,
            task_id: row.get(7)?,
            run_id: row.get(8)?,
        },
        round_id: row.get(9)?,
        brief_revision: row.get::<_, i64>(10)? as u64,
        created_at: row.get(11)?,
    })
}

fn load_findings(
    connection: &Connection,
    research_id: &str,
    publication_id: Option<&str>,
) -> Result<Vec<Finding>, ResearchError> {
    let mut statement = connection.prepare(&format!(
        "{FINDING_SELECT} WHERE f.research_id = ?1 AND (?2 IS NULL OR f.publication_id = ?2)
         ORDER BY f.seq"
    ))?;
    let rows = statement.query_map(params![research_id, publication_id], |row| {
        let kind: String = row.get(4)?;
        let basis: String = row.get(5)?;
        let evidence: String = row.get(7)?;
        let author: String = row.get(9)?;
        Ok((
            Finding {
                id: row.get(0)?,
                research_id: row.get(1)?,
                publication_id: row.get(2)?,
                seq: row.get::<_, i64>(3)? as u64,
                kind: FindingKind::parse(&kind).unwrap_or(FindingKind::Finding),
                basis: FindingBasis::parse(&basis).unwrap_or(FindingBasis::Interpretation),
                statement: row.get(6)?,
                evidence: Vec::new(),
                author_kind: AuthorKind::parse(&author).unwrap_or(AuthorKind::System),
                author_ref: row.get(10)?,
                producer: Producer {
                    session_id: row.get(11)?,
                    team_id: row.get(12)?,
                    task_id: row.get(13)?,
                    run_id: row.get(14)?,
                },
                round_id: row.get(15)?,
                brief_revision: row.get::<_, i64>(16)? as u64,
                created_at: row.get(8)?,
            },
            evidence,
        ))
    })?;
    rows.map(|row| {
        let (mut finding, evidence) = row?;
        finding.evidence = serde_json::from_str(&evidence)?;
        Ok(finding)
    })
    .collect()
}
