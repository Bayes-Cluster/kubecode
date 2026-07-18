use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::convert::Infallible;
use std::path::Path as FileSystemPath;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use crate::agent_discovery::{AgentDescriptor, supported_agents_unavailable};
use crate::agent_runtime::{AgentRuntime, RuntimeError, StartAgentRun};
use crate::agents::{
    AgentEvent, AgentId, AgentStore, Conversation, ExecutionMode, RunStatus, StoreError,
    WorkspaceEvent,
};
use crate::git::{GitError, GitMutation, GitService};
use crate::teams::{TeamError, TeamRole, TeamStatus, TeamStore};
use crate::terminal::{
    TerminalError, TerminalEventSink, TerminalKind, TerminalLifecycleEvent, TerminalManager,
    TerminalSnapshot, TerminalStatus,
};
use crate::workspace::{DirectoryListing, EntryKind, WorkspaceError, WorkspaceService};

const API_PATH: &str = "/api/v1";

#[derive(Clone)]
pub struct AppState {
    pub workspace: Arc<WorkspaceService>,
    pub terminals: Arc<TerminalManager>,
    pub agents: Arc<Vec<AgentDescriptor>>,
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
        let terminals = Arc::new(TerminalManager::with_agents_and_events(
            Arc::clone(&workspace),
            8,
            2 * 1024 * 1024,
            Vec::new(),
            terminal_event_sink(Arc::clone(&agent_store)),
        ));
        let agents = supported_agents_unavailable();
        let git = Arc::new(GitService::new(Arc::clone(&workspace)));
        let agent_runtime = Arc::new(
            AgentRuntime::new(Arc::clone(&workspace), agent_store, agents.clone())
                .with_team_store(Arc::clone(&teams)),
        );
        Self {
            workspace,
            terminals,
            agents: Arc::new(agents),
            agent_runtime,
            git,
            teams,
        }
    }

    pub fn with_agents(mut self, agents: Vec<AgentDescriptor>) -> Self {
        self.terminals = Arc::new(TerminalManager::with_agents_and_events(
            Arc::clone(&self.workspace),
            8,
            2 * 1024 * 1024,
            agents.clone(),
            terminal_event_sink(self.agent_runtime.store()),
        ));
        self.agent_runtime = Arc::new(
            AgentRuntime::new(
                Arc::clone(&self.workspace),
                self.agent_runtime.store(),
                agents.clone(),
            )
            .with_team_store(Arc::clone(&self.teams)),
        );
        self.agents = Arc::new(agents);
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

    async fn recover_starting_team_members(&self, team: &crate::teams::Team) {
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

    fn remind_idle_leader_without_progress(
        &self,
        team: &crate::teams::Team,
    ) -> Result<(), RuntimeError> {
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

pub fn app_router(state: AppState, base_path: &str) -> Router {
    root_router(Router::new().nest(API_PATH, api_router(state)), base_path)
}

pub fn app_router_with_static(
    state: AppState,
    base_path: &str,
    static_directory: impl AsRef<FileSystemPath>,
) -> Router {
    let static_directory = static_directory.as_ref();
    let index_file = static_directory.join("index.html");
    let service =
        ServeDir::new(static_directory).not_found_service(ServeFile::new(index_file.clone()));
    let application = Router::new()
        .nest(API_PATH, api_router(state))
        .fallback_service(service);
    let base_path = normalize_base_path(base_path);
    if base_path.is_empty() {
        root_router(
            application.route_service("/", ServeFile::new(index_file)),
            &base_path,
        )
    } else {
        let index_path = format!("{base_path}/");
        let redirect_target = index_path.clone();
        health_router()
            .route(
                &base_path,
                get(move || {
                    let target = redirect_target.clone();
                    async move { Redirect::permanent(&target) }
                }),
            )
            .route_service(&index_path, ServeFile::new(index_file))
            .nest(&base_path, application)
    }
}

fn api_router(state: AppState) -> Router {
    Router::new()
        .route(
            "/team-mcp/{token}/{conversation_id}",
            axum::routing::any(crate::team_mcp::handle_http),
        )
        .route("/agents", get(list_agents))
        .route("/events", get(stream_workspace_events))
        .route("/events/cursor", get(get_workspace_event_cursor))
        .route("/sessions", get(list_all_conversations))
        .route("/filesystem/directories", get(list_directories))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{project_id}/runs", get(list_project_runs))
        .route(
            "/projects/{project_id}/agents/{agent_id}/sessions",
            get(list_provider_sessions),
        )
        .route(
            "/projects/{project_id}/conversations",
            get(list_conversations).post(create_conversation),
        )
        .route(
            "/projects/{project_id}/sessions",
            get(list_conversations).post(create_conversation),
        )
        .route(
            "/projects/{project_id}/conversations/{conversation_id}/runs",
            axum::routing::post(start_agent_run),
        )
        .route(
            "/projects/{project_id}/sessions/{conversation_id}/runs",
            axum::routing::post(start_agent_run),
        )
        .route(
            "/conversations/{conversation_id}/runs",
            get(list_conversation_runs),
        )
        .route(
            "/sessions/{conversation_id}/runs",
            get(list_conversation_runs),
        )
        .route(
            "/sessions/{conversation_id}",
            axum::routing::patch(update_conversation).delete(delete_conversation),
        )
        .route(
            "/sessions/{conversation_id}/fork",
            axum::routing::post(fork_conversation),
        )
        .route(
            "/sessions/{conversation_id}/turns/{run_id}/branch",
            axum::routing::post(branch_conversation_at_run),
        )
        .route(
            "/sessions/{conversation_id}/turns/{run_id}/revise",
            axum::routing::post(revise_conversation_at_run),
        )
        .route(
            "/sessions/{conversation_id}/revisions",
            get(list_conversation_revisions),
        )
        .route(
            "/sessions/{conversation_id}/team-members",
            axum::routing::post(create_team_member),
        )
        .route(
            "/sessions/{conversation_id}/events",
            get(list_session_events),
        )
        .route("/sessions/{conversation_id}/state", get(get_session_state))
        .route(
            "/sessions/{conversation_id}/options",
            axum::routing::patch(update_session_option),
        )
        .route(
            "/runs/{run_id}",
            get(get_agent_run).delete(cancel_agent_run),
        )
        .route("/runs/{run_id}/events", get(list_agent_events))
        .route("/runs/{run_id}/events/stream", get(stream_agent_events))
        .route(
            "/permissions/{request_id}",
            axum::routing::post(resolve_permission),
        )
        .route(
            "/elicitations/{request_id}",
            axum::routing::post(resolve_elicitation),
        )
        .route("/projects/{project_id}", delete(unregister_project))
        .route(
            "/projects/{project_id}/workspaces",
            axum::routing::patch(update_project_workspaces),
        )
        .route(
            "/projects/{project_id}/workspaces/migration",
            get(get_workspace_migration).post(migrate_project_workspaces),
        )
        .route("/projects/{project_id}/git/status", get(git_status))
        .route(
            "/projects/{project_id}/git/init",
            axum::routing::post(git_initialize),
        )
        .route("/projects/{project_id}/git/diff", get(git_diff))
        .route(
            "/projects/{project_id}/git/mutate",
            axum::routing::post(git_mutate),
        )
        .route(
            "/projects/{project_id}/git/commit",
            axum::routing::post(git_commit),
        )
        .route(
            "/projects/{project_id}/terminals",
            get(list_terminals).post(create_terminal),
        )
        .route(
            "/terminals/{terminal_id}",
            delete(close_terminal).patch(rename_terminal),
        )
        .route(
            "/projects/{project_id}/terminals/{terminal_id}/attach",
            get(attach_terminal),
        )
        .route(
            "/projects/{project_id}/entries",
            get(list_entries)
                .post(create_entry)
                .patch(rename_entry)
                .delete(delete_entry),
        )
        .route(
            "/projects/{project_id}/file",
            get(read_file).put(write_file),
        )
        .merge(crate::team_api::routes())
        .with_state(state)
}

async fn list_agents(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.agents.as_ref().clone())
}

#[derive(Debug, Deserialize)]
struct CreateConversationRequest {
    agent_id: AgentId,
    title: Option<String>,
    provider_session_id: Option<String>,
    agent_title: Option<String>,
    workspace_mode: Option<ExecutionMode>,
}

#[derive(Debug, Serialize)]
struct ConversationSummary {
    #[serde(flatten)]
    conversation: Conversation,
    team_id: Option<String>,
    team_role: Option<TeamRole>,
    team_title: Option<String>,
    team_status: Option<TeamStatus>,
}

async fn list_conversations(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.workspace.project_path(&project_id)?;
    let conversations = state
        .agent_runtime
        .store()
        .list_conversations(&project_id)?;
    Ok(Json(conversation_summaries(&state, conversations)?))
}

async fn create_conversation(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateConversationRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state.workspace.project_path(&project_id)?;
    let store = state.agent_runtime.store();
    let mut conversation = if let Some(provider_session_id) = request.provider_session_id.as_deref()
    {
        let imported = store.create_imported_conversation(
            &project_id,
            request.agent_id,
            provider_session_id,
            request.agent_title.as_deref(),
        )?;
        if request
            .title
            .as_ref()
            .is_some_and(|title| !title.trim().is_empty())
        {
            store.set_manual_title(&imported.id, request.title.as_deref())?
        } else {
            imported
        }
    } else {
        store.create_conversation(&project_id, request.agent_id, request.title.as_deref())?
    };
    if request.provider_session_id.is_none()
        && request.workspace_mode == Some(ExecutionMode::Worktree)
    {
        let workspace_path = state
            .workspace
            .create_session_worktree(&project_id, &conversation.agent_session_id)?;
        conversation = store.assign_execution_workspace(
            &conversation.id,
            ExecutionMode::Worktree,
            Some(&workspace_path.to_string_lossy()),
        )?;
    }
    if state
        .agents
        .iter()
        .any(|agent| agent.id == conversation.agent_id && agent.available)
        && let Err(error) = state
            .agent_runtime
            .initialize_conversation(&conversation.id)
            .await
    {
        let _ = store.delete_conversation(&conversation.id);
        return Err(error.into());
    }
    Ok((
        StatusCode::CREATED,
        Json(store.get_conversation(&conversation.id)?),
    ))
}

async fn list_provider_sessions(
    State(state): State<AppState>,
    Path((project_id, agent_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let agent_id = agent_id
        .parse::<AgentId>()
        .map_err(|_| ApiError::InvalidRequest("unsupported agent id".into()))?;
    Ok(Json(
        state
            .agent_runtime
            .list_provider_sessions(&project_id, agent_id)
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
struct UpdateConversationRequest {
    manual_title: Option<String>,
    archived: Option<bool>,
}

async fn update_conversation(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<UpdateConversationRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.agent_runtime.store();
    let conversation = if let Some(archived) = request.archived {
        store.set_archived(&conversation_id, archived)?
    } else {
        store.set_manual_title(&conversation_id, request.manual_title.as_deref())?
    };
    Ok(Json(conversation))
}

async fn list_all_conversations(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let conversations = state.agent_runtime.store().list_all_conversations()?;
    Ok(Json(conversation_summaries(&state, conversations)?))
}

fn conversation_summaries(
    state: &AppState,
    conversations: Vec<Conversation>,
) -> Result<Vec<ConversationSummary>, ApiError> {
    let project_ids = conversations
        .iter()
        .map(|conversation| conversation.project_id.clone())
        .collect::<BTreeSet<_>>();
    let mut memberships = BTreeMap::new();
    for project_id in project_ids {
        for team in state.teams.list_teams(&project_id)? {
            for member in state.teams.list_members(&team.id)? {
                memberships.insert(
                    member.conversation_id,
                    (
                        team.id.clone(),
                        member.role,
                        team.title.clone(),
                        team.status,
                    ),
                );
            }
        }
    }
    Ok(conversations
        .into_iter()
        .map(|conversation| {
            let membership = memberships.get(&conversation.id);
            ConversationSummary {
                team_id: membership.map(|(team_id, _, _, _)| team_id.clone()),
                team_role: membership.map(|(_, role, _, _)| *role),
                team_title: membership.map(|(_, _, title, _)| title.clone()),
                team_status: membership.map(|(_, _, _, status)| *status),
                conversation,
            }
        })
        .collect())
}

async fn get_workspace_event_cursor(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(json!({
        "cursor": state.agent_runtime.store().latest_workspace_event_id()?
    })))
}

async fn delete_conversation(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if let Some(team) = state.teams.team_for_conversation(&conversation_id)? {
        let member = state
            .teams
            .list_members(&team.id)?
            .into_iter()
            .find(|member| member.conversation_id == conversation_id)
            .ok_or_else(|| TeamError::MemberNotFound(conversation_id.clone()))?;
        if member.id != team.leader_member_id {
            return Err(ApiError::TeammateDeletionRequiresLeader);
        }
        let project_id = team.project_id.clone();
        let result = state
            .agent_runtime
            .disband_team_local_first(&team.id)
            .await?;
        let _ = state.agent_runtime.store().append_workspace_event(
            "team_disbanded",
            Some(&project_id),
            None,
            None,
            &json!({
                "team_id":result.team_id,
                "cleanup_operations":result.cleanup_operations.len(),
            }),
        );
    } else {
        state
            .agent_runtime
            .disconnect_conversation(&conversation_id)
            .await?;
        delete_session_with_revisions(&state, &conversation_id).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_session_with_revisions(
    state: &AppState,
    conversation_id: &str,
) -> Result<(), ApiError> {
    let revisions = state
        .agent_runtime
        .store()
        .list_revisions(conversation_id)?;
    for revision in revisions {
        state
            .agent_runtime
            .disconnect_conversation(&revision.snapshot_conversation_id)
            .await?;
        state
            .agent_runtime
            .delete_session(&revision.snapshot_conversation_id)
            .await?;
    }
    state.agent_runtime.delete_session(conversation_id).await?;
    Ok(())
}

async fn fork_conversation(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .agent_runtime
                .fork_provider_session(&conversation_id)
                .await?,
        ),
    ))
}

async fn branch_conversation_at_run(
    State(state): State<AppState>,
    Path((conversation_id, run_id)): Path<(String, String)>,
    Json(request): Json<BranchConversationRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.agent_runtime.store();
    let source = store.get_conversation(&conversation_id)?;
    if request.restore_files
        && let Some(checkpoint) = store.run_checkpoint(&run_id)?
        && let Some(before_tree) = checkpoint.before_tree
    {
        let cwd = state
            .workspace
            .execution_path(&source.project_id, source.workspace_path.as_deref())?;
        let expected = (source.execution_mode == ExecutionMode::Shared)
            .then_some(checkpoint.after_tree)
            .flatten();
        if source.execution_mode == ExecutionMode::Shared && expected.is_none() {
            return Err(ApiError::CheckpointUnavailable(
                "cannot safely restore a Shared workspace without an after-turn fingerprint".into(),
            ));
        }
        state
            .workspace
            .restore_git_tree(&cwd, &before_tree, expected.as_deref())?;
    }
    let conversation = store.branch_conversation_at_run(&conversation_id, &run_id)?;
    Ok((StatusCode::CREATED, Json(conversation)))
}

async fn revise_conversation_at_run(
    State(state): State<AppState>,
    Path((conversation_id, run_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    state
        .agent_runtime
        .disconnect_conversation(&conversation_id)
        .await?;
    let revision = state
        .agent_runtime
        .store()
        .revise_conversation_at_run(&conversation_id, &run_id)?;
    Ok((StatusCode::CREATED, Json(revision)))
}

async fn list_conversation_revisions(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .agent_runtime
            .store()
            .list_revisions(&conversation_id)?,
    ))
}

#[derive(Debug, Deserialize)]
struct BranchConversationRequest {
    #[serde(default = "default_true")]
    restore_files: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct CreateTeamMemberRequest {
    agent_id: AgentId,
    #[serde(default)]
    isolated: bool,
}

async fn create_team_member(
    State(state): State<AppState>,
    Path(parent_conversation_id): Path<String>,
    Json(request): Json<CreateTeamMemberRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.agent_runtime.store();
    let parent = store.get_conversation(&parent_conversation_id)?;
    let mut member =
        store.create_team_member(&parent_conversation_id, request.agent_id, request.isolated)?;
    if request.isolated {
        let workspace_path = state.workspace.create_session_worktree_from(
            &member.project_id,
            &member.agent_session_id,
            parent.workspace_path.as_deref(),
        )?;
        member = store.assign_execution_workspace(
            &member.id,
            ExecutionMode::Worktree,
            Some(&workspace_path.to_string_lossy()),
        )?;
    }
    if state
        .agents
        .iter()
        .any(|agent| agent.id == member.agent_id && agent.available)
    {
        state
            .agent_runtime
            .initialize_conversation(&member.id)
            .await?;
    }
    Ok((StatusCode::CREATED, Json(member)))
}

#[derive(Debug, Deserialize)]
struct StartRunRequest {
    message: String,
}

async fn start_agent_run(
    State(state): State<AppState>,
    Path((project_id, conversation_id)): Path<(String, String)>,
    Json(request): Json<StartRunRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if request.message.trim().is_empty() {
        return Err(ApiError::InvalidRequest("message must not be empty".into()));
    }
    let run = state.agent_runtime.start(StartAgentRun {
        conversation_id,
        project_id,
        message: request.message,
    })?;
    Ok((StatusCode::ACCEPTED, Json(run)))
}

async fn get_agent_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.agent_runtime.store().get_run(&run_id)?))
}

async fn list_conversation_runs(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state.agent_runtime.store().list_runs(&conversation_id)?,
    ))
}

async fn list_project_runs(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.workspace.project_path(&project_id)?;
    Ok(Json(
        state.agent_runtime.store().list_project_runs(&project_id)?,
    ))
}

async fn cancel_agent_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.agent_runtime.store().get_run(&run_id)?;
    if !state.agent_runtime.cancel(&run_id) {
        return Err(ApiError::RunNotActive(run_id));
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct ResolvePermissionRequest {
    option_id: String,
}

async fn resolve_permission(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    Json(request): Json<ResolvePermissionRequest>,
) -> Result<StatusCode, ApiError> {
    if request.option_id.trim().is_empty() {
        return Err(ApiError::InvalidRequest(
            "option_id must not be empty".into(),
        ));
    }
    let team_permission = if let Some(teams) = state.agent_runtime.team_store() {
        teams
            .resolve_permission_as_user(&request_id, &request.option_id)
            .map_err(|error| ApiError::InvalidRequest(error.to_string()))?
    } else {
        None
    };
    if !state
        .agent_runtime
        .resolve_permission(&request_id, &request.option_id)
    {
        return Err(ApiError::PermissionNotFound(request_id));
    }
    if let Some(permission) = team_permission
        && let Some(teams) = state.agent_runtime.team_store()
    {
        let _ = teams.append_activity(
            &permission.team_id,
            Some(&permission.member_id),
            None,
            "permission_user_resolved",
            "User resolved a teammate permission",
            None,
        );
        if let Ok(team) = teams.get_team(&permission.team_id) {
            let _ = state.agent_runtime.store().append_workspace_event(
                "team_permission_updated",
                Some(&team.project_id),
                Some(&permission.conversation_id),
                Some(&permission.run_id),
                &serde_json::json!({
                    "team_id": permission.team_id,
                    "request_id": permission.id,
                }),
            );
        }
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct ResolveElicitationRequest {
    content: Option<BTreeMap<String, agent_client_protocol::schema::v1::ElicitationContentValue>>,
}

async fn resolve_elicitation(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    Json(request): Json<ResolveElicitationRequest>,
) -> Result<StatusCode, ApiError> {
    if !state
        .agent_runtime
        .resolve_elicitation(&request_id, request.content)
    {
        return Err(ApiError::ElicitationNotFound(request_id));
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Default, Deserialize)]
struct EventQuery {
    #[serde(default)]
    after: u64,
}

async fn list_agent_events(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<impl IntoResponse, ApiError> {
    state.agent_runtime.store().get_run(&run_id)?;
    Ok(Json(
        state
            .agent_runtime
            .store()
            .events_after(&run_id, query.after)?,
    ))
}

async fn list_session_events(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .agent_runtime
            .store()
            .session_events_after(&conversation_id, query.after)?,
    ))
}

#[derive(Debug, Default, Serialize)]
struct SessionState {
    capabilities: Option<serde_json::Value>,
    available_commands: Option<serde_json::Value>,
    current_mode: Option<serde_json::Value>,
    config_options: Option<serde_json::Value>,
    plan: Option<serde_json::Value>,
    usage: Option<serde_json::Value>,
}

async fn get_session_state(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let events = state
        .agent_runtime
        .store()
        .session_events_after(&conversation_id, 0)?;
    let mut session = SessionState::default();
    for event in events {
        match event.kind.as_str() {
            "capabilities" => session.capabilities = Some(event.payload),
            "available_commands" => session.available_commands = Some(event.payload),
            "current_mode" => {
                if let (Some(current), Some(mode_id)) = (
                    session
                        .current_mode
                        .as_mut()
                        .and_then(|value| value.as_object_mut()),
                    event.payload.get("currentModeId"),
                ) {
                    current.insert("currentModeId".into(), mode_id.clone());
                } else {
                    session.current_mode = Some(event.payload);
                }
            }
            "config_options" => session.config_options = Some(event.payload),
            "session_loaded" | "session_created_state" => {
                if let Some(modes) = event.payload.get("modes") {
                    session.current_mode = Some(modes.clone());
                }
                if let Some(options) = event.payload.get("configOptions") {
                    session.config_options = Some(json!({"configOptions":options}));
                }
            }
            "plan" => session.plan = Some(event.payload),
            "usage" => session.usage = Some(event.payload),
            _ => {}
        }
    }
    Ok(Json(session))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum UpdateSessionOptionRequest {
    Mode {
        value: String,
    },
    Config {
        config_id: String,
        value: crate::agent_runtime::SessionConfigInput,
    },
}

async fn update_session_option(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<UpdateSessionOptionRequest>,
) -> Result<StatusCode, ApiError> {
    match request {
        UpdateSessionOptionRequest::Mode { value } => {
            state
                .agent_runtime
                .set_session_mode(&conversation_id, value)
                .await?;
        }
        UpdateSessionOptionRequest::Config { config_id, value } => {
            state
                .agent_runtime
                .set_session_config(&conversation_id, config_id, value)
                .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

struct AgentEventStreamState {
    store: Arc<AgentStore>,
    run_id: String,
    cursor: u64,
    pending: VecDeque<AgentEvent>,
}

struct WorkspaceEventStreamState {
    store: Arc<AgentStore>,
    cursor: u64,
    pending: VecDeque<WorkspaceEvent>,
}

async fn stream_workspace_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<EventQuery>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(query.after);
    let stream = futures_util::stream::unfold(
        WorkspaceEventStreamState {
            store: state.agent_runtime.store(),
            cursor,
            pending: VecDeque::new(),
        },
        |mut state| async move {
            loop {
                if let Some(workspace_event) = state.pending.pop_front() {
                    state.cursor = workspace_event.id;
                    let event = Event::default()
                        .id(workspace_event.id.to_string())
                        .event("workspace_event")
                        .json_data(&workspace_event)
                        .unwrap_or_else(|_| Event::default().event("serialization_error"));
                    return Some((Ok(event), state));
                }
                state.pending = state
                    .store
                    .workspace_events_after(state.cursor)
                    .unwrap_or_default()
                    .into();
                if state.pending.is_empty() {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn stream_agent_events(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let store = state.agent_runtime.store();
    store.get_run(&run_id)?;
    let stream = futures_util::stream::unfold(
        AgentEventStreamState {
            store,
            run_id,
            cursor: query.after,
            pending: VecDeque::new(),
        },
        |mut state| async move {
            loop {
                if let Some(agent_event) = state.pending.pop_front() {
                    state.cursor = agent_event.seq;
                    let event = Event::default()
                        .id(agent_event.seq.to_string())
                        .event(agent_event.kind.as_str())
                        .json_data(&agent_event)
                        .unwrap_or_else(|_| Event::default().event("serialization_error"));
                    return Some((Ok(event), state));
                }
                state.pending = state
                    .store
                    .events_after(&state.run_id, state.cursor)
                    .unwrap_or_default()
                    .into();
                if !state.pending.is_empty() {
                    continue;
                }
                let run = state.store.get_run(&state.run_id).ok()?;
                if !matches!(
                    run.status,
                    RunStatus::Running | RunStatus::WaitingPermission
                ) {
                    return None;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn root_router(application: Router, base_path: &str) -> Router {
    let base_path = normalize_base_path(base_path);

    let router = health_router();
    if base_path.is_empty() {
        router.merge(application)
    } else {
        router.nest(&base_path, application)
    }
}

fn health_router() -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(health))
}

async fn health() -> &'static str {
    "ok"
}

async fn list_projects(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.workspace.list_projects()?))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CreateProjectRequest {
    Create { path: String },
    Import { path: String },
}

async fn create_project(
    State(state): State<AppState>,
    Json(request): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let project = match request {
        CreateProjectRequest::Create { path } => state.workspace.create_project_at(path)?,
        CreateProjectRequest::Import { path } => state.workspace.import_project_at(path)?,
    };
    Ok((StatusCode::CREATED, Json(project)))
}

#[derive(Debug, Default, Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}

async fn list_directories(
    State(state): State<AppState>,
    Query(query): Query<DirectoryQuery>,
) -> Result<Json<DirectoryListing>, ApiError> {
    let requested = query.path.as_deref().map(FileSystemPath::new);
    Ok(Json(state.workspace.list_directories(requested)?))
}

async fn unregister_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.workspace.unregister_project(&project_id)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct UpdateProjectWorkspacesRequest {
    enabled: bool,
}

async fn update_project_workspaces(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<UpdateProjectWorkspacesRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if !request.enabled
        && state
            .agent_runtime
            .store()
            .list_conversations(&project_id)?
            .iter()
            .any(|conversation| conversation.workspace_path.is_some())
    {
        return Err(ApiError::WorkspaceMigration(
            "resolve existing worktrees before disabling Workspaces".into(),
        ));
    }
    Ok(Json(
        state
            .workspace
            .set_workspaces_enabled(&project_id, request.enabled)?,
    ))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WorkspaceMigrationStrategy {
    Merge,
    ExportPatch,
    Discard,
}

#[derive(Debug, Deserialize)]
struct WorkspaceMigrationResolution {
    conversation_id: String,
    strategy: WorkspaceMigrationStrategy,
}

#[derive(Debug, Deserialize)]
struct WorkspaceMigrationRequest {
    resolutions: Vec<WorkspaceMigrationResolution>,
}

#[derive(Debug, Serialize)]
struct WorkspaceMigrationItem {
    conversation_id: String,
    title: String,
    path: String,
    dirty: bool,
}

#[derive(Debug, Serialize)]
struct WorkspaceMigrationPreview {
    active_conversation_ids: Vec<String>,
    worktrees: Vec<WorkspaceMigrationItem>,
}

#[derive(Debug, Serialize)]
struct WorkspaceMigrationExport {
    conversation_id: String,
    path: String,
}

#[derive(Debug, Serialize)]
struct WorkspaceMigrationResponse {
    project: crate::workspace::Project,
    exports: Vec<WorkspaceMigrationExport>,
}

async fn get_workspace_migration(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<WorkspaceMigrationPreview>, ApiError> {
    state.workspace.project(&project_id)?;
    let conversations = state
        .agent_runtime
        .store()
        .list_conversations(&project_id)?;
    let active_conversation_ids = conversations
        .iter()
        .filter(|conversation| {
            matches!(
                conversation.latest_run_status,
                Some(RunStatus::Running | RunStatus::WaitingPermission)
            )
        })
        .map(|conversation| conversation.id.clone())
        .collect();
    let mut worktrees = Vec::new();
    for conversation in conversations {
        let Some(path) = conversation.workspace_path else {
            continue;
        };
        worktrees.push(WorkspaceMigrationItem {
            dirty: state.workspace.session_worktree_dirty(
                &project_id,
                &conversation.agent_session_id,
                &path,
            )?,
            conversation_id: conversation.id,
            title: conversation.title,
            path,
        });
    }
    Ok(Json(WorkspaceMigrationPreview {
        active_conversation_ids,
        worktrees,
    }))
}

async fn migrate_project_workspaces(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<WorkspaceMigrationRequest>,
) -> Result<Json<WorkspaceMigrationResponse>, ApiError> {
    let preview = get_workspace_migration(State(state.clone()), Path(project_id.clone()))
        .await?
        .0;
    if !preview.active_conversation_ids.is_empty() {
        return Err(ApiError::WorkspaceMigration(
            "stop active Agent runs before disabling Workspaces".into(),
        ));
    }
    let resolutions = request
        .resolutions
        .into_iter()
        .map(|resolution| (resolution.conversation_id, resolution.strategy))
        .collect::<BTreeMap<_, _>>();
    if preview
        .worktrees
        .iter()
        .any(|item| !resolutions.contains_key(&item.conversation_id))
    {
        return Err(ApiError::WorkspaceMigration(
            "every worktree requires merge, export patch, or discard".into(),
        ));
    }

    let store = state.agent_runtime.store();
    let mut exports = Vec::new();
    for item in preview.worktrees {
        state
            .agent_runtime
            .disconnect_conversation(&item.conversation_id)
            .await?;
        let conversation = store.get_conversation(&item.conversation_id)?;
        match resolutions
            .get(&item.conversation_id)
            .expect("migration resolution checked above")
        {
            WorkspaceMigrationStrategy::Merge => state.workspace.merge_session_worktree(
                &project_id,
                &conversation.agent_session_id,
                &item.path,
            )?,
            WorkspaceMigrationStrategy::ExportPatch => {
                let path = state.workspace.export_session_worktree(
                    &project_id,
                    &conversation.agent_session_id,
                    &item.path,
                )?;
                exports.push(WorkspaceMigrationExport {
                    conversation_id: item.conversation_id.clone(),
                    path: path.to_string_lossy().into_owned(),
                });
            }
            WorkspaceMigrationStrategy::Discard => state.workspace.discard_session_worktree(
                &project_id,
                &conversation.agent_session_id,
                &item.path,
            )?,
        }
        store.assign_execution_workspace(&item.conversation_id, ExecutionMode::Shared, None)?;
    }
    let project = state.workspace.set_workspaces_enabled(&project_id, false)?;
    Ok(Json(WorkspaceMigrationResponse { project, exports }))
}

async fn git_status(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.git.status(&project_id).await?))
}

async fn git_initialize(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let status = state.git.initialize(&project_id).await?;
    emit_project_event(&state, "git_changed", &project_id, json!({"action":"init"}));
    Ok((StatusCode::CREATED, Json(status)))
}

#[derive(Debug, Default, Deserialize)]
struct GitDiffQuery {
    path: String,
    #[serde(default)]
    staged: bool,
}

async fn git_diff(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<GitDiffQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(json!({
        "diff": state.git.diff(&project_id, &query.path, query.staged).await?
    })))
}

#[derive(Debug, Deserialize)]
struct GitMutationRequest {
    action: GitMutation,
    paths: Vec<String>,
}

async fn git_mutate(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<GitMutationRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let status = state
        .git
        .mutate(&project_id, request.action, &request.paths)
        .await?;
    emit_project_event(
        &state,
        "git_changed",
        &project_id,
        json!({"action":request.action}),
    );
    Ok(Json(status))
}

#[derive(Debug, Deserialize)]
struct GitCommitRequest {
    message: String,
}

async fn git_commit(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<GitCommitRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let status = state.git.commit(&project_id, &request.message).await?;
    emit_project_event(
        &state,
        "git_changed",
        &project_id,
        json!({"action":"commit"}),
    );
    Ok(Json(status))
}

fn emit_project_event(state: &AppState, kind: &str, project_id: &str, payload: serde_json::Value) {
    let _ = state.agent_runtime.store().append_workspace_event(
        kind,
        Some(project_id),
        None,
        None,
        &payload,
    );
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

#[derive(Debug, Default, Deserialize)]
struct EntryQuery {
    #[serde(default)]
    path: String,
}

async fn list_entries(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state.workspace.list_entries(&project_id, &query.path)?,
    ))
}

#[derive(Debug, Deserialize)]
struct CreateEntryRequest {
    path: String,
    kind: EntryKind,
}

async fn create_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateEntryRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .workspace
        .create_entry(&project_id, &request.path, request.kind)?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"path":request.path}),
    );
    Ok(StatusCode::CREATED)
}

#[derive(Debug, Deserialize)]
struct RenameEntryRequest {
    from: String,
    to: String,
}

async fn rename_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<RenameEntryRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .workspace
        .rename_entry(&project_id, &request.from, &request.to)?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"from":request.from, "to":request.to}),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<StatusCode, ApiError> {
    state.workspace.delete_entry(&project_id, &query.path)?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"path":query.path}),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn read_file(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.workspace.read_text(&project_id, &query.path)?))
}

#[derive(Debug, Deserialize)]
struct WriteFileRequest {
    content: String,
    revision: String,
}

async fn write_file(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
    Json(request): Json<WriteFileRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let document = state.workspace.write_text(
        &project_id,
        &query.path,
        &request.content,
        &request.revision,
    )?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"path":query.path}),
    );
    Ok(Json(document))
}

