use std::collections::{BTreeMap, HashSet};

use agent_client_protocol::schema::v1::{
    ClientRequest, ElicitationAcceptAction, ElicitationAction, ElicitationContentValue, ExtRequest,
    PermissionOption, PermissionOptionId, PermissionOptionKind, RequestPermissionOutcome,
    SelectedPermissionOutcome, SessionConfigOptionValue, SetSessionConfigOptionRequest,
    SetSessionModeRequest, ToolKind,
};
use agent_client_protocol::{Agent, ConnectionTo};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::agents::{AgentEventKind, AgentId, AgentRun, AgentStore, RunStatus};

use super::actor::SessionCommand;
use super::{AgentPermissionProfile, AgentRuntime, RuntimeError};

/// Everything needed to record an allow-always rule once the user picks an
/// always-class option.
#[derive(Clone, Debug)]
pub(super) struct AlwaysAllowContext {
    /// Rules are scoped per project and agent; the matcher itself stays
    /// kind-granular (see [`always_allow_matcher`]).
    pub(super) project_id: String,
    pub(super) agent_id: AgentId,
    pub(super) matcher: Value,
}

pub(super) struct PendingPermission {
    pub(super) allowed_options: HashSet<String>,
    pub(super) request_payload: Value,
    pub(super) run_id: String,
    pub(super) sender: oneshot::Sender<RequestPermissionOutcome>,
    /// Present only when the store could establish project/agent scope for
    /// the run; pairs with the always-class option ids that must persist it.
    pub(super) always_allow: Option<(AlwaysAllowContext, HashSet<String>)>,
    /// When it was asked (store timestamp form) and when it stops waiting.
    pub(super) requested_at: String,
    pub(super) deadline: std::time::Instant,
}

/// Builds the canonical kind-granular always-allow rule for a permission
/// request. It carries the ACP tool kind and nothing else — never titles,
/// paths, commands, or raw input.
pub(super) fn always_allow_matcher(tool_kind: Option<ToolKind>) -> Value {
    let kind = match tool_kind {
        Some(ToolKind::Read) => "read",
        Some(ToolKind::Edit) => "edit",
        Some(ToolKind::Delete) => "delete",
        Some(ToolKind::Move) => "move",
        Some(ToolKind::Search) => "search",
        Some(ToolKind::Execute) => "execute",
        Some(ToolKind::Think) => "think",
        Some(ToolKind::Fetch) => "fetch",
        Some(ToolKind::SwitchMode) => "switch_mode",
        // The kind enum is non-exhaustive across protocol versions and
        // "other" is its declared default bucket.
        Some(ToolKind::Other) | None | Some(_) => "other",
    };
    json!({"tool_kind": kind})
}

/// Answers a permission request from persisted always-allow memory without
/// surfacing it. Returns `None` when no remembered rule matches (or when the
/// agent offered no allow option to answer with).
pub(super) fn remembered_permission_outcome(
    runtime: &AgentRuntime,
    run_id: &str,
    tool_kind: Option<ToolKind>,
    options: &[PermissionOption],
) -> Option<RequestPermissionOutcome> {
    let run = runtime.store.get_run(run_id).ok()?;
    let conversation = runtime.store.get_conversation(&run.conversation_id).ok()?;
    let matcher = always_allow_matcher(tool_kind);
    let allowed = runtime
        .store
        .is_allowed(&run.project_id, conversation.agent_id, &matcher)
        .ok()?;
    if !allowed {
        return None;
    }
    // Prefer answering with the same class of grant that was remembered;
    // a bare allow-once fallback keeps the turn flowing when the agent did
    // not offer an always option this time.
    let granted = options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::AllowAlways)
        .or_else(|| {
            options
                .iter()
                .find(|option| option.kind == PermissionOptionKind::AllowOnce)
        })?;
    Some(RequestPermissionOutcome::Selected(
        SelectedPermissionOutcome::new(granted.option_id.clone()),
    ))
}

pub(super) struct PendingElicitation {
    pub(super) run_id: String,
    pub(super) sender: oneshot::Sender<ElicitationAction>,
    /// The request as the provider sent it (`message`, `requestedSchema`).
    pub(super) request_payload: Value,
    pub(super) requested_at: String,
    pub(super) deadline: std::time::Instant,
}

/// Which kind of answer a waiting request needs.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingKind {
    Permission,
    Input,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PendingOptionView {
    pub id: String,
    pub label: String,
    pub kind: String,
}

