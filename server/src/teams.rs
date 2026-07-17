use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const MAX_TEAMMATES: i64 = 8;

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
    #[error("only a Team discriminator may submit a verdict")]
    DiscriminatorRequired,
    #[error("a discriminator cannot perform concrete Team work")]
    DiscriminatorCannotWork,
    #[error("invalid stored team value: {0}")]
    InvalidStoredValue(String),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
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
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamStatus {
    Draft,
    Active,
    Verifying,
    NeedsAttention,
    Completed,
    Archived,
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

pub struct TeamStore {
    database: Mutex<Connection>,
}

impl TeamStore {
    pub fn open(database_path: impl AsRef<Path>) -> Result<Self, TeamError> {
        let database = Connection::open(database_path)?;
        database.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS teams (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               leader_member_id TEXT NOT NULL,
               agent_session_id TEXT NOT NULL,
               title TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'draft',
               workspace TEXT NOT NULL DEFAULT 'shared',
               workspace_path TEXT,
               member_management_policy TEXT NOT NULL DEFAULT 'ask',
               max_parallel_runs INTEGER NOT NULL DEFAULT 3,
               requested_mode TEXT NOT NULL DEFAULT 'standard',
               mode TEXT NOT NULL DEFAULT 'standard',
               mode_fallback_agent_id TEXT,
               mode_fallback_reason_code TEXT,
               mode_fallback_reason TEXT,
               mode_fallback_at TEXT,
               goal TEXT NOT NULL DEFAULT '',
               acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
               allowed_agent_ids_json TEXT NOT NULL DEFAULT '[\"claude_code\",\"codex\",\"opencode\"]',
               max_teammates INTEGER NOT NULL DEFAULT 3,
               max_review_rounds INTEGER NOT NULL DEFAULT 3,
               current_review_round INTEGER NOT NULL DEFAULT 0,
               workspace_fingerprint TEXT,
               final_summary TEXT,
               started_at TEXT,
               completed_at TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS team_members (
               id TEXT PRIMARY KEY,
               team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
               conversation_id TEXT NOT NULL UNIQUE,
               name TEXT NOT NULL,
               role TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'idle',
               workspace_mode TEXT NOT NULL DEFAULT 'shared',
               base_tree TEXT,
               permission_profile_applied INTEGER NOT NULL DEFAULT 0,
               previous_permission_mode TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               UNIQUE(team_id, name)
             );
             CREATE TABLE IF NOT EXISTS team_tasks (
               id TEXT PRIMARY KEY,
               team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
               creator_member_id TEXT NOT NULL REFERENCES team_members(id),
               assignee_member_id TEXT REFERENCES team_members(id),
               title TEXT NOT NULL,
               description TEXT NOT NULL,
               status TEXT NOT NULL,
               completion_required INTEGER NOT NULL DEFAULT 1,
               requires_plan_approval INTEGER NOT NULL DEFAULT 0,
               plan TEXT,
               mutates_files INTEGER NOT NULL DEFAULT 0,
               result TEXT,
               verification TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS team_task_dependencies (
               task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
               dependency_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
               PRIMARY KEY(task_id, dependency_id)
             );
             CREATE TABLE IF NOT EXISTS team_task_paths (
               task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
               path TEXT NOT NULL,
               PRIMARY KEY(task_id, path)
             );
             CREATE TABLE IF NOT EXISTS team_messages (
               id TEXT PRIMARY KEY,
               team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
               from_member_id TEXT NOT NULL REFERENCES team_members(id),
               to_member_id TEXT NOT NULL REFERENCES team_members(id),
               kind TEXT NOT NULL,
               task_id TEXT REFERENCES team_tasks(id),
               body TEXT NOT NULL,
               read_at TEXT,
               delivery_status TEXT NOT NULL DEFAULT 'pending',
               delivery_attempts INTEGER NOT NULL DEFAULT 0,
               delivered_at TEXT,
               last_error TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS team_proposals (
               id TEXT PRIMARY KEY,
               team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
               summary TEXT NOT NULL,
               members_json TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               resolved_at TEXT
             );
             CREATE TABLE IF NOT EXISTS team_activity_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
               member_id TEXT REFERENCES team_members(id) ON DELETE SET NULL,
               task_id TEXT REFERENCES team_tasks(id) ON DELETE SET NULL,
               kind TEXT NOT NULL,
               summary TEXT NOT NULL,
               metadata_json TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS team_permission_requests (
               id TEXT PRIMARY KEY,
               team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
               member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
               conversation_id TEXT NOT NULL,
               run_id TEXT NOT NULL,
               tool TEXT NOT NULL,
               input_json TEXT NOT NULL,
               options_json TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending_leader',
               selected_option_id TEXT,
               reason TEXT,
               decided_by TEXT,
               decided_by_member_id TEXT REFERENCES team_members(id) ON DELETE SET NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               resolved_at TEXT
             );
             CREATE TABLE IF NOT EXISTS team_discrimination_rounds (
               id TEXT PRIMARY KEY,
               team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
               discriminator_member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
               round INTEGER NOT NULL,
               workspace_fingerprint TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'running',
               verdict TEXT,
               evidence TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               resolved_at TEXT,
               UNIQUE(team_id, round)
             );
             CREATE TABLE IF NOT EXISTS team_task_attempts (
               id TEXT PRIMARY KEY,
               team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
               task_id TEXT NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
               member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
               run_id TEXT,
               status TEXT NOT NULL DEFAULT 'queued',
               failure_kind TEXT,
               error TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               completed_at TEXT
             );",
        )?;
        ensure_column(
            &database,
            "teams",
            "member_management_policy",
            "TEXT NOT NULL DEFAULT 'ask'",
        )?;
        ensure_column(&database, "team_tasks", "plan", "TEXT")?;
        ensure_column(
            &database,
            "teams",
            "max_parallel_runs",
            "INTEGER NOT NULL DEFAULT 3",
        )?;
        ensure_column(
            &database,
            "teams",
            "mode",
            "TEXT NOT NULL DEFAULT 'standard'",
        )?;
        ensure_column(&database, "teams", "goal", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(
            &database,
            "teams",
            "acceptance_criteria_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column(
            &database,
            "teams",
            "allowed_agent_ids_json",
            "TEXT NOT NULL DEFAULT '[\"claude_code\",\"codex\",\"opencode\"]'",
        )?;
        ensure_column(
            &database,
            "teams",
            "max_teammates",
            "INTEGER NOT NULL DEFAULT 3",
        )?;
        ensure_column(
            &database,
            "teams",
            "max_review_rounds",
            "INTEGER NOT NULL DEFAULT 3",
        )?;
        ensure_column(
            &database,
            "teams",
            "current_review_round",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &database,
            "teams",
            "requested_mode",
            "TEXT NOT NULL DEFAULT 'standard'",
        )?;
        ensure_column(&database, "teams", "mode_fallback_agent_id", "TEXT")?;
        ensure_column(&database, "teams", "mode_fallback_reason_code", "TEXT")?;
        ensure_column(&database, "teams", "mode_fallback_reason", "TEXT")?;
        ensure_column(&database, "teams", "mode_fallback_at", "TEXT")?;
        ensure_column(
            &database,
            "team_members",
            "permission_profile_applied",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &database,
            "team_members",
            "previous_permission_mode",
            "TEXT",
        )?;
        ensure_column(&database, "teams", "workspace_fingerprint", "TEXT")?;
        ensure_column(&database, "teams", "final_summary", "TEXT")?;
        ensure_column(&database, "teams", "started_at", "TEXT")?;
        ensure_column(&database, "teams", "completed_at", "TEXT")?;
        ensure_column(
            &database,
            "team_messages",
            "delivery_status",
            "TEXT NOT NULL DEFAULT 'pending'",
        )?;
        ensure_column(
            &database,
            "team_messages",
            "delivery_attempts",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&database, "team_messages", "delivered_at", "TEXT")?;
        ensure_column(&database, "team_messages", "last_error", "TEXT")?;
        ensure_column(
            &database,
            "team_tasks",
            "completion_required",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        database.execute(
            "UPDATE team_permission_requests
             SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP
             WHERE status IN ('pending_leader', 'waiting_user')",
            [],
        )?;
        database.execute(
            "UPDATE teams SET mode = CASE WHEN mode IS NULL OR mode = '' THEN 'standard' ELSE mode END,
                 requested_mode = CASE
                   WHEN requested_mode IS NULL OR requested_mode = '' THEN mode
                   WHEN requested_mode = 'standard' AND mode = 'yolo'
                     AND mode_fallback_reason_code IS NULL THEN mode
                   ELSE requested_mode
                 END,
                 max_teammates = MIN(8, MAX(max_teammates, (
                   SELECT COUNT(*) FROM team_members
                   WHERE team_members.team_id = teams.id AND role = 'teammate'
                 )))",
            [],
        )?;
        Ok(Self {
            database: Mutex::new(database),
        })
    }

    pub fn create_team(&self, input: NewTeam<'_>) -> Result<Team, TeamError> {
        let team_id = Uuid::new_v4().to_string();
        let leader_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        transaction.execute(
            "INSERT INTO teams
             (id, project_id, leader_member_id, agent_session_id, title, status, workspace, workspace_path)
             VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7)",
            params![
                team_id,
                input.project_id,
                leader_id,
                input.agent_session_id,
                normalize_title(input.title),
                input.workspace.as_str(),
                input.workspace_path,
            ],
        )?;
        transaction.execute(
            "INSERT INTO team_members
             (id, team_id, conversation_id, name, role, status, workspace_mode)
             VALUES (?1, ?2, ?3, ?4, 'leader', 'idle', 'shared')",
            params![
                leader_id,
                team_id,
                input.leader_conversation_id,
                normalized_name(input.leader_name),
            ],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_team(&team_id)
    }

    pub fn get_team(&self, team_id: &str) -> Result<Team, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, project_id, leader_member_id, agent_session_id, title, status,
                        workspace, workspace_path, member_management_policy, max_parallel_runs,
                        requested_mode, mode, mode_fallback_agent_id,
                        mode_fallback_reason_code, mode_fallback_reason, mode_fallback_at,
                        goal, acceptance_criteria_json, allowed_agent_ids_json,
                        max_teammates, max_review_rounds, current_review_round,
                        workspace_fingerprint, final_summary, started_at, completed_at,
                        created_at, updated_at
                 FROM teams WHERE id = ?1",
                [team_id],
                team_from_row,
            )
            .optional()?
            .ok_or_else(|| TeamError::TeamNotFound(team_id.to_owned()))
    }

    pub fn update_team_settings(
        &self,
        team_id: &str,
        policy: MemberManagementPolicy,
        max_parallel_runs: u8,
    ) -> Result<Team, TeamError> {
        if !(1..=MAX_TEAMMATES as u8).contains(&max_parallel_runs) {
            return Err(TeamError::InvalidConcurrency);
        }
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE teams SET member_management_policy = ?2, max_parallel_runs = ?3,
                 updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![team_id, policy.as_str(), max_parallel_runs],
            )?;
        if changed == 0 {
            return Err(TeamError::TeamNotFound(team_id.to_owned()));
        }
        self.get_team(team_id)
    }

    pub fn start_team(&self, input: StartTeam<'_>) -> Result<Team, TeamError> {
        let goal = input.goal.trim();
        if goal.is_empty() {
            return Err(TeamError::GoalRequired);
        }
        let acceptance_criteria = normalized_strings(input.acceptance_criteria);
        if acceptance_criteria.is_empty() {
            return Err(TeamError::AcceptanceCriteriaRequired);
        }
        let allowed_agent_ids = normalized_agent_ids(input.allowed_agent_ids)?;
        if allowed_agent_ids.is_empty() {
            return Err(TeamError::AllowedAgentsRequired);
        }
        if !(1..=MAX_TEAMMATES as u8).contains(&input.max_teammates) {
            return Err(TeamError::InvalidMemberLimit);
        }
        if !(1..=input.max_teammates).contains(&input.max_parallel_runs) {
            return Err(TeamError::InvalidConcurrency);
        }
        if !(1..=10).contains(&input.max_review_rounds) {
            return Err(TeamError::InvalidReviewRounds);
        }
        let criteria_json = serde_json::to_string(&acceptance_criteria)
            .map_err(|error| TeamError::InvalidStoredValue(error.to_string()))?;
        let agents_json = serde_json::to_string(&allowed_agent_ids)
            .map_err(|error| TeamError::InvalidStoredValue(error.to_string()))?;
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        require_leader(&transaction, input.team_id, input.leader_member_id)?;
        let changed = transaction.execute(
            "UPDATE teams SET status = 'active', requested_mode = ?3, mode = ?3,
                    mode_fallback_agent_id = NULL, mode_fallback_reason_code = NULL,
                    mode_fallback_reason = NULL, mode_fallback_at = NULL, goal = ?4,
                    acceptance_criteria_json = ?5, allowed_agent_ids_json = ?6,
                    max_teammates = ?7, max_parallel_runs = ?8, max_review_rounds = ?9,
                    current_review_round = CASE WHEN status = 'draft' THEN 0 ELSE current_review_round END,
                    workspace_fingerprint = NULL,
                    final_summary = NULL, started_at = CURRENT_TIMESTAMP, completed_at = NULL,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status IN ('draft', 'needs_attention')
               AND (status = 'draft' OR ?9 > current_review_round)",
            params![
                input.team_id,
                input.leader_member_id,
                input.mode.as_str(),
                goal,
                criteria_json,
                agents_json,
                input.max_teammates,
                input.max_parallel_runs,
                input.max_review_rounds,
            ],
        )?;
        if changed == 0 {
            return Err(TeamError::InvalidTeamState);
        }
        transaction.commit()?;
        drop(database);
        self.get_team(input.team_id)
    }

    pub fn downgrade_to_standard(
        &self,
        team_id: &str,
        agent_id: &str,
        reason_code: &str,
        reason: &str,
    ) -> Result<Team, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE teams SET mode = 'standard', mode_fallback_agent_id = ?2,
                        mode_fallback_reason_code = ?3, mode_fallback_reason = ?4,
                        mode_fallback_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND requested_mode = 'yolo'",
                params![team_id, agent_id, reason_code, reason.trim()],
            )?;
        if changed == 0 {
            return Err(TeamError::InvalidTeamState);
        }
        self.get_team(team_id)
    }

    pub fn abort_start(&self, team_id: &str) -> Result<Team, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE teams SET status = 'draft', requested_mode = 'standard',
                        mode = 'standard', mode_fallback_agent_id = NULL,
                        mode_fallback_reason_code = NULL, mode_fallback_reason = NULL,
                        mode_fallback_at = NULL, started_at = NULL,
                        updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status = 'active'",
                [team_id],
            )?;
        if changed == 0 {
            return Err(TeamError::InvalidTeamState);
        }
        self.get_team(team_id)
    }

    pub fn mark_permission_profile_applied(
        &self,
        member_id: &str,
        previous_mode: Option<&str>,
    ) -> Result<TeamMember, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_members SET permission_profile_applied = 1,
                        previous_permission_mode = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![member_id, previous_mode],
            )?;
        if changed == 0 {
            return Err(TeamError::MemberNotFound(member_id.to_owned()));
        }
        self.get_member(member_id)
    }

    pub fn clear_permission_profile(&self, member_id: &str) -> Result<TeamMember, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_members SET permission_profile_applied = 0,
                        previous_permission_mode = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                [member_id],
            )?;
        if changed == 0 {
            return Err(TeamError::MemberNotFound(member_id.to_owned()));
        }
        self.get_member(member_id)
    }

    pub fn remove_discriminators(&self, team_id: &str) -> Result<Vec<TeamMember>, TeamError> {
        let discriminators = self
            .list_members(team_id)?
            .into_iter()
            .filter(|member| member.role == TeamRole::Discriminator)
            .collect::<Vec<_>>();
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "DELETE FROM team_members WHERE team_id = ?1 AND role = 'discriminator'",
                [team_id],
            )?;
        Ok(discriminators)
    }

    pub fn complete_team(
        &self,
        team_id: &str,
        leader_member_id: &str,
        final_summary: &str,
        workspace_fingerprint: &str,
    ) -> Result<Team, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        require_leader(&transaction, team_id, leader_member_id)?;
        let (mode, status, required, accepted): (String, String, i64, i64) =
            transaction.query_row(
                "SELECT mode, status,
                    (SELECT COUNT(*) FROM team_tasks WHERE team_id = teams.id AND completion_required = 1),
                    (SELECT COUNT(*) FROM team_tasks WHERE team_id = teams.id
                     AND completion_required = 1 AND status = 'accepted')
                 FROM teams WHERE id = ?1",
                [team_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        if status != "active" || required == 0 || required != accepted {
            return Err(TeamError::CompletionBlocked);
        }
        let unresolved: i64 = transaction.query_row(
            "SELECT
               (SELECT COUNT(*) FROM team_permission_requests
                WHERE team_id = ?1 AND status IN ('pending_leader', 'waiting_user'))
               + (SELECT COUNT(*) FROM team_messages
                  WHERE team_id = ?1 AND delivery_status IN ('pending', 'failed'))",
            [team_id],
            |row| row.get(0),
        )?;
        if unresolved != 0 {
            return Err(TeamError::CompletionBlocked);
        }
        if mode == TeamMode::Yolo.as_str() {
            let passed = transaction
                .query_row(
                    "SELECT workspace_fingerprint FROM team_discrimination_rounds
                     WHERE team_id = ?1 AND status = 'passed'
                     ORDER BY round DESC LIMIT 1",
                    [team_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if passed.as_deref() != Some(workspace_fingerprint) {
                return Err(TeamError::CompletionBlocked);
            }
        }
        transaction.execute(
            "UPDATE teams SET status = 'completed', final_summary = ?2,
                    workspace_fingerprint = ?3, completed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![team_id, final_summary.trim(), workspace_fingerprint],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_team(team_id)
    }

    pub fn list_teams(&self, project_id: &str) -> Result<Vec<Team>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, project_id, leader_member_id, agent_session_id, title, status,
                    workspace, workspace_path, member_management_policy, max_parallel_runs,
                    requested_mode, mode, mode_fallback_agent_id,
                    mode_fallback_reason_code, mode_fallback_reason, mode_fallback_at,
                    goal, acceptance_criteria_json, allowed_agent_ids_json,
                    max_teammates, max_review_rounds, current_review_round,
                    workspace_fingerprint, final_summary, started_at, completed_at,
                    created_at, updated_at
             FROM teams WHERE project_id = ?1 ORDER BY updated_at DESC, id",
        )?;
        statement
            .query_map([project_id], team_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn delete_team(&self, team_id: &str) -> Result<(), TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute("DELETE FROM teams WHERE id = ?1", [team_id])?;
        if changed == 0 {
            return Err(TeamError::TeamNotFound(team_id.to_owned()));
        }
        Ok(())
    }

    pub fn team_for_conversation(&self, conversation_id: &str) -> Result<Option<Team>, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT t.id, t.project_id, t.leader_member_id, t.agent_session_id, t.title,
                        t.status, t.workspace, t.workspace_path, t.member_management_policy,
                        t.max_parallel_runs, t.requested_mode, t.mode,
                        t.mode_fallback_agent_id, t.mode_fallback_reason_code,
                        t.mode_fallback_reason, t.mode_fallback_at,
                        t.goal, t.acceptance_criteria_json,
                        t.allowed_agent_ids_json, t.max_teammates, t.max_review_rounds,
                        t.current_review_round, t.workspace_fingerprint, t.final_summary,
                        t.started_at, t.completed_at, t.created_at, t.updated_at
                 FROM teams t JOIN team_members m ON m.team_id = t.id
                 WHERE m.conversation_id = ?1",
                [conversation_id],
                team_from_row,
            )
            .optional()
            .map_err(TeamError::from)
    }

    pub fn list_members(&self, team_id: &str) -> Result<Vec<TeamMember>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, conversation_id, name, role, status, workspace_mode,
                    base_tree, permission_profile_applied, previous_permission_mode,
                    created_at, updated_at
             FROM team_members WHERE team_id = ?1
             ORDER BY CASE role WHEN 'leader' THEN 0 ELSE 1 END, created_at, id",
        )?;
        statement
            .query_map([team_id], team_member_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn add_teammate(&self, input: NewTeammate<'_>) -> Result<TeamMember, TeamError> {
        let normalized_name = normalized_name(input.name);
        let member_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        require_leader(&transaction, input.team_id, input.caller_member_id)?;
        let max_teammates: i64 = transaction.query_row(
            "SELECT max_teammates FROM teams WHERE id = ?1",
            [input.team_id],
            |row| row.get(0),
        )?;
        let teammates: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM team_members WHERE team_id = ?1 AND role = 'teammate'",
            [input.team_id],
            |row| row.get(0),
        )?;
        if teammates >= max_teammates {
            return Err(TeamError::MemberLimit);
        }
        let inserted = transaction.execute(
            "INSERT INTO team_members
             (id, team_id, conversation_id, name, role, status, workspace_mode, base_tree)
             VALUES (?1, ?2, ?3, ?4, 'teammate', 'idle', ?5, ?6)",
            params![
                member_id,
                input.team_id,
                input.conversation_id,
                normalized_name,
                input.workspace_mode.as_str(),
                input.base_tree,
            ],
        );
        if let Err(error) = inserted {
            return if is_unique_violation(&error) {
                Err(TeamError::DuplicateMemberName(normalized_name))
            } else {
                Err(error.into())
            };
        }
        transaction.commit()?;
        drop(database);
        self.get_member(&member_id)
    }

    pub fn add_discriminator(&self, input: NewDiscriminator<'_>) -> Result<TeamMember, TeamError> {
        let member_id = Uuid::new_v4().to_string();
        let normalized_name = normalized_name(input.name);
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        require_leader(&transaction, input.team_id, input.caller_member_id)?;
        let (mode, status): (String, String) = transaction.query_row(
            "SELECT mode, status FROM teams WHERE id = ?1",
            [input.team_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if mode != TeamMode::Yolo.as_str() || status != TeamStatus::Active.as_str() {
            return Err(TeamError::InvalidTeamState);
        }
        transaction.execute(
            "DELETE FROM team_members WHERE team_id = ?1 AND role = 'discriminator'",
            [input.team_id],
        )?;
        transaction.execute(
            "INSERT INTO team_members
             (id, team_id, conversation_id, name, role, status, workspace_mode)
             VALUES (?1, ?2, ?3, ?4, 'discriminator', 'idle', 'shared')",
            params![
                member_id,
                input.team_id,
                input.conversation_id,
                normalized_name
            ],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_member(&member_id)
    }

    pub fn get_member(&self, member_id: &str) -> Result<TeamMember, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, conversation_id, name, role, status, workspace_mode,
                        base_tree, permission_profile_applied, previous_permission_mode,
                        created_at, updated_at
                 FROM team_members WHERE id = ?1",
                [member_id],
                team_member_from_row,
            )
            .optional()?
            .ok_or_else(|| TeamError::MemberNotFound(member_id.to_owned()))
    }

    pub fn member_for_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Option<TeamMember>, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, conversation_id, name, role, status, workspace_mode,
                        base_tree, permission_profile_applied, previous_permission_mode,
                        created_at, updated_at
                 FROM team_members WHERE conversation_id = ?1",
                [conversation_id],
                team_member_from_row,
            )
            .optional()
            .map_err(TeamError::from)
    }

    pub fn set_member_status(
        &self,
        member_id: &str,
        status: TeamMemberStatus,
    ) -> Result<TeamMember, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_members SET status = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![member_id, status.as_str()],
            )?;
        if changed == 0 {
            return Err(TeamError::MemberNotFound(member_id.to_owned()));
        }
        self.get_member(member_id)
    }

    pub fn remove_teammate(
        &self,
        team_id: &str,
        caller_member_id: &str,
        teammate_id: &str,
    ) -> Result<(), TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        require_leader(&transaction, team_id, caller_member_id)?;
        match member_role(&transaction, team_id, teammate_id)? {
            TeamRole::Leader => return Err(TeamError::LeaderCannotBeRemoved),
            TeamRole::Discriminator => return Err(TeamError::DiscriminatorCannotWork),
            TeamRole::Teammate => {}
        }
        transaction.execute(
            "DELETE FROM team_messages WHERE from_member_id = ?1 OR to_member_id = ?1",
            [teammate_id],
        )?;
        transaction.execute(
            "UPDATE team_tasks
             SET creator_member_id = ?2, updated_at = CURRENT_TIMESTAMP
             WHERE creator_member_id = ?1",
            params![teammate_id, caller_member_id],
        )?;
        transaction.execute(
            "UPDATE team_tasks
             SET assignee_member_id = NULL,
                 status = CASE
                   WHEN status IN ('in_progress', 'plan_review', 'result_review',
                                   'changes_requested', 'failed') THEN 'pending'
                   ELSE status
                 END,
                 result = CASE
                   WHEN status IN ('in_progress', 'plan_review', 'result_review',
                                   'changes_requested', 'failed') THEN NULL
                   ELSE result
                 END,
                 verification = CASE
                   WHEN status IN ('in_progress', 'plan_review', 'result_review',
                                   'changes_requested', 'failed') THEN NULL
                   ELSE verification
                 END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE assignee_member_id = ?1",
            [teammate_id],
        )?;
        transaction.execute("DELETE FROM team_members WHERE id = ?1", [teammate_id])?;
        transaction.execute(
            "UPDATE teams SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [team_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn create_task(&self, input: NewTeamTask<'_>) -> Result<TeamTask, TeamError> {
        let task_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        require_leader(&transaction, input.team_id, input.creator_member_id)?;
        validate_dependencies(&transaction, input.team_id, input.dependencies)?;
        let status = if input.dependencies.is_empty() {
            TeamTaskStatus::Pending
        } else {
            TeamTaskStatus::Blocked
        };
        transaction.execute(
            "INSERT INTO team_tasks
             (id, team_id, creator_member_id, title, description, status,
              requires_plan_approval, mutates_files)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                task_id,
                input.team_id,
                input.creator_member_id,
                input.title.trim(),
                input.description.trim(),
                status.as_str(),
                input.requires_plan_approval,
                input.mutates_files,
            ],
        )?;
        for dependency in input.dependencies {
            transaction.execute(
                "INSERT INTO team_task_dependencies (task_id, dependency_id) VALUES (?1, ?2)",
                params![task_id, dependency],
            )?;
        }
        for path in input.owned_paths {
            transaction.execute(
                "INSERT INTO team_task_paths (task_id, path) VALUES (?1, ?2)",
                params![task_id, path.trim()],
            )?;
        }
        transaction.commit()?;
        drop(database);
        self.get_task(&task_id)
    }

    pub fn delegate_task(
        &self,
        task_id: &str,
        leader_member_id: &str,
        assignee_member_id: &str,
    ) -> Result<TeamTask, TeamError> {
        let message_id = Uuid::new_v4().to_string();
        let attempt_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        let team_id = task_team_id(&transaction, task_id)?;
        require_leader(&transaction, &team_id, leader_member_id)?;
        require_teammate(&transaction, &team_id, assignee_member_id)?;
        let changed = transaction.execute(
            "UPDATE team_tasks SET assignee_member_id = ?2, status = 'in_progress',
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status = 'pending'",
            params![task_id, assignee_member_id],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskUnavailable);
        }
        let title: String = transaction.query_row(
            "SELECT title FROM team_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO team_messages
             (id, team_id, from_member_id, to_member_id, kind, task_id, body)
             VALUES (?1, ?2, ?3, ?4, 'task_assigned', ?5, ?6)",
            params![
                message_id,
                team_id,
                leader_member_id,
                assignee_member_id,
                task_id,
                format!("Assigned task: {title}"),
            ],
        )?;
        transaction.execute(
            "INSERT INTO team_task_attempts
             (id, team_id, task_id, member_id, status)
             VALUES (?1, ?2, ?3, ?4, 'queued')",
            params![attempt_id, team_id, task_id, assignee_member_id],
        )?;
        transaction.execute(
            "UPDATE teams SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [&team_id],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_task(task_id)
    }

    pub fn list_tasks(&self, team_id: &str) -> Result<Vec<TeamTask>, TeamError> {
        let task_ids = {
            let database = self.database.lock().expect("team database mutex poisoned");
            let mut statement = database
                .prepare("SELECT id FROM team_tasks WHERE team_id = ?1 ORDER BY created_at, id")?;
            statement
                .query_map([team_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        task_ids
            .iter()
            .map(|id| self.get_task(id))
            .collect::<Result<Vec<_>, _>>()
    }

    pub fn send_message(
        &self,
        team_id: &str,
        from_member_id: &str,
        to_member_id: &str,
        kind: TeamMessageKind,
        task_id: Option<&str>,
        body: &str,
    ) -> Result<TeamMessage, TeamError> {
        let message_id = Uuid::new_v4().to_string();
        let database = self.database.lock().expect("team database mutex poisoned");
        require_team_member(&database, team_id, from_member_id)?;
        require_team_member(&database, team_id, to_member_id)?;
        if let Some(task_id) = task_id {
            let task_team = database
                .query_row(
                    "SELECT team_id FROM team_tasks WHERE id = ?1",
                    [task_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| TeamError::TaskNotFound(task_id.to_owned()))?;
            if task_team != team_id {
                return Err(TeamError::WrongTeam);
            }
        }
        database.execute(
            "INSERT INTO team_messages
             (id, team_id, from_member_id, to_member_id, kind, task_id, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                message_id,
                team_id,
                from_member_id,
                to_member_id,
                kind.as_str(),
                task_id,
                body.trim(),
            ],
        )?;
        database
            .query_row(
                "SELECT id, team_id, from_member_id, to_member_id, kind, task_id,
                        body, read_at, delivery_status, delivery_attempts, delivered_at,
                        last_error, created_at
                 FROM team_messages WHERE id = ?1",
                [message_id],
                team_message_from_row,
            )
            .map_err(TeamError::from)
    }

    pub fn unread_messages(&self, member_id: &str) -> Result<Vec<TeamMessage>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, from_member_id, to_member_id, kind, task_id,
                    body, read_at, delivery_status, delivery_attempts, delivered_at,
                    last_error, created_at
             FROM team_messages
             WHERE to_member_id = ?1 AND read_at IS NULL
             ORDER BY created_at, id",
        )?;
        statement
            .query_map([member_id], team_message_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn read_messages(&self, member_id: &str) -> Result<Vec<TeamMessage>, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        let messages = {
            let mut statement = transaction.prepare(
                "SELECT id, team_id, from_member_id, to_member_id, kind, task_id,
                        body, read_at, delivery_status, delivery_attempts, delivered_at,
                        last_error, created_at
                 FROM team_messages
                 WHERE to_member_id = ?1 AND read_at IS NULL
                 ORDER BY created_at, id",
            )?;
            statement
                .query_map([member_id], team_message_from_row)?
                .collect::<Result<Vec<_>, _>>()?
        };
        transaction.execute(
            "UPDATE team_messages SET read_at = CURRENT_TIMESTAMP,
             delivery_status = 'acknowledged'
             WHERE to_member_id = ?1 AND read_at IS NULL",
            [member_id],
        )?;
        transaction.commit()?;
        Ok(messages)
    }

    pub fn pending_messages(&self, member_id: &str) -> Result<Vec<TeamMessage>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, from_member_id, to_member_id, kind, task_id,
                    body, read_at, delivery_status, delivery_attempts, delivered_at,
                    last_error, created_at
             FROM team_messages
             WHERE to_member_id = ?1 AND delivery_status IN ('pending', 'failed')
                   AND delivery_attempts < 3
             ORDER BY created_at, id",
        )?;
        statement
            .query_map([member_id], team_message_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn mark_message_delivered(&self, message_id: &str) -> Result<(), TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_messages
                 SET delivery_status = 'delivered', delivered_at = CURRENT_TIMESTAMP,
                     delivery_attempts = delivery_attempts + 1, last_error = NULL
                 WHERE id = ?1",
                [message_id],
            )?;
        Ok(())
    }

    pub fn mark_message_failed(&self, message_id: &str, error: &str) -> Result<(), TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_messages
                 SET delivery_status = 'failed', delivery_attempts = delivery_attempts + 1,
                     last_error = ?2 WHERE id = ?1",
                params![message_id, error],
            )?;
        Ok(())
    }

    pub fn mark_messages_read(&self, member_id: &str) -> Result<usize, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_messages SET read_at = CURRENT_TIMESTAMP,
                 delivery_status = 'acknowledged'
                 WHERE to_member_id = ?1 AND read_at IS NULL",
                [member_id],
            )
            .map_err(TeamError::from)
    }

    pub fn create_proposal(&self, input: NewTeamProposal<'_>) -> Result<TeamProposal, TeamError> {
        self.get_team(input.team_id)?;
        let proposal_id = Uuid::new_v4().to_string();
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "INSERT INTO team_proposals (id, team_id, summary, members_json)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    proposal_id,
                    input.team_id,
                    input.summary.trim(),
                    input.members_json,
                ],
            )?;
        self.get_proposal(&proposal_id)
    }

    pub fn resolve_proposal(
        &self,
        team_id: &str,
        proposal_id: &str,
        status: TeamProposalStatus,
    ) -> Result<TeamProposal, TeamError> {
        if status == TeamProposalStatus::Pending {
            return Err(TeamError::InvalidProposalDecision);
        }
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_proposals SET status = ?2, resolved_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND team_id = ?3 AND status = 'pending'",
                params![proposal_id, status.as_str(), team_id],
            )?;
        if changed == 0 {
            let proposal = self.get_proposal(proposal_id)?;
            return if proposal.team_id == team_id {
                Err(TeamError::ProposalNotFound(proposal_id.to_owned()))
            } else {
                Err(TeamError::WrongTeam)
            };
        }
        self.get_proposal(proposal_id)
    }

    pub fn latest_proposal(&self, team_id: &str) -> Result<Option<TeamProposal>, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, summary, members_json, status, created_at, resolved_at
                 FROM team_proposals WHERE team_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
                [team_id],
                team_proposal_from_row,
            )
            .optional()
            .map_err(TeamError::from)
    }

    pub fn create_permission_request(
        &self,
        input: NewTeamPermissionRequest<'_>,
    ) -> Result<TeamPermissionRequest, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        require_team_member(&database, input.team_id, input.member_id)?;
        database.execute(
            "INSERT INTO team_permission_requests
             (id, team_id, member_id, conversation_id, run_id, tool, input_json, options_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                input.id,
                input.team_id,
                input.member_id,
                input.conversation_id,
                input.run_id,
                input.tool,
                input.input_json,
                input.options_json,
            ],
        )?;
        drop(database);
        self.get_permission_request(input.id)
    }

    pub fn pending_permission_requests(
        &self,
        team_id: &str,
    ) -> Result<Vec<TeamPermissionRequest>, TeamError> {
        self.get_team(team_id)?;
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, member_id, conversation_id, run_id, tool, input_json,
                    options_json, status, selected_option_id, reason, decided_by,
                    decided_by_member_id, created_at, resolved_at
             FROM team_permission_requests
             WHERE team_id = ?1 AND status IN ('pending_leader', 'waiting_user')
             ORDER BY created_at, id",
        )?;
        statement
            .query_map([team_id], team_permission_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn resolve_permission_as_leader(
        &self,
        request_id: &str,
        leader_member_id: &str,
        option_id: &str,
        reason: Option<&str>,
    ) -> Result<TeamPermissionRequest, TeamError> {
        self.update_permission_request(
            request_id,
            Some(leader_member_id),
            TeamPermissionStatus::Resolved,
            Some(option_id),
            reason,
            "leader",
        )
    }

    pub fn escalate_permission(
        &self,
        request_id: &str,
        leader_member_id: &str,
        reason: Option<&str>,
    ) -> Result<TeamPermissionRequest, TeamError> {
        self.update_permission_request(
            request_id,
            Some(leader_member_id),
            TeamPermissionStatus::WaitingUser,
            None,
            reason,
            "leader",
        )
    }

    pub fn resolve_permission_as_user(
        &self,
        request_id: &str,
        option_id: &str,
    ) -> Result<Option<TeamPermissionRequest>, TeamError> {
        let request = match self.get_permission_request(request_id) {
            Ok(request) => request,
            Err(TeamError::PermissionNotFound(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        if request.status != TeamPermissionStatus::WaitingUser {
            return Err(TeamError::PermissionNotPending);
        }
        validate_permission_option(&request, option_id)?;
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_permission_requests
                 SET status = 'resolved', selected_option_id = ?2, decided_by = 'user',
                     resolved_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status = 'waiting_user'",
                params![request_id, option_id],
            )?;
        if changed == 0 {
            return Err(TeamError::PermissionNotPending);
        }
        self.get_permission_request(request_id).map(Some)
    }

    pub fn cancel_permission_request(
        &self,
        request_id: &str,
    ) -> Result<Option<TeamPermissionRequest>, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_permission_requests
                 SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status IN ('pending_leader', 'waiting_user')",
                [request_id],
            )?;
        if changed == 0 {
            return match self.get_permission_request(request_id) {
                Ok(request) => Ok(Some(request)),
                Err(TeamError::PermissionNotFound(_)) => Ok(None),
                Err(error) => Err(error),
            };
        }
        self.get_permission_request(request_id).map(Some)
    }

    pub fn get_permission_request(
        &self,
        request_id: &str,
    ) -> Result<TeamPermissionRequest, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, member_id, conversation_id, run_id, tool, input_json,
                        options_json, status, selected_option_id, reason, decided_by,
                        decided_by_member_id, created_at, resolved_at
                 FROM team_permission_requests WHERE id = ?1",
                [request_id],
                team_permission_from_row,
            )
            .optional()?
            .ok_or_else(|| TeamError::PermissionNotFound(request_id.to_owned()))
    }

    fn update_permission_request(
        &self,
        request_id: &str,
        leader_member_id: Option<&str>,
        status: TeamPermissionStatus,
        option_id: Option<&str>,
        reason: Option<&str>,
        decided_by: &str,
    ) -> Result<TeamPermissionRequest, TeamError> {
        let request = self.get_permission_request(request_id)?;
        if request.status != TeamPermissionStatus::PendingLeader {
            return Err(TeamError::PermissionNotPending);
        }
        let leader_member_id = leader_member_id.ok_or(TeamError::LeaderRequired)?;
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        require_leader(&transaction, &request.team_id, leader_member_id)?;
        if let Some(option_id) = option_id {
            validate_permission_option(&request, option_id)?;
        }
        transaction.execute(
            "UPDATE team_permission_requests
             SET status = ?2, selected_option_id = ?3, reason = ?4, decided_by = ?5,
                 decided_by_member_id = ?6,
                 resolved_at = CASE WHEN ?2 = 'resolved' THEN CURRENT_TIMESTAMP ELSE NULL END
             WHERE id = ?1 AND status = 'pending_leader'",
            params![
                request_id,
                status.as_str(),
                option_id,
                reason.map(str::trim).filter(|value| !value.is_empty()),
                decided_by,
                leader_member_id,
            ],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_permission_request(request_id)
    }

    pub fn append_activity(
        &self,
        team_id: &str,
        member_id: Option<&str>,
        task_id: Option<&str>,
        kind: &str,
        summary: &str,
        metadata_json: Option<&str>,
    ) -> Result<TeamActivity, TeamError> {
        self.get_team(team_id)?;
        let database = self.database.lock().expect("team database mutex poisoned");
        database.execute(
            "INSERT INTO team_activity_events
             (team_id, member_id, task_id, kind, summary, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                team_id,
                member_id,
                task_id,
                kind,
                summary.trim(),
                metadata_json
            ],
        )?;
        let id = database.last_insert_rowid();
        database
            .query_row(
                "SELECT id, team_id, member_id, task_id, kind, summary, metadata_json, created_at
                 FROM team_activity_events WHERE id = ?1",
                [id],
                team_activity_from_row,
            )
            .map_err(TeamError::from)
    }

    pub fn list_activity(&self, team_id: &str, limit: u16) -> Result<Vec<TeamActivity>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, member_id, task_id, kind, summary, metadata_json, created_at
             FROM team_activity_events WHERE team_id = ?1
             ORDER BY id DESC LIMIT ?2",
        )?;
        statement
            .query_map(
                params![team_id, limit.clamp(1, 200)],
                team_activity_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    fn get_proposal(&self, proposal_id: &str) -> Result<TeamProposal, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, summary, members_json, status, created_at, resolved_at
                 FROM team_proposals WHERE id = ?1",
                [proposal_id],
                team_proposal_from_row,
            )
            .optional()?
            .ok_or_else(|| TeamError::ProposalNotFound(proposal_id.to_owned()))
    }

    pub fn claim_task(&self, task_id: &str, member_id: &str) -> Result<TeamTask, TeamError> {
        let attempt_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        let team_id = task_team_id(&transaction, task_id)?;
        require_teammate(&transaction, &team_id, member_id)?;
        let changed = transaction.execute(
            "UPDATE team_tasks SET assignee_member_id = ?2, status = 'in_progress',
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status = 'pending' AND assignee_member_id IS NULL",
            params![task_id, member_id],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskUnavailable);
        }
        transaction.execute(
            "INSERT INTO team_task_attempts
             (id, team_id, task_id, member_id, status)
             VALUES (?1, ?2, ?3, ?4, 'running')",
            params![attempt_id, team_id, task_id, member_id],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_task(task_id)
    }

    pub fn submit_result(
        &self,
        task_id: &str,
        member_id: &str,
        result: &str,
        verification: &str,
    ) -> Result<TeamTask, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let changed = database.execute(
            "UPDATE team_tasks SET status = 'result_review', result = ?3, verification = ?4,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND assignee_member_id = ?2 AND status IN ('in_progress', 'changes_requested')",
            params![task_id, member_id, result.trim(), verification.trim()],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskNotAssigned);
        }
        database.execute(
            "UPDATE team_task_attempts SET status = 'result_submitted',
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = (
               SELECT id FROM team_task_attempts
               WHERE task_id = ?1 AND member_id = ?2
                 AND status IN ('queued', 'running', 'needs_report')
               ORDER BY created_at DESC, id DESC LIMIT 1
             )",
            params![task_id, member_id],
        )?;
        drop(database);
        self.get_task(task_id)
    }

    pub fn submit_plan(
        &self,
        task_id: &str,
        member_id: &str,
        plan: &str,
    ) -> Result<TeamTask, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let changed = database.execute(
            "UPDATE team_tasks SET status = 'plan_review', plan = ?3,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND assignee_member_id = ?2
               AND requires_plan_approval = 1 AND status = 'in_progress'",
            params![task_id, member_id, plan.trim()],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskNotAssigned);
        }
        drop(database);
        self.get_task(task_id)
    }

    pub fn review_plan(
        &self,
        task_id: &str,
        leader_member_id: &str,
        accept: bool,
        feedback: Option<&str>,
    ) -> Result<TeamTask, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        let team_id = task_team_id(&transaction, task_id)?;
        require_leader(&transaction, &team_id, leader_member_id)?;
        let next_status = if accept {
            TeamTaskStatus::InProgress
        } else {
            TeamTaskStatus::ChangesRequested
        };
        let changed = transaction.execute(
            "UPDATE team_tasks SET status = ?2,
                    result = CASE WHEN ?3 IS NULL THEN result ELSE ?3 END,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status = 'plan_review'",
            params![task_id, next_status.as_str(), feedback.map(str::trim)],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskUnavailable);
        }
        transaction.commit()?;
        drop(database);
        self.get_task(task_id)
    }

    pub fn review_result(
        &self,
        task_id: &str,
        leader_member_id: &str,
        accept: bool,
        feedback: Option<&str>,
    ) -> Result<TeamTask, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        let team_id = task_team_id(&transaction, task_id)?;
        require_leader(&transaction, &team_id, leader_member_id)?;
        let status = if accept {
            TeamTaskStatus::Accepted
        } else {
            TeamTaskStatus::ChangesRequested
        };
        let result = if accept {
            None
        } else {
            feedback.map(str::trim)
        };
        let changed = transaction.execute(
            "UPDATE team_tasks SET status = ?2,
                    result = CASE WHEN ?3 IS NULL THEN result ELSE ?3 END,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status = 'result_review'",
            params![task_id, status.as_str(), result],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskUnavailable);
        }
        if accept {
            unblock_dependents(&transaction, task_id)?;
        }
        transaction.execute(
            "UPDATE team_task_attempts SET status = ?2,
                    completed_at = CASE WHEN ?2 = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = (
               SELECT id FROM team_task_attempts WHERE task_id = ?1
               ORDER BY created_at DESC, id DESC LIMIT 1
             )",
            params![task_id, if accept { "completed" } else { "running" }],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_task(task_id)
    }

    pub fn request_discrimination(
        &self,
        team_id: &str,
        leader_member_id: &str,
        discriminator_member_id: &str,
        workspace_fingerprint: &str,
    ) -> Result<TeamDiscriminationRound, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        require_leader(&transaction, team_id, leader_member_id)?;
        if member_role(&transaction, team_id, discriminator_member_id)? != TeamRole::Discriminator {
            return Err(TeamError::DiscriminatorRequired);
        }
        let (current_round, _) = discrimination_budget(&transaction, team_id)?;
        let round = current_round + 1;
        let round_id = Uuid::new_v4().to_string();
        transaction.execute(
            "INSERT INTO team_discrimination_rounds
             (id, team_id, discriminator_member_id, round, workspace_fingerprint, status)
             VALUES (?1, ?2, ?3, ?4, ?5, 'running')",
            params![
                round_id,
                team_id,
                discriminator_member_id,
                round,
                workspace_fingerprint,
            ],
        )?;
        transaction.execute(
            "UPDATE teams SET status = 'verifying', current_review_round = ?2,
                    workspace_fingerprint = ?3, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![team_id, round, workspace_fingerprint],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_discrimination_round(&round_id)
    }

    pub fn validate_discrimination_request(
        &self,
        team_id: &str,
        leader_member_id: &str,
    ) -> Result<(), TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        require_leader(&transaction, team_id, leader_member_id)?;
        discrimination_budget(&transaction, team_id)?;
        Ok(())
    }

    pub fn submit_discrimination_verdict(
        &self,
        round_id: &str,
        discriminator_member_id: &str,
        passed: bool,
        verdict: &str,
        evidence: &str,
    ) -> Result<TeamDiscriminationRound, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        let round = discrimination_round_by_id(&transaction, round_id)?;
        if round.discriminator_member_id != discriminator_member_id
            || member_role(&transaction, &round.team_id, discriminator_member_id)?
                != TeamRole::Discriminator
        {
            return Err(TeamError::DiscriminatorRequired);
        }
        if round.status != DiscriminationStatus::Running {
            return Err(TeamError::InvalidTeamState);
        }
        let status = if passed {
            DiscriminationStatus::Passed
        } else {
            DiscriminationStatus::Rejected
        };
        transaction.execute(
            "UPDATE team_discrimination_rounds SET status = ?2, verdict = ?3, evidence = ?4,
                    resolved_at = CURRENT_TIMESTAMP WHERE id = ?1 AND status = 'running'",
            params![round_id, status.as_str(), verdict.trim(), evidence.trim()],
        )?;
        let max_rounds: u8 = transaction.query_row(
            "SELECT max_review_rounds FROM teams WHERE id = ?1",
            [&round.team_id],
            |row| row.get(0),
        )?;
        let next_team_status = if !passed && round.round >= max_rounds {
            TeamStatus::NeedsAttention
        } else {
            TeamStatus::Active
        };
        transaction.execute(
            "UPDATE teams SET status = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![round.team_id, next_team_status.as_str()],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_discrimination_round(round_id)
    }

    pub fn list_discrimination_rounds(
        &self,
        team_id: &str,
    ) -> Result<Vec<TeamDiscriminationRound>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, discriminator_member_id, round, workspace_fingerprint,
                    status, verdict, evidence, created_at, resolved_at
             FROM team_discrimination_rounds WHERE team_id = ?1 ORDER BY round",
        )?;
        statement
            .query_map([team_id], discrimination_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn list_task_attempts(&self, team_id: &str) -> Result<Vec<TeamTaskAttempt>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, task_id, member_id, run_id, status, failure_kind,
                    error, created_at, updated_at, completed_at
             FROM team_task_attempts WHERE team_id = ?1 ORDER BY created_at, id",
        )?;
        statement
            .query_map([team_id], task_attempt_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn active_attempt_for_member(
        &self,
        member_id: &str,
    ) -> Result<Option<TeamTaskAttempt>, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, task_id, member_id, run_id, status, failure_kind,
                        error, created_at, updated_at, completed_at
                 FROM team_task_attempts
                 WHERE member_id = ?1 AND status IN ('queued', 'running', 'needs_report')
                 ORDER BY created_at DESC, id DESC LIMIT 1",
                [member_id],
                task_attempt_from_row,
            )
            .optional()
            .map_err(TeamError::from)
    }

    pub fn bind_task_attempt_run(
        &self,
        member_id: &str,
        run_id: &str,
    ) -> Result<Option<TeamTaskAttempt>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let attempt_id = database
            .query_row(
                "SELECT id FROM team_task_attempts
                 WHERE member_id = ?1 AND status IN ('queued', 'running', 'needs_report')
                 ORDER BY created_at DESC, id DESC LIMIT 1",
                [member_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(attempt_id) = attempt_id else {
            return Ok(None);
        };
        database.execute(
            "UPDATE team_task_attempts SET run_id = ?2,
                    status = CASE WHEN status = 'needs_report' THEN status ELSE 'running' END,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![attempt_id, run_id],
        )?;
        database
            .query_row(
                "SELECT id, team_id, task_id, member_id, run_id, status, failure_kind,
                        error, created_at, updated_at, completed_at
                 FROM team_task_attempts WHERE id = ?1",
                [attempt_id],
                task_attempt_from_row,
            )
            .map(Some)
            .map_err(TeamError::from)
    }

    pub fn mark_attempt_needs_report(
        &self,
        member_id: &str,
    ) -> Result<Option<TeamTaskAttempt>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let changed = database.execute(
            "UPDATE team_task_attempts SET status = 'needs_report',
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = (
               SELECT id FROM team_task_attempts
               WHERE member_id = ?1 AND status = 'running'
               ORDER BY created_at DESC, id DESC LIMIT 1
             )",
            [member_id],
        )?;
        drop(database);
        if changed == 0 {
            Ok(None)
        } else {
            self.active_attempt_for_member(member_id)
        }
    }

    pub fn fail_active_attempt(
        &self,
        member_id: &str,
        failure_kind: TeamTaskFailureKind,
        error: &str,
    ) -> Result<Option<TeamTaskAttempt>, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        let attempt_id = transaction
            .query_row(
                "SELECT id FROM team_task_attempts
                 WHERE member_id = ?1 AND status IN ('queued', 'running', 'needs_report')
                 ORDER BY created_at DESC, id DESC LIMIT 1",
                [member_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(attempt_id) = attempt_id else {
            return Ok(None);
        };
        transaction.execute(
            "UPDATE team_task_attempts SET status = 'failed', failure_kind = ?2,
                    error = ?3, completed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![attempt_id, failure_kind.as_str(), error.trim()],
        )?;
        transaction.execute(
            "UPDATE team_tasks SET status = 'failed', updated_at = CURRENT_TIMESTAMP
             WHERE id = (SELECT task_id FROM team_task_attempts WHERE id = ?1)",
            [&attempt_id],
        )?;
        let attempt = transaction.query_row(
            "SELECT id, team_id, task_id, member_id, run_id, status, failure_kind,
                    error, created_at, updated_at, completed_at
             FROM team_task_attempts WHERE id = ?1",
            [&attempt_id],
            task_attempt_from_row,
        )?;
        transaction.commit()?;
        Ok(Some(attempt))
    }

    pub fn retry_task(&self, task_id: &str, leader_member_id: &str) -> Result<TeamTask, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        let team_id = task_team_id(&transaction, task_id)?;
        require_leader(&transaction, &team_id, leader_member_id)?;
        let changed = transaction.execute(
            "UPDATE team_tasks SET status = 'pending', assignee_member_id = NULL,
                    result = NULL, verification = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status = 'failed'",
            [task_id],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskUnavailable);
        }
        transaction.commit()?;
        drop(database);
        self.get_task(task_id)
    }

    fn get_discrimination_round(
        &self,
        round_id: &str,
    ) -> Result<TeamDiscriminationRound, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, discriminator_member_id, round, workspace_fingerprint,
                        status, verdict, evidence, created_at, resolved_at
                 FROM team_discrimination_rounds WHERE id = ?1",
                [round_id],
                discrimination_from_row,
            )
            .optional()?
            .ok_or_else(|| TeamError::DiscriminationNotFound(round_id.to_owned()))
    }

    pub fn get_task(&self, task_id: &str) -> Result<TeamTask, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut task = database
            .query_row(
                "SELECT id, team_id, creator_member_id, assignee_member_id, title, description,
                        status, completion_required, requires_plan_approval, plan, mutates_files,
                        result, verification,
                        created_at, updated_at
                 FROM team_tasks WHERE id = ?1",
                [task_id],
                task_from_row,
            )
            .optional()?
            .ok_or_else(|| TeamError::TaskNotFound(task_id.to_owned()))?;
        task.dependencies = string_list(
            &database,
            "SELECT dependency_id FROM team_task_dependencies WHERE task_id = ?1 ORDER BY dependency_id",
            task_id,
        )?;
        task.owned_paths = string_list(
            &database,
            "SELECT path FROM team_task_paths WHERE task_id = ?1 ORDER BY path",
            task_id,
        )?;
        Ok(task)
    }
}

