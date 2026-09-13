//! Safe domain types derived from the wire protocol. Everything the rest
//! of the server touches lives here: credential material is wrapped in
//! [`Secret`] (redacted `Debug`/`Display`), media references stay inert,
//! and inbound content is normalized once — with an explicit unsupported
//! variant instead of silent drops (ADR 0211 §10).

use super::error::Secret;
use super::types::{
    CdnMedia, ITEM_TYPE_FILE, ITEM_TYPE_IMAGE, ITEM_TYPE_TEXT, ITEM_TYPE_VIDEO, ITEM_TYPE_VOICE,
    ImageItem, MessageItem, VideoItem, WeixinMessage,
};

/// Stable inbound identity: sender + timestamp + sequence/message id
/// (ADR 0211 §6). Used for dedupe and as the run `client_message_id`.
pub fn inbound_message_key(message: &WeixinMessage) -> Option<String> {
    let sender = message.from_user_id.as_deref()?.trim();
    if sender.is_empty() {
        return None;
    }
    let timestamp = message.create_time_ms.unwrap_or(0);
    let sequence = message.message_id.or(message.seq).unwrap_or(0);
    Some(format!("{sender}:{timestamp}:{sequence}"))
}

/// An inert CDN reference resolved later by the CDN client (Phase 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaRef {
    pub encrypt_query_param: Option<String>,
    pub aes_key: Option<Secret>,
    pub full_url: Option<String>,
}

impl MediaRef {
    fn from_wire(media: &CdnMedia) -> Self {
        Self {
            encrypt_query_param: media.encrypt_query_param.clone(),
            aes_key: media.aes_key.clone().map(Secret::new),
            full_url: media.full_url.clone(),
        }
    }
}

/// One normalized inbound content item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundItem {
    Text {
        text: String,
    },
    /// Upstream excerpt of the quoted message (`ref_msg.title`).
    QuotedText {
        text: String,
    },
    /// Voice with Tencent-provided transcription; `None` means the channel
    /// must answer with an explicit unsupported message rather than guess.
    Voice {
        transcription: Option<String>,
    },
    Image {
        media: MediaRef,
        /// Thumbnail reference when upstream provides one.
        thumb: Option<MediaRef>,
    },
    Video {
        media: MediaRef,
    },
    File {
        media: MediaRef,
        file_name: Option<String>,
    },
    /// Known but not supported in this release — surfaced explicitly.
    Unsupported {
        item_type: i64,
    },
}

impl InboundItem {
    fn from_wire(item: &MessageItem) -> Option<Self> {
        let item_type = item.item_type?;
        match item_type {
            ITEM_TYPE_TEXT => item
                .text_item
                .as_ref()
                .and_then(|text| text.text.clone())
                .map(|text| Self::Text { text }),
            ITEM_TYPE_VOICE => Some(Self::Voice {
                transcription: item
                    .voice_item
                    .as_ref()
                    .and_then(|voice| voice.text.clone()),
            }),
            // Media items always normalize so the bridge can answer with
            // its localized unsupported/failed reply instead of silently
            // dropping the record.
            ITEM_TYPE_IMAGE => Some(Self::media_ref(
                item.image_item.as_ref().unwrap_or(&ImageItem::default()),
            )),
            ITEM_TYPE_VIDEO => Some(Self::media_from_video(
                item.video_item.as_ref().unwrap_or(&VideoItem::default()),
            )),
            ITEM_TYPE_FILE => Some(Self::File {
                media: Self::media_from(
                    item.file_item.as_ref().and_then(|file| file.media.as_ref()),
                ),
                file_name: item
                    .file_item
                    .as_ref()
                    .and_then(|file| file.file_name.clone()),
            }),
            _ => Some(Self::Unsupported { item_type }),
        }
    }

    fn media_ref(media: &ImageItem) -> Self {
        let media_ref = Self::media_from(media.media.as_ref());
        let thumb = media
            .thumb_media
            .as_ref()
            .map(|thumb| Self::media_from(Some(thumb)));
        Self::Image {
            media: media_ref,
            thumb,
        }
    }

