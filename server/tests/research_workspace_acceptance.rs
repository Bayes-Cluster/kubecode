//! Milestone acceptance for the conversation-led research workspace (#185):
//! one deterministic scenario from a channel discussion through an approved,
//! bounded round and shared-board work to a failed experiment, its analysis,
//! evidence review, and findings in the Thread and the question's log. Along
//! the way it replays commands, restarts the orchestrator, replaces the
//! coordinator, exhausts a budget, changes cited evidence, and crosses a
//! Project boundary. Real agents are not involved: Sessions are scripted
//! through the same caller-bound service the MCP tools use.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::experiment_store::EnvelopeLimits;
use kubecode_server::orchestrator::{
    DeliveryOutcome, DeliveryRequest, Orchestrator, RouteKind, RouteSink,
};
use kubecode_server::research_store::{NewRound, ResearchBrief, RoundKind};
use kubecode_server::teams::TeamStore;
use kubecode_server::work_agent::{
    AgentWorkError, DecisionInput, Evidence, LaunchSpec, NewTask, ReportStatus, WorkAgent,
};
use kubecode_server::work_store::{Actor, WorkError, WorkOutcome, WorkStage};
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE: &str = "/user/alice/kubecode";

#[derive(Default)]
struct Recording(Mutex<Vec<String>>);

impl RouteSink for Recording {
    fn deliver(&self, request: &DeliveryRequest<'_>) -> DeliveryOutcome {
        self.0
            .lock()
            .unwrap()
            .push(request.conversation_id.to_owned());
        DeliveryOutcome::Delivered
    }
}

struct Lab {
    _root: TempDir,
    app: Router,
    state: AppState,
    agents: Arc<AgentStore>,
    project: String,
    channel: String,
    other_project: String,
    research_id: String,
    round_id: String,
}

fn lab() -> Lab {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace.create_project(".", "alpha").expect("alpha");
    let other = workspace.create_project(".", "beta").expect("beta");
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let state = AppState::new(workspace, Arc::clone(&agents), teams);
    let (question, _) = state
        .research
        .create(
            &project.id,
            ResearchBrief {
                title: "Pruning".into(),
                question: "Does head pruning hold accuracy?".into(),
                evaluation_criteria: vec!["accuracy within 1 point".into()],
                ..Default::default()
            },
            None,
        )
        .expect("question");
    let lead = agents
        .create_conversation(&project.id, AgentId::OpenCode, Some("Lead"))
        .expect("lead");
    let (round, _) = state
        .research
        .begin_round(
            &project.id,
            &question.id,
            NewRound {
                kind: RoundKind::Solo,
                idempotency_key: "r1",
                expected_revision: 1,
                request: json!({}),
                sources: Vec::new(),
            },
        )
        .expect("round");
    state
        .research
        .round_set_session(&project.id, &question.id, &round.id, &lead.id)
        .expect("session");
    // The researcher approves the round and its execution envelope.
    state
        .research
        .round_mark_started(&project.id, &question.id, &round.id)
        .expect("approved");
    state
        .experiments
        .set_envelope(
            &project.id,
            &question.id,
            &round.id,
            None,
            EnvelopeLimits {
                max_launches: 4,
                max_concurrent: 2,
                deadline_at: None,
                max_runtime_secs: 30,
                max_no_progress: 5,
                allowed_commands: vec![vec!["sh".into(), "-c".into()]],
            },
            Some("researcher"),
        )
        .expect("envelope");
    let app = app_router(state.clone(), BASE);
    Lab {
        _root: root,
        app,
        state,
        agents,
        channel: String::new(),
        project: project.id,
        other_project: other.id,
        research_id: question.id,
        round_id: round.id,
    }
}

impl Lab {
    async fn call(&self, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("{BASE}/api/v1{path}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .expect("request"),
            )
            .await
            .expect("response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("json")
        };
        (status, value)
    }

    fn agent(&self, project: &str, caller: &str) -> WorkAgent {
        WorkAgent::new(
            project.to_owned(),
            caller.to_owned(),
            Arc::clone(&self.state.work),
            Arc::clone(&self.state.channels),
            Arc::clone(&self.state.orchestrator),
            Arc::clone(&self.state.research),
            Arc::clone(&self.agents),
            Arc::new(|_| true),
        )
        .with_experiments(Arc::clone(&self.state.experiment_runner))
        .with_evidence(Evidence::new(
            Arc::clone(&self.state.context),
            Arc::clone(&self.state.workspace),
        ))
    }

