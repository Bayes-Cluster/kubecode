use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_runtime::{AgentRuntime, SessionConfigInput, StartAgentRun};
use kubecode_server::agents::{AgentEventKind, AgentId, AgentStore, RunStatus};
use kubecode_server::teams::{
    MemberWorkspaceMode, NewTeam, NewTeammate, StartTeam, TeamMode, TeamStore, TeamWorkspace,
};
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;

fn executable(directory: &TempDir, body: &str) -> String {
    let path = directory.path().join("codex");
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write mock agent");
    let mut permissions = fs::metadata(&path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).expect("permissions");
    path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn starts_the_acp_process_in_the_session_execution_directory() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project(".", "directory-sensitive-project")
        .expect("project");
    let store = Arc::new(AgentStore::open(&database).expect("agent store"));
    let observed_cwd = temp.path().join("observed-cwd");
    let binary = executable(
        &temp,
        &format!(
            r#"pwd > '{}'
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"protocolVersion\":1,\"agentCapabilities\":{{}},\"authMethods\":[]}}}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"sessionId\":\"cwd-session\"}}}}"
      ;;
  esac
done"#,
            observed_cwd.display()
        ),
    );
    let runtime = AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        }],
    );
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");

    runtime
        .initialize_conversation(&conversation.id)
        .await
        .expect("initialize");

    assert_eq!(
        fs::read_to_string(observed_cwd)
            .expect("observed cwd")
            .trim(),
        workspace
            .project_path(&project.id)
            .expect("project path")
            .to_string_lossy(),
    );
}

#[tokio::test]
async fn initializes_an_opencode_yolo_teammate_with_an_object_permission_override() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project(".", "opencode-team-project")
        .expect("project");
    let store = Arc::new(AgentStore::open(&database).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database).expect("team store"));
    let leader_conversation = store
        .create_conversation(&project.id, AgentId::Codex, Some("Leader"))
        .expect("leader conversation");
    let team = teams
        .create_team(NewTeam {
            project_id: &project.id,
            leader_conversation_id: &leader_conversation.id,
            agent_session_id: &leader_conversation.id,
            leader_name: "Leader",
            title: Some("OpenCode permissions"),
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    let leader = teams.list_members(&team.id).expect("members")[0].clone();
    let criteria = vec!["Teammate starts".to_owned()];
    let allowed_agents = vec!["codex".to_owned(), "opencode".to_owned()];
    teams
        .start_team(StartTeam {
            team_id: &team.id,
            leader_member_id: &leader.id,
            goal: "Start the OpenCode teammate",
            acceptance_criteria: &criteria,
            allowed_agent_ids: &allowed_agents,
            mode: TeamMode::Yolo,
            max_teammates: 2,
            max_parallel_runs: 1,
            max_review_rounds: 1,
        })
        .expect("start team");
    teams.activate_team(&team.id).expect("activate team");
    let teammate_conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Reviewer"))
        .expect("teammate conversation");
    teams
        .add_teammate(NewTeammate {
            team_id: &team.id,
            caller_member_id: &leader.id,
            conversation_id: &teammate_conversation.id,
            name: "Reviewer",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("teammate");

    let binary = executable(
        &temp,
        r#"if [ "$OPENCODE_PERMISSION" != '{"*":"allow"}' ]; then
  exit 88
fi
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{\"mcpCapabilities\":{\"http\":true}},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"opencode-yolo-teammate\"}}"
      ;;
  esac
done"#,
    );
    let runtime = AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("1.17.20".into()),
            executable: binary,
            error: None,
        }],
    )
    .with_team_store(Arc::clone(&teams))
    .with_team_mcp_http_origin("http://127.0.0.1:9999/user/alice/kubecode");

    runtime
        .initialize_conversation(&teammate_conversation.id)
        .await
        .expect("initialize OpenCode teammate");
    assert_eq!(
        store
            .get_conversation(&teammate_conversation.id)
            .expect("initialized teammate")
            .provider_session_id
            .as_deref(),
        Some("opencode-yolo-teammate"),
    );
    runtime
        .disconnect_conversation(&teammate_conversation.id)
        .await
        .expect("disconnect teammate");
}

#[tokio::test]
async fn initializes_provider_session_and_commands_before_the_first_prompt() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project(".", "agent-project")
        .expect("project");
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
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-ready","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"status","description":"Show session status"}]}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"session-ready\"}}"
      ;;
  esac
done"#,
    );
    let runtime = AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        }],
    );
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");

    runtime
        .initialize_conversation(&conversation.id)
        .await
        .expect("initialize ACP session");

    let initialized = store
        .get_conversation(&conversation.id)
        .expect("initialized conversation");
    assert_eq!(
        initialized.provider_session_id.as_deref(),
        Some("session-ready")
    );
    let events = store
        .session_events_after(&conversation.id, 0)
        .expect("session events");
    assert!(events.iter().any(|event| {
        event.kind == "available_commands"
            && event.payload["availableCommands"][0]["name"] == "status"
    }));
}

#[tokio::test]
async fn reconnects_a_session_before_changing_its_native_mode() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project(".", "agent-project")
        .expect("project");
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
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"session-reconnected\"}}"
      ;;
    *'"method":"session/set_mode"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{}}"
      ;;
  esac
