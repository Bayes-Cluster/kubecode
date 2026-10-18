//! Types of the server-owned orchestrator (ADR 0217): durable routes that carry
//! a researcher's request, a targeted question, a dispatched task, or a result
//! to the Session that must act on it.

use serde::{Deserialize, Serialize};
use thiserror::Error;

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

// What a route carries.
text_enum!(RouteKind {
    Request => "request",
    Ask => "ask",
    Dispatch => "dispatch",
    Result => "result",
});

// Where a route's payload came from.
text_enum!(SourceKind {
    Message => "message",
    Attempt => "attempt",
    Work => "work",
});

// `delivered` is receipt of the event by the Session. It is not task
// completion and not experiment analysis: those are work and experiment state.
text_enum!(RouteState {
    Pending => "pending",
    Delivered => "delivered",
    Failed => "failed",
});

/// Who a route is for: the round's coordinator *as of delivery* (so a handoff
/// retargets pending routes), or a fixed Session.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    Coordinator { round_id: String },
    Session { session_id: String },
}

impl Target {
    /// Part of a route's identity: one source reaches one target once.
    pub fn key(&self) -> String {
        match self {
            Self::Coordinator { round_id } => format!("round:{round_id}"),
            Self::Session { session_id } => format!("session:{session_id}"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Route {
    pub id: String,
    pub project_id: String,
    pub kind: RouteKind,
    pub source_kind: SourceKind,
    pub source_id: String,
    pub target: Target,
    /// The Thread to report progress to, when the route began in one.
    pub thread_id: Option<String>,
    pub body: String,
    pub state: RouteState,
    pub attempts: u32,
    /// Times the recipient was busy; busy is not failure.
    pub busy: u32,
    pub last_error: Option<String>,
    /// The Session that received it.
    pub recipient: Option<String>,
    pub created_at: String,
    pub delivered_at: Option<String>,
}

/// One delivery the sink must make exactly once per `delivery_key`.
#[derive(Clone, Debug)]
pub struct DeliveryRequest<'a> {
    pub project_id: &'a str,
    pub conversation_id: &'a str,
    pub delivery_key: &'a str,
    pub body: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryOutcome {
    /// The Session has the prompt (started, or durably queued behind a busy turn).
    Delivered,
    /// The Session cannot take it right now; try again later.
    Busy,
    /// The provider or runtime refused it.
    Failed(String),
}

/// Hands a prompt to a Session. Implementations must be idempotent per
/// `delivery_key`, because a crash between a delivery and its record repeats it.
pub trait RouteSink: Send + Sync {
    fn deliver(&self, request: &DeliveryRequest<'_>) -> DeliveryOutcome;
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RoutingReport {
    pub routed: usize,
    pub denied: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DeliveryReport {
    pub delivered: usize,
    pub retried: usize,
    pub failed: usize,
}

pub const MAX_ATTEMPTS: u32 = 5;
pub const MAX_BUSY: u32 = 30;
pub const LEASE_SECS: i64 = 60;
pub const BATCH: usize = 20;
pub const MAX_BODY_CHARS: usize = 12_000;

#[derive(Debug, Error)]
pub enum OrchestratorError {
    #[error("not found")]
    NotFound,
    #[error("invalid orchestration input: {0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Channel(#[from] crate::channel_store::ChannelError),
    #[error(transparent)]
    Work(#[from] crate::work_store::WorkError),
    #[error(transparent)]
    Research(#[from] crate::research_store::ResearchError),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
}
