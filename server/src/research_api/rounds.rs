//! Research rounds (ADR 0212 §6, issue #150): an explicit, resumable request
//! to do work for a question, with the exact brief revision pinned.
//!
//! A round is validated in full *before* anything is created, then driven
//! through durable phases. Each phase is recorded before the next side
//! effect and every step is idempotent, so a retry, a reconnect, or a restart
//! resumes rather than creating a second Team or run:
//!
//! - Team: Leader Session ready → Team created (a Session belongs to at most
//!   one Team, so a crashed attempt's Team is found again) → Team started.
//! - Solo: Session ready → prompt admitted under the stable client message id
//!   `research:{round}` (admission already de-duplicates on it) → started.
//!
//! Starting reuses the Team setup validation, allowed Agents, limits, native
//! permission handling, and human-input behavior of a manually started Team;
//! the Leader keeps task decomposition and team formation.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::agent_runtime::StartAgentRun;
use crate::agents::AgentId;
use crate::app_state::AppState;
use crate::research_store::{
    BriefRevision, LinkKind, MAX_INSTRUCTION_CHARS, MAX_ROUND_SOURCES, NewRound, ResearchError,
    ResearchRound, RoundKind, RoundPhase, SourceAvailability, SourceRef,
};
use crate::team_api::{
    StartTeamRequest, check_allowed_agents, promote_conversation_core, start_team_core,
};
use crate::teams::{TeamMode, TeamStatus, TeamWorkspace};

use super::sources::{SourceError, SourceResolver};
use super::{ResearchApiError, check_project};

const DEFAULT_LEADER_NAME: &str = "Lead";
const DEFAULT_ALLOWED_AGENTS: [&str; 3] = ["claude_code", "codex", "opencode"];
const MAX_TEAMMATES: u8 = 8;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/research/{research_id}/rounds",
            get(list_rounds).post(start_round),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/rounds/{round_id}",
            get(get_round),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/rounds/{round_id}/resume",
            post(resume_round),
        )
}

/// Serializes setup work per round, so a retry racing the original request
/// (or a resume racing a start) cannot run the same step twice.
#[derive(Default)]
pub struct KeyedLocks {
    inner: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl KeyedLocks {
    fn lock_for(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut inner = self.inner.lock().expect("round lock map poisoned");
        // Locks nobody holds or waits on are dropped, bounding the map.
        inner.retain(|_, lock| Arc::strong_count(lock) > 1);
        Arc::clone(inner.entry(key.to_owned()).or_default())
    }
}

// -- Requests and the stored, authorized setup -------------------------------------------

#[derive(Debug, Deserialize)]
struct StartRoundRequest {
    /// Required idempotency key: a retry with the same key and request
    /// resumes the same round.
    client_request_id: String,
    /// The brief revision the researcher is looking at.
    expected_revision: u64,
    mode: RoundKind,
    /// An existing Session to continue in (discussion Session, or a Solo
    /// Session). Without it a new Session is created for `agent_id`.
    session_id: Option<String>,
    agent_id: Option<AgentId>,
    title: Option<String>,
    instruction: Option<String>,
    #[serde(default)]
    sources: Vec<SourceRef>,
    // Team setup (ignored for Solo).
    leader_name: Option<String>,
    workspace: Option<TeamWorkspace>,
    acceptance_criteria: Option<Vec<String>>,
    allowed_agent_ids: Option<Vec<String>>,
    team_mode: Option<TeamMode>,
    max_teammates: Option<u8>,
    max_parallel_runs: Option<u8>,
    max_review_rounds: Option<u8>,
}

/// The setup exactly as authorized, with defaults resolved so that a replay
/// of the same request compares equal.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct StoredRequest {
    /// Digest of the request as the client sent it (before defaults are
    /// resolved), so a replay is recognized even if a default has since moved.
    #[serde(default)]
    fingerprint: String,
    session_id: Option<String>,
    agent_id: Option<AgentId>,
    title: Option<String>,
    instruction: String,
    leader_name: Option<String>,
    workspace: Option<TeamWorkspace>,
    acceptance_criteria: Vec<String>,
    allowed_agent_ids: Vec<String>,
    team_mode: TeamMode,
    max_teammates: u8,
    max_parallel_runs: u8,
    max_review_rounds: u8,
}

