//! Read-only Project context routes (ADR 0214): search, progressive read, and
//! availability resolution. The Project always comes from the route; nothing
//! here writes, starts an Agent, or changes authority.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::project_context::{
    ContextDocument, ContextError, ContextKind, ContextPage, ContextRef, Detail, ResolvedRef,
};
use crate::workspace::WorkspaceError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/context/search", get(search))
        .route("/projects/{project_id}/context/read", get(read))
        .route("/projects/{project_id}/context/resolve", post(resolve))
}

enum ContextApiError {
    Context(ContextError),
    Workspace(WorkspaceError),
    BadRequest(&'static str),
}

impl From<ContextError> for ContextApiError {
    fn from(error: ContextError) -> Self {
        Self::Context(error)
    }
}

impl From<WorkspaceError> for ContextApiError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

impl IntoResponse for ContextApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::Context(ContextError::NotFound) => (
                StatusCode::NOT_FOUND,
                "context_not_found",
                "context source not found".to_owned(),
            ),
            Self::Context(ContextError::Invalid(reason)) => (
                StatusCode::BAD_REQUEST,
                "invalid_context_request",
                reason.to_owned(),
            ),
            Self::Context(ContextError::Source(detail)) => {
                eprintln!("WARN: project context read failed: {detail}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "context storage failed".to_owned(),
                )
            }
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
            Self::BadRequest(reason) => (
                StatusCode::BAD_REQUEST,
                "invalid_context_request",
                reason.to_owned(),
            ),
        };
        (
            status,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response()
    }
}

/// Context reads touch SQLite and the filesystem synchronously, so they run
/// off the async workers.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ContextError> + Send + 'static,
) -> Result<T, ContextApiError> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => Ok(result?),
        Err(error) => Err(ContextApiError::Context(ContextError::Source(format!(
            "context task failed: {error}"
        )))),
    }
}

fn check_project(state: &AppState, project_id: &str) -> Result<(), ContextApiError> {
    state.workspace.project_path(project_id)?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: Option<String>,
    /// Comma-separated kinds; empty means every kind but `file`.
    kinds: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
}

async fn search(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<ContextPage>, ContextApiError> {
    check_project(&state, &project_id)?;
    let kinds = parse_kinds(query.kinds.as_deref())?;
    let context = Arc::clone(&state.context);
    Ok(Json(
        blocking(move || {
            context.search(
                &project_id,
                query.q.as_deref(),
                &kinds,
                query.limit,
                query.cursor.as_deref(),
            )
        })
        .await?,
    ))
}

fn parse_kinds(value: Option<&str>) -> Result<Vec<ContextKind>, ContextApiError> {
    value
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| {
            ContextKind::parse(part).ok_or(ContextApiError::BadRequest("unknown context kind"))
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct ReadQuery {
    kind: String,
    id: String,
    revision: Option<String>,
    detail: Option<String>,
    cursor: Option<String>,
}

async fn read(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<ReadQuery>,
) -> Result<Json<ContextDocument>, ContextApiError> {
    check_project(&state, &project_id)?;
    let kind = ContextKind::parse(&query.kind)
        .ok_or(ContextApiError::BadRequest("unknown context kind"))?;
    let detail = match query.detail.as_deref() {
        None => Detail::Summary,
        Some(value) => {
            Detail::parse(value).ok_or(ContextApiError::BadRequest("unknown detail level"))?
        }
    };
    let reference = ContextRef {
        kind,
        id: query.id,
        revision: query.revision,
    };
    let context = Arc::clone(&state.context);
    Ok(Json(
        blocking(move || context.read(&project_id, &reference, detail, query.cursor.as_deref()))
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
struct ResolveBody {
    refs: Vec<ContextRef>,
}

async fn resolve(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<ResolveBody>,
) -> Result<Json<Vec<ResolvedRef>>, ContextApiError> {
    check_project(&state, &project_id)?;
    let context = Arc::clone(&state.context);
    Ok(Json(
        blocking(move || context.resolve(&project_id, &body.refs)).await?,
    ))
}
