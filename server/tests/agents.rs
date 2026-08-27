use kubecode_server::agents::{
    AgentEventKind, AgentId, AgentStore, ConversationRelation, ConversationRelationship,
    ExecutionMode, PermissionMode, RunStatus, RuntimeRunEvent, RuntimeUpdate, StoreError,
    TerminalCause,
};
use kubecode_server::composer_catalog::{
    ComposerCatalogError, ComposerContextKind, ComposerContextSelector, ComposerContextSummary,
    ComposerDraftSegment, ComposerInvocation, ComposerItemKind, ComposerPreflightContext,
    ComposerSessionTurnRole, MAX_COMPOSER_CONTEXTS, MAX_COMPOSER_REFERENCES, MAX_COMPOSER_SEGMENTS,
    MAX_COMPOSER_TEXT_BYTES, MAX_COMPOSER_VALIDATION_ROWS, MAX_SESSION_TURN_CONTEXT_BYTES,
    session_turn_selector,
};
use kubecode_server::terminal::TerminalContextCaptureKind;
use serde_json::json;
use std::sync::Arc;
use tempfile::TempDir;

fn store() -> (TempDir, AgentStore) {
    let temp = TempDir::new().expect("tempdir");
    let store = AgentStore::open(temp.path().join("kubecode.sqlite3")).expect("agent store");
    (temp, store)
}

#[test]
fn composer_catalog_reopens_with_exact_snapshot_and_rejects_foreign_ids() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = AgentStore::open(&database).expect("agent store");
    let first = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("first conversation");
    let second = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("second conversation");
    let raw = json!({"availableCommands":[
        {"name":"status", "description":"Show status"},
        {"name":"future", "description":"Future", "input":{"type":"choices"}}
    ], "_meta":{"private":"server-only"}});
    for conversation in [&first, &second] {
        store
            .append_runtime_update(&conversation.id, "available_commands", &raw, None)
            .expect("catalog update");
    }
    let before = store
        .composer_catalog_snapshot(&first.id)
        .expect("first snapshot");
    let second_snapshot = store
        .composer_catalog_snapshot(&second.id)
        .expect("second snapshot");
    assert_eq!(before.revision, 1);
    assert_ne!(before.items[0].id, second_snapshot.items[0].id);
    assert!(!before.items[1].enabled);
    assert_eq!(
        before.items[1].disabled_reason.as_deref(),
        Some("unsupported_input")
    );
    let disabled = store
        .start_typed_composer_command(
            &first.id,
            "project",
            &before.items[1].id,
            before.revision,
            "",
            PermissionMode::Safe,
        )
        .expect_err("disabled item");
    assert!(matches!(
        disabled,
        StoreError::Composer(kubecode_server::composer_catalog::ComposerCatalogError::ItemDisabled)
    ));
    assert!(store.list_runs(&first.id).expect("runs").is_empty());
    let foreign = store
        .start_typed_composer_command(
            &second.id,
            "project",
            &before.items[0].id,
            second_snapshot.revision,
            "",
            PermissionMode::Safe,
        )
        .expect_err("foreign item id");
    assert!(matches!(
        foreign,
        StoreError::Composer(kubecode_server::composer_catalog::ComposerCatalogError::ItemMissing)
    ));
    assert!(store.list_runs(&second.id).expect("runs").is_empty());
    let run = store
        .start_typed_composer_command(
            &first.id,
            "project",
            &before.items[0].id,
            before.revision,
            "",
            PermissionMode::Safe,
        )
        .expect("typed run");
    store
        .finish_run(&run.id, RunStatus::Completed, None, TerminalCause::EndTurn)
        .expect("finish typed run");
    let branch = store
        .branch_conversation_at_run(&first.id, &run.id)
        .expect("branch conversation");
    let branch_catalog = store
        .composer_catalog_snapshot(&branch.id)
        .expect("branch catalog");
    assert_eq!(branch_catalog.conversation_id, branch.id);
    assert_eq!(branch_catalog.revision, 0);
    assert!(branch_catalog.items.is_empty());
    drop(store);

    let reopened = AgentStore::open(&database).expect("reopened store");
    assert_eq!(
        reopened
            .composer_catalog_snapshot(&first.id)
            .expect("reopened snapshot"),
        before
    );
}

#[test]
fn claude_skill_catalog_reopens_and_dispatches_the_exact_advertised_identity() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = AgentStore::open(&database).expect("agent store");
    let conversation = store
        .create_conversation("project", AgentId::ClaudeCode, None)
        .expect("Claude conversation");
    let raw = json!({
        "availableCommands": [
            {"name":"review", "description":"Review code", "input":{"hint":"<path>"}},
            {"name":"status", "description":"Show status"}
        ],
        "_meta": {"kubecode":{"claudeSkills":{
            "version":1,
            "supported":true,
            "skills":[{
                "identity":"review",
                "name":"review",
                "description":"Review code",
                "inputHint":"<path>",
                "scope":"project",
                "sourceLabel":"Project skill",
                "enabled":true
            }]
        }}}
    });
    store
        .append_runtime_update(&conversation.id, "available_commands", &raw, None)
        .expect("Claude skill update");
    let before = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("Claude skill catalog");
    let skill = before
        .items
        .iter()
        .find(|item| item.kind == ComposerItemKind::Skill)
        .expect("skill")
        .clone();
    drop(store);

    let reopened = AgentStore::open(&database).expect("reopened store");
    let after = reopened
        .composer_catalog_snapshot(&conversation.id)
        .expect("reopened Claude skill catalog");
    assert_eq!(after, before);
    let run = reopened
        .start_typed_composer_command(
            &conversation.id,
            "project",
            &skill.id,
            after.revision,
            "src/lib.rs",
            PermissionMode::Safe,
        )
        .expect("Claude skill run");
    assert_eq!(run.message, "/review src/lib.rs");
    assert!(run.internal);
}

