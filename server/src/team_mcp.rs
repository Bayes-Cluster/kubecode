use std::collections::BTreeMap;
use std::sync::Arc;

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
use crate::app_state::AppState;
use crate::team_coordinator::{SpawnDiscriminator, SpawnTeammate, TeamCoordinator};
use crate::teams::{
    MemberWorkspaceMode, NewTeamProposal, NewTeamTask, TeamMember, TeamMemberStatus,
    TeamMessageKind, TeamMode, TeamRole, TeamStore,
};

const TEAM_MCP_NAME: &str = "kubecode-team";
const TEAM_MCP_INSTRUCTIONS: &str = "You are a member of a persistent Kubecode Team. Begin with team_get_context. The Leader plans, creates concrete tasks, configures teammates within the user's Agent and concurrency budget, reviews permissions/plans/results, integrates or edits accepted work when needed, synthesizes the final answer, and calls team_complete. The Leader is never a concrete task assignee. If a semantic decision genuinely requires the user, the Leader calls team_request_user_input; Kubecode pauses scheduling until the answer returns through the durable mailbox. Teammates claim or receive concrete tasks and must submit plans/results through Team tools. A YOLO Discriminator is an independent read-only evaluator: it never implements fixes and only submits a verdict. Every member owns an independent durable ACP transcript. Native provider subagents remain inside their owning Session. In YOLO, Kubecode owns the provider-native permission mode; do not pass mode or a mode session_option when spawning or configuring members. Model, effort, fast mode, and other non-permission session_options remain configurable. Use Agent-native option IDs exactly as advertised and never invent model IDs. When team_get_context includes a research section, its brief is the researcher-approved direction pinned at the revision shown; treat its hypotheses, constraints, and evaluation criteria as binding, use its source references to retrieve further evidence on demand, and do not assume the live research question has not changed since. Before team_complete the Leader calls team_publish_research to record findings, failed approaches, limitations, open questions, and proposals; earlier findings in the research section are attributed records to build on, not established fact, and evidence marked changed or removed no longer proves what it did. When the round has an execution envelope, launch long work with team_launch_experiment, then call team_yield_for_experiment and end your turn instead of waiting: the runtime delivers the result to your inbox, and an experiment stays pending analysis until you analyze it. Launch limits and authorized commands are the researcher's; never retry a refused launch, ask for a change instead.";

