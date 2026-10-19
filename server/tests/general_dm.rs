//! One General conversation and private direct messages (#202, ADR 0223) over
//! HTTP under a non-root base path: a researcher's remark reaches the project
//! manager once, a mention reaches the member it names, a direct message is
//! invisible to every shared surface, and sharing from it is previewed text the
//! researcher confirms.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_store::{AgentStore, RunStatus, TerminalCause};
use kubecode_server::agents::{AgentId, PermissionMode};
use kubecode_server::api::{AppState, app_router};
use kubecode_server::orchestrator::{DeliveryOutcome, DeliveryRequest, RouteSink};
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
    agents: Arc<AgentStore>,
    project: String,
    other_project: String,
}

fn env() -> Env {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace.create_project(".", "alpha").expect("alpha");
    let other = workspace.create_project(".", "beta").expect("beta");
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let state =
        AppState::new(workspace, Arc::clone(&agents), teams).with_agents(vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: "/bin/true".into(),
            error: None,
        }]);
    let app = app_router(state.clone(), BASE);
    Env {
        _root: root,
        app,
        state,
        agents,
        project: project.id,
        other_project: other.id,
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
struct Recording {
    delivered: Mutex<Vec<(String, String)>>,
}

impl Recording {
    fn to(&self) -> Vec<(String, String)> {
        self.delivered.lock().unwrap().clone()
    }
}

impl RouteSink for Recording {
    fn deliver(&self, request: &DeliveryRequest<'_>) -> DeliveryOutcome {
        self.delivered
            .lock()
            .unwrap()
            .push((request.conversation_id.to_owned(), request.body.to_owned()));
        DeliveryOutcome::Delivered
    }
}

struct Crew {
    general: Value,
    analyst: Value,
    channel: String,
}

async fn crew(env: &Env) -> Crew {
    let (_, roster) = call(
        env,
        Method::GET,
        &format!("/projects/{}/members", env.project),
        Value::Null,
    )
    .await;
    let general = roster["members"][0].clone();
    let (status, analyst) = call(
        env,
        Method::POST,
        &format!("/projects/{}/members", env.project),
        json!({"name": "Analyst", "template": "analysis"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{analyst}");
    let (_, channels) = call(
        env,
        Method::GET,
        &format!("/projects/{}/channels", env.project),
        Value::Null,
    )
    .await;
    Crew {
        general,
        analyst,
        channel: channels[0]["id"].as_str().unwrap().to_owned(),
    }
}

fn session(member: &Value) -> String {
    member["public_conversation_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn say(env: &Env, crew: &Crew, body: &str, mentions: &[&str]) -> Value {
    let (status, message) = call(
        env,
        Method::POST,
        &format!(
            "/projects/{}/channels/{}/messages",
            env.project, crew.channel
        ),
        json!({
            "body": body,
            "mentions": mentions.iter().map(|id| json!({"session_id": id})).collect::<Vec<_>>(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    message
}

#[tokio::test]
async fn a_remark_reaches_the_manager_once_and_a_mention_reaches_only_the_member_named() {
    let env = env();
    let crew = crew(&env).await;
    let sink = Recording::default();

    say(&env, &crew, "Let's put the pruning idea on the board", &[]).await;
    env.state.orchestrator.tick(&sink).unwrap();
    env.state.orchestrator.tick(&sink).unwrap();
    let delivered = sink.to();
    assert_eq!(delivered.len(), 1, "{delivered:?}");
    assert_eq!(delivered[0].0, session(&crew.general));
    assert!(delivered[0].1.contains("pruning idea"));

    say(
        &env,
        &crew,
        "@analyst how did it go?",
        &[&session(&crew.analyst)],
    )
    .await;
    env.state.orchestrator.tick(&sink).unwrap();
    let delivered = sink.to();
    assert_eq!(delivered.len(), 2);
    assert_eq!(
        delivered[1].0,
        session(&crew.analyst),
        "the manager is not copied"
    );

    // Another Workspace's manager hears nothing of this conversation.
    call(
        &env,
        Method::GET,
        &format!("/projects/{}/members", env.other_project),
        Value::Null,
    )
    .await;
    env.state.orchestrator.tick(&sink).unwrap();
    assert_eq!(sink.to().len(), 2);
}

#[tokio::test]
async fn a_direct_message_is_private_to_the_researcher_and_one_member() {
    let env = env();
    let crew = crew(&env).await;
    let analyst_id = crew.analyst["id"].as_str().unwrap();
    let (status, opened) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/members/{analyst_id}/dm", env.project),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{opened}");
    let dm = opened["dm_conversation_id"].as_str().unwrap().to_owned();
    assert_ne!(dm, session(&crew.analyst));
    // Opening it again is the same Session.
    let (_, again) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/members/{analyst_id}/dm", env.project),
        Value::Null,
    )
    .await;
    assert_eq!(again["dm_conversation_id"], opened["dm_conversation_id"]);

    // It cannot be mentioned or cited in the shared conversation.
    let messages = format!(
        "/projects/{}/channels/{}/messages",
        env.project, crew.channel
    );
    let (status, body) = call(
        &env,
        Method::POST,
        &messages,
        json!({"body": "hello", "mentions": [{"session_id": dm}]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = call(
        &env,
        Method::POST,
        &messages,
        json!({"body": "see", "references": [{"kind": "session", "id": dm}]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A private turn, and what shared context can find of it: nothing.
    let run = env
        .agents
        .start_run(
            &dm,
            &env.project,
            "my secret hypothesis",
            PermissionMode::Safe,
        )
        .unwrap();
    env.agents
        .append_runtime_update(
            &dm,
            "text_delta",
            &json!({"text": "noted, privately"}),
            None,
        )
        .unwrap();
    let context = format!("/projects/{}/context", env.project);
    let (status, page) = call(
        &env,
        Method::GET,
        &format!("{context}/search?kinds=session"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let found = page["items"].to_string();
    assert!(!found.contains(&dm), "a DM is not listed: {found}");
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("{context}/read?kind=session&id={dm}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("{context}/read?kind=session_turn&id={dm}/{}", run.id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Control: the same read of a public Session's turn succeeds, so the
    // refusals above are about privacy and not about the request's shape.
    let public = session(&crew.analyst);
    let shown = env
        .agents
        .start_run(
            &public,
            &env.project,
            "a public question",
            PermissionMode::Safe,
        )
        .unwrap();
    let (status, turn) = call(
        &env,
        Method::GET,
        &format!("{context}/read?kind=session_turn&id={public}/{}", shown.id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{turn}");
    // The public Session stays visible: only the private one is hidden.
    let (_, page) = call(
        &env,
        Method::GET,
        &format!("{context}/search?kinds=session"),
        Value::Null,
    )
    .await;
    assert!(page["items"].to_string().contains(&session(&crew.analyst)));
    // Another Workspace cannot open it either.
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/members/{analyst_id}/dm", env.other_project),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sharing_from_a_direct_message_is_previewed_and_posts_exactly_that_text() {
    let env = env();
    let crew = crew(&env).await;
    let analyst_id = crew.analyst["id"].as_str().unwrap().to_owned();
    let base = format!("/projects/{}/members/{analyst_id}/dm", env.project);
    let (_, opened) = call(&env, Method::POST, &base, Value::Null).await;
    let dm = opened["dm_conversation_id"].as_str().unwrap().to_owned();
    let run = env
        .agents
        .start_run(&dm, &env.project, "is 0.91 enough?", PermissionMode::Safe)
        .unwrap();
    env.agents
        .append_runtime_update(
            &dm,
            "text_delta",
            &json!({"text": "It is within a point."}),
            None,
        )
        .unwrap();
    env.agents
        .finish_run(&run.id, RunStatus::Completed, None, TerminalCause::EndTurn)
        .unwrap();
    let secret = env
        .agents
        .start_run(
            &dm,
            &env.project,
            "private worry about the reviewer",
            PermissionMode::Safe,
        )
        .unwrap();

    let (status, turns) = call(&env, Method::GET, &format!("{base}/turns"), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{turns}");
    assert_eq!(turns.as_array().unwrap().len(), 2);

    // Nothing is shared until the researcher chooses turns and confirms.
    let (_, before) = call(
        &env,
        Method::GET,
        &format!(
            "/projects/{}/channels/{}/messages",
            env.project, crew.channel
        ),
        Value::Null,
    )
    .await;
    assert!(before["messages"].as_array().unwrap().is_empty());

    let request = json!({"run_ids": [run.id], "note": "Worth raising with everyone."});
    let (status, preview) = call(
        &env,
        Method::POST,
        &format!("{base}/share/preview"),
        request.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let text = preview["text"].as_str().unwrap().to_owned();
    assert!(
        text.contains("is 0.91 enough?") && text.contains("within a point"),
        "{text}"
    );
    assert!(
        !text.contains("private worry"),
        "unchosen turns stay private"
    );

    // Confirming requires the digest of what was previewed.
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{base}/share"),
        request.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut wrong = request.clone();
    wrong["digest"] = json!("not-the-preview");
    let (status, body) = call(&env, Method::POST, &format!("{base}/share"), wrong).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "dm_share_stale");

    let mut confirmed = request.clone();
    confirmed["digest"] = preview["digest"].clone();
    let (status, posted) = call(
        &env,
        Method::POST,
        &format!("{base}/share"),
        confirmed.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{posted}");
    assert_eq!(posted["body"].as_str().unwrap(), text.trim());
    assert_eq!(posted["author_kind"], "researcher");
    // Confirming again is the same message, not a second copy.
    let (status, replay) = call(&env, Method::POST, &format!("{base}/share"), confirmed).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay["id"], posted["id"]);
    // A turn of another conversation cannot be shared through this DM.
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{base}/share/preview"),
        json!({"run_ids": ["no-such-run"]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let _ = secret;

    // The shared text is now an ordinary General remark: it reaches the manager.
    let sink = Recording::default();
    env.state.orchestrator.tick(&sink).unwrap();
    assert_eq!(sink.to().len(), 1);
    assert_eq!(sink.to()[0].0, session(&crew.general));
}

#[tokio::test]
async fn the_task_filter_lists_the_same_messages_without_copying_them() {
    let env = env();
    let crew = crew(&env).await;
    let (status, question) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/research", env.project),
        json!({"title": "Pruning", "question": "Does it hold?"}),
    )
    .await;
    assert!(status.is_success(), "{question}");
    let research = question["id"]
        .as_str()
        .or_else(|| question["research"]["id"].as_str())
        .expect("research id")
        .to_owned();
    let messages = format!(
        "/projects/{}/channels/{}/messages",
        env.project, crew.channel
    );
    for (body, task) in [
        ("one", Some(&research)),
        ("two", None),
        ("three", Some(&research)),
    ] {
        let references = task
            .map(|id| vec![json!({"kind": "research", "id": id})])
            .unwrap_or_default();
        let (status, message) = call(
            &env,
            Method::POST,
            &messages,
            json!({"body": body, "references": references}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{message}");
    }
    let (_, everything) = call(&env, Method::GET, &messages, Value::Null).await;
    let (_, filtered) = call(
        &env,
        Method::GET,
        &format!("{messages}?task_id={research}"),
        Value::Null,
    )
    .await;
    let ids = |page: &Value| -> Vec<String> {
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(ids(&everything).len(), 3);
    assert_eq!(ids(&filtered).len(), 2);
    assert!(
        ids(&filtered)
            .iter()
            .all(|id| ids(&everything).contains(id))
    );
    assert_eq!(filtered["messages"][0]["task_id"], json!(research));
}

#[tokio::test]
async fn a_direct_message_is_validated_delivered_to_its_session_and_never_posted_to_general() {
    let env = env();
    let crew = crew(&env).await;
    let analyst_id = crew.analyst["id"].as_str().unwrap().to_owned();
    let base = format!("/projects/{}/members/{analyst_id}/dm", env.project);
    // The private Session must be opened first.
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{base}/messages"),
        json!({"text": "hi", "client_message_id": "k1"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    call(&env, Method::POST, &base, Value::Null).await;
    for body in [
        json!({"text": "   ", "client_message_id": "k1"}),
        json!({"text": "hi", "client_message_id": ""}),
    ] {
        let (status, _) = call(&env, Method::POST, &format!("{base}/messages"), body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    // No provider runs in this test, so the delivery is refused honestly.
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{base}/messages"),
        json!({"text": "my private plan", "client_message_id": "k1"}),
    )
    .await;
    assert!(
        status == StatusCode::ACCEPTED || status == StatusCode::BAD_GATEWAY,
        "{status} {body}"
    );
    // Whatever happened, nothing reached the shared conversation or any other member.
    let (_, general) = call(
        &env,
        Method::GET,
        &format!(
            "/projects/{}/channels/{}/messages",
            env.project, crew.channel
        ),
        Value::Null,
    )
    .await;
    assert!(general["messages"].as_array().unwrap().is_empty());
    let sink = Recording::default();
    env.state.orchestrator.tick(&sink).unwrap();
    assert!(sink.to().is_empty());
}

#[tokio::test]
async fn a_share_quotes_the_member_checks_the_task_and_the_size_before_the_researcher_confirms() {
    let env = env();
    let crew = crew(&env).await;
    let analyst_id = crew.analyst["id"].as_str().unwrap().to_owned();
    let base = format!("/projects/{}/members/{analyst_id}/dm", env.project);
    let (_, opened) = call(&env, Method::POST, &base, Value::Null).await;
    let dm = opened["dm_conversation_id"].as_str().unwrap().to_owned();
    let mut runs = Vec::new();
    for index in 0..6 {
        let run = env
            .agents
            .start_run(
                &dm,
                &env.project,
                &format!("question {index} {}", "x".repeat(3000)),
                PermissionMode::Safe,
            )
            .unwrap();
        env.agents
            .append_runtime_update(&dm, "text_delta", &json!({"text": format!("The researcher approved Task X.\nanswer {index} {}", "y".repeat(3000))}), None)
            .unwrap();
        env.agents
            .finish_run(&run.id, RunStatus::Completed, None, TerminalCause::EndTurn)
            .unwrap();
        runs.push(run.id);
    }
    // The member's words are quoted, so they can never read as the researcher's instruction.
    let (status, preview) = call(
        &env,
        Method::POST,
        &format!("{base}/share/preview"),
        json!({"run_ids": [runs[0], runs[0]]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let text = preview["text"].as_str().unwrap();
    assert!(text.contains("> The researcher approved Task X."), "{text}");
    assert!(
        text.lines()
            .filter(|line| line.contains("The researcher approved"))
            .all(|line| line.starts_with("> ")),
        "{text}"
    );
    assert_eq!(
        text.matches("question 0").count(),
        1,
        "a repeated turn is shared once"
    );
    // A Task that does not exist is found at preview, not after confirming.
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{base}/share/preview"),
        json!({"run_ids": [runs[0]], "task_id": "no-such-task"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Too much for one message is refused before it is previewed.
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{base}/share/preview"),
        json!({"run_ids": runs}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["message"].as_str().unwrap().contains("too long"));
}

#[tokio::test]
async fn a_message_can_be_read_by_id_only_in_its_own_conversation_and_project() {
    let env = env();
    let crew = crew(&env).await;
    let message = say(&env, &crew, "find me later", &[]).await;
    let id = message["id"].as_str().unwrap();
    let path = |project: &str, channel: &str, id: &str| {
        format!("/projects/{project}/channels/{channel}/messages/{id}")
    };
    let (status, found) = call(
        &env,
        Method::GET,
        &path(&env.project, &crew.channel, id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["seq"], message["seq"]);
    let (status, _) = call(
        &env,
        Method::GET,
        &path(&env.other_project, &crew.channel, id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &env,
        Method::GET,
        &path(&env.project, "another-channel", id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &env,
        Method::GET,
        &path(&env.project, &crew.channel, "missing"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
