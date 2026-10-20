//! Direct messages with a member, and sharing from one into General (ADR 0223).
//!
//! A direct message (DM) is the researcher's private conversation with one
//! member, held in that member's DM Session. It is not part of the shared
//! record: no search, mention, reference, tool, or other member reaches it.
//! The researcher moves something out of it only by previewing exactly what
//! will be posted and then confirming that same text. Only the browser uses
//! these routes; an agent has no tool that reads or publishes a DM.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::app_state::AppState;
use crate::channel_store::{AuthorKind, ChannelError, ContextRef, MessageView, NewMessage};
use crate::member_store::{Member, MemberError, MemberState};
use crate::orchestrator::{DeliveryOutcome, DeliveryRequest, RouteSink, RuntimeSink};
use crate::project_context::ContextKind;
use crate::workspace::WorkspaceError;

/// Turns offered for sharing, newest last.
const TURN_PAGE: usize = 20;
/// Turns one share may carry.
const MAX_SHARED_TURNS: usize = 6;
/// Longest text of one side of a turn that is shown or shared.
const TURN_CHARS: usize = 3_000;
const NOTE_CHARS: usize = 2_000;
/// What General accepts in one message.
const MAX_SHARE_CHARS: usize = 16_000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/members/{member_id}/dm",
            post(open_dm),
        )
        .route(
            "/projects/{project_id}/members/{member_id}/dm/turns",
            get(list_turns),
        )
        .route(
            "/projects/{project_id}/members/{member_id}/dm/messages",
            post(send_message),
        )
        .route(
            "/projects/{project_id}/members/{member_id}/dm/share/preview",
            post(preview_share),
        )
        .route(
            "/projects/{project_id}/members/{member_id}/dm/share",
            post(share),
        )
}

enum DmError {
    Member(MemberError),
    Workspace(WorkspaceError),
    Channel(ChannelError),
    Invalid(&'static str),
    /// The preview the researcher confirmed is not what would be posted now.
    Stale,
    /// The member's Session cannot take the message right now.
    Busy,
    /// The provider or runtime refused the message.
    Refused,
    Storage,
}

impl From<MemberError> for DmError {
    fn from(error: MemberError) -> Self {
        Self::Member(error)
    }
}

impl From<WorkspaceError> for DmError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

impl From<ChannelError> for DmError {
    fn from(error: ChannelError) -> Self {
        Self::Channel(error)
    }
}

impl IntoResponse for DmError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::Workspace(WorkspaceError::ProjectNotFound(id)) => (
                StatusCode::NOT_FOUND,
                "not_found",
                format!("project not found: {id}"),
            ),
            Self::Member(MemberError::NotFound) => (
                StatusCode::NOT_FOUND,
                "member_not_found",
                "member not found".to_owned(),
            ),
            Self::Member(MemberError::Removed) => (
                StatusCode::CONFLICT,
                "member_removed",
                "the member was removed".to_owned(),
            ),
            Self::Member(MemberError::Invalid(message)) => {
                (StatusCode::BAD_REQUEST, "invalid_dm", message.to_owned())
            }
            Self::Channel(ChannelError::Invalid(message)) | Self::Invalid(message) => {
                (StatusCode::BAD_REQUEST, "invalid_dm", message.to_owned())
            }
            Self::Channel(ChannelError::KeyReuse) => (
                StatusCode::CONFLICT,
                "dm_key_reused",
                "that client message id was used for different text".to_owned(),
            ),
            Self::Stale => (
                StatusCode::CONFLICT,
                "dm_share_stale",
                "the conversation changed since the preview; preview it again".to_owned(),
            ),
            Self::Busy => (
                StatusCode::CONFLICT,
                "dm_busy",
                "the member is busy; try again in a moment".to_owned(),
            ),
            Self::Refused => (
                StatusCode::BAD_GATEWAY,
                "dm_failed",
                "the message could not be delivered to the member".to_owned(),
            ),
            Self::Workspace(_) | Self::Member(_) | Self::Channel(_) | Self::Storage => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "the direct message could not be handled".to_owned(),
            ),
        };
        (status, Json(json!({ "code": code, "message": message }))).into_response()
    }
}

fn check_project(state: &AppState, project_id: &str) -> Result<(), DmError> {
    state.workspace.project_path(project_id)?;
    Ok(())
}

/// The member and its DM Session, which must already exist.
fn member_with_dm(
    state: &AppState,
    project_id: &str,
    member_id: &str,
) -> Result<(Member, String), DmError> {
    let member = state.members.get(project_id, member_id)?;
    if member.state == MemberState::Removed {
        return Err(MemberError::Removed.into());
    }
    let dm = member
        .dm_conversation_id
        .clone()
        .ok_or(DmError::Invalid("open the direct message first"))?;
    Ok((member, dm))
}

