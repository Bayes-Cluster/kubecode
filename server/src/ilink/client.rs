//! Native Rust iLink HTTP/JSON client, wire-compatible with the reviewed
//! Tencent `openclaw-weixin` baseline (ADR 0211 §1). Every request is
//! validated against the [`OriginPolicy`] *before* network access, carries
//! the versioned iLink headers, and enforces a per-operation timeout.
//! Long-poll timeout and external cancellation are control-flow outcomes,
//! not errors, matching upstream long-poll semantics.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::crypto::random_wechat_uin;
use super::domain::{InboundMessage, OutboundText};
use super::error::{IlinkError, Secret, check_business};
use super::origins::OriginPolicy;
use super::types::{
    BaseInfo, CdnMedia, GetConfigResp, GetUpdatesReq, GetUpdatesResp, GetUploadUrlReq,
    GetUploadUrlResp, LoginState, NotifyStartResp, NotifyStopResp, QrCodeResponse,
    QrStatusResponse, SendMessageReq, SendMessageResp, SendTypingReq, SendTypingResp,
    TYPING_STATUS_TYPING,
};

/// `iLink-App-Id` for this channel build (upstream package `ilink_appid`).
pub const ILINK_APP_ID: &str = "bot";
/// Default `bot_type` for the QR login endpoints.
pub const ILINK_BOT_TYPE: &str = "3";
/// The `AuthorizationType` header value for bot tokens.
pub const AUTHORIZATION_TYPE: &str = "ilink_bot_token";

/// Default timeout for regular API requests (sendMessage, getUploadUrl).
pub const API_TIMEOUT: Duration = Duration::from_secs(15);
/// Default timeout for lightweight requests (getConfig, sendTyping, notify*).
pub const CONFIG_TIMEOUT: Duration = Duration::from_secs(10);
/// Default long-poll timeout (getupdates, QR status).
pub const LONG_POLL_TIMEOUT: Duration = Duration::from_secs(35);

/// Upper bound for the sanitized `bot_agent`, matching upstream.
pub const BOT_AGENT_MAX_LEN: usize = 256;

/// Builds the encoded `iLink-App-ClientVersion` from a semantic version:
/// `0x00MMNNPP` = major<<16 | minor<<8 | patch.
pub fn build_client_version(version: &str) -> u32 {
    let component = |index: usize| -> u32 {
        version
            .split('.')
            .nth(index)
            .and_then(|part| part.parse::<u32>().ok())
            .unwrap_or(0)
            .min(0xff)
    };
    let major = component(0);
    let minor = component(1);
    let patch = component(2);
    (major << 16) | (minor << 8) | patch
}

/// Sanitizes a `bot_agent` into a UA-style wire-safe string: space
/// separated `name/version` products optionally followed by `(comment)`;
/// tokens that fail the grammar are dropped; the result is bounded to
/// [`BOT_AGENT_MAX_LEN`] bytes. Empty results fall back to `fallback`.
pub fn sanitize_bot_agent(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback.to_owned();
    }
    fn product(token: &str) -> Option<&str> {
        let (name, version) = token.split_once('/')?;
        let name_ok = !name.is_empty()
            && name.len() <= 32
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
        let version_ok = !version.is_empty()
            && version.len() <= 32
            && version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-'));
        (name_ok && version_ok).then_some(token)
    }
    let comment = |token: &str| {
        token.len() >= 2
            && token.len() <= 66
            && token.starts_with('(')
            && token.ends_with(')')
            && token[1..token.len() - 1]
                .chars()
                .all(|c| ('\x20'..='\x27').contains(&c) || ('\x2A'..='\x7E').contains(&c))
    };
    let mut accepted: Vec<String> = Vec::new();
    let mut pending_product: Option<String> = None;
    let mut tokens = trimmed.split_whitespace().peekable();
    while let Some(token) = tokens.next() {
        if token.starts_with('(') && !token.ends_with(')') {
            // Multi-word comment: glue tokens until the closing paren.
            let mut glued = token.to_owned();
            for next in tokens.by_ref() {
                glued.push(' ');
                glued.push_str(next);
                if next.ends_with(')') {
                    break;
                }
            }
            if let Some(product) = pending_product.take()
                && comment(&glued)
            {
                accepted.push(format!("{product} ({})", &glued[1..glued.len() - 1]));
            }
            continue;
        }
        if let Some(product) = pending_product.take() {
            accepted.push(product);
        }
        if let Some(product) = product(token) {
            pending_product = Some(product.to_owned());
        }
    }
    if let Some(product) = pending_product {
        accepted.push(product);
    }
    if accepted.is_empty() {
        return fallback.to_owned();
    }
    let mut joined = accepted.join(" ");
    if joined.len() <= BOT_AGENT_MAX_LEN {
        return joined;
    }
    // Truncate by dropping trailing tokens until under the cap.
    let mut truncated: Vec<String> = Vec::new();
    let mut length = 0usize;
    for token in accepted {
        let add = if truncated.is_empty() { 0 } else { 1 } + token.len();
        if length + add > BOT_AGENT_MAX_LEN {
            break;
        }
        length += add;
        truncated.push(token);
    }
    if truncated.is_empty() {
        return fallback.to_owned();
    }
    joined = truncated.join(" ");
    joined
}

