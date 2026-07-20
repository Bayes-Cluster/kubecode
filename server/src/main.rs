use std::env;
use std::error::Error;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use kubecode_server::agent_discovery::AgentCatalog;
use kubecode_server::agents::AgentStore;
use kubecode_server::api::{AppState, app_router_with_static};
use kubecode_server::config::ServerOptions;
use kubecode_server::doctor::DoctorReport;
use kubecode_server::teams::TeamStore;
use kubecode_server::workspace::WorkspaceService;

#[derive(Debug, Parser)]
#[command(
    name = "kubecode",
    bin_name = "kubecode",
    version,
    about = "Browser-based, project-oriented AI coding workspace"
)]
struct Cli {
    #[command(flatten)]
    server: ServerOptions,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Check the local Kubecode runtime without creating an Agent Session.
    Doctor {
        /// Emit a machine-readable schema-versioned report.
        #[arg(long)]
        json: bool,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let config = cli.server.resolve()?;
    if let Some(Command::Doctor { json }) = cli.command {
        let report = DoctorReport::collect(&config).await;
        if json {
            println!("{}", serde_json::to_string_pretty(&report)?);
        } else {
            println!("{}", report.render_text());
        }
        if !report.success() {
            std::process::exit(1);
        }
        return Ok(());
    }
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
    let agents = AgentCatalog::discover().await;
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
        .with_agent_catalog(agents)
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

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser};

    use super::{Cli, Command};

    #[test]
    fn public_cli_name_is_kubecode() {
        assert_eq!(Cli::command().get_bin_name(), Some("kubecode"));
    }

    #[test]
    fn doctor_subcommand_accepts_json_output() {
        let cli = Cli::try_parse_from(["kubecode", "doctor", "--json"]).expect("doctor command");
        assert!(matches!(cli.command, Some(Command::Doctor { json: true })));
    }
}
