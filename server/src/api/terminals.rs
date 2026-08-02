use std::sync::Arc;

use axum::Json;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::AppState;
use super::emit_project_event;
use super::error::ApiError;
use crate::agents::StoreError;
use crate::terminal::{
    TerminalError, TerminalInfo, TerminalKind, TerminalManager, TerminalSnapshot, TerminalStatus,
};

#[derive(Debug, Deserialize)]
pub(super) struct CreateTerminalRequest {
    conversation_id: Option<String>,
    #[serde(default)]
    kind: TerminalKind,
    #[serde(default = "default_terminal_cols")]
    cols: u16,
    #[serde(default = "default_terminal_rows")]
    rows: u16,
}

#[derive(Debug, Deserialize)]
pub(super) struct RenameTerminalRequest {
    title: String,
}

pub(super) async fn list_terminals(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    Json(state.terminals.list(&project_id))
}

pub(super) async fn create_terminal(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateTerminalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let conversation = request
        .conversation_id
        .as_deref()
        .map(|conversation_id| {
            state
                .agent_runtime
                .store()
                .get_conversation(conversation_id)
        })
        .transpose()?;
    if let Some(conversation) = conversation.as_ref()
        && conversation.project_id != project_id
    {
        return Err(StoreError::ConversationNotFound(conversation.id.clone()).into());
    }
    let terminal = state.terminals.create(
        &project_id,
        request.conversation_id.as_deref(),
        conversation
            .as_ref()
            .and_then(|conversation| conversation.workspace_path.as_deref()),
        request.kind,
        request.cols,
        request.rows,
    )?;
    emit_project_event(
        &state,
        "terminal_created",
        &project_id,
        json!({"terminal_id":terminal.id.clone()}),
    );
    Ok((StatusCode::CREATED, Json(terminal)))
}

pub(super) async fn close_terminal(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let terminal = state.terminals.get(&terminal_id)?;
    state.terminals.close(&terminal_id)?;
    emit_project_event(
        &state,
        "terminal_closed",
        &terminal.project_id,
        json!({"terminal_id":terminal_id}),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn rename_terminal(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
    Json(request): Json<RenameTerminalRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let terminal = state.terminals.rename(&terminal_id, &request.title)?;
    emit_project_event(
        &state,
        "terminal_updated",
        &terminal.project_id,
        json!({"terminal_id":terminal.id.clone()}),
    );
    Ok(Json(terminal))
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct TerminalAttachQuery {
    #[serde(default)]
    cursor: u64,
}

pub(super) async fn attach_terminal(
    State(state): State<AppState>,
    Path((project_id, terminal_id)): Path<(String, String)>,
    Query(query): Query<TerminalAttachQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let terminal = state.terminals.get(&terminal_id)?;
    if terminal.project_id != project_id {
        return Err(ApiError::Terminal(TerminalError::NotFound(terminal_id)));
    }
    let manager = Arc::clone(&state.terminals);
    Ok(upgrade
        .on_upgrade(move |socket| terminal_socket(socket, manager, terminal.id, query.cursor)))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

async fn terminal_socket(
    mut socket: WebSocket,
    manager: Arc<TerminalManager>,
    terminal_id: String,
    mut cursor: u64,
) {
    match send_terminal_snapshot(&mut socket, &manager, &terminal_id, &mut cursor).await {
        Ok(false) => {}
        Ok(true) | Err(()) => return,
    }

    loop {
        tokio::select! {
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(message) = serde_json::from_str::<TerminalClientMessage>(text.as_str()) else {
                            continue;
                        };
                        let result = match message {
                            TerminalClientMessage::Input { data } => manager.write(&terminal_id, data.as_bytes()),
                            TerminalClientMessage::Resize { cols, rows } => manager.resize(&terminal_id, cols, rows),
                        };
                        if result.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                    Some(Ok(_)) => {}
                }
            }
            () = tokio::time::sleep(std::time::Duration::from_millis(40)) => {
                match send_terminal_snapshot(&mut socket, &manager, &terminal_id, &mut cursor).await {
                    Ok(false) => {}
                    Ok(true) | Err(()) => return,
                }
            }
        }
    }
}

async fn send_terminal_snapshot(
    socket: &mut WebSocket,
    manager: &TerminalManager,
    terminal_id: &str,
    cursor: &mut u64,
) -> Result<bool, ()> {
    let snapshot = manager.read_since(terminal_id, *cursor).map_err(|_| ())?;
    if !snapshot.data.is_empty() || snapshot.truncated {
        *cursor = snapshot.cursor;
        socket
            .send(Message::Text(terminal_output_json(snapshot).into()))
            .await
            .map_err(|_| ())?;
    }
    let terminal = manager.get(terminal_id).map_err(|_| ())?;
    if terminal.status != TerminalStatus::Exited {
        return Ok(false);
    }
    socket
        .send(Message::Text(terminal_status_json(&terminal).into()))
        .await
        .map_err(|_| ())?;
    Ok(true)
}

fn terminal_output_json(snapshot: TerminalSnapshot) -> String {
    json!({
        "type": "output",
        "data": snapshot.data,
        "cursor": snapshot.cursor,
        "truncated": snapshot.truncated,
    })
    .to_string()
}

fn terminal_status_json(terminal: &TerminalInfo) -> String {
    json!({
        "type": "status",
        "status": terminal.status,
        "exit_code": terminal.exit_code,
        "signal": terminal.signal,
    })
    .to_string()
}

fn default_terminal_cols() -> u16 {
    80
}

fn default_terminal_rows() -> u16 {
    24
}