pub(super) fn invalid(message: &'static str) -> ResearchApiError {
    ResearchError::Invalid(message).into()
}

// -- Sources ---------------------------------------------------------------------------------------------

pub(super) fn resolver(state: &AppState) -> SourceResolver<'_> {
    SourceResolver {
        agents: state.agent_runtime.store_ref(),
        teams: &state.teams,
        workspace: &state.workspace,
    }
}

pub(super) fn validate_source(
    state: &AppState,
    project_id: &str,
    source: &SourceRef,
) -> Result<SourceRef, ResearchApiError> {
    resolver(state)
        .validate(project_id, source)
        .map_err(|error| match error {
            SourceError::Invalid => invalid("a source reference is invalid"),
            SourceError::Missing => {
                invalid("a source reference could not be found in this Project")
            }
        })
}

/// A digest of the request as sent. `expected_revision` is excluded: it
/// guards creation and says nothing about what the round does.
fn fingerprint(request: &StartRoundRequest) -> String {
    let canonical = serde_json::json!({
        "mode": request.mode.as_str(),
        "session_id": request.session_id,
        "agent_id": request.agent_id,
        "title": request.title,
        "instruction": request.instruction,
        "sources": request
            .sources
            .iter()
            .map(|source| (source.kind.as_str(), &source.id))
            .collect::<Vec<_>>(),
        "leader_name": request.leader_name,
        "workspace": request.workspace,
        "acceptance_criteria": request.acceptance_criteria,
        "allowed_agent_ids": request.allowed_agent_ids,
        "team_mode": request.team_mode,
        "max_teammates": request.max_teammates,
        "max_parallel_runs": request.max_parallel_runs,
        "max_review_rounds": request.max_review_rounds,
    });
    hex::encode(<sha2::Sha256 as sha2::Digest>::digest(
        canonical.to_string().as_bytes(),
    ))
}

// -- Pre-flight ---------------------------------------------------------------------------------------

