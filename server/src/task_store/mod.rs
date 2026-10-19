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
         -- One instruction authorizes one thing of each kind, once.
         CREATE UNIQUE INDEX IF NOT EXISTS task_authorizations_message
           ON task_authorizations(kind, message_id) WHERE message_id IS NOT NULL;
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
           created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE INDEX IF NOT EXISTS task_events_task ON task_events(research_id, seq);",
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
    brief_revision, state, created_at, resolved_at FROM task_review_requests";

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
    })
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
        tx.execute(
            "INSERT INTO task_events (project_id, research_id, kind, ref_id) VALUES (?1, ?2, ?3, ?4)",
            params![project_id, research_id, kind, reference],
        )?;
        Ok(())
    }

    // -- Existing records (ADR 0221 §6) ------------------------------------------------------------

    /// A question whose round the researcher already started has an explicit
    /// authorization on record; it is admitted with `legacy_round` origin and
    /// no authorizing message. Nothing else is admitted retroactively.
    /// Idempotent; also run when the boards are read, so a round started from
    /// the research panel appears.
    pub fn adopt_legacy(&self) -> Result<usize, TaskError> {
        self.write(|tx| {
            let candidates: Vec<(String, String, String, i64)> = {
                let mut statement = tx.prepare(
                    "SELECT q.project_id, q.id, r.id, r.brief_revision
                     FROM research_questions q
                     JOIN research_rounds r ON r.research_id = q.id AND r.phase = 'started'
                     WHERE q.archived = 0
                       AND NOT EXISTS (SELECT 1 FROM task_authorizations a
                                       WHERE a.research_id = q.id AND a.kind = 'admit')
                     GROUP BY q.id
                     ORDER BY r.round",
                )?;
                statement
                    .query_map([], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?
                    .collect::<Result<_, _>>()?
            };
            let mut adopted = 0;
            for (project_id, research_id, round_id, revision) in &candidates {
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
                        "INSERT INTO task_authorizations
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
                Self::log(
                    tx,
                    project_id,
                    research_id,
                    "execution_authorized",
                    Some(round_id),
                )?;
                adopted += 1;
            }
            Ok((
                adopted,
                (adopted > 0).then(|| (String::new(), "legacy".to_owned())),
            ))
        })
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

    /// The stage: the last stage-affecting event decides. A question that was
    /// never admitted has none (it is a draft).
    pub fn stage(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Option<TaskStage>, TaskError> {
        let last: Option<String> = self
            .connection()
            .query_row(
                "SELECT kind FROM task_events
                 WHERE project_id = ?1 AND research_id = ?2
                   AND kind IN ('admitted', 'execution_authorized', 'review_requested',
                                'review_returned', 'review_accepted')
                 ORDER BY seq DESC LIMIT 1",
                params![project_id, research_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(last.map(|kind| match kind.as_str() {
            "execution_authorized" | "review_returned" => TaskStage::InProgress,
            "review_requested" => TaskStage::Review,
            "review_accepted" => TaskStage::Done,
            _ => TaskStage::Ready,
        }))
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
        text.push_str(&format!(
            "\n\n(Draft, revision {}. It is not on the board. Tell the General Agent in your own words to add it, or refine it first.)",
            question.revision
        ));
        text
    }

    /// Shows a brief revision to the researcher in General. A proposal is
    /// displayed by construction, so an authorization can only name something
    /// the researcher was shown (ADR 0221 §2).
    fn show_proposal(
        &self,
        project_id: &str,
        caller: &str,
        question: &ResearchQuestion,
    ) -> Result<Message, TaskError> {
        let channel = self.channels.default_channel(project_id)?;
        let reference = ContextRef::at(
            ContextKind::Research,
            &question.id,
            question.revision.to_string(),
        );
        let key = format!("proposal:{}:{}", question.id, question.revision);
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
        let (question, _) = self.research.create_authored(
            project_id,
            brief,
            client_request_id,
            AuthorKind::Agent,
            Some(caller),
        )?;
        let message = self.show_proposal(project_id, caller, &question)?;
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
        let message = self.show_proposal(project_id, caller, &question)?;
        Ok((question, message))
    }

    // -- Authorization ---------------------------------------------------------------------------------------

    /// Checks everything the server can know about an instruction: who wrote
    /// it, where, whether it is the researcher's own words, and that it
    /// followed the proposal it authorizes. The meaning of the words is the
    /// General Agent's to judge (ADR 0221 §2).
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
            return Err(TaskError::State("the question is archived"));
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

    /// The proposal at this exact revision was shown before the instruction.
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
        let shown = self.channels.first_citation_seq(
            project_id,
            &general.id,
            ContextKind::Research,
            &question.id,
            &brief_revision.to_string(),
        )?;
        match shown {
            Some(seq) if seq < message.seq => Ok(()),
            Some(_) => Err(TaskError::Stale(
                "the instruction came before the proposal at this revision was shown",
            )),
            None => Err(TaskError::Stale(
                "this revision was never shown to the researcher",
            )),
        }
    }

    fn insert_authorization(
        tx: &Transaction<'_>,
        project_id: &str,
        question: &ResearchQuestion,
        kind: AuthorizationKind,
        message_id: &str,
        acted_by: &str,
    ) -> Result<Authorization, TaskError> {
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
        )?;
        Ok(tx.query_row(
            &format!("{AUTH_SELECT} WHERE id = ?1"),
            [&id],
            auth_from_row,
        )?)
    }

    /// Puts a Task on the board because the researcher said so in
    /// `message_id`. Idempotent: the same authorization returns the same
    /// record and board identity; anything else is refused (ADR 0221 §2).
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
        // A retry of the same authorized admission is the same admission.
        if let Some(existing) = self.admission(project_id, research_id)? {
            return if existing.message_id.as_deref() == Some(message_id) {
                Ok((existing, false))
            } else {
                Err(TaskError::State("the Task is already on the board"))
            };
        }
        self.require_shown(project_id, &question, brief_revision, &message)?;
        let created = self.write(|tx| {
            let used: i64 = tx.query_row(
                "SELECT COUNT(*) FROM task_authorizations WHERE kind = 'admit' AND message_id = ?1",
                [message_id],
                |row| row.get(0),
            )?;
            if used > 0 {
                return Err(TaskError::MessageUsed);
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
                record,
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
        )?;
        Ok((created, true))
    }

    /// The General Agent says what it did, where the researcher said it.
    fn acknowledge(
        &self,
        project_id: &str,
        caller: &str,
        question: &ResearchQuestion,
        instruction: &Message,
        verb: &str,
        key: &str,
    ) -> Result<(), TaskError> {
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
        self.channels.post(
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
        )?;
        Ok(())
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
        if let Some(existing) = self
            .authorizations(project_id, research_id)?
            .into_iter()
            .find(|a| a.kind != AuthorizationKind::Execute && a.brief_revision == brief_revision)
        {
            return if existing.message_id.as_deref() == Some(message_id) {
                Ok((existing, false))
            } else {
                Err(TaskError::State("that revision is already approved"))
            };
        }
        self.require_shown(project_id, &question, brief_revision, &message)?;
        let record = self.write(|tx| {
            let used: i64 = tx.query_row(
                "SELECT COUNT(*) FROM task_authorizations WHERE kind = 'revise' AND message_id = ?1",
                [message_id],
                |row| row.get(0),
            )?;
            if used > 0 {
                return Err(TaskError::MessageUsed);
            }
            let record = Self::insert_authorization(
                tx,
                project_id,
                &question,
                AuthorizationKind::Revise,
                message_id,
                caller,
            )?;
            Ok((record, Some((project_id.to_owned(), research_id.to_owned()))))
        })?;
        self.acknowledge(
            project_id,
            caller,
            &question,
            &message,
            "Approved the revised brief",
            "approved",
        )?;
        Ok((record, true))
    }

    /// Lets an admitted Task execute because the researcher said so: starts a
    /// round pinned to the approved brief, with the General Agent as its
    /// coordinator. Idempotent per instruction. Sets no limit and no
    /// experiment envelope (ADR 0221 §3).
    pub fn start_execution(
        &self,
        project_id: &str,
        caller: &str,
        research_id: &str,
        message_id: &str,
    ) -> Result<(Authorization, bool), TaskError> {
        let (question, message) =
            self.check_instruction(project_id, caller, research_id, message_id)?;
        let admission = self
            .admission(project_id, research_id)?
            .ok_or(TaskError::State("the Task is not on the board yet"))?;
        let existing = self
            .authorizations(project_id, research_id)?
            .into_iter()
            .find(|a| {
                a.kind == AuthorizationKind::Execute && a.message_id.as_deref() == Some(message_id)
            });
        let approved = self.approved_revision(project_id, research_id)?;
        if existing.is_none() {
            if self.stage(project_id, research_id)? == Some(TaskStage::Review) {
                return Err(TaskError::State(
                    "the Task is waiting for the researcher's review",
                ));
            }
            if approved != question.revision {
                return Err(TaskError::State(
                    "a revised brief is waiting for the researcher's approval",
                ));
            }
            // The instruction follows the admission it builds on (or is it).
            if let Some(admitted_by) = admission.message_id.as_deref()
                && let Ok(admitting) = self.channels.message(project_id, admitted_by)
                && message.seq < admitting.seq
            {
                return Err(TaskError::Stale(
                    "the instruction came before the Task was admitted",
                ));
            }
        }
        let (record, created) = match existing {
            Some(record) => (record, false),
            None => {
                let record = self.write(|tx| {
                    let used: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM task_authorizations
                         WHERE kind = 'execute' AND message_id = ?1",
                        [message_id],
                        |row| row.get(0),
                    )?;
                    if used > 0 {
                        return Err(TaskError::MessageUsed);
                    }
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
        // The round steps are idempotent, so a crash after the record is
        // finished by repeating the same instruction.
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
                idempotency_key: &format!("task-{}", record.id),
                expected_revision: question.revision,
                request: json!({"task": true, "authorized_by_message": message_id}),
                sources: Vec::new(),
            },
        )?;
        self.research
            .round_set_session(project_id, research_id, &round.id, &session)?;
        self.research
            .round_mark_started(project_id, research_id, &round.id)?;
        if self.work.coordinator(project_id, &round.id)?.is_none() {
            self.work
                .assume_coordinator(project_id, &round.id, &session, &Actor::Researcher)?;
        }
        let finished = self.write(|tx| {
            tx.execute(
                "UPDATE task_authorizations SET round_id = ?2 WHERE id = ?1 AND round_id IS NULL",
                params![record.id, round.id],
            )?;
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
        // A question that was resolved and is iterated on is open again.
        let _ = self
            .research
            .set_status(project_id, research_id, ResearchStatus::Open);
        self.acknowledge(
            project_id,
            caller,
            &question,
            &message,
            "Started execution of",
            "started",
        )?;
        Ok((finished, created))
    }

    // -- Review ----------------------------------------------------------------------------------------------

    /// The General Agent reports results and asks the researcher to review
    /// (it does not review specialist work itself). One request is open at a time.
    pub fn request_review(
        &self,
        project_id: &str,
        caller: &str,
        research_id: &str,
        summary: &str,
        evidence: &[String],
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
        if evidence.len() > MAX_EVIDENCE {
            return Err(TaskError::Invalid("too much evidence on one request"));
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
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO task_review_requests
                   (id, project_id, research_id, summary, evidence_json, requested_by, brief_revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    project_id,
                    research_id,
                    summary,
                    serde_json::to_string(evidence)?,
                    caller,
                    question.revision as i64
                ],
            )?;
            Self::log(tx, project_id, research_id, "review_requested", Some(&id))?;
            let stored = tx.query_row(
                &format!("{REQUEST_SELECT} WHERE id = ?1"),
                [&id],
                request_from_row,
            )?;
            Ok(((stored, true), Some((project_id.to_owned(), research_id.to_owned()))))
        })?;
        if created {
            let channel = self.channels.default_channel(project_id)?;
            let reference = ContextRef::at(
                ContextKind::Research,
                &question.id,
                question.revision.to_string(),
            );
            let body = format!(
                "Ready for your review: \"{}\".\n\n{summary}",
                question.brief.title
            );
            self.channels.post(
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
            )?;
        }
        Ok((request, created))
    }

    /// The researcher accepts the Task's results (with the scientific outcome
    /// they judge) or sends it back with a reason. A well-supported negative
    /// finding completes a Task.
    pub fn review(
        &self,
        project_id: &str,
        research_id: &str,
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
        let _ = self.research.add_entry(
            project_id,
            research_id,
            NewEntry {
                kind: EntryKind::Decision,
                author_kind: AuthorKind::Researcher,
                author_ref: None,
                body: text.clone(),
                client_request_id: Some(format!("task-review:{}", stored.id)),
            },
        );
        if stored.accepted {
            let _ = self
                .research
                .set_status(project_id, research_id, ResearchStatus::Resolved);
        }
        if let Ok(channel) = self.channels.default_channel(project_id) {
            let reference = ContextRef::at(
                ContextKind::Research,
                &question.id,
                question.revision.to_string(),
            );
            let _ = self.channels.post(
                project_id,
                &channel.id,
                NewMessage {
                    body: &text,
                    author_kind: Some(ChannelAuthor::System),
                    references: std::slice::from_ref(&reference),
                    client_message_id: Some(&format!("task-review:{}", stored.id)),
                    ..Default::default()
                },
            );
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
        }))
    }

    /// The single board: every admitted Task of the Workspace, in its stage.
    pub fn board(&self, project_id: &str) -> Result<TaskBoard, TaskError> {
        self.adopt_legacy()?;
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
        })
    }

    /// Proposals that are not on the board.
    pub fn drafts(&self, project_id: &str) -> Result<Vec<Draft>, TaskError> {
        self.adopt_legacy()?;
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
            drafts.push(Draft {
                id: summary.id,
                project_id: summary.project_id,
                title: summary.title,
                question: question.brief.question,
                revision: summary.revision,
                proposed_by,
                updated_at: summary.updated_at,
            });
        }
        Ok(drafts)
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
