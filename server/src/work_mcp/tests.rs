use serde_json::{Value, json};

use super::*;
use crate::agents::{AgentId, PermissionMode};
use crate::channel_store::{Intent, NewMessage};
use crate::experiment_store::testing::Fixture;

struct Rig {
    f: Fixture,
    state: AppState,
    runtime: AgentRuntime,
}

fn rig() -> Rig {
    let f = Fixture::new();
    let state = AppState::new(
        std::sync::Arc::clone(&f.workspace),
        std::sync::Arc::clone(&f.agents),
        std::sync::Arc::clone(&f.teams),
    )
    .with_agents(vec![crate::agent_discovery::AgentDescriptor {
        id: AgentId::OpenCode,
        available: true,
        version: Some("test".into()),
        executable: "/bin/true".into(),
        error: None,
    }])
    .with_team_mcp_http_origin("http://127.0.0.1:9999/base");
    let runtime = state.agent_runtime.as_ref().clone();
    Rig { f, state, runtime }
}

impl Rig {
    fn server(&self, conversation_id: &str) -> WorkMcpServer {
        WorkMcpServer::new(
            self.runtime.clone(),
            self.f.project_id.clone(),
            conversation_id.to_owned(),
        )
    }

    fn leader(&self) -> WorkMcpServer {
        self.server(&self.f.leader.conversation_id)
    }

    fn session(&self, title: &str) -> String {
        self.f
            .agents
            .create_conversation(&self.f.project_id, AgentId::OpenCode, Some(title))
            .unwrap()
            .id
    }
}

fn payload(result: Result<CallToolResult, McpError>) -> Value {
    let result = result.expect("tool result");
    let value = serde_json::to_value(&result).expect("serialize");
    let text = value["content"][0]["text"].as_str().expect("text content");
    serde_json::from_str(text).expect("json payload")
}

fn refused(result: Result<CallToolResult, McpError>) -> String {
    result
        .expect_err("the tool must refuse")
        .message
        .to_string()
}

#[tokio::test]
async fn a_coordinator_drives_a_task_from_creation_to_acceptance_through_the_tools() {
    let rig = rig();
    let leader = rig.leader();
    let task = payload(
        leader
            .work_create(Parameters(CreateInput {
                round_id: None,
                title: "Sweep".into(),
                description: "Try ratios".into(),
                plan: None,
                depends_on: vec![],
                from_thread: None,
                client_request_id: "c-1".into(),
            }))
            .await,
    );
    let work_id = task["item"]["id"].as_str().unwrap().to_owned();
    let created = payload(
        leader
            .work_executor_create(Parameters(ExecutorInput {
                request_key: "e-1".into(),
                round_id: None,
                agent: "opencode".into(),
                title: Some("Pruner".into()),
            }))
            .await,
    );
    let executor_id = created["session_id"].as_str().unwrap().to_owned();
    payload(
        leader
            .work_assign(Parameters(AssignInput {
                work_id: work_id.clone(),
                session_id: executor_id.clone(),
                member: None,
                reason: None,
            }))
            .await,
    );
    let attempt = payload(
        leader
            .work_start(Parameters(StartInput {
                work_id: work_id.clone(),
                request_key: "s-1".into(),
            }))
            .await,
    );
    assert_eq!(attempt["status"], "queued");

    // The executor has a running turn; it reports under its own identity.
    rig.f
        .agents
        .start_run(&executor_id, &rig.f.project_id, "go", PermissionMode::Safe)
        .unwrap();
    let executor = rig.server(&executor_id);
    payload(
        executor
            .work_attach(Parameters(AttachInput {
                work_id: work_id.clone(),
                kind: "file".into(),
                id: "results/sweep.csv".into(),
                revision: None,
                role: None,
            }))
            .await,
    );
    let reported = payload(
        executor
            .work_report(Parameters(ReportInput {
                work_id: work_id.clone(),
                status: "completed".into(),
                summary: "30% is best".into(),
                error: None,
            }))
            .await,
    );
    assert_eq!(reported["item"]["stage"], "review");
    let done = payload(
        leader
            .work_review(Parameters(ReviewInput {
                work_id: work_id.clone(),
                accept: true,
                outcome: Some("supported".into()),
                reason: Some("reproducible".into()),
            }))
            .await,
    );
    assert_eq!(done["item"]["stage"], "done");
    assert_eq!(done["item"]["outcome"], "supported");
}

