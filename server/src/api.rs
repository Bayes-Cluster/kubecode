use std::collections::VecDeque;
use std::convert::Infallible;
use std::path::Path as FileSystemPath;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use crate::agent_discovery::{AgentDescriptor, supported_agents_unavailable};
use crate::agent_runtime::{AgentRuntime, RuntimeError, StartAgentRun};
use crate::agents::{AgentEvent, AgentId, AgentStore, PermissionMode, RunStatus, StoreError};
use crate::terminal::{TerminalError, TerminalKind, TerminalManager, TerminalSnapshot};
use crate::workspace::{EntryKind, WorkspaceError, WorkspaceService};

const API_PATH: &str = "/api/v1";

#[derive(Clone)]
pub struct AppState {
    pub workspace: Arc<WorkspaceService>,
    pub terminals: Arc<TerminalManager>,
    pub agents: Arc<Vec<AgentDescriptor>>,
    pub agent_runtime: Arc<AgentRuntime>,
}

impl AppState {
    pub fn new(workspace: Arc<WorkspaceService>, agent_store: Arc<AgentStore>) -> Self {
        let terminals = Arc::new(TerminalManager::new(
            Arc::clone(&workspace),
            8,
            2 * 1024 * 1024,
        ));
        let agents = supported_agents_unavailable();
        let agent_runtime = Arc::new(AgentRuntime::new(
            Arc::clone(&workspace),
            agent_store,
            agents.clone(),
        ));
        Self {
            workspace,
            terminals,
            agents: Arc::new(agents),
            agent_runtime,
        }
    }

    pub fn with_agents(mut self, agents: Vec<AgentDescriptor>) -> Self {
        self.terminals = Arc::new(TerminalManager::with_agents(
            Arc::clone(&self.workspace),
            8,
            2 * 1024 * 1024,
            agents.clone(),
        ));
        self.agent_runtime = Arc::new(AgentRuntime::new(
            Arc::clone(&self.workspace),
            self.agent_runtime.store(),
            agents.clone(),
        ));
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
        .route(
            "/projects/{project_id}/conversations",
            get(list_conversations).post(create_conversation),
        )
        .route(
            "/projects/{project_id}/conversations/{conversation_id}/runs",
            axum::routing::post(start_agent_run),
        )
        .route(
            "/runs/{run_id}",
            get(get_agent_run).delete(cancel_agent_run),
        )
        .route("/runs/{run_id}/events", get(list_agent_events))
        .route("/runs/{run_id}/events/stream", get(stream_agent_events))
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

#[derive(Debug, Deserialize)]
struct CreateConversationRequest {
    agent_id: AgentId,
    title: Option<String>,
}

async fn list_conversations(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.workspace.project_path(&project_id)?;
    Ok(Json(
        state
            .agent_runtime
            .store()
            .list_conversations(&project_id)?,
    ))
}

async fn create_conversation(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateConversationRequest>,
) -> Result<impl IntoResponse, ApiError> {
    state.workspace.project_path(&project_id)?;
    let conversation = state.agent_runtime.store().create_conversation(
        &project_id,
        request.agent_id,
        request.title.as_deref(),
    )?;
    Ok((StatusCode::CREATED, Json(conversation)))
}

#[derive(Debug, Deserialize)]
struct StartRunRequest {
    message: String,
    permission_mode: PermissionMode,
}

async fn start_agent_run(
    State(state): State<AppState>,
    Path((project_id, conversation_id)): Path<(String, String)>,
    Json(request): Json<StartRunRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if request.message.trim().is_empty() {
        return Err(ApiError::InvalidRequest("message must not be empty".into()));
    }
    let run = state.agent_runtime.start(StartAgentRun {
        conversation_id,
        project_id,
        message: request.message,
        permission_mode: request.permission_mode,
    })?;
    Ok((StatusCode::ACCEPTED, Json(run)))
}

async fn get_agent_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.agent_runtime.store().get_run(&run_id)?))
}

