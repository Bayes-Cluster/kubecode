use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::agent_discovery::{AgentCatalog, AgentDescriptor};
use crate::agent_runtime::{AgentRuntime, RuntimeError};
use crate::agents::{AgentStore, RunStatus};
use crate::git::GitService;
use crate::teams::{Team, TeamRole, TeamStore};
use crate::terminal::{TerminalEventSink, TerminalLifecycleEvent, TerminalManager};
use crate::workspace::WorkspaceService;

#[derive(Clone)]
pub struct AppState {
    pub workspace: Arc<WorkspaceService>,
    pub terminals: Arc<TerminalManager>,
    pub agents: Arc<AgentCatalog>,
    pub agent_runtime: Arc<AgentRuntime>,
    pub git: Arc<GitService>,
    pub teams: Arc<TeamStore>,
}

impl AppState {
    pub fn new(
        workspace: Arc<WorkspaceService>,
        agent_store: Arc<AgentStore>,
        teams: Arc<TeamStore>,
    ) -> Self {
        let agents = AgentCatalog::pending();
        let terminals = Arc::new(TerminalManager::with_catalog_and_events(
            Arc::clone(&workspace),
            8,
            2 * 1024 * 1024,
            Arc::clone(&agents),
            terminal_event_sink(Arc::clone(&agent_store)),
        ));
        let git = Arc::new(GitService::new(Arc::clone(&workspace)));
        let agent_runtime = Arc::new(
            AgentRuntime::with_catalog(Arc::clone(&workspace), agent_store, Arc::clone(&agents))
                .with_team_store(Arc::clone(&teams))
                .with_terminal_manager(Arc::clone(&terminals)),
        );
        Self {
            workspace,
            terminals,
            agents,
            agent_runtime,
            git,
            teams,
        }
    }

    pub fn with_agents(mut self, agents: Vec<AgentDescriptor>) -> Self {
        self = self.with_agent_catalog(AgentCatalog::from_descriptors(agents));
        self
    }

    pub fn with_agent_catalog(mut self, agents: Arc<AgentCatalog>) -> Self {
        self.terminals = Arc::new(TerminalManager::with_catalog_and_events(
            Arc::clone(&self.workspace),
            8,
            2 * 1024 * 1024,
            Arc::clone(&agents),
            terminal_event_sink(self.agent_runtime.store()),
        ));
        self.agent_runtime = Arc::new(
            AgentRuntime::with_catalog(
                Arc::clone(&self.workspace),
                self.agent_runtime.store(),
                Arc::clone(&agents),
            )
            .with_team_store(Arc::clone(&self.teams))
            .with_terminal_manager(Arc::clone(&self.terminals)),
        );
        self.agents = agents;
        self
    }

    pub fn with_team_mcp_http_origin(mut self, origin: impl Into<String>) -> Self {
        self.agent_runtime = Arc::new(
            self.agent_runtime
                .as_ref()
                .clone()
                .with_team_mcp_http_origin(origin),
        );
        self
    }

