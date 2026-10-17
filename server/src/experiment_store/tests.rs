use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use super::testing::{Fixture, launch, limits};
use super::*;
use crate::teams::TeamError;

fn finished(code: i32) -> Outcome {
    Outcome {
        exit_code: Some(code),
        ..Outcome::default()
    }
}

fn denied(result: Result<(Experiment, bool), ExperimentError>) -> LaunchDenial {
    match result {
        Err(ExperimentError::Denied(denial)) => denial,
        other => panic!("expected a denial, got {other:?}"),
    }
}

#[test]
fn envelope_revisions_are_immutable_and_edits_are_checked() {
    let f = Fixture::new();
    let first = f
        .experiments
        .envelope(&f.project_id, &f.research_id, &f.round_id)
        .unwrap()
        .unwrap();
    assert_eq!((first.revision, first.state), (1, EnvelopeState::Active));

    // The same limits change nothing; a stale revision is a conflict.
    let same = f
        .experiments
        .set_envelope(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            Some(1),
            limits(),
            None,
        )
        .unwrap();
    assert_eq!(same.revision, 1);
    let mut wider = limits();
    wider.max_launches = 10;
    let stale = f.experiments.set_envelope(
        &f.project_id,
        &f.research_id,
        &f.round_id,
        Some(7),
        wider.clone(),
        None,
    );
    assert!(matches!(
        stale,
        Err(ExperimentError::EnvelopeConflict { current: 1 })
    ));
    let second = f
        .experiments
        .set_envelope(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            Some(1),
            wider,
            Some("me"),
        )
        .unwrap();
    assert_eq!(second.revision, 2);

    // Invalid limits and foreign scopes are refused.
    let mut zero = limits();
    zero.max_concurrent = 0;
    assert!(matches!(
        f.experiments.set_envelope(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            Some(2),
            zero,
            None
        ),
        Err(ExperimentError::Invalid(_))
    ));
    assert!(matches!(
        f.experiments
            .envelope("other-project", &f.research_id, &f.round_id),
        Err(ExperimentError::NotFound)
    ));
}

#[test]
fn admission_enforces_authorization_budget_and_concurrency() {
    let f = Fixture::new();
    // Only the researcher's allow-listed argv prefixes may run.
    assert_eq!(
        denied(f.reserve("a", &["rm", "-rf", "/"])),
        LaunchDenial::CommandNotAuthorized
    );
    assert_eq!(
        denied(f.reserve("a", &["python3", "evil.py"])),
        LaunchDenial::CommandNotAuthorized
    );

    let (one, created) = f
        .reserve("k1", &["python3", "train.py", "--lr", "1"])
        .unwrap();
    assert!(created);
    assert_eq!(
        (one.state, one.analysis, one.policy_revision),
        (ExperimentState::Reserved, AnalysisState::None, 1)
    );

    // Replay: same experiment, nothing consumed. Reuse with a different command is refused.
    let (replay, created) = f
        .reserve("k1", &["python3", "train.py", "--lr", "1"])
        .unwrap();
    assert!(!created);
    assert_eq!(replay.id, one.id);
    assert!(matches!(
        f.reserve("k1", &["echo", "x"]),
        Err(ExperimentError::KeyReuse)
    ));
    let envelope = f
        .experiments
        .envelope(&f.project_id, &f.research_id, &f.round_id)
        .unwrap()
        .unwrap();
    assert_eq!(envelope.launches_reserved, 1);

    f.reserve("k2", &["echo", "two"]).unwrap();
    // max_concurrent = 2: a third waits until a slot frees.
    assert_eq!(
        denied(f.reserve("k3", &["echo", "three"])),
        LaunchDenial::ConcurrencyLimit
    );
    f.experiments.observe(&one.id, finished(0)).unwrap();
    f.reserve("k3", &["echo", "three"]).unwrap();
    // max_launches = 3 is spent, whatever has finished.
    f.experiments.observe(&replay.id, finished(0)).unwrap();
    assert_eq!(
        denied(f.reserve("k4", &["echo", "four"])),
        LaunchDenial::LaunchBudgetExhausted
    );
}