    fn session(&self, title: &str) -> String {
        self.agents
            .create_conversation(&self.project, AgentId::OpenCode, Some(title))
            .expect("session")
            .id
    }

    fn routes(&self, kind: RouteKind) -> usize {
        self.state
            .orchestrator
            .routes(&self.project, None, 500)
            .unwrap()
            .into_iter()
            .filter(|route| route.kind == kind)
            .count()
    }

    async fn settle(&self, experiment_id: &str) {
        for _ in 0..400 {
            if !self
                .state
                .experiments
                .get(experiment_id)
                .unwrap()
                .state
                .is_active()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("experiment {experiment_id} did not settle");
    }

    async fn thread_texts(&self, thread_id: &str) -> Vec<String> {
        let (status, page) = self
            .call(
                Method::GET,
                &format!(
                    "/projects/{}/channels/{}/messages?thread_id={thread_id}&limit=200",
                    self.project, self.channel
                ),
                Value::Null,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["body"].as_str().unwrap_or_default().to_owned())
            .collect()
    }
}

fn task<'a>(title: &'a str, thread: &'a str, key: &'a str) -> NewTask<'a> {
    NewTask {
        round_id: None,
        title,
        description: "Run it and report what the evidence says",
        plan: None,
        depends_on: &[],
        from_thread: Some(thread),
        client_request_id: Some(key),
    }
}

fn spec(key: &str, script: &str) -> LaunchSpec {
    LaunchSpec {
        launch_key: key.into(),
        argv: vec!["sh".into(), "-c".into(), script.into()],
        artifacts: vec!["sweep.txt".into()],
        ..Default::default()
    }
}

