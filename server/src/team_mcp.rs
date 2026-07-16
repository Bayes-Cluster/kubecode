use agent_client_protocol::mcp_server::McpServer;
use agent_client_protocol::{Agent, RunWithConnectionTo};
use agent_client_protocol_rmcp::McpServerExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent_runtime::{AgentRuntime, RuntimeError};
use crate::agents::AgentId;
use crate::team_coordinator::{SpawnTeammate, TeamCoordinator};
use crate::teams::{MemberWorkspaceMode, NewTeamTask, TeamMember, TeamMessageKind, TeamStore};

#[derive(Clone)]
struct ToolContext {
    runtime: AgentRuntime,
    teams: std::sync::Arc<TeamStore>,
    member: TeamMember,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SpawnInput {
    agent_id: String,
    name: String,
    #[serde(default = "shared_workspace")]
    workspace_mode: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateTaskInput {
    title: String,
    description: String,
    #[serde(default)]
    dependencies: Vec<String>,
    #[serde(default)]
    owned_paths: Vec<String>,
    #[serde(default)]
    requires_plan_approval: bool,
    #[serde(default)]
    mutates_files: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct TaskInput {
    task_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SubmitResultInput {
    task_id: String,
    result: String,
    verification: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReviewResultInput {
    task_id: String,
    accepted: bool,
    feedback: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SendMessageInput {
    to_member_id: String,
    body: String,
    task_id: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
struct ToolOutput {
    json: String,
}

pub fn build_team_mcp(
    runtime: AgentRuntime,
    conversation_id: &str,
) -> Result<Option<McpServer<Agent, impl RunWithConnectionTo<Agent> + 'static>>, RuntimeError> {
    let Some(teams) = runtime.team_store() else {
        return Ok(None);
    };
    let Some(team) = teams
        .team_for_conversation(conversation_id)
        .map_err(team_runtime_error)?
    else {
        return Ok(None);
    };
    let member = teams
        .list_members(&team.id)
        .map_err(team_runtime_error)?
        .into_iter()
        .find(|member| member.conversation_id == conversation_id)
        .ok_or_else(|| RuntimeError::Acp("team member is missing for this conversation".into()))?;
    let context = ToolContext {
        runtime,
        teams,
        member,
    };

    let spawn_context = context.clone();
    let create_context = context.clone();
    let list_context = context.clone();
    let claim_context = context.clone();
    let submit_context = context.clone();
    let review_context = context.clone();
    let send_context = context.clone();
    let inbox_context = context;
    let server = McpServer::<Agent>::builder("kubecode-team")
        .instructions(
            "Coordinate this Kubecode Team through these tools. The Leader delegates and has final authority; teammates claim tasks and report results.",
        )
        .tool_fn(
            "team_spawn_teammate",
            "Leader only: create a teammate backed by Codex, Claude Code, or OpenCode.",
            async move |input: SpawnInput, _connection| {
                let agent_id = input.agent_id.parse::<AgentId>().map_err(|_| {
                    mcp_error(format!("unsupported agent id: {}", input.agent_id))
                })?;
                if !spawn_context.runtime.agent_available(agent_id) {
                    return Err(mcp_error(format!("agent is not available: {agent_id:?}")));
                }
                let workspace_mode = parse_workspace_mode(&input.workspace_mode)?;
                let coordinator = coordinator(&spawn_context);
                let member = coordinator
                    .spawn_teammate(SpawnTeammate {
                        team_id: &spawn_context.member.team_id,
                        caller_member_id: &spawn_context.member.id,
                        agent_id,
                        name: &input.name,
                        workspace_mode,
                    })
                    .map_err(mcp_error)?;
                spawn_context
                    .runtime
                    .initialize_conversation(&member.conversation_id)
                    .await
                    .map_err(mcp_error)?;
                json_output(&member)
            },
            agent_client_protocol_rmcp::tool_fn!(),
        )
        .tool_fn(
            "team_create_task",
            "Leader only: create a task with dependencies and optional path ownership.",
            async move |input: CreateTaskInput, _connection| {
                let task = create_context
                    .teams
                    .create_task(NewTeamTask {
                        team_id: &create_context.member.team_id,
                        creator_member_id: &create_context.member.id,
                        title: &input.title,
                        description: &input.description,
                        dependencies: &input.dependencies,
                        owned_paths: &input.owned_paths,
                        requires_plan_approval: input.requires_plan_approval,
                        mutates_files: input.mutates_files,
                    })
                    .map_err(mcp_error)?;
                json_output(&task)
            },
            agent_client_protocol_rmcp::tool_fn!(),
        )
        .tool_fn(
            "team_list_tasks",
            "List the current Team task board.",
            async move |_: EmptyInput, _connection| {
                let tasks = list_context
                    .teams
                    .list_tasks(&list_context.member.team_id)
                    .map_err(mcp_error)?;
                json_output(&tasks)
            },
            agent_client_protocol_rmcp::tool_fn!(),
        )
        .tool_fn(
            "team_claim_task",
            "Claim an available, unblocked Team task for the current member.",
            async move |input: TaskInput, _connection| {
                let task = claim_context
                    .teams
                    .claim_task(&input.task_id, &claim_context.member.id)
                    .map_err(mcp_error)?;
                json_output(&task)
            },
            agent_client_protocol_rmcp::tool_fn!(),
        )
        .tool_fn(
            "team_submit_result",
            "Submit a completed task result and verification to wake the Leader for review.",
            async move |input: SubmitResultInput, _connection| {
                coordinator(&submit_context)
                    .submit_result(
                        &input.task_id,
                        &submit_context.member.id,
                        &input.result,
                        input.verification.as_deref(),
                    )
                    .map_err(mcp_error)?;
                submit_context
                    .runtime
                    .wake_team_leader(&submit_context.member.team_id)
                    .map_err(mcp_error)?;
                json_output(&serde_json::json!({"submitted": true}))
            },
            agent_client_protocol_rmcp::tool_fn!(),
        )
        .tool_fn(
            "team_review_result",
            "Leader only: accept a teammate result or request changes.",
            async move |input: ReviewResultInput, _connection| {
                let task = coordinator(&review_context)
                    .review_result(
                        &input.task_id,
                        &review_context.member.id,
                        input.accepted,
                        input.feedback.as_deref(),
                    )
                    .map_err(mcp_error)?;
                json_output(&task)
            },
            agent_client_protocol_rmcp::tool_fn!(),
        )
        .tool_fn(
            "team_send_message",
            "Send a persistent direct message to another Team member.",
            async move |input: SendMessageInput, _connection| {
                let message = send_context
                    .teams
                    .send_message(
                        &send_context.member.team_id,
                        &send_context.member.id,
                        &input.to_member_id,
                        TeamMessageKind::Direct,
                        input.task_id.as_deref(),
                        &input.body,
                    )
                    .map_err(mcp_error)?;
                json_output(&message)
            },
            agent_client_protocol_rmcp::tool_fn!(),
        )
        .tool_fn(
            "team_read_inbox",
            "Read and acknowledge unread Team mailbox messages for the current member.",
            async move |_: EmptyInput, _connection| {
                let messages = inbox_context
                    .teams
                    .unread_messages(&inbox_context.member.id)
                    .map_err(mcp_error)?;
                inbox_context
                    .teams
                    .mark_messages_read(&inbox_context.member.id)
                    .map_err(mcp_error)?;
                json_output(&messages)
            },
            agent_client_protocol_rmcp::tool_fn!(),
        )
        .build();
    Ok(Some(server))
}

#[derive(Debug, Deserialize, JsonSchema)]
struct EmptyInput {}

fn coordinator(context: &ToolContext) -> TeamCoordinator {
    TeamCoordinator::new(
        context.runtime.workspace_service(),
        context.runtime.store(),
        std::sync::Arc::clone(&context.teams),
    )
}

fn parse_workspace_mode(value: &str) -> Result<MemberWorkspaceMode, agent_client_protocol::Error> {
    match value {
        "shared" => Ok(MemberWorkspaceMode::Shared),
        "isolated" => Ok(MemberWorkspaceMode::Isolated),
        _ => Err(mcp_error(format!("unsupported workspace mode: {value}"))),
    }
}

fn shared_workspace() -> String {
    "shared".into()
}

fn json_output(value: &impl Serialize) -> Result<ToolOutput, agent_client_protocol::Error> {
    serde_json::to_string(value)
        .map(|json| ToolOutput { json })
        .map_err(mcp_error)
}

fn mcp_error(error: impl std::fmt::Display) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(error.to_string())
}

fn team_runtime_error(error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Acp(error.to_string())
}