#[test]
fn a_paused_or_closed_envelope_and_an_inactive_team_stop_future_launches() {
    let f = Fixture::new();
    let (running, _) = f.reserve("k1", &["echo", "a"]).unwrap();
    f.experiments
        .set_envelope_state(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            EnvelopeState::Paused,
        )
        .unwrap();
    assert_eq!(
        denied(f.reserve("k2", &["echo", "b"])),
        LaunchDenial::EnvelopePaused
    );
    // Pausing does not touch work in flight, and replays still answer.
    assert_eq!(
        f.experiments
            .experiment(&f.project_id, &running.id)
            .unwrap()
            .state,
        ExperimentState::Reserved
    );
    assert!(!f.reserve("k1", &["echo", "a"]).unwrap().1);

    f.experiments
        .set_envelope_state(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            EnvelopeState::Active,
        )
        .unwrap();
    f.teams.pause_team(&f.team.id).unwrap();
    assert_eq!(
        denied(f.reserve("k2", &["echo", "b"])),
        LaunchDenial::TeamNotActive
    );
    f.teams.resume_team(&f.team.id).unwrap();
    f.reserve("k2", &["echo", "b"]).unwrap();

    f.experiments
        .set_envelope_state(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            EnvelopeState::Closed,
        )
        .unwrap();
    assert_eq!(
        denied(f.reserve("k3", &["echo", "c"])),
        LaunchDenial::EnvelopeClosed
    );
    assert!(matches!(
        f.experiments.set_envelope_state(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            EnvelopeState::Active
        ),
        Err(ExperimentError::State(_))
    ));
}

#[test]
fn the_deadline_is_enforced_with_an_injectable_clock() {
    let f = Fixture::new();
    let now = Arc::new(AtomicI64::new(1_000));
    let clock = Arc::clone(&now);
    let store = ExperimentStore::from_database(f.agents.database(), Arc::clone(&f.agents))
        .unwrap()
        .with_clock(move || clock.load(Ordering::SeqCst));
    let mut bounded = limits();
    bounded.deadline_at = Some(2_000);
    store
        .set_envelope(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            Some(1),
            bounded,
            None,
        )
        .unwrap();
    let request = |key: &str| launch(&f.round_id, &f.team, key, &["echo", "x"]);
    store
        .reserve(&f.project_id, &f.research_id, request("early"))
        .unwrap();
    now.store(2_000, Ordering::SeqCst);
    assert!(matches!(
        store.reserve(&f.project_id, &f.research_id, request("late")),
        Err(ExperimentError::Denied(LaunchDenial::DeadlinePassed))
    ));
}

#[test]
fn foreign_scopes_are_indistinguishable_from_missing() {
    let f = Fixture::new();
    let mut foreign_member = launch(&f.round_id, &f.team, "m", &["echo", "x"]);
    foreign_member.owner_member_id = Some("someone-else".into());
    assert!(matches!(
        f.experiments
            .reserve(&f.project_id, &f.research_id, foreign_member),
        Err(ExperimentError::NotFound)
    ));
    let mut foreign_task = launch(&f.round_id, &f.team, "t", &["echo", "x"]);
    foreign_task.task_id = Some("not-a-task".into());
    assert!(matches!(
        f.experiments
            .reserve(&f.project_id, &f.research_id, foreign_task),
        Err(ExperimentError::NotFound)
    ));
    assert!(matches!(
        f.experiments.reserve(
            "other-project",
            &f.research_id,
            launch(&f.round_id, &f.team, "p", &["echo"])
        ),
        Err(ExperimentError::NotFound)
    ));
    let (experiment, _) = f.reserve("ok", &["echo", "x"]).unwrap();
    assert!(matches!(
        f.experiments.experiment("other-project", &experiment.id),
        Err(ExperimentError::NotFound)
    ));
}

#[test]
fn concurrent_reservations_never_exceed_the_limits() {
    let f = Arc::new(Fixture::new());
    let handles: Vec<_> = (0..8)
        .map(|index| {
            let f = Arc::clone(&f);
            std::thread::spawn(move || f.reserve(&format!("race-{index}"), &["echo", "x"]).is_ok())
        })
        .collect();
    let admitted = handles
        .into_iter()
        .filter(|_| true)
        .map(|h| h.join().unwrap())
        .filter(|ok| *ok)
        .count();
    assert_eq!(admitted, 2, "max_concurrent is 2");
    let envelope = f
        .experiments
        .envelope(&f.project_id, &f.research_id, &f.round_id)
        .unwrap()
        .unwrap();
    assert_eq!(envelope.launches_reserved, 2);
}

