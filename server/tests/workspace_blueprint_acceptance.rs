//! The Research Workspace blueprint (#199) as one deterministic story across
//! its parts, under a non-root base path: a researcher's remark reaches the
//! project manager; a proposal is shown; a specialist's words and a quoted line
//! never admit it; the researcher's own instruction does, once; the Task
//! survives a restart; the manager delegates and refuses to execute; the
//! specialist reports in public; the researcher reviews evidence that changed,
//! accepts a negative finding, and iterates; another Workspace and a private
//! direct message see none of it.
//!
//! The agents are the real services driven through their own entry points
//! (`WorkAgent` is what the MCP tools call), so every authority check is the
//! production one. A real model's judgement is not exercised.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::{AgentId, PermissionMode};
use kubecode_server::api::{AppState, app_router};
use kubecode_server::orchestrator::{DeliveryOutcome, DeliveryRequest, RouteSink};
use kubecode_server::research_store::ResearchBrief;
use kubecode_server::teams::TeamStore;
use kubecode_server::work_agent::{Evidence, NewTask, ReportStatus, WorkAgent};
use kubecode_server::work_store::ResultRole;
use kubecode_server::workspace::WorkspaceService;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const BASE: &str = "/user/alice/kubecode";

struct World {
    root: TempDir,
    app: Router,
    state: AppState,
    agents: Arc<AgentStore>,
    project: String,
    other: String,
    path: PathBuf,
}

fn open(root: &std::path::Path) -> (Router, AppState, Arc<AgentStore>, Arc<WorkspaceService>) {
    let database = root.join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root, &database).expect("workspace"));
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let state =
        AppState::new(Arc::clone(&workspace), Arc::clone(&agents), teams).with_agents(vec![
            AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: "/bin/true".into(),
                error: None,
            },
        ]);
    (app_router(state.clone(), BASE), state, agents, workspace)
}

fn world() -> World {
    let root = TempDir::new().expect("tempdir");
    let (app, state, agents, workspace) = open(root.path());
    let alpha = workspace.create_project(".", "alpha").expect("alpha");
    let beta = workspace.create_project(".", "beta").expect("beta");
    let path = workspace.project_path(&alpha.id).expect("path");
    World {
        root,
        app,
        state,
        agents,
        project: alpha.id,
        other: beta.id,
        path,
    }
}

/// A new process on the same state directory: every store reopened.
fn restart(world: &mut World) {
    let (app, state, agents, _) = open(world.root.path());
    world.app = app;
    world.state = state;
    world.agents = agents;
}

async fn call(world: &World, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
    let response = world
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

#[derive(Default)]
struct Recording {
    delivered: Mutex<Vec<(String, String)>>,
}

impl Recording {
    fn to(&self) -> Vec<(String, String)> {
        self.delivered.lock().unwrap().clone()
    }
}

impl RouteSink for Recording {
    fn deliver(&self, request: &DeliveryRequest<'_>) -> DeliveryOutcome {
        self.delivered
            .lock()
            .unwrap()
            .push((request.conversation_id.to_owned(), request.body.to_owned()));
        DeliveryOutcome::Delivered
    }
}

fn member(world: &World, project: &str, conversation: &str) -> WorkAgent {
    WorkAgent::new(
        project.to_owned(),
        conversation.to_owned(),
        Arc::clone(&world.state.work),
        Arc::clone(&world.state.channels),
        Arc::clone(&world.state.orchestrator),
        Arc::clone(&world.state.research),
        Arc::clone(&world.agents),
        Arc::new(|_| true),
    )
    .with_members(Arc::clone(&world.state.members))
    .with_tasks(Arc::clone(&world.state.tasks))
    .with_evidence(Evidence::new(
        world.state.context.clone(),
        Arc::clone(&world.state.workspace),
    ))
}

async fn roster(world: &World, project: &str) -> Value {
    call(
        world,
        Method::GET,
        &format!("/projects/{project}/members"),
        Value::Null,
    )
    .await
    .1
}

fn public(members: &Value, handle: &str) -> String {
    members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["handle"] == handle)
        .and_then(|member| member["public_conversation_id"].as_str())
        .unwrap()
        .to_owned()
}