    fn media_from_video(media: &VideoItem) -> Self {
        Self::Video {
            media: Self::media_from(media.media.as_ref()),
        }
    }

    fn media_from(media: Option<&CdnMedia>) -> MediaRef {
        media.map(MediaRef::from_wire).unwrap_or(MediaRef {
            encrypt_query_param: None,
            aes_key: None,
            full_url: None,
        })
    }
}

/// A normalized inbound WeChat message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundMessage {
    pub message_key: String,
    pub peer_id: String,
    /// Context token to echo on any reply (kept secret; per-peer storage is
    /// ADR 0211 §7).
    pub context_token: Option<Secret>,
    pub items: Vec<InboundItem>,
    /// Wire message type (1 = user, 2 = bot echo).
    pub wire_type: Option<i64>,
    /// Wire message state (1 = generating partial, 2 = finished).
    pub wire_state: Option<i64>,
}

impl InboundMessage {
    /// Normalizes a wire message. Returns `None` for messages without a
    /// usable sender or without items — those carry nothing actionable.
    pub fn from_wire(message: &WeixinMessage) -> Option<Self> {
        let message_key = inbound_message_key(message)?;
        let mut items = Vec::new();
        for item in message.item_list.as_ref()?.iter() {
            // A quoted excerpt rides on its item and normalizes as its
            // own content so the prompt keeps reply-context order.
            if let Some(quoted) = item
                .ref_msg
                .as_ref()
                .and_then(|reference| reference.title.clone())
                .filter(|title| !title.trim().is_empty())
            {
                items.push(InboundItem::QuotedText { text: quoted });
            }
            if let Some(item) = InboundItem::from_wire(item) {
                items.push(item);
            }
        }
        if items.is_empty() {
            return None;
        }
        Some(Self {
            message_key,
            peer_id: message.from_user_id.clone()?.trim().to_owned(),
            context_token: message.context_token.clone().map(Secret::new),
            items,
            wire_type: message.message_type,
            wire_state: message.message_state,
        })
    }

    /// The first text item, when present (the common prompt path).
    pub fn text(&self) -> Option<&str> {
        self.items.iter().find_map(|item| match item {
            InboundItem::Text { text } => Some(text.as_str()),
            _ => None,
        })
    }
}

/// A text reply bound to one peer and its most recent context token.
#[derive(Debug, Clone)]
pub struct OutboundText {
    pub to_peer_id: String,
    pub text: String,
    pub context_token: Option<Secret>,
    /// Unique client-side id for the send (dedupe + logging).
    pub client_id: String,
}

impl OutboundText {
    pub fn new(to_peer_id: impl Into<String>, text: impl Into<String>, client_id: String) -> Self {
        Self {
            to_peer_id: to_peer_id.into(),
            text: text.into(),
            context_token: None,
            client_id,
        }
    }

    pub fn with_context_token(mut self, token: Option<Secret>) -> Self {
        self.context_token = token;
        self
    }

