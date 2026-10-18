//! The Workspace work board (ADR 0218): one server-composed projection of the
//! canonical work records, a card inspector, and the researcher's revision-
//! checked commands. Every filter narrows the same items — none creates another
//! board or another card — and every command goes through the work store's
//! rules: the browser can express a supported command, never fabricate
//! completion or bypass a check. Legacy Team work is shown with its original
//! attribution and is operated through its Team.

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::agents::AgentId;
use crate::app_state::AppState;
use crate::orchestrator::{OrchestratorError, Route};
use crate::work_store::{
    Actor, Assignment, Attempt, Closure, Ctx, DependencyState, NewWork, PlanPatch, ResultRef,
    ReviewInput, ReviewRecord, WorkCondition, WorkCounts, WorkError, WorkFilter, WorkLifecycle,
    WorkOrigin, WorkOutcome, WorkStage, WorkSummary,
};
use crate::workspace::WorkspaceError;

const BOARD_LIMIT: usize = 200;
const MAX_OFFSET: usize = 100_000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{project_id}/work", post(create))
        .route("/projects/{project_id}/work/board", get(board))
        .route("/projects/{project_id}/work/{work_id}", get(detail))
        .route(
            "/projects/{project_id}/work/{work_id}/commands",
            post(command),
        )
}

enum ApiError {
    Work(WorkError),
    Orchestrator(OrchestratorError),
    Workspace(WorkspaceError),
    BadRequest(&'static str),
    /// Pausing would erase a condition someone else set (needs input, blocked, waiting).
    ConditionInUse,
}

impl From<WorkError> for ApiError {
    fn from(error: WorkError) -> Self {
        Self::Work(error)
    }
}

impl From<OrchestratorError> for ApiError {
    fn from(error: OrchestratorError) -> Self {
        Self::Orchestrator(error)
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
                "invalid_work_request",
                reason.to_owned(),
            ),
            Self::ConditionInUse => (
                StatusCode::CONFLICT,
                "work_condition_in_use",
                "the work has a condition set by someone else; resolve it first".to_owned(),
            ),
            Self::Workspace(WorkspaceError::ProjectNotFound(id)) => (
                StatusCode::NOT_FOUND,
                "not_found",
                format!("project not found: {id}"),
            ),
            Self::Workspace(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "workspace storage failed".to_owned(),
            ),
            // A work error wrapped by routing keeps its own meaning.
            Self::Orchestrator(OrchestratorError::Work(error)) => {
                return Self::Work(error).into_response();
            }
            Self::Orchestrator(OrchestratorError::NotFound) => (
                StatusCode::NOT_FOUND,
                "work_not_found",
                "work not found".to_owned(),
            ),
            Self::Orchestrator(OrchestratorError::Invalid(reason)) => (
                StatusCode::BAD_REQUEST,
                "invalid_work_request",
                reason.to_owned(),
            ),
            Self::Orchestrator(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "work storage failed".to_owned(),
            ),
            Self::Work(error) => match error {
                WorkError::NotFound => (StatusCode::NOT_FOUND, "work_not_found", error.to_string()),
                WorkError::StaleState { current } => {
                    extra.insert("current_state_revision".into(), json!(current));
                    (
                        StatusCode::CONFLICT,
                        "work_state_conflict",
                        error.to_string(),
                    )
                }
                WorkError::Stale { current } => {
                    extra.insert("current_revision".into(), json!(current));
                    (
                        StatusCode::CONFLICT,
                        "work_revision_conflict",
                        error.to_string(),
                    )
                }
                WorkError::LegacyOwned => {
                    (StatusCode::CONFLICT, "work_legacy_owned", error.to_string())
                }
                WorkError::BudgetExhausted(limit) => {
                    extra.insert("limit".into(), json!(limit));
                    (
                        StatusCode::CONFLICT,
                        "work_budget_exhausted",
                        error.to_string(),
                    )
                }
                WorkError::RoundPaused => {
                    (StatusCode::CONFLICT, "work_round_paused", error.to_string())
                }
                WorkError::NotAssigned => {
                    (StatusCode::CONFLICT, "work_not_assigned", error.to_string())
                }
                WorkError::Invalid(_) => (
                    StatusCode::BAD_REQUEST,
                    "invalid_work_request",
                    error.to_string(),
                ),
                WorkError::Database(_) | WorkError::Json(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "work storage failed".to_owned(),
                ),
                other => (StatusCode::CONFLICT, "work_state", other.to_string()),
            },
        };
        extra.insert("code".into(), json!(code));
        extra.insert("message".into(), json!(message));
        (status, Json(serde_json::Value::Object(extra))).into_response()
    }
}

