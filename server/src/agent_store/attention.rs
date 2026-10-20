//! Read helpers for the attention and delivery projections (ADR 0232): what
//! each Session is doing now and whether a prompt was admitted. One targeted
//! query each; nothing here writes.

use std::collections::HashMap;
use std::str::FromStr;

use rusqlite::{OptionalExtension, params_from_iter};

use super::AgentStore;
use super::models::{PromptQueueItem, RunStatus, StoreError};

/// A run that is working or waiting for an answer now.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveRun {
    pub run_id: String,
    pub conversation_id: String,
    pub status: RunStatus,
    pub started_at: String,
    /// The Session's title, for a Session that is not a member's.
    pub title: String,
}

/// A Session's latest non-internal run and how (or whether) it ended.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LatestRun {
    pub run_id: String,
    pub conversation_id: String,
    pub status: RunStatus,
    /// When it ended, or started if it has not.
    pub at: String,
}

/// What a Session did with a prompt delivered under a client message id.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Admission {
    Started { run_id: String, status: RunStatus },
    Queued { item_id: String, position: u32 },
}

fn status(text: String) -> rusqlite::Result<RunStatus> {
    RunStatus::from_str(&text).map_err(super::models::to_sql_conversion_error)
}

impl AgentStore {
    /// Runs of a Project that are working or waiting now: the latest per
    /// Session, never an internal run or a subagent's.
    pub fn active_runs(&self, project_id: &str) -> Result<Vec<ActiveRun>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT r.id, r.conversation_id, r.status, r.started_at, c.title
             FROM agent_runs r JOIN conversations c ON c.id = r.conversation_id
             WHERE r.project_id = ?1 AND r.status IN ('running', 'waiting_permission')
               AND r.internal = 0
               AND (c.relationship IS NULL OR c.relationship != 'subagent')
             ORDER BY r.rowid DESC",
        )?;
        let rows = statement.query_map([project_id], |row| {
            Ok(ActiveRun {
                run_id: row.get(0)?,
                conversation_id: row.get(1)?,
                status: status(row.get(2)?)?,
                started_at: row.get(3)?,
                title: row.get(4)?,
            })
        })?;
        let mut runs: Vec<ActiveRun> = Vec::new();
        for run in rows {
            let run = run?;
            if runs
                .iter()
                .all(|seen| seen.conversation_id != run.conversation_id)
            {
                runs.push(run);
            }
        }
        runs.reverse();
        Ok(runs)
    }

    /// The latest non-internal run of each of these Sessions.
    pub fn latest_runs(&self, conversation_ids: &[String]) -> Result<Vec<LatestRun>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut latest = Vec::new();
        for chunk in conversation_ids.chunks(100) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut statement = database.prepare(&format!(
                "SELECT r.id, r.conversation_id, r.status, COALESCE(r.completed_at, r.started_at)
                 FROM agent_runs r
                 WHERE r.internal = 0 AND r.conversation_id IN ({marks})
                   AND r.rowid = (SELECT MAX(l.rowid) FROM agent_runs l
                                  WHERE l.conversation_id = r.conversation_id AND l.internal = 0)"
            ))?;
            let rows = statement.query_map(params_from_iter(chunk.iter()), |row| {
                Ok(LatestRun {
                    run_id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    status: status(row.get(2)?)?,
                    at: row.get(3)?,
                })
            })?;
            for row in rows {
                latest.push(row?);
            }
        }
        Ok(latest)
    }

    /// Prompts waiting in each Session's queue (Sessions with none are absent).
    pub fn queued_counts(
        &self,
        conversation_ids: &[String],
    ) -> Result<HashMap<String, u32>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut counts = HashMap::new();
        for chunk in conversation_ids.chunks(100) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut statement = database.prepare(&format!(
                "SELECT conversation_id, COUNT(*) FROM conversation_prompt_queue
                 WHERE status = 'pending' AND conversation_id IN ({marks})
                 GROUP BY conversation_id"
            ))?;
            let rows = statement.query_map(params_from_iter(chunk.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32))
            })?;
            for row in rows {
                let (conversation, count) = row?;
                counts.insert(conversation, count);
            }
        }
        Ok(counts)
    }

    /// Whether a prompt delivered under `client_message_id` started a run or
    /// waits in the queue (and where); `None` when neither exists, for example
    /// a queued prompt the researcher removed.
    pub fn prompt_admission(
        &self,
        client_message_id: &str,
    ) -> Result<Option<Admission>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let run = database
            .query_row(
                "SELECT id, status FROM agent_runs WHERE client_message_id = ?1 LIMIT 1",
                [client_message_id],
                |row| {
                    Ok(Admission::Started {
                        run_id: row.get(0)?,
                        status: status(row.get(1)?)?,
                    })
                },
            )
            .optional()?;
        if run.is_some() {
            return Ok(run);
        }
        Ok(database
            .query_row(
                "SELECT q.id,
                        (SELECT COUNT(*) FROM conversation_prompt_queue o
                         WHERE o.conversation_id = q.conversation_id AND o.status = 'pending'
                           AND (o.position < q.position
                                OR (o.position = q.position AND o.rowid < q.rowid)))
                 FROM conversation_prompt_queue q
                 WHERE q.client_message_id = ?1 AND q.status = 'pending' LIMIT 1",
                [client_message_id],
                |row| {
                    Ok(Admission::Queued {
                        item_id: row.get(0)?,
                        position: row.get::<_, i64>(1)? as u32 + 1,
                    })
                },
            )
            .optional()?)
    }

    /// Direct messages waiting in a member's DM Session queue.
    pub fn dm_queued(&self, conversation_id: &str) -> Result<Vec<PromptQueueItem>, StoreError> {
        Ok(self
            .list_queued_prompts(conversation_id)?
            .into_iter()
            .filter(|item| {
                item.client_message_id
                    .as_deref()
                    .is_some_and(|key| key.starts_with("route:dm:"))
            })
            .collect())
    }
}
