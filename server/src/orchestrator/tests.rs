use std::sync::{Arc, Mutex};

use super::*;
use crate::agents::AgentId;
use crate::channel_store::{
    Channel, ChannelStore, Intent, Mention, MessageKind, MessageQuery, NewMessage, Scope, Thread,
};
use crate::experiment_store::testing::Fixture;
use crate::work_store::{Actor, CoordinatorAuth};

struct Rig {
    f: Fixture,
    channels: Arc<ChannelStore>,
    work: Arc<WorkStore>,
    orchestrator: Orchestrator,
}

fn rig() -> Rig {
    let f = Fixture::new();
    let work =
        Arc::new(WorkStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap());
    let channels =
        Arc::new(ChannelStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap());
    let orchestrator = Orchestrator::new(
        f.agents.database(),
        Arc::clone(&f.agents),
        Arc::clone(&channels),
        Arc::clone(&work),
        Arc::clone(&f.research),
    )
    .unwrap();
    Rig {
        f,
        channels,
        work,
        orchestrator,
    }
}

/// A sink that records every delivery and plays back scripted outcomes.
#[derive(Default)]
struct Recording {
    script: Mutex<Vec<DeliveryOutcome>>,
    delivered: Mutex<Vec<(String, String, String)>>,
}

impl Recording {
    fn script(&self, outcomes: Vec<DeliveryOutcome>) {
        *self.script.lock().unwrap() = outcomes.into_iter().rev().collect();
    }

    fn deliveries(&self) -> Vec<(String, String, String)> {
        self.delivered.lock().unwrap().clone()
    }
}

impl RouteSink for Recording {
    fn deliver(&self, request: &DeliveryRequest<'_>) -> DeliveryOutcome {
        let outcome = self
            .script
            .lock()
            .unwrap()
            .pop()
            .unwrap_or(DeliveryOutcome::Delivered);
        if outcome == DeliveryOutcome::Delivered {
            self.delivered.lock().unwrap().push((
                request.conversation_id.to_owned(),
                request.delivery_key.to_owned(),
                request.body.to_owned(),
            ));
        }
        outcome
    }
}

impl Rig {
    fn project(&self) -> &str {
        &self.f.project_id
    }

    fn channel(&self) -> Channel {
        self.channels.default_channel(self.project()).unwrap()
    }

    fn leader(&self) -> String {
        self.f.leader.conversation_id.clone()
    }

    /// A Thread rooted at a discussion message, linked to the round's question.
    fn linked_thread(&self, linked: bool) -> Thread {
        let channel = self.channel();
        let root = self
            .channels
            .post(
                self.project(),
                &channel.id,
                NewMessage {
                    body: "Let's study pruning",
                    ..Default::default()
                },
            )
            .unwrap()
            .0;
        let (thread, _) = self
            .channels
            .start_thread(self.project(), &channel.id, &root.id, None, None)
            .unwrap();
        if linked {
            self.channels
                .link_thread(
                    self.project(),
                    &thread.id,
                    1,
                    Some(&self.f.research_id),
                    Some(&self.f.round_id),
                )
                .unwrap()
        } else {
            thread
        }
    }

    fn ask(&self, thread: &Thread, intent: Intent, key: &str, mention: Option<&str>) -> Message {
        let mentions = mention
            .map(|id| {
                vec![Mention {
                    session_id: id.to_owned(),
                }]
            })
            .unwrap_or_default();
        self.channels
            .post(
                self.project(),
                &thread.channel_id,
                NewMessage {
                    thread_id: Some(&thread.id),
                    body: "Please run the pruning sweep",
                    intent: Some(intent),
                    mentions: &mentions,
                    client_message_id: Some(key),
                    ..Default::default()
                },
            )
            .unwrap()
            .0
    }

    fn thread_texts(&self, thread: &Thread) -> Vec<String> {
        self.channels
            .messages(
                self.project(),
                &thread.channel_id,
                MessageQuery {
                    scope: Scope::Thread(&thread.id),
                    ..Default::default()
                },
            )
            .unwrap()
            .messages
            .into_iter()
            .filter(|m| m.kind == MessageKind::System || m.author_kind == AuthorKind::System)
            .map(|m| m.body)
            .collect()
    }

    fn handoff_to(&self, new_holder: &str) {
        let current = self
            .work
            .coordinator(self.project(), &self.f.round_id)
            .unwrap()
            .unwrap();
        self.work
            .handoff_coordinator(
                self.project(),
                &self.f.round_id,
                current.epoch,
                new_holder,
                "rotate",
                &Actor::Coordinator(CoordinatorAuth {
                    round_id: self.f.round_id.clone(),
                    holder: current.holder,
                    epoch: current.epoch,
                }),
            )
            .unwrap();
    }

