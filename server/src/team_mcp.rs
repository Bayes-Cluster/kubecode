use std::sync::{Arc, OnceLock};

use agent_client_protocol::mcp_server::McpServer;
use agent_client_protocol::{Agent, RunWithConnectionTo};
use agent_client_protocol_rmcp::McpServerExt;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{
    CallToolResult, Content, Implementation, ProtocolVersion, ServerCapabilities, ServerInfo,
};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tower::ServiceExt;

use crate::agent_runtime::{AgentRuntime, RuntimeError};
use crate::agents::AgentId;
use crate::api::AppState;
use crate::team_coordinator::{SpawnTeammate, TeamCoordinator};
use crate::teams::{MemberWorkspaceMode, NewTeamTask, TeamMember, TeamMessageKind, TeamStore};

const TEAM_MCP_NAME: &str = "kubecode-team";
const TEAM_MCP_INSTRUCTIONS: &str = "Coordinate this Kubecode Team through these tools. The Leader delegates and has final authority; teammates claim tasks and report results.";
static HTTP_SESSIONS: OnceLock<Arc<LocalSessionManager>> = OnceLock::new();

#[derive(Clone)]
struct ToolContext {
    runtime: AgentRuntime,
    teams: Arc<TeamStore>,
    member: TeamMember,
}

#[derive(Clone)]
struct TeamMcpServer {
    context: ToolContext,
    tool_router: ToolRouter<Self>,
}

impl TeamMcpServer {
    fn new(context: ToolContext) -> Self {
        Self {
            context,
            tool_router: Self::tool_router(),
        }
    }
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

#[tool_router]
impl TeamMcpServer {
    #[tool(
        description = "Leader only: create a teammate backed by Codex, Claude Code, or OpenCode."
    )]
    async fn team_spawn_teammate(
        &self,
        Parameters(input): Parameters<SpawnInput>,
    ) -> Result<CallToolResult, McpError> {
        let agent_id = input
            .agent_id
            .parse::<AgentId>()
            .map_err(|_| mcp_error(format!("unsupported agent id: {}", input.agent_id)))?;
        if !self.context.runtime.agent_available(agent_id) {
            return Err(mcp_error(format!("agent is not available: {agent_id:?}")));
        }
        let workspace_mode = parse_workspace_mode(&input.workspace_mode)?;
        let member = coordinator(&self.context)
            .spawn_teammate(SpawnTeammate {
                team_id: &self.context.member.team_id,
                caller_member_id: &self.context.member.id,
                agent_id,
                name: &input.name,
                workspace_mode,
            })
            .map_err(mcp_error)?;
        self.context
            .runtime
            .initialize_conversation(&member.conversation_id)
            .await
            .map_err(mcp_error)?;
        json_output(&member)
    }

    #[tool(
        description = "Leader only: create a task with dependencies and optional path ownership."
    )]
    async fn team_create_task(
        &self,
        Parameters(input): Parameters<CreateTaskInput>,
    ) -> Result<CallToolResult, McpError> {
        let task = self
            .context
            .teams
            .create_task(NewTeamTask {
                team_id: &self.context.member.team_id,
                creator_member_id: &self.context.member.id,
                title: &input.title,
                description: &input.description,
                dependencies: &input.dependencies,
                owned_paths: &input.owned_paths,
                requires_plan_approval: input.requires_plan_approval,
                mutates_files: input.mutates_files,
            })
            .map_err(mcp_error)?;
        json_output(&task)
    }

    #[tool(description = "List the current Team task board.")]
    async fn team_list_tasks(&self) -> Result<CallToolResult, McpError> {
        let tasks = self
            .context
            .teams
            .list_tasks(&self.context.member.team_id)
            .map_err(mcp_error)?;
        json_output(&tasks)
    }

    #[tool(description = "Claim an available, unblocked Team task for the current member.")]
    async fn team_claim_task(
        &self,
        Parameters(input): Parameters<TaskInput>,
    ) -> Result<CallToolResult, McpError> {
        let task = self
            .context
            .teams
            .claim_task(&input.task_id, &self.context.member.id)
            .map_err(mcp_error)?;
        json_output(&task)
    }

    #[tool(
        description = "Submit a completed task result and verification to wake the Leader for review."
    )]
    async fn team_submit_result(
        &self,
        Parameters(input): Parameters<SubmitResultInput>,
    ) -> Result<CallToolResult, McpError> {
        coordinator(&self.context)
            .submit_result(
                &input.task_id,
                &self.context.member.id,
                &input.result,
                input.verification.as_deref(),
            )
            .map_err(mcp_error)?;
        self.context
            .runtime
            .wake_team_leader(&self.context.member.team_id)
            .map_err(mcp_error)?;
        json_output(&serde_json::json!({"submitted": true}))
    }

    #[tool(description = "Leader only: accept a teammate result or request changes.")]
    async fn team_review_result(
        &self,
        Parameters(input): Parameters<ReviewResultInput>,
    ) -> Result<CallToolResult, McpError> {
        let task = coordinator(&self.context)
            .review_result(
                &input.task_id,
                &self.context.member.id,
                input.accepted,
                input.feedback.as_deref(),
            )
            .map_err(mcp_error)?;
        json_output(&task)
    }

    #[tool(description = "Send a persistent direct message to another Team member.")]
    async fn team_send_message(
        &self,
        Parameters(input): Parameters<SendMessageInput>,
    ) -> Result<CallToolResult, McpError> {
        let message = self
            .context
            .teams
            .send_message(
                &self.context.member.team_id,
                &self.context.member.id,
                &input.to_member_id,
                TeamMessageKind::Direct,
                input.task_id.as_deref(),
                &input.body,
            )
            .map_err(mcp_error)?;
        json_output(&message)
    }

    #[tool(
        description = "Read and acknowledge unread Team mailbox messages for the current member."
    )]
    async fn team_read_inbox(&self) -> Result<CallToolResult, McpError> {
        let messages = self
            .context
            .teams
            .unread_messages(&self.context.member.id)
            .map_err(mcp_error)?;
        self.context
            .teams
            .mark_messages_read(&self.context.member.id)
            .map_err(mcp_error)?;
        json_output(&messages)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for TeamMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                TEAM_MCP_NAME,
                env!("CARGO_PKG_VERSION"),
            ))
            .with_protocol_version(ProtocolVersion::V_2025_03_26)
            .with_instructions(TEAM_MCP_INSTRUCTIONS)
    }
}