#[test]
fn codex_skill_catalog_reopens_with_private_structured_dispatch() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = AgentStore::open(&database).expect("agent store");
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("Codex conversation");
    let path = "/srv/project/.agents/skills/review/SKILL.md";
    let raw = json!({
        "availableCommands": [{"name":"status", "description":"Show status"}],
        "_meta": {"kubecode":{"codexSkills":{
            "version":1,
            "supported":true,
            "structuredInput":true,
            "textFallback":false,
            "skills":[{
                "identity":path,
                "name":"review",
                "description":"Review code",
                "path":path,
                "providerScope":"repo",
                "sourceLabel":"Project skill",
                "enabled":true
            }]
        }}}
    });
    store
        .append_runtime_update(&conversation.id, "available_commands", &raw, None)
        .expect("Codex skill update");
    let before = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("Codex skill catalog");
    let skill = before
        .items
        .iter()
        .find(|item| item.kind == ComposerItemKind::Skill)
        .expect("skill")
        .clone();
    assert!(
        !serde_json::to_string(&before)
            .expect("safe catalog")
            .contains(path)
    );
    drop(store);

    let reopened = AgentStore::open(&database).expect("reopened store");
    let dispatch = reopened
        .start_typed_composer_command_dispatch(
            &conversation.id,
            "project",
            &skill.id,
            before.revision,
            "focus on tests",
            PermissionMode::Safe,
        )
        .expect("Codex structured dispatch");
    assert_eq!(dispatch.run.message, "$review focus on tests");
    assert_eq!(dispatch.prompt_message, "focus on tests");
    assert_eq!(
        dispatch.provider_input,
        Some(ComposerInvocation::ProviderStructuredInput {
            adapter_kind: "codex".to_owned(),
            payload: json!({"type":"skill", "name":"review", "path":path}),
        })
    );
    let user_message = reopened
        .session_events_after(&conversation.id, 0)
        .expect("session events")
        .into_iter()
        .rfind(|event| event.kind == "user_message")
        .expect("safe user message");
    assert_eq!(user_message.payload["text"], "$review focus on tests");
    assert!(!user_message.payload.to_string().contains(path));
}

#[test]
fn opencode_catalog_reopens_and_removes_undifferentiated_commands_without_capabilities() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = AgentStore::open(&database).expect("agent store");
    let conversation = store
        .create_conversation("project", AgentId::OpenCode, None)
        .expect("OpenCode conversation");
    let advertised = json!({
        "availableCommands":[{
            "name":"review",
            "description":"Load the review skill",
            "_meta":{"source":"skill"}
        }],
        "_meta":{"openCodeCapabilities":{"version":1, "supported":true}}
    });
    store
        .append_runtime_update(&conversation.id, "available_commands", &advertised, None)
        .expect("OpenCode command update");
    let before = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("OpenCode catalog");
    assert_eq!(before.revision, 1);
    assert_eq!(before.items.len(), 1);
    assert_eq!(before.items[0].kind, ComposerItemKind::Command);
    drop(store);

    let reopened = AgentStore::open(&database).expect("reopened store");
    assert_eq!(
        reopened
            .composer_catalog_snapshot(&conversation.id)
            .expect("reopened OpenCode catalog"),
        before
    );
    reopened
        .append_runtime_update(
            &conversation.id,
            "available_commands",
            &json!({
                "availableCommands":[],
                "_meta":{"openCodeCapabilities":{"version":2, "supported":false}}
            }),
            None,
        )
        .expect("OpenCode capability removal");
    let removed = reopened
        .composer_catalog_snapshot(&conversation.id)
        .expect("replacement catalog");
    assert_eq!(removed.revision, 2);
    assert!(removed.items.is_empty());
    assert!(
        reopened
            .list_runs(&conversation.id)
            .expect("runs")
            .is_empty()
    );
}

#[test]
fn set_run_status_cannot_resurrect_a_terminal_run() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = AgentStore::open(&database).expect("agent store");
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let run = store
        .start_run(
            &conversation.id,
            "project",
            "Cancel me",
            PermissionMode::Safe,
        )
        .expect("run");
    assert!(
        store
            .finish_run(
                &run.id,
                RunStatus::Cancelled,
                None,
                TerminalCause::Cancelled
            )
            .expect("cancel run")
    );

    // A permission resolution racing the cancel must not flip the run back
    // to a non-terminal status: the late update is a no-op, not an error.
    store
        .set_run_status(&run.id, RunStatus::Running)
        .expect("late status update");
    assert_eq!(
        store.get_run(&run.id).expect("reloaded run").status,
        RunStatus::Cancelled
    );

    // The terminal transition stays exactly-once.
    assert!(
        !store
            .finish_run(&run.id, RunStatus::Completed, None, TerminalCause::EndTurn)
            .expect("second finish")
    );
    assert_eq!(
        store.get_run(&run.id).expect("reloaded run").status,
        RunStatus::Cancelled
    );
}

#[test]
fn finish_run_records_the_typed_cause_on_the_row_and_both_event_streams() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = AgentStore::open(&database).expect("agent store");
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let cases = [
        (RunStatus::Completed, TerminalCause::EndTurn, None),
        (RunStatus::Cancelled, TerminalCause::Cancelled, None),
        (RunStatus::Failed, TerminalCause::Error, Some("boom")),
        (RunStatus::Completed, TerminalCause::MaxTokens, None),
        (RunStatus::Completed, TerminalCause::MaxTurnRequests, None),
        (RunStatus::Completed, TerminalCause::Refusal, None),
        (RunStatus::Interrupted, TerminalCause::Interrupted, None),
    ];
    for (status, cause, error) in cases {
        let run = store
            .start_run(
                &conversation.id,
                "project",
                "Typed cause",
                PermissionMode::Safe,
            )
            .expect("run");
        assert!(
            store
                .finish_run(&run.id, status, error, cause)
                .expect("finish run")
        );
        let stored = store.get_run(&run.id).expect("reloaded run");
        assert_eq!(stored.status, status, "{cause:?}");
        assert_eq!(stored.terminal_cause, Some(cause), "{cause:?}");

        let run_event = store
            .events_after(&run.id, 0)
            .expect("run events")
            .into_iter()
            .find(|event| event.kind == AgentEventKind::RunCompleted)
            .expect("run completion event");
        assert_eq!(run_event.payload["cause"], cause.as_str(), "{cause:?}");
        assert_eq!(run_event.payload["status"], status.as_str(), "{cause:?}");

        let workspace_event = store
            .workspace_events_after(0)
            .expect("workspace events")
            .into_iter()
            .find(|event| {
                event.kind == "run_completed" && event.run_id.as_deref() == Some(run.id.as_str())
            })
            .expect("workspace completion event");
        assert_eq!(
            workspace_event.payload["cause"],
            cause.as_str(),
            "{cause:?}"
        );
    }
}

#[test]
fn reopening_the_store_interrupts_inflight_runs_with_a_typed_cause() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = AgentStore::open(&database).expect("agent store");
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let run = store
        .start_run(
            &conversation.id,
            "project",
            "Interrupted by restart",
            PermissionMode::Safe,
        )
        .expect("run");
    drop(store);

    let reopened = AgentStore::open(&database).expect("reopened store");
    let stored = reopened.get_run(&run.id).expect("reloaded run");
    assert_eq!(stored.status, RunStatus::Interrupted);
    assert_eq!(stored.terminal_cause, Some(TerminalCause::Interrupted));
    let workspace_event = reopened
        .workspace_events_after(0)
        .expect("workspace events")
        .into_iter()
        .find(|event| {
            event.kind == "run_completed" && event.run_id.as_deref() == Some(run.id.as_str())
        })
        .expect("interrupted completion event");
    assert_eq!(workspace_event.payload["cause"], "interrupted");
    assert_eq!(workspace_event.payload["status"], "interrupted");
}

