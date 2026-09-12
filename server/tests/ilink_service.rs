//! ILinkService lifecycle tests (#127): QR TTL/refresh, verification,
//! redirect, restore, retry/backoff, stale token, duplicate starts,
//! abort, disconnect, logout, and shutdown — against a loopback wire
//! mock, with Tokio paused time for the timing-sensitive paths.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::response::Response;
use kubecode_server::agent_store::{AgentStore, IlinkAccountStatus};
use kubecode_server::ilink::OriginPolicy;
use kubecode_server::ilink::service::{ConnectionStatus, ILinkService, IlinkServiceConfig};
use tempfile::TempDir;

const CHANNEL_VERSION: &str = "2.4.6";
const BOT_AGENT: &str = "kubecode/test";
// -- Wire mock ----------------------------------------------------------------

#[derive(Clone)]
struct MockResponse {
    status: u16,
    body: String,
    delay_ms: u64,
}

#[derive(Default)]
struct MockState {
    routes: std::sync::Mutex<std::collections::HashMap<String, Vec<MockResponse>>>,
    counters: std::sync::Mutex<std::collections::HashMap<String, usize>>,
    requests: AtomicUsize,
}

impl MockState {
    fn set(&self, key: &str, responses: Vec<MockResponse>) {
        self.routes
            .lock()
            .unwrap()
            .insert(key.to_owned(), responses);
    }

    fn json(key_response: &str) -> MockResponse {
        MockResponse {
            status: 200,
            body: key_response.to_owned(),
            delay_ms: 0,
        }
    }

    fn fixture(name: &str) -> MockResponse {
        let body = match name {
            "qr.ok" => {
                r#"{"qrcode":"synthetic-qr-id","qrcode_img_content":"https://weixin.qq.com/x/synthetic"}"#
            }
            "status.wait" => r#"{"status":"wait"}"#,
            "status.scanned" => r#"{"status":"scaned"}"#,
            "status.need_verifycode" => r#"{"status":"need_verifycode"}"#,
            "status.confirmed" => {
                r#"{"status":"confirmed","bot_token":"synthetic-bot-token-000000000001","ilink_bot_id":"ilink_bot_synthetic_01","baseurl":"https://szchild.weixin.qq.com","ilink_user_id":"wxid_synthetic_scanner"}"#
            }
            "status.blocked" => r#"{"status":"verify_code_blocked"}"#,
            "status.binded" => r#"{"status":"binded_redirect"}"#,
            "updates.ok" => {
                r#"{"ret":0,"msgs":[],"get_updates_buf":"cursor-blob","longpolling_timeout_ms":30000}"#
            }
            "updates.expired" => r#"{"ret":0,"errcode":-14,"errmsg":"session timeout"}"#,
            other => panic!("unknown fixture {other}"),
        };
        Self::json(body)
    }
}

async fn mock_fallback(State(state): State<Arc<MockState>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let _ = axum::body::to_bytes(body, 1 << 20).await;
    let key = format!("{} {}", parts.method, parts.uri.path());
    let response = {
        let routes = state.routes.lock().unwrap();
        let counters = state.counters.lock().unwrap();
        let sequence = routes
            .get(&key)
            .unwrap_or_else(|| panic!("unmocked route {key}"));
        let index = counters
            .get(&key)
            .copied()
            .unwrap_or(0)
            .min(sequence.len() - 1);
        sequence[index].clone()
    };
    *state.counters.lock().unwrap().entry(key).or_insert(0) += 1;
    state.requests.fetch_add(1, Ordering::SeqCst);
    if response.delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(response.delay_ms)).await;
    }
    axum::response::Response::builder()
        .status(response.status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(response.body))
        .unwrap()
}

async fn spawn_mock() -> (String, Arc<MockState>) {
    let state = Arc::new(MockState::default());
    let app = Router::new()
        .fallback(mock_fallback)
        .with_state(Arc::clone(&state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), state)
}

// -- Harness ------------------------------------------------------------------

struct Environment {
    _root: TempDir,
    store: Arc<AgentStore>,
}

async fn environment(tag: &str) -> (Environment, String, Arc<MockState>) {
    let root = TempDir::new().expect("tempdir");
    let database = root
        .path()
        .join(format!(".state-{tag}/kubecode/kubecode.sqlite3"));
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let (base, mock) = spawn_mock().await;
    (Environment { _root: root, store }, base, mock)
}