#[tokio::test]
async fn identity_is_the_session_not_an_argument_and_roles_are_not_taken_on_trust() {
    let rig = rig();
    let leader = rig.leader();
    let item = payload(
        leader
            .work_create(Parameters(CreateInput {
                round_id: None,
                title: "Secret plan".into(),
                description: "d".into(),
                plan: None,
                depends_on: vec![],
                from_thread: None,
                client_request_id: "x".into(),
            }))
            .await,
    );
    let work_id = item["item"]["id"].as_str().unwrap().to_owned();
    // A Session that merely names the leader's round gets nothing.
    let impostor = rig.server(&rig.session("Impostor"));
    let message = refused(
        impostor
            .work_policy(Parameters(RoundInput {
                round_id: Some(rig.f.round_id.clone()),
            }))
            .await,
    );
    assert!(message.contains("coordinate"), "{message}");
    for result in [
        impostor
            .work_create(Parameters(CreateInput {
                round_id: Some(rig.f.round_id.clone()),
                title: "x".into(),
                description: "x".into(),
                plan: None,
                depends_on: vec![],
                from_thread: None,
                client_request_id: "y".into(),
            }))
            .await,
        impostor
            .work_get(Parameters(WorkIdInput {
                work_id: work_id.clone(),
            }))
            .await,
        impostor
            .work_handoff(Parameters(HandoffInput {
                round_id: rig.f.round_id.clone(),
                to_session: rig.f.leader.conversation_id.clone(),
                reason: "take over".into(),
            }))
            .await,
    ] {
        assert!(result.is_err());
    }
    // It cannot even learn that the task exists.
    let list = payload(impostor.work_list(Parameters(RoundInput::default())).await);
    assert_eq!(list, json!([]));
    // And the schema offers no way to widen a budget.
    let tools: Vec<String> = WorkMcpServer::tool_router()
        .list_all()
        .into_iter()
        .map(|tool| tool.name.to_string())
        .collect();
    assert!(
        !tools
            .iter()
            .any(|name| name.contains("policy_set") || name.contains("budget"))
    );
    assert!(tools.contains(&"work_policy".to_string()));
}

#[tokio::test]
async fn the_old_coordinators_next_call_fails_after_a_handoff() {
    let rig = rig();
    let old = rig.leader();
    let successor_id = rig.session("Successor");
    payload(
        old.work_handoff(Parameters(HandoffInput {
            round_id: rig.f.round_id.clone(),
            to_session: successor_id.clone(),
            reason: "rotating".into(),
        }))
        .await,
    );
    let create = |client_request_id: &str| CreateInput {
        round_id: None,
        title: "T".into(),
        description: "d".into(),
        plan: None,
        depends_on: vec![],
        from_thread: None,
        client_request_id: client_request_id.into(),
    };
    assert!(old.work_create(Parameters(create("late"))).await.is_err());
    let new = rig.server(&successor_id);
    assert!(new.work_create(Parameters(create("fresh"))).await.is_ok());
}

#[tokio::test]
async fn limits_and_provider_availability_reach_the_agent_as_clear_errors() {
    let rig = rig();
    let leader = rig.leader();
    let message = refused(
        leader
            .work_executor_create(Parameters(ExecutorInput {
                request_key: "e-2".into(),
                round_id: None,
                agent: "gpt-9000".into(),
                title: None,
            }))
            .await,
    );
    assert!(message.contains("unknown agent"), "{message}");
    rig.state
        .work
        .set_policy(
            &rig.f.project_id,
            &rig.f.round_id,
            0,
            crate::work_store::PolicyPatch {
                paused: Some(true),
                ..Default::default()
            },
            &crate::work_store::Actor::Researcher,
        )
        .unwrap();
    let paused = refused(
        leader
            .work_executor_create(Parameters(ExecutorInput {
                request_key: "e-3".into(),
                round_id: None,
                agent: "opencode".into(),
                title: None,
            }))
            .await,
    );
    assert!(
        paused.contains("paused") || paused.contains("installed"),
        "{paused}"
    );
    let view = payload(leader.work_policy(Parameters(RoundInput::default())).await);
    assert_eq!(view["policy"]["paused"], true);
    assert_eq!(view["used"]["executors"], 1);
}

