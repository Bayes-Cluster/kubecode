//! The local experiment runner (ADR 0213 section 6): launches an authorized
//! command as a managed process, observes it without an Agent turn or browser
//! connection staying open, and recovers it after a Runtime restart.
//!
//! Launch is crash-safe by construction. The budget is reserved and the
//! attempt recorded before any side effect; `launching` is recorded
//! immediately before the spawn; the process identity is recorded right
//! after. Output goes to files and the exit code to an atomically written
//! receipt, so the outcome is recoverable even if the Runtime died while the
//! process ran. A launch whose fate cannot be established becomes `unknown`
//! and is never resubmitted.

mod process;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::experiment_store::{
    ArtifactRevision, Experiment, ExperimentError, ExperimentState, ExperimentStore, NewLaunch,
    Outcome,
};
use crate::teams::{TeamError, TeamStore};
use crate::workspace::{WorkspaceError, WorkspaceService};

const TERM_GRACE: Duration = Duration::from_secs(2);
/// Recorded as the reason when the runtime cap triggers the stop, so the
/// outcome is still `timed_out` after a Runtime restart.
const TIMEOUT_REASON: &str = "stopping at the runtime limit";
/// Cap on each captured log file (the program's other files are not limited).
const LOG_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_LOG_TAIL_BYTES: u64 = 64 * 1024;

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error(transparent)]
    Experiment(#[from] ExperimentError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Team(#[from] TeamError),
    #[error("the process could not be started: {0}")]
    Spawn(String),
}

