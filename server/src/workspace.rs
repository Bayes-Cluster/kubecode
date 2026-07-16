use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const MAX_EDITABLE_BYTES: usize = 5 * 1024 * 1024;
const STATE_DIRECTORY: &str = ".state";

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("invalid workspace path: {0}")]
    InvalidPath(String),
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
    #[error("git worktree operation failed: {0}")]
    Git(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
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
    database: Mutex<Connection>,
}

impl WorkspaceService {
    pub fn open(
        root: impl AsRef<Path>,
        database_path: impl AsRef<Path>,
    ) -> Result<Self, WorkspaceError> {
        fs::create_dir_all(root.as_ref())?;
        let root = root.as_ref().canonicalize()?;
        if let Some(parent) = database_path.as_ref().parent() {
            fs::create_dir_all(parent)?;
        }
        let state_root = database_path
            .as_ref()
            .parent()
            .ok_or_else(|| WorkspaceError::InvalidPath(path_string(database_path.as_ref())))?
            .canonicalize()?;

        let database = Connection::open(database_path)?;
        database.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS projects (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               path TEXT NOT NULL UNIQUE,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );",
        )?;
        ensure_column(
            &database,
            "projects",
            "workspaces_enabled",
            "INTEGER NOT NULL DEFAULT 0",
        )?;

        migrate_project_paths(&database, &root)?;

        Ok(Self {
            root,
            state_root,
            database: Mutex::new(database),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn project_path(&self, project_id: &str) -> Result<PathBuf, WorkspaceError> {
        self.project_root(project_id)
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
        validate_storage_id(session_id)?;
        let project = self.project(project_id)?;
        if !project.workspaces_enabled {
            return Err(WorkspaceError::InvalidPath(
                "Workspaces are disabled for this project".into(),
            ));
        }
        let project_root = PathBuf::from(&project.path).canonicalize()?;
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
            &project_root,
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
        let database = self
            .database
            .lock()
            .expect("workspace database mutex poisoned");
        let changed = database.execute("DELETE FROM projects WHERE id = ?1", [project_id])?;
        if changed == 0 {
            return Err(WorkspaceError::ProjectNotFound(project_id.to_owned()));
        }
        Ok(())
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
        let relative = normalize_relative(relative, true)?;
        let directory = project_root.join(&relative).canonicalize()?;
        ensure_contained_or_same(
            &project_root,
            &directory,
            relative.to_string_lossy().into_owned(),
        )?;
        if !directory.is_dir() {
            return Err(WorkspaceError::InvalidPath(path_string(&relative)));
        }

        let mut entries = Vec::new();
        for result in fs::read_dir(directory)? {
            let entry = result?;
            if entry.file_name() == STATE_DIRECTORY {
                continue;
            }
            let canonical = match entry.path().canonicalize() {
                Ok(path) if path.starts_with(&project_root) => path,
                _ => continue,
            };
            let metadata = canonical.metadata()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            entries.push(FileEntry {
                path: path_string(&relative.join(&name)),
                name,
                kind: if metadata.is_dir() {
                    EntryKind::Directory
                } else {
                    EntryKind::File
                },
                size: metadata.len(),
            });
        }
        entries.sort_by(|left, right| {
            entry_kind_rank(&left.kind)
                .cmp(&entry_kind_rank(&right.kind))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
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

fn ensure_column(
    database: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), WorkspaceError> {
    let mut statement = database.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|current| current == column) {
        database.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
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
        .output()
        .map_err(WorkspaceError::from)
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

fn migrate_project_paths(database: &Connection, legacy_root: &Path) -> Result<(), WorkspaceError> {
    let mut statement = database.prepare("SELECT id, path FROM projects")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let transaction = database.unchecked_transaction()?;
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

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn entry_kind_rank(kind: &EntryKind) -> u8 {
    match kind {
        EntryKind::Directory => 0,
        EntryKind::File => 1,
    }
}
