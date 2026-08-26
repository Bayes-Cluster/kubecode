use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::agent_runtime::{AgentStartupStage, RuntimeError};
use crate::agents::StoreError;
use crate::composer_catalog::{AcpCommandError, ComposerCatalogError};
use crate::git::GitError;
use crate::teams::TeamError;
use crate::terminal::TerminalError;
use crate::workspace::WorkspaceError;

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<AgentStartupStage>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SessionModeLockReason {
    ActiveRun,
    ReadOnly,
    TeamDiscriminator,
    TeamTeammate,
    TeamYoloPermission,
}

pub(super) enum ApiError {
    Workspace(WorkspaceError),
    Terminal(TerminalError),
    AgentStore(StoreError),
    AgentRuntime(RuntimeError),
    InvalidRequest(String),
    Git(GitError),
    PermissionNotFound(String),
    ElicitationNotFound(String),
    CheckpointUnavailable(String),
    WorkspaceMigration(String),
    Team(TeamError),
    TeammateDeletionRequiresLeader,
    SessionModeLocked(SessionModeLockReason),
    AcpCommand(AcpCommandError),
    ComposerContextOutsideProject(String),
}

impl From<AcpCommandError> for ApiError {
    fn from(error: AcpCommandError) -> Self {
        Self::AcpCommand(error)
    }
}

impl From<ComposerCatalogError> for ApiError {
    fn from(error: ComposerCatalogError) -> Self {
        Self::AgentStore(StoreError::Composer(error))
    }
}

impl From<WorkspaceError> for ApiError {
    fn from(error: WorkspaceError) -> Self {
        Self::Workspace(error)
    }
}

impl From<TerminalError> for ApiError {
    fn from(error: TerminalError) -> Self {
        Self::Terminal(error)
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        Self::AgentStore(error)
    }
}

impl From<RuntimeError> for ApiError {
    fn from(error: RuntimeError) -> Self {
        Self::AgentRuntime(error)
    }
}

impl From<GitError> for ApiError {
    fn from(error: GitError) -> Self {
        Self::Git(error)
    }
}

impl From<TeamError> for ApiError {
    fn from(error: TeamError) -> Self {
        Self::Team(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let self_ = match self {
            ApiError::AgentRuntime(RuntimeError::AcpStartup { stage, message }) => {
                let code = startup_error_code(stage, &message);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorBody {
                        code,
                        message,
                        stage: Some(stage),
                    }),
                )
                    .into_response();
            }
            other => other,
        };
        let (status, code, message) = match self_ {
            ApiError::Workspace(error) => {
                let (status, code) = workspace_error_status(&error);
                (status, code, error.to_string())
            }
            ApiError::ComposerContextOutsideProject(message) => (
                StatusCode::FORBIDDEN,
                "composer_context_outside_project",
                message,
            ),
            ApiError::Terminal(error) => {
                let (status, code) = match &error {
                    TerminalError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
                    TerminalError::LimitReached => (StatusCode::CONFLICT, "terminal_limit"),
                    TerminalError::AgentUnavailable(_) => {
                        (StatusCode::CONFLICT, "agent_unavailable")
                    }
                    TerminalError::InvalidTitle => (StatusCode::BAD_REQUEST, "invalid_title"),
                    TerminalError::ContextOverLimit => {
                        (StatusCode::PAYLOAD_TOO_LARGE, "composer_context_over_limit")
                    }
                    TerminalError::ContextBinary => (
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "composer_item_unsupported",
                    ),
                    TerminalError::ContextSelectionUnavailable | TerminalError::ContextStale => {
                        (StatusCode::CONFLICT, "composer_context_stale")
                    }
                    TerminalError::Workspace(workspace) => workspace_error_status(workspace),
                    TerminalError::Pty(_) | TerminalError::Io(_) => {
                        (StatusCode::INTERNAL_SERVER_ERROR, "terminal_error")
                    }
                };
                (status, code, error.to_string())
            }
            ApiError::AgentStore(error) => {
                let (status, code) = store_error_status(&error);
                (status, code, error.to_string())
            }
            ApiError::AgentRuntime(error) => match error {
                RuntimeError::AgentUnavailable(_) => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "agent_unavailable",
                    error.to_string(),
                ),
                RuntimeError::Store(store) => {
                    let (status, code) = store_error_status(&store);
                    (status, code, store.to_string())
                }
                RuntimeError::Workspace(workspace) => {
                    let (status, code) = workspace_error_status(&workspace);
                    (status, code, workspace.to_string())
                }
                RuntimeError::Acp(_) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "agent_error",
                    error.to_string(),
                ),
                RuntimeError::AcpStartup { .. } => unreachable!(),
                RuntimeError::AdapterUnavailable { .. } => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "agent_adapter_unavailable",
                    error.to_string(),
                ),
                RuntimeError::SideQuestionUnavailable => (
                    StatusCode::CONFLICT,
                    "side_question_unavailable",
                    error.to_string(),
                ),
                RuntimeError::SideQuestionInactive => (
                    StatusCode::CONFLICT,
                    "side_question_inactive",
                    error.to_string(),
                ),
                RuntimeError::SideQuestionPending => (
                    StatusCode::CONFLICT,
                    "side_question_pending",
                    error.to_string(),
                ),
            },
            ApiError::InvalidRequest(message) => {
                (StatusCode::BAD_REQUEST, "invalid_request", message)
            }
            ApiError::Git(error) => {
                let (status, code) = match &error {
                    GitError::InvalidPath(_) | GitError::EmptyMessage => {
                        (StatusCode::BAD_REQUEST, "invalid_request")
                    }
                    GitError::Workspace(workspace) => workspace_error_status(workspace),
                    GitError::Command(_) => (StatusCode::CONFLICT, "git_error"),
                    GitError::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, "git_error"),
                };
                (status, code, error.to_string())
            }
            ApiError::PermissionNotFound(request_id) => (
                StatusCode::NOT_FOUND,
                "permission_not_found",
                format!("permission request is no longer active: {request_id}"),
            ),
            ApiError::ElicitationNotFound(request_id) => (
                StatusCode::NOT_FOUND,
                "elicitation_not_found",
                format!("elicitation request is no longer active: {request_id}"),
            ),
            ApiError::CheckpointUnavailable(message) => {
                (StatusCode::CONFLICT, "checkpoint_unavailable", message)
            }
            ApiError::WorkspaceMigration(message) => (
                StatusCode::CONFLICT,
                "workspace_migration_required",
                message,
            ),
            ApiError::Team(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "team_error",
                error.to_string(),
            ),
            ApiError::TeammateDeletionRequiresLeader => (
                StatusCode::CONFLICT,
                "teammate_delete_requires_leader",
                "Team teammates can only be deleted by their Leader".to_owned(),
            ),
            ApiError::SessionModeLocked(reason) => (
                StatusCode::CONFLICT,
                "session_mode_locked",
                session_mode_lock_message(reason).to_owned(),
            ),
            ApiError::AcpCommand(error) => {
                let (status, code, message) = acp_command_error_response(error);
                (status, code, message.to_owned())
            }
        };
        (
            status,
            Json(ErrorBody {
                code,
                message,
                stage: None,
            }),
        )
            .into_response()
    }
}