    fn session(&self, title: &str) -> String {
        self.f
            .agents
            .create_conversation(self.project(), AgentId::OpenCode, Some(title))
            .unwrap()
            .id
    }
}

#[test]
fn a_request_in_a_linked_thread_reaches_the_coordinator_exactly_once() {
    let r = rig();
    let thread = r.linked_thread(true);
    let message = r.ask(&thread, Intent::Request, "q1", None);
    let sink = Recording::default();

    // Routing twice (a restarted loop, a duplicate wake) makes one route.
    assert_eq!(r.orchestrator.route_intents().unwrap().routed, 1);
    assert_eq!(
        r.orchestrator.route_intents().unwrap(),
        RoutingReport::default()
    );
    let routes = r.orchestrator.routes(r.project(), None, 10).unwrap();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].kind, RouteKind::Request);
    assert_eq!(
        routes[0].target,
        Target::Coordinator {
            round_id: r.f.round_id.clone()
        }
    );
    assert!(routes[0].body.contains("Please run the pruning sweep"));
    assert!(routes[0].body.contains("cannot widen"));
    assert_eq!(
        r.channels
            .message(r.project(), &message.id)
            .unwrap()
            .intent_claimed_by
            .as_deref(),
        Some(ORCHESTRATOR)
    );

    let report = r.orchestrator.deliver_due(&sink, 1_000).unwrap();
    assert_eq!(report.delivered, 1);
    // Delivering again, or from a second worker, does nothing more.
    assert_eq!(
        r.orchestrator.deliver_due(&sink, 1_000).unwrap(),
        DeliveryReport::default()
    );
    let deliveries = sink.deliveries();
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].0, r.leader());
    assert_eq!(
        deliveries[0].1, routes[0].id,
        "the delivery key is the route id"
    );
    let stored = r.orchestrator.route(r.project(), &routes[0].id).unwrap();
    assert_eq!(
        (stored.state, stored.recipient),
        (RouteState::Delivered, Some(r.leader()))
    );
    // The Thread shows what happened, once.
    let notes = r.thread_texts(&thread);
    assert_eq!(
        notes
            .iter()
            .filter(|n| n.contains("passed to the round's coordinator"))
            .count(),
        1
    );
}

#[test]
fn a_request_without_an_approved_round_is_answered_not_acted_on() {
    let r = rig();
    let unlinked = r.linked_thread(false);
    let message = r.ask(&unlinked, Intent::Request, "q1", None);
    assert_eq!(
        r.orchestrator.route_intents().unwrap(),
        RoutingReport {
            routed: 0,
            denied: 1
        }
    );
    assert!(
        r.orchestrator
            .routes(r.project(), None, 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        r.thread_texts(&unlinked)
            .iter()
            .any(|note| note.contains("no approved round"))
    );
    assert_eq!(
        r.channels
            .message(r.project(), &message.id)
            .unwrap()
            .intent_claimed_by
            .as_deref(),
        Some(ORCHESTRATOR)
    );
    // Asking again is a new request, evaluated on its own.
    r.ask(&unlinked, Intent::Request, "q2", None);
    assert_eq!(r.orchestrator.route_intents().unwrap().denied, 1);

    // A resolved or archived question admits nothing either.
    let thread = r.linked_thread(true);
    r.f.research
        .set_status(
            r.project(),
            &r.f.research_id,
            crate::research_store::ResearchStatus::Resolved,
        )
        .unwrap();
    r.ask(&thread, Intent::Request, "q3", None);
    assert_eq!(r.orchestrator.route_intents().unwrap().denied, 1);
}

#[test]
fn a_mention_goes_to_the_designated_session_only() {
    let r = rig();
    let thread = r.linked_thread(true);
    let analyst = r.session("Analyst");
    let bystander = r.session("Bystander");
    r.ask(&thread, Intent::Ask, "a1", Some(&analyst));
    assert_eq!(r.orchestrator.route_intents().unwrap().routed, 1);
    let sink = Recording::default();
    r.orchestrator.deliver_due(&sink, 1).unwrap();
    let deliveries = sink.deliveries();
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].0, analyst);
    assert_ne!(deliveries[0].0, bystander);
    assert!(deliveries[0].2.contains("does not authorize starting work"));
}

