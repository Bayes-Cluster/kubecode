use std::collections::BTreeMap;
use std::path::Path as FileSystemPath;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::composer::run_workspace_operation;
use super::error::ApiError;
use crate::agents::{ExecutionMode, RunStatus};
use crate::workspace::{DirectoryListing, Project};

#[derive(Debug, Serialize)]
struct ProjectSummary {
    id: String,
    name: String,
    workspaces_enabled: bool,
}

impl From<Project> for ProjectSummary {
    fn from(project: Project) -> Self {
        Self {
            id: project.id,
            name: project.name,
            workspaces_enabled: project.workspaces_enabled,
        }
    }
}

pub(super) async fn list_projects(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .workspace
            .list_projects()?
            .into_iter()
            .map(ProjectSummary::from)
            .collect::<Vec<_>>(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum CreateProjectRequest {
    Create { path: String },
    Import { path: String },
}

#[derive(Debug, Deserialize)]
pub(super) struct AuthorizeProjectPathRequest {
    path: String,
}

pub(super) async fn create_project(
    State(state): State<AppState>,
    Json(request): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let project = match request {
        CreateProjectRequest::Create { path } => state.workspace.create_project_at(path)?,
        CreateProjectRequest::Import { path } => state.workspace.import_project_at(path)?,
    };
    Ok((StatusCode::CREATED, Json(ProjectSummary::from(project))))
}

pub(super) async fn authorize_project_path(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<AuthorizeProjectPathRequest>,
) -> Result<StatusCode, ApiError> {
    let workspace = Arc::clone(&state.workspace);
    run_workspace_operation(move || workspace.authorize_project_path(&project_id, request.path))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct DirectoryQuery {
    path: Option<String>,
}

pub(super) async fn list_directories(
    State(state): State<AppState>,
    Query(query): Query<DirectoryQuery>,
) -> Result<Json<DirectoryListing>, ApiError> {
    let requested = query.path.as_deref().map(FileSystemPath::new);
    Ok(Json(state.workspace.list_directories(requested)?))
}

pub(super) async fn unregister_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.workspace.unregister_project(&project_id)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateProjectWorkspacesRequest {
    enabled: bool,
}

pub(super) async fn update_project_workspaces(
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
    let project = state
        .workspace
        .set_workspaces_enabled(&project_id, request.enabled)?;
    Ok(Json(ProjectSummary::from(project)))
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
pub(super) struct WorkspaceMigrationRequest {
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
pub(super) struct WorkspaceMigrationPreview {
    active_conversation_ids: Vec<String>,
    worktrees: Vec<WorkspaceMigrationItem>,
}

#[derive(Debug, Serialize)]
struct WorkspaceMigrationExport {
    conversation_id: String,
    path: String,
}

#[derive(Debug, Serialize)]
pub(super) struct WorkspaceMigrationResponse {
    project: ProjectSummary,
    exports: Vec<WorkspaceMigrationExport>,
}

pub(super) async fn get_workspace_migration(
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

pub(super) async fn migrate_project_workspaces(
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
    Ok(Json(WorkspaceMigrationResponse {
        project: ProjectSummary::from(project),
        exports,
    }))
}
