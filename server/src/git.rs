use std::collections::HashSet;
use std::path::{Component, Path};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::process::Command;

use crate::workspace::{WorkspaceError, WorkspaceService};

#[derive(Debug, Error)]
pub enum GitError {
    #[error("invalid git path: {0}")]
    InvalidPath(String),
    #[error("commit message must not be empty")]
    EmptyMessage,
    #[error("git command failed: {0}")]
    Command(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitFileChange {
    pub path: String,
    pub index_status: Option<char>,
    pub worktree_status: Option<char>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitStatus {
    pub is_repository: bool,
    pub branch: Option<String>,
    pub files: Vec<GitFileChange>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitMutation {
    Stage,
    Unstage,
    Discard,
}

#[derive(Clone)]
pub struct GitService {
    workspace: Arc<WorkspaceService>,
}

impl GitService {
    pub fn new(workspace: Arc<WorkspaceService>) -> Self {
        Self { workspace }
    }

    pub async fn status(&self, project_id: &str) -> Result<GitStatus, GitError> {
        let cwd = self.workspace.project_path(project_id)?;
        let repository = Command::new("git")
            .args(["rev-parse", "--is-inside-work-tree"])
            .current_dir(&cwd)
            .output()
            .await?;
        if !repository.status.success() {
            return Ok(GitStatus {
                is_repository: false,
                branch: None,
                files: Vec::new(),
            });
        }
        let output = git_output(&cwd, &["status", "--porcelain=v1", "-z", "--branch"]).await?;
        parse_status(&output)
    }

    pub async fn initialize(&self, project_id: &str) -> Result<GitStatus, GitError> {
        let cwd = self.workspace.project_path(project_id)?;
        git_output(&cwd, &["init"]).await?;
        self.status(project_id).await
    }

    pub async fn diff(
        &self,
        project_id: &str,
        path: &str,
        staged: bool,
    ) -> Result<String, GitError> {
        validate_path(path)?;
        let cwd = self.workspace.project_path(project_id)?;
        let mut arguments = vec!["diff"];
        if staged {
            arguments.push("--cached");
        }
        arguments.extend(["--", path]);
        Ok(String::from_utf8_lossy(&git_output(&cwd, &arguments).await?).into_owned())
    }

    pub async fn mutate(
        &self,
        project_id: &str,
        mutation: GitMutation,
        paths: &[String],
    ) -> Result<GitStatus, GitError> {
        if paths.is_empty() {
            return Err(GitError::InvalidPath(
                "at least one path is required".into(),
            ));
        }
        for path in paths {
            validate_path(path)?;
        }
        let cwd = self.workspace.project_path(project_id)?;
        match mutation {
            GitMutation::Stage => git_paths(&cwd, &["add"], paths).await?,
            GitMutation::Unstage => {
                if git_succeeds(&cwd, &["rev-parse", "--verify", "HEAD"]).await? {
                    git_paths(&cwd, &["restore", "--staged"], paths).await?;
                } else {
                    git_paths(&cwd, &["rm", "--cached", "-r"], paths).await?;
                }
            }
            GitMutation::Discard => self.discard_paths(project_id, &cwd, paths).await?,
        }
        self.status(project_id).await
    }

    pub async fn commit(&self, project_id: &str, message: &str) -> Result<GitStatus, GitError> {
        let message = message.trim();
        if message.is_empty() {
            return Err(GitError::EmptyMessage);
        }
        let cwd = self.workspace.project_path(project_id)?;
        git_output(&cwd, &["commit", "-m", message]).await?;
        self.status(project_id).await
    }

    async fn discard_paths(
        &self,
        project_id: &str,
        cwd: &Path,
        paths: &[String],
    ) -> Result<(), GitError> {
        let untracked = self
            .status(project_id)
            .await?
            .files
            .into_iter()
            .filter(|file| file.index_status == Some('?') && file.worktree_status == Some('?'))
            .map(|file| file.path)
            .collect::<HashSet<_>>();
        let (untracked_paths, tracked_paths): (Vec<_>, Vec<_>) = paths
            .iter()
            .partition(|path| untracked.contains(path.as_str()));
        if !tracked_paths.is_empty() {
            git_paths(cwd, &["restore", "--worktree"], &tracked_paths).await?;
        }
        if !untracked_paths.is_empty() {
            git_paths(cwd, &["clean", "-f", "-d"], &untracked_paths).await?;
        }
        Ok(())
    }
}

async fn git_paths<T>(cwd: &Path, prefix: &[&str], paths: &[T]) -> Result<(), GitError>
where
    T: AsRef<str>,
{
    let mut arguments = prefix.to_vec();
    arguments.push("--");
    arguments.extend(paths.iter().map(|path| path.as_ref()));
    git_output(cwd, &arguments).await?;
    Ok(())
}

async fn git_succeeds(cwd: &Path, arguments: &[&str]) -> Result<bool, GitError> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await?;
    Ok(output.status.success())
}

async fn git_output(cwd: &Path, arguments: &[&str]) -> Result<Vec<u8>, GitError> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(GitError::Command(if message.is_empty() {
        format!("git {} exited with {}", arguments.join(" "), output.status)
    } else {
        message
    }))
}

fn parse_status(output: &[u8]) -> Result<GitStatus, GitError> {
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut branch = None;
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        let text = String::from_utf8_lossy(record);
        if let Some(value) = text.strip_prefix("## ") {
            branch = Some(value.split("...").next().unwrap_or(value).to_owned());
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err(GitError::Command(
                "git returned an invalid status record".into(),
            ));
        }
        let index_status = status_character(record[0]);
        let worktree_status = status_character(record[1]);
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let renamed = matches!(index_status, Some('R' | 'C'));
        files.push(GitFileChange {
            path,
            index_status,
            worktree_status,
        });
        if renamed {
            let _ = records.next();
        }
    }
    Ok(GitStatus {
        is_repository: true,
        branch,
        files,
    })
}

fn status_character(value: u8) -> Option<char> {
    (value != b' ').then_some(value as char)
}

fn validate_path(path: &str) -> Result<(), GitError> {
    let candidate = Path::new(path);
    let valid = !path.is_empty()
        && !candidate.is_absolute()
        && candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if valid {
        Ok(())
    } else {
        Err(GitError::InvalidPath(path.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_status_without_shell_interpolation() {
        let status =
            parse_status(b"## main\0 M src/main.rs\0A  README.md\0?? notes.txt\0").expect("status");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.files.len(), 3);
        assert_eq!(status.files[0].worktree_status, Some('M'));
        assert_eq!(status.files[1].index_status, Some('A'));
        assert_eq!(status.files[2].index_status, Some('?'));
    }

    #[test]
    fn rejects_paths_outside_the_project() {
        assert!(validate_path("src/main.rs").is_ok());
        assert!(validate_path("../secret").is_err());
        assert!(validate_path("/etc/passwd").is_err());
    }
}