    /// Renders the wire `WeixinMessage` (bot → user, single text item,
    /// terminal state) per the upstream send path.
    pub fn to_wire(&self) -> WeixinMessage {
        use super::types::{MESSAGE_STATE_FINISH, MESSAGE_TYPE_BOT, MessageItem, TextItem};
        WeixinMessage {
            to_user_id: Some(self.to_peer_id.clone()),
            client_id: Some(self.client_id.clone()),
            message_type: Some(MESSAGE_TYPE_BOT),
            message_state: Some(MESSAGE_STATE_FINISH),
            item_list: Some(vec![MessageItem {
                item_type: Some(ITEM_TYPE_TEXT),
                text_item: Some(TextItem {
                    text: Some(self.text.clone()),
                }),
                ..MessageItem::default()
            }]),
            context_token: self
                .context_token
                .as_ref()
                .map(|token| token.expose().to_owned()),
            ..WeixinMessage::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ilink::types::{MESSAGE_TYPE_USER, TextItem, VoiceItem};

    fn wire_message() -> WeixinMessage {
        WeixinMessage {
            seq: Some(12),
            message_id: Some(9001),
            from_user_id: Some("wxid_synthetic_01".into()),
            create_time_ms: Some(1_750_000_000_000),
            message_type: Some(MESSAGE_TYPE_USER),
            item_list: Some(vec![MessageItem {
                item_type: Some(ITEM_TYPE_TEXT),
                text_item: Some(TextItem {
                    text: Some("fix the bug".into()),
                }),
                ..MessageItem::default()
            }]),
            context_token: Some("ctx-synthetic".into()),
            ..WeixinMessage::default()
        }
    }

    #[test]
    fn message_key_composes_sender_timestamp_sequence() {
        let message = wire_message();
        assert_eq!(
            inbound_message_key(&message).as_deref(),
            Some("wxid_synthetic_01:1750000000000:9001")
        );
        // Falls back to seq when message_id is absent.
        let mut no_id = message.clone();
        no_id.message_id = None;
        assert_eq!(
            inbound_message_key(&no_id).as_deref(),
            Some("wxid_synthetic_01:1750000000000:12")
        );
        // No sender → no key.
        let mut no_sender = message;
        no_sender.from_user_id = Some("  ".into());
        assert_eq!(inbound_message_key(&no_sender), None);
    }

    #[test]
    fn normalizes_text_voice_image_and_unsupported_items() {
        let mut message = wire_message();
        message.item_list = Some(vec![
            MessageItem {
                item_type: Some(ITEM_TYPE_TEXT),
                text_item: Some(TextItem {
                    text: Some("hello".into()),
                }),
                ..MessageItem::default()
            },
            MessageItem {
                item_type: Some(ITEM_TYPE_VOICE),
                voice_item: Some(VoiceItem {
                    text: Some("spoken words".into()),
                    ..VoiceItem::default()
                }),
                ..MessageItem::default()
            },
            MessageItem {
                item_type: Some(ITEM_TYPE_VOICE),
                voice_item: Some(VoiceItem::default()),
                ..MessageItem::default()
            },
            MessageItem {
                item_type: Some(99),
                ..MessageItem::default()
            },
        ]);
        let inbound = InboundMessage::from_wire(&message).expect("inbound");
        assert_eq!(inbound.peer_id, "wxid_synthetic_01");
        assert_eq!(inbound.items.len(), 4);
        assert!(matches!(inbound.items[0], InboundItem::Text { .. }));
        assert!(matches!(
            &inbound.items[1],
            InboundItem::Voice { transcription: Some(t) } if t == "spoken words"
        ));
        assert!(matches!(
            &inbound.items[2],
            InboundItem::Voice {
                transcription: None
            }
        ));
        assert!(matches!(
            &inbound.items[3],
            InboundItem::Unsupported { item_type: 99 }
        ));
        assert_eq!(inbound.text(), Some("hello"));
    }

    #[test]
    fn outbound_text_renders_the_upstream_send_shape() {
        let outbound = OutboundText::new("wxid_synthetic_01", "done", "kubecode-1".into())
            .with_context_token(Some(Secret::new("ctx-synthetic")));
        let wire = outbound.to_wire();
        let json = serde_json::to_value(&wire).expect("serialize");
        assert_eq!(json["to_user_id"], "wxid_synthetic_01");
        assert_eq!(json["client_id"], "kubecode-1");
        assert_eq!(json["context_token"], "ctx-synthetic");
        assert_eq!(json["item_list"][0]["text_item"]["text"], "done");
        // The domain type never prints the context token.
        assert!(!format!("{outbound:?}").contains("ctx-synthetic"));
    }

    #[test]
    fn messages_without_sender_or_items_are_skipped() {
        let mut message = wire_message();
        message.item_list = None;
        assert!(InboundMessage::from_wire(&message).is_none());
        let mut empty = wire_message();
        empty.item_list = Some(Vec::new());
        assert!(InboundMessage::from_wire(&empty).is_none());
    }
}
