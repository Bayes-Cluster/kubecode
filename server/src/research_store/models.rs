//! Research domain types, validation, and errors (ADR 0212). Everything
//! here is bounded: the brief, every list item, and every entry body, so no
//! caller can store an unbounded transcript through the research APIs.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_QUESTION_CHARS: usize = 4_000;
pub const MAX_MOTIVATION_CHARS: usize = 4_000;
pub const MAX_LIST_ITEMS: usize = 20;
pub const MAX_ITEM_CHARS: usize = 1_000;
pub const MAX_BRIEF_BYTES: usize = 16 * 1024;
pub const MAX_ENTRY_CHARS: usize = 8_192;
pub const MAX_NOTE_CHARS: usize = 500;
pub const MAX_CLIENT_REQUEST_ID_CHARS: usize = 128;
pub const DEFAULT_ENTRY_PAGE: usize = 100;
pub const MAX_ENTRY_PAGE: usize = 500;

#[derive(Debug, Error)]
pub enum ResearchError {
    #[error("research question not found")]
    NotFound,
    #[error("research question is archived; restore it before changing it")]
    Archived,
    #[error("research brief revision conflict (current revision {current})")]
    RevisionConflict { current: u64 },
    #[error("invalid research input: {0}")]
    Invalid(&'static str),
    #[error("{kind} is already linked to another research question")]
    LinkConflict { kind: &'static str },
    #[error("linked target belongs to a different Project or does not exist")]
    InvalidLinkTarget,
    #[error("research revision {0} does not exist")]
    RevisionNotFound(u64),
    #[error("research round not found")]
    RoundNotFound,
    #[error("this request key was already used for a different round request")]
    KeyReuse,
    #[error("research round state conflict: {0}")]
    RoundState(&'static str),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

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

text_enum!(ResearchStatus {
    Open => "open",
    Resolved => "resolved",
});

text_enum!(AuthorKind {
    Researcher => "researcher",
    Agent => "agent",
    System => "system",
});

text_enum!(EntryKind {
    Note => "note",
    Decision => "decision",
    Proposal => "proposal",
    Observation => "observation",
});

text_enum!(LinkKind {
    Session => "session",
    Team => "team",
});

text_enum!(LinkRole {
    Discussion => "discussion",
    Execution => "execution",
});

text_enum!(SourceKind {
    Session => "session",
    Run => "run",
    Team => "team",
    TeamTask => "team_task",
    File => "file",
});

text_enum!(RoundKind {
    Team => "team",
    Solo => "solo",
});

// Durable setup phases of a round. Each transition is recorded before the
// next side effect, so a retry resumes instead of repeating (ADR 0212 §6).
text_enum!(RoundPhase {
    Created => "created",
    SessionReady => "session_ready",
    TeamCreated => "team_created",
    Started => "started",
});

text_enum!(SourceAvailability {
    Available => "available",
    Changed => "changed",
    Removed => "removed",
});

impl EntryKind {
    /// Kinds the browser (the researcher) may record directly.
    pub fn researcher_recordable(self) -> bool {
        matches!(self, Self::Note | Self::Decision)
    }
}

/// A typed pointer to another record. Research rows hold identifiers only;
/// they never embed the referenced content (ADR 0212 §5). A `file` source
/// records the content revision it was selected at, which is how a later
/// change is detected.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SourceRef {
    pub kind: SourceKind,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

pub const MAX_ROUND_SOURCES: usize = 20;
pub const MAX_INSTRUCTION_CHARS: usize = 4_000;

/// The approved research direction.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchBrief {
    pub title: String,
    pub question: String,
    #[serde(default)]
    pub motivation: String,
    #[serde(default)]
    pub hypotheses: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub evaluation_criteria: Vec<String>,
}

/// A partial brief edit; absent fields keep their current value.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct BriefPatch {
    pub title: Option<String>,
    pub question: Option<String>,
    pub motivation: Option<String>,
    pub hypotheses: Option<Vec<String>>,
    pub constraints: Option<Vec<String>>,
    pub evaluation_criteria: Option<Vec<String>>,
}

impl BriefPatch {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.question.is_none()
            && self.motivation.is_none()
            && self.hypotheses.is_none()
            && self.constraints.is_none()
            && self.evaluation_criteria.is_none()
    }
}

impl ResearchBrief {
    /// Applies a patch and returns the validated, normalized result.
    pub fn patched(&self, patch: &BriefPatch) -> Result<Self, ResearchError> {
        Self {
            title: patch.title.clone().unwrap_or_else(|| self.title.clone()),
            question: patch
                .question
                .clone()
                .unwrap_or_else(|| self.question.clone()),
            motivation: patch
                .motivation
                .clone()
                .unwrap_or_else(|| self.motivation.clone()),
            hypotheses: patch
                .hypotheses
                .clone()
                .unwrap_or_else(|| self.hypotheses.clone()),
            constraints: patch
                .constraints
                .clone()
                .unwrap_or_else(|| self.constraints.clone()),
            evaluation_criteria: patch
                .evaluation_criteria
                .clone()
                .unwrap_or_else(|| self.evaluation_criteria.clone()),
        }
        .normalized()
    }