/// Resolves defaults and validates the whole request before anything is
/// created, so a bad request leaves no Session, Team, or round behind.
fn preflight(
    state: &AppState,
    project_id: &str,
    research_id: &str,
    request: &StartRoundRequest,
    default_criteria: &[String],
) -> Result<(StoredRequest, Vec<SourceRef>), ResearchApiError> {
    let instruction = request
        .instruction
        .clone()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if instruction.chars().count() > MAX_INSTRUCTION_CHARS {
        return Err(invalid("the instruction is too long"));
    }
    if request.sources.len() > MAX_ROUND_SOURCES {
        return Err(invalid("too many sources"));
    }
    let mut sources: Vec<SourceRef> = Vec::new();
    for source in &request.sources {
        let validated = validate_source(state, project_id, source)?;
        if !sources
            .iter()
            .any(|seen| seen.kind == validated.kind && seen.id == validated.id)
        {
            sources.push(validated);
        }
    }
    let store = state.agent_runtime.store();
    let session = match request.session_id.as_deref() {
        Some(session_id) => {
            let conversation = store
                .get_conversation(session_id)
                .map_err(|_| invalid("the Session could not be found in this Project"))?;
            if conversation.project_id != project_id {
                return Err(invalid("the Session could not be found in this Project"));
            }
            if conversation.read_only
                || state
                    .teams
                    .member_for_conversation(session_id)
                    .ok()
                    .flatten()
                    .is_some()
            {
                return Err(invalid("the Session cannot be used for a research round"));
            }
            // A Session linked to another question is never silently taken.
            if let Some((_, link)) = state.research.link_for(LinkKind::Session, session_id)?
                && link.research_id != research_id
            {
                return Err(ResearchError::LinkConflict { kind: "session" }.into());
            }
            Some(conversation)
        }
        None => None,
    };
    if session.is_none() && request.agent_id.is_none() {
        return Err(invalid("choose a Session or an Agent"));
    }
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned);
    let stored = match request.mode {
        RoundKind::Solo => StoredRequest {
            fingerprint: fingerprint(request),
            session_id: request.session_id.clone(),
            agent_id: request.agent_id,
            title,
            instruction,
            leader_name: None,
            workspace: None,
            acceptance_criteria: Vec::new(),
            allowed_agent_ids: Vec::new(),
            team_mode: TeamMode::Standard,
            max_teammates: 0,
            max_parallel_runs: 0,
            max_review_rounds: 0,
        },
        RoundKind::Team => {
            let acceptance_criteria: Vec<String> = request
                .acceptance_criteria
                .clone()
                .unwrap_or_else(|| default_criteria.to_vec())
                .into_iter()
                .map(|criterion| criterion.trim().to_owned())
                .filter(|criterion| !criterion.is_empty())
                .collect();
            if acceptance_criteria.is_empty() {
                return Err(invalid(
                    "at least one acceptance criterion is required; add evaluation criteria to the brief",
                ));
            }
            let allowed_agent_ids = request.allowed_agent_ids.clone().unwrap_or_else(|| {
                DEFAULT_ALLOWED_AGENTS
                    .iter()
                    .map(|id| (*id).to_owned())
                    .collect()
            });
            if allowed_agent_ids.is_empty() {
                return Err(invalid("at least one allowed Agent is required"));
            }
            if allowed_agent_ids
                .iter()
                .any(|agent_id| agent_id.parse::<AgentId>().is_err())
            {
                return Err(invalid("an allowed Agent is not a supported Agent"));
            }
            check_allowed_agents(state, &allowed_agent_ids)?;
            let max_teammates = request.max_teammates.unwrap_or(3);
            let max_parallel_runs = request.max_parallel_runs.unwrap_or(max_teammates.min(3));
            let max_review_rounds = request.max_review_rounds.unwrap_or(3);
            if !(1..=MAX_TEAMMATES).contains(&max_teammates)
                || !(1..=max_teammates).contains(&max_parallel_runs)
                || !(1..=10).contains(&max_review_rounds)
            {
                return Err(invalid("the Team limits are out of range"));
            }
            StoredRequest {
                fingerprint: fingerprint(request),
                session_id: request.session_id.clone(),
                agent_id: request.agent_id,
                title,
                instruction,
                leader_name: Some(
                    request
                        .leader_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .unwrap_or(DEFAULT_LEADER_NAME)
                        .to_owned(),
                ),
                // Left to the promotion path, which follows the Session's own mode.
                workspace: request.workspace,
                acceptance_criteria,
                allowed_agent_ids,
                team_mode: request.team_mode.unwrap_or_default(),
                max_teammates,
                max_parallel_runs,
                max_review_rounds,
            }
        }
    };
    Ok((stored, sources))
}

// -- Orchestration -------------------------------------------------------------------------------------

/// The pinned brief rendered as bounded text for a Solo prompt. The text is
/// fixed at admission, so a later brief edit cannot rewrite queued work.
fn render_context(round: &ResearchRound, brief: &BriefRevision, instruction: &str) -> String {
    let mut text = format!(
        "Research round {} — \"{}\" (brief revision {})\n\nQuestion: {}\n",
        round.round, brief.brief.title, brief.revision, brief.brief.question
    );
    if !brief.brief.motivation.is_empty() {
        text.push_str(&format!("\nMotivation: {}\n", brief.brief.motivation));
    }
    for (heading, items) in [
        ("Hypotheses", &brief.brief.hypotheses),
        ("Constraints", &brief.brief.constraints),
        ("Evaluation criteria", &brief.brief.evaluation_criteria),
    ] {
        if !items.is_empty() {
            text.push_str(&format!("\n{heading}:\n"));
            for item in items {
                text.push_str(&format!("- {item}\n"));
            }
        }
    }
    if !round.sources.is_empty() {
        text.push_str("\nSources to consult:\n");
        for source in &round.sources {
            text.push_str(&format!("- {} {}\n", source.kind.as_str(), source.id));
        }
    }
    text.push_str("\nResearcher's instruction:\n");
    text.push_str(if instruction.is_empty() {
        "Work toward answering the research question."
    } else {
        instruction
    });
    text
}

