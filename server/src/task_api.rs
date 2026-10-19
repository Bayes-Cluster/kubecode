//! The Task board and inspector over HTTP (ADR 0221). Tasks are read models
//! over the research, work, and member stores. The browser can read them and
//! review a Task's results; it cannot admit one — admission is the General
//! Agent's act on the researcher's conversational instruction, with no form
//! and no confirmation button in between.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app_state::AppState;
use crate::research_store::ResearchBrief;
use crate::task_store::{
    Authorization, Draft, ReviewRequest, RevisionNote, TaskBoard, TaskCard, TaskError, TaskReview,
};
use crate::work_agent::{Evidence, StaleEvidence};
use crate::work_store::{Actor, WorkError, WorkFilter, WorkOutcome};
use crate::workspace::WorkspaceError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/tasks/board", get(board))
        .route("/projects/{project_id}/tasks/drafts", get(drafts))
        .route("/projects/{project_id}/tasks/{research_id}", get(detail))
        .route(
            "/projects/{project_id}/tasks/{research_id}/review",
            post(review),
        )
        .route(
            "/projects/{project_id}/tasks/{research_id}/repin",
            post(repin),
        )
}

enum ApiError {
    Task(TaskError),
    Work(WorkError),
    Workspace(WorkspaceError),
    BadRequest(&'static str),
    /// Cited evidence changed since it was attached.
    StaleEvidence(Vec<TaskStale>),
}

impl From<TaskError> for ApiError {
    fn from(error: TaskError) -> Self {
        Self::Task(error)
    }
}

impl From<WorkError> for ApiError {
    fn from(error: WorkError) -> Self {
        Self::Work(error)
    }
}

impl From<WorkspaceError> for ApiError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut extra = serde_json::Map::new();
        let (status, code, message) = match self {
            Self::BadRequest(reason) => (
                StatusCode::BAD_REQUEST,
                "invalid_task_request",
                reason.to_owned(),
            ),
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
            Self::StaleEvidence(stale) => {
                extra.insert("stale".into(), json!(stale));
                (
                    StatusCode::CONFLICT,
                    "work_evidence_stale",
                    "cited evidence changed since it was attached; look at it and accept its current version first".to_owned(),
                )
            }
            Self::Work(WorkError::NotFound) => (
                StatusCode::NOT_FOUND,
                "task_not_found",
                "task not found".to_owned(),
            ),
            Self::Work(WorkError::Database(_) | WorkError::Json(_)) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "task storage failed".to_owned(),
            ),
            Self::Work(error) => (StatusCode::CONFLICT, "work_state", error.to_string()),
            Self::Task(error) => match &error {
                TaskError::NotFound
                | TaskError::Research(crate::research_store::ResearchError::NotFound) => {
                    (StatusCode::NOT_FOUND, "task_not_found", error.to_string())
                }
                TaskError::Research(
                    crate::research_store::ResearchError::Database(_)
                    | crate::research_store::ResearchError::Json(_),
                )
                | TaskError::Channel(
                    crate::channel_store::ChannelError::Database(_)
                    | crate::channel_store::ChannelError::Json(_),
                )
                | TaskError::Work(WorkError::Database(_) | WorkError::Json(_))
                | TaskError::Member(
                    crate::member_store::MemberError::Database(_)
                    | crate::member_store::MemberError::Json(_),
                ) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "task storage failed".to_owned(),
                ),
                TaskError::Invalid(_) => (
                    StatusCode::BAD_REQUEST,
                    "invalid_task_request",
                    error.to_string(),
                ),
                TaskError::State(_) => (StatusCode::CONFLICT, "task_state", error.to_string()),
                TaskError::Database(_) | TaskError::Json(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "task storage failed".to_owned(),
                ),
                _ => (StatusCode::CONFLICT, "task_state", error.to_string()),
            },
        };
        extra.insert("code".into(), json!(code));
        extra.insert("message".into(), json!(message));
        (status, Json(serde_json::Value::Object(extra))).into_response()
    }
}

fn check_project(state: &AppState, project_id: &str) -> Result<(), ApiError> {
    state.workspace.project_path(project_id)?;
    Ok(())
}

