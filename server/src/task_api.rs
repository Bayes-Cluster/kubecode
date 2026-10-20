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
        .route(
            "/projects/{project_id}/tasks/{research_id}/archive",
            post(archive),
        )
        .route(
            "/projects/{project_id}/tasks/{research_id}/restore",
            post(restore),
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
                TaskError::Active(reason) => {
                    extra.insert("reason".into(), json!(reason));
                    (StatusCode::CONFLICT, "task_active", error.to_string())
                }
                TaskError::Owned => (StatusCode::CONFLICT, "task_owned", error.to_string()),
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
    /// The Session the work is assigned to, to open its execution record.
    conversation_id: Option<String>,
    updated_at: String,
}

/// One cited `kind:id`, once, with every pin of it (ADR 0230).
#[derive(Debug, Serialize)]
struct TaskEvidence {
    key: String,
    kind: String,
    ref_id: String,
    /// What it is called now; `None` when not described (beyond the rows that
    /// matter, or gone).
    title: Option<String>,
    cited_by: Vec<EvidenceCitation>,
    current: Option<String>,
    /// `current`, `changed`, `removed`, or `unpinned`.
    status: &'static str,
    /// Cited by the open review.
    in_review: bool,
    /// Cited by the review the researcher accepted (a Done Task).
    accepted: bool,
}

#[derive(Debug, Serialize)]
struct EvidenceCitation {
    /// The internal work it is attached to; empty for a review's own citation.
    work_id: String,
    /// A work result's id, or for a review the cited `kind:id`.
    result_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    pinned: Option<String>,
}

/// The round a Task executes in and whether new work is paused there.
#[derive(Debug, Serialize)]
struct TaskExecution {
    round_id: String,
    round_number: u64,
    paused: bool,
    /// The policy revision a pause must name.
    policy_revision: u64,
}

#[derive(Debug, Serialize)]
struct TaskActions {
    archive: crate::task_store::Availability,
    restore: bool,
}

/// Evidence rows the detail lists at most.
const MAX_EVIDENCE_ROWS: usize = 64;

/// Every piece of evidence the Task cites — the open review's own (or, once
/// Done, the accepted review's), and its open internal work's results — one
/// row per `kind:id` with all of its pins.
fn evidence_rows(
    state: &AppState,
    project_id: &str,
    research_id: &str,
    requests: &[ReviewRequest],
    reviews: &[TaskReview],
    done: bool,
) -> Result<Vec<TaskEvidence>, ApiError> {
    let mut rows: Vec<TaskEvidence> = Vec::new();
    let mut cite = |key: &str, citation: EvidenceCitation, in_review: bool, accepted: bool| {
        let index = match rows.iter().position(|row| row.key == key) {
            Some(index) => index,
            None => {
                let (kind, id) = key.split_once(':').unwrap_or((key, ""));
                rows.push(TaskEvidence {
                    key: key.to_owned(),
                    kind: kind.to_owned(),
                    ref_id: id.to_owned(),
                    title: None,
                    cited_by: Vec::new(),
                    current: None,
                    status: "unpinned",
                    in_review: false,
                    accepted: false,
                });
                rows.len() - 1
            }
        };
        let row = &mut rows[index];
        row.in_review |= in_review;
        row.accepted |= accepted;
        row.cited_by.push(citation);
    };
    let open = requests.iter().find(|request| request.state == "open");
    let accepted = if done {
        reviews
            .iter()
            .rev()
            .find(|review| review.accepted)
            .and_then(|review| {
                requests
                    .iter()
                    .find(|request| request.id == review.request_id)
            })
    } else {
        None
    };
    for (request, in_review) in open
        .map(|request| (request, true))
        .into_iter()
        .chain(accepted.map(|request| (request, false)))
    {
        for entry in &request.evidence {
            cite(
                entry,
                EvidenceCitation {
                    work_id: String::new(),
                    result_id: entry.clone(),
                    request_id: Some(request.id.clone()),
                    pinned: request.evidence_pins.get(entry).cloned(),
                },
                in_review,
                !in_review,
            );
        }
    }
    // The results of the Task's open internal work (what `stale_of` checks).
    for summary in state.work.list(
        project_id,
        &WorkFilter {
            research_id: Some(research_id.to_owned()),
            limit: Some(200),
            ..Default::default()
        },
    )? {
        for result in &summary.results {
            cite(
                &format!("{}:{}", result.kind, result.ref_id),
                EvidenceCitation {
                    work_id: summary.item.id.clone(),
                    result_id: result.id.clone(),
                    request_id: None,
                    pinned: result.revision.clone(),
                },
                false,
                false,
            );
        }
    }
    let evidence = evidence_of(state);
    for row in &mut rows {
        row.current = evidence.current_revision(project_id, &row.kind, &row.ref_id);
        let pins: Vec<&String> = row
            .cited_by
            .iter()
            .filter_map(|citation| citation.pinned.as_ref())
            .collect();
        row.status = match (&row.current, pins.is_empty()) {
            (_, true) => "unpinned",
            (None, false) => "removed",
            (Some(current), false) if pins.iter().any(|pinned| *pinned != current) => "changed",
            _ => "current",
        };
    }
    let rank = |row: &TaskEvidence| {
        if row.in_review {
            0
        } else if row.accepted {
            1
        } else if matches!(row.status, "changed" | "removed") {
            2
        } else {
            3
        }
    };
    rows.sort_by_key(rank);
    rows.truncate(MAX_EVIDENCE_ROWS);
    // Titles only for the rows the researcher has to look at.
    for row in &mut rows {
        if rank(row) < 3 {
            row.title = evidence.describe(project_id, &row.kind, &row.ref_id).0;
        }
    }
    Ok(rows)
}