#[tokio::test]
async fn work_posts_land_in_the_conversation_as_the_agent_and_only_where_it_has_standing() {
    let rig = rig();
    let channel = rig
        .state
        .channels
        .default_channel(&rig.f.project_id)
        .unwrap();
    let root = rig
        .state
        .channels
        .post(
            &rig.f.project_id,
            &channel.id,
            NewMessage {
                body: "Pruning?",
                ..Default::default()
            },
        )
        .unwrap()
        .0;
    let (thread, _) = rig
        .state
        .channels
        .start_thread(&rig.f.project_id, &channel.id, &root.id, None, None)
        .unwrap();
    rig.state
        .channels
        .link_thread(
            &rig.f.project_id,
            &thread.id,
            1,
            Some(&rig.f.research_id),
            Some(&rig.f.round_id),
        )
        .unwrap();
    let leader = rig.leader();
    let posted = payload(
        leader
            .work_post(Parameters(PostInput {
                in_reply_to: thread.id.clone(),
                body: "Two sweeps, then analysis.".into(),
                references: vec![],
            }))
            .await,
    );
    assert_eq!(posted["thread_id"], thread.id);
    let stranger = rig.server(&rig.session("Stranger"));
    assert!(
        stranger
            .work_post(Parameters(PostInput {
                in_reply_to: thread.id.clone(),
                body: "hello".into(),
                references: vec![],
            }))
            .await
            .is_err()
    );
    let _ = Intent::Say;
}

