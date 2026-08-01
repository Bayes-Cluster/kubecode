use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::MaybeUndefined;
use agent_client_protocol::schema::v1::SessionUpdate;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

use crate::agents::{AgentEventKind, AgentStore, RuntimeRunEvent, RuntimeUpdate, StoreError};

use super::SessionActorGeneration;
use super::events::{text_event, tool_started, tool_updated};

#[derive(Debug)]
struct PersistedSessionUpdate {
    session_kind: &'static str,
    run_kind: Option<AgentEventKind>,
    payload: Value,
    publish_session_state: bool,
    title_update: Option<SessionTitleUpdate>,
}

#[derive(Clone, Debug)]
enum SessionTitleUpdate {
    IfUntitled(String),
    Provider(String),
}

#[derive(Debug)]
struct PendingSessionUpdate {
    run_id: Option<String>,
    event: PersistedSessionUpdate,
}

enum SessionJournalCommand {
    Update(PendingSessionUpdate),
    Flush(oneshot::Sender<Result<(), String>>),
    Shutdown,
}

const SESSION_UPDATE_FLUSH_INTERVAL: Duration = Duration::from_millis(33);
const SESSION_UPDATE_CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Error)]
pub(super) enum SessionJournalError {
    #[error("Session update journal is closed")]
    Closed,
    #[error("Session update persistence failed: {0}")]
    Persistence(String),
    #[error("Session update journal task failed: {0}")]
    Worker(String),
}

struct SessionJournalSender {
    sender: mpsc::Sender<SessionJournalCommand>,
    accepting: tokio::sync::Mutex<bool>,
}

#[derive(Clone)]
pub(super) struct SessionUpdateSink {
    sender: Arc<SessionJournalSender>,
    conversation_id: Arc<str>,
    pub(super) generation: Option<SessionActorGeneration>,
}

pub(super) struct SessionUpdateJournal {
    sink: SessionUpdateSink,
    worker: tokio::task::JoinHandle<Result<(), StoreError>>,
}

impl SessionUpdateJournal {
    pub(super) fn spawn(store: Arc<AgentStore>, conversation_id: String) -> Self {
        Self::spawn_with_generation(store, conversation_id, None)
    }

    pub(super) fn spawn_guarded(
        store: Arc<AgentStore>,
        conversation_id: String,
        generation: SessionActorGeneration,
    ) -> Self {
        Self::spawn_with_generation(store, conversation_id, Some(generation))
    }

    fn spawn_with_generation(
        store: Arc<AgentStore>,
        conversation_id: String,
        generation: Option<SessionActorGeneration>,
    ) -> Self {
        let (sender, mut receiver) = mpsc::channel(SESSION_UPDATE_CHANNEL_CAPACITY);
        let sink = SessionUpdateSink {
            sender: Arc::new(SessionJournalSender {
                sender,
                accepting: tokio::sync::Mutex::new(true),
            }),
            conversation_id: Arc::from(conversation_id),
            generation: generation.clone(),
        };
        let worker_conversation_id = Arc::clone(&sink.conversation_id);
        let worker = tokio::spawn(async move {
            let mut pending = Vec::<PendingSessionUpdate>::new();
            let mut flush_deadline = None;
            loop {
                let command = if let Some(deadline) = flush_deadline {
                    match tokio::time::timeout_at(deadline, receiver.recv()).await {
                        Ok(command) => command,
                        Err(_) => {
                            persist_pending_updates(
                                &store,
                                &worker_conversation_id,
                                &mut pending,
                                generation.as_ref(),
                            )?;
                            flush_deadline = None;
                            continue;
                        }
                    }
                } else {
                    receiver.recv().await
                };
                match command {
                    Some(SessionJournalCommand::Update(update)) => {
                        if update.event.is_streaming() {
                            if pending.is_empty() {
                                flush_deadline = Some(
                                    tokio::time::Instant::now() + SESSION_UPDATE_FLUSH_INTERVAL,
                                );
                            }
                            push_streaming_update(&mut pending, update);
                        } else {
                            persist_pending_updates(
                                &store,
                                &worker_conversation_id,
                                &mut pending,
                                generation.as_ref(),
                            )?;
                            flush_deadline = None;
                            persist_session_event(
                                &store,
                                &worker_conversation_id,
                                update.run_id.as_deref(),
                                update.event,
                                generation.as_ref(),
                            )?;
                        }
                    }
                    Some(SessionJournalCommand::Flush(response)) => {
                        let result = persist_pending_updates(
                            &store,
                            &worker_conversation_id,
                            &mut pending,
                            generation.as_ref(),
                        );
                        flush_deadline = None;
                        match result {
                            Ok(()) => {
                                let _ = response.send(Ok(()));
                            }
                            Err(error) => {
                                let _ = response.send(Err(error.to_string()));
                                return Err(error);
                            }
                        }
                    }
                    Some(SessionJournalCommand::Shutdown) => {
                        persist_pending_updates(
                            &store,
                            &worker_conversation_id,
                            &mut pending,
                            generation.as_ref(),
                        )?;
                        break;
                    }
                    None => {
                        persist_pending_updates(
                            &store,
                            &worker_conversation_id,
                            &mut pending,
                            generation.as_ref(),
                        )?;
                        break;
                    }
                }
            }
            Ok(())
        });
        Self { sink, worker }
    }