// -- Projection -----------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct NamedRef {
    id: String,
    title: String,
}

#[derive(Debug, Serialize)]
struct RoundRef {
    id: String,
    number: u64,
}

#[derive(Debug, Serialize)]
struct ExecutorRef {
    session_id: String,
    title: String,
    agent_id: Option<AgentId>,
    /// False when the assigned Session was removed or is not visible any more.
    available: bool,
}

/// Why a card is not moving, as structured facts the browser words and styles.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Blocker {
    /// A dependency that is not accepted yet (or was closed without being).
    Dependency {
        work_id: String,
        title: String,
        closed: bool,
    },
    /// The item's own condition, with the reason someone recorded.
    Condition {
        condition: WorkCondition,
        reason: Option<String>,
    },
}

#[derive(Debug, Serialize)]
struct RouteBrief {
    kind: crate::orchestrator::RouteKind,
    state: crate::orchestrator::RouteState,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
struct Card {
    #[serde(flatten)]
    summary: WorkSummary,
    research: Option<NamedRef>,
    round: Option<RoundRef>,
    team: Option<NamedRef>,
    executor: Option<ExecutorRef>,
    /// The Thread (or message's Thread) the work came from.
    origin_thread: Option<NamedRef>,
    blockers: Vec<Blocker>,
    /// Whether the researcher can command it here (`native`) or only through its Team.
    operable: &'static str,
    /// The newest delivery state of a dispatch or result about this task.
    delivery: Option<RouteBrief>,
}

/// Resolves the names a card shows, caching per request.
struct Resolver<'a> {
    state: &'a AppState,
    project_id: &'a str,
    research: HashMap<String, Option<NamedRef>>,
    rounds: HashMap<String, Option<RoundRef>>,
    teams: HashMap<String, Option<NamedRef>>,
    sessions: HashMap<String, Option<ExecutorRef>>,
    threads: HashMap<String, Option<NamedRef>>,
}

impl<'a> Resolver<'a> {
    fn new(state: &'a AppState, project_id: &'a str) -> Self {
        Self {
            state,
            project_id,
            research: HashMap::new(),
            rounds: HashMap::new(),
            teams: HashMap::new(),
            sessions: HashMap::new(),
            threads: HashMap::new(),
        }
    }

    fn research(&mut self, id: &str) -> Option<NamedRef> {
        self.research
            .entry(id.to_owned())
            .or_insert_with(|| {
                self.state
                    .research
                    .get(self.project_id, id)
                    .ok()
                    .map(|question| NamedRef {
                        id: question.id,
                        title: question.brief.title,
                    })
            })
            .as_ref()
            .map(|r| NamedRef {
                id: r.id.clone(),
                title: r.title.clone(),
            })
    }

    fn round(&mut self, id: &str) -> Option<RoundRef> {
        self.rounds
            .entry(id.to_owned())
            .or_insert_with(|| {
                self.state
                    .research
                    .round_by_id(self.project_id, id)
                    .ok()
                    .map(|round| RoundRef {
                        id: round.id,
                        number: round.round,
                    })
            })
            .as_ref()
            .map(|r| RoundRef {
                id: r.id.clone(),
                number: r.number,
            })
    }

    fn team(&mut self, id: &str) -> Option<NamedRef> {
        self.teams
            .entry(id.to_owned())
            .or_insert_with(|| {
                self.state
                    .teams
                    .get_team(id)
                    .ok()
                    .filter(|team| team.project_id == self.project_id)
                    .map(|team| NamedRef {
                        id: team.id,
                        title: team.title,
                    })
            })
            .as_ref()
            .map(|r| NamedRef {
                id: r.id.clone(),
                title: r.title.clone(),
            })
    }

