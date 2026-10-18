//! Execution API tests (#162): the envelope the researcher approves, its
//! revisions, pause/resume, round setup with an envelope, and that waits and
//! reservations survive a restart.

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
use kubecode_server::teams::TeamStore;
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

fn team_round(key: &str, envelope: Option<Value>) -> Value {
    let mut request = json!({
        "client_request_id": key,
        "expected_revision": 1,
        "mode": "team",
        "agent_id": "opencode",
        "leader_name": "Lead",
        "instruction": "Run the baseline.",
    });
    if let Some(envelope) = envelope {
        request["envelope"] = envelope;
    }
    request
}

fn limits() -> Value {
    json!({
        "max_launches": 3,
        "max_concurrent": 2,
        "deadline_at": null,
        "max_runtime_secs": 60,
        "max_no_progress": 2,
        "allowed_commands": [["python3", "train.py"], ["echo"]],
    })
}

async fn start_round(
    env: &Env,
    rq: &str,
    key: &str,
    envelope: Option<Value>,
) -> (StatusCode, Value) {
    call(
        env,
        Method::POST,
        &format!("{}/{rq}/rounds", rq_path(env)),
        team_round(key, envelope),
    )
    .await
}

fn execution_path(env: &Env, rq: &str, round: &str) -> String {
    format!("{}/{rq}/rounds/{round}/execution", rq_path(env))
}

