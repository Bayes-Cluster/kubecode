use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    BooleanConfigOptionCapabilities, CancelNotification, ClientCapabilities, ClientRequest,
    ClientSessionCapabilities, ContentBlock, ContentChunk, CreateElicitationRequest,
    CreateElicitationResponse, ElicitationAcceptAction, ElicitationAction, ElicitationCapabilities,
    ElicitationContentValue, ElicitationFormCapabilities, EnvVariable, ExtRequest,
    ForkSessionRequest, InitializeRequest, ListSessionsRequest, LoadSessionRequest, McpServer,
    McpServerHttp, NewSessionRequest, NewSessionResponse, PermissionOptionId, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, SelectedPermissionOutcome, SessionConfigOptionValue,
    SessionConfigOptionsCapabilities, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, ToolCall, ToolCallStatus, ToolCallUpdate,
};
use agent_client_protocol::schema::{MaybeUndefined, ProtocolVersion};
use agent_client_protocol::{ActiveSession, Agent, ConnectTo, ConnectionTo, LineDirection, Lines};
use futures_util::StreamExt;
use futures_util::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use uuid::Uuid;

use crate::agent_discovery::{AgentCatalog, AgentDescriptor, configured_adapter_path};
use crate::agents::{
    AgentEventKind, AgentId, AgentRun, AgentStore, ConversationRelation, ConversationRelationship,
    PermissionMode, RunStatus, RuntimeRunEvent, RuntimeUpdate, StoreError,
};
use crate::composer_catalog::{
    ComposerCatalogError, ComposerContextRecord, ComposerContextSelector, ComposerDraftSegment,
    ComposerInvocation, ComposerPreflightContext, opaque_git_diff_context_id,
    validate_structured_composer_segments,
};
use crate::git::GitService;
use crate::teams::{TeamMemberStatus, TeamMode, TeamRole, TeamStatus, TeamStore};
use crate::terminal::{TerminalInfo, TerminalManager, TerminalStatus};
use crate::workspace::{WorkspaceError, WorkspaceService};

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("agent is not available: {0:?}")]
    AgentUnavailable(AgentId),
    #[error("ACP connection failed: {0}")]
    Acp(String),
    #[error("ACP connection failed during {stage}: {message}")]
    AcpStartup {
        stage: AgentStartupStage,
        message: String,
    },
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
    #[error("Claude side questions are not available for this session")]
    SideQuestionUnavailable,
    #[error("Claude side questions require an active turn")]
    SideQuestionInactive,
    #[error("another Claude side question is already pending")]
    SideQuestionPending,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStartupStage {
    ProcessSpawn,
    Initialize,
    SessionNew,
    SessionLoad,
    SessionResume,
}

impl std::fmt::Display for AgentStartupStage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ProcessSpawn => "process_spawn",
            Self::Initialize => "initialize",
            Self::SessionNew => "session_new",
            Self::SessionLoad => "session_load",
            Self::SessionResume => "session_resume",
        })
    }
}

#[derive(Clone, Debug)]
struct RuntimeFailure {
    stage: Option<AgentStartupStage>,
    message: String,
}

impl RuntimeError {
    pub fn is_native_permission_unavailable(&self) -> bool {
        matches!(self, Self::Acp(message) if message.contains("native_permission_unavailable"))
    }

    fn failure(&self) -> RuntimeFailure {
        RuntimeFailure {
            stage: match self {
                Self::AcpStartup { stage, .. } => Some(*stage),
                _ => None,
            },
            message: self.to_string(),
        }
    }

    fn from_failure(failure: RuntimeFailure) -> Self {
        match failure.stage {
            Some(stage) => Self::AcpStartup {
                stage,
                message: failure.message,
            },
            None => Self::Acp(failure.message),
        }
    }
}