/// A permission or input request waiting for an answer, as the attention
/// projection reads it (ADR 0232). Never carries the tool's input.
#[derive(Clone, Debug, Serialize)]
pub struct PendingRequestView {
    pub kind: PendingKind,
    pub request_id: String,
    pub run_id: String,
    pub requested_at: String,
    /// Milliseconds left before it stops waiting.
    pub deadline_ms: u64,
    /// `user` (the researcher) or `leader` (a Team leader reviews it first).
    pub reviewer: String,
    /// The tool's title, for a permission.
    pub tool: Option<String>,
    pub options: Vec<PendingOptionView>,
    /// What an input request asks, and the form it asks for.
    pub message: Option<String>,
    pub schema: Option<Value>,
}

fn text_field(payload: &Value, key: &str, max: usize) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(|text| text.chars().take(max).collect())
}

impl PendingPermission {
    fn view(&self, request_id: &str) -> PendingRequestView {
        let payload = &self.request_payload;
        PendingRequestView {
            kind: PendingKind::Permission,
            request_id: request_id.to_owned(),
            run_id: self.run_id.clone(),
            requested_at: self.requested_at.clone(),
            deadline_ms: deadline_remaining_ms(self.deadline),
            reviewer: text_field(payload, "reviewer", 20).unwrap_or_else(|| "user".to_owned()),
            tool: text_field(payload, "tool", 200),
            options: payload
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .map(|option| PendingOptionView {
                            id: text_field(option, "id", 200).unwrap_or_default(),
                            label: text_field(option, "label", 200).unwrap_or_default(),
                            kind: text_field(option, "kind", 40).unwrap_or_default(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            message: None,
            schema: None,
        }
    }
}

impl PendingElicitation {
    fn view(&self, request_id: &str) -> PendingRequestView {
        PendingRequestView {
            kind: PendingKind::Input,
            request_id: request_id.to_owned(),
            run_id: self.run_id.clone(),
            requested_at: self.requested_at.clone(),
            deadline_ms: deadline_remaining_ms(self.deadline),
            reviewer: "user".to_owned(),
            tool: None,
            options: Vec::new(),
            message: text_field(&self.request_payload, "message", 500),
            schema: self.request_payload.get("requestedSchema").cloned(),
        }
    }
}

/// A wait ended (answered, stopped, or timed out): every tab refetches (#101).
pub(super) fn announce_wait_ended(store: &AgentStore, run_id: &str) {
    if let Ok(run) = store.get_run(run_id) {
        let _ = store.append_workspace_event(
            "conversation_state",
            Some(&run.project_id),
            Some(&run.conversation_id),
            Some(run_id),
            &json!({
                "conversation_id": run.conversation_id,
                "streaming": true,
                "pending": Value::Null,
            }),
        );
    }
}

/// How long pending permission / elicitation requests wait before the
/// server resolves them as declined (#111). Tunable via
/// `KUBECODE_PENDING_REQUEST_TIMEOUT_MS`.
pub(crate) fn pending_request_timeout() -> std::time::Duration {
    std::env::var("KUBECODE_PENDING_REQUEST_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(std::time::Duration::from_millis)
        .unwrap_or(std::time::Duration::from_secs(5 * 60))
}

pub(crate) fn deadline_remaining_ms(deadline: std::time::Instant) -> u64 {
    deadline
        .saturating_duration_since(std::time::Instant::now())
        .as_millis() as u64
}

impl PendingPermission {
    fn accepts(&self, option_id: &str) -> bool {
        self.allowed_options.contains(option_id)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SideQuestionAccepted {
    pub id: String,
    pub status: &'static str,
}

/// Native tools the General Agent may not use: it manages, so editing,
/// deleting, moving, and executing are refused outright (ADR 0220 §4).
pub(super) fn denied_for_manager(kind: Option<ToolKind>) -> bool {
    matches!(
        kind,
        Some(ToolKind::Edit | ToolKind::Delete | ToolKind::Move | ToolKind::Execute)
    )
}

pub(super) fn default_native_permission_mode(agent_id: AgentId) -> Option<&'static str> {
    // Delegates to the per-agent adapter seam (#104); the fn name is kept
    // for call-site stability.
    super::agent_seam::AgentAdapterRegistry::new()
        .for_agent(agent_id)
        .native_permission_mode()
}

impl AgentRuntime {
    pub fn resolve_permission(&self, request_id: &str, option_id: &str) -> bool {
        let mut permissions = self
            .pending_permissions
            .lock()
            .expect("pending permission mutex poisoned");
        if !permissions
            .get(request_id)
            .is_some_and(|pending| pending.accepts(option_id))
        {
            return false;
        }
        let Some(pending) = permissions.remove(request_id) else {
            return false;
        };
        drop(permissions);
        let sent = pending
            .sender
            .send(RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(PermissionOptionId::new(option_id.to_owned())),
            ))
            .is_ok();
        // The wait ended: broadcast the cleared snapshot (#101).
        announce_wait_ended(&self.store, &pending.run_id);
        // Remembering follows a successful delivery so an agent that never
        // sees the answer does not gain silent standing grants.
        if sent
            && let Some((context, option_ids)) = &pending.always_allow
            && option_ids.contains(option_id)
        {
            let _ =
                self.store
                    .allow_always(&context.project_id, context.agent_id, &context.matcher);
        }
        sent
    }

    pub fn escalate_team_permission(&self, request_id: &str) -> Result<(), RuntimeError> {
        // The waiting request itself now names the researcher as its
        // reviewer, so what is listed as waiting matches what was announced.
        let (run_id, payload) = {
            let mut permissions = self
                .pending_permissions
                .lock()
                .expect("pending permission mutex poisoned");
            let pending = permissions.get_mut(request_id).ok_or_else(|| {
                RuntimeError::Acp("permission request is no longer active".into())
            })?;
            if let Value::Object(object) = &mut pending.request_payload {
                object.insert("reviewer".into(), Value::String("user".into()));
            }
            (pending.run_id.clone(), pending.request_payload.clone())
        };
        self.store
            .append_event(&run_id, AgentEventKind::PermissionRequested, &payload)?;
        let run = self.store.get_run(&run_id)?;
        self.store.append_workspace_event(
            "permission_requested",
            Some(&run.project_id),
            Some(&run.conversation_id),
            Some(&run.id),
            &payload,
        )?;
        Ok(())
    }

    pub fn resolve_elicitation(
        &self,
        request_id: &str,
        content: Option<BTreeMap<String, ElicitationContentValue>>,
    ) -> bool {
        self.pending_elicitations
            .lock()
            .expect("pending elicitation mutex poisoned")
            .remove(request_id)
            .is_some_and(|pending| {
                let action = content.map_or(ElicitationAction::Decline, |content| {
                    ElicitationAction::Accept(ElicitationAcceptAction::new().content(content))
                });
                let delivered = pending.sender.send(action).is_ok();
                // The wait ended: broadcast the cleared snapshot (#101).
                announce_wait_ended(&self.store, &pending.run_id);
                delivered
            })
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        // Kill the conversation's agent terminals before the ACP cancel:
        // local kills are synchronous and immediate while the provider's
        // cancel may lag, so nothing the run spawned outlives the stop. Only
        // an active run kills — a late or duplicate stop for a finished run
        // must never take down terminals the user opened afterwards.
        if let Some(terminals) = self.terminals.as_ref()
            && let Ok(run) = self.store.get_run(run_id)
            && matches!(
                run.status,
                RunStatus::Running | RunStatus::WaitingPermission
            )
        {
            terminals.kill_by_session(&run.conversation_id);
        }
        let cancelled = self
            .cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .remove(run_id)
            .is_some_and(|sender| sender.send(()).is_ok());
        self.cancel_pending_permissions(run_id);
        self.cancel_pending_elicitations(run_id);
        cancelled
    }

    fn cancel_pending_permissions(&self, run_id: &str) {
        let mut permissions = self
            .pending_permissions
            .lock()
            .expect("pending permission mutex poisoned");
        let request_ids = permissions
            .iter()
            .filter(|(_, pending)| pending.run_id == run_id)
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        let mut ended = 0;
        for request_id in request_ids {
            if let Some(pending) = permissions.remove(&request_id) {
                let _ = pending.sender.send(RequestPermissionOutcome::Cancelled);
                ended += 1;
            }
        }
        drop(permissions);
        for _ in 0..ended {
            announce_wait_ended(&self.store, run_id);
        }
    }

    fn cancel_pending_elicitations(&self, run_id: &str) {
        let mut elicitations = self
            .pending_elicitations
            .lock()
            .expect("pending elicitation mutex poisoned");
        let request_ids = elicitations
            .iter()
            .filter(|(_, pending)| pending.run_id == run_id)
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        let mut ended = 0;
        for request_id in request_ids {
            if let Some(pending) = elicitations.remove(&request_id) {
                let _ = pending.sender.send(ElicitationAction::Cancel);
                ended += 1;
            }
        }
        drop(elicitations);
        for _ in 0..ended {
            announce_wait_ended(&self.store, run_id);
        }
    }

    /// Every permission and input request now waiting for an answer. The
    /// in-memory maps are the authority: only what is here can be answered.
    /// Each map is copied under its own lock; no lock is held across a store call.
    pub fn pending_requests(&self) -> Vec<PendingRequestView> {
        let mut views: Vec<PendingRequestView> = self
            .pending_permissions
            .lock()
            .expect("pending permission mutex poisoned")
            .iter()
            .map(|(request_id, pending)| pending.view(request_id))
            .collect();
        views.extend(
            self.pending_elicitations
                .lock()
                .expect("pending elicitation mutex poisoned")
                .iter()
                .map(|(request_id, pending)| pending.view(request_id)),
        );
        views
    }

    pub async fn ask_side_question(
        &self,
        conversation_id: &str,
        question: String,
    ) -> Result<SideQuestionAccepted, RuntimeError> {
        let conversation = self.store.get_conversation(conversation_id)?;
        // The ext method — and thus the whole capability — lives in the
        // per-agent adapter seam (#104); no agent_id match outside it.
        let ext_method = self
            .adapter_for(conversation.agent_id)
            .side_question_ext_method();
        if ext_method != Some("_claude/side_question")
            || !side_question_capability(&self.store, conversation_id)
        {
            return Err(RuntimeError::SideQuestionUnavailable);
        }
        let active = self
            .store
            .list_runs(conversation_id)?
            .into_iter()
            .rev()
            .any(|run| {
                matches!(
                    run.status,
                    RunStatus::Running | RunStatus::WaitingPermission
                )
            });
        if !active {
            return Err(RuntimeError::SideQuestionInactive);
        }
        {
            let mut pending = self
                .pending_side_questions
                .lock()
                .expect("pending side question mutex poisoned");
            if !pending.insert(conversation_id.to_owned()) {
                return Err(RuntimeError::SideQuestionPending);
            }
        }

        let config = match self.session_config(conversation_id) {
            Ok(config) => config,
            Err(error) => {
                self.finish_side_question(conversation_id);
                return Err(error);
            }
        };
        let (response, accepted) = oneshot::channel();
        self.dispatch(
            config,
            SessionCommand::SideQuestion {
                id: Uuid::new_v4().to_string(),
                question,
                response,
            },
        );
        match accepted.await {
            Ok(Ok(accepted)) => Ok(accepted),
            Ok(Err(error)) => {
                self.finish_side_question(conversation_id);
                Err(error)
            }
            Err(_) => {
                self.finish_side_question(conversation_id);
                Err(RuntimeError::Acp("session connection closed".into()))
            }
        }
    }

    fn finish_side_question(&self, conversation_id: &str) {
        self.pending_side_questions
            .lock()
            .expect("pending side question mutex poisoned")
            .remove(conversation_id);
    }
}

pub(super) fn start_side_question(
    runtime: &AgentRuntime,
    connection: &ConnectionTo<Agent>,
    session_id: &agent_client_protocol::schema::v1::SessionId,
    run: &AgentRun,
    id: String,
    question: String,
    response: oneshot::Sender<Result<SideQuestionAccepted, RuntimeError>>,
) {
    let payload = json!({"id":id, "run_id":run.id, "question":question});
    if let Err(error) = runtime
        .store
        .append_session_event(&run.conversation_id, "side_question_started", &payload)
        .and_then(|_| {
            runtime.store.append_workspace_event(
                "side_question_started",
                Some(&run.project_id),
                Some(&run.conversation_id),
                Some(&run.id),
                &payload,
            )
        })
    {
        runtime.finish_side_question(&run.conversation_id);
        let _ = response.send(Err(RuntimeError::Store(error)));
        return;
    }
    let _ = response.send(Ok(SideQuestionAccepted {
        id: id.clone(),
        status: "pending",
    }));

    let runtime = runtime.clone();
    let connection = connection.clone();
    let session_id = session_id.clone();
    let run = run.clone();
    tokio::spawn(async move {
        let params = serde_json::value::to_raw_value(&json!({
            "sessionId":session_id,
            "question":question,
        }));
        let result = match params {
            Ok(params) => connection
                .send_request(ClientRequest::ExtMethodRequest(ExtRequest::new(
                    "_claude/side_question",
                    params.into(),
                )))
                .block_task()
                .await
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        let (kind, payload) = match result {
            Ok(value) => {
                let answer = value
                    .get("response")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if answer.is_empty() {
                    (
                        "side_question_failed",
                        json!({
                            "id":id,
                            "run_id":run.id,
                            "question":question,
                            "message":"Claude returned an empty side-question response",
                        }),
                    )
                } else {
                    (
                        "side_question_completed",
                        json!({
                            "id":id,
                            "run_id":run.id,
                            "question":question,
                            "answer":answer,
                            "synthetic":value.get("synthetic").cloned().unwrap_or(Value::Null),
                        }),
                    )
                }
            }
            Err(message) => (
                "side_question_failed",
                json!({
                    "id":id,
                    "run_id":run.id,
                    "question":question,
                    "message":message,
                }),
            ),
        };
        let _ = runtime
            .store
            .append_session_event(&run.conversation_id, kind, &payload);
        let _ = runtime.store.append_workspace_event(
            kind,
            Some(&run.project_id),
            Some(&run.conversation_id),
            Some(&run.id),
            &payload,
        );
        runtime.finish_side_question(&run.conversation_id);
    });
}

fn side_question_capability(store: &AgentStore, conversation_id: &str) -> bool {
    store
        .session_events_after(conversation_id, 0)
        .ok()
        .and_then(|events| {
            events
                .into_iter()
                .rev()
                .find(|event| event.kind == "capabilities")
                .map(|event| event.payload)
        })
        .and_then(|payload| payload.get("_meta").cloned())
        .and_then(|meta| meta.get("claudeCode").cloned())
        .and_then(|claude| claude.get("sideQuestion").cloned())
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// Claude Code tools that edit files or run commands: withdrawn from the
/// General Agent's sessions when they start, whatever the user's own Claude
/// settings allow (ADR 0226).
const MANAGER_WITHDRAWN_CLAUDE_TOOLS: &[&str] = &[
    "Bash",
    "BashOutput",
    "KillShell",
    "Edit",
    "MultiEdit",
    "Write",
    "NotebookEdit",
    // Runs a shell command and watches its output.
    "Monitor",
    "TaskOutput",
    "TaskStop",
    // Creates a git worktree.
    "EnterWorktree",
    "PowerShell",
];

/// Session metadata a provider reads when a session starts (new, loaded, or
/// resumed). Only the manager's Claude Code sessions carry any: the tools it
/// may not use are withdrawn at the source, not refused one request at a time.
pub(super) fn session_meta(
    agent_id: AgentId,
    profile: AgentPermissionProfile,
) -> Option<agent_client_protocol::schema::v1::Meta> {
    if agent_id != AgentId::ClaudeCode || profile != AgentPermissionProfile::Manager {
        return None;
    }
    let value = serde_json::json!({
        "claudeCode": { "options": { "disallowedTools": MANAGER_WITHDRAWN_CLAUDE_TOOLS } }
    });
    value.as_object().cloned()
}

pub(super) async fn apply_native_permission_profile(
    connection: &ConnectionTo<Agent>,
    session_id: &agent_client_protocol::schema::v1::SessionId,
    agent_id: AgentId,
    profile: AgentPermissionProfile,
) -> Result<(), agent_client_protocol::Error> {
    let config_value = |value: &str| SessionConfigOptionValue::value_id(value.to_owned());
    match (profile, agent_id) {
        (AgentPermissionProfile::Default, _)
        | (AgentPermissionProfile::Maximum, AgentId::OpenCode) => Ok(()),
        (AgentPermissionProfile::Maximum, AgentId::Codex) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("agent-full-access"),
                ))
                .block_task()
                .await
                .map_err(native_permission_error)?;
            Ok(())
        }
        (AgentPermissionProfile::Maximum, AgentId::ClaudeCode) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("bypassPermissions"),
                ))
                .block_task()
                .await
                .map_err(native_permission_error)?;
            Ok(())
        }
        (AgentPermissionProfile::ReadOnly, AgentId::Codex) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("read-only"),
                ))
                .block_task()
                .await?;
            Ok(())
        }
        (AgentPermissionProfile::ReadOnly, AgentId::ClaudeCode) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("plan"),
                ))
                .block_task()
                .await?;
            Ok(())
        }
        // The manager's Codex runs read-only: commands stay inside a read-only,
        // no-network sandbox, and editing or leaving the sandbox needs an
        // approval, which the runtime refuses for the manager.
        (AgentPermissionProfile::Manager, AgentId::Codex) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("read-only"),
                ))
                .block_task()
                .await
                .map_err(native_permission_error)?;
            Ok(())
        }
        // Claude Code's editing and shell tools were withdrawn at launch; its
        // mode is reset to the one that asks, never one that skips asking.
        (AgentPermissionProfile::Manager, AgentId::ClaudeCode) => {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    config_value("default"),
                ))
                .block_task()
                .await
                .map_err(native_permission_error)?;
            Ok(())
        }
        // OpenCode's editing and shell were denied in its launch environment.
        (AgentPermissionProfile::Manager, AgentId::OpenCode) => Ok(()),
        (AgentPermissionProfile::ReadOnly, AgentId::OpenCode) => {
            connection
                .send_request(SetSessionModeRequest::new(session_id.clone(), "plan"))
                .block_task()
                .await?;
            Ok(())
        }
    }
}

