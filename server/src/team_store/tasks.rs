use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use uuid::Uuid;

use super::TeamStore;
use super::members::{member_role, require_leader, require_teammate};
use super::models::{
    DiscriminationStatus, NewTeamTask, TeamDiscriminationRound, TeamError, TeamMode, TeamRole,
    TeamStatus, TeamTask, TeamTaskAttempt, TeamTaskAttemptStatus, TeamTaskFailureKind,
    TeamTaskStatus, sql_value_error,
};

impl TeamStore {
    pub fn create_task(&self, input: NewTeamTask<'_>) -> Result<TeamTask, TeamError> {
        let task_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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

    pub fn claim_task(&self, task_id: &str, member_id: &str) -> Result<TeamTask, TeamError> {
        let attempt_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        let message_id = Uuid::new_v4().to_string();
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (team_id, leader_member_id, title): (String, String, String) = transaction
            .query_row(
                "SELECT task.team_id, team.leader_member_id, task.title
                 FROM team_tasks task
                 JOIN teams team ON team.id = task.team_id
                 WHERE task.id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| TeamError::TaskNotFound(task_id.to_owned()))?;
        let changed = transaction.execute(
            "UPDATE team_tasks SET status = 'result_review', result = ?3, verification = ?4,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND assignee_member_id = ?2 AND status IN ('in_progress', 'changes_requested')",
            params![task_id, member_id, result.trim(), verification.trim()],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskNotAssigned);
        }
        transaction.execute(
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
        transaction.execute(
            "INSERT INTO team_messages
             (id, team_id, from_member_id, to_member_id, kind, task_id, body)
             VALUES (?1, ?2, ?3, ?4, 'result_ready', ?5, ?6)",
            params![
                message_id,
                team_id,
                member_id,
                leader_member_id,
                task_id,
                result.trim()
            ],
        )?;
        transaction.execute(
            "INSERT INTO team_activity_events
             (team_id, member_id, task_id, kind, summary)
             VALUES (?1, ?2, ?3, 'task_result_submitted', ?4)",
            params![team_id, member_id, task_id, title],
        )?;
        transaction.commit()?;
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        let message_id = (!accept).then(|| Uuid::new_v4().to_string());
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let team_id = task_team_id(&transaction, task_id)?;
        require_leader(&transaction, &team_id, leader_member_id)?;
        let (assignee_member_id, title): (Option<String>, String) = transaction.query_row(
            "SELECT assignee_member_id, title FROM team_tasks WHERE id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
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
        transaction.execute(
            "UPDATE team_messages
             SET delivery_status = 'acknowledged',
                 read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
             WHERE task_id = ?1 AND to_member_id = ?2 AND kind = 'result_ready'
               AND delivery_status IN ('pending', 'delivered', 'failed')",
            params![task_id, leader_member_id],
        )?;
        if let (Some(message_id), Some(assignee_member_id)) =
            (message_id.as_deref(), assignee_member_id.as_deref())
        {
            transaction.execute(
                "INSERT INTO team_messages
                 (id, team_id, from_member_id, to_member_id, kind, task_id, body)
                 VALUES (?1, ?2, ?3, ?4, 'changes_requested', ?5, ?6)",
                params![
                    message_id,
                    team_id,
                    leader_member_id,
                    assignee_member_id,
                    task_id,
                    feedback.unwrap_or("Changes requested").trim()
                ],
            )?;
        }
        transaction.execute(
            "INSERT INTO team_activity_events
             (team_id, member_id, task_id, kind, summary, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                team_id,
                leader_member_id,
                task_id,
                if accept {
                    "task_result_accepted"
                } else {
                    "task_changes_requested"
                },
                title,
                feedback.map(str::trim)
            ],
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let team_id = task_team_id(&transaction, task_id)?;
        require_leader(&transaction, &team_id, leader_member_id)?;
        let dependencies_accepted: bool = transaction.query_row(
            "SELECT NOT EXISTS (
               SELECT 1 FROM team_task_dependencies dependencies
               JOIN team_tasks dependency ON dependency.id = dependencies.dependency_id
               WHERE dependencies.task_id = ?1 AND dependency.status != 'accepted'
             )",
            [task_id],
            |row| row.get(0),
        )?;
        let changed = transaction.execute(
            "UPDATE team_tasks SET status = ?2, assignee_member_id = NULL,
                    completion_required = 1, result = NULL, verification = NULL,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status IN ('failed', 'cancelled')",
            params![
                task_id,
                if dependencies_accepted {
                    TeamTaskStatus::Pending.as_str()
                } else {
                    TeamTaskStatus::Blocked.as_str()
                }
            ],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskUnavailable);
        }
        transaction.execute(
            "INSERT INTO team_activity_events
             (team_id, member_id, task_id, kind, summary)
             SELECT team_id, ?2, id, 'task_retried', title
             FROM team_tasks WHERE id = ?1",
            params![task_id, leader_member_id],
        )?;
        transaction.commit()?;
        drop(database);
        self.get_task(task_id)
    }

    pub fn cancel_task(
        &self,
        task_id: &str,
        leader_member_id: &str,
        reason: Option<&str>,
    ) -> Result<TeamTask, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let team_id = task_team_id(&transaction, task_id)?;
        require_leader(&transaction, &team_id, leader_member_id)?;
        let changed = transaction.execute(
            "UPDATE team_tasks
             SET status = 'cancelled', assignee_member_id = NULL,
                 completion_required = 0, verification = ?2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1 AND status != 'accepted'",
            params![
                task_id,
                reason.map(str::trim).filter(|value| !value.is_empty())
            ],
        )?;
        if changed == 0 {
            return Err(TeamError::TaskUnavailable);
        }
        transaction.execute(
            "UPDATE team_task_attempts
             SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE task_id = ?1
               AND status IN ('queued', 'running', 'needs_report', 'result_submitted')",
            [task_id],
        )?;
        transaction.execute(
            "UPDATE team_messages
             SET delivery_status = 'cancelled',
                 read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
             WHERE task_id = ?1
               AND delivery_status IN ('pending', 'delivered', 'failed')",
            [task_id],
        )?;
        transaction.execute(
            "INSERT INTO team_activity_events
             (team_id, member_id, task_id, kind, summary, metadata_json)
             SELECT team_id, ?2, id, 'task_cancelled', title, ?3
             FROM team_tasks WHERE id = ?1",
            params![task_id, leader_member_id, reason.map(str::trim)],
        )?;
        transaction.execute(
            "UPDATE teams SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [team_id],
        )?;
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
