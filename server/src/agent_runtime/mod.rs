mod actor;
mod adapter;
mod agent_seam;
mod dispatch;
mod events;
mod journal;
mod permissions;
mod pool;

pub use self::actor::SessionConfigInput;
pub use self::agent_seam::AgentAdapterRegistry;
pub use self::dispatch::{
    PromptAdmission, StartAgentRun, StartComposerCommand, StartStructuredComposerRun,
};
pub use self::permissions::SideQuestionAccepted;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    ForkSessionRequest, InitializeRequest, ListSessionsRequest, LoadSessionRequest, McpServer,
    McpServerHttp, SessionNotification,
};
use agent_client_protocol::{Agent, ConnectionTo};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::agent_discovery::{AgentCatalog, AgentDescriptor};
use crate::agents::{
    AgentId, AgentRun, AgentStore, ConversationRelation, ConversationRelationship, RunStatus,
    StoreError,
};
use crate::composer_catalog::{
    ComposerCatalogError, ComposerContextRecord, ComposerPreflightContext,
    opaque_session_turn_context_id, parse_session_turn_selector,
};
use crate::git::GitService;
use crate::teams::{TeamMemberStatus, TeamMode, TeamRole, TeamStatus, TeamStore};
use crate::terminal::{TerminalInfo, TerminalManager, TerminalStatus};
use crate::workspace::{WorkspaceError, WorkspaceService};

use self::actor::SessionCommand;
use self::adapter::acp_agent;
use self::journal::{
    SessionUpdateJournal, finish_journal, journal_protocol_error, persist_serialized_session_event,
    persist_serialized_session_state_checkpoint,
};
use self::permissions::{PendingElicitation, PendingPermission, default_native_permission_mode};
use self::pool::SessionActorPolicy;

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
    adapters: AgentAdapterRegistry,
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum AgentPermissionProfile {
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
            adapters: AgentAdapterRegistry::new(),
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

    /// Per-agent adapter seam lookup (#104).
    pub fn adapter_for(&self, agent_id: AgentId) -> &dyn agent_seam::AgentAdapter {
        self.adapters.for_agent(agent_id)
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

    pub fn resolve_session_turn_composer_context(
        &self,
        conversation_id: &str,
        project_id: &str,
        record: &ComposerContextRecord,
    ) -> Result<Option<ComposerPreflightContext>, RuntimeError> {
        let (role, turn_id) = match parse_session_turn_selector(&record.path) {
            Some(selector) => selector,
            None => return Ok(None),
        };
        let snapshot =
            match self
                .store
                .resolve_composer_session_turn(conversation_id, turn_id, role)
            {
                Ok(snapshot) => snapshot,
                Err(StoreError::Composer(_)) => return Ok(None),
                Err(error) => return Err(error.into()),
            };
        let expected_id = opaque_session_turn_context_id(
            project_id,
            conversation_id,
            &record.path,
            &snapshot.source_revision,
        );
        if record.id != expected_id
            || record.source_revision.as_deref() != Some(snapshot.source_revision.as_str())
        {
            return Ok(None);
        }
        Ok(Some(ComposerPreflightContext {
            id: record.id.clone(),
            kind: record.kind,
            path: record.path.clone(),
            content: Some(snapshot.content),
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
            client_message_id: None,
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

    /// Boundary fork (#99): cuts the conversation at a completed-turn
    /// boundary. When the agent advertises native fork capability and the
    /// conversation has a provider session, the provider session is forked
    /// and the child stays linked (provider history survives — no
    /// `context_prefix` flattening). Otherwise the child rebuilds from the
    /// transcript prefix. The path taken is recorded on the child's lineage.
    pub async fn fork_provider_session(
        &self,
        conversation_id: &str,
        run_id: Option<&str>,
    ) -> Result<crate::agents::Conversation, RuntimeError> {
        let conversation = self.store.get_conversation(conversation_id)?;
        // A boundary fork cuts after a completed turn; an open turn is a
        // typed 409 — never a silent clip.
        let boundary = match run_id {
            Some(run_id) => Some(
                self.store
                    .resolve_turn_boundary(conversation_id, run_id)
                    .map_err(RuntimeError::Store)?,
            ),
            None => None,
        };
        let boundary_run_id = run_id.map(str::to_owned);

        if let Some(provider_session_id) = conversation.provider_session_id.clone() {
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
            let source_provider = provider_session_id.clone();
            let forked = agent_client_protocol::Client
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
                        .send_request(ForkSessionRequest::new(source_provider, cwd))
                        .block_task()
                        .await?;
                    Ok(response.session_id.to_string())
                })
                .await;
            if let Ok(forked_session_id) = forked {
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
                if let (Some(boundary), Some(boundary_run_id)) =
                    (boundary, boundary_run_id.as_deref())
                {
                    let _ = self.store.copy_transcript_to_conversation(
                        conversation_id,
                        &fork.id,
                        boundary.after_seq,
                    );
                    let _ = self.store.set_fork_lineage(
                        &fork.id,
                        Some(boundary_run_id),
                        "provider_fork",
                    );
                } else {
                    let _ = self.store.set_fork_lineage(&fork.id, None, "provider_fork");
                }
                self.hydrate_provider_session(&fork.id).await?;
                // Re-read: lineage was written after the child row was
                // created, so the caller gets the final metadata.
                return Ok(self.store.get_conversation(&fork.id)?);
            }
            // Native fork unavailable: fall through to the transcript
            // prefix reconstruction — the fallback, not the default.
        }

        // Fallback: flatten the transcript prefix into a fresh conversation
        // with a null provider session id.
        if let Some(run_id) = boundary_run_id.as_deref() {
            let fork = self
                .store
                .branch_conversation_at_run(conversation_id, run_id)?;
            let _ = self
                .store
                .set_fork_lineage(&fork.id, Some(run_id), "transcript_prefix");
            return Ok(self.store.get_conversation(&fork.id)?);
        }
        Err(RuntimeError::Store(StoreError::InvalidStoredValue(
            "conversation has no provider session and no boundary was given".into(),
        )))
    }

    fn available_descriptor(&self, agent_id: AgentId) -> Result<AgentDescriptor, RuntimeError> {
        self.agents
            .descriptor(agent_id)
            .filter(|agent| agent.available)
            .ok_or(RuntimeError::AgentUnavailable(agent_id))
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

#[cfg(test)]
fn run_git(path: &std::path::Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .expect("git command");
    assert!(status.success(), "git {args:?}");
}
