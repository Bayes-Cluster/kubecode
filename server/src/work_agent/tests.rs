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
        .create_executor(None, "opencode", "Pruner")
        .unwrap();
    let b = coordinator
        .create_executor(None, "opencode", "Quantizer")
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
    let executor_id = r.session("Executor");
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
    old.handoff(&r.f.round_id, &successor_id, "going away")
        .unwrap();
    let new = r.agent(&r.f.project_id, &successor_id);

    for result in [
        old.create(r.task("Late", None)).map(|_| ()),
        old.assign(&item.item.id, &successor_id, "").map(|_| ()),
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
    let executor = r.session("Executor");
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
    let session_a = r.session("A");
    let session_b = r.session("B");
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
        coordinator.create_executor(None, "opencode", "More"),
        Err(AgentWorkError::Work(WorkError::RoundPaused))
    ));
}

#[test]
fn executors_come_only_from_available_providers_and_never_start_work_themselves() {
    let r = rig();
    let coordinator = r.leader();
    assert!(matches!(
        coordinator.create_executor(None, "codex", "Nope"),
        Err(AgentWorkError::Invalid(_))
    ));
    assert!(matches!(
        coordinator.create_executor(None, "gpt-9000", "Nope"),
        Err(AgentWorkError::Invalid(_))
    ));
    let id = coordinator
        .create_executor(None, "opencode", "Helper")
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
    let executor_id = r.session("Executor");
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
