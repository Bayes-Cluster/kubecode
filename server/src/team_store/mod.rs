mod lifecycle;
mod mailbox;
mod members;
mod models;
mod permissions;
mod proposals;
mod tasks;

pub use models::*;

use std::path::Path;
use std::sync::Arc;

use rusqlite::params;

use crate::database::{Database, ensure_column};

pub struct TeamStore {
    database: Arc<Database>,
}

impl TeamStore {
    pub fn open(database_path: impl AsRef<Path>) -> Result<Self, TeamError> {
        let database = Arc::new(Database::open(database_path)?);
        Self::from_database(database)
    }

    pub fn from_database(database: Arc<Database>) -> Result<Self, TeamError> {
        let connection = database.lock().expect("team database mutex poisoned");
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS teams (
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
             );
             CREATE TABLE IF NOT EXISTS team_lifecycle_operations (
               id TEXT PRIMARY KEY,
               team_id TEXT NOT NULL,
               project_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               member_id TEXT,
               conversation_id TEXT,
               payload_json TEXT NOT NULL DEFAULT '{}',
               attempt_count INTEGER NOT NULL DEFAULT 0,
               next_attempt_at TEXT,
               last_error TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               completed_at TEXT
             );
             CREATE TABLE IF NOT EXISTS team_user_input_requests (
               id TEXT PRIMARY KEY,
               team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
               requester_member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
               title TEXT NOT NULL,
               prompt TEXT NOT NULL,
               resume_status TEXT NOT NULL DEFAULT 'active',
               status TEXT NOT NULL DEFAULT 'pending',
               answer TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               resolved_at TEXT
             );",
        )?;
        ensure_column(
            &connection,
            "teams",
            "member_management_policy",
            "TEXT NOT NULL DEFAULT 'ask'",
        )?;
        ensure_column(&connection, "team_tasks", "plan", "TEXT")?;
        ensure_column(
            &connection,
            "teams",
            "max_parallel_runs",
            "INTEGER NOT NULL DEFAULT 3",
        )?;
        ensure_column(
            &connection,
            "teams",
            "mode",
            "TEXT NOT NULL DEFAULT 'standard'",
        )?;
        ensure_column(&connection, "teams", "goal", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(
            &connection,
            "teams",
            "acceptance_criteria_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column(
            &connection,
            "teams",
            "allowed_agent_ids_json",
            "TEXT NOT NULL DEFAULT '[\"claude_code\",\"codex\",\"opencode\"]'",
        )?;
        ensure_column(
            &connection,
            "teams",
            "max_teammates",
            "INTEGER NOT NULL DEFAULT 3",
        )?;
        ensure_column(
            &connection,
            "teams",
            "max_review_rounds",
            "INTEGER NOT NULL DEFAULT 3",
        )?;
        ensure_column(
            &connection,
            "teams",
            "current_review_round",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "teams",
            "requested_mode",
            "TEXT NOT NULL DEFAULT 'standard'",
        )?;
        ensure_column(&connection, "teams", "mode_fallback_agent_id", "TEXT")?;
        ensure_column(&connection, "teams", "mode_fallback_reason_code", "TEXT")?;
        ensure_column(&connection, "teams", "mode_fallback_reason", "TEXT")?;
        ensure_column(&connection, "teams", "mode_fallback_at", "TEXT")?;
        ensure_column(
            &connection,
            "team_members",
            "permission_profile_applied",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "team_members",
            "previous_permission_mode",
            "TEXT",
        )?;
        ensure_column(&connection, "teams", "workspace_fingerprint", "TEXT")?;
        ensure_column(&connection, "teams", "final_summary", "TEXT")?;
        ensure_column(&connection, "teams", "started_at", "TEXT")?;
        ensure_column(&connection, "teams", "completed_at", "TEXT")?;
        ensure_column(
            &connection,
            "team_messages",
            "delivery_status",
            "TEXT NOT NULL DEFAULT 'pending'",
        )?;
        ensure_column(
            &connection,
            "team_messages",
            "delivery_attempts",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "team_messages", "delivered_at", "TEXT")?;
        ensure_column(&connection, "team_messages", "last_error", "TEXT")?;
        ensure_column(
            &connection,
            "team_user_input_requests",
            "resume_status",
            "TEXT NOT NULL DEFAULT 'active'",
        )?;
        ensure_column(
            &connection,
            "team_tasks",
            "completion_required",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        connection.execute(
            "UPDATE team_tasks SET completion_required = 0
             WHERE status = 'cancelled' AND completion_required = 1",
            [],
        )?;
        connection.execute(
            "UPDATE team_messages
             SET delivery_status = 'cancelled',
                 read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
             WHERE task_id IN (SELECT id FROM team_tasks WHERE status = 'cancelled')
               AND delivery_status IN ('pending', 'delivered', 'failed')",
            [],
        )?;
        connection.execute(
            "UPDATE team_permission_requests
             SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP
             WHERE status IN ('pending_leader', 'waiting_user')",
            [],
        )?;
        connection.execute(
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
        connection.execute(
            "UPDATE team_lifecycle_operations
             SET status = CASE
                   WHEN kind = 'provider_cleanup' THEN 'pending'
                   ELSE 'failed'
                 END,
                 next_attempt_at = NULL,
                 last_error = CASE
                   WHEN kind = 'provider_cleanup' THEN last_error
                   ELSE 'operation interrupted by server restart'
                 END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE status = 'running'",
            [],
        )?;
        drop(connection);
        Ok(Self { database })
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
