use std::ffi::OsString;
use std::path::PathBuf;

use clap::Parser;
use thiserror::Error;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8888;
const PERSISTENT_DIR_DEPRECATION: &str =
    "PERSISTENT_DIR is deprecated; use KUBECODE_WORKSPACE_ROOT and KUBECODE_STATE_DIR";

#[derive(Debug, Parser)]
#[command(
    name = "kubecode",
    version,
    about = "Browser-based, project-oriented AI coding workspace"
)]
pub struct ServerOptions {
    /// Address on which the HTTP server listens.
    #[arg(long)]
    pub host: Option<String>,

    /// Port on which the HTTP server listens.
    #[arg(long)]
    pub port: Option<u16>,

    /// URL path below which Kubecode is served.
    #[arg(long)]
    pub base_path: Option<String>,

    /// Directory containing Kubecode's SQLite state.
    #[arg(long, value_name = "PATH")]
    pub state_dir: Option<PathBuf>,

    /// Default root exposed by the server-side directory picker.
    #[arg(long, value_name = "PATH")]
    pub workspace_root: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub base_path: String,
    pub state_directory: PathBuf,
    pub workspace_root: PathBuf,
    pub static_directory: PathBuf,
    pub deprecations: Vec<&'static str>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("{name} must be an absolute path: {path}")]
    RelativePath { name: &'static str, path: String },
    #[error("{name} must be a valid port: {value}")]
    InvalidPort { name: &'static str, value: String },
    #[error("HOME is not set; pass --workspace-root and --state-dir explicitly")]
    MissingHome,
}

impl ServerOptions {
    pub fn resolve(self) -> Result<ServerConfig, ConfigError> {
        self.resolve_with(|key| std::env::var_os(key))
    }

    fn resolve_with(
        self,
        environment: impl Fn(&str) -> Option<OsString>,
    ) -> Result<ServerConfig, ConfigError> {
        let mut deprecations = Vec::new();
        let persistent_directory = env_path(&environment, "PERSISTENT_DIR");

        let host = self
            .host
            .or_else(|| env_string(&environment, "KUBECODE_HOST"))
            .or_else(|| {
                env_string(&environment, "HOST").inspect(|_| {
                    deprecations.push("HOST is deprecated; use KUBECODE_HOST or --host")
                })
            })
            .unwrap_or_else(|| DEFAULT_HOST.to_owned());

        let port = match self.port {
            Some(port) => port,
            None => match env_string(&environment, "KUBECODE_PORT") {
                Some(value) => parse_port("KUBECODE_PORT", value)?,
                None => match env_string(&environment, "PORT") {
                    Some(value) => {
                        deprecations.push("PORT is deprecated; use KUBECODE_PORT or --port");
                        parse_port("PORT", value)?
                    }
                    None => DEFAULT_PORT,
                },
            },
        };

        let base_path = normalize_base_path(
            self.base_path
                .or_else(|| env_string(&environment, "KUBECODE_BASE_PATH"))
                .or_else(|| {
                    env_string(&environment, "NB_PREFIX").inspect(|_| {
                        deprecations
                            .push("NB_PREFIX is deprecated; use KUBECODE_BASE_PATH or --base-path")
                    })
                })
                .as_deref()
                .unwrap_or("/"),
        );

        let home = env_path(&environment, "HOME");
        let workspace_root = match self
            .workspace_root
            .or_else(|| env_path(&environment, "KUBECODE_WORKSPACE_ROOT"))
        {
            Some(path) => path,
            None => match persistent_directory.clone() {
                Some(path) => {
                    deprecations.push(PERSISTENT_DIR_DEPRECATION);
                    path
                }
                None => home.clone().ok_or(ConfigError::MissingHome)?,
            },
        };
        validate_absolute("workspace root", &workspace_root)?;

        let state_directory = match self
            .state_dir
            .or_else(|| env_path(&environment, "KUBECODE_STATE_DIR"))
        {
            Some(path) => path,
            None => match persistent_directory {
                Some(path) => {
                    if !deprecations.contains(&PERSISTENT_DIR_DEPRECATION) {
                        deprecations.push(PERSISTENT_DIR_DEPRECATION);
                    }
                    path.join(".state/kubecode")
                }
                None => match env_path(&environment, "XDG_DATA_HOME")
                    .filter(|path| path.is_absolute())
                {
                    Some(path) => path.join("kubecode"),
                    None => home
                        .ok_or(ConfigError::MissingHome)?
                        .join(".local/share/kubecode"),
                },
            },
        };
        validate_absolute("state directory", &state_directory)?;

        let static_directory =
            env_path(&environment, "KUBECODE_STATIC_DIR").unwrap_or_else(|| PathBuf::from("dist"));

        Ok(ServerConfig {
            host,
            port,
            base_path,
            state_directory,
            workspace_root,
            static_directory,
            deprecations,
        })
    }
}

fn env_string(environment: &impl Fn(&str) -> Option<OsString>, name: &str) -> Option<String> {
    environment(name)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string_lossy().into_owned())
}

fn env_path(environment: &impl Fn(&str) -> Option<OsString>, name: &str) -> Option<PathBuf> {
    environment(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn parse_port(name: &'static str, value: String) -> Result<u16, ConfigError> {
    value
        .parse::<u16>()
        .map_err(|_| ConfigError::InvalidPort { name, value })
}

fn validate_absolute(name: &'static str, path: &std::path::Path) -> Result<(), ConfigError> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(ConfigError::RelativePath {
            name,
            path: path.to_string_lossy().into_owned(),
        })
    }
}