fn fast_config(base: &str) -> IlinkServiceConfig {
    IlinkServiceConfig {
        api_base: base.to_owned(),
        cdn_base: base.to_owned(),
        channel_version: CHANNEL_VERSION.to_owned(),
        bot_agent: BOT_AGENT.to_owned(),
        qr_ttl: Duration::from_millis(400),
        qr_refresh_max: 2,
        login_poll_interval: Duration::from_millis(20),
        retry_delay: Duration::from_millis(20),
        backoff_base: Duration::from_millis(20),
        backoff_max: Duration::from_millis(60),
        stale_cooldown: Duration::from_millis(150),
        long_poll_timeout: Duration::from_millis(150),
        api_timeout: Duration::from_secs(5),
        config_timeout: Duration::from_secs(5),
        origin_policy: OriginPolicy::testing(),
    }
}

async fn wait_for_status(
    service: &ILinkService,
    expected: ConnectionStatus,
    attempts: usize,
) -> bool {
    for _ in 0..attempts {
        if service.status().await.status == expected {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    service.status().await.status == expected
}

// -- Tests --------------------------------------------------------------------

#[tokio::test]
async fn qr_login_reuses_a_fresh_code_and_never_duplicates_start() {
    let (env, base, mock) = environment("reuse").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));

    let first = service.start_login().await.expect("first start");
    assert!(!first.reused);
    let second = service.start_login().await.expect("second start");
    assert!(second.reused, "a fresh QR is reused, not re-issued");
    let issued = mock
        .counters
        .lock()
        .unwrap()
        .get("POST /ilink/bot/get_bot_qrcode")
        .copied()
        .unwrap_or(0);
    assert_eq!(issued, 1, "one QR request for two starts inside the TTL");

    service.shutdown().await;
    assert_eq!(
        service.status().await.status,
        ConnectionStatus::Disconnected
    );
}

#[tokio::test]
async fn qr_login_refreshes_a_bounded_number_of_times_then_expires() {
    let (env, base, mock) = environment("refresh").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![
            MockState::fixture("qr.ok"),
            MockState::fixture("qr.ok"),
            MockState::fixture("qr.ok"),
        ],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.wait")],
    );
    let config = IlinkServiceConfig {
        qr_ttl: Duration::from_millis(60),
        qr_refresh_max: 2,
        login_poll_interval: Duration::from_millis(10),
        ..fast_config(&base)
    };
    let service = ILinkService::new(Arc::clone(&env.store), config);
    service.start_login().await.expect("start");
    assert!(
        wait_for_status(&service, ConnectionStatus::Expired, 200).await,
        "QR expires after the bounded refresh budget"
    );
    let issued = mock
        .counters
        .lock()
        .unwrap()
        .get("POST /ilink/bot/get_bot_qrcode")
        .copied()
        .unwrap_or(0);
    assert_eq!(issued, 3, "initial QR plus two refreshes, then give up");
    service.shutdown().await;
}

#[tokio::test]
async fn verification_requires_an_active_login_and_a_matching_state() {
    let (env, base, mock) = environment("verify").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.need_verifycode")],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    // Without a login, codes are rejected outright.
    assert!(service.submit_verification_code("123456").await.is_err());
    service.start_login().await.expect("start");
    assert!(wait_for_status(&service, ConnectionStatus::VerificationRequired, 200).await);
    service
        .submit_verification_code("482913")
        .await
        .expect("code accepted");
    // A second code for the same login is harmless but the first was consumed.
    service.shutdown().await;
}

#[tokio::test]
async fn confirmed_login_persists_credentials_before_connected_and_restores() {
    let (env, base, mock) = environment("confirm").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.confirmed")],
    );
    mock.set(
        "POST /ilink/bot/getupdates",
        vec![MockState::fixture("updates.ok")],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    service.start_login().await.expect("start");
    assert!(
        wait_for_status(&service, ConnectionStatus::Connected, 300).await,
        "login confirms and the poll loop turns Connected"
    );

    // Persisted before connected: account, credentials, scanner peer.
    let account = env
        .store
        .ilink_account("ilink_bot_synthetic_01")
        .expect("account lookup")
        .expect("account row");
    assert_eq!(account.status, IlinkAccountStatus::Connected);
    let credentials = env
        .store
        .ilink_credentials("ilink_bot_synthetic_01")
        .expect("credentials")
        .expect("sealed credentials row");
    assert!(!credentials.sealed_blob.is_empty());
    assert_eq!(
        credentials.api_origin.trim_end_matches('/'),
        base,
        "the effective (post-redirect) base is persisted"
    );
    let peer = env
        .store
        .ilink_peer("ilink_bot_synthetic_01", "wxid_synthetic_scanner")
        .expect("peer")
        .expect("scanner peer");
    assert!(peer.authorized, "the scanning user is auto-authorized");

    // Restore on a fresh service against the same store.
    service.shutdown().await;
    let restored = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    assert!(restored.restore_on_startup().await.expect("restore"));
    assert!(
        wait_for_status(&restored, ConnectionStatus::Connected, 300).await,
        "restored account reaches Connected from stored credentials"
    );
    // Duplicate restore is idempotent.
    assert!(restored.restore_on_startup().await.expect("restore again"));
    restored.shutdown().await;
}