/// Outcome of a long-poll that produced no messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LongPollOutcome<T> {
    /// Messages (or a terminal status) arrived.
    Items(T),
    /// The long poll timed out or was cancelled — normal control flow;
    /// the caller simply retries (or shuts down if it cancelled).
    Quiet,
}

/// One page of `getupdates`.
#[derive(Debug, Clone)]
pub struct UpdatesPage {
    pub messages: Vec<InboundMessage>,
    /// Opaque sync cursor to persist and echo on the next request.
    pub get_updates_buf: Option<String>,
    /// Server-suggested timeout for the next long poll.
    pub longpolling_timeout_ms: Option<i64>,
}

/// Result of a QR status poll.
#[derive(Debug, Clone)]
pub struct QrPoll {
    pub state: LoginState,
    /// Present only on `confirmed`.
    pub bot_token: Option<Secret>,
    pub bot_id: Option<String>,
    /// Effective API base for subsequent traffic.
    pub base_url: Option<String>,
    /// The user who scanned the QR code (the first authorized peer).
    pub scanner_user_id: Option<String>,
    /// Present only on `scaned_but_redirect`.
    pub redirect_host: Option<String>,
}

/// Validated, immutable client configuration.
#[derive(Clone)]
pub struct IlinkClient {
    http: reqwest::Client,
    api_base: reqwest::Url,
    _cdn_base_validated: reqwest::Url,
    policy: OriginPolicy,
    channel_version: String,
    bot_agent: String,
    api_timeout: Duration,
    config_timeout: Duration,
    long_poll_timeout: Duration,
}

impl IlinkClient {
    /// Builds a client. All origins are validated before any request; an
    /// invalid base is a construction error, not a network failure.
    pub fn new(
        api_base: &str,
        cdn_base: &str,
        policy: OriginPolicy,
        channel_version: &str,
        bot_agent: &str,
    ) -> Result<Self, IlinkError> {
        Ok(Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("kubecode-ilink/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|error| IlinkError::from_transport("client", &error))?,
            api_base: Self::normalize_base(policy.validate_url(api_base)?),
            // The CDN base participates in construction-time validation so
            // a misconfigured origin fails before any request; CDN traffic
            // itself goes through `CdnClient`.
            _cdn_base_validated: Self::normalize_base(policy.validate_url(cdn_base)?),
            policy,
            channel_version: channel_version.to_owned(),
            bot_agent: bot_agent.to_owned(),
            api_timeout: API_TIMEOUT,
            config_timeout: CONFIG_TIMEOUT,
            long_poll_timeout: LONG_POLL_TIMEOUT,
        })
    }

