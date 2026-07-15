use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_runtime::{AgentRuntime, SessionConfigInput, StartAgentRun};
use kubecode_server::agents::{AgentEventKind, AgentId, AgentStore, RunStatus};
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
async fn changes_native_config_while_a_prompt_is_running() {
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

    assert!(runtime.cancel(&run.id));
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
