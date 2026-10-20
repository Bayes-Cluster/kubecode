//! Tasks and human-authorized admission (ADR 0221).
//!
//! A Task is a research question. This store adds only what the other stores
//! do not hold: the recorded *authorizations* by which the researcher, through
//! the General Agent, put a question on the board and let it execute, the
//! researcher's *reviews*, and a small append-only log of stage-affecting
//! events. Everything else a Task shows — brief, rounds, internal work,
//! experiments, decisions, participants — is read from the stores that own it.

mod models;
#[cfg(test)]
mod tests;

pub use models::*;

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::agent_store::AgentStore;
use crate::channel_store::{
    AuthorKind as ChannelAuthor, ChannelStore, ContextRef, Message, NewMessage,
};
use crate::database::Database;
use crate::member_store::{MemberRole, MemberStore};
use crate::project_context::ContextKind;
use crate::research_store::{
    AuthorKind, BriefPatch, EntryKind, NewEntry, NewRound, ResearchBrief, ResearchQuestion,
    ResearchStatus, ResearchStore, RoundKind,
};
use crate::work_store::{Actor, WorkCondition, WorkFilter, WorkOutcome, WorkStage, WorkStore};

/// The task events that move a Task's stage. Every stage read filters on
/// exactly these, so other events (archiving) never move a stage.
const STAGE_EVENT_KINDS: &str = "('admitted', 'execution_authorized', 'review_requested', 'review_returned', 'review_accepted')";
/// The task events after which an earlier instruction no longer authorizes the
/// next step: the stage events, and restoring an archived Task, so nothing the
/// researcher said before archiving it starts work after it comes back.
const WATERMARK_EVENT_KINDS: &str = "('admitted', 'execution_authorized', 'review_requested', 'review_returned', 'review_accepted', 'restored')";

/// Why a step is refused while the researcher has archived the Task.
const ARCHIVED: &str = "the Task is archived; the researcher restores it first";
/// Archived Tasks the board lists apart.
const MAX_ARCHIVED: usize = 50;

/// Steps a Task's history shows (the newest).
const MAX_TIMELINE: usize = 100;
/// The researcher's words quoted in a history step.
const MAX_EXCERPT_CHARS: usize = 280;

/// Drafts waiting at once, so a loop cannot flood General.
const MAX_DRAFTS: usize = 50;
/// The proposal shown in General is shortened to this; the Task shows all of it.
const MAX_PROPOSAL_CHARS: usize = 8_000;

pub struct TaskStore {
    database: Arc<Database>,
    agents: Arc<AgentStore>,
    research: Arc<ResearchStore>,
    channels: Arc<ChannelStore>,
    members: Arc<MemberStore>,
    work: Arc<WorkStore>,
}

