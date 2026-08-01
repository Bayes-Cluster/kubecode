use std::collections::{BTreeMap, BTreeSet};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::AppState;
use super::error::{ApiError, SessionModeLockReason};
use super::runtime::project_available_commands;
use crate::agent_runtime::SessionConfigInput;
use crate::agents::{
    AgentId, AgentStore, Conversation, ConversationRevision, ExecutionMode, RunStatus, StoreError,
};
use crate::composer_catalog::ComposerCatalogSnapshot;
use crate::teams::{TeamError, TeamMode, TeamRole, TeamStatus};

#[derive(Debug, Deserialize)]
pub(super) struct CreateConversationRequest {
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

pub(super) async fn list_conversations(
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

pub(super) async fn create_conversation(
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
    if state.agents.is_available(conversation.agent_id)
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

pub(super) async fn list_provider_sessions(
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
pub(super) struct UpdateConversationRequest {
    manual_title: Option<String>,
    archived: Option<bool>,
}

pub(super) async fn update_conversation(
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

pub(super) async fn list_all_conversations(
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

pub(super) async fn delete_conversation(
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

pub(super) async fn fork_conversation(
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

pub(super) async fn branch_conversation_at_run(
    State(state): State<AppState>,
    Path((conversation_id, run_id)): Path<(String, String)>,
    Json(request): Json<BranchConversationRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.agent_runtime.store();
    let source = store.get_conversation(&conversation_id)?;
    let target = store.get_run(&run_id)?;
    if target.conversation_id != source.id {
        return Err(StoreError::RunNotFound(run_id).into());
    }
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

pub(super) async fn revise_conversation_at_run(
    State(state): State<AppState>,
    Path((conversation_id, run_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.agent_runtime.store();
    let source = store.get_conversation(&conversation_id)?;
    let (workspace_restore, workspace_restore_reason) = match store.run_checkpoint(&run_id)? {
        Some(checkpoint) if checkpoint.before_tree.is_some() && checkpoint.after_tree.is_some() => {
            let cwd = state
                .workspace
                .execution_path(&source.project_id, source.workspace_path.as_deref())?;
            match state.workspace.restore_git_tree(
                &cwd,
                checkpoint
                    .before_tree
                    .as_deref()
                    .expect("checked before tree"),
                checkpoint.after_tree.as_deref(),
            ) {
                Ok(()) => ("restored", None),
                Err(_) => ("kept", Some("workspace_changed")),
            }
        }
        _ => ("kept", Some("checkpoint_unavailable")),
    };
    state
        .agent_runtime
        .disconnect_conversation(&conversation_id)
        .await?;
    let revision = store.revise_conversation_at_run(&conversation_id, &run_id)?;
    Ok((
        StatusCode::CREATED,
        Json(ReviseConversationResponse {
            revision,
            workspace_restore,
            workspace_restore_reason,
        }),
    ))
}

#[derive(Debug, Serialize)]
struct ReviseConversationResponse {
    #[serde(flatten)]
    revision: ConversationRevision,
    workspace_restore: &'static str,
    workspace_restore_reason: Option<&'static str>,
}

pub(super) async fn list_conversation_revisions(
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
pub(super) struct BranchConversationRequest {
    #[serde(default = "default_true")]
    restore_files: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateTeamMemberRequest {
    agent_id: AgentId,
    #[serde(default)]
    isolated: bool,
}

pub(super) async fn create_team_member(
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
    if state.agents.is_available(member.agent_id) {
        state
            .agent_runtime
            .initialize_conversation(&member.id)
            .await?;
    }
    Ok((StatusCode::CREATED, Json(member)))
}

#[derive(Debug, Deserialize)]
pub(super) struct SideQuestionRequest {
    question: String,
}

pub(super) async fn ask_side_question(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<SideQuestionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let question = request.question.trim();
    if question.is_empty() {
        return Err(ApiError::InvalidRequest(
            "question must not be empty".into(),
        ));
    }
    let accepted = state
        .agent_runtime
        .ask_side_question(&conversation_id, question.to_owned())
        .await?;
    Ok((StatusCode::ACCEPTED, Json(accepted)))
}

#[derive(Debug, Serialize)]
struct SessionModeAccess {
    can_change: bool,
    reason: Option<SessionModeLockReason>,
}

impl Default for SessionModeAccess {
    fn default() -> Self {
        Self {
            can_change: true,
            reason: None,
        }
    }
}

#[derive(Debug, Serialize)]
struct SessionComposerState {
    catalog: ComposerCatalogSnapshot,
}

#[derive(Debug, Serialize)]
struct SessionState {
    capabilities: Option<serde_json::Value>,
    available_commands: Option<serde_json::Value>,
    current_mode: Option<serde_json::Value>,
    config_options: Option<serde_json::Value>,
    plan: Option<serde_json::Value>,
    usage: Option<serde_json::Value>,
    mode_access: SessionModeAccess,
    composer: SessionComposerState,
}

pub(super) async fn get_session_state(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.agent_runtime.store();
    let events = store.session_events_after(&conversation_id, 0)?;
    let mut session = SessionState {
        capabilities: None,
        available_commands: None,
        current_mode: None,
        config_options: None,
        plan: None,
        usage: None,
        mode_access: session_mode_access(&state, &conversation_id)?,
        composer: SessionComposerState {
            catalog: store.composer_catalog_snapshot(&conversation_id)?,
        },
    };
    let mut raw_available_commands = None;
    for event in events {
        match event.kind.as_str() {
            "capabilities" => session.capabilities = Some(event.payload),
            "available_commands" => raw_available_commands = Some(event.payload),
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
    session.available_commands = raw_available_commands
        .as_ref()
        .map(project_available_commands);
    Ok(Json(session))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum UpdateSessionOptionRequest {
    Mode {
        value: String,
    },
    Config {
        config_id: String,
        value: SessionConfigInput,
    },
}

pub(super) async fn update_session_option(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<UpdateSessionOptionRequest>,
) -> Result<StatusCode, ApiError> {
    let changes_mode = match &request {
        UpdateSessionOptionRequest::Mode { .. } => true,
        UpdateSessionOptionRequest::Config { config_id, .. } => {
            is_mode_config(&state.agent_runtime.store(), &conversation_id, config_id)?
        }
    };
    if changes_mode {
        let access = session_mode_access(&state, &conversation_id)?;
        if let Some(reason) = access.reason {
            return Err(ApiError::SessionModeLocked(reason));
        }
    }
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

fn session_mode_access(
    state: &AppState,
    conversation_id: &str,
) -> Result<SessionModeAccess, ApiError> {
    let conversation = state
        .agent_runtime
        .store()
        .get_conversation(conversation_id)?;
    let member = state.teams.member_for_conversation(conversation_id)?;
    if let Some(member) = member.as_ref() {
        let reason = match member.role {
            TeamRole::Teammate => Some(SessionModeLockReason::TeamTeammate),
            TeamRole::Discriminator => Some(SessionModeLockReason::TeamDiscriminator),
            TeamRole::Leader => None,
        };
        if let Some(reason) = reason {
            return Ok(locked_session_mode(reason));
        }
    }
    if conversation.read_only {
        return Ok(locked_session_mode(SessionModeLockReason::ReadOnly));
    }
    if let Some(team) = state.teams.team_for_conversation(conversation_id)?
        && team.mode == TeamMode::Yolo
        && conversation.agent_id != AgentId::OpenCode
    {
        return Ok(locked_session_mode(
            SessionModeLockReason::TeamYoloPermission,
        ));
    }
    if matches!(
        conversation.latest_run_status,
        Some(RunStatus::Running | RunStatus::WaitingPermission)
    ) {
        return Ok(locked_session_mode(SessionModeLockReason::ActiveRun));
    }
    Ok(SessionModeAccess::default())
}

fn locked_session_mode(reason: SessionModeLockReason) -> SessionModeAccess {
    SessionModeAccess {
        can_change: false,
        reason: Some(reason),
    }
}

fn is_mode_config(
    store: &AgentStore,
    conversation_id: &str,
    config_id: &str,
) -> Result<bool, ApiError> {
    if config_id.eq_ignore_ascii_case("mode") {
        return Ok(true);
    }
    let events = store.session_events_after(conversation_id, 0)?;
    Ok(events.iter().rev().any(|event| {
        let configs = event
            .payload
            .get("configOptions")
            .and_then(|value| value.as_array());
        configs.is_some_and(|configs| {
            configs.iter().any(|config| {
                config.get("id").and_then(|value| value.as_str()) == Some(config_id)
                    && config
                        .get("category")
                        .and_then(|value| value.as_str())
                        .is_some_and(|category| category.eq_ignore_ascii_case("mode"))
            })
        })
    }))
}
