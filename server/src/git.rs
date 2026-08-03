use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path};
use std::process::{Command as BlockingCommand, Stdio};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::process::Command as TokioCommand;

use crate::agents::ExecutionMode;
use crate::workspace::{WorkspaceError, WorkspaceService, is_generated_relative_path};

pub const MAX_GIT_DIFF_CONTEXT_FILES: usize = 32;
pub const MAX_GIT_DIFF_CONTEXT_HUNKS: usize = 128;
pub const MAX_GIT_DIFF_CONTEXT_BYTES: usize = 64 * 1024;
pub const MAX_GIT_DIFF_FILE_CONTEXT_HUNKS: usize = 64;
pub const MAX_GIT_DIFF_FILE_CONTEXT_BYTES: usize = 32 * 1024;
pub const MAX_GIT_STATUS_BYTES: usize = 1024 * 1024;
pub const MAX_GIT_STATUS_RECORDS: usize = 10_000;
pub const MAX_GIT_UI_DIFF_BYTES: usize = 2 * 1024 * 1024;
const MAX_GIT_DIFF_CANDIDATES: usize = 128;
const MAX_GIT_ERROR_BYTES: usize = 16 * 1024;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub index_status: Option<char>,
    pub worktree_status: Option<char>,
    pub conflict: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitStatus {
    pub is_repository: bool,
    pub branch: Option<String>,
    pub files: Vec<GitFileChange>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDiffUnavailableReason {
    Binary,
    Oversized,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDiff {
    pub diff: Option<String>,
    pub unavailable_reason: Option<GitDiffUnavailableReason>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDiffContextCandidate {
    pub path: Option<String>,
    pub source_revision: String,
    pub file_count: usize,
    pub hunk_count: usize,
    pub byte_count: usize,
    pub enabled: bool,
    pub disabled_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDiffContextList {
    pub is_repository: bool,
    pub candidates: Vec<GitDiffContextCandidate>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDiffContextSnapshot {
    pub path: Option<String>,
    pub source_revision: String,
    pub file_count: usize,
    pub hunk_count: usize,
    pub byte_count: usize,
    pub content: String,
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
        tokio::task::spawn_blocking(move || status_blocking(&cwd, true))
            .await
            .map_err(|error| GitError::Command(format!("Git status task failed: {error}")))?
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
    ) -> Result<GitDiff, GitError> {
        let path = self
            .workspace
            .validate_project_relative_path(project_id, path)?;
        let cwd = self.workspace.project_path(project_id)?;
        tokio::task::spawn_blocking(move || ui_diff_blocking(&cwd, &path, staged))
            .await
            .map_err(|error| GitError::Command(format!("Git diff task failed: {error}")))?
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
        let paths = paths
            .iter()
            .map(|path| {
                self.workspace
                    .validate_project_relative_path(project_id, path)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let cwd = self.workspace.project_path(project_id)?;
        match mutation {
            GitMutation::Stage => git_paths(&cwd, &["add"], &paths).await?,
            GitMutation::Unstage => {
                if git_succeeds(&cwd, &["rev-parse", "--verify", "HEAD"]).await? {
                    git_paths(&cwd, &["restore", "--staged"], &paths).await?;
                } else {
                    git_paths(&cwd, &["rm", "--cached", "-r"], &paths).await?;
                }
            }
            GitMutation::Discard => self.discard_paths(project_id, &cwd, &paths).await?,
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

    pub async fn composer_diff_candidates(
        &self,
        project_id: &str,
        agent_session_id: &str,
        execution_mode: ExecutionMode,
        workspace_path: Option<&str>,
    ) -> Result<GitDiffContextList, GitError> {
        let service = self.clone();
        let project_id = project_id.to_owned();
        let agent_session_id = agent_session_id.to_owned();
        let workspace_path = workspace_path.map(str::to_owned);
        tokio::task::spawn_blocking(move || {
            service.composer_diff_candidates_blocking(
                &project_id,
                &agent_session_id,
                execution_mode,
                workspace_path.as_deref(),
            )
        })
        .await
        .map_err(|error| GitError::Command(format!("Git diff context task failed: {error}")))?
    }

    pub async fn resolve_composer_diff(
        &self,
        project_id: &str,
        agent_session_id: &str,
        execution_mode: ExecutionMode,
        workspace_path: Option<&str>,
        path: Option<&str>,
    ) -> Result<GitDiffContextSnapshot, GitError> {
        let service = self.clone();
        let project_id = project_id.to_owned();
        let agent_session_id = agent_session_id.to_owned();
        let workspace_path = workspace_path.map(str::to_owned);
        let path = path.map(str::to_owned);
        tokio::task::spawn_blocking(move || {
            service.resolve_composer_diff_blocking(
                &project_id,
                &agent_session_id,
                execution_mode,
                workspace_path.as_deref(),
                path.as_deref(),
            )
        })
        .await
        .map_err(|error| GitError::Command(format!("Git diff context task failed: {error}")))?
    }

    pub(crate) fn resolve_composer_diff_blocking(
        &self,
        project_id: &str,
        agent_session_id: &str,
        execution_mode: ExecutionMode,
        workspace_path: Option<&str>,
        path: Option<&str>,
    ) -> Result<GitDiffContextSnapshot, GitError> {
        let cwd = self.workspace.session_execution_path(
            project_id,
            agent_session_id,
            execution_mode,
            workspace_path,
        )?;
        let status = status_blocking(&cwd, false)?;
        if !status.is_repository {
            return Err(GitError::Command("not a Git repository".into()));
        }
        let (candidate, content) = resolve_diff_content(&cwd, &status, path)?;
        let content =
            String::from_utf8(content).map_err(|_| GitError::Command("git_diff_binary".into()))?;
        Ok(GitDiffContextSnapshot {
            path: candidate.path,
            source_revision: candidate.source_revision,
            file_count: candidate.file_count,
            hunk_count: candidate.hunk_count,
            byte_count: candidate.byte_count,
            content,
        })
    }

    fn composer_diff_candidates_blocking(
        &self,
        project_id: &str,
        agent_session_id: &str,
        execution_mode: ExecutionMode,
        workspace_path: Option<&str>,
    ) -> Result<GitDiffContextList, GitError> {
        let cwd = self.workspace.session_execution_path(
            project_id,
            agent_session_id,
            execution_mode,
            workspace_path,
        )?;
        let status = status_blocking(&cwd, false)?;
        if !status.is_repository {
            return Ok(GitDiffContextList {
                is_repository: false,
                candidates: Vec::new(),
            });
        }
        Ok(GitDiffContextList {
            is_repository: true,
            candidates: build_diff_candidates(&cwd, &status)?,
        })
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
    let status = TokioCommand::new("git")
        .arg("--no-optional-locks")
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    Ok(status.success())
}

async fn git_output(cwd: &Path, arguments: &[&str]) -> Result<Vec<u8>, GitError> {
    let output = TokioCommand::new("git")
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

fn status_blocking(cwd: &Path, allow_truncated: bool) -> Result<GitStatus, GitError> {
    if !blocking_git_succeeds(cwd, &["rev-parse", "--is-inside-work-tree"])? {
        return Ok(GitStatus {
            is_repository: false,
            branch: None,
            files: Vec::new(),
            truncated: false,
        });
    }
    let (output, truncated) = blocking_status_output(cwd)?;
    if truncated && !allow_truncated {
        return Err(GitError::Command("git status exceeds its bound".into()));
    }
    parse_status(&output, truncated)
}

fn ui_diff_blocking(cwd: &Path, path: &str, staged: bool) -> Result<GitDiff, GitError> {
    let status = status_blocking(cwd, true)?;
    let Some(change) = status.files.iter().find(|change| change.path == path) else {
        return Ok(unavailable_ui_diff(GitDiffUnavailableReason::Unsupported));
    };
    let untracked = change.index_status == Some('?') && change.worktree_status == Some('?');
    if (staged && (change.index_status.is_none() || untracked))
        || (!staged && change.worktree_status.is_none())
    {
        return Ok(unavailable_ui_diff(GitDiffUnavailableReason::Unsupported));
    }

    let mut arguments = vec!["diff"];
    if untracked {
        arguments.push("--no-index");
    } else if staged {
        arguments.push("--cached");
    }
    arguments.extend(["--no-ext-diff", "--no-textconv", "--unified=3", "--"]);
    if untracked {
        arguments.push("/dev/null");
    } else if let Some(original_path) = change.original_path.as_deref() {
        arguments.push(original_path);
    }
    arguments.push(path);

    match blocking_git_output(cwd, &arguments, MAX_GIT_UI_DIFF_BYTES, untracked)? {
        BoundedGitOutput::OverLimit(_) => {
            Ok(unavailable_ui_diff(GitDiffUnavailableReason::Oversized))
        }
        BoundedGitOutput::Complete(content) if contains_binary_marker(&content) => {
            Ok(unavailable_ui_diff(GitDiffUnavailableReason::Binary))
        }
        BoundedGitOutput::Complete(content) => match String::from_utf8(content) {
            Ok(diff) => Ok(GitDiff {
                diff: Some(diff),
                unavailable_reason: None,
            }),
            Err(_) => Ok(unavailable_ui_diff(GitDiffUnavailableReason::Unsupported)),
        },
    }
}

fn unavailable_ui_diff(reason: GitDiffUnavailableReason) -> GitDiff {
    GitDiff {
        diff: None,
        unavailable_reason: Some(reason),
    }
}

fn build_diff_candidates(
    cwd: &Path,
    status: &GitStatus,
) -> Result<Vec<GitDiffContextCandidate>, GitError> {
    if status.files.is_empty() {
        return Ok(vec![disabled_candidate(None, "git_diff_empty", b"")]);
    }
    let mut file_candidates = Vec::new();
    for change in status.files.iter().take(MAX_GIT_DIFF_CANDIDATES) {
        file_candidates.push(file_candidate(cwd, change)?);
    }
    let full = if status.files.len() > MAX_GIT_DIFF_CONTEXT_FILES {
        disabled_candidate(
            None,
            "git_diff_too_many_files",
            status_identity(&status.files).as_bytes(),
        )
    } else {
        match render_full_diff(cwd, &status.files)? {
            Ok(content) => candidate_from_content(
                None,
                status.files.len(),
                content,
                MAX_GIT_DIFF_CONTEXT_HUNKS,
            ),
            Err(reason) => {
                disabled_candidate(None, &reason, status_identity(&status.files).as_bytes())
            }
        }
    };
    let mut candidates = Vec::with_capacity(file_candidates.len() + 1);
    candidates.push(full);
    candidates.extend(file_candidates);
    Ok(candidates)
}

fn file_candidate(cwd: &Path, change: &GitFileChange) -> Result<GitDiffContextCandidate, GitError> {
    if is_generated_relative_path(&change.path) {
        return Ok(disabled_candidate(
            Some(change.path.clone()),
            "git_diff_generated",
            change.path.as_bytes(),
        ));
    }
    match render_file_diff(cwd, change, MAX_GIT_DIFF_FILE_CONTEXT_BYTES)? {
        Ok(content)
            if contains_binary_marker(&content) || std::str::from_utf8(&content).is_err() =>
        {
            Ok(disabled_candidate(
                Some(change.path.clone()),
                "git_diff_binary",
                &content,
            ))
        }
        Ok(content) => Ok(candidate_from_content(
            Some(change.path.clone()),
            1,
            content,
            MAX_GIT_DIFF_FILE_CONTEXT_HUNKS,
        )),
        Err(reason) => Ok(disabled_candidate(
            Some(change.path.clone()),
            &reason,
            change.path.as_bytes(),
        )),
    }
}

fn resolve_diff_content(
    cwd: &Path,
    status: &GitStatus,
    path: Option<&str>,
) -> Result<(GitDiffContextCandidate, Vec<u8>), GitError> {
    if status.files.is_empty() {
        return Err(GitError::Command("git_diff_empty".into()));
    }
    let (candidate, content) = if let Some(path) = path {
        let change = status
            .files
            .iter()
            .find(|change| change.path == path)
            .ok_or_else(|| GitError::InvalidPath(path.to_owned()))?;
        if is_generated_relative_path(&change.path) {
            return Err(GitError::Command("git_diff_generated".into()));
        }
        let content = render_file_diff(cwd, change, MAX_GIT_DIFF_FILE_CONTEXT_BYTES)?
            .map_err(GitError::Command)?;
        if contains_binary_marker(&content) || std::str::from_utf8(&content).is_err() {
            return Err(GitError::Command("git_diff_binary".into()));
        }
        let candidate = candidate_from_content(
            Some(change.path.clone()),
            1,
            content.clone(),
            MAX_GIT_DIFF_FILE_CONTEXT_HUNKS,
        );
        (candidate, content)
    } else {
        if status.files.len() > MAX_GIT_DIFF_CONTEXT_FILES {
            return Err(GitError::Command("git_diff_too_many_files".into()));
        }
        let content = render_full_diff(cwd, &status.files)?.map_err(GitError::Command)?;
        let candidate = candidate_from_content(
            None,
            status.files.len(),
            content.clone(),
            MAX_GIT_DIFF_CONTEXT_HUNKS,
        );
        (candidate, content)
    };
    if let Some(reason) = candidate.disabled_reason.clone() {
        return Err(GitError::Command(reason));
    }
    Ok((candidate, content))
}

fn render_full_diff(
    cwd: &Path,
    changes: &[GitFileChange],
) -> Result<Result<Vec<u8>, String>, GitError> {
    let mut content = Vec::new();
    for change in changes {
        if is_generated_relative_path(&change.path) {
            return Ok(Err("git_diff_contains_unsupported".into()));
        }
        let remaining = MAX_GIT_DIFF_CONTEXT_BYTES.saturating_sub(content.len());
        if remaining == 0 {
            return Ok(Err("git_diff_too_large".into()));
        }
        match render_file_diff(cwd, change, remaining)? {
            Ok(patch) => {
                if contains_binary_marker(&patch) || std::str::from_utf8(&patch).is_err() {
                    return Ok(Err("git_diff_contains_unsupported".into()));
                }
                content.extend_from_slice(&patch);
                if content.len() > MAX_GIT_DIFF_CONTEXT_BYTES {
                    return Ok(Err("git_diff_too_large".into()));
                }
            }
            Err(reason) => return Ok(Err(reason)),
        }
    }
    if hunk_count(&content) > MAX_GIT_DIFF_CONTEXT_HUNKS {
        return Ok(Err("git_diff_too_many_hunks".into()));
    }
    Ok(Ok(content))
}

fn render_file_diff(
    cwd: &Path,
    change: &GitFileChange,
    limit: usize,
) -> Result<Result<Vec<u8>, String>, GitError> {
    validate_path(&change.path)?;
    let mut content = Vec::new();
    if change.index_status == Some('?') && change.worktree_status == Some('?') {
        return match append_bounded_diff(
            cwd,
            &[
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=3",
                "--",
                "/dev/null",
                &change.path,
            ],
            limit,
            true,
            &mut content,
        )? {
            Ok(()) => Ok(Ok(content)),
            Err(reason) => Ok(Err(reason)),
        };
    }
    if change.index_status.is_some()
        && let Err(reason) = append_bounded_diff(
            cwd,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=3",
                "--",
                &change.path,
            ],
            limit,
            false,
            &mut content,
        )?
    {
        return Ok(Err(reason));
    }
    if change.worktree_status.is_some() {
        let remaining = limit.saturating_sub(content.len());
        if remaining == 0 {
            return Ok(Err("git_diff_too_large".into()));
        }
        if let Err(reason) = append_bounded_diff(
            cwd,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=3",
                "--",
                &change.path,
            ],
            remaining,
            false,
            &mut content,
        )? {
            return Ok(Err(reason));
        }
    }
    Ok(Ok(content))
}

fn append_bounded_diff(
    cwd: &Path,
    arguments: &[&str],
    limit: usize,
    accept_difference_exit: bool,
    content: &mut Vec<u8>,
) -> Result<Result<(), String>, GitError> {
    match blocking_git_output(cwd, arguments, limit, accept_difference_exit)? {
        BoundedGitOutput::Complete(patch) => {
            content.extend_from_slice(&patch);
            Ok(Ok(()))
        }
        BoundedGitOutput::OverLimit(prefix) => {
            content.extend_from_slice(&prefix);
            Ok(Err("git_diff_too_large".into()))
        }
    }
}

fn candidate_from_content(
    path: Option<String>,
    file_count: usize,
    content: Vec<u8>,
    max_hunks: usize,
) -> GitDiffContextCandidate {
    if content.is_empty() {
        return disabled_candidate(path, "git_diff_empty", &content);
    }
    let hunks = hunk_count(&content);
    if hunks > max_hunks {
        return disabled_candidate(path, "git_diff_too_many_hunks", &content);
    }
    GitDiffContextCandidate {
        source_revision: diff_revision(path.as_deref(), &content),
        path,
        file_count,
        hunk_count: hunks,
        byte_count: content.len(),
        enabled: true,
        disabled_reason: None,
    }
}

fn disabled_candidate(
    path: Option<String>,
    reason: &str,
    identity: &[u8],
) -> GitDiffContextCandidate {
    let mut revision_input = reason.as_bytes().to_vec();
    revision_input.extend_from_slice(identity);
    GitDiffContextCandidate {
        source_revision: diff_revision(path.as_deref(), &revision_input),
        path,
        file_count: 0,
        hunk_count: 0,
        byte_count: 0,
        enabled: false,
        disabled_reason: Some(reason.to_owned()),
    }
}

fn diff_revision(path: Option<&str>, content: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"kubecode-git-diff-context-v1\0");
    digest.update(path.unwrap_or("."));
    digest.update([0]);
    digest.update(content);
    hex::encode(digest.finalize())
}

fn status_identity(changes: &[GitFileChange]) -> String {
    changes
        .iter()
        .map(|change| {
            format!(
                "{}:{}:{}:{}:{}",
                change.index_status.unwrap_or(' '),
                change.worktree_status.unwrap_or(' '),
                change.conflict,
                change.original_path.as_deref().unwrap_or(""),
                change.path,
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn hunk_count(content: &[u8]) -> usize {
    content
        .split(|byte| *byte == b'\n')
        .filter(|line| line.starts_with(b"@@ "))
        .count()
}

fn contains_binary_marker(content: &[u8]) -> bool {
    content
        .windows(b"Binary files ".len())
        .any(|window| window == b"Binary files ")
        || content
            .windows(b"GIT binary patch".len())
            .any(|window| window == b"GIT binary patch")
}

enum BoundedGitOutput {
    Complete(Vec<u8>),
    OverLimit(Vec<u8>),
}

fn blocking_git_succeeds(cwd: &Path, arguments: &[&str]) -> Result<bool, GitError> {
    Ok(BlockingCommand::new("git")
        .arg("--no-optional-locks")
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?
        .success())
}

fn blocking_status_output(cwd: &Path) -> Result<(Vec<u8>, bool), GitError> {
    let arguments = [
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
    ];
    let mut child = BlockingCommand::new("git")
        .arg("--no-optional-locks")
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr_pipe = child.stderr.take().expect("piped stderr");
    let stderr_reader = std::thread::spawn(move || {
        let mut stderr = Vec::with_capacity(MAX_GIT_ERROR_BYTES);
        {
            let mut bounded = (&mut stderr_pipe).take((MAX_GIT_ERROR_BYTES + 1) as u64);
            let _ = bounded.read_to_end(&mut stderr);
        }
        let _ = std::io::copy(&mut stderr_pipe, &mut std::io::sink());
        stderr.truncate(MAX_GIT_ERROR_BYTES);
        stderr
    });

    let mut collector = StatusOutputCollector::new(MAX_GIT_STATUS_BYTES, MAX_GIT_STATUS_RECORDS);
    let mut chunk = [0_u8; 8192];
    loop {
        let read = stdout.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        if !collector.push(&chunk[..read]) {
            let _ = child.kill();
            break;
        }
    }
    let (output, truncated) = collector.finish();
    let status = child.wait()?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if !truncated && !status.success() {
        let message = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Err(GitError::Command(if message.is_empty() {
            format!("git {} exited with {status}", arguments.join(" "))
        } else {
            message
        }));
    }
    Ok((output, truncated))
}

struct StatusOutputCollector {
    output: Vec<u8>,
    pending: Vec<u8>,
    file_records: usize,
    max_bytes: usize,
    max_records: usize,
    awaiting_original_path: bool,
    truncated: bool,
}

impl StatusOutputCollector {
    fn new(max_bytes: usize, max_records: usize) -> Self {
        Self {
            output: Vec::with_capacity(max_bytes.min(64 * 1024)),
            pending: Vec::new(),
            file_records: 0,
            max_bytes,
            max_records,
            awaiting_original_path: false,
            truncated: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> bool {
        for byte in bytes {
            if self.file_records >= self.max_records
                || self.output.len().saturating_add(self.pending.len()) >= self.max_bytes
            {
                self.truncated = true;
                return false;
            }
            self.pending.push(*byte);
            if *byte != 0 {
                continue;
            }
            if !self.awaiting_original_path && self.pending.starts_with(b"2 ") {
                self.awaiting_original_path = true;
                continue;
            }
            if self
                .pending
                .first()
                .is_some_and(|kind| matches!(kind, b'1' | b'2' | b'u' | b'?'))
            {
                self.file_records += 1;
            }
            self.output.append(&mut self.pending);
            self.awaiting_original_path = false;
        }
        true
    }

    fn finish(mut self) -> (Vec<u8>, bool) {
        if !self.pending.is_empty() {
            self.truncated = true;
        }
        (self.output, self.truncated)
    }
}

fn blocking_git_output(
    cwd: &Path,
    arguments: &[&str],
    limit: usize,
    accept_difference_exit: bool,
) -> Result<BoundedGitOutput, GitError> {
    let mut child = BlockingCommand::new("git")
        .arg("--no-optional-locks")
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr_pipe = child.stderr.take().expect("piped stderr");
    let stderr_reader = std::thread::spawn(move || {
        let mut stderr = Vec::with_capacity(MAX_GIT_ERROR_BYTES);
        {
            let mut bounded = (&mut stderr_pipe).take((MAX_GIT_ERROR_BYTES + 1) as u64);
            let _ = bounded.read_to_end(&mut stderr);
        }
        let _ = std::io::copy(&mut stderr_pipe, &mut std::io::sink());
        stderr.truncate(MAX_GIT_ERROR_BYTES);
        stderr
    });
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024) + 1);
    let mut chunk = [0_u8; 8192];
    let mut over_limit = false;
    loop {
        let read = stdout.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_add(1).saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..read.min(remaining)]);
        if bytes.len() > limit {
            over_limit = true;
            let _ = child.kill();
            break;
        }
    }
    let status = child.wait()?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if over_limit {
        bytes.truncate(limit);
        return Ok(BoundedGitOutput::OverLimit(bytes));
    }
    let difference = accept_difference_exit && status.code() == Some(1);
    if !status.success() && !difference {
        let message = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Err(GitError::Command(if message.is_empty() {
            format!("git {} exited with {status}", arguments.join(" "))
        } else {
            message
        }));
    }
    Ok(BoundedGitOutput::Complete(bytes))
}

fn parse_status(output: &[u8], truncated: bool) -> Result<GitStatus, GitError> {
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut branch = None;
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if let Some(value) = record.strip_prefix(b"# branch.head ") {
            let value = String::from_utf8_lossy(value);
            branch = (!value.starts_with('(')).then(|| value.into_owned());
            continue;
        }
        if record.starts_with(b"# ") || record.starts_with(b"! ") {
            continue;
        }
        files.push(parse_file_status(record, &mut records)?);
    }
    Ok(GitStatus {
        is_repository: true,
        branch,
        files,
        truncated,
    })
}

fn parse_file_status<'a>(
    record: &[u8],
    records: &mut impl Iterator<Item = &'a [u8]>,
) -> Result<GitFileChange, GitError> {
    let invalid = || GitError::Command("git returned an invalid status record".into());
    let (xy, submodule, path, original_path, conflict) = match record.first() {
        Some(b'1') => {
            let fields = record.splitn(9, |byte| *byte == b' ').collect::<Vec<_>>();
            if fields.len() != 9 || fields[0] != b"1" {
                return Err(invalid());
            }
            (fields[1], fields[2], fields[8], None, false)
        }
        Some(b'2') => {
            let fields = record.splitn(10, |byte| *byte == b' ').collect::<Vec<_>>();
            if fields.len() != 10 || fields[0] != b"2" {
                return Err(invalid());
            }
            let original = records.next().ok_or_else(invalid)?;
            (fields[1], fields[2], fields[9], Some(original), false)
        }
        Some(b'u') => {
            let fields = record.splitn(11, |byte| *byte == b' ').collect::<Vec<_>>();
            if fields.len() != 11 || fields[0] != b"u" {
                return Err(invalid());
            }
            (fields[1], fields[2], fields[10], None, true)
        }
        Some(b'?') if record.get(1) == Some(&b' ') => (
            b"??".as_slice(),
            b"N...".as_slice(),
            &record[2..],
            None,
            false,
        ),
        _ => return Err(invalid()),
    };
    if xy.len() != 2 || path.is_empty() {
        return Err(invalid());
    }
    let index_status = status_character(xy[0]);
    let mut worktree_status = status_character(xy[1]);
    if worktree_status.is_none()
        && submodule.len() == 4
        && submodule[0] == b'S'
        && submodule[1..].iter().any(|value| *value != b'.')
    {
        worktree_status = Some('M');
    }
    Ok(GitFileChange {
        path: String::from_utf8_lossy(path).into_owned(),
        original_path: original_path.map(|path| String::from_utf8_lossy(path).into_owned()),
        index_status,
        worktree_status,
        conflict,
    })
}

fn status_character(value: u8) -> Option<char> {
    (!matches!(value, b'.' | b' ')).then_some(value as char)
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
    fn parses_porcelain_v2_records_without_losing_identity() {
        let output = b"# branch.oid abc\0# branch.head main\0\
1 .M N... 100644 100644 100644 abc def src/main.rs\0\
2 R. N... 100644 100644 100644 abc def R100 renamed name.rs\0old name.rs\0\
2 C. N... 100644 100644 100644 abc def C100 copied.rs\0source.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
1 .. S.MU 160000 160000 160000 abc def vendor/sub\0\
? white space.txt\0? na\xc3\xafve.txt\0";
        let status = parse_status(output, false).expect("status");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.files.len(), 7);
        assert!(!status.truncated);
        assert_eq!(status.files[0].worktree_status, Some('M'));
        assert_eq!(status.files[1].index_status, Some('R'));
        assert_eq!(status.files[1].path, "renamed name.rs");
        assert_eq!(
            status.files[1].original_path.as_deref(),
            Some("old name.rs")
        );
        assert_eq!(status.files[2].index_status, Some('C'));
        assert_eq!(status.files[2].original_path.as_deref(), Some("source.rs"));
        assert!(status.files[3].conflict);
        assert_eq!(status.files[3].index_status, Some('U'));
        assert_eq!(status.files[3].worktree_status, Some('U'));
        assert_eq!(status.files[4].worktree_status, Some('M'));
        assert_eq!(status.files[5].path, "white space.txt");
        assert_eq!(status.files[6].path, "na\u{00ef}ve.txt");
    }

    #[test]
    fn bounds_status_by_complete_file_records() {
        let mut input = b"# branch.head main\0".to_vec();
        for index in 0..=MAX_GIT_STATUS_RECORDS {
            input.extend_from_slice(format!("? file-{index}\0").as_bytes());
        }
        let mut collector =
            StatusOutputCollector::new(MAX_GIT_STATUS_BYTES, MAX_GIT_STATUS_RECORDS);
        assert!(!collector.push(&input));
        let (output, truncated) = collector.finish();
        let status = parse_status(&output, truncated).expect("bounded status");
        assert_eq!(status.files.len(), MAX_GIT_STATUS_RECORDS);
        assert!(status.truncated);
        assert!(output.len() <= MAX_GIT_STATUS_BYTES);
        assert_eq!(output.last(), Some(&0));
    }

    #[test]
    fn drops_partial_byte_limited_and_rename_records() {
        let oversized = format!("? {}\0", "x".repeat(MAX_GIT_STATUS_BYTES));
        let mut collector =
            StatusOutputCollector::new(MAX_GIT_STATUS_BYTES, MAX_GIT_STATUS_RECORDS);
        assert!(!collector.push(oversized.as_bytes()));
        let (output, truncated) = collector.finish();
        assert!(output.is_empty());
        assert!(truncated);

        let rename = b"2 R. N... 100644 100644 100644 a b R100 new.txt\0old.txt\0";
        let mut collector = StatusOutputCollector::new(rename.len() - 1, 10);
        assert!(!collector.push(rename));
        let (output, truncated) = collector.finish();
        assert!(output.is_empty());
        assert!(truncated);
    }

    #[test]
    fn rejects_paths_outside_the_project() {
        assert!(validate_path("src/main.rs").is_ok());
        assert!(validate_path("../secret").is_err());
        assert!(validate_path("/etc/passwd").is_err());
    }
}
