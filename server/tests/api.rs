use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agents::{AgentId, AgentStore};
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
    let agent_store = AgentStore::open(state.join("kubecode.sqlite3")).expect("agent store");
    let router = app_router(
        AppState::new(Arc::new(workspace), Arc::new(agent_store)),
        BASE_PATH,
    );
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
    let (temp, app) = app();
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
        json!({"kind":"create", "path":temp.path().join("srv/demo")}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        created["path"],
        temp.path()
            .join("srv/demo")
            .canonicalize()
            .expect("canonical project")
            .to_string_lossy()
            .as_ref()
    );

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
async fn creates_conversations_and_rejects_runs_for_unavailable_agents() {
    let (temp, app) = app();
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":temp.path().join("srv/agent-api")}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    let conversations_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/conversations");

    let (status, conversation) = json_request(
        &app,
        Method::POST,
        &conversations_uri,
        json!({"agent_id":"codex", "title":"Implement feature"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let conversation_id = conversation["id"].as_str().expect("conversation id");

    let (status, conversations) =
        json_request(&app, Method::GET, &conversations_uri, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(conversations.as_array().expect("conversations").len(), 1);

    let (status, error) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/conversations/{conversation_id}/runs"),
        json!({"message":"Do it"}),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error["code"], "agent_unavailable");

    let (status, runs) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/runs"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(runs.as_array().expect("project runs").is_empty());
}

#[tokio::test]
async fn creates_reads_and_revision_checks_files_over_http() {
    let (temp, app) = app();
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":temp.path().join("srv/api")}),
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
    let (temp, app) = app();
    let (status, error) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"import", "path":temp.path().join("srv/.state")}),
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
    let agent_store = AgentStore::open(state_dir.join("kubecode.sqlite3")).expect("agent store");
    let app = app_router_with_static(
        AppState::new(Arc::new(workspace), Arc::new(agent_store)),
        BASE_PATH,
        &static_dir,
    );

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
    let (temp, app) = app();
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":temp.path().join("srv/terminal-api")}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    let terminals_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/terminals");

    let (status, terminal) = json_request(
        &app,
        Method::POST,
        &terminals_uri,
        json!({"kind":"regular", "cols":100, "rows":30}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(terminal["kind"], "regular");
    let terminal_id = terminal["id"].as_str().expect("terminal id");

    let (status, terminals) = json_request(&app, Method::GET, &terminals_uri, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(terminals.as_array().expect("terminals").len(), 1);

    let terminal_uri = format!("{BASE_PATH}/api/v1/terminals/{terminal_id}");
    let (status, renamed) = json_request(
        &app,
        Method::PATCH,
        &terminal_uri,
        json!({"title":"  Build logs  "}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["title"], "Build logs");

    let (status, _) = json_request(&app, Method::DELETE, &terminal_uri, Value::Null).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn manages_project_registration_and_entry_lifecycle_over_http() {
    let (temp, app) = app();
    fs::create_dir_all(temp.path().join("srv/imported")).expect("import directory");
    let (status, imported) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"import", "path":temp.path().join("srv/imported")}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let project_id = imported["id"].as_str().expect("project id");
    let entries_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/entries");

    for body in [
        json!({"path":"src", "kind":"directory"}),
        json!({"path":"src/main.rs", "kind":"file"}),
    ] {
        let (status, _) = json_request(&app, Method::POST, &entries_uri, body).await;
        assert_eq!(status, StatusCode::CREATED);
    }
    let (status, entries) = json_request(
        &app,
        Method::GET,
        &format!("{entries_uri}?path=src"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(entries[0]["path"], "src/main.rs");

    let (status, _) = json_request(
        &app,
        Method::PATCH,
        &entries_uri,
        json!({"from":"src/main.rs", "to":"src/lib.rs"}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = json_request(
        &app,
        Method::DELETE,
        &format!("{entries_uri}?path=src/lib.rs"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = json_request(
        &app,
        Method::DELETE,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, error) = json_request(&app, Method::GET, &entries_uri, Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], "not_found");
}

#[tokio::test]
async fn supports_session_aliases_global_events_permissions_and_git_review() {
    let (temp, app) = app();
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":temp.path().join("srv/session-review-api")}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    let sessions_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions");
    let (status, session) = json_request(
        &app,
        Method::POST,
        &sessions_uri,
        json!({"agent_id":"codex", "title":"Review changes"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let session_id = session["id"].as_str().expect("session id");

    let (status, sessions) = json_request(&app, Method::GET, &sessions_uri, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sessions[0]["title"], "Review changes");
    let (status, runs) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions/{session_id}/runs"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(runs.as_array().expect("runs").is_empty());

    let events = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("{BASE_PATH}/api/v1/events?after=0"))
                .header("last-event-id", "0")
                .body(Body::empty())
                .expect("workspace event request"),
        )
        .await
        .expect("workspace event response");
    assert_eq!(events.status(), StatusCode::OK);
    assert_eq!(events.headers()[header::CONTENT_TYPE], "text/event-stream");

    let (status, invalid_permission) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/permissions/missing"),
        json!({"option_id":" "}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid_permission["code"], "invalid_request");
    let (status, missing_permission) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/permissions/missing"),
        json!({"option_id":"allow_once"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing_permission["code"], "permission_not_found");
    let (status, missing_elicitation) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/elicitations/missing"),
        json!({"content":{"goal":"Use native ACP", "includeTests":true}}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing_elicitation["code"], "elicitation_not_found");

    let git_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/git");
    let (status, initial) =
        json_request(&app, Method::GET, &format!("{git_uri}/status"), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(initial["is_repository"], false);
    let (status, initialized) =
        json_request(&app, Method::POST, &format!("{git_uri}/init"), Value::Null).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(initialized["is_repository"], true);
    configure_git_identity(&temp.path().join("srv/session-review-api"));
    fs::write(
        temp.path().join("srv/session-review-api/README.md"),
        "first\n",
    )
    .expect("write review file");

    let (status, staged) = json_request(
        &app,
        Method::POST,
        &format!("{git_uri}/mutate"),
        json!({"action":"stage", "paths":["README.md"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(staged["files"][0]["index_status"], "A");
    let (status, diff) = json_request(
        &app,
        Method::GET,
        &format!("{git_uri}/diff?path=README.md&staged=true"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        diff["diff"]
            .as_str()
            .expect("staged diff")
            .contains("+first")
    );
    let (status, committed) = json_request(
        &app,
        Method::POST,
        &format!("{git_uri}/commit"),
        json!({"message":"Initial commit"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        committed["files"]
            .as_array()
            .expect("clean files")
            .is_empty()
    );

    fs::write(
        temp.path().join("srv/session-review-api/README.md"),
        "first\nsecond\n",
    )
    .expect("modify review file");
    let (status, _) = json_request(
        &app,
        Method::POST,
        &format!("{git_uri}/mutate"),
        json!({"action":"discard", "paths":["README.md"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        fs::read_to_string(temp.path().join("srv/session-review-api/README.md"))
            .expect("restored review file"),
        "first\n"
    );
}

fn configure_git_identity(repository: &std::path::Path) {
    for (key, value) in [
        ("user.name", "Kubecode API Test"),
        ("user.email", "api-test@kubecode.local"),
    ] {
        let status = Command::new("git")
            .args(["config", key, value])
            .current_dir(repository)
            .status()
            .expect("git config");
        assert!(status.success());
    }
}

#[tokio::test]
async fn reports_request_store_and_terminal_errors_consistently() {
    let (temp, app) = app();
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":temp.path().join("srv/errors")}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    let conversations_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/conversations");
    let (_, conversation) = json_request(
        &app,
        Method::POST,
        &conversations_uri,
        json!({"agent_id":"codex"}),
    )
    .await;
    let conversation_id = conversation["id"].as_str().expect("conversation id");
    let (status, error) = json_request(
        &app,
        Method::POST,
        &format!("{conversations_uri}/{conversation_id}/runs"),
        json!({"message":"  "}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "invalid_request");

    for (method, suffix) in [
        (Method::GET, "/runs/missing"),
        (Method::DELETE, "/runs/missing"),
        (Method::GET, "/runs/missing/events"),
    ] {
        let (status, error) = json_request(
            &app,
            method,
            &format!("{BASE_PATH}/api/v1{suffix}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error["code"], "not_found");
    }
    let (status, error) = json_request(
        &app,
        Method::DELETE,
        &format!("{BASE_PATH}/api/v1/terminals/missing"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], "not_found");
}

fn executable(directory: &TempDir, body: &str) -> String {
    let path = directory.path().join("codex");
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write mock agent");
    let mut permissions = fs::metadata(&path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).expect("permissions");
    path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn exposes_completed_run_details_replay_and_event_stream() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state_dir = root.join(".state/kubecode");
    fs::create_dir_all(&state_dir).expect("state directory");
    let database = state_dir.join("kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let store = Arc::new(AgentStore::open(&database).expect("agent store"));
    let binary = executable(
        &temp,
        r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"session-api\"}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-api","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Finished through API"}}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done"#,
    );
    let app = app_router(
        AppState::new(workspace, store).with_agents(vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        }]),
        BASE_PATH,
    );
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":temp.path().join("srv/run-api")}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    let conversations_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/conversations");
    let (_, conversation) = json_request(
        &app,
        Method::POST,
        &conversations_uri,
        json!({"agent_id":"opencode"}),
    )
    .await;
    let conversation_id = conversation["id"].as_str().expect("conversation id");
    let (status, run) = json_request(
        &app,
        Method::POST,
        &format!("{conversations_uri}/{conversation_id}/runs"),
        json!({"message":"Do it"}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let run_id = run["id"].as_str().expect("run id");
    let run_uri = format!("{BASE_PATH}/api/v1/runs/{run_id}");

    let completed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let (_, current) = json_request(&app, Method::GET, &run_uri, Value::Null).await;
            if current["status"] != "running" {
                break current;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("run completion");
    assert_eq!(completed["status"], "completed");

    let events_uri = format!("{run_uri}/events");
    let (status, events) = json_request(&app, Method::GET, &events_uri, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(events.as_array().expect("events").iter().any(|event| {
        event["kind"] == "text_delta" && event["payload"]["text"] == "Finished through API"
    }));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("{events_uri}/stream?after=0"))
                .body(Body::empty())
                .expect("stream request"),
        )
        .await
        .expect("stream response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("stream body");
    assert!(String::from_utf8_lossy(&body).contains("Finished through API"));

    let (status, error) = json_request(&app, Method::DELETE, &run_uri, Value::Null).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "run_not_active");
}