#[test]
fn composer_catalog_revision_high_water_survives_rewind_and_reopen() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = AgentStore::open(&database).expect("agent store");
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let first_raw = json!({"availableCommands":[{
        "name":"first", "description":"First"
    }]});
    store
        .append_runtime_update(&conversation.id, "available_commands", &first_raw, None)
        .expect("first catalog");
    let first_run = store
        .start_run(
            &conversation.id,
            "project",
            "First question",
            PermissionMode::Safe,
        )
        .expect("first run");
    store
        .finish_run(
            &first_run.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish first run");
    let second_raw = json!({"availableCommands":[{
        "name":"second", "description":"Second"
    }]});
    store
        .append_runtime_update(&conversation.id, "available_commands", &second_raw, None)
        .expect("second catalog");
    let second = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("second snapshot");
    assert_eq!(second.revision, 2);
    let old_item_id = second.items[0].id.clone();

    store
        .revise_conversation_at_run(&conversation.id, &first_run.id)
        .expect("rewind conversation");
    assert_eq!(
        store
            .composer_catalog_snapshot(&conversation.id)
            .expect("rewound snapshot")
            .revision,
        1
    );
    drop(store);

    let reopened = AgentStore::open(&database).expect("reopened store");
    let third_raw = json!({"availableCommands":[{
        "name":"third", "description":"Third"
    }]});
    reopened
        .append_runtime_update(&conversation.id, "available_commands", &third_raw, None)
        .expect("third catalog");
    let third = reopened
        .composer_catalog_snapshot(&conversation.id)
        .expect("third snapshot");
    assert_eq!(third.revision, 3, "revision 2 must never be reused");

    let run_count = reopened
        .list_runs(&conversation.id)
        .expect("runs before stale request")
        .len();
    let session_event_count = reopened
        .session_events_after(&conversation.id, 0)
        .expect("session events before stale request")
        .len();
    let workspace_cursor = reopened
        .latest_workspace_event_id()
        .expect("workspace cursor before stale request");
    let error = reopened
        .start_typed_composer_command(
            &conversation.id,
            "project",
            &old_item_id,
            second.revision,
            "",
            PermissionMode::Safe,
        )
        .expect_err("old revision must remain stale");
    assert!(matches!(
        error,
        StoreError::Composer(
            kubecode_server::composer_catalog::ComposerCatalogError::StaleRevision
        )
    ));
    assert_eq!(
        reopened.list_runs(&conversation.id).expect("runs").len(),
        run_count
    );
    assert_eq!(
        reopened
            .session_events_after(&conversation.id, 0)
            .expect("session events")
            .len(),
        session_event_count
    );
    assert_eq!(
        reopened
            .latest_workspace_event_id()
            .expect("workspace cursor"),
        workspace_cursor
    );
}

#[test]
fn rewind_reconciles_lifetime_contexts_with_a_new_non_reused_catalog() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = AgentStore::open(&database).expect("agent store");
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let target = store
        .start_run(
            &conversation.id,
            "project",
            "Retained question",
            PermissionMode::Safe,
        )
        .expect("target run");
    store
        .finish_run(
            &target.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish target");
    let first = store
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::File,
            "src/main.rs",
        )
        .expect("register after target");
    let selector = ComposerContextSelector {
        id: first.context.id.clone(),
        catalog_revision: first.catalog.revision,
        context_kind: ComposerContextKind::File,
    };
    let unavailable = store
        .validate_composer_contexts(
            &conversation.id,
            "project",
            std::slice::from_ref(&selector),
            &[None],
        )
        .expect("change availability after target");
    let selected = store
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::File,
            "src/main.rs",
        )
        .expect("reselect after target");
    assert_eq!(selected.context.id, first.context.id);
    assert!(selected.catalog.revision > unavailable.catalog.revision);
    let removed_revision = selected.catalog.revision;

    store
        .revise_conversation_at_run(&conversation.id, &target.id)
        .expect("rewind");
    let reconciled = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("reconciled catalog");
    assert!(reconciled.revision > removed_revision);
    assert!(reconciled.contexts.iter().any(|context| {
        context.id == first.context.id
            && context.kind == ComposerContextKind::File
            && context.enabled
    }));
    drop(store);

    let reopened = AgentStore::open(&database).expect("reopen store");
    let reopened_catalog = reopened
        .composer_catalog_snapshot(&conversation.id)
        .expect("reopened catalog");
    assert_eq!(reopened_catalog, reconciled);
    let old_error = reopened
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            reconciled.revision,
            &[ComposerDraftSegment::ContextRef {
                id: first.context.id.clone(),
                catalog_revision: removed_revision,
                context_kind: ComposerContextKind::File,
            }],
            &[ComposerPreflightContext {
                id: first.context.id.clone(),
                kind: ComposerContextKind::File,
                path: "src/main.rs".into(),
                content: None,
            }],
            PermissionMode::Safe,
        )
        .expect_err("removed historical selector must be stale");
    assert!(matches!(
        old_error,
        StoreError::Composer(kubecode_server::composer_catalog::ComposerCatalogError::ContextStale)
    ));
    let reselected = reopened
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::File,
            "src/main.rs",
        )
        .expect("reselect same identity after reopen");
    assert_eq!(reselected.context.id, first.context.id);
    let run = reopened
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            reselected.catalog.revision,
            &[ComposerDraftSegment::ContextRef {
                id: reselected.context.id.clone(),
                catalog_revision: reselected.catalog.revision,
                context_kind: ComposerContextKind::File,
            }],
            &[ComposerPreflightContext {
                id: reselected.context.id,
                kind: ComposerContextKind::File,
                path: "src/main.rs".into(),
                content: None,
            }],
            PermissionMode::Safe,
        )
        .expect("current selector must not hit an inconsistent-catalog 500");
    assert_eq!(run.message, "@src/main.rs");
}

#[test]
fn composer_context_registration_is_session_local_and_preserves_catalog_items() {
    let (_temp, store) = store();
    let first = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("first");
    let second = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("second");
    store
        .append_runtime_update(
            &first.id,
            "available_commands",
            &json!({"availableCommands":[{"name":"review","description":"Review"}]}),
            None,
        )
        .expect("commands");

    let first_registration = store
        .register_composer_context(
            &first.id,
            "project",
            ComposerContextKind::File,
            "src/main.rs",
        )
        .expect("register");
    let repeated = store
        .register_composer_context(
            &first.id,
            "project",
            ComposerContextKind::File,
            "src/main.rs",
        )
        .expect("idempotent register");
    let second_registration = store
        .register_composer_context(
            &second.id,
            "project",
            ComposerContextKind::File,
            "src/main.rs",
        )
        .expect("second register");

    assert_eq!(first_registration.context.id, repeated.context.id);
    assert_eq!(
        first_registration.catalog.revision,
        repeated.catalog.revision
    );
    assert_ne!(
        first_registration.context.id,
        second_registration.context.id
    );
    assert_eq!(first_registration.catalog.items.len(), 1);
    assert_eq!(
        first_registration.catalog.contexts,
        vec![first_registration.context]
    );
}

