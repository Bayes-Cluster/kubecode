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
use crate::team_coordinator::{SpawnDiscriminator, SpawnTeammate, TeamCoordinator};
use crate::teams::{
    MemberWorkspaceMode, NewTeamProposal, NewTeamTask, TeamMember, TeamMemberStatus,
    TeamMessageKind, TeamMode, TeamRole, TeamStore,
};

const TEAM_MCP_NAME: &str = "kubecode-team";
const TEAM_MCP_INSTRUCTIONS: &str = "You are a member of a persistent Kubecode Team. Begin with team_get_context. The Leader plans, creates concrete tasks, configures teammates within the user's Agent and concurrency budget, reviews permissions/plans/results, integrates or edits accepted work when needed, synthesizes the final answer, and calls team_complete. The Leader is never a concrete task assignee. If a semantic decision genuinely requires the user, the Leader calls team_request_user_input; Kubecode pauses scheduling until the answer returns through the durable mailbox. Teammates claim or receive concrete tasks and must submit plans/results through Team tools. A YOLO Discriminator is an independent read-only evaluator: it never implements fixes and only submits a verdict. Every member owns an independent durable ACP transcript. Native provider subagents remain inside their owning Session. In YOLO, Kubecode owns the provider-native permission mode; do not pass mode or a mode session_option when spawning or configuring members. Model, effort, fast mode, and other non-permission session_options remain configurable. Use Agent-native option IDs exactly as advertised and never invent model IDs.";
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
        let disabled: &[&str] = match context.member.role {
            TeamRole::Leader => &[
                "team_claim_task",
                "team_report_status",
                "team_submit_plan",
                "team_submit_result",
                "team_submit_verdict",
                "team_read_inbox",
                "team_propose_lineup",
            ],
            TeamRole::Teammate => &[
                "team_list_available_agents",
                "team_propose_lineup",
                "team_spawn_teammate",
                "team_configure_teammate",
                "team_remove_teammate",
                "team_list_members",
                "team_create_task",
                "team_delegate_task",
                "team_retry_task",
                "team_cancel_task",
                "team_review_plan",
                "team_review_result",
                "team_review_permission",
                "team_request_user_input",
                "team_request_discrimination",
                "team_complete",
                "team_submit_verdict",
                "team_read_inbox",
            ],
            TeamRole::Discriminator => &[
                "team_list_available_agents",
                "team_propose_lineup",
                "team_spawn_teammate",
                "team_configure_teammate",
                "team_remove_teammate",
                "team_list_members",
                "team_create_task",
                "team_delegate_task",
                "team_retry_task",
                "team_cancel_task",
                "team_list_tasks",
                "team_claim_task",
                "team_report_status",
                "team_submit_plan",
                "team_review_plan",
                "team_submit_result",
                "team_review_result",
                "team_review_permission",
                "team_request_user_input",
                "team_request_discrimination",
                "team_complete",
                "team_send_message",
                "team_read_inbox",
            ],
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
struct CancelTaskInput {
    task_id: String,
    reason: Option<String>,
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
struct SubmitPlanInput {
    task_id: String,
    plan: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReviewPlanInput {
    task_id: String,
    accepted: bool,
    feedback: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SubmitVerdictInput {
    round_id: String,
    passed: bool,
    verdict: String,
    evidence: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CompleteTeamInput {
    final_summary: String,
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

#[derive(Debug, Deserialize, JsonSchema)]
struct RequestUserInput {
    title: String,
    prompt: String,
}

#[tool_router]
impl TeamMcpServer {
    #[tool(
        description = "Return the durable caller role, Team goal and policy, roster, task board, unread messages, permissions, verification rounds, and recent activity. Reading context acknowledges the caller mailbox."
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
            "task_attempts": self.context.teams.list_task_attempts(&team.id).map_err(mcp_error)?,
            "unread_messages": unread_messages,
            "activity": self.context.teams.list_activity(&team.id, 40).map_err(mcp_error)?,
            "discrimination_rounds": self.context.teams.list_discrimination_rounds(&team.id)
                .map_err(mcp_error)?,
            "pending_permissions": self.context.teams.pending_permission_requests(&team.id)
                .map_err(mcp_error)?,
            "pending_user_input": self.context.teams.pending_user_input_requests(&team.id)
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
        self.require_mutable_team()?;
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
        self.require_mutable_team()?;
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
        let provisioning = self
            .context
            .teams
            .create_lifecycle_operation(
                &member.team_id,
                &self
                    .context
                    .teams
                    .get_team(&member.team_id)
                    .map_err(mcp_error)?
                    .project_id,
                crate::teams::TeamLifecycleOperationKind::Provisioning,
                Some(&member.id),
                Some(&member.conversation_id),
                &serde_json::json!({"agent_id": input.agent_id}).to_string(),
            )
            .map_err(mcp_error)?;
        self.context
            .teams
            .mark_lifecycle_operation_running(&provisioning.id)
            .map_err(mcp_error)?;
        if let Err(error) = self
            .context
            .runtime
            .initialize_conversation(&member.conversation_id)
            .await
        {
            if error.is_native_permission_unavailable() {
                self.fallback_yolo_team(agent_id, &error.to_string())
                    .await?;
                self.context
                    .runtime
                    .initialize_conversation(&member.conversation_id)
                    .await
                    .map_err(mcp_error)?;
                self.apply_teammate_configuration(&member, input.mode, input.session_options)
                    .await
                    .map_err(mcp_error)?;
                let member = self
                    .context
                    .teams
                    .set_member_status(&member.id, TeamMemberStatus::Idle)
                    .map_err(mcp_error)?;
                self.context
                    .teams
                    .mark_lifecycle_operation_completed(&provisioning.id)
                    .map_err(mcp_error)?;
                publish_team_event(
                    &self.context,
                    "team_mode_fallback",
                    Some(&member.conversation_id),
                );
                return json_output(&member);
            }
            let _ = self
                .context
                .runtime
                .disconnect_conversation(&member.conversation_id)
                .await;
            let _ = self
                .context
                .teams
                .mark_lifecycle_operation_terminal_failure(&provisioning.id, &error.to_string());
            let _ = self
                .context
                .runtime
                .remove_team_member_local_first(
                    &self.context.member.team_id,
                    &self.context.member.id,
                    &member.id,
                )
                .await;
            let _ = self.context.teams.append_activity(
                &member.team_id,
                None,
                None,
                "member_provision_failed",
                &format!("Could not start teammate {}", member.name),
                Some(&provisioning.id),
            );
            publish_team_event(&self.context, "team_member_provision_failed", None);
            return Err(mcp_error(error));
        }
        let team = self
            .context
            .teams
            .get_team(&member.team_id)
            .map_err(mcp_error)?;
        if team.mode == TeamMode::Yolo {
            self.context
                .teams
                .mark_permission_profile_applied(&member.id, None)
                .map_err(mcp_error)?;
        }
        if let Err(error) = self
            .apply_teammate_configuration(&member, input.mode, input.session_options)
            .await
        {
            let _ = self
                .context
                .teams
                .mark_lifecycle_operation_terminal_failure(&provisioning.id, &error.to_string());
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
        self.context
            .teams
            .mark_lifecycle_operation_completed(&provisioning.id)
            .map_err(mcp_error)?;
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
        self.require_mutable_team()?;
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
        if let Some(operation) = self
            .context
            .teams
            .list_lifecycle_operations(&member.team_id)
            .map_err(mcp_error)?
            .into_iter()
            .rev()
            .find(|operation| {
                operation.kind == crate::teams::TeamLifecycleOperationKind::Provisioning
                    && operation.member_id.as_deref() == Some(member.id.as_str())
                    && operation.status == crate::teams::TeamLifecycleOperationStatus::Failed
            })
        {
            self.context
                .teams
                .mark_lifecycle_operation_completed(&operation.id)
                .map_err(mcp_error)?;
        }
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
        description = "Leader only: immediately remove a teammate from this Team and release assigned work. Provider-native Session cleanup runs in the background when the provider is unavailable. Project files are never deleted."
    )]
    async fn team_remove_teammate(
        &self,
        Parameters(input): Parameters<RemoveTeammateInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_mutable_team()?;
        let team_id = &self.context.member.team_id;
        let caller_id = &self.context.member.id;
        let teammate = coordinator(&self.context)
            .removable_teammate(team_id, caller_id, &input.teammate_id)
            .map_err(mcp_error)?;
        let removal = self
            .context
            .runtime
            .remove_team_member_local_first(team_id, caller_id, &teammate.id)
            .await
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_member_updated", None);
        json_output(&serde_json::json!({
            "removed": true,
            "teammate_id": teammate.id,
            "name": teammate.name,
            "cleanup": removal.cleanup_operation,
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
        self.require_mutable_team()?;
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
        self.require_mutable_team()?;
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

    #[tool(
        description = "Leader only: reopen a failed task after inspecting its structured attempt failure, so it can be assigned again or claimed by another teammate."
    )]
    async fn team_retry_task(
        &self,
        Parameters(input): Parameters<TaskInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_mutable_team()?;
        let task = self
            .context
            .teams
            .retry_task(&input.task_id, &self.context.member.id)
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_task_updated", None);
        json_output(&task)
    }

    #[tool(
        description = "Leader only: cancel concrete work that is no longer required. This closes any active attempt and never assigns implementation work to the Leader."
    )]
    async fn team_cancel_task(
        &self,
        Parameters(input): Parameters<CancelTaskInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_mutable_team()?;
        let task = self
            .context
            .teams
            .cancel_task(
                &input.task_id,
                &self.context.member.id,
                input.reason.as_deref(),
            )
            .map_err(mcp_error)?;
        self.context
            .teams
            .append_activity(
                &task.team_id,
                Some(&self.context.member.id),
                Some(&task.id),
                "task_cancelled",
                &task.title,
                None,
            )
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
        self.require_mutable_team()?;
        let task = self
            .context
            .teams
            .claim_task(&input.task_id, &self.context.member.id)
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_task_updated", None);
        json_output(&task)
    }

    #[tool(
        description = "Teammate only: submit the implementation or research plan for a task that requires Leader plan approval."
    )]
    async fn team_submit_plan(
        &self,
        Parameters(input): Parameters<SubmitPlanInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_mutable_team()?;
        let task = self
            .context
            .teams
            .submit_plan(&input.task_id, &self.context.member.id, &input.plan)
            .map_err(mcp_error)?;
        let team = self
            .context
            .teams
            .get_team(&task.team_id)
            .map_err(mcp_error)?;
        self.context
            .teams
            .send_message(
                &team.id,
                &self.context.member.id,
                &team.leader_member_id,
                TeamMessageKind::PlanReady,
                Some(&task.id),
                &input.plan,
            )
            .map_err(mcp_error)?;
        self.context
            .runtime
            .wake_team_leader(&team.id)
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
        self.require_mutable_team()?;
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
        description = "Leader only: pause Team scheduling and ask the user for a semantic decision that the Leader cannot safely make. The answer is delivered back to the Leader's durable mailbox."
    )]
    async fn team_request_user_input(
        &self,
        Parameters(input): Parameters<RequestUserInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_leader()?;
        self.require_mutable_team()?;
        let request = self
            .context
            .teams
            .request_user_input(
                &self.context.member.team_id,
                &self.context.member.id,
                &input.title,
                &input.prompt,
            )
            .map_err(mcp_error)?;
        self.context
            .teams
            .append_activity(
                &self.context.member.team_id,
                Some(&self.context.member.id),
                None,
                "user_input_requested",
                &input.title,
                Some(&request.id),
            )
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_user_input_requested", None);
        json_output(&request)
    }

    #[tool(
        description = "Submit a completed task result and verification to wake the Leader for review."
    )]
    async fn team_submit_result(
        &self,
        Parameters(input): Parameters<SubmitResultInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_mutable_team()?;
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

    #[tool(description = "Leader only: approve a teammate plan or request a revised plan.")]
    async fn team_review_plan(
        &self,
        Parameters(input): Parameters<ReviewPlanInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_mutable_team()?;
        let task = self
            .context
            .teams
            .review_plan(
                &input.task_id,
                &self.context.member.id,
                input.accepted,
                input.feedback.as_deref(),
            )
            .map_err(mcp_error)?;
        if let Some(member_id) = task.assignee_member_id.as_deref() {
            let body = if input.accepted {
                "The Leader approved your plan. Continue the task."
            } else {
                input.feedback.as_deref().unwrap_or("Revise the plan.")
            };
            self.context
                .teams
                .send_message(
                    &task.team_id,
                    &self.context.member.id,
                    member_id,
                    TeamMessageKind::System,
                    Some(&task.id),
                    body,
                )
                .map_err(mcp_error)?;
            self.context
                .runtime
                .wake_team_member(&task.team_id, member_id)
                .map_err(mcp_error)?;
        }
        publish_team_event(&self.context, "team_task_updated", None);
        json_output(&task)
    }

    #[tool(description = "Leader only: accept a teammate result or request changes.")]
    async fn team_review_result(
        &self,
        Parameters(input): Parameters<ReviewResultInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_mutable_team()?;
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
        description = "Leader only, YOLO Teams: start a fresh independent read-only discrimination round after all required tasks are accepted. Kubecode selects the verifier backend and records the workspace fingerprint."
    )]
    async fn team_request_discrimination(&self) -> Result<CallToolResult, McpError> {
        self.require_leader()?;
        self.require_mutable_team()?;
        let team = self
            .context
            .teams
            .get_team(&self.context.member.team_id)
            .map_err(mcp_error)?;
        if team.mode != TeamMode::Yolo {
            return Err(mcp_error(
                "independent discrimination is only available in Team YOLO",
            ));
        }
        self.context
            .teams
            .validate_discrimination_request(&team.id, &self.context.member.id)
            .map_err(mcp_error)?;
        let fingerprint = coordinator(&self.context)
            .capture_team_fingerprint(&team)
            .map_err(mcp_error)?;
        let agent_id = self.select_discriminator_agent(&team)?;
        let member = coordinator(&self.context)
            .spawn_discriminator(SpawnDiscriminator {
                team_id: &team.id,
                caller_member_id: &self.context.member.id,
                agent_id,
                name: &format!("Verifier {}", team.current_review_round + 1),
            })
            .map_err(mcp_error)?;
        if let Err(error) = self
            .context
            .runtime
            .initialize_conversation(&member.conversation_id)
            .await
        {
            return Err(mcp_error(error));
        }
        let round = self
            .context
            .teams
            .request_discrimination(&team.id, &self.context.member.id, &member.id, &fingerprint)
            .map_err(mcp_error)?;
        let review_message = format!(
            "Independently evaluate Team goal '{}' against these acceptance criteria: {}. Inspect the current workspace and submitted task evidence without modifying anything. Submit exactly one verdict with team_submit_verdict for round {}.",
            team.goal,
            team.acceptance_criteria.join("; "),
            round.id,
        );
        self.context
            .teams
            .send_message(
                &team.id,
                &self.context.member.id,
                &member.id,
                TeamMessageKind::System,
                None,
                &review_message,
            )
            .map_err(mcp_error)?;
        self.context
            .runtime
            .wake_team_member(&team.id, &member.id)
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_discrimination_started", None);
        json_output(&serde_json::json!({"round": round, "discriminator": member}))
    }

    #[tool(
        description = "Discriminator only: submit an independent pass or reject verdict with concrete evidence. A rejection cannot be overridden by the Leader."
    )]
    async fn team_submit_verdict(
        &self,
        Parameters(input): Parameters<SubmitVerdictInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_mutable_team()?;
        let round = self
            .context
            .teams
            .submit_discrimination_verdict(
                &input.round_id,
                &self.context.member.id,
                input.passed,
                &input.verdict,
                &input.evidence,
            )
            .map_err(mcp_error)?;
        let team = self
            .context
            .teams
            .get_team(&round.team_id)
            .map_err(mcp_error)?;
        self.context
            .teams
            .send_message(
                &team.id,
                &self.context.member.id,
                &team.leader_member_id,
                TeamMessageKind::System,
                None,
                &format!(
                    "Independent review round {} {}: {}",
                    round.round,
                    if input.passed { "passed" } else { "rejected" },
                    input.verdict
                ),
            )
            .map_err(mcp_error)?;
        self.context
            .runtime
            .wake_team_leader(&team.id)
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_discrimination_completed", None);
        json_output(&round)
    }

    #[tool(
        description = "Leader only: explicitly complete the Team after every required task is accepted, permissions/messages are resolved, and the latest YOLO workspace fingerprint has a passing verdict."
    )]
    async fn team_complete(
        &self,
        Parameters(input): Parameters<CompleteTeamInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_leader()?;
        self.require_mutable_team()?;
        let team = self
            .context
            .teams
            .get_team(&self.context.member.team_id)
            .map_err(mcp_error)?;
        let fingerprint = if team.mode == TeamMode::Yolo {
            coordinator(&self.context)
                .capture_team_fingerprint(&team)
                .map_err(mcp_error)?
        } else {
            team.updated_at.clone()
        };
        let completed = self
            .context
            .teams
            .complete_team(
                &team.id,
                &self.context.member.id,
                &input.final_summary,
                &fingerprint,
            )
            .map_err(mcp_error)?;
        let restored = self
            .context
            .runtime
            .restore_team_permissions(&team.id)
            .await
            .map_err(mcp_error)?;
        let _ = self.context.teams.append_activity(
            &team.id,
            Some(&self.context.member.id),
            None,
            "team_completed",
            "Leader completed the Team",
            None,
        );
        if restored {
            let _ = self.context.teams.append_activity(
                &team.id,
                Some(&self.context.member.id),
                None,
                "team_native_permission_restored",
                "Restored the Team's previous native permission profiles",
                None,
            );
        }
        publish_team_event(&self.context, "team_completed", None);
        json_output(&completed)
    }

    #[tool(
        description = "Leader only: review a pending teammate permission. Use decision='resolve' with an exact option_id advertised in pending_permissions, or decision='escalate' with a reason to ask the user."
    )]
    async fn team_review_permission(
        &self,
        Parameters(input): Parameters<ReviewPermissionInput>,
    ) -> Result<CallToolResult, McpError> {
        self.require_leader()?;
        self.require_mutable_team()?;
        let request = self
            .context
            .teams
            .get_permission_request(&input.request_id)
            .map_err(mcp_error)?;
        if request.team_id != self.context.member.team_id {
            return Err(mcp_error("permission request does not belong to this team"));
        }
        let team = self
            .context
            .teams
            .get_team(&request.team_id)
            .map_err(mcp_error)?;
        if input.decision == "escalate" && team.mode == TeamMode::Yolo {
            return Err(mcp_error(
                "Team YOLO permissions must be resolved by the Leader; escalation is disabled",
            ));
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
        self.require_mutable_team()?;
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

    fn require_mutable_team(&self) -> Result<(), McpError> {
        let team = self
            .context
            .teams
            .get_team(&self.context.member.team_id)
            .map_err(mcp_error)?;
        if matches!(
            team.status,
            crate::teams::TeamStatus::Completed
                | crate::teams::TeamStatus::Archived
                | crate::teams::TeamStatus::Disbanding
                | crate::teams::TeamStatus::Removed
        ) {
            Err(mcp_error("the Team lifecycle is read-only"))
        } else {
            Ok(())
        }
    }

    async fn apply_teammate_configuration(
        &self,
        member: &TeamMember,
        mode: Option<String>,
        session_options: BTreeMap<String, SpawnConfigValue>,
    ) -> Result<(), RuntimeError> {
        let force_native_permission = self
            .context
            .teams
            .get_team(&member.team_id)
            .is_ok_and(|team| team.mode == TeamMode::Yolo);
        if let Some(mode) = mode.filter(|_| !force_native_permission) {
            self.context
                .runtime
                .set_session_mode(&member.conversation_id, mode)
                .await?;
        }
        for (config_id, value) in session_options {
            if force_native_permission && config_id == "mode" {
                continue;
            }
            self.context
                .runtime
                .set_session_config(&member.conversation_id, config_id, value.into())
                .await?;
        }
        Ok(())
    }

    async fn fallback_yolo_team(&self, agent_id: AgentId, reason: &str) -> Result<(), McpError> {
        let team_id = &self.context.member.team_id;
        self.context
            .teams
            .downgrade_to_standard(
                team_id,
                agent_id_value(agent_id),
                "native_permission_unavailable",
                reason,
            )
            .map_err(mcp_error)?;
        for discriminator in self
            .context
            .teams
            .remove_discriminators(team_id)
            .map_err(mcp_error)?
        {
            self.context
                .runtime
                .disconnect_conversation(&discriminator.conversation_id)
                .await
                .map_err(mcp_error)?;
            self.context
                .runtime
                .store()
                .delete_conversation(&discriminator.conversation_id)
                .map_err(mcp_error)?;
        }
        self.context
            .runtime
            .restore_team_permissions(team_id)
            .await
            .map_err(mcp_error)?;
        self.context
            .teams
            .append_activity(
                team_id,
                Some(&self.context.member.id),
                None,
                "team_mode_fallback",
                &format!("YOLO fell back to Standard: {reason}"),
                None,
            )
            .map_err(mcp_error)?;
        Ok(())
    }

    fn select_discriminator_agent(&self, team: &crate::teams::Team) -> Result<AgentId, McpError> {
        let leader = self
            .context
            .runtime
            .store()
            .get_conversation(
                &self
                    .context
                    .teams
                    .get_member(&team.leader_member_id)
                    .map_err(mcp_error)?
                    .conversation_id,
            )
            .map_err(mcp_error)?;
        let agents = [AgentId::ClaudeCode, AgentId::Codex, AgentId::OpenCode];
        let leader_index = agents
            .iter()
            .position(|candidate| *candidate == leader.agent_id)
            .unwrap_or_default();
        (1..=agents.len())
            .map(|offset| agents[(leader_index + offset) % agents.len()])
            .find(|candidate| {
                team.allowed_agent_ids
                    .iter()
                    .any(|allowed| allowed == agent_id_value(*candidate))
                    && self.context.runtime.agent_available(*candidate)
            })
            .ok_or_else(|| mcp_error("no allowed and available Agent can run the discriminator"))
    }
}

fn agent_id_value(agent_id: AgentId) -> &'static str {
    match agent_id {
        AgentId::ClaudeCode => "claude_code",
        AgentId::Codex => "codex",
        AgentId::OpenCode => "opencode",
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
