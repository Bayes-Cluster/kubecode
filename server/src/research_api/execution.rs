//! Read and control routes for a round's execution (ADR 0213). The browser
//! is the researcher: it sets and revises the envelope, pauses or resumes
//! future launches, and reconciles an experiment whose fate is unknown. It
//! never launches or authors Agent decisions here.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::{ResearchApiError, check_project};
use crate::app_state::AppState;
use crate::experiment_runner::{LogStream, LogTail, RunnerError};
use crate::experiment_store::{
    Envelope, EnvelopeLimits, EnvelopeState, Experiment, ExperimentError, ExperimentWait,
    NewLaunch, ReconcileTruth,
};
use crate::research_store::{SourceAvailability, SourceRef};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/research/{research_id}/rounds/{round_id}/execution",
            get(get_execution),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/rounds/{round_id}/execution/envelope",
            put(set_envelope),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/rounds/{round_id}/execution/pause",
            post(pause),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/rounds/{round_id}/execution/resume",
            post(resume),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/rounds/{round_id}/execution/experiments",
            post(launch),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/rounds/{round_id}/execution/cancel",
            post(cancel_round),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/experiments/{experiment_id}/cancel",
            post(cancel),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/experiments/{experiment_id}/logs",
            get(logs),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/experiments/{experiment_id}/reconcile",
            post(reconcile),
        )
}

/// An experiment with its declared artifacts re-resolved against the files
/// as they are now: a missing or modified artifact is reported, never assumed.
#[derive(Debug, Serialize)]
pub(crate) struct ExperimentView {
    #[serde(flatten)]
    experiment: Experiment,
    artifact_state: Vec<ArtifactStateView>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ArtifactStateView {
    path: String,
    revision: Option<String>,
    availability: SourceAvailability,
}

pub(crate) fn experiment_view(state: &AppState, experiment: Experiment) -> ExperimentView {
    let artifact_state = experiment
        .artifact_revisions
        .iter()
        .map(|artifact| {
            let current = state
                .workspace
                .file_revision(&experiment.project_id, &artifact.path)
                .ok();
            let availability = match (&artifact.revision, current) {
                // The file did not exist when the process ended.
                (None, None) => SourceAvailability::Removed,
                (None, Some(_)) => SourceAvailability::Changed,
                (Some(_), None) => SourceAvailability::Removed,
                (Some(recorded), Some(now)) if *recorded == now => SourceAvailability::Available,
                (Some(_), Some(_)) => SourceAvailability::Changed,
            };
            ArtifactStateView {
                path: artifact.path.clone(),
                revision: artifact.revision.clone(),
                availability,
            }
        })
        .collect();
    ExperimentView {
        experiment,
        artifact_state,
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ExecutionView {
    envelope: Option<Envelope>,
    experiments: Vec<ExperimentView>,
    waits: Vec<ExperimentWait>,
    /// Server time (unix seconds), so deadlines render consistently.
    now: i64,
}

pub(crate) fn execution_view(
    state: &AppState,
    project_id: &str,
    research_id: &str,
    round_id: &str,
) -> Result<ExecutionView, ResearchApiError> {
    Ok(ExecutionView {
        envelope: state
            .experiments
            .envelope(project_id, research_id, round_id)?,
        experiments: state
            .experiments
            .experiments(project_id, research_id, round_id)?
            .into_iter()
            .map(|experiment| experiment_view(state, experiment))
            .collect(),
        waits: state.experiments.waits(project_id, research_id, round_id)?,
        now: state.experiments.now(),
    })
}

async fn get_execution(
    State(state): State<AppState>,
    Path((project_id, research_id, round_id)): Path<(String, String, String)>,
) -> Result<Json<ExecutionView>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(execution_view(
        &state,
        &project_id,
        &research_id,
        &round_id,
    )?))
}

#[derive(Debug, Deserialize)]
struct SetEnvelopeRequest {
    /// The revision the researcher saw; omitted when creating the first.
    expected_revision: Option<u64>,
    limits: EnvelopeLimits,
}

async fn set_envelope(
    State(state): State<AppState>,
    Path((project_id, research_id, round_id)): Path<(String, String, String)>,
    Json(request): Json<SetEnvelopeRequest>,
) -> Result<Json<Envelope>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.experiments.set_envelope(
        &project_id,
        &research_id,
        &round_id,
        request.expected_revision,
        request.limits,
        Some("researcher"),
    )?))
}

async fn pause(
    State(state): State<AppState>,
    Path((project_id, research_id, round_id)): Path<(String, String, String)>,
) -> Result<Json<Envelope>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.experiments.set_envelope_state(
        &project_id,
        &research_id,
        &round_id,
        EnvelopeState::Paused,
    )?))
}

async fn resume(
    State(state): State<AppState>,
    Path((project_id, research_id, round_id)): Path<(String, String, String)>,
) -> Result<Json<Envelope>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.experiments.set_envelope_state(
        &project_id,
        &research_id,
        &round_id,
        EnvelopeState::Active,
    )?))
}

#[derive(Debug, Deserialize)]
struct ReconcileRequest {
    truth: ReconcileTruth,
    exit_code: Option<i32>,
}