done"#,
    );
    let runtime = AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        }],
    );
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");

    runtime
        .set_session_mode(&conversation.id, "acceptEdits".into())
        .await
        .expect("reconnect and set mode");

    assert_eq!(
        store
            .get_conversation(&conversation.id)
            .expect("reconnected conversation")
            .provider_session_id
            .as_deref(),
        Some("session-reconnected")
    );
    assert!(
        store
            .session_events_after(&conversation.id, 0)
            .expect("session events")
            .iter()
            .any(|event| {
                event.kind == "current_mode" && event.payload["currentModeId"] == "acceptEdits"
            })
    );
}

#[tokio::test]
async fn importing_provider_session_loads_history_before_resuming() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project(".", "agent-project")
        .expect("project");
    let store = Arc::new(AgentStore::open(&database).expect("agent store"));
    let binary = executable(
        &temp,
        r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{\"loadSession\":true,\"sessionCapabilities\":{\"resume\":{}}},\"authMethods\":[]}}"
      ;;
    *'"method":"session/resume"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{}}"
      ;;
    *'"method":"session/load"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"provider-session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Earlier request"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"provider-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Earlier response"}}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{}}"
      ;;
  esac
done"#,
    );
    let runtime = AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        }],
    );
    let conversation = store
        .create_imported_conversation(&project.id, AgentId::OpenCode, "provider-session", None)
        .expect("imported conversation");

    runtime
        .initialize_conversation(&conversation.id)
        .await
        .expect("initialize imported ACP session");

    let events = store
        .session_events_after(&conversation.id, 0)
        .expect("session events");
    assert!(events.iter().any(|event| {
        event.kind == "user_message_delta" && event.payload["text"] == "Earlier request"
    }));
    assert!(events.iter().any(|event| {
        event.kind == "text_delta" && event.payload["text"] == "Earlier response"
    }));
    assert_eq!(
        store
            .get_conversation(&conversation.id)
            .expect("imported title")
            .title,
        "Earlier request"
    );
}

#[tokio::test]
async fn changes_native_config_and_disconnects_while_a_prompt_is_running() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project(".", "agent-project")
        .expect("project");
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
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"session-config\"}}"
      ;;
    *'"method":"session/set_config_option"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"configOptions\":[]}}"
      ;;
    *'"method":"session/set_mode"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{}}"
      ;;
  esac
done"#,
    );
    let runtime = AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        }],
    );
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");
    runtime
        .initialize_conversation(&conversation.id)
        .await
        .expect("initialize ACP session");
    let run = runtime
        .start(StartAgentRun {
            conversation_id: conversation.id.clone(),
            project_id: project.id,
            message: "Keep working".into(),
        })
        .expect("start prompt");

    tokio::time::timeout(
        Duration::from_secs(1),
        runtime.set_session_config(
            &conversation.id,
            "permissionMode".into(),
            SessionConfigInput::ValueId("acceptEdits".into()),
        ),
    )
    .await
    .expect("config update must not wait for prompt completion")
    .expect("set config");

    runtime
        .set_session_mode(&conversation.id, "acceptEdits".into())
        .await
        .expect("set mode");
    let events = store
        .session_events_after(&conversation.id, 0)
        .expect("session events");
    assert!(events.iter().any(|event| {
        event.kind == "current_mode" && event.payload["currentModeId"] == "acceptEdits"
    }));

    tokio::time::timeout(
        Duration::from_secs(1),
        runtime.disconnect_conversation(&conversation.id),
    )
    .await
    .expect("disconnect must not wait for prompt completion")
    .expect("disconnect session");
    let stopped = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let current = store.get_run(&run.id).expect("run");
            if current.status != RunStatus::Running {
                break current;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("run stops after disconnect");
    assert_eq!(stopped.status, RunStatus::Cancelled);
}

#[tokio::test]
async fn keeps_running_after_start_returns_and_persists_normalized_events() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let project = workspace
        .create_project(".", "agent-project")
        .expect("project");
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
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"session-1\"}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Shell","rawInput":{"command":"pwd"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed","rawOutput":"ok"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Finished"}}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done"#,
    );
    let runtime = AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        }],
    );
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");

    let run = runtime
        .start(StartAgentRun {
            conversation_id: conversation.id.clone(),
            project_id: project.id.clone(),
            message: "Do the work".into(),
        })
        .expect("start run");

    let completed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let current = store.get_run(&run.id).expect("run");
            if current.status != RunStatus::Running {
                break current;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("run completion");
    assert_eq!(completed.status, RunStatus::Completed);

    let events = store.events_after(&run.id, 0).expect("events");
    assert!(events.iter().any(|event| {
        event.kind == AgentEventKind::TextDelta && event.payload["text"] == "Finished"
    }));
    assert!(
        events
            .iter()
            .any(|event| event.kind == AgentEventKind::ToolStarted)
    );
    assert_eq!(
        events.last().expect("terminal event").kind,
        AgentEventKind::RunCompleted
    );

    let second = runtime
        .start(StartAgentRun {
            conversation_id: conversation.id,
            project_id: project.id,
            message: "Continue in the same ACP session".into(),
        })
        .expect("start second run");
    let second_completed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let current = store.get_run(&second.id).expect("second run");
            if current.status != RunStatus::Running {
                break current;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("second run completion");
    assert_eq!(second_completed.status, RunStatus::Completed);
}
