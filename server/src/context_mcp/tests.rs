use serde_json::{Value, json};

use super::*;
use crate::agents::{AgentId, PermissionMode};
use crate::experiment_store::testing::Fixture;
use crate::experiment_store::{ArtifactRevision, Outcome};
use crate::research_store::{BriefPatch, NewRound, RoundKind};

struct Rig {
    f: Fixture,
    runtime: AgentRuntime,
}

fn rig() -> Rig {
    let f = Fixture::new();
    let state = AppState::new(
        std::sync::Arc::clone(&f.workspace),
        std::sync::Arc::clone(&f.agents),
        std::sync::Arc::clone(&f.teams),
    )
    .with_team_mcp_http_origin("http://127.0.0.1:9999/base");
    let runtime = state.agent_runtime.as_ref().clone();
    Rig { f, runtime }
}

fn server_for(runtime: &AgentRuntime, conversation_id: &str) -> Option<ContextMcpServer> {
    tool_context(runtime.clone(), conversation_id)
        .expect("context")
        .map(ContextMcpServer::new)
}

fn payload(result: Result<CallToolResult, McpError>) -> Value {
    let result = result.expect("tool result");
    let value = serde_json::to_value(&result).expect("serialize");
    let text = value["content"][0]["text"].as_str().expect("text content");
    serde_json::from_str(text).expect("json payload")
}

impl Rig {
    /// A completed experiment whose artifact exists, so there is evidence to read.
    fn experiment(&self) -> crate::experiment_store::Experiment {
        let root = self.f.workspace.project_path(&self.f.project_id).unwrap();
        std::fs::write(root.join("curve.txt"), "loss=0.12\n").unwrap();
        let mut request = crate::experiment_store::testing::launch(
            &self.f.round_id,
            &self.f.team,
            "mcp",
            &["echo", "train"],
        );
        request.label = "pruning baseline".into();
        request.artifacts = vec!["curve.txt".into()];
        let (experiment, _) = self
            .f
            .experiments
            .reserve(&self.f.project_id, &self.f.research_id, request)
            .unwrap();
        self.f.experiments.mark_launching(&experiment.id).unwrap();
        let revision = self
            .f
            .workspace
            .execution_file_revision(&self.f.project_id, None, "curve.txt")
            .ok();
        self.f
            .experiments
            .observe(
                &experiment.id,
                Outcome {
                    state: Some(crate::experiment_store::ExperimentState::Exited),
                    exit_code: Some(0),
                    artifact_revisions: vec![ArtifactRevision {
                        path: "curve.txt".into(),
                        revision,
                    }],
                    ..Outcome::default()
                },
            )
            .unwrap();
        experiment
    }

    fn prior_session(&self) -> crate::agent_store::Conversation {
        let session = self
            .f
            .agents
            .create_conversation(
                &self.f.project_id,
                AgentId::OpenCode,
                Some("Earlier pruning sweep"),
            )
            .unwrap();
        self.f
            .agents
            .start_run(
                &session.id,
                &self.f.project_id,
                "Sweep sparsity 0.5",
                PermissionMode::Safe,
            )
            .unwrap();
        session
    }

    fn solo_round(
        &self,
    ) -> (
        crate::agent_store::Conversation,
        crate::research_store::ResearchRound,
    ) {
        let session = self
            .f
            .agents
            .create_conversation(&self.f.project_id, AgentId::OpenCode, Some("Solo round"))
            .unwrap();
        let (round, _) = self
            .f
            .research
            .begin_round(
                &self.f.project_id,
                &self.f.research_id,
                NewRound {
                    kind: RoundKind::Solo,
                    idempotency_key: "solo",
                    expected_revision: 1,
                    request: json!({"instruction": "Try structured pruning"}),
                    sources: Vec::new(),
                },
            )
            .unwrap();
        self.f
            .research
            .round_set_session(
                &self.f.project_id,
                &self.f.research_id,
                &round.id,
                &session.id,
            )
            .unwrap();
        (session, round)
    }
}