fn team_goal(round: &ResearchRound, brief: &BriefRevision, instruction: &str) -> String {
    let lead = if instruction.is_empty() {
        "Work toward answering the research question."
    } else {
        instruction
    };
    format!(
        "{lead}\n\nResearch round {} of \"{}\" — brief revision {}. Call team_get_context for the pinned research brief and source references.",
        round.round, brief.brief.title, brief.revision
    )
}

/// Advances a round through its remaining phases. Safe to call repeatedly
/// and concurrently (serialized per round); a failure leaves the round at its
/// last durable phase so `resume` continues from there.
async fn drive_round(
    state: &AppState,
    project_id: &str,
    research_id: &str,
    round_id: &str,
) -> Result<ResearchRound, ResearchApiError> {
    let lock = state.research_locks.lock_for(round_id);
    let _serialized = lock.lock().await;
    let mut round = state.research.round(project_id, research_id, round_id)?;
    if round.phase == RoundPhase::Started {
        return Ok(round);
    }
    // Archiving freezes the question: an unfinished round does not start
    // work on it until it is restored.
    if state.research.get(project_id, research_id)?.archived {
        return Err(ResearchError::Archived.into());
    }
    let request: StoredRequest = serde_json::from_value(round.request.clone())
        .map_err(|_| invalid("the stored round request is unreadable"))?;
    // Two rounds on one existing Session must not interleave their setup;
    // the round lock alone is per round.
    let session_lock = request
        .session_id
        .as_deref()
        .map(|id| state.research_locks.lock_for(&format!("session:{id}")));
    let _session_serialized = match &session_lock {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };
    let brief = state
        .research
        .revision(project_id, research_id, round.brief_revision)?;
    let store = state.agent_runtime.store();

    // Phase 1: the Leader / Solo Session exists.
    let mut created_here = false;
    if round.phase == RoundPhase::Created {
        let session_id = match &request.session_id {
            Some(existing) => existing.clone(),
            None => {
                let agent_id = request
                    .agent_id
                    .ok_or_else(|| invalid("choose a Session or an Agent"))?;
                let title = request
                    .title
                    .clone()
                    .or_else(|| Some(format!("Round {}: {}", round.round, brief.brief.title)));
                let conversation =
                    store.create_conversation(project_id, agent_id, title.as_deref())?;
                created_here = true;
                // A Solo Session is initialized now; a Team Leader is
                // initialized as part of promotion.
                if round.kind == RoundKind::Solo
                    && state.agents.is_available(agent_id)
                    && let Err(error) = state
                        .agent_runtime
                        .initialize_conversation(&conversation.id)
                        .await
                {
                    let _ = store.delete_conversation(&conversation.id);
                    return Err(error.into());
                }
                conversation.id
            }
        };
        round =
            match state
                .research
                .round_set_session(project_id, research_id, round_id, &session_id)
            {
                Ok(round) => round,
                Err(error) => {
                    if created_here {
                        let _ = store.delete_conversation(&session_id);
                    }
                    return Err(error.into());
                }
            };
    }
    let session_id = round
        .session_id
        .clone()
        .ok_or_else(|| invalid("the round has no Session"))?;
    let fresh = request.session_id.is_none();

    match round.kind {
        RoundKind::Solo => {
            // Phase 2: admit the pinned context. The client message id makes
            // admission idempotent across retries and restarts.
            // A resume after a crash finds the run the first attempt
            // created; handing it to the actor again could send the prompt
            // twice, so only a missing run is admitted.
            let client_message_id = format!("research:{round_id}");
            if store
                .run_by_client_message_id(&client_message_id)?
                .is_none()
            {
                let conversation = store.get_conversation(&session_id)?;
                state.agent_runtime.start_or_queue(StartAgentRun {
                    conversation_id: conversation.id.clone(),
                    project_id: project_id.to_owned(),
                    message: render_context(&round, &brief, &request.instruction),
                    client_message_id: Some(client_message_id),
                })?;
            }
        }
        RoundKind::Team => {
            // Phase 2: the Team. A Session belongs to at most one Team, so a
            // Team left by a crashed attempt is found rather than duplicated.
            if round.phase != RoundPhase::TeamCreated {
                let team = match state.teams.team_for_conversation(&session_id)? {
                    Some(existing) => existing,
                    None => {
                        let leader_name = request
                            .leader_name
                            .clone()
                            .unwrap_or_else(|| DEFAULT_LEADER_NAME.to_owned());
                        let title = request.title.clone().or_else(|| {
                            Some(format!("Round {}: {}", round.round, brief.brief.title))
                        });
                        promote_conversation_core(
                            state,
                            &session_id,
                            &leader_name,
                            title.as_deref(),
                            request.workspace,
                            fresh,
                        )
                        .await?
                    }
                };
                // A Team serves one round; a Session already led by another
                // round's Team cannot be reused for a second one.
                if let Some((_, other)) = state.research.round_for_team(&team.id)?
                    && other.id != round_id
                {
                    return Err(ResearchError::RoundState(
                        "that Session already leads the Team of another round",
                    )
                    .into());
                }
                round = state.research.round_attach_team(
                    project_id,
                    research_id,
                    round_id,
                    &team.id,
                )?;
            }
            // Phase 3: start (only a draft Team; anything else is already
            // started or being recovered by the Team supervisor).
            let team_id = round
                .team_id
                .clone()
                .ok_or_else(|| invalid("the round has no Team"))?;
            let team = state.teams.get_team(&team_id)?;
            if team.status == TeamStatus::Draft {
                start_team_core(
                    state,
                    &team_id,
                    StartTeamRequest {
                        goal: team_goal(&round, &brief, &request.instruction),
                        acceptance_criteria: request.acceptance_criteria.clone(),
                        allowed_agent_ids: request.allowed_agent_ids.clone(),
                        mode: request.team_mode,
                        max_teammates: request.max_teammates,
                        max_parallel_runs: request.max_parallel_runs,
                        max_review_rounds: request.max_review_rounds,
                    },
                )
                .await?;
            }
        }
    }
    Ok(state
        .research
        .round_mark_started(project_id, research_id, round_id)?)
}

