use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher, recommended_watcher};
use serde_json::{Value, json};
use thiserror::Error;

use crate::workspace::{WatchedPathClassification, classify_watched_path};

const CHANNEL_CAPACITY: usize = 1024;
const MAX_CALLBACK_PATHS: usize = 256;
const MAX_PATHS_PER_BATCH: usize = 256;
const QUIET_WINDOW: Duration = Duration::from_millis(250);
const MAX_FLUSH_WINDOW: Duration = Duration::from_secs(2);
const OVERFLOW_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Error)]
pub enum WatcherError {
    #[error("watcher event persistence failed: {0}")]
    Persist(String),
}

/// Appends a durable workspace event for a watcher-produced invalidation.
///
/// The sink is owned by `WorkspaceService`'s watcher machinery and must never
/// block on the native callback path. A persistence failure is surfaced as an
/// error so the worker retains the Project as full-dirty and retries.
pub type WorkspaceEventSink =
    Arc<dyn Fn(&str, &str, &Value) -> Result<(), WatcherError> + Send + Sync>;

/// Handle to the process-owned watcher worker. All watch registrations, the
/// native callback bridge, coalescing worker, retry state, and shutdown
/// lifecycle live behind this type, owned by `WorkspaceService`.
pub struct ProjectWatcher {
    sender: SyncSender<WorkerCommand>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl ProjectWatcher {
    pub fn start(sink: WorkspaceEventSink) -> Self {
        let (sender, receiver) = mpsc::sync_channel(CHANNEL_CAPACITY);
        let callback_sender = sender.clone();
        let join = thread::Builder::new()
            .name("kubecode-watcher".to_owned())
            .spawn(move || Worker::new(receiver, callback_sender, sink).run())
            .expect("spawn kubecode watcher worker");
        Self {
            sender,
            join: Mutex::new(Some(join)),
        }
    }

    pub fn register(&self, project_id: String, root: PathBuf) {
        let _ = self
            .sender
            .send(WorkerCommand::Register { project_id, root });
    }

    pub fn unregister(&self, project_id: String) {
        let _ = self.sender.send(WorkerCommand::Unregister { project_id });
    }

    pub fn shutdown(&self) {
        let _ = self.sender.send(WorkerCommand::Shutdown);
        if let Some(join) = self
            .join
            .lock()
            .expect("watcher join mutex poisoned")
            .take()
        {
            let _ = join.join();
        }
    }
}

#[derive(Debug)]
enum WorkerCommand {
    Register { project_id: String, root: PathBuf },
    Unregister { project_id: String },
    Event(RawRecord),
    Shutdown,
}

#[derive(Debug)]
struct RawRecord {
    project_id: String,
    generation: u64,
    signal: RawSignal,
    backend_error: bool,
}

#[derive(Debug)]
enum RawSignal {
    Paths(Vec<PathBuf>),
    Full,
}

struct Worker {
    receiver: Receiver<WorkerCommand>,
    callback_sender: SyncSender<WorkerCommand>,
    sink: WorkspaceEventSink,
    registrations: HashMap<String, Registration>,
    batches: HashMap<String, ProjectBatch>,
    retries: HashMap<String, RetryEntry>,
    generations: HashMap<String, u64>,
    removed: HashSet<String>,
}

struct Registration {
    watcher: RecommendedWatcher,
    overflow: Arc<AtomicBool>,
    root: PathBuf,
}

struct RetryEntry {
    root: PathBuf,
    attempt: u32,
    next_retry: Option<Instant>,
}

#[derive(Debug, Default)]
struct ProjectBatch {
    paths: Vec<String>,
    has_git: bool,
    full: bool,
    dirty: bool,
    first_seen: Option<Instant>,
    last_seen: Option<Instant>,
    retry_after: Option<Instant>,
}

impl ProjectBatch {
    fn touch(&mut self, now: Instant) {
        if self.first_seen.is_none() {
            self.first_seen = Some(now);
        }
        self.last_seen = Some(now);
        self.retry_after = None;
    }

