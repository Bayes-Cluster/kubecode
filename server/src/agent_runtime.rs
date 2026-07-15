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
    McpServerStdio, NewSessionRequest, PermissionOption, PermissionOptionId, PermissionOptionKind,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, SelectedPermissionOutcome, SessionConfigOptionValue, SessionNotification,
    SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest, ToolCall, ToolCallStatus,
    ToolCallUpdate,
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
    AgentEventKind, AgentId, AgentRun, AgentStore, PermissionMode, RunStatus, StoreError,
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
    pub permission_mode: PermissionMode,
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
        let cwd = self.workspace.project_path(&request.project_id)?;
        let run = self.store.start_run(
            &request.conversation_id,
            &request.project_id,
            &request.message,
            request.permission_mode,
        )?;
        let (cancel, cancelled) = oneshot::channel();
        self.cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .insert(run.id.clone(), cancel);

        let command = AgentCommand {
            run: run.clone(),
            message: request.message,
            permission_mode: request.permission_mode,
            cancelled,
        };
        let config = AgentSessionConfig {
            conversation_id: conversation.id,
            agent_id: conversation.agent_id,
            descriptor,
            provider_session_id: conversation.provider_session_id,
            cwd,
        };
        self.dispatch(config, command);
        Ok(run)
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
        let cwd = self.workspace.project_path(&conversation.project_id)?;
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
        let cwd = self.workspace.project_path(&conversation.project_id)?;
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
        let fork = self.store.create_imported_conversation(
            &conversation.project_id,
            conversation.agent_id,
            &forked_session_id,
            conversation.agent_title.as_deref(),
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

    fn dispatch(&self, config: AgentSessionConfig, command: AgentCommand) {
        let existing = self
            .sessions
            .lock()
            .expect("agent session mutex poisoned")
            .get(&config.conversation_id)
            .cloned();
        let command = if let Some(handle) = existing {
            match handle.sender.send(SessionCommand::Prompt(command)) {
                Ok(()) => return,
                Err(error) => match error.0 {
                    SessionCommand::Prompt(command) => command,
                    _ => unreachable!("dispatch sends only prompt commands"),
                },
            }
        } else {
            command
        };

        let (sender, receiver) = mpsc::unbounded_channel();
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
            runtime.run_session_actor(config, command, receiver).await;
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
        first_command: AgentCommand,
        mut receiver: mpsc::UnboundedReceiver<SessionCommand>,
    ) {
        let active_run_id = Arc::new(Mutex::new(None));
        let result = run_acp_session(
            self.clone(),
            config,
            first_command,
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
                    | SessionCommand::SetConfig { response, .. } => {
                        let _ = response.send(Err(error.to_string()));
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
        self.send_session_control(conversation_id, |response| SessionCommand::SetMode {
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
        self.send_session_control(conversation_id, |response| SessionCommand::SetConfig {
            config_id,
            value,
            response,
        })
        .await
    }

    async fn send_session_control(
        &self,
        conversation_id: &str,
        command: impl FnOnce(oneshot::Sender<Result<(), String>>) -> SessionCommand,
    ) -> Result<(), RuntimeError> {
        let sender = self
            .sessions
            .lock()
            .expect("agent session mutex poisoned")
            .get(conversation_id)
            .map(|handle| handle.sender.clone())
            .ok_or_else(|| {
                RuntimeError::Acp("session is not connected; send a prompt first".into())
            })?;
        let (response, result) = oneshot::channel();
        sender
            .send(command(response))
            .map_err(|_| RuntimeError::Acp("session connection closed".into()))?;
        result
            .await
            .map_err(|_| RuntimeError::Acp("session connection closed".into()))?
            .map_err(RuntimeError::Acp)
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
    permission_mode: PermissionMode,
    cancelled: oneshot::Receiver<()>,
}

enum SessionCommand {
    Prompt(AgentCommand),
    SetMode {
        mode_id: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    SetConfig {
        config_id: String,
        value: SessionConfigInput,
        response: oneshot::Sender<Result<(), String>>,
    },
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
    first_command: AgentCommand,
    receiver: &mut mpsc::UnboundedReceiver<SessionCommand>,
    active_run_id: Arc<Mutex<Option<String>>>,
) -> Result<(), RuntimeError> {
    let agent = acp_agent(config.agent_id, &config.descriptor)?;
    let update_store = Arc::clone(&runtime.store);
    let update_run_id = Arc::clone(&active_run_id);
    let update_conversation_id = config.conversation_id.clone();
    let permission_store = Arc::clone(&runtime.store);
    let permission_run_id = Arc::clone(&active_run_id);
    let permission_mode = Arc::new(Mutex::new(PermissionMode::Safe));
    let current_permission_mode = Arc::clone(&permission_mode);
    let pending_permissions = Arc::clone(&runtime.pending_permissions);
    let elicitation_store = Arc::clone(&runtime.store);
    let elicitation_run_id = Arc::clone(&active_run_id);
    let pending_elicitations = Arc::clone(&runtime.pending_elicitations);
    let store = Arc::clone(&runtime.store);
    let conversation_id = config.conversation_id;
    let provider_session_id = config.provider_session_id;
    let cwd = config.cwd;

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
                let mode = *current_permission_mode
                    .lock()
                    .expect("permission mode mutex poisoned");
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
                    let _ = permission_store.append_event(
                        &run_id,
                        AgentEventKind::PermissionRequested,
                        &request_payload,
                    );
                    let outcome = if mode == PermissionMode::Power {
                        permission_outcome(&request.options, mode)
                    } else {
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
                        let selected = tokio::time::timeout(Duration::from_secs(5 * 60), receiver)
                            .await
                            .ok()
                            .and_then(Result::ok)
                            .unwrap_or(RequestPermissionOutcome::Cancelled);
                        pending_permissions
                            .lock()
                            .expect("pending permission mutex poisoned")
                            .remove(&request_id);
                        selected
                    };
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
                let resumed = if initialization
                    .agent_capabilities
                    .session_capabilities
                    .resume
                    .is_some()
                {
                    connection
                        .send_request(ResumeSessionRequest::new(session_id.clone(), cwd.clone()))
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
                        .send_request(LoadSessionRequest::new(session_id.clone(), cwd.clone()))
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
            } else {
                create_provider_session(&connection, &store, &conversation_id, cwd).await?
            };
            store
                .set_provider_session(&conversation_id, &session_id.to_string())
                .map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
            let mut next_command = Some(SessionCommand::Prompt(first_command));
            loop {
                let command = if let Some(command) = next_command.take() {
                    command
                } else {
                    match tokio::time::timeout(SESSION_IDLE_TIMEOUT, receiver.recv()).await {
                        Ok(Some(command)) => command,
                        Ok(None) | Err(_) => break,
                    }
                };
                let SessionCommand::Prompt(command) = command else {
                    match command {
                        SessionCommand::SetMode { mode_id, response } => {
                            let result = connection
                                .send_request(SetSessionModeRequest::new(
                                    session_id.clone(),
                                    mode_id,
                                ))
                                .block_task()
                                .await
                                .map(|_| ())
                                .map_err(|error| error.to_string());
                            let _ = response.send(result);
                        }
                        SessionCommand::SetConfig {
                            config_id,
                            value,
                            response,
                        } => {
                            let value = match value {
                                SessionConfigInput::Boolean(value) => {
                                    SessionConfigOptionValue::boolean(value)
                                }
                                SessionConfigInput::ValueId(value) => {
                                    SessionConfigOptionValue::value_id(value)
                                }
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
                                        &runtime.store,
                                        &conversation_id,
                                        "config_options",
                                        update,
                                    );
                                })
                                .map_err(|error| error.to_string());
                            let _ = response.send(result);
                        }
                        SessionCommand::Prompt(_) => unreachable!(),
                    }
                    continue;
                };
                *active_run_id.lock().expect("active run mutex poisoned") =
                    Some(command.run.id.clone());
                *permission_mode
                    .lock()
                    .expect("permission mode mutex poisoned") = command.permission_mode;
                let mut cancelled = command.cancelled;
                let prompt = connection
                    .send_request(PromptRequest::new(
                        session_id.clone(),
                        vec![command.message.into()],
                    ))
                    .block_task();
                let outcome = tokio::select! {
                    response = prompt => {
                        response?;
                        AcpRunOutcome::Completed
                    }
                    _ = &mut cancelled => {
                        connection.send_notification(CancelNotification::new(session_id.clone()))?;
                        AcpRunOutcome::Cancelled
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

fn permission_outcome(
    options: &[PermissionOption],
    permission_mode: PermissionMode,
) -> RequestPermissionOutcome {
    let preferred = options.iter().find(|option| {
        matches!(
            (permission_mode, option.kind),
            (PermissionMode::Safe, PermissionOptionKind::RejectOnce)
                | (PermissionMode::Safe, PermissionOptionKind::RejectAlways)
                | (PermissionMode::Power, PermissionOptionKind::AllowOnce)
                | (PermissionMode::Power, PermissionOptionKind::AllowAlways)
        )
    });
    preferred.map_or(RequestPermissionOutcome::Cancelled, |option| {
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.option_id.clone()))
    })
}

fn persist_session_update(
    store: &AgentStore,
    conversation_id: &str,
    run_id: Option<&str>,
    update: SessionUpdate,
) {
    let event = match update {
        SessionUpdate::UserMessageChunk(chunk) => text_event(AgentEventKind::TextDelta, chunk)
            .map(|(_, payload)| ("user_message_delta", None, payload)),
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
                MaybeUndefined::Value(title) => {
                    let _ = store.set_agent_title(conversation_id, Some(title));
                }
                MaybeUndefined::Null => {
                    let _ = store.set_agent_title(conversation_id, None);
                }
                MaybeUndefined::Undefined => {}
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
    use agent_client_protocol::schema::v1::{
        PermissionOptionId, TextContent, ToolCallId, ToolCallUpdateFields,
    };

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
    fn validates_adapter_executables_and_empty_permissions() {
        assert!(executable_path(PathBuf::from("sh")).is_some());
        assert!(executable_path(PathBuf::from("/definitely/missing/adapter")).is_none());
        assert!(local_adapter("codex-acp").is_some());
        assert_eq!(
            permission_outcome(&[], PermissionMode::Safe),
            RequestPermissionOutcome::Cancelled
        );
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

    #[test]
    fn safe_rejects_and_power_allows_acp_permissions() {
        let options = vec![
            PermissionOption::new(
                PermissionOptionId::new("allow"),
                "Allow",
                PermissionOptionKind::AllowOnce,
            ),
            PermissionOption::new(
                PermissionOptionId::new("reject"),
                "Reject",
                PermissionOptionKind::RejectOnce,
            ),
        ];
        assert_eq!(
            selected_option(permission_outcome(&options, PermissionMode::Safe)),
            "reject"
        );
        assert_eq!(
            selected_option(permission_outcome(&options, PermissionMode::Power)),
            "allow"
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