#[derive(Clone)]
struct ToolContext {
    runtime: AgentRuntime,
    teams: Arc<TeamStore>,
    research: Option<Arc<crate::research_store::ResearchStore>>,
    runner: Option<Arc<crate::experiment_runner::ExperimentRunner>>,
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
                "team_record_experiment_decision",
                "team_publish_research",
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
                "team_launch_experiment",
                "team_yield_for_experiment",
                "team_cancel_experiment",
                "team_record_experiment_decision",
                "team_publish_research",
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
struct LaunchExperimentInput {
    /// Retry key for this launch. Repeating it returns the same attempt and
    /// starts nothing; a deliberate retry needs a new key.
    launch_key: String,
    /// The command as separate tokens (no shell). It must start with a
    /// command the researcher authorized in the round's execution envelope.
    argv: Vec<String>,
    /// Working directory, relative to your execution root.
    cwd: Option<String>,
    label: Option<String>,
    /// Project-relative files to report on when the process ends.
    #[serde(default)]
    artifacts: Vec<String>,
    task_id: Option<String>,
    /// Runtime cap in seconds; limited by the envelope.
    max_runtime_secs: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DecisionLaunchInput {
    argv: Vec<String>,
    cwd: Option<String>,
    label: Option<String>,
    #[serde(default)]
    artifacts: Vec<String>,
    max_runtime_secs: Option<u32>,
    task_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ExperimentDecisionInput {
    experiment_id: String,
    /// One of: further_analysis, repair, retry, follow_up, external_wait,
    /// researcher_input, conclude.
    decision: String,
    /// Distinguishes several decisions of one kind about one experiment (for
    /// example two follow-ups). Repeating a call with the same key is the same
    /// decision and starts nothing new.
    decision_key: Option<String>,
    /// Why, in terms of the evidence. Required.
    rationale: String,
    #[serde(default)]
    evidence: Vec<EvidenceInput>,
    /// The next experiment, required for retry and follow_up. It is admitted
    /// against the same envelope as any launch.
    launch: Option<DecisionLaunchInput>,
    /// What you need from the researcher, required for researcher_input.
    question: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct YieldInput {
    experiment_id: String,
    /// What you will do with the result, so whoever picks this up knows.
    expected_follow_up: Option<String>,
    /// Longest you are willing to wait before being asked to check, in seconds.
    wait_secs: Option<i64>,
    task_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CancelExperimentInput {
    experiment_id: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
struct EvidenceInput {
    /// One of: session, run, team, team_task, file.
    kind: String,
    /// The record id, or a Project-relative path for a file.
    id: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
struct PublishFindingInput {
    /// One of: finding, attempt, limitation, open_question.
    kind: String,
    statement: String,
    /// Sources that support the statement. A statement without evidence is
    /// recorded as your attributed interpretation, not as an observation.
    #[serde(default)]
    evidence: Vec<EvidenceInput>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
struct PublishResearchInput {
    /// Retry key. Optional: repeating an identical call is already
    /// idempotent; supply one to publish several batches with the same text.
    publication_key: Option<String>,
    #[serde(default)]
    findings: Vec<PublishFindingInput>,
    /// Suggested changes to the approved research direction. A researcher
    /// must accept them; they never change the brief by themselves.
    #[serde(default)]
    proposals: Vec<String>,
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
            "research": research_context(&self.context, &team),
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
        description = "Leader only: immediately remove a teammate from this Team and release assigned work. This removes only Kubecode records; provider-native Session history and Project files are never deleted."
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
        self.context
            .runtime
            .remove_team_member_local_first(team_id, caller_id, &teammate.id)
            .await
            .map_err(mcp_error)?;
        publish_team_event(&self.context, "team_member_updated", None);
        json_output(&serde_json::json!({
            "removed": true,
            "teammate_id": teammate.id,
            "name": teammate.name,
            "provider_history_kept": true,
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
        description = "Leader only: reopen a failed or cancelled task so it becomes required work and can be assigned again or claimed by another teammate."
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
        description = "Leader only: cancel concrete work that is no longer required. This closes active attempts and deliveries, and the task no longer blocks Team completion."
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
        if let Some(research) = &self.context.research {
            research.announce_committed();
        }
        publish_team_event(&self.context, "team_completed", None);
        json_output(&completed)
    }

    #[tool(
        description = "Launch a bounded local experiment inside the round's approved execution envelope and return immediately. The command must start with an argv prefix the researcher authorized; limits on launches, concurrent processes, runtime, and the deadline are enforced by the runtime and cannot be overridden. Launching does not wait: when the process ends the result is delivered to you. Repeating a launch_key returns the same attempt."
    )]
    async fn team_launch_experiment(
        &self,
        Parameters(input): Parameters<LaunchExperimentInput>,
    ) -> Result<CallToolResult, McpError> {
        let (research, runner) = self.execution()?;
        let team = self.context.member.team_id.clone();
        let (project_id, round) = research
            .round_for_team(&team)
            .map_err(mcp_error)?
            .ok_or_else(|| mcp_error("this Team is not part of a research round"))?;
        let experiment = runner
            .launch(
                &project_id,
                &round.research_id,
                crate::experiment_store::NewLaunch {
                    round_id: round.id,
                    launch_key: input.launch_key,
                    team_id: Some(team),
                    task_id: input.task_id,
                    owner_member_id: Some(self.context.member.id.clone()),
                    label: input.label.unwrap_or_default(),
                    argv: input.argv,
                    cwd: input.cwd.unwrap_or_default(),
                    artifacts: input.artifacts,
                    sources: Vec::new(),
                    max_runtime_secs: input.max_runtime_secs,
                },
            )
            .map_err(launch_error)?;
        json_output(&experiment_summary(&experiment))
    }

    #[tool(
        description = "Leader only: record what you decide about a finished experiment, with your rationale and the evidence behind it. Kinds: further_analysis (more analysis first; the result stays owed), repair (a classified blocker to fix), retry or follow_up (start the next experiment from `launch`, inside the researcher's envelope), external_wait (waiting on something outside), researcher_input (ask the researcher; use for scope, extra budget, or direction), conclude (enough evidence or a stopping condition). All but further_analysis and external_wait settle the result's analysis; the Team cannot complete while one is owed. Repeating the call is idempotent. Limits are enforced by the runtime and cannot be overridden here; a negative scientific result is valid evidence, not a failure. Never conclude by exit code alone."
    )]
    async fn team_record_experiment_decision(
        &self,
        Parameters(input): Parameters<ExperimentDecisionInput>,
    ) -> Result<CallToolResult, McpError> {
        use crate::experiment_store::{DecisionKind, NewDecision, NewLaunch};
        use crate::research_api::sources::SourceResolver;
        self.require_leader()?;
        let (research, runner) = self.execution()?;
        let team_id = self.context.member.team_id.clone();
        let (project_id, round) = research
            .round_for_team(&team_id)
            .map_err(mcp_error)?
            .ok_or_else(|| mcp_error("this Team is not part of a research round"))?;
        let kind = DecisionKind::parse(&input.decision)
            .ok_or_else(|| mcp_error(format!("unknown decision: {}", input.decision)))?;
        let store = runner.store();
        let experiment = store
            .experiment(&project_id, &input.experiment_id)
            .map_err(mcp_error)?;
        if experiment.team_id.as_deref() != Some(team_id.as_str()) {
            return Err(mcp_error("experiment not found"));
        }
        if experiment.state.is_active() {
            return Err(mcp_error(
                "the experiment has not finished; wait for its result (or reconcile it if its outcome is unknown)",
            ));
        }
        let key = input
            .decision_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .unwrap_or(kind.as_str())
            .to_owned();
        let workspace = self.context.runtime.workspace_service();
        let resolver = SourceResolver {
            agents: self.context.runtime.store_ref(),
            teams: &self.context.teams,
            workspace: &workspace,
            research: self.context.research.as_deref(),
        };
        let evidence = validate_evidence(
            &resolver,
            &project_id,
            &round.research_id,
            &input.evidence,
            false,
        )?;
        let question = input
            .question
            .as_deref()
            .map(str::trim)
            .filter(|question| !question.is_empty());
        if kind == DecisionKind::ResearcherInput && question.is_none() {
            return Err(mcp_error("researcher_input needs `question`"));
        }
        if kind.launches() && input.launch.is_none() {
            return Err(mcp_error(
                "retry and follow_up need `launch` describing the next experiment",
            ));
        }
        let mut record = NewDecision {
            experiment_id: experiment.id.clone(),
            member_id: self.context.member.id.clone(),
            kind,
            decision_key: Some(key.clone()),
            rationale: input.rationale,
            evidence,
            launched_experiment_id: None,
        };
        // Everything the decision itself must satisfy is checked before it
        // starts anything: a refused decision must not leave a process behind
        // that a retry under a new key would then duplicate.
        record.validate().map_err(mcp_error)?;
        let existing = store
            .find_decision(&project_id, &experiment.id, kind, &key)
            .map_err(mcp_error)?;

        // The next experiment is admitted first, under a key derived from the
        // observation, so the same result can never fan out into duplicates;
        // a refused launch records nothing and leaves the result owed.
        if existing.is_none()
            && let Some(spec) = input.launch
            && kind.launches()
        {
            let digest = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(key.as_bytes()));
            let started = runner
                .launch(
                    &project_id,
                    &round.research_id,
                    NewLaunch {
                        round_id: round.id.clone(),
                        // Derived from fixed-size parts, so any decision key
                        // (spaces, length) yields a valid, stable launch key.
                        launch_key: format!(
                            "decision:{}:{}:{}",
                            experiment.id,
                            kind.as_str(),
                            &digest[..16]
                        ),
                        team_id: Some(team_id.clone()),
                        task_id: spec.task_id,
                        // The decider owns what it starts, so the result comes back to it.
                        owner_member_id: Some(self.context.member.id.clone()),
                        label: spec.label.unwrap_or_default(),
                        argv: spec.argv,
                        cwd: spec.cwd.unwrap_or_default(),
                        artifacts: spec.artifacts,
                        sources: Vec::new(),
                        max_runtime_secs: spec.max_runtime_secs,
                    },
                )
                .map_err(launch_error)?;
            record.launched_experiment_id = Some(started.id);
        }
        // Asking the researcher comes first: if it cannot be asked, nothing
        // is recorded and the result stays owed. A scope, budget, or direction
        // change takes effect only as an explicit envelope or brief revision.
        if existing.is_none()
            && let (DecisionKind::ResearcherInput, Some(question)) = (kind, question)
        {
            self.context
                .teams
                .request_user_input(
                    &team_id,
                    &self.context.member.id,
                    "Research decision needed",
                    question,
                )
                .map_err(|error| {
                    mcp_error(format!("the researcher could not be asked: {error}"))
                })?;
            publish_team_event(&self.context, "team_attention_updated", None);
        }
        let (decision, created) = store
            .record_decision(&project_id, record)
            .map_err(mcp_error)?;
        json_output(&serde_json::json!({
            "decision_id": decision.id,
            "created": created,
            "decision": decision.kind,
            "launched_experiment_id": decision.launched_experiment_id,
            "analysis": store.get(&experiment.id).map_err(mcp_error)?.analysis,
        }))
    }

    #[tool(
        description = "Yield on a running experiment instead of keeping your turn open. Records that you are waiting, then end your turn: ending a turn with an open wait is not a missing report, and you are woken with the result (or with an expiry notice) as a mailbox message. An experiment stays pending analysis until you analyze it; a mailbox acknowledgement does not satisfy that."
    )]
    async fn team_yield_for_experiment(
        &self,
        Parameters(input): Parameters<YieldInput>,
    ) -> Result<CallToolResult, McpError> {
        let (research, runner) = self.execution()?;
        let team_id = self.context.member.team_id.clone();
        let (project_id, _) = research
            .round_for_team(&team_id)
            .map_err(mcp_error)?
            .ok_or_else(|| mcp_error("this Team is not part of a research round"))?;
        let store = runner.store();
        let deadline = input
            .wait_secs
            .map(|secs| store.now() + secs.clamp(1, 86_400));
        let wait = store
            .register_wait(
                &project_id,
                &team_id,
                &self.context.member.id,
                &input.experiment_id,
                input.task_id.as_deref(),
                input.expected_follow_up.as_deref().unwrap_or_default(),
                deadline,
            )
            .map_err(mcp_error)?;
        json_output(&serde_json::json!({
            "wait_id": wait.id,
            "state": wait.state,
            "deadline_at": wait.deadline_at,
            "next": if wait.state == crate::experiment_store::WaitState::Open {
                "End your turn now; the result will be delivered to you."
            } else {
                "The experiment already ended; its result has been delivered to your inbox."
            },
        }))
    }

    #[tool(
        description = "Cancel a running experiment of this Team. Its process group is stopped and the result is delivered as a cancelled experiment."
    )]
    async fn team_cancel_experiment(
        &self,
        Parameters(input): Parameters<CancelExperimentInput>,
    ) -> Result<CallToolResult, McpError> {
        let (research, runner) = self.execution()?;
        let team = self.context.member.team_id.clone();
        let (project_id, _) = research
            .round_for_team(&team)
            .map_err(mcp_error)?
            .ok_or_else(|| mcp_error("this Team is not part of a research round"))?;
        let experiment = runner
            .store()
            .experiment(&project_id, &input.experiment_id)
            .map_err(mcp_error)?;
        if experiment.team_id.as_deref() != Some(team.as_str()) {
            return Err(mcp_error("experiment not found"));
        }
        // Stopping someone else's work is the Leader's call.
        if self.context.member.role != TeamRole::Leader
            && experiment.owner_member_id.as_deref() != Some(self.context.member.id.as_str())
        {
            return Err(mcp_error(
                "only the Leader or the experiment's owner can cancel it",
            ));
        }
        self.require_mutable_team()?;
        let cancelled = runner
            .cancel(&project_id, &input.experiment_id)
            .map_err(launch_error)?;
        json_output(&experiment_summary(&cancelled))
    }