#[test]
fn structured_composer_run_uses_exact_historical_contexts_in_order() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let first = store
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::File,
            "src/first.rs",
        )
        .expect("first");
    let second = store
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::Directory,
            "src/components",
        )
        .expect("second");
    let segments = vec![
        ComposerDraftSegment::Text {
            text: "Review ".into(),
        },
        ComposerDraftSegment::ContextRef {
            id: first.context.id.clone(),
            catalog_revision: first.catalog.revision,
            context_kind: ComposerContextKind::File,
        },
        ComposerDraftSegment::Text {
            text: " then ".into(),
        },
        ComposerDraftSegment::ContextRef {
            id: second.context.id.clone(),
            catalog_revision: second.catalog.revision,
            context_kind: ComposerContextKind::Directory,
        },
    ];
    let preflight = vec![
        ComposerPreflightContext {
            id: first.context.id,
            kind: ComposerContextKind::File,
            path: "src/first.rs".into(),
            content: None,
        },
        ComposerPreflightContext {
            id: second.context.id,
            kind: ComposerContextKind::Directory,
            path: "src/components".into(),
            content: None,
        },
    ];

    let run = store
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            second.catalog.revision,
            &segments,
            &preflight,
            PermissionMode::Safe,
        )
        .expect("structured run");

    assert_eq!(run.message, "Review @src/first.rs then @src/components");
    assert!(!run.internal);
}

#[test]
fn structured_terminal_context_dispatches_only_the_explicit_sanitized_capture() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let selector = "private-terminal-id:selection";
    let source_revision = "a".repeat(64);
    let registration = store
        .register_composer_terminal_context(
            &conversation.id,
            "project",
            selector,
            &source_revision,
            ComposerContextSummary::Terminal {
                capture: TerminalContextCaptureKind::Selection,
                pane_index: 1,
                line_count: 2,
                byte_count: 25,
                truncated: false,
            },
        )
        .expect("terminal context");
    assert!(
        !serde_json::to_string(&registration.context)
            .expect("safe context")
            .contains(selector)
    );

    let run = store
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &[ComposerDraftSegment::ContextRef {
                id: registration.context.id.clone(),
                catalog_revision: registration.catalog.revision,
                context_kind: ComposerContextKind::Terminal,
            }],
            &[ComposerPreflightContext {
                id: registration.context.id,
                kind: ComposerContextKind::Terminal,
                path: selector.into(),
                content: Some("explicit-output\nsecond-line".into()),
            }],
            PermissionMode::Safe,
        )
        .expect("terminal dispatch");

    assert!(run.message.contains("explicit-output\n    second-line"));
    assert!(!run.message.contains(selector));
    assert!(!run.message.contains("unselected-output"));
}

#[test]
fn session_turn_context_is_bounded_branch_local_and_revision_aware() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let foreign = store
        .create_conversation("other-project", AgentId::Codex, None)
        .expect("foreign conversation");
    let first = store
        .start_run(
            &conversation.id,
            "project",
            "First visible question",
            PermissionMode::Safe,
        )
        .expect("first run");
    store
        .append_runtime_update(
            &conversation.id,
            "text_delta",
            &json!({"run_id":first.id, "text":"First visible answer"}),
            Some((
                &first.id,
                AgentEventKind::TextDelta,
                &json!({"text":"First visible answer"}),
            )),
        )
        .expect("first answer");
    assert!(matches!(
        store.resolve_composer_session_turn(
            &conversation.id,
            &first.id,
            ComposerSessionTurnRole::Agent,
        ),
        Err(StoreError::Composer(ComposerCatalogError::ContextStale))
    ));
    store
        .finish_run(
            &first.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish first");

    let user = store
        .resolve_composer_session_turn(&conversation.id, &first.id, ComposerSessionTurnRole::User)
        .expect("user turn");
    assert_eq!(user.content, "First visible question");
    let agent = store
        .resolve_composer_session_turn(&conversation.id, &first.id, ComposerSessionTurnRole::Agent)
        .expect("agent turn");
    assert_eq!(agent.content, "First visible answer");
    assert!(matches!(
        store
            .resolve_composer_session_turn(&foreign.id, &first.id, ComposerSessionTurnRole::Agent,),
        Err(StoreError::Composer(ComposerCatalogError::ContextStale))
    ));

    let second = store
        .start_run(
            &conversation.id,
            "project",
            "Second visible question",
            PermissionMode::Safe,
        )
        .expect("second run");
    store
        .append_runtime_update(
            &conversation.id,
            "text_delta",
            &json!({"run_id":second.id, "text":"Second visible answer"}),
            Some((
                &second.id,
                AgentEventKind::TextDelta,
                &json!({"text":"Second visible answer"}),
            )),
        )
        .expect("second answer");
    store
        .finish_run(
            &second.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish second");
    let branch = store
        .branch_conversation_at_run(&conversation.id, &second.id)
        .expect("explicit branch");
    assert_eq!(
        store
            .resolve_composer_session_turn(&branch.id, &first.id, ComposerSessionTurnRole::Agent,)
            .expect("branch-retained turn")
            .content,
        "First visible answer"
    );

    let revision = store
        .revise_conversation_at_run(&conversation.id, &second.id)
        .expect("hidden revision");
    assert!(matches!(
        store.resolve_composer_session_turn(
            &revision.snapshot_conversation_id,
            &first.id,
            ComposerSessionTurnRole::Agent,
        ),
        Err(StoreError::Composer(ComposerCatalogError::ContextStale))
    ));
    assert!(matches!(
        store.resolve_composer_session_turn(
            &conversation.id,
            &second.id,
            ComposerSessionTurnRole::Agent,
        ),
        Err(StoreError::Composer(ComposerCatalogError::ContextStale))
    ));

    let oversized = store
        .start_run(
            &conversation.id,
            "project",
            &"x".repeat(MAX_SESSION_TURN_CONTEXT_BYTES + 1),
            PermissionMode::Safe,
        )
        .expect("oversized run");
    store
        .finish_run(
            &oversized.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish oversized");
    assert!(matches!(
        store.resolve_composer_session_turn(
            &conversation.id,
            &oversized.id,
            ComposerSessionTurnRole::User,
        ),
        Err(StoreError::Composer(ComposerCatalogError::ContextOverLimit))
    ));
}

#[test]
fn structured_session_turn_dispatches_only_the_resolved_role_content() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let source = store
        .start_run(
            &conversation.id,
            "project",
            "Private user question",
            PermissionMode::Safe,
        )
        .expect("source run");
    store
        .append_runtime_update(
            &conversation.id,
            "text_delta",
            &json!({"run_id":source.id, "text":"Private Agent answer"}),
            Some((
                &source.id,
                AgentEventKind::TextDelta,
                &json!({"text":"Private Agent answer"}),
            )),
        )
        .expect("source answer");
    store
        .finish_run(
            &source.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish source");
    let snapshot = store
        .resolve_composer_session_turn(&conversation.id, &source.id, ComposerSessionTurnRole::Agent)
        .expect("resolved source");
    let selector = session_turn_selector(ComposerSessionTurnRole::Agent, &source.id);
    assert!(matches!(
        store.register_composer_session_turn_context(
            &conversation.id,
            "project",
            &selector,
            &snapshot.source_revision,
            ComposerContextSummary::SessionTurn {
                role: ComposerSessionTurnRole::User,
                line_count: snapshot.line_count,
                byte_count: snapshot.byte_count,
            },
        ),
        Err(StoreError::Composer(ComposerCatalogError::InvalidDraft))
    ));
    let registration = store
        .register_composer_session_turn_context(
            &conversation.id,
            "project",
            &selector,
            &snapshot.source_revision,
            ComposerContextSummary::SessionTurn {
                role: ComposerSessionTurnRole::Agent,
                line_count: snapshot.line_count,
                byte_count: snapshot.byte_count,
            },
        )
        .expect("session turn context");
    assert!(
        !serde_json::to_string(&registration.context)
            .expect("safe context")
            .contains(&source.id)
    );

    let run = store
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &[ComposerDraftSegment::ContextRef {
                id: registration.context.id.clone(),
                catalog_revision: registration.catalog.revision,
                context_kind: ComposerContextKind::SessionTurn,
            }],
            &[ComposerPreflightContext {
                id: registration.context.id,
                kind: ComposerContextKind::SessionTurn,
                path: selector.clone(),
                content: Some(snapshot.content),
            }],
            PermissionMode::Safe,
        )
        .expect("session turn dispatch");

    assert!(
        run.message
            .contains("Prior Agent response explicitly referenced")
    );
    assert!(run.message.contains("Private Agent answer"));
    assert!(!run.message.contains("Private user question"));
    assert!(!run.message.contains(&selector));
}

#[test]
fn native_session_turn_context_uses_the_visible_delta_anchor() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::OpenCode, None)
        .expect("conversation");
    let anchor = store
        .append_session_event(
            &conversation.id,
            "user_message_delta",
            &json!({"text":"Native private "}),
        )
        .expect("first user chunk");
    store
        .append_session_event(
            &conversation.id,
            "user_message_delta",
            &json!({"text":"question"}),
        )
        .expect("second user chunk");
    store
        .append_session_event(
            &conversation.id,
            "text_delta",
            &json!({"text":"Native private answer"}),
        )
        .expect("answer");
    store
        .append_session_event(
            &conversation.id,
            "user_message",
            &json!({"text":"Next question"}),
        )
        .expect("next turn");
    let selector = format!("native-{}", anchor.seq);

    assert_eq!(
        store
            .resolve_composer_session_turn(
                &conversation.id,
                &selector,
                ComposerSessionTurnRole::User,
            )
            .expect("native user turn")
            .content,
        "Native private question"
    );
    assert_eq!(
        store
            .resolve_composer_session_turn(
                &conversation.id,
                &selector,
                ComposerSessionTurnRole::Agent,
            )
            .expect("native Agent turn")
            .content,
        "Native private answer"
    );
    assert!(matches!(
        store.resolve_composer_session_turn(
            &conversation.id,
            &format!("native-{}", anchor.seq + 1),
            ComposerSessionTurnRole::User,
        ),
        Err(StoreError::Composer(ComposerCatalogError::ContextStale))
    ));
}

