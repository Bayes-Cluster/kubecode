//! Rust-owned iLink channel lifecycle (issue #127, ADR 0211 §4): one
//! owner supervises QR login, verification, redirect, connection
//! restore, the cancellable long-poll loop, reconnect, disconnect, and
//! graceful shutdown. Every mutation runs through the shared
//! [`ServiceCore`], so repeated calls are idempotent and at most one
//! poll task exists for the linked account at any point. Public state is
//! safe-only: statuses, display names, and binding ids — never upstream
//! responses, tokens, or QR identifiers.
//!
//! Cursor discipline: the wire cursor (`get_updates_buf`) advances in
//! memory per delivered page; the durable cursor advances only through
//! message-commit (#126 API, wired to real messages in Phase 3). A
//! shutdown therefore never persists a cursor ahead of processed
//! messages.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::agent_store::{AgentStore, IlinkAccountStatus, IlinkCredentialRecord, StoreError};

use super::client::{IlinkClient, LongPollOutcome, UpdatesPage};
use super::crypto::random_key_hex;
use super::error::{IlinkError, Secret};
use super::origins::{OriginPolicy, QR_LOGIN_BASE_URL};
use super::seal::SecretKeyring;
use super::types::LoginState;

/// Fixed production CDN base used for canonical URL fallbacks; every
/// destination still passes the origin policy before any request.
pub const ILINK_CDN_BASE_URL: &str = "https://szextshort.wechat.com";

/// Safe, externally visible connection state (ADR 0211 §4 statuses).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionStatus {
    /// No linked account or logged out.
    Disconnected,
    /// A QR code is being requested.
    RequestingQr,
    /// QR live, not yet scanned.
    WaitingForScan,
    /// Scanned; confirmation in progress.
    Scanned,
    /// The phone shows a number that must be submitted.
    VerificationRequired,
    /// Too many wrong codes; a fresh QR is required.
    VerificationBlocked,
    /// Polling is moving to the validated redirect host.
    Redirecting,
    /// Credentials persisted and the long-poll loop is live.
    Connected,
    /// Connected, but the poll loop is retrying after failures.
    BackingOff,
    /// Stored credentials were rejected; a new QR scan is required.
    Expired,
    /// An operational error ended the current attempt.
    Error,
}

impl ConnectionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::RequestingQr => "requesting_qr",
            Self::WaitingForScan => "waiting_for_scan",
            Self::Scanned => "scanned",
            Self::VerificationRequired => "verification_required",
            Self::VerificationBlocked => "verification_blocked",
            Self::Redirecting => "redirecting",
            Self::Connected => "connected",
            Self::BackingOff => "backing_off",
            Self::Expired => "expired",
            Self::Error => "error",
        }
    }

    /// The coarse status persisted in `ilink_accounts`.
    fn store_status(self) -> IlinkAccountStatus {
        match self {
            Self::Connected | Self::BackingOff => IlinkAccountStatus::Connected,
            Self::Expired => IlinkAccountStatus::Expired,
            Self::Disconnected | Self::Error => IlinkAccountStatus::Disconnected,
            _ => IlinkAccountStatus::Connecting,
        }
    }
}

/// Safe status projection returned by the REST layer.
#[derive(Clone, Debug)]
pub struct ServiceStatus {
    pub status: ConnectionStatus,
    pub account_id: Option<String>,
    pub display_name: Option<String>,
    /// The bound conversation id, if any (never a path).
    pub bound_conversation_id: Option<String>,
    /// True while a login QR is live and may still be scanned.
    pub login_active: bool,
    /// Milliseconds left before the live QR expires.
    pub login_expires_in_ms: Option<u64>,
}

/// Bounded outbound page sink; Phase 3's bridge registers a real one.
pub type PageSink = mpsc::UnboundedSender<UpdatesPage>;

