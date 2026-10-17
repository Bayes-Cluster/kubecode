//! Findings, outcome capture, and proposal review (ADR 0212 §7, issue #151).
//! The browser is the researcher here too: it can capture outcomes from
//! linked work, decline a Team's pending outcome, and decide proposals. It
//! cannot author Agent claims; those arrive only through the Team MCP tool,
//! which verifies the producing Team.

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::rounds::{invalid, resolver, validate_source};
use super::{ResearchApiError, check_project};
use crate::app_state::AppState;
use crate::research_store::{
    AuthorKind, Finding, LinkKind, NewFinding, NewPublication, PendingOutcome, Producer,
    ProposalView, PublishOutcome, ResearchError, ReviewDecision, SourceAvailability, SourceKind,
    SourceRef,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/research/{research_id}/findings",
            get(list_findings).post(capture_findings),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/outcomes",
            get(list_outcomes),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/outcomes/{team_id}/decline",
            post(decline_outcome),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/proposals",
            get(list_proposals),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/proposals/{entry_id}/review",
            post(review_proposal),
        )
}

/// A source reference with its current state. A removed Session or a
/// changed file is reported as such, never silently still "evidence".
#[derive(Debug, Serialize)]
pub(crate) struct EvidenceView {
    #[serde(flatten)]
    pub source: SourceRef,
    pub availability: SourceAvailability,
}

#[derive(Debug, Serialize)]
pub(crate) struct FindingView {
    #[serde(flatten)]
    pub finding: Finding,
    pub evidence_state: Vec<EvidenceView>,
    pub producer_state: Vec<EvidenceView>,
    /// The brief has moved on since the producing round consumed it.
    pub stale: bool,
}

pub(crate) fn finding_views(
    state: &AppState,
    project_id: &str,
    findings: Vec<Finding>,
    current_revision: u64,
) -> Vec<FindingView> {
    let resolver = resolver(state);
    let view = |source: SourceRef| EvidenceView {
        availability: resolver.resolve(project_id, &source),
        source,
    };
    findings
        .into_iter()
        .map(|finding| {
            let producer = [
                (SourceKind::Session, &finding.producer.session_id),
                (SourceKind::Team, &finding.producer.team_id),
                (SourceKind::TeamTask, &finding.producer.task_id),
                (SourceKind::Run, &finding.producer.run_id),
            ]
            .into_iter()
            .filter_map(|(kind, id)| {
                id.as_ref().map(|id| {
                    view(SourceRef {
                        kind,
                        id: id.clone(),
                        revision: None,
                    })
                })
            })
            .collect();
            FindingView {
                evidence_state: finding.evidence.iter().cloned().map(view).collect(),
                producer_state: producer,
                stale: finding.brief_revision < current_revision,
                finding,
            }
        })
        .collect()
}

async fn list_findings(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<Vec<FindingView>>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state.research.get(&project_id, &research_id)?;
    let findings = state.research.findings(&project_id, &research_id)?;
    Ok(Json(finding_views(
        &state,
        &project_id,
        findings,
        question.revision,
    )))
}

#[derive(Debug, Deserialize)]
struct CaptureRequest {
    /// Retry key: repeating it returns the stored result.
    publication_key: String,
    /// The linked Session or Team the outcome came from. At least one.
    session_id: Option<String>,
    team_id: Option<String>,
    round_id: Option<String>,
    findings: Vec<NewFinding>,
}

#[derive(Debug, Serialize)]
struct CaptureResponse {
    created: bool,
    findings: Vec<FindingView>,
}

/// The explicit capture path for linked work: the researcher records what a
/// Session or Team produced. The record is attributed to the researcher and
/// cites the producing execution, so the origin stays traceable.
async fn capture_findings(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Json(request): Json<CaptureRequest>,
) -> Result<Json<CaptureResponse>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state.research.get(&project_id, &research_id)?;
    if request.session_id.is_none() && request.team_id.is_none() {
        return Err(invalid(
            "name the linked Session or Team the outcome came from",
        ));
    }
    for (kind, id) in [
        (LinkKind::Session, &request.session_id),
        (LinkKind::Team, &request.team_id),
    ] {
        if let Some(id) = id
            && !linked_to(&state, kind, id, &project_id, &research_id)
        {
            return Err(ResearchError::InvalidLinkTarget.into());
        }
    }
    let round_id = match (&request.round_id, &request.team_id) {
        (Some(round), _) => Some(round.clone()),
        (None, Some(team)) => state
            .research
            .round_for_team(team)?
            .map(|(_, round)| round.id),
        _ => None,
    };
    // A retry of a stored batch is answered from the record: its evidence
    // may have been removed since, which must not turn the retry into an error.
    let replay =
        state
            .research
            .has_publication(&project_id, &research_id, &request.publication_key)?;
    let findings = request
        .findings
        .into_iter()
        .map(|mut finding| {
            if !replay {
                finding.evidence = finding
                    .evidence
                    .iter()
                    .map(|source| validate_source(&state, &project_id, source))
                    .collect::<Result<_, _>>()?;
            }
            Ok(finding)
        })
        .collect::<Result<Vec<_>, ResearchApiError>>()?;
    let outcome = state.research.publish(
        &project_id,
        &research_id,
        NewPublication {
            key: request.publication_key,
            author_kind: AuthorKind::Researcher,
            author_ref: None,
            producer: Producer {
                session_id: request.session_id,
                team_id: request.team_id,
                ..Producer::default()
            },
            round_id,
            findings,
            proposals: Vec::new(),
        },
    )?;
    Ok(Json(capture_response(
        &state,
        &project_id,
        question.revision,
        outcome,
    )))
}

fn capture_response(
    state: &AppState,
    project_id: &str,
    current_revision: u64,
    outcome: PublishOutcome,
) -> CaptureResponse {
    CaptureResponse {
        created: outcome.created,
        findings: finding_views(state, project_id, outcome.findings, current_revision),
    }
}

fn linked_to(
    state: &AppState,
    kind: LinkKind,
    ref_id: &str,
    project_id: &str,
    research_id: &str,
) -> bool {
    matches!(
        state.research.link_for(kind, ref_id),
        Ok(Some((project, link))) if project == project_id && link.research_id == research_id
    )
}

async fn list_outcomes(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<Vec<PendingOutcome>>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.research.outcomes(&project_id, &research_id)?))
}

async fn decline_outcome(
    State(state): State<AppState>,
    Path((project_id, research_id, team_id)): Path<(String, String, String)>,
) -> Result<Json<PendingOutcome>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.research.decline_outcome(
        &project_id,
        &research_id,
        &team_id,
    )?))
}

async fn list_proposals(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<Vec<ProposalView>>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.research.proposals(&project_id, &research_id)?))
}

#[derive(Debug, Deserialize)]
struct ReviewRequest {
    decision: ReviewDecision,
    note: Option<String>,
}

async fn review_proposal(
    State(state): State<AppState>,
    Path((project_id, research_id, entry_id)): Path<(String, String, String)>,
    Json(request): Json<ReviewRequest>,
) -> Result<Json<ProposalView>, ResearchApiError> {
    check_project(&state, &project_id)?;
    Ok(Json(state.research.review_proposal(
        &project_id,
        &research_id,
        &entry_id,
        request.decision,
        request.note.as_deref(),
    )?))
}