/// The scenario both a fresh Solo Session and a Team member must complete.
async fn discover_and_read(server: &ContextMcpServer, session_id: &str, experiment_id: &str) {
    let found = payload(
        server
            .context_search(Parameters(SearchInput {
                query: Some("pruning".into()),
                ..Default::default()
            }))
            .await,
    );
    let items = found["items"].as_array().unwrap();
    let session = items
        .iter()
        .find(|item| item["ref"]["kind"] == "session" && item["ref"]["id"] == session_id)
        .expect("the prior Session is discoverable");
    assert_eq!(session["title"], "Earlier pruning sweep");
    let experiment = items
        .iter()
        .find(|item| item["ref"]["kind"] == "experiment" && item["ref"]["id"] == experiment_id)
        .expect("the prior experiment is discoverable");
    assert!(experiment["ref"]["revision"].is_string());

    let doc = payload(
        server
            .context_read(Parameters(ReadInput {
                kind: "session".into(),
                id: session_id.into(),
                revision: None,
                detail: Some("content".into()),
                cursor: None,
            }))
            .await,
    );
    let turn = doc["related"][0]["ref"].clone();
    assert_eq!(turn["kind"], "session_turn");
    let turn_doc = payload(
        server
            .context_read(Parameters(ReadInput {
                kind: "session_turn".into(),
                id: turn["id"].as_str().unwrap().into(),
                revision: turn["revision"].as_str().map(str::to_owned),
                detail: Some("content".into()),
                cursor: None,
            }))
            .await,
    );
    assert!(turn_doc.to_string().contains("Sweep sparsity 0.5"));

    let evidence = payload(
        server
            .context_read(Parameters(ReadInput {
                kind: "experiment".into(),
                id: experiment_id.into(),
                revision: None,
                detail: Some("evidence".into()),
                cursor: None,
            }))
            .await,
    );
    assert!(evidence.to_string().contains("curve.txt (unchanged)"));
    let artifact = payload(
        server
            .context_read(Parameters(ReadInput {
                kind: "artifact".into(),
                id: format!("{experiment_id}/curve.txt"),
                revision: None,
                detail: Some("content".into()),
                cursor: None,
            }))
            .await,
    );
    assert!(artifact.to_string().contains("loss=0.12"));
}

#[tokio::test]
async fn a_fresh_solo_session_discovers_prior_work_and_reads_evidence() {
    let rig = rig();
    let experiment = rig.experiment();
    let prior = rig.prior_session();
    let (fresh, _) = rig.solo_round();
    let server = server_for(&rig.runtime, &fresh.id).expect("every Session has context tools");
    discover_and_read(&server, &prior.id, &experiment.id).await;
}

#[tokio::test]
async fn a_team_member_reads_through_the_same_interface() {
    let rig = rig();
    let experiment = rig.experiment();
    let prior = rig.prior_session();
    let member = &rig.f.teammate.conversation_id;
    let server = server_for(&rig.runtime, member).expect("Team members have context tools");
    discover_and_read(&server, &prior.id, &experiment.id).await;
}

