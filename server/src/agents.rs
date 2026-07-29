use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::watch;
use uuid::Uuid;

use crate::composer_catalog::{
    ComposerCatalogError, ComposerCatalogSnapshot, ComposerContextKind, ComposerContextRecord,
    ComposerContextRegistration, ComposerContextSelector, ComposerContextValidationResponse,
    ComposerContextValidationResult, ComposerDraftSegment, ComposerPreflightContext,
    MAX_COMPOSER_CONTEXTS, MAX_COMPOSER_TEXT_BYTES, context_kind_key, opaque_context_id,
    parse_context_kind, project_acp_catalog_with_contexts, project_available_commands,
    resolve_acp_catalog_item, validate_structured_composer_segments,
};
use crate::database::{Database, DatabaseError};

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("an agent run is already active for project {0}")]
    ActiveRun(String),
    #[error("conversation not found: {0}")]
    ConversationNotFound(String),
    #[error("run not found: {0}")]
    RunNotFound(String),
    #[error("invalid stored value: {0}")]
    InvalidStoredValue(String),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    DatabaseSetup(#[from] DatabaseError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Composer(#[from] ComposerCatalogError),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentId {
    ClaudeCode,
    Codex,
    #[serde(rename = "opencode")]
    OpenCode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    Safe,
    Power,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    WaitingPermission,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationRelationship {
    Fork,
    Subagent,
    Branch,
    TeamMember,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Shared,
    Worktree,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationRelation {
    pub parent_conversation_id: String,
    pub relationship: ConversationRelationship,
    pub read_only: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventKind {
    RunStarted,
    TextDelta,
    ThinkingDelta,
    ToolStarted,
    ToolUpdated,
    ToolCompleted,
    PermissionRequested,
    PermissionResolved,
    Usage,
    Plan,
    AvailableCommands,
    CurrentMode,
    ConfigOptions,
    SessionInfo,
    ElicitationRequested,
    ElicitationResolved,
    Error,
    RunCompleted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Conversation {
    pub id: String,
    pub agent_session_id: String,
    pub project_id: String,
    pub agent_id: AgentId,
    pub provider_session_id: Option<String>,
    pub title: String,
    pub manual_title: Option<String>,
    pub agent_title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
    pub parent_conversation_id: Option<String>,
    pub relationship: Option<ConversationRelationship>,
    pub read_only: bool,
    pub latest_run_status: Option<RunStatus>,
    pub execution_mode: ExecutionMode,
    pub workspace_path: Option<String>,
    pub recreated_context: bool,
    #[serde(skip)]
    pub context_prefix: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentRun {
    pub id: String,
    pub conversation_id: String,
    pub project_id: String,
    pub message: String,
    pub status: RunStatus,
    pub permission_mode: PermissionMode,
    pub error: Option<String>,
    pub internal: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RunCheckpoint {
    pub run_id: String,
    pub before_tree: Option<String>,
    pub after_tree: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConversationRevision {
    pub id: String,
    pub conversation_id: String,
    pub snapshot_conversation_id: String,
    pub forked_at_run_id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AgentEvent {
    pub run_id: String,
    pub seq: u64,
    pub kind: AgentEventKind,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SessionEvent {
    pub conversation_id: String,
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkspaceEvent {
    pub id: u64,
    pub kind: String,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub run_id: Option<String>,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeRunEvent {
    pub run_id: String,
    pub kind: AgentEventKind,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeUpdate {
    pub session_kind: String,
    pub session_payload: Value,
    pub run_event: Option<RuntimeRunEvent>,
    pub publish_session_state: bool,
}

#[derive(Debug)]
pub struct WorkspaceEventBus {
    latest_committed_cursor: watch::Sender<u64>,
}

impl WorkspaceEventBus {
    fn new(latest_committed_cursor: u64) -> Self {
        let (sender, _) = watch::channel(latest_committed_cursor);
        Self {
            latest_committed_cursor: sender,
        }
    }

    pub fn latest_committed_cursor(&self) -> u64 {
        *self.latest_committed_cursor.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.latest_committed_cursor.subscribe()
    }

    fn publish_committed(&self, cursor: u64) {
        self.latest_committed_cursor.send_if_modified(|current| {
            if cursor > *current {
                *current = cursor;
                true
            } else {
                false
            }
        });
    }
}

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
        backfill_catalog_revision_high_water(&connection)?;
        backfill_catalog_snapshots(&connection)?;
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
        connection.execute(
            "UPDATE conversations SET manual_title = title
             WHERE manual_title IS NULL AND agent_title IS NULL
               AND TRIM(title) <> '' AND title <> 'New conversation'",
            [],
        )?;
        let latest_committed_cursor = latest_workspace_event_id(&connection)?;
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

    pub fn create_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        title: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            agent_session_id: String::new(),
            project_id: project_id.to_owned(),
            agent_id,
            provider_session_id: None,
            title: normalized_title(title).unwrap_or_default(),
            manual_title: normalized_title(title),
            agent_title: None,
            created_at: String::new(),
            updated_at: String::new(),
            archived: false,
            parent_conversation_id: None,
            relationship: None,
            read_only: false,
            latest_run_status: None,
            execution_mode: ExecutionMode::Shared,
            workspace_path: None,
            recreated_context: false,
            context_prefix: None,
        };
        let conversation = Conversation {
            agent_session_id: conversation.id.clone(),
            ..conversation
        };
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO conversations
                 (id, agent_session_id, project_id, agent_id, title, manual_title)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conversation.id,
                    conversation.agent_session_id,
                    conversation.project_id,
                    conversation.agent_id.as_str(),
                    conversation.title,
                    conversation.manual_title,
                ],
            )?;
        self.append_workspace_event(
            "session_created",
            Some(project_id),
            Some(&conversation.id),
            None,
            &json!({"agent_id": agent_id, "title": conversation.title}),
        )?;
        self.get_conversation(&conversation.id)
    }

    pub fn create_imported_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        provider_session_id: &str,
        agent_title: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        self.create_related_imported_conversation(
            project_id,
            agent_id,
            provider_session_id,
            agent_title,
            None,
        )
    }

    pub fn create_related_imported_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        provider_session_id: &str,
        agent_title: Option<&str>,
        relation: Option<ConversationRelation>,
    ) -> Result<Conversation, StoreError> {
        let provider_session_id = provider_session_id.trim();
        if provider_session_id.is_empty() {
            return Err(StoreError::InvalidStoredValue(
                "empty provider session id".into(),
            ));
        }
        if let Some(existing) =
            self.find_provider_conversation(project_id, agent_id, provider_session_id)?
        {
            return Ok(existing);
        }
        let agent_title = normalized_title(agent_title);
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            agent_session_id: String::new(),
            project_id: project_id.to_owned(),
            agent_id,
            provider_session_id: Some(provider_session_id.to_owned()),
            title: agent_title.clone().unwrap_or_default(),
            manual_title: None,
            agent_title,
            created_at: String::new(),
            updated_at: String::new(),
            archived: false,
            parent_conversation_id: relation
                .as_ref()
                .map(|value| value.parent_conversation_id.clone()),
            relationship: relation.as_ref().map(|value| value.relationship),
            read_only: relation.is_some_and(|value| value.read_only),
            latest_run_status: None,
            execution_mode: ExecutionMode::Shared,
            workspace_path: None,
            recreated_context: false,
            context_prefix: None,
        };
        let conversation = Conversation {
            agent_session_id: conversation.id.clone(),
            ..conversation
        };
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO conversations
                 (id, agent_session_id, project_id, agent_id, provider_session_id, title, agent_title,
                  parent_conversation_id, relationship, read_only)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    conversation.id,
                    conversation.agent_session_id,
                    conversation.project_id,
                    conversation.agent_id.as_str(),
                    conversation.provider_session_id,
                    conversation.title,
                    conversation.agent_title,
                    conversation.parent_conversation_id,
                    conversation.relationship.map(|value| value.as_str()),
                    conversation.read_only,
                ],
            )?;
        self.append_workspace_event(
            "session_imported",
            Some(project_id),
            Some(&conversation.id),
            None,
            &json!({"agent_id": agent_id, "provider_session_id": provider_session_id}),
        )?;
        self.get_conversation(&conversation.id)
    }

    pub fn get_conversation(&self, conversation_id: &str) -> Result<Conversation, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                &conversation_query("WHERE c.id = ?1"),
                [conversation_id],
                conversation_from_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))
    }

    pub fn list_conversations(&self, project_id: &str) -> Result<Vec<Conversation>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(&conversation_query(
            "WHERE c.project_id = ?1 AND c.internal_revision = 0
             ORDER BY c.created_at, c.id",
        ))?;
        let rows = statement.query_map([project_id], conversation_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_all_conversations(&self) -> Result<Vec<Conversation>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(&conversation_query(
            "WHERE c.internal_revision = 0 ORDER BY c.updated_at DESC, c.id",
        ))?;
        let rows = statement.query_map([], conversation_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn set_archived(
        &self,
        conversation_id: &str,
        archived: bool,
    ) -> Result<Conversation, StoreError> {
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "UPDATE conversations SET archived = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![conversation_id, archived],
            )?;
        if changed == 0 {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let conversation = self.get_conversation(conversation_id)?;
        self.append_workspace_event(
            "session_updated",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({"archived": archived}),
        )?;
        Ok(conversation)
    }

    pub fn assign_execution_workspace(
        &self,
        conversation_id: &str,
        execution_mode: ExecutionMode,
        workspace_path: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        if execution_mode == ExecutionMode::Worktree && workspace_path.is_none() {
            return Err(StoreError::InvalidStoredValue(
                "worktree execution requires a workspace path".into(),
            ));
        }
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "UPDATE conversations
                 SET execution_mode = ?2, workspace_path = ?3, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![conversation_id, execution_mode.as_str(), workspace_path],
            )?;
        if changed == 0 {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let conversation = self.get_conversation(conversation_id)?;
        self.append_workspace_event(
            "session_updated",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({
                "execution_mode": execution_mode,
                "workspace_path": workspace_path,
            }),
        )?;
        Ok(conversation)
    }

    pub fn branch_conversation_at_run(
        &self,
        source_conversation_id: &str,
        run_id: &str,
    ) -> Result<Conversation, StoreError> {
        let source = self.get_conversation(source_conversation_id)?;
        let run = self.get_run(run_id)?;
        if run.conversation_id != source.id {
            return Err(StoreError::RunNotFound(run_id.to_owned()));
        }
        let source_events = self.session_events_after(source_conversation_id, 0)?;
        let retained_events = source_events
            .into_iter()
            .take_while(|event| event.payload.get("run_id").and_then(Value::as_str) != Some(run_id))
            .collect::<Vec<_>>();
        let context_prefix = transcript_context(&retained_events);
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            agent_session_id: source.agent_session_id,
            project_id: source.project_id.clone(),
            agent_id: source.agent_id,
            provider_session_id: None,
            title: source.title.clone(),
            manual_title: None,
            agent_title: normalized_title(Some(&source.title)),
            created_at: String::new(),
            updated_at: String::new(),
            archived: false,
            parent_conversation_id: Some(source.id.clone()),
            relationship: Some(ConversationRelationship::Branch),
            read_only: false,
            latest_run_status: None,
            execution_mode: source.execution_mode,
            workspace_path: source.workspace_path,
            recreated_context: true,
            context_prefix: (!context_prefix.is_empty()).then_some(context_prefix),
        };
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO conversations
             (id, agent_session_id, project_id, agent_id, title, agent_title,
              parent_conversation_id, relationship, read_only, execution_mode,
              workspace_path, recreated_context, context_prefix)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                conversation.id,
                conversation.agent_session_id,
                conversation.project_id,
                conversation.agent_id.as_str(),
                conversation.title,
                conversation.agent_title,
                conversation.parent_conversation_id,
                conversation.relationship.map(|value| value.as_str()),
                conversation.read_only,
                conversation.execution_mode.as_str(),
                conversation.workspace_path,
                conversation.recreated_context,
                conversation.context_prefix,
            ],
        )?;
        for (index, event) in retained_events
            .iter()
            .filter(|event| event.kind != "composer_catalog")
            .enumerate()
        {
            transaction.execute(
                "INSERT INTO session_events
                 (conversation_id, seq, kind, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    conversation.id,
                    i64::try_from(index + 1)
                        .map_err(|error| { StoreError::InvalidStoredValue(error.to_string()) })?,
                    event.kind,
                    serde_json::to_string(&event.payload)?,
                    event.created_at,
                ],
            )?;
        }
        transaction.commit()?;
        drop(database);
        self.append_workspace_event(
            "session_created",
            Some(&source.project_id),
            Some(&conversation.id),
            None,
            &json!({
                "agent_id": source.agent_id,
                "parent_conversation_id": source.id,
                "relationship": "branch",
                "recreated_context": true,
            }),
        )?;
        self.get_conversation(&conversation.id)
    }

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
        let source_events = self.session_events_after(conversation_id, 0)?;
        let retained_events = source_events
            .iter()
            .take_while(|event| event.payload.get("run_id").and_then(Value::as_str) != Some(run_id))
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

    pub fn create_team_member(
        &self,
        parent_conversation_id: &str,
        agent_id: AgentId,
        isolated: bool,
    ) -> Result<Conversation, StoreError> {
        let parent = self.get_conversation(parent_conversation_id)?;
        let id = Uuid::new_v4().to_string();
        let conversation = Conversation {
            agent_session_id: if isolated {
                id.clone()
            } else {
                parent.agent_session_id
            },
            id,
            project_id: parent.project_id.clone(),
            agent_id,
            provider_session_id: None,
            title: String::new(),
            manual_title: None,
            agent_title: None,
            created_at: String::new(),
            updated_at: String::new(),
            archived: false,
            parent_conversation_id: Some(parent.id.clone()),
            relationship: Some(ConversationRelationship::TeamMember),
            read_only: false,
            latest_run_status: None,
            execution_mode: if isolated {
                ExecutionMode::Shared
            } else {
                parent.execution_mode
            },
            workspace_path: if isolated {
                None
            } else {
                parent.workspace_path
            },
            recreated_context: false,
            context_prefix: None,
        };
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO conversations
                 (id, agent_session_id, project_id, agent_id, title,
                  parent_conversation_id, relationship, read_only, execution_mode,
                  workspace_path, recreated_context)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    conversation.id,
                    conversation.agent_session_id,
                    conversation.project_id,
                    conversation.agent_id.as_str(),
                    conversation.title,
                    conversation.parent_conversation_id,
                    conversation.relationship.map(|value| value.as_str()),
                    conversation.read_only,
                    conversation.execution_mode.as_str(),
                    conversation.workspace_path,
                    conversation.recreated_context,
                ],
            )?;
        self.append_workspace_event(
            "session_created",
            Some(&parent.project_id),
            Some(&conversation.id),
            None,
            &json!({
                "agent_id": agent_id,
                "parent_conversation_id": parent.id,
                "relationship": "team_member",
                "isolated": isolated,
            }),
        )?;
        self.get_conversation(&conversation.id)
    }

    pub fn set_manual_title(
        &self,
        conversation_id: &str,
        title: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        self.set_conversation_title(conversation_id, "manual_title", normalized_title(title))
    }

    pub fn set_agent_title(
        &self,
        conversation_id: &str,
        title: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        self.set_conversation_title(conversation_id, "agent_title", normalized_title(title))
    }

    pub fn set_agent_title_if_untitled(
        &self,
        conversation_id: &str,
        source: &str,
    ) -> Result<Option<Conversation>, StoreError> {
        let Some(title) = fallback_conversation_title(source) else {
            return Ok(None);
        };
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "UPDATE conversations SET agent_title = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND manual_title IS NULL AND agent_title IS NULL",
                params![conversation_id, title],
            )?;
        if changed == 0 {
            self.get_conversation(conversation_id)?;
            return Ok(None);
        }
        let conversation = self.get_conversation(conversation_id)?;
        self.append_workspace_event(
            "session_updated",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({"title":conversation.title}),
        )?;
        Ok(Some(conversation))
    }

    pub fn delete_conversation(&self, conversation_id: &str) -> Result<(), StoreError> {
        self.delete_conversation_with_scope(conversation_id, "local")
    }

    pub fn delete_provider_conversation(&self, conversation_id: &str) -> Result<(), StoreError> {
        self.delete_conversation_with_scope(conversation_id, "provider")
    }

    fn delete_conversation_with_scope(
        &self,
        conversation_id: &str,
        scope: &str,
    ) -> Result<(), StoreError> {
        let conversation = self.get_conversation(conversation_id)?;
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let snapshot_ids = {
            let mut statement = transaction.prepare(
                "SELECT snapshot_conversation_id FROM conversation_revisions
                 WHERE conversation_id = ?1",
            )?;
            statement
                .query_map([conversation_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for snapshot_id in snapshot_ids {
            transaction.execute("DELETE FROM conversations WHERE id = ?1", [snapshot_id])?;
        }
        transaction.execute("DELETE FROM conversations WHERE id = ?1", [conversation_id])?;
        transaction.commit()?;
        drop(database);
        self.append_workspace_event(
            "session_removed",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({"scope":scope}),
        )?;
        Ok(())
    }

    fn find_provider_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        provider_session_id: &str,
    ) -> Result<Option<Conversation>, StoreError> {
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .query_row(
                &conversation_query(
                    "WHERE c.project_id = ?1 AND c.agent_id = ?2 AND c.provider_session_id = ?3
                     AND c.internal_revision = 0",
                ),
                params![project_id, agent_id.as_str(), provider_session_id],
                conversation_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    fn set_conversation_title(
        &self,
        conversation_id: &str,
        column: &str,
        title: Option<String>,
    ) -> Result<Conversation, StoreError> {
        let query = match column {
            "manual_title" => {
                "UPDATE conversations SET manual_title = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1"
            }
            "agent_title" => {
                "UPDATE conversations SET agent_title = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1"
            }
            _ => return Err(StoreError::InvalidStoredValue(column.to_owned())),
        };
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(query, params![conversation_id, title])?;
        if changed == 0 {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let conversation = self.get_conversation(conversation_id)?;
        self.append_workspace_event(
            "session_updated",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({"title":conversation.title}),
        )?;
        Ok(conversation)
    }

    pub fn set_provider_session(
        &self,
        conversation_id: &str,
        provider_session_id: &str,
    ) -> Result<(), StoreError> {
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "UPDATE conversations SET provider_session_id = ?2,
                 updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![conversation_id, provider_session_id],
            )?;
        if changed == 0 {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        Ok(())
    }

    pub fn start_run(
        &self,
        conversation_id: &str,
        project_id: &str,
        message: &str,
        permission_mode: PermissionMode,
    ) -> Result<AgentRun, StoreError> {
        self.start_run_with_visibility(conversation_id, project_id, message, permission_mode, false)
    }

    pub fn start_internal_run(
        &self,
        conversation_id: &str,
        project_id: &str,
        message: &str,
        permission_mode: PermissionMode,
    ) -> Result<AgentRun, StoreError> {
        self.start_run_with_visibility(conversation_id, project_id, message, permission_mode, true)
    }

    pub fn start_typed_composer_command(
        &self,
        conversation_id: &str,
        project_id: &str,
        item_id: &str,
        catalog_revision: u64,
        arguments: &str,
        permission_mode: PermissionMode,
    ) -> Result<AgentRun, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (conversation_project, agent_id) = conversation_scope(&transaction, conversation_id)?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let snapshot = latest_catalog_transaction(&transaction, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
        let raw = latest_session_payload_transaction(
            &transaction,
            conversation_id,
            "available_commands",
        )?
        .ok_or(ComposerCatalogError::ItemMissing)?;
        let expected = authoritative_catalog_transaction(
            &transaction,
            project_id,
            conversation_id,
            agent_id,
            snapshot.revision,
        )?;
        if !snapshot.same_contents(&expected) {
            return Err(StoreError::InvalidStoredValue(
                "composer catalog does not match its authoritative ACP snapshot".into(),
            ));
        }
        let message =
            resolve_acp_catalog_item(&snapshot, &raw, catalog_revision, item_id, arguments)?;
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
        let run = insert_run_transaction(
            &transaction,
            conversation_id,
            project_id,
            &message,
            permission_mode,
            true,
        )?;
        let workspace_cursor = latest_workspace_event_id(&transaction)?;
        transaction.commit()?;
        self.workspace_event_bus.publish_committed(workspace_cursor);
        drop(database);
        self.append_session_event(
            conversation_id,
            "user_message",
            &json!({"run_id":run.id, "text":message, "internal":true}),
        )?;
        Ok(run)
    }

    fn start_run_with_visibility(
        &self,
        conversation_id: &str,
        project_id: &str,
        message: &str,
        permission_mode: PermissionMode,
        internal: bool,
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
        };
        transaction.execute(
            "INSERT INTO agent_runs
             (id, conversation_id, project_id, message, status, permission_mode, internal)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                run.id,
                run.conversation_id,
                run.project_id,
                run.message,
                run.status.as_str(),
                run.permission_mode.as_str(),
                run.internal,
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
            &json!({"run_id":run.id, "text":message, "internal":internal}),
        )?;
        Ok(run)
    }

    pub fn get_run(&self, run_id: &str) -> Result<AgentRun, StoreError> {
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .query_row(
                "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal
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
            "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal
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
            "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal
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
            "SELECT id, conversation_id, project_id, message, status, permission_mode, error, internal
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
             WHERE id = ?1",
            params![run_id, status.as_str(), error],
        )?;
        if changed == 0 {
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

    pub fn composer_catalog_snapshot(
        &self,
        conversation_id: &str,
    ) -> Result<ComposerCatalogSnapshot, StoreError> {
        self.get_conversation(conversation_id)?;
        let database = self.database.lock().expect("agent database mutex poisoned");
        Ok(latest_catalog_connection(&database, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id)))
    }

    pub fn register_composer_context(
        &self,
        conversation_id: &str,
        project_id: &str,
        kind: ComposerContextKind,
        normalized_relative_path: &str,
    ) -> Result<ComposerContextRegistration, StoreError> {
        if !matches!(
            kind,
            ComposerContextKind::File | ComposerContextKind::Directory
        ) || normalized_relative_path.is_empty()
        {
            return Err(ComposerCatalogError::InvalidDraft.into());
        }
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (conversation_project, agent_id) = conversation_scope(&transaction, conversation_id)?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let id = opaque_context_id(project_id, conversation_id, kind, normalized_relative_path);
        let existing = context_record_transaction(&transaction, conversation_id, &id)?;
        if let Some(existing) = &existing {
            if existing.project_id != project_id
                || existing.conversation_id != conversation_id
                || existing.kind != kind
                || existing.path != normalized_relative_path
            {
                return Err(StoreError::InvalidStoredValue(
                    "composer context identity tuple mismatch".into(),
                ));
            }
            transaction.execute(
                "UPDATE composer_contexts
                 SET available = 1, updated_at = CURRENT_TIMESTAMP
                 WHERE conversation_id = ?1 AND opaque_id = ?2",
                params![conversation_id, id],
            )?;
        } else {
            let count = transaction.query_row(
                "SELECT COUNT(*) FROM composer_contexts WHERE conversation_id = ?1",
                [conversation_id],
                |row| row.get::<_, i64>(0),
            )?;
            if usize::try_from(count).unwrap_or(usize::MAX) >= MAX_COMPOSER_CONTEXTS {
                return Err(ComposerCatalogError::ContextOverLimit.into());
            }
            transaction.execute(
                "INSERT INTO composer_contexts
                 (conversation_id, opaque_id, project_id, kind, relative_path, available)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                params![
                    conversation_id,
                    id,
                    project_id,
                    context_kind_key(kind),
                    normalized_relative_path,
                ],
            )?;
        }
        let previous = latest_catalog_transaction(&transaction, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
        let mut catalog = authoritative_catalog_transaction(
            &transaction,
            project_id,
            conversation_id,
            agent_id,
            previous.revision,
        )?;
        let mut workspace_cursor = None;
        if !previous.same_contents(&catalog) {
            let revision = next_catalog_revision_transaction(&transaction, conversation_id)?;
            catalog = authoritative_catalog_transaction(
                &transaction,
                project_id,
                conversation_id,
                agent_id,
                revision,
            )?;
            workspace_cursor = Some(issue_catalog_snapshot_transaction(
                &transaction,
                project_id,
                conversation_id,
                &catalog,
            )?);
        }
        let context = catalog
            .contexts
            .iter()
            .find(|context| context.id == id)
            .cloned()
            .ok_or_else(|| StoreError::InvalidStoredValue("registered context missing".into()))?;
        transaction.commit()?;
        if let Some(cursor) = workspace_cursor {
            self.workspace_event_bus.publish_committed(cursor);
        }
        Ok(ComposerContextRegistration { context, catalog })
    }

    pub fn composer_context_records_for_preflight(
        &self,
        conversation_id: &str,
        project_id: &str,
        selectors: &[ComposerContextSelector],
    ) -> Result<Vec<Option<ComposerContextRecord>>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let conversation_project = database
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
        selectors
            .iter()
            .map(|selector| context_record_connection(&database, conversation_id, &selector.id))
            .collect()
    }

    pub fn validate_composer_contexts(
        &self,
        conversation_id: &str,
        project_id: &str,
        selectors: &[ComposerContextSelector],
        preflight: &[Option<ComposerPreflightContext>],
    ) -> Result<ComposerContextValidationResponse, StoreError> {
        if selectors.len() > crate::composer_catalog::MAX_COMPOSER_VALIDATION_ROWS
            || selectors.len() != preflight.len()
        {
            return Err(ComposerCatalogError::ContextOverLimit.into());
        }
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (conversation_project, agent_id) = conversation_scope(&transaction, conversation_id)?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let mut results = Vec::with_capacity(selectors.len());
        for (selector, preflight) in selectors.iter().zip(preflight) {
            let record = context_record_transaction(&transaction, conversation_id, &selector.id)?;
            let historical = catalog_snapshot_at_transaction(
                &transaction,
                conversation_id,
                selector.catalog_revision,
            )?;
            let historically_valid = historical.as_ref().is_some_and(|snapshot| {
                snapshot.contexts.iter().any(|context| {
                    context.id == selector.id
                        && context.kind == selector.context_kind
                        && context.enabled
                })
            });
            let available = match (&record, preflight) {
                (Some(record), Some(preflight)) => {
                    record.project_id == project_id
                        && record.conversation_id == conversation_id
                        && record.kind == selector.context_kind
                        && preflight.id == record.id
                        && preflight.kind == record.kind
                        && preflight.path == record.path
                        && historically_valid
                }
                _ => false,
            };
            if let Some(record) = &record {
                transaction.execute(
                    "UPDATE composer_contexts
                     SET available = ?3, updated_at = CURRENT_TIMESTAMP
                     WHERE conversation_id = ?1 AND opaque_id = ?2",
                    params![conversation_id, record.id, available],
                )?;
            }
            results.push(ComposerContextValidationResult {
                id: selector.id.clone(),
                catalog_revision: selector.catalog_revision,
                context_kind: selector.context_kind,
                available,
            });
        }
        let previous = latest_catalog_transaction(&transaction, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
        let mut catalog = authoritative_catalog_transaction(
            &transaction,
            project_id,
            conversation_id,
            agent_id,
            previous.revision,
        )?;
        let mut workspace_cursor = None;
        if !previous.same_contents(&catalog) {
            let revision = next_catalog_revision_transaction(&transaction, conversation_id)?;
            catalog = authoritative_catalog_transaction(
                &transaction,
                project_id,
                conversation_id,
                agent_id,
                revision,
            )?;
            workspace_cursor = Some(issue_catalog_snapshot_transaction(
                &transaction,
                project_id,
                conversation_id,
                &catalog,
            )?);
        }
        transaction.commit()?;
        if let Some(cursor) = workspace_cursor {
            self.workspace_event_bus.publish_committed(cursor);
        }
        Ok(ComposerContextValidationResponse {
            references: results,
            catalog,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_structured_composer_run(
        &self,
        conversation_id: &str,
        project_id: &str,
        item_id: Option<&str>,
        catalog_revision: u64,
        segments: &[ComposerDraftSegment],
        preflight: &[ComposerPreflightContext],
        permission_mode: PermissionMode,
    ) -> Result<AgentRun, StoreError> {
        validate_structured_composer_segments(segments)?;
        let preflight = preflight
            .iter()
            .map(|context| (context.id.as_str(), context))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (conversation_project, agent_id) = conversation_scope(&transaction, conversation_id)?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let current = latest_catalog_transaction(&transaction, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
        if current.revision != catalog_revision {
            return Err(ComposerCatalogError::StaleRevision.into());
        }
        let expected = authoritative_catalog_transaction(
            &transaction,
            project_id,
            conversation_id,
            agent_id,
            current.revision,
        )?;
        if !current.same_contents(&expected) {
            return Err(StoreError::InvalidStoredValue(
                "composer catalog does not match its authoritative sources".into(),
            ));
        }
        let mut resolved = String::new();
        for segment in segments {
            match segment {
                ComposerDraftSegment::Text { text } => resolved.push_str(text),
                ComposerDraftSegment::ContextRef {
                    id,
                    catalog_revision,
                    context_kind,
                } => {
                    let historical = catalog_snapshot_at_transaction(
                        &transaction,
                        conversation_id,
                        *catalog_revision,
                    )?
                    .ok_or(ComposerCatalogError::ContextStale)?;
                    if !historical.contexts.iter().any(|context| {
                        context.id == *id && context.kind == *context_kind && context.enabled
                    }) || !current.contexts.iter().any(|context| {
                        context.id == *id && context.kind == *context_kind && context.enabled
                    }) {
                        return Err(ComposerCatalogError::ContextStale.into());
                    }
                    let record = context_record_transaction(&transaction, conversation_id, id)?
                        .ok_or(ComposerCatalogError::ContextStale)?;
                    let preflight = preflight
                        .get(id.as_str())
                        .ok_or(ComposerCatalogError::ContextStale)?;
                    if !record.available
                        || record.project_id != project_id
                        || record.kind != *context_kind
                        || preflight.kind != record.kind
                        || preflight.path != record.path
                    {
                        return Err(ComposerCatalogError::ContextStale.into());
                    }
                    resolved.push('@');
                    resolved.push_str(&record.path);
                }
                ComposerDraftSegment::CapabilityRef {
                    id,
                    catalog_revision,
                    item_kind,
                } => {
                    let historical = catalog_snapshot_at_transaction(
                        &transaction,
                        conversation_id,
                        *catalog_revision,
                    )?
                    .ok_or(ComposerCatalogError::ItemMissing)?;
                    if !historical
                        .items
                        .iter()
                        .any(|item| item.id == *id && item.kind == *item_kind && item.enabled)
                        || !current
                            .items
                            .iter()
                            .any(|item| item.id == *id && item.kind == *item_kind && item.enabled)
                    {
                        return Err(ComposerCatalogError::ItemMissing.into());
                    }
                    return Err(ComposerCatalogError::ItemUnsupported.into());
                }
            }
        }
        if resolved.len() > MAX_COMPOSER_TEXT_BYTES {
            return Err(ComposerCatalogError::TextTooLong.into());
        }
        let (message, internal) = if let Some(item_id) = item_id {
            let raw = latest_session_payload_transaction(
                &transaction,
                conversation_id,
                "available_commands",
            )?
            .ok_or(ComposerCatalogError::ItemMissing)?;
            (
                resolve_acp_catalog_item(&current, &raw, catalog_revision, item_id, &resolved)?,
                true,
            )
        } else {
            if resolved.trim().is_empty() {
                return Err(ComposerCatalogError::InvalidDraft.into());
            }
            (resolved, false)
        };
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
        let run = insert_run_transaction(
            &transaction,
            conversation_id,
            project_id,
            &message,
            permission_mode,
            internal,
        )?;
        append_session_event_transaction(
            &transaction,
            conversation_id,
            "user_message",
            &json!({"run_id":run.id, "text":message, "internal":internal}),
        )?;
        let workspace_cursor = latest_workspace_event_id(&transaction)?;
        transaction.commit()?;
        self.workspace_event_bus.publish_committed(workspace_cursor);
        drop(database);
        if !internal {
            self.set_agent_title_if_untitled(conversation_id, &message)?;
        }
        Ok(run)
    }

    pub fn append_session_event(
        &self,
        conversation_id: &str,
        kind: &str,
        payload: &Value,
    ) -> Result<SessionEvent, StoreError> {
        self.get_conversation(conversation_id)?;
        let payload = serde_json::to_string(payload)?;
        let database = self.database.lock().expect("agent database mutex poisoned");
        let next = database.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM session_events WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get::<_, i64>(0),
        )?;
        database.execute(
            "INSERT INTO session_events (conversation_id, seq, kind, payload)
             VALUES (?1, ?2, ?3, ?4)",
            params![conversation_id, next, kind, payload],
        )?;
        let created_at = database.query_row(
            "SELECT created_at FROM session_events WHERE conversation_id = ?1 AND seq = ?2",
            params![conversation_id, next],
            |row| row.get::<_, String>(0),
        )?;
        Ok(SessionEvent {
            conversation_id: conversation_id.to_owned(),
            seq: u64::try_from(next).map_err(|_| {
                StoreError::InvalidStoredValue("negative session event sequence".into())
            })?,
            kind: kind.to_owned(),
            payload: serde_json::from_str(&payload)?,
            created_at,
        })
    }

    pub fn session_events_after(
        &self,
        conversation_id: &str,
        cursor: u64,
    ) -> Result<Vec<SessionEvent>, StoreError> {
        self.get_conversation(conversation_id)?;
        let cursor = i64::try_from(cursor).map_err(|_| {
            StoreError::InvalidStoredValue("session event cursor exceeds SQLite range".into())
        })?;
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT conversation_id, seq, kind, payload, created_at
             FROM session_events WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq",
        )?;
        let rows = statement.query_map(params![conversation_id, cursor], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        rows.map(|row| {
            let (conversation_id, seq, kind, payload, created_at) = row?;
            Ok(SessionEvent {
                conversation_id,
                seq: u64::try_from(seq).map_err(|_| {
                    StoreError::InvalidStoredValue("negative session event sequence".into())
                })?,
                kind,
                payload: serde_json::from_str(&payload)?,
                created_at,
            })
        })
        .collect()
    }

    pub fn events_after(&self, run_id: &str, seq: u64) -> Result<Vec<AgentEvent>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT run_id, seq, kind, payload, created_at
             FROM agent_events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq",
        )?;
        let cursor = i64::try_from(seq).map_err(|_| {
            StoreError::InvalidStoredValue("event cursor exceeds SQLite range".into())
        })?;
        let rows = statement.query_map(params![run_id, cursor], |row| {
            let kind = row.get::<_, String>(2)?;
            let payload = row.get::<_, String>(3)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                kind,
                payload,
                row.get::<_, String>(4)?,
            ))
        })?;
        rows.map(|row| {
            let (run_id, stored_seq, kind, payload, created_at) = row?;
            let seq = u64::try_from(stored_seq).map_err(|_| {
                StoreError::InvalidStoredValue("negative event sequence in database".into())
            })?;
            Ok(AgentEvent {
                run_id,
                seq,
                kind: AgentEventKind::from_str(&kind)?,
                payload: serde_json::from_str(&payload)?,
                created_at,
            })
        })
        .collect()
    }

    pub fn append_workspace_event(
        &self,
        kind: &str,
        project_id: Option<&str>,
        conversation_id: Option<&str>,
        run_id: Option<&str>,
        payload: &Value,
    ) -> Result<WorkspaceEvent, StoreError> {
        let (event, workspace_cursor) = {
            let database = self.database.lock().expect("agent database mutex poisoned");
            database.execute(
                "INSERT INTO workspace_events
                 (kind, project_id, conversation_id, run_id, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    kind,
                    project_id,
                    conversation_id,
                    run_id,
                    serde_json::to_string(payload)?
                ],
            )?;
            let id = database.last_insert_rowid();
            let workspace_cursor = u64::try_from(id).map_err(|_| {
                StoreError::InvalidStoredValue("negative workspace event id".into())
            })?;
            (workspace_event_by_id(&database, id), workspace_cursor)
        };
        self.workspace_event_bus.publish_committed(workspace_cursor);
        event
    }

    pub fn workspace_events_after(&self, cursor: u64) -> Result<Vec<WorkspaceEvent>, StoreError> {
        let cursor = i64::try_from(cursor).map_err(|_| {
            StoreError::InvalidStoredValue("workspace event cursor exceeds SQLite range".into())
        })?;
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, kind, project_id, conversation_id, run_id, payload, created_at
             FROM workspace_events WHERE id > ?1 ORDER BY id LIMIT 512",
        )?;
        let rows = statement.query_map([cursor], workspace_event_from_row)?;
        rows.map(|row| row.and_then(workspace_event_from_values))
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn latest_workspace_event_id(&self) -> Result<u64, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        latest_workspace_event_id(&database)
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
        let mut latest_workspace_cursor = None;
        for run_id in run_ids {
            transaction.execute(
                "UPDATE agent_runs
                 SET status = 'interrupted', error = 'server restarted',
                     completed_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                [&run_id],
            )?;
            let (_, workspace_cursor) = append_event_transaction(
                &transaction,
                &run_id,
                AgentEventKind::RunCompleted,
                &json!({"status":"interrupted", "error":"server restarted"}),
            )?;
            latest_workspace_cursor = Some(workspace_cursor);
        }
        transaction.commit()?;
        if let Some(cursor) = latest_workspace_cursor {
            self.workspace_event_bus.publish_committed(cursor);
        }
        Ok(())
    }
}

fn append_session_state_workspace_event_transaction(
    transaction: &Transaction<'_>,
    project_id: &str,
    conversation_id: &str,
) -> Result<u64, StoreError> {
    transaction.execute(
        "INSERT INTO workspace_events
         (kind, project_id, conversation_id, run_id, payload)
         VALUES ('session_state', ?1, ?2, NULL, ?3)",
        params![
            project_id,
            conversation_id,
            serde_json::to_string(&json!({}))?
        ],
    )?;
    u64::try_from(transaction.last_insert_rowid())
        .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))
}

fn append_event_transaction(
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

fn insert_run_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    project_id: &str,
    message: &str,
    permission_mode: PermissionMode,
    internal: bool,
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
    };
    transaction.execute(
        "INSERT INTO agent_runs
         (id, conversation_id, project_id, message, status, permission_mode, internal)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            run.id,
            run.conversation_id,
            run.project_id,
            run.message,
            run.status.as_str(),
            run.permission_mode.as_str(),
            run.internal,
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

fn conversation_scope(
    transaction: &Transaction<'_>,
    conversation_id: &str,
) -> Result<(String, AgentId), StoreError> {
    let (project_id, agent_id) = transaction
        .query_row(
            "SELECT project_id, agent_id FROM conversations WHERE id = ?1",
            [conversation_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))?;
    Ok((project_id, AgentId::from_str(&agent_id)?))
}

fn latest_session_payload_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    kind: &str,
) -> Result<Option<Value>, StoreError> {
    let payload = transaction
        .query_row(
            "SELECT payload FROM session_events
             WHERE conversation_id = ?1 AND kind = ?2
             ORDER BY seq DESC LIMIT 1",
            params![conversation_id, kind],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    payload
        .map(|payload| serde_json::from_str(&payload).map_err(StoreError::from))
        .transpose()
}

fn latest_catalog_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
) -> Result<Option<ComposerCatalogSnapshot>, StoreError> {
    let snapshot =
        latest_session_payload_transaction(transaction, conversation_id, "composer_catalog")?
            .map(serde_json::from_value)
            .transpose()
            .map_err(StoreError::from)?;
    Ok(snapshot
        .filter(|snapshot: &ComposerCatalogSnapshot| snapshot.conversation_id == conversation_id))
}

fn catalog_snapshot_at_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    revision: u64,
) -> Result<Option<ComposerCatalogSnapshot>, StoreError> {
    let revision = i64::try_from(revision)
        .map_err(|error| StoreError::InvalidStoredValue(error.to_string()))?;
    let payload = transaction
        .query_row(
            "SELECT payload FROM composer_catalog_snapshots
             WHERE conversation_id = ?1 AND revision = ?2",
            params![conversation_id, revision],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let snapshot = payload
        .map(|payload| serde_json::from_str::<ComposerCatalogSnapshot>(&payload))
        .transpose()?;
    Ok(snapshot.filter(|snapshot| {
        snapshot.conversation_id == conversation_id && snapshot.revision == revision as u64
    }))
}

fn context_record_connection(
    database: &Connection,
    conversation_id: &str,
    opaque_id: &str,
) -> Result<Option<ComposerContextRecord>, StoreError> {
    let stored = database
        .query_row(
            "SELECT project_id, kind, relative_path, available
             FROM composer_contexts
             WHERE conversation_id = ?1 AND opaque_id = ?2",
            params![conversation_id, opaque_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )
        .optional()?;
    stored
        .map(|(project_id, kind, path, available)| {
            let kind = parse_context_kind(&kind).ok_or_else(|| {
                StoreError::InvalidStoredValue("unknown composer context kind".into())
            })?;
            Ok(ComposerContextRecord {
                id: opaque_id.to_owned(),
                project_id,
                conversation_id: conversation_id.to_owned(),
                kind,
                path,
                available,
            })
        })
        .transpose()
}

fn context_record_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    opaque_id: &str,
) -> Result<Option<ComposerContextRecord>, StoreError> {
    context_record_connection(transaction, conversation_id, opaque_id)
}

fn composer_contexts_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
) -> Result<Vec<crate::composer_catalog::ComposerContextMeta>, StoreError> {
    let mut statement = transaction.prepare(
        "SELECT opaque_id, project_id, kind, relative_path, available
         FROM composer_contexts WHERE conversation_id = ?1
         ORDER BY relative_path, kind, opaque_id",
    )?;
    let rows = statement
        .query_map([conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, project_id, kind, path, available)| {
            let kind = parse_context_kind(&kind).ok_or_else(|| {
                StoreError::InvalidStoredValue("unknown composer context kind".into())
            })?;
            Ok(ComposerContextRecord {
                id,
                project_id,
                conversation_id: conversation_id.to_owned(),
                kind,
                path,
                available,
            }
            .safe_meta())
        })
        .collect()
}

