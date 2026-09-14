//! Inbound WeChat bridge (issue #129): turns authorized `getupdates`
//! pages into bounded, typed dispatches while preserving cursor/dedupe
//! correctness. Bot echoes and generating states are ignored without
//! poisoning the batch; every admitted message commits its dedupe key
//! through the #126 store contract only after its dispatch (or its
//! localized unsupported response) is accepted, so a retry before or
//! after restart re-delivers at most once.
//!
//! Safe-by-construction surfaces: dispatches carry user content and
//! inline image bytes only — never upstream paths, URLs, or raw
//! payloads; rejections and counters are content-free.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::agent_store::{AgentStore, IlinkPeer};

use super::cdn::{CdnClient, MAX_MEDIA_BYTES};
use super::client::{API_TIMEOUT, UpdatesPage};
use super::domain::{InboundItem, InboundMessage, MediaRef};
use super::error::Secret;
use super::guard::{PeerGate, Rejection};
use super::types::{CdnMedia, MESSAGE_STATE_FINISH, MESSAGE_STATE_NEW, MESSAGE_TYPE_USER};

/// Channel-facing reply strings, localized per the channel language
/// (first release: en + zh-CN; the Runtime l10n list is broader but
/// WeChat peers are configured per channel, not per browser locale).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelLanguage {
    En,
    ZhCn,
}

impl ChannelLanguage {
    fn pick(self, en: &'static str, zh: &'static str) -> &'static str {
        match self {
            Self::En => en,
            Self::ZhCn => zh,
        }
    }
}

/// One localized channel reply.
#[derive(Clone, Debug)]
pub struct ChannelReply {
    pub text: String,
}

impl ChannelReply {
    pub fn new(language: ChannelLanguage, kind: ReplyKind) -> Self {
        let text = match kind {
            ReplyKind::Unauthorized => language.pick(
                "This Kubecode channel is not available for your account.",
                "此 Kubecode 通道未对你的微信开放。",
            ),
            ReplyKind::UnsupportedVoice => language.pick(
                "Voice messages without transcription are not supported yet.",
                "暂不支持没有转写文本的语音消息。",
            ),
            ReplyKind::UnsupportedFile => {
                language.pick("File messages are not supported yet.", "暂不支持文件消息。")
            }
            ReplyKind::UnsupportedVideo => language.pick(
                "Video messages are not supported yet.",
                "暂不支持视频消息。",
            ),
            ReplyKind::UnsupportedBinary => language.pick(
                "This content type cannot be handled here.",
                "该内容类型暂无法在此处理。",
            ),
            ReplyKind::MediaFailed => language.pick(
                "The attached media could not be loaded.",
                "附带媒体加载失败。",
            ),
            ReplyKind::RateLimited { .. } => language.pick(
                "Too many messages — please wait a moment.",
                "消息太频繁，请稍后再试。",
            ),
        };
        Self {
            text: text.to_owned(),
        }
    }
}

/// The reply categories the bridge can emit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplyKind {
    Unauthorized,
    UnsupportedVoice,
    UnsupportedFile,
    UnsupportedVideo,
    UnsupportedBinary,
    MediaFailed,
    RateLimited { seconds: u64 },
}

/// Object-safe output surface for localized replies (implemented by the
/// Phase 3 outbound bridge; tests capture replies directly).
pub trait ResponseChannel: Send + Sync {
    fn send_reply(
        &self,
        account_id: &str,
        peer_id: &str,
        reply: &ChannelReply,
    ) -> Result<(), super::error::IlinkError>;
}

/// A normalized prompt ready for Session routing (#130).
#[derive(Clone, Debug)]
pub struct BridgePrompt {
    pub account_id: String,
    pub peer_id: String,
    /// Stable upstream identity — becomes the run `client_message_id`.
    pub message_key: String,
    /// Joined text (plain text plus quoted excerpts), possibly empty when
    /// the prompt is image-only.
    pub text: String,
    /// Inline, bounded image payloads for run admission blocks.
    pub images: Vec<BridgeImage>,
}

