use std::collections::{HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ContentChunk, EnvVariable, InitializeRequest,
    LoadSessionRequest, McpServer, McpServerStdio, NewSessionRequest, PermissionOption,
    PermissionOptionId, PermissionOptionKind, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionNotification, SessionUpdate, ToolCall, ToolCallStatus, ToolCallUpdate,
};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};
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

#[derive(Clone)]
pub struct AgentRuntime {
    workspace: Arc<WorkspaceService>,
    store: Arc<AgentStore>,
    agents: Arc<HashMap<AgentId, AgentDescriptor>>,
    cancellations: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    sessions: Arc<Mutex<HashMap<String, SessionActorHandle>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

#[derive(Clone)]
struct SessionActorHandle {
    generation: String,
    sender: mpsc::UnboundedSender<AgentCommand>,
}

struct PendingPermission {
    allowed_options: HashSet<String>,
    run_id: String,
    sender: oneshot::Sender<RequestPermissionOutcome>,
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

    pub fn cancel(&self, run_id: &str) -> bool {
        let cancelled = self
            .cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .remove(run_id)
            .is_some_and(|sender| sender.send(()).is_ok());
        self.cancel_pending_permissions(run_id);
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

    fn dispatch(&self, config: AgentSessionConfig, command: AgentCommand) {
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
        mut receiver: mpsc::UnboundedReceiver<AgentCommand>,
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
                self.fail_run(&command.run.id, error.to_string());
                self.remove_cancellation(&command.run.id);
            }
        }
    }

    fn fail_run(&self, run_id: &str, message: String) {
        let _ =
            self.store
                .append_event(run_id, AgentEventKind::Error, &json!({"message": message}));
        let _ = self
            .store
            .finish_run(run_id, RunStatus::Failed, Some(&message));
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AcpRunOutcome {
    Completed,
    Cancelled,
}

async fn run_acp_session(
    runtime: AgentRuntime,
    config: AgentSessionConfig,
    first_command: AgentCommand,
    receiver: &mut mpsc::UnboundedReceiver<AgentCommand>,
    active_run_id: Arc<Mutex<Option<String>>>,
) -> Result<(), RuntimeError> {
    let agent = acp_agent(config.agent_id, &config.descriptor)?;
    let update_store = Arc::clone(&runtime.store);
    let update_run_id = Arc::clone(&active_run_id);
    let permission_store = Arc::clone(&runtime.store);
    let permission_run_id = Arc::clone(&active_run_id);
    let permission_mode = Arc::new(Mutex::new(PermissionMode::Safe));
    let current_permission_mode = Arc::clone(&permission_mode);
    let pending_permissions = Arc::clone(&runtime.pending_permissions);
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
                if let Some(run_id) = run_id {
                    persist_session_update(&update_store, &run_id, notification.update);
                }
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
        .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
            connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;

            let session_id = match provider_session_id {
                Some(session_id)
                    if connection
                        .send_request(LoadSessionRequest::new(session_id.clone(), cwd.clone()))
                        .block_task()
                        .await
                        .is_ok() =>
                {
                    session_id.into()
                }
                _ => {
                    connection
                        .send_request(NewSessionRequest::new(cwd))
                        .block_task()
                        .await?
                        .session_id
                }
            };
            store
                .set_provider_session(&conversation_id, &session_id.to_string())
                .map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
            let mut next_command = Some(first_command);
            loop {
                let command = if let Some(command) = next_command.take() {
                    command
                } else {
                    match tokio::time::timeout(SESSION_IDLE_TIMEOUT, receiver.recv()).await {
                        Ok(Some(command)) => command,
                        Ok(None) | Err(_) => break,
                    }
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
                *active_run_id.lock().expect("active run mutex poisoned") = None;
            }
            Ok(())
        })
        .await;

    result.map_err(|error| RuntimeError::Acp(error.to_string()))
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

fn persist_session_update(store: &AgentStore, run_id: &str, update: SessionUpdate) {
    let event = match update {
        SessionUpdate::AgentMessageChunk(chunk) => text_event(AgentEventKind::TextDelta, chunk),
        SessionUpdate::AgentThoughtChunk(chunk) => text_event(AgentEventKind::ThinkingDelta, chunk),
        SessionUpdate::ToolCall(tool_call) => Some(tool_started(tool_call)),
        SessionUpdate::ToolCallUpdate(update) => Some(tool_updated(update)),
        SessionUpdate::UsageUpdate(usage) => serde_json::to_value(usage)
            .ok()
            .map(|payload| (AgentEventKind::Usage, payload)),
        _ => None,
    };
    if let Some((kind, payload)) = event {
        let _ = store.append_event(run_id, kind, &payload);
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
