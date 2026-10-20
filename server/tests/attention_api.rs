//! What waits on the researcher (#220, ADR 0232) over HTTP under a non-root
//! base path: decisions appear once in the attention snapshot as members make
//! them necessary, and leave it when the researcher answers on the existing
//! endpoints, with a newer cursor.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_store::AgentStore;
use kubecode_server::agents::AgentId;
use kubecode_server::api::{AppState, app_router};
use kubecode_server::research_store::ResearchBrief;
use kubecode_server::teams::TeamStore;
use kubecode_server::work_agent::{Evidence, NewTask, WorkAgent};
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
}

fn brief(title: &str) -> ResearchBrief {
    ResearchBrief {
        title: title.into(),
        question: "Does head pruning hold accuracy?".into(),
        ..Default::default()
    }
}

async fn snapshot(env: &Env, project: &str) -> Value {
    let (status, body) = call(
        env,
        Method::GET,
        &format!("/projects/{project}/attention"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

fn keys(snapshot: &Value) -> Vec<String> {
    snapshot["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["key"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn decisions_appear_once_and_leave_when_the_researcher_answers() {
    let env = env();
    let (status, body) = call(&env, Method::GET, "/projects/nope/attention", Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "not_found");
    let empty = snapshot(&env, &env.project).await;
    assert!(empty["cursor"].as_u64().is_some());
    assert!(keys(&empty).is_empty(), "{empty}");
    assert_eq!(empty["incomplete"], json!([]));

    // The manager shows a proposal: it waits for the researcher's word.
    let manager = env.agent(&env.general);
    let proposal = manager
        .task_propose(brief("Prune heads"), Some("prune"))
        .unwrap();
    let shown = snapshot(&env, &env.project).await;
    let key = format!("proposal:{}:{}", proposal.research_id, proposal.revision);
    assert_eq!(keys(&shown), [key]);
    assert_eq!(shown["items"][0]["message_id"], json!(proposal.message_id));
    assert_eq!(shown["items"][0]["task"]["title"], "Prune heads");

    // Admitted on the researcher's words: gone. Started, with work and a question.
    let admit = env.say("Add it to the board").await;
    manager
        .task_admit(&proposal.research_id, &admit, proposal.revision)
        .unwrap();
    let go = env.say("Go ahead.").await;
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
    let (asked, _) = env
        .state
        .work
        .request_decision(
            &env.project,
            &work.item.id,
            "q1",
            &env.specialist,
            "Which ratios?",
            &[],
            None,
            None,
        )
        .unwrap();
    let before = snapshot(&env, &env.project).await;
    assert_eq!(keys(&before), [format!("question:{}", asked.id)]);
    let item = &before["items"][0];
    assert_eq!(item["kind"], "question");
    assert_eq!(item["task"]["id"], json!(proposal.research_id));
    assert_eq!(item["work_title"], "Sweep ratios");

    // Answered on its own endpoint: gone, and the cursor moved on.
    let (status, body) = call(
        &env,
        Method::POST,
        &format!(
            "/projects/{}/work/{}/decisions/{}/answer",
            env.project, work.item.id, asked.id
        ),
        json!({"answer": "0.5 and 0.7"}),
    )
    .await;
    assert!(status.is_success(), "{body}");
    let after = snapshot(&env, &env.project).await;
    assert!(keys(&after).is_empty(), "{after}");
    assert!(after["cursor"].as_u64() > before["cursor"].as_u64());

    // A review request waits until it is decided.
    let item = env.state.work.get(&env.project, &work.item.id).unwrap();
    env.state
        .work
        .close(
            &env.project,
            &work.item.id,
            item.revision,
            kubecode_server::work_store::Closure {
                lifecycle: kubecode_server::work_store::WorkLifecycle::Canceled,
                reason: "done differently",
                superseded_by: None,
            },
            &kubecode_server::work_store::Actor::Researcher,
        )
        .unwrap();
    let request = manager
        .task_request_review(&proposal.research_id, "It held.", &[])
        .unwrap();
    assert_eq!(
        keys(&snapshot(&env, &env.project).await),
        [format!("review:{}", request.id)]
    );
    let (status, body) = call(
        &env,
        Method::POST,
        &format!(
            "/projects/{}/tasks/{}/review",
            env.project, proposal.research_id
        ),
        json!({"request_id": request.id, "accept": true, "outcome": "supported"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(keys(&snapshot(&env, &env.project).await).is_empty());
}

#[tokio::test]
async fn the_summary_counts_every_workspace() {
    let env = env();
    let manager = env.agent(&env.general);
    manager
        .task_propose(brief("Prune heads"), Some("prune"))
        .unwrap();
    let (status, summary) = call(&env, Method::GET, "/attention/summary", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let workspaces = summary["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 2, "{summary}");
    let of = |project: &str| {
        workspaces
            .iter()
            .find(|counts| counts["project_id"] == project)
            .unwrap()
            .clone()
    };
    assert_eq!(of(&env.project)["decisions"], 1);
    assert_eq!(of(&env.other_project)["decisions"], 0);
    assert_eq!(of(&env.project)["incomplete"], false);
}
