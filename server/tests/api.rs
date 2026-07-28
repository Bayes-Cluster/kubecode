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
use kubecode_server::api::{AppState, app_router, app_router_api_only, app_router_with_static};
use kubecode_server::teams::{MemberWorkspaceMode, NewTeam, NewTeammate, TeamStore, TeamWorkspace};
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
