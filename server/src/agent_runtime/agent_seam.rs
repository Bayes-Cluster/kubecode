//! Per-agent ACP adapter seam (#104, ADR 0210 §8): one registry of pure
//! translators so subagent envelopes (#107), ext methods, env/command
//! resolution, and permission-mode selection land in one place instead of
//! scattered `match agent_id` arms. Synthetic notifications re-enter the
//! unified processing path directly — never through `preprocess` again.

use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{EnvVariable, SessionUpdate};
use serde_json::Value;

use crate::agent_discovery::AgentDescriptor;
use crate::agents::AgentId;

use super::AgentPermissionProfile;

/// What the pipeline does with one incoming notification after per-agent
/// translation.
pub enum NotificationFlow {
    /// Pass the (possibly transformed) update through 1:1.
    Keep(Box<SessionUpdate>),
    /// Drop silently (agent-specific noise the unified path must not see).
    Drop,
    /// Drop the original and inject one or more synthetic updates that enter
    /// the unified path directly (non-recursive).
    Synthesize(Vec<SessionUpdate>),
}

impl NotificationFlow {
    pub fn keep(update: &SessionUpdate) -> Self {
        Self::Keep(Box::new(update.clone()))
    }
}

/// Result of translating a vendor ext method.
#[derive(Default)]
pub struct ExtFlow {
    /// Synthetic standard notifications derived from the ext payload.
    pub synthetic: Vec<SessionUpdate>,
}

impl ExtFlow {
    pub fn none() -> Self {
        Self::default()
    }
}

/// Inputs the turn-boundary hook receives when a run reaches a terminal
/// event.
pub struct TurnBoundaryContext<'a> {
    pub conversation_id: &'a str,
    pub run_id: &'a str,
    pub cause: &'a str,
}

/// Per-agent behavior lives here, never in scattered `match agent_id` arms
/// (ADR 0210 §8).
pub trait AgentAdapter: Send + Sync {
    fn agent_id(&self) -> AgentId;

    /// 1:1 transform / drop / 1:N synthetic translation of one incoming
    /// notification, upstream of the journal.
    fn preprocess_notification(&self, update: &SessionUpdate) -> NotificationFlow {
        NotificationFlow::keep(update)
    }

    /// Vendor ext method → synthetic standard notifications.
    fn handle_ext_notification(&self, _method: &str, _payload: &Value) -> ExtFlow {
        ExtFlow::none()
    }

    /// The ext method this agent uses for side questions, if any.
    fn side_question_ext_method(&self) -> Option<&'static str> {
        None
    }

    /// Per-agent environment for the provider process.
    fn environment(
        &self,
        descriptor: &AgentDescriptor,
        permission_profile: AgentPermissionProfile,
    ) -> Vec<EnvVariable> {
        let _ = (descriptor, permission_profile);
        Vec::new()
    }

    /// Provider command (after the launcher's cwd) and arguments.
    fn command(&self, descriptor: &AgentDescriptor, cwd: &Path) -> (PathBuf, Vec<String>) {
        (
            PathBuf::from(&descriptor.executable),
            vec![
                "acp".to_owned(),
                "--cwd".to_owned(),
                cwd.to_string_lossy().into_owned(),
            ],
        )
    }

    /// Native permission-mode string selected on session start, if the agent
    /// has a default.
    fn native_permission_mode(&self) -> Option<&'static str> {
        None
    }

    /// Turn-boundary hook: invoked at terminal events for adapter-local
    /// bookkeeping (e.g. flushing subagent transcripts).
    fn on_prompt_completed(&self, _context: &TurnBoundaryContext<'_>) {}
}

/// Claude Code: side questions via the `_claude/side_question` ext method,
/// `CLAUDE_CODE_EXECUTABLE` environment, `default` permission mode.
#[derive(Clone, Default)]
pub struct ClaudeCodeAdapter;

impl AgentAdapter for ClaudeCodeAdapter {
    fn agent_id(&self) -> AgentId {
        AgentId::ClaudeCode
    }

