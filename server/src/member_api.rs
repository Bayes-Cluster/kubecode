//! Workspace members over HTTP (ADR 0220): the roster, member setup, and the
//! server-wide defaults. Only the researcher (the browser) uses these; an
//! agent has no tool that adds, edits, removes, or reconfigures a member.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::agents::AgentId;
use crate::app_state::AppState;
use crate::member_store::{
    Binding, Member, MemberDefaults, MemberError, MemberPatch, MemberSpec, MemberTemplate,
    NewMember,
};
use crate::workspace::WorkspaceError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/members",
            get(list_members).post(create_member),
        )
        .route(
            "/projects/{project_id}/members/{member_id}",
            axum::routing::patch(update_member).delete(remove_member),
        )
        .route(
            "/projects/{project_id}/members/{member_id}/setup",
            post(retry_setup),
        )
        .route(
            "/projects/{project_id}/members/{member_id}/session",
            post(replace_session),
        )
        .route("/member-defaults", get(get_defaults).put(put_defaults))
}

enum ApiError {
    Member(MemberError),
    Workspace(WorkspaceError),
}

impl From<MemberError> for ApiError {
    fn from(error: MemberError) -> Self {
        Self::Member(error)
    }
}

impl From<WorkspaceError> for ApiError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut extra = serde_json::Map::new();
        let (status, code, message) = match self {
            Self::Workspace(WorkspaceError::ProjectNotFound(id)) => (
                StatusCode::NOT_FOUND,
                "not_found",
                format!("project not found: {id}"),
            ),
            Self::Workspace(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                error.to_string(),
            ),
            Self::Member(error) => match &error {
                MemberError::NotFound => {
                    (StatusCode::NOT_FOUND, "member_not_found", error.to_string())
                }
                MemberError::Invalid(_) => {
                    (StatusCode::BAD_REQUEST, "invalid_member", error.to_string())
                }
                MemberError::NameTaken => {
                    (StatusCode::CONFLICT, "member_name_taken", error.to_string())
                }
                MemberError::Stale { current } | MemberError::DefaultsStale { current } => {
                    extra.insert("current_revision".into(), json!(current));
                    (
                        StatusCode::CONFLICT,
                        "member_revision_conflict",
                        error.to_string(),
                    )
                }
                MemberError::TooMany => (StatusCode::CONFLICT, "member_limit", error.to_string()),
                MemberError::GeneralProtected => {
                    (StatusCode::CONFLICT, "general_protected", error.to_string())
                }
                MemberError::HoldsWork => {
                    (StatusCode::CONFLICT, "member_holds_work", error.to_string())
                }
                MemberError::Running => (StatusCode::CONFLICT, "member_running", error.to_string()),
                MemberError::Removed => (StatusCode::CONFLICT, "member_removed", error.to_string()),
                MemberError::Session(_) | MemberError::Database(_) | MemberError::Json(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "member storage failed".to_owned(),
                ),
            },
        };
        extra.insert("code".into(), json!(code));
        extra.insert("message".into(), json!(message));
        (status, Json(serde_json::Value::Object(extra))).into_response()
    }
}

/// The provider new members default to when nothing is configured: the first
/// installed one.
pub fn fallback_provider(state: &AppState) -> AgentId {
    [AgentId::ClaudeCode, AgentId::Codex, AgentId::OpenCode]
        .into_iter()
        .find(|agent| state.agent_runtime.agent_available(*agent))
        .unwrap_or(AgentId::ClaudeCode)
}

/// Makes sure the Workspace has its General Agent. Never fails the caller:
/// a roster read or project creation must not break on a provider problem,
/// which the member's setup state reports instead.
pub fn ensure_general(state: &AppState, project_id: &str) -> Option<Member> {
    let runtime = std::sync::Arc::clone(&state.agent_runtime);
    match state.members.ensure_general(
        project_id,
        &move |agent| runtime.agent_available(agent),
        fallback_provider(state),
    ) {
        Ok(member) => Some(member),
        Err(error) => {
            eprintln!("WARN: could not set up the General Agent of {project_id}: {error}");
            None
        }
    }
}

