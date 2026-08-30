use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    BooleanConfigOptionCapabilities, CancelNotification, ClientCapabilities,
    ClientSessionCapabilities, CreateElicitationRequest, CreateElicitationResponse,
    ElicitationAction, ElicitationCapabilities, ElicitationFormCapabilities, InitializeRequest,
    LoadSessionRequest, McpServer, NewSessionRequest, NewSessionResponse, PermissionOptionKind,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResumeSessionRequest, SessionConfigOptionValue, SessionConfigOptionsCapabilities, SessionId,
    SessionNotification, SetSessionConfigOptionRequest, SetSessionModeRequest, StopReason,
};
use agent_client_protocol::{ActiveSession, Agent, ConnectionTo, LineDirection};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::agents::{AgentEventKind, AgentRun, AgentStore, RunStatus, TerminalCause};
use crate::composer_catalog::ComposerInvocation;
use crate::teams::TeamMemberStatus;

use super::adapter::acp_agent;
use super::agent_seam;
use super::events::terminal_outcome;
use super::journal::{
    SessionUpdateJournal, SessionUpdateSink, finish_journal, journal_protocol_error,
    persist_serialized_session_event, persist_serialized_session_state_checkpoint,
};
use super::permissions::{
    AlwaysAllowContext, PendingElicitation, PendingPermission, SideQuestionAccepted,
    always_allow_matcher, apply_native_permission_profile, remembered_permission_outcome,
    start_side_question,
};
use super::{
    AgentRuntime, AgentSessionConfig, AgentStartupStage, RuntimeError, RuntimeFailure,
    SessionActorGeneration, SessionActorHandle,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum SessionConfigInput {
    Boolean(bool),
    ValueId(String),
}

pub(super) struct AgentCommand {
    pub(super) run: AgentRun,
    pub(super) message: String,
    pub(super) provider_input: Option<Box<ComposerInvocation>>,
    pub(super) cancelled: oneshot::Receiver<()>,
}

fn prompt_request_for_command(session_id: &SessionId, command: &AgentCommand) -> PromptRequest {
    let mut request = PromptRequest::new(session_id.clone(), vec![command.message.clone().into()]);
    if let Some(ComposerInvocation::ProviderStructuredInput {
        adapter_kind,
        payload,
    }) = command.provider_input.as_deref()
    {
        request.meta = json!({
            "kubecode": {
                "providerStructuredInput": {
                    "adapterKind": adapter_kind,
                    "payload": payload,
                }
            }
        })
        .as_object()
        .cloned();
    }
    request
}

pub(super) enum SessionCommand {
    Prompt(AgentCommand),
    Ready {
        response: oneshot::Sender<Result<(), RuntimeFailure>>,
    },
    SetMode {
        mode_id: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    SetConfig {
        config_id: String,
        value: SessionConfigInput,
        response: oneshot::Sender<Result<(), String>>,
    },
    SideQuestion {
        id: String,
        question: String,
        response: oneshot::Sender<Result<SideQuestionAccepted, RuntimeError>>,
    },
    Shutdown {
        response: oneshot::Sender<()>,
    },
}

async fn process_session_control(
    connection: &ConnectionTo<Agent>,
    session_id: &agent_client_protocol::schema::v1::SessionId,
    command: SessionCommand,
    store: &AgentStore,
    conversation_id: &str,
    journal: &SessionUpdateSink,
) -> Option<AgentCommand> {
    match command {
        SessionCommand::Prompt(command) => Some(command),
        SessionCommand::Ready { response } => {
            let _ = response.send(Ok(()));
            None
        }
        SessionCommand::SetMode { mode_id, response } => {
            let selected_mode = mode_id.clone();
            let result = match connection
                .send_request(SetSessionModeRequest::new(session_id.clone(), mode_id))
                .block_task()
                .await
            {
                Ok(_) => match journal.flush().await {
                    Ok(()) => persist_serialized_session_state_checkpoint(
                        store,
                        conversation_id,
                        "current_mode",
                        json!({"currentModeId":selected_mode}),
                        journal.generation.as_ref(),
                    )
                    .map_err(|error| error.to_string()),
                    Err(error) => Err(error.to_string()),
                },
                Err(error) => Err(error.to_string()),
            };
            let _ = response.send(result);
            None
        }
        SessionCommand::SetConfig {
            config_id,
            value,
            response,
        } => {
            let value = match value {
                SessionConfigInput::Boolean(value) => SessionConfigOptionValue::boolean(value),
                SessionConfigInput::ValueId(value) => SessionConfigOptionValue::value_id(value),
            };
            let result = match connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    config_id,
                    value,
                ))
                .block_task()
                .await
            {
                Ok(update) => match journal.flush().await {
                    Ok(()) => persist_serialized_session_state_checkpoint(
                        store,
                        conversation_id,
                        "config_options",
                        update,
                        journal.generation.as_ref(),
                    )
                    .map_err(|error| error.to_string()),
                    Err(error) => Err(error.to_string()),
                },
                Err(error) => Err(error.to_string()),
            };
            let _ = response.send(result);
            None
        }
        SessionCommand::SideQuestion { response, .. } => {
            let _ = response.send(Err(RuntimeError::SideQuestionInactive));
            None
        }
        SessionCommand::Shutdown { response } => {
            let _ = response.send(());
            None
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AcpRunOutcome {
    Completed { stop_reason: StopReason },
    Cancelled,
}

async fn run_acp_session(
    runtime: AgentRuntime,
    config: AgentSessionConfig,
    receiver: &mut mpsc::UnboundedReceiver<SessionCommand>,
    active_run_id: Arc<Mutex<Option<String>>>,
    actor_active: Arc<AtomicBool>,
    last_activity: Arc<AtomicU64>,
    generation: SessionActorGeneration,
) -> Result<(), RuntimeError> {
    let hydrate_provider_history = config.provider_session_id.is_some()
        && runtime
            .store
            .session_events_after(&config.conversation_id, 0)?
            .is_empty();
    let session_responses = SessionResponseCapture::default();
    let response_capture = Arc::clone(&session_responses);
    let agent = acp_agent(
        config.agent_id,
        &config.descriptor,
        config.permission_profile,
        &config.cwd,
    )?
    .with_debug(move |line, direction| {
        capture_new_session_response(&response_capture, line, direction)
    });
    let update_journal = SessionUpdateJournal::spawn_guarded(
        Arc::clone(&runtime.store),
        config.conversation_id.clone(),
        generation.clone(),
    );
    let notification_journal = update_journal.sink();
    let permission_journal = update_journal.sink();
    let elicitation_journal = update_journal.sink();
    let connection_journal = update_journal.sink();
    let update_run_id = Arc::clone(&active_run_id);
    let runtime_for_adapters = runtime.clone();
    let config_agent_id = config.agent_id;
    let permission_store = Arc::clone(&runtime.store);
    let permission_run_id = Arc::clone(&active_run_id);
    let pending_permissions = Arc::clone(&runtime.pending_permissions);
    let permission_runtime = runtime.clone();
    let permission_conversation_id = config.conversation_id.clone();
    let elicitation_store = Arc::clone(&runtime.store);
    let elicitation_run_id = Arc::clone(&active_run_id);
    let pending_elicitations = Arc::clone(&runtime.pending_elicitations);
    let store = Arc::clone(&runtime.store);
    let conversation_id = config.conversation_id;
    let provider_session_id = config.provider_session_id;
    let cwd = config.cwd;
    let captured_session_responses = Arc::clone(&session_responses);
    let startup_stage = Arc::new(Mutex::new(Some(AgentStartupStage::ProcessSpawn)));
    let connection_stage = Arc::clone(&startup_stage);

    let result = agent_client_protocol::Client
        .builder()
        .name("Kubecode")
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                let run_id = update_run_id
                    .lock()
                    .expect("active run mutex poisoned")
                    .clone();
                // Per-agent translation seam (#104): 1:1 keep, drop, or 1:N
                // synthetic — synthetic updates enter the unified journal
                // path directly, never through preprocess again.
                let adapter = runtime_for_adapters.adapter_for(config_agent_id);
                let updates = match adapter.preprocess_notification(&notification.update) {
                    agent_seam::NotificationFlow::Keep(update) => vec![*update],
                    agent_seam::NotificationFlow::Drop => Vec::new(),
                    agent_seam::NotificationFlow::Synthesize(synthetic) => synthetic,
                };
                for update in updates {
                    notification_journal
                        .enqueue(run_id.clone(), update)
                        .await
                        .map_err(journal_protocol_error)?;
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                permission_journal
                    .flush()
                    .await
                    .map_err(journal_protocol_error)?;
                let run_id = permission_run_id
                    .lock()
                    .expect("active run mutex poisoned")
                    .clone();
                let request_id = Uuid::new_v4().to_string();
                let team_member = permission_runtime
                    .team_store()
                    .and_then(|teams| {
                        teams
                            .member_for_conversation(&permission_conversation_id)
                            .ok()
                            .flatten()
                            .map(|member| (teams, member))
                    });
                let discriminator_request = team_member
                    .as_ref()
                    .is_some_and(|(_, member)| {
                        member.role == crate::teams::TeamRole::Discriminator
                    });
                let team_permission = team_member.filter(|(_, member)| {
                    member.role == crate::teams::TeamRole::Teammate
                });
                let reviewer = if team_permission.is_some() { "leader" } else { "user" };
                let should_route_to_leader = team_permission.is_some();
                let request_payload = json!({
                    "request_id": request_id,
                    "tool_id": request.tool_call.tool_call_id.to_string(),
                    "tool": request.tool_call.fields.title,
                    "input": request.tool_call.fields.raw_input,
                    "reviewer": reviewer,
                    "options": request.options.iter().map(|option| json!({
                        "id": option.option_id.to_string(),
                        "label": option.name,
                        "kind": option.kind,
                    })).collect::<Vec<_>>(),
                });
                let outcome = if discriminator_request {
                    RequestPermissionOutcome::Cancelled
                } else if let Some(run_id) = run_id.as_deref()
                    && let Some(outcome) = remembered_permission_outcome(
                        &permission_runtime,
                        run_id,
                        request.tool_call.fields.kind,
                        &request.options,
                    )
                {
                    // Always-allow memory: this class of tool was granted for
                    // the project before; answer without surfacing it.
                    outcome
                } else if let Some(run_id) = run_id {
                    let _ = permission_store
                        .set_run_status(&run_id, RunStatus::WaitingPermission);
                    let _ = permission_store.append_event(
                        &run_id,
                        AgentEventKind::PermissionRequested,
                        &request_payload,
                    );
                    if let Ok(run) = permission_store.get_run(&run_id) {
                        let _ = permission_store.append_workspace_event(
                            "permission_requested",
                            Some(&run.project_id),
                            Some(&run.conversation_id),
                            Some(&run.id),
                            &request_payload,
                        );
                    }
                    // Always-allow persistence context: scope comes from the
                    // run's project and the conversation's agent; the matcher
                    // is kind-granular only. Without both scopes the request
                    // still surfaces, it just cannot be remembered.
                    let always_allow = permission_store
                        .get_conversation(&permission_conversation_id)
                        .ok()
                        .zip(permission_store.get_run(&run_id).ok())
                        .map(|(conversation, run)| {
                            let option_ids = request
                                .options
                                .iter()
                                .filter(|option| option.kind == PermissionOptionKind::AllowAlways)
                                .map(|option| option.option_id.to_string())
                                .collect::<HashSet<_>>();
                            (
                                AlwaysAllowContext {
                                    project_id: run.project_id.clone(),
                                    agent_id: conversation.agent_id,
                                    matcher: always_allow_matcher(request.tool_call.fields.kind),
                                },
                                option_ids,
                            )
                        });
                    let (sender, receiver) = oneshot::channel();
                    pending_permissions
                        .lock()
                        .expect("pending permission mutex poisoned")
                        .insert(
                            request_id.clone(),
                            PendingPermission {
                                allowed_options: request
                                    .options
                                    .iter()
                                    .map(|option| option.option_id.to_string())
                                    .collect(),
                                request_payload: request_payload.clone(),
                                run_id: run_id.clone(),
                                sender,
                                always_allow,
                            },
                        );
                    let mut routed_to_leader = false;
                    if let Some((teams, member)) = team_permission {
                        let team = teams.get_team(&member.team_id).ok();
                        let input_json = serde_json::to_string(
                            &request_payload.get("input").cloned().unwrap_or(Value::Null),
                        )
                        .unwrap_or_else(|_| "null".into());
                        let options_json = serde_json::to_string(
                            &request_payload.get("options").cloned().unwrap_or_else(|| json!([])),
                        )
                        .unwrap_or_else(|_| "[]".into());
                        if let Some(team) = team
                            && teams
                                .create_permission_request(
                                    crate::teams::NewTeamPermissionRequest {
                                        id: &request_id,
                                        team_id: &team.id,
                                        member_id: &member.id,
                                        conversation_id: &permission_conversation_id,
                                        run_id: &run_id,
                                        tool: request_payload
                                            .get("tool")
                                            .and_then(Value::as_str)
                                            .unwrap_or("Tool"),
                                        input_json: &input_json,
                                        options_json: &options_json,
                                    },
                                )
                                .is_ok()
                        {
                            routed_to_leader = true;
                            let _ = teams.set_member_status(
                                &member.id,
                                TeamMemberStatus::WaitingPermission,
                            );
                            let _ = teams.append_activity(
                                &team.id,
                                Some(&member.id),
                                None,
                                "permission_requested",
                                &format!("{} requested permission", member.name),
                                Some(&request_id),
                            );
                            let _ = teams.send_message(
                                &team.id,
                                &member.id,
                                &team.leader_member_id,
                                crate::teams::TeamMessageKind::System,
                                None,
                                &format!(
                                    "Teammate {} needs a permission review. Request ID: {}. Call team_get_context, then team_review_permission.",
                                    member.name, request_id
                                ),
                            );
                            let _ = permission_runtime.store.append_workspace_event(
                                "team_permission_updated",
                                Some(&team.project_id),
                                Some(&permission_conversation_id),
                                Some(&run_id),
                                &json!({"team_id":team.id, "request_id":request_id}),
                            );
                            let _ = permission_runtime.wake_team_leader(&team.id);
                        }
                    }
                    if should_route_to_leader && !routed_to_leader {
                        let _ = permission_runtime.escalate_team_permission(&request_id);
                    }
                    let outcome = receiver
                        .await
                        .unwrap_or(RequestPermissionOutcome::Cancelled);
                    pending_permissions
                        .lock()
                        .expect("pending permission mutex poisoned")
                        .remove(&request_id);
                    if matches!(outcome, RequestPermissionOutcome::Cancelled)
                        && let Some(teams) = permission_runtime.team_store()
                    {
                        let _ = teams.cancel_permission_request(&request_id);
                    }
                    let _ = permission_store.set_run_status(&run_id, RunStatus::Running);
                    let _ = permission_store.append_event(
                        &run_id,
                        AgentEventKind::PermissionResolved,
                        &json!({"request_id":request_id, "outcome": outcome}),
                    );
                    outcome
                } else {
                    RequestPermissionOutcome::Cancelled
                };
                responder.respond(RequestPermissionResponse::new(outcome))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CreateElicitationRequest, responder, _connection| {
                elicitation_journal
                    .flush()
                    .await
                    .map_err(journal_protocol_error)?;
                let run_id = elicitation_run_id
                    .lock()
                    .expect("active run mutex poisoned")
                    .clone();
                let request_id = Uuid::new_v4().to_string();
                let mut payload = serde_json::to_value(&request).unwrap_or_else(|_| json!({}));
                if let Value::Object(object) = &mut payload {
                    object.insert("request_id".into(), Value::String(request_id.clone()));
                }
                let action = if let Some(run_id) = run_id {
                    let _ = elicitation_store
                        .set_run_status(&run_id, RunStatus::WaitingPermission);
                    let _ = elicitation_store.append_event(
                        &run_id,
                        AgentEventKind::ElicitationRequested,
                        &payload,
                    );
                    let (sender, receiver) = oneshot::channel();
                    pending_elicitations
                        .lock()
                        .expect("pending elicitation mutex poisoned")
                        .insert(
                            request_id.clone(),
                            PendingElicitation {
                                run_id: run_id.clone(),
                                sender,
                            },
                        );
                    let action = tokio::time::timeout(Duration::from_secs(5 * 60), receiver)
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or(ElicitationAction::Cancel);
                    pending_elicitations
                        .lock()
                        .expect("pending elicitation mutex poisoned")
                        .remove(&request_id);
                    let _ = elicitation_store.set_run_status(&run_id, RunStatus::Running);
                    let _ = elicitation_store.append_event(
                        &run_id,
                        AgentEventKind::ElicitationResolved,
                        &json!({"request_id":request_id, "action":action}),
                    );
                    action
                } else {
                    ElicitationAction::Cancel
                };
                responder.respond(CreateElicitationResponse::new(action))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
            set_startup_stage(&connection_stage, AgentStartupStage::Initialize);
            let initialization = connection
                .send_request(
                    InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
                        ClientCapabilities::new()
                            .session(ClientSessionCapabilities::new().config_options(
                                SessionConfigOptionsCapabilities::new()
                                    .boolean(BooleanConfigOptionCapabilities::new()),
                            ))
                            .elicitation(
                                ElicitationCapabilities::new()
                                    .form(ElicitationFormCapabilities::new()),
                            ),
                    ),
                )
                .block_task()
                .await?;
            persist_serialized_session_event(
                &store,
                &conversation_id,
                "capabilities",
                &initialization.agent_capabilities,
                Some(&generation),
            )?;
            let team_mcp_http = if initialization.agent_capabilities.mcp_capabilities.http {
                runtime
                    .team_mcp_http_server(&conversation_id)
                    .map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })?
            } else {
                None
            };

            let (session_id, _team_session) = if let Some(session_id) = provider_session_id {
                if hydrate_provider_history && initialization.agent_capabilities.load_session {
                    set_startup_stage(&connection_stage, AgentStartupStage::SessionLoad);
                    let response = connection
                        .send_request(
                            LoadSessionRequest::new(session_id.clone(), cwd.clone())
                                .mcp_servers(team_mcp_http.clone().into_iter().collect()),
                        )
                        .block_task()
                        .await?;
                    connection_journal
                        .flush()
                        .await
                        .map_err(journal_protocol_error)?;
                    persist_serialized_session_state_checkpoint(
                        &store,
                        &conversation_id,
                        "session_loaded",
                        response,
                        Some(&generation),
                    )?;
                    (session_id.into(), None)
                } else {
                    let resumed = if initialization
                    .agent_capabilities
                    .session_capabilities
                    .resume
                    .is_some()
                    {
                        set_startup_stage(&connection_stage, AgentStartupStage::SessionResume);
                        match connection
                            .send_request(
                                ResumeSessionRequest::new(session_id.clone(), cwd.clone())
                                    .mcp_servers(team_mcp_http.clone().into_iter().collect()),
                            )
                            .block_task()
                            .await
                        {
                            Ok(response) => {
                                connection_journal
                                    .flush()
                                    .await
                                    .map_err(journal_protocol_error)?;
                                persist_serialized_session_event(
                                    &store,
                                    &conversation_id,
                                    "session_resumed",
                                    response,
                                    Some(&generation),
                                )?;
                                true
                            }
                            Err(_) => false,
                        }
                    } else {
                        false
                    };
                    if resumed {
                        (session_id.into(), None)
                    } else {
                        set_startup_stage(&connection_stage, AgentStartupStage::SessionLoad);
                        match connection
                            .send_request(LoadSessionRequest::new(
                                session_id.clone(),
                                cwd.clone(),
                            ).mcp_servers(team_mcp_http.clone().into_iter().collect()))
                            .block_task()
                            .await
                        {
                            Ok(response) => {
                                connection_journal
                                    .flush()
                                    .await
                                    .map_err(journal_protocol_error)?;
                                persist_serialized_session_state_checkpoint(
                                    &store,
                                    &conversation_id,
                                    "session_loaded",
                                    response,
                                    Some(&generation),
                                )?;
                                (session_id.into(), None)
                            }
                            Err(_) => {
                                create_provider_session(
                                    &connection,
                                    cwd.clone(),
                                    ProviderSessionCreation {
                                        runtime: &runtime,
                                        conversation_id: &conversation_id,
                                        team_mcp_http: team_mcp_http.clone(),
                                        captured_responses: &captured_session_responses,
                                        startup_stage: &connection_stage,
                                        journal: &connection_journal,
                                        generation: &generation,
                                    },
                                )
                                .await?
                            }
                        }
                    }
                }
            } else {
                create_provider_session(
                    &connection,
                    cwd.clone(),
                    ProviderSessionCreation {
                        runtime: &runtime,
                        conversation_id: &conversation_id,
                        team_mcp_http,
                        captured_responses: &captured_session_responses,
                        startup_stage: &connection_stage,
                        journal: &connection_journal,
                        generation: &generation,
                    },
                )
                .await?
            };
            connection_journal
                .flush()
                .await
                .map_err(journal_protocol_error)?;
            let provider_session_id = session_id.to_string();
            let persisted = generation
                .persist_if_current(|| {
                    store.set_provider_session(&conversation_id, &provider_session_id)
                })
                .map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
            if !persisted {
                return Err(agent_client_protocol::Error::internal_error()
                    .data("stale session actor generation"));
            }
            apply_native_permission_profile(
                &connection,
                &session_id,
                config.agent_id,
                config.permission_profile,
            )
            .await?;
            *connection_stage
                .lock()
                .expect("startup stage capture poisoned") = None;
            // Queued prompts drain whenever the channel is otherwise idle —
            // at boot (restart-resumed queues) and at every turn boundary —
            // but never ahead of commands already accepted into the channel,
            // which keep their FIFO seniority (#95).
            let mut pending_drain: Option<AgentCommand> = None;
            loop {
                let command = match pending_drain.take() {
                    Some(command) => SessionCommand::Prompt(command),
                    None => {
                        if receiver.is_empty() {
                            pending_drain =
                                runtime.claim_next_queued_prompt(&conversation_id);
                        }
                        match pending_drain.take() {
                            Some(command) => SessionCommand::Prompt(command),
                            None => {
                                match tokio::time::timeout(
                                    runtime.session_actor_policy.idle_timeout,
                                    receiver.recv(),
                                )
                                .await
                                {
                                    Ok(Some(command)) => command,
                                    Ok(None) | Err(_) => break,
                                }
                            }
                        }
                    }
                };
                last_activity.store(runtime.next_session_activity(), Ordering::Release);
                let command = match command {
                    SessionCommand::Shutdown { response } => {
                        let _ = response.send(());
                        break;
                    }
                    command => command,
                };
                let Some(command) = process_session_control(
                    &connection,
                    &session_id,
                    command,
                    &runtime.store,
                    &conversation_id,
                    &connection_journal,
                )
                .await
                else {
                    continue;
                };
                actor_active.store(true, Ordering::Release);
                *active_run_id.lock().expect("active run mutex poisoned") =
                    Some(command.run.id.clone());
                runtime
                    .capture_before_checkpoint(&command.run.id, &cwd)
                    .await;
                let prompt_request = prompt_request_for_command(&session_id, &command);
                let mut cancelled = command.cancelled;
                let prompt = connection.send_request(prompt_request).block_task();
                tokio::pin!(prompt);
                let mut controls_open = true;
                let mut shutdown_response = None;
                let outcome = loop {
                    tokio::select! {
                        response = &mut prompt => {
                            let response = response?;
                            break AcpRunOutcome::Completed {
                                stop_reason: response.stop_reason,
                            };
                        }
                        _ = &mut cancelled => {
                            connection.send_notification(CancelNotification::new(session_id.clone()))?;
                            break AcpRunOutcome::Cancelled;
                        }
                        next = receiver.recv(), if controls_open => {
                            if let Some(next) = next {
                                let next = match next {
                                    SessionCommand::Shutdown { response } => {
                                        connection.send_notification(CancelNotification::new(session_id.clone()))?;
                                        shutdown_response = Some(response);
                                        break AcpRunOutcome::Cancelled;
                                    }
                                    SessionCommand::SideQuestion { id, question, response } => {
                                        connection_journal
                                            .flush()
                                            .await
                                            .map_err(journal_protocol_error)?;
                                        start_side_question(
                                            &runtime,
                                            &connection,
                                            &session_id,
                                            &command.run,
                                            id,
                                            question,
                                            response,
                                        );
                                        continue;
                                    }
                                    next => next,
                                };
                                if let Some(queued_prompt) = process_session_control(
                                    &connection,
                                    &session_id,
                                    next,
                                    &runtime.store,
                                    &conversation_id,
                                    &connection_journal,
                                ).await {
                                    runtime.fail_run(
                                        &queued_prompt.run.id,
                                        "another prompt is already running in this session".into(),
                                    );
                                    runtime.remove_cancellation(&queued_prompt.run.id);
                                }
                            } else {
                                controls_open = false;
                            }
                        }
                    }
                };
                connection_journal
                    .flush()
                    .await
                    .map_err(journal_protocol_error)?;
                runtime.remove_cancellation(&command.run.id);
                let (status, cause) = match outcome {
                    AcpRunOutcome::Completed { stop_reason } => terminal_outcome(stop_reason),
                    AcpRunOutcome::Cancelled => (RunStatus::Cancelled, TerminalCause::Cancelled),
                };
                let transitioned = runtime
                    .store
                    .finish_run(&command.run.id, status, None, cause)
                    .map_err(|error| {
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    })?;
                runtime.capture_after_checkpoint(&command.run.id);
                if transitioned {
                    let _ = runtime.store.append_session_event(
                        &conversation_id,
                        "run_completed",
                        &json!({"run_id":command.run.id, "status":status, "cause":cause}),
                    );
                }
                match runtime.claim_next_queued_prompt(&conversation_id) {
                    Some(next) => {
                        // The queue continues straight into the next turn: the
                        // actor stays active and the drained command seeds the
                        // next loop iteration (#95).
                        *active_run_id.lock().expect("active run mutex poisoned") =
                            Some(next.run.id.clone());
                        last_activity.store(runtime.next_session_activity(), Ordering::Release);
                        pending_drain = Some(next);
                    }
                    None => {
                        *active_run_id.lock().expect("active run mutex poisoned") = None;
                        actor_active.store(false, Ordering::Release);
                        last_activity.store(runtime.next_session_activity(), Ordering::Release);
                        runtime.enforce_warm_actor_limit(Some(&conversation_id));
                    }
                }
                runtime.wake_team_member_for_conversation(&conversation_id);
                if let Some(response) = shutdown_response {
                    let _ = response.send(());
                    break;
                }
            }
            Ok(())
        })
        .await;

    let shutdown = update_journal.shutdown().await;
    finish_journal(result, shutdown).map_err(|error| {
        let message = error.to_string();
        match *startup_stage
            .lock()
            .expect("startup stage capture poisoned")
        {
            Some(stage) => RuntimeError::AcpStartup { stage, message },
            None => RuntimeError::Acp(message),
        }
    })
}

