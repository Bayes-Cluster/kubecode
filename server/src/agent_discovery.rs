use std::env;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
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
    let specifications = [
        (AgentId::ClaudeCode, "KUBECODE_CLAUDE_PATH", "claude"),
        (AgentId::Codex, "KUBECODE_CODEX_PATH", "codex"),
        (AgentId::OpenCode, "KUBECODE_OPENCODE_PATH", "opencode"),
    ];
    let mut tasks = JoinSet::new();
    for (id, variable, name) in specifications {
        tasks.spawn(async move {
            let candidate =
                tokio::task::spawn_blocking(move || resolve_agent_candidate(id, variable, name))
                    .await
                    .unwrap_or_else(|_| AgentCandidate::new(id, name));
            probe(candidate).await
        });
    }
    collect_descriptors(tasks).await
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

    collect_descriptors(tasks).await
}

async fn collect_descriptors(mut tasks: JoinSet<AgentDescriptor>) -> Vec<AgentDescriptor> {
    let mut descriptors = Vec::with_capacity(3);
    while let Some(result) = tasks.join_next().await {
        if let Ok(descriptor) = result {
            descriptors.push(descriptor);
        }
    }
    descriptors.sort_by_key(|descriptor| agent_order(descriptor.id));
    descriptors
}

fn resolve_agent_candidate(id: AgentId, variable: &str, name: &str) -> AgentCandidate {
    let executable = env::var_os(variable).map(PathBuf::from).unwrap_or_else(|| {
        resolve_executable(name)
            .or_else(|| {
                env::var_os("HOME")
                    .map(PathBuf::from)
                    .and_then(|home| first_executable(agent_binary_candidates(id, &home)))
            })
            .unwrap_or_else(|| PathBuf::from(name))
    });
    AgentCandidate::new(id, executable)
}

pub(crate) fn resolve_executable(name: &str) -> Option<PathBuf> {
    find_on_inherited_path(name).or_else(|| find_in_login_shell(name))
}

fn find_on_inherited_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    let candidates = env::split_paths(&path)
        .map(|directory| directory.join(name))
        .collect();
    first_executable(candidates)
}

fn find_in_login_shell(name: &str) -> Option<PathBuf> {
    shell_candidates().into_iter().find_map(|shell| {
        StdCommand::new(shell)
            .args(["-lc", &format!("command -v {name}")])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| first_path(&output.stdout))
    })
}

fn shell_candidates() -> Vec<PathBuf> {
    let mut candidates = env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .collect::<Vec<_>>();
    for shell in [PathBuf::from("/bin/zsh"), PathBuf::from("/bin/bash")] {
        if !candidates.contains(&shell) && shell.exists() {
            candidates.push(shell);
        }
    }
    candidates
}

fn first_path(output: &[u8]) -> Option<PathBuf> {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| is_executable(path))
}

fn first_executable(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| is_executable(path))
}

pub(crate) fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn agent_binary_candidates(id: AgentId, home: &Path) -> Vec<PathBuf> {
    let name = match id {
        AgentId::ClaudeCode => "claude",
        AgentId::Codex => "codex",
        AgentId::OpenCode => "opencode",
    };
    let mut candidates = vec![
        home.join(format!(".local/bin/{name}")),
        home.join(format!(".local/share/mise/shims/{name}")),
        home.join(format!(".asdf/shims/{name}")),
        home.join(format!(".npm-global/bin/{name}")),
        home.join(format!(".npm/bin/{name}")),
        home.join(format!(".bun/bin/{name}")),
        home.join(format!(".linuxbrew/bin/{name}")),
        PathBuf::from(format!("/home/linuxbrew/.linuxbrew/bin/{name}")),
        PathBuf::from(format!("/opt/homebrew/bin/{name}")),
        PathBuf::from(format!("/usr/local/bin/{name}")),
    ];
    match id {
        AgentId::ClaudeCode => candidates.push(home.join(".claude/local/claude")),
        AgentId::Codex => {
            candidates.push(home.join(".codex/bin/codex"));
            candidates.push(PathBuf::from(
                "/Applications/Codex.app/Contents/Resources/codex",
            ));
        }
        AgentId::OpenCode => candidates.push(home.join(".opencode/bin/opencode")),
    }
    candidates.extend(nvm_candidates(home, name));
    candidates
}

