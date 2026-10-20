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
    // A file path outside the Project, or inside Git, is simply not there.
    for id in ["..%2Fx", "%2Fetc%2Fpasswd", ".git%2Fconfig"] {
        let (status, body) = call(
            &env,
            Method::GET,
            &format!("{base}/read?kind=file&id={id}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{id}: {body}");
    }
    // A forged file cursor is refused rather than guessed at.
    std::fs::write(env._root.path().join("alpha/notes.md"), "notes").unwrap();
    let (status, body) = call(
        &env,
        Method::GET,
        &format!("{base}/read?kind=file&id=notes.md&cursor=ZjoxOnh4"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
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

#[tokio::test]
async fn sessions_are_discoverable_and_pages_are_clamped_over_http() {
    let env = env();
    let (status, session) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/sessions", env.project_id),
        json!({"agent_id": "opencode", "title": "Sweep notes"}),
    )
    .await;
    assert!(status.is_success(), "{session}");
    let id = session["id"].as_str().unwrap();
    let base = format!("/projects/{}/context", env.project_id);
    let (_, page) = call(
        &env,
        Method::GET,
        &format!("{base}/search?q=sweep&kinds=session&limit=1000"),
        Value::Null,
    )
    .await;
    assert_eq!(page["items"][0]["ref"]["id"], id);
    assert_eq!(page["items"][0]["provenance"]["state"], "active");
    let (status, doc) = call(
        &env,
        Method::GET,
        &format!("{base}/read?kind=session&id={id}&detail=content"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{doc}");
    assert_eq!(doc["title"], "Sweep notes");
    // Another Project cannot read it.
    let other = format!("/projects/{}/context", env.other_project_id);
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("{other}/read?kind=session&id={id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn file_search_read_and_resolve_over_http() {
    let env = env();
    let root = env._root.path().join("alpha");
    std::fs::create_dir_all(root.join("results")).unwrap();
    let text = "model,accuracy\n".repeat(1_200);
    std::fs::write(root.join("results/summary.csv"), &text).unwrap();
    let base = format!("/projects/{}/context", env.project_id);

    let (status, page) = call(
        &env,
        Method::GET,
        &format!("{base}/search?q=summary&kinds=file"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"][0]["ref"]["kind"], "file");
    assert_eq!(page["items"][0]["ref"]["id"], "results/summary.csv");
    assert_eq!(page["items"][0]["title"], "results/summary.csv");
    assert_eq!(page["searched"], json!(["file"]));

    let mut joined = String::new();
    let mut cursor: Option<String> = None;
    let mut shown: Option<String> = None;
    loop {
        let mut path = format!("{base}/read?kind=file&id=results%2Fsummary.csv&detail=content");
        if let Some(cursor) = &cursor {
            path.push_str(&format!("&cursor={cursor}"));
        }
        let (status, doc) = call(&env, Method::GET, &path, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{doc}");
        assert_eq!(doc["availability"], "available");
        assert_eq!(doc["shown_revision"], doc["ref"]["revision"]);
        // Every page shows the same version.
        assert!(shown.is_none() || shown.as_deref() == doc["shown_revision"].as_str());
        shown = doc["shown_revision"].as_str().map(str::to_owned);
        joined.push_str(doc["sections"][0]["text"].as_str().unwrap());
        match doc["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => break,
        }
    }
    assert_eq!(joined, text);

    let (status, resolved) = call(
        &env,
        Method::POST,
        &format!("{base}/resolve"),
        json!({"refs": [
            {"kind": "file", "id": "results/summary.csv", "revision": shown},
            {"kind": "file", "id": "missing.csv"},
        ]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved[0]["availability"], "available");
    assert_eq!(resolved[0]["title"], "results/summary.csv");
    assert_eq!(resolved[1]["availability"], "removed");
    assert_eq!(resolved[1]["title"], Value::Null);
}

#[tokio::test]
async fn the_page_names_its_scope_over_http() {
    let env = env();
    create_research(&env, "Scoped pruning").await;
    std::fs::write(env._root.path().join("alpha/pruning.md"), "notes").unwrap();
    let base = format!("/projects/{}/context", env.project_id);
    let (status, page) = call(
        &env,
        Method::GET,
        &format!("{base}/search?q=pruning"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let searched = page["searched"].as_array().unwrap();
    assert!(searched.contains(&json!("research")));
    assert!(
        !searched.contains(&json!("file")),
        "files are searched only when named"
    );
    assert_eq!(page["counts"]["research"], 1);
    assert_eq!(page["truncated"], false);
    assert_eq!(page["truncated_kinds"], json!([]));
    let (_, page) = call(
        &env,
        Method::GET,
        &format!("{base}/search?q=pruning&kinds=research,file"),
        Value::Null,
    )
    .await;
    assert_eq!(page["searched"], json!(["research", "file"]));
    assert_eq!(page["counts"], json!({"research": 1, "file": 1}));
}

/// Acceptance compares the version the browser displayed with the revision the
/// server checks (ADR 0230 §4): the reads that display evidence report the
/// same revision `Evidence::current_revision` gives, and a file the reader
/// cannot display is refused even though it has a revision.
#[tokio::test]
async fn the_content_read_reports_the_revision_acceptance_checks() {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace.create_project(".", "alpha").expect("alpha").id;
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let state = AppState::new(workspace, agents, teams);
    let env = Env {
        app: app_router(state.clone(), BASE),
        _root: root,
        project_id: project.clone(),
        other_project_id: String::new(),
    };
    let evidence =
        kubecode_server::work_agent::Evidence::new(state.context.clone(), state.workspace.clone());

    // A context record: the read's own ref revision is the checked one.
    let created = create_research(&env, "Structured pruning").await;
    let id = created["id"].as_str().unwrap();
    let (status, doc) = call(
        &env,
        Method::GET,
        &format!("/projects/{project}/context/read?kind=research&id={id}&detail=content"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{doc}");
    assert_eq!(
        doc["ref"]["revision"].as_str(),
        evidence
            .current_revision(&project, "research", id)
            .as_deref()
    );
    let (title, current) = evidence.describe(&project, "research", id);
    assert_eq!(title.as_deref(), Some("Structured pruning"));
    assert_eq!(current.as_deref(), doc["ref"]["revision"].as_str());
    // Resolve names it too.
    let (_, resolved) = call(
        &env,
        Method::POST,
        &format!("/projects/{project}/context/resolve"),
        json!({"refs": [{"kind": "research", "id": id}, {"kind": "research", "id": "gone"}]}),
    )
    .await;
    assert_eq!(resolved[0]["title"], "Structured pruning");
    // A record that is gone is never named (ADR 0231 §3).
    assert_eq!(resolved[1]["title"], Value::Null, "{resolved}");

    // A text file: GET /file reports the revision the checks use.
    let path = state.workspace.project_path(&project).unwrap();
    std::fs::write(path.join("results.csv"), "ratio,accuracy\n0.5,0.91\n").unwrap();
    let (status, file) = call(
        &env,
        Method::GET,
        &format!("/projects/{project}/file?path=results.csv"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{file}");
    assert_eq!(
        file["revision"].as_str(),
        evidence
            .current_revision(&project, "file", "results.csv")
            .as_deref()
    );
    assert_eq!(
        evidence.describe(&project, "file", "results.csv"),
        (
            Some("results.csv".to_owned()),
            file["revision"].as_str().map(str::to_owned)
        )
    );
    // A file that is not text has a revision but cannot be displayed, so a
    // change to it can never be accepted at a displayed version.
    std::fs::write(path.join("weights.bin"), [0xff_u8, 0xfe, 0x00, 0x80]).unwrap();
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("/projects/{project}/file?path=weights.bin"),
        Value::Null,
    )
    .await;
    assert!(status.is_client_error(), "{status}");
    assert!(
        evidence
            .current_revision(&project, "file", "weights.bin")
            .is_some()
    );
}
