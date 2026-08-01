use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::database::DatabaseError;

pub(crate) const MAX_TEAMMATES: i64 = 8;

#[derive(Debug, Error)]
pub enum TeamError {
    #[error("team not found: {0}")]
    TeamNotFound(String),
    #[error("team member not found: {0}")]
    MemberNotFound(String),
    #[error("team task not found: {0}")]
    TaskNotFound(String),
    #[error("only the team leader may perform this action")]
    LeaderRequired,
    #[error("the team leader cannot be removed")]
    LeaderCannotBeRemoved,
    #[error("team member does not belong to this team")]
    WrongTeam,
    #[error("team member name already exists: {0}")]
    DuplicateMemberName(String),
    #[error("team has reached the {MAX_TEAMMATES} teammate limit")]
    MemberLimit,
    #[error("task is not available to claim")]
    TaskUnavailable,
    #[error("task is not assigned to this member")]
    TaskNotAssigned,
    #[error("team proposal not found: {0}")]
    ProposalNotFound(String),
    #[error("team permission request not found: {0}")]
    PermissionNotFound(String),
    #[error("team permission request is no longer pending")]
    PermissionNotPending,
    #[error("permission option was not offered by the Agent: {0}")]
    InvalidPermissionOption(String),
    #[error("a team proposal can only be approved or rejected")]
    InvalidProposalDecision,
    #[error("team concurrency must be between 1 and {MAX_TEAMMATES}")]
    InvalidConcurrency,
    #[error("team member limit must be between 1 and {MAX_TEAMMATES}")]
    InvalidMemberLimit,
    #[error("team review rounds must be between 1 and 10")]
    InvalidReviewRounds,
    #[error("a Team goal is required before it can start")]
    GoalRequired,
    #[error("at least one acceptance criterion is required before a Team can start")]
    AcceptanceCriteriaRequired,
    #[error("at least one Agent must be allowed before a Team can start")]
    AllowedAgentsRequired,
    #[error("the Leader Agent does not advertise a native YOLO profile: {0}")]
    NativeAutonomyUnavailable(String),
    #[error("the Team is not in the required lifecycle state")]
    InvalidTeamState,
    #[error("the Team cannot complete until all required work and reviews are resolved")]
    CompletionBlocked,
    #[error("team discrimination round not found: {0}")]
    DiscriminationNotFound(String),
    #[error("team lifecycle operation not found: {0}")]
    LifecycleOperationNotFound(String),
    #[error("team user input request not found: {0}")]
    UserInputRequestNotFound(String),
    #[error("team user input request is no longer pending")]
    UserInputRequestNotPending,
    #[error("only a Team discriminator may submit a verdict")]
    DiscriminatorRequired,
    #[error("a discriminator cannot perform concrete Team work")]
    DiscriminatorCannotWork,
    #[error("invalid stored team value: {0}")]
    InvalidStoredValue(String),
    #[error("database error ({diagnostic})")]
    Database {
        #[source]
        source: rusqlite::Error,
        diagnostic: String,
    },
    #[error(transparent)]
    DatabaseSetup(#[from] DatabaseError),
}

impl From<rusqlite::Error> for TeamError {
    fn from(source: rusqlite::Error) -> Self {
        let diagnostic = match &source {
            rusqlite::Error::SqliteFailure(failure, _) => format!(
                "primary={:?}, extended_code={}",
                failure.code, failure.extended_code
            ),
            _ => source.to_string(),
        };
        Self::Database { source, diagnostic }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRole {
    Leader,
    Teammate,
    Discriminator,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberManagementPolicy {
    #[default]
    Ask,
    Auto,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamWorkspace {
    #[default]
    Shared,
    Worktree,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberWorkspaceMode {
    Shared,
    Isolated,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamMemberStatus {
    Starting,
    Configuring,
    Queued,
    Idle,
    Working,
    WaitingInput,
    WaitingPermission,
    Failed,
    Stopped,
    Removing,
    Removed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamStatus {
    Draft,
    Starting,
    Active,
    Paused,
    Verifying,
    NeedsAttention,
    Completed,
    Archived,
    Disbanding,
    Removed,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamMode {
    #[default]
    Standard,
    Yolo,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscriminationStatus {
    Running,
    Passed,
    Rejected,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamTaskAttemptStatus {
    Queued,
    Running,
    NeedsReport,
    ResultSubmitted,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamTaskFailureKind {
    RateLimit,
    Quota,
    Auth,
    PermissionDenied,
    Process,
    Protocol,
    Timeout,
    Interrupted,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamTaskStatus {
    Pending,
    Blocked,
    InProgress,
    PlanReview,
    ResultReview,
    ChangesRequested,
    Accepted,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamMessageKind {
    Direct,
    TaskAssigned,
    PlanReady,
    ResultReady,
    ChangesRequested,
    System,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamMessageDeliveryStatus {
    Pending,
    Delivered,
    Acknowledged,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamLifecycleOperationKind {
    Provisioning,
    ProviderCleanup,
    Disband,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamLifecycleOperationStatus {
    Pending,
    Running,
    RetryScheduled,
    Failed,
    Completed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamUserInputStatus {
    Pending,
    Resolved,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamProposalStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamPermissionStatus {
    PendingLeader,
    WaitingUser,
    Resolved,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Team {
    pub id: String,
    pub project_id: String,
    pub leader_member_id: String,
    pub agent_session_id: String,
    pub title: String,
    pub status: TeamStatus,
    pub workspace: TeamWorkspace,
    pub workspace_path: Option<String>,
    pub member_management_policy: MemberManagementPolicy,
    pub max_parallel_runs: u8,
    pub requested_mode: TeamMode,
    pub mode: TeamMode,
    pub mode_fallback: Option<TeamModeFallback>,
    pub goal: String,
    pub acceptance_criteria: Vec<String>,
    pub allowed_agent_ids: Vec<String>,
    pub max_teammates: u8,
    pub max_review_rounds: u8,
    pub current_review_round: u8,
    pub workspace_fingerprint: Option<String>,
    pub final_summary: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamModeFallback {
    pub agent_id: String,
    pub reason_code: String,
    pub reason: String,
    pub occurred_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamMember {
    pub id: String,
    pub team_id: String,
    pub conversation_id: String,
    pub name: String,
    pub role: TeamRole,
    pub status: TeamMemberStatus,
    pub workspace_mode: MemberWorkspaceMode,
    pub base_tree: Option<String>,
    pub permission_profile_applied: bool,
    pub previous_permission_mode: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamTask {
    pub id: String,
    pub team_id: String,
    pub creator_member_id: String,
    pub assignee_member_id: Option<String>,
    pub title: String,
    pub description: String,
    pub status: TeamTaskStatus,
    pub completion_required: bool,
    pub requires_plan_approval: bool,
    pub plan: Option<String>,
    pub mutates_files: bool,
    pub result: Option<String>,
    pub verification: Option<String>,
    pub dependencies: Vec<String>,
    pub owned_paths: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamMessage {
    pub id: String,
    pub team_id: String,
    pub from_member_id: String,
    pub to_member_id: String,
    pub kind: TeamMessageKind,
    pub task_id: Option<String>,
    pub body: String,
    pub read_at: Option<String>,
    pub delivery_status: TeamMessageDeliveryStatus,
    pub delivery_attempts: u32,
    pub delivered_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamLifecycleOperation {
    pub id: String,
    pub team_id: String,
    pub project_id: String,
    pub kind: TeamLifecycleOperationKind,
    pub status: TeamLifecycleOperationStatus,
    pub member_id: Option<String>,
    pub conversation_id: Option<String>,
    pub payload_json: String,
    pub attempt_count: u32,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamUserInputRequest {
    pub id: String,
    pub team_id: String,
    pub requester_member_id: String,
    pub title: String,
    pub prompt: String,
    pub resume_status: TeamStatus,
    pub status: TeamUserInputStatus,
    pub answer: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamProposal {
    pub id: String,
    pub team_id: String,
    pub summary: String,
    pub members_json: String,
    pub status: TeamProposalStatus,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamActivity {
    pub id: i64,
    pub team_id: String,
    pub member_id: Option<String>,
    pub task_id: Option<String>,
    pub kind: String,
    pub summary: String,
    pub metadata_json: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamPermissionRequest {
    pub id: String,
    pub team_id: String,
    pub member_id: String,
    pub conversation_id: String,
    pub run_id: String,
    pub tool: String,
    pub input_json: String,
    pub options_json: String,
    pub status: TeamPermissionStatus,
    pub selected_option_id: Option<String>,
    pub reason: Option<String>,
    pub decided_by: Option<String>,
    pub decided_by_member_id: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamDiscriminationRound {
    pub id: String,
    pub team_id: String,
    pub discriminator_member_id: String,
    pub round: u8,
    pub workspace_fingerprint: String,
    pub status: DiscriminationStatus,
    pub verdict: Option<String>,
    pub evidence: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TeamTaskAttempt {
    pub id: String,
    pub team_id: String,
    pub task_id: String,
    pub member_id: String,
    pub run_id: Option<String>,
    pub status: TeamTaskAttemptStatus,
    pub failure_kind: Option<TeamTaskFailureKind>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

pub struct NewTeam<'a> {
    pub project_id: &'a str,
    pub leader_conversation_id: &'a str,
    pub agent_session_id: &'a str,
    pub leader_name: &'a str,
    pub title: Option<&'a str>,
    pub workspace: TeamWorkspace,
    pub workspace_path: Option<&'a str>,
}

pub struct NewTeammate<'a> {
    pub team_id: &'a str,
    pub caller_member_id: &'a str,
    pub conversation_id: &'a str,
    pub name: &'a str,
    pub workspace_mode: MemberWorkspaceMode,
    pub base_tree: Option<&'a str>,
}

pub struct NewDiscriminator<'a> {
    pub team_id: &'a str,
    pub caller_member_id: &'a str,
    pub conversation_id: &'a str,
    pub name: &'a str,
}

pub struct StartTeam<'a> {
    pub team_id: &'a str,
    pub leader_member_id: &'a str,
    pub goal: &'a str,
    pub acceptance_criteria: &'a [String],
    pub allowed_agent_ids: &'a [String],
    pub mode: TeamMode,
    pub max_teammates: u8,
    pub max_parallel_runs: u8,
    pub max_review_rounds: u8,
}

pub struct NewTeamTask<'a> {
    pub team_id: &'a str,
    pub creator_member_id: &'a str,
    pub title: &'a str,
    pub description: &'a str,
    pub dependencies: &'a [String],
    pub owned_paths: &'a [String],
    pub requires_plan_approval: bool,
    pub mutates_files: bool,
}

pub struct NewTeamProposal<'a> {
    pub team_id: &'a str,
    pub summary: &'a str,
    pub members_json: &'a str,
}

pub struct NewTeamPermissionRequest<'a> {
    pub id: &'a str,
    pub team_id: &'a str,
    pub member_id: &'a str,
    pub conversation_id: &'a str,
    pub run_id: &'a str,
    pub tool: &'a str,
    pub input_json: &'a str,
    pub options_json: &'a str,
}

pub(crate) fn sql_value_error(error: TeamError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

pub(crate) fn normalize_title(title: Option<&str>) -> String {
    title.unwrap_or_default().trim().to_owned()
}

pub(crate) fn normalized_name(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "teammate".to_owned()
    } else {
        name.to_owned()
    }
}

pub(crate) fn normalized_strings(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values.iter().map(|value| value.trim()) {
        if !value.is_empty() && !normalized.iter().any(|current| current == value) {
            normalized.push(value.to_owned());
        }
    }
    normalized
}

pub(crate) fn normalized_agent_ids(values: &[String]) -> Result<Vec<String>, TeamError> {
    let values = normalized_strings(values);
    if let Some(value) = values
        .iter()
        .find(|value| !matches!(value.as_str(), "claude_code" | "codex" | "opencode"))
    {
        return Err(TeamError::InvalidStoredValue(format!(
            "unsupported Agent ID: {value}"
        )));
    }
    Ok(values)
}

pub(crate) fn json_string_list(value: &str) -> Result<Vec<String>, TeamError> {
    serde_json::from_str(value).map_err(|error| TeamError::InvalidStoredValue(error.to_string()))
}

pub(crate) fn is_unique_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

pub(crate) fn ensure_column(
    database: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), TeamError> {
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

macro_rules! stored_enum {
    ($enum:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        impl $enum {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $value),+ }
            }

            pub(crate) fn parse(value: &str) -> Result<Self, TeamError> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(TeamError::InvalidStoredValue(value.to_owned())),
                }
            }
        }
    };
}

stored_enum!(TeamRole {
    Leader => "leader",
    Teammate => "teammate",
    Discriminator => "discriminator"
});
stored_enum!(MemberManagementPolicy { Ask => "ask", Auto => "auto" });
stored_enum!(TeamWorkspace { Shared => "shared", Worktree => "worktree" });
stored_enum!(MemberWorkspaceMode { Shared => "shared", Isolated => "isolated" });
stored_enum!(TeamMemberStatus {
    Starting => "starting",
    Configuring => "configuring",
    Queued => "queued",
    Idle => "idle",
    Working => "working",
    WaitingInput => "waiting_input",
    WaitingPermission => "waiting_permission",
    Failed => "failed",
    Stopped => "stopped",
    Removing => "removing",
    Removed => "removed",
});
stored_enum!(TeamStatus {
    Draft => "draft",
    Starting => "starting",
    Active => "active",
    Paused => "paused",
    Verifying => "verifying",
    NeedsAttention => "needs_attention",
    Completed => "completed",
    Archived => "archived",
    Disbanding => "disbanding",
    Removed => "removed"
});
stored_enum!(TeamMode { Standard => "standard", Yolo => "yolo" });
stored_enum!(DiscriminationStatus {
    Running => "running",
    Passed => "passed",
    Rejected => "rejected",
    Error => "error"
});
stored_enum!(TeamTaskAttemptStatus {
    Queued => "queued",
    Running => "running",
    NeedsReport => "needs_report",
    ResultSubmitted => "result_submitted",
    Completed => "completed",
    Failed => "failed",
    Cancelled => "cancelled"
});
stored_enum!(TeamTaskFailureKind {
    RateLimit => "rate_limit",
    Quota => "quota",
    Auth => "auth",
    PermissionDenied => "permission_denied",
    Process => "process",
    Protocol => "protocol",
    Timeout => "timeout",
    Interrupted => "interrupted",
    Unknown => "unknown"
});
stored_enum!(TeamTaskStatus {
    Pending => "pending",
    Blocked => "blocked",
    InProgress => "in_progress",
    PlanReview => "plan_review",
    ResultReview => "result_review",
    ChangesRequested => "changes_requested",
    Accepted => "accepted",
    Failed => "failed",
    Cancelled => "cancelled",
});
stored_enum!(TeamMessageKind {
    Direct => "direct",
    TaskAssigned => "task_assigned",
    PlanReady => "plan_ready",
    ResultReady => "result_ready",
    ChangesRequested => "changes_requested",
    System => "system",
});
stored_enum!(TeamMessageDeliveryStatus {
    Pending => "pending",
    Delivered => "delivered",
    Acknowledged => "acknowledged",
    Failed => "failed",
    Cancelled => "cancelled",
});
stored_enum!(TeamLifecycleOperationKind {
    Provisioning => "provisioning",
    ProviderCleanup => "provider_cleanup",
    Disband => "disband",
});
stored_enum!(TeamLifecycleOperationStatus {
    Pending => "pending",
    Running => "running",
    RetryScheduled => "retry_scheduled",
    Failed => "failed",
    Completed => "completed",
});
stored_enum!(TeamUserInputStatus {
    Pending => "pending",
    Resolved => "resolved",
});
stored_enum!(TeamProposalStatus {
    Pending => "pending",
    Approved => "approved",
    Rejected => "rejected",
});
stored_enum!(TeamPermissionStatus {
    PendingLeader => "pending_leader",
    WaitingUser => "waiting_user",
    Resolved => "resolved",
    Cancelled => "cancelled",
});