#[test]
fn unsupported_capability_reference_creates_no_run() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    store
        .append_runtime_update(
            &conversation.id,
            "available_commands",
            &json!({"availableCommands":[{"name":"review","description":"Review"}]}),
            None,
        )
        .expect("catalog");
    let catalog = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("catalog");
    let error = store
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            catalog.revision,
            &[ComposerDraftSegment::CapabilityRef {
                id: catalog.items[0].id.clone(),
                catalog_revision: catalog.revision,
                item_kind: ComposerItemKind::Command,
            }],
            &[],
            PermissionMode::Safe,
        )
        .expect_err("unsupported capability");

    assert!(matches!(
        error,
        StoreError::Composer(
            kubecode_server::composer_catalog::ComposerCatalogError::ItemUnsupported
        )
    ));
    assert!(store.list_runs(&conversation.id).expect("runs").is_empty());
}

#[test]
fn context_validation_batches_availability_into_one_catalog_revision() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let first = store
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::File,
            "src/first.rs",
        )
        .expect("first");
    let second = store
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::Directory,
            "src/components",
        )
        .expect("second");
    let session_events_before = store
        .session_events_after(&conversation.id, 0)
        .expect("session events")
        .len();
    let workspace_events_before = store
        .workspace_events_after(0)
        .expect("workspace events")
        .len();
    let selectors = vec![
        ComposerContextSelector {
            id: first.context.id,
            catalog_revision: first.catalog.revision,
            context_kind: ComposerContextKind::File,
        },
        ComposerContextSelector {
            id: second.context.id,
            catalog_revision: second.catalog.revision,
            context_kind: ComposerContextKind::Directory,
        },
    ];

    let response = store
        .validate_composer_contexts(&conversation.id, "project", &selectors, &[None, None])
        .expect("batch validation");

    assert!(
        response
            .references
            .iter()
            .all(|reference| !reference.available)
    );
    assert_eq!(response.catalog.revision, second.catalog.revision + 1);
    assert!(
        response
            .catalog
            .contexts
            .iter()
            .all(|context| !context.enabled)
    );
    assert_eq!(
        store
            .session_events_after(&conversation.id, 0)
            .expect("session events")
            .len(),
        session_events_before + 1
    );
    assert_eq!(
        store
            .workspace_events_after(0)
            .expect("workspace events")
            .len(),
        workspace_events_before + 1
    );
}

