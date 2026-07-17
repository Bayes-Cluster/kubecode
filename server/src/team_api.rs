use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::agent_runtime::RuntimeError;
use crate::agents::{AgentId, Conversation, ExecutionMode, RunStatus, StoreError};
use crate::api::AppState;
use crate::teams::{
    MemberManagementPolicy, NewTeam, Team, TeamActivity, TeamError, TeamMember, TeamMemberStatus,
    TeamPermissionRequest, TeamProposal, TeamProposalStatus, TeamTask, TeamWorkspace,
};
use crate::workspace::WorkspaceError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/teams",
            get(list_teams).post(create_team),
        )
        .route("/teams/{team_id}", get(get_team))
        .route("/teams/{team_id}/settings", patch(update_team_settings))
        .route(
            "/teams/{team_id}/proposals/{proposal_id}/decision",
            post(resolve_team_proposal),
        )
        .route(
            "/sessions/{conversation_id}/promote-to-team",
            post(promote_to_team),
        )
}

#[derive(Debug, Deserialize)]
struct CreateTeamRequest {
    agent_id: AgentId,
    leader_name: String,
    title: Option<String>,
    #[serde(default)]
    workspace: TeamWorkspace,
}

#[derive(Debug, Deserialize)]
struct PromoteToTeamRequest {
    leader_name: String,
    title: Option<String>,
    workspace: Option<TeamWorkspace>,
}

#[derive(Debug, Deserialize)]
struct UpdateTeamSettingsRequest {
    member_management_policy: MemberManagementPolicy,
    max_parallel_runs: u8,
}

#[derive(Debug, Deserialize)]
struct ResolveProposalRequest {
    decision: TeamProposalStatus,
}

#[derive(Debug, Serialize)]
struct TeamRuntimeSummary {
    running: usize,
    queued: usize,
    needs_attention: usize,
    done: usize,
    total_tasks: usize,
}

#[derive(Debug, Serialize)]
struct TeamAttention {
    id: String,
    kind: &'static str,
    member_id: Option<String>,
    task_id: Option<String>,
    summary: String,
}

#[derive(Debug, Serialize)]
struct TeamSnapshot {
    team: Team,
    leader_conversation: Conversation,
    conversations: Vec<Conversation>,
    members: Vec<TeamMember>,
    tasks: Vec<TeamTask>,
    summary: TeamRuntimeSummary,
    proposal: Option<TeamProposal>,
    permissions: Vec<TeamPermissionRequest>,
    activity: Vec<TeamActivity>,
    attention: Vec<TeamAttention>,
}

async fn create_team(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateTeamRequest>,
) -> Result<impl IntoResponse, TeamApiError> {
    state.workspace.project_path(&project_id)?;
    let store = state.agent_runtime.store();
    let mut conversation =
        store.create_conversation(&project_id, request.agent_id, request.title.as_deref())?;
    if request.workspace == TeamWorkspace::Worktree {
        conversation = assign_worktree(&state, conversation)?;
    }
    let title = request
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&conversation.title);
    let team = state.teams.create_team(NewTeam {
        project_id: &project_id,
        leader_conversation_id: &conversation.id,
        agent_session_id: &conversation.agent_session_id,
        leader_name: &request.leader_name,
        title: Some(title),
        workspace: request.workspace,
        workspace_path: conversation.workspace_path.as_deref(),
    })?;
    if agent_is_available(&state, &conversation)
        && let Err(error) = state
            .agent_runtime
            .initialize_conversation(&conversation.id)
            .await
    {
        let _ = state.teams.delete_team(&team.id);
        let _ = store.delete_conversation(&conversation.id);
        return Err(error.into());
    }
    Ok((StatusCode::CREATED, Json(snapshot(&state, team)?)))
}

async fn promote_to_team(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<PromoteToTeamRequest>,
) -> Result<impl IntoResponse, TeamApiError> {
    if state
        .teams
        .team_for_conversation(&conversation_id)?
        .is_some()
    {
        return Err(TeamApiError::AlreadyInTeam(conversation_id));
    }
    let store = state.agent_runtime.store();
    let mut conversation = store.get_conversation(&conversation_id)?;
    let workspace = request.workspace.unwrap_or_else(|| {
        if conversation.execution_mode == ExecutionMode::Worktree {
            TeamWorkspace::Worktree
        } else {
            TeamWorkspace::Shared
        }
    });
    if workspace == TeamWorkspace::Worktree
        && conversation.execution_mode != ExecutionMode::Worktree
    {
        conversation = assign_worktree(&state, conversation)?;
    }
    let title = request
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&conversation.title);
    let team = state.teams.create_team(NewTeam {
        project_id: &conversation.project_id,
        leader_conversation_id: &conversation.id,
        agent_session_id: &conversation.agent_session_id,
        leader_name: &request.leader_name,
        title: Some(title),
        workspace,
        workspace_path: conversation.workspace_path.as_deref(),
    })?;
    Ok((StatusCode::CREATED, Json(snapshot(&state, team)?)))
}

