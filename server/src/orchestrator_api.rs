//! Researcher-facing routes of the orchestrator (ADR 0217): what a round may
//! spend on execution, and where the conversation's requests have gone. Only
//! the researcher (the browser) can set limits; an agent has no such command.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app_state::AppState;
use crate::orchestrator::{OrchestratorError, Route, RouteState};
use crate::work_store::{Actor, PolicyPatch, RoundPolicy, RoundStats, WorkError};
use crate::workspace::WorkspaceError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/rounds/{round_id}/execution-policy",
            get(get_policy).put(set_policy),
        )
        .route("/projects/{project_id}/routes", get(list_routes))
        .route("/projects/{project_id}/deliveries", get(deliveries))
        .route(
            "/projects/{project_id}/routes/{route_id}/retry",
            axum::routing::post(retry_route),
        )
}

enum ApiError {
    Work(WorkError),
    Orchestrator(OrchestratorError),
    Workspace(WorkspaceError),
    RoundNotFound,
    BadRequest(&'static str),
}

impl From<WorkError> for ApiError {
    fn from(error: WorkError) -> Self {
        Self::Work(error)
    }
}

impl From<OrchestratorError> for ApiError {
    fn from(error: OrchestratorError) -> Self {
        Self::Orchestrator(error)
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
            Self::BadRequest(reason) => (
                StatusCode::BAD_REQUEST,
                "invalid_request",
                reason.to_owned(),
            ),
            Self::RoundNotFound => (
                StatusCode::NOT_FOUND,
                "round_not_found",
                "round not found".to_owned(),
            ),
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
            Self::Work(WorkError::Stale { current }) => {
                extra.insert("current_revision".into(), json!(current));
                (
                    StatusCode::CONFLICT,
                    "policy_revision_conflict",
                    format!("the limits changed (current revision {current})"),
                )
            }
            Self::Work(WorkError::Invalid(reason)) => {
                (StatusCode::BAD_REQUEST, "invalid_policy", reason.to_owned())
            }
            Self::Work(WorkError::Database(_) | WorkError::Json(_))
            | Self::Orchestrator(OrchestratorError::Database(_)) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "orchestration storage failed".to_owned(),
            ),
            Self::Work(error) => (StatusCode::CONFLICT, "work_state", error.to_string()),
            Self::Orchestrator(OrchestratorError::NotFound) => (
                StatusCode::NOT_FOUND,
                "route_not_found",
                "route not found".to_owned(),
            ),
            Self::Orchestrator(OrchestratorError::NotRetryable) => (
                StatusCode::CONFLICT,
                "route_not_retryable",
                OrchestratorError::NotRetryable.to_string(),
            ),
            Self::Orchestrator(OrchestratorError::TargetGone) => (
                StatusCode::CONFLICT,
                "route_target_gone",
                OrchestratorError::TargetGone.to_string(),
            ),
            Self::Orchestrator(OrchestratorError::RetryLimit) => (
                StatusCode::CONFLICT,
                "retry_limit",
                OrchestratorError::RetryLimit.to_string(),
            ),
            Self::Orchestrator(error) => (
                StatusCode::BAD_REQUEST,
                "invalid_routing",
                error.to_string(),
            ),
        };
        extra.insert("code".into(), json!(code));
        extra.insert("message".into(), json!(message));
        (status, Json(serde_json::Value::Object(extra))).into_response()
    }
}

#[derive(Debug, Serialize)]
struct PolicyResponse {
    policy: RoundPolicy,
    used: RoundStats,
}

fn check_round(state: &AppState, project_id: &str, round_id: &str) -> Result<(), ApiError> {
    state.workspace.project_path(project_id)?;
    state
        .research
        .round_by_id(project_id, round_id)
        .map(|_| ())
        .map_err(|_| ApiError::RoundNotFound)
}

fn view(state: &AppState, project_id: &str, round_id: &str) -> Result<PolicyResponse, ApiError> {
    Ok(PolicyResponse {
        policy: state.work.policy(project_id, round_id)?,
        used: state.work.round_stats(project_id, round_id)?,
    })
}