    pub(super) fn sink(&self) -> SessionUpdateSink {
        self.sink.clone()
    }

    #[cfg(test)]
    async fn enqueue(
        &self,
        run_id: Option<String>,
        update: SessionUpdate,
    ) -> Result<(), SessionJournalError> {
        self.sink.enqueue(run_id, update).await
    }

    #[cfg(test)]
    async fn flush(&self) -> Result<(), SessionJournalError> {
        self.sink.flush().await
    }

    pub(super) async fn shutdown(self) -> Result<(), SessionJournalError> {
        let send_result = {
            let mut accepting = self.sink.sender.accepting.lock().await;
            *accepting = false;
            self.sink
                .sender
                .sender
                .send(SessionJournalCommand::Shutdown)
                .await
        };
        let worker_result = self
            .worker
            .await
            .map_err(|error| SessionJournalError::Worker(error.to_string()))?;
        match worker_result {
            Ok(()) if send_result.is_ok() => Ok(()),
            Ok(()) => Err(SessionJournalError::Closed),
            Err(error) => Err(SessionJournalError::Persistence(error.to_string())),
        }
    }
}

impl SessionUpdateSink {
    pub(super) async fn enqueue(
        &self,
        run_id: Option<String>,
        update: SessionUpdate,
    ) -> Result<(), SessionJournalError> {
        let accepting = self.sender.accepting.lock().await;
        if !*accepting {
            return Err(SessionJournalError::Closed);
        }
        if self
            .generation
            .as_ref()
            .is_some_and(|generation| !generation.is_current())
        {
            return Ok(());
        }
        let Some(event) = session_update_event(update) else {
            return Ok(());
        };
        self.sender
            .sender
            .send(SessionJournalCommand::Update(PendingSessionUpdate {
                run_id,
                event,
            }))
            .await
            .map_err(|_| SessionJournalError::Closed)
    }

    pub(super) async fn flush(&self) -> Result<(), SessionJournalError> {
        let (sender, receiver) = oneshot::channel();
        {
            let accepting = self.sender.accepting.lock().await;
            if !*accepting {
                return Err(SessionJournalError::Closed);
            }
            self.sender
                .sender
                .send(SessionJournalCommand::Flush(sender))
                .await
                .map_err(|_| SessionJournalError::Closed)?;
        }
        receiver
            .await
            .map_err(|_| SessionJournalError::Closed)?
            .map_err(SessionJournalError::Persistence)
    }
}

pub(super) fn journal_protocol_error(error: SessionJournalError) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(error.to_string())
}

pub(super) fn finish_journal<T>(
    result: Result<T, agent_client_protocol::Error>,
    shutdown: Result<(), SessionJournalError>,
) -> Result<T, String> {
    match (result, shutdown) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(connection), Err(journal)) => Err(format!("{connection}; {journal}")),
        (Err(error), Ok(())) => Err(error.to_string()),
        (Ok(_), Err(error)) => Err(error.to_string()),
    }
}

