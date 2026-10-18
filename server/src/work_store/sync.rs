//! The additive, resumable mirror of legacy Team tasks (ADR 0215 §5). Triggers
//! on the Team tables enqueue the owning Team in the same transaction as the
//! legacy write; `reconcile` applies the queue idempotently (same ids, so every
//! existing reference stays valid) before any work read or write, and again at
//! startup, so a crash between the two leaves nothing lost.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::commands::refresh_readiness;
use super::*;

const SOURCE_TABLES: [&str; 6] = [
    "team_tasks",
    "team_task_attempts",
    "team_task_dependencies",
    "research_rounds",
    "experiment_waits",
    "teams",
];

/// Installs the enqueue triggers once the source tables exist.
pub(super) fn install_triggers(connection: &Connection) -> Result<(), WorkError> {
    let present: i64 = connection.query_row(
        &format!(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ({})",
            SOURCE_TABLES
                .iter()
                .map(|name| format!("'{name}'"))
                .collect::<Vec<_>>()
                .join(",")
        ),
        [],
        |row| row.get(0),
    )?;
    if present as usize != SOURCE_TABLES.len() {
        return Ok(());
    }
    connection.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS work_sync_tasks_insert AFTER INSERT ON team_tasks BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (NEW.team_id);
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_tasks_update AFTER UPDATE ON team_tasks BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (NEW.team_id);
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_tasks_delete AFTER DELETE ON team_tasks BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (OLD.team_id);
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_attempts_insert AFTER INSERT ON team_task_attempts BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (NEW.team_id);
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_attempts_update AFTER UPDATE ON team_task_attempts BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (NEW.team_id);
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_dependencies_insert AFTER INSERT ON team_task_dependencies BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id)
             SELECT team_id FROM team_tasks WHERE id = NEW.task_id;
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_dependencies_delete AFTER DELETE ON team_task_dependencies BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id)
             SELECT team_id FROM team_tasks WHERE id = OLD.task_id;
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_rounds_insert AFTER INSERT ON research_rounds
           WHEN NEW.team_id IS NOT NULL BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (NEW.team_id);
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_rounds_update AFTER UPDATE ON research_rounds
           WHEN NEW.team_id IS NOT NULL BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (NEW.team_id);
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_waits_insert AFTER INSERT ON experiment_waits BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (NEW.team_id);
         END;
         CREATE TRIGGER IF NOT EXISTS work_sync_waits_update AFTER UPDATE ON experiment_waits BEGIN
           INSERT OR IGNORE INTO work_sync_queue(team_id) VALUES (NEW.team_id);
         END;",
    )?;
    Ok(())
}

/// Queues every Team that has tasks: the first mirror of work that predates this
/// store, and a safety net after a crash. Idempotent.
pub(super) fn enqueue_all_teams(connection: &Connection) -> Result<(), WorkError> {
    let has_tasks: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'team_tasks'",
        [],
        |row| row.get(0),
    )?;
    if has_tasks == 0 {
        return Ok(());
    }
    connection.execute(
        "INSERT OR IGNORE INTO work_sync_queue(team_id)
         SELECT DISTINCT team_id FROM team_tasks",
        [],
    )?;
    Ok(())
}

struct LegacyTask {
    id: String,
    creator_member_id: String,
    assignee_member_id: Option<String>,
    title: String,
    description: String,
    status: String,
    plan: Option<String>,
    created_at: String,
    updated_at: String,
}

/// The facets a legacy status mirrors to (ADR 0215 §5).
struct Mirrored {
    stage: WorkStage,
    condition: WorkCondition,
    condition_reason: Option<&'static str>,
    review_kind: Option<ReviewKind>,
    lifecycle: WorkLifecycle,
    closed_reason: Option<&'static str>,
    acceptance: Acceptance,
}

