use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::error::{AcpCommandError, ApiError};
use super::runtime::{safe_agent_event, safe_session_event};
use crate::agent_runtime::{StartAgentRun, StartComposerCommand, StartStructuredComposerRun};
use crate::agents::{AgentEvent, AgentRun, AgentStore, SessionEvent, StoreError};
use crate::composer_catalog::ComposerDraftSegment;

const MAX_ACP_COMMAND_NAME_BYTES: usize = 256;
const MAX_ACP_COMMAND_ARGUMENT_BYTES: usize = 8 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyStartRunRequest {
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredStartRunRequest {
    #[serde(default)]
    item_id: Option<String>,
    catalog_revision: u64,
    segments: Vec<ComposerDraftSegment>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StartRunRequest {
    Legacy(LegacyStartRunRequest),
    Structured(StructuredStartRunRequest),
}

pub(super) async fn start_agent_run(
    State(state): State<AppState>,
    Path((project_id, conversation_id)): Path<(String, String)>,
    Json(request): Json<serde_json::Value>,
) -> Result<impl IntoResponse, ApiError> {
    let conversation = state
        .agent_runtime
        .store()
        .get_conversation(&conversation_id)?;
    if conversation.project_id != project_id {
        return Err(StoreError::ConversationNotFound(conversation_id).into());
    }
    let request = serde_json::from_value::<StartRunRequest>(request)
        .map_err(|_| ApiError::InvalidRequest("invalid run request".into()))?;
    let run = match request {
        StartRunRequest::Legacy(request) => {
            if request.message.trim().is_empty() {
                return Err(ApiError::InvalidRequest("message must not be empty".into()));
            }
            state.agent_runtime.start(StartAgentRun {
                conversation_id,
                project_id,
                message: request.message,
            })?
        }
        StartRunRequest::Structured(request) => {
            state
                .agent_runtime
                .start_structured_composer(StartStructuredComposerRun {
                    conversation_id,
                    project_id,
                    item_id: request.item_id,
                    catalog_revision: request.catalog_revision,
                    segments: request.segments,
                })?
        }
    };
    Ok((StatusCode::ACCEPTED, Json(run)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyAcpCommandSelector {
    name: String,
    #[serde(default)]
    arguments: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TypedComposerCommandSelector {
    item_id: String,
    catalog_revision: u64,
    #[serde(default)]
    arguments: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum DispatchAcpCommandSelector {
    Legacy(LegacyAcpCommandSelector),
    Typed(TypedComposerCommandSelector),
}

pub(super) async fn dispatch_acp_command(
    State(state): State<AppState>,
    Path((project_id, conversation_id)): Path<(String, String)>,
    Json(request): Json<serde_json::Value>,
) -> Result<impl IntoResponse, ApiError> {
    let conversation = state
        .agent_runtime
        .store()
        .get_conversation(&conversation_id)?;
    if conversation.project_id != project_id {
        return Err(StoreError::ConversationNotFound(conversation_id).into());
    }
    let selector = serde_json::from_value::<DispatchAcpCommandSelector>(request)
        .map_err(|_| ApiError::InvalidRequest("invalid command selector".into()))?;
    let run = match selector {
        DispatchAcpCommandSelector::Legacy(request) => {
            if !valid_acp_command_name(&request.name) {
                return Err(AcpCommandError::Unavailable.into());
            }
            if request.arguments.len() > MAX_ACP_COMMAND_ARGUMENT_BYTES {
                return Err(AcpCommandError::ArgumentsTooLong.into());
            }
            let arguments = request.arguments.trim();
            let raw =
                latest_available_commands(state.agent_runtime.store().as_ref(), &conversation_id)?
                    .ok_or(AcpCommandError::Unavailable)?;
            let message = resolve_acp_command_message(&raw, &request.name, arguments)?;
            state.agent_runtime.start_acp_command(StartAgentRun {
                conversation_id,
                project_id,
                message,
            })?
        }
        DispatchAcpCommandSelector::Typed(request) => {
            state
                .agent_runtime
                .start_composer_command(StartComposerCommand {
                    conversation_id,
                    project_id,
                    item_id: request.item_id,
                    catalog_revision: request.catalog_revision,
                    arguments: request.arguments,
                })?
        }
    };
    Ok((StatusCode::ACCEPTED, Json(run)))
}

pub(super) async fn get_agent_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.agent_runtime.store().get_run(&run_id)?))
}

pub(super) async fn list_conversation_runs(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state.agent_runtime.store().list_runs(&conversation_id)?,
    ))
}

#[derive(Debug, Deserialize)]
pub(super) struct HistoryPageQuery {
    before: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct ConversationHistoryPage {
    runs: Vec<AgentRun>,
    events: BTreeMap<String, Vec<AgentEvent>>,
    session_events: Vec<SessionEvent>,
    next_cursor: Option<String>,
}

pub(super) async fn list_conversation_history(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(query): Query<HistoryPageQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let store = state.agent_runtime.store();
    let (runs, has_more) =
        store.list_runs_page(&conversation_id, query.before.as_deref(), limit)?;
    let mut events = BTreeMap::new();
    for run in &runs {
        events.insert(
            run.id.clone(),
            store
                .events_after(&run.id, 0)?
                .into_iter()
                .map(safe_agent_event)
                .collect(),
        );
    }
    let all_session_events = store.session_events_after(&conversation_id, 0)?;
    let session_events = runs.first().map_or_else(Vec::new, |first| {
        let start = all_session_events
            .iter()
            .position(|event| {
                event
                    .payload
                    .get("run_id")
                    .and_then(serde_json::Value::as_str)
                    == Some(first.id.as_str())
            })
            .unwrap_or(all_session_events.len());
        let end = query
            .before
            .as_deref()
            .and_then(|before| {
                all_session_events.iter().position(|event| {
                    event
                        .payload
                        .get("run_id")
                        .and_then(serde_json::Value::as_str)
                        == Some(before)
                })
            })
            .unwrap_or(all_session_events.len());
        all_session_events[start..end.max(start)]
            .iter()
            .cloned()
            .map(safe_session_event)
            .collect()
    });
    let next_cursor = has_more
        .then(|| runs.first().map(|run| run.id.clone()))
        .flatten();
    Ok(Json(ConversationHistoryPage {
        runs,
        events,
        session_events,
        next_cursor,
    }))
}

pub(super) async fn list_project_runs(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    state.workspace.project_path(&project_id)?;
    Ok(Json(
        state.agent_runtime.store().list_project_runs(&project_id)?,
    ))
}

pub(super) async fn cancel_agent_run(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.agent_runtime.store().get_run(&run_id)?;
    if !state.agent_runtime.cancel(&run_id) {
        return Err(ApiError::RunNotActive(run_id));
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
pub(super) struct ResolvePermissionRequest {
    option_id: String,
}

pub(super) async fn resolve_permission(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    Json(request): Json<ResolvePermissionRequest>,
) -> Result<StatusCode, ApiError> {
    if request.option_id.trim().is_empty() {
        return Err(ApiError::InvalidRequest(
            "option_id must not be empty".into(),
        ));
    }
    let team_permission = if let Some(teams) = state.agent_runtime.team_store() {
        teams
            .resolve_permission_as_user(&request_id, &request.option_id)
            .map_err(|error| ApiError::InvalidRequest(error.to_string()))?
    } else {
        None
    };
    if !state
        .agent_runtime
        .resolve_permission(&request_id, &request.option_id)
    {
        return Err(ApiError::PermissionNotFound(request_id));
    }
    if let Some(permission) = team_permission
        && let Some(teams) = state.agent_runtime.team_store()
    {
        let _ = teams.append_activity(
            &permission.team_id,
            Some(&permission.member_id),
            None,
            "permission_user_resolved",
            "User resolved a teammate permission",
            None,
        );
        if let Ok(team) = teams.get_team(&permission.team_id) {
            let _ = state.agent_runtime.store().append_workspace_event(
                "team_permission_updated",
                Some(&team.project_id),
                Some(&permission.conversation_id),
                Some(&permission.run_id),
                &serde_json::json!({
                    "team_id": permission.team_id,
                    "request_id": permission.id,
                }),
            );
        }
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
pub(super) struct ResolveElicitationRequest {
    content: Option<BTreeMap<String, agent_client_protocol::schema::v1::ElicitationContentValue>>,
}

pub(super) async fn resolve_elicitation(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    Json(request): Json<ResolveElicitationRequest>,
) -> Result<StatusCode, ApiError> {
    if !state
        .agent_runtime
        .resolve_elicitation(&request_id, request.content)
    {
        return Err(ApiError::ElicitationNotFound(request_id));
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum AcpCommandInput {
    None,
    Text { hint: Option<String> },
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AcpCommand {
    name: String,
    description: String,
    input: AcpCommandInput,
}

fn latest_available_commands(
    store: &AgentStore,
    conversation_id: &str,
) -> Result<Option<serde_json::Value>, StoreError> {
    Ok(store
        .session_events_after(conversation_id, 0)?
        .into_iter()
        .filter(|event| event.kind == "available_commands")
        .map(|event| event.payload)
        .next_back())
}

fn parse_available_commands(payload: &serde_json::Value) -> Vec<AcpCommand> {
    payload
        .get("availableCommands")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let command = value.as_object()?;
            let name = command.get("name")?.as_str()?;
            let description = command.get("description")?.as_str()?;
            let input = match command.get("input") {
                None | Some(serde_json::Value::Null) => AcpCommandInput::None,
                Some(serde_json::Value::Object(input)) => {
                    let kind = input.get("type").and_then(serde_json::Value::as_str);
                    let hint = input.get("hint");
                    match (kind, hint) {
                        (None | Some("text"), None) => AcpCommandInput::Text { hint: None },
                        (None | Some("text"), Some(serde_json::Value::String(hint))) => {
                            AcpCommandInput::Text {
                                hint: Some(hint.to_owned()),
                            }
                        }
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

fn valid_acp_command_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ACP_COMMAND_NAME_BYTES
        && name.chars().all(|character| {
            !character.is_control() && !character.is_whitespace() && character != '/'
        })
}

fn resolve_acp_command_message(
    payload: &serde_json::Value,
    name: &str,
    arguments: &str,
) -> Result<String, AcpCommandError> {
    let matches = parse_available_commands(payload)
        .into_iter()
        .filter(|command| command.name == name)
        .collect::<Vec<_>>();
    let command = match matches.as_slice() {
        [] => return Err(AcpCommandError::Unavailable),
        [command] => command,
        _ => return Err(AcpCommandError::Ambiguous),
    };
    match command.input {
        AcpCommandInput::None if !arguments.is_empty() => {
            return Err(AcpCommandError::UnexpectedInput);
        }
        AcpCommandInput::Text { .. } if arguments.is_empty() => {
            return Err(AcpCommandError::InputRequired);
        }
        AcpCommandInput::Unsupported => return Err(AcpCommandError::UnsupportedInput),
        AcpCommandInput::None | AcpCommandInput::Text { .. } => {}
    }
    Ok(if arguments.is_empty() {
        format!("/{name}")
    } else {
        format!("/{name} {arguments}")
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AcpCommandError, resolve_acp_command_message};

    #[test]
    fn resolves_only_one_current_command_with_the_declared_input_shape() {
        let commands = json!({"availableCommands":[
            {"name":"status", "description":"Show status"},
            {"name":"review", "description":"Review", "input":{"hint":"focus"}},
            {"name":"ask", "description":"Ask", "input":{"type":"text"}},
            {"name":"future", "description":"Future", "input":{"type":"choices"}},
            {"name":"duplicate", "description":"One"},
            {"name":"duplicate", "description":"Two"}
        ]});
        assert_eq!(
            resolve_acp_command_message(&commands, "status", ""),
            Ok("/status".into())
        );
        assert_eq!(
            resolve_acp_command_message(&commands, "review", "security"),
            Ok("/review security".into())
        );
        assert_eq!(
            resolve_acp_command_message(&commands, "ask", "anything"),
            Ok("/ask anything".into())
        );
        assert!(matches!(
            resolve_acp_command_message(&commands, "removed", ""),
            Err(AcpCommandError::Unavailable)
        ));
        assert!(matches!(
            resolve_acp_command_message(&commands, "duplicate", ""),
            Err(AcpCommandError::Ambiguous)
        ));
        assert!(matches!(
            resolve_acp_command_message(&commands, "future", ""),
            Err(AcpCommandError::UnsupportedInput)
        ));
        assert!(matches!(
            resolve_acp_command_message(&commands, "review", ""),
            Err(AcpCommandError::InputRequired)
        ));
        assert!(matches!(
            resolve_acp_command_message(&commands, "status", "extra"),
            Err(AcpCommandError::UnexpectedInput)
        ));
    }
}
