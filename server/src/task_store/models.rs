//! Task types (ADR 0221). A Task is a research question; these are the records
//! of its admission and review and the read model composed over the research,
//! work, and member stores. Nothing here is a second copy of task state.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::channel_store::ChannelError;
use crate::member_store::MemberError;
use crate::research_store::ResearchError;
use crate::work_store::{WorkError, WorkOutcome};

pub const MAX_SUMMARY_CHARS: usize = 4_000;
pub const MAX_REASON_CHARS: usize = 1_000;
pub const MAX_EVIDENCE: usize = 20;
pub const MAX_EVIDENCE_CHARS: usize = 200;

#[derive(Debug, Error)]
pub enum TaskError {
    #[error("task not found")]
    NotFound,
    /// Only the General Agent's current Session may do this.
    #[error("only the General Agent can do this")]
    NotManager,
    /// The caller is not a Workspace member's current Session.
    #[error("only a Workspace member can propose a Task")]
    NotMember,
    /// The authorizing message cannot authorize this (not the researcher's,
    /// quoted, outside General, unknown).
    #[error("that message cannot authorize this: {0}")]
    NotAuthorized(&'static str),
    /// What the researcher authorized is not what the Task is now, or they were
    /// never shown it: the General Agent must show the current proposal again.
    #[error("the researcher has not seen and authorized the current proposal: {0}")]
    Stale(&'static str),
    #[error("that message already authorized another Task or step")]
    MessageUsed,
    #[error("the Task is not in a state for that: {0}")]
    State(&'static str),
    #[error("invalid input: {0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Research(#[from] ResearchError),
    #[error(transparent)]
    Channel(#[from] ChannelError),
    #[error(transparent)]
    Work(#[from] WorkError),
    #[error(transparent)]
    Member(#[from] MemberError),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

macro_rules! text_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
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

text_enum!(AuthorizationKind {
    Admit => "admit",
    Execute => "execute",
    Revise => "revise",
});

text_enum!(AuthorizationOrigin {
    Conversation => "conversation",
    LegacyRound => "legacy_round",
});

text_enum!(TaskStage {
    Ready => "ready",
    InProgress => "in_progress",
    Review => "review",
    Done => "done",
});

// Why a Task is not moving; never a stage.
text_enum!(TaskCondition {
    None => "none",
    Waiting => "waiting",
    Blocked => "blocked",
    Paused => "paused",
    NeedsInput => "needs_input",
});

/// The record that the researcher authorized a step, and who acted on it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Authorization {
    pub id: String,
    pub project_id: String,
    pub research_id: String,
    pub kind: AuthorizationKind,
    /// The researcher's message in General; `None` only for `legacy_round`.
    pub message_id: Option<String>,
    pub brief_revision: u64,
    /// A digest of the goal, criteria, constraints, and scope that was shown.
    pub scope_digest: String,
    /// The General Agent's Session that acted (or `migration`).
    pub acted_by: String,
    pub origin: AuthorizationOrigin,
    pub round_id: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReviewRequest {
    pub id: String,
    pub research_id: String,
    pub summary: String,
    /// Cited evidence as `kind:id`.
    pub evidence: Vec<String>,
    pub requested_by: String,
    pub brief_revision: u64,
    /// `open`, `accepted`, or `returned`.
    pub state: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
    /// The revision each cited `kind:id` had when the review was asked for.
    #[serde(default)]
    pub evidence_pins: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskReview {
    pub id: String,
    pub research_id: String,
    pub request_id: String,
    pub accepted: bool,
    pub outcome: WorkOutcome,
    pub reason: Option<String>,
    pub brief_revision: u64,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkRollup {
    pub total: usize,
    pub active: usize,
    pub in_review: usize,
    pub done: usize,
    pub needs_input: usize,
    pub blocked: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Participant {
    pub member_id: String,
    pub name: String,
    pub handle: String,
    /// `general` (coordinates) or `specialist` (executes).
    pub role: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RoundRef {
    pub id: String,
    pub number: u64,
    pub brief_revision: u64,
    pub phase: String,
}

/// One Task as the board and the inspector read it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskCard {
    /// The research question's id: the Task's one identity.
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub question: String,
    pub stage: TaskStage,
    pub condition: TaskCondition,
    pub condition_reason: Option<String>,
    /// The scientific outcome once the researcher accepted it.
    pub outcome: Option<WorkOutcome>,
    /// The brief revision now, and the one the researcher approved.
    pub revision: u64,
    pub approved_revision: u64,
    pub admitted_at: String,
    pub origin: AuthorizationOrigin,
    pub authorizing_message_id: Option<String>,
    pub rounds: Vec<RoundRef>,
    pub work: WorkRollup,
    pub participants: Vec<Participant>,
    pub open_questions: usize,
    pub review_requested: bool,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageCount {
    pub stage: TaskStage,
    pub count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskBoard {
    pub cards: Vec<TaskCard>,
    pub stages: Vec<StageCount>,
    pub total: usize,
}

/// A proposal that is not on the board.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Draft {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub question: String,
    pub revision: u64,
    /// Who wrote the first revision: `researcher`, `agent`, or `system`.
    pub proposed_by: String,
    pub updated_at: String,
}

/// One revision of a Task's brief and who wrote it, for the inspector.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RevisionNote {
    pub revision: u64,
    pub author_kind: String,
    pub approved: bool,
    pub created_at: String,
}
