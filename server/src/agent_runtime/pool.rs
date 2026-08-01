use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::sync::oneshot;

use super::actor::SessionCommand;
use super::{AgentRuntime, AgentRuntimeSessionCounts};

#[derive(Clone, Copy, Debug)]
pub(crate) struct SessionActorPolicy {
    pub(super) idle_timeout: Duration,
    pub(super) maximum_warm_actors: usize,
}

impl Default for SessionActorPolicy {
    fn default() -> Self {
        Self {
            idle_timeout: Duration::from_secs(2 * 60),
            maximum_warm_actors: 4,
        }
    }
}

impl AgentRuntime {
    pub fn session_counts(&self) -> AgentRuntimeSessionCounts {
        let sessions = self.sessions.lock().expect("agent session mutex poisoned");
        let active = sessions
            .values()
            .filter(|handle| handle.active.load(Ordering::Acquire))
            .count();
        AgentRuntimeSessionCounts {
            active,
            idle: sessions.len().saturating_sub(active),
        }
    }

    pub fn session_actor_warm_limit(&self) -> usize {
        self.session_actor_policy.maximum_warm_actors
    }

    pub(super) fn enforce_warm_actor_limit(&self, protected_conversation_id: Option<&str>) {
        let mut shutdown = Vec::new();
        {
            let mut sessions = self.sessions.lock().expect("agent session mutex poisoned");
            let mut idle = sessions
                .iter()
                .filter(|(conversation_id, handle)| {
                    !handle.active.load(Ordering::Acquire)
                        && protected_conversation_id != Some(conversation_id.as_str())
                })
                .map(|(conversation_id, handle)| {
                    (
                        conversation_id.clone(),
                        handle.last_activity.load(Ordering::Acquire),
                    )
                })
                .collect::<Vec<_>>();
            let protected_idle = protected_conversation_id
                .and_then(|id| sessions.get(id))
                .is_some_and(|handle| !handle.active.load(Ordering::Acquire));
            let warm_count = idle.len() + usize::from(protected_idle);
            if warm_count <= self.session_actor_policy.maximum_warm_actors {
                return;
            }
            idle.sort_by_key(|(_, activity)| *activity);
            for (conversation_id, _) in idle
                .into_iter()
                .take(warm_count - self.session_actor_policy.maximum_warm_actors)
            {
                if let Some(handle) = sessions.remove(&conversation_id) {
                    shutdown.push(handle.sender);
                }
            }
        }
        for sender in shutdown {
            let (response, _disconnected) = oneshot::channel();
            let _ = sender.send(SessionCommand::Shutdown { response });
        }
    }
}
