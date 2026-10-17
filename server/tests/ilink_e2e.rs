//! End-to-end WeChat bridge evidence (#136) against the deterministic fake
//! iLink server: QR login with verification → bind → inbound prompt → run
//! → typing / text / encrypted media reply → disconnect; restart at the
//! cursor and dedupe boundaries; unauthorized peers and oversized media;
//! transient failures and stale tokens; graceful shutdown with a long poll
//! in flight; and the API-only authentication boundary. No real WeChat
//! credentials or network access are used.

#[path = "support/fake_ilink.rs"]
mod fake_ilink;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_runtime::{AgentRuntime, StartAgentRun};
use kubecode_server::agent_store::{AgentStore, IlinkCredentialRecord};
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router_api_only};
use kubecode_server::ilink::bridge::{ChannelBridge, ChannelBridgeConfig};
use kubecode_server::ilink::inbound::ChannelLanguage;
use kubecode_server::ilink::outbound::OutboundConfig;
use kubecode_server::ilink::service::{ConnectionStatus, ILinkService, IlinkServiceConfig};
use kubecode_server::ilink::{OriginPolicy, SecretKeyring};
use kubecode_server::teams::TeamStore;
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;
use tower::ServiceExt;

use fake_ilink::{BOT_ID, BOT_TOKEN, FakeIlink, QR_ID, SCANNER, Updates, user_image, user_text};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nsynthetic-chart";

