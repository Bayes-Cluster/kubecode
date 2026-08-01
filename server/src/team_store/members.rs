use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use uuid::Uuid;

use super::TeamStore;
use super::models::{
    MemberWorkspaceMode, NewDiscriminator, NewTeammate, TeamError, TeamMember, TeamMemberStatus,
    TeamMode, TeamRole, TeamStatus, is_unique_violation, normalized_name, sql_value_error,
};

impl TeamStore {
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
             VALUES (?1, ?2, ?3, ?4, 'teammate', 'starting', ?5, ?6)",
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_leader(&transaction, team_id, caller_member_id)?;
        match member_role(&transaction, team_id, teammate_id)? {
            TeamRole::Leader => return Err(TeamError::LeaderCannotBeRemoved),
            TeamRole::Discriminator => return Err(TeamError::DiscriminatorCannotWork),
            TeamRole::Teammate => {}
        }
        transaction.execute(
            "UPDATE team_members SET status = 'removing', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            [teammate_id],
        )?;
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
}

pub(crate) fn require_leader(
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

pub(crate) fn require_teammate(
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

pub(crate) fn member_role(
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

pub(crate) fn require_team_member(
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
