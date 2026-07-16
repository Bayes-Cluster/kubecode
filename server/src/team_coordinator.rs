use std::sync::Arc;

use thiserror::Error;

use crate::agents::{AgentId, AgentStore, Conversation, ExecutionMode, StoreError};
use crate::teams::{
    MemberWorkspaceMode, NewTeammate, Team, TeamError, TeamMember, TeamMessageKind, TeamRole,
    TeamStore,
};
use crate::workspace::{WorkspaceError, WorkspaceService};

pub struct SpawnTeammate<'a> {
    pub team_id: &'a str,
    pub caller_member_id: &'a str,
    pub agent_id: AgentId,
    pub name: &'a str,
    pub workspace_mode: MemberWorkspaceMode,
}

#[derive(Debug, Error)]
pub enum CoordinatorError {
    #[error(transparent)]
    Team(#[from] TeamError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
}

#[derive(Clone)]
pub struct TeamCoordinator {
    workspace: Arc<WorkspaceService>,
    agents: Arc<AgentStore>,
    teams: Arc<TeamStore>,
}

impl TeamCoordinator {
    pub fn new(
        workspace: Arc<WorkspaceService>,
        agents: Arc<AgentStore>,
        teams: Arc<TeamStore>,
    ) -> Self {
        Self {
            workspace,
            agents,
            teams,
        }
    }

    pub fn agent_store(&self) -> Arc<AgentStore> {
        Arc::clone(&self.agents)
    }

    pub fn spawn_teammate(&self, input: SpawnTeammate<'_>) -> Result<TeamMember, CoordinatorError> {
        let team = self.teams.get_team(input.team_id)?;
        let caller = self.teams.get_member(input.caller_member_id)?;
        ensure_leader(&team, &caller)?;

        let conversation =
            self.agents
                .create_conversation(&team.project_id, input.agent_id, Some(input.name))?;
        let conversation_id = conversation.id.clone();
        let conversation = match self.configure_workspace(&team, conversation, input.workspace_mode)
        {
            Ok(conversation) => conversation,
            Err(error) => {
                let _ = self.agents.delete_conversation(&conversation_id);
                return Err(error);
            }
        };
        let base_tree = self.capture_team_tree(&team)?;
        let member = self.teams.add_teammate(NewTeammate {
            team_id: &team.id,
            caller_member_id: &caller.id,
            conversation_id: &conversation.id,
            name: input.name,
            workspace_mode: input.workspace_mode,
            base_tree: base_tree.as_deref(),
        });
        if member.is_err() {
            let _ = self.agents.delete_conversation(&conversation.id);
        }
        member.map_err(CoordinatorError::from)
    }

    pub fn submit_result(
        &self,
        task_id: &str,
        member_id: &str,
        result: &str,
        verification: Option<&str>,
    ) -> Result<(), CoordinatorError> {
        let task = self.teams.submit_result(
            task_id,
            member_id,
            result,
            verification.unwrap_or_default(),
        )?;
        let team = self.teams.get_team(&task.team_id)?;
        self.teams.send_message(
            &team.id,
            member_id,
            &team.leader_member_id,
            TeamMessageKind::ResultReady,
            Some(task_id),
            result,
        )?;
        Ok(())
    }

    pub fn review_result(
        &self,
        task_id: &str,
        leader_member_id: &str,
        accept: bool,
        feedback: Option<&str>,
    ) -> Result<crate::teams::TeamTask, CoordinatorError> {
        let task = self.teams.get_task(task_id)?;
        let team = self.teams.get_team(&task.team_id)?;
        let leader = self.teams.get_member(leader_member_id)?;
        ensure_leader(&team, &leader)?;
        if accept && task.mutates_files {
            self.merge_isolated_result(&team, &task)?;
        }
        let reviewed = self
            .teams
            .review_result(task_id, leader_member_id, accept, feedback)?;
        if !accept && let Some(assignee) = reviewed.assignee_member_id.as_deref() {
            self.teams.send_message(
                &team.id,
                leader_member_id,
                assignee,
                TeamMessageKind::ChangesRequested,
                Some(task_id),
                feedback.unwrap_or("Changes requested"),
            )?;
        }
        Ok(reviewed)
    }

    fn configure_workspace(
        &self,
        team: &Team,
        mut conversation: Conversation,
        mode: MemberWorkspaceMode,
    ) -> Result<Conversation, CoordinatorError> {
        let workspace_path = match mode {
            MemberWorkspaceMode::Shared => team.workspace_path.clone(),
            MemberWorkspaceMode::Isolated => Some(
                self.workspace
                    .create_session_worktree_from(
                        &team.project_id,
                        &conversation.agent_session_id,
                        team.workspace_path.as_deref(),
                    )?
                    .to_string_lossy()
                    .into_owned(),
            ),
        };
        if let Some(workspace_path) = workspace_path {
            conversation = self.agents.assign_execution_workspace(
                &conversation.id,
                ExecutionMode::Worktree,
                Some(&workspace_path),
            )?;
        }
        Ok(conversation)
    }

    fn capture_team_tree(&self, team: &Team) -> Result<Option<String>, CoordinatorError> {
        let path = self
            .workspace
            .execution_path(&team.project_id, team.workspace_path.as_deref())?;
        self.workspace
            .capture_git_tree(&path, &format!("team-{}", team.id))
            .map_err(CoordinatorError::from)
    }

    fn merge_isolated_result(
        &self,
        team: &Team,
        task: &crate::teams::TeamTask,
    ) -> Result<(), CoordinatorError> {
        let Some(assignee_id) = task.assignee_member_id.as_deref() else {
            return Err(TeamError::TaskNotAssigned.into());
        };
        let member = self.teams.get_member(assignee_id)?;
        if member.workspace_mode != MemberWorkspaceMode::Isolated {
            return Ok(());
        }
        let base_tree = member.base_tree.as_deref().ok_or_else(|| {
            TeamError::InvalidStoredValue("isolated member has no base tree".into())
        })?;
        let conversation = self.agents.get_conversation(&member.conversation_id)?;
        let member_path = self
            .workspace
            .execution_path(&team.project_id, conversation.workspace_path.as_deref())?;
        let member_tree = self
            .workspace
            .capture_git_tree(&member_path, &format!("team-result-{}", task.id))?
            .ok_or_else(|| TeamError::InvalidStoredValue("member workspace is not Git".into()))?;
        let leader_path = self
            .workspace
            .execution_path(&team.project_id, team.workspace_path.as_deref())?;
        self.workspace
            .merge_isolated_tree(&leader_path, base_tree, &member_tree)?;
        Ok(())
    }
}

fn ensure_leader(team: &Team, member: &TeamMember) -> Result<(), TeamError> {
    if member.team_id != team.id {
        return Err(TeamError::WrongTeam);
    }
    if member.role != TeamRole::Leader {
        return Err(TeamError::LeaderRequired);
    }
    Ok(())
}