    /// Trims text, drops blank list items, and enforces every bound.
    pub fn normalized(self) -> Result<Self, ResearchError> {
        let title = self.title.trim().to_owned();
        let question = self.question.trim().to_owned();
        let motivation = self.motivation.trim().to_owned();
        if title.is_empty() {
            return Err(ResearchError::Invalid("a title is required"));
        }
        if question.is_empty() {
            return Err(ResearchError::Invalid("a question is required"));
        }
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(ResearchError::Invalid("the title is too long"));
        }
        if question.chars().count() > MAX_QUESTION_CHARS {
            return Err(ResearchError::Invalid("the question is too long"));
        }
        if motivation.chars().count() > MAX_MOTIVATION_CHARS {
            return Err(ResearchError::Invalid("the motivation is too long"));
        }
        let hypotheses = normalize_list(self.hypotheses)?;
        let constraints = normalize_list(self.constraints)?;
        let evaluation_criteria = normalize_list(self.evaluation_criteria)?;
        let brief = Self {
            title,
            question,
            motivation,
            hypotheses,
            constraints,
            evaluation_criteria,
        };
        if serde_json::to_vec(&brief)?.len() > MAX_BRIEF_BYTES {
            return Err(ResearchError::Invalid("the brief is too large"));
        }
        Ok(brief)
    }
}

fn normalize_list(items: Vec<String>) -> Result<Vec<String>, ResearchError> {
    let items: Vec<String> = items
        .into_iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect();
    if items.len() > MAX_LIST_ITEMS {
        return Err(ResearchError::Invalid("too many list items"));
    }
    if items
        .iter()
        .any(|item| item.chars().count() > MAX_ITEM_CHARS)
    {
        return Err(ResearchError::Invalid("a list item is too long"));
    }
    Ok(items)
}

/// Normalizes an optional client idempotency key.
pub fn normalize_client_request_id(value: Option<&str>) -> Result<Option<String>, ResearchError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > MAX_CLIENT_REQUEST_ID_CHARS
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
    {
        return Err(ResearchError::Invalid("invalid client request id"));
    }
    Ok(Some(value.to_owned()))
}

/// The full current record of a research question.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchQuestion {
    pub id: String,
    pub project_id: String,
    pub status: ResearchStatus,
    pub archived: bool,
    /// Current brief revision; increases only when the brief changes.
    pub revision: u64,
    pub brief: ResearchBrief,
    pub created_at: String,
    pub updated_at: String,
    pub resolved_at: Option<String>,
}

/// A list row: enough to navigate without loading the brief body.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: ResearchStatus,
    pub archived: bool,
    pub revision: u64,
    pub entry_count: u64,
    pub link_count: u64,
    pub updated_at: String,
}

/// One immutable stored brief revision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BriefRevision {
    pub research_id: String,
    pub revision: u64,
    pub brief: ResearchBrief,
    pub author_kind: AuthorKind,
    pub author_ref: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RevisionSummary {
    pub revision: u64,
    pub title: String,
    pub author_kind: AuthorKind,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchEntry {
    pub id: String,
    pub research_id: String,
    pub seq: u64,
    pub kind: EntryKind,
    pub author_kind: AuthorKind,
    pub author_ref: Option<String>,
    pub body: String,
    /// The brief revision that was current when the entry was written.
    pub brief_revision: u64,
    pub created_at: String,
}

/// Input for a new entry.
#[derive(Clone, Debug)]
pub struct NewEntry {
    pub kind: EntryKind,
    pub author_kind: AuthorKind,
    pub author_ref: Option<String>,
    pub body: String,
    pub client_request_id: Option<String>,
}

/// One explicit request to do work for the question (ADR 0212 §6). It pins
/// the brief revision the work consumed and the validated setup request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchRound {
    pub id: String,
    pub research_id: String,
    /// 1-based, per question.
    pub round: u64,
    pub brief_revision: u64,
    pub kind: RoundKind,
    pub phase: RoundPhase,
    /// The Leader (Team) or Solo Session once it exists.
    pub session_id: Option<String>,
    pub team_id: Option<String>,
    /// The validated setup request exactly as authorized.
    pub request: serde_json::Value,
    pub sources: Vec<SourceRef>,
    pub created_at: String,
    pub updated_at: String,
}

