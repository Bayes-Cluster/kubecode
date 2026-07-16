use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, ContentChunk, CreateElicitationRequest,
    CreateElicitationResponse, DeleteSessionRequest, ElicitationAcceptAction, ElicitationAction,
    ElicitationCapabilities, ElicitationContentValue, ElicitationFormCapabilities, EnvVariable,
    ForkSessionRequest, InitializeRequest, ListSessionsRequest, LoadSessionRequest, McpServer,
    McpServerStdio, NewSessionRequest, PermissionOptionId, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, ResumeSessionRequest,
    SelectedPermissionOutcome, SessionConfigOptionValue, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, ToolCall, ToolCallStatus, ToolCallUpdate,
};
use agent_client_protocol::schema::{MaybeUndefined, ProtocolVersion};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};
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

#[derive(Clone)]
pub struct AgentRuntime {
    workspace: Arc<WorkspaceService>,
    store: Arc<AgentStore>,
    agents: Arc<HashMap<AgentId, AgentDescriptor>>,
    cancellations: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    sessions: Arc<Mutex<HashMap<String, SessionActorHandle>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
}

#[derive(Clone)]
struct SessionActorHandle {
    generation: String,
    sender: mpsc::UnboundedSender<SessionCommand>,
}

struct PendingPermission {
    allowed_options: HashSet<String>,
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
        }
    }

    pub fn store(&self) -> Arc<AgentStore> {
        Arc::clone(&self.store)
    }

    pub fn start(&self, request: StartAgentRun) -> Result<AgentRun, RuntimeError> {
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
        let run = self.store.start_run(
            &request.conversation_id,
            &request.project_id,
            &request.message,
            PermissionMode::Safe,
        )?;
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
            .get(conversation_id)
            .cloned();
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

    pub async fn list_provider_sessions(
        &self,
        project_id: &str,
        agent_id: AgentId,
    ) -> Result<Vec<ProviderSessionInfo>, RuntimeError> {
        let descriptor = self.available_descriptor(agent_id)?;
        let cwd = self.workspace.project_path(project_id)?;
        let agent = acp_agent(agent_id, &descriptor)?;
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
        let agent = acp_agent(conversation.agent_id, &descriptor)?;
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

    pub async fn delete_provider_session(&self, conversation_id: &str) -> Result<(), RuntimeError> {
        let conversation = self.store.get_conversation(conversation_id)?;
        let provider_session_id = conversation.provider_session_id.clone().ok_or_else(|| {
            StoreError::InvalidStoredValue("conversation has no provider session".into())
        })?;
        let descriptor = self.available_descriptor(conversation.agent_id)?;
        let agent = acp_agent(conversation.agent_id, &descriptor)?;
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
                    .delete
                    .is_none()
                {
                    return Err(agent_client_protocol::Error::method_not_found());
                }
                connection
                    .send_request(DeleteSessionRequest::new(provider_session_id))
                    .block_task()
                    .await?;
                Ok(())
            })
            .await
            .map_err(|error| RuntimeError::Acp(error.to_string()))?;
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
        let agent = acp_agent(conversation.agent_id, &descriptor)?;
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
        if let Some(run) = run {
            let _ = self.store.append_session_event(
                &run.conversation_id,
                "run_completed",
                &json!({"run_id":run_id, "status":"failed", "error":message}),
            );
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
        })
    }
}