fn authoritative_catalog_transaction(
    transaction: &Transaction<'_>,
    project_id: &str,
    conversation_id: &str,
    agent_id: AgentId,
    revision: u64,
) -> Result<ComposerCatalogSnapshot, StoreError> {
    let raw =
        latest_session_payload_transaction(transaction, conversation_id, "available_commands")?
            .unwrap_or_else(|| json!({"availableCommands":[]}));
    Ok(project_acp_catalog_with_contexts(
        project_id,
        conversation_id,
        agent_id,
        revision,
        &raw,
        composer_contexts_transaction(transaction, conversation_id)?,
    ))
}

fn issue_catalog_snapshot_transaction(
    transaction: &Transaction<'_>,
    project_id: &str,
    conversation_id: &str,
    snapshot: &ComposerCatalogSnapshot,
) -> Result<u64, StoreError> {
    let payload = serde_json::to_value(snapshot)?;
    append_session_event_transaction(transaction, conversation_id, "composer_catalog", &payload)?;
    transaction.execute(
        "INSERT INTO composer_catalog_snapshots (conversation_id, revision, payload)
         VALUES (?1, ?2, ?3)",
        params![
            conversation_id,
            i64::try_from(snapshot.revision)
                .map_err(|error| StoreError::InvalidStoredValue(error.to_string()))?,
            serde_json::to_string(snapshot)?,
        ],
    )?;
    append_workspace_event_transaction(
        transaction,
        "composer_catalog_snapshot",
        Some(project_id),
        Some(conversation_id),
        None,
        &json!({
            "conversation_id": conversation_id,
            "revision": snapshot.revision,
            "snapshot": snapshot,
        }),
    )
}

