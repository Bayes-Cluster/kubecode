//! iLink protocol compatibility tests (#125, ADR 0211). A loopback wire
//! mock replays committed synthetic fixtures (derived from public Tencent
//! shapes) so every endpoint, header, login state, business error,
//! timeout/abort path, and CDN key encoding is exercised without ever
//! touching the real network.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use kubecode_server::ilink::crypto::aes_ecb_encrypt;
use kubecode_server::ilink::types::CdnMedia;
use kubecode_server::ilink::{
    CdnClient, IlinkClient, IlinkError, InboundItem, LoginState, LongPollOutcome, OriginPolicy,
    OutboundText, build_client_version,
};
use tokio_util::sync::CancellationToken;

const CHANNEL_VERSION: &str = "2.4.6";
const BOT_AGENT: &str = "kubecode/0.1.3";
const SYNTHETIC_TOKEN: &str = "synthetic-bot-token-000000000001";

fn fixture(name: &str) -> &'static str {
    match name {
        "get_bot_qrcode.ok" => include_str!("ilink_fixtures/get_bot_qrcode.ok.json"),
        "get_qrcode_status.wait" => include_str!("ilink_fixtures/get_qrcode_status.wait.json"),
        "get_qrcode_status.scaned" => include_str!("ilink_fixtures/get_qrcode_status.scaned.json"),
        "get_qrcode_status.confirmed" => {
            include_str!("ilink_fixtures/get_qrcode_status.confirmed.json")
        }
        "get_qrcode_status.expired" => {
            include_str!("ilink_fixtures/get_qrcode_status.expired.json")
        }
        "get_qrcode_status.scaned_but_redirect" => {
            include_str!("ilink_fixtures/get_qrcode_status.scaned_but_redirect.json")
        }
        "get_qrcode_status.redirect_evil" => {
            include_str!("ilink_fixtures/get_qrcode_status.redirect_evil.json")
        }
        "get_qrcode_status.need_verifycode" => {
            include_str!("ilink_fixtures/get_qrcode_status.need_verifycode.json")
        }
        "get_qrcode_status.verify_code_blocked" => {
            include_str!("ilink_fixtures/get_qrcode_status.verify_code_blocked.json")
        }
        "get_qrcode_status.binded_redirect" => {
            include_str!("ilink_fixtures/get_qrcode_status.binded_redirect.json")
        }
        "get_qrcode_status.unknown" => {
            include_str!("ilink_fixtures/get_qrcode_status.unknown.json")
        }
        "getupdates.ok" => include_str!("ilink_fixtures/getupdates.ok.json"),
        "getupdates.session_expired" => {
            include_str!("ilink_fixtures/getupdates.session_expired.json")
        }
        "getupdates.business_error" => {
            include_str!("ilink_fixtures/getupdates.business_error.json")
        }
        "sendmessage.ok" => include_str!("ilink_fixtures/sendmessage.ok.json"),
        "sendmessage.business_error" => {
            include_str!("ilink_fixtures/sendmessage.business_error.json")
        }
        "getconfig.ok" => include_str!("ilink_fixtures/getconfig.ok.json"),
        "sendtyping.ok" => include_str!("ilink_fixtures/sendtyping.ok.json"),
        "notifystart.ok" => include_str!("ilink_fixtures/notifystart.ok.json"),
        "notifystop.ok" => include_str!("ilink_fixtures/notifystop.ok.json"),
        "getuploadurl.ok" => include_str!("ilink_fixtures/getuploadurl.ok.json"),
        "getuploadurl.full_url" => include_str!("ilink_fixtures/getuploadurl.full_url.json"),
        other => panic!("unknown fixture {other}"),
    }
}

#[derive(Clone)]
struct MockResponse {
    status: u16,
    body: Vec<u8>,
    delay_ms: u64,
    headers: Vec<(String, String)>,
}

impl MockResponse {
    fn json(body: &str) -> Self {
        Self {
            status: 200,
            body: body.as_bytes().to_vec(),
            delay_ms: 0,
            headers: Vec::new(),
        }
    }

    fn bytes(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            body,
            delay_ms: 0,
            headers: Vec::new(),
        }
    }

    fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    fn with_delay_ms(mut self, delay_ms: u64) -> Self {
        self.delay_ms = delay_ms;
        self
    }
}

