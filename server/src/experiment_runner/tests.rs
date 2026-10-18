//! Deterministic short local processes exercising the runner: success,
//! failure, large output, timeout, cancellation of a whole process tree,
//! duplicate and concurrent admission, and recovery at each launch boundary.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::experiment_store::testing::{Fixture, launch};
use crate::experiment_store::{AnalysisState, EnvelopeLimits, LaunchDenial};

fn shell_limits() -> EnvelopeLimits {
    EnvelopeLimits {
        max_launches: 12,
        max_concurrent: 2,
        deadline_at: None,
        max_runtime_secs: 30,
        max_no_progress: 5,
        allowed_commands: vec![vec!["sh".into(), "-c".into()]],
    }
}

struct Rig {
    f: Fixture,
    runner: Arc<ExperimentRunner>,
    root: PathBuf,
}

impl Rig {
    fn new() -> Self {
        let f = Fixture::new();
        f.experiments
            .set_envelope(
                &f.project_id,
                &f.research_id,
                &f.round_id,
                Some(1),
                shell_limits(),
                None,
            )
            .expect("envelope");
        let runner = ExperimentRunner::new(
            Arc::clone(&f.experiments),
            Arc::clone(&f.workspace),
            Arc::clone(&f.teams),
        )
        .with_poll(Duration::from_millis(20));
        let root = f
            .workspace
            .execution_path(&f.project_id, None)
            .expect("root");
        Self { f, runner, root }
    }

    fn request(&self, key: &str, script: &str) -> NewLaunch {
        launch(&self.f.round_id, &self.f.team, key, &["sh", "-c", script])
    }

    fn launch(&self, key: &str, script: &str) -> Result<Experiment, RunnerError> {
        self.runner.launch(
            &self.f.project_id,
            &self.f.research_id,
            self.request(key, script),
        )
    }