fn latest_catalog_connection(
    database: &Connection,
    conversation_id: &str,
) -> Result<Option<ComposerCatalogSnapshot>, StoreError> {
    let payload = database
        .query_row(
            "SELECT payload FROM session_events
             WHERE conversation_id = ?1 AND kind = 'composer_catalog'
             ORDER BY seq DESC LIMIT 1",
            [conversation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let snapshot = payload
        .map(|payload| serde_json::from_str(&payload).map_err(StoreError::from))
        .transpose()?;
    Ok(snapshot
        .filter(|snapshot: &ComposerCatalogSnapshot| snapshot.conversation_id == conversation_id))
}

fn next_catalog_revision_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
) -> Result<u64, StoreError> {
    let current = transaction
        .query_row(
            "SELECT composer_catalog_revision FROM conversations WHERE id = ?1",
            [conversation_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))?;
    let next = current.checked_add(1).ok_or_else(|| {
        StoreError::InvalidStoredValue("composer catalog revision overflow".into())
    })?;
    transaction.execute(
        "UPDATE conversations SET composer_catalog_revision = ?2 WHERE id = ?1",
        params![conversation_id, next],
    )?;
    u64::try_from(next)
        .map_err(|_| StoreError::InvalidStoredValue("negative composer catalog revision".into()))
}

fn append_workspace_event_transaction(
    transaction: &Transaction<'_>,
    kind: &str,
    project_id: Option<&str>,
    conversation_id: Option<&str>,
    run_id: Option<&str>,
    payload: &Value,
) -> Result<u64, StoreError> {
    transaction.execute(
        "INSERT INTO workspace_events
         (kind, project_id, conversation_id, run_id, payload)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            kind,
            project_id,
            conversation_id,
            run_id,
            serde_json::to_string(payload)?,
        ],
    )?;
    u64::try_from(transaction.last_insert_rowid())
        .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))
}