async fn reconcile(
    State(state): State<AppState>,
    Path((project_id, research_id, experiment_id)): Path<(String, String, String)>,
    Json(request): Json<ReconcileRequest>,
) -> Result<Json<ExperimentView>, ResearchApiError> {
    check_project(&state, &project_id)?;
    // Confirm the question first so an unknown id never reveals whether an
    // experiment exists elsewhere.
    state.research.get(&project_id, &research_id)?;
    let experiment = state.experiments.experiment(&project_id, &experiment_id)?;
    if experiment.research_id != research_id {
        return Err(crate::experiment_store::ExperimentError::NotFound.into());
    }
    Ok(Json(experiment_view(
        &state,
        state.experiments.reconcile(
            &project_id,
            &experiment_id,
            request.truth,
            request.exit_code,
            "researcher",
        )?,
    )))
}

fn runner_error(error: RunnerError) -> ResearchApiError {
    match error {
        RunnerError::Experiment(error) => error.into(),
        // A path that is not allowed is a bad request, not a server fault.
        RunnerError::Workspace(_) => {
            ExperimentError::Invalid("the working directory is not allowed").into()
        }
        RunnerError::Team(_) => ExperimentError::NotFound.into(),
        RunnerError::Spawn(_) => ExperimentError::State("the process could not be started").into(),
    }
}

#[derive(Debug, Deserialize)]
struct LaunchRequest {
    /// Retry key: repeating it returns the same attempt.
    launch_key: String,
    argv: Vec<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    artifacts: Vec<String>,
    #[serde(default)]
    sources: Vec<SourceRef>,
    max_runtime_secs: Option<u32>,
}

/// The researcher's own launch, subject to the same envelope as an Agent's.
async fn launch(
    State(state): State<AppState>,
    Path((project_id, research_id, round_id)): Path<(String, String, String)>,
    Json(request): Json<LaunchRequest>,
) -> Result<Response, ResearchApiError> {
    check_project(&state, &project_id)?;
    let round = state.research.round(&project_id, &research_id, &round_id)?;
    let owner = round
        .team_id
        .as_deref()
        .and_then(|team_id| state.teams.get_team(team_id).ok())
        .map(|team| team.leader_member_id);
    let experiment = state
        .experiment_runner
        .launch(
            &project_id,
            &research_id,
            NewLaunch {
                round_id,
                launch_key: request.launch_key,
                team_id: round.team_id,
                task_id: None,
                owner_member_id: owner,
                label: request.label,
                argv: request.argv,
                cwd: request.cwd,
                artifacts: request.artifacts,
                sources: request.sources,
                max_runtime_secs: request.max_runtime_secs,
            },
        )
        .map_err(runner_error)?;
    Ok((StatusCode::OK, Json(experiment_view(&state, experiment))).into_response())
}

async fn cancel(
    State(state): State<AppState>,
    Path((project_id, research_id, experiment_id)): Path<(String, String, String)>,
) -> Result<Json<ExperimentView>, ResearchApiError> {
    check_project(&state, &project_id)?;
    state.research.get(&project_id, &research_id)?;
    let experiment = state.experiments.experiment(&project_id, &experiment_id)?;
    if experiment.research_id != research_id {
        return Err(ExperimentError::NotFound.into());
    }
    let experiment = state
        .experiment_runner
        .cancel(&project_id, &experiment_id)
        .map_err(runner_error)?;
    Ok(Json(experiment_view(&state, experiment)))
}

#[derive(Debug, Serialize)]
struct CancelRoundResponse {
    cancelled: usize,
    envelope: Envelope,
}

/// Terminates the round's running processes and closes its envelope. Unlike
/// pause, this ends the round's authority to run anything.
async fn cancel_round(
    State(state): State<AppState>,
    Path((project_id, research_id, round_id)): Path<(String, String, String)>,
) -> Result<Json<CancelRoundResponse>, ResearchApiError> {
    check_project(&state, &project_id)?;
    // Close first so nothing new is admitted while processes are stopped.
    let envelope = state.experiments.set_envelope_state(
        &project_id,
        &research_id,
        &round_id,
        EnvelopeState::Closed,
    )?;
    let cancelled = state
        .experiment_runner
        .cancel_round(&project_id, &research_id, &round_id)
        .map_err(runner_error)?;
    Ok(Json(CancelRoundResponse {
        cancelled,
        envelope,
    }))
}

#[derive(Debug, Deserialize)]
struct LogQuery {
    stream: Option<String>,
    tail: Option<u64>,
}

async fn logs(
    State(state): State<AppState>,
    Path((project_id, research_id, experiment_id)): Path<(String, String, String)>,
    Query(query): Query<LogQuery>,
) -> Result<Json<LogTail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    state.research.get(&project_id, &research_id)?;
    let experiment = state.experiments.experiment(&project_id, &experiment_id)?;
    if experiment.research_id != research_id {
        return Err(ExperimentError::NotFound.into());
    }
    let stream = match query.stream.as_deref() {
        Some("stderr") => LogStream::Stderr,
        _ => LogStream::Stdout,
    };
    Ok(Json(
        state
            .experiment_runner
            .read_log(
                &project_id,
                &experiment_id,
                stream,
                query
                    .tail
                    .unwrap_or(crate::experiment_runner::MAX_LOG_TAIL_BYTES),
            )
            .map_err(runner_error)?,
    ))
}
