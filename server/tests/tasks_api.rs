//! Tasks (#200, ADR 0221) over HTTP under a non-root base path: a Task enters
//! the one board only when the researcher's own message tells the General
//! Agent to add it, specialists and quoted text cannot do it, internal work
//! stays inside the Task, and the researcher reviews its results.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::research_store::ResearchBrief;
use kubecode_server::task_store::TaskError;
use kubecode_server::teams::TeamStore;
use kubecode_server::work_agent::{AgentWorkError, Evidence, NewTask, WorkAgent};
use kubecode_server::work_store::{NewResult, ResultRole};
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
    other_project: String,
    general: String,
    specialist: String,
}

fn env() -> Env {
    let root = TempDir::new().expect("tempdir");
    let database = root.path().join(".state/kubecode/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace.create_project(".", "alpha").expect("alpha");
    let other = workspace.create_project(".", "beta").expect("beta");
    let agents = Arc::new(AgentStore::open(&database).expect("agents"));
    let teams = Arc::new(TeamStore::open(&database).expect("teams"));
    let state =
        AppState::new(workspace, Arc::clone(&agents), teams).with_agents(vec![AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: "/bin/true".into(),
            error: None,
        }]);
    let available: &dyn Fn(AgentId) -> bool = &|_| true;
    let general = state
        .members
        .ensure_general(&project.id, available, AgentId::OpenCode)
        .expect("general")
        .public_conversation_id
        .expect("session");
    let specialist = state
        .members
        .create_specialist(
            &project.id,
            kubecode_server::member_store::NewMember {
                name: "Analyst".into(),
                template: Some(kubecode_server::member_store::MemberTemplate::Analysis),
                ..Default::default()
            },
            available,
            AgentId::OpenCode,
        )
        .expect("specialist")
        .public_conversation_id
        .expect("session");
    let app = app_router(state.clone(), BASE);
    Env {
        _root: root,
        app,
        state,
        agents,
        project: project.id,
        other_project: other.id,
        general,
        specialist,
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

impl Env {
    fn agent(&self, caller: &str) -> WorkAgent {
        WorkAgent::new(
            self.project.clone(),
            caller.to_owned(),
            Arc::clone(&self.state.work),
            Arc::clone(&self.state.channels),
            Arc::clone(&self.state.orchestrator),
            Arc::clone(&self.state.research),
            Arc::clone(&self.agents),
            Arc::new(|_| true),
        )
        .with_members(Arc::clone(&self.state.members))
        .with_tasks(Arc::clone(&self.state.tasks))
        .with_evidence(Evidence::new(
            Arc::clone(&self.state.context),
            Arc::clone(&self.state.workspace),
        ))
    }

    /// The researcher says something in General, over HTTP, as the browser does.
    async fn say(&self, body: &str) -> String {
        let channel = self.state.channels.default_channel(&self.project).unwrap();
        let (status, message) = call(
            self,
            Method::POST,
            &format!(
                "/projects/{}/channels/{}/messages",
                self.project, channel.id
            ),
            json!({"body": body}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{message}");
        message["id"].as_str().unwrap().to_owned()
    }

    async fn board(&self, project: &str) -> Value {
        let (status, board) = call(
            self,
            Method::GET,
            &format!("/projects/{project}/tasks/board"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{board}");
        board
    }
}

fn brief(title: &str) -> ResearchBrief {
    ResearchBrief {
        title: title.into(),
        question: "Does head pruning hold accuracy?".into(),
        evaluation_criteria: vec!["within one point".into()],
        ..Default::default()
    }
}

#[tokio::test]
async fn a_task_reaches_the_one_board_only_through_the_researchers_words_to_the_manager() {
    let env = env();
    let manager = env.agent(&env.general);
    let specialist = env.agent(&env.specialist);

    // Brainstorming and proposals leave the board empty.
    let proposal = manager
        .task_propose(brief("Prune heads"), Some("prune"))
        .unwrap();
    let from_specialist = specialist
        .task_propose(brief("Quantize"), Some("quant"))
        .unwrap();
    assert_eq!(env.board(&env.project).await["total"], 0);
    let (_, drafts) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/tasks/drafts", env.project),
        Value::Null,
    )
    .await;
    assert_eq!(drafts.as_array().unwrap().len(), 2);

    // Two proposals are on the table; the manager shows the one in question again
    // and the researcher answers it in their words, with no @mention and no button.
    manager.task_show(&proposal.research_id).unwrap();
    let instruction = env
        .say("Yes, please add the pruning one to the board.")
        .await;
    // The manager finds it among the latest messages, with its author kind.
    let recent = manager.general_recent(None).unwrap();
    let seen = recent
        .iter()
        .find(|m| m.id == instruction)
        .expect("visible to the manager");
    assert_eq!(seen.author, "researcher");
    assert!(
        recent
            .iter()
            .any(|m| m.task == [proposal.research_id.clone()]
                && m.from.as_deref() == Some("general"))
    );

    // A specialist cannot admit, even holding the researcher's message id; nor can a
    // wrong revision, an unrelated Task, or an agent's own words.
    let refused = specialist.task_admit(&proposal.research_id, &instruction, proposal.revision);
    assert!(
        matches!(refused, Err(AgentWorkError::Task(TaskError::NotManager))),
        "{refused:?}"
    );
    let agent_words = manager
        .task_propose(brief("Agent drafted"), Some("agent-words"))
        .unwrap()
        .message_id;
    let by_agent = manager.task_admit(&proposal.research_id, &agent_words, proposal.revision);
    assert!(
        matches!(
            by_agent,
            Err(AgentWorkError::Task(TaskError::NotAuthorized(_)))
        ),
        "{by_agent:?}"
    );
    assert_eq!(env.board(&env.project).await["total"], 0);

    let admitted = manager
        .task_admit(&proposal.research_id, &instruction, proposal.revision)
        .unwrap();
    assert_eq!(admitted.message_id.as_deref(), Some(instruction.as_str()));
    // A retry changes nothing; the same words do not admit the other draft.
    assert_eq!(
        manager
            .task_admit(&proposal.research_id, &instruction, proposal.revision)
            .unwrap()
            .id,
        admitted.id
    );
    let replay = manager.task_admit(
        &from_specialist.research_id,
        &instruction,
        from_specialist.revision,
    );
    // (A specialist's own proposal first has to be shown by the General Agent.)
    assert!(
        matches!(
            replay,
            Err(AgentWorkError::Task(
                TaskError::Stale(_) | TaskError::MessageUsed
            ))
        ),
        "{replay:?}"
    );

    let board = env.board(&env.project).await;
    assert_eq!(board["total"], 1);
    let card = &board["cards"][0];
    assert_eq!(
        (card["id"].as_str(), card["stage"].as_str()),
        (Some(proposal.research_id.as_str()), Some("ready"))
    );
    assert_eq!(card["authorizing_message_id"], instruction);

    // The inspector shows the authorization the way a person would read it.
    let (status, detail) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/tasks/{}", env.project, proposal.research_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(
        detail["authorizing_message"]["body"]
            .as_str()
            .unwrap()
            .contains("add the pruning one")
    );
    assert_eq!(detail["authorizations"][0]["kind"], "admit");
    assert_eq!(
        detail["authorizations"][0]["acted_by"],
        env.general.as_str()
    );
    assert_eq!(detail["brief"]["title"], "Prune heads");

    // Another Workspace sees nothing of it.
    assert_eq!(env.board(&env.other_project).await["total"], 0);
    let (status, _) = call(
        &env,
        Method::GET,
        &format!(
            "/projects/{}/tasks/{}",
            env.other_project, proposal.research_id
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn work_stays_inside_the_task_and_the_researcher_reviews_stale_evidence_aware() {
    let env = env();
    let manager = env.agent(&env.general);
    let proposal = manager
        .task_propose(brief("Prune heads"), Some("prune"))
        .unwrap();
    let admit = env.say("Add it to the board").await;
    manager
        .task_admit(&proposal.research_id, &admit, proposal.revision)
        .unwrap();
    let go = env.say("Go ahead and start.").await;
    let started = manager.task_start(&proposal.research_id, &go).unwrap();
    let round = started.round_id.unwrap();

    // The manager organizes internal work and delegates to the specialist.
    let work = manager
        .create(NewTask {
            round_id: Some(&round),
            title: "Sweep ratios",
            description: "Try them",
            plan: None,
            depends_on: &[],
            from_thread: None,
            client_request_id: Some("w1"),
        })
        .unwrap();
    manager
        .assign_member(&work.item.id, "@analyst", "your area")
        .unwrap();
    let board = env.board(&env.project).await;
    assert_eq!(board["total"], 1, "internal work is not a card");
    assert_eq!(board["cards"][0]["stage"], "in_progress");
    assert_eq!(board["cards"][0]["work"]["total"], 1);
    let handles: Vec<&str> = board["cards"][0]["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["handle"].as_str().unwrap())
        .collect();
    assert_eq!(handles, ["general", "analyst"]);
    let (_, detail) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/tasks/{}", env.project, proposal.research_id),
        Value::Null,
    )
    .await;
    assert_eq!(detail["internal_work"][0]["assignee"]["handle"], "analyst");

    // The specialist cites a file as evidence; the manager asks for review.
    let root = env
        .state
        .workspace
        .execution_path(&env.project, None)
        .unwrap();
    std::fs::write(root.join("notes.md"), "pruning hurts").unwrap();
    let revision = env
        .state
        .workspace
        .file_revision(&env.project, "notes.md")
        .unwrap();
    let attempt = env
        .state
        .work
        .begin_attempt(
            &env.project,
            &work.item.id,
            Some("a1"),
            &kubecode_server::work_store::Actor::Researcher,
        )
        .unwrap();
    env.state
        .work
        .add_result(
            &env.project,
            &work.item.id,
            NewResult {
                attempt_id: Some(&attempt.id),
                role: ResultRole::Evidence,
                kind: "file",
                ref_id: "notes.md",
                revision: Some(&revision),
            },
            &kubecode_server::work_store::Actor::Executor {
                conversation_id: env.specialist.clone(),
            },
        )
        .unwrap();
    let request = manager
        .task_request_review(
            &proposal.research_id,
            "0.9 diverged; 0.5 holds.",
            &["file:notes.md".into()],
        )
        .unwrap();
    assert_eq!(request.state, "open");
    assert_eq!(env.board(&env.project).await["cards"][0]["stage"], "review");
    // A Task awaiting review takes no new work.
    let late = manager.create(NewTask {
        round_id: Some(&round),
        title: "More",
        description: "x",
        plan: None,
        depends_on: &[],
        from_thread: None,
        client_request_id: Some("w2"),
    });
    assert!(
        matches!(&late, Err(AgentWorkError::Invalid(text)) if text.contains("awaiting the researcher's review")),
        "{late:?}"
    );
    // Nor can existing work be reassigned, started, or given another executor meanwhile.
    for result in [
        manager
            .assign_member(&work.item.id, "@analyst", "again")
            .map(|_| ()),
        manager.start(&work.item.id, "again").map(|_| ()),
    ] {
        assert!(
            matches!(&result, Err(AgentWorkError::Invalid(text)) if text.contains("the Task is finished or awaiting")),
            "{result:?}"
        );
    }

    // The evidence changed behind the review: accepting is refused until it is accepted anew.
    std::fs::write(root.join("notes.md"), "pruning helps after all").unwrap();
    let path = format!(
        "/projects/{}/tasks/{}/review",
        env.project, proposal.research_id
    );
    let (status, stale) = call(
        &env,
        Method::POST,
        &path,
        json!({"request_id": request.id, "accept": true, "outcome": "supported"}),
    )
    .await;
    assert_eq!(
        (status, stale["code"].as_str()),
        (StatusCode::CONFLICT, Some("work_evidence_stale")),
        "{stale}"
    );
    assert_eq!(stale["stale"][0]["ref_id"], "notes.md");
    let (_, detail) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/tasks/{}", env.project, proposal.research_id),
        Value::Null,
    )
    .await;
    assert_eq!(
        detail["stale_evidence"][0]["work_id"],
        work.item.id.as_str()
    );
    let result_id = detail["stale_evidence"][0]["result_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, _) = call(
        &env,
        Method::POST,
        &format!(
            "/projects/{}/tasks/{}/repin",
            env.project, proposal.research_id
        ),
        json!({"work_id": work.item.id, "result_id": result_id}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Sending it back needs a reason; a valid negative finding then completes it.
    let (status, _) = call(
        &env,
        Method::POST,
        &path,
        json!({"request_id": request.id, "accept": false}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, accepted) = call(
        &env,
        Method::POST,
        &path,
        json!({"request_id": request.id, "accept": true, "outcome": "refuted", "reason": "clean ablation"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    let board = env.board(&env.project).await;
    assert_eq!(
        (
            board["cards"][0]["stage"].as_str(),
            board["cards"][0]["outcome"].as_str()
        ),
        (Some("done"), Some("refuted"))
    );
    // Nothing else to review now.
    let (status, again) = call(
        &env,
        Method::POST,
        &path,
        json!({"request_id": request.id, "accept": true}),
    )
    .await;
    assert_eq!(
        (status, again["code"].as_str()),
        (StatusCode::CONFLICT, Some("task_state"))
    );
    // And a finished Task takes no new work either.
    let after = manager.create(NewTask {
        round_id: Some(&round),
        title: "Even more",
        description: "x",
        plan: None,
        depends_on: &[],
        from_thread: None,
        client_request_id: Some("w3"),
    });
    assert!(
        matches!(&after, Err(AgentWorkError::Invalid(text)) if text.contains("finished or awaiting")),
        "{after:?}"
    );
}

#[tokio::test]
async fn the_manager_coordinates_many_tasks_and_a_stale_review_click_decides_nothing() {
    let env = env();
    let manager = env.agent(&env.general);
    let mut rounds = Vec::new();
    for title in ["Prune heads", "Quantize"] {
        let proposal = manager
            .task_propose(brief(title), Some(&title.replace(' ', "-")))
            .unwrap();
        let admit = env.say(&format!("Add {title} to the board")).await;
        manager
            .task_admit(&proposal.research_id, &admit, proposal.revision)
            .unwrap();
        let go = env.say(&format!("Go ahead with {title}")).await;
        let started = manager.task_start(&proposal.research_id, &go).unwrap();
        rounds.push((proposal.research_id, started.round_id.unwrap()));
    }
    // One manager, two Tasks, two rounds, both coordinated by it.
    for (_, round) in &rounds {
        assert_eq!(
            env.state
                .work
                .coordinator(&env.project, round)
                .unwrap()
                .unwrap()
                .holder,
            env.general
        );
    }
    assert_eq!(env.board(&env.project).await["total"], 2);

    // A review the researcher is not looking at cannot be decided by an old click.
    let (task, _) = &rounds[0];
    let first = manager
        .task_request_review(task, "First look", &[])
        .unwrap();
    let path = format!("/projects/{}/tasks/{task}/review", env.project);
    let (status, sent_back) = call(
        &env,
        Method::POST,
        &path,
        json!({"request_id": first.id, "accept": false, "reason": "more"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent_back}");
    let second = manager
        .task_request_review(task, "Second look", &[])
        .unwrap();
    let (status, stale) = call(
        &env,
        Method::POST,
        &path,
        json!({"request_id": first.id, "accept": true, "outcome": "supported"}),
    )
    .await;
    assert_eq!(
        (status, stale["code"].as_str()),
        (StatusCode::CONFLICT, Some("task_state")),
        "{stale}"
    );
    let (status, _) = call(
        &env,
        Method::POST,
        &path,
        json!({"request_id": second.id, "accept": true, "outcome": "supported"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // A review of a Task that does not exist is a 404.
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/tasks/no-such/review", env.project),
        json!({"request_id": "x", "accept": true}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
