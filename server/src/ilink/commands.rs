//! Peer-isolated WeChat Session control commands (issue #133). A text
//! message starting with ASCII `!` or full-width `！` is a command:
//!
//! - `!` — safe status of the bound Session;
//! - `!s [page]` — switch the bound Session;
//! - `!n [page]` — create and bind a new Session (Project, then Agent);
//! - `!m` — change the Session's advertised model/mode options;
//! - `!q` — send a configured quick prompt;
//! - anything else — help plus status.
//!
//! Every command first requests idempotent cancellation of the bound
//! Session's active run and continues even if that races with completion.
//! Menus are server-authoritative state keyed by account + peer: numbered
//! 1..N per page, expiring, fenced by the timestamp of the command that
//! opened them (a reply sent before the menu existed is stale), and every
//! selection is revalidated against current server state before it acts.
//! Replies carry display names only — never paths, cwd, prompt content,
//! tool arguments, or credentials.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::agent_runtime::{AgentRuntime, SessionConfigInput};
use crate::agent_store::{AgentStore, Conversation, ConversationRelationship, RunStatus};
use crate::agents::AgentId;
use crate::workspace::WorkspaceService;

use super::inbound::{BridgePrompt, ChannelLanguage, ChannelReply, ResponseChannel};
use super::router::SessionRouter;

/// Entries per menu page (single-digit replies).
pub const MENU_PAGE_SIZE: usize = 9;
/// Upper bound for model/mode menus, which are not paged.
pub const OPTION_MENU_LIMIT: usize = 20;
/// How long a menu stays answerable.
pub const MENU_TTL: Duration = Duration::from_secs(120);
/// Longest quick prompt accepted by the settings API.
pub const QUICK_PROMPT_MAX_CHARS: usize = 2_000;

const TITLE_LIMIT: usize = 48;
const PREVIEW_LIMIT: usize = 40;

/// A parsed control command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Status,
    Sessions { page: usize },
    NewSession { page: usize },
    Model,
    QuickPrompts,
    Unknown,
}

/// Recognizes a command only at the very start of a message (leading
/// whitespace allowed); `!` and `！` are equivalent.
pub fn parse_command(text: &str) -> Option<Command> {
    let trimmed = text.trim_start();
    let rest = trimmed
        .strip_prefix('!')
        .or_else(|| trimmed.strip_prefix('！'))?;
    let mut words = rest.split_whitespace();
    let head = words.next().unwrap_or("").to_ascii_lowercase();
    let page = words
        .next()
        .and_then(|word| word.parse::<usize>().ok())
        .filter(|page| *page >= 1)
        .unwrap_or(1);
    Some(match head.as_str() {
        "" => Command::Status,
        "s" => Command::Sessions { page },
        "n" => Command::NewSession { page },
        "m" => Command::Model,
        "q" => Command::QuickPrompts,
        _ => Command::Unknown,
    })
}

/// The send timestamp encoded in an inbound message key
/// (`sender:timestamp:sequence`), when present.
fn message_timestamp(message_key: &str) -> Option<i64> {
    let mut parts = message_key.rsplitn(3, ':');
    let _sequence = parts.next()?;
    parts.next()?.parse::<i64>().ok().filter(|ts| *ts > 0)
}

fn selection_number(text: &str) -> Option<usize> {
    let text = text.trim();
    if text.is_empty() || text.len() > 3 || !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum MenuEntry {
    Session {
        conversation_id: String,
    },
    Project {
        project_id: String,
    },
    Agent {
        project_id: String,
        agent_id: AgentId,
    },
    Mode {
        conversation_id: String,
        mode_id: String,
    },
    Config {
        conversation_id: String,
        config_id: String,
        value: String,
    },
    QuickPrompt {
        slot: u8,
    },
}

struct Menu {
    entries: Vec<MenuEntry>,
    opened_at_ms: Option<i64>,
    expires_at: Instant,
}

/// One advertised select value of the bound Session.
#[derive(Clone, Debug, PartialEq, Eq)]
struct AdvertisedChoice {
    group: String,
    current: bool,
    label: String,
    entry: MenuEntry,
}

/// A rendered reply plus the menu it opens, if any.
struct Rendered {
    text: String,
    menu: Option<Vec<MenuEntry>>,
}

impl Rendered {
    fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            menu: None,
        }
    }
}