    fn reset(&mut self) {
        self.paths.clear();
        self.has_git = false;
        self.full = false;
        self.dirty = false;
        self.first_seen = None;
        self.last_seen = None;
        self.retry_after = None;
    }
}

impl Worker {
    fn new(
        receiver: Receiver<WorkerCommand>,
        callback_sender: SyncSender<WorkerCommand>,
        sink: WorkspaceEventSink,
    ) -> Self {
        Self {
            receiver,
            callback_sender,
            sink,
            registrations: HashMap::new(),
            batches: HashMap::new(),
            retries: HashMap::new(),
            generations: HashMap::new(),
            removed: HashSet::new(),
        }
    }

    fn run(mut self) {
        loop {
            let now = Instant::now();
            self.poll_overflow(now);
            self.retry_due(now);
            self.flush_due(now);
            let deadline = self.next_deadline();
            match self.receiver.recv_timeout(deadline) {
                Ok(WorkerCommand::Shutdown) => {
                    self.registrations.clear();
                    self.flush_all_pending(Instant::now());
                    break;
                }
                Ok(command) => self.handle(command),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.registrations.clear();
                    self.flush_all_pending(Instant::now());
                    break;
                }
            }
        }
    }

    fn handle(&mut self, command: WorkerCommand) {
        match command {
            WorkerCommand::Register { project_id, root } => self.register(project_id, root),
            WorkerCommand::Unregister { project_id } => self.unregister(&project_id),
            WorkerCommand::Event(record) => self.ingest(record),
            WorkerCommand::Shutdown => {}
        }
    }

    fn register(&mut self, project_id: String, root: PathBuf) {
        if self.removed.contains(&project_id) {
            return;
        }
        self.retries.remove(&project_id);
        let generation = self.generations.get(&project_id).copied().unwrap_or(0) + 1;
        self.generations.insert(project_id.clone(), generation);
        let overflow = Arc::new(AtomicBool::new(false));
        let callback = make_callback(
            project_id.clone(),
            generation,
            Arc::clone(&overflow),
            self.callback_sender.clone(),
        );
        match install_watch(&root, callback) {
            Ok(watcher) => {
                self.registrations.insert(
                    project_id,
                    Registration {
                        watcher,
                        overflow,
                        root,
                    },
                );
            }
            Err(_) => self.record_unavailable(project_id, root),
        }
    }

    fn unregister(&mut self, project_id: &str) {
        self.removed.insert(project_id.to_owned());
        if let Some(mut registration) = self.registrations.remove(project_id) {
            let _ = registration.watcher.unwatch(&registration.root);
        }
        self.batches.remove(project_id);
        self.retries.remove(project_id);
        let generation = self.generations.get(project_id).copied().unwrap_or(0) + 1;
        self.generations.insert(project_id.to_owned(), generation);
    }

    fn ingest(&mut self, record: RawRecord) {
        if record.generation
            != self
                .generations
                .get(&record.project_id)
                .copied()
                .unwrap_or(0)
        {
            return;
        }
        let now = Instant::now();
        if record.backend_error {
            let root = self
                .registrations
                .get(&record.project_id)
                .map(|registration| registration.root.clone());
            let batch = self.batches.entry(record.project_id.clone()).or_default();
            merge_full(batch, now);
            if let Some(root) = root {
                self.record_unavailable(record.project_id, root);
            }
            return;
        }
        let batch = self.batches.entry(record.project_id.clone()).or_default();
        match record.signal {
            RawSignal::Full => merge_full(batch, now),
            RawSignal::Paths(paths) => {
                let Some(registration) = self.registrations.get(&record.project_id) else {
                    return;
                };
                let root = registration.root.clone();
                let mut merged_full = false;
                for path in paths {
                    match classify_watched_path(&root, &path) {
                        WatchedPathClassification::Ordinary(relative) => {
                            insert_path(&mut batch.paths, relative);
                            if batch.paths.len() > MAX_PATHS_PER_BATCH {
                                merge_full(batch, now);
                                merged_full = true;
                                break;
                            }
                        }
                        WatchedPathClassification::GitOnly => batch.has_git = true,
                        WatchedPathClassification::Full => {
                            merge_full(batch, now);
                            merged_full = true;
                            break;
                        }
                    }
                }
                if !merged_full {
                    batch.dirty = true;
                    batch.touch(now);
                }
            }
        }
    }

