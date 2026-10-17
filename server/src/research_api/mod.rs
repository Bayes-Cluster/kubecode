//! Project-scoped research API (ADR 0212, issue #149). Every handler first
//! validates the Project, and the store scopes every lookup by it. Nothing
//! here executes an Agent: saving, editing, discussing, archiving, and
//! linking are pure persistence.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

mod rounds;
pub(crate) mod sources;

pub use rounds::KeyedLocks;

use crate::agent_runtime::RuntimeError;
use crate::agent_store::{ConversationRelationship, StoreError};
use crate::agents::AgentId;
use crate::app_state::AppState;
use crate::research_store::{
    AuthorKind, BriefPatch, BriefRevision, EntryKind, LinkKind, LinkRole, NewEntry, ResearchBrief,
    ResearchEntry, ResearchError, ResearchLink, ResearchQuestion, ResearchStatus, ResearchSummary,
    RevisionSummary, SourceAvailability,
};
use crate::team_api::TeamApiError;
use crate::workspace::WorkspaceError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .merge(rounds::routes())
        .route(
            "/projects/{project_id}/research",
            get(list_research).post(create_research),
        )
        .route(
            "/projects/{project_id}/research/{research_id}",
            get(get_research).patch(update_research),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/archive",
            post(archive_research),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/restore",
            post(restore_research),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/resolve",
            post(resolve_research),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/reopen",
            post(reopen_research),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/entries",
            get(list_entries).post(add_entry),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/revisions",
            get(list_revisions),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/revisions/{revision}",
            get(get_revision),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/links",
            post(link_research),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/links/{kind}/{ref_id}",
            delete(unlink_research),
        )
}

// -- Projections -----------------------------------------------------------------

/// A link with the current state of its target. Sessions and Teams that were
/// removed locally stay listed as `removed` rather than breaking the RQ
/// (ADR 0212 §5).
#[derive(Debug, Serialize)]
struct LinkView {
    #[serde(flatten)]
    link: ResearchLink,
    availability: SourceAvailability,
    title: Option<String>,
    agent_id: Option<AgentId>,
    /// Team lifecycle status, or `archived` for an archived Session.
    state: Option<String>,
}

#[derive(Debug, Serialize)]
struct ResearchDetail {
    #[serde(flatten)]
    question: ResearchQuestion,
    links: Vec<LinkView>,
}

fn link_view(state: &AppState, project_id: &str, link: ResearchLink) -> LinkView {
    let removed = |link: ResearchLink| LinkView {
        link,
        availability: SourceAvailability::Removed,
        title: None,
        agent_id: None,
        state: None,
    };
    match link.kind {
        LinkKind::Session => match state.agent_runtime.store().get_conversation(&link.ref_id) {
            Ok(conversation) if conversation.project_id == project_id => LinkView {
                availability: SourceAvailability::Available,
                title: Some(conversation.title.clone()),
                agent_id: Some(conversation.agent_id),
                state: conversation.archived.then(|| "archived".to_owned()),
                link,
            },
            _ => removed(link),
        },
        LinkKind::Team => match state.teams.get_team(&link.ref_id) {
            Ok(team) if team.project_id == project_id => LinkView {
                availability: SourceAvailability::Available,
                title: Some(team.title.clone()),
                agent_id: None,
                state: serde_json::to_value(team.status)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned)),
                link,
            },
            _ => removed(link),
        },
    }
}

fn detail(
    state: &AppState,
    project_id: &str,
    question: ResearchQuestion,
) -> Result<ResearchDetail, ResearchApiError> {
    let links = state
        .research
        .links(project_id, &question.id)?
        .into_iter()
        .map(|link| link_view(state, project_id, link))
        .collect();
    Ok(ResearchDetail { question, links })
}

pub(super) fn check_project(state: &AppState, project_id: &str) -> Result<(), ResearchApiError> {
    state.workspace.project_path(project_id)?;
    Ok(())
}

// -- Questions ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    archived: bool,
}

async fn list_research(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<ResearchSummary>>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.research.list(&project_id, query.archived)?))
}

#[derive(Debug, Deserialize)]
struct CreateResearchRequest {
    #[serde(flatten)]
    brief: ResearchBrief,
    client_request_id: Option<String>,
}

async fn create_research(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateResearchRequest>,
) -> Result<Response, ResearchApiError> {
    check_project(&state, &project_id)?;
    let (question, created) = state.research.create(
        &project_id,
        request.brief,
        request.client_request_id.as_deref(),
    )?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(detail(&state, &project_id, question)?)).into_response())
}