    /// Relative endpoint joins need the base path to end with a slash.
    fn normalize_base(mut base: reqwest::Url) -> reqwest::Url {
        if !base.as_str().ends_with('/') {
            let path = base.path().to_owned();
            base.set_path(&format!("{path}/"));
        }
        base
    }

    /// Overrides the per-operation timeouts (channel configuration).
    pub fn with_timeouts(mut self, api: Duration, config: Duration, long_poll: Duration) -> Self {
        self.api_timeout = api;
        self.config_timeout = config;
        self.long_poll_timeout = long_poll;
        self
    }

    pub fn api_base(&self) -> &reqwest::Url {
        &self.api_base
    }

    /// Re-bases the client after a validated `scaned_but_redirect` host.
    pub fn with_api_base(&self, base_url: &str) -> Result<Self, IlinkError> {
        let mut rebased = self.clone();
        rebased.api_base = self.policy.validate_url(base_url)?;
        Ok(rebased)
    }

    pub fn base_info(&self) -> BaseInfo {
        BaseInfo {
            channel_version: Some(self.channel_version.clone()),
            bot_agent: Some(self.bot_agent.clone()),
        }
    }

    /// Common headers for authenticated POSTs.
    fn auth_headers(
        &self,
        request: reqwest::RequestBuilder,
        token: Option<&Secret>,
    ) -> reqwest::RequestBuilder {
        let mut request = request
            .header("Content-Type", "application/json")
            .header("AuthorizationType", AUTHORIZATION_TYPE)
            .header("X-WECHAT-UIN", random_wechat_uin())
            .header("iLink-App-Id", ILINK_APP_ID)
            .header(
                "iLink-App-ClientVersion",
                build_client_version(&self.channel_version).to_string(),
            );
        if let Some(token) = token.filter(|token| !token.expose().trim().is_empty()) {
            request = request.bearer_auth(token.expose().trim());
        }
        request
    }

