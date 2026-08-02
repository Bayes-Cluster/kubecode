use std::env;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent_client_protocol::schema::v1::EnvVariable;
use agent_client_protocol::{Agent, ConnectTo, LineDirection, Lines};
use futures_util::StreamExt;
use futures_util::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::agent_discovery::{AgentDescriptor, configured_adapter_path};
use crate::agents::AgentId;

use super::{AgentPermissionProfile, RuntimeError};

const OPENCODE_MAXIMUM_PERMISSION: &str = r#"{"*":"allow"}"#;

type AcpDebugCallback = Arc<dyn Fn(&str, LineDirection) + Send + Sync + 'static>;

pub(super) struct TokioStdioAcpAgent {
    command: PathBuf,
    args: Vec<String>,
    environment: Vec<EnvVariable>,
    debug_callback: Option<AcpDebugCallback>,
}

impl TokioStdioAcpAgent {
    pub(super) fn with_debug(
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

pub(super) fn acp_agent(
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

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
}