fn mirror_status(status: &str, dependencies_met: bool, waiting: bool) -> Mirrored {
    let base = |stage| Mirrored {
        stage,
        condition: WorkCondition::None,
        condition_reason: None,
        review_kind: None,
        lifecycle: WorkLifecycle::Active,
        closed_reason: None,
        acceptance: Acceptance::Pending,
    };
    match status {
        "pending" => base(if dependencies_met {
            WorkStage::Ready
        } else {
            WorkStage::Planned
        }),
        "blocked" => Mirrored {
            condition: WorkCondition::Blocked,
            condition_reason: Some("waiting for dependencies"),
            ..base(WorkStage::Planned)
        },
        "in_progress" => Mirrored {
            condition: if waiting {
                WorkCondition::Waiting
            } else {
                WorkCondition::None
            },
            condition_reason: waiting.then_some("waiting for an experiment"),
            ..base(WorkStage::Executing)
        },
        "plan_review" => Mirrored {
            review_kind: Some(ReviewKind::Plan),
            ..base(WorkStage::Review)
        },
        "result_review" => Mirrored {
            review_kind: Some(ReviewKind::Result),
            ..base(WorkStage::Review)
        },
        "changes_requested" => Mirrored {
            condition_reason: Some("changes requested"),
            ..base(WorkStage::Executing)
        },
        "accepted" => Mirrored {
            acceptance: Acceptance::Accepted,
            ..base(WorkStage::Done)
        },
        // The process or the Session failed; the task was not accepted.
        "failed" => Mirrored {
            acceptance: Acceptance::Rejected,
            ..base(WorkStage::Done)
        },
        "cancelled" => Mirrored {
            lifecycle: WorkLifecycle::Canceled,
            closed_reason: Some("cancelled by the Team"),
            ..base(WorkStage::Done)
        },
        _ => base(WorkStage::Planned),
    }
}

