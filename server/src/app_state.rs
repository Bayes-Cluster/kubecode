use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::agent_discovery::{AgentCatalog, AgentDescriptor};
use crate::agent_runtime::{AgentRuntime, RuntimeError};
use crate::agents::{AgentStore, RunStatus};
use crate::channel_store::ChannelStore;
use crate::experiment_runner::ExperimentRunner;
use crate::experiment_store::ExperimentStore;
use crate::git::GitService;
use crate::ilink::{ChannelBridge, ChannelBridgeConfig, ILinkService, IlinkServiceConfig};
use crate::orchestrator::{Orchestrator, RuntimeSink};
use crate::project_context::ProjectContext;
use crate::research_store::ResearchStore;
use crate::teams::{Team, TeamRole, TeamStore};
use crate::terminal::{TerminalEventSink, TerminalLifecycleEvent, TerminalManager};
use crate::work_store::WorkStore;
use crate::workspace::WorkspaceService;

#[derive(Clone)]
pub struct AppState {
    pub workspace: Arc<WorkspaceService>,
    pub terminals: Arc<TerminalManager>,
    pub agents: Arc<AgentCatalog>,
    pub agent_runtime: Arc<AgentRuntime>,
    pub git: Arc<GitService>,
    pub teams: Arc<TeamStore>,
    pub ilink: Arc<ILinkService>,
    pub research: Arc<ResearchStore>,
    pub experiments: Arc<ExperimentStore>,
    /// Workspace-owned research work (ADR 0215).
    pub work: Arc<WorkStore>,
    /// The Workspace conversation (ADR 0216).
    pub channels: Arc<ChannelStore>,
    /// The Workspace roster: members and the General Agent (ADR 0220).
    pub members: Arc<crate::member_store::MemberStore>,
    /// Tasks: admission by the General Agent and the researcher's review (ADR 0221).
    pub tasks: Arc<crate::task_store::TaskStore>,
    /// Routes intents of the conversation to Sessions (ADR 0217).
    pub orchestrator: Arc<Orchestrator>,
    pub experiment_runner: Arc<ExperimentRunner>,
    /// Read-only discovery over the stores above (ADR 0214).
    pub context: Arc<ProjectContext>,
    /// Serializes research round setup per round.
    pub research_locks: Arc<crate::research_api::KeyedLocks>,
    /// The running WeChat channel pipeline, once started.
    pub ilink_bridge: Arc<tokio::sync::Mutex<Option<Arc<ChannelBridge>>>>,
}

