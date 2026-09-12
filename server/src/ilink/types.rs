//! iLink wire types, mirroring the reviewed Tencent `openclaw-weixin`
//! protocol shapes (`src/api/types.ts`, commit `cef0bfc`) — see
//! `docs/adr/0211-compatibility-2026-08-31.md`. JSON is sent and parsed
//! exactly as upstream; everything consumers outside this module touch
//! goes through the safe domain types in [`super::domain`].

use serde::{Deserialize, Serialize};

/// Common request metadata attached to every CGI request.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct BaseInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_version: Option<String>,
    /// Self-declared UA-style identity, sanitized and length-bounded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_agent: Option<String>,
}

/// proto: UploadMediaType
pub const UPLOAD_MEDIA_TYPE_IMAGE: i64 = 1;
pub const UPLOAD_MEDIA_TYPE_VIDEO: i64 = 2;
pub const UPLOAD_MEDIA_TYPE_FILE: i64 = 3;
pub const UPLOAD_MEDIA_TYPE_VOICE: i64 = 4;

/// proto: MessageType — 1 inbound from the user, 2 outbound from the bot.
pub const MESSAGE_TYPE_USER: i64 = 1;
pub const MESSAGE_TYPE_BOT: i64 = 2;

/// proto: MessageState
pub const MESSAGE_STATE_NEW: i64 = 0;
pub const MESSAGE_STATE_GENERATING: i64 = 1;
pub const MESSAGE_STATE_FINISH: i64 = 2;

/// proto: MessageItemType
pub const ITEM_TYPE_NONE: i64 = 0;
pub const ITEM_TYPE_TEXT: i64 = 1;
pub const ITEM_TYPE_IMAGE: i64 = 2;
pub const ITEM_TYPE_VOICE: i64 = 3;
pub const ITEM_TYPE_FILE: i64 = 4;
pub const ITEM_TYPE_VIDEO: i64 = 5;
pub const ITEM_TYPE_TOOL_CALL_START: i64 = 11;
pub const ITEM_TYPE_TOOL_CALL_RESULT: i64 = 12;

/// Typing status: 1 = typing (default), 2 = cancel typing.
pub const TYPING_STATUS_TYPING: i64 = 1;
pub const TYPING_STATUS_CANCEL: i64 = 2;

/// Every login state the QR status endpoint currently returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginState {
    /// Not yet scanned.
    Wait,
    /// Scanned; verification in progress.
    Scaned,
    /// Confirmed: credentials are in the response.
    Confirmed,
    /// QR expired; a fresh QR must be requested.
    Expired,
    /// Scanned, but polling must switch to the announced redirect host.
    ScanedButRedirect,
    /// The phone shows a number that must be submitted back.
    NeedVerifycode,
    /// Too many wrong verification codes; retry with a fresh QR.
    VerifyCodeBlocked,
    /// The scanned bot is already bound; existing credentials stay valid.
    BindedRedirect,
}

impl LoginState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wait => "wait",
            Self::Scaned => "scaned",
            Self::Confirmed => "confirmed",
            Self::Expired => "expired",
            Self::ScanedButRedirect => "scaned_but_redirect",
            Self::NeedVerifycode => "need_verifycode",
            Self::VerifyCodeBlocked => "verify_code_blocked",
            Self::BindedRedirect => "binded_redirect",
        }
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        Some(match value {
            "wait" => Self::Wait,
            "scaned" => Self::Scaned,
            "confirmed" => Self::Confirmed,
            "expired" => Self::Expired,
            "scaned_but_redirect" => Self::ScanedButRedirect,
            "need_verifycode" => Self::NeedVerifycode,
            "verify_code_blocked" => Self::VerifyCodeBlocked,
            "binded_redirect" => Self::BindedRedirect,
            _ => return None,
        })
    }
}

