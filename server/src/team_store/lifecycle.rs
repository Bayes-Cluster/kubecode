use rusqlite::{OptionalExtension, TransactionBehavior, params};
use uuid::Uuid;

use super::TeamStore;
use super::members::require_leader;
use super::models::{
    MAX_TEAMMATES, MemberManagementPolicy, NewTeam, StartTeam, Team, TeamError,
    TeamLifecycleOperation, TeamLifecycleOperationKind, TeamLifecycleOperationStatus, TeamMode,
    TeamModeFallback, TeamStatus, TeamUserInputRequest, TeamUserInputStatus, TeamWorkspace,
    json_string_list, normalize_title, normalized_agent_ids, normalized_name, normalized_strings,
    sql_value_error,
};

impl TeamStore {
    pub fn create_team(&self, input: NewTeam<'_>) -> Result<Team, TeamError> {
        let team_id = Uuid::new_v4().to_string();
        let leader_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_leader(&transaction, input.team_id, input.leader_member_id)?;
        let changed = transaction.execute(
            "UPDATE teams SET status = 'starting', requested_mode = ?3, mode = ?3,
                    mode_fallback_agent_id = NULL, mode_fallback_reason_code = NULL,
                    mode_fallback_reason = NULL, mode_fallback_at = NULL, goal = ?4,
                    acceptance_criteria_json = ?5, allowed_agent_ids_json = ?6,
                    max_teammates = ?7, max_parallel_runs = ?8, max_review_rounds = ?9,
                    current_review_round = CASE WHEN status = 'draft' THEN 0 ELSE current_review_round END,
                    workspace_fingerprint = NULL,
                    final_summary = NULL, started_at = CURRENT_TIMESTAMP, completed_at = NULL,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status IN ('draft', 'needs_attention')
               AND (status = 'draft' OR ?9 > current_review_round)
               AND NOT EXISTS (
                 SELECT 1 FROM team_user_input_requests
                 WHERE team_id = teams.id AND status = 'pending'
               )",
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

    pub fn activate_team(&self, team_id: &str) -> Result<Team, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE teams SET status = 'active', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status = 'starting'",
                [team_id],
            )?;
        if changed == 0 {
            return Err(TeamError::InvalidTeamState);
        }
        self.get_team(team_id)
    }

