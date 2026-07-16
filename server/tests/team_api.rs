use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agents::AgentId;
use kubecode_server::agents::AgentStore;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::teams::TeamStore;
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
    let database_path = state.join("kubecode.sqlite3");
    let workspace = WorkspaceService::open(&root, &database_path).expect("workspace service");
    let agent_store = AgentStore::open(&database_path).expect("agent store");
    let teams = TeamStore::open(&database_path).expect("team store");
    let router = app_router(
        AppState::new(Arc::new(workspace), Arc::new(agent_store), Arc::new(teams)),
        BASE_PATH,
    );
    (temp, router)
}

async fn request(app: &Router, method: Method, uri: &str, body: Value) -> (StatusCode, Value) {
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

async fn create_project(app: &Router, root: &std::path::Path) -> String {
    let (status, project) = request(
        app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind": "create", "path": root.join("project")}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    project["id"].as_str().expect("project id").to_owned()
}

#[tokio::test]
async fn creates_a_team_with_only_its_leader() {
    let (temp, app) = app();
    let project_id = create_project(&app, temp.path()).await;

    let (status, snapshot) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({
            "agent_id": "codex",
            "leader_name": "Lead",
            "title": "Investigate failure",
            "workspace": "shared"
        }),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(snapshot["team"]["project_id"], project_id);
    assert_eq!(snapshot["team"]["title"], "Investigate failure");
    assert_eq!(snapshot["members"].as_array().expect("members").len(), 1);
    assert_eq!(snapshot["members"][0]["role"], "leader");
    assert_eq!(snapshot["members"][0]["name"], "Lead");
    assert_eq!(snapshot["tasks"], json!([]));
    assert_eq!(snapshot["leader_conversation"]["agent_id"], "codex");
}

#[tokio::test]
async fn promotes_an_existing_solo_session_without_replacing_it() {
    let (temp, app) = app();
    let project_id = create_project(&app, temp.path()).await;
    let (status, session) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions"),
        json!({"agent_id": "claude_code", "title": "Existing work"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let session_id = session["id"].as_str().expect("session id");

    let (status, snapshot) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/sessions/{session_id}/promote-to-team"),
        json!({"leader_name": "Coordinator"}),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(snapshot["members"][0]["conversation_id"], session_id);
    assert_eq!(snapshot["members"][0]["name"], "Coordinator");
    assert_eq!(snapshot["team"]["title"], "Existing work");
}

#[tokio::test]
async fn reads_a_team_snapshot_by_id() {
    let (temp, app) = app();
    let project_id = create_project(&app, temp.path()).await;
    let (status, created) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "opencode", "leader_name": "Leader"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let team_id = created["team"]["id"].as_str().expect("team id");

    let (status, snapshot) = request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/teams/{team_id}"),
        Value::Null,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot, created);
}

#[tokio::test]
async fn advertises_kubecode_team_tools_to_the_leader_acp_session() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace = WorkspaceService::open(&root, &database_path).expect("workspace service");
    let agent_store = AgentStore::open(&database_path).expect("agent store");
    let teams = TeamStore::open(&database_path).expect("team store");
    let transcript = temp.path().join("acp.jsonl");
    let executable = temp.path().join("opencode");
    fs::write(
        &executable,
        format!(
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"protocolVersion\":1,\"agentCapabilities\":{{}},\"authMethods\":[]}}}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"sessionId\":\"team-session\"}}}}"
      ;;
  esac
done"#,
            transcript.display()
        ),
    )
    .expect("mock agent");
    let mut permissions = fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&executable, permissions).expect("executable permissions");
    let router = app_router(
        AppState::new(Arc::new(workspace), Arc::new(agent_store), Arc::new(teams)).with_agents(
            vec![AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: executable.to_string_lossy().into_owned(),
                error: None,
            }],
        ),
        BASE_PATH,
    );
    let project_id = create_project(&router, temp.path()).await;

    let (status, _) = request(
        &router,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "opencode", "leader_name": "Leader"}),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    let transcript = fs::read_to_string(transcript).expect("ACP transcript");
    let session_new = transcript
        .lines()
        .find(|line| line.contains("session/new"))
        .expect("session/new request");
    assert!(session_new.contains("mcpServers"), "{session_new}");
    assert!(session_new.contains("kubecode-team"), "{session_new}");
}
