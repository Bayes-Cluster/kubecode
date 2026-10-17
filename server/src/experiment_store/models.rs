//! Experiment domain types, validation, and errors (ADR 0213). Every list and
//! string is bounded so no caller can store an unbounded command, label, or
//! allow-list through the execution APIs.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::research_store::SourceRef;

pub const MAX_LAUNCHES: u32 = 50;
pub const MAX_CONCURRENT: u32 = 4;
pub const MAX_RUNTIME_SECS: u32 = 86_400;
pub const MAX_NO_PROGRESS: u32 = 10;
pub const MAX_ALLOWED_COMMANDS: usize = 20;
pub const MAX_ARGV: usize = 32;
pub const MAX_ARG_CHARS: usize = 512;
pub const MAX_LABEL_CHARS: usize = 200;
pub const MAX_ARTIFACTS: usize = 20;
pub const MAX_FOLLOW_UP_CHARS: usize = 1_000;
pub const MAX_KEY_CHARS: usize = 128;
pub const MAX_REASON_CHARS: usize = 500;

macro_rules! text_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
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

text_enum!(EnvelopeState {
    Active => "active",
    Paused => "paused",
    Closed => "closed",
});

text_enum!(ExperimentState {
    Reserved => "reserved",
    Launching => "launching",
    Running => "running",
    Cancelling => "cancelling",
    Exited => "exited",
    TimedOut => "timed_out",
    Cancelled => "cancelled",
    FailedToStart => "failed_to_start",
    Unknown => "unknown",
});

text_enum!(AnalysisState {
    None => "none",
    Pending => "pending",
    Analyzed => "analyzed",
});

text_enum!(WaitState {
    Open => "open",
    Resolved => "resolved",
    Expired => "expired",
    Cancelled => "cancelled",
    Reassigned => "reassigned",
});

text_enum!(EventKind {
    Finished => "finished",
    WaitExpired => "wait_expired",
    Reconciled => "reconciled",
});

// What the Leader decided to do about a finished experiment (ADR 0213 section 7).
text_enum!(DecisionKind {
    FurtherAnalysis => "further_analysis",
    Repair => "repair",
    Retry => "retry",
    FollowUp => "follow_up",
    ExternalWait => "external_wait",
    ResearcherInput => "researcher_input",
    Conclude => "conclude",
});

// What the researcher says really happened to an `unknown` experiment.
text_enum!(ReconcileTruth {
    NotStarted => "not_started",
    Finished => "finished",
});

impl DecisionKind {
    /// Whether the decision settles the experiment's analysis obligation.
    /// Further analysis and an external wait only promise more work, so the
    /// result stays owed until a later decision.
    pub fn resolves_analysis(self) -> bool {
        !matches!(self, Self::FurtherAnalysis | Self::ExternalWait)
    }

    /// Whether the decision starts another experiment.
    pub fn launches(self) -> bool {
        matches!(self, Self::Retry | Self::FollowUp)
    }
}

impl ExperimentState {
    /// States whose process may still be running (or whose fate is
    /// unrecorded): they hold a concurrency slot and block Team completion.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Reserved | Self::Launching | Self::Running | Self::Cancelling | Self::Unknown
        )
    }

    /// Finished states that count against the no-progress limit.
    pub fn is_unproductive(self) -> bool {
        matches!(self, Self::TimedOut | Self::FailedToStart | Self::Unknown)
    }
}

/// Why a launch was refused. Codes are stable: the UI and Leader tools key
/// off them, and none can be overridden from a prompt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchDenial {
    NoEnvelope,
    EnvelopePaused,
    EnvelopeClosed,
    DeadlinePassed,
    CommandNotAuthorized,
    LaunchBudgetExhausted,
    ConcurrencyLimit,
    NoProgress,
    TeamNotActive,
}

impl LaunchDenial {
    pub fn code(self) -> &'static str {
        match self {
            Self::NoEnvelope => "no_envelope",
            Self::EnvelopePaused => "envelope_paused",
            Self::EnvelopeClosed => "envelope_closed",
            Self::DeadlinePassed => "deadline_passed",
            Self::CommandNotAuthorized => "command_not_authorized",
            Self::LaunchBudgetExhausted => "launch_budget_exhausted",
            Self::ConcurrencyLimit => "concurrency_limit",
            Self::NoProgress => "no_progress",
            Self::TeamNotActive => "team_not_active",
        }
    }
}