    #[tool(
        description = "Leader only: publish this Team's research outcome to its research question before calling team_complete. Record findings, attempted approaches (including failed ones), limitations, and open questions, each citing evidence sources (session, run, team, team_task, or Project-relative file). Unsupported claims are stored as attributed interpretations. Put anything that would change the approved direction in proposals; a researcher decides on them. Safe to retry. Publishing never resolves the research question."
    )]
    async fn team_publish_research(
        &self,
        Parameters(input): Parameters<PublishResearchInput>,
    ) -> Result<CallToolResult, McpError> {
        use crate::research_api::sources::SourceResolver;
        use crate::research_store::{
            AuthorKind, FindingKind, LinkKind, NewFinding, NewPublication, Producer,
        };
        self.require_leader()?;
        let research = self
            .context
            .research
            .clone()
            .ok_or_else(|| mcp_error("research is not available"))?;
        let team_id = self.context.member.team_id.clone();
        let (project_id, link) = research
            .link_for(LinkKind::Team, &team_id)
            .map_err(mcp_error)?
            .ok_or_else(|| mcp_error("this Team is not linked to a research question"))?;
        let round_id = research
            .round_for_team(&team_id)
            .map_err(mcp_error)?
            .map(|(_, round)| round.id);
        let key = match input
            .publication_key
            .clone()
            .filter(|key| !key.trim().is_empty())
        {
            Some(key) => key,
            None => {
                let digest = serde_json::to_string(&input).map_err(mcp_error)?;
                format!(
                    "team-{}",
                    &hex::encode(<sha2::Sha256 as sha2::Digest>::digest(format!(
                        "{team_id}:{digest}"
                    )))[..24]
                )
            }
        };
        let workspace = self.context.runtime.workspace_service();
        let resolver = SourceResolver {
            agents: self.context.runtime.store_ref(),
            teams: &self.context.teams,
            workspace: &workspace,
            research: self.context.research.as_deref(),
        };
        let replay = research
            .has_publication(&project_id, &link.research_id, &key)
            .map_err(mcp_error)?;
        let findings = input
            .findings
            .iter()
            .map(|finding| {
                let kind = FindingKind::parse(&finding.kind)
                    .ok_or_else(|| mcp_error(format!("unknown finding kind: {}", finding.kind)))?;
                let evidence = validate_evidence(
                    &resolver,
                    &project_id,
                    &link.research_id,
                    &finding.evidence,
                    replay,
                )?;
                Ok(NewFinding {
                    kind,
                    statement: finding.statement.clone(),
                    evidence,
                })
            })
            .collect::<Result<Vec<_>, McpError>>()?;
        let outcome = research
            .publish(
                &project_id,
                &link.research_id,
                NewPublication {
                    key,
                    author_kind: AuthorKind::Agent,
                    author_ref: Some(self.context.member.id.clone()),
                    producer: Producer {
                        team_id: Some(team_id),
                        ..Producer::default()
                    },
                    round_id,
                    findings,
                    proposals: input.proposals.clone(),
                },
            )
            .map_err(mcp_error)?;
        json_output(&serde_json::json!({
            "created": outcome.created,
            "publication_id": outcome.publication.id,
            "findings": outcome.findings.len(),
            "proposals": outcome.proposals.len(),
        }))
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
    fn execution(
        &self,
    ) -> Result<
        (
            Arc<crate::research_store::ResearchStore>,
            Arc<crate::experiment_runner::ExperimentRunner>,
        ),
        McpError,
    > {
        match (&self.context.research, &self.context.runner) {
            (Some(research), Some(runner)) => Ok((Arc::clone(research), Arc::clone(runner))),
            _ => Err(mcp_error("experiment execution is not available")),
        }
    }

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
                agent_id.as_str(),
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
                    .any(|allowed| allowed == candidate.as_str())
                    && self.context.runtime.agent_available(*candidate)
            })
            .ok_or_else(|| mcp_error("no allowed and available Agent can run the discriminator"))
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
    if !state
        .agent_runtime
        .authorize_mcp("team", &conversation_id, &token)
    {
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
            crate::context_mcp::session_manager(TEAM_MCP_NAME, &conversation_id),
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
    let research = runtime.research_store();
    let runner = runtime.experiment_runner();
    Ok(Some(ToolContext {
        runtime,
        teams,
        research,
        runner,
        member,
    }))
}

/// Longest earlier-round summary shown to a member.
pub(crate) const PREVIOUS_SUMMARY_CHARS: usize = 2_000;
/// Earlier rounds shown, newest first.
pub(crate) const PREVIOUS_ROUNDS: usize = 5;
/// Earlier findings shown, newest first, each bounded.
pub(crate) const CONTEXT_FINDINGS: usize = 20;
pub(crate) const CONTEXT_FINDING_CHARS: usize = 1_000;

/// The research context of the Team's round, or `null` for a Team that is not
/// part of one. The brief is the immutable revision the round consumed — not
/// the live question — plus references (never transcripts) for retrieval, and
/// a bounded summary of earlier rounds so a new round can build on them
/// (ADR 0212 §6).
fn research_context(context: &ToolContext, team: &crate::teams::Team) -> serde_json::Value {
    let Some(research) = context.research.as_ref() else {
        return serde_json::Value::Null;
    };
    let Ok(Some((project_id, round))) = research.round_for_team(&team.id) else {
        return serde_json::Value::Null;
    };
    round_delivery(&context.runtime, &project_id, &round)
}

/// The delivery of one research round to whoever executes it — a Team member
/// through `team_get_context` or a Solo Session through `context_round`. One
/// function builds both so Solo and Team cannot drift (ADR 0214): the pinned
/// brief revision, the instruction, the selected sources with their current
/// availability, bounded earlier rounds, attributed findings, and execution
/// facts. Reading it changes nothing.
pub(crate) fn round_delivery(
    runtime: &AgentRuntime,
    project_id: &str,
    round: &crate::research_store::ResearchRound,
) -> serde_json::Value {
    use crate::research_api::sources::SourceResolver;
    let (Some(research), Some(teams)) = (runtime.research_store(), runtime.team_store()) else {
        return serde_json::Value::Null;
    };
    let project_id = project_id.to_owned();
    let round = round.clone();
    let (Ok(question), Ok(brief)) = (
        research.get(&project_id, &round.research_id),
        research.revision(&project_id, &round.research_id, round.brief_revision),
    ) else {
        return serde_json::Value::Null;
    };
    let workspace = runtime.workspace_service();
    let resolver = SourceResolver {
        agents: runtime.store_ref(),
        teams: &teams,
        workspace: &workspace,
        research: Some(research.as_ref()),
    };
    let sources: Vec<_> = round
        .sources
        .iter()
        .map(|source| {
            serde_json::json!({
                "kind": source.kind,
                "id": source.id,
                "revision": source.revision,
                "availability": resolver.resolve(&project_id, source),
            })
        })
        .collect();
    let instruction = round
        .request
        .get("instruction")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let previous: Vec<_> = research
        .rounds(&project_id, &round.research_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|earlier| earlier.round < round.round)
        .take(PREVIOUS_ROUNDS)
        .map(|earlier| {
            let earlier_team = earlier
                .team_id
                .as_deref()
                .and_then(|id| teams.get_team(id).ok());
            serde_json::json!({
                "round": earlier.round,
                "brief_revision": earlier.brief_revision,
                "kind": earlier.kind,
                "team_id": earlier.team_id,
                "session_id": earlier.session_id,
                "team_title": earlier_team.as_ref().map(|team| team.title.clone()),
                "team_status": earlier_team.as_ref().map(|team| team.status),
                "final_summary": earlier_team
                    .and_then(|team| team.final_summary)
                    .map(|summary| summary.chars().take(PREVIOUS_SUMMARY_CHARS).collect::<String>()),
            })
        })
        .collect();
    let mut earlier_findings = research
        .findings(&project_id, &round.research_id)
        .unwrap_or_default();
    earlier_findings.reverse();
    let findings: Vec<_> = earlier_findings
        .into_iter()
        .take(CONTEXT_FINDINGS)
        .map(|finding| {
            let evidence: Vec<_> = finding
                .evidence
                .iter()
                .map(|source| {
                    serde_json::json!({
                        "kind": source.kind,
                        "id": source.id,
                        "availability": resolver.resolve(&project_id, source),
                    })
                })
                .collect();
            serde_json::json!({
                "kind": finding.kind,
                "basis": finding.basis,
                "statement": finding.statement.chars().take(CONTEXT_FINDING_CHARS).collect::<String>(),
                "author_kind": finding.author_kind,
                "round_id": finding.round_id,
                "brief_revision": finding.brief_revision,
                "evidence": evidence,
            })
        })
        .collect();
    serde_json::json!({
        "research_id": round.research_id,
        "round": round.round,
        "brief_revision": round.brief_revision,
        "current_revision": question.revision,
        "stale": round.brief_revision < question.revision,
        "brief": brief.brief,
        "instruction": instruction,
        "sources": sources,
        "previous_rounds": previous,
        "findings": findings,
        "execution": execution_context(runtime, &project_id, &round, &resolver),
    })
}

