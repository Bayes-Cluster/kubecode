use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::composer_catalog::ComposerCatalogSnapshot;

use super::AgentStore;
use super::composer::{
    authoritative_catalog_transaction, issue_catalog_snapshot_transaction,
    latest_catalog_transaction, next_catalog_revision_transaction,
};
use super::conversations::transcript_context;
use super::models::{ConversationRevision, RunStatus, StoreError};

impl AgentStore {
    pub fn revise_conversation_at_run(
        &self,
        conversation_id: &str,
        run_id: &str,
    ) -> Result<ConversationRevision, StoreError> {
        let source = self.get_conversation(conversation_id)?;
        let runs = self.list_runs(conversation_id)?;
        let target_index = runs
            .iter()
            .position(|run| run.id == run_id)
            .ok_or_else(|| StoreError::RunNotFound(run_id.to_owned()))?;
        if runs.iter().any(|run| {
            matches!(
                run.status,
                RunStatus::Running | RunStatus::WaitingPermission
            )
        }) {
            return Err(StoreError::ActiveRun(source.project_id));
        }
        // The boundary primitive owns the cut point (#99); the typed
        // open-turn rejection complements the any-active guard above.
        let boundary = self.resolve_turn_boundary(conversation_id, run_id)?;
        let source_events = self.session_events_after(conversation_id, 0)?;
        let retained_events = source_events
            .iter()
            .filter(|event| event.seq <= boundary.before_seq)
            .cloned()
            .collect::<Vec<_>>();
        let context_prefix = transcript_context(&retained_events);
        let revision_id = Uuid::new_v4().to_string();
        let snapshot_id = Uuid::new_v4().to_string();
        let removed_run_ids = runs[target_index..]
            .iter()
            .map(|run| run.id.clone())
            .collect::<Vec<_>>();

        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO conversations
             (id, agent_session_id, project_id, agent_id, provider_session_id, title,
              manual_title, agent_title, created_at, updated_at, archived,
              parent_conversation_id, relationship, read_only, execution_mode,
              workspace_path, recreated_context, context_prefix, internal_revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, 'branch', 1,
                     ?12, ?13, ?14, ?15, 1)",
            params![
                snapshot_id,
                source.agent_session_id,
                source.project_id,
                source.agent_id.as_str(),
                source.provider_session_id,
                source.title,
                source.manual_title,
                source.agent_title,
                source.created_at,
                source.updated_at,
                source.id,
                source.execution_mode.as_str(),
                source.workspace_path,
                source.recreated_context,
                source.context_prefix,
            ],
        )?;