async fn get_policy(
    State(state): State<AppState>,
    Path((project_id, round_id)): Path<(String, String)>,
) -> Result<Json<PolicyResponse>, ApiError> {
    check_round(&state, &project_id, &round_id)?;
    Ok(Json(view(&state, &project_id, &round_id)?))
}

#[derive(Debug, Deserialize)]
struct SetPolicyRequest {
    expected_revision: u64,
    #[serde(flatten)]
    patch: PolicyPatch,
}

async fn set_policy(
    State(state): State<AppState>,
    Path((project_id, round_id)): Path<(String, String)>,
    Json(request): Json<SetPolicyRequest>,
) -> Result<Json<PolicyResponse>, ApiError> {
    check_round(&state, &project_id, &round_id)?;
    state.work.set_policy(
        &project_id,
        &round_id,
        request.expected_revision,
        request.patch,
        &Actor::Researcher,
    )?;
    Ok(Json(view(&state, &project_id, &round_id)?))
}

#[derive(Debug, Deserialize)]
struct RoutesQuery {
    state: Option<String>,
    limit: Option<usize>,
}

async fn list_routes(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<RoutesQuery>,
) -> Result<Json<Vec<Route>>, ApiError> {
    state.workspace.project_path(&project_id)?;
    let filter = match query.state.as_deref() {
        None => None,
        Some(value) => Some(RouteState::parse(value).ok_or(ApiError::Orchestrator(
            OrchestratorError::Invalid("state must be pending, delivered, or failed"),
        ))?),
    };
    Ok(Json(state.orchestrator.routes(
        &project_id,
        filter,
        query.limit.unwrap_or(50),
    )?))
}

/// Ids the delivery read accepts at once.
const MAX_DELIVERY_IDS: usize = 100;

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        && !id.contains("..")
}

#[derive(Debug, Deserialize)]
struct DeliveriesQuery {
    #[serde(default)]
    message_ids: String,
}

/// The delivery state of the researcher's messages, by id (ADR 0232).
async fn deliveries(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<DeliveriesQuery>,
) -> Result<Json<Vec<crate::orchestrator::MessageDelivery>>, ApiError> {
    state.workspace.project_path(&project_id)?;
    let ids: Vec<String> = query
        .message_ids
        .split(',')
        .map(str::trim)
        .map(str::to_owned)
        .collect();
    if ids.len() > MAX_DELIVERY_IDS {
        return Err(ApiError::BadRequest("ask for at most 100 messages"));
    }
    if !ids.iter().all(|id| safe_id(id)) {
        return Err(ApiError::BadRequest("message ids are malformed"));
    }
    let deliveries =
        tokio::task::spawn_blocking(move || state.orchestrator.deliveries_for(&project_id, &ids))
            .await
            .map_err(|_| ApiError::BadRequest("deliveries could not be read"))??;
    Ok(Json(deliveries))
}

#[derive(Debug, Serialize)]
struct RetryResponse {
    route: Route,
    /// False when the route was not failed (already retried, or moving).
    retried: bool,
    /// The delivery of the message it carries, when it carries one.
    delivery: Option<crate::orchestrator::MessageDelivery>,
}

/// The researcher re-arms a failed route they originated (ADR 0232).
async fn retry_route(
    State(state): State<AppState>,
    Path((project_id, route_id)): Path<(String, String)>,
) -> Result<Json<RetryResponse>, ApiError> {
    state.workspace.project_path(&project_id)?;
    let response = tokio::task::spawn_blocking(move || -> Result<RetryResponse, ApiError> {
        let (route, retried) = match state.orchestrator.retry_route(&project_id, &route_id)? {
            crate::orchestrator::RetryOutcome::Requeued(route) => (route, true),
            crate::orchestrator::RetryOutcome::AlreadyMoving(route) => (route, false),
        };
        let delivery = if route.source_kind == crate::orchestrator::SourceKind::Message {
            state
                .orchestrator
                .deliveries_for(&project_id, std::slice::from_ref(&route.source_id))?
                .into_iter()
                .next()
        } else {
            None
        };
        Ok(RetryResponse {
            route,
            retried,
            delivery,
        })
    })
    .await
    .map_err(|_| ApiError::BadRequest("the route could not be retried"))??;
    Ok(Json(response))
}
