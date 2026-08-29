use std::str::FromStr;

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::json;
use uuid::Uuid;

use super::AgentStore;
use super::models::{AgentRun, PromptQueueItem, PromptQueueStatus, StartPromptOutcome, StoreError};
use super::runs::{
    append_event_transaction, existing_run_by_client_message_id, insert_run_transaction,
};

/// The durable per-conversation prompt inbox (#95). Admission runs the
/// active-run check and the enqueue inside one transaction, so a prompt
/// either starts or is queued — never both, never neither.
impl AgentStore {
    /// Admits a plain prompt: starts a run when the conversation is idle,
    /// otherwise queues it durably and returns the queue item.
    pub fn start_prompt_or_enqueue(
        &self,
        conversation_id: &str,
        project_id: &str,
        message: &str,
        permission_mode: crate::agents::PermissionMode,
        internal: bool,
        client_message_id: Option<&str>,
    ) -> Result<StartPromptOutcome, StoreError> {
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
        if let Some(client_message_id) = client_message_id {
            if let Some(run) =
                existing_run_by_client_message_id(&transaction, Some(client_message_id))?
            {
                return Ok(StartPromptOutcome::Started(run));
            }
            if let Some(item) = queue_item_by_client_message_id(&transaction, client_message_id)? {
                return Ok(StartPromptOutcome::Queued(item));
            }
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
            let item = insert_queue_item(
                &transaction,
                conversation_id,
                project_id,
                message,
                internal,
                client_message_id,
            )?;
            transaction.commit()?;
            return Ok(StartPromptOutcome::Queued(item));
        }
        let run = insert_run_transaction(
            &transaction,
            conversation_id,
            project_id,
            message,
            permission_mode,
            internal,
            client_message_id,
        )?;
        transaction.execute(
            "UPDATE conversations
             SET updated_at = STRFTIME('%Y-%m-%d %H:%M:%f', 'now')
             WHERE id = ?1",
            [conversation_id],
        )?;
        let (_, workspace_cursor) = append_event_transaction(
            &transaction,
            &run.id,
            crate::agents::AgentEventKind::RunStarted,
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
            &super::runs::user_message_payload(&run, message, internal),
        )?;
        Ok(StartPromptOutcome::Started(run))
    }

