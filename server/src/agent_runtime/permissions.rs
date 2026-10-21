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
    /// When it was asked (store timestamp form). A permission request waits
    /// until it is answered or its turn stops: it has no deadline.
    pub(super) requested_at: String,
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

/// Why the project manager's review of a permission request was refused.
#[derive(Debug, thiserror::Error)]
pub enum ManagerReviewError {
    #[error("only the project manager's current Session reviews specialists' permission requests")]
    NotManager,
    #[error("this permission request is no longer waiting on the project manager")]
    NotWaiting,
    #[error("{0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Store(#[from] crate::agents::StoreError),
    #[error("the roster could not be read: {0}")]
    Members(String),
}

/// What the manager decided on a specialist's request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagerVerdict {
    /// Answer with this agent-offered allow-once option (the first one when `None`).
    Approve(Option<String>),
    Deny,
    Escalate,
}

/// A specialist's permission request as the manager reviews it: unlike the
/// researcher's view it carries the tool's input, clipped, which the manager
/// needs to judge it. It is returned to the manager's Session only.
#[derive(Clone, Debug, Serialize)]
pub struct ManagerReviewRequest {
    pub request_id: String,
    pub conversation_id: String,
    pub member: Option<crate::attention::MemberRef>,
    pub tool: String,
    pub input: String,
    pub options: Vec<PendingOptionView>,
    pub requested_at: String,
}

/// How long a specialist's request waits for the manager before it is
/// escalated to the researcher by itself (ADR 0237).
pub const MANAGER_REVIEW_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// One decision on a waiting request, before it is recorded.
struct ReviewOutcome {
    tool: String,
    decision: &'static str,
    decided_by: &'static str,
    option_id: Option<String>,
    reason: String,
}

