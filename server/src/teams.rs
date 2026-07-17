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
    Active,
    Completed,
    Archived,
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
    pub created_at: String,
    pub updated_at: String,
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
    pub requires_plan_approval: bool,
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
               status TEXT NOT NULL DEFAULT 'active',
               workspace TEXT NOT NULL DEFAULT 'shared',
               workspace_path TEXT,
               member_management_policy TEXT NOT NULL DEFAULT 'ask',
               max_parallel_runs INTEGER NOT NULL DEFAULT 3,
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
               requires_plan_approval INTEGER NOT NULL DEFAULT 0,
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
             );",
        )?;
        ensure_column(
            &database,
            "teams",
            "member_management_policy",
            "TEXT NOT NULL DEFAULT 'ask'",
        )?;
        ensure_column(
            &database,
            "teams",
            "max_parallel_runs",
            "INTEGER NOT NULL DEFAULT 3",
        )?;
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
        database.execute(
            "UPDATE team_permission_requests
             SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP
             WHERE status IN ('pending_leader', 'waiting_user')",
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
             (id, project_id, leader_member_id, agent_session_id, title, workspace, workspace_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
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

    pub fn list_teams(&self, project_id: &str) -> Result<Vec<Team>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, project_id, leader_member_id, agent_session_id, title, status,
                    workspace, workspace_path, member_management_policy, max_parallel_runs,
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
                        t.max_parallel_runs, t.created_at, t.updated_at
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
                    base_tree, created_at, updated_at
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
        let teammates: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM team_members WHERE team_id = ?1 AND role = 'teammate'",
            [input.team_id],
            |row| row.get(0),
        )?;
        if teammates >= MAX_TEAMMATES {
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

    pub fn get_member(&self, member_id: &str) -> Result<TeamMember, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, conversation_id, name, role, status, workspace_mode,
                        base_tree, created_at, updated_at
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
                        base_tree, created_at, updated_at
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
        if member_role(&transaction, team_id, teammate_id)? == TeamRole::Leader {
            return Err(TeamError::LeaderCannotBeRemoved);
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
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction()?;
        let team_id = task_team_id(&transaction, task_id)?;
        require_leader(&transaction, &team_id, leader_member_id)?;
        require_team_member(&transaction, &team_id, assignee_member_id)?;
        if member_role(&transaction, &team_id, assignee_member_id)? == TeamRole::Leader {
            return Err(TeamError::TaskUnavailable);
        }
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
        transaction.commit()?;
        drop(database);
        self.get_task(task_id)
    }

    pub fn get_task(&self, task_id: &str) -> Result<TeamTask, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut task = database
            .query_row(
                "SELECT id, team_id, creator_member_id, assignee_member_id, title, description,
                        status, requires_plan_approval, mutates_files, result, verification,
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
    member_role(transaction, team_id, member_id).map(|_| ())
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
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
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
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
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
        requires_plan_approval: row.get(7)?,
        mutates_files: row.get(8)?,
        result: row.get(9)?,
        verification: row.get(10)?,
        dependencies: Vec::new(),
        owned_paths: Vec::new(),
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
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

stored_enum!(TeamRole { Leader => "leader", Teammate => "teammate" });
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
stored_enum!(TeamStatus { Active => "active", Completed => "completed", Archived => "archived" });
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