fn latest_workspace_event_id(database: &Connection) -> Result<u64, StoreError> {
    let id = database.query_row(
        "SELECT COALESCE(MAX(id), 0) FROM workspace_events",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    u64::try_from(id)
        .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))
}

fn append_session_event_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    kind: &str,
    payload: &Value,
) -> Result<(), StoreError> {
    let next = transaction.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM session_events WHERE conversation_id = ?1",
        [conversation_id],
        |row| row.get::<_, i64>(0),
    )?;
    transaction.execute(
        "INSERT INTO session_events (conversation_id, seq, kind, payload)
         VALUES (?1, ?2, ?3, ?4)",
        params![conversation_id, next, kind, serde_json::to_string(payload)?],
    )?;
    Ok(())
}

type StoredWorkspaceEvent = (
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);

fn workspace_event_by_id(database: &Connection, id: i64) -> Result<WorkspaceEvent, StoreError> {
    let values = database.query_row(
        "SELECT id, kind, project_id, conversation_id, run_id, payload, created_at
         FROM workspace_events WHERE id = ?1",
        [id],
        workspace_event_from_row,
    )?;
    workspace_event_from_values(values).map_err(StoreError::from)
}

fn workspace_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredWorkspaceEvent> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
    ))
}

fn workspace_event_from_values(values: StoredWorkspaceEvent) -> rusqlite::Result<WorkspaceEvent> {
    let (id, kind, project_id, conversation_id, run_id, payload, created_at) = values;
    let id = u64::try_from(id).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })?;
    let payload = serde_json::from_str(&payload).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(WorkspaceEvent {
        id,
        kind,
        project_id,
        conversation_id,
        run_id,
        payload,
        created_at,
    })
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

