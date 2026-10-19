//! Experiments, analysis, and evidence for a task (ADR 0219): the commands an
//! executing Session uses to run bounded experiments for its task and decide
//! what a finished one means, and the gates that keep a review honest.

use serde::{Deserialize, Serialize};

use super::{AgentWorkError, Role, WorkAgent, invalid};
use crate::experiment_runner::RunnerError;
use crate::experiment_store::{
    AnalysisState, DecisionKind, Experiment, ExperimentError, NewDecision, NewLaunch,
};
use crate::work_store::{
    DecisionRequest, NewResult, ResultRole, WorkCondition, WorkError, WorkLifecycle, WorkOrigin,
    WorkStage, WorkSummary,
};

/// Longest key a caller may supply; the stored key adds a task prefix.
const MAX_CALLER_KEY_CHARS: usize = 64;
/// Items shown in a brief, newest first.
const BRIEF_ITEMS: usize = 20;

/// The next experiment to run, as the executing Session describes it.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct LaunchSpec {
    /// Repeating a key returns the same experiment and starts nothing.
    pub launch_key: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub label: Option<String>,
    pub artifacts: Vec<String>,
    pub max_runtime_secs: Option<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct DecisionInput {
    pub experiment_id: String,
    pub kind: String,
    pub decision_key: Option<String>,
    pub rationale: String,
    /// `(kind, id)` of the records the decision rests on.
    pub evidence: Vec<(String, String)>,
    /// The next experiment, for `retry` and `follow_up`.
    pub launch: Option<LaunchSpec>,
    /// What to ask the researcher, for `researcher_input`.
    pub question: Option<String>,
    pub options: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DecisionOutcome {
    pub decision_id: String,
    pub created: bool,
    pub kind: DecisionKind,
    pub launched_experiment_id: Option<String>,
    /// Whether any experiment of the task still owes analysis.
    pub analysis_owed: bool,
    pub request: Option<DecisionRequest>,
}

/// Everything an executing Session needs to start a task well, assembled from
/// records so a replacement Session gets the same picture.
#[derive(Clone, Debug, Serialize)]
pub struct TaskBrief {
    pub work_id: String,
    pub title: String,
    pub description: String,
    pub plan: Option<String>,
    pub question: Option<String>,
    pub hypotheses: Vec<String>,
    pub constraints: Vec<String>,
    /// The brief revision the round was approved under.
    pub brief_revision: Option<u64>,
    /// What counts as done, from the brief's evaluation criteria.
    pub completion_conditions: Vec<String>,
    pub sources: Vec<BriefSource>,
    pub attempts: Vec<serde_json::Value>,
    pub experiments: Vec<serde_json::Value>,
    pub decisions: Vec<serde_json::Value>,
    pub resources: serde_json::Value,
    /// Questions put to the researcher, with their answers once given.
    pub decision_requests: Vec<serde_json::Value>,
    pub stale_evidence: Vec<super::StaleEvidence>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BriefSource {
    pub kind: String,
    pub id: String,
    /// `available`, `changed`, or `removed`.
    pub status: &'static str,
}

fn experiment_error(error: ExperimentError) -> AgentWorkError {
    AgentWorkError::Experiment(error.to_string())
}

impl WorkAgent {
    fn runner(
        &self,
    ) -> Result<&std::sync::Arc<crate::experiment_runner::ExperimentRunner>, AgentWorkError> {
        self.experiments
            .as_ref()
            .ok_or_else(|| invalid("experiments are not available in this Project"))
    }

    /// The task, if the caller is the Session executing it right now.
    fn executing(&self, work_id: &str) -> Result<WorkSummary, AgentWorkError> {
        self.refuse_manager("run or analyze experiments")?;
        let (summary, role) = self.visible(work_id)?;
        let is_executor = summary
            .assignment
            .as_ref()
            .is_some_and(|assignment| assignment.conversation_id == self.caller);
        if !is_executor {
            return Err(if matches!(role, Role::Coordinator(_)) {
                invalid("only the Session executing the task runs and analyzes its experiments")
            } else {
                AgentWorkError::NotFound
            });
        }
        if summary.item.origin != WorkOrigin::Native
            || summary.item.lifecycle != WorkLifecycle::Active
        {
            return Err(invalid("the task is not active"));
        }
        Ok(summary)
    }

    /// The task may run or analyze experiments now: it is executing (or
    /// analyzing), not paused or blocked by someone, and the round is not paused.
    fn require_runnable(&self, summary: &WorkSummary) -> Result<(), AgentWorkError> {
        if !matches!(
            summary.item.stage,
            WorkStage::Executing | WorkStage::Analyzing
        ) {
            return Err(invalid(
                "experiments run while the task is executing, not before or after",
            ));
        }
        if matches!(
            summary.item.condition,
            WorkCondition::Paused | WorkCondition::Blocked
        ) {
            return Err(invalid(
                "the task is paused or blocked; the researcher resumes it",
            ));
        }
        if let Some(round_id) = summary.item.round_id.as_deref()
            && self.work.policy(&self.project_id, round_id)?.paused
        {
            return Err(WorkError::RoundPaused.into());
        }
        Ok(())
    }

    fn research_of(&self, summary: &WorkSummary) -> Result<(String, String), AgentWorkError> {
        let round_id = summary
            .item
            .round_id
            .clone()
            .ok_or_else(|| invalid("the task belongs to no research round"))?;
        let round = self
            .research
            .round_by_id(&self.project_id, &round_id)
            .map_err(|_| AgentWorkError::NotFound)?;
        Ok((round.research_id, round_id))
    }

    /// Experiments of this task, newest first.
    fn task_experiments(&self, summary: &WorkSummary) -> Result<Vec<Experiment>, AgentWorkError> {
        let (research_id, round_id) = self.research_of(summary)?;
        let Ok(runner) = self.runner() else {
            return Ok(Vec::new());
        };
        Ok(runner
            .store()
            .experiments(&self.project_id, &research_id, &round_id)
            .map_err(experiment_error)?
            .into_iter()
            .filter(|experiment| experiment.task_id.as_deref() == Some(summary.item.id.as_str()))
            .collect())
    }

    /// Why a launch was refused, as the Session should read it. Limits are the
    /// researcher's; the task is flagged so they hear about it.
    fn launch_refusal(&self, work_id: &str, error: RunnerError) -> AgentWorkError {
        match error {
            RunnerError::Experiment(ExperimentError::Denied(denial)) => {
                let _ = self.work.flag_attention(
                    &self.project_id,
                    work_id,
                    &format!(
                        "an experiment could not start: {}. Only the researcher can change the limit.",
                        denial.code()
                    ),
                );
                AgentWorkError::Experiment(format!(
                    "launch refused: {}. Limits and authorized commands are the researcher's; \
                     ask with work_request_decision instead of retrying.",
                    denial.code()
                ))
            }
            RunnerError::Workspace(_) => {
                AgentWorkError::Experiment("the working directory is not allowed".to_owned())
            }
            RunnerError::Experiment(error) => experiment_error(error),
            other => AgentWorkError::Experiment(other.to_string()),
        }
    }

    fn task_launch(
        &self,
        summary: &WorkSummary,
        launch_key: String,
        spec: LaunchSpec,
    ) -> Result<Experiment, AgentWorkError> {
        let runner = self.runner()?.clone();
        let (research_id, round_id) = self.research_of(summary)?;
        runner
            .launch(
                &self.project_id,
                &research_id,
                NewLaunch {
                    round_id,
                    launch_key,
                    team_id: None,
                    task_id: Some(summary.item.id.clone()),
                    owner_member_id: Some(self.caller.clone()),
                    label: spec.label.unwrap_or_default(),
                    argv: spec.argv,
                    cwd: spec.cwd.unwrap_or_default(),
                    artifacts: spec.artifacts,
                    sources: Vec::new(),
                    max_runtime_secs: spec.max_runtime_secs,
                },
            )
            .map_err(|error| self.launch_refusal(&summary.item.id, error))
    }

    /// Runs one bounded experiment for the caller's task. The key is scoped to
    /// the task, so no other task's key can return this task's experiment.
    pub fn launch_experiment(
        &self,
        work_id: &str,
        spec: LaunchSpec,
    ) -> Result<Experiment, AgentWorkError> {
        let summary = self.executing(work_id)?;
        if summary.item.stage != WorkStage::Executing {
            return Err(invalid(
                "launch while the task is executing; decide on the finished experiment first",
            ));
        }
        self.require_runnable(&summary)?;
        let key = spec.launch_key.trim();
        if key.is_empty()
            || key.chars().count() > MAX_CALLER_KEY_CHARS
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        {
            return Err(invalid(
                "a launch_key of letters, digits, '-', '_', ':' or '.' (at most 64) is required",
            ));
        }
        let launch_key = format!("work:{work_id}:{key}");
        self.task_launch(&summary, launch_key, spec)
    }

    /// Records what a finished experiment of the caller's task means, and does
    /// what the decision says: starts the next experiment, or asks the
    /// researcher. Idempotent per `(experiment, kind, key)`.
    pub fn decide(
        &self,
        work_id: &str,
        input: DecisionInput,
    ) -> Result<DecisionOutcome, AgentWorkError> {
        let summary = self.executing(work_id)?;
        self.require_runnable(&summary)?;
        let runner = self.runner()?.clone();
        let store = runner.store().clone();
        let kind = DecisionKind::parse(&input.kind)
            .ok_or_else(|| invalid(format!("unknown decision: {}", input.kind)))?;
        let experiment = store
            .experiment(&self.project_id, &input.experiment_id)
            .map_err(|_| AgentWorkError::NotFound)?;
        if experiment.task_id.as_deref() != Some(work_id) {
            return Err(AgentWorkError::NotFound);
        }
        if experiment.state.is_active() {
            return Err(invalid(
                "the experiment has not finished; wait for its result",
            ));
        }
        let key = input
            .decision_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .unwrap_or(kind.as_str())
            .to_owned();
        let evidence = input
            .evidence
            .iter()
            .map(|(source_kind, id)| {
                self.evidence
                    .as_ref()
                    .and_then(|evidence| evidence.source_ref(&self.project_id, source_kind, id))
                    .ok_or_else(|| {
                        invalid(format!(
                            "evidence {source_kind}:{id} was not found in this Project"
                        ))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let question = input
            .question
            .as_deref()
            .map(str::trim)
            .filter(|question| !question.is_empty());
        if kind == DecisionKind::ResearcherInput && question.is_none() {
            return Err(invalid("researcher_input needs `question`"));
        }
        if kind.launches() && input.launch.is_none() {
            return Err(invalid(
                "retry and follow_up need `launch` describing the next experiment",
            ));
        }
        let mut record = NewDecision {
            experiment_id: experiment.id.clone(),
            member_id: self.caller.clone(),
            kind,
            decision_key: Some(key.clone()),
            rationale: input.rationale,
            evidence,
            launched_experiment_id: None,
        };
        // Everything the decision must satisfy is checked before it starts
        // anything, so a refused decision leaves no process behind.
        record.validate().map_err(experiment_error)?;
        let existing = store
            .find_decision(&self.project_id, &experiment.id, kind, &key)
            .map_err(experiment_error)?;

        let mut request = None;
        if existing.is_none() {
            if kind.launches()
                && let Some(spec) = input.launch
            {
                // Derived from the observation, so one result cannot fan out
                // into duplicates under different caller keys.
                let digest = {
                    use sha2::{Digest, Sha256};
                    hex::encode(Sha256::digest(key.as_bytes()))
                };
                let started = self.task_launch(
                    &summary,
                    format!(
                        "decision:{}:{}:{}",
                        experiment.id,
                        kind.as_str(),
                        &digest[..16]
                    ),
                    spec,
                )?;
                record.launched_experiment_id = Some(started.id);
            }
            // Asking comes before recording: if the researcher cannot be asked
            // the result stays owed.
            if let (DecisionKind::ResearcherInput, Some(question)) = (kind, question) {
                let thread = summary
                    .item
                    .derived_from
                    .as_ref()
                    .filter(|from| from.kind == "thread")
                    .map(|from| from.id.as_str());
                let (asked, _) = self.work.request_decision(
                    &self.project_id,
                    work_id,
                    &format!("experiment:{}:{key}", experiment.id),
                    &self.caller,
                    question,
                    &input.options,
                    None,
                    thread,
                )?;
                let _ = self
                    .orchestrator
                    .announce_question(&self.project_id, &asked);
                request = Some(asked);
            }
        }
        let (decision, created) = store
            .record_decision(&self.project_id, record)
            .map_err(experiment_error)?;
        self.pin_experiment(&summary, &experiment.id)?;
        let owed = self.owes_analysis(&summary)?;
        if !owed {
            let _ = self.work.analysis_resolved(&self.project_id, work_id);
        }
        Ok(DecisionOutcome {
            decision_id: decision.id,
            created,
            kind: decision.kind,
            launched_experiment_id: decision.launched_experiment_id,
            analysis_owed: owed,
            request,
        })
    }

    /// Cites the analyzed experiment and its recorded artifacts, pinned to
    /// what they are *now*; a later change makes them stale.
    fn pin_experiment(
        &self,
        summary: &WorkSummary,
        experiment_id: &str,
    ) -> Result<(), AgentWorkError> {
        let Some(evidence) = &self.evidence else {
            return Ok(());
        };
        let runner = self.runner()?;
        let experiment = runner
            .store()
            .experiment(&self.project_id, experiment_id)
            .map_err(experiment_error)?;
        let actor = self.executor_actor();
        let attempt = summary.latest_attempt.as_ref().map(|a| a.id.as_str());
        let mut refs = vec![("experiment", experiment.id.clone())];
        for artifact in &experiment.artifact_revisions {
            if artifact.revision.is_some() {
                refs.push(("artifact", format!("{}/{}", experiment.id, artifact.path)));
            }
        }
        for (kind, ref_id) in refs {
            let current = evidence.current_revision(&self.project_id, kind, &ref_id);
            let result = self.work.add_result(
                &self.project_id,
                &summary.item.id,
                NewResult {
                    attempt_id: attempt,
                    role: ResultRole::Evidence,
                    kind,
                    ref_id: &ref_id,
                    revision: current.as_deref(),
                },
                &actor,
            )?;
            // A result cited earlier keeps the pin it has: moving a pin is a
            // person's act (repin), never the executor's. Only a reference
            // that was cited without one is pinned now.
            if result.revision.is_none() && current.is_some() {
                self.work.repin_result(
                    &self.project_id,
                    &summary.item.id,
                    &result.id,
                    current.as_deref(),
                    &actor,
                )?;
            }
        }
        Ok(())
    }

    /// Whether an experiment of the task is unfinished or owes an analysis.
    fn owes_analysis(&self, summary: &WorkSummary) -> Result<bool, AgentWorkError> {
        Ok(self
            .task_experiments(summary)?
            .iter()
            .any(|experiment| experiment.analysis == AnalysisState::Pending))
    }

    /// A report is refused while the task still has a process running or a
    /// result nobody has decided about.
    pub(super) fn refuse_unanalyzed(&self, summary: &WorkSummary) -> Result<(), AgentWorkError> {
        let experiments = self.task_experiments(summary)?;
        if experiments.iter().any(|e| e.state.is_active()) {
            return Err(invalid(
                "an experiment of this task is still running; wait for its result and decide on it",
            ));
        }
        if experiments
            .iter()
            .any(|e| e.analysis == AnalysisState::Pending)
        {
            return Err(invalid(
                "a finished experiment of this task has no decision yet; record one with work_decide",
            ));
        }
        Ok(())
    }

    /// Acceptance rests on evidence as it was when cited. Evidence that changed
    /// or was removed blocks acceptance, and the researcher is told.
    pub(super) fn refuse_stale_evidence(&self, work_id: &str) -> Result<(), AgentWorkError> {
        let Some(evidence) = &self.evidence else {
            return Ok(());
        };
        let results = self.work.results(&self.project_id, work_id)?;
        let stale = evidence.stale(&self.project_id, &results);
        if stale.is_empty() {
            return Ok(());
        }
        let _ = self.work.flag_attention(
            &self.project_id,
            work_id,
            "cited evidence changed since it was attached; review it before accepting",
        );
        Err(AgentWorkError::StaleEvidence(stale))
    }

    /// Re-pins one cited result to what it is now, after the coordinator has
    /// looked at the change. The earlier revision stays in earlier reviews.
    pub fn repin(&self, work_id: &str, result_id: &str) -> Result<WorkSummary, AgentWorkError> {
        let (summary, role) = self.visible(work_id)?;
        let Role::Coordinator(actor) = role else {
            return Err(AgentWorkError::NotCoordinator);
        };
        let result = summary
            .results
            .iter()
            .find(|result| result.id == result_id)
            .ok_or(AgentWorkError::NotFound)?;
        let current = self
            .evidence
            .as_ref()
            .and_then(|e| e.current_revision(&self.project_id, &result.kind, &result.ref_id))
            .ok_or_else(|| {
                invalid(
                    "that evidence has no current version to accept (it is gone or cannot be read)",
                )
            })?;
        self.work
            .repin_result(&self.project_id, work_id, result_id, Some(&current), &actor)?;
        // The evidence flag goes only once nothing cited is stale any more.
        let remaining = self.work.results(&self.project_id, work_id)?;
        let still_stale = self
            .evidence
            .as_ref()
            .is_some_and(|e| !e.stale(&self.project_id, &remaining).is_empty());
        if !still_stale {
            self.work
                .clear_attention(&self.project_id, work_id, "evidence")?;
        }
        Ok(self.work.summary(&self.project_id, work_id)?)
    }

    /// Puts a bounded question to the researcher about a task. The answer
    /// widens no authority: limits change only by the researcher revising them.
    pub fn request_decision(
        &self,
        work_id: &str,
        request_key: &str,
        question: &str,
        options: &[String],
        impact: Option<&str>,
    ) -> Result<DecisionRequest, AgentWorkError> {
        let (summary, _) = self.visible(work_id)?;
        let thread = summary
            .item
            .derived_from
            .as_ref()
            .filter(|from| from.kind == "thread")
            .map(|from| from.id.as_str());
        let (request, _) = self.work.request_decision(
            &self.project_id,
            work_id,
            request_key,
            &self.caller,
            question,
            options,
            impact,
            thread,
        )?;
        // Once per request however often the command is replayed.
        let _ = self
            .orchestrator
            .announce_question(&self.project_id, &request);
        Ok(request)
    }

    /// The task as a Session starting it should see it.
    pub fn brief(&self, work_id: &str) -> Result<TaskBrief, AgentWorkError> {
        let (summary, _) = self.visible(work_id)?;
        let round = summary
            .item
            .round_id
            .as_deref()
            .and_then(|id| self.research.round_by_id(&self.project_id, id).ok());
        let revision = round.as_ref().and_then(|round| {
            self.research
                .revision(&self.project_id, &round.research_id, round.brief_revision)
                .ok()
        });
        let sources = round
            .as_ref()
            .map(|round| {
                round
                    .sources
                    .iter()
                    .map(|source| BriefSource {
                        kind: source.kind.as_str().to_owned(),
                        id: source.id.clone(),
                        status: self
                            .evidence
                            .as_ref()
                            .map_or("available", |e| e.source_status(&self.project_id, source)),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let experiments = self.task_experiments(&summary)?;
        let decisions = match (&round, self.runner()) {
            (Some(round), Ok(runner)) => runner
                .store()
                .decisions(&self.project_id, &round.research_id, &round.id)
                .map_err(experiment_error)?
                .into_iter()
                .filter(|d| experiments.iter().any(|e| e.id == d.experiment_id))
                .take(BRIEF_ITEMS)
                .map(|d| {
                    serde_json::json!({
                        "experiment_id": d.experiment_id,
                        "kind": d.kind,
                        "rationale": d.rationale,
                        "launched_experiment_id": d.launched_experiment_id,
                    })
                })
                .collect(),
            _ => Vec::new(),
        };
        let resources = match &round {
            Some(round) => {
                let envelope = self
                    .runner()
                    .ok()
                    .and_then(|r| {
                        r.store()
                            .envelope(&self.project_id, &round.research_id, &round.id)
                            .ok()
                            .flatten()
                    })
                    .map(|e| {
                        serde_json::json!({
                            "state": e.state,
                            "limits": e.limits,
                            "launches_reserved": e.launches_reserved,
                        })
                    });
                serde_json::json!({
                    "policy": self.work.policy(&self.project_id, &round.id)?,
                    "used": self.work.round_stats(&self.project_id, &round.id)?,
                    "experiments": envelope,
                })
            }
            None => serde_json::Value::Null,
        };
        let attempts = self
            .work
            .attempts(&self.project_id, work_id)?
            .into_iter()
            .rev()
            .take(BRIEF_ITEMS)
            .map(|a| {
                serde_json::json!({
                    "id": a.id, "status": a.status,
                    "failure_kind": a.failure_kind, "error": a.error,
                })
            })
            .collect();
        let stale = self
            .evidence
            .as_ref()
            .map(|e| e.stale(&self.project_id, &summary.results))
            .unwrap_or_default();
        let brief = revision.as_ref().map(|r| &r.brief);
        Ok(TaskBrief {
            work_id: work_id.to_owned(),
            title: summary.item.title.clone(),
            description: summary.item.description.clone(),
            plan: summary.item.plan.clone(),
            question: brief.map(|b| b.question.clone()),
            hypotheses: brief.map(|b| b.hypotheses.clone()).unwrap_or_default(),
            constraints: brief.map(|b| b.constraints.clone()).unwrap_or_default(),
            brief_revision: round.as_ref().map(|r| r.brief_revision),
            completion_conditions: brief
                .map(|b| b.evaluation_criteria.clone())
                .unwrap_or_default(),
            sources,
            attempts,
            experiments: experiments
                .iter()
                .take(BRIEF_ITEMS)
                .map(|e| {
                    serde_json::json!({
                        "id": e.id, "label": e.label, "state": e.state,
                        "analysis": e.analysis, "exit_code": e.exit_code,
                        "artifacts": e.artifact_revisions,
                    })
                })
                .collect(),
            decisions,
            resources,
            decision_requests: self
                .work
                .decision_requests(&self.project_id, work_id)?
                .into_iter()
                .take(BRIEF_ITEMS)
                .map(|r| {
                    serde_json::json!({
                        "id": r.id, "question": r.question, "options": r.options,
                        "state": r.state, "answer": r.answer,
                    })
                })
                .collect(),
            stale_evidence: stale,
        })
    }

    /// Shows an accepted or rejected review in the originating Thread and, for
    /// accepted work, the question's log. Never blocks the review itself.
    pub(super) fn publish_latest_review(&self, work_id: &str) -> Result<(), AgentWorkError> {
        let item = self.work.get(&self.project_id, work_id)?;
        if let Some(review) = self.work.reviews(&self.project_id, work_id)?.last() {
            let _ = self
                .orchestrator
                .publish_review(&self.project_id, &item, review);
        }
        Ok(())
    }
}
