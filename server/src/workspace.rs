use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::agents::ExecutionMode;
use crate::database::{Database, DatabaseError, ensure_column};
use crate::project_watcher::{ProjectWatcher, WorkspaceEventSink};

const MAX_EDITABLE_BYTES: usize = 5 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_SESSION_DIRECTORY_ENTRIES: usize = 512;
const STATE_DIRECTORY: &str = ".state";

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("invalid workspace path: {0}")]
    InvalidPath(String),
    #[error("session workspace is unavailable")]
    SessionWorkspaceUnavailable,
    #[error("composer context is outside the Session execution root or is ineligible: {0}")]
    IneligibleContext(String),
    #[error("project not found: {0}")]
    ProjectNotFound(String),
    #[error("project is already registered: {0}")]
    DuplicateProject(String),
    #[error("file changed since it was opened (expected {expected}, current {current})")]
    Conflict { expected: String, current: String },
    #[error("file is not editable UTF-8 text")]
    UnsupportedText,
    #[error("file is larger than the 5 MiB editor limit")]
    FileTooLarge,
    #[error("asset is larger than the 8 MiB preview limit")]
    AssetTooLarge,
    #[error("git worktree operation failed: {0}")]
    Git(String),
    #[error("workspace changed after this turn (expected {expected}, current {current})")]
    CheckpointConflict { expected: String, current: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    DatabaseSetup(#[from] DatabaseError),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub workspaces_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TextDocument {
    pub path: String,
    pub content: String,
    pub revision: String,
    pub size: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub hidden: bool,
    pub ignored: bool,
    pub generated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub hidden: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirectoryEntry>,
}

pub struct WorkspaceService {
    root: PathBuf,
    state_root: PathBuf,
    database: Arc<Database>,
    watcher: Mutex<Option<ProjectWatcher>>,
}

impl WorkspaceService {
    pub fn open(
        root: impl AsRef<Path>,
        database_path: impl AsRef<Path>,
    ) -> Result<Self, WorkspaceError> {
        let database = Arc::new(Database::open(database_path)?);
        Self::from_database(root, database)
    }

    pub fn from_database(
        root: impl AsRef<Path>,
        database: Arc<Database>,
    ) -> Result<Self, WorkspaceError> {
        fs::create_dir_all(root.as_ref())?;
        let root = root.as_ref().canonicalize()?;
        let state_root = database
            .path()
            .parent()
            .ok_or_else(|| WorkspaceError::InvalidPath(path_string(database.path())))?
            .canonicalize()?;

        let mut connection = database.lock().expect("workspace database mutex poisoned");
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               path TEXT NOT NULL UNIQUE,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );",
        )?;
        ensure_column(
            &connection,
            "projects",
            "workspaces_enabled",
            "INTEGER NOT NULL DEFAULT 0",
        )?;

        migrate_project_paths(&mut connection, &root)?;
        drop(connection);

        Ok(Self {
            root,
            state_root,
            database,
            watcher: Mutex::new(None),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn project_path(&self, project_id: &str) -> Result<PathBuf, WorkspaceError> {
        self.project_root(project_id)
    }

    pub fn validate_project_relative_path(
        &self,
        project_id: &str,
        relative: &str,
    ) -> Result<String, WorkspaceError> {
        if relative.contains('\0') {
            return Err(WorkspaceError::InvalidPath(relative.to_owned()));
        }
        self.project_root(project_id)?;
        normalize_relative(relative, false).map(|path| path_string(&path))
    }

    pub fn project(&self, project_id: &str) -> Result<Project, WorkspaceError> {
        let database = self
            .database
            .lock()
            .expect("workspace database mutex poisoned");
        database
            .query_row(
                "SELECT id, name, path, workspaces_enabled FROM projects WHERE id = ?1",
                [project_id],
                |row| {
                    Ok(Project {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        path: row.get(2)?,
                        workspaces_enabled: row.get(3)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| WorkspaceError::ProjectNotFound(project_id.to_owned()))
    }

    pub fn create_session_worktree(
        &self,
        project_id: &str,
        session_id: &str,
    ) -> Result<PathBuf, WorkspaceError> {
        self.create_session_worktree_from(project_id, session_id, None)
    }

    pub fn create_session_worktree_from(
        &self,
        project_id: &str,
        session_id: &str,
        base_workspace_path: Option<&str>,
    ) -> Result<PathBuf, WorkspaceError> {
        validate_storage_id(session_id)?;
        let project = self.project(project_id)?;
        if !project.workspaces_enabled {
            return Err(WorkspaceError::InvalidPath(
                "Workspaces are disabled for this project".into(),
            ));
        }
        let base = self.execution_path(project_id, base_workspace_path)?;
        let workspace_parent = self.state_root.join("worktrees").join(project_id);
        fs::create_dir_all(&workspace_parent)?;
        let workspace_path = workspace_parent.join(session_id);
        if workspace_path.exists() {
            return Err(WorkspaceError::DuplicateProject(path_string(
                &workspace_path,
            )));
        }
        let branch = format!("kubecode/{session_id}");
        let workspace_text = path_string(&workspace_path);
        run_git(
            &base,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                workspace_text.as_str(),
                "HEAD",
            ],
        )?;
        workspace_path.canonicalize().map_err(WorkspaceError::from)
    }

    pub fn execution_path(
        &self,
        project_id: &str,
        workspace_path: Option<&str>,
    ) -> Result<PathBuf, WorkspaceError> {
        let Some(workspace_path) = workspace_path else {
            return self.project_root(project_id);
        };
        let canonical = PathBuf::from(workspace_path).canonicalize()?;
        let expected_parent = self.state_root.join("worktrees").join(project_id);
        if !canonical.starts_with(&expected_parent) {
            return Err(WorkspaceError::InvalidPath(workspace_path.to_owned()));
        }
        Ok(canonical)
    }

    pub fn session_worktree_dirty(
        &self,
        project_id: &str,
        session_id: &str,
        workspace_path: &str,
    ) -> Result<bool, WorkspaceError> {
        let workspace = self.validated_session_worktree(project_id, session_id, workspace_path)?;
        Ok(!git_output(&workspace, &["status", "--porcelain"])?.is_empty())
    }

    pub fn capture_git_tree(
        &self,
        cwd: &Path,
        checkpoint_id: &str,
    ) -> Result<Option<String>, WorkspaceError> {
        validate_storage_id(checkpoint_id)?;
        let repository = git_command(cwd, &["rev-parse", "--is-inside-work-tree"])?;
        if !repository.status.success() {
            return Ok(None);
        }
        let checkpoint_parent = self.state_root.join("checkpoints");
        fs::create_dir_all(&checkpoint_parent)?;
        let index_path = checkpoint_parent.join(format!("{checkpoint_id}.index"));
        if index_path.exists() {
            fs::remove_file(&index_path)?;
        }
        let result = (|| {
            run_git_with_index(cwd, &index_path, &["read-tree", "HEAD"])?;
            run_git_with_index(cwd, &index_path, &["add", "--all"])?;
            git_output_with_index(cwd, &index_path, &["write-tree"]).map(Some)
        })();
        if index_path.exists() {
            fs::remove_file(index_path)?;
        }
        result
    }

    pub fn restore_git_tree(
        &self,
        cwd: &Path,
        target_tree: &str,
        expected_current_tree: Option<&str>,
    ) -> Result<(), WorkspaceError> {
        let checkpoint_id = format!("restore-{}", Uuid::new_v4());
        let current_tree = self
            .capture_git_tree(cwd, &checkpoint_id)?
            .ok_or_else(|| WorkspaceError::Git("workspace is not a Git repository".into()))?;
        if let Some(expected) = expected_current_tree
            && current_tree != expected
        {
            return Err(WorkspaceError::CheckpointConflict {
                expected: expected.to_owned(),
                current: current_tree,
            });
        }
        let patch = git_output_bytes(cwd, &["diff", "--binary", &current_tree, target_tree])?;
        if patch.is_empty() {
            return Ok(());
        }
        let mut child = Command::new("git")
            .args(["apply", "--whitespace=nowarn", "-"])
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .ok_or_else(|| WorkspaceError::Git("could not open git apply input".into()))?
            .write_all(&patch)?;
        let output = child.wait_with_output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(git_failure(&output))
        }
    }

    pub fn merge_session_worktree(
        &self,
        project_id: &str,
        session_id: &str,
        workspace_path: &str,
    ) -> Result<(), WorkspaceError> {
        let workspace = self.validated_session_worktree(project_id, session_id, workspace_path)?;
        let project_root = self.project_root(project_id)?;
        if !git_output(&project_root, &["status", "--porcelain"])?.is_empty() {
            return Err(WorkspaceError::Git(
                "Project root has uncommitted changes; commit or stash them before merging".into(),
            ));
        }
        if !git_output(&workspace, &["status", "--porcelain"])?.is_empty() {
            run_git(&workspace, &["add", "--all"])?;
            run_git(
                &workspace,
                &["commit", "-m", &format!("Kubecode workspace {session_id}")],
            )?;
        }
        let branch = worktree_branch(session_id);
        run_git(
            &project_root,
            &[
                "merge",
                "--no-ff",
                &branch,
                "-m",
                &format!("Merge Kubecode workspace {session_id}"),
            ],
        )?;
        self.discard_session_worktree(project_id, session_id, workspace_path)
    }

    pub fn export_session_worktree(
        &self,
        project_id: &str,
        session_id: &str,
        workspace_path: &str,
    ) -> Result<PathBuf, WorkspaceError> {
        let workspace = self.validated_session_worktree(project_id, session_id, workspace_path)?;
        let project_root = self.project_root(project_id)?;
        let base = git_output(&project_root, &["rev-parse", "HEAD"])?;
        let patch = git_output_bytes(&workspace, &["diff", "--binary", &base])?;
        let export_parent = self.state_root.join("exports").join(project_id);
        fs::create_dir_all(&export_parent)?;
        let export_path = export_parent.join(format!("{session_id}.patch"));
        fs::write(&export_path, patch)?;
        self.discard_session_worktree(project_id, session_id, workspace_path)?;
        Ok(export_path)
    }

    pub fn discard_session_worktree(
        &self,
        project_id: &str,
        session_id: &str,
        workspace_path: &str,
    ) -> Result<(), WorkspaceError> {
        let workspace = self.validated_session_worktree(project_id, session_id, workspace_path)?;
        let project_root = self.project_root(project_id)?;
        let workspace_text = path_string(&workspace);
        run_git(
            &project_root,
            &["worktree", "remove", "--force", &workspace_text],
        )?;
        run_git(
            &project_root,
            &["branch", "-D", &worktree_branch(session_id)],
        )
    }

    fn validated_session_worktree(
        &self,
        project_id: &str,
        session_id: &str,
        workspace_path: &str,
    ) -> Result<PathBuf, WorkspaceError> {
        validate_storage_id(session_id)?;
        let canonical = PathBuf::from(workspace_path).canonicalize()?;
        let expected = self
            .state_root
            .join("worktrees")
            .join(project_id)
            .join(session_id);
        if canonical != expected {
            return Err(WorkspaceError::InvalidPath(workspace_path.to_owned()));
        }
        Ok(canonical)
    }

    pub fn create_project_at(&self, path: impl AsRef<Path>) -> Result<Project, WorkspaceError> {
        let requested = require_absolute(path.as_ref())?;
        reject_state_directory(&self.root, requested)?;
        if requested.exists() {
            return Err(WorkspaceError::DuplicateProject(path_string(requested)));
        }
        fs::create_dir_all(requested)?;
        let canonical = requested.canonicalize()?;
        reject_state_directory(&self.root, &canonical)?;
        self.register_project(canonical)
    }

    pub fn import_project_at(&self, path: impl AsRef<Path>) -> Result<Project, WorkspaceError> {
        let requested = require_absolute(path.as_ref())?;
        let canonical = requested.canonicalize()?;
        reject_state_directory(&self.root, &canonical)?;
        if !canonical.is_dir() {
            return Err(WorkspaceError::InvalidPath(path_string(requested)));
        }
        self.register_project(canonical)
    }

    pub fn authorize_project_path(
        &self,
        project_id: &str,
        path: impl AsRef<Path>,
    ) -> Result<(), WorkspaceError> {
        let requested = require_absolute(path.as_ref())?;
        let canonical = requested.canonicalize()?;
        reject_state_directory(&self.root, &canonical)?;
        if !canonical.is_dir() {
            return Err(WorkspaceError::InvalidPath(path_string(requested)));
        }
        let registered = self.project_root(project_id)?;
        if canonical != registered {
            return Err(WorkspaceError::InvalidPath(path_string(requested)));
        }
        Ok(())
    }

    pub fn list_directories(
        &self,
        requested: Option<&Path>,
    ) -> Result<DirectoryListing, WorkspaceError> {
        let fallback = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_dir())
            .unwrap_or_else(|| self.root.clone());
        let requested = requested.unwrap_or(&fallback);
        require_absolute(requested)?;
        let directory = requested.canonicalize()?;
        reject_state_directory(&self.root, &directory)?;
        if !directory.is_dir() {
            return Err(WorkspaceError::InvalidPath(path_string(requested)));
        }

        let mut entries = Vec::new();
        for result in fs::read_dir(&directory)? {
            let entry = match result {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let canonical = match entry.path().canonicalize() {
                Ok(path) if path.is_dir() => path,
                _ => continue,
            };
            if reject_state_directory(&self.root, &canonical).is_err() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            entries.push(DirectoryEntry {
                hidden: name.starts_with('.'),
                name,
                path: path_string(&canonical),
            });
        }
        entries.sort_by_key(|entry| entry.name.to_lowercase());
        Ok(DirectoryListing {
            path: path_string(&directory),
            parent: directory.parent().map(path_string),
            entries,
        })
    }

    pub fn create_project(&self, parent: &str, name: &str) -> Result<Project, WorkspaceError> {
        let name_path = normalize_relative(name, false)?;
        if name_path.components().count() != 1 {
            return Err(WorkspaceError::InvalidPath(name.to_owned()));
        }

        let parent = normalize_relative(parent, true)?;
        let relative = parent.join(name_path);
        ensure_not_state_path(&relative)?;
        let destination = self.root.join(&relative);
        if destination.exists() {
            return Err(WorkspaceError::DuplicateProject(path_string(&relative)));
        }

        fs::create_dir_all(&destination)?;
        let canonical = destination.canonicalize()?;
        ensure_contained(&self.root, &canonical, path_string(&relative))?;
        self.register_project(canonical)
    }

    pub fn import_project(
        &self,
        relative: &str,
        name: Option<&str>,
    ) -> Result<Project, WorkspaceError> {
        let relative = normalize_relative(relative, false)?;
        ensure_not_state_path(&relative)?;
        let requested = self.root.join(&relative);
        let canonical = requested.canonicalize()?;
        ensure_contained(
            &self.root,
            &canonical,
            relative.to_string_lossy().into_owned(),
        )?;
        if !canonical.is_dir() {
            return Err(WorkspaceError::InvalidPath(
                relative.to_string_lossy().into_owned(),
            ));
        }
        let canonical_relative = canonical
            .strip_prefix(&self.root)
            .map_err(|_| WorkspaceError::InvalidPath(relative.to_string_lossy().into_owned()))?
            .to_path_buf();
        let _ = name;
        self.register_project(self.root.join(canonical_relative).canonicalize()?)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, WorkspaceError> {
        let database = self
            .database
            .lock()
            .expect("workspace database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, name, path, workspaces_enabled FROM projects ORDER BY name, path",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                workspaces_enabled: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(WorkspaceError::from)
    }

    pub fn set_workspaces_enabled(
        &self,
        project_id: &str,
        enabled: bool,
    ) -> Result<Project, WorkspaceError> {
        let database = self
            .database
            .lock()
            .expect("workspace database mutex poisoned");
        let changed = database.execute(
            "UPDATE projects SET workspaces_enabled = ?2 WHERE id = ?1",
            params![project_id, enabled],
        )?;
        if changed == 0 {
            return Err(WorkspaceError::ProjectNotFound(project_id.to_owned()));
        }
        database
            .query_row(
                "SELECT id, name, path, workspaces_enabled FROM projects WHERE id = ?1",
                [project_id],
                |row| {
                    Ok(Project {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        path: row.get(2)?,
                        workspaces_enabled: row.get(3)?,
                    })
                },
            )
            .map_err(WorkspaceError::from)
    }

    pub fn unregister_project(&self, project_id: &str) -> Result<(), WorkspaceError> {
        {
            let database = self
                .database
                .lock()
                .expect("workspace database mutex poisoned");
            let changed = database.execute("DELETE FROM projects WHERE id = ?1", [project_id])?;
            if changed == 0 {
                return Err(WorkspaceError::ProjectNotFound(project_id.to_owned()));
            }
        }
        if let Some(watcher) = self
            .watcher
            .lock()
            .expect("workspace watcher mutex poisoned")
            .as_ref()
        {
            watcher.unregister(project_id.to_owned());
        }
        Ok(())
    }

    /// Starts watching every registered Project. Called after the durable
    /// workspace-event append sink is available and before the HTTP listener
    /// accepts requests. Watch failures are an explicit supported state and
    /// never roll back a valid Project.
    pub fn start_watching(&self, sink: WorkspaceEventSink) {
        let projects = self.list_projects().unwrap_or_default();
        let mut guard = self
            .watcher
            .lock()
            .expect("workspace watcher mutex poisoned");
        if guard.is_some() {
            return;
        }
        let watcher = ProjectWatcher::start(sink);
        for project in projects {
            watcher.register(project.id, PathBuf::from(&project.path));
        }
        *guard = Some(watcher);
    }

    /// Stops the watcher worker, draining and flushing pending batches. Used by
    /// tests and orderly Runtime shutdown.
    pub fn stop_watching(&self) {
        if let Some(watcher) = self
            .watcher
            .lock()
            .expect("workspace watcher mutex poisoned")
            .take()
        {
            watcher.shutdown();
        }
    }

    pub fn merge_isolated_tree(
        &self,
        leader_cwd: &Path,
        base_tree: &str,
        member_tree: &str,
    ) -> Result<String, WorkspaceError> {
        let checkpoint_id = format!("team-merge-{}", Uuid::new_v4());
        let leader_tree = self
            .capture_git_tree(leader_cwd, &checkpoint_id)?
            .ok_or_else(|| WorkspaceError::Git("workspace is not a Git repository".into()))?;
        let index_path = self
            .state_root
            .join("checkpoints")
            .join(format!("{checkpoint_id}.index"));
        if index_path.exists() {
            fs::remove_file(&index_path)?;
        }
        let merge_result = (|| {
            run_git_with_index(
                leader_cwd,
                &index_path,
                &["read-tree", "-m", base_tree, &leader_tree, member_tree],
            )?;
            git_output_with_index(leader_cwd, &index_path, &["write-tree"])
        })();
        if index_path.exists() {
            fs::remove_file(index_path)?;
        }
        let merged_tree = merge_result?;
        self.restore_git_tree(leader_cwd, &merged_tree, Some(&leader_tree))?;
        Ok(merged_tree)
    }

    pub fn create_entry(
        &self,
        project_id: &str,
        relative: &str,
        kind: EntryKind,
    ) -> Result<(), WorkspaceError> {
        let project_root = self.project_root(project_id)?;
        let relative = normalize_relative(relative, false)?;
        let target = project_root.join(&relative);
        let parent = target
            .parent()
            .ok_or_else(|| WorkspaceError::InvalidPath(relative.to_string_lossy().into_owned()))?;
        fs::create_dir_all(parent)?;
        ensure_contained_or_same(
            &project_root,
            &parent.canonicalize()?,
            relative.to_string_lossy().into_owned(),
        )?;

        match kind {
            EntryKind::Directory => fs::create_dir(&target)?,
            EntryKind::File => {
                OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&target)?;
            }
        }
        Ok(())
    }

    pub fn list_entries(
        &self,
        project_id: &str,
        relative: &str,
    ) -> Result<Vec<FileEntry>, WorkspaceError> {
        let project_root = self.project_root(project_id)?;
        list_entries_in(&project_root, relative, None)
    }

    /// Lists entries for a Session/conversation-scoped Composer context search.
    ///
    /// The execution root is derived entirely from the conversation record: a
    /// shared Session resolves to its registered Project root, while a worktree
    /// Session resolves to its exact validated worktree. The caller supplies
    /// only a validated relative directory path; no arbitrary or absolute path
    /// is accepted or exposed.
    pub fn list_session_entries(
        &self,
        project_id: &str,
        agent_session_id: &str,
        execution_mode: ExecutionMode,
        workspace_path: Option<&str>,
        relative: &str,
    ) -> Result<Vec<FileEntry>, WorkspaceError> {
        let root = self.session_execution_path(
            project_id,
            agent_session_id,
            execution_mode,
            workspace_path,
        )?;
        list_entries_in(&root, relative, Some(MAX_SESSION_DIRECTORY_ENTRIES))
    }

    /// Resolves one Composer context entry inside the exact Session execution
    /// root without following symlinks. The returned path is always normalized
    /// and relative; absolute execution roots remain server-only.
    pub fn resolve_session_context_entry(
        &self,
        project_id: &str,
        agent_session_id: &str,
        execution_mode: ExecutionMode,
        workspace_path: Option<&str>,
        relative: &str,
        expected_kind: EntryKind,
    ) -> Result<FileEntry, WorkspaceError> {
        if relative.len() > 4_096 || relative.contains(['\0', '\r', '\n', '\\']) {
            return Err(WorkspaceError::IneligibleContext(relative.to_owned()));
        }
        let relative_path = normalize_relative(relative, false)
            .map_err(|_| WorkspaceError::IneligibleContext(relative.to_owned()))?;
        let root = self.session_execution_path(
            project_id,
            agent_session_id,
            execution_mode,
            workspace_path,
        )?;
        let mut candidate = root.clone();
        let components = relative_path.components().collect::<Vec<_>>();
        for (index, component) in components.iter().enumerate() {
            candidate.push(component.as_os_str());
            let metadata = fs::symlink_metadata(&candidate)?;
            if metadata.file_type().is_symlink() {
                return Err(WorkspaceError::IneligibleContext(relative.to_owned()));
            }
            let name = component.as_os_str().to_string_lossy();
            let is_final = index + 1 == components.len();
            if name.starts_with('.') || (!is_final && is_generated_directory_name(&name)) {
                return Err(WorkspaceError::IneligibleContext(relative.to_owned()));
            }
            if !is_final && !metadata.is_dir() {
                return Err(WorkspaceError::IneligibleContext(relative.to_owned()));
            }
        }
        let metadata = fs::symlink_metadata(&candidate)?;
        let actual_kind = if metadata.is_dir() {
            EntryKind::Directory
        } else if metadata.is_file() {
            EntryKind::File
        } else {
            return Err(WorkspaceError::IneligibleContext(relative.to_owned()));
        };
        if actual_kind != expected_kind {
            return Err(WorkspaceError::IneligibleContext(relative.to_owned()));
        }
        let normalized = path_string(&relative_path);
        let name = relative_path
            .file_name()
            .ok_or_else(|| WorkspaceError::IneligibleContext(relative.to_owned()))?
            .to_string_lossy()
            .into_owned();
        if (actual_kind == EntryKind::Directory && is_generated_directory_name(&name))
            || git_ignored_paths(&root, std::iter::once(normalized.as_str())).contains(&normalized)
        {
            return Err(WorkspaceError::IneligibleContext(relative.to_owned()));
        }
        Ok(FileEntry {
            name,
            path: normalized,
            kind: actual_kind,
            size: metadata.len(),
            hidden: false,
            ignored: false,
            generated: false,
        })
    }

    /// Resolves the execution root for a Session, enforcing execution-mode and
    /// `workspace_path` consistency so a corrupted record fails rather than
    /// falling back. Project registration is a common prerequisite for both
    /// modes, so a retained worktree can never be listed after its Project is
    /// unregistered. A worktree Session must additionally point at exactly its
    /// own `state_root/worktrees/<project_id>/<agent_session_id>` worktree,
    /// never another Agent Session's.
    pub fn session_execution_path(
        &self,
        project_id: &str,
        agent_session_id: &str,
        execution_mode: ExecutionMode,
        workspace_path: Option<&str>,
    ) -> Result<PathBuf, WorkspaceError> {
        // Common prerequisite: the Project must still be registered. This also
        // gates the Worktree branch, so an orphaned retained worktree cannot be
        // reached once its Project is unregistered.
        let project_root = self.project_root(project_id)?;
        match execution_mode {
            ExecutionMode::Shared => match workspace_path {
                None => Ok(project_root),
                Some(_) => Err(WorkspaceError::SessionWorkspaceUnavailable),
            },
            ExecutionMode::Worktree => match workspace_path {
                Some(workspace_path) => self
                    .validated_session_worktree(project_id, agent_session_id, workspace_path)
                    .map_err(|_| WorkspaceError::SessionWorkspaceUnavailable),
                None => Err(WorkspaceError::SessionWorkspaceUnavailable),
            },
        }
    }

    pub fn read_text(
        &self,
        project_id: &str,
        relative: &str,
    ) -> Result<TextDocument, WorkspaceError> {
        let (relative, target) = self.existing_entry(project_id, relative)?;
        let bytes = fs::read(target)?;
        if bytes.len() > MAX_EDITABLE_BYTES {
            return Err(WorkspaceError::FileTooLarge);
        }
        let content =
            String::from_utf8(bytes.clone()).map_err(|_| WorkspaceError::UnsupportedText)?;
        Ok(TextDocument {
            path: path_string(&relative),
            revision: revision(&bytes),
            size: bytes.len(),
            content,
        })
    }

    pub fn read_asset(&self, project_id: &str, relative: &str) -> Result<Vec<u8>, WorkspaceError> {
        let (_, target) = self.existing_entry(project_id, relative)?;
        let file = fs::File::open(&target)?;
        if file.metadata()?.len() > MAX_ASSET_BYTES {
            return Err(WorkspaceError::AssetTooLarge);
        }
        let mut bytes = Vec::new();
        file.take(MAX_ASSET_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(WorkspaceError::AssetTooLarge);
        }
        Ok(bytes)
    }

    pub fn write_text(
        &self,
        project_id: &str,
        relative: &str,
        content: &str,
        expected_revision: &str,
    ) -> Result<TextDocument, WorkspaceError> {
        if content.len() > MAX_EDITABLE_BYTES {
            return Err(WorkspaceError::FileTooLarge);
        }
        let (relative, target) = self.existing_entry(project_id, relative)?;
        let current = fs::read(&target)?;
        let current_revision = revision(&current);
        if current_revision != expected_revision {
            return Err(WorkspaceError::Conflict {
                expected: expected_revision.to_owned(),
                current: current_revision,
            });
        }

        let parent = target
            .parent()
            .ok_or_else(|| WorkspaceError::InvalidPath(path_string(&relative)))?;
        let temporary = parent.join(format!(".kubecode-save-{}", Uuid::new_v4()));
        let write_result = (|| -> Result<(), std::io::Error> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            fs::rename(&temporary, &target)
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result?;

        Ok(TextDocument {
            path: path_string(&relative),
            content: content.to_owned(),
            revision: revision(content.as_bytes()),
            size: content.len(),
        })
    }

    pub fn rename_entry(
        &self,
        project_id: &str,
        from: &str,
        to: &str,
    ) -> Result<(), WorkspaceError> {
        let project_root = self.project_root(project_id)?;
        let (_, source) = self.existing_entry(project_id, from)?;
        let destination_relative = normalize_relative(to, false)?;
        let destination = project_root.join(&destination_relative);
        let parent = destination.parent().ok_or_else(|| {
            WorkspaceError::InvalidPath(destination_relative.to_string_lossy().into_owned())
        })?;
        fs::create_dir_all(parent)?;
        ensure_contained_or_same(
            &project_root,
            &parent.canonicalize()?,
            destination_relative.to_string_lossy().into_owned(),
        )?;
        if destination.exists() {
            return Err(WorkspaceError::InvalidPath(path_string(
                &destination_relative,
            )));
        }
        fs::rename(source, destination)?;
        Ok(())
    }

    pub fn delete_entry(&self, project_id: &str, relative: &str) -> Result<(), WorkspaceError> {
        let (_, target) = self.existing_entry(project_id, relative)?;
        if target.is_dir() {
            fs::remove_dir_all(target)?;
        } else {
            fs::remove_file(target)?;
        }
        Ok(())
    }

    fn register_project(&self, canonical: PathBuf) -> Result<Project, WorkspaceError> {
        let path = path_string(&canonical);
        let name = canonical
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| path.clone());
        let project = {
            let database = self
                .database
                .lock()
                .expect("workspace database mutex poisoned");
            let exists = database
                .query_row(
                    "SELECT 1 FROM projects WHERE path = ?1",
                    [&path],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if exists {
                return Err(WorkspaceError::DuplicateProject(path));
            }
            let project = Project {
                id: Uuid::new_v4().to_string(),
                name,
                path,
                workspaces_enabled: false,
            };
            database.execute(
                "INSERT INTO projects (id, name, path) VALUES (?1, ?2, ?3)",
                params![project.id, project.name, project.path],
            )?;
            project
        };
        // The Project is committed before its watch is installed; a watch
        // failure must not roll back or hide an otherwise valid Project.
        if let Some(watcher) = self
            .watcher
            .lock()
            .expect("workspace watcher mutex poisoned")
            .as_ref()
        {
            watcher.register(project.id.clone(), canonical);
        }
        Ok(project)
    }

    fn project_root(&self, project_id: &str) -> Result<PathBuf, WorkspaceError> {
        let database = self
            .database
            .lock()
            .expect("workspace database mutex poisoned");
        let path = database
            .query_row(
                "SELECT path FROM projects WHERE id = ?1",
                [project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| WorkspaceError::ProjectNotFound(project_id.to_owned()))?;
        drop(database);
        let canonical = PathBuf::from(path).canonicalize()?;
        Ok(canonical)
    }

    fn existing_entry(
        &self,
        project_id: &str,
        relative: &str,
    ) -> Result<(PathBuf, PathBuf), WorkspaceError> {
        let project_root = self.project_root(project_id)?;
        let relative = normalize_relative(relative, false)?;
        let canonical = project_root.join(&relative).canonicalize()?;
        ensure_contained(
            &project_root,
            &canonical,
            relative.to_string_lossy().into_owned(),
        )?;
        Ok((relative, canonical))
    }
}

fn validate_storage_id(value: &str) -> Result<(), WorkspaceError> {
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(WorkspaceError::InvalidPath(value.to_owned()));
    }
    Ok(())
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<(), WorkspaceError> {
    let output = git_command(cwd, args)?;
    if output.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(WorkspaceError::Git(if message.is_empty() {
        format!("git exited with {}", output.status)
    } else {
        message
    }))
}

fn git_output(cwd: &Path, args: &[&str]) -> Result<String, WorkspaceError> {
    String::from_utf8(git_output_bytes(cwd, args)?)
        .map(|output| output.trim().to_owned())
        .map_err(|error| WorkspaceError::Git(error.to_string()))
}

fn run_git_with_index(cwd: &Path, index: &Path, args: &[&str]) -> Result<(), WorkspaceError> {
    let output = git_command_with_index(cwd, index, args)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure(&output))
    }
}

fn git_output_with_index(
    cwd: &Path,
    index: &Path,
    args: &[&str],
) -> Result<String, WorkspaceError> {
    let output = git_command_with_index(cwd, index, args)?;
    if !output.status.success() {
        return Err(git_failure(&output));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_owned())
        .map_err(|error| WorkspaceError::Git(error.to_string()))
}

fn git_command_with_index(
    cwd: &Path,
    index: &Path,
    args: &[&str],
) -> Result<std::process::Output, WorkspaceError> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_INDEX_FILE", index)
        .output()
        .map_err(WorkspaceError::from)
}

fn git_output_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, WorkspaceError> {
    let output = git_command(cwd, args)?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    Err(git_failure(&output))
}

fn git_command(cwd: &Path, args: &[&str]) -> Result<std::process::Output, WorkspaceError> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(WorkspaceError::from)
}

fn git_ignored_paths<'a>(
    cwd: &Path,
    paths: impl Iterator<Item = &'a str>,
) -> std::collections::BTreeSet<String> {
    let mut command = Command::new("git");
    command
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        return std::collections::BTreeSet::new();
    };
    if let Some(mut stdin) = child.stdin.take() {
        for path in paths {
            if stdin.write_all(path.as_bytes()).is_err() || stdin.write_all(&[0]).is_err() {
                return std::collections::BTreeSet::new();
            }
        }
    }
    let Ok(output) = child.wait_with_output() else {
        return std::collections::BTreeSet::new();
    };
    if !output.status.success() && output.status.code() != Some(1) {
        return std::collections::BTreeSet::new();
    }
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect()
}

