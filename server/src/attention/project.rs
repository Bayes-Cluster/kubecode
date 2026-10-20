use std::collections::BTreeMap;

use super::types::*;
use crate::agent_runtime::PendingKind;
use crate::agent_store::RunStatus;
use crate::orchestrator::RouteKind;

/// Items one snapshot lists at most.
pub const MAX_ITEMS: usize = 200;

/// The order kinds are listed in: requests that time out first.
fn rank(detail: &AttentionDetail) -> u8 {
    match detail {
        AttentionDetail::Permission { .. } | AttentionDetail::Input { .. } => 0,
        AttentionDetail::Question { .. } => 1,
        AttentionDetail::Review { .. } => 2,
        AttentionDetail::Suggestion { .. } => 3,
        AttentionDetail::Brief { .. } => 4,
        AttentionDetail::Proposal { .. } => 5,
        AttentionDetail::Setup { .. } => 6,
    }
}

/// One item per key: a second record naming the same decision adds nothing.
fn insert<'a>(
    items: &'a mut BTreeMap<String, AttentionItem>,
    project_id: &str,
    key: String,
    created_at: &str,
    detail: AttentionDetail,
    task: Option<TaskRef>,
) -> &'a mut AttentionItem {
    items.entry(key.clone()).or_insert(AttentionItem {
        key,
        project_id: project_id.to_owned(),
        group: if matches!(detail, AttentionDetail::Setup { .. }) {
            Group::Setup
        } else {
            Group::Decision
        },
        created_at: created_at.to_owned(),
        deadline_ms: None,
        task,
        member: None,
        binding: None,
        conversation_id: None,
        session_title: None,
        detail,
    })
}