async fn cancel_agent_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.agent_runtime.store().get_run(&run_id)?;
    if !state.agent_runtime.cancel(&run_id) {
        return Err(ApiError::RunNotActive(run_id));
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Default, Deserialize)]
struct EventQuery {
    #[serde(default)]
    after: u64,
}

async fn list_agent_events(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<impl IntoResponse, ApiError> {
    state.agent_runtime.store().get_run(&run_id)?;
    Ok(Json(
        state
            .agent_runtime
            .store()
            .events_after(&run_id, query.after)?,
    ))
}

struct AgentEventStreamState {
    store: Arc<AgentStore>,
    run_id: String,
    cursor: u64,
    pending: VecDeque<AgentEvent>,
}

async fn stream_agent_events(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let store = state.agent_runtime.store();
    store.get_run(&run_id)?;
    let stream = futures_util::stream::unfold(
        AgentEventStreamState {
            store,
            run_id,
            cursor: query.after,
            pending: VecDeque::new(),
        },
        |mut state| async move {
            loop {
                if let Some(agent_event) = state.pending.pop_front() {
                    state.cursor = agent_event.seq;
                    let event = Event::default()
                        .id(agent_event.seq.to_string())
                        .event(agent_event.kind.as_str())
                        .json_data(&agent_event)
                        .unwrap_or_else(|_| Event::default().event("serialization_error"));
                    return Some((Ok(event), state));
                }
                state.pending = state
                    .store
                    .events_after(&state.run_id, state.cursor)
                    .unwrap_or_default()
                    .into();
                if !state.pending.is_empty() {
                    continue;
                }
                let run = state.store.get_run(&state.run_id).ok()?;
                if !matches!(
                    run.status,
                    RunStatus::Running | RunStatus::WaitingPermission
                ) {
                    return None;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
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
    #[serde(default)]
    kind: TerminalKind,
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
        .create(&project_id, request.kind, request.cols, request.rows)?;
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
    AgentStore(StoreError),
    AgentRuntime(RuntimeError),
    InvalidRequest(String),
    RunNotActive(String),
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

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        Self::AgentStore(error)
    }
}

impl From<RuntimeError> for ApiError {
    fn from(error: RuntimeError) -> Self {
        Self::AgentRuntime(error)
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
                    TerminalError::AgentUnavailable(_) => {
                        (StatusCode::CONFLICT, "agent_unavailable")
                    }
                    TerminalError::Workspace(workspace) => workspace_error_status(workspace),
                    TerminalError::Pty(_) | TerminalError::Io(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, "terminal_error")
                    }
                };
                (status, code, error.to_string())
            }
            ApiError::AgentStore(error) => {
                let (status, code) = store_error_status(&error);
                (status, code, error.to_string())
            }
            ApiError::AgentRuntime(error) => match error {
                RuntimeError::AgentUnavailable(_) => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "agent_unavailable",
                    error.to_string(),
                ),
                RuntimeError::Store(store) => {
                    let (status, code) = store_error_status(&store);
                    (status, code, store.to_string())
                }
                RuntimeError::Workspace(workspace) => {
                    let (status, code) = workspace_error_status(&workspace);
                    (status, code, workspace.to_string())
                }
                RuntimeError::Acp(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "agent_error",
                    error.to_string(),
                ),
                RuntimeError::AdapterUnavailable { .. } => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "agent_adapter_unavailable",
                    error.to_string(),
                ),
            },
            ApiError::InvalidRequest(message) => {
                (StatusCode::BAD_REQUEST, "invalid_request", message)
            }
            ApiError::RunNotActive(run_id) => (
                StatusCode::CONFLICT,
                "run_not_active",
                format!("run is not active: {run_id}"),
            ),
        };
        (status, Json(ErrorBody { code, message })).into_response()
    }
}

fn store_error_status(error: &StoreError) -> (StatusCode, &'static str) {
    match error {
        StoreError::ConversationNotFound(_) | StoreError::RunNotFound(_) => {
            (StatusCode::NOT_FOUND, "not_found")
        }
        StoreError::ActiveRun(_) => (StatusCode::CONFLICT, "active_run"),
        StoreError::InvalidStoredValue(_) | StoreError::Json(_) | StoreError::Database(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
        }
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
