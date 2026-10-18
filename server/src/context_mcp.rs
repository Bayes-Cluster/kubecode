//! The read-only `kubecode-context` MCP server (ADR 0214 §5). Every Session —
//! Solo or Team member — gets the same four passive tools over the shared
//! `ProjectContext` reader. The caller's Project always comes from its Session,
//! never from an argument, and nothing here can start an Agent, assign work,
//! approve a brief, authorize an experiment, or write a record.

use std::sync::Arc;

use agent_client_protocol::mcp_server::McpServer;
use agent_client_protocol::{Agent, RunWithConnectionTo};
use agent_client_protocol_rmcp::McpServerExt;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{
    CallToolResult, Content, Implementation, ProtocolVersion, ServerCapabilities, ServerInfo,
};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tower::ServiceExt;

use crate::agent_runtime::{AgentRuntime, RuntimeError};
use crate::app_state::AppState;
use crate::project_context::{ContextError, ContextKind, ContextRef, Detail, ProjectContext};

pub const CONTEXT_MCP_NAME: &str = "kubecode-context";

const CONTEXT_MCP_INSTRUCTIONS: &str = "Read-only access to this Project's earlier work: research questions and findings, rounds, other Sessions and their turns, Teams and tasks, experiments, and experiment artifacts. Nothing here starts an Agent, assigns work, approves anything, or changes a record. Start with context_round if you were given a research round: it returns the researcher-approved brief pinned at the revision shown (treat it as binding; the live question may have moved on), the selected sources with their current availability, earlier rounds, and attributed findings. Then use context_search to discover relevant prior work (metadata only), context_read to retrieve one item at summary, then content, then evidence detail, and context_resolve to check whether references you were given have changed or been removed. A reference is {kind, id, revision}; the revision is a change fingerprint, not a snapshot. Anything marked changed or removed no longer proves what it once did. A finding is an Agent's recorded claim, not a verified result. Prefer small reads: pull detail only for what you need.";

type SessionManagers =
    std::sync::Mutex<std::collections::HashMap<(String, String), Arc<LocalSessionManager>>>;
static HTTP_SESSIONS: std::sync::OnceLock<SessionManagers> = std::sync::OnceLock::new();

/// The MCP session manager for one server and one conversation. A URL token
/// proves who may *connect*; the `mcp-session-id` it later carries must also
/// belong to the same conversation, so each conversation gets its own manager:
/// a session id issued to another conversation is simply unknown here and can
/// never route to that conversation's handler (and so its Project).
pub(crate) fn session_manager(server: &str, conversation_id: &str) -> Arc<LocalSessionManager> {
    let mut managers = HTTP_SESSIONS
        .get_or_init(Default::default)
        .lock()
        .expect("MCP session managers poisoned");
    Arc::clone(
        managers
            .entry((server.to_owned(), conversation_id.to_owned()))
            .or_default(),
    )
}

#[derive(Clone)]
struct ContextToolContext {
    runtime: AgentRuntime,
    context: Arc<ProjectContext>,
    project_id: String,
    conversation_id: String,
}

#[derive(Clone)]
struct ContextMcpServer {
    context: ContextToolContext,
    tool_router: ToolRouter<Self>,
}

