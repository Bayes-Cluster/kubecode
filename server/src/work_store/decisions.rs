//! Human decisions and server-owned analysis transitions (ADR 0219).
//!
//! A *decision request* is a bounded question an agent puts to the researcher
//! about one task: the question, the options, and what is at stake. Answering
//! it unblocks that task and nothing else. It never widens a limit, edits a
//! brief, or authorizes a round — those are explicit versioned actions of their
//! own — so answering a message alone cannot expand authority.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::*;

const MAX_QUESTION_CHARS: usize = 1_000;
const MAX_OPTIONS: usize = 6;
/// Open questions one task may have at a time.
const MAX_OPEN_REQUESTS: i64 = 5;
const MAX_OPTION_CHARS: usize = 200;
const MAX_IMPACT_CHARS: usize = 1_000;
const MAX_KEY_CHARS: usize = 128;
const OPEN_PREFIX: &str = "decision needed: ";
const ATTENTION_PREFIX: &str = "attention: ";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DecisionRequest {
    pub id: String,
    pub project_id: String,
    pub work_id: String,
    pub thread_id: Option<String>,
    pub question: String,
    pub options: Vec<String>,
    pub impact: Option<String>,
    pub asked_by: String,
    /// `open` until the researcher answers.
    pub state: String,
    pub answer: Option<String>,
    pub answered_by: Option<String>,
    pub created_at: String,
    pub answered_at: Option<String>,
}

/// An open question with the work and Task it concerns.
#[derive(Clone, Debug, Serialize)]
pub struct OpenDecision {
    pub request: DecisionRequest,
    pub work_title: String,
    pub research_id: Option<String>,
}

/// An open assignment: a Session working on a piece of work.
#[derive(Clone, Debug, Serialize)]
pub struct OpenAssignment {
    pub conversation_id: String,
    pub work_id: String,
    pub work_title: String,
    pub research_id: Option<String>,
    pub started_at: String,
}

const REQUEST_SELECT: &str = "SELECT id, project_id, work_id, thread_id, question, options_json,
        impact, asked_by, state, answer, answered_by, created_at, answered_at
    FROM decision_requests";

fn request_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DecisionRequest> {
    let options: String = row.get(5)?;
    Ok(DecisionRequest {
        id: row.get(0)?,
        project_id: row.get(1)?,
        work_id: row.get(2)?,
        thread_id: row.get(3)?,
        question: row.get(4)?,
        options: serde_json::from_str(&options).unwrap_or_default(),
        impact: row.get(6)?,
        asked_by: row.get(7)?,
        state: row.get(8)?,
        answer: row.get(9)?,
        answered_by: row.get(10)?,
        created_at: row.get(11)?,
        answered_at: row.get(12)?,
    })
}

