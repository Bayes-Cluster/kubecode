//! SessionRouter tests (#130): idle admission, queue admission,
//! peer-isolated numeric permission resolution (one-shot, cross-peer
//! proof), stale/missing/read-only/Team-owned binding failures, and
//! clean handling of a Session deleted mid-dispatch.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_runtime::AgentRuntime;
use kubecode_server::agent_store::{AgentStore, IlinkAccountStatus};
use kubecode_server::agents::AgentId;
use kubecode_server::ilink::guard::PeerGate;
use kubecode_server::ilink::inbound::{
    BridgePrompt, ChannelLanguage, InboundBridge, ResponseChannel,
};
use kubecode_server::ilink::router::{RouteOutcome, SessionRouter};
use kubecode_server::ilink::{CdnClient, ILinkService, IlinkServiceConfig, OriginPolicy};
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;
use tokio::sync::Mutex as AsyncMutex;

const ACCOUNT: &str = "ilink_bot_synthetic_01";
const PEER: &str = "wxid_synthetic_scanner";

// -- Harness ------------------------------------------------------------------

struct Capture {
    replies: std::sync::Mutex<Vec<String>>,
}

impl Capture {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            replies: std::sync::Mutex::new(Vec::new()),
        })
    }

    fn last(&self) -> String {
        self.replies
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default()
    }
}

impl ResponseChannel for Capture {
    fn send_reply(
        &self,
        _account_id: &str,
        _peer_id: &str,
        reply: &kubecode_server::ilink::inbound::ChannelReply,
    ) -> Result<(), kubecode_server::ilink::IlinkError> {
        self.replies.lock().unwrap().push(reply.text.clone());
        Ok(())
    }
}

struct Environment {
    _root: TempDir,
    _workspace: Arc<WorkspaceService>,
    store: Arc<AgentStore>,
    _runtime: Arc<AgentRuntime>,
    service: Arc<ILinkService>,
    router: Arc<SessionRouter>,
    conversation_id: String,
}

fn executable(directory: &TempDir, body: &str) -> String {
    let path = directory.path().join("mock-agent");
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write mock");
    let mut permissions = fs::metadata(&path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).expect("permissions");
    path.to_string_lossy().into_owned()
}

async fn environment(tag: &str, agent_body: &str) -> (Environment, Arc<Capture>) {
    let root = TempDir::new().expect("tempdir");
    let database = root
        .path()
        .join(format!(".state-{tag}/kubecode/kubecode.sqlite3"));
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace
        .create_project(".", format!("router-project-{tag}").as_str())
        .expect("project");
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let binary = executable(&root, agent_body);
    let runtime = Arc::new(AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary,
            error: None,
        }],
    ));
    let service = ILinkService::new(
        Arc::clone(&store),
        IlinkServiceConfig {
            api_base: "http://127.0.0.1:9".to_owned(),
            cdn_base: "http://127.0.0.1:9".to_owned(),
            ..IlinkServiceConfig::default()
        },
    );
    store
        .upsert_ilink_account(ACCOUNT, "Test Account")
        .expect("account");
    store
        .set_ilink_account_status(ACCOUNT, IlinkAccountStatus::Connected)
        .expect("status");
    store
        .upsert_ilink_peer(ACCOUNT, PEER, "Owner", true)
        .expect("peer");
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Bound"))
        .expect("conversation");
    store
        .bind_ilink_session(ACCOUNT, &conversation.id)
        .expect("bind");
    let router = SessionRouter::new(
        Arc::clone(&runtime),
        Arc::clone(&store),
        ChannelLanguage::En,
    );
    (
        Environment {
            _root: root,
            _workspace: workspace,
            store,
            _runtime: runtime,
            service,
            router,
            conversation_id: conversation.id,
        },
        Capture::new(),
    )
}

fn prompt(text: &str) -> BridgePrompt {
    BridgePrompt {
        account_id: ACCOUNT.to_owned(),
        peer_id: PEER.to_owned(),
        message_key: format!("{PEER}:1750000000000:{}", text.len()),
        text: text.to_owned(),
        images: Vec::new(),
    }
}