#[derive(Debug, Serialize)]
struct TaskStale {
    /// The internal work the evidence is attached to; empty for the review's own evidence.
    work_id: String,
    /// The open review whose own evidence this is (its `result_id` is the cited `kind:id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
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

/// A review request with the General message that asked for it.
#[derive(Debug, Serialize)]
struct ReviewRequestView {
    #[serde(flatten)]
    request: ReviewRequest,
    general_message_id: Option<String>,
}

/// A review decision with the General message that told the conversation.
#[derive(Debug, Serialize)]
struct ReviewView {
    #[serde(flatten)]
    review: TaskReview,
    general_message_id: Option<String>,
}

/// The General messages the Task service posted for review requests
/// (`review-request:{id}`) and decisions (`task-review:{id}`), in one lookup.
fn review_messages(
    state: &AppState,
    project_id: &str,
    requests: &[ReviewRequest],
    reviews: &[TaskReview],
) -> Result<std::collections::HashMap<String, (String, u64)>, ApiError> {
    let keys: Vec<String> = requests
        .iter()
        .map(|request| format!("review-request:{}", request.id))
        .chain(
            reviews
                .iter()
                .map(|review| format!("task-review:{}", review.id)),
        )
        .collect();
    Ok(state
        .channels
        .messages_by_client_ids(project_id, &keys)
        .map_err(TaskError::from)?)
}

#[derive(Debug, Serialize)]
struct Detail {
    #[serde(flatten)]
    card: TaskCard,
    brief: ResearchBrief,
    revisions: Vec<RevisionNote>,
    authorizations: Vec<Authorization>,
    authorizing_message: Option<AuthorizingMessage>,
    review_requests: Vec<ReviewRequestView>,
    reviews: Vec<ReviewView>,
    internal_work: Vec<InternalWork>,
    open_questions: Vec<OpenQuestion>,
    /// Deprecated: `evidence` lists every cited record with all its pins.
    stale_evidence: Vec<TaskStale>,
    archived: bool,
    evidence: Vec<TaskEvidence>,
    timeline: Vec<crate::task_store::TaskActivity>,
    pending: Vec<crate::task_store::PendingDecision>,
    actions: TaskActions,
    /// The round the newest execution authorization started (ADR 0232).
    execution: Option<TaskExecution>,
    /// Decisions on this Task that did not reach their recipient yet.
    delivery_issues: Vec<crate::orchestrator::SourceDelivery>,
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
                request_id: None,
                evidence: entry,
            });
        }
    }
    // The open review's own evidence, against the revisions pinned when the
    // manager asked for the review (ADR 0226).
    if let Some(request) = state
        .tasks
        .review_requests(project_id, research_id)?
        .into_iter()
        .find(|request| request.state == "open")
    {
        for (entry, pinned) in &request.evidence_pins {
            let (kind, id) = entry.split_once(':').unwrap_or((entry.as_str(), ""));
            let now = evidence.current_revision(project_id, kind, id);
            let status = match &now {
                None => "removed",
                Some(current) if current != pinned => "changed",
                Some(_) => continue,
            };
            stale.push(TaskStale {
                work_id: String::new(),
                request_id: Some(request.id.clone()),
                evidence: StaleEvidence {
                    result_id: entry.clone(),
                    kind: kind.to_owned(),
                    ref_id: id.to_owned(),
                    status,
                    pinned: pinned.clone(),
                    current: now,
                },
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
                conversation_id: summary
                    .assignment
                    .as_ref()
                    .map(|assignment| assignment.conversation_id.clone()),
                updated_at: summary.item.updated_at,
            });
        }
        let requests = state.tasks.review_requests(&project_id, &research_id)?;
        let reviews = state.tasks.reviews(&project_id, &research_id)?;
        let messages = review_messages(&state, &project_id, &requests, &reviews)?;
        let message_of = |key: String| messages.get(&key).map(|(id, _)| id.clone());
        let evidence = evidence_rows(
            &state,
            &project_id,
            &research_id,
            &requests,
            &reviews,
            card.stage == crate::task_store::TaskStage::Done,
        )?;
        let mut pending = state.tasks.pending(&project_id, &research_id)?;
        if let Some(open) = requests.iter().find(|request| request.state == "open") {
            pending.extend(
                evidence
                    .iter()
                    .filter(|row| row.status == "changed")
                    .map(|row| crate::task_store::PendingDecision {
                        key: format!("evidence:{}", row.key),
                        kind: "evidence_changed",
                        ref_id: row.key.clone(),
                        since: open.created_at.clone(),
                    }),
            );
        }
        let execution = match authorizations
            .iter()
            .rev()
            .filter(|authorization| {
                authorization.kind == crate::task_store::AuthorizationKind::Execute
            })
            .find_map(|authorization| authorization.round_id.clone())
        {
            Some(round_id) => {
                let policy = state.work.policy(&project_id, &round_id)?;
                let round_number = card
                    .rounds
                    .iter()
                    .find(|round| round.id == round_id)
                    .map_or(0, |round| round.number);
                Some(TaskExecution {
                    round_id,
                    round_number,
                    paused: policy.paused,
                    policy_revision: policy.revision,
                })
            }
            None => None,
        };
        // Presentation: a failed read lists no issue instead of failing the detail.
        let delivery_issues = state
            .orchestrator
            .task_delivery_issues(&project_id, &research_id)
            .unwrap_or_else(|error| {
                eprintln!("WARN: Task delivery issues could not be read: {error}");
                Vec::new()
            });
        Ok(Detail {
            execution,
            delivery_issues,
            archived: question.archived,
            actions: TaskActions {
                archive: state
                    .tasks
                    .archive_availability(&project_id, &research_id)?,
                restore: question.archived,
            },
            timeline: state.tasks.timeline(&project_id, &research_id)?,
            pending,
            evidence,
            revisions: state.tasks.revisions(&project_id, &research_id)?,
            review_requests: requests
                .into_iter()
                .map(|request| ReviewRequestView {
                    general_message_id: message_of(format!("review-request:{}", request.id)),
                    request,
                })
                .collect(),
            reviews: reviews
                .into_iter()
                .map(|review| ReviewView {
                    general_message_id: message_of(format!("task-review:{}", review.id)),
                    review,
                })
                .collect(),
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
) -> Result<Json<ReviewView>, ApiError> {
    check_project(&state, &project_id)?;
    let review = tokio::task::spawn_blocking(move || -> Result<ReviewView, ApiError> {
        let outcome = match body.outcome.as_deref() {
            None => WorkOutcome::Unknown,
            Some(value) => {
                WorkOutcome::parse(value).ok_or(ApiError::BadRequest("unknown outcome"))?
            }
        };
        if body.accept {
            // Evidence that changed must be looked at and re-pinned first. Evidence
            // that no longer exists cannot be re-pinned: the interface makes the
            // researcher acknowledge it, and it does not block the decision forever.
            let stale = stale_of(&state, &project_id, &research_id)?;
            if stale.iter().any(|entry| entry.evidence.status == "changed") {
                return Err(ApiError::StaleEvidence(stale));
            }
        }
        let review = state.tasks.review(
            &project_id,
            &research_id,
            &body.request_id,
            body.accept,
            outcome,
            body.reason.as_deref(),
        )?;
        // The manager hears the decision, with the researcher's reasons: a Task
        // sent back is rework it must plan, and an accepted one is closed out.
        if let Ok(Some(manager)) = state.members.general(&project_id)
            && let Some(session) = manager.public_conversation_id.as_deref()
        {
            let title = state
                .research
                .get(&project_id, &research_id)
                .map(|question| question.brief.title)
                .unwrap_or_default();
            if let Err(error) =
                state
                    .orchestrator
                    .route_task_review(&project_id, session, &review, &title)
            {
                eprintln!("WARN: could not tell the manager about a Task review: {error}");
            }
            state.orchestrator.wake();
        }
        // The verdict posted to General, so the decision can link to it; none
        // if that best-effort post (or this lookup) failed: the decision is
        // already recorded and must not be reported as failed.
        let general_message_id =
            review_messages(&state, &project_id, &[], std::slice::from_ref(&review))
                .ok()
                .and_then(|messages| messages.into_values().next())
                .map(|(id, _)| id);
        Ok(ReviewView {
            review,
            general_message_id,
        })
    })
    .await
    .map_err(|_| ApiError::BadRequest("the review could not be recorded"))??;
    Ok(Json(review))
}

#[derive(Debug, Deserialize)]
struct RepinBody {
    #[serde(default)]
    work_id: String,
    /// A work result's id, or, with `request_id`, the review's cited `kind:id`.
    result_id: String,
    /// The open review whose own evidence is being re-pinned.
    #[serde(default)]
    request_id: Option<String>,
    /// The version the researcher looked at; if it has changed again, nothing is pinned.
    #[serde(default)]
    revision: Option<String>,
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
        if let Some(request_id) = body.request_id.as_deref() {
            let (kind, id) = body
                .result_id
                .split_once(':')
                .unwrap_or((body.result_id.as_str(), ""));
            let current = evidence_of(&state)
                .current_revision(&project_id, kind, id)
                .ok_or(ApiError::BadRequest(
                    "that evidence has no current version to accept",
                ))?;
            // The review's own evidence is accepted only at the version the
            // researcher looked at (ADR 0226).
            let looked_at = body
                .revision
                .as_deref()
                .ok_or(ApiError::BadRequest("name the version that was looked at"))?;
            if looked_at != current {
                return Err(ApiError::StaleEvidence(stale_of(
                    &state,
                    &project_id,
                    &research_id,
                )?));
            }
            state.tasks.repin_review_evidence(
                &project_id,
                &research_id,
                request_id,
                &body.result_id,
                &current,
            )?;
            return Ok(());
        }
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
        // Work-attached evidence, like the review's own, is accepted only at
        // the version the researcher looked at (ADR 0230 §4).
        let looked_at = body
            .revision
            .as_deref()
            .ok_or(ApiError::BadRequest("name the version that was looked at"))?;
        if looked_at != current {
            return Err(ApiError::StaleEvidence(stale_of(
                &state,
                &project_id,
                &research_id,
            )?));
        }
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

/// Hides a Task from the board, keeping everything, unless a review is open or
/// its work is active (ADR 0230). Archiving is not completing.
async fn archive(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    set_archived(state, project_id, research_id, true).await
}

/// Puts an archived Task back on the board in the stage it had.
async fn restore(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    set_archived(state, project_id, research_id, false).await
}

async fn set_archived(
    state: AppState,
    project_id: String,
    research_id: String,
    archived: bool,
) -> Result<StatusCode, ApiError> {
    check_project(&state, &project_id)?;
    tokio::task::spawn_blocking(move || {
        state
            .tasks
            .set_archived(&project_id, &research_id, archived)
            .map(|_| ())
    })
    .await
    .map_err(|_| ApiError::BadRequest("the Task could not be archived"))??;
    Ok(StatusCode::NO_CONTENT)
}
