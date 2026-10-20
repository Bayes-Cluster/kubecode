//! The Workspace conversation (ADR 0216): Project-scoped channels, immutable
//! attributed messages, and Threads that can be linked to a research question.
//! It shares the Runtime's single SQLite owner (ADR 0200) and commits every
//! `channel_updated` workspace event in the same transaction as the change it
//! announces, so a browser that reloads or reconnects converges by refetching.
//!
//! Nothing here starts an Agent. A message may carry an intent (`ask`,
//! `request`), but that is a recorded request: a consumer claims it by message
//! id, exactly once, and replaying or re-reading a message never acts on it.

mod models;
#[cfg(test)]
mod tests;

pub use models::*;

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde_json::json;
use uuid::Uuid;

use crate::agent_store::AgentStore;
use crate::database::{Database, ensure_column};
use crate::project_context::ContextKind;

pub struct ChannelStore {
    database: Arc<Database>,
    agents: Arc<AgentStore>,
}

/// What changed, for the content-free `channel_updated` event payload.
#[derive(Clone, Copy, Debug)]
enum Change {
    Channel,
    Message,
    Thread,
    Link,
    Intent,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Message => "message",
            Self::Thread => "thread",
            Self::Link => "link",
            Self::Intent => "intent",
        }
    }
}

/// `(project_id, channel_id, thread_id, change)` of an event to announce.
type Announce = Option<(String, String, Option<String>, Change)>;

pub fn ensure_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS channels (
           id         TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           name       TEXT NOT NULL,
           is_default INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         -- Exactly one default channel per Project, whatever races to create it.
         CREATE UNIQUE INDEX IF NOT EXISTS channels_default
           ON channels(project_id) WHERE is_default = 1;
         CREATE TABLE IF NOT EXISTS channel_messages (
           id                TEXT PRIMARY KEY,
           project_id        TEXT NOT NULL,
           channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
           thread_id         TEXT,
           seq               INTEGER NOT NULL,
           kind              TEXT NOT NULL DEFAULT 'message',
           author_kind       TEXT NOT NULL,
           author_ref        TEXT,
           body              TEXT NOT NULL,
           intent            TEXT NOT NULL DEFAULT 'say',
           mentions_json     TEXT NOT NULL DEFAULT '[]',
           references_json   TEXT NOT NULL DEFAULT '[]',
           client_message_id TEXT,
           intent_claimed_by TEXT,
           intent_claimed_at TEXT,
           created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           UNIQUE (channel_id, seq)
         );
         CREATE INDEX IF NOT EXISTS channel_messages_thread
           ON channel_messages(thread_id, seq);
         CREATE UNIQUE INDEX IF NOT EXISTS channel_messages_request
           ON channel_messages(channel_id, client_message_id)
           WHERE client_message_id IS NOT NULL;
         CREATE TABLE IF NOT EXISTS channel_threads (
           id              TEXT PRIMARY KEY,
           project_id      TEXT NOT NULL,
           channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
           root_message_id TEXT NOT NULL UNIQUE,
           title           TEXT NOT NULL DEFAULT '',
           research_id     TEXT,
           round_id        TEXT,
           revision        INTEGER NOT NULL DEFAULT 1,
           created_by      TEXT,
           created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         -- The orchestrator's pass scans only what nobody has claimed.
         CREATE INDEX IF NOT EXISTS channel_messages_intents
           ON channel_messages(created_at) WHERE intent != 'say' AND intent_claimed_by IS NULL;
         CREATE INDEX IF NOT EXISTS channel_threads_channel
           ON channel_threads(channel_id);
         CREATE INDEX IF NOT EXISTS channel_threads_research
           ON channel_threads(research_id);",
    )?;
    // Conversation routing (ADR 0223): a Task association, a citation, the
    // hand-off depth, and whether the orchestrator still has to read the message.
    ensure_column(connection, "channel_messages", "task_id", "TEXT")?;
    ensure_column(connection, "channel_messages", "reply_to", "TEXT")?;
    ensure_column(
        connection,
        "channel_messages",
        "hops",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(connection, "channel_messages", "routing", "TEXT")?;
    // Messages written before Tasks were associated with them: the first
    // research question a message references is its Task. Idempotent.
    connection.execute(
        "UPDATE channel_messages
         SET task_id = (SELECT json_extract(value, '$.id')
                        FROM json_each(channel_messages.references_json)
                        WHERE json_extract(value, '$.kind') = 'research' LIMIT 1)
         WHERE task_id IS NULL AND references_json != '[]'",
        [],
    )?;
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS channel_messages_pending
           ON channel_messages(created_at) WHERE routing = 'pending';
         CREATE INDEX IF NOT EXISTS channel_messages_task
           ON channel_messages(channel_id, task_id, seq) WHERE task_id IS NOT NULL;",
    )
}