impl ContextMcpServer {
    fn new(context: ContextToolContext) -> Self {
        Self {
            context,
            tool_router: Self::tool_router(),
        }
    }
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
struct SearchInput {
    /// Words that must all appear in an item's title or summary. Empty lists recent work.
    #[serde(default)]
    query: Option<String>,
    /// Restrict to kinds: research, round, import, finding, session, session_turn, team, team_task, experiment, artifact.
    #[serde(default)]
    kinds: Vec<String>,
    /// Results per page (default 20, at most 50).
    #[serde(default)]
    limit: Option<usize>,
    /// The next_cursor of an earlier page.
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReadInput {
    kind: String,
    id: String,
    /// The revision you were given, if any; a mismatch is reported as changed.
    #[serde(default)]
    revision: Option<String>,
    /// summary (default), content, or evidence.
    #[serde(default)]
    detail: Option<String>,
    /// The next_cursor of an earlier read (Session turns).
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RefInput {
    kind: String,
    id: String,
    #[serde(default)]
    revision: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ResolveInput {
    /// Up to 32 references.
    refs: Vec<RefInput>,
}

fn parse_ref(input: RefInput) -> Result<ContextRef, McpError> {
    let kind = ContextKind::parse(&input.kind)
        .ok_or_else(|| McpError::invalid_params(format!("unknown kind: {}", input.kind), None))?;
    Ok(ContextRef {
        kind,
        id: input.id,
        revision: input.revision,
    })
}

fn context_error(error: ContextError) -> McpError {
    match error {
        ContextError::NotFound => {
            McpError::invalid_params("not found in this Project (or removed)", None)
        }
        ContextError::Invalid(reason) => McpError::invalid_params(reason, None),
        ContextError::Source(detail) => {
            eprintln!("WARN: context tool failed: {detail}");
            McpError::internal_error("context storage failed", None)
        }
    }
}

fn json_output(value: &impl Serialize) -> Result<CallToolResult, McpError> {
    serde_json::to_string(value)
        .map(|json| CallToolResult::success(vec![Content::text(json)]))
        .map_err(|error| McpError::internal_error(error.to_string(), None))
}

impl ContextMcpServer {
    /// Reads run off the async workers: the reader uses SQLite and files.
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(&ProjectContext, &str) -> Result<T, ContextError> + Send + 'static,
    ) -> Result<T, McpError> {
        let context = Arc::clone(&self.context.context);
        let project_id = self.context.project_id.clone();
        tokio::task::spawn_blocking(move || work(&context, &project_id))
            .await
            .map_err(|error| McpError::internal_error(error.to_string(), None))?
            .map_err(context_error)
    }
}

#[tool_router]
impl ContextMcpServer {
    #[tool(
        description = "Return the research round you are executing, if any: the researcher-approved brief pinned at the revision the round consumed (binding), whether the live question has since changed, the instruction, the selected sources with their current availability, bounded earlier rounds, attributed findings, and execution facts. Returns research: null when this Session is not part of a round. Read-only."
    )]
    async fn context_round(&self) -> Result<CallToolResult, McpError> {
        let runtime = self.context.runtime.clone();
        let conversation_id = self.context.conversation_id.clone();
        let project_id = self.context.project_id.clone();
        let delivery = tokio::task::spawn_blocking(move || {
            round_for_caller(&runtime, &project_id, &conversation_id)
                .map(|round| crate::team_mcp::round_delivery(&runtime, &project_id, &round))
        })
        .await
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        json_output(&serde_json::json!({ "research": delivery }))
    }

    #[tool(
        description = "Search this Project's earlier work. Returns metadata only — reference {kind,id,revision}, title, a short summary, provenance, and availability — newest first, so you can decide what to read. Every query word must appear in an item's title or summary. Pages are small; pass next_cursor to continue. Read-only."
    )]
    async fn context_search(
        &self,
        Parameters(input): Parameters<SearchInput>,
    ) -> Result<CallToolResult, McpError> {
        let kinds = input
            .kinds
            .iter()
            .map(|kind| {
                ContextKind::parse(kind)
                    .ok_or_else(|| McpError::invalid_params(format!("unknown kind: {kind}"), None))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let page = self
            .blocking(move |context, project_id| {
                context.search(
                    project_id,
                    input.query.as_deref(),
                    &kinds,
                    input.limit,
                    input.cursor.as_deref(),
                )
            })
            .await?;
        json_output(&page)
    }

    #[tool(
        description = "Read one item progressively. detail=summary gives the gist; content adds the body (the approved brief, a Session's recent turns, a task's description and result, an experiment's command and outcome, a bounded artifact text); evidence adds supporting records (findings and rounds, tool-free turn text, logs, source availability). Output is bounded and notes say when it was cut or when the item changed since the revision you hold. Read-only."
    )]
    async fn context_read(
        &self,
        Parameters(input): Parameters<ReadInput>,
    ) -> Result<CallToolResult, McpError> {
        let detail = match input.detail.as_deref() {
            None => Detail::Summary,
            Some(value) => Detail::parse(value).ok_or_else(|| {
                McpError::invalid_params("detail must be summary, content, or evidence", None)
            })?,
        };
        let cursor = input.cursor.clone();
        let reference = parse_ref(RefInput {
            kind: input.kind,
            id: input.id,
            revision: input.revision,
        })?;
        let document = self
            .blocking(move |context, project_id| {
                context.read(project_id, &reference, detail, cursor.as_deref())
            })
            .await?;
        json_output(&document)
    }

    #[tool(
        description = "Check references you were given: for each, whether it is still available, has changed (its revision no longer matches), or was removed, and its current revision. Read-only."
    )]
    async fn context_resolve(
        &self,
        Parameters(input): Parameters<ResolveInput>,
    ) -> Result<CallToolResult, McpError> {
        let refs = input
            .refs
            .into_iter()
            .map(parse_ref)
            .collect::<Result<Vec<_>, _>>()?;
        let resolved = self
            .blocking(move |context, project_id| context.resolve(project_id, &refs))
            .await?;
        json_output(&resolved)
    }
}