#[derive(Clone, Debug)]
pub struct StartAgentRun {
    pub conversation_id: String,
    pub project_id: String,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct StartComposerCommand {
    pub conversation_id: String,
    pub project_id: String,
    pub item_id: String,
    pub catalog_revision: u64,
    pub arguments: String,
}

#[derive(Clone, Debug)]
pub struct StartStructuredComposerRun {
    pub conversation_id: String,
    pub project_id: String,
    pub item_id: Option<String>,
    pub catalog_revision: u64,
    pub segments: Vec<ComposerDraftSegment>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SideQuestionAccepted {
    pub id: String,
    pub status: &'static str,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentRuntimeSessionCounts {
    pub active: usize,
    pub idle: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct AgentRuntimeStatus {
    pub active_actor_count: usize,
    pub idle_actor_count: usize,
    pub warm_actor_limit: usize,
    pub latest_workspace_event_cursor: u64,
    pub workspace_event_delivery_available: bool,
}

#[derive(Clone)]
pub struct AgentRuntime {
    workspace: Arc<WorkspaceService>,
    git: GitService,
    store: Arc<AgentStore>,
    agents: Arc<AgentCatalog>,
    cancellations: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    sessions: Arc<Mutex<HashMap<String, SessionActorHandle>>>,
    session_generations: Arc<Mutex<HashMap<String, Arc<RwLock<String>>>>>,
    session_actor_policy: SessionActorPolicy,
    session_activity_sequence: Arc<AtomicU64>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
    pending_side_questions: Arc<Mutex<HashSet<String>>>,
    terminals: Option<Arc<TerminalManager>>,
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
    active: Arc<AtomicBool>,
    last_activity: Arc<AtomicU64>,
}

#[derive(Clone)]
struct SessionActorGeneration {
    expected: String,
    current: Arc<RwLock<String>>,
}

impl SessionActorGeneration {
    fn is_current(&self) -> bool {
        *self
            .current
            .read()
            .expect("session generation lock poisoned")
            == self.expected
    }

    fn persist_if_current(
        &self,
        operation: impl FnOnce() -> Result<(), StoreError>,
    ) -> Result<bool, StoreError> {
        let current = self
            .current
            .read()
            .expect("session generation lock poisoned");
        if *current != self.expected {
            return Ok(false);
        }
        operation()?;
        Ok(true)
    }
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

#[derive(Clone, Copy, Debug)]
struct SessionActorPolicy {
    idle_timeout: Duration,
    maximum_warm_actors: usize,
}

impl Default for SessionActorPolicy {
    fn default() -> Self {
        Self {
            idle_timeout: Duration::from_secs(2 * 60),
            maximum_warm_actors: 4,
        }
    }
}
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
        Self::with_catalog(workspace, store, AgentCatalog::from_descriptors(agents))
    }

    pub fn with_catalog(
        workspace: Arc<WorkspaceService>,
        store: Arc<AgentStore>,
        agents: Arc<AgentCatalog>,
    ) -> Self {
        let git = GitService::new(Arc::clone(&workspace));
        Self {
            workspace,
            git,
            store,
            agents,
            cancellations: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_generations: Arc::new(Mutex::new(HashMap::new())),
            session_actor_policy: SessionActorPolicy::default(),
            session_activity_sequence: Arc::new(AtomicU64::new(0)),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            pending_elicitations: Arc::new(Mutex::new(HashMap::new())),
            pending_side_questions: Arc::new(Mutex::new(HashSet::new())),
            terminals: None,
            teams: None,
            team_mcp_http: None,
        }
    }

    pub fn with_team_store(mut self, teams: Arc<TeamStore>) -> Self {
        self.teams = Some(teams);
        self
    }

    pub fn with_terminal_manager(mut self, terminals: Arc<TerminalManager>) -> Self {
        self.terminals = Some(terminals);
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

    pub fn authorize_terminal_context(
        &self,
        conversation_id: &str,
        terminal_id: &str,
    ) -> Result<(TerminalInfo, usize), RuntimeError> {
        let conversation = self.store.get_conversation(conversation_id)?;
        let terminals = self
            .terminals
            .as_ref()
            .ok_or(StoreError::Composer(ComposerCatalogError::ContextStale))?;
        let terminal = terminals
            .get(terminal_id)
            .map_err(|_| StoreError::Composer(ComposerCatalogError::ContextStale))?;
        if terminal.status != TerminalStatus::Running
            || !self.terminal_execution_context_matches(&conversation, &terminal)?
        {
            return Err(StoreError::Composer(ComposerCatalogError::ContextStale).into());
        }
        let pane_index = terminals
            .list(&conversation.project_id)
            .iter()
            .position(|candidate| candidate.id == terminal.id)
            .map(|index| index + 1)
            .ok_or(StoreError::Composer(ComposerCatalogError::ContextStale))?;
        Ok((terminal, pane_index))
    }

    pub fn resolve_terminal_composer_context(
        &self,
        conversation_id: &str,
        record: &ComposerContextRecord,
    ) -> Result<Option<ComposerPreflightContext>, RuntimeError> {
        let terminals = match self.terminals.as_ref() {
            Some(terminals) => terminals,
            None => return Ok(None),
        };
        let capture = match terminals.resolve_context_capture(&record.id, conversation_id) {
            Ok(capture) => capture,
            Err(_) => return Ok(None),
        };
        let conversation = self.store.get_conversation(conversation_id)?;
        let terminal = match terminals.get(&capture.terminal_id) {
            Ok(terminal) => terminal,
            Err(_) => return Ok(None),
        };
        if record.source_revision.as_deref() != Some(capture.source_revision.as_str())
            || !self.terminal_execution_context_matches(&conversation, &terminal)?
        {
            return Ok(None);
        }
        Ok(Some(ComposerPreflightContext {
            id: record.id.clone(),
            kind: record.kind,
            path: record.path.clone(),
            content: Some(capture.content),
        }))
    }

    fn terminal_execution_context_matches(
        &self,
        conversation: &crate::agents::Conversation,
        terminal: &TerminalInfo,
    ) -> Result<bool, RuntimeError> {
        if terminal.project_id != conversation.project_id {
            return Ok(false);
        }
        let target = self.workspace.session_execution_path(
            &conversation.project_id,
            &conversation.agent_session_id,
            conversation.execution_mode,
            conversation.workspace_path.as_deref(),
        )?;
        let terminal_path = if let Some(owner_id) = terminal.conversation_id.as_deref() {
            let owner = match self.store.get_conversation(owner_id) {
                Ok(owner) => owner,
                Err(StoreError::ConversationNotFound(_)) => return Ok(false),
                Err(error) => return Err(error.into()),
            };
            if owner.project_id != conversation.project_id {
                return Ok(false);
            }
            self.workspace.session_execution_path(
                &owner.project_id,
                &owner.agent_session_id,
                owner.execution_mode,
                owner.workspace_path.as_deref(),
            )?
        } else {
            self.workspace
                .execution_path(&conversation.project_id, None)?
        };
        Ok(target == terminal_path)
    }

    pub fn agent_available(&self, agent_id: AgentId) -> bool {
        self.agents.is_available(agent_id)
    }

    pub fn session_counts(&self) -> AgentRuntimeSessionCounts {
        let sessions = self.sessions.lock().expect("agent session mutex poisoned");
        let active = sessions
            .values()
            .filter(|handle| handle.active.load(Ordering::Acquire))
            .count();
        AgentRuntimeSessionCounts {
            active,
            idle: sessions.len().saturating_sub(active),
        }
    }

    pub fn session_actor_warm_limit(&self) -> usize {
        self.session_actor_policy.maximum_warm_actors
    }

    pub fn status(&self) -> Result<AgentRuntimeStatus, StoreError> {
        let counts = self.session_counts();
        Ok(AgentRuntimeStatus {
            active_actor_count: counts.active,
            idle_actor_count: counts.idle,
            warm_actor_limit: self.session_actor_warm_limit(),
            latest_workspace_event_cursor: self.store.latest_workspace_event_id()?,
            workspace_event_delivery_available: true,
        })
    }

    pub fn available_agents(&self) -> Vec<AgentDescriptor> {
        self.agents.descriptors()
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

    pub fn start_acp_command(&self, request: StartAgentRun) -> Result<AgentRun, RuntimeError> {
        self.start_with_visibility(request, true)
    }

    pub fn start_composer_command(
        &self,
        request: StartComposerCommand,
    ) -> Result<AgentRun, RuntimeError> {
        let conversation = self.store.get_conversation(&request.conversation_id)?;
        if conversation.project_id != request.project_id {
            return Err(StoreError::ConversationNotFound(request.conversation_id).into());
        }
        let descriptor = self
            .agents
            .descriptor(conversation.agent_id)
            .filter(|agent| agent.available)
            .ok_or(RuntimeError::AgentUnavailable(conversation.agent_id))?;
        let cwd = self
            .workspace
            .execution_path(&request.project_id, conversation.workspace_path.as_deref())?;
        let dispatch = self.store.start_typed_composer_command_dispatch(
            &request.conversation_id,
            &request.project_id,
            &request.item_id,
            request.catalog_revision,
            &request.arguments,
            PermissionMode::Safe,
        )?;
        let run = dispatch.run;
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
                    dispatch.prompt_message
                )
            })
            .unwrap_or(dispatch.prompt_message);
        let command = AgentCommand {
            run: run.clone(),
            message: agent_message,
            provider_input: dispatch.provider_input.map(Box::new),
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

    pub fn start_structured_composer(
        &self,
        request: StartStructuredComposerRun,
    ) -> Result<AgentRun, RuntimeError> {
        self.start_structured_composer_before_store(request, || {})
    }

    fn start_structured_composer_before_store(
        &self,
        request: StartStructuredComposerRun,
        before_store: impl FnOnce(),
    ) -> Result<AgentRun, RuntimeError> {
        let conversation = self.store.get_conversation(&request.conversation_id)?;
        if conversation.project_id != request.project_id {
            return Err(StoreError::ConversationNotFound(request.conversation_id).into());
        }
        validate_structured_composer_segments(&request.segments).map_err(StoreError::Composer)?;
        let descriptor = self
            .agents
            .descriptor(conversation.agent_id)
            .filter(|agent| agent.available)
            .ok_or(RuntimeError::AgentUnavailable(conversation.agent_id))?;
        let cwd = self.workspace.session_execution_path(
            &request.project_id,
            &conversation.agent_session_id,
            conversation.execution_mode,
            conversation.workspace_path.as_deref(),
        )?;
        let selectors = request
            .segments
            .iter()
            .filter_map(|segment| match segment {
                ComposerDraftSegment::ContextRef {
                    id,
                    catalog_revision,
                    context_kind,
                } => Some(ComposerContextSelector {
                    id: id.clone(),
                    catalog_revision: *catalog_revision,
                    context_kind: *context_kind,
                }),
                ComposerDraftSegment::Text { .. } | ComposerDraftSegment::CapabilityRef { .. } => {
                    None
                }
            })
            .collect::<Vec<_>>();
        before_store();
        let records = self.store.composer_context_records_for_preflight(
            &conversation.id,
            &conversation.project_id,
            &selectors,
        )?;
        let mut preflight = Vec::with_capacity(records.len());
        for (selector, record) in selectors.iter().zip(records) {
            let record = record.ok_or(StoreError::Composer(ComposerCatalogError::ContextStale))?;
            if record.kind != selector.context_kind {
                return Err(StoreError::Composer(ComposerCatalogError::ContextStale).into());
            }
            let expected_kind = match record.kind {
                crate::composer_catalog::ComposerContextKind::File => {
                    Some(crate::workspace::EntryKind::File)
                }
                crate::composer_catalog::ComposerContextKind::Directory => {
                    Some(crate::workspace::EntryKind::Directory)
                }
                crate::composer_catalog::ComposerContextKind::GitDiff
                | crate::composer_catalog::ComposerContextKind::Terminal => None,
                _ => return Err(StoreError::Composer(ComposerCatalogError::ItemUnsupported).into()),
            };
            if let Some(expected_kind) = expected_kind {
                let resolved = match self.workspace.resolve_session_context_entry(
                    &conversation.project_id,
                    &conversation.agent_session_id,
                    conversation.execution_mode,
                    conversation.workspace_path.as_deref(),
                    &record.path,
                    expected_kind,
                ) {
                    Ok(resolved) => resolved,
                    Err(error @ WorkspaceError::ProjectNotFound(_)) => return Err(error.into()),
                    Err(_) => {
                        return Err(StoreError::Composer(ComposerCatalogError::ContextStale).into());
                    }
                };
                preflight.push(ComposerPreflightContext {
                    id: record.id,
                    kind: record.kind,
                    path: resolved.path,
                    content: None,
                });
            } else if record.kind == crate::composer_catalog::ComposerContextKind::GitDiff {
                let path = (record.path != ".").then_some(record.path.as_str());
                let snapshot = self
                    .git
                    .resolve_composer_diff_blocking(
                        &conversation.project_id,
                        &conversation.agent_session_id,
                        conversation.execution_mode,
                        conversation.workspace_path.as_deref(),
                        path,
                    )
                    .map_err(|_| StoreError::Composer(ComposerCatalogError::ContextStale))?;
                let expected_id = opaque_git_diff_context_id(
                    &conversation.project_id,
                    &conversation.id,
                    &record.path,
                    &snapshot.source_revision,
                );
                if expected_id != record.id
                    || record.source_revision.as_deref() != Some(snapshot.source_revision.as_str())
                {
                    return Err(StoreError::Composer(ComposerCatalogError::ContextStale).into());
                }
                preflight.push(ComposerPreflightContext {
                    id: record.id,
                    kind: record.kind,
                    path: record.path,
                    content: Some(snapshot.content),
                });
            } else {
                let resolved = self
                    .resolve_terminal_composer_context(&conversation.id, &record)?
                    .ok_or(StoreError::Composer(ComposerCatalogError::ContextStale))?;
                preflight.push(resolved);
            }
        }
        let dispatch = self.store.start_structured_composer_run_dispatch(
            &conversation.id,
            &conversation.project_id,
            request.item_id.as_deref(),
            request.catalog_revision,
            &request.segments,
            &preflight,
            PermissionMode::Safe,
        )?;
        let run = dispatch.run;
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
                    dispatch.prompt_message
                )
            })
            .unwrap_or(dispatch.prompt_message);
        let command = AgentCommand {
            run: run.clone(),
            message: agent_message,
            provider_input: dispatch.provider_input.map(Box::new),
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
            .descriptor(conversation.agent_id)
            .filter(|agent| agent.available)
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
            provider_input: None,
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
            .map_err(RuntimeError::from_failure)
    }