fn acp_command_error_response(error: AcpCommandError) -> (StatusCode, &'static str, &'static str) {
    match error {
        AcpCommandError::Unavailable => (
            StatusCode::CONFLICT,
            "acp_command_unavailable",
            "command is no longer available",
        ),
        AcpCommandError::Ambiguous => (
            StatusCode::CONFLICT,
            "acp_command_ambiguous",
            "command name is advertised more than once",
        ),
        AcpCommandError::UnsupportedInput => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "acp_command_input_unsupported",
            "command uses an unsupported input specification",
        ),
        AcpCommandError::InputRequired => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "acp_command_input_required",
            "command input is required",
        ),
        AcpCommandError::UnexpectedInput => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "acp_command_input_unexpected",
            "command does not accept input",
        ),
        AcpCommandError::ArgumentsTooLong => (
            StatusCode::PAYLOAD_TOO_LARGE,
            "acp_command_input_too_long",
            "command input exceeds the size limit",
        ),
    }
}

fn session_mode_lock_message(reason: SessionModeLockReason) -> &'static str {
    match reason {
        SessionModeLockReason::ActiveRun => {
            "session mode can be changed after the current turn finishes"
        }
        SessionModeLockReason::ReadOnly => "session mode cannot be changed in a read-only session",
        SessionModeLockReason::TeamDiscriminator => "discriminator mode is controlled by the Team",
        SessionModeLockReason::TeamTeammate => "teammate mode is controlled by the Team Leader",
        SessionModeLockReason::TeamYoloPermission => {
            "session mode is controlled by the Team YOLO permission policy"
        }
    }
}

fn startup_error_code(stage: AgentStartupStage, message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if [
        "unauthorized",
        "authentication",
        "not logged in",
        "login required",
        "invalid api key",
        "status 401",
    ]
    .iter()
    .any(|value| lower.contains(value))
    {
        return "agent_authentication_failed";
    }
    if [
        "\"service\":\"directory\"",
        "service\": \"directory",
        "service: directory",
        "no such file or directory",
        "working directory",
        "invalid cwd",
    ]
    .iter()
    .any(|value| lower.contains(value))
    {
        return "agent_project_directory_failed";
    }
    match stage {
        AgentStartupStage::ProcessSpawn => "agent_process_spawn_failed",
        AgentStartupStage::Initialize => "agent_initialize_failed",
        AgentStartupStage::SessionNew => "agent_session_new_failed",
        AgentStartupStage::SessionLoad => "agent_session_load_failed",
        AgentStartupStage::SessionResume => "agent_session_resume_failed",
    }
}