#[derive(Default)]
struct MockState {
    routes: Mutex<HashMap<String, Vec<MockResponse>>>,
    requests: Mutex<Vec<RecordedRequest>>,
    counters: Mutex<HashMap<String, usize>>,
}

#[derive(Clone)]
struct RecordedRequest {
    method: String,
    path: String,
    query: String,
    authorization: Option<String>,
    authorization_type: Option<String>,
    app_id: Option<String>,
    client_version: Option<String>,
    uin: Option<String>,
    body: Vec<u8>,
}

impl RecordedRequest {
    fn header(&self, name: &str) -> String {
        let value = match name.to_ascii_lowercase().as_str() {
            "authorization" => &self.authorization,
            "authorizationtype" => &self.authorization_type,
            "ilink-app-id" => &self.app_id,
            "ilink-app-clientversion" => &self.client_version,
            "x-wechat-uin" => &self.uin,
            other => panic!("no recorded header {other}"),
        };
        value.clone().unwrap_or_default()
    }

    fn body_json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("recorded body is json")
    }
}

async fn mock_fallback(State(state): State<Arc<MockState>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body_bytes = axum::body::to_bytes(body, 4 << 20)
        .await
        .expect("mock body read");
    let key = format!("{} {}", parts.method, parts.uri.path());
    let response = {
        let routes = state.routes.lock().expect("routes");
        let counters = state.counters.lock().expect("counters");
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
    *state
        .counters
        .lock()
        .expect("counters")
        .entry(key)
        .or_insert(0) += 1;
    state
        .requests
        .lock()
        .expect("requests")
        .push(RecordedRequest {
            method: parts.method.to_string(),
            path: parts.uri.path().to_owned(),
            query: parts.uri.query().unwrap_or_default().to_owned(),
            authorization: parts
                .headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            authorization_type: parts
                .headers
                .get("AuthorizationType")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            app_id: parts
                .headers
                .get("iLink-App-Id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            client_version: parts
                .headers
                .get("iLink-App-ClientVersion")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            uin: parts
                .headers
                .get("X-WECHAT-UIN")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            body: body_bytes.to_vec(),
        });
    if response.delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(response.delay_ms)).await;
    }
    let mut builder = Response::builder().status(response.status);
    for (name, value) in &response.headers {
        builder = builder.header(name, value);
    }
    builder
        .body(axum::body::Body::from(response.body))
        .expect("mock response")
}

/// Spawns a loopback wire mock; returns its base URL and shared state.
async fn spawn_mock() -> (String, Arc<MockState>) {
    let state = Arc::new(MockState::default());
    let app = Router::new()
        .fallback(mock_fallback)
        .with_state(Arc::clone(&state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("mock server");
    });
    (format!("http://{addr}"), state)
}

fn mock(state: &Arc<MockState>) -> MockGuard<'_> {
    MockGuard { state }
}

struct MockGuard<'a> {
    state: &'a Arc<MockState>,
}

impl MockGuard<'_> {
    fn set(&self, method: &str, path: &str, responses: Vec<MockResponse>) {
        self.state
            .routes
            .lock()
            .expect("routes")
            .insert(format!("{method} {path}"), responses);
    }

    fn fixture(&self, method: &str, path: &str, name: &str) {
        self.set(method, path, vec![MockResponse::json(fixture(name))]);
    }

    fn requests(&self) -> Vec<RecordedRequest> {
        self.state.requests.lock().expect("requests").clone()
    }

    fn count_for(&self, method: &str, path: &str) -> usize {
        self.requests()
            .iter()
            .filter(|request| request.method == method && request.path == path)
            .count()
    }
}

fn mock_client(base: &str) -> IlinkClient {
    IlinkClient::new(
        base,
        base,
        OriginPolicy::testing(),
        CHANNEL_VERSION,
        BOT_AGENT,
    )
    .expect("client")
}

fn fast_timeouts(client: IlinkClient) -> IlinkClient {
    client.with_timeouts(
        Duration::from_millis(120),
        Duration::from_millis(120),
        Duration::from_millis(120),
    )
}

