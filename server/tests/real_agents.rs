use std::env;
use std::sync::Arc;
use std::time::Duration;

use kubecode_server::agent_discovery::discover_agents;
use kubecode_server::agent_runtime::AgentRuntime;
use kubecode_server::agents::{AgentId, AgentStore};
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;
use tokio::time::timeout;

#[tokio::test]
#[ignore = "starts installed provider ACP adapters; run explicitly with KUBECODE_REAL_AGENT"]
async fn initializes_installed_agent_through_its_real_acp_adapter() {
    let selected = env::var("KUBECODE_REAL_AGENT").unwrap_or_else(|_| "all".into());
    let descriptors = discover_agents().await;
    let available = descriptors
        .iter()
        .filter(|descriptor| {
            descriptor.available && (selected == "all" || selected == agent_name(descriptor.id))
        })
        .cloned()
        .collect::<Vec<_>>();
    assert!(
        !available.is_empty(),
        "no installed Agent matched KUBECODE_REAL_AGENT={selected}; discovered: {descriptors:?}"
    );

    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, &database).expect("workspace"));
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let runtime = AgentRuntime::new(Arc::clone(&workspace), Arc::clone(&store), descriptors);

    for descriptor in available {
        let project = workspace
            .create_project_at(root.join(format!("real-{}", agent_name(descriptor.id))))
            .expect("project");
        let conversation = store
            .create_conversation(&project.id, descriptor.id, Some("ACP smoke test"))
            .expect("conversation");
        timeout(
            Duration::from_secs(60),
            runtime.initialize_conversation(&conversation.id),
        )
        .await
        .expect("ACP initialization timed out")
        .unwrap_or_else(|error| {
            panic!(
                "{} ACP initialization failed: {error}",
                agent_name(descriptor.id)
            )
        });
        runtime
            .disconnect_conversation(&conversation.id)
            .await
            .expect("disconnect");
    }
}

fn agent_name(agent_id: AgentId) -> &'static str {
    match agent_id {
        AgentId::ClaudeCode => "claude_code",
        AgentId::Codex => "codex",
        AgentId::OpenCode => "opencode",
    }
}
