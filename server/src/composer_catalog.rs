use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::agents::AgentId;

pub const MAX_ACP_COMMAND_NAME_BYTES: usize = 256;
pub const MAX_ACP_COMMAND_ARGUMENT_BYTES: usize = 8 * 1024;
const MAX_ACP_COMMAND_ITEMS: usize = 256;
pub const MAX_COMPOSER_ITEMS: usize = 256;
pub const MAX_COMPOSER_CONTEXTS: usize = 256;
pub const MAX_COMPOSER_SEGMENTS: usize = 128;
pub const MAX_COMPOSER_REFERENCES: usize = 32;
pub const MAX_COMPOSER_VALIDATION_ROWS: usize = 32;
pub const MAX_COMPOSER_TEXT_BYTES: usize = 128 * 1024;
const MAX_TRUSTED_COMPOSER_ITEMS: usize = 64;
const MAX_TRUSTED_SOURCE_IDENTITY_BYTES: usize = 512;
const MAX_TRUSTED_ITEM_NAME_BYTES: usize = 256;
const MAX_DESCRIPTION_CHARS: usize = 512;
const MAX_INPUT_HINT_CHARS: usize = 160;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposerItemKind {
    Command,
    Skill,
    PluginAction,
    ProviderApp,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposerItemScope {
    Session,
    Project,
    User,
    Bundled,
    Plugin,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposerContextKind {
    File,
    Directory,
    GitDiff,
    Terminal,
    SessionTurn,
    Diagnostics,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposerGitDiffScope {
    All,
    File,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComposerContextSummary {
    GitDiff {
        scope: ComposerGitDiffScope,
        file_count: usize,
        hunk_count: usize,
        byte_count: usize,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ComposerItem {
    pub id: String,
    pub kind: ComposerItemKind,
    pub name: String,
    pub description: Option<String>,
    pub source_label: String,
    pub scope: ComposerItemScope,
    pub input_hint: Option<String>,
    pub enabled: bool,
    pub disabled_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ComposerContextMeta {
    pub id: String,
    pub kind: ComposerContextKind,
    pub display: String,
    pub enabled: bool,
    pub disabled_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<ComposerContextSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComposerContextRecord {
    pub id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub kind: ComposerContextKind,
    pub path: String,
    pub available: bool,
    pub source_revision: Option<String>,
    pub summary: Option<ComposerContextSummary>,
}

impl ComposerContextRecord {
    pub fn safe_meta(&self) -> ComposerContextMeta {
        ComposerContextMeta {
            id: self.id.clone(),
            kind: self.kind,
            display: self.path.clone(),
            enabled: self.available,
            disabled_reason: (!self.available).then(|| "context_stale".to_owned()),
            summary: self.summary.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ComposerContextRegistration {
    pub context: ComposerContextMeta,
    pub catalog: ComposerCatalogSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ComposerContextValidationResult {
    pub id: String,
    pub catalog_revision: u64,
    pub context_kind: ComposerContextKind,
    pub available: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComposerContextSelector {
    pub id: String,
    pub catalog_revision: u64,
    pub context_kind: ComposerContextKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ComposerContextValidationResponse {
    pub references: Vec<ComposerContextValidationResult>,
    pub catalog: ComposerCatalogSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComposerPreflightContext {
    pub id: String,
    pub kind: ComposerContextKind,
    pub path: String,
    pub content: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComposerDraftSegment {
    Text {
        text: String,
    },
    ContextRef {
        id: String,
        catalog_revision: u64,
        context_kind: ComposerContextKind,
    },
    CapabilityRef {
        id: String,
        catalog_revision: u64,
        item_kind: ComposerItemKind,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ComposerCatalogSnapshot {
    pub conversation_id: String,
    pub revision: u64,
    pub items: Vec<ComposerItem>,
    pub contexts: Vec<ComposerContextMeta>,
}

impl ComposerCatalogSnapshot {
    pub fn empty(conversation_id: impl Into<String>) -> Self {
        Self {
            conversation_id: conversation_id.into(),
            revision: 0,
            items: Vec::new(),
            contexts: Vec::new(),
        }
    }

    pub fn same_contents(&self, other: &Self) -> bool {
        self.conversation_id == other.conversation_id
            && self.items == other.items
            && self.contexts == other.contexts
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcpCommandInput {
    None,
    Text { hint: Option<String> },
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpCommand {
    pub name: String,
    pub description: String,
    pub input: AcpCommandInput,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ComposerInvocation {
    AcpPromptTemplate {
        command_name: String,
    },
    AcpPrivateMethod {
        method: String,
        payload: Value,
    },
    ProviderStructuredInput {
        adapter_kind: String,
        payload: Value,
    },
    HostAction {
        action: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedComposerDispatch {
    pub display_message: String,
    pub prompt_message: String,
    pub provider_input: Option<ComposerInvocation>,
}

#[derive(Clone, Debug)]
pub struct TrustedComposerContribution {
    pub kind: ComposerItemKind,
    pub source_identity: String,
    pub name: String,
    pub description: Option<String>,
    pub source_label: String,
    pub scope: ComposerItemScope,
    pub input_hint: Option<String>,
    pub disabled_reason: Option<String>,
    pub invocation: Option<ComposerInvocation>,
}

pub trait TrustedComposerCatalogAdapter: Send + Sync {
    fn contributions(
        &self,
        project_id: &str,
        conversation_id: &str,
        agent_id: AgentId,
    ) -> Vec<TrustedComposerContribution>;
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ComposerCatalogError {
    #[error("catalog revision is stale")]
    StaleRevision,
    #[error("catalog item is missing")]
    ItemMissing,
    #[error("catalog item is disabled")]
    ItemDisabled,
    #[error("catalog item invocation is unsupported")]
    ItemUnsupported,
    #[error("command is unavailable")]
    CommandUnavailable,
    #[error("command name is ambiguous")]
    CommandAmbiguous,
    #[error("command input is unsupported")]
    InputUnsupported,
    #[error("command input is required")]
    InputRequired,
    #[error("command input is unexpected")]
    UnexpectedInput,
    #[error("command input is too long")]
    ArgumentsTooLong,
    #[error("composer context is stale or missing")]
    ContextStale,
    #[error("composer context limit exceeded")]
    ContextOverLimit,
    #[error("composer draft segment limit exceeded")]
    SegmentsOverLimit,
    #[error("composer draft text is too long")]
    TextTooLong,
    #[error("composer draft is invalid")]
    InvalidDraft,
}

pub fn validate_structured_composer_segments(
    segments: &[ComposerDraftSegment],
) -> Result<(), ComposerCatalogError> {
    if segments.len() > MAX_COMPOSER_SEGMENTS {
        return Err(ComposerCatalogError::SegmentsOverLimit);
    }
    let reference_count = segments
        .iter()
        .filter(|segment| !matches!(segment, ComposerDraftSegment::Text { .. }))
        .count();
    if reference_count > MAX_COMPOSER_REFERENCES {
        return Err(ComposerCatalogError::ContextOverLimit);
    }
    let text_bytes = segments.iter().try_fold(0_usize, |total, segment| {
        let bytes = match segment {
            ComposerDraftSegment::Text { text } => text.len(),
            ComposerDraftSegment::ContextRef { .. }
            | ComposerDraftSegment::CapabilityRef { .. } => 0,
        };
        total
            .checked_add(bytes)
            .ok_or(ComposerCatalogError::TextTooLong)
    })?;
    if text_bytes > MAX_COMPOSER_TEXT_BYTES {
        return Err(ComposerCatalogError::TextTooLong);
    }
    Ok(())
}

pub fn valid_acp_command_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ACP_COMMAND_NAME_BYTES
        && name.chars().all(|character| {
            !character.is_control() && !character.is_whitespace() && character != '/'
        })
}

pub fn parse_available_commands(payload: &Value) -> Vec<AcpCommand> {
    payload
        .get("availableCommands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_ACP_COMMAND_ITEMS)
        .filter_map(|value| {
            let command = value.as_object()?;
            let name = command.get("name")?.as_str()?;
            if !valid_acp_command_name(name) {
                return None;
            }
            let description = command.get("description")?.as_str()?;
            let input = match command.get("input") {
                None | Some(Value::Null) => AcpCommandInput::None,
                Some(Value::Object(input)) => {
                    let kind = input.get("type").and_then(Value::as_str);
                    let hint = input.get("hint");
                    match (kind, hint) {
                        (None | Some("text"), None) => AcpCommandInput::Text { hint: None },
                        (None | Some("text"), Some(Value::String(hint))) => AcpCommandInput::Text {
                            hint: Some(hint.to_owned()),
                        },
                        _ => AcpCommandInput::Unsupported,
                    }
                }
                Some(_) => AcpCommandInput::Unsupported,
            };
            Some(AcpCommand {
                name: name.to_owned(),
                description: description.to_owned(),
                input,
            })
        })
        .collect()
}

pub fn project_available_commands(payload: &Value) -> Value {
    let available_commands = parse_available_commands(payload)
        .into_iter()
        .map(|command| {
            let input = match command.input {
                AcpCommandInput::None => Value::Null,
                AcpCommandInput::Text { hint: Some(hint) } => {
                    json!({"kind":"text", "hint":truncate_display(&hint, MAX_INPUT_HINT_CHARS)})
                }
                AcpCommandInput::Text { hint: None } => json!({"kind":"text"}),
                AcpCommandInput::Unsupported => json!({"kind":"unsupported"}),
            };
            json!({
                "name": command.name,
                "description": truncate_display(&command.description, MAX_DESCRIPTION_CHARS),
                "input": input,
            })
        })
        .collect::<Vec<_>>();
    json!({"availableCommands": available_commands})
}

pub fn project_acp_catalog(
    project_id: &str,
    conversation_id: &str,
    agent_id: AgentId,
    revision: u64,
    payload: &Value,
) -> ComposerCatalogSnapshot {
    project_acp_catalog_with_contexts(
        project_id,
        conversation_id,
        agent_id,
        revision,
        payload,
        Vec::new(),
    )
}

pub fn project_acp_catalog_with_contexts(
    project_id: &str,
    conversation_id: &str,
    agent_id: AgentId,
    revision: u64,
    payload: &Value,
    contexts: Vec<ComposerContextMeta>,
) -> ComposerCatalogSnapshot {
    let trusted = trusted_contributions_from_payload(agent_id, payload);
    let mut snapshot = project_catalog_with_trusted(
        project_id,
        conversation_id,
        agent_id,
        revision,
        payload,
        &trusted,
    );
    snapshot.contexts = contexts.into_iter().take(MAX_COMPOSER_CONTEXTS).collect();
    snapshot
}

pub fn project_catalog_with_trusted(
    project_id: &str,
    conversation_id: &str,
    agent_id: AgentId,
    revision: u64,
    payload: &Value,
    trusted: &[TrustedComposerContribution],
) -> ComposerCatalogSnapshot {
    let reclassified_commands = trusted
        .iter()
        .filter(|contribution| {
            valid_trusted_source_identity(&contribution.source_identity)
                && valid_trusted_item_name(&contribution.name)
        })
        .filter_map(
            |contribution| match (&contribution.kind, &contribution.invocation) {
                (
                    ComposerItemKind::Skill,
                    Some(ComposerInvocation::AcpPromptTemplate { command_name }),
                ) => Some(command_name.as_str()),
                _ => None,
            },
        )
        .collect::<BTreeSet<_>>();
    let commands = parse_available_commands(payload)
        .into_iter()
        .filter(|command| !reclassified_commands.contains(command.name.as_str()))
        .collect::<Vec<_>>();
    let mut counts = BTreeMap::new();
    for command in &commands {
        *counts.entry(command.name.clone()).or_insert(0_usize) += 1;
    }
    let mut emitted = BTreeSet::new();
    let mut items = Vec::new();
    for command in commands {
        if !emitted.insert(command.name.clone()) {
            continue;
        }
        let duplicate = counts.get(&command.name).copied().unwrap_or(0) > 1;
        let unsupported = matches!(command.input, AcpCommandInput::Unsupported);
        let disabled_reason = if duplicate {
            Some("ambiguous_source_identity".to_owned())
        } else if unsupported {
            Some("unsupported_input".to_owned())
        } else {
            None
        };
        let input_hint = match &command.input {
            AcpCommandInput::Text { hint } => hint
                .as_deref()
                .map(|hint| truncate_display(hint, MAX_INPUT_HINT_CHARS)),
            AcpCommandInput::None | AcpCommandInput::Unsupported => None,
        };
        items.push(ComposerItem {
            id: opaque_command_id(project_id, conversation_id, agent_id, &command.name),
            kind: ComposerItemKind::Command,
            name: command.name,
            description: Some(truncate_display(
                &command.description,
                MAX_DESCRIPTION_CHARS,
            )),
            source_label: agent_source_label(agent_id).to_owned(),
            scope: ComposerItemScope::Session,
            input_hint,
            enabled: disabled_reason.is_none(),
            disabled_reason,
        });
    }
    let trusted_limit =
        MAX_TRUSTED_COMPOSER_ITEMS.min(MAX_COMPOSER_ITEMS.saturating_sub(items.len()));
    let trusted = trusted
        .iter()
        .take(MAX_TRUSTED_COMPOSER_ITEMS)
        .filter(|contribution| {
            valid_trusted_source_identity(&contribution.source_identity)
                && valid_trusted_item_name(&contribution.name)
        })
        .take(trusted_limit)
        .collect::<Vec<_>>();
    let mut trusted_counts = BTreeMap::new();
    for contribution in &trusted {
        *trusted_counts
            .entry((
                item_kind_key(contribution.kind),
                contribution.source_identity.clone(),
            ))
            .or_insert(0_usize) += 1;
    }
    let mut trusted_emitted = BTreeSet::new();
    for contribution in trusted {
        let identity = (
            item_kind_key(contribution.kind),
            contribution.source_identity.clone(),
        );
        if !trusted_emitted.insert(identity.clone()) {
            continue;
        }
        let duplicate = trusted_counts.get(&identity).copied().unwrap_or(0) > 1;
        let unsupported_command = contribution.kind == ComposerItemKind::Command;
        let enabled = !duplicate
            && !unsupported_command
            && contribution.disabled_reason.is_none()
            && contribution.invocation.is_some();
        let disabled_reason = if duplicate {
            Some("ambiguous_source_identity".to_owned())
        } else if unsupported_command {
            Some("unsupported_invocation".to_owned())
        } else if let Some(reason) = &contribution.disabled_reason {
            Some(truncate_display(reason, MAX_INPUT_HINT_CHARS))
        } else if contribution.invocation.is_none() {
            Some("invocation_unavailable".to_owned())
        } else {
            None
        };
        items.push(ComposerItem {
            id: opaque_item_id(
                item_id_prefix(contribution.kind),
                project_id,
                conversation_id,
                agent_id,
                contribution.kind,
                "trusted-adapter",
                &contribution.source_identity,
            ),
            kind: contribution.kind,
            name: contribution.name.clone(),
            description: contribution
                .description
                .as_deref()
                .map(|value| truncate_display(value, MAX_DESCRIPTION_CHARS)),
            source_label: truncate_display(&contribution.source_label, MAX_INPUT_HINT_CHARS),
            scope: contribution.scope,
            input_hint: contribution
                .input_hint
                .as_deref()
                .map(|value| truncate_display(value, MAX_INPUT_HINT_CHARS)),
            enabled,
            disabled_reason,
        });
    }
    ComposerCatalogSnapshot {
        conversation_id: conversation_id.to_owned(),
        revision,
        items,
        contexts: Vec::new(),
    }
}

fn trusted_contributions_from_payload(
    agent_id: AgentId,
    payload: &Value,
) -> Vec<TrustedComposerContribution> {
    match agent_id {
        AgentId::ClaudeCode => claude_skill_contributions(payload),
        AgentId::Codex => codex_skill_contributions(payload),
        AgentId::OpenCode => Vec::new(),
    }
}

fn claude_skill_contributions(payload: &Value) -> Vec<TrustedComposerContribution> {
    let Some(metadata) = payload
        .get("_meta")
        .and_then(|value| value.get("kubecode"))
        .and_then(|value| value.get("claudeSkills"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    if metadata.get("version").and_then(Value::as_u64) != Some(1)
        || metadata.get("supported").and_then(Value::as_bool) != Some(true)
    {
        return Vec::new();
    }
    let commands = parse_available_commands(payload);
    metadata
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_TRUSTED_COMPOSER_ITEMS)
        .filter_map(|value| {
            let skill = value.as_object()?;
            let source_identity = skill.get("identity")?.as_str()?.to_owned();
            let name = skill.get("name")?.as_str()?.to_owned();
            let scope = match skill.get("scope")?.as_str()? {
                "session" => ComposerItemScope::Session,
                "project" => ComposerItemScope::Project,
                "user" => ComposerItemScope::User,
                "bundled" => ComposerItemScope::Bundled,
                "plugin" => ComposerItemScope::Plugin,
                _ => return None,
            };
            let source_label = skill.get("sourceLabel")?.as_str()?.to_owned();
            let enabled = skill.get("enabled").and_then(Value::as_bool) == Some(true);
            let matching = commands
                .iter()
                .filter(|command| command.name == source_identity)
                .collect::<Vec<_>>();
            let command_reason = match matching.as_slice() {
                [] => Some("command_unavailable".to_owned()),
                [command] if matches!(command.input, AcpCommandInput::Unsupported) => {
                    Some("unsupported_input".to_owned())
                }
                [_] => None,
                _ => Some("ambiguous_source_identity".to_owned()),
            };
            let disabled_reason = if enabled {
                command_reason
            } else {
                skill
                    .get("disabledReason")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| Some("provider_disabled".to_owned()))
            };
            Some(TrustedComposerContribution {
                kind: ComposerItemKind::Skill,
                source_identity: source_identity.clone(),
                name,
                description: skill
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                source_label,
                scope,
                input_hint: skill
                    .get("inputHint")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                disabled_reason,
                invocation: Some(ComposerInvocation::AcpPromptTemplate {
                    command_name: source_identity,
                }),
            })
        })
        .collect()
}

fn codex_skill_contributions(payload: &Value) -> Vec<TrustedComposerContribution> {
    let Some(metadata) = payload
        .get("_meta")
        .and_then(|value| value.get("kubecode"))
        .and_then(|value| value.get("codexSkills"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    if metadata.get("version").and_then(Value::as_u64) != Some(1)
        || metadata.get("supported").and_then(Value::as_bool) != Some(true)
        || metadata.get("structuredInput").and_then(Value::as_bool) != Some(true)
        || metadata.get("textFallback").and_then(Value::as_bool) != Some(false)
    {
        return Vec::new();
    }
    metadata
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_TRUSTED_COMPOSER_ITEMS)
        .filter_map(|value| {
            let skill = value.as_object()?;
            let source_identity = skill.get("identity")?.as_str()?.to_owned();
            let path = skill.get("path")?.as_str()?.to_owned();
            if source_identity != path || !Path::new(&path).is_absolute() {
                return None;
            }
            let name = skill.get("name")?.as_str()?.to_owned();
            let (scope, source_label) = match skill.get("providerScope")?.as_str()? {
                "repo" => (ComposerItemScope::Project, "Project skill"),
                "user" => (ComposerItemScope::User, "User skill"),
                "system" => (ComposerItemScope::Bundled, "System skill"),
                "admin" => (ComposerItemScope::Bundled, "Admin skill"),
                "bundled" => (ComposerItemScope::Bundled, "Bundled skill"),
                "plugin" => (ComposerItemScope::Plugin, "Plugin skill"),
                _ => return None,
            };
            let enabled = skill.get("enabled").and_then(Value::as_bool) == Some(true);
            Some(TrustedComposerContribution {
                kind: ComposerItemKind::Skill,
                source_identity,
                name: name.clone(),
                description: skill
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                source_label: source_label.to_owned(),
                scope,
                input_hint: None,
                disabled_reason: if enabled {
                    None
                } else {
                    Some("provider_disabled".to_owned())
                },
                invocation: Some(ComposerInvocation::ProviderStructuredInput {
                    adapter_kind: "codex".to_owned(),
                    payload: json!({"type":"skill", "name":name, "path":path}),
                }),
            })
        })
        .collect()
}

fn valid_trusted_source_identity(identity: &str) -> bool {
    !identity.trim().is_empty()
        && identity.len() <= MAX_TRUSTED_SOURCE_IDENTITY_BYTES
        && identity.chars().all(|character| !character.is_control())
}

fn valid_trusted_item_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= MAX_TRUSTED_ITEM_NAME_BYTES
        && name.chars().all(|character| !character.is_control())
}

pub fn resolve_acp_catalog_item(
    snapshot: &ComposerCatalogSnapshot,
    raw_commands: &Value,
    expected_revision: u64,
    item_id: &str,
    arguments: &str,
) -> Result<String, ComposerCatalogError> {
    if arguments.len() > MAX_ACP_COMMAND_ARGUMENT_BYTES {
        return Err(ComposerCatalogError::ArgumentsTooLong);
    }
    if snapshot.revision != expected_revision {
        return Err(ComposerCatalogError::StaleRevision);
    }
    let item = snapshot
        .items
        .iter()
        .find(|item| item.id == item_id)
        .ok_or(ComposerCatalogError::ItemMissing)?;
    if !item.enabled {
        return Err(ComposerCatalogError::ItemDisabled);
    }
    if item.kind != ComposerItemKind::Command {
        return Err(ComposerCatalogError::ItemUnsupported);
    }
    resolve_acp_command_message(raw_commands, &item.name, arguments.trim())
}

#[allow(clippy::too_many_arguments)]
pub fn resolve_composer_catalog_item(
    project_id: &str,
    conversation_id: &str,
    agent_id: AgentId,
    snapshot: &ComposerCatalogSnapshot,
    raw_commands: &Value,
    expected_revision: u64,
    item_id: &str,
    arguments: &str,
) -> Result<String, ComposerCatalogError> {
    resolve_composer_catalog_dispatch(
        project_id,
        conversation_id,
        agent_id,
        snapshot,
        raw_commands,
        expected_revision,
        item_id,
        arguments,
    )
    .map(|dispatch| dispatch.display_message)
}

#[allow(clippy::too_many_arguments)]
pub fn resolve_composer_catalog_dispatch(
    project_id: &str,
    conversation_id: &str,
    agent_id: AgentId,
    snapshot: &ComposerCatalogSnapshot,
    raw_commands: &Value,
    expected_revision: u64,
    item_id: &str,
    arguments: &str,
) -> Result<ResolvedComposerDispatch, ComposerCatalogError> {
    if arguments.len() > MAX_ACP_COMMAND_ARGUMENT_BYTES {
        return Err(ComposerCatalogError::ArgumentsTooLong);
    }
    if snapshot.revision != expected_revision {
        return Err(ComposerCatalogError::StaleRevision);
    }
    let item = snapshot
        .items
        .iter()
        .find(|item| item.id == item_id)
        .ok_or(ComposerCatalogError::ItemMissing)?;
    if !item.enabled {
        return Err(ComposerCatalogError::ItemDisabled);
    }
    if item.kind == ComposerItemKind::Command {
        let message = resolve_acp_catalog_item(
            snapshot,
            raw_commands,
            expected_revision,
            item_id,
            arguments,
        )?;
        return Ok(ResolvedComposerDispatch {
            display_message: message.clone(),
            prompt_message: message,
            provider_input: None,
        });
    }
    if item.kind != ComposerItemKind::Skill
        || !matches!(agent_id, AgentId::ClaudeCode | AgentId::Codex)
    {
        return Err(ComposerCatalogError::ItemUnsupported);
    }
    let contributions = trusted_contributions_from_payload(agent_id, raw_commands);
    let mut matches = contributions.iter().filter(|contribution| {
        opaque_item_id(
            item_id_prefix(contribution.kind),
            project_id,
            conversation_id,
            agent_id,
            contribution.kind,
            "trusted-adapter",
            &contribution.source_identity,
        ) == item_id
    });
    let contribution = matches.next().ok_or(ComposerCatalogError::ItemMissing)?;
    if matches.next().is_some() {
        return Err(ComposerCatalogError::ItemDisabled);
    }
    if contribution.disabled_reason.is_some() {
        return Err(ComposerCatalogError::ItemDisabled);
    }
    match &contribution.invocation {
        Some(ComposerInvocation::AcpPromptTemplate { command_name }) => {
            let message =
                resolve_acp_command_message(raw_commands, command_name, arguments.trim())?;
            Ok(ResolvedComposerDispatch {
                display_message: message.clone(),
                prompt_message: message,
                provider_input: None,
            })
        }
        Some(input @ ComposerInvocation::ProviderStructuredInput { adapter_kind, .. })
            if agent_id == AgentId::Codex && adapter_kind == "codex" =>
        {
            let arguments = arguments.trim();
            let display_message = if arguments.is_empty() {
                format!("${}", contribution.name)
            } else {
                format!("${} {arguments}", contribution.name)
            };
            Ok(ResolvedComposerDispatch {
                display_message,
                prompt_message: arguments.to_owned(),
                provider_input: Some(input.clone()),
            })
        }
        Some(
            ComposerInvocation::AcpPrivateMethod { .. }
            | ComposerInvocation::ProviderStructuredInput { .. }
            | ComposerInvocation::HostAction { .. },
        )
        | None => Err(ComposerCatalogError::ItemUnsupported),
    }
}

pub fn resolve_acp_command_message(
    payload: &Value,
    name: &str,
    arguments: &str,
) -> Result<String, ComposerCatalogError> {
    let matches = parse_available_commands(payload)
        .into_iter()
        .filter(|command| command.name == name)
        .collect::<Vec<_>>();
    let command = match matches.as_slice() {
        [] => return Err(ComposerCatalogError::CommandUnavailable),
        [command] => command,
        _ => return Err(ComposerCatalogError::CommandAmbiguous),
    };
    match command.input {
        AcpCommandInput::None if !arguments.is_empty() => {
            return Err(ComposerCatalogError::UnexpectedInput);
        }
        AcpCommandInput::Text { .. } if arguments.is_empty() => {
            return Err(ComposerCatalogError::InputRequired);
        }
        AcpCommandInput::Unsupported => return Err(ComposerCatalogError::InputUnsupported),
        AcpCommandInput::None | AcpCommandInput::Text { .. } => {}
    }
    Ok(if arguments.is_empty() {
        format!("/{name}")
    } else {
        format!("/{name} {arguments}")
    })
}

fn opaque_command_id(
    project_id: &str,
    conversation_id: &str,
    agent_id: AgentId,
    source_identity: &str,
) -> String {
    opaque_item_id(
        "cmd",
        project_id,
        conversation_id,
        agent_id,
        ComposerItemKind::Command,
        "standard-acp",
        source_identity,
    )
}

pub fn opaque_context_id(
    project_id: &str,
    conversation_id: &str,
    kind: ComposerContextKind,
    normalized_relative_path: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"kubecode-composer-context-v1\0");
    for part in [
        project_id,
        conversation_id,
        context_kind_key(kind),
        normalized_relative_path,
    ] {
        digest.update(part.len().to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("ctx:{}", hex::encode(digest.finalize()))
}

pub fn opaque_git_diff_context_id(
    project_id: &str,
    conversation_id: &str,
    selector: &str,
    source_revision: &str,
) -> String {
    opaque_context_id(
        project_id,
        conversation_id,
        ComposerContextKind::GitDiff,
        &format!("{selector}\0{source_revision}"),
    )
}

pub fn context_kind_key(kind: ComposerContextKind) -> &'static str {
    match kind {
        ComposerContextKind::File => "file",
        ComposerContextKind::Directory => "directory",
        ComposerContextKind::GitDiff => "git_diff",
        ComposerContextKind::Terminal => "terminal",
        ComposerContextKind::SessionTurn => "session_turn",
        ComposerContextKind::Diagnostics => "diagnostics",
    }
}

pub fn parse_context_kind(value: &str) -> Option<ComposerContextKind> {
    match value {
        "file" => Some(ComposerContextKind::File),
        "directory" => Some(ComposerContextKind::Directory),
        "git_diff" => Some(ComposerContextKind::GitDiff),
        "terminal" => Some(ComposerContextKind::Terminal),
        "session_turn" => Some(ComposerContextKind::SessionTurn),
        "diagnostics" => Some(ComposerContextKind::Diagnostics),
        _ => None,
    }
}

fn opaque_item_id(
    prefix: &str,
    project_id: &str,
    conversation_id: &str,
    agent_id: AgentId,
    kind: ComposerItemKind,
    source_kind: &str,
    source_identity: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"kubecode-composer-item-v1\0");
    for part in [
        item_kind_key(kind),
        source_kind,
        project_id,
        conversation_id,
        agent_id.as_str(),
        source_identity,
    ] {
        digest.update(part.len().to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("{prefix}:{}", hex::encode(digest.finalize()))
}

fn item_id_prefix(kind: ComposerItemKind) -> &'static str {
    match kind {
        ComposerItemKind::Command => "cmd",
        ComposerItemKind::Skill | ComposerItemKind::ProviderApp => "cap",
        ComposerItemKind::PluginAction => "plugin",
    }
}

fn item_kind_key(kind: ComposerItemKind) -> &'static str {
    match kind {
        ComposerItemKind::Command => "command",
        ComposerItemKind::Skill => "skill",
        ComposerItemKind::PluginAction => "plugin_action",
        ComposerItemKind::ProviderApp => "provider_app",
    }
}

fn agent_source_label(agent_id: AgentId) -> &'static str {
    match agent_id {
        AgentId::ClaudeCode => "Claude Code command",
        AgentId::Codex => "Codex command",
        AgentId::OpenCode => "OpenCode command",
    }
}

fn truncate_display(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_safe_bounded_catalog_with_collision_safe_identity() {
        let raw = json!({
            "availableCommands": [
                {"name":"review", "description":"Review", "input":{"hint":"focus"}, "_meta":{"method":"secret"}},
                {"name":"duplicate", "description":"One"},
                {"name":"duplicate", "description":"Two"},
                {"name":"future", "description":"Future", "input":{"type":"choices"}},
                {"name":"bad name", "description":"Invalid"}
            ],
            "_meta":{"private":"preserved elsewhere"}
        });
        let first = project_acp_catalog("project-a", "session-a", AgentId::Codex, 1, &raw);
        let other_session = project_acp_catalog("project-a", "session-b", AgentId::Codex, 1, &raw);
        let other_project = project_acp_catalog("project-b", "session-a", AgentId::Codex, 1, &raw);

        assert_eq!(first.items.len(), 3);
        assert_ne!(first.items[0].id, other_session.items[0].id);
        assert_ne!(first.items[0].id, other_project.items[0].id);
        assert!(first.items[0].enabled);
        assert_eq!(
            first.items[1].disabled_reason.as_deref(),
            Some("ambiguous_source_identity")
        );
        assert_eq!(
            first.items[2].disabled_reason.as_deref(),
            Some("unsupported_input")
        );
        let serialized = serde_json::to_value(&first).expect("catalog JSON");
        assert!(serialized.to_string().find("secret").is_none());
        assert!(serialized.to_string().find("method").is_none());
    }

    #[test]
    fn stale_missing_and_disabled_items_never_resolve() {
        let raw = json!({"availableCommands":[
            {"name":"status", "description":"Status"},
            {"name":"future", "description":"Future", "input":{"type":"choices"}}
        ]});
        let snapshot = project_acp_catalog("project", "session", AgentId::OpenCode, 7, &raw);
        assert_eq!(
            resolve_acp_catalog_item(&snapshot, &raw, 6, &snapshot.items[0].id, ""),
            Err(ComposerCatalogError::StaleRevision)
        );
        assert_eq!(
            resolve_acp_catalog_item(&snapshot, &raw, 7, "cmd:invented", ""),
            Err(ComposerCatalogError::ItemMissing)
        );
        assert_eq!(
            resolve_acp_catalog_item(&snapshot, &raw, 7, &snapshot.items[1].id, ""),
            Err(ComposerCatalogError::ItemDisabled)
        );
        assert_eq!(
            resolve_acp_catalog_item(&snapshot, &raw, 7, &snapshot.items[0].id, ""),
            Ok("/status".to_owned())
        );
    }

    #[test]
    fn bounds_never_truncate_identity_or_enable_omitted_rows() {
        let mut rows = (0..MAX_ACP_COMMAND_ITEMS)
            .map(|index| {
                json!({
                    "name": format!("command-{index}"),
                    "description": "é".repeat(MAX_DESCRIPTION_CHARS + 20)
                })
            })
            .collect::<Vec<_>>();
        rows.push(json!({"name":"beyond-cap", "description":"Omitted"}));
        rows.push(json!({
            "name":"x".repeat(MAX_ACP_COMMAND_NAME_BYTES + 1),
            "description":"Overlong identity"
        }));
        let raw = json!({"availableCommands":rows});
        let snapshot = project_acp_catalog("project", "session", AgentId::Codex, 1, &raw);

        assert_eq!(snapshot.items.len(), MAX_ACP_COMMAND_ITEMS);
        assert_eq!(snapshot.items[0].name, "command-0");
        assert_eq!(
            snapshot.items[0]
                .description
                .as_deref()
                .expect("description")
                .chars()
                .count(),
            MAX_DESCRIPTION_CHARS
        );
        assert!(snapshot.items.iter().all(|item| item.name != "beyond-cap"));
        let overlong = json!({"availableCommands":[{
            "name":"x".repeat(MAX_ACP_COMMAND_NAME_BYTES + 1),
            "description":"Overlong identity"
        }]});
        assert!(
            project_acp_catalog("project", "session", AgentId::Codex, 1, &overlong)
                .items
                .is_empty()
        );
        assert_eq!(
            resolve_acp_catalog_item(&snapshot, &raw, 1, "cmd:invented", ""),
            Err(ComposerCatalogError::ItemMissing)
        );
    }

    #[test]
    fn trusted_capability_gap_is_disabled_without_inference() {
        let snapshot = project_catalog_with_trusted(
            "project",
            "session",
            AgentId::ClaudeCode,
            1,
            &json!({"availableCommands":[]}),
            &[TrustedComposerContribution {
                kind: ComposerItemKind::Skill,
                source_identity: "provider-skill-id".to_owned(),
                name: "Review".to_owned(),
                description: Some("Trusted inventory row".to_owned()),
                source_label: "Claude skill".to_owned(),
                scope: ComposerItemScope::Session,
                input_hint: None,
                disabled_reason: None,
                invocation: None,
            }],
        );

        assert_eq!(snapshot.items.len(), 1);
        assert!(snapshot.items[0].id.starts_with("cap:"));
        assert!(!snapshot.items[0].enabled);
        assert_eq!(
            snapshot.items[0].disabled_reason.as_deref(),
            Some("invocation_unavailable")
        );
    }

    #[test]
    fn claude_skill_metadata_reclassifies_and_resolves_the_exact_command() {
        let raw = json!({
            "availableCommands": [
                {"name":"review", "description":"Review code", "input":{"hint":"<path>"}},
                {"name":"status", "description":"Show status"}
            ],
            "_meta": {"kubecode":{"claudeSkills":{
                "version": 1,
                "supported": true,
                "skills": [{
                    "identity":"review",
                    "name":"review",
                    "description":"Review code",
                    "inputHint":"<path>",
                    "scope":"project",
                    "sourceLabel":"Project skill",
                    "enabled":true
                }]
            }}}
        });
        let snapshot = project_acp_catalog("project", "session", AgentId::ClaudeCode, 7, &raw);

        assert_eq!(snapshot.items.len(), 2);
        let skill = snapshot
            .items
            .iter()
            .find(|item| item.kind == ComposerItemKind::Skill)
            .expect("Claude skill");
        assert_eq!(skill.name, "review");
        assert_eq!(skill.scope, ComposerItemScope::Project);
        assert_eq!(skill.source_label, "Project skill");
        assert_eq!(skill.input_hint.as_deref(), Some("<path>"));
        assert!(skill.enabled);
        assert!(skill.id.starts_with("cap:"));
        assert!(
            snapshot
                .items
                .iter()
                .any(|item| { item.kind == ComposerItemKind::Command && item.name == "status" })
        );
        assert!(
            !snapshot
                .items
                .iter()
                .any(|item| { item.kind == ComposerItemKind::Command && item.name == "review" })
        );
        assert_eq!(
            resolve_composer_catalog_item(
                "project",
                "session",
                AgentId::ClaudeCode,
                &snapshot,
                &raw,
                7,
                &skill.id,
                "src/lib.rs"
            ),
            Ok("/review src/lib.rs".to_owned())
        );
    }

    #[test]
    fn claude_skill_metadata_is_ignored_for_other_agents() {
        let raw = json!({
            "availableCommands": [{"name":"review", "description":"Review code"}],
            "_meta": {"kubecode":{"claudeSkills":{
                "version": 1,
                "supported": true,
                "skills": [{
                    "identity":"review", "name":"review", "scope":"user",
                    "sourceLabel":"User skill", "enabled":true
                }]
            }}}
        });

        let snapshot = project_acp_catalog("project", "session", AgentId::Codex, 1, &raw);
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].kind, ComposerItemKind::Command);
    }

    #[test]
    fn opencode_never_infers_capabilities_from_undifferentiated_acp_rows() {
        let raw = json!({
            "availableCommands": [{
                "name":"review",
                "description":"Load the review skill",
                "_meta":{"source":"skill", "location":"/private/review/SKILL.md"}
            }],
            "_meta":{"openCodeCapabilities":{
                "version":99,
                "skills":[{"name":"review", "manual":true}]
            }}
        });

        let snapshot = project_acp_catalog("project", "session", AgentId::OpenCode, 4, &raw);

        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].kind, ComposerItemKind::Command);
        assert_eq!(snapshot.items[0].source_label, "OpenCode command");
        assert!(
            snapshot
                .items
                .iter()
                .all(|item| !item.id.starts_with("cap:"))
        );
        assert!(
            !serde_json::to_string(&snapshot)
                .expect("safe OpenCode catalog")
                .contains("/private/review")
        );
        assert_eq!(
            resolve_composer_catalog_item(
                "project",
                "session",
                AgentId::OpenCode,
                &snapshot,
                &raw,
                4,
                &snapshot.items[0].id,
                "",
            ),
            Ok("/review".to_owned())
        );
    }

    #[test]
    fn claude_skill_metadata_disables_duplicate_and_unavailable_identities() {
        let raw = json!({
            "availableCommands": [{"name":"review", "description":"Review code"}],
            "_meta": {"kubecode":{"claudeSkills":{
                "version": 1,
                "supported": true,
                "skills": [
                    {"identity":"review", "name":"Project review", "scope":"project",
                     "sourceLabel":"Project skill", "enabled":true},
                    {"identity":"review", "name":"User review", "scope":"user",
                     "sourceLabel":"User skill", "enabled":true},
                    {"identity":"missing", "name":"Missing", "scope":"session",
                     "sourceLabel":"Claude skill", "enabled":true}
                ]
            }}}
        });
        let snapshot = project_acp_catalog("project", "session", AgentId::ClaudeCode, 1, &raw);

        assert_eq!(snapshot.items.len(), 2);
        assert!(snapshot.items.iter().all(|item| !item.enabled));
        assert!(
            snapshot.items.iter().any(|item| {
                item.disabled_reason.as_deref() == Some("ambiguous_source_identity")
            })
        );
        assert!(
            snapshot
                .items
                .iter()
                .any(|item| { item.disabled_reason.as_deref() == Some("command_unavailable") })
        );
    }

    #[test]
    fn codex_skill_metadata_preserves_identity_and_resolves_structured_input() {
        let raw = json!({
            "availableCommands": [{"name":"status", "description":"Show status"}],
            "_meta": {"kubecode":{"codexSkills":{
                "version": 1,
                "supported": true,
                "structuredInput": true,
                "textFallback": false,
                "skills": [
                    {
                        "identity":"/srv/project/.agents/skills/review/SKILL.md",
                        "name":"review",
                        "description":"Project review",
                        "path":"/srv/project/.agents/skills/review/SKILL.md",
                        "providerScope":"repo",
                        "sourceLabel":"Project skill",
                        "enabled":true
                    },
                    {
                        "identity":"/home/user/.codex/skills/review/SKILL.md",
                        "name":"review",
                        "description":"User review",
                        "path":"/home/user/.codex/skills/review/SKILL.md",
                        "providerScope":"user",
                        "sourceLabel":"User skill",
                        "enabled":true
                    }
                ]
            }}}
        });
        let snapshot = project_acp_catalog("project", "session", AgentId::Codex, 11, &raw);
        let skills = snapshot
            .items
            .iter()
            .filter(|item| item.kind == ComposerItemKind::Skill)
            .collect::<Vec<_>>();

        assert_eq!(skills.len(), 2);
        assert!(skills.iter().all(|item| item.enabled));
        assert_ne!(skills[0].id, skills[1].id);
        assert_eq!(skills[0].scope, ComposerItemScope::Project);
        assert_eq!(skills[1].scope, ComposerItemScope::User);
        assert!(
            !serde_json::to_string(&snapshot)
                .expect("safe snapshot")
                .contains("/srv/project")
        );

        let selected = skills
            .iter()
            .find(|item| item.scope == ComposerItemScope::Project)
            .expect("project skill");
        assert_eq!(
            resolve_composer_catalog_dispatch(
                "project",
                "session",
                AgentId::Codex,
                &snapshot,
                &raw,
                11,
                &selected.id,
                "focus on tests"
            ),
            Ok(ResolvedComposerDispatch {
                display_message: "$review focus on tests".to_owned(),
                prompt_message: "focus on tests".to_owned(),
                provider_input: Some(ComposerInvocation::ProviderStructuredInput {
                    adapter_kind: "codex".to_owned(),
                    payload: json!({
                        "type":"skill",
                        "name":"review",
                        "path":"/srv/project/.agents/skills/review/SKILL.md"
                    }),
                }),
            })
        );
    }

    #[test]
    fn codex_skill_metadata_fails_closed_when_text_fallback_is_advertised() {
        let raw = json!({
            "availableCommands": [],
            "_meta": {"kubecode":{"codexSkills":{
                "version": 1,
                "supported": true,
                "structuredInput": true,
                "textFallback": true,
                "skills": [{
                    "identity":"/private/review/SKILL.md",
                    "name":"review",
                    "path":"/private/review/SKILL.md",
                    "providerScope":"repo",
                    "sourceLabel":"Project skill",
                    "enabled":true
                }]
            }}}
        });

        assert!(
            project_acp_catalog("project", "session", AgentId::Codex, 1, &raw)
                .items
                .is_empty()
        );
    }

    #[test]
    fn trusted_contributions_are_bounded_validated_and_never_masquerade_as_acp_commands() {
        let mut trusted = (0..80)
            .map(|index| TrustedComposerContribution {
                kind: ComposerItemKind::Skill,
                source_identity: format!("skill-{index}"),
                name: format!("Skill {index}"),
                description: None,
                source_label: "Trusted skills".to_owned(),
                scope: ComposerItemScope::Session,
                input_hint: None,
                disabled_reason: None,
                invocation: Some(ComposerInvocation::HostAction {
                    action: format!("skill-{index}"),
                }),
            })
            .collect::<Vec<_>>();
        let trusted_only = project_catalog_with_trusted(
            "project",
            "session",
            AgentId::ClaudeCode,
            1,
            &json!({"availableCommands":[]}),
            &trusted,
        );
        assert_eq!(trusted_only.items.len(), MAX_TRUSTED_COMPOSER_ITEMS);

        trusted[1].source_identity = trusted[0].source_identity.clone();
        let duplicate = project_catalog_with_trusted(
            "project",
            "session",
            AgentId::ClaudeCode,
            1,
            &json!({"availableCommands":[]}),
            &trusted[..2],
        );
        assert_eq!(duplicate.items.len(), 1);
        assert!(!duplicate.items[0].enabled);
        assert_eq!(
            duplicate.items[0].disabled_reason.as_deref(),
            Some("ambiguous_source_identity")
        );
        trusted[1].source_identity = "skill-1".to_owned();

        let commands = (0..250)
            .map(|index| json!({"name":format!("command-{index}"), "description":"Command"}))
            .collect::<Vec<_>>();
        let combined = project_catalog_with_trusted(
            "project",
            "session",
            AgentId::ClaudeCode,
            1,
            &json!({"availableCommands":commands}),
            &trusted,
        );
        assert_eq!(combined.items.len(), MAX_COMPOSER_ITEMS);
        assert_eq!(
            combined
                .items
                .iter()
                .filter(|item| item.kind == ComposerItemKind::Skill)
                .count(),
            6
        );

        let raw = json!({"availableCommands":[{"name":"status", "description":"Status"}]});
        let exceptional = project_catalog_with_trusted(
            "project",
            "session",
            AgentId::ClaudeCode,
            1,
            &raw,
            &[
                TrustedComposerContribution {
                    kind: ComposerItemKind::Skill,
                    source_identity: "x".repeat(MAX_TRUSTED_SOURCE_IDENTITY_BYTES + 1),
                    name: "Overlong identity".to_owned(),
                    description: None,
                    source_label: "Trusted skills".to_owned(),
                    scope: ComposerItemScope::Session,
                    input_hint: None,
                    disabled_reason: None,
                    invocation: Some(ComposerInvocation::AcpPromptTemplate {
                        command_name: "status".to_owned(),
                    }),
                },
                TrustedComposerContribution {
                    kind: ComposerItemKind::Skill,
                    source_identity: "overlong-name".to_owned(),
                    name: "x".repeat(MAX_TRUSTED_ITEM_NAME_BYTES + 1),
                    description: None,
                    source_label: "Trusted skills".to_owned(),
                    scope: ComposerItemScope::Session,
                    input_hint: None,
                    disabled_reason: None,
                    invocation: None,
                },
                TrustedComposerContribution {
                    kind: ComposerItemKind::Command,
                    source_identity: "private-status".to_owned(),
                    name: "status".to_owned(),
                    description: None,
                    source_label: "Private command".to_owned(),
                    scope: ComposerItemScope::Session,
                    input_hint: None,
                    disabled_reason: None,
                    invocation: Some(ComposerInvocation::AcpPromptTemplate {
                        command_name: "status".to_owned(),
                    }),
                },
            ],
        );
        assert_eq!(exceptional.items.len(), 2);
        let trusted_command = exceptional
            .items
            .iter()
            .find(|item| item.id != exceptional.items[0].id)
            .expect("trusted command");
        assert!(!trusted_command.enabled);
        assert_eq!(
            trusted_command.disabled_reason.as_deref(),
            Some("unsupported_invocation")
        );
        assert_eq!(
            resolve_acp_catalog_item(
                &exceptional,
                &raw,
                exceptional.revision,
                &trusted_command.id,
                ""
            ),
            Err(ComposerCatalogError::ItemDisabled)
        );
    }

    #[test]
    fn item_and_context_snapshot_caps_are_independent() {
        let commands = (0..=MAX_COMPOSER_ITEMS)
            .map(|index| json!({"name":format!("command-{index}"), "description":"Command"}))
            .collect::<Vec<_>>();
        let contexts = (0..=MAX_COMPOSER_CONTEXTS)
            .map(|index| ComposerContextMeta {
                id: format!("ctx:{index}"),
                kind: ComposerContextKind::File,
                display: format!("src/context-{index}.rs"),
                enabled: true,
                disabled_reason: None,
                summary: None,
            })
            .collect::<Vec<_>>();

        let snapshot = project_acp_catalog_with_contexts(
            "project",
            "session",
            AgentId::Codex,
            1,
            &json!({"availableCommands":commands}),
            contexts,
        );

        assert_eq!(snapshot.items.len(), MAX_COMPOSER_ITEMS);
        assert_eq!(snapshot.contexts.len(), MAX_COMPOSER_CONTEXTS);
        assert!(snapshot.items.iter().all(|item| item.name != "command-256"));
        assert!(
            snapshot
                .contexts
                .iter()
                .all(|context| context.id != "ctx:256")
        );
    }
}