/// Validates cited evidence inside the Project. A replay of something already
/// stored skips validation: its sources may be gone by now, and the record
/// answers.
fn validate_evidence(
    resolver: &crate::research_api::sources::SourceResolver<'_>,
    project_id: &str,
    research_id: &str,
    evidence: &[EvidenceInput],
    replay: bool,
) -> Result<Vec<crate::research_store::SourceRef>, McpError> {
    use crate::research_store::{SourceKind, SourceRef};
    evidence
        .iter()
        .map(|source| {
            let kind = SourceKind::parse(&source.kind)
                .ok_or_else(|| mcp_error(format!("unknown evidence kind: {}", source.kind)))?;
            let reference = SourceRef {
                kind,
                id: source.id.clone(),
                revision: None,
            };
            if replay {
                return Ok(reference);
            }
            resolver
                .validate(project_id, research_id, &reference)
                .map_err(|_| {
                    mcp_error(format!(
                        "evidence {}:{} was not found in this Project",
                        source.kind, source.id
                    ))
                })
        })
        .collect()
}

/// Longest decision rationale shown back in context.
const CONTEXT_RATIONALE_CHARS: usize = 600;
/// Attempts and decisions shown, newest first.
const CONTEXT_ATTEMPTS: usize = 20;

/// The round's execution facts for the Leader and members: the approved
/// envelope and what is consumed, recent attempts, open waits, results still
/// owed an analysis, recent decisions, and the conditions that stop or need
/// attention. Everything is read from committed records, never from prompts.
fn execution_context(
    runtime: &AgentRuntime,
    project_id: &str,
    round: &crate::research_store::ResearchRound,
    resolver: &crate::research_api::sources::SourceResolver<'_>,
) -> serde_json::Value {
    let Some(runner) = runtime.experiment_runner() else {
        return serde_json::Value::Null;
    };
    let store = runner.store();
    let Ok(Some(envelope)) = store.envelope(project_id, &round.research_id, &round.id) else {
        return serde_json::json!({ "envelope": null, "attention": ["no_envelope"] });
    };
    let experiments = store
        .experiments(project_id, &round.research_id, &round.id)
        .unwrap_or_default();
    let waits = store
        .waits(project_id, &round.research_id, &round.id)
        .unwrap_or_default();
    let decisions = store
        .decisions(project_id, &round.research_id, &round.id)
        .unwrap_or_default();
    let blockers = store
        .launch_blockers(project_id, &round.research_id, &round.id)
        .unwrap_or_default();
    let finished_owed = experiments
        .iter()
        .filter(|experiment| {
            !experiment.state.is_active()
                && experiment.analysis == crate::experiment_store::AnalysisState::Pending
        })
        .count();
    let owed: Vec<_> = experiments
        .iter()
        .filter(|experiment| {
            experiment.state.is_active()
                || experiment.analysis == crate::experiment_store::AnalysisState::Pending
        })
        .map(|experiment| experiment.id.clone())
        .collect();
    let attempts: Vec<_> = experiments
        .iter()
        .take(CONTEXT_ATTEMPTS)
        .map(|experiment| {
            let artifacts: Vec<_> = experiment
                .artifact_revisions
                .iter()
                .map(|artifact| {
                    serde_json::json!({
                        "path": artifact.path,
                        "availability": resolver.resolve(
                            project_id,
                            &crate::research_store::SourceRef {
                                kind: crate::research_store::SourceKind::File,
                                id: artifact.path.clone(),
                                revision: artifact.revision.clone(),
                            },
                        ),
                    })
                })
                .collect();
            serde_json::json!({
                "experiment_id": experiment.id,
                "label": experiment.label,
                "argv": experiment.argv,
                "state": experiment.state,
                "analysis": experiment.analysis,
                "exit_code": experiment.exit_code,
                "policy_revision": experiment.policy_revision,
                "reason": experiment.reason,
                "artifacts": artifacts,
            })
        })
        .collect();
    serde_json::json!({
        "envelope": {
            "revision": envelope.revision,
            "state": envelope.state,
            "max_launches": envelope.limits.max_launches,
            "launches_reserved": envelope.launches_reserved,
            "launches_remaining": envelope
                .limits
                .max_launches
                .saturating_sub(envelope.launches_reserved),
            "max_concurrent": envelope.limits.max_concurrent,
            "deadline_at": envelope.limits.deadline_at,
            "now": store.now(),
            "max_runtime_secs": envelope.limits.max_runtime_secs,
            "allowed_commands": envelope.limits.allowed_commands,
        },
        "attempts": attempts,
        "open_waits": waits
            .iter()
            .filter(|wait| wait.state == crate::experiment_store::WaitState::Open)
            .map(|wait| serde_json::json!({
                "experiment_id": wait.experiment_id,
                "owner_member_id": wait.owner_member_id,
                "expected_follow_up": wait.expected_follow_up,
                "deadline_at": wait.deadline_at,
            }))
            .collect::<Vec<_>>(),
        "results_owed": owed,
        "decisions": decisions
            .iter()
            .take(CONTEXT_ATTEMPTS)
            .map(|decision| serde_json::json!({
                "experiment_id": decision.experiment_id,
                "decision": decision.kind,
                "rationale": decision
                    .rationale
                    .chars()
                    .take(CONTEXT_RATIONALE_CHARS)
                    .collect::<String>(),
                "launched_experiment_id": decision.launched_experiment_id,
            }))
            .collect::<Vec<_>>(),
        // Why another launch would be refused right now. The runtime enforces
        // these; a prompt cannot override them.
        "launch_blockers": blockers.iter().map(|blocker| blocker.code()).collect::<Vec<_>>(),
        "attention": attention_codes(&blockers, finished_owed),
    })
}

fn attention_codes(
    blockers: &[crate::experiment_store::LaunchDenial],
    owed: usize,
) -> Vec<&'static str> {
    use crate::experiment_store::LaunchDenial;
    let mut codes = Vec::new();
    for blocker in blockers {
        if matches!(
            blocker,
            LaunchDenial::LaunchBudgetExhausted
                | LaunchDenial::DeadlinePassed
                | LaunchDenial::NoProgress
                | LaunchDenial::ConcurrencyLimit
        ) {
            codes.push(blocker.code());
        }
    }
    if owed > 0 {
        codes.push("results_owed");
    }
    codes
}

/// A refused launch names its stable reason code, so a Leader can tell a
/// spent budget (ask the researcher) from a typo (fix the command).
fn launch_error(error: crate::experiment_runner::RunnerError) -> McpError {
    use crate::experiment_runner::RunnerError;
    use crate::experiment_store::ExperimentError;
    match error {
        RunnerError::Experiment(ExperimentError::Denied(denial)) => mcp_error(format!(
            "launch refused: {}. Limits and authorized commands are set by the researcher; \
             use team_request_user_input to ask for a change instead of retrying.",
            denial.code()
        )),
        RunnerError::Workspace(_) => mcp_error("the working directory is not allowed"),
        other => mcp_error(other),
    }
}

