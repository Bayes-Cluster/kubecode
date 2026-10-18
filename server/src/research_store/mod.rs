//! Project-scoped research questions (ADR 0212): the durable home for a
//! research brief and its immutable revisions, the attributed entry log, and
//! associations to Sessions and Teams. The store shares the Runtime's single
//! SQLite owner (ADR 0200) and commits every `research_updated` workspace
//! event in the same transaction as the change it announces (ADR 0205), so a
//! browser that reloads or reconnects converges by refetching.
//!
//! Nothing here starts an Agent: saving, editing, discussing, or linking is
//! pure persistence. Every lookup is scoped by Project id, so a research
//! question in another Project is indistinguishable from a missing one.

mod findings;
mod models;

pub use models::*;

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::json;
use uuid::Uuid;

use crate::agent_store::AgentStore;
use crate::database::Database;

pub struct ResearchStore {
    database: Arc<Database>,
    agents: Arc<AgentStore>,
}

/// What changed, for the content-free `research_updated` event payload.
#[derive(Clone, Copy, Debug)]
enum Change {
    Created,
    Brief,
    Status,
    Archived,
    Restored,
    Entry,
    Link,
    Unlink,
    Round,
    Finding,
    Outcome,
    Review,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Brief => "brief",
            Self::Status => "status",
            Self::Archived => "archived",
            Self::Restored => "restored",
            Self::Entry => "entry",
            Self::Link => "link",
            Self::Unlink => "unlink",
            Self::Round => "round",
            Self::Finding => "finding",
            Self::Outcome => "outcome",
            Self::Review => "review",
        }
    }
}

