//! Orchestration API tests (#188) under a non-root base path: the researcher
//! reads and sets a round's execution limits (revision-checked, bounded), a
//! request posted in a linked Thread is routed to the round's coordinator
//! exactly once across repeated passes, and another Project sees none of it.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::orchestrator::{DeliveryOutcome, DeliveryRequest, RouteSink};
use kubecode_server::research_store::{NewRound, ResearchBrief, RoundKind};
use kubecode_server::teams::TeamStore;
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE: &str = "/user/alice/kubecode";

struct Env {
    _root: TempDir,
    app: Router,
    state: AppState,
    project_id: String,
    other_project_id: String,
    research_id: String,
    round_id: String,
    coordinator: String,
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
    let session = agents
        .create_conversation(&project.id, AgentId::OpenCode, Some("Solo"))
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
        .round_set_session(&project.id, &question.id, &round.id, &session.id)
        .expect("session");
    let app = app_router(state.clone(), BASE);
    Env {
        _root: root,
        app,
        state,
        project_id: project.id,
        other_project_id: other.id,
        research_id: question.id,
        round_id: round.id,
        coordinator: session.id,
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

#[derive(Default)]
struct Recording(Mutex<Vec<(String, String)>>);

impl RouteSink for Recording {
    fn deliver(&self, request: &DeliveryRequest<'_>) -> DeliveryOutcome {
        self.0.lock().unwrap().push((
            request.conversation_id.to_owned(),
            request.delivery_key.to_owned(),
        ));
        DeliveryOutcome::Delivered
    }
}

#[tokio::test]
async fn the_researcher_reads_and_sets_a_rounds_limits_with_revisions_and_bounds() {
    let env = env();
    let path = format!(
        "/projects/{}/rounds/{}/execution-policy",
        env.project_id, env.round_id
    );
    let (status, defaults) = call(&env, Method::GET, &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(defaults["policy"]["revision"], 0);
    assert_eq!(defaults["policy"]["paused"], false);
    assert_eq!(defaults["used"]["executors"], 0);

    let (status, set) = call(
        &env,
        Method::PUT,
        &path,
        json!({"expected_revision": 0, "max_executors": 2, "paused": true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (
            set["policy"]["max_executors"].as_u64(),
            set["policy"]["revision"].as_u64()
        ),
        (Some(2), Some(1))
    );
    assert_eq!(set["policy"]["paused"], true);

    let (status, stale) = call(
        &env,
        Method::PUT,
        &path,
        json!({"expected_revision": 0, "paused": false}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(stale["code"], "policy_revision_conflict");
    assert_eq!(stale["current_revision"], 1);
    let (status, bad) = call(
        &env,
        Method::PUT,
        &path,
        json!({"expected_revision": 1, "max_attempts": 0}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(bad["code"], "invalid_policy");

    // Another Project cannot read or change this round's limits.
    let foreign = format!(
        "/projects/{}/rounds/{}/execution-policy",
        env.other_project_id, env.round_id
    );
    for method in [Method::GET, Method::PUT] {
        let (status, _) = call(
            &env,
            method,
            &foreign,
            json!({"expected_revision": 0, "paused": false}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn a_request_in_a_linked_thread_is_routed_once_and_visible_to_the_researcher_only() {
    let env = env();
    let channel = env.state.channels.default_channel(&env.project_id).unwrap();
    let messages = format!(
        "/projects/{}/channels/{}/messages",
        env.project_id, channel.id
    );
    let (_, root) = call(&env, Method::POST, &messages, json!({"body": "Pruning?"})).await;
    let threads = format!(
        "/projects/{}/channels/{}/threads",
        env.project_id, channel.id
    );
    let (_, thread) = call(
        &env,
        Method::POST,
        &threads,
        json!({"root_message_id": root["id"]}),
    )
    .await;
    let thread_id = thread["id"].as_str().unwrap();
    call(
        &env,
        Method::PUT,
        &format!("/projects/{}/threads/{thread_id}/link", env.project_id),
        json!({"expected_revision": 1, "research_id": env.research_id, "round_id": env.round_id}),
    )
    .await;
    let (status, request) = call(
        &env,
        Method::POST,
        &messages,
        json!({"body": "Please run the sweep", "thread_id": thread_id,
               "intent": "request", "client_message_id": "req-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    // A browser retry of the same request is the same message.
    let (status, replay) = call(
        &env,
        Method::POST,
        &messages,
        json!({"body": "Please run the sweep", "thread_id": thread_id,
               "intent": "request", "client_message_id": "req-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay["id"], request["id"]);

    let sink = Recording::default();
    for _ in 0..3 {
        env.state.orchestrator.tick(&sink).unwrap();
    }
    let delivered = sink.0.lock().unwrap().clone();
    assert_eq!(delivered.len(), 1, "three passes, one delivery");
    assert_eq!(delivered[0].0, env.coordinator);

    let (status, routes) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/routes?state=delivered", env.project_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(routes.as_array().unwrap().len(), 1);
    assert_eq!(routes[0]["kind"], "request");
    assert_eq!(routes[0]["recipient"], env.coordinator);
    let (_, theirs) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/routes", env.other_project_id),
        Value::Null,
    )
    .await;
    assert_eq!(theirs, json!([]));
    // The Thread tells the researcher what happened.
    let (_, page) = call(
        &env,
        Method::GET,
        &format!("{messages}?thread_id={thread_id}"),
        Value::Null,
    )
    .await;
    let bodies = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["body"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(
        bodies
            .iter()
            .any(|b| b.contains("passed to the round's coordinator")),
        "{bodies:?}"
    );
}