    pub fn pause_team(&self, team_id: &str) -> Result<Team, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE teams SET status = 'paused', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status IN ('active', 'verifying', 'needs_attention')",
                [team_id],
            )?;
        if changed == 0 {
            return Err(TeamError::InvalidTeamState);
        }
        self.get_team(team_id)
    }

    pub fn resume_team(&self, team_id: &str) -> Result<Team, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE teams SET status = 'active', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status = 'paused'",
                [team_id],
            )?;
        if changed == 0 {
            return Err(TeamError::InvalidTeamState);
        }
        self.get_team(team_id)
    }

    pub fn mark_team_needs_attention(&self, team_id: &str) -> Result<Team, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE teams SET status = 'needs_attention', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status IN ('active', 'verifying')",
                [team_id],
            )?;
        if changed == 0 {
            return Err(TeamError::InvalidTeamState);
        }
        self.get_team(team_id)
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
                 WHERE id = ?1 AND status IN ('starting', 'active')",
                [team_id],
            )?;
        if changed == 0 {
            return Err(TeamError::InvalidTeamState);
        }
        self.get_team(team_id)
    }

    pub fn complete_team(
        &self,
        team_id: &str,
        leader_member_id: &str,
        final_summary: &str,
        workspace_fingerprint: &str,
    ) -> Result<Team, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
                  WHERE team_id = ?1
                    AND delivery_status IN ('pending', 'delivered', 'failed'))",
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

    pub fn list_reconcilable_teams(&self) -> Result<Vec<Team>, TeamError> {
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
             FROM teams
             WHERE status IN ('starting', 'active', 'verifying', 'needs_attention', 'disbanding')
             ORDER BY updated_at, id",
        )?;
        statement
            .query_map([], team_from_row)?
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

    pub fn mark_team_disbanding(&self, team_id: &str) -> Result<Team, TeamError> {
        let current = self.get_team(team_id)?;
        if current.status == TeamStatus::Disbanding {
            return Ok(current);
        }
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE teams SET status = 'disbanding', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1
                   AND status NOT IN ('disbanding', 'removed')",
                [team_id],
            )?;
        if changed == 0 {
            return Err(TeamError::InvalidTeamState);
        }
        self.get_team(team_id)
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

    pub fn create_lifecycle_operation(
        &self,
        team_id: &str,
        project_id: &str,
        kind: TeamLifecycleOperationKind,
        member_id: Option<&str>,
        conversation_id: Option<&str>,
        payload_json: &str,
    ) -> Result<TeamLifecycleOperation, TeamError> {
        let operation_id = Uuid::new_v4().to_string();
        serde_json::from_str::<serde_json::Value>(payload_json)
            .map_err(|error| TeamError::InvalidStoredValue(error.to_string()))?;
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "INSERT INTO team_lifecycle_operations
                 (id, team_id, project_id, kind, member_id, conversation_id, payload_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    operation_id,
                    team_id,
                    project_id,
                    kind.as_str(),
                    member_id,
                    conversation_id,
                    payload_json,
                ],
            )?;
        self.get_lifecycle_operation(&operation_id)
    }

    pub fn get_lifecycle_operation(
        &self,
        operation_id: &str,
    ) -> Result<TeamLifecycleOperation, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, project_id, kind, status, member_id, conversation_id,
                        payload_json, attempt_count, next_attempt_at, last_error,
                        created_at, updated_at, completed_at
                 FROM team_lifecycle_operations WHERE id = ?1",
                [operation_id],
                team_lifecycle_operation_from_row,
            )
            .optional()?
            .ok_or_else(|| TeamError::LifecycleOperationNotFound(operation_id.to_owned()))
    }

    pub fn list_lifecycle_operations(
        &self,
        team_id: &str,
    ) -> Result<Vec<TeamLifecycleOperation>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, project_id, kind, status, member_id, conversation_id,
                    payload_json, attempt_count, next_attempt_at, last_error,
                    created_at, updated_at, completed_at
             FROM team_lifecycle_operations
             WHERE team_id = ?1
             ORDER BY created_at, id",
        )?;
        statement
            .query_map([team_id], team_lifecycle_operation_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn due_lifecycle_operations(&self) -> Result<Vec<TeamLifecycleOperation>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, project_id, kind, status, member_id, conversation_id,
                    payload_json, attempt_count, next_attempt_at, last_error,
                    created_at, updated_at, completed_at
             FROM team_lifecycle_operations
             WHERE kind = 'provider_cleanup'
               AND status IN ('pending', 'retry_scheduled')
               AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
             ORDER BY created_at, id",
        )?;
        statement
            .query_map([], team_lifecycle_operation_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn mark_lifecycle_operation_running(
        &self,
        operation_id: &str,
    ) -> Result<TeamLifecycleOperation, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_lifecycle_operations
                 SET status = 'running', attempt_count = attempt_count + 1,
                     next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status IN ('pending', 'retry_scheduled')",
                [operation_id],
            )?;
        if changed == 0 {
            return Err(TeamError::LifecycleOperationNotFound(
                operation_id.to_owned(),
            ));
        }
        self.get_lifecycle_operation(operation_id)
    }

    pub fn mark_lifecycle_operation_failed(
        &self,
        operation_id: &str,
        error: &str,
    ) -> Result<TeamLifecycleOperation, TeamError> {
        let operation = self.get_lifecycle_operation(operation_id)?;
        let retry_delay_seconds = match operation.attempt_count {
            0 | 1 => Some(5),
            2 => Some(30),
            3 => Some(2 * 60),
            4 => Some(10 * 60),
            5 => Some(60 * 60),
            _ => None,
        };
        let (status, next_attempt_at) = retry_delay_seconds.map_or_else(
            || (TeamLifecycleOperationStatus::Failed, None),
            |seconds| {
                (
                    TeamLifecycleOperationStatus::RetryScheduled,
                    Some(format!("+{seconds} seconds")),
                )
            },
        );
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_lifecycle_operations
                 SET status = ?2,
                     next_attempt_at = CASE
                       WHEN ?3 IS NULL THEN NULL
                       ELSE datetime('now', ?3)
                     END,
                     last_error = ?4, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![operation_id, status.as_str(), next_attempt_at, error.trim(),],
            )?;
        self.get_lifecycle_operation(operation_id)
    }

    pub fn mark_lifecycle_operation_completed(
        &self,
        operation_id: &str,
    ) -> Result<TeamLifecycleOperation, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_lifecycle_operations
                 SET status = 'completed', next_attempt_at = NULL, last_error = NULL,
                     completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                [operation_id],
            )?;
        if changed == 0 {
            return Err(TeamError::LifecycleOperationNotFound(
                operation_id.to_owned(),
            ));
        }
        self.get_lifecycle_operation(operation_id)
    }

    pub fn mark_lifecycle_operation_terminal_failure(
        &self,
        operation_id: &str,
        error: &str,
    ) -> Result<TeamLifecycleOperation, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_lifecycle_operations
                 SET status = 'failed', next_attempt_at = NULL, last_error = ?2,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![operation_id, error.trim()],
            )?;
        if changed == 0 {
            return Err(TeamError::LifecycleOperationNotFound(
                operation_id.to_owned(),
            ));
        }
        self.get_lifecycle_operation(operation_id)
    }

    pub fn retry_lifecycle_operation(
        &self,
        operation_id: &str,
    ) -> Result<TeamLifecycleOperation, TeamError> {
        let changed = self
            .database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_lifecycle_operations
                 SET status = 'pending', attempt_count = 0, next_attempt_at = NULL,
                     last_error = NULL, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status = 'failed'",
                [operation_id],
            )?;
        if changed == 0 {
            return Err(TeamError::LifecycleOperationNotFound(
                operation_id.to_owned(),
            ));
        }
        self.get_lifecycle_operation(operation_id)
    }

    pub fn request_user_input(
        &self,
        team_id: &str,
        leader_member_id: &str,
        title: &str,
        prompt: &str,
    ) -> Result<TeamUserInputRequest, TeamError> {
        let request_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_leader(&transaction, team_id, leader_member_id)?;
        let status: String =
            transaction.query_row("SELECT status FROM teams WHERE id = ?1", [team_id], |row| {
                row.get(0)
            })?;
        if !matches!(status.as_str(), "active" | "verifying") {
            return Err(TeamError::InvalidTeamState);
        }
        transaction.execute(
            "INSERT INTO team_user_input_requests
             (id, team_id, requester_member_id, title, prompt, resume_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                request_id,
                team_id,
                leader_member_id,
                title.trim(),
                prompt.trim(),
                status,
            ],
        )?;
        transaction.execute(
            "UPDATE teams SET status = 'needs_attention', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            [team_id],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_user_input_request(&request_id)
    }

    pub fn get_user_input_request(
        &self,
        request_id: &str,
    ) -> Result<TeamUserInputRequest, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .query_row(
                "SELECT id, team_id, requester_member_id, title, prompt, resume_status,
                        status, answer, created_at, resolved_at
                 FROM team_user_input_requests WHERE id = ?1",
                [request_id],
                team_user_input_request_from_row,
            )
            .optional()?
            .ok_or_else(|| TeamError::UserInputRequestNotFound(request_id.to_owned()))
    }

    pub fn pending_user_input_requests(
        &self,
        team_id: &str,
    ) -> Result<Vec<TeamUserInputRequest>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, requester_member_id, title, prompt, resume_status,
                    status, answer, created_at, resolved_at
             FROM team_user_input_requests
             WHERE team_id = ?1 AND status = 'pending'
             ORDER BY created_at, id",
        )?;
        statement
            .query_map([team_id], team_user_input_request_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn resolve_user_input(
        &self,
        team_id: &str,
        request_id: &str,
        answer: &str,
    ) -> Result<TeamUserInputRequest, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE team_user_input_requests
             SET status = 'resolved', answer = ?3, resolved_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND team_id = ?2 AND status = 'pending'",
            params![request_id, team_id, answer.trim()],
        )?;
        if changed == 0 {
            let exists = transaction
                .query_row(
                    "SELECT 1 FROM team_user_input_requests WHERE id = ?1 AND team_id = ?2",
                    params![request_id, team_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            return Err(if exists {
                TeamError::UserInputRequestNotPending
            } else {
                TeamError::UserInputRequestNotFound(request_id.to_owned())
            });
        }
        let pending: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM team_user_input_requests
             WHERE team_id = ?1 AND status = 'pending'",
            [team_id],
            |row| row.get(0),
        )?;
        if pending == 0 {
            let resume_status: String = transaction.query_row(
                "SELECT resume_status FROM team_user_input_requests WHERE id = ?1",
                [request_id],
                |row| row.get(0),
            )?;
            transaction.execute(
                "UPDATE teams SET status = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status = 'needs_attention'",
                params![team_id, resume_status],
            )?;
        }
        transaction.commit()?;
        drop(database);
        self.get_user_input_request(request_id)
    }
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

