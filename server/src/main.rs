use std::env;
use std::error::Error;
use std::sync::Arc;

use clap::Parser;
use kubecode_server::agent_discovery::discover_agents;
use kubecode_server::agents::AgentStore;
use kubecode_server::api::{AppState, app_router_with_static};
use kubecode_server::config::ServerOptions;
use kubecode_server::teams::TeamStore;
use kubecode_server::workspace::WorkspaceService;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let config = ServerOptions::parse().resolve()?;
    for warning in &config.deprecations {
        eprintln!("WARN: {warning}");
    }
    if config.host != "127.0.0.1" && config.host != "::1" && config.host != "localhost" {
        eprintln!(
            "WARN: Kubecode does not provide built-in authentication; protect non-loopback listeners with an authenticated proxy"
        );
    }

    let database_path = config.state_directory.join("kubecode.sqlite3");
    let workspace = WorkspaceService::open(&config.workspace_root, &database_path)?;
    let agent_store = AgentStore::open(&database_path)?;
    let teams = TeamStore::open(&database_path)?;
    let agents = discover_agents().await;
    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    let internal_origin = env::var("KUBECODE_INTERNAL_ORIGIN").unwrap_or_else(|_| {
        format!(
            "http://127.0.0.1:{}{}",
            listener
                .local_addr()
                .map(|address| address.port())
                .unwrap_or(config.port),
            config.base_path
        )
    });
    let state = AppState::new(Arc::new(workspace), Arc::new(agent_store), Arc::new(teams))
        .with_agents(agents)
        .with_team_mcp_http_origin(internal_origin);
    state.start_team_supervisor();
    let app = app_router_with_static(state, &config.base_path, &config.static_directory);
    let display_path = if config.base_path.is_empty() {
        "/"
    } else {
        &config.base_path
    };
    println!(
        "Kubecode listening on http://{}:{}{}",
        config.host, config.port, display_path
    );
    axum::serve(listener, app).await?;
    Ok(())
}
