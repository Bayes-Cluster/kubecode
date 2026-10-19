//! The production sink: a route becomes a prompt of the recipient's Session.
//! The runtime admits a prompt under its client message id, so a repeated
//! delivery of the same route is the same prompt; a busy Session queues it
//! durably behind the running turn, which is delivery, not failure.

use std::sync::Arc;
use std::time::Duration;

use super::{DeliveryOutcome, DeliveryRequest, RouteSink};
use crate::agent_runtime::{AgentRuntime, RuntimeError, SessionConfigInput, StartAgentRun};
use crate::agents::StoreError;
use crate::member_store::{Binding, Brief, MemberStore, PendingConfig};

/// How long one configuration value may take to apply before the delivery
/// is retried instead of stalling every other delivery behind it.
const CONFIG_TIMEOUT: Duration = Duration::from_secs(20);

/// Applies one provider-reported configuration value to a Session. A seam so
/// the member delivery rules can be exercised without a provider.
pub trait SessionConfigurator: Send + Sync {
    fn set(&self, conversation_id: &str, id: &str, value: &str) -> Result<(), String>;
}

struct RuntimeConfigurator(Arc<AgentRuntime>);

impl SessionConfigurator for RuntimeConfigurator {
    fn set(&self, conversation_id: &str, id: &str, value: &str) -> Result<(), String> {
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "no runtime to configure the Session on".to_owned())?;
        let runtime = Arc::clone(&self.0);
        let (conversation, id, value) =
            (conversation_id.to_owned(), id.to_owned(), value.to_owned());
        handle
            .block_on(async move {
                tokio::time::timeout(
                    CONFIG_TIMEOUT,
                    runtime.set_session_config(
                        &conversation,
                        id,
                        SessionConfigInput::ValueId(value),
                    ),
                )
                .await
            })
            .map_err(|_| "the Session did not answer in time".to_owned())?
            .map_err(|error| error.to_string())
    }
}

/// Member delivery that configures Sessions through the runtime.
pub fn runtime_member_delivery(
    runtime: Arc<AgentRuntime>,
    members: Arc<MemberStore>,
) -> MemberDelivery {
    MemberDelivery::new(members, Arc::new(RuntimeConfigurator(runtime)))
}

/// What a member's Session is owed before its next prompt (ADR 0220): its
/// configuration values, once per specification revision, and the role brief.
pub struct MemberDelivery {
    members: Arc<MemberStore>,
    configurator: Arc<dyn SessionConfigurator>,
}

/// The work done before a prompt, to commit once the prompt was accepted.
pub struct Prepared {
    brief: Option<Brief>,
}

impl MemberDelivery {
    pub fn new(members: Arc<MemberStore>, configurator: Arc<dyn SessionConfigurator>) -> Self {
        Self {
            members,
            configurator,
        }
    }

    /// Applies pending configuration (a rejected value is a setup problem the
    /// roster shows) and finds the brief. `Err` is a reason to retry later.
    pub fn prepare(&self, conversation_id: &str) -> Result<Prepared, String> {
        self.apply_config(conversation_id)?;
        let brief = self
            .members
            .pending_brief(conversation_id)
            .map_err(|error| error.to_string())?;
        Ok(Prepared { brief })
    }

    /// Applies the member's configuration to the Session if it has not been.
    pub fn apply_config(&self, conversation_id: &str) -> Result<(), String> {
        let Some(pending) = self
            .members
            .pending_config(conversation_id)
            .map_err(|error| error.to_string())?
        else {
            return Ok(());
        };
        self.apply(conversation_id, &pending)
    }

    fn apply(&self, conversation_id: &str, pending: &PendingConfig) -> Result<(), String> {
        // `model` first: other options (reasoning effort) can depend on it.
        let mut values = pending.values.clone();
        values.sort_by_key(|(id, _)| (id != "model", id.clone()));
        for (id, value) in &values {
            if let Err(error) = self.configurator.set(conversation_id, id, value) {
                let reason = format!("could not set {id} to {value}: {error}");
                // A private Session's problem does not make the member
                // unassignable for shared work.
                if pending.binding == Binding::Public {
                    let _ = self.members.record_setup_error(&pending.member_id, &reason);
                }
                return Err(reason);
            }
        }
        self.members
            .mark_config_applied(pending)
            .map_err(|error| error.to_string())
    }

    /// The prompt with the brief in front of it, if one is owed.
    pub fn message(prepared: &Prepared, body: &str) -> String {
        match &prepared.brief {
            Some(brief) => format!("{}{body}", brief.text),
            None => body.to_owned(),
        }
    }

    pub fn commit(&self, prepared: &Prepared) {
        if let Some(brief) = &prepared.brief {
            let _ = self.members.mark_briefed(brief);
        }
    }
}

pub struct RuntimeSink {
    runtime: Arc<AgentRuntime>,
    members: Option<MemberDelivery>,
}

impl RuntimeSink {
    pub fn new(runtime: Arc<AgentRuntime>) -> Self {
        Self {
            runtime,
            members: None,
        }
    }

    /// Delivers to members: a Session is given its configuration and role
    /// brief before the first prompt after its member's specification changed
    /// (ADR 0220), not on every message.
    pub fn with_members(mut self, members: Arc<MemberStore>) -> Self {
        let configurator = Arc::new(RuntimeConfigurator(Arc::clone(&self.runtime)));
        self.members = Some(MemberDelivery::new(members, configurator));
        self
    }

    /// Same, with another way to configure a Session.
    pub fn with_member_delivery(mut self, delivery: MemberDelivery) -> Self {
        self.members = Some(delivery);
        self
    }
}

impl RouteSink for RuntimeSink {
    fn deliver(&self, request: &DeliveryRequest<'_>) -> DeliveryOutcome {
        // Per recipient: a route retargeted by a handoff after a delivery to
        // the old holder must still reach the new one.
        let client_message_id =
            format!("route:{}:{}", request.delivery_key, request.conversation_id);
        // A restart can repeat a delivery that already reached the Session.
        if self
            .runtime
            .store_ref()
            .run_by_client_message_id(&client_message_id)
            .ok()
            .flatten()
            .is_some()
        {
            return DeliveryOutcome::Delivered;
        }
        let prepared = match &self.members {
            Some(delivery) => match delivery.prepare(request.conversation_id) {
                Ok(prepared) => Some(prepared),
                Err(reason) => return DeliveryOutcome::Failed(reason),
            },
            None => None,
        };
        let message = match &prepared {
            Some(prepared) => MemberDelivery::message(prepared, request.body),
            None => request.body.to_owned(),
        };
        match self.runtime.start_or_queue(StartAgentRun {
            conversation_id: request.conversation_id.to_owned(),
            project_id: request.project_id.to_owned(),
            message,
            client_message_id: Some(client_message_id),
        }) {
            Ok(_) => {
                if let (Some(delivery), Some(prepared)) = (&self.members, &prepared) {
                    delivery.commit(prepared);
                }
                DeliveryOutcome::Delivered
            }
            Err(RuntimeError::Store(StoreError::ActiveRun(_))) => DeliveryOutcome::Busy,
            Err(error) => DeliveryOutcome::Failed(error.to_string()),
        }
    }
}