/// Opens the researcher's direct message with a member, creating its private
/// Session the first time. Returns the member, whose `dm_conversation_id` is
/// the Session the browser shows.
async fn open_dm(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
) -> Result<Json<Member>, DmError> {
    check_project(&state, &project_id)?;
    let member = tokio::task::spawn_blocking(move || -> Result<Member, DmError> {
        let runtime = std::sync::Arc::clone(&state.agent_runtime);
        Ok(state
            .members
            .ensure_dm_session(&project_id, &member_id, &move |agent| {
                runtime.agent_available(agent)
            })?)
    })
    .await
    .map_err(|_| DmError::Storage)??;
    Ok(Json(member))
}

#[derive(Debug, Serialize)]
struct DmTurn {
    run_id: String,
    user: String,
    assistant: String,
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The researcher's words without the role brief the first prompt carries.
fn without_brief(text: &str) -> String {
    const END: &str = "[End of role brief]";
    if let Some(start) = text.find("[Role brief]")
        && let Some(end) = text[start..].find(END)
    {
        let after = start + end + END.len();
        return format!(
            "{}{}",
            &text[..start],
            text[after..].trim_start_matches('\n')
        );
    }
    text.to_owned()
}

#[derive(Debug, Deserialize)]
struct SendRequest {
    text: String,
    /// One key per typed message: a retry after a lost reply is the same message.
    client_message_id: String,
}

const MAX_DM_CHARS: usize = 16_000;

/// Sends the researcher's message to the member's DM Session. It goes through
/// the same delivery as every member message, so the Session is configured and
/// briefed first; nothing is posted to the shared conversation.
async fn send_message(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
    Json(request): Json<SendRequest>,
) -> Result<(StatusCode, Json<Value>), DmError> {
    check_project(&state, &project_id)?;
    let text = request.text.trim().to_owned();
    if text.is_empty() {
        return Err(DmError::Invalid("a message is required"));
    }
    if text.chars().count() > MAX_DM_CHARS {
        return Err(DmError::Invalid("the message is too long"));
    }
    let key = request.client_message_id.trim().to_owned();
    if key.is_empty() || key.chars().count() > 128 {
        return Err(DmError::Invalid("a client message id is required"));
    }
    let outcome = tokio::task::spawn_blocking(move || -> Result<DeliveryOutcome, DmError> {
        let (_, dm) = member_with_dm(&state, &project_id, &member_id)?;
        let sink = RuntimeSink::new(std::sync::Arc::clone(&state.agent_runtime))
            .with_members(std::sync::Arc::clone(&state.members));
        Ok(sink.deliver(&DeliveryRequest {
            project_id: &project_id,
            conversation_id: &dm,
            delivery_key: &format!("dm:{key}"),
            body: &text,
        }))
    })
    .await
    .map_err(|_| DmError::Storage)??;
    match outcome {
        DeliveryOutcome::Delivered => {
            Ok((StatusCode::ACCEPTED, Json(json!({"state": "delivered"}))))
        }
        DeliveryOutcome::Busy => Err(DmError::Busy),
        DeliveryOutcome::Failed(_) => Err(DmError::Refused),
    }
}

async fn list_turns(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
) -> Result<Json<Vec<DmTurn>>, DmError> {
    check_project(&state, &project_id)?;
    let turns = tokio::task::spawn_blocking(move || -> Result<Vec<DmTurn>, DmError> {
        let (_, dm) = member_with_dm(&state, &project_id, &member_id)?;
        let (runs, _) = state
            .agent_runtime
            .store_ref()
            .list_runs_page(&dm, None, TURN_PAGE)
            .map_err(|_| DmError::Storage)?;
        let mut turns = Vec::new();
        for run in runs.iter().filter(|run| !run.internal) {
            if let Some(text) = state
                .agent_runtime
                .store_ref()
                .read_turn_text(&dm, &run.id, TURN_CHARS * 4)
                .map_err(|_| DmError::Storage)?
            {
                turns.push(DmTurn {
                    run_id: run.id.clone(),
                    user: clip(&without_brief(&text.user), TURN_CHARS),
                    assistant: clip(&text.assistant, TURN_CHARS),
                });
            }
        }
        Ok(turns)
    })
    .await
    .map_err(|_| DmError::Storage)??;
    Ok(Json(turns))
}

#[derive(Debug, Deserialize)]
struct ShareRequest {
    /// The turns to share, by run id, in the order they happened.
    run_ids: Vec<String>,
    /// The researcher's own words to add.
    note: Option<String>,
    /// A Task (research question) the shared text is about.
    task_id: Option<String>,
    /// What the preview showed; the share is refused if it no longer matches.
    digest: Option<String>,
    client_message_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct SharePreview {
    /// Exactly what will be posted to General.
    text: String,
    digest: String,
    task_id: Option<String>,
}

fn compose(
    state: &AppState,
    project_id: &str,
    member: &Member,
    dm: &str,
    request: &ShareRequest,
) -> Result<SharePreview, DmError> {
    let mut run_ids: Vec<&String> = Vec::new();
    for run_id in &request.run_ids {
        if !run_ids.contains(&run_id) {
            run_ids.push(run_id);
        }
    }
    if let Some(task) = request.task_id.as_deref() {
        // A Task that does not exist is found now, not after the researcher confirmed.
        state
            .research
            .get(project_id, task)
            .map_err(|_| DmError::Invalid("that Task was not found"))?;
    }
    if run_ids.is_empty() {
        return Err(DmError::Invalid("choose at least one turn to share"));
    }
    if run_ids.len() > MAX_SHARED_TURNS {
        return Err(DmError::Invalid("share at most six turns at once"));
    }
    let mut text = format!(
        "Shared from my private conversation with @{} (the excerpt below is what I chose to share):\n",
        member.handle
    );
    for run_id in run_ids {
        let turn = state
            .agent_runtime
            .store_ref()
            .read_turn_text(dm, run_id, TURN_CHARS * 4)
            .map_err(|_| DmError::Storage)?
            .ok_or(DmError::Invalid("that turn is not in this direct message"))?;
        // The member's words are quoted, as everything written by an agent is
        // when it sits in a researcher's message: a quoted line is never read
        // as the researcher's instruction to the project manager.
        let reply = clip(&turn.assistant, TURN_CHARS);
        let quoted = reply
            .trim()
            .lines()
            .map(|line| format!("> {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        text.push_str(&format!(
            "\nMe: {}\n@{} said:\n{}\n",
            clip(&without_brief(&turn.user), TURN_CHARS).trim(),
            member.handle,
            quoted
        ));
    }
    if let Some(note) = request
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        text.push_str(&format!("\n{}", clip(note, NOTE_CHARS)));
    }
    if text.chars().count() > MAX_SHARE_CHARS {
        return Err(DmError::Invalid(
            "that is too long to share at once; choose fewer turns",
        ));
    }
    let digest = hex::encode(Sha256::digest(
        format!(
            "{}\u{0}{}\u{0}{text}",
            member.id,
            request.task_id.as_deref().unwrap_or_default()
        )
        .as_bytes(),
    ))[..32]
        .to_owned();
    Ok(SharePreview {
        text,
        digest,
        task_id: request.task_id.clone(),
    })
}

async fn preview_share(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
    Json(request): Json<ShareRequest>,
) -> Result<Json<SharePreview>, DmError> {
    check_project(&state, &project_id)?;
    let preview = tokio::task::spawn_blocking(move || -> Result<SharePreview, DmError> {
        let (member, dm) = member_with_dm(&state, &project_id, &member_id)?;
        compose(&state, &project_id, &member, &dm, &request)
    })
    .await
    .map_err(|_| DmError::Storage)??;
    Ok(Json(preview))
}

/// Posts the previewed text to General as the researcher's own message. The
/// message is an ordinary General message: it reaches the project manager like
/// any unaddressed remark and authorizes nothing by itself.
async fn share(
    State(state): State<AppState>,
    Path((project_id, member_id)): Path<(String, String)>,
    Json(request): Json<ShareRequest>,
) -> Result<(StatusCode, Json<MessageView>), DmError> {
    check_project(&state, &project_id)?;
    let digest = request
        .digest
        .clone()
        .ok_or(DmError::Invalid("preview the text before sharing it"))?;
    let (message, created) = tokio::task::spawn_blocking(move || -> Result<_, DmError> {
        let (member, dm) = member_with_dm(&state, &project_id, &member_id)?;
        let preview = compose(&state, &project_id, &member, &dm, &request)?;
        if preview.digest != digest {
            return Err(DmError::Stale);
        }
        let channel = state.channels.default_channel(&project_id)?;
        let requested: Vec<ContextRef> = request
            .task_id
            .as_deref()
            .map(|id| vec![ContextRef::new(ContextKind::Research, id)])
            .unwrap_or_default();
        let key = request
            .client_message_id
            .clone()
            .unwrap_or_else(|| format!("dm-share:{}", preview.digest));
        // The Task is cited at the version it has when shared; a confirmed
        // share replays with the version it was stored with.
        let stored = state
            .channels
            .by_client_message_id(&project_id, &channel.id, key.trim())?;
        let references =
            crate::channel_api::pin_references(&state, &project_id, &requested, stored.as_ref())
                .map_err(|error| match error {
                    crate::project_context::ContextError::Invalid(reason) => {
                        DmError::Invalid(reason)
                    }
                    crate::project_context::ContextError::NotFound => {
                        DmError::Invalid("that Task was not found")
                    }
                    crate::project_context::ContextError::Source(_) => DmError::Storage,
                })?;
        let posted = state.channels.post(
            &project_id,
            &channel.id,
            NewMessage {
                body: &preview.text,
                author_kind: Some(AuthorKind::Researcher),
                references: &references,
                client_message_id: Some(&key),
                ..Default::default()
            },
        )?;
        state.orchestrator.wake();
        let (message, created) = posted;
        Ok((crate::channel_api::view(&state, message), created))
    })
    .await
    .map_err(|_| DmError::Storage)??;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(message)))
}