#[tokio::test]
async fn the_caller_project_comes_from_its_session_not_an_argument() {
    let rig = rig();
    rig.experiment();
    let other = rig.f.workspace.create_project(".", "beta").unwrap();
    let outsider = rig
        .f
        .agents
        .create_conversation(&other.id, AgentId::OpenCode, Some("outsider"))
        .unwrap();
    let server = server_for(&rig.runtime, &outsider.id).unwrap();
    let found = payload(
        server
            .context_search(Parameters(SearchInput::default()))
            .await,
    );
    assert_eq!(
        found["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["title"] != "outsider")
            .count(),
        0,
        "another Project's work is invisible"
    );
    let denied = server
        .context_read(Parameters(ReadInput {
            kind: "research".into(),
            id: rig.f.research_id.clone(),
            revision: None,
            detail: None,
            cursor: None,
        }))
        .await;
    assert!(denied.is_err());
    // There is no Project argument to forge.
    let schema = serde_json::to_string(&schemars::schema_for!(ReadInput)).unwrap();
    assert!(!schema.contains("project"));
}

#[tokio::test]
async fn hidden_and_unknown_sessions_get_no_context_tools() {
    let rig = rig();
    let hidden = rig
        .f
        .agents
        .create_conversation(&rig.f.project_id, AgentId::OpenCode, Some("snapshot"))
        .unwrap();
    rig.f
        .agents
        .database()
        .lock()
        .unwrap()
        .execute(
            "UPDATE conversations SET internal_revision = 1 WHERE id = ?1",
            [&hidden.id],
        )
        .unwrap();
    assert!(server_for(&rig.runtime, &hidden.id).is_none());
    assert!(server_for(&rig.runtime, "does-not-exist").is_none());
}

#[tokio::test]
async fn round_delivery_is_pinned_and_identical_in_shape_for_solo_and_team() {
    let rig = rig();
    let (solo, solo_round) = rig.solo_round();
    rig.f
        .research
        .update_brief(
            &rig.f.project_id,
            &rig.f.research_id,
            1,
            &BriefPatch {
                title: Some("Pruning, revised".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let solo_server = server_for(&rig.runtime, &solo.id).unwrap();
    let team_server = server_for(&rig.runtime, &rig.f.teammate.conversation_id).unwrap();
    let solo_delivery = payload(solo_server.context_round().await)["research"].clone();
    let team_delivery = payload(team_server.context_round().await)["research"].clone();
    for delivery in [&solo_delivery, &team_delivery] {
        assert_eq!(
            delivery["brief_revision"], 1,
            "the round keeps its pinned direction"
        );
        assert_eq!(delivery["current_revision"], 2);
        assert_eq!(delivery["stale"], true);
        assert_eq!(delivery["brief"]["title"], "Pruning", "not the live title");
    }
    assert_eq!(solo_delivery["instruction"], "Try structured pruning");
    assert_eq!(solo_delivery["round"], solo_round.round);
    let keys = |value: &Value| {
        let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(&solo_delivery), keys(&team_delivery));
    // team_get_context carries the very same delivery.
    let direct = crate::team_mcp::round_delivery(
        &rig.runtime,
        &rig.f.project_id,
        &rig.f
            .research
            .round(&rig.f.project_id, &rig.f.research_id, &rig.f.round_id)
            .unwrap(),
    );
    assert_eq!(direct, team_delivery);
}

#[tokio::test]
async fn a_session_outside_any_round_has_no_research_section() {
    let rig = rig();
    let plain = rig.prior_session();
    let server = server_for(&rig.runtime, &plain.id).unwrap();
    assert_eq!(
        payload(server.context_round().await)["research"],
        Value::Null
    );
}

#[tokio::test]
async fn changed_and_removed_sources_are_explicit_in_round_delivery() {
    let rig = rig();
    let root = rig.f.workspace.project_path(&rig.f.project_id).unwrap();
    std::fs::write(root.join("plan.md"), "v1").unwrap();
    let revision = rig
        .f
        .workspace
        .file_revision(&rig.f.project_id, "plan.md")
        .unwrap();
    let session = rig
        .f
        .agents
        .create_conversation(&rig.f.project_id, AgentId::OpenCode, Some("with sources"))
        .unwrap();
    let (round, _) = rig
        .f
        .research
        .begin_round(
            &rig.f.project_id,
            &rig.f.research_id,
            NewRound {
                kind: RoundKind::Solo,
                idempotency_key: "sources",
                expected_revision: 1,
                request: json!({"instruction": "x"}),
                sources: vec![crate::research_store::SourceRef {
                    kind: crate::research_store::SourceKind::File,
                    id: "plan.md".into(),
                    revision: Some(revision),
                }],
            },
        )
        .unwrap();
    rig.f
        .research
        .round_set_session(
            &rig.f.project_id,
            &rig.f.research_id,
            &round.id,
            &session.id,
        )
        .unwrap();
    let server = server_for(&rig.runtime, &session.id).unwrap();
    let availability =
        |delivery: &Value| delivery["research"]["sources"][0]["availability"].clone();
    assert_eq!(
        availability(&payload(server.context_round().await)),
        "available"
    );
    std::fs::write(root.join("plan.md"), "v2").unwrap();
    assert_eq!(
        availability(&payload(server.context_round().await)),
        "changed"
    );
    std::fs::remove_file(root.join("plan.md")).unwrap();
    assert_eq!(
        availability(&payload(server.context_round().await)),
        "removed"
    );
}

#[tokio::test]
async fn reading_has_no_execution_side_effects() {
    let rig = rig();
    let experiment = rig.experiment();
    let prior = rig.prior_session();
    let (solo, _) = rig.solo_round();
    let snapshot = |rig: &Rig| {
        let database = rig.f.agents.database();
        let connection = database.lock().unwrap();
        let count = |table: &str| -> i64 {
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        let state: String = connection
            .query_row("SELECT group_concat(status) FROM team_tasks", [], |row| {
                row.get::<_, Option<String>>(0)
            })
            .unwrap()
            .unwrap_or_default();
        (
            count("agent_runs"),
            count("team_tasks"),
            count("team_messages"),
            count("experiments"),
            count("research_entries"),
            count("research_rounds"),
            count("research_findings"),
            count("conversations"),
            state,
        )
    };
    let before = snapshot(&rig);
    let server = server_for(&rig.runtime, &solo.id).unwrap();
    let team_server = server_for(&rig.runtime, &rig.f.leader.conversation_id).unwrap();
    for server in [&server, &team_server] {
        let _ = server.context_round().await;
        let _ = server
            .context_search(Parameters(SearchInput::default()))
            .await;
        for (kind, id) in [
            ("research", rig.f.research_id.clone()),
            ("round", rig.f.round_id.clone()),
            ("team", rig.f.team.id.clone()),
            ("team_task", rig.f.task_id.clone()),
            ("experiment", experiment.id.clone()),
            ("session", prior.id.clone()),
        ] {
            server
                .context_read(Parameters(ReadInput {
                    kind: kind.into(),
                    id,
                    revision: None,
                    detail: Some("evidence".into()),
                    cursor: None,
                }))
                .await
                .unwrap_or_else(|error| panic!("{kind} read failed: {error:?}"));
        }
        server
            .context_resolve(Parameters(ResolveInput {
                refs: vec![RefInput {
                    kind: "session".into(),
                    id: prior.id.clone(),
                    revision: None,
                }],
            }))
            .await
            .expect("resolve");
    }
    assert_eq!(before, snapshot(&rig));
}

#[test]
fn the_server_exposes_only_the_four_read_only_tools() {
    let names: Vec<String> = ContextMcpServer::tool_router()
        .list_all()
        .into_iter()
        .map(|tool| tool.name.to_string())
        .collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        vec![
            "context_read",
            "context_resolve",
            "context_round",
            "context_search"
        ]
    );
    assert!(names.iter().all(|name| name.starts_with("context_")));
}

#[tokio::test]
async fn bad_input_is_a_client_error_not_a_guess() {
    let rig = rig();
    let session = rig.prior_session();
    let server = server_for(&rig.runtime, &session.id).unwrap();
    for result in [
        server
            .context_search(Parameters(SearchInput {
                kinds: vec!["bogus".into()],
                ..Default::default()
            }))
            .await,
        server
            .context_read(Parameters(ReadInput {
                kind: "session".into(),
                id: session.id.clone(),
                revision: None,
                detail: Some("everything".into()),
                cursor: None,
            }))
            .await,
        server
            .context_resolve(Parameters(ResolveInput {
                refs: (0..40)
                    .map(|n| RefInput {
                        kind: "session".into(),
                        id: n.to_string(),
                        revision: None,
                    })
                    .collect(),
            }))
            .await,
    ] {
        let error = result.expect_err("rejected");
        assert_eq!(error.code, rmcp::model::ErrorCode::INVALID_PARAMS);
    }
}

#[test]
fn context_servers_are_advertised_to_every_session_and_alongside_the_team_server() {
    let rig = rig();
    let names = |conversation_id: &str| -> Vec<String> {
        rig.runtime
            .mcp_http_servers(conversation_id)
            .unwrap()
            .into_iter()
            .map(|server| match server {
                agent_client_protocol::schema::v1::McpServer::Http(http) => http.name,
                _ => "other".into(),
            })
            .collect()
    };
    let solo = rig.prior_session();
    assert_eq!(names(&solo.id), vec!["kubecode-context"]);
    assert_eq!(
        names(&rig.f.teammate.conversation_id),
        vec!["kubecode-team", "kubecode-context"]
    );
    assert!(names("does-not-exist").is_empty());
    // Without the HTTP origin there is nothing to advertise.
    let bare = AppState::new(
        std::sync::Arc::clone(&rig.f.workspace),
        std::sync::Arc::clone(&rig.f.agents),
        std::sync::Arc::clone(&rig.f.teams),
    );
    assert!(
        bare.agent_runtime
            .mcp_http_servers(&solo.id)
            .unwrap()
            .is_empty()
    );
}

/// Drives the real HTTP transport the way an Agent does: initialize, list the
/// tools, call one. The URL (token included) is the one advertised to the Agent.
#[tokio::test]
async fn the_advertised_url_serves_the_tools_and_a_wrong_token_is_refused() {
    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request, header};
    use tower::ServiceExt;

    let f = Fixture::new();
    let state = AppState::new(
        std::sync::Arc::clone(&f.workspace),
        std::sync::Arc::clone(&f.agents),
        std::sync::Arc::clone(&f.teams),
    )
    .with_team_mcp_http_origin("http://127.0.0.1:9999/base");
    let app = crate::api::app_router(state.clone(), "/base");
    let session = f
        .agents
        .create_conversation(&f.project_id, AgentId::OpenCode, Some("http caller"))
        .unwrap();
    let url = match state
        .agent_runtime
        .mcp_http_servers(&session.id)
        .unwrap()
        .remove(0)
    {
        agent_client_protocol::schema::v1::McpServer::Http(http) => http.url,
        _ => panic!("expected an HTTP server"),
    };
    let path = url
        .strip_prefix("http://127.0.0.1:9999")
        .unwrap()
        .to_owned();

    let rpc = |path: String, session_id: Option<String>, body: Value| {
        let app = app.clone();
        async move {
            let mut request = Request::builder()
                .method(Method::POST)
                .uri(path)
                .header(header::HOST, "127.0.0.1:9999")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json, text/event-stream");
            if let Some(id) = session_id {
                request = request.header("mcp-session-id", id);
            }
            let response = app
                .oneshot(request.body(Body::from(body.to_string())).unwrap())
                .await
                .unwrap();
            let status = response.status();
            let session_header = response
                .headers()
                .get("mcp-session-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            (
                status,
                session_header,
                String::from_utf8_lossy(&bytes).into_owned(),
            )
        }
    };

    let bad = path.replace(path.split('/').nth_back(1).unwrap(), "not-the-token");
    let (status, _, _) = rpc(bad, None, json!({})).await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);

    let (status, session_id, body) = rpc(
        path.clone(),
        None,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-03-26","capabilities":{},
            "clientInfo":{"name":"test","version":"0"}}}),
    )
    .await;
    assert!(status.is_success(), "{status} {body}");
    assert!(body.contains("kubecode-context"), "{body}");
    let session_id = session_id.expect("session id");
    let (status, _, _) = rpc(
        path.clone(),
        Some(session_id.clone()),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    assert!(status.is_success());
    let (_, _, listed) = rpc(
        path.clone(),
        Some(session_id.clone()),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await;
    for tool in [
        "context_round",
        "context_search",
        "context_read",
        "context_resolve",
    ] {
        assert!(listed.contains(tool), "{tool} missing: {listed}");
    }
    let (_, _, called) = rpc(
        path,
        Some(session_id),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
               "params":{"name":"context_search","arguments":{"query":"pruning","kinds":["research"]}}}),
    )
    .await;
    assert!(called.contains("Pruning"), "{called}");
}

