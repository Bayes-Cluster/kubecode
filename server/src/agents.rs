use std::path::Path;
use std::str::FromStr;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

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
    Json(#[from] serde_json::Error),
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
    pub project_id: String,
    pub agent_id: AgentId,
    pub provider_session_id: Option<String>,
    pub title: String,
    pub manual_title: Option<String>,
    pub agent_title: Option<String>,
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

pub struct AgentStore {
    database: Mutex<Connection>,
}

impl AgentStore {
    pub fn open(database_path: impl AsRef<Path>) -> Result<Self, StoreError> {
        if let Some(parent) = database_path.as_ref().parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                StoreError::InvalidStoredValue(format!("cannot create state directory: {error}"))
            })?;
        }
        let database = Connection::open(database_path)?;
        database.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS conversations (
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
               started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               completed_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_agent_runs_project_status
               ON agent_runs(project_id, status);
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
             );",
        )?;
        ensure_column(
            &database,
            "agent_runs",
            "message",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(&database, "conversations", "manual_title", "TEXT")?;
        ensure_column(&database, "conversations", "agent_title", "TEXT")?;
        database.execute(
            "UPDATE conversations SET manual_title = title
             WHERE manual_title IS NULL AND agent_title IS NULL
               AND TRIM(title) <> '' AND title <> 'New conversation'",
            [],
        )?;
        let store = Self {
            database: Mutex::new(database),
        };
        store.interrupt_inflight_runs()?;
        Ok(store)
    }

    pub fn create_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        title: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_owned(),
            agent_id,
            provider_session_id: None,
            title: normalized_title(title).unwrap_or_default(),
            manual_title: normalized_title(title),
            agent_title: None,
        };
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO conversations (id, project_id, agent_id, title, manual_title)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    conversation.id,
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
        Ok(conversation)
    }

    pub fn create_imported_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        provider_session_id: &str,
        agent_title: Option<&str>,
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
            project_id: project_id.to_owned(),
            agent_id,
            provider_session_id: Some(provider_session_id.to_owned()),
            title: agent_title.clone().unwrap_or_default(),
            manual_title: None,
            agent_title,
        };
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO conversations
                 (id, project_id, agent_id, provider_session_id, title, agent_title)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conversation.id,
                    conversation.project_id,
                    conversation.agent_id.as_str(),
                    conversation.provider_session_id,
                    conversation.title,
                    conversation.agent_title,
                ],
            )?;
        self.append_workspace_event(
            "session_imported",
            Some(project_id),
            Some(&conversation.id),
            None,
            &json!({"agent_id": agent_id, "provider_session_id": provider_session_id}),
        )?;
        Ok(conversation)
    }

    pub fn get_conversation(&self, conversation_id: &str) -> Result<Conversation, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                "SELECT id, project_id, agent_id, provider_session_id,
                        COALESCE(manual_title, agent_title, ''), manual_title, agent_title
                 FROM conversations WHERE id = ?1",
                [conversation_id],
                conversation_from_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))
    }

    pub fn list_conversations(&self, project_id: &str) -> Result<Vec<Conversation>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, project_id, agent_id, provider_session_id,
                    COALESCE(manual_title, agent_title, ''), manual_title, agent_title
             FROM conversations WHERE project_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = statement.query_map([project_id], conversation_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
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

    pub fn delete_conversation(&self, conversation_id: &str) -> Result<(), StoreError> {
        let conversation = self.get_conversation(conversation_id)?;
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute("DELETE FROM conversations WHERE id = ?1", [conversation_id])?;
        self.append_workspace_event(
            "session_removed",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({"scope":"local"}),
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
                "SELECT id, project_id, agent_id, provider_session_id,
                        COALESCE(manual_title, agent_title, ''), manual_title, agent_title
                 FROM conversations
                 WHERE project_id = ?1 AND agent_id = ?2 AND provider_session_id = ?3",
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
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction()?;
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
        };
        transaction.execute(
            "INSERT INTO agent_runs
             (id, conversation_id, project_id, message, status, permission_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                run.id,
                run.conversation_id,
                run.project_id,
                run.message,
                run.status.as_str(),
                run.permission_mode.as_str()
            ],
        )?;
        append_event_transaction(
            &transaction,
            &run.id,
            AgentEventKind::RunStarted,
            &json!({"permission_mode": permission_mode}),
        )?;
        transaction.commit()?;
        drop(database);
        self.append_session_event(
            conversation_id,
            "user_message",
            &json!({"run_id":run.id, "text":message}),
        )?;
        Ok(run)
    }

    pub fn get_run(&self, run_id: &str) -> Result<AgentRun, StoreError> {
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .query_row(
                "SELECT id, conversation_id, project_id, message, status, permission_mode, error
                 FROM agent_runs WHERE id = ?1",
                [run_id],
                run_from_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::RunNotFound(run_id.to_owned()))
    }

    pub fn list_runs(&self, conversation_id: &str) -> Result<Vec<AgentRun>, StoreError> {
        self.get_conversation(conversation_id)?;
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, conversation_id, project_id, message, status, permission_mode, error
             FROM agent_runs WHERE conversation_id = ?1 ORDER BY rowid",
        )?;
        let rows = statement.query_map([conversation_id], run_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_project_runs(&self, project_id: &str) -> Result<Vec<AgentRun>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, conversation_id, project_id, message, status, permission_mode, error
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
        let transaction = database.transaction()?;
        let changed = transaction.execute(
            "UPDATE agent_runs
             SET status = ?2, error = ?3, completed_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![run_id, status.as_str(), error],
        )?;
        if changed == 0 {
            return Err(StoreError::RunNotFound(run_id.to_owned()));
        }
        append_event_transaction(
            &transaction,
            run_id,
            AgentEventKind::RunCompleted,
            &json!({"status": status, "error": error}),
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn append_event(
        &self,
        run_id: &str,
        kind: AgentEventKind,
        payload: &Value,
    ) -> Result<AgentEvent, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction()?;
        let event = append_event_transaction(&transaction, run_id, kind, payload)?;
        transaction.commit()?;
        Ok(event)
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
        workspace_event_by_id(&database, id)
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
        let transaction = database.transaction()?;
        let run_ids = {
            let mut statement = transaction.prepare(
                "SELECT id FROM agent_runs
                 WHERE status IN ('running', 'waiting_permission')",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for run_id in run_ids {
            transaction.execute(
                "UPDATE agent_runs
                 SET status = 'interrupted', error = 'server restarted',
                     completed_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                [&run_id],
            )?;
            append_event_transaction(
                &transaction,
                &run_id,
                AgentEventKind::RunCompleted,
                &json!({"status":"interrupted", "error":"server restarted"}),
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
}

fn append_event_transaction(
    transaction: &Transaction<'_>,
    run_id: &str,
    kind: AgentEventKind,
    payload: &Value,
) -> Result<AgentEvent, StoreError> {
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
    let created_at = transaction.query_row(
        "SELECT created_at FROM agent_events WHERE run_id = ?1 AND seq = ?2",
        params![run_id, stored_seq],
        |row| row.get::<_, String>(0),
    )?;
    Ok(AgentEvent {
        run_id: run_id.to_owned(),
        seq: u64::try_from(stored_seq).map_err(|_| {
            StoreError::InvalidStoredValue("negative event sequence in database".into())
        })?,
        kind,
        payload: serde_json::from_str(&payload)?,
        created_at,
    })
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

fn conversation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    let agent_id = row.get::<_, String>(2)?;
    Ok(Conversation {
        id: row.get(0)?,
        project_id: row.get(1)?,
        agent_id: AgentId::from_str(&agent_id).map_err(to_sql_conversion_error)?,
        provider_session_id: row.get(3)?,
        title: row.get(4)?,
        manual_title: row.get(5)?,
        agent_title: row.get(6)?,
    })
}

fn normalized_title(title: Option<&str>) -> Option<String> {
    title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
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
