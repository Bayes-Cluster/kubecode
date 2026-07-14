use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::agent_discovery::AgentDescriptor;
use crate::agents::{
    AgentEventKind, AgentId, AgentRun, AgentStore, PermissionMode, RunStatus, StoreError,
};
use crate::workspace::{WorkspaceError, WorkspaceService};

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("agent is not available: {0:?}")]
    AgentUnavailable(AgentId),
    #[error("agent process could not start: {0}")]
    Spawn(#[from] std::io::Error),
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
        let spawned_run = run.clone();
        tokio::spawn(async move {
            runtime
                .execute(
                    spawned_run,
                    conversation.agent_id,
                    descriptor,
                    cwd,
                    request,
                    cancelled,
                )
                .await;
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

    async fn execute(
        &self,
        run: AgentRun,
        agent_id: AgentId,
        descriptor: AgentDescriptor,
        cwd: std::path::PathBuf,
        request: StartAgentRun,
        mut cancelled: oneshot::Receiver<()>,
    ) {
        let mut command = build_command(
            agent_id,
            &descriptor.executable,
            &cwd,
            &request.message,
            request.permission_mode,
        );
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.fail_run(&run.id, format!("could not start agent: {error}"));
                self.remove_cancellation(&run.id);
                return;
            }
        };
        let stdout = child.stdout.take().expect("agent stdout was configured");
        let stderr = child.stderr.take().expect("agent stderr was configured");
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut diagnostics = Vec::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() && diagnostics.len() < 3 {
                    diagnostics.push(line);
                }
            }
            diagnostics.join("\n")
        });
        let mut lines = BufReader::new(stdout).lines();
        let mut was_cancelled = false;

        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => self.persist_provider_line(&run, agent_id, &line),
                    Ok(None) | Err(_) => break,
                },
                _ = &mut cancelled => {
                    was_cancelled = true;
                    let _ = child.start_kill();
                    break;
                }
            }
        }
        let status = child.wait().await;
        let diagnostic = stderr_task.await.unwrap_or_default();
        self.remove_cancellation(&run.id);

        if was_cancelled {
            let _ = self.store.finish_run(&run.id, RunStatus::Cancelled, None);
        } else if status.as_ref().is_ok_and(|status| status.success()) {
            let _ = self.store.finish_run(&run.id, RunStatus::Completed, None);
        } else {
            let message = if diagnostic.is_empty() {
                status
                    .map(|status| format!("agent exited with {status}"))
                    .unwrap_or_else(|error| format!("agent wait failed: {error}"))
            } else {
                diagnostic
            };
            self.fail_run(&run.id, message);
        }
    }

    fn persist_provider_line(&self, run: &AgentRun, agent_id: AgentId, line: &str) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        for event in normalize_event(agent_id, &value) {
            if let Some(session_id) = event.session_id {
                let _ = self
                    .store
                    .set_provider_session(&run.conversation_id, &session_id);
            }
            if let Some((kind, payload)) = event.persisted {
                let _ = self.store.append_event(&run.id, kind, &payload);
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
}

fn build_command(
    agent_id: AgentId,
    executable: &str,
    cwd: &std::path::Path,
    message: &str,
    permission_mode: PermissionMode,
) -> Command {
    let mut command = Command::new(executable);
    match agent_id {
        AgentId::ClaudeCode => {
            command.args([
                "-p",
                message,
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--permission-mode",
                "acceptEdits",
            ]);
            match permission_mode {
                PermissionMode::Safe => {
                    command.args(["--disallowedTools", "Bash"]);
                }
                PermissionMode::Power => {
                    command.args(["--allowedTools", "Bash"]);
                }
            }
            command.env_remove("CLAUDECODE");
        }
        AgentId::Codex => {
            let (sandbox, approval) = match permission_mode {
                PermissionMode::Safe => ("read-only", "untrusted"),
                PermissionMode::Power => ("workspace-write", "never"),
            };
            command.args([
                "--sandbox",
                sandbox,
                "--ask-for-approval",
                approval,
                "exec",
                "--json",
                "-C",
                cwd.to_string_lossy().as_ref(),
                message,
            ]);
        }
        AgentId::OpenCode => {
            command.args(["run", "--format", "json", message]);
            let bash = match permission_mode {
                PermissionMode::Safe => "deny",
                PermissionMode::Power => "allow",
            };
            command.env(
                "OPENCODE_CONFIG_CONTENT",
                json!({
                    "$schema": "https://opencode.ai/config.json",
                    "permission": {
                        "read": "allow", "edit": "allow", "glob": "allow",
                        "grep": "allow", "list": "allow",
                        "external_directory": "deny", "bash": bash
                    }
                })
                .to_string(),
            );
        }
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

struct NormalizedEvent {
    session_id: Option<String>,
    persisted: Option<(AgentEventKind, Value)>,
}

fn normalize_event(agent_id: AgentId, value: &Value) -> Vec<NormalizedEvent> {
    match agent_id {
        AgentId::ClaudeCode => normalize_claude(value),
        AgentId::Codex => normalize_codex(value),
        AgentId::OpenCode => normalize_opencode(value),
    }
}

fn session(session_id: Option<&str>) -> Vec<NormalizedEvent> {
    session_id
        .map(|session_id| NormalizedEvent {
            session_id: Some(session_id.to_owned()),
            persisted: None,
        })
        .into_iter()
        .collect()
}

fn event(kind: AgentEventKind, payload: Value) -> Vec<NormalizedEvent> {
    vec![NormalizedEvent {
        session_id: None,
        persisted: Some((kind, payload)),
    }]
}

fn normalize_codex(value: &Value) -> Vec<NormalizedEvent> {
    match value["type"].as_str().unwrap_or_default() {
        "thread.started" => session(value["thread_id"].as_str()),
        "item.started" => normalize_codex_item(&value["item"], false),
        "item.completed" => normalize_codex_item(&value["item"], true),
        _ => Vec::new(),
    }
}

fn normalize_codex_item(item: &Value, completed: bool) -> Vec<NormalizedEvent> {
    let id = item["id"].as_str().unwrap_or("tool");
    match (item["type"].as_str().unwrap_or_default(), completed) {
        ("command_execution", false) => event(
            AgentEventKind::ToolStarted,
            json!({"tool_id": id, "tool":"Bash", "input":{"command":item["command"]}}),
        ),
        ("command_execution", true) => event(
            AgentEventKind::ToolCompleted,
            json!({"tool_id":id, "output":item["aggregated_output"]}),
        ),
        ("agent_message", true) => item["text"]
            .as_str()
            .map(|text| event(AgentEventKind::TextDelta, json!({"text":text})))
            .unwrap_or_default(),
        ("reasoning", true) => item["text"]
            .as_str()
            .map(|text| event(AgentEventKind::ThinkingDelta, json!({"text":text})))
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn normalize_claude(value: &Value) -> Vec<NormalizedEvent> {
    match value["type"].as_str().unwrap_or_default() {
        "system" if value["subtype"] == "init" => session(value["session_id"].as_str()),
        "result" => {
            let mut events = session(value["session_id"].as_str());
            if let Some(text) = value["result"].as_str().filter(|text| !text.is_empty()) {
                events.extend(event(AgentEventKind::TextDelta, json!({"text":text})));
            }
            events
        }
        "stream_event" => normalize_claude_stream(&value["event"]),
        "tool_result" => event(
            AgentEventKind::ToolCompleted,
            json!({"tool_id":value["tool_use_id"], "output":value["content"]}),
        ),
        _ => Vec::new(),
    }
}

fn normalize_claude_stream(stream: &Value) -> Vec<NormalizedEvent> {
    match stream["type"].as_str().unwrap_or_default() {
        "content_block_delta" if stream["delta"]["type"] == "text_delta" => event(
            AgentEventKind::TextDelta,
            json!({"text":stream["delta"]["text"]}),
        ),
        "content_block_delta" if stream["delta"]["type"] == "thinking_delta" => event(
            AgentEventKind::ThinkingDelta,
            json!({"text":stream["delta"]["thinking"]}),
        ),
        "content_block_start" if stream["content_block"]["type"] == "tool_use" => event(
            AgentEventKind::ToolStarted,
            json!({
                "tool_id":stream["content_block"]["id"],
                "tool":stream["content_block"]["name"],
                "input":stream["content_block"]["input"]
            }),
        ),
        _ => Vec::new(),
    }
}

fn normalize_opencode(value: &Value) -> Vec<NormalizedEvent> {
    let direct_type = value["type"].as_str().unwrap_or_default();
    if direct_type == "session" {
        return session(
            value["sessionID"]
                .as_str()
                .or_else(|| value["session_id"].as_str()),
        );
    }
    let part = &value["part"];
    let kind = if matches!(
        direct_type,
        "message"
            | "text"
            | "reasoning"
            | "tool_use"
            | "tool"
            | "tool_result"
            | "tool_done"
            | "error"
    ) {
        direct_type
    } else {
        part["type"].as_str().unwrap_or(direct_type)
    };
    let field = |name: &str| value.get(name).or_else(|| part.get(name));
    match kind {
        "message" | "text" => field("text")
            .or_else(|| field("content"))
            .and_then(Value::as_str)
            .map(|text| event(AgentEventKind::TextDelta, json!({"text":text})))
            .unwrap_or_default(),
        "reasoning" => field("text")
            .and_then(Value::as_str)
            .map(|text| event(AgentEventKind::ThinkingDelta, json!({"text":text})))
            .unwrap_or_default(),
        "tool_use" | "tool" => event(
            AgentEventKind::ToolStarted,
            json!({"tool_id":field("id"), "tool":field("name"), "input":field("input")}),
        ),
        "tool_result" | "tool_done" => event(
            AgentEventKind::ToolCompleted,
            json!({"tool_id":field("id"), "output":field("output")}),
        ),
        "error" => event(AgentEventKind::Error, json!({"message":field("message")})),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn persisted(value: Vec<NormalizedEvent>) -> Vec<(AgentEventKind, Value)> {
        value
            .into_iter()
            .filter_map(|event| event.persisted)
            .collect()
    }

    fn command_args(command: &Command) -> Vec<String> {
        command
            .as_std()
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn builds_provider_specific_safe_and_power_commands() {
        let cwd = Path::new("/tmp/project");
        let claude_safe = build_command(
            AgentId::ClaudeCode,
            "claude",
            cwd,
            "fix it",
            PermissionMode::Safe,
        );
        let claude_power = build_command(
            AgentId::ClaudeCode,
            "claude",
            cwd,
            "fix it",
            PermissionMode::Power,
        );
        assert!(
            command_args(&claude_safe)
                .windows(2)
                .any(|pair| pair == ["--disallowedTools", "Bash"])
        );
        assert!(
            command_args(&claude_power)
                .windows(2)
                .any(|pair| pair == ["--allowedTools", "Bash"])
        );

        let codex_safe =
            build_command(AgentId::Codex, "codex", cwd, "fix it", PermissionMode::Safe);
        let codex_power = build_command(
            AgentId::Codex,
            "codex",
            cwd,
            "fix it",
            PermissionMode::Power,
        );
        assert!(
            command_args(&codex_safe)
                .windows(2)
                .any(|pair| pair == ["--sandbox", "read-only"])
        );
        assert!(
            command_args(&codex_power)
                .windows(2)
                .any(|pair| pair == ["--sandbox", "workspace-write"])
        );

        let opencode_safe = build_command(
            AgentId::OpenCode,
            "opencode",
            cwd,
            "fix it",
            PermissionMode::Safe,
        );
        let opencode_power = build_command(
            AgentId::OpenCode,
            "opencode",
            cwd,
            "fix it",
            PermissionMode::Power,
        );
        let config = |command: &Command| {
            command
                .as_std()
                .get_envs()
                .find(|(name, _)| *name == "OPENCODE_CONFIG_CONTENT")
                .and_then(|(_, value)| value)
                .expect("OpenCode config")
                .to_string_lossy()
                .into_owned()
        };
        assert!(config(&opencode_safe).contains(r#""bash":"deny""#));
        assert!(config(&opencode_power).contains(r#""bash":"allow""#));
    }

    #[test]
    fn normalizes_codex_sessions_text_reasoning_and_tools() {
        let session_event = normalize_event(
            AgentId::Codex,
            &json!({"type":"thread.started", "thread_id":"thread-1"}),
        );
        assert_eq!(session_event[0].session_id.as_deref(), Some("thread-1"));

        let started = persisted(normalize_event(
            AgentId::Codex,
            &json!({"type":"item.started", "item":{"id":"tool-1", "type":"command_execution", "command":"pwd"}}),
        ));
        assert_eq!(started[0].0, AgentEventKind::ToolStarted);
        let completed = persisted(normalize_event(
            AgentId::Codex,
            &json!({"type":"item.completed", "item":{"id":"tool-1", "type":"command_execution", "aggregated_output":"ok"}}),
        ));
        assert_eq!(completed[0].0, AgentEventKind::ToolCompleted);

        let text = persisted(normalize_event(
            AgentId::Codex,
            &json!({"type":"item.completed", "item":{"type":"agent_message", "text":"done"}}),
        ));
        assert_eq!(text[0].1["text"], "done");
        let thinking = persisted(normalize_event(
            AgentId::Codex,
            &json!({"type":"item.completed", "item":{"type":"reasoning", "text":"plan"}}),
        ));
        assert_eq!(thinking[0].0, AgentEventKind::ThinkingDelta);
        assert!(normalize_event(AgentId::Codex, &json!({"type":"unknown"})).is_empty());
    }

    #[test]
    fn normalizes_claude_sessions_streams_results_and_tools() {
        let initialized = normalize_event(
            AgentId::ClaudeCode,
            &json!({"type":"system", "subtype":"init", "session_id":"session-1"}),
        );
        assert_eq!(initialized[0].session_id.as_deref(), Some("session-1"));

        let result = normalize_event(
            AgentId::ClaudeCode,
            &json!({"type":"result", "session_id":"session-1", "result":"done"}),
        );
        assert_eq!(result.len(), 2);
        assert_eq!(persisted(result)[0].1["text"], "done");

        for (delta_type, field, expected_kind) in [
            ("text_delta", "text", AgentEventKind::TextDelta),
            ("thinking_delta", "thinking", AgentEventKind::ThinkingDelta),
        ] {
            let events = persisted(normalize_event(
                AgentId::ClaudeCode,
                &json!({"type":"stream_event", "event":{"type":"content_block_delta", "delta":{"type":delta_type, field:"value"}}}),
            ));
            assert_eq!(events[0].0, expected_kind);
        }

        let tool = persisted(normalize_event(
            AgentId::ClaudeCode,
            &json!({"type":"stream_event", "event":{"type":"content_block_start", "content_block":{"type":"tool_use", "id":"tool-1", "name":"Read", "input":{}}}}),
        ));
        assert_eq!(tool[0].0, AgentEventKind::ToolStarted);
        let tool_result = persisted(normalize_event(
            AgentId::ClaudeCode,
            &json!({"type":"tool_result", "tool_use_id":"tool-1", "content":"ok"}),
        ));
        assert_eq!(tool_result[0].0, AgentEventKind::ToolCompleted);
        assert!(normalize_event(AgentId::ClaudeCode, &json!({"type":"unknown"})).is_empty());
    }

    #[test]
    fn normalizes_opencode_direct_and_part_events() {
        let session_event = normalize_event(
            AgentId::OpenCode,
            &json!({"type":"session", "sessionID":"session-1"}),
        );
        assert_eq!(session_event[0].session_id.as_deref(), Some("session-1"));

        for (value, expected_kind) in [
            (
                json!({"type":"text", "text":"done"}),
                AgentEventKind::TextDelta,
            ),
            (
                json!({"part":{"type":"reasoning", "text":"plan"}}),
                AgentEventKind::ThinkingDelta,
            ),
            (
                json!({"type":"tool", "id":"tool-1", "name":"bash", "input":{}}),
                AgentEventKind::ToolStarted,
            ),
            (
                json!({"part":{"type":"tool_done", "id":"tool-1", "output":"ok"}}),
                AgentEventKind::ToolCompleted,
            ),
            (
                json!({"type":"error", "message":"failed"}),
                AgentEventKind::Error,
            ),
        ] {
            let events = persisted(normalize_event(AgentId::OpenCode, &value));
            assert_eq!(events[0].0, expected_kind);
        }
        assert!(normalize_event(AgentId::OpenCode, &json!({"type":"unknown"})).is_empty());
    }
}
