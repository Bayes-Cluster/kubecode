mod agents;
mod composer;
mod error;
mod git;
mod projects;
mod runs;
mod runtime;
mod sessions;
mod terminals;

pub use crate::app_state::AppState;

use std::path::Path as FileSystemPath;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get};
use serde::Serialize;
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use crate::config::normalize_base_path;

use self::agents::{list_agents, refresh_agents};
use self::composer::{
    create_entry, delete_entry, list_composer_git_diffs, list_entries, list_session_entries,
    read_asset, read_file, register_composer_context, rename_entry, validate_composer_contexts,
    write_file,
};
use self::git::{git_commit, git_diff, git_initialize, git_mutate, git_status};
use self::projects::{
    authorize_project_path, create_project, get_workspace_migration, list_directories,
    list_projects, migrate_project_workspaces, unregister_project, update_project_workspaces,
};
use self::runs::{
    cancel_agent_run, dispatch_acp_command, get_agent_run, list_conversation_history,
    list_conversation_runs, list_project_runs, resolve_elicitation, resolve_permission,
    start_agent_run,
};
use self::runtime::{
    get_runtime_status, get_workspace_event_cursor, list_agent_events, list_session_events,
    stream_agent_events, stream_workspace_events,
};
use self::sessions::{
    ask_side_question, branch_conversation_at_run, create_conversation, create_team_member,
    delete_conversation, fork_conversation, get_session_state, list_all_conversations,
    list_conversation_revisions, list_conversations, list_provider_sessions,
    revise_conversation_at_run, update_conversation, update_session_option,
};
use self::terminals::{
    attach_terminal, close_terminal, create_terminal, list_terminals, rename_terminal,
};

const API_PATH: &str = "/api/v1";

pub fn app_router(state: AppState, base_path: &str) -> Router {
    root_router(Router::new().nest(API_PATH, api_router(state)), base_path)
}

#[derive(Clone, Debug, Serialize)]
struct RuntimeDiscovery {
    protocol_version: u16,
    server_version: &'static str,
    api_base: String,
    authentication: &'static str,
    capabilities: &'static [&'static str],
}

pub fn app_router_api_only(
    state: AppState,
    base_path: &str,
    access_token: impl Into<String>,
) -> Router {
    let normalized_base_path = normalize_base_path(base_path);
    let discovery = RuntimeDiscovery {
        protocol_version: 1,
        server_version: env!("CARGO_PKG_VERSION"),
        api_base: format!("{normalized_base_path}{API_PATH}"),
        authentication: "bearer",
        capabilities: &[
            "projects",
            "sessions",
            "teams",
            "files",
            "git",
            "terminals",
            "workspace_events",
        ],
    };
    let access_token: Arc<str> = Arc::from(access_token.into());
    let protected_api = client_api_router(state.clone()).layer(middleware::from_fn_with_state(
        access_token,
        require_access_token,
    ));
    let api = team_mcp_router(state).merge(protected_api);
    let application = Router::new()
        .route(
            "/.well-known/kubecode",
            get(move || {
                let discovery = discovery.clone();
                async move { Json(discovery) }
            }),
        )
        .nest(API_PATH, api);
    root_router(application, base_path)
}

async fn require_access_token(
    State(expected): State<Arc<str>>,
    request: Request,
    next: Next,
) -> Response {
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == expected.as_ref());
    if authorized {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "code": "unauthorized",
                "message": "A valid Kubecode desktop access token is required"
            })),
        )
            .into_response()
    }
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
        .fallback_service(service);
    let base_path = normalize_base_path(base_path);
    if base_path.is_empty() {
        root_router(
            application.route_service("/", ServeFile::new(index_file)),
            &base_path,
        )
    } else {
        let index_path = format!("{base_path}/");
        let redirect_target = index_path.clone();
        health_router()
            .route(
                &base_path,
                get(move || {
                    let target = redirect_target.clone();
                    async move { Redirect::permanent(&target) }
                }),
            )
            .route_service(&index_path, ServeFile::new(index_file))
            .nest(&base_path, application)
    }
}

fn api_router(state: AppState) -> Router {
    team_mcp_router(state.clone()).merge(client_api_router(state))
}

fn team_mcp_router(state: AppState) -> Router {
    Router::new()
        .route(
            "/team-mcp/{token}/{conversation_id}",
            axum::routing::any(crate::team_mcp::handle_http),
        )
        .with_state(state)
}

fn client_api_router(state: AppState) -> Router {
    Router::new()
        .route("/agents", get(list_agents))
        .route("/agents/refresh", axum::routing::post(refresh_agents))
        .route("/events", get(stream_workspace_events))
        .route("/events/cursor", get(get_workspace_event_cursor))
        .route("/runtime/status", get(get_runtime_status))
        .route("/sessions", get(list_all_conversations))
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
            "/projects/{project_id}/sessions/{conversation_id}/commands",
            axum::routing::post(dispatch_acp_command),
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
            "/sessions/{conversation_id}/history",
            get(list_conversation_history),
        )
        .route(
            "/sessions/{conversation_id}",
            axum::routing::patch(update_conversation).delete(delete_conversation),
        )
        .route(
            "/sessions/{conversation_id}/fork",
            axum::routing::post(fork_conversation),
        )
        .route(
            "/sessions/{conversation_id}/turns/{run_id}/branch",
            axum::routing::post(branch_conversation_at_run),
        )
        .route(
            "/sessions/{conversation_id}/turns/{run_id}/revise",
            axum::routing::post(revise_conversation_at_run),
        )
        .route(
            "/sessions/{conversation_id}/revisions",
            get(list_conversation_revisions),
        )
        .route(
            "/sessions/{conversation_id}/team-members",
            axum::routing::post(create_team_member),
        )
        .route(
            "/sessions/{conversation_id}/events",
            get(list_session_events),
        )
        .route("/sessions/{conversation_id}/state", get(get_session_state))
        .route(
            "/sessions/{conversation_id}/entries",
            get(list_session_entries),
        )
        .route(
            "/sessions/{conversation_id}/composer/contexts",
            axum::routing::post(register_composer_context),
        )
        .route(
            "/sessions/{conversation_id}/composer/git-diffs",
            get(list_composer_git_diffs),
        )
        .route(
            "/sessions/{conversation_id}/composer/contexts/validate",
            axum::routing::post(validate_composer_contexts),
        )
        .route(
            "/sessions/{conversation_id}/side-questions",
            axum::routing::post(ask_side_question),
        )
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
        .route(
            "/projects/{project_id}/authorize",
            axum::routing::post(authorize_project_path),
        )
        .route(
            "/projects/{project_id}/workspaces",
            axum::routing::patch(update_project_workspaces),
        )
        .route(
            "/projects/{project_id}/workspaces/migration",
            get(get_workspace_migration).post(migrate_project_workspaces),
        )
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
        .route("/projects/{project_id}/asset", get(read_asset))
        .merge(crate::team_api::routes())
        .with_state(state)
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

fn root_router(application: Router, base_path: &str) -> Router {
    let base_path = normalize_base_path(base_path);

    let router = health_router();
    if base_path.is_empty() {
        router.merge(application)
    } else {
        router.nest(&base_path, application)
    }
}

fn health_router() -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(health))
}

async fn health() -> &'static str {
    "ok"
}