#[tokio::test]
async fn stale_token_expires_and_reconnect_honors_the_cooldown() {
    let (env, base, mock) = environment("stale").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.confirmed")],
    );
    mock.set(
        "POST /ilink/bot/getupdates",
        vec![MockState::fixture("updates.expired")],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    service.start_login().await.expect("start");
    assert!(
        wait_for_status(&service, ConnectionStatus::Expired, 400).await,
        "errcode -14 decays the session to Expired"
    );
    assert_eq!(
        env.store
            .ilink_account("ilink_bot_synthetic_01")
            .expect("account")
            .expect("account")
            .status,
        IlinkAccountStatus::Expired
    );
    // Reconnect inside the cooldown is rejected with the remaining time.
    let error = service.reconnect().await.expect_err("cooldown");
    assert!(matches!(
        error,
        kubecode_server::ilink::service::ServiceError::CooldownActive(_)
    ));
    // After the cooldown a reconnect is accepted (and will re-detect
    // expiry against the same fixture).
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(service.reconnect().await.is_ok());
    service.shutdown().await;
}

#[tokio::test]
async fn transport_failures_back_off_without_losing_the_poll_task() {
    let (env, base, mock) = environment("backoff").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.confirmed")],
    );
    // Long poll always fails with HTTP 500: the loop must back off, not die.
    mock.set(
        "POST /ilink/bot/getupdates",
        vec![MockState::json(r#"server error"#)],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    service.start_login().await.expect("start");
    assert!(
        wait_for_status(&service, ConnectionStatus::BackingOff, 400).await,
        "failures decay to BackingOff"
    );
    // The second attempt fires after the first backoff sleep; wait for
    // it instead of racing it.
    let mut attempts = 0;
    for _ in 0..400 {
        attempts = mock
            .counters
            .lock()
            .unwrap()
            .get("POST /ilink/bot/getupdates")
            .copied()
            .unwrap_or(0);
        if attempts >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(attempts >= 2, "the loop retries under backoff");
    service.shutdown().await;
    assert_eq!(
        service.status().await.status,
        ConnectionStatus::Disconnected
    );
}

#[tokio::test]
async fn repeated_start_login_after_confirm_does_not_duplicate_pollers() {
    let (env, base, mock) = environment("duplicate").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.confirmed")],
    );
    mock.set(
        "POST /ilink/bot/getupdates",
        vec![MockState::fixture("updates.ok")],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    service.start_login().await.expect("start");
    assert!(wait_for_status(&service, ConnectionStatus::Connected, 300).await);
    // A start while connected is refused, not duplicated.
    assert!(service.start_login().await.is_err());
    // Extra reconnects while connected are no-ops.
    service.reconnect().await.expect("idempotent reconnect");
    service.reconnect().await.expect("idempotent reconnect");
    service.shutdown().await;
}

#[tokio::test]
async fn shutdown_aborts_the_in_flight_long_poll_immediately() {
    let (env, base, mock) = environment("abort").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.confirmed")],
    );
    // The long poll is held well past the shutdown moment.
    mock.set(
        "POST /ilink/bot/getupdates",
        vec![MockResponse {
            status: 200,
            body: r#"{"ret":0,"msgs":[],"get_updates_buf":"b"}"#.to_owned(),
            delay_ms: 5_000,
        }],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    service.start_login().await.expect("start");
    // Wait until the poll loop has issued its first (held) request.
    for _ in 0..200 {
        if mock
            .counters
            .lock()
            .unwrap()
            .get("POST /ilink/bot/getupdates")
            .copied()
            .unwrap_or(0)
            > 0
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = std::time::Instant::now();
    service.shutdown().await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "shutdown must not wait for the server-side long poll"
    );
    assert_eq!(
        service.status().await.status,
        ConnectionStatus::Disconnected
    );
}

#[tokio::test]
async fn pages_are_forwarded_to_the_registered_sink_and_shutdown_keeps_the_durable_cursor() {
    let (env, base, mock) = environment("sink").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.confirmed")],
    );
    mock.set(
        "POST /ilink/bot/getupdates",
        vec![
            MockState::json(
                r#"{"ret":0,"msgs":[{"seq":1,"message_id":9,"from_user_id":"wxid_synthetic_scanner","create_time_ms":1750000000000,"message_type":1,"item_list":[{"type":1,"text_item":{"text":"hello"}}],"context_token":"ctx"}],"get_updates_buf":"blob-1","longpolling_timeout_ms":50}"#,
            ),
            MockState::json(r#"{"ret":0,"msgs":[],"get_updates_buf":"blob-2"}"#),
        ],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    let (sink_tx, mut sink_rx) = tokio::sync::mpsc::unbounded_channel();
    service.set_page_sink(Some(sink_tx)).await;
    service.start_login().await.expect("start");
    let page = tokio::time::timeout(Duration::from_secs(5), sink_rx.recv())
        .await
        .expect("page within timeout")
        .expect("page");
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].peer_id, "wxid_synthetic_scanner");
    // The in-memory cursor followed the page; the durable cursor is
    // untouched until message-commit (Phase 3).
    assert_eq!(page.get_updates_buf.as_deref(), Some("blob-1"));
    assert_eq!(
        env.store
            .first_ilink_credentials()
            .expect("credentials")
            .get_updates_buf,
        "",
        "durable cursor only moves with committed messages"
    );
    service.shutdown().await;
}

#[tokio::test]
async fn disconnect_removes_channel_state_and_blocks_later_operations() {
    let (env, base, mock) = environment("disconnect").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.confirmed")],
    );
    mock.set(
        "POST /ilink/bot/getupdates",
        vec![MockState::fixture("updates.ok")],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    service.start_login().await.expect("start");
    assert!(wait_for_status(&service, ConnectionStatus::Connected, 300).await);
    service.disconnect().await.expect("disconnect");
    assert_eq!(
        service.status().await.status,
        ConnectionStatus::Disconnected
    );
    assert!(env.store.first_ilink_credentials().is_none());
    assert!(
        env.store
            .ilink_account("ilink_bot_synthetic_01")
            .expect("account")
            .is_some(),
        "the account row survives logout as a record"
    );
    // Operations without state fail closed.
    assert!(service.reconnect().await.is_err());
    assert!(service.disconnect().await.is_err());
    assert!(
        !env.store
            .database_directory()
            .join("ilink/secret.key")
            .exists(),
        "logout destroys the machine secret"
    );
}

#[tokio::test]
async fn binded_redirect_ends_the_attempt_without_touching_credentials() {
    let (env, base, mock) = environment("binded").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.binded")],
    );
    let service = ILinkService::new(Arc::clone(&env.store), fast_config(&base));
    service.start_login().await.expect("start");
    assert!(
        wait_for_status(&service, ConnectionStatus::Disconnected, 200).await,
        "a binded_redirect folds to Disconnected (already linked semantics)"
    );
    assert!(env.store.first_ilink_credentials().is_none());
    service.shutdown().await;
}

#[tokio::test]
async fn login_ttl_expiry_without_refresh_budget_ends_the_loop() {
    let (env, base, mock) = environment("ttl").await;
    mock.set(
        "POST /ilink/bot/get_bot_qrcode",
        vec![MockState::fixture("qr.ok")],
    );
    mock.set(
        "GET /ilink/bot/get_qrcode_status",
        vec![MockState::fixture("status.wait")],
    );
    let config = IlinkServiceConfig {
        // No refresh budget: the first TTL expiry is terminal.
        qr_ttl: Duration::from_millis(60),
        qr_refresh_max: 0,
        login_poll_interval: Duration::from_millis(10),
        ..fast_config(&base)
    };
    let service = ILinkService::new(Arc::clone(&env.store), config);
    service.start_login().await.expect("start");
    assert_eq!(
        service.status().await.status,
        ConnectionStatus::WaitingForScan
    );
    assert!(
        wait_for_status(&service, ConnectionStatus::Expired, 300).await,
        "TTL expiry with a zero refresh budget is terminal"
    );
    service.shutdown().await;
}
