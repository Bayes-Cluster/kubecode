use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, BodyDataStream, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use futures_util::StreamExt;
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_runtime::{AgentRuntimeSessionCounts, StartAgentRun};
use kubecode_server::agents::{
    AgentEventKind, AgentId, AgentStore, PermissionMode, RuntimeRunEvent, RuntimeUpdate,
};
use kubecode_server::api::{AppState, app_router, app_router_api_only, app_router_with_static};
use kubecode_server::composer_catalog::{
    ComposerContextKind, MAX_COMPOSER_SEGMENTS, MAX_COMPOSER_TEXT_BYTES,
    MAX_COMPOSER_VALIDATION_ROWS,
};
use kubecode_server::teams::{MemberWorkspaceMode, NewTeam, NewTeammate, TeamStore, TeamWorkspace};
use kubecode_server::terminal::TerminalKind;
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE_PATH: &str = "/user/alice/kubecode";

#[derive(Debug)]
struct ReceivedWorkspaceEvent {
    id: u64,
    event: String,
    payload: Value,
}

struct WorkspaceSseReader {
    stream: BodyDataStream,
    buffer: String,
}

impl WorkspaceSseReader {
    fn new(body: Body) -> Self {
        Self {
            stream: body.into_data_stream(),
            buffer: String::new(),
        }
    }

    async fn next_workspace_event(&mut self) -> Option<ReceivedWorkspaceEvent> {
        loop {
            while let Some(boundary) = self.buffer.find("\n\n") {
                let frame = self.buffer[..boundary].to_owned();
                self.buffer.drain(..boundary + 2);
                let mut id = None;
                let mut event = None;
                let mut data = String::new();
                for line in frame.lines() {
                    if let Some(value) = line.strip_prefix("id:") {
                        id = value.trim().parse::<u64>().ok();
                    } else if let Some(value) = line.strip_prefix("event:") {
                        event = Some(value.trim().to_owned());
                    } else if let Some(value) = line.strip_prefix("data:") {
                        if !data.is_empty() {
                            data.push('\n');
                        }
                        data.push_str(value.trim_start());
                    }
                }
                if event.as_deref() != Some("workspace_event") {
                    continue;
                }
                let id = id.expect("workspace SSE event id");
                let payload = serde_json::from_str::<Value>(&data).expect("workspace SSE JSON");
                assert_eq!(payload["id"], id);
                return Some(ReceivedWorkspaceEvent {
                    id,
                    event: event.expect("workspace SSE event name"),
                    payload,
                });
            }

            let chunk = self.stream.next().await?;
            let chunk = chunk.expect("workspace SSE body");
            self.buffer
                .push_str(std::str::from_utf8(&chunk).expect("workspace SSE UTF-8"));
        }
    }
}

fn workspace_sse_app() -> (TempDir, std::path::PathBuf, Arc<AgentStore>, Router) {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(workspace, Arc::clone(&store), teams),
        BASE_PATH,
    );
    (temp, database_path, store, app)
}

async fn workspace_sse_reader(
    app: &Router,
    after: u64,
    last_event_id: Option<u64>,
) -> WorkspaceSseReader {
    let mut request = Request::builder()
        .uri(format!("{BASE_PATH}/api/v1/events?after={after}"))
        .body(Body::empty())
        .expect("workspace event request");
    if let Some(last_event_id) = last_event_id {
        request.headers_mut().insert(
            "last-event-id",
            last_event_id.to_string().parse().expect("last event id"),
        );
    }
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("workspace event response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream"
    );
    WorkspaceSseReader::new(response.into_body())
}

fn append_test_workspace_event(store: &AgentStore, value: usize) -> u64 {
    store
        .append_workspace_event(
            "test_event",
            Some("project"),
            None,
            None,
            &json!({"value":value}),
        )
        .expect("workspace event")
        .id
}

async fn collect_workspace_event_ids(mut reader: WorkspaceSseReader, count: usize) -> Vec<u64> {
    let mut ids = Vec::with_capacity(count);
    while ids.len() < count {
        ids.push(
            reader
                .next_workspace_event()
                .await
                .expect("workspace event")
                .id,
        );
    }
    ids
}

#[tokio::test]
async fn workspace_sse_wakes_after_an_empty_catch_up_without_missing_a_boundary_commit() {
    let (_temp, _database, store, app) = workspace_sse_app();
    let cursor = store.latest_workspace_event_id().expect("workspace cursor");
    let mut reader = workspace_sse_reader(&app, cursor, None).await;

    assert!(
        tokio::time::timeout(Duration::from_millis(200), reader.next_workspace_event())
            .await
            .is_err()
    );
    let committed = append_test_workspace_event(&store, 1);
    let received = tokio::time::timeout(Duration::from_secs(1), reader.next_workspace_event())
        .await
        .expect("workspace event wakeup")
        .expect("workspace event");

    assert_eq!(received.id, committed);
    assert_eq!(received.event, "workspace_event");
    assert_eq!(received.payload["kind"], "test_event");
}

#[tokio::test]
async fn workspace_sse_replays_coalesced_events_across_multiple_bounded_pages() {
    let (_temp, _database, store, app) = workspace_sse_app();
    let boundary = append_test_workspace_event(&store, 0);
    let reader = workspace_sse_reader(&app, boundary, None).await;
    let expected = (1..=513)
        .map(|value| append_test_workspace_event(&store, value))
        .collect::<Vec<_>>();

    let received = tokio::time::timeout(
        Duration::from_secs(3),
        collect_workspace_event_ids(reader, expected.len()),
    )
    .await
    .expect("multi-page workspace replay");

    assert_eq!(received, expected);
    assert!(received.iter().all(|id| *id > boundary));
}