fn token() -> kubecode_server::ilink::Secret {
    kubecode_server::ilink::Secret::new(SYNTHETIC_TOKEN)
}

fn secret(value: &str) -> kubecode_server::ilink::Secret {
    kubecode_server::ilink::Secret::new(value)
}

const QR_PATH: &str = "/ilink/bot/get_bot_qrcode";
const QR_STATUS_PATH: &str = "/ilink/bot/get_qrcode_status";
const GETUPDATES_PATH: &str = "/ilink/bot/getupdates";
const SENDMESSAGE_PATH: &str = "/ilink/bot/sendmessage";
const GETCONFIG_PATH: &str = "/ilink/bot/getconfig";
const SENDTYPING_PATH: &str = "/ilink/bot/sendtyping";
const NOTIFY_START_PATH: &str = "/ilink/bot/msg/notifystart";
const NOTIFY_STOP_PATH: &str = "/ilink/bot/msg/notifystop";
const GETUPLOADURL_PATH: &str = "/ilink/bot/getuploadurl";
const CDN_UPLOAD_PATH: &str = "/upload";
const CDN_DOWNLOAD_PATH: &str = "/download";

#[tokio::test]
async fn qr_creation_posts_unauthenticated_with_bot_type_query() {
    let (base, state) = spawn_mock().await;
    mock(&state).fixture("POST", QR_PATH, "get_bot_qrcode.ok");
    let qr = mock_client(&base).create_qr().await.expect("qr");
    assert_eq!(qr.qrcode, "synthetic-qr-id-0123456789abcdef");
    assert!(!qr.qrcode_img_content.is_empty());
    let requests = mock(&state)
        .requests()
        .into_iter()
        .filter(|request| request.path == QR_PATH)
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.method, "POST");
    assert_eq!(request.query, "bot_type=3");
    assert_eq!(request.header("iLink-App-Id"), "bot");
    assert_eq!(request.header("AuthorizationType"), "ilink_bot_token");
    // No credentials yet: no Authorization header, but the random UIN exists.
    assert!(request.authorization.is_none());
    assert!(request.header("X-WECHAT-UIN").len() >= 4);
}

#[tokio::test]
async fn every_qr_login_state_is_represented() {
    let (base, state) = spawn_mock().await;
    let cases: &[(&str, LoginState)] = &[
        ("get_qrcode_status.wait", LoginState::Wait),
        ("get_qrcode_status.scaned", LoginState::Scaned),
        ("get_qrcode_status.confirmed", LoginState::Confirmed),
        ("get_qrcode_status.expired", LoginState::Expired),
        (
            "get_qrcode_status.scaned_but_redirect",
            LoginState::ScanedButRedirect,
        ),
        (
            "get_qrcode_status.need_verifycode",
            LoginState::NeedVerifycode,
        ),
        (
            "get_qrcode_status.verify_code_blocked",
            LoginState::VerifyCodeBlocked,
        ),
        (
            "get_qrcode_status.binded_redirect",
            LoginState::BindedRedirect,
        ),
    ];
    for (fixture_name, expected) in cases {
        mock(&state).fixture("GET", QR_STATUS_PATH, fixture_name);
        let poll = mock_client(&base)
            .poll_qr_status(&secret("synthetic-qr"), None, None)
            .await
            .expect("poll");
        assert_eq!(poll.state, *expected, "fixture {fixture_name}");
    }

    // The confirmed state carries credentials and the effective base URL.
    mock(&state).fixture("GET", QR_STATUS_PATH, "get_qrcode_status.confirmed");
    let poll = mock_client(&base)
        .poll_qr_status(&secret("synthetic-qr"), None, None)
        .await
        .expect("confirmed poll");
    assert_eq!(
        poll.bot_token.as_ref().map(|token| token.expose()),
        Some(SYNTHETIC_TOKEN)
    );
    assert_eq!(poll.bot_id.as_deref(), Some("ilink_bot_synthetic_01"));
    assert_eq!(
        poll.base_url.as_deref(),
        Some("https://szchild.weixin.qq.com")
    );
    assert_eq!(
        poll.scanner_user_id.as_deref(),
        Some("wxid_synthetic_scanner")
    );
    // Credential material never renders through the domain type.
    assert!(!format!("{poll:?}").contains(SYNTHETIC_TOKEN));

    // The unknown state is a typed protocol error, not a panic.
    mock(&state).fixture("GET", QR_STATUS_PATH, "get_qrcode_status.unknown");
    let error = mock_client(&base)
        .poll_qr_status(&secret("synthetic-qr"), None, None)
        .await
        .expect_err("unknown state");
    assert!(matches!(error, IlinkError::InvalidResponse { .. }));
}

