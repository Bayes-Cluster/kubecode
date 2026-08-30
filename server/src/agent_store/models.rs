use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::composer_catalog::{ComposerCatalogError, ComposerInvocation};
use crate::database::DatabaseError;

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
    #[error("queued prompt is not actionable: {0}")]
    QueueItemNotActionable(String),
    #[error("queue item not found: {0}")]
    QueueItemNotFound(String),
    #[error("fork unavailable: {0}")]
    ForkUnavailable(String),
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
pub enum TerminalCause {
    EndTurn,
    Cancelled,
    Error,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_boundary_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_path: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_cause: Option<TerminalCause>,
}

/// A prompt durably queued while another run is active (#95). Items drain
/// FIFO by position; the whole pending set broadcasts as a snapshot event
/// after every mutation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PromptQueueItem {
    pub id: String,
    pub conversation_id: String,
    pub project_id: String,
    pub content: String,
    pub status: PromptQueueStatus,
    pub position: i64,
    pub internal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptQueueStatus {
    Pending,
    Claimed,
}

/// Completed-turn cut points around a target run (#99): `after_seq` is the
/// ADR 0210 boundary (fork keeps the turn); `before_seq` is the redo point
/// (branch/revise drop the turn).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TurnBoundary {
    pub before_seq: u64,
    pub after_seq: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StartPromptOutcome {
    Started(AgentRun),
    Queued(PromptQueueItem),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComposerRunDispatch {
    pub run: AgentRun,
    pub prompt_message: String,
    pub provider_input: Option<ComposerInvocation>,
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

pub(super) fn to_sql_conversion_error(error: StoreError) -> rusqlite::Error {
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

string_enum!(TerminalCause, {
    TerminalCause::EndTurn => "end_turn",
    TerminalCause::Cancelled => "cancelled",
    TerminalCause::Error => "error",
    TerminalCause::MaxTokens => "max_tokens",
    TerminalCause::MaxTurnRequests => "max_turn_requests",
    TerminalCause::Refusal => "refusal",
    TerminalCause::Interrupted => "interrupted",
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

string_enum!(PromptQueueStatus, {
    PromptQueueStatus::Pending => "pending",
    PromptQueueStatus::Claimed => "claimed",
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
    use super::AgentId;

    #[test]
    fn agent_ids_have_one_canonical_stored_value() {
        assert_eq!(AgentId::ClaudeCode.as_str(), "claude_code");
        assert_eq!(AgentId::Codex.as_str(), "codex");
        assert_eq!(AgentId::OpenCode.as_str(), "opencode");
    }
}