/// Creates the research tables. `TeamStore` calls this too: completing a
/// linked Team writes a pending outcome in the Team's own transaction, so
/// the table must exist wherever that transaction can run.
pub(crate) fn ensure_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS research_questions (
                   id                TEXT PRIMARY KEY,
                   project_id        TEXT NOT NULL,
                   client_request_id TEXT,
                   status            TEXT NOT NULL DEFAULT 'open',
                   archived          INTEGER NOT NULL DEFAULT 0,
                   revision          INTEGER NOT NULL DEFAULT 1,
                   title             TEXT NOT NULL,
                   brief_json        TEXT NOT NULL,
                   resolved_at       TEXT,
                   created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE INDEX IF NOT EXISTS research_questions_project
                   ON research_questions(project_id, archived, updated_at);
                 CREATE UNIQUE INDEX IF NOT EXISTS research_questions_request
                   ON research_questions(project_id, client_request_id)
                   WHERE client_request_id IS NOT NULL;
                 -- Immutable: revisions are never updated or pruned, because
                 -- rounds and findings cite them by number (ADR 0212 §2).
                 CREATE TABLE IF NOT EXISTS research_brief_revisions (
                   research_id TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   revision    INTEGER NOT NULL,
                   brief_json  TEXT NOT NULL,
                   author_kind TEXT NOT NULL,
                   author_ref  TEXT,
                   note        TEXT,
                   created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   PRIMARY KEY (research_id, revision)
                 );
                 -- Append-only, per-RQ sequenced log of attributed entries.
                 CREATE TABLE IF NOT EXISTS research_entries (
                   id                TEXT PRIMARY KEY,
                   research_id       TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   seq               INTEGER NOT NULL,
                   kind              TEXT NOT NULL,
                   author_kind       TEXT NOT NULL,
                   author_ref        TEXT,
                   body              TEXT NOT NULL,
                   brief_revision    INTEGER NOT NULL,
                   client_request_id TEXT,
                   created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   UNIQUE (research_id, seq)
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS research_entries_request
                   ON research_entries(research_id, client_request_id)
                   WHERE client_request_id IS NOT NULL;
                 -- A Session or Team is linked to at most one RQ.
                 CREATE TABLE IF NOT EXISTS research_links (
                   research_id TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   kind        TEXT NOT NULL,
                   ref_id      TEXT NOT NULL,
                   role        TEXT NOT NULL,
                   created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   PRIMARY KEY (research_id, kind, ref_id),
                   UNIQUE (kind, ref_id)
                 );
                 -- One explicit work request per row; the brief revision it
                 -- consumed is pinned here (ADR 0212 §6).
                 CREATE TABLE IF NOT EXISTS research_rounds (
                   id               TEXT PRIMARY KEY,
                   research_id      TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   round            INTEGER NOT NULL,
                   brief_revision   INTEGER NOT NULL,
                   kind             TEXT NOT NULL,
                   phase            TEXT NOT NULL DEFAULT 'created',
                   idempotency_key  TEXT NOT NULL,
                   session_id       TEXT,
                   team_id          TEXT,
                   request_json     TEXT NOT NULL,
                   sources_json     TEXT NOT NULL DEFAULT '[]',
                   created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   UNIQUE (research_id, round),
                   UNIQUE (research_id, idempotency_key)
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS research_rounds_team
                   ON research_rounds(team_id) WHERE team_id IS NOT NULL;
                 -- One batch of findings per idempotency key. Provenance
                 -- (the producing execution) is recorded once per batch.
                 CREATE TABLE IF NOT EXISTS research_publications (
                   id             TEXT PRIMARY KEY,
                   research_id    TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   key            TEXT NOT NULL,
                   payload_hash   TEXT NOT NULL,
                   author_kind    TEXT NOT NULL,
                   author_ref     TEXT,
                   session_id     TEXT,
                   team_id        TEXT,
                   task_id        TEXT,
                   run_id         TEXT,
                   round_id       TEXT,
                   brief_revision INTEGER NOT NULL,
                   created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   UNIQUE (research_id, key)
                 );
                 CREATE TABLE IF NOT EXISTS research_findings (
                   id             TEXT PRIMARY KEY,
                   research_id    TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   publication_id TEXT NOT NULL REFERENCES research_publications(id) ON DELETE CASCADE,
                   seq            INTEGER NOT NULL,
                   ordinal        INTEGER NOT NULL,
                   kind           TEXT NOT NULL,
                   basis          TEXT NOT NULL,
                   statement      TEXT NOT NULL,
                   evidence_json  TEXT NOT NULL DEFAULT '[]',
                   created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   UNIQUE (research_id, seq),
                   UNIQUE (publication_id, ordinal)
                 );
                 -- Created in the transaction that completes a linked Team.
                 CREATE TABLE IF NOT EXISTS research_pending_outcomes (
                   team_id        TEXT PRIMARY KEY,
                   research_id    TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   round_id       TEXT,
                   status         TEXT NOT NULL DEFAULT 'pending',
                   publication_id TEXT,
                   created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   resolved_at    TEXT
                 );
                 CREATE TABLE IF NOT EXISTS research_proposal_reviews (
                   entry_id    TEXT PRIMARY KEY REFERENCES research_entries(id) ON DELETE CASCADE,
                   research_id TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   decision    TEXT NOT NULL,
                   note        TEXT,
                   decided_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );",
    )
}

impl ResearchStore {
    pub fn from_database(
        database: Arc<Database>,
        agents: Arc<AgentStore>,
    ) -> Result<Self, ResearchError> {
        {
            let connection = database.lock().expect("research database mutex poisoned");
            ensure_schema(&connection)?;
        }
        Ok(Self { database, agents })
    }

    /// Announces events committed by another store's transaction (a Team
    /// completion writes a pending outcome and its event itself), so open
    /// browsers refetch without waiting for the next unrelated event.
    pub fn announce_committed(&self) {
        if let Ok(latest) = self.agents.latest_workspace_event_id() {
            self.agents.workspace_event_bus().publish_committed(latest);
        }
    }

    // -- Questions -----------------------------------------------------------

    /// Creates a question with revision 1. A repeated `client_request_id` in
    /// the same Project returns the original and reports `created = false`.
    pub fn create(
        &self,
        project_id: &str,
        brief: ResearchBrief,
        client_request_id: Option<&str>,
    ) -> Result<(ResearchQuestion, bool), ResearchError> {
        let brief = brief.normalized()?;
        let request_id = normalize_client_request_id(client_request_id)?;
        self.write(|tx| {
            if let Some(request_id) = &request_id
                && let Some(existing) = tx
                    .query_row(
                        "SELECT id FROM research_questions
                         WHERE project_id = ?1 AND client_request_id = ?2",
                        params![project_id, request_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
            {
                return Ok(((load_question(tx, project_id, &existing)?, false), None));
            }
            let id = Uuid::new_v4().to_string();
            let brief_json = serde_json::to_string(&brief)?;
            tx.execute(
                "INSERT INTO research_questions
                   (id, project_id, client_request_id, title, brief_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, project_id, request_id, brief.title, brief_json],
            )?;
            tx.execute(
                "INSERT INTO research_brief_revisions
                   (research_id, revision, brief_json, author_kind)
                 VALUES (?1, 1, ?2, 'researcher')",
                params![id, brief_json],
            )?;
            let question = load_question(tx, project_id, &id)?;
            Ok((
                (question, true),
                Some((project_id.to_owned(), id, Change::Created)),
            ))
        })
    }

    pub fn get(&self, project_id: &str, id: &str) -> Result<ResearchQuestion, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)
    }

    pub fn list(
        &self,
        project_id: &str,
        include_archived: bool,
    ) -> Result<Vec<ResearchSummary>, ResearchError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT q.id, q.project_id, q.title, q.status, q.archived, q.revision,
                    (SELECT COUNT(*) FROM research_entries e WHERE e.research_id = q.id),
                    (SELECT COUNT(*) FROM research_links l WHERE l.research_id = q.id),
                    q.updated_at
             FROM research_questions q
             WHERE q.project_id = ?1 AND (?2 OR q.archived = 0)
             ORDER BY q.archived, q.updated_at DESC, q.id",
        )?;
        let rows = statement.query_map(params![project_id, include_archived], |row| {
            let status: String = row.get(3)?;
            Ok(ResearchSummary {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                status: ResearchStatus::parse(&status).unwrap_or(ResearchStatus::Open),
                archived: row.get::<_, i64>(4)? != 0,
                revision: row.get::<_, i64>(5)? as u64,
                entry_count: row.get::<_, i64>(6)? as u64,
                link_count: row.get::<_, i64>(7)? as u64,
                updated_at: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Applies a brief edit under optimistic concurrency. Returns the
    /// question and whether a new revision was written; an edit that changes
    /// nothing writes nothing.
    pub fn update_brief(
        &self,
        project_id: &str,
        id: &str,
        expected_revision: u64,
        patch: &BriefPatch,
        note: Option<&str>,
    ) -> Result<(ResearchQuestion, bool), ResearchError> {
        let note = note
            .map(str::trim)
            .filter(|note| !note.is_empty())
            .map(str::to_owned);
        if note
            .as_deref()
            .is_some_and(|note| note.chars().count() > MAX_NOTE_CHARS)
        {
            return Err(ResearchError::Invalid("the revision note is too long"));
        }
        self.write(|tx| {
            let current = load_question(tx, project_id, id)?;
            if current.archived {
                return Err(ResearchError::Archived);
            }
            if current.revision != expected_revision {
                return Err(ResearchError::RevisionConflict {
                    current: current.revision,
                });
            }
            let next = current.brief.patched(patch)?;
            if next == current.brief {
                return Ok(((current, false), None));
            }
            let brief_json = serde_json::to_string(&next)?;
            let revision = current.revision + 1;
            tx.execute(
                "UPDATE research_questions
                 SET revision = ?2, title = ?3, brief_json = ?4, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, revision as i64, next.title, brief_json],
            )?;
            tx.execute(
                "INSERT INTO research_brief_revisions
                   (research_id, revision, brief_json, author_kind, note)
                 VALUES (?1, ?2, ?3, 'researcher', ?4)",
                params![id, revision as i64, brief_json, note],
            )?;
            let question = load_question(tx, project_id, id)?;
            Ok((
                (question, true),
                Some((project_id.to_owned(), id.to_owned(), Change::Brief)),
            ))
        })
    }

    /// Idempotent: archiving an archived question (or restoring a live one)
    /// succeeds without effect and publishes nothing.
    pub fn set_archived(
        &self,
        project_id: &str,
        id: &str,
        archived: bool,
    ) -> Result<ResearchQuestion, ResearchError> {
        self.write(|tx| {
            let current = load_question(tx, project_id, id)?;
            if current.archived == archived {
                return Ok((current, None));
            }
            tx.execute(
                "UPDATE research_questions
                 SET archived = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![id, archived],
            )?;
            let change = if archived {
                Change::Archived
            } else {
                Change::Restored
            };
            Ok((
                load_question(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), change)),
            ))
        })
    }

    /// Idempotent researcher decision; never a side effect of Team
    /// completion (ADR 0212 §1).
    pub fn set_status(
        &self,
        project_id: &str,
        id: &str,
        status: ResearchStatus,
    ) -> Result<ResearchQuestion, ResearchError> {
        self.write(|tx| {
            let current = load_question(tx, project_id, id)?;
            if current.archived {
                return Err(ResearchError::Archived);
            }
            if current.status == status {
                return Ok((current, None));
            }
            tx.execute(
                "UPDATE research_questions
                 SET status = ?2,
                     resolved_at = CASE WHEN ?2 = 'resolved' THEN CURRENT_TIMESTAMP ELSE NULL END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, status.as_str()],
            )?;
            Ok((
                load_question(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Status)),
            ))
        })
    }

    // -- Revisions -----------------------------------------------------------

    pub fn revisions(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Vec<RevisionSummary>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let mut statement = connection.prepare(
            "SELECT revision, brief_json, author_kind, note, created_at
             FROM research_brief_revisions WHERE research_id = ?1 ORDER BY revision DESC",
        )?;
        let rows = statement.query_map([id], |row| {
            let brief_json: String = row.get(1)?;
            let author: String = row.get(2)?;
            Ok((
                row.get::<_, i64>(0)?,
                brief_json,
                author,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut summaries = Vec::new();
        for row in rows {
            let (revision, brief_json, author, note, created_at) = row?;
            let brief: ResearchBrief = serde_json::from_str(&brief_json)?;
            summaries.push(RevisionSummary {
                revision: revision as u64,
                title: brief.title,
                author_kind: AuthorKind::parse(&author).unwrap_or(AuthorKind::Researcher),
                note,
                created_at,
            });
        }
        Ok(summaries)
    }

    pub fn revision(
        &self,
        project_id: &str,
        id: &str,
        revision: u64,
    ) -> Result<BriefRevision, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        load_revision(&connection, id, revision)
    }

    // -- Entries -------------------------------------------------------------

    /// Appends an entry. A repeated `client_request_id` returns the original.
    /// Callers decide which kinds and authors are permitted; the browser API
    /// only passes researcher `note` / `decision` entries.
    pub fn add_entry(
        &self,
        project_id: &str,
        id: &str,
        entry: NewEntry,
    ) -> Result<ResearchEntry, ResearchError> {
        let body = entry.body.trim().to_owned();
        if body.is_empty() {
            return Err(ResearchError::Invalid("an entry body is required"));
        }
        if body.chars().count() > MAX_ENTRY_CHARS {
            return Err(ResearchError::Invalid("the entry is too long"));
        }
        let request_id = normalize_client_request_id(entry.client_request_id.as_deref())?;
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            if question.archived {
                return Err(ResearchError::Archived);
            }
            if let Some(request_id) = &request_id
                && let Some(existing) = tx
                    .query_row(
                        &format!(
                            "{ENTRY_SELECT} WHERE research_id = ?1 AND client_request_id = ?2"
                        ),
                        params![id, request_id],
                        entry_from_row,
                    )
                    .optional()?
            {
                return Ok((existing, None));
            }
            let stored = insert_entry(
                tx,
                &question,
                entry.kind,
                entry.author_kind,
                entry.author_ref.as_deref(),
                &body,
                request_id.as_deref(),
            )?;
            Ok((
                stored,
                Some((project_id.to_owned(), id.to_owned(), Change::Entry)),
            ))
        })
    }

    /// Entries after `after_seq` in sequence order, at most `limit`
    /// (default 100, maximum 500).
    pub fn entries(
        &self,
        project_id: &str,
        id: &str,
        after_seq: u64,
        limit: Option<usize>,
    ) -> Result<Vec<ResearchEntry>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let limit = limit.unwrap_or(DEFAULT_ENTRY_PAGE).clamp(1, MAX_ENTRY_PAGE);
        let mut statement = connection.prepare(&format!(
            "{ENTRY_SELECT} WHERE research_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3"
        ))?;
        let rows =
            statement.query_map(params![id, after_seq as i64, limit as i64], entry_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    // -- Links ---------------------------------------------------------------

    /// Associates a Session or Team with the question. The caller has
    /// already verified the target exists in the same Project. Idempotent for
    /// the same target; a different role on the same target updates the role;
    /// a target linked to another question is a conflict, never a move.
    pub fn link(
        &self,
        project_id: &str,
        id: &str,
        kind: LinkKind,
        ref_id: &str,
        role: LinkRole,
    ) -> Result<ResearchLink, ResearchError> {
        let ref_id = ref_id.trim();
        if ref_id.is_empty() || ref_id.chars().count() > MAX_CLIENT_REQUEST_ID_CHARS {
            return Err(ResearchError::InvalidLinkTarget);
        }
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            if question.archived {
                return Err(ResearchError::Archived);
            }
            let existing = tx
                .query_row(
                    "SELECT research_id, role FROM research_links WHERE kind = ?1 AND ref_id = ?2",
                    params![kind.as_str(), ref_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let change = match existing {
                Some((owner, _)) if owner != id => {
                    return Err(ResearchError::LinkConflict {
                        kind: kind.as_str(),
                    });
                }
                Some((_, current_role)) if current_role == role.as_str() => None,
                Some(_) => {
                    tx.execute(
                        "UPDATE research_links SET role = ?4
                         WHERE research_id = ?1 AND kind = ?2 AND ref_id = ?3",
                        params![id, kind.as_str(), ref_id, role.as_str()],
                    )?;
                    Some((project_id.to_owned(), id.to_owned(), Change::Link))
                }
                None => {
                    tx.execute(
                        "INSERT INTO research_links (research_id, kind, ref_id, role)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![id, kind.as_str(), ref_id, role.as_str()],
                    )?;
                    Some((project_id.to_owned(), id.to_owned(), Change::Link))
                }
            };
            if change.is_some() {
                tx.execute(
                    "UPDATE research_questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                    [id],
                )?;
            }
            let link = tx.query_row(
                &format!("{LINK_SELECT} WHERE research_id = ?1 AND kind = ?2 AND ref_id = ?3"),
                params![id, kind.as_str(), ref_id],
                link_from_row,
            )?;
            Ok((link, change))
        })
    }

    /// Removes the association only. Allowed on archived questions so a
    /// Session or Team can be released for another question.
    pub fn unlink(
        &self,
        project_id: &str,
        id: &str,
        kind: LinkKind,
        ref_id: &str,
    ) -> Result<bool, ResearchError> {
        self.write(|tx| {
            load_question(tx, project_id, id)?;
            let removed = tx.execute(
                "DELETE FROM research_links WHERE research_id = ?1 AND kind = ?2 AND ref_id = ?3",
                params![id, kind.as_str(), ref_id],
            )?;
            if removed == 0 {
                return Ok((false, None));
            }
            tx.execute(
                "UPDATE research_questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id],
            )?;
            Ok((
                true,
                Some((project_id.to_owned(), id.to_owned(), Change::Unlink)),
            ))
        })
    }

    pub fn links(&self, project_id: &str, id: &str) -> Result<Vec<ResearchLink>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let mut statement = connection.prepare(&format!(
            "{LINK_SELECT} WHERE research_id = ?1 ORDER BY created_at, kind, ref_id"
        ))?;
        let rows = statement.query_map([id], link_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The question (and Project) a Session or Team is linked to, if any.
    pub fn link_for(
        &self,
        kind: LinkKind,
        ref_id: &str,
    ) -> Result<Option<(String, ResearchLink)>, ResearchError> {
        let connection = self.connection();
        let row = connection
            .query_row(
                "SELECT q.project_id, l.research_id, l.kind, l.ref_id, l.role, l.created_at
                 FROM research_links l JOIN research_questions q ON q.id = l.research_id
                 WHERE l.kind = ?1 AND l.ref_id = ?2",
                params![kind.as_str(), ref_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        ResearchLink {
                            research_id: row.get(1)?,
                            kind: LinkKind::parse(&row.get::<_, String>(2)?)
                                .unwrap_or(LinkKind::Session),
                            ref_id: row.get(3)?,
                            role: LinkRole::parse(&row.get::<_, String>(4)?)
                                .unwrap_or(LinkRole::Discussion),
                            created_at: row.get(5)?,
                        },
                    ))
                },
            )
            .optional()?;
        Ok(row)
    }

    // -- Rounds ----------------------------------------------------------------

    /// Records an explicit work request, pinning the current brief revision.
    /// A repeated key returns the original round (`created = false`) even if
    /// the brief has since changed; reusing a key for a *different* request
    /// is refused. A new round must be created against the revision the
    /// researcher saw (`expected_revision`).
    /// The round started under an idempotency key, if any.
    pub fn round_by_key(
        &self,
        project_id: &str,
        id: &str,
        key: &str,
    ) -> Result<Option<ResearchRound>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let Some(key) = normalize_client_request_id(Some(key))? else {
            return Ok(None);
        };
        connection
            .query_row(
                &format!("{ROUND_SELECT} WHERE research_id = ?1 AND idempotency_key = ?2"),
                params![id, key],
                round_from_row,
            )
            .optional()?
            .transpose()
    }

    pub fn begin_round(
        &self,
        project_id: &str,
        id: &str,
        new: NewRound<'_>,
    ) -> Result<(ResearchRound, bool), ResearchError> {
        let key = normalize_client_request_id(Some(new.idempotency_key))?
            .ok_or(ResearchError::Invalid("a request key is required"))?;
        if new.sources.len() > MAX_ROUND_SOURCES {
            return Err(ResearchError::Invalid("too many sources"));
        }
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            if let Some(existing) = tx
                .query_row(
                    &format!("{ROUND_SELECT} WHERE research_id = ?1 AND idempotency_key = ?2"),
                    params![id, key],
                    round_from_row,
                )
                .optional()?
            {
                let existing = existing?;
                // The request fingerprint covers what the client asked for;
                // resolved defaults and file revisions may legitimately differ
                // on a replay.
                if existing.kind != new.kind
                    || existing.request.get("fingerprint") != new.request.get("fingerprint")
                {
                    return Err(ResearchError::KeyReuse);
                }
                return Ok(((existing, false), None));
            }
            if question.archived {
                return Err(ResearchError::Archived);
            }
            if question.revision != new.expected_revision {
                return Err(ResearchError::RevisionConflict {
                    current: question.revision,
                });
            }
            let round_id = Uuid::new_v4().to_string();
            let number: i64 = tx.query_row(
                "SELECT COALESCE(MAX(round), 0) + 1 FROM research_rounds WHERE research_id = ?1",
                [id],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO research_rounds
                   (id, research_id, round, brief_revision, kind, idempotency_key,
                    request_json, sources_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    round_id,
                    id,
                    number,
                    question.revision as i64,
                    new.kind.as_str(),
                    key,
                    serde_json::to_string(&new.request)?,
                    serde_json::to_string(&new.sources)?,
                ],
            )?;
            touch(tx, id)?;
            let round = tx.query_row(
                &format!("{ROUND_SELECT} WHERE id = ?1"),
                [&round_id],
                round_from_row,
            )??;
            Ok((
                (round, true),
                Some((project_id.to_owned(), id.to_owned(), Change::Round)),
            ))
        })
    }

    /// Records the Leader or Solo Session. Idempotent for the same Session.
    /// A Solo round also links its Session as execution unless the Session is
    /// already linked to this question (its existing role is kept).
    pub fn round_set_session(
        &self,
        project_id: &str,
        id: &str,
        round_id: &str,
        session_id: &str,
    ) -> Result<ResearchRound, ResearchError> {
        self.write(|tx| {
            load_question(tx, project_id, id)?;
            let round = load_round(tx, id, round_id)?;
            match round.session_id.as_deref() {
                Some(existing) if existing == session_id => return Ok((round, None)),
                Some(_) => {
                    return Err(ResearchError::RoundState(
                        "the round already has a different Session",
                    ));
                }
                None => {}
            }
            if round.phase != RoundPhase::Created {
                return Err(ResearchError::RoundState("the round has already advanced"));
            }
            tx.execute(
                "UPDATE research_rounds
                 SET session_id = ?2, phase = 'session_ready', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![round_id, session_id],
            )?;
            if round.kind == RoundKind::Solo {
                link_if_absent(tx, id, LinkKind::Session, session_id, LinkRole::Execution)?;
            }
            touch(tx, id)?;
            Ok((
                load_round(tx, id, round_id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Round)),
            ))
        })
    }

    /// Records the Team created for the round and links it as execution.
    /// Idempotent for the same Team.
    pub fn round_attach_team(
        &self,
        project_id: &str,
        id: &str,
        round_id: &str,
        team_id: &str,
    ) -> Result<ResearchRound, ResearchError> {
        self.write(|tx| {
            load_question(tx, project_id, id)?;
            let round = load_round(tx, id, round_id)?;
            match round.team_id.as_deref() {
                Some(existing) if existing == team_id => return Ok((round, None)),
                Some(_) => {
                    return Err(ResearchError::RoundState(
                        "the round already has a different Team",
                    ));
                }
                None => {}
            }
            if round.kind != RoundKind::Team || round.phase == RoundPhase::Started {
                return Err(ResearchError::RoundState("the round cannot take a Team"));
            }
            tx.execute(
                "UPDATE research_rounds
                 SET team_id = ?2, phase = 'team_created', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![round_id, team_id],
            )?;
            link_if_absent(tx, id, LinkKind::Team, team_id, LinkRole::Execution)?;
            touch(tx, id)?;
            Ok((
                load_round(tx, id, round_id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Round)),
            ))
        })
    }

    /// Marks setup complete and logs it once.
    pub fn round_mark_started(
        &self,
        project_id: &str,
        id: &str,
        round_id: &str,
    ) -> Result<ResearchRound, ResearchError> {
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            let round = load_round(tx, id, round_id)?;
            if round.phase == RoundPhase::Started {
                return Ok((round, None));
            }
            tx.execute(
                "UPDATE research_rounds
                 SET phase = 'started', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [round_id],
            )?;
            let seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM research_entries WHERE research_id = ?1",
                [id],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO research_entries
                   (id, research_id, seq, kind, author_kind, body, brief_revision, client_request_id)
                 VALUES (?1, ?2, ?3, 'note', 'system', ?4, ?5, ?6)",
                params![
                    Uuid::new_v4().to_string(),
                    id,
                    seq,
                    format!(
                        "Round {} started with brief revision {}.",
                        round.round, round.brief_revision
                    ),
                    question.revision as i64,
                    format!("round-{round_id}-started"),
                ],
            )?;
            touch(tx, id)?;
            Ok((
                load_round(tx, id, round_id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Round)),
            ))
        })
    }

    pub fn rounds(&self, project_id: &str, id: &str) -> Result<Vec<ResearchRound>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let mut statement = connection.prepare(&format!(
            "{ROUND_SELECT} WHERE research_id = ?1 ORDER BY round DESC"
        ))?;
        let rows = statement.query_map([id], round_from_row)?;
        let mut rounds = Vec::new();
        for row in rows {
            rounds.push(row??);
        }
        Ok(rounds)
    }

    pub fn round(
        &self,
        project_id: &str,
        id: &str,
        round_id: &str,
    ) -> Result<ResearchRound, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        load_round(&connection, id, round_id)
    }

    /// A round looked up by id alone, inside a Project. A round of another
    /// Project is reported as not found.
    pub fn round_by_id(
        &self,
        project_id: &str,
        round_id: &str,
    ) -> Result<ResearchRound, ResearchError> {
        let connection = self.connection();
        let research_id: Option<String> = connection
            .query_row(
                "SELECT r.research_id FROM research_rounds r
                 JOIN research_questions q ON q.id = r.research_id
                 WHERE r.id = ?1 AND q.project_id = ?2",
                params![round_id, project_id],
                |row| row.get(0),
            )
            .optional()?;
        let research_id = research_id.ok_or(ResearchError::RoundNotFound)?;
        load_round(&connection, &research_id, round_id)
    }

    /// The round (and Project) that created or owns a Team, if any.
    pub fn round_for_team(
        &self,
        team_id: &str,
    ) -> Result<Option<(String, ResearchRound)>, ResearchError> {
        let connection = self.connection();
        let row = connection
            .query_row(
                "SELECT q.project_id, r.id, r.research_id, r.round, r.brief_revision, r.kind,
                        r.phase, r.session_id, r.team_id, r.request_json, r.sources_json,
                        r.created_at, r.updated_at
                 FROM research_rounds r JOIN research_questions q ON q.id = r.research_id
                 WHERE r.team_id = ?1",
                [team_id],
                |row| {
                    let project: String = row.get(0)?;
                    Ok((project, round_from_offset_row(row, 1)))
                },
            )
            .optional()?;
        match row {
            Some((project, round)) => Ok(Some((project, round?))),
            None => Ok(None),
        }
    }

    // -- Plumbing --------------------------------------------------------------

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.database
            .lock()
            .expect("research database mutex poisoned")
    }

    /// Runs `operation` in one immediate transaction. When it names a change,
    /// the `research_updated` event commits with it and is published after.
    fn write<T>(
        &self,
        operation: impl FnOnce(
            &Transaction<'_>,
        ) -> Result<(T, Option<(String, String, Change)>), ResearchError>,
    ) -> Result<T, ResearchError> {
        let mut connection = self.connection();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (value, change) = operation(&transaction)?;
        let cursor = match change {
            Some((project_id, research_id, change)) => {
                transaction.execute(
                    "INSERT INTO workspace_events (kind, project_id, payload)
                     VALUES ('research_updated', ?1, ?2)",
                    params![
                        project_id,
                        json!({"research_id": research_id, "change": change.as_str()}).to_string()
                    ],
                )?;
                Some(transaction.last_insert_rowid() as u64)
            }
            None => None,
        };
        transaction.commit()?;
        drop(connection);
        if let Some(cursor) = cursor {
            self.agents.workspace_event_bus().publish_committed(cursor);
        }
        Ok(value)
    }
}