fn conversation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    let agent_id = row.get::<_, String>(2)?;
    let relationship = row
        .get::<_, Option<String>>(11)?
        .map(|value| ConversationRelationship::from_str(&value))
        .transpose()
        .map_err(to_sql_conversion_error)?;
    let latest_run_status = row
        .get::<_, Option<String>>(13)?
        .map(|value| RunStatus::from_str(&value))
        .transpose()
        .map_err(to_sql_conversion_error)?;
    let execution_mode =
        ExecutionMode::from_str(&row.get::<_, String>(15)?).map_err(to_sql_conversion_error)?;
    Ok(Conversation {
        id: row.get(0)?,
        agent_session_id: row.get(14)?,
        project_id: row.get(1)?,
        agent_id: AgentId::from_str(&agent_id).map_err(to_sql_conversion_error)?,
        provider_session_id: row.get(3)?,
        title: row.get(4)?,
        manual_title: row.get(5)?,
        agent_title: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        archived: row.get(9)?,
        parent_conversation_id: row.get(10)?,
        relationship,
        read_only: row.get(12)?,
        latest_run_status,
        execution_mode,
        workspace_path: row.get(16)?,
        recreated_context: row.get(17)?,
        context_prefix: row.get(18)?,
    })
}

fn conversation_query(suffix: &str) -> String {
    format!(
        "SELECT c.id, c.project_id, c.agent_id, c.provider_session_id,
                COALESCE(c.manual_title, c.agent_title, ''), c.manual_title, c.agent_title,
                c.created_at, c.updated_at, c.archived, c.parent_conversation_id,
                c.relationship, c.read_only,
                (SELECT r.status FROM agent_runs r WHERE r.conversation_id = c.id
                 ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1),
                COALESCE(c.agent_session_id, c.id), c.execution_mode, c.workspace_path,
                c.recreated_context, c.context_prefix
         FROM conversations c {suffix}"
    )
}

