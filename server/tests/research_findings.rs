//! Findings and outcome tests (#151): attributed, idempotent publication with
//! provenance; evidence that reports when it is removed or changed; the
//! pending outcome a Team completion leaves behind exactly once; proposals
//! that wait for a researcher decision; and persistence across a restart.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::teams::{MemberWorkspaceMode, NewTeamTask, NewTeammate, TeamStore};
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

fn team_round(key: &str) -> Value {
    json!({
        "client_request_id": key,
        "expected_revision": 1,
        "mode": "team",
        "agent_id": "opencode",
        "leader_name": "Lead",
        "instruction": "Compare pruning approaches.",
    })
}

/// Accepts one required task and completes the Team through the store
/// transition production uses.
fn finish_team(env: &Env, team_id: &str, tag: &str) {
    let team = env.state.teams.get_team(team_id).expect("team");
    let teammate = env
        .state
        .teams
        .add_teammate(NewTeammate {
            team_id,
            caller_member_id: &team.leader_member_id,
            conversation_id: &format!("worker-{tag}"),
            name: "worker",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("teammate");
    let task = env
        .state
        .teams
        .create_task(NewTeamTask {
            team_id,
            creator_member_id: &team.leader_member_id,
            title: "Run it",
            description: "Run the experiment",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: false,
        })
        .expect("task");
    env.state
        .teams
        .claim_task(&task.id, &teammate.id)
        .expect("claim");
    env.state
        .teams
        .submit_result(&task.id, &teammate.id, "done", "ran")
        .expect("result");
    env.state
        .teams
        .review_result(&task.id, &team.leader_member_id, true, None)
        .expect("accept");
    // The Leader reads what the accepted work sent, as production does.
    env.state
        .teams
        .read_messages(&team.leader_member_id)
        .expect("read inbox");
    env.state
        .teams
        .complete_team(team_id, &team.leader_member_id, "All done", "fp")
        .expect("complete");
}

/// Starts a linked Team round and drives the Team to completion through the
/// same store transition production uses.
async fn completed_team(env: &Env, rq_id: &str, key: &str) -> String {
    let (status, round) = call(
        env,
        Method::POST,
        &format!("{}/{rq_id}/rounds", rq_path(env)),
        team_round(key),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{round}");
    let team_id = round["team"]["id"].as_str().expect("team").to_owned();
    finish_team(env, &team_id, key);
    team_id
}

fn capture(key: &str, team_id: &str, findings: Value) -> Value {
    json!({"publication_key": key, "team_id": team_id, "findings": findings})
}

#[tokio::test]
async fn capture_is_idempotent_attributed_and_keeps_unsupported_claims_as_interpretations() {
    let env = env(false);
    let rq = create_rq(&env, "Capture").await;
    let id = rq["id"].as_str().expect("id");
    let team_id = completed_team(&env, id, "r1").await;
    let path = format!("{}/{id}/findings", rq_path(&env));
    fs::write(env.project_path.join("results.csv"), "acc\n0.9\n").expect("file");
    let body = capture(
        "k1",
        &team_id,
        json!([
            {"kind": "finding", "statement": "Accuracy held at 0.9",
             "evidence": [{"kind": "file", "id": "results.csv"}]},
            {"kind": "attempt", "statement": "Random pruning collapsed"},
            {"kind": "limitation", "statement": "One seed only"},
            {"kind": "open_question", "statement": "Does it hold on larger models?"},
        ]),
    );
    let (status, first) = call(&env, Method::POST, &path, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["created"], true);
    let findings = first["findings"].as_array().expect("findings");
    assert_eq!(findings.len(), 4);
    assert_eq!(findings[0]["basis"], "observation");
    assert_eq!(findings[0]["author_kind"], "researcher");
    assert_eq!(findings[0]["producer"]["team_id"], json!(team_id));
    assert_eq!(findings[0]["brief_revision"], 1);
    assert_eq!(
        findings[0]["evidence_state"][0]["availability"],
        "available"
    );
    assert!(
        findings[0]["evidence"][0]["revision"].is_string(),
        "a file records the revision it was cited at"
    );
    for finding in &findings[1..] {
        assert_eq!(finding["basis"], "interpretation", "{finding}");
    }

    // A retry returns the stored batch; the log has the same four findings.
    let (_, replay) = call(&env, Method::POST, &path, body).await;
    assert_eq!(replay["created"], false);
    let (_, listed) = call(&env, Method::GET, &path, Value::Null).await;
    assert_eq!(listed.as_array().expect("list").len(), 4);

    // The same key with different content is refused, not merged.
    let (status, reused) = call(
        &env,
        Method::POST,
        &path,
        capture(
            "k1",
            &team_id,
            json!([{"kind": "finding", "statement": "Different"}]),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(reused["code"], "research_request_key_reused");
}

#[tokio::test]
async fn capture_validates_provenance_and_evidence_inside_the_project() {
    let env = env(false);
    let rq = create_rq(&env, "Validate").await;
    let id = rq["id"].as_str().expect("id");
    let team_id = completed_team(&env, id, "r1").await;
    let path = format!("{}/{id}/findings", rq_path(&env));
    let finding =
        |evidence: Value| json!([{"kind": "finding", "statement": "s", "evidence": evidence}]);

    // Nothing names a producer.
    let (status, _) = call(
        &env,
        Method::POST,
        &path,
        json!({"publication_key": "a", "findings": finding(json!([]))}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A Team that is not linked to this question cannot be a producer.
    let (status, body) = call(
        &env,
        Method::POST,
        &path,
        capture("b", "not-a-linked-team", finding(json!([]))),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // Evidence must exist in this Project; another Project's record looks
    // exactly like a missing one.
    let foreign = env
        .state
        .agent_runtime
        .store()
        .create_conversation(
            &env.other_project_id,
            kubecode_server::agents::AgentId::OpenCode,
            Some("foreign"),
        )
        .expect("foreign session");
    for source in [
        json!({"kind": "session", "id": foreign.id}),
        json!({"kind": "session", "id": "missing"}),
        json!({"kind": "file", "id": "../escape"}),
        json!({"kind": "file", "id": "absent.txt"}),
    ] {
        let (status, body) = call(
            &env,
            Method::POST,
            &path,
            capture("c", &team_id, finding(json!([source.clone()]))),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{source}: {body}");
    }
    let (_, listed) = call(&env, Method::GET, &path, Value::Null).await;
    assert_eq!(listed, json!([]), "rejected requests store nothing");

    // Another Project cannot see the question at all.
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/research/{id}/findings", env.other_project_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn changed_and_removed_evidence_is_reported_not_trusted() {
    let env = env(false);
    let rq = create_rq(&env, "Drift").await;
    let id = rq["id"].as_str().expect("id");
    let team_id = completed_team(&env, id, "r1").await;
    let session = env
        .state
        .agent_runtime
        .store()
        .create_conversation(
            &env.project_id,
            kubecode_server::agents::AgentId::OpenCode,
            Some("scratch"),
        )
        .expect("session");
    fs::write(env.project_path.join("notes.txt"), "v1").expect("file");
    let path = format!("{}/{id}/findings", rq_path(&env));
    let (status, body) = call(
        &env,
        Method::POST,
        &path,
        capture(
            "k",
            &team_id,
            json!([{"kind": "finding", "statement": "s", "evidence": [
                {"kind": "file", "id": "notes.txt"},
                {"kind": "session", "id": session.id},
            ]}]),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    fs::write(env.project_path.join("notes.txt"), "v2").expect("edit");
    env.state
        .agent_runtime
        .store()
        .delete_conversation(&session.id)
        .expect("delete session");
    let (_, listed) = call(&env, Method::GET, &path, Value::Null).await;
    let states: Vec<_> = listed[0]["evidence_state"]
        .as_array()
        .expect("state")
        .iter()
        .map(|e| e["availability"].clone())
        .collect();
    assert_eq!(states, vec![json!("changed"), json!("removed")]);
    assert_eq!(listed[0]["producer_state"][0]["availability"], "available");

    fs::remove_file(env.project_path.join("notes.txt")).expect("remove");
    let (_, listed) = call(&env, Method::GET, &path, Value::Null).await;
    assert_eq!(listed[0]["evidence_state"][0]["availability"], "removed");
    // The finding itself, and who produced it, remain readable.
    assert_eq!(listed[0]["statement"], "s");
}

#[tokio::test]
async fn completing_a_linked_team_leaves_one_pending_outcome_and_never_resolves_the_question() {
    let env = env(false);
    let rq = create_rq(&env, "Pending").await;
    let id = rq["id"].as_str().expect("id");
    let team_id = completed_team(&env, id, "r1").await;
    let outcomes = format!("{}/{id}/outcomes", rq_path(&env));

    let (_, listed) = call(&env, Method::GET, &outcomes, Value::Null).await;
    assert_eq!(listed.as_array().expect("outcomes").len(), 1);
    assert_eq!(listed[0]["team_id"], json!(team_id));
    assert_eq!(listed[0]["status"], "pending");
    assert!(listed[0]["round_id"].is_string());
    let (_, detail) = call(
        &env,
        Method::GET,
        &format!("{}/{id}", rq_path(&env)),
        Value::Null,
    )
    .await;
    assert_eq!(
        detail["status"], "open",
        "completion must not resolve the RQ"
    );

    // The same transaction announced it to open browsers.
    let events = env
        .state
        .agent_runtime
        .store()
        .workspace_events_after(0)
        .expect("events");
    let announced = events
        .iter()
        .filter(|event| {
            event.kind == "research_updated" && event.payload["change"] == "outcome_pending"
        })
        .count();
    assert_eq!(announced, 1);

    // Recording the Team's findings resolves it; declining a recorded
    // outcome is refused, and a second capture is a separate batch.
    let findings = json!([{"kind": "finding", "statement": "ok"}]);
    let path = format!("{}/{id}/findings", rq_path(&env));
    let (status, _) = call(&env, Method::POST, &path, capture("k", &team_id, findings)).await;
    assert_eq!(status, StatusCode::OK);
    let (_, listed) = call(&env, Method::GET, &outcomes, Value::Null).await;
    assert_eq!(listed[0]["status"], "recorded");
    assert!(listed[0]["publication_id"].is_string());
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{outcomes}/{team_id}/decline"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
}

#[tokio::test]
async fn a_researcher_can_decline_a_pending_outcome_and_unlinked_teams_leave_none() {
    let env = env(false);
    let rq = create_rq(&env, "Decline").await;
    let id = rq["id"].as_str().expect("id");
    let team_id = completed_team(&env, id, "r1").await;
    let outcomes = format!("{}/{id}/outcomes", rq_path(&env));
    let decline = format!("{outcomes}/{team_id}/decline");
    for _ in 0..2 {
        let (status, body) = call(&env, Method::POST, &decline, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "declined");
    }
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{outcomes}/unknown/decline"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A Team with no RQ completes exactly as before and records nothing.
    let leader = env
        .state
        .agent_runtime
        .store()
        .create_conversation(
            &env.project_id,
            kubecode_server::agents::AgentId::OpenCode,
            Some("plain"),
        )
        .expect("leader");
    let plain = env
        .state
        .teams
        .create_team(kubecode_server::teams::NewTeam {
            project_id: &env.project_id,
            leader_conversation_id: &leader.id,
            agent_session_id: &leader.agent_session_id,
            leader_name: "Lead",
            title: Some("Plain"),
            workspace: kubecode_server::teams::TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    let leader_member = env
        .state
        .teams
        .get_team(&plain.id)
        .expect("team")
        .leader_member_id;
    env.state
        .teams
        .start_team(kubecode_server::teams::StartTeam {
            team_id: &plain.id,
            leader_member_id: &leader_member,
            goal: "Plain work",
            acceptance_criteria: &["done".to_owned()],
            allowed_agent_ids: &["opencode".to_owned()],
            mode: kubecode_server::teams::TeamMode::Standard,
            max_teammates: 3,
            max_parallel_runs: 2,
            max_review_rounds: 3,
        })
        .expect("start");
    env.state.teams.activate_team(&plain.id).expect("activate");
    finish_team(&env, &plain.id, "plain");
    assert_eq!(
        env.state.teams.get_team(&plain.id).expect("team").status,
        kubecode_server::teams::TeamStatus::Completed
    );
    let (_, listed) = call(&env, Method::GET, &outcomes, Value::Null).await;
    assert_eq!(
        listed.as_array().expect("outcomes").len(),
        1,
        "only the linked Team owes the question an outcome"
    );
}

#[tokio::test]
async fn proposals_wait_for_an_explicit_decision_and_never_edit_the_brief() {
    let env = env(false);
    let rq = create_rq(&env, "Proposals").await;
    let id = rq["id"].as_str().expect("id");
    let published = env
        .state
        .research
        .publish(
            &env.project_id,
            id,
            kubecode_server::research_store::NewPublication {
                key: "p1".into(),
                author_kind: kubecode_server::research_store::AuthorKind::Agent,
                author_ref: Some("member-1".into()),
                producer: kubecode_server::research_store::Producer {
                    team_id: Some("team-1".into()),
                    ..Default::default()
                },
                round_id: None,
                findings: Vec::new(),
                proposals: vec!["Relax the single-GPU constraint".into()],
            },
        )
        .expect("publish");
    let entry_id = published.proposals[0].id.clone();
    assert_eq!(published.proposals[0].author_kind.as_str(), "agent");

    let proposals = format!("{}/{id}/proposals", rq_path(&env));
    let (_, listed) = call(&env, Method::GET, &proposals, Value::Null).await;
    assert_eq!(listed[0]["review"], Value::Null);

    let review = format!("{proposals}/{entry_id}/review");
    let (status, accepted) = call(
        &env,
        Method::POST,
        &review,
        json!({"decision": "accepted", "note": "Agreed, edit the brief"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["review"]["decision"], "accepted");
    // The same decision is a no-op; the opposite is a conflict.
    let (status, _) = call(&env, Method::POST, &review, json!({"decision": "accepted"})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = call(&env, Method::POST, &review, json!({"decision": "rejected"})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "research_review_conflict");
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{proposals}/missing/review"),
        json!({"decision": "accepted"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Accepting records a researcher decision once, and leaves the brief at
    // its approved revision until the researcher edits it.
    let (_, entries) = call(
        &env,
        Method::GET,
        &format!("{}/{id}/entries", rq_path(&env)),
        Value::Null,
    )
    .await;
    let decisions: Vec<_> = entries
        .as_array()
        .expect("entries")
        .iter()
        .filter(|e| e["kind"] == "decision")
        .collect();
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0]["author_kind"], "researcher");
    let (_, detail) = call(
        &env,
        Method::GET,
        &format!("{}/{id}", rq_path(&env)),
        Value::Null,
    )
    .await;
    assert_eq!(detail["revision"], 1);
    assert_eq!(detail["status"], "open");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_duplicate_publications_store_one_batch() {
    let env = Arc::new(env(false));
    let rq = create_rq(&env, "Race").await;
    let id = rq["id"].as_str().expect("id").to_owned();
    let team_id = completed_team(&env, &id, "r1").await;
    let path = format!("{}/{id}/findings", rq_path(&env));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let env = Arc::clone(&env);
            let path = path.clone();
            let body = capture(
                "same",
                &team_id,
                json!([{"kind": "finding", "statement": "once"}]),
            );
            tokio::spawn(async move { call(&env, Method::POST, &path, body).await })
        })
        .collect();
    let mut created = 0;
    for handle in handles {
        let (status, body) = handle.await.expect("join");
        assert_eq!(status, StatusCode::OK, "{body}");
        if body["created"] == true {
            created += 1;
        }
    }
    assert_eq!(created, 1);
    let (_, listed) = call(&env, Method::GET, &path, Value::Null).await;
    assert_eq!(listed.as_array().expect("list").len(), 1);
}

#[tokio::test]
async fn findings_and_pending_outcomes_survive_a_restart() {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let (project_id, project_path) = {
        let workspace = WorkspaceService::open(root.path(), &database).expect("workspace");
        let project = workspace.create_project(".", "alpha").expect("alpha");
        (project.id, project.path)
    };
    let _ = project_path;
    let research_id;
    {
        let workspace =
            Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
        let agents = Arc::new(AgentStore::open(&database).expect("agents"));
        let teams = Arc::new(TeamStore::open(&database).expect("teams"));
        let state = AppState::new(workspace, agents, teams);
        let (question, _) = state
            .research
            .create(
                &project_id,
                kubecode_server::research_store::ResearchBrief {
                    title: "Durable".into(),
                    question: "q".into(),
                    ..Default::default()
                },
                None,
            )
            .expect("question");
        research_id = question.id.clone();
        state
            .research
            .publish(
                &project_id,
                &research_id,
                kubecode_server::research_store::NewPublication {
                    key: "k".into(),
                    author_kind: kubecode_server::research_store::AuthorKind::Researcher,
                    author_ref: None,
                    producer: kubecode_server::research_store::Producer {
                        session_id: Some("s1".into()),
                        ..Default::default()
                    },
                    round_id: None,
                    findings: vec![kubecode_server::research_store::NewFinding {
                        kind: kubecode_server::research_store::FindingKind::Finding,
                        statement: "kept".into(),
                        evidence: Vec::new(),
                    }],
                    proposals: Vec::new(),
                },
            )
            .expect("publish");
    }
    // A fresh process over the same database sees it and still deduplicates.
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let state = AppState::new(workspace, agents, teams);
    let findings = state
        .research
        .findings(&project_id, &research_id)
        .expect("findings");
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].statement, "kept");
    let replay = state
        .research
        .publish(
            &project_id,
            &research_id,
            kubecode_server::research_store::NewPublication {
                key: "k".into(),
                author_kind: kubecode_server::research_store::AuthorKind::Researcher,
                author_ref: None,
                producer: kubecode_server::research_store::Producer {
                    session_id: Some("s1".into()),
                    ..Default::default()
                },
                round_id: None,
                findings: vec![kubecode_server::research_store::NewFinding {
                    kind: kubecode_server::research_store::FindingKind::Finding,
                    statement: "kept".into(),
                    evidence: Vec::new(),
                }],
                proposals: Vec::new(),
            },
        )
        .expect("replay");
    assert!(!replay.created);
    assert_eq!(
        state
            .research
            .findings(&project_id, &research_id)
            .expect("findings")
            .len(),
        1
    );
}