    fn session(&mut self, id: &str) -> Option<ExecutorRef> {
        self.sessions
            .entry(id.to_owned())
            .or_insert_with(|| {
                self.state
                    .agent_runtime
                    .store_ref()
                    .visible_conversation(self.project_id, id)
                    .ok()
                    .flatten()
                    .map(|conversation| ExecutorRef {
                        session_id: conversation.id,
                        title: conversation.title,
                        agent_id: Some(conversation.agent_id),
                        available: true,
                    })
                    .or_else(|| {
                        Some(ExecutorRef {
                            session_id: id.to_owned(),
                            title: String::new(),
                            agent_id: None,
                            available: false,
                        })
                    })
            })
            .as_ref()
            .map(|r| ExecutorRef {
                session_id: r.session_id.clone(),
                title: r.title.clone(),
                agent_id: r.agent_id,
                available: r.available,
            })
    }

    fn origin_thread(&mut self, summary: &WorkSummary) -> Option<NamedRef> {
        let derived = summary.item.derived_from.as_ref()?;
        // The Thread filter matches work derived from a Thread, so only that kind
        // is shown as a Thread (the same set under every entry point).
        if derived.kind != "thread" {
            return None;
        }
        let thread_id = derived.id.clone();
        self.threads
            .entry(thread_id.clone())
            .or_insert_with(|| {
                self.state
                    .channels
                    .thread(self.project_id, &thread_id)
                    .ok()
                    .map(|thread| NamedRef {
                        id: thread.id,
                        title: thread.title,
                    })
            })
            .as_ref()
            .map(|r| NamedRef {
                id: r.id.clone(),
                title: r.title.clone(),
            })
    }

    fn card(&mut self, summary: WorkSummary) -> Card {
        let item = &summary.item;
        let research = item.research_id.as_deref().and_then(|id| self.research(id));
        let round = item.round_id.as_deref().and_then(|id| self.round(id));
        let team = item.team_id.as_deref().and_then(|id| self.team(id));
        let executor = summary
            .assignment
            .as_ref()
            .and_then(|assignment| self.session(&assignment.conversation_id));
        let origin_thread = self.origin_thread(&summary);
        let delivery = self
            .state
            .orchestrator
            .routes_for(self.project_id, None, Some(&summary.item.id), 1)
            .ok()
            .and_then(|mut routes| routes.pop())
            .map(|route| RouteBrief {
                kind: route.kind,
                state: route.state,
                last_error: route.last_error,
            });
        let mut blockers: Vec<Blocker> = summary
            .dependency_states
            .iter()
            .filter(|dependency: &&DependencyState| {
                dependency.acceptance != crate::work_store::Acceptance::Accepted
            })
            .map(|dependency| Blocker::Dependency {
                work_id: dependency.id.clone(),
                title: dependency.title.clone(),
                closed: dependency.lifecycle != WorkLifecycle::Active,
            })
            .collect();
        if item.condition != WorkCondition::None {
            blockers.push(Blocker::Condition {
                condition: item.condition,
                reason: item.condition_reason.clone(),
            });
        }
        let operable = if item.origin == WorkOrigin::Native {
            "native"
        } else {
            "legacy_team"
        };
        Card {
            summary,
            research,
            round,
            team,
            executor,
            origin_thread,
            blockers,
            operable,
            delivery,
        }
    }
}

fn check_project(state: &AppState, project_id: &str) -> Result<(), ApiError> {
    state.workspace.project_path(project_id)?;
    Ok(())
}

// -- Board ----------------------------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct BoardQuery {
    research_id: Option<String>,
    round_id: Option<String>,
    team_id: Option<String>,
    /// An Agent (Session) executing the work.
    conversation_id: Option<String>,
    /// A Thread (or message) the work came from.
    thread_id: Option<String>,
    stage: Option<String>,
    condition: Option<String>,
    origin: Option<String>,
    #[serde(default)]
    include_closed: bool,
    limit: Option<usize>,
    #[serde(default)]
    offset: usize,
}

