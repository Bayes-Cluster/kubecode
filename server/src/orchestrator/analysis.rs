//! Experiment results, researcher decisions, and accepted outcomes (ADR 0219).
//! Every route here is identified by what it is about, so a restart, a replay,
//! or a second pass tells the responsible Session once and writes the Thread
//! and the research question once.

use rusqlite::params;

use super::*;
use crate::research_store::{AuthorKind as ResearchAuthor, EntryKind, NewEntry};
use crate::work_store::DecisionRequest;

struct Finished {
    experiment_id: String,
    project_id: String,
    round_id: String,
    task_id: String,
    label: String,
    state: String,
    exit_code: Option<i64>,
    reason: Option<String>,
}

impl Orchestrator {
    /// Finds team-less experiments of native work that ended and have not been
    /// told to anyone, tells the responsible Session once, moves the task to
    /// `analyzing`, and says so in the Thread the task came from. The
    /// experiment store keeps the analysis obligation; this only delivers it.
    pub fn route_experiments(&self) -> Result<usize, OrchestratorError> {
        let finished: Vec<Finished> = {
            let connection = self.connection();
            let mut statement = connection.prepare(
                "SELECT x.id, x.project_id, x.round_id, x.task_id, x.label, x.state, x.exit_code,
                        x.reason
                 FROM experiment_events e JOIN experiments x ON x.id = e.experiment_id
                 WHERE e.kind IN ('finished', 'reconciled') AND x.team_id IS NULL
                   AND x.task_id IS NOT NULL AND x.state != 'unknown'
                   AND NOT EXISTS (SELECT 1 FROM message_routes r
                                   WHERE r.source_kind = 'experiment' AND r.source_id = x.id)
                 GROUP BY x.id ORDER BY MIN(e.rowid) LIMIT ?1",
            )?;
            statement
                .query_map([BATCH as i64], |row| {
                    Ok(Finished {
                        experiment_id: row.get(0)?,
                        project_id: row.get(1)?,
                        round_id: row.get(2)?,
                        task_id: row.get(3)?,
                        label: row.get(4)?,
                        state: row.get(5)?,
                        exit_code: row.get(6)?,
                        reason: row.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut routed = 0;
        let mut failure = None;
        for experiment in finished {
            // One experiment that cannot be routed never blocks the others.
            match self.route_finished(&experiment) {
                Ok(true) => routed += 1,
                Ok(false) => {}
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        // A crash between creating a route and moving the task leaves the
        // route in place; the stage follows the experiment's own obligation.
        if let Err(error) = self.reconcile_analysis() {
            failure.get_or_insert(error);
        }
        if routed == 0
            && let Some(error) = failure
        {
            return Err(error);
        }
        Ok(routed)
    }

    /// Routes one ended experiment. `false` when there was nothing to tell.
    fn route_finished(&self, experiment: &Finished) -> Result<bool, OrchestratorError> {
        let item = match self.work.get(&experiment.project_id, &experiment.task_id) {
            Ok(item)
                if item.origin == crate::work_store::WorkOrigin::Native
                    && item.lifecycle == crate::work_store::WorkLifecycle::Active =>
            {
                item
            }
            // Closed or gone: nothing to tell; remember it was looked at.
            Ok(_) | Err(crate::work_store::WorkError::NotFound) => {
                self.mark_seen(experiment)?;
                return Ok(false);
            }
            // A storage hiccup is retried by the next pass, not remembered.
            Err(error) => return Err(error.into()),
        };
        let executor = self
            .work
            .assignments(&experiment.project_id, &item.id)?
            .into_iter()
            .find(|assignment| assignment.ended_at.is_none())
            .map(|assignment| assignment.conversation_id);
        let target = match executor {
            Some(session_id) => Target::Session { session_id },
            None => Target::Coordinator {
                round_id: experiment.round_id.clone(),
            },
        };
        let origin = self.origin_of(&experiment.project_id, &item)?;
        let label = if experiment.label.trim().is_empty() {
            experiment.experiment_id.clone()
        } else {
            clip(&experiment.label.replace(['\n', '\r'], " "), 80)
        };
        let exit = experiment
            .exit_code
            .map(|code| format!(" (exit code {code})"))
            .unwrap_or_default();
        let ended = format!("{}{exit}", experiment.state);
        let body = format!(
            "An experiment of task {} ({}) ended: {ended}.\n\n{}\n\nIt is owed analysis. Read \
             its logs and artifacts with kubecode-context, then record what you decide with \
             work_decide: retry, repair, follow_up, further_analysis, external_wait, \
             researcher_input, or conclude. A valid negative result is evidence, not a \
             failure; never conclude by exit code alone.",
            item.id,
            clip(&item.title, 120),
            quoted(
                "experiment label and reason",
                &format!(
                    "{label}{}",
                    experiment
                        .reason
                        .as_deref()
                        .map(|reason| format!("\n{}", clip(reason, 300)))
                        .unwrap_or_default()
                )
            ),
        );
        self.create_route(NewRoute {
            project_id: &experiment.project_id,
            kind: RouteKind::Experiment,
            source_kind: SourceKind::Experiment,
            source_id: &experiment.experiment_id,
            target,
            channel_id: origin.as_ref().map(|(channel, _)| channel.as_str()),
            thread_id: origin.as_ref().and_then(|(_, thread)| thread.as_deref()),
            work_id: Some(&item.id),
            body: &body,
        })?;
        let owed: bool = self.connection().query_row(
            "SELECT analysis = 'pending' FROM experiments WHERE id = ?1",
            [&experiment.experiment_id],
            |row| row.get(0),
        )?;
        if owed {
            self.work
                .analysis_started(&experiment.project_id, &item.id)?;
        }
        if let Some((channel_id, thread_id)) = &origin {
            self.note(
                &experiment.project_id,
                channel_id,
                thread_id.as_deref(),
                &format!("experiment:{}", experiment.experiment_id),
                &format!(
                    "An experiment of \"{}\" ended: {ended}. It is being analyzed.",
                    clip(&item.title, 120)
                ),
            )?;
        }
        self.wake();
        Ok(true)
    }

    /// Tasks with an ended experiment that still owes analysis are `analyzing`,
    /// whatever happened between routing and the stage move. Idempotent.
    fn reconcile_analysis(&self) -> Result<(), OrchestratorError> {
        let owed: Vec<(String, String)> = {
            let connection = self.connection();
            let mut statement = connection.prepare(
                "SELECT DISTINCT project_id, task_id FROM experiments
                 WHERE team_id IS NULL AND task_id IS NOT NULL AND analysis = 'pending'
                   AND state NOT IN ('reserved', 'launching', 'running')
                 LIMIT ?1",
            )?;
            statement
                .query_map([BATCH as i64], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (project_id, task_id) in owed {
            self.work.analysis_started(&project_id, &task_id)?;
        }
        // And back: nothing owed any more (a reconcile found it never ran, or
        // a decision committed before the stage moved) returns the task to its
        // executor.
        let settled: Vec<(String, String)> = {
            let connection = self.connection();
            let mut statement = connection.prepare(
                "SELECT w.project_id, w.id FROM work_items w
                 WHERE w.stage = 'analyzing' AND w.origin = 'native'
                   AND NOT EXISTS (SELECT 1 FROM experiments x
                                   WHERE x.task_id = w.id AND x.analysis = 'pending')
                 LIMIT ?1",
            )?;
            statement
                .query_map([BATCH as i64], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (project_id, task_id) in settled {
            self.work.analysis_resolved(&project_id, &task_id)?;
        }
        Ok(())
    }

    /// Remembers that an ended experiment was looked at and needs no route, so
    /// the scan never reads it again.
    fn mark_seen(&self, experiment: &Finished) -> Result<(), OrchestratorError> {
        self.connection().execute(
            "INSERT OR IGNORE INTO message_routes
               (id, project_id, kind, source_kind, source_id, target_kind, target_key, target_ref,
                work_id, body, state, last_error)
             VALUES (?1, ?2, 'experiment', 'experiment', ?3, 'session', 'skipped', '', ?4,
                     'skipped', 'failed', 'the task is closed')",
            params![
                Uuid::new_v4().to_string(),
                experiment.project_id,
                experiment.experiment_id,
                experiment.task_id,
            ],
        )?;
        Ok(())
    }

    /// Answers that were recorded but never routed (a crash between the two
    /// writes) are routed now. Closed tasks are remembered and left alone.
    pub fn route_answers(&self) -> Result<usize, OrchestratorError> {
        let pending: Vec<(String, String)> = {
            let connection = self.connection();
            let mut statement = connection.prepare(
                "SELECT d.project_id, d.id FROM decision_requests d
                 WHERE d.state = 'answered'
                   AND NOT EXISTS (SELECT 1 FROM message_routes r
                                   WHERE r.source_kind = 'decision' AND r.source_id = d.id)
                 LIMIT ?1",
            )?;
            statement
                .query_map([BATCH as i64], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut routed = 0;
        for (project_id, request_id) in pending {
            let request = self.work.decision_request(&project_id, &request_id)?;
            let open = self
                .work
                .get(&project_id, &request.work_id)
                .is_ok_and(|item| item.lifecycle == crate::work_store::WorkLifecycle::Active);
            if open {
                self.route_decision_answer(&project_id, &request)?;
                routed += 1;
            } else {
                self.connection().execute(
                    "INSERT OR IGNORE INTO message_routes
                       (id, project_id, kind, source_kind, source_id, target_kind, target_key,
                        target_ref, work_id, body, state, last_error)
                     VALUES (?1, ?2, 'decision', 'decision', ?3, 'session', 'skipped', '', ?4,
                             'skipped', 'failed', 'the task is closed')",
                    params![
                        Uuid::new_v4().to_string(),
                        project_id,
                        request.id,
                        request.work_id
                    ],
                )?;
            }
        }
        Ok(routed)
    }

    /// Shows a question put to the researcher where the work came from, with
    /// its options and what depends on it, and records it as unresolved in the
    /// question's log. Once per request; never blocks the request itself.
    pub fn announce_question(
        &self,
        project_id: &str,
        request: &DecisionRequest,
    ) -> Result<(), OrchestratorError> {
        let item = self.work.get(project_id, &request.work_id)?;
        let options = if request.options.is_empty() {
            String::new()
        } else {
            format!(
                " Options: {}.",
                request
                    .options
                    .iter()
                    .map(|option| clip(option, 80))
                    .collect::<Vec<_>>()
                    .join(" / ")
            )
        };
        let impact = request
            .impact
            .as_deref()
            .map(|impact| format!(" If this changes: {}.", clip(impact, 200)))
            .unwrap_or_default();
        let text = format!(
            "A Session needs a decision about \"{}\": {}{options}{impact}",
            clip(&item.title, 120),
            clip(&request.question, 400)
        );
        if let Some((channel_id, thread_id)) = self.origin_of(project_id, &item)? {
            self.note(
                project_id,
                &channel_id,
                thread_id.as_deref(),
                &format!("question:{}", request.id),
                &text,
            )?;
        }
        if let Some(research_id) = &item.research_id {
            let _ = self.research.add_entry(
                project_id,
                research_id,
                NewEntry {
                    kind: EntryKind::Note,
                    author_kind: ResearchAuthor::System,
                    author_ref: None,
                    body: format!("Unresolved: {text}"),
                    client_request_id: Some(format!("question:{}", request.id)),
                },
            );
        }
        Ok(())
    }

    /// Tells the Session that asked, once, what the researcher answered. The
    /// answer unblocks the task; it grants nothing beyond that.
    pub fn route_decision_answer(
        &self,
        project_id: &str,
        request: &DecisionRequest,
    ) -> Result<Option<Route>, OrchestratorError> {
        let Some(answer) = request.answer.as_deref() else {
            return Ok(None);
        };
        let item = self.work.get(project_id, &request.work_id)?;
        let origin = self.origin_of(project_id, &item)?;
        let body = format!(
            "The researcher answered your question about task {} ({}).\n\n{}\n\nThis answers the \
             question and nothing more: it does not change any limit, brief, or approval. Continue \
             the task.",
            item.id,
            clip(&item.title, 120),
            quoted("the researcher's answer", &clip(answer, 1_000)),
        );
        let (route, _) = self.create_route(NewRoute {
            project_id,
            kind: RouteKind::Decision,
            source_kind: SourceKind::Decision,
            source_id: &request.id,
            target: Target::Session {
                session_id: request.asked_by.clone(),
            },
            channel_id: origin.as_ref().map(|(channel, _)| channel.as_str()),
            thread_id: origin.as_ref().and_then(|(_, thread)| thread.as_deref()),
            work_id: Some(&item.id),
            body: &body,
        })?;
        if let Some((channel_id, thread_id)) = &origin {
            self.note(
                project_id,
                channel_id,
                thread_id.as_deref(),
                &format!("answer:{}", request.id),
                &format!(
                    "The researcher answered the question about \"{}\": {}",
                    clip(&item.title, 120),
                    clip(answer, 300)
                ),
            )?;
        }
        self.wake();
        Ok(Some(route))
    }

    /// Publishes a review decision back where the work came from: the Thread
    /// that started it and, for accepted work, the research question's log.
    /// Nothing is removed or rewritten; artifacts and histories stay. Once per
    /// review.
    pub fn publish_review(
        &self,
        project_id: &str,
        item: &WorkItem,
        review: &crate::work_store::ReviewRecord,
    ) -> Result<(), OrchestratorError> {
        let outcome = if review.accepted {
            match review.outcome {
                crate::work_store::WorkOutcome::Refuted => "accepted as a valid negative result",
                crate::work_store::WorkOutcome::Supported => {
                    "accepted: the result supports the hypothesis"
                }
                crate::work_store::WorkOutcome::Inconclusive => "accepted as inconclusive",
                crate::work_store::WorkOutcome::Unknown => "accepted",
            }
        } else {
            "sent back for changes"
        };
        let reason = review
            .reason
            .as_deref()
            .map(|reason| format!(" Reason: {}", clip(reason, 300)))
            .unwrap_or_default();
        let text = format!(
            "Task \"{}\" was {outcome}.{reason} ({} inputs reviewed.)",
            clip(&item.title, 120),
            review.inputs.len()
        );
        if let Some((channel_id, thread_id)) = self.origin_of(project_id, item)? {
            self.note(
                project_id,
                &channel_id,
                thread_id.as_deref(),
                &format!("review:{}", review.id),
                &text,
            )?;
        }
        if review.accepted
            && let Some(research_id) = &item.research_id
        {
            // The log of the question keeps the outcome beside its brief and
            // findings; a failure to write it never blocks the review.
            let _ = self.research.add_entry(
                project_id,
                research_id,
                NewEntry {
                    kind: EntryKind::Observation,
                    author_kind: ResearchAuthor::System,
                    author_ref: None,
                    body: text,
                    client_request_id: Some(format!("review:{}", review.id)),
                },
            );
        }
        Ok(())
    }
}
