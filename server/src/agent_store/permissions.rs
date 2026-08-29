use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use uuid::Uuid;

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