/// One inline image payload (already decrypted, bounded).
#[derive(Clone, Debug)]
pub struct BridgeImage {
    pub mime: String,
    pub bytes: Arc<[u8]>,
    pub source: ImageSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageSource {
    /// Thumbnail preferred by default (ADR-safe mobile context).
    Thumb,
    /// Original, only through the explicit server setting.
    Original,
}

/// Safe operational counters — never carry content.
#[derive(Debug, Default)]
pub struct InboundCounters {
    pub processed: AtomicU64,
    pub duplicates: AtomicU64,
    pub rejected: AtomicU64,
    pub unsupported: AtomicU64,
    pub skipped: AtomicU64,
    pub media_bytes: AtomicU64,
}

impl InboundCounters {
    pub fn snapshot(&self) -> (u64, u64, u64, u64, u64, u64) {
        (
            self.processed.load(Ordering::Relaxed),
            self.duplicates.load(Ordering::Relaxed),
            self.rejected.load(Ordering::Relaxed),
            self.unsupported.load(Ordering::Relaxed),
            self.skipped.load(Ordering::Relaxed),
            self.media_bytes.load(Ordering::Relaxed),
        )
    }
}

/// What the bridge decided for one inbound message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Disposition {
    /// Forwarded to the Session router.
    Prompted,
    /// A localized unsupported reply was emitted.
    Unsupported(&'static str),
    /// An unauthorized or rate-limited sender was refused.
    Rejected(&'static str),
    /// Already committed upstream of admission.
    Duplicate,
    /// Bot echo, generating state, or unusable record: ignored.
    Skipped,
}

pub struct InboundBridge {
    store: Arc<AgentStore>,
    gate: std::sync::Mutex<PeerGate>,
    cdn: CdnClient,
    prefer_original_images: bool,
    language: ChannelLanguage,
    download_timeout: Duration,
    pub counters: InboundCounters,
}

impl InboundBridge {
    pub fn new(
        store: Arc<AgentStore>,
        gate: PeerGate,
        cdn: CdnClient,
        prefer_original_images: bool,
        language: ChannelLanguage,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            gate: std::sync::Mutex::new(gate),
            cdn,
            prefer_original_images,
            language,
            download_timeout: Duration::from_secs(30),
            counters: InboundCounters::default(),
        })
    }

    /// Refreshes the authorized peer set from the durable store.
    pub fn sync_authorized_peers(&self, account_id: &str) {
        let peers: Vec<IlinkPeer> = self
            .store
            .ilink_peers(account_id)
            .unwrap_or_default()
            .into_iter()
            .filter(|peer| peer.authorized)
            .collect();
        let mut gate = self.gate.lock().expect("peer gate poisoned");
        for peer in peers {
            gate.authorize(account_id, &peer.peer_id);
        }
    }

    /// Processes one long-poll page in order. `prompts` is the Session
    /// router's inbox (#130); a closed router leaves the message
    /// uncommitted so the next poll re-delivers it.
    pub async fn process_page(
        &self,
        account_id: &str,
        page: &UpdatesPage,
        responses: &dyn ResponseChannel,
        prompts: &mpsc::UnboundedSender<BridgePrompt>,
    ) {
        self.sync_authorized_peers(account_id);
        for message in &page.messages {
            let disposition = self
                .process_message(
                    account_id,
                    message,
                    responses,
                    prompts,
                    &page.get_updates_buf,
                )
                .await;
            match disposition {
                Disposition::Prompted => self.counters.processed.fetch_add(1, Ordering::Relaxed),
                Disposition::Duplicate => self.counters.duplicates.fetch_add(1, Ordering::Relaxed),
                Disposition::Rejected(_) => self.counters.rejected.fetch_add(1, Ordering::Relaxed),
                Disposition::Unsupported(_) => {
                    self.counters.unsupported.fetch_add(1, Ordering::Relaxed)
                }
                Disposition::Skipped => self.counters.skipped.fetch_add(1, Ordering::Relaxed),
            };
        }
    }

