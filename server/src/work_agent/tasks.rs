//! The Task commands of the Workspace members (ADR 0221): the General Agent
//! proposes and refines Tasks, admits one when the researcher told it to, lets
//! it execute, and asks for review; specialists may propose. Authority is
//! read from the roster on every call; the server checks who said what and
//! when, the General Agent judges what the words meant.

use serde::Serialize;

use super::{AgentWorkError, WorkAgent, invalid};
use crate::channel_store::{
    AuthorKind, ContextRef, Mention, Message, MessageQuery, NewMessage, Scope,
};
use crate::project_context::ContextKind;
use crate::research_store::{BriefPatch, ResearchBrief};
use crate::task_store::{Authorization, Draft, ReviewRequest, TaskCard, TaskError};

/// Messages of General shown to a member at once.
const RECENT_LIMIT: usize = 40;

#[derive(Clone, Debug, Serialize)]
pub struct Proposal {
    pub research_id: String,
    pub revision: u64,
    pub message_id: String,
}

/// A message of the General conversation as a member reads it.
#[derive(Clone, Debug, Serialize)]
pub struct GeneralMessage {
    pub id: String,
    pub seq: u64,
    /// `researcher`, `agent`, or `system`. Only `researcher` messages can authorize.
    pub author: &'static str,
    /// The writing member's @handle, for an agent.
    pub from: Option<String>,
    pub body: String,
    pub task: Vec<String>,
    pub created_at: String,
    /// The earlier message this one cites (ADR 0229 §4).
    pub reply_to: Option<String>,
    /// The @handles of the members it names, through their public Sessions
    /// only (current or ended): a private Session is never named here.
    pub to: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskList {
    pub tasks: Vec<TaskCard>,
    pub drafts: Vec<Draft>,
}

impl WorkAgent {
    fn tasks(&self) -> Result<&std::sync::Arc<crate::task_store::TaskStore>, AgentWorkError> {
        // Task commands post into General. A direct-message Session is private
        // and cannot publish there, whichever member it belongs to (ADR 0223).
        if let Some(members) = &self.members
            && members
                .is_dm_session(&self.project_id, &self.caller)
                .map_err(|error| invalid(error.to_string()))?
        {
            return Err(invalid(
                "a direct message is private; Task commands belong to the public Session",
            ));
        }
        self.tasks
            .as_ref()
            .ok_or_else(|| invalid("Tasks are not available in this Workspace"))
    }

    /// Drafts a Task for the researcher to see. Nothing is admitted or runs.
    pub fn task_propose(
        &self,
        brief: ResearchBrief,
        client_request_id: Option<&str>,
    ) -> Result<Proposal, AgentWorkError> {
        let (question, message) =
            self.tasks()?
                .propose(&self.project_id, &self.caller, brief, client_request_id)?;
        Ok(Proposal {
            research_id: question.id,
            revision: question.revision,
            message_id: message.id,
        })
    }

    /// Refines a proposal as the researcher asks; the new revision is shown.
    pub fn task_revise(
        &self,
        research_id: &str,
        expected_revision: u64,
        patch: &BriefPatch,
        note: Option<&str>,
    ) -> Result<Proposal, AgentWorkError> {
        let (question, message) = self.tasks()?.revise(
            &self.project_id,
            &self.caller,
            research_id,
            expected_revision,
            patch,
            note,
        )?;
        Ok(Proposal {
            research_id: question.id,
            revision: question.revision,
            message_id: message.id,
        })
    }

    /// Admits a Task because the researcher's message `message_id` told the
    /// General Agent to, naming the revision of the proposal they were shown.
    pub fn task_admit(
        &self,
        research_id: &str,
        message_id: &str,
        brief_revision: u64,
    ) -> Result<Authorization, AgentWorkError> {
        Ok(self
            .tasks()?
            .admit(
                &self.project_id,
                &self.caller,
                research_id,
                message_id,
                brief_revision,
            )?
            .0)
    }

    pub fn task_approve_revision(
        &self,
        research_id: &str,
        message_id: &str,
        brief_revision: u64,
    ) -> Result<Authorization, AgentWorkError> {
        Ok(self
            .tasks()?
            .approve_revision(
                &self.project_id,
                &self.caller,
                research_id,
                message_id,
                brief_revision,
            )?
            .0)
    }

    /// Lets an admitted Task execute because the researcher said so.
    pub fn task_start(
        &self,
        research_id: &str,
        message_id: &str,
    ) -> Result<Authorization, AgentWorkError> {
        Ok(self
            .tasks()?
            .start_execution(&self.project_id, &self.caller, research_id, message_id)?
            .0)
    }