/// How long an acknowledged result may sit unanalyzed before it is re-raised,
/// and how many times, before the Team is flagged for attention.
pub const EXPERIMENT_REMINDER_SECS: i64 = 600;
pub const EXPERIMENT_MAX_REMINDERS: u32 = 3;

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
        let ilink = ILinkService::new(Arc::clone(&agent_store), IlinkServiceConfig::default());
        let research = Arc::new(
            ResearchStore::from_database(agent_store.database(), Arc::clone(&agent_store))
                .expect("research store"),
        );
        let experiments = Arc::new(
            ExperimentStore::from_database(agent_store.database(), Arc::clone(&agent_store))
                .expect("experiment store"),
        );
        let work = Arc::new(
            WorkStore::from_database(agent_store.database(), Arc::clone(&agent_store))
                .expect("work store"),
        );
        let channels = Arc::new(
            ChannelStore::from_database(agent_store.database(), Arc::clone(&agent_store))
                .expect("channel store"),
        );
        let members = Arc::new(
            crate::member_store::MemberStore::from_database(
                agent_store.database(),
                Arc::clone(&agent_store),
            )
            .expect("member store"),
        );
        work.set_assignment_guard(
            Arc::clone(&members) as Arc<dyn crate::work_store::AssignmentGuard>
        );
        let tasks = Arc::new(
            crate::task_store::TaskStore::from_database(
                agent_store.database(),
                Arc::clone(&agent_store),
                Arc::clone(&research),
                Arc::clone(&channels),
                Arc::clone(&members),
                Arc::clone(&work),
            )
            .expect("task store"),
        );
        let orchestrator = Arc::new(
            Orchestrator::new(
                agent_store.database(),
                Arc::clone(&agent_store),
                Arc::clone(&channels),
                Arc::clone(&work),
                Arc::clone(&research),
            )
            .expect("orchestrator"),
        );
        let experiment_runner = ExperimentRunner::new(
            Arc::clone(&experiments),
            Arc::clone(&workspace),
            Arc::clone(&teams),
        );
        let context = Arc::new(ProjectContext::new(
            Arc::clone(&agent_store),
            Arc::clone(&teams),
            Arc::clone(&research),
            Arc::clone(&experiments),
            Arc::clone(&work),
            Arc::clone(&channels),
            Arc::clone(&workspace),
        ));
        let agent_runtime = Arc::new(
            AgentRuntime::with_catalog(Arc::clone(&workspace), agent_store, Arc::clone(&agents))
                .with_team_store(Arc::clone(&teams))
                .with_research_store(Arc::clone(&research))
                .with_project_context(Arc::clone(&context))
                .with_work_services(crate::work_agent::WorkServices {
                    work: Arc::clone(&work),
                    channels: Arc::clone(&channels),
                    orchestrator: Arc::clone(&orchestrator),
                    members: Arc::clone(&members),
                    tasks: Arc::clone(&tasks),
                })
                .with_experiments(Arc::clone(&experiments), Arc::clone(&experiment_runner))
                .with_terminal_manager(Arc::clone(&terminals)),
        );
        let state = Self {
            workspace,
            terminals,
            agents,
            agent_runtime,
            git,
            teams,
            ilink,
            research,
            experiments,
            work,
            channels,
            members,
            tasks,
            orchestrator,
            experiment_runner,
            context,
            research_locks: Arc::default(),
            ilink_bridge: Arc::new(tokio::sync::Mutex::new(None)),
        };
        state.install_experiment_wake();
        state
    }

    /// Starts the iLink channel service supervisor: wires the inbound and
    /// outbound bridge (issue #131), then restores a persisted linked
    /// account (if any) without blocking startup (issue #127).
    pub fn start_ilink_service(&self) {
        let ilink = Arc::clone(&self.ilink);
        let runtime = Arc::clone(&self.agent_runtime);
        let slot = Arc::clone(&self.ilink_bridge);
        tokio::spawn(async move {
            match ChannelBridge::start(Arc::clone(&ilink), runtime, ChannelBridgeConfig::default())
                .await
            {
                Ok(bridge) => *slot.lock().await = Some(bridge),
                Err(error) => eprintln!("WARN: iLink bridge failed to start: {error}"),
            }
            if let Err(error) = ilink.restore_on_startup().await {
                eprintln!("WARN: iLink restore failed: {error}");
            }
        });
    }

    /// Graceful channel shutdown: stop the bridge (typing cancelled while
    /// credentials still work), then the service (polls aborted, cursor
    /// and credentials kept for the next start).
    pub async fn shutdown_ilink(&self) {
        if let Some(bridge) = self.ilink_bridge.lock().await.take() {
            bridge.shutdown().await;
        }
        self.ilink.shutdown().await;
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
            .with_research_store(Arc::clone(&self.research))
            .with_project_context(Arc::clone(&self.context))
            .with_work_services(crate::work_agent::WorkServices {
                work: Arc::clone(&self.work),
                channels: Arc::clone(&self.channels),
                orchestrator: Arc::clone(&self.orchestrator),
                members: Arc::clone(&self.members),
                tasks: Arc::clone(&self.tasks),
            })
            .with_experiments(
                Arc::clone(&self.experiments),
                Arc::clone(&self.experiment_runner),
            )
            .with_terminal_manager(Arc::clone(&self.terminals)),
        );
        self.agents = agents;
        self.install_experiment_wake();
        self
    }

    pub fn with_team_mcp_http_origin(mut self, origin: impl Into<String>) -> Self {
        self.agent_runtime = Arc::new(
            self.agent_runtime
                .as_ref()
                .clone()
                .with_team_mcp_http_origin(origin),
        );
        self.install_experiment_wake();
        self
    }

    /// Routes the conversation's intents and delivers due routes: promptly
    /// when a message with an intent is saved, and at least every few seconds
    /// so retries, expired leases, and a restart's leftovers are picked up.
    pub fn start_orchestrator(&self) {
        let state = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    _ = state.orchestrator.woken() => {}
                }
                let orchestrator = Arc::clone(&state.orchestrator);
                let sink = RuntimeSink::new(Arc::clone(&state.agent_runtime))
                    .with_members(Arc::clone(&state.members));
                let result = tokio::task::spawn_blocking(move || orchestrator.tick(&sink)).await;
                match result {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => eprintln!("WARN: orchestrator pass failed: {error}"),
                    Err(error) => eprintln!("WARN: orchestrator task failed: {error}"),
                }
            }
        });
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

    /// Wakes a Team's members when an experiment delivery commits. The hook
    /// holds the runtime weakly, so it never keeps a replaced runtime alive.
    fn install_experiment_wake(&self) {
        let runtime = Arc::downgrade(&self.agent_runtime);
        self.experiments.set_delivery_hook(move |team_id| {
            if let Some(runtime) = runtime.upgrade() {
                let _ = runtime.reconcile_team(team_id);
            }
        });
    }

    /// Backstops for experiment delivery: waits past their deadline expire
    /// into events, and results that were read but never analyzed are
    /// re-raised a bounded number of times before the Team is flagged.
    fn reconcile_experiments(&self) {
        let _ = self.experiments.expire_due_waits();
        let Ok(outcome) = self
            .experiments
            .remind_unanalyzed(EXPERIMENT_REMINDER_SECS, EXPERIMENT_MAX_REMINDERS)
        else {
            return;
        };
        for (team_id, experiment_id) in outcome.exhausted {
            let _ = self.teams.append_activity(
                &team_id,
                None,
                None,
                "experiment_unanalyzed",
                "An experiment result is still unanalyzed after repeated reminders",
                Some(&format!("{{\"experiment_id\":\"{experiment_id}\"}}")),
            );
            let _ = self.teams.mark_team_needs_attention(&team_id);
        }
    }

    pub async fn reconcile_teams_once(&self) -> Result<(), RuntimeError> {
        self.teams
            .requeue_expired_deliveries(90)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        self.reconcile_experiments();
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
