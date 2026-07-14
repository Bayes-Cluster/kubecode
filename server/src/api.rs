use std::path::Path as FileSystemPath;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use serde::{Deserialize, Serialize};
use tower_http::services::{ServeDir, ServeFile};

use crate::workspace::{EntryKind, WorkspaceError, WorkspaceService};

const API_PATH: &str = "/api/v1";

#[derive(Clone)]
pub struct AppState {
    pub workspace: Arc<WorkspaceService>,
}

impl AppState {
    pub fn new(workspace: Arc<WorkspaceService>) -> Self {
        Self { workspace }
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
        .route_service("/", ServeFile::new(index_file))
        .fallback_service(service);
    root_router(application, base_path)
}

fn api_router(state: AppState) -> Router {
    Router::new()
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{project_id}", delete(unregister_project))
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
        .with_state(state)
}

fn root_router(application: Router, base_path: &str) -> Router {
    let base_path = normalize_base_path(base_path);

    let router = Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(health));
    if base_path.is_empty() {
        router.merge(application)
    } else {
        router.nest(&base_path, application)
    }
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
    Create { parent: String, name: String },
    Import { path: String, name: Option<String> },
}

async fn create_project(
    State(state): State<AppState>,
    Json(request): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let project = match request {
        CreateProjectRequest::Create { parent, name } => {
            state.workspace.create_project(&parent, &name)?
        }
        CreateProjectRequest::Import { path, name } => {
            state.workspace.import_project(&path, name.as_deref())?
        }
    };
    Ok((StatusCode::CREATED, Json(project)))
}

async fn unregister_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.workspace.unregister_project(&project_id)?;
    Ok(StatusCode::NO_CONTENT)
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
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<StatusCode, ApiError> {
    state.workspace.delete_entry(&project_id, &query.path)?;
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
    Ok(Json(state.workspace.write_text(
        &project_id,
        &query.path,
        &request.content,
        &request.revision,
    )?))
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

struct ApiError(WorkspaceError);

impl From<WorkspaceError> for ApiError {
    fn from(error: WorkspaceError) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match &self.0 {
            WorkspaceError::InvalidPath(_)
            | WorkspaceError::UnsupportedText
            | WorkspaceError::FileTooLarge => (StatusCode::BAD_REQUEST, "invalid_path"),
            WorkspaceError::ProjectNotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            WorkspaceError::DuplicateProject(_) => (StatusCode::CONFLICT, "duplicate_project"),
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
        };
        (
            status,
            Json(ErrorBody {
                code,
                message: self.0.to_string(),
            }),
        )
            .into_response()
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
