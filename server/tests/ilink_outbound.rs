//! Outbound bridge tests (#131): a WeChat-originated run streams ordered
//! text, typing, and terminal outcomes to its originating peer through the
//! production pipeline; permission menus resolve by numeric reply;
//! cancellation sends its typed notice; an unreachable peer stops
//! receiving sends; and the service delivers text/typing with the sealed
//! peer context and a cached typing ticket over the real wire shape.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::response::Response;
use futures_util::future::BoxFuture;
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_runtime::AgentRuntime;
use kubecode_server::agent_store::{AgentStore, IlinkAccountStatus, IlinkCredentialRecord};
use kubecode_server::agents::{AgentId, RunStatus};
use kubecode_server::ilink::inbound::{BridgePrompt, ChannelLanguage};
use kubecode_server::ilink::outbound::OutboundConfig;
use kubecode_server::ilink::{
    ChannelBridge, ChannelBridgeConfig, ILinkService, IlinkError, IlinkServiceConfig, OriginPolicy,
    OutboundTransport, Secret, SecretKeyring,
};
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;

const ACCOUNT: &str = "ilink_bot_synthetic_01";
const PEER: &str = "wxid_synthetic_owner";

// -- Capture transport ----------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
enum Sent {
    Text { client_id: String, text: String },
    Typing(bool),
}

#[derive(Default)]
struct Capture {
    sent: Mutex<Vec<Sent>>,
    /// When set, every text send fails as if the peer context expired.
    unreachable: std::sync::atomic::AtomicBool,
    text_attempts: std::sync::atomic::AtomicUsize,
}

impl Capture {
    fn snapshot(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }

    fn texts(&self) -> Vec<String> {
        self.snapshot()
            .into_iter()
            .filter_map(|sent| match sent {
                Sent::Text { text, .. } => Some(text),
                Sent::Typing(_) => None,
            })
            .collect()
    }
}

impl OutboundTransport for Capture {
    fn send_text<'a>(
        &'a self,
        peer_id: &'a str,
        text: &'a str,
        client_id: &'a str,
    ) -> BoxFuture<'a, Result<(), IlinkError>> {
        Box::pin(async move {
            assert_eq!(peer_id, PEER, "replies only reach the originating peer");
            self.text_attempts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.unreachable.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(IlinkError::PeerContextUnavailable);
            }
            self.sent.lock().unwrap().push(Sent::Text {
                client_id: client_id.to_owned(),
                text: text.to_owned(),
            });
            Ok(())
        })
    }

    fn set_typing<'a>(
        &'a self,
        peer_id: &'a str,
        typing: bool,
    ) -> BoxFuture<'a, Result<(), IlinkError>> {
        Box::pin(async move {
            assert_eq!(peer_id, PEER);
            self.sent.lock().unwrap().push(Sent::Typing(typing));
            Ok(())
        })
    }
}

// -- Runtime harness -------------------------------------------------------------

struct Environment {
    _root: TempDir,
    store: Arc<AgentStore>,
    runtime: Arc<AgentRuntime>,
    service: Arc<ILinkService>,
    bridge: Arc<ChannelBridge>,
    capture: Arc<Capture>,
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

async fn environment(tag: &str, agent_body: &str) -> Environment {
    let root = TempDir::new().expect("tempdir");
    let database = root
        .path()
        .join(format!(".state-{tag}/kubecode/kubecode.sqlite3"));
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace
        .create_project(".", format!("outbound-{tag}").as_str())
        .expect("project");
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let runtime = Arc::new(AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: executable(&root, agent_body),
            error: None,
        }],
    ));
    let service = ILinkService::new(
        Arc::clone(&store),
        IlinkServiceConfig {
            api_base: "http://127.0.0.1:9".to_owned(),
            cdn_base: "http://127.0.0.1:9".to_owned(),
            origin_policy: OriginPolicy::testing(),
            ..IlinkServiceConfig::default()
        },
    );
    // The bridge identifies the linked account through its credentials row.
    store
        .upsert_ilink_account(ACCOUNT, "Test Account")
        .expect("account");
    store
        .save_ilink_credentials(&IlinkCredentialRecord {
            account_id: ACCOUNT.to_owned(),
            device_id: "device".to_owned(),
            committed_cursor: 0,
            get_updates_buf: String::new(),
            api_origin: String::new(),
            cdn_origin: String::new(),
            sealed_blob: vec![0; 16],
        })
        .expect("credentials");
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
    let capture = Arc::new(Capture::default());
    let bridge = ChannelBridge::start_with_transport(
        Arc::clone(&service),
        Arc::clone(&runtime),
        Arc::clone(&capture) as Arc<dyn OutboundTransport>,
        ChannelBridgeConfig {
            language: ChannelLanguage::En,
            outbound: OutboundConfig {
                keepalive: Duration::from_secs(3600),
                retry_delay: Duration::from_millis(10),
                ..OutboundConfig::default()
            },
            ..ChannelBridgeConfig::default()
        },
    )
    .await
    .expect("bridge");
    Environment {
        _root: root,
        store,
        runtime,
        service,
        bridge,
        capture,
        conversation_id: conversation.id,
    }
}

