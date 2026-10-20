//! Workspace conversation routes (ADR 0216). Every handler first validates the
//! Project from the route; the store scopes every lookup by it. The browser
//! authors `researcher` messages only: authorship is never taken from the
//! request body, and nothing here starts an Agent.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::channel_store::{
    AuthorKind, Channel, ChannelError, ContextRef, Intent, Mention, Message, MessagePageView,
    MessageQuery, MessageView, NewMessage, Scope, Thread,
};
use crate::workspace::WorkspaceError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/channels", get(list_channels))
        .route(
            "/projects/{project_id}/channels/{channel_id}/messages",
            get(list_messages).post(post_message),
        )
        .route(
            "/projects/{project_id}/channels/{channel_id}/messages/{message_id}",
            get(get_message),
        )
        .route(
            "/projects/{project_id}/channels/{channel_id}/threads",
            get(list_threads).post(start_thread),
        )
        .route(
            "/projects/{project_id}/threads/{thread_id}",
            get(get_thread),
        )
        .route(
            "/projects/{project_id}/threads/{thread_id}/link",
            put(link_thread),
        )
}

enum ChannelApiError {
    Channel(ChannelError),
    Workspace(WorkspaceError),
    /// A mention names a member who cannot receive messages (ADR 0229 §2).
    MentionUnavailable {
        member_id: String,
        reason: &'static str,
    },
}

impl From<ChannelError> for ChannelApiError {
    fn from(error: ChannelError) -> Self {
        Self::Channel(error)
    }
}

impl From<WorkspaceError> for ChannelApiError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

impl IntoResponse for ChannelApiError {
    fn into_response(self) -> Response {
        let mut extra = serde_json::Map::new();
        let (status, code, message) = match self {
            Self::MentionUnavailable { member_id, reason } => {
                extra.insert("member_id".into(), json!(member_id));
                extra.insert("reason".into(), json!(reason));
                (
                    StatusCode::BAD_REQUEST,
                    "mention_unavailable",
                    "a mentioned member cannot receive messages".to_owned(),
                )
            }
            Self::Workspace(WorkspaceError::ProjectNotFound(id)) => (
                StatusCode::NOT_FOUND,
                "not_found",
                format!("project not found: {id}"),
            ),
            Self::Workspace(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                error.to_string(),
            ),
            Self::Channel(error) => match error {
                ChannelError::NotFound => (
                    StatusCode::NOT_FOUND,
                    "channel_not_found",
                    error.to_string(),
                ),
                ChannelError::MessageNotFound => (
                    StatusCode::NOT_FOUND,
                    "message_not_found",
                    error.to_string(),
                ),
                ChannelError::ThreadNotFound => {
                    (StatusCode::NOT_FOUND, "thread_not_found", error.to_string())
                }
                ChannelError::Invalid(_) => (
                    StatusCode::BAD_REQUEST,
                    "invalid_conversation",
                    error.to_string(),
                ),
                ChannelError::NoIntent => (
                    StatusCode::BAD_REQUEST,
                    "message_has_no_intent",
                    error.to_string(),
                ),
                ChannelError::KeyReuse => (
                    StatusCode::CONFLICT,
                    "message_key_reused",
                    error.to_string(),
                ),
                ChannelError::Stale { current } => {
                    extra.insert("current_revision".into(), json!(current));
                    (
                        StatusCode::CONFLICT,
                        "thread_revision_conflict",
                        error.to_string(),
                    )
                }
                ChannelError::Database(_) | ChannelError::Json(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "conversation storage failed".to_owned(),
                ),
            },
        };
        extra.insert("code".into(), json!(code));
        extra.insert("message".into(), json!(message));
        (status, Json(serde_json::Value::Object(extra))).into_response()
    }
}

fn check_project(state: &AppState, project_id: &str) -> Result<(), ChannelApiError> {
    state.workspace.project_path(project_id)?;
    Ok(())
}

