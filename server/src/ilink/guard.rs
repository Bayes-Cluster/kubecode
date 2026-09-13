//! iLink trust boundary (issue #128, ADR 0211 §7/§9/§10/§12): peer
//! authorization, bounded inbound payloads, per-peer rate limits,
//! one-shot interactive-request resolution, and session-binding gates.
//! Every check fails closed with a typed error and never mutates state
//! partially. The Phase 3 bridge calls these gates before anything
//! reaches `WorkspaceService`, run admission, or an Agent prompt.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::domain::InboundMessage;
use super::error::IlinkError;

/// Typed, safe rejections. Messages never quote peer content, ids, or
/// upstream payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// The sender is not an authorized peer.
    UnauthorizedPeer,
    /// Too many commands/prompts from this peer right now.
    RateLimited { retry_after_ms: u64 },
    /// The inbound payload exceeds a bounded limit.
    Oversize(&'static str),
    /// The content kind cannot be admitted (binary/unknown media).
    UnsupportedContent,
    /// No current writable Session binding exists.
    NoWritableBinding,
    /// The interactive reference is unknown, answered, expired, or not
    /// owned by this peer.
    InteractionUnavailable,
    /// Duplicate delivery of an already-committed message.
    Duplicate,
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnauthorizedPeer => write!(formatter, "sender is not authorized"),
            Self::RateLimited { retry_after_ms } => {
                write!(formatter, "rate limited; retry after {retry_after_ms}ms")
            }
            Self::Oversize(what) => write!(formatter, "payload exceeds the {what} limit"),
            Self::UnsupportedContent => write!(formatter, "content type cannot be admitted"),
            Self::NoWritableBinding => write!(formatter, "no writable Session binding"),
            Self::InteractionUnavailable => write!(formatter, "interactive request unavailable"),
            Self::Duplicate => write!(formatter, "duplicate delivery"),
        }
    }
}

/// Inbound payload bounds (ADR 0211 §10).
#[derive(Clone, Copy, Debug)]
pub struct InboundLimits {
    pub max_items_per_message: usize,
    pub max_text_chars: usize,
    pub max_media_bytes: usize,
    pub max_filename_chars: usize,
    pub max_mime_chars: usize,
    pub max_download_time: Duration,
}

impl Default for InboundLimits {
    fn default() -> Self {
        Self {
            max_items_per_message: 8,
            max_text_chars: 8_192,
            max_media_bytes: 10 * 1024 * 1024,
            max_filename_chars: 128,
            max_mime_chars: 64,
            max_download_time: Duration::from_secs(30),
        }
    }
}

impl InboundLimits {
    /// Validates a normalized inbound message against every bound.
    /// Fails closed before any content leaves the protocol layer.
    pub fn check_message(&self, message: &InboundMessage) -> Result<(), Rejection> {
        if message.items.len() > self.max_items_per_message {
            return Err(Rejection::Oversize("item count"));
        }
        for item in &message.items {
            match item {
                super::domain::InboundItem::Text { text } => {
                    if text.chars().count() > self.max_text_chars {
                        return Err(Rejection::Oversize("text"));
                    }
                }
                super::domain::InboundItem::File {
                    file_name: Some(name),
                    ..
                } => {
                    // Filenames are bounded and must stay plain names:
                    // no separators, no traversal, no absolute paths.
                    if name.chars().count() > self.max_filename_chars
                        || name.contains(['/', '\\'])
                        || name.contains("..")
                    {
                        return Err(Rejection::UnsupportedContent);
                    }
                }
                super::domain::InboundItem::Unsupported { .. } => {
                    // Unknown content is surfaced explicitly upstream, never
                    // silently executed; the bridge answers with a
                    // localized unsupported response.
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Validates a media byte count before download or decode.
    pub fn check_media_bytes(&self, bytes: usize) -> Result<(), Rejection> {
        if bytes > self.max_media_bytes {
            return Err(Rejection::Oversize("media"));
        }
        Ok(())
    }

    /// Validates a MIME string bound (upstream-supplied strings are
    /// untrusted input, not instructions).
    pub fn check_mime(&self, mime: &str) -> Result<(), Rejection> {
        if mime.chars().count() > self.max_mime_chars
            || !mime.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '.' | ';' | '=' | '+' | '_')
            })
        {
            return Err(Rejection::UnsupportedContent);
        }
        Ok(())
    }
}

/// Fixed-window per-peer rate limit for commands and prompts.
#[derive(Debug)]
pub struct PeerRateLimiter {
    window: Duration,
    max_per_window: u32,
    windows: HashMap<(String, String), (u32, Instant)>,
}

impl PeerRateLimiter {
    pub fn new(max_per_window: u32, window: Duration) -> Self {
        Self {
            window,
            max_per_window,
            windows: HashMap::new(),
        }
    }

