use std::env;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use kubecode_server::agent_discovery::discover_agents;
use kubecode_server::agents::AgentStore;
use kubecode_server::api::{AppState, app_router_with_static};
use kubecode_server::teams::TeamStore;
use kubecode_server::workspace::WorkspaceService;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let persistent_directory =
        PathBuf::from(env::var("PERSISTENT_DIR").unwrap_or_else(|_| "/home/jovyan/srv".to_owned()));
    let state_directory = env::var_os("KUBECODE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| persistent_directory.join(".state/kubecode"));
    let static_directory =
        PathBuf::from(env::var("KUBECODE_STATIC_DIR").unwrap_or_else(|_| "dist".to_owned()));
    let base_path = env::var("NB_PREFIX").unwrap_or_default();
    let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_owned());
    let port = env::var("PORT")
        .unwrap_or_else(|_| "8888".to_owned())
        .parse::<u16>()?;

    let database_path = state_directory.join("kubecode.sqlite3");
    let workspace = WorkspaceService::open(&persistent_directory, &database_path)?;
    let agent_store = AgentStore::open(&database_path)?;
    let teams = TeamStore::open(&database_path)?;
    let agents = discover_agents().await;
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    let internal_origin = env::var("KUBECODE_INTERNAL_ORIGIN").unwrap_or_else(|_| {
        format!(
            "http://127.0.0.1:{}{}",
            listener
                .local_addr()
                .map(|address| address.port())
                .unwrap_or(port),
            base_path.trim_end_matches('/')
        )
    });
    let state = AppState::new(Arc::new(workspace), Arc::new(agent_store), Arc::new(teams))
        .with_agents(agents)
        .with_team_mcp_http_origin(internal_origin);
    state.start_team_supervisor();
    let app = app_router_with_static(state, &base_path, static_directory);
    println!("Kubecode listening on http://{host}:{port}{base_path}");
    axum::serve(listener, app).await?;
    Ok(())
}
