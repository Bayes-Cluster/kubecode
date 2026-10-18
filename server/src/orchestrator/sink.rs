//! The production sink: a route becomes a prompt of the recipient's Session.
//! The runtime admits a prompt under its client message id, so a repeated
//! delivery of the same route is the same prompt; a busy Session queues it
//! durably behind the running turn, which is delivery, not failure.

use std::sync::Arc;

use super::{DeliveryOutcome, DeliveryRequest, RouteSink};
use crate::agent_runtime::{AgentRuntime, RuntimeError, StartAgentRun};
use crate::agents::StoreError;

pub struct RuntimeSink {
    runtime: Arc<AgentRuntime>,
}

impl RuntimeSink {
    pub fn new(runtime: Arc<AgentRuntime>) -> Self {
        Self { runtime }
    }
}

impl RouteSink for RuntimeSink {
    fn deliver(&self, request: &DeliveryRequest<'_>) -> DeliveryOutcome {
        let client_message_id = format!("route:{}", request.delivery_key);
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
        match self.runtime.start_or_queue(StartAgentRun {
            conversation_id: request.conversation_id.to_owned(),
            project_id: request.project_id.to_owned(),
            message: request.body.to_owned(),
            client_message_id: Some(client_message_id),
        }) {
            Ok(_) => DeliveryOutcome::Delivered,
            Err(RuntimeError::Store(StoreError::ActiveRun(_))) => DeliveryOutcome::Busy,
            Err(error) => DeliveryOutcome::Failed(error.to_string()),
        }
    }
}
