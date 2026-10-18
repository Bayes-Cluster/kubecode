use std::sync::Arc;

use super::*;
use crate::agents::AgentId;
use crate::experiment_store::testing::Fixture;
use crate::teams::NewTeamTask;

struct Rig {
    f: Fixture,
    work: WorkStore,
}

fn rig() -> Rig {
    let f = Fixture::new();
    let work = WorkStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap();
    Rig { f, work }
}

impl Rig {
    fn project(&self) -> &str {
        &self.f.project_id
    }

    fn coordinator(&self) -> Actor {
        let current = self
            .work
            .coordinator(self.project(), &self.f.round_id)
            .unwrap()
            .expect("the Leader coordinates a research Team's round");
        Actor::Coordinator(CoordinatorAuth {
            round_id: self.f.round_id.clone(),
            holder: current.holder,
            epoch: current.epoch,
        })
    }

    fn session(&self, title: &str) -> String {
        self.f
            .agents
            .create_conversation(self.project(), AgentId::OpenCode, Some(title))
            .unwrap()
            .id
    }

    /// Native work in the approved round with an executing Session.
    fn native(&self, title: &str) -> WorkItem {
        let actor = self.coordinator();
        let (item, _) = self
            .work
            .create(
                self.project(),
                NewWork {
                    title,
                    description: "do it",
                    round_id: Some(&self.f.round_id),
                    ..Default::default()
                },
                &actor,
            )
            .unwrap();
        item
    }

    fn assigned(&self, title: &str) -> (WorkItem, String) {
        let item = self.native(title);
        let session = self.session("worker");
        self.work
            .assign(
                self.project(),
                &item.id,
                &session,
                None,
                "",
                &self.coordinator(),
            )
            .unwrap();
        (item, session)
    }
}

// -- Migration and the legacy mirror --------------------------------------------------------------------

#[test]
fn legacy_team_tasks_are_mirrored_with_their_ids_attempts_and_attribution() {
    let r = rig();
    let item = r.work.get(r.project(), &r.f.task_id).unwrap();
    assert_eq!(item.origin, WorkOrigin::LegacyTeam);
    assert_eq!(item.title, "Run baseline");
    assert_eq!(item.team_id.as_deref(), Some(r.f.team.id.as_str()));
    // The round's research attribution comes from the round, not invented.
    assert_eq!(item.round_id.as_deref(), Some(r.f.round_id.as_str()));
    assert_eq!(item.research_id.as_deref(), Some(r.f.research_id.as_str()));
    assert_eq!(
        (item.stage, item.lifecycle),
        (WorkStage::Executing, WorkLifecycle::Active)
    );
    assert_eq!(
        item.created_by.as_deref(),
        Some(r.f.leader.conversation_id.as_str())
    );

    let summary = r.work.summary(r.project(), &r.f.task_id).unwrap();
    assert_eq!(
        summary
            .assignment
            .as_ref()
            .map(|a| a.conversation_id.as_str()),
        Some(r.f.teammate.conversation_id.as_str())
    );
    // The attempts keep the legacy ids, so anything that names them still does.
    let legacy = r.f.teams.list_task_attempts(&r.f.team.id).unwrap();
    assert_eq!(legacy.len(), 1);
    let attempts = r.work.attempts(r.project(), &r.f.task_id).unwrap();
    assert_eq!(
        attempts.iter().map(|a| &a.id).collect::<Vec<_>>(),
        vec![&legacy[0].id]
    );
    assert_eq!(
        attempts[0].conversation_id.as_deref(),
        Some(r.f.teammate.conversation_id.as_str())
    );
    // The Leader is the round's first coordinator.
    let coordinator = r
        .work
        .coordinator(r.project(), &r.f.round_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (coordinator.holder.as_str(), coordinator.epoch),
        (r.f.leader.conversation_id.as_str(), 1)
    );
}

#[test]
fn the_mirror_follows_later_team_changes_before_the_next_read() {
    let r = rig();
    assert_eq!(
        r.work.get(r.project(), &r.f.task_id).unwrap().stage,
        WorkStage::Executing
    );
    r.f.teams
        .submit_result(&r.f.task_id, &r.f.teammate.id, "accuracy 0.9", "ran twice")
        .unwrap();
    let reviewing = r.work.get(r.project(), &r.f.task_id).unwrap();
    assert_eq!(
        (reviewing.stage, reviewing.review_kind),
        (WorkStage::Review, Some(ReviewKind::Result))
    );
    r.f.teams
        .review_result(&r.f.task_id, &r.f.leader.id, true, None)
        .unwrap();
    let done = r.work.get(r.project(), &r.f.task_id).unwrap();
    assert_eq!(
        (done.stage, done.acceptance),
        (WorkStage::Done, Acceptance::Accepted)
    );
    assert!(
        r.work
            .attempts(r.project(), &r.f.task_id)
            .unwrap()
            .iter()
            .all(|a| !is_open(a.status))
    );
}

#[test]
fn a_legacy_dependency_makes_work_ready_only_when_its_dependency_is_accepted() {
    let r = rig();
    let follow =
        r.f.teams
            .create_task(NewTeamTask {
                team_id: &r.f.team.id,
                creator_member_id: &r.f.leader.id,
                title: "Analyse",
                description: "after the baseline",
                dependencies: std::slice::from_ref(&r.f.task_id),
                owned_paths: &[],
                requires_plan_approval: false,
                mutates_files: false,
            })
            .unwrap();
    let before = r.work.get(r.project(), &follow.id).unwrap();
    assert_eq!(before.dependencies, vec![r.f.task_id.clone()]);
    assert_ne!(
        before.stage,
        WorkStage::Ready,
        "an unmet dependency is not ready"
    );
    r.f.teams
        .submit_result(&r.f.task_id, &r.f.teammate.id, "r", "v")
        .unwrap();
    r.f.teams
        .review_result(&r.f.task_id, &r.f.leader.id, true, None)
        .unwrap();
    assert_eq!(
        r.work.get(r.project(), &follow.id).unwrap().stage,
        WorkStage::Ready
    );
}