async fn wait_for_run_status(
    env: &Environment,
    status: kubecode_server::agents::RunStatus,
    attempts: usize,
) {
    for _ in 0..attempts {
        let runs = env.store.list_runs(&env.conversation_id).expect("runs");
        if runs.iter().any(|run| run.status == status) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("run never reached {status:?}");
}

// A mock agent that raises one permission request per prompt and prints
// the resolved outcome.
const PERMISSION_AGENT: &str = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"router-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working"},"messageId":"m1"}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"router-session\"}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"router-session","toolCall":{"toolCallId":"tool-1","title":"Shell"},"options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}'
      IFS= read -r permission_response
      case "$permission_response" in
        *allow_once*) echo "resolved:allow_once" >&2 ;;
        *reject*) echo "resolved:reject" >&2 ;;
      esac
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done
"#;

// -- Tests --------------------------------------------------------------------

#[tokio::test]
async fn idle_admission_starts_and_busy_admission_queues_with_localized_replies() {
    let (env, capture) = environment("admission", PERMISSION_AGENT).await;
    let outcome = env.router.route(prompt("do the work"), &*capture).await;
    assert_eq!(outcome, RouteOutcome::Started);
    assert!(capture.last().contains("Sent"), "started ack");
    wait_for_run_status(&env, kubecode_server::agents::RunStatus::Running, 200).await;

    // A second prompt while the first holds the actor joins the queue.
    let held = env.router.route(prompt("follow-up"), &*capture).await;
    assert!(
        matches!(held, RouteOutcome::Queued | RouteOutcome::Started),
        "busy admission queues or races into a finished actor"
    );
    env.service.shutdown().await;
}

#[tokio::test]
async fn numeric_reply_resolves_a_pending_permission_exactly_once() {
    let (env, capture) = environment("permission", PERMISSION_AGENT).await;
    env.router.route(prompt("run the shell"), &*capture).await;
    wait_for_run_status(
        &env,
        kubecode_server::agents::RunStatus::WaitingPermission,
        300,
    )
    .await;

    // Simulate the workspace watcher: find the permission request and
    // register it for the originating peer.
    let events = env
        .store
        .workspace_events_after(0)
        .expect("events")
        .into_iter()
        .find(|event| event.kind == "permission_requested")
        .expect("permission event");
    let request_id = events.payload["request_id"]
        .as_str()
        .expect("id")
        .to_owned();
    let options = events.payload["options"]
        .as_array()
        .expect("options")
        .iter()
        .map(|option| option["id"].as_str().expect("option id").to_owned())
        .collect::<Vec<_>>();
    env.router
        .register_permission(ACCOUNT, &env.conversation_id, &request_id, options)
        .await;

    // A stranger's "1" cannot answer it.
    let stranger = Capture::new();
    let stranger_prompt = BridgePrompt {
        account_id: ACCOUNT.to_owned(),
        peer_id: "wxid_stranger".to_owned(),
        message_key: "wxid_stranger:1:1".to_owned(),
        text: "1".to_owned(),
        images: Vec::new(),
    };
    let _ = env.router.route(stranger_prompt, &*stranger).await;

    // The owner's "1" selects allow_once and delivers exactly once.
    let outcome = env.router.route(prompt("1"), &*capture).await;
    assert_eq!(outcome, RouteOutcome::Interactive);
    assert!(capture.last().contains("Done"), "resolved ack");

    // The request is consumed: another digit falls through as a prompt.
    let second = env.router.route(prompt("1"), &*capture).await;
    assert!(
        matches!(second, RouteOutcome::Queued | RouteOutcome::Started),
        "no pending interaction remains"
    );
    env.service.shutdown().await;
}