#[test]
fn a_crash_between_routing_and_claiming_is_repaired_without_a_second_route() {
    let r = rig();
    let thread = r.linked_thread(true);
    let message = r.ask(&thread, Intent::Request, "q1", None);
    // The route was written; the process died before the claim.
    r.orchestrator
        .create_route(NewRoute {
            project_id: r.project(),
            kind: RouteKind::Request,
            source_kind: SourceKind::Message,
            source_id: &message.id,
            target: Target::Coordinator {
                round_id: r.f.round_id.clone(),
            },
            channel_id: Some(&message.channel_id),
            thread_id: message.thread_id.as_deref(),
            body: "framed",
        })
        .unwrap();
    assert!(
        r.channels
            .message(r.project(), &message.id)
            .unwrap()
            .intent_claimed_by
            .is_none()
    );
    r.orchestrator.route_intents().unwrap();
    assert_eq!(
        r.orchestrator.routes(r.project(), None, 10).unwrap().len(),
        1
    );
    assert!(
        r.channels
            .message(r.project(), &message.id)
            .unwrap()
            .intent_claimed_by
            .is_some()
    );
}

#[test]
fn a_handoff_retargets_what_was_pending_and_the_old_coordinator_hears_nothing() {
    let r = rig();
    let thread = r.linked_thread(true);
    r.ask(&thread, Intent::Request, "q1", None);
    r.orchestrator.route_intents().unwrap();
    let successor = r.session("Successor");
    let sink = Recording::default();
    // The first attempt finds the coordinator busy.
    sink.script(vec![DeliveryOutcome::Busy]);
    assert_eq!(r.orchestrator.deliver_due(&sink, 100).unwrap().retried, 1);
    r.handoff_to(&successor);
    // Not due yet, then due: it goes to whoever coordinates now.
    assert_eq!(
        r.orchestrator.deliver_due(&sink, 101).unwrap(),
        DeliveryReport::default()
    );
    assert_eq!(
        r.orchestrator.deliver_due(&sink, 10_000).unwrap().delivered,
        1
    );
    let deliveries = sink.deliveries();
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0].0, successor);
    assert_ne!(deliveries[0].0, r.leader());
}

#[test]
fn busy_recipients_are_retried_with_backoff_and_eventually_reported() {
    let r = rig();
    let thread = r.linked_thread(true);
    r.ask(&thread, Intent::Request, "q1", None);
    r.orchestrator.route_intents().unwrap();
    let sink = Recording::default();
    sink.script(vec![DeliveryOutcome::Busy; 3]);
    let mut now = 0;
    for expected in 1..=3 {
        let report = r.orchestrator.deliver_due(&sink, now).unwrap();
        assert_eq!(report.retried, 1, "busy attempt {expected}");
        // Nothing is tried before the backoff elapses.
        assert_eq!(
            r.orchestrator.deliver_due(&sink, now + 1).unwrap(),
            DeliveryReport::default()
        );
        now += 400;
    }
    assert_eq!(r.orchestrator.deliver_due(&sink, now).unwrap().delivered, 1);
    let route = &r.orchestrator.routes(r.project(), None, 1).unwrap()[0];
    assert_eq!(
        (route.state, route.busy, route.attempts),
        (RouteState::Delivered, 3, 0)
    );

    // A Session that never frees up becomes a reported failure, not a silent one.
    r.ask(&thread, Intent::Request, "q2", None);
    r.orchestrator.route_intents().unwrap();
    sink.script(vec![DeliveryOutcome::Busy; (MAX_BUSY + 2) as usize]);
    let mut failed = 0;
    for step in 0..(MAX_BUSY + 2) {
        failed += r
            .orchestrator
            .deliver_due(&sink, 100_000 + i64::from(step) * 1_000)
            .unwrap()
            .failed;
    }
    assert_eq!(failed, 1);
    assert!(
        r.thread_texts(&thread)
            .iter()
            .any(|note| note.contains("could not be delivered") && note.contains("busy"))
    );
}