/// Tunable timing knobs. Production uses the defaults; tests shrink
/// them to exercise TTL, cooldown, and backoff logic quickly.
#[derive(Clone)]
pub struct IlinkServiceConfig {
    pub api_base: String,
    pub cdn_base: String,
    pub channel_version: String,
    pub bot_agent: String,
    /// How long one QR stays scannable (upstream `ACTIVE_LOGIN_TTL`).
    pub qr_ttl: Duration,
    /// Bounded QR refreshes before giving up.
    pub qr_refresh_max: u32,
    /// Login status poll cadence.
    pub login_poll_interval: Duration,
    /// Short delay after a quiet long poll.
    pub retry_delay: Duration,
    /// Consecutive-failure backoff: base and ceiling (ADR 0211 §4).
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Minimum wait before a reconnect may follow an expired token.
    pub stale_cooldown: Duration,
    pub long_poll_timeout: Duration,
    pub api_timeout: Duration,
    pub config_timeout: Duration,
    pub origin_policy: OriginPolicy,
}

impl Default for IlinkServiceConfig {
    fn default() -> Self {
        let version = env!("CARGO_PKG_VERSION").to_owned();
        Self {
            api_base: QR_LOGIN_BASE_URL.to_owned(),
            cdn_base: ILINK_CDN_BASE_URL.to_owned(),
            channel_version: version.clone(),
            bot_agent: format!("kubecode/{version}"),
            qr_ttl: Duration::from_secs(5 * 60),
            qr_refresh_max: 3,
            login_poll_interval: Duration::from_millis(200),
            retry_delay: Duration::from_millis(500),
            backoff_base: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            stale_cooldown: Duration::from_secs(30),
            long_poll_timeout: super::client::LONG_POLL_TIMEOUT,
            api_timeout: super::client::API_TIMEOUT,
            config_timeout: super::client::CONFIG_TIMEOUT,
            origin_policy: OriginPolicy::production(),
        }
    }
}

/// Errors surfaced by the service API. Messages are safe by construction.
#[derive(Debug)]
pub enum ServiceError {
    /// No stored or active state to act on.
    NotAvailable,
    /// The requested transition does not apply right now.
    InvalidState(&'static str),
    /// Reconnect attempted inside the stale-token cooldown.
    CooldownActive(Duration),
    Protocol(IlinkError),
    Store(StoreError),
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAvailable => write!(formatter, "no linked iLink account"),
            Self::InvalidState(reason) => write!(formatter, "invalid state: {reason}"),
            Self::CooldownActive(remaining) => {
                write!(formatter, "reconnect cooldown active for {remaining:?}")
            }
            Self::Protocol(error) => write!(formatter, "{error}"),
            Self::Store(error) => write!(formatter, "{error}"),
        }
    }
}

/// The plaintext credential snapshot sealed at rest.
#[derive(Serialize, Deserialize, Default)]
struct CredentialPlain {
    #[serde(default)]
    bot_token: String,
}

/// One live QR login attempt.
struct ActiveLogin {
    qrcode: Secret,
    image_url: String,
    started_at: std::time::Instant,
    refreshes: u32,
    /// Verification code awaiting the next poll.
    pending_code: Option<String>,
}

/// Everything mutable about the connection, guarded by one mutex.
struct ServiceCore {
    config: IlinkServiceConfig,
    client: Option<IlinkClient>,
    account_id: Option<String>,
    status: ConnectionStatus,
    login: Option<ActiveLogin>,
    login_task: Option<JoinHandle<()>>,
    poll_task: Option<JoinHandle<()>>,
    login_cancel: CancellationToken,
    poll_cancel: CancellationToken,
    poll_generation: u64,
    consecutive_failures: u32,
    /// Set after an expired-token event; reconnects wait out the cooldown.
    stale_since: Option<std::time::Instant>,
    page_sink: Option<PageSink>,
    /// In-memory wire cursor; the durable cursor lives in the store.
    get_updates_buf: String,
}

impl ServiceCore {
    /// True while the loop generation still matches — a superseded task
    /// exits instead of fighting its replacement.
    fn current_generation(&self, generation: u64) -> bool {
        self.poll_generation == generation
    }
}

