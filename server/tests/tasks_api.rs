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
use kubecode_server::channel_store::{Mention, NewMessage};
use kubecode_server::orchestrator::{
    DeliveryOutcome, DeliveryRequest, RouteKind, RouteSink, Target,
};
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
    // The review cites the same file, so its own pin is stale too (ADR 0226);
    // the researcher accepts the version they looked at for every pin of it.
    let stale = detail["stale_evidence"].as_array().unwrap().clone();
    assert_eq!(stale.len(), 2, "{stale:?}");
    for entry in stale {
        assert_eq!(entry["ref_id"], "notes.md");
        let (status, body) = call(
            &env,
            Method::POST,
            &format!(
                "/projects/{}/tasks/{}/repin",
                env.project, proposal.research_id
            ),
            json!({
                "work_id": entry["work_id"], "result_id": entry["result_id"],
                "request_id": entry["request_id"], "revision": entry["current"],
            }),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }

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

#[derive(Default)]
struct Recording {
    delivered: std::sync::Mutex<Vec<(String, String)>>,
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

#[tokio::test]
async fn general_recent_reports_reply_to_and_recipients() {
    let env = env();
    let manager = env.agent(&env.general);
    let first = env.say("What did the sweep show?").await;
    let channel = env.state.channels.default_channel(&env.project).unwrap();
    let (named, _) = env
        .state
        .channels
        .post(
            &env.project,
            &channel.id,
            NewMessage {
                body: "@analyst @general look at this",
                mentions: &[
                    Mention {
                        session_id: env.specialist.clone(),
                    },
                    Mention {
                        session_id: env.general.clone(),
                    },
                ],
                reply_to: Some(&first),
                ..Default::default()
            },
        )
        .unwrap();
    // The Analyst's Session is replaced: the old mention still names it.
    let analyst = env
        .state
        .members
        .find(&env.project, "analyst")
        .unwrap()
        .unwrap();
    env.state
        .members
        .replace_session(
            &env.project,
            &analyst.id,
            kubecode_server::member_store::Binding::Public,
            None,
            &|_| true,
        )
        .unwrap();

    let recent = manager.general_recent(None).unwrap();
    let seen = recent.iter().find(|m| m.id == named.id).unwrap();
    assert_eq!(seen.reply_to.as_deref(), Some(first.as_str()));
    assert_eq!(seen.to, ["analyst", "general"]);
    let plain = recent.iter().find(|m| m.id == first).unwrap();
    assert_eq!(plain.reply_to, None);
    assert!(plain.to.is_empty(), "a remark names no one");
    let json = serde_json::to_value(seen).unwrap();
    assert_eq!(json["to"], json!(["analyst", "general"]));
    assert_eq!(json["reply_to"], json!(first));
}

#[tokio::test]
async fn general_recent_never_names_a_dm_session_in_to() {
    let env = env();
    let manager = env.agent(&env.general);
    let analyst = env
        .state
        .members
        .find(&env.project, "analyst")
        .unwrap()
        .unwrap();
    let dm = env
        .state
        .members
        .ensure_dm_session(&env.project, &analyst.id, &|_| true)
        .unwrap()
        .dm_conversation_id
        .unwrap();
    let stranger = env
        .agents
        .create_conversation(&env.project, AgentId::OpenCode, Some("chat"))
        .unwrap()
        .id;
    // Written straight to the store, as data from before the HTTP refusal
    // of private mentions could be.
    let channel = env.state.channels.default_channel(&env.project).unwrap();
    let (message, _) = env
        .state
        .channels
        .post(
            &env.project,
            &channel.id,
            NewMessage {
                body: "private and stranger",
                mentions: &[
                    Mention { session_id: dm },
                    Mention {
                        session_id: stranger,
                    },
                ],
                ..Default::default()
            },
        )
        .unwrap();
    let recent = manager.general_recent(None).unwrap();
    let seen = recent.iter().find(|m| m.id == message.id).unwrap();
    assert!(seen.to.is_empty(), "{:?}", seen.to);
}

#[tokio::test]
async fn a_reply_is_public_and_authorizes_nothing() {
    let env = env();
    let manager = env.agent(&env.general);
    let proposal = manager
        .task_propose(brief("Prune heads"), Some("prune"))
        .unwrap();
    let channel = env.state.channels.default_channel(&env.project).unwrap();
    let (status, reply) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/channels/{}/messages", env.project, channel.id),
        json!({"body": "yes, add it", "reply_to": proposal.message_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{reply}");
    assert_eq!(reply["reply_to"], json!(proposal.message_id));
    assert_eq!(reply["thread_id"], Value::Null);
    let (_, threads) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/channels/{}/threads", env.project, channel.id),
        Value::Null,
    )
    .await;
    assert!(threads.as_array().unwrap().is_empty(), "{threads}");

    let sink = Recording::default();
    env.state.orchestrator.tick(&sink).unwrap();
    // The reply reached the manager as the manager, citing the proposal fenced.
    let reply_id = reply["id"].as_str().unwrap();
    let route = env
        .state
        .orchestrator
        .routes(&env.project, None, 50)
        .unwrap()
        .into_iter()
        .find(|route| route.source_id == reply_id)
        .expect("the reply was routed");
    assert_eq!(route.kind, RouteKind::Discussion);
    assert!(
        matches!(&route.target, Target::Session { session_id } if *session_id == env.general),
        "{:?}",
        route.target
    );
    let delivered = sink.delivered.lock().unwrap().clone();
    let (_, body) = delivered
        .iter()
        .find(|(to, body)| *to == env.general && body.contains("yes, add it"))
        .expect("delivered to the manager");
    assert!(
        body.contains(&format!("It replies to message {}", proposal.message_id)),
        "{body}"
    );
    assert!(body.contains("task_admit"), "{body}");
    // Nothing was admitted by the reply itself.
    assert_eq!(env.board(&env.project).await["total"], 0);
    // Only the manager's own call, citing the researcher's words, admits it.
    manager
        .task_admit(&proposal.research_id, reply_id, proposal.revision)
        .unwrap();
    assert_eq!(env.board(&env.project).await["total"], 1);
}

/// A Task under review: admitted, executing, one piece of internal work
/// assigned to the Analyst with `notes.md` attached as evidence, and an open
/// review request that cites the same file.
struct Reviewing {
    research_id: String,
    round: String,
    work_id: String,
    result_id: String,
    request_id: String,
    root: std::path::PathBuf,
}

async fn reviewing(env: &Env) -> Reviewing {
    let manager = env.agent(&env.general);
    let proposal = manager
        .task_propose(brief("Prune heads"), Some("prune"))
        .unwrap();
    let admit = env.say("Add it to the board").await;
    manager
        .task_admit(&proposal.research_id, &admit, proposal.revision)
        .unwrap();
    let go = env.say("Go ahead and start.").await;
    let round = manager
        .task_start(&proposal.research_id, &go)
        .unwrap()
        .round_id
        .unwrap();
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
    let result = env
        .state
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
    Reviewing {
        research_id: proposal.research_id,
        round,
        work_id: work.item.id,
        result_id: result.id,
        request_id: request.id,
        root,
    }
}

#[tokio::test]
async fn a_work_evidence_repin_must_name_the_version_looked_at() {
    let env = env();
    let task = reviewing(&env).await;
    std::fs::write(task.root.join("notes.md"), "pruning helps after all").unwrap();
    let current = env
        .state
        .workspace
        .file_revision(&env.project, "notes.md")
        .unwrap();
    let path = format!("/projects/{}/tasks/{}/repin", env.project, task.research_id);
    // Work-attached evidence, like the review's own, names what was looked at.
    let (status, body) = call(
        &env,
        Method::POST,
        &path,
        json!({"work_id": task.work_id, "result_id": task.result_id}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], "invalid_task_request");
    let (status, body) = call(
        &env,
        Method::POST,
        &path,
        json!({"work_id": task.work_id, "result_id": task.result_id, "revision": "an-older-one"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "work_evidence_stale");
    let (status, body) = call(
        &env,
        Method::POST,
        &path,
        json!({"work_id": task.work_id, "result_id": task.result_id, "revision": current}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    // The review's own pin still asks for its version too.
    let (status, body) = call(
        &env,
        Method::POST,
        &path,
        json!({"request_id": task.request_id, "result_id": "file:notes.md"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let _ = task.round;
}

/// Task evidence is accepted only at a version the researcher displayed: the
/// work board's re-pin of a Task's internal work names it too, and the
/// coordinator cannot re-pin it to make acceptance possible (ADR 0230 §4).
#[tokio::test]
async fn task_evidence_is_re_pinned_only_by_the_researcher_at_the_version_looked_at() {
    let env = env();
    let task = reviewing(&env).await;
    std::fs::write(task.root.join("notes.md"), "pruning helps after all").unwrap();
    let current = env
        .state
        .workspace
        .file_revision(&env.project, "notes.md")
        .unwrap();
    let commands = format!("/projects/{}/work/{}/commands", env.project, task.work_id);
    let state = |env: &Env| {
        env.state
            .work
            .get(&env.project, &task.work_id)
            .unwrap()
            .state_revision
    };
    // The work board's command names no version: refused for a Task's work.
    let (status, body) = call(
        &env,
        Method::POST,
        &commands,
        json!({"command": "repin", "result_id": task.result_id, "expected_state_revision": state(&env)}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let pinned = |env: &Env| {
        env.state
            .work
            .results(&env.project, &task.work_id)
            .unwrap()
            .into_iter()
            .find(|result| result.id == task.result_id)
            .unwrap()
            .revision
    };
    assert_ne!(pinned(&env).as_deref(), Some(current.as_str()));
    // A version that is not the current one is refused as stale.
    let (status, body) = call(
        &env,
        Method::POST,
        &commands,
        json!({"command": "repin", "result_id": task.result_id, "revision": "an-older-one", "expected_state_revision": state(&env)}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "work_evidence_stale");
    // The coordinator cannot re-pin a Task's evidence at all.
    let refused = env
        .agent(&env.general)
        .repin(&task.work_id, &task.result_id);
    let Err(AgentWorkError::Invalid(reason)) = refused else {
        panic!("expected a refusal, got {refused:?}");
    };
    assert!(reason.contains("researcher"), "{reason}");
    assert_ne!(pinned(&env).as_deref(), Some(current.as_str()));
    // The version the researcher looked at, when current, is accepted.
    let (status, body) = call(
        &env,
        Method::POST,
        &commands,
        json!({"command": "repin", "result_id": task.result_id, "revision": current, "expected_state_revision": state(&env)}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(pinned(&env).as_deref(), Some(current.as_str()));
}

#[tokio::test]
async fn archiving_is_separate_from_accepting() {
    let env = env();
    let task = reviewing(&env).await;
    let id = &task.research_id;
    let tasks = format!("/projects/{}/tasks/{id}", env.project);
    let research = format!("/projects/{}/research/{id}", env.project);
    // Under review: refused through both routes, with the reason.
    for path in [format!("{tasks}/archive"), format!("{research}/archive")] {
        let (status, body) = call(&env, Method::POST, &path, Value::Null).await;
        assert_eq!(status, StatusCode::CONFLICT, "{path}: {body}");
        assert_eq!(body["code"], "task_active", "{body}");
        assert_eq!(body["reason"], "under_review", "{body}");
    }
    // Sent back with its work still active: refused for that reason.
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{tasks}/review"),
        json!({"request_id": task.request_id, "accept": false, "reason": "try 0.7"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call(&env, Method::POST, &format!("{tasks}/archive"), Value::Null).await;
    assert_eq!(
        (status, body["reason"].as_str()),
        (StatusCode::CONFLICT, Some("work_active")),
        "{body}"
    );
    // Done: it can be archived, and keeps its outcome while hidden.
    let item = env.state.work.get(&env.project, &task.work_id).unwrap();
    env.state
        .work
        .close(
            &env.project,
            &task.work_id,
            item.revision,
            kubecode_server::work_store::Closure {
                lifecycle: kubecode_server::work_store::WorkLifecycle::Canceled,
                reason: "no longer needed",
                superseded_by: None,
            },
            &kubecode_server::work_store::Actor::Researcher,
        )
        .unwrap();
    let manager = env.agent(&env.general);
    let second = manager
        .task_request_review(id, "0.7 also diverges.", &[])
        .unwrap();
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{tasks}/review"),
        json!({"request_id": second.id, "accept": true, "outcome": "refuted"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call(&env, Method::POST, &format!("{tasks}/archive"), Value::Null).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let board = env.board(&env.project).await;
    assert_eq!(board["total"], 0, "{board}");
    assert_eq!(board["archived"][0]["id"], json!(id));
    assert_eq!(board["archived"][0]["stage"], "done");
    assert_eq!(board["archived"][0]["outcome"], "refuted");
    // Restoring puts it back where it was.
    let (status, body) = call(&env, Method::POST, &format!("{tasks}/restore"), Value::Null).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let board = env.board(&env.project).await;
    assert_eq!(board["cards"][0]["stage"], "done");
    assert_eq!(board["archived"], json!([]));
    let (status, _) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/tasks/no-such-task/archive", env.project),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_task_is_completed_only_by_review() {
    let env = env();
    let task = reviewing(&env).await;
    let research = format!("/projects/{}/research/{}", env.project, task.research_id);
    for verb in ["resolve", "reopen"] {
        let (status, body) = call(
            &env,
            Method::POST,
            &format!("{research}/{verb}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{verb}: {body}");
        assert_eq!(body["code"], "task_owned", "{body}");
    }
    assert_eq!(env.board(&env.project).await["cards"][0]["stage"], "review");
    // A draft is still a research question the researcher resolves directly.
    let draft = env
        .agent(&env.general)
        .task_propose(brief("Quantize"), Some("quant"))
        .unwrap();
    let (status, body) = call(
        &env,
        Method::POST,
        &format!(
            "/projects/{}/research/{}/resolve",
            env.project, draft.research_id
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn the_detail_links_reviews_to_general() {
    let env = env();
    let task = reviewing(&env).await;
    let tasks = format!("/projects/{}/tasks/{}", env.project, task.research_id);
    let (status, decided) = call(
        &env,
        Method::POST,
        &format!("{tasks}/review"),
        json!({"request_id": task.request_id, "accept": false, "reason": "also try 0.7"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{decided}");
    let verdict = decided["general_message_id"]
        .as_str()
        .expect("the verdict's General message")
        .to_owned();
    let channel = env.state.channels.default_channel(&env.project).unwrap();
    let message = env.state.channels.message(&env.project, &verdict).unwrap();
    assert_eq!(message.task_id.as_deref(), Some(task.research_id.as_str()));
    assert!(
        message.body.contains("Reason: also try 0.7"),
        "{}",
        message.body
    );
    // The Task-scoped page of General lists it.
    let (_, page) = call(
        &env,
        Method::GET,
        &format!(
            "/projects/{}/channels/{}/messages?task_id={}",
            env.project, channel.id, task.research_id
        ),
        Value::Null,
    )
    .await;
    assert!(
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == json!(verdict)),
        "{page}"
    );
    let (_, detail) = call(&env, Method::GET, &tasks, Value::Null).await;
    let asked = detail["review_requests"][0]["general_message_id"]
        .as_str()
        .expect("the request's General message");
    let asked = env.state.channels.message(&env.project, asked).unwrap();
    assert!(
        asked.body.starts_with("Ready for your review"),
        "{}",
        asked.body
    );
    assert_eq!(detail["review_requests"][0]["id"], json!(task.request_id));
    assert_eq!(detail["reviews"][0]["general_message_id"], json!(verdict));
    assert_eq!(detail["reviews"][0]["accepted"], false);
    // What last happened to it is on the card.
    assert_eq!(detail["last_event"]["kind"], "review_returned");
}

#[tokio::test]
async fn the_task_detail_lists_each_cited_evidence_once_with_every_pin() {
    let env = env();
    let task = reviewing(&env).await;
    let pinned = env
        .state
        .workspace
        .file_revision(&env.project, "notes.md")
        .unwrap();
    std::fs::write(task.root.join("notes.md"), "pruning helps after all").unwrap();
    let current = env
        .state
        .workspace
        .file_revision(&env.project, "notes.md")
        .unwrap();
    let (status, detail) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/tasks/{}", env.project, task.research_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let rows = detail["evidence"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "one row per cited record: {rows:?}");
    let row = &rows[0];
    assert_eq!(row["key"], "file:notes.md");
    assert_eq!(row["title"], "notes.md");
    assert_eq!(row["status"], "changed");
    assert_eq!(row["in_review"], true);
    assert_eq!(row["accepted"], false);
    assert_eq!(row["current"], json!(current));
    let cited = row["cited_by"].as_array().unwrap();
    assert_eq!(cited.len(), 2, "{cited:?}");
    assert!(cited.iter().any(|c| c["work_id"] == json!(task.work_id)
        && c["result_id"] == json!(task.result_id)
        && c["pinned"] == json!(pinned)));
    assert!(
        cited
            .iter()
            .any(|c| c["request_id"] == json!(task.request_id)
                && c["result_id"] == "file:notes.md"
                && c["pinned"] == json!(pinned))
    );
    // Kept for older pages.
    assert_eq!(detail["stale_evidence"].as_array().unwrap().len(), 2);
    // What waits on the researcher.
    let keys: Vec<&str> = detail["pending"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        [
            format!("review:{}", task.request_id).as_str(),
            "evidence:file:notes.md"
        ]
    );
    assert_eq!(detail["actions"]["archive"]["allowed"], false);
    assert_eq!(detail["actions"]["archive"]["reason"], "under_review");
    assert_eq!(detail["actions"]["restore"], false);
    assert_eq!(detail["archived"], false);
}

#[tokio::test]
async fn a_done_task_shows_the_evidence_it_accepted() {
    let env = env();
    let task = reviewing(&env).await;
    let tasks = format!("/projects/{}/tasks/{}", env.project, task.research_id);
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{tasks}/review"),
        json!({"request_id": task.request_id, "accept": true, "outcome": "supported"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, detail) = call(&env, Method::GET, &tasks, Value::Null).await;
    assert_eq!(detail["stage"], "done");
    let row = &detail["evidence"][0];
    assert_eq!(row["key"], "file:notes.md");
    assert_eq!(
        (row["accepted"].as_bool(), row["in_review"].as_bool()),
        (Some(true), Some(false))
    );
    assert_eq!(row["status"], "current");
    assert!(detail["pending"].as_array().unwrap().is_empty(), "{detail}");
    let last = detail["timeline"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(last["kind"], "review_accepted");
    assert_eq!(last["actor"], "researcher");
}

#[tokio::test]
async fn internal_work_names_its_session() {
    let env = env();
    let task = reviewing(&env).await;
    let (_, detail) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/tasks/{}", env.project, task.research_id),
        Value::Null,
    )
    .await;
    let work = &detail["internal_work"][0];
    assert_eq!(work["id"], json!(task.work_id));
    assert_eq!(work["conversation_id"], json!(env.specialist));
    assert!(!work["updated_at"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn an_archived_task_detail_says_so() {
    let env = env();
    let manager = env.agent(&env.general);
    let proposal = manager
        .task_propose(brief("Prune heads"), Some("prune"))
        .unwrap();
    let admit = env.say("Add it to the board").await;
    manager
        .task_admit(&proposal.research_id, &admit, proposal.revision)
        .unwrap();
    let tasks = format!("/projects/{}/tasks/{}", env.project, proposal.research_id);
    let (status, body) = call(&env, Method::POST, &format!("{tasks}/archive"), Value::Null).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (status, detail) = call(&env, Method::GET, &tasks, Value::Null).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "an archived Task is still served: {detail}"
    );
    assert_eq!(detail["archived"], true);
    assert_eq!(detail["stage"], "ready");
    assert_eq!(detail["actions"]["archive"]["allowed"], false);
    assert_eq!(detail["actions"]["archive"]["reason"], "archived");
    assert_eq!(detail["actions"]["restore"], true);
    let kinds: Vec<&str> = detail["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| step["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["proposed", "admitted", "archived"]);
}

#[tokio::test]
async fn the_task_detail_names_its_executing_round_policy_and_delivery_issues() {
    let env = env();
    let task = reviewing(&env).await;
    let tasks = format!("/projects/{}/tasks/{}", env.project, task.research_id);
    let (_, detail) = call(&env, Method::GET, &tasks, Value::Null).await;
    let execution = &detail["execution"];
    assert_eq!(execution["round_id"], json!(task.round), "{detail}");
    assert_eq!(execution["paused"], false);
    let revision = execution["policy_revision"].as_u64().unwrap();
    // Pausing new work is the round's execution policy.
    let (status, body) = call(
        &env,
        Method::PUT,
        &format!(
            "/projects/{}/rounds/{}/execution-policy",
            env.project, task.round
        ),
        json!({"expected_revision": revision, "paused": true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, detail) = call(&env, Method::GET, &tasks, Value::Null).await;
    assert_eq!(detail["execution"]["paused"], true);
    assert_eq!(detail["delivery_issues"], json!([]));

    // The decision reaches the manager; when that cannot be delivered, the Task says so.
    let (status, body) = call(
        &env,
        Method::POST,
        &format!("{tasks}/review"),
        json!({"request_id": task.request_id, "accept": false, "reason": "again"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    struct Failing;
    impl RouteSink for Failing {
        fn deliver(&self, _request: &DeliveryRequest<'_>) -> DeliveryOutcome {
            DeliveryOutcome::Failed("provider unavailable".into())
        }
    }
    for step in 0..10 {
        env.state
            .orchestrator
            .deliver_due(&Failing, 1_000_000 * (step + 1))
            .unwrap();
    }
    let (_, detail) = call(&env, Method::GET, &tasks, Value::Null).await;
    let issues = detail["delivery_issues"].as_array().unwrap();
    assert_eq!(issues.len(), 1, "{detail}");
    assert_eq!(issues[0]["source_kind"], "review");
    assert_eq!(issues[0]["route"]["kind"], "task_review");
    assert_eq!(issues[0]["route"]["state"], "failed");
    assert_eq!(issues[0]["route"]["retryable"], true);
}

#[tokio::test]
async fn stopping_a_members_turn_leaves_its_assigned_work_open() {
    let env = env();
    let task = reviewing(&env).await;
    let item = env.state.work.get(&env.project, &task.work_id).unwrap();
    let run = env
        .agents
        .start_run(
            &env.specialist,
            &env.project,
            "working on it",
            kubecode_server::agents::PermissionMode::Safe,
        )
        .unwrap();
    env.state.agent_runtime.cancel(&run.id);
    // Only the attempt's own report ends it; Stop says the work stays open.
    let after = env.state.work.get(&env.project, &task.work_id).unwrap();
    assert_eq!(after.stage, item.stage);
    assert_eq!(after.lifecycle, item.lifecycle);
    let summary = env
        .state
        .work
        .list(
            &env.project,
            &kubecode_server::work_store::WorkFilter {
                research_id: Some(task.research_id.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    let attempt = summary[0].latest_attempt.as_ref().unwrap();
    use kubecode_server::work_store::AttemptStatus;
    assert!(
        !matches!(
            attempt.status,
            AttemptStatus::Completed | AttemptStatus::Failed | AttemptStatus::Cancelled
        ),
        "{attempt:?}"
    );
}

/// The question view decides from the research record itself whether a
/// question is a Task, whatever the board lists (ADR 0230 §3).
#[tokio::test]
async fn a_research_record_says_whether_it_is_a_task_and_in_which_stage() {
    let env = env();
    let task = reviewing(&env).await;
    let draft = env
        .agent(&env.general)
        .task_propose(brief("Quantize"), Some("quant"))
        .unwrap();
    let read = |id: &str| format!("/projects/{}/research/{id}", env.project);
    let (status, body) = call(&env, Method::GET, &read(&task.research_id), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["task_stage"], "review", "{body}");
    let (_, body) = call(&env, Method::GET, &read(&draft.research_id), Value::Null).await;
    assert_eq!(body["task_stage"], Value::Null, "{body}");
}

/// The work board knows a Task's internal work, so it sends the researcher
/// to the Task's Results to accept changed evidence (ADR 0230 §4).
#[tokio::test]
async fn a_work_card_says_its_question_is_a_task() {
    let env = env();
    let task = reviewing(&env).await;
    let (status, card) = call(
        &env,
        Method::GET,
        &format!("/projects/{}/work/{}", env.project, task.work_id),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["research"]["task"], true, "{card}");
}

/// "Show the message" narrows General to the Task only when the authorizing
/// message is in the Task's scope.
#[tokio::test]
async fn the_authorizing_message_says_whether_it_is_in_the_tasks_scope() {
    let env = env();
    let task = reviewing(&env).await;
    let detail = |id: String| {
        let env = &env;
        async move {
            let (status, body) = call(
                env,
                Method::GET,
                &format!("/projects/{}/tasks/{id}", env.project),
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            body
        }
    };
    let body = detail(task.research_id.clone()).await;
    assert_eq!(
        body["authorizing_message"]["task_id"],
        Value::Null,
        "{body}"
    );
    // An instruction that names the Task is in its scope.
    let manager = env.agent(&env.general);
    let proposal = manager
        .task_propose(brief("Quantize"), Some("quant"))
        .unwrap();
    let channel = env.state.channels.default_channel(&env.project).unwrap();
    let (status, message) = call(
        &env,
        Method::POST,
        &format!("/projects/{}/channels/{}/messages", env.project, channel.id),
        json!({
            "body": "Add this one to the board",
            "references": [{"kind": "research", "id": proposal.research_id}],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{message}");
    manager
        .task_admit(
            &proposal.research_id,
            message["id"].as_str().unwrap(),
            proposal.revision,
        )
        .unwrap();
    let body = detail(proposal.research_id.clone()).await;
    assert_eq!(
        body["authorizing_message"]["task_id"],
        json!(proposal.research_id),
        "{body}"
    );
}

/// A suggested change of direction waits on the researcher like any other
/// decision, under a stable key, until it is decided.
#[tokio::test]
async fn a_suggested_change_of_direction_is_pending() {
    let env = env();
    let task = reviewing(&env).await;
    let published = env
        .state
        .research
        .publish(
            &env.project,
            &task.research_id,
            kubecode_server::research_store::NewPublication {
                key: "suggest-1".into(),
                author_kind: kubecode_server::research_store::AuthorKind::Agent,
                author_ref: None,
                producer: Default::default(),
                round_id: None,
                findings: Vec::new(),
                proposals: vec!["Relax the single-GPU constraint".into()],
            },
        )
        .unwrap();
    let entry = published.proposals[0].id.clone();
    let path = format!("/projects/{}/tasks/{}", env.project, task.research_id);
    let (_, body) = call(&env, Method::GET, &path, Value::Null).await;
    let keys: Vec<&str> = body["pending"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pending| pending["key"].as_str().unwrap())
        .collect();
    assert!(
        keys.contains(&format!("suggestion:{entry}").as_str()),
        "{body}"
    );
    env.state
        .research
        .review_proposal(
            &env.project,
            &task.research_id,
            &entry,
            kubecode_server::research_store::ReviewDecision::Rejected,
            None,
        )
        .unwrap();
    let (_, body) = call(&env, Method::GET, &path, Value::Null).await;
    assert!(
        body["pending"]
            .as_array()
            .unwrap()
            .iter()
            .all(|pending| pending["kind"] != "suggestion"),
        "{body}"
    );
}