fn native_permission_error(error: agent_client_protocol::Error) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(serde_json::json!({
        "kind": "native_permission_unavailable",
        "error": error.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::agents::PermissionMode;
    use crate::workspace::WorkspaceService;

    #[test]
    fn a_manager_claude_session_starts_without_editing_or_shell_tools() {
        let meta = session_meta(AgentId::ClaudeCode, AgentPermissionProfile::Manager)
            .expect("a manager's Claude session carries its restriction");
        let disallowed: Vec<&str> = meta["claudeCode"]["options"]["disallowedTools"]
            .as_array()
            .expect("disallowed tools")
            .iter()
            .filter_map(|tool| tool.as_str())
            .collect();
        for tool in [
            "Bash",
            "Edit",
            "MultiEdit",
            "Write",
            "NotebookEdit",
            // Runs a shell command and watches it.
            "Monitor",
            "TaskOutput",
            "TaskStop",
            // Writes a git worktree.
            "EnterWorktree",
            "PowerShell",
        ] {
            assert!(
                disallowed.contains(&tool),
                "{tool} is not withdrawn: {disallowed:?}"
            );
        }
        // Other profiles and providers start as before.
        assert!(session_meta(AgentId::ClaudeCode, AgentPermissionProfile::Default).is_none());
        assert!(session_meta(AgentId::Codex, AgentPermissionProfile::Manager).is_none());
        assert!(session_meta(AgentId::OpenCode, AgentPermissionProfile::Manager).is_none());
    }

    #[test]
    fn always_allow_matchers_carry_tool_kind_only() {
        let cases = [
            (Some(ToolKind::Read), "read"),
            (Some(ToolKind::Edit), "edit"),
            (Some(ToolKind::Delete), "delete"),
            (Some(ToolKind::Move), "move"),
            (Some(ToolKind::Search), "search"),
            (Some(ToolKind::Execute), "execute"),
            (Some(ToolKind::Think), "think"),
            (Some(ToolKind::Fetch), "fetch"),
            (Some(ToolKind::SwitchMode), "switch_mode"),
            (Some(ToolKind::Other), "other"),
            (None, "other"),
        ];
        for (kind, expected) in cases {
            let matcher = always_allow_matcher(kind);
            let object = matcher.as_object().expect("matcher object");
            assert_eq!(object.len(), 1, "{kind:?}: matcher carries one key");
            assert_eq!(
                object.get("tool_kind").and_then(Value::as_str),
                Some(expected),
                "{kind:?}"
            );
        }
    }

    #[tokio::test]
    async fn resolving_an_always_option_persists_the_kind_granular_rule() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project = workspace
            .create_project_at(temp.path().join("remember-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::Codex, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Grant me",
                PermissionMode::Safe,
            )
            .expect("run");
        let runtime = AgentRuntime::new(workspace, Arc::clone(&store), Vec::new());
        let (sender, receiver) = oneshot::channel();
        runtime
            .pending_permissions
            .lock()
            .expect("pending permission mutex")
            .insert(
                "permission-1".to_owned(),
                PendingPermission {
                    allowed_options: HashSet::from([
                        "allow_once".to_owned(),
                        "allow_always".to_owned(),
                    ]),
                    request_payload: json!({"request_id":"permission-1"}),
                    run_id: run.id.clone(),
                    sender,
                    always_allow: Some((
                        AlwaysAllowContext {
                            project_id: project.id.clone(),
                            agent_id: AgentId::Codex,
                            matcher: json!({"tool_kind": "execute"}),
                        },
                        HashSet::from(["allow_always".to_owned()]),
                    )),
                    requested_at: String::new(),
                    deadline: std::time::Instant::now(),
                },
            );

        // The once option resolves but never persists a rule.
        assert!(
            !store
                .is_allowed(
                    &project.id,
                    AgentId::Codex,
                    &json!({"tool_kind": "execute"})
                )
                .expect("rule lookup")
        );
        assert!(runtime.resolve_permission("permission-1", "allow_always"));
        let _ = receiver.await;
        assert!(
            store
                .is_allowed(
                    &project.id,
                    AgentId::Codex,
                    &json!({"tool_kind": "execute"})
                )
                .expect("rule lookup after allow-always"),
            "the always option must persist its rule"
        );
        // The stored matcher is exactly the kind key: nothing path- or
        // prompt-shaped can leak into the rules table.
        let matchers = store
            .permission_matchers(&project.id, AgentId::Codex)
            .expect("stored matchers");
        assert_eq!(matchers, vec![json!({"tool_kind": "execute"})]);
    }

    #[test]
    fn restores_provider_defaults_without_treating_opencode_agent_mode_as_permission() {
        assert_eq!(
            default_native_permission_mode(AgentId::ClaudeCode),
            Some("default")
        );
        assert_eq!(
            default_native_permission_mode(AgentId::Codex),
            Some("agent")
        );
        assert_eq!(default_native_permission_mode(AgentId::OpenCode), None);
    }

    #[tokio::test]
    async fn pending_permissions_accept_only_agent_provided_options() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let runtime = AgentRuntime::new(workspace, store, Vec::new());
        let (sender, receiver) = oneshot::channel();
        runtime
            .pending_permissions
            .lock()
            .expect("pending permission mutex")
            .insert(
                "permission-1".to_owned(),
                PendingPermission {
                    allowed_options: HashSet::from(["allow_once".to_owned()]),
                    request_payload: json!({"request_id":"permission-1"}),
                    run_id: "run-1".to_owned(),
                    sender,
                    always_allow: None,
                    requested_at: String::new(),
                    deadline: std::time::Instant::now(),
                },
            );

        assert!(!runtime.resolve_permission("permission-1", "invented_option"));
        assert!(runtime.resolve_permission("permission-1", "allow_once"));
        assert_eq!(
            selected_option(receiver.await.expect("permission outcome")),
            "allow_once"
        );
        assert!(!runtime.resolve_permission("permission-1", "allow_once"));
    }

    #[tokio::test]
    async fn escalating_a_team_permission_publishes_a_user_review_event() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project = workspace
            .create_project_at(temp.path().join("permission-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Review access",
                PermissionMode::Safe,
            )
            .expect("run");
        let runtime = AgentRuntime::new(workspace, Arc::clone(&store), Vec::new());
        let (sender, receiver) = oneshot::channel();
        runtime
            .pending_permissions
            .lock()
            .expect("pending permission mutex")
            .insert(
                "permission-1".to_owned(),
                PendingPermission {
                    allowed_options: HashSet::from(["allow_once".to_owned()]),
                    request_payload: json!({
                        "request_id":"permission-1",
                        "reviewer":"leader",
                        "options":[{"id":"allow_once","label":"Allow"}],
                    }),
                    run_id: run.id.clone(),
                    sender,
                    always_allow: None,
                    requested_at: String::new(),
                    deadline: std::time::Instant::now(),
                },
            );

        assert_eq!(
            runtime.pending_requests()[0].reviewer,
            "leader",
            "a Team leader reviews it first"
        );
        runtime
            .escalate_team_permission("permission-1")
            .expect("escalation");
        // The waiting request itself now says so, not only the event.
        let pending = runtime.pending_requests();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].reviewer, "user");

        let event = store
            .events_after(&run.id, 0)
            .expect("run events")
            .pop()
            .expect("permission event");
        assert_eq!(event.kind, AgentEventKind::PermissionRequested);
        assert_eq!(event.payload["reviewer"], "user");
        let workspace_event = store
            .workspace_events_after(0)
            .expect("workspace events")
            .into_iter()
            .find(|event| event.kind == "permission_requested")
            .expect("workspace permission event");
        assert_eq!(workspace_event.conversation_id, Some(conversation.id));
        assert_eq!(workspace_event.payload["reviewer"], "user");

        assert!(runtime.resolve_permission("permission-1", "allow_once"));
        assert_eq!(
            selected_option(receiver.await.expect("permission outcome")),
            "allow_once"
        );
    }

    #[tokio::test]
    async fn pending_requests_show_what_waits_and_cancelling_clears_it() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project = workspace
            .create_project_at(temp.path().join("pending-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(&conversation.id, &project.id, "Work", PermissionMode::Safe)
            .expect("run");
        let runtime = AgentRuntime::new(workspace, Arc::clone(&store), Vec::new());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let (permission_sender, permission_receiver) = oneshot::channel();
        runtime
            .pending_permissions
            .lock()
            .expect("pending permission mutex")
            .insert(
                "permission-1".to_owned(),
                PendingPermission {
                    allowed_options: HashSet::from(["allow_once".to_owned()]),
                    request_payload: json!({
                        "request_id": "permission-1",
                        "tool": "Shell",
                        "input": {"command": "rm -rf secret"},
                        "reviewer": "user",
                        "options": [{"id": "allow_once", "label": "Allow once", "kind": "allow_once"}],
                    }),
                    run_id: run.id.clone(),
                    sender: permission_sender,
                    always_allow: None,
                    requested_at: "2026-10-20 10:00:00.000".to_owned(),
                    deadline,
                },
            );
        let (input_sender, input_receiver) = oneshot::channel();
        runtime
            .pending_elicitations
            .lock()
            .expect("pending elicitation mutex")
            .insert(
                "input-1".to_owned(),
                PendingElicitation {
                    run_id: run.id.clone(),
                    sender: input_sender,
                    request_payload: json!({
                        "request_id": "input-1",
                        "message": "Choose a value",
                        "requestedSchema": {"type": "object"},
                    }),
                    requested_at: "2026-10-20 10:00:01.000".to_owned(),
                    deadline,
                },
            );

        let mut pending = runtime.pending_requests();
        pending.sort_by(|a, b| a.request_id.cmp(&b.request_id));
        assert_eq!(pending.len(), 2);
        let input = &pending[0];
        assert!(matches!(input.kind, PendingKind::Input));
        assert_eq!(input.message.as_deref(), Some("Choose a value"));
        assert_eq!(input.schema, Some(json!({"type": "object"})));
        assert_eq!(input.run_id, run.id);
        let permission = &pending[1];
        assert!(matches!(permission.kind, PendingKind::Permission));
        assert_eq!(permission.tool.as_deref(), Some("Shell"));
        assert_eq!(permission.reviewer, "user");
        assert_eq!(permission.options[0].id, "allow_once");
        assert_eq!(permission.requested_at, "2026-10-20 10:00:00.000");
        assert!(permission.deadline_ms > 50_000);
        let json = serde_json::to_string(&pending).expect("serialize");
        assert!(
            !json.contains("rm -rf"),
            "tool input is never shown: {json}"
        );

        // Stopping the run clears both, and every tab hears that the wait ended.
        let before = store.latest_workspace_event_id().expect("cursor");
        runtime.cancel(&run.id);
        assert!(runtime.pending_requests().is_empty());
        assert!(permission_receiver.await.is_ok());
        assert!(input_receiver.await.is_ok());
        let cleared = store
            .workspace_events_after(before)
            .expect("events")
            .into_iter()
            .filter(|event| {
                event.kind == "conversation_state" && event.payload["pending"].is_null()
            })
            .count();
        assert_eq!(cleared, 2);
    }

    #[test]
    fn the_manager_is_refused_native_edit_delete_move_and_execute_but_not_reading_or_its_own_tools()
    {
        for kind in [
            ToolKind::Edit,
            ToolKind::Delete,
            ToolKind::Move,
            ToolKind::Execute,
        ] {
            assert!(denied_for_manager(Some(kind)), "{kind:?}");
        }
        for kind in [
            ToolKind::Read,
            ToolKind::Search,
            ToolKind::Fetch,
            ToolKind::Think,
            ToolKind::Other,
        ] {
            assert!(!denied_for_manager(Some(kind)), "{kind:?}");
        }
        assert!(!denied_for_manager(None));
    }

    fn selected_option(outcome: RequestPermissionOutcome) -> String {
        let RequestPermissionOutcome::Selected(selected) = outcome else {
            panic!("selected outcome")
        };
        selected.option_id.to_string()
    }
}