async fn get_team(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<impl IntoResponse, TeamApiError> {
    let _ = state.agent_runtime.reconcile_team(&team_id);
    let team = state.teams.get_team(&team_id)?;
    Ok(Json(snapshot(&state, team)?))
}

async fn update_team_settings(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(request): Json<UpdateTeamSettingsRequest>,
) -> Result<impl IntoResponse, TeamApiError> {
    state.teams.update_team_settings(
        &team_id,
        request.member_management_policy,
        request.max_parallel_runs,
    )?;
    publish_team_event(&state, &team_id, "team_settings_updated");
    let team = state.teams.get_team(&team_id)?;
    Ok(Json(snapshot(&state, team)?))
}

async fn resolve_team_proposal(
    State(state): State<AppState>,
    Path((team_id, proposal_id)): Path<(String, String)>,
    Json(request): Json<ResolveProposalRequest>,
) -> Result<impl IntoResponse, TeamApiError> {
    state
        .teams
        .resolve_proposal(&team_id, &proposal_id, request.decision)?;
    state.teams.append_activity(
        &team_id,
        None,
        None,
        if request.decision == TeamProposalStatus::Approved {
            "proposal_approved"
        } else {
            "proposal_rejected"
        },
        if request.decision == TeamProposalStatus::Approved {
            "User approved the Team lineup"
        } else {
            "User rejected the Team lineup"
        },
        None,
    )?;
    publish_team_event(&state, &team_id, "team_proposal_updated");
    let team = state.teams.get_team(&team_id)?;
    Ok(Json(snapshot(&state, team)?))
}

async fn list_teams(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, TeamApiError> {
    state.workspace.project_path(&project_id)?;
    let teams = state.teams.list_teams(&project_id)?;
    for team in &teams {
        let _ = state.agent_runtime.reconcile_team(&team.id);
    }
    let snapshots = teams
        .into_iter()
        .filter_map(|team| match snapshot(&state, team) {
            Ok(snapshot) => Some(Ok(snapshot)),
            Err(TeamApiError::Store(StoreError::ConversationNotFound(_))) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(snapshots))
}

fn assign_worktree(
    state: &AppState,
    conversation: Conversation,
) -> Result<Conversation, TeamApiError> {
    let workspace_path = state
        .workspace
        .create_session_worktree(&conversation.project_id, &conversation.agent_session_id)?;
    state
        .agent_runtime
        .store()
        .assign_execution_workspace(
            &conversation.id,
            ExecutionMode::Worktree,
            Some(&workspace_path.to_string_lossy()),
        )
        .map_err(TeamApiError::from)
}

fn agent_is_available(state: &AppState, conversation: &Conversation) -> bool {
    state
        .agents
        .iter()
        .any(|agent| agent.id == conversation.agent_id && agent.available)
}

fn snapshot(state: &AppState, team: Team) -> Result<TeamSnapshot, TeamApiError> {
    let mut members = state.teams.list_members(&team.id)?;
    let conversations = members
        .iter()
        .map(|member| {
            state
                .agent_runtime
                .store()
                .get_conversation(&member.conversation_id)
        })
        .collect::<Result<Vec<_>, _>>()?;
    for member in &mut members {
        if let Some(conversation) = conversations
            .iter()
            .find(|conversation| conversation.id == member.conversation_id)
        {
            member.status = runtime_member_status(member.status, conversation.latest_run_status);
        }
    }
    let leader_conversation = conversations
        .iter()
        .find(|conversation| {
            members.iter().any(|member| {
                member.id == team.leader_member_id && member.conversation_id == conversation.id
            })
        })
        .cloned()
        .ok_or_else(|| {
            TeamApiError::Team(TeamError::MemberNotFound(team.leader_member_id.clone()))
        })?;
    let tasks = state.teams.list_tasks(&team.id)?;
    let attention = team_attention(&members, &tasks);
    let summary = TeamRuntimeSummary {
        running: members
            .iter()
            .filter(|member| member.status == TeamMemberStatus::Working)
            .count(),
        queued: members
            .iter()
            .filter(|member| member.status == TeamMemberStatus::Queued)
            .count(),
        needs_attention: attention.len(),
        done: tasks
            .iter()
            .filter(|task| task.status == crate::teams::TeamTaskStatus::Accepted)
            .count(),
        total_tasks: tasks.len(),
    };
    Ok(TeamSnapshot {
        leader_conversation,
        conversations,
        members,
        tasks,
        summary,
        proposal: state.teams.latest_proposal(&team.id)?,
        permissions: state.teams.pending_permission_requests(&team.id)?,
        activity: state.teams.list_activity(&team.id, 100)?,
        attention,
        team,
    })
}

fn runtime_member_status(
    stored: TeamMemberStatus,
    run_status: Option<RunStatus>,
) -> TeamMemberStatus {
    match run_status {
        Some(RunStatus::Running) => TeamMemberStatus::Working,
        Some(RunStatus::WaitingPermission) => TeamMemberStatus::WaitingPermission,
        Some(RunStatus::Failed | RunStatus::TimedOut) => TeamMemberStatus::Failed,
        _ if matches!(
            stored,
            TeamMemberStatus::Working | TeamMemberStatus::WaitingPermission
        ) =>
        {
            TeamMemberStatus::Idle
        }
        _ => stored,
    }
}

fn team_attention(members: &[TeamMember], tasks: &[TeamTask]) -> Vec<TeamAttention> {
    let member_attention = members.iter().filter_map(|member| {
        let (kind, summary) = match member.status {
            TeamMemberStatus::WaitingInput => {
                ("waiting_input", format!("{} needs input", member.name))
            }
            TeamMemberStatus::WaitingPermission => (
                "waiting_permission",
                format!("{} needs permission", member.name),
            ),
            TeamMemberStatus::Failed => ("failed", format!("{} failed", member.name)),
            TeamMemberStatus::Configuring => (
                "configuration",
                format!("{} needs configuration", member.name),
            ),
            _ => return None,
        };
        Some(TeamAttention {
            id: format!("member:{}:{kind}", member.id),
            kind,
            member_id: Some(member.id.clone()),
            task_id: None,
            summary,
        })
    });
    let task_attention = tasks.iter().filter_map(|task| {
        let kind = match task.status {
            crate::teams::TeamTaskStatus::ResultReview => "review",
            crate::teams::TeamTaskStatus::Failed => "failed",
            crate::teams::TeamTaskStatus::ChangesRequested => "changes_requested",
            _ => return None,
        };
        Some(TeamAttention {
            id: format!("task:{}:{kind}", task.id),
            kind,
            member_id: task.assignee_member_id.clone(),
            task_id: Some(task.id.clone()),
            summary: task.title.clone(),
        })
    });
    member_attention.chain(task_attention).collect()
}

fn publish_team_event(state: &AppState, team_id: &str, kind: &str) {
    let Ok(team) = state.teams.get_team(team_id) else {
        return;
    };
    let _ = state.agent_runtime.store().append_workspace_event(
        kind,
        Some(&team.project_id),
        None,
        None,
        &serde_json::json!({"team_id": team.id}),
    );
}

enum TeamApiError {
    Team(TeamError),
    Store(StoreError),
    Runtime(RuntimeError),
    Workspace(WorkspaceError),
    AlreadyInTeam(String),
}

impl From<TeamError> for TeamApiError {
    fn from(error: TeamError) -> Self {
        Self::Team(error)
    }
}

impl From<StoreError> for TeamApiError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<RuntimeError> for TeamApiError {
    fn from(error: RuntimeError) -> Self {
        Self::Runtime(error)
    }
}

impl From<WorkspaceError> for TeamApiError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

impl IntoResponse for TeamApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::Team(TeamError::TeamNotFound(message)) => {
                (StatusCode::NOT_FOUND, "team_not_found", message)
            }
            Self::Team(error @ (TeamError::MemberNotFound(_) | TeamError::TaskNotFound(_))) => {
                (StatusCode::NOT_FOUND, "not_found", error.to_string())
            }
            Self::Team(error @ (TeamError::LeaderRequired | TeamError::WrongTeam)) => {
                (StatusCode::FORBIDDEN, "team_forbidden", error.to_string())
            }
            Self::Team(error @ (TeamError::DuplicateMemberName(_) | TeamError::MemberLimit)) => {
                (StatusCode::CONFLICT, "team_conflict", error.to_string())
            }
            Self::Team(error @ (TeamError::TaskUnavailable | TeamError::TaskNotAssigned)) => {
                (StatusCode::CONFLICT, "task_conflict", error.to_string())
            }
            Self::Team(
                error @ (TeamError::InvalidConcurrency | TeamError::InvalidProposalDecision),
            ) => (
                StatusCode::BAD_REQUEST,
                "invalid_team_request",
                error.to_string(),
            ),
            Self::Team(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "team_error",
                error.to_string(),
            ),
            Self::Store(error) => (StatusCode::BAD_REQUEST, "session_error", error.to_string()),
            Self::Runtime(error) => (StatusCode::BAD_GATEWAY, "agent_error", error.to_string()),
            Self::Workspace(error) => (
                StatusCode::BAD_REQUEST,
                "workspace_error",
                error.to_string(),
            ),
            Self::AlreadyInTeam(session_id) => (
                StatusCode::CONFLICT,
                "already_in_team",
                format!("session already belongs to a team: {session_id}"),
            ),
        };
        (status, Json(ErrorBody { code, message })).into_response()
    }
}