/// Appends one entry to the question's log and bumps its `updated_at`.
/// Callers run inside their own write transaction and have already checked
/// that the question is writable and that `request_id` is new.
fn insert_entry(
    tx: &Transaction<'_>,
    question: &ResearchQuestion,
    kind: EntryKind,
    author_kind: AuthorKind,
    author_ref: Option<&str>,
    body: &str,
    request_id: Option<&str>,
) -> Result<ResearchEntry, ResearchError> {
    let seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM research_entries WHERE research_id = ?1",
        [&question.id],
        |row| row.get(0),
    )?;
    let entry_id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO research_entries
           (id, research_id, seq, kind, author_kind, author_ref, body,
            brief_revision, client_request_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            entry_id,
            question.id,
            seq,
            kind.as_str(),
            author_kind.as_str(),
            author_ref,
            body,
            question.revision as i64,
            request_id,
        ],
    )?;
    tx.execute(
        "UPDATE research_questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [&question.id],
    )?;
    Ok(tx.query_row(
        &format!("{ENTRY_SELECT} WHERE id = ?1"),
        [&entry_id],
        entry_from_row,
    )?)
}

const ROUND_SELECT: &str = "SELECT id, research_id, round, brief_revision, kind, phase,
                                   session_id, team_id, request_json, sources_json,
                                   created_at, updated_at FROM research_rounds";