#[test]
fn an_observation_converges_resolves_waits_and_leaves_an_analysis_obligation() {
    let f = Fixture::new();
    let (experiment, _) = f.reserve("k", &["echo", "x"]).unwrap();
    let wait = f
        .experiments
        .register_wait(
            &f.project_id,
            &f.team.id,
            &f.teammate.id,
            &experiment.id,
            Some(&f.task_id),
            "analyze loss",
            None,
        )
        .unwrap();
    assert_eq!(wait.state, WaitState::Open);
    assert!(
        wait.attempt_id.is_some(),
        "the wait is bound to the member's active attempt"
    );
    assert!(wait.deadline_at.is_some(), "a wait always has a deadline");
    // Registering again while open returns the same wait.
    assert_eq!(
        f.experiments
            .register_wait(
                &f.project_id,
                &f.team.id,
                &f.teammate.id,
                &experiment.id,
                None,
                "",
                None
            )
            .unwrap()
            .id,
        wait.id
    );
    assert!(
        f.teams
            .member_has_open_wait(&f.team.id, &f.teammate.id)
            .unwrap()
    );

    assert!(f.experiments.observe(&experiment.id, finished(0)).unwrap());
    assert!(
        !f.experiments.observe(&experiment.id, finished(1)).unwrap(),
        "a duplicate changes nothing"
    );
    let done = f
        .experiments
        .experiment(&f.project_id, &experiment.id)
        .unwrap();
    assert_eq!(
        (done.state, done.analysis, done.exit_code),
        (ExperimentState::Exited, AnalysisState::Pending, Some(0))
    );
    assert!(
        !f.teams
            .member_has_open_wait(&f.team.id, &f.teammate.id)
            .unwrap()
    );
    let waits = f
        .experiments
        .waits(&f.project_id, &f.research_id, &f.round_id)
        .unwrap();
    assert_eq!(waits[0].state, WaitState::Resolved);

    // A wait on an already finished experiment is created resolved: the result is owed.
    let late = f
        .experiments
        .register_wait(
            &f.project_id,
            &f.team.id,
            &f.leader.id,
            &experiment.id,
            None,
            "",
            None,
        )
        .unwrap();
    assert_eq!(late.state, WaitState::Resolved);

    let analyzed = f.experiments.mark_analyzed(&experiment.id).unwrap();
    assert_eq!(analyzed.analysis, AnalysisState::Analyzed);
}

#[test]
fn a_wait_cannot_name_a_foreign_experiment_member_or_task() {
    let f = Fixture::new();
    let (experiment, _) = f.reserve("k", &["echo", "x"]).unwrap();
    for (project, member, task) in [
        ("other-project", f.teammate.id.as_str(), None),
        (f.project_id.as_str(), "nobody", None),
        (
            f.project_id.as_str(),
            f.teammate.id.as_str(),
            Some("not-a-task"),
        ),
    ] {
        assert!(matches!(
            f.experiments.register_wait(
                project,
                &f.team.id,
                member,
                &experiment.id,
                task,
                "",
                None
            ),
            Err(ExperimentError::NotFound)
        ));
    }
    assert!(matches!(
        f.experiments.register_wait(
            &f.project_id,
            "other-team",
            &f.teammate.id,
            &experiment.id,
            None,
            "",
            None
        ),
        Err(ExperimentError::NotFound)
    ));
}