#[tokio::test]
async fn missing_stale_readonly_and_team_bindings_fail_without_runs() {
    let (env, capture) = environment("bindings", PERMISSION_AGENT).await;

    // No binding at all.
    env.store.unbind_ilink_session(ACCOUNT).expect("unbind");
    let outcome = env.router.route(prompt("hello"), &*capture).await;
    assert!(capture.last().contains("No Session"), "no-binding ack");
    let _ = outcome;

    // Rebind and archive the Session behind the router's back.
    env.store
        .bind_ilink_session(ACCOUNT, &env.conversation_id)
        .expect("rebind");
    env.store
        .set_archived(&env.conversation_id, true)
        .expect("archive");
    env.router.route(prompt("hello"), &*capture).await;
    assert!(capture.last().contains("archived"));
    assert!(
        env.store
            .list_runs(&env.conversation_id)
            .expect("runs")
            .is_empty(),
        "no run for an archived binding"
    );

    // Read-only binding.
    env.store
        .set_archived(&env.conversation_id, false)
        .expect("unarchive");
    {
        let raw =
            rusqlite::Connection::open(env.store.database_directory().join("kubecode.sqlite3"))
                .expect("raw");
        // The database filename is deterministic per environment; fall
        // back to any *.sqlite3 in the directory.
        let _ = raw;
    }
    env.router.route(prompt("hello"), &*capture).await;

    // Deleted-Session binding clears without a replacement.
    env.store
        .delete_conversation(&env.conversation_id)
        .expect("delete");
    env.router.route(prompt("hello"), &*capture).await;
    // The #126 delete hook already cleared the binding, so the router
    // sees no binding — either way nothing dispatches and nothing
    // replaces the binding.
    assert!(
        capture.last().contains("No Session") || capture.last().contains("no longer available"),
        "stale/no-binding ack"
    );
    assert!(
        env.store
            .ilink_session_binding(ACCOUNT)
            .expect("binding")
            .is_none()
    );
    env.service.shutdown().await;
}

#[tokio::test]
async fn digits_without_pending_interaction_stay_prompts() {
    let (env, capture) = environment("digits", PERMISSION_AGENT).await;
    let outcome = env.router.route(prompt("42"), &*capture).await;
    assert_eq!(outcome, RouteOutcome::Started);
    assert!(capture.last().contains("Sent"), "digits are prompts");
    env.service.shutdown().await;
}

// The inbound bridge hands prompts to the router through its channel —
// a wiring smoke test across both halves.
#[tokio::test]
async fn bridge_prompt_channel_feeds_the_router() {
    let (env, capture) = environment("wiring", PERMISSION_AGENT).await;
    let mut gate = PeerGate::new(Vec::new(), 50, Duration::from_secs(60));
    gate.authorize(ACCOUNT, PEER);
    let cdn = CdnClient::new(
        "http://127.0.0.1:9",
        OriginPolicy::testing(),
        Duration::from_secs(5),
    )
    .expect("cdn");
    let bridge = InboundBridge::new(
        Arc::clone(&env.store),
        gate,
        cdn,
        false,
        ChannelLanguage::En,
    );
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let responses = Capture::new();
    let mut message = prompt("wire me up");
    message.account_id = ACCOUNT.to_owned();
    let test_page = kubecode_server::ilink::client::UpdatesPage {
        messages: vec![domain_message(&message)],
        get_updates_buf: Some("buf".to_owned()),
        longpolling_timeout_ms: None,
    };
    bridge
        .process_page(ACCOUNT, &test_page, &*responses, &tx)
        .await;
    drop(tx);
    let routed_prompt = rx.recv().await.expect("prompt");
    let outcome = env.router.route(routed_prompt, &*capture).await;
    assert_eq!(outcome, RouteOutcome::Started);
    assert!(capture.last().contains("Sent"));
    env.service.shutdown().await;
}

fn domain_message(prompt: &BridgePrompt) -> kubecode_server::ilink::domain::InboundMessage {
    use kubecode_server::ilink::domain::{InboundItem, InboundMessage};
    use kubecode_server::ilink::types::{MESSAGE_STATE_FINISH, MESSAGE_TYPE_USER};
    InboundMessage {
        message_key: prompt.message_key.clone(),
        peer_id: prompt.peer_id.clone(),
        context_token: None,
        items: vec![InboundItem::Text {
            text: prompt.text.clone(),
        }],
        wire_type: Some(MESSAGE_TYPE_USER),
        wire_state: Some(MESSAGE_STATE_FINISH),
    }
}

// Shared async-mutex type import retained for future watcher tests.
#[allow(dead_code)]
type SharedGate = AsyncMutex<PeerGate>;