fn experiment_summary(experiment: &crate::experiment_store::Experiment) -> serde_json::Value {
    serde_json::json!({
        "experiment_id": experiment.id,
        "label": experiment.label,
        "state": experiment.state,
        "analysis": experiment.analysis,
        "policy_revision": experiment.policy_revision,
        "exit_code": experiment.exit_code,
    })
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

#[cfg(test)]
mod research_context_tests {
    use super::*;
    use crate::agent_store::AgentStore;
    use crate::research_store::{
        NewRound, ResearchBrief, ResearchStore, RoundKind, SourceKind, SourceRef,
    };
    use crate::teams::{NewTeam, TeamWorkspace};
    use crate::workspace::WorkspaceService;

    struct Fixture {
        _root: tempfile::TempDir,
        runtime: AgentRuntime,
        teams: Arc<TeamStore>,
        research: Arc<ResearchStore>,
        project_id: String,
    }

    fn fixture() -> Fixture {
        let root = tempfile::TempDir::new().expect("tempdir");
        let database = root.path().join("state/kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
        let project = workspace.create_project(".", "alpha").expect("project");
        let agents = Arc::new(AgentStore::open(&database).expect("agents"));
        let teams = Arc::new(TeamStore::open(&database).expect("teams"));
        let research = Arc::new(
            ResearchStore::from_database(agents.database(), Arc::clone(&agents)).expect("research"),
        );
        let runtime = AgentRuntime::new(workspace, agents, Vec::new())
            .with_team_store(Arc::clone(&teams))
            .with_research_store(Arc::clone(&research));
        Fixture {
            _root: root,
            runtime,
            teams,
            research,
            project_id: project.id,
        }
    }

    fn team_with_leader(fixture: &Fixture, title: &str) -> (crate::teams::Team, TeamMember) {
        let leader = fixture
            .runtime
            .store()
            .create_conversation(&fixture.project_id, AgentId::OpenCode, Some(title))
            .expect("leader session");
        let team = fixture
            .teams
            .create_team(NewTeam {
                project_id: &fixture.project_id,
                leader_conversation_id: &leader.id,
                agent_session_id: &leader.agent_session_id,
                leader_name: "Lead",
                title: Some(title),
                workspace: TeamWorkspace::Shared,
                workspace_path: None,
            })
            .expect("team");
        let member = fixture
            .teams
            .list_members(&team.id)
            .expect("members")
            .into_iter()
            .next()
            .expect("leader member");
        (team, member)
    }

    fn context(fixture: &Fixture, member: TeamMember) -> ToolContext {
        ToolContext {
            runtime: fixture.runtime.clone(),
            teams: Arc::clone(&fixture.teams),
            research: fixture.runtime.research_store(),
            runner: None,
            member,
        }
    }

    async fn team_context(context: ToolContext) -> serde_json::Value {
        let result = TeamMcpServer::new(context)
            .team_get_context()
            .await
            .expect("team_get_context");
        let text = result
            .content
            .iter()
            .find_map(|content| content.as_text().map(|text| text.text.clone()))
            .expect("text content");
        serde_json::from_str(&text).expect("context JSON")
    }

    #[tokio::test]
    async fn members_receive_the_pinned_brief_sources_and_earlier_rounds() {
        let fixture = fixture();
        let (question, _) = fixture
            .research
            .create(
                &fixture.project_id,
                ResearchBrief {
                    title: "Pruning".into(),
                    question: "Does pruning keep accuracy?".into(),
                    motivation: String::new(),
                    hypotheses: vec!["H1".into()],
                    constraints: vec!["single GPU".into()],
                    evaluation_criteria: vec!["top-1".into()],
                },
                None,
            )
            .expect("question");
        let new_round = |key: &'static str, revision: u64, sources: Vec<SourceRef>| NewRound {
            kind: RoundKind::Team,
            idempotency_key: key,
            expected_revision: revision,
            request: serde_json::json!({"instruction": "Compare approaches"}),
            sources,
        };

        // Round 1 finishes with a summary the next round can build on.
        let (first_team, _) = team_with_leader(&fixture, "First team");
        let (first, _) = fixture
            .research
            .begin_round(
                &fixture.project_id,
                &question.id,
                new_round("a", 1, Vec::new()),
            )
            .expect("round 1");
        fixture
            .research
            .round_set_session(
                &fixture.project_id,
                &question.id,
                &first.id,
                &first_team.agent_session_id,
            )
            .expect("session");
        fixture
            .research
            .round_attach_team(&fixture.project_id, &question.id, &first.id, &first_team.id)
            .expect("attach");

        // The brief is edited, then round 2 starts against revision 2.
        fixture
            .research
            .update_brief(
                &fixture.project_id,
                &question.id,
                1,
                &crate::research_store::BriefPatch {
                    constraints: Some(vec!["two GPUs".into()]),
                    ..Default::default()
                },
                None,
            )
            .expect("edit");
        let (second_team, second_leader) = team_with_leader(&fixture, "Second team");
        let sources = vec![
            SourceRef {
                kind: SourceKind::Team,
                id: first_team.id.clone(),
                revision: None,
            },
            SourceRef {
                kind: SourceKind::Session,
                id: "removed-session".into(),
                revision: None,
            },
        ];
        let (second, _) = fixture
            .research
            .begin_round(
                &fixture.project_id,
                &question.id,
                new_round("b", 2, sources),
            )
            .expect("round 2");
        fixture
            .research
            .round_set_session(
                &fixture.project_id,
                &question.id,
                &second.id,
                &second_team.agent_session_id,
            )
            .expect("session");
        fixture
            .research
            .round_attach_team(
                &fixture.project_id,
                &question.id,
                &second.id,
                &second_team.id,
            )
            .expect("attach");

        let value = team_context(context(&fixture, second_leader.clone())).await;
        let research = &value["research"];
        assert_eq!(research["round"], 2);
        assert_eq!(research["brief_revision"], 2);
        assert_eq!(research["stale"], false);
        assert_eq!(
            research["brief"]["constraints"],
            serde_json::json!(["two GPUs"])
        );
        assert_eq!(research["instruction"], "Compare approaches");
        let states: Vec<_> = research["sources"]
            .as_array()
            .expect("sources")
            .iter()
            .map(|source| {
                (
                    source["id"].as_str().expect("id"),
                    source["availability"].as_str().expect("state"),
                )
            })
            .collect();
        assert_eq!(
            states,
            vec![
                (first_team.id.as_str(), "available"),
                ("removed-session", "removed")
            ]
        );
        let previous = research["previous_rounds"].as_array().expect("previous");
        assert_eq!(previous.len(), 1);
        assert_eq!(
            (
                previous[0]["round"].clone(),
                previous[0]["brief_revision"].clone()
            ),
            (serde_json::json!(1), serde_json::json!(1))
        );
        assert_eq!(previous[0]["team_title"], "First team");

        // Round 1 keeps seeing the revision it consumed, flagged stale.
        let first_leader = fixture
            .teams
            .list_members(&first_team.id)
            .expect("members")
            .remove(0);
        let first_value = team_context(context(&fixture, first_leader)).await;
        assert_eq!(
            first_value["research"]["brief"]["constraints"],
            serde_json::json!(["single GPU"])
        );
        assert_eq!(first_value["research"]["stale"], true);
        assert_eq!(first_value["research"]["current_revision"], 2);
    }

    fn text(result: CallToolResult) -> serde_json::Value {
        let text = result
            .content
            .iter()
            .find_map(|content| content.as_text().map(|text| text.text.clone()))
            .expect("text content");
        serde_json::from_str(&text).expect("JSON")
    }

    #[tokio::test]
    async fn the_leader_publishes_attributed_findings_once_and_later_rounds_see_them() {
        let fixture = fixture();
        let (question, _) = fixture
            .research
            .create(
                &fixture.project_id,
                ResearchBrief {
                    title: "Pruning".into(),
                    question: "Does pruning keep accuracy?".into(),
                    ..Default::default()
                },
                None,
            )
            .expect("question");
        let (team, leader) = team_with_leader(&fixture, "Team");
        let (round, _) = fixture
            .research
            .begin_round(
                &fixture.project_id,
                &question.id,
                NewRound {
                    kind: RoundKind::Team,
                    idempotency_key: "a",
                    expected_revision: 1,
                    request: serde_json::json!({}),
                    sources: Vec::new(),
                },
            )
            .expect("round");
        fixture
            .research
            .round_set_session(
                &fixture.project_id,
                &question.id,
                &round.id,
                &team.agent_session_id,
            )
            .expect("session");
        fixture
            .research
            .round_attach_team(&fixture.project_id, &question.id, &round.id, &team.id)
            .expect("attach");

        let server = TeamMcpServer::new(context(&fixture, leader.clone()));
        let input = || PublishResearchInput {
            publication_key: None,
            findings: vec![
                PublishFindingInput {
                    kind: "finding".into(),
                    statement: "Layer 4 tolerates pruning".into(),
                    evidence: vec![EvidenceInput {
                        kind: "team".into(),
                        id: team.id.clone(),
                    }],
                },
                PublishFindingInput {
                    kind: "attempt".into(),
                    statement: "Unstructured pruning diverged".into(),
                    evidence: Vec::new(),
                },
            ],
            proposals: vec!["Drop the single-GPU constraint".into()],
        };
        let first = text(
            server
                .team_publish_research(Parameters(input()))
                .await
                .expect("publish"),
        );
        let replay = text(
            server
                .team_publish_research(Parameters(input()))
                .await
                .expect("replay"),
        );
        assert_eq!(first["created"], true);
        assert_eq!(replay["created"], false);
        assert_eq!(first["publication_id"], replay["publication_id"]);
        let stored = fixture
            .research
            .findings(&fixture.project_id, &question.id)
            .expect("findings");
        assert_eq!(stored.len(), 2, "a retry must not duplicate findings");
        assert_eq!(stored[0].basis.as_str(), "observation");
        assert_eq!(
            stored[1].basis.as_str(),
            "interpretation",
            "an unsupported claim stays an attributed interpretation"
        );
        assert_eq!(stored[0].author_kind.as_str(), "agent");
        assert_eq!(
            stored[0].producer.team_id.as_deref(),
            Some(team.id.as_str())
        );
        assert_eq!(stored[0].round_id.as_deref(), Some(round.id.as_str()));
        let proposals = fixture
            .research
            .proposals(&fixture.project_id, &question.id)
            .expect("proposals");
        assert_eq!(proposals.len(), 1);
        assert!(proposals[0].review.is_none());
        let unchanged = fixture
            .research
            .get(&fixture.project_id, &question.id)
            .expect("question");
        assert_eq!(
            (unchanged.revision, unchanged.status.as_str()),
            (1, "open"),
            "publishing never edits the brief or resolves the question"
        );

        // Evidence that is not in the Project is refused, and nothing is
        // stored for the rejected call.
        let mut bad = input();
        bad.publication_key = Some("bad".into());
        bad.findings[0].evidence[0].id = "missing-team".into();
        assert!(server.team_publish_research(Parameters(bad)).await.is_err());
        assert_eq!(
            fixture
                .research
                .findings(&fixture.project_id, &question.id)
                .expect("findings")
                .len(),
            2
        );

        // The next member context carries the findings, with state.
        let value = team_context(context(&fixture, leader)).await;
        let findings = value["research"]["findings"].as_array().expect("findings");
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[1]["evidence"][0]["availability"], "available");
        assert_eq!(findings[0]["basis"], "interpretation", "newest first");
    }

    #[tokio::test]
    async fn only_the_leader_of_a_linked_team_can_publish() {
        let fixture = fixture();
        let (_, leader) = team_with_leader(&fixture, "Unlinked");
        let server = TeamMcpServer::new(context(&fixture, leader));
        let result = server
            .team_publish_research(Parameters(PublishResearchInput {
                publication_key: None,
                findings: vec![PublishFindingInput {
                    kind: "finding".into(),
                    statement: "x".into(),
                    evidence: Vec::new(),
                }],
                proposals: Vec::new(),
            }))
            .await;
        assert!(result.is_err(), "an unlinked Team has nowhere to publish");
    }

    #[tokio::test]
    async fn teams_outside_a_round_see_no_research_section() {
        let fixture = fixture();
        let (_, member) = team_with_leader(&fixture, "Plain team");
        let value = team_context(context(&fixture, member)).await;
        assert!(value["research"].is_null());
        assert_eq!(value["role"], "leader");
    }
}