#[test]
fn waits_expire_at_their_deadline_and_reassign_when_the_owner_leaves() {
    let f = Fixture::new();
    let now = Arc::new(AtomicI64::new(10_000));
    let clock = Arc::clone(&now);
    let store = ExperimentStore::from_database(f.agents.database(), Arc::clone(&f.agents))
        .unwrap()
        .with_clock(move || clock.load(Ordering::SeqCst));
    let (experiment, _) = f.reserve("k", &["echo", "x"]).unwrap();
    let wait = store
        .register_wait(
            &f.project_id,
            &f.team.id,
            &f.teammate.id,
            &experiment.id,
            None,
            "",
            Some(10_100),
        )
        .unwrap();
    assert!(store.expire_due_waits().unwrap().is_empty());
    now.store(10_100, Ordering::SeqCst);
    let expired = store.expire_due_waits().unwrap();
    assert_eq!(
        expired.iter().map(|w| w.id.clone()).collect::<Vec<_>>(),
        vec![wait.id.clone()]
    );
    assert!(
        store.expire_due_waits().unwrap().is_empty(),
        "an expired wait expires once"
    );
    assert!(
        !f.teams
            .member_has_open_wait(&f.team.id, &f.teammate.id)
            .unwrap()
    );

    // Reassignment closes an open wait without touching the work.
    let other = store
        .register_wait(
            &f.project_id,
            &f.team.id,
            &f.leader.id,
            &experiment.id,
            None,
            "",
            Some(99_999),
        )
        .unwrap();
    assert_eq!(other.state, WaitState::Open);
    assert_eq!(
        store
            .reassign_waits_of_member(&f.team.id, &f.leader.id)
            .unwrap(),
        1
    );
    assert_eq!(
        f.experiments
            .experiment(&f.project_id, &experiment.id)
            .unwrap()
            .state,
        ExperimentState::Reserved
    );
}

#[test]
fn an_unknown_experiment_keeps_its_slot_until_it_is_reconciled() {
    let f = Fixture::new();
    let (a, _) = f.reserve("a", &["echo", "a"]).unwrap();
    let (_b, _) = f.reserve("b", &["echo", "b"]).unwrap();
    f.experiments
        .observe(
            &a.id,
            Outcome {
                state: Some(ExperimentState::Unknown),
                reason: Some("lost".into()),
                ..Outcome::default()
            },
        )
        .unwrap();
    // The uncertain process still holds a slot: no silent release.
    assert_eq!(
        denied(f.reserve("c", &["echo", "c"])),
        LaunchDenial::ConcurrencyLimit
    );
    // Only a person's explicit truth moves it on; nothing is relaunched.
    assert!(matches!(
        f.experiments.reconcile(
            "other-project",
            &a.id,
            ReconcileTruth::NotStarted,
            None,
            "x"
        ),
        Err(ExperimentError::NotFound)
    ));
    let freed = f
        .experiments
        .reconcile(
            &f.project_id,
            &a.id,
            ReconcileTruth::NotStarted,
            None,
            "researcher",
        )
        .unwrap();
    assert_eq!(
        (freed.state, freed.analysis),
        (ExperimentState::FailedToStart, AnalysisState::None)
    );
    let envelope = f
        .experiments
        .envelope(&f.project_id, &f.research_id, &f.round_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        envelope.launches_reserved, 1,
        "a never-started attempt gives its launch back"
    );
    f.reserve("c", &["echo", "c"]).unwrap();
    assert!(matches!(
        f.experiments
            .reconcile(&f.project_id, &a.id, ReconcileTruth::Finished, Some(0), "x"),
        Err(ExperimentError::State(_))
    ));
}

#[test]
fn repeated_unproductive_attempts_stop_further_admission() {
    let f = Fixture::new();
    let mut wider = limits();
    wider.max_launches = 10;
    wider.max_concurrent = 1;
    f.experiments
        .set_envelope(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            Some(1),
            wider,
            None,
        )
        .unwrap();
    let (first, _) = f.reserve("a", &["echo", "a"]).unwrap();
    f.experiments.observe(&first.id, finished(1)).unwrap();
    let (second, _) = f.reserve("b", &["echo", "b"]).unwrap();
    f.experiments
        .observe(
            &second.id,
            Outcome {
                state: Some(ExperimentState::TimedOut),
                ..Outcome::default()
            },
        )
        .unwrap();
    // max_no_progress = 2 consecutive failures/timeouts.
    assert_eq!(
        denied(f.reserve("c", &["echo", "c"])),
        LaunchDenial::NoProgress
    );
}

