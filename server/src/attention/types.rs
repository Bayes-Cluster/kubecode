//! The shapes of the attention snapshot (ADR 0232).

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use serde_json::Value;

use crate::agent_runtime::{PendingOptionView, PendingRequestView};
use crate::agent_store::{ActiveRun, LatestRun, RunStatus};
use crate::orchestrator::RouteKind;
use crate::research_store::ResearchEntry;
use crate::task_store::{AwaitingBrief, AwaitingProposal, ReviewRequest};
use crate::work_store::{OpenAssignment, OpenDecision};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TaskRef {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct MemberRef {
    pub id: String,
    pub name: String,
    pub handle: String,
    /// `general` or `specialist`.
    pub role: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    Decision,
    Setup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingView {
    Public,
    Dm,
}

/// One decision only the researcher can make, keyed by its identity.
#[derive(Clone, Debug, Serialize)]
pub struct AttentionItem {
    pub key: String,
    pub project_id: String,
    pub group: Group,
    pub created_at: String,
    pub deadline_ms: Option<u64>,
    pub task: Option<TaskRef>,
    pub member: Option<MemberRef>,
    pub binding: Option<BindingView>,
    pub conversation_id: Option<String>,
    /// A Session that is not a member's is named by its title.
    pub session_title: Option<String>,
    #[serde(flatten)]
    pub detail: AttentionDetail,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttentionDetail {
    Permission {
        request_id: String,
        run_id: String,
        tool: String,
        options: Vec<PendingOptionView>,
    },
    Input {
        request_id: String,
        run_id: String,
        message: String,
        schema: Option<Value>,
    },
    Question {
        request_id: String,
        work_id: String,
        work_title: String,
        question: String,
        options: Vec<String>,
        impact: Option<String>,
    },
    Review {
        request_id: String,
        brief_revision: u64,
    },
    /// A suggested change of direction on a Task, agreed or declined in its Results.
    Suggestion {
        research_id: String,
        entry_id: String,
        text: String,
    },
    /// A brief revised past the approved revision of an admitted Task.
    Brief {
        research_id: String,
        revision: u64,
        approved_revision: u64,
        /// The General message that showed the revision, if one did.
        message_id: Option<String>,
    },
    /// A proposal shown in General, not on the board yet.
    Proposal {
        research_id: String,
        revision: u64,
        message_id: String,
    },
    Setup {
        member_id: String,
        setup_code: Option<String>,
    },
}

/// A Session working now.
#[derive(Clone, Debug, Serialize)]
pub struct ExecutionView {
    pub run_id: String,
    pub conversation_id: String,
    pub status: RunStatus,
    pub started_at: String,
    pub member: Option<MemberRef>,
    pub binding: Option<BindingView>,
    pub session_title: Option<String>,
    pub tasks: Vec<TaskRef>,
    pub queued: u32,
    /// The keys of the requests this run waits on.
    pub waiting_keys: Vec<String>,
}

/// A member Session's latest turn that failed; only its status, never the error.
#[derive(Clone, Debug, Serialize)]
pub struct ExecutionFailure {
    pub run_id: String,
    pub conversation_id: String,
    pub member: MemberRef,
    pub binding: BindingView,
    pub status: RunStatus,
    pub ended_at: String,
}

/// Failed routes the researcher can retry: in General, and per Task.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct UndeliveredCounts {
    pub general: u32,
    pub tasks: BTreeMap<String, u32>,
}

/// A decision the project manager made on a specialist's permission request
/// (ADR 0237), shown to the researcher as information, never as a prompt.
#[derive(Clone, Debug, Serialize)]
pub struct ManagerDecisionView {
    pub id: String,
    pub request_id: String,
    pub conversation_id: String,
    pub member: Option<MemberRef>,
    pub tool: String,
    /// `approved`, `denied`, or `escalated`.
    pub decision: String,
    pub reason: String,
    pub created_at: String,
}

/// A source the snapshot could not read: never reported as "nothing waits".
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Runtime,
    Work,
    Tasks,
    Proposals,
    Members,
    Runs,
    Routes,
}

#[derive(Clone, Debug, Serialize)]
pub struct AttentionSnapshot {
    pub project_id: String,
    /// The workspace event cursor read before any source.
    pub cursor: u64,
    pub items: Vec<AttentionItem>,
    pub executions: Vec<ExecutionView>,
    pub failures: Vec<ExecutionFailure>,
    pub undelivered: UndeliveredCounts,
    pub incomplete: Vec<Source>,
    pub truncated: bool,
    /// The manager's latest permission decisions, newest first.
    pub manager_decisions: Vec<ManagerDecisionView>,
}

/// Who a Session is: its member and binding, or its title.
#[derive(Clone, Debug)]
pub struct SessionOwner {
    pub member: MemberRef,
    pub binding: BindingView,
    /// The member's current Session for that binding.
    pub current: bool,
}

/// Everything `project` reads, as plain data (filled by `collect`).
#[derive(Clone, Debug, Default)]
pub struct AttentionInputs {
    /// Pending requests whose run belongs to this Project, with the run's Session.
    pub pending: Vec<(PendingRequestView, String)>,
    pub owners: HashMap<String, SessionOwner>,
    pub session_titles: HashMap<String, String>,
    pub task_titles: HashMap<String, String>,
    pub assignments: Vec<OpenAssignment>,
    pub decisions: Vec<OpenDecision>,
    pub reviews: Vec<ReviewRequest>,
    pub proposals: Vec<AwaitingProposal>,
    /// Suggested changes of direction not decided yet.
    pub suggestions: Vec<ResearchEntry>,
    pub briefs: Vec<AwaitingBrief>,
    /// `(member, setup_code, since)` for members that need setup.
    pub setup: Vec<(MemberRef, Option<String>, String)>,
    pub active_runs: Vec<ActiveRun>,
    /// The latest run of each member Session.
    pub latest_runs: Vec<LatestRun>,
    pub queued: HashMap<String, u32>,
    /// Failed routes the researcher originated, with the Task they concern.
    pub failed_routes: Vec<(RouteKind, Option<String>)>,
    pub failed_sources: Vec<Source>,
    pub manager_decisions: Vec<ManagerDecisionView>,
}