    fn poll_overflow(&mut self, now: Instant) {
        let flagged = self
            .registrations
            .iter()
            .filter(|(_, registration)| registration.overflow.load(Ordering::Acquire))
            .map(|(project_id, _)| project_id.clone())
            .collect::<Vec<_>>();
        for project_id in flagged {
            let batch = self.batches.entry(project_id).or_default();
            merge_full(batch, now);
        }
    }

    fn retry_due(&mut self, now: Instant) {
        let due = self
            .retries
            .iter()
            .filter(|(_, entry)| entry.next_retry.is_some_and(|deadline| now >= deadline))
            .map(|(project_id, _)| project_id.clone())
            .collect::<Vec<_>>();
        for project_id in due {
            self.try_install(&project_id);
        }
    }

    fn try_install(&mut self, project_id: &str) {
        let Some(entry) = self.retries.remove(project_id) else {
            return;
        };
        let generation = self.generations.get(project_id).copied().unwrap_or(0) + 1;
        self.generations.insert(project_id.to_owned(), generation);
        let overflow = Arc::new(AtomicBool::new(false));
        let callback = make_callback(
            project_id.to_owned(),
            generation,
            Arc::clone(&overflow),
            self.callback_sender.clone(),
        );
        match install_watch(&entry.root, callback) {
            Ok(watcher) => {
                self.registrations.insert(
                    project_id.to_owned(),
                    Registration {
                        watcher,
                        overflow,
                        root: entry.root,
                    },
                );
                // A successful retry closes the interval during which external
                // changes could not be observed with one full reconciliation.
                let now = Instant::now();
                let payload = json!({"paths": [], "full": true});
                if (self.sink)("file_changed", project_id, &payload).is_err() {
                    let batch = self.batches.entry(project_id.to_owned()).or_default();
                    batch.full = true;
                    batch.dirty = true;
                    batch.retry_after = Some(now + MAX_FLUSH_WINDOW);
                }
            }
            Err(_) => {
                let attempt = entry.attempt + 1;
                let delay = backoff_delay(attempt);
                self.retries.insert(
                    project_id.to_owned(),
                    RetryEntry {
                        root: entry.root,
                        attempt,
                        next_retry: Some(Instant::now() + delay),
                    },
                );
            }
        }
    }

    fn record_unavailable(&mut self, project_id: String, root: PathBuf) {
        self.registrations.remove(&project_id);
        let attempt = self
            .retries
            .get(&project_id)
            .map(|entry| entry.attempt)
            .unwrap_or(0)
            + 1;
        let delay = backoff_delay(attempt);
        self.retries.insert(
            project_id,
            RetryEntry {
                root,
                attempt,
                next_retry: Some(Instant::now() + delay),
            },
        );
    }

    fn flush_due(&mut self, now: Instant) {
        let due = self
            .batches
            .iter()
            .filter(|(_, batch)| batch_due(batch, now))
            .map(|(project_id, _)| project_id.clone())
            .collect::<Vec<_>>();
        for project_id in due {
            self.flush(&project_id, now);
        }
    }

    fn flush_all_pending(&mut self, now: Instant) {
        let pending = self
            .batches
            .iter()
            .filter(|(_, batch)| batch.dirty)
            .map(|(project_id, _)| project_id.clone())
            .collect::<Vec<_>>();
        for project_id in pending {
            self.flush(&project_id, now);
        }
    }

