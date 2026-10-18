//! Work board API tests (#189) under a non-root base path: one projection that
//! every filter only narrows, a card inspector, and researcher commands that
//! are revision-checked and cannot fabricate completion, bypass a limit, or
//! cross a Project.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::research_store::{NewRound, ResearchBrief, RoundKind};
use kubecode_server::teams::TeamStore;
use kubecode_server::work_store::{Actor, NewWork, PolicyPatch};
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE: &str = "/user/alice/kubecode";

struct Env {
    _root: TempDir,
    app: Router,
    state: AppState,
    agents: Arc<AgentStore>,
    project_id: String,
    other_project_id: String,
    research_id: String,
    round_id: String,
}

fn env() -> Env {
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
                question: "Does it hold?".into(),
                ..Default::default()
            },
            None,
        )
        .expect("question");
    let coordinator = agents
        .create_conversation(&project.id, AgentId::OpenCode, Some("Coordinator"))
        .expect("session");
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
        .round_set_session(&project.id, &question.id, &round.id, &coordinator.id)
        .expect("session");
    state
        .research
        .round_mark_started(&project.id, &question.id, &round.id)
        .expect("started");
    state
        .work
        .assume_coordinator(&project.id, &round.id, &coordinator.id, &Actor::Researcher)
        .expect("coordinator");
    let app = app_router(state.clone(), BASE);
    Env {
        _root: root,
        app,
        state,
        agents,
        project_id: project.id,
        other_project_id: other.id,
        research_id: question.id,
        round_id: round.id,
    }
}

