//! The #173 milestone flow end to end (deterministic fixtures, no real Agent):
//! a researcher imports an outside discussion, reviews it into an approved
//! brief revision, starts a round that cites it, a fresh Solo Session discovers
//! prior work and reads evidence through the shared reader, a finding is
//! published and then referenced from another Session, the researcher exports
//! open questions, and a follow-up imported against a changed brief never
//! silently replaces newer direction.
//!
//! These are deterministic fixtures, not a real Agent: the fresh Agent's
//! discovery goes through the same HTTP routes the context tools wrap (the MCP
//! transport itself is covered in `context_mcp`'s tests), and the finding is
//! published through the research store as the Team tool would. The experiment
//! step of the milestone is covered by the context reader and `context_mcp`
//! tests.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_store::{AgentEventKind, AgentStore, RunStatus};
use kubecode_server::agents::{AgentId, PermissionMode};
use kubecode_server::api::{AppState, app_router};
use kubecode_server::research_store::{
    AuthorKind, FindingKind, NewFinding, NewPublication, Producer, SourceKind, SourceRef,
};
use kubecode_server::teams::TeamStore;
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE: &str = "/user/alice/kubecode";

const AGENT: &str = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"flow-session\"}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"stopReason\":\"end_turn\"}}"
      ;;
  esac
done"#;

