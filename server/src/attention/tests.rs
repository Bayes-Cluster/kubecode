//! The rules of `project`, one fixture per rule.

use std::collections::HashMap;

use serde_json::json;

use super::*;
use crate::agent_runtime::{PendingKind, PendingOptionView, PendingRequestView};
use crate::agent_store::{ActiveRun, LatestRun, RunStatus};
use crate::orchestrator::RouteKind;
use crate::task_store::{AwaitingProposal, ReviewRequest};
use crate::work_store::{DecisionRequest, OpenAssignment, OpenDecision};

fn analyst() -> MemberRef {
    MemberRef {
        id: "m-analyst".into(),
        name: "Analyst".into(),
        handle: "analyst".into(),
        role: "specialist".into(),
    }
}

fn permission(request: &str, run: &str, deadline_ms: u64) -> PendingRequestView {
    PendingRequestView {
        kind: PendingKind::Permission,
        request_id: request.into(),
        run_id: run.into(),
        requested_at: "2026-10-20 10:00:00".into(),
        deadline_ms,
        reviewer: "user".into(),
        tool: Some("Shell".into()),
        options: vec![PendingOptionView {
            id: "allow_once".into(),
            label: "Allow once".into(),
            kind: "allow_once".into(),
        }],
        message: None,
        schema: None,
    }
}

fn decision(id: &str, work: &str, research: Option<&str>) -> OpenDecision {
    OpenDecision {
        request: DecisionRequest {
            id: id.into(),
            project_id: "p".into(),
            work_id: work.into(),
            thread_id: None,
            question: "Which ratios?".into(),
            options: vec!["0.5".into()],
            impact: None,
            asked_by: "s-analyst".into(),
            state: "open".into(),
            answer: None,
            answered_by: None,
            created_at: "2026-10-20 09:00:00".into(),
            answered_at: None,
        },
        work_title: "Sweep".into(),
        research_id: research.map(str::to_owned),
    }
}

/// The Analyst's public Session works on "Sweep" of Task T.
fn base() -> AttentionInputs {
    let mut inputs = AttentionInputs::default();
    inputs.owners.insert(
        "s-analyst".into(),
        SessionOwner {
            member: analyst(),
            binding: BindingView::Public,
            current: true,
        },
    );
    inputs.owners.insert(
        "s-analyst-dm".into(),
        SessionOwner {
            member: analyst(),
            binding: BindingView::Dm,
            current: true,
        },
    );
    inputs
        .task_titles
        .insert("T".into(), "Structured pruning".into());
    inputs.assignments.push(OpenAssignment {
        conversation_id: "s-analyst".into(),
        work_id: "w1".into(),
        work_title: "Sweep".into(),
        research_id: Some("T".into()),
        started_at: "2026-10-20 08:00:00".into(),
    });
    inputs
}

fn keys(snapshot: &AttentionSnapshot) -> Vec<&str> {
    snapshot
        .items
        .iter()
        .map(|item| item.key.as_str())
        .collect()
}

#[test]
fn one_decision_appears_once_with_its_task_member_and_binding() {
    let mut inputs = base();
    inputs
        .pending
        .push((permission("req-1", "run-1", 60_000), "s-analyst".into()));
    inputs.active_runs.push(ActiveRun {
        run_id: "run-1".into(),
        conversation_id: "s-analyst".into(),
        status: RunStatus::WaitingPermission,
        started_at: "2026-10-20 09:59:00".into(),
        title: "Analyst".into(),
    });
    let snapshot = project("p", 7, inputs);
    assert_eq!(snapshot.cursor, 7);
    assert_eq!(keys(&snapshot), ["permission:req-1"]);
    let item = &snapshot.items[0];
    assert_eq!(item.task.as_ref().unwrap().title, "Structured pruning");
    assert_eq!(item.member.as_ref().unwrap().handle, "analyst");
    assert_eq!(item.binding, Some(BindingView::Public));
    assert_eq!(item.deadline_ms, Some(60_000));
    let json = serde_json::to_value(item).unwrap();
    assert_eq!(json["kind"], "permission");
    assert_eq!(json["tool"], "Shell");
    // The run that waits is an execution, pointing at the item, not a second item.
    assert_eq!(snapshot.executions.len(), 1);
    assert_eq!(snapshot.executions[0].waiting_keys, ["permission:req-1"]);
    assert_eq!(snapshot.executions[0].tasks[0].id, "T");
}