#[test]
fn a_successful_attempt_resets_the_no_progress_run_and_cancellation_is_neutral() {
    let f = Fixture::new();
    let mut wider = limits();
    wider.max_launches = 10;
    wider.max_concurrent = 1;
    f.experiments
        .set_envelope(
            &f.project_id,
            &f.research_id,
            &f.round_id,
            Some(1),
            wider,
            None,
        )
        .unwrap();
    for (key, outcome) in [("a", finished(1)), ("b", finished(0))] {
        let (e, _) = f.reserve(key, &["echo", key]).unwrap();
        f.experiments.observe(&e.id, outcome).unwrap();
    }
    let (c, _) = f.reserve("c", &["echo", "c"]).unwrap();
    f.experiments.observe(&c.id, finished(1)).unwrap();
    // One failure after a success is not a streak of two.
    let (d, _) = f.reserve("d", &["echo", "d"]).unwrap();
    // A cancelled reservation neither counts against nor resets progress.
    let cancelled = f.experiments.request_cancel(&d.id).unwrap();
    assert_eq!(cancelled.state, ExperimentState::Cancelled);
    f.reserve("e", &["echo", "e"]).unwrap();
}

#[test]
fn a_cancel_before_launch_is_final_and_a_cancel_during_launch_is_remembered() {
    let f = Fixture::new();
    let (a, _) = f.reserve("a", &["echo", "a"]).unwrap();
    let cancelled = f.experiments.request_cancel(&a.id).unwrap();
    assert_eq!(
        (cancelled.state, cancelled.analysis),
        (ExperimentState::Cancelled, AnalysisState::Pending)
    );

    let (b, _) = f.reserve("b", &["echo", "b"]).unwrap();
    f.experiments.mark_launching(&b.id).unwrap();
    assert_eq!(
        f.experiments.request_cancel(&b.id).unwrap().state,
        ExperimentState::Cancelling
    );
    // The spawn completes after the cancel: the intent is not lost.
    let identity = ProcessIdentity {
        pid: 42,
        start_ticks: 7,
        boot_id: "boot".into(),
    };
    let running = f.experiments.mark_running(&b.id, &identity).unwrap();
    assert_eq!(
        (running.state, running.cancel_requested),
        (ExperimentState::Cancelling, true)
    );
    f.experiments
        .observe(
            &b.id,
            Outcome {
                signal: Some(9),
                ..Outcome::default()
            },
        )
        .unwrap();
    assert_eq!(
        f.experiments
            .experiment(&f.project_id, &b.id)
            .unwrap()
            .state,
        ExperimentState::Cancelled
    );
}

#[test]
fn a_team_cannot_complete_while_experiments_or_analysis_are_outstanding() {
    let f = Fixture::new();
    // Make the delegated task accepted so only execution state can block.
    f.teams
        .submit_result(&f.task_id, &f.teammate.id, "done", "ran")
        .unwrap();
    f.teams
        .review_result(&f.task_id, &f.leader.id, true, None)
        .unwrap();
    f.teams.read_messages(&f.leader.id).unwrap();
    f.teams.read_messages(&f.teammate.id).unwrap();

    let (experiment, _) = f.reserve("k", &["echo", "x"]).unwrap();
    let blocked = |f: &Fixture| {
        matches!(
            f.teams
                .complete_team(&f.team.id, &f.leader.id, "Done", "fp"),
            Err(TeamError::CompletionBlocked)
        )
    };
    assert!(blocked(&f), "a running experiment must be accounted for");
    f.experiments.observe(&experiment.id, finished(0)).unwrap();
    assert!(blocked(&f), "the delivered result must be read");
    f.teams.read_messages(&f.leader.id).unwrap();
    assert!(
        blocked(&f),
        "an unanalyzed result must be accounted for, read or not"
    );
    f.experiments.mark_analyzed(&experiment.id).unwrap();
    f.teams
        .complete_team(&f.team.id, &f.leader.id, "Done", "fp")
        .expect("complete once nothing is owed");
}

// -- Delivery (#164) -----------------------------------------------------------

fn inbox(f: &Fixture, member: &str) -> Vec<crate::teams::TeamMessage> {
    f.teams.pending_messages(member).unwrap()
}