#[test]
fn work_survives_the_deletion_of_its_team_with_history_intact() {
    let r = rig();
    r.work.get(r.project(), &r.f.task_id).unwrap();
    r.f.teams.delete_team(&r.f.team.id).unwrap();
    // The Team and its legacy rows are gone; the work and its history are not.
    assert!(r.f.teams.get_task(&r.f.task_id).is_err());
    let item = r.work.get(r.project(), &r.f.task_id).unwrap();
    assert_eq!(item.title, "Run baseline");
    assert_eq!(r.work.attempts(r.project(), &r.f.task_id).unwrap().len(), 1);
    assert_eq!(
        r.work.assignments(r.project(), &r.f.task_id).unwrap().len(),
        1
    );
    assert!(
        r.work
            .coordinator(r.project(), &r.f.round_id)
            .unwrap()
            .is_some()
    );
}

#[test]
fn migration_is_resumable_pending_changes_apply_on_the_next_start() {
    let f = Fixture::new();
    // Work the store has never seen, queued by nothing: the first start mirrors it.
    let first = WorkStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap();
    drop(first);
    f.teams
        .submit_result(&f.task_id, &f.teammate.id, "r", "v")
        .unwrap();
    // A crash before the queue was applied: the entry is durable.
    let queued: i64 = f
        .agents
        .database()
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM work_sync_queue", [], |r| r.get(0))
        .unwrap();
    assert_eq!(queued, 1);
    let second = WorkStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap();
    assert_eq!(
        second.get(&f.project_id, &f.task_id).unwrap().stage,
        WorkStage::Review
    );
    // Re-running the mirror changes nothing.
    let before = second.summary(&f.project_id, &f.task_id).unwrap();
    f.agents
        .database()
        .lock()
        .unwrap()
        .execute(
            "INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (?1)",
            [&f.team.id],
        )
        .unwrap();
    assert_eq!(second.summary(&f.project_id, &f.task_id).unwrap(), before);
}

#[test]
fn legacy_work_is_readable_but_only_operable_through_its_team() {
    let r = rig();
    let id = r.f.task_id.clone();
    let item = r.work.get(r.project(), &id).unwrap();
    let actor = Actor::Researcher;
    assert!(matches!(
        r.work.update_plan(
            r.project(),
            &id,
            item.revision,
            PlanPatch::default(),
            &actor
        ),
        Err(WorkError::LegacyOwned)
    ));
    assert!(matches!(
        r.work.close(
            r.project(),
            &id,
            item.revision,
            Closure {
                lifecycle: WorkLifecycle::Canceled,
                reason: "no",
                superseded_by: None
            },
            &actor
        ),
        Err(WorkError::LegacyOwned)
    ));
    assert!(matches!(
        r.work.advance(
            r.project(),
            &id,
            WorkStage::Executing,
            WorkStage::Review,
            None,
            &actor
        ),
        Err(WorkError::LegacyOwned)
    ));
    // The Team store still operates it, and the mirror follows.
    r.f.teams
        .cancel_task(&id, &r.f.leader.id, Some("not needed"))
        .unwrap();
    let closed = r.work.get(r.project(), &id).unwrap();
    assert_eq!(closed.lifecycle, WorkLifecycle::Canceled);
}

#[test]
fn an_unlinked_legacy_team_gets_no_invented_research_approval() {
    let r = rig();
    // A second Team in the same Project with no research round.
    let leader = r.session("plain leader");
    let team =
        r.f.teams
            .create_team(crate::teams::NewTeam {
                project_id: r.project(),
                leader_conversation_id: &leader,
                agent_session_id: &r
                    .f
                    .agents
                    .get_conversation(&leader)
                    .unwrap()
                    .agent_session_id,
                leader_name: "Lead",
                title: Some("Ordinary"),
                workspace: crate::teams::TeamWorkspace::Shared,
                workspace_path: None,
            })
            .unwrap();
    let member = r.f.teams.list_members(&team.id).unwrap().remove(0);
    let task =
        r.f.teams
            .create_task(NewTeamTask {
                team_id: &team.id,
                creator_member_id: &member.id,
                title: "Chore",
                description: "unrelated",
                dependencies: &[],
                owned_paths: &[],
                requires_plan_approval: false,
                mutates_files: false,
            })
            .unwrap();
    let item = r.work.get(r.project(), &task.id).unwrap();
    assert_eq!((item.research_id, item.round_id), (None, None));
    assert_eq!(item.team_id.as_deref(), Some(team.id.as_str()));
    assert!(
        r.work
            .coordinator(r.project(), &r.f.round_id)
            .unwrap()
            .is_some()
    );
}

// -- Native work ---------------------------------------------------------------------------------------------

#[test]
fn creation_is_idempotent_per_request_and_scoped_to_its_project() {
    let r = rig();
    let make = |key: Option<&str>| {
        r.work
            .create(
                r.project(),
                NewWork {
                    title: "Sweep",
                    round_id: Some(&r.f.round_id),
                    client_request_id: key,
                    ..Default::default()
                },
                &r.coordinator(),
            )
            .unwrap()
    };
    let (first, created) = make(Some("req-1"));
    assert!(created);
    let (again, created_again) = make(Some("req-1"));
    assert!(!created_again);
    assert_eq!(first.id, again.id);
    assert_eq!(
        r.work
            .list(r.project(), &WorkFilter::default())
            .unwrap()
            .len(),
        2,
        "one legacy, one native"
    );

    let other = r.f.workspace.create_project(".", "beta").unwrap();
    assert!(matches!(
        r.work.get(&other.id, &first.id),
        Err(WorkError::NotFound)
    ));
    assert!(
        r.work
            .list(&other.id, &WorkFilter::default())
            .unwrap()
            .is_empty()
    );
    // A round of another Project cannot anchor work.
    assert!(matches!(
        r.work.create(
            &other.id,
            NewWork {
                title: "x",
                round_id: Some(&r.f.round_id),
                ..Default::default()
            },
            &Actor::Researcher
        ),
        Err(WorkError::Invalid(_))
    ));
}

