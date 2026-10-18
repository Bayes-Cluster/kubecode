//! Read-only discovery and progressive reads over a Project's existing work
//! (ADR 0214). The reader owns no data: every answer is computed from the
//! canonical stores on demand, scoped by Project, and bounded. Reading never
//! starts an Agent, assigns work, approves a brief, or grants execution.

mod models;
#[cfg(test)]
mod tests;

pub use models::*;

use std::sync::Arc;

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::agent_store::{AgentStore, Conversation, ConversationRelationship};
use crate::experiment_store::{Experiment, ExperimentStore};
use crate::research_store::{Finding, LinkKind, ResearchRound, ResearchStore};
use crate::teams::{Team, TeamStore};
use crate::workspace::WorkspaceService;

/// Bytes of an artifact or log shown in one read.
const TEXT_READ_BYTES: usize = 8 * 1024;

pub struct ProjectContext {
    agents: Arc<AgentStore>,
    teams: Arc<TeamStore>,
    research: Arc<ResearchStore>,
    experiments: Arc<ExperimentStore>,
    workspace: Arc<WorkspaceService>,
}

fn digest(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())[..16].to_owned()
}

fn encode_cursor(offset: usize) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(offset.to_string())
}

fn decode_cursor(cursor: Option<&str>) -> Result<usize, ContextError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| text.parse().ok())
        .ok_or(ContextError::Invalid("the cursor is not valid"))
}

fn state_label(value: &impl serde::Serialize) -> Option<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
}

impl ProjectContext {
    pub fn new(
        agents: Arc<AgentStore>,
        teams: Arc<TeamStore>,
        research: Arc<ResearchStore>,
        experiments: Arc<ExperimentStore>,
        workspace: Arc<WorkspaceService>,
    ) -> Self {
        Self {
            agents,
            teams,
            research,
            experiments,
            workspace,
        }
    }

    // -- Search -----------------------------------------------------------------

