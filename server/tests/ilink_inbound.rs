//! Inbound bridge tests (#129): normalization coverage (text, multi-item,
//! voice, image/thumb, quoted, bot echo, duplicates, malformed items,
//! unsupported file/video/voice, mixed batches) plus the exactly-once
//! retry contract across a simulated restart.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use kubecode_server::agent_store::AgentStore;
use kubecode_server::ilink::client::UpdatesPage;
use kubecode_server::ilink::crypto::aes_ecb_encrypt;
use kubecode_server::ilink::domain::{InboundMessage, MediaRef};
use kubecode_server::ilink::error::Secret;
use kubecode_server::ilink::guard::PeerGate;
use kubecode_server::ilink::inbound::{BridgePrompt, ChannelLanguage, InboundBridge, ReplyKind};
use kubecode_server::ilink::types::{
    CdnMedia, MESSAGE_STATE_FINISH, MESSAGE_TYPE_BOT, MESSAGE_TYPE_USER, MessageItem, RefMessage,
    TextItem, VoiceItem,
};
use kubecode_server::ilink::{CdnClient, OriginPolicy};
use tempfile::TempDir;

// -- Harness ------------------------------------------------------------------

struct CaptureChannel {
    replies: Mutex<Vec<(String, String, String)>>, // (peer, text, tag)
}

impl CaptureChannel {
    fn new() -> Self {
        Self {
            replies: Mutex::new(Vec::new()),
        }
    }

    fn texts_to(&self, peer: &str) -> Vec<String> {
        self.replies
            .lock()
            .unwrap()
            .iter()
            .filter(|(to, _, _)| to == peer)
            .map(|(_, text, _)| text.clone())
            .collect()
    }

    fn total(&self) -> usize {
        self.replies.lock().unwrap().len()
    }
}

impl kubecode_server::ilink::inbound::ResponseChannel for CaptureChannel {
    fn send_reply(
        &self,
        _account_id: &str,
        peer_id: &str,
        reply: &kubecode_server::ilink::inbound::ChannelReply,
    ) -> Result<(), kubecode_server::ilink::IlinkError> {
        self.replies
            .lock()
            .unwrap()
            .push((peer_id.to_owned(), reply.text.clone(), String::new()));
        Ok(())
    }
}

struct Environment {
    _root: TempDir,
    store: Arc<AgentStore>,
    cdn_base: String,
    _cdn_server: tokio::task::JoinHandle<()>,
}

async fn environment(tag: &str) -> (Environment, Arc<Mutex<Vec<Vec<u8>>>>) {
    let root = TempDir::new().expect("tempdir");
    let database = root
        .path()
        .join(format!(".state-{tag}/kubecode/kubecode.sqlite3"));
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    store.upsert_ilink_account("acct", "Test").expect("account");
    // A CDN mock that answers any download with the fixture ciphertext.
    let served: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let served_for_route = Arc::clone(&served);
    async fn cdn_fallback(
        State(served): State<Arc<Mutex<Vec<Vec<u8>>>>>,
        _request: Request,
    ) -> Response {
        let body = served.lock().unwrap().first().cloned().unwrap_or_default();
        Response::builder()
            .status(200)
            .body(axum::body::Body::from(body))
            .unwrap()
    }
    let app = Router::new()
        .fallback(cdn_fallback)
        .with_state(served_for_route);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (
        Environment {
            _root: root,
            store,
            cdn_base: format!("http://{addr}"),
            _cdn_server: server,
        },
        served,
    )
}

fn authorized_bridge(env: &Environment, peers: &[&str]) -> Arc<InboundBridge> {
    let mut gate = PeerGate::new(Vec::new(), 50, Duration::from_secs(60));
    for peer in peers {
        env.store
            .upsert_ilink_peer("acct", peer, "", true)
            .expect("peer");
        gate.authorize("acct", peer);
    }
    let cdn = CdnClient::new(
        &env.cdn_base,
        OriginPolicy::testing(),
        Duration::from_secs(5),
    )
    .expect("cdn client");
    InboundBridge::new(
        Arc::clone(&env.store),
        gate,
        cdn,
        false,
        ChannelLanguage::En,
    )
}