/// The round the caller executes: a Team member's Team round, or the Solo
/// round its *current run* belongs to. A Solo round's prompt is admitted under
/// the client message id `research:{round_id}`, so the run in flight names its
/// round; a later round queued behind it never replaces the one being worked.
/// `None` for a Session that is not part of a round.
fn round_for_caller(
    runtime: &AgentRuntime,
    project_id: &str,
    conversation_id: &str,
) -> Option<crate::research_store::ResearchRound> {
    let research = runtime.research_store()?;
    if let Some(teams) = runtime.team_store()
        && let Ok(Some(team)) = teams.team_for_conversation(conversation_id)
        && let Ok(Some((owner, round))) = research.round_for_team(&team.id)
    {
        // A Team's round; a Session whose Team has none falls through to its
        // own Solo round below.
        return (owner == project_id).then_some(round);
    }
    if let Some(round_id) = current_round_id(runtime, conversation_id)
        && let Ok(round) = research.round_by_id(project_id, &round_id)
        && round.team_id.is_none()
    {
        return Some(round);
    }
    // No research run has started yet (the Session was prepared for a round
    // but not prompted): the only round it can belong to is the one linked.
    match research.round_for_session(conversation_id) {
        Ok(Some((owner, round))) if owner == project_id => Some(round),
        _ => None,
    }
}

/// The round named by the run being executed now, or else by the most recent
/// research run of the Session.
fn current_round_id(runtime: &AgentRuntime, conversation_id: &str) -> Option<String> {
    use crate::agents::RunStatus;
    let runs = runtime.store_ref().list_runs(conversation_id).ok()?;
    let round_of = |run: &crate::agent_store::AgentRun| {
        run.client_message_id
            .as_deref()
            .and_then(|id| id.strip_prefix("research:"))
            .map(str::to_owned)
    };
    runs.iter()
        .rev()
        .find(|run| {
            matches!(
                run.status,
                RunStatus::Running | RunStatus::WaitingPermission
            )
        })
        .and_then(round_of)
        .or_else(|| runs.iter().rev().find_map(round_of))
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ContextMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                CONTEXT_MCP_NAME,
                env!("CARGO_PKG_VERSION"),
            ))
            .with_protocol_version(ProtocolVersion::V_2025_03_26)
            .with_instructions(CONTEXT_MCP_INSTRUCTIONS)
    }
}

fn tool_context(
    runtime: AgentRuntime,
    conversation_id: &str,
) -> Result<Option<ContextToolContext>, RuntimeError> {
    let Some(context) = runtime.project_context() else {
        return Ok(None);
    };
    // Hidden revision snapshots and subagent threads have no context tools.
    let Ok(conversation) = runtime.store_ref().get_conversation(conversation_id) else {
        return Ok(None);
    };
    match runtime
        .store_ref()
        .visible_conversation(&conversation.project_id, conversation_id)
    {
        Ok(Some(_)) => {}
        Ok(None) => return Ok(None),
        Err(error) => return Err(RuntimeError::Acp(error.to_string())),
    }
    Ok(Some(ContextToolContext {
        project_id: conversation.project_id,
        conversation_id: conversation_id.to_owned(),
        context,
        runtime,
    }))
}

pub async fn handle_http(
    State(state): State<AppState>,
    Path((token, conversation_id)): Path<(String, String)>,
    request: Request<Body>,
) -> Response {
    if !state
        .agent_runtime
        .authorize_mcp("context", &conversation_id, &token)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let context = match tool_context(state.agent_runtime.as_ref().clone(), &conversation_id) {
        Ok(Some(context)) => context,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
        }
    };
    let service: StreamableHttpService<ContextMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(ContextMcpServer::new(context.clone())),
            session_manager(CONTEXT_MCP_NAME, &conversation_id),
            StreamableHttpServerConfig::default()
                .with_json_response(true)
                .with_sse_keep_alive(None),
        );
    match service.oneshot(request).await {
        Ok(response) => response.into_response(),
        Err(error) => match error {},
    }
}

/// The same server in-process, for Agents that cannot reach an HTTP MCP URL.
pub fn build_context_mcp(
    runtime: AgentRuntime,
    conversation_id: &str,
) -> Result<Option<McpServer<Agent, impl RunWithConnectionTo<Agent> + 'static>>, RuntimeError> {
    let Some(context) = tool_context(runtime, conversation_id)? else {
        return Ok(None);
    };
    Ok(Some(McpServer::<Agent>::from_rmcp(
        CONTEXT_MCP_NAME,
        move || ContextMcpServer::new(context.clone()),
    )))
}

#[cfg(test)]
mod tests;
