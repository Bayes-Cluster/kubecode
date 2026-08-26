use std::str::FromStr;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::composer_catalog::{ComposerCatalogSnapshot, project_available_commands};

use super::AgentStore;
use super::composer::{
    authoritative_catalog_transaction, issue_catalog_snapshot_transaction,
    latest_catalog_transaction, next_catalog_revision_transaction,
};
use super::events::{RuntimeRunEvent, RuntimeUpdate};
use super::events::{
    append_session_event_transaction, append_session_state_workspace_event_transaction,
};
use super::models::{
    AgentEvent, AgentEventKind, AgentId, AgentRun, PermissionMode, RunCheckpoint, RunStatus,
    StoreError, to_sql_conversion_error,
};

impl AgentStore {
    pub fn start_run(
        &self,
        conversation_id: &str,
        project_id: &str,
        message: &str,
        permission_mode: PermissionMode,
    ) -> Result<AgentRun, StoreError> {
        self.start_run_with_visibility(
            conversation_id,
            project_id,
            message,
            permission_mode,
            false,
            None,
        )
    }

    pub fn start_run_with_client_message_id(
        &self,
        conversation_id: &str,
        project_id: &str,
        message: &str,
        permission_mode: PermissionMode,
        client_message_id: Option<&str>,
    ) -> Result<AgentRun, StoreError> {
        self.start_run_with_visibility(
            conversation_id,
            project_id,
            message,
            permission_mode,
            false,
            client_message_id,
        )
    }

    pub fn start_internal_run(
        &self,
        conversation_id: &str,
        project_id: &str,
        message: &str,
        permission_mode: PermissionMode,
    ) -> Result<AgentRun, StoreError> {
        self.start_run_with_visibility(
            conversation_id,
            project_id,
            message,
            permission_mode,
            true,
            None,
        )
    }