#[cfg(test)]
mod experiment_tool_tests {
    use super::*;
    use crate::agent_runtime::AgentRuntime;
    use crate::experiment_runner::ExperimentRunner;
    use crate::experiment_store::testing::Fixture;
    use crate::experiment_store::{EnvelopeLimits, ExperimentState};

    fn server(fixture: &Fixture, member: TeamMember) -> TeamMcpServer {
        let runner = ExperimentRunner::new(
            Arc::clone(&fixture.experiments),
            Arc::clone(&fixture.workspace),
            Arc::clone(&fixture.teams),
        );
        let runtime = AgentRuntime::new(
            Arc::clone(&fixture.workspace),
            Arc::clone(&fixture.agents),
            Vec::new(),
        )
        .with_team_store(Arc::clone(&fixture.teams))
        .with_research_store(Arc::clone(&fixture.research))
        .with_experiments(Arc::clone(&fixture.experiments), Arc::clone(&runner));
        TeamMcpServer::new(ToolContext {
            runtime,
            teams: Arc::clone(&fixture.teams),
            research: Some(Arc::clone(&fixture.research)),
            runner: Some(runner),
            member,
        })
    }

    fn allow_shell(fixture: &Fixture) {
        fixture
            .experiments
            .set_envelope(
                &fixture.project_id,
                &fixture.research_id,
                &fixture.round_id,
                Some(1),
                EnvelopeLimits {
                    max_launches: 5,
                    max_concurrent: 2,
                    deadline_at: None,
                    max_runtime_secs: 30,
                    max_no_progress: 3,
                    allowed_commands: vec![vec!["sh".into(), "-c".into()]],
                },
                None,
            )
            .expect("envelope");
    }

    fn input(key: &str, argv: &[&str]) -> LaunchExperimentInput {
        LaunchExperimentInput {
            launch_key: key.into(),
            argv: argv.iter().map(|token| (*token).to_owned()).collect(),
            cwd: None,
            label: Some("baseline".into()),
            artifacts: Vec::new(),
            task_id: None,
            max_runtime_secs: None,
        }
    }

    #[tokio::test]
    async fn a_member_launches_inside_the_envelope_and_replays_start_nothing() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let server = server(&fixture, fixture.teammate.clone());
        let first = server
            .team_launch_experiment(Parameters(input("k1", &["sh", "-c", "sleep 0.2"])))
            .await
            .expect("launch");
        let replay = server
            .team_launch_experiment(Parameters(input("k1", &["sh", "-c", "sleep 0.2"])))
            .await
            .expect("replay");
        let id = |result: &CallToolResult| {
            let text = result
                .content
                .iter()
                .find_map(|c| c.as_text().map(|t| t.text.clone()))
                .unwrap();
            serde_json::from_str::<serde_json::Value>(&text).unwrap()
        };
        assert_eq!(id(&first)["experiment_id"], id(&replay)["experiment_id"]);
        assert_eq!(id(&first)["state"], "running");
        let stored = fixture
            .experiments
            .get(id(&first)["experiment_id"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            stored.owner_member_id.as_deref(),
            Some(fixture.teammate.id.as_str())
        );
        assert_eq!(
            stored.policy_revision, 2,
            "admitted under the revision in force"
        );
        assert!(matches!(
            stored.state,
            ExperimentState::Running | ExperimentState::Exited
        ));
    }