    /// Lists the pending queue for a conversation in drain order.
    pub fn list_queued_prompts(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<PromptQueueItem>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, conversation_id, project_id, content, status, position, internal,
                    client_message_id, created_at
             FROM conversation_prompt_queue
             WHERE conversation_id = ?1 AND status = 'pending'
             ORDER BY position, rowid",
        )?;
        let rows = statement.query_map([conversation_id], prompt_queue_item_from_row)?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    /// Claims the head of the queue for draining (pending → claimed).
    pub fn claim_next_queued_prompt(
        &self,
        conversation_id: &str,
    ) -> Result<Option<PromptQueueItem>, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let item = transaction
            .query_row(
                "SELECT id, conversation_id, project_id, content, status, position, internal,
                        client_message_id, created_at
                 FROM conversation_prompt_queue
                 WHERE conversation_id = ?1 AND status = 'pending'
                 ORDER BY position, rowid LIMIT 1",
                [conversation_id],
                prompt_queue_item_from_row,
            )
            .optional()?;
        let Some(item) = item else {
            return Ok(None);
        };
        transaction.execute(
            "UPDATE conversation_prompt_queue SET status = 'claimed' WHERE id = ?1",
            [&item.id],
        )?;
        transaction.commit()?;
        Ok(Some(item))
    }

    /// Rewrites a pending item's content (durable, validated).
    pub fn edit_queued_prompt(
        &self,
        item_id: &str,
        content: &str,
    ) -> Result<PromptQueueItem, StoreError> {
        if content.trim().is_empty() {
            return Err(StoreError::QueueItemNotActionable(
                "queued prompt content must not be empty".into(),
            ));
        }
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let item = require_pending_item(&transaction, item_id)?;
        transaction.execute(
            "UPDATE conversation_prompt_queue SET content = ?1 WHERE id = ?2",
            params![content, item_id],
        )?;
        transaction.commit()?;
        Ok(PromptQueueItem {
            content: content.to_owned(),
            ..item
        })
    }

    /// Removes a pending item; claimed items are already running and can no
    /// longer be removed.
    pub fn remove_queued_prompt(&self, item_id: &str) -> Result<(), StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let item = require_pending_item(&transaction, item_id)?;
        transaction.execute(
            "DELETE FROM conversation_prompt_queue WHERE id = ?1",
            [&item.id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Moves a pending item to the head of the queue (steer-now, #98).
    pub fn move_queued_prompt_to_head(&self, item_id: &str) -> Result<PromptQueueItem, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let item = require_pending_item(&transaction, item_id)?;
        let head: i64 = transaction.query_row(
            "SELECT COALESCE(MIN(position), 0) FROM conversation_prompt_queue
             WHERE conversation_id = ?1 AND status = 'pending'",
            [&item.conversation_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "UPDATE conversation_prompt_queue SET position = ?1 WHERE id = ?2",
            params![head - 1, item.id],
        )?;
        transaction.commit()?;
        Ok(PromptQueueItem {
            position: head - 1,
            ..item
        })
    }

    /// Starts a run from a claimed queue item: the run reuses the item's
    /// content and client message id, so optimistic bubbles reconcile at
    /// drain time exactly like an immediately-started run.
    pub fn start_run_from_queue_item(
        &self,
        item: &PromptQueueItem,
        permission_mode: crate::agents::PermissionMode,
    ) -> Result<AgentRun, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let conversation_project = transaction
            .query_row(
                "SELECT project_id FROM conversations WHERE id = ?1",
                [&item.conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::ConversationNotFound(item.conversation_id.to_owned()))?;
        if conversation_project != item.project_id {
            return Err(StoreError::ConversationNotFound(
                item.conversation_id.to_owned(),
            ));
        }
        let run = insert_run_transaction(
            &transaction,
            &item.conversation_id,
            &item.project_id,
            &item.content,
            permission_mode,
            item.internal,
            item.client_message_id.as_deref(),
        )?;
        transaction.execute(
            "UPDATE conversations
             SET updated_at = STRFTIME('%Y-%m-%d %H:%M:%f', 'now')
             WHERE id = ?1",
            [&item.conversation_id],
        )?;
        let (_, workspace_cursor) = append_event_transaction(
            &transaction,
            &run.id,
            crate::agents::AgentEventKind::RunStarted,
            &json!({"permission_mode": permission_mode}),
        )?;
        transaction.commit()?;
        self.workspace_event_bus.publish_committed(workspace_cursor);
        drop(database);
        if !item.internal {
            self.set_agent_title_if_untitled(&item.conversation_id, &item.content)?;
        }
        self.append_session_event(
            &item.conversation_id,
            "user_message",
            &super::runs::user_message_payload(&run, &item.content, item.internal),
        )?;
        Ok(run)
    }

    /// Publishes the whole pending queue as one snapshot event. Consumers
    /// replace their state wholesale — snapshot semantics, no diffs.
    pub fn publish_prompt_queue_snapshot(&self, conversation_id: &str) -> Result<(), StoreError> {
        let items = self.list_queued_prompts(conversation_id)?;
        let conversation = self.get_conversation(conversation_id)?;
        let payload = json!({ "items": items });
        self.append_workspace_event(
            "prompt_queue",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &payload,
        )?;
        Ok(())
    }

    /// Queued prompts for a conversation regardless of status (restart and
    /// audit views).
    pub fn prompt_queue_entries(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<PromptQueueItem>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, conversation_id, project_id, content, status, position, internal,
                    client_message_id, created_at
             FROM conversation_prompt_queue
             WHERE conversation_id = ?1
             ORDER BY position, rowid",
        )?;
        let rows = statement.query_map([conversation_id], prompt_queue_item_from_row)?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    /// Returns every conversation that still has a claimed queue item, after
    /// resetting claims back to pending. Used by boot recovery: a claimed
    /// item whose run died with the previous process must drain again.
    pub fn reset_orphaned_queue_claims(&self) -> Result<Vec<String>, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = transaction.prepare(
            "SELECT DISTINCT conversation_id FROM conversation_prompt_queue
             WHERE status = 'claimed'",
        )?;
        let conversations = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        if conversations.is_empty() {
            return Ok(Vec::new());
        }
        transaction.execute(
            "UPDATE conversation_prompt_queue SET status = 'pending' WHERE status = 'claimed'",
            [],
        )?;
        transaction.commit()?;
        Ok(conversations)
    }
}

fn insert_queue_item(
    transaction: &rusqlite::Transaction<'_>,
    conversation_id: &str,
    project_id: &str,
    content: &str,
    internal: bool,
    client_message_id: Option<&str>,
) -> Result<PromptQueueItem, StoreError> {
    let position: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM conversation_prompt_queue
         WHERE conversation_id = ?1",
        [conversation_id],
        |row| row.get(0),
    )?;
    let item = PromptQueueItem {
        id: Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_owned(),
        project_id: project_id.to_owned(),
        content: content.to_owned(),
        status: PromptQueueStatus::Pending,
        position,
        internal,
        client_message_id: client_message_id.map(str::to_owned),
        created_at: now_string(),
    };
    transaction.execute(
        "INSERT INTO conversation_prompt_queue
         (id, conversation_id, project_id, content, status, position, internal,
          client_message_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            item.id,
            item.conversation_id,
            item.project_id,
            item.content,
            item.status.as_str(),
            item.position,
            item.internal,
            item.client_message_id,
            item.created_at,
        ],
    )?;
    Ok(item)
}

