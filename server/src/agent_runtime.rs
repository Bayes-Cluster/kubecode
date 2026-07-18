use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    BooleanConfigOptionCapabilities, CancelNotification, ClientCapabilities,
    ClientSessionCapabilities, ContentBlock, ContentChunk, CreateElicitationRequest,
    CreateElicitationResponse, ElicitationAcceptAction, ElicitationAction, ElicitationCapabilities,
    ElicitationContentValue, ElicitationFormCapabilities, EnvVariable, ForkSessionRequest,
    InitializeRequest, ListSessionsRequest, LoadSessionRequest, McpServer, McpServerHttp,
    McpServerStdio, NewSessionRequest, NewSessionResponse, PermissionOptionId, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, SelectedPermissionOutcome, SessionConfigOptionValue,
    SessionConfigOptionsCapabilities, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, ToolCall, ToolCallStatus, ToolCallUpdate,
};
use agent_client_protocol::schema::{MaybeUndefined, ProtocolVersion};
use agent_client_protocol::{AcpAgent, ActiveSession, Agent, ConnectionTo, LineDirection};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::agent_discovery::AgentDescriptor;
use crate::agent_discovery::{is_executable, resolve_executable};
use crate::agents::{
    AgentEventKind, AgentId, AgentRun, AgentStore, ConversationRelation, ConversationRelationship,
    PermissionMode, RunStatus, StoreError,
};
use crate::teams::{TeamMemberStatus, TeamMode, TeamRole, TeamStatus, TeamStore};
use crate::workspace::{WorkspaceError, WorkspaceService};

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("agent is not available: {0:?}")]
    AgentUnavailable(AgentId),
    #[error("ACP connection failed: {0}")]
    Acp(String),
    #[error(
        "ACP adapter for {agent:?} is not installed: {binary}. Install it or set {variable} to its executable path"
    )]
    AdapterUnavailable {
        agent: AgentId,
        binary: String,
        variable: &'static str,
    },
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
}

impl RuntimeError {
    pub fn is_native_permission_unavailable(&self) -> bool {
        matches!(self, Self::Acp(message) if message.contains("native_permission_unavailable"))
    }
}