fn filter_of(query: &BoardQuery) -> Result<WorkFilter, ApiError> {
    Ok(WorkFilter {
        research_id: query.research_id.clone(),
        round_id: query.round_id.clone(),
        team_id: query.team_id.clone(),
        conversation_id: query.conversation_id.clone(),
        stage: match query.stage.as_deref() {
            None => None,
            Some(value) => {
                Some(WorkStage::parse(value).ok_or(ApiError::BadRequest("unknown stage"))?)
            }
        },
        condition: match query.condition.as_deref() {
            None => None,
            Some(value) => {
                Some(WorkCondition::parse(value).ok_or(ApiError::BadRequest("unknown condition"))?)
            }
        },
        origin: match query.origin.as_deref() {
            None => None,
            Some(value) => {
                Some(WorkOrigin::parse(value).ok_or(ApiError::BadRequest("unknown origin"))?)
            }
        },
        include_closed: query.include_closed,
        only_closed: false,
        derived_from_id: query.thread_id.clone(),
        limit: Some(query.limit.unwrap_or(BOARD_LIMIT).clamp(1, BOARD_LIMIT)),
        offset: query.offset.min(MAX_OFFSET),
    })
}

#[derive(Debug, Serialize)]
struct StageCount {
    stage: WorkStage,
    count: usize,
}

#[derive(Debug, Serialize)]
struct ConditionCount {
    condition: WorkCondition,
    count: usize,
}

#[derive(Debug, Serialize)]
struct BoardResponse {
    cards: Vec<Card>,
    /// Active work per stage under the same filter (closed work is separate).
    stages: Vec<StageCount>,
    /// Active work that is waiting, blocked, paused, or needs a person.
    conditions: Vec<ConditionCount>,
    total: usize,
    /// There is more matching work than `cards` holds; narrow the filter.
    truncated: bool,
    /// Canceled, abandoned, and superseded work under the same filter.
    closed: Vec<Card>,
    /// More closed work matches than the lane holds.
    closed_truncated: bool,
}

async fn board(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<BoardQuery>,
) -> Result<Json<BoardResponse>, ApiError> {
    check_project(&state, &project_id)?;
    let filter = filter_of(&query)?;
    let active_filter = WorkFilter {
        include_closed: false,
        only_closed: false,
        ..filter.clone()
    };
    let work = std::sync::Arc::clone(&state.work);
    let blocking_state = state.clone();
    let project = project_id.clone();
    let response = tokio::task::spawn_blocking(move || -> Result<BoardResponse, ApiError> {
        let counts: WorkCounts = work.counts(&project, &active_filter)?;
        let summaries = work.list(&project, &active_filter)?;
        // `counts` spans every stage; a stage filter narrows what is shown.
        let total = match active_filter.stage {
            Some(stage) => counts
                .by_stage
                .iter()
                .find(|(candidate, _)| *candidate == stage)
                .map_or(0, |(_, count)| *count),
            None => counts.total,
        };
        let truncated = total > summaries.len().saturating_add(active_filter.offset);
        let mut resolver = Resolver::new(&blocking_state, &project);
        let cards = summaries.into_iter().map(|s| resolver.card(s)).collect();
        let mut conditions = Vec::new();
        for condition in [
            WorkCondition::NeedsInput,
            WorkCondition::Waiting,
            WorkCondition::Blocked,
            WorkCondition::Paused,
        ] {
            let total = work
                .counts(
                    &project,
                    &WorkFilter {
                        condition: Some(condition),
                        stage: None,
                        ..active_filter.clone()
                    },
                )?
                .total;
            conditions.push(ConditionCount {
                condition,
                count: total,
            });
        }
        let (closed, closed_truncated) = if query.include_closed {
            let closed_filter = WorkFilter {
                only_closed: true,
                stage: None,
                condition: None,
                limit: Some(BOARD_LIMIT),
                offset: 0,
                ..filter.clone()
            };
            let closed_total: usize = work.counts(&project, &closed_filter)?.total;
            let cards: Vec<Card> = work
                .list(&project, &closed_filter)?
                .into_iter()
                .map(|s| resolver.card(s))
                .collect();
            let truncated = closed_total > cards.len();
            (cards, truncated)
        } else {
            (Vec::new(), false)
        };
        Ok(BoardResponse {
            cards,
            stages: counts
                .by_stage
                .into_iter()
                .map(|(stage, count)| StageCount { stage, count })
                .collect(),
            conditions,
            total,
            truncated,
            closed_truncated,
            closed,
        })
    })
    .await
    .map_err(|_| ApiError::BadRequest("the board could not be composed"))??;
    Ok(Json(response))
}