type SessionResponseCapture = Arc<Mutex<HashMap<String, NewSessionResponse>>>;
type StartupStageCapture = Arc<Mutex<Option<AgentStartupStage>>>;

struct ProviderSessionCreation<'a> {
    runtime: &'a AgentRuntime,
    team_mcp_http: Option<McpServer>,
    conversation_id: &'a str,
    captured_responses: &'a SessionResponseCapture,
    startup_stage: &'a StartupStageCapture,
    journal: &'a SessionUpdateSink,
    generation: &'a SessionActorGeneration,
}

async fn create_provider_session(
    connection: &ConnectionTo<Agent>,
    cwd: PathBuf,
    context: ProviderSessionCreation<'_>,
) -> Result<
    (
        agent_client_protocol::schema::v1::SessionId,
        Option<ActiveSession<'static, Agent>>,
    ),
    agent_client_protocol::Error,
> {
    let ProviderSessionCreation {
        runtime,
        team_mcp_http,
        conversation_id,
        captured_responses,
        startup_stage,
        journal,
        generation,
    } = context;
    set_startup_stage(startup_stage, AgentStartupStage::SessionNew);
    if let Some(mcp_server) = team_mcp_http {
        let response = connection
            .send_request(NewSessionRequest::new(cwd).mcp_servers(vec![mcp_server]))
            .block_task()
            .await?;
        let session_id = response.session_id.clone();
        let _ = take_captured_session_response(captured_responses, &session_id);
        journal.flush().await.map_err(journal_protocol_error)?;
        persist_serialized_session_state_checkpoint(
            &runtime.store,
            conversation_id,
            "session_created_state",
            response,
            Some(generation),
        )?;
        return Ok((session_id, None));
    }
    if let Some(mcp_server) = crate::team_mcp::build_team_mcp(runtime.clone(), conversation_id)
        .map_err(|error| agent_client_protocol::Error::internal_error().data(error.to_string()))?
    {
        let active_session = connection
            .build_session(&cwd)
            .with_mcp_server(mcp_server)?
            .block_task()
            .start_session()
            .await?;
        let session_id = active_session.session_id().clone();
        let response = take_captured_session_response(captured_responses, &session_id)
            .unwrap_or_else(|| active_session.response());
        journal.flush().await.map_err(journal_protocol_error)?;
        persist_serialized_session_state_checkpoint(
            &runtime.store,
            conversation_id,
            "session_created_state",
            response,
            Some(generation),
        )?;
        return Ok((session_id, Some(active_session)));
    }
    let response = connection
        .send_request(NewSessionRequest::new(cwd))
        .block_task()
        .await?;
    let session_id = response.session_id.clone();
    let _ = take_captured_session_response(captured_responses, &session_id);
    journal.flush().await.map_err(journal_protocol_error)?;
    persist_serialized_session_state_checkpoint(
        &runtime.store,
        conversation_id,
        "session_created_state",
        response,
        Some(generation),
    )?;
    Ok((session_id, None))
}