#[derive(Clone, Debug)]
pub struct StartAgentRun {
    pub conversation_id: String,
    pub project_id: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderSessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TeamMemberRemoval {
    pub member: crate::teams::TeamMember,
    pub cleanup_operation: Option<crate::teams::TeamLifecycleOperation>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TeamDisbandResult {
    pub team_id: String,
    pub cleanup_operations: Vec<crate::teams::TeamLifecycleOperation>,
}

#[derive(Clone)]
pub struct AgentRuntime {
    workspace: Arc<WorkspaceService>,
    store: Arc<AgentStore>,
    agents: Arc<HashMap<AgentId, AgentDescriptor>>,
    cancellations: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    sessions: Arc<Mutex<HashMap<String, SessionActorHandle>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
    teams: Option<Arc<TeamStore>>,
    team_mcp_http: Option<Arc<TeamMcpHttpConfig>>,
}

#[derive(Clone)]
struct TeamMcpHttpConfig {
    origin: String,
    token: String,
}

#[derive(Clone)]
struct SessionActorHandle {
    generation: String,
    sender: mpsc::UnboundedSender<SessionCommand>,
}

struct PendingPermission {
    allowed_options: HashSet<String>,
    request_payload: Value,
    run_id: String,
    sender: oneshot::Sender<RequestPermissionOutcome>,
}

struct PendingElicitation {
    run_id: String,
    sender: oneshot::Sender<ElicitationAction>,
}

impl PendingPermission {
    fn accepts(&self, option_id: &str) -> bool {
        self.allowed_options.contains(option_id)
    }
}

const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const OPENCODE_MAXIMUM_PERMISSION: &str = r#"{"*":"allow"}"#;

fn classify_team_failure(run: &AgentRun) -> crate::teams::TeamTaskFailureKind {
    let error = run.error.as_deref().unwrap_or_default().to_lowercase();
    if error.contains("rate limit") || error.contains("too many requests") || error.contains("429")
    {
        crate::teams::TeamTaskFailureKind::RateLimit
    } else if error.contains("quota") || error.contains("limit reached") {
        crate::teams::TeamTaskFailureKind::Quota
    } else if error.contains("auth") || error.contains("unauthorized") || error.contains("401") {
        crate::teams::TeamTaskFailureKind::Auth
    } else if error.contains("permission") || error.contains("denied") {
        crate::teams::TeamTaskFailureKind::PermissionDenied
    } else {
        match run.status {
            RunStatus::TimedOut => crate::teams::TeamTaskFailureKind::Timeout,
            RunStatus::Interrupted | RunStatus::Cancelled => {
                crate::teams::TeamTaskFailureKind::Interrupted
            }
            RunStatus::Failed if error.contains("protocol") || error.contains("acp") => {
                crate::teams::TeamTaskFailureKind::Protocol
            }
            RunStatus::Failed => crate::teams::TeamTaskFailureKind::Process,
            _ => crate::teams::TeamTaskFailureKind::Unknown,
        }
    }
}

impl AgentRuntime {
    pub fn new(
        workspace: Arc<WorkspaceService>,
        store: Arc<AgentStore>,
        agents: Vec<AgentDescriptor>,
    ) -> Self {
        Self {
            workspace,
            store,
            agents: Arc::new(agents.into_iter().map(|agent| (agent.id, agent)).collect()),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            pending_elicitations: Arc::new(Mutex::new(HashMap::new())),
            teams: None,
            team_mcp_http: None,
        }
    }

    pub fn with_team_store(mut self, teams: Arc<TeamStore>) -> Self {
        self.teams = Some(teams);
        self
    }

    pub fn team_store(&self) -> Option<Arc<TeamStore>> {
        self.teams.clone()
    }

    pub fn with_team_mcp_http_origin(mut self, origin: impl Into<String>) -> Self {
        self.team_mcp_http = Some(Arc::new(TeamMcpHttpConfig {
            origin: origin.into().trim_end_matches('/').to_owned(),
            token: Uuid::new_v4().to_string(),
        }));
        self
    }

    pub fn authorize_team_mcp(&self, token: &str) -> bool {
        self.team_mcp_http
            .as_ref()
            .is_some_and(|config| config.token == token)
    }

    fn team_mcp_http_server(
        &self,
        conversation_id: &str,
    ) -> Result<Option<McpServer>, RuntimeError> {
        let Some(teams) = self.team_store() else {
            return Ok(None);
        };
        if teams
            .team_for_conversation(conversation_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?
            .is_none()
        {
            return Ok(None);
        }
        let config = self
            .team_mcp_http
            .as_ref()
            .ok_or_else(|| RuntimeError::Acp("Team MCP HTTP origin is not configured".into()))?;
        Ok(Some(McpServer::Http(McpServerHttp::new(
            "kubecode-team",
            format!(
                "{}/api/v1/team-mcp/{}/{}",
                config.origin, config.token, conversation_id
            ),
        ))))
    }

    pub fn workspace_service(&self) -> Arc<WorkspaceService> {
        Arc::clone(&self.workspace)
    }

    pub fn agent_available(&self, agent_id: AgentId) -> bool {
        self.agents
            .get(&agent_id)
            .is_some_and(|agent| agent.available)
    }

    pub fn available_agents(&self) -> Vec<AgentDescriptor> {
        let mut agents = self.agents.values().cloned().collect::<Vec<_>>();
        agents.sort_by_key(|agent| match agent.id {
            AgentId::ClaudeCode => 0,
            AgentId::Codex => 1,
            AgentId::OpenCode => 2,
        });
        agents
    }

    pub fn wake_team_leader(&self, team_id: &str) -> Result<Option<AgentRun>, RuntimeError> {
        let Some(teams) = self.team_store() else {
            return Ok(None);
        };
        let team = teams
            .get_team(team_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let leader = teams
            .get_member(&team.leader_member_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        self.wake_team_member(team_id, &leader.id)
    }

    pub fn wake_team_member(
        &self,
        team_id: &str,
        member_id: &str,
    ) -> Result<Option<AgentRun>, RuntimeError> {
        let Some(teams) = self.team_store() else {
            return Ok(None);
        };
        let team = teams
            .get_team(team_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let member = teams
            .get_member(member_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        if member.team_id != team.id {
            return Err(RuntimeError::Acp(
                "team member does not belong to this team".into(),
            ));
        }
        if matches!(
            team.status,
            TeamStatus::Completed
                | TeamStatus::Archived
                | TeamStatus::Paused
                | TeamStatus::Disbanding
                | TeamStatus::Removed
        ) || (team.status == TeamStatus::NeedsAttention && member.role != TeamRole::Leader)
        {
            return Ok(None);
        }
        let messages = teams
            .pending_messages(&member.id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        if messages.is_empty() {
            return Ok(None);
        }
        let active_members = teams
            .list_members(team_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?
            .into_iter()
            .filter_map(|candidate| self.store.get_conversation(&candidate.conversation_id).ok())
            .filter(|conversation| {
                matches!(
                    conversation.latest_run_status,
                    Some(RunStatus::Running | RunStatus::WaitingPermission)
                )
            })
            .count();
        let conversation = self.store.get_conversation(&member.conversation_id)?;
        if matches!(
            conversation.latest_run_status,
            Some(RunStatus::Running | RunStatus::WaitingPermission)
        ) {
            let _ = teams.set_member_status(&member.id, TeamMemberStatus::Working);
            return Ok(None);
        }
        if member.role != crate::teams::TeamRole::Leader
            && active_members >= usize::from(team.max_parallel_runs)
        {
            let _ = teams.set_member_status(&member.id, TeamMemberStatus::Queued);
            return Ok(None);
        }
        let summary = messages
            .iter()
            .map(|message| {
                format!(
                    "- {:?} from member {}: {}",
                    message.kind, message.from_member_id, message.body
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let run = match self.start_internal(StartAgentRun {
            conversation_id: member.conversation_id.clone(),
            project_id: team.project_id.clone(),
            message: format!(
                "You are {} {} in Kubecode Team '{}'. Process these durable Team updates now. Use team_get_context for the full current state, communicate through Team MCP, and do not claim work is complete until you report it through the appropriate Team tool.\n{summary}",
                if member.role == crate::teams::TeamRole::Leader { "the" } else { "a" },
                match member.role {
                    crate::teams::TeamRole::Leader => "Leader",
                    crate::teams::TeamRole::Teammate => "Teammate",
                    crate::teams::TeamRole::Discriminator => "read-only Discriminator",
                },
                team.title,
            ),
        }) {
            Ok(run) => run,
            Err(RuntimeError::Store(StoreError::ActiveRun(_))) => return Ok(None),
            Err(error) => {
                let _ = teams.set_member_status(&member.id, TeamMemberStatus::Failed);
                for message in &messages {
                    let _ = teams.mark_message_failed(&message.id, &error.to_string());
                }
                let _ = teams.append_activity(
                    team_id,
                    Some(&member.id),
                    None,
                    "delivery_failed",
                    "Team message delivery failed",
                    None,
                );
                return Err(error);
            }
        };
        let _ = teams.bind_task_attempt_run(&member.id, &run.id);
        for message in &messages {
            teams
                .mark_message_delivered(&message.id)
                .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        }
        let _ = teams.set_member_status(&member.id, TeamMemberStatus::Working);
        let _ = teams.append_activity(
            team_id,
            Some(&member.id),
            None,
            "member_woken",
            "Team member started processing queued work",
            None,
        );
        Ok(Some(run))
    }

    pub fn reconcile_team(&self, team_id: &str) -> Result<(), RuntimeError> {
        let Some(teams) = self.team_store() else {
            return Ok(());
        };
        for member in teams
            .list_members(team_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?
        {
            let _ = self.wake_team_member(team_id, &member.id);
        }
        Ok(())
    }

    fn wake_team_member_for_conversation(&self, conversation_id: &str) {
        let Some(teams) = self.team_store() else {
            return;
        };
        let Ok(Some(team)) = teams.team_for_conversation(conversation_id) else {
            return;
        };
        let Ok(Some(member)) = teams.member_for_conversation(conversation_id) else {
            return;
        };
        let run = self
            .store
            .list_runs(conversation_id)
            .ok()
            .and_then(|runs| runs.into_iter().last());
        let failed_attempt = if member.role == crate::teams::TeamRole::Teammate {
            run.as_ref().and_then(|run| match run.status {
                RunStatus::Failed
                | RunStatus::TimedOut
                | RunStatus::Interrupted
                | RunStatus::Cancelled => {
                    let kind = classify_team_failure(run);
                    teams
                        .fail_active_attempt(
                            &member.id,
                            kind,
                            run.error
                                .as_deref()
                                .unwrap_or("Agent turn ended before reporting a result"),
                        )
                        .ok()
                        .flatten()
                }
                _ => None,
            })
        } else {
            None
        };
        if let Some(attempt) = failed_attempt {
            let summary = format!(
                "{} failed task {} ({})",
                member.name,
                attempt.task_id,
                attempt
                    .failure_kind
                    .map(|kind| kind.as_str())
                    .unwrap_or("unknown")
            );
            let _ = teams.set_member_status(&member.id, TeamMemberStatus::Failed);
            let _ = teams.append_activity(
                &team.id,
                Some(&member.id),
                Some(&attempt.task_id),
                "task_attempt_failed",
                &summary,
                attempt.error.as_deref(),
            );
            let _ = teams.send_message(
                &team.id,
                &member.id,
                &team.leader_member_id,
                crate::teams::TeamMessageKind::System,
                Some(&attempt.task_id),
                &summary,
            );
            let _ = self.wake_team_leader(&team.id);
        } else {
            let _ = teams.set_member_status(&member.id, TeamMemberStatus::Idle);
            self.request_missing_team_report(&teams, &team, &member, run.as_ref());
        }
        let _ = teams.append_activity(
            &team.id,
            Some(&member.id),
            None,
            "turn_completed",
            &format!("{} completed an Agent turn", member.name),
            None,
        );
        let _ = self.wake_team_member(&team.id, &member.id);
        if let Ok(members) = teams.list_members(&team.id) {
            for queued in members {
                if queued.id != member.id {
                    let _ = self.wake_team_member(&team.id, &queued.id);
                }
            }
        }
    }

    fn request_missing_team_report(
        &self,
        teams: &TeamStore,
        team: &crate::teams::Team,
        member: &crate::teams::TeamMember,
        run: Option<&AgentRun>,
    ) {
        if member.role != crate::teams::TeamRole::Teammate
            || !run.is_some_and(|run| run.status == RunStatus::Completed)
        {
            return;
        }
        let Ok(Some(attempt)) = teams.active_attempt_for_member(&member.id) else {
            return;
        };
        let Ok(task) = teams.get_task(&attempt.task_id) else {
            return;
        };
        if task.status == crate::teams::TeamTaskStatus::PlanReview {
            return;
        }
        if attempt.status == crate::teams::TeamTaskAttemptStatus::NeedsReport {
            if let Ok(Some(failed)) = teams.fail_active_attempt(
                &member.id,
                crate::teams::TeamTaskFailureKind::Protocol,
                "Agent completed twice without submitting a Team result",
            ) {
                let _ = teams.send_message(
                    &team.id,
                    &member.id,
                    &team.leader_member_id,
                    crate::teams::TeamMessageKind::System,
                    Some(&failed.task_id),
                    "Teammate completed without submitting a result after one reminder.",
                );
                let _ = self.wake_team_leader(&team.id);
            }
            return;
        }
        if teams
            .mark_attempt_needs_report(&member.id)
            .ok()
            .flatten()
            .is_some()
        {
            let _ = teams.send_message(
                &team.id,
                &team.leader_member_id,
                &member.id,
                crate::teams::TeamMessageKind::System,
                Some(&attempt.task_id),
                "Your Agent turn ended without a structured result. Submit the task result now with team_submit_result, or report a blocker.",
            );
            let _ = self.wake_team_member(&team.id, &member.id);
        }
    }

    pub fn store(&self) -> Arc<AgentStore> {
        Arc::clone(&self.store)
    }

    pub fn start(&self, request: StartAgentRun) -> Result<AgentRun, RuntimeError> {
        self.start_with_visibility(request, false)
    }

    fn start_internal(&self, request: StartAgentRun) -> Result<AgentRun, RuntimeError> {
        self.start_with_visibility(request, true)
    }

    fn start_with_visibility(
        &self,
        request: StartAgentRun,
        internal: bool,
    ) -> Result<AgentRun, RuntimeError> {
        let conversation = self.store.get_conversation(&request.conversation_id)?;
        if conversation.project_id != request.project_id {
            return Err(StoreError::ConversationNotFound(request.conversation_id).into());
        }
        let descriptor = self
            .agents
            .get(&conversation.agent_id)
            .filter(|agent| agent.available)
            .cloned()
            .ok_or(RuntimeError::AgentUnavailable(conversation.agent_id))?;
        let cwd = self
            .workspace
            .execution_path(&request.project_id, conversation.workspace_path.as_deref())?;
        let run = if internal {
            self.store.start_internal_run(
                &request.conversation_id,
                &request.project_id,
                &request.message,
                PermissionMode::Safe,
            )?
        } else {
            self.store.start_run(
                &request.conversation_id,
                &request.project_id,
                &request.message,
                PermissionMode::Safe,
            )?
        };
        if let Ok(Some(tree)) = self
            .workspace
            .capture_git_tree(&cwd, &format!("{}-before", run.id))
        {
            let _ = self.store.set_run_checkpoint(&run.id, Some(&tree), None);
        }
        let (cancel, cancelled) = oneshot::channel();
        self.cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .insert(run.id.clone(), cancel);

        let agent_message = conversation
            .context_prefix
            .as_deref()
            .filter(|_| conversation.provider_session_id.is_none())
            .map(|context| {
                format!(
                    "{context}\n\nContinue with this user request:\n{}",
                    request.message
                )
            })
            .unwrap_or_else(|| request.message.clone());
        let command = AgentCommand {
            run: run.clone(),
            message: agent_message,
            cancelled,
        };
        let config = AgentSessionConfig {
            conversation_id: conversation.id,
            agent_id: conversation.agent_id,
            descriptor,
            provider_session_id: conversation.provider_session_id,
            cwd,
            permission_profile: self.permission_profile(&request.conversation_id),
        };
        self.dispatch(config, SessionCommand::Prompt(command));
        Ok(run)
    }

    pub async fn initialize_conversation(&self, conversation_id: &str) -> Result<(), RuntimeError> {
        let config = self.session_config(conversation_id)?;
        let (response, ready) = oneshot::channel();
        self.dispatch(config, SessionCommand::Ready { response });
        ready
            .await
            .map_err(|_| RuntimeError::Acp("session connection closed".into()))?
            .map_err(RuntimeError::Acp)
    }

    pub async fn disconnect_conversation(&self, conversation_id: &str) -> Result<(), RuntimeError> {
        let handle = self
            .sessions
            .lock()
            .expect("agent session mutex poisoned")
            .remove(conversation_id);
        let Some(handle) = handle else {
            return Ok(());
        };
        let (response, disconnected) = oneshot::channel();
        handle
            .sender
            .send(SessionCommand::Shutdown { response })
            .map_err(|_| RuntimeError::Acp("session connection closed".into()))?;
        tokio::time::timeout(Duration::from_secs(10), disconnected)
            .await
            .map_err(|_| RuntimeError::Acp("timed out disconnecting session".into()))?
            .map_err(|_| RuntimeError::Acp("session connection closed".into()))?;
        Ok(())
    }

    pub async fn reconnect_conversation(&self, conversation_id: &str) -> Result<(), RuntimeError> {
        self.disconnect_conversation(conversation_id).await?;
        self.initialize_conversation(conversation_id).await
    }

    pub async fn restore_team_permissions(&self, team_id: &str) -> Result<bool, RuntimeError> {
        let Some(teams) = self.team_store() else {
            return Ok(false);
        };
        let members = teams
            .list_members(team_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let applied = members
            .into_iter()
            .filter(|member| member.permission_profile_applied)
            .collect::<Vec<_>>();
        let restored = !applied.is_empty();
        for member in applied {
            let conversation = self.store.get_conversation(&member.conversation_id)?;
            let restore_mode = member
                .previous_permission_mode
                .as_deref()
                .or_else(|| default_native_permission_mode(conversation.agent_id));
            if let Some(previous_mode) = restore_mode {
                self.set_session_config(
                    &member.conversation_id,
                    "mode".to_owned(),
                    SessionConfigInput::ValueId(previous_mode.to_owned()),
                )
                .await?;
            }
            teams
                .clear_permission_profile(&member.id)
                .map_err(|error| RuntimeError::Acp(error.to_string()))?;
            self.reconnect_conversation(&member.conversation_id).await?;
        }
        Ok(restored)
    }

    pub async fn list_provider_sessions(
        &self,
        project_id: &str,
        agent_id: AgentId,
    ) -> Result<Vec<ProviderSessionInfo>, RuntimeError> {
        let descriptor = self.available_descriptor(agent_id)?;
        let cwd = self.workspace.project_path(project_id)?;
        let agent = acp_agent(agent_id, &descriptor, AgentPermissionProfile::Default, &cwd)?;
        agent_client_protocol::Client
            .builder()
            .name("Kubecode")
            .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
                let initialization = connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;
                if initialization
                    .agent_capabilities
                    .session_capabilities
                    .list
                    .is_none()
                {
                    return Ok(Vec::new());
                }
                let mut sessions = Vec::new();
                let mut cursor = None;
                loop {
                    let response = connection
                        .send_request(
                            ListSessionsRequest::new()
                                .cwd(cwd.clone())
                                .cursor(cursor.clone()),
                        )
                        .block_task()
                        .await?;
                    sessions.extend(response.sessions.into_iter().map(|session| {
                        ProviderSessionInfo {
                            session_id: session.session_id.to_string(),
                            cwd: session.cwd.to_string_lossy().into_owned(),
                            title: session.title,
                            updated_at: session.updated_at,
                        }
                    }));
                    cursor = response.next_cursor;
                    if cursor.is_none() {
                        break;
                    }
                }
                Ok(sessions)
            })
            .await
            .map_err(|error| RuntimeError::Acp(error.to_string()))
    }

    pub async fn hydrate_provider_session(
        &self,
        conversation_id: &str,
    ) -> Result<(), RuntimeError> {
        if !self
            .store
            .session_events_after(conversation_id, 0)?
            .is_empty()
        {
            return Ok(());
        }
        let conversation = self.store.get_conversation(conversation_id)?;
        let provider_session_id = conversation.provider_session_id.clone().ok_or_else(|| {
            StoreError::InvalidStoredValue("conversation has no provider session".into())
        })?;
        let descriptor = self.available_descriptor(conversation.agent_id)?;
        let cwd = self.workspace.execution_path(
            &conversation.project_id,
            conversation.workspace_path.as_deref(),
        )?;
        let agent = acp_agent(
            conversation.agent_id,
            &descriptor,
            AgentPermissionProfile::Default,
            &cwd,
        )?;
        let update_store = Arc::clone(&self.store);
        let update_conversation_id = conversation.id.clone();
        let state_store = Arc::clone(&self.store);
        let state_conversation_id = conversation.id;
        agent_client_protocol::Client
            .builder()
            .name("Kubecode")
            .on_receive_notification(
                async move |notification: SessionNotification, _connection| {
                    persist_session_update(
                        &update_store,
                        &update_conversation_id,
                        None,
                        notification.update,
                    );
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
                let initialization = connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;
                persist_serialized_session_event(
                    &state_store,
                    &state_conversation_id,
                    "capabilities",
                    &initialization.agent_capabilities,
                );
                let response = connection
                    .send_request(LoadSessionRequest::new(provider_session_id, cwd))
                    .block_task()
                    .await?;
                persist_serialized_session_event(
                    &state_store,
                    &state_conversation_id,
                    "session_loaded",
                    response,
                );
                Ok(())
            })
            .await
            .map_err(|error| RuntimeError::Acp(error.to_string()))
    }

    pub async fn remove_team_member_local_first(
        &self,
        team_id: &str,
        leader_member_id: &str,
        teammate_id: &str,
    ) -> Result<TeamMemberRemoval, RuntimeError> {
        let teams = self
            .team_store()
            .ok_or_else(|| RuntimeError::Acp("Team store is not configured".into()))?;
        let team = teams
            .get_team(team_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let member = teams
            .get_member(teammate_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        if member.team_id != team.id || member.role != TeamRole::Teammate {
            return Err(RuntimeError::Acp(
                "only a teammate in this Team can be removed".into(),
            ));
        }
        let _ = self.disconnect_conversation(&member.conversation_id).await;
        let _ = teams.append_activity(
            &team.id,
            Some(&member.id),
            None,
            "member_removing",
            &format!("Removing teammate {}", member.name),
            None,
        );
        teams
            .remove_teammate(team_id, leader_member_id, teammate_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        self.store.delete_conversation(&member.conversation_id)?;
        let _ = teams.append_activity(
            &team.id,
            None,
            None,
            "member_removed",
            &format!("Removed teammate {}", member.name),
            None,
        );
        Ok(TeamMemberRemoval {
            member,
            cleanup_operation: None,
        })
    }

    pub async fn disband_team_local_first(
        &self,
        team_id: &str,
    ) -> Result<TeamDisbandResult, RuntimeError> {
        let teams = self
            .team_store()
            .ok_or_else(|| RuntimeError::Acp("Team store is not configured".into()))?;
        let team = teams
            .mark_team_disbanding(team_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let disband = teams
            .create_lifecycle_operation(
                &team.id,
                &team.project_id,
                crate::teams::TeamLifecycleOperationKind::Disband,
                None,
                None,
                "{}",
            )
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        teams
            .mark_lifecycle_operation_running(&disband.id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let members = teams
            .list_members(&team.id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        for member in &members {
            let _ = self.disconnect_conversation(&member.conversation_id).await;
        }
        teams
            .delete_team(&team.id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        for member in &members {
            if self.store.get_conversation(&member.conversation_id).is_ok() {
                self.store.delete_conversation(&member.conversation_id)?;
            }
        }
        teams
            .mark_lifecycle_operation_completed(&disband.id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        Ok(TeamDisbandResult {
            team_id: team.id,
            cleanup_operations: Vec::new(),
        })
    }

    pub async fn process_due_lifecycle_operations(&self) -> Result<usize, RuntimeError> {
        let Some(teams) = self.team_store() else {
            return Ok(0);
        };
        let operations = teams
            .due_lifecycle_operations()
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let count = operations.len();
        for operation in operations {
            let _ = self.process_lifecycle_operation(&operation.id).await;
        }
        Ok(count)
    }

    pub async fn process_lifecycle_operation(
        &self,
        operation_id: &str,
    ) -> Result<crate::teams::TeamLifecycleOperation, RuntimeError> {
        let teams = self
            .team_store()
            .ok_or_else(|| RuntimeError::Acp("Team store is not configured".into()))?;
        teams
            .mark_lifecycle_operation_running(operation_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        teams
            .mark_lifecycle_operation_completed(operation_id)
            .map_err(|error| RuntimeError::Acp(error.to_string()))
    }

    pub async fn delete_session(&self, conversation_id: &str) -> Result<(), RuntimeError> {
        self.store.delete_conversation(conversation_id)?;
        Ok(())
    }

    pub async fn fork_provider_session(
        &self,
        conversation_id: &str,
    ) -> Result<crate::agents::Conversation, RuntimeError> {
        let conversation = self.store.get_conversation(conversation_id)?;
        let provider_session_id = conversation.provider_session_id.clone().ok_or_else(|| {
            StoreError::InvalidStoredValue("conversation has no provider session".into())
        })?;
        let descriptor = self.available_descriptor(conversation.agent_id)?;
        let cwd = self.workspace.execution_path(
            &conversation.project_id,
            conversation.workspace_path.as_deref(),
        )?;
        let agent = acp_agent(
            conversation.agent_id,
            &descriptor,
            AgentPermissionProfile::Default,
            &cwd,
        )?;
        let forked_session_id = agent_client_protocol::Client
            .builder()
            .name("Kubecode")
            .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
                let initialization = connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;
                if initialization
                    .agent_capabilities
                    .session_capabilities
                    .fork
                    .is_none()
                {
                    return Err(agent_client_protocol::Error::method_not_found());
                }
                let response = connection
                    .send_request(ForkSessionRequest::new(provider_session_id, cwd))
                    .block_task()
                    .await?;
                Ok(response.session_id.to_string())
            })
            .await
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
        let fork = self.store.create_related_imported_conversation(
            &conversation.project_id,
            conversation.agent_id,
            &forked_session_id,
            conversation.agent_title.as_deref(),
            Some(ConversationRelation {
                parent_conversation_id: conversation.id,
                relationship: ConversationRelationship::Fork,
                read_only: false,
            }),
        )?;
        self.hydrate_provider_session(&fork.id).await?;
        Ok(fork)
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        let cancelled = self
            .cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .remove(run_id)
            .is_some_and(|sender| sender.send(()).is_ok());
        self.cancel_pending_permissions(run_id);
        self.cancel_pending_elicitations(run_id);
        cancelled
    }

    pub fn resolve_permission(&self, request_id: &str, option_id: &str) -> bool {
        let mut permissions = self
            .pending_permissions
            .lock()
            .expect("pending permission mutex poisoned");
        if !permissions
            .get(request_id)
            .is_some_and(|pending| pending.accepts(option_id))
        {
            return false;
        }
        permissions.remove(request_id).is_some_and(|pending| {
            pending
                .sender
                .send(RequestPermissionOutcome::Selected(
                    SelectedPermissionOutcome::new(PermissionOptionId::new(option_id.to_owned())),
                ))
                .is_ok()
        })
    }

    pub fn escalate_team_permission(&self, request_id: &str) -> Result<(), RuntimeError> {
        let (run_id, mut payload) = {
            let permissions = self
                .pending_permissions
                .lock()
                .expect("pending permission mutex poisoned");
            let pending = permissions.get(request_id).ok_or_else(|| {
                RuntimeError::Acp("permission request is no longer active".into())
            })?;
            (pending.run_id.clone(), pending.request_payload.clone())
        };
        if let Value::Object(object) = &mut payload {
            object.insert("reviewer".into(), Value::String("user".into()));
        }
        self.store
            .append_event(&run_id, AgentEventKind::PermissionRequested, &payload)?;
        let run = self.store.get_run(&run_id)?;
        self.store.append_workspace_event(
            "permission_requested",
            Some(&run.project_id),
            Some(&run.conversation_id),
            Some(&run.id),
            &payload,
        )?;
        Ok(())
    }

    pub fn resolve_elicitation(
        &self,
        request_id: &str,
        content: Option<BTreeMap<String, ElicitationContentValue>>,
    ) -> bool {
        self.pending_elicitations
            .lock()
            .expect("pending elicitation mutex poisoned")
            .remove(request_id)
            .is_some_and(|pending| {
                let action = content.map_or(ElicitationAction::Decline, |content| {
                    ElicitationAction::Accept(ElicitationAcceptAction::new().content(content))
                });
                pending.sender.send(action).is_ok()
            })
    }

    fn dispatch(&self, config: AgentSessionConfig, command: SessionCommand) {
        let existing = self
            .sessions
            .lock()
            .expect("agent session mutex poisoned")
            .get(&config.conversation_id)
            .cloned();
        let command = if let Some(handle) = existing {
            match handle.sender.send(command) {
                Ok(()) => return,
                Err(error) => error.0,
            }
        } else {
            command
        };

        let (sender, receiver) = mpsc::unbounded_channel();
        sender
            .send(command)
            .expect("new session actor receiver must be open");
        let generation = Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .expect("agent session mutex poisoned")
            .insert(
                config.conversation_id.clone(),
                SessionActorHandle {
                    generation: generation.clone(),
                    sender,
                },
            );
        let runtime = self.clone();
        tokio::spawn(async move {
            let conversation_id = config.conversation_id.clone();
            runtime.run_session_actor(config, receiver).await;
            let mut sessions = runtime
                .sessions
                .lock()
                .expect("agent session mutex poisoned");
            if sessions
                .get(&conversation_id)
                .is_some_and(|handle| handle.generation == generation)
            {
                sessions.remove(&conversation_id);
            }
        });
    }

    async fn run_session_actor(
        &self,
        config: AgentSessionConfig,
        mut receiver: mpsc::UnboundedReceiver<SessionCommand>,
    ) {
        let active_run_id = Arc::new(Mutex::new(None));
        let result = run_acp_session(
            self.clone(),
            config,
            &mut receiver,
            Arc::clone(&active_run_id),
        )
        .await;
        if let Err(error) = result {
            if let Some(run_id) = active_run_id
                .lock()
                .expect("active run mutex poisoned")
                .take()
            {
                self.fail_run(&run_id, error.to_string());
            }
            while let Ok(command) = receiver.try_recv() {
                match command {
                    SessionCommand::Prompt(command) => {
                        self.fail_run(&command.run.id, error.to_string());
                        self.remove_cancellation(&command.run.id);
                    }
                    SessionCommand::SetMode { response, .. }
                    | SessionCommand::SetConfig { response, .. }
                    | SessionCommand::Ready { response } => {
                        let _ = response.send(Err(error.to_string()));
                    }
                    SessionCommand::Shutdown { response } => {
                        let _ = response.send(());
                    }
                }
            }
        }
    }

    fn fail_run(&self, run_id: &str, message: String) {
        let run = self.store.get_run(run_id).ok();
        let _ =
            self.store
                .append_event(run_id, AgentEventKind::Error, &json!({"message": message}));
        let _ = self
            .store
            .finish_run(run_id, RunStatus::Failed, Some(&message));
        self.capture_after_checkpoint(run_id);
        if let Some(run) = run {
            let _ = self.store.append_session_event(
                &run.conversation_id,
                "run_completed",
                &json!({"run_id":run_id, "status":"failed", "error":message}),
            );
        }
    }

    fn capture_after_checkpoint(&self, run_id: &str) {
        let Ok(run) = self.store.get_run(run_id) else {
            return;
        };
        let Ok(conversation) = self.store.get_conversation(&run.conversation_id) else {
            return;
        };
        let Ok(cwd) = self.workspace.execution_path(
            &conversation.project_id,
            conversation.workspace_path.as_deref(),
        ) else {
            return;
        };
        if let Ok(Some(tree)) = self
            .workspace
            .capture_git_tree(&cwd, &format!("{run_id}-after"))
        {
            let _ = self.store.set_run_checkpoint(run_id, None, Some(&tree));
        }
    }

    fn remove_cancellation(&self, run_id: &str) {
        self.cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .remove(run_id);
    }

    fn cancel_pending_permissions(&self, run_id: &str) {
        let mut permissions = self
            .pending_permissions
            .lock()
            .expect("pending permission mutex poisoned");
        let request_ids = permissions
            .iter()
            .filter(|(_, pending)| pending.run_id == run_id)
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        for request_id in request_ids {
            if let Some(pending) = permissions.remove(&request_id) {
                let _ = pending.sender.send(RequestPermissionOutcome::Cancelled);
            }
        }
    }

    fn cancel_pending_elicitations(&self, run_id: &str) {
        let mut elicitations = self
            .pending_elicitations
            .lock()
            .expect("pending elicitation mutex poisoned");
        let request_ids = elicitations
            .iter()
            .filter(|(_, pending)| pending.run_id == run_id)
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        for request_id in request_ids {
            if let Some(pending) = elicitations.remove(&request_id) {
                let _ = pending.sender.send(ElicitationAction::Cancel);
            }
        }
    }

    fn available_descriptor(&self, agent_id: AgentId) -> Result<AgentDescriptor, RuntimeError> {
        self.agents
            .get(&agent_id)
            .filter(|agent| agent.available)
            .cloned()
            .ok_or(RuntimeError::AgentUnavailable(agent_id))
    }

    pub async fn set_session_mode(
        &self,
        conversation_id: &str,
        mode_id: String,
    ) -> Result<(), RuntimeError> {
        self.dispatch_session_control(conversation_id, |response| SessionCommand::SetMode {
            mode_id,
            response,
        })
        .await
    }

    pub async fn set_session_config(
        &self,
        conversation_id: &str,
        config_id: String,
        value: SessionConfigInput,
    ) -> Result<(), RuntimeError> {
        self.dispatch_session_control(conversation_id, |response| SessionCommand::SetConfig {
            config_id,
            value,
            response,
        })
        .await
    }

    async fn dispatch_session_control(
        &self,
        conversation_id: &str,
        command: impl FnOnce(oneshot::Sender<Result<(), String>>) -> SessionCommand,
    ) -> Result<(), RuntimeError> {
        let config = self.session_config(conversation_id)?;
        let (response, result) = oneshot::channel();
        self.dispatch(config, command(response));
        result
            .await
            .map_err(|_| RuntimeError::Acp("session connection closed".into()))?
            .map_err(RuntimeError::Acp)
    }

    fn session_config(&self, conversation_id: &str) -> Result<AgentSessionConfig, RuntimeError> {
        let conversation = self.store.get_conversation(conversation_id)?;
        let descriptor = self.available_descriptor(conversation.agent_id)?;
        let cwd = self.workspace.execution_path(
            &conversation.project_id,
            conversation.workspace_path.as_deref(),
        )?;
        Ok(AgentSessionConfig {
            conversation_id: conversation.id,
            agent_id: conversation.agent_id,
            descriptor,
            provider_session_id: conversation.provider_session_id,
            cwd,
            permission_profile: self.permission_profile(conversation_id),
        })
    }

    fn permission_profile(&self, conversation_id: &str) -> AgentPermissionProfile {
        let Some(teams) = self.team_store() else {
            return AgentPermissionProfile::Default;
        };
        let Ok(Some(member)) = teams.member_for_conversation(conversation_id) else {
            return AgentPermissionProfile::Default;
        };
        if member.role == TeamRole::Discriminator {
            return AgentPermissionProfile::ReadOnly;
        }
        let Ok(team) = teams.get_team(&member.team_id) else {
            return AgentPermissionProfile::Default;
        };
        if team.mode == TeamMode::Yolo
            && matches!(team.status, TeamStatus::Active | TeamStatus::Verifying)
        {
            AgentPermissionProfile::Maximum
        } else {
            AgentPermissionProfile::Default
        }
    }
}

fn default_native_permission_mode(agent_id: AgentId) -> Option<&'static str> {
    match agent_id {
        AgentId::ClaudeCode => Some("default"),
        AgentId::Codex => Some("agent"),
        AgentId::OpenCode => None,
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum AgentPermissionProfile {
    #[default]
    Default,
    Maximum,
    ReadOnly,
}

struct AgentSessionConfig {
    conversation_id: String,
    agent_id: AgentId,
    descriptor: AgentDescriptor,
    provider_session_id: Option<String>,
    cwd: PathBuf,
    permission_profile: AgentPermissionProfile,
}

type SessionResponseCapture = Arc<Mutex<HashMap<String, NewSessionResponse>>>;

struct AgentCommand {
    run: AgentRun,
    message: String,
    cancelled: oneshot::Receiver<()>,
}

enum SessionCommand {
    Prompt(AgentCommand),
    Ready {
        response: oneshot::Sender<Result<(), String>>,
    },
    SetMode {
        mode_id: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    SetConfig {
        config_id: String,
        value: SessionConfigInput,
        response: oneshot::Sender<Result<(), String>>,
    },
    Shutdown {
        response: oneshot::Sender<()>,
    },
}

async fn process_session_control(
    connection: &ConnectionTo<Agent>,
    session_id: &agent_client_protocol::schema::v1::SessionId,
    command: SessionCommand,
    store: &AgentStore,
    conversation_id: &str,
) -> Option<AgentCommand> {
    match command {
        SessionCommand::Prompt(command) => Some(command),
        SessionCommand::Ready { response } => {
            let _ = response.send(Ok(()));
            None
        }
        SessionCommand::SetMode { mode_id, response } => {
            let selected_mode = mode_id.clone();
            let result = connection
                .send_request(SetSessionModeRequest::new(session_id.clone(), mode_id))
                .block_task()
                .await
                .map(|_| {
                    persist_serialized_session_event(
                        store,
                        conversation_id,
                        "current_mode",
                        json!({"currentModeId":selected_mode}),
                    );
                })
                .map_err(|error| error.to_string());
            let _ = response.send(result);
            None
        }
        SessionCommand::SetConfig {
            config_id,
            value,
            response,
        } => {
            let value = match value {
                SessionConfigInput::Boolean(value) => SessionConfigOptionValue::boolean(value),
                SessionConfigInput::ValueId(value) => SessionConfigOptionValue::value_id(value),
            };
            let result = connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    config_id,
                    value,
                ))
                .block_task()
                .await
                .map(|update| {
                    persist_serialized_session_event(
                        store,
                        conversation_id,
                        "config_options",
                        update,
                    );
                })
                .map_err(|error| error.to_string());
            let _ = response.send(result);
            None
        }
        SessionCommand::Shutdown { response } => {
            let _ = response.send(());
            None
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum SessionConfigInput {
    Boolean(bool),
    ValueId(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AcpRunOutcome {
    Completed,
    Cancelled,
}

async fn run_acp_session(
    runtime: AgentRuntime,
    config: AgentSessionConfig,
    receiver: &mut mpsc::UnboundedReceiver<SessionCommand>,
    active_run_id: Arc<Mutex<Option<String>>>,
) -> Result<(), RuntimeError> {
    let hydrate_provider_history = config.provider_session_id.is_some()
        && runtime
            .store
            .session_events_after(&config.conversation_id, 0)?
            .is_empty();
    let session_responses = SessionResponseCapture::default();
    let response_capture = Arc::clone(&session_responses);
    let agent = acp_agent(
        config.agent_id,
        &config.descriptor,
        config.permission_profile,
        &config.cwd,
    )?
    .with_debug(move |line, direction| {
        capture_new_session_response(&response_capture, line, direction)
    });
    let update_store = Arc::clone(&runtime.store);
    let update_run_id = Arc::clone(&active_run_id);
    let update_conversation_id = config.conversation_id.clone();
    let permission_store = Arc::clone(&runtime.store);
    let permission_run_id = Arc::clone(&active_run_id);
    let pending_permissions = Arc::clone(&runtime.pending_permissions);
    let permission_runtime = runtime.clone();
    let permission_conversation_id = config.conversation_id.clone();
    let elicitation_store = Arc::clone(&runtime.store);
    let elicitation_run_id = Arc::clone(&active_run_id);
    let pending_elicitations = Arc::clone(&runtime.pending_elicitations);
    let store = Arc::clone(&runtime.store);
    let conversation_id = config.conversation_id;
    let provider_session_id = config.provider_session_id;
    let cwd = config.cwd;
    let captured_session_responses = Arc::clone(&session_responses);

    let result = agent_client_protocol::Client
        .builder()
        .name("Kubecode")
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                let run_id = update_run_id
                    .lock()
                    .expect("active run mutex poisoned")
                    .clone();
                persist_session_update(
                    &update_store,
                    &update_conversation_id,
                    run_id.as_deref(),
                    notification.update,
                );
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                let run_id = permission_run_id
                    .lock()
                    .expect("active run mutex poisoned")
                    .clone();
                let request_id = Uuid::new_v4().to_string();
                let team_member = permission_runtime
                    .team_store()
                    .and_then(|teams| {
                        teams
                            .member_for_conversation(&permission_conversation_id)
                            .ok()
                            .flatten()
                            .map(|member| (teams, member))
                    });
                let discriminator_request = team_member
                    .as_ref()
                    .is_some_and(|(_, member)| {
                        member.role == crate::teams::TeamRole::Discriminator
                    });
                let team_permission = team_member.filter(|(_, member)| {
                    member.role == crate::teams::TeamRole::Teammate
                });
                let reviewer = if team_permission.is_some() { "leader" } else { "user" };
                let should_route_to_leader = team_permission.is_some();
                let request_payload = json!({
                    "request_id": request_id,
                    "tool_id": request.tool_call.tool_call_id.to_string(),
                    "tool": request.tool_call.fields.title,
                    "input": request.tool_call.fields.raw_input,
                    "reviewer": reviewer,
                    "options": request.options.iter().map(|option| json!({
                        "id": option.option_id.to_string(),
                        "label": option.name,
                        "kind": option.kind,
                    })).collect::<Vec<_>>(),
                });
                let outcome = if discriminator_request {
                    RequestPermissionOutcome::Cancelled
                } else if let Some(run_id) = run_id {
                    let _ = permission_store
                        .set_run_status(&run_id, RunStatus::WaitingPermission);
                    let _ = permission_store.append_event(
                        &run_id,
                        AgentEventKind::PermissionRequested,
                        &request_payload,
                    );
                    if let Ok(run) = permission_store.get_run(&run_id) {
                        let _ = permission_store.append_workspace_event(
                            "permission_requested",
                            Some(&run.project_id),
                            Some(&run.conversation_id),
                            Some(&run.id),
                            &request_payload,
                        );
                    }
                    let (sender, receiver) = oneshot::channel();
                    pending_permissions
                        .lock()
                        .expect("pending permission mutex poisoned")
                        .insert(
                            request_id.clone(),
                            PendingPermission {
                                allowed_options: request
                                    .options
                                    .iter()
                                    .map(|option| option.option_id.to_string())
                                    .collect(),
                                request_payload: request_payload.clone(),
                                run_id: run_id.clone(),
                                sender,
                            },
                        );
                    let mut routed_to_leader = false;
                    if let Some((teams, member)) = team_permission {
                        let team = teams.get_team(&member.team_id).ok();
                        let input_json = serde_json::to_string(
                            &request_payload.get("input").cloned().unwrap_or(Value::Null),
                        )
                        .unwrap_or_else(|_| "null".into());
                        let options_json = serde_json::to_string(
                            &request_payload.get("options").cloned().unwrap_or_else(|| json!([])),
                        )
                        .unwrap_or_else(|_| "[]".into());
                        if let Some(team) = team
                            && teams
                                .create_permission_request(
                                    crate::teams::NewTeamPermissionRequest {
                                        id: &request_id,
                                        team_id: &team.id,
                                        member_id: &member.id,
                                        conversation_id: &permission_conversation_id,
                                        run_id: &run_id,
                                        tool: request_payload
                                            .get("tool")
                                            .and_then(Value::as_str)
                                            .unwrap_or("Tool"),
                                        input_json: &input_json,
                                        options_json: &options_json,
                                    },
                                )
                                .is_ok()
                        {
                            routed_to_leader = true;
                            let _ = teams.set_member_status(
                                &member.id,
                                TeamMemberStatus::WaitingPermission,
                            );
                            let _ = teams.append_activity(
                                &team.id,
                                Some(&member.id),
                                None,
                                "permission_requested",
                                &format!("{} requested permission", member.name),
                                Some(&request_id),
                            );
                            let _ = teams.send_message(
                                &team.id,
                                &member.id,
                                &team.leader_member_id,
                                crate::teams::TeamMessageKind::System,
                                None,
                                &format!(
                                    "Teammate {} needs a permission review. Request ID: {}. Call team_get_context, then team_review_permission.",
                                    member.name, request_id
                                ),
                            );
                            let _ = permission_runtime.store.append_workspace_event(
                                "team_permission_updated",
                                Some(&team.project_id),
                                Some(&permission_conversation_id),
                                Some(&run_id),
                                &json!({"team_id":team.id, "request_id":request_id}),
                            );
                            let _ = permission_runtime.wake_team_leader(&team.id);
                        }
                    }
                    if should_route_to_leader && !routed_to_leader {
                        let _ = permission_runtime.escalate_team_permission(&request_id);
                    }
                    let outcome = receiver
                        .await
                        .unwrap_or(RequestPermissionOutcome::Cancelled);
                    pending_permissions
                        .lock()
                        .expect("pending permission mutex poisoned")
                        .remove(&request_id);
                    if matches!(outcome, RequestPermissionOutcome::Cancelled)
                        && let Some(teams) = permission_runtime.team_store()
                    {
                        let _ = teams.cancel_permission_request(&request_id);
                    }
                    let _ = permission_store.set_run_status(&run_id, RunStatus::Running);
                    let _ = permission_store.append_event(
                        &run_id,
                        AgentEventKind::PermissionResolved,
                        &json!({"request_id":request_id, "outcome": outcome}),
                    );
                    outcome
                } else {
                    RequestPermissionOutcome::Cancelled
                };
                responder.respond(RequestPermissionResponse::new(outcome))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CreateElicitationRequest, responder, _connection| {
                let run_id = elicitation_run_id
                    .lock()
                    .expect("active run mutex poisoned")
                    .clone();
                let request_id = Uuid::new_v4().to_string();
                let mut payload = serde_json::to_value(&request).unwrap_or_else(|_| json!({}));
                if let Value::Object(object) = &mut payload {
                    object.insert("request_id".into(), Value::String(request_id.clone()));
                }
                let action = if let Some(run_id) = run_id {
                    let _ = elicitation_store
                        .set_run_status(&run_id, RunStatus::WaitingPermission);
                    let _ = elicitation_store.append_event(
                        &run_id,
                        AgentEventKind::ElicitationRequested,
                        &payload,
                    );
                    let (sender, receiver) = oneshot::channel();
                    pending_elicitations
                        .lock()
                        .expect("pending elicitation mutex poisoned")
                        .insert(
                            request_id.clone(),
                            PendingElicitation {
                                run_id: run_id.clone(),
                                sender,
                            },
                        );
                    let action = tokio::time::timeout(Duration::from_secs(5 * 60), receiver)
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or(ElicitationAction::Cancel);
                    pending_elicitations
                        .lock()
                        .expect("pending elicitation mutex poisoned")
                        .remove(&request_id);
                    let _ = elicitation_store.set_run_status(&run_id, RunStatus::Running);
                    let _ = elicitation_store.append_event(
                        &run_id,
                        AgentEventKind::ElicitationResolved,
                        &json!({"request_id":request_id, "action":action}),
                    );
                    action
                } else {
                    ElicitationAction::Cancel
                };
                responder.respond(CreateElicitationResponse::new(action))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
            let initialization = connection
                .send_request(
                    InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
                        ClientCapabilities::new()
                            .session(ClientSessionCapabilities::new().config_options(
                                SessionConfigOptionsCapabilities::new()
                                    .boolean(BooleanConfigOptionCapabilities::new()),
                            ))
                            .elicitation(
                                ElicitationCapabilities::new()
                                    .form(ElicitationFormCapabilities::new()),
                            ),
                    ),
                )
                .block_task()
                .await?;
            persist_serialized_session_event(
                &store,
                &conversation_id,
                "capabilities",
                &initialization.agent_capabilities,
            );
            let team_mcp_http = if initialization.agent_capabilities.mcp_capabilities.http {
                runtime
                    .team_mcp_http_server(&conversation_id)
                    .map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })?
            } else {
                None
            };

            let (session_id, _team_session) = if let Some(session_id) = provider_session_id {
                if hydrate_provider_history && initialization.agent_capabilities.load_session {
                    let response = connection
                        .send_request(
                            LoadSessionRequest::new(session_id.clone(), cwd.clone())
                                .mcp_servers(team_mcp_http.clone().into_iter().collect()),
                        )
                        .block_task()
                        .await?;
                    persist_serialized_session_event(
                        &store,
                        &conversation_id,
                        "session_loaded",
                        response,
                    );
                    (session_id.into(), None)
                } else {
                    let resumed = if initialization
                    .agent_capabilities
                    .session_capabilities
                    .resume
                    .is_some()
                    {
                        connection
                            .send_request(
                                ResumeSessionRequest::new(session_id.clone(), cwd.clone())
                                    .mcp_servers(team_mcp_http.clone().into_iter().collect()),
                            )
                            .block_task()
                            .await
                            .map(|response| {
                                persist_serialized_session_event(
                                    &store,
                                    &conversation_id,
                                    "session_resumed",
                                    response,
                                );
                            })
                            .is_ok()
                    } else {
                        false
                    };
                    if resumed {
                        (session_id.into(), None)
                    } else {
                        match connection
                            .send_request(LoadSessionRequest::new(
                                session_id.clone(),
                                cwd.clone(),
                            ).mcp_servers(team_mcp_http.clone().into_iter().collect()))
                            .block_task()
                            .await
                        {
                            Ok(response) => {
                                persist_serialized_session_event(
                                    &store,
                                    &conversation_id,
                                    "session_loaded",
                                    response,
                                );
                                (session_id.into(), None)
                            }
                            Err(_) => {
                                create_provider_session(
                                    &connection,
                                    &runtime,
                                    &conversation_id,
                                    cwd,
                                    team_mcp_http.clone(),
                                    &captured_session_responses,
                                )
                                .await?
                            }
                        }
                    }
                }
            } else {
                create_provider_session(
                    &connection,
                    &runtime,
                    &conversation_id,
                    cwd,
                    team_mcp_http,
                    &captured_session_responses,
                )
                .await?
            };
            store
                .set_provider_session(&conversation_id, &session_id.to_string())
                .map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
            apply_native_permission_profile(
                &connection,
                &session_id,
                config.agent_id,
                config.permission_profile,
            )
            .await?;
            loop {
                let command =
                    match tokio::time::timeout(SESSION_IDLE_TIMEOUT, receiver.recv()).await {
                        Ok(Some(command)) => command,
                        Ok(None) | Err(_) => break,
                    };
                let command = match command {
                    SessionCommand::Shutdown { response } => {
                        let _ = response.send(());
                        break;
                    }
                    command => command,
                };
                let Some(command) = process_session_control(
                    &connection,
                    &session_id,
                    command,
                    &runtime.store,
                    &conversation_id,
                )
                .await
                else {
                    continue;
                };
                *active_run_id.lock().expect("active run mutex poisoned") =
                    Some(command.run.id.clone());
                let mut cancelled = command.cancelled;
                let prompt = connection
                    .send_request(PromptRequest::new(
                        session_id.clone(),
                        vec![command.message.into()],
                    ))
                    .block_task();
                tokio::pin!(prompt);
                let mut controls_open = true;
                let mut shutdown_response = None;
                let outcome = loop {
                    tokio::select! {
                        response = &mut prompt => {
                            response?;
                            break AcpRunOutcome::Completed;
                        }
                        _ = &mut cancelled => {
                            connection.send_notification(CancelNotification::new(session_id.clone()))?;
                            break AcpRunOutcome::Cancelled;
                        }
                        next = receiver.recv(), if controls_open => {
                            if let Some(next) = next {
                                if let SessionCommand::Shutdown { response } = next {
                                    connection.send_notification(CancelNotification::new(session_id.clone()))?;
                                    shutdown_response = Some(response);
                                    break AcpRunOutcome::Cancelled;
                                }
                                if let Some(queued_prompt) = process_session_control(
                                    &connection,
                                    &session_id,
                                    next,
                                    &runtime.store,
                                    &conversation_id,
                                ).await {
                                    runtime.fail_run(
                                        &queued_prompt.run.id,
                                        "another prompt is already running in this session".into(),
                                    );
                                    runtime.remove_cancellation(&queued_prompt.run.id);
                                }
                            } else {
                                controls_open = false;
                            }
                        }
                    }
                };
                runtime.remove_cancellation(&command.run.id);
                let status = match outcome {
                    AcpRunOutcome::Completed => RunStatus::Completed,
                    AcpRunOutcome::Cancelled => RunStatus::Cancelled,
                };
                runtime
                    .store
                    .finish_run(&command.run.id, status, None)
                    .map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })?;
                runtime.capture_after_checkpoint(&command.run.id);
                let _ = runtime.store.append_session_event(
                    &conversation_id,
                    "run_completed",
                    &json!({"run_id":command.run.id, "status":status}),
                );
                *active_run_id.lock().expect("active run mutex poisoned") = None;
                runtime.wake_team_member_for_conversation(&conversation_id);
                if let Some(response) = shutdown_response {
                    let _ = response.send(());
                    break;
                }
            }
            Ok(())
        })
        .await;

    result.map_err(|error| RuntimeError::Acp(error.to_string()))
}

async fn create_provider_session(
    connection: &ConnectionTo<Agent>,
    runtime: &AgentRuntime,
    conversation_id: &str,
    cwd: PathBuf,
    team_mcp_http: Option<McpServer>,
    captured_responses: &SessionResponseCapture,
) -> Result<
    (
        agent_client_protocol::schema::v1::SessionId,
        Option<ActiveSession<'static, Agent>>,
    ),
    agent_client_protocol::Error,
> {
    if let Some(mcp_server) = team_mcp_http {
        let response = connection
            .send_request(NewSessionRequest::new(cwd).mcp_servers(vec![mcp_server]))
            .block_task()
            .await?;
        let session_id = response.session_id.clone();
        let _ = take_captured_session_response(captured_responses, &session_id);
        persist_serialized_session_event(
            &runtime.store,
            conversation_id,
            "session_created_state",
            response,
        );
        return Ok((session_id, None));
    }
    if let Some(mcp_server) = crate::team_mcp::build_team_mcp(runtime.clone(), conversation_id)
        .map_err(|error| agent_client_protocol::Error::internal_error().data(error.to_string()))?
    {
        let active_session = connection
            .build_session(&cwd)
            .with_mcp_server(mcp_server)?
            .block_task()
            .start_session()
            .await?;
        let session_id = active_session.session_id().clone();
        let response = take_captured_session_response(captured_responses, &session_id)
            .unwrap_or_else(|| active_session.response());
        persist_serialized_session_event(
            &runtime.store,
            conversation_id,
            "session_created_state",
            response,
        );
        return Ok((session_id, Some(active_session)));
    }
    let response = connection
        .send_request(NewSessionRequest::new(cwd))
        .block_task()
        .await?;
    let session_id = response.session_id.clone();
    let _ = take_captured_session_response(captured_responses, &session_id);
    persist_serialized_session_event(
        &runtime.store,
        conversation_id,
        "session_created_state",
        response,
    );
    Ok((session_id, None))
}

fn capture_new_session_response(
    captured_responses: &SessionResponseCapture,
    line: &str,
    direction: LineDirection,
) {
    if direction != LineDirection::Stdout {
        return;
    }
    let Some(result) = serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|message| message.get("result").cloned())
    else {
        return;
    };
    let Ok(response) = serde_json::from_value::<NewSessionResponse>(result) else {
        return;
    };
    captured_responses
        .lock()
        .expect("session response capture mutex poisoned")
        .insert(response.session_id.to_string(), response);
}

fn take_captured_session_response(
    captured_responses: &SessionResponseCapture,
    session_id: &agent_client_protocol::schema::v1::SessionId,
) -> Option<NewSessionResponse> {
    captured_responses
        .lock()
        .expect("session response capture mutex poisoned")
        .remove(&session_id.to_string())
}

async fn apply_native_permission_profile(
    connection: &ConnectionTo<Agent>,
    session_id: &agent_client_protocol::schema::v1::SessionId,
    agent_id: AgentId,
    profile: AgentPermissionProfile,
) -> Result<(), agent_client_protocol::Error> {
    let config_value = |value: &str| SessionConfigOptionValue::value_id(value.to_owned());
    match (profile, agent_id) {
        (AgentPermissionProfile::Default, _)
        | (AgentPermissionProfile::Maximum, AgentId::OpenCode) => Ok(()),
        (AgentPermissionProfile::Maximum, AgentId::Codex) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("agent-full-access"),
                ))
                .block_task()
                .await
                .map_err(native_permission_error)?;
            Ok(())
        }
        (AgentPermissionProfile::Maximum, AgentId::ClaudeCode) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("bypassPermissions"),
                ))
                .block_task()
                .await
                .map_err(native_permission_error)?;
            Ok(())
        }
        (AgentPermissionProfile::ReadOnly, AgentId::Codex) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("read-only"),
                ))
                .block_task()
                .await?;
            Ok(())
        }
        (AgentPermissionProfile::ReadOnly, AgentId::ClaudeCode) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("plan"),
                ))
                .block_task()
                .await?;
            Ok(())
        }
        (AgentPermissionProfile::ReadOnly, AgentId::OpenCode) => {
            connection
                .send_request(SetSessionModeRequest::new(session_id.clone(), "plan"))
                .block_task()
                .await?;
            Ok(())
        }
    }
}

fn native_permission_error(error: agent_client_protocol::Error) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(serde_json::json!({
        "kind": "native_permission_unavailable",
        "error": error.to_string(),
    }))
}

fn acp_agent(
    agent_id: AgentId,
    descriptor: &AgentDescriptor,
    permission_profile: AgentPermissionProfile,
    cwd: &Path,
) -> Result<AcpAgent, RuntimeError> {
    let (name, command, args, agent_environment) = match agent_id {
        AgentId::ClaudeCode => (
            "Claude Agent",
            configured_adapter(
                AgentId::ClaudeCode,
                "KUBECODE_CLAUDE_ACP_PATH",
                "claude-agent-acp",
            )?,
            Vec::new(),
            vec![EnvVariable::new(
                "CLAUDE_CODE_EXECUTABLE",
                descriptor.executable.clone(),
            )],
        ),
        AgentId::Codex => (
            "Codex",
            configured_adapter(AgentId::Codex, "KUBECODE_CODEX_ACP_PATH", "codex-acp")?,
            Vec::new(),
            vec![EnvVariable::new(
                "CODEX_PATH",
                descriptor.executable.clone(),
            )],
        ),
        AgentId::OpenCode => {
            let environment = if permission_profile == AgentPermissionProfile::Maximum {
                vec![EnvVariable::new(
                    "OPENCODE_PERMISSION",
                    OPENCODE_MAXIMUM_PERMISSION,
                )]
            } else {
                Vec::new()
            };
            (
                "OpenCode",
                PathBuf::from(&descriptor.executable),
                vec![
                    "acp".to_owned(),
                    "--cwd".to_owned(),
                    cwd.to_string_lossy().into_owned(),
                ],
                environment,
            )
        }
    };
    let mut launcher_args = vec![
        "-c".to_owned(),
        "cd \"$1\" || exit 126\nshift\nexec \"$@\"".to_owned(),
        "kubecode-agent-launcher".to_owned(),
        cwd.to_string_lossy().into_owned(),
        command.to_string_lossy().into_owned(),
    ];
    launcher_args.extend(args);
    Ok(AcpAgent::new(McpServer::Stdio(
        McpServerStdio::new(name, PathBuf::from("/bin/sh"))
            .args(launcher_args)
            .env(agent_environment),
    )))
}

fn configured_adapter(
    agent: AgentId,
    variable: &'static str,
    default: &str,
) -> Result<PathBuf, RuntimeError> {
    if let Some(configured) = env::var_os(variable).map(PathBuf::from) {
        return executable_path(configured).ok_or_else(|| RuntimeError::AdapterUnavailable {
            agent,
            binary: env::var_os(variable)
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            variable,
        });
    }

    local_adapter(default)
        .or_else(|| resolve_executable(default))
        .ok_or_else(|| RuntimeError::AdapterUnavailable {
            agent,
            binary: default.to_owned(),
            variable,
        })
}

fn executable_path(candidate: PathBuf) -> Option<PathBuf> {
    if candidate.components().count() > 1 {
        is_executable(&candidate).then_some(candidate)
    } else {
        resolve_executable(candidate.to_str()?)
    }
}

fn local_adapter(name: &str) -> Option<PathBuf> {
    let project_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let candidate = project_root.join("node_modules/.bin").join(name);
    is_executable(&candidate).then_some(candidate)
}

fn persist_session_update(
    store: &AgentStore,
    conversation_id: &str,
    run_id: Option<&str>,
    update: SessionUpdate,
) {
    let event = match update {
        SessionUpdate::UserMessageChunk(chunk) => {
            text_event(AgentEventKind::TextDelta, chunk).map(|(_, payload)| {
                if let Some(text) = payload.get("text").and_then(Value::as_str) {
                    let _ = store.set_agent_title_if_untitled(conversation_id, text);
                }
                ("user_message_delta", None, payload)
            })
        }
        SessionUpdate::AgentMessageChunk(chunk) => text_event(AgentEventKind::TextDelta, chunk)
            .map(|(kind, payload)| ("text_delta", Some(kind), payload)),
        SessionUpdate::AgentThoughtChunk(chunk) => text_event(AgentEventKind::ThinkingDelta, chunk)
            .map(|(kind, payload)| ("thinking_delta", Some(kind), payload)),
        SessionUpdate::ToolCall(tool_call) => {
            let (kind, payload) = tool_started(tool_call);
            Some(("tool_started", Some(kind), payload))
        }
        SessionUpdate::ToolCallUpdate(update) => {
            let (kind, payload) = tool_updated(update);
            let session_kind = if kind == AgentEventKind::ToolCompleted {
                "tool_completed"
            } else {
                "tool_updated"
            };
            Some((session_kind, Some(kind), payload))
        }
        SessionUpdate::Plan(plan) => serialized_update("plan", AgentEventKind::Plan, plan),
        SessionUpdate::AvailableCommandsUpdate(commands) => serialized_update(
            "available_commands",
            AgentEventKind::AvailableCommands,
            commands,
        ),
        SessionUpdate::CurrentModeUpdate(mode) => {
            serialized_update("current_mode", AgentEventKind::CurrentMode, mode)
        }
        SessionUpdate::ConfigOptionUpdate(options) => {
            serialized_update("config_options", AgentEventKind::ConfigOptions, options)
        }
        SessionUpdate::SessionInfoUpdate(info) => {
            match &info.title {
                MaybeUndefined::Value(title) if !title.trim().is_empty() => {
                    let _ = store.set_agent_title(conversation_id, Some(title));
                }
                MaybeUndefined::Value(_) | MaybeUndefined::Null | MaybeUndefined::Undefined => {}
            }
            serialized_update("session_info", AgentEventKind::SessionInfo, info)
        }
        SessionUpdate::UsageUpdate(usage) => {
            serialized_update("usage", AgentEventKind::Usage, usage)
        }
        _ => None,
    };
    if let Some((session_kind, run_kind, payload)) = event {
        let session_payload = match run_id {
            Some(run_id) => merge_run_id(payload.clone(), run_id),
            None => payload.clone(),
        };
        let _ = store.append_session_event(conversation_id, session_kind, &session_payload);
        if let (Some(run_id), Some(run_kind)) = (run_id, run_kind) {
            let _ = store.append_event(run_id, run_kind, &payload);
        }
    }
}

fn serialized_update(
    session_kind: &'static str,
    run_kind: AgentEventKind,
    value: impl serde::Serialize,
) -> Option<(&'static str, Option<AgentEventKind>, Value)> {
    serde_json::to_value(value)
        .ok()
        .map(|payload| (session_kind, Some(run_kind), payload))
}

fn persist_serialized_session_event(
    store: &AgentStore,
    conversation_id: &str,
    kind: &str,
    value: impl serde::Serialize,
) {
    if let Ok(payload) = serde_json::to_value(value) {
        let _ = store.append_session_event(conversation_id, kind, &payload);
    }
}

fn merge_run_id(mut payload: Value, run_id: &str) -> Value {
    if let Value::Object(ref mut object) = payload {
        object.insert("run_id".into(), Value::String(run_id.to_owned()));
        payload
    } else {
        json!({"run_id":run_id, "value":payload})
    }
}

fn text_event(kind: AgentEventKind, chunk: ContentChunk) -> Option<(AgentEventKind, Value)> {
    match chunk.content {
        ContentBlock::Text(text) => Some((kind, json!({"text": text.text}))),
        _ => None,
    }
}

fn tool_started(tool_call: ToolCall) -> (AgentEventKind, Value) {
    (
        AgentEventKind::ToolStarted,
        json!({
            "tool_id": tool_call.tool_call_id.to_string(),
            "tool": tool_call.title,
            "input": tool_call.raw_input,
            "output": tool_call.raw_output,
            "status": tool_call.status,
            "content": tool_call.content,
        }),
    )
}

fn tool_updated(update: ToolCallUpdate) -> (AgentEventKind, Value) {
    let kind = match update.fields.status {
        Some(ToolCallStatus::Completed | ToolCallStatus::Failed) => AgentEventKind::ToolCompleted,
        _ => AgentEventKind::ToolUpdated,
    };
    (
        kind,
        json!({
            "tool_id": update.tool_call_id.to_string(),
            "tool": update.fields.title,
            "input": update.fields.raw_input,
            "output": update.fields.raw_output,
            "status": update.fields.status,
            "content": update.fields.content,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{TextContent, ToolCallId, ToolCallUpdateFields};

    #[test]
    fn builds_standard_adapter_commands() {
        let descriptor = AgentDescriptor {
            id: AgentId::OpenCode,
            available: true,
            version: Some("test".into()),
            executable: "/opt/bin/opencode".into(),
            error: None,
        };
        let server = acp_agent(
            AgentId::OpenCode,
            &descriptor,
            AgentPermissionProfile::Default,
            Path::new("/workspace/project"),
        )
        .expect("native ACP agent")
        .into_server();
        let McpServer::Stdio(server) = server else {
            panic!("stdio adapter")
        };
        assert_eq!(server.command, PathBuf::from("/bin/sh"));
        assert_eq!(
            server.args,
            [
                "-c",
                "cd \"$1\" || exit 126\nshift\nexec \"$@\"",
                "kubecode-agent-launcher",
                "/workspace/project",
                "/opt/bin/opencode",
                "acp",
                "--cwd",
                "/workspace/project",
            ],
        );
        assert!(
            !server
                .env
                .iter()
                .any(|variable| variable.name == "OPENCODE_PERMISSION")
        );

        let maximum = acp_agent(
            AgentId::OpenCode,
            &descriptor,
            AgentPermissionProfile::Maximum,
            Path::new("/workspace/project"),
        )
        .expect("maximum ACP agent")
        .into_server();
        let McpServer::Stdio(maximum) = maximum else {
            panic!("stdio adapter")
        };
        let permission = maximum
            .env
            .iter()
            .find(|variable| variable.name == "OPENCODE_PERMISSION")
            .expect("OpenCode maximum permission environment");
        assert_eq!(
            serde_json::from_str::<Value>(&permission.value).expect("permission JSON"),
            json!({"*": "allow"}),
        );
    }

    #[test]
    fn restores_provider_defaults_without_treating_opencode_agent_mode_as_permission() {
        assert_eq!(
            default_native_permission_mode(AgentId::ClaudeCode),
            Some("default")
        );
        assert_eq!(
            default_native_permission_mode(AgentId::Codex),
            Some("agent")
        );
        assert_eq!(default_native_permission_mode(AgentId::OpenCode), None);
    }

    #[test]
    fn codex_adapter_uses_discovered_cli_and_project_adapter() {
        let descriptor = AgentDescriptor {
            id: AgentId::Codex,
            available: true,
            version: Some("test".into()),
            executable: "/opt/homebrew/bin/codex".into(),
            error: None,
        };
        let server = acp_agent(
            AgentId::Codex,
            &descriptor,
            AgentPermissionProfile::Default,
            Path::new("/workspace/project"),
        )
        .expect("project ACP adapter")
        .into_server();
        let McpServer::Stdio(server) = server else {
            panic!("stdio adapter")
        };
        assert_eq!(server.command, PathBuf::from("/bin/sh"));
        assert!(
            server
                .args
                .iter()
                .any(|argument| argument.ends_with("node_modules/.bin/codex-acp"))
        );
        assert!(server.env.iter().any(|variable| {
            variable.name == "CODEX_PATH" && variable.value == "/opt/homebrew/bin/codex"
        }));
    }

    #[test]
    fn claude_adapter_uses_discovered_cli_and_project_adapter() {
        let descriptor = AgentDescriptor {
            id: AgentId::ClaudeCode,
            available: true,
            version: Some("test".into()),
            executable: "/home/jovyan/.local/bin/claude".into(),
            error: None,
        };
        let server = acp_agent(
            AgentId::ClaudeCode,
            &descriptor,
            AgentPermissionProfile::Default,
            Path::new("/workspace/project"),
        )
        .expect("project ACP adapter")
        .into_server();
        let McpServer::Stdio(server) = server else {
            panic!("stdio adapter")
        };
        assert_eq!(server.command, PathBuf::from("/bin/sh"));
        assert!(
            server
                .args
                .iter()
                .any(|argument| { argument.ends_with("node_modules/.bin/claude-agent-acp") })
        );
        assert!(server.env.iter().any(|variable| {
            variable.name == "CLAUDE_CODE_EXECUTABLE"
                && variable.value == "/home/jovyan/.local/bin/claude"
        }));
    }

    #[test]
    fn validates_adapter_executables() {
        assert!(executable_path(PathBuf::from("sh")).is_some());
        assert!(executable_path(PathBuf::from("/definitely/missing/adapter")).is_none());
        assert!(local_adapter("codex-acp").is_some());
    }

    #[test]
    fn maps_acp_content_and_tool_updates_to_shared_events() {
        let text = text_event(
            AgentEventKind::TextDelta,
            ContentChunk::new(ContentBlock::Text(TextContent::new("done"))),
        )
        .expect("text event");
        assert_eq!(text.1["text"], "done");

        let tool = tool_updated(ToolCallUpdate::new(
            ToolCallId::new("tool-1"),
            ToolCallUpdateFields::new()
                .title("Shell".to_owned())
                .status(ToolCallStatus::Completed)
                .raw_output(json!({"stdout":"ok"})),
        ));
        assert_eq!(tool.0, AgentEventKind::ToolCompleted);
        assert_eq!(tool.1["tool_id"], "tool-1");

        let started = tool_started(
            ToolCall::new(ToolCallId::new("startup-1"), "MCP startup")
                .status(ToolCallStatus::Failed)
                .content(vec![
                    ContentBlock::Text(TextContent::new("connection refused")).into(),
                ]),
        );
        assert_eq!(started.1["status"], "failed");
        assert_eq!(
            started.1["content"][0]["content"]["text"],
            "connection refused"
        );
    }

    #[tokio::test]
    async fn pending_permissions_accept_only_agent_provided_options() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let runtime = AgentRuntime::new(workspace, store, Vec::new());
        let (sender, receiver) = oneshot::channel();
        runtime
            .pending_permissions
            .lock()
            .expect("pending permission mutex")
            .insert(
                "permission-1".to_owned(),
                PendingPermission {
                    allowed_options: HashSet::from(["allow_once".to_owned()]),
                    request_payload: json!({"request_id":"permission-1"}),
                    run_id: "run-1".to_owned(),
                    sender,
                },
            );

        assert!(!runtime.resolve_permission("permission-1", "invented_option"));
        assert!(runtime.resolve_permission("permission-1", "allow_once"));
        assert_eq!(
            selected_option(receiver.await.expect("permission outcome")),
            "allow_once"
        );
        assert!(!runtime.resolve_permission("permission-1", "allow_once"));
    }

    #[tokio::test]
    async fn escalating_a_team_permission_publishes_a_user_review_event() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project = workspace
            .create_project_at(temp.path().join("permission-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Review access",
                PermissionMode::Safe,
            )
            .expect("run");
        let runtime = AgentRuntime::new(workspace, Arc::clone(&store), Vec::new());
        let (sender, receiver) = oneshot::channel();
        runtime
            .pending_permissions
            .lock()
            .expect("pending permission mutex")
            .insert(
                "permission-1".to_owned(),
                PendingPermission {
                    allowed_options: HashSet::from(["allow_once".to_owned()]),
                    request_payload: json!({
                        "request_id":"permission-1",
                        "reviewer":"leader",
                        "options":[{"id":"allow_once","label":"Allow"}],
                    }),
                    run_id: run.id.clone(),
                    sender,
                },
            );

        runtime
            .escalate_team_permission("permission-1")
            .expect("escalation");

        let event = store
            .events_after(&run.id, 0)
            .expect("run events")
            .pop()
            .expect("permission event");
        assert_eq!(event.kind, AgentEventKind::PermissionRequested);
        assert_eq!(event.payload["reviewer"], "user");
        let workspace_event = store
            .workspace_events_after(0)
            .expect("workspace events")
            .into_iter()
            .find(|event| event.kind == "permission_requested")
            .expect("workspace permission event");
        assert_eq!(workspace_event.conversation_id, Some(conversation.id));
        assert_eq!(workspace_event.payload["reviewer"], "user");

        assert!(runtime.resolve_permission("permission-1", "allow_once"));
        assert_eq!(
            selected_option(receiver.await.expect("permission outcome")),
            "allow_once"
        );
    }

    #[test]
    fn failed_runs_capture_an_after_turn_checkpoint() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let project_path = temp.path().join("project");
        std::fs::create_dir_all(&project_path).expect("project directory");
        run_git(&project_path, &["init"]);
        run_git(
            &project_path,
            &["config", "user.email", "kubecode@example.test"],
        );
        run_git(&project_path, &["config", "user.name", "Kubecode Test"]);
        std::fs::write(project_path.join("README.md"), "before\n").expect("initial file");
        run_git(&project_path, &["add", "README.md"]);
        run_git(&project_path, &["commit", "-m", "initial"]);

        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project = workspace
            .import_project_at(&project_path)
            .expect("project registration");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Change the file",
                PermissionMode::Safe,
            )
            .expect("run");
        let before = workspace
            .capture_git_tree(&project_path, "before-failure")
            .expect("before checkpoint")
            .expect("git tree");
        store
            .set_run_checkpoint(&run.id, Some(&before), None)
            .expect("store before checkpoint");
        std::fs::write(project_path.join("README.md"), "after\n").expect("changed file");

        let runtime = AgentRuntime::new(workspace, Arc::clone(&store), Vec::new());
        runtime.fail_run(&run.id, "OpenCode disconnected".into());

        let checkpoint = store
            .run_checkpoint(&run.id)
            .expect("checkpoint query")
            .expect("checkpoint");
        assert!(checkpoint.after_tree.is_some());
    }

    fn run_git(path: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(path)
            .status()
            .expect("git command");
        assert!(status.success(), "git {args:?}");
    }

    fn selected_option(outcome: RequestPermissionOutcome) -> String {
        let RequestPermissionOutcome::Selected(selected) = outcome else {
            panic!("selected outcome")
        };
        selected.option_id.to_string()
    }
}