    /// Common headers for the unauthenticated QR status GET.
    fn public_headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request.header("iLink-App-Id", ILINK_APP_ID).header(
            "iLink-App-ClientVersion",
            build_client_version(&self.channel_version).to_string(),
        )
    }

    /// Validates the destination, sends, checks HTTP status and the iLink
    /// business envelope, and parses the typed response. Runs the request
    /// against the timeout; `cancel` short-circuits to a transport error.
    async fn post_checked<T: DeserializeOwned>(
        &self,
        operation: &'static str,
        endpoint: &str,
        body: &impl serde::Serialize,
        token: Option<&Secret>,
        timeout: Duration,
        cancel: Option<&CancellationToken>,
    ) -> Result<T, IlinkError> {
        let url = self.policy.validate_url(
            self.api_base
                .join(endpoint)
                .map_err(|_| IlinkError::OriginRejected {
                    reason: "endpoint is not a valid relative URL",
                })?
                .as_str(),
        )?;
        let request = self
            .auth_headers(self.http.post(url), token)
            .json(body)
            .timeout(timeout);
        let send = async {
            let response = request
                .send()
                .await
                .map_err(|error| IlinkError::from_transport(operation, &error))?;
            let status = response.status();
            let text = response
                .text()
                .await
                .map_err(|error| IlinkError::from_transport(operation, &error))?;
            if !status.is_success() {
                return Err(IlinkError::HttpStatus {
                    operation,
                    status: status.as_u16(),
                });
            }
            Self::parse_business(operation, &text)
        };
        match cancel {
            Some(cancel) => {
                tokio::select! {
                    _ = cancel.cancelled() => Err(IlinkError::Transport {
                        operation,
                        kind: super::error::TransportKind::Request,
                    }),
                    result = send => result,
                }
            }
            None => send.await,
        }
    }

    /// Parses a response envelope: business `ret`/`errcode` first, then the
    /// typed body. Raw response text never enters the error path.
    fn parse_business<T: DeserializeOwned>(
        operation: &'static str,
        text: &str,
    ) -> Result<T, IlinkError> {
        let value: Value =
            serde_json::from_str(text).map_err(|_| IlinkError::InvalidResponse { operation })?;
        let ret = value.get("ret").and_then(Value::as_i64);
        let errcode = value.get("errcode").and_then(Value::as_i64);
        check_business(operation, ret, errcode)?;
        serde_json::from_value(value).map_err(|_| IlinkError::InvalidResponse { operation })
    }

    /// GET with a bounded timeout, returning the raw text. QR status polls
    /// treat transport failures and timeouts as `wait`, per upstream.
    async fn get_text(
        &self,
        operation: &'static str,
        endpoint: &str,
        timeout: Duration,
        cancel: Option<&CancellationToken>,
    ) -> Result<String, IlinkError> {
        let url = self.policy.validate_url(
            self.api_base
                .join(endpoint)
                .map_err(|_| IlinkError::OriginRejected {
                    reason: "endpoint is not a valid relative URL",
                })?
                .as_str(),
        )?;
        let request = self.public_headers(self.http.get(url)).timeout(timeout);
        let send = async {
            let response = request
                .send()
                .await
                .map_err(|error| IlinkError::from_transport(operation, &error))?;
            let status = response.status();
            let text = response
                .text()
                .await
                .map_err(|error| IlinkError::from_transport(operation, &error))?;
            if !status.is_success() {
                return Err(IlinkError::HttpStatus {
                    operation,
                    status: status.as_u16(),
                });
            }
            Ok(text)
        };
        match cancel {
            Some(cancel) => {
                tokio::select! {
                    _ = cancel.cancelled() => Err(IlinkError::Timeout { operation }),
                    result = send => result,
                }
            }
            None => send.await,
        }
    }

    // -- QR login ----------------------------------------------------------

    /// Requests a fresh login QR (`ilink/bot/get_bot_qrcode`, unauthenticated).
    pub async fn create_qr(&self) -> Result<QrCodeResponse, IlinkError> {
        let body = json!({ "local_token_list": [] });
        self.post_checked::<QrCodeResponse>(
            "get_bot_qrcode",
            &format!("ilink/bot/get_bot_qrcode?bot_type={ILINK_BOT_TYPE}"),
            &body,
            None,
            self.config_timeout,
            None,
        )
        .await
    }

    /// Long-polls the QR status. Timeouts map to `LoginState::Wait`.
    pub async fn poll_qr_status(
        &self,
        qrcode: &Secret,
        verify_code: Option<&str>,
        cancel: Option<&CancellationToken>,
    ) -> Result<QrPoll, IlinkError> {
        let mut endpoint = format!(
            "ilink/bot/get_qrcode_status?qrcode={}",
            urlencoding_escape(qrcode.expose())
        );
        if let Some(code) = verify_code.map(str::trim).filter(|code| !code.is_empty()) {
            endpoint.push_str(&format!("&verify_code={}", urlencoding_escape(code)));
        }
        let outcome = self
            .get_text(
                "get_qrcode_status",
                &endpoint,
                self.long_poll_timeout,
                cancel,
            )
            .await;
        let text = match outcome {
            Ok(text) => text,
            // Timeout and transport noise are ordinary long-poll outcomes.
            Err(IlinkError::Timeout { .. }) | Err(IlinkError::Transport { .. }) => {
                return Ok(QrPoll {
                    state: LoginState::Wait,
                    bot_token: None,
                    bot_id: None,
                    base_url: None,
                    scanner_user_id: None,
                    redirect_host: None,
                });
            }
            Err(error) => return Err(error),
        };
        let response: QrStatusResponse =
            serde_json::from_str(&text).map_err(|_| IlinkError::InvalidResponse {
                operation: "get_qrcode_status",
            })?;
        let Some(state) = LoginState::from_wire(&response.status) else {
            return Err(IlinkError::InvalidResponse {
                operation: "get_qrcode_status",
            });
        };
        if state == LoginState::ScanedButRedirect
            && let Some(host) = response.redirect_host.as_deref()
        {
            // Validate eagerly: the caller may only re-base to a trusted
            // host.
            self.policy.validate_redirect_host(host)?;
        }
        Ok(QrPoll {
            state,
            bot_token: response.bot_token.map(Secret::new),
            bot_id: response.ilink_bot_id,
            base_url: response.baseurl,
            scanner_user_id: response.ilink_user_id,
            redirect_host: response.redirect_host,
        })
    }

    // -- Sync --------------------------------------------------------------

    /// Long-polls for inbound updates. Timeout, cancellation, and
    /// transport noise return [`LongPollOutcome::Quiet`]; business codes
    /// (including session expiry) are errors.
    pub async fn get_updates(
        &self,
        get_updates_buf: Option<&str>,
        token: &Secret,
        suggested_timeout: Option<Duration>,
        cancel: Option<&CancellationToken>,
    ) -> Result<LongPollOutcome<UpdatesPage>, IlinkError> {
        let request = GetUpdatesReq {
            get_updates_buf: Some(get_updates_buf.unwrap_or_default().to_owned()),
            base_info: Some(self.base_info()),
        };
        let sent_buf = request.get_updates_buf.clone();
        let timeout = suggested_timeout.unwrap_or(self.long_poll_timeout);
        // `post_checked` already converts cancellation into a transport
        // error, which folds into Quiet alongside the long-poll timeout.
        let result = self
            .post_checked::<GetUpdatesResp>(
                "getupdates",
                "ilink/bot/getupdates",
                &request,
                Some(token),
                timeout,
                cancel,
            )
            .await;
        let response = match result {
            Ok(response) => response,
            Err(IlinkError::Timeout { .. }) | Err(IlinkError::Transport { .. }) => {
                return Ok(LongPollOutcome::Quiet);
            }
            Err(error) => return Err(error),
        };
        let messages = response
            .msgs
            .unwrap_or_default()
            .iter()
            .filter_map(InboundMessage::from_wire)
            .collect();
        Ok(LongPollOutcome::Items(UpdatesPage {
            messages,
            get_updates_buf: response.get_updates_buf.or(sent_buf),
            longpolling_timeout_ms: response.longpolling_timeout_ms,
        }))
    }

    // -- Outbound ----------------------------------------------------------

    /// Sends one outbound message. Fails on business errors, otherwise
    /// quietly succeeds (matching upstream `sendMessage`).
    pub async fn send_message(
        &self,
        outbound: &OutboundText,
        token: &Secret,
        cancel: Option<&CancellationToken>,
    ) -> Result<(), IlinkError> {
        let wire = SendMessageReq {
            msg: Some(outbound.to_wire()),
            base_info: Some(self.base_info()),
        };
        let _: SendMessageResp = self
            .post_checked(
                "sendmessage",
                "ilink/bot/sendmessage",
                &wire,
                Some(token),
                self.api_timeout,
                cancel,
            )
            .await?;
        Ok(())
    }

    /// Sends a typing indicator (`sendtyping`); `status` selects
    /// typing/cancel per [`super::types::TYPING_STATUS_TYPING`].
    pub async fn send_typing(
        &self,
        ilink_user_id: &str,
        typing_ticket: &Secret,
        status: i64,
        token: &Secret,
    ) -> Result<(), IlinkError> {
        let request = SendTypingReq {
            ilink_user_id: Some(ilink_user_id.to_owned()),
            typing_ticket: Some(typing_ticket.expose().to_owned()),
            status: Some(if status == 0 {
                TYPING_STATUS_TYPING
            } else {
                status
            }),
            base_info: Some(self.base_info()),
        };
        let _: SendTypingResp = self
            .post_checked(
                "sendtyping",
                "ilink/bot/sendtyping",
                &request,
                Some(token),
                self.config_timeout,
                None,
            )
            .await?;
        Ok(())
    }

    /// Fetches bot config (notably the per-user `typing_ticket`).
    pub async fn get_config(
        &self,
        ilink_user_id: &str,
        context_token: Option<&Secret>,
        token: &Secret,
    ) -> Result<GetConfigResp, IlinkError> {
        let body = json!({
            "ilink_user_id": ilink_user_id,
            "context_token": context_token.map(Secret::expose),
            "base_info": self.base_info(),
        });
        self.post_checked(
            "getconfig",
            "ilink/bot/getconfig",
            &body,
            Some(token),
            self.config_timeout,
            None,
        )
        .await
    }

    /// Notifies iLink that the channel is starting.
    pub async fn notify_start(&self, token: &Secret) -> Result<NotifyStartResp, IlinkError> {
        let body = json!({ "base_info": self.base_info() });
        self.post_checked(
            "notifystart",
            "ilink/bot/msg/notifystart",
            &body,
            Some(token),
            self.config_timeout,
            None,
        )
        .await
    }

    /// Notifies iLink that the channel is stopping.
    pub async fn notify_stop(&self, token: &Secret) -> Result<NotifyStopResp, IlinkError> {
        let body = json!({ "base_info": self.base_info() });
        self.post_checked(
            "notifystop",
            "ilink/bot/msg/notifystop",
            &body,
            Some(token),
            self.config_timeout,
            None,
        )
        .await
    }

    /// Requests a pre-signed CDN upload URL (`getuploadurl`).
    pub async fn get_upload_url(
        &self,
        request: GetUploadUrlReq,
        token: &Secret,
    ) -> Result<GetUploadUrlResp, IlinkError> {
        let mut request = request;
        request.base_info = Some(self.base_info());
        self.post_checked(
            "getuploadurl",
            "ilink/bot/getuploadurl",
            &request,
            Some(token),
            self.api_timeout,
            None,
        )
        .await
    }

    /// Validates a media reference origin for CDN traffic.
    pub fn validate_cdn_media(&self, media: &CdnMedia) -> Result<(), IlinkError> {
        if let Some(full_url) = media.full_url.as_deref() {
            self.policy.validate_url(full_url)?;
        }
        Ok(())
    }
}

