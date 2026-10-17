//! Outbound bridge tests (#131): a WeChat-originated run streams ordered
//! text, typing, and terminal outcomes to its originating peer through the
//! production pipeline; permission menus resolve by numeric reply;
//! cancellation sends its typed notice; an unreachable peer stops
//! receiving sends; and the service delivers text/typing with the sealed
//! peer context and a cached typing ticket over the real wire shape.
//!
//! Shared media (#132): structured resource links resolve through
//! `WorkspaceService` by opaque id, arrive after preceding text, and
//! ineligible files (outside the root, symlinked, hidden, directories,
//! changed, mislabelled, oversized, other Sessions') never upload; the
//! service's encrypted CDN upload matches the reviewed upstream wire.

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
use kubecode_server::ilink::bridge::WorkspaceMediaSource;
use kubecode_server::ilink::inbound::{BridgePrompt, ChannelLanguage};
use kubecode_server::ilink::outbound::OutboundConfig;
use kubecode_server::ilink::outbound::{MediaRejection, MediaSource};
use kubecode_server::ilink::{
    ChannelBridge, ChannelBridgeConfig, ILinkService, IlinkError, IlinkServiceConfig, OriginPolicy,
    OutboundTransport, Secret, SecretKeyring,
};
use kubecode_server::shared_media::SharedMediaKind;
use kubecode_server::workspace::{SharedMediaFile, WorkspaceService};
use tempfile::TempDir;

const ACCOUNT: &str = "ilink_bot_synthetic_01";
const PEER: &str = "wxid_synthetic_owner";

// -- Capture transport ----------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
enum Sent {
    Text {
        client_id: String,
        text: String,
    },
    Typing(bool),
    Media {
        client_id: String,
        kind: SharedMediaKind,
        file_name: String,
        bytes: usize,
    },
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
                Sent::Typing(_) | Sent::Media { .. } => None,
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

    fn send_media<'a>(
        &'a self,
        peer_id: &'a str,
        media: &'a SharedMediaFile,
        client_id: &'a str,
    ) -> BoxFuture<'a, Result<(), IlinkError>> {
        Box::pin(async move {
            assert_eq!(peer_id, PEER);
            self.sent.lock().unwrap().push(Sent::Media {
                client_id: client_id.to_owned(),
                kind: media.kind,
                file_name: media.file_name.clone(),
                bytes: media.bytes.len(),
            });
            Ok(())
        })
    }
}

// -- Runtime harness -------------------------------------------------------------

