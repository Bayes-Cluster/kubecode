use std::sync::Arc;

use super::*;
use crate::channel_store::{Intent, MessageQuery, Scope};
use crate::experiment_store::testing::Fixture;
use crate::orchestrator::{
    DeliveryOutcome, DeliveryRequest, Orchestrator, RouteKind, RouteSink, RouteState,
};
use crate::work_store::{AttemptStatus, PolicyPatch};

struct Rig {
    f: Fixture,
    work: Arc<WorkStore>,
    channels: Arc<ChannelStore>,
    orchestrator: Arc<Orchestrator>,
}

struct Always;
impl RouteSink for Always {
    fn deliver(&self, _: &DeliveryRequest<'_>) -> DeliveryOutcome {
        DeliveryOutcome::Delivered
    }
}

fn rig() -> Rig {
    let f = Fixture::new();
    let work =
        Arc::new(WorkStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap());
    let channels =
        Arc::new(ChannelStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap());
    let orchestrator = Arc::new(
        Orchestrator::new(
            f.agents.database(),
            Arc::clone(&f.agents),
            Arc::clone(&channels),
            Arc::clone(&work),
            Arc::clone(&f.research),
        )
        .unwrap(),
    );
    Rig {
        f,
        work,
        channels,
        orchestrator,
    }
}

impl Rig {
    fn agent(&self, project: &str, caller: &str) -> WorkAgent {
        WorkAgent::new(
            project.to_owned(),
            caller.to_owned(),
            Arc::clone(&self.work),
            Arc::clone(&self.channels),
            Arc::clone(&self.orchestrator),
            Arc::clone(&self.f.research),
            Arc::clone(&self.f.agents),
            Arc::new(|agent| agent == AgentId::OpenCode),
        )
    }

    fn leader(&self) -> WorkAgent {
        self.agent(&self.f.project_id, &self.f.leader.conversation_id)
    }

    /// An executor Session the coordinator made for the round.
    fn executor(&self, coordinator: &WorkAgent, key: &str) -> String {
        coordinator
            .create_executor(None, "opencode", key, key)
            .unwrap()
    }

    fn session(&self, title: &str) -> String {
        self.f
            .agents
            .create_conversation(&self.f.project_id, AgentId::OpenCode, Some(title))
            .unwrap()
            .id
    }

    fn thread(&self) -> Thread {
        let channel = self.channels.default_channel(&self.f.project_id).unwrap();
        let root = self
            .channels
            .post(
                &self.f.project_id,
                &channel.id,
                NewMessage {
                    body: "Prune the heads?",
                    ..Default::default()
                },
            )
            .unwrap()
            .0;
        let (thread, _) = self
            .channels
            .start_thread(&self.f.project_id, &channel.id, &root.id, None, None)
            .unwrap();
        self.channels
            .link_thread(
                &self.f.project_id,
                &thread.id,
                1,
                Some(&self.f.research_id),
                Some(&self.f.round_id),
            )
            .unwrap()
    }

    fn task<'a>(&self, title: &'a str, thread: Option<&'a str>) -> NewTask<'a> {
        NewTask {
            round_id: None,
            title,
            description: "do the thing",
            plan: None,
            depends_on: &[],
            from_thread: thread,
            client_request_id: None,
        }
    }

    fn texts(&self, thread: &Thread) -> Vec<(AuthorKind, String)> {
        self.channels
            .messages(
                &self.f.project_id,
                &thread.channel_id,
                MessageQuery {
                    scope: Scope::Thread(&thread.id),
                    ..Default::default()
                },
            )
            .unwrap()
            .messages
            .into_iter()
            .map(|m| (m.author_kind, m.body))
            .collect()
    }
}

#[test]
fn a_round_grows_from_one_executor_to_several_and_every_result_reaches_its_thread() {
    let r = rig();
    let thread = r.thread();
    let coordinator = r.leader();
    // Work comes from the Thread, once however often the command is replayed.
    let first = coordinator.create(NewTask {
        client_request_id: Some("t-1"),
        ..r.task("Sweep ratios", Some(&thread.id))
    });
    let first = first.unwrap();
    let again = coordinator
        .create(NewTask {
            client_request_id: Some("t-1"),
            ..r.task("Sweep ratios", Some(&thread.id))
        })
        .unwrap();
    assert_eq!(first.item.id, again.item.id);
    let second = coordinator
        .create(NewTask {
            client_request_id: Some("t-2"),
            ..r.task("Quantize", Some(&thread.id))
        })
        .unwrap();

    // One executor first, then a second one for the second task: the round
    // keeps its history and tasks while it grows.
    let a = coordinator
        .create_executor(None, "opencode", "Pruner", "k-pruner")
        .unwrap();
    let b = coordinator
        .create_executor(None, "opencode", "Quantizer", "k-quantizer")
        .unwrap();
    coordinator.assign(&first.item.id, &a, "").unwrap();
    coordinator.assign(&second.item.id, &b, "").unwrap();
    let attempt = coordinator.start(&first.item.id, "start-1").unwrap();
    // A replay starts nothing new and routes nothing new.
    assert_eq!(
        coordinator.start(&first.item.id, "start-1").unwrap().id,
        attempt.id
    );
    let dispatches = r
        .orchestrator
        .routes(&r.f.project_id, None, 50)
        .unwrap()
        .into_iter()
        .filter(|route| route.kind == RouteKind::Dispatch)
        .count();
    assert_eq!(dispatches, 1);

    // The dispatch reaches the executor while its attempt is open.
    r.orchestrator.tick(&Always).unwrap();
    // The executor works under its own identity and reports.
    let executor = r.agent(&r.f.project_id, &a);
    r.work
        .bind_attempt_run(&r.f.project_id, &attempt.id, "run-1", &Actor::Researcher)
        .unwrap();
    executor
        .attach(
            &first.item.id,
            "file",
            "results/pruning.csv",
            None,
            ResultRole::Evidence,
        )
        .unwrap();
    let reported = executor
        .report(
            &first.item.id,
            ReportStatus::Completed,
            "30% pruning keeps 0.91",
            None,
        )
        .unwrap();
    assert_eq!(reported.item.stage, WorkStage::Review);
    let notes = r.texts(&thread);
    assert_eq!(
        notes
            .iter()
            .filter(|(_, text)| text.contains("30% pruning keeps 0.91"))
            .count(),
        1
    );
    // The coordinator hears of it and accepts through the review command.
    r.orchestrator.tick(&Always).unwrap();
    let done = coordinator
        .review(
            &first.item.id,
            true,
            WorkOutcome::Supported,
            Some("reproducible"),
        )
        .unwrap();
    assert_eq!(
        (done.item.stage, done.item.acceptance),
        (WorkStage::Done, crate::work_store::Acceptance::Accepted)
    );
    let routes = r
        .orchestrator
        .routes(&r.f.project_id, Some(RouteState::Delivered), 50)
        .unwrap();
    assert!(routes.iter().any(|route| route.kind == RouteKind::Result));
    assert!(routes.iter().any(|route| route.kind == RouteKind::Dispatch));
}