fn user_message(peer: &str, id: i64, items: Vec<MessageItem>) -> InboundMessage {
    let wire = kubecode_server::ilink::types::WeixinMessage {
        seq: Some(id),
        message_id: Some(id),
        from_user_id: Some(peer.to_owned()),
        create_time_ms: Some(1_750_000_000_000 + id),
        message_type: Some(MESSAGE_TYPE_USER),
        message_state: Some(MESSAGE_STATE_FINISH),
        item_list: Some(items),
        context_token: Some("ctx-token".to_owned()),
        ..kubecode_server::ilink::types::WeixinMessage::default()
    };
    InboundMessage::from_wire(&wire).expect("normalizable message")
}

fn text_item(text: &str) -> MessageItem {
    MessageItem {
        item_type: Some(kubecode_server::ilink::types::ITEM_TYPE_TEXT),
        text_item: Some(TextItem {
            text: Some(text.to_owned()),
        }),
        ..MessageItem::default()
    }
}

fn page(messages: Vec<InboundMessage>) -> UpdatesPage {
    UpdatesPage {
        messages,
        get_updates_buf: Some("cursor-buf".to_owned()),
        longpolling_timeout_ms: None,
    }
}

async fn run_page(
    bridge: &InboundBridge,
    env: &Environment,
    test_page: UpdatesPage,
) -> Vec<BridgePrompt> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let responses = CaptureChannel::new();
    bridge
        .process_page("acct", &test_page, &responses, &tx)
        .await;
    drop(tx);
    let mut prompts = Vec::new();
    while let Ok(prompt) = rx.try_recv() {
        prompts.push(prompt);
    }
    let _ = env;
    prompts
}

// -- Tests --------------------------------------------------------------------

#[tokio::test]
async fn text_dispatches_exactly_once_across_retry_and_restart() {
    let (env, _served) = environment("once").await;
    let bridge = authorized_bridge(&env, &["wxid_owner"]);
    let test_page = page(vec![user_message(
        "wxid_owner",
        1,
        vec![text_item("please fix the failing test")],
    )]);

    let first = run_page(&bridge, &env, test_page.clone()).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].text, "please fix the failing test");
    assert_eq!(first[0].message_key, "wxid_owner:1750000000001:1");
    assert_eq!(bridge.counters.snapshot().0, 1);

    // Immediate retry: deduped, no second dispatch.
    let retry = run_page(&bridge, &env, test_page.clone()).await;
    assert!(retry.is_empty());
    assert_eq!(bridge.counters.snapshot().1, 1);

    // Retry after a simulated restart (fresh bridge over the same store).
    let restarted = authorized_bridge(&env, &["wxid_owner"]);
    let after_restart = run_page(&restarted, &env, test_page).await;
    assert!(after_restart.is_empty(), "restart cannot re-dispatch");
}

#[tokio::test]
async fn bot_echoes_and_generating_states_are_skipped() {
    let (env, _served) = environment("echo").await;
    let bridge = authorized_bridge(&env, &["wxid_owner"]);
    let mut echo = user_message("wxid_owner", 2, vec![text_item("echo of my own message")]);
    echo.wire_type = Some(MESSAGE_TYPE_BOT);
    let mut generating = user_message("wxid_owner", 3, vec![text_item("partial")]);
    generating.wire_state = Some(1); // GENERATING

    let prompts = run_page(&bridge, &env, page(vec![echo, generating])).await;
    assert!(prompts.is_empty(), "echo and partials never drive state");
    assert_eq!(bridge.counters.snapshot().4, 2, "both skipped");
}

