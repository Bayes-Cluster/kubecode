//! Types of the Workspace work store (ADR 0215). Facets that mean different
//! things never share a field: where work is (`stage`), why it is not moving
//! (`condition`), whether it is still wanted (`lifecycle`), whether it was
//! accepted (`acceptance`), and what the science showed (`outcome`).

use serde::{Deserialize, Serialize};
use thiserror::Error;

macro_rules! text_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$(Self::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

text_enum!(WorkStage {
    Planned => "planned",
    Ready => "ready",
    Executing => "executing",
    Analyzing => "analyzing",
    Review => "review",
    Done => "done",
});

text_enum!(WorkCondition {
    None => "none",
    Waiting => "waiting",
    Blocked => "blocked",
    Paused => "paused",
    NeedsInput => "needs_input",
});

text_enum!(WorkLifecycle {
    Active => "active",
    Canceled => "canceled",
    Abandoned => "abandoned",
    Superseded => "superseded",
});

text_enum!(Acceptance {
    Pending => "pending",
    Accepted => "accepted",
    Rejected => "rejected",
});

text_enum!(WorkOutcome {
    Unknown => "unknown",
    Supported => "supported",
    Refuted => "refuted",
    Inconclusive => "inconclusive",
});

text_enum!(WorkKind {
    Experiment => "experiment",
    Analysis => "analysis",
    Implementation => "implementation",
    Review => "review",
    Other => "other",
});

// Who writes a work item. A legacy item mirrors a Team task and is changed
// only through the Team store; a native item is owned by the work store.
text_enum!(WorkOrigin {
    LegacyTeam => "legacy_team",
    Native => "native",
});

text_enum!(ReviewKind {
    Plan => "plan",
    Result => "result",
    Code => "code",
    Validity => "validity",
    Evidence => "evidence",
});

text_enum!(AttemptStatus {
    Queued => "queued",
    Running => "running",
    NeedsReport => "needs_report",
    ResultSubmitted => "result_submitted",
    Completed => "completed",
    Failed => "failed",
    Cancelled => "cancelled",
});

text_enum!(ResultRole {
    Result => "result",
    Evidence => "evidence",
    Artifact => "artifact",
});

pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_DESCRIPTION_CHARS: usize = 8_000;
pub const MAX_PLAN_CHARS: usize = 16_000;
pub const MAX_REASON_CHARS: usize = 1_000;
pub const MAX_DEPENDENCIES: usize = 50;
pub const MAX_RESULT_REFS: usize = 100;
pub const MAX_ID_CHARS: usize = 512;

/// Where an actor stands: the researcher of the Project, or the coordinator of
/// one round at one epoch. Coordinator authority is re-read from the persisted
/// row on every command (ADR 0215 §4), never trusted from the caller.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Actor {
    Researcher,
    Coordinator(CoordinatorAuth),
    /// The Session currently assigned to the task: it may report on its own
    /// attempt (finish it, attach results, say it is waiting) but not plan,
    /// assign, review, or close.
    Executor {
        conversation_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CoordinatorAuth {
    pub round_id: String,
    /// The coordinating Session's conversation id.
    pub holder: String,
    pub epoch: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkItem {
    pub id: String,
    pub project_id: String,
    pub research_id: Option<String>,
    pub round_id: Option<String>,
    /// Attribution of legacy work only; never an owner.
    pub team_id: Option<String>,
    pub origin: WorkOrigin,
    /// What sort of work this is, so a view can show only the stages that apply.
    pub kind: WorkKind,
    pub title: String,
    pub description: String,
    pub plan: Option<String>,
    /// What the executor reported (mirrored from a Team task's result).
    pub result: Option<String>,
    pub verification: Option<String>,
    pub stage: WorkStage,
    pub condition: WorkCondition,
    pub condition_reason: Option<String>,
    pub review_kind: Option<ReviewKind>,
    pub lifecycle: WorkLifecycle,
    pub closed_reason: Option<String>,
    pub superseded_by: Option<String>,
    pub acceptance: Acceptance,
    pub outcome: WorkOutcome,
    pub priority: i64,
    /// Bumped by every plan, dependency, or round-link change.
    pub revision: u64,
    /// Bumped by *every* change to the item, including stage, condition,
    /// assignment, and review, so a stale board command can be refused.
    pub state_revision: u64,
    /// What this work arose from: a finding, or the work it follows up.
    pub derived_from: Option<DerivedFrom>,
    pub dependencies: Vec<String>,
    /// Who created it: a Session's conversation id, or `researcher`.
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Assignment {
    pub id: String,
    pub task_id: String,
    /// The executing Session.
    pub conversation_id: String,
    pub member_id: Option<String>,
    pub assigned_by: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub end_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Attempt {
    pub id: String,
    pub task_id: String,
    pub assignment_id: Option<String>,
    pub conversation_id: Option<String>,
    pub run_id: Option<String>,
    pub status: AttemptStatus,
    pub failure_kind: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

/// An existing record attached to a task or one of its attempts. Nothing is
/// copied: the reference carries the revision it was cited at (ADR 0214).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResultRef {
    pub id: String,
    pub task_id: String,
    pub attempt_id: Option<String>,
    pub role: ResultRole,
    pub kind: String,
    pub ref_id: String,
    pub revision: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RoundCoordinator {
    pub round_id: String,
    pub project_id: String,
    pub holder: String,
    pub epoch: u64,
    pub since: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CoordinatorChange {
    pub round_id: String,
    pub epoch: u64,
    pub holder: String,
    pub previous_holder: Option<String>,
    pub reason: String,
    pub at: String,
}

/// The one shape every consumer reads (ADR 0215 §6): the board, inspectors, and
/// evidence views are filters over this, not separate task models.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkSummary {
    pub item: WorkItem,
    pub assignment: Option<Assignment>,
    pub latest_attempt: Option<Attempt>,
    pub attempt_count: usize,
    pub results: Vec<ResultRef>,
    /// Each dependency with the state a card needs to explain why it waits.
    pub dependency_states: Vec<DependencyState>,
    /// The work this replaces (the reverse of `superseded_by`).
    pub supersedes: Vec<String>,
    /// Experiments recorded against this task.
    pub experiment_count: usize,
    /// The latest change to the item, its attempts, or its results.
    pub last_activity_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DependencyState {
    pub id: String,
    pub title: String,
    pub stage: WorkStage,
    pub lifecycle: WorkLifecycle,
    pub acceptance: Acceptance,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DerivedFrom {
    /// `finding` or `work`.
    pub kind: String,
    pub id: String,
}

/// A recorded review decision and exactly what it looked at.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReviewRecord {
    pub id: String,
    pub task_id: String,
    pub kind: ReviewKind,
    pub accepted: bool,
    pub outcome: WorkOutcome,
    pub reviewer: String,
    pub reason: Option<String>,
    /// Attempts and result references (`kind:id@revision`) that existed when the
    /// decision was made, so later invalidation of the inputs is detectable.
    pub inputs: Vec<String>,
    pub created_at: String,
}

#[derive(Clone, Copy, Debug)]
pub struct ReviewInput<'a> {
    pub accept: bool,
    pub outcome: WorkOutcome,
    pub reason: Option<&'a str>,
}

/// An actor plus an optional precondition on the item's `state_revision`.
/// A command carrying one is refused if anything about the item changed since
/// the caller looked, so a stale card can never act on newer state.
#[derive(Clone, Copy, Debug)]
pub struct Ctx<'a> {
    pub actor: &'a Actor,
    pub expected_state_revision: Option<u64>,
}

impl<'a> Ctx<'a> {
    pub fn expecting(actor: &'a Actor, state_revision: u64) -> Self {
        Self {
            actor,
            expected_state_revision: Some(state_revision),
        }
    }
}

impl<'a> From<&'a Actor> for Ctx<'a> {
    fn from(actor: &'a Actor) -> Self {
        Self {
            actor,
            expected_state_revision: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct WorkCounts {
    pub total: usize,
    pub by_stage: Vec<(WorkStage, usize)>,
}

#[derive(Clone, Debug, Default)]
pub struct WorkFilter {
    pub research_id: Option<String>,
    pub round_id: Option<String>,
    pub team_id: Option<String>,
    pub conversation_id: Option<String>,
    pub stage: Option<WorkStage>,
    pub condition: Option<WorkCondition>,
    pub origin: Option<WorkOrigin>,
    /// Include canceled, abandoned, and superseded work.
    pub include_closed: bool,
    /// At most this many (default and ceiling 200); `offset` skips that many.
    pub limit: Option<usize>,
    pub offset: usize,
}

#[derive(Clone, Debug, Default)]
pub struct NewWork<'a> {
    pub kind: Option<WorkKind>,
    pub derived_from: Option<(&'a str, &'a str)>,
    pub title: &'a str,
    pub description: &'a str,
    pub plan: Option<&'a str>,
    pub research_id: Option<&'a str>,
    pub round_id: Option<&'a str>,
    pub dependencies: &'a [String],
    pub priority: i64,
    pub created_by: Option<&'a str>,
    pub client_request_id: Option<&'a str>,
}

pub const DEFAULT_MAX_EXECUTORS: u32 = 4;
pub const DEFAULT_MAX_PARALLEL_ATTEMPTS: u32 = 2;
pub const DEFAULT_MAX_ATTEMPTS: u32 = 20;
pub const MAX_POLICY_LIMIT: u32 = 1_000;

/// What the researcher authorized a round to spend on execution (ADR 0217).
/// Only the researcher sets it; no mention, message, or coordinator command
/// can widen it. A round without a stored policy runs under the defaults.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RoundPolicy {
    pub round_id: String,
    /// Distinct Sessions executing at once.
    pub max_executors: u32,
    /// Attempts open at once across the round.
    pub max_parallel_attempts: u32,
    /// Attempts ever started in the round, retries included.
    pub max_attempts: u32,
    /// No new attempts start while paused.
    pub paused: bool,
    /// 0 for the defaults, then bumped by every change.
    pub revision: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct PolicyPatch {
    pub max_executors: Option<u32>,
    pub max_parallel_attempts: Option<u32>,
    pub max_attempts: Option<u32>,
    pub paused: Option<bool>,
}

/// What a round has used so far.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct RoundStats {
    pub executors: u32,
    pub open_attempts: u32,
    pub total_attempts: u32,
}

/// A revision-checked change to a task's plan. Absent fields keep their value.
#[derive(Clone, Debug, Default)]
pub struct PlanPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    /// `Some("")` clears the plan.
    pub plan: Option<String>,
    pub priority: Option<i64>,
    pub kind: Option<WorkKind>,
    pub add_dependencies: Vec<String>,
    pub remove_dependencies: Vec<String>,
}

/// Why and how work is closed.
#[derive(Clone, Copy, Debug)]
pub struct Closure<'a> {
    /// Canceled, abandoned, or superseded.
    pub lifecycle: WorkLifecycle,
    pub reason: &'a str,
    /// The work that replaces this one; required for, and only for, supersession.
    pub superseded_by: Option<&'a str>,
}

/// An existing record to attach to a task or one of its attempts.
#[derive(Clone, Copy, Debug)]
pub struct NewResult<'a> {
    pub attempt_id: Option<&'a str>,
    pub role: ResultRole,
    pub kind: &'a str,
    pub ref_id: &'a str,
    pub revision: Option<&'a str>,
}

#[derive(Clone, Debug)]
pub enum AttemptOutcome {
    Completed,
    Failed {
        kind: Option<String>,
        error: Option<String>,
    },
    Cancelled,
}

#[derive(Debug, Error)]
pub enum WorkError {
    /// Missing, or in another Project: indistinguishable by design.
    #[error("work not found")]
    NotFound,
    #[error("the work item changed (current revision {current})")]
    Stale { current: u64 },
    #[error("invalid work input: {0}")]
    Invalid(&'static str),
    #[error("cannot move work from {from} to {to}")]
    InvalidTransition {
        from: &'static str,
        to: &'static str,
    },
    #[error("this work mirrors a Team task and is changed through its Team")]
    LegacyOwned,
    #[error("research execution requires an approved round")]
    NoApprovedRound,
    #[error("dependencies are not accepted yet")]
    DependenciesUnmet,
    #[error("a dependency would create a cycle")]
    DependencyCycle,
    #[error("work is closed ({0})")]
    Closed(&'static str),
    #[error("the work changed (current state revision {current})")]
    StaleState { current: u64 },
    #[error("the task has no executing Session assigned")]
    NotAssigned,
    #[error("an attempt is already open for this task")]
    AttemptOpen,
    #[error("the coordinator authority is stale (current epoch {current_epoch})")]
    StaleCoordinator { current_epoch: u64 },
    #[error("the round has no coordinator")]
    NoCoordinator,
    #[error("the round's {0} limit is reached")]
    BudgetExhausted(&'static str),
    #[error("the round is paused")]
    RoundPaused,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
