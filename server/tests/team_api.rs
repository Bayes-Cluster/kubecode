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
use kubecode_server::teams::{
    MemberWorkspaceMode, NewTeamProposal, NewTeammate, StartTeam, TeamMode, TeamStore,
};
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

fn mcp_response_json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or_else(|_| {
        String::from_utf8_lossy(bytes)
            .lines()
            .rev()
            .find_map(|line| line.strip_prefix("data: "))
            .and_then(|data| serde_json::from_str(data).ok())
            .expect("MCP JSON or SSE data")
    })
}

async fn call_mcp_tool(
    router: &Router,
    path: &str,
    session_id: &str,
    id: u64,
    name: &str,
    arguments: Value,
) -> Value {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(path)
                .header(header::HOST, "127.0.0.1:9999")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json, text/event-stream")
                .header("mcp-session-id", session_id)
                .body(Body::from(
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "method": "tools/call",
                        "params": {"name": name, "arguments": arguments}
                    })
                    .to_string(),
                ))
                .expect("MCP tool request"),
        )
        .await
        .expect("MCP tool response");
    assert_eq!(response.status(), StatusCode::OK);
    mcp_response_json(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("MCP tool body"),
    )
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
    assert_eq!(snapshot["team"]["status"], "draft");
    assert_eq!(snapshot["team"]["mode"], "standard");
    assert_eq!(snapshot["members"].as_array().expect("members").len(), 1);
    assert_eq!(snapshot["members"][0]["role"], "leader");
    assert_eq!(snapshot["members"][0]["name"], "Lead");
    assert_eq!(snapshot["tasks"], json!([]));
    assert_eq!(snapshot["leader_conversation"]["agent_id"], "codex");
}