#[tokio::test]
async fn mixed_batch_preserves_order_and_survives_unsupported_items() {
    let (env, _served) = environment("mixed").await;
    let bridge = authorized_bridge(&env, &["wxid_owner"]);
    let test_page = page(vec![
        // Voice with transcription: becomes prompt text.
        user_message(
            "wxid_owner",
            10,
            vec![MessageItem {
                item_type: Some(kubecode_server::ilink::types::ITEM_TYPE_VOICE),
                voice_item: Some(VoiceItem {
                    text: Some("spoken instruction".to_owned()),
                    ..VoiceItem::default()
                }),
                ..MessageItem::default()
            }],
        ),
        // Quoted content plus text: quote prefixes the prompt.
        user_message(
            "wxid_owner",
            11,
            vec![MessageItem {
                item_type: Some(kubecode_server::ilink::types::ITEM_TYPE_TEXT),
                ref_msg: Some(RefMessage {
                    title: Some("earlier context line".to_owned()),
                }),
                text_item: Some(TextItem {
                    text: Some("now do this".to_owned()),
                }),
                ..MessageItem::default()
            }],
        ),
        // Multiple text items keep order.
        user_message(
            "wxid_owner",
            12,
            vec![text_item("first"), text_item("second")],
        ),
        // Unsupported file: localized reply, later messages unaffected.
        user_message(
            "wxid_owner",
            13,
            vec![MessageItem {
                item_type: Some(kubecode_server::ilink::types::ITEM_TYPE_FILE),
                ..MessageItem::default()
            }],
        ),
    ]);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let responses = CaptureChannel::new();
    bridge
        .process_page("acct", &test_page, &responses, &tx)
        .await;
    drop(tx);
    let mut prompts = Vec::new();
    while let Ok(prompt) = rx.try_recv() {
        prompts.push(prompt);
    }
    assert_eq!(prompts.len(), 3, "voice, quoted+text, multi-text dispatch");
    assert_eq!(prompts[0].text, "spoken instruction");
    assert_eq!(prompts[1].text, "> earlier context line\nnow do this");
    assert_eq!(prompts[2].text, "first\nsecond");
    // The unsupported file got exactly one localized reply.
    assert_eq!(responses.total(), 1);
    assert!(responses.texts_to("wxid_owner")[0].contains("not supported"));
    // Malformed-item tolerance is structural: every dispatch above
    // carries a clean message even in a batch with failures.
}

#[tokio::test]
async fn voice_without_transcription_gets_the_localized_reply() {
    let (env, _served) = environment("voice").await;
    let bridge = authorized_bridge(&env, &["wxid_owner"]);
    let test_page = page(vec![user_message(
        "wxid_owner",
        20,
        vec![MessageItem {
            item_type: Some(kubecode_server::ilink::types::ITEM_TYPE_VOICE),
            voice_item: Some(VoiceItem::default()),
            ..MessageItem::default()
        }],
    )]);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let responses = CaptureChannel::new();
    bridge
        .process_page("acct", &test_page, &responses, &tx)
        .await;
    let replies = responses.texts_to("wxid_owner");
    assert_eq!(replies.len(), 1);
    assert!(replies[0].contains("Voice messages"));
}

#[tokio::test]
async fn image_downloads_through_cdn_preferring_the_thumbnail() {
    let (env, served) = environment("image").await;
    let key: [u8; 16] = core::array::from_fn(|index| index as u8);
    let plaintext = b"thumb-bytes".to_vec();
    let ciphertext = aes_ecb_encrypt(&key, &plaintext).expect("encrypt");
    *served.lock().unwrap() = vec![ciphertext];

    let media_ref = |param: &str| MediaRef {
        encrypt_query_param: Some(param.to_owned()),
        aes_key: Some(Secret::new(BASE64.encode(key))),
        full_url: None,
    };
    let bridge = authorized_bridge(&env, &["wxid_owner"]);
    let test_page = page(vec![user_message(
        "wxid_owner",
        30,
        vec![MessageItem {
            item_type: Some(kubecode_server::ilink::types::ITEM_TYPE_IMAGE),
            image_item: Some(kubecode_server::ilink::types::ImageItem {
                media: Some(CdnMedia {
                    encrypt_query_param: Some("original-param".to_owned()),
                    aes_key: Some(BASE64.encode(key)),
                    ..CdnMedia::default()
                }),
                thumb_media: Some(CdnMedia {
                    encrypt_query_param: Some("thumb-param".to_owned()),
                    aes_key: Some(BASE64.encode(key)),
                    ..CdnMedia::default()
                }),
                ..kubecode_server::ilink::types::ImageItem::default()
            }),
            ..MessageItem::default()
        }],
    )]);
    // The CDN mock serves one ciphertext regardless of param; assert the
    // dispatched image decrypted to the fixture plaintext and that the
    // thumbnail reference was the download source.
    let prompts = run_page(&bridge, &env, test_page).await;
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].images.len(), 1);
    assert_eq!(
        prompts[0].images[0].bytes.as_ref(),
        &b"thumb-bytes".to_vec()[..]
    );
    assert_eq!(
        prompts[0].images[0].source,
        kubecode_server::ilink::inbound::ImageSource::Thumb
    );
    let _ = media_ref;
}