fn evidence_of(state: &AppState) -> Evidence {
    Evidence::new(state.context.clone(), state.workspace.clone())
}

async fn board(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<TaskBoard>, ApiError> {
    check_project(&state, &project_id)?;
    let board = tokio::task::spawn_blocking(move || state.tasks.board(&project_id))
        .await
        .map_err(|_| ApiError::BadRequest("the board could not be composed"))??;
    Ok(Json(board))
}

async fn drafts(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<Draft>>, ApiError> {
    check_project(&state, &project_id)?;
    let drafts = tokio::task::spawn_blocking(move || state.tasks.drafts(&project_id))
        .await
        .map_err(|_| ApiError::BadRequest("the drafts could not be read"))??;
    Ok(Json(drafts))
}

/// A piece of internal work, as the Task lists it. Its own inspector is the
/// work inspector.
#[derive(Debug, Serialize)]
struct InternalWork {
    id: String,
    title: String,
    stage: crate::work_store::WorkStage,
    condition: crate::work_store::WorkCondition,
    lifecycle: crate::work_store::WorkLifecycle,
    attempts: usize,
    experiments: usize,
    assignee: Option<crate::task_store::Participant>,
}

#[derive(Debug, Serialize)]
struct TaskStale {
    work_id: String,
    #[serde(flatten)]
    evidence: StaleEvidence,
}

#[derive(Debug, Serialize)]
struct OpenQuestion {
    work_id: String,
    work_title: String,
    #[serde(flatten)]
    request: crate::work_store::DecisionRequest,
}

#[derive(Debug, Serialize)]
struct AuthorizingMessage {
    id: String,
    body: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct Detail {
    #[serde(flatten)]
    card: TaskCard,
    brief: ResearchBrief,
    revisions: Vec<RevisionNote>,
    authorizations: Vec<Authorization>,
    authorizing_message: Option<AuthorizingMessage>,
    review_requests: Vec<ReviewRequest>,
    reviews: Vec<TaskReview>,
    internal_work: Vec<InternalWork>,
    open_questions: Vec<OpenQuestion>,
    stale_evidence: Vec<TaskStale>,
}

fn stale_of(
    state: &AppState,
    project_id: &str,
    research_id: &str,
) -> Result<Vec<TaskStale>, ApiError> {
    let evidence = evidence_of(state);
    let mut stale = Vec::new();
    for summary in state.work.list(
        project_id,
        &WorkFilter {
            research_id: Some(research_id.to_owned()),
            limit: Some(200),
            ..Default::default()
        },
    )? {
        for entry in evidence.stale(project_id, &summary.results) {
            stale.push(TaskStale {
                work_id: summary.item.id.clone(),
                evidence: entry,
            });
        }
    }
    Ok(stale)
}

async fn detail(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<Detail>, ApiError> {
    check_project(&state, &project_id)?;
    let detail = tokio::task::spawn_blocking(move || -> Result<Detail, ApiError> {
        let card = state
            .tasks
            .card(&project_id, &research_id)?
            .ok_or(TaskError::NotFound)?;
        let question = state
            .research
            .get(&project_id, &research_id)
            .map_err(TaskError::from)?;
        let authorizations = state.tasks.authorizations(&project_id, &research_id)?;
        let authorizing_message = card
            .authorizing_message_id
            .as_deref()
            .and_then(|id| state.channels.message(&project_id, id).ok())
            .map(|message| AuthorizingMessage {
                id: message.id,
                body: message.body.chars().take(600).collect(),
                created_at: message.created_at,
            });
        let mut internal_work = Vec::new();
        let mut open_questions = Vec::new();
        for summary in state.work.list(
            &project_id,
            &WorkFilter {
                research_id: Some(research_id.clone()),
                include_closed: true,
                limit: Some(200),
                ..Default::default()
            },
        )? {
            for request in state
                .work
                .decision_requests(&project_id, &summary.item.id)?
            {
                if request.state == "open" {
                    open_questions.push(OpenQuestion {
                        work_id: summary.item.id.clone(),
                        work_title: summary.item.title.clone(),
                        request,
                    });
                }
            }
            let assignee = summary.assignment.as_ref().and_then(|assignment| {
                state
                    .members
                    .by_conversation(&project_id, &assignment.conversation_id)
                    .ok()
                    .flatten()
                    .map(|resolved| crate::task_store::Participant {
                        member_id: resolved.member.id,
                        name: resolved.member.name,
                        handle: resolved.member.handle,
                        role: resolved.member.role.as_str().to_owned(),
                    })
            });
            internal_work.push(InternalWork {
                id: summary.item.id,
                title: summary.item.title,
                stage: summary.item.stage,
                condition: summary.item.condition,
                lifecycle: summary.item.lifecycle,
                attempts: summary.attempt_count,
                experiments: summary.experiment_count,
                assignee,
            });
        }
        Ok(Detail {
            revisions: state.tasks.revisions(&project_id, &research_id)?,
            review_requests: state.tasks.review_requests(&project_id, &research_id)?,
            reviews: state.tasks.reviews(&project_id, &research_id)?,
            stale_evidence: stale_of(&state, &project_id, &research_id)?,
            card,
            brief: question.brief,
            authorizations,
            authorizing_message,
            internal_work,
            open_questions,
        })
    })
    .await
    .map_err(|_| ApiError::BadRequest("the Task could not be composed"))??;
    Ok(Json(detail))
}

#[derive(Debug, Deserialize)]
struct ReviewRequestBody {
    /// The review request the researcher looked at; a newer one is not decided by an old click.
    request_id: String,
    accept: bool,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

/// The researcher accepts the Task's results (choosing the scientific outcome)
/// or sends it back. Accepting is refused while evidence the Task's work cites
/// has changed since it was attached.
async fn review(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Json(body): Json<ReviewRequestBody>,
) -> Result<Json<TaskReview>, ApiError> {
    check_project(&state, &project_id)?;
    let review = tokio::task::spawn_blocking(move || -> Result<TaskReview, ApiError> {
        let outcome = match body.outcome.as_deref() {
            None => WorkOutcome::Unknown,
            Some(value) => {
                WorkOutcome::parse(value).ok_or(ApiError::BadRequest("unknown outcome"))?
            }
        };
        if body.accept {
            let stale = stale_of(&state, &project_id, &research_id)?;
            if !stale.is_empty() {
                return Err(ApiError::StaleEvidence(stale));
            }
        }
        Ok(state.tasks.review(
            &project_id,
            &research_id,
            &body.request_id,
            body.accept,
            outcome,
            body.reason.as_deref(),
        )?)
    })
    .await
    .map_err(|_| ApiError::BadRequest("the review could not be recorded"))??;
    Ok(Json(review))
}

#[derive(Debug, Deserialize)]
struct RepinBody {
    work_id: String,
    result_id: String,
}

/// The researcher accepts the current version of one cited result, after
/// looking at what changed.
async fn repin(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Json(body): Json<RepinBody>,
) -> Result<StatusCode, ApiError> {
    check_project(&state, &project_id)?;
    tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let item = state.work.get(&project_id, &body.work_id)?;
        if item.research_id.as_deref() != Some(research_id.as_str()) {
            return Err(WorkError::NotFound.into());
        }
        let results = state.work.results(&project_id, &body.work_id)?;
        let result = results
            .iter()
            .find(|result| result.id == body.result_id)
            .ok_or(WorkError::NotFound)?;
        let current = evidence_of(&state)
            .current_revision(&project_id, &result.kind, &result.ref_id)
            .ok_or(ApiError::BadRequest(
                "that evidence has no current version to accept",
            ))?;
        state.work.repin_result(
            &project_id,
            &body.work_id,
            &body.result_id,
            Some(&current),
            &Actor::Researcher,
        )?;
        let remaining = state.work.results(&project_id, &body.work_id)?;
        if evidence_of(&state)
            .stale(&project_id, &remaining)
            .is_empty()
        {
            state
                .work
                .clear_attention(&project_id, &body.work_id, "evidence")?;
        }
        Ok(())
    })
    .await
    .map_err(|_| ApiError::BadRequest("the evidence could not be accepted"))??;
    Ok(StatusCode::NO_CONTENT)
}
