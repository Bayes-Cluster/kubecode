//! Durable research experiments (ADR 0213): the execution envelope a
//! researcher approves, the launch attempts admitted under it, the waits
//! members register while a process runs, and the observations that resolve
//! them. The store shares the Runtime's single SQLite owner and commits its
//! `research_updated` workspace event in the same transaction as each change.
//!
//! Nothing here spawns a process or wakes an Agent: the runner and the Team
//! delivery path consume these records. A record is authoritative; a
//! notification is only a hint.

mod models;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;

pub use models::*;

use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::agent_store::AgentStore;
use crate::database::Database;

/// The longest a wait may run past now (seven days).
const MAX_WAIT_SECS: i64 = 7 * 24 * 3600;

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

type WakeHook = Arc<dyn Fn(&str) + Send + Sync>;

pub struct ExperimentStore {
    database: Arc<Database>,
    agents: Arc<AgentStore>,
    clock: Clock,
    /// Teams with a delivery committed in the current write; woken after
    /// commit. A hint only: the committed message is authoritative.
    wakes: Mutex<Vec<String>>,
    hook: Mutex<Option<WakeHook>>,
}

/// Creates the execution tables. `TeamStore` calls this too: completing a
/// Team and recording a missing report consult them in the Team's own
/// transactions, so they must exist wherever those can run.
pub(crate) fn ensure_schema(connection: &Connection) -> rusqlite::Result<()> {
    crate::research_store::ensure_schema(connection)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS research_envelopes (
           round_id          TEXT PRIMARY KEY REFERENCES research_rounds(id) ON DELETE CASCADE,
           research_id       TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
           revision          INTEGER NOT NULL,
           state             TEXT NOT NULL DEFAULT 'active',
           limits_json       TEXT NOT NULL,
           launches_reserved INTEGER NOT NULL DEFAULT 0,
           created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         -- Immutable: a running attempt cites the revision it was admitted under.
         CREATE TABLE IF NOT EXISTS research_envelope_revisions (
           round_id    TEXT NOT NULL REFERENCES research_rounds(id) ON DELETE CASCADE,
           revision    INTEGER NOT NULL,
           limits_json TEXT NOT NULL,
           actor       TEXT,
           created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           PRIMARY KEY (round_id, revision)
         );
         CREATE TABLE IF NOT EXISTS experiments (
           id               TEXT PRIMARY KEY,
           project_id       TEXT NOT NULL,
           research_id      TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
           round_id         TEXT NOT NULL REFERENCES research_rounds(id) ON DELETE CASCADE,
           team_id          TEXT REFERENCES teams(id) ON DELETE CASCADE,
           task_id          TEXT,
           owner_member_id  TEXT,
           launch_key       TEXT NOT NULL,
           request_hash     TEXT NOT NULL,
           label            TEXT NOT NULL DEFAULT '',
           argv_json        TEXT NOT NULL,
           cwd              TEXT NOT NULL DEFAULT '',
           artifacts_json   TEXT NOT NULL DEFAULT '[]',
           sources_json     TEXT NOT NULL DEFAULT '[]',
           policy_revision  INTEGER NOT NULL,
           max_runtime_secs INTEGER NOT NULL,
           state            TEXT NOT NULL DEFAULT 'reserved',
           analysis         TEXT NOT NULL DEFAULT 'none',
           pid              INTEGER,
           start_ticks      INTEGER,
           boot_id          TEXT,
           exit_code        INTEGER,
           signal           INTEGER,
           reason           TEXT,
           cancel_requested INTEGER NOT NULL DEFAULT 0,
           created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           launched_at      TEXT,
           finished_at      TEXT,
           UNIQUE (round_id, launch_key)
         );
         CREATE INDEX IF NOT EXISTS experiments_state ON experiments(state);
         CREATE INDEX IF NOT EXISTS experiments_team ON experiments(team_id);
         CREATE TABLE IF NOT EXISTS experiment_waits (
           id                 TEXT PRIMARY KEY,
           experiment_id      TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
           team_id            TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
           task_id            TEXT,
           attempt_id         TEXT,
           owner_member_id    TEXT NOT NULL,
           expected_follow_up TEXT NOT NULL DEFAULT '',
           deadline_at        INTEGER,
           state              TEXT NOT NULL DEFAULT 'open',
           created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           resolved_at        TEXT
         );
         CREATE INDEX IF NOT EXISTS experiment_waits_open ON experiment_waits(state, team_id);
         -- Committed observations: the trigger for delivery. One of each kind
         -- per experiment, so a duplicate observation converges.
         CREATE TABLE IF NOT EXISTS experiment_events (
           id            TEXT PRIMARY KEY,
           experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
           kind          TEXT NOT NULL,
           created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           UNIQUE (experiment_id, kind)
         );",
    )?;
    crate::database::ensure_column(
        connection,
        "experiments",
        "artifact_revisions_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    // Delivery: the mailbox row an event produced, and how often an
    // unanalyzed result has been re-raised.
    crate::database::ensure_column(connection, "experiment_events", "message_id", "TEXT")?;
    crate::database::ensure_column(
        connection,
        "experiments",
        "reminders",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    crate::database::ensure_column(connection, "experiments", "reminded_at", "INTEGER")?;
    // A launch given back (never started) is not a failed attempt.
    crate::database::ensure_column(
        connection,
        "experiments",
        "refunded",
        "INTEGER NOT NULL DEFAULT 0",
    )
}

const EXPERIMENT_SELECT: &str = "SELECT id, project_id, research_id, round_id, team_id, task_id,
        owner_member_id, launch_key, label, argv_json, cwd, artifacts_json, sources_json,
        policy_revision, max_runtime_secs, state, analysis, pid, start_ticks, boot_id,
        exit_code, signal, reason, cancel_requested, created_at, launched_at, finished_at,
        artifact_revisions_json
    FROM experiments";

const WAIT_SELECT: &str = "SELECT id, experiment_id, team_id, task_id, attempt_id, owner_member_id,
        expected_follow_up, deadline_at, state, created_at, resolved_at
    FROM experiment_waits";

impl ExperimentStore {
    pub fn from_database(
        database: Arc<Database>,
        agents: Arc<AgentStore>,
    ) -> Result<Self, ExperimentError> {
        {
            let connection = database.lock().expect("experiment database mutex poisoned");
            ensure_schema(&connection)?;
        }
        Ok(Self {
            database,
            agents,
            clock: Arc::new(system_now),
            wakes: Mutex::default(),
            hook: Mutex::default(),
        })
    }

    /// Registers what happens after a delivery commits (normally: wake the
    /// recipient through the Team runtime). Called with the Team id.
    pub fn set_delivery_hook(&self, hook: impl Fn(&str) + Send + Sync + 'static) {
        *self.hook.lock().expect("hook mutex poisoned") = Some(Arc::new(hook));
    }

    /// Replaces the clock (unix seconds), so deadlines are testable without
    /// sleeping.
    pub fn with_clock(mut self, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        self.clock = Arc::new(clock);
        self
    }

    pub fn now(&self) -> i64 {
        (self.clock)()
    }

    // -- Envelope ---------------------------------------------------------

    /// Creates the round's envelope (revision 1) or revises it. A revision
    /// supplies the revision the researcher saw; a stale one is a conflict
    /// that changes nothing. Running attempts keep the revision they were
    /// admitted under.
    pub fn set_envelope(
        &self,
        project_id: &str,
        research_id: &str,
        round_id: &str,
        expected_revision: Option<u64>,
        limits: EnvelopeLimits,
        actor: Option<&str>,
    ) -> Result<Envelope, ExperimentError> {
        let limits = limits.normalized()?;
        self.write(|tx| {
            require_round(tx, project_id, research_id, round_id)?;
            let limits_json = serde_json::to_string(&limits)?;
            let current = load_envelope(tx, round_id)?;
            let revision = match (&current, expected_revision) {
                (None, None | Some(0)) => 1,
                (None, Some(_)) => return Err(ExperimentError::EnvelopeConflict { current: 0 }),
                (Some(envelope), Some(expected)) if envelope.revision == expected => {
                    if envelope.limits == limits {
                        return Ok((envelope.clone(), None));
                    }
                    envelope.revision + 1
                }
                (Some(envelope), _) => {
                    return Err(ExperimentError::EnvelopeConflict {
                        current: envelope.revision,
                    });
                }
            };
            if current.is_none() {
                tx.execute(
                    "INSERT INTO research_envelopes (round_id, research_id, revision, limits_json)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![round_id, research_id, revision as i64, limits_json],
                )?;
            } else {
                tx.execute(
                    "UPDATE research_envelopes
                     SET revision = ?2, limits_json = ?3, updated_at = CURRENT_TIMESTAMP
                     WHERE round_id = ?1",
                    params![round_id, revision as i64, limits_json],
                )?;
            }
            tx.execute(
                "INSERT INTO research_envelope_revisions (round_id, revision, limits_json, actor)
                 VALUES (?1, ?2, ?3, ?4)",
                params![round_id, revision as i64, limits_json, actor],
            )?;
            let envelope = load_envelope(tx, round_id)?.expect("envelope just written");
            Ok((
                envelope,
                Some((project_id.to_owned(), research_id.to_owned())),
            ))
        })
    }

    pub fn envelope(
        &self,
        project_id: &str,
        research_id: &str,
        round_id: &str,
    ) -> Result<Option<Envelope>, ExperimentError> {
        let connection = self.connection();
        require_round(&connection, project_id, research_id, round_id)?;
        load_envelope(&connection, round_id)
    }

    /// Pauses (stops future launches), resumes, or closes the envelope.
    /// Idempotent; a closed envelope stays closed. Running processes are not
    /// touched here (cancellation is a separate act).
    pub fn set_envelope_state(
        &self,
        project_id: &str,
        research_id: &str,
        round_id: &str,
        state: EnvelopeState,
    ) -> Result<Envelope, ExperimentError> {
        self.write(|tx| {
            require_round(tx, project_id, research_id, round_id)?;
            let envelope = load_envelope(tx, round_id)?.ok_or(ExperimentError::NotFound)?;
            if envelope.state == state {
                return Ok((envelope, None));
            }
            if envelope.state == EnvelopeState::Closed {
                return Err(ExperimentError::State(
                    "a closed envelope cannot be reopened",
                ));
            }
            tx.execute(
                "UPDATE research_envelopes SET state = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE round_id = ?1",
                params![round_id, state.as_str()],
            )?;
            let envelope = load_envelope(tx, round_id)?.expect("envelope exists");
            Ok((
                envelope,
                Some((project_id.to_owned(), research_id.to_owned())),
            ))
        })
    }

    // -- Admission --------------------------------------------------------

    /// Admits a launch and reserves its budget in one transaction, before any
    /// side effect. Replaying a `launch_key` returns the existing attempt and
    /// consumes nothing; reusing it for a different command is refused.
    pub fn reserve(
        &self,
        project_id: &str,
        research_id: &str,
        launch: NewLaunch,
    ) -> Result<(Experiment, bool), ExperimentError> {
        let launch = launch.normalized()?;
        let hash = request_hash(&launch);
        let now = self.now();
        self.write(|tx| {
            require_round(tx, project_id, research_id, &launch.round_id)?;
            if let Some(found) = find_by_key(tx, &launch.round_id, &launch.launch_key)? {
                if found.1 != hash {
                    return Err(ExperimentError::KeyReuse);
                }
                return Ok(((found.0, false), None));
            }
            let envelope = load_envelope(tx, &launch.round_id)?
                .ok_or(ExperimentError::Denied(LaunchDenial::NoEnvelope))?;
            match envelope.state {
                EnvelopeState::Paused => {
                    return Err(ExperimentError::Denied(LaunchDenial::EnvelopePaused));
                }
                EnvelopeState::Closed => {
                    return Err(ExperimentError::Denied(LaunchDenial::EnvelopeClosed));
                }
                EnvelopeState::Active => {}
            }
            if envelope
                .limits
                .deadline_at
                .is_some_and(|deadline| now >= deadline)
            {
                return Err(ExperimentError::Denied(LaunchDenial::DeadlinePassed));
            }
            if !envelope.limits.authorizes(&launch.argv) {
                return Err(ExperimentError::Denied(LaunchDenial::CommandNotAuthorized));
            }
            if let Some(team_id) = &launch.team_id {
                check_team_scope(tx, project_id, team_id, &launch)?;
            }
            if envelope.launches_reserved >= envelope.limits.max_launches {
                return Err(ExperimentError::Denied(LaunchDenial::LaunchBudgetExhausted));
            }
            let running: i64 = tx.query_row(
                "SELECT COUNT(*) FROM experiments
                 WHERE round_id = ?1
                   AND state IN ('reserved', 'launching', 'running', 'cancelling', 'unknown')",
                [&launch.round_id],
                |row| row.get(0),
            )?;
            if running >= i64::from(envelope.limits.max_concurrent) {
                return Err(ExperimentError::Denied(LaunchDenial::ConcurrencyLimit));
            }
            if no_progress(tx, &launch.round_id, envelope.limits.max_no_progress)? {
                return Err(ExperimentError::Denied(LaunchDenial::NoProgress));
            }
            let id = Uuid::new_v4().to_string();
            let runtime = launch
                .max_runtime_secs
                .unwrap_or(envelope.limits.max_runtime_secs)
                .clamp(1, envelope.limits.max_runtime_secs);
            tx.execute(
                "INSERT INTO experiments
                   (id, project_id, research_id, round_id, team_id, task_id, owner_member_id,
                    launch_key, request_hash, label, argv_json, cwd, artifacts_json, sources_json,
                    policy_revision, max_runtime_secs)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    id,
                    project_id,
                    research_id,
                    launch.round_id,
                    launch.team_id,
                    launch.task_id,
                    launch.owner_member_id,
                    launch.launch_key,
                    hash,
                    launch.label,
                    serde_json::to_string(&launch.argv)?,
                    launch.cwd,
                    serde_json::to_string(&launch.artifacts)?,
                    serde_json::to_string(&launch.sources)?,
                    envelope.revision as i64,
                    runtime,
                ],
            )?;
            tx.execute(
                "UPDATE research_envelopes
                 SET launches_reserved = launches_reserved + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE round_id = ?1",
                [&launch.round_id],
            )?;
            let experiment = load_experiment(tx, &id)?;
            Ok((
                (experiment, true),
                Some((project_id.to_owned(), research_id.to_owned())),
            ))
        })
    }

    // -- Transitions (used by the runner) ----------------------------------

    /// `reserved → launching`: recorded immediately before the process is
    /// spawned, so a crash in between is recognisable as ambiguous.
    pub fn mark_launching(&self, id: &str) -> Result<Experiment, ExperimentError> {
        self.transition(id, &["reserved"], "launching", None)
    }

    /// `launching → running` with the process identity.
    pub fn mark_running(
        &self,
        id: &str,
        identity: &ProcessIdentity,
    ) -> Result<Experiment, ExperimentError> {
        self.write(|tx| {
            let experiment = load_experiment(tx, id)?;
            // A cancel that raced the launch keeps its intent.
            let next = if experiment.cancel_requested {
                "cancelling"
            } else {
                "running"
            };
            let changed = tx.execute(
                "UPDATE experiments
                 SET state = ?2, pid = ?3, start_ticks = ?4, boot_id = ?5,
                     launched_at = COALESCE(launched_at, CURRENT_TIMESTAMP)
                 WHERE id = ?1 AND state IN ('launching', 'reserved', 'cancelling')",
                params![
                    id,
                    next,
                    identity.pid,
                    identity.start_ticks as i64,
                    identity.boot_id
                ],
            )?;
            if changed == 0 {
                return Err(ExperimentError::State("the experiment is not launching"));
            }
            Ok((load_experiment(tx, id)?, Some(scope_of(tx, id)?)))
        })
    }

    /// Records a terminal observation. The state change, the committed event,
    /// the analysis obligation, and the resolution of the experiment's open
    /// waits happen together. Returns `true` only for the first observation,
    /// so duplicates converge without repeating side effects.
    pub fn observe(&self, id: &str, outcome: Outcome) -> Result<bool, ExperimentError> {
        self.write(|tx| {
            let experiment = load_experiment(tx, id)?;
            if !experiment.state.is_active() {
                return Ok((false, None));
            }
            let state = outcome.state.unwrap_or(if experiment.cancel_requested {
                ExperimentState::Cancelled
            } else {
                ExperimentState::Exited
            });
            if state.is_active() && state != ExperimentState::Unknown {
                return Err(ExperimentError::Invalid("an observation must be terminal"));
            }
            let reason = outcome
                .reason
                .as_deref()
                .map(|reason| reason.chars().take(MAX_REASON_CHARS).collect::<String>());
            // `unknown` keeps its slot and is finished by a later reconcile.
            let finished = state != ExperimentState::Unknown;
            tx.execute(
                "UPDATE experiments
                 SET state = ?2, exit_code = ?3, signal = ?4, reason = ?5, analysis = 'pending',
                     artifact_revisions_json = ?7,
                     finished_at = CASE WHEN ?6 THEN CURRENT_TIMESTAMP ELSE finished_at END
                 WHERE id = ?1",
                params![
                    id,
                    state.as_str(),
                    outcome.exit_code,
                    outcome.signal,
                    reason,
                    finished,
                    serde_json::to_string(&outcome.artifact_revisions)?
                ],
            )?;
            self.deliver(tx, id, EventKind::Finished)?;
            resolve_open_waits(tx, id)?;
            Ok((true, Some(scope_of(tx, id)?)))
        })
    }

    /// Asks for the process to stop. A not-yet-spawned reservation is
    /// cancelled outright; a live one moves to `cancelling` and the runner
    /// signals its process group. Returns the experiment as it now stands.
    pub fn request_cancel(&self, id: &str) -> Result<Experiment, ExperimentError> {
        self.write(|tx| {
            let experiment = load_experiment(tx, id)?;
            if !experiment.state.is_active() || experiment.cancel_requested {
                return Ok((experiment, None));
            }
            tx.execute(
                "UPDATE experiments SET cancel_requested = 1 WHERE id = ?1",
                [id],
            )?;
            match experiment.state {
                ExperimentState::Reserved => {
                    tx.execute(
                        "UPDATE experiments
                         SET state = 'cancelled', analysis = 'pending', reason = 'cancelled before launch',
                             finished_at = CURRENT_TIMESTAMP
                         WHERE id = ?1",
                        [id],
                    )?;
                    self.deliver(tx, id, EventKind::Finished)?;
                    resolve_open_waits(tx, id)?;
                }
                ExperimentState::Launching | ExperimentState::Running => {
                    tx.execute("UPDATE experiments SET state = 'cancelling' WHERE id = ?1", [id])?;
                }
                _ => {}
            }
            Ok((load_experiment(tx, id)?, Some(scope_of(tx, id)?)))
        })
    }

    /// Resolves an `unknown` experiment with the truth a person established.
    /// `not_started` frees the launch reservation; `finished` records the
    /// exit code if known. Nothing is relaunched.
    pub fn reconcile(
        &self,
        project_id: &str,
        id: &str,
        truth: ReconcileTruth,
        exit_code: Option<i32>,
        actor: &str,
    ) -> Result<Experiment, ExperimentError> {
        self.write(|tx| {
            let experiment = load_experiment(tx, id)?;
            if experiment.project_id != project_id {
                return Err(ExperimentError::NotFound);
            }
            if experiment.state != ExperimentState::Unknown {
                return Err(ExperimentError::State(
                    "only an unknown experiment is reconciled",
                ));
            }
            let reason = format!("reconciled as {} by {actor}", truth.as_str());
            match truth {
                ReconcileTruth::NotStarted => {
                    tx.execute(
                        "UPDATE experiments
                         SET state = 'failed_to_start', analysis = 'none', reason = ?2, refunded = 1,
                             finished_at = CURRENT_TIMESTAMP
                         WHERE id = ?1",
                        params![id, reason],
                    )?;
                    tx.execute(
                        "UPDATE research_envelopes
                         SET launches_reserved = MAX(launches_reserved - 1, 0)
                         WHERE round_id = ?1",
                        [&experiment.round_id],
                    )?;
                }
                ReconcileTruth::Finished => {
                    tx.execute(
                        "UPDATE experiments
                         SET state = 'exited', exit_code = ?2, reason = ?3, analysis = 'pending',
                             finished_at = CURRENT_TIMESTAMP
                         WHERE id = ?1",
                        params![id, exit_code, reason],
                    )?;
                }
            }
            resolve_open_waits(tx, id)?;
            self.deliver(tx, id, EventKind::Reconciled)?;
            Ok((load_experiment(tx, id)?, Some(scope_of(tx, id)?)))
        })
    }

    /// Records why a stop is under way (e.g. the runtime limit), so the
    /// eventual outcome is attributed correctly even across a restart.
    pub fn set_reason(&self, id: &str, reason: &str) -> Result<(), ExperimentError> {
        self.write(|tx| {
            tx.execute(
                "UPDATE experiments SET reason = ?2 WHERE id = ?1
                 AND state IN ('launching', 'running', 'cancelling')",
                params![id, reason],
            )?;
            Ok(((), None))
        })
    }

    /// Puts an experiment in a state without the usual transition (tests
    /// simulating a crash at a boundary).
    #[cfg(test)]
    pub(crate) fn force_state_for_test(&self, id: &str, state: &str) {
        self.connection()
            .execute(
                "UPDATE experiments SET state = ?2, pid = NULL, start_ticks = NULL, boot_id = NULL
                 WHERE id = ?1",
                params![id, state],
            )
            .expect("force state");
    }

    /// Looks an experiment up by id alone (the runner's own bookkeeping; API
    /// callers use the Project-scoped `experiment`).
    pub fn get(&self, id: &str) -> Result<Experiment, ExperimentError> {
        load_experiment(&self.connection(), id)
    }

    /// A reservation that never reached `launching` provably never spawned a
    /// process. It is closed and its launch is given back; the Leader is told
    /// through the usual observation so it can decide on an explicit retry.
    pub fn abandon_reserved(&self, id: &str, reason: &str) -> Result<bool, ExperimentError> {
        self.write(|tx| {
            let experiment = load_experiment(tx, id)?;
            if experiment.state != ExperimentState::Reserved {
                return Ok((false, None));
            }
            tx.execute(
                "UPDATE experiments
                 SET state = 'failed_to_start', analysis = 'pending', reason = ?2, refunded = 1,
                     finished_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, reason],
            )?;
            tx.execute(
                "UPDATE research_envelopes
                 SET launches_reserved = MAX(launches_reserved - 1, 0)
                 WHERE round_id = ?1",
                [&experiment.round_id],
            )?;
            self.deliver(tx, id, EventKind::Finished)?;
            resolve_open_waits(tx, id)?;
            Ok((true, Some(scope_of(tx, id)?)))
        })
    }

    /// Marks the analysis obligation met (used by the decision protocol).
    pub fn mark_analyzed(&self, id: &str) -> Result<Experiment, ExperimentError> {
        self.write(|tx| {
            let experiment = load_experiment(tx, id)?;
            if experiment.state.is_active() {
                return Err(ExperimentError::State("the experiment has not finished"));
            }
            if experiment.analysis == AnalysisState::Analyzed {
                return Ok((experiment, None));
            }
            tx.execute(
                "UPDATE experiments SET analysis = 'analyzed' WHERE id = ?1",
                [id],
            )?;
            Ok((load_experiment(tx, id)?, Some(scope_of(tx, id)?)))
        })
    }

    // -- Waits ------------------------------------------------------------

    /// Records that `member_id` yields on `experiment_id`. If the experiment
    /// is already finished the wait is created resolved: the result is owed
    /// and the caller will be woken with it. Idempotent per (experiment,
    /// member) while open.
    #[allow(clippy::too_many_arguments)]
    pub fn register_wait(
        &self,
        project_id: &str,
        team_id: &str,
        member_id: &str,
        experiment_id: &str,
        task_id: Option<&str>,
        expected_follow_up: &str,
        deadline_at: Option<i64>,
    ) -> Result<ExperimentWait, ExperimentError> {
        let follow_up = expected_follow_up.trim();
        if follow_up.chars().count() > MAX_FOLLOW_UP_CHARS {
            return Err(ExperimentError::Invalid(
                "the expected follow-up is too long",
            ));
        }
        let now = self.now();
        self.write(|tx| {
            let experiment = load_experiment(tx, experiment_id)?;
            if experiment.project_id != project_id
                || experiment.team_id.as_deref() != Some(team_id)
            {
                return Err(ExperimentError::NotFound);
            }
            let member_in_team: bool = tx
                .query_row(
                    "SELECT 1 FROM team_members WHERE id = ?1 AND team_id = ?2",
                    params![member_id, team_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !member_in_team {
                return Err(ExperimentError::NotFound);
            }
            if let Some(task_id) = task_id {
                let task_in_team: bool = tx
                    .query_row(
                        "SELECT 1 FROM team_tasks WHERE id = ?1 AND team_id = ?2",
                        params![task_id, team_id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if !task_in_team {
                    return Err(ExperimentError::NotFound);
                }
            }
            if let Some(open) = tx
                .query_row(
                    &format!(
                        "{WAIT_SELECT} WHERE experiment_id = ?1 AND owner_member_id = ?2 AND state = 'open'"
                    ),
                    params![experiment_id, member_id],
                    wait_from_row,
                )
                .optional()?
                .transpose()?
            {
                return Ok((open, None));
            }
            // A finished experiment's result was already delivered; a repeat
            // yield from the same member returns the wait it already made.
            if let Some(existing) = tx
                .query_row(
                    &format!(
                        "{WAIT_SELECT} WHERE experiment_id = ?1 AND owner_member_id = ?2
                         ORDER BY created_at DESC, rowid DESC LIMIT 1"
                    ),
                    params![experiment_id, member_id],
                    wait_from_row,
                )
                .optional()?
                .transpose()?
                && !experiment.state.is_active()
            {
                return Ok((existing, None));
            }
            let attempt_id: Option<String> = tx
                .query_row(
                    "SELECT id FROM team_task_attempts
                     WHERE team_id = ?1 AND member_id = ?2
                       AND status IN ('queued', 'running', 'needs_report')
                     ORDER BY created_at DESC LIMIT 1",
                    params![team_id, member_id],
                    |row| row.get(0),
                )
                .optional()?;
            // A wait cannot outlive the process's own runtime cap by much.
            let deadline = deadline_at
                .map(|at| at.clamp(now, now + MAX_WAIT_SECS))
                .or(Some(
                now + i64::from(experiment.max_runtime_secs) + 600,
            ));
            let finished = !experiment.state.is_active();
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO experiment_waits
                   (id, experiment_id, team_id, task_id, attempt_id, owner_member_id,
                    expected_follow_up, deadline_at, state, resolved_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                         CASE WHEN ?10 THEN CURRENT_TIMESTAMP ELSE NULL END)",
                params![
                    id,
                    experiment_id,
                    team_id,
                    task_id,
                    attempt_id,
                    member_id,
                    follow_up,
                    deadline,
                    if finished { "resolved" } else { "open" },
                    finished,
                ],
            )?;
            let wait = tx.query_row(&format!("{WAIT_SELECT} WHERE id = ?1"), [&id], wait_from_row)??;
            Ok((wait, Some(scope_of(tx, experiment_id)?)))
        })
    }

    /// Waits past their deadline become `expired`, each with its own event.
    /// Returns the expired waits so delivery can notify their owners.
    pub fn expire_due_waits(&self) -> Result<Vec<ExperimentWait>, ExperimentError> {
        let now = self.now();
        let mut connection = self.connection();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let due: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT id FROM experiment_waits
                 WHERE state = 'open' AND deadline_at IS NOT NULL AND deadline_at <= ?1",
            )?;
            statement
                .query_map([now], |row| row.get(0))?
                .collect::<Result<_, _>>()?
        };
        let mut expired = Vec::new();
        let mut cursor = None;
        for id in due {
            tx.execute(
                "UPDATE experiment_waits SET state = 'expired', resolved_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND state = 'open'",
                [&id],
            )?;
            let wait = tx.query_row(
                &format!("{WAIT_SELECT} WHERE id = ?1"),
                [&id],
                wait_from_row,
            )??;
            self.deliver(&tx, &wait.experiment_id, EventKind::WaitExpired)?;
            cursor = Some(append_research_event(
                &tx,
                &scope_of(&tx, &wait.experiment_id)?,
            )?);
            expired.push(wait);
        }
        tx.commit()?;
        drop(connection);
        if let Some(cursor) = cursor {
            self.agents.workspace_event_bus().publish_committed(cursor);
        }
        self.fire_wakes();
        Ok(expired)
    }

    /// Re-raises results that were read but never analyzed, a bounded number
    /// of times. A mailbox acknowledgement means the event was read, not that
    /// the experiment was analyzed, so the obligation stays until an explicit
    /// decision. Past the bound the result is reported as exhausted so the
    /// Team can be marked as needing attention instead of waking forever.
    pub fn remind_unanalyzed(
        &self,
        after_secs: i64,
        max_reminders: u32,
    ) -> Result<ReminderOutcome, ExperimentError> {
        let now = self.now();
        self.write(|tx| {
            let due: Vec<(String, String, u32, String)> = {
                let mut statement = tx.prepare(
                    "SELECT e.id, e.team_id, e.reminders, ev.id
                     FROM experiments e
                     JOIN teams t ON t.id = e.team_id AND t.status = 'active'
                     JOIN experiment_events ev ON ev.experiment_id = e.id AND ev.kind = 'finished'
                     LEFT JOIN team_messages m ON m.id = ev.message_id
                     WHERE e.analysis = 'pending'
                       AND (m.id IS NULL OR m.delivery_status = 'acknowledged')
                       AND COALESCE(e.reminded_at, CAST(strftime('%s', COALESCE(e.finished_at, e.created_at)) AS INTEGER))
                           <= ?1 - ?2
                     ORDER BY e.created_at, e.rowid",
                )?;
                statement
                    .query_map(params![now, after_secs], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                    })?
                    .collect::<Result<_, _>>()?
            };
            let mut outcome = ReminderOutcome::default();
            for (experiment_id, team_id, reminders, event_id) in due {
                if reminders >= max_reminders {
                    outcome.exhausted.push((team_id, experiment_id));
                    continue;
                }
                let experiment = load_experiment(tx, &experiment_id)?;
                let body = format!("Reminder {}: {}", reminders + 1, describe(&experiment, EventKind::Finished));
                let message_id = enqueue_message(tx, &experiment, &body)?;
                tx.execute(
                    "UPDATE experiment_events SET message_id = ?2 WHERE id = ?1",
                    params![event_id, message_id],
                )?;
                tx.execute(
                    "UPDATE experiments SET reminders = reminders + 1, reminded_at = ?2 WHERE id = ?1",
                    params![experiment_id, now],
                )?;
                self.note_wake(&team_id);
                outcome.reminded.push(experiment_id);
            }
            Ok((outcome, None))
        })
    }

    /// A member that leaves the Team cannot keep an obligation: its open waits
    /// are marked reassigned (delivery then routes to the Leader).
    pub fn reassign_waits_of_member(
        &self,
        team_id: &str,
        member_id: &str,
    ) -> Result<usize, ExperimentError> {
        self.write(|tx| {
            let changed = tx.execute(
                "UPDATE experiment_waits SET state = 'reassigned', resolved_at = CURRENT_TIMESTAMP
                 WHERE team_id = ?1 AND owner_member_id = ?2 AND state = 'open'",
                params![team_id, member_id],
            )?;
            Ok((changed, None))
        })
    }

    // -- Reads ------------------------------------------------------------

    pub fn experiment(&self, project_id: &str, id: &str) -> Result<Experiment, ExperimentError> {
        let connection = self.connection();
        let experiment = load_experiment(&connection, id)?;
        if experiment.project_id != project_id {
            return Err(ExperimentError::NotFound);
        }
        Ok(experiment)
    }

    pub fn experiments(
        &self,
        project_id: &str,
        research_id: &str,
        round_id: &str,
    ) -> Result<Vec<Experiment>, ExperimentError> {
        let connection = self.connection();
        require_round(&connection, project_id, research_id, round_id)?;
        let mut statement = connection.prepare(&format!(
            "{EXPERIMENT_SELECT} WHERE round_id = ?1 ORDER BY created_at DESC, rowid DESC"
        ))?;
        statement
            .query_map([round_id], experiment_from_row)?
            .map(|row| row?)
            .collect()
    }

    pub fn waits(
        &self,
        project_id: &str,
        research_id: &str,
        round_id: &str,
    ) -> Result<Vec<ExperimentWait>, ExperimentError> {
        let connection = self.connection();
        require_round(&connection, project_id, research_id, round_id)?;
        let mut statement = connection.prepare(&format!(
            "{WAIT_SELECT} WHERE experiment_id IN (SELECT id FROM experiments WHERE round_id = ?1)
             ORDER BY created_at DESC, rowid DESC"
        ))?;
        statement
            .query_map([round_id], wait_from_row)?
            .map(|row| row?)
            .collect()
    }

    /// Every experiment whose process may still be running or whose outcome
    /// is not recorded, across Projects. Used by startup recovery.
    pub fn active_experiments(&self) -> Result<Vec<Experiment>, ExperimentError> {
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "{EXPERIMENT_SELECT}
             WHERE state IN ('reserved', 'launching', 'running', 'cancelling')
             ORDER BY created_at, rowid"
        ))?;
        statement
            .query_map([], experiment_from_row)?
            .map(|row| row?)
            .collect()
    }

    // -- Internals ----------------------------------------------------------

    fn transition(
        &self,
        id: &str,
        from: &[&str],
        to: &str,
        reason: Option<&str>,
    ) -> Result<Experiment, ExperimentError> {
        self.write(|tx| {
            let placeholders = from
                .iter()
                .map(|state| format!("'{state}'"))
                .collect::<Vec<_>>()
                .join(",");
            let changed = tx.execute(
                &format!(
                    "UPDATE experiments SET state = ?2, reason = COALESCE(?3, reason)
                     WHERE id = ?1 AND state IN ({placeholders})"
                ),
                params![id, to, reason],
            )?;
            if changed == 0 {
                return Err(ExperimentError::State(
                    "the experiment is not in the expected state",
                ));
            }
            Ok((load_experiment(tx, id)?, Some(scope_of(tx, id)?)))
        })
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.database
            .lock()
            .expect("experiment database mutex poisoned")
    }

    /// Runs `operation` in an immediate transaction. A returned scope
    /// `(project_id, research_id)` inserts a content-free `research_updated`
    /// event in the same transaction and publishes it after commit.
    fn write<T>(
        &self,
        operation: impl FnOnce(
            &Transaction<'_>,
        ) -> Result<(T, Option<(String, String)>), ExperimentError>,
    ) -> Result<T, ExperimentError> {
        let mut connection = self.connection();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (value, scope) = operation(&transaction)?;
        let cursor = match scope {
            Some(scope) => Some(append_research_event(&transaction, &scope)?),
            None => None,
        };
        transaction.commit()?;
        drop(connection);
        if let Some(cursor) = cursor {
            self.agents.workspace_event_bus().publish_committed(cursor);
        }
        self.fire_wakes();
        Ok(value)
    }

    fn note_wake(&self, team_id: &str) {
        let mut wakes = self.wakes.lock().expect("wake mutex poisoned");
        if !wakes.iter().any(|queued| queued == team_id) {
            wakes.push(team_id.to_owned());
        }
    }

    fn fire_wakes(&self) {
        let teams: Vec<String> =
            std::mem::take(&mut *self.wakes.lock().expect("wake mutex poisoned"));
        if teams.is_empty() {
            return;
        }
        let hook = self.hook.lock().expect("hook mutex poisoned").clone();
        if let Some(hook) = hook {
            for team in teams {
                hook(&team);
            }
        }
    }

    /// Records an event once per (experiment, kind) and, if it is new and the
    /// experiment belongs to a Team, enqueues the mailbox message for the
    /// responsible member in the same transaction. A duplicate event does
    /// neither, so repeated observations converge.
    fn deliver(
        &self,
        tx: &Connection,
        experiment_id: &str,
        kind: EventKind,
    ) -> Result<(), ExperimentError> {
        let experiment = load_experiment(tx, experiment_id)?;
        let event_id = Uuid::new_v4().to_string();
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO experiment_events (id, experiment_id, kind) VALUES (?1, ?2, ?3)",
            params![event_id, experiment_id, kind.as_str()],
        )?;
        if inserted == 0 {
            return Ok(());
        }
        let Some(team_id) = &experiment.team_id else {
            return Ok(());
        };
        let message_id = enqueue_message(tx, &experiment, &describe(&experiment, kind))?;
        tx.execute(
            "UPDATE experiment_events SET message_id = ?2 WHERE id = ?1",
            params![event_id, message_id],
        )?;
        self.note_wake(team_id);
        Ok(())
    }
}