    pub fn task_request_review(
        &self,
        research_id: &str,
        summary: &str,
        evidence: &[String],
    ) -> Result<ReviewRequest, AgentWorkError> {
        // Each cited record is pinned to the revision it has now, so a change
        // before the researcher decides is caught (ADR 0226). A citation of
        // something that does not exist here is refused, not carried along.
        let mut pins = std::collections::BTreeMap::new();
        if let Some(checker) = &self.evidence {
            for entry in evidence.iter().take(20) {
                // A malformed citation is refused by the store with its rule.
                let Some((kind, id)) = entry
                    .split_once(':')
                    .filter(|(kind, id)| !kind.is_empty() && !id.is_empty())
                else {
                    continue;
                };
                let revision = checker
                    .current_revision(&self.project_id, kind, id)
                    .ok_or_else(|| invalid(format!("cited evidence was not found: {entry}")))?;
                pins.insert(entry.clone(), revision);
            }
        }
        Ok(self
            .tasks()?
            .request_review(
                &self.project_id,
                &self.caller,
                research_id,
                summary,
                evidence,
                &pins,
            )?
            .0)
    }

    /// Shows a proposal again, when other proposals have been shown since or
    /// the researcher's answer was unclear, so they can answer this one.
    pub fn task_show(&self, research_id: &str) -> Result<Proposal, AgentWorkError> {
        let message = self
            .tasks()?
            .show_again(&self.project_id, &self.caller, research_id)?;
        let question = self
            .research
            .get(&self.project_id, research_id)
            .map_err(|_| AgentWorkError::NotFound)?;
        Ok(Proposal {
            research_id: question.id,
            revision: question.revision,
            message_id: message.id,
        })
    }

    /// The board and the drafts, for any member.
    pub fn task_list(&self) -> Result<TaskList, AgentWorkError> {
        let tasks = self.tasks()?;
        if self.members.as_ref().is_some_and(|members| {
            !members
                .active_role(&self.project_id, &self.caller)
                .ok()
                .flatten()
                .is_some()
        }) {
            return Err(AgentWorkError::NotFound);
        }
        Ok(TaskList {
            tasks: tasks.board(&self.project_id)?.cards,
            drafts: tasks.drafts(&self.project_id)?,
        })
    }

    /// The latest messages of the General conversation, with their ids, who
    /// wrote each, and the Tasks they cite: what a member needs to see who said
    /// what. Public by design: it is the shared conversation.
    pub fn general_recent(
        &self,
        limit: Option<usize>,
    ) -> Result<Vec<GeneralMessage>, AgentWorkError> {
        let members = self
            .members
            .as_ref()
            .ok_or_else(|| invalid("members are not available"))?;
        if members
            .active_role(&self.project_id, &self.caller)
            .map_err(|error| invalid(error.to_string()))?
            .is_none()
        {
            return Err(AgentWorkError::NotFound);
        }
        let channel = self.channels.default_channel(&self.project_id)?;
        let page = self.channels.messages(
            &self.project_id,
            &channel.id,
            MessageQuery {
                scope: Scope::All,
                limit: Some(limit.unwrap_or(RECENT_LIMIT).min(RECENT_LIMIT)),
                ..Default::default()
            },
        )?;
        // Who each mention names: presentation, so a failed lookup names no one.
        let authors = members.public_authors(&self.project_id).unwrap_or_default();
        let handles: std::collections::HashMap<String, String> = members
            .list(&self.project_id, true)
            .unwrap_or_default()
            .into_iter()
            .map(|member| (member.id, member.handle))
            .collect();
        Ok(page
            .messages
            .iter()
            .map(|message| {
                let to = message
                    .mentions
                    .iter()
                    .filter_map(|mention| authors.get(&mention.session_id))
                    .filter_map(|member_id| handles.get(member_id).cloned())
                    .collect();
                self.view(message, members, to)
            })
            .collect())
    }