/// Returned by [`ILinkService::start_login`].
#[derive(Clone, Debug)]
pub struct QrLoginStart {
    /// True when a still-fresh QR was reused instead of re-issued.
    pub reused: bool,
    /// The QR image URL for the browser (upstream-provided; not a secret).
    pub image_url: String,
    pub expires_in_ms: u64,
}

/// The supervised iLink channel service handle.
pub struct ILinkService {
    store: Arc<AgentStore>,
    core: Arc<Mutex<ServiceCore>>,
}

impl ILinkService {
    pub fn new(store: Arc<AgentStore>, config: IlinkServiceConfig) -> Arc<Self> {
        let client = IlinkClient::new(
            &config.api_base,
            &config.cdn_base,
            config.origin_policy,
            &config.channel_version,
            &config.bot_agent,
        )
        .ok()
        .map(|client| {
            client.with_timeouts(
                config.api_timeout,
                config.config_timeout,
                config.long_poll_timeout,
            )
        });
        Arc::new(Self {
            store,
            core: Arc::new(Mutex::new(ServiceCore {
                config,
                client,
                account_id: None,
                status: ConnectionStatus::Disconnected,
                login: None,
                login_task: None,
                poll_task: None,
                login_cancel: CancellationToken::new(),
                poll_cancel: CancellationToken::new(),
                poll_generation: 0,
                consecutive_failures: 0,
                stale_since: None,
                page_sink: None,
                get_updates_buf: String::new(),
            })),
        })
    }

    pub fn store(&self) -> &AgentStore {
        &self.store
    }

    fn state_dir(&self) -> std::path::PathBuf {
        self.store.database_directory().join("ilink")
    }

    /// Registers the safe page sink used later by the Session bridge.
    pub async fn set_page_sink(&self, sink: Option<PageSink>) {
        self.core.lock().await.page_sink = sink;
    }

    /// Current safe status snapshot.
    pub async fn status(&self) -> ServiceStatus {
        let core = self.core.lock().await;
        let account = core
            .account_id
            .as_deref()
            .and_then(|account_id| self.store.ilink_account(account_id).ok().flatten());
        ServiceStatus {
            status: core.status,
            account_id: core.account_id.clone(),
            display_name: account.map(|account| account.display_name),
            bound_conversation_id: core
                .account_id
                .as_deref()
                .and_then(|account_id| self.store.ilink_session_binding(account_id).ok().flatten()),
            login_active: core.login.is_some(),
            login_expires_in_ms: core.login.as_ref().map(|login| {
                core.config
                    .qr_ttl
                    .saturating_sub(login.started_at.elapsed())
                    .as_millis() as u64
            }),
        }
    }

    // -- Startup restore ---------------------------------------------------

    /// Restores a persisted account on Runtime startup: credentials plus
    /// a working machine secret → restart the poll loop (the first
    /// successful page confirms `Connected`; a rejected token decays to
    /// `Expired`). Nothing persisted → stays disconnected. Idempotent.
    pub async fn restore_on_startup(&self) -> Result<bool, ServiceError> {
        let Some(credentials) = self.store.first_ilink_credentials() else {
            return Ok(false);
        };
        let mut core = self.core.lock().await;
        if core.poll_task.is_some() || core.account_id.is_some() {
            return Ok(true);
        }
        let keyring = SecretKeyring::open(self.state_dir()).map_err(ServiceError::Protocol)?;
        keyring
            .unseal(&credentials.sealed_blob)
            .map_err(ServiceError::Protocol)?;
        let client = core.client.clone().ok_or(ServiceError::NotAvailable)?;
        let client = if credentials.api_origin.is_empty() {
            client
        } else {
            client
                .with_api_base(&credentials.api_origin)
                .map_err(ServiceError::Protocol)?
        };
        core.client = Some(client);
        core.account_id = Some(credentials.account_id.clone());
        core.get_updates_buf = credentials.get_updates_buf.clone();
        core.stale_since = None;
        drop(core);
        self.set_status(ConnectionStatus::BackingOff).await;
        spawn_poll_loop(&self.core, Arc::clone(&self.store)).await;
        Ok(true)
    }