fn advertised(rig: &Rig, conversation: &str, name: &str) -> String {
    rig.runtime
        .mcp_http_servers(conversation)
        .unwrap()
        .into_iter()
        .find_map(|server| match server {
            agent_client_protocol::schema::v1::McpServer::Http(http) if http.name == name => {
                http.url.rsplit('/').nth(1).map(str::to_owned)
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("{name} not advertised"))
}

#[test]
fn the_work_credential_is_scoped_to_one_server_and_one_conversation() {
    let rig = rig();
    let member = rig.f.teammate.conversation_id.clone();
    let other = rig.session("Other");
    let work = advertised(&rig, &member, "kubecode-work");
    let context = advertised(&rig, &member, "kubecode-context");
    let team = advertised(&rig, &member, "kubecode-team");
    let others_work = advertised(&rig, &other, "kubecode-work");
    assert!(rig.runtime.authorize_mcp("work", &member, &work));
    // The credentials every Session holds for other servers cannot open this one,
    // and one conversation's cannot open another's.
    assert!(!rig.runtime.authorize_mcp("work", &member, &context));
    assert!(!rig.runtime.authorize_mcp("work", &member, &team));
    assert!(!rig.runtime.authorize_mcp("work", &member, &others_work));
    assert!(!rig.runtime.authorize_mcp("context", &member, &work));
    assert!(!rig.runtime.authorize_mcp("work", &member, ""));
}

#[tokio::test]
async fn the_advertised_url_serves_the_tools_and_a_wrong_token_is_refused() {
    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request, header};
    use tower::ServiceExt;

    let rig = rig();
    let app = crate::api::app_router(rig.state.clone(), "/base");
    let session = rig.session("http caller");
    let url = match rig
        .runtime
        .mcp_http_servers(&session)
        .unwrap()
        .into_iter()
        .find(|server| matches!(server, agent_client_protocol::schema::v1::McpServer::Http(http) if http.name == "kubecode-work"))
        .unwrap()
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
    assert!(body.contains("kubecode-work"), "{body}");
    let session_id = session_id.expect("session id");
    rpc(
        path.clone(),
        Some(session_id.clone()),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await;
    let (_, _, listed) = rpc(
        path.clone(),
        Some(session_id.clone()),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await;
    for tool in [
        "work_policy",
        "work_create",
        "work_start",
        "work_report",
        "work_post",
    ] {
        assert!(listed.contains(tool), "{tool} missing: {listed}");
    }
    // A Session with no standing gets an error, not data.
    let (_, _, called) = rpc(
        path,
        Some(session_id),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
               "params":{"name":"work_policy","arguments":{}}}),
    )
    .await;
    assert!(called.contains("coordinate"), "{called}");
}

#[tokio::test]
async fn experiments_decisions_and_the_brief_are_tools_bound_to_the_executing_session() {
    let rig = rig();
    let leader = rig.leader();
    let task = payload(
        leader
            .work_create(Parameters(CreateInput {
                round_id: None,
                title: "Sweep".into(),
                description: "Try ratios".into(),
                plan: None,
                depends_on: vec![],
                from_thread: None,
                client_request_id: "c-1".into(),
            }))
            .await,
    );
    let work_id = task["item"]["id"].as_str().unwrap().to_owned();
    let executor_id = payload(
        leader
            .work_executor_create(Parameters(ExecutorInput {
                request_key: "e-1".into(),
                round_id: None,
                agent: "opencode".into(),
                title: None,
            }))
            .await,
    )["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    payload(
        leader
            .work_assign(Parameters(AssignInput {
                work_id: work_id.clone(),
                session_id: executor_id.clone(),
                member: None,
                reason: None,
            }))
            .await,
    );
    payload(
        leader
            .work_start(Parameters(StartInput {
                work_id: work_id.clone(),
                request_key: "s-1".into(),
            }))
            .await,
    );
    let executor = rig.server(&executor_id);

    let brief = payload(
        executor
            .work_brief(Parameters(WorkIdInput {
                work_id: work_id.clone(),
            }))
            .await,
    );
    assert_eq!(brief["title"], "Sweep");
    assert_eq!(brief["resources"]["policy"]["paused"], false);

    // The researcher's authorized commands bound what a Session can run.
    let launch = |key: &str, argv: &[&str]| LaunchInput {
        work_id: work_id.clone(),
        launch_key: key.into(),
        argv: argv.iter().map(|t| (*t).to_owned()).collect(),
        cwd: None,
        label: None,
        artifacts: vec![],
        max_runtime_secs: None,
    };
    let denied = refused(
        executor
            .work_launch_experiment(Parameters(launch("k-1", &["rm", "-rf", "x"])))
            .await,
    );
    assert!(denied.contains("command_not_authorized"), "{denied}");
    // The coordinator is not the executing Session, and a decision about an
    // experiment that is not this task's finds nothing.
    let by_leader = refused(
        leader
            .work_launch_experiment(Parameters(launch("k-2", &["echo", "x"])))
            .await,
    );
    assert!(by_leader.contains("executing"), "{by_leader}");
    let unknown = refused(
        executor
            .work_decide(Parameters(DecideInput {
                work_id: work_id.clone(),
                experiment_id: "nope".into(),
                decision: "conclude".into(),
                decision_key: None,
                rationale: "because".into(),
                evidence: vec![],
                launch: None,
                question: None,
                options: vec![],
            }))
            .await,
    );
    assert!(unknown.contains("not found"), "{unknown}");

    let asked = payload(
        executor
            .work_request_decision(Parameters(RequestDecisionInput {
                work_id: work_id.clone(),
                request_key: "q-1".into(),
                question: "More budget?".into(),
                options: vec![],
                impact: None,
            }))
            .await,
    );
    assert_eq!(asked["state"], "open");
    let asked_again = payload(
        executor
            .work_request_decision(Parameters(RequestDecisionInput {
                work_id: work_id.clone(),
                request_key: "q-1".into(),
                question: "More budget?".into(),
                options: vec![],
                impact: None,
            }))
            .await,
    );
    assert_eq!(asked_again["id"], asked["id"]);
    // Re-pinning is the coordinator's act.
    let repin = refused(
        executor
            .work_repin(Parameters(RepinInput {
                work_id: work_id.clone(),
                result_id: "r".into(),
            }))
            .await,
    );
    assert!(repin.contains("coordinate"), "{repin}");
}

#[tokio::test]
async fn the_roster_is_a_tool_and_work_goes_to_specialist_members_by_handle() {
    let rig = rig();
    let leader = rig.leader();
    let available: &dyn Fn(AgentId) -> bool = &|_| true;
    rig.state
        .members
        .ensure_general(&rig.f.project_id, available, AgentId::OpenCode)
        .unwrap();
    let analyst = rig
        .state
        .members
        .create_specialist(
            &rig.f.project_id,
            crate::member_store::NewMember {
                name: "Analyst".into(),
                template: Some(crate::member_store::MemberTemplate::Analysis),
                ..Default::default()
            },
            available,
            AgentId::OpenCode,
        )
        .unwrap();
    let roster = payload(leader.work_members().await);
    let handles: Vec<(&str, bool)> = roster
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["handle"].as_str().unwrap(),
                m["assignable"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(handles, [("general", false), ("analyst", true)]);

    let task = payload(
        leader
            .work_create(Parameters(CreateInput {
                round_id: None,
                title: "Sweep".into(),
                description: "Try ratios".into(),
                plan: None,
                depends_on: vec![],
                from_thread: None,
                client_request_id: "c-m".into(),
            }))
            .await,
    );
    let work_id = task["item"]["id"].as_str().unwrap().to_owned();
    let assign = |member: &str| AssignInput {
        work_id: work_id.clone(),
        session_id: String::new(),
        member: Some(member.to_owned()),
        reason: None,
    };
    let to_general = refused(leader.work_assign(Parameters(assign("@general"))).await);
    assert!(to_general.contains("specialist members"), "{to_general}");
    let assigned = payload(leader.work_assign(Parameters(assign("@analyst"))).await);
    assert_eq!(
        assigned["assignment"]["conversation_id"].as_str(),
        analyst.public_conversation_id.as_deref()
    );
    assert_eq!(
        assigned["assignment"]["member_id"].as_str(),
        Some(analyst.id.as_str())
    );
    // The member is gone from the roster once removed; work cannot go to it.
    let other = payload(
        leader
            .work_create(Parameters(CreateInput {
                round_id: None,
                title: "Second".into(),
                description: "More".into(),
                plan: None,
                depends_on: vec![],
                from_thread: None,
                client_request_id: "c-m2".into(),
            }))
            .await,
    );
    let unknown = refused(
        leader
            .work_assign(Parameters(AssignInput {
                work_id: other["item"]["id"].as_str().unwrap().to_owned(),
                session_id: String::new(),
                member: Some("@nobody".into()),
                reason: None,
            }))
            .await,
    );
    assert!(unknown.contains("not found"), "{unknown}");
}

#[tokio::test]
async fn task_tools_are_the_managers_and_say_what_to_do_when_refused() {
    let rig = rig();
    let available: &dyn Fn(AgentId) -> bool = &|_| true;
    let general = rig
        .state
        .members
        .ensure_general(&rig.f.project_id, available, AgentId::OpenCode)
        .unwrap()
        .public_conversation_id
        .unwrap();
    let manager = rig.server(&general);
    let outsider = rig.leader();
    let propose = |title: &str| ProposeInput {
        title: title.into(),
        question: "Does it hold?".into(),
        motivation: None,
        hypotheses: vec![],
        constraints: vec![],
        success_criteria: vec!["within a point".into()],
        client_request_id: Some(title.replace(' ', "-")),
    };
    // A Session that is not a member cannot even draft.
    let message = refused(outsider.task_propose(Parameters(propose("Nope"))).await);
    assert!(message.contains("Workspace member"), "{message}");

    let proposal = payload(
        manager
            .task_propose(Parameters(propose("Prune heads")))
            .await,
    );
    let id = proposal["research_id"].as_str().unwrap().to_owned();
    let step = |message: &str, revision: Option<u64>| AuthorizedStepInput {
        research_id: id.clone(),
        message_id: message.to_owned(),
        brief_revision: revision,
    };
    // The revision they were shown is required.
    let missing = refused(manager.task_admit(Parameters(step("m", None))).await);
    assert!(missing.contains("brief_revision"), "{missing}");
    // The manager's own message is not the researcher's.
    let own = proposal["message_id"].as_str().unwrap();
    let by_agent = refused(manager.task_admit(Parameters(step(own, Some(1)))).await);
    assert!(by_agent.contains("researcher"), "{by_agent}");
    // The researcher speaks; the instruction is visible to the manager and admits.
    let channel = rig
        .state
        .channels
        .default_channel(&rig.f.project_id)
        .unwrap();
    let said = rig
        .state
        .channels
        .post(
            &rig.f.project_id,
            &channel.id,
            NewMessage {
                body: "Add it please",
                ..Default::default()
            },
        )
        .unwrap()
        .0;
    let recent = payload(
        manager
            .general_recent(Parameters(RecentInput::default()))
            .await,
    );
    assert!(
        recent
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == said.id.as_str() && m["author"] == "researcher")
    );
    let admitted = payload(
        manager
            .task_admit(Parameters(step(&said.id, Some(1))))
            .await,
    );
    assert_eq!(admitted["kind"], "admit");
    let list = payload(manager.task_list().await);
    assert_eq!(list["tasks"][0]["id"], id.as_str());
    assert_eq!(list["tasks"][0]["stage"], "ready");
    // Execution needs its own, later instruction; review is asked for by the manager.
    let early = refused(
        manager
            .task_start(Parameters(AuthorizedStepInput {
                research_id: id.clone(),
                message_id: said.id.clone(),
                brief_revision: None,
            }))
            .await,
    );
    assert!(
        early.contains("authorize") || early.contains("used"),
        "{early}"
    );
    let go = rig
        .state
        .channels
        .post(
            &rig.f.project_id,
            &channel.id,
            NewMessage {
                body: "Go ahead and run it",
                ..Default::default()
            },
        )
        .unwrap()
        .0;
    let started = payload(
        manager
            .task_start(Parameters(AuthorizedStepInput {
                research_id: id.clone(),
                message_id: go.id.clone(),
                brief_revision: None,
            }))
            .await,
    );
    assert_eq!(started["kind"], "execute");
    assert!(started["round_id"].is_string());
    let asked = payload(
        manager
            .task_request_review(Parameters(RequestReviewInput {
                research_id: id.clone(),
                summary: "Both ratios ran.".into(),
                evidence: vec![],
            }))
            .await,
    );
    assert_eq!(asked["state"], "open");
    let shown = payload(
        manager
            .task_show(Parameters(ShowInput {
                research_id: id.clone(),
            }))
            .await,
    );
    assert_eq!(shown["research_id"], id.as_str());
    let bad_evidence = refused(
        manager
            .task_request_review(Parameters(RequestReviewInput {
                research_id: id.clone(),
                summary: "x".into(),
                evidence: vec!["nonsense".into()],
            }))
            .await,
    );
    assert!(
        bad_evidence.contains("kind:id") || bad_evidence.contains("review"),
        "{bad_evidence}"
    );
    // An outsider cannot read the shared conversation through the tool.
    assert!(
        outsider
            .general_recent(Parameters(RecentInput::default()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn members_speak_in_general_by_name_and_a_direct_message_cannot() {
    let rig = rig();
    let available: &dyn Fn(AgentId) -> bool = &|_| true;
    let project = rig.f.project_id.clone();
    let general = rig
        .state
        .members
        .ensure_general(&project, available, AgentId::OpenCode)
        .unwrap();
    let analyst = rig
        .state
        .members
        .create_specialist(
            &project,
            crate::member_store::NewMember {
                name: "Analyst".into(),
                spec: Some(crate::member_store::MemberSpec {
                    agent_id: AgentId::OpenCode,
                    config: Default::default(),
                    instructions: String::new(),
                }),
                ..Default::default()
            },
            available,
            AgentId::OpenCode,
        )
        .unwrap();
    let manager = rig.server(general.public_conversation_id.as_deref().unwrap());
    let say = |body: &str, mentions: &[&str]| GeneralPostInput {
        body: body.into(),
        mentions: mentions.iter().map(|m| (*m).to_owned()).collect(),
        task: None,
        reply_to: None,
    };

    // A hand-off names a member; it is stored attributed, with depth, and queued
    // for the orchestrator.
    let first = payload(
        manager
            .general_post(Parameters(say(
                "@analyst please run the sweep",
                &["@Analyst"],
            )))
            .await,
    );
    let stored = rig
        .state
        .channels
        .message(&project, first["message_id"].as_str().unwrap())
        .unwrap();
    assert_eq!(stored.author_kind, crate::channel_store::AuthorKind::Agent);
    assert_eq!(stored.thread_id, None, "General, not a Thread");
    assert_eq!(stored.hops, 1);
    assert_eq!(
        stored.mentions[0].session_id,
        analyst.public_conversation_id.clone().unwrap()
    );
    assert!(
        rig.state
            .channels
            .pending_routing(10)
            .unwrap()
            .iter()
            .any(|m| m.id == stored.id)
    );
    // The same words with nothing said since are one message; later, a new one.
    let again = payload(
        manager
            .general_post(Parameters(say(
                "@analyst please run the sweep",
                &["analyst"],
            )))
            .await,
    );
    assert_eq!(again["message_id"], first["message_id"]);
    let channel = rig.state.channels.default_channel(&project).unwrap();
    rig.state
        .channels
        .post(
            &project,
            &channel.id,
            NewMessage {
                body: "ok",
                ..Default::default()
            },
        )
        .unwrap();
    let later = payload(
        manager
            .general_post(Parameters(say(
                "@analyst please run the sweep",
                &["analyst"],
            )))
            .await,
    );
    assert_ne!(later["message_id"], first["message_id"]);

    // Unknown names, too many names, and Sessions that are not public member
    // Sessions are refused with a reason.
    assert!(
        refused(
            manager
                .general_post(Parameters(say("hi", &["nobody"])))
                .await
        )
        .contains("no member answers")
    );
    assert!(
        refused(
            manager
                .general_post(Parameters(say("hi", &["a", "b", "c", "d", "e"])))
                .await
        )
        .contains("at most four")
    );
    let outsider = rig.leader();
    assert!(
        refused(outsider.general_post(Parameters(say("hi", &[]))).await).contains("public Session")
    );
    let dm = rig
        .state
        .members
        .ensure_dm_session(&project, &analyst.id, available)
        .unwrap()
        .dm_conversation_id
        .unwrap();
    let private = rig.server(&dm);
    assert!(refused(private.general_post(Parameters(say("leak?", &[]))).await).contains("private"));
}

#[tokio::test]
async fn a_private_session_cannot_publish_through_task_commands_and_hand_offs_are_rate_bounded() {
    let rig = rig();
    let available: &dyn Fn(AgentId) -> bool = &|_| true;
    let project = rig.f.project_id.clone();
    let general = rig
        .state
        .members
        .ensure_general(&project, available, AgentId::OpenCode)
        .unwrap();
    let analyst = rig
        .state
        .members
        .create_specialist(
            &project,
            crate::member_store::NewMember {
                name: "Analyst".into(),
                spec: Some(crate::member_store::MemberSpec {
                    agent_id: AgentId::OpenCode,
                    config: Default::default(),
                    instructions: String::new(),
                }),
                ..Default::default()
            },
            available,
            AgentId::OpenCode,
        )
        .unwrap();
    let dm = rig
        .state
        .members
        .ensure_dm_session(&project, &general.id, available)
        .unwrap()
        .dm_conversation_id
        .unwrap();
    let private = rig.server(&dm);
    let refusal = refused(
        private
            .task_propose(Parameters(ProposeInput {
                title: "Leak".into(),
                question: "private content?".into(),
                motivation: None,
                hypotheses: vec![],
                constraints: vec![],
                success_criteria: vec![],
                client_request_id: Some("leak".into()),
            }))
            .await,
    );
    assert!(refusal.contains("private"), "{refusal}");
    let channel = rig.state.channels.default_channel(&project).unwrap();
    assert!(
        rig.state
            .channels
            .messages(&project, &channel.id, Default::default())
            .unwrap()
            .messages
            .is_empty(),
        "nothing from the private Session reached General"
    );

    // A member's hand-offs are bounded per hour however they are shaped.
    let manager = rig.server(general.public_conversation_id.as_deref().unwrap());
    let say = |n: usize| GeneralPostInput {
        body: format!("please look at item {n}"),
        mentions: vec![analyst.handle.clone()],
        task: None,
        reply_to: None,
    };
    for n in 0..12 {
        payload(manager.general_post(Parameters(say(n))).await);
    }
    let limited = refused(manager.general_post(Parameters(say(12))).await);
    assert!(limited.contains("too many hand-offs"), "{limited}");
}