/// The fake clock starts at the real time, because finished_at is stamped by
/// the database.
fn real_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn store_with_clock(f: &Fixture, clock: Arc<AtomicI64>) -> ExperimentStore {
    ExperimentStore::from_database(f.agents.database(), Arc::clone(&f.agents))
        .unwrap()
        .with_clock(move || clock.load(Ordering::SeqCst))
}

#[test]
fn a_result_is_enqueued_for_the_waiting_member_in_the_same_commit_exactly_once() {
    let f = Fixture::new();
    let (experiment, _) = f.reserve("k", &["echo", "x"]).unwrap();
    f.experiments
        .register_wait(
            &f.project_id,
            &f.team.id,
            &f.teammate.id,
            &experiment.id,
            Some(&f.task_id),
            "analyze",
            None,
        )
        .unwrap();
    let before = inbox(&f, &f.teammate.id).len();

    assert!(f.experiments.observe(&experiment.id, finished(0)).unwrap());
    assert!(!f.experiments.observe(&experiment.id, finished(0)).unwrap());
    let messages = inbox(&f, &f.teammate.id);
    assert_eq!(messages.len(), before + 1, "one observation, one delivery");
    let message = messages.iter().find(|m| m.body.contains("ended")).unwrap();
    assert!(
        message.body.contains("ended: exited") && message.body.contains("analysis"),
        "{}",
        message.body
    );
    assert_eq!(message.task_id.as_deref(), Some(f.task_id.as_str()));
    assert!(
        inbox(&f, &f.leader.id)
            .iter()
            .all(|m| !m.body.contains("ended: exited"))
    );
}

#[test]
fn delivery_routes_to_the_leader_when_the_owner_is_gone_or_there_was_no_wait() {
    let f = Fixture::new();
    let (waited, _) = f.reserve("a", &["echo", "a"]).unwrap();
    f.experiments
        .register_wait(
            &f.project_id,
            &f.team.id,
            &f.teammate.id,
            &waited.id,
            None,
            "",
            None,
        )
        .unwrap();
    f.experiments
        .reassign_waits_of_member(&f.team.id, &f.teammate.id)
        .unwrap();
    f.teams
        .remove_teammate(&f.team.id, &f.leader.id, &f.teammate.id)
        .unwrap();
    f.experiments.observe(&waited.id, finished(0)).unwrap();
    assert!(
        inbox(&f, &f.leader.id)
            .iter()
            .any(|m| m.body.contains("ended: exited")),
        "an absent owner routes to the Leader"
    );

    let (unowned, _) = f.reserve("b", &["echo", "b"]).unwrap();
    f.experiments.observe(&unowned.id, finished(2)).unwrap();
    let leader_messages = inbox(&f, &f.leader.id);
    assert!(
        leader_messages
            .iter()
            .any(|m| m.body.contains("exit code 2"))
    );
}

#[test]
fn a_delivery_that_commits_without_a_wake_is_still_pending_for_the_supervisor() {
    let f = Fixture::new();
    let woken = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let record = Arc::clone(&woken);
    f.experiments
        .set_delivery_hook(move |team| record.lock().unwrap().push(team.to_owned()));
    let (experiment, _) = f.reserve("k", &["echo", "x"]).unwrap();
    f.experiments.observe(&experiment.id, finished(0)).unwrap();
    assert_eq!(
        *woken.lock().unwrap(),
        vec![f.team.id.clone()],
        "woken once, after commit"
    );
    // Whether or not the wake worked, the obligation is a committed row.
    assert!(
        inbox(&f, &f.leader.id)
            .iter()
            .any(|m| m.body.contains("ended"))
    );
    assert_eq!(
        f.experiments.get(&experiment.id).unwrap().analysis,
        AnalysisState::Pending
    );
    f.experiments.observe(&experiment.id, finished(0)).unwrap();
    assert_eq!(
        woken.lock().unwrap().len(),
        1,
        "a duplicate observation wakes nobody"
    );
}

