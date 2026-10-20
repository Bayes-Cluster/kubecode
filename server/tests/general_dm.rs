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
use kubecode_server::channel_store::{AuthorKind, NewMessage};
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
    // The shared message is shown like any other: the researcher is no member.
    assert_eq!(posted["author_member_id"], Value::Null, "{posted}");
    assert_eq!(posted["mention_member_ids"], json!([]));
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

/// An agent's message written the way the MCP tools write it.
fn agent_says(env: &Env, crew: &Crew, session: &str, body: &str) -> String {
    env.state
        .channels
        .post(
            &env.project,
            &crew.channel,
            NewMessage {
                body,
                author_kind: Some(AuthorKind::Agent),
                author_ref: Some(session),
                ..Default::default()
            },
        )
        .expect("agent message")
        .0
        .id
}

#[tokio::test]
async fn messages_name_their_members_through_every_session_a_member_has_had() {
    let env = env();
    let crew = crew(&env).await;
    let members = format!("/projects/{}/members", env.project);
    let (status, writer) = call(
        &env,
        Method::POST,
        &members,
        json!({"name": "Writer", "template": "writing"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{writer}");
    let id = |member: &Value| member["id"].as_str().unwrap().to_owned();
    let (analyst_id, writer_id, general_id) = (id(&crew.analyst), id(&writer), id(&crew.general));

    let mention = say(
        &env,
        &crew,
        "@analyst please look",
        &[&session(&crew.analyst)],
    )
    .await;
    assert_eq!(mention["author_member_id"], Value::Null, "{mention}");
    assert_eq!(mention["mention_member_ids"], json!([analyst_id]));
    let old_analyst = agent_says(&env, &crew, &session(&crew.analyst), "first look");
    let by_writer = agent_says(&env, &crew, &session(&writer), "a draft");
    let by_general = agent_says(&env, &crew, &session(&crew.general), "noted");
    let stranger = env
        .agents
        .create_conversation(&env.project, AgentId::OpenCode, Some("chat"))
        .unwrap()
        .id;
    let by_stranger = agent_says(&env, &crew, &stranger, "who am I");
    let (note, _) = env
        .state
        .channels
        .post(
            &env.project,
            &crew.channel,
            NewMessage {
                body: "a note",
                author_kind: Some(AuthorKind::System),
                ..Default::default()
            },
        )
        .unwrap();

    // The Analyst gets a new Session and keeps writing from it.
    let (status, replaced) = call(
        &env,
        Method::POST,
        &format!("{members}/{analyst_id}/session"),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    assert_ne!(session(&replaced), session(&crew.analyst));
    let new_analyst = agent_says(&env, &crew, &session(&replaced), "second look");

    let messages = format!(
        "/projects/{}/channels/{}/messages",
        env.project, crew.channel
    );
    let author_of = |page: &Value, message: &str| -> Value {
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == message)
            .unwrap_or_else(|| panic!("{message} is listed: {page}"))["author_member_id"]
            .clone()
    };
    let (status, page) = call(&env, Method::GET, &messages, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(author_of(&page, &old_analyst), json!(analyst_id));
    assert_eq!(author_of(&page, &new_analyst), json!(analyst_id));
    assert_eq!(author_of(&page, &by_writer), json!(writer_id));
    assert_eq!(author_of(&page, &by_general), json!(general_id));
    assert_eq!(author_of(&page, &by_stranger), Value::Null);
    assert_eq!(author_of(&page, &note.id), Value::Null);
    assert_eq!(
        author_of(&page, mention["id"].as_str().unwrap()),
        Value::Null
    );
    let listed = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == mention["id"])
        .unwrap();
    assert_eq!(listed["mention_member_ids"], json!([analyst_id]));
    assert_eq!(page["has_more"], false);

    // One message by id carries the same projection.
    let (status, one) = call(
        &env,
        Method::GET,
        &format!("{messages}/{old_analyst}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{one}");
    assert_eq!(one["author_member_id"], json!(analyst_id));
    assert_eq!(one["mention_member_ids"], json!([]));

    // A removed member keeps its name in history.
    let (status, removed) = call(
        &env,
        Method::DELETE,
        &format!("{members}/{writer_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{removed}");
    let (_, page) = call(&env, Method::GET, &messages, Value::Null).await;
    assert_eq!(author_of(&page, &by_writer), json!(writer_id));
    let (_, roster) = call(
        &env,
        Method::GET,
        &format!("{members}?include_removed=true"),
        Value::Null,
    )
    .await;
    assert!(
        roster["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == json!(writer_id) && m["state"] == "removed"),
        "{roster}"
    );
}

fn messages_path(env: &Env, crew: &Crew) -> String {
    format!(
        "/projects/{}/channels/{}/messages",
        env.project, crew.channel
    )
}

#[tokio::test]
async fn a_mention_by_member_id_reaches_that_members_current_session() {
    let env = env();
    let crew = crew(&env).await;
    let analyst_id = crew.analyst["id"].as_str().unwrap().to_owned();
    let messages = messages_path(&env, &crew);
    let request = json!({
        "body": "@analyst run the sweep",
        "client_message_id": "member-mention-1",
        "mentions": [{"member_id": analyst_id}, {"member_id": analyst_id}],
    });
    let (status, posted) = call(&env, Method::POST, &messages, request.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{posted}");
    // Stored in its Session form, once, and shown as the member.
    assert_eq!(
        posted["mentions"],
        json!([{"session_id": session(&crew.analyst)}])
    );
    assert_eq!(posted["mention_member_ids"], json!([analyst_id]));
    let sink = Recording::default();
    env.state.orchestrator.tick(&sink).unwrap();
    let delivered = sink.to();
    assert_eq!(delivered.len(), 1, "{delivered:?}");
    assert_eq!(delivered[0].0, session(&crew.analyst));

    // A retry after the member's Session was replaced is the same message.
    let (status, replaced) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/members/{analyst_id}/session", env.project),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    let (status, replay) = call(&env, Method::POST, &messages, request).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["id"], posted["id"]);
    let (_, page) = call(&env, Method::GET, &messages, Value::Null).await;
    assert_eq!(page["messages"].as_array().unwrap().len(), 1, "{page}");

    // A new message reaches the member's new Session.
    let (status, fresh) = call(
        &env,
        Method::POST,
        &messages,
        json!({"body": "@analyst again", "mentions": [{"member_id": analyst_id}]}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{fresh}");
    assert_eq!(
        fresh["mentions"],
        json!([{"session_id": session(&replaced)}])
    );
    assert_eq!(fresh["mention_member_ids"], json!([analyst_id]));
}

#[tokio::test]
async fn a_mention_of_a_member_who_cannot_receive_is_refused() {
    let env = env();
    let crew = crew(&env).await;
    let messages = messages_path(&env, &crew);
    let members = format!("/projects/{}/members", env.project);
    let (_, writer) = call(
        &env,
        Method::POST,
        &members,
        json!({"name": "Writer", "template": "writing"}),
    )
    .await;
    let writer_id = writer["id"].as_str().unwrap().to_owned();
    let (status, _) = call(
        &env,
        Method::DELETE,
        &format!("{members}/{writer_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let analyst_id = crew.analyst["id"].as_str().unwrap().to_owned();
    env.state
        .members
        .record_setup_error(&analyst_id, "the provider refused the model")
        .unwrap();
    // A member of another Workspace is not found here.
    let (_, elsewhere) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/members", env.other_project),
        Value::Null,
    )
    .await;
    let foreign = elsewhere["members"][0]["id"].as_str().unwrap().to_owned();

    for (member, reason) in [
        (writer_id.as_str(), "removed"),
        (analyst_id.as_str(), "needs_setup"),
        ("no-such-member", "not_found"),
        (foreign.as_str(), "not_found"),
    ] {
        let (status, body) = call(
            &env,
            Method::POST,
            &messages,
            json!({"body": "hello", "mentions": [{"member_id": member}]}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{member}: {body}");
        assert_eq!(body["code"], "mention_unavailable", "{body}");
        assert_eq!(body["reason"], reason, "{body}");
        assert_eq!(body["member_id"], member, "{body}");
    }
    let (_, page) = call(&env, Method::GET, &messages, Value::Null).await;
    assert!(
        page["messages"].as_array().unwrap().is_empty(),
        "nothing is stored: {page}"
    );
}

#[tokio::test]
async fn a_mention_must_name_a_member_or_a_session() {
    let env = env();
    let crew = crew(&env).await;
    let messages = messages_path(&env, &crew);
    let analyst_id = crew.analyst["id"].as_str().unwrap();
    for mention in [
        json!({"member_id": analyst_id, "session_id": session(&crew.analyst)}),
        json!({}),
    ] {
        let (status, body) = call(
            &env,
            Method::POST,
            &messages,
            json!({"body": "hello", "mentions": [mention]}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "invalid_conversation", "{body}");
    }
    // The legacy Session form still works.
    say(&env, &crew, "@analyst hi", &[&session(&crew.analyst)]).await;
}

#[tokio::test]
async fn deliveries_are_read_by_message_and_listed_on_researcher_messages_only() {
    let env = env();
    let crew = crew(&env).await;
    let hello = say(&env, &crew, "hello", &[]).await;
    let id = hello["id"].as_str().unwrap().to_owned();
    let deliveries = format!("/projects/{}/deliveries", env.project);
    let (status, saved) = call(
        &env,
        Method::GET,
        &format!("{deliveries}?message_ids={id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved[0]["message_id"], json!(id));
    assert_eq!(saved[0]["state"], "saved");

    let sink = Recording::default();
    env.state.orchestrator.tick(&sink).unwrap();
    env.state.orchestrator.tick(&sink).unwrap();
    let (_, delivered) = call(
        &env,
        Method::GET,
        &format!("{deliveries}?message_ids={id}"),
        Value::Null,
    )
    .await;
    assert_eq!(delivered[0]["state"], "delivered", "{delivered}");
    assert_eq!(delivered[0]["routes"][0]["kind"], "discussion");
    assert_eq!(delivered[0]["routes"][0]["recipient"]["handle"], "general");

    // The page carries the delivery of the researcher's messages only.
    let by_agent = agent_says(&env, &crew, &session(&crew.analyst), "a report");
    let (_, page) = call(&env, Method::GET, &messages_path(&env, &crew), Value::Null).await;
    assert_eq!(page["deliveries"][&id]["state"], "delivered", "{page}");
    assert!(page["deliveries"].get(&by_agent).is_none(), "{page}");
    assert_eq!(page["messages"].as_array().unwrap().len(), 2);

    // Bounded, well-formed ids only.
    let many = (0..101)
        .map(|n| format!("m{n}"))
        .collect::<Vec<_>>()
        .join(",");
    for query in [many.as_str(), "a%20b", "..%2Fx", ""] {
        let (status, body) = call(
            &env,
            Method::GET,
            &format!("{deliveries}?message_ids={query}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["code"], "invalid_request");
    }
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("/projects/nope/deliveries?message_ids={id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// A sink whose deliveries all fail.
struct Failing;

impl RouteSink for Failing {
    fn deliver(&self, _request: &DeliveryRequest<'_>) -> DeliveryOutcome {
        DeliveryOutcome::Failed("provider unavailable".into())
    }
}

/// Runs delivery until every due route has used its attempts.
fn exhaust(env: &Env) {
    for step in 0..10 {
        env.state
            .orchestrator
            .deliver_due(&Failing, 1_000_000 * (step + 1))
            .unwrap();
    }
}

#[tokio::test]
async fn the_researcher_retries_a_failed_delivery_over_http() {
    let env = env();
    let crew = crew(&env).await;
    let hello = say(&env, &crew, "hello", &[]).await;
    env.state.orchestrator.route_conversation().unwrap();
    exhaust(&env);
    let routes = format!("/projects/{}/routes", env.project);
    let (_, listed) = call(&env, Method::GET, &routes, Value::Null).await;
    let route = listed
        .as_array()
        .or_else(|| listed["routes"].as_array())
        .unwrap()
        .iter()
        .find(|route| route["source_id"] == hello["id"])
        .unwrap()
        .clone();
    assert_eq!(route["state"], "failed", "{route}");
    let retry = format!("{routes}/{}/retry", route["id"].as_str().unwrap());
    let (status, body) = call(&env, Method::POST, &retry, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["retried"], true);
    assert_eq!(body["route"]["retries"], 1);
    assert_eq!(body["delivery"]["state"], "sending");
    let (status, body) = call(&env, Method::POST, &retry, Value::Null).await;
    assert_eq!(
        (status, body["retried"].as_bool()),
        (StatusCode::OK, Some(false))
    );
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{routes}/missing/retry"),
        Value::Null,
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("route_not_found"))
    );

    // A mention of a member removed since cannot be retried.
    let (_, writer) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/members", env.project),
        json!({"name": "Writer", "template": "writing"}),
    )
    .await;
    let to_writer = say(&env, &crew, "@writer draft it", &[&session(&writer)]).await;
    env.state.orchestrator.route_conversation().unwrap();
    call(
        &env,
        Method::DELETE,
        &format!(
            "/projects/{}/members/{}",
            env.project,
            writer["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    exhaust(&env);
    let (_, listed) = call(&env, Method::GET, &routes, Value::Null).await;
    let gone = listed
        .as_array()
        .or_else(|| listed["routes"].as_array())
        .unwrap()
        .iter()
        .find(|route| route["source_id"] == to_writer["id"])
        .unwrap()
        .clone();
    assert_eq!(gone["state"], "failed");
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{routes}/{}/retry", gone["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("route_target_gone")),
        "{body}"
    );

    // An agent's hand-off is not the researcher's to retry.
    let handoff = env
        .state
        .channels
        .post(
            &env.project,
            &crew.channel,
            NewMessage {
                body: "@analyst yours",
                author_kind: Some(AuthorKind::Agent),
                author_ref: Some(&session(&crew.general)),
                mentions: &[kubecode_server::channel_store::Mention {
                    session_id: session(&crew.analyst),
                }],
                hops: 1,
                ..Default::default()
            },
        )
        .unwrap()
        .0;
    env.state.orchestrator.route_conversation().unwrap();
    exhaust(&env);
    let (_, listed) = call(&env, Method::GET, &routes, Value::Null).await;
    let agent_route = listed
        .as_array()
        .or_else(|| listed["routes"].as_array())
        .unwrap()
        .iter()
        .find(|route| route["source_id"] == json!(handoff.id))
        .unwrap()
        .clone();
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{routes}/{}/retry", agent_route["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("route_not_retryable"))
    );

    // Past the limit.
    env.agents
        .database()
        .lock()
        .unwrap()
        .execute(
            "UPDATE message_routes SET state = 'failed', retries = 3 WHERE id = ?1",
            [route["id"].as_str().unwrap()],
        )
        .unwrap();
    let (status, body) = call(&env, Method::POST, &retry, Value::Null).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("retry_limit"))
    );
}

#[tokio::test]
async fn a_denied_message_is_rerouted_once_the_member_is_set_up() {
    let env = env();
    let crew = crew(&env).await;
    let analyst_id = crew.analyst["id"].as_str().unwrap().to_owned();
    env.state
        .members
        .record_setup_error(&analyst_id, "the provider refused the model")
        .unwrap();
    let ask = say(&env, &crew, "@analyst look", &[&session(&crew.analyst)]).await;
    let id = ask["id"].as_str().unwrap().to_owned();
    env.state.orchestrator.route_conversation().unwrap();
    let (_, page) = call(&env, Method::GET, &messages_path(&env, &crew), Value::Null).await;
    let delivery = &page["deliveries"][&id];
    assert_eq!(delivery["state"], "denied", "{page}");
    assert_eq!(delivery["denial"]["code"], "member_unavailable");
    assert_eq!(delivery["denial"]["reroutable"], true);

    env.state
        .members
        .finish_setup(&env.project, &analyst_id, &|_| true)
        .unwrap();
    let reroute = format!("{}/{id}/reroute", messages_path(&env, &crew));
    let (status, rerouted) = call(&env, Method::POST, &reroute, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{rerouted}");
    assert_eq!(rerouted["state"], "saved");
    env.state.orchestrator.route_conversation().unwrap();
    let (_, page) = call(&env, Method::GET, &messages_path(&env, &crew), Value::Null).await;
    assert_eq!(page["deliveries"][&id]["state"], "sending", "{page}");
    assert_eq!(
        page["deliveries"][&id]["routes"][0]["recipient"]["handle"],
        "analyst"
    );

    // Routed now, it is not rerouted again; an unknown message is not found.
    let (status, body) = call(&env, Method::POST, &reroute, Value::Null).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::CONFLICT, Some("message_not_reroutable")),
        "{body}"
    );
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{}/missing/reroute", messages_path(&env, &crew)),
        Value::Null,
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("message_not_found"))
    );
}

#[tokio::test]
async fn a_dm_reports_its_admission_and_queued_text_stays_visible() {
    let env = env();
    let crew = crew(&env).await;
    let analyst_id = crew.analyst["id"].as_str().unwrap().to_owned();
    let base = format!("/projects/{}/members/{analyst_id}/dm", env.project);
    let (_, opened) = call(&env, Method::POST, &base, Value::Null).await;
    let dm = opened["dm_conversation_id"].as_str().unwrap().to_owned();
    // A turn that already started under this key (a retry after a lost reply).
    let started = env
        .agents
        .start_run_with_client_message_id(
            &dm,
            &env.project,
            "[Role brief]\nYou are the Analyst.\n[End of role brief]\nfirst question",
            PermissionMode::Safe,
            Some(&format!("route:dm:k1:{dm}")),
        )
        .unwrap();
    let (status, sent) = call(
        &env,
        Method::POST,
        &format!("{base}/messages"),
        json!({"text": "first question", "client_message_id": "k1"}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{sent}");
    assert_eq!(sent["state"], "delivered");
    assert_eq!(sent["admission"], "started");
    // A message queued behind that running turn stays visible, without the brief.
    env.agents
        .start_prompt_or_enqueue(
            &dm,
            &env.project,
            "[Role brief]\nYou are the Analyst.\n[End of role brief]\nsecond question",
            PermissionMode::Safe,
            false,
            Some(&format!("route:dm:k2:{dm}")),
        )
        .unwrap();
    let (status, pending) = call(&env, Method::GET, &format!("{base}/pending"), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{pending}");
    let pending = pending.as_array().unwrap();
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert_eq!(pending[0]["client_message_id"], "k2");
    assert_eq!(pending[0]["text"], "second question");
    assert_eq!(pending[0]["position"], 1);
    let _ = started;
}
