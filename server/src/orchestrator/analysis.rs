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
                   AND x.task_id IS NOT NULL
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
        for experiment in finished {
            let item = match self.work.get(&experiment.project_id, &experiment.task_id) {
                Ok(item)
                    if item.origin == crate::work_store::WorkOrigin::Native
                        && item.lifecycle == crate::work_store::WorkLifecycle::Active =>
                {
                    item
                }
                // Closed or gone: nothing to tell; remember it was looked at.
                _ => {
                    self.mark_seen(&experiment)?;
                    continue;
                }
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
            self.work
                .analysis_started(&experiment.project_id, &item.id)?;
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
            routed += 1;
        }
        Ok(routed)
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
