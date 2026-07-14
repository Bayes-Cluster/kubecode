use std::env;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::task::JoinSet;
use tokio::time::timeout;

use crate::agents::AgentId;

const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub struct AgentCandidate {
    pub id: AgentId,
    pub executable: PathBuf,
}

impl AgentCandidate {
    pub fn new(id: AgentId, executable: impl Into<PathBuf>) -> Self {
        Self {
            id,
            executable: executable.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentDescriptor {
    pub id: AgentId,
    pub available: bool,
    pub version: Option<String>,
    pub executable: String,
    pub error: Option<String>,
}

pub async fn discover_agents() -> Vec<AgentDescriptor> {
    discover_candidates(vec![
        configured_candidate(AgentId::ClaudeCode, "KUBECODE_CLAUDE_PATH", "claude"),
        configured_candidate(AgentId::Codex, "KUBECODE_CODEX_PATH", "codex"),
        configured_candidate(AgentId::OpenCode, "KUBECODE_OPENCODE_PATH", "opencode"),
    ])
    .await
}

pub fn supported_agents_unavailable() -> Vec<AgentDescriptor> {
    [
        (AgentId::ClaudeCode, "claude"),
        (AgentId::Codex, "codex"),
        (AgentId::OpenCode, "opencode"),
    ]
    .into_iter()
    .map(|(id, executable)| AgentDescriptor {
        id,
        available: false,
        version: None,
        executable: executable.to_owned(),
        error: Some("agent discovery has not completed".to_owned()),
    })
    .collect()
}

pub async fn discover_candidates(candidates: Vec<AgentCandidate>) -> Vec<AgentDescriptor> {
    let mut tasks = JoinSet::new();
    for candidate in candidates {
        tasks.spawn(probe(candidate));
    }

    let mut descriptors = Vec::with_capacity(3);
    while let Some(result) = tasks.join_next().await {
        if let Ok(descriptor) = result {
            descriptors.push(descriptor);
        }
    }
    descriptors.sort_by_key(|descriptor| agent_order(descriptor.id));
    descriptors
}

fn configured_candidate(id: AgentId, variable: &str, default: &str) -> AgentCandidate {
    AgentCandidate::new(
        id,
        env::var_os(variable)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(default)),
    )
}

async fn probe(candidate: AgentCandidate) -> AgentDescriptor {
    let executable = candidate.executable.to_string_lossy().into_owned();
    let output = timeout(
        VERSION_TIMEOUT,
        Command::new(&candidate.executable)
            .arg("--version")
            .output(),
    )
    .await;

    match output {
        Err(_) => unavailable(candidate.id, executable, "version probe timed out".into()),
        Ok(Err(error)) => unavailable(candidate.id, executable, error.to_string()),
        Ok(Ok(output)) if !output.status.success() => {
            let diagnostic = first_line(&output.stderr)
                .or_else(|| first_line(&output.stdout))
                .unwrap_or_else(|| format!("version probe exited with {}", output.status));
            unavailable(candidate.id, executable, diagnostic)
        }
        Ok(Ok(output)) => AgentDescriptor {
            id: candidate.id,
            available: true,
            version: first_line(&output.stdout).or_else(|| first_line(&output.stderr)),
            executable,
            error: None,
        },
    }
}

fn unavailable(id: AgentId, executable: String, error: String) -> AgentDescriptor {
    let diagnostic = format!("{executable}: {error}");
    AgentDescriptor {
        id,
        available: false,
        version: None,
        executable,
        error: Some(diagnostic),
    }
}

fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn agent_order(id: AgentId) -> u8 {
    match id {
        AgentId::ClaudeCode => 0,
        AgentId::Codex => 1,
        AgentId::OpenCode => 2,
    }
}