    fn start_run_with_visibility(
        &self,
        conversation_id: &str,
        project_id: &str,
        message: &str,
        permission_mode: PermissionMode,
        internal: bool,
        client_message_id: Option<&str>,
    ) -> Result<AgentRun, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let conversation_project = transaction
            .query_row(
                "SELECT project_id FROM conversations WHERE id = ?1",
                [conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        if let Some(run) = existing_run_by_client_message_id(&transaction, client_message_id)? {
            // Exactly-once send: a retried request with the same client
            // message id returns the run it already created instead of
            // starting a second turn.
            return Ok(run);
        }
        let active = transaction
            .query_row(
                "SELECT id FROM agent_runs
                 WHERE conversation_id = ?1 AND status IN ('running', 'waiting_permission')
                 LIMIT 1",
                [conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if active.is_some() {
            return Err(StoreError::ActiveRun(project_id.to_owned()));
        }

        let run = AgentRun {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_owned(),
            project_id: project_id.to_owned(),
            message: message.to_owned(),
            status: RunStatus::Running,
            permission_mode,
            error: None,
            internal,
            client_message_id: client_message_id.map(str::to_owned),
        };
        transaction.execute(
            "INSERT INTO agent_runs
             (id, conversation_id, project_id, message, status, permission_mode, internal,
              client_message_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                run.id,
                run.conversation_id,
                run.project_id,
                run.message,
                run.status.as_str(),
                run.permission_mode.as_str(),
                run.internal,
                run.client_message_id,
            ],
        )?;
        transaction.execute(
            "UPDATE conversations
             SET updated_at = STRFTIME('%Y-%m-%d %H:%M:%f', 'now')
             WHERE id = ?1",
            [&run.conversation_id],
        )?;
        let (_, workspace_cursor) = append_event_transaction(
            &transaction,
            &run.id,
            AgentEventKind::RunStarted,
            &json!({"permission_mode": permission_mode}),
        )?;
        transaction.commit()?;
        self.workspace_event_bus.publish_committed(workspace_cursor);
        drop(database);
        if !internal {
            self.set_agent_title_if_untitled(conversation_id, message)?;
        }
        self.append_session_event(
            conversation_id,
            "user_message",
            &user_message_payload(&run, message, internal),
        )?;
        Ok(run)
    }

    pub fn run_by_client_message_id(
        &self,
        client_message_id: &str,
    ) -> Result<Option<AgentRun>, StoreError> {
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .query_row(
                "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal, client_message_id
                 FROM agent_runs WHERE client_message_id = ?1 LIMIT 1",
                [client_message_id],
                run_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn get_run(&self, run_id: &str) -> Result<AgentRun, StoreError> {
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .query_row(
                "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal, client_message_id
                 FROM agent_runs WHERE id = ?1",
                [run_id],
                run_from_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::RunNotFound(run_id.to_owned()))
    }

    pub fn set_run_checkpoint(
        &self,
        run_id: &str,
        before_tree: Option<&str>,
        after_tree: Option<&str>,
    ) -> Result<(), StoreError> {
        self.get_run(run_id)?;
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO run_checkpoints (run_id, before_tree, after_tree)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(run_id) DO UPDATE SET
                   before_tree = COALESCE(excluded.before_tree, run_checkpoints.before_tree),
                   after_tree = COALESCE(excluded.after_tree, run_checkpoints.after_tree),
                   updated_at = CURRENT_TIMESTAMP",
                params![run_id, before_tree, after_tree],
            )?;
        Ok(())
    }

    pub fn run_checkpoint(&self, run_id: &str) -> Result<Option<RunCheckpoint>, StoreError> {
        self.get_run(run_id)?;
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .query_row(
                "SELECT run_id, before_tree, after_tree FROM run_checkpoints WHERE run_id = ?1",
                [run_id],
                |row| {
                    Ok(RunCheckpoint {
                        run_id: row.get(0)?,
                        before_tree: row.get(1)?,
                        after_tree: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_runs(&self, conversation_id: &str) -> Result<Vec<AgentRun>, StoreError> {
        self.get_conversation(conversation_id)?;
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal, client_message_id
             FROM agent_runs WHERE conversation_id = ?1 ORDER BY rowid",
        )?;
        let rows = statement.query_map([conversation_id], run_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_runs_page(
        &self,
        conversation_id: &str,
        before_run_id: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<AgentRun>, bool), StoreError> {
        self.get_conversation(conversation_id)?;
        let database = self.database.lock().expect("agent database mutex poisoned");
        let before_rowid = if let Some(run_id) = before_run_id {
            database
                .query_row(
                    "SELECT rowid FROM agent_runs
                     WHERE id = ?1 AND conversation_id = ?2",
                    params![run_id, conversation_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .ok_or_else(|| StoreError::RunNotFound(run_id.to_owned()))?
        } else {
            i64::MAX
        };
        let page_size = i64::try_from(limit.saturating_add(1)).map_err(|_| {
            StoreError::InvalidStoredValue("run page size exceeds SQLite range".into())
        })?;
        let mut statement = database.prepare(
            "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal, client_message_id
             FROM agent_runs
             WHERE conversation_id = ?1 AND rowid < ?2
             ORDER BY rowid DESC LIMIT ?3",
        )?;
        let mut runs = statement
            .query_map(
                params![conversation_id, before_rowid, page_size],
                run_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = runs.len() > limit;
        if has_more {
            runs.pop();
        }
        runs.reverse();
        Ok((runs, has_more))
    }

    pub fn list_project_runs(&self, project_id: &str) -> Result<Vec<AgentRun>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal, client_message_id
             FROM agent_runs WHERE project_id = ?1 ORDER BY rowid",
        )?;
        let rows = statement.query_map([project_id], run_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn set_run_status(&self, run_id: &str, status: RunStatus) -> Result<(), StoreError> {
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "UPDATE agent_runs SET status = ?2 WHERE id = ?1",
                params![run_id, status.as_str()],
            )?;
        if changed == 0 {
            return Err(StoreError::RunNotFound(run_id.to_owned()));
        }
        Ok(())
    }

    pub fn finish_run(
        &self,
        run_id: &str,
        status: RunStatus,
        error: Option<&str>,
    ) -> Result<(), StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE agent_runs
             SET status = ?2, error = ?3, completed_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status IN ('running', 'waiting_permission')",
            params![run_id, status.as_str(), error],
        )?;
        if changed == 0 {
            // Exactly-once terminal transition: a run that is already
            // terminal (e.g. a double cancel firing) records no second
            // completion; only a missing run is an error.
            let exists = transaction
                .query_row("SELECT 1 FROM agent_runs WHERE id = ?1", [run_id], |_| {
                    Ok(())
                })
                .optional()?;
            if exists.is_some() {
                return Ok(());
            }
            return Err(StoreError::RunNotFound(run_id.to_owned()));
        }
        let (_, workspace_cursor) = append_event_transaction(
            &transaction,
            run_id,
            AgentEventKind::RunCompleted,
            &json!({"status": status, "error": error}),
        )?;
        transaction.commit()?;
        self.workspace_event_bus.publish_committed(workspace_cursor);
        Ok(())
    }

    pub fn append_event(
        &self,
        run_id: &str,
        kind: AgentEventKind,
        payload: &Value,
    ) -> Result<AgentEvent, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (event, workspace_cursor) =
            append_event_transaction(&transaction, run_id, kind, payload)?;
        transaction.commit()?;
        self.workspace_event_bus.publish_committed(workspace_cursor);
        Ok(event)
    }

    pub fn append_runtime_update(
        &self,
        conversation_id: &str,
        session_kind: &str,
        session_payload: &Value,
        run_event: Option<(&str, AgentEventKind, &Value)>,
    ) -> Result<(), StoreError> {
        let update = RuntimeUpdate {
            session_kind: session_kind.to_owned(),
            session_payload: session_payload.clone(),
            run_event: run_event.map(|(run_id, kind, payload)| RuntimeRunEvent {
                run_id: run_id.to_owned(),
                kind,
                payload: payload.clone(),
            }),
            publish_session_state: false,
        };
        self.append_runtime_updates(conversation_id, &[update])
    }

    pub fn append_runtime_updates(
        &self,
        conversation_id: &str,
        updates: &[RuntimeUpdate],
    ) -> Result<(), StoreError> {
        if updates.is_empty() {
            return Ok(());
        }
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let conversation = transaction
            .query_row(
                "SELECT project_id, agent_id FROM conversations WHERE id = ?1",
                [conversation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))?;
        let project_id = conversation.0.clone();
        let agent_id = AgentId::from_str(&conversation.1)?;
        let mut latest_workspace_cursor = None;
        let mut publish_session_state = false;
        for update in updates {
            append_session_event_transaction(
                &transaction,
                conversation_id,
                &update.session_kind,
                &update.session_payload,
            )?;
            if update.session_kind == "available_commands" {
                let previous = latest_catalog_transaction(&transaction, conversation_id)?
                    .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
                let candidate = authoritative_catalog_transaction(
                    &transaction,
                    &project_id,
                    conversation_id,
                    agent_id,
                    previous.revision,
                )?;
                if !previous.same_contents(&candidate) {
                    let next_revision =
                        next_catalog_revision_transaction(&transaction, conversation_id)?;
                    let candidate = authoritative_catalog_transaction(
                        &transaction,
                        &project_id,
                        conversation_id,
                        agent_id,
                        next_revision,
                    )?;
                    latest_workspace_cursor = Some(issue_catalog_snapshot_transaction(
                        &transaction,
                        &project_id,
                        conversation_id,
                        &candidate,
                    )?);
                }
            }
            if let Some(run_event) = &update.run_event {
                let run_payload = if run_event.kind == AgentEventKind::AvailableCommands {
                    project_available_commands(&run_event.payload)
                } else {
                    run_event.payload.clone()
                };
                let (_, workspace_cursor) = append_event_transaction(
                    &transaction,
                    &run_event.run_id,
                    run_event.kind,
                    &run_payload,
                )?;
                latest_workspace_cursor = Some(workspace_cursor);
            } else {
                publish_session_state |= update.publish_session_state;
            }
        }
        if publish_session_state {
            latest_workspace_cursor = Some(append_session_state_workspace_event_transaction(
                &transaction,
                &project_id,
                conversation_id,
            )?);
        }
        transaction.commit()?;
        if let Some(cursor) = latest_workspace_cursor {
            self.workspace_event_bus.publish_committed(cursor);
        }
        Ok(())
    }

    pub fn append_session_state_checkpoint(
        &self,
        conversation_id: &str,
        kind: &str,
        payload: &Value,
    ) -> Result<(), StoreError> {
        let workspace_cursor = {
            let mut database = self.database.lock().expect("agent database mutex poisoned");
            let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let project_id = transaction
                .query_row(
                    "SELECT project_id FROM conversations WHERE id = ?1",
                    [conversation_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))?;
            append_session_event_transaction(&transaction, conversation_id, kind, payload)?;
            let workspace_cursor = append_session_state_workspace_event_transaction(
                &transaction,
                &project_id,
                conversation_id,
            )?;
            transaction.commit()?;
            workspace_cursor
        };
        self.workspace_event_bus.publish_committed(workspace_cursor);
        Ok(())
    }
}

pub(super) fn append_event_transaction(
    transaction: &Transaction<'_>,
    run_id: &str,
    kind: AgentEventKind,
    payload: &Value,
) -> Result<(AgentEvent, u64), StoreError> {
    let run_scope = transaction
        .query_row(
            "SELECT project_id, conversation_id FROM agent_runs WHERE id = ?1",
            [run_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::RunNotFound(run_id.to_owned()))?;
    let stored_seq = transaction.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_events WHERE run_id = ?1",
        [run_id],
        |row| row.get::<_, i64>(0),
    )?;
    let payload = serde_json::to_string(payload)?;
    transaction.execute(
        "INSERT INTO agent_events (run_id, seq, kind, payload)
         VALUES (?1, ?2, ?3, ?4)",
        params![run_id, stored_seq, kind.as_str(), payload],
    )?;
    transaction.execute(
        "INSERT INTO workspace_events
         (kind, project_id, conversation_id, run_id, payload)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![kind.as_str(), run_scope.0, run_scope.1, run_id, payload],
    )?;
    let workspace_cursor = u64::try_from(transaction.last_insert_rowid())
        .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))?;
    let created_at = transaction.query_row(
        "SELECT created_at FROM agent_events WHERE run_id = ?1 AND seq = ?2",
        params![run_id, stored_seq],
        |row| row.get::<_, String>(0),
    )?;
    Ok((
        AgentEvent {
            run_id: run_id.to_owned(),
            seq: u64::try_from(stored_seq).map_err(|_| {
                StoreError::InvalidStoredValue("negative event sequence in database".into())
            })?,
            kind,
            payload: serde_json::from_str(&payload)?,
            created_at,
        },
        workspace_cursor,
    ))
}

pub(super) fn existing_run_by_client_message_id(
    transaction: &Transaction<'_>,
    client_message_id: Option<&str>,
) -> Result<Option<AgentRun>, StoreError> {
    let Some(client_message_id) = client_message_id else {
        return Ok(None);
    };
    let run = transaction
        .query_row(
            "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal, client_message_id
             FROM agent_runs WHERE client_message_id = ?1 LIMIT 1",
            [client_message_id],
            run_from_row,
        )
        .optional()?;
    Ok(run)
}

pub(super) fn insert_run_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    project_id: &str,
    message: &str,
    permission_mode: PermissionMode,
    internal: bool,
    client_message_id: Option<&str>,
) -> Result<AgentRun, StoreError> {
    let run = AgentRun {
        id: Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_owned(),
        project_id: project_id.to_owned(),
        message: message.to_owned(),
        status: RunStatus::Running,
        permission_mode,
        error: None,
        internal,
        client_message_id: client_message_id.map(str::to_owned),
    };
    transaction.execute(
        "INSERT INTO agent_runs
         (id, conversation_id, project_id, message, status, permission_mode, internal,
          client_message_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            run.id,
            run.conversation_id,
            run.project_id,
            run.message,
            run.status.as_str(),
            run.permission_mode.as_str(),
            run.internal,
            run.client_message_id,
        ],
    )?;
    transaction.execute(
        "UPDATE conversations
         SET updated_at = STRFTIME('%Y-%m-%d %H:%M:%f', 'now')
         WHERE id = ?1",
        [&run.conversation_id],
    )?;
    append_event_transaction(
        transaction,
        &run.id,
        AgentEventKind::RunStarted,
        &json!({"permission_mode": permission_mode}),
    )?;
    Ok(run)
}

fn run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRun> {
    let status = row.get::<_, String>(4)?;
    let permission_mode = row.get::<_, String>(5)?;
    Ok(AgentRun {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        project_id: row.get(2)?,
        message: row.get(3)?,
        status: RunStatus::from_str(&status).map_err(to_sql_conversion_error)?,
        permission_mode: PermissionMode::from_str(&permission_mode)
            .map_err(to_sql_conversion_error)?,
        error: row.get(6)?,
        internal: row.get(7)?,
        client_message_id: row.get(8)?,
    })
}

pub(super) fn user_message_payload(run: &AgentRun, text: &str, internal: bool) -> Value {
    let mut payload = json!({"run_id":run.id, "text":text, "internal":internal});
    if let Some(client_message_id) = &run.client_message_id {
        payload["client_message_id"] = json!(client_message_id);
    }
    payload
}
