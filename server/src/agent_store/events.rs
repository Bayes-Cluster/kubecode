use std::str::FromStr;

use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::AgentStore;
use super::models::{AgentEvent, AgentEventKind, SessionEvent, StoreError};

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
    pub(super) fn new(latest_committed_cursor: u64) -> Self {
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

    pub(super) fn publish_committed(&self, cursor: u64) {
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

type StoredSessionEvent = (String, i64, String, String, String);

pub(super) fn stored_session_event_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<StoredSessionEvent> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

pub(super) fn deserialize_stored_session_event(
    (conversation_id, seq, kind, payload, created_at): StoredSessionEvent,
) -> Result<SessionEvent, StoreError> {
    Ok(SessionEvent {
        conversation_id,
        seq: u64::try_from(seq).map_err(|_| {
            StoreError::InvalidStoredValue("negative session event sequence".into())
        })?,
        kind,
        payload: serde_json::from_str(&payload)?,
        created_at,
    })
}

impl AgentStore {
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
}

pub(super) fn append_session_state_workspace_event_transaction(
    transaction: &Transaction<'_>,
    project_id: &str,
    conversation_id: &str,
    updates: &[(&str, &Value)],
) -> Result<u64, StoreError> {
    // The payload names the checkpoint kinds it carries so live consumers can
    // route individual updates (usage, mode, …) without a refetch while the
    // wire stays additive.
    let payload = json!({
        "updates": updates.iter().map(|(kind, value)| json!({
            "kind": kind,
            "payload": value,
        })).collect::<Vec<_>>(),
    });
    transaction.execute(
        "INSERT INTO workspace_events
         (kind, project_id, conversation_id, run_id, payload)
         VALUES ('session_state', ?1, ?2, NULL, ?3)",
        params![
            project_id,
            conversation_id,
            serde_json::to_string(&payload)?
        ],
    )?;
    u64::try_from(transaction.last_insert_rowid())
        .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))
}

pub(super) fn append_workspace_event_transaction(
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

pub(super) fn latest_workspace_event_id(database: &Connection) -> Result<u64, StoreError> {
    let id = database.query_row(
        "SELECT COALESCE(MAX(id), 0) FROM workspace_events",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    u64::try_from(id)
        .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))
}

pub(super) fn append_session_event_transaction(
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