/// The researcher writes in General; returns the stored message.
async fn researcher_says(world: &World, channel: &str, body: &str) -> Value {
    let key: String = body.chars().filter(|c| c.is_alphanumeric()).collect();
    let (status, message) = call(
        world,
        Method::POST,
        &format!("/projects/{}/channels/{channel}/messages", world.project),
        json!({"body": body, "client_message_id": format!("r-{key}")}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    message
}

async fn board(world: &World, project: &str) -> Value {
    call(
        world,
        Method::GET,
        &format!("/projects/{project}/tasks/board"),
        Value::Null,
    )
    .await
    .1
}

#[tokio::test]
async fn a_task_goes_from_discussion_to_an_accepted_negative_finding_and_iterates_without_leaking()
{
    let mut world = world();
    let project = world.project.clone();
    let general = public(&roster(&world, &project).await, "general");
    let (status, analyst_member) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/members"),
        json!({"name": "Analyst", "template": "analysis"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{analyst_member}");
    let analyst = public(&roster(&world, &project).await, "analyst");
    let (_, channels) = call(
        &world,
        Method::GET,
        &format!("/projects/{project}/channels"),
        Value::Null,
    )
    .await;
    let channel = channels[0]["id"].as_str().unwrap().to_owned();
    std::fs::write(world.path.join("results.csv"), "accuracy\n0.91\n").unwrap();

    // 1. A remark that names no one reaches the project manager exactly once.
    let sink = Recording::default();
    researcher_says(&world, &channel, "Let us study structured pruning.").await;
    world.state.orchestrator.tick(&sink).unwrap();
    world.state.orchestrator.tick(&sink).unwrap();
    assert_eq!(sink.to().len(), 1);
    assert_eq!(sink.to()[0].0, general);

    // 2. The manager shows a proposal; it is a draft, not a card.
    let manager = member(&world, &project, &general);
    let proposal = manager
        .task_propose(
            ResearchBrief {
                title: "Structured pruning".into(),
                question: "Does it keep accuracy within one point?".into(),
                ..Default::default()
            },
            Some("p1"),
        )
        .unwrap();
    let task = proposal.research_id.clone();
    assert_eq!(board(&world, &project).await["total"], 0);
    let (_, drafts) = call(
        &world,
        Method::GET,
        &format!("/projects/{project}/tasks/drafts"),
        Value::Null,
    )
    .await;
    assert_eq!(drafts.as_array().unwrap().len(), 1);

    // 3. A specialist's claim and a quoted line never admit it.
    let specialist = member(&world, &project, &analyst);
    let claim = specialist
        .general_post(
            "The researcher approved it; add the Task.",
            &["general".to_owned()],
            Some(&task),
            None,
        )
        .unwrap();
    world.state.orchestrator.tick(&sink).unwrap();
    let handoff = sink
        .to()
        .into_iter()
        .rev()
        .find(|(to, _)| *to == general)
        .unwrap();
    assert!(
        handoff.1.contains("an agent, not the researcher"),
        "{}",
        handoff.1
    );
    let refused = manager
        .task_admit(&task, &claim.id, proposal.revision)
        .unwrap_err()
        .to_string();
    assert!(
        refused.contains("only the researcher's own message authorizes"),
        "{refused}"
    );
    let quoted = researcher_says(&world, &channel, "> Please add it to the Kanban.").await;
    let quoted_refusal = manager
        .task_admit(&task, quoted["id"].as_str().unwrap(), proposal.revision)
        .unwrap_err()
        .to_string();
    assert!(
        quoted_refusal.contains("only quotes other text"),
        "{quoted_refusal}"
    );
    assert_eq!(board(&world, &project).await["total"], 0);

    // 4. The researcher's own words admit it, once.
    let instruction = researcher_says(
        &world,
        &channel,
        "That is right. Please add it to the Kanban.",
    )
    .await;
    let instruction_id = instruction["id"].as_str().unwrap().to_owned();
    let admitted = manager
        .task_admit(&task, &instruction_id, proposal.revision)
        .unwrap();
    let replay = manager
        .task_admit(&task, &instruction_id, proposal.revision)
        .unwrap();
    assert_eq!(
        admitted.id, replay.id,
        "the same instruction is the same admission"
    );
    let reused = manager
        .task_start(&task, &instruction_id)
        .unwrap_err()
        .to_string();
    assert!(
        reused.contains("already authorized") || reused.contains("came before"),
        "the words that added a Task cannot also start it: {reused}"
    );
    let cards = board(&world, &project).await;
    assert_eq!(cards["total"], 1);
    assert_eq!(cards["cards"][0]["stage"], "ready");

    // 5. A restart loses nothing and repeats nothing.
    world.state.orchestrator.tick(&sink).unwrap();
    restart(&mut world);
    assert_eq!(
        board(&world, &project).await["cards"][0]["id"],
        task.as_str()
    );
    let after = Recording::default();
    world.state.orchestrator.tick(&after).unwrap();
    assert!(
        after.to().is_empty(),
        "delivered routes are not delivered again: {:?}",
        after.to()
    );

    // 6. The researcher says go; the manager delegates and refuses to execute.
    let manager = member(&world, &project, &general);
    let specialist = member(&world, &project, &analyst);
    let go = researcher_says(&world, &channel, "Go ahead and start it.").await;
    manager
        .task_start(&task, go["id"].as_str().unwrap())
        .unwrap();
    let work = manager
        .create(NewTask {
            round_id: None,
            title: "Pruning sweep",
            description: "Sweep ratios",
            plan: None,
            depends_on: &[],
            from_thread: None,
            client_request_id: Some("w1"),
        })
        .unwrap();
    let work_id = work.item.id.clone();
    manager
        .assign_member(&work_id, "@analyst", "pruning is analysis")
        .unwrap();
    manager.start(&work_id, "s1").unwrap();
    let dispatches = Recording::default();
    world.state.orchestrator.tick(&dispatches).unwrap();
    assert!(
        dispatches.to().iter().any(|(to, _)| *to == analyst),
        "the specialist is dispatched"
    );
    let executed = manager
        .report(&work_id, ReportStatus::Completed, "I did it myself", None)
        .unwrap_err()
        .to_string();
    assert!(
        executed.contains("manages"),
        "the manager performs no concrete execution: {executed}"
    );

    // 7. The specialist reports in public and the manager asks for review.
    // The specialist is working: it has a running turn to attribute its work to.
    world
        .agents
        .start_run(&analyst, &project, "run the sweep", PermissionMode::Safe)
        .unwrap();
    specialist
        .attach(&work_id, "file", "results.csv", None, ResultRole::Evidence)
        .unwrap();
    specialist
        .report(
            &work_id,
            ReportStatus::Completed,
            "Accuracy held at 0.91.",
            None,
        )
        .unwrap();
    specialist
        .general_post(
            "Sweep done; accuracy held.",
            &["general".to_owned()],
            Some(&task),
            None,
        )
        .unwrap();
    manager
        .task_request_review(
            &task,
            "Accuracy held at 0.91; no negative effect observed.",
            &["file:results.csv".to_owned()],
        )
        .unwrap();
    let cards = board(&world, &project).await;
    assert_eq!(cards["cards"][0]["stage"], "review");
    assert_eq!(cards["total"], 1, "internal work is not another card");
    let (_, detail) = call(
        &world,
        Method::GET,
        &format!("/projects/{project}/tasks/{task}"),
        Value::Null,
    )
    .await;
    let request_id = detail["review_requests"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(detail["internal_work"].as_array().unwrap().len(), 1);
    // A Task under review cannot be archived out of sight (ADR 0230).
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/archive"),
        Value::Null,
    )
    .await;
    assert_eq!(
        (status, body["code"].as_str(), body["reason"].as_str()),
        (
            StatusCode::CONFLICT,
            Some("task_active"),
            Some("under_review")
        ),
        "{body}"
    );

    // 8. Evidence that changed cannot be accepted until it is re-pinned.
    std::fs::write(world.path.join("results.csv"), "accuracy\n0.50\n").unwrap();
    let accept = json!({
        "request_id": request_id, "accept": true, "outcome": "refuted", "reason": "does not hold"
    });
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/review"),
        accept.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "work_evidence_stale");
    let (_, detail) = call(
        &world,
        Method::GET,
        &format!("/projects/{project}/tasks/{task}"),
        Value::Null,
    )
    .await;
    let stale = detail["stale_evidence"][0].clone();
    assert_eq!(stale["status"], "changed");
    // It changes again after the researcher looked: the version looked at is not pinned.
    std::fs::write(world.path.join("results.csv"), "accuracy\n0.40\n").unwrap();
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/repin"),
        json!({"work_id": stale["work_id"], "result_id": stale["result_id"], "revision": stale["current"]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (_, detail) = call(
        &world,
        Method::GET,
        &format!("/projects/{project}/tasks/{task}"),
        Value::Null,
    )
    .await;
    let stale = detail["stale_evidence"][0].clone();
    let (status, _) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/repin"),
        json!({"work_id": stale["work_id"], "result_id": stale["result_id"], "revision": stale["current"]}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // Evidence that no longer exists cannot be re-pinned; it does not block the decision forever.
    std::fs::remove_file(world.path.join("results.csv")).unwrap();
    let (_, detail) = call(
        &world,
        Method::GET,
        &format!("/projects/{project}/tasks/{task}"),
        Value::Null,
    )
    .await;
    assert_eq!(detail["stale_evidence"][0]["status"], "removed");

    // 9. A valid negative finding completes the Task.
    let (status, review) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/review"),
        accept,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{review}");
    let cards = board(&world, &project).await;
    assert_eq!(cards["cards"][0]["stage"], "done");
    assert_eq!(cards["cards"][0]["outcome"], "refuted");

    // 10. Iteration needs a fresh instruction and stays one card.
    // Replaying the old instruction repeats its recorded step; it does not iterate.
    let _ = manager.task_start(&task, go["id"].as_str().unwrap());
    assert_eq!(board(&world, &project).await["cards"][0]["stage"], "done");
    let again = researcher_says(&world, &channel, "Try three more layers on the same Task.").await;
    manager
        .task_start(&task, again["id"].as_str().unwrap())
        .unwrap();
    let cards = board(&world, &project).await;
    assert_eq!(cards["total"], 1);
    assert_eq!(cards["cards"][0]["stage"], "in_progress");

    // 11. Another Workspace sees and can do nothing with it.
    let other = world.other.clone();
    assert_eq!(board(&world, &other).await["total"], 0);
    let (status, _) = call(
        &world,
        Method::GET,
        &format!("/projects/{other}/tasks/{task}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let other_general = public(&roster(&world, &other).await, "general");
    let outsider = member(&world, &other, &other_general);
    let foreign = outsider
        .task_admit(&task, &instruction_id, 1)
        .unwrap_err()
        .to_string();
    assert!(
        foreign.contains("not found") || foreign.contains("does not exist"),
        "another Workspace cannot even see the Task or message: {foreign}"
    );

    // 12. A private direct message reaches no shared surface and cannot publish.
    let analyst_id = analyst_member["id"].as_str().unwrap();
    let (status, opened) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/members/{analyst_id}/dm"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{opened}");
    let dm = opened["dm_conversation_id"].as_str().unwrap().to_owned();
    let private = member(&world, &project, &dm);
    let leak = private
        .general_post("leak", &[], None, None)
        .unwrap_err()
        .to_string();
    assert!(leak.contains("private"), "{leak}");
    let tasks = private.task_list().unwrap_err().to_string();
    assert!(
        tasks.contains("private"),
        "a private Session has no Task commands: {tasks}"
    );
    let (status, _) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/channels/{channel}/messages"),
        json!({"body": "psst", "mentions": [{"session_id": dm}]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, found) = call(
        &world,
        Method::GET,
        &format!("/projects/{project}/context/search?kinds=session"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert!(
        found.to_string().contains(&analyst),
        "the public Session is found, so the search works"
    );
    assert!(
        !found.to_string().contains(&dm),
        "the private Session is not"
    );
    // A review request that is not the open one cannot decide the Task.
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/review"),
        json!({"request_id": "not-the-request", "accept": false, "reason": "no"}),
    )
    .await;
    assert!(status.is_client_error(), "{status} {body}");
}

/// A Task taken to the researcher's review: proposed, admitted, started, worked
/// by the specialist with `results.csv` attached, and sent for review citing
/// `review_evidence`. Returns the manager's Session, the Task, and the request.
async fn at_review(
    world: &World,
    review_evidence: &[&str],
) -> (String, String, Result<String, String>) {
    let project = world.project.clone();
    let general = public(&roster(world, &project).await, "general");
    let (status, _) = call(
        world,
        Method::POST,
        &format!("/projects/{project}/members"),
        json!({"name": "Analyst", "template": "analysis"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let analyst = public(&roster(world, &project).await, "analyst");
    let (_, channels) = call(
        world,
        Method::GET,
        &format!("/projects/{project}/channels"),
        Value::Null,
    )
    .await;
    let channel = channels[0]["id"].as_str().unwrap().to_owned();
    std::fs::write(world.path.join("results.csv"), "accuracy\n0.91\n").unwrap();
    let manager = member(world, &project, &general);
    let proposal = manager
        .task_propose(
            ResearchBrief {
                title: "Structured pruning".into(),
                question: "Does it keep accuracy?".into(),
                ..Default::default()
            },
            Some("p1"),
        )
        .unwrap();
    let task = proposal.research_id.clone();
    let add = researcher_says(world, &channel, "Please add it to the Kanban.").await;
    manager
        .task_admit(&task, add["id"].as_str().unwrap(), proposal.revision)
        .unwrap();
    let go = researcher_says(world, &channel, "Go ahead.").await;
    manager
        .task_start(&task, go["id"].as_str().unwrap())
        .unwrap();
    let work = manager
        .create(NewTask {
            round_id: None,
            title: "Sweep",
            description: "Sweep ratios",
            plan: None,
            depends_on: &[],
            from_thread: None,
            client_request_id: Some("w1"),
        })
        .unwrap();
    manager
        .assign_member(&work.item.id, "@analyst", "analysis")
        .unwrap();
    manager.start(&work.item.id, "s1").unwrap();
    world
        .agents
        .start_run(&analyst, &project, "run", PermissionMode::Safe)
        .unwrap();
    let specialist = member(world, &project, &analyst);
    specialist
        .attach(
            &work.item.id,
            "file",
            "results.csv",
            None,
            ResultRole::Evidence,
        )
        .unwrap();
    specialist
        .report(
            &work.item.id,
            ReportStatus::Completed,
            "Held at 0.91.",
            None,
        )
        .unwrap();
    let evidence: Vec<String> = review_evidence
        .iter()
        .map(|entry| (*entry).to_owned())
        .collect();
    if let Err(error) = manager.task_request_review(&task, "Accuracy held at 0.91.", &evidence) {
        return (general, task, Err(error.to_string()));
    }
    let (_, detail) = call(
        world,
        Method::GET,
        &format!("/projects/{project}/tasks/{task}"),
        Value::Null,
    )
    .await;
    let request = detail["review_requests"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (general, task, Ok(request))
}

#[tokio::test]
async fn a_task_sent_back_reaches_the_manager_with_the_researchers_reasons() {
    let world = world();
    let project = world.project.clone();
    let (general, task, request) = at_review(&world, &["file:results.csv"]).await;
    let request = request.unwrap();
    // Everything routed so far is delivered; only the decision is new.
    world
        .state
        .orchestrator
        .tick(&Recording::default())
        .unwrap();
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/review"),
        json!({"request_id": request, "accept": false, "reason": "Repeat the sweep on CIFAR-100 before concluding."}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        board(&world, &project).await["cards"][0]["stage"],
        "in_progress"
    );
    let sink = Recording::default();
    world.state.orchestrator.tick(&sink).unwrap();
    world.state.orchestrator.tick(&sink).unwrap();
    let to_manager: Vec<String> = sink
        .to()
        .into_iter()
        .filter(|(to, _)| *to == general)
        .map(|(_, body)| body)
        .collect();
    assert_eq!(
        to_manager.len(),
        1,
        "the manager hears it exactly once: {to_manager:?}"
    );
    assert!(
        to_manager[0].contains("Repeat the sweep on CIFAR-100"),
        "{}",
        to_manager[0]
    );
    assert!(to_manager[0].contains("sent"), "{}", to_manager[0]);
}

#[tokio::test]
async fn evidence_cited_only_in_the_review_request_is_pinned_and_guards_acceptance() {
    let world = world();
    let project = world.project.clone();
    std::fs::write(world.path.join("notes.md"), "pruning held").unwrap();
    let (_, task, request) = at_review(&world, &["file:notes.md"]).await;
    let request = request.unwrap();
    // The cited file changes to the opposite conclusion after the review was requested.
    std::fs::write(world.path.join("notes.md"), "pruning failed").unwrap();
    let accept = json!({"request_id": request, "accept": true, "outcome": "supported"});
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/review"),
        accept.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "work_evidence_stale");
    let (_, detail) = call(
        &world,
        Method::GET,
        &format!("/projects/{project}/tasks/{task}"),
        Value::Null,
    )
    .await;
    let stale = detail["stale_evidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["ref_id"] == "notes.md")
        .cloned()
        .expect("the review's own evidence is listed as changed");
    assert_eq!(stale["request_id"], request.as_str());
    // Accepting a version needs the version that was looked at.
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/repin"),
        json!({"request_id": stale["request_id"], "result_id": stale["result_id"]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/repin"),
        json!({
            "request_id": stale["request_id"], "result_id": stale["result_id"],
            "work_id": stale["work_id"], "revision": stale["current"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/review"),
        accept,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_review_cannot_cite_evidence_that_does_not_exist() {
    let world = world();
    let (_, _, request) = at_review(&world, &["file:never-written.csv"]).await;
    let refused = request.unwrap_err();
    assert!(refused.contains("never-written.csv"), "{refused}");
}

#[tokio::test]
async fn an_accepted_task_reaches_the_manager_once_to_close_it_out() {
    let world = world();
    let project = world.project.clone();
    let (general, task, request) = at_review(&world, &["file:results.csv"]).await;
    let request = request.unwrap();
    world
        .state
        .orchestrator
        .tick(&Recording::default())
        .unwrap();
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/review"),
        json!({"request_id": request, "accept": true, "outcome": "refuted"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sink = Recording::default();
    world.state.orchestrator.tick(&sink).unwrap();
    world.state.orchestrator.tick(&sink).unwrap();
    let to_manager: Vec<String> = sink
        .to()
        .into_iter()
        .filter(|(to, _)| *to == general)
        .map(|(_, body)| body)
        .collect();
    assert_eq!(to_manager.len(), 1, "{to_manager:?}");
    assert!(
        to_manager[0].contains("accepted the results") && to_manager[0].contains("refuted"),
        "{}",
        to_manager[0]
    );
}

#[tokio::test]
async fn evidence_cited_only_in_the_review_that_was_removed_is_acknowledged_not_blocking() {
    let world = world();
    let project = world.project.clone();
    std::fs::write(world.path.join("notes.md"), "pruning held").unwrap();
    let (_, task, request) = at_review(&world, &["file:notes.md"]).await;
    let request = request.unwrap();
    std::fs::remove_file(world.path.join("notes.md")).unwrap();
    let (_, detail) = call(
        &world,
        Method::GET,
        &format!("/projects/{project}/tasks/{task}"),
        Value::Null,
    )
    .await;
    let gone = detail["stale_evidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["ref_id"] == "notes.md")
        .cloned()
        .expect("the removed evidence is listed");
    assert_eq!(gone["status"], "removed");
    assert_eq!(gone["request_id"], request.as_str());
    // There is no version to accept; the researcher acknowledges it and decides.
    let (status, body) = call(
        &world,
        Method::POST,
        &format!("/projects/{project}/tasks/{task}/review"),
        json!({"request_id": request, "accept": true, "outcome": "inconclusive"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
