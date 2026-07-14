use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_runtime::{AgentRuntime, StartAgentRun};
use kubecode_server::agents::{AgentEventKind, AgentId, AgentStore, PermissionMode, RunStatus};
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
        r#"printf '%s\n' '{"type":"thread.started","thread_id":"thread-1"}'
printf '%s\n' '{"type":"item.started","item":{"id":"tool-1","type":"command_execution","command":"pwd"}}'
printf '%s\n' '{"type":"item.completed","item":{"id":"tool-1","type":"command_execution","aggregated_output":"ok"}}'
printf '%s\n' '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"Finished"}}'"#,
    );
    let runtime = AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::Codex,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        }],
    );
    let conversation = store
        .create_conversation(&project.id, AgentId::Codex, None)
        .expect("conversation");

    let run = runtime
        .start(StartAgentRun {
            conversation_id: conversation.id,
            project_id: project.id,
            message: "Do the work".into(),
            permission_mode: PermissionMode::Safe,
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
}