/// Every public Session the Project's members have had, mapped to the member:
/// how a message names its author and mentions (ADR 0229 §1). Identity is
/// presentation, so a failed lookup degrades to an unnamed author (shown as
/// unknown, never as someone else) instead of failing the read.
pub(crate) fn authors(state: &AppState, project_id: &str) -> HashMap<String, String> {
    state
        .members
        .public_authors(project_id)
        .unwrap_or_else(|error| {
            eprintln!("WARN: message authors could not be resolved: {error}");
            HashMap::new()
        })
}

/// A message as the API shows it, with its member identity.
pub(crate) fn view(state: &AppState, message: Message) -> MessageView {
    let authors = authors(state, &message.project_id);
    MessageView::project(message, &authors)
}

/// Created, or the stored record on a replay.
fn created_or_ok<T: serde::Serialize>(created: bool, value: T) -> Response {
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    (status, Json(value)).into_response()
}

async fn list_channels(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<Channel>>, ChannelApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.channels.channels(&project_id)?))
}

#[derive(Debug, Deserialize)]
struct MessagesQuery {
    thread_id: Option<String>,
    before_seq: Option<u64>,
    after_seq: Option<u64>,
    limit: Option<usize>,
    /// Only messages about this Task: a filter over the same history.
    task_id: Option<String>,
}

