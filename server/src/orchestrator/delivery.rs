//! The delivery state of the researcher's messages (ADR 0232), from facts
//! only: how the orchestrator read the message, its routes, and whether the
//! recipient Session admitted the prompt under the route's delivery key.
//! "Delivered" keeps ADR 0217's meaning: the Session has it.

use rusqlite::params_from_iter;
use serde::Serialize;

use super::*;
use crate::attention::MemberRef;
use crate::channel_store::RoutingMark;

/// Times the researcher may re-arm one failed route.
pub const MAX_MANUAL_RETRIES: u32 = 3;
/// Route kinds the researcher originated, and so may retry.
pub const RETRYABLE: [RouteKind; 6] = [
    RouteKind::Discussion,
    RouteKind::Mention,
    RouteKind::Ask,
    RouteKind::Request,
    RouteKind::TaskReview,
    RouteKind::Decision,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteDeliveryState {
    /// Waiting for its first attempt.
    Sending,
    /// An attempt failed and another is due.
    Retrying,
    /// The recipient was busy; it is tried again.
    Busy,
    /// Delivered, and waiting in the Session's queue.
    Queued,
    /// Delivered, and the Session's turn started.
    Started,
    /// Delivered, but neither a turn nor a queued prompt exists any more.
    Withdrawn,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct RouteDelivery {
    pub route_id: String,
    pub kind: RouteKind,
    pub recipient: Option<MemberRef>,
    pub recipient_session: Option<String>,
    pub state: RouteDeliveryState,
    pub attempts: u32,
    pub busy: u32,
    pub retries: u32,
    pub last_error: Option<String>,
    pub delivered_at: Option<String>,
    pub retryable: bool,
    /// A review verdict the Task has moved past: listed, never retried.
    pub superseded: bool,
    /// The routing notes about this route, which the browser folds in.
    pub note_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageDeliveryState {
    /// Saved; the orchestrator has not read it yet.
    Saved,
    /// Recorded and never routed (a Thread reply, for example).
    Recorded,
    Sending,
    Delivered,
    /// Some recipients have it, not all.
    Partial,
    Failed,
    /// It reached nobody.
    Denied,
}

#[derive(Clone, Debug, Serialize)]
pub struct Denial {
    /// `manager_unavailable`, `member_unavailable`, `dm_private`, or `request_refused`.
    pub code: String,
    pub reroutable: bool,
    pub note_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MessageDelivery {
    pub message_id: String,
    pub state: MessageDeliveryState,
    pub routes: Vec<RouteDelivery>,
    pub denial: Option<Denial>,
}

/// One route of a source that is not a message (a review decision, an answer).
#[derive(Clone, Debug, Serialize)]
pub struct SourceDelivery {
    pub source_kind: SourceKind,
    pub source_id: String,
    pub route: RouteDelivery,
}

/// What a retry did.
#[derive(Clone, Debug)]
pub enum RetryOutcome {
    /// It was failed and is pending again, under the same route.
    Requeued(Route),
    /// It was not failed (already retried, or never failed): nothing changed.
    AlreadyMoving(Route),
}

pub use crate::channel_store::MAX_REROUTES;

/// SQL: whether the review `t` is still its Task's newest step — its verdict
/// is the Task's last stage-affecting event — and the Task is not archived.
/// Only such a verdict may still be delivered (ADR 0232).
pub(super) const REVIEW_IS_CURRENT: &str = "(SELECT e.ref_id FROM task_events e
       WHERE e.research_id = t.research_id ORDER BY e.seq DESC LIMIT 1) = t.id
     AND NOT EXISTS (SELECT 1 FROM research_questions q
       WHERE q.id = t.research_id AND q.archived <> 0)";

/// A message's state from its mark and its routes. Pure.
pub fn aggregate(mark: &RoutingMark, routes: &[RouteDelivery]) -> MessageDeliveryState {
    use RouteDeliveryState as R;
    match mark.routing.as_deref() {
        Some("pending") => return MessageDeliveryState::Saved,
        Some("denied") => return MessageDeliveryState::Denied,
        _ => {}
    }
    if routes.is_empty() {
        return MessageDeliveryState::Recorded;
    }
    let reached = routes
        .iter()
        .any(|route| matches!(route.state, R::Queued | R::Started | R::Withdrawn));
    if routes.iter().any(|route| route.state == R::Failed) {
        return if reached {
            MessageDeliveryState::Partial
        } else {
            MessageDeliveryState::Failed
        };
    }
    if routes
        .iter()
        .any(|route| matches!(route.state, R::Sending | R::Retrying | R::Busy))
    {
        return MessageDeliveryState::Sending;
    }
    if mark.issue.is_some() {
        return MessageDeliveryState::Partial;
    }
    MessageDeliveryState::Delivered
}

impl Orchestrator {
    /// Re-arms a failed route the researcher originated (ADR 0232), under the
    /// same route identity and so the same delivery key: a Session that
    /// admitted the prompt before the failure gets the same turn, never a
    /// second one. One conditional write; at most `MAX_MANUAL_RETRIES` times.
    /// Each failure after a retry is noted under its own key.
    pub fn retry_route(
        &self,
        project_id: &str,
        route_id: &str,
    ) -> Result<RetryOutcome, OrchestratorError> {
        let route = self.route(project_id, route_id)?;
        if !RETRYABLE.contains(&route.kind) {
            return Err(OrchestratorError::NotRetryable);
        }
        if route.state != RouteState::Failed {
            return Ok(RetryOutcome::AlreadyMoving(route));
        }
        // A conversation route addressed to a Session that is gone (a member
        // removed, a plain Session deleted) cannot be retried; coordinator,
        // decision and review routes find their recipient at delivery.
        if let Target::Session { session_id } = &route.target
            && matches!(
                route.kind,
                RouteKind::Discussion | RouteKind::Mention | RouteKind::Ask
            )
        {
            let session = self
                .member_session(&route, session_id)
                .map_err(|_| OrchestratorError::TargetGone)?;
            if !matches!(
                self.agents.visible_conversation(project_id, &session),
                Ok(Some(_))
            ) {
                return Err(OrchestratorError::TargetGone);
            }
        }
        if route.retries >= MAX_MANUAL_RETRIES {
            return Err(OrchestratorError::RetryLimit);
        }
        // Only the Task's newest verdict, while the Task still stands by it.
        if self.superseded(&route)? {
            return Err(OrchestratorError::Superseded);
        }
        let changed = self.connection().execute(
            "UPDATE message_routes SET state = 'pending', attempts = 0, busy = 0,
               next_attempt_at = 0, lease_until = 0, last_error = NULL, retries = retries + 1
             WHERE id = ?1 AND project_id = ?2 AND state = 'failed'",
            rusqlite::params![route_id, project_id],
        )?;
        let route = self.route(project_id, route_id)?;
        if changed == 0 {
            return Ok(RetryOutcome::AlreadyMoving(route));
        }
        self.announce(&route, "retried");
        self.wake();
        Ok(RetryOutcome::Requeued(route))
    }

    /// Whether this is a review verdict its Task has moved past.
    fn superseded(&self, route: &Route) -> Result<bool, OrchestratorError> {
        if route.kind != RouteKind::TaskReview {
            return Ok(false);
        }
        let current: Option<bool> = self
            .connection()
            .query_row(
                &format!(
                    "SELECT {REVIEW_IS_CURRENT} FROM task_reviews t
                     WHERE t.id = ?1 AND t.project_id = ?2"
                ),
                rusqlite::params![route.source_id, route.project_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(current != Some(true))
    }

    /// The delivery of one route, from its row, the recipient's admission of
    /// `route:{id}:{recipient}`, and the notes written about it.
    fn route_delivery(
        &self,
        route: &Route,
        notes: &std::collections::HashMap<String, (String, u64)>,
    ) -> RouteDelivery {
        let recipient_session = route.recipient.clone().or_else(|| match &route.target {
            Target::Session { session_id } => Some(session_id.clone()),
            Target::Coordinator { .. } => None,
        });
        let recipient = recipient_session.as_deref().and_then(|session| {
            let resolved = self
                .members
                .as_ref()?
                .by_conversation(&route.project_id, session)
                .ok()??;
            Some(MemberRef {
                id: resolved.member.id,
                name: resolved.member.name,
                handle: resolved.member.handle,
                role: resolved.member.role.as_str().to_owned(),
            })
        });
        let state = match route.state {
            RouteState::Pending if route.busy > 0 => RouteDeliveryState::Busy,
            RouteState::Pending if route.attempts > 0 => RouteDeliveryState::Retrying,
            RouteState::Pending => RouteDeliveryState::Sending,
            RouteState::Failed => RouteDeliveryState::Failed,
            RouteState::Delivered => match route.recipient.as_deref().and_then(|session| {
                self.agents
                    .prompt_admission(&format!("route:{}:{session}", route.id))
                    .ok()
                    .flatten()
            }) {
                Some(crate::agent_store::Admission::Started { .. }) => RouteDeliveryState::Started,
                Some(crate::agent_store::Admission::Queued { .. }) => RouteDeliveryState::Queued,
                None => RouteDeliveryState::Withdrawn,
            },
        };
        let superseded = self.superseded(route).unwrap_or(false);
        let note_ids = route_note_keys(route)
            .iter()
            .filter_map(|key| notes.get(key).map(|(id, _)| id.clone()))
            .collect();
        RouteDelivery {
            route_id: route.id.clone(),
            kind: route.kind,
            recipient,
            recipient_session,
            state,
            attempts: route.attempts,
            busy: route.busy,
            retries: route.retries,
            last_error: route.last_error.clone(),
            delivered_at: route.delivered_at.clone(),
            retryable: state == RouteDeliveryState::Failed
                && RETRYABLE.contains(&route.kind)
                && route.retries < MAX_MANUAL_RETRIES
                && !superseded,
            superseded,
            note_ids,
        }
    }

    /// A Task's deliveries that went wrong or are being retried: the
    /// researcher's review decisions on it, and answers to questions on its
    /// work, that did not reach their recipient (ADR 0232).
    pub fn task_delivery_issues(
        &self,
        project_id: &str,
        research_id: &str,
    ) -> Result<Vec<SourceDelivery>, OrchestratorError> {
        let routes: Vec<Route> = {
            let connection = self.connection();
            let mut statement = connection.prepare(&format!(
                "{ROUTE_SELECT} WHERE project_id = ?1
                   AND (state = 'failed' OR (state = 'pending' AND attempts > 0))
                   AND ((kind = 'task_review' AND source_id IN
                          (SELECT id FROM task_reviews WHERE research_id = ?2))
                        OR (kind = 'decision' AND work_id IN
                          (SELECT id FROM work_items WHERE research_id = ?2)))
                 ORDER BY created_at, rowid"
            ))?;
            statement
                .query_map(rusqlite::params![project_id, research_id], route_from_row)?
                .collect::<Result<Vec<_>, _>>()?
        };
        let keys: Vec<String> = routes.iter().flat_map(route_note_keys).collect();
        let notes = self.channels.messages_by_client_ids(project_id, &keys)?;
        Ok(routes
            .iter()
            .map(|route| SourceDelivery {
                source_kind: route.source_kind,
                source_id: route.source_id.clone(),
                route: self.route_delivery(route, &notes),
            })
            .collect())
    }

    /// Routes whose source is one of these messages.
    fn routes_of_messages(
        &self,
        project_id: &str,
        message_ids: &[String],
    ) -> Result<Vec<Route>, OrchestratorError> {
        let connection = self.connection();
        let mut routes = Vec::new();
        for chunk in message_ids.chunks(100) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut statement = connection.prepare(&format!(
                "{ROUTE_SELECT} WHERE source_kind = 'message' AND source_id IN ({marks})
                   AND project_id = ?{} ORDER BY created_at, rowid",
                chunk.len() + 1
            ))?;
            let values: Vec<&str> = chunk
                .iter()
                .map(String::as_str)
                .chain(std::iter::once(project_id))
                .collect();
            routes.extend(
                statement
                    .query_map(params_from_iter(values), route_from_row)?
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        Ok(routes)
    }

    /// The delivery of each of these messages that the researcher wrote, in
    /// the order asked; other messages are skipped.
    pub fn deliveries_for(
        &self,
        project_id: &str,
        message_ids: &[String],
    ) -> Result<Vec<MessageDelivery>, OrchestratorError> {
        let messages: Vec<Message> = self
            .channels
            .messages_by_ids(project_id, message_ids)?
            .into_iter()
            .filter(|message| message.author_kind == AuthorKind::Researcher)
            .collect();
        let ids: Vec<String> = messages.iter().map(|message| message.id.clone()).collect();
        let marks = self.channels.routing_marks(project_id, &ids)?;
        let routes = self.routes_of_messages(project_id, &ids)?;
        let mut keys: Vec<String> = routes.iter().flat_map(route_note_keys).collect();
        for (id, mark) in &marks {
            keys.extend(denial_note_keys(id, mark.reroutes));
        }
        let notes = self.channels.messages_by_client_ids(project_id, &keys)?;
        let mut deliveries = Vec::new();
        for id in message_ids {
            let Some(mark) = marks.get(id) else {
                continue;
            };
            let routes: Vec<RouteDelivery> = routes
                .iter()
                .filter(|route| route.source_id == *id)
                .map(|route| self.route_delivery(route, &notes))
                .collect();
            let denial =
                (mark.routing.as_deref() == Some("denied") || mark.issue.is_some()).then(|| {
                    Denial {
                        code: mark
                            .issue
                            .clone()
                            .unwrap_or_else(|| "manager_unavailable".to_owned()),
                        reroutable: mark.reroutes < MAX_REROUTES,
                        note_id: denial_note_keys(id, mark.reroutes)
                            .iter()
                            .rev()
                            .find_map(|key| notes.get(key).map(|(id, _)| id.clone())),
                    }
                });
            deliveries.push(MessageDelivery {
                message_id: id.clone(),
                state: aggregate(mark, &routes),
                routes,
                denial,
            });
        }
        Ok(deliveries)
    }
}

/// The keys of the notes written about a route: its failures, one per retry,
/// and the delivery note of a request.
fn route_note_keys(route: &Route) -> Vec<String> {
    let mut keys = vec![
        format!("route-failed:{}", route.id),
        format!("route-delivered:{}", route.id),
    ];
    keys.extend((1..=route.retries).map(|retry| format!("route-failed:{}:{retry}", route.id)));
    keys
}

/// The keys of a message's denial notes, one per reroute.
pub(super) fn denial_note_keys(message_id: &str, reroutes: u32) -> Vec<String> {
    let mut keys = vec![format!("route-denied:{message_id}")];
    keys.extend((1..=reroutes).map(|reroute| format!("route-denied:{message_id}:{reroute}")));
    keys
}