fn system_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn append_research_event(
    tx: &Connection,
    (project_id, research_id): &(String, String),
) -> Result<u64, ExperimentError> {
    tx.execute(
        "INSERT INTO workspace_events (kind, project_id, payload)
         VALUES ('research_updated', ?1, ?2)",
        params![
            project_id,
            json!({"research_id": research_id, "change": "execution"}).to_string()
        ],
    )?;
    Ok(tx.last_insert_rowid() as u64)
}

fn scope_of(tx: &Connection, experiment_id: &str) -> Result<(String, String), ExperimentError> {
    Ok(tx.query_row(
        "SELECT project_id, research_id FROM experiments WHERE id = ?1",
        [experiment_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?)
}

/// The round must exist inside this Project's question; anything else is
/// indistinguishable from missing.
fn require_round(
    connection: &Connection,
    project_id: &str,
    research_id: &str,
    round_id: &str,
) -> Result<(), ExperimentError> {
    connection
        .query_row(
            "SELECT 1 FROM research_rounds r JOIN research_questions q ON q.id = r.research_id
             WHERE r.id = ?1 AND r.research_id = ?2 AND q.project_id = ?3",
            params![round_id, research_id, project_id],
            |_| Ok(()),
        )
        .optional()?
        .ok_or(ExperimentError::NotFound)
}

fn check_team_scope(
    tx: &Connection,
    project_id: &str,
    team_id: &str,
    launch: &NewLaunch,
) -> Result<(), ExperimentError> {
    let status: Option<String> = tx
        .query_row(
            "SELECT status FROM teams WHERE id = ?1 AND project_id = ?2",
            params![team_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    match status.as_deref() {
        None => return Err(ExperimentError::NotFound),
        Some("active") => {}
        Some(_) => return Err(ExperimentError::Denied(LaunchDenial::TeamNotActive)),
    }
    // The round must belong to this Team, so another Team's round cannot be
    // spent by naming it.
    let owns_round: bool = tx
        .query_row(
            "SELECT 1 FROM research_rounds WHERE id = ?1 AND team_id = ?2",
            params![launch.round_id, team_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !owns_round {
        return Err(ExperimentError::NotFound);
    }
    if let Some(member_id) = &launch.owner_member_id {
        let member: bool = tx
            .query_row(
                "SELECT 1 FROM team_members WHERE id = ?1 AND team_id = ?2",
                params![member_id, team_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !member {
            return Err(ExperimentError::NotFound);
        }
    }
    if let Some(task_id) = &launch.task_id {
        let task: bool = tx
            .query_row(
                "SELECT 1 FROM team_tasks WHERE id = ?1 AND team_id = ?2",
                params![task_id, team_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !task {
            return Err(ExperimentError::NotFound);
        }
    }
    Ok(())
}

/// After `limit` consecutive finished attempts that failed, timed out, or
/// were lost, admission refuses until a person intervenes. Cancellations are
/// neutral; a productive attempt resets the run.
fn no_progress(tx: &Connection, round_id: &str, limit: u32) -> Result<bool, ExperimentError> {
    let mut statement = tx.prepare(
        "SELECT state, exit_code FROM experiments
         WHERE round_id = ?1 AND refunded = 0
           AND state IN ('exited', 'timed_out', 'failed_to_start')
         ORDER BY finished_at DESC, rowid DESC LIMIT ?2",
    )?;
    let recent: Vec<(String, Option<i32>)> = statement
        .query_map(params![round_id, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    Ok(recent.len() as u32 >= limit
        && recent
            .iter()
            .all(|(state, code)| state != "exited" || code.is_none_or(|code| code != 0)))
}

fn request_hash(launch: &NewLaunch) -> String {
    let canonical = json!({
        "argv": launch.argv,
        "cwd": launch.cwd,
        "artifacts": launch.artifacts,
        "team": launch.team_id,
        "task": launch.task_id,
    });
    hex::encode(Sha256::digest(canonical.to_string().as_bytes()))
}

/// Who is told about an experiment: the member who last waited on it, else
/// its owner, else the Leader — and the Leader whenever that member is gone.
fn enqueue_message(
    tx: &Connection,
    experiment: &Experiment,
    body: &str,
) -> Result<String, ExperimentError> {
    let team_id = experiment
        .team_id
        .as_deref()
        .ok_or(ExperimentError::NotFound)?;
    let leader: String = tx.query_row(
        "SELECT leader_member_id FROM teams WHERE id = ?1",
        [team_id],
        |row| row.get(0),
    )?;
    let latest_wait: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT owner_member_id, task_id FROM experiment_waits
             WHERE experiment_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [&experiment.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let task_id = experiment
        .task_id
        .clone()
        .or_else(|| latest_wait.as_ref().and_then(|(_, task)| task.clone()));
    let candidate = latest_wait
        .map(|(member, _)| member)
        .or_else(|| experiment.owner_member_id.clone());
    let recipient = match candidate {
        Some(member) => {
            let present: bool = tx
                .query_row(
                    "SELECT 1 FROM team_members WHERE id = ?1 AND team_id = ?2",
                    params![member, team_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if present { member } else { leader.clone() }
        }
        None => leader.clone(),
    };
    let message_id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO team_messages (id, team_id, from_member_id, to_member_id, kind, task_id, body)
         VALUES (?1, ?2, ?3, ?4, 'system', ?5, ?6)",
        params![message_id, team_id, leader, recipient, task_id, body],
    )?;
    Ok(message_id)
}

fn describe(experiment: &Experiment, kind: EventKind) -> String {
    let name = if experiment.label.is_empty() {
        experiment.id.as_str()
    } else {
        experiment.label.as_str()
    };
    match kind {
        EventKind::Finished if experiment.state == ExperimentState::Unknown => format!(
            "Experiment \"{name}\" has an unknown outcome: its process could not be accounted for. \
             Do not assume it succeeded and do not rerun it; ask the researcher to reconcile it."
        ),
        EventKind::Finished => {
            let code = experiment
                .exit_code
                .map(|code| format!(" (exit code {code})"))
                .unwrap_or_default();
            format!(
                "Experiment \"{name}\" ended: {}{code}. It is waiting for your analysis: review its \
                 logs and artifacts, publish what you learned, then continue or report. Until it is \
                 analyzed the Team cannot complete.",
                experiment.state.as_str()
            )
        }
        EventKind::WaitExpired => format!(
            "Your wait on experiment \"{name}\" expired while it was {}. The experiment itself is \
             unchanged; check on it and decide what to do.",
            experiment.state.as_str()
        ),
        EventKind::Reconciled => format!(
            "Experiment \"{name}\" was reconciled by the researcher: {}. Analyze the outcome if one \
             was recorded.",
            experiment.state.as_str()
        ),
    }
}

fn resolve_open_waits(tx: &Connection, experiment_id: &str) -> Result<(), ExperimentError> {
    tx.execute(
        "UPDATE experiment_waits SET state = 'resolved', resolved_at = CURRENT_TIMESTAMP
         WHERE experiment_id = ?1 AND state = 'open'",
        [experiment_id],
    )?;
    Ok(())
}

fn find_by_key(
    tx: &Connection,
    round_id: &str,
    launch_key: &str,
) -> Result<Option<(Experiment, String)>, ExperimentError> {
    let hash: Option<(String, String)> = tx
        .query_row(
            "SELECT id, request_hash FROM experiments WHERE round_id = ?1 AND launch_key = ?2",
            params![round_id, launch_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    hash.map(|(id, hash)| Ok((load_experiment(tx, &id)?, hash)))
        .transpose()
}

fn load_experiment(connection: &Connection, id: &str) -> Result<Experiment, ExperimentError> {
    connection
        .query_row(
            &format!("{EXPERIMENT_SELECT} WHERE id = ?1"),
            [id],
            experiment_from_row,
        )
        .optional()?
        .ok_or(ExperimentError::NotFound)?
}

fn load_envelope(
    connection: &Connection,
    round_id: &str,
) -> Result<Option<Envelope>, ExperimentError> {
    let row = connection
        .query_row(
            "SELECT round_id, research_id, revision, state, limits_json, launches_reserved,
                    created_at, updated_at
             FROM research_envelopes WHERE round_id = ?1",
            [round_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(round_id, research_id, revision, state, limits, reserved, created_at, updated_at)| {
            Ok(Envelope {
                round_id,
                research_id,
                revision: revision as u64,
                state: EnvelopeState::parse(&state).unwrap_or(EnvelopeState::Closed),
                limits: serde_json::from_str(&limits)?,
                launches_reserved: reserved as u32,
                created_at,
                updated_at,
            })
        },
    )
    .transpose()
}

fn experiment_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<Experiment, ExperimentError>> {
    let argv: String = row.get(9)?;
    let artifacts: String = row.get(11)?;
    let sources: String = row.get(12)?;
    let state: String = row.get(15)?;
    let analysis: String = row.get(16)?;
    let pid: Option<i64> = row.get(17)?;
    let ticks: Option<i64> = row.get(18)?;
    let boot: Option<String> = row.get(19)?;
    let base = (
        row.get::<_, String>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, String>(2)?,
        row.get::<_, String>(3)?,
        row.get::<_, Option<String>>(4)?,
        row.get::<_, Option<String>>(5)?,
        row.get::<_, Option<String>>(6)?,
        row.get::<_, String>(7)?,
        row.get::<_, String>(8)?,
        row.get::<_, String>(10)?,
        row.get::<_, i64>(13)?,
        row.get::<_, i64>(14)?,
    );
    let tail = (
        row.get::<_, Option<i32>>(20)?,
        row.get::<_, Option<i32>>(21)?,
        row.get::<_, Option<String>>(22)?,
        row.get::<_, bool>(23)?,
        row.get::<_, String>(24)?,
        row.get::<_, Option<String>>(25)?,
        row.get::<_, Option<String>>(26)?,
    );
    let artifact_revisions: String = row.get(27)?;
    Ok((|| {
        Ok(Experiment {
            id: base.0,
            project_id: base.1,
            research_id: base.2,
            round_id: base.3,
            team_id: base.4,
            task_id: base.5,
            owner_member_id: base.6,
            launch_key: base.7,
            label: base.8,
            argv: serde_json::from_str(&argv)?,
            cwd: base.9,
            artifacts: serde_json::from_str(&artifacts)?,
            sources: serde_json::from_str(&sources)?,
            policy_revision: base.10 as u64,
            max_runtime_secs: base.11 as u32,
            state: ExperimentState::parse(&state).unwrap_or(ExperimentState::Unknown),
            analysis: AnalysisState::parse(&analysis).unwrap_or(AnalysisState::Pending),
            identity: match (pid, ticks, boot) {
                (Some(pid), Some(ticks), Some(boot_id)) => Some(ProcessIdentity {
                    pid,
                    start_ticks: ticks as u64,
                    boot_id,
                }),
                _ => None,
            },
            exit_code: tail.0,
            signal: tail.1,
            reason: tail.2,
            cancel_requested: tail.3,
            artifact_revisions: serde_json::from_str(&artifact_revisions)?,
            created_at: tail.4,
            launched_at: tail.5,
            finished_at: tail.6,
        })
    })())
}

fn wait_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<Result<ExperimentWait, ExperimentError>> {
    let state: String = row.get(8)?;
    Ok(Ok(ExperimentWait {
        id: row.get(0)?,
        experiment_id: row.get(1)?,
        team_id: row.get(2)?,
        task_id: row.get(3)?,
        attempt_id: row.get(4)?,
        owner_member_id: row.get(5)?,
        expected_follow_up: row.get(6)?,
        deadline_at: row.get(7)?,
        state: WaitState::parse(&state).unwrap_or(WaitState::Cancelled),
        created_at: row.get(9)?,
        resolved_at: row.get(10)?,
    }))
}