#[test]
fn authority_comes_from_persisted_state_not_from_who_claims_a_role() {
    let r = rig();
    let coordinator = r.leader();
    let item = coordinator.create(r.task("Task", None)).unwrap();
    let executor_id = r.executor(&coordinator, "executor");
    coordinator.assign(&item.item.id, &executor_id, "").unwrap();
    let executor = r.agent(&r.f.project_id, &executor_id);
    let stranger_id = r.session("Stranger");
    let stranger = r.agent(&r.f.project_id, &stranger_id);

    // The executor sees its task but cannot coordinate it.
    assert!(executor.get(&item.item.id).is_ok());
    for result in [
        executor.assign(&item.item.id, &stranger_id, "").map(|_| ()),
        executor.start(&item.item.id, "k").map(|_| ()),
        executor
            .review(&item.item.id, true, WorkOutcome::Supported, None)
            .map(|_| ()),
        executor.handoff(&r.f.round_id, &stranger_id, "mine now"),
    ] {
        assert!(
            matches!(result, Err(AgentWorkError::NotCoordinator)),
            "{result:?}"
        );
    }
    assert!(executor.policy(None).is_err());
    assert!(matches!(
        executor.create(r.task("Sneaky", None)),
        Err(AgentWorkError::NotCoordinator)
    ));
    // A Session with no role cannot even tell the task exists.
    assert!(matches!(
        stranger.get(&item.item.id),
        Err(AgentWorkError::NotFound)
    ));
    assert!(matches!(
        stranger.attach(&item.item.id, "file", "x", None, ResultRole::Evidence),
        Err(AgentWorkError::NotFound)
    ));
    assert!(stranger.list(None).unwrap().is_empty());
    // The executor cannot report on a task it does not execute.
    let other = coordinator.create(r.task("Other", None)).unwrap();
    assert!(matches!(
        executor.report(&other.item.id, ReportStatus::Completed, "x", None),
        Err(AgentWorkError::NotFound)
    ));
}

#[test]
fn a_handoff_revokes_the_old_coordinator_on_its_next_command_and_keeps_the_work() {
    let r = rig();
    let old = r.leader();
    let item = old.create(r.task("Task", None)).unwrap();
    let successor_id = r.session("Successor");
    let old_made = r.executor(&old, "old-made");
    old.handoff(&r.f.round_id, &successor_id, "going away")
        .unwrap();
    let new = r.agent(&r.f.project_id, &successor_id);

    for result in [
        old.create(r.task("Late", None)).map(|_| ()),
        old.assign(&item.item.id, &old_made, "").map(|_| ()),
        old.update(&item.item.id, 1, PlanPatch::default())
            .map(|_| ()),
        old.handoff(&r.f.round_id, &successor_id, "again"),
    ] {
        assert!(result.is_err(), "{result:?}");
    }
    assert!(
        old.get(&item.item.id).is_err(),
        "the old coordinator no longer sees it"
    );
    // The task, its history, and its creator survive; the new holder carries on.
    let carried = new.get(&item.item.id).unwrap();
    assert_eq!(carried.item.title, "Task");
    let executor = r.executor(&new, "carried-on");
    new.assign(&item.item.id, &executor, "").unwrap();
    assert!(new.create(r.task("Next", None)).is_ok());
}