/// Composes the snapshot from plain inputs. Pure: every rule is a test row.
pub fn project(project_id: &str, cursor: u64, inputs: AttentionInputs) -> AttentionSnapshot {
    let task = |id: &str| TaskRef {
        id: id.to_owned(),
        title: inputs
            .task_titles
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.to_owned()),
    };
    // The Task a public Session works on: its newest open assignment's.
    let task_of_session = |conversation: &str| {
        inputs
            .assignments
            .iter()
            .filter(|assignment| assignment.conversation_id == conversation)
            .find_map(|assignment| assignment.research_id.as_deref())
            .map(task)
    };
    let mut items: BTreeMap<String, AttentionItem> = BTreeMap::new();

    // Permission and input requests addressed to the researcher.
    let mut waiting: Vec<(String, String)> = Vec::new();
    for (request, conversation) in &inputs.pending {
        if request.reviewer != "user" {
            continue;
        }
        let (key, detail) = match request.kind {
            PendingKind::Permission => (
                format!("permission:{}", request.request_id),
                AttentionDetail::Permission {
                    request_id: request.request_id.clone(),
                    run_id: request.run_id.clone(),
                    tool: request.tool.clone().unwrap_or_default(),
                    options: request.options.clone(),
                },
            ),
            PendingKind::Input => (
                format!("input:{}", request.request_id),
                AttentionDetail::Input {
                    request_id: request.request_id.clone(),
                    run_id: request.run_id.clone(),
                    message: request.message.clone().unwrap_or_default(),
                    schema: request.schema.clone(),
                },
            ),
        };
        let owner = inputs.owners.get(conversation);
        let task = match owner.map(|owner| owner.binding) {
            Some(BindingView::Dm) => None,
            _ => task_of_session(conversation),
        };
        let entry = insert(
            &mut items,
            project_id,
            key.clone(),
            &request.requested_at,
            detail,
            task,
        );
        entry.deadline_ms = Some(request.deadline_ms);
        entry.conversation_id = Some(conversation.clone());
        match owner {
            Some(owner) => {
                entry.member = Some(owner.member.clone());
                entry.binding = Some(owner.binding);
            }
            None => entry.session_title = inputs.session_titles.get(conversation).cloned(),
        }
        waiting.push((request.run_id.clone(), key));
    }

    // Open questions on work inside a Task.
    for open in &inputs.decisions {
        let Some(research_id) = open.research_id.as_deref() else {
            continue;
        };
        insert(
            &mut items,
            project_id,
            format!("question:{}", open.request.id),
            &open.request.created_at,
            AttentionDetail::Question {
                request_id: open.request.id.clone(),
                work_id: open.request.work_id.clone(),
                work_title: open.work_title.clone(),
                question: open.request.question.clone(),
                options: open.request.options.clone(),
                impact: open.request.impact.clone(),
            },
            Some(task(research_id)),
        );
    }
    for request in &inputs.reviews {
        insert(
            &mut items,
            project_id,
            format!("review:{}", request.id),
            &request.created_at,
            AttentionDetail::Review {
                request_id: request.id.clone(),
                brief_revision: request.brief_revision,
            },
            Some(task(&request.research_id)),
        );
    }
    // The keys the Task panel lists them under (`TaskStore::pending`).
    for entry in &inputs.suggestions {
        insert(
            &mut items,
            project_id,
            format!("suggestion:{}", entry.id),
            &entry.created_at,
            AttentionDetail::Suggestion {
                research_id: entry.research_id.clone(),
                entry_id: entry.id.clone(),
                text: entry.body.chars().take(500).collect(),
            },
            Some(task(&entry.research_id)),
        );
    }
    for brief in &inputs.briefs {
        insert(
            &mut items,
            project_id,
            format!("brief:{}:{}", brief.research_id, brief.revision),
            &brief.since,
            AttentionDetail::Brief {
                research_id: brief.research_id.clone(),
                revision: brief.revision,
                approved_revision: brief.approved_revision,
                message_id: brief.message_id.clone(),
            },
            Some(TaskRef {
                id: brief.research_id.clone(),
                title: brief.title.clone(),
            }),
        );
    }
    for proposal in &inputs.proposals {
        insert(
            &mut items,
            project_id,
            format!("proposal:{}:{}", proposal.research_id, proposal.revision),
            &proposal.created_at,
            AttentionDetail::Proposal {
                research_id: proposal.research_id.clone(),
                revision: proposal.revision,
                message_id: proposal.message_id.clone(),
            },
            Some(TaskRef {
                id: proposal.research_id.clone(),
                title: proposal.title.clone(),
            }),
        );
    }
    for (member, setup_code, since) in &inputs.setup {
        insert(
            &mut items,
            project_id,
            format!("setup:{}", member.id),
            since,
            AttentionDetail::Setup {
                member_id: member.id.clone(),
                setup_code: setup_code.clone(),
            },
            None,
        )
        .member = Some(member.clone());
    }
    let mut items: Vec<AttentionItem> = items.into_values().collect();
    items.sort_by(|a, b| {
        rank(&a.detail)
            .cmp(&rank(&b.detail))
            .then(
                a.deadline_ms
                    .unwrap_or(u64::MAX)
                    .cmp(&b.deadline_ms.unwrap_or(u64::MAX)),
            )
            .then(a.created_at.cmp(&b.created_at))
            .then(a.key.cmp(&b.key))
    });
    let truncated = items.len() > MAX_ITEMS;
    items.truncate(MAX_ITEMS);

    // Sessions working now, with what they work on and what they wait for.
    let executions = inputs
        .active_runs
        .iter()
        .map(|run| {
            let owner = inputs.owners.get(&run.conversation_id);
            let mut tasks: Vec<TaskRef> = Vec::new();
            if owner.is_none_or(|owner| owner.binding == BindingView::Public) {
                for assignment in &inputs.assignments {
                    if assignment.conversation_id == run.conversation_id
                        && let Some(id) = assignment.research_id.as_deref()
                        && tasks.iter().all(|seen| seen.id != id)
                    {
                        tasks.push(task(id));
                    }
                }
            }
            ExecutionView {
                run_id: run.run_id.clone(),
                conversation_id: run.conversation_id.clone(),
                status: run.status,
                started_at: run.started_at.clone(),
                member: owner.map(|owner| owner.member.clone()),
                binding: owner.map(|owner| owner.binding),
                session_title: owner.is_none().then(|| run.title.clone()),
                tasks,
                queued: inputs
                    .queued
                    .get(&run.conversation_id)
                    .copied()
                    .unwrap_or(0),
                waiting_keys: waiting
                    .iter()
                    .filter(|(run_id, _)| *run_id == run.run_id)
                    .map(|(_, key)| key.clone())
                    .collect(),
            }
        })
        .collect();

    // A member Session's latest turn that failed: status only.
    let failures = inputs
        .latest_runs
        .iter()
        .filter(|run| {
            matches!(
                run.status,
                RunStatus::Failed | RunStatus::TimedOut | RunStatus::Interrupted
            )
        })
        .filter_map(|run| {
            let owner = inputs.owners.get(&run.conversation_id)?;
            Some(ExecutionFailure {
                run_id: run.run_id.clone(),
                conversation_id: run.conversation_id.clone(),
                member: owner.member.clone(),
                binding: owner.binding,
                status: run.status,
                ended_at: run.at.clone(),
            })
        })
        .collect();

    // Failed routes the researcher can retry.
    let mut undelivered = UndeliveredCounts::default();
    for (kind, research_id) in &inputs.failed_routes {
        match (kind, research_id) {
            (
                RouteKind::Discussion | RouteKind::Mention | RouteKind::Ask | RouteKind::Request,
                _,
            ) => {
                undelivered.general += 1;
            }
            (RouteKind::TaskReview | RouteKind::Decision, Some(research_id)) => {
                *undelivered.tasks.entry(research_id.clone()).or_default() += 1;
            }
            _ => {}
        }
    }

    AttentionSnapshot {
        project_id: project_id.to_owned(),
        cursor,
        items,
        executions,
        failures,
        undelivered,
        incomplete: inputs.failed_sources.clone(),
        truncated,
    }
}
