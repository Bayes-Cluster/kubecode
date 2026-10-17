//! iLink channel REST surface (issue #127, ADR 0211 §5). All routes sit
//! under the generic `/api/v1` base path behind the existing bearer
//! boundary and return safe status only — never tokens, QR identifiers,
//! upstream responses, or message content.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::agent_store::ILINK_QUICK_PROMPT_SLOTS;
use crate::ilink::commands::QUICK_PROMPT_MAX_CHARS;
use crate::ilink::service::{ConnectionStatus, ServiceError};

use super::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/ilink/status", get(ilink_status))
        .route("/ilink/login/qr", post(ilink_login_start))
        .route("/ilink/login/qr/poll", get(ilink_login_poll))
        .route("/ilink/login/verify", post(ilink_login_verify))
        .route("/ilink/login/cancel", post(ilink_login_cancel))
        .route("/ilink/reconnect", post(ilink_reconnect))
        .route("/ilink/disconnect", post(ilink_disconnect))
        .route("/ilink/quick-prompts", get(list_quick_prompts))
        .route(
            "/ilink/quick-prompts/{slot}",
            put(set_quick_prompt).delete(remove_quick_prompt),
        )
}

fn service_error_response(error: ServiceError) -> Response {
    let (status, code) = match &error {
        ServiceError::NotAvailable => (StatusCode::NOT_FOUND, "ilink_not_available"),
        ServiceError::InvalidState(_) => (StatusCode::CONFLICT, "ilink_invalid_state"),
        ServiceError::CooldownActive(_) => (StatusCode::CONFLICT, "ilink_cooldown_active"),
        ServiceError::Protocol(_) | ServiceError::Store(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "ilink_error")
        }
    };
    (
        status,
        Json(json!({ "code": code, "message": error.to_string() })),
    )
        .into_response()
}

fn status_payload(status: crate::ilink::service::ServiceStatus) -> Value {
    json!({
        "status": status.status.as_str(),
        "account_id": status.account_id,
        "display_name": status.display_name,
        "bound_conversation_id": status.bound_conversation_id,
        "login_active": status.login_active,
        "login_expires_in_ms": status.login_expires_in_ms,
    })
}

async fn ilink_status(State(state): State<AppState>) -> Response {
    let status = state.ilink.status().await;
    Json(status_payload(status)).into_response()
}

async fn ilink_login_start(State(state): State<AppState>) -> Response {
    match state.ilink.start_login().await {
        Ok(start) => {
            let status = state.ilink.status().await;
            Json(json!({
                "reused": start.reused,
                "image_url": start.image_url,
                "expires_in_ms": start.expires_in_ms,
                "status": status.status.as_str(),
            }))
            .into_response()
        }
        Err(error) => service_error_response(error),
    }
}

async fn ilink_login_poll(State(state): State<AppState>) -> Response {
    let status = state.ilink.status().await;
    let mut payload = status_payload(status);
    // The QR image rides along only while the login is still live.
    payload["image_url"] = state
        .ilink
        .active_login_image()
        .await
        .map(Value::String)
        .unwrap_or(Value::Null);
    Json(payload).into_response()
}

async fn ilink_login_verify(
    State(state): State<AppState>,
    Json(body): Json<VerifyCodeBody>,
) -> Response {
    match state.ilink.submit_verification_code(&body.code).await {
        Ok(()) => {
            let status = state.ilink.status().await;
            Json(json!({ "accepted": true, "status": status.status.as_str() })).into_response()
        }
        Err(error) => service_error_response(error),
    }
}

#[derive(Deserialize)]
struct VerifyCodeBody {
    code: String,
}

async fn ilink_login_cancel(State(state): State<AppState>) -> Response {
    state.ilink.cancel_login().await;
    let status = state.ilink.status().await;
    Json(json!({ "cancelled": true, "status": status.status.as_str() })).into_response()
}

async fn ilink_reconnect(State(state): State<AppState>) -> Response {
    match state.ilink.reconnect().await {
        Ok(()) => {
            let status = state.ilink.status().await;
            Json(json!({ "reconnecting": true, "status": status.status.as_str() })).into_response()
        }
        Err(error) => service_error_response(error),
    }
}

async fn ilink_disconnect(State(state): State<AppState>) -> Response {
    match state.ilink.disconnect().await {
        Ok(()) => {
            Json(json!({ "status": ConnectionStatus::Disconnected.as_str() })).into_response()
        }
        Err(error) => service_error_response(error),
    }
}

// -- Quick prompts (issue #133) ----------------------------------------------
//
// The smallest server-owned settings model for `!q`: numbered slots per
// linked account. Content is the user's own setting; it never enters
// workspace events or analytics.

#[derive(Deserialize)]
struct QuickPromptBody {
    content: String,
}

fn quick_prompt_error(status: StatusCode, code: &'static str, message: &str) -> Response {
    (status, Json(json!({ "code": code, "message": message }))).into_response()
}

/// The linked account is the one with stored credentials, so settings stay
/// editable while the channel is disconnected but still linked.
fn linked_account(state: &AppState) -> Option<String> {
    state
        .agent_runtime
        .store()
        .first_ilink_credentials()
        .map(|credentials| credentials.account_id)
}

fn valid_slot(slot: u8) -> bool {
    (1..=ILINK_QUICK_PROMPT_SLOTS).contains(&slot)
}

fn invalid_slot() -> Response {
    quick_prompt_error(
        StatusCode::BAD_REQUEST,
        "invalid_quick_prompt_slot",
        "quick prompt slot is out of range",
    )
}

async fn list_quick_prompts(State(state): State<AppState>) -> Response {
    let Some(account_id) = linked_account(&state) else {
        return service_error_response(ServiceError::NotAvailable);
    };
    match state.agent_runtime.store().ilink_quick_prompts(&account_id) {
        Ok(prompts) => Json(json!({
            "slots": ILINK_QUICK_PROMPT_SLOTS,
            "max_chars": QUICK_PROMPT_MAX_CHARS,
            "prompts": prompts
                .into_iter()
                .map(|(slot, content)| json!({ "slot": slot, "content": content }))
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(error) => service_error_response(ServiceError::Store(error)),
    }
}

async fn set_quick_prompt(
    State(state): State<AppState>,
    Path(slot): Path<u8>,
    Json(body): Json<QuickPromptBody>,
) -> Response {
    let Some(account_id) = linked_account(&state) else {
        return service_error_response(ServiceError::NotAvailable);
    };
    if !valid_slot(slot) {
        return invalid_slot();
    }
    let content = body.content.trim();
    if content.is_empty() || content.chars().count() > QUICK_PROMPT_MAX_CHARS {
        return quick_prompt_error(
            StatusCode::BAD_REQUEST,
            "invalid_quick_prompt",
            "quick prompt must be non-empty and within the length limit",
        );
    }
    match state
        .agent_runtime
        .store()
        .set_ilink_quick_prompt(&account_id, slot, content)
    {
        Ok(()) => Json(json!({ "slot": slot, "content": content })).into_response(),
        Err(error) => service_error_response(ServiceError::Store(error)),
    }
}

async fn remove_quick_prompt(State(state): State<AppState>, Path(slot): Path<u8>) -> Response {
    let Some(account_id) = linked_account(&state) else {
        return service_error_response(ServiceError::NotAvailable);
    };
    if !valid_slot(slot) {
        return invalid_slot();
    }
    match state
        .agent_runtime
        .store()
        .remove_ilink_quick_prompt(&account_id, slot)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => service_error_response(ServiceError::Store(error)),
    }
}