#[tokio::test]
async fn a_discussion_becomes_bounded_work_whose_failure_is_analyzed_and_whose_findings_return_to_the_thread()
 {
    let lab = lab();
    let mut lab = lab;
    let sink = Recording::default();

    // -- Discussion, Thread, and the researcher's request -------------------------------
    let channel = lab.state.channels.default_channel(&lab.project).unwrap();
    lab.channel = channel.id.clone();
    let messages = format!("/projects/{}/channels/{}/messages", lab.project, channel.id);
    let (_, root) = lab
        .call(
            Method::POST,
            &messages,
            json!({"body": "Does head pruning hold accuracy?"}),
        )
        .await;
    let (status, thread) = lab
        .call(
            Method::POST,
            &format!("/projects/{}/channels/{}/threads", lab.project, channel.id),
            json!({"root_message_id": root["id"]}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{thread}");
    let thread_id = thread["id"].as_str().unwrap().to_owned();
    let (status, linked) = lab
        .call(
            Method::PUT,
            &format!("/projects/{}/threads/{thread_id}/link", lab.project),
            json!({"expected_revision": 1, "research_id": lab.research_id, "round_id": lab.round_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{linked}");
    let request = json!({"body": "Please run the pruning sweep", "thread_id": thread_id,
                         "intent": "request", "client_message_id": "req-1"});
    let (status, _) = lab.call(Method::POST, &messages, request.clone()).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = lab.call(Method::POST, &messages, request).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a browser retry is the same message"
    );

    // -- The request reaches the round's coordinator exactly once ------------------------
    for _ in 0..3 {
        lab.state.orchestrator.tick(&sink).unwrap();
    }
    let lead = lab
        .state
        .work
        .coordinator(&lab.project, &lab.round_id)
        .unwrap()
        .expect("the round's Session coordinates")
        .holder;
    assert_eq!(sink.0.lock().unwrap().clone(), vec![lead.clone()]);
    assert_eq!(lab.routes(RouteKind::Request), 1);

    // -- The researcher bounds the round --------------------------------------------------
    let policy = format!(
        "/projects/{}/rounds/{}/execution-policy",
        lab.project, lab.round_id
    );
    let (status, bounded) = lab
        .call(
            Method::PUT,
            &policy,
            json!({"expected_revision": 0, "max_executors": 2, "max_parallel_attempts": 2,
                   "max_attempts": 2}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{bounded}");

    // -- The coordinator organizes work from the Thread -----------------------------------
    let coordinator = lab.agent(&lab.project, &lead);
    let first = coordinator
        .create(task("Sweep prune ratios", &thread_id, "t-1"))
        .unwrap();
    let replay = coordinator
        .create(task("Sweep prune ratios", &thread_id, "t-1"))
        .unwrap();
    assert_eq!(
        first.item.id, replay.item.id,
        "a replayed create is one task"
    );
    let work = first.item.id.clone();
    let executor_id = coordinator
        .create_executor(None, "opencode", "Pruner", "exec-1")
        .unwrap();
    assert_eq!(
        coordinator
            .create_executor(None, "opencode", "Pruner", "exec-1")
            .unwrap(),
        executor_id
    );
    coordinator.assign(&work, &executor_id, "").unwrap();
    let attempt = coordinator.start(&work, "start-1").unwrap();
    assert_eq!(coordinator.start(&work, "start-1").unwrap().id, attempt.id);
    lab.state.orchestrator.tick(&sink).unwrap();
    assert_eq!(lab.routes(RouteKind::Dispatch), 1);
    assert!(sink.0.lock().unwrap().contains(&executor_id));
    lab.state
        .work
        .bind_attempt_run(&lab.project, &attempt.id, "run-1", &Actor::Researcher)
        .unwrap();

    // -- The one board shows it; another Project sees nothing -----------------------------
    let (_, board) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/board", lab.project),
            Value::Null,
        )
        .await;
    assert_eq!(board["total"], 1);
    assert_eq!(board["cards"][0]["item"]["stage"], "executing");
    assert_eq!(board["cards"][0]["origin_thread"]["id"], thread_id);
    let (_, foreign_board) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/board", lab.other_project),
            Value::Null,
        )
        .await;
    assert_eq!(foreign_board["total"], 0);
    let (status, _) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/{work}", lab.other_project),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let foreign = lab.agent(&lab.other_project, &executor_id);
    assert!(matches!(foreign.get(&work), Err(AgentWorkError::NotFound)));
    assert!(
        foreign
            .launch_experiment(&work, spec("x", "echo x"))
            .is_err()
    );

    // -- A failed experiment, analyzed ----------------------------------------------------
    let executor = lab.agent(&lab.project, &executor_id);
    let root_dir = lab
        .state
        .workspace
        .execution_path(&lab.project, None)
        .unwrap();
    let failing = executor
        .launch_experiment(
            &work,
            spec("sweep-1", "echo 'ratio 0.9: diverged' > sweep.txt; exit 2"),
        )
        .unwrap();
    assert_eq!(
        executor
            .launch_experiment(
                &work,
                spec("sweep-1", "echo 'ratio 0.9: diverged' > sweep.txt; exit 2")
            )
            .unwrap()
            .id,
        failing.id,
        "a replayed launch starts no second process"
    );
    assert!(
        executor
            .report(&work, ReportStatus::Completed, "done", None)
            .is_err(),
        "a result cannot be reported while a process runs"
    );
    lab.settle(&failing.id).await;
    lab.state.orchestrator.tick(&sink).unwrap();
    lab.state.orchestrator.tick(&sink).unwrap();
    assert_eq!(
        lab.routes(RouteKind::Experiment),
        1,
        "the result is delivered once"
    );
    let (_, card) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/{work}", lab.project),
            Value::Null,
        )
        .await;
    assert_eq!(card["item"]["stage"], "analyzing");

    // The executor asks the researcher instead of widening anything itself.
    let asked = executor
        .request_decision(
            &work,
            "q-1",
            "Spend the last launch on ratio 0.5?",
            &["yes".into(), "no".into()],
            Some("one more run"),
        )
        .unwrap();
    let (_, card) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/{work}", lab.project),
            Value::Null,
        )
        .await;
    assert_eq!(card["item"]["condition"], "needs_input");
    let envelope_before = lab
        .state
        .experiments
        .envelope(&lab.project, &lab.research_id, &lab.round_id)
        .unwrap()
        .unwrap();
    let answer = format!(
        "/projects/{}/work/{work}/decisions/{}/answer",
        lab.project, asked.id
    );
    let (status, _) = lab
        .call(Method::POST, &answer, json!({"answer": "yes"}))
        .await;
    assert_eq!(status, StatusCode::OK);
    lab.state.orchestrator.tick(&sink).unwrap();
    assert_eq!(lab.routes(RouteKind::Decision), 1);
    assert_eq!(
        lab.state
            .experiments
            .envelope(&lab.project, &lab.research_id, &lab.round_id)
            .unwrap()
            .unwrap(),
        envelope_before,
        "an answer authorizes nothing"
    );

    // -- The coordinator is replaced mid-flow ---------------------------------------------
    let successor_id = lab.session("Successor");
    coordinator
        .handoff(&lab.round_id, &successor_id, "rotating")
        .unwrap();
    assert!(
        coordinator
            .create(task("Late", &thread_id, "t-late"))
            .is_err()
    );
    assert!(
        coordinator
            .review(&work, true, WorkOutcome::Supported, None)
            .is_err(),
        "the old coordinator's next command is refused"
    );
    let successor = lab.agent(&lab.project, &successor_id);
    let carried = successor.get(&work).unwrap();
    assert_eq!(carried.item.created_by.as_deref(), Some(lead.as_str()));
    assert_eq!(
        carried.item.derived_from.as_ref().map(|d| d.id.as_str()),
        Some(thread_id.as_str()),
        "provenance survives the handoff"
    );

    // -- Retry, with the evidence the decision rests on -----------------------------------
    std::fs::write(root_dir.join("notes.md"), "ratio 0.9 diverges; 0.5 holds").unwrap();
    executor
        .attach(
            &work,
            "file",
            "notes.md",
            None,
            kubecode_server::work_store::ResultRole::Evidence,
        )
        .unwrap();
    let mut retry = DecisionInput {
        experiment_id: failing.id.clone(),
        kind: "retry".into(),
        decision_key: Some("retry-0.5".into()),
        rationale: "ratio 0.9 diverged; the loss curve says 0.5 is worth one run".into(),
        evidence: vec![("file".into(), "notes.md".into())],
        launch: Some(spec("unused", "echo 'ratio 0.5: ok' > sweep.txt")),
        ..Default::default()
    };
    let decided = executor.decide(&work, retry.clone()).unwrap();
    let second = decided.launched_experiment_id.clone().unwrap();
    retry.rationale = "same decision, replayed".into();
    assert!(!executor.decide(&work, retry).unwrap().created);
    assert_eq!(
        lab.state
            .experiments
            .experiments(&lab.project, &lab.research_id, &lab.round_id)
            .unwrap()
            .len(),
        2,
        "one failure, one justified retry, no duplicates"
    );
    lab.settle(&second).await;
    lab.state.orchestrator.tick(&sink).unwrap();
    executor
        .decide(
            &work,
            DecisionInput {
                experiment_id: second.clone(),
                kind: "conclude".into(),
                decision_key: Some("conclude".into()),
                rationale: "0.5 holds accuracy; 0.9 diverges. Both are findings.".into(),
                ..Default::default()
            },
        )
        .unwrap();
    executor
        .report(
            &work,
            ReportStatus::Completed,
            "0.5 holds, 0.9 diverges",
            None,
        )
        .unwrap();

    // -- Stale context blocks acceptance until it is looked at ----------------------------
    std::fs::write(
        root_dir.join("notes.md"),
        "ratio 0.5 also diverges at 3 seeds",
    )
    .unwrap();
    assert!(matches!(
        successor.review(&work, true, WorkOutcome::Supported, None),
        Err(AgentWorkError::StaleEvidence(_))
    ));
    let (_, card) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/{work}", lab.project),
            Value::Null,
        )
        .await;
    assert_eq!(card["stale_evidence"][0]["ref_id"], "notes.md");
    let revision = card["item"]["state_revision"].as_u64().unwrap();
    let commands = format!("/projects/{}/work/{work}/commands", lab.project);
    let (status, refused) = lab
        .call(
            Method::POST,
            &commands,
            json!({"command": "review", "accept": true, "outcome": "supported",
                   "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(
        (status, refused["code"].as_str()),
        (StatusCode::CONFLICT, Some("work_evidence_stale"))
    );
    let stale_result = card["stale_evidence"][0]["result_id"].as_str().unwrap();
    let (_, flagged) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/{work}", lab.project),
            Value::Null,
        )
        .await;
    let revision = flagged["item"]["state_revision"].as_u64().unwrap();
    let (status, repinned) = lab
        .call(
            Method::POST,
            &commands,
            json!({"command": "repin", "result_id": stale_result, "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{repinned}");
    let revision = repinned["item"]["state_revision"].as_u64().unwrap();
    let (status, accepted) = lab
        .call(
            Method::POST,
            &commands,
            json!({"command": "review", "accept": true, "outcome": "inconclusive",
                   "reason": "0.5 diverges on 3 seeds; recorded, not hidden",
                   "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["item"]["stage"], "done");

    // -- Findings return to the Thread and the question's log ----------------------------
    let texts = lab.thread_texts(&thread_id).await;
    let said = |needle: &str| texts.iter().filter(|text| text.contains(needle)).count();
    assert_eq!(
        said("An experiment of \"Sweep prune ratios\" ended"),
        2,
        "{texts:#?}"
    );
    assert_eq!(said("Spend the last launch on ratio 0.5?"), 1, "{texts:#?}");
    assert_eq!(said("was accepted as inconclusive"), 1, "{texts:#?}");
    let entries = lab
        .state
        .research
        .entries(&lab.project, &lab.research_id, 0, Some(100))
        .unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.body.contains("accepted as inconclusive"))
            .count(),
        1
    );
    let (_, detail) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/{work}", lab.project),
            Value::Null,
        )
        .await;
    assert_eq!(detail["experiments"].as_array().unwrap().len(), 2);
    assert!(detail["decisions"].as_array().unwrap().len() >= 2);
    assert_eq!(detail["reviews"].as_array().unwrap().len(), 1);
    assert_eq!(detail["stale_evidence"].as_array().unwrap().len(), 0);

    // -- Budget enforcement: the round's attempt limit stops the next dispatch -----------
    let second_task = successor
        .create(task("Quantize", &thread_id, "t-2"))
        .unwrap()
        .item
        .id;
    let third_task = successor
        .create(task("Distill", &thread_id, "t-3"))
        .unwrap()
        .item
        .id;
    successor.assign(&second_task, &executor_id, "").unwrap();
    successor.start(&second_task, "start-2").unwrap();
    assert_eq!(
        lab.state
            .work
            .policy(&lab.project, &lab.round_id)
            .unwrap()
            .max_attempts,
        2
    );
    successor.assign(&third_task, &executor_id, "").unwrap();
    let refused = successor.start(&third_task, "start-3");
    assert!(
        matches!(
            refused,
            Err(AgentWorkError::Work(WorkError::BudgetExhausted(_)))
        ),
        "{refused:?}"
    );
    let (_, over) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/{third_task}", lab.project),
            Value::Null,
        )
        .await;
    assert_eq!(
        over["item"]["condition"], "needs_input",
        "the researcher is told"
    );

    // -- Restart and duplicate delivery ---------------------------------------------------
    // Everything pending is delivered once by the running orchestrator first
    // (the handoff, result, and dispatch notices created since the last pass).
    lab.state.orchestrator.tick(&sink).unwrap();
    let delivered_once = sink.0.lock().unwrap().len();
    lab.state.orchestrator.tick(&sink).unwrap();
    assert_eq!(
        sink.0.lock().unwrap().len(),
        delivered_once,
        "a second pass delivers nothing"
    );
    let before: Vec<_> = lab
        .state
        .orchestrator
        .routes(&lab.project, None, 500)
        .unwrap();
    let restarted = Orchestrator::new(
        lab.agents.database(),
        Arc::clone(&lab.agents),
        Arc::clone(&lab.state.channels),
        Arc::clone(&lab.state.work),
        Arc::clone(&lab.state.research),
    )
    .unwrap();
    let again = Recording::default();
    restarted.tick(&again).unwrap();
    restarted.tick(&again).unwrap();
    assert!(
        again.0.lock().unwrap().is_empty(),
        "nothing is delivered twice after a restart"
    );
    assert_eq!(restarted.route_experiments().unwrap(), 0);
    let after: Vec<_> = lab
        .state
        .orchestrator
        .routes(&lab.project, None, 500)
        .unwrap();
    assert_eq!(before.len(), after.len());
    // Replaying every earlier command with its key changes nothing.
    assert_eq!(
        successor
            .create(task("Quantize", &thread_id, "t-2"))
            .unwrap()
            .item
            .id,
        second_task
    );
    assert_eq!(
        lab.state
            .experiments
            .experiments(&lab.project, &lab.research_id, &lab.round_id)
            .unwrap()
            .len(),
        2
    );
    let (_, final_board) = lab
        .call(
            Method::GET,
            &format!("/projects/{}/work/board", lab.project),
            Value::Null,
        )
        .await;
    assert_eq!(final_board["total"], 3);
    assert_eq!(
        lab.state.work.get(&lab.project, &work).unwrap().stage,
        WorkStage::Done
    );
}