struct Environment {
    root: TempDir,
    workspace: Arc<WorkspaceService>,
    project_path: std::path::PathBuf,
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
            executable: executable(&root, &agent_body.replace("__PROJECT__", &project.path)),
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
    let media: Arc<dyn MediaSource> =
        WorkspaceMediaSource::new(Arc::clone(&store), Arc::clone(&workspace));
    let bridge = ChannelBridge::start_with_transport(
        Arc::clone(&service),
        Arc::clone(&runtime),
        Arc::clone(&capture) as Arc<dyn OutboundTransport>,
        Some(media),
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
        root,
        workspace,
        project_path: std::path::PathBuf::from(&project.path),
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

// -- Shared media (#132) ----------------------------------------------------------

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nsynthetic-image-bytes";

fn resource_link(uri: &str, name: &str, title: Option<&str>) -> String {
    let title = title
        .map(|title| format!(r#","title":"{title}""#))
        .unwrap_or_default();
    format!(
        r#"      printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"outbound-session","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"resource_link","uri":"{uri}","name":"{name}"{title}}}}}}}}}'"#
    )
}

fn sharing_agent(links: &[String]) -> String {
    agent(&format!(
        r#"    *'"method":"session/prompt"'*)
{}
{}
      printf '%s\n' "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\"}}}}"
      ;;"#,
        chunk("Here is the chart."),
        links.join("\n"),
    ))
}

#[tokio::test]
async fn shared_image_follows_its_text_with_caption_and_content_free_events() {
    let env = environment(
        "media",
        &sharing_agent(&[resource_link(
            "file://__PROJECT__/out/chart.png",
            "chart.png",
            Some("Build chart"),
        )]),
    )
    .await;
    fs::create_dir_all(env.project_path.join("out")).expect("out dir");
    fs::write(env.project_path.join("out/chart.png"), PNG).expect("chart");
    route(&env, prompt("draw the chart", 1)).await;
    wait_until(
        || env.capture.snapshot().last() == Some(&Sent::Typing(false)),
        "completion",
    )
    .await;
    let sent: Vec<Sent> = env
        .capture
        .snapshot()
        .into_iter()
        .filter(|item| !matches!(item, Sent::Text { text, .. } if text == "Sent to the Session."))
        .collect();
    let run = env
        .store
        .list_runs(&env.conversation_id)
        .expect("runs")
        .pop()
        .expect("run");
    assert_eq!(
        sent[1..],
        [
            Sent::Text {
                client_id: format!("kubecode-{}-0", run.id),
                text: "Here is the chart.".into()
            },
            Sent::Text {
                client_id: format!("kubecode-{}-m0-caption", run.id),
                text: "Build chart".into()
            },
            Sent::Media {
                client_id: format!("kubecode-{}-m0", run.id),
                kind: SharedMediaKind::Image,
                file_name: "chart.png".into(),
                bytes: PNG.len(),
            },
            Sent::Typing(false),
        ]
    );
    // The public event carries only the opaque id, kind, and MIME.
    let event = env
        .store
        .workspace_events_after(0)
        .expect("events")
        .into_iter()
        .find(|event| event.kind == "media_shared")
        .expect("media event");
    let mut keys: Vec<&String> = event.payload.as_object().expect("object").keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["kind", "media_id", "mime"]);
    let rendered = event.payload.to_string();
    assert!(
        !rendered.contains("chart.png")
            && !rendered.contains(&env.project_path.display().to_string())
    );
    env.bridge.shutdown().await;
}

#[tokio::test]
async fn ineligible_shared_files_never_upload_and_send_one_notice_each() {
    let links = [
        // Outside the Session execution root.
        resource_link("file://__PROJECT__/../outside.png", "outside.png", None),
        // Symlink into the project pointing outside.
        resource_link("file://__PROJECT__/link.png", "link.png", None),
        // Hidden component.
        resource_link("file://__PROJECT__/.secrets/key.txt", "key.txt", None),
        // A directory with an allowlisted extension.
        resource_link("file://__PROJECT__/folder.png", "folder.png", None),
        // Missing.
        resource_link("file://__PROJECT__/missing.pdf", "missing.pdf", None),
        // Content does not match the extension.
        resource_link("file://__PROJECT__/fake.png", "fake.png", None),
        // Executable disguised as text.
        resource_link("file://__PROJECT__/run.txt", "run.txt", None),
    ];
    let env = environment("ineligible", &sharing_agent(&links)).await;
    let parent = env.project_path.parent().expect("parent");
    fs::write(parent.join("outside.png"), PNG).expect("outside");
    std::os::unix::fs::symlink(
        parent.join("outside.png"),
        env.project_path.join("link.png"),
    )
    .expect("symlink");
    fs::create_dir_all(env.project_path.join(".secrets")).expect("hidden dir");
    fs::write(env.project_path.join(".secrets/key.txt"), "secret").expect("hidden");
    fs::create_dir_all(env.project_path.join("folder.png")).expect("dir");
    fs::write(env.project_path.join("fake.png"), "not an image").expect("fake");
    fs::write(env.project_path.join("run.txt"), "#!/bin/sh\necho hi\n").expect("script");
    route(&env, prompt("share files", 1)).await;
    wait_until(
        || env.capture.snapshot().last() == Some(&Sent::Typing(false)),
        "completion",
    )
    .await;
    let snapshot = env.capture.snapshot();
    assert!(
        !snapshot
            .iter()
            .any(|item| matches!(item, Sent::Media { .. })),
        "nothing ineligible uploads"
    );
    let notices = env
        .capture
        .texts()
        .into_iter()
        .filter(|text| text == "A shared file could not be sent. Open Kubecode to get it.")
        .count();
    assert_eq!(notices, links.len());
    env.bridge.shutdown().await;
}

#[tokio::test]
async fn media_resolution_is_scoped_to_the_sharing_session_and_its_revision() {
    let env = environment("scope", &streaming_agent()).await;
    let conversation = env
        .store
        .get_conversation(&env.conversation_id)
        .expect("conversation");
    let other = env
        .store
        .create_conversation(&conversation.project_id, AgentId::OpenCode, Some("Other"))
        .expect("other");
    fs::write(env.project_path.join("report.pdf"), b"%PDF-1.7 synthetic").expect("pdf");
    let uri = format!("file://{}/report.pdf", env.project_path.display());
    let record = |id: &str, conversation_id: &str, declared: Option<u64>| {
        env.store
            .record_agent_media(&kubecode_server::agent_store::AgentMediaRef {
                id: id.to_owned(),
                conversation_id: conversation_id.to_owned(),
                run_id: "run".to_owned(),
                uri: uri.clone(),
                declared_size: declared,
                caption: None,
            })
            .expect("record");
    };
    record("ok", &env.conversation_id, Some(18));
    record("stale-size", &env.conversation_id, Some(999));
    record("foreign", &other.id, None);
    let source = WorkspaceMediaSource::new(Arc::clone(&env.store), Arc::clone(&env.workspace));
    let loaded = source.load(&env.conversation_id, "ok").expect("loads");
    assert_eq!(loaded.file.kind, SharedMediaKind::File);
    assert_eq!(loaded.file.mime, "application/pdf");
    assert_eq!(loaded.file.file_name, "report.pdf");
    assert_eq!(
        source.load(&env.conversation_id, "stale-size").err(),
        Some(MediaRejection::Changed),
        "a file that changed since it was shared is refused"
    );
    assert_eq!(
        source.load(&env.conversation_id, "foreign").err(),
        Some(MediaRejection::Unavailable),
        "another Session's media id never resolves here"
    );
    assert_eq!(
        source.load(&env.conversation_id, "unknown").err(),
        Some(MediaRejection::Unavailable)
    );
    // Oversized files are refused before reading.
    let big = env.project_path.join("big.zip");
    fs::File::create(&big)
        .expect("big")
        .set_len(10 * 1024 * 1024 + 1)
        .expect("size");
    env.store
        .record_agent_media(&kubecode_server::agent_store::AgentMediaRef {
            id: "big".to_owned(),
            conversation_id: env.conversation_id.clone(),
            run_id: "run".to_owned(),
            uri: format!("file://{}", big.display()),
            declared_size: None,
            caption: None,
        })
        .expect("record big");
    assert_eq!(
        source.load(&env.conversation_id, "big").err(),
        Some(MediaRejection::TooLarge)
    );
    // Removing the Session removes its media references.
    env.store
        .delete_conversation(&env.conversation_id)
        .expect("delete");
    assert!(env.store.agent_media("ok").expect("lookup").is_none());
    drop(env.root);
}

// -- Encrypted CDN upload wire (#132) -------------------------------------------

#[derive(Default)]
struct MediaWire {
    requests: Mutex<Vec<(String, serde_json::Value)>>,
    uploads: Mutex<Vec<Vec<u8>>>,
    upload_full_url: Mutex<Option<String>>,
}

async fn media_fallback(State(state): State<Arc<MediaWire>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, 32 << 20)
        .await
        .unwrap_or_default();
    let path = parts.uri.path().to_owned();
    if path == "/upload" {
        state.uploads.lock().unwrap().push(body.to_vec());
        return Response::builder()
            .status(200)
            .header("x-encrypted-param", "synthetic-download-param")
            .body(axum::body::Body::empty())
            .unwrap();
    }
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    state.requests.lock().unwrap().push((path.clone(), json));
    let response = match path.as_str() {
        "/ilink/bot/getupdates" => {
            tokio::time::sleep(Duration::from_millis(100)).await;
            r#"{"ret":0,"msgs":[],"get_updates_buf":"cursor"}"#.to_owned()
        }
        "/ilink/bot/getuploadurl" => match state.upload_full_url.lock().unwrap().clone() {
            Some(url) => serde_json::json!({ "upload_full_url": url }).to_string(),
            None => r#"{"upload_param":"synthetic-upload-param"}"#.to_owned(),
        },
        _ => r#"{"ret":0}"#.to_owned(),
    };
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(response))
        .unwrap()
}

async fn media_service() -> (TempDir, Arc<ILinkService>, Arc<MediaWire>) {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let mock = Arc::new(MediaWire::default());
    let app = Router::new()
        .fallback(media_fallback)
        .with_state(Arc::clone(&mock));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
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
    let service = ILinkService::new(
        Arc::clone(&store),
        IlinkServiceConfig {
            api_base: base.clone(),
            cdn_base: base,
            origin_policy: OriginPolicy::testing(),
            long_poll_timeout: Duration::from_millis(200),
            retry_delay: Duration::from_millis(50),
            ..IlinkServiceConfig::default()
        },
    );
    assert!(service.restore_on_startup().await.expect("restore"));
    (root, service, mock)
}

fn shared(kind: SharedMediaKind, mime: &'static str, name: &str, bytes: &[u8]) -> SharedMediaFile {
    SharedMediaFile {
        bytes: bytes.to_vec(),
        file_name: name.to_owned(),
        kind,
        mime,
    }
}

#[tokio::test]
async fn service_uploads_encrypted_media_and_sends_upstream_items() {
    let (_root, service, mock) = media_service().await;
    let image = shared(SharedMediaKind::Image, "image/png", "chart.png", PNG);
    // No reply context yet: nothing is uploaded.
    assert!(matches!(
        service.send_media(PEER, &image, "kubecode-run-m0").await,
        Err(IlinkError::PeerContextUnavailable)
    ));
    assert!(mock.uploads.lock().unwrap().is_empty());
    service
        .remember_peer_context(ACCOUNT, PEER, &Secret::new("ctx-synthetic"))
        .expect("context");

    service
        .send_media(PEER, &image, "kubecode-run-m0")
        .await
        .expect("image send");
    let pdf = shared(
        SharedMediaKind::File,
        "application/pdf",
        "report.pdf",
        b"%PDF-1.7 synthetic",
    );
    service
        .send_media(PEER, &pdf, "kubecode-run-m1")
        .await
        .expect("file send");

    let requests = mock.requests.lock().unwrap().clone();
    let uploads = mock.uploads.lock().unwrap().clone();
    let upload_requests: Vec<serde_json::Value> = requests
        .iter()
        .filter(|(path, _)| path == "/ilink/bot/getuploadurl")
        .map(|(_, body)| body.clone())
        .collect();
    let sends: Vec<serde_json::Value> = requests
        .iter()
        .filter(|(path, _)| path == "/ilink/bot/sendmessage")
        .map(|(_, body)| body.clone())
        .collect();
    assert_eq!(
        (upload_requests.len(), uploads.len(), sends.len()),
        (2, 2, 2)
    );

    for (index, (plaintext, media_type)) in [(PNG, 1), (&b"%PDF-1.7 synthetic"[..], 3)]
        .into_iter()
        .enumerate()
    {
        let request = &upload_requests[index];
        assert_eq!(request["media_type"], media_type);
        assert_eq!(request["to_user_id"], PEER);
        assert_eq!(request["rawsize"], plaintext.len());
        assert_eq!(request["filesize"], (plaintext.len() / 16 + 1) * 16);
        assert_eq!(request["no_need_thumb"], true);
        assert_eq!(
            request["rawfilemd5"],
            kubecode_server::ilink::crypto::md5_hex(plaintext)
        );
        let key_hex = request["aeskey"].as_str().expect("aeskey");
        let key: [u8; 16] = hex::decode(key_hex)
            .expect("hex key")
            .try_into()
            .expect("16 bytes");
        // The CDN received ciphertext that decrypts to the plaintext.
        assert_ne!(uploads[index], plaintext);
        assert_eq!(
            kubecode_server::ilink::crypto::aes_ecb_decrypt(&key, &uploads[index])
                .expect("decrypt"),
            plaintext
        );
        // The sent item references the upload exactly like upstream.
        let item = &sends[index]["msg"]["item_list"][0];
        let media = if media_type == 1 {
            assert_eq!(item["type"], 2);
            assert_eq!(item["image_item"]["mid_size"], uploads[index].len());
            &item["image_item"]["media"]
        } else {
            assert_eq!(item["type"], 4);
            assert_eq!(item["file_item"]["file_name"], "report.pdf");
            assert_eq!(item["file_item"]["len"], plaintext.len().to_string());
            &item["file_item"]["media"]
        };
        assert_eq!(media["encrypt_query_param"], "synthetic-download-param");
        assert_eq!(media["encrypt_type"], 1);
        use base64::Engine as _;
        assert_eq!(
            media["aes_key"],
            base64::engine::general_purpose::STANDARD.encode(key_hex.as_bytes())
        );
        assert_eq!(sends[index]["msg"]["context_token"], "ctx-synthetic");
        assert_eq!(
            sends[index]["msg"]["client_id"],
            format!("kubecode-run-m{index}")
        );
    }

    // An upload URL on an unexpected host is refused before any upload.
    *mock.upload_full_url.lock().unwrap() = Some("https://cdn.evil.example/upload".to_owned());
    assert!(matches!(
        service.send_media(PEER, &image, "kubecode-run-m2").await,
        Err(IlinkError::OriginRejected { .. })
    ));
    assert_eq!(mock.uploads.lock().unwrap().len(), 2);
    // Oversized payloads never leave the process.
    let huge = shared(
        SharedMediaKind::File,
        "application/zip",
        "huge.zip",
        &vec![0u8; 10 * 1024 * 1024 + 1],
    );
    assert!(matches!(
        service.send_media(PEER, &huge, "kubecode-run-m3").await,
        Err(IlinkError::PayloadTooLarge { .. })
    ));
    service.shutdown().await;
}
