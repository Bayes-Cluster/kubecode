//! The production sink: a route becomes a prompt of the recipient's Session.
//! The runtime admits a prompt under its client message id, so a repeated
//! delivery of the same route is the same prompt; a busy Session queues it
//! durably behind the running turn, which is delivery, not failure.

use std::sync::Arc;

use super::{DeliveryOutcome, DeliveryRequest, RouteSink};
use crate::agent_runtime::{AgentRuntime, RuntimeError, SessionConfigInput, StartAgentRun};
use crate::agents::StoreError;
use crate::member_store::{MemberStore, PendingConfig};

pub struct RuntimeSink {
    runtime: Arc<AgentRuntime>,
    members: Option<Arc<MemberStore>>,
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
        self.members = Some(members);
        self
    }

    /// Applies the member's configuration to the Session. Failing to is a
    /// setup problem the roster shows, and the delivery is retried.
    fn configure(&self, conversation_id: &str) -> Result<Option<PendingConfig>, String> {
        let Some(members) = &self.members else {
            return Ok(None);
        };
        let Some(pending) = members
            .pending_config(conversation_id)
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| "no runtime to configure the Session on".to_owned())?;
        for (id, value) in &pending.values {
            let result = handle.block_on(self.runtime.set_session_config(
                conversation_id,
                id.clone(),
                SessionConfigInput::ValueId(value.clone()),
            ));
            if let Err(error) = result {
                let reason = format!("could not set {id} to {value}: {error}");
                let _ = members.record_setup_error(&pending.member_id, &reason);
                return Err(reason);
            }
        }
        let _ = members.mark_config_applied(&pending);
        Ok(Some(pending))
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
        if let Err(reason) = self.configure(request.conversation_id) {
            return DeliveryOutcome::Failed(reason);
        }
        let brief = self.members.as_ref().and_then(|members| {
            members
                .pending_brief(request.conversation_id)
                .ok()
                .flatten()
        });
        let message = match &brief {
            Some(brief) => format!("{}{}", brief.text, request.body),
            None => request.body.to_owned(),
        };
        match self.runtime.start_or_queue(StartAgentRun {
            conversation_id: request.conversation_id.to_owned(),
            project_id: request.project_id.to_owned(),
            message,
            client_message_id: Some(client_message_id),
        }) {
            Ok(_) => {
                if let (Some(members), Some(brief)) = (&self.members, &brief) {
                    let _ = members.mark_briefed(brief);
                }
                DeliveryOutcome::Delivered
            }
            Err(RuntimeError::Store(StoreError::ActiveRun(_))) => DeliveryOutcome::Busy,
            Err(error) => DeliveryOutcome::Failed(error.to_string()),
        }
    }
}
