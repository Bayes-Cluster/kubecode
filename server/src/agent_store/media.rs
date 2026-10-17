//! Agent-shared media references (issue #132). The journal records one row
//! per structured `resource_link` an Agent shares in a run, then publishes a
//! content-free `media_shared` run event carrying only the opaque id, the
//! delivery kind, and the MIME type. The URI, declared size, and caption
//! stay server-side: no workspace event, browser payload, or log carries
//! them. Rows cascade with their conversation and are bounded per
//! conversation.

use rusqlite::{OptionalExtension, params};

use super::AgentStore;
use super::models::StoreError;

/// Retained references per conversation; older rows are pruned.
pub const AGENT_MEDIA_KEEP: i64 = 256;

/// A server-side reference to an Agent-shared file.
#[derive(Clone, PartialEq, Eq)]
pub struct AgentMediaRef {
    pub id: String,
    pub conversation_id: String,
    pub run_id: String,
    /// The Agent-supplied `file://` URI; resolved only through
    /// `WorkspaceService` against the Session execution root.
    pub uri: String,
    pub declared_size: Option<u64>,
    pub caption: Option<String>,
}

/// Content-free rendering: never prints the URI or caption.
impl std::fmt::Debug for AgentMediaRef {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "AgentMediaRef({})", self.id)
    }
}

impl AgentStore {
    pub fn record_agent_media(&self, media: &AgentMediaRef) -> Result<(), StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database.execute(
            "INSERT OR IGNORE INTO agent_media_refs
               (id, conversation_id, run_id, uri, declared_size, caption)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                media.id,
                media.conversation_id,
                media.run_id,
                media.uri,
                media.declared_size.map(|size| size as i64),
                media.caption,
            ],
        )?;
        database.execute(
            "DELETE FROM agent_media_refs
             WHERE conversation_id = ?1 AND id NOT IN (
               SELECT id FROM agent_media_refs WHERE conversation_id = ?1
               ORDER BY created_at DESC, rowid DESC LIMIT ?2
             )",
            params![media.conversation_id, AGENT_MEDIA_KEEP],
        )?;
        Ok(())
    }

    pub fn agent_media(&self, media_id: &str) -> Result<Option<AgentMediaRef>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                "SELECT id, conversation_id, run_id, uri, declared_size, caption
                 FROM agent_media_refs WHERE id = ?1",
                [media_id],
                |row| {
                    Ok(AgentMediaRef {
                        id: row.get(0)?,
                        conversation_id: row.get(1)?,
                        run_id: row.get(2)?,
                        uri: row.get(3)?,
                        declared_size: row
                            .get::<_, Option<i64>>(4)?
                            .and_then(|size| u64::try_from(size).ok()),
                        caption: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }
}
