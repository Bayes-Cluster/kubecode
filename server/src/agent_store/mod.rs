mod composer;
mod conversations;
mod events;
mod models;
mod permissions;
mod prompt_queue;
mod revisions;
mod runs;

pub use events::{RuntimeRunEvent, RuntimeUpdate, WorkspaceEvent, WorkspaceEventBus};
pub use models::{
    AgentEvent, AgentEventKind, AgentId, AgentRun, ComposerRunDispatch, Conversation,
    ConversationRelation, ConversationRelationship, ConversationRevision, ExecutionMode,
    PermissionMode, PromptQueueItem, PromptQueueStatus, RunCheckpoint, RunStatus, SessionEvent,
    StartPromptOutcome, StoreError, TerminalCause, TurnBoundary,
};

use std::path::Path;
use std::sync::Arc;

use rusqlite::TransactionBehavior;
use serde_json::json;

use crate::database::{Database, ensure_column};

pub struct AgentStore {
    database: Arc<Database>,
    workspace_event_bus: WorkspaceEventBus,
}

impl AgentStore {
    pub fn open(database_path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let database = Arc::new(Database::open(database_path)?);
        Self::from_database(database)
    }

    pub fn from_database(database: Arc<Database>) -> Result<Self, StoreError> {
        let connection = database.lock().expect("agent database mutex poisoned");
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversations (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               agent_id TEXT NOT NULL,
               provider_session_id TEXT,
               title TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS agent_runs (
               id TEXT PRIMARY KEY,
               conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
               project_id TEXT NOT NULL,
               message TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL,
               permission_mode TEXT NOT NULL,
               error TEXT,
               internal INTEGER NOT NULL DEFAULT 0,
               started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               completed_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_agent_runs_project_status
               ON agent_runs(project_id, status);
             CREATE TABLE IF NOT EXISTS run_checkpoints (
               run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
               before_tree TEXT,
               after_tree TEXT,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS agent_events (
               run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
               seq INTEGER NOT NULL,
               kind TEXT NOT NULL,
               payload TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY (run_id, seq)
             );
             CREATE TABLE IF NOT EXISTS session_events (
               conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
               seq INTEGER NOT NULL,
               kind TEXT NOT NULL,
               payload TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY (conversation_id, seq)
             );
             CREATE TABLE IF NOT EXISTS agent_permission_rules (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               agent_id TEXT NOT NULL,
               matcher TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               UNIQUE(project_id, agent_id, matcher)
             );
             CREATE TABLE IF NOT EXISTS conversation_prompt_queue (
               id TEXT PRIMARY KEY,
               conversation_id TEXT NOT NULL,
               project_id TEXT NOT NULL,
               content TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               position INTEGER NOT NULL,
               internal INTEGER NOT NULL DEFAULT 0,
               client_message_id TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS workspace_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               kind TEXT NOT NULL,
               project_id TEXT,
               conversation_id TEXT,
               run_id TEXT,
               payload TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS conversation_revisions (
               id TEXT PRIMARY KEY,
               conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
               snapshot_conversation_id TEXT NOT NULL UNIQUE,
               forked_at_run_id TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS composer_contexts (
               conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
               opaque_id TEXT NOT NULL,
               project_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               relative_path TEXT NOT NULL,
               available INTEGER NOT NULL DEFAULT 1,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY (conversation_id, opaque_id),
               UNIQUE (conversation_id, kind, relative_path)
             );
             CREATE TABLE IF NOT EXISTS composer_catalog_snapshots (
               conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
               revision INTEGER NOT NULL,
               payload TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY (conversation_id, revision)
             );",
        )?;
        ensure_column(
            &connection,
            "agent_runs",
            "message",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &connection,
            "agent_runs",
            "internal",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "conversations", "agent_session_id", "TEXT")?;
        ensure_column(
            &connection,
            "conversations",
            "execution_mode",
            "TEXT NOT NULL DEFAULT 'shared'",
        )?;
        ensure_column(&connection, "conversations", "workspace_path", "TEXT")?;
        ensure_column(
            &connection,
            "conversations",
            "recreated_context",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "conversations", "context_prefix", "TEXT")?;
        ensure_column(&connection, "conversations", "fork_boundary_run_id", "TEXT")?;
        ensure_column(&connection, "conversations", "fork_path", "TEXT")?;
        ensure_column(
            &connection,
            "conversations",
            "internal_revision",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "conversations",
            "composer_catalog_revision",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "composer_contexts", "source_revision", "TEXT")?;
        ensure_column(&connection, "composer_contexts", "metadata", "TEXT")?;
        composer::backfill_catalog_revision_high_water(&connection)?;
        composer::backfill_catalog_snapshots(&connection)?;
        connection.execute(
            "UPDATE conversations SET agent_session_id = id WHERE agent_session_id IS NULL",
            [],
        )?;
        ensure_column(&connection, "conversations", "manual_title", "TEXT")?;
        ensure_column(&connection, "conversations", "agent_title", "TEXT")?;
        ensure_column(
            &connection,
            "conversations",
            "archived",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "conversations",
            "parent_conversation_id",
            "TEXT",
        )?;
        ensure_column(&connection, "conversations", "relationship", "TEXT")?;
        ensure_column(
            &connection,
            "conversations",
            "read_only",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "agent_runs", "client_message_id", "TEXT")?;
        ensure_column(&connection, "agent_runs", "terminal_cause", "TEXT")?;
        connection.execute(
            "UPDATE conversations SET manual_title = title
             WHERE manual_title IS NULL AND agent_title IS NULL
               AND TRIM(title) <> '' AND title <> 'New conversation'",
            [],
        )?;
        let latest_committed_cursor = events::latest_workspace_event_id(&connection)?;
        drop(connection);
        let store = Self {
            database,
            workspace_event_bus: WorkspaceEventBus::new(latest_committed_cursor),
        };
        store.interrupt_inflight_runs()?;
        Ok(store)
    }

    pub fn workspace_event_bus(&self) -> &WorkspaceEventBus {
        &self.workspace_event_bus
    }

    fn interrupt_inflight_runs(&self) -> Result<(), StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let run_ids = {
            let mut statement = transaction.prepare(
                "SELECT id FROM agent_runs
                 WHERE status IN ('running', 'waiting_permission')",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        // Interrupted runs leave claimed queue items behind; the drain must
        // resume after restart, so claims reset below once the store lock is
        // released (#95).
        let mut latest_workspace_cursor = None;
        for run_id in run_ids {
            transaction.execute(
                "UPDATE agent_runs
                 SET status = 'interrupted', error = 'server restarted',
                     terminal_cause = 'interrupted',
                     completed_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                [&run_id],
            )?;
            let (_, workspace_cursor) = runs::append_event_transaction(
                &transaction,
                &run_id,
                AgentEventKind::RunCompleted,
                &json!({
                    "status":"interrupted",
                    "error":"server restarted",
                    "cause":"interrupted",
                }),
            )?;
            latest_workspace_cursor = Some(workspace_cursor);
        }
        transaction.commit()?;
        if let Some(cursor) = latest_workspace_cursor {
            self.workspace_event_bus.publish_committed(cursor);
        }
        drop(database);
        for conversation_id in self.reset_orphaned_queue_claims()? {
            let _ = self.publish_prompt_queue_snapshot(&conversation_id);
        }
        Ok(())
    }
}