const MESSAGE_SELECT: &str = "SELECT id, project_id, channel_id, thread_id, seq, kind, author_kind,
        author_ref, body, intent, mentions_json, references_json, client_message_id,
        intent_claimed_by, created_at, task_id, reply_to, hops
    FROM channel_messages";

const THREAD_SELECT: &str = "SELECT t.id, t.project_id, t.channel_id, t.root_message_id, t.title,
        t.research_id, t.round_id, t.revision,
        (SELECT COUNT(*) FROM channel_messages m WHERE m.thread_id = t.id AND m.kind = 'message'),
        COALESCE((SELECT MAX(m.seq) FROM channel_messages m WHERE m.thread_id = t.id),
                 (SELECT r.seq FROM channel_messages r WHERE r.id = t.root_message_id), 0),
        t.created_by, t.created_at, t.updated_at
    FROM channel_threads t";

fn decode<T: serde::de::DeserializeOwned>(index: usize, text: String) -> rusqlite::Result<T> {
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn message_from_row(row: &Row<'_>) -> rusqlite::Result<Message> {
    let kind: String = row.get(5)?;
    let author_kind: String = row.get(6)?;
    let intent: String = row.get(9)?;
    Ok(Message {
        id: row.get(0)?,
        project_id: row.get(1)?,
        channel_id: row.get(2)?,
        thread_id: row.get(3)?,
        seq: row.get::<_, i64>(4)? as u64,
        kind: MessageKind::parse(&kind).unwrap_or(MessageKind::Message),
        author_kind: AuthorKind::parse(&author_kind).unwrap_or(AuthorKind::System),
        author_ref: row.get(7)?,
        body: row.get(8)?,
        intent: Intent::parse(&intent).unwrap_or(Intent::Say),
        mentions: decode(10, row.get(10)?)?,
        references: decode(11, row.get(11)?)?,
        client_message_id: row.get(12)?,
        intent_claimed_by: row.get(13)?,
        created_at: row.get(14)?,
        task_id: row.get(15)?,
        reply_to: row.get(16)?,
        hops: row.get::<_, i64>(17)?.clamp(0, i64::from(u8::MAX)) as u8,
    })
}

fn thread_from_row(row: &Row<'_>) -> rusqlite::Result<Thread> {
    Ok(Thread {
        id: row.get(0)?,
        project_id: row.get(1)?,
        channel_id: row.get(2)?,
        root_message_id: row.get(3)?,
        title: row.get(4)?,
        research_id: row.get(5)?,
        round_id: row.get(6)?,
        revision: row.get::<_, i64>(7)? as u64,
        reply_count: row.get::<_, i64>(8)? as u64,
        last_seq: row.get::<_, i64>(9)? as u64,
        created_by: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn load_channel(
    connection: &Connection,
    project_id: &str,
    channel_id: &str,
) -> Result<Channel, ChannelError> {
    connection
        .query_row(
            "SELECT c.id, c.project_id, c.name, c.is_default,
                    COALESCE((SELECT MAX(m.seq) FROM channel_messages m WHERE m.channel_id = c.id), 0),
                    c.created_at
             FROM channels c WHERE c.id = ?1 AND c.project_id = ?2",
            params![channel_id, project_id],
            |row| {
                Ok(Channel {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    name: row.get(2)?,
                    is_default: row.get(3)?,
                    last_seq: row.get::<_, i64>(4)? as u64,
                    created_at: row.get(5)?,
                })
            },
        )
        .optional()?
        .ok_or(ChannelError::NotFound)
}

fn load_thread(
    connection: &Connection,
    project_id: &str,
    thread_id: &str,
) -> Result<Thread, ChannelError> {
    connection
        .query_row(
            &format!("{THREAD_SELECT} WHERE t.id = ?1 AND t.project_id = ?2"),
            params![thread_id, project_id],
            thread_from_row,
        )
        .optional()?
        .ok_or(ChannelError::ThreadNotFound)
}

fn load_message(
    connection: &Connection,
    project_id: &str,
    message_id: &str,
) -> Result<Message, ChannelError> {
    connection
        .query_row(
            &format!("{MESSAGE_SELECT} WHERE id = ?1 AND project_id = ?2"),
            params![message_id, project_id],
            message_from_row,
        )
        .optional()?
        .ok_or(ChannelError::MessageNotFound)
}

/// The message a client message id was first used for in a channel.
fn load_by_client_id(
    connection: &Connection,
    project_id: &str,
    channel_id: &str,
    client_message_id: &str,
) -> Result<Option<Message>, ChannelError> {
    Ok(connection
        .query_row(
            &format!(
                "{MESSAGE_SELECT} WHERE channel_id = ?1 AND client_message_id = ?2
                   AND project_id = ?3"
            ),
            params![channel_id, client_message_id, project_id],
            message_from_row,
        )
        .optional()?)
}

fn session_in_project(
    tx: &Connection,
    project_id: &str,
    session_id: &str,
) -> Result<bool, ChannelError> {
    Ok(tx
        .query_row(
            "SELECT 1 FROM conversations
             WHERE id = ?1 AND project_id = ?2 AND internal_revision = 0",
            params![session_id, project_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn client_id(value: Option<&str>) -> Result<Option<String>, ChannelError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > 128
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
    {
        return Err(ChannelError::Invalid("invalid client message id"));
    }
    Ok(Some(value.to_owned()))
}

/// A reference is accepted only if the record exists in this Project.
fn validate_reference(
    tx: &Connection,
    project_id: &str,
    reference: &ContextRef,
) -> Result<(), ChannelError> {
    if reference.id.chars().count() > MAX_ID_CHARS
        || reference
            .revision
            .as_deref()
            .is_some_and(|revision| revision.chars().count() > 128)
    {
        return Err(ChannelError::Invalid(
            "a reference id or revision is too long",
        ));
    }
    let found = match reference.kind {
        ContextKind::Thread => tx
            .query_row(
                "SELECT 1 FROM channel_threads WHERE id = ?1 AND project_id = ?2",
                params![reference.id, project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some(),
        ContextKind::Channel => tx
            .query_row(
                "SELECT 1 FROM channels WHERE id = ?1 AND project_id = ?2",
                params![reference.id, project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some(),
        kind => match crate::work_store::validate_reference(
            tx,
            project_id,
            kind.as_str(),
            &reference.id,
        ) {
            Ok(()) => true,
            Err(crate::work_store::WorkError::Database(error)) => return Err(error.into()),
            Err(_) => false,
        },
    };
    if !found {
        return Err(ChannelError::Invalid(
            "a referenced record was not found in this Project",
        ));
    }
    Ok(())
}

impl ChannelStore {
    /// The Team, research, experiment, and work stores must already have
    /// created their tables: references are validated against them.
    pub fn from_database(
        database: Arc<Database>,
        agents: Arc<AgentStore>,
    ) -> Result<Self, ChannelError> {
        ensure_schema(&database.lock().expect("channel database mutex poisoned"))?;
        Ok(Self { database, agents })
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.database
            .lock()
            .expect("channel database mutex poisoned")
    }

    fn write<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<(T, Announce), ChannelError>,
    ) -> Result<T, ChannelError> {
        let mut connection = self.connection();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (value, change) = operation(&transaction)?;
        let cursor = match change {
            Some((project_id, channel_id, thread_id, change)) => {
                transaction.execute(
                    "INSERT INTO workspace_events (kind, project_id, payload)
                     VALUES ('channel_updated', ?1, ?2)",
                    params![
                        project_id,
                        json!({
                            "channel_id": channel_id,
                            "thread_id": thread_id,
                            "change": change.as_str(),
                        })
                        .to_string()
                    ],
                )?;
                Some(transaction.last_insert_rowid() as u64)
            }
            None => None,
        };
        transaction.commit()?;
        drop(connection);
        if let Some(cursor) = cursor {
            self.agents.workspace_event_bus().publish_committed(cursor);
        }
        Ok(value)
    }

    // -- Channels ------------------------------------------------------------

    /// The Project's default channel, created on first use.
    pub fn default_channel(&self, project_id: &str) -> Result<Channel, ChannelError> {
        {
            let connection = self.connection();
            if let Some(id) = connection
                .query_row(
                    "SELECT id FROM channels WHERE project_id = ?1 AND is_default = 1",
                    [project_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                return load_channel(&connection, project_id, &id);
            }
        }
        self.write(|tx| {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM channels WHERE project_id = ?1 AND is_default = 1",
                    [project_id],
                    |row| row.get(0),
                )
                .optional()?;
            let (id, created) = match existing {
                Some(id) => (id, false),
                None => {
                    let id = Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT INTO channels (id, project_id, name, is_default)
                         VALUES (?1, ?2, ?3, 1)",
                        params![id, project_id, DEFAULT_CHANNEL_NAME],
                    )?;
                    (id, true)
                }
            };
            let channel = load_channel(tx, project_id, &id)?;
            let change = created.then(|| (project_id.to_owned(), id, None, Change::Channel));
            Ok((channel, change))
        })
    }

    pub fn channel(&self, project_id: &str, channel_id: &str) -> Result<Channel, ChannelError> {
        load_channel(&self.connection(), project_id, channel_id)
    }

    /// Channels that exist, without creating the default one (for readers).
    pub fn existing_channels(&self, project_id: &str) -> Result<Vec<Channel>, ChannelError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT id FROM channels WHERE project_id = ?1 ORDER BY is_default DESC, created_at, id",
        )?;
        let ids = statement
            .query_map([project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| load_channel(&connection, project_id, id))
            .collect()
    }

    pub fn channels(&self, project_id: &str) -> Result<Vec<Channel>, ChannelError> {
        self.default_channel(project_id)?;
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT id FROM channels WHERE project_id = ?1 ORDER BY is_default DESC, created_at, id",
        )?;
        let ids = statement
            .query_map([project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| load_channel(&connection, project_id, id))
            .collect()
    }

    // -- Messages --------------------------------------------------------------

    /// Appends a message. A repeated `client_message_id` returns the stored
    /// message (`created = false`) and writes nothing; reusing it for different
    /// content is refused. A reply goes to a Thread of the same channel.
    pub fn post(
        &self,
        project_id: &str,
        channel_id: &str,
        new: NewMessage<'_>,
    ) -> Result<(Message, bool), ChannelError> {
        let body = new.body.trim();
        if body.is_empty() {
            return Err(ChannelError::Invalid("a message body is required"));
        }
        if body.chars().count() > MAX_BODY_CHARS {
            return Err(ChannelError::Invalid("the message is too long"));
        }
        if new.mentions.len() > MAX_MENTIONS {
            return Err(ChannelError::Invalid("too many mentions"));
        }
        if new.references.len() > MAX_REFERENCES {
            return Err(ChannelError::Invalid("too many references"));
        }
        let author_kind = new.author_kind.unwrap_or(AuthorKind::Researcher);
        let intent = new.intent.unwrap_or(Intent::Say);
        match (intent, author_kind) {
            (Intent::Request, AuthorKind::Agent | AuthorKind::System) => {
                return Err(ChannelError::Invalid(
                    "only the researcher can request that work be organized",
                ));
            }
            (Intent::Ask, _) if new.mentions.is_empty() => {
                return Err(ChannelError::Invalid("a question needs a Session to ask"));
            }
            (_, AuthorKind::Agent) if new.author_ref.is_none() => {
                return Err(ChannelError::Invalid("an agent message names its Session"));
            }
            _ => {}
        }
        if new.hops > MAX_HANDOFF_HOPS {
            return Err(ChannelError::Invalid(
                "this hand-off chain is too long; ask the researcher to continue it",
            ));
        }
        let request = client_id(new.client_message_id)?;
        self.write(|tx| {
            load_channel(tx, project_id, channel_id)?;
            if let Some(request) = &request
                && let Some(existing) = load_by_client_id(tx, project_id, channel_id, request)?
            {
                let same = existing.body == body
                    && existing.thread_id.as_deref() == new.thread_id
                    && existing.author_kind == author_kind
                    && existing.author_ref.as_deref() == new.author_ref
                    && existing.intent == intent
                    && existing.mentions == new.mentions
                    && existing.references == new.references
                    && existing.reply_to.as_deref() == new.reply_to;
                if !same {
                    return Err(ChannelError::KeyReuse);
                }
                return Ok(((existing, false), None));
            }
            if let Some(thread_id) = new.thread_id {
                let thread = load_thread(tx, project_id, thread_id)?;
                if thread.channel_id != channel_id {
                    return Err(ChannelError::ThreadNotFound);
                }
            }
            if let (AuthorKind::Agent, Some(author)) = (author_kind, new.author_ref)
                && !session_in_project(tx, project_id, author)?
            {
                return Err(ChannelError::Invalid("the author Session was not found"));
            }
            for mention in new.mentions {
                if mention.session_id.chars().count() > MAX_ID_CHARS {
                    return Err(ChannelError::Invalid("a mention is too long"));
                }
                if !session_in_project(tx, project_id, &mention.session_id)? {
                    return Err(ChannelError::Invalid("a mentioned Session was not found"));
                }
            }
            for reference in new.references {
                validate_reference(tx, project_id, reference)?;
            }
            if let Some(cited) = new.reply_to {
                let same_channel = tx
                    .query_row(
                        "SELECT 1 FROM channel_messages
                         WHERE id = ?1 AND project_id = ?2 AND channel_id = ?3",
                        params![cited, project_id, channel_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if !same_channel {
                    return Err(ChannelError::Invalid(
                        "the message being replied to was not found in this conversation",
                    ));
                }
            }
            // The conversation's own messages are read by the orchestrator once:
            // a researcher's remark, or an agent hand-off that names someone.
            let routed = new.thread_id.is_none()
                && match author_kind {
                    AuthorKind::Researcher => intent == Intent::Say,
                    AuthorKind::Agent => !new.mentions.is_empty(),
                    AuthorKind::System => false,
                };
            let message = insert_message(
                tx,
                project_id,
                channel_id,
                new.thread_id,
                MessageKind::Message,
                author_kind,
                new.author_ref,
                body,
                intent,
                new.mentions,
                new.references,
                request.as_deref(),
                Extras {
                    reply_to: new.reply_to,
                    hops: new.hops,
                    routing: routed.then_some("pending"),
                },
            )?;
            let change = (
                project_id.to_owned(),
                channel_id.to_owned(),
                new.thread_id.map(str::to_owned),
                Change::Message,
            );
            Ok(((message, true), Some(change)))
        })
    }

    /// A page of messages. With no cursor it is the latest page; `before_seq`
    /// scrolls back and `after_seq` catches up. Oldest first.
    pub fn messages(
        &self,
        project_id: &str,
        channel_id: &str,
        query: MessageQuery<'_>,
    ) -> Result<MessagePage, ChannelError> {
        let connection = self.connection();
        load_channel(&connection, project_id, channel_id)?;
        let limit = query.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
        let (scope_sql, thread_param): (&str, Option<String>) = match query.scope {
            Scope::Channel => ("thread_id IS NULL AND ?2 IS NULL", None),
            Scope::All => ("?2 IS NULL", None),
            Scope::Thread(thread_id) => {
                let thread = load_thread(&connection, project_id, thread_id)?;
                if thread.channel_id != channel_id {
                    return Err(ChannelError::ThreadNotFound);
                }
                (
                    "(thread_id = ?2 OR id = (SELECT root_message_id FROM channel_threads WHERE id = ?2))",
                    Some(thread.id),
                )
            }
        };
        let task = query.task.map(str::to_owned);
        let base = format!(
            "{MESSAGE_SELECT} WHERE channel_id = ?1 AND {scope_sql} AND (?5 IS NULL OR task_id = ?5)"
        );
        let mut messages = if let Some(after) = query.after_seq {
            let mut statement =
                connection.prepare(&format!("{base} AND seq > ?3 ORDER BY seq ASC LIMIT ?4"))?;
            statement
                .query_map(
                    params![channel_id, thread_param, after as i64, limit as i64, task],
                    message_from_row,
                )?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            let before = query.before_seq.map_or(i64::MAX, |seq| seq as i64);
            let mut statement =
                connection.prepare(&format!("{base} AND seq < ?3 ORDER BY seq DESC LIMIT ?4"))?;
            let mut rows = statement
                .query_map(
                    params![channel_id, thread_param, before, limit as i64, task],
                    message_from_row,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            rows.reverse();
            rows
        };
        messages.shrink_to_fit();
        let has_more = match messages.first() {
            Some(first) => connection
                .query_row(
                    &format!("SELECT 1 FROM channel_messages WHERE channel_id = ?1 AND {scope_sql} AND (?4 IS NULL OR task_id = ?4) AND seq < ?3 LIMIT 1"),
                    params![channel_id, thread_param, first.seq as i64, task],
                    |_| Ok(()),
                )
                .optional()?
                .is_some(),
            None => false,
        };
        Ok(MessagePage { messages, has_more })
    }

    /// The first top-level proposal of a brief revision in a channel: its
    /// sequence and the Session that wrote it. Proposals are posted by the
    /// Task service under the key `proposal:{research}:{revision}` (or a later
    /// `…:again:…` copy), so only they count as showing the proposal.
    pub fn proposal_seq(
        &self,
        project_id: &str,
        channel_id: &str,
        research_id: &str,
        revision: &str,
    ) -> Result<Option<(u64, Option<String>)>, ChannelError> {
        let exact = format!("proposal:{research_id}:{revision}");
        let again = format!("proposal:{research_id}:{revision}:again:%");
        Ok(self
            .connection()
            .query_row(
                "SELECT seq, author_ref FROM channel_messages
                 WHERE project_id = ?1 AND channel_id = ?2 AND thread_id IS NULL
                   AND author_kind = 'agent'
                   AND (client_message_id = ?3 OR client_message_id LIKE ?4)
                 ORDER BY seq LIMIT 1",
                params![project_id, channel_id, exact, again],
                |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?)),
            )
            .optional()?)
    }

    /// The research question and revision of the newest top-level proposal
    /// posted before `before_seq`.
    pub fn latest_proposal_before(
        &self,
        project_id: &str,
        channel_id: &str,
        before_seq: u64,
    ) -> Result<Option<(String, String)>, ChannelError> {
        let key: Option<String> = self
            .connection()
            .query_row(
                "SELECT client_message_id FROM channel_messages
                 WHERE project_id = ?1 AND channel_id = ?2 AND thread_id IS NULL
                   AND author_kind = 'agent' AND client_message_id LIKE 'proposal:%'
                   AND seq < ?3
                 ORDER BY seq DESC LIMIT 1",
                params![project_id, channel_id, before_seq as i64],
                |row| row.get(0),
            )
            .optional()?;
        Ok(key.and_then(|key| {
            let mut parts = key.split(':');
            let (_, id, revision) = (parts.next()?, parts.next()?, parts.next()?);
            Some((id.to_owned(), revision.to_owned()))
        }))
    }

    pub fn message(&self, project_id: &str, message_id: &str) -> Result<Message, ChannelError> {
        load_message(&self.connection(), project_id, message_id)
    }

    /// The message stored under a client message id in a channel, if any: what
    /// a retried post replays.
    pub fn by_client_message_id(
        &self,
        project_id: &str,
        channel_id: &str,
        client_message_id: &str,
    ) -> Result<Option<Message>, ChannelError> {
        load_by_client_id(
            &self.connection(),
            project_id,
            channel_id,
            client_message_id,
        )
    }

    // -- Threads ---------------------------------------------------------------

    /// Starts a Thread on a top-level message. Idempotent per root message.
    pub fn start_thread(
        &self,
        project_id: &str,
        channel_id: &str,
        root_message_id: &str,
        title: Option<&str>,
        created_by: Option<&str>,
    ) -> Result<(Thread, bool), ChannelError> {
        let title = title.map(str::trim).unwrap_or_default();
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(ChannelError::Invalid("the title is too long"));
        }
        if let Some(created_by) = created_by
            && created_by.chars().count() > MAX_ID_CHARS
        {
            return Err(ChannelError::Invalid("the creator is too long"));
        }
        self.write(|tx| {
            load_channel(tx, project_id, channel_id)?;
            let root = load_message(tx, project_id, root_message_id)?;
            if root.channel_id != channel_id || root.thread_id.is_some() {
                return Err(ChannelError::MessageNotFound);
            }
            if root.kind != MessageKind::Message {
                return Err(ChannelError::Invalid("only a message can start a Thread"));
            }
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM channel_threads WHERE root_message_id = ?1",
                    [root_message_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(id) = existing {
                return Ok(((load_thread(tx, project_id, &id)?, false), None));
            }
            let id = Uuid::new_v4().to_string();
            let title = if title.is_empty() {
                let flat: String = root.body.split_whitespace().collect::<Vec<_>>().join(" ");
                flat.chars().take(80).collect()
            } else {
                title.to_owned()
            };
            tx.execute(
                "INSERT INTO channel_threads (id, project_id, channel_id, root_message_id, title, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, project_id, channel_id, root_message_id, title, created_by],
            )?;
            let thread = load_thread(tx, project_id, &id)?;
            Ok((
                (thread, true),
                Some((
                    project_id.to_owned(),
                    channel_id.to_owned(),
                    Some(id),
                    Change::Thread,
                )),
            ))
        })
    }

    pub fn thread(&self, project_id: &str, thread_id: &str) -> Result<Thread, ChannelError> {
        load_thread(&self.connection(), project_id, thread_id)
    }

    /// The Thread rooted at a message, if one was started.
    pub fn thread_of_message(
        &self,
        project_id: &str,
        message_id: &str,
    ) -> Result<Option<Thread>, ChannelError> {
        Ok(self
            .connection()
            .query_row(
                &format!("{THREAD_SELECT} WHERE t.root_message_id = ?1 AND t.project_id = ?2"),
                params![message_id, project_id],
                thread_from_row,
            )
            .optional()?)
    }

    /// Threads of a channel, most recently active first, optionally only those
    /// linked to one research question.
    pub fn threads(
        &self,
        project_id: &str,
        channel_id: &str,
        research_id: Option<&str>,
    ) -> Result<Vec<Thread>, ChannelError> {
        let connection = self.connection();
        load_channel(&connection, project_id, channel_id)?;
        let mut statement = connection.prepare(&format!(
            "{THREAD_SELECT} WHERE t.channel_id = ?1 AND t.project_id = ?2
               AND (?3 IS NULL OR t.research_id = ?3)"
        ))?;
        let mut threads = statement
            .query_map(
                params![channel_id, project_id, research_id],
                thread_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        threads.sort_by(|a, b| b.last_seq.cmp(&a.last_seq).then_with(|| a.id.cmp(&b.id)));
        threads.truncate(MAX_THREADS);
        Ok(threads)
    }

    /// Links a Thread to a research question (and optionally one of its
    /// rounds), or unlinks it with `None`. Revision-checked; repeating the
    /// current link is a no-op. The change is recorded in the Thread as a
    /// system message; no message moves and no work starts.
    pub fn link_thread(
        &self,
        project_id: &str,
        thread_id: &str,
        expected_revision: u64,
        research_id: Option<&str>,
        round_id: Option<&str>,
    ) -> Result<Thread, ChannelError> {
        if research_id.is_none() && round_id.is_some() {
            return Err(ChannelError::Invalid("a round needs its research question"));
        }
        self.write(|tx| {
            let thread = load_thread(tx, project_id, thread_id)?;
            if thread.research_id.as_deref() == research_id
                && thread.round_id.as_deref() == round_id
            {
                return Ok((thread, None));
            }
            if thread.revision != expected_revision {
                return Err(ChannelError::Stale {
                    current: thread.revision,
                });
            }
            let mut references = Vec::new();
            let text = match research_id {
                Some(research_id) => {
                    let archived: bool = tx
                        .query_row(
                            "SELECT archived FROM research_questions WHERE id = ?1 AND project_id = ?2",
                            params![research_id, project_id],
                            |row| row.get(0),
                        )
                        .optional()?
                        .ok_or(ChannelError::Invalid(
                            "the research question was not found in this Project",
                        ))?;
                    if archived {
                        return Err(ChannelError::Invalid(
                            "an archived research question cannot take a Thread",
                        ));
                    }
                    references.push(ContextRef::new(ContextKind::Research, research_id));
                    if let Some(round_id) = round_id {
                        let belongs = tx
                            .query_row(
                                "SELECT 1 FROM research_rounds WHERE id = ?1 AND research_id = ?2",
                                params![round_id, research_id],
                                |_| Ok(()),
                            )
                            .optional()?
                            .is_some();
                        if !belongs {
                            return Err(ChannelError::Invalid(
                                "the round does not belong to that research question",
                            ));
                        }
                        references.push(ContextRef::new(ContextKind::Round, round_id));
                    }
                    "This discussion is now linked to a research question."
                }
                None => "This discussion is no longer linked to a research question.",
            };
            tx.execute(
                "UPDATE channel_threads SET research_id = ?2, round_id = ?3,
                   revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![thread_id, research_id, round_id],
            )?;
            insert_message(
                tx,
                project_id,
                &thread.channel_id,
                Some(thread_id),
                MessageKind::System,
                AuthorKind::System,
                None,
                text,
                Intent::Say,
                &[],
                &references,
                None,
                Extras::default(),
            )?;
            Ok((
                load_thread(tx, project_id, thread_id)?,
                Some((
                    project_id.to_owned(),
                    thread.channel_id,
                    Some(thread_id.to_owned()),
                    Change::Link,
                )),
            ))
        })
    }

    // -- Intents ---------------------------------------------------------------

    /// Claims a message's intent for `claimer` with one conditional write. The
    /// first claim wins; every later one — a duplicate delivery, a restarted
    /// consumer — is told who holds it and must do nothing.
    pub fn claim_intent(
        &self,
        project_id: &str,
        message_id: &str,
        claimer: &str,
    ) -> Result<Claim, ChannelError> {
        if claimer.is_empty() || claimer.chars().count() > MAX_ID_CHARS {
            return Err(ChannelError::Invalid("a claimer is required"));
        }
        self.write(|tx| {
            let message = load_message(tx, project_id, message_id)?;
            if message.intent == Intent::Say {
                return Err(ChannelError::NoIntent);
            }
            let changed = tx.execute(
                "UPDATE channel_messages
                 SET intent_claimed_by = ?2, intent_claimed_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND intent_claimed_by IS NULL",
                params![message_id, claimer],
            )?;
            if changed == 0 {
                let by = load_message(tx, project_id, message_id)?
                    .intent_claimed_by
                    .unwrap_or_default();
                return Ok((Claim::AlreadyClaimed { by }, None));
            }
            Ok((
                Claim::Claimed(Box::new(load_message(tx, project_id, message_id)?)),
                Some((
                    project_id.to_owned(),
                    message.channel_id,
                    message.thread_id,
                    Change::Intent,
                )),
            ))
        })
    }

    /// How many hand-offs (agent messages naming someone) this Session made in
    /// the last hour: the bound on a chain however it is shaped.
    pub fn recent_handoffs(&self, project_id: &str, session_id: &str) -> Result<u32, ChannelError> {
        let count: i64 = self.connection().query_row(
            "SELECT COUNT(*) FROM channel_messages
             WHERE project_id = ?1 AND author_kind = 'agent' AND author_ref = ?2
               AND mentions_json != '[]' AND created_at > datetime('now', '-1 hour')",
            params![project_id, session_id],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u32)
    }

    /// Messages the orchestrator has not read yet, oldest first.
    pub fn pending_routing(&self, limit: usize) -> Result<Vec<Message>, ChannelError> {
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "{MESSAGE_SELECT} WHERE routing = 'pending' ORDER BY created_at, seq LIMIT ?1"
        ))?;
        Ok(statement
            .query_map([limit.clamp(1, MAX_PAGE) as i64], message_from_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Records that a message was read. Routes are written first, so a crash
    /// before this repeats the pass and finds the routes already there.
    pub fn mark_routed(&self, project_id: &str, message_id: &str) -> Result<(), ChannelError> {
        self.connection().execute(
            "UPDATE channel_messages SET routing = 'done'
             WHERE id = ?1 AND project_id = ?2 AND routing = 'pending'",
            params![message_id, project_id],
        )?;
        Ok(())
    }

    /// Unclaimed intents of every Project, oldest first (for the orchestrator).
    pub fn all_unclaimed_intents(&self, limit: usize) -> Result<Vec<Message>, ChannelError> {
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "{MESSAGE_SELECT} WHERE intent != 'say' AND intent_claimed_by IS NULL
             ORDER BY created_at, seq LIMIT ?1"
        ))?;
        Ok(statement
            .query_map([limit.clamp(1, MAX_PAGE) as i64], message_from_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Messages whose intent nobody has claimed yet, oldest first.
    pub fn unclaimed_intents(
        &self,
        project_id: &str,
        limit: usize,
    ) -> Result<Vec<Message>, ChannelError> {
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "{MESSAGE_SELECT} WHERE project_id = ?1 AND intent != 'say' AND intent_claimed_by IS NULL
             ORDER BY created_at, seq LIMIT ?2"
        ))?;
        Ok(statement
            .query_map(
                params![project_id, limit.clamp(1, MAX_PAGE) as i64],
                message_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?)
    }
}

/// What a message carries beyond its text: the citation, the hand-off depth,
/// and whether the orchestrator must still read it.
#[derive(Clone, Copy, Default)]
struct Extras<'a> {
    reply_to: Option<&'a str>,
    hops: u8,
    routing: Option<&'a str>,
}

#[allow(clippy::too_many_arguments)]
fn insert_message(
    tx: &Transaction<'_>,
    project_id: &str,
    channel_id: &str,
    thread_id: Option<&str>,
    kind: MessageKind,
    author_kind: AuthorKind,
    author_ref: Option<&str>,
    body: &str,
    intent: Intent,
    mentions: &[Mention],
    references: &[ContextRef],
    client_message_id: Option<&str>,
    extras: Extras<'_>,
) -> Result<Message, ChannelError> {
    let task_id = references
        .iter()
        .find(|reference| reference.kind == ContextKind::Research)
        .map(|reference| reference.id.as_str());
    let seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM channel_messages WHERE channel_id = ?1",
        [channel_id],
        |row| row.get(0),
    )?;
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO channel_messages
           (id, project_id, channel_id, thread_id, seq, kind, author_kind, author_ref, body,
            intent, mentions_json, references_json, client_message_id,
            task_id, reply_to, hops, routing)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            id,
            project_id,
            channel_id,
            thread_id,
            seq,
            kind.as_str(),
            author_kind.as_str(),
            author_ref,
            body,
            intent.as_str(),
            serde_json::to_string(mentions)?,
            serde_json::to_string(references)?,
            client_message_id,
            task_id,
            extras.reply_to,
            i64::from(extras.hops),
            extras.routing,
        ],
    )?;
    load_message(tx, project_id, &id)
}
