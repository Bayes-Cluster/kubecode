use std::collections::{BTreeMap, VecDeque};
use std::convert::Infallible;
use std::path::Path as FileSystemPath;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use crate::agent_discovery::{AgentDescriptor, supported_agents_unavailable};
use crate::agent_runtime::{AgentRuntime, RuntimeError, StartAgentRun};
use crate::agents::{AgentEvent, AgentId, AgentStore, RunStatus, StoreError, WorkspaceEvent};
use crate::git::{GitError, GitMutation, GitService};
use crate::terminal::{
    TerminalError, TerminalEventSink, TerminalKind, TerminalLifecycleEvent, TerminalManager,
    TerminalSnapshot, TerminalStatus,
};
use crate::workspace::{DirectoryListing, EntryKind, WorkspaceError, WorkspaceService};

const API_PATH: &str = "/api/v1";

#[derive(Clone)]
pub struct AppState {
    pub workspace: Arc<WorkspaceService>,
    pub terminals: Arc<TerminalManager>,
    pub agents: Arc<Vec<AgentDescriptor>>,
    pub agent_runtime: Arc<AgentRuntime>,
    pub git: Arc<GitService>,
}

impl AppState {
    pub fn new(workspace: Arc<WorkspaceService>, agent_store: Arc<AgentStore>) -> Self {
        let terminals = Arc::new(TerminalManager::with_agents_and_events(
            Arc::clone(&workspace),
            8,
            2 * 1024 * 1024,
            Vec::new(),
            terminal_event_sink(Arc::clone(&agent_store)),
        ));
        let agents = supported_agents_unavailable();
        let git = Arc::new(GitService::new(Arc::clone(&workspace)));
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
            git,
        }
    }

    pub fn with_agents(mut self, agents: Vec<AgentDescriptor>) -> Self {
        self.terminals = Arc::new(TerminalManager::with_agents_and_events(
            Arc::clone(&self.workspace),
            8,
            2 * 1024 * 1024,
            agents.clone(),
            terminal_event_sink(self.agent_runtime.store()),
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
        .route("/events", get(stream_workspace_events))
        .route("/filesystem/directories", get(list_directories))
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/{project_id}/runs", get(list_project_runs))
        .route(
            "/projects/{project_id}/agents/{agent_id}/sessions",
            get(list_provider_sessions),
        )
        .route(
            "/projects/{project_id}/conversations",
            get(list_conversations).post(create_conversation),
        )
        .route(
            "/projects/{project_id}/sessions",
            get(list_conversations).post(create_conversation),
        )
        .route(
            "/projects/{project_id}/conversations/{conversation_id}/runs",
            axum::routing::post(start_agent_run),
        )
        .route(
            "/projects/{project_id}/sessions/{conversation_id}/runs",
            axum::routing::post(start_agent_run),
        )
        .route(
            "/conversations/{conversation_id}/runs",
            get(list_conversation_runs),
        )
        .route(
            "/sessions/{conversation_id}/runs",
            get(list_conversation_runs),
        )
        .route(
            "/sessions/{conversation_id}",
            axum::routing::patch(update_conversation).delete(remove_conversation),
        )
        .route(
            "/sessions/{conversation_id}/fork",
            axum::routing::post(fork_conversation),
        )
        .route(
            "/sessions/{conversation_id}/events",
            get(list_session_events),
        )
        .route("/sessions/{conversation_id}/state", get(get_session_state))
        .route(
            "/sessions/{conversation_id}/options",
            axum::routing::patch(update_session_option),
        )
        .route(
            "/runs/{run_id}",
            get(get_agent_run).delete(cancel_agent_run),
        )
        .route("/runs/{run_id}/events", get(list_agent_events))
        .route("/runs/{run_id}/events/stream", get(stream_agent_events))
        .route(
            "/permissions/{request_id}",
            axum::routing::post(resolve_permission),
        )
        .route(
            "/elicitations/{request_id}",
            axum::routing::post(resolve_elicitation),
        )
        .route("/projects/{project_id}", delete(unregister_project))
        .route("/projects/{project_id}/git/status", get(git_status))
        .route(
            "/projects/{project_id}/git/init",
            axum::routing::post(git_initialize),
        )
        .route("/projects/{project_id}/git/diff", get(git_diff))
        .route(
            "/projects/{project_id}/git/mutate",
            axum::routing::post(git_mutate),
        )
        .route(
            "/projects/{project_id}/git/commit",
            axum::routing::post(git_commit),
        )
        .route(
            "/projects/{project_id}/terminals",
            get(list_terminals).post(create_terminal),
        )
        .route(
            "/terminals/{terminal_id}",
            delete(close_terminal).patch(rename_terminal),
        )
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
    provider_session_id: Option<String>,
    agent_title: Option<String>,
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
    let store = state.agent_runtime.store();
    let conversation = if let Some(provider_session_id) = request.provider_session_id.as_deref() {
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
    if state
        .agents
        .iter()
        .any(|agent| agent.id == conversation.agent_id && agent.available)
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

async fn list_provider_sessions(
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
struct UpdateConversationRequest {
    manual_title: Option<String>,
}

async fn update_conversation(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<UpdateConversationRequest>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.agent_runtime.store().set_manual_title(
        &conversation_id,
        request.manual_title.as_deref(),
    )?))
}

async fn remove_conversation(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(query): Query<RemoveConversationQuery>,
) -> Result<StatusCode, ApiError> {
    if query.scope.as_deref() == Some("provider") {
        state
            .agent_runtime
            .delete_provider_session(&conversation_id)
            .await?;
    } else {
        state
            .agent_runtime
            .store()
            .delete_conversation(&conversation_id)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
struct RemoveConversationQuery {
    scope: Option<String>,
}

async fn fork_conversation(
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

#[derive(Debug, Deserialize)]
struct StartRunRequest {
    message: String,
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
    })?;
    Ok((StatusCode::ACCEPTED, Json(run)))
}

async fn get_agent_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.agent_runtime.store().get_run(&run_id)?))
}

async fn list_conversation_runs(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state.agent_runtime.store().list_runs(&conversation_id)?,
    ))
}

