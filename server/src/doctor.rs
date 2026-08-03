use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::time::timeout;

use crate::agent_discovery::{AgentCatalogEntry, AgentReadiness, discover_agent_catalog};
use crate::config::ServerConfig;

const CHECK_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorStatus {
    Ready,
    Warning,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct DoctorCheck {
    pub id: &'static str,
    pub status: DoctorStatus,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DoctorReport {
    pub schema_version: u8,
    pub version: &'static str,
    pub platform: String,
    pub overall: DoctorStatus,
    pub checks: Vec<DoctorCheck>,
    pub agents: Vec<AgentCatalogEntry>,
}

impl DoctorReport {
    pub async fn collect(config: &ServerConfig) -> Self {
        let mut checks = vec![
            directory_check("workspace_root", &config.workspace_root, true),
            directory_check("state_directory", &config.state_directory, false),
            static_assets_check(&config.static_directory),
            git_check().await,
        ];
        let agents = discover_agent_catalog().await;
        let ready_agents = agents
            .iter()
            .filter(|agent| agent.readiness == AgentReadiness::Ready)
            .count();
        checks.push(DoctorCheck {
            id: "agent_runtime",
            status: if ready_agents > 0 {
                DoctorStatus::Ready
            } else {
                DoctorStatus::Error
            },
            detail: if ready_agents > 0 {
                format!("{ready_agents} Agent runtime(s) ready")
            } else {
                "No Agent runtime is ready".to_owned()
            },
        });
        let overall = report_status(&checks, &agents);
        Self {
            schema_version: 1,
            version: env!("CARGO_PKG_VERSION"),
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            overall,
            checks,
            agents,
        }
    }

    pub fn success(&self) -> bool {
        self.overall != DoctorStatus::Error
    }

    pub fn render_text(&self) -> String {
        let any_ready = self
            .agents
            .iter()
            .any(|agent| agent.readiness == AgentReadiness::Ready);
        let mut output = vec![
            format!("Kubecode {} ({})", self.version, self.platform),
            String::new(),
        ];
        for check in &self.checks {
            output.push(format!(
                "{} {:<18} {}",
                status_mark(check.status),
                check.id,
                check.detail
            ));
        }
        output.push(String::new());
        output.push("Agents".to_owned());
        for agent in &self.agents {
            let name = match agent.descriptor.id {
                crate::agents::AgentId::ClaudeCode => "Claude Code",
                crate::agents::AgentId::Codex => "Codex",
                crate::agents::AgentId::OpenCode => "OpenCode",
            };
            let version = agent
                .descriptor
                .version
                .as_deref()
                .unwrap_or("version unavailable");
            let detail = agent.descriptor.error.as_deref().unwrap_or(version);
            output.push(format!(
                "{} {:<18} {}",
                status_mark(match agent.readiness {
                    AgentReadiness::Ready => DoctorStatus::Ready,
                    AgentReadiness::Degraded => DoctorStatus::Warning,
                    AgentReadiness::Unavailable if any_ready => DoctorStatus::Warning,
                    AgentReadiness::Unavailable => DoctorStatus::Error,
                }),
                name,
                detail
            ));
        }
        output.join("\n")
    }
}

fn report_status(checks: &[DoctorCheck], agents: &[AgentCatalogEntry]) -> DoctorStatus {
    if checks
        .iter()
        .any(|check| check.status == DoctorStatus::Error)
        || !agents
            .iter()
            .any(|agent| agent.readiness == AgentReadiness::Ready)
    {
        DoctorStatus::Error
    } else if checks
        .iter()
        .any(|check| check.status == DoctorStatus::Warning)
        || agents
            .iter()
            .any(|agent| agent.readiness != AgentReadiness::Ready)
    {
        DoctorStatus::Warning
    } else {
        DoctorStatus::Ready
    }
}

fn directory_check(id: &'static str, path: &Path, must_exist: bool) -> DoctorCheck {
    let target = if path.exists() {
        Some(path.to_path_buf())
    } else {
        nearest_existing_parent(path)
    };
    match target.and_then(|target| target.metadata().ok().map(|metadata| (target, metadata))) {
        Some((target, metadata)) if metadata.is_dir() && (!must_exist || path.exists()) => {
            DoctorCheck {
                id,
                status: if path.exists() {
                    DoctorStatus::Ready
                } else {
                    DoctorStatus::Warning
                },
                detail: if path.exists() {
                    format!("{} is accessible", path.display())
                } else {
                    format!(
                        "{} will be created below {}",
                        path.display(),
                        target.display()
                    )
                },
            }
        }
        _ => DoctorCheck {
            id,
            status: DoctorStatus::Error,
            detail: format!("{} is not an accessible directory", path.display()),
        },
    }
}

fn nearest_existing_parent(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|candidate| candidate.exists())
        .map(PathBuf::from)
}

fn static_assets_check(path: &Path) -> DoctorCheck {
    let index = path.join("index.html");
    DoctorCheck {
        id: "static_assets",
        status: if index.is_file() {
            DoctorStatus::Ready
        } else {
            DoctorStatus::Error
        },
        detail: if index.is_file() {
            format!("{} is readable", index.display())
        } else {
            format!("{} is missing", index.display())
        },
    }
}

async fn git_check() -> DoctorCheck {
    let output = timeout(
        CHECK_TIMEOUT,
        Command::new("git")
            .arg("--version")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output(),
    )
    .await;
    match output {
        Ok(Ok(output)) if output.status.success() => DoctorCheck {
            id: "git",
            status: DoctorStatus::Ready,
            detail: String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        },
        Ok(Ok(output)) => DoctorCheck {
            id: "git",
            status: DoctorStatus::Error,
            detail: format!("git --version exited with {}", output.status),
        },
        Ok(Err(error)) => DoctorCheck {
            id: "git",
            status: DoctorStatus::Error,
            detail: error.to_string(),
        },
        Err(_) => DoctorCheck {
            id: "git",
            status: DoctorStatus::Error,
            detail: "git --version timed out".to_owned(),
        },
    }
}

fn status_mark(status: DoctorStatus) -> &'static str {
    match status {
        DoctorStatus::Ready => "[ok]",
        DoctorStatus::Warning => "[warn]",
        DoctorStatus::Error => "[error]",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_requires_one_ready_agent_and_preserves_json_schema() {
        let checks = vec![DoctorCheck {
            id: "git",
            status: DoctorStatus::Ready,
            detail: "git version test".to_owned(),
        }];
        let agents = crate::agent_discovery::supported_agents_unavailable()
            .into_iter()
            .map(AgentCatalogEntry::from_descriptor)
            .collect::<Vec<_>>();
        assert_eq!(report_status(&checks, &agents), DoctorStatus::Error);

        let report = DoctorReport {
            schema_version: 1,
            version: "test",
            platform: "linux-x86_64".to_owned(),
            overall: DoctorStatus::Error,
            checks,
            agents,
        };
        let json = serde_json::to_value(&report).expect("doctor report");
        assert_eq!(json["schema_version"], 1);
        assert!(!report.success());
        assert!(report.render_text().contains("Kubecode test"));
    }
}