    /// Metadata items matching `query` (every whole word must appear in the
    /// title or summary), newest first within a relevance tier. An empty query
    /// lists recent work. Each owner is scanned for at most `SCAN_CAP` recent
    /// candidates; if one had more, the page says so.
    pub fn search(
        &self,
        project_id: &str,
        query: Option<&str>,
        kinds: &[ContextKind],
        limit: Option<usize>,
        cursor: Option<&str>,
    ) -> Result<ContextPage, ContextError> {
        let limit = limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
        let offset = decode_cursor(cursor)?;
        let wanted = |kind: ContextKind| kinds.is_empty() || kinds.contains(&kind);
        let words: Vec<String> = query
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_lowercase)
            .take(8)
            .collect();
        let mut candidates = Vec::new();
        let mut truncated = false;
        self.collect(project_id, &wanted, &mut candidates, &mut truncated)?;
        let mut scored: Vec<(u8, ContextItem)> = candidates
            .into_iter()
            .filter_map(|item| {
                let title = item.title.to_lowercase();
                let haystack = format!("{title} {}", item.summary.to_lowercase());
                words
                    .iter()
                    .all(|word| haystack.contains(word.as_str()))
                    .then(|| {
                        let in_title =
                            !words.is_empty() && words.iter().all(|w| title.contains(w.as_str()));
                        (u8::from(in_title), item)
                    })
            })
            .collect();
        // Stable: collection order is already newest first per owner.
        scored.sort_by(|a, b| {
            b.0.cmp(&a.0).then_with(|| {
                b.1.provenance
                    .updated_at
                    .cmp(&a.1.provenance.updated_at)
                    .then_with(|| a.1.reference.id.cmp(&b.1.reference.id))
            })
        });
        let total = scored.len();
        let items: Vec<ContextItem> = scored
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(_, item)| item)
            .collect();
        let next_cursor =
            (offset + items.len() < total).then(|| encode_cursor(offset + items.len()));
        Ok(ContextPage {
            items,
            next_cursor,
            truncated,
        })
    }

    fn collect(
        &self,
        project_id: &str,
        wanted: &dyn Fn(ContextKind) -> bool,
        out: &mut Vec<ContextItem>,
        truncated: &mut bool,
    ) -> Result<(), ContextError> {
        let need_research = [
            ContextKind::Research,
            ContextKind::Round,
            ContextKind::Finding,
            ContextKind::Experiment,
            ContextKind::Artifact,
        ]
        .into_iter()
        .any(wanted);
        if need_research {
            let mut questions = self.research.list(project_id, true).map_err(source_error)?;
            if questions.len() > SCAN_CAP {
                *truncated = true;
                questions.truncate(SCAN_CAP);
            }
            for question in &questions {
                if wanted(ContextKind::Research) {
                    let full = self
                        .research
                        .get(project_id, &question.id)
                        .map_err(source_error)?;
                    out.push(self.research_item(
                        &question.id,
                        &full.brief.title,
                        &full.brief.question,
                        full.revision,
                        &question.updated_at,
                        state_label(&full.status),
                    ));
                }
                if wanted(ContextKind::Finding) {
                    for finding in self
                        .research
                        .findings(project_id, &question.id)
                        .map_err(source_error)?
                        .into_iter()
                        .rev()
                        .take(SCAN_CAP)
                    {
                        out.push(self.finding_item(&finding, &question.updated_at));
                    }
                }
                if [
                    ContextKind::Round,
                    ContextKind::Experiment,
                    ContextKind::Artifact,
                ]
                .into_iter()
                .any(wanted)
                {
                    for round in self
                        .research
                        .rounds(project_id, &question.id)
                        .map_err(source_error)?
                        .into_iter()
                        .take(SCAN_CAP)
                    {
                        if wanted(ContextKind::Round) {
                            out.push(self.round_item(&question.title, &round));
                        }
                        if wanted(ContextKind::Experiment) || wanted(ContextKind::Artifact) {
                            for experiment in self
                                .experiments
                                .experiments(project_id, &question.id, &round.id)
                                .map_err(source_error)?
                                .into_iter()
                                .take(SCAN_CAP)
                            {
                                if wanted(ContextKind::Experiment) {
                                    out.push(self.experiment_item(&experiment));
                                }
                                if wanted(ContextKind::Artifact) {
                                    for artifact in &experiment.artifact_revisions {
                                        out.push(self.artifact_item(
                                            &experiment,
                                            &artifact.path,
                                            artifact.revision.as_deref(),
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if wanted(ContextKind::Session) {
            let mut conversations = self
                .agents
                .list_conversations(project_id)
                .map_err(source_error)?;
            if conversations.len() > SCAN_CAP {
                *truncated = true;
                conversations.truncate(SCAN_CAP);
            }
            for conversation in &conversations {
                if self.visible_session(conversation) {
                    out.push(self.session_item(conversation));
                }
            }
        }
        if wanted(ContextKind::Team) || wanted(ContextKind::TeamTask) {
            let mut teams = self.teams.list_teams(project_id).map_err(source_error)?;
            if teams.len() > SCAN_CAP {
                *truncated = true;
                teams.truncate(SCAN_CAP);
            }
            for team in &teams {
                if wanted(ContextKind::Team) {
                    out.push(self.team_item(team));
                }
                if wanted(ContextKind::TeamTask) {
                    for task in self
                        .teams
                        .list_tasks(&team.id)
                        .map_err(source_error)?
                        .into_iter()
                        .take(SCAN_CAP)
                    {
                        out.push(self.task_item(team, &task));
                    }
                }
            }
        }
        Ok(())
    }

    /// Hidden snapshots and subagent threads are not discoverable Sessions.
    fn visible_session(&self, conversation: &Conversation) -> bool {
        !matches!(
            conversation.relationship,
            Some(ConversationRelationship::Subagent)
        )
    }

    // -- Item builders (metadata only) ---------------------------------------------

    fn research_item(
        &self,
        id: &str,
        title: &str,
        question: &str,
        revision: u64,
        updated_at: &str,
        state: Option<String>,
    ) -> ContextItem {
        ContextItem {
            reference: ContextRef::at(ContextKind::Research, id, revision.to_string()),
            title: title.to_owned(),
            summary: summarize(question),
            provenance: Provenance {
                author: Some("researcher".into()),
                updated_at: Some(updated_at.to_owned()),
                research_id: Some(id.to_owned()),
                state,
                ..Provenance::default()
            },
            availability: Availability::Available,
        }
    }

    fn finding_item(&self, finding: &Finding, updated_at: &str) -> ContextItem {
        let _ = updated_at;
        ContextItem {
            reference: ContextRef::at(ContextKind::Finding, &finding.id, "1"),
            title: format!(
                "{}: {}",
                state_label(&finding.kind)
                    .unwrap_or_default()
                    .replace('_', " "),
                summarize(&finding.statement)
                    .chars()
                    .take(60)
                    .collect::<String>()
            ),
            summary: summarize(&finding.statement),
            provenance: Provenance {
                author: state_label(&finding.author_kind),
                updated_at: Some(finding.created_at.clone()),
                research_id: Some(finding.research_id.clone()),
                parent: Some(ContextRef::new(ContextKind::Research, &finding.research_id)),
                state: state_label(&finding.basis),
            },
            availability: Availability::Available,
        }
    }

    fn round_item(&self, question_title: &str, round: &ResearchRound) -> ContextItem {
        let instruction = round
            .request
            .get("instruction")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        ContextItem {
            reference: ContextRef::at(
                ContextKind::Round,
                &round.id,
                format!(
                    "{}:{}",
                    state_label(&round.phase).unwrap_or_default(),
                    round.brief_revision
                ),
            ),
            title: format!("Round {} of {question_title}", round.round),
            summary: summarize(instruction),
            provenance: Provenance {
                author: Some("researcher".into()),
                updated_at: Some(round.updated_at.clone()),
                research_id: Some(round.research_id.clone()),
                parent: Some(ContextRef::new(ContextKind::Research, &round.research_id)),
                state: state_label(&round.phase),
            },
            availability: Availability::Available,
        }
    }

    fn session_item(&self, conversation: &Conversation) -> ContextItem {
        let (_, last) = self
            .agents
            .conversation_activity(&conversation.id)
            .unwrap_or((0, None));
        ContextItem {
            reference: ContextRef::at(
                ContextKind::Session,
                &conversation.id,
                last.unwrap_or_else(|| "0".into()),
            ),
            title: conversation.title.clone(),
            summary: summarize(&format!(
                "{} Session{}",
                state_label(&conversation.agent_id).unwrap_or_default(),
                if conversation.archived {
                    " (archived)"
                } else {
                    ""
                }
            )),
            provenance: Provenance {
                author: Some("agent".into()),
                updated_at: Some(conversation.updated_at.clone()),
                research_id: self
                    .research
                    .link_for(LinkKind::Session, &conversation.id)
                    .ok()
                    .flatten()
                    .map(|(_, link)| link.research_id),
                state: Some(if conversation.archived {
                    "archived".into()
                } else {
                    "active".into()
                }),
                ..Provenance::default()
            },
            availability: Availability::Available,
        }
    }

    fn team_item(&self, team: &Team) -> ContextItem {
        ContextItem {
            reference: ContextRef::at(
                ContextKind::Team,
                &team.id,
                digest(&[
                    &state_label(&team.status).unwrap_or_default(),
                    &team.updated_at,
                ]),
            ),
            title: team.title.clone(),
            summary: summarize(&team.goal),
            provenance: Provenance {
                author: Some("agent".into()),
                updated_at: Some(team.updated_at.clone()),
                research_id: self
                    .research
                    .link_for(LinkKind::Team, &team.id)
                    .ok()
                    .flatten()
                    .map(|(_, link)| link.research_id),
                state: state_label(&team.status),
                ..Provenance::default()
            },
            availability: Availability::Available,
        }
    }

    fn task_item(&self, team: &Team, task: &crate::teams::TeamTask) -> ContextItem {
        ContextItem {
            reference: ContextRef::at(ContextKind::TeamTask, &task.id, task_revision(task)),
            title: task.title.clone(),
            summary: summarize(&task.description),
            provenance: Provenance {
                author: Some("agent".into()),
                updated_at: Some(task.updated_at.clone()),
                parent: Some(ContextRef::new(ContextKind::Team, &team.id)),
                state: state_label(&task.status),
                ..Provenance::default()
            },
            availability: Availability::Available,
        }
    }

    fn experiment_item(&self, experiment: &Experiment) -> ContextItem {
        ContextItem {
            reference: ContextRef::at(
                ContextKind::Experiment,
                &experiment.id,
                experiment_revision(experiment),
            ),
            title: if experiment.label.is_empty() {
                summarize(&experiment.argv.join(" "))
            } else {
                experiment.label.clone()
            },
            summary: summarize(&format!(
                "{} — {}",
                experiment.argv.join(" "),
                experiment.reason.clone().unwrap_or_default()
            )),
            provenance: Provenance {
                author: Some("agent".into()),
                updated_at: experiment
                    .finished_at
                    .clone()
                    .or_else(|| Some(experiment.created_at.clone())),
                research_id: Some(experiment.research_id.clone()),
                parent: Some(ContextRef::new(ContextKind::Round, &experiment.round_id)),
                state: state_label(&experiment.state),
            },
            availability: Availability::Available,
        }
    }

    fn artifact_item(
        &self,
        experiment: &Experiment,
        path: &str,
        revision: Option<&str>,
    ) -> ContextItem {
        ContextItem {
            reference: ContextRef {
                kind: ContextKind::Artifact,
                id: format!("{}/{path}", experiment.id),
                revision: revision.map(str::to_owned),
            },
            title: path.to_owned(),
            summary: format!(
                "Artifact of experiment {}",
                if experiment.label.is_empty() {
                    &experiment.id
                } else {
                    &experiment.label
                }
            ),
            provenance: Provenance {
                author: Some("agent".into()),
                updated_at: experiment.finished_at.clone(),
                research_id: Some(experiment.research_id.clone()),
                parent: Some(ContextRef::new(ContextKind::Experiment, &experiment.id)),
                state: Some(if revision.is_some() {
                    "recorded".into()
                } else {
                    "missing at exit".into()
                }),
            },
            availability: Availability::Available,
        }
    }
}

fn task_revision(task: &crate::teams::TeamTask) -> String {
    digest(&[
        &state_label(&task.status).unwrap_or_default(),
        task.result.as_deref().unwrap_or_default(),
        task.verification.as_deref().unwrap_or_default(),
    ])
}

fn experiment_revision(experiment: &Experiment) -> String {
    digest(&[
        &state_label(&experiment.state).unwrap_or_default(),
        &state_label(&experiment.analysis).unwrap_or_default(),
        &experiment
            .exit_code
            .map(|c| c.to_string())
            .unwrap_or_default(),
    ])
}

// -- Lookup, resolve, and read -------------------------------------------------------

/// Bytes of a log tail shown with an experiment.
const LOG_TAIL_BYTES: usize = 4 * 1024;
/// Related items shown with one document.
const RELATED_CAP: usize = 20;

fn missing<T, E>(
    result: Result<T, E>,
    is_missing: impl Fn(&E) -> bool,
) -> Result<Option<T>, ContextError>
where
    E: std::fmt::Display,
{
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if is_missing(&error) => Ok(None),
        Err(error) => Err(source_error(error)),
    }
}

fn research_missing(error: &crate::research_store::ResearchError) -> bool {
    use crate::research_store::ResearchError as E;
    matches!(
        error,
        E::NotFound | E::RoundNotFound | E::RevisionNotFound(_)
    )
}

fn compare(pinned: Option<&str>, current: &str) -> Availability {
    match pinned {
        Some(pinned) if pinned != current => Availability::Changed,
        _ => Availability::Available,
    }
}

fn level(detail: Detail) -> u8 {
    match detail {
        Detail::Summary => 0,
        Detail::Content => 1,
        Detail::Evidence => 2,
    }
}

fn valid_id(id: &str) -> Result<(), ContextError> {
    if id.trim().is_empty() || id.chars().count() > MAX_ID_CHARS {
        return Err(ContextError::Invalid(
            "the reference id is empty or too long",
        ));
    }
    Ok(())
}

impl ContextDocument {
    fn new(item: &ContextItem, detail: Detail, availability: Availability) -> Self {
        Self {
            reference: item.reference.clone(),
            detail,
            title: item.title.clone(),
            availability,
            provenance: item.provenance.clone(),
            sections: Vec::new(),
            related: Vec::new(),
            next_cursor: None,
            notes: Vec::new(),
        }
    }

    fn section(&mut self, heading: &str, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        let (text, truncated) = clip(text.trim(), SECTION_CHARS);
        self.sections.push(Section {
            heading: heading.to_owned(),
            text,
            truncated,
        });
    }

    fn list(&mut self, heading: &str, lines: &[String]) {
        self.section(heading, &lines.join("\n"));
    }

    fn note(&mut self, text: impl Into<String>) {
        self.notes.push(text.into());
    }
}

impl ProjectContext {
    /// The object's metadata and **current** revision, or `None` when it does
    /// not exist in this Project.
    fn lookup(
        &self,
        project_id: &str,
        reference: &ContextRef,
    ) -> Result<Option<ContextItem>, ContextError> {
        let id = reference.id.as_str();
        valid_id(id)?;
        Ok(match reference.kind {
            ContextKind::Research => missing(self.research.get(project_id, id), research_missing)?
                .map(|q| {
                    self.research_item(
                        &q.id,
                        &q.brief.title,
                        &q.brief.question,
                        q.revision,
                        &q.updated_at,
                        state_label(&q.status),
                    )
                }),
            ContextKind::Round => {
                missing(self.research.round_by_id(project_id, id), research_missing)?.map(|round| {
                    let title = self
                        .research
                        .get(project_id, &round.research_id)
                        .map(|q| q.brief.title)
                        .unwrap_or_default();
                    self.round_item(&title, &round)
                })
            }
            ContextKind::Finding => {
                missing(self.research.finding(project_id, id), research_missing)?
                    .map(|finding| self.finding_item(&finding, &finding.created_at))
            }
            ContextKind::Session => self
                .conversation(project_id, id)?
                .map(|c| self.session_item(&c)),
            ContextKind::SessionTurn => self.turn_item(project_id, id)?,
            ContextKind::Team => self.team(project_id, id)?.map(|team| self.team_item(&team)),
            ContextKind::TeamTask => self
                .task(project_id, id)?
                .map(|(team, task)| self.task_item(&team, &task)),
            ContextKind::Experiment => self
                .experiment(project_id, id)?
                .map(|e| self.experiment_item(&e)),
            ContextKind::Artifact => self.artifact_lookup(project_id, id)?,
        })
    }

    fn conversation(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Option<Conversation>, ContextError> {
        let found = missing(self.agents.get_conversation(id), |e| {
            matches!(e, crate::agent_store::StoreError::ConversationNotFound(_))
        })?;
        Ok(found.filter(|c| c.project_id == project_id && self.visible_session(c)))
    }

    fn team(&self, project_id: &str, id: &str) -> Result<Option<Team>, ContextError> {
        let found = missing(self.teams.get_team(id), |e| {
            matches!(e, crate::teams::TeamError::TeamNotFound(_))
        })?;
        Ok(found.filter(|team| team.project_id == project_id))
    }

    fn task(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Option<(Team, crate::teams::TeamTask)>, ContextError> {
        let Some(task) = missing(self.teams.get_task(id), |e| {
            matches!(e, crate::teams::TeamError::TaskNotFound(_))
        })?
        else {
            return Ok(None);
        };
        Ok(self
            .team(project_id, &task.team_id)?
            .map(|team| (team, task)))
    }

    fn experiment(&self, project_id: &str, id: &str) -> Result<Option<Experiment>, ContextError> {
        missing(self.experiments.experiment(project_id, id), |e| {
            matches!(e, crate::experiment_store::ExperimentError::NotFound)
        })
    }

    /// `conversation_id/run_id`.
    fn turn(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<
        Option<(
            Conversation,
            crate::agent_store::AgentRun,
            crate::agent_store::TurnText,
        )>,
        ContextError,
    > {
        let Some((conversation_id, run_id)) = id.split_once('/') else {
            return Ok(None);
        };
        let Some(conversation) = self.conversation(project_id, conversation_id)? else {
            return Ok(None);
        };
        let Some(run) = missing(self.agents.get_run(run_id), |e| {
            matches!(e, crate::agent_store::StoreError::RunNotFound(_))
        })?
        else {
            return Ok(None);
        };
        if run.conversation_id != conversation.id || run.internal {
            return Ok(None);
        }
        let text = self
            .agents
            .read_turn_text(&conversation.id, run_id, SECTION_CHARS)
            .map_err(source_error)?;
        Ok(text.map(|text| (conversation, run, text)))
    }

    fn turn_item(&self, project_id: &str, id: &str) -> Result<Option<ContextItem>, ContextError> {
        Ok(self.turn(project_id, id)?.map(|(conversation, run, text)| {
            let status = state_label(&run.status).unwrap_or_default();
            ContextItem {
                reference: ContextRef::at(
                    ContextKind::SessionTurn,
                    id,
                    digest(&[&status, &text.user, &text.assistant]),
                ),
                title: format!(
                    "Turn: {}",
                    summarize(&text.user).chars().take(60).collect::<String>()
                ),
                summary: summarize(&text.user),
                provenance: Provenance {
                    author: Some("agent".into()),
                    parent: Some(ContextRef::new(ContextKind::Session, &conversation.id)),
                    state: Some(status),
                    ..Provenance::default()
                },
                availability: Availability::Available,
            }
        }))
    }

    /// An artifact's identity is `experiment_id/path`; its revision is the
    /// file's content **now**, resolved under the Team's execution root.
    fn artifact_lookup(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Option<ContextItem>, ContextError> {
        let Some((experiment_id, path)) = id.split_once('/') else {
            return Ok(None);
        };
        let Some(experiment) = self.experiment(project_id, experiment_id)? else {
            return Ok(None);
        };
        if !experiment.artifacts.iter().any(|declared| declared == path) {
            return Ok(None);
        }
        let current = self
            .workspace
            .execution_file_revision(
                project_id,
                self.workspace_path(&experiment).as_deref(),
                path,
            )
            .ok();
        let mut item = self.artifact_item(&experiment, path, current.as_deref());
        if current.is_none() {
            item.availability = Availability::Removed;
        }
        Ok(Some(item))
    }

    fn workspace_path(&self, experiment: &Experiment) -> Option<String> {
        experiment
            .team_id
            .as_deref()
            .and_then(|team_id| self.teams.get_team(team_id).ok())
            .and_then(|team| team.workspace_path)
    }

    /// The availability of a reference and its current revision.
    pub fn resolve(
        &self,
        project_id: &str,
        refs: &[ContextRef],
    ) -> Result<Vec<ResolvedRef>, ContextError> {
        if refs.len() > MAX_RESOLVE {
            return Err(ContextError::Invalid("too many references to resolve"));
        }
        refs.iter()
            .map(|reference| {
                Ok(match self.lookup(project_id, reference)? {
                    None => ResolvedRef {
                        reference: reference.clone(),
                        availability: Availability::Removed,
                        current_revision: None,
                    },
                    Some(item) => {
                        let current = item.reference.revision.clone().unwrap_or_default();
                        let availability = if item.availability == Availability::Removed {
                            Availability::Removed
                        } else {
                            compare(reference.revision.as_deref(), &current)
                        };
                        ResolvedRef {
                            reference: reference.clone(),
                            availability,
                            current_revision: item.reference.revision,
                        }
                    }
                })
            })
            .collect()
    }

    /// A progressive read: a summary first, then content, then evidence.
    pub fn read(
        &self,
        project_id: &str,
        reference: &ContextRef,
        detail: Detail,
        cursor: Option<&str>,
    ) -> Result<ContextDocument, ContextError> {
        let item = self
            .lookup(project_id, reference)?
            .ok_or(ContextError::NotFound)?;
        let current = item.reference.revision.clone().unwrap_or_default();
        let availability = if item.availability == Availability::Removed {
            Availability::Removed
        } else {
            compare(reference.revision.as_deref(), &current)
        };
        let mut doc = ContextDocument::new(&item, detail, availability);
        doc.section("Summary", &item.summary);
        if availability == Availability::Changed {
            doc.note("This source changed after the revision that was referenced; showing its current state.");
        }
        let depth = level(detail);
        match reference.kind {
            ContextKind::Research => self.read_research(project_id, reference, depth, &mut doc)?,
            ContextKind::Round => self.read_round(project_id, &reference.id, depth, &mut doc)?,
            ContextKind::Finding => {
                self.read_finding(project_id, &reference.id, depth, &mut doc)?
            }
            ContextKind::Session => {
                self.read_session(project_id, &reference.id, depth, cursor, &mut doc)?
            }
            ContextKind::SessionTurn => {
                self.read_turn(project_id, &reference.id, depth, &mut doc)?
            }
            ContextKind::Team => self.read_team(project_id, &reference.id, depth, &mut doc)?,
            ContextKind::TeamTask => self.read_task(project_id, &reference.id, depth, &mut doc)?,
            ContextKind::Experiment => {
                self.read_experiment(project_id, &reference.id, depth, &mut doc)?
            }
            ContextKind::Artifact => {
                self.read_artifact(project_id, &reference.id, depth, &mut doc)?
            }
        }
        Ok(doc)
    }

    fn read_research(
        &self,
        project_id: &str,
        reference: &ContextRef,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let question = self
            .research
            .get(project_id, &reference.id)
            .map_err(source_error)?;
        let mut brief = question.brief.clone();
        if let Some(pinned) = reference.revision.as_deref() {
            let pinned: u64 = pinned
                .parse()
                .map_err(|_| ContextError::Invalid("a research revision is a number"))?;
            if pinned < question.revision {
                let old = self
                    .research
                    .revision(project_id, &question.id, pinned)
                    .map_err(source_error)?;
                brief = old.brief;
                doc.note(format!(
                    "Showing brief revision {pinned}; the current approved brief is revision {}.",
                    question.revision
                ));
            }
        }
        doc.provenance.state = state_label(&question.status);
        if depth >= 1 {
            let mut lines = vec![format!("Question: {}", brief.question)];
            if !brief.motivation.is_empty() {
                lines.push(format!("Motivation: {}", brief.motivation));
            }
            for (label, values) in [
                ("Hypothesis", &brief.hypotheses),
                ("Constraint", &brief.constraints),
                ("Evaluation criterion", &brief.evaluation_criteria),
            ] {
                lines.extend(values.iter().map(|value| format!("{label}: {value}")));
            }
            doc.list("Approved brief", &lines);
        }
        if depth >= 2 {
            let findings = self
                .research
                .findings(project_id, &question.id)
                .map_err(source_error)?;
            let lines: Vec<String> = findings
                .iter()
                .rev()
                .take(RELATED_CAP)
                .map(|f| {
                    format!(
                        "[{} / {}] {} ({})",
                        state_label(&f.kind).unwrap_or_default(),
                        state_label(&f.basis).unwrap_or_default(),
                        summarize(&f.statement),
                        f.id
                    )
                })
                .collect();
            doc.list("Recent findings", &lines);
            if findings.len() > RELATED_CAP {
                doc.note(format!(
                    "{} older findings are available through search (kind finding).",
                    findings.len() - RELATED_CAP
                ));
            }
            doc.related.extend(
                findings
                    .iter()
                    .rev()
                    .take(RELATED_CAP)
                    .map(|f| self.finding_item(f, &question.updated_at)),
            );
            let rounds = self
                .research
                .rounds(project_id, &question.id)
                .map_err(source_error)?;
            doc.related.extend(
                rounds
                    .iter()
                    .take(RELATED_CAP)
                    .map(|round| self.round_item(&question.brief.title, round)),
            );
        }
        Ok(())
    }

    fn read_round(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let round = self
            .research
            .round_by_id(project_id, id)
            .map_err(source_error)?;
        let question = self
            .research
            .get(project_id, &round.research_id)
            .map_err(source_error)?;
        doc.related.push(self.research_item(
            &question.id,
            &question.brief.title,
            &question.brief.question,
            question.revision,
            &question.updated_at,
            state_label(&question.status),
        ));
        if round.brief_revision < question.revision {
            doc.note(format!(
                "This round used brief revision {}; the current approved brief is revision {}.",
                round.brief_revision, question.revision
            ));
        }
        if depth >= 1 {
            doc.section(
                "Round",
                &format!(
                    "Round {} ({}, {}), brief revision {}",
                    round.round,
                    state_label(&round.kind).unwrap_or_default(),
                    state_label(&round.phase).unwrap_or_default(),
                    round.brief_revision
                ),
            );
            doc.section(
                "Instruction",
                round
                    .request
                    .get("instruction")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default(),
            );
            let lines: Vec<String> = round
                .sources
                .iter()
                .map(|source| {
                    format!(
                        "{} {} ({})",
                        state_label(&source.kind).unwrap_or_default(),
                        source.id,
                        self.source_availability(project_id, source).as_str()
                    )
                })
                .collect();
            doc.list("Sources", &lines);
        }
        if depth >= 2 {
            if let Some(team_id) = &round.team_id
                && let Some(team) = self.team(project_id, team_id)?
            {
                doc.related.push(self.team_item(&team));
            }
            if let Some(session_id) = &round.session_id
                && let Some(conversation) = self.conversation(project_id, session_id)?
            {
                doc.related.push(self.session_item(&conversation));
            }
            for experiment in self
                .experiments
                .experiments(project_id, &round.research_id, &round.id)
                .map_err(source_error)?
                .iter()
                .take(RELATED_CAP)
            {
                doc.related.push(self.experiment_item(experiment));
            }
        }
        Ok(())
    }

    fn read_finding(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let finding = self
            .research
            .finding(project_id, id)
            .map_err(source_error)?;
        if depth >= 1 {
            doc.section("Statement", &finding.statement);
            doc.section(
                "Basis",
                &format!(
                    "{} (basis {}), recorded against brief revision {}",
                    state_label(&finding.kind).unwrap_or_default(),
                    state_label(&finding.basis).unwrap_or_default(),
                    finding.brief_revision
                ),
            );
            doc.note("A finding is an Agent's recorded claim, not a verified result.");
        }
        if depth >= 2 {
            let lines: Vec<String> = finding
                .evidence
                .iter()
                .map(|source| {
                    format!(
                        "{} {} ({})",
                        state_label(&source.kind).unwrap_or_default(),
                        source.id,
                        self.source_availability(project_id, source).as_str()
                    )
                })
                .collect();
            doc.list("Evidence", &lines);
        }
        if let Ok(question) = self.research.get(project_id, &finding.research_id) {
            doc.related.push(self.research_item(
                &question.id,
                &question.brief.title,
                &question.brief.question,
                question.revision,
                &question.updated_at,
                state_label(&question.status),
            ));
        }
        Ok(())
    }

    fn read_session(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        cursor: Option<&str>,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let conversation = self
            .conversation(project_id, id)?
            .ok_or(ContextError::NotFound)?;
        if depth >= 1 {
            let before = match cursor {
                Some(cursor) => Some(
                    String::from_utf8(
                        base64::engine::general_purpose::URL_SAFE_NO_PAD
                            .decode(cursor)
                            .map_err(|_| ContextError::Invalid("the cursor is not valid"))?,
                    )
                    .map_err(|_| ContextError::Invalid("the cursor is not valid"))?,
                ),
                None => None,
            };
            let (runs, has_more) = self
                .agents
                .list_runs_page(&conversation.id, before.as_deref(), TURN_PAGE)
                .map_err(|error| match error {
                    crate::agent_store::StoreError::RunNotFound(_) => {
                        ContextError::Invalid("the cursor is not valid")
                    }
                    other => source_error(other),
                })?;
            let visible: Vec<_> = runs.iter().filter(|run| !run.internal).collect();
            let lines: Vec<String> = visible
                .iter()
                .rev()
                .map(|run| {
                    format!(
                        "{} [{}] {}",
                        run.id,
                        state_label(&run.status).unwrap_or_default(),
                        summarize(&run.message)
                    )
                })
                .collect();
            doc.list("Turns (newest first)", &lines);
            if has_more && let Some(first) = runs.first() {
                doc.next_cursor =
                    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&first.id));
            }
            for run in visible.iter().rev() {
                if let Some(item) =
                    self.turn_item(project_id, &format!("{}/{}", conversation.id, run.id))?
                {
                    doc.related.push(item);
                }
            }
            if visible.iter().any(|run| {
                matches!(
                    run.status,
                    crate::agent_store::RunStatus::Running
                        | crate::agent_store::RunStatus::WaitingPermission
                )
            }) {
                doc.note("A turn in this Session is still running; its text is partial.");
            }
        }
        Ok(())
    }

    fn read_turn(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let (conversation, run, text) = self.turn(project_id, id)?.ok_or(ContextError::NotFound)?;
        doc.related.push(self.session_item(&conversation));
        if depth >= 1 {
            doc.section("Researcher / user message", &text.user);
            doc.section("Agent reply", &text.assistant);
            if text.assistant_truncated {
                doc.note("The Agent reply was cut at the read limit.");
            }
            if matches!(
                run.status,
                crate::agent_store::RunStatus::Running
                    | crate::agent_store::RunStatus::WaitingPermission
            ) {
                doc.note("This turn is still running; the reply is partial.");
            }
        }
        Ok(())
    }

    fn read_team(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let team = self.team(project_id, id)?.ok_or(ContextError::NotFound)?;
        if depth >= 1 {
            doc.section("Goal", &team.goal);
            doc.list("Acceptance criteria", &team.acceptance_criteria);
            if let Some(summary) = &team.final_summary {
                doc.section("Final summary", summary);
            }
        }
        if depth >= 2 {
            let members = self.teams.list_members(&team.id).map_err(source_error)?;
            let lines: Vec<String> = members
                .iter()
                .map(|member| {
                    format!(
                        "{} ({})",
                        member.name,
                        state_label(&member.role).unwrap_or_default()
                    )
                })
                .collect();
            doc.list("Members", &lines);
            for task in self
                .teams
                .list_tasks(&team.id)
                .map_err(source_error)?
                .iter()
                .take(MAX_PAGE)
            {
                doc.related.push(self.task_item(&team, task));
            }
        }
        Ok(())
    }

    fn read_task(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let (team, task) = self.task(project_id, id)?.ok_or(ContextError::NotFound)?;
        doc.related.push(self.team_item(&team));
        if depth >= 1 {
            doc.section("Description", &task.description);
            if let Some(plan) = &task.plan {
                doc.section("Plan", plan);
            }
            if let Some(result) = &task.result {
                doc.section("Result", result);
            }
        }
        if depth >= 2 {
            if let Some(verification) = &task.verification {
                doc.section("Verification", verification);
            }
            doc.list("Owned paths", &task.owned_paths);
            doc.list("Depends on", &task.dependencies);
        }
        Ok(())
    }

    fn read_experiment(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let experiment = self
            .experiment(project_id, id)?
            .ok_or(ContextError::NotFound)?;
        if depth >= 1 {
            doc.section(
                "Command",
                &format!(
                    "{}\n(in {})",
                    experiment.argv.join(" "),
                    if experiment.cwd.is_empty() {
                        "."
                    } else {
                        &experiment.cwd
                    }
                ),
            );
            let mut outcome = format!(
                "state {}",
                state_label(&experiment.state).unwrap_or_default()
            );
            if let Some(code) = experiment.exit_code {
                outcome.push_str(&format!(", exit code {code}"));
            }
            if let Some(reason) = &experiment.reason {
                outcome.push_str(&format!(", {reason}"));
            }
            doc.section("Outcome", &outcome);
            let workspace_path = self.workspace_path(&experiment);
            let lines: Vec<String> = experiment
                .artifact_revisions
                .iter()
                .map(|artifact| {
                    let now = self
                        .workspace
                        .execution_file_revision(
                            project_id,
                            workspace_path.as_deref(),
                            &artifact.path,
                        )
                        .ok();
                    let status = match (&artifact.revision, &now) {
                        (None, None) => "missing",
                        (None, Some(_)) => "appeared after the run",
                        (Some(_), None) => "removed",
                        (Some(a), Some(b)) if a == b => "unchanged",
                        _ => "changed since the run",
                    };
                    format!(
                        "{} ({status}) — artifact id {}/{}",
                        artifact.path, experiment.id, artifact.path
                    )
                })
                .collect();
            doc.list("Declared artifacts", &lines);
        }
        if depth >= 2 {
            for (heading, name) in [
                ("Standard output (tail)", "stdout.log"),
                ("Standard error (tail)", "stderr.log"),
            ] {
                let (text, cut) = self.log_tail(&experiment.id, name);
                if cut {
                    doc.note(format!(
                        "{heading} was cut to the last {LOG_TAIL_BYTES} bytes."
                    ));
                }
                doc.section(heading, &text);
            }
            let lines: Vec<String> = experiment
                .sources
                .iter()
                .map(|source| {
                    format!(
                        "{} {} ({})",
                        state_label(&source.kind).unwrap_or_default(),
                        source.id,
                        self.source_availability(project_id, source).as_str()
                    )
                })
                .collect();
            doc.list("Sources", &lines);
        }
        if let Ok(round) = self.research.round_by_id(project_id, &experiment.round_id)
            && let Ok(question) = self.research.get(project_id, &round.research_id)
        {
            doc.related
                .push(self.round_item(&question.brief.title, &round));
        }
        Ok(())
    }

    fn read_artifact(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let (experiment_id, path) = id.split_once('/').ok_or(ContextError::NotFound)?;
        let experiment = self
            .experiment(project_id, experiment_id)?
            .ok_or(ContextError::NotFound)?;
        doc.related.push(self.experiment_item(&experiment));
        if depth >= 1 {
            match self.workspace.read_execution_text(
                project_id,
                self.workspace_path(&experiment).as_deref(),
                path,
                TEXT_READ_BYTES,
            ) {
                Ok((text, truncated, _)) => {
                    doc.sections.push(Section {
                        heading: "Content".into(),
                        text,
                        truncated,
                    });
                    if truncated {
                        doc.note(format!(
                            "The file was cut to its first {TEXT_READ_BYTES} bytes."
                        ));
                    }
                }
                Err(crate::workspace::WorkspaceError::UnsupportedText) => {
                    doc.note("The file is not UTF-8 text, so no content is shown.");
                }
                Err(_) => doc.note("The file could not be read; it may have been removed."),
            }
        }
        Ok(())
    }

    fn log_tail(&self, experiment_id: &str, name: &str) -> (String, bool) {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(dir) = self.workspace.experiment_dir(experiment_id) else {
            return (String::new(), false);
        };
        let Ok(mut file) = std::fs::File::open(dir.join(name)) else {
            return (String::new(), false);
        };
        let total = file.metadata().map(|m| m.len()).unwrap_or(0);
        let start = total.saturating_sub(LOG_TAIL_BYTES as u64);
        let mut bytes = Vec::new();
        if file.seek(SeekFrom::Start(start)).is_err()
            || file
                .take(LOG_TAIL_BYTES as u64)
                .read_to_end(&mut bytes)
                .is_err()
        {
            return (String::new(), false);
        }
        (String::from_utf8_lossy(&bytes).into_owned(), start > 0)
    }

    /// Availability of a source cited by a round, finding, or experiment.
    fn source_availability(
        &self,
        project_id: &str,
        source: &crate::research_store::SourceRef,
    ) -> Availability {
        use crate::research_store::SourceKind;
        let kind = match source.kind {
            SourceKind::File => {
                return match self.workspace.file_revision(project_id, &source.id) {
                    Ok(current) => compare(source.revision.as_deref(), &current),
                    Err(_) => Availability::Removed,
                };
            }
            SourceKind::Session => ContextKind::Session,
            SourceKind::Team => ContextKind::Team,
            SourceKind::TeamTask => ContextKind::TeamTask,
            SourceKind::Run => {
                return if self
                    .agents
                    .get_run(&source.id)
                    .is_ok_and(|run| run.project_id == project_id)
                {
                    Availability::Available
                } else {
                    Availability::Removed
                };
            }
        };
        match self.lookup(project_id, &ContextRef::new(kind, &source.id)) {
            Ok(Some(_)) => Availability::Available,
            _ => Availability::Removed,
        }
    }
}