#[tokio::test]
async fn qr_status_poll_sends_qrcode_and_optional_verify_code() {
    let (base, state) = spawn_mock().await;
    mock(&state).fixture("GET", QR_STATUS_PATH, "get_qrcode_status.need_verifycode");
    mock_client(&base)
        .poll_qr_status(&secret("synthetic-qr-id"), None, None)
        .await
        .expect("first poll");
    mock_client(&base)
        .poll_qr_status(&secret("synthetic-qr-id"), Some("482913"), None)
        .await
        .expect("poll with verify code");
    let queries: Vec<String> = mock(&state)
        .requests()
        .into_iter()
        .filter(|request| request.path == QR_STATUS_PATH)
        .map(|request| request.query)
        .collect();
    assert_eq!(queries.len(), 2);
    assert_eq!(queries[0], "qrcode=synthetic-qr-id");
    assert_eq!(queries[1], "qrcode=synthetic-qr-id&verify_code=482913");
}

#[tokio::test]
async fn redirect_host_must_pass_the_allowlist_before_rebasing() {
    let (base, state) = spawn_mock().await;
    mock(&state).fixture("GET", QR_STATUS_PATH, "get_qrcode_status.redirect_evil");
    // The client validates the redirect host eagerly: an off-allowlist
    // host fails the poll instead of poisoning the next request target.
    let error = mock_client(&base)
        .poll_qr_status(&secret("synthetic-qr"), None, None)
        .await
        .expect_err("evil redirect");
    assert!(matches!(error, IlinkError::OriginRejected { .. }));

    // A legitimate redirect host validates and can re-base the client.
    mock(&state).fixture(
        "GET",
        QR_STATUS_PATH,
        "get_qrcode_status.scaned_but_redirect",
    );
    let client = mock_client(&base);
    let poll = client
        .poll_qr_status(&secret("synthetic-qr"), None, None)
        .await
        .expect("legit redirect");
    assert_eq!(poll.redirect_host.as_deref(), Some("szchild.weixin.qq.com"));
    let rebased = client
        .with_api_base("https://szchild.weixin.qq.com")
        .expect("rebase");
    assert_eq!(
        rebased.api_base().as_str(),
        "https://szchild.weixin.qq.com/"
    );
    assert!(client.with_api_base("https://evil.example.com").is_err());
}

#[tokio::test]
async fn get_updates_parses_messages_cursor_and_headers() {
    let (base, state) = spawn_mock().await;
    mock(&state).fixture("POST", GETUPDATES_PATH, "getupdates.ok");
    let outcome = mock_client(&base)
        .get_updates(Some("synthetic-cursor-blob-0001"), &token(), None, None)
        .await
        .expect("getupdates");
    let LongPollOutcome::Items(page) = outcome else {
        panic!("expected messages");
    };
    assert_eq!(page.messages.len(), 2);
    assert_eq!(page.messages[0].peer_id, "wxid_synthetic_01");
    assert_eq!(
        page.messages[0].message_key,
        "wxid_synthetic_01:1750000000000:9001"
    );
    assert!(matches!(
        page.messages[0].items[0],
        InboundItem::Text { .. }
    ));
    assert!(matches!(
        &page.messages[1].items[0],
        InboundItem::Voice { transcription: Some(text) } if text == "voice transcription"
    ));
    assert_eq!(
        page.get_updates_buf.as_deref(),
        Some("synthetic-cursor-blob-0002")
    );
    assert_eq!(page.longpolling_timeout_ms, Some(30_000));

    let request = mock(&state)
        .requests()
        .into_iter()
        .find(|request| request.path == GETUPDATES_PATH)
        .expect("recorded getupdates");
    assert_eq!(request.header("iLink-App-Id"), "bot");
    assert_eq!(request.header("AuthorizationType"), "ilink_bot_token");
    assert_eq!(
        request.header("Authorization"),
        format!("Bearer {SYNTHETIC_TOKEN}")
    );
    assert_eq!(
        request.header("iLink-App-ClientVersion"),
        build_client_version(CHANNEL_VERSION).to_string()
    );
    // X-WECHAT-UIN is base64 of a decimal uint32.
    let decoded = BASE64
        .decode(request.header("X-WECHAT-UIN").as_bytes())
        .expect("uin base64");
    std::str::from_utf8(&decoded)
        .expect("uin digits")
        .parse::<u32>()
        .expect("uin decimal");
    // Body echoes the cursor and carries the versioned base_info.
    let body = request.body_json();
    assert_eq!(body["get_updates_buf"], "synthetic-cursor-blob-0001");
    assert_eq!(body["base_info"]["channel_version"], CHANNEL_VERSION);
    assert_eq!(body["base_info"]["bot_agent"], BOT_AGENT);
}