// -- Projections ----------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct TargetView {
    id: String,
    title: Option<String>,
    availability: SourceAvailability,
    /// Team lifecycle status.
    state: Option<String>,
}

#[derive(Debug, Serialize)]
struct SourceView {
    #[serde(flatten)]
    source: SourceRef,
    availability: SourceAvailability,
}

#[derive(Debug, Serialize)]
struct RoundView {
    id: String,
    research_id: String,
    round: u64,
    brief_revision: u64,
    /// True when the brief has changed since this round pinned its revision.
    stale: bool,
    kind: RoundKind,
    phase: RoundPhase,
    session: Option<TargetView>,
    team: Option<TargetView>,
    request: serde_json::Value,
    sources: Vec<SourceView>,
    created_at: String,
    updated_at: String,
}

fn round_view(state: &AppState, project_id: &str, round: ResearchRound, current: u64) -> RoundView {
    let session = round.session_id.as_deref().map(|id| {
        match state.agent_runtime.store().get_conversation(id) {
            Ok(conversation) if conversation.project_id == project_id => TargetView {
                id: id.to_owned(),
                title: Some(conversation.title),
                availability: SourceAvailability::Available,
                state: None,
            },
            _ => TargetView {
                id: id.to_owned(),
                title: None,
                availability: SourceAvailability::Removed,
                state: None,
            },
        }
    });
    let team = round
        .team_id
        .as_deref()
        .map(|id| match state.teams.get_team(id) {
            Ok(team) if team.project_id == project_id => TargetView {
                id: id.to_owned(),
                title: Some(team.title.clone()),
                availability: SourceAvailability::Available,
                state: serde_json::to_value(team.status)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned)),
            },
            _ => TargetView {
                id: id.to_owned(),
                title: None,
                availability: SourceAvailability::Removed,
                state: None,
            },
        });
    let sources = round
        .sources
        .iter()
        .map(|source| SourceView {
            availability: resolver(state).resolve(project_id, source),
            source: source.clone(),
        })
        .collect();
    RoundView {
        stale: round.brief_revision < current,
        id: round.id,
        research_id: round.research_id,
        round: round.round,
        brief_revision: round.brief_revision,
        kind: round.kind,
        phase: round.phase,
        session,
        team,
        request: round.request,
        sources,
        created_at: round.created_at,
        updated_at: round.updated_at,
    }
}