/// Percent-encodes a query parameter value without pulling in a new
/// dependency (iLink QR ids are opaque ASCII, but be conservative).
fn urlencoding_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_version_encodes_semver() {
        assert_eq!(build_client_version("0.0.0"), 0);
        assert_eq!(build_client_version("1.0.11"), 0x0001_000B);
        assert_eq!(build_client_version("2.4.6"), 0x0002_0406);
        assert_eq!(build_client_version("3.4"), 0x0003_0400);
        assert_eq!(build_client_version(""), 0);
    }

    #[test]
    fn bot_agent_sanitization_follows_the_ua_grammar() {
        let fallback = "kubecode/0.1.3";
        assert_eq!(sanitize_bot_agent("", fallback), fallback);
        assert_eq!(sanitize_bot_agent("   ", fallback), fallback);
        assert_eq!(sanitize_bot_agent("$$$not-a-product", fallback), fallback);
        assert_eq!(
            sanitize_bot_agent("kubecode/1.0 evil/../x", fallback),
            "kubecode/1.0"
        );
        assert_eq!(
            sanitize_bot_agent("kubecode/1.0 (standalone runtime)", fallback),
            "kubecode/1.0 (standalone runtime)"
        );
        // Comment without a preceding product is dropped.
        assert_eq!(sanitize_bot_agent("(orphan comment)", fallback), fallback);
        // An invalid comment drops the comment but keeps the product,
        // matching the upstream tokenizer.
        assert_eq!(sanitize_bot_agent("a/1 (bad\x01comment)", fallback), "a/1");
        // Oversized input truncates at a token boundary.
        let many: String = (0..40).map(|index| format!(" prod{index}/1.0")).collect();
        let sanitized = sanitize_bot_agent(&many, fallback);
        assert!(sanitized.len() <= BOT_AGENT_MAX_LEN);
        assert!(sanitized.starts_with("prod0/1.0"));
        // A bare name without a version is not a product token.
        assert_eq!(sanitize_bot_agent("no-version-here", fallback), fallback);
    }
}