pub fn build_team_mcp(
    runtime: AgentRuntime,
    conversation_id: &str,
) -> Result<Option<McpServer<Agent, impl RunWithConnectionTo<Agent> + 'static>>, RuntimeError> {
    let Some(context) = tool_context(runtime, conversation_id)? else {
        return Ok(None);
    };
    Ok(Some(McpServer::<Agent>::from_rmcp(
        TEAM_MCP_NAME,
        move || TeamMcpServer::new(context.clone()),
    )))
}

pub async fn handle_http(
    State(state): State<AppState>,
    Path((token, conversation_id)): Path<(String, String)>,
    request: Request<Body>,
) -> Response {
    if !state.agent_runtime.authorize_team_mcp(&token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let context = match tool_context(state.agent_runtime.as_ref().clone(), &conversation_id) {
        Ok(Some(context)) => context,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
        }
    };
    let service: StreamableHttpService<TeamMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(TeamMcpServer::new(context.clone())),
            Arc::clone(HTTP_SESSIONS.get_or_init(Default::default)),
            StreamableHttpServerConfig::default()
                .with_json_response(true)
                .with_sse_keep_alive(None),
        );
    match service.oneshot(request).await {
        Ok(response) => response.into_response(),
        Err(error) => match error {},
    }
}

fn tool_context(
    runtime: AgentRuntime,
    conversation_id: &str,
) -> Result<Option<ToolContext>, RuntimeError> {
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
    Ok(Some(ToolContext {
        runtime,
        teams,
        member,
    }))
}

fn coordinator(context: &ToolContext) -> TeamCoordinator {
    TeamCoordinator::new(
        context.runtime.workspace_service(),
        context.runtime.store(),
        Arc::clone(&context.teams),
    )
}

fn parse_workspace_mode(value: &str) -> Result<MemberWorkspaceMode, McpError> {
    match value {
        "shared" => Ok(MemberWorkspaceMode::Shared),
        "isolated" => Ok(MemberWorkspaceMode::Isolated),
        _ => Err(mcp_error(format!("unsupported workspace mode: {value}"))),
    }
}

fn shared_workspace() -> String {
    "shared".into()
}

fn json_output(value: &impl Serialize) -> Result<CallToolResult, McpError> {
    serde_json::to_string(value)
        .map(|json| CallToolResult::success(vec![Content::text(json)]))
        .map_err(mcp_error)
}

fn mcp_error(error: impl std::fmt::Display) -> McpError {
    McpError::internal_error(error.to_string(), None)
}

fn team_runtime_error(error: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Acp(error.to_string())
}
