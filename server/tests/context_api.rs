//! Project context API tests (#174) under a non-root base path: discovery,
//! progressive reads, Project scoping, revision-aware resolution, and the
//! guarantee that reading leaves every store untouched.

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
    _root: TempDir,
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
        _root: root,
        app,
        project_id: project.id,
        other_project_id: other.id,
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
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, value)
}

async fn create_research(env: &Env, title: &str) -> Value {
    let (status, body) = call(
        env,
        Method::POST,
        &format!("/projects/{}/research", env.project_id),
        json!({"title": title, "question": "Does pruning keep accuracy within one percent?"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}

#[tokio::test]
async fn search_read_and_resolve_a_research_question() {
    let env = env();
    let created = create_research(&env, "Structured pruning").await;
    let id = created["id"].as_str().unwrap();
    let base = format!("/projects/{}/context", env.project_id);

    let (status, page) = call(
        &env,
        Method::GET,
        &format!("{base}/search?q=pruning&kinds=research"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"][0]["ref"]["kind"], "research");
    assert_eq!(page["items"][0]["ref"]["id"], id);
    assert_eq!(page["items"][0]["ref"]["revision"], "1");
    assert_eq!(page["items"][0]["availability"], "available");

    let (status, doc) = call(
        &env,
        Method::GET,
        &format!("{base}/read?kind=research&id={id}&detail=content"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{doc}");
    assert_eq!(doc["detail"], "content");
    assert!(doc["sections"].as_array().unwrap().len() >= 2);

    let (status, resolved) = call(
        &env,
        Method::POST,
        &format!("{base}/resolve"),
        json!({"refs": [{"kind": "research", "id": id, "revision": "1"}, {"kind": "session", "id": "missing"}]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved[0]["availability"], "available");
    assert_eq!(resolved[1]["availability"], "removed");

    // A brief edit makes the pinned revision `changed`.
    let (status, _) = call(
        &env,
        Method::PATCH,
        &format!("/projects/{}/research/{id}", env.project_id),
        json!({"expected_revision": 1, "title": "Structured pruning v2"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, resolved) = call(
        &env,
        Method::POST,
        &format!("{base}/resolve"),
        json!({"refs": [{"kind": "research", "id": id, "revision": "1"}]}),
    )
    .await;
    assert_eq!(resolved[0]["availability"], "changed");
    assert_eq!(resolved[0]["current_revision"], "2");
}

#[tokio::test]
async fn another_project_sees_nothing_and_unknown_projects_404() {
    let env = env();
    let created = create_research(&env, "Private").await;
    let id = created["id"].as_str().unwrap();
    let other = format!("/projects/{}/context", env.other_project_id);

    let (_, page) = call(&env, Method::GET, &format!("{other}/search"), Value::Null).await;
    assert!(page["items"].as_array().unwrap().is_empty());
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("{other}/read?kind=research&id={id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = call(
        &env,
        Method::GET,
        "/projects/nope/context/search",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[tokio::test]
async fn malformed_requests_are_rejected_not_guessed() {
    let env = env();
    let base = format!("/projects/{}/context", env.project_id);
    for path in [
        format!("{base}/search?kinds=research,bogus"),
        format!("{base}/search?cursor=%25%25"),
        format!("{base}/read?kind=bogus&id=x"),
        format!("{base}/read?kind=research&id=x&detail=everything"),
    ] {
        let (status, body) = call(&env, Method::GET, &path, Value::Null).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
        assert_eq!(body["error"]["code"], "invalid_context_request");
    }
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{base}/resolve"),
        json!({"refs": 5}),
    )
    .await;
    assert!(status.is_client_error());
    let too_many: Vec<Value> = (0..40)
        .map(|i| json!({"kind": "session", "id": i.to_string()}))
        .collect();
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{base}/resolve"),
        json!({"refs": too_many}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn reading_does_not_write() {
    let env = env();
    let created = create_research(&env, "Passive").await;
    let id = created["id"].as_str().unwrap();
    let base = format!("/projects/{}/context", env.project_id);
    let (_, before) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/research/{id}", env.project_id),
        Value::Null,
    )
    .await;
    for _ in 0..3 {
        call(&env, Method::GET, &format!("{base}/search"), Value::Null).await;
        call(
            &env,
            Method::GET,
            &format!("{base}/read?kind=research&id={id}&detail=evidence"),
            Value::Null,
        )
        .await;
    }
    let (_, after) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/research/{id}", env.project_id),
        Value::Null,
    )
    .await;
    assert_eq!(before, after);
    let (_, entries) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/research/{id}/entries", env.project_id),
        Value::Null,
    )
    .await;
    assert!(
        entries["entries"]
            .as_array()
            .is_none_or(|list| list.is_empty()),
        "{entries}"
    );
}
