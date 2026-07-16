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
    Idle,
    Working,
    WaitingInput,
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
    pub created_at: String,
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
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );",
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
                        workspace, workspace_path, created_at, updated_at
                 FROM teams WHERE id = ?1",
                [team_id],
                team_from_row,
            )
            .optional()?
            .ok_or_else(|| TeamError::TeamNotFound(team_id.to_owned()))
    }

    pub fn list_teams(&self, project_id: &str) -> Result<Vec<Team>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, project_id, leader_member_id, agent_session_id, title, status,
                    workspace, workspace_path, created_at, updated_at
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
                        t.status, t.workspace, t.workspace_path, t.created_at, t.updated_at
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
                        body, read_at, created_at
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
                    body, read_at, created_at
             FROM team_messages
             WHERE to_member_id = ?1 AND read_at IS NULL
             ORDER BY created_at, id",
        )?;
        statement
            .query_map([member_id], team_message_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn mark_messages_read(&self, member_id: &str) -> Result<usize, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_messages SET read_at = CURRENT_TIMESTAMP
                 WHERE to_member_id = ?1 AND read_at IS NULL",
                [member_id],
            )
            .map_err(TeamError::from)
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
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
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
        created_at: row.get(8)?,
    })
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
stored_enum!(TeamWorkspace { Shared => "shared", Worktree => "worktree" });
stored_enum!(MemberWorkspaceMode { Shared => "shared", Isolated => "isolated" });
stored_enum!(TeamMemberStatus {
    Starting => "starting",
    Idle => "idle",
    Working => "working",
    WaitingInput => "waiting_input",
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
