//! Commands on native work (ADR 0215). Every command re-reads the authority it
//! needs from the database inside its own transaction: the item's revision and
//! stage, the round coordinator's holder and epoch, the open assignment. Nothing
//! is trusted from a cached role or an earlier read.

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::*;

const REQUEST_ID_CHARS: usize = 128;

/// What a command needs its actor to be.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Need {
    /// The researcher, or the round's current coordinator.
    Coordination,
    /// As above, or the Session currently assigned to the task.
    Execution,
}

fn text_ok(value: &str, max: usize, what: &'static str) -> Result<(), WorkError> {
    if value.chars().count() > max {
        return Err(WorkError::Invalid(what));
    }
    Ok(())
}

fn request_id(value: Option<&str>) -> Result<Option<String>, WorkError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > REQUEST_ID_CHARS
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
    {
        return Err(WorkError::Invalid("invalid client request id"));
    }
    Ok(Some(value.to_owned()))
}

/// The research question of a round, if the round is in this Project.
fn round_research(
    tx: &Transaction<'_>,
    project_id: &str,
    round_id: &str,
) -> Result<String, WorkError> {
    tx.query_row(
        "SELECT r.research_id FROM research_rounds r
         JOIN research_questions q ON q.id = r.research_id
         WHERE r.id = ?1 AND q.project_id = ?2",
        params![round_id, project_id],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .ok_or(WorkError::Invalid(
        "the round was not found in this Project",
    ))
}

/// A round is *approved for execution* once the researcher requested it (a
/// round exists only after an explicit request pinning a brief revision) and
/// its question is still open: an archived or resolved question stops new
/// attempts without touching history.
fn round_executable(
    tx: &Transaction<'_>,
    project_id: &str,
    round_id: &str,
) -> Result<(), WorkError> {
    let open: bool = tx
        .query_row(
            "SELECT q.archived = 0 AND q.status = 'open' FROM research_rounds r
             JOIN research_questions q ON q.id = r.research_id
             WHERE r.id = ?1 AND q.project_id = ?2",
            params![round_id, project_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(WorkError::Invalid(
            "the round was not found in this Project",
        ))?;
    if !open {
        return Err(WorkError::NoApprovedRound);
    }
    Ok(())
}

fn question_in_project(
    tx: &Transaction<'_>,
    project_id: &str,
    research_id: &str,
) -> Result<(), WorkError> {
    tx.query_row(
        "SELECT 1 FROM research_questions WHERE id = ?1 AND project_id = ?2",
        params![research_id, project_id],
        |_| Ok(()),
    )
    .optional()?
    .ok_or(WorkError::Invalid(
        "the research question was not found in this Project",
    ))
}

fn session_in_project(
    tx: &Transaction<'_>,
    project_id: &str,
    conversation_id: &str,
) -> Result<(), WorkError> {
    tx.query_row(
        "SELECT 1 FROM conversations
         WHERE id = ?1 AND project_id = ?2 AND internal_revision = 0",
        params![conversation_id, project_id],
        |_| Ok(()),
    )
    .optional()?
    .ok_or(WorkError::Invalid(
        "the Session was not found in this Project",
    ))
}

/// Whether a query keyed by `(id, project_id)` finds a row.
fn exists_in_project(
    tx: &Connection,
    sql: &str,
    project_id: &str,
    id: &str,
) -> Result<bool, WorkError> {
    Ok(tx
        .query_row(sql, params![id, project_id], |_| Ok(()))
        .optional()?
        .is_some())
}

/// A reference to a record is accepted only if the record exists in this
/// Project; another Project's record reads exactly like a missing one.
pub(crate) fn validate_reference(
    tx: &Connection,
    project_id: &str,
    kind: &str,
    ref_id: &str,
) -> Result<(), WorkError> {
    const EXPERIMENT: &str = "SELECT 1 FROM experiments WHERE id = ?1 AND project_id = ?2";
    const CONVERSATION: &str =
        "SELECT 1 FROM conversations WHERE id = ?1 AND project_id = ?2 AND internal_revision = 0";
    let found = match kind {
        "experiment" => exists_in_project(tx, EXPERIMENT, project_id, ref_id)?,
        // `experiment_id/path`
        "artifact" => {
            let (id, path) = ref_id.split_once('/').unwrap_or((ref_id, ""));
            relative_path_ok(path) && exists_in_project(tx, EXPERIMENT, project_id, id)?
        }
        "finding" => exists_in_project(
            tx,
            "SELECT 1 FROM research_findings f JOIN research_questions q ON q.id = f.research_id
             WHERE f.id = ?1 AND q.project_id = ?2",
            project_id,
            ref_id,
        )?,
        "research" => exists_in_project(
            tx,
            "SELECT 1 FROM research_questions WHERE id = ?1 AND project_id = ?2",
            project_id,
            ref_id,
        )?,
        "round" => exists_in_project(
            tx,
            "SELECT 1 FROM research_rounds r JOIN research_questions q ON q.id = r.research_id
             WHERE r.id = ?1 AND q.project_id = ?2",
            project_id,
            ref_id,
        )?,
        "import" => exists_in_project(
            tx,
            "SELECT 1 FROM research_imports i JOIN research_questions q ON q.id = i.research_id
             WHERE i.id = ?1 AND q.project_id = ?2",
            project_id,
            ref_id,
        )?,
        "session" => exists_in_project(tx, CONVERSATION, project_id, ref_id)?,
        "session_turn" => {
            let (id, turn) = ref_id.split_once('/').unwrap_or((ref_id, ""));
            !turn.is_empty()
                && turn
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
                && exists_in_project(tx, CONVERSATION, project_id, id)?
        }
        "team" => exists_in_project(
            tx,
            "SELECT 1 FROM teams WHERE id = ?1 AND project_id = ?2",
            project_id,
            ref_id,
        )?,
        // Conversation records live in a sibling store whose tables may not
        // exist where only the work store is installed.
        "thread" | "message" | "channel" => {
            let (table, owner) = match kind {
                "thread" => ("channel_threads", "id"),
                "message" => ("channel_messages", "id"),
                _ => ("channels", "id"),
            };
            let present: i64 = tx.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )?;
            present > 0
                && exists_in_project(
                    tx,
                    &format!("SELECT 1 FROM {table} WHERE {owner} = ?1 AND project_id = ?2"),
                    project_id,
                    ref_id,
                )?
        }
        "work" | "team_task" => exists_in_project(
            tx,
            "SELECT 1 FROM work_items WHERE id = ?1 AND project_id = ?2",
            project_id,
            ref_id,
        )?,
        // A Project-relative path; its existence is a filesystem question the
        // reader answers when it resolves the reference.
        "file" => relative_path_ok(ref_id),
        _ => return Err(WorkError::Invalid("unknown reference kind")),
    };
    if !found {
        return Err(WorkError::Invalid(
            "the referenced record was not found in this Project",
        ));
    }
    Ok(())
}

/// A Project-relative path with no empty, `.`, or `..` component.
fn relative_path_ok(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Re-reads the persisted authority and compares it with what the actor claims.
fn authorize(
    tx: &Transaction<'_>,
    item: &WorkItem,
    actor: &Actor,
    need: Need,
) -> Result<(), WorkError> {
    match actor {
        Actor::Researcher => Ok(()),
        Actor::Coordinator(auth) => {
            let Some(round_id) = item.round_id.as_deref() else {
                return Err(WorkError::Invalid(
                    "work without an approved round can only be changed by the researcher",
                ));
            };
            check_coordinator(tx, &item.project_id, round_id, auth)
        }
        Actor::Executor { conversation_id } => {
            if need != Need::Execution {
                return Err(WorkError::Invalid("an executor cannot coordinate"));
            }
            let assigned = open_assignment(tx, &item.id)?;
            if assigned.as_ref().map(|a| a.conversation_id.as_str()) == Some(conversation_id) {
                Ok(())
            } else {
                Err(WorkError::NotAssigned)
            }
        }
    }
}

fn check_coordinator(
    tx: &Transaction<'_>,
    project_id: &str,
    round_id: &str,
    auth: &CoordinatorAuth,
) -> Result<(), WorkError> {
    if auth.round_id != round_id {
        return Err(WorkError::Invalid(
            "the coordinator authority is for a different round",
        ));
    }
    let current = coordinator_of(tx, project_id, round_id)?.ok_or(WorkError::NoCoordinator)?;
    if current.holder != auth.holder || current.epoch != auth.epoch {
        return Err(WorkError::StaleCoordinator {
            current_epoch: current.epoch,
        });
    }
    Ok(())
}

fn actor_name(actor: &Actor) -> String {
    match actor {
        Actor::Researcher => "researcher".to_owned(),
        Actor::Coordinator(auth) => auth.holder.clone(),
        Actor::Executor { conversation_id } => conversation_id.clone(),
    }
}

fn native(item: &WorkItem) -> Result<(), WorkError> {
    if item.origin != WorkOrigin::Native {
        return Err(WorkError::LegacyOwned);
    }
    Ok(())
}

fn active(item: &WorkItem) -> Result<(), WorkError> {
    if item.lifecycle != WorkLifecycle::Active {
        return Err(WorkError::Closed(item.lifecycle.as_str()));
    }
    Ok(())
}

fn expect_revision(item: &WorkItem, expected: u64) -> Result<(), WorkError> {
    if item.revision != expected {
        return Err(WorkError::Stale {
            current: item.revision,
        });
    }
    Ok(())
}

/// A command that carries a state-revision precondition is refused if the item
/// changed in any way since the caller looked.
fn expect_state(item: &WorkItem, ctx: &Ctx<'_>) -> Result<(), WorkError> {
    match ctx.expected_state_revision {
        Some(expected) if expected != item.state_revision => Err(WorkError::StaleState {
            current: item.state_revision,
        }),
        _ => Ok(()),
    }
}

/// Whether `from` can reach `target` through dependency edges (a cycle check).
fn reaches(tx: &Transaction<'_>, from: &str, target: &str) -> Result<bool, WorkError> {
    let mut stack = vec![from.to_owned()];
    let mut seen = std::collections::HashSet::new();
    while let Some(current) = stack.pop() {
        if current == target {
            return Ok(true);
        }
        if !seen.insert(current.clone()) {
            continue;
        }
        let mut statement =
            tx.prepare("SELECT dependency_id FROM work_dependencies WHERE task_id = ?1")?;
        let next = statement
            .query_map([&current], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        stack.extend(next);
    }
    Ok(false)
}

fn dependencies_accepted(tx: &Transaction<'_>, task_id: &str) -> Result<bool, WorkError> {
    let unmet: i64 = tx.query_row(
        "SELECT COUNT(*) FROM work_dependencies d
         LEFT JOIN work_items w ON w.id = d.dependency_id
         WHERE d.task_id = ?1 AND (w.id IS NULL OR w.acceptance != 'accepted')",
        [task_id],
        |row| row.get(0),
    )?;
    Ok(unmet == 0)
}

/// A dependency that was closed without being accepted blocks its dependents
/// until the plan changes; one that is accepted (or still pending) does not.
fn closed_dependency(tx: &Transaction<'_>, task_id: &str) -> Result<Option<String>, WorkError> {
    Ok(tx
        .query_row(
            "SELECT d.dependency_id FROM work_dependencies d
             JOIN work_items w ON w.id = d.dependency_id
             WHERE d.task_id = ?1 AND w.lifecycle != 'active' AND w.acceptance != 'accepted'
             ORDER BY d.dependency_id LIMIT 1",
            [task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

const AUTO_BLOCK: &str = "dependency closed: ";

/// Recomputes eligibility for a Project's native, active, not-yet-started work:
/// dependencies decide `planned` versus `ready`, and a closed dependency blocks.
/// A condition the researcher or coordinator set (paused, blocked) is never
/// touched; it is independent of eligibility. Authorization and capacity are
/// checked again at dispatch; this only says whether the work may be considered.
pub(crate) fn refresh_readiness(tx: &Transaction<'_>, project_id: &str) -> Result<(), WorkError> {
    let mut statement = tx.prepare(
        "SELECT id, stage, condition, condition_reason FROM work_items
         WHERE project_id = ?1 AND origin = 'native' AND lifecycle = 'active'
           AND stage IN ('planned', 'ready')",
    )?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, stage, condition, reason) in rows {
        let auto_blocked =
            condition == "blocked" && reason.as_deref().is_some_and(|r| r.starts_with(AUTO_BLOCK));
        if let Some(closed) = closed_dependency(tx, &id)? {
            if condition == "none" || auto_blocked {
                tx.execute(
                    "UPDATE work_items SET condition = 'blocked', condition_reason = ?2,
                       stage = 'planned', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                    params![id, format!("{AUTO_BLOCK}{closed}")],
                )?;
            }
            continue;
        }
        if auto_blocked {
            tx.execute(
                "UPDATE work_items SET condition = 'none', condition_reason = NULL,
                   updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [&id],
            )?;
        }
        // Work that is waiting on a person (a plan sent back, a pause) is not
        // promoted to ready until that condition is lifted.
        let still_conditioned = condition != "none" && !auto_blocked;
        let wanted =
            if dependencies_accepted(tx, &id)? && !(still_conditioned && stage == "planned") {
                "ready"
            } else {
                "planned"
            };
        if wanted != stage {
            tx.execute(
                "UPDATE work_items SET stage = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![id, wanted],
            )?;
        }
    }
    Ok(())
}

/// Entering `executing` is only possible through `begin_attempt`, and `done`
/// only through `review`; every other path is listed here.
fn stage_allowed(from: WorkStage, to: WorkStage) -> bool {
    use WorkStage::*;
    matches!(
        (from, to),
        (Planned, Ready)
            | (Executing, Ready)
            | (Executing, Analyzing)
            | (Executing, Review)
            | (Analyzing, Review)
            | (Review, Ready)
    )
}

fn bump(tx: &Transaction<'_>, id: &str) -> Result<(), WorkError> {
    tx.execute(
        "UPDATE work_items SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

fn add_dependency(
    tx: &Transaction<'_>,
    project_id: &str,
    task_id: &str,
    dependency: &str,
) -> Result<(), WorkError> {
    if dependency == task_id {
        return Err(WorkError::DependencyCycle);
    }
    let target = load_item(tx, project_id, dependency)?;
    if target.lifecycle != WorkLifecycle::Active {
        return Err(WorkError::Invalid("a dependency must be active work"));
    }
    if reaches(tx, dependency, task_id)? {
        return Err(WorkError::DependencyCycle);
    }
    tx.execute(
        "INSERT OR IGNORE INTO work_dependencies (task_id, dependency_id) VALUES (?1, ?2)",
        params![task_id, dependency],
    )?;
    Ok(())
}

fn has_open_attempt(tx: &Transaction<'_>, task_id: &str) -> Result<bool, WorkError> {
    Ok(attempts_of(tx, task_id)?.iter().any(|a| is_open(a.status)))
}

/// Everything a review looked at, as `attempt:<id>:<status>` and
/// `<kind>:<id>@<revision>`, so a later change to an input is detectable.
fn review_inputs(tx: &Transaction<'_>, task_id: &str) -> Result<Vec<String>, WorkError> {
    let mut inputs: Vec<String> = attempts_of(tx, task_id)?
        .iter()
        .map(|a| format!("attempt:{}:{}", a.id, a.status.as_str()))
        .collect();
    inputs.extend(results_of(tx, task_id)?.iter().map(|r| {
        format!(
            "{}:{}@{}",
            r.kind,
            r.ref_id,
            r.revision.as_deref().unwrap_or("-")
        )
    }));
    Ok(inputs)
}

impl WorkStore {
    /// Creates native work. A repeated `client_request_id` returns the original
    /// (`created = false`), so a replayed request never makes a second task.
    /// Work may be a candidate (no round) or belong to an approved round; only
    /// the researcher, or the round's current coordinator, may create it there.
    pub fn create(
        &self,
        project_id: &str,
        new: NewWork<'_>,
        actor: &Actor,
    ) -> Result<(WorkItem, bool), WorkError> {
        let title = new.title.trim();
        if title.is_empty() {
            return Err(WorkError::Invalid("a title is required"));
        }
        text_ok(title, MAX_TITLE_CHARS, "the title is too long")?;
        text_ok(
            new.description,
            MAX_DESCRIPTION_CHARS,
            "the description is too long",
        )?;
        if let Some(plan) = new.plan {
            text_ok(plan, MAX_PLAN_CHARS, "the plan is too long")?;
        }
        if let Some(created_by) = new.created_by {
            text_ok(created_by, MAX_ID_CHARS, "the creator is too long")?;
        }
        if new.dependencies.len() > MAX_DEPENDENCIES {
            return Err(WorkError::Invalid("too many dependencies"));
        }
        let request = request_id(new.client_request_id)?;
        self.write(|tx| {
            // Authority first: a replay is not a way to read someone's work.
            let target_round = new.round_id;
            match actor {
                Actor::Researcher => {}
                Actor::Coordinator(auth) => {
                    let round_id = target_round.ok_or(WorkError::Invalid(
                        "work without an approved round can only be created by the researcher",
                    ))?;
                    check_coordinator(tx, project_id, round_id, auth)?;
                }
                Actor::Executor { .. } => {
                    return Err(WorkError::Invalid("an executor cannot create planned work"));
                }
            }
            if let Some(request) = &request
                && let Some(existing) = tx
                    .query_row(
                        &format!("{ITEM_SELECT} WHERE project_id = ?1 AND client_request_id = ?2"),
                        params![project_id, request],
                        item_from_row,
                    )
                    .optional()?
            {
                if existing.round_id.as_deref() != target_round || existing.title != title {
                    return Err(WorkError::Invalid(
                        "this request id was already used for different work",
                    ));
                }
                return Ok(((hydrate(tx, existing)?, false), None));
            }
            let (research_id, round_id) = match target_round {
                Some(round_id) => {
                    let research = round_research(tx, project_id, round_id)?;
                    if new.research_id.is_some_and(|given| given != research) {
                        return Err(WorkError::Invalid("the round belongs to another question"));
                    }
                    (Some(research), Some(round_id.to_owned()))
                }
                None => {
                    if let Some(research_id) = new.research_id {
                        question_in_project(tx, project_id, research_id)?;
                    }
                    (new.research_id.map(str::to_owned), None)
                }
            };
            let derived = match new.derived_from {
                Some((kind, id)) => {
                    if !matches!(kind, "finding" | "work" | "thread" | "message") {
                        return Err(WorkError::Invalid(
                            "work derives from a finding, other work, a Thread, or a message",
                        ));
                    }
                    validate_reference(tx, project_id, kind, id)?;
                    Some((kind, id))
                }
                None => None,
            };
            let id = new_id();
            tx.execute(
                "INSERT INTO work_items
                   (id, project_id, research_id, round_id, origin, kind, title, description, plan,
                    stage, priority, created_by, client_request_id, derived_from_kind,
                    derived_from_id)
                 VALUES (?1, ?2, ?3, ?4, 'native', ?5, ?6, ?7, ?8, 'planned', ?9, ?10, ?11, ?12, ?13)",
                params![
                    id,
                    project_id,
                    research_id,
                    round_id,
                    new.kind.unwrap_or(WorkKind::Other).as_str(),
                    title,
                    new.description,
                    new.plan,
                    new.priority,
                    new.created_by,
                    request,
                    derived.map(|(kind, _)| kind),
                    derived.map(|(_, id)| id),
                ],
            )?;
            for dependency in new.dependencies {
                add_dependency(tx, project_id, &id, dependency)?;
            }
            refresh_readiness(tx, project_id)?;
            let item = load_item(tx, project_id, &id)?;
            Ok((
                (item, true),
                Some((project_id.to_owned(), id, Change::Created)),
            ))
        })
    }

    /// A revision-checked change to the plan: text, priority, dependencies.
    /// Authority is checked before the revision, so a stale or foreign caller
    /// learns nothing about the item. A stale revision is refused with the
    /// current one, so two planners can never silently overwrite each other.
    pub fn update_plan<'a>(
        &self,
        project_id: &str,
        id: &str,
        expected_revision: u64,
        patch: PlanPatch,
        ctx: impl Into<Ctx<'a>>,
    ) -> Result<WorkItem, WorkError> {
        let ctx = ctx.into();
        let actor = ctx.actor;
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            authorize(tx, &item, actor, Need::Coordination)?;
            expect_revision(&item, expected_revision)?;
            expect_state(&item, &ctx)?;
            if item.stage == WorkStage::Done {
                return Err(WorkError::Closed("done"));
            }
            if patch.add_dependencies.len() > MAX_DEPENDENCIES
                || patch.remove_dependencies.len() > MAX_DEPENDENCIES
            {
                return Err(WorkError::Invalid("too many dependencies"));
            }
            let title = match &patch.title {
                Some(title) => {
                    let title = title.trim();
                    if title.is_empty() {
                        return Err(WorkError::Invalid("a title is required"));
                    }
                    text_ok(title, MAX_TITLE_CHARS, "the title is too long")?;
                    title.to_owned()
                }
                None => item.title.clone(),
            };
            let description = patch
                .description
                .clone()
                .unwrap_or(item.description.clone());
            text_ok(
                &description,
                MAX_DESCRIPTION_CHARS,
                "the description is too long",
            )?;
            let plan = match &patch.plan {
                Some(plan) if plan.trim().is_empty() => None,
                Some(plan) => Some(plan.clone()),
                None => item.plan.clone(),
            };
            if let Some(plan) = &plan {
                text_ok(plan, MAX_PLAN_CHARS, "the plan is too long")?;
            }
            let priority = patch.priority.unwrap_or(item.priority);
            let kind = patch.kind.unwrap_or(item.kind);
            let mut changed = title != item.title
                || description != item.description
                || plan != item.plan
                || priority != item.priority
                || kind != item.kind;
            for removed in &patch.remove_dependencies {
                changed |= tx.execute(
                    "DELETE FROM work_dependencies WHERE task_id = ?1 AND dependency_id = ?2",
                    params![id, removed],
                )? > 0;
            }
            for added in &patch.add_dependencies {
                // Against the dependencies as they are now, after any removal.
                let present: bool = tx
                    .query_row(
                        "SELECT 1 FROM work_dependencies WHERE task_id = ?1 AND dependency_id = ?2",
                        params![id, added],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if !present {
                    add_dependency(tx, project_id, id, added)?;
                    changed = true;
                }
            }
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM work_dependencies WHERE task_id = ?1",
                [id],
                |row| row.get(0),
            )?;
            if count as usize > MAX_DEPENDENCIES {
                return Err(WorkError::Invalid("too many dependencies"));
            }
            if !changed {
                return Ok((item, None));
            }
            tx.execute(
                "UPDATE work_items SET title = ?2, description = ?3, plan = ?4, priority = ?5,
                   kind = ?6 WHERE id = ?1",
                params![id, title, description, plan, priority, kind.as_str()],
            )?;
            bump(tx, id)?;
            refresh_readiness(tx, project_id)?;
            Ok((
                load_item(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Plan)),
            ))
        })
    }

    /// Attaches candidate work to an approved round. The round must be in the
    /// same Project and belong to the same question as the work (if it has one);
    /// the work must not already belong to another round. Repeating the link to
    /// the round it already has is a no-op whatever revision the caller holds.
    pub fn link_round(
        &self,
        project_id: &str,
        id: &str,
        expected_revision: u64,
        round_id: &str,
        actor: &Actor,
    ) -> Result<WorkItem, WorkError> {
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            let research = round_research(tx, project_id, round_id)?;
            match actor {
                Actor::Researcher => {}
                Actor::Coordinator(auth) => check_coordinator(tx, project_id, round_id, auth)?,
                Actor::Executor { .. } => {
                    return Err(WorkError::Invalid("an executor cannot approve work"));
                }
            }
            if item.round_id.as_deref() == Some(round_id) {
                return Ok((item, None));
            }
            if item.round_id.is_some() {
                return Err(WorkError::Invalid(
                    "the work already belongs to another round",
                ));
            }
            if item
                .research_id
                .as_deref()
                .is_some_and(|current| current != research)
            {
                return Err(WorkError::Invalid("the round belongs to another question"));
            }
            expect_revision(&item, expected_revision)?;
            tx.execute(
                "UPDATE work_items SET round_id = ?2, research_id = ?3 WHERE id = ?1",
                params![id, round_id, research],
            )?;
            bump(tx, id)?;
            Ok((
                load_item(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Plan)),
            ))
        })
    }

    /// Makes `conversation_id` the executing Session. The previous open
    /// assignment is closed with a reason; the task, its attempts, and its
    /// results are untouched. Refused while an attempt is still open, so a
    /// running attempt is never orphaned from its Session, and on finished work.
    pub fn assign<'a>(
        &self,
        project_id: &str,
        id: &str,
        conversation_id: &str,
        member_id: Option<&str>,
        reason: &str,
        ctx: impl Into<Ctx<'a>>,
    ) -> Result<Assignment, WorkError> {
        let ctx = ctx.into();
        text_ok(reason, MAX_REASON_CHARS, "the reason is too long")?;
        self.check_may_execute(project_id, conversation_id)?;
        if let Some(member_id) = member_id {
            text_ok(member_id, MAX_ID_CHARS, "the member id is too long")?;
        }
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            authorize(tx, &item, ctx.actor, Need::Coordination)?;
            expect_state(&item, &ctx)?;
            if item.stage == WorkStage::Done {
                return Err(WorkError::Closed("done"));
            }
            session_in_project(tx, project_id, conversation_id)?;
            if has_open_attempt(tx, id)? {
                return Err(WorkError::AttemptOpen);
            }
            if let Some(open) = open_assignment(tx, id)?
                && open.conversation_id == conversation_id
            {
                return Ok((open, None));
            }
            // A new executing Session counts against the round's executor limit.
            if let Some(round_id) = item.round_id.as_deref() {
                let policy = load_policy(tx, project_id, round_id)?;
                let already: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM work_assignments a JOIN work_items w ON w.id = a.task_id
                     WHERE w.project_id = ?1 AND w.round_id = ?2 AND a.ended_at IS NULL
                       AND w.lifecycle = 'active' AND a.conversation_id = ?3",
                    params![project_id, round_id, conversation_id],
                    |row| row.get(0),
                )?;
                let stats = round_stats(tx, project_id, round_id)?;
                if already == 0 && stats.executors >= policy.max_executors {
                    return Err(WorkError::BudgetExhausted("executors"));
                }
            }
            if let Some(open) = open_assignment(tx, id)? {
                tx.execute(
                    "UPDATE work_assignments SET ended_at = CURRENT_TIMESTAMP, end_reason = ?2
                     WHERE id = ?1",
                    params![
                        open.id,
                        if reason.is_empty() {
                            "reassigned"
                        } else {
                            reason
                        }
                    ],
                )?;
            }
            tx.execute(
                "INSERT INTO work_assignments (id, task_id, conversation_id, member_id, assigned_by)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![new_id(), id, conversation_id, member_id, actor_name(ctx.actor)],
            )?;
            tx.execute(
                "UPDATE work_items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id],
            )?;
            let created = open_assignment(tx, id)?.ok_or(WorkError::NotFound)?;
            Ok((
                created,
                Some((project_id.to_owned(), id.to_owned(), Change::Assignment)),
            ))
        })
    }

    /// Starts one execution attempt. Needs an approved, still-open round, an
    /// executing Session, eligible and unpaused work, accepted dependencies, and
    /// a current coordinator (or the researcher); it never overlaps another
    /// attempt of the same task. A repeated `request_key` returns the attempt it
    /// already made instead of making another, so a replayed dispatch cannot
    /// launch twice.
    pub fn begin_attempt<'a>(
        &self,
        project_id: &str,
        id: &str,
        request_key: Option<&str>,
        ctx: impl Into<Ctx<'a>>,
    ) -> Result<Attempt, WorkError> {
        let ctx = ctx.into();
        let key = request_id(request_key)?;
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            authorize(tx, &item, ctx.actor, Need::Coordination)?;
            if let Some(key) = &key
                && let Some(existing) = tx
                    .query_row(
                        &format!("{ATTEMPT_SELECT} WHERE task_id = ?1 AND request_key = ?2"),
                        params![id, key],
                        attempt_from_row,
                    )
                    .optional()?
            {
                return Ok((existing, None));
            }
            expect_state(&item, &ctx)?;
            let round_id = item.round_id.as_deref().ok_or(WorkError::NoApprovedRound)?;
            round_executable(tx, project_id, round_id)?;
            if !matches!(item.stage, WorkStage::Ready | WorkStage::Executing) {
                return Err(WorkError::InvalidTransition {
                    from: item.stage.as_str(),
                    to: WorkStage::Executing.as_str(),
                });
            }
            if matches!(
                item.condition,
                WorkCondition::Paused | WorkCondition::Blocked
            ) {
                return Err(WorkError::Invalid("the work is paused or blocked"));
            }
            if !dependencies_accepted(tx, id)? {
                return Err(WorkError::DependenciesUnmet);
            }
            if has_open_attempt(tx, id)? {
                return Err(WorkError::AttemptOpen);
            }
            let assignment = open_assignment(tx, id)?.ok_or(WorkError::NotAssigned)?;
            // What the researcher authorized the round to spend (ADR 0217).
            let policy = load_policy(tx, project_id, round_id)?;
            if policy.paused {
                return Err(WorkError::RoundPaused);
            }
            let stats = round_stats(tx, project_id, round_id)?;
            if stats.open_attempts >= policy.max_parallel_attempts {
                return Err(WorkError::BudgetExhausted("parallel attempts"));
            }
            if stats.total_attempts >= policy.max_attempts {
                return Err(WorkError::BudgetExhausted("attempts"));
            }
            let attempt_id = new_id();
            tx.execute(
                "INSERT INTO work_attempts
                   (id, task_id, assignment_id, conversation_id, status, request_key)
                 VALUES (?1, ?2, ?3, ?4, 'queued', ?5)",
                params![
                    attempt_id,
                    id,
                    assignment.id,
                    assignment.conversation_id,
                    key
                ],
            )?;
            tx.execute(
                "UPDATE work_items SET stage = 'executing', condition = 'none',
                   condition_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id],
            )?;
            let attempt = load_attempt(tx, project_id, &attempt_id)?;
            Ok((
                attempt,
                Some((project_id.to_owned(), id.to_owned(), Change::Attempt)),
            ))
        })
    }

    /// Records the run that is executing an attempt. Only the executing Session
    /// (or the researcher/coordinator) may bind, only a queued attempt starts,
    /// and a bound run is never replaced by a different one.
    pub fn bind_attempt_run(
        &self,
        project_id: &str,
        attempt_id: &str,
        run_id: &str,
        actor: &Actor,
    ) -> Result<Attempt, WorkError> {
        self.write(|tx| {
            let attempt = load_attempt(tx, project_id, attempt_id)?;
            let item = load_item(tx, project_id, &attempt.task_id)?;
            native(&item)?;
            active(&item)?;
            authorize(tx, &item, actor, Need::Execution)?;
            text_ok(run_id, MAX_ID_CHARS, "the run id is too long")?;
            if attempt.run_id.as_deref() == Some(run_id) {
                return Ok((attempt, None));
            }
            if attempt.status != AttemptStatus::Queued || attempt.run_id.is_some() {
                return Err(WorkError::Invalid(
                    "the attempt already has a run or is not queued",
                ));
            }
            tx.execute(
                "UPDATE work_attempts SET run_id = ?2, status = 'running',
                   updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![attempt_id, run_id],
            )?;
            tx.execute(
                "UPDATE work_items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [&attempt.task_id],
            )?;
            Ok((
                load_attempt(tx, project_id, attempt_id)?,
                Some((project_id.to_owned(), attempt.task_id, Change::Attempt)),
            ))
        })
    }

    /// Closes an attempt. A failed attempt is history, not the end of the task:
    /// the task stays at `executing`, ready for a retry under a new attempt.
    /// Repeating the same outcome on an already-closed attempt is a no-op.
    pub fn finish_attempt(
        &self,
        project_id: &str,
        attempt_id: &str,
        outcome: AttemptOutcome,
        actor: &Actor,
    ) -> Result<Attempt, WorkError> {
        self.write(|tx| {
            let attempt = load_attempt(tx, project_id, attempt_id)?;
            let item = load_item(tx, project_id, &attempt.task_id)?;
            native(&item)?;
            authorize(tx, &item, actor, Need::Execution)?;
            let (status, kind, error) = match outcome {
                AttemptOutcome::Completed => (AttemptStatus::Completed, None, None),
                AttemptOutcome::Failed { kind, error } => (AttemptStatus::Failed, kind, error),
                AttemptOutcome::Cancelled => (AttemptStatus::Cancelled, None, None),
            };
            if !is_open(attempt.status) {
                if attempt.status == status {
                    return Ok((attempt, None));
                }
                return Err(WorkError::Invalid("the attempt is already closed"));
            }
            if let Some(error) = &error {
                text_ok(error, MAX_REASON_CHARS, "the error is too long")?;
            }
            if let Some(kind) = &kind {
                text_ok(kind, 64, "the failure kind is too long")?;
            }
            if status == AttemptStatus::Completed && attempt.status == AttemptStatus::Queued {
                return Err(WorkError::Invalid(
                    "an attempt that never started cannot complete",
                ));
            }
            tx.execute(
                "UPDATE work_attempts SET status = ?2, failure_kind = ?3, error = ?4,
                   completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![attempt_id, status.as_str(), kind, error],
            )?;
            tx.execute(
                "UPDATE work_items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [&attempt.task_id],
            )?;
            Ok((
                load_attempt(tx, project_id, attempt_id)?,
                Some((project_id.to_owned(), attempt.task_id, Change::Attempt)),
            ))
        })
    }

    /// Moves work between stages along the allowed paths. Entering `executing`
    /// is only possible through [`WorkStore::begin_attempt`] and reaching `done`
    /// only through [`WorkStore::review`], so neither is fabricated by a stage
    /// change. The caller names the stage it is moving *from*; a different
    /// current stage is a stale command.
    pub fn advance<'a>(
        &self,
        project_id: &str,
        id: &str,
        from: WorkStage,
        to: WorkStage,
        review_kind: Option<ReviewKind>,
        ctx: impl Into<Ctx<'a>>,
    ) -> Result<WorkItem, WorkError> {
        let ctx = ctx.into();
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            if item.stage != from {
                return Err(WorkError::InvalidTransition {
                    from: item.stage.as_str(),
                    to: to.as_str(),
                });
            }
            // A plan can be put up for approval before any attempt exists.
            let plan_review = to == WorkStage::Review
                && review_kind == Some(ReviewKind::Plan)
                && matches!(from, WorkStage::Planned | WorkStage::Ready);
            if plan_review
                && item
                    .plan
                    .as_deref()
                    .is_none_or(|plan| plan.trim().is_empty())
            {
                return Err(WorkError::Invalid("there is no plan to review"));
            }
            if !plan_review && !stage_allowed(from, to) {
                return Err(WorkError::InvalidTransition {
                    from: from.as_str(),
                    to: to.as_str(),
                });
            }
            let need = if matches!(to, WorkStage::Analyzing | WorkStage::Review)
                && from == WorkStage::Executing
            {
                Need::Execution
            } else {
                Need::Coordination
            };
            authorize(tx, &item, ctx.actor, need)?;
            expect_state(&item, &ctx)?;
            if item.round_id.is_none() && to != WorkStage::Planned && to != WorkStage::Ready {
                return Err(WorkError::NoApprovedRound);
            }
            if to == WorkStage::Ready && !dependencies_accepted(tx, id)? {
                return Err(WorkError::DependenciesUnmet);
            }
            // Work that leaves the executor's hands needs its attempt finished.
            let attempts = attempts_of(tx, id)?;
            if matches!(to, WorkStage::Planned | WorkStage::Ready)
                && attempts.iter().any(|a| is_open(a.status))
            {
                return Err(WorkError::AttemptOpen);
            }
            if matches!(to, WorkStage::Analyzing | WorkStage::Review)
                && from == WorkStage::Executing
            {
                if attempts.iter().any(|a| {
                    matches!(
                        a.status,
                        AttemptStatus::Queued | AttemptStatus::Running | AttemptStatus::NeedsReport
                    )
                }) {
                    return Err(WorkError::AttemptOpen);
                }
                // Something must have been done before it can be analyzed or reviewed.
                let produced = attempts.iter().any(|a| {
                    matches!(
                        a.status,
                        AttemptStatus::Completed | AttemptStatus::ResultSubmitted
                    )
                }) || !results_of(tx, id)?.is_empty();
                if !produced {
                    return Err(WorkError::Invalid(
                        "there is nothing to analyze or review: no completed attempt or result",
                    ));
                }
            }
            let kind = (to == WorkStage::Review).then(|| review_kind.unwrap_or(ReviewKind::Result));
            tx.execute(
                "UPDATE work_items SET stage = ?2, review_kind = ?3, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, to.as_str(), kind.map(ReviewKind::as_str)],
            )?;
            refresh_readiness(tx, project_id)?;
            Ok((
                load_item(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Stage)),
            ))
        })
    }

    /// Sets why work is not moving. The executing Session may report that it is
    /// `waiting` or needs input; pausing or blocking — and lifting a pause or a
    /// block, whoever set it — is coordination.
    pub fn set_condition<'a>(
        &self,
        project_id: &str,
        id: &str,
        condition: WorkCondition,
        reason: Option<&str>,
        ctx: impl Into<Ctx<'a>>,
    ) -> Result<WorkItem, WorkError> {
        let ctx = ctx.into();
        if let Some(reason) = reason {
            text_ok(reason, MAX_REASON_CHARS, "the reason is too long")?;
            if reason.starts_with(AUTO_BLOCK) {
                return Err(WorkError::Invalid("that reason prefix is reserved"));
            }
        }
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            let lifting = matches!(
                item.condition,
                WorkCondition::Paused | WorkCondition::Blocked
            );
            let need = if lifting
                || !matches!(
                    condition,
                    WorkCondition::Waiting | WorkCondition::NeedsInput | WorkCondition::None
                ) {
                Need::Coordination
            } else {
                Need::Execution
            };
            authorize(tx, &item, ctx.actor, need)?;
            expect_state(&item, &ctx)?;
            if item.stage == WorkStage::Done {
                return Err(WorkError::Closed("done"));
            }
            let reason = (condition != WorkCondition::None)
                .then(|| reason.filter(|r| !r.is_empty()))
                .flatten();
            if item.condition == condition && item.condition_reason.as_deref() == reason {
                return Ok((item, None));
            }
            tx.execute(
                "UPDATE work_items SET condition = ?2, condition_reason = ?3,
                   updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![id, condition.as_str(), reason],
            )?;
            refresh_readiness(tx, project_id)?;
            Ok((
                load_item(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Condition)),
            ))
        })
    }

    /// Records a review decision, with its reason and exactly what it looked
    /// at, and applies it. Accepting a *plan* sends the work on to be done
    /// (`ready`); accepting a result, code, validity, or evidence review moves
    /// it to `done` — including a valid negative result (`refuted`) — and ends
    /// the executor's assignment. Rejecting returns it to the executor (or to
    /// planning, for a plan). Acceptance, outcome, and exit status stay
    /// separate facts.
    pub fn review<'a>(
        &self,
        project_id: &str,
        id: &str,
        input: ReviewInput<'_>,
        ctx: impl Into<Ctx<'a>>,
    ) -> Result<WorkItem, WorkError> {
        let ctx = ctx.into();
        if let Some(reason) = input.reason {
            text_ok(reason, MAX_REASON_CHARS, "the reason is too long")?;
        }
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            authorize(tx, &item, ctx.actor, Need::Coordination)?;
            expect_state(&item, &ctx)?;
            if item.stage != WorkStage::Review {
                return Err(WorkError::InvalidTransition {
                    from: item.stage.as_str(),
                    to: WorkStage::Done.as_str(),
                });
            }
            let kind = item.review_kind.unwrap_or(ReviewKind::Result);
            let inputs = review_inputs(tx, id)?;
            tx.execute(
                "INSERT INTO work_reviews (id, task_id, kind, accepted, outcome, reviewer, reason, inputs)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    new_id(),
                    id,
                    kind.as_str(),
                    input.accept,
                    input.outcome.as_str(),
                    actor_name(ctx.actor),
                    input.reason.filter(|r| !r.is_empty()),
                    serde_json::to_string(&inputs)?,
                ],
            )?;
            match (kind, input.accept) {
                (ReviewKind::Plan, true) => {
                    tx.execute(
                        "UPDATE work_items SET stage = 'ready', review_kind = NULL,
                           updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                        [id],
                    )?;
                }
                (ReviewKind::Plan, false) => {
                    tx.execute(
                        "UPDATE work_items SET stage = 'planned', review_kind = NULL,
                           condition = 'needs_input', condition_reason = 'plan changes requested',
                           updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                        [id],
                    )?;
                }
                (_, true) => {
                    tx.execute(
                        "UPDATE work_items SET stage = 'done', acceptance = 'accepted',
                           outcome = ?2, review_kind = NULL, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?1",
                        params![id, input.outcome.as_str()],
                    )?;
                    tx.execute(
                        "UPDATE work_assignments SET ended_at = CURRENT_TIMESTAMP, end_reason = 'accepted'
                         WHERE task_id = ?1 AND ended_at IS NULL",
                        [id],
                    )?;
                }
                (_, false) => {
                    tx.execute(
                        "UPDATE work_items SET stage = 'executing', acceptance = 'rejected',
                           review_kind = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                        [id],
                    )?;
                }
            }
            refresh_readiness(tx, project_id)?;
            Ok((
                load_item(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Review)),
            ))
        })
    }

    /// Cancels, abandons, or supersedes work. History stays: attempts and
    /// results remain, open attempts are cancelled, the open assignment ends,
    /// and the reason (and the replacing item) is recorded.
    pub fn close<'a>(
        &self,
        project_id: &str,
        id: &str,
        expected_revision: u64,
        closure: Closure<'_>,
        ctx: impl Into<Ctx<'a>>,
    ) -> Result<WorkItem, WorkError> {
        let ctx = ctx.into();
        let Closure {
            lifecycle,
            reason,
            superseded_by,
        } = closure;
        let reason = reason.trim();
        if lifecycle == WorkLifecycle::Active {
            return Err(WorkError::Invalid(
                "choose canceled, abandoned, or superseded",
            ));
        }
        if reason.is_empty() {
            return Err(WorkError::Invalid("a reason is required"));
        }
        text_ok(reason, MAX_REASON_CHARS, "the reason is too long")?;
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            authorize(tx, &item, ctx.actor, Need::Coordination)?;
            expect_revision(&item, expected_revision)?;
            expect_state(&item, &ctx)?;
            let replacement = match (lifecycle, superseded_by) {
                (WorkLifecycle::Superseded, Some(other)) => {
                    if other == id {
                        return Err(WorkError::Invalid("work cannot supersede itself"));
                    }
                    let other = load_item(tx, project_id, other)?;
                    active(&other)?;
                    Some(other.id)
                }
                (WorkLifecycle::Superseded, None) => {
                    return Err(WorkError::Invalid("name the work that supersedes this"));
                }
                (_, Some(_)) => {
                    return Err(WorkError::Invalid("only superseded work names a replacement"));
                }
                (_, None) => None,
            };
            tx.execute(
                "UPDATE work_attempts SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP
                 WHERE task_id = ?1 AND status IN ('queued', 'running', 'needs_report', 'result_submitted')",
                [id],
            )?;
            tx.execute(
                "UPDATE work_assignments SET ended_at = CURRENT_TIMESTAMP, end_reason = ?2
                 WHERE task_id = ?1 AND ended_at IS NULL",
                params![id, format!("{}: {reason}", lifecycle.as_str())],
            )?;
            tx.execute(
                "UPDATE work_items SET lifecycle = ?2, closed_reason = ?3, superseded_by = ?4,
                   updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![id, lifecycle.as_str(), reason, replacement],
            )?;
            bump(tx, id)?;
            refresh_readiness(tx, project_id)?;
            Ok((
                load_item(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Closed)),
            ))
        })
    }

    /// Attaches an existing record as a result, evidence, or artifact of the
    /// task or one of its attempts. The record must exist in this Project;
    /// nothing is copied. The executing Session may attach while the work is
    /// being executed or analyzed, not after review.
    pub fn add_result(
        &self,
        project_id: &str,
        id: &str,
        result: NewResult<'_>,
        actor: &Actor,
    ) -> Result<ResultRef, WorkError> {
        let NewResult {
            attempt_id,
            role,
            kind,
            ref_id,
            revision,
        } = result;
        if kind.trim().is_empty() || ref_id.trim().is_empty() {
            return Err(WorkError::Invalid(
                "a result reference needs a kind and an id",
            ));
        }
        text_ok(kind, 64, "the reference kind is too long")?;
        text_ok(ref_id, MAX_ID_CHARS, "the reference id is too long")?;
        if let Some(revision) = revision {
            text_ok(revision, 128, "the reference revision is too long")?;
        }
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            authorize(tx, &item, actor, Need::Execution)?;
            if matches!(actor, Actor::Executor { .. })
                && !matches!(item.stage, WorkStage::Executing | WorkStage::Analyzing)
            {
                return Err(WorkError::Closed(item.stage.as_str()));
            }
            validate_reference(tx, project_id, kind, ref_id)?;
            if let Some(attempt_id) = attempt_id {
                let attempt = load_attempt(tx, project_id, attempt_id)?;
                if attempt.task_id != id {
                    return Err(WorkError::Invalid("the attempt belongs to another task"));
                }
            }
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM work_results WHERE task_id = ?1",
                [id],
                |row| row.get(0),
            )?;
            if count as usize >= MAX_RESULT_REFS {
                return Err(WorkError::Invalid("too many result references"));
            }
            let existing = tx
                .query_row(
                    "SELECT id FROM work_results
                     WHERE task_id = ?1 AND attempt_id IS ?2 AND role = ?3 AND kind = ?4 AND ref_id = ?5",
                    params![id, attempt_id, role.as_str(), kind, ref_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let result_id = match existing {
                Some(existing) => existing,
                None => {
                    let result_id = new_id();
                    tx.execute(
                        "INSERT INTO work_results (id, task_id, attempt_id, role, kind, ref_id, revision)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![result_id, id, attempt_id, role.as_str(), kind, ref_id, revision],
                    )?;
                    tx.execute(
                        "UPDATE work_items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                        [id],
                    )?;
                    result_id
                }
            };
            let stored = results_of(tx, id)?
                .into_iter()
                .find(|result| result.id == result_id)
                .ok_or(WorkError::NotFound)?;
            Ok((
                stored,
                Some((project_id.to_owned(), id.to_owned(), Change::Result)),
            ))
        })
    }

    /// Sets what the round may spend on execution. Only the researcher can: no
    /// message, mention, or coordinator command widens a budget. Revision-
    /// checked (0 is the unstored defaults), so two edits cannot overwrite each
    /// other, and every limit is bounded.
    pub fn set_policy(
        &self,
        project_id: &str,
        round_id: &str,
        expected_revision: u64,
        patch: PolicyPatch,
        actor: &Actor,
    ) -> Result<RoundPolicy, WorkError> {
        if !matches!(actor, Actor::Researcher) {
            return Err(WorkError::Invalid(
                "only the researcher sets a round's execution limits",
            ));
        }
        for limit in [
            patch.max_executors,
            patch.max_parallel_attempts,
            patch.max_attempts,
        ]
        .into_iter()
        .flatten()
        {
            if limit == 0 || limit > MAX_POLICY_LIMIT {
                return Err(WorkError::Invalid("a limit must be between 1 and 1000"));
            }
        }
        self.write(|tx| {
            round_research(tx, project_id, round_id)?;
            let current = load_policy(tx, project_id, round_id)?;
            if current.revision != expected_revision {
                return Err(WorkError::Stale {
                    current: current.revision,
                });
            }
            let next = RoundPolicy {
                max_executors: patch.max_executors.unwrap_or(current.max_executors),
                max_parallel_attempts: patch
                    .max_parallel_attempts
                    .unwrap_or(current.max_parallel_attempts),
                max_attempts: patch.max_attempts.unwrap_or(current.max_attempts),
                paused: patch.paused.unwrap_or(current.paused),
                ..current.clone()
            };
            if next == current {
                return Ok((current, None));
            }
            tx.execute(
                "INSERT INTO round_policies
                   (round_id, project_id, max_executors, max_parallel_attempts, max_attempts,
                    paused, revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
                 ON CONFLICT(round_id) DO UPDATE SET
                   max_executors = excluded.max_executors,
                   max_parallel_attempts = excluded.max_parallel_attempts,
                   max_attempts = excluded.max_attempts, paused = excluded.paused,
                   revision = round_policies.revision + 1, updated_at = CURRENT_TIMESTAMP",
                params![
                    round_id,
                    project_id,
                    next.max_executors,
                    next.max_parallel_attempts,
                    next.max_attempts,
                    next.paused,
                ],
            )?;
            Ok((
                load_policy(tx, project_id, round_id)?,
                Some((project_id.to_owned(), round_id.to_owned(), Change::Policy)),
            ))
        })
    }

    /// Re-pins a cited result to the revision it has now, on purpose: the
    /// caller has looked at what changed and accepts it as the evidence. The
    /// earlier revision stays in any review that saw it.
    pub fn repin_result<'a>(
        &self,
        project_id: &str,
        id: &str,
        result_id: &str,
        revision: Option<&str>,
        ctx: impl Into<Ctx<'a>>,
    ) -> Result<ResultRef, WorkError> {
        let ctx = ctx.into();
        if let Some(revision) = revision {
            text_ok(revision, 128, "the reference revision is too long")?;
        }
        self.write(|tx| {
            let item = load_item(tx, project_id, id)?;
            native(&item)?;
            active(&item)?;
            authorize(tx, &item, ctx.actor, Need::Execution)?;
            expect_state(&item, &ctx)?;
            let changed = tx.execute(
                "UPDATE work_results SET revision = ?3 WHERE id = ?1 AND task_id = ?2",
                params![result_id, id, revision],
            )?;
            if changed == 0 {
                return Err(WorkError::NotFound);
            }
            tx.execute(
                "UPDATE work_items SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id],
            )?;
            let stored = results_of(tx, id)?
                .into_iter()
                .find(|result| result.id == result_id)
                .ok_or(WorkError::NotFound)?;
            Ok((
                stored,
                Some((project_id.to_owned(), id.to_owned(), Change::Result)),
            ))
        })
    }

    // -- Coordination ------------------------------------------------------------------------------

    /// Names the first coordinator of a round (epoch 1). Only the researcher
    /// may seat one; repeating it for the same holder is a no-op, and a
    /// different holder must go through a handoff.
    pub fn assume_coordinator(
        &self,
        project_id: &str,
        round_id: &str,
        holder: &str,
        actor: &Actor,
    ) -> Result<RoundCoordinator, WorkError> {
        if !matches!(actor, Actor::Researcher) {
            return Err(WorkError::Invalid(
                "only the researcher seats the first coordinator",
            ));
        }
        self.check_may_coordinate(project_id, holder)?;
        self.write(|tx| {
            round_research(tx, project_id, round_id)?;
            session_in_project(tx, project_id, holder)?;
            if let Some(current) = coordinator_of(tx, project_id, round_id)? {
                if current.holder == holder {
                    return Ok((current, None));
                }
                return Err(WorkError::StaleCoordinator {
                    current_epoch: current.epoch,
                });
            }
            tx.execute(
                "INSERT INTO round_coordinators (round_id, project_id, holder, epoch)
                 VALUES (?1, ?2, ?3, 1)",
                params![round_id, project_id, holder],
            )?;
            tx.execute(
                "INSERT INTO round_coordinator_history (round_id, epoch, holder, previous_holder, reason)
                 VALUES (?1, 1, ?2, NULL, 'first coordinator')",
                params![round_id, holder],
            )?;
            Ok((
                coordinator_of(tx, project_id, round_id)?.ok_or(WorkError::NotFound)?,
                Some((project_id.to_owned(), round_id.to_owned(), Change::Coordinator)),
            ))
        })
    }

    /// Hands a round to another Session. It names the epoch it expects and
    /// increments it, so the previous holder's authority ends at once: every
    /// later command presenting the old epoch is refused. Tasks, attempts, and
    /// results are not coordinator-owned and are untouched. (Work that mirrors a
    /// Team task is still operated through its Team; see ADR 0215 §5.)
    pub fn handoff_coordinator(
        &self,
        project_id: &str,
        round_id: &str,
        expected_epoch: u64,
        to_holder: &str,
        reason: &str,
        actor: &Actor,
    ) -> Result<RoundCoordinator, WorkError> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Err(WorkError::Invalid("a reason is required"));
        }
        text_ok(reason, MAX_REASON_CHARS, "the reason is too long")?;
        self.check_may_coordinate(project_id, to_holder)?;
        self.write(|tx| {
            round_research(tx, project_id, round_id)?;
            let current = coordinator_of(tx, project_id, round_id)?.ok_or(WorkError::NoCoordinator)?;
            match actor {
                Actor::Researcher => {}
                Actor::Coordinator(auth) => check_coordinator(tx, project_id, round_id, auth)?,
                Actor::Executor { .. } => {
                    return Err(WorkError::Invalid("an executor cannot hand off a round"));
                }
            }
            if current.epoch != expected_epoch {
                return Err(WorkError::StaleCoordinator {
                    current_epoch: current.epoch,
                });
            }
            session_in_project(tx, project_id, to_holder)?;
            if current.holder == to_holder {
                return Ok((current, None));
            }
            let epoch = current.epoch + 1;
            tx.execute(
                "UPDATE round_coordinators SET holder = ?2, epoch = ?3, since = CURRENT_TIMESTAMP
                 WHERE round_id = ?1",
                params![round_id, to_holder, epoch as i64],
            )?;
            tx.execute(
                "INSERT INTO round_coordinator_history (round_id, epoch, holder, previous_holder, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![round_id, epoch as i64, to_holder, current.holder, reason],
            )?;
            Ok((
                coordinator_of(tx, project_id, round_id)?.ok_or(WorkError::NotFound)?,
                Some((project_id.to_owned(), round_id.to_owned(), Change::Coordinator)),
            ))
        })
    }

    /// Checks a claimed authority against the persisted row, as a caller that
    /// is about to act would. `Ok` means `(holder, epoch)` is current *now*; the
    /// answer can age, so any action must go through a command here, which
    /// re-checks inside its own transaction.
    pub fn authorize_coordinator(
        &self,
        project_id: &str,
        auth: &CoordinatorAuth,
    ) -> Result<(), WorkError> {
        self.reconcile()?;
        let connection = self.connection();
        let current = coordinator_of(&connection, project_id, &auth.round_id)?
            .ok_or(WorkError::NoCoordinator)?;
        if current.holder != auth.holder || current.epoch != auth.epoch {
            return Err(WorkError::StaleCoordinator {
                current_epoch: current.epoch,
            });
        }
        Ok(())
    }
}