    // -- QR login ----------------------------------------------------------

    /// Starts (or reuses) a QR login. Reuses the live QR within its TTL;
    /// cancels any superseded attempt otherwise. Starting while already
    /// connected is reported instead of duplicated.
    pub async fn start_login(&self) -> Result<QrLoginStart, ServiceError> {
        let client = {
            let core = self.core.lock().await;
            if core.status == ConnectionStatus::Connected && core.poll_task.is_some() {
                return Err(ServiceError::InvalidState("already connected"));
            }
            core.client.clone().ok_or(ServiceError::NotAvailable)?
        };
        {
            let mut core = self.core.lock().await;
            // Bounded reuse: a still-fresh QR is handed out again.
            if let Some(login) = core.login.as_ref() {
                let elapsed = login.started_at.elapsed();
                if elapsed < core.config.qr_ttl {
                    return Ok(QrLoginStart {
                        reused: true,
                        image_url: login.image_url.clone(),
                        expires_in_ms: (core.config.qr_ttl - elapsed).as_millis() as u64,
                    });
                }
            }
            self.cancel_login_locked(&mut core).await;
            core.status = ConnectionStatus::RequestingQr;
        }
        // Network I/O happens without the core lock held.
        let qr = match client.create_qr().await {
            Ok(qr) => qr,
            Err(error) => {
                self.set_status(ConnectionStatus::Error).await;
                return Err(ServiceError::Protocol(error));
            }
        };
        {
            let mut core = self.core.lock().await;
            core.login = Some(ActiveLogin {
                qrcode: Secret::new(qr.qrcode.clone()),
                image_url: qr.qrcode_img_content.clone(),
                started_at: std::time::Instant::now(),
                refreshes: 0,
                pending_code: None,
            });
            core.status = ConnectionStatus::WaitingForScan;
            let login_cancel = core.login_cancel.clone();
            let core_shared = Arc::clone(&self.core);
            let store = Arc::clone(&self.store);
            let poll_qrcode = Secret::new(qr.qrcode);
            core.login_task = Some(tokio::spawn(async move {
                login_loop(store, core_shared, login_cancel, poll_qrcode).await;
            }));
        }
        Ok(QrLoginStart {
            reused: false,
            image_url: qr.qrcode_img_content,
            expires_in_ms: self.config().await.qr_ttl.as_millis() as u64,
        })
    }

    async fn cancel_login_locked(&self, core: &mut ServiceCore) {
        core.login_cancel.cancel();
        if let Some(task) = core.login_task.take() {
            task.abort();
        }
        core.login_cancel = CancellationToken::new();
        core.login = None;
    }

    async fn config(&self) -> IlinkServiceConfig {
        self.core.lock().await.config.clone()
    }

    /// The live QR image URL while a login is active (safe to render).
    pub async fn active_login_image(&self) -> Option<String> {
        self.core
            .lock()
            .await
            .login
            .as_ref()
            .map(|login| login.image_url.clone())
    }

    /// Submits a verification code for the active login. Rejected unless
    /// a login is awaiting a code — codes never outlive their login.
    pub async fn submit_verification_code(&self, code: &str) -> Result<(), ServiceError> {
        let mut core = self.core.lock().await;
        let code = code.trim();
        if code.is_empty() {
            return Err(ServiceError::InvalidState("empty verification code"));
        }
        if core.status != ConnectionStatus::VerificationRequired {
            return Err(ServiceError::InvalidState(
                "login is not awaiting a verification code",
            ));
        }
        let Some(login) = core.login.as_mut() else {
            return Err(ServiceError::InvalidState("no active login"));
        };
        login.pending_code = Some(code.to_owned());
        Ok(())
    }