struct Env {
    root: TempDir,
    store: Arc<AgentStore>,
    runtime: Arc<AgentRuntime>,
    service: Arc<ILinkService>,
    bridge: Arc<ChannelBridge>,
    fake: FakeIlink,
    project_path: String,
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

fn config(fake: &FakeIlink) -> IlinkServiceConfig {
    IlinkServiceConfig {
        api_base: fake.base.clone(),
        cdn_base: fake.base.clone(),
        channel_version: "2.4.6".to_owned(),
        bot_agent: "kubecode/test".to_owned(),
        login_poll_interval: Duration::from_millis(20),
        retry_delay: Duration::from_millis(20),
        backoff_base: Duration::from_millis(20),
        backoff_max: Duration::from_millis(60),
        stale_cooldown: Duration::from_millis(100),
        long_poll_timeout: Duration::from_secs(2),
        api_timeout: Duration::from_secs(5),
        config_timeout: Duration::from_secs(5),
        origin_policy: OriginPolicy::testing(),
        ..IlinkServiceConfig::default()
    }
}

async fn start_bridge(
    service: &Arc<ILinkService>,
    runtime: &Arc<AgentRuntime>,
) -> Arc<ChannelBridge> {
    ChannelBridge::start(
        Arc::clone(service),
        Arc::clone(runtime),
        ChannelBridgeConfig {
            language: ChannelLanguage::En,
            outbound: OutboundConfig {
                language: ChannelLanguage::En,
                keepalive: Duration::from_secs(3600),
                retry_delay: Duration::from_millis(10),
                ..OutboundConfig::default()
            },
            ..ChannelBridgeConfig::default()
        },
    )
    .await
    .expect("bridge")
}

/// A Runtime with one bound Session, the fake upstream, and a running
/// bridge. `restored` links the account from sealed credentials instead
/// of the QR flow.
async fn env(tag: &str, agent_body: &str, restored: bool) -> Env {
    let root = TempDir::new().expect("tempdir");
    let database = root
        .path()
        .join(format!(".state-{tag}/kubecode/kubecode.sqlite3"));
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace
        .create_project(".", format!("e2e-{tag}").as_str())
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
    let fake = FakeIlink::start().await;
    if restored {
        let keyring =
            SecretKeyring::open(store.database_directory().join("ilink")).expect("keyring");
        let sealed = keyring
            .seal(format!(r#"{{"bot_token":"{BOT_TOKEN}"}}"#).as_bytes())
            .expect("seal");
        store
            .upsert_ilink_account(BOT_ID, "Ops Bot")
            .expect("account");
        store
            .save_ilink_credentials(&IlinkCredentialRecord {
                account_id: BOT_ID.to_owned(),
                device_id: "device".to_owned(),
                committed_cursor: 0,
                get_updates_buf: String::new(),
                api_origin: fake.base.clone(),
                cdn_origin: fake.base.clone(),
                sealed_blob: sealed,
            })
            .expect("credentials");
        store
            .upsert_ilink_peer(BOT_ID, SCANNER, "", true)
            .expect("scanner");
    }
    let service = ILinkService::new(Arc::clone(&store), config(&fake));
    let bridge = start_bridge(&service, &runtime).await;
    if restored {
        assert!(service.restore_on_startup().await.expect("restore"));
    }
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Bound"))
        .expect("conversation");
    Env {
        root,
        store,
        runtime,
        service,
        bridge,
        fake,
        project_path: project.path,
        conversation_id: conversation.id,
    }
}

async fn wait_until(mut condition: impl FnMut() -> bool, what: &str) {
    for _ in 0..600 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn wait_status(service: &ILinkService, status: ConnectionStatus) {
    for _ in 0..400 {
        if service.status().await.status == status {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!(
        "never reached {status:?}, at {:?}",
        service.status().await.status
    );
}

const INIT: &str = r#"
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"e2e-session\"}}"
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

/// Replies with text, shares a project file, and ends the turn.
fn charting_agent() -> String {
    agent(
        r#"    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"e2e-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Here is the chart."}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"e2e-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"resource_link","uri":"file://__PROJECT__/out/chart.png","name":"chart.png"}}}}'
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;"#,
    )
}

fn quick_agent() -> String {
    agent(
        r#"    *'"method":"session/prompt"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;"#,
    )
}

fn holding_agent() -> String {
    agent(
        r#"    *'"method":"session/prompt"'*)
      prompt_id=$id
      ;;
    *'"method":"session/cancel"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$prompt_id,\"result\":{\"stopReason\":\"cancelled\"}}"
      ;;"#,
    )
}

fn message_key(peer: &str, sequence: i64) -> String {
    format!("{peer}:{}:{sequence}", 1_750_000_000_000i64 + sequence)
}

#[tokio::test]
async fn connect_bind_prompt_reply_with_media_then_disconnect() {
    let env = env("flow", &charting_agent(), false).await;
    fs::create_dir_all(format!("{}/out", env.project_path)).expect("out dir");
    fs::write(format!("{}/out/chart.png", env.project_path), PNG).expect("chart");

    // QR login with a verification code.
    env.fake
        .script_login(&["wait", "scaned", "need_verifycode"], Some("4829"));
    let start = env.service.start_login().await.expect("start login");
    wait_status(&env.service, ConnectionStatus::VerificationRequired).await;
    assert!(
        env.service
            .submit_verification_code_for("1111", Some(start.generation + 1))
            .await
            .is_err(),
        "codes for another QR are refused"
    );
    env.service
        .submit_verification_code_for("4829", Some(start.generation))
        .await
        .expect("code");
    wait_status(&env.service, ConnectionStatus::Connected).await;
    assert!(env.store.first_ilink_credentials().is_some());

    // Bind and prompt from the scanner (authorized automatically).
    env.store
        .bind_ilink_session(BOT_ID, &env.conversation_id)
        .expect("bind");
    env.fake.push_updates(Updates::Page {
        msgs: vec![user_text(SCANNER, 1, "draw the chart", "ctx-scanner-1")],
        buf: "cursor-1".to_owned(),
        timeout_ms: Some(1_500),
    });
    wait_until(|| env.fake.typing().last() == Some(&2), "typing cancel").await;

    // One user turn in the browser history, admitted through the channel.
    let runs = env.store.list_runs(&env.conversation_id).expect("runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].message, "draw the chart");
    assert!(
        env.store
            .ilink_message_seen(BOT_ID, &message_key(SCANNER, 1))
            .expect("seen")
    );
    // The committed cursor advanced and the next poll echoes it.
    assert_eq!(
        env.store
            .ilink_credentials(BOT_ID)
            .expect("credentials")
            .expect("row")
            .get_updates_buf,
        "cursor-1"
    );
    wait_until(
        || {
            env.fake
                .requests("/ilink/bot/getupdates")
                .iter()
                .any(|request| request.body["get_updates_buf"] == "cursor-1")
        },
        "cursor echo",
    )
    .await;

    // Ack, flushed text, then the encrypted image, in order, with the
    // peer's context token; typing started before and stopped after.
    let texts = env.fake.texts_to(SCANNER);
    assert!(texts.contains(&"Sent to the Session.".to_owned()));
    assert!(texts.contains(&"Here is the chart.".to_owned()));
    let messages = env.fake.sent_messages();
    let text_at = messages
        .iter()
        .position(|message| message["item_list"][0]["text_item"]["text"] == "Here is the chart.")
        .expect("text");
    let image_at = messages
        .iter()
        .position(|message| message["item_list"][0]["type"] == 2)
        .expect("image");
    assert!(text_at < image_at, "text before media");
    assert!(
        messages
            .iter()
            .all(|message| message["context_token"] == "ctx-scanner-1")
    );
    assert_eq!(env.fake.requests("/upload").len(), 1);
    assert_eq!(env.fake.typing().first(), Some(&1));

    // Nothing sensitive reached the public event stream.
    let events = serde_json::to_string(&env.store.workspace_events_after(0).expect("events"))
        .expect("serialize");
    for secret in [
        BOT_TOKEN,
        "ctx-scanner-1",
        QR_ID,
        "synthetic-login-target",
        "chart.png",
        &env.project_path,
        "synthetic-typing-ticket",
    ] {
        assert!(!events.contains(secret), "workspace events leak {secret}");
    }

    // Disconnect removes channel credentials but never Sessions or files.
    env.service.disconnect().await.expect("disconnect");
    assert!(env.store.first_ilink_credentials().is_none());
    assert!(
        env.store
            .ilink_session_binding(BOT_ID)
            .expect("binding")
            .is_none()
    );
    assert_eq!(
        env.store
            .list_runs(&env.conversation_id)
            .expect("runs")
            .len(),
        1
    );
    assert!(fs::metadata(format!("{}/out/chart.png", env.project_path)).is_ok());
    env.bridge.shutdown().await;
    env.service.shutdown().await;
}

#[tokio::test]
async fn restart_resumes_from_the_committed_cursor_without_duplicate_or_skipped_prompts() {
    let env = env("restart", &quick_agent(), true).await;
    env.store
        .bind_ilink_session(BOT_ID, &env.conversation_id)
        .expect("bind");
    env.fake.push_updates(Updates::Page {
        msgs: vec![user_text(SCANNER, 1, "first", "ctx-1")],
        buf: "c1".to_owned(),
        timeout_ms: None,
    });
    wait_until(
        || {
            env.store
                .ilink_message_seen(BOT_ID, &message_key(SCANNER, 1))
                .unwrap_or(false)
        },
        "first commit",
    )
    .await;

    // Crash window: message 3 was admitted but its dedupe/cursor commit
    // never happened.
    let conversation = env
        .store
        .get_conversation(&env.conversation_id)
        .expect("conversation");
    env.runtime
        .start_or_queue(StartAgentRun {
            conversation_id: env.conversation_id.clone(),
            project_id: conversation.project_id.clone(),
            message: "third".to_owned(),
            client_message_id: Some(format!("ilink:{BOT_ID}:{}", message_key(SCANNER, 3))),
        })
        .expect("admitted before crash");

    // Restart the channel on the same durable state.
    env.bridge.shutdown().await;
    env.service.shutdown().await;
    let polls_before = env.fake.requests("/ilink/bot/getupdates").len();
    let service = ILinkService::new(Arc::clone(&env.store), config(&env.fake));
    let bridge = start_bridge(&service, &env.runtime).await;
    assert!(service.restore_on_startup().await.expect("restore"));
    wait_until(
        || env.fake.requests("/ilink/bot/getupdates").len() > polls_before,
        "first poll after restart",
    )
    .await;
    assert_eq!(
        env.fake.requests("/ilink/bot/getupdates")[polls_before].body["get_updates_buf"],
        "c1",
        "polling resumes from the committed cursor"
    );

    // Upstream replays the committed message and the uncommitted one, then
    // delivers a new one.
    env.fake.push_updates(Updates::Page {
        msgs: vec![
            user_text(SCANNER, 1, "first", "ctx-1"),
            user_text(SCANNER, 3, "third", "ctx-3"),
            user_text(SCANNER, 2, "second", "ctx-2"),
        ],
        buf: "c2".to_owned(),
        timeout_ms: None,
    });
    wait_until(
        || {
            env.store
                .ilink_message_seen(BOT_ID, &message_key(SCANNER, 2))
                .unwrap_or(false)
        },
        "second commit",
    )
    .await;
    wait_until(
        || {
            env.store
                .ilink_message_seen(BOT_ID, &message_key(SCANNER, 3))
                .unwrap_or(false)
        },
        "third commit",
    )
    .await;
    let runs = env.store.list_runs(&env.conversation_id).expect("runs");
    let queued = env
        .store
        .list_queued_prompts(&env.conversation_id)
        .expect("queue");
    let mut messages: Vec<String> = runs
        .iter()
        .map(|run| run.message.clone())
        .chain(queued.iter().map(|item| item.content.clone()))
        .collect();
    messages.sort();
    assert_eq!(
        messages,
        vec!["first", "second", "third"],
        "each prompt exactly once"
    );
    bridge.shutdown().await;
    service.shutdown().await;
}

#[tokio::test]
async fn unauthorized_peers_and_oversized_media_never_reach_the_session() {
    let env = env("security", &quick_agent(), true).await;
    env.store
        .bind_ilink_session(BOT_ID, &env.conversation_id)
        .expect("bind");
    // An oversized but otherwise valid encrypted PNG (11 MiB) from the
    // authorized scanner: only the size bound can refuse it.
    let key: [u8; 16] = core::array::from_fn(|index| index as u8);
    let mut huge_png = PNG.to_vec();
    huge_png.resize(11 * 1024 * 1024, 0);
    env.fake.serve_blob(
        "huge-image",
        kubecode_server::ilink::crypto::aes_ecb_encrypt(&key, &huge_png).expect("encrypt"),
    );
    env.fake.push_updates(Updates::Page {
        msgs: vec![
            user_text(
                "wxid_synthetic_stranger",
                1,
                "rm -rf everything",
                "ctx-stranger",
            ),
            user_text("wxid_synthetic_stranger", 3, "again", "ctx-stranger-2"),
            user_image(SCANNER, 2, "huge-image", &BASE64.encode(key), "ctx-scanner"),
        ],
        buf: "c1".to_owned(),
        timeout_ms: None,
    });
    wait_until(
        || {
            env.fake.texts_to("wxid_synthetic_stranger").len() == 1
                && !env.fake.texts_to(SCANNER).is_empty()
        },
        "rejection and media notice",
    )
    .await;
    assert_eq!(
        env.fake.texts_to("wxid_synthetic_stranger"),
        vec!["This Kubecode channel is not available for your account."]
    );
    assert_eq!(
        env.fake.texts_to(SCANNER),
        vec!["The attached media could not be loaded."]
    );
    assert!(
        env.store
            .list_runs(&env.conversation_id)
            .expect("runs")
            .is_empty()
    );
    // A replay of the stranger's message (as after a restart) and later
    // messages inside the window get no further reply.
    env.fake.push_updates(Updates::Page {
        msgs: vec![
            user_text(
                "wxid_synthetic_stranger",
                1,
                "rm -rf everything",
                "ctx-stranger",
            ),
            user_text("wxid_synthetic_stranger", 4, "please", "ctx-stranger-3"),
        ],
        buf: "c2".to_owned(),
        timeout_ms: None,
    });
    wait_until(
        || {
            env.store
                .ilink_message_seen(BOT_ID, &message_key("wxid_synthetic_stranger", 4))
                .unwrap_or(false)
        },
        "second stranger page processed",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        env.fake.texts_to("wxid_synthetic_stranger").len(),
        1,
        "one rejection per window, none for replays"
    );
    // The stranger's context is never persisted.
    assert!(
        env.store
            .ilink_peer_context_token(BOT_ID, "wxid_synthetic_stranger")
            .expect("lookup")
            .is_none()
    );
    let events = serde_json::to_string(&env.store.workspace_events_after(0).expect("events"))
        .expect("serialize");
    assert!(!events.contains("rm -rf") && !events.contains("ctx-stranger"));
    env.bridge.shutdown().await;
    env.service.shutdown().await;
}

#[tokio::test]
async fn transient_failures_back_off_and_a_stale_token_expires() {
    let env = env("expiry", &quick_agent(), true).await;
    env.fake.push_updates(Updates::HttpError(502));
    env.fake.push_updates(Updates::HttpError(503));
    wait_status(&env.service, ConnectionStatus::BackingOff).await;
    env.fake.push_updates(Updates::Page {
        msgs: Vec::new(),
        buf: "c1".to_owned(),
        timeout_ms: Some(500),
    });
    wait_status(&env.service, ConnectionStatus::Connected).await;
    env.fake.push_updates(Updates::Expired);
    wait_status(&env.service, ConnectionStatus::Expired).await;
    // Credentials stay for a re-scan; nothing is deleted on expiry.
    assert!(env.store.first_ilink_credentials().is_some());
    env.bridge.shutdown().await;
    env.service.shutdown().await;
}

#[tokio::test]
async fn graceful_shutdown_aborts_the_long_poll_and_stops_typing() {
    let env = env("shutdown", &holding_agent(), true).await;
    env.fake.set_idle_hold(Duration::from_secs(30));
    env.store
        .bind_ilink_session(BOT_ID, &env.conversation_id)
        .expect("bind");
    env.fake.push_updates(Updates::Page {
        msgs: vec![user_text(SCANNER, 1, "long job", "ctx-1")],
        buf: "c1".to_owned(),
        timeout_ms: None,
    });
    wait_until(|| env.fake.typing().first() == Some(&1), "typing start").await;
    // The next poll is now parked for 30s upstream.
    let started = Instant::now();
    env.bridge.shutdown().await;
    env.service.shutdown().await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "shutdown never waits out the long poll ({:?})",
        started.elapsed()
    );
    assert_eq!(env.fake.typing().last(), Some(&2), "typing stopped");
    assert!(!env.fake.requests("/ilink/bot/msg/notifystop").is_empty());
    // Credentials and the committed cursor survive for the next start.
    let credentials = env
        .store
        .first_ilink_credentials()
        .expect("credentials kept");
    assert_eq!(credentials.get_updates_buf, "c1");
    drop(env.root);
}

#[tokio::test]
async fn ilink_routes_require_the_runtime_bearer_in_api_only_mode() {
    let root = TempDir::new().expect("tempdir");
    let state_directory = root.path().join("srv/.state/kubecode");
    fs::create_dir_all(&state_directory).expect("state");
    let database = state_directory.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(root.path().join("srv"), &database).expect("workspace"));
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let app = app_router_api_only(
        AppState::new(workspace, store, teams),
        "/",
        "runtime-secret",
    );
    for (authorization, expected) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some("Bearer wrong"), StatusCode::UNAUTHORIZED),
        (Some("Bearer runtime-secret"), StatusCode::OK),
    ] {
        let mut request = Request::builder().uri("/api/v1/ilink/status");
        if let Some(value) = authorization {
            request = request.header(header::AUTHORIZATION, value);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("response");
        assert_eq!(response.status(), expected, "{authorization:?}");
    }
}