fn set_startup_stage(capture: &StartupStageCapture, stage: AgentStartupStage) {
    *capture.lock().expect("startup stage capture poisoned") = Some(stage);
}

fn capture_new_session_response(
    captured_responses: &SessionResponseCapture,
    line: &str,
    direction: LineDirection,
) {
    if direction != LineDirection::Stdout {
        return;
    }
    let Some(result) = serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|message| message.get("result").cloned())
    else {
        return;
    };
    let Ok(response) = serde_json::from_value::<NewSessionResponse>(result) else {
        return;
    };
    captured_responses
        .lock()
        .expect("session response capture mutex poisoned")
        .insert(response.session_id.to_string(), response);
}

fn take_captured_session_response(
    captured_responses: &SessionResponseCapture,
    session_id: &agent_client_protocol::schema::v1::SessionId,
) -> Option<NewSessionResponse> {
    captured_responses
        .lock()
        .expect("session response capture mutex poisoned")
        .remove(&session_id.to_string())
}

impl AgentRuntime {
    pub(super) fn dispatch(&self, config: AgentSessionConfig, command: SessionCommand) {
        let starts_run = matches!(&command, SessionCommand::Prompt(_));
        let activity = self.next_session_activity();
        let existing = self
            .sessions
            .lock()
            .expect("agent session mutex poisoned")
            .get(&config.conversation_id)
            .cloned();
        let command = if let Some(handle) = existing {
            handle.last_activity.store(activity, Ordering::Release);
            if starts_run {
                handle.active.store(true, Ordering::Release);
            }
            match handle.sender.send(command) {
                Ok(()) => return,
                Err(error) => error.0,
            }
        } else {
            command
        };

        let (sender, receiver) = mpsc::unbounded_channel();
        sender
            .send(command)
            .expect("new session actor receiver must be open");
        let generation = Uuid::new_v4().to_string();
        let generation_guard = {
            let mut generations = self
                .session_generations
                .lock()
                .expect("session generation registry mutex poisoned");
            let current = Arc::clone(
                generations
                    .entry(config.conversation_id.clone())
                    .or_insert_with(|| Arc::new(RwLock::new(String::new()))),
            );
            *current.write().expect("session generation lock poisoned") = generation.clone();
            SessionActorGeneration {
                expected: generation.clone(),
                current,
            }
        };
        let active = Arc::new(AtomicBool::new(starts_run));
        let last_activity = Arc::new(AtomicU64::new(activity));
        self.sessions
            .lock()
            .expect("agent session mutex poisoned")
            .insert(
                config.conversation_id.clone(),
                SessionActorHandle {
                    generation: generation.clone(),
                    sender,
                    active: Arc::clone(&active),
                    last_activity: Arc::clone(&last_activity),
                },
            );
        self.enforce_warm_actor_limit(Some(&config.conversation_id));
        let runtime = self.clone();
        tokio::spawn(async move {
            let conversation_id = config.conversation_id.clone();
            runtime
                .run_session_actor(config, receiver, active, last_activity, generation_guard)
                .await;
            let mut sessions = runtime
                .sessions
                .lock()
                .expect("agent session mutex poisoned");
            if sessions
                .get(&conversation_id)
                .is_some_and(|handle| handle.generation == generation)
            {
                sessions.remove(&conversation_id);
            }
            drop(sessions);
            let mut generations = runtime
                .session_generations
                .lock()
                .expect("session generation registry mutex poisoned");
            if generations.get(&conversation_id).is_some_and(|current| {
                *current.read().expect("session generation lock poisoned") == generation
            }) {
                generations.remove(&conversation_id);
            }
        });
    }