#[test]
fn provider_failures_are_bounded_and_the_researcher_is_told() {
    let r = rig();
    let thread = r.linked_thread(true);
    r.ask(&thread, Intent::Request, "q1", None);
    r.orchestrator.route_intents().unwrap();
    let sink = Recording::default();
    sink.script(vec![
        DeliveryOutcome::Failed("provider unavailable".into());
        MAX_ATTEMPTS as usize
    ]);
    let mut totals = DeliveryReport::default();
    for step in 0..MAX_ATTEMPTS {
        let report = r
            .orchestrator
            .deliver_due(&sink, i64::from(step) * 10_000)
            .unwrap();
        totals.retried += report.retried;
        totals.failed += report.failed;
    }
    assert_eq!(
        (totals.retried, totals.failed),
        (MAX_ATTEMPTS as usize - 1, 1)
    );
    let route = &r.orchestrator.routes(r.project(), None, 1).unwrap()[0];
    assert_eq!(route.state, RouteState::Failed);
    assert_eq!(route.last_error.as_deref(), Some("provider unavailable"));
    assert!(sink.deliveries().is_empty());
    // A failed route is final: later passes leave it alone.
    assert_eq!(
        r.orchestrator.deliver_due(&sink, 999_999).unwrap(),
        DeliveryReport::default()
    );
    assert!(
        r.thread_texts(&thread)
            .iter()
            .any(|note| note.contains("provider unavailable"))
    );
}

#[test]
fn a_crash_after_delivery_repeats_the_delivery_under_the_same_key_after_the_lease() {
    let r = rig();
    let thread = r.linked_thread(true);
    r.ask(&thread, Intent::Request, "q1", None);
    r.orchestrator.route_intents().unwrap();
    let route = r
        .orchestrator
        .routes(r.project(), None, 1)
        .unwrap()
        .remove(0);
    // A worker leased the route and died: nobody else may deliver during the lease.
    r.orchestrator
        .connection()
        .execute(
            "UPDATE message_routes SET lease_until = 500 WHERE id = ?1",
            [&route.id],
        )
        .unwrap();
    let sink = Recording::default();
    assert_eq!(
        r.orchestrator.deliver_due(&sink, 100).unwrap(),
        DeliveryReport::default()
    );
    // After the lease expires the route is tried again with the same key, which
    // the Session's admission de-duplicates.
    assert_eq!(r.orchestrator.deliver_due(&sink, 501).unwrap().delivered, 1);
    assert_eq!(sink.deliveries()[0].1, route.id);
}

#[test]
fn dispatch_and_result_routes_are_idempotent_and_report_to_the_originating_thread() {
    let r = rig();
    let thread = r.linked_thread(true);
    let executor = r.session("Executor");
    let (item, _) = r
        .work
        .create(
            r.project(),
            crate::work_store::NewWork {
                title: "Sweep ratios",
                description: "Try 10%, 30%, 50%",
                round_id: Some(&r.f.round_id),
                derived_from: Some(("thread", &thread.id)),
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap();
    let first = r
        .orchestrator
        .route_dispatch(r.project(), &item, "attempt-1", &executor)
        .unwrap();
    let again = r
        .orchestrator
        .route_dispatch(r.project(), &item, "attempt-1", &executor)
        .unwrap();
    assert_eq!(first.id, again.id);
    assert_eq!(
        r.orchestrator.routes(r.project(), None, 10).unwrap().len(),
        1
    );

    let result = r
        .orchestrator
        .route_result(r.project(), &item, "attempt-1", "accuracy 0.91 at 30%")
        .unwrap()
        .unwrap();
    let repeat = r
        .orchestrator
        .route_result(r.project(), &item, "attempt-1", "accuracy 0.91 at 30%")
        .unwrap()
        .unwrap();
    assert_eq!(result.id, repeat.id);
    assert_eq!(
        result.target,
        Target::Coordinator {
            round_id: r.f.round_id.clone()
        }
    );
    // The Thread hears about the result exactly once.
    let notes = r.thread_texts(&thread);
    assert_eq!(
        notes
            .iter()
            .filter(|n| n.contains("accuracy 0.91 at 30%"))
            .count(),
        1
    );
}

#[test]
fn another_projects_messages_never_route_into_this_one() {
    let r = rig();
    let thread = r.linked_thread(true);
    let other = r.f.workspace.create_project(".", "beta").unwrap();
    let theirs = r.channels.default_channel(&other.id).unwrap();
    r.channels
        .post(
            &other.id,
            &theirs.id,
            NewMessage {
                body: "run it",
                intent: Some(Intent::Request),
                client_message_id: Some("x"),
                ..Default::default()
            },
        )
        .unwrap();
    // The other Project has no round: its request is denied, nothing reaches us.
    let report = r.orchestrator.route_intents().unwrap();
    assert_eq!(
        report,
        RoutingReport {
            routed: 0,
            denied: 1
        }
    );
    assert!(
        r.orchestrator
            .routes(r.project(), None, 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        r.orchestrator
            .routes(&other.id, None, 10)
            .unwrap()
            .is_empty()
    );
    let _ = thread;
}