async fn list_messages(
    State(state): State<AppState>,
    Path((project_id, channel_id)): Path<(String, String)>,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<MessagePageResponse>, ChannelApiError> {
    check_project(&state, &project_id)?;
    let scope = match (query.thread_id.as_deref(), query.task_id.as_deref()) {
        (Some(thread_id), _) => Scope::Thread(thread_id),
        // A Task's messages include the replies of an older Thread.
        (None, Some(_)) => Scope::All,
        (None, None) => Scope::Channel,
    };
    let page = state.channels.messages(
        &project_id,
        &channel_id,
        MessageQuery {
            scope,
            before_seq: query.before_seq,
            after_seq: query.after_seq,
            limit: query.limit,
            task: query.task_id.as_deref(),
        },
    )?;
    // The delivery of the researcher's messages on this page (ADR 0232).
    // Presentation: a failed read leaves it out instead of failing the page.
    let ids: Vec<String> = page
        .messages
        .iter()
        .filter(|message| message.author_kind == AuthorKind::Researcher)
        .map(|message| message.id.clone())
        .collect();
    let deliveries = state
        .orchestrator
        .deliveries_for(&project_id, &ids)
        .unwrap_or_else(|error| {
            eprintln!("WARN: message deliveries could not be read: {error}");
            Vec::new()
        })
        .into_iter()
        .map(|delivery| (delivery.message_id.clone(), delivery))
        .collect();
    Ok(Json(MessagePageResponse {
        page: MessagePageView::project(page, &authors(&state, &project_id)),
        deliveries,
    }))
}

/// A page of messages with the delivery state of the researcher's own.
#[derive(Debug, serde::Serialize)]
struct MessagePageResponse {
    #[serde(flatten)]
    page: MessagePageView,
    deliveries: std::collections::BTreeMap<String, crate::orchestrator::MessageDelivery>,
}

/// One message, so a link to it can land on it however old it is.
async fn get_message(
    State(state): State<AppState>,
    Path((project_id, channel_id, message_id)): Path<(String, String, String)>,
) -> Result<Json<MessageView>, ChannelApiError> {
    check_project(&state, &project_id)?;
    let message = state.channels.message(&project_id, &message_id)?;
    if message.channel_id != channel_id {
        return Err(ChannelError::MessageNotFound.into());
    }
    Ok(Json(view(&state, message)))
}

/// Who a message names: a member (what the browser sends), or a Session (the
/// legacy form). Exactly one of the two.
#[derive(Debug, Deserialize)]
struct MentionRequest {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    member_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PostMessageRequest {
    body: String,
    /// Legacy: kept for pages opened before Threads became read-only history.
    thread_id: Option<String>,
    client_message_id: Option<String>,
    /// Legacy: `ask`/`request`, kept for pages opened before the upgrade.
    intent: Option<Intent>,
    #[serde(default)]
    mentions: Vec<MentionRequest>,
    #[serde(default)]
    references: Vec<ContextRef>,
    /// An earlier message of the conversation this one cites.
    reply_to: Option<String>,
}

/// Resolves each mention to the Session it is stored as. A member resolves to
/// its current public Session when the message is written; one that is
/// removed, needs setup, or is not in this Project is refused instead of the
/// message silently falling through to the manager. A retry of a stored
/// message reuses the Session its mention was stored with when that Session
/// was this member's, so a retry after a Session replacement replays instead
/// of conflicting. Naming a member twice names it once.
fn resolve_mentions(
    state: &AppState,
    project_id: &str,
    channel_id: &str,
    client_message_id: Option<&str>,
    requested: &[MentionRequest],
) -> Result<Vec<Mention>, ChannelApiError> {
    if requested.len() > crate::channel_store::MAX_MENTIONS {
        return Err(ChannelError::Invalid("too many mentions").into());
    }
    let lookup_failed = |error: crate::member_store::MemberError| {
        eprintln!("WARN: a mention could not be resolved: {error}");
        ChannelApiError::Channel(ChannelError::Invalid("a mention could not be resolved"))
    };
    // Only a mention by member needs the roster and the stored message.
    let (authors, stored) = if requested.iter().any(|mention| mention.member_id.is_some()) {
        let authors = state
            .members
            .public_authors(project_id)
            .map_err(lookup_failed)?;
        let stored = match client_message_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(key) => state
                .channels
                .by_client_message_id(project_id, channel_id, key)?
                .map(|message| message.mentions)
                .unwrap_or_default(),
            None => Vec::new(),
        };
        (authors, stored)
    } else {
        Default::default()
    };
    let mut resolved: Vec<Mention> = Vec::new();
    let mut named: Vec<&str> = Vec::new();
    for mention in requested {
        let member_id = match (&mention.session_id, &mention.member_id) {
            (Some(session_id), None) => {
                resolved.push(Mention {
                    session_id: session_id.clone(),
                });
                continue;
            }
            (None, Some(member_id)) => member_id.as_str(),
            _ => {
                return Err(ChannelError::Invalid("a mention names a member or a Session").into());
            }
        };
        if named.contains(&member_id) {
            continue;
        }
        named.push(member_id);
        // A replay keeps the Session the stored message named this member by.
        if let Some(previous) = stored.iter().find(|previous| {
            authors.get(&previous.session_id).map(String::as_str) == Some(member_id)
        }) {
            resolved.push(previous.clone());
            continue;
        }
        let unavailable = |reason: &'static str| ChannelApiError::MentionUnavailable {
            member_id: member_id.to_owned(),
            reason,
        };
        let member = match state.members.get(project_id, member_id) {
            Ok(member) => member,
            Err(crate::member_store::MemberError::NotFound) => {
                return Err(unavailable("not_found"));
            }
            Err(error) => return Err(lookup_failed(error)),
        };
        let session_id = match (member.state, member.public_conversation_id) {
            (crate::member_store::MemberState::Removed, _) => {
                return Err(unavailable("removed"));
            }
            (crate::member_store::MemberState::Active, Some(session_id)) => session_id,
            _ => return Err(unavailable("needs_setup")),
        };
        resolved.push(Mention { session_id });
    }
    Ok(resolved)
}