// -- Handlers -------------------------------------------------------------------------------------------

async fn list_rounds(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<Vec<RoundView>>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let current = state.research.get(&project_id, &research_id)?.revision;
    let rounds = state.research.rounds(&project_id, &research_id)?;
    Ok(Json(
        rounds
            .into_iter()
            .map(|round| round_view(&state, &project_id, round, current))
            .collect(),
    ))
}

async fn get_round(
    State(state): State<AppState>,
    Path((project_id, research_id, round_id)): Path<(String, String, String)>,
) -> Result<Json<RoundView>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let current = state.research.get(&project_id, &research_id)?.revision;
    let round = state.research.round(&project_id, &research_id, &round_id)?;
    Ok(Json(round_view(&state, &project_id, round, current)))
}

async fn start_round(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Json(request): Json<StartRoundRequest>,
) -> Result<Response, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state.research.get(&project_id, &research_id)?;
    // A replay is answered from the stored round without re-validating: the
    // request has already been authorized, and its Session may since have
    // been promoted (which preflight would refuse) or its sources changed.
    if let Some(existing) =
        state
            .research
            .round_by_key(&project_id, &research_id, &request.client_request_id)?
    {
        let stored: Option<StoredRequest> = serde_json::from_value(existing.request.clone()).ok();
        if existing.kind != request.mode
            || stored.is_none_or(|stored| stored.fingerprint != fingerprint(&request))
        {
            return Err(ResearchError::KeyReuse.into());
        }
        let round = drive_round(&state, &project_id, &research_id, &existing.id).await?;
        let current = question.revision;
        return Ok((
            StatusCode::OK,
            Json(round_view(&state, &project_id, round, current)),
        )
            .into_response());
    }
    let (stored, sources) = preflight(
        &state,
        &project_id,
        &research_id,
        &request,
        &question.brief.evaluation_criteria,
    )?;
    let (round, created) = state.research.begin_round(
        &project_id,
        &research_id,
        NewRound {
            kind: request.mode,
            idempotency_key: &request.client_request_id,
            expected_revision: request.expected_revision,
            request: serde_json::to_value(&stored)
                .map_err(|_| invalid("the round request could not be recorded"))?,
            sources,
        },
    )?;
    // A replay of an unfinished round resumes it.
    let round = drive_round(&state, &project_id, &research_id, &round.id).await?;
    let current = state.research.get(&project_id, &research_id)?.revision;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(round_view(&state, &project_id, round, current)),
    )
        .into_response())
}

async fn resume_round(
    State(state): State<AppState>,
    Path((project_id, research_id, round_id)): Path<(String, String, String)>,
) -> Result<Json<RoundView>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let round = drive_round(&state, &project_id, &research_id, &round_id).await?;
    let current = state.research.get(&project_id, &research_id)?.revision;
    Ok(Json(round_view(&state, &project_id, round, current)))
}