    /// Cancels the active login attempt (idempotent).
    pub async fn cancel_login(&self) {
        let mut core = self.core.lock().await;
        self.cancel_login_locked(&mut core).await;
        if core.status != ConnectionStatus::Connected {
            core.status = ConnectionStatus::Disconnected;
        }
    }

    // -- Reconnect / stop / disconnect / shutdown ----------------------------

    /// Reconnects after backing off or expiry. Idempotent while
    /// connected; honors the stale-token cooldown after expiry.
    pub async fn reconnect(&self) -> Result<(), ServiceError> {
        let mut core = self.core.lock().await;
        if core.poll_task.is_some() && core.status == ConnectionStatus::Connected {
            return Ok(());
        }
        if core.account_id.is_none() {
            return Err(ServiceError::NotAvailable);
        }
        if let Some(since) = core.stale_since {
            let remaining = core.config.stale_cooldown.saturating_sub(since.elapsed());
            if remaining > Duration::ZERO {
                return Err(ServiceError::CooldownActive(remaining));
            }
            core.stale_since = None;
        }
        drop(core);
        spawn_poll_loop(&self.core, Arc::clone(&self.store)).await;
        Ok(())
    }

    /// Service stop: cancels tasks, notifies Tencent, keeps credentials
    /// and the durable cursor for the next startup (ADR 0211 §3/§4).
    pub async fn stop(&self) {
        let account_id = {
            let mut core = self.core.lock().await;
            self.teardown_tasks_locked(&mut core).await;
            core.status = ConnectionStatus::Disconnected;
            core.account_id.clone()
        };
        if let Some(account_id) = account_id {
            let _ = self
                .store
                .set_ilink_account_status(&account_id, IlinkAccountStatus::Disconnected);
        }
        let client = self.core.lock().await.client.clone();
        if let (Some(client), Some(token)) = (client, self.stored_token().await) {
            // notifyStop is best-effort; shutdown must not wait on it.
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                client.notify_stop(&Secret::new(token)),
            )
            .await;
        }
    }

    /// Disconnect/logout: everything `stop` does plus full channel-state
    /// removal and secret-file destruction (ADR 0211 §3).
    pub async fn disconnect(&self) -> Result<(), ServiceError> {
        let account_id = {
            let mut core = self.core.lock().await;
            self.teardown_tasks_locked(&mut core).await;
            core.status = ConnectionStatus::Disconnected;
            core.account_id.take()
        };
        let Some(account_id) = account_id else {
            return Err(ServiceError::NotAvailable);
        };
        let keyring = SecretKeyring::open(self.state_dir()).map_err(ServiceError::Protocol)?;
        self.store
            .ilink_logout(&account_id)
            .map_err(ServiceError::Store)?;
        keyring.destroy().map_err(ServiceError::Protocol)?;
        Ok(())
    }

    /// Graceful shutdown: cancel, notify, join — never waits for the
    /// server-side long-poll timeout because the token aborts the
    /// in-flight request immediately.
    pub async fn shutdown(&self) {
        self.stop().await;
        let mut core = self.core.lock().await;
        if let Some(task) = core.poll_task.take() {
            let _ = task.await;
        }
        if let Some(task) = core.login_task.take() {
            let _ = task.await;
        }
    }

    async fn teardown_tasks_locked(&self, core: &mut ServiceCore) {
        core.poll_cancel.cancel();
        core.login_cancel.cancel();
        if let Some(task) = core.poll_task.take() {
            task.abort();
        }
        if let Some(task) = core.login_task.take() {
            task.abort();
        }
        core.login = None;
        core.consecutive_failures = 0;
    }

    async fn set_status(&self, status: ConnectionStatus) {
        let mut core = self.core.lock().await;
        core.status = status;
        if let Some(account_id) = core.account_id.clone() {
            let _ = self
                .store
                .set_ilink_account_status(&account_id, status.store_status());
        }
    }

    async fn stored_token(&self) -> Option<String> {
        let account_id = self.core.lock().await.account_id.clone()?;
        let credentials = self.store.ilink_credentials(&account_id).ok().flatten()?;
        let keyring = SecretKeyring::open(self.state_dir()).ok()?;
        let plain = keyring.unseal(&credentials.sealed_blob).ok()?;
        serde_json::from_slice::<CredentialPlain>(&plain)
            .ok()
            .map(|value| value.bot_token)
    }
}