#[test]
fn structured_run_rechecks_catalog_after_preflight_and_rejects_a_committed_race() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let registration = store
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::File,
            "src/main.rs",
        )
        .expect("registration");
    let selector = ComposerContextSelector {
        id: registration.context.id.clone(),
        catalog_revision: registration.catalog.revision,
        context_kind: ComposerContextKind::File,
    };
    let records = store
        .composer_context_records_for_preflight(
            &conversation.id,
            "project",
            std::slice::from_ref(&selector),
        )
        .expect("filesystem preflight records");
    let record = records[0].as_ref().expect("registered context");
    let preflight = [ComposerPreflightContext {
        id: record.id.clone(),
        kind: record.kind,
        path: record.path.clone(),
        content: None,
    }];
    store
        .append_runtime_update(
            &conversation.id,
            "available_commands",
            &json!({"availableCommands":[{"name":"review","description":"Review"}]}),
            None,
        )
        .expect("catalog race");
    let event_count = store
        .session_events_after(&conversation.id, 0)
        .expect("session events")
        .len();
    let workspace_cursor = store.latest_workspace_event_id().expect("workspace cursor");

    let error = store
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &[ComposerDraftSegment::ContextRef {
                id: selector.id,
                catalog_revision: selector.catalog_revision,
                context_kind: selector.context_kind,
            }],
            &preflight,
            PermissionMode::Safe,
        )
        .expect_err("stale catalog race");

    assert!(matches!(
        error,
        StoreError::Composer(
            kubecode_server::composer_catalog::ComposerCatalogError::StaleRevision
        )
    ));
    assert!(store.list_runs(&conversation.id).expect("runs").is_empty());
    assert_eq!(
        store
            .session_events_after(&conversation.id, 0)
            .expect("session events")
            .len(),
        event_count
    );
    assert_eq!(
        store.latest_workspace_event_id().expect("workspace cursor"),
        workspace_cursor
    );
}

#[test]
fn structured_run_enforces_segment_reference_and_text_bounds() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let registration = store
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::File,
            "src/main.rs",
        )
        .expect("registration");
    let preflight = [ComposerPreflightContext {
        id: registration.context.id.clone(),
        kind: ComposerContextKind::File,
        path: "src/main.rs".into(),
        content: None,
    }];
    let too_many_segments = (0..=MAX_COMPOSER_SEGMENTS)
        .map(|_| ComposerDraftSegment::Text { text: "x".into() })
        .collect::<Vec<_>>();
    let too_many_references = (0..=MAX_COMPOSER_REFERENCES)
        .map(|_| ComposerDraftSegment::ContextRef {
            id: registration.context.id.clone(),
            catalog_revision: registration.catalog.revision,
            context_kind: ComposerContextKind::File,
        })
        .collect::<Vec<_>>();

    let exact_segments = (0..MAX_COMPOSER_SEGMENTS)
        .map(|_| ComposerDraftSegment::Text { text: "x".into() })
        .collect::<Vec<_>>();
    let exact_segment_run = store
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &exact_segments,
            &[],
            PermissionMode::Safe,
        )
        .expect("exact segment limit");
    store
        .finish_run(
            &exact_segment_run.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish exact segments");
    let exact_references = (0..MAX_COMPOSER_REFERENCES)
        .map(|_| ComposerDraftSegment::ContextRef {
            id: registration.context.id.clone(),
            catalog_revision: registration.catalog.revision,
            context_kind: ComposerContextKind::File,
        })
        .collect::<Vec<_>>();
    let exact_reference_run = store
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &exact_references,
            &preflight,
            PermissionMode::Safe,
        )
        .expect("exact reference limit");
    store
        .finish_run(
            &exact_reference_run.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish exact references");
    let exact_text_run = store
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &[ComposerDraftSegment::Text {
                text: "x".repeat(MAX_COMPOSER_TEXT_BYTES),
            }],
            &[],
            PermissionMode::Safe,
        )
        .expect("exact aggregate text limit");
    store
        .finish_run(
            &exact_text_run.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish exact text");

    let rendered_reference_bytes = 1 + "src/main.rs".len();
    let exact_rendered_segments = [
        ComposerDraftSegment::Text {
            text: "x".repeat(MAX_COMPOSER_TEXT_BYTES - rendered_reference_bytes),
        },
        ComposerDraftSegment::ContextRef {
            id: registration.context.id.clone(),
            catalog_revision: registration.catalog.revision,
            context_kind: ComposerContextKind::File,
        },
    ];
    let exact_rendered_run = store
        .start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &exact_rendered_segments,
            &preflight,
            PermissionMode::Safe,
        )
        .expect("exact rendered text limit");
    assert_eq!(exact_rendered_run.message.len(), MAX_COMPOSER_TEXT_BYTES);
    store
        .finish_run(
            &exact_rendered_run.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
        .expect("finish exact rendered text");
    let rendered_over = [
        ComposerDraftSegment::Text {
            text: "x".repeat(MAX_COMPOSER_TEXT_BYTES - rendered_reference_bytes + 1),
        },
        ComposerDraftSegment::ContextRef {
            id: registration.context.id.clone(),
            catalog_revision: registration.catalog.revision,
            context_kind: ComposerContextKind::File,
        },
    ];

    let errors = [
        store.start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &too_many_segments,
            &[],
            PermissionMode::Safe,
        ),
        store.start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &rendered_over,
            &preflight,
            PermissionMode::Safe,
        ),
        store.start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &too_many_references,
            &preflight,
            PermissionMode::Safe,
        ),
        store.start_structured_composer_run(
            &conversation.id,
            "project",
            None,
            registration.catalog.revision,
            &[ComposerDraftSegment::Text {
                text: "x".repeat(MAX_COMPOSER_TEXT_BYTES + 1),
            }],
            &[],
            PermissionMode::Safe,
        ),
    ];

    assert!(matches!(
        errors[0],
        Err(StoreError::Composer(
            kubecode_server::composer_catalog::ComposerCatalogError::SegmentsOverLimit
        ))
    ));
    assert!(matches!(
        errors[1],
        Err(StoreError::Composer(
            kubecode_server::composer_catalog::ComposerCatalogError::TextTooLong
        ))
    ));
    assert!(matches!(
        errors[2],
        Err(StoreError::Composer(
            kubecode_server::composer_catalog::ComposerCatalogError::ContextOverLimit
        ))
    ));
    assert!(matches!(
        errors[3],
        Err(StoreError::Composer(
            kubecode_server::composer_catalog::ComposerCatalogError::TextTooLong
        ))
    ));
    assert_eq!(
        store
            .list_runs(&conversation.id)
            .expect("runs")
            .iter()
            .filter(|run| run.status == RunStatus::Running)
            .count(),
        0
    );
}

#[test]
fn composer_context_registry_is_full_without_evicting_existing_identities() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let mut ids = Vec::with_capacity(MAX_COMPOSER_CONTEXTS);
    for index in 0..MAX_COMPOSER_CONTEXTS {
        let registration = store
            .register_composer_context(
                &conversation.id,
                "project",
                ComposerContextKind::File,
                &format!("src/context-{index}.rs"),
            )
            .expect("register within context limit");
        ids.push(registration.context.id);
    }
    let before = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("full catalog");
    assert_eq!(before.contexts.len(), MAX_COMPOSER_CONTEXTS);
    let error = store
        .register_composer_context(
            &conversation.id,
            "project",
            ComposerContextKind::File,
            "src/context-over.rs",
        )
        .expect_err("257th context rejected");
    assert!(matches!(
        error,
        StoreError::Composer(
            kubecode_server::composer_catalog::ComposerCatalogError::ContextOverLimit
        )
    ));
    let after = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("unchanged full catalog");
    assert_eq!(after, before);
    assert!(
        ids.iter()
            .all(|id| after.contexts.iter().any(|context| &context.id == id))
    );
}

