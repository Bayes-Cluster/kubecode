//! Experiment delivery tests (#164): a finished process wakes the responsible
//! member through the durable Team mailbox, exactly once, with a real mock
//! Agent behind the Team runtime.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::{AgentId, RunStatus};
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
}

const SOLO_AGENT: &str = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{\"mcpCapabilities\":{\"http\":true,\"sse\":false},\"sessionCapabilities\":{\"resume\":{},\"delete\":{}}},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"round-session\"}}"
      ;;
    *'"method":"session/resume"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{}}"
      ;;
    *'"method":"session/set_config_option"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"configOptions\":[]}}"
      ;;
    *'"method":"session/delete"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{}}"
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
    // The origin is applied last: replacing the Agent catalog rebuilds the runtime.
    state = state.with_team_mcp_http_origin("http://127.0.0.1:9999/user/alice/kubecode");
    let app = app_router(state.clone(), BASE);
    Env {
        _root: root,
        state,
        app,
        project_id: project.id,
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

async fn wait_for(mut done: impl FnMut() -> bool, what: &str) {
    for _ in 0..400 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

fn envelope() -> Value {
    json!({
        "max_launches": 4,
        "max_concurrent": 2,
        "deadline_at": null,
        "max_runtime_secs": 30,
        "max_no_progress": 3,
        "allowed_commands": [["sh", "-c"]],
    })
}

async fn started_team_round(env: &Env) -> (String, String, String) {
    let rq = create_rq(env, "Delivery").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    let (status, round) = call(
        env,
        Method::POST,
        &format!("{}/{id}/rounds", rq_path(env)),
        json!({
            "client_request_id": "r1",
            "expected_revision": 1,
            "mode": "team",
            "agent_id": "opencode",
            "leader_name": "Lead",
            "instruction": "Run an experiment.",
            "team_mode": "standard",
            "allowed_agent_ids": ["opencode"],
            "envelope": envelope(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{round}");
    (
        id,
        round["id"].as_str().expect("round").to_owned(),
        round["team"]["id"].as_str().expect("team").to_owned(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_finished_experiment_wakes_its_owner_once_with_the_result() {
    let env = env(true);
    let (rq, round_id, team_id) = started_team_round(&env).await;
    let team = env.state.teams.get_team(&team_id).expect("team");
    let leader_conversation = env
        .state
        .teams
        .get_member(&team.leader_member_id)
        .expect("leader")
        .conversation_id;
    let store = env.state.agent_runtime.store();
    wait_for(
        || {
            store
                .list_runs(&leader_conversation)
                .map(|r| {
                    !r.is_empty()
                        && r.iter().all(|run| {
                            !matches!(
                                run.status,
                                RunStatus::Running | RunStatus::WaitingPermission
                            )
                        })
                })
                .unwrap_or(false)
        },
        "the start run to finish",
    )
    .await;
    let runs_before = store.list_runs(&leader_conversation).expect("runs").len();

    // The Leader launches and yields; the process ends on its own.
    let (status, started) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/research/{rq}/rounds/{round_id}/execution/experiments", env.project_id),
        json!({"launch_key": "baseline", "argv": ["sh", "-c", "sleep 0.4; echo done"], "label": "baseline"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let experiment_id = started["id"].as_str().expect("experiment").to_owned();
    env.state
        .experiments
        .register_wait(
            &env.project_id,
            &team_id,
            &team.leader_member_id,
            &experiment_id,
            None,
            "analyze",
            None,
        )
        .expect("wait");

    // The committed result wakes the idle owner with a new run that carries it.
    wait_for(
        || {
            store
                .list_runs(&leader_conversation)
                .map(|r| r.len() > runs_before)
                .unwrap_or(false)
        },
        "the owner to be woken with the result",
    )
    .await;
    let runs = store.list_runs(&leader_conversation).expect("runs");
    assert!(
        runs.iter()
            .skip(runs_before)
            .any(|run| run.message.contains("baseline")),
        "the woken run carries the experiment result: {:?}",
        runs.iter().map(|r| r.message.clone()).collect::<Vec<_>>()
    );
    wait_for(
        || {
            store
                .list_runs(&leader_conversation)
                .map(|r| {
                    r.iter().all(|run| {
                        !matches!(
                            run.status,
                            RunStatus::Running | RunStatus::WaitingPermission
                        )
                    })
                })
                .unwrap_or(false)
        },
        "the woken run to finish",
    )
    .await;
    // One observation produced one wake; nothing is left undelivered, but
    // the result is still owed an analysis.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        store.list_runs(&leader_conversation).expect("runs").len(),
        runs_before + 1
    );
    assert!(
        env.state
            .teams
            .pending_messages(&team.leader_member_id)
            .expect("pending")
            .is_empty()
    );
    let experiment = env
        .state
        .experiments
        .get(&experiment_id)
        .expect("experiment");
    assert_eq!(format!("{:?}", experiment.analysis), "Pending");
}

/// Starts a Team round, waits for its start run, and returns what a test
/// needs to launch and observe an experiment.
async fn idle_team(env: &Env) -> (String, String, String, String) {
    let (rq, round_id, team_id) = started_team_round(env).await;
    let team = env.state.teams.get_team(&team_id).expect("team");
    let leader = env
        .state
        .teams
        .get_member(&team.leader_member_id)
        .expect("leader");
    let store = env.state.agent_runtime.store();
    wait_for(
        || {
            store
                .list_runs(&leader.conversation_id)
                .map(|runs| {
                    !runs.is_empty()
                        && runs.iter().all(|run| {
                            !matches!(
                                run.status,
                                RunStatus::Running | RunStatus::WaitingPermission
                            )
                        })
                })
                .unwrap_or(false)
        },
        "the start run to finish",
    )
    .await;
    (rq, round_id, team_id, leader.conversation_id)
}

fn run_count(env: &Env, conversation: &str) -> usize {
    env.state
        .agent_runtime
        .store()
        .list_runs(conversation)
        .expect("runs")
        .len()
}

async fn launch_quick(env: &Env, rq: &str, round_id: &str, key: &str) -> String {
    let (status, started) = call(
        env,
        Method::POST,
        &format!(
            "/projects/{}/research/{rq}/rounds/{round_id}/execution/experiments",
            env.project_id
        ),
        json!({"launch_key": key, "argv": ["sh", "-c", "sleep 0.3"], "label": key}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    started["id"].as_str().expect("experiment").to_owned()
}

/// Runs that carried this experiment's result to the owner.
fn runs_with(env: &Env, conversation: &str, label: &str) -> usize {
    env.state
        .agent_runtime
        .store()
        .list_runs(conversation)
        .expect("runs")
        .iter()
        .filter(|run| run.message.contains(label))
        .count()
}

async fn finished(env: &Env, experiment: &str) {
    wait_for(
        || {
            env.state
                .experiments
                .get(experiment)
                .map(|e| !e.state.is_active())
                .unwrap_or(false)
        },
        "the experiment to finish",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wake_lost_after_the_commit_is_recovered_by_the_supervisor() {
    let env = env(true);
    let (rq, round_id, _team_id, leader) = idle_team(&env).await;
    // The commit succeeds but the wake is lost (a crash between the two).
    env.state.experiments.set_delivery_hook(|_| {});
    let before = run_count(&env, &leader);
    let experiment = launch_quick(&env, &rq, &round_id, "lost-wake").await;
    finished(&env, &experiment).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(run_count(&env, &leader), before, "nothing woke the owner");

    // The obligation is a committed row; the next supervisor pass finds it.
    env.state.reconcile_teams_once().await.expect("reconcile");
    wait_for(
        || runs_with(&env, &leader, "lost-wake") == 1,
        "the supervisor to wake the owner with the result",
    )
    .await;
    // Reconciling again does not carry the same result a second time.
    env.state.reconcile_teams_once().await.expect("reconcile");
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(runs_with(&env, &leader, "lost-wake"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_paused_team_keeps_the_event_pending_and_resumes_from_current_state() {
    let env = env(true);
    let (rq, round_id, team_id, leader) = idle_team(&env).await;
    let before = run_count(&env, &leader);
    let experiment = launch_quick(&env, &rq, &round_id, "paused").await;
    env.state.teams.pause_team(&team_id).expect("pause");
    finished(&env, &experiment).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        run_count(&env, &leader),
        before,
        "a paused Team is not woken"
    );
    let team = env.state.teams.get_team(&team_id).expect("team");
    assert!(
        !env.state
            .teams
            .pending_messages(&team.leader_member_id)
            .expect("pending")
            .is_empty(),
        "the event waits for the Team"
    );

    env.state.teams.resume_team(&team_id).expect("resume");
    env.state.reconcile_teams_once().await.expect("reconcile");
    wait_for(
        || runs_with(&env, &leader, "paused") == 1,
        "the resumed Team to be woken with the result",
    )
    .await;
}