fn store_error_status(error: &StoreError) -> (StatusCode, &'static str) {
    match error {
        StoreError::ConversationNotFound(_) | StoreError::RunNotFound(_) => {
            (StatusCode::NOT_FOUND, "not_found")
        }
        StoreError::ActiveRun(_) => (StatusCode::CONFLICT, "active_run"),
        StoreError::Composer(error) => composer_error_status(*error),
        StoreError::InvalidStoredValue(_)
        | StoreError::Json(_)
        | StoreError::Database(_)
        | StoreError::DatabaseSetup(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    }
}

fn composer_error_status(error: ComposerCatalogError) -> (StatusCode, &'static str) {
    match error {
        ComposerCatalogError::StaleRevision => (StatusCode::CONFLICT, "composer_stale_revision"),
        ComposerCatalogError::ItemMissing | ComposerCatalogError::CommandUnavailable => {
            (StatusCode::NOT_FOUND, "composer_item_missing")
        }
        ComposerCatalogError::ItemDisabled | ComposerCatalogError::CommandAmbiguous => {
            (StatusCode::CONFLICT, "composer_item_disabled")
        }
        ComposerCatalogError::ItemUnsupported | ComposerCatalogError::InputUnsupported => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "composer_item_unsupported",
        ),
        ComposerCatalogError::InputRequired => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "acp_command_input_required",
        ),
        ComposerCatalogError::UnexpectedInput => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "acp_command_input_unexpected",
        ),
        ComposerCatalogError::ArgumentsTooLong => {
            (StatusCode::PAYLOAD_TOO_LARGE, "acp_command_input_too_long")
        }
        ComposerCatalogError::ContextStale => (StatusCode::CONFLICT, "composer_context_stale"),
        ComposerCatalogError::ContextOverLimit
        | ComposerCatalogError::SegmentsOverLimit
        | ComposerCatalogError::TextTooLong => {
            (StatusCode::PAYLOAD_TOO_LARGE, "composer_context_over_limit")
        }
        ComposerCatalogError::InvalidDraft => (StatusCode::BAD_REQUEST, "invalid_request"),
    }
}

fn workspace_error_status(error: &WorkspaceError) -> (StatusCode, &'static str) {
    match error {
        WorkspaceError::InvalidPath(_)
        | WorkspaceError::SessionWorkspaceUnavailable
        | WorkspaceError::IneligibleContext(_)
        | WorkspaceError::UnsupportedText
        | WorkspaceError::FileTooLarge => (StatusCode::BAD_REQUEST, "invalid_path"),
        WorkspaceError::AssetTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "asset_too_large"),
        WorkspaceError::ProjectNotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
        WorkspaceError::DuplicateProject(_) => (StatusCode::CONFLICT, "duplicate_project"),
        WorkspaceError::Git(_) => (StatusCode::CONFLICT, "git_worktree_error"),
        WorkspaceError::CheckpointConflict { .. } => (StatusCode::CONFLICT, "checkpoint_conflict"),
        WorkspaceError::Conflict { .. } => (StatusCode::CONFLICT, "revision_conflict"),
        WorkspaceError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::NOT_FOUND, "not_found")
        }
        WorkspaceError::Io(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            (StatusCode::CONFLICT, "already_exists")
        }
        WorkspaceError::Io(_) | WorkspaceError::Database(_) | WorkspaceError::DatabaseSetup(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_domain_acp_command_errors_to_legacy_api_classifications() {
        for (error, expected_status, expected_code) in [
            (
                AcpCommandError::Unavailable,
                StatusCode::CONFLICT,
                "acp_command_unavailable",
            ),
            (
                AcpCommandError::Ambiguous,
                StatusCode::CONFLICT,
                "acp_command_ambiguous",
            ),
            (
                AcpCommandError::UnsupportedInput,
                StatusCode::UNPROCESSABLE_ENTITY,
                "acp_command_input_unsupported",
            ),
            (
                AcpCommandError::InputRequired,
                StatusCode::UNPROCESSABLE_ENTITY,
                "acp_command_input_required",
            ),
            (
                AcpCommandError::UnexpectedInput,
                StatusCode::UNPROCESSABLE_ENTITY,
                "acp_command_input_unexpected",
            ),
            (
                AcpCommandError::ArgumentsTooLong,
                StatusCode::PAYLOAD_TOO_LARGE,
                "acp_command_input_too_long",
            ),
        ] {
            let (status, code, _) = acp_command_error_response(error);
            assert_eq!(status, expected_status);
            assert_eq!(code, expected_code);
        }
    }
}