async fn list_project_runs(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.workspace.project_path(&project_id)?;
    Ok(Json(
        state.agent_runtime.store().list_project_runs(&project_id)?,
    ))
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

#[derive(Debug, Deserialize)]
struct ResolvePermissionRequest {
    option_id: String,
}

async fn resolve_permission(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    Json(request): Json<ResolvePermissionRequest>,
) -> Result<StatusCode, ApiError> {
    if request.option_id.trim().is_empty() {
        return Err(ApiError::InvalidRequest(
            "option_id must not be empty".into(),
        ));
    }
    if !state
        .agent_runtime
        .resolve_permission(&request_id, &request.option_id)
    {
        return Err(ApiError::PermissionNotFound(request_id));
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct ResolveElicitationRequest {
    content: Option<BTreeMap<String, agent_client_protocol::schema::v1::ElicitationContentValue>>,
}

async fn resolve_elicitation(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    Json(request): Json<ResolveElicitationRequest>,
) -> Result<StatusCode, ApiError> {
    if !state
        .agent_runtime
        .resolve_elicitation(&request_id, request.content)
    {
        return Err(ApiError::ElicitationNotFound(request_id));
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

async fn list_session_events(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .agent_runtime
            .store()
            .session_events_after(&conversation_id, query.after)?,
    ))
}

#[derive(Debug, Default, Serialize)]
struct SessionState {
    capabilities: Option<serde_json::Value>,
    available_commands: Option<serde_json::Value>,
    current_mode: Option<serde_json::Value>,
    config_options: Option<serde_json::Value>,
    plan: Option<serde_json::Value>,
    usage: Option<serde_json::Value>,
}

async fn get_session_state(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let events = state
        .agent_runtime
        .store()
        .session_events_after(&conversation_id, 0)?;
    let mut session = SessionState::default();
    for event in events {
        match event.kind.as_str() {
            "capabilities" => session.capabilities = Some(event.payload),
            "available_commands" => session.available_commands = Some(event.payload),
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
    Ok(Json(session))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum UpdateSessionOptionRequest {
    Mode {
        value: String,
    },
    Config {
        config_id: String,
        value: crate::agent_runtime::SessionConfigInput,
    },
}

async fn update_session_option(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<UpdateSessionOptionRequest>,
) -> Result<StatusCode, ApiError> {
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

struct AgentEventStreamState {
    store: Arc<AgentStore>,
    run_id: String,
    cursor: u64,
    pending: VecDeque<AgentEvent>,
}

struct WorkspaceEventStreamState {
    store: Arc<AgentStore>,
    cursor: u64,
    pending: VecDeque<WorkspaceEvent>,
}

async fn stream_workspace_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<EventQuery>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(query.after);
    let stream = futures_util::stream::unfold(
        WorkspaceEventStreamState {
            store: state.agent_runtime.store(),
            cursor,
            pending: VecDeque::new(),
        },
        |mut state| async move {
            loop {
                if let Some(workspace_event) = state.pending.pop_front() {
                    state.cursor = workspace_event.id;
                    let event = Event::default()
                        .id(workspace_event.id.to_string())
                        .event("workspace_event")
                        .json_data(&workspace_event)
                        .unwrap_or_else(|_| Event::default().event("serialization_error"));
                    return Some((Ok(event), state));
                }
                state.pending = state
                    .store
                    .workspace_events_after(state.cursor)
                    .unwrap_or_default()
                    .into();
                if state.pending.is_empty() {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
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
    Create { path: String },
    Import { path: String },
}

async fn create_project(
    State(state): State<AppState>,
    Json(request): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let project = match request {
        CreateProjectRequest::Create { path } => state.workspace.create_project_at(path)?,
        CreateProjectRequest::Import { path } => state.workspace.import_project_at(path)?,
    };
    Ok((StatusCode::CREATED, Json(project)))
}

#[derive(Debug, Default, Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}

async fn list_directories(
    State(state): State<AppState>,
    Query(query): Query<DirectoryQuery>,
) -> Result<Json<DirectoryListing>, ApiError> {
    let requested = query.path.as_deref().map(FileSystemPath::new);
    Ok(Json(state.workspace.list_directories(requested)?))
}

async fn unregister_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.workspace.unregister_project(&project_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn git_status(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.git.status(&project_id).await?))
}

async fn git_initialize(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let status = state.git.initialize(&project_id).await?;
    emit_project_event(&state, "git_changed", &project_id, json!({"action":"init"}));
    Ok((StatusCode::CREATED, Json(status)))
}

#[derive(Debug, Default, Deserialize)]
struct GitDiffQuery {
    path: String,
    #[serde(default)]
    staged: bool,
}

async fn git_diff(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<GitDiffQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(json!({
        "diff": state.git.diff(&project_id, &query.path, query.staged).await?
    })))
}

#[derive(Debug, Deserialize)]
struct GitMutationRequest {
    action: GitMutation,
    paths: Vec<String>,
}

async fn git_mutate(
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
struct GitCommitRequest {
    message: String,
}

async fn git_commit(
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

fn emit_project_event(state: &AppState, kind: &str, project_id: &str, payload: serde_json::Value) {
    let _ = state.agent_runtime.store().append_workspace_event(
        kind,
        Some(project_id),
        None,
        None,
        &payload,
    );
}

fn terminal_event_sink(store: Arc<AgentStore>) -> TerminalEventSink {
    Arc::new(move |event: TerminalLifecycleEvent| {
        let terminal = event.terminal;
        let _ = store.append_workspace_event(
            event.kind,
            Some(&terminal.project_id),
            None,
            None,
            &json!({
                "terminal_id": terminal.id,
                "status": terminal.status,
                "exit_code": terminal.exit_code,
                "signal": terminal.signal,
            }),
        );
    })
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
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"path":request.path}),
    );
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
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"from":request.from, "to":request.to}),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<StatusCode, ApiError> {
    state.workspace.delete_entry(&project_id, &query.path)?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"path":query.path}),
    );
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
    let document = state.workspace.write_text(
        &project_id,
        &query.path,
        &request.content,
        &request.revision,
    )?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"path":query.path}),
    );
    Ok(Json(document))
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

#[derive(Debug, Deserialize)]
struct RenameTerminalRequest {
    title: String,
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
    emit_project_event(
        &state,
        "terminal_created",
        &project_id,
        json!({"terminal_id":terminal.id.clone()}),
    );
    Ok((StatusCode::CREATED, Json(terminal)))
}

async fn close_terminal(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let terminal = state.terminals.get(&terminal_id)?;
    state.terminals.close(&terminal_id)?;
    emit_project_event(
        &state,
        "terminal_closed",
        &terminal.project_id,
        json!({"terminal_id":terminal_id}),
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn rename_terminal(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
    Json(request): Json<RenameTerminalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let terminal = state.terminals.rename(&terminal_id, &request.title)?;
    emit_project_event(
        &state,
        "terminal_updated",
        &terminal.project_id,
        json!({"terminal_id":terminal.id.clone()}),
    );
    Ok(Json(terminal))
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
    match send_terminal_snapshot(&mut socket, &manager, &terminal_id, &mut cursor).await {
        Ok(false) => {}
        Ok(true) | Err(()) => return,
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
                match send_terminal_snapshot(&mut socket, &manager, &terminal_id, &mut cursor).await {
                    Ok(false) => {}
                    Ok(true) | Err(()) => return,
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
) -> Result<bool, ()> {
    let snapshot = manager.read_since(terminal_id, *cursor).map_err(|_| ())?;
    if !snapshot.data.is_empty() || snapshot.truncated {
        *cursor = snapshot.cursor;
        socket
            .send(Message::Text(terminal_output_json(snapshot).into()))
            .await
            .map_err(|_| ())?;
    }
    let terminal = manager.get(terminal_id).map_err(|_| ())?;
    if terminal.status != TerminalStatus::Exited {
        return Ok(false);
    }
    socket
        .send(Message::Text(terminal_status_json(&terminal).into()))
        .await
        .map_err(|_| ())?;
    Ok(true)
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

fn terminal_status_json(terminal: &crate::terminal::TerminalInfo) -> String {
    json!({
        "type": "status",
        "status": terminal.status,
        "exit_code": terminal.exit_code,
        "signal": terminal.signal,
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
    Git(GitError),
    PermissionNotFound(String),
    ElicitationNotFound(String),
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

impl From<GitError> for ApiError {
    fn from(error: GitError) -> Self {
        Self::Git(error)
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
                    TerminalError::InvalidTitle => (StatusCode::BAD_REQUEST, "invalid_title"),
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
            ApiError::Git(error) => {
                let (status, code) = match &error {
                    GitError::InvalidPath(_) | GitError::EmptyMessage => {
                        (StatusCode::BAD_REQUEST, "invalid_request")
                    }
                    GitError::Workspace(workspace) => workspace_error_status(workspace),
                    GitError::Command(_) => (StatusCode::CONFLICT, "git_error"),
                    GitError::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, "git_error"),
                };
                (status, code, error.to_string())
            }
            ApiError::PermissionNotFound(request_id) => (
                StatusCode::NOT_FOUND,
                "permission_not_found",
                format!("permission request is no longer active: {request_id}"),
            ),
            ApiError::ElicitationNotFound(request_id) => (
                StatusCode::NOT_FOUND,
                "elicitation_not_found",
                format!("elicitation request is no longer active: {request_id}"),
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
