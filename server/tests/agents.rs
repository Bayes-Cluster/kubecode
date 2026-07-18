use kubecode_server::agents::{
    AgentEventKind, AgentId, AgentStore, ConversationRelation, ConversationRelationship,
    ExecutionMode, PermissionMode, RunStatus, StoreError,
};
use tempfile::TempDir;

fn store() -> (TempDir, AgentStore) {
    let temp = TempDir::new().expect("tempdir");
    let store = AgentStore::open(temp.path().join("kubecode.sqlite3")).expect("agent store");
    (temp, store)
}

#[test]
fn assigns_an_execution_workspace_to_the_agent_session() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    assert_eq!(conversation.agent_session_id, conversation.id);
    assert_eq!(conversation.execution_mode, ExecutionMode::Shared);
    assert_eq!(conversation.workspace_path, None);

    let updated = store
        .assign_execution_workspace(
            &conversation.id,
            ExecutionMode::Worktree,
            Some("/tmp/kubecode-worktree"),
        )
        .expect("assign workspace");

    assert_eq!(updated.execution_mode, ExecutionMode::Worktree);
    assert_eq!(
        updated.workspace_path.as_deref(),
        Some("/tmp/kubecode-worktree")
    );
    assert_eq!(
        store
            .get_conversation(&conversation.id)
            .expect("persisted conversation"),
        updated,
    );
}

#[test]
fn internal_team_runs_persist_in_the_teammate_session_without_retitling_it() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::OpenCode, Some("Backend Reviewer"))
        .expect("conversation");
    let run = store
        .start_internal_run(
            &conversation.id,
            "project",
            "Kubecode Team mailbox has new updates",
            PermissionMode::Safe,
        )
        .expect("internal run");
    store
        .append_event(
            &run.id,
            AgentEventKind::TextDelta,
            &serde_json::json!({"text":"I reviewed the backend."}),
        )
        .expect("response");

    let persisted = store.list_runs(&conversation.id).expect("runs");
    assert_eq!(persisted.len(), 1);
    assert!(persisted[0].internal);
    assert_eq!(
        store
            .get_conversation(&conversation.id)
            .expect("conversation")
            .title,
        "Backend Reviewer",
    );
    assert!(
        store
            .session_events_after(&conversation.id, 0)
            .expect("session events")
            .iter()
            .any(|event| event.kind == "user_message" && event.payload["internal"] == true)
    );
}

#[test]
fn branches_chat_history_without_rewriting_the_source_session() {
    let (_temp, store) = store();
    let source = store
        .create_conversation("project", AgentId::Codex, Some("Original"))
        .expect("source conversation");
    let first = store
        .start_run(
            &source.id,
            "project",
            "First question",
            PermissionMode::Safe,
        )
        .expect("first run");
    store
        .append_event(
            &first.id,
            AgentEventKind::TextDelta,
            &serde_json::json!({"text":"First answer"}),
        )
        .expect("first answer");
    store
        .finish_run(&first.id, RunStatus::Completed, None)
        .expect("finish first");
    let second = store
        .start_run(
            &source.id,
            "project",
            "Second question",
            PermissionMode::Safe,
        )
        .expect("second run");
    store
        .finish_run(&second.id, RunStatus::Interrupted, None)
        .expect("interrupt second");

    let branch = store
        .branch_conversation_at_run(&source.id, &second.id)
        .expect("branch conversation");

    assert_ne!(branch.id, source.id);
    assert_eq!(branch.agent_session_id, source.agent_session_id);
    assert_eq!(branch.relationship, Some(ConversationRelationship::Branch));
    assert_eq!(
        branch.parent_conversation_id.as_deref(),
        Some(source.id.as_str())
    );
    assert!(branch.recreated_context);
    assert_eq!(store.list_runs(&source.id).expect("source runs").len(), 2);
    assert!(store.list_runs(&branch.id).expect("branch runs").is_empty());
    let history = store
        .session_events_after(&branch.id, 0)
        .expect("branched transcript");
    assert!(history.iter().any(|event| {
        event.kind == "user_message" && event.payload["text"] == "First question"
    }));
    assert!(!history.iter().any(|event| {
        event.kind == "user_message" && event.payload["text"] == "Second question"
    }));
}

#[test]
fn revises_chat_history_without_creating_a_visible_session() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, Some("Stable session"))
        .expect("conversation");
    store
        .set_provider_session(&conversation.id, "provider-original")
        .expect("provider session");
    let first = store
        .start_run(
            &conversation.id,
            "project",
            "First question",
            PermissionMode::Safe,
        )
        .expect("first run");
    store
        .finish_run(&first.id, RunStatus::Completed, None)
        .expect("finish first");
    let second = store
        .start_run(
            &conversation.id,
            "project",
            "Second question",
            PermissionMode::Safe,
        )
        .expect("second run");
    store
        .append_event(
            &second.id,
            AgentEventKind::TextDelta,
            &serde_json::json!({"text":"Original second answer"}),
        )
        .expect("second answer");
    store
        .finish_run(&second.id, RunStatus::Completed, None)
        .expect("finish second");

    let revision = store
        .revise_conversation_at_run(&conversation.id, &second.id)
        .expect("revision");

    assert_eq!(revision.conversation_id, conversation.id);
    assert_eq!(
        store.list_conversations("project").expect("sessions").len(),
        1
    );
    assert_eq!(
        store
            .list_runs(&conversation.id)
            .expect("current runs")
            .len(),
        1
    );
    assert_eq!(
        store
            .list_runs(&revision.snapshot_conversation_id)
            .expect("snapshot runs")
            .len(),
        2,
    );
    assert_eq!(
        store
            .get_conversation(&conversation.id)
            .expect("current conversation")
            .provider_session_id,
        None,
    );
    assert_eq!(
        store.list_revisions(&conversation.id).expect("revisions"),
        vec![revision],
    );
}

