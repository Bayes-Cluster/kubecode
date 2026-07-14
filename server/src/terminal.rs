use std::collections::{HashMap, VecDeque};
use std::env;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::workspace::{WorkspaceError, WorkspaceService};

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal not found: {0}")]
    NotFound(String),
    #[error("the project terminal limit has been reached")]
    LimitReached,
    #[error("PTY error: {0}")]
    Pty(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TerminalSnapshot {
    pub data: String,
    pub cursor: u64,
    pub truncated: bool,
}

pub struct TerminalManager {
    workspace: Arc<WorkspaceService>,
    per_project_limit: usize,
    buffer_capacity: usize,
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
}

struct TerminalSession {
    info: Mutex<TerminalInfo>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    buffer: Arc<Mutex<TerminalBuffer>>,
}

struct TerminalBuffer {
    bytes: VecDeque<u8>,
    start_cursor: u64,
    end_cursor: u64,
    capacity: usize,
}

impl TerminalManager {
    pub fn new(
        workspace: Arc<WorkspaceService>,
        per_project_limit: usize,
        buffer_capacity: usize,
    ) -> Self {
        Self {
            workspace,
            per_project_limit,
            buffer_capacity,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn workspace(&self) -> Arc<WorkspaceService> {
        Arc::clone(&self.workspace)
    }

    pub fn create(
        &self,
        project_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo, TerminalError> {
        let project_path = self.workspace.project_path(project_id)?;
        let mut sessions = self
            .sessions
            .lock()
            .expect("terminal sessions mutex poisoned");
        let existing = sessions
            .values()
            .filter(|session| {
                session
                    .info
                    .lock()
                    .expect("terminal info mutex poisoned")
                    .project_id
                    == project_id
            })
            .count();
        if existing >= self.per_project_limit {
            return Err(TerminalError::LimitReached);
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned());
        let mut command = CommandBuilder::new(shell);
        command.cwd(project_path);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Pty(error.to_string()))?;

        let id = Uuid::new_v4().to_string();
        let info = TerminalInfo {
            id: id.clone(),
            project_id: project_id.to_owned(),
            title: format!("Terminal {}", existing + 1),
            cols,
            rows,
        };
        let buffer = Arc::new(Mutex::new(TerminalBuffer::new(self.buffer_capacity)));
        let reader_buffer = Arc::clone(&buffer);
        thread::Builder::new()
            .name(format!("kubecode-pty-{id}"))
            .spawn(move || copy_pty_output(&mut reader, &reader_buffer))?;

        sessions.insert(
            id,
            Arc::new(TerminalSession {
                info: Mutex::new(info.clone()),
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                buffer,
            }),
        );
        Ok(info)
    }

    pub fn list(&self, project_id: &str) -> Vec<TerminalInfo> {
        let sessions = self
            .sessions
            .lock()
            .expect("terminal sessions mutex poisoned");
        let mut result = sessions
            .values()
            .filter_map(|session| {
                let info = session
                    .info
                    .lock()
                    .expect("terminal info mutex poisoned")
                    .clone();
                (info.project_id == project_id).then_some(info)
            })
            .collect::<Vec<_>>();
        result.sort_by(|left, right| left.title.cmp(&right.title));
        result
    }

    pub fn get(&self, terminal_id: &str) -> Result<TerminalInfo, TerminalError> {
        let session = self.session(terminal_id)?;
        let info = session
            .info
            .lock()
            .expect("terminal info mutex poisoned")
            .clone();
        Ok(info)
    }

    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let session = self.session(terminal_id)?;
        let mut writer = session
            .writer
            .lock()
            .expect("terminal writer mutex poisoned");
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let session = self.session(terminal_id)?;
        session
            .master
            .lock()
            .expect("terminal master mutex poisoned")
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let mut info = session.info.lock().expect("terminal info mutex poisoned");
        info.cols = cols;
        info.rows = rows;
        Ok(())
    }

    pub fn read_since(
        &self,
        terminal_id: &str,
        cursor: u64,
    ) -> Result<TerminalSnapshot, TerminalError> {
        let session = self.session(terminal_id)?;
        Ok(session
            .buffer
            .lock()
            .expect("terminal buffer mutex poisoned")
            .snapshot(cursor))
    }

    pub fn close(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let session = self
            .sessions
            .lock()
            .expect("terminal sessions mutex poisoned")
            .remove(terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_owned()))?;
        session
            .child
            .lock()
            .expect("terminal child mutex poisoned")
            .kill()?;
        Ok(())
    }

    fn session(&self, terminal_id: &str) -> Result<Arc<TerminalSession>, TerminalError> {
        self.sessions
            .lock()
            .expect("terminal sessions mutex poisoned")
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_owned()))
    }
}

impl TerminalBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(capacity),
            start_cursor: 0,
            end_cursor: 0,
            capacity,
        }
    }

    fn push(&mut self, data: &[u8]) {
        self.end_cursor = self.end_cursor.saturating_add(data.len() as u64);
        self.bytes.extend(data);
        while self.bytes.len() > self.capacity {
            self.bytes.pop_front();
            self.start_cursor = self.start_cursor.saturating_add(1);
        }
    }

    fn snapshot(&self, cursor: u64) -> TerminalSnapshot {
        let truncated = cursor < self.start_cursor;
        let effective_cursor = cursor.clamp(self.start_cursor, self.end_cursor);
        let skip = (effective_cursor - self.start_cursor) as usize;
        let bytes = self.bytes.iter().skip(skip).copied().collect::<Vec<_>>();
        TerminalSnapshot {
            data: String::from_utf8_lossy(&bytes).into_owned(),
            cursor: self.end_cursor,
            truncated,
        }
    }
}

fn copy_pty_output(reader: &mut dyn Read, buffer: &Arc<Mutex<TerminalBuffer>>) {
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(read) => buffer
                .lock()
                .expect("terminal buffer mutex poisoned")
                .push(&chunk[..read]),
        }
    }
}