#[tokio::test]
async fn get_updates_maps_session_expiry_and_business_errors() {
    let (base, state) = spawn_mock().await;
    mock(&state).fixture("POST", GETUPDATES_PATH, "getupdates.session_expired");
    let error = mock_client(&base)
        .get_updates(None, &token(), None, None)
        .await
        .expect_err("session expired");
    assert!(error.is_session_expired());

    mock(&state).fixture("POST", GETUPDATES_PATH, "getupdates.business_error");
    let error = mock_client(&base)
        .get_updates(None, &token(), None, None)
        .await
        .expect_err("business error");
    assert!(matches!(error, IlinkError::Business { code: 1101, .. }));
    // The upstream errmsg never reaches the rendered error.
    assert!(!format!("{error}").contains("synthetic-leaky-errmsg"));
}

#[tokio::test]
async fn long_poll_timeout_and_cancellation_are_quiet() {
    let (base, state) = spawn_mock().await;
    mock(&state).set(
        "POST",
        GETUPDATES_PATH,
        vec![MockResponse::json(fixture("getupdates.ok")).with_delay_ms(400)],
    );
    let client = fast_timeouts(mock_client(&base));
    let outcome = client
        .get_updates(None, &token(), None, None)
        .await
        .expect("timeout folds to quiet");
    assert!(
        matches!(outcome, LongPollOutcome::Quiet),
        "long-poll timeout is control flow"
    );

    // Cancellation before the request yields Quiet immediately.
    let cancel = CancellationToken::new();
    cancel.cancel();
    let outcome = mock_client(&base)
        .get_updates(None, &token(), None, Some(&cancel))
        .await
        .expect("cancel folds to quiet");
    assert!(matches!(outcome, LongPollOutcome::Quiet));
    assert_eq!(mock(&state).count_for("POST", GETUPDATES_PATH), 1);
}

#[tokio::test]
async fn qr_status_timeout_is_a_wait() {
    let (base, state) = spawn_mock().await;
    mock(&state).set(
        "GET",
        QR_STATUS_PATH,
        vec![MockResponse::json(fixture("get_qrcode_status.wait")).with_delay_ms(400)],
    );
    let poll = fast_timeouts(mock_client(&base))
        .poll_qr_status(&secret("synthetic-qr"), None, None)
        .await
        .expect("timeout folds to wait");
    assert_eq!(poll.state, LoginState::Wait);
}

#[tokio::test]
async fn http_error_status_is_typed_without_the_body() {
    let (base, state) = spawn_mock().await;
    mock(&state).set(
        "POST",
        GETUPDATES_PATH,
        vec![MockResponse::bytes(503, b"Bearer gateway-secret".to_vec())],
    );
    let error = mock_client(&base)
        .get_updates(None, &token(), None, None)
        .await
        .expect_err("gateway error");
    assert!(matches!(error, IlinkError::HttpStatus { status: 503, .. }));
    let rendered = format!("{error} {error:?}");
    assert!(!rendered.contains("gateway-secret"));
}

