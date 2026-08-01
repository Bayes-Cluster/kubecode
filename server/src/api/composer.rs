use std::collections::BTreeSet;
use std::path::Path as FileSystemPath;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::json;

use super::AppState;
use super::emit_project_event;
use super::error::ApiError;
use crate::composer_catalog::{
    ComposerCatalogError, ComposerContextKind, ComposerContextSelector, ComposerContextSummary,
    ComposerGitDiffScope, ComposerPreflightContext, ComposerSessionTurnRole,
    MAX_COMPOSER_VALIDATION_ROWS, opaque_git_diff_context_id, opaque_terminal_context_id,
    session_turn_selector,
};
use crate::git::GitError;
use crate::terminal::TerminalContextCaptureKind;
use crate::workspace::{EntryKind, WorkspaceError};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RegisterComposerContextRequest {
    kind: ComposerContextKind,
    path: String,
    #[serde(default)]
    source_revision: Option<String>,
    #[serde(default)]
    terminal_id: Option<String>,
    #[serde(default)]
    selected_text: Option<String>,
    #[serde(default)]
    turn_id: Option<String>,
}

pub(super) async fn register_composer_context(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<RegisterComposerContextRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let store = state.agent_runtime.store();
    let conversation = store.get_conversation(&conversation_id)?;
    let registration = match request.kind {
        ComposerContextKind::File | ComposerContextKind::Directory => {
            if request.source_revision.is_some()
                || request.terminal_id.is_some()
                || request.selected_text.is_some()
                || request.turn_id.is_some()
            {
                return Err(ComposerCatalogError::InvalidDraft.into());
            }
            let expected_kind = workspace_kind(request.kind)?;
            let workspace = Arc::clone(&state.workspace);
            let project_id = conversation.project_id.clone();
            let agent_session_id = conversation.agent_session_id.clone();
            let workspace_path = conversation.workspace_path.clone();
            let path = request.path;
            let resolved = run_workspace_operation(move || {
                workspace.resolve_session_context_entry(
                    &project_id,
                    &agent_session_id,
                    conversation.execution_mode,
                    workspace_path.as_deref(),
                    &path,
                    expected_kind,
                )
            })
            .await
            .map_err(map_composer_workspace_error)?;
            store.register_composer_context(
                &conversation.id,
                &conversation.project_id,
                request.kind,
                &resolved.path,
            )?
        }
        ComposerContextKind::GitDiff => {
            if request.terminal_id.is_some()
                || request.selected_text.is_some()
                || request.turn_id.is_some()
            {
                return Err(ComposerCatalogError::InvalidDraft.into());
            }
            let source_revision = request
                .source_revision
                .ok_or(ComposerCatalogError::InvalidDraft)?;
            let path = (request.path != ".").then_some(request.path.as_str());
            let snapshot = state
                .git
                .resolve_composer_diff(
                    &conversation.project_id,
                    &conversation.agent_session_id,
                    conversation.execution_mode,
                    conversation.workspace_path.as_deref(),
                    path,
                )
                .await
                .map_err(map_composer_git_error)?;
            if snapshot.source_revision != source_revision {
                return Err(ComposerCatalogError::ContextStale.into());
            }
            let selector = snapshot.path.as_deref().unwrap_or(".");
            let summary = ComposerContextSummary::GitDiff {
                scope: if snapshot.path.is_some() {
                    ComposerGitDiffScope::File
                } else {
                    ComposerGitDiffScope::All
                },
                file_count: snapshot.file_count,
                hunk_count: snapshot.hunk_count,
                byte_count: snapshot.byte_count,
            };
            store.register_composer_git_diff_context(
                &conversation.id,
                &conversation.project_id,
                selector,
                &snapshot.source_revision,
                summary,
            )?
        }
        ComposerContextKind::Terminal => {
            if request.source_revision.is_some() || request.turn_id.is_some() {
                return Err(ComposerCatalogError::InvalidDraft.into());
            }
            let capture_kind = match request.path.as_str() {
                "selection" => TerminalContextCaptureKind::Selection,
                "recent" => TerminalContextCaptureKind::Recent,
                _ => return Err(ComposerCatalogError::InvalidDraft.into()),
            };
            let terminal_id = request
                .terminal_id
                .ok_or(ComposerCatalogError::InvalidDraft)?;
            let (terminal, pane_index) = state
                .agent_runtime
                .authorize_terminal_context(&conversation.id, &terminal_id)?;
            let capture = state.terminals.capture_context(
                &terminal.id,
                &conversation.id,
                capture_kind,
                request.selected_text.as_deref(),
            )?;
            let selector = format!(
                "{}:{}",
                terminal.id,
                match capture_kind {
                    TerminalContextCaptureKind::Selection => "selection",
                    TerminalContextCaptureKind::Recent => "recent",
                }
            );
            let id = opaque_terminal_context_id(
                &conversation.project_id,
                &conversation.id,
                &selector,
                &capture.source_revision,
            );
            let retained = state
                .terminals
                .retain_context_capture(id.clone(), capture.clone())?;
            let summary = ComposerContextSummary::Terminal {
                capture: capture.capture,
                pane_index,
                line_count: capture.line_count,
                byte_count: capture.byte_count,
                truncated: capture.truncated,
            };
            match store.register_composer_terminal_context(
                &conversation.id,
                &conversation.project_id,
                &selector,
                &capture.source_revision,
                summary,
            ) {
                Ok(registration) => registration,
                Err(error) => {
                    if retained {
                        state.terminals.discard_context_capture(&id);
                    }
                    return Err(error.into());
                }
            }
        }
        ComposerContextKind::SessionTurn => {
            if request.source_revision.is_some()
                || request.terminal_id.is_some()
                || request.selected_text.is_some()
            {
                return Err(ComposerCatalogError::InvalidDraft.into());
            }
            let role = match request.path.as_str() {
                "user" => ComposerSessionTurnRole::User,
                "agent" => ComposerSessionTurnRole::Agent,
                _ => return Err(ComposerCatalogError::InvalidDraft.into()),
            };
            let turn_id = request.turn_id.ok_or(ComposerCatalogError::InvalidDraft)?;
            let snapshot = store.resolve_composer_session_turn(&conversation.id, &turn_id, role)?;
            let selector = session_turn_selector(role, &turn_id);
            let summary = ComposerContextSummary::SessionTurn {
                role,
                line_count: snapshot.line_count,
                byte_count: snapshot.byte_count,
            };
            store.register_composer_session_turn_context(
                &conversation.id,
                &conversation.project_id,
                &selector,
                &snapshot.source_revision,
                summary,
            )?
        }
        _ => return Err(ComposerCatalogError::ItemUnsupported.into()),
    };
    Ok((StatusCode::CREATED, Json(registration)))
}