/// Decodes a round row; stored JSON is validated here, so a corrupt row is
/// a typed error rather than a panic.
fn round_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<ResearchRound, ResearchError>> {
    Ok(round_from_offset_row(row, 0))
}

fn round_from_offset_row(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> Result<ResearchRound, ResearchError> {
    let request_json: String = row.get(offset + 8)?;
    let sources_json: String = row.get(offset + 9)?;
    Ok(ResearchRound {
        id: row.get(offset)?,
        research_id: row.get(offset + 1)?,
        round: row.get::<_, i64>(offset + 2)? as u64,
        brief_revision: row.get::<_, i64>(offset + 3)? as u64,
        kind: RoundKind::parse(&row.get::<_, String>(offset + 4)?).unwrap_or(RoundKind::Team),
        phase: RoundPhase::parse(&row.get::<_, String>(offset + 5)?).unwrap_or(RoundPhase::Created),
        session_id: row.get(offset + 6)?,
        team_id: row.get(offset + 7)?,
        request: serde_json::from_str(&request_json)?,
        sources: serde_json::from_str(&sources_json)?,
        created_at: row.get(offset + 10)?,
        updated_at: row.get(offset + 11)?,
    })
}

fn load_round(
    connection: &Connection,
    research_id: &str,
    round_id: &str,
) -> Result<ResearchRound, ResearchError> {
    connection
        .query_row(
            &format!("{ROUND_SELECT} WHERE id = ?1 AND research_id = ?2"),
            params![round_id, research_id],
            round_from_row,
        )
        .optional()?
        .ok_or(ResearchError::RoundNotFound)?
}

fn touch(tx: &Transaction<'_>, id: &str) -> Result<(), ResearchError> {
    tx.execute(
        "UPDATE research_questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// Links a target unless it is already linked to this question; an existing
/// link (and its role) is kept. A target owned by another question is a
/// conflict.
fn link_if_absent(
    tx: &Transaction<'_>,
    id: &str,
    kind: LinkKind,
    ref_id: &str,
    role: LinkRole,
) -> Result<(), ResearchError> {
    let owner = tx
        .query_row(
            "SELECT research_id FROM research_links WHERE kind = ?1 AND ref_id = ?2",
            params![kind.as_str(), ref_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner != id => Err(ResearchError::LinkConflict {
            kind: kind.as_str(),
        }),
        Some(_) => Ok(()),
        None => {
            tx.execute(
                "INSERT INTO research_links (research_id, kind, ref_id, role)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, kind.as_str(), ref_id, role.as_str()],
            )?;
            Ok(())
        }
    }
}

const ENTRY_SELECT: &str = "SELECT id, research_id, seq, kind, author_kind, author_ref, body,
                                   brief_revision, created_at FROM research_entries";
const LINK_SELECT: &str = "SELECT research_id, kind, ref_id, role, created_at FROM research_links";

fn entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResearchEntry> {
    Ok(ResearchEntry {
        id: row.get(0)?,
        research_id: row.get(1)?,
        seq: row.get::<_, i64>(2)? as u64,
        kind: EntryKind::parse(&row.get::<_, String>(3)?).unwrap_or(EntryKind::Note),
        author_kind: AuthorKind::parse(&row.get::<_, String>(4)?).unwrap_or(AuthorKind::Researcher),
        author_ref: row.get(5)?,
        body: row.get(6)?,
        brief_revision: row.get::<_, i64>(7)? as u64,
        created_at: row.get(8)?,
    })
}

fn link_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResearchLink> {
    Ok(ResearchLink {
        research_id: row.get(0)?,
        kind: LinkKind::parse(&row.get::<_, String>(1)?).unwrap_or(LinkKind::Session),
        ref_id: row.get(2)?,
        role: LinkRole::parse(&row.get::<_, String>(3)?).unwrap_or(LinkRole::Discussion),
        created_at: row.get(4)?,
    })
}

fn load_question(
    connection: &Connection,
    project_id: &str,
    id: &str,
) -> Result<ResearchQuestion, ResearchError> {
    let row = connection
        .query_row(
            "SELECT id, project_id, status, archived, revision, brief_json,
                    created_at, updated_at, resolved_at
             FROM research_questions WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .optional()?
        .ok_or(ResearchError::NotFound)?;
    Ok(ResearchQuestion {
        id: row.0,
        project_id: row.1,
        status: ResearchStatus::parse(&row.2).unwrap_or(ResearchStatus::Open),
        archived: row.3 != 0,
        revision: row.4 as u64,
        brief: serde_json::from_str(&row.5)?,
        created_at: row.6,
        updated_at: row.7,
        resolved_at: row.8,
    })
}

fn load_revision(
    connection: &Connection,
    research_id: &str,
    revision: u64,
) -> Result<BriefRevision, ResearchError> {
    let row = connection
        .query_row(
            "SELECT brief_json, author_kind, author_ref, note, created_at
             FROM research_brief_revisions WHERE research_id = ?1 AND revision = ?2",
            params![research_id, revision as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or(ResearchError::RevisionNotFound(revision))?;
    Ok(BriefRevision {
        research_id: research_id.to_owned(),
        revision,
        brief: serde_json::from_str(&row.0)?,
        author_kind: AuthorKind::parse(&row.1).unwrap_or(AuthorKind::Researcher),
        author_ref: row.2,
        note: row.3,
        created_at: row.4,
    })
}
