//! Session routing for WeChat input (issue #130): normalized prompts and
//! interactive replies enter the bound Session through the existing
//! `AgentRuntime` contracts — never a direct ACP adapter call. Numeric
//! input is intercepted only while a peer-isolated permission or
//! elicitation request is pending; every other digit string is an
//! ordinary prompt. Bindings are revalidated at dispatch time and stale
//! bindings clear without selecting a replacement.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::agent_runtime::{AgentRuntime, PromptAdmission};
use crate::agent_store::AgentStore;

use super::guard::{AdvertisedOption, InteractionRegistry, PendingInteraction};
use super::inbound::ResponseChannel;
use super::inbound::{BridgePrompt, ChannelLanguage, ChannelReply};

/// How long a registered interactive request stays answerable; the
/// runtime's own pending timeout remains the authority, this only bounds
/// the WeChat-side window.
const INTERACTION_TTL: Duration = Duration::from_secs(300);

/// What one routed prompt produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteOutcome {
    /// A run started in the bound Session.
    Started,
    /// The prompt joined the durable queue behind an active run.
    Queued,
    /// A pending interactive request was answered.
    Interactive,
    /// Numeric input fell through as an ordinary prompt (no pending
    /// interaction) and was dispatched normally.
    PromptedAsText,
}

/// Routes BridgePrompts into the bound Session.
pub struct SessionRouter {
    runtime: Arc<AgentRuntime>,
    store: Arc<AgentStore>,
    registry: Mutex<InteractionRegistry>,
    /// conversation → originating WeChat peer of the latest routed run.
    origin_peers: Mutex<HashMap<String, String>>,
    /// peer (account+peer) → pending request ids registered for it.
    peer_requests: Mutex<HashMap<(String, String), Vec<String>>>,
    language: ChannelLanguage,
}

