//! The Task commands of the Workspace members (ADR 0221): the General Agent
//! proposes and refines Tasks, admits one when the researcher told it to, lets
//! it execute, and asks for review; specialists may propose. Authority is
//! read from the roster on every call; the server checks who said what and
//! when, the General Agent judges what the words meant.

use serde::Serialize;

use super::{AgentWorkError, WorkAgent, invalid};
use crate::channel_store::{AuthorKind, Message, MessageQuery, Scope};
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
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskList {
    pub tasks: Vec<TaskCard>,
    pub drafts: Vec<Draft>,
}

impl WorkAgent {
    fn tasks(&self) -> Result<&std::sync::Arc<crate::task_store::TaskStore>, AgentWorkError> {
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
        Ok(self
            .tasks()?
            .request_review(
                &self.project_id,
                &self.caller,
                research_id,
                summary,
                evidence,
            )?
            .0)
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
        Ok(page
            .messages
            .iter()
            .map(|message| self.view(message, members))
            .collect())
    }

    fn view(
        &self,
        message: &Message,
        members: &crate::member_store::MemberStore,
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
        }
    }
}

impl From<TaskError> for AgentWorkError {
    fn from(error: TaskError) -> Self {
        Self::Task(error)
    }
}
