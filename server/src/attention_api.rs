//! What waits on the researcher, over HTTP (ADR 0232). Reads only: each
//! decision is still made on its own endpoint, which commits before replying,
//! so a refetch after the answer already omits it.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::attention::{AttentionDetail, AttentionSnapshot, Group, collect};
use crate::workspace::WorkspaceError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/attention", get(attention))
        .route("/attention/summary", get(summary))
}

/// A refusal from this API, kept small so handlers' `Result`s stay cheap to move.
struct AttentionError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl IntoResponse for AttentionError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"code": self.code, "message": self.message})),
        )
            .into_response()
    }
}

fn error(status: StatusCode, code: &'static str, message: String) -> AttentionError {
    AttentionError {
        status,
        code,
        message,
    }
}

fn workspace_error(failure: WorkspaceError) -> AttentionError {
    match failure {
        WorkspaceError::ProjectNotFound(id) => error_not_found(&id),
        other => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            other.to_string(),
        ),
    }
}

fn error_not_found(id: &str) -> AttentionError {
    error(
        StatusCode::NOT_FOUND,
        "not_found",
        format!("project not found: {id}"),
    )
}

async fn attention(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<AttentionSnapshot>, AttentionError> {
    state
        .workspace
        .project_path(&project_id)
        .map_err(workspace_error)?;
    let snapshot = tokio::task::spawn_blocking(move || collect(&state, &project_id))
        .await
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "attention could not be read".into(),
            )
        })?;
    Ok(Json(snapshot))
}

/// Counts for one Workspace, for the titlebar.
#[derive(Debug, Serialize)]
struct WorkspaceCounts {
    project_id: String,
    decisions: u32,
    setup: u32,
    permissions: u32,
    undelivered: u32,
    incomplete: bool,
}

#[derive(Debug, Serialize)]
struct Summary {
    cursor: u64,
    workspaces: Vec<WorkspaceCounts>,
}

fn counts(snapshot: &AttentionSnapshot) -> WorkspaceCounts {
    let mut counts = WorkspaceCounts {
        project_id: snapshot.project_id.clone(),
        decisions: 0,
        setup: 0,
        permissions: 0,
        undelivered: snapshot.undelivered.general
            + snapshot.undelivered.tasks.values().sum::<u32>(),
        incomplete: !snapshot.incomplete.is_empty(),
    };
    for item in &snapshot.items {
        match (&item.group, &item.detail) {
            (Group::Setup, _) => counts.setup += 1,
            (_, AttentionDetail::Permission { .. } | AttentionDetail::Input { .. }) => {
                counts.permissions += 1
            }
            _ => counts.decisions += 1,
        }
    }
    counts
}

async fn summary(State(state): State<AppState>) -> Result<Json<Summary>, AttentionError> {
    let summary = tokio::task::spawn_blocking(move || -> Result<Summary, WorkspaceError> {
        let cursor = state
            .agent_runtime
            .store()
            .latest_workspace_event_id()
            .unwrap_or(0);
        let workspaces = state
            .workspace
            .list_projects()?
            .into_iter()
            .map(|project| counts(&collect(&state, &project.id)))
            .collect();
        Ok(Summary { cursor, workspaces })
    })
    .await
    .map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "attention could not be read".into(),
        )
    })?
    .map_err(workspace_error)?;
    Ok(Json(summary))
}
