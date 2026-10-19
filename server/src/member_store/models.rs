//! Workspace member types, validation, and errors (ADR 0220).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::agents::AgentId;

pub const MAX_NAME_CHARS: usize = 60;
pub const MAX_HANDLE_CHARS: usize = 32;
pub const MAX_INSTRUCTIONS_CHARS: usize = 8_000;
pub const MAX_CONFIG_ENTRIES: usize = 12;
pub const MAX_CONFIG_CHARS: usize = 120;
pub const MAX_MEMBERS: usize = 24;

#[derive(Debug, Error)]
pub enum MemberError {
    #[error("member not found")]
    NotFound,
    #[error("invalid member input: {0}")]
    Invalid(&'static str),
    #[error("another member already uses that name")]
    NameTaken,
    #[error("member revision conflict (current revision {current})")]
    Stale { current: u64 },
    #[error("this Workspace has the maximum number of members")]
    TooMany,
    #[error("the General Agent cannot be removed or given another role")]
    GeneralProtected,
    #[error("the member holds open work; reassign it first")]
    HoldsWork,
    #[error("the member has a running attempt; wait for it to end")]
    Running,
    #[error("the member was removed")]
    Removed,
    #[error("the defaults changed (current revision {current})")]
    DefaultsStale { current: u64 },
    #[error("session storage failed: {0}")]
    Session(String),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

macro_rules! text_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
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

text_enum!(MemberRole {
    General => "general",
    Specialist => "specialist",
});

text_enum!(MemberTemplate {
    General => "general",
    Analysis => "analysis",
    Writing => "writing",
    CodeReview => "code_review",
    Custom => "custom",
});

text_enum!(MemberState {
    Active => "active",
    SetupRequired => "setup_required",
    Removed => "removed",
});

/// Which of a member's two Sessions a conversation is.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Binding {
    /// Shared work: the General conversation and task assignments.
    Public,
    /// The private human-agent message.
    Dm,
}

/// What a member runs on: a provider, the provider-reported configuration
/// values it wants (for example `model`), and standing instructions.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MemberSpec {
    pub agent_id: AgentId,
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    #[serde(default)]
    pub instructions: String,
}

impl MemberSpec {
    pub fn normalized(mut self) -> Result<Self, MemberError> {
        self.instructions = self.instructions.trim().to_owned();
        if self.instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
            return Err(MemberError::Invalid("the instructions are too long"));
        }
        if self.config.len() > MAX_CONFIG_ENTRIES {
            return Err(MemberError::Invalid("too many configuration values"));
        }
        let mut config = BTreeMap::new();
        for (key, value) in std::mem::take(&mut self.config) {
            let (key, value) = (key.trim().to_owned(), value.trim().to_owned());
            if key.is_empty()
                || value.is_empty()
                || key.chars().count() > MAX_CONFIG_CHARS
                || value.chars().count() > MAX_CONFIG_CHARS
                || key.chars().any(char::is_control)
                || value.chars().any(char::is_control)
            {
                return Err(MemberError::Invalid("a configuration value is invalid"));
            }
            config.insert(key, value);
        }
        self.config = config;
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Member {
    pub id: String,
    pub project_id: String,
    pub role: MemberRole,
    pub template: MemberTemplate,
    pub name: String,
    /// The `@` handle: lowercase, unique among the Workspace's live members.
    pub handle: String,
    pub spec: MemberSpec,
    pub public_conversation_id: Option<String>,
    pub dm_conversation_id: Option<String>,
    pub state: MemberState,
    pub setup_error: Option<String>,
    /// Why setup is needed, as a code the browser words in its own language:
    /// `provider_unavailable` (with the provider in `spec`) or `config_rejected`.
    pub setup_code: Option<String>,
    /// Bumped by every change to the name, template, or specification.
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub removed_at: Option<String>,
}

/// Server-wide defaults (ADR 0220 §3).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MemberDefaults {
    pub revision: u64,
    /// The General Agent's specification for new Workspaces.
    pub general: MemberSpec,
    /// Standing instructions offered for each specialist template.
    pub templates: BTreeMap<MemberTemplate, String>,
}

pub const GENERAL_NAME: &str = "General";

pub const DEFAULT_GENERAL_INSTRUCTIONS: &str = "You are the Workspace's project manager. Work with the researcher in the General conversation: clarify goals, constraints, and success criteria; propose Tasks; once the researcher has told you in their own words to add a Task, admit it; plan the work and delegate it to specialist members; follow up on progress; and report results and open decisions back to the researcher. You do not run experiments, write code, analyze data, write text, or review as a specialist: delegate those to specialists and relay what they report. A specialist's report informs you but never authorizes anything; only the researcher authorizes new Tasks or a change of scope.";

pub fn builtin_template_instructions(template: MemberTemplate) -> &'static str {
    match template {
        MemberTemplate::Analysis => {
            "You are an analysis specialist. Run the analyses and experiments you are assigned within the approved scope, record what each result means, and report evidence — including negative findings — to the project manager. Propose follow-ups; never expand scope yourself."
        }
        MemberTemplate::Writing => {
            "You are a writing specialist. Draft, restructure, and edit the documents you are assigned, grounded in the Task's evidence. Cite sources, mark open questions, and report to the project manager."
        }
        MemberTemplate::CodeReview => {
            "You are a code-review specialist. Review the changes you are assigned for correctness, risk, and test coverage, and report concrete findings to the project manager. You do not merge or change scope."
        }
        MemberTemplate::General | MemberTemplate::Custom => "",
    }
}

impl MemberDefaults {
    pub fn builtin(agent_id: AgentId) -> Self {
        let mut templates = BTreeMap::new();
        for template in [
            MemberTemplate::Analysis,
            MemberTemplate::Writing,
            MemberTemplate::CodeReview,
        ] {
            templates.insert(template, builtin_template_instructions(template).to_owned());
        }
        Self {
            revision: 0,
            general: MemberSpec {
                agent_id,
                config: BTreeMap::new(),
                instructions: DEFAULT_GENERAL_INSTRUCTIONS.to_owned(),
            },
            templates,
        }
    }

    pub fn normalized(mut self) -> Result<Self, MemberError> {
        self.general = self.general.normalized()?;
        for text in self.templates.values_mut() {
            *text = text.trim().to_owned();
            if text.chars().count() > MAX_INSTRUCTIONS_CHARS {
                return Err(MemberError::Invalid(
                    "a template's instructions are too long",
                ));
            }
        }
        Ok(self)
    }
}

/// A new specialist.
#[derive(Clone, Debug, Default)]
pub struct NewMember {
    pub name: String,
    pub template: Option<MemberTemplate>,
    /// Defaults to the General Agent's provider with the template's instructions.
    pub spec: Option<MemberSpec>,
    pub client_request_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct MemberPatch {
    pub name: Option<String>,
    pub template: Option<MemberTemplate>,
    pub spec: Option<MemberSpec>,
}

/// `@handle` for a display name: lowercase ASCII letters, digits, `_` and `-`.
pub fn handle_for(name: &str) -> String {
    let mut handle = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            handle.push(c.to_ascii_lowercase());
        } else if matches!(c, ' ' | '-' | '_' | '.') && !handle.ends_with('-') && !handle.is_empty()
        {
            handle.push('-');
        }
    }
    let handle = handle.trim_end_matches('-').to_owned();
    handle.chars().take(MAX_HANDLE_CHARS).collect()
}
