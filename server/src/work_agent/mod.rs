//! The commands an *agent* may issue over Workspace work (ADR 0217), as one
//! caller-bound service. The caller is a Session; its Project always comes from
//! the Session. Every command re-reads who may do it from persisted state:
//! the round's current coordinator row for coordination, the open assignment
//! for execution. A role named in a prompt grants nothing, and a handoff takes
//! effect on the very next command. The MCP server (`work_mcp`) is a thin
//! wrapper over this service so it can be exercised without a transport.

use std::sync::Arc;

use serde::Serialize;
use thiserror::Error;

use crate::agent_store::{AgentStore, StoreError};
use crate::agents::AgentId;
use crate::channel_store::{
    AuthorKind, ChannelError, ChannelStore, ContextRef, Message, NewMessage, Thread,
};
use crate::orchestrator::{Orchestrator, OrchestratorError};
use crate::research_store::ResearchStore;
use crate::work_store::{
    Actor, Attempt, AttemptOutcome, Closure, CoordinatorAuth, NewResult, NewWork, PlanPatch,
    ResultRole, ReviewInput, ReviewKind, RoundPolicy, RoundStats, WorkCondition, WorkError,
    WorkFilter, WorkLifecycle, WorkOutcome, WorkStage, WorkStore, WorkSummary,
};

mod analysis;
mod evidence;
#[cfg(test)]
mod tests;

pub use analysis::{DecisionInput, LaunchSpec};
pub use evidence::{Evidence, StaleEvidence};

const LIST_LIMIT: usize = 100;