fn normalized_title(title: Option<&str>) -> Option<String> {
    title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn fallback_conversation_title(source: &str) -> Option<String> {
    const MAX_WORDS: usize = 4;
    const MAX_CHARS: usize = 48;
    const STOP_WORDS: &[&str] = &[
        "a", "an", "can", "could", "for", "help", "me", "please", "the", "to", "would", "you",
    ];

    let line = source.lines().find(|line| !line.trim().is_empty())?.trim();
    if line.starts_with('/') {
        return None;
    }
    let words = line
        .split_whitespace()
        .map(|word| word.trim_matches(|character: char| !character.is_alphanumeric()))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let meaningful = words
        .iter()
        .copied()
        .filter(|word| !STOP_WORDS.contains(&word.to_ascii_lowercase().as_str()))
        .collect::<Vec<_>>();
    let selected = if meaningful.is_empty() {
        &words
    } else {
        &meaningful
    };
    let mut title = selected
        .iter()
        .take(MAX_WORDS)
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_CHARS)
        .collect::<String>();
    let first = title.chars().next()?;
    if first.is_lowercase() {
        title.replace_range(0..first.len_utf8(), &first.to_uppercase().to_string());
    }
    Some(title)
}

fn transcript_context(events: &[SessionEvent]) -> String {
    let mut transcript = String::from(
        "The following is immutable context recreated from an earlier Kubecode chat branch:\n",
    );
    let mut assistant_open = false;
    for event in events {
        match event.kind.as_str() {
            "user_message" => {
                if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                    transcript.push_str("\nUser: ");
                    transcript.push_str(text);
                    assistant_open = false;
                }
            }
            "text_delta" => {
                if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                    if !assistant_open {
                        transcript.push_str("\nAssistant: ");
                        assistant_open = true;
                    }
                    transcript.push_str(text);
                }
            }
            _ => {}
        }
    }
    transcript.trim().to_owned()
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
    })
}