fn flatten(text: &str, max: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

impl WorkStore {
    /// Puts a bounded question to the researcher about one task. Repeating the
    /// same `request_key` returns the stored request. The task is marked as
    /// needing input (if nothing else already flags it) until it is answered.
    #[allow(clippy::too_many_arguments)]
    pub fn request_decision(
        &self,
        project_id: &str,
        work_id: &str,
        request_key: &str,
        asked_by: &str,
        question: &str,
        options: &[String],
        impact: Option<&str>,
        thread_id: Option<&str>,
    ) -> Result<(DecisionRequest, bool), WorkError> {
        let question = question.trim();
        if question.is_empty() || question.chars().count() > MAX_QUESTION_CHARS {
            return Err(WorkError::Invalid(
                "a question of 1 to 1000 characters is required",
            ));
        }
        if options.len() > MAX_OPTIONS
            || options
                .iter()
                .any(|option| option.trim().is_empty() || option.chars().count() > MAX_OPTION_CHARS)
        {
            return Err(WorkError::Invalid(
                "at most 6 options of 1 to 200 characters",
            ));
        }
        if impact.is_some_and(|text| text.chars().count() > MAX_IMPACT_CHARS) {
            return Err(WorkError::Invalid("the impact is too long"));
        }
        let key = request_key.trim();
        if key.is_empty() || key.chars().count() > MAX_KEY_CHARS {
            return Err(WorkError::Invalid("a request key is required"));
        }
        self.write(|tx| {
            let item = load_item(tx, project_id, work_id)?;
            if item.origin != WorkOrigin::Native {
                return Err(WorkError::LegacyOwned);
            }
            if item.lifecycle != WorkLifecycle::Active {
                return Err(WorkError::Closed(item.lifecycle.as_str()));
            }
            if let Some(existing) = tx
                .query_row(
                    &format!("{REQUEST_SELECT} WHERE work_id = ?1 AND request_key = ?2"),
                    params![work_id, key],
                    request_from_row,
                )
                .optional()?
            {
                return Ok(((existing, false), None));
            }
            let open: i64 = tx.query_row(
                "SELECT COUNT(*) FROM decision_requests WHERE work_id = ?1 AND state = 'open'",
                [work_id],
                |row| row.get(0),
            )?;
            if open >= MAX_OPEN_REQUESTS {
                return Err(WorkError::Invalid(
                    "this task already has 5 open questions; wait for answers",
                ));
            }
            let id = new_id();
            tx.execute(
                "INSERT INTO decision_requests
                   (id, project_id, work_id, thread_id, request_key, question, options_json,
                    impact, asked_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    id,
                    project_id,
                    work_id,
                    thread_id,
                    key,
                    question,
                    serde_json::to_string(options)?,
                    impact,
                    asked_by,
                ],
            )?;
            if item.condition == WorkCondition::None {
                tx.execute(
                    "UPDATE work_items SET condition = 'needs_input', condition_reason = ?2,
                       updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                    params![work_id, format!("{OPEN_PREFIX}{}", flatten(question, 120))],
                )?;
            }
            let stored = tx.query_row(
                &format!("{REQUEST_SELECT} WHERE id = ?1"),
                [&id],
                request_from_row,
            )?;
            Ok((
                (stored, true),
                Some((project_id.to_owned(), work_id.to_owned(), Change::Decision)),
            ))
        })
    }

    /// Records the researcher's answer. It unblocks the task if this was what
    /// flagged it; it changes no limit, brief, or round.
    pub fn answer_decision(
        &self,
        project_id: &str,
        request_id: &str,
        answer: &str,
        answered_by: &str,
    ) -> Result<DecisionRequest, WorkError> {
        let answer = answer.trim();
        if answer.is_empty() || answer.chars().count() > MAX_QUESTION_CHARS {
            return Err(WorkError::Invalid(
                "an answer of 1 to 1000 characters is required",
            ));
        }
        self.write(|tx| {
            let request = tx
                .query_row(
                    &format!("{REQUEST_SELECT} WHERE id = ?1 AND project_id = ?2"),
                    params![request_id, project_id],
                    request_from_row,
                )
                .optional()?
                .ok_or(WorkError::NotFound)?;
            if request.state != "open" {
                return if request.answer.as_deref() == Some(answer) {
                    Ok((request, None))
                } else {
                    Err(WorkError::Invalid("this question was already answered"))
                };
            }
            if !request.options.is_empty() && !request.options.iter().any(|option| option == answer)
            {
                return Err(WorkError::Invalid("choose one of the offered options"));
            }
            tx.execute(
                "UPDATE decision_requests SET state = 'answered', answer = ?2, answered_by = ?3,
                   answered_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![request_id, answer, answered_by],
            )?;
            let still_open: i64 = tx.query_row(
                "SELECT COUNT(*) FROM decision_requests WHERE work_id = ?1 AND state = 'open'",
                [&request.work_id],
                |row| row.get(0),
            )?;
            if still_open == 0 {
                tx.execute(
                    "UPDATE work_items SET condition = 'none', condition_reason = NULL,
                       updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?1 AND condition = 'needs_input' AND condition_reason LIKE ?2",
                    params![request.work_id, format!("{OPEN_PREFIX}%")],
                )?;
            }
            refresh_readiness(tx, project_id)?;
            let stored = tx.query_row(
                &format!("{REQUEST_SELECT} WHERE id = ?1"),
                [request_id],
                request_from_row,
            )?;
            Ok((
                stored,
                Some((project_id.to_owned(), request.work_id, Change::Decision)),
            ))
        })
    }

    pub fn decision_request(
        &self,
        project_id: &str,
        request_id: &str,
    ) -> Result<DecisionRequest, WorkError> {
        self.connection()
            .query_row(
                &format!("{REQUEST_SELECT} WHERE id = ?1 AND project_id = ?2"),
                params![request_id, project_id],
                request_from_row,
            )
            .optional()?
            .ok_or(WorkError::NotFound)
    }

    /// A task's decision requests, oldest first.
    pub fn decision_requests(
        &self,
        project_id: &str,
        work_id: &str,
    ) -> Result<Vec<DecisionRequest>, WorkError> {
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "{REQUEST_SELECT} WHERE work_id = ?1 AND project_id = ?2 ORDER BY created_at, rowid"
        ))?;
        Ok(statement
            .query_map(params![work_id, project_id], request_from_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Every open question of a Project, with its work's title and the Task
    /// (research question) it belongs to: what the attention projection lists.
    pub fn open_decisions(&self, project_id: &str) -> Result<Vec<OpenDecision>, WorkError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT d.id, d.project_id, d.work_id, d.thread_id, d.question, d.options_json,
                    d.impact, d.asked_by, d.state, d.answer, d.answered_by, d.created_at,
                    d.answered_at, w.title, w.research_id
             FROM decision_requests d JOIN work_items w ON w.id = d.work_id
             WHERE d.project_id = ?1 AND d.state = 'open'
             ORDER BY d.created_at, d.rowid",
        )?;
        Ok(statement
            .query_map([project_id], |row| {
                Ok(OpenDecision {
                    request: request_from_row(row)?,
                    work_title: row.get(13)?,
                    research_id: row.get(14)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Every assignment still open in a Project: which Session works on what.
    pub fn open_assignments(&self, project_id: &str) -> Result<Vec<OpenAssignment>, WorkError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT a.conversation_id, a.task_id, w.title, w.research_id, a.started_at
             FROM work_assignments a JOIN work_items w ON w.id = a.task_id
             WHERE w.project_id = ?1 AND a.ended_at IS NULL
             ORDER BY a.started_at DESC, a.rowid DESC",
        )?;
        Ok(statement
            .query_map([project_id], |row| {
                Ok(OpenAssignment {
                    conversation_id: row.get(0)?,
                    work_id: row.get(1)?,
                    work_title: row.get(2)?,
                    research_id: row.get(3)?,
                    started_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    // -- Server-owned transitions ------------------------------------------------------------

    /// A finished experiment of the task owes analysis: `executing` becomes
    /// `analyzing`. Server-owned (no actor): it only reports a fact the
    /// experiment store already holds. Idempotent.
    pub(crate) fn analysis_started(
        &self,
        project_id: &str,
        work_id: &str,
    ) -> Result<bool, WorkError> {
        self.write(|tx| {
            let item = load_item(tx, project_id, work_id)?;
            if item.origin != WorkOrigin::Native
                || item.lifecycle != WorkLifecycle::Active
                || item.stage != WorkStage::Executing
            {
                return Ok((false, None));
            }
            tx.execute(
                "UPDATE work_items SET stage = 'analyzing', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND stage = 'executing'",
                [work_id],
            )?;
            Ok((
                true,
                Some((project_id.to_owned(), work_id.to_owned(), Change::Analysis)),
            ))
        })
    }

    /// Every finished experiment of the task has been analyzed: `analyzing`
    /// returns to `executing`, where the executor continues or reports.
    pub(crate) fn analysis_resolved(
        &self,
        project_id: &str,
        work_id: &str,
    ) -> Result<bool, WorkError> {
        self.write(|tx| {
            let item = load_item(tx, project_id, work_id)?;
            if item.origin != WorkOrigin::Native
                || item.lifecycle != WorkLifecycle::Active
                || item.stage != WorkStage::Analyzing
            {
                return Ok((false, None));
            }
            tx.execute(
                "UPDATE work_items SET stage = 'executing', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND stage = 'analyzing'",
                [work_id],
            )?;
            Ok((
                true,
                Some((project_id.to_owned(), work_id.to_owned(), Change::Analysis)),
            ))
        })
    }

    /// A dispatch could never be delivered: the attempt it carried, which never
    /// began, is closed as failed so the task can be started again. A started
    /// attempt, or one already closed, is left alone. Server-owned.
    pub(crate) fn undelivered_attempt_failed(
        &self,
        project_id: &str,
        attempt_id: &str,
        reason: &str,
    ) -> Result<Option<crate::work_store::Attempt>, WorkError> {
        self.write(|tx| {
            let attempt = load_attempt(tx, project_id, attempt_id)?;
            if attempt.status != crate::work_store::AttemptStatus::Queued {
                return Ok((None, None));
            }
            tx.execute(
                "UPDATE work_attempts SET status = 'failed', failure_kind = 'dispatch_failed',
                   error = ?2, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status = 'queued'",
                params![attempt_id, flatten(reason, 200)],
            )?;
            tx.execute(
                "UPDATE work_items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [&attempt.task_id],
            )?;
            let closed = load_attempt(tx, project_id, attempt_id)?;
            Ok((
                Some(closed),
                Some((project_id.to_owned(), attempt.task_id, Change::Attempt)),
            ))
        })
    }

    /// Marks a task as needing a person's attention for a reason the server
    /// found (a limit reached, evidence that changed). It never overrides a
    /// condition someone else set. Returns whether it flagged the task.
    pub(crate) fn flag_attention(
        &self,
        project_id: &str,
        work_id: &str,
        reason: &str,
    ) -> Result<bool, WorkError> {
        self.write(|tx| {
            let item = load_item(tx, project_id, work_id)?;
            if item.origin != WorkOrigin::Native
                || item.lifecycle != WorkLifecycle::Active
                || item.condition != WorkCondition::None
            {
                return Ok((false, None));
            }
            tx.execute(
                "UPDATE work_items SET condition = 'needs_input', condition_reason = ?2,
                   updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![
                    work_id,
                    format!("{ATTENTION_PREFIX}{}", flatten(reason, 200))
                ],
            )?;
            Ok((
                true,
                Some((project_id.to_owned(), work_id.to_owned(), Change::Attention)),
            ))
        })
    }

    /// Clears an attention flag the server raised once its reason is gone.
    /// Only a flag whose reason mentions `about` is cleared, so resolving one
    /// cause never hides another.
    pub(crate) fn clear_attention(
        &self,
        project_id: &str,
        work_id: &str,
        about: &str,
    ) -> Result<bool, WorkError> {
        self.write(|tx| {
            let changed = tx.execute(
                "UPDATE work_items SET condition = 'none', condition_reason = NULL,
                   updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND project_id = ?2 AND condition = 'needs_input'
                   AND condition_reason LIKE ?3",
                params![work_id, project_id, format!("{ATTENTION_PREFIX}%{about}%")],
            )?;
            Ok((
                changed > 0,
                (changed > 0)
                    .then(|| (project_id.to_owned(), work_id.to_owned(), Change::Attention)),
            ))
        })
    }
}