    fn next_session_activity(&self) -> u64 {
        self.session_activity_sequence
            .fetch_add(1, Ordering::AcqRel)
            + 1
    }

    async fn run_session_actor(
        &self,
        config: AgentSessionConfig,
        mut receiver: mpsc::UnboundedReceiver<SessionCommand>,
        active: Arc<AtomicBool>,
        last_activity: Arc<AtomicU64>,
        generation: SessionActorGeneration,
    ) {
        let active_run_id = Arc::new(Mutex::new(None));
        let result = run_acp_session(
            self.clone(),
            config,
            &mut receiver,
            Arc::clone(&active_run_id),
            Arc::clone(&active),
            Arc::clone(&last_activity),
            generation,
        )
        .await;
        active.store(false, Ordering::Release);
        if let Err(error) = result {
            let failure = error.failure();
            if let Some(run_id) = active_run_id
                .lock()
                .expect("active run mutex poisoned")
                .take()
            {
                self.fail_run(&run_id, error.to_string());
            }
            while let Ok(command) = receiver.try_recv() {
                match command {
                    SessionCommand::Prompt(command) => {
                        self.fail_run(&command.run.id, error.to_string());
                        self.remove_cancellation(&command.run.id);
                    }
                    SessionCommand::SetMode { response, .. }
                    | SessionCommand::SetConfig { response, .. } => {
                        let _ = response.send(Err(error.to_string()));
                    }
                    SessionCommand::SideQuestion { response, .. } => {
                        let _ = response.send(Err(RuntimeError::Acp(error.to_string())));
                    }
                    SessionCommand::Ready { response } => {
                        let _ = response.send(Err(failure.clone()));
                    }
                    SessionCommand::Shutdown { response } => {
                        let _ = response.send(());
                    }
                }
            }
        }
    }

