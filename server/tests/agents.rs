use kubecode_server::agents::{
    AgentEventKind, AgentId, AgentStore, PermissionMode, RunStatus, StoreError,
};
use tempfile::TempDir;

fn store() -> (TempDir, AgentStore) {
    let temp = TempDir::new().expect("tempdir");
    let store = AgentStore::open(temp.path().join("kubecode.sqlite3")).expect("agent store");
    (temp, store)
}

#[test]
fn enforces_one_active_run_per_session_and_allows_parallel_sessions() {
    let (_temp, store) = store();
    let first_conversation = store
        .create_conversation("project-a", AgentId::Codex, None)
        .expect("first conversation");
    let second_conversation = store
        .create_conversation("project-a", AgentId::ClaudeCode, None)
        .expect("second conversation");
    let other_project = store
        .create_conversation("project-b", AgentId::OpenCode, None)
        .expect("other project conversation");

    let first = store
        .start_run(
            &first_conversation.id,
            "project-a",
            "first",
            PermissionMode::Safe,
        )
        .expect("first run");
    store
        .set_run_status(&first.id, RunStatus::WaitingPermission)
        .expect("mark run waiting");
    assert_eq!(
        store.get_run(&first.id).expect("waiting run").status,
        RunStatus::WaitingPermission
    );
    store
        .start_run(
            &second_conversation.id,
            "project-a",
            "parallel",
            PermissionMode::Safe,
        )
        .expect("another session in the same project may run");
    let duplicate = store
        .start_run(
            &first_conversation.id,
            "project-a",
            "duplicate",
            PermissionMode::Safe,
        )
        .expect_err("same session must be locked");
    assert!(matches!(duplicate, StoreError::ActiveRun(_)));

    store
        .start_run(
            &other_project.id,
            "project-b",
            "other",
            PermissionMode::Power,
        )
        .expect("different project may run");
    store
        .finish_run(&first.id, RunStatus::Completed, None)
        .expect("finish first run");
    store
        .start_run(
            &first_conversation.id,
            "project-a",
            "next",
            PermissionMode::Safe,
        )
        .expect("session lock released");

    let history = store
        .list_runs(&first_conversation.id)
        .expect("session history");
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].message, "first");
    assert_eq!(history[1].message, "next");

    let project_history = store
        .list_project_runs("project-a")
        .expect("project run history");
    assert_eq!(project_history.len(), 3);
    assert!(
        project_history
            .iter()
            .all(|run| run.project_id == "project-a")
    );
}

#[test]
fn persists_monotonic_events_and_replays_after_a_cursor() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, Some("Refactor"))
        .expect("conversation");
    let run = store
        .start_run(
            &conversation.id,
            "project",
            "Refactor it",
            PermissionMode::Safe,
        )
        .expect("run");

    let first = store
        .append_event(
            &run.id,
            AgentEventKind::TextDelta,
            &serde_json::json!({"text":"a"}),
        )
        .expect("first event");
    let second = store
        .append_event(
            &run.id,
            AgentEventKind::ToolStarted,
            &serde_json::json!({"tool":"shell"}),
        )
        .expect("second event");
    assert_eq!(first.seq, 2);
    assert_eq!(second.seq, 3);

    let replay = store.events_after(&run.id, 2).expect("replay");
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].seq, 3);
    assert_eq!(replay[0].kind, AgentEventKind::ToolStarted);

    let workspace_events = store.workspace_events_after(0).expect("workspace replay");
    assert!(workspace_events.iter().any(|event| {
        event.run_id.as_deref() == Some(run.id.as_str()) && event.kind == "tool_started"
    }));

    store
        .append_session_event(&conversation.id, "plan", &serde_json::json!({"entries":[]}))
        .expect("session event");
    let session_events = store
        .session_events_after(&conversation.id, 0)
        .expect("session replay");
    assert_eq!(session_events[0].kind, "user_message");
    assert_eq!(session_events[1].kind, "plan");
}

#[test]
fn marks_inflight_runs_interrupted_when_the_store_reopens() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let run_id = {
        let store = AgentStore::open(&database).expect("first store");
        let conversation = store
            .create_conversation("project", AgentId::ClaudeCode, None)
            .expect("conversation");
        store
            .start_run(
                &conversation.id,
                "project",
                "Continue",
                PermissionMode::Safe,
            )
            .expect("run")
            .id
    };

    let reopened = AgentStore::open(&database).expect("reopened store");
    let run = reopened.get_run(&run_id).expect("get run");
    assert_eq!(run.status, RunStatus::Interrupted);
    let events = reopened.events_after(&run_id, 0).expect("events");
    assert_eq!(
        events.last().expect("interrupted event").kind,
        AgentEventKind::RunCompleted
    );
}

