//! Workspace-owned research work (ADR 0215): the canonical task, attempt,
//! assignment, result-reference, and round-coordinator records. Work belongs to
//! a Project and a round, never to a Team or a Session, so it survives a
//! disbanded Team or a replaced executing Session. Legacy Team tasks are
//! mirrored additively (same ids) and remain operable through the Team store;
//! native work is changed only through the commands here.
//!
//! The store shares the Runtime's single SQLite owner (ADR 0200) and commits
//! its `work_updated` workspace event in the same transaction as each change.

mod commands;
mod models;
mod sync;

pub use models::*;

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::json;
use uuid::Uuid;

use crate::agent_store::AgentStore;
use crate::database::Database;

pub struct WorkStore {
    database: Arc<Database>,
    agents: Arc<AgentStore>,
}

/// What changed, for the content-free `work_updated` event payload.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Change {
    Created,
    Plan,
    Stage,
    Condition,
    Closed,
    Review,
    Assignment,
    Attempt,
    Result,
    Coordinator,
    Synced,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Plan => "plan",
            Self::Stage => "stage",
            Self::Condition => "condition",
            Self::Closed => "closed",
            Self::Review => "review",
            Self::Assignment => "assignment",
            Self::Attempt => "attempt",
            Self::Result => "result",
            Self::Coordinator => "coordinator",
            Self::Synced => "synced",
        }
    }
}

/// The event a write announces: `(project_id, work_id or round_id, change)`.
pub(crate) type Announce = Option<(String, String, Change)>;

/// Called by the Team store when it deletes a Team, in the same transaction:
/// mirrors the Team's last changes, then re-owns its work (ADR 0215 §5).
pub fn drain_team(tx: &Transaction<'_>, team_id: &str) -> rusqlite::Result<()> {
    sync::drain_team(tx, team_id).map_err(|error| match error {
        WorkError::Database(error) => error,
        other => rusqlite::Error::ToSqlConversionFailure(Box::new(other)),
    })
}