fn push_streaming_update(pending: &mut Vec<PendingSessionUpdate>, update: PendingSessionUpdate) {
    if let Some(last) = pending.last_mut()
        && last.run_id == update.run_id
        && last.event.try_merge(&update.event)
    {
        return;
    }
    pending.push(update);
}

fn persist_pending_updates(
    store: &AgentStore,
    conversation_id: &str,
    pending: &mut Vec<PendingSessionUpdate>,
    generation: Option<&SessionActorGeneration>,
) -> Result<(), StoreError> {
    let pending = std::mem::take(pending);
    let title_updates = pending
        .iter()
        .filter_map(|update| update.event.title_update.clone())
        .collect::<Vec<_>>();
    let updates = pending.into_iter().map(runtime_update).collect::<Vec<_>>();
    let persist = || {
        store.append_runtime_updates(conversation_id, &updates)?;
        apply_session_title_updates(store, conversation_id, &title_updates);
        Ok(())
    };
    if let Some(generation) = generation {
        generation.persist_if_current(persist).map(|_| ())
    } else {
        persist()
    }
}

fn runtime_update(update: PendingSessionUpdate) -> RuntimeUpdate {
    let session_payload = match &update.run_id {
        Some(run_id) => merge_run_id(update.event.payload.clone(), run_id),
        None => update.event.payload.clone(),
    };
    let run_event = update
        .run_id
        .zip(update.event.run_kind)
        .map(|(run_id, kind)| RuntimeRunEvent {
            run_id,
            kind,
            payload: update.event.payload,
        });
    RuntimeUpdate {
        session_kind: update.event.session_kind.to_owned(),
        session_payload,
        run_event,
        publish_session_state: update.event.publish_session_state,
    }
}

impl PersistedSessionUpdate {
    fn is_streaming(&self) -> bool {
        matches!(
            self.session_kind,
            "user_message_delta" | "text_delta" | "thinking_delta"
        )
    }

    fn try_merge(&mut self, next: &Self) -> bool {
        if !self.is_streaming()
            || self.session_kind != next.session_kind
            || self.run_kind != next.run_kind
            || self.payload.get("message_id") != next.payload.get("message_id")
            || self.payload.get("_meta") != next.payload.get("_meta")
        {
            return false;
        }
        let Some(current) = self.payload.get("text").and_then(Value::as_str) else {
            return false;
        };
        let Some(delta) = next.payload.get("text").and_then(Value::as_str) else {
            return false;
        };
        self.payload["text"] = Value::String(current.to_owned() + delta);
        true
    }
}

fn session_update_event(update: SessionUpdate) -> Option<PersistedSessionUpdate> {
    let mut title_update = None;
    let event = match update {
        SessionUpdate::UserMessageChunk(chunk) => {
            text_event(AgentEventKind::TextDelta, chunk).map(|(_, payload)| {
                if let Some(text) = payload.get("text").and_then(Value::as_str) {
                    title_update = Some(SessionTitleUpdate::IfUntitled(text.to_owned()));
                }
                ("user_message_delta", None, payload)
            })
        }
        SessionUpdate::AgentMessageChunk(chunk) => text_event(AgentEventKind::TextDelta, chunk)
            .map(|(kind, payload)| ("text_delta", Some(kind), payload)),
        SessionUpdate::AgentThoughtChunk(chunk) => text_event(AgentEventKind::ThinkingDelta, chunk)
            .map(|(kind, payload)| ("thinking_delta", Some(kind), payload)),
        SessionUpdate::ToolCall(tool_call) => {
            let (kind, payload) = tool_started(tool_call);
            Some(("tool_started", Some(kind), payload))
        }
        SessionUpdate::ToolCallUpdate(update) => {
            let (kind, payload) = tool_updated(update);
            let session_kind = if kind == AgentEventKind::ToolCompleted {
                "tool_completed"
            } else {
                "tool_updated"
            };
            Some((session_kind, Some(kind), payload))
        }
        SessionUpdate::Plan(plan) => serialized_update("plan", AgentEventKind::Plan, plan),
        SessionUpdate::AvailableCommandsUpdate(commands) => {
            serialized_state_update("available_commands", commands)
        }
        SessionUpdate::CurrentModeUpdate(mode) => serialized_state_update("current_mode", mode),
        SessionUpdate::ConfigOptionUpdate(options) => {
            serialized_state_update("config_options", options)
        }
        SessionUpdate::SessionInfoUpdate(info) => {
            match &info.title {
                MaybeUndefined::Value(title) if !title.trim().is_empty() => {
                    title_update = Some(SessionTitleUpdate::Provider(title.to_owned()));
                }
                MaybeUndefined::Value(_) | MaybeUndefined::Null | MaybeUndefined::Undefined => {}
            }
            serialized_state_update("session_info", info)
        }
        SessionUpdate::UsageUpdate(usage) => serialized_state_update("usage", usage),
        _ => None,
    };
    event.map(|(session_kind, run_kind, payload)| PersistedSessionUpdate {
        session_kind,
        run_kind,
        payload,
        publish_session_state: matches!(
            session_kind,
            "available_commands"
                | "current_mode"
                | "config_options"
                | "session_info"
                | "usage"
                | "plan"
        ),
        title_update,
    })
}