    fn side_question_ext_method(&self) -> Option<&'static str> {
        Some("_claude/side_question")
    }

    fn environment(
        &self,
        descriptor: &AgentDescriptor,
        _permission_profile: AgentPermissionProfile,
    ) -> Vec<EnvVariable> {
        vec![EnvVariable::new(
            "CLAUDE_CODE_EXECUTABLE",
            descriptor.executable.clone(),
        )]
    }

    fn command(&self, _descriptor: &AgentDescriptor, _cwd: &Path) -> (PathBuf, Vec<String>) {
        // Claude runs through the project ACP adapter, not the CLI directly.
        (
            crate::agent_discovery::configured_adapter_path(
                "KUBECODE_CLAUDE_ACP_PATH",
                "claude-agent-acp",
            )
            .unwrap_or_else(|| PathBuf::from("claude-agent-acp")),
            Vec::new(),
        )
    }

    fn native_permission_mode(&self) -> Option<&'static str> {
        Some("default")
    }
}

/// Codex: `CODEX_PATH` environment, project ACP adapter, `agent` mode.
#[derive(Clone, Default)]
pub struct CodexAdapter;

impl AgentAdapter for CodexAdapter {
    fn agent_id(&self) -> AgentId {
        AgentId::Codex
    }

    fn environment(
        &self,
        descriptor: &AgentDescriptor,
        _permission_profile: AgentPermissionProfile,
    ) -> Vec<EnvVariable> {
        vec![EnvVariable::new(
            "CODEX_PATH",
            descriptor.executable.clone(),
        )]
    }

    fn command(&self, _descriptor: &AgentDescriptor, _cwd: &Path) -> (PathBuf, Vec<String>) {
        (
            crate::agent_discovery::configured_adapter_path("KUBECODE_CODEX_ACP_PATH", "codex-acp")
                .unwrap_or_else(|| PathBuf::from("codex-acp")),
            Vec::new(),
        )
    }

    fn native_permission_mode(&self) -> Option<&'static str> {
        Some("agent")
    }
}

/// OpenCode: native ACP, optional blanket permission environment for the
/// maximum profile, no native default mode.
#[derive(Clone, Default)]
pub struct OpenCodeAdapter;

const OPENCODE_MAXIMUM_PERMISSION: &str = r#"{"*":"allow"}"#;

impl AgentAdapter for OpenCodeAdapter {
    fn agent_id(&self) -> AgentId {
        AgentId::OpenCode
    }

    fn environment(
        &self,
        _descriptor: &AgentDescriptor,
        permission_profile: AgentPermissionProfile,
    ) -> Vec<EnvVariable> {
        if permission_profile == AgentPermissionProfile::Maximum {
            vec![EnvVariable::new(
                "OPENCODE_PERMISSION",
                OPENCODE_MAXIMUM_PERMISSION,
            )]
        } else {
            Vec::new()
        }
    }

    fn command(&self, descriptor: &AgentDescriptor, cwd: &Path) -> (PathBuf, Vec<String>) {
        (
            PathBuf::from(&descriptor.executable),
            vec![
                "acp".to_owned(),
                "--cwd".to_owned(),
                cwd.to_string_lossy().into_owned(),
            ],
        )
    }
}

/// Registry mapping each supported agent to its adapter. Unknown agents get
/// a neutral pass-through so new agents fail soft at the seam.
#[derive(Clone)]
pub struct AgentAdapterRegistry {
    claude_code: ClaudeCodeAdapter,
    codex: CodexAdapter,
    opencode: OpenCodeAdapter,
}

impl AgentAdapterRegistry {
    pub fn new() -> Self {
        Self {
            claude_code: ClaudeCodeAdapter,
            codex: CodexAdapter,
            opencode: OpenCodeAdapter,
        }
    }