fn publish_as(
    rig: &Rig,
    key: &str,
    author: crate::research_store::AuthorKind,
    statements: &[String],
    evidence: Vec<crate::research_store::SourceRef>,
) {
    use crate::research_store::{FindingKind, NewFinding, NewPublication, Producer};
    rig.f
        .research
        .publish(
            &rig.f.project_id,
            &rig.f.research_id,
            NewPublication {
                key: key.into(),
                author_kind: author,
                author_ref: Some("tester".into()),
                producer: Producer::default(),
                round_id: Some(rig.f.round_id.clone()),
                findings: statements
                    .iter()
                    .map(|statement| NewFinding {
                        kind: FindingKind::Finding,
                        statement: statement.clone(),
                        evidence: evidence.clone(),
                    })
                    .collect(),
                proposals: Vec::new(),
            },
        )
        .expect("publish");
}

#[tokio::test]
async fn delivery_carries_attributed_findings_and_earlier_rounds() {
    use crate::research_store::AuthorKind;
    let rig = rig();
    publish_as(
        &rig,
        "a",
        AuthorKind::Agent,
        &["Agent claim".into()],
        Vec::new(),
    );
    publish_as(
        &rig,
        "b",
        AuthorKind::Researcher,
        &["Researcher note".into()],
        Vec::new(),
    );
    let (solo, _) = rig.solo_round();
    let server = server_for(&rig.runtime, &solo.id).unwrap();
    let delivery = payload(server.context_round().await)["research"].clone();
    let findings = delivery["findings"].as_array().unwrap();
    assert_eq!(findings.len(), 2);
    let by_statement = |statement: &str| {
        findings
            .iter()
            .find(|f| f["statement"] == statement)
            .unwrap_or_else(|| panic!("{statement} missing"))
            .clone()
    };
    assert_eq!(by_statement("Agent claim")["author_kind"], "agent");
    assert_eq!(by_statement("Researcher note")["author_kind"], "researcher");
    assert_eq!(by_statement("Agent claim")["brief_revision"], 1);
    // The Team round that came first is visible as prior-round context, and
    // a fresh Agent can follow it to the Leader's Session.
    let earlier = &delivery["previous_rounds"][0];
    assert_eq!(earlier["round"], 1);
    assert_eq!(earlier["team_id"], rig.f.team.id);
    assert_eq!(earlier["team_title"], "Team");
    assert!(earlier["session_id"].is_string());
    assert!(delivery["execution"].is_object());
}