    pub async fn initialize_conversation_ephemeral(
        &self,
        conversation_id: &str,
    ) -> Result<(), RuntimeError> {
        self.initialize_conversation(conversation_id).await?;
        self.disconnect_conversation(conversation_id).await
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

    pub async fn reconnect_conversation_ephemeral(
        &self,
        conversation_id: &str,
    ) -> Result<(), RuntimeError> {
        self.disconnect_conversation(conversation_id).await?;
        self.initialize_conversation_ephemeral(conversation_id)
            .await
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
        let update_journal =
            SessionUpdateJournal::spawn(Arc::clone(&self.store), conversation.id.clone());
        let notification_journal = update_journal.sink();
        let history_journal = update_journal.sink();
        let state_store = Arc::clone(&self.store);
        let state_conversation_id = conversation.id;
        let result = agent_client_protocol::Client
            .builder()
            .name("Kubecode")
            .on_receive_notification(
                async move |notification: SessionNotification, _connection| {
                    notification_journal
                        .enqueue(None, notification.update)
                        .await
                        .map_err(journal_protocol_error)?;
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
                    None,
                )?;
                let response = connection
                    .send_request(LoadSessionRequest::new(provider_session_id, cwd))
                    .block_task()
                    .await?;
                history_journal
                    .flush()
                    .await
                    .map_err(journal_protocol_error)?;
                persist_serialized_session_state_checkpoint(
                    &state_store,
                    &state_conversation_id,
                    "session_loaded",
                    response,
                    None,
                )?;
                Ok(())
            })
            .await;
        let shutdown = update_journal.shutdown().await;
        finish_journal(result, shutdown).map_err(RuntimeError::Acp)
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
        let starts_run = matches!(&command, SessionCommand::Prompt(_));
        let activity = self.next_session_activity();
        let existing = self
            .sessions
            .lock()
            .expect("agent session mutex poisoned")
            .get(&config.conversation_id)
            .cloned();
        let command = if let Some(handle) = existing {
            handle.last_activity.store(activity, Ordering::Release);
            if starts_run {
                handle.active.store(true, Ordering::Release);
            }
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
        let generation_guard = {
            let mut generations = self
                .session_generations
                .lock()
                .expect("session generation registry mutex poisoned");
            let current = Arc::clone(
                generations
                    .entry(config.conversation_id.clone())
                    .or_insert_with(|| Arc::new(RwLock::new(String::new()))),
            );
            *current.write().expect("session generation lock poisoned") = generation.clone();
            SessionActorGeneration {
                expected: generation.clone(),
                current,
            }
        };
        let active = Arc::new(AtomicBool::new(starts_run));
        let last_activity = Arc::new(AtomicU64::new(activity));
        self.sessions
            .lock()
            .expect("agent session mutex poisoned")
            .insert(
                config.conversation_id.clone(),
                SessionActorHandle {
                    generation: generation.clone(),
                    sender,
                    active: Arc::clone(&active),
                    last_activity: Arc::clone(&last_activity),
                },
            );
        self.enforce_warm_actor_limit(Some(&config.conversation_id));
        let runtime = self.clone();
        tokio::spawn(async move {
            let conversation_id = config.conversation_id.clone();
            runtime
                .run_session_actor(config, receiver, active, last_activity, generation_guard)
                .await;
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
            drop(sessions);
            let mut generations = runtime
                .session_generations
                .lock()
                .expect("session generation registry mutex poisoned");
            if generations.get(&conversation_id).is_some_and(|current| {
                *current.read().expect("session generation lock poisoned") == generation
            }) {
                generations.remove(&conversation_id);
            }
        });
    }

    fn next_session_activity(&self) -> u64 {
        self.session_activity_sequence
            .fetch_add(1, Ordering::AcqRel)
            + 1
    }

    fn enforce_warm_actor_limit(&self, protected_conversation_id: Option<&str>) {
        let mut shutdown = Vec::new();
        {
            let mut sessions = self.sessions.lock().expect("agent session mutex poisoned");
            let mut idle = sessions
                .iter()
                .filter(|(conversation_id, handle)| {
                    !handle.active.load(Ordering::Acquire)
                        && protected_conversation_id != Some(conversation_id.as_str())
                })
                .map(|(conversation_id, handle)| {
                    (
                        conversation_id.clone(),
                        handle.last_activity.load(Ordering::Acquire),
                    )
                })
                .collect::<Vec<_>>();
            let protected_idle = protected_conversation_id
                .and_then(|id| sessions.get(id))
                .is_some_and(|handle| !handle.active.load(Ordering::Acquire));
            let warm_count = idle.len() + usize::from(protected_idle);
            if warm_count <= self.session_actor_policy.maximum_warm_actors {
                return;
            }
            idle.sort_by_key(|(_, activity)| *activity);
            for (conversation_id, _) in idle
                .into_iter()
                .take(warm_count - self.session_actor_policy.maximum_warm_actors)
            {
                if let Some(handle) = sessions.remove(&conversation_id) {
                    shutdown.push(handle.sender);
                }
            }
        }
        for sender in shutdown {
            let (response, _disconnected) = oneshot::channel();
            let _ = sender.send(SessionCommand::Shutdown { response });
        }
    }

    async fn run_session_actor(
        &self,
        config: AgentSessionConfig,
        mut receiver: mpsc::UnboundedReceiver<SessionCommand>,
        active: Arc<AtomicBool>,
        last_activity: Arc<AtomicU64>,
        generation: SessionActorGeneration,
    ) {
        let active_run_id = Arc::new(Mutex::new(None));
        let result = run_acp_session(
            self.clone(),
            config,
            &mut receiver,
            Arc::clone(&active_run_id),
            Arc::clone(&active),
            Arc::clone(&last_activity),
            generation,
        )
        .await;
        active.store(false, Ordering::Release);
        if let Err(error) = result {
            let failure = error.failure();
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
                    | SessionCommand::SetConfig { response, .. } => {
                        let _ = response.send(Err(error.to_string()));
                    }
                    SessionCommand::SideQuestion { response, .. } => {
                        let _ = response.send(Err(RuntimeError::Acp(error.to_string())));
                    }
                    SessionCommand::Ready { response } => {
                        let _ = response.send(Err(failure.clone()));
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
            .descriptor(agent_id)
            .filter(|agent| agent.available)
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

    pub async fn ask_side_question(
        &self,
        conversation_id: &str,
        question: String,
    ) -> Result<SideQuestionAccepted, RuntimeError> {
        let conversation = self.store.get_conversation(conversation_id)?;
        if conversation.agent_id != AgentId::ClaudeCode
            || !side_question_capability(&self.store, conversation_id)
        {
            return Err(RuntimeError::SideQuestionUnavailable);
        }
        let active = self
            .store
            .list_runs(conversation_id)?
            .into_iter()
            .rev()
            .any(|run| {
                matches!(
                    run.status,
                    RunStatus::Running | RunStatus::WaitingPermission
                )
            });
        if !active {
            return Err(RuntimeError::SideQuestionInactive);
        }
        {
            let mut pending = self
                .pending_side_questions
                .lock()
                .expect("pending side question mutex poisoned");
            if !pending.insert(conversation_id.to_owned()) {
                return Err(RuntimeError::SideQuestionPending);
            }
        }

        let config = match self.session_config(conversation_id) {
            Ok(config) => config,
            Err(error) => {
                self.finish_side_question(conversation_id);
                return Err(error);
            }
        };
        let (response, accepted) = oneshot::channel();
        self.dispatch(
            config,
            SessionCommand::SideQuestion {
                id: Uuid::new_v4().to_string(),
                question,
                response,
            },
        );
        match accepted.await {
            Ok(Ok(accepted)) => Ok(accepted),
            Ok(Err(error)) => {
                self.finish_side_question(conversation_id);
                Err(error)
            }
            Err(_) => {
                self.finish_side_question(conversation_id);
                Err(RuntimeError::Acp("session connection closed".into()))
            }
        }
    }

    fn finish_side_question(&self, conversation_id: &str) {
        self.pending_side_questions
            .lock()
            .expect("pending side question mutex poisoned")
            .remove(conversation_id);
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
type StartupStageCapture = Arc<Mutex<Option<AgentStartupStage>>>;

struct AgentCommand {
    run: AgentRun,
    message: String,
    provider_input: Option<Box<ComposerInvocation>>,
    cancelled: oneshot::Receiver<()>,
}

fn prompt_request_for_command(session_id: &SessionId, command: &AgentCommand) -> PromptRequest {
    let mut request = PromptRequest::new(session_id.clone(), vec![command.message.clone().into()]);
    if let Some(ComposerInvocation::ProviderStructuredInput {
        adapter_kind,
        payload,
    }) = command.provider_input.as_deref()
    {
        request.meta = json!({
            "kubecode": {
                "providerStructuredInput": {
                    "adapterKind": adapter_kind,
                    "payload": payload,
                }
            }
        })
        .as_object()
        .cloned();
    }
    request
}

enum SessionCommand {
    Prompt(AgentCommand),
    Ready {
        response: oneshot::Sender<Result<(), RuntimeFailure>>,
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
    SideQuestion {
        id: String,
        question: String,
        response: oneshot::Sender<Result<SideQuestionAccepted, RuntimeError>>,
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
    journal: &SessionUpdateSink,
) -> Option<AgentCommand> {
    match command {
        SessionCommand::Prompt(command) => Some(command),
        SessionCommand::Ready { response } => {
            let _ = response.send(Ok(()));
            None
        }
        SessionCommand::SetMode { mode_id, response } => {
            let selected_mode = mode_id.clone();
            let result = match connection
                .send_request(SetSessionModeRequest::new(session_id.clone(), mode_id))
                .block_task()
                .await
            {
                Ok(_) => match journal.flush().await {
                    Ok(()) => persist_serialized_session_state_checkpoint(
                        store,
                        conversation_id,
                        "current_mode",
                        json!({"currentModeId":selected_mode}),
                        journal.generation.as_ref(),
                    )
                    .map_err(|error| error.to_string()),
                    Err(error) => Err(error.to_string()),
                },
                Err(error) => Err(error.to_string()),
            };
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
            let result = match connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    config_id,
                    value,
                ))
                .block_task()
                .await
            {
                Ok(update) => match journal.flush().await {
                    Ok(()) => persist_serialized_session_state_checkpoint(
                        store,
                        conversation_id,
                        "config_options",
                        update,
                        journal.generation.as_ref(),
                    )
                    .map_err(|error| error.to_string()),
                    Err(error) => Err(error.to_string()),
                },
                Err(error) => Err(error.to_string()),
            };
            let _ = response.send(result);
            None
        }
        SessionCommand::SideQuestion { response, .. } => {
            let _ = response.send(Err(RuntimeError::SideQuestionInactive));
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
    actor_active: Arc<AtomicBool>,
    last_activity: Arc<AtomicU64>,
    generation: SessionActorGeneration,
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
    let update_journal = SessionUpdateJournal::spawn_guarded(
        Arc::clone(&runtime.store),
        config.conversation_id.clone(),
        generation.clone(),
    );
    let notification_journal = update_journal.sink();
    let permission_journal = update_journal.sink();
    let elicitation_journal = update_journal.sink();
    let connection_journal = update_journal.sink();
    let update_run_id = Arc::clone(&active_run_id);
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
    let startup_stage = Arc::new(Mutex::new(Some(AgentStartupStage::ProcessSpawn)));
    let connection_stage = Arc::clone(&startup_stage);

    let result = agent_client_protocol::Client
        .builder()
        .name("Kubecode")
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                let run_id = update_run_id
                    .lock()
                    .expect("active run mutex poisoned")
                    .clone();
                notification_journal
                    .enqueue(run_id, notification.update)
                    .await
                    .map_err(journal_protocol_error)?;
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                permission_journal
                    .flush()
                    .await
                    .map_err(journal_protocol_error)?;
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
                elicitation_journal
                    .flush()
                    .await
                    .map_err(journal_protocol_error)?;
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
            set_startup_stage(&connection_stage, AgentStartupStage::Initialize);
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
                Some(&generation),
            )?;
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
                    set_startup_stage(&connection_stage, AgentStartupStage::SessionLoad);
                    let response = connection
                        .send_request(
                            LoadSessionRequest::new(session_id.clone(), cwd.clone())
                                .mcp_servers(team_mcp_http.clone().into_iter().collect()),
                        )
                        .block_task()
                        .await?;
                    connection_journal
                        .flush()
                        .await
                        .map_err(journal_protocol_error)?;
                    persist_serialized_session_state_checkpoint(
                        &store,
                        &conversation_id,
                        "session_loaded",
                        response,
                        Some(&generation),
                    )?;
                    (session_id.into(), None)
                } else {
                    let resumed = if initialization
                    .agent_capabilities
                    .session_capabilities
                    .resume
                    .is_some()
                    {
                        set_startup_stage(&connection_stage, AgentStartupStage::SessionResume);
                        match connection
                            .send_request(
                                ResumeSessionRequest::new(session_id.clone(), cwd.clone())
                                    .mcp_servers(team_mcp_http.clone().into_iter().collect()),
                            )
                            .block_task()
                            .await
                        {
                            Ok(response) => {
                                connection_journal
                                    .flush()
                                    .await
                                    .map_err(journal_protocol_error)?;
                                persist_serialized_session_event(
                                    &store,
                                    &conversation_id,
                                    "session_resumed",
                                    response,
                                    Some(&generation),
                                )?;
                                true
                            }
                            Err(_) => false,
                        }
                    } else {
                        false
                    };
                    if resumed {
                        (session_id.into(), None)
                    } else {
                        set_startup_stage(&connection_stage, AgentStartupStage::SessionLoad);
                        match connection
                            .send_request(LoadSessionRequest::new(
                                session_id.clone(),
                                cwd.clone(),
                            ).mcp_servers(team_mcp_http.clone().into_iter().collect()))
                            .block_task()
                            .await
                        {
                            Ok(response) => {
                                connection_journal
                                    .flush()
                                    .await
                                    .map_err(journal_protocol_error)?;
                                persist_serialized_session_state_checkpoint(
                                    &store,
                                    &conversation_id,
                                    "session_loaded",
                                    response,
                                    Some(&generation),
                                )?;
                                (session_id.into(), None)
                            }
                            Err(_) => {
                                create_provider_session(
                                    &connection,
                                    cwd,
                                    ProviderSessionCreation {
                                        runtime: &runtime,
                                        conversation_id: &conversation_id,
                                        team_mcp_http: team_mcp_http.clone(),
                                        captured_responses: &captured_session_responses,
                                        startup_stage: &connection_stage,
                                        journal: &connection_journal,
                                        generation: &generation,
                                    },
                                )
                                .await?
                            }
                        }
                    }
                }
            } else {
                create_provider_session(
                    &connection,
                    cwd,
                    ProviderSessionCreation {
                        runtime: &runtime,
                        conversation_id: &conversation_id,
                        team_mcp_http,
                        captured_responses: &captured_session_responses,
                        startup_stage: &connection_stage,
                        journal: &connection_journal,
                        generation: &generation,
                    },
                )
                .await?
            };
            connection_journal
                .flush()
                .await
                .map_err(journal_protocol_error)?;
            let provider_session_id = session_id.to_string();
            let persisted = generation
                .persist_if_current(|| {
                    store.set_provider_session(&conversation_id, &provider_session_id)
                })
                .map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
            if !persisted {
                return Err(agent_client_protocol::Error::internal_error()
                    .data("stale session actor generation"));
            }
            apply_native_permission_profile(
                &connection,
                &session_id,
                config.agent_id,
                config.permission_profile,
            )
            .await?;
            *connection_stage
                .lock()
                .expect("startup stage capture poisoned") = None;
            loop {
                let command =
                    match tokio::time::timeout(
                        runtime.session_actor_policy.idle_timeout,
                        receiver.recv(),
                    )
                    .await
                    {
                        Ok(Some(command)) => command,
                        Ok(None) | Err(_) => break,
                    };
                last_activity.store(runtime.next_session_activity(), Ordering::Release);
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
                    &connection_journal,
                )
                .await
                else {
                    continue;
                };
                actor_active.store(true, Ordering::Release);
                *active_run_id.lock().expect("active run mutex poisoned") =
                    Some(command.run.id.clone());
                let prompt_request = prompt_request_for_command(&session_id, &command);
                let mut cancelled = command.cancelled;
                let prompt = connection.send_request(prompt_request).block_task();
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
                                let next = match next {
                                    SessionCommand::Shutdown { response } => {
                                        connection.send_notification(CancelNotification::new(session_id.clone()))?;
                                        shutdown_response = Some(response);
                                        break AcpRunOutcome::Cancelled;
                                    }
                                    SessionCommand::SideQuestion { id, question, response } => {
                                        connection_journal
                                            .flush()
                                            .await
                                            .map_err(journal_protocol_error)?;
                                        start_side_question(
                                            &runtime,
                                            &connection,
                                            &session_id,
                                            &command.run,
                                            id,
                                            question,
                                            response,
                                        );
                                        continue;
                                    }
                                    next => next,
                                };
                                if let Some(queued_prompt) = process_session_control(
                                    &connection,
                                    &session_id,
                                    next,
                                    &runtime.store,
                                    &conversation_id,
                                    &connection_journal,
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
                connection_journal
                    .flush()
                    .await
                    .map_err(journal_protocol_error)?;
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
                actor_active.store(false, Ordering::Release);
                last_activity.store(runtime.next_session_activity(), Ordering::Release);
                runtime.enforce_warm_actor_limit(Some(&conversation_id));
                runtime.wake_team_member_for_conversation(&conversation_id);
                if let Some(response) = shutdown_response {
                    let _ = response.send(());
                    break;
                }
            }
            Ok(())
        })
        .await;

    let shutdown = update_journal.shutdown().await;
    finish_journal(result, shutdown).map_err(|error| {
        let message = error.to_string();
        match *startup_stage
            .lock()
            .expect("startup stage capture poisoned")
        {
            Some(stage) => RuntimeError::AcpStartup { stage, message },
            None => RuntimeError::Acp(message),
        }
    })
}

fn start_side_question(
    runtime: &AgentRuntime,
    connection: &ConnectionTo<Agent>,
    session_id: &agent_client_protocol::schema::v1::SessionId,
    run: &AgentRun,
    id: String,
    question: String,
    response: oneshot::Sender<Result<SideQuestionAccepted, RuntimeError>>,
) {
    let payload = json!({"id":id, "run_id":run.id, "question":question});
    if let Err(error) = runtime
        .store
        .append_session_event(&run.conversation_id, "side_question_started", &payload)
        .and_then(|_| {
            runtime.store.append_workspace_event(
                "side_question_started",
                Some(&run.project_id),
                Some(&run.conversation_id),
                Some(&run.id),
                &payload,
            )
        })
    {
        runtime.finish_side_question(&run.conversation_id);
        let _ = response.send(Err(RuntimeError::Store(error)));
        return;
    }
    let _ = response.send(Ok(SideQuestionAccepted {
        id: id.clone(),
        status: "pending",
    }));

    let runtime = runtime.clone();
    let connection = connection.clone();
    let session_id = session_id.clone();
    let run = run.clone();
    tokio::spawn(async move {
        let params = serde_json::value::to_raw_value(&json!({
            "sessionId":session_id,
            "question":question,
        }));
        let result = match params {
            Ok(params) => connection
                .send_request(ClientRequest::ExtMethodRequest(ExtRequest::new(
                    "_claude/side_question",
                    params.into(),
                )))
                .block_task()
                .await
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        let (kind, payload) = match result {
            Ok(value) => {
                let answer = value
                    .get("response")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if answer.is_empty() {
                    (
                        "side_question_failed",
                        json!({
                            "id":id,
                            "run_id":run.id,
                            "question":question,
                            "message":"Claude returned an empty side-question response",
                        }),
                    )
                } else {
                    (
                        "side_question_completed",
                        json!({
                            "id":id,
                            "run_id":run.id,
                            "question":question,
                            "answer":answer,
                            "synthetic":value.get("synthetic").cloned().unwrap_or(Value::Null),
                        }),
                    )
                }
            }
            Err(message) => (
                "side_question_failed",
                json!({
                    "id":id,
                    "run_id":run.id,
                    "question":question,
                    "message":message,
                }),
            ),
        };
        let _ = runtime
            .store
            .append_session_event(&run.conversation_id, kind, &payload);
        let _ = runtime.store.append_workspace_event(
            kind,
            Some(&run.project_id),
            Some(&run.conversation_id),
            Some(&run.id),
            &payload,
        );
        runtime.finish_side_question(&run.conversation_id);
    });
}

fn side_question_capability(store: &AgentStore, conversation_id: &str) -> bool {
    store
        .session_events_after(conversation_id, 0)
        .ok()
        .and_then(|events| {
            events
                .into_iter()
                .rev()
                .find(|event| event.kind == "capabilities")
                .map(|event| event.payload)
        })
        .and_then(|payload| payload.get("_meta").cloned())
        .and_then(|meta| meta.get("claudeCode").cloned())
        .and_then(|claude| claude.get("sideQuestion").cloned())
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

struct ProviderSessionCreation<'a> {
    runtime: &'a AgentRuntime,
    team_mcp_http: Option<McpServer>,
    conversation_id: &'a str,
    captured_responses: &'a SessionResponseCapture,
    startup_stage: &'a StartupStageCapture,
    journal: &'a SessionUpdateSink,
    generation: &'a SessionActorGeneration,
}

async fn create_provider_session(
    connection: &ConnectionTo<Agent>,
    cwd: PathBuf,
    context: ProviderSessionCreation<'_>,
) -> Result<
    (
        agent_client_protocol::schema::v1::SessionId,
        Option<ActiveSession<'static, Agent>>,
    ),
    agent_client_protocol::Error,
> {
    let ProviderSessionCreation {
        runtime,
        team_mcp_http,
        conversation_id,
        captured_responses,
        startup_stage,
        journal,
        generation,
    } = context;
    set_startup_stage(startup_stage, AgentStartupStage::SessionNew);
    if let Some(mcp_server) = team_mcp_http {
        let response = connection
            .send_request(NewSessionRequest::new(cwd).mcp_servers(vec![mcp_server]))
            .block_task()
            .await?;
        let session_id = response.session_id.clone();
        let _ = take_captured_session_response(captured_responses, &session_id);
        journal.flush().await.map_err(journal_protocol_error)?;
        persist_serialized_session_state_checkpoint(
            &runtime.store,
            conversation_id,
            "session_created_state",
            response,
            Some(generation),
        )?;
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
        journal.flush().await.map_err(journal_protocol_error)?;
        persist_serialized_session_state_checkpoint(
            &runtime.store,
            conversation_id,
            "session_created_state",
            response,
            Some(generation),
        )?;
        return Ok((session_id, Some(active_session)));
    }
    let response = connection
        .send_request(NewSessionRequest::new(cwd))
        .block_task()
        .await?;
    let session_id = response.session_id.clone();
    let _ = take_captured_session_response(captured_responses, &session_id);
    journal.flush().await.map_err(journal_protocol_error)?;
    persist_serialized_session_state_checkpoint(
        &runtime.store,
        conversation_id,
        "session_created_state",
        response,
        Some(generation),
    )?;
    Ok((session_id, None))
}

fn set_startup_stage(capture: &StartupStageCapture, stage: AgentStartupStage) {
    *capture.lock().expect("startup stage capture poisoned") = Some(stage);
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

type AcpDebugCallback = Arc<dyn Fn(&str, LineDirection) + Send + Sync + 'static>;

struct TokioStdioAcpAgent {
    command: PathBuf,
    args: Vec<String>,
    environment: Vec<EnvVariable>,
    debug_callback: Option<AcpDebugCallback>,
}

impl TokioStdioAcpAgent {
    fn with_debug(
        mut self,
        callback: impl Fn(&str, LineDirection) + Send + Sync + 'static,
    ) -> Self {
        self.debug_callback = Some(Arc::new(callback));
        self
    }
}

impl ConnectTo<agent_client_protocol::Client> for TokioStdioAcpAgent {
    async fn connect_to(
        self,
        client: impl ConnectTo<Agent>,
    ) -> Result<(), agent_client_protocol::Error> {
        let mut command = tokio::process::Command::new(&self.command);
        command
            .args(&self.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for variable in &self.environment {
            command.env(&variable.name, &variable.value);
        }
        let mut child = command.spawn().map_err(|error| {
            agent_client_protocol::Error::internal_error().data(error.to_string())
        })?;
        let child_stdin = child.stdin.take().ok_or_else(|| {
            agent_client_protocol::Error::internal_error().data("Failed to open agent stdin")
        })?;
        let child_stdout = child.stdout.take().ok_or_else(|| {
            agent_client_protocol::Error::internal_error().data("Failed to open agent stdout")
        })?;
        let child_stderr = child.stderr.take().ok_or_else(|| {
            agent_client_protocol::Error::internal_error().data("Failed to open agent stderr")
        })?;

        let stdout_callback = self.debug_callback.clone();
        let incoming = BufReader::new(child_stdout.compat())
            .lines()
            .inspect(move |line| {
                if let (Some(callback), Ok(line)) = (&stdout_callback, line) {
                    callback(line, LineDirection::Stdout);
                }
            });
        let stdin_callback = self.debug_callback.clone();
        let outgoing = futures_util::sink::unfold(
            child_stdin.compat_write(),
            move |mut stdin, line: String| {
                let callback = stdin_callback.clone();
                async move {
                    if let Some(callback) = callback {
                        callback(&line, LineDirection::Stdin);
                    }
                    stdin.write_all(line.as_bytes()).await?;
                    stdin.write_all(b"\n").await?;
                    stdin.flush().await?;
                    Ok::<_, std::io::Error>(stdin)
                }
            },
        );

        let stderr_callback = self.debug_callback;
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(child_stderr.compat()).lines();
            let mut collected = String::new();
            while let Some(line) = lines.next().await {
                let Ok(line) = line else { break };
                if let Some(callback) = &stderr_callback {
                    callback(&line, LineDirection::Stderr);
                }
                if !collected.is_empty() {
                    collected.push('\n');
                }
                collected.push_str(&line);
            }
            collected
        });

        let protocol = ConnectTo::<agent_client_protocol::Client>::connect_to(
            Lines::new(outgoing, incoming),
            client,
        );
        tokio::pin!(protocol);
        let result = tokio::select! {
            result = &mut protocol => {
                let _ = child.kill().await;
                result
            }
            status = child.wait() => {
                match status {
                    Ok(status) if status.success() => Ok(()),
                    Ok(status) => {
                        let stderr = stderr_task.await.unwrap_or_default();
                        let detail = if stderr.is_empty() {
                            format!("Agent process exited with {status}")
                        } else {
                            format!("Agent process exited with {status}: {stderr}")
                        };
                        return Err(agent_client_protocol::Error::internal_error().data(detail));
                    }
                    Err(error) => return Err(
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    ),
                }
            }
        };
        stderr_task.abort();
        result
    }
}

fn acp_agent(
    agent_id: AgentId,
    descriptor: &AgentDescriptor,
    permission_profile: AgentPermissionProfile,
    cwd: &Path,
) -> Result<TokioStdioAcpAgent, RuntimeError> {
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
    let _ = name;
    Ok(TokioStdioAcpAgent {
        command: PathBuf::from("/bin/sh"),
        args: launcher_args,
        environment: agent_environment,
        debug_callback: None,
    })
}

fn configured_adapter(
    agent: AgentId,
    variable: &'static str,
    default: &str,
) -> Result<PathBuf, RuntimeError> {
    configured_adapter_path(variable, default).ok_or_else(|| RuntimeError::AdapterUnavailable {
        agent,
        binary: env::var_os(variable)
            .unwrap_or_else(|| default.into())
            .to_string_lossy()
            .into_owned(),
        variable,
    })
}

#[derive(Debug)]
struct PersistedSessionUpdate {
    session_kind: &'static str,
    run_kind: Option<AgentEventKind>,
    payload: Value,
    publish_session_state: bool,
    title_update: Option<SessionTitleUpdate>,
}

#[derive(Clone, Debug)]
enum SessionTitleUpdate {
    IfUntitled(String),
    Provider(String),
}

#[derive(Debug)]
struct PendingSessionUpdate {
    run_id: Option<String>,
    event: PersistedSessionUpdate,
}

enum SessionJournalCommand {
    Update(PendingSessionUpdate),
    Flush(oneshot::Sender<Result<(), String>>),
    Shutdown,
}

const SESSION_UPDATE_FLUSH_INTERVAL: Duration = Duration::from_millis(33);
const SESSION_UPDATE_CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Error)]
enum SessionJournalError {
    #[error("Session update journal is closed")]
    Closed,
    #[error("Session update persistence failed: {0}")]
    Persistence(String),
    #[error("Session update journal task failed: {0}")]
    Worker(String),
}

struct SessionJournalSender {
    sender: mpsc::Sender<SessionJournalCommand>,
    accepting: tokio::sync::Mutex<bool>,
}

#[derive(Clone)]
struct SessionUpdateSink {
    sender: Arc<SessionJournalSender>,
    conversation_id: Arc<str>,
    generation: Option<SessionActorGeneration>,
}

struct SessionUpdateJournal {
    sink: SessionUpdateSink,
    worker: tokio::task::JoinHandle<Result<(), StoreError>>,
}

impl SessionUpdateJournal {
    fn spawn(store: Arc<AgentStore>, conversation_id: String) -> Self {
        Self::spawn_with_generation(store, conversation_id, None)
    }

    fn spawn_guarded(
        store: Arc<AgentStore>,
        conversation_id: String,
        generation: SessionActorGeneration,
    ) -> Self {
        Self::spawn_with_generation(store, conversation_id, Some(generation))
    }

    fn spawn_with_generation(
        store: Arc<AgentStore>,
        conversation_id: String,
        generation: Option<SessionActorGeneration>,
    ) -> Self {
        let (sender, mut receiver) = mpsc::channel(SESSION_UPDATE_CHANNEL_CAPACITY);
        let sink = SessionUpdateSink {
            sender: Arc::new(SessionJournalSender {
                sender,
                accepting: tokio::sync::Mutex::new(true),
            }),
            conversation_id: Arc::from(conversation_id),
            generation: generation.clone(),
        };
        let worker_conversation_id = Arc::clone(&sink.conversation_id);
        let worker = tokio::spawn(async move {
            let mut pending = Vec::<PendingSessionUpdate>::new();
            let mut flush_deadline = None;
            loop {
                let command = if let Some(deadline) = flush_deadline {
                    match tokio::time::timeout_at(deadline, receiver.recv()).await {
                        Ok(command) => command,
                        Err(_) => {
                            persist_pending_updates(
                                &store,
                                &worker_conversation_id,
                                &mut pending,
                                generation.as_ref(),
                            )?;
                            flush_deadline = None;
                            continue;
                        }
                    }
                } else {
                    receiver.recv().await
                };
                match command {
                    Some(SessionJournalCommand::Update(update)) => {
                        if update.event.is_streaming() {
                            if pending.is_empty() {
                                flush_deadline = Some(
                                    tokio::time::Instant::now() + SESSION_UPDATE_FLUSH_INTERVAL,
                                );
                            }
                            push_streaming_update(&mut pending, update);
                        } else {
                            persist_pending_updates(
                                &store,
                                &worker_conversation_id,
                                &mut pending,
                                generation.as_ref(),
                            )?;
                            flush_deadline = None;
                            persist_session_event(
                                &store,
                                &worker_conversation_id,
                                update.run_id.as_deref(),
                                update.event,
                                generation.as_ref(),
                            )?;
                        }
                    }
                    Some(SessionJournalCommand::Flush(response)) => {
                        let result = persist_pending_updates(
                            &store,
                            &worker_conversation_id,
                            &mut pending,
                            generation.as_ref(),
                        );
                        flush_deadline = None;
                        match result {
                            Ok(()) => {
                                let _ = response.send(Ok(()));
                            }
                            Err(error) => {
                                let _ = response.send(Err(error.to_string()));
                                return Err(error);
                            }
                        }
                    }
                    Some(SessionJournalCommand::Shutdown) => {
                        persist_pending_updates(
                            &store,
                            &worker_conversation_id,
                            &mut pending,
                            generation.as_ref(),
                        )?;
                        break;
                    }
                    None => {
                        persist_pending_updates(
                            &store,
                            &worker_conversation_id,
                            &mut pending,
                            generation.as_ref(),
                        )?;
                        break;
                    }
                }
            }
            Ok(())
        });
        Self { sink, worker }
    }

    fn sink(&self) -> SessionUpdateSink {
        self.sink.clone()
    }

    #[cfg(test)]
    async fn enqueue(
        &self,
        run_id: Option<String>,
        update: SessionUpdate,
    ) -> Result<(), SessionJournalError> {
        self.sink.enqueue(run_id, update).await
    }

    #[cfg(test)]
    async fn flush(&self) -> Result<(), SessionJournalError> {
        self.sink.flush().await
    }

    async fn shutdown(self) -> Result<(), SessionJournalError> {
        let send_result = {
            let mut accepting = self.sink.sender.accepting.lock().await;
            *accepting = false;
            self.sink
                .sender
                .sender
                .send(SessionJournalCommand::Shutdown)
                .await
        };
        let worker_result = self
            .worker
            .await
            .map_err(|error| SessionJournalError::Worker(error.to_string()))?;
        match worker_result {
            Ok(()) if send_result.is_ok() => Ok(()),
            Ok(()) => Err(SessionJournalError::Closed),
            Err(error) => Err(SessionJournalError::Persistence(error.to_string())),
        }
    }
}

impl SessionUpdateSink {
    async fn enqueue(
        &self,
        run_id: Option<String>,
        update: SessionUpdate,
    ) -> Result<(), SessionJournalError> {
        let accepting = self.sender.accepting.lock().await;
        if !*accepting {
            return Err(SessionJournalError::Closed);
        }
        if self
            .generation
            .as_ref()
            .is_some_and(|generation| !generation.is_current())
        {
            return Ok(());
        }
        let Some(event) = session_update_event(update) else {
            return Ok(());
        };
        self.sender
            .sender
            .send(SessionJournalCommand::Update(PendingSessionUpdate {
                run_id,
                event,
            }))
            .await
            .map_err(|_| SessionJournalError::Closed)
    }

    async fn flush(&self) -> Result<(), SessionJournalError> {
        let (sender, receiver) = oneshot::channel();
        {
            let accepting = self.sender.accepting.lock().await;
            if !*accepting {
                return Err(SessionJournalError::Closed);
            }
            self.sender
                .sender
                .send(SessionJournalCommand::Flush(sender))
                .await
                .map_err(|_| SessionJournalError::Closed)?;
        }
        receiver
            .await
            .map_err(|_| SessionJournalError::Closed)?
            .map_err(SessionJournalError::Persistence)
    }
}

fn journal_protocol_error(error: SessionJournalError) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(error.to_string())
}

fn finish_journal<T>(
    result: Result<T, agent_client_protocol::Error>,
    shutdown: Result<(), SessionJournalError>,
) -> Result<T, String> {
    match (result, shutdown) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(connection), Err(journal)) => Err(format!("{connection}; {journal}")),
        (Err(error), Ok(())) => Err(error.to_string()),
        (Ok(_), Err(error)) => Err(error.to_string()),
    }
}

