use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;

use super::AppState;

pub(super) async fn list_agents(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.agents.entries())
}

pub(super) async fn refresh_agents(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.agents.refresh().await)
}