/// Spawns the supervised long-poll loop unless one already exists for a
/// newer generation. At most one live poll task exists at any point.
async fn spawn_poll_loop(core: &Arc<Mutex<ServiceCore>>, store: Arc<AgentStore>) {
    let (poll_cancel, generation) = {
        let mut core = core.lock().await;
        if core.poll_task.is_some() {
            return;
        }
        let generation = core.poll_generation + 1;
        core.poll_generation = generation;
        core.poll_cancel = CancellationToken::new();
        (core.poll_cancel.clone(), generation)
    };
    let core_shared = Arc::clone(core);
    let task = tokio::spawn(sync_loop(store, core_shared, poll_cancel, generation));
    core.lock().await.poll_task = Some(task);
}

/// Confirms a login: persists credentials (sealed) and account identity
/// before the service reports `Connected` (issue #127 ordering rule).
fn confirm_login(
    store: &AgentStore,
    state_dir: &std::path::Path,
    api_origin: &str,
    cdn_origin: &str,
    bot_token: &str,
    bot_id: &str,
    scanner_user_id: Option<&str>,
) -> Result<(), ServiceError> {
    let keyring = SecretKeyring::open(state_dir).map_err(ServiceError::Protocol)?;
    let plain = serde_json::to_vec(&CredentialPlain {
        bot_token: bot_token.to_owned(),
    })
    .map_err(|_| {
        ServiceError::Protocol(IlinkError::Crypto("credential serialize failed".into()))
    })?;
    let sealed = keyring.seal(&plain).map_err(ServiceError::Protocol)?;
    let (_key, device_id) = random_key_hex();
    store
        .upsert_ilink_account(bot_id, "")
        .map_err(ServiceError::Store)?;
    store
        .save_ilink_credentials(&IlinkCredentialRecord {
            account_id: bot_id.to_owned(),
            device_id,
            committed_cursor: 0,
            get_updates_buf: String::new(),
            api_origin: api_origin.to_owned(),
            cdn_origin: cdn_origin.to_owned(),
            sealed_blob: sealed,
        })
        .map_err(ServiceError::Store)?;
    if let Some(scanner) = scanner_user_id.map(str::trim).filter(|id| !id.is_empty()) {
        // The scanning user is the first authorized peer (§7).
        store
            .upsert_ilink_peer(bot_id, scanner, "", true)
            .map_err(ServiceError::Store)?;
    }
    let _ = store.set_ilink_account_status(bot_id, IlinkAccountStatus::Connected);
    Ok(())
}