#[test]
fn candidate_work_exists_before_a_round_but_cannot_execute_without_one() {
    let r = rig();
    let (candidate, _) = r
        .work
        .create(
            r.project(),
            NewWork {
                title: "Idea",
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap();
    assert_eq!(
        (candidate.round_id.clone(), candidate.research_id.clone()),
        (None, None)
    );
    // A coordinator cannot create or touch work with no approved round.
    assert!(matches!(
        r.work.create(
            r.project(),
            NewWork {
                title: "x",
                ..Default::default()
            },
            &r.coordinator()
        ),
        Err(WorkError::Invalid(_))
    ));
    let session = r.session("exec");
    r.work
        .assign(
            r.project(),
            &candidate.id,
            &session,
            None,
            "",
            &Actor::Researcher,
        )
        .unwrap();
    assert!(matches!(
        r.work
            .begin_attempt(r.project(), &candidate.id, None, &Actor::Researcher),
        Err(WorkError::NoApprovedRound)
    ));
    // Linking it to the approved round makes it executable, by revision.
    assert!(matches!(
        r.work.link_round(
            r.project(),
            &candidate.id,
            99,
            &r.f.round_id,
            &Actor::Researcher
        ),
        Err(WorkError::Stale { current: 1 })
    ));
    let linked = r
        .work
        .link_round(
            r.project(),
            &candidate.id,
            1,
            &r.f.round_id,
            &Actor::Researcher,
        )
        .unwrap();
    assert_eq!(linked.round_id.as_deref(), Some(r.f.round_id.as_str()));
    assert_eq!(
        linked.research_id.as_deref(),
        Some(r.f.research_id.as_str())
    );
    r.work
        .begin_attempt(r.project(), &candidate.id, None, &Actor::Researcher)
        .unwrap();
}

#[test]
fn plan_updates_are_revision_checked_and_dependencies_cannot_cycle_or_cross_projects() {
    let r = rig();
    let a = r.native("A");
    let b = r.native("B");
    let patch = |title: &str| PlanPatch {
        title: Some(title.into()),
        ..Default::default()
    };
    let updated = r
        .work
        .update_plan(
            r.project(),
            &a.id,
            a.revision,
            patch("A2"),
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(
        (updated.title.as_str(), updated.revision),
        ("A2", a.revision + 1)
    );
    // The second planner, holding the old revision, is refused with the current one.
    assert!(matches!(
        r.work.update_plan(r.project(), &a.id, a.revision, patch("A3"), &r.coordinator()),
        Err(WorkError::Stale { current }) if current == a.revision + 1
    ));
    // An unchanged plan does not bump the revision.
    let same = r
        .work
        .update_plan(
            r.project(),
            &a.id,
            updated.revision,
            patch("A2"),
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(same.revision, updated.revision);

    let b = r
        .work
        .update_plan(
            r.project(),
            &b.id,
            b.revision,
            PlanPatch {
                add_dependencies: vec![a.id.clone()],
                ..Default::default()
            },
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(b.dependencies, vec![a.id.clone()]);
    assert!(matches!(
        r.work.update_plan(
            r.project(),
            &a.id,
            updated.revision,
            PlanPatch {
                add_dependencies: vec![b.id.clone()],
                ..Default::default()
            },
            &r.coordinator()
        ),
        Err(WorkError::DependencyCycle)
    ));
    assert!(matches!(
        r.work.update_plan(
            r.project(),
            &a.id,
            updated.revision,
            PlanPatch {
                add_dependencies: vec![a.id.clone()],
                ..Default::default()
            },
            &r.coordinator()
        ),
        Err(WorkError::DependencyCycle)
    ));
    // Another Project's item cannot be a dependency (it reads as missing).
    let other = r.f.workspace.create_project(".", "beta").unwrap();
    let (foreign, _) = r
        .work
        .create(
            &other.id,
            NewWork {
                title: "Foreign",
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap();
    assert!(matches!(
        r.work.update_plan(
            r.project(),
            &a.id,
            updated.revision,
            PlanPatch {
                add_dependencies: vec![foreign.id],
                ..Default::default()
            },
            &r.coordinator()
        ),
        Err(WorkError::NotFound)
    ));
}

#[test]
fn dependencies_decide_eligibility_and_closing_one_blocks_its_dependents() {
    let r = rig();
    let a = r.native("A");
    let (b, _) = r
        .work
        .create(
            r.project(),
            NewWork {
                title: "B",
                round_id: Some(&r.f.round_id),
                dependencies: std::slice::from_ref(&a.id),
                ..Default::default()
            },
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(a.stage, WorkStage::Ready);
    assert_eq!(
        b.stage,
        WorkStage::Planned,
        "an unmet dependency keeps it planned"
    );
    assert!(matches!(
        r.work.advance(
            r.project(),
            &b.id,
            WorkStage::Planned,
            WorkStage::Ready,
            None,
            &r.coordinator()
        ),
        Err(WorkError::DependenciesUnmet)
    ));

    // A -> executing -> review -> accepted makes B ready.
    let session = r.session("exec");
    r.work
        .assign(r.project(), &a.id, &session, None, "", &r.coordinator())
        .unwrap();
    let attempt = r
        .work
        .begin_attempt(r.project(), &a.id, None, &r.coordinator())
        .unwrap();
    r.work
        .bind_attempt_run(r.project(), &attempt.id, "run-x", &Actor::Researcher)
        .ok();
    r.work
        .finish_attempt(
            r.project(),
            &attempt.id,
            AttemptOutcome::Completed,
            &r.coordinator(),
        )
        .unwrap();
    r.work
        .advance(
            r.project(),
            &a.id,
            WorkStage::Executing,
            WorkStage::Review,
            None,
            &r.coordinator(),
        )
        .unwrap();
    r.work
        .review(
            r.project(),
            &a.id,
            ReviewInput {
                accept: true,
                outcome: WorkOutcome::Supported,
                reason: None,
            },
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(
        r.work.get(r.project(), &b.id).unwrap().stage,
        WorkStage::Ready
    );

    // A closed, unaccepted dependency blocks instead.
    let c = r.native("C");
    let (d, _) = r
        .work
        .create(
            r.project(),
            NewWork {
                title: "D",
                round_id: Some(&r.f.round_id),
                dependencies: std::slice::from_ref(&c.id),
                ..Default::default()
            },
            &r.coordinator(),
        )
        .unwrap();
    r.work
        .close(
            r.project(),
            &c.id,
            c.revision,
            Closure {
                lifecycle: WorkLifecycle::Abandoned,
                reason: "dead end",
                superseded_by: None,
            },
            &r.coordinator(),
        )
        .unwrap();
    let blocked = r.work.get(r.project(), &d.id).unwrap();
    assert_eq!(
        (blocked.stage, blocked.condition),
        (WorkStage::Planned, WorkCondition::Blocked)
    );
    assert!(blocked.condition_reason.unwrap().contains(&c.id));
    // Removing the dead dependency from the plan frees it.
    r.work
        .update_plan(
            r.project(),
            &d.id,
            blocked.revision,
            PlanPatch {
                remove_dependencies: vec![c.id.clone()],
                ..Default::default()
            },
            &r.coordinator(),
        )
        .unwrap();
    let freed = r.work.get(r.project(), &d.id).unwrap();
    assert_eq!(
        (freed.stage, freed.condition),
        (WorkStage::Ready, WorkCondition::None)
    );
}

#[test]
fn a_task_acquires_a_new_executing_session_without_losing_its_attempts() {
    let r = rig();
    let (item, first) = r.assigned("Long task");
    let attempt = r
        .work
        .begin_attempt(r.project(), &item.id, None, &r.coordinator())
        .unwrap();
    // Reassigning under a running attempt would orphan it.
    let second = r.session("replacement");
    assert!(matches!(
        r.work
            .assign(r.project(), &item.id, &second, None, "", &r.coordinator()),
        Err(WorkError::AttemptOpen)
    ));
    r.work
        .finish_attempt(
            r.project(),
            &attempt.id,
            AttemptOutcome::Failed {
                kind: Some("interrupted".into()),
                error: Some("session lost".into()),
            },
            &r.coordinator(),
        )
        .unwrap();
    r.work
        .assign(
            r.project(),
            &item.id,
            &second,
            None,
            "session lost",
            &r.coordinator(),
        )
        .unwrap();
    let retry = r
        .work
        .begin_attempt(r.project(), &item.id, None, &r.coordinator())
        .unwrap();
    assert_ne!(retry.id, attempt.id);

    let attempts = r.work.attempts(r.project(), &item.id).unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0].conversation_id.as_deref(), Some(first.as_str()));
    assert_eq!(attempts[0].status, AttemptStatus::Failed);
    assert_eq!(
        attempts[1].conversation_id.as_deref(),
        Some(second.as_str())
    );
    let assignments = r.work.assignments(r.project(), &item.id).unwrap();
    assert_eq!(assignments.len(), 2);
    assert_eq!(assignments[0].end_reason.as_deref(), Some("session lost"));
    assert!(assignments[1].ended_at.is_none());
    // Same task, same id: nothing was recreated.
    assert_eq!(r.work.get(r.project(), &item.id).unwrap().id, item.id);
}

#[test]
fn attempts_need_assignment_eligibility_and_never_overlap() {
    let r = rig();
    let item = r.native("Task");
    assert!(matches!(
        r.work
            .begin_attempt(r.project(), &item.id, None, &r.coordinator()),
        Err(WorkError::NotAssigned)
    ));
    let session = r.session("exec");
    r.work
        .assign(r.project(), &item.id, &session, None, "", &r.coordinator())
        .unwrap();
    r.work
        .set_condition(
            r.project(),
            &item.id,
            WorkCondition::Paused,
            Some("hold"),
            &r.coordinator(),
        )
        .unwrap();
    assert!(
        r.work
            .begin_attempt(r.project(), &item.id, None, &r.coordinator())
            .is_err()
    );
    r.work
        .set_condition(
            r.project(),
            &item.id,
            WorkCondition::None,
            None,
            &r.coordinator(),
        )
        .unwrap();
    let attempt = r
        .work
        .begin_attempt(r.project(), &item.id, None, &r.coordinator())
        .unwrap();
    assert!(matches!(
        r.work
            .begin_attempt(r.project(), &item.id, None, &r.coordinator()),
        Err(WorkError::AttemptOpen)
    ));
    let bound = r
        .work
        .bind_attempt_run(r.project(), &attempt.id, "run-1", &Actor::Researcher)
        .unwrap();
    assert_eq!(
        (bound.status, bound.run_id.as_deref()),
        (AttemptStatus::Running, Some("run-1"))
    );
    r.work
        .finish_attempt(
            r.project(),
            &attempt.id,
            AttemptOutcome::Completed,
            &Actor::Executor {
                conversation_id: session.clone(),
            },
        )
        .unwrap();
    // Repeating the same report is a no-op; a different one is refused.
    assert!(
        r.work
            .finish_attempt(
                r.project(),
                &attempt.id,
                AttemptOutcome::Completed,
                &r.coordinator()
            )
            .is_ok(),
        "a repeated report converges"
    );
    assert!(
        r.work
            .finish_attempt(
                r.project(),
                &attempt.id,
                AttemptOutcome::Cancelled,
                &r.coordinator()
            )
            .is_err(),
        "a closed attempt stays closed"
    );
    // An unrelated Session cannot report on the attempt.
    let other = r.session("stranger");
    assert!(matches!(
        r.work.add_result(
            r.project(),
            &item.id,
            NewResult {
                attempt_id: Some(&attempt.id),
                role: ResultRole::Result,
                kind: "experiment",
                ref_id: "e1",
                revision: None
            },
            &Actor::Executor {
                conversation_id: other
            }
        ),
        Err(WorkError::NotAssigned)
    ));
}

#[test]
fn done_is_reachable_only_through_review_and_a_valid_negative_result_can_be_accepted() {
    let r = rig();
    let (item, session) = r.assigned("Negative result");
    let attempt = r
        .work
        .begin_attempt(r.project(), &item.id, None, &r.coordinator())
        .unwrap();
    // Not even the coordinator can mark work done by a stage change.
    for target in [WorkStage::Done, WorkStage::Review] {
        assert!(
            r.work
                .advance(
                    r.project(),
                    &item.id,
                    WorkStage::Executing,
                    target,
                    None,
                    &r.coordinator()
                )
                .is_err(),
            "{target:?}"
        );
    }
    r.work
        .bind_attempt_run(r.project(), &attempt.id, "run-x", &Actor::Researcher)
        .ok();
    r.work
        .finish_attempt(
            r.project(),
            &attempt.id,
            AttemptOutcome::Completed,
            &Actor::Executor {
                conversation_id: session.clone(),
            },
        )
        .unwrap();
    // The executor may submit for review; it may not accept.
    let reviewing = r
        .work
        .advance(
            r.project(),
            &item.id,
            WorkStage::Executing,
            WorkStage::Review,
            Some(ReviewKind::Validity),
            &Actor::Executor {
                conversation_id: session.clone(),
            },
        )
        .unwrap();
    assert_eq!(reviewing.review_kind, Some(ReviewKind::Validity));
    assert!(
        r.work
            .review(
                r.project(),
                &item.id,
                ReviewInput {
                    accept: true,
                    outcome: WorkOutcome::Refuted,
                    reason: None
                },
                &Actor::Executor {
                    conversation_id: session
                }
            )
            .is_err()
    );
    // A stale "from" is refused.
    assert!(
        r.work
            .advance(
                r.project(),
                &item.id,
                WorkStage::Executing,
                WorkStage::Analyzing,
                None,
                &r.coordinator()
            )
            .is_err()
    );

    let accepted = r
        .work
        .review(
            r.project(),
            &item.id,
            ReviewInput {
                accept: true,
                outcome: WorkOutcome::Refuted,
                reason: None,
            },
            &r.coordinator(),
        )
        .unwrap();
    // Exit status, acceptance, and the science are separate facts.
    assert_eq!(
        (
            accepted.stage,
            accepted.acceptance,
            accepted.outcome,
            accepted.lifecycle
        ),
        (
            WorkStage::Done,
            Acceptance::Accepted,
            WorkOutcome::Refuted,
            WorkLifecycle::Active
        )
    );
    assert!(
        r.work
            .review(
                r.project(),
                &item.id,
                ReviewInput {
                    accept: true,
                    outcome: WorkOutcome::Supported,
                    reason: None
                },
                &r.coordinator()
            )
            .is_err(),
        "already done"
    );
}

#[test]
fn rejected_review_sends_work_back_and_closing_keeps_history_with_its_reason() {
    let r = rig();
    let (item, _) = r.assigned("Rework");
    let attempt = r
        .work
        .begin_attempt(r.project(), &item.id, None, &r.coordinator())
        .unwrap();
    r.work
        .bind_attempt_run(r.project(), &attempt.id, "run-x", &Actor::Researcher)
        .ok();
    r.work
        .finish_attempt(
            r.project(),
            &attempt.id,
            AttemptOutcome::Completed,
            &r.coordinator(),
        )
        .unwrap();
    r.work
        .advance(
            r.project(),
            &item.id,
            WorkStage::Executing,
            WorkStage::Review,
            None,
            &r.coordinator(),
        )
        .unwrap();
    let back = r
        .work
        .review(
            r.project(),
            &item.id,
            ReviewInput {
                accept: false,
                outcome: WorkOutcome::Unknown,
                reason: None,
            },
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(
        (back.stage, back.acceptance),
        (WorkStage::Executing, Acceptance::Rejected)
    );

    let next = r
        .work
        .begin_attempt(r.project(), &item.id, None, &r.coordinator())
        .unwrap();
    r.work
        .add_result(
            r.project(),
            &item.id,
            NewResult {
                attempt_id: Some(&next.id),
                role: ResultRole::Evidence,
                kind: "file",
                ref_id: "results/exp-1.csv",
                revision: Some("rev1"),
            },
            &r.coordinator(),
        )
        .unwrap();
    let duplicate = r
        .work
        .add_result(
            r.project(),
            &item.id,
            NewResult {
                attempt_id: Some(&next.id),
                role: ResultRole::Evidence,
                kind: "file",
                ref_id: "results/exp-1.csv",
                revision: Some("rev1"),
            },
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(
        r.work.results(r.project(), &item.id).unwrap().len(),
        1,
        "a repeated reference is one reference"
    );
    assert_eq!(duplicate.ref_id, "results/exp-1.csv");

    let current = r.work.get(r.project(), &item.id).unwrap();
    assert!(
        r.work
            .close(
                r.project(),
                &item.id,
                current.revision,
                Closure {
                    lifecycle: WorkLifecycle::Abandoned,
                    reason: " ",
                    superseded_by: None
                },
                &r.coordinator()
            )
            .is_err(),
        "a reason is required"
    );
    let replacement = r.native("Better approach");
    assert!(
        r.work
            .close(
                r.project(),
                &item.id,
                current.revision,
                Closure {
                    lifecycle: WorkLifecycle::Superseded,
                    reason: "replaced",
                    superseded_by: None
                },
                &r.coordinator()
            )
            .is_err()
    );
    let closed = r
        .work
        .close(
            r.project(),
            &item.id,
            current.revision,
            Closure {
                lifecycle: WorkLifecycle::Superseded,
                reason: "a better approach exists",
                superseded_by: Some(&replacement.id),
            },
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(
        (closed.lifecycle, closed.superseded_by.as_deref()),
        (WorkLifecycle::Superseded, Some(replacement.id.as_str()))
    );
    assert_eq!(
        closed.closed_reason.as_deref(),
        Some("a better approach exists")
    );
    // History stays: both attempts (the open one cancelled), the results, the ended assignment.
    let attempts = r.work.attempts(r.project(), &item.id).unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[1].status, AttemptStatus::Cancelled);
    assert_eq!(r.work.results(r.project(), &item.id).unwrap().len(), 1);
    assert!(
        r.work
            .assignments(r.project(), &item.id)
            .unwrap()
            .iter()
            .all(|a| a.ended_at.is_some())
    );
    assert!(
        r.work
            .list(r.project(), &WorkFilter::default())
            .unwrap()
            .iter()
            .all(|s| s.item.id != item.id),
        "closed work is hidden by default"
    );
    assert!(
        r.work
            .list(
                r.project(),
                &WorkFilter {
                    include_closed: true,
                    ..Default::default()
                }
            )
            .unwrap()
            .iter()
            .any(|s| s.item.id == item.id)
    );
    assert!(
        r.work
            .begin_attempt(r.project(), &item.id, None, &r.coordinator())
            .is_err()
    );
}

// -- Coordination ----------------------------------------------------------------------------------------------

#[test]
fn a_handoff_revokes_the_old_coordinator_at_every_boundary_and_keeps_the_work() {
    let r = rig();
    let old = r.coordinator();
    let (item, _) = r.assigned("Pending work");
    let attempt = r
        .work
        .begin_attempt(r.project(), &item.id, None, &old)
        .unwrap();
    let successor = r.session("new coordinator");
    let Actor::Coordinator(old_auth) = &old else {
        unreachable!()
    };

    // A stale epoch cannot hand the round off.
    assert!(matches!(
        r.work
            .handoff_coordinator(r.project(), &r.f.round_id, 7, &successor, "rotate", &old),
        Err(WorkError::StaleCoordinator { current_epoch: 1 })
    ));
    let next = r
        .work
        .handoff_coordinator(
            r.project(),
            &r.f.round_id,
            1,
            &successor,
            "context window full",
            &old,
        )
        .unwrap();
    assert_eq!((next.holder.as_str(), next.epoch), (successor.as_str(), 2));

    // Pending work, attempts, and assignments are exactly where they were.
    let summary = r.work.summary(r.project(), &item.id).unwrap();
    assert_eq!(summary.attempt_count, 1);
    assert_eq!(
        summary.latest_attempt.as_ref().map(|a| a.id.as_str()),
        Some(attempt.id.as_str())
    );
    assert!(summary.assignment.is_some());

    // The old coordinator is refused by every coordinator-gated command.
    let refused = |result: Result<(), WorkError>| {
        assert!(
            matches!(
                result,
                Err(WorkError::StaleCoordinator { current_epoch: 2 })
            ),
            "{result:?}"
        );
    };
    refused(
        r.work
            .create(
                r.project(),
                NewWork {
                    title: "late",
                    round_id: Some(&r.f.round_id),
                    ..Default::default()
                },
                &old,
            )
            .map(|_| ()),
    );
    refused(
        r.work
            .update_plan(
                r.project(),
                &item.id,
                item.revision,
                PlanPatch {
                    priority: Some(5),
                    ..Default::default()
                },
                &old,
            )
            .map(|_| ()),
    );
    refused(
        r.work
            .assign(r.project(), &item.id, &successor, None, "", &old)
            .map(|_| ()),
    );
    refused(
        r.work
            .begin_attempt(r.project(), &item.id, None, &old)
            .map(|_| ()),
    );
    refused(
        r.work
            .finish_attempt(r.project(), &attempt.id, AttemptOutcome::Completed, &old)
            .map(|_| ()),
    );
    refused(
        r.work
            .set_condition(r.project(), &item.id, WorkCondition::Paused, None, &old)
            .map(|_| ()),
    );
    refused(
        r.work
            .advance(
                r.project(),
                &item.id,
                WorkStage::Executing,
                WorkStage::Review,
                None,
                &old,
            )
            .map(|_| ()),
    );
    refused(
        r.work
            .review(
                r.project(),
                &item.id,
                ReviewInput {
                    accept: true,
                    outcome: WorkOutcome::Supported,
                    reason: None,
                },
                &old,
            )
            .map(|_| ()),
    );
    refused(
        r.work
            .close(
                r.project(),
                &item.id,
                item.revision,
                Closure {
                    lifecycle: WorkLifecycle::Canceled,
                    reason: "x",
                    superseded_by: None,
                },
                &old,
            )
            .map(|_| ()),
    );
    refused(
        r.work
            .handoff_coordinator(r.project(), &r.f.round_id, 2, &successor, "again", &old)
            .map(|_| ()),
    );
    refused(r.work.authorize_coordinator(r.project(), old_auth));

    // The successor continues the same work.
    let new = Actor::Coordinator(CoordinatorAuth {
        round_id: r.f.round_id.clone(),
        holder: successor.clone(),
        epoch: 2,
    });
    r.work
        .bind_attempt_run(r.project(), &attempt.id, "run-x", &Actor::Researcher)
        .ok();
    r.work
        .finish_attempt(r.project(), &attempt.id, AttemptOutcome::Completed, &new)
        .unwrap();
    let history = r
        .work
        .coordinator_history(r.project(), &r.f.round_id)
        .unwrap();
    assert_eq!(
        history.iter().map(|c| c.epoch).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        history[1].previous_holder.as_deref(),
        Some(old_auth.holder.as_str())
    );
    assert_eq!(history[1].reason, "context window full");
    // The researcher is always authorized, whatever the epoch.
    r.work
        .update_plan(
            r.project(),
            &item.id,
            item.revision,
            PlanPatch {
                priority: Some(1),
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap();
}

#[test]
fn coordinator_authority_is_bound_to_its_round_and_project() {
    let r = rig();
    let auth = CoordinatorAuth {
        round_id: "some-other-round".into(),
        holder: r.f.leader.conversation_id.clone(),
        epoch: 1,
    };
    assert!(
        r.work
            .create(
                r.project(),
                NewWork {
                    title: "x",
                    round_id: Some(&r.f.round_id),
                    ..Default::default()
                },
                &Actor::Coordinator(auth.clone())
            )
            .is_err()
    );
    let other = r.f.workspace.create_project(".", "beta").unwrap();
    assert!(matches!(
        r.work.authorize_coordinator(
            &other.id,
            &CoordinatorAuth {
                round_id: r.f.round_id.clone(),
                ..auth
            }
        ),
        Err(WorkError::NoCoordinator)
    ));
    assert!(matches!(
        r.work.coordinator_history(&other.id, &r.f.round_id),
        Err(WorkError::NotFound)
    ));
    // A Session of another Project cannot become the coordinator.
    let foreign =
        r.f.agents
            .create_conversation(&other.id, AgentId::OpenCode, None)
            .unwrap();
    assert!(
        r.work
            .handoff_coordinator(
                r.project(),
                &r.f.round_id,
                1,
                &foreign.id,
                "x",
                &Actor::Researcher
            )
            .is_err()
    );
    // An executor cannot change who coordinates.
    assert!(
        r.work
            .handoff_coordinator(
                r.project(),
                &r.f.round_id,
                1,
                &r.f.leader.conversation_id,
                "x",
                &Actor::Executor {
                    conversation_id: "s".into()
                }
            )
            .is_err()
    );
}

#[test]
fn filters_narrow_one_set_of_cards_and_never_create_another() {
    let r = rig();
    let (item, session) = r.assigned("Filtered");
    let all = r.work.list(r.project(), &WorkFilter::default()).unwrap();
    assert_eq!(all.len(), 2, "the legacy task and the native one");
    let by_round = r
        .work
        .list(
            r.project(),
            &WorkFilter {
                round_id: Some(r.f.round_id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    let by_research = r
        .work
        .list(
            r.project(),
            &WorkFilter {
                research_id: Some(r.f.research_id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    let by_team = r
        .work
        .list(
            r.project(),
            &WorkFilter {
                team_id: Some(r.f.team.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    let by_session = r
        .work
        .list(
            r.project(),
            &WorkFilter {
                conversation_id: Some(session),
                ..Default::default()
            },
        )
        .unwrap();
    let ids = |list: &[WorkSummary]| {
        list.iter()
            .map(|s| s.item.id.clone())
            .collect::<std::collections::BTreeSet<_>>()
    };
    // Each view is a subset of the same cards; a card is one id wherever it appears.
    assert_eq!(ids(&by_round), ids(&all));
    assert_eq!(ids(&by_research), ids(&all));
    assert_eq!(
        ids(&by_team),
        std::collections::BTreeSet::from([r.f.task_id.clone()])
    );
    assert_eq!(
        ids(&by_session),
        std::collections::BTreeSet::from([item.id.clone()])
    );
    let ready = r
        .work
        .list(
            r.project(),
            &WorkFilter {
                stage: Some(WorkStage::Ready),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(ids(&ready), std::collections::BTreeSet::from([item.id]));
}

#[test]
fn commands_announce_a_content_free_work_updated_event() {
    let r = rig();
    let before = r.f.agents.latest_workspace_event_id().unwrap();
    let item = r.native("Announced");
    let events = r.f.agents.workspace_events_after(before).unwrap();
    let event = events
        .iter()
        .find(|e| e.kind == "work_updated")
        .expect("work_updated");
    assert_eq!(event.project_id.as_deref(), Some(r.project()));
    let payload = event.payload.to_string();
    assert!(payload.contains(&item.id) && payload.contains("created"));
    assert!(
        !payload.contains("Announced"),
        "titles never travel in events"
    );
}

// -- Review fixes: re-owning, stale cards, references, replays -------------------------------------------

#[test]
fn deleting_a_team_mirrors_its_last_changes_and_hands_the_work_to_the_workspace() {
    let r = rig();
    // A change made through the Team and never read before the Team is deleted.
    r.f.teams
        .submit_result(&r.f.task_id, &r.f.teammate.id, "accuracy 0.9", "ran twice")
        .unwrap();
    r.f.teams.delete_team(&r.f.team.id).unwrap();

    let item = r.work.get(r.project(), &r.f.task_id).unwrap();
    assert_eq!(
        (item.stage, item.review_kind),
        (WorkStage::Review, Some(ReviewKind::Result)),
        "the last change was not lost with the Team"
    );
    assert_eq!(item.result.as_deref(), Some("accuracy 0.9"));
    assert_eq!(item.origin, WorkOrigin::Native, "the workspace now owns it");
    let attempts = r.work.attempts(r.project(), &r.f.task_id).unwrap();
    assert!(attempts.iter().all(|a| !is_open(a.status)));
    assert!(
        r.work
            .assignments(r.project(), &r.f.task_id)
            .unwrap()
            .iter()
            .all(|a| a.ended_at.is_some()),
        "the removed Team's Session no longer executes it"
    );
    // The researcher can still finish the work: it is not orphaned.
    let done = r
        .work
        .review(
            r.project(),
            &item.id,
            ReviewInput {
                accept: true,
                outcome: WorkOutcome::Supported,
                reason: Some("reviewed after the Team was removed"),
            },
            &Actor::Researcher,
        )
        .unwrap();
    assert_eq!(done.stage, WorkStage::Done);
}

#[test]
fn a_stale_card_cannot_act_on_newer_state() {
    let r = rig();
    let (item, session) = r.assigned("card");
    let seen = r.work.get(r.project(), &item.id).unwrap().state_revision;
    // Something else changes the item after the card was rendered.
    r.work
        .set_condition(
            r.project(),
            &item.id,
            WorkCondition::Paused,
            Some("hold on"),
            &r.coordinator(),
        )
        .unwrap();
    let coordinator = r.coordinator();
    assert!(matches!(
        r.work.assign(
            r.project(),
            &item.id,
            &session,
            None,
            "",
            Ctx::expecting(&coordinator, seen),
        ),
        Err(WorkError::StaleState { .. })
    ));
    let current = r.work.get(r.project(), &item.id).unwrap().state_revision;
    r.work
        .set_condition(
            r.project(),
            &item.id,
            WorkCondition::None,
            None,
            Ctx::expecting(&coordinator, current),
        )
        .unwrap();
}

#[test]
fn results_reference_only_records_that_exist_in_this_project() {
    let r = rig();
    let (item, _) = r.assigned("evidence");
    let add = |kind: &'static str, ref_id: &str| {
        r.work.add_result(
            r.project(),
            &item.id,
            NewResult {
                attempt_id: None,
                role: ResultRole::Evidence,
                kind,
                ref_id,
                revision: None,
            },
            &r.coordinator(),
        )
    };
    assert!(
        add("experiment", "no-such-experiment").is_err(),
        "a missing record is refused"
    );
    assert!(add("finding", "nope").is_err());
    assert!(add("file", "../outside").is_err(), "paths stay relative");
    assert!(add("file", "/etc/passwd").is_err(), "paths stay relative");
    assert!(add("unknown-kind", "x").is_err());
    assert!(add("work", &item.id).is_ok(), "work in this Project exists");
    assert!(add("file", "results/table.csv").is_ok());
}

#[test]
fn a_replayed_dispatch_returns_the_attempt_it_already_made() {
    let r = rig();
    let (item, _) = r.assigned("dispatch");
    assert_eq!(
        r.work.get(r.project(), &item.id).unwrap().stage,
        WorkStage::Ready
    );
    let first = r
        .work
        .begin_attempt(r.project(), &item.id, Some("dispatch:1"), &r.coordinator())
        .unwrap();
    let again = r
        .work
        .begin_attempt(r.project(), &item.id, Some("dispatch:1"), &r.coordinator())
        .unwrap();
    assert_eq!(first.id, again.id);
    assert_eq!(r.work.attempts(r.project(), &item.id).unwrap().len(), 1);
    // A different dispatch while the first is open is still an overlap.
    assert!(matches!(
        r.work
            .begin_attempt(r.project(), &item.id, Some("dispatch:2"), &r.coordinator()),
        Err(WorkError::AttemptOpen)
    ));
}

#[test]
fn a_plan_is_reviewed_before_work_starts_and_acceptance_sends_it_on() {
    let r = rig();
    let (item, _) = r.assigned("plan");
    // No plan, nothing to review.
    assert!(
        r.work
            .advance(
                r.project(),
                &item.id,
                item.stage,
                WorkStage::Review,
                Some(ReviewKind::Plan),
                &r.coordinator(),
            )
            .is_err()
    );
    let planned = r
        .work
        .update_plan(
            r.project(),
            &item.id,
            item.revision,
            PlanPatch {
                plan: Some("1. baseline 2. ablate".into()),
                ..Default::default()
            },
            &r.coordinator(),
        )
        .unwrap();
    let reviewing = r
        .work
        .advance(
            r.project(),
            &item.id,
            planned.stage,
            WorkStage::Review,
            Some(ReviewKind::Plan),
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(reviewing.review_kind, Some(ReviewKind::Plan));
    let accepted = r
        .work
        .review(
            r.project(),
            &item.id,
            ReviewInput {
                accept: true,
                outcome: WorkOutcome::Unknown,
                reason: Some("sound"),
            },
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(
        (accepted.stage, accepted.acceptance),
        (WorkStage::Ready, Acceptance::Pending),
        "an accepted plan is not an accepted result"
    );
    let reviews = r.work.reviews(r.project(), &item.id).unwrap();
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0].reason.as_deref(), Some("sound"));
}

#[test]
fn a_pause_survives_dependency_recalculation() {
    let r = rig();
    let item = r.native("paused");
    r.work
        .set_condition(
            r.project(),
            &item.id,
            WorkCondition::Paused,
            Some("budget"),
            &r.coordinator(),
        )
        .unwrap();
    let other = r.native("unrelated");
    r.work
        .update_plan(
            r.project(),
            &other.id,
            other.revision,
            PlanPatch {
                priority: Some(3),
                ..Default::default()
            },
            &r.coordinator(),
        )
        .unwrap();
    let still = r.work.get(r.project(), &item.id).unwrap();
    assert_eq!(still.condition, WorkCondition::Paused);
    assert_eq!(still.condition_reason.as_deref(), Some("budget"));
}

#[test]
fn a_rejected_plan_stays_with_the_planner_instead_of_becoming_ready() {
    let r = rig();
    let item = r.native("plan");
    let planned = r
        .work
        .update_plan(
            r.project(),
            &item.id,
            item.revision,
            PlanPatch {
                plan: Some("try it".into()),
                ..Default::default()
            },
            &r.coordinator(),
        )
        .unwrap();
    r.work
        .advance(
            r.project(),
            &item.id,
            planned.stage,
            WorkStage::Review,
            Some(ReviewKind::Plan),
            &r.coordinator(),
        )
        .unwrap();
    let back = r
        .work
        .review(
            r.project(),
            &item.id,
            ReviewInput {
                accept: false,
                outcome: WorkOutcome::Unknown,
                reason: Some("too vague"),
            },
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(
        (back.stage, back.condition),
        (WorkStage::Planned, WorkCondition::NeedsInput)
    );
    // Once the planner answers, it is eligible again.
    let lifted = r
        .work
        .set_condition(
            r.project(),
            &item.id,
            WorkCondition::None,
            None,
            &r.coordinator(),
        )
        .unwrap();
    assert_eq!(lifted.stage, WorkStage::Ready);
}

#[test]
fn a_teams_experiments_stay_as_evidence_after_the_team_is_deleted() {
    let r = rig();
    let (experiment, _) =
        r.f.reserve("baseline", &["python3", "train.py", "--lr", "1"])
            .unwrap();
    // Evidence is attached to the task through a result reference.
    r.work
        .add_result(
            r.project(),
            &r.f.task_id,
            NewResult {
                attempt_id: None,
                role: ResultRole::Evidence,
                kind: "experiment",
                ref_id: &experiment.id,
                revision: None,
            },
            &Actor::Researcher,
        )
        .expect_err("legacy work is changed through its Team");
    r.f.teams.delete_team(&r.f.team.id).unwrap();
    // Re-owned work accepts the reference, and the experiment still exists.
    r.work
        .add_result(
            r.project(),
            &r.f.task_id,
            NewResult {
                attempt_id: None,
                role: ResultRole::Evidence,
                kind: "experiment",
                ref_id: &experiment.id,
                revision: None,
            },
            &Actor::Researcher,
        )
        .unwrap();
    assert_eq!(
        r.work
            .results(r.project(), &r.f.task_id)
            .unwrap()
            .iter()
            .filter(|result| result.ref_id == experiment.id)
            .count(),
        1
    );
}

#[test]
fn an_attempt_that_never_ran_cannot_complete_and_stage_changes_cannot_start_execution() {
    let r = rig();
    let (item, session) = r.assigned("never ran");
    let attempt = r
        .work
        .begin_attempt(r.project(), &item.id, None, &r.coordinator())
        .unwrap();
    let executor = Actor::Executor {
        conversation_id: session,
    };
    assert!(matches!(
        r.work.finish_attempt(
            r.project(),
            &attempt.id,
            AttemptOutcome::Completed,
            &executor
        ),
        Err(WorkError::Invalid(_))
    ));
    // Rework after a review goes through a new attempt, never a stage move.
    r.work
        .bind_attempt_run(r.project(), &attempt.id, "run-1", &executor)
        .unwrap();
    r.work
        .finish_attempt(
            r.project(),
            &attempt.id,
            AttemptOutcome::Completed,
            &executor,
        )
        .unwrap();
    r.work
        .advance(
            r.project(),
            &item.id,
            WorkStage::Executing,
            WorkStage::Analyzing,
            None,
            &executor,
        )
        .unwrap();
    assert!(matches!(
        r.work.advance(
            r.project(),
            &item.id,
            WorkStage::Analyzing,
            WorkStage::Executing,
            None,
            &r.coordinator(),
        ),
        Err(WorkError::InvalidTransition { .. })
    ));
}

#[test]
fn reserved_and_oversized_inputs_are_refused() {
    let r = rig();
    let (item, session) = r.assigned("limits");
    assert!(
        r.work
            .set_condition(
                r.project(),
                &item.id,
                WorkCondition::Blocked,
                Some("dependency closed: x"),
                &r.coordinator(),
            )
            .is_err(),
        "the automatic-block prefix is reserved"
    );
    let long = "x".repeat(MAX_ID_CHARS + 1);
    assert!(
        r.work
            .assign(
                r.project(),
                &item.id,
                &session,
                Some(&long),
                "",
                &r.coordinator(),
            )
            .is_err()
    );
    let add = |kind: &'static str, ref_id: &str| {
        r.work.add_result(
            r.project(),
            &item.id,
            NewResult {
                attempt_id: None,
                role: ResultRole::Evidence,
                kind,
                ref_id,
                revision: None,
            },
            &r.coordinator(),
        )
    };
    assert!(add("artifact", "no-experiment/../../x").is_err());
    assert!(add("session_turn", &format!("{session}/..")).is_err());
    assert!(add("session_turn", &format!("{session}/turn-1")).is_ok());
}