fn team_lifecycle_operation_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<TeamLifecycleOperation> {
    Ok(TeamLifecycleOperation {
        id: row.get(0)?,
        team_id: row.get(1)?,
        project_id: row.get(2)?,
        kind: TeamLifecycleOperationKind::parse(&row.get::<_, String>(3)?)
            .map_err(sql_value_error)?,
        status: TeamLifecycleOperationStatus::parse(&row.get::<_, String>(4)?)
            .map_err(sql_value_error)?,
        member_id: row.get(5)?,
        conversation_id: row.get(6)?,
        payload_json: row.get(7)?,
        attempt_count: row.get(8)?,
        next_attempt_at: row.get(9)?,
        last_error: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        completed_at: row.get(13)?,
    })
}

fn team_user_input_request_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<TeamUserInputRequest> {
    Ok(TeamUserInputRequest {
        id: row.get(0)?,
        team_id: row.get(1)?,
        requester_member_id: row.get(2)?,
        title: row.get(3)?,
        prompt: row.get(4)?,
        resume_status: TeamStatus::parse(&row.get::<_, String>(5)?).map_err(sql_value_error)?,
        status: TeamUserInputStatus::parse(&row.get::<_, String>(6)?).map_err(sql_value_error)?,
        answer: row.get(7)?,
        created_at: row.get(8)?,
        resolved_at: row.get(9)?,
    })
}