/// Longest tool input the manager is shown.
const REVIEW_INPUT_CHARS: usize = 4_000;
/// Longest reason the manager may record.
const REVIEW_REASON_CHARS: usize = 1_000;
/// Manager decisions the attention snapshot lists.
pub const MANAGER_DECISIONS_SHOWN: usize = 20;

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
    /// Milliseconds left before the server declines it; only an input
    /// request has a deadline, a permission request waits until answered.
    pub deadline_ms: Option<u64>,
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
        PendingRequestView {
            run_id: self.run_id.clone(),
            requested_at: self.requested_at.clone(),
            ..Self::view_payload(request_id, &self.request_payload)
        }
    }

    fn view_payload(request_id: &str, payload: &Value) -> PendingRequestView {
        PendingRequestView {
            kind: PendingKind::Permission,
            request_id: request_id.to_owned(),
            run_id: String::new(),
            requested_at: String::new(),
            deadline_ms: None,
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
            deadline_ms: Some(deadline_remaining_ms(self.deadline)),
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

/// How long a pending input (elicitation) request waits before the server
/// resolves it as declined (#111). Tunable via
/// `KUBECODE_PENDING_REQUEST_TIMEOUT_MS`. Permission requests have no
/// timeout: they wait until answered or their turn stops (ADR 0232).
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

    /// The project manager's public Session when `conversation_id` is a
    /// current specialist's: its permission requests are the manager's to
    /// review first (ADR 0237). `None` means the researcher reviews them.
    pub(super) fn manager_reviewer_session(&self, conversation_id: &str) -> Option<String> {
        let services = self.work_services()?;
        let conversation = self.store.get_conversation(conversation_id).ok()?;
        let resolved = services
            .members
            .by_conversation(&conversation.project_id, conversation_id)
            .ok()??;
        // A direct message is the researcher's own conversation: its
        // requests go straight to them.
        if !resolved.current
            || resolved.member.role != crate::member_store::MemberRole::Specialist
            || resolved.binding != crate::member_store::Binding::Public
        {
            return None;
        }
        services
            .members
            .general(&conversation.project_id)
            .ok()??
            .public_conversation_id
    }

    /// Asks the manager to review a waiting request by a durable route to its
    /// Session. If that cannot be written, the researcher is asked instead.
    pub(super) fn route_permission_review(
        &self,
        request_id: &str,
        run_id: &str,
        conversation_id: &str,
        manager_session: &str,
        tool: &str,
    ) {
        let routed = self.work_services().is_some_and(|services| {
            let project_id = match self.store.get_run(run_id) {
                Ok(run) => run.project_id,
                Err(_) => return false,
            };
            let specialist = services
                .members
                .by_conversation(&project_id, conversation_id)
                .ok()
                .flatten()
                .map_or_else(
                    || "A specialist".to_owned(),
                    |resolved| format!("@{}", resolved.member.handle),
                );
            services
                .orchestrator
                .route_permission_review(&project_id, manager_session, request_id, &specialist, tool)
                .map_err(|error| {
                    eprintln!(
                        "WARN: permission request {request_id} could not be routed to the manager: {error}"
                    );
                })
                .is_ok()
        });
        if !routed {
            self.system_escalate(request_id, "route_failed");
            return;
        }
        // Undecided in time, it goes to the researcher by itself.
        let timeout = *self
            .manager_review_timeout
            .lock()
            .expect("manager review timeout mutex poisoned");
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let runtime = self.clone();
            let request_id = request_id.to_owned();
            handle.spawn(async move {
                tokio::time::sleep(timeout).await;
                runtime.system_escalate(&request_id, "timeout");
            });
        }
    }

    /// Escalates a request still waiting on the manager to the researcher,
    /// recorded as the server's decision with a reason code.
    pub(super) fn system_escalate(&self, request_id: &str, code: &str) {
        let (run_id, tool) = {
            let permissions = self
                .pending_permissions
                .lock()
                .expect("pending permission mutex poisoned");
            let Some(pending) = permissions
                .get(request_id)
                .filter(|pending| pending.request_payload["reviewer"] == "manager")
            else {
                return;
            };
            (
                pending.run_id.clone(),
                text_field(&pending.request_payload, "tool", 200).unwrap_or_default(),
            )
        };
        if self.escalate_team_permission(request_id).is_err() {
            return;
        }
        let Ok(run) = self.store.get_run(&run_id) else {
            return;
        };
        let _ = self.record_review(
            &run,
            request_id,
            ReviewOutcome {
                tool,
                decision: "escalated",
                decided_by: "system",
                option_id: None,
                reason: code.to_owned(),
            },
        );
    }

    #[cfg(test)]
    pub(crate) fn set_manager_review_timeout(&self, timeout: std::time::Duration) {
        *self
            .manager_review_timeout
            .lock()
            .expect("manager review timeout mutex poisoned") = timeout;
    }

    fn record_review(
        &self,
        run: &AgentRun,
        request_id: &str,
        outcome: ReviewOutcome,
    ) -> Result<crate::agent_store::ManagerPermissionReview, ManagerReviewError> {
        let review = crate::agent_store::ManagerPermissionReview {
            id: Uuid::new_v4().to_string(),
            project_id: run.project_id.clone(),
            request_id: request_id.to_owned(),
            run_id: run.id.clone(),
            conversation_id: run.conversation_id.clone(),
            tool: outcome.tool,
            decision: outcome.decision.to_owned(),
            decided_by: outcome.decided_by.to_owned(),
            option_id: outcome.option_id,
            reason: outcome.reason,
            created_at: crate::agent_store::utc_now(),
        };
        self.store.record_manager_review(&review)?;
        let _ = self.store.append_workspace_event(
            "permission_reviewed",
            Some(&run.project_id),
            Some(&run.conversation_id),
            Some(&run.id),
            &json!({
                "request_id": request_id,
                "conversation_id": run.conversation_id,
                "decision": review.decision,
            }),
        );
        Ok(review)
    }

    /// Specialists' permission requests in `project_id` waiting on the manager.
    pub fn manager_review_queue(
        &self,
        project_id: &str,
        caller: &str,
    ) -> Result<Vec<ManagerReviewRequest>, ManagerReviewError> {
        self.require_manager(project_id, caller)?;
        let waiting: Vec<(String, String, Value, String)> = self
            .pending_permissions
            .lock()
            .expect("pending permission mutex poisoned")
            .iter()
            .filter(|(_, pending)| pending.request_payload["reviewer"] == "manager")
            .map(|(request_id, pending)| {
                (
                    request_id.clone(),
                    pending.run_id.clone(),
                    pending.request_payload.clone(),
                    pending.requested_at.clone(),
                )
            })
            .collect();
        let members = self.work_services().map(|services| services.members);
        let mut requests = Vec::new();
        for (request_id, run_id, payload, requested_at) in waiting {
            let Ok(run) = self.store.get_run(&run_id) else {
                continue;
            };
            if run.project_id != project_id {
                continue;
            }
            let view = PendingPermission::view_payload(&request_id, &payload);
            let member = members
                .as_ref()
                .and_then(|members| {
                    members
                        .by_conversation(project_id, &run.conversation_id)
                        .ok()
                        .flatten()
                })
                .map(|resolved| crate::attention::MemberRef {
                    id: resolved.member.id,
                    name: resolved.member.name,
                    handle: resolved.member.handle,
                    role: resolved.member.role.as_str().to_owned(),
                });
            let input = serde_json::to_string(payload.get("input").unwrap_or(&Value::Null))
                .unwrap_or_default()
                .chars()
                .take(REVIEW_INPUT_CHARS)
                .collect();
            requests.push(ManagerReviewRequest {
                request_id,
                conversation_id: run.conversation_id,
                member,
                tool: view.tool.unwrap_or_default(),
                input,
                options: view.options,
                requested_at,
            });
        }
        requests.sort_by(|a, b| a.requested_at.cmp(&b.requested_at));
        Ok(requests)
    }

    /// The manager approves, denies, or escalates a specialist's waiting
    /// request, with a reason; the decision is recorded and announced without
    /// the tool's input or the reason (ADR 0237).
    pub fn manager_review_permission(
        &self,
        project_id: &str,
        caller: &str,
        request_id: &str,
        verdict: ManagerVerdict,
        reason: &str,
    ) -> Result<crate::agent_store::ManagerPermissionReview, ManagerReviewError> {
        self.require_manager(project_id, caller)?;
        let reason = reason.trim();
        if reason.is_empty() {
            return Err(ManagerReviewError::Invalid(
                "a decision needs a reason the researcher can read",
            ));
        }
        let reason: String = reason.chars().take(REVIEW_REASON_CHARS).collect();
        let mut permissions = self
            .pending_permissions
            .lock()
            .expect("pending permission mutex poisoned");
        let pending = permissions
            .get(request_id)
            .filter(|pending| pending.request_payload["reviewer"] == "manager")
            .ok_or(ManagerReviewError::NotWaiting)?;
        let run = self.store.get_run(&pending.run_id)?;
        if run.project_id != project_id {
            return Err(ManagerReviewError::NotWaiting);
        }
        let view = PendingPermission::view_payload(request_id, &pending.request_payload);
        let option_of_kind = |kind: &str| {
            view.options
                .iter()
                .find(|option| option.kind == kind)
                .map(|option| option.id.clone())
        };
        let (decision, option_id) = match &verdict {
            ManagerVerdict::Approve(chosen) => {
                let option = match chosen {
                    Some(chosen) => view
                        .options
                        .iter()
                        .find(|option| option.id == *chosen && option.kind == "allow_once")
                        .map(|option| option.id.clone())
                        .ok_or(ManagerReviewError::Invalid(
                            "approve with one of the request's allow-once options",
                        ))?,
                    None => option_of_kind("allow_once").ok_or(ManagerReviewError::Invalid(
                        "this request offers no allow-once option; escalate it to the researcher",
                    ))?,
                };
                ("approved", Some(option))
            }
            ManagerVerdict::Deny => ("denied", option_of_kind("reject_once")),
            ManagerVerdict::Escalate => ("escalated", None),
        };
        let tool = view.tool.clone().unwrap_or_default();
        let run_id = pending.run_id.clone();
        if verdict == ManagerVerdict::Escalate {
            drop(permissions);
            self.escalate_team_permission(request_id)
                .map_err(|_| ManagerReviewError::NotWaiting)?;
        } else {
            let pending = permissions
                .remove(request_id)
                .ok_or(ManagerReviewError::NotWaiting)?;
            drop(permissions);
            let outcome = match &option_id {
                Some(option) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    PermissionOptionId::new(option.clone()),
                )),
                None => RequestPermissionOutcome::Cancelled,
            };
            // Never remembered: a manager's approval adds nothing to
            // always-allow memory, which only the researcher writes.
            let _ = pending.sender.send(outcome);
            announce_wait_ended(&self.store, &run_id);
        }
        self.record_review(
            &run,
            request_id,
            ReviewOutcome {
                tool,
                decision,
                decided_by: "manager",
                option_id,
                reason,
            },
        )
    }

    fn require_manager(&self, project_id: &str, caller: &str) -> Result<(), ManagerReviewError> {
        let services = self.work_services().ok_or(ManagerReviewError::NotManager)?;
        let manager = services
            .members
            .is_general(project_id, caller)
            .map_err(|error| ManagerReviewError::Members(error.to_string()))?;
        if manager {
            Ok(())
        } else {
            Err(ManagerReviewError::NotManager)
        }
    }

    /// Registers a permission request exactly as the session actor does for
    /// a provider's request, without a provider.
    #[cfg(test)]
    pub(crate) fn ask_permission_for_test(
        &self,
        conversation_id: &str,
        run_id: &str,
        request_id: &str,
        tool: &str,
        input: Value,
        options: &[(&str, &str)],
    ) -> oneshot::Receiver<RequestPermissionOutcome> {
        let manager_session = self.manager_reviewer_session(conversation_id);
        let reviewer = if manager_session.is_some() {
            "manager"
        } else {
            "user"
        };
        let (sender, receiver) = oneshot::channel();
        self.pending_permissions
            .lock()
            .expect("pending permission mutex poisoned")
            .insert(
                request_id.to_owned(),
                PendingPermission {
                    allowed_options: options.iter().map(|(id, _)| (*id).to_owned()).collect(),
                    request_payload: json!({
                        "request_id": request_id,
                        "tool": tool,
                        "input": input,
                        "reviewer": reviewer,
                        "options": options.iter().map(|(id, kind)| json!({
                            "id": id, "label": id, "kind": kind,
                        })).collect::<Vec<_>>(),
                    }),
                    run_id: run_id.to_owned(),
                    sender,
                    always_allow: None,
                    requested_at: crate::agent_store::utc_now(),
                },
            );
        if let Some(manager_session) = manager_session {
            self.route_permission_review(
                request_id,
                run_id,
                conversation_id,
                &manager_session,
                tool,
            );
        }
        receiver
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

/// The native mode a permission profile sets when a session starts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum NativeMode {
    /// The provider's own default (or its launch environment) stands.
    Unchanged,
    /// Set through the `mode` session config option.
    Config(&'static str),
    /// Set through `session/set_mode`.
    Session(&'static str),
}

/// What each profile asks of each provider. The manager runs with full native
/// permissions, like a Maximum (Yolo) Team member (ADR 0237); OpenCode's full
/// access is set in its launch environment instead.
pub(super) fn native_mode(profile: AgentPermissionProfile, agent_id: AgentId) -> NativeMode {
    match (profile, agent_id) {
        (AgentPermissionProfile::Default, _)
        | (AgentPermissionProfile::Maximum | AgentPermissionProfile::Manager, AgentId::OpenCode) => {
            NativeMode::Unchanged
        }
        (AgentPermissionProfile::Maximum | AgentPermissionProfile::Manager, AgentId::Codex) => {
            NativeMode::Config("agent-full-access")
        }
        (
            AgentPermissionProfile::Maximum | AgentPermissionProfile::Manager,
            AgentId::ClaudeCode,
        ) => NativeMode::Config("bypassPermissions"),
        (AgentPermissionProfile::ReadOnly, AgentId::Codex) => NativeMode::Config("read-only"),
        (AgentPermissionProfile::ReadOnly, AgentId::ClaudeCode) => NativeMode::Config("plan"),
        (AgentPermissionProfile::ReadOnly, AgentId::OpenCode) => NativeMode::Session("plan"),
    }
}

pub(super) async fn apply_native_permission_profile(
    connection: &ConnectionTo<Agent>,
    session_id: &agent_client_protocol::schema::v1::SessionId,
    agent_id: AgentId,
    profile: AgentPermissionProfile,
) -> Result<(), agent_client_protocol::Error> {
    // A widening profile that cannot be applied is reported as such; a
    // read-only one fails with the provider's own error.
    let widening = matches!(
        profile,
        AgentPermissionProfile::Maximum | AgentPermissionProfile::Manager
    );
    match native_mode(profile, agent_id) {
        NativeMode::Unchanged => Ok(()),
        NativeMode::Config(value) => {
            let result = connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    "mode",
                    SessionConfigOptionValue::value_id(value.to_owned()),
                ))
                .block_task()
                .await;
            match result {
                Ok(_) => Ok(()),
                Err(error) if widening => Err(native_permission_error(error)),
                Err(error) => Err(error),
            }
        }
        NativeMode::Session(mode) => {
            connection
                .send_request(SetSessionModeRequest::new(session_id.clone(), mode))
                .block_task()
                .await?;
            Ok(())
        }
    }
}

