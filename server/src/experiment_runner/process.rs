//! Linux process facts for experiments (ADR 0213 section 6): identity that
//! survives a Runtime restart, group signalling, and the wrapper script that
//! writes an exit receipt. A pid alone is never trusted: it can be reused.

use std::path::Path;

use crate::experiment_store::ProcessIdentity;

/// Runs the user's argv (`"$@"`) with output redirected to files and an
/// atomically written exit receipt, so the outcome survives a Runtime restart.
/// `ulimit -f` bounds each log file in the kernel; the wrapper leads its own
/// process group so the whole tree can be signalled.
pub const WRAPPER: &str = r#"printf '%s' "$$" > "$KUBECODE_EXPERIMENT_DIR/pid"
ulimit -f "$KUBECODE_EXPERIMENT_FILE_BLOCKS" 2>/dev/null
"$@" >"$KUBECODE_EXPERIMENT_DIR/stdout.log" 2>"$KUBECODE_EXPERIMENT_DIR/stderr.log"
code=$?
printf '%s' "$code" > "$KUBECODE_EXPERIMENT_DIR/exit.tmp" && mv "$KUBECODE_EXPERIMENT_DIR/exit.tmp" "$KUBECODE_EXPERIMENT_DIR/exit"
"#;

pub fn boot_id() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map(|value| value.trim().to_owned())
        .unwrap_or_default()
}

fn clock_ticks() -> f64 {
    // SAFETY: sysconf has no preconditions.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks > 0 { ticks as f64 } else { 100.0 }
}

/// `(state, start time in clock ticks since boot)` from `/proc/<pid>/stat`.
/// The command name may contain spaces and parentheses, so fields are read
/// after the last closing parenthesis.
fn stat_of(pid: i64) -> Option<(char, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // After the name: state is field 3, start time is field 22.
    let state = fields.first()?.chars().next()?;
    let start = fields.get(19)?.parse().ok()?;
    Some((state, start))
}

pub fn identity(pid: i64) -> Option<ProcessIdentity> {
    let (_, start_ticks) = stat_of(pid)?;
    Some(ProcessIdentity {
        pid,
        start_ticks,
        boot_id: boot_id(),
    })
}

/// Whether this exact process (same start time, same boot) is still running.
/// A zombie counts as gone: its work is over.
pub fn is_alive(identity: &ProcessIdentity) -> bool {
    if identity.boot_id != boot_id() {
        return false;
    }
    matches!(
        stat_of(identity.pid),
        Some((state, start)) if start == identity.start_ticks && state != 'Z' && state != 'X'
    )
}

/// Seconds the process has been running, from its recorded start time.
pub fn elapsed_secs(identity: &ProcessIdentity) -> Option<u64> {
    let uptime: f64 = std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    let started = identity.start_ticks as f64 / clock_ticks();
    Some((uptime - started).max(0.0) as u64)
}

/// Signals the process group the wrapper leads. Refuses unless the identity
/// still matches, so a reused pid is never signalled.
pub fn signal_group(identity: &ProcessIdentity, signal: i32) -> bool {
    if !is_alive(identity) {
        return false;
    }
    // SAFETY: a negative pid addresses the process group; the identity check
    // above established that the leader is the process we launched.
    unsafe { libc::kill(-(identity.pid as libc::pid_t), signal) == 0 }
}

pub fn read_receipt(dir: &Path) -> Option<i32> {
    std::fs::read_to_string(dir.join("exit"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

pub const SIGTERM: i32 = libc::SIGTERM;
pub const SIGKILL: i32 = libc::SIGKILL;
