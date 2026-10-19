//! Workspace members (#201, ADR 0220) over HTTP under a non-root base path:
//! a new Workspace opens with exactly one General Agent, specialists are
//! added and removed with history intact, defaults are server state, and the
//! manager/specialist boundary holds in the work service itself.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::research_store::{NewRound, ResearchBrief, RoundKind};
use kubecode_server::teams::TeamStore;
use kubecode_server::work_agent::{AgentWorkError, LaunchSpec, NewTask, ReportStatus, WorkAgent};
use kubecode_server::work_store::{Actor, WorkError};
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
}

fn env(providers_available: bool) -> Env {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace.create_project(".", "alpha").expect("alpha");
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let mut state = AppState::new(workspace, Arc::clone(&agents), teams);
    if providers_available {
        state = state.with_agents(vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: "/bin/true".into(),
            error: None,
        }]);
    }
    let app = app_router(state.clone(), BASE);
    Env {
        _root: root,
        app,
        state,
        agents,
        project: project.id,
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

#[tokio::test]
async fn a_new_workspace_opens_with_one_general_agent_and_retries_do_not_duplicate_it() {
    let env = env(true);
    let dir = env._root.path().join("fresh-workspace");
    let (status, created) = call(
        &env,
        Method::POST,
        "/projects",
        json!({"kind": "create", "path": dir.to_string_lossy()}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let project = created["id"].as_str().unwrap().to_owned();
    let path = format!("/projects/{project}/members");
    let mut ids = Vec::new();
    for _ in 0..3 {
        let (status, roster) = call(&env, Method::GET, &path, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{roster}");
        assert_eq!(roster["members"].as_array().unwrap().len(), 1);
        let general = &roster["members"][0];
        assert_eq!(
            (general["role"].as_str(), general["state"].as_str()),
            (Some("general"), Some("active"))
        );
        assert_eq!(general["handle"], "general");
        ids.push((
            general["id"].clone(),
            general["public_conversation_id"].clone(),
        ));
        assert_eq!(roster["general_id"], general["id"]);
    }
    assert!(ids.windows(2).all(|pair| pair[0] == pair[1]), "{ids:?}");
    // The first Workspace got its own, lazily, the first time it was read.
    let (_, other) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/members", env.project),
        Value::Null,
    )
    .await;
    assert_ne!(other["members"][0]["id"], ids[0].0);
}

#[tokio::test]
async fn an_unavailable_provider_leaves_a_recoverable_setup_state_not_a_failure() {
    let env = env(false);
    let (status, roster) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/members", env.project),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let general = &roster["members"][0];
    assert_eq!(general["state"], "setup_required");
    assert!(general["public_conversation_id"].is_null());
    assert!(
        general["setup_error"]
            .as_str()
            .unwrap()
            .contains("not installed")
    );
    let id = general["id"].as_str().unwrap();
    // Retrying while still unavailable reports the same state and makes nothing.
    let (status, retried) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/members/{id}/setup", env.project),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retried["id"], general["id"]);
    assert_eq!(retried["state"], "setup_required");
}

#[tokio::test]
async fn specialists_are_added_edited_and_removed_and_the_manager_is_protected() {
    let env = env(true);
    let path = format!("/projects/{}/members", env.project);
    let (_, roster) = call(&env, Method::GET, &path, Value::Null).await;
    let general_id = roster["general_id"].as_str().unwrap().to_owned();

    let body = json!({"name": "Data Analyst", "template": "analysis", "client_request_id": "k1"});
    let (status, analyst) = call(&env, Method::POST, &path, body.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{analyst}");
    assert_eq!(analyst["handle"], "data-analyst");
    assert_eq!(analyst["state"], "active");
    let (_, replay) = call(&env, Method::POST, &path, body).await;
    assert_eq!(replay["id"], analyst["id"], "a retried add is one member");
    let (status, taken) = call(&env, Method::POST, &path, json!({"name": "data analyst"})).await;
    assert_eq!(
        (status, taken["code"].as_str()),
        (StatusCode::CONFLICT, Some("member_name_taken"))
    );

    let member_path = format!("{path}/{}", analyst["id"].as_str().unwrap());
    let revision = analyst["revision"].as_u64().unwrap();
    let (status, edited) = call(
        &env,
        Method::PATCH,
        &member_path,
        json!({"expected_revision": revision, "template": "writing"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["template"], "writing");
    let (status, stale) = call(
        &env,
        Method::PATCH,
        &member_path,
        json!({"expected_revision": revision, "name": "Nope"}),
    )
    .await;
    assert_eq!(
        (status, stale["code"].as_str()),
        (StatusCode::CONFLICT, Some("member_revision_conflict"))
    );
    assert_eq!(stale["current_revision"], edited["revision"]);

    // The manager can be renamed but not removed or given another role.
    let general_path = format!("{path}/{general_id}");
    let (status, protected) = call(&env, Method::DELETE, &general_path, Value::Null).await;
    assert_eq!(
        (status, protected["code"].as_str()),
        (StatusCode::CONFLICT, Some("general_protected"))
    );
    let (status, _) = call(
        &env,
        Method::PATCH,
        &general_path,
        json!({"expected_revision": roster["members"][0]["revision"], "template": "custom"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, removed) = call(&env, Method::DELETE, &member_path, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(removed["state"], "removed");
    let (_, live) = call(&env, Method::GET, &path, Value::Null).await;
    assert_eq!(live["members"].as_array().unwrap().len(), 1);
    let (_, all) = call(
        &env,
        Method::GET,
        &format!("{path}?include_removed=true"),
        Value::Null,
    )
    .await;
    assert_eq!(all["members"].as_array().unwrap().len(), 2);

    // Another Workspace cannot see or change this member.
    let foreign = format!(
        "/projects/{}/members/{}",
        "no-such-project",
        edited["id"].as_str().unwrap()
    );
    let (status, _) = call(&env, Method::DELETE, &foreign, Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn defaults_are_saved_on_the_server_with_a_revision_and_reach_new_workspaces() {
    let env = env(true);
    let (status, defaults) = call(&env, Method::GET, "/member-defaults", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(defaults["revision"], 0);
    assert_eq!(defaults["general"]["agent_id"], "opencode");
    let body = json!({
        "expected_revision": 0,
        "general": {"agent_id": "opencode", "config": {"model": "fast"}, "instructions": "Be concise."},
        "templates": defaults["templates"],
    });
    let (status, saved) = call(&env, Method::PUT, "/member-defaults", body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 1);
    let (status, stale) = call(&env, Method::PUT, "/member-defaults", body).await;
    assert_eq!(
        (status, stale["code"].as_str()),
        (StatusCode::CONFLICT, Some("member_revision_conflict"))
    );
    let (_, roster) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/members", env.project),
        Value::Null,
    )
    .await;
    assert_eq!(roster["members"][0]["spec"]["config"]["model"], "fast");
    assert_eq!(roster["members"][0]["spec"]["instructions"], "Be concise.");
}

#[tokio::test]
async fn the_manager_manages_and_cannot_execute_and_specialists_are_assigned_by_roster() {
    let env = env(true);
    let (_, roster) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/members", env.project),
        Value::Null,
    )
    .await;
    let general = roster["members"][0].clone();
    let manager_session = general["public_conversation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_, analyst) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/members", env.project),
        json!({"name": "Analyst", "template": "analysis"}),
    )
    .await;
    let analyst_session = analyst["public_conversation_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // An approved round the manager coordinates.
    let (question, _) = env
        .state
        .research
        .create(
            &env.project,
            ResearchBrief {
                title: "Pruning".into(),
                question: "Does it hold?".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let (round, _) = env
        .state
        .research
        .begin_round(
            &env.project,
            &question.id,
            NewRound {
                kind: RoundKind::Solo,
                idempotency_key: "r1",
                expected_revision: 1,
                request: json!({}),
                sources: Vec::new(),
            },
        )
        .unwrap();
    env.state
        .research
        .round_set_session(&env.project, &question.id, &round.id, &manager_session)
        .unwrap();
    env.state
        .research
        .round_mark_started(&env.project, &question.id, &round.id)
        .unwrap();
    env.state
        .work
        .assume_coordinator(
            &env.project,
            &round.id,
            &manager_session,
            &Actor::Researcher,
        )
        .unwrap();

    let agent = |caller: &str| {
        WorkAgent::new(
            env.project.clone(),
            caller.to_owned(),
            Arc::clone(&env.state.work),
            Arc::clone(&env.state.channels),
            Arc::clone(&env.state.orchestrator),
            Arc::clone(&env.state.research),
            Arc::clone(&env.agents),
            Arc::new(|_| true),
        )
        .with_members(Arc::clone(&env.state.members))
        .with_experiments(Arc::clone(&env.state.experiment_runner))
    };
    let manager = agent(&manager_session);
    let task = manager
        .create(NewTask {
            round_id: None,
            title: "Sweep ratios",
            description: "Try them",
            plan: None,
            depends_on: &[],
            from_thread: None,
            client_request_id: Some("t1"),
        })
        .unwrap();

    // The manager sees the roster and who can take work.
    let listed = manager.members().unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().any(|m| m.handle == "analyst" && m.assignable));
    assert!(
        listed
            .iter()
            .any(|m| m.handle == "general" && !m.assignable)
    );

    // It cannot take the work itself, nor run or report as an executor.
    let itself = manager.assign(&task.item.id, &manager_session, "do it myself");
    assert!(
        matches!(itself, Err(AgentWorkError::Work(WorkError::Invalid(text))) if text.contains("manages")),
        "{itself:?}"
    );
    let to_manager = manager.assign_member(&task.item.id, "@general", "");
    assert!(
        matches!(&to_manager, Err(AgentWorkError::Invalid(text)) if text.contains("specialist members")),
        "{to_manager:?}"
    );
    let boundary = |result: Result<(), AgentWorkError>| match result {
        Err(AgentWorkError::Invalid(text)) => text.contains("General Agent manages"),
        _ => false,
    };
    assert!(boundary(
        manager
            .launch_experiment(
                &task.item.id,
                LaunchSpec {
                    launch_key: "k".into(),
                    argv: vec!["echo".into()],
                    ..Default::default()
                }
            )
            .map(|_| ())
    ));
    assert!(boundary(
        manager
            .report(&task.item.id, ReportStatus::Completed, "done", None)
            .map(|_| ())
    ));
    assert!(boundary(
        manager
            .create_executor(None, "opencode", "Side", "k-side")
            .map(|_| ())
    ));
    // The same calls by a specialist are not stopped by that rule (negative
    // control): they fail, if at all, for their own reasons.
    let specialist = agent(&analyst_session);
    assert!(!boundary(
        specialist
            .report(&task.item.id, ReportStatus::Completed, "done", None)
            .map(|_| ())
    ));

    // It delegates to the specialist, by handle.
    let assigned = manager
        .assign_member(&task.item.id, "@analyst", "your area")
        .unwrap();
    assert_eq!(
        assigned
            .assignment
            .as_ref()
            .map(|a| a.conversation_id.as_str()),
        Some(analyst_session.as_str())
    );
    // A DM Session of the specialist is not a place for shared work.
    let dm = env
        .state
        .members
        .ensure_dm_session(&env.project, analyst["id"].as_str().unwrap(), &|_| true)
        .unwrap()
        .dm_conversation_id
        .unwrap();
    let other = manager
        .create(NewTask {
            round_id: None,
            title: "Second",
            description: "Another",
            plan: None,
            depends_on: &[],
            from_thread: None,
            client_request_id: Some("t2"),
        })
        .unwrap();
    assert!(
        env.state
            .work
            .assign(
                &env.project,
                &other.item.id,
                &dm,
                None,
                "",
                &Actor::Researcher
            )
            .is_err()
    );
    // A removed member (or a replaced Session) can no longer be assigned.
    env.state
        .work
        .close(
            &env.project,
            &task.item.id,
            task.item.revision,
            kubecode_server::work_store::Closure {
                lifecycle: kubecode_server::work_store::WorkLifecycle::Canceled,
                reason: "done with it",
                superseded_by: None,
            },
            &Actor::Researcher,
        )
        .unwrap();
    let (status, removed) = call(
        &env,
        Method::DELETE,
        &format!(
            "/projects/{}/members/{}",
            env.project,
            analyst["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{removed}");
    assert!(
        manager
            .assign_member(&other.item.id, "@analyst", "")
            .is_err()
    );
}

#[tokio::test]
async fn a_members_session_cannot_be_deleted_and_replacing_it_can_change_the_provider() {
    let env = env(true);
    let (_, roster) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/members", env.project),
        Value::Null,
    )
    .await;
    let general = roster["members"][0].clone();
    let session = general["public_conversation_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Deleting a member's Session through the Session API is refused.
    let (status, refused) = call(
        &env,
        Method::DELETE,
        &format!("/sessions/{session}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert!(env.agents.get_conversation(&session).is_ok());

    // Replacing the Session keeps the member and the old Session is no longer its own.
    let path = format!(
        "/projects/{}/members/{}/session",
        env.project,
        general["id"].as_str().unwrap()
    );
    let (status, replaced) = call(&env, Method::POST, &path, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    assert_eq!(replaced["id"], general["id"]);
    assert_ne!(
        replaced["public_conversation_id"],
        general["public_conversation_id"]
    );
    assert!(
        !env.state
            .members
            .is_general(&env.project, &session)
            .unwrap()
    );
    assert!(
        env.state
            .members
            .was_general(&env.project, &session)
            .unwrap()
    );
    // A provider that is not available is refused with nothing left behind.
    let (status, bad) = call(
        &env,
        Method::POST,
        &path,
        json!({"spec": {"agent_id": "codex", "config": {}, "instructions": ""}}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
}

#[tokio::test]
async fn coordination_goes_to_the_general_agents_current_session_only() {
    let env = env(true);
    let (_, roster) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/members", env.project),
        Value::Null,
    )
    .await;
    let manager_session = roster["members"][0]["public_conversation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_, analyst) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/members", env.project),
        json!({"name": "Analyst"}),
    )
    .await;
    let specialist_session = analyst["public_conversation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (question, _) = env
        .state
        .research
        .create(
            &env.project,
            ResearchBrief {
                title: "Q".into(),
                question: "?".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let (round, _) = env
        .state
        .research
        .begin_round(
            &env.project,
            &question.id,
            NewRound {
                kind: RoundKind::Solo,
                idempotency_key: "r1",
                expected_revision: 1,
                request: json!({}),
                sources: Vec::new(),
            },
        )
        .unwrap();
    let denied = env.state.work.assume_coordinator(
        &env.project,
        &round.id,
        &specialist_session,
        &Actor::Researcher,
    );
    assert!(
        matches!(denied, Err(WorkError::Invalid(text)) if text.contains("General Agent")),
        "{denied:?}"
    );
    env.state
        .work
        .assume_coordinator(
            &env.project,
            &round.id,
            &manager_session,
            &Actor::Researcher,
        )
        .unwrap();
    let handed = env.state.work.handoff_coordinator(
        &env.project,
        &round.id,
        1,
        &specialist_session,
        "to the specialist",
        &Actor::Researcher,
    );
    assert!(
        handed.is_err(),
        "a specialist does not take over coordination"
    );
    // Replacing the manager's Session carries its rounds to the new one.
    let path = format!(
        "/projects/{}/members/{}/session",
        env.project,
        roster["members"][0]["id"].as_str().unwrap()
    );
    let (status, replaced) = call(&env, Method::POST, &path, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    let holder = env
        .state
        .work
        .coordinator(&env.project, &round.id)
        .unwrap()
        .unwrap()
        .holder;
    assert_eq!(
        Some(holder.as_str()),
        replaced["public_conversation_id"].as_str()
    );
}