/// A direct message is private to the researcher and one member: it cannot be
/// mentioned or cited in the shared conversation. Sharing it is an explicit,
/// previewed act of its own (ADR 0223).
fn refuse_private(
    state: &AppState,
    project_id: &str,
    mentions: &[Mention],
    references: &[ContextRef],
) -> Result<(), ChannelApiError> {
    let private = |conversation_id: &str| {
        state
            .members
            .is_dm_session(project_id, conversation_id)
            .unwrap_or(true)
    };
    if mentions.iter().any(|mention| private(&mention.session_id)) {
        return Err(ChannelError::Invalid("a direct message cannot be mentioned").into());
    }
    let cites_private = references.iter().any(|reference| match reference.kind {
        crate::project_context::ContextKind::Session => private(&reference.id),
        crate::project_context::ContextKind::SessionTurn => {
            private(reference.id.split('/').next().unwrap_or_default())
        }
        _ => false,
    });
    if cites_private {
        return Err(ChannelError::Invalid("a direct message cannot be cited").into());
    }
    Ok(())
}

async fn post_message(
    State(state): State<AppState>,
    Path((project_id, channel_id)): Path<(String, String)>,
    Json(request): Json<PostMessageRequest>,
) -> Result<Response, ChannelApiError> {
    check_project(&state, &project_id)?;
    let mentions = resolve_mentions(
        &state,
        &project_id,
        &channel_id,
        request.client_message_id.as_deref(),
        &request.mentions,
    )?;
    refuse_private(&state, &project_id, &mentions, &request.references)?;
    let (message, created): (Message, bool) = state.channels.post(
        &project_id,
        &channel_id,
        NewMessage {
            thread_id: request.thread_id.as_deref(),
            body: &request.body,
            author_kind: Some(AuthorKind::Researcher),
            author_ref: None,
            intent: request.intent,
            mentions: &mentions,
            references: &request.references,
            client_message_id: request.client_message_id.as_deref(),
            reply_to: request.reply_to.as_deref(),
            hops: 0,
        },
    )?;
    if created {
        // The orchestrator reads the message and routes it without waiting
        // for its next scheduled pass.
        state.orchestrator.wake();
    }
    Ok(created_or_ok(created, view(&state, message)))
}

#[derive(Debug, Deserialize)]
struct ThreadsQuery {
    research_id: Option<String>,
}

async fn list_threads(
    State(state): State<AppState>,
    Path((project_id, channel_id)): Path<(String, String)>,
    Query(query): Query<ThreadsQuery>,
) -> Result<Json<Vec<Thread>>, ChannelApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.channels.threads(
        &project_id,
        &channel_id,
        query.research_id.as_deref(),
    )?))
}

#[derive(Debug, Deserialize)]
struct StartThreadRequest {
    root_message_id: String,
    title: Option<String>,
}

async fn start_thread(
    State(state): State<AppState>,
    Path((project_id, channel_id)): Path<(String, String)>,
    Json(request): Json<StartThreadRequest>,
) -> Result<Response, ChannelApiError> {
    check_project(&state, &project_id)?;
    let (thread, created) = state.channels.start_thread(
        &project_id,
        &channel_id,
        &request.root_message_id,
        request.title.as_deref(),
        Some("researcher"),
    )?;
    Ok(created_or_ok(created, thread))
}

async fn get_thread(
    State(state): State<AppState>,
    Path((project_id, thread_id)): Path<(String, String)>,
) -> Result<Json<Thread>, ChannelApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.channels.thread(&project_id, &thread_id)?))
}

#[derive(Debug, Deserialize)]
struct LinkThreadRequest {
    expected_revision: u64,
    research_id: Option<String>,
    round_id: Option<String>,
}

async fn link_thread(
    State(state): State<AppState>,
    Path((project_id, thread_id)): Path<(String, String)>,
    Json(request): Json<LinkThreadRequest>,
) -> Result<Json<Thread>, ChannelApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.channels.link_thread(
        &project_id,
        &thread_id,
        request.expected_revision,
        request.research_id.as_deref(),
        request.round_id.as_deref(),
    )?))
}