pub(super) async fn list_composer_git_diffs(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let conversation = state
        .agent_runtime
        .store()
        .get_conversation(&conversation_id)?;
    Ok(Json(
        state
            .git
            .composer_diff_candidates(
                &conversation.project_id,
                &conversation.agent_session_id,
                conversation.execution_mode,
                conversation.workspace_path.as_deref(),
            )
            .await
            .map_err(map_composer_git_error)?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ValidateComposerContextsRequest {
    references: Vec<ComposerContextSelector>,
}

pub(super) async fn validate_composer_contexts(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Json(request): Json<ValidateComposerContextsRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if request.references.len() > MAX_COMPOSER_VALIDATION_ROWS {
        return Err(ComposerCatalogError::ContextOverLimit.into());
    }
    let mut ids = BTreeSet::new();
    if request
        .references
        .iter()
        .any(|reference| !ids.insert(reference.id.as_str()))
    {
        return Err(ApiError::InvalidRequest(
            "composer context validation IDs must be unique".into(),
        ));
    }
    let store = state.agent_runtime.store();
    let conversation = store.get_conversation(&conversation_id)?;
    let records = store.composer_context_records_for_preflight(
        &conversation.id,
        &conversation.project_id,
        &request.references,
    )?;
    let mut preflight = Vec::with_capacity(records.len());
    for (selector, record) in request.references.iter().zip(records) {
        let Some(record) = record else {
            preflight.push(None);
            continue;
        };
        if record.kind != selector.context_kind {
            preflight.push(None);
            continue;
        }
        match record.kind {
            ComposerContextKind::File | ComposerContextKind::Directory => {
                let workspace = Arc::clone(&state.workspace);
                let project_id = conversation.project_id.clone();
                let agent_session_id = conversation.agent_session_id.clone();
                let workspace_path = conversation.workspace_path.clone();
                let path = record.path.clone();
                let expected_kind = workspace_kind(record.kind)?;
                let resolved = run_workspace_operation(move || {
                    workspace.resolve_session_context_entry(
                        &project_id,
                        &agent_session_id,
                        conversation.execution_mode,
                        workspace_path.as_deref(),
                        &path,
                        expected_kind,
                    )
                })
                .await;
                match resolved {
                    Ok(resolved) => preflight.push(Some(ComposerPreflightContext {
                        id: record.id,
                        kind: record.kind,
                        path: resolved.path,
                        content: None,
                    })),
                    Err(ApiError::Workspace(WorkspaceError::IneligibleContext(_))) => {
                        preflight.push(None)
                    }
                    Err(ApiError::Workspace(WorkspaceError::Io(error)))
                        if error.kind() == std::io::ErrorKind::NotFound =>
                    {
                        preflight.push(None)
                    }
                    Err(error) => return Err(error),
                }
            }
            ComposerContextKind::GitDiff => {
                let path = (record.path != ".").then_some(record.path.as_str());
                let snapshot = state
                    .git
                    .resolve_composer_diff(
                        &conversation.project_id,
                        &conversation.agent_session_id,
                        conversation.execution_mode,
                        conversation.workspace_path.as_deref(),
                        path,
                    )
                    .await;
                let available = snapshot.ok().filter(|snapshot| {
                    record.source_revision.as_deref() == Some(snapshot.source_revision.as_str())
                        && record.id
                            == opaque_git_diff_context_id(
                                &conversation.project_id,
                                &conversation.id,
                                &record.path,
                                &snapshot.source_revision,
                            )
                });
                preflight.push(available.map(|snapshot| ComposerPreflightContext {
                    id: record.id,
                    kind: record.kind,
                    path: record.path,
                    content: Some(snapshot.content),
                }));
            }
            ComposerContextKind::Terminal => {
                preflight.push(
                    state
                        .agent_runtime
                        .resolve_terminal_composer_context(&conversation.id, &record)?,
                );
            }
            ComposerContextKind::SessionTurn => {
                preflight.push(state.agent_runtime.resolve_session_turn_composer_context(
                    &conversation.id,
                    &conversation.project_id,
                    &record,
                )?);
            }
            _ => preflight.push(None),
        }
    }
    Ok(Json(store.validate_composer_contexts(
        &conversation.id,
        &conversation.project_id,
        &request.references,
        &preflight,
    )?))
}

fn workspace_kind(kind: ComposerContextKind) -> Result<EntryKind, ApiError> {
    match kind {
        ComposerContextKind::File => Ok(EntryKind::File),
        ComposerContextKind::Directory => Ok(EntryKind::Directory),
        _ => Err(ComposerCatalogError::ItemUnsupported.into()),
    }
}

fn map_composer_workspace_error(error: ApiError) -> ApiError {
    match error {
        ApiError::Workspace(WorkspaceError::ProjectNotFound(project_id)) => {
            ApiError::Workspace(WorkspaceError::ProjectNotFound(project_id))
        }
        ApiError::Workspace(error @ WorkspaceError::IneligibleContext(_)) => {
            ApiError::ComposerContextOutsideProject(error.to_string())
        }
        ApiError::Workspace(WorkspaceError::Io(error))
            if error.kind() == std::io::ErrorKind::NotFound =>
        {
            ApiError::ComposerContextOutsideProject(error.to_string())
        }
        other => other,
    }
}

fn map_composer_git_error(error: GitError) -> ApiError {
    match &error {
        GitError::Command(reason)
            if matches!(
                reason.as_str(),
                "git_diff_too_large" | "git_diff_too_many_hunks" | "git_diff_too_many_files"
            ) =>
        {
            ComposerCatalogError::ContextOverLimit.into()
        }
        GitError::Command(reason)
            if matches!(
                reason.as_str(),
                "git_diff_binary" | "git_diff_generated" | "git_diff_contains_unsupported"
            ) =>
        {
            ComposerCatalogError::ItemUnsupported.into()
        }
        GitError::InvalidPath(_) | GitError::Command(_) => {
            ComposerCatalogError::ContextStale.into()
        }
        GitError::Workspace(_) | GitError::Io(_) | GitError::EmptyMessage => {
            ComposerCatalogError::ContextStale.into()
        }
    }
}

pub(super) async fn run_workspace_operation<T, Operation>(
    operation: Operation,
) -> Result<T, ApiError>
where
    T: Send + 'static,
    Operation: FnOnce() -> Result<T, WorkspaceError> + Send + 'static,
{
    Ok(tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| {
            ApiError::Workspace(WorkspaceError::Io(std::io::Error::other(format!(
                "workspace operation task failed: {error}"
            ))))
        })??)
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct EntryQuery {
    #[serde(default)]
    path: String,
}

pub(super) async fn list_entries(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let workspace = Arc::clone(&state.workspace);
    let relative = query.path;
    let entries =
        run_workspace_operation(move || workspace.list_entries(&project_id, &relative)).await?;
    Ok(Json(entries))
}

pub(super) async fn list_session_entries(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<impl IntoResponse, ApiError> {
    // The conversation record is the server-authoritative source of which
    // Project this Session belongs to and where it executes. The browser
    // supplies only a validated relative directory path.
    let conversation = state
        .agent_runtime
        .store()
        .get_conversation(&conversation_id)?;
    let project_id = conversation.project_id.clone();
    let agent_session_id = conversation.agent_session_id.clone();
    let execution_mode = conversation.execution_mode;
    let workspace_path = conversation.workspace_path.clone();
    let relative = query.path;

    let workspace = Arc::clone(&state.workspace);
    let entries = run_workspace_operation(move || {
        workspace.list_session_entries(
            &project_id,
            &agent_session_id,
            execution_mode,
            workspace_path.as_deref(),
            &relative,
        )
    })
    .await?;
    Ok(Json(entries))
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateEntryRequest {
    path: String,
    kind: EntryKind,
}

pub(super) async fn create_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CreateEntryRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .workspace
        .create_entry(&project_id, &request.path, request.kind)?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"path":request.path}),
    );
    Ok(StatusCode::CREATED)
}

#[derive(Debug, Deserialize)]
pub(super) struct RenameEntryRequest {
    from: String,
    to: String,
}

pub(super) async fn rename_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<RenameEntryRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .workspace
        .rename_entry(&project_id, &request.from, &request.to)?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"from":request.from, "to":request.to}),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn delete_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<StatusCode, ApiError> {
    state.workspace.delete_entry(&project_id, &query.path)?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"path":query.path}),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn read_file(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(state.workspace.read_text(&project_id, &query.path)?))
}

