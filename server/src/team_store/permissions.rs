use rusqlite::{OptionalExtension, TransactionBehavior, params};

use super::TeamStore;
use super::members::{require_leader, require_team_member};
use super::models::{
    NewTeamPermissionRequest, TeamError, TeamPermissionRequest, TeamPermissionStatus,
    sql_value_error,
};

impl TeamStore {
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