#[tokio::test]
async fn send_message_round_trips_the_wire_shape() {
    let (base, state) = spawn_mock().await;
    mock(&state).fixture("POST", SENDMESSAGE_PATH, "sendmessage.ok");
    let outbound = OutboundText::new(
        "wxid_synthetic_01",
        "working on it",
        "kubecode-1".to_owned(),
    )
    .with_context_token(Some(secret("synthetic-context-token-01")));
    mock_client(&base)
        .send_message(&outbound, &token(), None)
        .await
        .expect("send");
    let request = mock(&state)
        .requests()
        .into_iter()
        .find(|request| request.path == SENDMESSAGE_PATH)
        .expect("recorded sendmessage");
    let body = request.body_json();
    assert_eq!(body["msg"]["to_user_id"], "wxid_synthetic_01");
    assert_eq!(body["msg"]["context_token"], "synthetic-context-token-01");
    assert_eq!(body["msg"]["message_type"], 2);
    assert_eq!(body["msg"]["message_state"], 2);
    assert_eq!(
        body["msg"]["item_list"][0]["text_item"]["text"],
        "working on it"
    );
    assert_eq!(body["base_info"]["channel_version"], CHANNEL_VERSION);
    assert_eq!(
        request.header("Authorization"),
        format!("Bearer {SYNTHETIC_TOKEN}")
    );

    mock(&state).fixture("POST", SENDMESSAGE_PATH, "sendmessage.business_error");
    let error = mock_client(&base)
        .send_message(&outbound, &token(), None)
        .await
        .expect_err("business error");
    assert!(matches!(error, IlinkError::Business { code: -1, .. }));
    assert!(!format!("{error:?}").contains("synthetic-leaky-send"));
}

#[tokio::test]
async fn config_typing_and_notify_round_trips() {
    let (base, state) = spawn_mock().await;
    let client = mock_client(&base);
    mock(&state).fixture("POST", GETCONFIG_PATH, "getconfig.ok");
    let config = client
        .get_config(
            "wxid_synthetic_01",
            Some(&secret("synthetic-context-token-01")),
            &token(),
        )
        .await
        .expect("config");
    let ticket = config.typing_ticket.expect("typing ticket");

    mock(&state).fixture("POST", SENDTYPING_PATH, "sendtyping.ok");
    client
        .send_typing("wxid_synthetic_01", &secret(&ticket), 1, &token())
        .await
        .expect("typing");
    let request = mock(&state)
        .requests()
        .into_iter()
        .find(|request| request.path == SENDTYPING_PATH)
        .expect("recorded sendtyping");
    let body = request.body_json();
    assert_eq!(body["ilink_user_id"], "wxid_synthetic_01");
    assert_eq!(body["typing_ticket"], ticket);
    assert_eq!(body["status"], 1);

    mock(&state).fixture("POST", NOTIFY_START_PATH, "notifystart.ok");
    mock(&state).fixture("POST", NOTIFY_STOP_PATH, "notifystop.ok");
    client.notify_start(&token()).await.expect("notify start");
    client.notify_stop(&token()).await.expect("notify stop");
    assert_eq!(mock(&state).count_for("POST", NOTIFY_START_PATH), 1);
    assert_eq!(mock(&state).count_for("POST", NOTIFY_STOP_PATH), 1);
}