/// Applies the queue. Returns how many Teams were mirrored and the Projects
/// whose work changed.
pub(super) fn reconcile(tx: &Transaction<'_>) -> Result<(usize, Vec<String>), WorkError> {
    let teams = {
        let mut statement = tx.prepare("SELECT team_id FROM work_sync_queue ORDER BY team_id")?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut projects = BTreeSet::new();
    let mut applied = 0;
    for team_id in teams {
        if let Some(project_id) = sync_team(tx, &team_id)? {
            projects.insert(project_id);
            applied += 1;
        }
        tx.execute("DELETE FROM work_sync_queue WHERE team_id = ?1", [&team_id])?;
    }
    for project_id in &projects {
        // Native work may depend on mirrored work.
        refresh_readiness(tx, project_id)?;
    }
    Ok((applied, projects.into_iter().collect()))
}

fn sync_team(tx: &Transaction<'_>, team_id: &str) -> Result<Option<String>, WorkError> {
    // A Team that is gone leaves its work items in place: work outlives the Team.
    let Some((project_id, leader_member_id)) = tx
        .query_row(
            "SELECT project_id, leader_member_id FROM teams WHERE id = ?1",
            [team_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let round: Option<(String, String)> = tx
        .query_row(
            "SELECT r.id, r.research_id FROM research_rounds r
             JOIN research_questions q ON q.id = r.research_id
             WHERE r.team_id = ?1 AND q.project_id = ?2",
            params![team_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let conversation_of = |member_id: &str| -> Result<Option<String>, WorkError> {
        Ok(tx
            .query_row(
                "SELECT conversation_id FROM team_members WHERE id = ?1 AND team_id = ?2",
                params![member_id, team_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    };

    // The Leader is the first coordinator of a research Team's round.
    if let Some((round_id, _)) = &round
        && coordinator_of(tx, &project_id, round_id)?.is_none()
        && let Some(leader) = conversation_of(&leader_member_id)?
    {
        tx.execute(
            "INSERT OR IGNORE INTO round_coordinators (round_id, project_id, holder, epoch)
             VALUES (?1, ?2, ?3, 1)",
            params![round_id, project_id, leader],
        )?;
        tx.execute(
            "INSERT INTO round_coordinator_history (round_id, epoch, holder, previous_holder, reason)
             VALUES (?1, 1, ?2, NULL, 'Team Leader of the round')",
            params![round_id, leader],
        )?;
    }

    let tasks = {
        let mut statement = tx.prepare(
            "SELECT id, creator_member_id, assignee_member_id, title, description, status, plan,
                    created_at, updated_at
             FROM team_tasks WHERE team_id = ?1 ORDER BY created_at, id",
        )?;
        statement
            .query_map([team_id], |row| {
                Ok(LegacyTask {
                    id: row.get(0)?,
                    creator_member_id: row.get(1)?,
                    assignee_member_id: row.get(2)?,
                    title: row.get(3)?,
                    description: row.get(4)?,
                    status: row.get(5)?,
                    plan: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
    };

    for task in &tasks {
        let dependencies: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT dependency_id FROM team_task_dependencies WHERE task_id = ?1
                 ORDER BY dependency_id",
            )?;
            statement
                .query_map([&task.id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let unmet: i64 = tx.query_row(
            "SELECT COUNT(*) FROM team_task_dependencies d
             JOIN team_tasks t ON t.id = d.dependency_id
             WHERE d.task_id = ?1 AND t.status != 'accepted'",
            [&task.id],
            |row| row.get(0),
        )?;
        let waiting = match &task.assignee_member_id {
            Some(member) => tx
                .query_row(
                    "SELECT 1 FROM experiment_waits
                     WHERE team_id = ?1 AND owner_member_id = ?2 AND state = 'open' LIMIT 1",
                    params![team_id, member],
                    |_| Ok(()),
                )
                .optional()?
                .is_some(),
            None => false,
        };
        let mirrored = mirror_status(&task.status, unmet == 0, waiting);
        let created_by = conversation_of(&task.creator_member_id)?;
        let (round_id, research_id) = match &round {
            Some((round_id, research_id)) => (Some(round_id.clone()), Some(research_id.clone())),
            None => (None, None),
        };

        let existing: Option<(String, String, String, Option<String>)> = tx
            .query_row(
                "SELECT origin, title, description, plan FROM work_items WHERE id = ?1",
                [&task.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let previous_dependencies: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT dependency_id FROM work_dependencies WHERE task_id = ?1
                 ORDER BY dependency_id",
            )?;
            statement
                .query_map([&task.id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        match existing {
            None => {
                tx.execute(
                    "INSERT INTO work_items
                       (id, project_id, research_id, round_id, team_id, origin, title, description,
                        plan, stage, condition, condition_reason, review_kind, lifecycle,
                        closed_reason, acceptance, created_by, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'legacy_team', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                             ?14, ?15, ?16, ?17, ?18)",
                    params![
                        task.id,
                        project_id,
                        research_id,
                        round_id,
                        team_id,
                        task.title,
                        task.description,
                        task.plan,
                        mirrored.stage.as_str(),
                        mirrored.condition.as_str(),
                        mirrored.condition_reason,
                        mirrored.review_kind.map(ReviewKind::as_str),
                        mirrored.lifecycle.as_str(),
                        mirrored.closed_reason,
                        mirrored.acceptance.as_str(),
                        created_by,
                        task.created_at,
                        task.updated_at,
                    ],
                )?;
            }
            Some((origin, title, description, plan)) if origin == "legacy_team" => {
                let plan_changed =
                    title != task.title || description != task.description || plan != task.plan;
                tx.execute(
                    "UPDATE work_items SET project_id = ?2, research_id = ?3, round_id = ?4,
                       team_id = ?5, title = ?6, description = ?7, plan = ?8, stage = ?9,
                       condition = ?10, condition_reason = ?11, review_kind = ?12,
                       lifecycle = ?13, closed_reason = ?14, acceptance = ?15, updated_at = ?16,
                       revision = revision + ?17
                     WHERE id = ?1",
                    params![
                        task.id,
                        project_id,
                        research_id,
                        round_id,
                        team_id,
                        task.title,
                        task.description,
                        task.plan,
                        mirrored.stage.as_str(),
                        mirrored.condition.as_str(),
                        mirrored.condition_reason,
                        mirrored.review_kind.map(ReviewKind::as_str),
                        mirrored.lifecycle.as_str(),
                        mirrored.closed_reason,
                        mirrored.acceptance.as_str(),
                        task.updated_at,
                        i64::from(plan_changed || previous_dependencies != dependencies),
                    ],
                )?;
            }
            // Never overwrite native work.
            Some(_) => continue,
        }

        if previous_dependencies != dependencies {
            tx.execute(
                "DELETE FROM work_dependencies WHERE task_id = ?1",
                [&task.id],
            )?;
            for dependency in &dependencies {
                tx.execute(
                    "INSERT OR IGNORE INTO work_dependencies (task_id, dependency_id) VALUES (?1, ?2)",
                    params![task.id, dependency],
                )?;
            }
        }

        // The executing Session follows the legacy assignee; earlier
        // assignments are kept as history.
        let assignee = match &task.assignee_member_id {
            Some(member) => {
                conversation_of(member)?.map(|conversation| (member.clone(), conversation))
            }
            None => None,
        };
        let open = open_assignment(tx, &task.id)?;
        match (&open, &assignee) {
            (Some(open), Some((_, conversation))) if open.conversation_id == *conversation => {}
            (open, assignee) => {
                if let Some(open) = open {
                    tx.execute(
                        "UPDATE work_assignments SET ended_at = CURRENT_TIMESTAMP, end_reason = ?2
                         WHERE id = ?1",
                        params![
                            open.id,
                            if assignee.is_some() {
                                "reassigned"
                            } else {
                                "unassigned"
                            }
                        ],
                    )?;
                }
                if let Some((member, conversation)) = assignee {
                    tx.execute(
                        "INSERT INTO work_assignments
                           (id, task_id, conversation_id, member_id, assigned_by)
                         VALUES (?1, ?2, ?3, ?4, 'team')",
                        params![new_id(), task.id, conversation, member],
                    )?;
                }
            }
        }
    }

    // Attempts: the same ids, so a result or message that names an attempt
    // keeps naming it.
    let attempts = {
        let mut statement = tx.prepare(
            "SELECT id, task_id, member_id, run_id, status, failure_kind, error, created_at,
                    updated_at, completed_at
             FROM team_task_attempts WHERE team_id = ?1",
        )?;
        statement
            .query_map([team_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (
        id,
        task_id,
        member_id,
        run_id,
        status,
        kind,
        error,
        created_at,
        updated_at,
        completed_at,
    ) in attempts
    {
        let owner: Option<String> = tx
            .query_row(
                "SELECT origin FROM work_items WHERE id = ?1",
                [&task_id],
                |row| row.get(0),
            )
            .optional()?;
        if owner.as_deref() != Some("legacy_team") {
            continue;
        }
        let conversation = conversation_of(&member_id)?;
        let assignment = open_assignment(tx, &task_id)?
            .filter(|a| Some(&a.conversation_id) == conversation.as_ref())
            .map(|a| a.id);
        tx.execute(
            "INSERT INTO work_attempts
               (id, task_id, assignment_id, conversation_id, run_id, status, failure_kind, error,
                created_at, updated_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, status = excluded.status,
               failure_kind = excluded.failure_kind, error = excluded.error,
               updated_at = excluded.updated_at, completed_at = excluded.completed_at",
            params![
                id,
                task_id,
                assignment,
                conversation,
                run_id,
                status,
                kind,
                error,
                created_at,
                updated_at,
                completed_at,
            ],
        )?;
    }
    Ok(Some(project_id))
}