impl SessionRouter {
    pub fn new(
        runtime: Arc<AgentRuntime>,
        store: Arc<AgentStore>,
        language: ChannelLanguage,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            store,
            registry: Mutex::new(InteractionRegistry::default()),
            origin_peers: Mutex::new(HashMap::new()),
            peer_requests: Mutex::new(HashMap::new()),
            language,
        })
    }

    pub fn registry(&self) -> &Mutex<InteractionRegistry> {
        &self.registry
    }

    /// Registers a permission request for the conversation's originating
    /// peer (fed by the workspace event watcher).
    pub async fn register_permission(
        &self,
        account_id: &str,
        conversation_id: &str,
        request_id: &str,
        option_ids: Vec<String>,
    ) {
        let Some(peer) = self.origin_peers.lock().await.get(conversation_id).cloned() else {
            return;
        };
        let options = option_ids
            .into_iter()
            .map(|option_id| AdvertisedOption { option_id })
            .collect();
        self.registry.lock().await.register(PendingInteraction::new(
            request_id.to_owned(),
            account_id.to_owned(),
            peer.clone(),
            "permission",
            options,
            INTERACTION_TTL,
        ));
        self.peer_requests
            .lock()
            .await
            .entry((account_id.to_owned(), peer))
            .or_default()
            .push(request_id.to_owned());
    }

    /// Registers an elicitation; WeChat can only decline it in this
    /// release (the typed runtime contract accepts `None` → Decline).
    pub async fn register_elicitation(
        &self,
        account_id: &str,
        conversation_id: &str,
        request_id: &str,
    ) {
        let Some(peer) = self.origin_peers.lock().await.get(conversation_id).cloned() else {
            return;
        };
        self.registry.lock().await.register(PendingInteraction::new(
            request_id.to_owned(),
            account_id.to_owned(),
            peer.clone(),
            "elicitation",
            Vec::new(),
            INTERACTION_TTL,
        ));
        self.peer_requests
            .lock()
            .await
            .entry((account_id.to_owned(), peer))
            .or_default()
            .push(request_id.to_owned());
    }

    /// Drops peer-scoped interaction state (binding change, logout,
    /// Session removal).
    pub async fn clear_peer_requests(&self, account_id: &str, peer_id: &str) {
        self.peer_requests
            .lock()
            .await
            .remove(&(account_id.to_owned(), peer_id.to_owned()));
    }

    /// Routes one prompt. The response channel receives the localized
    /// acknowledgement or failure notice.
    pub async fn route(
        &self,
        prompt: BridgePrompt,
        responses: &dyn ResponseChannel,
    ) -> RouteOutcome {
        let account_id = prompt.account_id.clone();
        let peer_id = prompt.peer_id.clone();
        let reply =
            |text: String| responses.send_reply(&account_id, &peer_id, &ChannelReply { text });

        // Numeric interception: only while something is pending for this
        // exact peer.
        let numeric = prompt.text.trim();
        if numeric.len() <= 3 && numeric.chars().all(|c| c.is_ascii_digit()) && !numeric.is_empty()
        {
            let pending = self
                .peer_requests
                .lock()
                .await
                .get(&(account_id.clone(), peer_id.clone()))
                .cloned()
                .unwrap_or_default();
            for request_id in pending {
                // Resolve against the registry first (one-shot, owned by
                // this peer), then deliver through the runtime. WeChat
                // digits select advertised options by position (1-based).
                let selected = {
                    let mut registry = self.registry.lock().await;
                    let index: usize = numeric.parse().unwrap_or(0);
                    let option_id = registry
                        .advertised_options(&request_id)
                        .and_then(|options| {
                            if index >= 1 && index <= options.len() {
                                options.get(index - 1).cloned()
                            } else {
                                None
                            }
                        });
                    match option_id {
                        Some(option_id) => registry
                            .resolve(&account_id, &peer_id, &request_id, &option_id)
                            .map(|option| option.option_id.clone()),
                        None => continue,
                    }
                };
                if let Ok(option_id) = selected {
                    let request_owned = self
                        .registry
                        .lock()
                        .await
                        .kind_of(&request_id)
                        .unwrap_or("permission");
                    let delivered = if request_owned == "elicitation" {
                        // Typed decline path: WeChat cannot fill forms.
                        self.runtime.resolve_elicitation(&request_id, None)
                    } else {
                        self.runtime.resolve_permission(&request_id, &option_id)
                    };
                    if delivered {
                        self.clear_peer_requests(&account_id, &peer_id).await;
                        let _ = reply(self.ack(Outcome::InteractiveResolved));
                        return RouteOutcome::Interactive;
                    }
                    // The runtime no longer knows the request (expired
                    // between event and answer): report expiry.
                    self.clear_peer_requests(&account_id, &peer_id).await;
                    let _ = reply(self.ack(Outcome::PermissionExpired));
                    return RouteOutcome::Interactive;
                }
            }
            // Nothing pending: digits are an ordinary prompt.
        }

        // Resolve and revalidate the binding at dispatch time.
        let Some(conversation_id) = self.store.ilink_session_binding(&account_id).ok().flatten()
        else {
            let _ = reply(self.ack(Outcome::NoBinding));
            return RouteOutcome::Started;
        };
        let revalidated = self.revalidate_binding(&conversation_id);
        if let Err(reason) = revalidated {
            // Stale binding clears without selecting a replacement.
            let _ = self.store.unbind_ilink_session(&account_id);
            self.clear_peer_requests(&account_id, &peer_id).await;
            let _ = reply(self.ack(reason));
            return RouteOutcome::Started;
        }
        let Ok(conversation) = self.store.get_conversation(&conversation_id) else {
            let _ = self.store.unbind_ilink_session(&account_id);
            let _ = reply(self.ack(Outcome::StaleBinding));
            return RouteOutcome::Started;
        };

        // Channel-generated client message id reconciles browser history
        // and WeChat admission to one user turn.
        let client_message_id = format!("ilink:{}:{}", account_id, prompt.message_key);
        let admission = self
            .runtime
            .start_or_queue(crate::agent_runtime::StartAgentRun {
                conversation_id: conversation_id.clone(),
                project_id: conversation.project_id.clone(),
                message: prompt.text.clone(),
                client_message_id: Some(client_message_id),
            });
        match admission {
            Ok(PromptAdmission::Started(_)) => {
                self.origin_peers
                    .lock()
                    .await
                    .insert(conversation_id, peer_id.clone());
                let _ = reply(self.ack(Outcome::Started));
                RouteOutcome::Started
            }
            Ok(PromptAdmission::Queued(_)) => {
                self.origin_peers
                    .lock()
                    .await
                    .insert(conversation_id, peer_id.clone());
                let _ = reply(self.ack(Outcome::Queued));
                RouteOutcome::Queued
            }
            Err(_) => {
                // Session deletion racing the dispatch: revalidate and
                // clear without replacement.
                if self.store.get_conversation(&conversation_id).is_err() {
                    let _ = self.store.unbind_ilink_session(&account_id);
                    let _ = reply(self.ack(Outcome::StaleBinding));
                } else {
                    let _ = reply(self.ack(Outcome::DispatchFailed));
                }
                RouteOutcome::Started
            }
        }
    }

    fn revalidate_binding(&self, conversation_id: &str) -> Result<(), Outcome> {
        let conversation = self
            .store
            .get_conversation(conversation_id)
            .map_err(|_| Outcome::StaleBinding)?;
        if conversation.archived {
            return Err(Outcome::ArchivedBinding);
        }
        if conversation.read_only {
            return Err(Outcome::ReadOnlyBinding);
        }
        if matches!(
            conversation.relationship,
            Some(crate::agent_store::ConversationRelationship::Subagent)
                | Some(crate::agent_store::ConversationRelationship::TeamMember)
        ) {
            return Err(Outcome::TeamOwnedBinding);
        }
        Ok(())
    }

    fn ack(&self, outcome: Outcome) -> String {
        let (en, zh) = match outcome {
            Outcome::Started => ("Sent to the Session.", "已发送给 Session。"),
            Outcome::Queued => (
                "The Session is busy — your message joined the queue.",
                "Session 正忙，消息已加入队列。",
            ),
            Outcome::InteractiveResolved => ("Done.", "已处理。"),
            Outcome::PermissionExpired => ("That request already expired.", "该请求已过期。"),
            Outcome::NoBinding => (
                "No Session is bound. Bind one from Kubecode Settings first.",
                "尚未绑定 Session，请先在 Kubecode 设置中绑定。",
            ),
            Outcome::StaleBinding => (
                "The bound Session is no longer available. Rebind from Settings.",
                "绑定的 Session 已不可用，请在设置中重新绑定。",
            ),
            Outcome::ArchivedBinding => {
                ("The bound Session is archived.", "绑定的 Session 已归档。")
            }
            Outcome::ReadOnlyBinding => {
                ("The bound Session is read-only.", "绑定的 Session 为只读。")
            }
            Outcome::TeamOwnedBinding => (
                "Team Sessions cannot be driven from WeChat.",
                "无法通过微信驱动团队 Session。",
            ),
            Outcome::DispatchFailed => (
                "The Session could not accept the message.",
                "Session 无法接收该消息。",
            ),
        };
        match self.language {
            ChannelLanguage::En => en.to_owned(),
            ChannelLanguage::ZhCn => zh.to_owned(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Started,
    Queued,
    InteractiveResolved,
    PermissionExpired,
    NoBinding,
    StaleBinding,
    ArchivedBinding,
    ReadOnlyBinding,
    TeamOwnedBinding,
    DispatchFailed,
}