    fn fail_run(&self, run_id: &str, message: String) {
        let run = self.store.get_run(run_id).ok();
        let _ =
            self.store
                .append_event(run_id, AgentEventKind::Error, &json!({"message": message}));
        let transitioned = self
            .store
            .finish_run(
                run_id,
                RunStatus::Failed,
                Some(&message),
                TerminalCause::Error,
            )
            .unwrap_or(false);
        self.capture_after_checkpoint(run_id);
        if transitioned && let Some(run) = run {
            let _ = self.store.append_session_event(
                &run.conversation_id,
                "run_completed",
                &json!({
                    "run_id":run_id,
                    "status":"failed",
                    "error":message,
                    "cause":"error",
                }),
            );
        }
    }

    /// Captures the before-turn checkpoint once the run has been admitted and
    /// dispatched to this actor. The git subprocess runs on the blocking pool
    /// so run admission (and its HTTP handler) never waits for it, while
    /// awaiting here keeps the snapshot strictly ahead of the turn's first
    /// tool effect.
    async fn capture_before_checkpoint(&self, run_id: &str, cwd: &Path) {
        let workspace = Arc::clone(&self.workspace);
        let store = Arc::clone(&self.store);
        let checkpoint_id = format!("{run_id}-before");
        let run_id = run_id.to_owned();
        let cwd = cwd.to_path_buf();
        let captured = tokio::task::spawn_blocking(move || {
            workspace
                .capture_git_tree(&cwd, &checkpoint_id)
                .ok()
                .flatten()
        })
        .await;
        if let Ok(Some(tree)) = captured {
            let _ = store.set_run_checkpoint(&run_id, Some(&tree), None);
        }
    }