fn persist_session_event(
    store: &AgentStore,
    conversation_id: &str,
    run_id: Option<&str>,
    event: PersistedSessionUpdate,
    generation: Option<&SessionActorGeneration>,
) -> Result<(), StoreError> {
    let title_updates = event.title_update.clone().into_iter().collect::<Vec<_>>();
    let update = runtime_update(PendingSessionUpdate {
        run_id: run_id.map(str::to_owned),
        event,
    });
    let persist = || {
        store.append_runtime_updates(conversation_id, &[update])?;
        apply_session_title_updates(store, conversation_id, &title_updates);
        Ok(())
    };
    if let Some(generation) = generation {
        generation.persist_if_current(persist).map(|_| ())
    } else {
        persist()
    }
}

fn apply_session_title_updates(
    store: &AgentStore,
    conversation_id: &str,
    updates: &[SessionTitleUpdate],
) {
    for update in updates {
        match update {
            SessionTitleUpdate::IfUntitled(title) => {
                let _ = store.set_agent_title_if_untitled(conversation_id, title);
            }
            SessionTitleUpdate::Provider(title) => {
                let _ = store.set_agent_title(conversation_id, Some(title));
            }
        }
    }
}

fn serialized_update(
    session_kind: &'static str,
    run_kind: AgentEventKind,
    value: impl serde::Serialize,
) -> Option<(&'static str, Option<AgentEventKind>, Value)> {
    serde_json::to_value(value)
        .ok()
        .map(|payload| (session_kind, Some(run_kind), payload))
}

fn serialized_state_update(
    session_kind: &'static str,
    value: impl serde::Serialize,
) -> Option<(&'static str, Option<AgentEventKind>, Value)> {
    serde_json::to_value(value)
        .ok()
        .map(|payload| (session_kind, None, payload))
}

pub(super) fn persist_serialized_session_event(
    store: &AgentStore,
    conversation_id: &str,
    kind: &str,
    value: impl serde::Serialize,
    generation: Option<&SessionActorGeneration>,
) -> Result<(), agent_client_protocol::Error> {
    let payload = serde_json::to_value(value)
        .map_err(|error| agent_client_protocol::Error::internal_error().data(error.to_string()))?;
    let persist = || {
        store
            .append_session_event(conversation_id, kind, &payload)
            .map(|_| ())
    };
    let persisted = match generation {
        Some(generation) => generation.persist_if_current(persist).map_err(|error| {
            agent_client_protocol::Error::internal_error().data(error.to_string())
        })?,
        None => {
            persist().map_err(|error| {
                agent_client_protocol::Error::internal_error().data(error.to_string())
            })?;
            true
        }
    };
    if persisted {
        Ok(())
    } else {
        Err(agent_client_protocol::Error::internal_error().data("stale session actor generation"))
    }
}