fn ensure_column(
    database: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), rusqlite::Error> {
    let mut statement = database.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|current| current == column) {
        database.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn backfill_catalog_revision_high_water(database: &Connection) -> Result<(), StoreError> {
    let stored = {
        let mut statement = database.prepare(
            "SELECT se.conversation_id, se.payload
             FROM session_events se
             JOIN conversations c ON c.id = se.conversation_id
             WHERE se.kind = 'composer_catalog' AND c.composer_catalog_revision = 0",
        )?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut high_water = std::collections::BTreeMap::<String, u64>::new();
    for (conversation_id, payload) in stored {
        let Ok(snapshot) = serde_json::from_str::<ComposerCatalogSnapshot>(&payload) else {
            continue;
        };
        if snapshot.conversation_id != conversation_id {
            continue;
        }
        high_water
            .entry(conversation_id)
            .and_modify(|revision| *revision = (*revision).max(snapshot.revision))
            .or_insert(snapshot.revision);
    }
    for (conversation_id, revision) in high_water {
        let revision = i64::try_from(revision).map_err(|_| {
            StoreError::InvalidStoredValue("composer catalog revision exceeds SQLite range".into())
        })?;
        database.execute(
            "UPDATE conversations SET composer_catalog_revision = ?2 WHERE id = ?1",
            params![conversation_id, revision],
        )?;
    }
    Ok(())
}

fn backfill_catalog_snapshots(database: &Connection) -> Result<(), StoreError> {
    let stored = {
        let mut statement = database.prepare(
            "SELECT conversation_id, payload, created_at
             FROM session_events WHERE kind = 'composer_catalog'
             ORDER BY conversation_id, seq",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (conversation_id, payload, created_at) in stored {
        let Ok(snapshot) = serde_json::from_str::<ComposerCatalogSnapshot>(&payload) else {
            continue;
        };
        if snapshot.conversation_id != conversation_id || snapshot.revision == 0 {
            continue;
        }
        let revision = i64::try_from(snapshot.revision).map_err(|_| {
            StoreError::InvalidStoredValue("composer catalog revision exceeds SQLite range".into())
        })?;
        let existing = database
            .query_row(
                "SELECT payload FROM composer_catalog_snapshots
                 WHERE conversation_id = ?1 AND revision = ?2",
                params![conversation_id, revision],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            if serde_json::from_str::<ComposerCatalogSnapshot>(&existing)? != snapshot {
                return Err(StoreError::InvalidStoredValue(
                    "composer catalog revision maps to multiple snapshots".into(),
                ));
            }
            continue;
        }
        database.execute(
            "INSERT INTO composer_catalog_snapshots
             (conversation_id, revision, payload, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![conversation_id, revision, payload, created_at],
        )?;
    }
    Ok(())
}

fn to_sql_conversion_error(error: StoreError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

macro_rules! string_enum {
    ($type:ty, {$($variant:path => $value:literal),+ $(,)?}) => {
        impl $type {
            pub fn as_str(self) -> &'static str {
                match self { $($variant => $value),+ }
            }
        }

        impl FromStr for $type {
            type Err = StoreError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok($variant),)+
                    _ => Err(StoreError::InvalidStoredValue(value.to_owned())),
                }
            }
        }
    };
}

string_enum!(AgentId, {
    AgentId::ClaudeCode => "claude_code",
    AgentId::Codex => "codex",
    AgentId::OpenCode => "opencode",
});

string_enum!(PermissionMode, {
    PermissionMode::Safe => "safe",
    PermissionMode::Power => "power",
});

string_enum!(RunStatus, {
    RunStatus::Running => "running",
    RunStatus::WaitingPermission => "waiting_permission",
    RunStatus::Completed => "completed",
    RunStatus::Failed => "failed",
    RunStatus::Cancelled => "cancelled",
    RunStatus::TimedOut => "timed_out",
    RunStatus::Interrupted => "interrupted",
});

string_enum!(ConversationRelationship, {
    ConversationRelationship::Fork => "fork",
    ConversationRelationship::Subagent => "subagent",
    ConversationRelationship::Branch => "branch",
    ConversationRelationship::TeamMember => "team_member",
});

string_enum!(ExecutionMode, {
    ExecutionMode::Shared => "shared",
    ExecutionMode::Worktree => "worktree",
});

string_enum!(AgentEventKind, {
    AgentEventKind::RunStarted => "run_started",
    AgentEventKind::TextDelta => "text_delta",
    AgentEventKind::ThinkingDelta => "thinking_delta",
    AgentEventKind::ToolStarted => "tool_started",
    AgentEventKind::ToolUpdated => "tool_updated",
    AgentEventKind::ToolCompleted => "tool_completed",
    AgentEventKind::PermissionRequested => "permission_requested",
    AgentEventKind::PermissionResolved => "permission_resolved",
    AgentEventKind::Usage => "usage",
    AgentEventKind::Plan => "plan",
    AgentEventKind::AvailableCommands => "available_commands",
    AgentEventKind::CurrentMode => "current_mode",
    AgentEventKind::ConfigOptions => "config_options",
    AgentEventKind::SessionInfo => "session_info",
    AgentEventKind::ElicitationRequested => "elicitation_requested",
    AgentEventKind::ElicitationResolved => "elicitation_resolved",
    AgentEventKind::Error => "error",
    AgentEventKind::RunCompleted => "run_completed",
});

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn catalog_replacement_committing_before_typed_critical_section_wins() {
        let temp = TempDir::new().expect("tempdir");
        let store =
            Arc::new(AgentStore::open(temp.path().join("kubecode.sqlite3")).expect("agent store"));
        let conversation = store
            .create_conversation("project", AgentId::Codex, None)
            .expect("conversation");
        store
            .append_runtime_update(
                &conversation.id,
                "available_commands",
                &json!({"availableCommands":[{
                    "name":"status", "description":"Status"
                }]}),
                None,
            )
            .expect("initial catalog");
        let initial = store
            .composer_catalog_snapshot(&conversation.id)
            .expect("initial snapshot");
        let item_id = initial.items[0].id.clone();
        let gate = Arc::new(Barrier::new(2));

        let mut database = store.database.lock().expect("agent database mutex");
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("replacement transaction");
        let replacement = json!({"availableCommands":[]});
        append_session_event_transaction(
            &transaction,
            &conversation.id,
            "available_commands",
            &replacement,
        )
        .expect("raw replacement");
        let revision = next_catalog_revision_transaction(&transaction, &conversation.id)
            .expect("replacement revision");
        let candidate = crate::composer_catalog::project_acp_catalog(
            "project",
            &conversation.id,
            AgentId::Codex,
            revision,
            &replacement,
        );
        append_session_event_transaction(
            &transaction,
            &conversation.id,
            "composer_catalog",
            &serde_json::to_value(&candidate).expect("catalog JSON"),
        )
        .expect("safe replacement");

        let request_store = Arc::clone(&store);
        let request_conversation = conversation.id.clone();
        let request_gate = Arc::clone(&gate);
        let request = std::thread::spawn(move || {
            request_gate.wait();
            request_store.start_typed_composer_command(
                &request_conversation,
                "project",
                &item_id,
                initial.revision,
                "",
                PermissionMode::Safe,
            )
        });
        gate.wait();
        transaction.commit().expect("commit replacement");
        drop(database);

        let error = request
            .join()
            .expect("typed request thread")
            .expect_err("stale request");
        assert!(matches!(
            error,
            StoreError::Composer(ComposerCatalogError::StaleRevision)
        ));
        assert!(store.list_runs(&conversation.id).expect("runs").is_empty());
    }
}