        let stored_runs = {
            let mut statement = transaction.prepare(
                "SELECT id, project_id, message, status, permission_mode, error, internal,
                        started_at, completed_at
                 FROM agent_runs WHERE conversation_id = ?1 ORDER BY rowid",
            )?;
            statement
                .query_map([conversation_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let run_id_map = stored_runs
            .iter()
            .map(|(old_id, ..)| (old_id.clone(), Uuid::new_v4().to_string()))
            .collect::<std::collections::HashMap<_, _>>();
        for (
            old_id,
            project_id,
            message,
            status,
            permission_mode,
            error,
            internal,
            started_at,
            completed_at,
        ) in &stored_runs
        {
            let snapshot_run_id = run_id_map
                .get(old_id)
                .ok_or_else(|| StoreError::RunNotFound(old_id.clone()))?;
            transaction.execute(
                "INSERT INTO agent_runs
                 (id, conversation_id, project_id, message, status, permission_mode, error,
                  internal, started_at, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    snapshot_run_id,
                    snapshot_id,
                    project_id,
                    message,
                    status,
                    permission_mode,
                    error,
                    internal,
                    started_at,
                    completed_at,
                ],
            )?;
            transaction.execute(
                "INSERT INTO run_checkpoints (run_id, before_tree, after_tree, updated_at)
                 SELECT ?2, before_tree, after_tree, updated_at
                 FROM run_checkpoints WHERE run_id = ?1",
                params![old_id, snapshot_run_id],
            )?;
            let stored_events = {
                let mut statement = transaction.prepare(
                    "SELECT seq, kind, payload, created_at
                     FROM agent_events WHERE run_id = ?1 ORDER BY seq",
                )?;
                statement
                    .query_map([old_id], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for (seq, kind, payload, created_at) in stored_events {
                transaction.execute(
                    "INSERT INTO agent_events (run_id, seq, kind, payload, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![snapshot_run_id, seq, kind, payload, created_at],
                )?;
            }
        }

        for event in source_events
            .iter()
            .filter(|event| event.kind != "composer_catalog")
        {
            let mut payload = event.payload.clone();
            rewrite_payload_run_id(&mut payload, &run_id_map);
            transaction.execute(
                "INSERT INTO session_events
                 (conversation_id, seq, kind, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    snapshot_id,
                    i64::try_from(event.seq)
                        .map_err(|error| StoreError::InvalidStoredValue(error.to_string()))?,
                    event.kind,
                    serde_json::to_string(&payload)?,
                    event.created_at,
                ],
            )?;
        }
        transaction.execute(
            "INSERT INTO conversation_revisions
             (id, conversation_id, snapshot_conversation_id, forked_at_run_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![revision_id, conversation_id, snapshot_id, run_id],
        )?;
        transaction.execute(
            "DELETE FROM session_events WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        for event in &retained_events {
            transaction.execute(
                "INSERT INTO session_events
                 (conversation_id, seq, kind, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    conversation_id,
                    i64::try_from(event.seq)
                        .map_err(|error| StoreError::InvalidStoredValue(error.to_string()))?,
                    event.kind,
                    serde_json::to_string(&event.payload)?,
                    event.created_at,
                ],
            )?;
        }
        transaction.execute(
            "DELETE FROM composer_catalog_snapshots WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        for event in retained_events
            .iter()
            .filter(|event| event.kind == "composer_catalog")
        {
            let snapshot =
                serde_json::from_value::<ComposerCatalogSnapshot>(event.payload.clone())?;
            if snapshot.conversation_id != conversation_id {
                return Err(StoreError::InvalidStoredValue(
                    "composer catalog conversation mismatch".into(),
                ));
            }
            transaction.execute(
                "INSERT INTO composer_catalog_snapshots
                 (conversation_id, revision, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    conversation_id,
                    i64::try_from(snapshot.revision)
                        .map_err(|error| StoreError::InvalidStoredValue(error.to_string()))?,
                    serde_json::to_string(&snapshot)?,
                    event.created_at,
                ],
            )?;
        }
        for removed_run_id in &removed_run_ids {
            transaction.execute("DELETE FROM agent_runs WHERE id = ?1", [removed_run_id])?;
        }
        transaction.execute(
            "UPDATE conversations
             SET provider_session_id = NULL, recreated_context = 1, context_prefix = ?2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![
                conversation_id,
                (!context_prefix.is_empty()).then_some(context_prefix),
            ],
        )?;
        let restored = latest_catalog_transaction(&transaction, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
        let expected = authoritative_catalog_transaction(
            &transaction,
            &source.project_id,
            conversation_id,
            source.agent_id,
            restored.revision,
        )?;
        let mut catalog_workspace_cursor = None;
        if !restored.same_contents(&expected) {
            let revision = next_catalog_revision_transaction(&transaction, conversation_id)?;
            let reconciled = authoritative_catalog_transaction(
                &transaction,
                &source.project_id,
                conversation_id,
                source.agent_id,
                revision,
            )?;
            catalog_workspace_cursor = Some(issue_catalog_snapshot_transaction(
                &transaction,
                &source.project_id,
                conversation_id,
                &reconciled,
            )?);
        }
        transaction.commit()?;
        drop(database);
        if let Some(cursor) = catalog_workspace_cursor {
            self.workspace_event_bus.publish_committed(cursor);
        }
        self.append_workspace_event(
            "session_revision_created",
            Some(&source.project_id),
            Some(conversation_id),
            None,
            &json!({"revision_id":revision_id, "forked_at_run_id":run_id}),
        )?;
        self.get_revision(&revision_id)
    }

    pub fn list_revisions(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ConversationRevision>, StoreError> {
        self.get_conversation(conversation_id)?;
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, conversation_id, snapshot_conversation_id, forked_at_run_id, created_at
             FROM conversation_revisions WHERE conversation_id = ?1 ORDER BY created_at, rowid",
        )?;
        statement
            .query_map([conversation_id], revision_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    fn get_revision(&self, revision_id: &str) -> Result<ConversationRevision, StoreError> {
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .query_row(
                "SELECT id, conversation_id, snapshot_conversation_id, forked_at_run_id, created_at
                 FROM conversation_revisions WHERE id = ?1",
                [revision_id],
                revision_from_row,
            )
            .optional()?
            .ok_or_else(|| {
                StoreError::InvalidStoredValue(format!(
                    "conversation revision not found: {revision_id}"
                ))
            })
    }
}

fn revision_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationRevision> {
    Ok(ConversationRevision {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        snapshot_conversation_id: row.get(2)?,
        forked_at_run_id: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn rewrite_payload_run_id(
    payload: &mut Value,
    run_id_map: &std::collections::HashMap<String, String>,
) {
    let Some(run_id) = payload.get("run_id").and_then(Value::as_str) else {
        return;
    };
    let Some(snapshot_run_id) = run_id_map.get(run_id) else {
        return;
    };
    if let Value::Object(object) = payload {
        object.insert("run_id".into(), Value::String(snapshot_run_id.clone()));
    }
}