    #[tokio::test]
    async fn an_unauthorized_command_or_an_exhausted_budget_is_refused_with_its_reason() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let server = server(&fixture, fixture.leader.clone());
        let refused = server
            .team_launch_experiment(Parameters(input("k", &["rm", "-rf", "/"])))
            .await
            .expect_err("not authorized");
        assert!(
            refused.message.contains("command_not_authorized"),
            "{refused:?}"
        );
        assert!(refused.message.contains("team_request_user_input"));
        // Nothing was reserved by the refusal.
        let envelope = fixture
            .experiments
            .envelope(&fixture.project_id, &fixture.research_id, &fixture.round_id)
            .unwrap()
            .unwrap();
        assert_eq!(envelope.launches_reserved, 0);
    }

    #[tokio::test]
    async fn a_member_cannot_cancel_another_teams_experiment() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let server = server(&fixture, fixture.leader.clone());
        let missing = server
            .team_cancel_experiment(Parameters(CancelExperimentInput {
                experiment_id: "not-an-experiment".into(),
            }))
            .await;
        assert!(missing.is_err());
    }

    // -- Continuation (#165): a scripted Leader ---------------------------------

    fn json_of(result: &CallToolResult) -> serde_json::Value {
        let text = result
            .content
            .iter()
            .find_map(|content| content.as_text().map(|text| text.text.clone()))
            .expect("text content");
        serde_json::from_str(&text).expect("JSON")
    }

    async fn settle(fixture: &Fixture, id: &str) {
        for _ in 0..400 {
            let experiment = fixture.experiments.get(id).expect("experiment");
            if !experiment.state.is_active() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("experiment {id} did not finish");
    }

    fn decision(
        experiment_id: &str,
        kind: &str,
        key: Option<&str>,
        launch: Option<DecisionLaunchInput>,
    ) -> ExperimentDecisionInput {
        ExperimentDecisionInput {
            experiment_id: experiment_id.into(),
            decision: kind.into(),
            decision_key: key.map(str::to_owned),
            rationale: "Baseline reached 0.9; try a wider search".into(),
            evidence: Vec::new(),
            launch,
            question: None,
        }
    }

    fn next(script: &str) -> DecisionLaunchInput {
        DecisionLaunchInput {
            argv: vec!["sh".into(), "-c".into(), script.into()],
            cwd: None,
            label: Some("follow-up".into()),
            artifacts: Vec::new(),
            max_runtime_secs: None,
            task_id: None,
        }
    }

    fn execution(context: &serde_json::Value) -> &serde_json::Value {
        &context["research"]["execution"]
    }

    #[tokio::test]
    async fn a_baseline_result_leads_to_one_justified_follow_up_without_the_researcher() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let leader = server(&fixture, fixture.leader.clone());
        let root = fixture
            .workspace
            .execution_path(&fixture.project_id, None)
            .unwrap();

        // The Leader launches the baseline and yields.
        let baseline = json_of(
            &leader
                .team_launch_experiment(Parameters(input(
                    "baseline",
                    &["sh", "-c", "echo base >> runs.txt"],
                )))
                .await
                .unwrap(),
        )["experiment_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let waited = json_of(
            &leader
                .team_yield_for_experiment(Parameters(YieldInput {
                    experiment_id: baseline.clone(),
                    expected_follow_up: Some("compare with a wider search".into()),
                    wait_secs: Some(60),
                    task_id: None,
                }))
                .await
                .unwrap(),
        );
        assert_eq!(waited["state"], "open");
        settle(&fixture, &baseline).await;

        // The result arrived as a message and is owed an analysis.
        let inbox = fixture.teams.read_messages(&fixture.leader.id).unwrap();
        assert!(
            inbox
                .iter()
                .any(|m| m.body.contains("baseline") || m.body.contains("ended"))
        );
        let context = json_of(&leader.team_get_context().await.unwrap());
        assert_eq!(
            execution(&context)["results_owed"],
            serde_json::json!([baseline])
        );
        assert_eq!(execution(&context)["attempts"][0]["state"], "exited");
        assert!(
            execution(&context)["attention"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c == "results_owed")
        );

        // One justified follow-up, started by a recorded decision.
        let chosen = decision(
            &baseline,
            "follow_up",
            None,
            Some(next("echo wide >> runs.txt")),
        );
        let first = json_of(
            &leader
                .team_record_experiment_decision(Parameters(chosen))
                .await
                .unwrap(),
        );
        assert_eq!(
            (first["created"].clone(), first["analysis"].clone()),
            (serde_json::json!(true), serde_json::json!("analyzed"))
        );
        let follow_up = first["launched_experiment_id"].as_str().unwrap().to_owned();
        // The same call again is the same decision: no second process.
        let again = json_of(
            &leader
                .team_record_experiment_decision(Parameters(decision(
                    &baseline,
                    "follow_up",
                    None,
                    Some(next("echo wide >> runs.txt")),
                )))
                .await
                .unwrap(),
        );
        assert_eq!(
            (
                again["created"].clone(),
                again["launched_experiment_id"].clone()
            ),
            (serde_json::json!(false), serde_json::json!(follow_up))
        );
        settle(&fixture, &follow_up).await;
        assert_eq!(
            std::fs::read_to_string(root.join("runs.txt"))
                .unwrap()
                .lines()
                .count(),
            2,
            "baseline + one follow-up"
        );

        // Conclude: the Team can then complete, and the RQ is not resolved.
        leader
            .team_record_experiment_decision(Parameters(decision(
                &follow_up, "conclude", None, None,
            )))
            .await
            .unwrap();
        fixture
            .teams
            .submit_result(&fixture.task_id, &fixture.teammate.id, "done", "ran")
            .unwrap();
        fixture
            .teams
            .review_result(&fixture.task_id, &fixture.leader.id, true, None)
            .unwrap();
        fixture.teams.read_messages(&fixture.leader.id).unwrap();
        fixture.teams.read_messages(&fixture.teammate.id).unwrap();
        fixture
            .teams
            .complete_team(&fixture.team.id, &fixture.leader.id, "Done", "fp")
            .expect("nothing is owed any more");
        let question = fixture
            .research
            .get(&fixture.project_id, &fixture.research_id)
            .unwrap();
        assert_eq!(
            question.status.as_str(),
            "open",
            "completion never resolves the RQ"
        );
    }

    #[tokio::test]
    async fn a_failed_process_is_a_classified_blocker_and_a_retry_is_a_new_attempt() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let leader = server(&fixture, fixture.leader.clone());
        let failed = json_of(
            &leader
                .team_launch_experiment(Parameters(input("flaky", &["sh", "-c", "exit 7"])))
                .await
                .unwrap(),
        )["experiment_id"]
            .as_str()
            .unwrap()
            .to_owned();
        settle(&fixture, &failed).await;
        // The exit code is an observation; the Leader classifies it.
        let repair = json_of(
            &leader
                .team_record_experiment_decision(Parameters(decision(
                    &failed, "repair", None, None,
                )))
                .await
                .unwrap(),
        );
        assert_eq!(repair["analysis"], "analyzed");
        let retried = json_of(
            &leader
                .team_record_experiment_decision(Parameters(decision(
                    &failed,
                    "retry",
                    Some("after-fix"),
                    Some(next("true")),
                )))
                .await
                .unwrap(),
        );
        let retry_id = retried["launched_experiment_id"].as_str().unwrap();
        assert_ne!(
            retry_id, failed,
            "a retry is a new attempt under the policy"
        );
        let attempt = fixture.experiments.get(retry_id).unwrap();
        assert_eq!(
            attempt.policy_revision,
            fixture.experiments.get(&failed).unwrap().policy_revision
        );
    }

    #[tokio::test]
    async fn exhausted_limits_refuse_the_follow_up_leave_the_result_owed_and_need_the_researcher() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let mut tight = fixture
            .experiments
            .envelope(&fixture.project_id, &fixture.research_id, &fixture.round_id)
            .unwrap()
            .unwrap()
            .limits;
        tight.max_launches = 1;
        fixture
            .experiments
            .set_envelope(
                &fixture.project_id,
                &fixture.research_id,
                &fixture.round_id,
                Some(2),
                tight,
                None,
            )
            .unwrap();
        let leader = server(&fixture, fixture.leader.clone());
        let baseline = json_of(
            &leader
                .team_launch_experiment(Parameters(input("only", &["sh", "-c", "true"])))
                .await
                .unwrap(),
        )["experiment_id"]
            .as_str()
            .unwrap()
            .to_owned();
        settle(&fixture, &baseline).await;

        // The runtime, not the prompt, refuses; nothing is recorded.
        let refused = leader
            .team_record_experiment_decision(Parameters(decision(
                &baseline,
                "follow_up",
                None,
                Some(next("true")),
            )))
            .await
            .expect_err("budget spent");
        assert!(
            refused.message.contains("launch_budget_exhausted"),
            "{refused:?}"
        );
        assert_eq!(
            fixture.experiments.get(&baseline).unwrap().analysis,
            crate::experiment_store::AnalysisState::Pending
        );
        let context = json_of(&leader.team_get_context().await.unwrap());
        assert!(
            execution(&context)["launch_blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c == "launch_budget_exhausted")
        );
        assert!(
            execution(&context)["attention"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c == "launch_budget_exhausted")
        );

        // Asking the researcher uses the existing user-input path.
        let mut ask = decision(&baseline, "researcher_input", None, None);
        ask.question = Some("May we spend two more launches on a wider search?".into());
        let asked = json_of(
            &leader
                .team_record_experiment_decision(Parameters(ask))
                .await
                .unwrap(),
        );
        assert_eq!(asked["created"], true);
        assert_eq!(
            fixture.teams.get_team(&fixture.team.id).unwrap().status,
            crate::teams::TeamStatus::NeedsAttention
        );

        // A granted reply changes nothing by itself: more work is admitted
        // only after the researcher records an explicit envelope revision.
        let request = fixture
            .teams
            .pending_user_input_requests(&fixture.team.id)
            .unwrap()
            .remove(0);
        fixture
            .teams
            .resolve_user_input(&fixture.team.id, &request.id, "Yes, two more")
            .unwrap();
        let still = fixture.reserve("later", &["sh", "-c", "true"]);
        assert!(
            matches!(
                still,
                Err(crate::experiment_store::ExperimentError::Denied(
                    crate::experiment_store::LaunchDenial::LaunchBudgetExhausted
                ))
            ),
            "{still:?}"
        );
        let mut granted = fixture
            .experiments
            .envelope(&fixture.project_id, &fixture.research_id, &fixture.round_id)
            .unwrap()
            .unwrap();
        granted.limits.max_launches = 3;
        fixture
            .experiments
            .set_envelope(
                &fixture.project_id,
                &fixture.research_id,
                &fixture.round_id,
                Some(granted.revision),
                granted.limits,
                Some("researcher"),
            )
            .unwrap();
        let ok = fixture.experiments.reserve(
            &fixture.project_id,
            &fixture.research_id,
            crate::experiment_store::testing::launch(
                &fixture.round_id,
                &fixture.team,
                "later2",
                &["sh", "-c", "true"],
            ),
        );
        assert!(ok.is_ok());
    }

    #[tokio::test]
    async fn only_the_leader_decides_and_only_about_finished_work_of_this_team() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let leader = server(&fixture, fixture.leader.clone());
        let worker = server(&fixture, fixture.teammate.clone());
        let started = json_of(
            &worker
                .team_launch_experiment(Parameters(input("w", &["sh", "-c", "sleep 0.3"])))
                .await
                .unwrap(),
        )["experiment_id"]
            .as_str()
            .unwrap()
            .to_owned();
        // A teammate may launch inside the envelope but not decide.
        assert!(
            worker
                .team_record_experiment_decision(Parameters(decision(
                    &started, "conclude", None, None
                )))
                .await
                .is_err()
        );
        // A running experiment cannot be concluded.
        let early = leader
            .team_record_experiment_decision(Parameters(decision(&started, "conclude", None, None)))
            .await
            .expect_err("not finished");
        assert!(early.message.contains("has not finished"));
        settle(&fixture, &started).await;
        assert!(
            leader
                .team_record_experiment_decision(Parameters(decision(
                    "not-an-experiment",
                    "conclude",
                    None,
                    None
                )))
                .await
                .is_err()
        );
        // A bare retry without a launch description is a malformed decision.
        assert!(
            leader
                .team_record_experiment_decision(Parameters(decision(
                    &started, "retry", None, None
                )))
                .await
                .is_err()
        );
        assert!(
            leader
                .team_record_experiment_decision(Parameters(decision(
                    &started, "conclude", None, None
                )))
                .await
                .is_ok()
        );
    }

    // -- Review fixes (#165) ------------------------------------------------------

    #[tokio::test]
    async fn ordinary_decision_keys_work_and_distinct_keys_are_distinct_follow_ups() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let leader = server(&fixture, fixture.leader.clone());
        let baseline = json_of(
            &leader
                .team_launch_experiment(Parameters(input("base", &["sh", "-c", "true"])))
                .await
                .unwrap(),
        )["experiment_id"]
            .as_str()
            .unwrap()
            .to_owned();
        settle(&fixture, &baseline).await;
        // Long and spaced, but within the 128-character bound.
        let long_key =
            "a long decision key with spaces that would overflow a naive prefix 0123456789";
        assert!(long_key.len() < 128);
        let mut launched = Vec::new();
        for key in ["second follow-up", "follow-up-2-lr", long_key] {
            let result = json_of(
                &leader
                    .team_record_experiment_decision(Parameters(decision(
                        &baseline,
                        "follow_up",
                        Some(key),
                        Some(next("true")),
                    )))
                    .await
                    .unwrap_or_else(|error| panic!("{key:?}: {error:?}")),
            );
            let id = result["launched_experiment_id"]
                .as_str()
                .unwrap()
                .to_owned();
            // Each is a quick process; let it end so the next fits the envelope.
            settle(&fixture, &id).await;
            launched.push(id);
        }
        launched.sort();
        launched.dedup();
        assert_eq!(launched.len(), 3, "one follow-up per decision key");
        // A follow-up the Leader decided on comes back to the Leader.
        let first = fixture.experiments.get(&launched[0]).unwrap();
        assert_eq!(
            first.owner_member_id.as_deref(),
            Some(fixture.leader.id.as_str())
        );
    }

    #[tokio::test]
    async fn a_malformed_decision_starts_nothing_so_a_retry_cannot_duplicate_it() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let leader = server(&fixture, fixture.leader.clone());
        let baseline = json_of(
            &leader
                .team_launch_experiment(Parameters(input("base", &["sh", "-c", "true"])))
                .await
                .unwrap(),
        )["experiment_id"]
            .as_str()
            .unwrap()
            .to_owned();
        settle(&fixture, &baseline).await;
        let mut bad = decision(
            &baseline,
            "follow_up",
            None,
            Some(next("echo started >> started.txt")),
        );
        bad.rationale = "   ".into();
        assert!(
            leader
                .team_record_experiment_decision(Parameters(bad))
                .await
                .is_err()
        );
        let mut too_long = decision(
            &baseline,
            "follow_up",
            None,
            Some(next("echo started >> started.txt")),
        );
        too_long.rationale = "x".repeat(2001);
        assert!(
            leader
                .team_record_experiment_decision(Parameters(too_long))
                .await
                .is_err()
        );
        let root = fixture
            .workspace
            .execution_path(&fixture.project_id, None)
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert!(
            !root.join("started.txt").exists(),
            "no process was started by a refused decision"
        );
        let envelope = fixture
            .experiments
            .envelope(&fixture.project_id, &fixture.research_id, &fixture.round_id)
            .unwrap()
            .unwrap();
        assert_eq!(envelope.launches_reserved, 1, "and no launch was spent");
    }

    #[tokio::test]
    async fn a_researcher_that_cannot_be_asked_leaves_the_result_owed() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let leader = server(&fixture, fixture.leader.clone());
        let started = json_of(
            &leader
                .team_launch_experiment(Parameters(input("a", &["sh", "-c", "true"])))
                .await
                .unwrap(),
        )["experiment_id"]
            .as_str()
            .unwrap()
            .to_owned();
        settle(&fixture, &started).await;
        // The Team is already waiting on the researcher, so another ask fails.
        fixture
            .teams
            .request_user_input(
                &fixture.team.id,
                &fixture.leader.id,
                "Earlier",
                "Earlier question",
            )
            .unwrap();
        let mut ask = decision(&started, "researcher_input", None, None);
        ask.question = Some("May we widen the search?".into());
        assert!(
            leader
                .team_record_experiment_decision(Parameters(ask))
                .await
                .is_err()
        );
        let experiment = fixture.experiments.get(&started).unwrap();
        assert_eq!(
            experiment.analysis,
            crate::experiment_store::AnalysisState::Pending,
            "still owed"
        );
        assert!(
            fixture
                .experiments
                .decisions(&fixture.project_id, &fixture.research_id, &fixture.round_id)
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn only_the_leader_or_the_owner_cancels_and_running_work_is_not_a_result() {
        let fixture = Fixture::new();
        allow_shell(&fixture);
        let leader = server(&fixture, fixture.leader.clone());
        let worker = server(&fixture, fixture.teammate.clone());
        let leader_owned = json_of(
            &leader
                .team_launch_experiment(Parameters(input("l", &["sh", "-c", "sleep 30"])))
                .await
                .unwrap(),
        )["experiment_id"]
            .as_str()
            .unwrap()
            .to_owned();
        // A teammate cannot stop the Leader's work...
        assert!(
            worker
                .team_cancel_experiment(Parameters(CancelExperimentInput {
                    experiment_id: leader_owned.clone()
                }))
                .await
                .is_err()
        );
        // ...and while it runs the context owes no result.
        let context = json_of(&leader.team_get_context().await.unwrap());
        let attention = execution(&context)["attention"].as_array().unwrap();
        assert!(
            attention.iter().all(|code| code != "results_owed"),
            "{attention:?}"
        );
        // The Leader (or the owner) can.
        leader
            .team_cancel_experiment(Parameters(CancelExperimentInput {
                experiment_id: leader_owned.clone(),
            }))
            .await
            .unwrap();
        settle(&fixture, &leader_owned).await;
    }
}
