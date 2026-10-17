//! Production wiring of the WeChat channel (issues #129–#131): long-poll
//! pages → [`InboundBridge`] → [`SessionRouter`], and the workspace event
//! stream → [`OutboundBridge`] → [`ILinkService`]. One [`ChannelBridge`]
//! exists per Runtime. It registers the service's page sink before the
//! poll loop restores, and stops before the service on shutdown so typing
//! indicators are cancelled while credentials are still usable.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::agent_runtime::AgentRuntime;

use super::client::UpdatesPage;
use super::error::IlinkError;
use super::guard::PeerGate;
use super::inbound::{BridgePrompt, ChannelLanguage, InboundBridge};
use super::outbound::{OutboundBridge, OutboundConfig, OutboundTransport};
use super::router::SessionRouter;
use super::service::{ILinkService, ServiceError};

/// Environment override for the channel reply language (`en`, `zh-CN`).
pub const ILINK_LANGUAGE_ENV: &str = "KUBECODE_ILINK_LANGUAGE";

/// Bridge tunables; production uses the defaults.
#[derive(Clone, Copy, Debug)]
pub struct ChannelBridgeConfig {
    pub language: ChannelLanguage,
    /// Agent image context uses originals instead of thumbnails.
    pub prefer_original_images: bool,
    /// Per-peer inbound budget per window.
    pub rate_limit: u32,
    pub rate_window: Duration,
    pub outbound: OutboundConfig,
}

impl Default for ChannelBridgeConfig {
    fn default() -> Self {
        let language = ChannelLanguage::from_tag(
            std::env::var(ILINK_LANGUAGE_ENV)
                .ok()
                .as_deref()
                .unwrap_or("en"),
        );
        Self {
            language,
            prefer_original_images: false,
            rate_limit: 20,
            rate_window: Duration::from_secs(60),
            outbound: OutboundConfig {
                language,
                ..OutboundConfig::default()
            },
        }
    }
}

/// Delivers outbound actions through the service, which alone holds the
/// bot token, sealed peer contexts, and typing tickets.
pub struct ServiceTransport {
    service: Arc<ILinkService>,
}

impl ServiceTransport {
    pub fn new(service: Arc<ILinkService>) -> Arc<Self> {
        Arc::new(Self { service })
    }
}

impl OutboundTransport for ServiceTransport {
    fn send_text<'a>(
        &'a self,
        peer_id: &'a str,
        text: &'a str,
        client_id: &'a str,
    ) -> BoxFuture<'a, Result<(), IlinkError>> {
        Box::pin(self.service.send_text(peer_id, text, client_id))
    }

    fn set_typing<'a>(
        &'a self,
        peer_id: &'a str,
        typing: bool,
    ) -> BoxFuture<'a, Result<(), IlinkError>> {
        Box::pin(self.service.set_typing(peer_id, typing))
    }
}

/// The running channel pipeline.
pub struct ChannelBridge {
    pub router: Arc<SessionRouter>,
    pub inbound: Arc<InboundBridge>,
    pub outbound: Arc<OutboundBridge>,
    service: Arc<ILinkService>,
    cancel: CancellationToken,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl ChannelBridge {
    /// Builds and starts the pipeline with the production transport.
    pub async fn start(
        service: Arc<ILinkService>,
        runtime: Arc<AgentRuntime>,
        config: ChannelBridgeConfig,
    ) -> Result<Arc<Self>, ServiceError> {
        let transport = ServiceTransport::new(Arc::clone(&service));
        Self::start_with_transport(service, runtime, transport, config).await
    }

    /// Builds and starts the pipeline with an explicit transport (tests
    /// capture deliveries without a network).
    pub async fn start_with_transport(
        service: Arc<ILinkService>,
        runtime: Arc<AgentRuntime>,
        transport: Arc<dyn OutboundTransport>,
        config: ChannelBridgeConfig,
    ) -> Result<Arc<Self>, ServiceError> {
        let store = runtime.store();
        let router = SessionRouter::new(runtime, Arc::clone(&store), config.language);
        let outbound = OutboundBridge::new(
            Arc::clone(&store),
            transport,
            Some(Arc::clone(&router)),
            config.outbound,
        );
        let inbound = InboundBridge::new(
            Arc::clone(&store),
            PeerGate::new(Vec::new(), config.rate_limit, config.rate_window),
            service.cdn_client().await?,
            config.prefer_original_images,
            config.language,
        );
        let cancel = CancellationToken::new();
        let (page_sender, pages) = mpsc::unbounded_channel();
        let (prompt_sender, prompts) = mpsc::unbounded_channel();
        let bridge = Arc::new(Self {
            router,
            inbound,
            outbound,
            service: Arc::clone(&service),
            cancel: cancel.clone(),
            tasks: Mutex::new(Vec::new()),
        });
        let tasks = vec![
            bridge.outbound.spawn(cancel.child_token()),
            tokio::spawn(Arc::clone(&bridge).page_loop(pages, prompt_sender, cancel.child_token())),
            tokio::spawn(Arc::clone(&bridge).prompt_loop(prompts, cancel.child_token())),
        ];
        *bridge.tasks.lock().await = tasks;
        service.set_page_sink(Some(page_sender)).await;
        Ok(bridge)
    }

    /// Stops the pipeline: detaches the page sink, cancels the loops
    /// (the outbound loop stops typing best-effort), and joins them.
    pub async fn shutdown(&self) {
        self.service.set_page_sink(None).await;
        self.cancel.cancel();
        let tasks = std::mem::take(&mut *self.tasks.lock().await);
        for task in tasks {
            if tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .is_err()
            {
                // A wedged loop must not hold Runtime shutdown hostage.
                continue;
            }
        }
    }

    async fn page_loop(
        self: Arc<Self>,
        mut pages: mpsc::UnboundedReceiver<UpdatesPage>,
        prompts: mpsc::UnboundedSender<BridgePrompt>,
        cancel: CancellationToken,
    ) {
        let responses = self.outbound.responses();
        loop {
            let page = tokio::select! {
                _ = cancel.cancelled() => return,
                page = pages.recv() => page,
            };
            let Some(page) = page else {
                return;
            };
            let Some(account_id) = self.service.account_id().await else {
                continue;
            };
            // Remember each authorized peer's latest reply context before
            // its message is dispatched (unauthorized peers are refused
            // inside `remember_peer_context`).
            for message in &page.messages {
                if let Some(context) = message.context_token.as_ref() {
                    let _ =
                        self.service
                            .remember_peer_context(&account_id, &message.peer_id, context);
                }
            }
            self.inbound
                .process_page(&account_id, &page, &responses, &prompts)
                .await;
        }
    }

    async fn prompt_loop(
        self: Arc<Self>,
        mut prompts: mpsc::UnboundedReceiver<BridgePrompt>,
        cancel: CancellationToken,
    ) {
        let responses = self.outbound.responses();
        loop {
            let prompt = tokio::select! {
                _ = cancel.cancelled() => return,
                prompt = prompts.recv() => prompt,
            };
            let Some(prompt) = prompt else {
                return;
            };
            self.router.route(prompt, &responses).await;
        }
    }
}