pub(super) fn persist_serialized_session_state_checkpoint(
    store: &AgentStore,
    conversation_id: &str,
    kind: &str,
    value: impl serde::Serialize,
    generation: Option<&SessionActorGeneration>,
) -> Result<(), agent_client_protocol::Error> {
    let payload = serde_json::to_value(value)
        .map_err(|error| agent_client_protocol::Error::internal_error().data(error.to_string()))?;
    let persisted = match generation {
        Some(generation) => generation
            .persist_if_current(|| {
                store.append_session_state_checkpoint(conversation_id, kind, &payload)
            })
            .map_err(|error| {
                agent_client_protocol::Error::internal_error().data(error.to_string())
            })?,
        None => {
            store
                .append_session_state_checkpoint(conversation_id, kind, &payload)
                .map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
            true
        }
    };
    if persisted {
        Ok(())
    } else {
        Err(agent_client_protocol::Error::internal_error().data("stale session actor generation"))
    }
}

fn merge_run_id(mut payload: Value, run_id: &str) -> Value {
    if let Value::Object(ref mut object) = payload {
        object.insert("run_id".into(), Value::String(run_id.to_owned()));
        payload
    } else {
        json!({"run_id":run_id, "value":payload})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::RwLock;

    use agent_client_protocol::schema::v1::{
        ContentBlock, ContentChunk, TextContent, ToolCall, ToolCallId,
    };
    use serde_json::json;
    use std::sync::mpsc as std_mpsc;

    use crate::agents::{AgentId, PermissionMode};
    use crate::workspace::WorkspaceService;

    #[test]
    fn streaming_updates_coalesce_only_with_the_same_identity() {
        let event = |message_id: &str, text: &str| PersistedSessionUpdate {
            session_kind: "text_delta",
            run_kind: Some(AgentEventKind::TextDelta),
            payload: json!({"message_id":message_id, "text":text}),
            publish_session_state: false,
            title_update: None,
        };
        let mut pending = Vec::new();
        for _ in 0..1_000 {
            push_streaming_update(
                &mut pending,
                PendingSessionUpdate {
                    run_id: Some("run-1".into()),
                    event: event("message-1", "x"),
                },
            );
        }
        push_streaming_update(
            &mut pending,
            PendingSessionUpdate {
                run_id: Some("run-1".into()),
                event: event("message-2", "y"),
            },
        );

        assert_eq!(pending.len(), 2);
        assert_eq!(
            pending[0].event.payload["text"].as_str().map(str::len),
            Some(1_000)
        );
        assert_eq!(pending[1].event.payload["text"], "y");
    }

    #[tokio::test]
    async fn session_update_journal_flushes_text_before_semantic_events() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("stream-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Stream",
                PermissionMode::Safe,
            )
            .expect("run");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());
        let workspace_event_bus = store.workspace_event_bus();
        let workspace_receiver = workspace_event_bus.subscribe();
        let workspace_cursor = *workspace_receiver.borrow();

        for _ in 0..1_000 {
            let mut chunk = ContentChunk::new(ContentBlock::Text(TextContent::new("x")));
            chunk.message_id = Some("message-1".into());
            journal
                .enqueue(
                    Some(run.id.clone()),
                    SessionUpdate::AgentMessageChunk(chunk),
                )
                .await
                .expect("stream update");
        }
        journal
            .enqueue(
                Some(run.id.clone()),
                SessionUpdate::ToolCall(ToolCall::new(ToolCallId::new("tool-1"), "Shell")),
            )
            .await
            .expect("tool update");
        journal.flush().await.expect("flush");

        let events = store.events_after(&run.id, 1).expect("run events");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, AgentEventKind::TextDelta);
        assert_eq!(
            events[0].payload["text"].as_str().map(str::len),
            Some(1_000)
        );
        assert_eq!(events[1].kind, AgentEventKind::ToolStarted);
        let session_events = store
            .session_events_after(&conversation.id, 1)
            .expect("session events");
        assert_eq!(session_events.len(), 2);
        assert_eq!(session_events[0].kind, "text_delta");
        assert_eq!(session_events[1].kind, "tool_started");
        let workspace_events = store
            .workspace_events_after(workspace_cursor)
            .expect("workspace events");
        assert_eq!(workspace_events.len(), 2);
        assert_eq!(
            workspace_event_bus.latest_committed_cursor(),
            workspace_events.last().expect("latest workspace event").id
        );
        assert!(
            workspace_receiver
                .has_changed()
                .expect("event bus remains open")
        );
        journal.shutdown().await.expect("shutdown");
    }

    #[tokio::test(start_paused = true)]
    async fn session_update_journal_flush_deadline_is_not_reset_by_streaming_updates() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("deadline-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Deadline",
                PermissionMode::Safe,
            )
            .expect("run");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());

        let enqueue_chunk = || {
            let mut chunk = ContentChunk::new(ContentBlock::Text(TextContent::new("x")));
            chunk.message_id = Some("message-1".into());
            journal.enqueue(
                Some(run.id.clone()),
                SessionUpdate::AgentMessageChunk(chunk),
            )
        };
        enqueue_chunk().await.expect("first update");
        tokio::task::yield_now().await;
        for _ in 0..3 {
            tokio::time::advance(Duration::from_millis(10)).await;
            enqueue_chunk().await.expect("stream update");
            tokio::task::yield_now().await;
        }

        tokio::time::advance(Duration::from_millis(4)).await;
        tokio::task::yield_now().await;

        let events = store.events_after(&run.id, 1).expect("run events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, AgentEventKind::TextDelta);
        assert_eq!(events[0].payload["text"], "xxxx");
        journal.shutdown().await.expect("shutdown");
    }

    #[tokio::test(start_paused = true)]
    async fn session_update_journal_uses_distinct_fixed_windows() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("windows-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Windows",
                PermissionMode::Safe,
            )
            .expect("run");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());
        let sink = journal.sink();

        sink.enqueue(
            Some(run.id.clone()),
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("a"),
            ))),
        )
        .await
        .expect("first update");
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(32)).await;
        tokio::task::yield_now().await;
        assert!(
            store
                .events_after(&run.id, 1)
                .expect("events before deadline")
                .is_empty()
        );

        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            store.events_after(&run.id, 1).expect("first window").len(),
            1
        );
        sink.enqueue(
            Some(run.id.clone()),
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("b"),
            ))),
        )
        .await
        .expect("second update");
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(33)).await;
        tokio::task::yield_now().await;

        let events = store.events_after(&run.id, 1).expect("two windows");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].payload["text"], "a");
        assert_eq!(events[1].payload["text"], "b");
        journal.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn journal_flush_and_shutdown_are_concurrency_fences() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("concurrent-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let run = store
            .start_run(
                &conversation.id,
                &project.id,
                "Concurrent",
                PermissionMode::Safe,
            )
            .expect("run");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());
        let sink = journal.sink();
        let barrier = Arc::new(tokio::sync::Barrier::new(17));
        let mut producers = Vec::new();
        for _ in 0..16 {
            let sink = sink.clone();
            let barrier = Arc::clone(&barrier);
            let run_id = run.id.clone();
            producers.push(tokio::spawn(async move {
                barrier.wait().await;
                sink.enqueue(
                    Some(run_id),
                    SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                        TextContent::new("x"),
                    ))),
                )
                .await
            }));
        }
        barrier.wait().await;
        for producer in producers {
            producer.await.expect("producer task").expect("enqueue");
        }

        journal.flush().await.expect("flush fence");
        let events = store.events_after(&run.id, 1).expect("flushed events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["text"], "xxxxxxxxxxxxxxxx");

        journal.shutdown().await.expect("shutdown fence");
        assert!(matches!(
            sink.enqueue(
                Some(run.id),
                SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                    TextContent::new("late"),
                ))),
            )
            .await,
            Err(SessionJournalError::Closed)
        ));
    }

    #[test]
    fn stale_actor_generation_cannot_overwrite_new_session_state() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("generation-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let workspace_cursor = store.latest_workspace_event_id().expect("workspace cursor");
        let current = Arc::new(RwLock::new("old".to_owned()));
        let old = SessionActorGeneration {
            expected: "old".into(),
            current: Arc::clone(&current),
        };
        let event = |name: &str| PendingSessionUpdate {
            run_id: None,
            event: PersistedSessionUpdate {
                session_kind: "available_commands",
                run_kind: Some(AgentEventKind::AvailableCommands),
                payload: json!({
                    "availableCommands":[{"name":name, "description":"Command"}]
                }),
                publish_session_state: true,
                title_update: None,
            },
        };
        let mut stale = vec![event("stale")];
        stale[0].event.title_update = Some(SessionTitleUpdate::Provider("Stale title".into()));

        *current.write().expect("generation lock") = "new".into();
        persist_pending_updates(&store, &conversation.id, &mut stale, Some(&old))
            .expect("stale update is discarded");
        assert!(stale.is_empty());
        assert!(
            store
                .session_events_after(&conversation.id, 0)
                .expect("session replay")
                .is_empty()
        );
        assert_eq!(
            store
                .get_conversation(&conversation.id)
                .expect("conversation")
                .agent_title,
            None
        );

        let new = SessionActorGeneration {
            expected: "new".into(),
            current,
        };
        let mut fresh = vec![event("fresh")];
        persist_pending_updates(&store, &conversation.id, &mut fresh, Some(&new))
            .expect("current update persists");

        let session_events = store
            .session_events_after(&conversation.id, 0)
            .expect("session replay");
        assert_eq!(session_events.len(), 2);
        let command_event = session_events
            .iter()
            .find(|event| event.kind == "available_commands")
            .expect("raw command snapshot");
        assert_eq!(
            command_event.payload["availableCommands"][0]["name"],
            "fresh"
        );
        let catalog_event = session_events
            .iter()
            .find(|event| event.kind == "composer_catalog")
            .expect("safe catalog snapshot");
        assert_eq!(catalog_event.payload["items"][0]["name"], "fresh");
        let workspace_events = store
            .workspace_events_after(workspace_cursor)
            .expect("workspace replay");
        assert_eq!(workspace_events.len(), 2);
        assert_eq!(workspace_events[0].kind, "composer_catalog_snapshot");
        assert_eq!(workspace_events[1].kind, "session_state");
    }

    #[test]
    fn session_generation_replacement_waits_for_an_inflight_state_commit() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("generation-fence-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let current = Arc::new(RwLock::new("old".to_owned()));
        let old = SessionActorGeneration {
            expected: "old".into(),
            current: Arc::clone(&current),
        };
        let old_after_replacement = old.clone();
        let old_store = Arc::clone(&store);
        let old_conversation_id = conversation.id.clone();
        let (commit_started, commit_started_rx) = std_mpsc::channel();
        let (release_commit, release_commit_rx) = std_mpsc::channel();
        let old_commit = std::thread::spawn(move || {
            old.persist_if_current(|| {
                commit_started.send(()).expect("commit started signal");
                release_commit_rx.recv().expect("release commit");
                old_store.append_runtime_updates(
                    &old_conversation_id,
                    &[RuntimeUpdate {
                        session_kind: "available_commands".into(),
                        session_payload: json!({
                            "availableCommands":[{"name":"old", "description":"Old"}]
                        }),
                        run_event: None,
                        publish_session_state: true,
                    }],
                )
            })
        });
        commit_started_rx.recv().expect("old commit entered");

        let replacement_generation = Arc::clone(&current);
        let (replacement_started, replacement_started_rx) = std_mpsc::channel();
        let (replacement_finished, replacement_finished_rx) = std_mpsc::channel();
        let replacement = std::thread::spawn(move || {
            replacement_started.send(()).expect("replacement started");
            *replacement_generation.write().expect("generation lock") = "new".into();
            replacement_finished.send(()).expect("replacement finished");
        });
        replacement_started_rx
            .recv()
            .expect("replacement attempted");
        assert!(
            replacement_finished_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "generation replacement must wait for the current commit"
        );

        release_commit.send(()).expect("release old commit");
        assert!(
            old_commit
                .join()
                .expect("old commit thread")
                .expect("old commit")
        );
        replacement_finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("replacement completes after commit");
        replacement.join().expect("replacement thread");

        let late = old_after_replacement
            .persist_if_current(|| panic!("stale generation must not execute its operation"))
            .expect("stale check");
        assert!(!late);
        let session_events = store
            .session_events_after(&conversation.id, 0)
            .expect("session replay");
        assert_eq!(session_events.len(), 2);
        let command_event = session_events
            .iter()
            .find(|event| event.kind == "available_commands")
            .expect("raw command snapshot");
        assert_eq!(command_event.payload["availableCommands"][0]["name"], "old");
        let catalog_event = session_events
            .iter()
            .find(|event| event.kind == "composer_catalog")
            .expect("safe catalog snapshot");
        assert_eq!(catalog_event.payload["items"][0]["name"], "old");
    }

    #[tokio::test]
    async fn journal_reports_persistence_failures_to_flush_and_shutdown() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let project = workspace
            .create_project_at(temp.path().join("failure-project"))
            .expect("project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let journal = SessionUpdateJournal::spawn(Arc::clone(&store), conversation.id.clone());
        let sink = journal.sink();
        sink.enqueue(
            None,
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("uncommitted"),
            ))),
        )
        .await
        .expect("accepted update");
        store
            .delete_conversation(&conversation.id)
            .expect("delete conversation before flush");

        assert!(matches!(
            sink.flush().await,
            Err(SessionJournalError::Persistence(_))
        ));
        assert!(matches!(
            journal.shutdown().await,
            Err(SessionJournalError::Persistence(_))
        ));
    }

    #[tokio::test]
    async fn concurrent_session_journals_keep_events_isolated() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace = WorkspaceService::open(temp.path(), &database).expect("workspace service");
        let first_project = workspace
            .create_project_at(temp.path().join("first-project"))
            .expect("first project");
        let second_project = workspace
            .create_project_at(temp.path().join("second-project"))
            .expect("second project");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let first = store
            .create_conversation(&first_project.id, AgentId::OpenCode, None)
            .expect("first conversation");
        let second = store
            .create_conversation(&second_project.id, AgentId::OpenCode, None)
            .expect("second conversation");
        let first_run = store
            .start_run(&first.id, &first_project.id, "First", PermissionMode::Safe)
            .expect("first run");
        let second_run = store
            .start_run(
                &second.id,
                &second_project.id,
                "Second",
                PermissionMode::Safe,
            )
            .expect("second run");
        let first_journal = SessionUpdateJournal::spawn(Arc::clone(&store), first.id.clone());
        let second_journal = SessionUpdateJournal::spawn(Arc::clone(&store), second.id.clone());
        let first_sink = first_journal.sink();
        let second_sink = second_journal.sink();

        let first_task = tokio::spawn(async move {
            for _ in 0..100 {
                first_sink
                    .enqueue(
                        Some(first_run.id.clone()),
                        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                            TextContent::new("a"),
                        ))),
                    )
                    .await?;
            }
            Ok::<_, SessionJournalError>(first_run.id)
        });
        let second_task = tokio::spawn(async move {
            for _ in 0..100 {
                second_sink
                    .enqueue(
                        Some(second_run.id.clone()),
                        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                            TextContent::new("b"),
                        ))),
                    )
                    .await?;
            }
            Ok::<_, SessionJournalError>(second_run.id)
        });
        let first_run_id = first_task
            .await
            .expect("first producer")
            .expect("first updates");
        let second_run_id = second_task
            .await
            .expect("second producer")
            .expect("second updates");
        first_journal.shutdown().await.expect("first shutdown");
        second_journal.shutdown().await.expect("second shutdown");

        let first_events = store.events_after(&first_run_id, 1).expect("first events");
        let second_events = store
            .events_after(&second_run_id, 1)
            .expect("second events");
        assert_eq!(first_events.len(), 1);
        assert_eq!(second_events.len(), 1);
        assert_eq!(first_events[0].payload["text"], "a".repeat(100));
        assert_eq!(second_events[0].payload["text"], "b".repeat(100));
    }
}