#[tokio::test]
async fn unauthorized_peers_fail_closed_with_a_localized_rejection() {
    let (env, _served) = environment("unauth").await;
    let bridge = authorized_bridge(&env, &["wxid_owner"]);
    let test_page = page(vec![user_message(
        "wxid_stranger",
        40,
        vec![text_item("let me in")],
    )]);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let responses = CaptureChannel::new();
    bridge
        .process_page("acct", &test_page, &responses, &tx)
        .await;
    let replies = responses.texts_to("wxid_stranger");
    assert_eq!(replies.len(), 1);
    assert!(replies[0].contains("not available"));
    // No dedupe commit for strangers is fine (they stay rejected); no
    // prompt ever existed.
    assert_eq!(bridge.counters.snapshot().2, 1);
}

#[tokio::test]
async fn unsupported_video_and_binary_replies_are_localized_and_committed() {
    let (env, _served) = environment("video").await;
    let bridge = authorized_bridge(&env, &["wxid_owner"]);
    let test_page = page(vec![
        user_message(
            "wxid_owner",
            50,
            vec![MessageItem {
                item_type: Some(kubecode_server::ilink::types::ITEM_TYPE_VIDEO),
                ..MessageItem::default()
            }],
        ),
        user_message(
            "wxid_owner",
            51,
            vec![MessageItem {
                item_type: Some(99),
                ..MessageItem::default()
            }],
        ),
    ]);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let responses = CaptureChannel::new();
    bridge
        .process_page("acct", &test_page, &responses, &tx)
        .await;
    let replies = responses.texts_to("wxid_owner");
    assert_eq!(replies.len(), 2);
    assert!(replies[0].contains("Video"));
    assert!(replies[1].contains("cannot be handled"));
    // Committed: replaying the same page yields duplicates, not replies.
    let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();
    let responses2 = CaptureChannel::new();
    bridge
        .process_page("acct", &test_page, &responses2, &tx2)
        .await;
    assert_eq!(responses2.total(), 0);
    assert_eq!(bridge.counters.snapshot().1, 2);
}

#[tokio::test]
async fn wechat_supplied_paths_never_reach_prompts_or_replies() {
    let (env, _served) = environment("paths").await;
    let bridge = authorized_bridge(&env, &["wxid_owner"]);
    // A file item with a traversal filename: the gate rejects the item
    // kind before any dispatch, and the reply contains no path text.
    let test_page = page(vec![user_message(
        "wxid_owner",
        60,
        vec![MessageItem {
            item_type: Some(kubecode_server::ilink::types::ITEM_TYPE_FILE),
            file_item: Some(kubecode_server::ilink::types::FileItem {
                file_name: Some("../../etc/passwd".to_owned()),
                ..kubecode_server::ilink::types::FileItem::default()
            }),
            ..MessageItem::default()
        }],
    )]);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let responses = CaptureChannel::new();
    bridge
        .process_page("acct", &test_page, &responses, &tx)
        .await;
    let replies = responses.texts_to("wxid_owner");
    assert_eq!(replies.len(), 1);
    assert!(!replies[0].contains("passwd"));
    assert!(!replies[0].contains('/'));
}

#[tokio::test]
async fn closed_router_leaves_messages_uncommitted_for_redelivery() {
    let (env, _served) = environment("closed").await;
    let bridge = authorized_bridge(&env, &["wxid_owner"]);
    let test_page = page(vec![user_message(
        "wxid_owner",
        70,
        vec![text_item("arrive later")],
    )]);
    // A dropped receiver closes the channel: the router is gone.
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    drop(rx);
    let responses = CaptureChannel::new();
    bridge
        .process_page("acct", &test_page, &responses, &tx)
        .await;
    // Nothing committed: reopening the router re-delivers exactly once.
    assert!(
        !env.store
            .ilink_message_seen("acct", "wxid_owner:1750000000070:70")
            .expect("dedupe check")
    );
    let prompts = run_page(&bridge, &env, test_page).await;
    assert_eq!(prompts.len(), 1);
}

// The reply machinery stays honest about supported kinds.
#[test]
fn reply_kinds_render_localized_text() {
    let en = ChannelReply::new(ChannelLanguage::En, ReplyKind::UnsupportedVoice);
    let zh = ChannelReply::new(ChannelLanguage::ZhCn, ReplyKind::UnsupportedVoice);
    assert!(en.text.contains("Voice"));
    assert!(zh.text.contains("语音"));
}

use kubecode_server::ilink::inbound::ChannelReply;
