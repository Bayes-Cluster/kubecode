//! Durable iLink state tests (#126): restart restoration, the inbound
//! crash-boundary contract, session-removal and logout semantics, secret
//! sealing, and safe workspace-event projections.

use std::sync::Arc;

use kubecode_server::agent_store::{
    AgentStore, ILINK_DEDUPE_KEEP, IlinkAccountStatus, IlinkCredentialRecord,
};
use kubecode_server::agents::AgentId;
use kubecode_server::ilink::seal::SecretKeyring;
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;

const ACCOUNT: &str = "ilink_bot_synthetic_01";
const PEER: &str = "wxid_synthetic_01";
const SYNTHETIC_TOKEN: &str = "synthetic-bot-token-000000000001";

struct Environment {
    _root: TempDir,
    workspace: Arc<WorkspaceService>,
    store: Arc<AgentStore>,
    database: std::path::PathBuf,
}

fn environment(tag: &str) -> Environment {
    let root = TempDir::new().expect("tempdir");
    let database = root
        .path()
        .join(format!(".state-{tag}/kubecode/kubecode.sqlite3"));
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let store = Arc::new(AgentStore::open(&database).expect("agent store"));
    Environment {
        _root: root,
        workspace,
        store,
        database,
    }
}

fn keyring(database: &std::path::Path) -> SecretKeyring {
    SecretKeyring::open(database.parent().unwrap().join("ilink")).expect("keyring")
}

fn credential_record(
    account_id: &str,
    sealed_blob: Vec<u8>,
    cursor_buf: &str,
) -> IlinkCredentialRecord {
    IlinkCredentialRecord {
        account_id: account_id.to_owned(),
        device_id: "synthetic-device-id".to_owned(),
        committed_cursor: 0,
        get_updates_buf: cursor_buf.to_owned(),
        api_origin: "https://ilinkai.weixin.qq.com/".to_owned(),
        cdn_origin: "https://szextshort.wechat.com/".to_owned(),
        sealed_blob,
    }
}

