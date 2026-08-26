use std::collections::{HashMap, VecDeque};
use std::env;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::agent_discovery::{AgentCatalog, AgentDescriptor};
use crate::agents::AgentId;
use crate::workspace::{WorkspaceError, WorkspaceService};

pub const MAX_TERMINAL_CONTEXT_BYTES: usize = 16 * 1024;
pub const MAX_TERMINAL_CONTEXT_LINES: usize = 120;
const MAX_TERMINAL_SELECTION_INPUT_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_CONTEXT_CAPTURES: usize = 2_048;

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal not found: {0}")]
    NotFound(String),
    #[error("the project terminal limit has been reached")]
    LimitReached,
    #[error("agent is not available: {0:?}")]
    AgentUnavailable(AgentId),
    #[error("terminal title must be 1-80 characters without control characters")]
    InvalidTitle,
    #[error("terminal context exceeds its line or byte limit")]
    ContextOverLimit,
    #[error("terminal context contains binary data")]
    ContextBinary,
    #[error("terminal context selection is empty or unavailable")]
    ContextSelectionUnavailable,
    #[error("terminal context is stale or disconnected")]
    ContextStale,
    #[error("PTY error: {0}")]
    Pty(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalKind {
    #[default]
    Regular,
    ClaudeCode,
    Codex,
    #[serde(rename = "opencode")]
    OpenCode,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    #[default]
    Running,
    Exited,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalContextCaptureKind {
    Selection,
    Recent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalContextCapture {
    pub terminal_id: String,
    pub target_conversation_id: String,
    pub capture: TerminalContextCaptureKind,
    pub content: String,
    pub source_revision: String,
    pub line_count: usize,
    pub byte_count: usize,
    pub truncated: bool,
    observed_start_cursor: u64,
    observed_end_cursor: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BoundedTerminalContext {
    content: String,
    line_count: usize,
    byte_count: usize,
    truncated: bool,
}

impl TerminalKind {
    fn agent_id(self) -> Option<AgentId> {
        match self {
            Self::Regular => None,
            Self::ClaudeCode => Some(AgentId::ClaudeCode),
            Self::Codex => Some(AgentId::Codex),
            Self::OpenCode => Some(AgentId::OpenCode),
        }
    }

    fn title(self, sequence: usize) -> String {
        match self {
            Self::Regular => format!("Terminal {sequence}"),
            Self::ClaudeCode => "Claude Code".to_owned(),
            Self::Codex => "Codex".to_owned(),
            Self::OpenCode => "OpenCode".to_owned(),
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
struct TerminalLaunchSpec {
    program: String,
    arguments: Vec<String>,
}

fn terminal_launch_spec(kind: TerminalKind, executable: &str, shell: &str) -> TerminalLaunchSpec {
    if kind == TerminalKind::Regular {
        return TerminalLaunchSpec {
            program: executable.to_owned(),
            arguments: Vec::new(),
        };
    }

    TerminalLaunchSpec {
        program: shell.to_owned(),
        arguments: vec![
            "-l".to_owned(),
            "-i".to_owned(),
            "-c".to_owned(),
            "exec \"$1\"".to_owned(),
            "kubecode-agent-tui".to_owned(),
            executable.to_owned(),
        ],
    }
}

#[cfg(test)]
mod launch_spec_tests {
    use super::{TerminalKind, terminal_launch_spec};

    #[test]
    fn regular_terminals_launch_the_shell_directly() {
        let spec = terminal_launch_spec(TerminalKind::Regular, "/bin/zsh", "/bin/zsh");

        assert_eq!(spec.program, "/bin/zsh");
        assert!(spec.arguments.is_empty());
    }

    #[test]
    fn agent_tuis_load_the_users_interactive_login_shell_environment() {
        let spec = terminal_launch_spec(
            TerminalKind::ClaudeCode,
            "/opt/homebrew/bin/claude",
            "/bin/zsh",
        );

        assert_eq!(spec.program, "/bin/zsh");
        assert_eq!(
            spec.arguments,
            [
                "-l",
                "-i",
                "-c",
                "exec \"$1\"",
                "kubecode-agent-tui",
                "/opt/homebrew/bin/claude",
            ]
        );
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub project_id: String,
    pub conversation_id: Option<String>,
    pub title: String,
    pub kind: TerminalKind,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalStatus,
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
}

#[derive(Clone, Debug)]
pub struct TerminalLifecycleEvent {
    pub kind: &'static str,
    pub terminal: TerminalInfo,
}

pub type TerminalEventSink = Arc<dyn Fn(TerminalLifecycleEvent) + Send + Sync>;

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
    agents: Arc<AgentCatalog>,
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
    context_captures: Mutex<HashMap<String, TerminalContextCapture>>,
    event_sink: TerminalEventSink,
}

struct TerminalSession {
    info: Arc<Mutex<TerminalInfo>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
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
        Self::with_agents(workspace, per_project_limit, buffer_capacity, Vec::new())
    }

    pub fn with_agents(
        workspace: Arc<WorkspaceService>,
        per_project_limit: usize,
        buffer_capacity: usize,
        agents: Vec<AgentDescriptor>,
    ) -> Self {
        Self::with_agents_and_events(
            workspace,
            per_project_limit,
            buffer_capacity,
            agents,
            Arc::new(|_| {}),
        )
    }

    pub fn with_agents_and_events(
        workspace: Arc<WorkspaceService>,
        per_project_limit: usize,
        buffer_capacity: usize,
        agents: Vec<AgentDescriptor>,
        event_sink: TerminalEventSink,
    ) -> Self {
        Self::with_catalog_and_events(
            workspace,
            per_project_limit,
            buffer_capacity,
            AgentCatalog::from_descriptors(agents),
            event_sink,
        )
    }

    pub fn with_catalog_and_events(
        workspace: Arc<WorkspaceService>,
        per_project_limit: usize,
        buffer_capacity: usize,
        agents: Arc<AgentCatalog>,
        event_sink: TerminalEventSink,
    ) -> Self {
        Self {
            workspace,
            per_project_limit,
            buffer_capacity,
            agents,
            sessions: Mutex::new(HashMap::new()),
            context_captures: Mutex::new(HashMap::new()),
            event_sink,
        }
    }

    pub fn workspace(&self) -> Arc<WorkspaceService> {
        Arc::clone(&self.workspace)
    }

    pub fn create(
        &self,
        project_id: &str,
        conversation_id: Option<&str>,
        workspace_path: Option<&str>,
        kind: TerminalKind,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo, TerminalError> {
        let execution_path = self.workspace.execution_path(project_id, workspace_path)?;
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
            .filter(|session| {
                session
                    .info
                    .lock()
                    .expect("terminal info mutex poisoned")
                    .status
                    == TerminalStatus::Running
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
        let executable = self.executable(kind)?;
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned());
        let launch = terminal_launch_spec(kind, &executable, &shell);
        let mut command = CommandBuilder::new(launch.program);
        for argument in launch.arguments {
            command.arg(argument);
        }
        command.cwd(&execution_path);
        command.env("PWD", &execution_path);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| TerminalError::Pty(error.to_string()))?;
        let killer = child.clone_killer();
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
            conversation_id: conversation_id.map(str::to_owned),
            title: kind.title(existing + 1),
            kind,
            cols,
            rows,
            status: TerminalStatus::Running,
            exit_code: None,
            signal: None,
        };
        let info = Arc::new(Mutex::new(info));
        let buffer = Arc::new(Mutex::new(TerminalBuffer::new(self.buffer_capacity)));
        let reader_buffer = Arc::clone(&buffer);
        thread::Builder::new()
            .name(format!("kubecode-pty-{id}"))
            .spawn(move || copy_pty_output(&mut reader, &reader_buffer))?;

        let session = Arc::new(TerminalSession {
            info: Arc::clone(&info),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            buffer,
        });
        sessions.insert(id.clone(), session);
        drop(sessions);
        let event_sink = Arc::clone(&self.event_sink);
        thread::Builder::new()
            .name(format!("kubecode-pty-wait-{id}"))
            .spawn(move || {
                let Ok(status) = child.wait() else {
                    return;
                };
                let terminal = {
                    let mut terminal = info.lock().expect("terminal info mutex poisoned");
                    terminal.status = TerminalStatus::Exited;
                    terminal.exit_code = Some(status.exit_code());
                    terminal.signal = status.signal().map(str::to_owned);
                    terminal.clone()
                };
                event_sink(TerminalLifecycleEvent {
                    kind: "terminal_exited",
                    terminal,
                });
            })?;
        self.get(&id)
    }

    fn executable(&self, kind: TerminalKind) -> Result<String, TerminalError> {
        let Some(agent_id) = kind.agent_id() else {
            return Ok(env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned()));
        };
        self.agents
            .descriptor(agent_id)
            .filter(|agent| agent.available)
            .map(|agent| agent.executable)
            .ok_or(TerminalError::AgentUnavailable(agent_id))
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

    pub fn rename(&self, terminal_id: &str, title: &str) -> Result<TerminalInfo, TerminalError> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) {
            return Err(TerminalError::InvalidTitle);
        }
        let session = self.session(terminal_id)?;
        let mut info = session.info.lock().expect("terminal info mutex poisoned");
        info.title = title.to_owned();
        Ok(info.clone())
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

    pub fn capture_context(
        &self,
        terminal_id: &str,
        target_conversation_id: &str,
        capture: TerminalContextCaptureKind,
        selected_text: Option<&str>,
    ) -> Result<TerminalContextCapture, TerminalError> {
        let session = self.session(terminal_id)?;
        if session
            .info
            .lock()
            .expect("terminal info mutex poisoned")
            .status
            != TerminalStatus::Running
        {
            return Err(TerminalError::ContextStale);
        }
        let (bytes, observed_start_cursor, observed_end_cursor) = session
            .buffer
            .lock()
            .expect("terminal buffer mutex poisoned")
            .window();
        let sanitized_buffer = sanitize_terminal_context(&bytes)?;
        let bounded = match capture {
            TerminalContextCaptureKind::Selection => {
                let selected_text = selected_text
                    .filter(|selection| !selection.is_empty())
                    .ok_or(TerminalError::ContextSelectionUnavailable)?;
                if selected_text.len() > MAX_TERMINAL_SELECTION_INPUT_BYTES {
                    return Err(TerminalError::ContextOverLimit);
                }
                let selected = sanitize_terminal_context(selected_text.as_bytes())?;
                let bounded = bounded_terminal_context(
                    selected.trim_matches('\n'),
                    TerminalContextCaptureKind::Selection,
                )?;
                if bounded.content.is_empty() || !sanitized_buffer.contains(&bounded.content) {
                    return Err(TerminalError::ContextSelectionUnavailable);
                }
                bounded
            }
            TerminalContextCaptureKind::Recent => {
                if selected_text.is_some() {
                    return Err(TerminalError::ContextSelectionUnavailable);
                }
                bounded_terminal_context(&sanitized_buffer, TerminalContextCaptureKind::Recent)?
            }
        };
        if bounded.content.is_empty() {
            return Err(TerminalError::ContextSelectionUnavailable);
        }
        let source_revision =
            terminal_context_revision(terminal_id, capture, observed_end_cursor, &bounded.content);
        Ok(TerminalContextCapture {
            terminal_id: terminal_id.to_owned(),
            target_conversation_id: target_conversation_id.to_owned(),
            capture,
            content: bounded.content,
            source_revision,
            line_count: bounded.line_count,
            byte_count: bounded.byte_count,
            truncated: bounded.truncated,
            observed_start_cursor,
            observed_end_cursor,
        })
    }

    pub fn retain_context_capture(
        &self,
        id: String,
        capture: TerminalContextCapture,
    ) -> Result<bool, TerminalError> {
        let mut captures = self
            .context_captures
            .lock()
            .expect("terminal context captures mutex poisoned");
        if captures.contains_key(&id) {
            return Ok(false);
        }
        if captures.len() >= MAX_TERMINAL_CONTEXT_CAPTURES {
            return Err(TerminalError::ContextOverLimit);
        }
        captures.insert(id, capture);
        Ok(true)
    }

    pub fn discard_context_capture(&self, id: &str) {
        self.context_captures
            .lock()
            .expect("terminal context captures mutex poisoned")
            .remove(id);
    }

    pub fn resolve_context_capture(
        &self,
        id: &str,
        target_conversation_id: &str,
    ) -> Result<TerminalContextCapture, TerminalError> {
        let capture = self
            .context_captures
            .lock()
            .expect("terminal context captures mutex poisoned")
            .get(id)
            .filter(|capture| capture.target_conversation_id == target_conversation_id)
            .cloned()
            .ok_or(TerminalError::ContextStale)?;
        let session = self
            .session(&capture.terminal_id)
            .map_err(|_| TerminalError::ContextStale)?;
        if session
            .info
            .lock()
            .expect("terminal info mutex poisoned")
            .status
            != TerminalStatus::Running
        {
            return Err(TerminalError::ContextStale);
        }
        let (bytes, start_cursor, end_cursor) = session
            .buffer
            .lock()
            .expect("terminal buffer mutex poisoned")
            .window();
        if start_cursor > capture.observed_start_cursor || end_cursor < capture.observed_end_cursor
        {
            return Err(TerminalError::ContextStale);
        }
        if capture.capture == TerminalContextCaptureKind::Selection
            && !sanitize_terminal_context(&bytes)?.contains(&capture.content)
        {
            return Err(TerminalError::ContextStale);
        }
        Ok(capture)
    }

    /// Kill every running terminal scoped to the conversation. Local kills are
    /// synchronous and immediate, so callers use this to cut a run's local
    /// child processes before slower provider-side cancellation catches up.
    pub fn kill_by_session(&self, conversation_id: &str) -> usize {
        let matching = {
            let sessions = self
                .sessions
                .lock()
                .expect("terminal sessions mutex poisoned");
            sessions
                .values()
                .filter(|session| {
                    let info = session.info.lock().expect("terminal info mutex poisoned");
                    info.conversation_id.as_deref() == Some(conversation_id)
                        && info.status == TerminalStatus::Running
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut killed = 0;
        for session in matching {
            if session
                .killer
                .lock()
                .expect("terminal killer mutex poisoned")
                .kill()
                .is_ok()
            {
                killed += 1;
            }
        }
        killed
    }

    pub fn close(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let session = self
            .sessions
            .lock()
            .expect("terminal sessions mutex poisoned")
            .remove(terminal_id)
            .ok_or_else(|| TerminalError::NotFound(terminal_id.to_owned()))?;
        let running = session
            .info
            .lock()
            .expect("terminal info mutex poisoned")
            .status
            == TerminalStatus::Running;
        if running {
            session
                .killer
                .lock()
                .expect("terminal killer mutex poisoned")
                .kill()?;
        }
        self.context_captures
            .lock()
            .expect("terminal context captures mutex poisoned")
            .retain(|_, capture| capture.terminal_id != terminal_id);
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

    fn window(&self) -> (Vec<u8>, u64, u64) {
        (
            self.bytes.iter().copied().collect(),
            self.start_cursor,
            self.end_cursor,
        )
    }
}

fn sanitize_terminal_context(bytes: &[u8]) -> Result<String, TerminalError> {
    #[derive(Clone, Copy)]
    enum State {
        Ground,
        Escape,
        Csi,
        Osc,
        OscEscape,
        Dcs,
        DcsEscape,
    }

    if bytes.contains(&0) {
        return Err(TerminalError::ContextBinary);
    }
    let mut output = Vec::with_capacity(bytes.len());
    let mut state = State::Ground;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        match state {
            State::Ground => match byte {
                0x1b => state = State::Escape,
                b'\r' => {
                    output.push(b'\n');
                    if bytes.get(index + 1) == Some(&b'\n') {
                        index += 1;
                    }
                }
                b'\n' | b'\t' => output.push(byte),
                0x00..=0x1f | 0x7f => {}
                _ => output.push(byte),
            },
            State::Escape => {
                state = match byte {
                    b'[' => State::Csi,
                    b']' => State::Osc,
                    b'P' | b'^' | b'_' => State::Dcs,
                    _ => State::Ground,
                };
            }
            State::Csi => {
                if (0x40..=0x7e).contains(&byte) {
                    state = State::Ground;
                }
            }
            State::Osc => match byte {
                0x07 => state = State::Ground,
                0x1b => state = State::OscEscape,
                _ => {}
            },
            State::OscEscape => {
                state = if byte == b'\\' {
                    State::Ground
                } else {
                    State::Osc
                };
            }
            State::Dcs => {
                if byte == 0x1b {
                    state = State::DcsEscape;
                }
            }
            State::DcsEscape => {
                state = if byte == b'\\' {
                    State::Ground
                } else {
                    State::Dcs
                };
            }
        }
        index += 1;
    }
    String::from_utf8(output).map_err(|_| TerminalError::ContextBinary)
}

fn bounded_terminal_context(
    content: &str,
    capture: TerminalContextCaptureKind,
) -> Result<BoundedTerminalContext, TerminalError> {
    let line_count = || {
        if content.is_empty() {
            0
        } else {
            content.split('\n').count()
        }
    };
    if capture == TerminalContextCaptureKind::Selection {
        if content.len() > MAX_TERMINAL_CONTEXT_BYTES || line_count() > MAX_TERMINAL_CONTEXT_LINES {
            return Err(TerminalError::ContextOverLimit);
        }
        return Ok(BoundedTerminalContext {
            content: content.to_owned(),
            line_count: line_count(),
            byte_count: content.len(),
            truncated: false,
        });
    }

    let lines = content.split('\n').collect::<Vec<_>>();
    let first_line = lines.len().saturating_sub(MAX_TERMINAL_CONTEXT_LINES);
    let mut bounded = lines[first_line..].join("\n");
    let mut truncated = first_line > 0;
    if bounded.len() > MAX_TERMINAL_CONTEXT_BYTES {
        let mut start = bounded.len() - MAX_TERMINAL_CONTEXT_BYTES;
        while !bounded.is_char_boundary(start) {
            start += 1;
        }
        bounded = bounded[start..].to_owned();
        truncated = true;
    }
    Ok(BoundedTerminalContext {
        line_count: if bounded.is_empty() {
            0
        } else {
            bounded.split('\n').count()
        },
        byte_count: bounded.len(),
        content: bounded,
        truncated,
    })
}

fn terminal_context_revision(
    terminal_id: &str,
    capture: TerminalContextCaptureKind,
    cursor: u64,
    content: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"kubecode-terminal-context-v1\0");
    digest.update(terminal_id.len().to_be_bytes());
    digest.update(terminal_id.as_bytes());
    digest.update(match capture {
        TerminalContextCaptureKind::Selection => b"selection".as_slice(),
        TerminalContextCaptureKind::Recent => b"recent".as_slice(),
    });
    digest.update(cursor.to_be_bytes());
    digest.update(content.len().to_be_bytes());
    digest.update(content.as_bytes());
    hex::encode(digest.finalize())
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

#[cfg(test)]
mod context_capture_tests {
    use super::{
        MAX_TERMINAL_CONTEXT_BYTES, MAX_TERMINAL_CONTEXT_LINES, TerminalContextCaptureKind,
        TerminalError, bounded_terminal_context, sanitize_terminal_context,
    };

    #[test]
    fn terminal_context_strips_ansi_osc_and_unsafe_controls() {
        let sanitized = sanitize_terminal_context(
            b"\x1b[31mfailed\x1b[0m\r\n\x1b]0;/private/project\x07next\x08!\tvalue",
        )
        .expect("text output");

        assert_eq!(sanitized, "failed\nnext!\tvalue");
        assert!(!sanitized.contains("/private/project"));
    }

    #[test]
    fn terminal_context_rejects_binary_and_oversized_explicit_selections() {
        assert!(matches!(
            sanitize_terminal_context(b"text\0binary"),
            Err(TerminalError::ContextBinary)
        ));
        let oversized = "x".repeat(MAX_TERMINAL_CONTEXT_BYTES + 1);
        assert!(matches!(
            bounded_terminal_context(&oversized, TerminalContextCaptureKind::Selection),
            Err(TerminalError::ContextOverLimit)
        ));
    }

    #[test]
    fn recent_terminal_context_keeps_only_an_explicit_bounded_tail() {
        let output = (0..MAX_TERMINAL_CONTEXT_LINES + 10)
            .map(|index| format!("line-{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let bounded = bounded_terminal_context(&output, TerminalContextCaptureKind::Recent)
            .expect("bounded tail");

        assert!(bounded.truncated);
        assert_eq!(bounded.line_count, MAX_TERMINAL_CONTEXT_LINES);
        assert!(bounded.content.len() <= MAX_TERMINAL_CONTEXT_BYTES);
        assert!(!bounded.content.contains("line-0\n"));
        assert!(
            bounded
                .content
                .ends_with(&format!("line-{}", MAX_TERMINAL_CONTEXT_LINES + 9))
        );
    }
}
