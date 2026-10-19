//! Types of the Workspace conversation (ADR 0216). Messages are immutable and
//! attributed; Threads group replies and may be linked to a research question
//! without moving a message.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use crate::project_context::ContextRef;

macro_rules! text_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

text_enum!(AuthorKind {
    Researcher => "researcher",
    Agent => "agent",
    System => "system",
});

text_enum!(MessageKind {
    Message => "message",
    System => "system",
});

// What a message asks for. Recorded only: nothing here acts on it.
text_enum!(Intent {
    Say => "say",
    Ask => "ask",
    Request => "request",
});

pub const MAX_BODY_CHARS: usize = 16_000;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_MENTIONS: usize = 8;
pub const MAX_REFERENCES: usize = 16;
pub const MAX_ID_CHARS: usize = 512;
pub const DEFAULT_PAGE: usize = 50;
pub const MAX_PAGE: usize = 200;
pub const MAX_THREADS: usize = 500;
pub const DEFAULT_CHANNEL_NAME: &str = "general";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Channel {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub is_default: bool,
    /// The newest message's sequence number (0 when empty).
    pub last_seq: u64,
    pub created_at: String,
}

/// A Session named in a message.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct Mention {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Message {
    pub id: String,
    pub project_id: String,
    pub channel_id: String,
    /// The Thread the message replies in; `None` for a top-level message.
    pub thread_id: Option<String>,
    pub seq: u64,
    pub kind: MessageKind,
    pub author_kind: AuthorKind,
    /// The writing Session, for an agent.
    pub author_ref: Option<String>,
    pub body: String,
    pub intent: Intent,
    pub mentions: Vec<Mention>,
    pub references: Vec<ContextRef>,
    pub client_message_id: Option<String>,
    /// Who consumed the intent, once someone did.
    pub intent_claimed_by: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Default)]
pub struct NewMessage<'a> {
    pub thread_id: Option<&'a str>,
    pub body: &'a str,
    pub author_kind: Option<AuthorKind>,
    pub author_ref: Option<&'a str>,
    pub intent: Option<Intent>,
    pub mentions: &'a [Mention],
    pub references: &'a [ContextRef],
    pub client_message_id: Option<&'a str>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Thread {
    pub id: String,
    pub project_id: String,
    pub channel_id: String,
    pub root_message_id: String,
    pub title: String,
    pub research_id: Option<String>,
    pub round_id: Option<String>,
    /// Bumped by every link change; a stale link is refused.
    pub revision: u64,
    pub reply_count: u64,
    pub last_seq: u64,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Which messages of a channel a page lists.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Scope<'a> {
    /// Top-level messages only: the channel as a timeline of topics.
    #[default]
    Channel,
    /// One Thread's root and replies, in order.
    Thread(&'a str),
    /// Every message of the channel, replies included, in order: the whole
    /// conversation as one stream.
    All,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MessageQuery<'a> {
    pub scope: Scope<'a>,
    /// Messages older than this sequence number (scrolling back).
    pub before_seq: Option<u64>,
    /// Messages newer than this sequence number (catching up).
    pub after_seq: Option<u64>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MessagePage {
    /// Oldest first.
    pub messages: Vec<Message>,
    /// There are older messages than the first one returned.
    pub has_more: bool,
}

/// The result of claiming a message's intent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Claim {
    /// This claimer now owns the intent.
    Claimed(Box<Message>),
    /// Someone already consumed it (possibly this same claimer, on a replay).
    AlreadyClaimed { by: String },
}

#[derive(Debug, Error)]
pub enum ChannelError {
    /// Missing, or in another Project: indistinguishable by design.
    #[error("channel not found")]
    NotFound,
    #[error("message not found")]
    MessageNotFound,
    #[error("thread not found")]
    ThreadNotFound,
    #[error("invalid conversation input: {0}")]
    Invalid(&'static str),
    #[error("this client message id was already used for a different message")]
    KeyReuse,
    #[error("the thread changed (current revision {current})")]
    Stale { current: u64 },
    #[error("the message carries no intent to claim")]
    NoIntent,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