pub(super) async fn read_asset(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let content_type = asset_content_type(&query.path);
    let bytes = state.workspace.read_asset(&project_id, &query.path)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        content_type.parse().expect("static MIME type"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        "private, max-age=60".parse().expect("static cache policy"),
    );
    Ok((headers, bytes))
}

fn asset_content_type(path: &str) -> &'static str {
    match FileSystemPath::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic" | "heif") => "image/heic",
        Some("tif" | "tiff") => "image/tiff",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct WriteFileRequest {
    content: String,
    revision: String,
}

pub(super) async fn write_file(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<EntryQuery>,
    Json(request): Json<WriteFileRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let document = state.workspace.write_text(
        &project_id,
        &query.path,
        &request.content,
        &request.revision,
    )?;
    emit_project_event(
        &state,
        "file_changed",
        &project_id,
        json!({"path":query.path}),
    );
    Ok(Json(document))
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::run_workspace_operation;

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_workspace_operations_leave_the_async_executor_responsive() {
        let operation = run_workspace_operation(|| {
            std::thread::sleep(Duration::from_millis(100));
            Ok(())
        });
        tokio::pin!(operation);
        let started = Instant::now();

        tokio::select! {
            _ = &mut operation => panic!("blocking operation completed early"),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }

        assert!(started.elapsed() < Duration::from_millis(80));
        assert!(operation.await.is_ok());
    }
}
