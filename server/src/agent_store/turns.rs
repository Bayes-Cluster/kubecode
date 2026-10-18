//! Bounded, read-only access to a conversation's turns for cross-Session
//! context reads (ADR 0214). It reads the canonical event log; it copies
//! nothing and never changes a conversation.

use rusqlite::{OptionalExtension, params};

use super::{AgentStore, StoreError};

/// One turn's text, cut to a byte budget.
#[derive(Clone, Debug)]
pub struct TurnText {
    pub run_id: String,
    pub user: String,
    pub assistant: String,
    pub assistant_truncated: bool,
}

/// Longest assistant span scanned, whatever the byte budget.
const MAX_TURN_EVENTS: i64 = 4096;

impl AgentStore {
    /// The text of the turn started by `run_id`, with the assistant side cut
    /// at `max_bytes`. `None` when the conversation has no such turn.
    pub fn read_turn_text(
        &self,
        conversation_id: &str,
        run_id: &str,
        max_bytes: usize,
    ) -> Result<Option<TurnText>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let anchor = database
            .query_row(
                "SELECT seq, json_extract(payload, '$.text') FROM session_events
                 WHERE conversation_id = ?1 AND kind = 'user_message'
                   AND json_extract(payload, '$.run_id') = ?2
                 LIMIT 1",
                params![conversation_id, run_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let Some((seq, user)) = anchor else {
            return Ok(None);
        };
        let next: Option<i64> = database.query_row(
            "SELECT MIN(seq) FROM session_events
             WHERE conversation_id = ?1 AND kind = 'user_message' AND seq > ?2",
            params![conversation_id, seq],
            |row| row.get(0),
        )?;
        let mut statement = database.prepare(
            "SELECT json_extract(payload, '$.text') FROM session_events
             WHERE conversation_id = ?1 AND kind = 'text_delta' AND seq > ?2
               AND (?3 IS NULL OR seq < ?3)
             ORDER BY seq LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![conversation_id, seq, next, MAX_TURN_EVENTS],
            |row| row.get::<_, Option<String>>(0),
        )?;
        let mut assistant = String::new();
        let mut truncated = false;
        for text in rows.flatten().flatten() {
            if assistant.len() + text.len() > max_bytes {
                let room = max_bytes.saturating_sub(assistant.len());
                let cut = (0..=room)
                    .rev()
                    .find(|index| text.is_char_boundary(*index))
                    .unwrap_or(0);
                assistant.push_str(&text[..cut]);
                truncated = true;
                break;
            }
            assistant.push_str(&text);
        }
        Ok(Some(TurnText {
            run_id: run_id.to_owned(),
            user: user.unwrap_or_default(),
            assistant,
            assistant_truncated: truncated,
        }))
    }

    /// How many user-visible turns a conversation has, and the latest one's
    /// run id: a Session's revision for change detection.
    pub fn conversation_activity(
        &self,
        conversation_id: &str,
    ) -> Result<(u64, Option<String>), StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let count: i64 = database.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE conversation_id = ?1 AND internal = 0",
            [conversation_id],
            |row| row.get(0),
        )?;
        let last: Option<String> = database
            .query_row(
                "SELECT id FROM agent_runs WHERE conversation_id = ?1 AND internal = 0
                 ORDER BY rowid DESC LIMIT 1",
                [conversation_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok((count as u64, last))
    }
}