    async fn settle(&self, id: &str) -> Experiment {
        for _ in 0..400 {
            let experiment = self.f.experiments.get(id).expect("experiment");
            if !experiment.state.is_active() || experiment.state == ExperimentState::Unknown {
                return experiment;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!(
            "experiment {id} did not settle: {:?}",
            self.f.experiments.get(id)
        );
    }

    fn log(&self, id: &str, stream: LogStream) -> LogTail {
        self.runner
            .read_log(&self.f.project_id, id, stream, MAX_LOG_TAIL_BYTES)
            .expect("log")
    }
}

#[tokio::test]
async fn a_process_runs_to_completion_with_logs_and_artifact_revisions() {
    let rig = Rig::new();
    let mut request = rig.request("ok", "echo hello; echo oops >&2; echo data > out.txt");
    request.artifacts = vec!["out.txt".into(), "missing.txt".into()];
    let started = rig
        .runner
        .launch(&rig.f.project_id, &rig.f.research_id, request)
        .unwrap();
    assert_eq!(started.state, ExperimentState::Running);
    assert!(
        started.identity.is_some(),
        "the process identity is recorded"
    );

    let done = rig.settle(&started.id).await;
    assert_eq!(
        (done.state, done.exit_code, done.analysis),
        (ExperimentState::Exited, Some(0), AnalysisState::Pending)
    );
    assert_eq!(rig.log(&done.id, LogStream::Stdout).text, "hello\n");
    assert_eq!(rig.log(&done.id, LogStream::Stderr).text, "oops\n");
    let revisions: Vec<_> = done
        .artifact_revisions
        .iter()
        .map(|a| (a.path.as_str(), a.revision.is_some()))
        .collect();
    assert_eq!(revisions, vec![("out.txt", true), ("missing.txt", false)]);
    assert!(
        rig.root.join("out.txt").exists(),
        "the process ran in the execution root"
    );
}

#[tokio::test]
async fn failures_are_observations_not_verdicts() {
    let rig = Rig::new();
    let failed = rig.launch("fail", "echo before; exit 3").unwrap();
    let done = rig.settle(&failed.id).await;
    assert_eq!(
        (done.state, done.exit_code),
        (ExperimentState::Exited, Some(3))
    );

    let missing = rig
        .launch("missing", "definitely_not_a_command_xyz")
        .unwrap();
    let done = rig.settle(&missing.id).await;
    assert_eq!(done.state, ExperimentState::FailedToStart);
    assert_eq!(done.exit_code, Some(127));
    assert!(
        rig.log(&done.id, LogStream::Stderr)
            .text
            .contains("not found")
    );
}

#[tokio::test]
async fn runaway_output_is_bounded_on_disk_and_never_breaks_the_program() {
    let rig = Rig::new();
    // `yes` would write forever; the log is capped but the program is not
    // killed by the cap, and its own files are not limited.
    let noisy = rig.launch("noisy", "yes").unwrap();
    let path = rig
        .f
        .workspace
        .experiment_dir(&noisy.id)
        .unwrap()
        .join("stdout.log");
    let cap = 16 * 1024 * 1024;
    for _ in 0..400 {
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) >= cap {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        cap,
        "the log fills to its cap"
    );
    assert_eq!(
        rig.f.experiments.get(&noisy.id).unwrap().state,
        ExperimentState::Running,
        "hitting the cap does not kill the program"
    );
    let tail = rig.log(&noisy.id, LogStream::Stdout);
    assert!(tail.text.len() as u64 <= MAX_LOG_TAIL_BYTES);
    assert!(tail.truncated);
    rig.runner.cancel(&rig.f.project_id, &noisy.id).unwrap();
    let done = tokio::time::timeout(Duration::from_secs(15), rig.settle(&noisy.id))
        .await
        .unwrap();
    assert_eq!(done.state, ExperimentState::Cancelled);
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        cap,
        "never grows past the cap"
    );
}

#[tokio::test]
async fn a_program_may_write_files_larger_than_the_log_cap() {
    let rig = Rig::new();
    let big = rig
        .launch("big", "head -c 20000000 /dev/zero > big.bin")
        .unwrap();
    let done = rig.settle(&big.id).await;
    assert_eq!(
        (done.state, done.exit_code),
        (ExperimentState::Exited, Some(0))
    );
    assert_eq!(
        std::fs::metadata(rig.root.join("big.bin")).unwrap().len(),
        20_000_000
    );
}

#[tokio::test]
async fn a_program_that_ignores_sigterm_keeps_its_slot_until_it_is_killed() {
    let rig = Rig::new();
    // The wrapper dies on SIGTERM; the program traps it and carries on.
    let stubborn = rig
        .launch("stubborn", "trap '' TERM; echo ready > ready.txt; sleep 30")
        .unwrap();
    for _ in 0..200 {
        if rig.root.join("ready.txt").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let identity = stubborn.identity.clone().unwrap();
    rig.runner.cancel(&rig.f.project_id, &stubborn.id).unwrap();
    // After the wrapper is gone but before the escalation, work may still run,
    // so the slot is not released and nothing is recorded as finished.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(
        process::group_alive(&identity),
        "the program survived SIGTERM"
    );
    assert_eq!(
        rig.f.experiments.get(&stubborn.id).unwrap().state,
        ExperimentState::Cancelling
    );
    let done = tokio::time::timeout(Duration::from_secs(15), rig.settle(&stubborn.id))
        .await
        .unwrap();
    assert_eq!(done.state, ExperimentState::Cancelled);
    assert!(
        !process::group_alive(&identity),
        "the escalation killed the whole group"
    );
}

#[tokio::test]
async fn a_process_over_its_runtime_cap_is_stopped_and_marked_timed_out() {
    let rig = Rig::new();
    let mut request = rig.request("slow", "sleep 30");
    request.max_runtime_secs = Some(1);
    let started = rig
        .runner
        .launch(&rig.f.project_id, &rig.f.research_id, request)
        .unwrap();
    let done = tokio::time::timeout(Duration::from_secs(15), rig.settle(&started.id))
        .await
        .expect("timed out in time");
    assert_eq!(done.state, ExperimentState::TimedOut);
    assert!(!process::is_alive(started.identity.as_ref().unwrap()));
}

#[tokio::test]
async fn cancelling_stops_the_whole_process_tree() {
    let rig = Rig::new();
    let started = rig
        .launch("tree", "sleep 60 & echo $! > child.pid; wait")
        .unwrap();
    // Wait until the grandchild exists.
    let child_pid_file = rig.root.join("child.pid");
    for _ in 0..200 {
        if child_pid_file.exists()
            && std::fs::read_to_string(&child_pid_file)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let child: i64 = std::fs::read_to_string(&child_pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(std::path::Path::new(&format!("/proc/{child}")).exists());

    let cancelling = rig.runner.cancel(&rig.f.project_id, &started.id).unwrap();
    assert_eq!(cancelling.state, ExperimentState::Cancelling);
    let done = tokio::time::timeout(Duration::from_secs(15), rig.settle(&started.id))
        .await
        .expect("cancelled");
    assert_eq!(done.state, ExperimentState::Cancelled);
    for _ in 0..100 {
        if !std::path::Path::new(&format!("/proc/{child}")).exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // A killed grandchild may linger briefly as a zombie of init; it must not run.
    let stat = std::fs::read_to_string(format!("/proc/{child}/stat")).unwrap_or_default();
    assert!(
        stat.is_empty() || stat.contains(") Z "),
        "the child survived: {stat}"
    );
}

#[tokio::test]
async fn a_duplicate_launch_key_never_starts_a_second_process() {
    let rig = Rig::new();
    let first = rig
        .launch("once", "echo run >> count.txt; sleep 0.3")
        .unwrap();
    let second = rig
        .launch("once", "echo run >> count.txt; sleep 0.3")
        .unwrap();
    assert_eq!(first.id, second.id);
    rig.settle(&first.id).await;
    // Even after it finished, the key still answers with the same attempt.
    let third = rig
        .launch("once", "echo run >> count.txt; sleep 0.3")
        .unwrap();
    assert_eq!(third.id, first.id);
    assert_eq!(
        std::fs::read_to_string(rig.root.join("count.txt"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_admission_respects_the_limits_and_the_budget() {
    let rig = Arc::new(Rig::new());
    let handles: Vec<_> = (0..6)
        .map(|index| {
            let rig = Arc::clone(&rig);
            tokio::spawn(async move { rig.launch(&format!("c{index}"), "sleep 0.5").is_ok() })
        })
        .collect();
    let mut admitted = 0;
    for handle in handles {
        if handle.await.unwrap() {
            admitted += 1;
        }
    }
    assert_eq!(admitted, 2, "max_concurrent is 2");
    let envelope = rig
        .f
        .experiments
        .envelope(&rig.f.project_id, &rig.f.research_id, &rig.f.round_id)
        .unwrap()
        .unwrap();
    assert_eq!(envelope.launches_reserved, 2);
}

#[tokio::test]
async fn an_unsafe_working_directory_is_refused_before_any_reservation() {
    let rig = Rig::new();
    for cwd in ["../escape", "/etc", "a/../../b"] {
        let mut request = rig.request("cwd", "echo x");
        request.cwd = cwd.into();
        assert!(
            matches!(
                rig.runner
                    .launch(&rig.f.project_id, &rig.f.research_id, request),
                Err(RunnerError::Workspace(_))
            ),
            "{cwd}"
        );
    }
    let envelope = rig
        .f
        .experiments
        .envelope(&rig.f.project_id, &rig.f.research_id, &rig.f.round_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        envelope.launches_reserved, 0,
        "a rejected path consumes no budget"
    );
    std::fs::create_dir_all(rig.root.join("sub")).unwrap();
    let mut inside = rig.request("sub", "pwd > where.txt");
    inside.cwd = "sub".into();
    let started = rig
        .runner
        .launch(&rig.f.project_id, &rig.f.research_id, inside)
        .unwrap();
    rig.settle(&started.id).await;
    assert!(rig.root.join("sub/where.txt").exists());
}

#[tokio::test]
async fn denied_launches_do_not_spawn_anything() {
    let rig = Rig::new();
    let outcome = rig.runner.launch(
        &rig.f.project_id,
        &rig.f.research_id,
        launch(&rig.f.round_id, &rig.f.team, "bad", &["touch", "pwned.txt"]),
    );
    assert!(matches!(
        outcome,
        Err(RunnerError::Experiment(ExperimentError::Denied(
            LaunchDenial::CommandNotAuthorized
        )))
    ));
    assert!(!rig.root.join("pwned.txt").exists());
}

// -- Recovery ---------------------------------------------------------------

fn restarted(rig: &Rig) -> Arc<ExperimentRunner> {
    ExperimentRunner::new(
        Arc::clone(&rig.f.experiments),
        Arc::clone(&rig.f.workspace),
        Arc::clone(&rig.f.teams),
    )
    .with_poll(Duration::from_millis(20))
}

#[tokio::test]
async fn recovery_closes_a_reservation_that_never_spawned_and_gives_the_launch_back() {
    let rig = Rig::new();
    let (reserved, _) = rig
        .f
        .reserve("r", &["sh", "-c", "touch should-not-run.txt"])
        .unwrap();
    restarted(&rig).recover().unwrap();
    let closed = rig.f.experiments.get(&reserved.id).unwrap();
    assert_eq!(closed.state, ExperimentState::FailedToStart);
    assert!(
        !rig.root.join("should-not-run.txt").exists(),
        "recovery never launches"
    );
    let envelope = rig
        .f
        .experiments
        .envelope(&rig.f.project_id, &rig.f.research_id, &rig.f.round_id)
        .unwrap()
        .unwrap();
    assert_eq!(envelope.launches_reserved, 0);
}

#[tokio::test]
async fn a_launch_interrupted_at_the_spawn_boundary_is_unknown_and_keeps_its_slot() {
    let rig = Rig::new();
    let (reserved, _) = rig
        .f
        .reserve("l", &["sh", "-c", "touch should-not-run.txt"])
        .unwrap();
    rig.f.experiments.mark_launching(&reserved.id).unwrap();
    restarted(&rig).recover().unwrap();
    let unknown = rig.f.experiments.get(&reserved.id).unwrap();
    assert_eq!(unknown.state, ExperimentState::Unknown);
    assert!(
        !rig.root.join("should-not-run.txt").exists(),
        "an ambiguous launch is never resubmitted"
    );
    // The slot stays held, so another launch fits only up to the limit.
    assert!(rig.launch("next", "sleep 0.2").is_ok());
    assert!(matches!(
        rig.launch("over", "sleep 0.2"),
        Err(RunnerError::Experiment(ExperimentError::Denied(
            LaunchDenial::ConcurrencyLimit
        )))
    ));
}

#[tokio::test]
async fn a_finished_process_is_read_from_its_receipt_after_a_restart() {
    let rig = Rig::new();
    let (reserved, _) = rig.f.reserve("receipt", &["sh", "-c", "true"]).unwrap();
    rig.f.experiments.mark_launching(&reserved.id).unwrap();
    let dir = rig.f.workspace.experiment_dir(&reserved.id).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("exit"), "0").unwrap();
    restarted(&rig).recover().unwrap();
    let done = rig.f.experiments.get(&reserved.id).unwrap();
    assert_eq!(
        (done.state, done.exit_code),
        (ExperimentState::Exited, Some(0))
    );
}

#[tokio::test]
async fn a_running_process_is_adopted_after_a_restart_and_observed_once() {
    let rig = Rig::new();
    let started = rig
        .launch("adopt", "sleep 1; echo finished > adopted.txt")
        .unwrap();
    // The first Runtime stops watching (it is gone); the process keeps running.
    rig.runner.abandon_monitors();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        rig.f.experiments.get(&started.id).unwrap().state,
        ExperimentState::Running
    );

    // Only the successor can now observe it.
    restarted(&rig).recover().unwrap();
    let done = tokio::time::timeout(Duration::from_secs(15), rig.settle(&started.id))
        .await
        .unwrap();
    assert_eq!(
        (done.state, done.exit_code),
        (ExperimentState::Exited, Some(0))
    );
    assert!(rig.root.join("adopted.txt").exists());
    assert_eq!(
        done.analysis,
        AnalysisState::Pending,
        "one observation, one obligation"
    );
}

#[tokio::test]
async fn a_launch_that_died_before_its_identity_was_recorded_is_adopted_from_its_pid_file() {
    let rig = Rig::new();
    let started = rig.launch("unrecorded", "sleep 30").unwrap();
    let identity = started.identity.clone().unwrap();
    rig.runner.abandon_monitors();
    // Simulate the Runtime dying before `mark_running`: the row is only `launching`.
    rig.f
        .experiments
        .force_state_for_test(&started.id, "launching");
    restarted(&rig).recover().unwrap();
    let adopted = rig.f.experiments.get(&started.id).unwrap();
    assert_eq!(adopted.state, ExperimentState::Running);
    assert_eq!(adopted.identity.as_ref().map(|i| i.pid), Some(identity.pid));
    // And it is supervised again: cancelling stops it.
    let successor = restarted(&rig);
    successor.recover().unwrap();
    successor.cancel(&rig.f.project_id, &started.id).unwrap();
    let done = tokio::time::timeout(Duration::from_secs(15), rig.settle(&started.id))
        .await
        .unwrap();
    assert_eq!(done.state, ExperimentState::Cancelled);
}

#[tokio::test]
async fn a_cancel_requested_during_launch_is_not_stuck_after_a_restart() {
    let rig = Rig::new();
    let (reserved, _) = rig.f.reserve("cl", &["sh", "-c", "true"]).unwrap();
    rig.f.experiments.mark_launching(&reserved.id).unwrap();
    rig.f.experiments.request_cancel(&reserved.id).unwrap();
    assert_eq!(
        rig.f.experiments.get(&reserved.id).unwrap().state,
        ExperimentState::Cancelling
    );
    restarted(&rig).recover().unwrap();
    // Without an identity the fate is ambiguous: visible and reconcilable,
    // never a slot that leaks forever.
    let after = rig.f.experiments.get(&reserved.id).unwrap();
    assert_eq!(after.state, ExperimentState::Unknown);
    rig.f
        .experiments
        .reconcile(
            &rig.f.project_id,
            &reserved.id,
            crate::experiment_store::ReconcileTruth::NotStarted,
            None,
            "test",
        )
        .unwrap();
}

#[tokio::test]
async fn a_lost_process_that_outlived_its_cap_is_unknown_not_timed_out() {
    let rig = Rig::new();
    let mut request = rig.request("old", "sleep 30");
    request.max_runtime_secs = Some(1);
    let started = rig
        .runner
        .launch(&rig.f.project_id, &rig.f.research_id, request)
        .unwrap();
    // Cap the runtime so the monitor would time it out: replace the monitor
    // with a successor that finds the process already gone, with no receipt.
    rig.runner.abandon_monitors();
    let identity = started.identity.clone().unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(process::signal_whole_group(&identity, process::SIGKILL));
    tokio::time::sleep(Duration::from_millis(100)).await;
    restarted(&rig).recover().unwrap();
    let lost = tokio::time::timeout(Duration::from_secs(10), rig.settle(&started.id))
        .await
        .unwrap();
    assert_eq!(
        lost.state,
        ExperimentState::Unknown,
        "elapsed time alone proves nothing about how it ended"
    );
}

#[test]
fn artifact_revisions_resolve_under_the_execution_root_and_large_files_are_not_missing() {
    let rig = Rig::new();
    std::fs::write(rig.root.join("small.txt"), "x").unwrap();
    let small = rig
        .f
        .workspace
        .execution_file_revision(&rig.f.project_id, None, "small.txt")
        .unwrap();
    assert!(!small.starts_with("large:"));
    let big = rig.root.join("big.bin");
    let file = std::fs::File::create(&big).unwrap();
    file.set_len(9 * 1024 * 1024).unwrap();
    let revision = rig
        .f
        .workspace
        .execution_file_revision(&rig.f.project_id, None, "big.bin")
        .unwrap();
    assert!(revision.starts_with("large:"), "{revision}");
    assert!(
        rig.f
            .workspace
            .execution_file_revision(&rig.f.project_id, None, "../escape")
            .is_err()
    );
    assert!(
        rig.f
            .workspace
            .execution_file_revision(&rig.f.project_id, None, "nope.txt")
            .is_err()
    );
}

#[tokio::test]
async fn a_lost_process_with_no_receipt_becomes_unknown_never_success() {
    let rig = Rig::new();
    let started = rig.launch("lost", "sleep 30").unwrap();
    let identity = started.identity.clone().unwrap();
    // Simulate the process group dying without the wrapper's receipt.
    assert!(process::signal_group(&identity, process::SIGKILL));
    let lost = tokio::time::timeout(Duration::from_secs(10), rig.settle(&started.id))
        .await
        .unwrap();
    assert_eq!(lost.state, ExperimentState::Unknown);
    assert!(lost.reason.unwrap().contains("receipt"));
}
