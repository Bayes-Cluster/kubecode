//! Read-only discovery and progressive reads over a Project's existing work
//! (ADR 0214). The reader owns no data: every answer is computed from the
//! canonical stores on demand, scoped by Project, and bounded. Reading never
//! starts an Agent, assigns work, approves a brief, or grants execution.

mod models;
#[cfg(test)]
mod tests;

pub use models::*;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::agent_store::{AgentStore, Conversation};
use crate::channel_store::{AuthorKind, ChannelStore, Message, MessageQuery, Scope, Thread};
use crate::experiment_store::{Experiment, ExperimentStore};
use crate::research_store::{Finding, LinkKind, ResearchRound, ResearchStore};
use crate::teams::{Team, TeamStore};
use crate::work_store::{WorkFilter, WorkStore, WorkSummary};
use crate::workspace::WorkspaceService;

/// Bytes of an artifact or log shown in one read.
const TEXT_READ_BYTES: usize = 8 * 1024;

pub struct ProjectContext {
    agents: Arc<AgentStore>,
    teams: Arc<TeamStore>,
    research: Arc<ResearchStore>,
    experiments: Arc<ExperimentStore>,
    work: Arc<WorkStore>,
    channels: Arc<ChannelStore>,
    workspace: Arc<WorkspaceService>,
    /// Who the direct-message Sessions are, so private conversations are never
    /// listed, resolved, or read as shared Project context (ADR 0223).
    members: Option<Arc<crate::member_store::MemberStore>>,
    /// Directory entries one file search visits.
    file_scan_entries: usize,
}

/// The kinds whose candidates come from research questions.
const RESEARCH_FAMILY: &[ContextKind] = &[
    ContextKind::Research,
    ContextKind::Import,
    ContextKind::Finding,
    ContextKind::Round,
    ContextKind::Experiment,
    ContextKind::Artifact,
];
const TEAM_FAMILY: &[ContextKind] = &[ContextKind::Team, ContextKind::TeamTask];

/// Which searched kinds were not searched completely.
struct Truncation<'a> {
    wanted: &'a dyn Fn(ContextKind) -> bool,
    kinds: BTreeSet<ContextKind>,
}

impl Truncation<'_> {
    /// Marks the searched kinds among `family`: their owner left some out.
    fn mark(&mut self, family: &[ContextKind]) {
        self.kinds
            .extend(family.iter().copied().filter(|kind| (self.wanted)(*kind)));
    }

    /// Keeps the first `SCAN_CAP` entries (callers order newest first) and
    /// marks `family` when anything was left out.
    fn cap<T>(&mut self, mut items: Vec<T>, family: &[ContextKind]) -> Vec<T> {
        if items.len() > SCAN_CAP {
            self.mark(family);
            items.truncate(SCAN_CAP);
        }
        items
    }
}