#[tokio::test]
async fn round_delivery_stays_bounded_however_much_history_exists() {
    use crate::research_store::{AuthorKind, SourceKind, SourceRef};
    use crate::team_mcp::{
        CONTEXT_FINDING_CHARS, CONTEXT_FINDINGS, PREVIOUS_ROUNDS, PREVIOUS_SUMMARY_CHARS,
    };
    let rig = rig();
    let evidence: Vec<_> = (0..10)
        .map(|n| SourceRef {
            kind: SourceKind::Session,
            id: format!("missing-{n}"),
            revision: None,
        })
        .collect();
    let long = |n: usize| format!("claim-{n:02} {}", "x".repeat(3_900));
    // Two publications of 15 findings each: more than the delivery shows.
    for (key, offset) in [("p1", 0usize), ("p2", 15)] {
        let statements: Vec<String> = (offset..offset + 15).map(long).collect();
        publish_as(&rig, key, AuthorKind::Agent, &statements, evidence.clone());
    }
    {
        let database = rig.f.agents.database();
        database
            .lock()
            .unwrap()
            .execute(
                "UPDATE teams SET final_summary = ?1 WHERE id = ?2",
                rusqlite::params!["s".repeat(10_000), rig.f.team.id],
            )
            .unwrap();
    }
    for n in 0..8 {
        rig.f
            .research
            .begin_round(
                &rig.f.project_id,
                &rig.f.research_id,
                NewRound {
                    kind: RoundKind::Solo,
                    idempotency_key: &format!("older-{n}"),
                    expected_revision: 1,
                    request: json!({"instruction": "earlier"}),
                    sources: Vec::new(),
                },
            )
            .unwrap();
    }
    let (solo, solo_round) = rig.solo_round();
    assert!(solo_round.round > PREVIOUS_ROUNDS as u64 + 1);
    let server = server_for(&rig.runtime, &solo.id).unwrap();
    let text = serde_json::to_string(&payload(server.context_round().await)).unwrap();
    let delivery: Value = serde_json::from_str(&text).unwrap();
    let delivery = &delivery["research"];

    let findings = delivery["findings"].as_array().unwrap();
    assert_eq!(findings.len(), CONTEXT_FINDINGS);
    assert!(
        findings[0]["statement"]
            .as_str()
            .unwrap()
            .starts_with("claim-29"),
        "newest first"
    );
    for finding in findings {
        assert!(finding["statement"].as_str().unwrap().chars().count() <= CONTEXT_FINDING_CHARS);
        assert!(finding["evidence"].as_array().unwrap().len() <= 10);
        assert_eq!(finding["evidence"][0]["availability"], "removed");
    }
    let previous = delivery["previous_rounds"].as_array().unwrap();
    assert_eq!(previous.len(), PREVIOUS_ROUNDS);
    assert!(
        previous[0]["round"].as_u64() > previous[1]["round"].as_u64(),
        "newest first"
    );
    for round in previous {
        if let Some(summary) = round["final_summary"].as_str() {
            assert!(summary.chars().count() <= PREVIOUS_SUMMARY_CHARS);
        }
    }
    assert!(text.len() < 96 * 1024, "delivery is {} bytes", text.len());
}