    fn flush(&mut self, project_id: &str, now: Instant) {
        let Some(batch) = self.batches.get_mut(project_id) else {
            return;
        };
        if !batch.dirty {
            return;
        }
        let Some((kind, payload)) = flush_signal(batch) else {
            return;
        };
        let result = (self.sink)(kind, project_id, &payload);
        let batch = self
            .batches
            .get_mut(project_id)
            .expect("project batch present during flush");
        if result.is_ok() {
            if let Some(registration) = self.registrations.get(project_id) {
                registration.overflow.store(false, Ordering::Release);
            }
            batch.reset();
            if !batch.dirty {
                self.batches.remove(project_id);
            }
        } else {
            // Persistence failure retains the Project as full-dirty and retries
            // no faster than the next maximum-flush boundary.
            batch.full = true;
            batch.paths.clear();
            batch.has_git = false;
            batch.retry_after = Some(now + MAX_FLUSH_WINDOW);
        }
    }

    fn next_deadline(&self) -> Duration {
        let now = Instant::now();
        let mut soonest: Option<Duration> = None;
        for batch in self.batches.values() {
            if !batch.dirty {
                continue;
            }
            let due = if let Some(retry_after) = batch.retry_after {
                retry_after.saturating_duration_since(now)
            } else {
                let first = batch.first_seen.unwrap_or(now);
                let last = batch.last_seen.unwrap_or(now);
                let quiet = (last + QUIET_WINDOW).saturating_duration_since(now);
                let max = (first + MAX_FLUSH_WINDOW).saturating_duration_since(now);
                quiet.min(max)
            };
            soonest = Some(soonest.map_or(due, |current| current.min(due)));
        }
        for entry in self.retries.values() {
            if let Some(next) = entry.next_retry {
                let due = next.saturating_duration_since(now);
                soonest = Some(soonest.map_or(due, |current| current.min(due)));
            }
        }
        soonest
            .unwrap_or(OVERFLOW_POLL_INTERVAL)
            .min(OVERFLOW_POLL_INTERVAL)
    }
}

fn install_watch(
    root: &Path,
    callback: impl FnMut(notify::Result<Event>) + Send + 'static,
) -> notify::Result<RecommendedWatcher> {
    let mut watcher = recommended_watcher(callback)?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

fn make_callback(
    project_id: String,
    generation: u64,
    overflow: Arc<AtomicBool>,
    sender: SyncSender<WorkerCommand>,
) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    move |result| match result {
        Ok(event) => {
            let rescanned = event.need_rescan();
            let path_count = event.paths.len();
            if rescanned || path_count > MAX_CALLBACK_PATHS {
                overflow.store(true, Ordering::Release);
            }
            let signal = if rescanned {
                RawSignal::Full
            } else if path_count > MAX_CALLBACK_PATHS {
                RawSignal::Paths(event.paths.into_iter().take(MAX_CALLBACK_PATHS).collect())
            } else {
                RawSignal::Paths(event.paths)
            };
            let record = RawRecord {
                project_id: project_id.clone(),
                generation,
                signal,
                backend_error: false,
            };
            if sender.try_send(WorkerCommand::Event(record)).is_err() {
                overflow.store(true, Ordering::Release);
            }
        }
        Err(_) => {
            let record = RawRecord {
                project_id: project_id.clone(),
                generation,
                signal: RawSignal::Full,
                backend_error: true,
            };
            if sender.try_send(WorkerCommand::Event(record)).is_err() {
                overflow.store(true, Ordering::Release);
            }
        }
    }
}

fn backoff_delay(attempt: u32) -> Duration {
    let seconds = if attempt >= 7 {
        60
    } else {
        1u64 << attempt.saturating_sub(1)
    };
    Duration::from_secs(seconds)
}

fn insert_path(paths: &mut Vec<String>, candidate: String) {
    let covers = |ancestor: &str, descendant: &str| {
        descendant == ancestor
            || (descendant.starts_with(ancestor)
                && descendant.as_bytes().get(ancestor.len()) == Some(&b'/'))
    };
    paths.retain(|existing| !covers(&candidate, existing));
    if paths.iter().any(|existing| covers(existing, &candidate)) {
        return;
    }
    paths.push(candidate);
}

fn merge_full(batch: &mut ProjectBatch, now: Instant) {
    batch.full = true;
    batch.paths.clear();
    batch.has_git = false;
    batch.dirty = true;
    batch.touch(now);
}