#[derive(Debug, Error)]
pub enum ExperimentError {
    #[error("experiment record not found")]
    NotFound,
    #[error("invalid execution input: {0}")]
    Invalid(&'static str),
    #[error("launch refused: {}", .0.code())]
    Denied(LaunchDenial),
    #[error("this launch key was already used for a different command")]
    KeyReuse,
    #[error("execution envelope revision conflict (current revision {current})")]
    EnvelopeConflict { current: u64 },
    #[error("experiment state conflict: {0}")]
    State(&'static str),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// The researcher-approved limits of one round. Without an envelope nothing
/// can launch (ADR 0213 §2).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EnvelopeLimits {
    pub max_launches: u32,
    pub max_concurrent: u32,
    /// Unix seconds; no launch is admitted after it.
    pub deadline_at: Option<i64>,
    /// Longest a single process may run before it is stopped.
    pub max_runtime_secs: u32,
    /// Consecutive unproductive attempts before admission refuses.
    pub max_no_progress: u32,
    /// argv prefixes a launch must start with.
    pub allowed_commands: Vec<Vec<String>>,
}

impl EnvelopeLimits {
    pub fn normalized(mut self) -> Result<Self, ExperimentError> {
        if !(1..=MAX_LAUNCHES).contains(&self.max_launches)
            || !(1..=MAX_CONCURRENT).contains(&self.max_concurrent)
            || !(1..=MAX_RUNTIME_SECS).contains(&self.max_runtime_secs)
            || !(1..=MAX_NO_PROGRESS).contains(&self.max_no_progress)
        {
            return Err(ExperimentError::Invalid(
                "an envelope limit is out of range",
            ));
        }
        if self.allowed_commands.is_empty() || self.allowed_commands.len() > MAX_ALLOWED_COMMANDS {
            return Err(ExperimentError::Invalid("allow between 1 and 20 commands"));
        }
        for command in &mut self.allowed_commands {
            *command = normalize_argv(std::mem::take(command))?;
        }
        self.allowed_commands.dedup();
        Ok(self)
    }

    /// Whether `argv` starts with an allowed prefix, token for token.
    pub fn authorizes(&self, argv: &[String]) -> bool {
        self.allowed_commands
            .iter()
            .any(|prefix| argv.len() >= prefix.len() && argv[..prefix.len()] == prefix[..])
    }
}

/// Trims and bounds a command. The first token is the program and must be
/// non-empty; tokens may not contain NUL.
pub fn normalize_argv(argv: Vec<String>) -> Result<Vec<String>, ExperimentError> {
    if argv.is_empty() || argv.len() > MAX_ARGV {
        return Err(ExperimentError::Invalid("a command needs 1 to 32 tokens"));
    }
    let mut normalized = Vec::with_capacity(argv.len());
    for token in argv {
        if token.chars().count() > MAX_ARG_CHARS || token.contains('\0') {
            return Err(ExperimentError::Invalid("a command token is invalid"));
        }
        normalized.push(token);
    }
    if normalized[0].trim().is_empty() {
        return Err(ExperimentError::Invalid("a command needs a program"));
    }
    Ok(normalized)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Envelope {
    pub round_id: String,
    pub research_id: String,
    pub revision: u64,
    pub state: EnvelopeState,
    pub limits: EnvelopeLimits,
    /// Reservations made against `max_launches` (never decreases except when
    /// an attempt is reconciled as never started).
    pub launches_reserved: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// Process identity: a pid alone is never enough to recognise a process
/// after a restart.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProcessIdentity {
    pub pid: i64,
    pub start_ticks: u64,
    pub boot_id: String,
}

/// A request to launch, validated by the caller's Project/Team scoping.
#[derive(Clone, Debug)]
pub struct NewLaunch {
    pub round_id: String,
    pub launch_key: String,
    pub team_id: Option<String>,
    pub task_id: Option<String>,
    pub owner_member_id: Option<String>,
    pub label: String,
    pub argv: Vec<String>,
    /// Project-relative directory under the execution root ("" is the root).
    pub cwd: String,
    /// Project-relative paths to report on at exit.
    pub artifacts: Vec<String>,
    pub sources: Vec<SourceRef>,
    /// Requested runtime cap; clamped to the envelope's.
    pub max_runtime_secs: Option<u32>,
}

impl NewLaunch {
    pub fn normalized(mut self) -> Result<Self, ExperimentError> {
        self.argv = normalize_argv(self.argv)?;
        self.launch_key = self.launch_key.trim().to_owned();
        if self.launch_key.is_empty()
            || self.launch_key.chars().count() > MAX_KEY_CHARS
            || !self
                .launch_key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        {
            return Err(ExperimentError::Invalid("a launch key is required"));
        }
        self.label = self.label.trim().to_owned();
        if self.label.chars().count() > MAX_LABEL_CHARS {
            return Err(ExperimentError::Invalid("the label is too long"));
        }
        if self.artifacts.len() > MAX_ARTIFACTS {
            return Err(ExperimentError::Invalid("too many artifacts"));
        }
        if self.cwd.chars().count() > MAX_ARG_CHARS
            || self.cwd.contains('\0')
            || self.artifacts.iter().any(|path| {
                path.trim().is_empty()
                    || path.chars().count() > MAX_ARG_CHARS
                    || path.contains('\0')
            })
        {
            return Err(ExperimentError::Invalid("a path is empty or too long"));
        }
        if self.sources.len() > crate::research_store::MAX_ROUND_SOURCES {
            return Err(ExperimentError::Invalid("too many sources"));
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Experiment {
    pub id: String,
    pub project_id: String,
    pub research_id: String,
    pub round_id: String,
    pub team_id: Option<String>,
    pub task_id: Option<String>,
    pub owner_member_id: Option<String>,
    pub launch_key: String,
    pub label: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub artifacts: Vec<String>,
    pub sources: Vec<SourceRef>,
    /// The envelope revision this attempt was admitted under.
    pub policy_revision: u64,
    pub max_runtime_secs: u32,
    pub state: ExperimentState,
    pub analysis: AnalysisState,
    pub identity: Option<ProcessIdentity>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub reason: Option<String>,
    pub cancel_requested: bool,
    /// Content revision of each declared artifact when the process ended
    /// (`None` when it was missing), so a later change is detectable.
    pub artifact_revisions: Vec<ArtifactRevision>,
    pub created_at: String,
    pub launched_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ArtifactRevision {
    pub path: String,
    pub revision: Option<String>,
}

/// What a finished process looked like.
#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub state: Option<ExperimentState>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub reason: Option<String>,
    pub artifact_revisions: Vec<ArtifactRevision>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExperimentWait {
    pub id: String,
    pub experiment_id: String,
    pub team_id: String,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub owner_member_id: String,
    pub expected_follow_up: String,
    pub deadline_at: Option<i64>,
    pub state: WaitState,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExperimentEvent {
    pub id: String,
    pub experiment_id: String,
    pub kind: EventKind,
    pub created_at: String,
}

/// What one reminder pass did.
#[derive(Debug, Default)]
pub struct ReminderOutcome {
    /// Experiments whose result was re-raised.
    pub reminded: Vec<String>,
    /// `(team_id, experiment_id)` pairs that used up their reminders.
    pub exhausted: Vec<(String, String)>,
}

pub const MAX_RATIONALE_CHARS: usize = 2_000;
pub const MAX_DECISION_EVIDENCE: usize = 10;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExperimentDecision {
    pub id: String,
    pub experiment_id: String,
    pub member_id: String,
    pub kind: DecisionKind,
    pub decision_key: String,
    pub rationale: String,
    pub evidence: Vec<SourceRef>,
    /// The attempt this decision started, for `retry` and `follow_up`.
    pub launched_experiment_id: Option<String>,
    pub created_at: String,
}

impl NewDecision {
    /// The decision's own fields checked up front, so a malformed decision is
    /// refused before anything it would start is started.
    pub fn validate(&self) -> Result<(), ExperimentError> {
        let rationale = self.rationale.trim();
        if rationale.is_empty() || rationale.chars().count() > MAX_RATIONALE_CHARS {
            return Err(ExperimentError::Invalid(
                "a rationale of 1 to 2000 characters is required",
            ));
        }
        if self.evidence.len() > MAX_DECISION_EVIDENCE {
            return Err(ExperimentError::Invalid(
                "too much evidence on one decision",
            ));
        }
        if self
            .decision_key
            .as_deref()
            .is_some_and(|key| key.trim().chars().count() > MAX_KEY_CHARS)
        {
            return Err(ExperimentError::Invalid("the decision key is too long"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct NewDecision {
    pub experiment_id: String,
    pub member_id: String,
    pub kind: DecisionKind,
    /// Distinguishes several decisions of one kind about one experiment;
    /// defaults to the kind, so a repeated call is the same decision.
    pub decision_key: Option<String>,
    pub rationale: String,
    pub evidence: Vec<SourceRef>,
    pub launched_experiment_id: Option<String>,
}