async fn get_research(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<ResearchDetail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state.research.get(&project_id, &research_id)?;
    Ok(Json(detail(&state, &project_id, question)?))
}

#[derive(Debug, Deserialize)]
struct UpdateResearchRequest {
    expected_revision: u64,
    note: Option<String>,
    #[serde(flatten)]
    patch: BriefPatch,
}

async fn update_research(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Json(request): Json<UpdateResearchRequest>,
) -> Result<Json<ResearchDetail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let (question, _changed) = state.research.update_brief(
        &project_id,
        &research_id,
        request.expected_revision,
        &request.patch,
        request.note.as_deref(),
    )?;
    Ok(Json(detail(&state, &project_id, question)?))
}

async fn archive_research(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<ResearchDetail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state
        .research
        .set_archived(&project_id, &research_id, true)?;
    Ok(Json(detail(&state, &project_id, question)?))
}

async fn restore_research(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<ResearchDetail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state
        .research
        .set_archived(&project_id, &research_id, false)?;
    Ok(Json(detail(&state, &project_id, question)?))
}

async fn resolve_research(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<ResearchDetail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question =
        state
            .research
            .set_status(&project_id, &research_id, ResearchStatus::Resolved)?;
    Ok(Json(detail(&state, &project_id, question)?))
}

async fn reopen_research(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<ResearchDetail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state
        .research
        .set_status(&project_id, &research_id, ResearchStatus::Open)?;
    Ok(Json(detail(&state, &project_id, question)?))
}

// -- Entries and revisions -----------------------------------------------------------

#[derive(Debug, Deserialize)]
struct EntriesQuery {
    #[serde(default)]
    after_seq: u64,
    limit: Option<usize>,
}

async fn list_entries(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Query(query): Query<EntriesQuery>,
) -> Result<Json<Vec<ResearchEntry>>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.research.entries(
        &project_id,
        &research_id,
        query.after_seq,
        query.limit,
    )?))
}

#[derive(Debug, Deserialize)]
struct AddEntryRequest {
    kind: EntryKind,
    body: String,
    client_request_id: Option<String>,
}

/// The browser is the researcher: it may record notes and decisions only.
/// Proposals and observations are Agent-attributed and are created solely by
/// server-side adapters that verify the producing execution.
async fn add_entry(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Json(request): Json<AddEntryRequest>,
) -> Result<Response, ResearchApiError> {
    check_project(&state, &project_id)?;
    if !request.kind.researcher_recordable() {
        return Err(ResearchError::Invalid("only notes and decisions can be recorded here").into());
    }
    let entry = state.research.add_entry(
        &project_id,
        &research_id,
        NewEntry {
            kind: request.kind,
            author_kind: AuthorKind::Researcher,
            author_ref: None,
            body: request.body,
            client_request_id: request.client_request_id,
        },
    )?;
    Ok((StatusCode::CREATED, Json(entry)).into_response())
}

async fn list_revisions(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<Vec<RevisionSummary>>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.research.revisions(&project_id, &research_id)?))
}

async fn get_revision(
    State(state): State<AppState>,
    Path((project_id, research_id, revision)): Path<(String, String, u64)>,
) -> Result<Json<BriefRevision>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.research.revision(
        &project_id,
        &research_id,
        revision,
    )?))
}

// -- Links ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct LinkRequest {
    kind: LinkKind,
    ref_id: String,
    role: LinkRole,
}

/// Verifies the target exists in this Project and is linkable. A Team's
/// member Sessions and sub-agent Sessions are not linked individually: link
/// the Team instead.
fn validate_link_target(
    state: &AppState,
    project_id: &str,
    kind: LinkKind,
    ref_id: &str,
) -> Result<(), ResearchApiError> {
    match kind {
        LinkKind::Session => {
            let conversation = state
                .agent_runtime
                .store()
                .get_conversation(ref_id)
                .map_err(|error| match error {
                    StoreError::ConversationNotFound(_) => ResearchError::InvalidLinkTarget,
                    _ => ResearchError::Invalid("the Session could not be read"),
                })?;
            let team_owned = matches!(
                conversation.relationship,
                Some(ConversationRelationship::Subagent | ConversationRelationship::TeamMember)
            ) || state
                .teams
                .member_for_conversation(ref_id)
                .ok()
                .flatten()
                .is_some();
            if conversation.project_id != project_id || team_owned {
                return Err(ResearchError::InvalidLinkTarget.into());
            }
        }
        LinkKind::Team => {
            let team = state
                .teams
                .get_team(ref_id)
                .map_err(|_| ResearchError::InvalidLinkTarget)?;
            if team.project_id != project_id {
                return Err(ResearchError::InvalidLinkTarget.into());
            }
        }
    }
    Ok(())
}

