//! iLink channel REST surface (issue #127, ADR 0211 §5). All routes sit
//! under the generic `/api/v1` base path behind the existing bearer
//! boundary and return safe status only — never tokens, QR identifiers,
//! upstream responses, or message content.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

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
