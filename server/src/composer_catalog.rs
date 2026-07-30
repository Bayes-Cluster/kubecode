use std::collections::{BTreeMap, BTreeSet};

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
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComposerContextRecord {
    pub id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub kind: ComposerContextKind,
    pub path: String,
    pub available: bool,
}

impl ComposerContextRecord {
    pub fn safe_meta(&self) -> ComposerContextMeta {
        ComposerContextMeta {
            id: self.id.clone(),
            kind: self.kind,
            display: self.path.clone(),
            enabled: self.available,
            disabled_reason: (!self.available).then(|| "context_stale".to_owned()),
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

#[derive(Clone, Debug)]
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

#[derive(Clone, Debug)]
pub struct TrustedComposerContribution {
    pub kind: ComposerItemKind,
    pub source_identity: String,
    pub name: String,
    pub description: Option<String>,
    pub source_label: String,
    pub scope: ComposerItemScope,
    pub input_hint: Option<String>,
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
    let mut snapshot = project_catalog_with_trusted(
        project_id,
        conversation_id,
        agent_id,
        revision,
        payload,
        &[],
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
    let commands = parse_available_commands(payload);
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
        let enabled = !duplicate && !unsupported_command && contribution.invocation.is_some();
        let disabled_reason = if duplicate {
            Some("ambiguous_source_identity".to_owned())
        } else if unsupported_command {
            Some("unsupported_invocation".to_owned())
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
                    invocation: None,
                },
                TrustedComposerContribution {
                    kind: ComposerItemKind::Skill,
                    source_identity: "overlong-name".to_owned(),
                    name: "x".repeat(MAX_TRUSTED_ITEM_NAME_BYTES + 1),
                    description: None,
                    source_label: "Trusted skills".to_owned(),
                    scope: ComposerItemScope::Session,
                    input_hint: None,
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