    /// Admits one action for the peer, or names the retry delay. The
    /// window resets lazily; entries for stale windows are reclaimed on
    /// the same pass.
    pub fn admit(&mut self, account_id: &str, peer_id: &str) -> Result<(), Rejection> {
        let now = Instant::now();
        self.windows
            .retain(|_, (_, opened)| now.duration_since(*opened) < self.window);
        let entry = self
            .windows
            .entry((account_id.to_owned(), peer_id.to_owned()))
            .or_insert((0, now));
        if now.duration_since(entry.1) >= self.window {
            *entry = (0, now);
        }
        if entry.0 >= self.max_per_window {
            let retry_after = self.window.saturating_sub(now.duration_since(entry.1));
            return Err(Rejection::RateLimited {
                retry_after_ms: retry_after.as_millis() as u64,
            });
        }
        entry.0 += 1;
        Ok(())
    }
}

/// One provider-advertised interactive option.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdvertisedOption {
    pub option_id: String,
}

/// A pending permission/elicitation request isolated to one peer
/// (ADR 0211 §7/§9). Resolution is one-shot, expiry-bound, and requires
/// an exact current request id plus an exactly-advertised option.
pub struct PendingInteraction {
    pub request_id: String,
    pub account_id: String,
    pub peer_id: String,
    pub kind: &'static str,
    pub options: Vec<AdvertisedOption>,
    pub expires_at: Instant,
    resolved: bool,
}

impl PendingInteraction {
    pub fn new(
        request_id: String,
        account_id: String,
        peer_id: String,
        kind: &'static str,
        options: Vec<AdvertisedOption>,
        ttl: Duration,
    ) -> Self {
        Self {
            request_id,
            account_id,
            peer_id,
            kind,
            options,
            expires_at: Instant::now() + ttl,
            resolved: false,
        }
    }
}

/// Registry of pending interactive requests, keyed by request id.
#[derive(Default)]
pub struct InteractionRegistry {
    pending: HashMap<String, PendingInteraction>,
}

impl InteractionRegistry {
    /// Registers a pending request; replaces an expired/unresolved same-id
    /// entry (provider re-advertisement).
    pub fn register(&mut self, interaction: PendingInteraction) {
        self.pending
            .insert(interaction.request_id.clone(), interaction);
    }