/// Input for a new round.
#[derive(Clone, Debug)]
pub struct NewRound<'a> {
    pub kind: RoundKind,
    pub idempotency_key: &'a str,
    /// The brief revision the researcher was looking at.
    pub expected_revision: u64,
    pub request: serde_json::Value,
    pub sources: Vec<SourceRef>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchLink {
    pub research_id: String,
    pub kind: LinkKind,
    pub ref_id: String,
    pub role: LinkRole,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brief() -> ResearchBrief {
        ResearchBrief {
            title: "  Does pruning help?  ".into(),
            question: "Does structured pruning keep accuracy within 1%?".into(),
            motivation: String::new(),
            hypotheses: vec!["  H1  ".into(), "   ".into(), "H2".into()],
            constraints: vec![],
            evaluation_criteria: vec!["top-1 accuracy".into()],
        }
    }

    #[test]
    fn normalization_trims_and_drops_blank_items() {
        let normalized = brief().normalized().expect("valid");
        assert_eq!(normalized.title, "Does pruning help?");
        assert_eq!(normalized.hypotheses, vec!["H1", "H2"]);
    }

    #[test]
    fn bounds_are_enforced() {
        for broken in [
            ResearchBrief {
                title: "  ".into(),
                ..brief()
            },
            ResearchBrief {
                question: String::new(),
                ..brief()
            },
            ResearchBrief {
                title: "t".repeat(201),
                ..brief()
            },
            ResearchBrief {
                question: "q".repeat(4_001),
                ..brief()
            },
            ResearchBrief {
                motivation: "m".repeat(4_001),
                ..brief()
            },
            ResearchBrief {
                hypotheses: vec!["h".into(); 21],
                ..brief()
            },
            ResearchBrief {
                constraints: vec!["c".repeat(1_001)],
                ..brief()
            },
        ] {
            assert!(matches!(
                broken.normalized(),
                Err(ResearchError::Invalid(_))
            ));
        }
        // Many maximal items still fit under the size bound by construction
        // of the other limits; the aggregate guard is a backstop.
        let big = ResearchBrief {
            hypotheses: vec!["h".repeat(1_000); 20],
            constraints: vec!["c".repeat(1_000); 20],
            evaluation_criteria: vec!["e".repeat(1_000); 20],
            motivation: "m".repeat(4_000),
            ..brief()
        };
        assert!(matches!(
            big.normalized(),
            Err(ResearchError::Invalid("the brief is too large"))
        ));
    }

    #[test]
    fn patches_replace_only_the_provided_fields() {
        let base = brief().normalized().expect("valid");
        let patched = base
            .patched(&BriefPatch {
                constraints: Some(vec!["single GPU".into()]),
                ..BriefPatch::default()
            })
            .expect("patched");
        assert_eq!(patched.title, base.title);
        assert_eq!(patched.constraints, vec!["single GPU"]);
        assert!(BriefPatch::default().is_empty());
    }

    #[test]
    fn client_request_ids_are_bounded_tokens() {
        assert_eq!(normalize_client_request_id(None).unwrap(), None);
        assert_eq!(normalize_client_request_id(Some("  ")).unwrap(), None);
        assert_eq!(
            normalize_client_request_id(Some("req-1:a.b_c"))
                .unwrap()
                .as_deref(),
            Some("req-1:a.b_c")
        );
        assert!(normalize_client_request_id(Some("bad id")).is_err());
        assert!(normalize_client_request_id(Some(&"x".repeat(129))).is_err());
    }

    #[test]
    fn only_notes_and_decisions_are_researcher_recordable() {
        assert!(EntryKind::Note.researcher_recordable());
        assert!(EntryKind::Decision.researcher_recordable());
        assert!(!EntryKind::Proposal.researcher_recordable());
        assert!(!EntryKind::Observation.researcher_recordable());
        assert_eq!(EntryKind::parse("decision"), Some(EntryKind::Decision));
        assert_eq!(EntryKind::parse("nope"), None);
    }
}