/// The command state machine for the linked account's peers.
pub struct CommandCenter {
    runtime: Arc<AgentRuntime>,
    store: Arc<AgentStore>,
    workspace: Arc<WorkspaceService>,
    router: Arc<SessionRouter>,
    language: ChannelLanguage,
    ttl: Duration,
    menus: Mutex<HashMap<(String, String), Menu>>,
}

impl CommandCenter {
    pub fn new(
        runtime: Arc<AgentRuntime>,
        router: Arc<SessionRouter>,
        language: ChannelLanguage,
    ) -> Arc<Self> {
        Self::with_ttl(runtime, router, language, MENU_TTL)
    }

    pub fn with_ttl(
        runtime: Arc<AgentRuntime>,
        router: Arc<SessionRouter>,
        language: ChannelLanguage,
        ttl: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            store: runtime.store(),
            workspace: runtime.workspace_service(),
            runtime,
            router,
            language,
            ttl,
            menus: Mutex::new(HashMap::new()),
        })
    }

    /// Handles a command or a menu selection. Returns `false` when the
    /// message is neither, so the caller routes it as a prompt; any such
    /// message also closes the peer's open menu.
    pub async fn handle(&self, prompt: &BridgePrompt, responses: &dyn ResponseChannel) -> bool {
        let key = (prompt.account_id.clone(), prompt.peer_id.clone());
        if let Some(command) = parse_command(&prompt.text) {
            self.menus.lock().await.remove(&key);
            let interrupted = self.interrupt(&prompt.account_id);
            let rendered = self.run_command(command, &prompt.account_id).await;
            let mut text = String::new();
            if interrupted {
                text.push_str(self.pick("Interrupted the running task.", "已中断正在运行的任务。"));
                text.push_str("\n\n");
            }
            text.push_str(&rendered.text);
            self.open_menu(key, rendered.menu, &prompt.message_key)
                .await;
            reply(responses, prompt, text);
            return true;
        }
        let Some(number) = selection_number(&prompt.text) else {
            self.menus.lock().await.remove(&key);
            return false;
        };
        let Some(menu) = self.menus.lock().await.remove(&key) else {
            return false;
        };
        let sent_at = message_timestamp(&prompt.message_key);
        let predates = matches!(
            (sent_at, menu.opened_at_ms),
            (Some(sent), Some(opened)) if sent < opened
        );
        if Instant::now() > menu.expires_at || predates {
            reply(
                responses,
                prompt,
                self.pick(
                    "That menu is no longer current. Send the command again.",
                    "该菜单已失效，请重新发送命令。",
                ),
            );
            return true;
        }
        let Some(entry) = number
            .checked_sub(1)
            .and_then(|index| menu.entries.get(index))
            .cloned()
        else {
            let text = match self.language {
                ChannelLanguage::En => {
                    format!("Reply with a number from 1 to {}.", menu.entries.len())
                }
                ChannelLanguage::ZhCn => format!("请回复 1 到 {} 之间的数字。", menu.entries.len()),
            };
            // An invalid number keeps the same menu open for a retry.
            self.menus.lock().await.insert(key, menu);
            reply(responses, prompt, text);
            return true;
        };
        let rendered = self.select(entry, prompt, responses).await;
        if let Some(rendered) = rendered {
            self.open_menu(key, rendered.menu, &prompt.message_key)
                .await;
            reply(responses, prompt, rendered.text);
        }
        true
    }

    async fn open_menu(
        &self,
        key: (String, String),
        entries: Option<Vec<MenuEntry>>,
        message_key: &str,
    ) {
        let Some(entries) = entries.filter(|entries| !entries.is_empty()) else {
            return;
        };
        self.menus.lock().await.insert(
            key,
            Menu {
                entries,
                opened_at_ms: message_timestamp(message_key),
                expires_at: Instant::now() + self.ttl,
            },
        );
    }

    fn pick(&self, en: &'static str, zh: &'static str) -> &'static str {
        match self.language {
            ChannelLanguage::En => en,
            ChannelLanguage::ZhCn => zh,
        }
    }

    // -- Interrupt -----------------------------------------------------------

    /// Requests cancellation of the bound Session's active run. Idempotent:
    /// a run that already finished is simply not cancelled.
    fn interrupt(&self, account_id: &str) -> bool {
        let Some(conversation_id) = self.bound_conversation(account_id) else {
            return false;
        };
        let Ok(runs) = self.store.list_runs(&conversation_id) else {
            return false;
        };
        // Every active run is cancelled; no short-circuiting.
        let mut cancelled = false;
        for run in runs.iter().filter(|run| {
            matches!(
                run.status,
                RunStatus::Running | RunStatus::WaitingPermission
            )
        }) {
            cancelled |= self.runtime.cancel(&run.id);
        }
        cancelled
    }

    fn bound_conversation(&self, account_id: &str) -> Option<String> {
        self.store.ilink_session_binding(account_id).ok().flatten()
    }

    // -- Commands --------------------------------------------------------------

    async fn run_command(&self, command: Command, account_id: &str) -> Rendered {
        match command {
            Command::Status => Rendered::text(self.status(account_id)),
            Command::Sessions { page } => self.sessions_menu(account_id, page),
            Command::NewSession { page } => self.projects_menu(page),
            Command::Model => self.options_menu(account_id),
            Command::QuickPrompts => self.quick_prompts_menu(account_id),
            Command::Unknown => {
                Rendered::text(format!("{}\n\n{}", self.help(), self.status(account_id)))
            }
        }
    }

    fn help(&self) -> &'static str {
        self.pick(
            "Commands:\n! — status\n!s — switch Session\n!n — new Session\n!m — model / mode\n!q — quick prompts",
            "命令：\n! — 状态\n!s — 切换 Session\n!n — 新建 Session\n!m — 模型 / 模式\n!q — 快捷指令",
        )
    }

    /// Safe status: display names, Agent, option summary, run/queue state,
    /// and command counts — nothing path- or content-bearing.
    fn status(&self, account_id: &str) -> String {
        let Some(conversation) = self
            .bound_conversation(account_id)
            .and_then(|id| self.store.get_conversation(&id).ok())
        else {
            return self
                .pick(
                    "No Session is bound. Use !s to pick one or !n to create one.",
                    "尚未绑定 Session。使用 !s 选择，或 !n 新建。",
                )
                .to_owned();
        };
        let project = self.project_label(&conversation.project_id);
        let state = match conversation.latest_run_status {
            Some(RunStatus::Running) => self.pick("running", "运行中"),
            Some(RunStatus::WaitingPermission) => self.pick("waiting for permission", "等待授权"),
            _ => self.pick("idle", "空闲"),
        };
        let queued = self
            .store
            .list_queued_prompts(&conversation.id)
            .map(|items| items.len())
            .unwrap_or(0);
        let session_state = SessionOptions::load(&self.store, &conversation.id);
        let mut lines = vec![
            format!(
                "{}{}",
                self.pick("Session: ", "Session："),
                bounded(&conversation.title, TITLE_LIMIT)
            ),
            format!("{}{project}", self.pick("Project: ", "项目：")),
            format!(
                "{}{}",
                self.pick("Agent: ", "Agent："),
                agent_label(conversation.agent_id)
            ),
        ];
        for (group, current) in session_state.current_summary() {
            lines.push(format!("{group}: {current}"));
        }
        lines.push(format!(
            "{}{state} · {}{queued}",
            self.pick("State: ", "状态："),
            self.pick("queued: ", "排队："),
        ));
        if let Some(commands) = session_state.command_count {
            lines.push(format!(
                "{}{commands}",
                self.pick("Agent commands: ", "Agent 命令数："),
            ));
        }
        lines.join("\n")
    }

    fn project_label(&self, project_id: &str) -> String {
        self.workspace
            .project(project_id)
            .map(|project| bounded(&project.name, TITLE_LIMIT))
            .unwrap_or_else(|_| self.pick("(unavailable)", "（不可用）").to_owned())
    }

    /// Whether a Session may be bound from WeChat right now (ADR 0211 §13).
    fn bindable(&self, conversation: &Conversation) -> bool {
        if conversation.archived
            || conversation.read_only
            || matches!(
                conversation.relationship,
                Some(ConversationRelationship::Subagent | ConversationRelationship::TeamMember)
            )
            || self.workspace.project(&conversation.project_id).is_err()
        {
            return false;
        }
        let team_owned = self
            .runtime
            .team_store()
            .and_then(|teams| teams.member_for_conversation(&conversation.id).ok())
            .flatten()
            .is_some();
        !team_owned
    }

    fn sessions_menu(&self, account_id: &str, page: usize) -> Rendered {
        let bound = self.bound_conversation(account_id);
        let sessions: Vec<Conversation> = self
            .store
            .list_all_conversations()
            .unwrap_or_default()
            .into_iter()
            .filter(|conversation| self.bindable(conversation))
            .collect();
        if sessions.is_empty() {
            return Rendered::text(self.pick(
                "No Sessions can be bound. Use !n to create one.",
                "没有可绑定的 Session。使用 !n 新建。",
            ));
        }
        let (page, pages, slice) = paginate(&sessions, page);
        // Group the page by Project while keeping recency order.
        let mut groups: Vec<(String, Vec<&Conversation>)> = Vec::new();
        for conversation in slice {
            match groups
                .iter_mut()
                .find(|(project_id, _)| *project_id == conversation.project_id)
            {
                Some((_, members)) => members.push(conversation),
                None => groups.push((conversation.project_id.clone(), vec![conversation])),
            }
        }
        let mut lines = vec![self.page_heading(self.pick("Sessions", "Session 列表"), page, pages)];
        let mut entries = Vec::new();
        for (project_id, members) in groups {
            lines.push(format!("[{}]", self.project_label(&project_id)));
            for conversation in members {
                entries.push(MenuEntry::Session {
                    conversation_id: conversation.id.clone(),
                });
                let marker = if bound.as_deref() == Some(conversation.id.as_str()) {
                    " ✓"
                } else {
                    ""
                };
                lines.push(format!(
                    "{}. {} · {}{marker}",
                    entries.len(),
                    bounded(&conversation.title, TITLE_LIMIT),
                    agent_label(conversation.agent_id)
                ));
            }
        }
        lines.push(self.page_footer("!s", page, pages, self.pick("to bind", "进行绑定")));
        Rendered {
            text: lines.join("\n"),
            menu: Some(entries),
        }
    }

    fn projects_menu(&self, page: usize) -> Rendered {
        let projects = self.workspace.list_projects().unwrap_or_default();
        if projects.is_empty() {
            return Rendered::text(self.pick(
                "No Projects are registered. Add one in Kubecode first.",
                "尚未注册项目，请先在 Kubecode 中添加。",
            ));
        }
        let (page, pages, slice) = paginate(&projects, page);
        let mut lines = vec![self.page_heading(
            self.pick("New Session — choose a Project", "新建 Session — 选择项目"),
            page,
            pages,
        )];
        let mut entries = Vec::new();
        for project in slice {
            entries.push(MenuEntry::Project {
                project_id: project.id.clone(),
            });
            lines.push(format!(
                "{}. {}",
                entries.len(),
                bounded(&project.name, TITLE_LIMIT)
            ));
        }
        lines.push(self.page_footer("!n", page, pages, self.pick("to choose", "进行选择")));
        Rendered {
            text: lines.join("\n"),
            menu: Some(entries),
        }
    }

    fn agents_menu(&self, project_id: &str) -> Rendered {
        let agents = self.supported_agents();
        if agents.is_empty() {
            return Rendered::text(self.pick(
                "No supported Agent is available on this Runtime.",
                "此 Runtime 上没有可用的受支持 Agent。",
            ));
        }
        let mut lines = vec![format!(
            "{} {}",
            self.pick("New Session in", "新建 Session，项目："),
            self.project_label(project_id)
        )];
        let mut entries = Vec::new();
        for agent_id in agents {
            entries.push(MenuEntry::Agent {
                project_id: project_id.to_owned(),
                agent_id,
            });
            lines.push(format!("{}. {}", entries.len(), agent_label(agent_id)));
        }
        lines.push(
            self.pick(
                "Reply with a number to choose the Agent.",
                "回复数字选择 Agent。",
            )
            .to_owned(),
        );
        Rendered {
            text: lines.join("\n"),
            menu: Some(entries),
        }
    }

    fn supported_agents(&self) -> Vec<AgentId> {
        [AgentId::ClaudeCode, AgentId::Codex, AgentId::OpenCode]
            .into_iter()
            .filter(|agent_id| self.runtime.agent_available(*agent_id))
            .collect()
    }

    fn options_menu(&self, account_id: &str) -> Rendered {
        let Some(conversation_id) = self.bound_conversation(account_id) else {
            return Rendered::text(self.status(account_id));
        };
        let choices = SessionOptions::load(&self.store, &conversation_id).choices(&conversation_id);
        if choices.is_empty() {
            return Rendered::text(self.pick(
                "This Session does not advertise model or mode options.",
                "此 Session 未提供模型或模式选项。",
            ));
        }
        let mut lines = Vec::new();
        let mut entries = Vec::new();
        let mut group = String::new();
        for choice in choices.into_iter().take(OPTION_MENU_LIMIT) {
            if choice.group != group {
                group = choice.group.clone();
                lines.push(format!("[{group}]"));
            }
            entries.push(choice.entry);
            lines.push(format!(
                "{}. {}{}",
                entries.len(),
                choice.label,
                if choice.current { " ✓" } else { "" }
            ));
        }
        lines.push(
            self.pick("Reply with a number to switch.", "回复数字进行切换。")
                .to_owned(),
        );
        Rendered {
            text: lines.join("\n"),
            menu: Some(entries),
        }
    }

    fn quick_prompts_menu(&self, account_id: &str) -> Rendered {
        let prompts = self
            .store
            .ilink_quick_prompts(account_id)
            .unwrap_or_default();
        if prompts.is_empty() {
            return Rendered::text(self.pick(
                "No quick prompts are configured. Add them in Kubecode Settings.",
                "尚未配置快捷指令，请在 Kubecode 设置中添加。",
            ));
        }
        let mut lines = vec![self.pick("Quick prompts", "快捷指令").to_owned()];
        let mut entries = Vec::new();
        for (slot, content) in prompts.iter().take(MENU_PAGE_SIZE) {
            entries.push(MenuEntry::QuickPrompt { slot: *slot });
            lines.push(format!(
                "{}. {}",
                entries.len(),
                bounded(content, PREVIEW_LIMIT)
            ));
        }
        lines.push(
            self.pick("Reply with a number to send it.", "回复数字发送。")
                .to_owned(),
        );
        Rendered {
            text: lines.join("\n"),
            menu: Some(entries),
        }
    }

    fn page_heading(&self, title: &str, page: usize, pages: usize) -> String {
        if pages > 1 {
            format!("{title} ({page}/{pages})")
        } else {
            title.to_owned()
        }
    }

    fn page_footer(&self, command: &str, page: usize, pages: usize, action: &str) -> String {
        let mut footer = format!("{} {action}.", self.pick("Reply with a number", "回复数字"));
        if page < pages {
            footer.push_str(&match self.language {
                ChannelLanguage::En => format!(" Send {command} {} for more.", page + 1),
                ChannelLanguage::ZhCn => format!(" 发送 {command} {} 查看更多。", page + 1),
            });
        }
        footer
    }

    // -- Selections --------------------------------------------------------------

    /// Applies one revalidated selection. Returns the reply (and possibly a
    /// follow-up menu); `None` when the router already replied.
    async fn select(
        &self,
        entry: MenuEntry,
        prompt: &BridgePrompt,
        responses: &dyn ResponseChannel,
    ) -> Option<Rendered> {
        let account_id = &prompt.account_id;
        let gone = || {
            Rendered::text(self.pick(
                "That choice is no longer available. Send the command again.",
                "该选项已不可用，请重新发送命令。",
            ))
        };
        Some(match entry {
            MenuEntry::Session { conversation_id } => {
                let Some(conversation) = self
                    .store
                    .get_conversation(&conversation_id)
                    .ok()
                    .filter(|conversation| self.bindable(conversation))
                else {
                    return Some(gone());
                };
                if self
                    .store
                    .bind_ilink_session(account_id, &conversation.id)
                    .is_err()
                {
                    return Some(gone());
                }
                self.router
                    .clear_peer_requests(account_id, &prompt.peer_id)
                    .await;
                Rendered::text(format!(
                    "{} {} · {}",
                    self.pick("Bound to", "已绑定："),
                    bounded(&conversation.title, TITLE_LIMIT),
                    self.project_label(&conversation.project_id)
                ))
            }
            MenuEntry::Project { project_id } => {
                if self.workspace.project(&project_id).is_err() {
                    return Some(gone());
                }
                self.agents_menu(&project_id)
            }
            MenuEntry::Agent {
                project_id,
                agent_id,
            } => {
                if self.workspace.project(&project_id).is_err()
                    || !self.supported_agents().contains(&agent_id)
                {
                    return Some(gone());
                }
                self.create_session(account_id, &prompt.peer_id, &project_id, agent_id)
                    .await
            }
            MenuEntry::Mode {
                conversation_id,
                mode_id,
            } => {
                let entry = MenuEntry::Mode {
                    conversation_id: conversation_id.clone(),
                    mode_id: mode_id.clone(),
                };
                if let Some(problem) = self.option_change_blocked(account_id, &entry) {
                    return Some(problem);
                }
                match self
                    .runtime
                    .set_session_mode(&conversation_id, mode_id)
                    .await
                {
                    Ok(()) => Rendered::text(self.pick("Mode updated.", "模式已更新。")),
                    Err(_) => self.option_failed(),
                }
            }
            MenuEntry::Config {
                conversation_id,
                config_id,
                value,
            } => {
                let entry = MenuEntry::Config {
                    conversation_id: conversation_id.clone(),
                    config_id: config_id.clone(),
                    value: value.clone(),
                };
                if let Some(problem) = self.option_change_blocked(account_id, &entry) {
                    return Some(problem);
                }
                match self
                    .runtime
                    .set_session_config(
                        &conversation_id,
                        config_id,
                        SessionConfigInput::ValueId(value),
                    )
                    .await
                {
                    Ok(()) => Rendered::text(self.pick("Option updated.", "选项已更新。")),
                    Err(_) => self.option_failed(),
                }
            }
            MenuEntry::QuickPrompt { slot } => {
                let content = self
                    .store
                    .ilink_quick_prompts(account_id)
                    .unwrap_or_default()
                    .into_iter()
                    .find(|(candidate, _)| *candidate == slot)
                    .map(|(_, content)| content);
                let Some(content) = content else {
                    return Some(gone());
                };
                // Normal admission: binding revalidation, start-or-queue,
                // and the router's own localized acknowledgement. The
                // selecting message's key makes the run idempotent and
                // routes the reply back to this peer.
                self.router
                    .route(
                        BridgePrompt {
                            account_id: account_id.clone(),
                            peer_id: prompt.peer_id.clone(),
                            message_key: prompt.message_key.clone(),
                            text: content,
                            images: Vec::new(),
                        },
                        responses,
                    )
                    .await;
                return None;
            }
        })
    }

    fn option_failed(&self) -> Rendered {
        Rendered::text(self.pick(
            "The Agent did not accept that change.",
            "Agent 未接受该更改。",
        ))
    }

    /// Model/mode changes apply only to the still-bound, idle, writable
    /// Session, and only to an option it still advertises.
    fn option_change_blocked(&self, account_id: &str, entry: &MenuEntry) -> Option<Rendered> {
        let conversation_id = match entry {
            MenuEntry::Mode {
                conversation_id, ..
            }
            | MenuEntry::Config {
                conversation_id, ..
            } => conversation_id,
            _ => return None,
        };
        let stale = || {
            Rendered::text(self.pick(
                "That choice is no longer available. Send the command again.",
                "该选项已不可用，请重新发送命令。",
            ))
        };
        if self.bound_conversation(account_id).as_deref() != Some(conversation_id.as_str()) {
            return Some(stale());
        }
        let Ok(conversation) = self.store.get_conversation(conversation_id) else {
            return Some(stale());
        };
        if !self.bindable(&conversation) {
            return Some(stale());
        }
        if matches!(
            conversation.latest_run_status,
            Some(RunStatus::Running | RunStatus::WaitingPermission)
        ) {
            return Some(Rendered::text(self.pick(
                "The Session is busy. Try again when it is idle.",
                "Session 正忙，请在空闲时重试。",
            )));
        }
        let advertised = SessionOptions::load(&self.store, conversation_id)
            .choices(conversation_id)
            .into_iter()
            .any(|choice| &choice.entry == entry);
        (!advertised).then(stale)
    }

    async fn create_session(
        &self,
        account_id: &str,
        peer_id: &str,
        project_id: &str,
        agent_id: AgentId,
    ) -> Rendered {
        let failed = || {
            Rendered::text(self.pick(
                "The Session could not be created. Try again from Kubecode.",
                "Session 创建失败，请在 Kubecode 中重试。",
            ))
        };
        // The store default is the normal safe permission profile; WeChat
        // never selects anything broader.
        let Ok(conversation) = self.store.create_conversation(project_id, agent_id, None) else {
            return failed();
        };
        if self
            .runtime
            .initialize_conversation(&conversation.id)
            .await
            .is_err()
        {
            let _ = self.store.delete_conversation(&conversation.id);
            return failed();
        }
        if self
            .store
            .bind_ilink_session(account_id, &conversation.id)
            .is_err()
        {
            return failed();
        }
        self.router.clear_peer_requests(account_id, peer_id).await;
        Rendered::text(format!(
            "{} {} · {}",
            self.pick("Created and bound a new Session:", "已新建并绑定 Session："),
            agent_label(agent_id),
            self.project_label(project_id)
        ))
    }
}

