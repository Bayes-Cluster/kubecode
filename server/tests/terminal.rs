use std::fs;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agents::AgentId;
use kubecode_server::terminal::{TerminalError, TerminalKind, TerminalManager};
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;

fn manager(limit: usize) -> (TempDir, String, TerminalManager) {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let workspace = Arc::new(
        WorkspaceService::open(&root, state.join("kubecode.sqlite3")).expect("workspace service"),
    );
    let project = workspace.create_project(".", "terminal").expect("project");
    let manager = TerminalManager::new(workspace, limit, 2 * 1024 * 1024);
    (temp, project.id, manager)
}

#[test]
fn runs_a_shell_in_the_project_and_replays_output_by_cursor() {
    let (_temp, project_id, manager) = manager(8);
    let terminal = manager
        .create(&project_id, TerminalKind::Regular, 80, 24)
        .expect("create terminal");
    assert_eq!(terminal.kind, TerminalKind::Regular);
    manager
        .write(&terminal.id, b"printf 'terminal-ready\\n'\n")
        .expect("write terminal");

    let deadline = Instant::now() + Duration::from_secs(3);
    let snapshot = loop {
        let snapshot = manager.read_since(&terminal.id, 0).expect("snapshot");
        if snapshot.data.contains("terminal-ready") {
            break snapshot;
        }
        assert!(Instant::now() < deadline, "terminal output timed out");
        thread::sleep(Duration::from_millis(20));
    };
    assert!(snapshot.cursor > 0);

    let caught_up = manager
        .read_since(&terminal.id, snapshot.cursor)
        .expect("caught-up snapshot");
    assert!(caught_up.data.is_empty());
    assert!(!caught_up.truncated);

    manager.resize(&terminal.id, 120, 40).expect("resize");
    manager.close(&terminal.id).expect("close");
    assert!(manager.list(&project_id).is_empty());
}

#[test]
fn enforces_a_per_project_terminal_limit() {
    let (_temp, project_id, manager) = manager(1);
    let first = manager
        .create(&project_id, TerminalKind::Regular, 80, 24)
        .expect("first terminal");
    let error = manager
        .create(&project_id, TerminalKind::Regular, 80, 24)
        .expect_err("second terminal must fail");
    assert!(matches!(error, TerminalError::LimitReached));
    manager.close(&first.id).expect("close first terminal");
}

#[test]
fn reports_a_truncated_cursor_when_the_ring_buffer_has_rotated() {
    let (_temp, project_id, manager) = manager(8);
    let small_buffer_manager = TerminalManager::new(manager.workspace(), 8, 16);
    let terminal = small_buffer_manager
        .create(&project_id, TerminalKind::Regular, 80, 24)
        .expect("create terminal");
    small_buffer_manager
        .write(&terminal.id, b"printf 'abcdefghijklmnopqrstuvwxyz'\n")
        .expect("write terminal");

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = small_buffer_manager
            .read_since(&terminal.id, 0)
            .expect("snapshot");
        if snapshot.cursor >= 26 {
            assert!(snapshot.truncated);
            assert!(snapshot.data.len() <= 16);
            break;
        }
        assert!(Instant::now() < deadline, "terminal output timed out");
        thread::sleep(Duration::from_millis(20));
    }
    small_buffer_manager.close(&terminal.id).expect("close");
}

#[test]
fn launches_available_agents_as_tui_terminals() {
    let (temp, project_id, manager) = manager(8);
    let executable = temp.path().join("fake-agent.sh");
    fs::write(&executable, "#!/bin/sh\nprintf 'agent-tui-ready\\n'\ncat\n")
        .expect("write fake agent");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("make fake agent executable");
    }
    let manager = TerminalManager::with_agents(
        manager.workspace(),
        8,
        2 * 1024 * 1024,
        vec![AgentDescriptor {
            id: AgentId::Codex,
            available: true,
            version: Some("test".to_owned()),
            executable: executable.to_string_lossy().into_owned(),
            error: None,
        }],
    );

    let terminal = manager
        .create(&project_id, TerminalKind::Codex, 80, 24)
        .expect("create Codex TUI");
    assert_eq!(terminal.kind, TerminalKind::Codex);
    assert_eq!(terminal.title, "Codex");

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = manager.read_since(&terminal.id, 0).expect("snapshot");
        if snapshot.data.contains("agent-tui-ready") {
            break;
        }
        assert!(Instant::now() < deadline, "agent TUI output timed out");
        thread::sleep(Duration::from_millis(20));
    }
    manager.close(&terminal.id).expect("close");
}

#[test]
fn rejects_unavailable_agent_tui_terminals() {
    let (_temp, project_id, manager) = manager(8);
    let error = manager
        .create(&project_id, TerminalKind::ClaudeCode, 80, 24)
        .expect_err("unavailable agent must fail");
    assert!(matches!(
        error,
        TerminalError::AgentUnavailable(AgentId::ClaudeCode)
    ));
}