pub struct ExperimentRunner {
    store: Arc<ExperimentStore>,
    workspace: Arc<WorkspaceService>,
    teams: Arc<TeamStore>,
    monitored: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    poll: Duration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// The tail of a log, bounded; `total` is the file's full size.
#[derive(Clone, Debug, serde::Serialize)]
pub struct LogTail {
    pub text: String,
    pub total_bytes: u64,
    pub truncated: bool,
}

impl ExperimentRunner {
    pub fn new(
        store: Arc<ExperimentStore>,
        workspace: Arc<WorkspaceService>,
        teams: Arc<TeamStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            workspace,
            teams,
            monitored: Mutex::default(),
            poll: Duration::from_millis(200),
        })
    }

    /// A faster poll for tests.
    pub fn with_poll(self: Arc<Self>, poll: Duration) -> Arc<Self> {
        match Arc::try_unwrap(self) {
            Ok(mut runner) => {
                runner.poll = poll;
                Arc::new(runner)
            }
            Err(shared) => shared,
        }
    }

    pub fn store(&self) -> &Arc<ExperimentStore> {
        &self.store
    }

    // -- Launch -------------------------------------------------------------

    /// Admits and starts one experiment. Replaying a launch key returns the
    /// existing attempt and never starts a second process.
    pub fn launch(
        self: &Arc<Self>,
        project_id: &str,
        research_id: &str,
        request: NewLaunch,
    ) -> Result<Experiment, RunnerError> {
        // The directory is validated before anything is reserved, so a bad
        // path never consumes budget.
        let workspace_path = match &request.team_id {
            Some(team_id) => self.teams.get_team(team_id)?.workspace_path,
            None => None,
        };
        let cwd = self.workspace.resolve_execution_cwd(
            project_id,
            workspace_path.as_deref(),
            &request.cwd,
        )?;
        let (experiment, _) = self.store.reserve(project_id, research_id, request)?;
        if experiment.state != ExperimentState::Reserved {
            return Ok(experiment);
        }
        // Only one caller wins the claim to spawn; a replay or a concurrent
        // duplicate sees the attempt as already launching.
        match self.store.mark_launching(&experiment.id) {
            Ok(_) => {}
            Err(ExperimentError::State(_)) => return Ok(self.store.get(&experiment.id)?),
            Err(error) => return Err(error.into()),
        }
        self.spawn(experiment, cwd)
    }

    fn spawn(
        self: &Arc<Self>,
        experiment: Experiment,
        cwd: PathBuf,
    ) -> Result<Experiment, RunnerError> {
        let dir = self.workspace.experiment_dir(&experiment.id)?;
        let started = std::fs::create_dir_all(&dir).and_then(|()| {
            tokio::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(process::WRAPPER)
                .arg("kubecode-experiment")
                .args(&experiment.argv)
                .current_dir(&cwd)
                .env("KUBECODE_EXPERIMENT_DIR", &dir)
                .env("KUBECODE_EXPERIMENT_LOG_LIMIT", LOG_LIMIT_BYTES.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .kill_on_drop(false)
                .spawn()
        });
        let mut child = match started {
            Ok(child) => child,
            Err(error) => {
                self.finish(
                    &experiment,
                    Outcome {
                        state: Some(ExperimentState::FailedToStart),
                        reason: Some(format!("spawn failed: {error}")),
                        ..Outcome::default()
                    },
                );
                return Ok(self.store.get(&experiment.id)?);
            }
        };
        let pid = child.id().map(i64::from);
        let identity = pid.and_then(process::identity);
        // Reap the wrapper when it exits so it never lingers as a zombie.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        let Some(identity) = identity else {
            // It already ended (or vanished) before its identity could be read;
            // the receipt, if any, tells the story.
            self.finish_from_files(&experiment);
            return Ok(self.store.get(&experiment.id)?);
        };
        let running = match self.store.mark_running(&experiment.id, &identity) {
            Ok(running) => running,
            Err(error) => {
                // The record is gone (its Team was removed) or changed under
                // us: a process nobody supervises must not be left running.
                process::signal_whole_group(&identity, process::SIGKILL);
                return Err(error.into());
            }
        };
        self.watch(&experiment.id);
        Ok(running)
    }

    // -- Observation ----------------------------------------------------------

    fn watch(self: &Arc<Self>, experiment_id: &str) {
        let mut monitored = self.monitored.lock().expect("monitor set poisoned");
        monitored.retain(|_, handle| !handle.is_finished());
        if monitored.contains_key(experiment_id) {
            return;
        }
        let runner = Arc::clone(self);
        let id = experiment_id.to_owned();
        let handle = tokio::spawn(async move {
            runner.monitor(&id).await;
        });
        monitored.insert(experiment_id.to_owned(), handle);
    }

    async fn monitor(&self, id: &str) {
        let mut term_sent: Option<Instant> = None;
        loop {
            tokio::time::sleep(self.poll).await;
            // The row is gone when its Team was removed: nothing to observe.
            let Ok(experiment) = self.store.get(id) else {
                return;
            };
            if !experiment.state.is_active() || experiment.state == ExperimentState::Unknown {
                return;
            }
            let Some(identity) = experiment.identity.clone() else {
                return;
            };
            let Ok(dir) = self.workspace.experiment_dir(id) else {
                return;
            };
            if process::read_receipt(&dir).is_some() {
                // The program ended; anything it left behind in the group is
                // stopped rather than left unsupervised.
                process::signal_whole_group(&identity, process::SIGKILL);
                self.finish_from_files(&experiment);
                return;
            }
            // The wrapper dies on the first SIGTERM but the program may have
            // trapped it, so the slot is held until the whole group is gone.
            if process::group_alive(&identity) {
                let elapsed = process::elapsed_secs(&identity).unwrap_or(0);
                if term_sent.is_none()
                    && (experiment.state == ExperimentState::Cancelling
                        || elapsed >= u64::from(experiment.max_runtime_secs))
                {
                    if experiment.state != ExperimentState::Cancelling {
                        let _ = self.store.set_reason(id, TIMEOUT_REASON);
                    }
                    process::signal_whole_group(&identity, process::SIGTERM);
                    term_sent = Some(Instant::now());
                }
                if term_sent.is_some_and(|at| at.elapsed() >= TERM_GRACE) {
                    process::signal_whole_group(&identity, process::SIGKILL);
                }
                continue;
            }
            // Gone. Let an in-flight receipt rename land before deciding.
            tokio::time::sleep(Duration::from_millis(50)).await;
            self.finish_from_files(&experiment);
            return;
        }
    }

    fn finish_from_files(&self, experiment: &Experiment) {
        let code = self
            .workspace
            .experiment_dir(&experiment.id)
            .ok()
            .and_then(|dir| process::read_receipt(&dir));
        // Intent that we recorded ourselves; never inferred from elapsed time,
        // which says nothing about how a lost process ended.
        let cancelled = experiment.cancel_requested;
        let timed_out = self
            .store
            .get(&experiment.id)
            .ok()
            .and_then(|current| current.reason)
            .is_some_and(|reason| reason == TIMEOUT_REASON);
        let outcome = match code {
            Some(code) if code > 128 && timed_out => Outcome {
                state: Some(ExperimentState::TimedOut),
                exit_code: Some(code),
                signal: Some(code - 128),
                reason: Some("stopped at the runtime limit".into()),
                ..Outcome::default()
            },
            Some(code) if code > 128 && cancelled => Outcome {
                state: Some(ExperimentState::Cancelled),
                exit_code: Some(code),
                signal: Some(code - 128),
                reason: Some("cancelled".into()),
                ..Outcome::default()
            },
            Some(code @ (126 | 127)) => Outcome {
                state: Some(ExperimentState::FailedToStart),
                exit_code: Some(code),
                reason: Some("the command could not be executed".into()),
                ..Outcome::default()
            },
            Some(code) => Outcome {
                state: Some(ExperimentState::Exited),
                exit_code: Some(code),
                signal: (code > 128 && code <= 192).then_some(code - 128),
                ..Outcome::default()
            },
            None if cancelled => Outcome {
                state: Some(ExperimentState::Cancelled),
                reason: Some("cancelled".into()),
                ..Outcome::default()
            },
            None if timed_out => Outcome {
                state: Some(ExperimentState::TimedOut),
                reason: Some("stopped at the runtime limit".into()),
                ..Outcome::default()
            },
            None => Outcome {
                state: Some(ExperimentState::Unknown),
                reason: Some("the process ended without an exit receipt".into()),
                ..Outcome::default()
            },
        };
        self.finish(experiment, outcome);
    }

    fn finish(&self, experiment: &Experiment, mut outcome: Outcome) {
        // Artifacts are resolved where the process ran: the Team's worktree
        // when it has one, otherwise the Project.
        let workspace_path = experiment
            .team_id
            .as_deref()
            .and_then(|team_id| self.teams.get_team(team_id).ok())
            .and_then(|team| team.workspace_path);
        outcome.artifact_revisions = experiment
            .artifacts
            .iter()
            .map(|path| ArtifactRevision {
                path: path.clone(),
                revision: self
                    .workspace
                    .execution_file_revision(
                        &experiment.project_id,
                        workspace_path.as_deref(),
                        path,
                    )
                    .ok(),
            })
            .collect();
        // The observation commits its own delivery to the responsible member.
        let _ = self.store.observe(&experiment.id, outcome);
    }

    // -- Cancellation ---------------------------------------------------------

    /// Stops one experiment. A reservation that never spawned is cancelled
    /// outright; a live process is signalled and its observation follows.
    pub fn cancel(
        self: &Arc<Self>,
        project_id: &str,
        experiment_id: &str,
    ) -> Result<Experiment, RunnerError> {
        self.store.experiment(project_id, experiment_id)?;
        let experiment = self.store.request_cancel(experiment_id)?;
        self.after_cancel(&experiment);
        Ok(experiment)
    }

    fn after_cancel(self: &Arc<Self>, experiment: &Experiment) {
        if experiment.state == ExperimentState::Cancelled {
            return;
        }
        if let Some(identity) = &experiment.identity
            && experiment.state == ExperimentState::Cancelling
        {
            process::signal_group(identity, process::SIGTERM);
            self.watch(&experiment.id);
        }
    }

    /// Cancels every active experiment of a round.
    pub fn cancel_round(
        self: &Arc<Self>,
        project_id: &str,
        research_id: &str,
        round_id: &str,
    ) -> Result<usize, RunnerError> {
        let mut cancelled = 0;
        for experiment in self.store.experiments(project_id, research_id, round_id)? {
            if experiment.state.is_active() && !experiment.cancel_requested {
                let updated = self.store.request_cancel(&experiment.id)?;
                self.after_cancel(&updated);
                cancelled += 1;
            }
        }
        Ok(cancelled)
    }

    /// Terminates a Team's running processes before its records are removed,
    /// and returns the experiment ids so their directories can be cleared once
    /// the rows are gone.
    pub fn cancel_team(self: &Arc<Self>, team_id: &str) -> Vec<String> {
        let Ok(active) = self.store.active_experiments() else {
            return Vec::new();
        };
        let mut ids = Vec::new();
        for experiment in active
            .into_iter()
            .filter(|experiment| experiment.team_id.as_deref() == Some(team_id))
        {
            if let Some(identity) = &experiment.identity {
                process::signal_whole_group(identity, process::SIGKILL);
            }
            ids.push(experiment.id);
        }
        ids
    }

    /// Removes the pid file, logs, and receipt of experiments whose records
    /// are gone.
    pub fn forget(&self, experiment_ids: &[String]) {
        for id in experiment_ids {
            if let Ok(dir) = self.workspace.experiment_dir(id) {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    /// Stops watching without touching any process (a Runtime stopping, or a
    /// test simulating one). Experiments keep running and are adopted by the
    /// next `recover`.
    pub fn abandon_monitors(&self) {
        for (_, handle) in self.monitored.lock().expect("monitor set poisoned").drain() {
            handle.abort();
        }
    }

    // -- Recovery -------------------------------------------------------------

    pub fn recover(self: &Arc<Self>) -> Result<(), RunnerError> {
        for experiment in self.store.active_experiments()? {
            match experiment.state {
                ExperimentState::Reserved => {
                    self.store.abandon_reserved(
                        &experiment.id,
                        "the Runtime stopped before this launched",
                    )?;
                }
                // The identity was never recorded: the process may or may not
                // have started.
                ExperimentState::Launching | ExperimentState::Cancelling
                    if experiment.identity.is_none() =>
                {
                    self.recover_unidentified(&experiment)?;
                }
                ExperimentState::Running | ExperimentState::Cancelling => {
                    self.watch(&experiment.id)
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Establishes what became of a launch whose process identity was never
    /// recorded. The exit receipt settles a finished process. A pid file is
    /// evidence that the wrapper started; the process is adopted only if a
    /// live process with that pid started when the file was written (a reused
    /// pid would have started much later). Anything else is `unknown`.
    fn recover_unidentified(self: &Arc<Self>, experiment: &Experiment) -> Result<(), RunnerError> {
        let Ok(dir) = self.workspace.experiment_dir(&experiment.id) else {
            return Ok(());
        };
        if process::read_receipt(&dir).is_some() {
            self.finish_from_files(experiment);
            return Ok(());
        }
        if let Some((pid, written)) = process::read_pid_file(&dir)
            && let Some(identity) = process::identity(pid)
            && process::is_alive(&identity)
            && process::start_unix(&identity).is_some_and(|started| {
                let written = written
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_secs() as i64)
                    .unwrap_or(0);
                (started - written).abs() <= 3
            })
        {
            self.store.mark_running(&experiment.id, &identity)?;
            self.watch(&experiment.id);
            return Ok(());
        }
        self.finish(
            experiment,
            Outcome {
                state: Some(ExperimentState::Unknown),
                reason: Some(
                    "the Runtime stopped while launching; the process may have started".into(),
                ),
                ..Outcome::default()
            },
        );
        Ok(())
    }

    // -- Logs -----------------------------------------------------------------

    pub fn read_log(
        &self,
        project_id: &str,
        experiment_id: &str,
        stream: LogStream,
        tail_bytes: u64,
    ) -> Result<LogTail, RunnerError> {
        use std::io::{Read, Seek, SeekFrom};
        self.store.experiment(project_id, experiment_id)?;
        let name = match stream {
            LogStream::Stdout => "stdout.log",
            LogStream::Stderr => "stderr.log",
        };
        let path = self.workspace.experiment_dir(experiment_id)?.join(name);
        let tail = tail_bytes.clamp(1, MAX_LOG_TAIL_BYTES);
        let Ok(mut file) = std::fs::File::open(&path) else {
            return Ok(LogTail {
                text: String::new(),
                total_bytes: 0,
                truncated: false,
            });
        };
        let total = file.metadata().map(|m| m.len()).unwrap_or(0);
        let start = total.saturating_sub(tail);
        file.seek(SeekFrom::Start(start))
            .map_err(WorkspaceError::from)?;
        let mut bytes = Vec::new();
        file.take(tail)
            .read_to_end(&mut bytes)
            .map_err(WorkspaceError::from)?;
        Ok(LogTail {
            text: String::from_utf8_lossy(&bytes).into_owned(),
            total_bytes: total,
            truncated: start > 0,
        })
    }
}