fn reply(responses: &dyn ResponseChannel, prompt: &BridgePrompt, text: impl Into<String>) {
    let _ = responses.send_reply(
        &prompt.account_id,
        &prompt.peer_id,
        &ChannelReply { text: text.into() },
    );
}

fn paginate<T>(items: &[T], page: usize) -> (usize, usize, &[T]) {
    let pages = items.len().div_ceil(MENU_PAGE_SIZE).max(1);
    let page = page.clamp(1, pages);
    let start = (page - 1) * MENU_PAGE_SIZE;
    let end = (start + MENU_PAGE_SIZE).min(items.len());
    (page, pages, &items[start..end])
}

fn agent_label(agent_id: AgentId) -> &'static str {
    match agent_id {
        AgentId::ClaudeCode => "Claude Code",
        AgentId::Codex => "Codex",
        AgentId::OpenCode => "OpenCode",
    }
}

fn bounded(text: &str, limit: usize) -> String {
    let single_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.chars().count() <= limit {
        return single_line;
    }
    let mut out: String = single_line.chars().take(limit.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The latest advertised mode and select options of a Session, parsed
/// from its session-state checkpoints exactly as the browser does.
#[derive(Default)]
struct SessionOptions {
    mode: Option<Value>,
    configs: Option<Value>,
    command_count: Option<usize>,
}

impl SessionOptions {
    fn load(store: &AgentStore, conversation_id: &str) -> Self {
        let mut options = Self::default();
        for event in store
            .session_events_after(conversation_id, 0)
            .unwrap_or_default()
        {
            match event.kind.as_str() {
                "current_mode" => match options.mode.as_mut().and_then(Value::as_object_mut) {
                    Some(current) if event.payload.get("currentModeId").is_some() => {
                        current.insert(
                            "currentModeId".into(),
                            event.payload["currentModeId"].clone(),
                        );
                    }
                    _ => options.mode = Some(event.payload),
                },
                "config_options" => options.configs = Some(event.payload),
                "session_loaded" | "session_created_state" => {
                    if let Some(modes) = event.payload.get("modes") {
                        options.mode = Some(modes.clone());
                    }
                    if let Some(configs) = event.payload.get("configOptions") {
                        options.configs = Some(serde_json::json!({ "configOptions": configs }));
                    }
                }
                "available_commands" => {
                    options.command_count = event
                        .payload
                        .get("availableCommands")
                        .and_then(Value::as_array)
                        .map(Vec::len);
                }
                _ => {}
            }
        }
        options
    }

    fn choices(&self, conversation_id: &str) -> Vec<AdvertisedChoice> {
        let mut choices = Vec::new();
        let advertised_mode = self.mode.as_ref().and_then(|mode| {
            let current = mode.get("currentModeId")?.as_str()?;
            let modes = mode.get("availableModes")?.as_array()?;
            Some((current.to_owned(), modes.clone()))
        });
        if let Some((current, modes)) = &advertised_mode {
            for mode in modes {
                let Some(id) = mode.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let name = mode.get("name").and_then(Value::as_str).unwrap_or(id);
                choices.push(AdvertisedChoice {
                    group: "Mode".to_owned(),
                    current: id == current,
                    label: bounded(name, TITLE_LIMIT),
                    entry: MenuEntry::Mode {
                        conversation_id: conversation_id.to_owned(),
                        mode_id: id.to_owned(),
                    },
                });
            }
        }
        let configs = self
            .configs
            .as_ref()
            .and_then(|configs| configs.get("configOptions"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for config in configs {
            if config.get("type").and_then(Value::as_str) != Some("select") {
                continue;
            }
            let (Some(id), Some(current)) = (
                config.get("id").and_then(Value::as_str),
                config.get("currentValue").and_then(Value::as_str),
            ) else {
                continue;
            };
            let is_mode = id.eq_ignore_ascii_case("mode")
                || config
                    .get("category")
                    .and_then(Value::as_str)
                    .is_some_and(|category| category.eq_ignore_ascii_case("mode"));
            if is_mode && advertised_mode.is_some() {
                continue;
            }
            let group = config.get("name").and_then(Value::as_str).unwrap_or(id);
            for option in config
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(value) = option
                    .get("value")
                    .or_else(|| option.get("id"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                let name = option.get("name").and_then(Value::as_str).unwrap_or(value);
                choices.push(AdvertisedChoice {
                    group: bounded(group, TITLE_LIMIT),
                    current: value == current,
                    label: bounded(name, TITLE_LIMIT),
                    entry: MenuEntry::Config {
                        conversation_id: conversation_id.to_owned(),
                        config_id: id.to_owned(),
                        value: value.to_owned(),
                    },
                });
            }
        }
        choices
    }

    /// `(group, current label)` pairs for the status reply.
    fn current_summary(&self) -> Vec<(String, String)> {
        let mut seen = Vec::<String>::new();
        let mut summary = Vec::new();
        for choice in self.choices("") {
            if choice.current && !seen.contains(&choice.group) {
                seen.push(choice.group.clone());
                summary.push((choice.group, choice.label));
            }
        }
        summary
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_parse_only_at_the_start_with_either_prefix() {
        assert_eq!(parse_command("!"), Some(Command::Status));
        assert_eq!(parse_command("  ！"), Some(Command::Status));
        assert_eq!(parse_command("!s"), Some(Command::Sessions { page: 1 }));
        assert_eq!(parse_command("！S 2"), Some(Command::Sessions { page: 2 }));
        assert_eq!(parse_command("!n 0"), Some(Command::NewSession { page: 1 }));
        assert_eq!(parse_command("!m"), Some(Command::Model));
        assert_eq!(parse_command("!q"), Some(Command::QuickPrompts));
        assert_eq!(parse_command("!help"), Some(Command::Unknown));
        assert_eq!(parse_command("hello !s"), None);
        assert_eq!(parse_command("s!"), None);
    }

    #[test]
    fn selections_are_short_digit_strings_and_timestamps_come_from_keys() {
        assert_eq!(selection_number(" 3 "), Some(3));
        assert_eq!(selection_number("1234"), None);
        assert_eq!(selection_number("3a"), None);
        assert_eq!(selection_number(""), None);
        assert_eq!(
            message_timestamp("wxid_peer@im.wechat:1750000000000:7"),
            Some(1_750_000_000_000)
        );
        assert_eq!(message_timestamp("garbage"), None);
    }

    #[test]
    fn pages_are_bounded_and_clamped() {
        let items: Vec<u32> = (0..20).collect();
        let (page, pages, slice) = paginate(&items, 1);
        assert_eq!((page, pages, slice.len()), (1, 3, MENU_PAGE_SIZE));
        let (page, _, slice) = paginate(&items, 99);
        assert_eq!((page, slice), (3, &items[18..]));
        let empty: Vec<u32> = Vec::new();
        assert_eq!(paginate(&empty, 1).2.len(), 0);
    }

    #[test]
    fn advertised_options_mirror_the_browser_projection() {
        let options = SessionOptions {
            mode: Some(serde_json::json!({
                "currentModeId": "build",
                "availableModes": [{"id": "build", "name": "Build"}, {"id": "plan", "name": "Plan"}]
            })),
            configs: Some(serde_json::json!({"configOptions": [
                {"id": "model", "name": "Model", "type": "select", "category": "model",
                 "currentValue": "sonnet",
                 "options": [{"value": "sonnet", "name": "Sonnet"}, {"value": "opus", "name": "Opus"}]},
                {"id": "mode", "name": "Mode", "type": "select", "category": "mode",
                 "currentValue": "build", "options": [{"value": "build", "name": "Build"}]},
                {"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": true}
            ]})),
            command_count: Some(3),
        };
        let choices = options.choices("c1");
        let labels: Vec<(&str, &str, bool)> = choices
            .iter()
            .map(|choice| (choice.group.as_str(), choice.label.as_str(), choice.current))
            .collect();
        assert_eq!(
            labels,
            vec![
                ("Mode", "Build", true),
                ("Mode", "Plan", false),
                ("Model", "Sonnet", true),
                ("Model", "Opus", false),
            ],
            "the duplicate mode config and boolean configs are skipped"
        );
        assert_eq!(
            options.current_summary(),
            vec![
                ("Mode".to_owned(), "Build".to_owned()),
                ("Model".to_owned(), "Sonnet".to_owned())
            ]
        );
    }
}