    fn capture_after_checkpoint(&self, run_id: &str) {
        let Ok(run) = self.store.get_run(run_id) else {
            return;
        };
        let Ok(conversation) = self.store.get_conversation(&run.conversation_id) else {
            return;
        };
        let Ok(cwd) = self.workspace.execution_path(
            &conversation.project_id,
            conversation.workspace_path.as_deref(),
        ) else {
            return;
        };
        if let Ok(Some(tree)) = self
            .workspace
            .capture_git_tree(&cwd, &format!("{run_id}-after"))
        {
            let _ = self.store.set_run_checkpoint(run_id, None, Some(&tree));
        }
    }

    fn remove_cancellation(&self, run_id: &str) {
        self.cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .remove(run_id);
    }

    pub async fn set_session_mode(
        &self,
        conversation_id: &str,
        mode_id: String,
    ) -> Result<(), RuntimeError> {
        self.dispatch_session_control(conversation_id, |response| SessionCommand::SetMode {
            mode_id,
            response,
        })
        .await
    }

    pub async fn set_session_config(
        &self,
        conversation_id: &str,
        config_id: String,
        value: SessionConfigInput,
    ) -> Result<(), RuntimeError> {
        self.dispatch_session_control(conversation_id, |response| SessionCommand::SetConfig {
            config_id,
            value,
            response,
        })
        .await
    }