#[test]
fn permission_rules_are_scoped_to_project_and_agent() {
    let (_temp, store) = store();
    let matcher = serde_json::json!({"tool":"Bash", "command_prefix":"git status"});
    store
        .allow_always("project-a", AgentId::ClaudeCode, &matcher)
        .expect("save rule");

    assert!(
        store
            .is_allowed("project-a", AgentId::ClaudeCode, &matcher)
            .expect("same scope")
    );
    assert!(
        !store
            .is_allowed("project-b", AgentId::ClaudeCode, &matcher)
            .expect("other project")
    );
    assert!(
        !store
            .is_allowed("project-a", AgentId::Codex, &matcher)
            .expect("other agent")
    );
}

#[test]
fn manual_titles_override_agent_titles_and_can_return_to_agent_control() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    assert_eq!(conversation.title, "");
    assert_eq!(conversation.manual_title, None);
    assert_eq!(conversation.agent_title, None);

    store
        .set_agent_title(&conversation.id, Some("Investigate build"))
        .expect("agent title");
    let agent_named = store
        .get_conversation(&conversation.id)
        .expect("agent named");
    assert_eq!(agent_named.title, "Investigate build");
    assert_eq!(
        agent_named.agent_title.as_deref(),
        Some("Investigate build")
    );

    store
        .set_manual_title(&conversation.id, Some("Release blocker"))
        .expect("manual title");
    store
        .set_agent_title(&conversation.id, Some("Agent changed its mind"))
        .expect("new agent title");
    assert_eq!(
        store
            .get_conversation(&conversation.id)
            .expect("manual named")
            .title,
        "Release blocker"
    );

    store
        .set_manual_title(&conversation.id, None)
        .expect("return to agent title");
    assert_eq!(
        store
            .get_conversation(&conversation.id)
            .expect("agent restored")
            .title,
        "Agent changed its mind"
    );
}

#[test]
fn untitled_sessions_receive_a_short_fallback_title_without_overriding_manual_titles() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("untitled conversation");

    store
        .start_run(
            &conversation.id,
            "project",
            "Please implement OAuth login flow for the dashboard",
            PermissionMode::Safe,
        )
        .expect("first run");
    assert_eq!(
        store
            .get_conversation(&conversation.id)
            .expect("generated title")
            .agent_title
            .as_deref(),
        Some("Implement OAuth login flow")
    );

    let manually_named = store
        .create_conversation("project", AgentId::ClaudeCode, Some("Release work"))
        .expect("manually named conversation");
    store
        .set_agent_title_if_untitled(&manually_named.id, "Replace this title")
        .expect("fallback ignored");
    assert_eq!(
        store
            .get_conversation(&manually_named.id)
            .expect("manual title preserved")
            .title,
        "Release work"
    );
}

#[test]
fn imported_sessions_can_derive_a_title_from_replayed_history() {
    let (_temp, store) = store();
    let conversation = store
        .create_imported_conversation("project", AgentId::Codex, "provider-untitled", None)
        .expect("untitled import");

    store
        .set_agent_title_if_untitled(&conversation.id, "修复导入会话历史为空的问题")
        .expect("history title");
    assert_eq!(
        store
            .get_conversation(&conversation.id)
            .expect("generated import title")
            .title,
        "修复导入会话历史为空的问题"
    );
}

#[test]
fn imports_and_removes_provider_sessions_locally() {
    let (_temp, store) = store();
    let conversation = store
        .create_imported_conversation(
            "project",
            AgentId::ClaudeCode,
            "provider-123",
            Some("Native session"),
        )
        .expect("imported conversation");
    assert_eq!(
        conversation.provider_session_id.as_deref(),
        Some("provider-123")
    );
    assert_eq!(conversation.agent_title.as_deref(), Some("Native session"));

    store
        .delete_conversation(&conversation.id)
        .expect("remove local conversation");
    assert!(matches!(
        store.get_conversation(&conversation.id),
        Err(StoreError::ConversationNotFound(_))
    ));
}