fn batch_due(batch: &ProjectBatch, now: Instant) -> bool {
    if !batch.dirty {
        return false;
    }
    if let Some(retry_after) = batch.retry_after {
        return now >= retry_after;
    }
    let first = batch.first_seen.unwrap_or(now);
    let last = batch.last_seen.unwrap_or(now);
    (now - last) >= QUIET_WINDOW || (now - first) >= MAX_FLUSH_WINDOW
}

fn flush_signal(batch: &ProjectBatch) -> Option<(&'static str, Value)> {
    if batch.full {
        return Some(("file_changed", json!({"paths": [], "full": true})));
    }
    if !batch.paths.is_empty() {
        let mut paths = batch.paths.clone();
        paths.sort_unstable();
        paths.dedup();
        return Some(("file_changed", json!({"paths": paths})));
    }
    if batch.has_git {
        return Some(("git_changed", json!({})));
    }
    None
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use tempfile::tempdir;

    use super::*;

    fn test_sink() -> (Receiver<(String, String, Value)>, WorkspaceEventSink) {
        let (tx, rx) = mpsc::channel();
        let sink: WorkspaceEventSink = Arc::new(move |kind, project_id, payload| {
            tx.send((kind.to_owned(), project_id.to_owned(), payload.clone()))
                .expect("test sink channel");
            Ok(())
        });
        (rx, sink)
    }

    fn register_project_dir() -> (tempfile::TempDir, PathBuf) {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("project");
        fs::create_dir_all(&root).expect("project directory");
        (temp, root)
    }

    fn next_event(rx: &Receiver<(String, String, Value)>) -> (String, String, Value) {
        rx.recv_timeout(Duration::from_secs(2))
            .expect("watcher event")
    }

    #[test]
    fn coalesces_an_external_file_change_into_one_scoped_event() {
        let (_temp, root) = register_project_dir();
        let (rx, sink) = test_sink();
        let watcher = ProjectWatcher::start(sink);
        let project_id = "project-1".to_owned();
        watcher.register(project_id.clone(), root.clone());
        std::thread::sleep(Duration::from_millis(200));

        fs::write(root.join("notes.txt"), "hello\n").expect("external write");

        let (kind, emitted_for, payload) = next_event(&rx);
        assert_eq!(kind, "file_changed");
        assert_eq!(emitted_for, project_id);
        assert_eq!(payload, json!({"paths": ["notes.txt"]}));
        assert!(
            rx.recv_timeout(Duration::from_millis(500)).is_err(),
            "one write must coalesce into exactly one event"
        );
        watcher.shutdown();
    }

    #[test]
    fn publishes_git_metadata_as_git_only_invalidation() {
        let (_temp, root) = register_project_dir();
        fs::create_dir_all(root.join(".git")).expect("git directory");
        let (rx, sink) = test_sink();
        let watcher = ProjectWatcher::start(sink);
        let project_id = "project-git".to_owned();
        watcher.register(project_id.clone(), root.clone());
        std::thread::sleep(Duration::from_millis(200));

        fs::write(root.join(".git/config"), "[core]\n").expect("git config write");

        let (kind, emitted_for, payload) = next_event(&rx);
        assert_eq!(kind, "git_changed");
        assert_eq!(emitted_for, project_id);
        assert_eq!(payload, json!({}));
        watcher.shutdown();
    }

    #[test]
    fn unregistering_stops_watching_and_never_touches_files() {
        let (_temp, root) = register_project_dir();
        let (rx, sink) = test_sink();
        let watcher = ProjectWatcher::start(sink);
        let project_id = "project-unregister".to_owned();
        watcher.register(project_id.clone(), root.clone());
        std::thread::sleep(Duration::from_millis(200));

        fs::write(root.join("before.txt"), "x\n").expect("first write");
        next_event(&rx);

        watcher.unregister(project_id.clone());
        std::thread::sleep(Duration::from_millis(200));

        fs::write(root.join("after.txt"), "y\n").expect("second write");
        assert!(
            rx.recv_timeout(Duration::from_millis(600)).is_err(),
            "unregistered project must stop emitting events"
        );
        assert!(root.join("after.txt").exists(), "files are never removed");
        watcher.shutdown();
    }

    #[test]
    fn shutdown_joins_and_flushes_a_pending_batch() {
        let (_temp, root) = register_project_dir();
        let (rx, sink) = test_sink();
        let watcher = ProjectWatcher::start(sink);
        let project_id = "project-shutdown".to_owned();
        watcher.register(project_id.clone(), root.clone());
        std::thread::sleep(Duration::from_millis(200));

        fs::write(root.join("pending.txt"), "z\n").expect("pending write");
        std::thread::sleep(Duration::from_millis(100));
        watcher.shutdown();

        let (kind, emitted_for, payload) = next_event(&rx);
        assert_eq!(kind, "file_changed");
        assert_eq!(emitted_for, project_id);
        assert_eq!(payload, json!({"paths": ["pending.txt"]}));
    }

    #[test]
    fn the_257th_accumulated_path_merges_full() {
        let (_temp, root) = register_project_dir();
        let mut worker = Worker {
            receiver: mpsc::channel().1,
            callback_sender: mpsc::sync_channel(4).0,
            sink: test_sink().1,
            registrations: HashMap::new(),
            batches: HashMap::new(),
            retries: HashMap::new(),
            generations: HashMap::new(),
            removed: HashSet::new(),
        };
        let watcher = recommended_watcher(|_: notify::Result<Event>| {}).expect("watcher");
        worker.registrations.insert(
            "project-overflow".to_owned(),
            Registration {
                watcher,
                overflow: Arc::new(AtomicBool::new(false)),
                root,
            },
        );
        worker.generations.insert("project-overflow".to_owned(), 1);

        let paths = (0..257)
            .map(|index| PathBuf::from(format!("file-{index}.txt")))
            .collect();
        worker.ingest(RawRecord {
            project_id: "project-overflow".to_owned(),
            generation: 1,
            signal: RawSignal::Paths(paths),
            backend_error: false,
        });

        let batch = worker.batches.get("project-overflow").expect("batch");
        assert!(batch.full);
        assert!(batch.dirty);
        assert_eq!(
            flush_signal(batch),
            Some(("file_changed", json!({"paths": [], "full": true})))
        );
    }

    #[test]
    fn an_overflow_flag_forces_full_on_the_next_cycle() {
        let (_temp, root) = register_project_dir();
        let mut worker = Worker {
            receiver: mpsc::channel().1,
            callback_sender: mpsc::sync_channel(4).0,
            sink: test_sink().1,
            registrations: HashMap::new(),
            batches: HashMap::new(),
            retries: HashMap::new(),
            generations: HashMap::new(),
            removed: HashSet::new(),
        };
        let watcher = recommended_watcher(|_: notify::Result<Event>| {}).expect("watcher");
        let overflow = Arc::new(AtomicBool::new(false));
        worker.registrations.insert(
            "project-flag".to_owned(),
            Registration {
                watcher,
                overflow: Arc::clone(&overflow),
                root,
            },
        );
        worker.generations.insert("project-flag".to_owned(), 1);

        overflow.store(true, Ordering::Release);
        worker.poll_overflow(Instant::now());

        let batch = worker.batches.get("project-flag").expect("batch");
        assert!(batch.full);
    }

    #[test]
    fn late_callbacks_with_an_inactive_generation_are_ignored() {
        let (_temp, root) = register_project_dir();
        let mut worker = Worker {
            receiver: mpsc::channel().1,
            callback_sender: mpsc::sync_channel(4).0,
            sink: test_sink().1,
            registrations: HashMap::new(),
            batches: HashMap::new(),
            retries: HashMap::new(),
            generations: HashMap::new(),
            removed: HashSet::new(),
        };
        let watcher = recommended_watcher(|_: notify::Result<Event>| {}).expect("watcher");
        worker.registrations.insert(
            "project-gen".to_owned(),
            Registration {
                watcher,
                overflow: Arc::new(AtomicBool::new(false)),
                root,
            },
        );
        worker.generations.insert("project-gen".to_owned(), 2);

        worker.ingest(RawRecord {
            project_id: "project-gen".to_owned(),
            generation: 1,
            signal: RawSignal::Full,
            backend_error: false,
        });

        assert!(worker.batches.is_empty());
    }

    #[test]
    fn backend_errors_merge_full_and_mark_the_registration_unavailable() {
        let (_temp, root) = register_project_dir();
        let mut worker = Worker {
            receiver: mpsc::channel().1,
            callback_sender: mpsc::sync_channel(4).0,
            sink: test_sink().1,
            registrations: HashMap::new(),
            batches: HashMap::new(),
            retries: HashMap::new(),
            generations: HashMap::new(),
            removed: HashSet::new(),
        };
        let watcher = recommended_watcher(|_: notify::Result<Event>| {}).expect("watcher");
        worker.registrations.insert(
            "project-error".to_owned(),
            Registration {
                watcher,
                overflow: Arc::new(AtomicBool::new(false)),
                root,
            },
        );
        worker.generations.insert("project-error".to_owned(), 1);

        worker.ingest(RawRecord {
            project_id: "project-error".to_owned(),
            generation: 1,
            signal: RawSignal::Full,
            backend_error: true,
        });

        assert!(worker.registrations.is_empty());
        let batch = worker.batches.get("project-error").expect("batch");
        assert!(batch.full);
        assert!(worker.retries.contains_key("project-error"));
    }

    #[test]
    fn insert_path_deduplicates_and_collapses_descendants() {
        let mut paths = Vec::new();
        insert_path(&mut paths, "a/b/c.txt".to_owned());
        insert_path(&mut paths, "a/b/c.txt".to_owned());
        insert_path(&mut paths, "a/b/d.txt".to_owned());
        assert_eq!(paths, vec!["a/b/c.txt".to_owned(), "a/b/d.txt".to_owned()]);

        insert_path(&mut paths, "a".to_owned());
        assert_eq!(paths, vec!["a".to_owned()]);

        insert_path(&mut paths, "a/b/new.txt".to_owned());
        assert_eq!(paths, vec!["a".to_owned()]);

        insert_path(&mut paths, "z.txt".to_owned());
        assert_eq!(paths, vec!["a".to_owned(), "z.txt".to_owned()]);
    }

    #[test]
    fn flush_signal_emits_canonical_scoped_and_full_forms() {
        let mut batch = ProjectBatch::default();
        assert_eq!(flush_signal(&batch), None);

        batch.paths.push("b".to_owned());
        batch.paths.push("a".to_owned());
        batch.dirty = true;
        assert_eq!(
            flush_signal(&batch),
            Some(("file_changed", json!({"paths": ["a", "b"]})))
        );

        batch.has_git = true;
        assert_eq!(
            flush_signal(&batch),
            Some(("file_changed", json!({"paths": ["a", "b"]})))
        );

        let git_only = ProjectBatch {
            has_git: true,
            dirty: true,
            ..Default::default()
        };
        assert_eq!(flush_signal(&git_only), Some(("git_changed", json!({}))));

        let full = ProjectBatch {
            full: true,
            dirty: true,
            ..Default::default()
        };
        assert_eq!(
            flush_signal(&full),
            Some(("file_changed", json!({"paths": [], "full": true})))
        );
    }

    #[test]
    fn retry_backoff_sequences_through_60_seconds() {
        assert_eq!(backoff_delay(1), Duration::from_secs(1));
        assert_eq!(backoff_delay(2), Duration::from_secs(2));
        assert_eq!(backoff_delay(4), Duration::from_secs(8));
        assert_eq!(backoff_delay(6), Duration::from_secs(32));
        assert_eq!(backoff_delay(7), Duration::from_secs(60));
        assert_eq!(backoff_delay(20), Duration::from_secs(60));
    }
}
