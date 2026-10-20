use std::collections::HashMap;

use super::project::project;
use super::types::*;
use crate::app_state::AppState;
use crate::member_store::{Binding, Member, MemberState};

fn member_ref(member: &Member) -> MemberRef {
    MemberRef {
        id: member.id.clone(),
        name: member.name.clone(),
        handle: member.handle.clone(),
        role: member.role.as_str().to_owned(),
    }
}

/// Reads every source of one Workspace's snapshot (I/O only). The cursor is
/// read first, so the snapshot reflects at least the state at its cursor. A
/// source that fails is listed in `incomplete` and contributes nothing.
pub fn collect(state: &AppState, project_id: &str) -> AttentionSnapshot {
    let store = state.agent_runtime.store();
    let cursor = store.latest_workspace_event_id().unwrap_or(0);
    let mut inputs = AttentionInputs::default();
    let mut failed: Vec<Source> = Vec::new();

    // Requests waiting in the runtime, for this Project's runs.
    for request in state.agent_runtime.pending_requests() {
        if let Ok(run) = store.get_run(&request.run_id)
            && run.project_id == project_id
        {
            inputs.pending.push((request, run.conversation_id));
        }
    }

    // The roster: who each Session is, and who needs setup.
    let mut member_sessions: Vec<String> = Vec::new();
    match state.members.list(project_id, false) {
        Ok(members) => {
            for member in &members {
                for (session, binding) in [
                    (&member.public_conversation_id, BindingView::Public),
                    (&member.dm_conversation_id, BindingView::Dm),
                ] {
                    if let Some(session) = session {
                        member_sessions.push(session.clone());
                        inputs.owners.insert(
                            session.clone(),
                            SessionOwner {
                                member: member_ref(member),
                                binding,
                                current: true,
                            },
                        );
                    }
                }
                if member.state == MemberState::SetupRequired {
                    inputs.setup.push((
                        member_ref(member),
                        member.setup_code.clone(),
                        member.updated_at.clone(),
                    ));
                }
            }
        }
        Err(_) => failed.push(Source::Members),
    }

    match state.agent_runtime.store().active_runs(project_id) {
        Ok(runs) => inputs.active_runs = runs,
        Err(_) => failed.push(Source::Runs),
    }
    // A Session a member has since left still names that member.
    let mut seen: Vec<String> = inputs
        .pending
        .iter()
        .map(|(_, conversation)| conversation.clone())
        .chain(
            inputs
                .active_runs
                .iter()
                .map(|run| run.conversation_id.clone()),
        )
        .collect();
    seen.sort();
    seen.dedup();
    for conversation in &seen {
        if inputs.owners.contains_key(conversation) {
            continue;
        }
        match state.members.by_conversation(project_id, conversation) {
            Ok(Some(resolved)) => {
                inputs.owners.insert(
                    conversation.clone(),
                    SessionOwner {
                        member: member_ref(&resolved.member),
                        binding: if resolved.binding == Binding::Dm {
                            BindingView::Dm
                        } else {
                            BindingView::Public
                        },
                        current: resolved.current,
                    },
                );
            }
            Ok(None) => {
                if let Ok(Some(conversation_record)) =
                    store.visible_conversation(project_id, conversation)
                {
                    inputs
                        .session_titles
                        .insert(conversation.clone(), conversation_record.title);
                }
            }
            Err(_) => failed.push(Source::Members),
        }
    }
    let active: Vec<String> = inputs
        .active_runs
        .iter()
        .map(|run| run.conversation_id.clone())
        .collect();
    match store
        .queued_counts(&active)
        .and_then(|queued| Ok((queued, store.latest_runs(&member_sessions)?)))
    {
        Ok((queued, latest)) => {
            inputs.queued = queued;
            inputs.latest_runs = latest;
        }
        Err(_) => failed.push(Source::Runs),
    }

    match (
        state.work.open_decisions(project_id),
        state.work.open_assignments(project_id),
    ) {
        (Ok(decisions), Ok(assignments)) => {
            inputs.decisions = decisions;
            inputs.assignments = assignments;
        }
        _ => failed.push(Source::Work),
    }
    match (
        state.tasks.open_review_requests(project_id),
        state.research.list(project_id, true),
    ) {
        (Ok(reviews), Ok(questions)) => {
            inputs.reviews = reviews;
            inputs.task_titles = questions
                .into_iter()
                .map(|question| (question.id, question.title))
                .collect::<HashMap<_, _>>();
        }
        _ => failed.push(Source::Tasks),
    }
    let showings = state
        .channels
        .existing_channels(project_id)
        .and_then(
            |channels| match channels.into_iter().find(|channel| channel.is_default) {
                Some(channel) => state.channels.proposal_showings(project_id, &channel.id),
                None => Ok(HashMap::new()),
            },
        )
        .map_err(crate::task_store::TaskError::from)
        .and_then(|showings| {
            Ok((
                state.tasks.awaiting_proposals(project_id, &showings)?,
                state.tasks.awaiting_briefs(project_id, &showings)?,
            ))
        });
    match showings {
        Ok((proposals, briefs)) => {
            inputs.proposals = proposals;
            inputs.briefs = briefs;
        }
        Err(_) => failed.push(Source::Proposals),
    }
    match state.research.open_proposals(project_id) {
        Ok(suggestions) => inputs.suggestions = suggestions,
        Err(_) => failed.push(Source::Tasks),
    }
    match state.orchestrator.failed_researcher_routes(project_id) {
        Ok(routes) => inputs.failed_routes = routes,
        Err(_) => failed.push(Source::Routes),
    }
    let mut unique: Vec<Source> = Vec::new();
    for source in failed {
        if !unique.contains(&source) {
            unique.push(source);
        }
    }
    let failed = unique;
    inputs.failed_sources = failed;
    project(project_id, cursor, inputs)
}