fn require_leader(
    transaction: &Transaction<'_>,
    team_id: &str,
    member_id: &str,
) -> Result<(), TeamError> {
    let role = member_role(transaction, team_id, member_id)?;
    if role == TeamRole::Leader {
        Ok(())
    } else {
        Err(TeamError::LeaderRequired)
    }
}

fn require_teammate(
    transaction: &Transaction<'_>,
    team_id: &str,
    member_id: &str,
) -> Result<(), TeamError> {
    if member_role(transaction, team_id, member_id)? == TeamRole::Teammate {
        Ok(())
    } else {
        Err(TeamError::TaskUnavailable)
    }
}

fn member_role(
    transaction: &Transaction<'_>,
    team_id: &str,
    member_id: &str,
) -> Result<TeamRole, TeamError> {
    transaction
        .query_row(
            "SELECT role FROM team_members WHERE id = ?1 AND team_id = ?2",
            params![member_id, team_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or(TeamError::WrongTeam)
        .and_then(|value| TeamRole::parse(&value))
}

fn validate_dependencies(
    transaction: &Transaction<'_>,
    team_id: &str,
    dependencies: &[String],
) -> Result<(), TeamError> {
    for dependency in dependencies {
        let exists = transaction
            .query_row(
                "SELECT 1 FROM team_tasks WHERE id = ?1 AND team_id = ?2",
                params![dependency, team_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Err(TeamError::TaskNotFound(dependency.clone()));
        }
    }
    Ok(())
}

fn task_team_id(transaction: &Transaction<'_>, task_id: &str) -> Result<String, TeamError> {
    transaction
        .query_row(
            "SELECT team_id FROM team_tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| TeamError::TaskNotFound(task_id.to_owned()))
}

fn required_tasks_are_accepted(
    transaction: &Transaction<'_>,
    team_id: &str,
) -> Result<bool, TeamError> {
    let (required, accepted): (i64, i64) = transaction.query_row(
        "SELECT COUNT(*), SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END)
         FROM team_tasks WHERE team_id = ?1 AND completion_required = 1",
        [team_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get::<_, Option<i64>>(1)?.unwrap_or_default(),
            ))
        },
    )?;
    Ok(required > 0 && required == accepted)
}

fn discrimination_budget(
    transaction: &Transaction<'_>,
    team_id: &str,
) -> Result<(u8, u8), TeamError> {
    let (mode, status, current_round, max_rounds): (String, String, u8, u8) = transaction
        .query_row(
            "SELECT mode, status, current_review_round, max_review_rounds
             FROM teams WHERE id = ?1",
            [team_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    if mode != TeamMode::Yolo.as_str()
        || status != TeamStatus::Active.as_str()
        || current_round >= max_rounds
        || !required_tasks_are_accepted(transaction, team_id)?
    {
        return Err(TeamError::CompletionBlocked);
    }
    Ok((current_round, max_rounds))
}

fn discrimination_round_by_id(
    transaction: &Transaction<'_>,
    round_id: &str,
) -> Result<TeamDiscriminationRound, TeamError> {
    transaction
        .query_row(
            "SELECT id, team_id, discriminator_member_id, round, workspace_fingerprint,
                    status, verdict, evidence, created_at, resolved_at
             FROM team_discrimination_rounds WHERE id = ?1",
            [round_id],
            discrimination_from_row,
        )
        .optional()?
        .ok_or_else(|| TeamError::DiscriminationNotFound(round_id.to_owned()))
}

fn require_team_member(
    database: &Connection,
    team_id: &str,
    member_id: &str,
) -> Result<(), TeamError> {
    let member_team = database
        .query_row(
            "SELECT team_id FROM team_members WHERE id = ?1",
            [member_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| TeamError::MemberNotFound(member_id.to_owned()))?;
    if member_team != team_id {
        return Err(TeamError::WrongTeam);
    }
    Ok(())
}

fn unblock_dependents(
    transaction: &Transaction<'_>,
    completed_task_id: &str,
) -> Result<(), TeamError> {
    transaction.execute(
        "UPDATE team_tasks AS task SET status = 'pending', updated_at = CURRENT_TIMESTAMP
         WHERE task.status = 'blocked'
           AND EXISTS (
             SELECT 1 FROM team_task_dependencies edge
             WHERE edge.task_id = task.id AND edge.dependency_id = ?1
           )
           AND NOT EXISTS (
             SELECT 1 FROM team_task_dependencies edge
             JOIN team_tasks dependency ON dependency.id = edge.dependency_id
             WHERE edge.task_id = task.id AND dependency.status <> 'accepted'
           )",
        [completed_task_id],
    )?;
    Ok(())
}

fn string_list(database: &Connection, query: &str, id: &str) -> Result<Vec<String>, TeamError> {
    let mut statement = database.prepare(query)?;
    statement
        .query_map([id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(TeamError::from)
}

fn team_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Team> {
    Ok(Team {
        id: row.get(0)?,
        project_id: row.get(1)?,
        leader_member_id: row.get(2)?,
        agent_session_id: row.get(3)?,
        title: row.get(4)?,
        status: TeamStatus::parse(&row.get::<_, String>(5)?).map_err(sql_value_error)?,
        workspace: TeamWorkspace::parse(&row.get::<_, String>(6)?).map_err(sql_value_error)?,
        workspace_path: row.get(7)?,
        member_management_policy: MemberManagementPolicy::parse(&row.get::<_, String>(8)?)
            .map_err(sql_value_error)?,
        max_parallel_runs: row.get(9)?,
        requested_mode: TeamMode::parse(&row.get::<_, String>(10)?).map_err(sql_value_error)?,
        mode: TeamMode::parse(&row.get::<_, String>(11)?).map_err(sql_value_error)?,
        mode_fallback: team_mode_fallback_from_row(row)?,
        goal: row.get(16)?,
        acceptance_criteria: json_string_list(&row.get::<_, String>(17)?)
            .map_err(sql_value_error)?,
        allowed_agent_ids: json_string_list(&row.get::<_, String>(18)?).map_err(sql_value_error)?,
        max_teammates: row.get(19)?,
        max_review_rounds: row.get(20)?,
        current_review_round: row.get(21)?,
        workspace_fingerprint: row.get(22)?,
        final_summary: row.get(23)?,
        started_at: row.get(24)?,
        completed_at: row.get(25)?,
        created_at: row.get(26)?,
        updated_at: row.get(27)?,
    })
}

fn team_mode_fallback_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Option<TeamModeFallback>> {
    let agent_id = row.get::<_, Option<String>>(12)?;
    let reason_code = row.get::<_, Option<String>>(13)?;
    let reason = row.get::<_, Option<String>>(14)?;
    let occurred_at = row.get::<_, Option<String>>(15)?;
    Ok(agent_id.zip(reason_code).zip(reason).zip(occurred_at).map(
        |(((agent_id, reason_code), reason), occurred_at)| TeamModeFallback {
            agent_id,
            reason_code,
            reason,
            occurred_at,
        },
    ))
}

fn team_member_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamMember> {
    Ok(TeamMember {
        id: row.get(0)?,
        team_id: row.get(1)?,
        conversation_id: row.get(2)?,
        name: row.get(3)?,
        role: TeamRole::parse(&row.get::<_, String>(4)?).map_err(sql_value_error)?,
        status: TeamMemberStatus::parse(&row.get::<_, String>(5)?).map_err(sql_value_error)?,
        workspace_mode: MemberWorkspaceMode::parse(&row.get::<_, String>(6)?)
            .map_err(sql_value_error)?,
        base_tree: row.get(7)?,
        permission_profile_applied: row.get(8)?,
        previous_permission_mode: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamTask> {
    Ok(TeamTask {
        id: row.get(0)?,
        team_id: row.get(1)?,
        creator_member_id: row.get(2)?,
        assignee_member_id: row.get(3)?,
        title: row.get(4)?,
        description: row.get(5)?,
        status: TeamTaskStatus::parse(&row.get::<_, String>(6)?).map_err(sql_value_error)?,
        completion_required: row.get(7)?,
        requires_plan_approval: row.get(8)?,
        plan: row.get(9)?,
        mutates_files: row.get(10)?,
        result: row.get(11)?,
        verification: row.get(12)?,
        dependencies: Vec::new(),
        owned_paths: Vec::new(),
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn discrimination_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamDiscriminationRound> {
    Ok(TeamDiscriminationRound {
        id: row.get(0)?,
        team_id: row.get(1)?,
        discriminator_member_id: row.get(2)?,
        round: row.get(3)?,
        workspace_fingerprint: row.get(4)?,
        status: DiscriminationStatus::parse(&row.get::<_, String>(5)?).map_err(sql_value_error)?,
        verdict: row.get(6)?,
        evidence: row.get(7)?,
        created_at: row.get(8)?,
        resolved_at: row.get(9)?,
    })
}

fn task_attempt_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamTaskAttempt> {
    let failure_kind = row
        .get::<_, Option<String>>(6)?
        .map(|value| TeamTaskFailureKind::parse(&value))
        .transpose()
        .map_err(sql_value_error)?;
    Ok(TeamTaskAttempt {
        id: row.get(0)?,
        team_id: row.get(1)?,
        task_id: row.get(2)?,
        member_id: row.get(3)?,
        run_id: row.get(4)?,
        status: TeamTaskAttemptStatus::parse(&row.get::<_, String>(5)?).map_err(sql_value_error)?,
        failure_kind,
        error: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        completed_at: row.get(10)?,
    })
}

fn team_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamMessage> {
    Ok(TeamMessage {
        id: row.get(0)?,
        team_id: row.get(1)?,
        from_member_id: row.get(2)?,
        to_member_id: row.get(3)?,
        kind: TeamMessageKind::parse(&row.get::<_, String>(4)?).map_err(sql_value_error)?,
        task_id: row.get(5)?,
        body: row.get(6)?,
        read_at: row.get(7)?,
        delivery_status: TeamMessageDeliveryStatus::parse(&row.get::<_, String>(8)?)
            .map_err(sql_value_error)?,
        delivery_attempts: row.get(9)?,
        delivered_at: row.get(10)?,
        last_error: row.get(11)?,
        created_at: row.get(12)?,
    })
}

fn team_proposal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamProposal> {
    Ok(TeamProposal {
        id: row.get(0)?,
        team_id: row.get(1)?,
        summary: row.get(2)?,
        members_json: row.get(3)?,
        status: TeamProposalStatus::parse(&row.get::<_, String>(4)?).map_err(sql_value_error)?,
        created_at: row.get(5)?,
        resolved_at: row.get(6)?,
    })
}

fn team_activity_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamActivity> {
    Ok(TeamActivity {
        id: row.get(0)?,
        team_id: row.get(1)?,
        member_id: row.get(2)?,
        task_id: row.get(3)?,
        kind: row.get(4)?,
        summary: row.get(5)?,
        metadata_json: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn team_permission_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamPermissionRequest> {
    Ok(TeamPermissionRequest {
        id: row.get(0)?,
        team_id: row.get(1)?,
        member_id: row.get(2)?,
        conversation_id: row.get(3)?,
        run_id: row.get(4)?,
        tool: row.get(5)?,
        input_json: row.get(6)?,
        options_json: row.get(7)?,
        status: TeamPermissionStatus::parse(&row.get::<_, String>(8)?).map_err(sql_value_error)?,
        selected_option_id: row.get(9)?,
        reason: row.get(10)?,
        decided_by: row.get(11)?,
        decided_by_member_id: row.get(12)?,
        created_at: row.get(13)?,
        resolved_at: row.get(14)?,
    })
}

fn validate_permission_option(
    request: &TeamPermissionRequest,
    option_id: &str,
) -> Result<(), TeamError> {
    let options = serde_json::from_str::<Vec<serde_json::Value>>(&request.options_json)
        .map_err(|error| TeamError::InvalidStoredValue(error.to_string()))?;
    if options
        .iter()
        .any(|option| option.get("id").and_then(serde_json::Value::as_str) == Some(option_id))
    {
        Ok(())
    } else {
        Err(TeamError::InvalidPermissionOption(option_id.to_owned()))
    }
}

fn sql_value_error(error: TeamError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn normalize_title(title: Option<&str>) -> String {
    title.unwrap_or_default().trim().to_owned()
}

fn normalized_name(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "teammate".to_owned()
    } else {
        name.to_owned()
    }
}

fn normalized_strings(values: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values.iter().map(|value| value.trim()) {
        if !value.is_empty() && !normalized.iter().any(|current| current == value) {
            normalized.push(value.to_owned());
        }
    }
    normalized
}

fn normalized_agent_ids(values: &[String]) -> Result<Vec<String>, TeamError> {
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

fn json_string_list(value: &str) -> Result<Vec<String>, TeamError> {
    serde_json::from_str(value).map_err(|error| TeamError::InvalidStoredValue(error.to_string()))
}

fn is_unique_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn ensure_column(
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

            fn parse(value: &str) -> Result<Self, TeamError> {
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
});
stored_enum!(TeamStatus {
    Draft => "draft",
    Active => "active",
    Verifying => "verifying",
    NeedsAttention => "needs_attention",
    Completed => "completed",
    Archived => "archived"
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