#[test]
fn composer_context_validation_accepts_32_unique_rows_and_rejects_33_atomically() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let mut selectors = Vec::with_capacity(MAX_COMPOSER_VALIDATION_ROWS + 1);
    for index in 0..=MAX_COMPOSER_VALIDATION_ROWS {
        let registration = store
            .register_composer_context(
                &conversation.id,
                "project",
                ComposerContextKind::File,
                &format!("src/validation-{index}.rs"),
            )
            .expect("register validation context");
        selectors.push(ComposerContextSelector {
            id: registration.context.id,
            catalog_revision: registration.catalog.revision,
            context_kind: ComposerContextKind::File,
        });
    }
    let exact = store
        .validate_composer_contexts(
            &conversation.id,
            "project",
            &selectors[..MAX_COMPOSER_VALIDATION_ROWS],
            &vec![None; MAX_COMPOSER_VALIDATION_ROWS],
        )
        .expect("32 unique validation rows");
    assert_eq!(exact.references.len(), MAX_COMPOSER_VALIDATION_ROWS);
    let before = store
        .composer_catalog_snapshot(&conversation.id)
        .expect("catalog before over-limit validation");
    let session_events = store
        .session_events_after(&conversation.id, 0)
        .expect("session events before over-limit validation")
        .len();
    let workspace_cursor = store.latest_workspace_event_id().expect("workspace cursor");
    let error = store
        .validate_composer_contexts(
            &conversation.id,
            "project",
            &selectors,
            &vec![None; MAX_COMPOSER_VALIDATION_ROWS + 1],
        )
        .expect_err("33 unique validation rows rejected");
    assert!(matches!(
        error,
        StoreError::Composer(
            kubecode_server::composer_catalog::ComposerCatalogError::ContextOverLimit
        )
    ));
    assert_eq!(
        store
            .composer_catalog_snapshot(&conversation.id)
            .expect("catalog after rejected validation"),
        before
    );
    assert_eq!(
        store
            .session_events_after(&conversation.id, 0)
            .expect("session events after rejected validation")
            .len(),
        session_events
    );
    assert_eq!(
        store
            .latest_workspace_event_id()
            .expect("workspace cursor after rejection"),
        workspace_cursor
    );
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
        .finish_run(
            &first.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
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
        .finish_run(
            &second.id,
            RunStatus::Interrupted,
            None,
            TerminalCause::Interrupted,
        )
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
        .finish_run(
            &first.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
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
        .finish_run(
            &second.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
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
            .finish_run(&run.id, RunStatus::Completed, None, TerminalCause::EndTurn)
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
        .finish_run(
            &first.id,
            RunStatus::Completed,
            None,
            TerminalCause::EndTurn,
        )
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
fn runtime_update_batches_roll_back_every_projection_when_one_update_fails() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let run = store
        .start_run(
            &conversation.id,
            "project",
            "Batch it",
            PermissionMode::Safe,
        )
        .expect("run");
    let session_cursor = store
        .session_events_after(&conversation.id, 0)
        .expect("session events")
        .last()
        .expect("initial user event")
        .seq;
    let run_cursor = store
        .events_after(&run.id, 0)
        .expect("run events")
        .last()
        .expect("initial run event")
        .seq;
    let workspace_cursor = store.latest_workspace_event_id().expect("workspace cursor");
    let bus = store.workspace_event_bus();
    let receiver = bus.subscribe();

    let error = store
        .append_runtime_updates(
            &conversation.id,
            &[
                RuntimeUpdate {
                    session_kind: "text_delta".into(),
                    session_payload: serde_json::json!({"run_id":run.id, "text":"kept"}),
                    run_event: Some(RuntimeRunEvent {
                        run_id: run.id.clone(),
                        kind: AgentEventKind::TextDelta,
                        payload: serde_json::json!({"text":"kept"}),
                    }),
                    publish_session_state: false,
                },
                RuntimeUpdate {
                    session_kind: "thinking_delta".into(),
                    session_payload: serde_json::json!({"run_id":"missing-run", "text":"rolled back"}),
                    run_event: Some(RuntimeRunEvent {
                        run_id: "missing-run".into(),
                        kind: AgentEventKind::ThinkingDelta,
                        payload: serde_json::json!({"text":"rolled back"}),
                    }),
                    publish_session_state: false,
                },
            ],
        )
        .expect_err("invalid run must roll back the batch");
    assert!(matches!(error, StoreError::RunNotFound(id) if id == "missing-run"));
    assert!(
        store
            .session_events_after(&conversation.id, session_cursor)
            .expect("session replay")
            .is_empty()
    );
    assert!(
        store
            .events_after(&run.id, run_cursor)
            .expect("run replay")
            .is_empty()
    );
    assert!(
        store
            .workspace_events_after(workspace_cursor)
            .expect("workspace replay")
            .is_empty()
    );
    assert_eq!(bus.latest_committed_cursor(), workspace_cursor);
    assert!(!receiver.has_changed().expect("event bus remains open"));
}

#[test]
fn workspace_event_bus_initializes_from_durable_state_for_late_subscribers() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let durable_cursor = {
        let store = AgentStore::open(&database).expect("first store");
        store
            .append_workspace_event(
                "test_event",
                Some("project"),
                None,
                None,
                &serde_json::json!({"value":1}),
            )
            .expect("workspace event")
            .id
    };

    let reopened = AgentStore::open(&database).expect("reopened store");
    let bus = reopened.workspace_event_bus();
    let receiver = bus.subscribe();

    assert_eq!(bus.latest_committed_cursor(), durable_cursor);
    assert_eq!(*receiver.borrow(), durable_cursor);
    assert_eq!(
        reopened
            .latest_workspace_event_id()
            .expect("durable cursor"),
        durable_cursor
    );
}

#[test]
fn coalesced_workspace_notifications_replay_every_durable_event() {
    let (_temp, store) = store();
    let bus = store.workspace_event_bus();
    let mut receiver = bus.subscribe();
    let previous_cursor = *receiver.borrow();

    for value in 1..=3 {
        store
            .append_workspace_event(
                "test_event",
                Some("project"),
                None,
                None,
                &serde_json::json!({"value":value}),
            )
            .expect("workspace event");
    }

    let latest = *receiver.borrow_and_update();
    let replay = store
        .workspace_events_after(previous_cursor)
        .expect("workspace replay");
    assert_eq!(replay.len(), 3);
    assert_eq!(replay.last().expect("latest event").id, latest);
    assert_eq!(bus.latest_committed_cursor(), latest);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_workspace_publishers_advance_the_visible_cursor_monotonically() {
    let (_temp, store) = store();
    let store = Arc::new(store);
    let bus = store.workspace_event_bus();
    let mut receiver = bus.subscribe();
    let initial_cursor = *receiver.borrow_and_update();
    let publishers = (0..16)
        .map(|value| {
            let store = Arc::clone(&store);
            std::thread::spawn(move || {
                store
                    .append_workspace_event(
                        "test_event",
                        Some("project"),
                        None,
                        None,
                        &serde_json::json!({"value":value}),
                    )
                    .expect("workspace event")
                    .id
            })
        })
        .collect::<Vec<_>>();
    let mut committed = publishers
        .into_iter()
        .map(|publisher| publisher.join().expect("publisher"))
        .collect::<Vec<_>>();
    committed.sort_unstable();
    let expected = *committed.last().expect("committed cursor");

    let mut observed = initial_cursor;
    while observed < expected {
        receiver.changed().await.expect("event bus remains open");
        let next = *receiver.borrow_and_update();
        assert!(next >= observed);
        observed = next;
    }

    assert_eq!(observed, expected);
    assert_eq!(bus.latest_committed_cursor(), expected);
}

#[test]
fn runtime_update_batch_publishes_its_latest_projection_after_commit() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::Codex, None)
        .expect("conversation");
    let run = store
        .start_run(
            &conversation.id,
            "project",
            "Batch it",
            PermissionMode::Safe,
        )
        .expect("run");
    let bus = store.workspace_event_bus();
    let receiver = bus.subscribe();
    let previous_cursor = *receiver.borrow();

    store
        .append_runtime_updates(
            &conversation.id,
            &[
                RuntimeUpdate {
                    session_kind: "text_delta".into(),
                    session_payload: serde_json::json!({"run_id":run.id, "text":"one"}),
                    run_event: Some(RuntimeRunEvent {
                        run_id: run.id.clone(),
                        kind: AgentEventKind::TextDelta,
                        payload: serde_json::json!({"text":"one"}),
                    }),
                    publish_session_state: false,
                },
                RuntimeUpdate {
                    session_kind: "thinking_delta".into(),
                    session_payload: serde_json::json!({"run_id":run.id, "text":"two"}),
                    run_event: Some(RuntimeRunEvent {
                        run_id: run.id.clone(),
                        kind: AgentEventKind::ThinkingDelta,
                        payload: serde_json::json!({"text":"two"}),
                    }),
                    publish_session_state: false,
                },
            ],
        )
        .expect("runtime batch");

    let replay = store
        .workspace_events_after(previous_cursor)
        .expect("workspace replay");
    assert_eq!(replay.len(), 2);
    assert_eq!(
        bus.latest_committed_cursor(),
        replay.last().expect("latest projection").id
    );
    assert!(receiver.has_changed().expect("event bus remains open"));
}