/// `get_bot_qrcode` response. `qrcode` is a login identifier (a secret:
/// it grants status polling for the login session), `qrcode_img_content`
/// is the QR image URL/data the browser renders.
#[derive(Debug, Clone, Deserialize)]
pub struct QrCodeResponse {
    #[serde(default)]
    pub qrcode: String,
    #[serde(default)]
    pub qrcode_img_content: String,
}

/// `get_qrcode_status` response.
#[derive(Debug, Clone, Deserialize)]
pub struct QrStatusResponse {
    pub status: String,
    #[serde(default)]
    pub bot_token: Option<String>,
    #[serde(default)]
    pub ilink_bot_id: Option<String>,
    #[serde(default)]
    pub baseurl: Option<String>,
    /// The user ID of the person who scanned the QR code.
    #[serde(default)]
    pub ilink_user_id: Option<String>,
    /// New host to redirect polling to when status is `scaned_but_redirect`.
    #[serde(default)]
    pub redirect_host: Option<String>,
}

/// CDN media reference; `aes_key` is base64-encoded bytes in JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CdnMedia {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypt_query_param: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aes_key: Option<String>,
    /// 0 = fileid only, 1 = packaged thumb/medium info.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypt_type: Option<i64>,
    /// Full download URL (server-provided; validated before use).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TextItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImageItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<CdnMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_media: Option<CdnMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aeskey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_height: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hd_size: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoiceItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<CdnMedia>,
    /// 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encode_type: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bits_per_sample: Option<i64>,
    /// Sample rate (Hz).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<i64>,
    /// Length in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playtime: Option<i64>,
    /// Speech-to-text transcription when Tencent provides one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<CdnMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub len: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct VideoItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<CdnMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_length: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_md5: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_media: Option<CdnMedia>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_height: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_width: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageItem {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub item_type: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_time_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_time_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_completed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_item: Option<TextItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_item: Option<ImageItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_item: Option<VoiceItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_item: Option<FileItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_item: Option<VideoItem>,
}

/// Unified message (proto: WeixinMessage).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct WeixinMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_time_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_time_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_time_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// See [`MESSAGE_TYPE_USER`] / [`MESSAGE_TYPE_BOT`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_type: Option<i64>,
    /// See [`MESSAGE_STATE_NEW`] / [`MESSAGE_STATE_GENERATING`] / [`MESSAGE_STATE_FINISH`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_state: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_list: Option<Vec<MessageItem>>,
    /// Per-message context token that must be echoed on the reply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// `getupdates` request; the opaque `get_updates_buf` is the sync cursor
/// cached locally and echoed back on the next request.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct GetUpdatesReq {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub get_updates_buf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_info: Option<BaseInfo>,
}

/// `getupdates` response.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct GetUpdatesResp {
    #[serde(default)]
    pub ret: Option<i64>,
    /// Server error code (e.g. -14 = session timeout).
    #[serde(default)]
    pub errcode: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
    #[serde(default)]
    pub msgs: Option<Vec<WeixinMessage>>,
    #[serde(default)]
    pub get_updates_buf: Option<String>,
    /// Server-suggested long-poll timeout (ms) for the next request.
    #[serde(default)]
    pub longpolling_timeout_ms: Option<i64>,
}

/// `sendmessage` request wrapping one outgoing message.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct SendMessageReq {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg: Option<WeixinMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_info: Option<BaseInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SendMessageResp {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
}

/// `sendtyping` request.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct SendTypingReq {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ilink_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub typing_ticket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_info: Option<BaseInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SendTypingResp {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
}

/// `getconfig` response; carries the per-user typing ticket.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct GetConfigResp {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
    #[serde(default)]
    pub typing_ticket: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct NotifyStartResp {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct NotifyStopResp {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
}

/// `getuploadurl` request fields (all thumbnail fields optional; first
/// release uploads without thumbnails).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct GetUploadUrlReq {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filekey: Option<String>,
    /// See [`UPLOAD_MEDIA_TYPE_IMAGE`] and friends.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_user_id: Option<String>,
    /// Plaintext size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rawsize: Option<i64>,
    /// Plaintext MD5 (hex).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rawfilemd5: Option<String>,
    /// Ciphertext size (AES-128-ECB + PKCS#7).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filesize: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_rawsize: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_rawfilemd5: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_filesize: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_need_thumb: Option<bool>,
    /// AES-128 key, hex-encoded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aeskey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_info: Option<BaseInfo>,
}

