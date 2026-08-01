use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::{Arc, Weak};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use serde::Deserialize;
use serde_json::json;

use super::AppState;
use super::error::ApiError;
use crate::agents::{
    AgentEvent, AgentEventKind, AgentStore, RunStatus, SessionEvent, WorkspaceEvent,
};

const WORKSPACE_EVENT_RECOVERY_INTERVAL: Duration = Duration::from_secs(30);

pub(super) async fn get_workspace_event_cursor(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(json!({
        "cursor": state.agent_runtime.store().latest_workspace_event_id()?
    })))
}

pub(super) async fn get_runtime_status(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.agent_runtime.status()?))
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct EventQuery {
    #[serde(default)]
    after: u64,
}

pub(super) async fn list_agent_events(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<impl IntoResponse, ApiError> {
    state.agent_runtime.store().get_run(&run_id)?;
    Ok(Json(
        state
            .agent_runtime
            .store()
            .events_after(&run_id, query.after)?
            .into_iter()
            .map(safe_agent_event)
            .collect::<Vec<_>>(),
    ))
}

pub(super) async fn list_session_events(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(
        state
            .agent_runtime
            .store()
            .session_events_after(&conversation_id, query.after)?
            .into_iter()
            .map(safe_session_event)
            .collect::<Vec<_>>(),
    ))
}

struct AgentEventStreamState {
    store: Arc<AgentStore>,
    run_id: String,
    cursor: u64,
    pending: VecDeque<AgentEvent>,
}

struct WorkspaceEventStreamState {
    store: Weak<AgentStore>,
    wakeups: tokio::sync::watch::Receiver<u64>,
    recovery: tokio::time::Interval,
    cursor: u64,
    pending: VecDeque<WorkspaceEvent>,
}

pub(super) async fn stream_workspace_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<EventQuery>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(query.after);
    let store = state.agent_runtime.store();
    let wakeups = store.workspace_event_bus().subscribe();
    let mut recovery = tokio::time::interval_at(
        tokio::time::Instant::now() + WORKSPACE_EVENT_RECOVERY_INTERVAL,
        WORKSPACE_EVENT_RECOVERY_INTERVAL,
    );
    recovery.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let stream = futures_util::stream::unfold(
        WorkspaceEventStreamState {
            store: Arc::downgrade(&store),
            wakeups,
            recovery,
            cursor,
            pending: VecDeque::new(),
        },
        |mut state| async move {
            loop {
                if let Some(workspace_event) = state.pending.pop_front() {
                    state.cursor = workspace_event.id;
                    let workspace_event = safe_workspace_event(workspace_event);
                    let event = Event::default()
                        .id(workspace_event.id.to_string())
                        .event("workspace_event")
                        .json_data(&workspace_event)
                        .unwrap_or_else(|_| Event::default().event("serialization_error"));
                    return Some((Ok(event), state));
                }
                let store = state.store.upgrade()?;
                state.pending = store
                    .workspace_events_after(state.cursor)
                    .unwrap_or_default()
                    .into();
                drop(store);
                if !state.pending.is_empty() {
                    continue;
                }

                let latest_wakeup = *state.wakeups.borrow_and_update();
                if latest_wakeup > state.cursor {
                    continue;
                }

                tokio::select! {
                    changed = state.wakeups.changed() => {
                        if changed.is_err() {
                            return None;
                        }
                    }
                    _ = state.recovery.tick() => {}
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub(super) async fn stream_agent_events(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let store = state.agent_runtime.store();
    store.get_run(&run_id)?;
    let stream = futures_util::stream::unfold(
        AgentEventStreamState {
            store,
            run_id,
            cursor: query.after,
            pending: VecDeque::new(),
        },
        |mut state| async move {
            loop {
                if let Some(agent_event) = state.pending.pop_front() {
                    state.cursor = agent_event.seq;
                    let agent_event = safe_agent_event(agent_event);
                    let event = Event::default()
                        .id(agent_event.seq.to_string())
                        .event(agent_event.kind.as_str())
                        .json_data(&agent_event)
                        .unwrap_or_else(|_| Event::default().event("serialization_error"));
                    return Some((Ok(event), state));
                }
                state.pending = state
                    .store
                    .events_after(&state.run_id, state.cursor)
                    .unwrap_or_default()
                    .into();
                if !state.pending.is_empty() {
                    continue;
                }
                let run = state.store.get_run(&state.run_id).ok()?;
                if !matches!(
                    run.status,
                    RunStatus::Running | RunStatus::WaitingPermission
                ) {
                    return None;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

pub(super) fn project_available_commands(payload: &serde_json::Value) -> serde_json::Value {
    crate::composer_catalog::project_available_commands(payload)
}

pub(super) fn safe_agent_event(mut event: AgentEvent) -> AgentEvent {
    if event.kind == AgentEventKind::AvailableCommands {
        event.payload = project_available_commands(&event.payload);
    }
    event
}

pub(super) fn safe_session_event(mut event: SessionEvent) -> SessionEvent {
    if event.kind == "available_commands" {
        event.payload = project_available_commands(&event.payload);
    }
    event
}

pub(super) fn safe_workspace_event(mut event: WorkspaceEvent) -> WorkspaceEvent {
    if event.kind == "available_commands" {
        event.payload = project_available_commands(&event.payload);
    }
    event
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::project_available_commands;

    #[test]
    fn projects_only_safe_standard_acp_command_fields() {
        let projected = project_available_commands(&json!({
            "availableCommands": [
                {"name":"status", "description":"Show status", "_meta":{"secret":"no"}},
                {"name":"review", "description":"Review", "input":{"hint":"focus"}},
                {"name":"search", "description":"Search", "input":{"type":"text", "hint":"query"}},
                {"name":"ask", "description":"Ask", "input":{"type":"text"}},
                {"name":"empty", "description":"Empty", "input":{"hint":""}},
                {"name":"unicode", "description":"Unicode", "input":{"hint":"问题"}},
                {"name":"future", "description":"Future", "input":{"type":"choices", "values":["a"]}},
                {"name":"broken", "description":"Broken", "input":{"type":"text", "hint":7}},
                {"name":7, "description":"invalid"}
            ],
            "_meta": {"private":"no"}
        }));
        assert_eq!(
            projected,
            json!({"availableCommands":[
                {"name":"status", "description":"Show status", "input":null},
                {"name":"review", "description":"Review", "input":{"kind":"text", "hint":"focus"}},
                {"name":"search", "description":"Search", "input":{"kind":"text", "hint":"query"}},
                {"name":"ask", "description":"Ask", "input":{"kind":"text"}},
                {"name":"empty", "description":"Empty", "input":{"kind":"text", "hint":""}},
                {"name":"unicode", "description":"Unicode", "input":{"kind":"text", "hint":"问题"}},
                {"name":"future", "description":"Future", "input":{"kind":"unsupported"}},
                {"name":"broken", "description":"Broken", "input":{"kind":"unsupported"}}
            ]})
        );
    }
}
