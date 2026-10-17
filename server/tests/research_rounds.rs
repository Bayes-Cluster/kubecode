//! Research round tests (#150): explicit work requests with a pinned brief
//! revision. Covers Team and Solo rounds end to end, idempotent replays and
//! concurrent duplicates, resume after a partial failure without a second
//! Team, edits after admission, Session promotion keeping the RQ association,
//! pre-flight validation that creates nothing, and source availability.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::research_store::RoundPhase;
use kubecode_server::teams::{NewTeam, TeamStatus, TeamStore, TeamWorkspace};
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE: &str = "/user/alice/kubecode";

struct Env {
    _root: TempDir,
    state: AppState,
    app: Router,
    project_id: String,
    other_project_id: String,
    project_path: std::path::PathBuf,
}

const SOLO_AGENT: &str = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"round-session\"}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done"#;

fn env(with_agent: bool) -> Env {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace.create_project(".", "alpha").expect("alpha");
    let other = workspace.create_project(".", "beta").expect("beta");
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let mut state = AppState::new(workspace, agents, teams);
    if with_agent {
        let binary = root.path().join("mock-agent");
        fs::write(&binary, format!("#!/bin/sh\n{SOLO_AGENT}\n")).expect("mock");
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).expect("chmod");
        state = state.with_agents(vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary.to_string_lossy().into_owned(),
            error: None,
        }]);
    }
    let app = app_router(state.clone(), BASE);
    let project_path = std::path::PathBuf::from(&project.path);
    Env {
        _root: root,
        state,
        app,
        project_id: project.id,
        other_project_id: other.id,
        project_path,
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

fn rq_path(env: &Env) -> String {
    format!("/projects/{}/research", env.project_id)
}

async fn create_rq(env: &Env, title: &str) -> Value {
    let (status, body) = call(
        env,
        Method::POST,
        &rq_path(env),
        json!({
            "title": title,
            "question": "Does structured pruning keep accuracy?",
            "hypotheses": ["Late layers tolerate pruning"],
            "constraints": ["single GPU"],
            "evaluation_criteria": ["top-1 accuracy within one point"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}

fn team_round(key: &str, revision: u64) -> Value {
    json!({
        "client_request_id": key,
        "expected_revision": revision,
        "mode": "team",
        "agent_id": "opencode",
        "leader_name": "Lead",
        "instruction": "Compare structured and unstructured pruning.",
    })
}

async fn wait_for(mut done: impl FnMut() -> bool, what: &str) {
    for _ in 0..400 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn a_team_round_creates_links_and_starts_one_team_with_the_pinned_revision() {
    let env = env(false);
    let rq = create_rq(&env, "Pruning").await;
    let id = rq["id"].as_str().expect("id");
    let rounds = format!("{}/{id}/rounds", rq_path(&env));
    let (status, round) = call(&env, Method::POST, &rounds, team_round("r1", 1)).await;
    assert_eq!(status, StatusCode::CREATED, "{round}");
    assert_eq!(
        (
            round["round"].clone(),
            round["brief_revision"].clone(),
            round["phase"].clone(),
            round["stale"].clone()
        ),
        (json!(1), json!(1), json!("started"), json!(false))
    );
    let team_id = round["team"]["id"].as_str().expect("team id");
    assert_eq!(round["team"]["state"], "active");

    // The Team carries the goal, a pointer to the pinned brief, and the
    // criteria from the brief; it is linked to the RQ as execution work.
    let team = env.state.teams.get_team(team_id).expect("team");
    assert_eq!(team.status, TeamStatus::Active);
    assert!(
        team.goal
            .starts_with("Compare structured and unstructured pruning.")
    );
    assert!(team.goal.contains("brief revision 1"));
    assert!(team.goal.contains("team_get_context"));
    assert_eq!(
        team.acceptance_criteria,
        vec!["top-1 accuracy within one point"]
    );
    let (_, detail) = call(
        &env,
        Method::GET,
        &format!("{}/{id}", rq_path(&env)),
        Value::Null,
    )
    .await;
    let link = detail["links"]
        .as_array()
        .expect("links")
        .iter()
        .find(|l| l["kind"] == "team")
        .expect("team link");
    assert_eq!(
        (link["role"].clone(), link["availability"].clone()),
        (json!("execution"), json!("available"))
    );
    // The log records the start once.
    let (_, entries) = call(
        &env,
        Method::GET,
        &format!("{}/{id}/entries", rq_path(&env)),
        Value::Null,
    )
    .await;
    assert_eq!(entries[0]["author_kind"], "system");
    assert_eq!(entries[0]["body"], "Round 1 started with brief revision 1.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replays_and_concurrent_duplicates_never_create_a_second_team() {
    let env = Arc::new(env(false));
    let rq = create_rq(&env, "Dedup").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    let rounds = format!("{}/{id}/rounds", rq_path(&env));
    // Eight identical requests race on real worker threads.
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let env = Arc::clone(&env);
            let rounds = rounds.clone();
            tokio::spawn(
                async move { call(&env, Method::POST, &rounds, team_round("same", 1)).await },
            )
        })
        .collect();
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.expect("request task"));
    }
    for (status, body) in &results {
        assert!(status.is_success(), "{body}");
    }
    let created = results
        .iter()
        .filter(|(status, _)| *status == StatusCode::CREATED)
        .count();
    assert_eq!(created, 1, "exactly one request created the round");
    assert!(
        results
            .iter()
            .all(|(_, body)| body["id"] == results[0].1["id"])
    );
    assert!(results.iter().all(|(_, body)| body["phase"] == "started"));
    assert_eq!(
        env.state
            .teams
            .list_teams(&env.project_id)
            .expect("teams")
            .len(),
        1
    );
    assert_eq!(
        env.state
            .agent_runtime
            .store()
            .list_all_conversations()
            .expect("sessions")
            .len(),
        1
    );
    let (_, listed) = call(&env, Method::GET, &rounds, Value::Null).await;
    assert_eq!(listed.as_array().expect("rounds").len(), 1);
    // The same key with a different request is a refusal, not a second round.
    let mut changed = team_round("same", 1);
    changed["instruction"] = json!("Something else entirely");
    let (status, refused) = call(&env, Method::POST, &rounds, changed).await;
    assert_eq!(
        (status, refused["code"].clone()),
        (StatusCode::CONFLICT, json!("research_request_key_reused"))
    );
}

#[tokio::test]
async fn editing_the_brief_leaves_an_admitted_round_on_its_revision() {
    let env = env(false);
    let rq = create_rq(&env, "Original title").await;
    let id = rq["id"].as_str().expect("id");
    let item = format!("{}/{id}", rq_path(&env));
    let (_, round) = call(
        &env,
        Method::POST,
        &format!("{item}/rounds"),
        team_round("r1", 1),
    )
    .await;
    let (status, _) = call(
        &env,
        Method::PATCH,
        &item,
        json!({"expected_revision": 1, "title": "Edited title", "constraints": ["two GPUs"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // The round is flagged stale, still names revision 1, and revision 1
    // still holds the text the round consumed.
    let (_, view) = call(
        &env,
        Method::GET,
        &format!("{item}/rounds/{}", round["id"].as_str().expect("round id")),
        Value::Null,
    )
    .await;
    assert_eq!(
        (view["stale"].clone(), view["brief_revision"].clone()),
        (json!(true), json!(1))
    );
    let (_, pinned) = call(
        &env,
        Method::GET,
        &format!("{item}/revisions/1"),
        Value::Null,
    )
    .await;
    assert_eq!(pinned["brief"]["title"], "Original title");
    assert_eq!(pinned["brief"]["constraints"], json!(["single GPU"]));
    // The Team goal text was fixed at admission.
    let team = env
        .state
        .teams
        .get_team(round["team"]["id"].as_str().expect("team"))
        .expect("team");
    assert!(team.goal.contains("\"Original title\"") && !team.goal.contains("Edited title"));
    // A new round must name the revision the researcher now sees.
    let (status, stale) = call(
        &env,
        Method::POST,
        &format!("{item}/rounds"),
        team_round("r2", 1),
    )
    .await;
    assert_eq!(
        (
            status,
            stale["code"].clone(),
            stale["current_revision"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("research_revision_conflict"),
            json!(2)
        )
    );
    let (status, second) = call(
        &env,
        Method::POST,
        &format!("{item}/rounds"),
        team_round("r2", 2),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    assert_eq!(
        (second["round"].clone(), second["brief_revision"].clone()),
        (json!(2), json!(2))
    );
}

#[tokio::test]
async fn a_round_interrupted_after_creating_its_team_resumes_without_a_duplicate() {
    let env = env(false);
    let rq = create_rq(&env, "Crash").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    // Reproduce a crash window: the round and its Leader Session are
    // recorded, a Team was created for that Session, but the Team was never
    // attached to the round or started.
    let request = json!({
        "session_id": null, "agent_id": "opencode", "title": null,
        "instruction": "Resume me", "leader_name": "Lead", "workspace": "shared",
        "acceptance_criteria": ["top-1 accuracy within one point"],
        "allowed_agent_ids": ["opencode"], "team_mode": "standard",
        "max_teammates": 3, "max_parallel_runs": 3, "max_review_rounds": 3,
    });
    let (round, _) = env
        .state
        .research
        .begin_round(
            &env.project_id,
            &id,
            kubecode_server::research_store::NewRound {
                kind: kubecode_server::research_store::RoundKind::Team,
                idempotency_key: "crashed",
                expected_revision: 1,
                request,
                sources: Vec::new(),
            },
        )
        .expect("begin");
    let leader = env
        .state
        .agent_runtime
        .store()
        .create_conversation(&env.project_id, AgentId::OpenCode, Some("Leader"))
        .expect("leader");
    env.state
        .research
        .round_set_session(&env.project_id, &id, &round.id, &leader.id)
        .expect("session");
    let orphan = env
        .state
        .teams
        .create_team(NewTeam {
            project_id: &env.project_id,
            leader_conversation_id: &leader.id,
            agent_session_id: &leader.agent_session_id,
            leader_name: "Lead",
            title: Some("Crashed team"),
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");

    let (status, resumed) = call(
        &env,
        Method::POST,
        &format!("{}/{id}/rounds/{}/resume", rq_path(&env), round.id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resumed}");
    assert_eq!(resumed["phase"], "started");
    assert_eq!(
        resumed["team"]["id"],
        orphan.id.as_str(),
        "the existing Team is reused"
    );
    assert_eq!(
        env.state
            .teams
            .list_teams(&env.project_id)
            .expect("teams")
            .len(),
        1
    );
    assert_eq!(
        env.state.teams.get_team(&orphan.id).expect("team").status,
        TeamStatus::Active
    );
    // Resuming a finished round is a no-op.
    let (_, again) = call(
        &env,
        Method::POST,
        &format!("{}/{id}/rounds/{}/resume", rq_path(&env), round.id),
        Value::Null,
    )
    .await;
    assert_eq!(again["phase"], "started");
    assert_eq!(
        env.state
            .teams
            .list_teams(&env.project_id)
            .expect("teams")
            .len(),
        1
    );
}

#[tokio::test]
async fn promoting_a_linked_session_keeps_its_history_and_research_association() {
    let env = env(false);
    let rq = create_rq(&env, "Promote").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    let store = env.state.agent_runtime.store();
    let discussion = store
        .create_conversation(&env.project_id, AgentId::OpenCode, Some("Discuss"))
        .expect("session");
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{}/{id}/links", rq_path(&env)),
        json!({"kind": "session", "ref_id": discussion.id, "role": "discussion"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Promotion through the ordinary route extends the association.
    let (status, snapshot) = call(
        &env,
        Method::POST,
        &format!("/sessions/{}/promote-to-team", discussion.id),
        json!({"leader_name": "Lead"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{snapshot}");
    let team_id = snapshot["team"]["id"].as_str().expect("team");
    assert_eq!(
        snapshot["leader_conversation"]["id"],
        discussion.id.as_str(),
        "same Session"
    );
    let (_, detail) = call(
        &env,
        Method::GET,
        &format!("{}/{id}", rq_path(&env)),
        Value::Null,
    )
    .await;
    let links = detail["links"].as_array().expect("links");
    assert!(links.iter().any(|l| l["kind"] == "session"
        && l["ref_id"] == discussion.id.as_str()
        && l["role"] == "discussion"));
    assert!(
        links
            .iter()
            .any(|l| l["kind"] == "team" && l["ref_id"] == team_id && l["role"] == "execution")
    );

    // A round that promotes that Session reuses the association.
    let (status, round) = call(
        &env,
        Method::POST,
        &format!("{}/{id}/rounds", rq_path(&env)),
        json!({"client_request_id": "p", "expected_revision": 1, "mode": "team", "session_id": discussion.id}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a Session already in a Team cannot be promoted again: {round}"
    );
    assert_eq!(
        env.state
            .teams
            .list_teams(&env.project_id)
            .expect("teams")
            .len(),
        1
    );
}

#[tokio::test]
async fn a_round_can_promote_a_discussion_session_into_its_team() {
    let env = env(false);
    let rq = create_rq(&env, "Round promote").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    let discussion = env
        .state
        .agent_runtime
        .store()
        .create_conversation(&env.project_id, AgentId::OpenCode, Some("Discuss"))
        .expect("session");
    call(
        &env,
        Method::POST,
        &format!("{}/{id}/links", rq_path(&env)),
        json!({"kind": "session", "ref_id": discussion.id, "role": "discussion"}),
    )
    .await;
    let (status, round) = call(
        &env,
        Method::POST,
        &format!("{}/{id}/rounds", rq_path(&env)),
        json!({"client_request_id": "p", "expected_revision": 1, "mode": "team", "session_id": discussion.id}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{round}");
    assert_eq!(round["session"]["id"], discussion.id.as_str());
    let team = env
        .state
        .teams
        .team_for_conversation(&discussion.id)
        .expect("lookup")
        .expect("promoted");
    assert_eq!(round["team"]["id"], team.id.as_str());
    assert_eq!(
        env.state
            .teams
            .list_teams(&env.project_id)
            .expect("teams")
            .len(),
        1
    );
}

#[tokio::test]
async fn invalid_requests_create_nothing() {
    let env = env(false);
    let rq = create_rq(&env, "Preflight").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    let rounds = format!("{}/{id}/rounds", rq_path(&env));
    let store = env.state.agent_runtime.store();
    let foreign = store
        .create_conversation(&env.other_project_id, AgentId::OpenCode, Some("Elsewhere"))
        .expect("foreign");
    let other_rq = create_rq(&env, "Other question").await;
    let claimed = store
        .create_conversation(&env.project_id, AgentId::OpenCode, Some("Claimed"))
        .expect("claimed");
    call(
        &env,
        Method::POST,
        &format!(
            "{}/{}/links",
            rq_path(&env),
            other_rq["id"].as_str().expect("id")
        ),
        json!({"kind": "session", "ref_id": claimed.id, "role": "discussion"}),
    )
    .await;
    let sessions_before = store.list_all_conversations().expect("sessions").len();

    let mut cases: Vec<(&str, Value, StatusCode, &str)> = vec![
        (
            "no agent or session",
            json!({"client_request_id": "a", "expected_revision": 1, "mode": "team"}),
            StatusCode::BAD_REQUEST,
            "invalid_research",
        ),
        (
            "foreign session",
            json!({"client_request_id": "b", "expected_revision": 1, "mode": "solo", "session_id": foreign.id}),
            StatusCode::BAD_REQUEST,
            "invalid_research",
        ),
        (
            "session of another question",
            json!({"client_request_id": "c", "expected_revision": 1, "mode": "solo", "session_id": claimed.id}),
            StatusCode::CONFLICT,
            "research_link_conflict",
        ),
        (
            "unknown source",
            json!({"client_request_id": "d", "expected_revision": 1, "mode": "team", "agent_id": "opencode", "sources": [{"kind": "session", "id": "nope"}]}),
            StatusCode::BAD_REQUEST,
            "invalid_research",
        ),
        (
            "foreign source",
            json!({"client_request_id": "e", "expected_revision": 1, "mode": "team", "agent_id": "opencode", "sources": [{"kind": "session", "id": foreign.id}]}),
            StatusCode::BAD_REQUEST,
            "invalid_research",
        ),
        (
            "path traversal source",
            json!({"client_request_id": "f", "expected_revision": 1, "mode": "team", "agent_id": "opencode", "sources": [{"kind": "file", "id": "../outside.txt"}]}),
            StatusCode::BAD_REQUEST,
            "invalid_research",
        ),
        (
            "limits out of range",
            json!({"client_request_id": "g", "expected_revision": 1, "mode": "team", "agent_id": "opencode", "max_teammates": 2, "max_parallel_runs": 5}),
            StatusCode::BAD_REQUEST,
            "invalid_research",
        ),
        (
            "no allowed agents",
            json!({"client_request_id": "h", "expected_revision": 1, "mode": "team", "agent_id": "opencode", "allowed_agent_ids": []}),
            StatusCode::BAD_REQUEST,
            "invalid_research",
        ),
        (
            "oversized instruction",
            json!({"client_request_id": "i", "expected_revision": 1, "mode": "solo", "agent_id": "opencode", "instruction": "x".repeat(4_001)}),
            StatusCode::BAD_REQUEST,
            "invalid_research",
        ),
        (
            "bad key",
            json!({"client_request_id": "has spaces", "expected_revision": 1, "mode": "solo", "agent_id": "opencode"}),
            StatusCode::BAD_REQUEST,
            "invalid_research",
        ),
    ];
    // Without evaluation criteria a Team has nothing to be accepted against.
    let bare = call(
        &env,
        Method::POST,
        &rq_path(&env),
        json!({"title": "Bare", "question": "Why?"}),
    )
    .await
    .1;
    let bare_rounds = format!(
        "{}/{}/rounds",
        rq_path(&env),
        bare["id"].as_str().expect("id")
    );
    let (status, refused) = call(&env, Method::POST, &bare_rounds, team_round("bare", 1)).await;
    assert_eq!(
        (status, refused["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_research"))
    );
    for (label, body, expected_status, expected_code) in cases.drain(..) {
        let (status, error) = call(&env, Method::POST, &rounds, body).await;
        assert_eq!(
            (status, error["code"].clone()),
            (expected_status, json!(expected_code)),
            "{label}: {error}"
        );
    }
    assert_eq!(
        store.list_all_conversations().expect("sessions").len(),
        sessions_before,
        "no Session was created"
    );
    assert!(
        env.state
            .teams
            .list_teams(&env.project_id)
            .expect("teams")
            .is_empty()
    );
    let (_, listed) = call(&env, Method::GET, &rounds, Value::Null).await;
    assert_eq!(listed, json!([]), "no round was recorded");
    // Archived questions take no new work.
    call(
        &env,
        Method::POST,
        &format!("{}/{id}/archive", rq_path(&env)),
        Value::Null,
    )
    .await;
    let (status, archived) = call(&env, Method::POST, &rounds, team_round("late", 1)).await;
    assert_eq!(
        (status, archived["code"].clone()),
        (StatusCode::CONFLICT, json!("research_archived"))
    );
}

#[tokio::test]
async fn sources_report_available_changed_and_removed_without_leaking_other_projects() {
    let env = env(false);
    let rq = create_rq(&env, "Sources").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    let store = env.state.agent_runtime.store();
    fs::write(env.project_path.join("notes.md"), "first draft").expect("file");
    fs::write(env.project_path.join("gone.md"), "soon removed").expect("file");
    let reference = store
        .create_conversation(&env.project_id, AgentId::OpenCode, Some("Reference"))
        .expect("session");
    let (status, round) = call(
        &env,
        Method::POST,
        &format!("{}/{id}/rounds", rq_path(&env)),
        json!({
            "client_request_id": "s", "expected_revision": 1, "mode": "team", "agent_id": "opencode",
            "sources": [
                {"kind": "file", "id": "notes.md"},
                {"kind": "file", "id": "gone.md"},
                {"kind": "file", "id": "notes.md"},
                {"kind": "session", "id": reference.id},
            ],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{round}");
    let round_id = round["id"].as_str().expect("round");
    let states = |view: &Value| -> Vec<(String, String)> {
        view["sources"]
            .as_array()
            .expect("sources")
            .iter()
            .map(|s| {
                (
                    s["id"].as_str().expect("id").to_owned(),
                    s["availability"].as_str().expect("state").to_owned(),
                )
            })
            .collect()
    };
    assert_eq!(
        round["sources"].as_array().expect("sources").len(),
        3,
        "duplicates collapse"
    );
    assert!(
        round["sources"][0]["revision"]
            .as_str()
            .is_some_and(|r| r.len() == 64),
        "a file records its revision"
    );
    assert!(states(&round).iter().all(|(_, state)| state == "available"));

    fs::write(env.project_path.join("notes.md"), "second draft").expect("edit");
    fs::remove_file(env.project_path.join("gone.md")).expect("remove");
    store
        .delete_conversation(&reference.id)
        .expect("delete session");
    let (_, view) = call(
        &env,
        Method::GET,
        &format!("{}/{id}/rounds/{round_id}", rq_path(&env)),
        Value::Null,
    )
    .await;
    let by_id: std::collections::HashMap<_, _> = states(&view).into_iter().collect();
    assert_eq!(by_id["notes.md"], "changed");
    assert_eq!(by_id["gone.md"], "removed");
    assert_eq!(by_id[reference.id.as_str()], "removed");
}

#[tokio::test]
async fn a_solo_round_admits_the_pinned_context_once() {
    let env = env(true);
    let rq = create_rq(&env, "Solo pruning").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    let rounds = format!("{}/{id}/rounds", rq_path(&env));
    let body = json!({
        "client_request_id": "solo-1", "expected_revision": 1, "mode": "solo",
        "agent_id": "opencode", "instruction": "Try the baseline first.",
    });
    let (status, round) = call(&env, Method::POST, &rounds, body.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{round}");
    assert_eq!(round["phase"], "started");
    let session_id = round["session"]["id"].as_str().expect("session").to_owned();
    let store = env.state.agent_runtime.store();
    let runs = store.list_runs(&session_id).expect("runs");
    assert_eq!(runs.len(), 1);
    let message = &runs[0].message;
    for expected in [
        "Research round 1",
        "brief revision 1",
        "Does structured pruning keep accuracy?",
        "- single GPU",
        "- top-1 accuracy within one point",
        "Try the baseline first.",
    ] {
        assert!(message.contains(expected), "{expected}: {message}");
    }
    assert_eq!(
        runs[0].client_message_id.as_deref(),
        Some(format!("research:{}", round["id"].as_str().expect("id")).as_str())
    );

    // The session is linked as execution work; replays add no run.
    let (_, detail) = call(
        &env,
        Method::GET,
        &format!("{}/{id}", rq_path(&env)),
        Value::Null,
    )
    .await;
    assert!(
        detail["links"]
            .as_array()
            .expect("links")
            .iter()
            .any(|l| l["ref_id"] == session_id.as_str() && l["role"] == "execution")
    );
    let (status, replay) = call(&env, Method::POST, &rounds, body).await;
    assert_eq!(
        (status, replay["id"].clone()),
        (StatusCode::OK, round["id"].clone())
    );
    wait_for(
        || {
            store
                .list_runs(&session_id)
                .map(|r| r.len() == 1)
                .unwrap_or(false)
        },
        "single run",
    )
    .await;

    // Editing the brief afterwards does not rewrite the admitted prompt.
    call(
        &env,
        Method::PATCH,
        &format!("{}/{id}", rq_path(&env)),
        json!({"expected_revision": 1, "question": "A completely different question?"}),
    )
    .await;
    let runs = store.list_runs(&session_id).expect("runs");
    assert!(
        runs[0]
            .message
            .contains("Does structured pruning keep accuracy?")
    );
    assert!(!runs[0].message.contains("completely different"));
    let phase = env
        .state
        .research
        .round(&env.project_id, &id, round["id"].as_str().expect("id"))
        .expect("round")
        .phase;
    assert_eq!(phase, RoundPhase::Started);
}

#[tokio::test]
async fn replaying_a_round_on_an_existing_session_returns_the_same_round() {
    let env = env(false);
    let rq = create_rq(&env, "Replay").await;
    let id = rq["id"].as_str().expect("id");
    let session = env
        .state
        .agent_runtime
        .store()
        .create_conversation(
            &env.project_id,
            kubecode_server::agents::AgentId::OpenCode,
            Some("chat"),
        )
        .expect("session");
    let rounds = format!("{}/{id}/rounds", rq_path(&env));
    let mut request = team_round("k-existing", 1);
    request["session_id"] = json!(session.id);
    let (status, first) = call(&env, Method::POST, &rounds, request.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{first}");

    // The first attempt promoted the Session; a retry must still find the
    // round rather than be refused for using a Team member's Session.
    let (status, replay) = call(&env, Method::POST, &rounds, request.clone()).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["id"], first["id"]);

    // A brief edit moves a defaulted value but is still the same request.
    let (status, _) = call(
        &env,
        Method::PATCH,
        &format!("{}/{id}", rq_path(&env)),
        json!({"expected_revision": 1, "evaluation_criteria": ["something else"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, replay) = call(&env, Method::POST, &rounds, request.clone()).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["id"], first["id"]);

    // A different request under the same key is still refused.
    let mut changed = request.clone();
    changed["instruction"] = json!("Something else entirely");
    let (status, body) = call(&env, Method::POST, &rounds, changed).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "research_request_key_reused");

    // A second round cannot take over the Session that already leads
    // the first round's Team.
    let mut second = team_round("k-second", 2);
    second["session_id"] = json!(session.id);
    let (status, body) = call(&env, Method::POST, &rounds, second).await;
    assert!(status.is_client_error(), "{status} {body}");
}

#[tokio::test]
async fn an_unsupported_allowed_agent_is_refused_before_anything_is_created() {
    let env = env(false);
    let rq = create_rq(&env, "Agents").await;
    let id = rq["id"].as_str().expect("id");
    let mut request = team_round("k-bogus", 1);
    request["allowed_agent_ids"] = json!(["bogus"]);
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{}/{id}/rounds", rq_path(&env)),
        request,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (_, rounds) = call(
        &env,
        Method::GET,
        &format!("{}/{id}/rounds", rq_path(&env)),
        Value::Null,
    )
    .await;
    assert_eq!(rounds, json!([]));
}
