//! Linux process facts for experiments (ADR 0213 section 6): identity that
//! survives a Runtime restart, group signalling, and the wrapper script that
//! writes an exit receipt. A pid alone is never trusted: it can be reused.

use std::path::Path;

use crate::experiment_store::ProcessIdentity;

/// Runs the user's argv (`"$@"`) with stdout and stderr copied into
/// Runtime-owned files, each bounded by `head -c` (the rest is drained so the
/// program never sees a broken pipe), and an exit code recorded in an
/// atomically renamed receipt. The cap applies to the log files only: the
/// program itself may write whatever it needs elsewhere. The wrapper leads a
/// new process group so the whole tree can be signalled.
pub const WRAPPER: &str = r#"printf '%s' "$$" > "$KUBECODE_EXPERIMENT_DIR/pid"
bound() { head -c "$KUBECODE_EXPERIMENT_LOG_LIMIT" > "$1"; cat > /dev/null; }
{ { "$@"; printf '%s' "$?" > "$KUBECODE_EXPERIMENT_DIR/code"; } 2>&1 1>&3 3>&- | bound "$KUBECODE_EXPERIMENT_DIR/stderr.log"; } 3>&1 | bound "$KUBECODE_EXPERIMENT_DIR/stdout.log"
mv "$KUBECODE_EXPERIMENT_DIR/code" "$KUBECODE_EXPERIMENT_DIR/exit" 2>/dev/null
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

/// Whether any process of the experiment's group is still running. The
/// wrapper leads the group and dies on the first SIGTERM, but the program may
/// have trapped it and carry on; the slot is held until the group is empty.
/// A group id cannot be reused while it has members.
pub fn group_alive(identity: &ProcessIdentity) -> bool {
    if identity.boot_id != boot_id() {
        return false;
    }
    // SAFETY: signal 0 only checks that the group exists.
    let result = unsafe { libc::kill(-(identity.pid as libc::pid_t), 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Signals every member of the group, whether or not the leader still lives.
pub fn signal_whole_group(identity: &ProcessIdentity, signal: i32) -> bool {
    if !group_alive(identity) {
        return false;
    }
    // SAFETY: as in `signal_group`; liveness of the group was just checked.
    unsafe { libc::kill(-(identity.pid as libc::pid_t), signal) == 0 }
}

/// When the process started, in unix seconds, from the boot time and its
/// start ticks.
pub fn start_unix(identity: &ProcessIdentity) -> Option<i64> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let btime: i64 = stat
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()?;
    Some(btime + (identity.start_ticks as f64 / clock_ticks()) as i64)
}

pub fn read_pid_file(dir: &Path) -> Option<(i64, std::time::SystemTime)> {
    let path = dir.join("pid");
    let pid = std::fs::read_to_string(&path).ok()?.trim().parse().ok()?;
    Some((pid, std::fs::metadata(&path).ok()?.modified().ok()?))
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