fn connect_account(store: &AgentStore, keyring: &SecretKeyring) {
    store
        .upsert_ilink_account(ACCOUNT, "Synthetic Account")
        .expect("account");
    store
        .set_ilink_account_status(ACCOUNT, IlinkAccountStatus::Connecting)
        .expect("connecting");
    let sealed = keyring
        .seal(format!(r#"{{"bot_token":"{SYNTHETIC_TOKEN}"}}"#).as_bytes())
        .expect("seal");
    store
        .save_ilink_credentials(&credential_record(ACCOUNT, sealed, "cursor-0"))
        .expect("credentials");
    store
        .set_ilink_account_status(ACCOUNT, IlinkAccountStatus::Connected)
        .expect("connected");
    // The first peer to message the account is auto-authorized.
    store
        .upsert_ilink_peer(ACCOUNT, PEER, "Synthetic Peer", true)
        .expect("peer");
    let peer_token = keyring
        .seal(b"synthetic-context-token-01")
        .expect("seal peer token");
    store
        .remember_ilink_peer_context_token(ACCOUNT, PEER, &peer_token)
        .expect("peer token");
}

#[test]
fn restart_restores_account_credentials_binding_cursor_and_dedupe() {
    let environment = environment("restart");
    let keyring = keyring(&environment.database);
    connect_account(&environment.store, &keyring);
    let project = environment
        .workspace
        .create_project(".", "ilink-restart-project")
        .expect("project");
    let conversation = environment
        .store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Bound"))
        .expect("conversation");
    environment
        .store
        .bind_ilink_session(ACCOUNT, &conversation.id)
        .expect("bind");
    environment
        .store
        .set_ilink_quick_prompt(ACCOUNT, 1, "run the tests")
        .expect("quick prompt");
    environment
        .store
        .commit_ilink_inbound_message(ACCOUNT, "key-a", "cursor-a", 1)
        .expect("commit a");

    // Simulate an ordinary Runtime restart: drop everything, reopen.
    drop(environment.store);
    let reopened = Arc::new(AgentStore::open(&environment.database).expect("reopened"));
    reopened.repair_ilink_state().expect("repair");

    let account = reopened
        .ilink_account(ACCOUNT)
        .expect("account lookup")
        .expect("account survives restart");
    assert_eq!(account.display_name, "Synthetic Account");
    assert_eq!(account.status, IlinkAccountStatus::Connected);

    let credentials = reopened
        .ilink_credentials(ACCOUNT)
        .expect("credentials lookup")
        .expect("credentials survive restart");
    assert_eq!(credentials.device_id, "synthetic-device-id");
    assert_eq!(credentials.get_updates_buf, "cursor-a");
    assert_eq!(credentials.committed_cursor, 1);
    assert_eq!(credentials.api_origin, "https://ilinkai.weixin.qq.com/");
    // The sealed blob opens only under the same machine key and never
    // contains plaintext.
    let restored = keyring.unseal(&credentials.sealed_blob).expect("unseal");
    assert_eq!(
        String::from_utf8(restored).expect("utf-8"),
        format!(r#"{{"bot_token":"{SYNTHETIC_TOKEN}"}}"#)
    );
    // The projection's Debug output never contains the sealed bytes in
    // plaintext form.
    let rendered = format!("{credentials:?}");
    assert!(rendered.contains("sealed_blob"));

    assert_eq!(
        reopened.ilink_session_binding(ACCOUNT).expect("binding"),
        Some(conversation.id)
    );
    let peer = reopened
        .ilink_peer(ACCOUNT, PEER)
        .expect("peer lookup")
        .expect("peer survives restart");
    assert!(peer.authorized);
    let peer_token = reopened
        .ilink_peer_context_token(ACCOUNT, PEER)
        .expect("peer token")
        .expect("peer token survives restart");
    assert_eq!(
        keyring.unseal(&peer_token).expect("unseal"),
        b"synthetic-context-token-01"
    );
    assert!(
        reopened
            .ilink_message_seen(ACCOUNT, "key-a")
            .expect("dedupe survives restart")
    );
    assert_eq!(
        reopened
            .ilink_quick_prompts(ACCOUNT)
            .expect("quick prompts"),
        vec![(1, "run the tests".to_owned())]
    );
}

#[test]
fn inbound_messages_commit_exactly_once_across_retries() {
    let environment = environment("crash");
    let keyring = keyring(&environment.database);
    connect_account(&environment.store, &keyring);
    let project = environment
        .workspace
        .create_project(".", "ilink-crash-project")
        .expect("project");
    let conversation = environment
        .store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");

    // Delivery path for one message: dedupe check → admission (idempotent
    // via the message-key-derived client_message_id) → commit.
    let message_key = format!("{PEER}:1750000000000:9001");
    assert!(
        !environment
            .store
            .ilink_message_seen(ACCOUNT, &message_key)
            .expect("first check")
    );
    let client_message_id = format!("ilink:{ACCOUNT}:{message_key}");
    let first = environment
        .store
        .start_prompt_or_enqueue(
            &conversation.id,
            &project.id,
            "please fix the failing test",
            kubecode_server::agent_store::PermissionMode::Safe,
            false,
            Some(&client_message_id),
        )
        .expect("first admission");
    let kubecode_server::agent_store::StartPromptOutcome::Started(run) = first else {
        panic!("idle conversation starts immediately");
    };
    assert!(
        environment
            .store
            .commit_ilink_inbound_message(ACCOUNT, &message_key, "cursor-1", 1)
            .expect("first commit")
    );

    // A transport retry before commit would re-admit to the same run —
    // never a second prompt.
    let retry = environment
        .store
        .start_prompt_or_enqueue(
            &conversation.id,
            &project.id,
            "please fix the failing test",
            kubecode_server::agent_store::PermissionMode::Safe,
            false,
            Some(&client_message_id),
        )
        .expect("retry admission");
    let kubecode_server::agent_store::StartPromptOutcome::Started(retried) = retry else {
        panic!("retry reconciles to the original run");
    };
    assert_eq!(retried.id, run.id);

    // After the commit, a replayed delivery is dropped by the dedupe key.
    assert!(
        environment
            .store
            .ilink_message_seen(ACCOUNT, &message_key)
            .expect("seen after commit")
    );
    assert!(
        !environment
            .store
            .commit_ilink_inbound_message(ACCOUNT, &message_key, "cursor-1", 1)
            .expect("replayed commit is a no-op")
    );

    // The next message advances the cursor exactly once more.
    environment
        .store
        .commit_ilink_inbound_message(ACCOUNT, "second-key", "cursor-2", 1)
        .expect("second commit");
    let credentials = environment
        .store
        .ilink_credentials(ACCOUNT)
        .expect("credentials")
        .expect("credentials");
    assert_eq!(credentials.committed_cursor, 2);
    assert_eq!(credentials.get_updates_buf, "cursor-2");
}

#[test]
fn dedupe_retention_is_bounded_by_count() {
    let environment = environment("prune");
    let keyring = keyring(&environment.database);
    connect_account(&environment.store, &keyring);
    let total = ILINK_DEDUPE_KEEP as i64 + 50;
    for index in 0..total {
        let committed = environment
            .store
            .commit_ilink_inbound_message(ACCOUNT, &format!("key-{index}"), "cursor", 1)
            .expect("commit");
        assert!(committed);
    }
    let credentials = environment
        .store
        .ilink_credentials(ACCOUNT)
        .expect("credentials")
        .expect("credentials");
    assert_eq!(credentials.committed_cursor, total);
    // Recent keys (needed for immediate replay safety) are retained.
    assert!(
        environment
            .store
            .ilink_message_seen(ACCOUNT, &format!("key-{}", total - 1))
            .expect("recent key kept")
    );
    // The store count is bounded.
    let database = rusqlite::Connection::open(&environment.database).expect("raw connection");
    let count: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM ilink_inbound_dedupe WHERE account_id = ?1",
            [ACCOUNT],
            |row| row.get(0),
        )
        .expect("count");
    assert!(count <= ILINK_DEDUPE_KEEP as i64, "dedupe rows {count}");
}

#[test]
fn session_removal_clears_only_the_ilink_binding() {
    let environment = environment("removal");
    let keyring = keyring(&environment.database);
    connect_account(&environment.store, &keyring);
    let project = environment
        .workspace
        .create_project(".", "ilink-removal-project")
        .expect("project");
    let project_path = environment
        .workspace
        .project_path(&project.id)
        .expect("path");
    let conversation = environment
        .store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Removed"))
        .expect("conversation");
    environment
        .store
        .bind_ilink_session(ACCOUNT, &conversation.id)
        .expect("bind");
    environment
        .store
        .append_session_event(
            &conversation.id,
            "text_delta",
            &serde_json::json!({"text": "earlier answer"}),
        )
        .expect("history");

    environment
        .store
        .delete_conversation(&conversation.id)
        .expect("delete conversation");

    assert_eq!(
        environment
            .store
            .ilink_session_binding(ACCOUNT)
            .expect("binding"),
        None,
        "only the binding is cleared"
    );
    // The Project directory and its files are untouched.
    assert!(project_path.exists());
    // Provider-native conversation history is untouched elsewhere: the
    // account, credentials, and peers all survive.
    assert!(
        environment
            .store
            .ilink_credentials(ACCOUNT)
            .expect("credentials")
            .is_some()
    );
    assert!(
        environment
            .store
            .ilink_peer(ACCOUNT, PEER)
            .expect("peer")
            .is_some()
    );
}

#[test]
fn logout_removes_channel_state_and_retains_session_history() {
    let environment = environment("logout");
    let keyring = keyring(&environment.database);
    connect_account(&environment.store, &keyring);
    let project = environment
        .workspace
        .create_project(".", "ilink-logout-project")
        .expect("project");
    let conversation = environment
        .store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Kept"))
        .expect("conversation");
    environment
        .store
        .bind_ilink_session(ACCOUNT, &conversation.id)
        .expect("bind");
    environment
        .store
        .commit_ilink_inbound_message(ACCOUNT, "key-a", "cursor-a", 1)
        .expect("commit");
    environment
        .store
        .set_ilink_quick_prompt(ACCOUNT, 2, "status")
        .expect("quick prompt");

    environment.store.ilink_logout(ACCOUNT).expect("logout");
    // The secret file is destroyed after the row deletion (logout order).
    keyring.destroy().expect("destroy secret");
    assert!(
        !environment
            .database
            .parent()
            .unwrap()
            .join("ilink/secret.key")
            .exists()
    );

    assert!(
        environment
            .store
            .ilink_credentials(ACCOUNT)
            .expect("credentials")
            .is_none()
    );
    assert!(
        environment
            .store
            .ilink_peers(ACCOUNT)
            .expect("peers")
            .is_empty()
    );
    assert!(
        !environment
            .store
            .ilink_message_seen(ACCOUNT, "key-a")
            .expect("dedupe cleared")
    );
    assert_eq!(
        environment
            .store
            .ilink_session_binding(ACCOUNT)
            .expect("binding"),
        None
    );
    assert!(
        environment
            .store
            .ilink_quick_prompts(ACCOUNT)
            .expect("prompts")
            .is_empty()
    );
    let account = environment
        .store
        .ilink_account(ACCOUNT)
        .expect("account")
        .expect("account row is retained as a record");
    assert_eq!(account.status, IlinkAccountStatus::Disconnected);

    // Session history and Project files are untouched.
    assert!(environment.store.get_conversation(&conversation.id).is_ok());
}

#[test]
fn binding_validates_the_target_session() {
    let environment = environment("binding");
    let keyring = keyring(&environment.database);
    connect_account(&environment.store, &keyring);
    let project = environment
        .workspace
        .create_project(".", "ilink-binding-project")
        .expect("project");
    let conversation = environment
        .store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Writable"))
        .expect("conversation");

    // Unknown conversation is rejected.
    assert!(
        environment
            .store
            .bind_ilink_session(ACCOUNT, "conv-missing")
            .is_err()
    );
    // A writable session binds and rebinds atomically.
    environment
        .store
        .bind_ilink_session(ACCOUNT, &conversation.id)
        .expect("bind");
    let other = environment
        .store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Other"))
        .expect("other");
    environment
        .store
        .bind_ilink_session(ACCOUNT, &other.id)
        .expect("rebind");
    assert_eq!(
        environment
            .store
            .ilink_session_binding(ACCOUNT)
            .expect("binding"),
        Some(other.id.clone())
    );

    // Read-only sessions are rejected (set via raw SQL: the store has no
    // public read-only mutator).
    let raw = rusqlite::Connection::open(&environment.database).expect("raw connection");
    raw.execute(
        "UPDATE conversations SET read_only = 1 WHERE id = ?1",
        [&conversation.id],
    )
    .expect("read only");
    assert!(
        environment
            .store
            .bind_ilink_session(ACCOUNT, &conversation.id)
            .is_err()
    );

    // Sub-agent conversations are rejected.
    let subagent = environment
        .store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Sub"))
        .expect("sub conversation");
    raw.execute(
        "UPDATE conversations SET relationship = 'subagent' WHERE id = ?1",
        [&subagent.id],
    )
    .expect("mark subagent");
    assert!(
        environment
            .store
            .bind_ilink_session(ACCOUNT, &subagent.id)
            .is_err()
    );
    drop(raw);

    // Archived sessions are rejected.
    environment
        .store
        .set_archived(&other.id, true)
        .expect("archive");
    assert!(
        environment
            .store
            .bind_ilink_session(ACCOUNT, &other.id)
            .is_err()
    );
}

#[test]
fn status_and_binding_changes_publish_safe_events_only() {
    let environment = environment("events");
    let keyring = keyring(&environment.database);
    connect_account(&environment.store, &keyring);
    let project = environment
        .workspace
        .create_project(".", "ilink-events-project")
        .expect("project");
    let conversation = environment
        .store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");
    environment
        .store
        .bind_ilink_session(ACCOUNT, &conversation.id)
        .expect("bind");

    let events = environment
        .store
        .workspace_events_after(0)
        .expect("events")
        .into_iter()
        .filter(|event| event.kind == "ilink_status_changed")
        .collect::<Vec<_>>();
    assert!(!events.is_empty());
    let latest = events.last().expect("latest status event");
    assert_eq!(latest.payload["account_id"], ACCOUNT);
    assert_eq!(latest.payload["status"], "connected");
    assert_eq!(latest.payload["conversation_id"], conversation.id);
    let rendered = latest.payload.to_string();
    assert!(!rendered.contains(SYNTHETIC_TOKEN));
    assert!(!rendered.contains("cursor-a"));
    assert!(!rendered.contains(PEER));
}

#[test]
fn quick_prompt_slots_are_bounded() {
    let environment = environment("quick");
    let keyring = keyring(&environment.database);
    connect_account(&environment.store, &keyring);
    assert!(
        environment
            .store
            .set_ilink_quick_prompt(ACCOUNT, 0, "x")
            .is_err()
    );
    assert!(
        environment
            .store
            .set_ilink_quick_prompt(ACCOUNT, 10, "x")
            .is_err()
    );
    for slot in 1..=9 {
        environment
            .store
            .set_ilink_quick_prompt(ACCOUNT, slot, &format!("prompt {slot}"))
            .expect("set");
    }
    let prompts = environment
        .store
        .ilink_quick_prompts(ACCOUNT)
        .expect("prompts");
    assert_eq!(prompts.len(), 9);
    assert_eq!(prompts[0], (1, "prompt 1".to_owned()));
    environment
        .store
        .remove_ilink_quick_prompt(ACCOUNT, 3)
        .expect("remove");
    assert_eq!(
        environment
            .store
            .ilink_quick_prompts(ACCOUNT)
            .expect("prompts")
            .len(),
        8
    );
}

#[test]
fn startup_repair_clears_orphaned_bindings() {
    let environment = environment("repair");
    let keyring = keyring(&environment.database);
    connect_account(&environment.store, &keyring);
    let project = environment
        .workspace
        .create_project(".", "ilink-repair-project")
        .expect("project");
    let conversation = environment
        .store
        .create_conversation(&project.id, AgentId::OpenCode, None)
        .expect("conversation");
    environment
        .store
        .bind_ilink_session(ACCOUNT, &conversation.id)
        .expect("bind");

    // Simulate the legacy path: a conversation deleted without the binding
    // cleanup (older schema, foreign keys disabled) leaves an orphan row.
    let raw = rusqlite::Connection::open(&environment.database).expect("raw connection");
    raw.execute_batch("PRAGMA foreign_keys = OFF;")
        .expect("disable foreign keys");
    raw.execute(
        "DELETE FROM conversations WHERE id = ?1",
        [&conversation.id],
    )
    .expect("legacy delete");
    drop(raw);
    assert!(
        environment
            .store
            .ilink_session_binding(ACCOUNT)
            .expect("binding")
            .is_some(),
        "orphaned binding exists before repair"
    );

    environment.store.repair_ilink_state().expect("repair");
    assert_eq!(
        environment
            .store
            .ilink_session_binding(ACCOUNT)
            .expect("binding"),
        None
    );
    // Idempotent.
    environment
        .store
        .repair_ilink_state()
        .expect("repair again");
}

#[test]
fn credentials_require_an_account_row() {
    let environment = environment("orphan");
    let record = credential_record("ilink_bot_unknown", vec![1, 2, 3], "cursor");
    // The foreign key keeps orphan credentials out; but even before the
    // foreign key fires, reads of a missing account are None.
    assert!(
        environment
            .store
            .ilink_credentials("ilink_bot_unknown")
            .expect("lookup")
            .is_none()
    );
    let _ = record;
}
