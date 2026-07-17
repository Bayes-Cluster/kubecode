use std::collections::BTreeMap;
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

use crate::agent_runtime::{AgentRuntime, RuntimeError, SessionConfigInput};
use crate::agents::AgentId;
use crate::api::AppState;
use crate::team_coordinator::{SpawnTeammate, TeamCoordinator};
use crate::teams::{
    MemberWorkspaceMode, NewTeamProposal, NewTeamTask, TeamMember, TeamMemberStatus,
    TeamMessageKind, TeamRole, TeamStore,
};

const TEAM_MCP_NAME: &str = "kubecode-team";
const TEAM_MCP_INSTRUCTIONS: &str = "You are a member of a persistent Kubecode Team. Begin coordination decisions with team_get_context. The Leader has final authority and can discover installed backends, propose a flexible lineup, create/configure/remove teammates, create or delegate tasks, review results, and review teammate permission requests. Teammates claim or receive tasks, report progress/blockers, submit results, and may message any member directly. team_send_message and task delegation wake idle recipients automatically; never assume another member saw prose in your own chat. When pending_permissions is non-empty, the Leader must use team_review_permission to choose an exact Agent-provided option or escalate to the user. Use agent-native ACP mode/session_options exactly as advertised by that Agent and never invent model IDs.";
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
        let mut tool_router = Self::tool_router();
        let disabled: &[&str] = if context.member.role == TeamRole::Leader {
            &[
                "team_claim_task",
                "team_report_status",
                "team_submit_result",
                "team_read_inbox",
            ]
        } else {
            &[
                "team_list_available_agents",
                "team_propose_lineup",
                "team_spawn_teammate",
                "team_configure_teammate",
                "team_remove_teammate",
                "team_list_members",
                "team_create_task",
                "team_delegate_task",
                "team_review_result",
                "team_review_permission",
                "team_read_inbox",
            ]
        };
        for name in disabled {
            tool_router.disable_route((*name).to_owned());
        }
        Self {
            context,
            tool_router,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SpawnInput {
    agent_id: String,
    name: String,
    #[serde(default = "shared_workspace")]
    workspace_mode: String,
    /// Optional native ACP session mode ID for this teammate.
    mode: Option<String>,
    /// Agent-native ACP config option IDs and values, such as {"model":"zhipu/glm-5.2"}.
    #[serde(default)]
    session_options: BTreeMap<String, SpawnConfigValue>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(untagged)]
enum SpawnConfigValue {
    Boolean(bool),
    ValueId(String),
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RemoveTeammateInput {
    teammate_id: String,
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

#[derive(Debug, Deserialize, JsonSchema)]
struct ConfigureTeammateInput {
    teammate_id: String,
    mode: Option<String>,
    #[serde(default)]
    session_options: BTreeMap<String, SpawnConfigValue>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DelegateTaskInput {
    task_id: String,
    teammate_id: String,
}

#[derive(Debug, Deserialize, JsonSchema, Serialize)]
struct ProposalMemberInput {
    name: String,
    purpose: String,
    agent_id: String,
    #[serde(default = "shared_workspace")]
    workspace_mode: String,
    mode: Option<String>,
    #[serde(default)]
    session_options: BTreeMap<String, SpawnConfigValue>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ProposeLineupInput {
    summary: String,
    members: Vec<ProposalMemberInput>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReportStatusInput {
    task_id: Option<String>,
    status: String,
    summary: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReviewPermissionInput {
    request_id: String,
    /// Either "resolve" to select an Agent-provided option or "escalate" for user review.
    decision: String,
    option_id: Option<String>,
    reason: Option<String>,
}

#[tool_router]
impl TeamMcpServer {
    #[tool(
        description = "Return the current caller role, Team settings, roster, task board, unread messages, latest lineup proposal, and recent structured activity. Use this before deciding the next Team action."
    )]
    async fn team_get_context(&self) -> Result<CallToolResult, McpError> {
        let team = self
            .context
            .teams
            .get_team(&self.context.member.team_id)
            .map_err(mcp_error)?;
        let unread_messages = self
            .context
            .teams
            .read_messages(&self.context.member.id)
            .map_err(mcp_error)?;
        json_output(&serde_json::json!({
            "role": self.context.member.role,
            "member": self.context.member,
            "team": team,
            "members": self.context.teams.list_members(&team.id).map_err(mcp_error)?,
            "tasks": self.context.teams.list_tasks(&team.id).map_err(mcp_error)?,
            "unread_messages": unread_messages,
            "proposal": self.context.teams.latest_proposal(&team.id).map_err(mcp_error)?,
            "activity": self.context.teams.list_activity(&team.id, 40).map_err(mcp_error)?,
            "pending_permissions": self.context.teams.pending_permission_requests(&team.id)
                .map_err(mcp_error)?,
        }))
    }

    #[tool(
        description = "Leader only: list the locally installed Codex, Claude Code, and OpenCode backends. Model, mode, effort, and other selectors remain agent-native ACP config options and are learned after that member Session initializes."
    )]
    async fn team_list_available_agents(&self) -> Result<CallToolResult, McpError> {
        self.require_leader()?;
        let members = self
            .context
            .teams
            .list_members(&self.context.member.team_id)
            .map_err(mcp_error)?;
        let mut capabilities = Vec::new();
        for agent in self.context.runtime.available_agents() {
            let cached = members.iter().find_map(|member| {
                let conversation = self
                    .context
                    .runtime
                    .store()
                    .get_conversation(&member.conversation_id)
                    .ok()?;
                if conversation.agent_id != agent.id {
                    return None;
                }
                let events = self
                    .context
                    .runtime
                    .store()
                    .session_events_after(&conversation.id, 0)
                    .ok()?;
                let config_options = events
                    .iter()
                    .rev()
                    .find(|event| event.kind == "config_options")
                    .map(|event| event.payload.clone());
                let current_mode = events
                    .iter()
                    .rev()
                    .find(|event| event.kind == "current_mode")
                    .map(|event| event.payload.clone());
                Some((config_options, current_mode))
            });
            let (config_options, current_mode, source) = match cached {
                Some((config_options, current_mode)) => {
                    (config_options, current_mode, "cached_team_session")
                }
                None => (None, None, "initialize_on_spawn"),
            };
            capabilities.push(serde_json::json!({
                "agent": agent,
                "config_options": config_options,
                "current_mode": current_mode,
                "source": source,
            }));
        }
        json_output(&capabilities)
    }

    #[tool(
        description = "Leader only: propose a flexible Team lineup for user approval. Members are not fixed templates; describe the purpose and desired agent-native configuration for each proposed teammate."
    )]
    async fn team_propose_lineup(
        &self,
        Parameters(input): Parameters<ProposeLineupInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_leader()?;
        let members_json = serde_json::to_string(&input.members).map_err(mcp_error)?;
        let proposal = self
            .context
            .teams
            .create_proposal(NewTeamProposal {
                team_id: &self.context.member.team_id,
                summary: &input.summary,
                members_json: &members_json,
            })
            .map_err(mcp_error)?;
        self.context
            .teams
            .append_activity(
                &self.context.member.team_id,
                Some(&self.context.member.id),
                None,
                "proposal_created",
                "Leader proposed a Team lineup",
                None,
            )
            .map_err(mcp_error)?;
        json_output(&proposal)
    }

    #[tool(
        description = "Leader only: create a teammate backed by Codex, Claude Code, or OpenCode. Use mode and session_options to apply the agent's native ACP settings after startup; for example session_options {\"model\":\"zhipu/glm-5.2\"}. Config IDs and values are agent-specific."
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
        if let Err(error) = self
            .context
            .runtime
            .initialize_conversation(&member.conversation_id)
            .await
        {
            let _ = self
                .context
                .runtime
                .disconnect_conversation(&member.conversation_id)
                .await;
            let _ = coordinator(&self.context).remove_teammate(
                &self.context.member.team_id,
                &self.context.member.id,
                &member.id,
            );
            return Err(mcp_error(error));
        }
        if let Err(error) = self
            .apply_teammate_configuration(&member, input.mode, input.session_options)
            .await
        {
            let _ = self
                .context
                .teams
                .set_member_status(&member.id, TeamMemberStatus::Configuring);
            let _ = self.context.teams.append_activity(
                &member.team_id,
                Some(&member.id),
                None,
                "configuration_required",
                &format!("{} needs valid Agent-native configuration", member.name),
                None,
            );
            publish_team_event(
                &self.context,
                "team_member_updated",
                Some(&member.conversation_id),
            );
            return json_output(&serde_json::json!({
                "member": member,
                "configuration_required": true,
                "error": error.to_string(),
            }));
        }
        let _ = self
            .context
            .teams
            .set_member_status(&member.id, TeamMemberStatus::Idle);
        let _ = self.context.teams.append_activity(
            &self.context.member.team_id,
            Some(&member.id),
            None,
            "member_added",
            &format!("Added teammate {}", member.name),
            None,
        );
        publish_team_event(
            &self.context,
            "team_member_updated",
            Some(&member.conversation_id),
        );
        json_output(&member)
    }

    #[tool(
        description = "Leader only: change an existing teammate's native ACP mode and configuration. Changes are applied immediately when the member is idle; active members accept them at the next safe ACP control boundary."
    )]
    async fn team_configure_teammate(
        &self,
        Parameters(input): Parameters<ConfigureTeammateInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_leader()?;
        let member = self
            .context
            .teams
            .get_member(&input.teammate_id)
            .map_err(mcp_error)?;
        if member.team_id != self.context.member.team_id {
            return Err(mcp_error("team member does not belong to this team"));
        }
        self.context
            .runtime
            .initialize_conversation(&member.conversation_id)
            .await
            .map_err(mcp_error)?;
        if let Err(error) = self
            .apply_teammate_configuration(&member, input.mode, input.session_options)
            .await
        {
            let _ = self
                .context
                .teams
                .set_member_status(&member.id, TeamMemberStatus::Configuring);
            return Err(mcp_error(error));
        }
        let _ = self
            .context
            .teams
            .set_member_status(&member.id, TeamMemberStatus::Idle);
        let _ = self.context.teams.append_activity(
            &member.team_id,
            Some(&member.id),
            None,
            "member_configured",
            &format!("Updated configuration for {}", member.name),
            None,
        );
        json_output(&member)
    }

    #[tool(
        description = "Leader only: stop a teammate, delete its Agent-native and Kubecode Session, remove it from this Team, and release assigned work back to pending. This does not delete project files or disband the Team."
    )]
    async fn team_remove_teammate(
        &self,
        Parameters(input): Parameters<RemoveTeammateInput>,
    ) -> Result<CallToolResult, McpError> {
        let team_id = &self.context.member.team_id;
        let caller_id = &self.context.member.id;
        let teammate = coordinator(&self.context)
            .removable_teammate(team_id, caller_id, &input.teammate_id)
            .map_err(mcp_error)?;
        self.context
            .runtime
            .disconnect_conversation(&teammate.conversation_id)
            .await
            .map_err(mcp_error)?;
        self.context
            .runtime
            .delete_session(&teammate.conversation_id)
            .await
            .map_err(mcp_error)?;
        self.context
            .teams
            .remove_teammate(team_id, caller_id, &teammate.id)
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_member_updated", None);
        json_output(&serde_json::json!({
            "removed": true,
            "teammate_id": teammate.id,
            "name": teammate.name,
        }))
    }

    #[tool(
        description = "List every current Team member with its member ID, name, role, status, Session, and workspace mode. Call this before team_remove_teammate when the teammate ID is not known."
    )]
    async fn team_list_members(&self) -> Result<CallToolResult, McpError> {
        let members = self
            .context
            .teams
            .list_members(&self.context.member.team_id)
            .map_err(mcp_error)?;
        json_output(&members)
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
        publish_team_event(&self.context, "team_task_updated", None);
        json_output(&task)
    }

    #[tool(
        description = "Leader only: atomically assign an available task to a specific teammate, enqueue the assignment in that member's durable mailbox, and wake the teammate when a concurrency slot is available."
    )]
    async fn team_delegate_task(
        &self,
        Parameters(input): Parameters<DelegateTaskInput>,
    ) -> Result<CallToolResult, McpError> {
        let task = self
            .context
            .teams
            .delegate_task(&input.task_id, &self.context.member.id, &input.teammate_id)
            .map_err(mcp_error)?;
        let _ = self.context.teams.append_activity(
            &task.team_id,
            Some(&input.teammate_id),
            Some(&task.id),
            "task_delegated",
            &format!("Delegated task {}", task.title),
            None,
        );
        self.context
            .runtime
            .wake_team_member(&task.team_id, &input.teammate_id)
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_task_updated", None);
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
        publish_team_event(&self.context, "team_task_updated", None);
        json_output(&task)
    }

    #[tool(
        description = "Report progress, a blocker, or a request for input to the Team Leader. This creates structured Team activity and wakes the Leader."
    )]
    async fn team_report_status(
        &self,
        Parameters(input): Parameters<ReportStatusInput>,
    ) -> Result<CallToolResult, McpError> {
        let team = self
            .context
            .teams
            .get_team(&self.context.member.team_id)
            .map_err(mcp_error)?;
        let member_status = match input.status.as_str() {
            "blocked" | "needs_input" => TeamMemberStatus::WaitingInput,
            "failed" => TeamMemberStatus::Failed,
            "working" | "in_progress" => TeamMemberStatus::Working,
            "idle" => TeamMemberStatus::Idle,
            value => return Err(mcp_error(format!("unsupported report status: {value}"))),
        };
        self.context
            .teams
            .set_member_status(&self.context.member.id, member_status)
            .map_err(mcp_error)?;
        self.context
            .teams
            .append_activity(
                &team.id,
                Some(&self.context.member.id),
                input.task_id.as_deref(),
                &format!("status_{}", input.status),
                &input.summary,
                None,
            )
            .map_err(mcp_error)?;
        self.context
            .teams
            .send_message(
                &team.id,
                &self.context.member.id,
                &team.leader_member_id,
                TeamMessageKind::System,
                input.task_id.as_deref(),
                &input.summary,
            )
            .map_err(mcp_error)?;
        self.context
            .runtime
            .wake_team_leader(&team.id)
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_attention_updated", None);
        json_output(&serde_json::json!({"reported": true}))
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
        publish_team_event(&self.context, "team_task_updated", None);
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
        if !input.accepted
            && let Some(member_id) = task.assignee_member_id.as_deref()
        {
            self.context
                .runtime
                .wake_team_member(&task.team_id, member_id)
                .map_err(mcp_error)?;
        }
        publish_team_event(&self.context, "team_task_updated", None);
        json_output(&task)
    }

    #[tool(
        description = "Leader only: review a pending teammate permission. Use decision='resolve' with an exact option_id advertised in pending_permissions, or decision='escalate' with a reason to ask the user."
    )]
    async fn team_review_permission(
        &self,
        Parameters(input): Parameters<ReviewPermissionInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_leader()?;
        let request = self
            .context
            .teams
            .get_permission_request(&input.request_id)
            .map_err(mcp_error)?;
        if request.team_id != self.context.member.team_id {
            return Err(mcp_error("permission request does not belong to this team"));
        }
        let updated = match input.decision.as_str() {
            "resolve" => {
                let option_id = input
                    .option_id
                    .as_deref()
                    .ok_or_else(|| mcp_error("option_id is required when resolving permission"))?;
                let updated = self
                    .context
                    .teams
                    .resolve_permission_as_leader(
                        &input.request_id,
                        &self.context.member.id,
                        option_id,
                        input.reason.as_deref(),
                    )
                    .map_err(mcp_error)?;
                if !self
                    .context
                    .runtime
                    .resolve_permission(&input.request_id, option_id)
                {
                    return Err(mcp_error("permission request is no longer active"));
                }
                updated
            }
            "escalate" => {
                let updated = self
                    .context
                    .teams
                    .escalate_permission(
                        &input.request_id,
                        &self.context.member.id,
                        input.reason.as_deref(),
                    )
                    .map_err(mcp_error)?;
                self.context
                    .runtime
                    .escalate_team_permission(&input.request_id)
                    .map_err(mcp_error)?;
                updated
            }
            value => {
                return Err(mcp_error(format!(
                    "unsupported permission decision: {value}"
                )));
            }
        };
        let _ = self.context.teams.append_activity(
            &updated.team_id,
            Some(&updated.member_id),
            None,
            if input.decision == "resolve" {
                "permission_reviewed"
            } else {
                "permission_escalated"
            },
            if input.decision == "resolve" {
                "Leader reviewed a teammate permission"
            } else {
                "Leader escalated a teammate permission to the user"
            },
            None,
        );
        publish_team_event(
            &self.context,
            "team_permission_updated",
            Some(&updated.conversation_id),
        );
        json_output(&updated)
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
        self.context
            .runtime
            .wake_team_member(&self.context.member.team_id, &input.to_member_id)
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_message_updated", None);
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

impl TeamMcpServer {
    fn require_leader(&self) -> Result<(), McpError> {
        if self.context.member.role == TeamRole::Leader {
            Ok(())
        } else {
            Err(mcp_error("only the Team Leader may perform this action"))
        }
    }

    async fn apply_teammate_configuration(
        &self,
        member: &TeamMember,
        mode: Option<String>,
        session_options: BTreeMap<String, SpawnConfigValue>,
    ) -> Result<(), RuntimeError> {
        if let Some(mode) = mode {
            self.context
                .runtime
                .set_session_mode(&member.conversation_id, mode)
                .await?;
        }
        for (config_id, value) in session_options {
            self.context
                .runtime
                .set_session_config(&member.conversation_id, config_id, value.into())
                .await?;
        }
        Ok(())
    }
}

impl From<SpawnConfigValue> for SessionConfigInput {
    fn from(value: SpawnConfigValue) -> Self {
        match value {
            SpawnConfigValue::Boolean(value) => Self::Boolean(value),
            SpawnConfigValue::ValueId(value) => Self::ValueId(value),
        }
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

fn publish_team_event(context: &ToolContext, kind: &str, conversation_id: Option<&str>) {
    let Ok(team) = context.teams.get_team(&context.member.team_id) else {
        return;
    };
    let _ = context.runtime.store().append_workspace_event(
        kind,
        Some(&team.project_id),
        conversation_id,
        None,
        &serde_json::json!({"team_id": team.id}),
    );
}