    async fn process_message(
        &self,
        account_id: &str,
        message: &InboundMessage,
        responses: &dyn ResponseChannel,
        prompts: &mpsc::UnboundedSender<BridgePrompt>,
        page_buf: &Option<String>,
    ) -> Disposition {
        // Only user-originated, complete messages drive state.
        if !self.is_processable(message) {
            return Disposition::Skipped;
        }
        // Authorization and bounds first — strangers never trigger work.
        let admission = {
            let mut gate = self.gate.lock().expect("peer gate poisoned");
            gate.admit(account_id, message)
        };
        if let Err(rejection) = admission {
            if matches!(rejection, Rejection::UnauthorizedPeer) {
                self.reply(
                    account_id,
                    &message.peer_id,
                    responses,
                    ReplyKind::Unauthorized,
                );
                return Disposition::Rejected("unauthorized");
            }
            if let Rejection::RateLimited { retry_after_ms } = rejection {
                self.reply(
                    account_id,
                    &message.peer_id,
                    responses,
                    ReplyKind::RateLimited {
                        seconds: retry_after_ms / 1000,
                    },
                );
                // Rate-limited messages are NOT committed: the sender may
                // retry the same content once the window opens.
                return Disposition::Rejected("rate_limited");
            }
            self.reply(
                account_id,
                &message.peer_id,
                responses,
                ReplyKind::UnsupportedBinary,
            );
            return Disposition::Rejected("bounds");
        }
        // Duplicate upstream identity: at most one dispatch ever.
        match self
            .store
            .ilink_message_seen(account_id, &message.message_key)
        {
            Ok(true) => return Disposition::Duplicate,
            Ok(false) => {}
            Err(_) => return Disposition::Skipped,
        }
        // Normalize content into prompt material.
        let mut text_parts: Vec<String> = Vec::new();
        let mut images: Vec<BridgeImage> = Vec::new();
        let mut unsupported: Option<ReplyKind> = None;
        for item in &message.items {
            match item {
                InboundItem::Text { text } => text_parts.push(text.clone()),
                InboundItem::QuotedText { text } => {
                    text_parts.push(format!("> {text}"));
                }
                InboundItem::Voice { transcription } => match transcription {
                    Some(text) => text_parts.push(text.clone()),
                    None => unsupported = Some(ReplyKind::UnsupportedVoice),
                },
                InboundItem::Image { media, thumb } => {
                    // Thumbnails are the default Agent image context;
                    // originals require the explicit server setting.
                    let chosen = if self.prefer_original_images {
                        media
                    } else {
                        thumb.as_ref().unwrap_or(media)
                    };
                    let source = if self.prefer_original_images
                        || thumb.is_none()
                        || std::ptr::eq(chosen, media)
                    {
                        ImageSource::Original
                    } else {
                        ImageSource::Thumb
                    };
                    match self.fetch_image(chosen).await {
                        Some(mut image) => {
                            image.source = source;
                            images.push(image);
                        }
                        None => unsupported = Some(ReplyKind::MediaFailed),
                    }
                }
                InboundItem::File { .. } => unsupported = Some(ReplyKind::UnsupportedFile),
                InboundItem::Video { .. } => unsupported = Some(ReplyKind::UnsupportedVideo),
                InboundItem::Unsupported { .. } => unsupported = Some(ReplyKind::UnsupportedBinary),
            }
        }
        if let Some(kind) = unsupported {
            self.reply(account_id, &message.peer_id, responses, kind);
            return self.commit(account_id, &message.message_key, page_buf);
        }
        if text_parts.is_empty() && images.is_empty() {
            return Disposition::Skipped;
        }
        let prompt = BridgePrompt {
            account_id: account_id.to_owned(),
            peer_id: message.peer_id.clone(),
            message_key: message.message_key.clone(),
            text: text_parts.join("\n"),
            images,
        };
        // Commit only after the router accepted ownership; a closed
        // router leaves the message for re-delivery.
        if prompts.send(prompt).is_err() {
            return Disposition::Skipped;
        }
        self.commit(account_id, &message.message_key, page_buf)
    }

