//! Workspace conversation API tests (#187) under a non-root base path: the
//! default channel, replay-safe posting, pagination, Threads, linking a Thread
//! to a research question without losing the conversation, Project scoping,
//! and the guarantee that authorship comes from the server, not the request.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_store::AgentStore;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::teams::TeamStore;
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE: &str = "/user/alice/kubecode";

struct Env {
    root: TempDir,
    app: Router,
    project_id: String,
    other_project_id: String,
}

fn env() -> Env {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace.create_project(".", "alpha").expect("alpha");
    let other = workspace.create_project(".", "beta").expect("beta");
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let app = app_router(AppState::new(workspace, agents, teams), BASE);
    Env {
        root,
        app,
        project_id: project.id,
        other_project_id: other.id,
    }
}

/// A new process on the same state directory: every store reopened.
fn restart(env: &mut Env) {
    let database = env.root.path().join(".state/kubecode/kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(env.root.path(), &database).expect("workspace"));
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    env.app = app_router(AppState::new(workspace, agents, teams), BASE);
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

async fn default_channel(env: &Env) -> String {
    let (status, channels) = call(
        env,
        Method::GET,
        &format!("/projects/{}/channels", env.project_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(channels.as_array().unwrap().len(), 1);
    assert_eq!(channels[0]["is_default"], true);
    channels[0]["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn discussion_survives_a_restart_replays_safely_and_pages() {
    let mut env = env();
    let channel = default_channel(&env).await;
    let messages = format!("/projects/{}/channels/{channel}/messages", env.project_id);
    let (status, first) = call(
        &env,
        Method::POST,
        &messages,
        json!({"body": "Should we prune?", "client_message_id": "c-1", "author_kind": "agent"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        first["author_kind"], "researcher",
        "authorship is the server's"
    );
    restart(&mut env);
    assert_eq!(
        default_channel(&env).await,
        channel,
        "same channel after a restart"
    );
    let (status, replay) = call(
        &env,
        Method::POST,
        &messages,
        json!({"body": "Should we prune?", "client_message_id": "c-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay["id"], first["id"]);
    let (status, error) = call(
        &env,
        Method::POST,
        &messages,
        json!({"body": "different", "client_message_id": "c-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["code"], "message_key_reused");
    for n in 2..=4 {
        call(
            &env,
            Method::POST,
            &messages,
            json!({"body": format!("message {n}")}),
        )
        .await;
    }
    let (_, latest) = call(
        &env,
        Method::GET,
        &format!("{messages}?limit=2"),
        Value::Null,
    )
    .await;
    assert_eq!(latest["messages"].as_array().unwrap().len(), 2);
    assert_eq!(latest["has_more"], true);
    let first_seq = latest["messages"][0]["seq"].as_u64().unwrap();
    let (_, older) = call(
        &env,
        Method::GET,
        &format!("{messages}?limit=10&before_seq={first_seq}"),
        Value::Null,
    )
    .await;
    assert_eq!(older["messages"].as_array().unwrap().len(), 2);
    assert_eq!(older["has_more"], false);
    let (status, empty) = call(&env, Method::POST, &messages, json!({"body": "   "})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(empty["code"], "invalid_conversation");
}

#[tokio::test]
async fn a_thread_becomes_a_research_thread_without_replacing_the_conversation() {
    let env = env();
    let channel = default_channel(&env).await;
    let (_, root) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/channels/{channel}/messages", env.project_id),
        json!({"body": "Pruning attention heads?"}),
    )
    .await;
    let threads = format!("/projects/{}/channels/{channel}/threads", env.project_id);
    let (status, thread) = call(
        &env,
        Method::POST,
        &threads,
        json!({"root_message_id": root["id"]}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, again) = call(
        &env,
        Method::POST,
        &threads,
        json!({"root_message_id": root["id"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["id"], thread["id"]);
    let thread_id = thread["id"].as_str().unwrap();
    // Thread posts and legacy intents stay accepted for pages opened before
    // the browser stopped offering them (ADR 0229 §5), and their answers carry
    // the member identity fields old pages ignore.
    let (status, reply) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/channels/{channel}/messages", env.project_id),
        json!({"body": "Start with magnitude pruning", "thread_id": thread_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{reply}");
    assert_eq!(reply["author_member_id"], Value::Null);
    assert_eq!(reply["mention_member_ids"], json!([]));
    let (status, request) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/channels/{channel}/messages", env.project_id),
        json!({"body": "Please organize this", "intent": "request"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{request}");
    assert_eq!(request["intent"], "request");
    assert_eq!(request["mention_member_ids"], json!([]));

    // Create the question and link the Thread.
    let (_, question) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/research", env.project_id),
        json!({"title": "Pruning", "question": "Does it hold?"}),
    )
    .await;
    let link = format!("/projects/{}/threads/{thread_id}/link", env.project_id);
    let (status, stale) = call(
        &env,
        Method::PUT,
        &link,
        json!({"expected_revision": 5, "research_id": question["id"]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(stale["current_revision"], 1);
    let (status, linked) = call(
        &env,
        Method::PUT,
        &link,
        json!({"expected_revision": 1, "research_id": question["id"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(linked["research_id"], question["id"]);

    // The question's Threads, and the whole conversation, are still there.
    let (_, for_question) = call(
        &env,
        Method::GET,
        &format!("{threads}?research_id={}", question["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(for_question.as_array().unwrap().len(), 1);
    let (_, in_thread) = call(
        &env,
        Method::GET,
        &format!(
            "/projects/{}/channels/{channel}/messages?thread_id={thread_id}",
            env.project_id
        ),
        Value::Null,
    )
    .await;
    let bodies: Vec<_> = in_thread["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["body"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(bodies[0], "Pruning attention heads?");
    assert_eq!(bodies[1], "Start with magnitude pruning");
    assert_eq!(in_thread["messages"][2]["kind"], "system");
    assert!(
        in_thread["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["author_member_id"].is_null() && m["mention_member_ids"].is_array()),
        "{in_thread}"
    );
}

#[tokio::test]
async fn another_project_cannot_reach_the_conversation() {
    let env = env();
    let channel = default_channel(&env).await;
    let (_, root) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/channels/{channel}/messages", env.project_id),
        json!({"body": "private"}),
    )
    .await;
    let other = &env.other_project_id;
    for (method, path, body) in [
        (
            Method::GET,
            format!("/projects/{other}/channels/{channel}/messages"),
            Value::Null,
        ),
        (
            Method::POST,
            format!("/projects/{other}/channels/{channel}/messages"),
            json!({"body": "intrusion"}),
        ),
        (
            Method::POST,
            format!("/projects/{other}/channels/{channel}/threads"),
            json!({"root_message_id": root["id"]}),
        ),
    ] {
        let (status, error) = call(&env, method, &path, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert!(
            !error.to_string().contains("private"),
            "no content leaks across Projects"
        );
    }
    let (status, _) = call(&env, Method::GET, "/projects/missing/channels", Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