async fn link_research(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Json(request): Json<LinkRequest>,
) -> Result<Json<ResearchDetail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    // Confirm the question first so an unknown id never reveals whether a
    // target exists.
    state.research.get(&project_id, &research_id)?;
    validate_link_target(&state, &project_id, request.kind, &request.ref_id)?;
    state.research.link(
        &project_id,
        &research_id,
        request.kind,
        &request.ref_id,
        request.role,
    )?;
    let question = state.research.get(&project_id, &research_id)?;
    Ok(Json(detail(&state, &project_id, question)?))
}

async fn unlink_research(
    State(state): State<AppState>,
    Path((project_id, research_id, kind, ref_id)): Path<(String, String, String, String)>,
) -> Result<Json<ResearchDetail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let kind = LinkKind::parse(&kind).ok_or(ResearchError::Invalid("unknown link kind"))?;
    state
        .research
        .unlink(&project_id, &research_id, kind, &ref_id)?;
    let question = state.research.get(&project_id, &research_id)?;
    Ok(Json(detail(&state, &project_id, question)?))
}

// -- Errors --------------------------------------------------------------------------

pub(super) enum ResearchApiError {
    Research(ResearchError),
    Workspace(WorkspaceError),
    Store(StoreError),
    Runtime(RuntimeError),
    Team(TeamApiError),
}

impl From<StoreError> for ResearchApiError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<RuntimeError> for ResearchApiError {
    fn from(error: RuntimeError) -> Self {
        Self::Runtime(error)
    }
}

impl From<TeamApiError> for ResearchApiError {
    fn from(error: TeamApiError) -> Self {
        Self::Team(error)
    }
}

impl From<crate::teams::TeamError> for ResearchApiError {
    fn from(error: crate::teams::TeamError) -> Self {
        Self::Team(error.into())
    }
}

impl From<ResearchError> for ResearchApiError {
    fn from(error: ResearchError) -> Self {
        Self::Research(error)
    }
}

impl From<WorkspaceError> for ResearchApiError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

impl IntoResponse for ResearchApiError {
    fn into_response(self) -> Response {
        let mut extra = serde_json::Map::new();
        let (status, code, message) = match self {
            Self::Team(error) => return error.into_response(),
            Self::Store(error) => (StatusCode::BAD_REQUEST, "session_error", error.to_string()),
            Self::Runtime(error) => (StatusCode::BAD_GATEWAY, "agent_error", error.to_string()),
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
            Self::Research(error) => match error {
                ResearchError::NotFound => (
                    StatusCode::NOT_FOUND,
                    "research_not_found",
                    error.to_string(),
                ),
                ResearchError::RevisionNotFound(_) => (
                    StatusCode::NOT_FOUND,
                    "research_revision_not_found",
                    error.to_string(),
                ),
                ResearchError::Archived => {
                    (StatusCode::CONFLICT, "research_archived", error.to_string())
                }
                ResearchError::RoundNotFound => (
                    StatusCode::NOT_FOUND,
                    "research_round_not_found",
                    error.to_string(),
                ),
                ResearchError::KeyReuse => (
                    StatusCode::CONFLICT,
                    "research_request_key_reused",
                    error.to_string(),
                ),
                ResearchError::RoundState(_) => (
                    StatusCode::CONFLICT,
                    "research_round_state",
                    error.to_string(),
                ),
                ResearchError::RevisionConflict { current } => {
                    extra.insert("current_revision".into(), json!(current));
                    (
                        StatusCode::CONFLICT,
                        "research_revision_conflict",
                        error.to_string(),
                    )
                }
                ResearchError::LinkConflict { .. } => (
                    StatusCode::CONFLICT,
                    "research_link_conflict",
                    error.to_string(),
                ),
                ResearchError::InvalidLinkTarget => (
                    StatusCode::BAD_REQUEST,
                    "invalid_research_link",
                    error.to_string(),
                ),
                ResearchError::Invalid(_) => (
                    StatusCode::BAD_REQUEST,
                    "invalid_research",
                    error.to_string(),
                ),
                ResearchError::Database(_) | ResearchError::Json(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "research storage failed".to_owned(),
                ),
            },
        };
        extra.insert("code".into(), json!(code));
        extra.insert("message".into(), json!(message));
        (status, Json(serde_json::Value::Object(extra))).into_response()
    }
}