#[tokio::test]
async fn get_upload_url_round_trips_and_the_qr_status_get_stays_public() {
    let (base, state) = spawn_mock().await;
    let client = mock_client(&base);
    mock(&state).fixture("POST", GETUPLOADURL_PATH, "getuploadurl.ok");
    let response = client
        .get_upload_url(
            kubecode_server::ilink::types::GetUploadUrlReq {
                filekey: Some("synthetic-filekey".to_owned()),
                media_type: Some(1),
                to_user_id: Some("wxid_synthetic_01".to_owned()),
                rawsize: Some(11),
                rawfilemd5: Some("0xdeadbeef".to_owned()),
                filesize: Some(16),
                thumb_rawsize: None,
                thumb_rawfilemd5: None,
                thumb_filesize: None,
                no_need_thumb: Some(true),
                aeskey: Some("00112233445566778899aabbccddeeff".to_owned()),
                base_info: None,
            },
            &token(),
        )
        .await
        .expect("getuploadurl");
    assert_eq!(
        response.upload_param.as_deref(),
        Some("synthetic-upload-param")
    );
    let request = mock(&state)
        .requests()
        .into_iter()
        .find(|request| request.path == GETUPLOADURL_PATH)
        .expect("recorded getuploadurl");
    let body = request.body_json();
    assert_eq!(body["filekey"], "synthetic-filekey");
    assert_eq!(body["filesize"], 16);
    assert_eq!(body["no_need_thumb"], true);
    assert_eq!(body["base_info"]["channel_version"], CHANNEL_VERSION);
    assert_eq!(
        request.header("Authorization"),
        format!("Bearer {SYNTHETIC_TOKEN}")
    );

    // QR status GETs carry only the public common headers — no bearer, no
    // AuthorizationType, no UIN.
    mock(&state).fixture("GET", QR_STATUS_PATH, "get_qrcode_status.wait");
    client
        .poll_qr_status(&secret("synthetic-qr"), None, None)
        .await
        .expect("status poll");
    let request = mock(&state)
        .requests()
        .into_iter()
        .find(|request| request.path == QR_STATUS_PATH)
        .expect("recorded status");
    assert_eq!(request.header("iLink-App-Id"), "bot");
    assert!(request.authorization.is_none());
    assert!(request.authorization_type.is_none());
    assert!(request.uin.is_none());
}

#[tokio::test]
async fn cdn_upload_encrypts_and_reads_the_download_param() {
    let (base, state) = spawn_mock().await;
    let plaintext = b"synthetic image bytes for the kubecode wire test".to_vec();
    let key: [u8; 16] = core::array::from_fn(|index| index as u8);
    let cdn =
        CdnClient::new(&base, OriginPolicy::testing(), Duration::from_secs(5)).expect("cdn client");

    // Fallback URL construction from upload_param (fixture body unused).
    let _ = fixture("getuploadurl.ok");
    mock(&state).set(
        "POST",
        CDN_UPLOAD_PATH,
        vec![
            MockResponse::bytes(200, Vec::new())
                .with_header("x-encrypted-param", "synthetic-download-param"),
        ],
    );
    let upload = cdn
        .upload(
            &plaintext,
            None,
            Some("synthetic-upload-param"),
            "synthetic-filekey",
            &key,
        )
        .await
        .expect("upload");
    assert_eq!(upload.file_size, plaintext.len());
    assert_eq!(
        upload.file_size_ciphertext,
        kubecode_server::ilink::crypto::aes_ecb_padded_size(plaintext.len())
    );
    assert_eq!(
        upload.download_encrypted_query_param,
        "synthetic-download-param"
    );
    assert_eq!(hex::encode(key), upload.aeskey_hex);
    let request = mock(&state)
        .requests()
        .into_iter()
        .find(|request| request.path == CDN_UPLOAD_PATH)
        .expect("recorded upload");
    assert_eq!(request.method, "POST");
    // The stored body is byte-identical AES-128-ECB ciphertext.
    let decrypted =
        kubecode_server::ilink::crypto::aes_ecb_decrypt(&key, &request.body).expect("decrypt");
    assert_eq!(decrypted, plaintext);

    // A server-provided full_url is used only when it passes the allowlist.
    let evil = cdn
        .upload(
            &plaintext,
            Some("http://evil.example.com/up"),
            None,
            "fk",
            &key,
        )
        .await
        .expect_err("evil full_url");
    assert!(matches!(evil, IlinkError::OriginRejected { .. }));
}