fn ensure_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_authorizations (
           id            TEXT PRIMARY KEY,
           project_id    TEXT NOT NULL,
           research_id   TEXT NOT NULL,
           kind          TEXT NOT NULL,
           message_id    TEXT,
           brief_revision INTEGER NOT NULL,
           scope_digest  TEXT NOT NULL,
           acted_by      TEXT NOT NULL,
           origin        TEXT NOT NULL,
           round_id      TEXT,
           created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         -- One instruction authorizes one thing, once: not a second kind of step,
         -- not another Task.
         CREATE UNIQUE INDEX IF NOT EXISTS task_authorizations_message
           ON task_authorizations(message_id) WHERE message_id IS NOT NULL;
         -- A Task is admitted once; a revision is approved once.
         CREATE UNIQUE INDEX IF NOT EXISTS task_authorizations_admit
           ON task_authorizations(research_id) WHERE kind = 'admit';
         CREATE UNIQUE INDEX IF NOT EXISTS task_authorizations_revision
           ON task_authorizations(research_id, brief_revision) WHERE kind = 'revise';
         CREATE TABLE IF NOT EXISTS task_review_requests (
           id             TEXT PRIMARY KEY,
           project_id     TEXT NOT NULL,
           research_id    TEXT NOT NULL,
           summary        TEXT NOT NULL,
           evidence_json  TEXT NOT NULL DEFAULT '[]',
           requested_by   TEXT NOT NULL,
           brief_revision INTEGER NOT NULL,
           state          TEXT NOT NULL DEFAULT 'open',
           created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           resolved_at    TEXT
         );
         CREATE UNIQUE INDEX IF NOT EXISTS task_review_requests_open
           ON task_review_requests(research_id) WHERE state = 'open';
         CREATE TABLE IF NOT EXISTS task_reviews (
           id             TEXT PRIMARY KEY,
           project_id     TEXT NOT NULL,
           research_id    TEXT NOT NULL,
           request_id     TEXT NOT NULL UNIQUE,
           accepted       INTEGER NOT NULL,
           outcome        TEXT NOT NULL,
           reason         TEXT,
           brief_revision INTEGER NOT NULL,
           created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         -- Stage-affecting events in order; the stage is the last of them.
         CREATE TABLE IF NOT EXISTS task_events (
           seq         INTEGER PRIMARY KEY AUTOINCREMENT,
           project_id  TEXT NOT NULL,
           research_id TEXT NOT NULL,
           kind        TEXT NOT NULL,
           ref_id      TEXT,
           -- The newest General message when it happened: an instruction counts
           -- for a step only if it came after the last stage change.
           channel_seq INTEGER NOT NULL DEFAULT 0,
           created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE INDEX IF NOT EXISTS task_events_task ON task_events(research_id, seq);",
    )?;
    // The revision each piece of a review's evidence had when the review was
    // asked for, so a change before the decision is caught (ADR 0226).
    crate::database::ensure_column(
        connection,
        "task_review_requests",
        "evidence_pins_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )
}

const AUTH_SELECT: &str = "SELECT id, project_id, research_id, kind, message_id, brief_revision,
    scope_digest, acted_by, origin, round_id, created_at FROM task_authorizations";

fn auth_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Authorization> {
    let kind: String = row.get(3)?;
    let origin: String = row.get(8)?;
    Ok(Authorization {
        id: row.get(0)?,
        project_id: row.get(1)?,
        research_id: row.get(2)?,
        kind: AuthorizationKind::parse(&kind).unwrap_or(AuthorizationKind::Admit),
        message_id: row.get(4)?,
        brief_revision: row.get::<_, i64>(5)? as u64,
        scope_digest: row.get(6)?,
        acted_by: row.get(7)?,
        origin: AuthorizationOrigin::parse(&origin).unwrap_or(AuthorizationOrigin::Conversation),
        round_id: row.get(9)?,
        created_at: row.get(10)?,
    })
}

const REQUEST_SELECT: &str = "SELECT id, research_id, summary, evidence_json, requested_by,
    brief_revision, state, created_at, resolved_at, evidence_pins_json FROM task_review_requests";

fn request_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewRequest> {
    let evidence: String = row.get(3)?;
    Ok(ReviewRequest {
        id: row.get(0)?,
        research_id: row.get(1)?,
        summary: row.get(2)?,
        evidence: serde_json::from_str(&evidence).unwrap_or_default(),
        requested_by: row.get(4)?,
        brief_revision: row.get::<_, i64>(5)? as u64,
        state: row.get(6)?,
        created_at: row.get(7)?,
        resolved_at: row.get(8)?,
        evidence_pins: serde_json::from_str(&row.get::<_, String>(9)?).unwrap_or_default(),
    })
}

/// A logged event, or `None` for a kind this version does not know.
fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<TaskEventNote>> {
    let kind: String = row.get(1)?;
    let Some(kind) = TaskEventKind::parse(&kind) else {
        return Ok(None);
    };
    Ok(Some(TaskEventNote {
        seq: row.get::<_, i64>(0)? as u64,
        kind,
        ref_id: row.get(2)?,
        created_at: row.get(3)?,
    }))
}

/// The instruction's own words: what is left once quoted lines are removed.
/// A message that only quotes someone (or an agent) is not an instruction.
pub fn instruction_text(body: &str) -> String {
    body.lines()
        .filter(|line| !line.trim_start().starts_with('>'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

/// What the researcher is shown and authorizes: goal, criteria, constraints,
/// and scope, as one digest recorded with the authorization.
pub fn scope_digest(brief: &ResearchBrief) -> String {
    let canonical = serde_json::to_vec(brief).unwrap_or_default();
    hex::encode(Sha256::digest(canonical))[..32].to_owned()
}

impl TaskStore {
    pub fn from_database(
        database: Arc<Database>,
        agents: Arc<AgentStore>,
        research: Arc<ResearchStore>,
        channels: Arc<ChannelStore>,
        members: Arc<MemberStore>,
        work: Arc<WorkStore>,
    ) -> Result<Self, TaskError> {
        ensure_schema(&database.lock().expect("task database mutex poisoned"))?;
        let store = Self {
            database,
            agents,
            research,
            channels,
            members,
            work,
        };
        store.adopt_legacy()?;
        Ok(store)
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.database.lock().expect("task database mutex poisoned")
    }

    fn write<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<(T, Option<(String, String)>), TaskError>,
    ) -> Result<T, TaskError> {
        let mut connection = self.connection();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (value, announce) = operation(&transaction)?;
        let cursor = match announce {
            Some((project_id, subject)) => {
                transaction.execute(
                    "INSERT INTO workspace_events (kind, project_id, payload)
                     VALUES ('task_updated', ?1, ?2)",
                    params![project_id, json!({"subject": subject}).to_string()],
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

    fn log(
        tx: &Transaction<'_>,
        project_id: &str,
        research_id: &str,
        kind: &str,
        reference: Option<&str>,
    ) -> Result<(), TaskError> {
        let watermark: i64 = tx.query_row(
            "SELECT COALESCE(MAX(m.seq), 0) FROM channel_messages m
             JOIN channels c ON c.id = m.channel_id
             WHERE c.project_id = ?1 AND c.is_default = 1",
            [project_id],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO task_events (project_id, research_id, kind, ref_id, channel_seq)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project_id, research_id, kind, reference, watermark],
        )?;
        Ok(())
    }

    /// Sets the research status an admitted Task's lifecycle implies, in the
    /// same transaction as the step that implies it, announcing the research
    /// change as the research store does (ADR 0230 §1).
    fn mirror_status(
        tx: &Transaction<'_>,
        project_id: &str,
        research_id: &str,
        status: ResearchStatus,
    ) -> Result<(), TaskError> {
        let changed = tx.execute(
            "UPDATE research_questions
             SET status = ?3,
                 resolved_at = CASE WHEN ?3 = 'resolved' THEN CURRENT_TIMESTAMP ELSE NULL END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND project_id = ?2 AND status != ?3",
            params![research_id, project_id, status.as_str()],
        )?;
        if changed > 0 {
            tx.execute(
                "INSERT INTO workspace_events (kind, project_id, payload)
                 VALUES ('research_updated', ?1, ?2)",
                params![
                    project_id,
                    json!({"research_id": research_id, "change": "status"}).to_string()
                ],
            )?;
        }
        Ok(())
    }

    /// A unique-index violation is a lost race with the same request, not a
    /// storage fault.
    fn lost_race(error: rusqlite::Error, what: &'static str) -> TaskError {
        match error {
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                TaskError::State(what)
            }
            other => other.into(),
        }
    }

    // -- Existing records (ADR 0221 §6) ------------------------------------------------------------

    /// Questions whose round the researcher started from the research panel
    /// have an explicit authorization on record: they are admitted with
    /// `legacy_round` origin and no authorizing message, a question the
    /// researcher resolved is Done, and a round started later on an admitted
    /// Task moves it to In progress. Nothing else is admitted retroactively.
    /// Idempotent; a cheap read when there is nothing to do.
    pub fn adopt_legacy(&self) -> Result<usize, TaskError> {
        self.adopt(None)
    }

    fn adopt(&self, project: Option<&str>) -> Result<usize, TaskError> {
        type Candidate = (String, String, String, i64, String);
        let (candidates, unlogged): (Vec<Candidate>, Vec<(String, String, String)>) = {
            let connection = self.connection();
            let mut statement = connection.prepare(
                "SELECT q.project_id, q.id, r.id, r.brief_revision, q.status
                 FROM research_questions q
                 JOIN research_rounds r ON r.id =
                      (SELECT id FROM research_rounds
                       WHERE research_id = q.id AND phase = 'started' ORDER BY round LIMIT 1)
                 WHERE q.archived = 0 AND (?1 IS NULL OR q.project_id = ?1)
                   AND NOT EXISTS (SELECT 1 FROM task_authorizations a
                                   WHERE a.research_id = q.id AND a.kind = 'admit')",
            )?;
            let candidates = statement
                .query_map([project], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut statement = connection.prepare(
                "SELECT a.project_id, a.research_id, r.id
                 FROM research_rounds r
                 JOIN task_authorizations a ON a.research_id = r.research_id AND a.kind = 'admit'
                 WHERE r.phase = 'started' AND (?1 IS NULL OR a.project_id = ?1)
                   AND NOT EXISTS (SELECT 1 FROM task_events e
                                   WHERE e.research_id = r.research_id
                                     AND e.kind = 'execution_authorized' AND e.ref_id = r.id)
                 ORDER BY r.round",
            )?;
            let unlogged = statement
                .query_map([project], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            (candidates, unlogged)
        };
        if candidates.is_empty() && unlogged.is_empty() {
            return Ok(0);
        }
        let mut touched: Vec<(String, String)> = Vec::new();
        self.write(|tx| {
            for (project_id, research_id, round_id, revision, status) in &candidates {
                let started: Vec<String> = {
                    let mut statement = tx.prepare(
                        "SELECT id FROM research_rounds
                         WHERE research_id = ?1 AND phase = 'started' ORDER BY round",
                    )?;
                    statement
                        .query_map([research_id], |row| row.get(0))?
                        .collect::<Result<_, _>>()?
                };
                let digest: String = tx
                    .query_row(
                        "SELECT brief_json FROM research_brief_revisions
                         WHERE research_id = ?1 AND revision = ?2",
                        params![research_id, revision],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .and_then(|json| serde_json::from_str::<ResearchBrief>(&json).ok())
                    .map(|brief| scope_digest(&brief))
                    .unwrap_or_default();
                for kind in ["admit", "execute"] {
                    tx.execute(
                        "INSERT OR IGNORE INTO task_authorizations
                           (id, project_id, research_id, kind, message_id, brief_revision,
                            scope_digest, acted_by, origin, round_id)
                         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 'migration', 'legacy_round', ?7)",
                        params![
                            Uuid::new_v4().to_string(),
                            project_id,
                            research_id,
                            kind,
                            revision,
                            digest,
                            round_id
                        ],
                    )?;
                }
                Self::log(tx, project_id, research_id, "admitted", None)?;
                for started_round in &started {
                    Self::log(
                        tx,
                        project_id,
                        research_id,
                        "execution_authorized",
                        Some(started_round),
                    )?;
                }
                // The researcher resolved it themselves: it is finished.
                if status == "resolved" {
                    Self::log(
                        tx,
                        project_id,
                        research_id,
                        "review_accepted",
                        Some("legacy"),
                    )?;
                }
                touched.push((project_id.clone(), research_id.clone()));
            }
            for (project_id, research_id, round_id) in &unlogged {
                let logged: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM task_events
                     WHERE research_id = ?1 AND kind = 'execution_authorized' AND ref_id = ?2",
                    params![research_id, round_id],
                    |row| row.get(0),
                )?;
                if logged == 0 {
                    Self::log(
                        tx,
                        project_id,
                        research_id,
                        "execution_authorized",
                        Some(round_id),
                    )?;
                    touched.push((project_id.clone(), research_id.clone()));
                }
            }
            Ok(((), None))
        })?;
        // One event per Workspace so open boards refresh.
        let mut announced: Vec<&String> = Vec::new();
        for (project_id, research_id) in &touched {
            if !announced.contains(&project_id) {
                announced.push(project_id);
                let _ = self.write(|_| Ok(((), Some((project_id.clone(), research_id.clone())))));
            }
        }
        Ok(touched.len())
    }

    // -- Reads of the authorization records ------------------------------------------------------------

    pub fn admission(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Option<Authorization>, TaskError> {
        Ok(self
            .connection()
            .query_row(
                &format!(
                    "{AUTH_SELECT} WHERE project_id = ?1 AND research_id = ?2 AND kind = 'admit'"
                ),
                params![project_id, research_id],
                auth_from_row,
            )
            .optional()?)
    }

    pub fn authorizations(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Vec<Authorization>, TaskError> {
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "{AUTH_SELECT} WHERE project_id = ?1 AND research_id = ?2 ORDER BY created_at, rowid"
        ))?;
        Ok(statement
            .query_map(params![project_id, research_id], auth_from_row)?
            .collect::<Result<_, _>>()?)
    }

    /// The newest brief revision the researcher approved (at admission or since).
    pub fn approved_revision(&self, project_id: &str, research_id: &str) -> Result<u64, TaskError> {
        let revision: Option<i64> = self.connection().query_row(
            "SELECT MAX(brief_revision) FROM task_authorizations
             WHERE project_id = ?1 AND research_id = ?2 AND kind IN ('admit', 'revise')",
            params![project_id, research_id],
            |row| row.get(0),
        )?;
        Ok(revision.unwrap_or(0) as u64)
    }

    pub fn review_requests(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Vec<ReviewRequest>, TaskError> {
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "{REQUEST_SELECT} WHERE project_id = ?1 AND research_id = ?2 ORDER BY created_at, rowid"
        ))?;
        Ok(statement
            .query_map(params![project_id, research_id], request_from_row)?
            .collect::<Result<_, _>>()?)
    }

    pub fn reviews(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Vec<TaskReview>, TaskError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT id, research_id, request_id, accepted, outcome, reason, brief_revision, created_at
             FROM task_reviews WHERE project_id = ?1 AND research_id = ?2 ORDER BY created_at, rowid",
        )?;
        Ok(statement
            .query_map(params![project_id, research_id], |row| {
                let outcome: String = row.get(4)?;
                Ok(TaskReview {
                    id: row.get(0)?,
                    research_id: row.get(1)?,
                    request_id: row.get(2)?,
                    accepted: row.get::<_, i64>(3)? != 0,
                    outcome: WorkOutcome::parse(&outcome).unwrap_or(WorkOutcome::Unknown),
                    reason: row.get(5)?,
                    brief_revision: row.get::<_, i64>(6)? as u64,
                    created_at: row.get(7)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    /// The stage: an open review request means Review; otherwise the last
    /// stage-affecting event decides. A question that was never admitted has
    /// none (it is a draft).
    pub fn stage(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Option<TaskStage>, TaskError> {
        let connection = self.connection();
        let open: i64 = connection.query_row(
            "SELECT COUNT(*) FROM task_review_requests
             WHERE project_id = ?1 AND research_id = ?2 AND state = 'open'",
            params![project_id, research_id],
            |row| row.get(0),
        )?;
        if open > 0 {
            return Ok(Some(TaskStage::Review));
        }
        let last: Option<String> = connection
            .query_row(
                &format!(
                    "SELECT kind FROM task_events
                     WHERE project_id = ?1 AND research_id = ?2 AND kind IN {STAGE_EVENT_KINDS}
                     ORDER BY seq DESC LIMIT 1"
                ),
                params![project_id, research_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(last.map(|kind| match kind.as_str() {
            "execution_authorized" | "review_returned" => TaskStage::InProgress,
            "review_accepted" => TaskStage::Done,
            _ => TaskStage::Ready,
        }))
    }

    /// Every logged event of a Task, oldest first.
    pub fn events(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Vec<TaskEventNote>, TaskError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT seq, kind, ref_id, created_at FROM task_events
             WHERE project_id = ?1 AND research_id = ?2 ORDER BY seq",
        )?;
        Ok(statement
            .query_map(params![project_id, research_id], event_from_row)?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    /// The newest stage event: archiving is never one.
    fn last_stage_event(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Option<TaskEventNote>, TaskError> {
        Ok(self
            .connection()
            .query_row(
                &format!(
                    "SELECT seq, kind, ref_id, created_at FROM task_events
                     WHERE project_id = ?1 AND research_id = ?2 AND kind IN {STAGE_EVENT_KINDS}
                     ORDER BY seq DESC LIMIT 1"
                ),
                params![project_id, research_id],
                event_from_row,
            )
            .optional()?
            .flatten())
    }

    /// The newest General message at the time of the last stage change or
    /// restore: an instruction for the next step must be newer than this.
    fn stage_watermark(&self, project_id: &str, research_id: &str) -> Result<u64, TaskError> {
        let seq: Option<i64> = self
            .connection()
            .query_row(
                &format!(
                    "SELECT channel_seq FROM task_events
                     WHERE project_id = ?1 AND research_id = ?2 AND kind IN {WATERMARK_EVENT_KINDS}
                     ORDER BY seq DESC LIMIT 1"
                ),
                params![project_id, research_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(seq.unwrap_or(0) as u64)
    }

    // -- Proposals ----------------------------------------------------------------------------------------

    fn proposal_body(question: &ResearchQuestion) -> String {
        let brief = &question.brief;
        let mut text = format!("Proposed Task: {}\n\n{}", brief.title, brief.question);
        for (heading, items) in [
            ("Hypotheses", &brief.hypotheses),
            ("Constraints", &brief.constraints),
            ("Success criteria", &brief.evaluation_criteria),
        ] {
            if !items.is_empty() {
                text.push_str(&format!("\n\n{heading}:"));
                for item in items {
                    text.push_str(&format!("\n- {item}"));
                }
            }
        }
        if !brief.motivation.is_empty() {
            text.push_str(&format!("\n\nWhy: {}", brief.motivation));
        }
        // A long brief is shortened in the message; the Task shows all of it.
        let mut text: String = text.chars().take(MAX_PROPOSAL_CHARS).collect();
        text.push_str(&format!(
            "\n\n(Draft, revision {}. It is not on the board. Tell the General Agent in your own words to add it, or refine it first.)",
            question.revision
        ));
        text
    }

    /// Shows a brief revision to the researcher in General, as a top-level
    /// message of the General Agent keyed `proposal:{id}:{revision}`. A
    /// proposal is displayed by construction, and only such a message counts as
    /// showing it (ADR 0221 §2). `again` posts a fresh copy, for when another
    /// proposal has been shown since.
    fn show_proposal(
        &self,
        project_id: &str,
        caller: &str,
        question: &ResearchQuestion,
        again: bool,
    ) -> Result<Message, TaskError> {
        let channel = self.channels.default_channel(project_id)?;
        let reference = ContextRef::at(
            ContextKind::Research,
            &question.id,
            question.revision.to_string(),
        );
        let key = if again {
            format!(
                "proposal:{}:{}:again:{}",
                question.id,
                question.revision,
                Uuid::new_v4().simple()
            )
        } else {
            format!("proposal:{}:{}", question.id, question.revision)
        };
        let (message, _) = self.channels.post(
            project_id,
            &channel.id,
            NewMessage {
                body: &Self::proposal_body(question),
                author_kind: Some(ChannelAuthor::Agent),
                author_ref: Some(caller),
                references: std::slice::from_ref(&reference),
                client_message_id: Some(&key),
                ..Default::default()
            },
        )?;
        Ok(message)
    }

    /// A Workspace member drafts a Task. It is a proposal: nothing is on the
    /// board and nothing runs. Attributed to the writing Session.
    pub fn propose(
        &self,
        project_id: &str,
        caller: &str,
        brief: ResearchBrief,
        client_request_id: Option<&str>,
    ) -> Result<(ResearchQuestion, Message), TaskError> {
        let active = self
            .members
            .by_conversation(project_id, caller)?
            .is_some_and(|resolved| resolved.current);
        if !active {
            return Err(TaskError::NotMember);
        }
        if self.drafts(project_id)?.len() >= MAX_DRAFTS {
            return Err(TaskError::Invalid(
                "too many drafts are waiting; ask the researcher to add or discard some",
            ));
        }
        let (question, _) = self.research.create_authored(
            project_id,
            brief,
            client_request_id,
            AuthorKind::Agent,
            Some(caller),
        )?;
        let message = self.show_proposal(project_id, caller, &question, false)?;
        Ok((question, message))
    }

    /// The General Agent refines a proposal (or proposes a change to an
    /// admitted Task's brief) as the researcher asks. The new revision is
    /// shown; for an admitted Task it is *proposed*, not approved.
    pub fn revise(
        &self,
        project_id: &str,
        caller: &str,
        research_id: &str,
        expected_revision: u64,
        patch: &BriefPatch,
        note: Option<&str>,
    ) -> Result<(ResearchQuestion, Message), TaskError> {
        if !self.members.is_general(project_id, caller)? {
            return Err(TaskError::NotManager);
        }
        if self.stage(project_id, research_id)? == Some(TaskStage::Done) {
            return Err(TaskError::State("a finished Task's brief is not revised"));
        }
        let (question, _) = self.research.update_brief_authored(
            project_id,
            research_id,
            expected_revision,
            patch,
            note,
            AuthorKind::Agent,
            Some(caller),
        )?;
        let message = self.show_proposal(project_id, caller, &question, false)?;
        Ok((question, message))
    }

    /// Shows the current proposal again, after other proposals have been shown
    /// or the brief was edited elsewhere, so the researcher can answer it.
    pub fn show_again(
        &self,
        project_id: &str,
        caller: &str,
        research_id: &str,
    ) -> Result<Message, TaskError> {
        if !self.members.is_general(project_id, caller)? {
            return Err(TaskError::NotManager);
        }
        let question = self
            .research
            .get(project_id, research_id)
            .map_err(|error| match error {
                crate::research_store::ResearchError::NotFound => TaskError::NotFound,
                other => other.into(),
            })?;
        if self.stage(project_id, research_id)? == Some(TaskStage::Done) {
            return Err(TaskError::State(
                "a finished Task's brief is not shown again",
            ));
        }
        self.show_proposal(project_id, caller, &question, true)
    }

    // -- Authorization ---------------------------------------------------------------------------------------

    /// Checks everything the server can know about an instruction: who wrote
    /// it, where, and whether it is the researcher's own words. The meaning of
    /// the words is the General Agent's to judge (ADR 0221 §2).
    fn check_instruction(
        &self,
        project_id: &str,
        caller: &str,
        research_id: &str,
        message_id: &str,
    ) -> Result<(ResearchQuestion, Message), TaskError> {
        if !self.members.is_general(project_id, caller)? {
            return Err(TaskError::NotManager);
        }
        let question = self
            .research
            .get(project_id, research_id)
            .map_err(|error| match error {
                crate::research_store::ResearchError::NotFound => TaskError::NotFound,
                other => other.into(),
            })?;
        if question.archived {
            return Err(TaskError::State(ARCHIVED));
        }
        let message = self
            .channels
            .message(project_id, message_id)
            .map_err(|_| TaskError::NotAuthorized("that message does not exist here"))?;
        if message.author_kind != ChannelAuthor::Researcher
            || message.kind != crate::channel_store::MessageKind::Message
        {
            return Err(TaskError::NotAuthorized(
                "only the researcher's own message authorizes",
            ));
        }
        let general = self.channels.default_channel(project_id)?;
        if message.channel_id != general.id {
            return Err(TaskError::NotAuthorized(
                "it was not said in the General conversation",
            ));
        }
        if instruction_text(&message.body).is_empty() {
            return Err(TaskError::NotAuthorized("it only quotes other text"));
        }
        Ok((question, message))
    }

    /// The instruction answers this proposal: the General Agent showed exactly
    /// this brief revision before the instruction, and either the instruction
    /// names the Task or this is the latest proposal shown before it. When
    /// another proposal came after, which one the researcher meant is unclear
    /// and the General Agent must show it again and ask.
    fn require_shown(
        &self,
        project_id: &str,
        question: &ResearchQuestion,
        brief_revision: u64,
        message: &Message,
    ) -> Result<(), TaskError> {
        if question.revision != brief_revision {
            return Err(TaskError::Stale(
                "the brief changed since it was shown; show the current one again",
            ));
        }
        let general = self.channels.default_channel(project_id)?;
        let shown = self.channels.proposal_seq(
            project_id,
            &general.id,
            &question.id,
            &brief_revision.to_string(),
        )?;
        match shown {
            Some((seq, author)) if seq < message.seq => {
                let by_manager = author
                    .as_deref()
                    .map(|session| self.members.was_general(project_id, session))
                    .transpose()?
                    .unwrap_or(false);
                if !by_manager {
                    return Err(TaskError::Stale(
                        "the proposal was not shown by the General Agent",
                    ));
                }
            }
            Some(_) => {
                return Err(TaskError::Stale(
                    "the instruction came before the proposal at this revision was shown",
                ));
            }
            None => {
                return Err(TaskError::Stale(
                    "this revision was never shown to the researcher",
                ));
            }
        }
        let names_it = message.references.iter().any(|reference| {
            reference.kind == ContextKind::Research && reference.id == question.id
        });
        if !names_it {
            let latest =
                self.channels
                    .latest_proposal_before(project_id, &general.id, message.seq)?;
            if latest != Some((question.id.clone(), brief_revision.to_string())) {
                return Err(TaskError::Stale(
                    "another proposal was shown more recently; show this one again, or ask which they meant",
                ));
            }
        }
        Ok(())
    }

    fn insert_authorization(
        tx: &Transaction<'_>,
        project_id: &str,
        question: &ResearchQuestion,
        kind: AuthorizationKind,
        message_id: &str,
        acted_by: &str,
    ) -> Result<Authorization, TaskError> {
        let used: i64 = tx.query_row(
            "SELECT COUNT(*) FROM task_authorizations WHERE message_id = ?1",
            [message_id],
            |row| row.get(0),
        )?;
        if used > 0 {
            return Err(TaskError::MessageUsed);
        }
        let id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO task_authorizations
               (id, project_id, research_id, kind, message_id, brief_revision, scope_digest,
                acted_by, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'conversation')",
            params![
                id,
                project_id,
                question.id,
                kind.as_str(),
                message_id,
                question.revision as i64,
                scope_digest(&question.brief),
                acted_by
            ],
        )
        .map_err(|error| Self::lost_race(error, "that step was already authorized"))?;
        Ok(tx.query_row(
            &format!("{AUTH_SELECT} WHERE id = ?1"),
            [&id],
            auth_from_row,
        )?)
    }

    /// Puts a Task on the board because the researcher said so in
    /// `message_id`. Idempotent: the same authorization returns the same
    /// record and board identity, however many callers race; anything else is
    /// refused (ADR 0221 §2).
    pub fn admit(
        &self,
        project_id: &str,
        caller: &str,
        research_id: &str,
        message_id: &str,
        brief_revision: u64,
    ) -> Result<(Authorization, bool), TaskError> {
        let (question, message) =
            self.check_instruction(project_id, caller, research_id, message_id)?;
        if let Some(existing) = self.admission(project_id, research_id)? {
            return if existing.message_id.as_deref() == Some(message_id) {
                self.acknowledge(
                    project_id,
                    caller,
                    &question,
                    &message,
                    "Added to the board",
                    "admitted",
                );
                Ok((existing, false))
            } else {
                Err(TaskError::State("the Task is already on the board"))
            };
        }
        self.require_shown(project_id, &question, brief_revision, &message)?;
        let (record, created) = self.write(|tx| {
            // The decisive check is made inside the transaction, so two callers
            // racing with the same instruction get the same record.
            if let Some(existing) = tx
                .query_row(
                    &format!("{AUTH_SELECT} WHERE research_id = ?1 AND kind = 'admit'"),
                    [research_id],
                    auth_from_row,
                )
                .optional()?
            {
                return if existing.message_id.as_deref() == Some(message_id) {
                    Ok(((existing, false), None))
                } else {
                    Err(TaskError::State("the Task is already on the board"))
                };
            }
            let record = Self::insert_authorization(
                tx,
                project_id,
                &question,
                AuthorizationKind::Admit,
                message_id,
                caller,
            )?;
            Self::log(tx, project_id, research_id, "admitted", Some(message_id))?;
            Ok((
                (record, true),
                Some((project_id.to_owned(), research_id.to_owned())),
            ))
        })?;
        self.acknowledge(
            project_id,
            caller,
            &question,
            &message,
            "Added to the board",
            "admitted",
        );
        Ok((record, created))
    }

    /// The General Agent says what it did, where the researcher said it. A
    /// failure is logged, not raised: the step is recorded, and repeating the
    /// same call posts the acknowledgement again (it is idempotent).
    fn acknowledge(
        &self,
        project_id: &str,
        caller: &str,
        question: &ResearchQuestion,
        instruction: &Message,
        verb: &str,
        key: &str,
    ) {
        let reference = ContextRef::at(
            ContextKind::Research,
            &question.id,
            question.revision.to_string(),
        );
        let key = format!("{key}:{}:{}", question.id, instruction.id);
        let body = format!(
            "{verb}: \"{}\" (brief revision {}), as you asked.",
            question.brief.title, question.revision
        );
        if let Err(error) = self.channels.post(
            project_id,
            &instruction.channel_id,
            NewMessage {
                thread_id: instruction.thread_id.as_deref(),
                body: &body,
                author_kind: Some(ChannelAuthor::Agent),
                author_ref: Some(caller),
                references: std::slice::from_ref(&reference),
                client_message_id: Some(&key),
                ..Default::default()
            },
        ) {
            eprintln!("WARN: could not acknowledge a Task step in General: {error}");
        }
    }

    /// Approves a revised brief of an admitted Task. Until then rounds keep the
    /// approved revision.
    pub fn approve_revision(
        &self,
        project_id: &str,
        caller: &str,
        research_id: &str,
        message_id: &str,
        brief_revision: u64,
    ) -> Result<(Authorization, bool), TaskError> {
        let (question, message) =
            self.check_instruction(project_id, caller, research_id, message_id)?;
        if self.admission(project_id, research_id)?.is_none() {
            return Err(TaskError::State("the Task is not on the board yet"));
        }
        self.require_shown(project_id, &question, brief_revision, &message)?;
        let (record, created) = self.write(|tx| {
            if let Some(existing) = tx
                .query_row(
                    &format!(
                        "{AUTH_SELECT} WHERE research_id = ?1 AND kind IN ('admit', 'revise')
                           AND brief_revision = ?2"
                    ),
                    params![research_id, brief_revision as i64],
                    auth_from_row,
                )
                .optional()?
            {
                return if existing.message_id.as_deref() == Some(message_id) {
                    Ok(((existing, false), None))
                } else {
                    Err(TaskError::State("that revision is already approved"))
                };
            }
            let record = Self::insert_authorization(
                tx,
                project_id,
                &question,
                AuthorizationKind::Revise,
                message_id,
                caller,
            )?;
            Ok((
                (record, true),
                Some((project_id.to_owned(), research_id.to_owned())),
            ))
        })?;
        self.acknowledge(
            project_id,
            caller,
            &question,
            &message,
            "Approved the revised brief",
            "approved",
        );
        Ok((record, created))
    }

    /// Lets an admitted Task execute because the researcher said so: starts a
    /// round pinned to the approved brief, with the General Agent as its
    /// coordinator. Allowed from Ready, or from Done when the researcher asks to
    /// iterate; never while a round is already running or under review. The
    /// instruction must be newer than the last change of stage and is
    /// idempotent per instruction. Sets no limit and no experiment envelope
    /// (ADR 0221 §3).
    pub fn start_execution(
        &self,
        project_id: &str,
        caller: &str,
        research_id: &str,
        message_id: &str,
    ) -> Result<(Authorization, bool), TaskError> {
        let (question, message) =
            self.check_instruction(project_id, caller, research_id, message_id)?;
        if self.admission(project_id, research_id)?.is_none() {
            return Err(TaskError::State("the Task is not on the board yet"));
        }
        let existing = self
            .authorizations(project_id, research_id)?
            .into_iter()
            .find(|a| {
                a.kind == AuthorizationKind::Execute && a.message_id.as_deref() == Some(message_id)
            });
        // Every call, retries included, is checked against the Task as it is now.
        let approved = self.approved_revision(project_id, research_id)?;
        if approved != question.revision {
            return Err(TaskError::State(
                "a revised brief is waiting for the researcher's approval",
            ));
        }
        match &existing {
            Some(record) if record.round_id.is_some() => {
                // Finished earlier; only the acknowledgement may have been lost.
                self.acknowledge(
                    project_id,
                    caller,
                    &question,
                    &message,
                    "Started execution of",
                    "started",
                );
                return Ok((record.clone(), false));
            }
            Some(record) if record.brief_revision != question.revision => {
                return Err(TaskError::Stale(
                    "the brief changed after this instruction; ask the researcher again",
                ));
            }
            // A record left without its round (a crash before the round began)
            // is checked like a new one: the Task may have moved on since.
            _ => {
                match self
                    .stage(project_id, research_id)?
                    .unwrap_or(TaskStage::Ready)
                {
                    TaskStage::Ready | TaskStage::Done => {}
                    TaskStage::InProgress => {
                        return Err(TaskError::State(
                            "the Task is already executing; continue in its current round",
                        ));
                    }
                    TaskStage::Review => {
                        return Err(TaskError::State(
                            "the Task is waiting for the researcher's review",
                        ));
                    }
                }
                if message.seq <= self.stage_watermark(project_id, research_id)? {
                    return Err(TaskError::Stale(
                        "the instruction came before the Task's last change; ask the researcher again",
                    ));
                }
            }
        }
        let (record, created) = match existing {
            Some(record) => (record, false),
            None => {
                let record = self.write(|tx| {
                    let record = Self::insert_authorization(
                        tx,
                        project_id,
                        &question,
                        AuthorizationKind::Execute,
                        message_id,
                        caller,
                    )?;
                    Ok((record, None))
                })?;
                (record, true)
            }
        };
        // The round steps are idempotent per instruction, so a crash after the
        // record is finished by repeating it.
        let session = self
            .members
            .general(project_id)?
            .and_then(|general| general.public_conversation_id)
            .ok_or(TaskError::State("the General Agent has no Session yet"))?;
        let (round, _) = self.research.begin_round(
            project_id,
            research_id,
            NewRound {
                kind: RoundKind::Solo,
                idempotency_key: &format!("task-exec-{message_id}"),
                expected_revision: question.revision,
                request: json!({"task": true, "authorized_by_message": message_id}),
                sources: Vec::new(),
            },
        )?;
        self.research
            .round_set_shared_session(project_id, research_id, &round.id, &session)?;
        self.research
            .round_mark_started(project_id, research_id, &round.id)?;
        if self.work.coordinator(project_id, &round.id)?.is_none() {
            self.work
                .assume_coordinator(project_id, &round.id, &session, &Actor::Researcher)?;
        }
        let finished = self.write(|tx| {
            let linked = tx.execute(
                "UPDATE task_authorizations SET round_id = ?2 WHERE id = ?1 AND round_id IS NULL",
                params![record.id, round.id],
            )?;
            // An iterated question is open again, with the step that reopens
            // it; an old instruction replayed does not reopen it.
            if linked > 0 {
                Self::mirror_status(tx, project_id, research_id, ResearchStatus::Open)?;
            }
            let logged: i64 = tx.query_row(
                "SELECT COUNT(*) FROM task_events
                 WHERE research_id = ?1 AND kind = 'execution_authorized' AND ref_id = ?2",
                params![research_id, round.id],
                |row| row.get(0),
            )?;
            if logged == 0 {
                Self::log(
                    tx,
                    project_id,
                    research_id,
                    "execution_authorized",
                    Some(&round.id),
                )?;
            }
            Ok((
                tx.query_row(
                    &format!("{AUTH_SELECT} WHERE id = ?1"),
                    [&record.id],
                    auth_from_row,
                )?,
                Some((project_id.to_owned(), research_id.to_owned())),
            ))
        })?;
        self.acknowledge(
            project_id,
            caller,
            &question,
            &message,
            "Started execution of",
            "started",
        );
        Ok((finished, created))
    }

    // -- Review ----------------------------------------------------------------------------------------------

    /// The General Agent reports results and asks the researcher to review
    /// (it does not review specialist work itself). Only a Task that is
    /// executing is reviewed; one request is open at a time.
    /// The researcher accepts the current version of one piece of the open
    /// review's own evidence, after looking at it: its pin moves to `revision`.
    pub fn repin_review_evidence(
        &self,
        project_id: &str,
        research_id: &str,
        request_id: &str,
        entry: &str,
        revision: &str,
    ) -> Result<(), TaskError> {
        self.write(|tx| {
            let request = tx
                .query_row(
                    &format!(
                        "{REQUEST_SELECT} WHERE id = ?1 AND project_id = ?2 AND research_id = ?3"
                    ),
                    params![request_id, project_id, research_id],
                    request_from_row,
                )
                .optional()?
                .ok_or(TaskError::NotFound)?;
            if request.state != "open" {
                return Err(TaskError::State("that review was already decided"));
            }
            if !request.evidence.iter().any(|cited| cited == entry) {
                return Err(TaskError::Invalid(
                    "that evidence is not cited by the review",
                ));
            }
            let mut pins = request.evidence_pins;
            pins.insert(entry.to_owned(), revision.to_owned());
            tx.execute(
                "UPDATE task_review_requests SET evidence_pins_json = ?2 WHERE id = ?1",
                params![request_id, serde_json::to_string(&pins)?],
            )?;
            Ok(((), Some((project_id.to_owned(), research_id.to_owned()))))
        })
    }

    pub fn request_review(
        &self,
        project_id: &str,
        caller: &str,
        research_id: &str,
        summary: &str,
        evidence: &[String],
        pins: &std::collections::BTreeMap<String, String>,
    ) -> Result<(ReviewRequest, bool), TaskError> {
        if !self.members.is_general(project_id, caller)? {
            return Err(TaskError::NotManager);
        }
        let summary = summary.trim();
        if summary.is_empty() || summary.chars().count() > MAX_SUMMARY_CHARS {
            return Err(TaskError::Invalid(
                "a summary of 1 to 4000 characters is required",
            ));
        }
        if evidence.len() > MAX_EVIDENCE
            || evidence.iter().any(|item| {
                item.chars().count() > MAX_EVIDENCE_CHARS
                    || item
                        .split_once(':')
                        .is_none_or(|(kind, id)| kind.is_empty() || id.is_empty())
            })
        {
            return Err(TaskError::Invalid(
                "evidence is cited as kind:id, at most 20 items",
            ));
        }
        let question = self
            .research
            .get(project_id, research_id)
            .map_err(|error| match error {
                crate::research_store::ResearchError::NotFound => TaskError::NotFound,
                other => other.into(),
            })?;
        let (request, created) = self.write(|tx| {
            let admitted: i64 = tx.query_row(
                "SELECT COUNT(*) FROM task_authorizations WHERE research_id = ?1 AND kind = 'admit'",
                [research_id],
                |row| row.get(0),
            )?;
            if admitted == 0 {
                return Err(TaskError::State("the Task is not on the board"));
            }
            let archived: bool = tx.query_row(
                "SELECT archived FROM research_questions WHERE id = ?1",
                [research_id],
                |row| row.get(0),
            )?;
            if archived {
                return Err(TaskError::State(ARCHIVED));
            }
            if let Some(open) = tx
                .query_row(
                    &format!("{REQUEST_SELECT} WHERE research_id = ?1 AND state = 'open'"),
                    [research_id],
                    request_from_row,
                )
                .optional()?
            {
                return if open.summary == summary {
                    Ok(((open, false), None))
                } else {
                    Err(TaskError::State("a review is already open"))
                };
            }
            let last: Option<String> = tx
                .query_row(
                    &format!(
                        "SELECT kind FROM task_events
                         WHERE research_id = ?1 AND kind IN {STAGE_EVENT_KINDS}
                         ORDER BY seq DESC LIMIT 1"
                    ),
                    [research_id],
                    |row| row.get(0),
                )
                .optional()?;
            if !matches!(last.as_deref(), Some("execution_authorized" | "review_returned")) {
                return Err(TaskError::State("only a Task that is executing is reviewed"));
            }
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO task_review_requests
                   (id, project_id, research_id, summary, evidence_json, requested_by, brief_revision,
                    evidence_pins_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    project_id,
                    research_id,
                    summary,
                    serde_json::to_string(evidence)?,
                    caller,
                    question.revision as i64,
                    serde_json::to_string(pins)?
                ],
            )
            .map_err(|error| Self::lost_race(error, "a review is already open"))?;
            Self::log(tx, project_id, research_id, "review_requested", Some(&id))?;
            let stored = tx.query_row(
                &format!("{REQUEST_SELECT} WHERE id = ?1"),
                [&id],
                request_from_row,
            )?;
            Ok(((stored, true), Some((project_id.to_owned(), research_id.to_owned()))))
        })?;
        // Posted again on a retry (it is idempotent), so a lost post is repaired.
        match self.channels.default_channel(project_id) {
            Ok(channel) => {
                let reference = ContextRef::at(
                    ContextKind::Research,
                    &question.id,
                    question.revision.to_string(),
                );
                let body = format!(
                    "Ready for your review: \"{}\".\n\n{summary}",
                    question.brief.title
                );
                if let Err(error) = self.channels.post(
                    project_id,
                    &channel.id,
                    NewMessage {
                        body: &body,
                        author_kind: Some(ChannelAuthor::Agent),
                        author_ref: Some(caller),
                        references: std::slice::from_ref(&reference),
                        client_message_id: Some(&format!("review-request:{}", request.id)),
                        ..Default::default()
                    },
                ) {
                    eprintln!("WARN: could not post a review request to General: {error}");
                }
            }
            Err(error) => eprintln!("WARN: could not find General for a review request: {error}"),
        }
        Ok((request, created))
    }

    /// The researcher accepts the Task's results (with the scientific outcome
    /// they judge) or sends it back with a reason, naming the request they
    /// looked at so a stale click cannot decide a newer one. A well-supported
    /// negative finding completes a Task.
    pub fn review(
        &self,
        project_id: &str,
        research_id: &str,
        request_id: &str,
        accept: bool,
        outcome: WorkOutcome,
        reason: Option<&str>,
    ) -> Result<TaskReview, TaskError> {
        let reason = reason.map(str::trim).filter(|text| !text.is_empty());
        if reason.is_some_and(|text| text.chars().count() > MAX_REASON_CHARS) {
            return Err(TaskError::Invalid("the reason is too long"));
        }
        if !accept && reason.is_none() {
            return Err(TaskError::Invalid("a reason is needed to send a Task back"));
        }
        let question = self
            .research
            .get(project_id, research_id)
            .map_err(|error| match error {
                crate::research_store::ResearchError::NotFound => TaskError::NotFound,
                other => other.into(),
            })?;
        let stored = self.write(|tx| {
            let open = tx
                .query_row(
                    &format!("{REQUEST_SELECT} WHERE research_id = ?1 AND state = 'open'"),
                    [research_id],
                    request_from_row,
                )
                .optional()?
                .ok_or(TaskError::State("there is nothing to review"))?;
            if open.id != request_id {
                return Err(TaskError::State("that review is no longer open; look at the current one"));
            }
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "UPDATE task_review_requests SET state = ?2, resolved_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![open.id, if accept { "accepted" } else { "returned" }],
            )?;
            tx.execute(
                "INSERT INTO task_reviews
                   (id, project_id, research_id, request_id, accepted, outcome, reason, brief_revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    project_id,
                    research_id,
                    open.id,
                    accept,
                    if accept { outcome.as_str() } else { "unknown" },
                    reason,
                    open.brief_revision as i64
                ],
            )?;
            Self::log(
                tx,
                project_id,
                research_id,
                if accept { "review_accepted" } else { "review_returned" },
                Some(&id),
            )?;
            // A Done Task's question is resolved, in the same write.
            if accept {
                Self::mirror_status(tx, project_id, research_id, ResearchStatus::Resolved)?;
            }
            let review = tx.query_row(
                "SELECT id, research_id, request_id, accepted, outcome, reason, brief_revision, created_at
                 FROM task_reviews WHERE id = ?1",
                [&id],
                |row| {
                    let outcome: String = row.get(4)?;
                    Ok(TaskReview {
                        id: row.get(0)?,
                        research_id: row.get(1)?,
                        request_id: row.get(2)?,
                        accepted: row.get::<_, i64>(3)? != 0,
                        outcome: WorkOutcome::parse(&outcome).unwrap_or(WorkOutcome::Unknown),
                        reason: row.get(5)?,
                        brief_revision: row.get::<_, i64>(6)? as u64,
                        created_at: row.get(7)?,
                    })
                },
            )?;
            Ok((review, Some((project_id.to_owned(), research_id.to_owned()))))
        })?;
        // The record of the question keeps the decision; the conversation hears it.
        // These follow the commit and are idempotent; a failure is logged.
        let verdict = if stored.accepted {
            match stored.outcome {
                WorkOutcome::Refuted => "accepted as a valid negative result",
                WorkOutcome::Supported => "accepted: the result supports the hypothesis",
                WorkOutcome::Inconclusive => "accepted as inconclusive",
                WorkOutcome::Unknown => "accepted",
            }
        } else {
            "sent back for more work"
        };
        let detail = reason
            .map(|text| format!(" Reason: {text}"))
            .unwrap_or_default();
        let text = format!("Task \"{}\" was {verdict}.{detail}", question.brief.title);
        if let Err(error) = self.research.add_entry(
            project_id,
            research_id,
            NewEntry {
                kind: EntryKind::Decision,
                author_kind: AuthorKind::Researcher,
                author_ref: None,
                body: text.clone(),
                client_request_id: Some(format!("task-review:{}", stored.id)),
            },
        ) {
            eprintln!("WARN: could not record a Task review in the question's log: {error}");
        }
        match self.channels.default_channel(project_id) {
            Ok(channel) => {
                let reference = ContextRef::at(
                    ContextKind::Research,
                    &question.id,
                    question.revision.to_string(),
                );
                if let Err(error) = self.channels.post(
                    project_id,
                    &channel.id,
                    NewMessage {
                        body: &text,
                        author_kind: Some(ChannelAuthor::System),
                        references: std::slice::from_ref(&reference),
                        client_message_id: Some(&format!("task-review:{}", stored.id)),
                        ..Default::default()
                    },
                ) {
                    eprintln!("WARN: could not tell General about a Task review: {error}");
                }
            }
            Err(error) => eprintln!("WARN: could not find General for a Task review: {error}"),
        }
        Ok(stored)
    }

    // -- Read model --------------------------------------------------------------------------------------------

    /// One admitted Task as a card, or `None` for a draft.
    pub fn card(&self, project_id: &str, research_id: &str) -> Result<Option<TaskCard>, TaskError> {
        let Some(admission) = self.admission(project_id, research_id)? else {
            return Ok(None);
        };
        let question = self
            .research
            .get(project_id, research_id)
            .map_err(|error| match error {
                crate::research_store::ResearchError::NotFound => TaskError::NotFound,
                other => other.into(),
            })?;
        let stage = self
            .stage(project_id, research_id)?
            .unwrap_or(TaskStage::Ready);
        let rounds = self.research.rounds(project_id, research_id)?;
        let items = self.work.list(
            project_id,
            &WorkFilter {
                research_id: Some(research_id.to_owned()),
                limit: Some(200),
                ..Default::default()
            },
        )?;
        let mut rollup = WorkRollup::default();
        let mut participants: Vec<Participant> = Vec::new();
        let mut open_questions = 0;
        let mut waiting = false;
        let note = |conversation: &str, participants: &mut Vec<Participant>| {
            if let Ok(Some(resolved)) = self.members.by_conversation(project_id, conversation)
                && !participants
                    .iter()
                    .any(|p| p.member_id == resolved.member.id)
            {
                participants.push(Participant {
                    member_id: resolved.member.id,
                    name: resolved.member.name,
                    handle: resolved.member.handle,
                    role: match resolved.member.role {
                        MemberRole::General => "general",
                        MemberRole::Specialist => "specialist",
                    }
                    .to_owned(),
                });
            }
        };
        for round in &rounds {
            if let Ok(Some(coordinator)) = self.work.coordinator(project_id, &round.id) {
                note(&coordinator.holder, &mut participants);
            }
        }
        for summary in &items {
            rollup.total += 1;
            match summary.item.stage {
                WorkStage::Done => rollup.done += 1,
                WorkStage::Review => {
                    rollup.in_review += 1;
                    rollup.active += 1;
                }
                _ => rollup.active += 1,
            }
            match summary.item.condition {
                WorkCondition::NeedsInput => rollup.needs_input += 1,
                WorkCondition::Blocked => rollup.blocked += 1,
                WorkCondition::Waiting => waiting = true,
                _ => {}
            }
            if let Some(assignment) = &summary.assignment {
                note(&assignment.conversation_id, &mut participants);
            }
            open_questions += self
                .work
                .decision_requests(project_id, &summary.item.id)?
                .iter()
                .filter(|request| request.state == "open")
                .count();
        }
        let paused = rounds.iter().any(|round| {
            self.work
                .policy(project_id, &round.id)
                .map(|policy| policy.paused)
                .unwrap_or(false)
        });
        let review_open = self
            .review_requests(project_id, research_id)?
            .iter()
            .any(|request| request.state == "open");
        let (condition, condition_reason) = if stage == TaskStage::Done {
            (TaskCondition::None, None)
        } else if open_questions > 0 || rollup.needs_input > 0 {
            (
                TaskCondition::NeedsInput,
                Some(format!(
                    "{} open question(s) for the researcher",
                    open_questions.max(rollup.needs_input)
                )),
            )
        } else if paused {
            (
                TaskCondition::Paused,
                Some("the round is paused".to_owned()),
            )
        } else if rollup.active > 0 && rollup.blocked == rollup.active {
            (
                TaskCondition::Blocked,
                Some("all active work is blocked".to_owned()),
            )
        } else if waiting {
            (TaskCondition::Waiting, Some("work is waiting".to_owned()))
        } else {
            (TaskCondition::None, None)
        };
        let outcome = if stage == TaskStage::Done {
            self.reviews(project_id, research_id)?
                .into_iter()
                .rev()
                .find(|review| review.accepted)
                .map(|review| review.outcome)
        } else {
            None
        };
        Ok(Some(TaskCard {
            id: question.id.clone(),
            project_id: question.project_id.clone(),
            title: question.brief.title.clone(),
            question: question.brief.question.clone(),
            stage,
            condition,
            condition_reason,
            outcome,
            revision: question.revision,
            approved_revision: self.approved_revision(project_id, research_id)?,
            admitted_at: admission.created_at.clone(),
            origin: admission.origin,
            authorizing_message_id: admission.message_id.clone(),
            rounds: rounds
                .iter()
                .map(|round| RoundRef {
                    id: round.id.clone(),
                    number: round.round,
                    brief_revision: round.brief_revision,
                    phase: format!("{:?}", round.phase).to_lowercase(),
                })
                .collect(),
            work: rollup,
            participants,
            open_questions,
            review_requested: review_open,
            updated_at: question.updated_at.clone(),
            last_event: self.last_stage_event(project_id, research_id)?,
        }))
    }

    /// The single board: every admitted Task of the Workspace, in its stage.
    pub fn board(&self, project_id: &str) -> Result<TaskBoard, TaskError> {
        self.adopt(Some(project_id))?;
        let mut cards = Vec::new();
        for summary in self.research.list(project_id, false)? {
            if let Some(card) = self.card(project_id, &summary.id)? {
                cards.push(card);
            }
        }
        cards.sort_by(|a, b| {
            (a.stage as u8)
                .cmp(&(b.stage as u8))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        let stages = [
            TaskStage::Ready,
            TaskStage::InProgress,
            TaskStage::Review,
            TaskStage::Done,
        ]
        .into_iter()
        .map(|stage| StageCount {
            stage,
            count: cards.iter().filter(|card| card.stage == stage).count(),
        })
        .collect();
        let total = cards.len();
        Ok(TaskBoard {
            cards,
            stages,
            total,
            archived: self.archived(project_id)?,
        })
    }

    /// Archived Tasks and proposals, newest first: their stage (none for a
    /// proposal) and the accepted outcome, without composing a whole card.
    pub fn archived(&self, project_id: &str) -> Result<Vec<ArchivedTask>, TaskError> {
        // Newest first and cut to the limit before anything else is read.
        let mut summaries: Vec<_> = self
            .research
            .list(project_id, true)?
            .into_iter()
            .filter(|summary| summary.archived)
            .collect();
        summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        summaries.truncate(MAX_ARCHIVED);
        let mut archived: Vec<ArchivedTask> = Vec::with_capacity(summaries.len());
        for summary in summaries {
            let stage = self.stage(project_id, &summary.id)?;
            let outcome = if stage == Some(TaskStage::Done) {
                self.reviews(project_id, &summary.id)?
                    .into_iter()
                    .rev()
                    .find(|review| review.accepted)
                    .map(|review| review.outcome)
            } else {
                None
            };
            archived.push(ArchivedTask {
                id: summary.id,
                title: summary.title,
                stage,
                outcome,
                updated_at: summary.updated_at,
            });
        }
        Ok(archived)
    }

    // -- Archiving and status (ADR 0230) ---------------------------------------------------------------

    /// Internal work of a question that is still active (not closed, not
    /// done), as the card counts it.
    fn active_work(
        connection: &Connection,
        project_id: &str,
        research_id: &str,
    ) -> Result<i64, TaskError> {
        Ok(connection.query_row(
            "SELECT COUNT(*) FROM work_items
             WHERE project_id = ?1 AND research_id = ?2
               AND lifecycle = 'active' AND stage != 'done'",
            params![project_id, research_id],
            |row| row.get(0),
        )?)
    }

    /// Whether the researcher may archive this Task (or proposal) now: not
    /// while a review is open or internal work is active (in any stage), so a
    /// Task never disappears with a decision or running work under it. A
    /// draft, and a Task in any stage with no open review and no active work,
    /// may be archived.
    pub fn archive_availability(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Availability, TaskError> {
        let question = self.question(project_id, research_id)?;
        let refused = |reason| Availability {
            allowed: false,
            reason: Some(reason),
        };
        if question.archived {
            return Ok(refused("archived"));
        }
        if self
            .review_requests(project_id, research_id)?
            .iter()
            .any(|request| request.state == "open")
        {
            return Ok(refused("under_review"));
        }
        if Self::active_work(&self.connection(), project_id, research_id)? > 0 {
            return Ok(refused("work_active"));
        }
        Ok(Availability {
            allowed: true,
            reason: None,
        })
    }

    /// Archives a Task (hidden from the board, everything kept) or restores
    /// it. Archiving is refused for the reasons `archive_availability` gives;
    /// restoring always works. On an admitted Task the change is logged as an
    /// `archived`/`restored` event, which is not a stage event. Idempotent.
    pub fn set_archived(
        &self,
        project_id: &str,
        research_id: &str,
        archived: bool,
    ) -> Result<ResearchQuestion, TaskError> {
        if archived {
            let availability = self.archive_availability(project_id, research_id)?;
            match availability.reason {
                // Already archived: nothing to do.
                Some("archived") => return self.question(project_id, research_id),
                Some(reason) => return Err(TaskError::Active(reason)),
                None => {}
            }
        }
        self.write(|tx| {
            let current: bool = tx
                .query_row(
                    "SELECT archived FROM research_questions WHERE id = ?1 AND project_id = ?2",
                    params![research_id, project_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(TaskError::NotFound)?;
            if current == archived {
                return Ok(((), None));
            }
            // The checks are repeated inside the transaction, so a review asked
            // for, or work started, meanwhile is never hidden.
            if archived {
                let open: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM task_review_requests
                     WHERE research_id = ?1 AND state = 'open'",
                    [research_id],
                    |row| row.get(0),
                )?;
                if open > 0 {
                    return Err(TaskError::Active("under_review"));
                }
                if Self::active_work(tx, project_id, research_id)? > 0 {
                    return Err(TaskError::Active("work_active"));
                }
            }
            tx.execute(
                "UPDATE research_questions SET archived = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![research_id, archived],
            )?;
            // The research question's own event, as the research store announces it.
            tx.execute(
                "INSERT INTO workspace_events (kind, project_id, payload)
                 VALUES ('research_updated', ?1, ?2)",
                params![
                    project_id,
                    json!({
                        "research_id": research_id,
                        "change": if archived { "archived" } else { "restored" },
                    })
                    .to_string()
                ],
            )?;
            let admitted: i64 = tx.query_row(
                "SELECT COUNT(*) FROM task_authorizations WHERE research_id = ?1 AND kind = 'admit'",
                [research_id],
                |row| row.get(0),
            )?;
            if admitted > 0 {
                Self::log(
                    tx,
                    project_id,
                    research_id,
                    if archived { "archived" } else { "restored" },
                    None,
                )?;
            }
            Ok(((), Some((project_id.to_owned(), research_id.to_owned()))))
        })?;
        self.question(project_id, research_id)
    }

    /// The research status of an admitted Task mirrors its lifecycle and is
    /// written only here (resolved on acceptance, open on iteration): a direct
    /// resolve or reopen is refused. Drafts and plain questions keep ADR 0212.
    pub fn guard_status_command(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<(), TaskError> {
        if self.admission(project_id, research_id)?.is_some() {
            return Err(TaskError::Owned);
        }
        Ok(())
    }

    fn question(&self, project_id: &str, research_id: &str) -> Result<ResearchQuestion, TaskError> {
        self.research
            .get(project_id, research_id)
            .map_err(|error| match error {
                crate::research_store::ResearchError::NotFound => TaskError::NotFound,
                other => other.into(),
            })
    }

    /// Proposals that are not on the board.
    pub fn drafts(&self, project_id: &str) -> Result<Vec<Draft>, TaskError> {
        self.adopt(Some(project_id))?;
        let mut drafts = Vec::new();
        for summary in self.research.list(project_id, false)? {
            if self.admission(project_id, &summary.id)?.is_some() {
                continue;
            }
            let proposed_by = self
                .research
                .revision(project_id, &summary.id, 1)
                .map(|revision| revision.author_kind.as_str().to_owned())
                .unwrap_or_else(|_| "researcher".to_owned());
            let question = self.research.get(project_id, &summary.id)?;
            // The newest showing of the current revision, first or again.
            let exact = format!("proposal:{}:{}", summary.id, summary.revision);
            let again = format!("{exact}:again:");
            let shown_message_id = self
                .channels
                .proposal_messages(project_id, &summary.id)?
                .into_iter()
                .rev()
                .find(|(key, _, _)| *key == exact || key.starts_with(&again))
                .map(|(_, id, _)| id);
            drafts.push(Draft {
                id: summary.id,
                project_id: summary.project_id,
                title: summary.title,
                question: question.brief.question,
                revision: summary.revision,
                proposed_by,
                updated_at: summary.updated_at,
                shown_message_id,
            });
        }
        Ok(drafts)
    }

    /// A Task's history, oldest first and at most the newest 100 steps: its
    /// events, the approvals of revised briefs, and every brief revision, each
    /// with the General message that carried it. Message ids come from two
    /// batched lookups (proposals; review requests and verdicts) and the
    /// researcher's words from one more.
    pub fn timeline(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Vec<TaskActivity>, TaskError> {
        let events = self.events(project_id, research_id)?;
        let authorizations = self.authorizations(project_id, research_id)?;
        let requests = self.review_requests(project_id, research_id)?;
        let reviews = self.reviews(project_id, research_id)?;
        let revisions: Vec<(u64, String, Option<String>, String)> = {
            let connection = self.connection();
            let mut statement = connection.prepare(
                "SELECT revision, author_kind, author_ref, created_at
                 FROM research_brief_revisions WHERE research_id = ?1 ORDER BY revision",
            )?;
            statement
                .query_map([research_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)? as u64,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                    ))
                })?
                .collect::<Result<_, _>>()?
        };
        let proposals = self.channels.proposal_messages(project_id, research_id)?;
        let keys: Vec<String> = requests
            .iter()
            .map(|request| format!("review-request:{}", request.id))
            .chain(
                reviews
                    .iter()
                    .map(|review| format!("task-review:{}", review.id)),
            )
            .collect();
        let keyed = self.channels.messages_by_client_ids(project_id, &keys)?;
        let authorizing: Vec<String> = authorizations
            .iter()
            .filter_map(|authorization| authorization.message_id.clone())
            .collect();
        let words: std::collections::HashMap<String, (String, u64)> = self
            .channels
            .messages_by_ids(project_id, &authorizing)?
            .into_iter()
            .map(|message| {
                let excerpt = instruction_text(&message.body)
                    .chars()
                    .take(MAX_EXCERPT_CHARS)
                    .collect();
                (message.id, (excerpt, message.seq))
            })
            .collect();
        let member = |session: &str| -> Option<(Participant, MemberRole)> {
            let resolved = self.members.by_conversation(project_id, session).ok()??;
            let role = resolved.member.role;
            Some((
                Participant {
                    member_id: resolved.member.id,
                    name: resolved.member.name,
                    handle: resolved.member.handle,
                    role: role.as_str().to_owned(),
                },
                role,
            ))
        };
        let actor_of = |role: Option<MemberRole>| match role {
            Some(MemberRole::General) => "manager",
            Some(MemberRole::Specialist) => "member",
            None => "system",
        };
        // (activity, position in the conversation) so steps logged within the
        // same second keep the order in which General saw them.
        let mut steps: Vec<(TaskActivity, u64)> = Vec::new();
        let step = |at: &str, kind, actor, member: Option<Participant>| TaskActivity {
            at: at.to_owned(),
            kind,
            actor,
            member,
            brief_revision: None,
            ref_id: None,
            message_id: None,
            excerpt: None,
        };
        for (revision, author_kind, author_ref, created_at) in &revisions {
            let exact = format!("proposal:{research_id}:{revision}");
            let again = format!("{exact}:again:");
            let shown = proposals
                .iter()
                .find(|(key, _, _)| *key == exact || key.starts_with(&again));
            let (participant, role) = match author_ref.as_deref().and_then(member) {
                Some((participant, role)) => (Some(participant), Some(role)),
                None => (None, None),
            };
            let actor = if author_kind == "researcher" {
                "researcher"
            } else {
                actor_of(role)
            };
            let kind = if *revision == 1 {
                TaskActivityKind::Proposed
            } else {
                TaskActivityKind::Revised
            };
            let mut activity = step(created_at, kind, actor, participant);
            activity.brief_revision = Some(*revision);
            activity.message_id = shown.map(|(_, id, _)| id.clone());
            steps.push((activity, shown.map_or(u64::MAX, |(_, _, seq)| *seq)));
        }
        for authorization in authorizations
            .iter()
            .filter(|authorization| authorization.kind == AuthorizationKind::Revise)
        {
            let mut activity = step(
                &authorization.created_at,
                TaskActivityKind::RevisionApproved,
                "manager",
                member(&authorization.acted_by).map(|(participant, _)| participant),
            );
            activity.brief_revision = Some(authorization.brief_revision);
            activity.message_id = authorization.message_id.clone();
            let said = authorization
                .message_id
                .as_ref()
                .and_then(|id| words.get(id));
            activity.excerpt = said.map(|(excerpt, _)| excerpt.clone());
            steps.push((activity, said.map_or(u64::MAX, |(_, seq)| *seq)));
        }
        let channel_seq: std::collections::HashMap<u64, u64> = {
            let connection = self.connection();
            let mut statement = connection.prepare(
                "SELECT seq, channel_seq FROM task_events WHERE project_id = ?1 AND research_id = ?2",
            )?;
            statement
                .query_map(params![project_id, research_id], |row| {
                    Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64))
                })?
                .collect::<Result<_, _>>()?
        };
        for event in &events {
            let mut position = channel_seq.get(&event.seq).copied().unwrap_or(u64::MAX);
            let legacy = event.ref_id.as_deref() == Some("legacy");
            let activity = match event.kind {
                TaskEventKind::Admitted | TaskEventKind::ExecutionAuthorized => {
                    let (kind, wanted) = if event.kind == TaskEventKind::Admitted {
                        (TaskActivityKind::Admitted, AuthorizationKind::Admit)
                    } else {
                        (
                            TaskActivityKind::ExecutionAuthorized,
                            AuthorizationKind::Execute,
                        )
                    };
                    let authorization = authorizations.iter().find(|authorization| {
                        authorization.kind == wanted
                            && (wanted == AuthorizationKind::Admit
                                || authorization.round_id == event.ref_id)
                    });
                    let conversation = authorization.is_some_and(|authorization| {
                        authorization.origin == AuthorizationOrigin::Conversation
                    });
                    let mut activity = step(
                        &event.created_at,
                        kind,
                        if conversation { "manager" } else { "system" },
                        authorization
                            .and_then(|authorization| member(&authorization.acted_by))
                            .map(|(participant, _)| participant),
                    );
                    if let Some(authorization) = authorization {
                        activity.brief_revision = Some(authorization.brief_revision);
                        activity.message_id = authorization.message_id.clone();
                        if let Some((excerpt, seq)) = authorization
                            .message_id
                            .as_ref()
                            .and_then(|id| words.get(id))
                        {
                            activity.excerpt = Some(excerpt.clone());
                            position = *seq;
                        }
                    }
                    if kind == TaskActivityKind::ExecutionAuthorized {
                        activity.ref_id = event.ref_id.clone();
                    }
                    activity
                }
                TaskEventKind::ReviewRequested => {
                    let request = requests
                        .iter()
                        .find(|request| Some(&request.id) == event.ref_id.as_ref());
                    let mut activity = step(
                        &event.created_at,
                        TaskActivityKind::ReviewRequested,
                        "manager",
                        request
                            .and_then(|request| member(&request.requested_by))
                            .map(|(participant, _)| participant),
                    );
                    activity.brief_revision = request.map(|request| request.brief_revision);
                    activity.ref_id = event.ref_id.clone();
                    if let Some((id, seq)) = event
                        .ref_id
                        .as_ref()
                        .and_then(|id| keyed.get(&format!("review-request:{id}")))
                    {
                        activity.message_id = Some(id.clone());
                        position = *seq;
                    }
                    activity
                }
                TaskEventKind::ReviewReturned | TaskEventKind::ReviewAccepted => {
                    let kind = if event.kind == TaskEventKind::ReviewAccepted {
                        TaskActivityKind::ReviewAccepted
                    } else {
                        TaskActivityKind::ReviewReturned
                    };
                    let review = reviews
                        .iter()
                        .find(|review| Some(&review.id) == event.ref_id.as_ref());
                    let mut activity = step(
                        &event.created_at,
                        kind,
                        if legacy { "system" } else { "researcher" },
                        None,
                    );
                    activity.brief_revision = review.map(|review| review.brief_revision);
                    activity.ref_id = review.map(|review| review.id.clone());
                    if let Some((id, seq)) = event
                        .ref_id
                        .as_ref()
                        .and_then(|id| keyed.get(&format!("task-review:{id}")))
                    {
                        activity.message_id = Some(id.clone());
                        position = *seq;
                    }
                    activity
                }
                TaskEventKind::Archived | TaskEventKind::Restored => {
                    let kind = if event.kind == TaskEventKind::Archived {
                        TaskActivityKind::Archived
                    } else {
                        TaskActivityKind::Restored
                    };
                    step(&event.created_at, kind, "researcher", None)
                }
            };
            steps.push((activity, position));
        }
        // By time; within the same second, by where General saw it.
        steps.sort_by(|(a, a_position), (b, b_position)| {
            a.at.cmp(&b.at).then(a_position.cmp(b_position))
        });
        let skip = steps.len().saturating_sub(MAX_TIMELINE);
        Ok(steps
            .into_iter()
            .skip(skip)
            .map(|(activity, _)| activity)
            .collect())
    }

    /// What waits on the researcher, under stable keys: an open review, each
    /// open question of the Task's open work, each suggested change of
    /// direction not yet decided, and a revised brief waiting for approval. (Changed evidence under an open review is added by the
    /// reader that checks evidence.)
    pub fn pending(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Vec<PendingDecision>, TaskError> {
        let mut pending = Vec::new();
        for request in self.review_requests(project_id, research_id)? {
            if request.state == "open" {
                pending.push(PendingDecision {
                    key: format!("review:{}", request.id),
                    kind: "review",
                    ref_id: request.id,
                    since: request.created_at,
                });
            }
        }
        // Only open work's questions, as the card counts them: closed work
        // waits on no one.
        for summary in self.work.list(
            project_id,
            &WorkFilter {
                research_id: Some(research_id.to_owned()),
                limit: Some(200),
                ..Default::default()
            },
        )? {
            for request in self.work.decision_requests(project_id, &summary.item.id)? {
                if request.state == "open" {
                    pending.push(PendingDecision {
                        key: format!("question:{}:{}", summary.item.id, request.id),
                        kind: "question",
                        ref_id: request.id,
                        since: request.created_at,
                    });
                }
            }
        }
        // A suggested change of direction waits for the researcher to agree or decline.
        for proposal in self.research.proposals(project_id, research_id)? {
            if proposal.review.is_none() {
                pending.push(PendingDecision {
                    key: format!("suggestion:{}", proposal.entry.id),
                    kind: "suggestion",
                    ref_id: proposal.entry.id,
                    since: proposal.entry.created_at,
                });
            }
        }
        if self.admission(project_id, research_id)?.is_some() {
            let question = self.question(project_id, research_id)?;
            if question.revision > self.approved_revision(project_id, research_id)? {
                let since = self
                    .research
                    .revision(project_id, research_id, question.revision)
                    .map(|revision| revision.created_at)
                    .unwrap_or_else(|_| question.updated_at.clone());
                pending.push(PendingDecision {
                    key: format!("brief:{}", question.revision),
                    kind: "brief_approval",
                    ref_id: question.revision.to_string(),
                    since,
                });
            }
        }
        Ok(pending)
    }

    /// The brief's revisions with who wrote them and whether the researcher
    /// approved each, for the inspector.
    pub fn revisions(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Vec<RevisionNote>, TaskError> {
        let approved: Vec<u64> = self
            .authorizations(project_id, research_id)?
            .into_iter()
            .filter(|a| a.kind != AuthorizationKind::Execute)
            .map(|a| a.brief_revision)
            .collect();
        let mut revisions = self.research.revisions(project_id, research_id)?;
        revisions.reverse();
        Ok(revisions
            .into_iter()
            .map(|revision| RevisionNote {
                revision: revision.revision,
                author_kind: revision.author_kind.as_str().to_owned(),
                approved: approved.contains(&revision.revision),
                created_at: revision.created_at,
            })
            .collect())
    }
}