#[tokio::test]
async fn starts_a_team_with_a_goal_and_bounded_agent_autonomy() {
    let (temp, app) = app();
    let project_id = create_project(&app, temp.path()).await;
    let (_, created) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "codex", "leader_name": "Leader"}),
    )
    .await;
    let team_id = created["team"]["id"].as_str().expect("team id");

    let (status, started) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/teams/{team_id}/start"),
        json!({
            "goal": "Reproduce the experiment",
            "acceptance_criteria": ["All tests pass", "Results are documented"],
            "allowed_agent_ids": ["codex", "opencode"],
            "mode": "standard",
            "max_teammates": 3,
            "max_parallel_runs": 2,
            "max_review_rounds": 3
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(started["team"]["status"], "active");
    assert_eq!(started["team"]["goal"], "Reproduce the experiment");
    assert_eq!(started["team"]["mode"], "standard");
    assert_eq!(
        started["team"]["allowed_agent_ids"],
        json!(["codex", "opencode"])
    );
    assert_eq!(started["discrimination_rounds"], json!([]));
}

#[tokio::test]
async fn session_summaries_preserve_team_roles_after_a_server_restart() {
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
    let project_id = create_project(&router, temp.path()).await;
    let (status, created) = request(
        &router,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "codex", "leader_name": "Leader"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let leader_id = created["leader_conversation"]["id"]
        .as_str()
        .expect("leader conversation id")
        .to_owned();
    drop(router);

    let workspace = WorkspaceService::open(&root, &database_path).expect("restarted workspace");
    let agent_store = AgentStore::open(&database_path).expect("restarted agent store");
    let teams = TeamStore::open(&database_path).expect("restarted team store");
    let restarted = app_router(
        AppState::new(Arc::new(workspace), Arc::new(agent_store), Arc::new(teams)),
        BASE_PATH,
    );

    let (status, sessions) = request(
        &restarted,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions"),
        Value::Null,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let leader = sessions
        .as_array()
        .expect("sessions")
        .iter()
        .find(|session| session["id"] == leader_id)
        .expect("persisted leader summary");
    assert_eq!(leader["team_id"], created["team"]["id"]);
    assert_eq!(leader["team_role"], "leader");

    let (status, all_sessions) = request(
        &restarted,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let global_leader = all_sessions
        .as_array()
        .expect("global sessions")
        .iter()
        .find(|session| session["id"] == leader_id)
        .expect("global persisted leader summary");
    assert_eq!(global_leader["team_id"], created["team"]["id"]);
    assert_eq!(global_leader["team_role"], "leader");
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
async fn updates_team_scheduling_and_resolves_only_its_own_proposal() {
    let (temp, app) = app();
    let project_id = create_project(&app, temp.path()).await;
    let (_, first) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "codex", "leader_name": "First"}),
    )
    .await;
    let (_, second) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "claude_code", "leader_name": "Second"}),
    )
    .await;
    let first_id = first["team"]["id"].as_str().expect("first team id");
    let second_id = second["team"]["id"].as_str().expect("second team id");
    let database_path = temp.path().join("srv/.state/kubecode/kubecode.sqlite3");
    let teams = TeamStore::open(database_path).expect("team store");
    let proposal = teams
        .create_proposal(NewTeamProposal {
            team_id: first_id,
            summary: "Add a backend reviewer",
            members_json: r#"[{"agent_id":"opencode","name":"Reviewer"}]"#,
        })
        .expect("proposal");

    let (status, updated) = request(
        &app,
        Method::PATCH,
        &format!("{BASE_PATH}/api/v1/teams/{first_id}/settings"),
        json!({"member_management_policy": "auto", "max_parallel_runs": 4}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["team"]["member_management_policy"], "auto");
    assert_eq!(updated["team"]["max_parallel_runs"], 4);

    let (status, _) = request(
        &app,
        Method::POST,
        &format!(
            "{BASE_PATH}/api/v1/teams/{second_id}/proposals/{}/decision",
            proposal.id
        ),
        json!({"decision": "approved"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, resolved) = request(
        &app,
        Method::POST,
        &format!(
            "{BASE_PATH}/api/v1/teams/{first_id}/proposals/{}/decision",
            proposal.id
        ),
        json!({"decision": "approved"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resolved["proposal"]["status"], "approved");
    assert_eq!(resolved["activity"][0]["kind"], "proposal_approved");
}

#[tokio::test]
async fn deleting_a_teammate_session_requires_the_team_leader() {
    let (temp, app) = app();
    let project_id = create_project(&app, temp.path()).await;
    let (status, created) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "codex", "leader_name": "Leader"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let database_path = temp.path().join("srv/.state/kubecode/kubecode.sqlite3");
    let agents = AgentStore::open(&database_path).expect("agent store");
    let teams = TeamStore::open(&database_path).expect("team store");
    let teammate_conversation = agents
        .create_conversation(&project_id, AgentId::OpenCode, Some("Backend Reviewer"))
        .expect("teammate conversation");
    let teammate = teams
        .add_teammate(NewTeammate {
            team_id: created["team"]["id"].as_str().expect("team id"),
            caller_member_id: created["team"]["leader_member_id"]
                .as_str()
                .expect("leader id"),
            conversation_id: &teammate_conversation.id,
            name: "Backend Reviewer",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("teammate");

    let (status, error) = request(
        &app,
        Method::DELETE,
        &format!("{BASE_PATH}/api/v1/sessions/{}", teammate.conversation_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "teammate_delete_requires_leader");

    let (status, snapshot) = request(
        &app,
        Method::GET,
        &format!(
            "{BASE_PATH}/api/v1/teams/{}",
            created["team"]["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["members"].as_array().expect("members").len(), 2);
    assert_eq!(snapshot["members"][0]["role"], "leader");
    assert_eq!(snapshot["members"][1]["role"], "teammate");
    assert_eq!(
        snapshot["leader_conversation"]["id"],
        created["leader_conversation"]["id"]
    );
}

#[tokio::test]
async fn deleting_a_team_leader_deletes_every_team_session() {
    let (temp, app) = app();
    let project_id = create_project(&app, temp.path()).await;
    let (status, created) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "codex", "leader_name": "Leader"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let database_path = temp.path().join("srv/.state/kubecode/kubecode.sqlite3");
    let agents = AgentStore::open(&database_path).expect("agent store");
    let teams = TeamStore::open(&database_path).expect("team store");
    let team_id = created["team"]["id"].as_str().expect("team id");
    let leader_id = created["leader_conversation"]["id"]
        .as_str()
        .expect("leader conversation id");
    let mut member_conversation_ids = Vec::new();
    for (name, agent_id) in [
        ("Frontend Engineer", AgentId::ClaudeCode),
        ("Backend Engineer", AgentId::OpenCode),
    ] {
        let conversation = agents
            .create_conversation(&project_id, agent_id, Some(name))
            .expect("teammate conversation");
        teams
            .add_teammate(NewTeammate {
                team_id,
                caller_member_id: created["team"]["leader_member_id"]
                    .as_str()
                    .expect("leader member id"),
                conversation_id: &conversation.id,
                name,
                workspace_mode: MemberWorkspaceMode::Shared,
                base_tree: None,
            })
            .expect("teammate");
        member_conversation_ids.push(conversation.id);
    }

    let (status, _) = request(
        &app,
        Method::DELETE,
        &format!("{BASE_PATH}/api/v1/sessions/{leader_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    assert!(agents.get_conversation(leader_id).is_err());
    for conversation_id in member_conversation_ids {
        assert!(
            agents.get_conversation(&conversation_id).is_err(),
            "teammate conversation {conversation_id} should be deleted"
        );
    }
    assert!(teams.get_team(team_id).is_err());
}

#[tokio::test]
async fn deleting_an_opencode_session_uses_the_native_cli_when_acp_only_supports_close() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace = WorkspaceService::open(&root, &database_path).expect("workspace service");
    let agent_store = AgentStore::open(&database_path).expect("agent store");
    let teams = TeamStore::open(&database_path).expect("team store");
    let transcript_path = temp.path().join("delete-acp.jsonl");
    let executable = temp.path().join("opencode-delete");
    fs::write(
        &executable,
        format!(
            r#"#!/bin/sh
if [ "$1" = "session" ] && [ "$2" = "delete" ]; then
  printf 'cli session delete %s\n' "$3" >> '{}'
  exit 0
fi
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"protocolVersion\":1,\"agentCapabilities\":{{\"sessionCapabilities\":{{\"close\":{{}}}}}},\"authMethods\":[]}}}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"sessionId\":\"native-session-to-delete\"}}}}"
      ;;
  esac
done"#,
            transcript_path.display(),
            transcript_path.display()
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
    let (status, conversation) = request(
        &router,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/sessions"),
        json!({"agent_id": "opencode", "title": "Delete me"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let conversation_id = conversation["id"].as_str().expect("conversation id");

    let (status, _) = request(
        &router,
        Method::DELETE,
        &format!("{BASE_PATH}/api/v1/sessions/{conversation_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let transcript = fs::read_to_string(&transcript_path).expect("ACP transcript");
    assert!(transcript.contains("cli session delete native-session-to-delete"));
    let events = AgentStore::open(&database_path)
        .expect("event store")
        .workspace_events_after(0)
        .expect("workspace events");
    let removed = events
        .iter()
        .find(|event| {
            event.kind == "session_removed"
                && event.conversation_id.as_deref() == Some(conversation_id)
        })
        .expect("provider deletion event");
    assert_eq!(removed.payload["scope"], "provider");
}

#[tokio::test]
async fn an_orphaned_team_does_not_hide_persisted_team_leaders() {
    let (temp, app) = app();
    let project_id = create_project(&app, temp.path()).await;
    let (_, orphaned) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "codex", "leader_name": "Removed"}),
    )
    .await;
    let (_, persisted) = request(
        &app,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "claude_code", "leader_name": "Persisted"}),
    )
    .await;
    let orphaned_id = orphaned["leader_conversation"]["id"]
        .as_str()
        .expect("orphaned leader id");
    let persisted_id = persisted["leader_conversation"]["id"]
        .as_str()
        .expect("persisted leader id");

    let (status, _) = request(
        &app,
        Method::DELETE,
        &format!("{BASE_PATH}/api/v1/sessions/{orphaned_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, teams) = request(
        &app,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        Value::Null,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(teams.as_array().expect("teams").len(), 1);
    assert_eq!(teams[0]["leader_conversation"]["id"], persisted_id);
    assert_eq!(teams[0]["members"][0]["role"], "leader");
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
    let transcript_path = temp.path().join("acp.jsonl");
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
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"protocolVersion\":1,\"agentCapabilities\":{{\"mcpCapabilities\":{{\"http\":true,\"sse\":false}},\"sessionCapabilities\":{{\"resume\":{{}},\"delete\":{{}}}}}},\"authMethods\":[]}}}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"sessionId\":\"team-session\",\"configOptions\":[{{\"id\":\"model\",\"name\":\"Model\",\"type\":\"select\",\"currentValue\":\"model-1\",\"options\":[{{\"value\":\"model-1\",\"name\":\"Model 1\"}},{{\"value\":\"model-2\",\"name\":\"Model 2\"}}]}}]}}}}"
      ;;
    *'"method":"session/resume"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{}}}}"
      ;;
    *'"method":"session/set_config_option"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"configOptions\":[{{\"id\":\"model\",\"name\":\"Model\",\"type\":\"select\",\"currentValue\":\"zhipu/glm-5.2\",\"options\":[]}}]}}}}"
      ;;
    *'"method":"session/delete"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{}}}}"
      ;;
  esac
done"#,
            transcript_path.display()
        ),
    )
    .expect("mock agent");
    let mut permissions = fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&executable, permissions).expect("executable permissions");
    let state = AppState::new(Arc::new(workspace), Arc::new(agent_store), Arc::new(teams))
        .with_agents(vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: executable.to_string_lossy().into_owned(),
            error: None,
        }])
        .with_team_mcp_http_origin("http://127.0.0.1:9999/user/alice/kubecode");
    let router = app_router(state.clone(), BASE_PATH);
    let project_id = create_project(&router, temp.path()).await;

    let (status, snapshot) = request(
        &router,
        Method::POST,
        &format!("{BASE_PATH}/api/v1/projects/{project_id}/teams"),
        json!({"agent_id": "opencode", "leader_name": "Leader"}),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    let created_team = state
        .teams
        .get_team(snapshot["team"]["id"].as_str().expect("team id"))
        .expect("created Team");
    state
        .teams
        .start_team(StartTeam {
            team_id: &created_team.id,
            leader_member_id: &created_team.leader_member_id,
            goal: "Review backend changes",
            acceptance_criteria: &["All required tasks are accepted".to_owned()],
            allowed_agent_ids: &["opencode".to_owned()],
            mode: TeamMode::Standard,
            max_teammates: 3,
            max_parallel_runs: 2,
            max_review_rounds: 3,
        })
        .expect("start Team");
    let transcript_text = fs::read_to_string(&transcript_path).expect("ACP transcript");
    let initialize = transcript_text
        .lines()
        .find(|line| line.contains("initialize"))
        .expect("initialize request");
    assert!(initialize.contains("configOptions"), "{initialize}");
    let session_new = transcript_text
        .lines()
        .find(|line| line.contains("session/new"))
        .expect("session/new request");
    assert!(session_new.contains("mcpServers"), "{session_new}");
    assert!(session_new.contains("kubecode-team"), "{session_new}");
    assert!(
        session_new.contains("http://127.0.0.1:9999/user/alice/kubecode/api/v1/team-mcp/"),
        "{session_new}"
    );
    assert!(!session_new.contains("\"url\":\"acp:"), "{session_new}");

    let leader_id = snapshot["leader_conversation"]["id"]
        .as_str()
        .expect("leader conversation id");
    let (status, session_state) = request(
        &router,
        Method::GET,
        &format!("{BASE_PATH}/api/v1/sessions/{leader_id}/state"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        session_state["config_options"]["configOptions"][0]["id"],
        "model"
    );

    let session_new_json: Value = serde_json::from_str(session_new).expect("session/new json");
    let mcp_url = session_new_json["params"]["mcpServers"][0]["url"]
        .as_str()
        .expect("MCP URL");
    let mcp_path = mcp_url
        .strip_prefix("http://127.0.0.1:9999")
        .expect("local MCP path");
    let initialize = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(mcp_path)
                .header(header::HOST, "127.0.0.1:9999")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json, text/event-stream")
                .body(Body::from(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-03-26",
                            "capabilities": {},
                            "clientInfo": {"name": "test", "version": "1"}
                        }
                    })
                    .to_string(),
                ))
                .expect("MCP initialize request"),
        )
        .await
        .expect("MCP initialize response");
    assert_eq!(initialize.status(), StatusCode::OK);
    let session_header = initialize
        .headers()
        .get("mcp-session-id")
        .expect("MCP session header")
        .to_str()
        .expect("MCP session header text")
        .to_owned();
    let initialize_bytes = to_bytes(initialize.into_body(), usize::MAX)
        .await
        .expect("MCP initialize body");
    let initialize_body = mcp_response_json(&initialize_bytes);
    assert!(initialize_body["result"]["capabilities"]["tools"].is_object());
    let initialized = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(mcp_path)
                .header(header::HOST, "127.0.0.1:9999")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json, text/event-stream")
                .header("mcp-session-id", &session_header)
                .body(Body::from(
                    json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized"
                    })
                    .to_string(),
                ))
                .expect("MCP initialized notification"),
        )
        .await
        .expect("MCP initialized response");
    assert!(initialized.status().is_success());
    let tools = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(mcp_path)
                .header(header::HOST, "127.0.0.1:9999")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json, text/event-stream")
                .header("mcp-session-id", &session_header)
                .body(Body::from(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {}
                    })
                    .to_string(),
                ))
                .expect("MCP tools request"),
        )
        .await
        .expect("MCP tools response");
    assert_eq!(tools.status(), StatusCode::OK);
    let tools_body = mcp_response_json(
        &to_bytes(tools.into_body(), usize::MAX)
            .await
            .expect("MCP tools body"),
    );
    assert!(
        tools_body["result"]["tools"]
            .as_array()
            .is_some_and(|tools| tools
                .iter()
                .any(|tool| tool["name"] == "team_spawn_teammate"))
    );
    let tools = tools_body["result"]["tools"].as_array().expect("tools");
    let spawn = tools
        .iter()
        .find(|tool| tool["name"] == "team_spawn_teammate")
        .expect("spawn tool");
    assert!(spawn["inputSchema"]["properties"]["mode"].is_object());
    assert!(spawn["inputSchema"]["properties"]["session_options"].is_object());
    assert!(
        tools
            .iter()
            .any(|tool| tool["name"] == "team_remove_teammate")
    );
    assert!(tools.iter().any(|tool| tool["name"] == "team_list_members"));
    for expected in [
        "team_get_context",
        "team_list_available_agents",
        "team_configure_teammate",
        "team_delegate_task",
        "team_review_plan",
        "team_request_discrimination",
        "team_complete",
    ] {
        assert!(
            tools.iter().any(|tool| tool["name"] == expected),
            "missing {expected}"
        );
    }
    assert!(
        !tools
            .iter()
            .any(|tool| tool["name"] == "team_propose_lineup"),
        "lineup proposals are replaced by bounded Leader autonomy",
    );
    for teammate_only in [
        "team_claim_task",
        "team_report_status",
        "team_submit_result",
    ] {
        assert!(
            !tools.iter().any(|tool| tool["name"] == teammate_only),
            "Leader must not receive {teammate_only}",
        );
    }

    let context = call_mcp_tool(
        &router,
        mcp_path,
        &session_header,
        3,
        "team_get_context",
        json!({}),
    )
    .await;
    let context: Value = serde_json::from_str(
        context["result"]["content"][0]["text"]
            .as_str()
            .expect("Team context JSON"),
    )
    .expect("Team context");
    assert_eq!(context["role"], "leader");
    assert_eq!(context["members"].as_array().expect("members").len(), 1);

    let available = call_mcp_tool(
        &router,
        mcp_path,
        &session_header,
        4,
        "team_list_available_agents",
        json!({}),
    )
    .await;
    let available: Value = serde_json::from_str(
        available["result"]["content"][0]["text"]
            .as_str()
            .expect("available Agents JSON"),
    )
    .expect("available Agents");
    assert_eq!(available.as_array().expect("Agent list").len(), 1);
    assert_eq!(available[0]["agent"]["id"], "opencode");

    let spawned = call_mcp_tool(
        &router,
        mcp_path,
        &session_header,
        6,
        "team_spawn_teammate",
        json!({
            "agent_id": "opencode",
            "name": "Backend Reviewer",
            "workspace_mode": "shared",
            "session_options": {"model": "zhipu/glm-5.2"}
        }),
    )
    .await;
    let teammate: Value = serde_json::from_str(
        spawned["result"]["content"][0]["text"]
            .as_str()
            .expect("spawned teammate JSON"),
    )
    .expect("spawned teammate");
    let teammate_id = teammate["id"].as_str().expect("teammate id");
    let transcript_text = fs::read_to_string(&transcript_path).expect("updated ACP transcript");
    assert!(transcript_text.contains("session/set_config_option"));
    assert!(transcript_text.contains("zhipu/glm-5.2"));

    let members = call_mcp_tool(
        &router,
        mcp_path,
        &session_header,
        4,
        "team_list_members",
        json!({}),
    )
    .await;
    let members: Value = serde_json::from_str(
        members["result"]["content"][0]["text"]
            .as_str()
            .expect("member list JSON"),
    )
    .expect("member list");
    assert!(
        members
            .as_array()
            .is_some_and(|members| { members.iter().any(|member| member["id"] == teammate_id) })
    );

    let removed = call_mcp_tool(
        &router,
        mcp_path,
        &session_header,
        5,
        "team_remove_teammate",
        json!({"teammate_id": teammate_id}),
    )
    .await;
    assert_eq!(removed["result"]["isError"], false);
    assert!(
        fs::read_to_string(&transcript_path)
            .expect("delete transcript")
            .contains("\"method\":\"session/delete\"")
    );
    let (status, snapshot_after_remove) = request(
        &router,
        Method::GET,
        &format!(
            "{BASE_PATH}/api/v1/teams/{}",
            snapshot["team"]["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        snapshot_after_remove["members"].as_array().unwrap().len(),
        1
    );

    state
        .agent_runtime
        .disconnect_conversation(leader_id)
        .await
        .expect("disconnect leader before restart");
    let before_restart = fs::read_to_string(&transcript_path)
        .expect("pre-restart transcript")
        .lines()
        .count();
    let restarted_workspace = WorkspaceService::open(&root, &database_path).expect("workspace");
    let restarted_store = AgentStore::open(&database_path).expect("agent store");
    let restarted_teams = TeamStore::open(&database_path).expect("team store");
    let restarted = AppState::new(
        Arc::new(restarted_workspace),
        Arc::new(restarted_store),
        Arc::new(restarted_teams),
    )
    .with_agents(vec![AgentDescriptor {
        id: AgentId::OpenCode,
        available: true,
        version: Some("test".into()),
        executable: executable.to_string_lossy().into_owned(),
        error: None,
    }])
    .with_team_mcp_http_origin("http://127.0.0.1:9999/user/alice/kubecode");
    restarted
        .agent_runtime
        .initialize_conversation(leader_id)
        .await
        .expect("restore persisted Team Leader");
    let restarted_transcript = fs::read_to_string(&transcript_path).expect("restart transcript");
    let resume = restarted_transcript
        .lines()
        .skip(before_restart)
        .find(|line| line.contains("session/resume"))
        .expect("session/resume request after restart");
    assert!(resume.contains("kubecode-team"), "{resume}");
    assert!(resume.contains("/api/v1/team-mcp/"), "{resume}");
}