/// `YYYY-MM-DD HH:MM:SS` in UTC, the format of the stores' `CURRENT_TIMESTAMP`,
/// so file times sort among record times as plain strings.
fn utc_timestamp(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
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
        work: Arc<WorkStore>,
        channels: Arc<ChannelStore>,
        workspace: Arc<WorkspaceService>,
    ) -> Self {
        Self {
            agents,
            teams,
            research,
            experiments,
            work,
            channels,
            workspace,
            members: None,
            file_scan_entries: FILE_SCAN_ENTRIES,
        }
    }

    #[cfg(test)]
    fn with_file_scan_budget(mut self, entries: usize) -> Self {
        self.file_scan_entries = entries;
        self
    }

    /// Hides every member's direct-message Session from Project context: no
    /// search, resolve, or read reaches it, from any caller. A direct message
    /// enters the shared record only through an explicit, previewed share.
    pub fn with_members(mut self, members: Arc<crate::member_store::MemberStore>) -> Self {
        self.members = Some(members);
        self
    }

    /// Fails closed: if the roster cannot be read, nothing is shown as shared.
    fn is_private(&self, project_id: &str, conversation_id: &str) -> Result<bool, ContextError> {
        match &self.members {
            Some(members) => members
                .is_dm_session(project_id, conversation_id)
                .map_err(source_error),
            None => Ok(false),
        }
    }

    // -- Search -----------------------------------------------------------------

    /// Metadata items matching `query` (every whole word must appear in the
    /// title or summary; a file's title is its path), newest first within a
    /// relevance tier. An empty query lists recent work. An empty `kinds`
    /// searches `ContextKind::DEFAULT_SEARCH`: Project files are walked only
    /// when named. Each owner is scanned for at most `SCAN_CAP` recent
    /// candidates; the page names every kind that was cut short.
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
        let kinds = if kinds.is_empty() {
            ContextKind::DEFAULT_SEARCH
        } else {
            kinds
        };
        let wanted = |kind: ContextKind| kinds.contains(&kind);
        // A turn is read through its Session; search never lists one.
        let searched: Vec<ContextKind> = ContextKind::ALL
            .iter()
            .copied()
            .filter(|kind| wanted(*kind) && *kind != ContextKind::SessionTurn)
            .collect();
        let words: Vec<String> = query
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_lowercase)
            .take(8)
            .collect();
        let mut candidates = Vec::new();
        let mut truncation = Truncation {
            wanted: &wanted,
            kinds: BTreeSet::new(),
        };
        self.collect(project_id, &words, &mut candidates, &mut truncation)?;
        let truncated_kinds: Vec<ContextKind> = truncation.kinds.into_iter().collect();
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
        let mut counts: BTreeMap<ContextKind, usize> =
            searched.iter().map(|kind| (*kind, 0)).collect();
        for (_, item) in &scored {
            *counts.entry(item.reference.kind).or_default() += 1;
        }
        let total = scored.len();
        let mut items: Vec<ContextItem> = scored
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(_, item)| item)
            .collect();
        self.check_page(project_id, &mut items);
        let next_cursor =
            (offset + items.len() < total).then(|| encode_cursor(offset + items.len()));
        Ok(ContextPage {
            items,
            next_cursor,
            truncated: !truncated_kinds.is_empty(),
            searched,
            truncated_kinds,
            counts,
        })
    }

    /// Artifacts and files on a returned page are checked for existence with
    /// a metadata check (no hashing), so a removed one is listed as removed.
    fn check_page(&self, project_id: &str, items: &mut [ContextItem]) {
        for item in items {
            let present = match item.reference.kind {
                ContextKind::File => {
                    self.workspace
                        .execution_file_exists(project_id, None, &item.reference.id)
                }
                ContextKind::Artifact => {
                    let Some((experiment_id, path)) = item.reference.id.split_once('/') else {
                        continue;
                    };
                    self.experiment(project_id, experiment_id)
                        .ok()
                        .flatten()
                        .and_then(|experiment| self.execution_root(&experiment))
                        .is_some_and(|root| {
                            self.workspace
                                .execution_file_exists(project_id, root.as_deref(), path)
                        })
                }
                _ => continue,
            };
            if !present {
                item.availability = Availability::Removed;
            }
        }
    }

    fn collect(
        &self,
        project_id: &str,
        words: &[String],
        out: &mut Vec<ContextItem>,
        truncation: &mut Truncation<'_>,
    ) -> Result<(), ContextError> {
        let wanted = truncation.wanted;
        if RESEARCH_FAMILY.iter().copied().any(wanted) {
            // Newest first: the cap keeps the most recent candidates.
            let questions = truncation.cap(
                self.research.list(project_id, true).map_err(source_error)?,
                RESEARCH_FAMILY,
            );
            for question in &questions {
                if out.len() >= CANDIDATE_BUDGET {
                    truncation.mark(RESEARCH_FAMILY);
                    break;
                }
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
                if wanted(ContextKind::Import) {
                    for import in truncation.cap(
                        self.research
                            .imports(project_id, &question.id)
                            .map_err(source_error)?,
                        &[ContextKind::Import],
                    ) {
                        out.push(self.import_item(&import));
                    }
                }
                if wanted(ContextKind::Finding) {
                    let mut findings = self
                        .research
                        .findings(project_id, &question.id)
                        .map_err(source_error)?;
                    findings.reverse();
                    for finding in truncation.cap(findings, &[ContextKind::Finding]) {
                        out.push(self.finding_item(&finding));
                    }
                }
                let round_family = &[
                    ContextKind::Round,
                    ContextKind::Experiment,
                    ContextKind::Artifact,
                ];
                if round_family.iter().copied().any(wanted) {
                    let rounds = self
                        .research
                        .rounds(project_id, &question.id)
                        .map_err(source_error)?;
                    for round in truncation.cap(rounds, round_family) {
                        if wanted(ContextKind::Round) {
                            out.push(self.round_item(&question.title, &round));
                        }
                        if wanted(ContextKind::Experiment) || wanted(ContextKind::Artifact) {
                            let experiments = self
                                .experiments
                                .experiments(project_id, &question.id, &round.id)
                                .map_err(source_error)?;
                            for experiment in truncation.cap(
                                experiments,
                                &[ContextKind::Experiment, ContextKind::Artifact],
                            ) {
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
            conversations.reverse();
            if let Some(members) = &self.members {
                let private = members.dm_session_ids().map_err(source_error)?;
                conversations.retain(|conversation| !private.contains(&conversation.id));
            }
            for conversation in truncation.cap(conversations, &[ContextKind::Session]) {
                out.push(self.session_item(&conversation));
            }
        }
        if TEAM_FAMILY.iter().copied().any(wanted) {
            let teams = truncation.cap(
                self.teams.list_teams(project_id).map_err(source_error)?,
                TEAM_FAMILY,
            );
            for team in &teams {
                if out.len() >= CANDIDATE_BUDGET {
                    truncation.mark(TEAM_FAMILY);
                    break;
                }
                if wanted(ContextKind::Team) {
                    out.push(self.team_item(team));
                }
                if wanted(ContextKind::TeamTask) {
                    let mut tasks = self.teams.list_tasks(&team.id).map_err(source_error)?;
                    tasks.reverse();
                    for task in truncation.cap(tasks, &[ContextKind::TeamTask]) {
                        out.push(self.task_item(team, &task));
                    }
                }
            }
        }
        if wanted(ContextKind::Work) {
            let filter = WorkFilter {
                include_closed: true,
                ..WorkFilter::default()
            };
            for summary in truncation.cap(
                self.work.list(project_id, &filter).map_err(source_error)?,
                &[ContextKind::Work],
            ) {
                out.push(self.work_item(&summary));
            }
        }
        if wanted(ContextKind::Channel) || wanted(ContextKind::Thread) {
            for channel in self
                .channels
                .existing_channels(project_id)
                .map_err(source_error)?
            {
                if wanted(ContextKind::Channel) {
                    out.push(self.channel_item(&channel));
                }
                if wanted(ContextKind::Thread) {
                    for thread in truncation.cap(
                        self.channels
                            .threads(project_id, &channel.id, None)
                            .map_err(source_error)?,
                        &[ContextKind::Thread],
                    ) {
                        out.push(self.thread_item(&thread));
                    }
                }
            }
        }
        if wanted(ContextKind::File) {
            let found = self
                .workspace
                .search_project_files(project_id, words, self.file_scan_entries, FILE_HIT_CAP)
                .map_err(source_error)?;
            if found.truncated {
                truncation.mark(&[ContextKind::File]);
            }
            out.extend(
                found
                    .hits
                    .into_iter()
                    .map(|hit| file_item(&hit.path, None, hit.modified_unix.map(utc_timestamp))),
            );
        }
        Ok(())
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

    /// An imported discussion's metadata. Its revision is the digest prefix of
    /// the exact text, so a reference can tell whether it is the same words.
    fn import_item(&self, import: &crate::research_store::ResearchImport) -> ContextItem {
        ContextItem {
            reference: ContextRef::at(
                ContextKind::Import,
                &import.id,
                import.digest.chars().take(16).collect::<String>(),
            ),
            title: import.label.clone(),
            summary: summarize(&format!(
                "Imported {} discussion about brief revision {}",
                import.origin.as_str(),
                import.based_on_revision
            )),
            provenance: Provenance {
                author: Some("researcher".into()),
                updated_at: Some(import.created_at.clone()),
                research_id: Some(import.research_id.clone()),
                parent: Some(ContextRef::new(ContextKind::Research, &import.research_id)),
                state: Some("source material".into()),
            },
            availability: Availability::Available,
        }
    }

    fn finding_item(&self, finding: &Finding) -> ContextItem {
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

    /// The research question a Session or Team is linked to, only if it lives
    /// in the same Project.
    fn linked_research(&self, project_id: &str, kind: LinkKind, id: &str) -> Option<String> {
        self.research
            .link_for(kind, id)
            .ok()
            .flatten()
            .filter(|(owner, _)| owner == project_id)
            .map(|(_, link)| link.research_id)
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
                digest(&[
                    last.as_deref().unwrap_or("0"),
                    &state_label(&conversation.latest_run_status).unwrap_or_default(),
                    &conversation.title,
                    if conversation.archived {
                        "archived"
                    } else {
                        "active"
                    },
                ]),
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
                research_id: self.linked_research(
                    &conversation.project_id,
                    LinkKind::Session,
                    &conversation.id,
                ),
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
                    &team.goal,
                    team.final_summary.as_deref().unwrap_or_default(),
                ]),
            ),
            title: team.title.clone(),
            summary: summarize(&team.goal),
            provenance: Provenance {
                author: Some("agent".into()),
                updated_at: Some(team.updated_at.clone()),
                research_id: self.linked_research(&team.project_id, LinkKind::Team, &team.id),
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

    fn work_item(&self, summary: &WorkSummary) -> ContextItem {
        let item = &summary.item;
        let parent = match (&item.round_id, &item.research_id) {
            (Some(round), _) => Some(ContextRef::new(ContextKind::Round, round)),
            (None, Some(research)) => Some(ContextRef::new(ContextKind::Research, research)),
            _ => None,
        };
        ContextItem {
            reference: ContextRef::at(ContextKind::Work, &item.id, item.state_revision.to_string()),
            title: item.title.clone(),
            summary: summarize(&item.description),
            provenance: Provenance {
                author: Some("agent".into()),
                updated_at: Some(item.updated_at.clone()),
                research_id: item.research_id.clone(),
                parent,
                state: Some(format!(
                    "{} / {}",
                    item.stage.as_str(),
                    item.lifecycle.as_str()
                )),
            },
            availability: Availability::Available,
        }
    }

    fn channel_item(&self, channel: &crate::channel_store::Channel) -> ContextItem {
        ContextItem {
            reference: ContextRef::at(
                ContextKind::Channel,
                &channel.id,
                channel.last_seq.to_string(),
            ),
            title: channel.name.clone(),
            summary: format!("Workspace channel with {} messages", channel.last_seq),
            provenance: Provenance {
                author: Some("researcher".into()),
                updated_at: Some(channel.created_at.clone()),
                state: channel.is_default.then(|| "default".to_owned()),
                ..Provenance::default()
            },
            availability: Availability::Available,
        }
    }

    /// A Thread's revision changes with every reply and every link change.
    fn thread_item(&self, thread: &Thread) -> ContextItem {
        ContextItem {
            reference: ContextRef::at(
                ContextKind::Thread,
                &thread.id,
                digest(&[&thread.last_seq.to_string(), &thread.revision.to_string()]),
            ),
            title: thread.title.clone(),
            summary: format!(
                "Thread with {} replies{}",
                thread.reply_count,
                if thread.research_id.is_some() {
                    ", linked to a research question"
                } else {
                    ""
                }
            ),
            provenance: Provenance {
                author: Some("researcher".into()),
                updated_at: Some(thread.updated_at.clone()),
                research_id: thread.research_id.clone(),
                parent: Some(ContextRef::new(ContextKind::Channel, &thread.channel_id)),
                state: Some(if thread.research_id.is_some() {
                    "linked".into()
                } else {
                    "open".into()
                }),
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
        task.plan.as_deref().unwrap_or_default(),
        &task.description,
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
        experiment.reason.as_deref().unwrap_or_default(),
        if experiment.cancel_requested {
            "cancel"
        } else {
            ""
        },
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
        E::NotFound | E::RoundNotFound | E::RevisionNotFound(_) | E::ImportNotFound
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

const CHANGED_NOTE: &str =
    "This source changed after the revision that was referenced; showing its current state.";

/// A Project-relative file path: no leading `/`, no `\` or NUL, no empty,
/// `.` or `..` component, and never inside a `.git` directory. Other dot
/// paths are readable when named explicitly but are never listed.
fn valid_file_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && !id.starts_with('/')
        && !id.contains(['\\', '\0'])
        && id.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.eq_ignore_ascii_case(".git")
        })
}

/// The path is not a regular file reached through no symlink in this Project.
fn file_missing(error: &crate::workspace::WorkspaceError) -> bool {
    use crate::workspace::WorkspaceError as E;
    match error {
        E::InvalidPath(_) => true,
        E::Io(error) => matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
        ),
        _ => false,
    }
}

fn file_item(path: &str, revision: Option<String>, updated_at: Option<String>) -> ContextItem {
    ContextItem {
        reference: ContextRef {
            kind: ContextKind::File,
            id: path.to_owned(),
            revision,
        },
        title: path.to_owned(),
        // No server-authored prose: the path is the whole description.
        summary: String::new(),
        provenance: Provenance {
            updated_at,
            ..Provenance::default()
        },
        availability: Availability::Available,
    }
}

/// A short tag of a file revision, carried by a file cursor.
fn revision_tag(revision: &str) -> String {
    hex::encode(Sha256::digest(revision.as_bytes()))[..16].to_owned()
}

fn encode_file_cursor(offset: u64, revision: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!("f:{offset}:{}", revision_tag(revision)))
}

/// `None` for the first page; the byte offset and revision tag otherwise.
fn decode_file_cursor(cursor: Option<&str>) -> Result<Option<(u64, String)>, ContextError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| {
            let rest = text.strip_prefix("f:")?;
            let (offset, tag) = rest.split_once(':')?;
            let offset = offset.parse().ok()?;
            (tag.len() == 16 && tag.bytes().all(|b| b.is_ascii_hexdigit()))
                .then(|| (offset, tag.to_owned()))
        })
        .map(Some)
        .ok_or(ContextError::Invalid("the cursor is not valid"))
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
            shown_revision: item.reference.revision.clone(),
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

    /// A section whose text is kept exactly as given. Paged text must not be
    /// trimmed: the whitespace at a page boundary (a newline, an indent) is
    /// part of the text, and dropping it would corrupt Markdown and code.
    fn section_verbatim(&mut self, heading: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        let (text, truncated) = clip(text, SECTION_CHARS);
        self.sections.push(Section {
            heading: heading.to_owned(),
            text,
            truncated,
        });
    }

    fn list(&mut self, heading: &str, lines: &[String]) {
        self.section(heading, &lines.join("\n"));
    }

    /// Keeps the whole document within `MAX_DOCUMENT_CHARS`: later sections
    /// are cut or dropped, and the cut is flagged.
    fn bound(&mut self) {
        let mut budget = MAX_DOCUMENT_CHARS;
        let mut cut = false;
        for section in &mut self.sections {
            let (text, truncated) = clip(&section.text, budget);
            budget -= text.chars().count();
            if truncated {
                section.text = text;
                section.truncated = true;
                cut = true;
            }
        }
        if cut {
            self.notes
                .push("Some sections were cut to keep this read within its size limit.".into());
        }
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
        if reference.kind == ContextKind::Research
            && reference
                .revision
                .as_deref()
                .is_some_and(|revision| revision.parse::<u64>().is_err())
        {
            return Err(ContextError::Invalid("a research revision is a number"));
        }
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
            ContextKind::Import => {
                missing(self.research.import_by_id(project_id, id), research_missing)?
                    .map(|(import, _)| self.import_item(&import))
            }
            ContextKind::Finding => {
                missing(self.research.finding(project_id, id), research_missing)?
                    .map(|finding| self.finding_item(&finding))
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
            ContextKind::Work => match self.work.summary(project_id, id) {
                Ok(summary) => Some(self.work_item(&summary)),
                Err(crate::work_store::WorkError::NotFound) => None,
                Err(error) => return Err(source_error(error)),
            },
            ContextKind::Thread => match self.channels.thread(project_id, id) {
                Ok(thread) => Some(self.thread_item(&thread)),
                Err(crate::channel_store::ChannelError::ThreadNotFound) => None,
                Err(error) => return Err(source_error(error)),
            },
            ContextKind::Channel => match self.channels.channel(project_id, id) {
                Ok(channel) => Some(self.channel_item(&channel)),
                Err(crate::channel_store::ChannelError::NotFound) => None,
                Err(error) => return Err(source_error(error)),
            },
            ContextKind::File => self.file_lookup(project_id, id)?,
        })
    }

    /// A Project file by its Project-relative path, with its current
    /// fingerprint (the one work evidence pins), or `None` when the path is
    /// not a readable regular file reached through no symlink.
    fn file_lookup(&self, project_id: &str, id: &str) -> Result<Option<ContextItem>, ContextError> {
        if !valid_file_id(id) {
            return Ok(None);
        }
        match self.workspace.execution_file_revision(project_id, None, id) {
            Ok(revision) => Ok(Some(file_item(id, Some(revision), None))),
            Err(error) if file_missing(&error) => Ok(None),
            Err(error) => Err(source_error(error)),
        }
    }

    fn conversation(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Option<Conversation>, ContextError> {
        if self.is_private(project_id, id)? {
            return Ok(None);
        }
        self.agents
            .visible_conversation(project_id, id)
            .map_err(source_error)
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
        let current = self.execution_root(&experiment).and_then(|root| {
            self.workspace
                .execution_file_revision(project_id, root.as_deref(), path)
                .ok()
        });
        let mut item = self.artifact_item(&experiment, path, current.as_deref());
        if current.is_none() {
            item.availability = Availability::Removed;
        }
        Ok(Some(item))
    }

    /// Where the experiment's process ran: `Some(None)` is the Project root,
    /// `Some(Some(path))` a Team worktree. `None` means the Team that owned
    /// the run is gone, so its worktree cannot be located and the Project's
    /// same-named files must not be substituted.
    fn execution_root(&self, experiment: &Experiment) -> Option<Option<String>> {
        match experiment.team_id.as_deref() {
            None => Some(None),
            Some(team_id) => self
                .teams
                .get_team(team_id)
                .ok()
                .map(|team| team.workspace_path),
        }
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
                        title: None,
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
                            title: Some(item.title),
                        }
                    }
                })
            })
            .collect()
    }

    /// The references a researcher posts, each pinned to a version (ADR 0231
    /// §5): a reference without a revision gets its current one, a supplied
    /// revision is kept (it is what the researcher saw, even if the record
    /// changed since), and a record that no longer exists here is refused.
    pub fn pin(
        &self,
        project_id: &str,
        refs: &[ContextRef],
    ) -> Result<Vec<ContextRef>, ContextError> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        self.resolve(project_id, refs)?
            .into_iter()
            .map(|resolved| match resolved.availability {
                Availability::Removed => Err(ContextError::Invalid(
                    "a referenced record no longer exists",
                )),
                _ => Ok(ContextRef {
                    revision: resolved.reference.revision.or(resolved.current_revision),
                    ..resolved.reference
                }),
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
        let item = if reference.kind == ContextKind::File {
            // A metadata check only: the page read below fingerprints the file
            // from the same descriptor as its text.
            valid_id(&reference.id)?;
            (valid_file_id(&reference.id)
                && self
                    .workspace
                    .execution_file_exists(project_id, None, &reference.id))
            .then(|| file_item(&reference.id, None, None))
        } else {
            self.lookup(project_id, reference)?
        }
        .ok_or(ContextError::NotFound)?;
        let availability = match &item.reference.revision {
            _ if item.availability == Availability::Removed => Availability::Removed,
            // A file's fingerprint arrives with its page, below.
            None if reference.kind == ContextKind::File => Availability::Available,
            current => compare(
                reference.revision.as_deref(),
                current.as_deref().unwrap_or_default(),
            ),
        };
        let mut doc = ContextDocument::new(&item, detail, availability);
        doc.section("Summary", &item.summary);
        if availability == Availability::Changed {
            doc.note(CHANGED_NOTE);
        }
        let depth = level(detail);
        match reference.kind {
            ContextKind::Research => self.read_research(project_id, reference, depth, &mut doc)?,
            ContextKind::Round => self.read_round(project_id, &reference.id, depth, &mut doc)?,
            ContextKind::Import => {
                self.read_import(project_id, &reference.id, depth, cursor, &mut doc)?
            }
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
            ContextKind::Artifact => self.read_artifact(
                project_id,
                &reference.id,
                reference.revision.as_deref(),
                depth,
                &mut doc,
            )?,
            ContextKind::Work => self.read_work(project_id, &reference.id, depth, &mut doc)?,
            ContextKind::Thread => {
                self.read_thread(project_id, &reference.id, depth, cursor, &mut doc)?
            }
            ContextKind::Channel => {
                self.read_channel(project_id, &reference.id, depth, cursor, &mut doc)?
            }
            ContextKind::File => {
                self.read_file(project_id, reference, cursor, &mut doc)?;
            }
        }
        if doc.availability == Availability::Removed {
            doc.shown_revision = None;
        }
        doc.bound();
        Ok(doc)
    }

    /// One page of a Project file. The cursor carries the offset and a tag of
    /// the revision it was issued for, so a file that changes between pages
    /// is reported as changed and two versions are never spliced together.
    fn read_file(
        &self,
        project_id: &str,
        reference: &ContextRef,
        cursor: Option<&str>,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let position = decode_file_cursor(cursor)?;
        let offset = position.as_ref().map_or(0, |(offset, _)| *offset);
        let requested = reference.revision.as_deref();
        match self.workspace.read_text_page(
            project_id,
            None,
            &reference.id,
            offset,
            TEXT_READ_BYTES,
        ) {
            Ok(page) => {
                doc.reference.revision = Some(page.revision.clone());
                if let Some((_, tag)) = &position
                    && *tag != revision_tag(&page.revision)
                {
                    doc.availability = Availability::Changed;
                    doc.shown_revision = None;
                    doc.note(
                        "The file changed while it was being read; reopen it to read the current version.",
                    );
                    return Ok(());
                }
                doc.availability = compare(requested, &page.revision);
                if doc.availability == Availability::Changed {
                    doc.note(CHANGED_NOTE);
                }
                doc.section_verbatim("Content", &page.text);
                if let Some(next) = page.next_offset {
                    doc.next_cursor = Some(encode_file_cursor(next, &page.revision));
                    doc.note(format!(
                        "Showing bytes {}–{} of {}; read again with next_cursor for the rest.",
                        offset + 1,
                        next,
                        page.size
                    ));
                }
                doc.shown_revision = Some(page.revision);
            }
            Err(crate::workspace::WorkspaceError::UnsupportedText) => {
                // Nothing is shown, but the reader saw this version of it.
                match self
                    .workspace
                    .execution_file_revision(project_id, None, &reference.id)
                {
                    Ok(revision) => {
                        doc.availability = compare(requested, &revision);
                        doc.reference.revision = Some(revision.clone());
                        doc.shown_revision = Some(revision);
                    }
                    Err(_) => doc.availability = Availability::Removed,
                }
                doc.note("The file is not UTF-8 text, so no content is shown.");
            }
            Err(_) => {
                // Gone or unreadable between lookup and read: not usable context.
                doc.availability = Availability::Removed;
                doc.note("The file could not be read; it may have been removed.");
            }
        }
        Ok(())
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
                    .map_err(|error| match error {
                        crate::research_store::ResearchError::RevisionNotFound(_) => {
                            ContextError::NotFound
                        }
                        other => source_error(other),
                    })?;
                brief = old.brief;
                doc.shown_revision = Some(pinned.to_string());
                if let Some(first) = doc.sections.first_mut() {
                    first.text = summarize(&brief.question);
                }
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
                    .map(|f| self.finding_item(f)),
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

    fn read_import(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        cursor: Option<&str>,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let (import, content) = self
            .research
            .import_by_id(project_id, id)
            .map_err(source_error)?;
        doc.note(
            "Imported discussion: attributed source material from outside Kubecode, not a verified finding and not an approved change to the brief.",
        );
        if let Ok(question) = self.research.get(project_id, &import.research_id) {
            if import.based_on_revision < question.revision {
                doc.note(format!(
                    "This discussion was about brief revision {}; the current approved brief is revision {}.",
                    import.based_on_revision, question.revision
                ));
            }
            doc.related.push(self.research_item(
                &question.id,
                &question.brief.title,
                &question.brief.question,
                question.revision,
                &question.updated_at,
                state_label(&question.status),
            ));
        }
        if depth >= 1 {
            // An import can be 64 KiB; read it a section at a time. The cursor
            // is a character offset, so every part of a long discussion is
            // reachable, not only its first section.
            let total = content.chars().count();
            let start = decode_cursor(cursor)?;
            if start > total {
                return Err(ContextError::Invalid(
                    "the cursor is past the end of the text",
                ));
            }
            let end = (start + SECTION_CHARS).min(total);
            let part: String = content.chars().skip(start).take(end - start).collect();
            doc.section_verbatim(
                &format!(
                    "Imported text (characters {}–{} of {total})",
                    start + 1,
                    end
                ),
                &part,
            );
            if end < total {
                doc.next_cursor = Some(encode_cursor(end));
                doc.note("The imported text continues; read again with next_cursor for the rest.");
            }
        }
        if depth >= 2 {
            let lines: Vec<String> = crate::research_store::extract_candidates(&content)
                .iter()
                .take(crate::research_store::MAX_IMPORT_CANDIDATES)
                .map(|candidate| {
                    format!(
                        "{} (line {}): {}",
                        state_label(&candidate.kind)
                            .unwrap_or_default()
                            .replace('_', " "),
                        candidate.line,
                        candidate.text
                    )
                })
                .collect();
            doc.list("Candidates found in the text", &lines);
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

    fn read_work(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let summary = self
            .work
            .summary(project_id, id)
            .map_err(|error| match error {
                crate::work_store::WorkError::NotFound => ContextError::NotFound,
                other => source_error(other),
            })?;
        let item = &summary.item;
        doc.section(
            "State",
            &format!(
                "stage: {}\ncondition: {}{}\nlifecycle: {}\nacceptance: {}\noutcome: {}",
                item.stage.as_str(),
                item.condition.as_str(),
                item.condition_reason
                    .as_deref()
                    .map(|reason| format!(" ({reason})"))
                    .unwrap_or_default(),
                item.lifecycle.as_str(),
                item.acceptance.as_str(),
                item.outcome.as_str(),
            ),
        );
        if let Some(round) = &item.round_id
            && let Ok(Some(round_item)) =
                self.lookup(project_id, &ContextRef::new(ContextKind::Round, round))
        {
            doc.related.push(round_item);
        }
        if depth >= 1 {
            doc.section("Description", &item.description);
            if let Some(plan) = &item.plan {
                doc.section("Plan", plan);
            }
            if let Some(result) = &item.result {
                doc.section("Result", result);
            }
            let results: Vec<String> = summary
                .results
                .iter()
                .map(|result| format!("{} {}:{}", result.role.as_str(), result.kind, result.ref_id))
                .collect();
            doc.list("Evidence and results", &results);
        }
        if depth >= 2 {
            if let Some(verification) = &item.verification {
                doc.section("Verification", verification);
            }
            doc.list(
                "Depends on",
                &summary
                    .dependency_states
                    .iter()
                    .map(|dependency| format!("{} ({})", dependency.id, dependency.stage.as_str()))
                    .collect::<Vec<_>>(),
            );
            if let Ok(attempts) = self.work.attempts(project_id, id) {
                doc.list(
                    "Attempts",
                    &attempts
                        .iter()
                        .map(|attempt| format!("{} [{}]", attempt.id, attempt.status.as_str()))
                        .collect::<Vec<_>>(),
                );
            }
        }
        Ok(())
    }

    /// Messages as `#seq author: text`, oldest first, with who wrote each. A
    /// body's own line breaks are indented so no message can pose as another
    /// author's line.
    fn message_lines(&self, project_id: &str, messages: &[Message]) -> Vec<String> {
        messages
            .iter()
            .map(|message| {
                let author = match message.author_kind {
                    AuthorKind::Researcher => "researcher".to_owned(),
                    AuthorKind::System => "system".to_owned(),
                    AuthorKind::Agent => message
                        .author_ref
                        .as_deref()
                        .and_then(|session| {
                            self.agents
                                .visible_conversation(project_id, session)
                                .ok()
                                .flatten()
                        })
                        .map(|conversation| {
                            let title: String = conversation
                                .title
                                .split_whitespace()
                                .collect::<Vec<_>>()
                                .join(" ");
                            format!("agent {title}")
                        })
                        .unwrap_or_else(|| "agent".to_owned()),
                };
                let (text, _) = clip(&message.body, 1_500);
                let text = text.replace('\n', "\n    ");
                format!("#{} {author}: {text}", message.seq)
            })
            .collect()
    }

    /// One page of a scope's messages that fits a section: the newest that fit
    /// are shown, and the cursor starts at the oldest one shown, so nothing is
    /// cut from view and older messages stay reachable.
    fn read_messages(
        &self,
        project_id: &str,
        channel_id: &str,
        scope: Scope<'_>,
        cursor: Option<&str>,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let before_seq = match cursor {
            Some(_) => Some(decode_cursor(cursor)? as u64),
            None => None,
        };
        let page = self
            .channels
            .messages(
                project_id,
                channel_id,
                MessageQuery {
                    scope,
                    before_seq,
                    after_seq: None,
                    limit: Some(TURN_PAGE * 2),
                    task: None,
                },
            )
            .map_err(source_error)?;
        let lines = self.message_lines(project_id, &page.messages);
        let mut budget = SECTION_CHARS;
        let mut shown = 0;
        for line in lines.iter().rev() {
            let cost = line.chars().count() + 1;
            if cost > budget && shown > 0 {
                break;
            }
            budget = budget.saturating_sub(cost);
            shown += 1;
        }
        let first_shown = lines.len() - shown;
        doc.section_verbatim("Messages (oldest first)", &lines[first_shown..].join("\n"));
        let older = first_shown > 0 || page.has_more;
        if older && let Some(oldest) = page.messages.get(first_shown) {
            doc.next_cursor = Some(encode_cursor(oldest.seq as usize));
            doc.note("Older messages exist; read again with next_cursor for them.");
        }
        Ok(())
    }

    fn read_thread(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        cursor: Option<&str>,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let thread = self
            .channels
            .thread(project_id, id)
            .map_err(|error| match error {
                crate::channel_store::ChannelError::ThreadNotFound => ContextError::NotFound,
                other => source_error(other),
            })?;
        doc.note(
            "Workspace conversation: attributed discussion, not verified findings and not an approved change to any brief.",
        );
        match &thread.research_id {
            Some(research_id) => {
                if let Ok(question) = self.research.get(project_id, research_id) {
                    doc.related.push(self.research_item(
                        &question.id,
                        &question.brief.title,
                        &question.brief.question,
                        question.revision,
                        &question.updated_at,
                        state_label(&question.status),
                    ));
                }
            }
            None => doc.note("This Thread is not linked to a research question."),
        }
        if depth >= 1 {
            self.read_messages(
                project_id,
                &thread.channel_id,
                Scope::Thread(id),
                cursor,
                doc,
            )?;
        }
        Ok(())
    }

    fn read_channel(
        &self,
        project_id: &str,
        id: &str,
        depth: u8,
        cursor: Option<&str>,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        self.channels
            .channel(project_id, id)
            .map_err(|error| match error {
                crate::channel_store::ChannelError::NotFound => ContextError::NotFound,
                other => source_error(other),
            })?;
        doc.note(
            "Workspace conversation: a channel can hold several research topics. Read a Thread for one topic's context.",
        );
        for thread in self
            .channels
            .threads(project_id, id, None)
            .map_err(source_error)?
            .iter()
            .take(10)
        {
            doc.related.push(self.thread_item(thread));
        }
        if depth >= 1 {
            self.read_messages(project_id, id, Scope::Channel, cursor, doc)?;
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
            let root = self.execution_root(&experiment);
            let lines: Vec<String> = experiment
                .artifact_revisions
                .iter()
                .map(|artifact| {
                    let now = root.as_ref().and_then(|root| {
                        self.workspace
                            .execution_file_revision(project_id, root.as_deref(), &artifact.path)
                            .ok()
                    });
                    let status = match (&artifact.revision, &now) {
                        _ if root.is_none() => "unavailable: the Team that ran it is gone",
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
        requested: Option<&str>,
        depth: u8,
        doc: &mut ContextDocument,
    ) -> Result<(), ContextError> {
        let (experiment_id, path) = id.split_once('/').ok_or(ContextError::NotFound)?;
        let experiment = self
            .experiment(project_id, experiment_id)?
            .ok_or(ContextError::NotFound)?;
        doc.related.push(self.experiment_item(&experiment));
        if depth >= 1 {
            let Some(root) = self.execution_root(&experiment) else {
                doc.note("The Team that ran this experiment no longer exists, so its files cannot be located.");
                return Ok(());
            };
            match self.workspace.read_execution_text(
                project_id,
                root.as_deref(),
                path,
                TEXT_READ_BYTES,
            ) {
                Ok((text, truncated, revision)) => {
                    // The revision comes from the bytes just read, so the
                    // reference and the text always agree.
                    doc.availability = compare(requested, &revision);
                    doc.shown_revision = Some(revision.clone());
                    doc.reference.revision = Some(revision);
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
                Err(_) => {
                    // Gone or unreadable between lookup and read: not usable context.
                    doc.availability = Availability::Removed;
                    doc.note("The file could not be read; it may have been removed.");
                }
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
            SourceKind::Import => ContextKind::Import,
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
        let reference = ContextRef {
            kind,
            id: source.id.clone(),
            revision: source.revision.clone(),
        };
        match self.lookup(project_id, &reference) {
            Ok(Some(item)) => compare(
                source.revision.as_deref(),
                item.reference.revision.as_deref().unwrap_or_default(),
            ),
            _ => Availability::Removed,
        }
    }
}