#[test]
fn limits_are_enforced_for_the_coordinator_and_only_the_researcher_widens_them() {
    let r = rig();
    r.work
        .set_policy(
            &r.f.project_id,
            &r.f.round_id,
            0,
            PolicyPatch {
                max_executors: Some(2),
                max_parallel_attempts: Some(2),
                max_attempts: Some(3),
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap();
    let coordinator = r.leader();
    let view = coordinator.policy(None).unwrap();
    assert_eq!((view.policy.max_executors, view.used.executors), (2, 1));
    let a = coordinator.create(r.task("A", None)).unwrap();
    let b = coordinator.create(r.task("B", None)).unwrap();
    let session_a = r.executor(&coordinator, "a");
    let session_b = r.executor(&coordinator, "b");
    coordinator.assign(&a.item.id, &session_a, "").unwrap();
    // The Team's teammate and Session A fill both executor slots.
    assert!(matches!(
        coordinator.assign(&b.item.id, &session_b, ""),
        Err(AgentWorkError::Work(WorkError::BudgetExhausted(
            "executors"
        )))
    ));
    // The legacy attempt is open, so one more native attempt fits and then no more.
    coordinator.start(&a.item.id, "a-1").unwrap();
    coordinator.assign(&b.item.id, &session_a, "").unwrap();
    assert!(matches!(
        coordinator.start(&b.item.id, "b-1"),
        Err(AgentWorkError::Work(WorkError::BudgetExhausted(
            "parallel attempts"
        )))
    ));
    // A tool-level view of "widening" does not exist; the researcher does it.
    r.work
        .set_policy(
            &r.f.project_id,
            &r.f.round_id,
            1,
            PolicyPatch {
                max_parallel_attempts: Some(3),
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap();
    assert!(coordinator.start(&b.item.id, "b-1").is_ok());
    // Paused: no new Sessions and no new attempts.
    r.work
        .set_policy(
            &r.f.project_id,
            &r.f.round_id,
            2,
            PolicyPatch {
                paused: Some(true),
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap();
    assert!(matches!(
        coordinator.create_executor(None, "opencode", "More", "k-more"),
        Err(AgentWorkError::Work(WorkError::RoundPaused))
    ));
}

#[test]
fn executors_come_only_from_available_providers_and_never_start_work_themselves() {
    let r = rig();
    let coordinator = r.leader();
    assert!(matches!(
        coordinator.create_executor(None, "codex", "Nope", "k-nope"),
        Err(AgentWorkError::Invalid(_))
    ));
    assert!(matches!(
        coordinator.create_executor(None, "gpt-9000", "Nope", "k-nope"),
        Err(AgentWorkError::Invalid(_))
    ));
    let id = coordinator
        .create_executor(None, "opencode", "Helper", "k-helper")
        .unwrap();
    // The new Session exists but runs nothing and holds no assignment.
    assert!(r.f.agents.list_runs(&id).unwrap().is_empty());
    assert!(
        r.work
            .list(
                &r.f.project_id,
                &WorkFilter {
                    conversation_id: Some(id.clone()),
                    ..Default::default()
                }
            )
            .unwrap()
            .is_empty()
    );
    // Its tools show it nothing to coordinate.
    assert!(matches!(
        r.agent(&r.f.project_id, &id).policy(None),
        Err(AgentWorkError::NotCoordinator)
    ));
}

#[test]
fn a_failed_attempt_stays_in_execution_and_is_reported_not_swallowed() {
    let r = rig();
    let thread = r.thread();
    let coordinator = r.leader();
    let item = coordinator
        .create(r.task("Flaky", Some(&thread.id)))
        .unwrap();
    let executor_id = r.executor(&coordinator, "executor");
    coordinator.assign(&item.item.id, &executor_id, "").unwrap();
    let attempt = coordinator.start(&item.item.id, "k1").unwrap();
    let executor = r.agent(&r.f.project_id, &executor_id);
    // Completing without a run to attribute it to is refused.
    assert!(matches!(
        executor.report(&item.item.id, ReportStatus::Completed, "done", None),
        Err(AgentWorkError::Invalid(_))
    ));
    let failed = executor
        .report(
            &item.item.id,
            ReportStatus::Failed,
            "ran out of memory",
            Some("OOM"),
        )
        .unwrap();
    assert_eq!(failed.item.stage, WorkStage::Executing);
    assert_eq!(
        failed.latest_attempt.as_ref().unwrap().status,
        AttemptStatus::Failed
    );
    assert!(
        r.texts(&thread)
            .iter()
            .any(|(_, text)| text.contains("FAILED: OOM") && text.contains("ran out of memory"))
    );
    // A closed attempt cannot be reported twice, and a retry is a new attempt.
    assert!(
        executor
            .report(&item.item.id, ReportStatus::Failed, "again", None)
            .is_err()
    );
    let retry = coordinator.start(&item.item.id, "k2").unwrap();
    assert_ne!(retry.id, attempt.id);
}

#[test]
fn a_thread_of_another_question_cannot_justify_this_rounds_work() {
    let r = rig();
    let other_question =
        r.f.research
            .create(
                &r.f.project_id,
                crate::research_store::ResearchBrief {
                    title: "Quantization".into(),
                    question: "?".into(),
                    ..Default::default()
                },
                None,
            )
            .unwrap()
            .0;
    let thread = r.thread();
    let channel = r.channels.default_channel(&r.f.project_id).unwrap();
    let root = r
        .channels
        .post(
            &r.f.project_id,
            &channel.id,
            NewMessage {
                body: "other topic",
                ..Default::default()
            },
        )
        .unwrap()
        .0;
    let (foreign, _) = r
        .channels
        .start_thread(&r.f.project_id, &channel.id, &root.id, None, None)
        .unwrap();
    r.channels
        .link_thread(
            &r.f.project_id,
            &foreign.id,
            1,
            Some(&other_question.id),
            None,
        )
        .unwrap();
    let coordinator = r.leader();
    assert!(matches!(
        coordinator.create(r.task("Wrong context", Some(&foreign.id))),
        Err(AgentWorkError::Invalid(_))
    ));
    assert!(
        coordinator
            .create(r.task("Right context", Some(&thread.id)))
            .is_ok()
    );
}

#[test]
fn agents_speak_only_where_they_have_standing() {
    let r = rig();
    let thread = r.thread();
    let coordinator = r.leader();
    let stranger_id = r.session("Stranger");
    let stranger = r.agent(&r.f.project_id, &stranger_id);

    let posted = coordinator
        .post(&thread.id, "Plan: two sweeps, then analysis.", &[])
        .unwrap();
    assert_eq!(posted.author_kind, AuthorKind::Agent);
    assert_eq!(
        posted.author_ref.as_deref(),
        Some(r.f.leader.conversation_id.as_str())
    );
    // The same words twice are one message.
    assert_eq!(
        coordinator
            .post(&thread.id, "Plan: two sweeps, then analysis.", &[])
            .unwrap()
            .id,
        posted.id
    );
    assert!(matches!(
        stranger.post(&thread.id, "Hi", &[]),
        Err(AgentWorkError::NotFound)
    ));

    // A Session asked about a top-level message may answer it, in its Thread.
    let channel = r.channels.default_channel(&r.f.project_id).unwrap();
    let mention = [crate::channel_store::Mention {
        session_id: stranger_id.clone(),
    }];
    let question = r
        .channels
        .post(
            &r.f.project_id,
            &channel.id,
            NewMessage {
                body: "What do you think?",
                intent: Some(Intent::Ask),
                mentions: &mention,
                client_message_id: Some("ask-1"),
                ..Default::default()
            },
        )
        .unwrap()
        .0;
    assert!(matches!(
        stranger.post(&question.id, "early", &[]),
        Err(AgentWorkError::NotFound)
    ));
    r.orchestrator.route_intents().unwrap();
    let answer = stranger
        .post(&question.id, "I'd try structured pruning.", &[])
        .unwrap();
    assert!(answer.thread_id.is_some());
    // The coordinator of an unrelated Thread is not welcome in it.
    let unrelated = r
        .channels
        .thread(&r.f.project_id, answer.thread_id.as_deref().unwrap())
        .unwrap();
    assert!(matches!(
        coordinator.post(&unrelated.id, "butting in", &[]),
        Err(AgentWorkError::NotFound)
    ));
}

#[test]
fn another_projects_sessions_have_no_standing_here() {
    let r = rig();
    let thread = r.thread();
    let coordinator = r.leader();
    let item = coordinator
        .create(r.task("Task", Some(&thread.id)))
        .unwrap();
    let other = r.f.workspace.create_project(".", "beta").unwrap();
    let outsider =
        r.f.agents
            .create_conversation(&other.id, AgentId::OpenCode, Some("Outsider"))
            .unwrap();
    let agent = r.agent(&other.id, &outsider.id);
    assert!(matches!(
        agent.get(&item.item.id),
        Err(AgentWorkError::NotFound)
    ));
    assert!(matches!(
        agent.post(&thread.id, "hello", &[]),
        Err(AgentWorkError::NotFound)
    ));
    assert!(agent.list(None).unwrap().is_empty());
    // Even naming the round does not make the outsider its coordinator.
    assert!(agent.policy(Some(&r.f.round_id)).is_err());
    assert!(agent.handoff(&r.f.round_id, &outsider.id, "mine").is_err());
}

// -- Review regressions ---------------------------------------------------------------------------------

#[test]
fn executors_are_made_once_per_request_and_are_the_only_other_sessions_a_coordinator_directs() {
    let r = rig();
    let coordinator = r.leader();
    let item = coordinator.create(r.task("Task", None)).unwrap();
    // A key is required, and a retry returns the same Session.
    assert!(matches!(
        coordinator.create_executor(None, "opencode", "x", "  "),
        Err(AgentWorkError::Invalid(_))
    ));
    let first = coordinator
        .create_executor(None, "opencode", "Pruner", "same-key")
        .unwrap();
    assert_eq!(
        coordinator
            .create_executor(None, "opencode", "Pruner", "same-key")
            .unwrap(),
        first
    );
    // The new Session is idle: no run, no escalated permissions to inherit.
    assert!(r.f.agents.list_runs(&first).unwrap().is_empty());
    // Other Sessions of the Project (the researcher's chats, Team members) are not its to direct.
    let chat = r.session("Researcher's chat");
    for target in [chat.as_str(), r.f.teammate.conversation_id.as_str()] {
        assert!(
            matches!(
                coordinator.assign(&item.item.id, target, ""),
                Err(AgentWorkError::Invalid(_))
            ),
            "{target}"
        );
    }
    assert!(coordinator.assign(&item.item.id, &first, "").is_ok());
    assert!(
        coordinator
            .assign(&item.item.id, &r.f.leader.conversation_id, "")
            .is_ok(),
        "a coordinator may execute work itself"
    );
    // A loop cannot flood the Project with idle Sessions: twice the executor limit.
    let mut refused = None;
    for n in 0..20 {
        if let Err(error) =
            coordinator.create_executor(None, "opencode", "Flood", &format!("flood-{n}"))
        {
            refused = Some((n, error));
            break;
        }
    }
    let (n, error) = refused.expect("the cap must stop the loop");
    assert!(n >= 1, "a few are allowed before the cap");
    assert!(matches!(
        error,
        AgentWorkError::Work(WorkError::BudgetExhausted(_))
    ));
}

#[test]
fn a_thread_must_be_this_rounds_discussion_to_justify_its_work() {
    let r = rig();
    let coordinator = r.leader();
    let channel = r.channels.default_channel(&r.f.project_id).unwrap();
    let root = r
        .channels
        .post(
            &r.f.project_id,
            &channel.id,
            NewMessage {
                body: "unlinked",
                ..Default::default()
            },
        )
        .unwrap()
        .0;
    let (unlinked, _) = r
        .channels
        .start_thread(&r.f.project_id, &channel.id, &root.id, None, None)
        .unwrap();
    assert!(matches!(
        coordinator.create(r.task("Chosen standing", Some(&unlinked.id))),
        Err(AgentWorkError::Invalid(_))
    ));
}

#[test]
fn standing_in_a_thread_ends_with_the_authority_that_gave_it() {
    let r = rig();
    let thread = r.thread();
    let old = r.leader();
    let item = old
        .create(r.task("From the thread", Some(&thread.id)))
        .unwrap();
    let executor_id = r.executor(&old, "worker");
    old.assign(&item.item.id, &executor_id, "").unwrap();
    let executor = r.agent(&r.f.project_id, &executor_id);
    assert!(executor.post(&thread.id, "working on it", &[]).is_ok());
    assert!(old.post(&thread.id, "status", &[]).is_ok());

    // The coordinator hands off: its standing goes with its authority.
    let successor = r.session("Successor");
    old.handoff(&r.f.round_id, &successor, "rotate").unwrap();
    assert!(matches!(
        old.post(&thread.id, "still here?", &[]),
        Err(AgentWorkError::NotFound)
    ));
    assert!(
        r.agent(&r.f.project_id, &successor)
            .post(&thread.id, "mine now", &[])
            .is_ok()
    );

    // The task is reassigned: the previous executor can no longer speak for it.
    let new = r.agent(&r.f.project_id, &successor);
    let replacement = r.executor(&new, "replacement");
    new.assign(&item.item.id, &replacement, "swap").unwrap();
    assert!(matches!(
        executor.post(&thread.id, "also me", &[]),
        Err(AgentWorkError::NotFound)
    ));
}

#[test]
fn a_report_repeated_after_a_crash_finishes_what_was_left_undone() {
    let r = rig();
    let thread = r.thread();
    let coordinator = r.leader();
    let item = coordinator
        .create(r.task("Task", Some(&thread.id)))
        .unwrap();
    let executor_id = r.executor(&coordinator, "worker");
    coordinator.assign(&item.item.id, &executor_id, "").unwrap();
    let attempt = coordinator.start(&item.item.id, "k").unwrap();
    r.work
        .bind_attempt_run(&r.f.project_id, &attempt.id, "run-1", &Actor::Researcher)
        .unwrap();
    let executor = r.agent(&r.f.project_id, &executor_id);
    // The process died after the attempt was closed but before anything else:
    // simulate by closing it directly.
    r.work
        .finish_attempt(
            &r.f.project_id,
            &attempt.id,
            AttemptOutcome::Completed,
            &Actor::Executor {
                conversation_id: executor_id.clone(),
            },
        )
        .unwrap();
    // The executor retries the same report: the stage moves, the Thread and the
    // coordinator are told, and a second retry adds nothing.
    for _ in 0..2 {
        let fresh = executor
            .report(&item.item.id, ReportStatus::Completed, "30% works", None)
            .unwrap();
        assert_eq!(fresh.item.stage, WorkStage::Review);
    }
    let notes = r.texts(&thread);
    assert_eq!(
        notes
            .iter()
            .filter(|(_, t)| t.contains("30% works"))
            .count(),
        1
    );
    let results = r
        .orchestrator
        .routes_for(&r.f.project_id, None, Some(&item.item.id), 20)
        .unwrap()
        .into_iter()
        .filter(|route| route.kind == RouteKind::Result)
        .count();
    assert_eq!(results, 1);
    // A different outcome for a closed attempt is still refused.
    assert!(matches!(
        executor.report(&item.item.id, ReportStatus::Failed, "no", None),
        Err(AgentWorkError::Invalid(_))
    ));
}

#[test]
fn a_coordinator_that_assigns_itself_can_report_its_own_attempt() {
    let r = rig();
    let coordinator = r.leader();
    let me = r.f.leader.conversation_id.clone();
    let item = coordinator.create(r.task("Simple work", None)).unwrap();
    coordinator
        .assign(&item.item.id, &me, "no teammate needed")
        .unwrap();
    let attempt = coordinator.start(&item.item.id, "k").unwrap();
    r.work
        .bind_attempt_run(&r.f.project_id, &attempt.id, "run-1", &Actor::Researcher)
        .unwrap();
    let reported = coordinator
        .report(&item.item.id, ReportStatus::Completed, "done", None)
        .unwrap();
    assert_eq!(reported.item.stage, WorkStage::Review);
}

#[test]
fn a_handoff_tells_the_new_coordinator_what_it_holds() {
    let r = rig();
    let old = r.leader();
    old.create(r.task("Open task", None)).unwrap();
    let successor = r.session("Successor");
    old.handoff(&r.f.round_id, &successor, "going away")
        .unwrap();
    let route = r
        .orchestrator
        .routes(&r.f.project_id, None, 10)
        .unwrap()
        .into_iter()
        .find(|route| route.kind == RouteKind::Handoff)
        .expect("a handoff route");
    assert_eq!(
        route.target,
        crate::orchestrator::Target::Session {
            session_id: successor.clone()
        }
    );
    assert!(route.body.contains("Open task"));
    assert!(route.body.contains("going away"));
}

// -- Experiments, analysis, evidence (ADR 0219) ------------------------------------------------------

mod analysis {
    use std::time::Duration;

    use super::*;
    use crate::experiment_runner::ExperimentRunner;
    use crate::experiment_store::{AnalysisState, EnvelopeLimits, Experiment};
    use crate::orchestrator::SourceKind as RouteSource;
    use crate::project_context::ProjectContext;
    use crate::work_store::DecisionRequest;

    struct Lab {
        r: Rig,
        runner: Arc<ExperimentRunner>,
        evidence: Evidence,
    }

    fn lab() -> Lab {
        let r = rig();
        r.f.experiments
            .set_envelope(
                &r.f.project_id,
                &r.f.research_id,
                &r.f.round_id,
                Some(1),
                EnvelopeLimits {
                    max_launches: 6,
                    max_concurrent: 2,
                    deadline_at: None,
                    max_runtime_secs: 30,
                    max_no_progress: 5,
                    allowed_commands: vec![vec!["sh".into(), "-c".into()]],
                },
                None,
            )
            .unwrap();
        let runner = ExperimentRunner::new(
            Arc::clone(&r.f.experiments),
            Arc::clone(&r.f.workspace),
            Arc::clone(&r.f.teams),
        )
        .with_poll(Duration::from_millis(20));
        let context = Arc::new(ProjectContext::new(
            Arc::clone(&r.f.agents),
            Arc::clone(&r.f.teams),
            Arc::clone(&r.f.research),
            Arc::clone(&r.f.experiments),
            Arc::clone(&r.work),
            Arc::clone(&r.channels),
            Arc::clone(&r.f.workspace),
        ));
        let evidence = Evidence::new(context, Arc::clone(&r.f.workspace));
        Lab {
            r,
            runner,
            evidence,
        }
    }

    impl Lab {
        fn agent(&self, caller: &str) -> WorkAgent {
            self.r
                .agent(&self.r.f.project_id, caller)
                .with_experiments(Arc::clone(&self.runner))
                .with_evidence(self.evidence.clone())
        }

        /// A coordinator, an executor Session, and a started task they share.
        fn started(&self, thread: Option<&Thread>) -> (WorkAgent, WorkAgent, String, String) {
            let coordinator = self.agent(&self.r.f.leader.conversation_id);
            let task = coordinator
                .create(self.r.task("Sweep ratios", thread.map(|t| t.id.as_str())))
                .unwrap();
            let executor_id = self.r.executor(&coordinator, "exec");
            coordinator.assign(&task.item.id, &executor_id, "").unwrap();
            let attempt = coordinator.start(&task.item.id, "start-1").unwrap();
            self.r
                .work
                .bind_attempt_run(
                    &self.r.f.project_id,
                    &attempt.id,
                    "run-1",
                    &Actor::Researcher,
                )
                .unwrap();
            let executor = self.agent(&executor_id);
            (coordinator, executor, executor_id, task.item.id)
        }

        async fn settle(&self, id: &str) -> Experiment {
            for _ in 0..400 {
                let experiment = self.r.f.experiments.get(id).unwrap();
                if !experiment.state.is_active() {
                    return experiment;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("experiment {id} did not settle");
        }

        fn spec(key: &str, script: &str) -> LaunchSpec {
            LaunchSpec {
                launch_key: key.into(),
                argv: vec!["sh".into(), "-c".into(), script.into()],
                artifacts: vec!["lab-out.txt".into()],
                ..Default::default()
            }
        }

        fn stage(&self, work: &str) -> WorkStage {
            self.r.work.get(&self.r.f.project_id, work).unwrap().stage
        }

        fn decide(kind: &str, experiment: &str, key: &str) -> DecisionInput {
            DecisionInput {
                experiment_id: experiment.into(),
                kind: kind.into(),
                decision_key: Some(key.into()),
                rationale: "the loss diverged at 4 heads".into(),
                ..Default::default()
            }
        }
    }

    #[tokio::test]
    async fn a_failed_experiment_is_analyzed_retried_and_accepted_without_duplicates() {
        let lab = lab();
        let r = &lab.r;
        let thread = r.thread();
        let (coordinator, executor, _, work) = lab.started(Some(&thread));

        // Launching is idempotent per key, and keys cannot cross tasks.
        let first = executor
            .launch_experiment(
                &work,
                Lab::spec("sweep-1", "echo partial > lab-out.txt; exit 3"),
            )
            .unwrap();
        let replay = executor
            .launch_experiment(
                &work,
                Lab::spec("sweep-1", "echo partial > lab-out.txt; exit 3"),
            )
            .unwrap();
        assert_eq!(first.id, replay.id);
        // The key is bound to its command: a different one under it is refused.
        assert!(
            executor
                .launch_experiment(&work, Lab::spec("sweep-1", "echo other"))
                .is_err()
        );
        assert_eq!(first.task_id.as_deref(), Some(work.as_str()));

        // It cannot be reported while the process runs or the result is unexamined.
        assert!(matches!(
            executor.report(&work, ReportStatus::Completed, "done", None),
            Err(AgentWorkError::Invalid(_))
        ));
        let done = lab.settle(&first.id).await;
        assert_eq!(done.exit_code, Some(3));
        assert_eq!(done.analysis, AnalysisState::Pending);

        // The finished experiment reaches the executor once, and the task
        // waits for analysis; a second scan, or a restarted orchestrator,
        // routes nothing again.
        assert_eq!(r.orchestrator.route_experiments().unwrap(), 1);
        assert_eq!(r.orchestrator.route_experiments().unwrap(), 0);
        let restarted = Orchestrator::new(
            r.f.agents.database(),
            Arc::clone(&r.f.agents),
            Arc::clone(&r.channels),
            Arc::clone(&r.work),
            Arc::clone(&r.f.research),
        )
        .unwrap();
        assert_eq!(restarted.route_experiments().unwrap(), 0);
        assert_eq!(lab.stage(&work), WorkStage::Analyzing);
        let routes: Vec<_> = r
            .orchestrator
            .routes(&r.f.project_id, None, 50)
            .unwrap()
            .into_iter()
            .filter(|route| route.kind == RouteKind::Experiment)
            .collect();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].source_kind, RouteSource::Experiment);
        assert!(
            r.texts(&thread)
                .iter()
                .any(|(_, text)| text.contains("Sweep ratios"))
        );

        // A decision needs a rationale and, for a retry, the next experiment.
        assert!(
            executor
                .decide(&work, Lab::decide("retry", &first.id, "retry-1"))
                .is_err()
        );
        let mut retry = Lab::decide("retry", &first.id, "retry-1");
        retry.launch = Some(Lab::spec("ignored", "echo fixed > lab-out.txt"));
        let outcome = executor.decide(&work, retry.clone()).unwrap();
        assert!(outcome.created);
        let second_id = outcome.launched_experiment_id.clone().unwrap();
        // The same decision again changes nothing and starts nothing.
        let again = executor.decide(&work, retry).unwrap();
        assert!(!again.created);
        assert_eq!(
            again.launched_experiment_id.as_deref(),
            Some(second_id.as_str())
        );
        assert_eq!(
            r.f.experiments
                .experiments(&r.f.project_id, &r.f.research_id, &r.f.round_id)
                .unwrap()
                .into_iter()
                .filter(|e| e.task_id.as_deref() == Some(work.as_str()))
                .count(),
            2
        );
        assert!(!outcome.analysis_owed);
        assert_eq!(lab.stage(&work), WorkStage::Executing);

        // The failed run is cited as evidence at what it was when analyzed.
        let cited = r.work.results(&r.f.project_id, &work).unwrap();
        assert!(
            cited
                .iter()
                .any(|c| c.kind == "experiment" && c.ref_id == first.id && c.revision.is_some())
        );

        // The retry succeeds; concluding settles it and the task can be reported.
        lab.settle(&second_id).await;
        assert_eq!(r.orchestrator.route_experiments().unwrap(), 1);
        assert_eq!(lab.stage(&work), WorkStage::Analyzing);
        assert!(matches!(
            executor.report(&work, ReportStatus::Completed, "done", None),
            Err(AgentWorkError::Invalid(_))
        ));
        executor
            .decide(&work, Lab::decide("conclude", &second_id, "conclude"))
            .unwrap();
        assert_eq!(lab.stage(&work), WorkStage::Executing);
        let reported = executor
            .report(&work, ReportStatus::Completed, "ratio 0.5 holds", None)
            .unwrap();
        assert_eq!(reported.item.stage, WorkStage::Review);

        // A handoff mid-flow keeps the experiments and the evidence, and only
        // the new holder can accept.
        let successor = r.session("Successor");
        coordinator
            .handoff(&r.f.round_id, &successor, "rotating")
            .unwrap();
        assert!(matches!(
            coordinator.review(&work, true, WorkOutcome::Supported, None),
            Err(AgentWorkError::NotFound | AgentWorkError::NotCoordinator)
        ));
        let new = lab.agent(&successor);
        let accepted = new
            .review(&work, true, WorkOutcome::Supported, Some("both runs read"))
            .unwrap();
        assert_eq!(accepted.item.stage, WorkStage::Done);

        // The decision reached the Thread and the question's log, once.
        let notes = r.texts(&thread);
        assert!(
            notes
                .iter()
                .filter(|(_, text)| text.contains("accepted"))
                .count()
                >= 1
        );
        let entries =
            r.f.research
                .entries(&r.f.project_id, &r.f.research_id, 0, Some(50))
                .unwrap();
        assert!(entries.iter().any(|e| e.body.contains("Sweep ratios")));
    }

    struct Capture(std::sync::Mutex<Vec<String>>);
    impl RouteSink for Capture {
        fn deliver(&self, request: &DeliveryRequest<'_>) -> DeliveryOutcome {
            self.0
                .lock()
                .unwrap()
                .push(request.conversation_id.to_owned());
            DeliveryOutcome::Delivered
        }
    }

    #[tokio::test]
    async fn a_valid_negative_result_completes_the_task_and_says_so() {
        let lab = lab();
        let r = &lab.r;
        let thread = r.thread();
        let (coordinator, executor, _, work) = lab.started(Some(&thread));
        let run = executor
            .launch_experiment(&work, Lab::spec("neg", "echo flat > lab-out.txt; exit 1"))
            .unwrap();
        lab.settle(&run.id).await;
        r.orchestrator.route_experiments().unwrap();
        // A negative result is concluded on its evidence, not retried for its exit code.
        executor
            .decide(&work, Lab::decide("conclude", &run.id, "negative"))
            .unwrap();
        executor
            .report(
                &work,
                ReportStatus::Completed,
                "pruning does not help",
                None,
            )
            .unwrap();
        let done = coordinator
            .review(&work, true, WorkOutcome::Refuted, Some("clean ablation"))
            .unwrap();
        assert_eq!(
            (done.item.stage, done.item.outcome),
            (WorkStage::Done, WorkOutcome::Refuted)
        );
        assert_eq!(
            r.texts(&thread)
                .iter()
                .filter(|(_, text)| text.contains("accepted as a valid negative result"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn an_executor_cannot_move_a_pin_by_deciding_again() {
        let lab = lab();
        let r = &lab.r;
        let (_, executor, _, work) = lab.started(None);
        let run = executor
            .launch_experiment(&work, Lab::spec("pin", "echo x > lab-out.txt"))
            .unwrap();
        lab.settle(&run.id).await;
        r.orchestrator.route_experiments().unwrap();
        executor
            .decide(&work, Lab::decide("conclude", &run.id, "c"))
            .unwrap();
        let cited = r.work.results(&r.f.project_id, &work).unwrap();
        let experiment = cited.iter().find(|c| c.kind == "experiment").unwrap();
        // The evidence is moved out from under the citation (as a re-run would).
        r.work
            .repin_result(
                &r.f.project_id,
                &work,
                &experiment.id,
                Some("older-revision"),
                &Actor::Executor {
                    conversation_id: executor.caller.clone(),
                },
            )
            .unwrap();
        executor
            .decide(&work, Lab::decide("conclude", &run.id, "c"))
            .unwrap();
        let after = r.work.results(&r.f.project_id, &work).unwrap();
        assert_eq!(
            after
                .iter()
                .find(|c| c.id == experiment.id)
                .unwrap()
                .revision
                .as_deref(),
            Some("older-revision"),
            "only a person re-pins"
        );
        assert!(!lab.evidence.stale(&r.f.project_id, &after).is_empty());
    }

    #[tokio::test]
    async fn an_experiment_result_goes_to_whoever_executes_the_task_at_delivery() {
        let lab = lab();
        let r = &lab.r;
        let (coordinator, executor, first_id, work) = lab.started(None);
        let run = executor
            .launch_experiment(&work, Lab::spec("late", "echo x > lab-out.txt"))
            .unwrap();
        lab.settle(&run.id).await;
        executor
            .report(&work, ReportStatus::Failed, "handing over", Some("moved"))
            .unwrap();
        r.orchestrator.route_experiments().unwrap();
        // The task changes hands before the route is delivered.
        let second_id = r.executor(&coordinator, "second");
        coordinator.assign(&work, &second_id, "new owner").unwrap();
        let sink = Capture(Default::default());
        r.orchestrator.tick(&sink).unwrap();
        let reached = sink.0.lock().unwrap().clone();
        assert!(reached.contains(&second_id), "{reached:?}");
        assert!(
            !reached.contains(&first_id),
            "the replaced Session is not told: {reached:?}"
        );
    }

    #[tokio::test]
    async fn a_question_is_shown_in_the_thread_and_the_log_and_open_questions_are_bounded() {
        let lab = lab();
        let r = &lab.r;
        let thread = r.thread();
        let (_, executor, _, work) = lab.started(Some(&thread));
        for i in 0..5 {
            executor
                .request_decision(
                    &work,
                    &format!("q-{i}"),
                    "Which heads?",
                    &["a".into(), "b".into()],
                    Some("a day"),
                )
                .unwrap();
        }
        // Replaying a key shows it once.
        executor
            .request_decision(
                &work,
                "q-0",
                "Which heads?",
                &["a".into(), "b".into()],
                Some("a day"),
            )
            .unwrap();
        let shown = r
            .texts(&thread)
            .into_iter()
            .filter(|(_, text)| {
                text.contains("needs a decision") && text.contains("Options: a / b")
            })
            .count();
        assert_eq!(shown, 5);
        assert!(
            r.f.research
                .entries(&r.f.project_id, &r.f.research_id, 0, Some(50))
                .unwrap()
                .iter()
                .any(|entry| entry.body.starts_with("Unresolved:"))
        );
        assert!(
            executor
                .request_decision(&work, "q-6", "One more?", &[], None)
                .is_err(),
            "a task cannot flood the researcher"
        );
    }

    #[tokio::test]
    async fn experiments_wait_for_the_researcher_when_the_task_or_round_is_stopped() {
        let lab = lab();
        let r = &lab.r;
        let (_, executor, _, work) = lab.started(None);
        r.work
            .set_condition(
                &r.f.project_id,
                &work,
                WorkCondition::Paused,
                Some("hold"),
                &Actor::Researcher,
            )
            .unwrap();
        assert!(
            executor
                .launch_experiment(&work, Lab::spec("p", "echo x"))
                .is_err()
        );
        r.work
            .set_condition(
                &r.f.project_id,
                &work,
                WorkCondition::None,
                None,
                &Actor::Researcher,
            )
            .unwrap();
        r.work
            .set_policy(
                &r.f.project_id,
                &r.f.round_id,
                0,
                PolicyPatch {
                    paused: Some(true),
                    ..Default::default()
                },
                &Actor::Researcher,
            )
            .unwrap();
        assert!(matches!(
            executor.launch_experiment(&work, Lab::spec("p", "echo x")),
            Err(AgentWorkError::Work(WorkError::RoundPaused))
        ));
    }

    #[tokio::test]
    async fn a_task_never_stays_analyzing_after_nothing_is_owed_and_answers_are_never_lost() {
        let lab = lab();
        let r = &lab.r;
        let (_, executor, _, work) = lab.started(None);
        let run = executor
            .launch_experiment(&work, Lab::spec("s", "echo x > lab-out.txt"))
            .unwrap();
        lab.settle(&run.id).await;
        r.orchestrator.route_experiments().unwrap();
        assert_eq!(lab.stage(&work), WorkStage::Analyzing);
        // The decision committed but the stage move was lost (a crash).
        r.f.experiments
            .record_decision(
                &r.f.project_id,
                crate::experiment_store::NewDecision {
                    experiment_id: run.id.clone(),
                    member_id: executor.caller.clone(),
                    kind: crate::experiment_store::DecisionKind::Conclude,
                    decision_key: None,
                    rationale: "done".into(),
                    evidence: vec![],
                    launched_experiment_id: None,
                },
            )
            .unwrap();
        assert_eq!(lab.stage(&work), WorkStage::Analyzing);
        r.orchestrator.route_experiments().unwrap();
        assert_eq!(lab.stage(&work), WorkStage::Executing);

        // An answer recorded without its route is routed by the next pass, once.
        let asked = executor
            .request_decision(&work, "q", "Go on?", &[], None)
            .unwrap();
        let answered = r
            .work
            .answer_decision(&r.f.project_id, &asked.id, "yes", "researcher")
            .unwrap();
        assert_eq!(r.orchestrator.route_answers().unwrap(), 1);
        assert_eq!(r.orchestrator.route_answers().unwrap(), 0);
        let _ = answered;
    }

    #[tokio::test]
    async fn only_this_tasks_experiments_can_be_cited_and_live_records_are_not_pinned() {
        let lab = lab();
        let r = &lab.r;
        r.work
            .set_policy(
                &r.f.project_id,
                &r.f.round_id,
                0,
                PolicyPatch {
                    max_executors: Some(4),
                    max_parallel_attempts: Some(4),
                    max_attempts: Some(6),
                    ..Default::default()
                },
                &Actor::Researcher,
            )
            .unwrap();
        let thread = r.thread();
        let (coordinator, executor, _, work) = lab.started(Some(&thread));
        let other = coordinator.create(r.task("Other", None)).unwrap();
        let other_session = r.executor(&coordinator, "other");
        coordinator
            .assign(&other.item.id, &other_session, "")
            .unwrap();
        coordinator.start(&other.item.id, "o-1").unwrap();
        let theirs = lab
            .agent(&other_session)
            .launch_experiment(&other.item.id, Lab::spec("t", "echo x"))
            .unwrap();
        assert!(
            executor
                .attach(&work, "experiment", &theirs.id, None, ResultRole::Evidence)
                .is_err(),
            "another task's experiment is not this task's evidence"
        );
        executor
            .attach(&work, "thread", &thread.id, None, ResultRole::Evidence)
            .unwrap();
        let cited = r.work.results(&r.f.project_id, &work).unwrap();
        assert_eq!(cited[0].revision, None, "a Thread changes with every reply");
    }

    #[tokio::test]
    async fn evidence_that_changed_blocks_acceptance_until_it_is_looked_at() {
        let lab = lab();
        let r = &lab.r;
        let (coordinator, executor, _, work) = lab.started(None);
        let path =
            r.f.workspace
                .execution_path(&r.f.project_id, None)
                .unwrap()
                .join("notes.md");
        std::fs::write(&path, "pruning helps").unwrap();
        executor
            .attach(&work, "file", "notes.md", None, ResultRole::Evidence)
            .unwrap();
        let pinned = r.work.results(&r.f.project_id, &work).unwrap();
        assert!(
            pinned[0].revision.is_some(),
            "evidence is pinned when cited"
        );
        executor
            .report(&work, ReportStatus::Completed, "see notes", None)
            .unwrap();

        std::fs::write(&path, "pruning hurts").unwrap();
        let refused = coordinator.review(&work, true, WorkOutcome::Supported, None);
        let Err(AgentWorkError::StaleEvidence(stale)) = refused else {
            panic!("expected stale evidence, got {refused:?}");
        };
        assert_eq!(
            (stale[0].ref_id.as_str(), stale[0].status),
            ("notes.md", "changed")
        );
        let item = r.work.get(&r.f.project_id, &work).unwrap();
        assert_eq!(item.stage, WorkStage::Review, "nothing was accepted");
        assert!(
            item.condition_reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with("attention: "))
        );

        // A rejection does not depend on evidence; accepting needs a re-pin.
        coordinator.repin(&work, &pinned[0].id).unwrap();
        let accepted = coordinator
            .review(&work, true, WorkOutcome::Supported, Some("re-read"))
            .unwrap();
        assert_eq!(accepted.item.stage, WorkStage::Done);

        // Removed evidence is stale too.
        std::fs::remove_file(&path).unwrap();
        let results = r.work.results(&r.f.project_id, &work).unwrap();
        assert_eq!(
            lab.evidence.stale(&r.f.project_id, &results)[0].status,
            "removed"
        );
    }

    #[tokio::test]
    async fn exhausted_limits_flag_the_task_for_the_researcher_and_stop_dispatch() {
        let lab = lab();
        let r = &lab.r;
        r.work
            .set_policy(
                &r.f.project_id,
                &r.f.round_id,
                0,
                PolicyPatch {
                    max_attempts: Some(2),
                    max_parallel_attempts: Some(2),
                    ..Default::default()
                },
                &Actor::Researcher,
            )
            .unwrap();
        let (coordinator, executor, _, work) = lab.started(None);
        executor
            .report(&work, ReportStatus::Failed, "crashed", Some("boom"))
            .unwrap();
        assert!(matches!(
            coordinator.start(&work, "start-2"),
            Err(AgentWorkError::Work(WorkError::BudgetExhausted(_)))
        ));
        let item = r.work.get(&r.f.project_id, &work).unwrap();
        assert!(
            item.condition_reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with("attention: no more attempts"))
        );
    }

    #[tokio::test]
    async fn a_launch_the_researcher_did_not_authorize_is_refused_and_surfaces_on_the_card() {
        let lab = lab();
        let r = &lab.r;
        let (_, executor, _, work) = lab.started(None);
        let denied = executor.launch_experiment(
            &work,
            LaunchSpec {
                launch_key: "k".into(),
                argv: vec!["rm".into(), "-rf".into(), "x".into()],
                ..Default::default()
            },
        );
        assert!(
            matches!(&denied, Err(AgentWorkError::Experiment(text)) if text.contains("command_not_authorized")),
            "{denied:?}"
        );
        let item = r.work.get(&r.f.project_id, &work).unwrap();
        assert_eq!(item.condition, WorkCondition::NeedsInput);
        assert!(
            item.condition_reason.as_deref().is_some_and(
                |reason| reason.starts_with("attention: an experiment could not start")
            )
        );
        // Nothing ran and nothing was reserved.
        assert!(
            r.f.experiments
                .experiments(&r.f.project_id, &r.f.research_id, &r.f.round_id)
                .unwrap()
                .iter()
                .all(|e| e.task_id.as_deref() != Some(work.as_str()))
        );
        // Another task's Session cannot launch for this one.
        let stranger = lab.agent(&r.session("Stranger"));
        assert!(
            stranger
                .launch_experiment(&work, Lab::spec("k", "echo"))
                .is_err()
        );
    }

    #[tokio::test]
    async fn the_researcher_is_asked_through_a_request_whose_answer_grants_nothing() {
        let lab = lab();
        let r = &lab.r;
        let thread = r.thread();
        let (_, executor, executor_id, work) = lab.started(Some(&thread));
        let policy_before = r.work.policy(&r.f.project_id, &r.f.round_id).unwrap();

        let asked: DecisionRequest = executor
            .request_decision(
                &work,
                "q-1",
                "Spend a second launch budget on 8 heads?",
                &["yes".into(), "no".into()],
                Some("one more day"),
            )
            .unwrap();
        // Repeating the key returns the same request.
        assert_eq!(
            executor
                .request_decision(
                    &work,
                    "q-1",
                    "Spend a second launch budget on 8 heads?",
                    &[],
                    None
                )
                .unwrap()
                .id,
            asked.id
        );
        let waiting = r.work.get(&r.f.project_id, &work).unwrap();
        assert_eq!(waiting.condition, WorkCondition::NeedsInput);

        // Only an offered option answers it; the answer clears the flag and
        // reaches the asker once, and no limit moves.
        assert!(
            r.work
                .answer_decision(&r.f.project_id, &asked.id, "maybe", "researcher")
                .is_err()
        );
        let answered = r
            .work
            .answer_decision(&r.f.project_id, &asked.id, "yes", "researcher")
            .unwrap();
        let route = r
            .orchestrator
            .route_decision_answer(&r.f.project_id, &answered)
            .unwrap()
            .unwrap();
        assert_eq!(
            r.orchestrator
                .route_decision_answer(&r.f.project_id, &answered)
                .unwrap()
                .unwrap()
                .id,
            route.id
        );
        assert_eq!(
            r.work.get(&r.f.project_id, &work).unwrap().condition,
            WorkCondition::None
        );
        assert_eq!(
            r.work.policy(&r.f.project_id, &r.f.round_id).unwrap(),
            policy_before,
            "an answer is not an authorization"
        );
        let _ = executor_id;
    }

    #[tokio::test]
    async fn the_brief_gathers_what_a_replacement_session_needs() {
        let lab = lab();
        let r = &lab.r;
        let (_, executor, _, work) = lab.started(None);
        let brief = executor.brief(&work).unwrap();
        assert_eq!(brief.title, "Sweep ratios");
        assert_eq!(brief.brief_revision, Some(1));
        assert_eq!(brief.attempts.len(), 1);
        assert!(brief.resources["policy"]["max_attempts"].is_number());
        assert!(brief.resources["experiments"]["limits"]["max_launches"].is_number());
        // A stranger sees nothing.
        let stranger = lab.agent(&r.session("Stranger"));
        assert!(matches!(
            stranger.brief(&work),
            Err(AgentWorkError::NotFound)
        ));
        assert!(
            stranger
                .launch_experiment(&work, Lab::spec("k", "echo"))
                .is_err()
        );
    }
}