#[test]
fn a_dm_request_and_a_plain_session_are_attributed_as_such() {
    let mut inputs = base();
    inputs
        .pending
        .push((permission("req-dm", "run-dm", 1_000), "s-analyst-dm".into()));
    inputs.pending.push((
        permission("req-plain", "run-plain", 2_000),
        "s-plain".into(),
    ));
    inputs
        .session_titles
        .insert("s-plain".into(), "My chat".into());
    let mut leader = permission("req-leader", "run-team", 500);
    leader.reviewer = "leader".into();
    inputs.pending.push((leader, "s-team".into()));
    let mut input = permission("req-input", "run-dm", 3_000);
    input.kind = PendingKind::Input;
    input.tool = None;
    input.options.clear();
    input.message = Some("Choose".into());
    input.schema = Some(json!({"type": "object"}));
    inputs.pending.push((input, "s-analyst-dm".into()));
    let snapshot = project("p", 1, inputs);
    // Deadline order; a request still with a Team leader is not the researcher's.
    assert_eq!(
        keys(&snapshot),
        [
            "permission:req-dm",
            "permission:req-plain",
            "input:req-input"
        ]
    );
    assert_eq!(snapshot.items[0].binding, Some(BindingView::Dm));
    assert!(snapshot.items[0].task.is_none(), "a DM carries no Task");
    assert!(snapshot.items[1].member.is_none());
    assert_eq!(snapshot.items[1].session_title.as_deref(), Some("My chat"));
    let json = serde_json::to_value(&snapshot.items[2]).unwrap();
    assert_eq!(
        (json["kind"].as_str(), json["message"].as_str()),
        (Some("input"), Some("Choose"))
    );
}

#[test]
fn questions_reviews_proposals_and_setup_each_have_one_key() {
    let mut inputs = base();
    inputs.decisions.push(decision("q1", "w1", Some("T")));
    inputs.decisions.push(decision("q-outside", "w9", None));
    inputs.reviews.push(ReviewRequest {
        id: "r1".into(),
        research_id: "T".into(),
        summary: "done".into(),
        evidence: Vec::new(),
        requested_by: "s-general".into(),
        brief_revision: 2,
        state: "open".into(),
        created_at: "2026-10-20 09:30:00".into(),
        resolved_at: None,
        evidence_pins: Default::default(),
    });
    inputs.proposals.push(AwaitingProposal {
        research_id: "D".into(),
        title: "A draft".into(),
        revision: 3,
        message_id: "msg-9".into(),
        admitted: false,
        created_at: "2026-10-20 09:40:00".into(),
    });
    inputs.task_titles.insert("D".into(), "A draft".into());
    inputs.setup.push((
        analyst(),
        Some("provider_unavailable".into()),
        "2026-10-20 07:00:00".into(),
    ));
    let snapshot = project("p", 1, inputs);
    assert_eq!(
        keys(&snapshot),
        [
            "question:q1",
            "review:r1",
            "proposal:D:3",
            "setup:m-analyst"
        ],
        "a question outside any Task stays on the Team surface"
    );
    assert_eq!(snapshot.items[0].task.as_ref().unwrap().id, "T");
    assert_eq!(
        snapshot.items[1].task.as_ref().unwrap().title,
        "Structured pruning"
    );
    assert_eq!(snapshot.items[3].group, Group::Setup);
    let proposal = serde_json::to_value(&snapshot.items[2]).unwrap();
    assert_eq!(proposal["message_id"], "msg-9");
}

#[test]
fn failures_undelivered_and_incomplete_sources_are_reported_not_hidden() {
    let mut inputs = base();
    inputs.latest_runs.push(LatestRun {
        run_id: "run-old".into(),
        conversation_id: "s-analyst".into(),
        status: RunStatus::Failed,
        at: "2026-10-20 09:00:00".into(),
    });
    inputs.latest_runs.push(LatestRun {
        run_id: "run-ok".into(),
        conversation_id: "s-analyst-dm".into(),
        status: RunStatus::Completed,
        at: "2026-10-20 09:00:00".into(),
    });
    inputs.failed_routes = vec![
        (RouteKind::Discussion, None),
        (RouteKind::Mention, None),
        (RouteKind::TaskReview, Some("T".into())),
        (RouteKind::Decision, Some("T".into())),
        (RouteKind::Dispatch, Some("T".into())),
        (RouteKind::AgentHandoff, None),
    ];
    inputs.failed_sources.push(Source::Runtime);
    inputs.queued.insert("s-analyst".into(), 2);
    let snapshot = project("p", 1, inputs);
    assert_eq!(snapshot.failures.len(), 1);
    assert_eq!(snapshot.failures[0].run_id, "run-old");
    assert_eq!(snapshot.failures[0].binding, BindingView::Public);
    assert_eq!(snapshot.undelivered.general, 2);
    assert_eq!(snapshot.undelivered.tasks.get("T"), Some(&2));
    assert_eq!(snapshot.incomplete, [Source::Runtime]);
}

#[test]
fn the_list_is_capped_and_says_so() {
    let mut inputs = base();
    for index in 0..(MAX_ITEMS + 5) {
        inputs
            .decisions
            .push(decision(&format!("q{index:04}"), "w1", Some("T")));
    }
    let snapshot = project("p", 1, inputs.clone());
    assert_eq!(snapshot.items.len(), MAX_ITEMS);
    assert!(snapshot.truncated);
    // Stable across reads.
    assert_eq!(keys(&snapshot), keys(&project("p", 1, inputs)));
    let _ = HashMap::<String, String>::new();
}