    pub fn for_agent(&self, agent_id: AgentId) -> &dyn AgentAdapter {
        match agent_id {
            AgentId::ClaudeCode => &self.claude_code,
            AgentId::Codex => &self.codex,
            AgentId::OpenCode => &self.opencode,
        }
    }
}

impl Default for AgentAdapterRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_discovery::AgentDescriptor;
    use serde_json::json;

    fn descriptor(agent: AgentId) -> AgentDescriptor {
        AgentDescriptor {
            id: agent,
            available: true,
            version: Some("test".into()),
            executable: format!("/opt/bin/{agent:?}").to_lowercase(),
            error: None,
        }
    }

    #[test]
    fn environment_and_command_resolution_lives_in_adapters() {
        let registry = AgentAdapterRegistry::new();
        let claude = registry.for_agent(AgentId::ClaudeCode);
        let environment = claude.environment(
            &descriptor(AgentId::ClaudeCode),
            AgentPermissionProfile::Default,
        );
        assert!(
            environment
                .iter()
                .any(|variable| variable.name == "CLAUDE_CODE_EXECUTABLE")
        );
        let (command, args) = claude.command(&descriptor(AgentId::ClaudeCode), Path::new("/w"));
        assert!(command.to_string_lossy().contains("claude-agent-acp"));
        assert!(args.is_empty());

        let opencode = registry.for_agent(AgentId::OpenCode);
        let (command, args) = opencode.command(&descriptor(AgentId::OpenCode), Path::new("/w"));
        assert_eq!(command, PathBuf::from("/opt/bin/opencode"));
        assert!(args.contains(&"--cwd".to_owned()));
    }

    #[test]
    fn native_permission_modes_come_from_the_registry() {
        let registry = AgentAdapterRegistry::new();
        assert_eq!(
            registry
                .for_agent(AgentId::ClaudeCode)
                .native_permission_mode(),
            Some("default")
        );
        assert_eq!(
            registry.for_agent(AgentId::Codex).native_permission_mode(),
            Some("agent")
        );
        assert_eq!(
            registry
                .for_agent(AgentId::OpenCode)
                .native_permission_mode(),
            None
        );
    }

    #[test]
    fn side_question_ext_method_is_claude_only() {
        let registry = AgentAdapterRegistry::new();
        assert_eq!(
            registry
                .for_agent(AgentId::ClaudeCode)
                .side_question_ext_method(),
            Some("_claude/side_question")
        );
        assert_eq!(
            registry
                .for_agent(AgentId::Codex)
                .side_question_ext_method(),
            None
        );
    }

    #[test]
    fn default_preprocess_keeps_and_ext_handler_synthesizes_nothing() {
        let registry = AgentAdapterRegistry::new();
        let update: SessionUpdate = serde_json::from_value(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "hi"},
        }))
        .expect("update");
        match registry
            .for_agent(AgentId::Codex)
            .preprocess_notification(&update)
        {
            NotificationFlow::Keep(kept) => assert_eq!(*kept, update),
            _ => panic!("default preprocess must keep"),
        }
        let flow = registry
            .for_agent(AgentId::Codex)
            .handle_ext_notification("_vendor/anything", &json!({}));
        assert!(flow.synthetic.is_empty());
    }

    #[test]
    fn one_to_one_transform_drop_and_synthesize_paths_are_expressible() {
        // Adapters express all three flows; exercised concretely by the
        // Claude subagent translation in #107. Here: the contract shapes.
        let update: SessionUpdate = serde_json::from_value(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "hi"},
        }))
        .expect("update");
        let one_to_one = NotificationFlow::keep(&update);
        assert!(matches!(one_to_one, NotificationFlow::Keep(_)));
        let drop = NotificationFlow::Drop;
        assert!(matches!(drop, NotificationFlow::Drop));
        let synthesize = NotificationFlow::Synthesize(vec![update]);
        match synthesize {
            NotificationFlow::Synthesize(list) => assert_eq!(list.len(), 1),
            _ => panic!("1:N shape"),
        }
    }
}
