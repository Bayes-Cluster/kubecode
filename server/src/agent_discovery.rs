use std::env;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::task::JoinSet;
use tokio::time::timeout;

use crate::agents::AgentId;

const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
const DISABLE_LOGIN_SHELL_DISCOVERY: &str = "KUBECODE_DISABLE_LOGIN_SHELL_DISCOVERY";

#[derive(Clone, Debug)]
pub struct AgentCandidate {
    pub id: AgentId,
    pub executable: PathBuf,
    pub source: AgentDiscoverySource,
}

impl AgentCandidate {
    pub fn new(id: AgentId, executable: impl Into<PathBuf>) -> Self {
        Self {
            id,
            executable: executable.into(),
            source: AgentDiscoverySource::Unresolved,
        }
    }

    fn with_source(
        id: AgentId,
        executable: impl Into<PathBuf>,
        source: AgentDiscoverySource,
    ) -> Self {
        Self {
            id,
            executable: executable.into(),
            source,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentDiscoverySource {
    Environment,
    Path,
    LoginShell,
    KnownLocation,
    Unresolved,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentComponentStatus {
    Ready,
    Missing,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentAdapterKind {
    Bundled,
    Native,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentReadiness {
    Ready,
    Degraded,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentComponentDiagnostic {
    pub status: AgentComponentStatus,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub source: Option<AgentDiscoverySource>,
    pub error_code: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentAdapterDiagnostic {
    pub kind: AgentAdapterKind,
    #[serde(flatten)]
    pub component: AgentComponentDiagnostic,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentCatalogEntry {
    #[serde(flatten)]
    pub descriptor: AgentDescriptor,
    pub checked_at: u64,
    pub readiness: AgentReadiness,
    pub cli: AgentComponentDiagnostic,
    pub adapter: AgentAdapterDiagnostic,
}

pub struct AgentCatalog {
    entries: RwLock<Vec<AgentCatalogEntry>>,
    generation: AtomicU64,
    refresh: tokio::sync::Mutex<()>,
}

impl AgentCatalog {
    pub fn pending() -> Arc<Self> {
        Arc::new(Self::from_entries(
            supported_agents_unavailable()
                .into_iter()
                .map(AgentCatalogEntry::from_descriptor)
                .collect(),
        ))
    }

    pub fn from_descriptors(descriptors: Vec<AgentDescriptor>) -> Arc<Self> {
        Arc::new(Self::from_entries(
            descriptors
                .into_iter()
                .map(AgentCatalogEntry::from_descriptor)
                .collect(),
        ))
    }

    pub fn from_entries(entries: Vec<AgentCatalogEntry>) -> Self {
        Self {
            entries: RwLock::new(entries),
            generation: AtomicU64::new(0),
            refresh: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn discover() -> Arc<Self> {
        Arc::new(Self::from_entries(discover_agent_catalog().await))
    }

    pub async fn refresh(&self) -> Vec<AgentCatalogEntry> {
        let observed_generation = self.generation.load(Ordering::Acquire);
        let _refresh = self.refresh.lock().await;
        if self.generation.load(Ordering::Acquire) != observed_generation {
            return self.entries();
        }
        let entries = discover_agent_catalog().await;
        *self.entries.write().expect("agent catalog poisoned") = entries.clone();
        self.generation.fetch_add(1, Ordering::Release);
        entries
    }

    pub fn entries(&self) -> Vec<AgentCatalogEntry> {
        self.entries.read().expect("agent catalog poisoned").clone()
    }

    pub fn descriptors(&self) -> Vec<AgentDescriptor> {
        self.entries()
            .into_iter()
            .map(|entry| entry.descriptor)
            .collect()
    }

    pub fn descriptor(&self, id: AgentId) -> Option<AgentDescriptor> {
        self.entries
            .read()
            .expect("agent catalog poisoned")
            .iter()
            .find(|entry| entry.descriptor.id == id)
            .map(|entry| entry.descriptor.clone())
    }

    pub fn is_available(&self, id: AgentId) -> bool {
        self.descriptor(id).is_some_and(|agent| agent.available)
    }
}

impl AgentCatalogEntry {
    pub(crate) fn from_descriptor(descriptor: AgentDescriptor) -> Self {
        let checked_at = checked_at();
        let status = if descriptor.available {
            AgentComponentStatus::Ready
        } else {
            AgentComponentStatus::Missing
        };
        let error_code = (!descriptor.available).then(|| "agent_not_discovered".to_owned());
        let cli = AgentComponentDiagnostic {
            status,
            executable: Some(descriptor.executable.clone()),
            version: descriptor.version.clone(),
            source: Some(AgentDiscoverySource::Unresolved),
            error_code: error_code.clone(),
            detail: descriptor.error.clone(),
        };
        let adapter = AgentAdapterDiagnostic {
            kind: if descriptor.id == AgentId::OpenCode {
                AgentAdapterKind::Native
            } else {
                AgentAdapterKind::Bundled
            },
            component: AgentComponentDiagnostic {
                status,
                executable: None,
                version: None,
                source: None,
                error_code,
                detail: descriptor.error.clone(),
            },
        };
        Self {
            readiness: if descriptor.available {
                AgentReadiness::Ready
            } else {
                AgentReadiness::Unavailable
            },
            descriptor,
            checked_at,
            cli,
            adapter,
        }
    }
}

pub async fn discover_agents() -> Vec<AgentDescriptor> {
    discover_agent_catalog()
        .await
        .into_iter()
        .map(|entry| entry.descriptor)
        .collect()
}

pub async fn discover_agent_catalog() -> Vec<AgentCatalogEntry> {
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
            probe_entry(candidate).await
        });
    }
    collect_entries(tasks).await
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

async fn collect_entries(mut tasks: JoinSet<AgentCatalogEntry>) -> Vec<AgentCatalogEntry> {
    let mut entries = Vec::with_capacity(3);
    while let Some(result) = tasks.join_next().await {
        if let Ok(entry) = result {
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| agent_order(entry.descriptor.id));
    entries
}

fn resolve_agent_candidate(id: AgentId, variable: &str, name: &str) -> AgentCandidate {
    if let Some(executable) = env::var_os(variable).map(PathBuf::from) {
        return AgentCandidate::with_source(id, executable, AgentDiscoverySource::Environment);
    }
    if let Some((executable, source)) = resolve_executable_with_source(name) {
        return AgentCandidate::with_source(id, executable, source);
    }
    if let Some(executable) = env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|home| first_executable(agent_binary_candidates(id, &home)))
    {
        return AgentCandidate::with_source(id, executable, AgentDiscoverySource::KnownLocation);
    }
    AgentCandidate::new(id, name)
}

pub(crate) fn resolve_executable(name: &str) -> Option<PathBuf> {
    resolve_executable_with_source(name).map(|(path, _)| path)
}

fn resolve_executable_with_source(name: &str) -> Option<(PathBuf, AgentDiscoverySource)> {
    find_on_inherited_path(name)
        .map(|path| (path, AgentDiscoverySource::Path))
        .or_else(|| {
            (!login_shell_discovery_disabled(
                env::var(DISABLE_LOGIN_SHELL_DISCOVERY).ok().as_deref(),
            ))
            .then(|| find_in_login_shell(name))
            .flatten()
            .map(|path| (path, AgentDiscoverySource::LoginShell))
        })
}

fn login_shell_discovery_disabled(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
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

async fn probe_entry(candidate: AgentCandidate) -> AgentCatalogEntry {
    let source = candidate.source;
    let id = candidate.id;
    let descriptor = probe(candidate).await;
    let cli = AgentComponentDiagnostic {
        status: if descriptor.available {
            AgentComponentStatus::Ready
        } else if Path::new(&descriptor.executable).exists() {
            AgentComponentStatus::Error
        } else {
            AgentComponentStatus::Missing
        },
        executable: Some(descriptor.executable.clone()),
        version: descriptor.version.clone(),
        source: Some(source),
        error_code: descriptor.error.as_ref().map(|error| {
            if error.contains("timed out") {
                "agent_version_timeout"
            } else if Path::new(&descriptor.executable).exists() {
                "agent_version_failed"
            } else {
                "agent_cli_missing"
            }
            .to_owned()
        }),
        detail: descriptor.error.clone(),
    };
    let adapter = probe_adapter(id, &descriptor).await;
    let readiness = match (cli.status, adapter.component.status) {
        (AgentComponentStatus::Ready, AgentComponentStatus::Ready) => AgentReadiness::Ready,
        (AgentComponentStatus::Ready, _) => AgentReadiness::Degraded,
        _ => AgentReadiness::Unavailable,
    };
    let available = readiness == AgentReadiness::Ready;
    let error = if available {
        None
    } else {
        cli.detail
            .clone()
            .or_else(|| adapter.component.detail.clone())
    };
    AgentCatalogEntry {
        descriptor: AgentDescriptor {
            available,
            error,
            ..descriptor
        },
        checked_at: checked_at(),
        readiness,
        cli,
        adapter,
    }
}

async fn probe_adapter(id: AgentId, descriptor: &AgentDescriptor) -> AgentAdapterDiagnostic {
    if id == AgentId::OpenCode {
        return AgentAdapterDiagnostic {
            kind: AgentAdapterKind::Native,
            component: AgentComponentDiagnostic {
                status: if descriptor.available {
                    AgentComponentStatus::Ready
                } else {
                    AgentComponentStatus::Missing
                },
                executable: Some(descriptor.executable.clone()),
                version: descriptor.version.clone(),
                source: None,
                error_code: (!descriptor.available).then(|| "agent_cli_missing".to_owned()),
                detail: descriptor.error.clone(),
            },
        };
    }
    let (variable, binary) = match id {
        AgentId::ClaudeCode => ("KUBECODE_CLAUDE_ACP_PATH", "claude-agent-acp"),
        AgentId::Codex => ("KUBECODE_CODEX_ACP_PATH", "codex-acp"),
        AgentId::OpenCode => unreachable!(),
    };
    let Some(executable) = configured_adapter_path(variable, binary) else {
        return AgentAdapterDiagnostic {
            kind: AgentAdapterKind::Bundled,
            component: AgentComponentDiagnostic {
                status: AgentComponentStatus::Missing,
                executable: Some(binary.to_owned()),
                version: None,
                source: None,
                error_code: Some("agent_adapter_missing".to_owned()),
                detail: Some(format!(
                    "{binary} is not installed; set {variable} to its executable path"
                )),
            },
        };
    };
    let executable_text = executable.to_string_lossy().into_owned();
    let output = timeout(
        VERSION_TIMEOUT,
        Command::new(&executable).arg("--version").output(),
    )
    .await;
    let component = match output {
        Err(_) => AgentComponentDiagnostic {
            status: AgentComponentStatus::Error,
            executable: Some(executable_text),
            version: None,
            source: None,
            error_code: Some("agent_adapter_timeout".to_owned()),
            detail: Some("adapter version probe timed out".to_owned()),
        },
        Ok(Err(error)) => AgentComponentDiagnostic {
            status: AgentComponentStatus::Error,
            executable: Some(executable_text),
            version: None,
            source: None,
            error_code: Some("agent_adapter_failed".to_owned()),
            detail: Some(error.to_string()),
        },
        Ok(Ok(output)) if !output.status.success() => AgentComponentDiagnostic {
            status: AgentComponentStatus::Error,
            executable: Some(executable_text),
            version: None,
            source: None,
            error_code: Some("agent_adapter_failed".to_owned()),
            detail: first_line(&output.stderr)
                .or_else(|| first_line(&output.stdout))
                .or_else(|| Some(format!("adapter exited with {}", output.status))),
        },
        Ok(Ok(output)) => AgentComponentDiagnostic {
            status: AgentComponentStatus::Ready,
            executable: Some(executable_text),
            version: first_line(&output.stdout).or_else(|| first_line(&output.stderr)),
            source: None,
            error_code: None,
            detail: None,
        },
    };
    AgentAdapterDiagnostic {
        kind: AgentAdapterKind::Bundled,
        component,
    }
}

pub(crate) fn configured_adapter_path(variable: &str, default: &str) -> Option<PathBuf> {
    if let Some(configured) = env::var_os(variable).map(PathBuf::from) {
        return executable_path(configured);
    }
    local_adapter(default).or_else(|| resolve_executable(default))
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
    if name == "claude-agent-acp" {
        let launcher = project_root.join("packaging/bin/claude-agent-acp");
        if is_executable(&launcher) {
            return Some(launcher);
        }
    }
    let candidate = project_root
        .join("packaging/adapter-runtime/node_modules/.bin")
        .join(name);
    is_executable(&candidate).then_some(candidate)
}

fn checked_at() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
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

    #[test]
    fn native_runtime_can_disable_login_shell_discovery() {
        for value in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(login_shell_discovery_disabled(Some(value)));
        }
        for value in [None, Some(""), Some("0"), Some("false"), Some("off")] {
            assert!(!login_shell_discovery_disabled(value));
        }
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