fn prompt(text: &str, sequence: u32) -> BridgePrompt {
    BridgePrompt {
        account_id: ACCOUNT.to_owned(),
        peer_id: PEER.to_owned(),
        message_key: format!("{PEER}:1750000000000:{sequence}"),
        text: text.to_owned(),
        images: Vec::new(),
    }
}

async fn route(env: &Environment, prompt: BridgePrompt) {
    env.bridge
        .router
        .route(prompt, &env.bridge.outbound.responses())
        .await;
}

async fn wait_until(mut condition: impl FnMut() -> bool, what: &str) {
    for _ in 0..400 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

const INIT: &str = r#"
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"outbound-session\"}}"
      ;;"#;

fn agent(prompt_branch: &str) -> String {
    format!(
        r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
{INIT}
{prompt_branch}
  esac
done"#
    )
}

fn chunk(text: &str) -> String {
    format!(
        r#"      printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"outbound-session","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{text}"}}}}}}}}'"#
    )
}

fn streaming_agent() -> String {
    agent(&format!(
        r#"    *'"method":"session/prompt"'*)
{}
{}
      printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"outbound-session","update":{{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Shell","status":"pending"}}}}}}'
      printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"outbound-session","update":{{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed"}}}}}}'
{}
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\"}}}}"
      ;;"#,
        chunk("## Checking "),
        chunk("the **build**"),
        chunk("Build is green."),
    ))
}

// -- Tests ---------------------------------------------------------------------

#[tokio::test]
async fn wechat_run_streams_ordered_text_typing_and_completion() {
    let env = environment("stream", &streaming_agent()).await;
    route(&env, prompt("check the build", 1)).await;
    wait_until(
        || env.capture.snapshot().last() == Some(&Sent::Typing(false)),
        "typing stop after completion",
    )
    .await;
    let sent = env.capture.snapshot();
    let texts = env.capture.texts();
    // The router acknowledgement plus the two flushes, in event order:
    // pre-tool flush, then the terminal flush. Markdown is simplified.
    assert!(texts.contains(&"Sent to the Session.".to_owned()));
    let agent_texts: Vec<&String> = texts
        .iter()
        .filter(|text| text.as_str() != "Sent to the Session.")
        .collect();
    assert_eq!(agent_texts, vec!["Checking the build", "Build is green."]);
    let first_typing = sent.iter().position(|item| item == &Sent::Typing(true));
    let first_agent_text = sent
        .iter()
        .position(|item| matches!(item, Sent::Text { text, .. } if text == "Checking the build"));
    assert!(first_typing < first_agent_text, "typing precedes text");
    assert_eq!(
        sent.iter()
            .filter(|item| **item == Sent::Typing(false))
            .count(),
        1,
        "typing stops exactly once"
    );
    // Stable per-run client ids.
    let run = env
        .store
        .list_runs(&env.conversation_id)
        .expect("runs")
        .pop()
        .expect("run");
    let ids: Vec<String> = sent
        .iter()
        .filter_map(|item| match item {
            Sent::Text { client_id, .. } if client_id.contains(&run.id) => Some(client_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        ids,
        vec![
            format!("kubecode-{}-0", run.id),
            format!("kubecode-{}-1", run.id)
        ]
    );
    // The browser transcript is untouched: exactly one user turn.
    assert_eq!(
        env.store
            .list_runs(&env.conversation_id)
            .expect("runs")
            .len(),
        1
    );
    env.bridge.shutdown().await;
    env.service.shutdown().await;
}

#[tokio::test]
async fn browser_runs_in_the_bound_session_are_not_mirrored() {
    let env = environment("browser", &streaming_agent()).await;
    let conversation = env
        .store
        .get_conversation(&env.conversation_id)
        .expect("conversation");
    env.runtime
        .start(kubecode_server::agent_runtime::StartAgentRun {
            conversation_id: env.conversation_id.clone(),
            project_id: conversation.project_id,
            message: "from the browser".to_owned(),
            client_message_id: Some("browser-1".to_owned()),
        })
        .expect("browser run");
    wait_until(
        || {
            env.store
                .list_runs(&env.conversation_id)
                .expect("runs")
                .iter()
                .any(|run| run.status == RunStatus::Completed)
        },
        "browser run completion",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(env.capture.snapshot().is_empty(), "nothing reaches WeChat");
    env.bridge.shutdown().await;
}

const PERMISSION_AGENT: &str = r#"
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"outbound-session","toolCall":{"toolCallId":"tool-1","title":"Shell"},"options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}'
      IFS= read -r permission_response
      case "$permission_response" in
        *allow_once*) printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"outbound-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"allowed"}}}}' ;;
        *) printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"outbound-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"rejected"}}}}' ;;
      esac
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;"#;

#[tokio::test]
async fn permission_menu_is_answered_by_the_originating_peer_number() {
    let env = environment("permission", &agent(PERMISSION_AGENT)).await;
    route(&env, prompt("run the shell", 1)).await;
    wait_until(
        || {
            env.capture
                .texts()
                .iter()
                .any(|text| text.starts_with("Permission needed: Shell"))
        },
        "permission menu",
    )
    .await;
    let menu = env
        .capture
        .texts()
        .into_iter()
        .find(|text| text.starts_with("Permission needed"))
        .expect("menu");
    assert_eq!(
        menu,
        "Permission needed: Shell\n1. Allow once\n2. Reject\nReply with a number to choose."
    );
    route(&env, prompt("1", 2)).await;
    wait_until(
        || env.capture.texts().contains(&"allowed".to_owned()),
        "allowed reply",
    )
    .await;
    assert!(
        env.capture.texts().contains(&"Done.".to_owned()),
        "resolution ack"
    );
    env.bridge.shutdown().await;
}

const CANCELLABLE_AGENT: &str = r#"
    *'"method":"session/prompt"'*)
      prompt_id=$id
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"outbound-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"started work"}}}}'
      ;;
    *'"method":"session/cancel"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$prompt_id,\"result\":{\"stopReason\":\"cancelled\"}}"
      ;;"#;

#[tokio::test]
async fn cancellation_flushes_text_then_sends_the_typed_notice_and_stops_typing() {
    let env = environment("cancel", &agent(CANCELLABLE_AGENT)).await;
    route(&env, prompt("long job", 1)).await;
    wait_until(
        || {
            env.store
                .list_runs(&env.conversation_id)
                .expect("runs")
                .iter()
                .any(|run| run.status == RunStatus::Running)
        },
        "running run",
    )
    .await;
    // Let the first chunk persist before cancelling.
    wait_until(
        || {
            env.store
                .workspace_events_after(0)
                .expect("events")
                .iter()
                .any(|event| event.kind == "text_delta")
        },
        "first text delta",
    )
    .await;
    let run = env
        .store
        .list_runs(&env.conversation_id)
        .expect("runs")
        .pop()
        .expect("run");
    assert!(env.runtime.cancel(&run.id));
    wait_until(
        || env.capture.snapshot().last() == Some(&Sent::Typing(false)),
        "typing stop after cancel",
    )
    .await;
    let texts = env.capture.texts();
    let started = texts.iter().position(|text| text == "started work");
    let cancelled = texts.iter().position(|text| text == "Run cancelled.");
    assert!(
        started.is_some() && started < cancelled,
        "text flushes before the notice"
    );
    env.bridge.shutdown().await;
}

#[tokio::test]
async fn unreachable_peer_receives_no_further_sends_and_shutdown_stops_typing() {
    let env = environment("unreachable", &agent(CANCELLABLE_AGENT)).await;
    env.capture
        .unreachable
        .store(true, std::sync::atomic::Ordering::SeqCst);
    route(&env, prompt("long job", 1)).await;
    wait_until(
        || {
            env.capture
                .text_attempts
                .load(std::sync::atomic::Ordering::SeqCst)
                >= 1
        },
        "first failed send",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let attempts = env
        .capture
        .text_attempts
        .load(std::sync::atomic::Ordering::SeqCst);
    // The failed ack (or flush) drops the peer's run: no retries storm.
    assert!(attempts <= 2, "bounded attempts, got {attempts}");
    env.bridge.shutdown().await;

    // Shutdown with an active run stops typing.
    let env = environment("shutdown", &agent(CANCELLABLE_AGENT)).await;
    route(&env, prompt("long job", 1)).await;
    wait_until(
        || env.capture.snapshot().contains(&Sent::Typing(true)),
        "typing start",
    )
    .await;
    env.bridge.shutdown().await;
    assert_eq!(env.capture.snapshot().last(), Some(&Sent::Typing(false)));
}

#[tokio::test]
async fn a_restarted_bridge_delivers_what_happened_while_it_was_down() {
    let env = environment("restart", &streaming_agent()).await;
    route(&env, prompt("check the build", 1)).await;
    wait_until(
        || env.capture.snapshot().last() == Some(&Sent::Typing(false)),
        "first run delivered",
    )
    .await;
    // Give the delivery cursor a chance to persist, then stop the bridge.
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    env.bridge.shutdown().await;

    // While the bridge is down, a WeChat-originated run is interrupted —
    // exactly what the store records when the Runtime restarts mid-run.
    let conversation = env
        .store
        .get_conversation(&env.conversation_id)
        .expect("conversation");
    let run = env
        .store
        .start_run_with_client_message_id(
            &env.conversation_id,
            &conversation.project_id,
            "long job",
            kubecode_server::agents::PermissionMode::Safe,
            Some(&format!("ilink:{ACCOUNT}:{PEER}:1750000000000:9")),
        )
        .expect("run");
    env.store
        .finish_run(
            &run.id,
            RunStatus::Interrupted,
            None,
            kubecode_server::agents::TerminalCause::Interrupted,
        )
        .expect("interrupt");

    let capture = Arc::new(Capture::default());
    let bridge = ChannelBridge::start_with_transport(
        Arc::clone(&env.service),
        Arc::clone(&env.runtime),
        Arc::clone(&capture) as Arc<dyn OutboundTransport>,
        ChannelBridgeConfig {
            language: ChannelLanguage::En,
            outbound: OutboundConfig {
                keepalive: Duration::from_secs(3600),
                retry_delay: Duration::from_millis(10),
                ..OutboundConfig::default()
            },
            ..ChannelBridgeConfig::default()
        },
    )
    .await
    .expect("restarted bridge");
    wait_until(
        || {
            capture.texts().contains(
                &"Run interrupted — the Runtime restarted or the Agent disconnected.".to_owned(),
            )
        },
        "interrupted notice after restart",
    )
    .await;
    assert!(
        !capture.texts().iter().any(|text| text == "Build is green."),
        "already-delivered output is not replayed"
    );
    bridge.shutdown().await;
}

#[tokio::test]
async fn unbinding_mid_run_stops_typing_without_flushing() {
    let env = environment("unbind", &agent(CANCELLABLE_AGENT)).await;
    route(&env, prompt("long job", 1)).await;
    wait_until(
        || env.capture.snapshot().contains(&Sent::Typing(true)),
        "typing start",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    env.store.unbind_ilink_session(ACCOUNT).expect("unbind");
    wait_until(
        || env.capture.snapshot().last() == Some(&Sent::Typing(false)),
        "typing stop after unbind",
    )
    .await;
    assert!(
        !env.capture.texts().contains(&"started work".to_owned()),
        "buffers are cleared, not flushed"
    );
    env.bridge.shutdown().await;
}

// -- Service wire delivery ------------------------------------------------------

#[derive(Default)]
struct WireMock {
    requests: Mutex<Vec<(String, serde_json::Value)>>,
}

async fn wire_fallback(State(state): State<Arc<WireMock>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, 1 << 20)
        .await
        .unwrap_or_default();
    let path = parts.uri.path().to_owned();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    state.requests.lock().unwrap().push((path.clone(), json));
    let response = match path.as_str() {
        "/ilink/bot/getupdates" => {
            tokio::time::sleep(Duration::from_millis(100)).await;
            r#"{"ret":0,"msgs":[],"get_updates_buf":"cursor"}"#
        }
        "/ilink/bot/getconfig" => r#"{"ret":0,"typing_ticket":"synthetic-ticket"}"#,
        _ => r#"{"ret":0}"#,
    };
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(response))
        .unwrap()
}

#[tokio::test]
async fn service_sends_text_and_typing_with_the_sealed_peer_context() {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let mock = Arc::new(WireMock::default());
    let app = Router::new()
        .fallback(wire_fallback)
        .with_state(Arc::clone(&mock));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    // Persist a linked account exactly as a confirmed login would.
    let keyring = SecretKeyring::open(store.database_directory().join("ilink")).expect("keyring");
    let sealed = keyring
        .seal(br#"{"bot_token":"synthetic-bot-token"}"#)
        .expect("seal");
    store
        .upsert_ilink_account(ACCOUNT, "Test")
        .expect("account");
    store
        .save_ilink_credentials(&IlinkCredentialRecord {
            account_id: ACCOUNT.to_owned(),
            device_id: "device".to_owned(),
            committed_cursor: 0,
            get_updates_buf: String::new(),
            api_origin: base.clone(),
            cdn_origin: base.clone(),
            sealed_blob: sealed,
        })
        .expect("credentials");
    store
        .upsert_ilink_peer(ACCOUNT, PEER, "", true)
        .expect("peer");
    store
        .upsert_ilink_peer(ACCOUNT, "wxid_stranger", "", false)
        .expect("stranger");
    let service = ILinkService::new(
        Arc::clone(&store),
        IlinkServiceConfig {
            api_base: base.clone(),
            cdn_base: base.clone(),
            origin_policy: OriginPolicy::testing(),
            long_poll_timeout: Duration::from_millis(200),
            retry_delay: Duration::from_millis(50),
            ..IlinkServiceConfig::default()
        },
    );
    assert!(service.restore_on_startup().await.expect("restore"));

    // Without a stored context the peer cannot be addressed.
    assert!(matches!(
        service.send_text(PEER, "hello", "kubecode-x-0").await,
        Err(IlinkError::PeerContextUnavailable)
    ));
    // Unauthorized peers never get a stored context.
    assert!(
        service
            .remember_peer_context(ACCOUNT, "wxid_stranger", &Secret::new("ctx-stranger"))
            .is_err()
    );
    service
        .remember_peer_context(ACCOUNT, PEER, &Secret::new("ctx-synthetic-owner"))
        .expect("remember");
    let raw = store
        .ilink_peer_context_token(ACCOUNT, PEER)
        .expect("context row")
        .expect("sealed");
    assert!(
        !String::from_utf8_lossy(&raw).contains("ctx-synthetic-owner"),
        "context tokens are sealed at rest"
    );

    service
        .send_text(PEER, "hello", "kubecode-run-1-0")
        .await
        .expect("send");
    service.set_typing(PEER, true).await.expect("typing on");
    service.set_typing(PEER, false).await.expect("typing off");

    let requests = mock.requests.lock().unwrap().clone();
    let send = requests
        .iter()
        .find(|(path, _)| path == "/ilink/bot/sendmessage")
        .map(|(_, body)| body.clone())
        .expect("sendmessage");
    assert_eq!(send["msg"]["to_user_id"], PEER);
    assert_eq!(send["msg"]["client_id"], "kubecode-run-1-0");
    assert_eq!(send["msg"]["context_token"], "ctx-synthetic-owner");
    assert_eq!(send["msg"]["item_list"][0]["text_item"]["text"], "hello");
    let configs = requests
        .iter()
        .filter(|(path, _)| path == "/ilink/bot/getconfig")
        .count();
    assert_eq!(configs, 1, "the typing ticket is cached");
    let typing: Vec<i64> = requests
        .iter()
        .filter(|(path, _)| path == "/ilink/bot/sendtyping")
        .map(|(_, body)| body["status"].as_i64().unwrap_or_default())
        .collect();
    assert_eq!(typing, vec![1, 2], "typing then cancel");
    assert!(
        requests
            .iter()
            .filter(|(path, _)| path == "/ilink/bot/sendtyping")
            .all(|(_, body)| body["typing_ticket"] == "synthetic-ticket")
    );
    service.shutdown().await;
}