struct Env {
    _root: TempDir,
    state: AppState,
    app: Router,
    store: Arc<AgentStore>,
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
    let binary = root.path().join("mock-agent");
    fs::write(&binary, format!("#!/bin/sh\n{AGENT}\n")).expect("mock");
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).expect("chmod");
    let state =
        AppState::new(workspace, Arc::clone(&agents), teams).with_agents(vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: binary.to_string_lossy().into_owned(),
            error: None,
        }]);
    let app = app_router(state.clone(), BASE);
    Env {
        _root: root,
        state,
        app,
        store: agents,
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
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

const DISCUSSION: &str = "\
# Call with the pruning group

## Decisions
- Use structured pruning only

## Constraints
- No more than one GPU

## Open questions
- Does the effect survive a different seed?
- What is the cost of retraining after pruning?
";

#[tokio::test]
async fn import_review_round_discovery_reference_export_and_stale_reimport() {
    let env = env();
    let p = env.project_id.clone();
    let rq_base = format!("/projects/{p}/research");

    // -- A question with an approved brief, and earlier work in the Project.
    let (status, rq) = call(
        &env,
        Method::POST,
        &rq_base,
        json!({"title": "Pruning", "question": "Does structured pruning hold accuracy?"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{rq}");
    let rq_id = rq["id"].as_str().unwrap().to_owned();
    let prior = env
        .store
        .create_conversation(&p, AgentId::OpenCode, Some("Earlier pruning sweep"))
        .unwrap();
    let prior_run = env
        .store
        .start_run(&prior.id, &p, "Sweep sparsity 0.5", PermissionMode::Safe)
        .unwrap();
    let delta = json!({"message_id": "m", "text": "Accuracy held at 91 percent."});
    env.store
        .append_runtime_update(
            &prior.id,
            "text_delta",
            &delta,
            Some((&prior_run.id, AgentEventKind::TextDelta, &delta)),
        )
        .unwrap();
    env.store
        .set_run_status(&prior_run.id, RunStatus::Completed)
        .unwrap();

    // -- Import an outside discussion: attributed source material, nothing starts.
    let runs_before = env.store.list_project_runs(&p).unwrap().len();
    let (status, imported) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/imports"),
        json!({
            "origin": "markdown", "label": "Call with the pruning group",
            "content": DISCUSSION, "client_request_id": "import-1"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{imported}");
    let import_id = imported["id"].as_str().unwrap().to_owned();
    assert_eq!(
        (
            imported["based_on_revision"].clone(),
            imported["stale"].clone()
        ),
        (json!(1), json!(false))
    );
    assert_eq!(
        env.store.list_project_runs(&p).unwrap().len(),
        runs_before,
        "importing starts no Agent"
    );
    let (_, detail) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(detail["revision"], 1, "importing edits no brief");
    assert!(
        env.state.research.findings(&p, &rq_id).unwrap().is_empty(),
        "importing creates no finding"
    );

    // A repeated import request returns the original.
    let (status, again) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/imports"),
        json!({"origin": "markdown", "label": "Call with the pruning group",
               "content": DISCUSSION, "client_request_id": "import-1"}),
    )
    .await;
    assert_eq!(
        (status, again["id"].clone()),
        (StatusCode::OK, json!(import_id))
    );

    // -- Review: candidates are suggestions; applying one is a revision-checked edit.
    let (_, reviewed) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/imports/{import_id}"),
        Value::Null,
    )
    .await;
    let candidates = reviewed["candidates"].as_array().unwrap();
    let kinds: Vec<_> = candidates
        .iter()
        .map(|c| c["kind"].as_str().unwrap())
        .collect();
    assert!(
        kinds.contains(&"decision")
            && kinds.contains(&"constraint")
            && kinds.contains(&"open_question")
    );
    let (status, applied) = call(
        &env,
        Method::PATCH,
        &format!("{rq_base}/{rq_id}"),
        json!({"expected_revision": 1, "import_id": import_id,
               "constraints": ["No more than one GPU"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["revision"], 2);
    let (_, revisions) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/revisions"),
        Value::Null,
    )
    .await;
    let note = revisions[0]["note"].as_str().unwrap_or_default();
    assert!(
        note.contains("From imported discussion \"Call with the pruning group\""),
        "{revisions}"
    );
    // Neither an invented import nor another question's can be named as the
    // source of an edit.
    let (_, other_rq) = call(
        &env,
        Method::POST,
        &rq_base,
        json!({"title": "Other", "question": "Q?"}),
    )
    .await;
    let other_rq_id = other_rq["id"].as_str().unwrap().to_owned();
    let (_, other_import) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{other_rq_id}/imports"),
        json!({"origin": "paste", "label": "Elsewhere", "content": "Constraint: elsewhere"}),
    )
    .await;
    for foreign in ["not-an-import", other_import["id"].as_str().unwrap()] {
        let (status, _) = call(
            &env,
            Method::PATCH,
            &format!("{rq_base}/{rq_id}"),
            json!({"expected_revision": 2, "import_id": foreign, "title": "Hijack"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{foreign}");
    }
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/rounds"),
        json!({"client_request_id": "cross", "expected_revision": 2, "mode": "solo",
               "agent_id": "opencode", "sources": [{"kind": "import", "id": other_import["id"]}]}),
    )
    .await;
    assert!(
        status.is_client_error(),
        "another question's import cannot be cited by a round"
    );
    let (_, unchanged) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(unchanged["revision"], 2);

    // -- An explicit handoff: the existing round action, citing the import and
    // the prior Session; a repeated request reuses the round.
    let start = json!({
        "client_request_id": "go-1", "expected_revision": 2, "mode": "solo",
        "agent_id": "opencode", "instruction": "Try structured pruning at 0.5",
        "sources": [
            {"kind": "import", "id": import_id},
            {"kind": "session", "id": prior.id},
        ]
    });
    let (status, round) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/rounds"),
        start.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{round}");
    let round_id = round["id"].as_str().unwrap().to_owned();
    assert_eq!(round["brief_revision"], 2);
    let source_kinds: Vec<_> = round["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["kind"].as_str().unwrap())
        .collect();
    assert!(
        source_kinds.contains(&"import") && source_kinds.contains(&"session"),
        "{round}"
    );
    let (status, replay) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/rounds"),
        start,
    )
    .await;
    assert!(status.is_success(), "{replay}");
    assert_eq!(
        replay["id"],
        json!(round_id),
        "the same request reuses the round"
    );
    let (_, listed) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/rounds"),
        Value::Null,
    )
    .await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    let fresh_session = round["session_id"]
        .as_str()
        .unwrap_or_else(|| round["session"]["id"].as_str().unwrap())
        .to_owned();

    // -- A fresh Agent discovers prior work and reads selected evidence.
    let ctx = format!("/projects/{p}/context");
    let (_, found) = call(
        &env,
        Method::GET,
        &format!("{ctx}/search?q=pruning"),
        Value::Null,
    )
    .await;
    let items = found["items"].as_array().unwrap();
    assert!(
        items
            .iter()
            .any(|i| i["ref"]["kind"] == "session" && i["ref"]["id"] == json!(prior.id))
    );
    assert!(
        items
            .iter()
            .any(|i| i["ref"]["kind"] == "import" && i["ref"]["id"] == json!(import_id))
    );
    let turn_ref = format!("{}/{}", prior.id, prior_run.id);
    let (_, turn) = call(
        &env,
        Method::GET,
        &format!("{ctx}/read?kind=session_turn&id={turn_ref}&detail=content"),
        Value::Null,
    )
    .await;
    assert!(turn.to_string().contains("Accuracy held at 91 percent."));
    let (_, import_doc) = call(
        &env,
        Method::GET,
        &format!("{ctx}/read?kind=import&id={import_id}&detail=evidence"),
        Value::Null,
    )
    .await;
    let text = import_doc.to_string();
    assert!(
        text.contains("source material") || text.contains("Imported discussion"),
        "{text}"
    );
    assert!(text.contains("Does the effect survive a different seed?"));

    // -- The Agent publishes a finding citing what it read.
    let publication = env
        .state
        .research
        .publish(
            &p,
            &rq_id,
            NewPublication {
                key: "flow-1".into(),
                author_kind: AuthorKind::Agent,
                author_ref: Some("solo".into()),
                producer: Producer {
                    session_id: Some(fresh_session.clone()),
                    ..Producer::default()
                },
                round_id: Some(round_id.clone()),
                findings: vec![
                    NewFinding {
                        kind: FindingKind::Finding,
                        statement: "Structured pruning at 0.5 keeps accuracy within one point"
                            .into(),
                        evidence: vec![SourceRef {
                            kind: SourceKind::Session,
                            id: prior.id.clone(),
                            revision: None,
                        }],
                    },
                    NewFinding {
                        kind: FindingKind::Limitation,
                        statement: "Only one seed was tried".into(),
                        evidence: vec![],
                    },
                ],
                proposals: vec![],
            },
        )
        .unwrap();
    let finding_id = publication.findings[0].id.clone();

    // -- Another Session references that work; the typed reference is
    // re-resolved server-side and the finding reaches the prompt.
    let other_session = env
        .store
        .create_conversation(&p, AgentId::OpenCode, Some("Follow-up chat"))
        .unwrap();
    let (status, registration) = call(
        &env,
        Method::POST,
        &format!("/sessions/{}/composer/contexts", other_session.id),
        json!({"kind": "project_context", "path": format!("finding:{finding_id}")}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{registration}");
    let (status, run) = call(
        &env,
        Method::POST,
        &format!("/projects/{p}/sessions/{}/runs", other_session.id),
        json!({
            "catalog_revision": registration["catalog"]["revision"],
            "segments": [
                {"kind": "text", "text": "Build on "},
                {"kind": "context_ref", "id": registration["context"]["id"],
                 "catalog_revision": registration["catalog"]["revision"],
                 "context_kind": "project_context"}
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{run}");
    assert!(
        run["message"]
            .as_str()
            .unwrap()
            .contains("Structured pruning at 0.5 keeps accuracy")
    );
    assert_eq!(
        env.state.research.get(&p, &rq_id).unwrap().revision,
        2,
        "cross-question references never change the question or its association"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if env
                .store
                .get_run(run["id"].as_str().unwrap())
                .unwrap()
                .status
                != RunStatus::Running
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the referencing run completes");

    // -- Export: a bounded packet, previewed before anything leaves.
    let (status, packet) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/export"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{packet}");
    let markdown = packet["markdown"].as_str().unwrap();
    assert_eq!(packet["brief_revision"], 2);
    assert!(markdown.contains("brief revision 2"));
    assert!(markdown.contains("Structured pruning at 0.5 keeps accuracy"));
    assert!(markdown.contains("Only one seed was tried"));
    assert!(
        markdown.contains("Does the effect survive a different seed?"),
        "open questions from the import"
    );
    assert!(markdown.contains("not verified results"));
    assert!(
        !markdown.contains("Sweep sparsity 0.5") && !markdown.contains("Accuracy held at 91"),
        "no transcripts leave"
    );
    assert!(packet["total_bytes"].as_u64().unwrap() <= 33 * 1024);
    let (status, subset) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/export?sections=brief"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        !subset["markdown"]
            .as_str()
            .unwrap()
            .contains("Only one seed was tried")
    );
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/export?sections=bogus"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // -- Meanwhile the researcher moves the direction on; a follow-up written
    // against the older brief is flagged, never silently applied.
    let (status, moved) = call(
        &env,
        Method::PATCH,
        &format!("{rq_base}/{rq_id}"),
        json!({"expected_revision": 2, "question": "Does structured pruning hold accuracy across seeds?"}),
    )
    .await;
    assert_eq!(
        (status, moved["revision"].clone()),
        (StatusCode::OK, json!(3))
    );
    let (status, followup) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/imports"),
        json!({"origin": "paste", "label": "Colleague reply", "based_on_revision": 2,
               "content": "Constraint: use two seeds minimum\nWhat about magnitude pruning?"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{followup}");
    assert_eq!(
        (
            followup["stale"].clone(),
            followup["current_revision"].clone()
        ),
        (json!(true), json!(3))
    );
    let followup_id = followup["id"].as_str().unwrap();
    let (status, conflict) = call(
        &env,
        Method::PATCH,
        &format!("{rq_base}/{rq_id}"),
        json!({"expected_revision": 2, "import_id": followup_id, "constraints": ["use two seeds minimum"]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    assert_eq!(conflict["current_revision"], 3);
    let (_, after) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(after["revision"], 3, "the newer direction stands");
    assert_eq!(
        after["brief"]["question"],
        "Does structured pruning hold accuracy across seeds?"
    );
    assert!(
        after["brief"]["constraints"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c != "use two seeds minimum")
    );
    // The follow-up is kept for review, not lost.
    let (_, imports) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/imports"),
        Value::Null,
    )
    .await;
    assert_eq!(imports.as_array().unwrap().len(), 2);
    // Reviewed against the current brief, it applies.
    let (status, ok) = call(
        &env,
        Method::PATCH,
        &format!("{rq_base}/{rq_id}"),
        json!({"expected_revision": 3, "import_id": followup_id, "constraints": ["No more than one GPU", "use two seeds minimum"]}),
    )
    .await;
    assert_eq!((status, ok["revision"].clone()), (StatusCode::OK, json!(4)));

    // -- The running round keeps the direction it was started with.
    let (_, round_now) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/rounds/{round_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(
        (
            round_now["brief_revision"].clone(),
            round_now["stale"].clone()
        ),
        (json!(2), json!(true))
    );

    // -- Scope: another Project sees none of it.
    let other = format!("/projects/{}/context", env.other_project_id);
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("{other}/read?kind=import&id={import_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &env,
        Method::GET,
        &format!(
            "/projects/{}/research/{rq_id}/imports",
            env.other_project_id
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn imports_are_validated_scoped_and_citable_only_when_real() {
    let env = env();
    let p = env.project_id.clone();
    let rq_base = format!("/projects/{p}/research");
    let (_, rq) = call(
        &env,
        Method::POST,
        &rq_base,
        json!({"title": "A", "question": "Q?"}),
    )
    .await;
    let rq_id = rq["id"].as_str().unwrap().to_owned();
    let imports = format!("{rq_base}/{rq_id}/imports");
    let valid =
        json!({"origin": "paste", "label": "Notes", "content": "hello", "client_request_id": "k1"});

    for (body, why) in [
        (
            json!({"origin": "paste", "label": "Notes", "content": "   "}),
            "empty text",
        ),
        (
            json!({"origin": "paste", "label": " ", "content": "x"}),
            "empty label",
        ),
        (
            json!({"origin": "paste", "label": "n", "content": "x".repeat(64 * 1024 + 1)}),
            "too large",
        ),
        (
            json!({"origin": "paste", "label": "n", "content": "x", "based_on_revision": 9}),
            "future revision",
        ),
        (
            json!({"origin": "pdf", "label": "n", "content": "x"}),
            "unknown origin",
        ),
    ] {
        let (status, body) = call(&env, Method::POST, &imports, body).await;
        assert!(status.is_client_error(), "{why}: {status} {body}");
    }
    let (status, first) = call(&env, Method::POST, &imports, valid.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{first}");
    // The same key with other text is a conflict, never a silent replacement.
    let mut other = valid.clone();
    other["content"] = json!("different");
    let (status, body) = call(&env, Method::POST, &imports, other).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (_, listed) = call(&env, Method::GET, &imports, Value::Null).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);

    // Another question's import id is not found under this one.
    let (_, rq2) = call(
        &env,
        Method::POST,
        &rq_base,
        json!({"title": "B", "question": "Q2?"}),
    )
    .await;
    let rq2_id = rq2["id"].as_str().unwrap();
    let (status, _) = call(
        &env,
        Method::GET,
        &format!(
            "{rq_base}/{rq2_id}/imports/{}",
            first["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A round can cite only an import that exists in this Project.
    let round = |source: Value, key: &str| {
        json!({
            "client_request_id": key, "expected_revision": 1, "mode": "solo",
            "agent_id": "opencode", "sources": [source]
        })
    };
    let rounds = format!("{rq_base}/{rq_id}/rounds");
    let (status, body) = call(
        &env,
        Method::POST,
        &rounds,
        round(json!({"kind": "import", "id": "invented"}), "r1"),
    )
    .await;
    assert!(status.is_client_error(), "{status} {body}");
    assert!(
        env.state.research.rounds(&p, &rq_id).unwrap().is_empty(),
        "a refused source creates no round"
    );
    let (status, body) = call(
        &env,
        Method::POST,
        &rounds,
        round(json!({"kind": "import", "id": first["id"]}), "r2"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let cited = body["sources"][0].clone();
    assert_eq!(
        (cited["kind"].clone(), cited["availability"].clone()),
        (json!("import"), json!("available"))
    );

    // An archived question takes no new imports.
    call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/archive"),
        Value::Null,
    )
    .await;
    let (status, _) = call(
        &env,
        Method::POST,
        &imports,
        json!({"origin": "paste", "label": "n", "content": "x"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn the_packet_is_budgeted_per_section_and_the_attribution_of_an_edit_is_never_cut() {
    let env = env();
    let p = env.project_id.clone();
    let rq_base = format!("/projects/{p}/research");
    let (_, rq) = call(
        &env,
        Method::POST,
        &rq_base,
        json!({"title": "Big", "question": "Q?"}),
    )
    .await;
    let rq_id = rq["id"].as_str().unwrap().to_owned();

    // Far more findings than fit, plus a limitation that must still be exported.
    let long = "z".repeat(550);
    for batch in 0..4 {
        env.state
            .research
            .publish(
                &p,
                &rq_id,
                NewPublication {
                    key: format!("big-{batch}"),
                    author_kind: AuthorKind::Agent,
                    author_ref: None,
                    producer: Producer::default(),
                    round_id: None,
                    findings: (0..10)
                        .map(|n| NewFinding {
                            kind: FindingKind::Finding,
                            statement: format!("claim {batch}-{n} {long}"),
                            evidence: vec![],
                        })
                        .collect(),
                    proposals: vec![],
                },
            )
            .unwrap();
    }
    env.state
        .research
        .publish(
            &p,
            &rq_id,
            NewPublication {
                key: "limit".into(),
                author_kind: AuthorKind::Agent,
                author_ref: None,
                producer: Producer::default(),
                round_id: None,
                findings: vec![NewFinding {
                    kind: FindingKind::Limitation,
                    statement: "Only one seed was tried".into(),
                    evidence: vec![],
                }],
                proposals: vec![],
            },
        )
        .unwrap();
    let (status, packet) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/export"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{packet}");
    let markdown = packet["markdown"].as_str().unwrap();
    assert!(packet["total_bytes"].as_u64().unwrap() <= 32 * 1024);
    let section = |id: &str| {
        packet["sections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(section("findings")["truncated"], true);
    assert!(section("findings")["bytes"].as_u64().unwrap() <= 6 * 1024 + 64);
    // A long section never pushes out the ones after it.
    assert!(
        markdown.contains("Only one seed was tried"),
        "the limitation survives"
    );
    assert_eq!(packet["truncated"], true);

    // Only what is asked for is built and reported.
    let (_, brief_only) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/export?sections=brief"),
        Value::Null,
    )
    .await;
    assert_eq!(
        section_flags(&brief_only),
        vec![
            ("brief", true),
            ("progress", false),
            ("findings", false),
            ("evidence", false),
            ("open_questions", false)
        ]
    );
    assert!(
        !brief_only["markdown"]
            .as_str()
            .unwrap()
            .contains("claim 0-0")
    );
    let (status, _) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/export?sections="),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A source note is never cut to make room: a note too long to leave room is refused.
    let (_, imported) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/imports"),
        json!({"origin": "paste", "label": "Attribution", "content": "Constraint: c"}),
    )
    .await;
    let (status, body) = call(
        &env,
        Method::PATCH,
        &format!("{rq_base}/{rq_id}"),
        json!({"expected_revision": 1, "import_id": imported["id"], "note": "n".repeat(480), "title": "T2"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, ok) = call(
        &env,
        Method::PATCH,
        &format!("{rq_base}/{rq_id}"),
        json!({"expected_revision": 1, "import_id": imported["id"], "note": "short", "title": "T2"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ok}");
    let (_, revisions) = call(
        &env,
        Method::GET,
        &format!("{rq_base}/{rq_id}/revisions"),
        Value::Null,
    )
    .await;
    assert!(
        revisions[0]["note"]
            .as_str()
            .unwrap()
            .contains("From imported discussion \"Attribution\"")
    );

    // Idempotency: the same key with another label is a conflict, and a replay
    // still returns the original after the question is archived.
    let first =
        json!({"origin": "paste", "label": "Same", "content": "text", "client_request_id": "idem"});
    let (status, created) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/imports"),
        first.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let mut relabelled = first.clone();
    relabelled["label"] = json!("Different");
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/imports"),
        relabelled,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/archive"),
        Value::Null,
    )
    .await;
    let (status, replay) = call(
        &env,
        Method::POST,
        &format!("{rq_base}/{rq_id}/imports"),
        first,
    )
    .await;
    assert_eq!(
        (status, replay["id"].clone()),
        (StatusCode::OK, created["id"].clone())
    );
}

fn section_flags(packet: &Value) -> Vec<(&str, bool)> {
    packet["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["id"].as_str().unwrap(), s["included"].as_bool().unwrap()))
        .collect()
}