#[tokio::test]
async fn a_session_whose_team_has_no_round_falls_back_to_its_own_solo_round() {
    let rig = rig();
    // A Team with no research round, whose leader also owns a Solo round.
    let leader = rig
        .f
        .agents
        .create_conversation(&rig.f.project_id, AgentId::OpenCode, Some("promoted"))
        .unwrap();
    let (round, _) = rig
        .f
        .research
        .begin_round(
            &rig.f.project_id,
            &rig.f.research_id,
            NewRound {
                kind: RoundKind::Solo,
                idempotency_key: "promoted",
                expected_revision: 1,
                request: json!({"instruction": "x"}),
                sources: Vec::new(),
            },
        )
        .unwrap();
    rig.f
        .research
        .round_set_session(&rig.f.project_id, &rig.f.research_id, &round.id, &leader.id)
        .unwrap();
    let team = rig
        .f
        .teams
        .create_team(crate::teams::NewTeam {
            project_id: &rig.f.project_id,
            leader_conversation_id: &leader.id,
            agent_session_id: &leader.agent_session_id,
            leader_name: "Lead",
            title: Some("No round"),
            workspace: crate::teams::TeamWorkspace::Shared,
            workspace_path: None,
        })
        .unwrap();
    assert!(rig.f.research.round_for_team(&team.id).unwrap().is_none());
    let server = server_for(&rig.runtime, &leader.id).unwrap();
    let delivery = payload(server.context_round().await)["research"].clone();
    assert_eq!(delivery["instruction"], "x");
}