#[derive(Debug, Deserialize)]
struct CreateTerminalRequest {
    #[serde(default)]
    kind: TerminalKind,
    #[serde(default = "default_terminal_cols")]
    cols: u16,
    #[serde(default = "default_terminal_rows")]
    rows: u16,
}

#[derive(Debug, Deserialize)]
struct RenameTerminalRequest {
    title: String,
}

async fn list_terminals(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    Json(state.terminals.list(&project_id))
}

async fn create_terminal(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateTerminalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let terminal = state
        .terminals
        .create(&project_id, request.kind, request.cols, request.rows)?;
    emit_project_event(
        &state,
        "terminal_created",
        &project_id,
        json!({"terminal_id":terminal.id.clone()}),
    );
    Ok((StatusCode::CREATED, Json(terminal)))
}

async fn close_terminal(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let terminal = state.terminals.get(&terminal_id)?;
    state.terminals.close(&terminal_id)?;
    emit_project_event(
        &state,
        "terminal_closed",
        &terminal.project_id,
        json!({"terminal_id":terminal_id}),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn rename_terminal(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
    Json(request): Json<RenameTerminalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let terminal = state.terminals.rename(&terminal_id, &request.title)?;
    emit_project_event(
        &state,
        "terminal_updated",
        &terminal.project_id,
        json!({"terminal_id":terminal.id.clone()}),
    );
    Ok(Json(terminal))
}

#[derive(Debug, Default, Deserialize)]
struct TerminalAttachQuery {
    #[serde(default)]
    cursor: u64,
}

async fn attach_terminal(
    State(state): State<AppState>,
    Path((project_id, terminal_id)): Path<(String, String)>,
    Query(query): Query<TerminalAttachQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let terminal = state.terminals.get(&terminal_id)?;
    if terminal.project_id != project_id {
        return Err(ApiError::Terminal(TerminalError::NotFound(terminal_id)));
    }
    let manager = Arc::clone(&state.terminals);
    Ok(upgrade
        .on_upgrade(move |socket| terminal_socket(socket, manager, terminal.id, query.cursor)))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

async fn terminal_socket(
    mut socket: WebSocket,
    manager: Arc<TerminalManager>,
    terminal_id: String,
    mut cursor: u64,
) {
    match send_terminal_snapshot(&mut socket, &manager, &terminal_id, &mut cursor).await {
        Ok(false) => {}
        Ok(true) | Err(()) => return,
    }

    loop {
        tokio::select! {
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(message) = serde_json::from_str::<TerminalClientMessage>(text.as_str()) else {
                            continue;
                        };
                        let result = match message {
                            TerminalClientMessage::Input { data } => manager.write(&terminal_id, data.as_bytes()),
                            TerminalClientMessage::Resize { cols, rows } => manager.resize(&terminal_id, cols, rows),
                        };
                        if result.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                    Some(Ok(_)) => {}
                }
            }
            () = tokio::time::sleep(std::time::Duration::from_millis(40)) => {
                match send_terminal_snapshot(&mut socket, &manager, &terminal_id, &mut cursor).await {
                    Ok(false) => {}
                    Ok(true) | Err(()) => return,
                }
            }
        }
    }
}

async fn send_terminal_snapshot(
    socket: &mut WebSocket,
    manager: &TerminalManager,
    terminal_id: &str,
    cursor: &mut u64,
) -> Result<bool, ()> {
    let snapshot = manager.read_since(terminal_id, *cursor).map_err(|_| ())?;
    if !snapshot.data.is_empty() || snapshot.truncated {
        *cursor = snapshot.cursor;
        socket
            .send(Message::Text(terminal_output_json(snapshot).into()))
            .await
            .map_err(|_| ())?;
    }
    let terminal = manager.get(terminal_id).map_err(|_| ())?;
    if terminal.status != TerminalStatus::Exited {
        return Ok(false);
    }
    socket
        .send(Message::Text(terminal_status_json(&terminal).into()))
        .await
        .map_err(|_| ())?;
    Ok(true)
}

fn terminal_output_json(snapshot: TerminalSnapshot) -> String {
    json!({
        "type": "output",
        "data": snapshot.data,
        "cursor": snapshot.cursor,
        "truncated": snapshot.truncated,
    })
    .to_string()
}

fn terminal_status_json(terminal: &crate::terminal::TerminalInfo) -> String {
    json!({
        "type": "status",
        "status": terminal.status,
        "exit_code": terminal.exit_code,
        "signal": terminal.signal,
    })
    .to_string()
}

fn default_terminal_cols() -> u16 {
    80
}

fn default_terminal_rows() -> u16 {
    24
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

enum ApiError {
    Workspace(WorkspaceError),
    Terminal(TerminalError),
    AgentStore(StoreError),
    AgentRuntime(RuntimeError),
    InvalidRequest(String),
    RunNotActive(String),
    Git(GitError),
    PermissionNotFound(String),
    ElicitationNotFound(String),
    CheckpointUnavailable(String),
    WorkspaceMigration(String),
    Team(TeamError),
    TeammateDeletionRequiresLeader,
}

impl From<WorkspaceError> for ApiError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

impl From<TerminalError> for ApiError {
    fn from(error: TerminalError) -> Self {
        Self::Terminal(error)
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        Self::AgentStore(error)
    }
}

impl From<RuntimeError> for ApiError {
    fn from(error: RuntimeError) -> Self {
        Self::AgentRuntime(error)
    }
}

impl From<GitError> for ApiError {
    fn from(error: GitError) -> Self {
        Self::Git(error)
    }
}

impl From<TeamError> for ApiError {
    fn from(error: TeamError) -> Self {
        Self::Team(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            ApiError::Workspace(error) => {
                let (status, code) = workspace_error_status(&error);
                (status, code, error.to_string())
            }
            ApiError::Terminal(error) => {
                let (status, code) = match &error {
                    TerminalError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
                    TerminalError::LimitReached => (StatusCode::CONFLICT, "terminal_limit"),
                    TerminalError::AgentUnavailable(_) => {
                        (StatusCode::CONFLICT, "agent_unavailable")
                    }
                    TerminalError::InvalidTitle => (StatusCode::BAD_REQUEST, "invalid_title"),
                    TerminalError::Workspace(workspace) => workspace_error_status(workspace),
                    TerminalError::Pty(_) | TerminalError::Io(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, "terminal_error")
                    }
                };
                (status, code, error.to_string())
            }
            ApiError::AgentStore(error) => {
                let (status, code) = store_error_status(&error);
                (status, code, error.to_string())
            }
            ApiError::AgentRuntime(error) => match error {
                RuntimeError::AgentUnavailable(_) => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "agent_unavailable",
                    error.to_string(),
                ),
                RuntimeError::Store(store) => {
                    let (status, code) = store_error_status(&store);
                    (status, code, store.to_string())
                }
                RuntimeError::Workspace(workspace) => {
                    let (status, code) = workspace_error_status(&workspace);
                    (status, code, workspace.to_string())
                }
                RuntimeError::Acp(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "agent_error",
                    error.to_string(),
                ),
                RuntimeError::SessionDeletion(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "session_delete_failed",
                    error.to_string(),
                ),
                RuntimeError::AdapterUnavailable { .. } => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "agent_adapter_unavailable",
                    error.to_string(),
                ),
            },
            ApiError::InvalidRequest(message) => {
                (StatusCode::BAD_REQUEST, "invalid_request", message)
            }
            ApiError::RunNotActive(run_id) => (
                StatusCode::CONFLICT,
                "run_not_active",
                format!("run is not active: {run_id}"),
            ),
            ApiError::Git(error) => {
                let (status, code) = match &error {
                    GitError::InvalidPath(_) | GitError::EmptyMessage => {
                        (StatusCode::BAD_REQUEST, "invalid_request")
                    }
                    GitError::Workspace(workspace) => workspace_error_status(workspace),
                    GitError::Command(_) => (StatusCode::CONFLICT, "git_error"),
                    GitError::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, "git_error"),
                };
                (status, code, error.to_string())
            }
            ApiError::PermissionNotFound(request_id) => (
                StatusCode::NOT_FOUND,
                "permission_not_found",
                format!("permission request is no longer active: {request_id}"),
            ),
            ApiError::ElicitationNotFound(request_id) => (
                StatusCode::NOT_FOUND,
                "elicitation_not_found",
                format!("elicitation request is no longer active: {request_id}"),
            ),
            ApiError::CheckpointUnavailable(message) => {
                (StatusCode::CONFLICT, "checkpoint_unavailable", message)
            }
            ApiError::WorkspaceMigration(message) => (
                StatusCode::CONFLICT,
                "workspace_migration_required",
                message,
            ),
            ApiError::Team(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "team_error",
                error.to_string(),
            ),
            ApiError::TeammateDeletionRequiresLeader => (
                StatusCode::CONFLICT,
                "teammate_delete_requires_leader",
                "Team teammates can only be deleted by their Leader".to_owned(),
            ),
        };
        (status, Json(ErrorBody { code, message })).into_response()
    }
}