// -- Detail ---------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct ExperimentBrief {
    id: String,
    label: String,
    state: crate::experiment_store::ExperimentState,
    analysis: crate::experiment_store::AnalysisState,
    exit_code: Option<i32>,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct Detail {
    #[serde(flatten)]
    card: Card,
    attempts: Vec<Attempt>,
    assignments: Vec<Assignment>,
    results: Vec<ResultRef>,
    reviews: Vec<ReviewRecord>,
    routes: Vec<Route>,
    experiments: Vec<ExperimentBrief>,
}

async fn detail(
    State(state): State<AppState>,
    Path((project_id, work_id)): Path<(String, String)>,
) -> Result<Json<Detail>, ApiError> {
    check_project(&state, &project_id)?;
    let blocking_state = state.clone();
    let detail = tokio::task::spawn_blocking(move || -> Result<Detail, ApiError> {
        let summary = blocking_state.work.summary(&project_id, &work_id)?;
        let experiments = match (&summary.item.research_id, &summary.item.round_id) {
            (Some(research_id), Some(round_id)) => blocking_state
                .experiments
                .experiments(&project_id, research_id, round_id)
                .unwrap_or_default()
                .into_iter()
                .filter(|experiment| experiment.task_id.as_deref() == Some(work_id.as_str()))
                .map(|experiment| ExperimentBrief {
                    id: experiment.id,
                    label: experiment.label,
                    state: experiment.state,
                    analysis: experiment.analysis,
                    exit_code: experiment.exit_code,
                    created_at: experiment.created_at,
                })
                .collect(),
            _ => Vec::new(),
        };
        let attempts = blocking_state.work.attempts(&project_id, &work_id)?;
        let assignments = blocking_state.work.assignments(&project_id, &work_id)?;
        let results = summary.results.clone();
        let reviews = blocking_state.work.reviews(&project_id, &work_id)?;
        let routes =
            blocking_state
                .orchestrator
                .routes_for(&project_id, None, Some(&work_id), 20)?;
        let mut resolver = Resolver::new(&blocking_state, &project_id);
        Ok(Detail {
            card: resolver.card(summary),
            attempts,
            assignments,
            results,
            reviews,
            routes,
            experiments,
        })
    })
    .await
    .map_err(|_| ApiError::BadRequest("the card could not be composed"))??;
    Ok(Json(detail))
}

// -- Create ---------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateRequest {
    title: String,
    #[serde(default)]
    description: String,
    plan: Option<String>,
    /// An approved round the task belongs to; without one it is a candidate
    /// that cannot run until it is attached to a round.
    round_id: Option<String>,
    thread_id: Option<String>,
    client_request_id: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateRequest>,
) -> Result<Response, ApiError> {
    check_project(&state, &project_id)?;
    let blocking_state = state.clone();
    let (card, created) = tokio::task::spawn_blocking(move || -> Result<(Card, bool), ApiError> {
        let (item, created) = blocking_state.work.create(
            &project_id,
            NewWork {
                title: &request.title,
                description: &request.description,
                plan: request.plan.as_deref(),
                round_id: request.round_id.as_deref(),
                derived_from: request.thread_id.as_deref().map(|id| ("thread", id)),
                created_by: Some("researcher"),
                client_request_id: request.client_request_id.as_deref(),
                ..Default::default()
            },
            &Actor::Researcher,
        )?;
        let summary = blocking_state.work.summary(&project_id, &item.id)?;
        Ok((
            Resolver::new(&blocking_state, &project_id).card(summary),
            created,
        ))
    })
    .await
    .map_err(|_| ApiError::BadRequest("the task could not be created"))??;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(card)).into_response())
}

// -- Commands -------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CommandRequest {
    /// The state revision the researcher was looking at; a card that moved on
    /// since is refused with the current one.
    expected_state_revision: u64,
    #[serde(flatten)]
    command: Command,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
    /// Begins an attempt (within the round's limits) and sends it to the executor.
    Start {
        request_key: String,
    },
    Assign {
        session_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    Pause {
        #[serde(default)]
        reason: Option<String>,
    },
    Resume,
    Prioritize {
        priority: i64,
        expected_revision: u64,
    },
    /// Accepts or rejects the work in review.
    Review {
        accept: bool,
        #[serde(default)]
        outcome: Option<String>,
        #[serde(default)]
        reason: Option<String>,
    },
    /// Cancels, abandons, or supersedes it, keeping its history.
    Close {
        lifecycle: String,
        reason: String,
        expected_revision: u64,
        #[serde(default)]
        superseded_by: Option<String>,
    },
}