#[tokio::test]
async fn a_round_without_an_envelope_cannot_launch_and_one_can_be_set_later() {
    let env = env(false);
    let rq = create_rq(&env, "Envelope").await;
    let id = rq["id"].as_str().expect("id");
    let (status, round) = start_round(&env, id, "r1", None).await;
    assert_eq!(status, StatusCode::CREATED, "{round}");
    let round_id = round["id"].as_str().expect("round");

    let (status, view) = call(
        &env,
        Method::GET,
        &execution_path(&env, id, round_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["envelope"], Value::Null);
    assert_eq!(view["experiments"], json!([]));
    assert!(view["now"].as_i64().expect("now") > 1_700_000_000);

    // Nothing is authorized yet.
    let team_id = round["team"]["id"].as_str().expect("team");
    let team = env.state.teams.get_team(team_id).expect("team");
    let denied = env.state.experiments.reserve(
        &env.project_id,
        id,
        kubecode_server::experiment_store::NewLaunch {
            round_id: round_id.to_owned(),
            launch_key: "k".into(),
            team_id: Some(team.id.clone()),
            task_id: None,
            owner_member_id: None,
            label: String::new(),
            argv: vec!["echo".into()],
            cwd: String::new(),
            artifacts: Vec::new(),
            sources: Vec::new(),
            max_runtime_secs: None,
        },
    );
    assert!(matches!(
        denied,
        Err(kubecode_server::experiment_store::ExperimentError::Denied(
            kubecode_server::experiment_store::LaunchDenial::NoEnvelope
        ))
    ));

    let (status, envelope) = call(
        &env,
        Method::PUT,
        &format!("{}/envelope", execution_path(&env, id, round_id)),
        json!({"limits": limits()}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
    assert_eq!(
        (envelope["revision"].clone(), envelope["state"].clone()),
        (json!(1), json!("active"))
    );
}

#[tokio::test]
async fn a_round_starts_with_its_envelope_and_revisions_need_the_current_revision() {
    let env = env(false);
    let rq = create_rq(&env, "Revisions").await;
    let id = rq["id"].as_str().expect("id");
    let (status, round) = start_round(&env, id, "r1", Some(limits())).await;
    assert_eq!(status, StatusCode::CREATED, "{round}");
    let round_id = round["id"].as_str().expect("round").to_owned();
    let path = execution_path(&env, id, &round_id);
    let (_, view) = call(&env, Method::GET, &path, Value::Null).await;
    assert_eq!(view["envelope"]["revision"], 1);
    assert_eq!(
        view["envelope"]["limits"]["allowed_commands"][0],
        json!(["python3", "train.py"])
    );

    let mut wider = limits();
    wider["max_launches"] = json!(8);
    let (status, revised) = call(
        &env,
        Method::PUT,
        &format!("{path}/envelope"),
        json!({"expected_revision": 1, "limits": wider.clone()}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{revised}");
    assert_eq!(revised["revision"], 2);

    let (status, conflict) = call(
        &env,
        Method::PUT,
        &format!("{path}/envelope"),
        json!({"expected_revision": 1, "limits": wider}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "envelope_revision_conflict");
    assert_eq!(conflict["current_revision"], 2);

    let mut invalid = limits();
    invalid["allowed_commands"] = json!([]);
    let (status, body) = call(
        &env,
        Method::PUT,
        &format!("{path}/envelope"),
        json!({"expected_revision": 2, "limits": invalid}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], "invalid_execution");

    // Pause and resume are idempotent commands on future launches.
    for (action, state) in [
        ("pause", "paused"),
        ("pause", "paused"),
        ("resume", "active"),
    ] {
        let (status, body) =
            call(&env, Method::POST, &format!("{path}/{action}"), Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], state);
    }
}

#[tokio::test]
async fn an_invalid_envelope_at_round_start_creates_nothing() {
    let env = env(false);
    let rq = create_rq(&env, "Invalid").await;
    let id = rq["id"].as_str().expect("id");
    let mut bad = limits();
    bad["max_concurrent"] = json!(99);
    let (status, body) = start_round(&env, id, "r1", Some(bad)).await;
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

#[tokio::test]
async fn execution_routes_do_not_leak_across_projects() {
    let env = env(false);
    let rq = create_rq(&env, "Scope").await;
    let id = rq["id"].as_str().expect("id");
    let (_, round) = start_round(&env, id, "r1", Some(limits())).await;
    let round_id = round["id"].as_str().expect("round");
    let foreign = format!(
        "/projects/{}/research/{id}/rounds/{round_id}/execution",
        env.other_project_id
    );
    let (status, _) = call(&env, Method::GET, &foreign, Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &env,
        Method::PUT,
        &format!("{foreign}/envelope"),
        json!({"limits": limits()}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{}/{id}/experiments/missing/reconcile", rq_path(&env)),
        json!({"truth": "not_started"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reservations_and_waits_survive_a_restart() {
    let first = env(false);
    let rq = create_rq(&first, "Durable").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    let (_, round) = start_round(&first, &id, "r1", Some(limits())).await;
    let round_id = round["id"].as_str().expect("round").to_owned();
    let team_id = round["team"]["id"].as_str().expect("team").to_owned();
    let leader = first
        .state
        .teams
        .get_team(&team_id)
        .expect("team")
        .leader_member_id;
    let (experiment, _) = first
        .state
        .experiments
        .reserve(
            &first.project_id,
            &id,
            kubecode_server::experiment_store::NewLaunch {
                round_id: round_id.clone(),
                launch_key: "baseline".into(),
                team_id: Some(team_id.clone()),
                task_id: None,
                owner_member_id: Some(leader.clone()),
                label: "baseline".into(),
                argv: vec!["echo".into(), "hi".into()],
                cwd: String::new(),
                artifacts: Vec::new(),
                sources: Vec::new(),
                max_runtime_secs: None,
            },
        )
        .expect("reserve");
    first
        .state
        .experiments
        .register_wait(
            &first.project_id,
            &team_id,
            &leader,
            &experiment.id,
            None,
            "analyze",
            None,
        )
        .expect("wait");

    let second = restart(&first);
    let (_, view) = call(
        &second,
        Method::GET,
        &execution_path(&second, &id, &round_id),
        Value::Null,
    )
    .await;
    assert_eq!(view["experiments"][0]["id"], json!(experiment.id));
    assert_eq!(view["experiments"][0]["state"], "reserved");
    assert_eq!(view["waits"][0]["state"], "open");
    assert!(
        second
            .state
            .teams
            .member_has_open_wait(&team_id, &leader)
            .expect("wait query")
    );
    // The replayed key still returns the same attempt and consumes nothing.
    let (replayed, created) = second
        .state
        .experiments
        .reserve(
            &second.project_id,
            &id,
            kubecode_server::experiment_store::NewLaunch {
                round_id: round_id.clone(),
                launch_key: "baseline".into(),
                team_id: Some(team_id),
                task_id: None,
                owner_member_id: Some(leader),
                label: "baseline".into(),
                argv: vec!["echo".into(), "hi".into()],
                cwd: String::new(),
                artifacts: Vec::new(),
                sources: Vec::new(),
                max_runtime_secs: None,
            },
        )
        .expect("replay");
    assert!(!created);
    assert_eq!(replayed.id, experiment.id);
}

/// Boots a second process over an existing Runtime directory.
fn restart(first: &Env) -> Env {
    let root = first._root.path();
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root, &database).expect("workspace"));
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let state = AppState::new(workspace, agents, teams);
    let app = app_router(state.clone(), BASE);
    Env {
        _root: TempDir::new().expect("placeholder"),
        state,
        app,
        project_id: first.project_id.clone(),
        other_project_id: first.other_project_id.clone(),
        project_path: first.project_path.clone(),
    }
}

fn shell_limits() -> Value {
    json!({
        "max_launches": 5,
        "max_concurrent": 2,
        "deadline_at": null,
        "max_runtime_secs": 30,
        "max_no_progress": 3,
        "allowed_commands": [["sh", "-c"]],
    })
}

async fn wait_for_state(env: &Env, path: &str, id: &str, done: &[&str]) -> Value {
    for _ in 0..400 {
        let (_, view) = call(env, Method::GET, path, Value::Null).await;
        if let Some(experiment) = view["experiments"]
            .as_array()
            .and_then(|list| list.iter().find(|e| e["id"] == json!(id)))
            && done.contains(&experiment["state"].as_str().unwrap_or_default())
        {
            return experiment.clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("experiment {id} did not reach {done:?}");
}

#[tokio::test]
async fn the_researcher_launches_inside_the_envelope_and_reads_logs_and_artifacts() {
    let env = env(false);
    let rq = create_rq(&env, "Launch").await;
    let id = rq["id"].as_str().expect("id");
    let (_, round) = start_round(&env, id, "r1", Some(shell_limits())).await;
    let round_id = round["id"].as_str().expect("round");
    let path = execution_path(&env, id, round_id);

    let launch_path = format!("{path}/experiments");
    let body = json!({
        "launch_key": "baseline",
        "argv": ["sh", "-c", "echo result > metrics.txt; echo hello"],
        "artifacts": ["metrics.txt"],
        "label": "baseline",
    });
    let (status, started) = call(&env, Method::POST, &launch_path, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let experiment_id = started["id"].as_str().expect("experiment").to_owned();
    assert_eq!(started["policy_revision"], 1);

    // A replay of the same key returns the same attempt.
    let (_, replay) = call(&env, Method::POST, &launch_path, body).await;
    assert_eq!(replay["id"], json!(experiment_id));

    let done = wait_for_state(&env, &path, &experiment_id, &["exited"]).await;
    assert_eq!(done["exit_code"], 0);
    assert_eq!(done["analysis"], "pending");
    assert_eq!(done["artifact_state"][0]["path"], "metrics.txt");
    assert_eq!(done["artifact_state"][0]["availability"], "available");
    let (_, logs) = call(
        &env,
        Method::GET,
        &format!(
            "{}/{id}/experiments/{experiment_id}/logs?stream=stdout",
            rq_path(&env)
        ),
        Value::Null,
    )
    .await;
    assert_eq!(logs["text"], "hello\n");

    // Changing the artifact is reported, not hidden.
    fs::write(env.project_path.join("metrics.txt"), "different").expect("edit");
    let (_, view) = call(&env, Method::GET, &path, Value::Null).await;
    assert_eq!(
        view["experiments"][0]["artifact_state"][0]["availability"],
        "changed"
    );
}

#[tokio::test]
async fn a_refused_launch_reports_its_reason_and_unsafe_paths_are_bad_requests() {
    let env = env(false);
    let rq = create_rq(&env, "Refuse").await;
    let id = rq["id"].as_str().expect("id");
    let (_, round) = start_round(&env, id, "r1", Some(shell_limits())).await;
    let path = format!(
        "{}/experiments",
        execution_path(&env, id, round["id"].as_str().expect("round"))
    );
    let (status, body) = call(
        &env,
        Method::POST,
        &path,
        json!({"launch_key": "a", "argv": ["touch", "x"]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        (body["code"].clone(), body["reason"].clone()),
        (json!("launch_denied"), json!("command_not_authorized"))
    );
    let (status, body) = call(
        &env,
        Method::POST,
        &path,
        json!({"launch_key": "b", "argv": ["sh", "-c", "true"], "cwd": "../outside"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn cancelling_a_round_stops_its_processes_and_closes_its_authority() {
    let env = env(false);
    let rq = create_rq(&env, "Cancel").await;
    let id = rq["id"].as_str().expect("id");
    let (_, round) = start_round(&env, id, "r1", Some(shell_limits())).await;
    let round_id = round["id"].as_str().expect("round");
    let path = execution_path(&env, id, round_id);
    let launch_path = format!("{path}/experiments");
    let (_, started) = call(
        &env,
        Method::POST,
        &launch_path,
        json!({"launch_key": "long", "argv": ["sh", "-c", "sleep 60"]}),
    )
    .await;
    let experiment_id = started["id"].as_str().expect("experiment").to_owned();
    assert_eq!(started["state"], "running");

    let (status, cancelled) =
        call(&env, Method::POST, &format!("{path}/cancel"), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["cancelled"], 1);
    assert_eq!(cancelled["envelope"]["state"], "closed");
    let done = wait_for_state(&env, &path, &experiment_id, &["cancelled"]).await;
    assert_eq!(done["cancel_requested"], true);

    // The round can no longer launch anything.
    let (status, body) = call(
        &env,
        Method::POST,
        &launch_path,
        json!({"launch_key": "again", "argv": ["sh", "-c", "true"]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["reason"], "envelope_closed");
}