#[tokio::test]
async fn cdn_upload_retries_server_errors_but_not_client_errors() {
    let (base, state) = spawn_mock().await;
    let key: [u8; 16] = [7u8; 16];
    let cdn =
        CdnClient::new(&base, OriginPolicy::testing(), Duration::from_secs(5)).expect("cdn client");
    let plaintext = b"retry-me".to_vec();

    // Two server errors then success (bounded retry budget).
    mock(&state).set(
        "POST",
        CDN_UPLOAD_PATH,
        vec![
            MockResponse::bytes(500, b"transient".to_vec()),
            MockResponse::bytes(500, b"transient".to_vec()),
            MockResponse::bytes(200, Vec::new())
                .with_header("x-encrypted-param", "synthetic-download-param"),
        ],
    );
    let upload = cdn
        .upload(&plaintext, None, Some("p"), "fk", &key)
        .await
        .expect("retry succeeds");
    assert_eq!(
        upload.download_encrypted_query_param,
        "synthetic-download-param"
    );
    assert_eq!(mock(&state).count_for("POST", CDN_UPLOAD_PATH), 3);

    // A client error aborts on the first attempt.
    let before = mock(&state).count_for("POST", CDN_UPLOAD_PATH);
    mock(&state).set(
        "POST",
        CDN_UPLOAD_PATH,
        vec![MockResponse::bytes(403, b"denied".to_vec())],
    );
    let error = cdn
        .upload(&plaintext, None, Some("p"), "fk", &key)
        .await
        .expect_err("client error aborts");
    assert!(matches!(error, IlinkError::HttpStatus { status: 403, .. }));
    assert_eq!(
        mock(&state).count_for("POST", CDN_UPLOAD_PATH),
        before + 1,
        "4xx responses are never retried"
    );
}

#[tokio::test]
async fn cdn_download_decrypts_both_supported_key_encodings() {
    let (base, state) = spawn_mock().await;
    let key: [u8; 16] = core::array::from_fn(|index| (index * 7 + 3) as u8);
    let plaintext = b"voice note payload bytes".to_vec();
    let ciphertext = aes_ecb_encrypt(&key, &plaintext).expect("encrypt");
    mock(&state).set(
        "GET",
        CDN_DOWNLOAD_PATH,
        vec![MockResponse::bytes(200, ciphertext)],
    );

    // Encoding 1: base64 of the 16 raw bytes (images).
    let media_raw = CdnMedia {
        encrypt_query_param: Some("synthetic-encrypted-query".to_owned()),
        aes_key: Some(BASE64.encode(key)),
        encrypt_type: None,
        full_url: None,
    };
    // Encoding 2: base64 of the 32-char hex string (file/voice/video).
    let media_hex = CdnMedia {
        encrypt_query_param: Some("synthetic-encrypted-query".to_owned()),
        aes_key: Some(BASE64.encode(hex::encode(key))),
        encrypt_type: None,
        full_url: None,
    };
    let cdn =
        CdnClient::new(&base, OriginPolicy::testing(), Duration::from_secs(5)).expect("cdn client");
    assert_eq!(
        cdn.download_and_decrypt(&media_raw).await.expect("raw key"),
        plaintext
    );
    assert_eq!(
        cdn.download_and_decrypt(&media_hex).await.expect("hex key"),
        plaintext
    );
    assert_eq!(mock(&state).count_for("GET", CDN_DOWNLOAD_PATH), 2);
}

#[tokio::test]
async fn production_policy_rejects_fixture_hosts_before_network_access() {
    let (base, state) = spawn_mock().await;
    mock(&state).fixture("POST", SENDMESSAGE_PATH, "sendmessage.ok");
    // A production client can never target the loopback mock: the base is
    // rejected at construction, before a socket is opened.
    assert!(
        IlinkClient::new(
            &base,
            &base,
            OriginPolicy::production(),
            CHANNEL_VERSION,
            BOT_AGENT
        )
        .is_err(),
        "construction rejects loopback api base"
    );
    assert!(
        CdnClient::new(&base, OriginPolicy::production(), Duration::from_secs(5)).is_err(),
        "construction rejects loopback cdn base"
    );
    assert_eq!(mock(&state).requests().len(), 0);

    // A production-allowlisted base still rejects off-allowlist upstream
    // full_urls before network access.
    let client = IlinkClient::new(
        "https://ilinkai.weixin.qq.com",
        "https://szextshort.wechat.com",
        OriginPolicy::production(),
        CHANNEL_VERSION,
        BOT_AGENT,
    )
    .expect("production client");
    let evil_media = CdnMedia {
        encrypt_query_param: Some("q".to_owned()),
        aes_key: None,
        encrypt_type: None,
        full_url: Some("https://evil.example.com/download?sig=1".to_owned()),
    };
    let error = client
        .validate_cdn_media(&evil_media)
        .expect_err("evil cdn host");
    assert!(matches!(error, IlinkError::OriginRejected { .. }));
    assert_eq!(mock(&state).requests().len(), 0);
}
