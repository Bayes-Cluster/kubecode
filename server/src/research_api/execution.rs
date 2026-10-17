//! Read and control routes for a round's execution (ADR 0213). The browser
//! is the researcher: it sets and revises the envelope, pauses or resumes
//! future launches, and reconciles an experiment whose fate is unknown. It
//! never launches or authors Agent decisions here.

use axum::extract::{Path, State};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::{ResearchApiError, check_project};
use crate::app_state::AppState;
use crate::experiment_store::{
    Envelope, EnvelopeLimits, EnvelopeState, Experiment, ExperimentWait, ReconcileTruth,
};

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
            "/projects/{project_id}/research/{research_id}/experiments/{experiment_id}/reconcile",
            post(reconcile),
        )
}

#[derive(Debug, Serialize)]
pub(crate) struct ExecutionView {
    envelope: Option<Envelope>,
    experiments: Vec<Experiment>,
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
            .experiments(project_id, research_id, round_id)?,
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
) -> Result<Json<Experiment>, ResearchApiError> {
    check_project(&state, &project_id)?;
    // Confirm the question first so an unknown id never reveals whether an
    // experiment exists elsewhere.
    state.research.get(&project_id, &research_id)?;
    let experiment = state.experiments.experiment(&project_id, &experiment_id)?;
    if experiment.research_id != research_id {
        return Err(crate::experiment_store::ExperimentError::NotFound.into());
    }
    Ok(Json(state.experiments.reconcile(
        &project_id,
        &experiment_id,
        request.truth,
        request.exit_code,
        "researcher",
    )?))
}
