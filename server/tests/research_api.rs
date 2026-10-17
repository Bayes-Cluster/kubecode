//! Research API tests (#149) under a non-root base path: the full question
//! lifecycle, revision conflicts reported over HTTP, researcher-only entry
//! kinds, link validation (same Project, existing, not Team-owned), removed
//! targets surfacing as unavailable, Project scoping, and the guarantee that
//! none of this executes an Agent or touches Sessions and Teams.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::teams::{NewTeam, TeamStore, TeamWorkspace};
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE: &str = "/user/alice/kubecode";

struct Env {
    _root: TempDir,
    app: Router,
    agents: Arc<AgentStore>,
    teams: Arc<TeamStore>,
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
    let app = app_router(
        AppState::new(workspace, Arc::clone(&agents), Arc::clone(&teams)),
        BASE,
    );
    Env {
        _root: root,
        app,
        agents,
        teams,
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
        serde_json::from_slice(&bytes).expect("json")
    };
    (status, value)
}

fn base_path(env: &Env) -> String {
    format!("/projects/{}/research", env.project_id)
}

async fn create(env: &Env, title: &str) -> Value {
    let (status, body) = call(
        env,
        Method::POST,
        &base_path(env),
        json!({
            "title": title,
            "question": "Does pruning keep accuracy?",
            "hypotheses": ["H1"],
            "constraints": ["single GPU"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}

#[tokio::test]
async fn the_question_lifecycle_works_end_to_end_without_running_anything() {
    let env = env();
    let created = create(&env, "Pruning").await;
    let id = created["id"].as_str().expect("id").to_owned();
    assert_eq!(created["revision"], 1);
    assert_eq!(created["brief"]["constraints"], json!(["single GPU"]));
    assert_eq!(created["links"], json!([]));

    let (status, listed) = call(&env, Method::GET, &base_path(&env), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed[0]["title"], "Pruning");
    assert_eq!(listed[0]["entry_count"], 0);

    // Edit under a revision check; the revision history keeps both.
    let item = format!("{}/{id}", base_path(&env));
    let (status, edited) = call(
        &env,
        Method::PATCH,
        &item,
        json!({"expected_revision": 1, "title": "Pruning v2", "note": "narrowed"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        (edited["revision"].clone(), edited["brief"]["title"].clone()),
        (json!(2), json!("Pruning v2"))
    );
    let (_, revisions) = call(&env, Method::GET, &format!("{item}/revisions"), Value::Null).await;
    assert_eq!(revisions.as_array().expect("revs").len(), 2);
    assert_eq!(revisions[0]["note"], "narrowed");
    let (status, first) = call(
        &env,
        Method::GET,
        &format!("{item}/revisions/1"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["brief"]["title"], "Pruning");
    let (status, missing) = call(
        &env,
        Method::GET,
        &format!("{item}/revisions/9"),
        Value::Null,
    )
    .await;
    assert_eq!(
        (status, missing["code"].clone()),
        (StatusCode::NOT_FOUND, json!("research_revision_not_found"))
    );

    // Researcher entries.
    let (status, entry) = call(
        &env,
        Method::POST,
        &format!("{item}/entries"),
        json!({"kind": "decision", "body": "Drop approach B", "client_request_id": "d1"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        (
            entry["seq"].clone(),
            entry["author_kind"].clone(),
            entry["brief_revision"].clone()
        ),
        (json!(1), json!("researcher"), json!(2))
    );
    let (_, entries) = call(
        &env,
        Method::GET,
        &format!("{item}/entries?after_seq=0&limit=10"),
        Value::Null,
    )
    .await;
    assert_eq!(entries.as_array().expect("entries").len(), 1);

    // Status and archive commands are idempotent and non-destructive.
    for (action, field, expected) in [
        ("resolve", "status", json!("resolved")),
        ("resolve", "status", json!("resolved")),
        ("reopen", "status", json!("open")),
        ("archive", "archived", json!(true)),
        ("archive", "archived", json!(true)),
    ] {
        let (status, body) =
            call(&env, Method::POST, &format!("{item}/{action}"), Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{action}: {body}");
        assert_eq!(body[field], expected, "{action}");
    }
    let (_, default_list) = call(&env, Method::GET, &base_path(&env), Value::Null).await;
    assert_eq!(default_list, json!([]));
    let (_, full_list) = call(
        &env,
        Method::GET,
        &format!("{}?archived=true", base_path(&env)),
        Value::Null,
    )
    .await;
    assert_eq!(full_list.as_array().expect("list").len(), 1);
    let (status, blocked) = call(
        &env,
        Method::PATCH,
        &item,
        json!({"expected_revision": 2, "title": "No"}),
    )
    .await;
    assert_eq!(
        (status, blocked["code"].clone()),
        (StatusCode::CONFLICT, json!("research_archived"))
    );
    let (status, restored) =
        call(&env, Method::POST, &format!("{item}/restore"), Value::Null).await;
    assert_eq!(
        (status, restored["archived"].clone()),
        (StatusCode::OK, json!(false))
    );
    assert_eq!(
        restored["revision"], 2,
        "state commands never create revisions"
    );

    // Nothing above executed an Agent.
    assert!(
        env.agents
            .list_all_conversations()
            .expect("sessions")
            .is_empty()
    );
}

#[tokio::test]
async fn revision_conflicts_name_the_current_revision() {
    let env = env();
    let created = create(&env, "Race").await;
    let item = format!(
        "{}/{}",
        base_path(&env),
        created["id"].as_str().expect("id")
    );
    call(
        &env,
        Method::PATCH,
        &item,
        json!({"expected_revision": 1, "title": "Winner"}),
    )
    .await;
    let (status, conflict) = call(
        &env,
        Method::PATCH,
        &item,
        json!({"expected_revision": 1, "title": "Loser"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "research_revision_conflict");
    assert_eq!(conflict["current_revision"], 2);
    let (_, current) = call(&env, Method::GET, &item, Value::Null).await;
    assert_eq!(current["brief"]["title"], "Winner");
}

#[tokio::test]
async fn creation_is_idempotent_and_validated() {
    let env = env();
    let body = json!({"title": "Once", "question": "Why?", "client_request_id": "req-1"});
    let (first, created) = call(&env, Method::POST, &base_path(&env), body.clone()).await;
    let (second, replay) = call(&env, Method::POST, &base_path(&env), body).await;
    assert_eq!((first, second), (StatusCode::CREATED, StatusCode::OK));
    assert_eq!(created["id"], replay["id"]);
    let (status, invalid) = call(
        &env,
        Method::POST,
        &base_path(&env),
        json!({"title": "", "question": "Why?"}),
    )
    .await;
    assert_eq!(
        (status, invalid["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_research"))
    );
}

#[tokio::test]
async fn only_researcher_entry_kinds_are_accepted_from_the_browser() {
    let env = env();
    let created = create(&env, "Entries").await;
    let item = format!(
        "{}/{}",
        base_path(&env),
        created["id"].as_str().expect("id")
    );
    for kind in ["proposal", "observation"] {
        let (status, body) = call(
            &env,
            Method::POST,
            &format!("{item}/entries"),
            json!({"kind": kind, "body": "Agents found something"}),
        )
        .await;
        assert_eq!(
            (status, body["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("invalid_research")),
            "{kind}"
        );
    }
    let (status, note) = call(
        &env,
        Method::POST,
        &format!("{item}/entries"),
        json!({"kind": "note", "body": "A thought", "author_kind": "agent"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        note["author_kind"], "researcher",
        "attribution cannot be supplied by the client"
    );
}

#[tokio::test]
async fn links_are_validated_unique_and_report_removed_targets() {
    let env = env();
    let first = create(&env, "First").await;
    let second = create(&env, "Second").await;
    let first_item = format!("{}/{}", base_path(&env), first["id"].as_str().expect("id"));
    let second_item = format!("{}/{}", base_path(&env), second["id"].as_str().expect("id"));
    let session = env
        .agents
        .create_conversation(&env.project_id, AgentId::OpenCode, Some("Discuss pruning"))
        .expect("session");
    let foreign = env
        .agents
        .create_conversation(&env.other_project_id, AgentId::OpenCode, Some("Elsewhere"))
        .expect("foreign");

    // Linking never starts anything and reports the target.
    let (status, linked) = call(
        &env,
        Method::POST,
        &format!("{first_item}/links"),
        json!({"kind": "session", "ref_id": session.id, "role": "discussion"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{linked}");
    assert_eq!(linked["links"][0]["availability"], "available");
    assert_eq!(linked["links"][0]["title"], "Discuss pruning");
    assert!(env.agents.list_runs(&session.id).expect("runs").is_empty());

    // Cross-Project, unknown, and already-linked targets are rejected.
    for (ref_id, expected_status, code) in [
        (
            foreign.id.as_str(),
            StatusCode::BAD_REQUEST,
            "invalid_research_link",
        ),
        (
            "no-such-session",
            StatusCode::BAD_REQUEST,
            "invalid_research_link",
        ),
    ] {
        let (status, body) = call(
            &env,
            Method::POST,
            &format!("{first_item}/links"),
            json!({"kind": "session", "ref_id": ref_id, "role": "discussion"}),
        )
        .await;
        assert_eq!(
            (status, body["code"].clone()),
            (expected_status, json!(code)),
            "{ref_id}"
        );
    }
    let (status, conflict) = call(
        &env,
        Method::POST,
        &format!("{second_item}/links"),
        json!({"kind": "session", "ref_id": session.id, "role": "execution"}),
    )
    .await;
    assert_eq!(
        (status, conflict["code"].clone()),
        (StatusCode::CONFLICT, json!("research_link_conflict"))
    );

    // A Team in the same Project links; a Team-owned Session does not.
    let leader = env
        .agents
        .create_conversation(&env.project_id, AgentId::Codex, Some("Leader"))
        .expect("leader");
    let team = env
        .teams
        .create_team(NewTeam {
            project_id: &env.project_id,
            leader_conversation_id: &leader.id,
            agent_session_id: &leader.agent_session_id,
            leader_name: "Lead",
            title: Some("Pruning team"),
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    let (status, with_team) = call(
        &env,
        Method::POST,
        &format!("{first_item}/links"),
        json!({"kind": "team", "ref_id": team.id, "role": "execution"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{with_team}");
    let team_link = with_team["links"]
        .as_array()
        .expect("links")
        .iter()
        .find(|link| link["kind"] == "team")
        .expect("team link");
    assert_eq!(team_link["title"], "Pruning team");
    let (status, owned) = call(
        &env,
        Method::POST,
        &format!("{second_item}/links"),
        json!({"kind": "session", "ref_id": leader.id, "role": "discussion"}),
    )
    .await;
    assert_eq!(
        (status, owned["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_research_link"))
    );

    // Removing the Session locally leaves the research record, flagged.
    env.agents
        .delete_conversation(&session.id)
        .expect("delete session");
    let (_, after) = call(&env, Method::GET, &first_item, Value::Null).await;
    let session_link = after["links"]
        .as_array()
        .expect("links")
        .iter()
        .find(|link| link["kind"] == "session")
        .expect("session link");
    assert_eq!(session_link["availability"], "removed");
    assert_eq!(session_link["title"], Value::Null);

    // Unlink is non-destructive: the Team still exists.
    let (status, unlinked) = call(
        &env,
        Method::DELETE,
        &format!("{first_item}/links/team/{}", team.id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        unlinked["links"]
            .as_array()
            .expect("links")
            .iter()
            .all(|link| link["kind"] != "team")
    );
    assert!(env.teams.get_team(&team.id).is_ok());
}

#[tokio::test]
async fn projects_are_isolated_and_unknown_ones_are_not_found() {
    let env = env();
    let created = create(&env, "Private").await;
    let id = created["id"].as_str().expect("id");
    let (status, foreign) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/research/{id}", env.other_project_id),
        Value::Null,
    )
    .await;
    assert_eq!(
        (status, foreign["code"].clone()),
        (StatusCode::NOT_FOUND, json!("research_not_found"))
    );
    let (_, other_list) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/research?archived=true", env.other_project_id),
        Value::Null,
    )
    .await;
    assert_eq!(other_list, json!([]));
    let (status, unknown) = call(
        &env,
        Method::GET,
        "/projects/no-such-project/research",
        Value::Null,
    )
    .await;
    assert_eq!(
        (status, unknown["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    // Link validation never reveals whether a target exists for an unknown id.
    let (status, hidden) = call(
        &env,
        Method::POST,
        &format!("{}/no-such-rq/links", base_path(&env)),
        json!({"kind": "session", "ref_id": "anything", "role": "discussion"}),
    )
    .await;
    assert_eq!(
        (status, hidden["code"].clone()),
        (StatusCode::NOT_FOUND, json!("research_not_found"))
    );
}