#[test]
fn an_expired_wait_notifies_its_owner_once() {
    let f = Fixture::new();
    let now = Arc::new(AtomicI64::new(10_000));
    let store = store_with_clock(&f, Arc::clone(&now));
    let (experiment, _) = f.reserve("k", &["echo", "x"]).unwrap();
    store
        .register_wait(
            &f.project_id,
            &f.team.id,
            &f.teammate.id,
            &experiment.id,
            None,
            "",
            Some(10_050),
        )
        .unwrap();
    let before = inbox(&f, &f.teammate.id).len();
    now.store(10_060, Ordering::SeqCst);
    assert_eq!(store.expire_due_waits().unwrap().len(), 1);
    assert_eq!(store.expire_due_waits().unwrap().len(), 0);
    let messages = inbox(&f, &f.teammate.id);
    assert_eq!(messages.len(), before + 1);
    assert!(messages.iter().any(|m| m.body.contains("expired")));
    // The experiment itself is untouched.
    assert_eq!(
        f.experiments.get(&experiment.id).unwrap().state,
        ExperimentState::Reserved
    );
}

#[test]
fn an_acknowledged_but_unanalyzed_result_is_re_raised_a_bounded_number_of_times() {
    let f = Fixture::new();
    let now = Arc::new(AtomicI64::new(real_now()));
    let store = store_with_clock(&f, Arc::clone(&now));
    let (experiment, _) = f.reserve("k", &["echo", "x"]).unwrap();
    f.experiments.observe(&experiment.id, finished(0)).unwrap();

    // Unread: the mailbox lease handles redelivery, not a reminder.
    now.fetch_add(10_000, Ordering::SeqCst);
    assert!(store.remind_unanalyzed(600, 2).unwrap().reminded.is_empty());

    // Read (acknowledged) but not analyzed: the obligation remains detectable.
    f.teams.read_messages(&f.leader.id).unwrap();
    assert_eq!(
        f.experiments.get(&experiment.id).unwrap().analysis,
        AnalysisState::Pending
    );
    let first = store.remind_unanalyzed(600, 2).unwrap();
    assert_eq!(first.reminded, vec![experiment.id.clone()]);
    assert!(
        inbox(&f, &f.leader.id)
            .iter()
            .any(|m| m.body.starts_with("Reminder 1"))
    );
    // Not again until the interval passes.
    assert!(store.remind_unanalyzed(600, 2).unwrap().reminded.is_empty());

    f.teams.read_messages(&f.leader.id).unwrap();
    now.fetch_add(700, Ordering::SeqCst);
    assert_eq!(store.remind_unanalyzed(600, 2).unwrap().reminded.len(), 1);
    f.teams.read_messages(&f.leader.id).unwrap();
    now.fetch_add(700, Ordering::SeqCst);
    let exhausted = store.remind_unanalyzed(600, 2).unwrap();
    assert!(exhausted.reminded.is_empty());
    assert_eq!(
        exhausted.exhausted,
        vec![(f.team.id.clone(), experiment.id.clone())]
    );

    // An explicit analysis ends the obligation.
    f.experiments.mark_analyzed(&experiment.id).unwrap();
    now.fetch_add(10_000, Ordering::SeqCst);
    let after = store.remind_unanalyzed(600, 2).unwrap();
    assert!(after.reminded.is_empty() && after.exhausted.is_empty());
}

#[test]
fn a_paused_team_gets_no_reminders_and_keeps_its_pending_events() {
    let f = Fixture::new();
    let now = Arc::new(AtomicI64::new(real_now()));
    let store = store_with_clock(&f, Arc::clone(&now));
    let (experiment, _) = f.reserve("k", &["echo", "x"]).unwrap();
    f.experiments.observe(&experiment.id, finished(0)).unwrap();
    f.teams.read_messages(&f.leader.id).unwrap();
    f.teams.pause_team(&f.team.id).unwrap();
    now.fetch_add(10_000, Ordering::SeqCst);
    let paused = store.remind_unanalyzed(600, 3).unwrap();
    assert!(paused.reminded.is_empty() && paused.exhausted.is_empty());
    f.teams.resume_team(&f.team.id).unwrap();
    assert_eq!(
        store.remind_unanalyzed(600, 3).unwrap().reminded.len(),
        1,
        "resumes from current state"
    );
}