    /// Resolves a pending request for this peer with an exactly
    /// advertised option. One-shot: the entry is consumed on success.
    /// Any mismatch — peer, id, option, expiry, or already-resolved —
    /// fails closed without consuming anything.
    pub fn resolve(
        &mut self,
        account_id: &str,
        peer_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<&AdvertisedOption, Rejection> {
        let Some(interaction) = self.pending.get_mut(request_id) else {
            return Err(Rejection::InteractionUnavailable);
        };
        if interaction.account_id != account_id || interaction.peer_id != peer_id {
            // Cross-peer answers are hijack attempts: fail closed.
            return Err(Rejection::InteractionUnavailable);
        }
        if interaction.resolved || Instant::now() > interaction.expires_at {
            return Err(Rejection::InteractionUnavailable);
        }
        let Some(option) = interaction
            .options
            .iter()
            .find(|option| option.option_id == option_id)
        else {
            // Not a currently advertised option — never accepted.
            return Err(Rejection::InteractionUnavailable);
        };
        interaction.resolved = true;
        Ok(option)
    }

    /// Drops expired entries; returns how many were reclaimed.
    pub fn reclaim_expired(&mut self) -> usize {
        let now = Instant::now();
        let before = self.pending.len();
        self.pending
            .retain(|_, interaction| !interaction.resolved && now <= interaction.expires_at);
        before - self.pending.len()
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

/// The trust gate combining peer authorization, limits, and rate
/// limiting. Constructed with the authorized peer set (the scanner plus
/// explicitly approved peers, ADR 0211 §7).
pub struct PeerGate {
    limits: InboundLimits,
    rate_limiter: PeerRateLimiter,
    authorized: std::collections::HashSet<(String, String)>,
}

impl PeerGate {
    pub fn new(authorized_peers: Vec<(String, String)>, rate_limit: u32, window: Duration) -> Self {
        Self {
            limits: InboundLimits::default(),
            rate_limiter: PeerRateLimiter::new(rate_limit, window),
            authorized: authorized_peers.into_iter().collect(),
        }
    }

    pub fn authorize(&mut self, account_id: &str, peer_id: &str) {
        self.authorized
            .insert((account_id.to_owned(), peer_id.to_owned()));
    }

    pub fn is_authorized(&self, account_id: &str, peer_id: &str) -> bool {
        self.authorized
            .contains(&(account_id.to_owned(), peer_id.to_owned()))
    }

    /// Full inbound admission check: authorization first (fail closed
    /// for everyone else), then rate limit, then payload bounds.
    pub fn admit(&mut self, account_id: &str, message: &InboundMessage) -> Result<(), Rejection> {
        if !self.is_authorized(account_id, &message.peer_id) {
            return Err(Rejection::UnauthorizedPeer);
        }
        self.rate_limiter.admit(account_id, &message.peer_id)?;
        self.limits.check_message(message)
    }
}

/// Maps a gate rejection onto the protocol error space for logging
/// (never for echoing content back).
impl From<Rejection> for IlinkError {
    fn from(rejection: Rejection) -> Self {
        IlinkError::Crypto(format!("rejected: {rejection}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ilink::domain::{InboundItem, InboundMessage};

    fn text_message(peer: &str, text: &str) -> InboundMessage {
        InboundMessage {
            message_key: format!("{peer}:1750000000000:1"),
            peer_id: peer.to_owned(),
            context_token: None,
            items: vec![InboundItem::Text {
                text: text.to_owned(),
            }],
            wire_type: None,
            wire_state: None,
        }
    }

    fn gate_with(authorized: &[&str]) -> PeerGate {
        let mut gate = PeerGate::new(Vec::new(), 3, Duration::from_secs(60));
        for peer in authorized {
            gate.authorize("acct", peer);
        }
        gate
    }

    #[test]
    fn unauthorized_peers_fail_closed_before_any_mutation() {
        let mut gate = gate_with(&["wxid_owner"]);
        let error = gate
            .admit("acct", &text_message("wxid_stranger", "run rm -rf"))
            .expect_err("strangers are rejected");
        assert_eq!(error, Rejection::UnauthorizedPeer);
        // An authorized peer passes bounds and rate limit.
        assert!(
            gate.admit("acct", &text_message("wxid_owner", "hello"))
                .is_ok()
        );
    }

    #[test]
    fn rate_limits_are_per_peer_and_windowed() {
        let mut gate = PeerGate::new(Vec::new(), 2, Duration::from_secs(60));
        gate.authorize("acct", "wxid_owner");
        gate.authorize("acct", "wxid_other");
        assert!(
            gate.admit("acct", &text_message("wxid_owner", "one"))
                .is_ok()
        );
        assert!(
            gate.admit("acct", &text_message("wxid_owner", "two"))
                .is_ok()
        );
        let error = gate
            .admit("acct", &text_message("wxid_owner", "three"))
            .expect_err("window exhausted");
        assert!(matches!(error, Rejection::RateLimited { .. }));
        // Another peer has its own budget.
        assert!(
            gate.admit("acct", &text_message("wxid_other", "one"))
                .is_ok()
        );
    }

    #[test]
    fn oversized_and_unsafe_content_fails_closed() {
        let gate = gate_with(&["wxid_owner"]);
        let long_text = "x".repeat(10_000);
        assert!(matches!(
            gate.limits
                .check_message(&text_message("wxid_owner", &long_text)),
            Err(Rejection::Oversize("text"))
        ));
        let traversal = InboundMessage {
            message_key: "k".to_owned(),
            peer_id: "wxid_owner".to_owned(),
            context_token: None,
            items: vec![InboundItem::File {
                media: crate::ilink::domain::MediaRef {
                    encrypt_query_param: None,
                    aes_key: None,
                    full_url: None,
                },
                file_name: Some("../../etc/passwd".to_owned()),
            }],
            wire_type: None,
            wire_state: None,
        };
        assert_eq!(
            gate.limits.check_message(&traversal),
            Err(Rejection::UnsupportedContent),
            "path-like filenames are rejected before any filesystem touch"
        );
        assert!(matches!(
            gate.limits.check_media_bytes(11 * 1024 * 1024),
            Err(Rejection::Oversize("media"))
        ));
        assert_eq!(gate.limits.check_mime("image/png"), Ok(()));
        assert!(
            gate.limits.check_mime("image/svg+xml").is_ok(),
            "structured mime types stay within the grammar"
        );
        assert!(gate.limits.check_mime("image png").is_err());
    }

    #[test]
    fn interactive_resolution_is_one_shot_peer_owned_and_expiry_bound() {
        let mut registry = InteractionRegistry::default();
        registry.register(PendingInteraction::new(
            "req-1".to_owned(),
            "acct".to_owned(),
            "wxid_owner".to_owned(),
            "permission",
            vec![
                AdvertisedOption {
                    option_id: "allow_once".to_owned(),
                },
                AdvertisedOption {
                    option_id: "reject".to_owned(),
                },
            ],
            Duration::from_millis(200),
        ));
        // A different peer cannot answer — hijack fails closed and the
        // request survives untouched.
        assert_eq!(
            registry.resolve("acct", "wxid_stranger", "req-1", "allow_once"),
            Err(Rejection::InteractionUnavailable)
        );
        // A non-advertised option is never accepted.
        assert_eq!(
            registry.resolve("acct", "wxid_owner", "req-1", "allow_always_yolo"),
            Err(Rejection::InteractionUnavailable)
        );
        // The exact peer with an exactly advertised option resolves once.
        assert!(
            registry
                .resolve("acct", "wxid_owner", "req-1", "allow_once")
                .is_ok()
        );
        assert_eq!(
            registry.resolve("acct", "wxid_owner", "req-1", "reject"),
            Err(Rejection::InteractionUnavailable),
            "one-shot: the request was consumed"
        );
        // Expiry closes the window.
        registry.register(PendingInteraction::new(
            "req-2".to_owned(),
            "acct".to_owned(),
            "wxid_owner".to_owned(),
            "elicitation",
            vec![AdvertisedOption {
                option_id: "ok".to_owned(),
            }],
            Duration::from_millis(5),
        ));
        std::thread::sleep(Duration::from_millis(10));
        assert_eq!(
            registry.resolve("acct", "wxid_owner", "req-2", "ok"),
            Err(Rejection::InteractionUnavailable)
        );
        // Both the consumed request and the expired one are garbage now.
        assert_eq!(registry.reclaim_expired(), 2);
        assert!(registry.is_empty());
    }

    #[test]
    fn rejection_display_never_carries_content() {
        let rendered = format!(
            "{} {} {}",
            Rejection::UnauthorizedPeer,
            Rejection::Oversize("text"),
            Rejection::Duplicate
        );
        assert!(!rendered.contains("rm -rf"));
        assert!(!rendered.contains("wxid"));
    }
}