#[derive(Debug, Error)]
pub enum AgentWorkError {
    /// Missing, or not something this Session may see: indistinguishable.
    #[error("not found, or not yours to act on")]
    NotFound,
    #[error("you do not coordinate that round (any longer)")]
    NotCoordinator,
    #[error("{0}")]
    Invalid(String),
    /// An experiment was refused or could not run (a limit, an unauthorized command).
    #[error("{0}")]
    Experiment(String),
    /// Cited evidence changed or was removed since it was pinned.
    #[error("evidence changed since it was attached; look at it and re-pin it before accepting")]
    StaleEvidence(Vec<StaleEvidence>),
    #[error(transparent)]
    Work(#[from] WorkError),
    #[error(transparent)]
    Channel(#[from] ChannelError),
    #[error(transparent)]
    Orchestrator(#[from] OrchestratorError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

fn invalid(text: impl Into<String>) -> AgentWorkError {
    AgentWorkError::Invalid(text.into())
}

#[derive(Clone, Debug, Serialize)]
pub struct PolicyView {
    pub round_id: String,
    pub policy: RoundPolicy,
    pub used: RoundStats,
}

pub struct NewTask<'a> {
    pub round_id: Option<&'a str>,
    pub title: &'a str,
    pub description: &'a str,
    pub plan: Option<&'a str>,
    pub depends_on: &'a [String],
    pub from_thread: Option<&'a str>,
    pub client_request_id: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReportStatus {
    Completed,
    Failed,
    Cancelled,
}

/// What a Session is allowed to do with one item.
enum Role {
    Coordinator(Actor),
    Executor(Actor),
}

/// The stores the agent commands run over; the runtime hands them to the
/// `kubecode-work` tool server.
#[derive(Clone)]
pub struct WorkServices {
    pub work: Arc<WorkStore>,
    pub channels: Arc<ChannelStore>,
    pub orchestrator: Arc<Orchestrator>,
}

pub struct WorkAgent {
    project_id: String,
    caller: String,
    work: Arc<WorkStore>,
    channels: Arc<ChannelStore>,
    orchestrator: Arc<Orchestrator>,
    research: Arc<ResearchStore>,
    agents: Arc<AgentStore>,
    provider_available: Arc<dyn Fn(AgentId) -> bool + Send + Sync>,
    experiments: Option<Arc<crate::experiment_runner::ExperimentRunner>>,
    evidence: Option<Evidence>,
}

impl WorkAgent {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        project_id: String,
        caller: String,
        work: Arc<WorkStore>,
        channels: Arc<ChannelStore>,
        orchestrator: Arc<Orchestrator>,
        research: Arc<ResearchStore>,
        agents: Arc<AgentStore>,
        provider_available: Arc<dyn Fn(AgentId) -> bool + Send + Sync>,
    ) -> Self {
        Self {
            project_id,
            caller,
            work,
            channels,
            orchestrator,
            research,
            agents,
            provider_available,
            experiments: None,
            evidence: None,
        }
    }

    /// Lets this Session launch experiments for its tasks (ADR 0219).
    pub fn with_experiments(
        mut self,
        runner: Arc<crate::experiment_runner::ExperimentRunner>,
    ) -> Self {
        self.experiments = Some(runner);
        self
    }

    /// Lets commands pin evidence to the revision it has and refuse stale evidence.
    pub fn with_evidence(mut self, evidence: Evidence) -> Self {
        self.evidence = Some(evidence);
        self
    }

    // -- Identity ------------------------------------------------------------------------------------

    /// Authority to coordinate `round_id`, from the persisted coordinator row
    /// as of this command. Another holder, or none, is refused.
    fn coordinator_actor(&self, round_id: &str) -> Result<Actor, AgentWorkError> {
        let current = self
            .work
            .coordinator(&self.project_id, round_id)?
            .ok_or(AgentWorkError::NotCoordinator)?;
        if current.holder != self.caller {
            return Err(AgentWorkError::NotCoordinator);
        }
        Ok(Actor::Coordinator(CoordinatorAuth {
            round_id: round_id.to_owned(),
            holder: current.holder,
            epoch: current.epoch,
        }))
    }

    fn executor_actor(&self) -> Actor {
        Actor::Executor {
            conversation_id: self.caller.clone(),
        }
    }

    fn role_for(&self, summary: &WorkSummary) -> Result<Role, AgentWorkError> {
        if let Some(round_id) = summary.item.round_id.as_deref()
            && let Ok(actor) = self.coordinator_actor(round_id)
        {
            return Ok(Role::Coordinator(actor));
        }
        if summary
            .assignment
            .as_ref()
            .is_some_and(|assignment| assignment.conversation_id == self.caller)
        {
            return Ok(Role::Executor(self.executor_actor()));
        }
        Err(AgentWorkError::NotFound)
    }

    fn visible(&self, work_id: &str) -> Result<(WorkSummary, Role), AgentWorkError> {
        let summary =
            self.work
                .summary(&self.project_id, work_id)
                .map_err(|error| match error {
                    WorkError::NotFound => AgentWorkError::NotFound,
                    other => other.into(),
                })?;
        let role = self.role_for(&summary)?;
        Ok((summary, role))
    }

    fn coordinated(&self, round_id: Option<&str>) -> Result<String, AgentWorkError> {
        match round_id {
            Some(round_id) => {
                self.coordinator_actor(round_id)?;
                Ok(round_id.to_owned())
            }
            None => {
                let rounds = self
                    .work
                    .coordinated_rounds(&self.project_id, &self.caller)?;
                match rounds.as_slice() {
                    [only] => Ok(only.clone()),
                    [] => Err(AgentWorkError::NotCoordinator),
                    _ => Err(invalid("you coordinate several rounds; name the round_id")),
                }
            }
        }
    }

    // -- Reading -------------------------------------------------------------------------------------

    pub fn policy(&self, round_id: Option<&str>) -> Result<PolicyView, AgentWorkError> {
        let round_id = self.coordinated(round_id)?;
        Ok(PolicyView {
            policy: self.work.policy(&self.project_id, &round_id)?,
            used: self.work.round_stats(&self.project_id, &round_id)?,
            round_id,
        })
    }

    /// Work in the rounds this Session coordinates, and work assigned to it.
    pub fn list(&self, round_id: Option<&str>) -> Result<Vec<WorkSummary>, AgentWorkError> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        let rounds = match round_id {
            Some(round_id) => {
                self.coordinator_actor(round_id)?;
                vec![round_id.to_owned()]
            }
            None => self
                .work
                .coordinated_rounds(&self.project_id, &self.caller)?,
        };
        for round in rounds {
            for summary in self.work.list(
                &self.project_id,
                &WorkFilter {
                    round_id: Some(round),
                    limit: Some(LIST_LIMIT),
                    ..Default::default()
                },
            )? {
                if seen.insert(summary.item.id.clone()) {
                    out.push(summary);
                }
            }
        }
        if round_id.is_none() {
            for summary in self.work.list(
                &self.project_id,
                &WorkFilter {
                    conversation_id: Some(self.caller.clone()),
                    limit: Some(LIST_LIMIT),
                    ..Default::default()
                },
            )? {
                if seen.insert(summary.item.id.clone()) {
                    out.push(summary);
                }
            }
        }
        out.truncate(LIST_LIMIT);
        Ok(out)
    }

    pub fn get(&self, work_id: &str) -> Result<WorkSummary, AgentWorkError> {
        Ok(self.visible(work_id)?.0)
    }

    // -- Coordination ----------------------------------------------------------------------------------

    pub fn create(&self, task: NewTask<'_>) -> Result<WorkSummary, AgentWorkError> {
        let round_id = self.coordinated(task.round_id)?;
        let actor = self.coordinator_actor(&round_id)?;
        let round = self
            .research
            .round_by_id(&self.project_id, &round_id)
            .map_err(|_| AgentWorkError::NotFound)?;
        // A task's discussion must be this round's: a Thread of another
        // question, of another round, or of no question at all is another
        // context and does not justify this round's work (nor does it gain the
        // executor standing to speak there).
        if let Some(thread_id) = task.from_thread {
            let thread = self
                .channels
                .thread(&self.project_id, thread_id)
                .map_err(|error| match error {
                    ChannelError::ThreadNotFound => AgentWorkError::NotFound,
                    other => other.into(),
                })?;
            let same_question = thread.research_id.as_deref() == Some(round.research_id.as_str());
            let same_round = thread
                .round_id
                .as_deref()
                .is_none_or(|linked| linked == round_id);
            if !(same_question && same_round) {
                return Err(invalid(
                    "that Thread is not linked to this round's research question",
                ));
            }
        }
        let (item, _) = self.work.create(
            &self.project_id,
            NewWork {
                title: task.title,
                description: task.description,
                plan: task.plan,
                round_id: Some(&round_id),
                dependencies: task.depends_on,
                derived_from: task.from_thread.map(|id| ("thread", id)),
                created_by: Some(&self.caller),
                client_request_id: task.client_request_id,
                ..Default::default()
            },
            &actor,
        )?;
        Ok(self.work.summary(&self.project_id, &item.id)?)
    }

    pub fn update(
        &self,
        work_id: &str,
        expected_revision: u64,
        patch: PlanPatch,
    ) -> Result<WorkSummary, AgentWorkError> {
        let (_, role) = self.visible(work_id)?;
        let Role::Coordinator(actor) = role else {
            return Err(AgentWorkError::NotCoordinator);
        };
        self.work
            .update_plan(&self.project_id, work_id, expected_revision, patch, &actor)?;
        Ok(self.work.summary(&self.project_id, work_id)?)
    }

    pub fn assign(
        &self,
        work_id: &str,
        session_id: &str,
        reason: &str,
    ) -> Result<WorkSummary, AgentWorkError> {
        let (summary, role) = self.visible(work_id)?;
        let Role::Coordinator(actor) = role else {
            return Err(AgentWorkError::NotCoordinator);
        };
        // A coordinator executes work itself or hands it to a Session it made
        // for the round. Other Sessions (the researcher's chats, Team members,
        // other work) are not its to direct.
        if session_id != self.caller {
            let round_id = summary.item.round_id.as_deref().unwrap_or_default();
            if !self
                .work
                .is_round_executor(&self.project_id, round_id, session_id)?
            {
                return Err(invalid(
                    "assign yourself or a Session you created with work_executor_create",
                ));
            }
        }
        self.work
            .assign(&self.project_id, work_id, session_id, None, reason, &actor)?;
        Ok(self.work.summary(&self.project_id, work_id)?)
    }

    pub fn create_executor(
        &self,
        round_id: Option<&str>,
        agent: &str,
        title: &str,
        request_key: &str,
    ) -> Result<String, AgentWorkError> {
        let round_id = self.coordinated(round_id)?;
        let key = request_key.trim();
        if key.is_empty() || key.chars().count() > 128 {
            return Err(invalid(
                "a request key (at most 128 characters) is required so a retry makes one Session",
            ));
        }
        let agent_id: AgentId = agent.parse().map_err(|_| invalid("unknown agent"))?;
        if !(self.provider_available)(agent_id) {
            return Err(invalid(format!("{agent} is not installed or available")));
        }
        let policy = self.work.policy(&self.project_id, &round_id)?;
        if policy.paused {
            return Err(WorkError::RoundPaused.into());
        }
        // A retry returns the Session the first call made. Idle Sessions are
        // bounded too: twice the executor limit, so a loop cannot flood the Project.
        if let Some(existing) = self.work.reserve_executor(
            &self.project_id,
            &round_id,
            key,
            &self.caller,
            policy.max_executors.saturating_mul(2),
        )? {
            return Ok(existing);
        }
        let title: String = title.trim().chars().take(120).collect();
        let conversation = self.agents.create_conversation(
            &self.project_id,
            agent_id,
            Some(if title.is_empty() { "Executor" } else { &title }),
        )?;
        let owner =
            self.work
                .record_executor(&self.project_id, &round_id, key, &conversation.id)?;
        if owner != conversation.id {
            // A concurrent call recorded its Session first; ours is surplus.
            let _ = self.agents.delete_conversation(&conversation.id);
        }
        Ok(owner)
    }

    /// Starts one attempt (within the round's limits) and tells the executor.
    /// A repeated `request_key` returns the same attempt and the same route, so
    /// a crash between the two is repaired by replaying the command.
    pub fn start(&self, work_id: &str, request_key: &str) -> Result<Attempt, AgentWorkError> {
        let (summary, role) = self.visible(work_id)?;
        let Role::Coordinator(actor) = role else {
            return Err(AgentWorkError::NotCoordinator);
        };
        if request_key.trim().is_empty() {
            return Err(invalid(
                "a request_key is required so a replay starts nothing twice",
            ));
        }
        let attempt = match self.work.begin_attempt(
            &self.project_id,
            work_id,
            Some(request_key),
            &actor,
        ) {
            Ok(attempt) => attempt,
            Err(error @ (WorkError::BudgetExhausted(_) | WorkError::RoundPaused)) => {
                // Further dispatch stops, and the researcher is told on the card.
                let _ = self.work.flag_attention(
                    &self.project_id,
                    work_id,
                    &format!("no more attempts can start: {error}. Only the researcher can raise the limit."),
                );
                return Err(error.into());
            }
            Err(error) => return Err(error.into()),
        };
        // The attempt names its own executor, even if the task moved since.
        let executor = attempt
            .conversation_id
            .clone()
            .ok_or(WorkError::NotAssigned)?;
        self.orchestrator.route_dispatch(
            &self.project_id,
            &summary.item,
            &attempt.id,
            &executor,
        )?;
        Ok(attempt)
    }

    pub fn review(
        &self,
        work_id: &str,
        accept: bool,
        outcome: WorkOutcome,
        reason: Option<&str>,
    ) -> Result<WorkSummary, AgentWorkError> {
        let (summary, role) = self.visible(work_id)?;
        let Role::Coordinator(actor) = role else {
            return Err(AgentWorkError::NotCoordinator);
        };
        // Evidence matters to what a result claims, not to a plan.
        if accept && summary.item.review_kind != Some(ReviewKind::Plan) {
            self.refuse_stale_evidence(work_id)?;
        }
        self.work.review(
            &self.project_id,
            work_id,
            ReviewInput {
                accept,
                outcome,
                reason,
            },
            &actor,
        )?;
        self.publish_latest_review(work_id)?;
        Ok(self.work.summary(&self.project_id, work_id)?)
    }

    pub fn close(
        &self,
        work_id: &str,
        expected_revision: u64,
        lifecycle: WorkLifecycle,
        reason: &str,
        superseded_by: Option<&str>,
    ) -> Result<WorkSummary, AgentWorkError> {
        let (_, role) = self.visible(work_id)?;
        let Role::Coordinator(actor) = role else {
            return Err(AgentWorkError::NotCoordinator);
        };
        self.work.close(
            &self.project_id,
            work_id,
            expected_revision,
            Closure {
                lifecycle,
                reason,
                superseded_by,
            },
            &actor,
        )?;
        Ok(self.work.summary(&self.project_id, work_id)?)
    }

    /// Why work is not moving. The coordinator may set any condition; the
    /// executing Session may say it is waiting, needs input, or is clear.
    pub fn set_condition(
        &self,
        work_id: &str,
        condition: WorkCondition,
        reason: Option<&str>,
    ) -> Result<WorkSummary, AgentWorkError> {
        let (_, role) = self.visible(work_id)?;
        let actor = match role {
            Role::Coordinator(actor) | Role::Executor(actor) => actor,
        };
        self.work
            .set_condition(&self.project_id, work_id, condition, reason, &actor)?;
        Ok(self.work.summary(&self.project_id, work_id)?)
    }

    /// Hands a round to another Session. The old holder's authority ends at
    /// once: its very next command is refused. The new holder is told what it
    /// now holds and what is open.
    pub fn handoff(
        &self,
        round_id: &str,
        to_session: &str,
        reason: &str,
    ) -> Result<(), AgentWorkError> {
        let Actor::Coordinator(auth) = self.coordinator_actor(round_id)? else {
            return Err(AgentWorkError::NotCoordinator);
        };
        let new = self.work.handoff_coordinator(
            &self.project_id,
            round_id,
            auth.epoch,
            to_session,
            reason,
            &Actor::Coordinator(auth.clone()),
        )?;
        let open: Vec<(String, String, String)> = self
            .work
            .list(
                &self.project_id,
                &WorkFilter {
                    round_id: Some(round_id.to_owned()),
                    limit: Some(LIST_LIMIT),
                    ..Default::default()
                },
            )?
            .into_iter()
            .filter(|summary| summary.item.stage != WorkStage::Done)
            .map(|summary| {
                (
                    summary.item.id,
                    summary.item.title,
                    summary.item.stage.as_str().to_owned(),
                )
            })
            .collect();
        self.orchestrator.route_handoff(
            &self.project_id,
            round_id,
            new.epoch,
            to_session,
            &open,
            reason,
        )?;
        Ok(())
    }

    /// Attaches an existing record as evidence or a result of the caller's
    /// task (or, for a coordinator, any task of its round).
    pub fn attach(
        &self,
        work_id: &str,
        kind: &str,
        ref_id: &str,
        revision: Option<&str>,
        role: ResultRole,
    ) -> Result<WorkSummary, AgentWorkError> {
        let (summary, who) = self.visible(work_id)?;
        let actor = match who {
            Role::Coordinator(actor) | Role::Executor(actor) => actor,
        };
        let attempt_id = summary
            .latest_attempt
            .as_ref()
            .map(|attempt| attempt.id.clone());
        // Evidence is pinned to the revision it has now, so a later change is
        // detectable. (Experiments are pinned when they are analyzed.)
        // Only content-addressed kinds are pinned: a Thread, a task, or a
        // Session changes all the time without invalidating what cites it.
        // (Evidence over the asset size limit cannot be fingerprinted and is
        // cited unpinned.)
        if matches!(kind, "experiment" | "artifact") {
            let experiment = ref_id.split_once('/').map_or(ref_id, |(id, _)| id);
            let owned = self.experiments.as_ref().is_some_and(|runner| {
                runner
                    .store()
                    .experiment(&self.project_id, experiment)
                    .is_ok_and(|e| e.task_id.as_deref() == Some(work_id))
            });
            if !owned {
                return Err(invalid("cite only experiments that belong to this task"));
            }
        }
        let pinned = match (revision, &self.evidence) {
            (Some(revision), _) => Some(revision.to_owned()),
            (None, Some(evidence))
                if matches!(kind, "file" | "artifact" | "finding" | "import") =>
            {
                evidence.current_revision(&self.project_id, kind, ref_id)
            }
            _ => None,
        };
        self.work.add_result(
            &self.project_id,
            work_id,
            NewResult {
                attempt_id: attempt_id.as_deref(),
                role,
                kind,
                ref_id,
                revision: pinned.as_deref(),
            },
            &actor,
        )?;
        Ok(self.work.summary(&self.project_id, work_id)?)
    }

    /// The executing Session reports its open attempt. A completed attempt
    /// goes to review; a failed or cancelled one is history and the task stays
    /// in execution for a decision. Either way the coordinator is told and the
    /// originating Thread hears it, once. Repeating a report that was already
    /// recorded finishes whatever a crash left undone (the stage move, the
    /// result route, the Thread note) instead of failing.
    pub fn report(
        &self,
        work_id: &str,
        status: ReportStatus,
        summary_text: &str,
        error: Option<&str>,
    ) -> Result<WorkSummary, AgentWorkError> {
        let summary =
            self.work
                .summary(&self.project_id, work_id)
                .map_err(|error| match error {
                    WorkError::NotFound => AgentWorkError::NotFound,
                    other => other.into(),
                })?;
        // Execution is the open assignment, even when the executor also
        // coordinates the round.
        if summary
            .assignment
            .as_ref()
            .is_none_or(|assignment| assignment.conversation_id != self.caller)
        {
            return Err(if self.role_for(&summary).is_ok() {
                invalid("only the executing Session reports on its attempt")
            } else {
                AgentWorkError::NotFound
            });
        }
        if status == ReportStatus::Completed {
            // Reporting done while a process runs, or while a finished result
            // has no decision, would put unexamined work in front of review.
            self.refuse_unanalyzed(&summary)?;
        }
        let actor = self.executor_actor();
        let wanted = match status {
            ReportStatus::Completed => crate::work_store::AttemptStatus::Completed,
            ReportStatus::Failed => crate::work_store::AttemptStatus::Failed,
            ReportStatus::Cancelled => crate::work_store::AttemptStatus::Cancelled,
        };
        let attempts = self.work.attempts(&self.project_id, work_id)?;
        let open = attempts.iter().rev().find(|attempt| {
            matches!(
                attempt.status,
                crate::work_store::AttemptStatus::Queued
                    | crate::work_store::AttemptStatus::Running
                    | crate::work_store::AttemptStatus::NeedsReport
            )
        });
        let attempt_id = match open {
            Some(attempt) => {
                if attempt.status == crate::work_store::AttemptStatus::Queued
                    && status == ReportStatus::Completed
                {
                    // The run that is doing the work: its newest running run.
                    let run = self
                        .agents
                        .list_runs(&self.caller)?
                        .into_iter()
                        .rev()
                        .find(|run| {
                            matches!(
                                run.status,
                                crate::agents::RunStatus::Running
                                    | crate::agents::RunStatus::WaitingPermission
                            )
                        })
                        .ok_or_else(|| invalid("no running turn to attribute the work to"))?;
                    self.work
                        .bind_attempt_run(&self.project_id, &attempt.id, &run.id, &actor)?;
                }
                let outcome = match status {
                    ReportStatus::Completed => AttemptOutcome::Completed,
                    ReportStatus::Failed => AttemptOutcome::Failed {
                        kind: Some("reported".to_owned()),
                        error: error.map(str::to_owned),
                    },
                    ReportStatus::Cancelled => AttemptOutcome::Cancelled,
                };
                self.work
                    .finish_attempt(&self.project_id, &attempt.id, outcome, &actor)?;
                attempt.id.clone()
            }
            // Already recorded: only the same outcome converges.
            None => attempts
                .last()
                .filter(|attempt| attempt.status == wanted)
                .map(|attempt| attempt.id.clone())
                .ok_or_else(|| invalid("there is no open attempt to report on"))?,
        };
        let fresh = self.work.summary(&self.project_id, work_id)?;
        if status == ReportStatus::Completed && fresh.item.stage == WorkStage::Executing {
            self.work.advance(
                &self.project_id,
                work_id,
                WorkStage::Executing,
                WorkStage::Review,
                Some(ReviewKind::Result),
                &actor,
            )?;
        }
        let text = match (status, error) {
            (ReportStatus::Completed, _) => summary_text.to_owned(),
            (ReportStatus::Failed, Some(error)) => format!("FAILED: {error}. {summary_text}"),
            (ReportStatus::Failed, None) => format!("FAILED. {summary_text}"),
            (ReportStatus::Cancelled, _) => format!("CANCELLED. {summary_text}"),
        };
        let fresh = self.work.summary(&self.project_id, work_id)?;
        self.orchestrator
            .route_result(&self.project_id, &fresh.item, &attempt_id, &text)?;
        Ok(fresh)
    }

    /// Posts into the Workspace conversation as this Session. Only where it has
    /// standing *now*: the Thread of a round it coordinates, a Thread it was
    /// asked in, or the Thread of work it currently executes. `in_reply_to` is
    /// a Thread id or a message id (a message without a Thread gets one, but
    /// only for a Session that was asked about it).
    pub fn post(
        &self,
        in_reply_to: &str,
        body: &str,
        references: &[ContextRef],
    ) -> Result<Message, AgentWorkError> {
        let (thread, asked) = self.thread_for(in_reply_to)?;
        if !asked && !self.may_speak_in(&thread)? {
            return Err(AgentWorkError::NotFound);
        }
        // A repeated post of the same words by the same Session is one message.
        let digest = {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(
                format!("{}\u{0}{}\u{0}{body}", self.caller, thread.id).as_bytes(),
            ))
        };
        let key = format!("agent:{}", &digest[..32]);
        let (message, _) = self.channels.post(
            &self.project_id,
            &thread.channel_id,
            NewMessage {
                thread_id: Some(&thread.id),
                body,
                author_kind: Some(AuthorKind::Agent),
                author_ref: Some(&self.caller),
                references,
                client_message_id: Some(&key),
                ..Default::default()
            },
        )?;
        Ok(message)
    }

    /// The Thread to speak in, and whether the Session was asked about the
    /// message that opened it (which is standing enough to answer).
    fn thread_for(&self, id: &str) -> Result<(Thread, bool), AgentWorkError> {
        if let Ok(thread) = self.channels.thread(&self.project_id, id) {
            return Ok((thread, false));
        }
        let message = self
            .channels
            .message(&self.project_id, id)
            .map_err(|_| AgentWorkError::NotFound)?;
        if let Some(thread_id) = &message.thread_id {
            return Ok((self.channels.thread(&self.project_id, thread_id)?, false));
        }
        // Only a Session that was asked about this message may open its Thread.
        if !self
            .orchestrator
            .was_asked(&self.project_id, &self.caller, &message.id, None)?
        {
            return Err(AgentWorkError::NotFound);
        }
        let (thread, _) = self.channels.start_thread(
            &self.project_id,
            &message.channel_id,
            &message.id,
            None,
            Some(&self.caller),
        )?;
        Ok((thread, true))
    }

    /// Standing in a Thread, from current state only: coordinating its round,
    /// having been asked in it, or executing work that came from it. A
    /// coordinator that handed off or an executor that was reassigned has none.
    fn may_speak_in(&self, thread: &Thread) -> Result<bool, AgentWorkError> {
        let coordinated = self
            .work
            .coordinated_rounds(&self.project_id, &self.caller)?;
        if let Some(round_id) = &thread.round_id
            && coordinated.contains(round_id)
        {
            return Ok(true);
        }
        if let Some(research_id) = &thread.research_id
            && !coordinated.is_empty()
            && self
                .research
                .rounds(&self.project_id, research_id)
                .unwrap_or_default()
                .iter()
                .any(|round| coordinated.contains(&round.id))
        {
            return Ok(true);
        }
        if self.orchestrator.was_asked(
            &self.project_id,
            &self.caller,
            &thread.root_message_id,
            Some(&thread.id),
        )? {
            return Ok(true);
        }
        // Executing work that came from this Thread.
        for summary in self.work.list(
            &self.project_id,
            &WorkFilter {
                conversation_id: Some(self.caller.clone()),
                limit: Some(LIST_LIMIT),
                ..Default::default()
            },
        )? {
            if summary
                .item
                .derived_from
                .as_ref()
                .is_some_and(|d| d.kind == "thread" && d.id == thread.id)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