fn push_streaming_update(pending: &mut Vec<PendingSessionUpdate>, update: PendingSessionUpdate) {
    if let Some(last) = pending.last_mut()
        && last.run_id == update.run_id
        && last.event.try_merge(&update.event)
    {
        return;
    }
    pending.push(update);
}

fn persist_pending_updates(
    store: &AgentStore,
    conversation_id: &str,
    pending: &mut Vec<PendingSessionUpdate>,
    generation: Option<&SessionActorGeneration>,
) -> Result<(), StoreError> {
    let pending = std::mem::take(pending);
    let title_updates = pending
        .iter()
        .filter_map(|update| update.event.title_update.clone())
        .collect::<Vec<_>>();
    let updates = pending.into_iter().map(runtime_update).collect::<Vec<_>>();
    let persist = || {
        store.append_runtime_updates(conversation_id, &updates)?;
        apply_session_title_updates(store, conversation_id, &title_updates);
        Ok(())
    };
    if let Some(generation) = generation {
        generation.persist_if_current(persist).map(|_| ())
    } else {
        persist()
    }
}

fn runtime_update(update: PendingSessionUpdate) -> RuntimeUpdate {
    let session_payload = match &update.run_id {
        Some(run_id) => merge_run_id(update.event.payload.clone(), run_id),
        None => update.event.payload.clone(),
    };
    let run_event = update
        .run_id
        .zip(update.event.run_kind)
        .map(|(run_id, kind)| RuntimeRunEvent {
            run_id,
            kind,
            payload: update.event.payload,
        });
    RuntimeUpdate {
        session_kind: update.event.session_kind.to_owned(),
        session_payload,
        run_event,
        publish_session_state: update.event.publish_session_state,
    }
}