#[test]
fn credentials_are_scoped_to_one_server_and_one_conversation() {
    let rig = rig();
    let member = rig.f.teammate.conversation_id.clone();
    let solo = rig.prior_session();
    let token_of = |conversation_id: &str, name: &str| -> String {
        rig.runtime
            .mcp_http_servers(conversation_id)
            .unwrap()
            .into_iter()
            .find_map(|server| match server {
                agent_client_protocol::schema::v1::McpServer::Http(http) if http.name == name => {
                    http.url.rsplit('/').nth(1).map(str::to_owned)
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name} not advertised"))
    };
    let team_token = token_of(&member, "kubecode-team");
    let context_token = token_of(&member, "kubecode-context");
    let solo_context = token_of(&solo.id, "kubecode-context");
    assert_ne!(team_token, context_token);
    assert!(rig.runtime.authorize_mcp("team", &member, &team_token));
    assert!(
        rig.runtime
            .authorize_mcp("context", &member, &context_token)
    );
    // The read-only credential every Session holds cannot open the Team server...
    assert!(!rig.runtime.authorize_mcp("team", &member, &context_token));
    assert!(!rig.runtime.authorize_mcp("team", &member, &solo_context));
    // ...nor any other conversation's route.
    assert!(!rig.runtime.authorize_mcp("context", &member, &solo_context));
    assert!(
        !rig.runtime
            .authorize_mcp("team", &rig.f.leader.conversation_id, &team_token)
    );
    assert!(!rig.runtime.authorize_mcp("context", &member, ""));
}