/// How a request from the manager's own provider is answered: granted once,
/// without asking anyone (ADR 0237). Never an always option while an
/// allow-once is offered, so nothing is added to always-allow memory.
pub(super) fn manager_self_grant(options: &[PermissionOption]) -> RequestPermissionOutcome {
    options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::AllowOnce)
        .or_else(|| {
            options
                .iter()
                .find(|option| option.kind == PermissionOptionKind::AllowAlways)
        })
        .map_or(RequestPermissionOutcome::Cancelled, |option| {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                option.option_id.clone(),
            ))
        })
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
    fn a_manager_session_launches_with_full_native_permissions() {
        assert_eq!(
            native_mode(AgentPermissionProfile::Manager, AgentId::ClaudeCode),
            NativeMode::Config("bypassPermissions")
        );
        assert_eq!(
            native_mode(AgentPermissionProfile::Manager, AgentId::Codex),
            NativeMode::Config("agent-full-access")
        );
        // OpenCode's full access is in its launch environment.
        assert_eq!(
            native_mode(AgentPermissionProfile::Manager, AgentId::OpenCode),
            NativeMode::Unchanged
        );
        // The other profiles keep their modes.
        assert_eq!(
            native_mode(AgentPermissionProfile::ReadOnly, AgentId::Codex),
            NativeMode::Config("read-only")
        );
        assert_eq!(
            native_mode(AgentPermissionProfile::ReadOnly, AgentId::OpenCode),
            NativeMode::Session("plan")
        );
        assert_eq!(
            native_mode(AgentPermissionProfile::Default, AgentId::Codex),
            NativeMode::Unchanged
        );
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
        // Only what the server enforces has a deadline: an input request
        // declines by itself, a permission request waits until answered.
        assert_eq!(permission.deadline_ms, None);
        assert!(input.deadline_ms.is_some_and(|left| left > 50_000));
        assert_eq!(
            serde_json::to_value(permission).unwrap()["deadline_ms"],
            Value::Null
        );
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
    fn the_manager_s_own_requests_are_granted_once_without_asking() {
        let option = |id: &str, kind| PermissionOption::new(id.to_owned(), id.to_owned(), kind);
        let options = [
            option("always", PermissionOptionKind::AllowAlways),
            option("once", PermissionOptionKind::AllowOnce),
            option("reject", PermissionOptionKind::RejectOnce),
        ];
        assert_eq!(selected_option(manager_self_grant(&options)), "once");
        // Without an allow-once option it still proceeds, with the agent's
        // own allow option.
        assert_eq!(selected_option(manager_self_grant(&options[..1])), "always");
        // Nothing to allow with: the tool call is cancelled.
        assert!(matches!(
            manager_self_grant(&options[2..]),
            RequestPermissionOutcome::Cancelled
        ));
    }

    fn selected_option(outcome: RequestPermissionOutcome) -> String {
        let RequestPermissionOutcome::Selected(selected) = outcome else {
            panic!("selected outcome")
        };
        selected.option_id.to_string()
    }
}
