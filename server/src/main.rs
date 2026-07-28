use std::env;
use std::error::Error;
use std::io::{self, BufRead};
use std::net::SocketAddr;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use kubecode_server::agent_discovery::AgentCatalog;
use kubecode_server::agents::AgentStore;
use kubecode_server::api::{AppState, app_router_api_only, app_router_with_static};
use kubecode_server::config::ServerOptions;
use kubecode_server::database::Database;
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

    /// Serve only the versioned Runtime API without browser assets.
    #[arg(long)]
    api_only: bool,

    /// Read the desktop bearer token from the first line of standard input.
    #[arg(long, requires = "api_only")]
    access_token_stdin: bool,

    /// Print a single machine-readable readiness document after binding.
    #[arg(long)]
    ready_json: bool,

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
    let Cli {
        server,
        api_only,
        access_token_stdin,
        ready_json,
        command,
    } = Cli::parse();
    let config = server.resolve()?;
    if let Some(Command::Doctor { json }) = command {
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
    let access_token = if api_only {
        if !access_token_stdin {
            return Err("--api-only requires --access-token-stdin".into());
        }
        Some(read_access_token(io::stdin().lock())?)
    } else {
        None
    };
    for warning in &config.deprecations {
        eprintln!("WARN: {warning}");
    }
    if config.host != "127.0.0.1" && config.host != "::1" && config.host != "localhost" {
        eprintln!(
            "WARN: Kubecode does not provide built-in authentication; protect non-loopback listeners with an authenticated proxy"
        );
    }

    let database_path = config.state_directory.join("kubecode.sqlite3");
    let database = Arc::new(Database::open_owned(&database_path)?);
    let workspace = WorkspaceService::from_database(&config.workspace_root, Arc::clone(&database))?;
    let agent_store = AgentStore::from_database(Arc::clone(&database))?;
    let teams = TeamStore::from_database(database)?;
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
    let app = match access_token {
        Some(access_token) => app_router_api_only(state, &config.base_path, access_token),
        None => app_router_with_static(state, &config.base_path, &config.static_directory),
    };
    let local_address = listener.local_addr()?;
    let display_path = if config.base_path.is_empty() {
        "/"
    } else {
        &config.base_path
    };
    if ready_json {
        println!(
            "{}",
            ready_document(&config.host, local_address, display_path)
        );
    } else {
        println!(
            "Kubecode listening on http://{}:{}{}",
            config.host,
            local_address.port(),
            display_path
        );
    }
    axum::serve(listener, app).await?;
    Ok(())
}

fn read_access_token(mut reader: impl BufRead) -> io::Result<String> {
    let mut token = String::new();
    reader.read_line(&mut token)?;
    let token = token.trim_end_matches(['\r', '\n']).to_owned();
    if token.is_empty() {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "desktop access token must not be empty",
        ))
    } else {
        Ok(token)
    }
}

fn ready_document(host: &str, address: SocketAddr, base_path: &str) -> String {
    serde_json::json!({
        "type": "ready",
        "protocol_version": 1,
        "server_version": env!("CARGO_PKG_VERSION"),
        "instance_id": uuid::Uuid::new_v4(),
        "origin": format!("http://{host}:{}", address.port()),
        "base_path": base_path,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use clap::{CommandFactory, Parser};

    use super::{Cli, Command, read_access_token, ready_document};

    #[test]
    fn public_cli_name_is_kubecode() {
        assert_eq!(Cli::command().get_bin_name(), Some("kubecode"));
    }

    #[test]
    fn doctor_subcommand_accepts_json_output() {
        let cli = Cli::try_parse_from(["kubecode", "doctor", "--json"]).expect("doctor command");
        assert!(matches!(cli.command, Some(Command::Doctor { json: true })));
    }

    #[test]
    fn desktop_runtime_flags_are_explicit_and_composable() {
        let cli = Cli::try_parse_from([
            "kubecode",
            "--port",
            "0",
            "--api-only",
            "--access-token-stdin",
            "--ready-json",
        ])
        .expect("desktop arguments");

        assert_eq!(cli.server.port, Some(0));
        assert!(cli.api_only);
        assert!(cli.access_token_stdin);
        assert!(cli.ready_json);
    }

    #[test]
    fn desktop_access_token_is_trimmed_but_not_allowed_to_be_empty() {
        assert_eq!(
            read_access_token(Cursor::new("secret\n")).expect("token"),
            "secret"
        );
        assert!(read_access_token(Cursor::new("\n")).is_err());
    }

    #[test]
    fn ready_document_uses_the_bound_port_instead_of_the_requested_port() {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43127);
        let document: serde_json::Value =
            serde_json::from_str(&ready_document("127.0.0.1", address, "/")).expect("json");

        assert_eq!(document["origin"], "http://127.0.0.1:43127");
        assert_eq!(document["protocol_version"], 1);
        assert!(document.get("token").is_none());
    }
}