fn list_entries_in(
    root: &Path,
    relative: &str,
    max_entries: Option<usize>,
) -> Result<Vec<FileEntry>, WorkspaceError> {
    let relative = normalize_relative(relative, true)?;
    let directory = root.join(&relative).canonicalize()?;
    ensure_contained_or_same(root, &directory, relative.to_string_lossy().into_owned())?;
    if !directory.is_dir() {
        return Err(WorkspaceError::InvalidPath(path_string(&relative)));
    }

    let mut entries = Vec::new();
    for result in fs::read_dir(&directory)?.take(max_entries.unwrap_or(usize::MAX)) {
        let entry = result?;
        if entry.file_name() == STATE_DIRECTORY {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let metadata = entry.metadata()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = if metadata.is_dir() {
            EntryKind::Directory
        } else {
            EntryKind::File
        };
        entries.push(FileEntry {
            path: path_string(&relative.join(&name)),
            hidden: name.starts_with('.'),
            generated: kind == EntryKind::Directory && is_generated_directory_name(&name),
            name,
            kind,
            size: metadata.len(),
            ignored: false,
        });
    }
    let ignored = git_ignored_paths(root, entries.iter().map(|entry| entry.path.as_str()));
    for entry in &mut entries {
        entry.ignored = ignored.contains(&entry.path);
    }
    entries.sort_by(|left, right| {
        entry_kind_rank(&left.kind)
            .cmp(&entry_kind_rank(&right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

fn git_failure(output: &std::process::Output) -> WorkspaceError {
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    WorkspaceError::Git(if message.is_empty() {
        format!("git exited with {}", output.status)
    } else {
        message
    })
}

fn worktree_branch(session_id: &str) -> String {
    format!("kubecode/{session_id}")
}

fn migrate_project_paths(
    database: &mut Connection,
    legacy_root: &Path,
) -> Result<(), WorkspaceError> {
    let mut statement = database.prepare("SELECT id, path FROM projects")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (id, stored) in rows {
        let path = Path::new(&stored);
        if path.is_absolute() {
            continue;
        }
        let absolute = legacy_root.join(path).canonicalize()?;
        transaction.execute(
            "UPDATE projects SET path = ?2 WHERE id = ?1",
            params![id, path_string(&absolute)],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn require_absolute(path: &Path) -> Result<&Path, WorkspaceError> {
    if !path.is_absolute() {
        return Err(WorkspaceError::InvalidPath(path_string(path)));
    }
    Ok(path)
}

fn reject_state_directory(legacy_root: &Path, candidate: &Path) -> Result<(), WorkspaceError> {
    let state = legacy_root.join(STATE_DIRECTORY);
    if candidate == state || candidate.starts_with(&state) {
        return Err(WorkspaceError::InvalidPath(path_string(candidate)));
    }
    Ok(())
}

fn normalize_relative(value: &str, allow_empty: bool) -> Result<PathBuf, WorkspaceError> {
    let mut normalized = PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceError::InvalidPath(value.to_owned()));
            }
        }
    }
    if normalized.as_os_str().is_empty() && !allow_empty {
        return Err(WorkspaceError::InvalidPath(value.to_owned()));
    }
    ensure_not_state_path(&normalized)?;
    Ok(normalized)
}

fn ensure_not_state_path(relative: &Path) -> Result<(), WorkspaceError> {
    if relative
        .components()
        .next()
        .is_some_and(|component| component.as_os_str() == STATE_DIRECTORY)
    {
        return Err(WorkspaceError::InvalidPath(
            relative.to_string_lossy().into_owned(),
        ));
    }
    Ok(())
}

fn ensure_contained(root: &Path, candidate: &Path, display: String) -> Result<(), WorkspaceError> {
    if candidate == root || !candidate.starts_with(root) {
        return Err(WorkspaceError::InvalidPath(display));
    }
    Ok(())
}

fn ensure_contained_or_same(
    root: &Path,
    candidate: &Path,
    display: String,
) -> Result<(), WorkspaceError> {
    if !candidate.starts_with(root) {
        return Err(WorkspaceError::InvalidPath(display));
    }
    Ok(())
}

fn revision(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// How a native watch event path is exposed across the Project-relative
/// boundary. Only `WorkspaceService` converts native paths.
#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) enum WatchedPathClassification {
    /// An ordinary Project-relative entry path, serialized with `/`.
    Ordinary(String),
    /// A path whose first component is exactly `.git`; Git-only invalidation.
    GitOnly,
    /// The batch must become a full reconciliation (root, escaping, or unsafe).
    Full,
}

/// Converts a native absolute path observed for a Project watch registration
/// into a validated Project-relative classification.
///
/// The Project root itself is a full invalidation. A path that cannot be
/// classified safely is also full so the complete Project batch fails closed
/// rather than dropping the path.
pub(crate) fn classify_watched_path(
    project_root: &Path,
    absolute: &Path,
) -> WatchedPathClassification {
    let relative = match absolute.strip_prefix(project_root) {
        Ok(relative) => relative,
        Err(_) => return WatchedPathClassification::Full,
    };
    if relative.as_os_str().is_empty() {
        return WatchedPathClassification::Full;
    }
    let mut normalized = PathBuf::new();
    for (index, component) in relative.components().enumerate() {
        let Component::Normal(name) = component else {
            return WatchedPathClassification::Full;
        };
        let name = match name.to_str() {
            Some(name) => name,
            None => return WatchedPathClassification::Full,
        };
        if name.is_empty() || name == "." || name == ".." || name.contains('\0') {
            return WatchedPathClassification::Full;
        }
        if index == 0 && name == ".git" {
            return WatchedPathClassification::GitOnly;
        }
        normalized.push(name);
    }
    // Containment: check the target, or the nearest existing ancestor for a
    // removed target, against the same escaping-symlink rules used by the
    // Project file APIs.
    let mut existing = absolute;
    loop {
        if existing.exists() {
            break;
        }
        match existing.parent() {
            Some(parent) => existing = parent,
            None => return WatchedPathClassification::Full,
        }
    }
    match existing.canonicalize() {
        Ok(canonical) if canonical.starts_with(project_root) => {}
        _ => return WatchedPathClassification::Full,
    }
    WatchedPathClassification::Ordinary(path_string(&normalized))
}

fn entry_kind_rank(kind: &EntryKind) -> u8 {
    match kind {
        EntryKind::Directory => 0,
        EntryKind::File => 1,
    }
}

pub(crate) fn is_generated_relative_path(path: &str) -> bool {
    Path::new(path)
        .components()
        .any(|component| match component {
            Component::Normal(name) => is_generated_directory_name(&name.to_string_lossy()),
            _ => false,
        })
}

fn is_generated_directory_name(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".next"
            | ".pytest_cache"
            | ".venv"
            | "__pycache__"
            | "build"
            | "coverage"
            | "dist"
            | "node_modules"
            | "target"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify_temp(relative: &Path) -> WatchedPathClassification {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().canonicalize().expect("canonical root");
        if let Some(parent) = relative.parent() {
            std::fs::create_dir_all(root.join(parent)).expect("parent dirs");
        }
        if let Some(name) = relative.file_name() {
            std::fs::write(root.join(relative), name.to_string_lossy().as_bytes()).expect("entry");
        }
        let absolute = root.join(relative);
        // Classification happens after the entry is removed so removed files
        // resolve against their nearest existing ancestor.
        std::fs::remove_file(&absolute).expect("remove entry");
        classify_watched_path(&root, &absolute)
    }

    #[test]
    fn classifies_nested_ordinary_path() {
        assert_eq!(
            classify_temp(Path::new("src/main.rs")),
            WatchedPathClassification::Ordinary("src/main.rs".to_owned())
        );
    }

    #[test]
    fn classifies_root_as_full() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().canonicalize().expect("canonical root");
        assert_eq!(
            classify_watched_path(&root, &root),
            WatchedPathClassification::Full
        );
    }

    #[test]
    fn classifies_git_first_component_as_git_only() {
        assert_eq!(
            classify_temp(Path::new(".git/HEAD")),
            WatchedPathClassification::GitOnly
        );
    }

    #[test]
    fn classifies_gitignore_as_ordinary() {
        assert_eq!(
            classify_temp(Path::new(".gitignore")),
            WatchedPathClassification::Ordinary(".gitignore".to_owned())
        );
    }

    #[test]
    fn classifies_escaping_path_as_full() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().canonicalize().expect("canonical root");
        let outside = root.join("../../outside.txt");
        assert_eq!(
            classify_watched_path(&root, &outside),
            WatchedPathClassification::Full
        );
    }

    #[test]
    fn classifies_symlink_escape_as_full() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().canonicalize().expect("canonical root");
        let outside = tempfile::tempdir().expect("outside tempdir");
        std::os::unix::fs::symlink(outside.path(), root.join("link")).expect("symlink");
        let absolute = root.join("link/escape.txt");
        assert_eq!(
            classify_watched_path(&root, &absolute),
            WatchedPathClassification::Full
        );
    }
}
