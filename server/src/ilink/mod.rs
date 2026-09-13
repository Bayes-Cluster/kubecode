//! Tencent iLink channel protocol primitives (ADR 0211, issue #125).
//!
//! This module is a native Rust port of the reviewed Tencent
//! `openclaw-weixin` wire protocol: HTTP/JSON endpoints, login states,
//! long-poll semantics, and encrypted CDN media. The TypeScript/OpenClaw
//! plugin is the protocol authority only — nothing here embeds, spawns, or
//! depends on Node.js, OpenClaw, or the upstream package.
//!
//! Layout:
//! - [`types`] — wire types mirroring the upstream proto JSON shapes.
//! - [`domain`] — safe domain types for the rest of the server, with
//!   credential material in redacting [`error::Secret`] wrappers.
//! - [`client`] — the HTTP client (`ILinkClient` semantics): versioned
//!   headers, per-operation timeouts, long-poll control flow.
//! - [`cdn`] — encrypted CDN upload/download with origin validation.
//! - [`crypto`] — MD5 digests, random wire ids, AES-128-ECB + PKCS#7.
//! - [`origins`] — the `.qq.com`/`.wechat.com` trust boundary applied
//!   before every request.
//! - [`error`] — typed errors that never carry secrets or raw payloads.
//!
//! Persisted channel state, lifecycle, and the bridge live in later
//! issues (#126, #127+); this module performs no I/O beyond the calls
//! its methods make.

pub mod cdn;
pub mod client;
pub mod crypto;
pub mod domain;
pub mod error;
pub mod guard;
pub mod inbound;
pub mod origins;
pub mod seal;
pub mod service;
pub mod types;

pub use cdn::{CdnClient, MAX_MEDIA_BYTES, UploadedMedia};
pub use client::{
    API_TIMEOUT, CONFIG_TIMEOUT, ILINK_APP_ID, ILINK_BOT_TYPE, IlinkClient, LONG_POLL_TIMEOUT,
    LongPollOutcome, QrPoll, UpdatesPage, build_client_version, sanitize_bot_agent,
};
pub use domain::{InboundItem, InboundMessage, MediaRef, OutboundText};
pub use error::{IlinkError, Secret};
pub use guard::{
    AdvertisedOption, InboundLimits, InteractionRegistry, PeerGate, PendingInteraction, Rejection,
};
pub use inbound::{
    BridgeImage, BridgePrompt, ChannelLanguage, ChannelReply, Disposition, ImageSource,
    InboundBridge, InboundCounters, ReplyKind,
};
pub use origins::{OriginPolicy, QR_LOGIN_BASE_URL, TRUSTED_SUFFIXES};
pub use seal::SecretKeyring;
pub use service::{
    ConnectionStatus, ILINK_CDN_BASE_URL, ILinkService, IlinkServiceConfig, PageSink, ServiceError,
    ServiceStatus,
};
pub use types::LoginState;