#[test]
fn pages_conversation_runs_from_newest_to_oldest_without_reordering_turns() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let mut run_ids = Vec::new();
    for index in 0..5 {
        let run = store
            .start_run(
                &conversation.id,
                "project",
                &format!("Question {index}"),
                PermissionMode::Safe,
            )
            .expect("run");
        store
            .finish_run(&run.id, RunStatus::Completed, None)
            .expect("finish");
        run_ids.push(run.id);
    }

    let (newest, has_more) = store
        .list_runs_page(&conversation.id, None, 2)
        .expect("newest page");
    assert_eq!(
        newest.iter().map(|run| &run.id).collect::<Vec<_>>(),
        vec![&run_ids[3], &run_ids[4]]
    );
    assert!(has_more);

    let (older, has_more) = store
        .list_runs_page(&conversation.id, Some(&run_ids[3]), 2)
        .expect("older page");
    assert_eq!(
        older.iter().map(|run| &run.id).collect::<Vec<_>>(),
        vec![&run_ids[1], &run_ids[2]]
    );
    assert!(has_more);

    let (oldest, has_more) = store
        .list_runs_page(&conversation.id, Some(&run_ids[1]), 2)
        .expect("oldest page");
    assert_eq!(
        oldest.iter().map(|run| &run.id).collect::<Vec<_>>(),
        vec![&run_ids[0]]
    );
    assert!(!has_more);
}

#[test]
fn persists_before_and_after_git_trees_for_a_run() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let run = store
        .start_run(
            &conversation.id,
            "project",
            "Change files",
            PermissionMode::Safe,
        )
        .expect("run");

    store
        .set_run_checkpoint(&run.id, Some("before-tree"), None)
        .expect("before checkpoint");
    store
        .set_run_checkpoint(&run.id, None, Some("after-tree"))
        .expect("after checkpoint");

    let checkpoint = store
        .run_checkpoint(&run.id)
        .expect("checkpoint query")
        .expect("checkpoint");
    assert_eq!(checkpoint.before_tree.as_deref(), Some("before-tree"));
    assert_eq!(checkpoint.after_tree.as_deref(), Some("after-tree"));
}

#[test]
fn team_members_share_the_parent_agent_session_by_default() {
    let (_temp, store) = store();
    let parent = store
        .create_conversation("project", AgentId::ClaudeCode, Some("Lead"))
        .expect("parent");

    let member = store
        .create_team_member(&parent.id, AgentId::Codex, false)
        .expect("team member");

    assert_eq!(member.agent_session_id, parent.agent_session_id);
    assert_eq!(member.execution_mode, parent.execution_mode);
    assert_eq!(member.workspace_path, parent.workspace_path);
    assert_eq!(
        member.parent_conversation_id.as_deref(),
        Some(parent.id.as_str())
    );
    assert_eq!(
        member.relationship,
        Some(ConversationRelationship::TeamMember),
    );

    let isolated = store
        .create_team_member(&parent.id, AgentId::OpenCode, true)
        .expect("isolated team member");
    assert_eq!(isolated.agent_session_id, isolated.id);
    assert_ne!(isolated.agent_session_id, parent.agent_session_id);
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
    assert_eq!(
        store.latest_workspace_event_id().expect("latest cursor"),
        workspace_events.last().expect("workspace event").id
    );
}

#[test]
fn lists_session_summaries_and_persists_archive_and_parent_relationships() {
    let (_temp, store) = store();
    let parent = store
        .create_conversation("project-a", AgentId::ClaudeCode, Some("Parent"))
        .expect("parent");
    let child = store
        .create_related_imported_conversation(
            "project-a",
            AgentId::ClaudeCode,
            "provider-child",
            Some("Child"),
            Some(ConversationRelation {
                parent_conversation_id: parent.id.clone(),
                relationship: ConversationRelationship::Fork,
                read_only: false,
            }),
        )
        .expect("child");
    store.set_archived(&child.id, true).expect("archive child");
    let run = store
        .start_run(&parent.id, "project-a", "Continue", PermissionMode::Safe)
        .expect("parent run");
    store
        .set_run_status(&run.id, RunStatus::WaitingPermission)
        .expect("waiting run");

    let summaries = store.list_all_conversations().expect("all conversations");
    let parent_summary = summaries
        .iter()
        .find(|conversation| conversation.id == parent.id)
        .expect("parent summary");
    assert_eq!(
        parent_summary.latest_run_status,
        Some(RunStatus::WaitingPermission)
    );
    assert!(!parent_summary.archived);
    assert!(!parent_summary.created_at.is_empty());
    assert!(parent_summary.updated_at > parent.updated_at);

    let child_summary = summaries
        .iter()
        .find(|conversation| conversation.id == child.id)
        .expect("child summary");
    assert!(child_summary.archived);
    assert_eq!(
        child_summary.parent_conversation_id.as_deref(),
        Some(parent.id.as_str())
    );
    assert_eq!(
        child_summary.relationship,
        Some(ConversationRelationship::Fork)
    );
    assert!(!child_summary.read_only);
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
