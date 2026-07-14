use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use kubecode_server::agent_discovery::{AgentCandidate, discover_candidates};
use kubecode_server::agents::AgentId;
use tempfile::TempDir;

fn executable(directory: &TempDir, name: &str, output: &str, success: bool) -> PathBuf {
    let path = directory.path().join(name);
    let exit = if success { 0 } else { 1 };
    fs::write(
        &path,
        format!("#!/bin/sh\nprintf '%s\\n' '{output}'\nexit {exit}\n"),
    )
    .expect("write executable");
    let mut permissions = fs::metadata(&path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).expect("permissions");
    path
}

#[tokio::test]
async fn reports_only_the_three_supported_agents_in_stable_order() {
    let directory = TempDir::new().expect("tempdir");
    let candidates = vec![
        AgentCandidate::new(
            AgentId::OpenCode,
            executable(&directory, "opencode", "opencode 1.17.20", true),
        ),
        AgentCandidate::new(
            AgentId::ClaudeCode,
            executable(&directory, "claude", "2.1.0 (Claude Code)", true),
        ),
        AgentCandidate::new(
            AgentId::Codex,
            executable(&directory, "codex", "codex-cli 0.90.0", true),
        ),
    ];

    let agents = discover_candidates(candidates).await;

    assert_eq!(agents.len(), 3);
    assert_eq!(agents[0].id, AgentId::ClaudeCode);
    assert_eq!(agents[1].id, AgentId::Codex);
    assert_eq!(agents[2].id, AgentId::OpenCode);
    assert_eq!(agents[2].version.as_deref(), Some("opencode 1.17.20"));
    assert!(agents.iter().all(|agent| agent.available));
}

#[tokio::test]
async fn keeps_failed_and_missing_executables_visible_with_diagnostics() {
    let directory = TempDir::new().expect("tempdir");
    let candidates = vec![
        AgentCandidate::new(AgentId::ClaudeCode, directory.path().join("missing")),
        AgentCandidate::new(
            AgentId::Codex,
            executable(&directory, "codex", "authentication failed", false),
        ),
        AgentCandidate::new(
            AgentId::OpenCode,
            executable(&directory, "opencode", "opencode 1.17.20", true),
        ),
    ];

    let agents = discover_candidates(candidates).await;

    assert!(!agents[0].available);
    assert!(
        agents[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("missing"))
    );
    assert!(!agents[1].available);
    assert!(
        agents[1]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("authentication failed"))
    );
    assert!(agents[2].available);
}
