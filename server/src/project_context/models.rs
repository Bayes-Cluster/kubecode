//! Types of the Project context reader (ADR 0214). Everything is bounded:
//! summaries, section text, page sizes, and the cursor.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use crate::research_store::SourceAvailability as Availability;

pub const SUMMARY_CHARS: usize = 280;
pub const SECTION_CHARS: usize = 8 * 1024;
pub const DEFAULT_PAGE: usize = 20;
pub const MAX_PAGE: usize = 50;
pub const MAX_RESOLVE: usize = 32;
/// Candidates scanned per owner for one search.
pub const SCAN_CAP: usize = 200;
/// Candidates gathered across all owners for one search.
pub const CANDIDATE_BUDGET: usize = 2_000;
/// Directory entries one file search visits (ADR 0231 §1).
pub const FILE_SCAN_ENTRIES: usize = 5_000;
/// Files one search keeps, the most recently modified.
pub const FILE_HIT_CAP: usize = SCAN_CAP;
/// Characters in one whole document, across its sections.
pub const MAX_DOCUMENT_CHARS: usize = 32 * 1024;
pub const TURN_PAGE: usize = 10;
pub const MAX_ID_CHARS: usize = 512;

macro_rules! text_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(
            Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
        )]
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

text_enum!(ContextKind {
    Research => "research",
    Round => "round",
    Finding => "finding",
    Session => "session",
    SessionTurn => "session_turn",
    Team => "team",
    TeamTask => "team_task",
    Import => "import",
    Experiment => "experiment",
    Artifact => "artifact",
    Work => "work",
    Thread => "thread",
    Channel => "channel",
    File => "file",
});

impl ContextKind {
    /// What a search covers when it names no kinds: every kind except Project
    /// files, which are walked on disk only when a caller asks (ADR 0231 §1).
    pub const DEFAULT_SEARCH: &'static [ContextKind] = &[
        Self::Research,
        Self::Round,
        Self::Finding,
        Self::Session,
        Self::SessionTurn,
        Self::Team,
        Self::TeamTask,
        Self::Import,
        Self::Experiment,
        Self::Artifact,
        Self::Work,
        Self::Thread,
        Self::Channel,
    ];
}

text_enum!(Detail {
    Summary => "summary",
    Content => "content",
    Evidence => "evidence",
});

/// A typed pointer to an existing object. `revision` is a fingerprint, not a
/// snapshot: it detects change, it cannot restore old content.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ContextRef {
    pub kind: ContextKind,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

impl ContextRef {
    pub fn new(kind: ContextKind, id: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
            revision: None,
        }
    }

    pub fn at(kind: ContextKind, id: impl Into<String>, revision: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
            revision: Some(revision.into()),
        }
    }
}

/// Where an object came from and what it belongs to.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Provenance {
    /// Who produced it: `researcher`, `agent`, `system`, or a member name.
    pub author: Option<String>,
    pub updated_at: Option<String>,
    /// The research question it belongs to, when it does.
    pub research_id: Option<String>,
    /// Its enclosing object (a turn's Session, a task's Team, ...).
    pub parent: Option<ContextRef>,
    /// A short, kind-specific state (`open`, `exited`, `completed`, ...).
    pub state: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextItem {
    #[serde(rename = "ref")]
    pub reference: ContextRef,
    pub title: String,
    pub summary: String,
    pub provenance: Provenance,
    pub availability: Availability,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextPage {
    pub items: Vec<ContextItem>,
    pub next_cursor: Option<String>,
    /// Some kind was not searched completely: `truncated_kinds` is not empty.
    pub truncated: bool,
    /// The kinds this search covered, in declaration order.
    #[serde(default)]
    pub searched: Vec<ContextKind>,
    /// Searched kinds an owner's scan cap, the candidate budget, or the file
    /// walk's budget cut short: more of them may exist than were matched.
    #[serde(default)]
    pub truncated_kinds: Vec<ContextKind>,
    /// Matches per searched kind before paging (zero included); a lower bound
    /// for a truncated kind.
    #[serde(default)]
    pub counts: BTreeMap<ContextKind, usize>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Section {
    pub heading: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextDocument {
    /// The reference as read, with the **current** revision filled in.
    #[serde(rename = "ref")]
    pub reference: ContextRef,
    pub detail: Detail,
    pub title: String,
    /// `changed` when the reference carried a revision that no longer matches.
    pub availability: Availability,
    pub provenance: Provenance,
    pub sections: Vec<Section>,
    pub related: Vec<ContextItem>,
    pub next_cursor: Option<String>,
    /// Plain-language caveats: a newer brief exists, a turn is still running...
    pub notes: Vec<String>,
    /// The revision of the content the sections show: an older pinned brief,
    /// the bytes of a file page. `None` when nothing of the record is shown
    /// (removed, or changed while it was being paged).
    #[serde(default)]
    pub shown_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResolvedRef {
    #[serde(rename = "ref")]
    pub reference: ContextRef,
    pub availability: Availability,
    pub current_revision: Option<String>,
}

#[derive(Debug, Error)]
pub enum ContextError {
    /// Missing, or in another Project: indistinguishable by design.
    #[error("context source not found")]
    NotFound,
    #[error("invalid context request: {0}")]
    Invalid(&'static str),
    #[error("context source could not be read: {0}")]
    Source(String),
}

pub fn source_error(error: impl std::fmt::Display) -> ContextError {
    ContextError::Source(error.to_string())
}

/// Cuts text to `max` characters on a character boundary.
pub fn clip(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text.to_owned(), false);
    }
    (text.chars().take(max).collect(), true)
}

/// A one-line summary of at most `SUMMARY_CHARS` characters.
pub fn summarize(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let (clipped, truncated) = clip(&flat, SUMMARY_CHARS);
    if truncated {
        format!("{clipped}…")
    } else {
        clipped
    }
}