fn require_pending_item(
    transaction: &rusqlite::Transaction<'_>,
    item_id: &str,
) -> Result<PromptQueueItem, StoreError> {
    let item = transaction
        .query_row(
            "SELECT id, conversation_id, project_id, content, status, position, internal,
                    client_message_id, created_at
             FROM conversation_prompt_queue WHERE id = ?1",
            [item_id],
            prompt_queue_item_from_row,
        )
        .optional()?
        .ok_or_else(|| StoreError::QueueItemNotFound(item_id.to_owned()))?;
    if item.status != PromptQueueStatus::Pending {
        return Err(StoreError::QueueItemNotActionable(
            "queue item has already been claimed".into(),
        ));
    }
    Ok(item)
}

fn queue_item_by_client_message_id(
    transaction: &rusqlite::Transaction<'_>,
    client_message_id: &str,
) -> Result<Option<PromptQueueItem>, StoreError> {
    transaction
        .query_row(
            "SELECT id, conversation_id, project_id, content, status, position, internal,
                    client_message_id, created_at
             FROM conversation_prompt_queue WHERE client_message_id = ?1 LIMIT 1",
            [client_message_id],
            prompt_queue_item_from_row,
        )
        .optional()
        .map_err(StoreError::from)
}

fn prompt_queue_item_from_row(row: &rusqlite::Row<'_>) -> Result<PromptQueueItem, rusqlite::Error> {
    let status = row.get::<_, String>(4)?;
    Ok(PromptQueueItem {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        project_id: row.get(2)?,
        content: row.get(3)?,
        status: PromptQueueStatus::from_str(&status)
            .map_err(super::models::to_sql_conversion_error)?,
        position: row.get(5)?,
        internal: row.get(6)?,
        client_message_id: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn now_string() -> String {
    // Matches the store's STRFTIME precision so rows sort consistently with
    // created_at columns elsewhere.
    chrono_like_now()
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // SQLite's '%Y-%m-%d %H:%M:%f' UTC format, reproduced without pulling a
    // date library: millisecond precision from the unix epoch.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = secs / 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}.{millis:03}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    // Howard Hinnant's civil-from-days algorithm.
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::agents::{AgentId, PermissionMode};
    use crate::workspace::WorkspaceService;

    fn store_with_conversation() -> (tempfile::TempDir, Arc<AgentStore>, String, String) {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace"));
        let project = workspace
            .create_project(".", "queue-project")
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        (temp, store, project.id, conversation.id)
    }

    #[test]
    fn admission_queues_under_active_run_and_starts_when_idle() {
        let (_temp, store, project_id, conversation_id) = store_with_conversation();
        let first = store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "first",
                PermissionMode::Safe,
                false,
                Some("client-1"),
            )
            .expect("first admission");
        let StartPromptOutcome::Started(run) = first else {
            panic!("idle conversation must start a run");
        };
        let queued = store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "second",
                PermissionMode::Safe,
                false,
                Some("client-2"),
            )
            .expect("queued admission");
        let StartPromptOutcome::Queued(item) = queued else {
            panic!("active conversation must queue");
        };
        assert_eq!(item.content, "second");
        assert_eq!(item.client_message_id.as_deref(), Some("client-2"));

        // Exactly-once: the same client id returns the queued item again.
        let repeat = store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "second",
                PermissionMode::Safe,
                false,
                Some("client-2"),
            )
            .expect("repeat admission");
        assert_eq!(repeat, StartPromptOutcome::Queued(item));

        // The started run's client id still dedupes to the run.
        let repeat_run = store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "first",
                PermissionMode::Safe,
                false,
                Some("client-1"),
            )
            .expect("repeat run admission");
        assert_eq!(repeat_run, StartPromptOutcome::Started(run));
    }

    #[test]
    fn claims_drain_fifo_and_mutations_respect_pending_only() {
        let (_temp, store, project_id, conversation_id) = store_with_conversation();
        store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "active",
                PermissionMode::Safe,
                false,
                None,
            )
            .expect("active run");
        for content in ["one", "two", "three"] {
            store
                .start_prompt_or_enqueue(
                    &conversation_id,
                    &project_id,
                    content,
                    PermissionMode::Safe,
                    false,
                    None,
                )
                .expect("enqueue");
        }
        let items = store.list_queued_prompts(&conversation_id).expect("queue");
        assert_eq!(
            items
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two", "three"]
        );

        let edited = store
            .edit_queued_prompt(&items[1].id, "two (edited)")
            .expect("edit");
        assert_eq!(edited.content, "two (edited)");
        store.remove_queued_prompt(&items[0].id).expect("remove");

        let first_claim = store
            .claim_next_queued_prompt(&conversation_id)
            .expect("claim")
            .expect("head item");
        assert_eq!(first_claim.content, "two (edited)");
        // Claimed items refuse mutations.
        assert!(store.edit_queued_prompt(&first_claim.id, "nope").is_err());
        assert!(store.remove_queued_prompt(&first_claim.id).is_err());

        let second_claim = store
            .claim_next_queued_prompt(&conversation_id)
            .expect("claim")
            .expect("second item");
        assert_eq!(second_claim.content, "three");
        assert!(
            store
                .claim_next_queued_prompt(&conversation_id)
                .expect("empty claim")
                .is_none()
        );
    }

    #[test]
    fn move_to_head_reorders_the_drain_sequence() {
        let (_temp, store, project_id, conversation_id) = store_with_conversation();
        store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "active",
                PermissionMode::Safe,
                false,
                None,
            )
            .expect("active run");
        for content in ["one", "two", "three"] {
            store
                .start_prompt_or_enqueue(
                    &conversation_id,
                    &project_id,
                    content,
                    PermissionMode::Safe,
                    false,
                    None,
                )
                .expect("enqueue");
        }
        let items = store.list_queued_prompts(&conversation_id).expect("queue");
        let moved = store
            .move_queued_prompt_to_head(&items[2].id)
            .expect("move to head");
        assert!(moved.position < items[0].position);
        let head = store
            .claim_next_queued_prompt(&conversation_id)
            .expect("claim")
            .expect("head");
        assert_eq!(head.content, "three");
    }

    #[test]
    fn draining_claims_publish_snapshot_events_for_the_conversation() {
        let (_temp, store, project_id, conversation_id) = store_with_conversation();
        store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "active",
                PermissionMode::Safe,
                false,
                None,
            )
            .expect("active run");
        store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "queued",
                PermissionMode::Safe,
                false,
                None,
            )
            .expect("enqueue");
        let before = store.workspace_events_after(0).expect("events");
        store
            .publish_prompt_queue_snapshot(&conversation_id)
            .expect("publish");
        let events = store.workspace_events_after(0).expect("events");
        let snapshot = events
            .iter()
            .rev()
            .find(|event| event.kind == "prompt_queue")
            .expect("snapshot event");
        assert_eq!(snapshot.conversation_id, Some(conversation_id.clone()));
        assert_eq!(snapshot.project_id, Some(project_id));
        let items = snapshot.payload["items"].as_array().expect("items").len();
        assert_eq!(items, 1);
        assert_eq!(before.len() + 1, events.len());
    }

    #[test]
    fn restart_resets_claims_so_interrupted_drains_resume() {
        let (temp, store, project_id, conversation_id) = store_with_conversation();
        store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "active",
                PermissionMode::Safe,
                false,
                None,
            )
            .expect("active run");
        store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "queued",
                PermissionMode::Safe,
                false,
                None,
            )
            .expect("enqueue");
        let claimed = store
            .claim_next_queued_prompt(&conversation_id)
            .expect("claim")
            .expect("claimed");
        drop(store);

        let reopened =
            AgentStore::open(temp.path().join("kubecode.sqlite3").as_path()).expect("reopened");
        // Opening the store already resets the orphaned claim during
        // interrupted-run recovery.
        let entries = reopened
            .prompt_queue_entries(&conversation_id)
            .expect("entries");
        let claimed_entry = entries
            .iter()
            .find(|entry| entry.id == claimed.id)
            .expect("claimed entry");
        assert_eq!(claimed_entry.status, PromptQueueStatus::Pending);

        // The reset stays available for direct use and reports what it freed.
        reopened
            .claim_next_queued_prompt(&conversation_id)
            .expect("claim")
            .expect("claimable after reset");
        let conversations = reopened.reset_orphaned_queue_claims().expect("reset");
        assert_eq!(conversations, vec![conversation_id]);
    }

    #[test]
    fn snapshot_items_serialize_with_pending_status_and_position() {
        let (_temp, store, project_id, conversation_id) = store_with_conversation();
        store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "active",
                PermissionMode::Safe,
                false,
                None,
            )
            .expect("active run");
        store
            .start_prompt_or_enqueue(
                &conversation_id,
                &project_id,
                "queued",
                PermissionMode::Safe,
                false,
                Some("client-q"),
            )
            .expect("enqueue");
        let items = store.list_queued_prompts(&conversation_id).expect("queue");
        let value = serde_json::to_value(&items).expect("serialize");
        let first = &value.as_array().expect("array")[0];
        assert_eq!(first["status"], "pending");
        assert_eq!(first["content"], "queued");
        assert_eq!(first["client_message_id"], "client-q");
        assert!(first["position"].is_i64());
    }
}
