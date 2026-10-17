//! A deterministic, loopback-only fake of the Tencent iLink HTTP API and
//! encrypted CDN (#136). It needs no real WeChat credentials or network:
//! QR login walks a scripted state list (with verification-code checking),
//! `getupdates` serves scripted pages, transient HTTP failures, and session
//! expiry, honours long-poll hold times, and echoes the caller's cursor when
//! idle; sends, typing, config, notify, upload, and download are recorded so
//! tests can assert the exact wire traffic. All identifiers are synthetic.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::response::Response;
use serde_json::{Value, json};

pub const BOT_TOKEN: &str = "synthetic-bot-token-000000000001";
pub const BOT_ID: &str = "ilink_bot_synthetic_01";
pub const SCANNER: &str = "wxid_synthetic_scanner";
pub const QR_ID: &str = "synthetic-qr-id-7f3a";

/// One scripted `getupdates` response.
#[derive(Clone)]
pub enum Updates {
    Page {
        msgs: Vec<Value>,
        buf: String,
        timeout_ms: Option<i64>,
    },
    HttpError(u16),
    Expired,
}

/// One recorded request.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub path: String,
    pub body: Value,
}

#[derive(Default)]
pub struct FakeState {
    pub requests: Mutex<Vec<Recorded>>,
    qr_states: Mutex<VecDeque<&'static str>>,
    verify_code: Mutex<Option<String>>,
    updates: Mutex<VecDeque<Updates>>,
    /// download param → ciphertext
    blobs: Mutex<HashMap<String, Vec<u8>>>,
    idle_hold_ms: AtomicU64,
}

pub struct FakeIlink {
    pub base: String,
    pub state: Arc<FakeState>,
}

