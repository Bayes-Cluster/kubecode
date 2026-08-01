use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

use super::TeamStore;
use super::models::{
    NewTeamProposal, TeamError, TeamProposal, TeamProposalStatus, sql_value_error,
};

impl TeamStore {
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
