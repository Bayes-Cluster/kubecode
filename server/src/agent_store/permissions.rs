use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

use serde::Serialize;

use super::AgentStore;
use super::models::{AgentId, StoreError};

impl AgentStore {
    /// Lists the persisted always-allow matchers for a project + agent.
    pub fn permission_matchers(
        &self,
        project_id: &str,
        agent_id: AgentId,
    ) -> Result<Vec<Value>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT matcher FROM agent_permission_rules
             WHERE project_id = ?1 AND agent_id = ?2 ORDER BY matcher",
        )?;
        let rows = statement.query_map(params![project_id, agent_id.as_str()], |row| {
            row.get::<_, String>(0)
        })?;
        rows.map(|row| {
            let matcher = row?;
            let value: Value = serde_json::from_str(&matcher)
                .map_err(|_| StoreError::InvalidStoredValue(matcher.clone()))?;
            Ok(value)
        })
        .collect()
    }

    pub fn allow_always(
        &self,
        project_id: &str,
        agent_id: AgentId,
        matcher: &Value,
    ) -> Result<(), StoreError> {
        let matcher = serde_json::to_string(matcher)?;
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT OR IGNORE INTO agent_permission_rules
                 (id, project_id, agent_id, matcher) VALUES (?1, ?2, ?3, ?4)",
                params![
                    Uuid::new_v4().to_string(),
                    project_id,
                    agent_id.as_str(),
                    matcher
                ],
            )?;
        Ok(())
    }

    pub fn is_allowed(
        &self,
        project_id: &str,
        agent_id: AgentId,
        matcher: &Value,
    ) -> Result<bool, StoreError> {
        let matcher = serde_json::to_string(matcher)?;
        Ok(self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .query_row(
                "SELECT 1 FROM agent_permission_rules
                 WHERE project_id = ?1 AND agent_id = ?2 AND matcher = ?3",
                params![project_id, agent_id.as_str(), matcher],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }
}

/// One decision the project manager made on a specialist's permission request
/// (ADR 0237): the audit the researcher reads afterwards. It never holds the
/// tool's input.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ManagerPermissionReview {
    pub id: String,
    pub project_id: String,
    pub request_id: String,
    pub run_id: String,
    pub conversation_id: String,
    /// The tool's title, as the researcher would have seen it.
    pub tool: String,
    /// `approved`, `denied`, or `escalated`.
    pub decision: String,
    pub option_id: Option<String>,
    pub reason: String,
    pub created_at: String,
}

impl AgentStore {
    pub fn record_manager_review(
        &self,
        review: &ManagerPermissionReview,
    ) -> Result<(), StoreError> {
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO manager_permission_reviews
                 (id, project_id, request_id, run_id, conversation_id, tool, decision,
                  option_id, reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    review.id,
                    review.project_id,
                    review.request_id,
                    review.run_id,
                    review.conversation_id,
                    review.tool,
                    review.decision,
                    review.option_id,
                    review.reason,
                    review.created_at,
                ],
            )?;
        Ok(())
    }

    /// A Workspace's latest manager decisions, newest first.
    pub fn manager_reviews(
        &self,
        project_id: &str,
        limit: usize,
    ) -> Result<Vec<ManagerPermissionReview>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, project_id, request_id, run_id, conversation_id, tool, decision,
                    option_id, reason, created_at
             FROM manager_permission_reviews WHERE project_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![project_id, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| {
                Ok(ManagerPermissionReview {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    request_id: row.get(2)?,
                    run_id: row.get(3)?,
                    conversation_id: row.get(4)?,
                    tool: row.get(5)?,
                    decision: row.get(6)?,
                    option_id: row.get(7)?,
                    reason: row.get(8)?,
                    created_at: row.get(9)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }
}