fn store_error_status(error: &StoreError) -> (StatusCode, &'static str) {
    match error {
        StoreError::ConversationNotFound(_) | StoreError::RunNotFound(_) => {
            (StatusCode::NOT_FOUND, "not_found")
        }
        StoreError::ActiveRun(_) => (StatusCode::CONFLICT, "active_run"),
        StoreError::InvalidStoredValue(_) | StoreError::Json(_) | StoreError::Database(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
        }
    }
}

fn workspace_error_status(error: &WorkspaceError) -> (StatusCode, &'static str) {
    match error {
        WorkspaceError::InvalidPath(_)
        | WorkspaceError::UnsupportedText
        | WorkspaceError::FileTooLarge => (StatusCode::BAD_REQUEST, "invalid_path"),
        WorkspaceError::ProjectNotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
        WorkspaceError::DuplicateProject(_) => (StatusCode::CONFLICT, "duplicate_project"),
        WorkspaceError::Git(_) => (StatusCode::CONFLICT, "git_worktree_error"),
        WorkspaceError::CheckpointConflict { .. } => (StatusCode::CONFLICT, "checkpoint_conflict"),
        WorkspaceError::Conflict { .. } => (StatusCode::CONFLICT, "revision_conflict"),
        WorkspaceError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::NOT_FOUND, "not_found")
        }
        WorkspaceError::Io(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            (StatusCode::CONFLICT, "already_exists")
        }
        WorkspaceError::Io(_) | WorkspaceError::Database(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
        }
    }
}

fn normalize_base_path(base_path: &str) -> String {
    let trimmed = base_path.trim().trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("/{trimmed}")
    }
}