async fn call(env: &Env, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
    let response = env
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

impl Env {
    fn task(&self, title: &str, thread: Option<&str>) -> String {
        self.state
            .work
            .create(
                &self.project_id,
                NewWork {
                    title,
                    description: "do the thing",
                    round_id: Some(&self.round_id),
                    derived_from: thread.map(|id| ("thread", id)),
                    ..Default::default()
                },
                &Actor::Researcher,
            )
            .expect("task")
            .0
            .id
    }

    fn session(&self, title: &str) -> String {
        self.agents
            .create_conversation(&self.project_id, AgentId::OpenCode, Some(title))
            .expect("session")
            .id
    }

    async fn board(&self, query: &str) -> Value {
        let (status, board) = call(
            self,
            Method::GET,
            &format!("/projects/{}/work/board?{query}", self.project_id),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{board}");
        board
    }

    async fn card(&self, work_id: &str) -> Value {
        let (status, card) = call(
            self,
            Method::GET,
            &format!("/projects/{}/work/{work_id}", self.project_id),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{card}");
        card
    }

    async fn run(&self, work_id: &str, body: Value) -> (StatusCode, Value) {
        call(
            self,
            Method::POST,
            &format!("/projects/{}/work/{work_id}/commands", self.project_id),
            body,
        )
        .await
    }
}

fn ids(cards: &Value) -> Vec<String> {
    let mut ids: Vec<String> = cards
        .as_array()
        .unwrap()
        .iter()
        .map(|card| card["item"]["id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

#[tokio::test]
async fn one_board_serves_every_filter_without_duplicating_or_inventing_cards() {
    let env = env();
    // A Thread links work to its discussion.
    let channel = env.state.channels.default_channel(&env.project_id).unwrap();
    let root = env
        .state
        .channels
        .post(
            &env.project_id,
            &channel.id,
            kubecode_server::channel_store::NewMessage {
                body: "Pruning?",
                ..Default::default()
            },
        )
        .unwrap()
        .0;
    let (thread, _) = env
        .state
        .channels
        .start_thread(&env.project_id, &channel.id, &root.id, None, None)
        .unwrap();
    env.state
        .channels
        .link_thread(
            &env.project_id,
            &thread.id,
            1,
            Some(&env.research_id),
            Some(&env.round_id),
        )
        .unwrap();
    let from_thread = env.task("From the thread", Some(&thread.id));
    let plain = env.task("Plain task", None);
    let executor = env.session("Pruner");
    env.state
        .work
        .assign(
            &env.project_id,
            &plain,
            &executor,
            None,
            "",
            &Actor::Researcher,
        )
        .unwrap();

    let all = env.board("").await;
    assert_eq!(all["total"], 2);
    assert_eq!(ids(&all["cards"]), {
        let mut both = vec![from_thread.clone(), plain.clone()];
        both.sort();
        both
    });
    // Every filter selects from the same cards: a subset with identical identities.
    for (query, expected) in [
        (
            format!("research_id={}", env.research_id),
            vec![from_thread.clone(), plain.clone()],
        ),
        (
            format!("round_id={}", env.round_id),
            vec![from_thread.clone(), plain.clone()],
        ),
        (
            format!("thread_id={}", thread.id),
            vec![from_thread.clone()],
        ),
        (format!("conversation_id={executor}"), vec![plain.clone()]),
        (
            "stage=ready".to_owned(),
            vec![from_thread.clone(), plain.clone()],
        ),
        ("origin=legacy_team".to_owned(), vec![]),
    ] {
        let mut expected = expected;
        expected.sort();
        assert_eq!(ids(&env.board(&query).await["cards"]), expected, "{query}");
    }
    // The card names what it belongs to and who executes it.
    let card = env.card(&plain).await;
    assert_eq!(card["research"]["title"], "Pruning");
    assert_eq!(card["round"]["number"], 1);
    assert_eq!(card["executor"]["title"], "Pruner");
    assert_eq!(card["operable"], "native");
    let from = env.card(&from_thread).await;
    assert_eq!(from["origin_thread"]["id"], thread.id);
    // Unknown filter values are refused, not ignored.
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/work/board?stage=nope", env.project_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn commands_are_revision_checked_and_cannot_fabricate_completion() {
    let env = env();
    let task = env.task("Sweep", None);
    let executor = env.session("Worker");
    let card = env.card(&task).await;
    let revision = card["item"]["state_revision"].as_u64().unwrap();

    // Starting before anyone is assigned is refused, not papered over.
    let (status, error) = env
        .run(
            &task,
            json!({"command": "start", "request_key": "s1", "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(
        ["work_not_assigned", "work_state"].contains(&error["code"].as_str().unwrap()),
        "{error}"
    );

    let (status, assigned) = env
        .run(&task, json!({"command": "assign", "session_id": executor, "expected_state_revision": revision}))
        .await;
    assert_eq!(status, StatusCode::OK, "{assigned}");
    // The card moved: the same revision is now stale.
    let (status, stale) = env
        .run(
            &task,
            json!({"command": "pause", "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(stale["code"], "work_state_conflict");
    let current = stale["current_state_revision"].as_u64().unwrap();

    // Start: an attempt begins and the executor is told.
    let (status, started) = env
        .run(
            &task,
            json!({"command": "start", "request_key": "s1", "expected_state_revision": current}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    assert_eq!(started["item"]["stage"], "executing");
    assert_eq!(started["latest_attempt"]["status"], "queued");
    let detail = env.card(&task).await;
    assert_eq!(detail["attempts"].as_array().unwrap().len(), 1);
    assert_eq!(detail["routes"][0]["kind"], "dispatch");
    assert_eq!(detail["routes"][0]["state"], "pending");

    // Nothing can move work to done without a review of something produced.
    let revision = detail["item"]["state_revision"].as_u64().unwrap();
    let (status, error) = env
        .run(
            &task,
            json!({"command": "review", "accept": true, "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "work_state");
    assert_eq!(env.card(&task).await["item"]["stage"], "executing");

    // Pause and resume are separate from stage; a priority change needs the plan revision.
    let (_, paused) = env
        .run(&task, json!({"command": "pause", "reason": "budget check", "expected_state_revision": revision}))
        .await;
    assert_eq!(paused["item"]["condition"], "paused");
    assert_eq!(paused["blockers"][0]["kind"], "condition");
    let revision = paused["item"]["state_revision"].as_u64().unwrap();
    let plan_revision = paused["item"]["revision"].as_u64().unwrap();
    let (status, prioritized) = env
        .run(&task, json!({"command": "prioritize", "priority": 5,
                           "expected_revision": plan_revision, "expected_state_revision": revision}))
        .await;
    assert_eq!(status, StatusCode::OK, "{prioritized}");
    assert_eq!(prioritized["item"]["priority"], 5);
    let (status, error) = env
        .run(
            &task,
            json!({"command": "prioritize", "priority": 9,
                           "expected_revision": plan_revision, "expected_state_revision":
                           prioritized["item"]["state_revision"]}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "work_revision_conflict");
}

#[tokio::test]
async fn limits_apply_to_the_researchers_commands_too_and_closed_work_keeps_its_reason() {
    let env = env();
    env.state
        .work
        .set_policy(
            &env.project_id,
            &env.round_id,
            0,
            PolicyPatch {
                max_parallel_attempts: Some(1),
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap();
    let executor = env.session("Worker");
    let a = env.task("A", None);
    let b = env.task("B", None);
    for task in [&a, &b] {
        env.state
            .work
            .assign(
                &env.project_id,
                task,
                &executor,
                None,
                "",
                &Actor::Researcher,
            )
            .unwrap();
    }
    let revision_of = |card: &Value| card["item"]["state_revision"].as_u64().unwrap();
    let (status, _) = env
        .run(&a, json!({"command": "start", "request_key": "a", "expected_state_revision": revision_of(&env.card(&a).await)}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, error) = env
        .run(&b, json!({"command": "start", "request_key": "b", "expected_state_revision": revision_of(&env.card(&b).await)}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "work_budget_exhausted");
    assert_eq!(error["limit"], "parallel attempts");

    // Cancelling keeps the card, its history, and the reason, in the closed lane.
    let card = env.card(&b).await;
    let (status, closed) = env
        .run(
            &b,
            json!({"command": "close", "lifecycle": "canceled", "reason": "superseded by plan B",
                        "expected_revision": card["item"]["revision"],
                        "expected_state_revision": revision_of(&card)}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    let open = env.board("").await;
    assert_eq!(open["total"], 1);
    assert_eq!(open["closed"].as_array().unwrap().len(), 0);
    let with_closed = env.board("include_closed=true").await;
    assert_eq!(with_closed["closed"][0]["item"]["id"], b.as_str());
    assert_eq!(
        with_closed["closed"][0]["item"]["closed_reason"],
        "superseded by plan B"
    );
    assert_eq!(with_closed["closed"][0]["item"]["lifecycle"], "canceled");
}

#[tokio::test]
async fn another_project_cannot_see_or_command_a_card() {
    let env = env();
    let task = env.task("Private", None);
    let other = &env.other_project_id;
    let (status, board) = call(
        &env,
        Method::GET,
        &format!("/projects/{other}/work/board"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(board["total"], 0);
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("/projects/{other}/work/{task}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("/projects/{other}/work/{task}/commands"),
        json!({"command": "resume", "expected_state_revision": 1}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &env,
        Method::GET,
        "/projects/missing/work/board",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_researcher_adds_tasks_that_replay_safely_and_candidates_cannot_run() {
    let env = env();
    let path = format!("/projects/{}/work", env.project_id);
    let (status, created) = call(
        &env,
        Method::POST,
        &path,
        json!({"title": "Try dropout", "description": "p=0.1", "client_request_id": "c-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["item"]["origin"], "native");
    assert_eq!(created["item"]["created_by"], "researcher");
    assert!(
        created["item"]["round_id"].is_null(),
        "a candidate has no round"
    );
    // A browser retry is the same card.
    let (status, again) = call(
        &env,
        Method::POST,
        &path,
        json!({"title": "Try dropout", "description": "p=0.1", "client_request_id": "c-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["item"]["id"], created["item"]["id"]);
    assert_eq!(env.board("").await["total"], 1);

    // It cannot start: no approved round, and no one is assigned either.
    let id = created["item"]["id"].as_str().unwrap();
    let executor = env.session("Worker");
    let revision = created["item"]["state_revision"].as_u64().unwrap();
    let (_, assigned) = env
        .run(id, json!({"command": "assign", "session_id": executor, "expected_state_revision": revision}))
        .await;
    let (status, error) = env
        .run(
            id,
            json!({"command": "start", "request_key": "k",
                        "expected_state_revision": assigned["item"]["state_revision"]}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "work_state");
    // Invalid input is a 400, not a stored card.
    let (status, _) = call(&env, Method::POST, &path, json!({"title": "   "})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Another Project cannot attach work to this one's round.
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/work", env.other_project_id),
        json!({"title": "Intruder", "round_id": env.round_id}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// -- Review regressions ---------------------------------------------------------------------------------

#[tokio::test]
async fn legacy_team_work_shows_with_its_attribution_and_is_never_commanded_from_here() {
    use kubecode_server::teams::{
        MemberWorkspaceMode, NewTeam, NewTeamTask, NewTeammate, StartTeam, TeamMode, TeamWorkspace,
    };
    let env = env();
    let leader = env
        .agents
        .create_conversation(&env.project_id, AgentId::OpenCode, Some("Lead"))
        .unwrap();
    let team = env
        .state
        .teams
        .create_team(NewTeam {
            project_id: &env.project_id,
            leader_conversation_id: &leader.id,
            agent_session_id: &leader.agent_session_id,
            leader_name: "Lead",
            title: Some("Compiler team"),
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .unwrap();
    let lead = env.state.teams.list_members(&team.id).unwrap().remove(0);
    env.state
        .teams
        .start_team(StartTeam {
            team_id: &team.id,
            leader_member_id: &lead.id,
            goal: "g",
            acceptance_criteria: &["done".to_owned()],
            allowed_agent_ids: &["opencode".to_owned()],
            mode: TeamMode::Standard,
            max_teammates: 2,
            max_parallel_runs: 1,
            max_review_rounds: 1,
        })
        .unwrap();
    env.state.teams.activate_team(&team.id).unwrap();
    let worker = env
        .agents
        .create_conversation(&env.project_id, AgentId::OpenCode, Some("Worker"))
        .unwrap();
    let teammate = env
        .state
        .teams
        .add_teammate(NewTeammate {
            team_id: &team.id,
            caller_member_id: &lead.id,
            conversation_id: &worker.id,
            name: "worker",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .unwrap();
    let task = env
        .state
        .teams
        .create_task(NewTeamTask {
            team_id: &team.id,
            creator_member_id: &lead.id,
            title: "Port the parser",
            description: "d",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: false,
        })
        .unwrap();
    env.state
        .teams
        .delegate_task(&task.id, &lead.id, &teammate.id)
        .unwrap();

    // The Team's task is a card on the one board with its attribution.
    let board = env.board(&format!("team_id={}", team.id)).await;
    assert_eq!(board["cards"].as_array().unwrap().len(), 1);
    let card = &board["cards"][0];
    assert_eq!(card["item"]["id"], task.id.as_str());
    assert_eq!(card["operable"], "legacy_team");
    assert_eq!(card["team"]["title"], "Compiler team");
    assert_eq!(card["executor"]["title"], "Worker");
    assert_eq!(env.board("origin=legacy_team").await["total"], 1);
    assert_eq!(env.board("origin=native").await["total"], 0);
    // Every command is refused as Team-owned, not applied.
    let revision = card["item"]["state_revision"].as_u64().unwrap();
    for body in [
        json!({"command": "pause", "expected_state_revision": revision}),
        json!({"command": "assign", "session_id": env.session("Other"), "expected_state_revision": revision}),
        json!({"command": "close", "lifecycle": "canceled", "reason": "x",
               "expected_revision": card["item"]["revision"], "expected_state_revision": revision}),
    ] {
        let (status, error) = env.run(&task.id, body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert_eq!(error["code"], "work_legacy_owned");
    }
    // A Team member's Session is not assignable to native work either.
    let native = env.task("Native", None);
    let current = env.card(&native).await["item"]["state_revision"].clone();
    let (status, error) = env
        .run(&native, json!({"command": "assign", "session_id": worker.id, "expected_state_revision": current}))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(error["code"], "invalid_work_request");
}

#[tokio::test]
async fn counts_conditions_truncation_blockers_and_closed_agents_are_reported_truthfully() {
    let env = env();
    let first = env.task("First", None);
    let second = env
        .state
        .work
        .create(
            &env.project_id,
            NewWork {
                title: "Second",
                round_id: Some(&env.round_id),
                dependencies: std::slice::from_ref(&first),
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap()
        .0
        .id;
    let card = env.card(&second).await;
    assert_eq!(card["item"]["stage"], "planned");
    assert_eq!(card["blockers"][0]["kind"], "dependency");
    assert_eq!(card["blockers"][0]["title"], "First");

    let board = env.board("").await;
    let count = |stage: &str| {
        board["stages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["stage"] == stage)
            .map_or(0, |entry| entry["count"].as_u64().unwrap())
    };
    assert_eq!(
        (
            count("planned"),
            count("ready"),
            board["total"].as_u64().unwrap()
        ),
        (1, 1, 2)
    );
    // A stage filter reports that stage's total, so it is not "truncated" by other stages.
    let ready = env.board("stage=ready&limit=1").await;
    assert_eq!(ready["total"], 1);
    assert_eq!(ready["truncated"], false);
    let paged = env.board("limit=1").await;
    assert_eq!(
        (paged["total"].as_u64(), paged["truncated"].as_bool()),
        (Some(2), Some(true))
    );
    // A huge offset is bounded, not an overflow.
    let (status, _) = call(
        &env,
        Method::GET,
        &format!(
            "/projects/{}/work/board?offset=18446744073709551615",
            env.project_id
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Conditions are counted apart from stages; pausing only works on unflagged work.
    let revision = env.card(&first).await["item"]["state_revision"].clone();
    let (status, paused) = env
        .run(
            &first,
            json!({"command": "pause", "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{paused}");
    let conditions = env.board("").await["conditions"].clone();
    assert!(
        conditions
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["condition"] == "paused" && c["count"] == 1)
    );
    env.state
        .work
        .set_condition(
            &env.project_id,
            &second,
            kubecode_server::work_store::WorkCondition::NeedsInput,
            Some("which dataset?"),
            &Actor::Researcher,
        )
        .unwrap();
    let flagged = env.card(&second).await["item"]["state_revision"].clone();
    let (status, error) = env
        .run(
            &second,
            json!({"command": "pause", "expected_state_revision": flagged}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "work_condition_in_use");

    // Under an Agent filter, closed work still shows with the Agent that held it.
    let executor = env.session("Worker");
    let third = env.task("Third", None);
    let revision = env.card(&third).await["item"]["state_revision"].clone();
    env.run(
        &third,
        json!({"command": "assign", "session_id": executor, "expected_state_revision": revision}),
    )
    .await;
    let card = env.card(&third).await;
    env.run(
        &third,
        json!({"command": "close", "lifecycle": "canceled", "reason": "dropped",
                           "expected_revision": card["item"]["revision"],
                           "expected_state_revision": card["item"]["state_revision"]}),
    )
    .await;
    let filtered = env
        .board(&format!("conversation_id={executor}&include_closed=true"))
        .await;
    assert_eq!(filtered["cards"].as_array().unwrap().len(), 0);
    assert_eq!(filtered["closed"][0]["item"]["id"], third.as_str());
    assert_eq!(filtered["closed_truncated"], false);
    // A removed executor is shown as removed, not as no one.
    let ghost = env.session("Ghost");
    let fourth = env.task("Fourth", None);
    let revision = env.card(&fourth).await["item"]["state_revision"].clone();
    env.run(
        &fourth,
        json!({"command": "assign", "session_id": ghost, "expected_state_revision": revision}),
    )
    .await;
    env.agents.delete_conversation(&ghost).unwrap();
    let after = env.card(&fourth).await;
    assert_eq!(after["executor"]["available"], false);
    assert!(after["assignment"].is_object());
}

#[tokio::test]
async fn a_priority_change_is_refused_if_the_card_moved_after_it_was_read() {
    let env = env();
    let task = env.task("Moving", None);
    let card = env.card(&task).await;
    // The card moves (an agent or the researcher paused it) after the browser read it.
    env.state
        .work
        .set_condition(
            &env.project_id,
            &task,
            kubecode_server::work_store::WorkCondition::Waiting,
            Some("x"),
            &Actor::Researcher,
        )
        .unwrap();
    let (status, error) = env
        .run(
            &task,
            json!({"command": "prioritize", "priority": 4,
                           "expected_revision": card["item"]["revision"],
                           "expected_state_revision": card["item"]["state_revision"]}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "work_state_conflict");
    assert_eq!(env.card(&task).await["item"]["priority"], 0);
}

/// Gets a task to review with an executor-cited file as evidence.
fn reviewed_task(env: &Env, evidence_path: &str) -> String {
    use kubecode_server::work_store::{
        AttemptOutcome, NewResult, ResultRole, ReviewKind, WorkStage,
    };
    let task = env.task("Cited", None);
    let executor = env.session("Worker");
    let actor = Actor::Executor {
        conversation_id: executor.clone(),
    };
    let work = &env.state.work;
    work.assign(
        &env.project_id,
        &task,
        &executor,
        None,
        "",
        &Actor::Researcher,
    )
    .expect("assign");
    let attempt = work
        .begin_attempt(&env.project_id, &task, Some("k"), &Actor::Researcher)
        .expect("attempt");
    work.bind_attempt_run(&env.project_id, &attempt.id, "run-1", &actor)
        .expect("run");
    let revision = env
        .state
        .workspace
        .file_revision(&env.project_id, evidence_path)
        .expect("revision");
    work.add_result(
        &env.project_id,
        &task,
        NewResult {
            attempt_id: Some(&attempt.id),
            role: ResultRole::Evidence,
            kind: "file",
            ref_id: evidence_path,
            revision: Some(&revision),
        },
        &actor,
    )
    .expect("result");
    work.finish_attempt(
        &env.project_id,
        &attempt.id,
        AttemptOutcome::Completed,
        &actor,
    )
    .expect("finish");
    work.advance(
        &env.project_id,
        &task,
        WorkStage::Executing,
        WorkStage::Review,
        Some(ReviewKind::Result),
        &actor,
    )
    .expect("review");
    task
}

#[tokio::test]
async fn acceptance_is_refused_for_changed_evidence_until_the_researcher_re_pins_it() {
    let env = env();
    let root = env
        .state
        .workspace
        .execution_path(&env.project_id, None)
        .expect("root");
    std::fs::write(root.join("notes.md"), "pruning helps").unwrap();
    let task = reviewed_task(&env, "notes.md");
    let detail = env.card(&task).await;
    assert_eq!(detail["stale_evidence"].as_array().unwrap().len(), 0);

    std::fs::write(root.join("notes.md"), "pruning hurts").unwrap();
    let detail = env.card(&task).await;
    assert_eq!(detail["stale_evidence"][0]["status"], "changed");
    let result_id = detail["results"][0]["id"].as_str().unwrap().to_owned();
    let revision = detail["item"]["state_revision"].as_u64().unwrap();
    let (status, error) = env
        .run(
            &task,
            json!({"command": "review", "accept": true, "outcome": "supported",
                   "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "work_evidence_stale");
    assert_eq!(error["stale"][0]["ref_id"], "notes.md");
    let after = env.card(&task).await;
    assert_eq!(after["item"]["stage"], "review", "nothing was accepted");
    assert_eq!(after["item"]["condition"], "needs_input");

    // Looking at it and re-pinning clears the flag; then acceptance is possible.
    let revision = after["item"]["state_revision"].as_u64().unwrap();
    let (status, repinned) = env
        .run(
            &task,
            json!({"command": "repin", "result_id": result_id, "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{repinned}");
    assert_eq!(repinned["item"]["condition"], "none");
    let revision = repinned["item"]["state_revision"].as_u64().unwrap();
    let (status, accepted) = env
        .run(
            &task,
            json!({"command": "review", "accept": true, "outcome": "supported",
                   "reason": "read again", "expected_state_revision": revision}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["item"]["stage"], "done");
    // The review reached the question's log.
    let entries = env
        .state
        .research
        .entries(&env.project_id, &env.research_id, 0, Some(20))
        .unwrap();
    assert!(entries.iter().any(|entry| entry.body.contains("Cited")));
}

#[tokio::test]
async fn a_question_to_the_researcher_is_answered_once_and_the_answer_grants_nothing() {
    let env = env();
    let task = env.task("Needs a call", None);
    let asker = env.session("Asker");
    let (request, _) = env
        .state
        .work
        .request_decision(
            &env.project_id,
            &task,
            "q-1",
            &asker,
            "Use 8 heads?",
            &["yes".to_owned(), "no".to_owned()],
            None,
            None,
        )
        .expect("request");
    let detail = env.card(&task).await;
    assert_eq!(detail["decision_requests"][0]["state"], "open");
    assert_eq!(detail["item"]["condition"], "needs_input");
    let policy_before = env
        .state
        .work
        .policy(&env.project_id, &env.round_id)
        .unwrap();
    let path = format!(
        "/projects/{}/work/{task}/decisions/{}/answer",
        env.project_id, request.id
    );

    let (status, error) = call(&env, Method::POST, &path, json!({"answer": "maybe"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    let (status, answered) = call(&env, Method::POST, &path, json!({"answer": "yes"})).await;
    assert_eq!(status, StatusCode::OK, "{answered}");
    assert_eq!(answered["state"], "answered");
    // Repeating the same answer is fine; a different one is refused.
    let (status, _) = call(&env, Method::POST, &path, json!({"answer": "yes"})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&env, Method::POST, &path, json!({"answer": "no"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let detail = env.card(&task).await;
    assert_eq!(detail["item"]["condition"], "none");
    let routes = env
        .state
        .orchestrator
        .routes(&env.project_id, None, 20)
        .unwrap()
        .into_iter()
        .filter(|route| route.kind.as_str() == "decision")
        .count();
    assert_eq!(routes, 1, "the asker is told once");
    assert_eq!(
        env.state
            .work
            .policy(&env.project_id, &env.round_id)
            .unwrap(),
        policy_before
    );

    // Another card, or another Project, cannot be used to answer it.
    let other_task = env.task("Other", None);
    let wrong_card = format!(
        "/projects/{}/work/{other_task}/decisions/{}/answer",
        env.project_id, request.id
    );
    let (status, _) = call(&env, Method::POST, &wrong_card, json!({"answer": "yes"})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let wrong_project = format!(
        "/projects/{}/work/{task}/decisions/{}/answer",
        env.other_project_id, request.id
    );
    let (status, _) = call(&env, Method::POST, &wrong_project, json!({"answer": "yes"})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