pub fn ensure_schema(connection: &Connection) -> Result<(), WorkError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_items (
           id                TEXT PRIMARY KEY,
           project_id        TEXT NOT NULL,
           research_id       TEXT,
           round_id          TEXT,
           team_id           TEXT,
           origin            TEXT NOT NULL,
           title             TEXT NOT NULL,
           description       TEXT NOT NULL DEFAULT '',
           plan              TEXT,
           stage             TEXT NOT NULL,
           condition         TEXT NOT NULL DEFAULT 'none',
           condition_reason  TEXT,
           review_kind       TEXT,
           lifecycle         TEXT NOT NULL DEFAULT 'active',
           closed_reason     TEXT,
           superseded_by     TEXT,
           acceptance        TEXT NOT NULL DEFAULT 'pending',
           outcome           TEXT NOT NULL DEFAULT 'unknown',
           priority          INTEGER NOT NULL DEFAULT 0,
           revision          INTEGER NOT NULL DEFAULT 1,
           state_revision    INTEGER NOT NULL DEFAULT 1,
           kind              TEXT NOT NULL DEFAULT 'other',
           result            TEXT,
           verification      TEXT,
           derived_from_kind TEXT,
           derived_from_id   TEXT,
           created_by        TEXT,
           client_request_id TEXT,
           created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE INDEX IF NOT EXISTS work_items_project ON work_items(project_id, stage);
         CREATE INDEX IF NOT EXISTS work_items_round ON work_items(round_id);
         CREATE INDEX IF NOT EXISTS work_items_team ON work_items(team_id);
         CREATE UNIQUE INDEX IF NOT EXISTS work_items_request
           ON work_items(project_id, client_request_id) WHERE client_request_id IS NOT NULL;
         -- Every change to an item bumps its state revision exactly once, whatever
         -- code path made it, so a command can be refused if the item moved on.
         CREATE TRIGGER IF NOT EXISTS work_items_state_revision AFTER UPDATE ON work_items
           WHEN NEW.state_revision = OLD.state_revision BEGIN
           UPDATE work_items SET state_revision = OLD.state_revision + 1 WHERE id = NEW.id;
         END;
         CREATE TABLE IF NOT EXISTS work_dependencies (
           task_id       TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
           dependency_id TEXT NOT NULL,
           PRIMARY KEY (task_id, dependency_id)
         );
         CREATE TABLE IF NOT EXISTS work_assignments (
           id              TEXT PRIMARY KEY,
           task_id         TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
           conversation_id TEXT NOT NULL,
           member_id       TEXT,
           assigned_by     TEXT,
           started_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           ended_at        TEXT,
           end_reason      TEXT
         );
         CREATE UNIQUE INDEX IF NOT EXISTS work_assignments_open
           ON work_assignments(task_id) WHERE ended_at IS NULL;
         CREATE TABLE IF NOT EXISTS work_attempts (
           id              TEXT PRIMARY KEY,
           task_id         TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
           assignment_id   TEXT,
           conversation_id TEXT,
           run_id          TEXT,
           request_key     TEXT,
           status          TEXT NOT NULL DEFAULT 'queued',
           failure_kind    TEXT,
           error           TEXT,
           created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           completed_at    TEXT
         );
         CREATE INDEX IF NOT EXISTS work_attempts_task ON work_attempts(task_id);
         CREATE UNIQUE INDEX IF NOT EXISTS work_attempts_request
           ON work_attempts(task_id, request_key) WHERE request_key IS NOT NULL;
         CREATE TABLE IF NOT EXISTS work_reviews (
           id         TEXT PRIMARY KEY,
           task_id    TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
           kind       TEXT NOT NULL,
           accepted   INTEGER NOT NULL,
           outcome    TEXT NOT NULL,
           reviewer   TEXT NOT NULL,
           reason     TEXT,
           inputs     TEXT NOT NULL DEFAULT '[]',
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE TABLE IF NOT EXISTS work_results (
           id         TEXT PRIMARY KEY,
           task_id    TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
           attempt_id TEXT,
           role       TEXT NOT NULL,
           kind       TEXT NOT NULL,
           ref_id     TEXT NOT NULL,
           revision   TEXT,
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           UNIQUE (task_id, attempt_id, role, kind, ref_id)
         );
         CREATE TABLE IF NOT EXISTS round_coordinators (
           round_id   TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           holder     TEXT NOT NULL,
           epoch      INTEGER NOT NULL,
           since      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE TABLE IF NOT EXISTS round_coordinator_history (
           id              INTEGER PRIMARY KEY AUTOINCREMENT,
           round_id        TEXT NOT NULL,
           epoch           INTEGER NOT NULL,
           holder          TEXT NOT NULL,
           previous_holder TEXT,
           reason          TEXT NOT NULL,
           at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE TABLE IF NOT EXISTS work_sync_queue (
           team_id TEXT PRIMARY KEY
         );",
    )?;
    sync::install_triggers(connection)?;
    Ok(())
}

impl WorkStore {
    /// The Team, research, and experiment stores must already have created
    /// their tables: the legacy mirror is fed by triggers on them.
    pub fn from_database(
        database: Arc<Database>,
        agents: Arc<AgentStore>,
    ) -> Result<Self, WorkError> {
        {
            let connection = database.lock().expect("work database mutex poisoned");
            ensure_schema(&connection)?;
            sync::enqueue_all_teams(&connection)?;
        }
        let store = Self { database, agents };
        // Drain whatever a previous run left queued, or the first mirror of
        // pre-existing Team tasks. Idempotent and safe to repeat after a crash.
        store.reconcile()?;
        Ok(store)
    }

    pub(crate) fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.database.lock().expect("work database mutex poisoned")
    }

    /// Applies queued legacy changes to the work records. Called before every
    /// read and write so a reader never sees a stale mirror.
    pub fn reconcile(&self) -> Result<usize, WorkError> {
        let mut connection = self.connection();
        let pending: i64 =
            connection.query_row("SELECT COUNT(*) FROM work_sync_queue", [], |row| row.get(0))?;
        if pending == 0 {
            return Ok(0);
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (applied, projects) = sync::reconcile(&transaction)?;
        let mut cursor = None;
        for project_id in &projects {
            transaction.execute(
                "INSERT INTO workspace_events (kind, project_id, payload)
                 VALUES ('work_updated', ?1, ?2)",
                params![
                    project_id,
                    json!({"change": Change::Synced.as_str()}).to_string()
                ],
            )?;
            cursor = Some(transaction.last_insert_rowid() as u64);
        }
        transaction.commit()?;
        drop(connection);
        if let Some(cursor) = cursor {
            self.agents.workspace_event_bus().publish_committed(cursor);
        }
        Ok(applied)
    }

    /// Runs one write command: mirror first, then the command in an immediate
    /// transaction, then its event committed with it and published after.
    pub(crate) fn write<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<(T, Announce), WorkError>,
    ) -> Result<T, WorkError> {
        self.reconcile()?;
        let mut connection = self.connection();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (value, change) = operation(&transaction)?;
        let cursor = match change {
            Some((project_id, subject, change)) => {
                transaction.execute(
                    "INSERT INTO workspace_events (kind, project_id, payload)
                     VALUES ('work_updated', ?1, ?2)",
                    params![
                        project_id,
                        json!({"subject": subject, "change": change.as_str()}).to_string()
                    ],
                )?;
                Some(transaction.last_insert_rowid() as u64)
            }
            None => None,
        };
        transaction.commit()?;
        drop(connection);
        if let Some(cursor) = cursor {
            self.agents.workspace_event_bus().publish_committed(cursor);
        }
        Ok(value)
    }

    // -- Reads ---------------------------------------------------------------

    pub fn get(&self, project_id: &str, id: &str) -> Result<WorkItem, WorkError> {
        self.reconcile()?;
        load_item(&self.connection(), project_id, id)
    }

    pub fn summary(&self, project_id: &str, id: &str) -> Result<WorkSummary, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        let item = load_item(&connection, project_id, id)?;
        summarize(&connection, item)
    }

    /// Work of one Project, highest priority first. Filters narrow the same
    /// items; none of them selects a different set of records. Paged: `limit`
    /// defaults to and is capped at 200.
    pub fn list(
        &self,
        project_id: &str,
        filter: &WorkFilter,
    ) -> Result<Vec<WorkSummary>, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        let limit = filter.limit.unwrap_or(MAX_LIST).clamp(1, MAX_LIST);
        let mut statement = connection.prepare(&format!(
            "{ITEM_SELECT} WHERE {FILTER_SQL}
             ORDER BY priority DESC, created_at, id LIMIT ?9 OFFSET ?10"
        ))?;
        let rows = statement.query_map(
            params![
                project_id,
                filter.research_id,
                filter.round_id,
                filter.team_id,
                filter.stage.map(WorkStage::as_str),
                filter.include_closed,
                filter.conversation_id,
                filter.condition.map(WorkCondition::as_str),
                limit as i64,
                filter.offset as i64,
                filter.origin.map(WorkOrigin::as_str),
            ],
            item_from_row,
        )?;
        let mut summaries = Vec::new();
        for row in rows {
            let item = hydrate(&connection, row?)?;
            summaries.push(summarize(&connection, item)?);
        }
        Ok(summaries)
    }

    /// How much work each stage holds under the same filter a view uses, so a
    /// board header never disagrees with its columns.
    pub fn counts(&self, project_id: &str, filter: &WorkFilter) -> Result<WorkCounts, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "SELECT stage, COUNT(*) FROM work_items WHERE {FILTER_SQL} GROUP BY stage"
        ))?;
        let rows = statement.query_map(
            params![
                project_id,
                filter.research_id,
                filter.round_id,
                filter.team_id,
                Option::<&str>::None,
                filter.include_closed,
                filter.conversation_id,
                filter.condition.map(WorkCondition::as_str),
                0_i64,
                0_i64,
                filter.origin.map(WorkOrigin::as_str),
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize)),
        )?;
        let mut counts = WorkCounts::default();
        for row in rows {
            let (stage, count) = row?;
            if let Some(stage) = WorkStage::parse(&stage) {
                counts.total += count;
                counts.by_stage.push((stage, count));
            }
        }
        counts
            .by_stage
            .sort_by_key(|(stage, _)| WorkStage::ALL.iter().position(|s| s == stage));
        Ok(counts)
    }

    /// Review decisions on a task, oldest first, with the inputs each saw.
    pub fn reviews(&self, project_id: &str, id: &str) -> Result<Vec<ReviewRecord>, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        load_item(&connection, project_id, id)?;
        let mut statement = connection.prepare(
            "SELECT id, task_id, kind, accepted, outcome, reviewer, reason, inputs, created_at
             FROM work_reviews WHERE task_id = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = statement.query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)? != 0,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })?;
        let mut records = Vec::new();
        for row in rows {
            let (id, task_id, kind, accepted, outcome, reviewer, reason, inputs, created_at) = row?;
            records.push(ReviewRecord {
                id,
                task_id,
                kind: ReviewKind::parse(&kind).unwrap_or(ReviewKind::Result),
                accepted,
                outcome: WorkOutcome::parse(&outcome).unwrap_or(WorkOutcome::Unknown),
                reviewer,
                reason,
                inputs: serde_json::from_str(&inputs)?,
                created_at,
            });
        }
        Ok(records)
    }

    pub fn attempts(&self, project_id: &str, id: &str) -> Result<Vec<Attempt>, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        load_item(&connection, project_id, id)?;
        attempts_of(&connection, id)
    }

    pub fn attempt(&self, project_id: &str, attempt_id: &str) -> Result<Attempt, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        load_attempt(&connection, project_id, attempt_id)
    }

    pub fn assignments(&self, project_id: &str, id: &str) -> Result<Vec<Assignment>, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        load_item(&connection, project_id, id)?;
        let mut statement = connection.prepare(&format!(
            "{ASSIGNMENT_SELECT} WHERE task_id = ?1 ORDER BY started_at, rowid"
        ))?;
        let rows = statement.query_map([id], assignment_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn results(&self, project_id: &str, id: &str) -> Result<Vec<ResultRef>, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        load_item(&connection, project_id, id)?;
        results_of(&connection, id)
    }

    pub fn coordinator(
        &self,
        project_id: &str,
        round_id: &str,
    ) -> Result<Option<RoundCoordinator>, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        coordinator_of(&connection, project_id, round_id)
    }

    pub fn coordinator_history(
        &self,
        project_id: &str,
        round_id: &str,
    ) -> Result<Vec<CoordinatorChange>, WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        let owned: i64 = connection.query_row(
            "SELECT COUNT(*) FROM round_coordinators WHERE round_id = ?1 AND project_id = ?2",
            params![round_id, project_id],
            |row| row.get(0),
        )?;
        if owned == 0 {
            return Err(WorkError::NotFound);
        }
        let mut statement = connection.prepare(
            "SELECT round_id, epoch, holder, previous_holder, reason, at
             FROM round_coordinator_history WHERE round_id = ?1 ORDER BY epoch, id",
        )?;
        let rows = statement.query_map([round_id], |row| {
            Ok(CoordinatorChange {
                round_id: row.get(0)?,
                epoch: row.get::<_, i64>(1)? as u64,
                holder: row.get(2)?,
                previous_holder: row.get(3)?,
                reason: row.get(4)?,
                at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

const MAX_LIST: usize = 200;

/// The one filter every view shares (see `list` and `counts`).
const FILTER_SQL: &str = "project_id = ?1
       AND (?2 IS NULL OR research_id = ?2)
       AND (?3 IS NULL OR round_id = ?3)
       AND (?4 IS NULL OR team_id = ?4)
       AND (?5 IS NULL OR stage = ?5)
       AND (?6 OR lifecycle = 'active')
       AND (?7 IS NULL OR EXISTS (
             SELECT 1 FROM work_assignments a
             WHERE a.task_id = work_items.id AND a.ended_at IS NULL AND a.conversation_id = ?7))
       AND (?8 IS NULL OR condition = ?8)
       AND (?11 IS NULL OR origin = ?11)";

// -- Row mapping -------------------------------------------------------------------------------------------

pub(crate) const ITEM_SELECT: &str =
    "SELECT id, project_id, research_id, round_id, team_id, origin,
        title, description, plan, stage, condition, condition_reason, review_kind, lifecycle,
        closed_reason, superseded_by, acceptance, outcome, priority, revision, created_by,
        created_at, updated_at, kind, result, verification, state_revision, derived_from_kind,
        derived_from_id FROM work_items";

pub(crate) fn item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkItem> {
    let text = |index: usize| row.get::<_, String>(index);
    Ok(WorkItem {
        id: row.get(0)?,
        project_id: row.get(1)?,
        research_id: row.get(2)?,
        round_id: row.get(3)?,
        team_id: row.get(4)?,
        origin: WorkOrigin::parse(&text(5)?).unwrap_or(WorkOrigin::Native),
        title: row.get(6)?,
        description: row.get(7)?,
        plan: row.get(8)?,
        stage: WorkStage::parse(&text(9)?).unwrap_or(WorkStage::Planned),
        condition: WorkCondition::parse(&text(10)?).unwrap_or(WorkCondition::None),
        condition_reason: row.get(11)?,
        review_kind: row
            .get::<_, Option<String>>(12)?
            .and_then(|value| ReviewKind::parse(&value)),
        lifecycle: WorkLifecycle::parse(&text(13)?).unwrap_or(WorkLifecycle::Active),
        closed_reason: row.get(14)?,
        superseded_by: row.get(15)?,
        acceptance: Acceptance::parse(&text(16)?).unwrap_or(Acceptance::Pending),
        outcome: WorkOutcome::parse(&text(17)?).unwrap_or(WorkOutcome::Unknown),
        priority: row.get(18)?,
        revision: row.get::<_, i64>(19)? as u64,
        dependencies: Vec::new(),
        created_by: row.get(20)?,
        created_at: row.get(21)?,
        updated_at: row.get(22)?,
        kind: WorkKind::parse(&text(23)?).unwrap_or(WorkKind::Other),
        result: row.get(24)?,
        verification: row.get(25)?,
        state_revision: row.get::<_, i64>(26)? as u64,
        derived_from: match (
            row.get::<_, Option<String>>(27)?,
            row.get::<_, Option<String>>(28)?,
        ) {
            (Some(kind), Some(id)) => Some(DerivedFrom { kind, id }),
            _ => None,
        },
    })
}

/// Fills the dependency list a row does not carry.
pub(crate) fn hydrate(connection: &Connection, mut item: WorkItem) -> Result<WorkItem, WorkError> {
    let mut statement = connection.prepare(
        "SELECT dependency_id FROM work_dependencies WHERE task_id = ?1 ORDER BY dependency_id",
    )?;
    item.dependencies = statement
        .query_map([&item.id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(item)
}

/// One item of a Project, or `NotFound` — another Project's item reads exactly
/// like a missing one.
pub(crate) fn load_item(
    connection: &Connection,
    project_id: &str,
    id: &str,
) -> Result<WorkItem, WorkError> {
    let item = connection
        .query_row(
            &format!("{ITEM_SELECT} WHERE id = ?1 AND project_id = ?2"),
            params![id, project_id],
            item_from_row,
        )
        .optional()?
        .ok_or(WorkError::NotFound)?;
    hydrate(connection, item)
}

pub(crate) const ASSIGNMENT_SELECT: &str = "SELECT id, task_id, conversation_id, member_id,
        assigned_by, started_at, ended_at, end_reason FROM work_assignments";

pub(crate) fn assignment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Assignment> {
    Ok(Assignment {
        id: row.get(0)?,
        task_id: row.get(1)?,
        conversation_id: row.get(2)?,
        member_id: row.get(3)?,
        assigned_by: row.get(4)?,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
        end_reason: row.get(7)?,
    })
}

pub(crate) fn open_assignment(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<Assignment>, WorkError> {
    Ok(connection
        .query_row(
            &format!("{ASSIGNMENT_SELECT} WHERE task_id = ?1 AND ended_at IS NULL"),
            [task_id],
            assignment_from_row,
        )
        .optional()?)
}

pub(crate) const ATTEMPT_SELECT: &str =
    "SELECT id, task_id, assignment_id, conversation_id, run_id,
        status, failure_kind, error, created_at, updated_at, completed_at FROM work_attempts";

pub(crate) fn attempt_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Attempt> {
    Ok(Attempt {
        id: row.get(0)?,
        task_id: row.get(1)?,
        assignment_id: row.get(2)?,
        conversation_id: row.get(3)?,
        run_id: row.get(4)?,
        status: AttemptStatus::parse(&row.get::<_, String>(5)?).unwrap_or(AttemptStatus::Queued),
        failure_kind: row.get(6)?,
        error: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        completed_at: row.get(10)?,
    })
}

pub(crate) fn attempts_of(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<Attempt>, WorkError> {
    let mut statement = connection.prepare(&format!(
        "{ATTEMPT_SELECT} WHERE task_id = ?1 ORDER BY created_at, rowid"
    ))?;
    let rows = statement.query_map([task_id], attempt_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// An attempt of an item in this Project.
pub(crate) fn load_attempt(
    connection: &Connection,
    project_id: &str,
    attempt_id: &str,
) -> Result<Attempt, WorkError> {
    connection
        .query_row(
            "SELECT a.id, a.task_id, a.assignment_id, a.conversation_id, a.run_id, a.status,
                    a.failure_kind, a.error, a.created_at, a.updated_at, a.completed_at
             FROM work_attempts a JOIN work_items w ON w.id = a.task_id
             WHERE a.id = ?1 AND w.project_id = ?2",
            params![attempt_id, project_id],
            attempt_from_row,
        )
        .optional()?
        .ok_or(WorkError::NotFound)
}

pub(crate) fn is_open(status: AttemptStatus) -> bool {
    matches!(
        status,
        AttemptStatus::Queued
            | AttemptStatus::Running
            | AttemptStatus::NeedsReport
            | AttemptStatus::ResultSubmitted
    )
}

pub(crate) fn results_of(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<ResultRef>, WorkError> {
    let mut statement = connection.prepare(
        "SELECT id, task_id, attempt_id, role, kind, ref_id, revision, created_at
         FROM work_results WHERE task_id = ?1 ORDER BY created_at, rowid",
    )?;
    let rows = statement.query_map([task_id], |row| {
        Ok(ResultRef {
            id: row.get(0)?,
            task_id: row.get(1)?,
            attempt_id: row.get(2)?,
            role: ResultRole::parse(&row.get::<_, String>(3)?).unwrap_or(ResultRole::Result),
            kind: row.get(4)?,
            ref_id: row.get(5)?,
            revision: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn summarize(connection: &Connection, item: WorkItem) -> Result<WorkSummary, WorkError> {
    let attempts = attempts_of(connection, &item.id)?;
    let results = results_of(connection, &item.id)?;
    let dependency_states = {
        let mut statement = connection.prepare(
            "SELECT w.id, w.title, w.stage, w.lifecycle, w.acceptance
             FROM work_dependencies d JOIN work_items w ON w.id = d.dependency_id
             WHERE d.task_id = ?1 ORDER BY w.id",
        )?;
        statement
            .query_map([&item.id], |row| {
                Ok(DependencyState {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    stage: WorkStage::parse(&row.get::<_, String>(2)?)
                        .unwrap_or(WorkStage::Planned),
                    lifecycle: WorkLifecycle::parse(&row.get::<_, String>(3)?)
                        .unwrap_or(WorkLifecycle::Active),
                    acceptance: Acceptance::parse(&row.get::<_, String>(4)?)
                        .unwrap_or(Acceptance::Pending),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let supersedes = {
        let mut statement =
            connection.prepare("SELECT id FROM work_items WHERE superseded_by = ?1 ORDER BY id")?;
        statement
            .query_map([&item.id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    let experiment_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM experiments WHERE task_id = ?1",
        [&item.id],
        |row| row.get(0),
    )?;
    let last_activity_at = attempts
        .iter()
        .map(|attempt| attempt.updated_at.clone())
        .chain(results.iter().map(|result| result.created_at.clone()))
        .chain(std::iter::once(item.updated_at.clone()))
        .max()
        .unwrap_or_default();
    Ok(WorkSummary {
        assignment: open_assignment(connection, &item.id)?,
        results,
        attempt_count: attempts.len(),
        latest_attempt: attempts.into_iter().last(),
        dependency_states,
        supersedes,
        experiment_count: experiment_count as usize,
        last_activity_at,
        item,
    })
}

pub(crate) fn coordinator_of(
    connection: &Connection,
    project_id: &str,
    round_id: &str,
) -> Result<Option<RoundCoordinator>, WorkError> {
    Ok(connection
        .query_row(
            "SELECT round_id, project_id, holder, epoch, since FROM round_coordinators
             WHERE round_id = ?1 AND project_id = ?2",
            params![round_id, project_id],
            |row| {
                Ok(RoundCoordinator {
                    round_id: row.get(0)?,
                    project_id: row.get(1)?,
                    holder: row.get(2)?,
                    epoch: row.get::<_, i64>(3)? as u64,
                    since: row.get(4)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests;
