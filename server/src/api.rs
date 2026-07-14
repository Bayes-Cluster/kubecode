use std::path::Path as FileSystemPath;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use crate::agent_discovery::{AgentDescriptor, supported_agents_unavailable};
use crate::terminal::{TerminalError, TerminalManager, TerminalSnapshot};
use crate::workspace::{EntryKind, WorkspaceError, WorkspaceService};

const API_PATH: &str = "/api/v1";

#[derive(Clone)]
pub struct AppState {
    pub workspace: Arc<WorkspaceService>,
    pub terminals: Arc<TerminalManager>,
    pub agents: Arc<Vec<AgentDescriptor>>,
}

impl AppState {
    pub fn new(workspace: Arc<WorkspaceService>) -> Self {
        let terminals = Arc::new(TerminalManager::new(
            Arc::clone(&workspace),
            8,
            2 * 1024 * 1024,
        ));
        Self {
            workspace,
            terminals,
            agents: Arc::new(supported_agents_unavailable()),
        }
    }

    pub fn with_agents(mut self, agents: Vec<AgentDescriptor>) -> Self {
        self.agents = Arc::new(agents);
        self
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
        .route("/agents", get(list_agents))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{project_id}", delete(unregister_project))
        .route(
            "/projects/{project_id}/terminals",
            get(list_terminals).post(create_terminal),
        )
        .route("/terminals/{terminal_id}", delete(close_terminal))
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
        .with_state(state)
}

async fn list_agents(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.agents.as_ref().clone())
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

#[derive(Debug, Deserialize)]
struct CreateTerminalRequest {
    #[serde(default = "default_terminal_cols")]
    cols: u16,
    #[serde(default = "default_terminal_rows")]
    rows: u16,
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
        .create(&project_id, request.cols, request.rows)?;
    Ok((StatusCode::CREATED, Json(terminal)))
}

async fn close_terminal(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.terminals.close(&terminal_id)?;
    Ok(StatusCode::NO_CONTENT)
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
    if send_terminal_snapshot(&mut socket, &manager, &terminal_id, &mut cursor)
        .await
        .is_err()
    {
        return;
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
                if send_terminal_snapshot(&mut socket, &manager, &terminal_id, &mut cursor).await.is_err() {
                    return;
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
) -> Result<(), ()> {
    let snapshot = manager.read_since(terminal_id, *cursor).map_err(|_| ())?;
    if snapshot.data.is_empty() && !snapshot.truncated {
        return Ok(());
    }
    *cursor = snapshot.cursor;
    socket
        .send(Message::Text(terminal_output_json(snapshot).into()))
        .await
        .map_err(|_| ())
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
                    TerminalError::Workspace(workspace) => workspace_error_status(workspace),
                    TerminalError::Pty(_) | TerminalError::Io(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, "terminal_error")
                    }
                };
                (status, code, error.to_string())
            }
        };
        (status, Json(ErrorBody { code, message })).into_response()
    }
}

fn workspace_error_status(error: &WorkspaceError) -> (StatusCode, &'static str) {
    match error {
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