fn check_project(state: &AppState, project_id: &str) -> Result<(), ApiError> {
    state.workspace.project_path(project_id)?;
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
struct ListQuery {
    #[serde(default)]
    include_removed: bool,
}

#[derive(Debug, Serialize)]
struct Roster {
    members: Vec<Member>,
    /// The General Agent, when it has been set up.
    general_id: Option<String>,
}

async fn list_members(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Roster>, ApiError> {
    check_project(&state, &project_id)?;
    let roster = tokio::task::spawn_blocking(move || -> Result<Roster, ApiError> {
        // The first read of an existing Workspace gives it its manager.
        ensure_general(&state, &project_id);
        let members = state.members.list(&project_id, query.include_removed)?;
        let general_id = state.members.general(&project_id)?.map(|member| member.id);
        Ok(Roster {
            members,
            general_id,
        })
    })
    .await
    .map_err(|_| MemberError::Invalid("the roster could not be read"))??;
    Ok(Json(roster))
}

#[derive(Debug, Deserialize)]
struct CreateRequest {
    name: String,
    template: Option<MemberTemplate>,
    spec: Option<MemberSpec>,
    client_request_id: Option<String>,
}

async fn create_member(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateRequest>,
) -> Result<(StatusCode, Json<Member>), ApiError> {
    check_project(&state, &project_id)?;
    let member = tokio::task::spawn_blocking(move || -> Result<Member, ApiError> {
        ensure_general(&state, &project_id);
        let runtime = std::sync::Arc::clone(&state.agent_runtime);
        Ok(state.members.create_specialist(
            &project_id,
            NewMember {
                name: request.name,
                template: request.template,
                spec: request.spec,
                client_request_id: request.client_request_id,
            },
            &move |agent| runtime.agent_available(agent),
            fallback_provider(&state),
        )?)
    })
    .await
    .map_err(|_| MemberError::Invalid("the member could not be created"))??;
    Ok((StatusCode::CREATED, Json(member)))
}

#[derive(Debug, Deserialize)]
struct UpdateRequest {
    expected_revision: u64,
    #[serde(flatten)]
    patch: MemberPatch,
}

async fn update_member(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
    Json(request): Json<UpdateRequest>,
) -> Result<Json<Member>, ApiError> {
    check_project(&state, &project_id)?;
    let member = tokio::task::spawn_blocking(move || -> Result<Member, ApiError> {
        let runtime = std::sync::Arc::clone(&state.agent_runtime);
        Ok(state.members.update(
            &project_id,
            &member_id,
            request.expected_revision,
            request.patch,
            &move |agent| runtime.agent_available(agent),
        )?)
    })
    .await
    .map_err(|_| MemberError::Invalid("the member could not be changed"))??;
    Ok(Json(member))
}

async fn remove_member(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
) -> Result<Json<Member>, ApiError> {
    check_project(&state, &project_id)?;
    let member = tokio::task::spawn_blocking(move || state.members.remove(&project_id, &member_id))
        .await
        .map_err(|_| MemberError::Invalid("the member could not be removed"))??;
    Ok(Json(member))
}

async fn retry_setup(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
) -> Result<Json<Member>, ApiError> {
    check_project(&state, &project_id)?;
    let member = tokio::task::spawn_blocking(move || -> Result<Member, ApiError> {
        let runtime = std::sync::Arc::clone(&state.agent_runtime);
        let available = {
            let runtime = std::sync::Arc::clone(&runtime);
            move |agent| runtime.agent_available(agent)
        };
        let member = state.members.get(&project_id, &member_id)?;
        // A waiting manager follows the current defaults before it retries.
        let member = if member.role == crate::member_store::MemberRole::General {
            state
                .members
                .ensure_general(&project_id, &available, fallback_provider(&state))?
        } else {
            state
                .members
                .finish_setup(&project_id, &member_id, &available)?
        };
        // A Session that exists is tried with its configuration now, so a
        // rejected value is reported here instead of on the next delivery.
        if let Some(session) = member.public_conversation_id.as_deref() {
            let delivery = crate::orchestrator::runtime_member_delivery(
                runtime,
                std::sync::Arc::clone(&state.members),
            );
            let _ = delivery.apply_config(session);
        }
        Ok(state.members.get(&project_id, &member_id)?)
    })
    .await
    .map_err(|_| MemberError::Invalid("setup could not be retried"))??;
    Ok(Json(member))
}

#[derive(Debug, Default, Deserialize)]
struct ReplaceRequest {
    /// A new specification (a provider change is made by replacing the Session).
    spec: Option<MemberSpec>,
}

async fn replace_session(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
    body: Option<Json<ReplaceRequest>>,
) -> Result<Json<Member>, ApiError> {
    check_project(&state, &project_id)?;
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let member = tokio::task::spawn_blocking(move || -> Result<Member, ApiError> {
        let runtime = std::sync::Arc::clone(&state.agent_runtime);
        let before = state.members.get(&project_id, &member_id)?;
        let member = state.members.replace_session(
            &project_id,
            &member_id,
            Binding::Public,
            request.spec,
            &move |agent| runtime.agent_available(agent),
        )?;
        // Rounds the old Session coordinated move with the member to its new
        // Session, so replacing a manager's Session does not strand them.
        if let (Some(old), Some(new)) = (
            before.public_conversation_id.as_deref(),
            member.public_conversation_id.as_deref(),
        ) && old != new
        {
            for round in state
                .work
                .coordinated_rounds(&project_id, old)
                .unwrap_or_default()
            {
                if let Ok(Some(current)) = state.work.coordinator(&project_id, &round) {
                    let _ = state.work.handoff_coordinator(
                        &project_id,
                        &round,
                        current.epoch,
                        new,
                        "the project manager's Session was replaced",
                        &crate::work_store::Actor::Researcher,
                    );
                }
            }
        }
        Ok(member)
    })
    .await
    .map_err(|_| MemberError::Invalid("the Session could not be replaced"))??;
    Ok(Json(member))
}

async fn get_defaults(State(state): State<AppState>) -> Result<Json<MemberDefaults>, ApiError> {
    let defaults =
        tokio::task::spawn_blocking(move || state.members.defaults(fallback_provider(&state)))
            .await
            .map_err(|_| MemberError::Invalid("the defaults could not be read"))??;
    Ok(Json(defaults))
}

#[derive(Debug, Deserialize)]
struct DefaultsRequest {
    expected_revision: u64,
    general: MemberSpec,
    templates: std::collections::BTreeMap<MemberTemplate, String>,
}

async fn put_defaults(
    State(state): State<AppState>,
    Json(request): Json<DefaultsRequest>,
) -> Result<Json<MemberDefaults>, ApiError> {
    let defaults = tokio::task::spawn_blocking(move || {
        state.members.set_defaults(
            request.expected_revision,
            MemberDefaults {
                revision: request.expected_revision,
                general: request.general,
                templates: request.templates,
            },
        )
    })
    .await
    .map_err(|_| MemberError::Invalid("the defaults could not be saved"))??;
    Ok(Json(defaults))
}