/// The QR login state machine: poll status, verification codes,
/// validated redirects, bounded refresh, TTL expiry, and confirm.
async fn login_loop(
    store: Arc<AgentStore>,
    core: Arc<Mutex<ServiceCore>>,
    cancel: CancellationToken,
    mut qrcode: Secret,
) {
    let core_arc = Arc::clone(&core);
    loop {
        if cancel.is_cancelled() {
            return;
        }
        let (client, poll_interval, ttl) = {
            let core = core.lock().await;
            let Some(client) = core.client.clone() else {
                return;
            };
            (client, core.config.login_poll_interval, core.config.qr_ttl)
        };
        let (verify_code, force_refresh) = {
            let mut core = core.lock().await;
            let Some(login) = core.login.as_mut() else {
                return;
            };
            (login.pending_code.take(), login.started_at.elapsed() >= ttl)
        };
        if force_refresh {
            let refreshable = {
                let core = core.lock().await;
                core.login
                    .as_ref()
                    .is_some_and(|login| login.refreshes < core.config.qr_refresh_max)
            };
            if refreshable && let Ok(fresh) = client.create_qr().await {
                let mut core = core.lock().await;
                if let Some(login) = core.login.as_mut() {
                    login.qrcode = Secret::new(fresh.qrcode.clone());
                    login.image_url = fresh.qrcode_img_content.clone();
                    login.started_at = std::time::Instant::now();
                    login.refreshes += 1;
                    login.pending_code = None;
                }
                qrcode = Secret::new(fresh.qrcode);
                core.status = ConnectionStatus::WaitingForScan;
                continue;
            }
            let mut core = core.lock().await;
            core.status = ConnectionStatus::Expired;
            core.login = None;
            return;
        }
        let polled = client
            .poll_qr_status(&qrcode, verify_code.as_deref(), Some(&cancel))
            .await;
        if let Ok(poll) = polled {
            match poll.state {
                LoginState::Wait | LoginState::ScanedButRedirect => {
                    let mut core = core.lock().await;
                    if poll.state == LoginState::ScanedButRedirect
                        && let Some(host) = poll.redirect_host.as_deref()
                    {
                        // poll_qr_status already validated the host.
                        if let Some(client) = core.client.clone()
                            && let Ok(rebased) = client.with_api_base(&format!("https://{host}"))
                        {
                            core.client = Some(rebased);
                        }
                    }
                    core.status = if poll.state == LoginState::Wait {
                        ConnectionStatus::WaitingForScan
                    } else {
                        ConnectionStatus::Redirecting
                    };
                }
                LoginState::Scaned => {
                    core.lock().await.status = ConnectionStatus::Scanned;
                }
                LoginState::NeedVerifycode => {
                    core.lock().await.status = ConnectionStatus::VerificationRequired;
                }
                LoginState::VerifyCodeBlocked => {
                    let mut core = core.lock().await;
                    core.status = ConnectionStatus::VerificationBlocked;
                    core.login = None;
                    return;
                }
                LoginState::Expired => {
                    // Force the TTL/refresh branch on the next pass.
                    let mut core = core.lock().await;
                    if let Some(login) = core.login.as_mut() {
                        login.started_at = std::time::Instant::now()
                            .checked_sub(ttl)
                            .unwrap_or(login.started_at);
                    }
                }
                LoginState::BindedRedirect => {
                    // The scanned bot is already bound; existing
                    // credentials stay valid, this attempt just ends.
                    let mut core = core.lock().await;
                    core.login = None;
                    core.status = ConnectionStatus::Disconnected;
                    return;
                }
                LoginState::Confirmed => {
                    let (Some(token), Some(bot_id)) = (poll.bot_token.clone(), poll.bot_id.clone())
                    else {
                        let mut core = core.lock().await;
                        core.status = ConnectionStatus::Error;
                        core.login = None;
                        return;
                    };
                    let (state_dir, api_origin, cdn_origin) = {
                        let core = core.lock().await;
                        (
                            store.database_directory().join("ilink"),
                            client.api_base().to_string(),
                            core.config.cdn_base.clone(),
                        )
                    };
                    let confirmed = confirm_login(
                        &store,
                        &state_dir,
                        &api_origin,
                        &cdn_origin,
                        token.expose(),
                        &bot_id,
                        poll.scanner_user_id.as_deref(),
                    );
                    let mut core = core.lock().await;
                    core.login = None;
                    match confirmed {
                        Ok(()) => {
                            core.account_id = Some(bot_id);
                            core.status = ConnectionStatus::Connected;
                            drop(core);
                            spawn_poll_loop(&core_arc, Arc::clone(&store)).await;
                            return;
                        }
                        Err(_) => {
                            core.status = ConnectionStatus::Error;
                            return;
                        }
                    }
                }
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(poll_interval) => {}
        }
    }
}

/// The supervised long-poll loop: quiet → short retry; failures →
/// bounded exponential backoff; session expiry → Expired + cooldown;
/// cancellation → immediate exit. Pages go to the registered sink; the
/// durable cursor is untouched here (Phase 3 commits per message).
async fn sync_loop(
    store: Arc<AgentStore>,
    core: Arc<Mutex<ServiceCore>>,
    cancel: CancellationToken,
    generation: u64,
) {
    let mut suggested_timeout: Option<Duration> = None;
    let mut backoff_step: u32 = 0;
    loop {
        if cancel.is_cancelled() {
            return;
        }
        let (client, token, buf, retry_delay, backoff_base, backoff_max, account_id) = {
            let mut core = core.lock().await;
            if !core.current_generation(generation) {
                return;
            }
            let Some(client) = core.client.clone() else {
                return;
            };
            let Some(account_id) = core.account_id.clone() else {
                return;
            };
            let credentials = match store.ilink_credentials(&account_id) {
                Ok(Some(credentials)) => credentials,
                _ => {
                    return;
                }
            };
            let keyring = match SecretKeyring::open(store.database_directory().join("ilink")) {
                Ok(keyring) => keyring,
                Err(_) => {
                    core.status = ConnectionStatus::Error;
                    return;
                }
            };
            let token = match keyring
                .unseal(&credentials.sealed_blob)
                .ok()
                .and_then(|plain| serde_json::from_slice::<CredentialPlain>(&plain).ok())
            {
                Some(value) => Secret::new(value.bot_token),
                None => {
                    core.status = ConnectionStatus::Error;
                    return;
                }
            };
            (
                client,
                token,
                core.get_updates_buf.clone(),
                core.config.retry_delay,
                core.config.backoff_base,
                core.config.backoff_max,
                account_id,
            )
        };
        let outcome = client
            .get_updates(
                if buf.is_empty() { None } else { Some(&buf) },
                &token,
                suggested_timeout,
                Some(&cancel),
            )
            .await;
        match outcome {
            Ok(LongPollOutcome::Items(page)) => {
                suggested_timeout = page
                    .longpolling_timeout_ms
                    .and_then(|ms| u64::try_from(ms).ok())
                    .map(Duration::from_millis);
                let mut core = core.lock().await;
                if !core.current_generation(generation) {
                    return;
                }
                core.consecutive_failures = 0;
                backoff_step = 0;
                core.get_updates_buf = page.get_updates_buf.clone().unwrap_or_default();
                if core.status != ConnectionStatus::Connected {
                    core.status = ConnectionStatus::Connected;
                    let _ = store.set_ilink_account_status(
                        &account_id,
                        ConnectionStatus::Connected.store_status(),
                    );
                }
                if let Some(sink) = core.page_sink.as_ref() {
                    let _ = sink.send(page);
                }
            }
            Ok(LongPollOutcome::Quiet) => {
                {
                    let mut core = core.lock().await;
                    core.consecutive_failures = 0;
                    backoff_step = 0;
                    if core.status == ConnectionStatus::BackingOff {
                        core.status = ConnectionStatus::Connected;
                    }
                }
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(retry_delay) => {}
                }
            }
            Err(IlinkError::SessionExpired { .. }) => {
                let mut core = core.lock().await;
                core.status = ConnectionStatus::Expired;
                core.stale_since = Some(std::time::Instant::now());
                let _ = store.set_ilink_account_status(&account_id, IlinkAccountStatus::Expired);
                return;
            }
            Err(_) => {
                let backoff = backoff_base
                    .saturating_mul(2u32.saturating_pow(backoff_step.min(16)))
                    .min(backoff_max);
                {
                    let mut core = core.lock().await;
                    core.consecutive_failures = core.consecutive_failures.saturating_add(1);
                    if core.status == ConnectionStatus::Connected {
                        core.status = ConnectionStatus::BackingOff;
                    }
                }
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff_step = backoff_step.saturating_add(1);
            }
        }
    }
}