    fn view(
        &self,
        message: &Message,
        members: &crate::member_store::MemberStore,
        to: Vec<String>,
    ) -> GeneralMessage {
        GeneralMessage {
            id: message.id.clone(),
            seq: message.seq,
            author: message.author_kind.as_str(),
            from: (message.author_kind == AuthorKind::Agent)
                .then_some(message.author_ref.as_deref())
                .flatten()
                .and_then(|session| {
                    members
                        .by_conversation(&self.project_id, session)
                        .ok()
                        .flatten()
                })
                .map(|resolved| resolved.member.handle),
            body: message.body.clone(),
            task: message
                .references
                .iter()
                .filter(|reference| reference.kind == crate::project_context::ContextKind::Research)
                .map(|reference| reference.id.clone())
                .collect(),
            created_at: message.created_at.clone(),
            reply_to: message.reply_to.clone(),
            to,
        }
    }
}

impl From<TaskError> for AgentWorkError {
    fn from(error: TaskError) -> Self {
        Self::Task(error)
    }
}

/// Longest list of members one General message may name.
const MAX_NAMED: usize = 4;
/// Hand-offs one member may make in an hour, however the chain is shaped.
const MAX_HANDOFFS_PER_HOUR: u32 = 12;

impl WorkAgent {
    /// Posts into the General conversation as this member, visibly and
    /// attributed (ADR 0223). Only a live member speaking from its *public*
    /// Session may: a direct-message Session is private and cannot publish.
    /// Naming members hands the message to them; the chain is bounded
    /// (`MAX_HANDOFF_HOPS`) and nothing said here authorizes a Task.
    pub fn general_post(
        &self,
        body: &str,
        handles: &[String],
        task: Option<&str>,
        reply_to: Option<&str>,
    ) -> Result<Message, AgentWorkError> {
        let members = self
            .members
            .as_ref()
            .ok_or_else(|| invalid("members are not available"))?;
        let speaker = members
            .public_member(&self.project_id, &self.caller)
            .map_err(|error| invalid(error.to_string()))?
            .ok_or_else(|| {
                invalid(
                    "only a member speaking from its public Session posts in General; \
                     a direct message is private",
                )
            })?;
        if handles.len() > MAX_NAMED {
            return Err(invalid("name at most four members in one message"));
        }
        let roster = members
            .list(&self.project_id, false)
            .map_err(|error| invalid(error.to_string()))?;
        let mut mentions: Vec<Mention> = Vec::new();
        for handle in handles {
            let handle = handle.trim().trim_start_matches('@').to_lowercase();
            let named = roster
                .iter()
                .find(|member| member.handle == handle && member.public_conversation_id.is_some())
                .ok_or_else(|| invalid(format!("no member answers to @{handle}")))?;
            if named.id == speaker.id {
                continue;
            }
            let session_id = named.public_conversation_id.clone().unwrap_or_default();
            if mentions.iter().all(|seen| seen.session_id != session_id) {
                mentions.push(Mention { session_id });
            }
        }
        let reply_to = reply_to.filter(|id| !id.trim().is_empty());
        let task = task.filter(|id| !id.trim().is_empty());
        let hops = if mentions.is_empty() {
            0
        } else {
            if self
                .channels
                .recent_handoffs(&self.project_id, &self.caller)?
                >= MAX_HANDOFFS_PER_HOUR
            {
                return Err(invalid(
                    "too many hand-offs in the last hour; ask the researcher to continue",
                ));
            }
            self.orchestrator
                .next_hops(&self.project_id, &self.caller, reply_to)?
        };
        let references: Vec<ContextRef> = task
            .map(|id| vec![ContextRef::new(ContextKind::Research, id)])
            .unwrap_or_default();
        let channel = self.channels.default_channel(&self.project_id)?;
        // The same words by the same member, with nobody else having spoken
        // since, are one message (a retry after a lost reply); the same words
        // after someone else spoke are a new one.
        let others_seq = self
            .channels
            .messages(
                &self.project_id,
                &channel.id,
                MessageQuery {
                    scope: Scope::All,
                    limit: Some(RECENT_LIMIT),
                    ..Default::default()
                },
            )?
            .messages
            .iter()
            .rev()
            .find(|message| message.author_ref.as_deref() != Some(self.caller.as_str()))
            .map_or(0, |message| message.seq);
        let key = {
            use sha2::{Digest, Sha256};
            let digest = hex::encode(Sha256::digest(
                format!(
                    "{}\u{0}{body}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
                    self.caller,
                    mentions
                        .iter()
                        .map(|mention| mention.session_id.as_str())
                        .collect::<Vec<_>>()
                        .join(","),
                    task.unwrap_or_default(),
                    reply_to.unwrap_or_default(),
                    others_seq
                )
                .as_bytes(),
            ));
            format!("general:{}", &digest[..32])
        };
        let (message, created) = self.channels.post(
            &self.project_id,
            &channel.id,
            NewMessage {
                body,
                author_kind: Some(AuthorKind::Agent),
                author_ref: Some(&self.caller),
                mentions: &mentions,
                references: &references,
                client_message_id: Some(&key),
                reply_to,
                hops,
                ..Default::default()
            },
        )?;
        if created {
            self.orchestrator.wake();
        }
        Ok(message)
    }
}