fn nvm_candidates(home: &Path, name: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) else {
        return Vec::new();
    };
    let mut candidates = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin").join(name))
        .collect::<Vec<_>>();
    candidates.sort();
    candidates
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn includes_common_install_locations() {
        let home = PathBuf::from("/Users/alex");

        let claude = agent_binary_candidates(AgentId::ClaudeCode, &home);
        assert!(claude.contains(&home.join(".claude/local/claude")));
        assert!(claude.contains(&home.join(".local/share/mise/shims/claude")));
        assert!(claude.contains(&PathBuf::from("/opt/homebrew/bin/claude")));

        let codex = agent_binary_candidates(AgentId::Codex, &home);
        assert!(codex.contains(&home.join(".codex/bin/codex")));
        assert!(codex.contains(&PathBuf::from(
            "/Applications/Codex.app/Contents/Resources/codex",
        )));

        let opencode = agent_binary_candidates(AgentId::OpenCode, &home);
        assert!(opencode.contains(&home.join(".opencode/bin/opencode")));
        assert!(opencode.contains(&home.join(".bun/bin/opencode")));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_an_executable_common_candidate_outside_inherited_path() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("tempdir");
        let binary = directory.path().join("claude");
        fs::write(&binary, "#!/bin/sh\nexit 0\n").expect("write binary");
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).expect("make executable");

        assert_eq!(first_executable(vec![binary.clone()]), Some(binary));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_path_shell_and_nvm_candidates_with_executable_checks() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("tempdir");
        let nvm_root = directory.path().join(".nvm/versions/node");
        let older = nvm_root.join("v20/bin");
        let newer = nvm_root.join("v22/bin");
        fs::create_dir_all(&older).expect("older node directory");
        fs::create_dir_all(&newer).expect("newer node directory");
        for path in [older.join("codex"), newer.join("codex")] {
            fs::write(&path, "#!/bin/sh\nexit 0\n").expect("write nvm binary");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .expect("make nvm binary executable");
        }

        let candidates = nvm_candidates(directory.path(), "codex");
        assert_eq!(candidates.len(), 2);
        assert!(candidates[0] < candidates[1]);
        assert_eq!(
            first_path(candidates[1].to_string_lossy().as_bytes()),
            Some(candidates[1].clone())
        );
        assert!(resolve_executable("sh").is_some());
        assert!(resolve_executable("kubecode-agent-that-does-not-exist").is_none());
        assert!(!shell_candidates().is_empty());

        let non_executable = directory.path().join("plain-file");
        fs::write(&non_executable, "plain").expect("write plain file");
        assert!(!is_executable(&non_executable));
        assert_eq!(first_executable(vec![non_executable.clone()]), None);
        assert_eq!(
            first_path(non_executable.to_string_lossy().as_bytes()),
            None
        );
        assert!(!is_executable(directory.path()));
        assert!(!is_executable(&directory.path().join("missing")));
        assert!(nvm_candidates(&directory.path().join("missing-home"), "codex").is_empty());
    }

    #[test]
    fn exposes_stable_unavailable_catalog_and_diagnostics() {
        let agents = supported_agents_unavailable();
        assert_eq!(agents.len(), 3);
        assert_eq!(agents[0].id, AgentId::ClaudeCode);
        assert_eq!(agents[1].id, AgentId::Codex);
        assert_eq!(agents[2].id, AgentId::OpenCode);
        assert!(agents.iter().all(|agent| !agent.available));
        assert_eq!(
            first_line(b"\n  version 1\nsecond"),
            Some("version 1".into())
        );
        assert_eq!(first_line(b"\n \n"), None);
    }
}