impl PersistedSessionUpdate {
    fn is_streaming(&self) -> bool {
        matches!(
            self.session_kind,
            "user_message_delta" | "text_delta" | "thinking_delta"
        )
    }

    fn try_merge(&mut self, next: &Self) -> bool {
        if !self.is_streaming()
            || self.session_kind != next.session_kind
            || self.run_kind != next.run_kind
            || self.payload.get("message_id") != next.payload.get("message_id")
            || self.payload.get("_meta") != next.payload.get("_meta")
        {
            return false;
        }
        let Some(current) = self.payload.get("text").and_then(Value::as_str) else {
            return false;
        };
        let Some(delta) = next.payload.get("text").and_then(Value::as_str) else {
            return false;
        };
        self.payload["text"] = Value::String(current.to_owned() + delta);
        true
    }
}

fn session_update_event(update: SessionUpdate) -> Option<PersistedSessionUpdate> {
    let mut title_update = None;
    let event = match update {
        SessionUpdate::UserMessageChunk(chunk) => {
            text_event(AgentEventKind::TextDelta, chunk).map(|(_, payload)| {
                if let Some(text) = payload.get("text").and_then(Value::as_str) {
                    title_update = Some(SessionTitleUpdate::IfUntitled(text.to_owned()));
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
        SessionUpdate::AvailableCommandsUpdate(commands) => {
            serialized_state_update("available_commands", commands)
        }
        SessionUpdate::CurrentModeUpdate(mode) => serialized_state_update("current_mode", mode),
        SessionUpdate::ConfigOptionUpdate(options) => {
            serialized_state_update("config_options", options)
        }
        SessionUpdate::SessionInfoUpdate(info) => {
            match &info.title {
                MaybeUndefined::Value(title) if !title.trim().is_empty() => {
                    title_update = Some(SessionTitleUpdate::Provider(title.to_owned()));
                }
                MaybeUndefined::Value(_) | MaybeUndefined::Null | MaybeUndefined::Undefined => {}
            }
            serialized_state_update("session_info", info)
        }
        SessionUpdate::UsageUpdate(usage) => serialized_state_update("usage", usage),
        _ => None,
    };
    event.map(|(session_kind, run_kind, payload)| PersistedSessionUpdate {
        session_kind,
        run_kind,
        payload,
        publish_session_state: matches!(
            session_kind,
            "available_commands"
                | "current_mode"
                | "config_options"
                | "session_info"
                | "usage"
                | "plan"
        ),
        title_update,
    })
}

fn persist_session_event(
    store: &AgentStore,
    conversation_id: &str,
    run_id: Option<&str>,
    event: PersistedSessionUpdate,
    generation: Option<&SessionActorGeneration>,
) -> Result<(), StoreError> {
    let title_updates = event.title_update.clone().into_iter().collect::<Vec<_>>();
    let update = runtime_update(PendingSessionUpdate {
        run_id: run_id.map(str::to_owned),
        event,
    });
    let persist = || {
        store.append_runtime_updates(conversation_id, &[update])?;
        apply_session_title_updates(store, conversation_id, &title_updates);
        Ok(())
    };
    if let Some(generation) = generation {
        generation.persist_if_current(persist).map(|_| ())
    } else {
        persist()
    }
}

fn apply_session_title_updates(
    store: &AgentStore,
    conversation_id: &str,
    updates: &[SessionTitleUpdate],
) {
    for update in updates {
        match update {
            SessionTitleUpdate::IfUntitled(title) => {
                let _ = store.set_agent_title_if_untitled(conversation_id, title);
            }
            SessionTitleUpdate::Provider(title) => {
                let _ = store.set_agent_title(conversation_id, Some(title));
            }
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

fn serialized_state_update(
    session_kind: &'static str,
    value: impl serde::Serialize,
) -> Option<(&'static str, Option<AgentEventKind>, Value)> {
    serde_json::to_value(value)
        .ok()
        .map(|payload| (session_kind, None, payload))
}

fn persist_serialized_session_event(
    store: &AgentStore,
    conversation_id: &str,
    kind: &str,
    value: impl serde::Serialize,
    generation: Option<&SessionActorGeneration>,
) -> Result<(), agent_client_protocol::Error> {
    let payload = serde_json::to_value(value)
        .map_err(|error| agent_client_protocol::Error::internal_error().data(error.to_string()))?;
    let persist = || {
        store
            .append_session_event(conversation_id, kind, &payload)
            .map(|_| ())
    };
    let persisted = match generation {
        Some(generation) => generation.persist_if_current(persist).map_err(|error| {
            agent_client_protocol::Error::internal_error().data(error.to_string())
        })?,
        None => {
            persist().map_err(|error| {
                agent_client_protocol::Error::internal_error().data(error.to_string())
            })?;
            true
        }
    };
    if persisted {
        Ok(())
    } else {
        Err(agent_client_protocol::Error::internal_error().data("stale session actor generation"))
    }
}

fn persist_serialized_session_state_checkpoint(
    store: &AgentStore,
    conversation_id: &str,
    kind: &str,
    value: impl serde::Serialize,
    generation: Option<&SessionActorGeneration>,
) -> Result<(), agent_client_protocol::Error> {
    let payload = serde_json::to_value(value)
        .map_err(|error| agent_client_protocol::Error::internal_error().data(error.to_string()))?;
    let persisted = match generation {
        Some(generation) => generation
            .persist_if_current(|| {
                store.append_session_state_checkpoint(conversation_id, kind, &payload)
            })
            .map_err(|error| {
                agent_client_protocol::Error::internal_error().data(error.to_string())
            })?,
        None => {
            store
                .append_session_state_checkpoint(conversation_id, kind, &payload)
                .map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
            true
        }
    };
    if persisted {
        Ok(())
    } else {
        Err(agent_client_protocol::Error::internal_error().data("stale session actor generation"))
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
    let message_id = chunk.message_id.map(|value| value.to_string());
    let meta = chunk.meta;
    match chunk.content {
        ContentBlock::Text(text) => {
            let mut payload = json!({"text": text.text});
            if let Value::Object(object) = &mut payload {
                if let Some(message_id) = message_id {
                    object.insert("message_id".into(), Value::String(message_id));
                }
                if let Some(meta) = meta {
                    object.insert("_meta".into(), serde_json::to_value(meta).ok()?);
                }
            }
            Some((kind, payload))
        }
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
    fn codex_skill_prompt_uses_private_structured_meta_without_text_injection() {
        let (_cancel, cancelled) = oneshot::channel();
        let command = AgentCommand {
            run: AgentRun {
                id: "run".into(),
                conversation_id: "conversation".into(),
                project_id: "project".into(),
                message: "$review focus on tests".into(),
                status: RunStatus::Running,
                permission_mode: PermissionMode::Safe,
                error: None,
                internal: true,
            },
            message: "focus on tests".into(),
            provider_input: Some(Box::new(ComposerInvocation::ProviderStructuredInput {
                adapter_kind: "codex".into(),
                payload: json!({
                    "type":"skill",
                    "name":"review",
                    "path":"/srv/project/.agents/skills/review/SKILL.md"
                }),
            })),
            cancelled,
        };

        let request = serde_json::to_value(prompt_request_for_command(
            &SessionId::from("provider-session"),
            &command,
        ))
        .expect("prompt request JSON");
        assert_eq!(request["prompt"][0]["text"], "focus on tests");
        assert_eq!(
            request["_meta"]["kubecode"]["providerStructuredInput"],
            json!({
                "adapterKind":"codex",
                "payload":{
                    "type":"skill",
                    "name":"review",
                    "path":"/srv/project/.agents/skills/review/SKILL.md"
                }
            })
        );
        assert!(!request["prompt"].to_string().contains("$review"));
    }

    #[test]
    fn structured_catalog_replacement_after_preflight_never_dispatches_a_provider() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project = workspace
            .create_project_at(temp.path().join("structured-race"))
            .expect("project");
        std::fs::create_dir_all(temp.path().join("structured-race/src")).expect("source directory");
        std::fs::write(
            temp.path().join("structured-race/src/main.rs"),
            "fn main() {}\n",
        )
        .expect("context file");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let registration = store
            .register_composer_context(
                &conversation.id,
                &project.id,
                crate::composer_catalog::ComposerContextKind::File,
                "src/main.rs",
            )
            .expect("registration");
        let runtime = AgentRuntime::new(
            workspace,
            Arc::clone(&store),
            vec![AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: "/bin/false".into(),
                error: None,
            }],
        );
        let committed_counts = Arc::new(Mutex::new(None));
        let observed_counts = Arc::clone(&committed_counts);
        let update_store = Arc::clone(&store);
        let update_conversation = conversation.id.clone();
        let error = runtime
            .start_structured_composer_before_store(
                StartStructuredComposerRun {
                    conversation_id: conversation.id.clone(),
                    project_id: project.id.clone(),
                    item_id: None,
                    catalog_revision: registration.catalog.revision,
                    segments: vec![ComposerDraftSegment::ContextRef {
                        id: registration.context.id,
                        catalog_revision: registration.catalog.revision,
                        context_kind: crate::composer_catalog::ComposerContextKind::File,
                    }],
                },
                move || {
                    update_store
                        .append_runtime_update(
                            &update_conversation,
                            "available_commands",
                            &json!({"availableCommands":[{
                                "name":"review", "description":"Review"
                            }]}),
                            None,
                        )
                        .expect("commit catalog replacement after preflight");
                    *observed_counts.lock().expect("observed counts") = Some((
                        update_store
                            .session_events_after(&update_conversation, 0)
                            .expect("session events after replacement")
                            .len(),
                        update_store
                            .latest_workspace_event_id()
                            .expect("workspace cursor after replacement"),
                    ));
                },
            )
            .expect_err("post-preflight replacement must stale the request");

        assert!(matches!(
            error,
            RuntimeError::Store(StoreError::Composer(ComposerCatalogError::StaleRevision))
        ));
        let (session_events, workspace_cursor) = committed_counts
            .lock()
            .expect("committed counts")
            .expect("replacement counts");
        assert!(store.list_runs(&conversation.id).expect("runs").is_empty());
        assert_eq!(
            store
                .session_events_after(&conversation.id, 0)
                .expect("session events after rejection")
                .len(),
            session_events
        );
        assert_eq!(
            store
                .latest_workspace_event_id()
                .expect("workspace cursor after rejection"),
            workspace_cursor
        );
        assert_eq!(
            runtime.session_counts(),
            AgentRuntimeSessionCounts { active: 0, idle: 0 }
        );
    }

    #[tokio::test]
    async fn structured_context_uses_the_shared_agent_session_worktree() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project_root = temp.path().join("structured-shared-session");
        let project = workspace.create_project_at(&project_root).expect("project");
        run_git(&project_root, &["init"]);
        run_git(&project_root, &["config", "user.email", "test@example.com"]);
        run_git(&project_root, &["config", "user.name", "Kubecode Test"]);
        std::fs::write(project_root.join("README.md"), "root\n").expect("fixture");
        run_git(&project_root, &["add", "README.md"]);
        run_git(&project_root, &["commit", "-m", "initial"]);
        workspace
            .set_workspaces_enabled(&project.id, true)
            .expect("enable workspaces");

        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let parent = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("parent conversation");
        let worktree = workspace
            .create_session_worktree(&project.id, &parent.agent_session_id)
            .expect("worktree");
        std::fs::write(worktree.join("context.txt"), "worktree\n").expect("context fixture");
        store
            .assign_execution_workspace(
                &parent.id,
                crate::agents::ExecutionMode::Worktree,
                Some(worktree.to_str().expect("worktree path")),
            )
            .expect("parent workspace");
        let child = store
            .create_team_member(&parent.id, AgentId::OpenCode, false)
            .expect("shared child conversation");
        assert_ne!(child.id, child.agent_session_id);
        assert_eq!(child.agent_session_id, parent.agent_session_id);
        let registration = store
            .register_composer_context(
                &child.id,
                &project.id,
                crate::composer_catalog::ComposerContextKind::File,
                "context.txt",
            )
            .expect("registration");
        let runtime = AgentRuntime::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            vec![AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: "/bin/false".into(),
                error: None,
            }],
        );

        let run = runtime
            .start_structured_composer(StartStructuredComposerRun {
                conversation_id: child.id.clone(),
                project_id: project.id,
                item_id: None,
                catalog_revision: registration.catalog.revision,
                segments: vec![ComposerDraftSegment::ContextRef {
                    id: registration.context.id,
                    catalog_revision: registration.catalog.revision,
                    context_kind: crate::composer_catalog::ComposerContextKind::File,
                }],
            })
            .expect("shared Agent Session context should resolve in its worktree");

        assert_eq!(run.message, "@context.txt");
    }

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
        .expect("native ACP agent");
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
                .environment
                .iter()
                .any(|variable| variable.name == "OPENCODE_PERMISSION")
        );

        let maximum = acp_agent(
            AgentId::OpenCode,
            &descriptor,
            AgentPermissionProfile::Maximum,
            Path::new("/workspace/project"),
        )
        .expect("maximum ACP agent");
        let permission = maximum
            .environment
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
        .expect("project ACP adapter");
        assert_eq!(server.command, PathBuf::from("/bin/sh"));
        assert!(server.args.iter().any(|argument| {
            argument.ends_with("packaging/adapter-runtime/node_modules/.bin/codex-acp")
        }));
        assert!(server.environment.iter().any(|variable| {
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
        .expect("project ACP adapter");
        assert_eq!(server.command, PathBuf::from("/bin/sh"));
        assert!(
            server
                .args
                .iter()
                .any(|argument| { argument.ends_with("packaging/bin/claude-agent-acp") })
        );
        assert!(server.environment.iter().any(|variable| {
            variable.name == "CLAUDE_CODE_EXECUTABLE"
                && variable.value == "/home/jovyan/.local/bin/claude"
        }));
    }

    #[test]
    fn validates_adapter_executables() {
        assert!(configured_adapter_path("KUBECODE_TEST_ACP_PATH", "sh").is_some());
        assert!(
            configured_adapter_path("KUBECODE_TEST_ACP_PATH", "/definitely/missing/adapter")
                .is_none()
        );
        assert!(configured_adapter_path("KUBECODE_TEST_ACP_PATH", "codex-acp").is_some());
    }

    #[test]
    fn maps_acp_content_and_tool_updates_to_shared_events() {
        let mut chunk = ContentChunk::new(ContentBlock::Text(TextContent::new("done")));
        chunk.message_id = Some("message-1".into());
        let text = text_event(AgentEventKind::TextDelta, chunk).expect("text event");
        assert_eq!(text.1["text"], "done");
        assert_eq!(text.1["message_id"], "message-1");

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

    #[test]
    fn streaming_updates_coalesce_only_with_the_same_identity() {
        let event = |message_id: &str, text: &str| PersistedSessionUpdate {
            session_kind: "text_delta",
            run_kind: Some(AgentEventKind::TextDelta),
            payload: json!({"message_id":message_id, "text":text}),
            publish_session_state: false,
            title_update: None,
        };
        let mut pending = Vec::new();
        for _ in 0..1_000 {
            push_streaming_update(
                &mut pending,
                PendingSessionUpdate {
                    run_id: Some("run-1".into()),
                    event: event("message-1", "x"),
                },
            );
        }
        push_streaming_update(
            &mut pending,
            PendingSessionUpdate {
                run_id: Some("run-1".into()),
                event: event("message-2", "y"),
            },
        );

        assert_eq!(pending.len(), 2);
        assert_eq!(
            pending[0].event.payload["text"].as_str().map(str::len),
            Some(1_000)
        );
        assert_eq!(pending[1].event.payload["text"], "y");
    }

    #[tokio::test]
    async fn session_update_journal_flushes_text_before_semantic_events() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("stream-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Stream",
                PermissionMode::Safe,
            )
            .expect("run");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());
        let workspace_event_bus = store.workspace_event_bus();
        let workspace_receiver = workspace_event_bus.subscribe();
        let workspace_cursor = *workspace_receiver.borrow();

        for _ in 0..1_000 {
            let mut chunk = ContentChunk::new(ContentBlock::Text(TextContent::new("x")));
            chunk.message_id = Some("message-1".into());
            journal
                .enqueue(
                    Some(run.id.clone()),
                    SessionUpdate::AgentMessageChunk(chunk),
                )
                .await
                .expect("stream update");
        }
        journal
            .enqueue(
                Some(run.id.clone()),
                SessionUpdate::ToolCall(ToolCall::new(ToolCallId::new("tool-1"), "Shell")),
            )
            .await
            .expect("tool update");
        journal.flush().await.expect("flush");

        let events = store.events_after(&run.id, 1).expect("run events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, AgentEventKind::TextDelta);
        assert_eq!(
            events[0].payload["text"].as_str().map(str::len),
            Some(1_000)
        );
        assert_eq!(events[1].kind, AgentEventKind::ToolStarted);
        let session_events = store
            .session_events_after(&conversation.id, 1)
            .expect("session events");
        assert_eq!(session_events.len(), 2);
        assert_eq!(session_events[0].kind, "text_delta");
        assert_eq!(session_events[1].kind, "tool_started");
        let workspace_events = store
            .workspace_events_after(workspace_cursor)
            .expect("workspace events");
        assert_eq!(workspace_events.len(), 2);
        assert_eq!(
            workspace_event_bus.latest_committed_cursor(),
            workspace_events.last().expect("latest workspace event").id
        );
        assert!(
            workspace_receiver
                .has_changed()
                .expect("event bus remains open")
        );
        journal.shutdown().await.expect("shutdown");
    }

    #[tokio::test(start_paused = true)]
    async fn session_update_journal_flush_deadline_is_not_reset_by_streaming_updates() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("deadline-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Deadline",
                PermissionMode::Safe,
            )
            .expect("run");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());

        let enqueue_chunk = || {
            let mut chunk = ContentChunk::new(ContentBlock::Text(TextContent::new("x")));
            chunk.message_id = Some("message-1".into());
            journal.enqueue(
                Some(run.id.clone()),
                SessionUpdate::AgentMessageChunk(chunk),
            )
        };
        enqueue_chunk().await.expect("first update");
        tokio::task::yield_now().await;
        for _ in 0..3 {
            tokio::time::advance(Duration::from_millis(10)).await;
            enqueue_chunk().await.expect("stream update");
            tokio::task::yield_now().await;
        }

        tokio::time::advance(Duration::from_millis(4)).await;
        tokio::task::yield_now().await;

        let events = store.events_after(&run.id, 1).expect("run events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, AgentEventKind::TextDelta);
        assert_eq!(events[0].payload["text"], "xxxx");
        journal.shutdown().await.expect("shutdown");
    }

    #[tokio::test(start_paused = true)]
    async fn session_update_journal_uses_distinct_fixed_windows() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("windows-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Windows",
                PermissionMode::Safe,
            )
            .expect("run");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());
        let sink = journal.sink();

        sink.enqueue(
            Some(run.id.clone()),
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("a"),
            ))),
        )
        .await
        .expect("first update");
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(32)).await;
        tokio::task::yield_now().await;
        assert!(
            store
                .events_after(&run.id, 1)
                .expect("events before deadline")
                .is_empty()
        );

        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            store.events_after(&run.id, 1).expect("first window").len(),
            1
        );
        sink.enqueue(
            Some(run.id.clone()),
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("b"),
            ))),
        )
        .await
        .expect("second update");
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(33)).await;
        tokio::task::yield_now().await;

        let events = store.events_after(&run.id, 1).expect("two windows");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].payload["text"], "a");
        assert_eq!(events[1].payload["text"], "b");
        journal.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn journal_flush_and_shutdown_are_concurrency_fences() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("concurrent-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Concurrent",
                PermissionMode::Safe,
            )
            .expect("run");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());
        let sink = journal.sink();
        let barrier = Arc::new(tokio::sync::Barrier::new(17));
        let mut producers = Vec::new();
        for _ in 0..16 {
            let sink = sink.clone();
            let barrier = Arc::clone(&barrier);
            let run_id = run.id.clone();
            producers.push(tokio::spawn(async move {
                barrier.wait().await;
                sink.enqueue(
                    Some(run_id),
                    SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                        TextContent::new("x"),
                    ))),
                )
                .await
            }));
        }
        barrier.wait().await;
        for producer in producers {
            producer.await.expect("producer task").expect("enqueue");
        }

        journal.flush().await.expect("flush fence");
        let events = store.events_after(&run.id, 1).expect("flushed events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["text"], "xxxxxxxxxxxxxxxx");

        journal.shutdown().await.expect("shutdown fence");
        assert!(matches!(
            sink.enqueue(
                Some(run.id),
                SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                    TextContent::new("late"),
                ))),
            )
            .await,
            Err(SessionJournalError::Closed)
        ));
    }

    #[test]
    fn stale_actor_generation_cannot_overwrite_new_session_state() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("generation-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let workspace_cursor = store.latest_workspace_event_id().expect("workspace cursor");
        let current = Arc::new(RwLock::new("old".to_owned()));
        let old = SessionActorGeneration {
            expected: "old".into(),
            current: Arc::clone(&current),
        };
        let event = |name: &str| PendingSessionUpdate {
            run_id: None,
            event: PersistedSessionUpdate {
                session_kind: "available_commands",
                run_kind: Some(AgentEventKind::AvailableCommands),
                payload: json!({
                    "availableCommands":[{"name":name, "description":"Command"}]
                }),
                publish_session_state: true,
                title_update: None,
            },
        };
        let mut stale = vec![event("stale")];
        stale[0].event.title_update = Some(SessionTitleUpdate::Provider("Stale title".into()));

        *current.write().expect("generation lock") = "new".into();
        persist_pending_updates(&store, &conversation.id, &mut stale, Some(&old))
            .expect("stale update is discarded");
        assert!(stale.is_empty());
        assert!(
            store
                .session_events_after(&conversation.id, 0)
                .expect("session replay")
                .is_empty()
        );
        assert_eq!(
            store
                .get_conversation(&conversation.id)
                .expect("conversation")
                .agent_title,
            None
        );

        let new = SessionActorGeneration {
            expected: "new".into(),
            current,
        };
        let mut fresh = vec![event("fresh")];
        persist_pending_updates(&store, &conversation.id, &mut fresh, Some(&new))
            .expect("current update persists");

        let session_events = store
            .session_events_after(&conversation.id, 0)
            .expect("session replay");
        assert_eq!(session_events.len(), 2);
        let command_event = session_events
            .iter()
            .find(|event| event.kind == "available_commands")
            .expect("raw command snapshot");
        assert_eq!(
            command_event.payload["availableCommands"][0]["name"],
            "fresh"
        );
        let catalog_event = session_events
            .iter()
            .find(|event| event.kind == "composer_catalog")
            .expect("safe catalog snapshot");
        assert_eq!(catalog_event.payload["items"][0]["name"], "fresh");
        let workspace_events = store
            .workspace_events_after(workspace_cursor)
            .expect("workspace replay");
        assert_eq!(workspace_events.len(), 2);
        assert_eq!(workspace_events[0].kind, "composer_catalog_snapshot");
        assert_eq!(workspace_events[1].kind, "session_state");
    }

    #[test]
    fn session_generation_replacement_waits_for_an_inflight_state_commit() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("generation-fence-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let current = Arc::new(RwLock::new("old".to_owned()));
        let old = SessionActorGeneration {
            expected: "old".into(),
            current: Arc::clone(&current),
        };
        let old_after_replacement = old.clone();
        let old_store = Arc::clone(&store);
        let old_conversation_id = conversation.id.clone();
        let (commit_started, commit_started_rx) = std::sync::mpsc::channel();
        let (release_commit, release_commit_rx) = std::sync::mpsc::channel();
        let old_commit = std::thread::spawn(move || {
            old.persist_if_current(|| {
                commit_started.send(()).expect("commit started signal");
                release_commit_rx.recv().expect("release commit");
                old_store.append_runtime_updates(
                    &old_conversation_id,
                    &[RuntimeUpdate {
                        session_kind: "available_commands".into(),
                        session_payload: json!({
                            "availableCommands":[{"name":"old", "description":"Old"}]
                        }),
                        run_event: None,
                        publish_session_state: true,
                    }],
                )
            })
        });
        commit_started_rx.recv().expect("old commit entered");

        let replacement_generation = Arc::clone(&current);
        let (replacement_started, replacement_started_rx) = std::sync::mpsc::channel();
        let (replacement_finished, replacement_finished_rx) = std::sync::mpsc::channel();
        let replacement = std::thread::spawn(move || {
            replacement_started.send(()).expect("replacement started");
            *replacement_generation.write().expect("generation lock") = "new".into();
            replacement_finished.send(()).expect("replacement finished");
        });
        replacement_started_rx
            .recv()
            .expect("replacement attempted");
        assert!(
            replacement_finished_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "generation replacement must wait for the current commit"
        );

        release_commit.send(()).expect("release old commit");
        assert!(
            old_commit
                .join()
                .expect("old commit thread")
                .expect("old commit")
        );
        replacement_finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("replacement completes after commit");
        replacement.join().expect("replacement thread");

        let late = old_after_replacement
            .persist_if_current(|| panic!("stale generation must not execute its operation"))
            .expect("stale check");
        assert!(!late);
        let session_events = store
            .session_events_after(&conversation.id, 0)
            .expect("session replay");
        assert_eq!(session_events.len(), 2);
        let command_event = session_events
            .iter()
            .find(|event| event.kind == "available_commands")
            .expect("raw command snapshot");
        assert_eq!(command_event.payload["availableCommands"][0]["name"], "old");
        let catalog_event = session_events
            .iter()
            .find(|event| event.kind == "composer_catalog")
            .expect("safe catalog snapshot");
        assert_eq!(catalog_event.payload["items"][0]["name"], "old");
    }

    #[tokio::test]
    async fn journal_reports_persistence_failures_to_flush_and_shutdown() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("failure-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());
        let sink = journal.sink();
        sink.enqueue(
            None,
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("uncommitted"),
            ))),
        )
        .await
        .expect("accepted update");
        store
            .delete_conversation(&conversation.id)
            .expect("delete conversation before flush");

        assert!(matches!(
            sink.flush().await,
            Err(SessionJournalError::Persistence(_))
        ));
        assert!(matches!(
            journal.shutdown().await,
            Err(SessionJournalError::Persistence(_))
        ));
    }

    #[tokio::test]
    async fn concurrent_session_journals_keep_events_isolated() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let first_project = workspace
            .create_project_at(temp.path().join("first-project"))
            .expect("first project");
        let second_project = workspace
            .create_project_at(temp.path().join("second-project"))
            .expect("second project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let first = store
            .create_conversation(&first_project.id, AgentId::OpenCode, None)
            .expect("first conversation");
        let second = store
            .create_conversation(&second_project.id, AgentId::OpenCode, None)
            .expect("second conversation");
        let first_run = store
            .start_run(&first.id, &first_project.id, "First", PermissionMode::Safe)
            .expect("first run");
        let second_run = store
            .start_run(
                &second.id,
                &second_project.id,
                "Second",
                PermissionMode::Safe,
            )
            .expect("second run");
        let first_journal = SessionUpdateJournal::spawn(Arc::clone(&store), first.id.clone());
        let second_journal = SessionUpdateJournal::spawn(Arc::clone(&store), second.id.clone());
        let first_sink = first_journal.sink();
        let second_sink = second_journal.sink();

        let first_task = tokio::spawn(async move {
            for _ in 0..100 {
                first_sink
                    .enqueue(
                        Some(first_run.id.clone()),
                        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                            TextContent::new("a"),
                        ))),
                    )
                    .await?;
            }
            Ok::<_, SessionJournalError>(first_run.id)
        });
        let second_task = tokio::spawn(async move {
            for _ in 0..100 {
                second_sink
                    .enqueue(
                        Some(second_run.id.clone()),
                        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                            TextContent::new("b"),
                        ))),
                    )
                    .await?;
            }
            Ok::<_, SessionJournalError>(second_run.id)
        });
        let first_run_id = first_task
            .await
            .expect("first producer")
            .expect("first updates");
        let second_run_id = second_task
            .await
            .expect("second producer")
            .expect("second updates");
        first_journal.shutdown().await.expect("first shutdown");
        second_journal.shutdown().await.expect("second shutdown");

        let first_events = store.events_after(&first_run_id, 1).expect("first events");
        let second_events = store
            .events_after(&second_run_id, 1)
            .expect("second events");
        assert_eq!(first_events.len(), 1);
        assert_eq!(second_events.len(), 1);
        assert_eq!(first_events[0].payload["text"], "a".repeat(100));
        assert_eq!(second_events[0].payload["text"], "b".repeat(100));
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