#[test]
fn idle_session_state_updates_publish_one_atomic_conversation_invalidation() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::OpenCode, None)
        .expect("conversation");
    let previous_cursor = store.latest_workspace_event_id().expect("workspace cursor");
    let bus = store.workspace_event_bus();
    let receiver = bus.subscribe();

    store
        .append_runtime_updates(
            &conversation.id,
            &[
                RuntimeUpdate {
                    session_kind: "available_commands".into(),
                    session_payload: serde_json::json!({
                        "availableCommands":[{"name":"review", "description":"Review"}]
                    }),
                    run_event: None,
                    publish_session_state: true,
                },
                RuntimeUpdate {
                    session_kind: "current_mode".into(),
                    session_payload: serde_json::json!({"currentModeId":"build"}),
                    run_event: None,
                    publish_session_state: true,
                },
            ],
        )
        .expect("idle state batch");

    let session_events = store
        .session_events_after(&conversation.id, 0)
        .expect("session replay");
    assert_eq!(session_events.len(), 3);
    assert_eq!(session_events[0].kind, "available_commands");
    assert_eq!(session_events[1].kind, "composer_catalog");
    assert_eq!(session_events[2].kind, "current_mode");
    let workspace_events = store
        .workspace_events_after(previous_cursor)
        .expect("workspace replay");
    assert_eq!(workspace_events.len(), 2);
    assert_eq!(workspace_events[0].kind, "composer_catalog_snapshot");
    assert_eq!(workspace_events[1].kind, "session_state");
    assert_eq!(workspace_events[1].project_id.as_deref(), Some("project"));
    assert_eq!(
        workspace_events[1].conversation_id.as_deref(),
        Some(conversation.id.as_str())
    );
    assert_eq!(workspace_events[1].run_id, None);
    assert_eq!(workspace_events[1].payload, serde_json::json!({}));
    assert_eq!(bus.latest_committed_cursor(), workspace_events[1].id);
    assert!(receiver.has_changed().expect("event bus remains open"));
}

#[test]
fn session_state_checkpoint_is_atomic_private_and_browser_safe() {
    let (_temp, store) = store();
    let conversation = store
        .create_conversation("project", AgentId::OpenCode, None)
        .expect("conversation");
    let previous_cursor = store.latest_workspace_event_id().expect("workspace cursor");
    let bus = store.workspace_event_bus();
    let receiver = bus.subscribe();
    let checkpoint = serde_json::json!({
        "sessionId":"provider-session",
        "modes":{
            "currentModeId":"build",
            "availableModes":[{"id":"build", "name":"Build"}]
        },
        "_meta":{"private":"journal-only"}
    });

    store
        .append_session_state_checkpoint(&conversation.id, "session_created_state", &checkpoint)
        .expect("session state checkpoint");

    let session_event = store
        .session_events_after(&conversation.id, 0)
        .expect("session replay")
        .into_iter()
        .find(|event| event.kind == "session_created_state")
        .expect("private checkpoint");
    assert_eq!(session_event.payload, checkpoint);
    let workspace_events = store
        .workspace_events_after(previous_cursor)
        .expect("workspace replay");
    assert_eq!(workspace_events.len(), 1);
    assert_eq!(workspace_events[0].kind, "session_state");
    assert_eq!(workspace_events[0].project_id.as_deref(), Some("project"));
    assert_eq!(
        workspace_events[0].conversation_id.as_deref(),
        Some(conversation.id.as_str())
    );
    assert_eq!(workspace_events[0].run_id, None);
    assert_eq!(workspace_events[0].payload, serde_json::json!({}));
    assert_eq!(bus.latest_committed_cursor(), workspace_events[0].id);
    assert!(receiver.has_changed().expect("event bus remains open"));

    let committed_cursor = workspace_events[0].id;
    let error = store
        .append_session_state_checkpoint("missing", "session_loaded", &checkpoint)
        .expect_err("missing conversation must roll back");
    assert!(matches!(error, StoreError::ConversationNotFound(id) if id == "missing"));
    assert!(
        store
            .workspace_events_after(committed_cursor)
            .expect("workspace replay")
            .is_empty()
    );
    assert_eq!(bus.latest_committed_cursor(), committed_cursor);
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