    pub fn start_team_supervisor(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let _ = state.reconcile_teams_once().await;
            }
        });
    }

    pub async fn reconcile_teams_once(&self) -> Result<(), RuntimeError> {
        self.teams
            .requeue_expired_deliveries(90)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let _ = self
            .agent_runtime
            .process_due_lifecycle_operations()
            .await?;
        let teams = self
            .teams
            .list_reconcilable_teams()
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        for team in teams {
            if team.status == crate::teams::TeamStatus::Disbanding {
                let _ = self.agent_runtime.disband_team_local_first(&team.id).await;
                continue;
            }
            let team = if team.status == crate::teams::TeamStatus::Starting {
                if team.mode == crate::teams::TeamMode::Yolo {
                    self.teams
                        .mark_permission_profile_applied(&team.leader_member_id, None)
                        .map_err(|error| RuntimeError::Acp(error.to_string()))?;
                }
                let activated = self
                    .teams
                    .activate_team(&team.id)
                    .map_err(|error| RuntimeError::Acp(error.to_string()))?;
                let _ = self.teams.send_message(
                    &activated.id,
                    &activated.leader_member_id,
                    &activated.leader_member_id,
                    crate::teams::TeamMessageKind::System,
                    None,
                    "Team startup was recovered after a server restart. Re-read Team context and continue coordination.",
                );
                activated
            } else {
                team
            };
            if matches!(
                team.status,
                crate::teams::TeamStatus::Active | crate::teams::TeamStatus::Verifying
            ) {
                self.recover_starting_team_members(&team).await;
                let _ = self.agent_runtime.reconcile_team(&team.id);
                self.remind_idle_leader_without_progress(&team)?;
            }
        }
        Ok(())
    }

    async fn recover_starting_team_members(&self, team: &Team) {
        let Ok(members) = self.teams.list_members(&team.id) else {
            return;
        };
        for member in members
            .into_iter()
            .filter(|member| member.status == crate::teams::TeamMemberStatus::Starting)
        {
            let provisioning = self
                .teams
                .list_lifecycle_operations(&team.id)
                .ok()
                .and_then(|operations| {
                    operations.into_iter().rev().find(|operation| {
                        operation.kind == crate::teams::TeamLifecycleOperationKind::Provisioning
                            && operation.member_id.as_deref() == Some(member.id.as_str())
                    })
                });
            match self
                .agent_runtime
                .initialize_conversation(&member.conversation_id)
                .await
            {
                Ok(()) => {
                    let _ = self
                        .teams
                        .set_member_status(&member.id, crate::teams::TeamMemberStatus::Idle);
                    if let Some(operation) = provisioning {
                        let _ = self.teams.mark_lifecycle_operation_completed(&operation.id);
                    }
                }
                Err(error) => {
                    if let Some(operation) = provisioning {
                        let _ = self.teams.mark_lifecycle_operation_terminal_failure(
                            &operation.id,
                            &error.to_string(),
                        );
                    }
                    let _ = self.teams.append_activity(
                        &team.id,
                        Some(&member.id),
                        None,
                        "member_provision_failed",
                        &format!("Could not recover teammate {}", member.name),
                        None,
                    );
                    if member.role == TeamRole::Teammate {
                        let _ = self
                            .agent_runtime
                            .remove_team_member_local_first(
                                &team.id,
                                &team.leader_member_id,
                                &member.id,
                            )
                            .await;
                    } else {
                        let _ = self
                            .teams
                            .set_member_status(&member.id, crate::teams::TeamMemberStatus::Failed);
                    }
                }
            }
        }
    }

    fn remind_idle_leader_without_progress(&self, team: &Team) -> Result<(), RuntimeError> {
        if !self
            .teams
            .list_tasks(&team.id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?
            .is_empty()
        {
            return Ok(());
        }
        let activity = self
            .teams
            .list_activity(&team.id, 200)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let no_progress_attempts = activity
            .iter()
            .take_while(|item| item.kind != "team_started")
            .filter(|item| item.kind == "leader_no_progress")
            .count();
        if no_progress_attempts >= 3 {
            let _ = self.teams.mark_team_needs_attention(&team.id);
            let _ = self.agent_runtime.store().append_workspace_event(
                "team_attention_updated",
                Some(&team.project_id),
                None,
                None,
                &json!({"team_id":team.id, "reason":"leader_no_progress"}),
            );
            return Ok(());
        }
        let leader = self
            .teams
            .get_member(&team.leader_member_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let conversation = self
            .agent_runtime
            .store()
            .get_conversation(&leader.conversation_id)?;
        if matches!(
            conversation.latest_run_status,
            Some(RunStatus::Running | RunStatus::WaitingPermission)
        ) {
            return Ok(());
        }
        self.teams
            .send_message(
                &team.id,
                &leader.id,
                &leader.id,
                crate::teams::TeamMessageKind::System,
                None,
                "The Team is active but has no concrete tasks. Re-read Team context, create the minimum useful task graph, and delegate work or ask the user only when a semantic decision is genuinely blocked.",
            )
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        self.teams
            .append_activity(
                &team.id,
                Some(&leader.id),
                None,
                "leader_no_progress",
                "Leader was reminded to establish the Team task graph",
                Some(&json!({"attempt":no_progress_attempts + 1}).to_string()),
            )
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let _ = self.agent_runtime.store().append_workspace_event(
            "team_leader_no_progress",
            Some(&team.project_id),
            Some(&leader.conversation_id),
            None,
            &json!({"team_id":team.id}),
        );
        let _ = self.agent_runtime.wake_team_leader(&team.id);
        Ok(())
    }
}

fn terminal_event_sink(store: Arc<AgentStore>) -> TerminalEventSink {
    Arc::new(move |event: TerminalLifecycleEvent| {
        let terminal = event.terminal;
        let _ = store.append_workspace_event(
            event.kind,
            Some(&terminal.project_id),
            None,
            None,
            &json!({
                "terminal_id": terminal.id,
                "status": terminal.status,
                "exit_code": terminal.exit_code,
                "signal": terminal.signal,
            }),
        );
    })
}
