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
        let (run_id, mut payload) = {
            let permissions = self
                .pending_permissions
                .lock()
                .expect("pending permission mutex poisoned");
            let pending = permissions.get(request_id).ok_or_else(|| {
                RuntimeError::Acp("permission request is no longer active".into())
            })?;
            (pending.run_id.clone(), pending.request_payload.clone())
        };
        if let Value::Object(object) = &mut payload {
            object.insert("reviewer".into(), Value::String("user".into()));
        }
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
                pending.sender.send(action).is_ok()
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
        for request_id in request_ids {
            if let Some(pending) = permissions.remove(&request_id) {
                let _ = pending.sender.send(RequestPermissionOutcome::Cancelled);
            }
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
        for request_id in request_ids {
            if let Some(pending) = elicitations.remove(&request_id) {
                let _ = pending.sender.send(ElicitationAction::Cancel);
            }
        }
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
                },
            );

        runtime
            .escalate_team_permission("permission-1")
            .expect("escalation");

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

    fn selected_option(outcome: RequestPermissionOutcome) -> String {
        let RequestPermissionOutcome::Selected(selected) = outcome else {
            panic!("selected outcome")
        };
        selected.option_id.to_string()
    }
}