impl FakeIlink {
    pub async fn start() -> Self {
        let state = Arc::new(FakeState::default());
        state.idle_hold_ms.store(100, Ordering::SeqCst);
        let app = Router::new()
            .fallback(handle)
            .with_state(Arc::clone(&state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { base, state }
    }

    /// QR status sequence; the last state repeats. `need_verifycode` turns
    /// into `confirmed` once the expected code is submitted.
    pub fn script_login(&self, states: &[&'static str], verify_code: Option<&str>) {
        *self.state.qr_states.lock().unwrap() = states.iter().copied().collect();
        *self.state.verify_code.lock().unwrap() = verify_code.map(str::to_owned);
    }

    pub fn push_updates(&self, updates: Updates) {
        self.state.updates.lock().unwrap().push_back(updates);
    }

    /// How long an idle `getupdates` holds before answering empty.
    pub fn set_idle_hold(&self, duration: Duration) {
        self.state
            .idle_hold_ms
            .store(duration.as_millis() as u64, Ordering::SeqCst);
    }

    /// Serves `ciphertext` for downloads of `param`.
    pub fn serve_blob(&self, param: &str, ciphertext: Vec<u8>) {
        self.state
            .blobs
            .lock()
            .unwrap()
            .insert(param.to_owned(), ciphertext);
    }

    pub fn requests(&self, path: &str) -> Vec<Recorded> {
        self.state
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.path == path)
            .cloned()
            .collect()
    }

    /// Every outbound message body (`sendmessage.msg`), in order.
    pub fn sent_messages(&self) -> Vec<Value> {
        self.requests("/ilink/bot/sendmessage")
            .into_iter()
            .map(|request| request.body["msg"].clone())
            .collect()
    }

    /// Text of every outbound text message to `peer`, in order.
    pub fn texts_to(&self, peer: &str) -> Vec<String> {
        self.sent_messages()
            .into_iter()
            .filter(|message| message["to_user_id"] == peer)
            .filter_map(|message| {
                message["item_list"][0]["text_item"]["text"]
                    .as_str()
                    .map(str::to_owned)
            })
            .collect()
    }

    /// Typing statuses sent (1 = typing, 2 = cancel), in order.
    pub fn typing(&self) -> Vec<i64> {
        self.requests("/ilink/bot/sendtyping")
            .into_iter()
            .filter_map(|request| request.body["status"].as_i64())
            .collect()
    }
}

/// A user text message as `getupdates` delivers it.
pub fn user_text(peer: &str, sequence: i64, text: &str, context_token: &str) -> Value {
    json!({
        "seq": sequence,
        "message_id": sequence,
        "from_user_id": peer,
        "to_user_id": BOT_ID,
        "create_time_ms": 1_750_000_000_000i64 + sequence,
        "message_type": 1,
        "message_state": 2,
        "item_list": [{"type": 1, "text_item": {"text": text}}],
        "context_token": context_token,
    })
}

/// A user image message referencing CDN `param` with `aes_key_b64`.
pub fn user_image(
    peer: &str,
    sequence: i64,
    param: &str,
    aes_key_b64: &str,
    context_token: &str,
) -> Value {
    json!({
        "seq": sequence,
        "message_id": sequence,
        "from_user_id": peer,
        "to_user_id": BOT_ID,
        "create_time_ms": 1_750_000_000_000i64 + sequence,
        "message_type": 1,
        "message_state": 2,
        "item_list": [{"type": 2, "image_item": {"media": {
            "encrypt_query_param": param,
            "aes_key": aes_key_b64,
        }}}],
        "context_token": context_token,
    })
}

fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
}

fn json_response(body: Value) -> Response {
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

async fn handle(State(state): State<Arc<FakeState>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 64 << 20)
        .await
        .unwrap_or_default();
    let path = parts.uri.path().to_owned();
    let query = parts.uri.query().unwrap_or_default().to_owned();
    let json_body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    state.requests.lock().unwrap().push(Recorded {
        path: path.clone(),
        body: json_body.clone(),
    });
    match path.as_str() {
        "/ilink/bot/get_bot_qrcode" => json_response(json!({
            "qrcode": QR_ID,
            "qrcode_img_content": "https://liteapp.weixin.qq.com/q/synthetic-login-target",
        })),
        "/ilink/bot/get_qrcode_status" => {
            let current = {
                let mut states = state.qr_states.lock().unwrap();
                if states.len() > 1 {
                    states.pop_front().unwrap_or("wait")
                } else {
                    states.front().copied().unwrap_or("wait")
                }
            };
            let expected = state.verify_code.lock().unwrap().clone();
            let submitted = query_value(&query, "verify_code").map(str::to_owned);
            let confirmed = current == "confirmed"
                || (current == "need_verifycode" && expected.is_some() && submitted == expected);
            if confirmed {
                json_response(json!({
                    "status": "confirmed",
                    "bot_token": BOT_TOKEN,
                    "ilink_bot_id": BOT_ID,
                    "ilink_user_id": SCANNER,
                }))
            } else {
                json_response(json!({ "status": current }))
            }
        }
        "/ilink/bot/getupdates" => {
            let next = state.updates.lock().unwrap().pop_front();
            match next {
                Some(Updates::Page {
                    msgs,
                    buf,
                    timeout_ms,
                }) => json_response(json!({
                    "ret": 0,
                    "msgs": msgs,
                    "get_updates_buf": buf,
                    "longpolling_timeout_ms": timeout_ms,
                })),
                Some(Updates::HttpError(status)) => Response::builder()
                    .status(status)
                    .body(axum::body::Body::empty())
                    .unwrap(),
                Some(Updates::Expired) => {
                    json_response(json!({ "ret": 0, "errcode": -14, "errmsg": "session timeout" }))
                }
                None => {
                    let hold = state.idle_hold_ms.load(Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(hold)).await;
                    json_response(json!({
                        "ret": 0,
                        "msgs": [],
                        "get_updates_buf": json_body["get_updates_buf"].clone(),
                    }))
                }
            }
        }
        "/ilink/bot/getconfig" => {
            json_response(json!({ "ret": 0, "typing_ticket": "synthetic-typing-ticket" }))
        }
        "/ilink/bot/getuploadurl" => {
            let filekey = json_body["filekey"]
                .as_str()
                .unwrap_or("filekey")
                .to_owned();
            json_response(json!({ "upload_param": format!("up-{filekey}") }))
        }
        "/upload" => {
            let filekey = query_value(&query, "filekey")
                .unwrap_or("filekey")
                .to_owned();
            let param = format!("dl-{filekey}");
            state
                .blobs
                .lock()
                .unwrap()
                .insert(param.clone(), bytes.to_vec());
            Response::builder()
                .status(200)
                .header("x-encrypted-param", param)
                .body(axum::body::Body::empty())
                .unwrap()
        }
        "/download" => {
            let param = query_value(&query, "encrypted_query_param").unwrap_or_default();
            match state.blobs.lock().unwrap().get(param) {
                Some(bytes) => Response::builder()
                    .status(200)
                    .body(axum::body::Body::from(bytes.clone()))
                    .unwrap(),
                None => Response::builder()
                    .status(404)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            }
        }
        _ => json_response(json!({ "ret": 0 })),
    }
}