struct AgentSessionConfig {
    conversation_id: String,
    agent_id: AgentId,
    descriptor: AgentDescriptor,
    provider_session_id: Option<String>,
    cwd: PathBuf,
}

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
    let agent = acp_agent(config.agent_id, &config.descriptor)?;
    let update_store = Arc::clone(&runtime.store);
    let update_run_id = Arc::clone(&active_run_id);
    let update_conversation_id = config.conversation_id.clone();
    let permission_store = Arc::clone(&runtime.store);
    let permission_run_id = Arc::clone(&active_run_id);
    let pending_permissions = Arc::clone(&runtime.pending_permissions);
    let elicitation_store = Arc::clone(&runtime.store);
    let elicitation_run_id = Arc::clone(&active_run_id);
    let pending_elicitations = Arc::clone(&runtime.pending_elicitations);
    let store = Arc::clone(&runtime.store);
    let conversation_id = config.conversation_id;
    let provider_session_id = config.provider_session_id;
    let cwd = config.cwd;
    let checkpoint_cwd = cwd.clone();

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
                let request_payload = json!({
                    "request_id": request_id,
                    "tool_id": request.tool_call.tool_call_id.to_string(),
                    "tool": request.tool_call.fields.title,
                    "input": request.tool_call.fields.raw_input,
                    "options": request.options.iter().map(|option| json!({
                        "id": option.option_id.to_string(),
                        "label": option.name,
                        "kind": option.kind,
                    })).collect::<Vec<_>>(),
                });
                let outcome = if let Some(run_id) = run_id {
                    let _ = permission_store
                        .set_run_status(&run_id, RunStatus::WaitingPermission);
                    let _ = permission_store.append_event(
                        &run_id,
                        AgentEventKind::PermissionRequested,
                        &request_payload,
                    );
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
                                run_id: run_id.clone(),
                                sender,
                            },
                        );
                    let outcome = tokio::time::timeout(Duration::from_secs(5 * 60), receiver)
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or(RequestPermissionOutcome::Cancelled);
                    pending_permissions
                        .lock()
                        .expect("pending permission mutex poisoned")
                        .remove(&request_id);
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
                        ClientCapabilities::new().elicitation(
                            ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()),
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

            let session_id = if let Some(session_id) = provider_session_id {
                if hydrate_provider_history && initialization.agent_capabilities.load_session {
                    let response = connection
                        .send_request(LoadSessionRequest::new(session_id.clone(), cwd.clone()))
                        .block_task()
                        .await?;
                    persist_serialized_session_event(
                        &store,
                        &conversation_id,
                        "session_loaded",
                        response,
                    );
                    session_id.into()
                } else {
                    let resumed = if initialization
                    .agent_capabilities
                    .session_capabilities
                    .resume
                    .is_some()
                    {
                        connection
                            .send_request(ResumeSessionRequest::new(
                                session_id.clone(),
                                cwd.clone(),
                            ))
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
                        session_id.into()
                    } else {
                        match connection
                            .send_request(LoadSessionRequest::new(
                                session_id.clone(),
                                cwd.clone(),
                            ))
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
                                session_id.into()
                            }
                            Err(_) => {
                                create_provider_session(&connection, &store, &conversation_id, cwd)
                                    .await?
                            }
                        }
                    }
                }
            } else {
                create_provider_session(&connection, &store, &conversation_id, cwd).await?
            };
            store
                .set_provider_session(&conversation_id, &session_id.to_string())
                .map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
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
                if let Ok(Some(tree)) = runtime.workspace.capture_git_tree(
                    &checkpoint_cwd,
                    &format!("{}-after", command.run.id),
                ) {
                    let _ = runtime
                        .store
                        .set_run_checkpoint(&command.run.id, None, Some(&tree));
                }
                let _ = runtime.store.append_session_event(
                    &conversation_id,
                    "run_completed",
                    &json!({"run_id":command.run.id, "status":status}),
                );
                *active_run_id.lock().expect("active run mutex poisoned") = None;
            }
            Ok(())
        })
        .await;

    result.map_err(|error| RuntimeError::Acp(error.to_string()))
}

async fn create_provider_session(
    connection: &ConnectionTo<Agent>,
    store: &AgentStore,
    conversation_id: &str,
    cwd: PathBuf,
) -> Result<agent_client_protocol::schema::v1::SessionId, agent_client_protocol::Error> {
    let response = connection
        .send_request(NewSessionRequest::new(cwd))
        .block_task()
        .await?;
    let session_id = response.session_id.clone();
    persist_serialized_session_event(store, conversation_id, "session_created_state", response);
    Ok(session_id)
}

fn acp_agent(agent_id: AgentId, descriptor: &AgentDescriptor) -> Result<AcpAgent, RuntimeError> {
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
        AgentId::OpenCode => (
            "OpenCode",
            PathBuf::from(&descriptor.executable),
            vec!["acp".to_owned()],
            Vec::new(),
        ),
    };
    Ok(AcpAgent::new(McpServer::Stdio(
        McpServerStdio::new(name, command)
            .args(args)
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
        let server = acp_agent(AgentId::OpenCode, &descriptor)
            .expect("native ACP agent")
            .into_server();
        let McpServer::Stdio(server) = server else {
            panic!("stdio adapter")
        };
        assert_eq!(server.command, PathBuf::from("/opt/bin/opencode"));
        assert_eq!(server.args, ["acp"]);
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
        let server = acp_agent(AgentId::Codex, &descriptor)
            .expect("project ACP adapter")
            .into_server();
        let McpServer::Stdio(server) = server else {
            panic!("stdio adapter")
        };
        assert!(server.command.ends_with("node_modules/.bin/codex-acp"));
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
        let server = acp_agent(AgentId::ClaudeCode, &descriptor)
            .expect("project ACP adapter")
            .into_server();
        let McpServer::Stdio(server) = server else {
            panic!("stdio adapter")
        };
        assert!(
            server
                .command
                .ends_with("node_modules/.bin/claude-agent-acp")
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

    fn selected_option(outcome: RequestPermissionOutcome) -> String {
        let RequestPermissionOutcome::Selected(selected) = outcome else {
            panic!("selected outcome")
        };
        selected.option_id.to_string()
    }
}
