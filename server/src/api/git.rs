use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::json;

use super::AppState;
use super::emit_project_event;
use super::error::ApiError;
use crate::git::GitMutation;

pub(super) async fn git_status(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.git.status(&project_id).await?))
}

pub(super) async fn git_initialize(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let status = state.git.initialize(&project_id).await?;
    emit_project_event(&state, "git_changed", &project_id, json!({"action":"init"}));
    Ok((StatusCode::CREATED, Json(status)))
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct GitDiffQuery {
    path: String,
    #[serde(default)]
    staged: bool,
}

pub(super) async fn git_diff(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<GitDiffQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .git
            .diff(&project_id, &query.path, query.staged)
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub(super) struct GitMutationRequest {
    action: GitMutation,
    paths: Vec<String>,
}

pub(super) async fn git_mutate(
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
pub(super) struct GitCommitRequest {
    message: String,
}

pub(super) async fn git_commit(
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