#[tokio::test]
async fn workspace_sse_reconnects_from_after_or_last_event_id_without_duplicates() {
    let (_temp, _database, store, app) = workspace_sse_app();
    let first = append_test_workspace_event(&store, 1);
    let second = append_test_workspace_event(&store, 2);
    let third = append_test_workspace_event(&store, 3);

    let mut after_reader = workspace_sse_reader(&app, first, None).await;
    assert_eq!(
        after_reader
            .next_workspace_event()
            .await
            .expect("after replay")
            .id,
        second
    );

    let mut header_reader = workspace_sse_reader(&app, first, Some(second)).await;
    assert_eq!(
        header_reader
            .next_workspace_event()
            .await
            .expect("Last-Event-ID replay")
            .id,
        third
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_sse_slow_consumer_does_not_delay_writers_or_fast_consumers() {
    let (_temp, _database, store, app) = workspace_sse_app();
    let slow = workspace_sse_reader(&app, 0, None).await;
    let first_fast = workspace_sse_reader(&app, 0, None).await;
    let second_fast = workspace_sse_reader(&app, 0, None).await;
    let writer_store = Arc::clone(&store);
    let writer = tokio::task::spawn_blocking(move || {
        (0..64)
            .map(|value| append_test_workspace_event(&writer_store, value))
            .collect::<Vec<_>>()
    });
    let first_consumer = tokio::spawn(collect_workspace_event_ids(first_fast, 64));
    let second_consumer = tokio::spawn(collect_workspace_event_ids(second_fast, 64));

    let expected = tokio::time::timeout(Duration::from_secs(2), writer)
        .await
        .expect("workspace writer was not blocked")
        .expect("workspace writer task");
    let first_received = tokio::time::timeout(Duration::from_secs(2), first_consumer)
        .await
        .expect("first fast consumer")
        .expect("first consumer task");
    let second_received = tokio::time::timeout(Duration::from_secs(2), second_consumer)
        .await
        .expect("second fast consumer")
        .expect("second consumer task");

    assert_eq!(first_received, expected);
    assert_eq!(second_received, expected);
    let mut slow = slow;
    assert_eq!(
        slow.next_workspace_event()
            .await
            .expect("slow consumer replay")
            .id,
        expected[0]
    );
}

#[tokio::test(start_paused = true)]
async fn workspace_sse_uses_a_low_frequency_safety_check_for_lost_notifications() {
    let (_temp, database_path, _store, app) = workspace_sse_app();
    let reader = workspace_sse_reader(&app, 0, None).await;
    let recovery = tokio::spawn(collect_workspace_event_ids(reader, 1));
    tokio::task::yield_now().await;

    let connection = rusqlite::Connection::open(database_path).expect("recovery connection");
    connection
        .execute(
            "INSERT INTO workspace_events
             (kind, project_id, conversation_id, run_id, payload)
             VALUES ('recovered_event', NULL, NULL, NULL, '{}')",
            [],
        )
        .expect("durable event without bus notification");
    let committed = u64::try_from(connection.last_insert_rowid()).expect("workspace cursor");

    tokio::time::advance(Duration::from_millis(150)).await;
    tokio::task::yield_now().await;
    assert!(!recovery.is_finished());
    tokio::time::advance(Duration::from_secs(29)).await;
    tokio::task::yield_now().await;
    assert!(!recovery.is_finished());
    tokio::time::advance(Duration::from_secs(1)).await;
    let received = recovery.await.expect("recovery task");

    assert_eq!(received, vec![committed]);
}

#[tokio::test]
async fn workspace_sse_drains_committed_events_then_releases_on_store_shutdown() {
    let (_temp, _database, store, app) = workspace_sse_app();
    let first = append_test_workspace_event(&store, 1);
    let second = append_test_workspace_event(&store, 2);
    let mut reader = workspace_sse_reader(&app, 0, None).await;

    assert_eq!(
        reader
            .next_workspace_event()
            .await
            .expect("first committed event")
            .id,
        first
    );
    assert_eq!(
        reader
            .next_workspace_event()
            .await
            .expect("second committed event")
            .id,
        second
    );

    drop(app);
    drop(store);
    let closed = tokio::time::timeout(Duration::from_secs(1), reader.next_workspace_event())
        .await
        .expect("waiting stream released");
    assert!(closed.is_none());
}

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

async fn runtime_status(app: &Router) -> Value {
    let (status, value) = json_request(
        app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/runtime/status"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    value
}

async fn wait_for_runtime_counts(app: &Router, expected: AgentRuntimeSessionCounts) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let status = runtime_status(app).await;
            if status["active_actor_count"] == expected.active
                && status["idle_actor_count"] == expected.idle
            {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Runtime actor counts")
}

fn run_command(cwd: impl AsRef<std::path::Path>, program: &str, args: &[&str]) {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("run command");
    assert!(
        output.status.success(),
        "{program} failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
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
    assert_eq!(created["workspaces_enabled"], false);
    assert!(created.get("path").is_none());

    let (status, projects) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/projects"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(projects.as_array().expect("projects").len(), 1);
    assert!(projects[0].get("path").is_none());

    let (status, _) = json_request(&app, Method::GET, "/api/v1/projects", Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn exposes_only_runtime_operational_status_below_the_generic_base_path() {
    let (_, app) = app();

    let status = runtime_status(&app).await;

    let keys = status
        .as_object()
        .expect("Runtime status object")
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        keys,
        BTreeSet::from([
            "active_actor_count",
            "idle_actor_count",
            "latest_workspace_event_cursor",
            "warm_actor_limit",
            "workspace_event_delivery_available",
        ])
    );
    assert_eq!(
        status,
        json!({
            "active_actor_count": 0,
            "idle_actor_count": 0,
            "warm_actor_limit": 4,
            "latest_workspace_event_cursor": 0,
            "workspace_event_delivery_available": true,
        })
    );

    let (unprefixed, _) =
        json_request(&app, Method::GET, "/api/v1/runtime/status", Value::Null).await;
    assert_eq!(unprefixed, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn desktop_api_only_router_discovers_the_runtime_and_requires_its_token() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state_dir = root.join(".state/kubecode");
    fs::create_dir_all(&state_dir).expect("state directory");
    let database_path = state_dir.join("kubecode.sqlite3");
    let workspace = WorkspaceService::open(&root, &database_path).expect("workspace service");
    let agent_store = AgentStore::open(&database_path).expect("agent store");
    let teams = TeamStore::open(&database_path).expect("team store");
    let app = app_router_api_only(
        AppState::new(Arc::new(workspace), Arc::new(agent_store), Arc::new(teams)),
        "/",
        "desktop-secret",
    );

    let discovery = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/.well-known/kubecode")
                .body(Body::empty())
                .expect("discovery request"),
        )
        .await
        .expect("discovery response");
    assert_eq!(discovery.status(), StatusCode::OK);
    let body = to_bytes(discovery.into_body(), usize::MAX)
        .await
        .expect("discovery body");
    let discovery: Value = serde_json::from_slice(&body).expect("discovery json");
    assert_eq!(discovery["protocol_version"], 1);
    assert_eq!(discovery["api_base"], "/api/v1");
    assert_eq!(discovery["authentication"], "bearer");
    assert!(discovery.get("token").is_none());

    let unauthorized = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects")
                .body(Body::empty())
                .expect("unauthorized request"),
        )
        .await
        .expect("unauthorized response");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let unauthorized_status = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/runtime/status")
                .body(Body::empty())
                .expect("unauthorized Runtime status request"),
        )
        .await
        .expect("unauthorized Runtime status response");
    assert_eq!(unauthorized_status.status(), StatusCode::UNAUTHORIZED);

    let team_mcp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/team-mcp/invalid-team-token/unknown-conversation")
                .body(Body::empty())
                .expect("Team MCP request"),
        )
        .await
        .expect("Team MCP response");
    assert_eq!(team_mcp.status(), StatusCode::NOT_FOUND);

    let authorized = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects")
                .header(header::AUTHORIZATION, "Bearer desktop-secret")
                .body(Body::empty())
                .expect("authorized request"),
        )
        .await
        .expect("authorized response");
    assert_eq!(authorized.status(), StatusCode::OK);

    let authorized_status = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/runtime/status")
                .header(header::AUTHORIZATION, "Bearer desktop-secret")
                .body(Body::empty())
                .expect("authorized Runtime status request"),
        )
        .await
        .expect("authorized Runtime status response");
    assert_eq!(authorized_status.status(), StatusCode::OK);
}

#[tokio::test]
async fn runtime_status_cursor_advances_only_for_committed_workspace_events() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let store = Arc::new(AgentStore::open(&database).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database).expect("team store"));
    let app = app_router(
        AppState::new(workspace, Arc::clone(&store), teams),
        BASE_PATH,
    );

    let initial_cursor = runtime_status(&app).await["latest_workspace_event_cursor"]
        .as_u64()
        .expect("initial cursor");
    let committed = store
        .append_workspace_event("test_committed", None, None, None, &json!({}))
        .expect("committed event");
    assert!(committed.id > initial_cursor);
    assert_eq!(
        runtime_status(&app).await["latest_workspace_event_cursor"],
        committed.id
    );

    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let run = store
        .start_run(
            &conversation.id,
            "project",
            "Roll back",
            PermissionMode::Safe,
        )
        .expect("run");
    let cursor_before_rollback = store
        .latest_workspace_event_id()
        .expect("cursor before rollback");
    store
        .append_runtime_updates(
            &conversation.id,
            &[
                RuntimeUpdate {
                    session_kind: "text_delta".into(),
                    session_payload: json!({"run_id":run.id, "text":"rolled back"}),
                    run_event: Some(RuntimeRunEvent {
                        run_id: run.id.clone(),
                        kind: AgentEventKind::TextDelta,
                        payload: json!({"text":"rolled back"}),
                    }),
                    publish_session_state: false,
                },
                RuntimeUpdate {
                    session_kind: "thinking_delta".into(),
                    session_payload: json!({"run_id":"missing-run", "text":"invalid"}),
                    run_event: Some(RuntimeRunEvent {
                        run_id: "missing-run".into(),
                        kind: AgentEventKind::ThinkingDelta,
                        payload: json!({"text":"invalid"}),
                    }),
                    publish_session_state: false,
                },
            ],
        )
        .expect_err("invalid Runtime projection must roll back");

    assert_eq!(
        runtime_status(&app).await["latest_workspace_event_cursor"],
        cursor_before_rollback
    );
}

#[tokio::test]
async fn exposes_agent_readiness_and_refreshes_the_shared_catalog() {
    let (_, app) = app();
    let (status, agents) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/agents"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(agents.as_array().expect("agents").len(), 3);
    assert!(agents[0]["readiness"].is_string());
    assert!(agents[0]["cli"]["status"].is_string());
    assert!(agents[0]["adapter"]["kind"].is_string());

    let (status, refreshed) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/agents/refresh"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(refreshed.as_array().expect("refreshed agents").len(), 3);
}

#[tokio::test]
async fn updates_the_project_workspaces_preference_over_http() {
    let (temp, app) = app();
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":temp.path().join("srv/workspaces-api")}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");

    let (status, updated) = json_request(
        &app,
        Method::PATCH,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/workspaces"),
        json!({"enabled":true}),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["workspaces_enabled"], true);
    let (_, projects) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/projects"),
        Value::Null,
    )
    .await;
    assert_eq!(projects[0]["workspaces_enabled"], true);
}