    async fn dispatch_session_control(
        &self,
        conversation_id: &str,
        command: impl FnOnce(oneshot::Sender<Result<(), String>>) -> SessionCommand,
    ) -> Result<(), RuntimeError> {
        let config = self.session_config(conversation_id)?;
        let (response, result) = oneshot::channel();
        self.dispatch(config, command(response));
        result
            .await
            .map_err(|_| RuntimeError::Acp("session connection closed".into()))?
            .map_err(RuntimeError::Acp)
    }

    pub(super) fn session_config(
        &self,
        conversation_id: &str,
    ) -> Result<AgentSessionConfig, RuntimeError> {
        let conversation = self.store.get_conversation(conversation_id)?;
        let descriptor = self.available_descriptor(conversation.agent_id)?;
        let cwd = self.workspace.execution_path(
            &conversation.project_id,
            conversation.workspace_path.as_deref(),
        )?;
        Ok(AgentSessionConfig {
            conversation_id: conversation.id,
            agent_id: conversation.agent_id,
            descriptor,
            provider_session_id: conversation.provider_session_id,
            cwd,
            permission_profile: self.permission_profile(conversation_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::agent_runtime::run_git;
    use crate::agents::{AgentId, PermissionMode};
    use crate::composer_catalog::ComposerInvocation;
    use crate::workspace::WorkspaceService;

    #[test]
    fn codex_skill_prompt_uses_private_structured_meta_without_text_injection() {
        let (_cancel, cancelled) = oneshot::channel();
        let command = AgentCommand {
            run: AgentRun {
                id: "run".into(),
                conversation_id: "conversation".into(),
                project_id: "project".into(),
                message: "$review focus on tests".into(),
                status: RunStatus::Running,
                permission_mode: PermissionMode::Safe,
                error: None,
                internal: true,
                client_message_id: None,
                terminal_cause: None,
            },
            message: "focus on tests".into(),
            provider_input: Some(Box::new(ComposerInvocation::ProviderStructuredInput {
                adapter_kind: "codex".into(),
                payload: json!({
                    "type":"skill",
                    "name":"review",
                    "path":"/srv/project/.agents/skills/review/SKILL.md"
                }),
            })),
            cancelled,
        };

        let request = serde_json::to_value(prompt_request_for_command(
            &SessionId::from("provider-session"),
            &command,
        ))
        .expect("prompt request JSON");
        assert_eq!(request["prompt"][0]["text"], "focus on tests");
        assert_eq!(
            request["_meta"]["kubecode"]["providerStructuredInput"],
            json!({
                "adapterKind":"codex",
                "payload":{
                    "type":"skill",
                    "name":"review",
                    "path":"/srv/project/.agents/skills/review/SKILL.md"
                }
            })
        );
        assert!(!request["prompt"].to_string().contains("$review"));
    }

    #[test]
    fn failed_runs_capture_an_after_turn_checkpoint() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let project_path = temp.path().join("project");
        std::fs::create_dir_all(&project_path).expect("project directory");
        run_git(&project_path, &["init"]);
        run_git(
            &project_path,
            &["config", "user.email", "kubecode@example.test"],
        );
        run_git(&project_path, &["config", "user.name", "Kubecode Test"]);
        std::fs::write(project_path.join("README.md"), "before\n").expect("initial file");
        run_git(&project_path, &["add", "README.md"]);
        run_git(&project_path, &["commit", "-m", "initial"]);

        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project = workspace
            .import_project_at(&project_path)
            .expect("project registration");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Change the file",
                PermissionMode::Safe,
            )
            .expect("run");
        let before = workspace
            .capture_git_tree(&project_path, "before-failure")
            .expect("before checkpoint")
            .expect("git tree");
        store
            .set_run_checkpoint(&run.id, Some(&before), None)
            .expect("store before checkpoint");
        std::fs::write(project_path.join("README.md"), "after\n").expect("changed file");

        let runtime = AgentRuntime::new(workspace, Arc::clone(&store), Vec::new());
        runtime.fail_run(&run.id, "OpenCode disconnected".into());

        let checkpoint = store
            .run_checkpoint(&run.id)
            .expect("checkpoint query")
            .expect("checkpoint");
        assert!(checkpoint.after_tree.is_some());
    }
}