    /// User messages in a terminal state only; bot echoes and
    /// generating partials never drive application state.
    fn is_processable(&self, message: &InboundMessage) -> bool {
        if message
            .wire_type
            .is_some_and(|kind| kind != MESSAGE_TYPE_USER)
        {
            return false;
        }
        if message
            .wire_state
            .is_some_and(|state| state != MESSAGE_STATE_FINISH && state != MESSAGE_STATE_NEW)
        {
            return false;
        }
        true
    }

    /// Fetches one image (thumbnail preferred) through validated CDN
    /// origins within the media bound.
    async fn fetch_image(&self, media: &MediaRef) -> Option<BridgeImage> {
        let wire = CdnMedia {
            encrypt_query_param: media.encrypt_query_param.clone(),
            aes_key: media.aes_key.as_ref().map(|key| key.expose().to_owned()),
            encrypt_type: None,
            full_url: media.full_url.clone(),
        };
        if media.full_url.is_none() && media.encrypt_query_param.is_none() {
            return None;
        }
        let _ = self.prefer_original_images; // setting lands with media sends (#132)
        let bytes =
            tokio::time::timeout(self.download_timeout, self.cdn.download_and_decrypt(&wire))
                .await
                .ok()?
                .ok()?;
        if bytes.len() > MAX_MEDIA_BYTES {
            return None;
        }
        self.counters
            .media_bytes
            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
        Some(BridgeImage {
            mime: "image/png".to_owned(),
            bytes: bytes.into(),
            source: ImageSource::Thumb,
        })
    }

    fn commit(
        &self,
        account_id: &str,
        message_key: &str,
        page_buf: &Option<String>,
    ) -> Disposition {
        match self.store.commit_ilink_inbound_message(
            account_id,
            message_key,
            page_buf.as_deref().unwrap_or_default(),
            1,
        ) {
            Ok(_) => Disposition::Prompted,
            Err(_) => Disposition::Skipped,
        }
    }

    fn reply(
        &self,
        account_id: &str,
        peer_id: &str,
        responses: &dyn ResponseChannel,
        kind: ReplyKind,
    ) {
        let reply = ChannelReply::new(self.language, kind);
        let _ = responses.send_reply(account_id, peer_id, &reply);
    }
}

/// Default API timeout re-exported so the bridge's download path and
/// the outbound bridge agree on bounds.
pub const BRIDGE_API_TIMEOUT: Duration = API_TIMEOUT;

/// Convenience constructor input: the peer's context token is stored
/// only after authorization (ADR 0211 §7); the router records it with
/// the exact account + peer pair.
pub fn seal_peer_context(
    store: &AgentStore,
    account_id: &str,
    peer_id: &str,
    context_token: &Secret,
    seal: impl Fn(&[u8]) -> Result<Vec<u8>, super::error::IlinkError>,
) -> Result<(), super::error::IlinkError> {
    let authorized = store
        .ilink_peer(account_id, peer_id)
        .ok()
        .flatten()
        .is_some_and(|peer: IlinkPeer| peer.authorized);
    if !authorized {
        return Err(super::error::IlinkError::Crypto(
            "peer not authorized for context storage".into(),
        ));
    }
    let sealed = seal(context_token.expose().as_bytes())?;
    store
        .remember_ilink_peer_context_token(account_id, peer_id, &sealed)
        .map_err(|error| super::error::IlinkError::Crypto(format!("store: {error}")))
}