#[tokio::test]
async fn creates_a_session_in_an_isolated_workspace_when_requested() {
    let (temp, app) = app();
    let project_path = temp.path().join("srv/session-worktree-api");
    fs::create_dir_all(&project_path).expect("project directory");
    run_command(&project_path, "git", &["init"]);
    run_command(
        &project_path,
        "git",
        &["config", "user.email", "test@example.com"],
    );
    run_command(
        &project_path,
        "git",
        &["config", "user.name", "Kubecode Test"],
    );
    fs::write(project_path.join("README.md"), "root\n").expect("fixture");
    run_command(&project_path, "git", &["add", "README.md"]);
    run_command(&project_path, "git", &["commit", "-m", "initial"]);
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"import", "path":project_path}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    json_request(
        &app,
        Method::PATCH,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/workspaces"),
        json!({"enabled":true}),
    )
    .await;

    let (status, conversation) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions"),
        json!({"agent_id":"codex", "workspace_mode":"worktree"}),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(conversation["execution_mode"], "worktree");
    assert_eq!(conversation["agent_session_id"], conversation["id"]);
    let workspace_path = conversation["workspace_path"]
        .as_str()
        .expect("workspace path");
    assert!(
        std::path::Path::new(workspace_path)
            .join("README.md")
            .is_file()
    );
    let (status, terminal) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/terminals"),
        json!({
            "kind":"regular",
            "conversation_id":conversation["id"],
            "cols":100,
            "rows":30,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(terminal["conversation_id"], conversation["id"]);

    let (_, other_project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":temp.path().join("srv/other-terminal-project")}),
    )
    .await;
    let other_project_id = other_project["id"].as_str().expect("other project id");
    let (status, _) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{other_project_id}/terminals"),
        json!({
            "kind":"regular",
            "conversation_id":conversation["id"],
            "cols":100,
            "rows":30,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn requires_an_explicit_resolution_before_disabling_workspaces() {
    let (temp, app) = app();
    let project_path = temp.path().join("srv/disable-workspaces-api");
    fs::create_dir_all(&project_path).expect("project directory");
    run_command(&project_path, "git", &["init"]);
    run_command(
        &project_path,
        "git",
        &["config", "user.email", "test@example.com"],
    );
    run_command(
        &project_path,
        "git",
        &["config", "user.name", "Kubecode Test"],
    );
    fs::write(project_path.join("README.md"), "root\n").expect("fixture");
    run_command(&project_path, "git", &["add", "README.md"]);
    run_command(&project_path, "git", &["commit", "-m", "initial"]);
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"import", "path":project_path}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    json_request(
        &app,
        Method::PATCH,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/workspaces"),
        json!({"enabled":true}),
    )
    .await;
    let (_, conversation) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions"),
        json!({"agent_id":"codex", "workspace_mode":"worktree"}),
    )
    .await;
    let conversation_id = conversation["id"].as_str().expect("conversation id");
    let workspace_path = conversation["workspace_path"]
        .as_str()
        .expect("workspace path");
    fs::write(
        std::path::Path::new(workspace_path).join("README.md"),
        "changed\n",
    )
    .expect("worktree change");

    let (status, preview) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/workspaces/migration"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["worktrees"][0]["conversation_id"], conversation_id);
    assert_eq!(preview["worktrees"][0]["dirty"], true);

    let (status, migrated) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/workspaces/migration"),
        json!({
            "resolutions":[{
                "conversation_id":conversation_id,
                "strategy":"export_patch"
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(migrated["project"]["workspaces_enabled"], false);
    assert!(migrated["exports"][0]["path"].as_str().is_some());
    assert!(!std::path::Path::new(workspace_path).exists());

    let (_, sessions) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions"),
        Value::Null,
    )
    .await;
    assert_eq!(sessions[0]["execution_mode"], "shared");
    assert_eq!(sessions[0]["workspace_path"], Value::Null);
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

    let (status, sessions) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sessions.as_array().expect("global sessions").len(), 1);

    let (status, archived) = json_request(
        &app,
        Method::PATCH,
        &format!("{BASE_PATH}/api/v1/sessions/{conversation_id}"),
        json!({"archived":true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(archived["archived"], true);

    let (status, cursor) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/events/cursor"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(cursor["cursor"].as_u64().expect("event cursor") > 0);
}

#[tokio::test]
async fn branches_an_agent_chat_at_an_immutable_turn() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            Arc::clone(&teams),
        ),
        BASE_PATH,
    );
    let project = workspace
        .create_project_at(root.join("chat-branch"))
        .expect("project");
    let conversation = store
        .create_conversation(&project.id, kubecode_server::agents::AgentId::Codex, None)
        .expect("conversation");
    let run = store
        .start_run(
            &conversation.id,
            &project.id,
            "Change this",
            kubecode_server::agents::PermissionMode::Safe,
        )
        .expect("run");
    store
        .finish_run(
            &run.id,
            kubecode_server::agents::RunStatus::Interrupted,
            None,
        )
        .expect("interrupt run");

    let (status, branch) = json_request(
        &app,
        Method::POST,
        &format!(
            "{BASE_PATH}/api/v1/sessions/{}/turns/{}/branch",
            conversation.id, run.id
        ),
        json!({}),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(branch["parent_conversation_id"], conversation.id);
    assert_eq!(branch["relationship"], "branch");
    assert_eq!(branch["recreated_context"], true);

    let incomplete_run = store
        .start_run(
            &conversation.id,
            &project.id,
            "Interrupted change",
            kubecode_server::agents::PermissionMode::Safe,
        )
        .expect("incomplete run");
    store
        .finish_run(
            &incomplete_run.id,
            kubecode_server::agents::RunStatus::Interrupted,
            None,
        )
        .expect("interrupt incomplete run");
    store
        .set_run_checkpoint(&incomplete_run.id, Some("before-tree"), None)
        .expect("incomplete checkpoint");

    let (status, error) = json_request(
        &app,
        Method::POST,
        &format!(
            "{BASE_PATH}/api/v1/sessions/{}/turns/{}/branch",
            conversation.id, incomplete_run.id
        ),
        json!({}),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "checkpoint_unavailable");
}

#[tokio::test]
async fn locks_native_session_mode_while_a_turn_is_active() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            Arc::clone(&teams),
        ),
        BASE_PATH,
    );
    let project = workspace
        .create_project_at(root.join("mode-lock"))
        .expect("project");
    let conversation = store
        .create_conversation(&project.id, AgentId::Codex, None)
        .expect("conversation");
    store
        .start_run(
            &conversation.id,
            &project.id,
            "Keep working",
            kubecode_server::agents::PermissionMode::Safe,
        )
        .expect("active run");
    store
        .append_session_event(
            &conversation.id,
            "config_options",
            &json!({"configOptions":[{
                "category":"mode",
                "id":"profile",
                "name":"Profile",
                "type":"select",
                "currentValue":"build",
                "options":[{"value":"build","name":"Build"}]
            }]}),
        )
        .expect("mode config event");

    let (status, session_state) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions/{}/state", conversation.id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session_state["mode_access"]["can_change"], false);
    assert_eq!(session_state["mode_access"]["reason"], "active_run");

    let (status, error) = json_request(
        &app,
        Method::PATCH,
        &format!("{BASE_PATH}/api/v1/sessions/{}/options", conversation.id),
        json!({"kind":"mode", "value":"read-only"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "session_mode_locked");

    let (status, error) = json_request(
        &app,
        Method::PATCH,
        &format!("{BASE_PATH}/api/v1/sessions/{}/options", conversation.id),
        json!({"kind":"config", "config_id":"profile", "value":"build"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "session_mode_locked");
}

#[tokio::test]
async fn rejects_blank_and_unsupported_side_questions() {
    let (temp, app) = app();
    let (status, error) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/sessions/missing/side-questions"),
        json!({"question":"   "}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "invalid_request");

    let root = temp.path().join("srv");
    let database_path = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = WorkspaceService::open(&root, &database_path).expect("workspace service");
    let store = AgentStore::open(&database_path).expect("agent store");
    let project = workspace
        .create_project_at(root.join("side-question"))
        .expect("project");
    let conversation = store
        .create_conversation(&project.id, AgentId::Codex, None)
        .expect("conversation");

    let (status, error) = json_request(
        &app,
        Method::POST,
        &format!(
            "{BASE_PATH}/api/v1/sessions/{}/side-questions",
            conversation.id
        ),
        json!({"question":"What are you doing?"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "side_question_unavailable");
}

#[tokio::test]
async fn exposes_leader_owned_mode_access_for_standard_team_sessions() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            Arc::clone(&teams),
        ),
        BASE_PATH,
    );
    let project = workspace
        .create_project_at(root.join("team-mode-access"))
        .expect("project");
    let leader = store
        .create_conversation(&project.id, AgentId::Codex, Some("Leader"))
        .expect("leader conversation");
    let teammate = store
        .create_conversation(&project.id, AgentId::Codex, Some("Teammate"))
        .expect("teammate conversation");
    let team = teams
        .create_team(NewTeam {
            project_id: &project.id,
            leader_conversation_id: &leader.id,
            agent_session_id: &leader.agent_session_id,
            leader_name: "Leader",
            title: Some("Mode ownership"),
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    teams
        .add_teammate(NewTeammate {
            team_id: &team.id,
            caller_member_id: &team.leader_member_id,
            conversation_id: &teammate.id,
            name: "Teammate",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("teammate");

    let (status, leader_state) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions/{}/state", leader.id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(leader_state["mode_access"]["can_change"], true);
    assert_eq!(leader_state["mode_access"]["reason"], Value::Null);

    let (status, teammate_state) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions/{}/state", teammate.id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(teammate_state["mode_access"]["can_change"], false);
    assert_eq!(teammate_state["mode_access"]["reason"], "team_teammate");

    let (status, error) = json_request(
        &app,
        Method::PATCH,
        &format!("{BASE_PATH}/api/v1/sessions/{}/options", teammate.id),
        json!({"kind":"mode", "value":"plan"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "session_mode_locked");
}

#[tokio::test]
async fn revises_chat_history_without_failing_when_file_restore_is_unsafe() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            Arc::clone(&teams),
        ),
        BASE_PATH,
    );
    let project = workspace
        .create_project_at(root.join("chat-revision"))
        .expect("project");
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");
    let run = store
        .start_run(
            &conversation.id,
            &project.id,
            "Change this",
            kubecode_server::agents::PermissionMode::Safe,
        )
        .expect("run");
    store
        .finish_run(&run.id, kubecode_server::agents::RunStatus::Completed, None)
        .expect("complete run");
    store
        .set_run_checkpoint(&run.id, Some("before-tree"), None)
        .expect("incomplete checkpoint");

    let (status, revision) = json_request(
        &app,
        Method::POST,
        &format!(
            "{BASE_PATH}/api/v1/sessions/{}/turns/{}/revise",
            conversation.id, run.id
        ),
        Value::Null,
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(revision["conversation_id"], conversation.id);
    assert_eq!(revision["workspace_restore"], "kept");
    assert_eq!(
        revision["workspace_restore_reason"],
        "checkpoint_unavailable"
    );
    assert!(store.list_runs(&conversation.id).expect("runs").is_empty());
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
async fn reads_project_scoped_binary_assets_over_http() {
    let (temp, app) = app();
    let project_root = temp.path().join("srv/assets");
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":project_root}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    fs::create_dir_all(project_root.join("docs")).expect("asset directory");
    let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    fs::write(project_root.join("docs/diagram one.png"), png).expect("asset");

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "{BASE_PATH}/api/v1/projects/{project_id}/asset?path=docs%2Fdiagram%20one.png"
                ))
                .body(Body::empty())
                .expect("asset request"),
        )
        .await
        .expect("asset response");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "private, max-age=60"
    );
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("asset body");
    assert_eq!(bytes.as_ref(), png);

    let traversal = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "{BASE_PATH}/api/v1/projects/{project_id}/asset?path=..%2Foutside.png"
                ))
                .body(Body::empty())
                .expect("traversal request"),
        )
        .await
        .expect("traversal response");
    assert_eq!(traversal.status(), StatusCode::BAD_REQUEST);
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
    let database_path = state_dir.join("kubecode.sqlite3");
    let workspace = WorkspaceService::open(&root, &database_path).expect("workspace service");
    let agent_store = AgentStore::open(&database_path).expect("agent store");
    let teams = TeamStore::open(&database_path).expect("team store");
    let app = app_router_with_static(
        AppState::new(Arc::new(workspace), Arc::new(agent_store), Arc::new(teams)),
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
    assert_eq!(prefixed.status(), StatusCode::PERMANENT_REDIRECT);
    let expected_location = format!("{BASE_PATH}/");
    assert_eq!(
        prefixed
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok()),
        Some(expected_location.as_str()),
    );

    let prefixed_index = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("{BASE_PATH}/"))
                .body(Body::empty())
                .expect("prefixed index request"),
        )
        .await
        .expect("prefixed index response");
    assert_eq!(prefixed_index.status(), StatusCode::OK);

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
    let authorize_uri = format!("{BASE_PATH}/api/v1/projects/{project_id}/authorize");

    let (status, _) = json_request(
        &app,
        Method::POST,
        &authorize_uri,
        json!({"path":temp.path().join("srv/imported")}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, error) = json_request(
        &app,
        Method::POST,
        &authorize_uri,
        json!({"path":temp.path().join("srv")}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "invalid_path");

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
    assert!(temp.path().join("srv/imported").is_dir());
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
async fn projects_and_dispatches_the_latest_advertised_acp_command() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let store = Arc::new(AgentStore::open(&database).expect("agent store"));
    let binary = executable(
        &temp,
        r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' initialize >> "$(dirname "$0")/initialize-count"
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"command-session","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"review","description":"Review changes","input":{"hint":"focus"},"_meta":{"private":"kept-server-side"}}],"_meta":{"private":"kept-server-side"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"command-session","update":{"sessionUpdate":"current_mode_update","currentModeId":"build"}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"command-session\",\"modes\":{\"currentModeId\":\"build\",\"availableModes\":[{\"id\":\"build\",\"name\":\"Build\"}]},\"_meta\":{\"private\":\"journal-only\"}}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' prompt >> "$(dirname "$0")/prompt-count"
      case "$line" in
        *'"text":"/review security"'*) ;;
        *) exit 9 ;;
      esac
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"command-session","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"review","description":"Updated review","input":{"hint":"focus"},"_meta":{"active_private":"must-not-cross-workspace"}}],"_meta":{"active_private":"must-not-cross-workspace"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"command-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Reviewed"}}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done"#,
    );
    let teams = Arc::new(TeamStore::open(&database).expect("team store"));
    let app_state =
        AppState::new(Arc::clone(&workspace), Arc::clone(&store), teams).with_agents(vec![
            AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: binary,
                error: None,
            },
        ]);
    let runtime = Arc::clone(&app_state.agent_runtime);
    let app = app_router(app_state, BASE_PATH);
    let (_, project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":root.join("command-project")}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    let (_, conversation) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions"),
        json!({"agent_id":"opencode"}),
    )
    .await;
    let conversation_id = conversation["id"].as_str().expect("conversation id");

    let (_, state) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions/{conversation_id}/state"),
        Value::Null,
    )
    .await;
    assert_eq!(
        state["available_commands"],
        json!({"availableCommands":[{
            "name":"review",
            "description":"Review changes",
            "input":{"kind":"text", "hint":"focus"}
        }]})
    );
    assert_eq!(state["current_mode"]["currentModeId"], "build");
    assert_eq!(state["current_mode"]["availableModes"][0]["name"], "Build");
    let state_events = store
        .workspace_events_after(0)
        .expect("workspace events")
        .into_iter()
        .filter(|event| event.kind == "session_state")
        .collect::<Vec<_>>();
    assert_eq!(state_events.len(), 3);
    let state_event = state_events.first().expect("session state invalidation");
    assert_eq!(state_event.project_id.as_deref(), Some(project_id));
    assert_eq!(
        state_event.conversation_id.as_deref(),
        Some(conversation_id)
    );
    assert_eq!(state_event.payload, json!({}));
    assert_eq!(state["composer"]["catalog"]["revision"], 1);
    assert_eq!(
        state["composer"]["catalog"]["conversation_id"],
        conversation_id
    );
    assert_eq!(state["composer"]["catalog"]["contexts"], json!([]));
    assert_eq!(state["composer"]["catalog"]["items"][0]["kind"], "command");
    assert_eq!(state["composer"]["catalog"]["items"][0]["scope"], "session");
    assert_eq!(state["composer"]["catalog"]["items"][0]["enabled"], true);
    assert_eq!(
        state["composer"]["catalog"]["items"][0]["input_hint"],
        "focus"
    );
    let item_id = state["composer"]["catalog"]["items"][0]["id"]
        .as_str()
        .expect("composer item id")
        .to_owned();
    assert!(item_id.starts_with("cmd:"));
    let catalog_event = store
        .workspace_events_after(0)
        .expect("workspace events")
        .into_iter()
        .find(|event| {
            event.kind == "composer_catalog_snapshot"
                && event.conversation_id.as_deref() == Some(conversation_id)
        })
        .expect("catalog workspace event");
    assert_eq!(catalog_event.payload["revision"], 1);
    assert_eq!(
        catalog_event.payload["snapshot"],
        state["composer"]["catalog"]
    );
    assert!(
        !catalog_event
            .payload
            .to_string()
            .contains("kept-server-side")
    );
    let raw = store
        .session_events_after(conversation_id, 0)
        .expect("session events")
        .into_iter()
        .find(|event| event.kind == "available_commands")
        .expect("raw command event");
    assert_eq!(raw.payload["_meta"]["private"], "kept-server-side");
    assert_eq!(
        raw.payload["availableCommands"][0]["_meta"]["private"],
        "kept-server-side"
    );
    let (_, public_session_events) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions/{conversation_id}/events?after=0"),
        Value::Null,
    )
    .await;
    assert!(
        !public_session_events
            .to_string()
            .contains("kept-server-side")
    );
    let empty_conversation = store
        .create_conversation(project_id, AgentId::OpenCode, None)
        .expect("empty conversation");
    let (_, empty_state) = json_request(
        &app,
        Method::GET,
        &format!(
            "{BASE_PATH}/api/v1/sessions/{}/state",
            empty_conversation.id
        ),
        Value::Null,
    )
    .await;
    assert_eq!(empty_state["composer"]["catalog"]["revision"], 0);
    assert_eq!(empty_state["composer"]["catalog"]["items"], json!([]));

    let (_, foreign_project) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects"),
        json!({"kind":"create", "path":root.join("foreign-command-project")}),
    )
    .await;
    let foreign_project_id = foreign_project["id"].as_str().expect("foreign project id");
    let foreign_command_uri = format!(
        "{BASE_PATH}/api/v1/projects/{foreign_project_id}/sessions/{conversation_id}/commands"
    );
    let run_count = store.list_runs(conversation_id).expect("runs").len();
    let session_event_count = store
        .session_events_after(conversation_id, 0)
        .expect("session events")
        .len();
    let workspace_event_count = store
        .workspace_events_after(0)
        .expect("workspace events")
        .len();
    let mut foreign_error = None;
    for request in [
        json!({"name":"review", "arguments":""}),
        json!({"name":"missing", "arguments":"security"}),
        json!({"name":"bad name", "arguments":"security"}),
        json!({"item_id":item_id, "catalog_revision":1, "arguments":"security"}),
        json!({"name":"review", "item_id":"mixed", "catalog_revision":1}),
    ] {
        let (status, error) = json_request(&app, Method::POST, &foreign_command_uri, request).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error["code"], "not_found");
        if let Some(expected) = &foreign_error {
            assert_eq!(&error, expected);
        } else {
            foreign_error = Some(error);
        }
    }
    assert_eq!(
        store.list_runs(conversation_id).expect("runs").len(),
        run_count
    );
    assert_eq!(
        store
            .session_events_after(conversation_id, 0)
            .expect("session events")
            .len(),
        session_event_count
    );
    assert_eq!(
        store
            .workspace_events_after(0)
            .expect("workspace events")
            .len(),
        workspace_event_count
    );

    let command_uri =
        format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions/{conversation_id}/commands");
    for request in [
        json!({"name":"review", "item_id":item_id, "catalog_revision":1}),
        json!({"item_id":item_id}),
        json!({"item_id":item_id, "catalog_revision":1, "method":"private"}),
        json!({"name":"review", "arguments":"", "template":"secret"}),
    ] {
        let (status, error) = json_request(&app, Method::POST, &command_uri, request).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["code"], "invalid_request");
    }
    let (status, error) = json_request(
        &app,
        Method::POST,
        &command_uri,
        json!({"item_id":item_id, "catalog_revision":1, "arguments":""}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["code"], "acp_command_input_required");
    assert!(store.list_runs(conversation_id).expect("runs").is_empty());

    let command_workspace_cursor = store.latest_workspace_event_id().expect("workspace cursor");
    let (status, run) = json_request(
        &app,
        Method::POST,
        &command_uri,
        json!({"item_id":item_id, "catalog_revision":1, "arguments":"security"}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(run["internal"], true);
    assert_eq!(run["message"], "/review security");
    let run_id = run["id"].as_str().expect("run id");
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if store.get_run(run_id).expect("run").status
                != kubecode_server::agents::RunStatus::Running
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("command completion");
    let events = store
        .session_events_after(conversation_id, 0)
        .expect("session events");
    assert!(events.iter().any(|event| {
        event.kind == "user_message"
            && event.payload["run_id"] == run_id
            && event.payload["internal"] == true
    }));
    runtime
        .initialize_conversation(conversation_id)
        .await
        .expect("live actor remains ready");
    let initialize_count = fs::read_to_string(temp.path().join("initialize-count"))
        .expect("initialize counter")
        .lines()
        .count();
    assert_eq!(
        initialize_count, 1,
        "catalog updates must not restart the actor"
    );
    assert_eq!(
        store
            .composer_catalog_snapshot(conversation_id)
            .expect("live catalog")
            .revision,
        2,
        "a safe live projection change must advance the catalog revision"
    );
    assert_eq!(
        store
            .composer_catalog_snapshot(conversation_id)
            .expect("live catalog")
            .items[0]
            .description
            .as_deref(),
        Some("Updated review")
    );
    assert!(events.iter().any(|event| {
        event.kind == "text_delta"
            && event.payload["run_id"] == run_id
            && event.payload["text"] == "Reviewed"
    }));
    let active_command_update = events
        .iter()
        .rev()
        .find(|event| event.kind == "available_commands")
        .expect("active command update in private Session journal");
    assert_eq!(
        active_command_update.payload["_meta"]["active_private"],
        "must-not-cross-workspace"
    );
    let command_workspace_events = store
        .workspace_events_after(command_workspace_cursor)
        .expect("command workspace events");
    assert!(command_workspace_events.iter().any(|event| {
        event.kind == "session_state" && event.run_id.is_none() && event.payload == json!({})
    }));
    assert!(command_workspace_events.iter().all(|event| {
        !serde_json::to_string(&event.payload)
            .expect("workspace payload")
            .contains("must-not-cross-workspace")
    }));

    let unchanged_catalog_events = store
        .session_events_after(conversation_id, 0)
        .expect("session events")
        .into_iter()
        .filter(|event| event.kind == "composer_catalog")
        .count();
    store
        .append_runtime_update(
            conversation_id,
            "available_commands",
            &json!({
                "availableCommands":[{
                    "name":"review",
                    "description":"Updated review",
                    "input":{"hint":"focus"},
                    "_meta":{"changed":"still-private"}
                }]
            }),
            None,
        )
        .expect("equivalent command snapshot");
    assert_eq!(
        store
            .session_events_after(conversation_id, 0)
            .expect("session events")
            .into_iter()
            .filter(|event| event.kind == "composer_catalog")
            .count(),
        unchanged_catalog_events
    );
    store
        .append_runtime_update(
            conversation_id,
            "available_commands",
            &json!({"availableCommands":[]}),
            None,
        )
        .expect("replacement command snapshot");
    let (_, state) = json_request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions/{conversation_id}/state"),
        Value::Null,
    )
    .await;
    assert_eq!(state["available_commands"], json!({"availableCommands":[]}));
    assert_eq!(state["composer"]["catalog"]["revision"], 3);
    assert_eq!(state["composer"]["catalog"]["items"], json!([]));
    let run_count = store.list_runs(conversation_id).expect("runs").len();
    let (status, error) = json_request(
        &app,
        Method::POST,
        &command_uri,
        json!({"item_id":item_id, "catalog_revision":1, "arguments":"security"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "composer_stale_revision");
    let (status, error) = json_request(
        &app,
        Method::POST,
        &command_uri,
        json!({"item_id":"cmd:invented", "catalog_revision":3, "arguments":""}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], "composer_item_missing");
    let (status, error) = json_request(
        &app,
        Method::POST,
        &command_uri,
        json!({"name":"review", "arguments":"security"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "acp_command_unavailable");
    assert_eq!(
        store.list_runs(conversation_id).expect("runs").len(),
        run_count
    );
    let prompt_count = fs::read_to_string(temp.path().join("prompt-count"))
        .expect("prompt counter")
        .lines()
        .count();
    assert_eq!(prompt_count, 1, "rejected commands must not reach ACP");
}

#[tokio::test]
async fn runtime_status_tracks_active_idle_evicted_and_shut_down_session_actors() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project(".", "runtime-status-actors")
        .expect("project");
    let store = Arc::new(AgentStore::open(&database).expect("agent store"));
    let release_prompt = temp.path().join("release-prompt");
    let binary = executable(
        &temp,
        &format!(
            r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"protocolVersion\":1,\"agentCapabilities\":{{}},\"authMethods\":[]}}}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"sessionId\":\"runtime-status-session\"}}}}"
      ;;
    *'"method":"session/prompt"'*)
      while [ ! -f '{}' ]; do sleep 0.01; done
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\"}}}}"
      ;;
  esac
done"#,
            release_prompt.display()
        ),
    );
    let teams = Arc::new(TeamStore::open(&database).expect("team store"));
    let state = AppState::new(Arc::clone(&workspace), Arc::clone(&store), teams).with_agents(vec![
        AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        },
    ]);
    let app = app_router(state.clone(), BASE_PATH);
    let active = store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Active"))
        .expect("active conversation");
    state
        .agent_runtime
        .initialize_conversation(&active.id)
        .await
        .expect("initialize active conversation");
    wait_for_runtime_counts(&app, AgentRuntimeSessionCounts { active: 0, idle: 1 }).await;

    state
        .agent_runtime
        .start(StartAgentRun {
            conversation_id: active.id.clone(),
            project_id: project.id.clone(),
            message: "Wait for release".into(),
        })
        .expect("active run");
    wait_for_runtime_counts(&app, AgentRuntimeSessionCounts { active: 1, idle: 0 }).await;

    let mut conversation_ids = vec![active.id];
    for index in 0..5 {
        let conversation = store
            .create_conversation(
                &project.id,
                AgentId::OpenCode,
                Some(&format!("Idle {index}")),
            )
            .expect("idle conversation");
        state
            .agent_runtime
            .initialize_conversation(&conversation.id)
            .await
            .expect("initialize idle conversation");
        conversation_ids.push(conversation.id);
    }
    let bounded =
        wait_for_runtime_counts(&app, AgentRuntimeSessionCounts { active: 1, idle: 4 }).await;
    assert_eq!(
        bounded["warm_actor_limit"],
        state.agent_runtime.session_actor_warm_limit()
    );

    fs::write(&release_prompt, "release").expect("release prompt");
    wait_for_runtime_counts(&app, AgentRuntimeSessionCounts { active: 0, idle: 4 }).await;

    for conversation_id in conversation_ids {
        state
            .agent_runtime
            .disconnect_conversation(&conversation_id)
            .await
            .expect("disconnect conversation");
    }
    wait_for_runtime_counts(&app, AgentRuntimeSessionCounts { active: 0, idle: 0 }).await;
}

#[tokio::test]
async fn classifies_project_directory_failures_during_session_creation() {
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
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"error\":{\"code\":-32603,\"message\":\"OpenCode service failure\",\"data\":{\"service\":\"directory\"}}}"
      ;;
  esac
done"#,
    );
    let teams = Arc::new(TeamStore::open(&database).expect("team store"));
    let app = app_router(
        AppState::new(workspace, store, teams).with_agents(vec![AgentDescriptor {
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
        json!({"kind":"create", "path":root.join("directory-error")}),
    )
    .await;
    let project_id = project["id"].as_str().expect("project id");
    let (status, error) = json_request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions"),
        json!({"agent_id":"opencode"}),
    )
    .await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(error["code"], "agent_project_directory_failed");
    assert_eq!(error["stage"], "session_new");
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
    let teams = Arc::new(TeamStore::open(&database).expect("team store"));
    let app = app_router(
        AppState::new(workspace, store, teams).with_agents(vec![AgentDescriptor {
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

async fn session_entries(app: &Router, conversation_id: &str, path: &str) -> (StatusCode, Value) {
    json_request(
        app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions/{conversation_id}/entries?path={path}"),
        Value::Null,
    )
    .await
}

#[tokio::test]
async fn structured_composer_resolves_session_contexts_without_an_existence_oracle() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database = state.join("kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project_at(root.join("composer-project"))
        .expect("project");
    let project_root = std::path::Path::new(&project.path);
    fs::create_dir(project_root.join("src")).expect("src");
    fs::write(project_root.join("src/main.rs"), "fn main() {}\n").expect("context file");
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let first = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("first session");
    let second = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("second session");
    store
        .append_runtime_update(
            &first.id,
            "available_commands",
            &json!({"availableCommands":[{
                "name":"review", "description":"Review", "input":{"hint":"focus"}
            }]}),
            None,
        )
        .expect("command catalog");
    let binary = executable(
        &temp,
        r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"structured-session\"}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' "$line" >> "$(dirname "$0")/structured-prompts"
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done"#,
    );
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let app = app_router(
        AppState::new(Arc::clone(&workspace), Arc::clone(&store), teams).with_agents(vec![
            AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: binary,
                error: None,
            },
        ]),
        BASE_PATH,
    );
    let registration_uri = format!("{BASE_PATH}/api/v1/sessions/{}/composer/contexts", first.id);
    let (status, registration) = json_request(
        &app,
        Method::POST,
        &registration_uri,
        json!({"kind":"file", "path":"src/main.rs"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let context_id = registration["context"]["id"]
        .as_str()
        .expect("context id")
        .to_owned();
    let selection_revision = registration["catalog"]["revision"]
        .as_u64()
        .expect("selection revision");
    let item_id = registration["catalog"]["items"][0]["id"]
        .as_str()
        .expect("item id")
        .to_owned();
    let (_, foreign_registration) = json_request(
        &app,
        Method::POST,
        &format!(
            "{BASE_PATH}/api/v1/sessions/{}/composer/contexts",
            second.id
        ),
        json!({"kind":"file", "path":"src/main.rs"}),
    )
    .await;
    let foreign_id = foreign_registration["context"]["id"]
        .as_str()
        .expect("foreign id");
    let runs_before = store.list_runs(&first.id).expect("runs").len();
    let events_before = store
        .session_events_after(&first.id, 0)
        .expect("session events")
        .len();
    let workspace_before = store
        .workspace_events_after(0)
        .expect("workspace events")
        .len();
    let runs_uri = format!(
        "{BASE_PATH}/api/v1/projects/{}/sessions/{}/runs",
        project.id, first.id
    );
    let mut missing_error = None;
    for id in [foreign_id, "ctx:invented"] {
        let (status, error) = json_request(
            &app,
            Method::POST,
            &runs_uri,
            json!({
                "catalog_revision":selection_revision,
                "segments":[{
                    "kind":"context_ref", "id":id,
                    "catalog_revision":selection_revision, "context_kind":"file"
                }]
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error["code"], "composer_context_stale");
        if let Some(expected) = &missing_error {
            assert_eq!(&error, expected);
        } else {
            missing_error = Some(error);
        }
    }
    assert_eq!(store.list_runs(&first.id).expect("runs").len(), runs_before);
    assert_eq!(
        store
            .session_events_after(&first.id, 0)
            .expect("session events")
            .len(),
        events_before
    );
    assert_eq!(
        store
            .workspace_events_after(0)
            .expect("workspace events")
            .len(),
        workspace_before
    );
    assert!(!temp.path().join("structured-prompts").exists());

    let (status, error) = json_request(
        &app,
        Method::POST,
        &runs_uri,
        json!({
            "catalog_revision":selection_revision,
            "segments":[{
                "kind":"capability_ref", "id":item_id,
                "catalog_revision":selection_revision, "item_kind":"command"
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["code"], "composer_item_unsupported");
    assert!(!temp.path().join("structured-prompts").exists());

    fs::remove_file(project_root.join("src/main.rs")).expect("remove context");
    let catalog_before_preflight = store
        .composer_catalog_snapshot(&first.id)
        .expect("catalog before filesystem preflight");
    let events_before_preflight = store
        .session_events_after(&first.id, 0)
        .expect("session events before filesystem preflight")
        .len();
    let workspace_before_preflight = store
        .latest_workspace_event_id()
        .expect("workspace cursor before filesystem preflight");
    let (status, error) = json_request(
        &app,
        Method::POST,
        &runs_uri,
        json!({
            "catalog_revision":selection_revision,
            "segments":[{
                "kind":"context_ref", "id":context_id,
                "catalog_revision":selection_revision, "context_kind":"file"
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "composer_context_stale");
    assert_eq!(
        store
            .composer_catalog_snapshot(&first.id)
            .expect("catalog after filesystem preflight"),
        catalog_before_preflight
    );
    assert_eq!(
        store
            .session_events_after(&first.id, 0)
            .expect("session events after filesystem preflight")
            .len(),
        events_before_preflight
    );
    assert_eq!(
        store
            .latest_workspace_event_id()
            .expect("workspace cursor after filesystem preflight"),
        workspace_before_preflight
    );
    assert_eq!(store.list_runs(&first.id).expect("runs").len(), runs_before);
    let validation_uri = format!("{registration_uri}/validate");
    let validation_body = json!({"references":[{
        "id":context_id,
        "catalog_revision":selection_revision,
        "context_kind":"file"
    }]});
    let (status, stale) =
        json_request(&app, Method::POST, &validation_uri, validation_body.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stale["references"][0]["available"], false);
    let stale_revision = stale["catalog"]["revision"]
        .as_u64()
        .expect("stale revision");
    assert!(stale_revision > selection_revision);
    fs::write(project_root.join("src/main.rs"), "fn main() {}\n").expect("restore context");
    let (status, restored) =
        json_request(&app, Method::POST, &validation_uri, validation_body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(restored["references"][0]["available"], true);
    let current_revision = restored["catalog"]["revision"]
        .as_u64()
        .expect("current revision");

    let (status, run) = json_request(
        &app,
        Method::POST,
        &runs_uri,
        json!({
            "item_id":item_id,
            "catalog_revision":current_revision,
            "segments":[
                {"kind":"text", "text":"focus "},
                {
                    "kind":"context_ref", "id":context_id,
                    "catalog_revision":selection_revision, "context_kind":"file"
                }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(run["internal"], true);
    assert_eq!(run["message"], "/review focus @src/main.rs");
    let run_id = run["id"].as_str().expect("run id");
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if store.get_run(run_id).expect("run").status
                != kubecode_server::agents::RunStatus::Running
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("structured run completion");
    let prompt =
        fs::read_to_string(temp.path().join("structured-prompts")).expect("structured prompt");
    assert!(prompt.contains("/review focus @src/main.rs"));

    let (status, error) = json_request(
        &app,
        Method::POST,
        &registration_uri,
        json!({"kind":"file", "path":"../outside"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], "composer_context_outside_project");

    let catalog_before_unregistered_project = store
        .composer_catalog_snapshot(&first.id)
        .expect("catalog before Project removal");
    let events_before_unregistered_project = store
        .session_events_after(&first.id, 0)
        .expect("events before Project removal")
        .len();
    workspace
        .unregister_project(&project.id)
        .expect("unregister Project");
    let (status, _) = json_request(
        &app,
        Method::POST,
        &validation_uri,
        json!({"references":[{
            "id":context_id,
            "catalog_revision":selection_revision,
            "context_kind":"file"
        }]}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        store
            .composer_catalog_snapshot(&first.id)
            .expect("catalog after Project removal"),
        catalog_before_unregistered_project
    );
    assert_eq!(
        store
            .session_events_after(&first.id, 0)
            .expect("events after Project removal")
            .len(),
        events_before_unregistered_project
    );
}

#[tokio::test]
async fn git_diff_context_rechecks_mutation_before_provider_dispatch() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database = state.join("kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project_at(root.join("git-context-project"))
        .expect("project");
    let repository = std::path::Path::new(&project.path);
    run_command(repository, "git", &["init"]);
    run_command(
        repository,
        "git",
        &["config", "user.email", "test@example.com"],
    );
    run_command(repository, "git", &["config", "user.name", "Kubecode Test"]);
    fs::write(repository.join("README.md"), "base\n").expect("fixture");
    run_command(repository, "git", &["add", "README.md"]);
    run_command(repository, "git", &["commit", "-m", "initial"]);
    fs::write(repository.join("README.md"), "base\nfirst\n").expect("first change");

    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");
    let binary = executable(
        &temp,
        r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"git-context-session\"}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' "$line" >> "$(dirname "$0")/git-context-prompts"
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done"#,
    );
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let app = app_router(
        AppState::new(Arc::clone(&workspace), Arc::clone(&store), teams).with_agents(vec![
            AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: binary,
                error: None,
            },
        ]),
        BASE_PATH,
    );
    let discovery_uri = format!(
        "{BASE_PATH}/api/v1/sessions/{}/composer/git-diffs",
        conversation.id
    );
    let (status, candidates) = json_request(&app, Method::GET, &discovery_uri, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(candidates["is_repository"], true);
    assert_eq!(candidates["candidates"][0]["file_count"], 1);
    let revision = candidates["candidates"][0]["source_revision"]
        .as_str()
        .expect("revision");
    let registration_uri = format!(
        "{BASE_PATH}/api/v1/sessions/{}/composer/contexts",
        conversation.id
    );
    let (status, registration) = json_request(
        &app,
        Method::POST,
        &registration_uri,
        json!({"kind":"git_diff", "path":".", "source_revision":revision}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(registration["context"]["kind"], "git_diff");
    assert_eq!(registration["context"]["summary"]["scope"], "all");
    assert!(!registration.to_string().contains("+first"));
    let context_id = registration["context"]["id"].as_str().expect("id");
    let catalog_revision = registration["catalog"]["revision"]
        .as_u64()
        .expect("catalog revision");

    fs::write(repository.join("README.md"), "base\nsecond\n").expect("mutate before submit");
    let runs_uri = format!(
        "{BASE_PATH}/api/v1/projects/{}/sessions/{}/runs",
        project.id, conversation.id
    );
    let stale_request = json!({
        "catalog_revision":catalog_revision,
        "segments":[{
            "kind":"context_ref", "id":context_id,
            "catalog_revision":catalog_revision, "context_kind":"git_diff"
        }]
    });
    let (status, error) = json_request(&app, Method::POST, &runs_uri, stale_request).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "composer_context_stale");
    assert!(store.list_runs(&conversation.id).expect("runs").is_empty());
    assert!(!temp.path().join("git-context-prompts").exists());

    let (_, changed_candidates) =
        json_request(&app, Method::GET, &discovery_uri, Value::Null).await;
    let changed_revision = changed_candidates["candidates"][0]["source_revision"]
        .as_str()
        .expect("changed revision");
    assert_ne!(revision, changed_revision);
    let (_, changed_registration) = json_request(
        &app,
        Method::POST,
        &registration_uri,
        json!({"kind":"git_diff", "path":".", "source_revision":changed_revision}),
    )
    .await;
    let changed_id = changed_registration["context"]["id"]
        .as_str()
        .expect("changed id");
    let changed_catalog_revision = changed_registration["catalog"]["revision"]
        .as_u64()
        .expect("changed catalog revision");
    assert_ne!(context_id, changed_id);
    let (status, _) = json_request(
        &app,
        Method::POST,
        &runs_uri,
        json!({
            "catalog_revision":changed_catalog_revision,
            "segments":[{
                "kind":"context_ref", "id":changed_id,
                "catalog_revision":changed_catalog_revision, "context_kind":"git_diff"
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if temp.path().join("git-context-prompts").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("provider prompt");
    let prompt = fs::read_to_string(temp.path().join("git-context-prompts")).expect("prompt");
    assert!(prompt.contains("Git diff context from Kubecode"));
    assert!(prompt.contains("+second"));
    assert!(!prompt.contains("+first"));
}

#[tokio::test]
async fn terminal_context_is_session_authorized_sanitized_bounded_and_transient() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state_root = root.join(".state/kubecode");
    fs::create_dir_all(&state_root).expect("state directory");
    let database = state_root.join("kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let first_project = workspace
        .create_project_at(root.join("terminal-context-first"))
        .expect("first project");
    let second_project = workspace
        .create_project_at(root.join("terminal-context-second"))
        .expect("second project");
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let target = store
        .create_conversation(&first_project.id, AgentId::Codex, None)
        .expect("target conversation");
    let compatible = store
        .create_conversation(&first_project.id, AgentId::Codex, None)
        .expect("compatible conversation");
    let cross_project = store
        .create_conversation(&second_project.id, AgentId::Codex, None)
        .expect("cross-project conversation");
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let state = AppState::new(Arc::clone(&workspace), Arc::clone(&store), teams).with_agents(vec![
        AgentDescriptor {
            id: AgentId::Codex,
            available: true,
            version: Some("test".into()),
            executable: "/bin/true".into(),
            error: None,
        },
    ]);
    let terminal = state
        .terminals
        .create(
            &first_project.id,
            Some(&target.id),
            None,
            TerminalKind::Regular,
            100,
            28,
        )
        .expect("terminal");
    state
        .terminals
        .write(
            &terminal.id,
            b"printf '\033[31mterminal-visible\033[0m\\n'\n",
        )
        .expect("terminal input");
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if state
                .terminals
                .read_since(&terminal.id, 0)
                .expect("terminal output")
                .data
                .contains("terminal-visible")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("terminal output timeout");
    let app = app_router(state.clone(), BASE_PATH);
    let registration_uri = format!(
        "{BASE_PATH}/api/v1/sessions/{}/composer/contexts",
        target.id
    );
    let (status, registration) = json_request(
        &app,
        Method::POST,
        &registration_uri,
        json!({
            "kind":"terminal", "path":"selection", "terminal_id":terminal.id,
            "selected_text":"terminal-visible"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(registration["context"]["kind"], "terminal");
    assert_eq!(registration["context"]["display"], "terminal");
    assert_eq!(registration["context"]["summary"]["capture"], "selection");
    assert_eq!(registration["context"]["summary"]["line_count"], 1);
    assert_eq!(registration["context"]["summary"]["byte_count"], 16);
    let serialized = registration.to_string();
    assert!(!serialized.contains("terminal-visible"));
    assert!(!serialized.contains(&terminal.id));

    let compatible_uri = format!(
        "{BASE_PATH}/api/v1/sessions/{}/composer/contexts",
        compatible.id
    );
    let (status, compatible_registration) = json_request(
        &app,
        Method::POST,
        &compatible_uri,
        json!({
            "kind":"terminal", "path":"recent", "terminal_id":terminal.id
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(compatible_registration["context"]["kind"], "terminal");
    assert!(!compatible_registration.to_string().contains(&terminal.id));

    let cross_uri = format!(
        "{BASE_PATH}/api/v1/sessions/{}/composer/contexts",
        cross_project.id
    );
    let (status, error) = json_request(
        &app,
        Method::POST,
        &cross_uri,
        json!({
            "kind":"terminal", "path":"recent", "terminal_id":terminal.id
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "composer_context_stale");

    let (status, error) = json_request(
        &app,
        Method::POST,
        &registration_uri,
        json!({
            "kind":"terminal", "path":"recent", "terminal_id":"missing-terminal"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "composer_context_stale");

    let oversized = "x".repeat(64 * 1024 + 1);
    let (status, error) = json_request(
        &app,
        Method::POST,
        &registration_uri,
        json!({
            "kind":"terminal", "path":"selection", "terminal_id":terminal.id,
            "selected_text":oversized
        }),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error["code"], "composer_context_over_limit");

    let context_id = registration["context"]["id"].as_str().expect("context id");
    let catalog_revision = registration["catalog"]["revision"]
        .as_u64()
        .expect("catalog revision");
    let validation_uri = format!(
        "{BASE_PATH}/api/v1/sessions/{}/composer/contexts/validate",
        target.id
    );
    let validation = json!({"references":[{
        "id":context_id, "catalog_revision":catalog_revision, "context_kind":"terminal"
    }]});
    let (status, available) =
        json_request(&app, Method::POST, &validation_uri, validation.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(available["references"][0]["available"], true);

    state.terminals.close(&terminal.id).expect("close terminal");
    let runs_uri = format!(
        "{BASE_PATH}/api/v1/projects/{}/sessions/{}/runs",
        first_project.id, target.id
    );
    let (status, error) = json_request(
        &app,
        Method::POST,
        &runs_uri,
        json!({
            "catalog_revision":catalog_revision,
            "segments":[{
                "kind":"context_ref", "id":context_id,
                "catalog_revision":catalog_revision, "context_kind":"terminal"
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "composer_context_stale");
    assert!(store.list_runs(&target.id).expect("runs").is_empty());

    let (status, stale) = json_request(&app, Method::POST, &validation_uri, validation).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stale["references"][0]["available"], false);
}

#[tokio::test]
async fn lists_session_scoped_entries_for_a_shared_session() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            Arc::clone(&teams),
        ),
        BASE_PATH,
    );
    let project = workspace
        .create_project_at(root.join("shared-entries"))
        .expect("project");
    fs::write(root.join("shared-entries/README.md"), "root\n").expect("fixture");
    let conversation = store
        .create_conversation(&project.id, AgentId::Codex, None)
        .expect("conversation");

    let (status, entries) = session_entries(&app, &conversation.id, "").await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = entries
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| entry["name"].as_str().expect("name"))
        .collect();
    assert!(names.contains(&"README.md"));
}

#[tokio::test]
async fn session_entries_return_404_for_missing_conversation() {
    let (temp, app) = app();
    let _ = temp;
    let (status, error) = session_entries(&app, "no-such-conversation", "").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], "not_found");
}

#[tokio::test]
async fn session_entries_reject_a_conversation_pointed_at_another_worktree() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            Arc::clone(&teams),
        ),
        BASE_PATH,
    );
    let project_root = root.join("cross-worktree");
    let project = workspace.create_project_at(&project_root).expect("project");
    run_command(&project_root, "git", &["init"]);
    run_command(
        &project_root,
        "git",
        &["config", "user.email", "test@example.com"],
    );
    run_command(
        &project_root,
        "git",
        &["config", "user.name", "Kubecode Test"],
    );
    fs::write(project_root.join("README.md"), "root\n").expect("fixture");
    run_command(&project_root, "git", &["add", "README.md"]);
    run_command(&project_root, "git", &["commit", "-m", "initial"]);
    workspace
        .set_workspaces_enabled(&project.id, true)
        .expect("enable workspaces");
    let other_worktree = workspace
        .create_session_worktree(&project.id, "session-aaaaaaaa")
        .expect("other worktree");

    // Conversation B claims to be a worktree session but points at A's worktree.
    let conversation = store
        .create_conversation(&project.id, AgentId::Codex, None)
        .expect("conversation");
    store
        .assign_execution_workspace(
            &conversation.id,
            kubecode_server::agents::ExecutionMode::Worktree,
            Some(other_worktree.to_str().expect("path")),
        )
        .expect("assign execution workspace");

    let (status, error) = session_entries(&app, &conversation.id, "").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "invalid_path");
    assert_eq!(error["message"], "session workspace is unavailable");
    let encoded = error.to_string();
    assert!(!encoded.contains(other_worktree.to_string_lossy().as_ref()));
    assert!(!encoded.contains(project_root.to_string_lossy().as_ref()));
    assert!(!encoded.contains(state.to_string_lossy().as_ref()));

    let git_diff_uri = format!(
        "{BASE_PATH}/api/v1/sessions/{}/composer/git-diffs",
        conversation.id
    );
    let (status, error) = json_request(&app, Method::GET, &git_diff_uri, Value::Null).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "composer_context_stale");
    let encoded = error.to_string();
    assert!(!encoded.contains(other_worktree.to_string_lossy().as_ref()));
    assert!(!encoded.contains(project_root.to_string_lossy().as_ref()));
    assert!(!encoded.contains(state.to_string_lossy().as_ref()));
}

#[tokio::test]
async fn structured_composer_checks_bounds_before_exact_session_worktree_and_provider_dispatch() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let project_root = root.join("structured-worktree-boundary");
    let project = workspace.create_project_at(&project_root).expect("project");
    run_command(&project_root, "git", &["init"]);
    run_command(
        &project_root,
        "git",
        &["config", "user.email", "test@example.com"],
    );
    run_command(
        &project_root,
        "git",
        &["config", "user.name", "Kubecode Test"],
    );
    fs::write(project_root.join("README.md"), "root\n").expect("fixture");
    run_command(&project_root, "git", &["add", "README.md"]);
    run_command(&project_root, "git", &["commit", "-m", "initial"]);
    workspace
        .set_workspaces_enabled(&project.id, true)
        .expect("enable workspaces");
    let valid = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("valid conversation");
    let valid_worktree = workspace
        .create_session_worktree(&project.id, &valid.id)
        .expect("valid worktree");
    store
        .assign_execution_workspace(
            &valid.id,
            kubecode_server::agents::ExecutionMode::Worktree,
            Some(valid_worktree.to_str().expect("valid path")),
        )
        .expect("assign valid worktree");
    let other_worktree = workspace
        .create_session_worktree(&project.id, "session-aaaaaaaa")
        .expect("other worktree");
    let corrupted = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("corrupted conversation");
    store
        .assign_execution_workspace(
            &corrupted.id,
            kubecode_server::agents::ExecutionMode::Worktree,
            Some(other_worktree.to_str().expect("other path")),
        )
        .expect("assign cross-conversation worktree");

    let binary = executable(
        &temp,
        r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"structured-worktree\"}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' "$line" >> "$(dirname "$0")/worktree-prompts"
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done"#,
    );
    let prompts = temp.path().join("worktree-prompts");
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(Arc::clone(&workspace), Arc::clone(&store), teams).with_agents(vec![
            AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: binary,
                error: None,
            },
        ]),
        BASE_PATH,
    );
    let corrupted_runs = format!(
        "{BASE_PATH}/api/v1/projects/{}/sessions/{}/runs",
        project.id, corrupted.id
    );
    let runs_before = store.list_runs(&corrupted.id).expect("runs before").len();
    let events_before = store
        .session_events_after(&corrupted.id, 0)
        .expect("events before")
        .len();
    let workspace_before = store.latest_workspace_event_id().expect("workspace before");
    let over_segments = (0..=MAX_COMPOSER_SEGMENTS)
        .map(|_| json!({"kind":"text", "text":"x"}))
        .collect::<Vec<_>>();
    let (status, error) = json_request(
        &app,
        Method::POST,
        &corrupted_runs,
        json!({"catalog_revision":0, "segments":over_segments}),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error["code"], "composer_context_over_limit");

    let (status, error) = json_request(
        &app,
        Method::POST,
        &corrupted_runs,
        json!({"catalog_revision":0, "segments":[{"kind":"text", "text":"hello"}]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["code"], "invalid_path");
    assert_eq!(
        store.list_runs(&corrupted.id).expect("runs after").len(),
        runs_before
    );
    assert_eq!(
        store
            .session_events_after(&corrupted.id, 0)
            .expect("events after")
            .len(),
        events_before
    );
    assert_eq!(
        store.latest_workspace_event_id().expect("workspace after"),
        workspace_before
    );
    assert!(!prompts.exists());

    let exact_segments = (0..MAX_COMPOSER_SEGMENTS)
        .map(|_| json!({"kind":"text", "text":"x".repeat(MAX_COMPOSER_TEXT_BYTES / MAX_COMPOSER_SEGMENTS)}))
        .collect::<Vec<_>>();
    let (status, _) = json_request(
        &app,
        Method::POST,
        &format!(
            "{BASE_PATH}/api/v1/projects/{}/sessions/{}/runs",
            project.id, valid.id
        ),
        json!({"catalog_revision":0, "segments":exact_segments}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if prompts.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("exact-limit provider prompt");
    assert_eq!(
        fs::read_to_string(prompts)
            .expect("provider prompts")
            .lines()
            .count(),
        1
    );
}

#[tokio::test]
async fn composer_context_validation_enforces_32_unique_rows_at_the_http_boundary() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace"));
    let project = workspace
        .create_project_at(root.join("validation-boundary"))
        .expect("project");
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let conversation = store
        .create_conversation(&project.id, AgentId::Codex, None)
        .expect("conversation");
    let mut references = Vec::with_capacity(MAX_COMPOSER_VALIDATION_ROWS + 1);
    for index in 0..=MAX_COMPOSER_VALIDATION_ROWS {
        let registration = store
            .register_composer_context(
                &conversation.id,
                &project.id,
                ComposerContextKind::File,
                &format!("src/missing-{index}.rs"),
            )
            .expect("register context");
        references.push(json!({
            "id": registration.context.id,
            "catalog_revision": registration.catalog.revision,
            "context_kind": "file",
        }));
    }
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(workspace, Arc::clone(&store), teams),
        BASE_PATH,
    );
    let uri = format!(
        "{BASE_PATH}/api/v1/sessions/{}/composer/contexts/validate",
        conversation.id
    );
    let (status, response) = json_request(
        &app,
        Method::POST,
        &uri,
        json!({"references": &references[..MAX_COMPOSER_VALIDATION_ROWS]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        response["references"]
            .as_array()
            .expect("validation rows")
            .len(),
        MAX_COMPOSER_VALIDATION_ROWS
    );
    let catalog_before = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("catalog before over-limit request");
    let events_before = store
        .session_events_after(&conversation.id, 0)
        .expect("events before over-limit request")
        .len();
    let workspace_before = store.latest_workspace_event_id().expect("workspace before");
    let (status, error) =
        json_request(&app, Method::POST, &uri, json!({"references": references})).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error["code"], "composer_context_over_limit");
    assert_eq!(
        store
            .composer_catalog_snapshot(&conversation.id)
            .expect("catalog after over-limit request"),
        catalog_before
    );
    assert_eq!(
        store
            .session_events_after(&conversation.id, 0)
            .expect("events after over-limit request")
            .len(),
        events_before
    );
    assert_eq!(
        store.latest_workspace_event_id().expect("workspace after"),
        workspace_before
    );
}

#[tokio::test]
async fn lists_session_scoped_entries_for_a_worktree_session() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            Arc::clone(&teams),
        ),
        BASE_PATH,
    );
    let project_root = root.join("worktree-entries");
    let project = workspace.create_project_at(&project_root).expect("project");
    run_command(&project_root, "git", &["init"]);
    run_command(
        &project_root,
        "git",
        &["config", "user.email", "test@example.com"],
    );
    run_command(
        &project_root,
        "git",
        &["config", "user.name", "Kubecode Test"],
    );
    fs::write(project_root.join("README.md"), "root\n").expect("fixture");
    run_command(&project_root, "git", &["add", "README.md"]);
    run_command(&project_root, "git", &["commit", "-m", "initial"]);
    workspace
        .set_workspaces_enabled(&project.id, true)
        .expect("enable workspaces");

    let conversation = store
        .create_conversation(&project.id, AgentId::Codex, None)
        .expect("conversation");
    let worktree = workspace
        .create_session_worktree(&project.id, &conversation.agent_session_id)
        .expect("worktree");
    fs::write(worktree.join("only-in-worktree.txt"), "wt\n").expect("worktree-only file");
    store
        .assign_execution_workspace(
            &conversation.id,
            kubecode_server::agents::ExecutionMode::Worktree,
            Some(worktree.to_str().expect("path")),
        )
        .expect("assign execution workspace");

    let (status, entries) = session_entries(&app, &conversation.id, "").await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = entries
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| entry["name"].as_str().expect("name"))
        .collect();
    assert!(names.contains(&"only-in-worktree.txt"));
}

#[tokio::test]
async fn lists_worktree_entries_for_a_chat_sharing_its_agent_session() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            Arc::clone(&teams),
        ),
        BASE_PATH,
    );
    let project_root = root.join("shared-agent-session-entries");
    let project = workspace.create_project_at(&project_root).expect("project");
    run_command(&project_root, "git", &["init"]);
    run_command(
        &project_root,
        "git",
        &["config", "user.email", "test@example.com"],
    );
    run_command(
        &project_root,
        "git",
        &["config", "user.name", "Kubecode Test"],
    );
    fs::write(project_root.join("README.md"), "root\n").expect("fixture");
    run_command(&project_root, "git", &["add", "README.md"]);
    run_command(&project_root, "git", &["commit", "-m", "initial"]);
    workspace
        .set_workspaces_enabled(&project.id, true)
        .expect("enable workspaces");

    let parent = store
        .create_conversation(&project.id, AgentId::Codex, None)
        .expect("parent conversation");
    let worktree = workspace
        .create_session_worktree(&project.id, &parent.agent_session_id)
        .expect("worktree");
    fs::write(worktree.join("shared-agent-session.txt"), "wt\n").expect("fixture");
    store
        .assign_execution_workspace(
            &parent.id,
            kubecode_server::agents::ExecutionMode::Worktree,
            Some(worktree.to_str().expect("path")),
        )
        .expect("parent workspace");
    let child = store
        .create_team_member(&parent.id, AgentId::ClaudeCode, false)
        .expect("shared team chat");
    assert_ne!(child.id, child.agent_session_id);
    assert_eq!(child.agent_session_id, parent.agent_session_id);

    let (status, entries) = session_entries(&app, &child.id, "").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        entries
            .as_array()
            .expect("entries")
            .iter()
            .any(|entry| { entry["name"] == "shared-agent-session.txt" })
    );
}

#[tokio::test]
async fn session_entries_return_404_after_the_project_is_unregistered() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let store = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let app = app_router(
        AppState::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            Arc::clone(&teams),
        ),
        BASE_PATH,
    );
    let project_root = root.join("unregistered-worktree");
    let project = workspace.create_project_at(&project_root).expect("project");
    run_command(&project_root, "git", &["init"]);
    run_command(
        &project_root,
        "git",
        &["config", "user.email", "test@example.com"],
    );
    run_command(
        &project_root,
        "git",
        &["config", "user.name", "Kubecode Test"],
    );
    fs::write(project_root.join("README.md"), "root\n").expect("fixture");
    run_command(&project_root, "git", &["add", "README.md"]);
    run_command(&project_root, "git", &["commit", "-m", "initial"]);
    workspace
        .set_workspaces_enabled(&project.id, true)
        .expect("enable workspaces");

    let conversation = store
        .create_conversation(&project.id, AgentId::Codex, None)
        .expect("conversation");
    let worktree = workspace
        .create_session_worktree(&project.id, &conversation.id)
        .expect("worktree");
    fs::write(worktree.join("only-in-worktree.txt"), "wt\n").expect("worktree-only file");
    store
        .assign_execution_workspace(
            &conversation.id,
            kubecode_server::agents::ExecutionMode::Worktree,
            Some(worktree.to_str().expect("path")),
        )
        .expect("assign execution workspace");

    // The worktree Session lists its entries before the Project is removed.
    let (status, _) = session_entries(&app, &conversation.id, "").await;
    assert_eq!(status, StatusCode::OK);

    // Unregistering the Project keeps the files and the retained worktree on
    // disk, but the Session can no longer list entries.
    workspace
        .unregister_project(&project.id)
        .expect("unregister project");
    assert!(worktree.is_dir(), "worktree directory is preserved on disk");

    let (status, error) = session_entries(&app, &conversation.id, "").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["code"], "not_found");
}