/// `getuploadurl` response.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct GetUploadUrlResp {
    #[serde(default)]
    pub upload_param: Option<String>,
    #[serde(default)]
    pub thumb_upload_param: Option<String>,
    /// Full upload URL (server-provided; validated before use).
    #[serde(default)]
    pub upload_full_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_state_round_trips_every_wire_string() {
        for state in [
            LoginState::Wait,
            LoginState::Scaned,
            LoginState::Confirmed,
            LoginState::Expired,
            LoginState::ScanedButRedirect,
            LoginState::NeedVerifycode,
            LoginState::VerifyCodeBlocked,
            LoginState::BindedRedirect,
        ] {
            assert_eq!(LoginState::from_wire(state.as_str()), Some(state));
        }
        assert_eq!(LoginState::from_wire("hologram"), None);
    }

    #[test]
    fn parses_the_upstream_getupdates_fixture_shape() {
        let raw = r#"{
          "ret": 0,
          "msgs": [{
            "seq": 12, "message_id": 9001,
            "from_user_id": "wxid_synthetic_01", "to_user_id": "ilink_bot_synthetic",
            "client_id": "", "create_time_ms": 1750000000000,
            "message_type": 1, "message_state": 2,
            "item_list": [{"type": 1, "text_item": {"text": "hello"}}],
            "context_token": "ctx-synthetic"
          }],
          "get_updates_buf": "cursor-blob",
          "longpolling_timeout_ms": 30000
        }"#;
        let resp: GetUpdatesResp = serde_json::from_str(raw).expect("fixture parse");
        assert_eq!(resp.ret, Some(0));
        let msgs = resp.msgs.expect("msgs");
        assert_eq!(msgs.len(), 1);
        assert_eq!(
            msgs[0].item_list.as_ref().expect("items")[0]
                .text_item
                .as_ref()
                .expect("text")
                .text
                .as_deref(),
            Some("hello")
        );
        assert_eq!(resp.longpolling_timeout_ms, Some(30000));
    }

    #[test]
    fn serializes_the_outgoing_message_with_snake_case_fields() {
        let req = SendMessageReq {
            msg: Some(WeixinMessage {
                to_user_id: Some("wxid_synthetic_01".into()),
                client_id: Some("kubecode-1".into()),
                message_type: Some(MESSAGE_TYPE_BOT),
                message_state: Some(MESSAGE_STATE_FINISH),
                item_list: Some(vec![MessageItem {
                    item_type: Some(ITEM_TYPE_TEXT),
                    text_item: Some(TextItem {
                        text: Some("reply".into()),
                    }),
                    ..MessageItem::default()
                }]),
                context_token: Some("ctx-synthetic".into()),
                ..WeixinMessage::default()
            }),
            base_info: Some(BaseInfo {
                channel_version: Some("0.1.3".into()),
                bot_agent: Some("kubecode/0.1.3".into()),
            }),
        };
        let json = serde_json::to_value(&req).expect("serialize");
        let msg = &json["msg"];
        assert_eq!(msg["to_user_id"], "wxid_synthetic_01");
        assert_eq!(msg["message_type"], MESSAGE_TYPE_BOT);
        assert_eq!(msg["item_list"][0]["type"], ITEM_TYPE_TEXT);
        assert_eq!(json["base_info"]["channel_version"], "0.1.3");
        // Absent fields are omitted, matching the optional proto shape.
        assert!(json["msg"].get("from_user_id").is_none());
        assert!(json["msg"].get("group_id").is_none());
    }
}