async fn command(
    State(state): State<AppState>,
    Path((project_id, work_id)): Path<(String, String)>,
    Json(request): Json<CommandRequest>,
) -> Result<Json<Card>, ApiError> {
    check_project(&state, &project_id)?;
    let blocking_state = state.clone();
    let card = tokio::task::spawn_blocking(move || -> Result<Card, ApiError> {
        let actor = Actor::Researcher;
        let ctx = Ctx::expecting(&actor, request.expected_state_revision);
        let work = &blocking_state.work;
        match request.command {
            Command::Start { request_key } => {
                let before = work.summary(&project_id, &work_id)?;
                let attempt = work.begin_attempt(&project_id, &work_id, Some(&request_key), ctx)?;
                let executor = attempt
                    .conversation_id
                    .clone()
                    .ok_or(WorkError::NotAssigned)?;
                blocking_state.orchestrator.route_dispatch(
                    &project_id,
                    &before.item,
                    &attempt.id,
                    &executor,
                )?;
            }
            Command::Assign { session_id, reason } => {
                // Only a standalone, live Session of this Project can execute work:
                // not an archived chat, a Team member, or a subagent thread.
                let usable = blocking_state
                    .agent_runtime
                    .store_ref()
                    .visible_conversation(&project_id, &session_id)
                    .ok()
                    .flatten()
                    .is_some_and(|conversation| {
                        !conversation.archived
                            && !matches!(
                                conversation.relationship,
                                Some(
                                    crate::agent_store::ConversationRelationship::TeamMember
                                        | crate::agent_store::ConversationRelationship::Subagent
                                )
                            )
                    });
                let in_team = blocking_state
                    .teams
                    .team_for_conversation(&session_id)
                    .ok()
                    .flatten()
                    .is_some();
                if !usable || in_team {
                    return Err(ApiError::BadRequest(
                        "choose a standalone Session of this Project",
                    ));
                }
                work.assign(
                    &project_id,
                    &work_id,
                    &session_id,
                    None,
                    reason.as_deref().unwrap_or_default(),
                    ctx,
                )?;
            }
            Command::Pause { reason } => {
                // Pausing would erase a flag someone else raised (needs input,
                // blocked, waiting) when it is resumed.
                let current = work.get(&project_id, &work_id)?;
                if !matches!(
                    current.condition,
                    WorkCondition::None | WorkCondition::Paused
                ) {
                    return Err(ApiError::ConditionInUse);
                }
                work.set_condition(
                    &project_id,
                    &work_id,
                    WorkCondition::Paused,
                    reason.as_deref(),
                    ctx,
                )?;
            }
            Command::Resume => {
                work.set_condition(&project_id, &work_id, WorkCondition::None, None, ctx)?;
            }
            Command::Prioritize {
                priority,
                expected_revision,
            } => {
                work.update_plan(
                    &project_id,
                    &work_id,
                    expected_revision,
                    PlanPatch {
                        priority: Some(priority),
                        ..Default::default()
                    },
                    ctx,
                )?;
            }
            Command::Review {
                accept,
                outcome,
                reason,
            } => {
                let outcome = match outcome.as_deref() {
                    None => WorkOutcome::Unknown,
                    Some(value) => {
                        WorkOutcome::parse(value).ok_or(ApiError::BadRequest("unknown outcome"))?
                    }
                };
                work.review(
                    &project_id,
                    &work_id,
                    ReviewInput {
                        accept,
                        outcome,
                        reason: reason.as_deref(),
                    },
                    ctx,
                )?;
            }
            Command::Close {
                lifecycle,
                reason,
                expected_revision,
                superseded_by,
            } => {
                let lifecycle = WorkLifecycle::parse(&lifecycle)
                    .ok_or(ApiError::BadRequest("unknown lifecycle"))?;
                work.close(
                    &project_id,
                    &work_id,
                    expected_revision,
                    Closure {
                        lifecycle,
                        reason: &reason,
                        superseded_by: superseded_by.as_deref(),
                    },
                    ctx,
                )?;
            }
        }
        let summary = work.summary(&project_id, &work_id)?;
        Ok(Resolver::new(&blocking_state, &project_id).card(summary))
    })
    .await
    .map_err(|_| ApiError::BadRequest("the command could not be run"))??;
    Ok(Json(card))
}
