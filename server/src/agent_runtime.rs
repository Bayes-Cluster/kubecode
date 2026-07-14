use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ContentChunk, EnvVariable, InitializeRequest,
    LoadSessionRequest, McpServer, McpServerStdio, NewSessionRequest, PermissionOption,
    PermissionOptionKind, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification, SessionUpdate,
    ToolCall, ToolCallStatus, ToolCallUpdate,
};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::oneshot;

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
            request.permission_mode,
        )?;
        let (cancel, cancelled) = oneshot::channel();
        self.cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .insert(run.id.clone(), cancel);

        let runtime = self.clone();
        let execution = AgentExecution {
            run: run.clone(),
            agent_id: conversation.agent_id,
            descriptor,
            provider_session_id: conversation.provider_session_id,
            cwd,
            message: request.message,
            permission_mode: request.permission_mode,
        };
        tokio::spawn(async move {
            runtime.execute(execution, cancelled).await;
        });
        Ok(run)
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        self.cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .remove(run_id)
            .is_some_and(|sender| sender.send(()).is_ok())
    }

    async fn execute(&self, execution: AgentExecution, cancelled: oneshot::Receiver<()>) {
        let result = run_acp(Arc::clone(&self.store), &execution, cancelled).await;
        self.remove_cancellation(&execution.run.id);

        match result {
            Ok(AcpRunOutcome::Completed) => {
                let _ = self
                    .store
                    .finish_run(&execution.run.id, RunStatus::Completed, None);
            }
            Ok(AcpRunOutcome::Cancelled) => {
                let _ = self
                    .store
                    .finish_run(&execution.run.id, RunStatus::Cancelled, None);
            }
            Err(error) => self.fail_run(&execution.run.id, error.to_string()),
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
}

struct AgentExecution {
    run: AgentRun,
    agent_id: AgentId,
    descriptor: AgentDescriptor,
    provider_session_id: Option<String>,
    cwd: PathBuf,
    message: String,
    permission_mode: PermissionMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AcpRunOutcome {
    Completed,
    Cancelled,
}

async fn run_acp(
    store: Arc<AgentStore>,
    execution: &AgentExecution,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<AcpRunOutcome, RuntimeError> {
    let agent = acp_agent(execution.agent_id, &execution.descriptor)?;
    let accepting_updates = Arc::new(AtomicBool::new(false));
    let update_store = Arc::clone(&store);
    let update_run_id = execution.run.id.clone();
    let update_gate = Arc::clone(&accepting_updates);
    let permission_store = Arc::clone(&store);
    let permission_run_id = execution.run.id.clone();
    let conversation_id = execution.run.conversation_id.clone();
    let provider_session_id = execution.provider_session_id.clone();
    let permission_mode = execution.permission_mode;
    let cwd = execution.cwd.clone();
    let message = execution.message.clone();

    let result = agent_client_protocol::Client
        .builder()
        .name("Kubecode")
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                if update_gate.load(Ordering::Acquire) {
                    persist_session_update(&update_store, &update_run_id, notification.update);
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                let outcome = permission_outcome(&request.options, permission_mode);
                let request_payload = json!({
                    "tool_id": request.tool_call.tool_call_id.to_string(),
                    "tool": request.tool_call.fields.title,
                    "input": request.tool_call.fields.raw_input,
                    "options": request.options,
                });
                let _ = permission_store.append_event(
                    &permission_run_id,
                    AgentEventKind::PermissionRequested,
                    &request_payload,
                );
                let _ = permission_store.append_event(
                    &permission_run_id,
                    AgentEventKind::PermissionResolved,
                    &json!({"outcome": outcome}),
                );
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
            accepting_updates.store(true, Ordering::Release);

            let prompt = connection
                .send_request(PromptRequest::new(session_id.clone(), vec![message.into()]))
                .block_task();
            tokio::select! {
                response = prompt => {
                    response?;
                    Ok(AcpRunOutcome::Completed)
                }
                _ = &mut cancelled => {
                    connection.send_notification(CancelNotification::new(session_id))?;
                    Ok(AcpRunOutcome::Cancelled)
                }
            }
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

    fn selected_option(outcome: RequestPermissionOutcome) -> String {
        let RequestPermissionOutcome::Selected(selected) = outcome else {
            panic!("selected outcome")
        };
        selected.option_id.to_string()
    }
}