pub fn normalize_base_path(base_path: &str) -> String {
    let trimmed = base_path.trim().trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("/{trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn resolve(args: &[&str], environment: &[(&str, &str)]) -> Result<ServerConfig, ConfigError> {
        let options = ServerOptions::try_parse_from(args).expect("valid arguments");
        let environment = environment
            .iter()
            .map(|(key, value)| ((*key).to_owned(), OsString::from(value)))
            .collect::<HashMap<_, _>>();
        options.resolve_with(|key| environment.get(key).cloned())
    }

    #[test]
    fn standalone_defaults_use_loopback_home_and_xdg_state() {
        let config = resolve(
            &["kubecode"],
            &[
                ("HOME", "/home/researcher"),
                ("XDG_DATA_HOME", "/data/researcher"),
            ],
        )
        .expect("config");

        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 8888);
        assert_eq!(config.base_path, "");
        assert_eq!(config.workspace_root, PathBuf::from("/home/researcher"));
        assert_eq!(
            config.state_directory,
            PathBuf::from("/data/researcher/kubecode")
        );
        assert!(config.deprecations.is_empty());
    }

    #[test]
    fn cli_values_win_over_current_and_legacy_environment() {
        let config = resolve(
            &[
                "kubecode",
                "--host",
                "127.0.0.2",
                "--port",
                "9000",
                "--base-path",
                "/workspace/",
                "--workspace-root",
                "/projects",
                "--state-dir",
                "/state",
            ],
            &[
                ("HOME", "/home/researcher"),
                ("KUBECODE_HOST", "127.0.0.3"),
                ("HOST", "0.0.0.0"),
                ("NB_PREFIX", "/legacy"),
                ("PERSISTENT_DIR", "/legacy"),
            ],
        )
        .expect("config");

        assert_eq!(config.host, "127.0.0.2");
        assert_eq!(config.port, 9000);
        assert_eq!(config.base_path, "/workspace");
        assert_eq!(config.workspace_root, PathBuf::from("/projects"));
        assert_eq!(config.state_directory, PathBuf::from("/state"));
        assert!(config.deprecations.is_empty());
    }

    #[test]
    fn legacy_environment_preserves_paths_with_warnings() {
        let config = resolve(
            &["kubecode"],
            &[
                ("HOME", "/home/jovyan"),
                ("HOST", "0.0.0.0"),
                ("PORT", "8889"),
                ("NB_PREFIX", "/user/test/kubecode"),
                ("PERSISTENT_DIR", "/home/jovyan/srv"),
            ],
        )
        .expect("config");

        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.port, 8889);
        assert_eq!(config.base_path, "/user/test/kubecode");
        assert_eq!(config.workspace_root, PathBuf::from("/home/jovyan/srv"));
        assert_eq!(
            config.state_directory,
            PathBuf::from("/home/jovyan/srv/.state/kubecode")
        );
        assert_eq!(config.deprecations.len(), 4);
    }

    #[test]
    fn relative_state_paths_are_rejected() {
        let error = resolve(
            &["kubecode", "--state-dir", "relative"],
            &[("HOME", "/home/researcher")],
        )
        .expect_err("relative state");

        assert_eq!(
            error,
            ConfigError::RelativePath {
                name: "state directory",
                path: "relative".to_owned(),
            }
        );
    }
}
