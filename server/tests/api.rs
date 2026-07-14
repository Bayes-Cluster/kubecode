use std::fs;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::api::{AppState, app_router, app_router_with_static};
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE_PATH: &str = "/user/alice/kubecode";

fn app() -> (TempDir, Router) {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let workspace =
        WorkspaceService::open(&root, state.join("kubecode.sqlite3")).expect("workspace service");
    let router = app_router(AppState::new(Arc::new(workspace)), BASE_PATH);
    (temp, router)
}

async fn json_request(app: &Router, method: Method, uri: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("json response")
    };
    (status, value)
}

#[tokio::test]
async fn serves_health_without_a_prefix_and_projects_below_the_prefix() {
    let (_temp, app) = app();
    let health = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .expect("health request"),
        )
        .await
        .expect("health response");
    assert_eq!(health.status(), StatusCode::OK);

    let (status, created) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "parent":".", "name":"demo"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["path"], "demo");

    let (status, projects) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/projects"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(projects.as_array().expect("projects").len(), 1);

    let (status, _) = json_request(&app, Method::GET, "/api/v1/projects", Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn exposes_exactly_the_supported_agent_catalog_below_the_prefix() {
    let (_temp, app) = app();

    let (status, agents) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/agents"),
        Value::Null,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let ids = agents
        .as_array()
        .expect("agents")
        .iter()
        .map(|agent| agent["id"].as_str().expect("agent id"))
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["claude_code", "codex", "opencode"]);
}

#[tokio::test]
async fn creates_reads_and_revision_checks_files_over_http() {
    let (_temp, app) = app();
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "parent":".", "name":"api"}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");

    let entries_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/entries");
    let (status, _) = json_request(
        &app,
        Method::POST,
        &entries_uri,
        json!({"path":"main.ts", "kind":"file"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let file_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/file?path=main.ts");
    let (status, initial) = json_request(&app, Method::GET, &file_uri, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let revision = initial["revision"].as_str().expect("revision");

    let (status, saved) = json_request(
        &app,
        Method::PUT,
        &file_uri,
        json!({"content":"export const ready = true\n", "revision":revision}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["content"], "export const ready = true\n");

    let (status, conflict) = json_request(
        &app,
        Method::PUT,
        &file_uri,
        json!({"content":"stale", "revision":revision}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "revision_conflict");
}

#[tokio::test]
async fn rejects_invalid_project_paths_with_a_structured_error() {
    let (_temp, app) = app();
    let (status, error) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"import", "path":".state"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "invalid_path");
}

#[tokio::test]
async fn serves_the_spa_only_below_the_configured_base_path() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state_dir = root.join(".state/kubecode");
    let static_dir = temp.path().join("dist");
    fs::create_dir_all(&state_dir).expect("state directory");
    fs::create_dir_all(&static_dir).expect("static directory");
    fs::write(static_dir.join("index.html"), "<main>Kubecode</main>").expect("index");
    let workspace = WorkspaceService::open(&root, state_dir.join("kubecode.sqlite3"))
        .expect("workspace service");
    let app = app_router_with_static(AppState::new(Arc::new(workspace)), BASE_PATH, &static_dir);

    let prefixed = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(BASE_PATH)
                .body(Body::empty())
                .expect("prefixed request"),
        )
        .await
        .expect("prefixed response");
    assert_eq!(prefixed.status(), StatusCode::OK);

    let root_response = app
        .oneshot(
            Request::builder()
                .uri("/")
                .body(Body::empty())
                .expect("root request"),
        )
        .await
        .expect("root response");
    assert_eq!(root_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn creates_lists_and_explicitly_closes_terminals_over_http() {
    let (_temp, app) = app();
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "parent":".", "name":"terminal-api"}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    let terminals_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/terminals");

    let (status, terminal) = json_request(
        &app,
        Method::POST,
        &terminals_uri,
        json!({"cols":100, "rows":30}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let terminal_id = terminal["id"].as_str().expect("terminal id");

    let (status, terminals) = json_request(&app, Method::GET, &terminals_uri, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(terminals.as_array().expect("terminals").len(), 1);

    let (status, _) = json_request(
        &app,
        Method::DELETE,
        &format!("{BASE_PATH}/api/v1/terminals/{terminal_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}
