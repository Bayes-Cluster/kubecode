//! WeChat control command tests (#133): status with either prefix and no
//! paths, interrupt-first semantics, Session switching with paging, stale
//! and expired menus, deleted targets, read-only/archived/sub-agent
//! exclusions, cross-peer isolation, Session creation (success and
//! failure), model/mode changes through the typed option API, quick
//! prompts through normal admission, and the quick-prompt settings API.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kubecode_server::agent_discovery::AgentDescriptor;
use kubecode_server::agent_runtime::AgentRuntime;
use kubecode_server::agent_store::{AgentStore, IlinkAccountStatus};
use kubecode_server::agents::{AgentId, RunStatus};
use kubecode_server::ilink::IlinkError;
use kubecode_server::ilink::commands::CommandCenter;
use kubecode_server::ilink::inbound::{
    BridgePrompt, ChannelLanguage, ChannelReply, ResponseChannel,
};
use kubecode_server::ilink::router::SessionRouter;
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;

const ACCOUNT: &str = "ilink_bot_synthetic_01";
const PEER: &str = "wxid_synthetic_owner";
const OTHER_PEER: &str = "wxid_synthetic_other";

#[derive(Default)]
struct Replies {
    sent: Mutex<Vec<(String, String)>>,
}

impl Replies {
    fn last(&self) -> String {
        self.sent
            .lock()
            .unwrap()
            .last()
            .map(|(_, text)| text.clone())
            .unwrap_or_default()
    }

    fn count(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
}

impl ResponseChannel for Replies {
    fn send_reply(
        &self,
        _account_id: &str,
        peer_id: &str,
        reply: &ChannelReply,
    ) -> Result<(), IlinkError> {
        self.sent
            .lock()
            .unwrap()
            .push((peer_id.to_owned(), reply.text.clone()));
        Ok(())
    }
}

struct Environment {
    _root: TempDir,
    workspace: Arc<WorkspaceService>,
    store: Arc<AgentStore>,
    runtime: Arc<AgentRuntime>,
    router: Arc<SessionRouter>,
    commands: Arc<CommandCenter>,
    replies: Arc<Replies>,
    project_id: String,
    project_path: String,
    conversation_id: String,
    clock: Mutex<i64>,
}

const AGENT: &str = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{},\"authMethods\":[]}}"
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"sessionId\":\"cmd-session\",\"modes\":{\"currentModeId\":\"build\",\"availableModes\":[{\"id\":\"build\",\"name\":\"Build\"},{\"id\":\"plan\",\"name\":\"Plan\"}]}}}"
      ;;
    *'"method":"session/set_mode"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{}}"
      ;;
    *'"method":"session/prompt"'*)
      prompt_id=$id
      ;;
    *'"method":"session/cancel"'*)
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$prompt_id,\"result\":{\"stopReason\":\"cancelled\"}}"
      ;;
  esac
done"#;

fn executable(directory: &TempDir, name: &str, body: &str) -> String {
    let path = directory.path().join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write mock");
    let mut permissions = fs::metadata(&path).expect("metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).expect("permissions");
    path.to_string_lossy().into_owned()
}

async fn environment(tag: &str, ttl: Duration) -> Environment {
    let root = TempDir::new().expect("tempdir");
    let database = root
        .path()
        .join(format!(".state-{tag}/kubecode/kubecode.sqlite3"));
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
    let project = workspace
        .create_project(".", format!("commands-{tag}").as_str())
        .expect("project");
    let store = Arc::new(AgentStore::open(&database).expect("store"));
    let runtime = Arc::new(AgentRuntime::new(
        Arc::clone(&workspace),
        Arc::clone(&store),
        vec![
            AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: executable(&root, "opencode-mock", AGENT),
                error: None,
            },
            // Codex is "available" but its adapter exits immediately, so
            // Session creation with it fails.
            AgentDescriptor {
                id: AgentId::Codex,
                available: true,
                version: Some("test".into()),
                executable: executable(&root, "codex-mock", "exit 1"),
                error: None,
            },
        ],
    ));
    store
        .upsert_ilink_account(ACCOUNT, "Test Account")
        .expect("account");
    store
        .set_ilink_account_status(ACCOUNT, IlinkAccountStatus::Connected)
        .expect("status");
    store
        .upsert_ilink_peer(ACCOUNT, PEER, "Owner", true)
        .expect("peer");
    let conversation = store
        .create_conversation(&project.id, AgentId::OpenCode, Some("Bound Session"))
        .expect("conversation");
    store
        .bind_ilink_session(ACCOUNT, &conversation.id)
        .expect("bind");
    let router = SessionRouter::new(
        Arc::clone(&runtime),
        Arc::clone(&store),
        ChannelLanguage::En,
    );
    let commands = CommandCenter::with_ttl(
        Arc::clone(&runtime),
        Arc::clone(&router),
        ChannelLanguage::En,
        ttl,
    );
    Environment {
        _root: root,
        workspace,
        store,
        runtime,
        router,
        commands,
        replies: Arc::new(Replies::default()),
        project_id: project.id,
        project_path: project.path,
        conversation_id: conversation.id,
        clock: Mutex::new(1_750_000_000_000),
    }
}

impl Environment {
    /// Sends one message from `peer` with a strictly increasing timestamp.
    async fn send_as(&self, peer: &str, text: &str) -> bool {
        let timestamp = {
            let mut clock = self.clock.lock().unwrap();
            *clock += 1_000;
            *clock
        };
        self.send_at(peer, text, timestamp).await
    }

    async fn send_at(&self, peer: &str, text: &str, timestamp: i64) -> bool {
        let prompt = BridgePrompt {
            account_id: ACCOUNT.to_owned(),
            peer_id: peer.to_owned(),
            message_key: format!("{peer}:{timestamp}:1"),
            text: text.to_owned(),
            images: Vec::new(),
        };
        self.commands.handle(&prompt, &*self.replies).await
    }

    async fn send(&self, text: &str) -> bool {
        self.send_as(PEER, text).await
    }

    fn binding(&self) -> Option<String> {
        self.store.ilink_session_binding(ACCOUNT).expect("binding")
    }

    fn create(&self, title: &str) -> String {
        self.store
            .create_conversation(&self.project_id, AgentId::OpenCode, Some(title))
            .expect("conversation")
            .id
    }
}

async fn wait_for_status(env: &Environment, status: RunStatus) {
    for _ in 0..400 {
        if env
            .store
            .list_runs(&env.conversation_id)
            .expect("runs")
            .iter()
            .any(|run| run.status == status)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("run never reached {status:?}");
}

#[tokio::test]
async fn status_answers_both_prefixes_without_paths_and_mid_text_is_a_prompt() {
    let env = environment("status", Duration::from_secs(60)).await;
    assert!(env.send("!").await);
    let status = env.replies.last();
    assert!(status.contains("Session: Bound Session"), "{status}");
    assert!(status.contains("Project: commands-status"));
    assert!(status.contains("Agent: OpenCode"));
    assert!(status.contains("State: idle"));
    assert!(!status.contains(&env.project_path), "no absolute paths");
    assert!(!status.contains("Interrupted"), "nothing to interrupt");
    assert!(env.send("！").await, "full-width prefix");
    assert_eq!(env.replies.last(), status);
    // Unknown commands answer with help plus status.
    assert!(env.send("!wat").await);
    assert!(env.replies.last().starts_with("Commands:"));
    assert!(env.replies.last().contains("Session: Bound Session"));
    // A `!` that is not at the start is not a command.
    let before = env.replies.count();
    assert!(!env.send("please run !s").await);
    assert_eq!(env.replies.count(), before);
}

#[tokio::test]
async fn every_command_interrupts_the_active_run_first() {
    let env = environment("interrupt", Duration::from_secs(60)).await;
    env.router
        .route(
            BridgePrompt {
                account_id: ACCOUNT.to_owned(),
                peer_id: PEER.to_owned(),
                message_key: format!("{PEER}:1:1"),
                text: "long job".to_owned(),
                images: Vec::new(),
            },
            &*env.replies,
        )
        .await;
    wait_for_status(&env, RunStatus::Running).await;
    assert!(env.send("!").await);
    assert!(
        env.replies
            .last()
            .starts_with("Interrupted the running task.")
    );
    wait_for_status(&env, RunStatus::Cancelled).await;
    // Repeating the command races with nothing: no second interrupt.
    assert!(env.send("!").await);
    assert!(!env.replies.last().contains("Interrupted"));
}

#[tokio::test]
async fn sessions_menu_pages_excludes_unbindable_and_binds_after_revalidation() {
    let env = environment("switch", Duration::from_secs(60)).await;
    let target = env.create("Target Session");
    let archived = env.create("Archived Session");
    env.store.set_archived(&archived, true).expect("archive");
    // Read-only sub-agent conversations are never offered.
    env.store
        .ensure_subagent_conversation(&env.conversation_id, "sub-1", "Helper Agent", "assist")
        .expect("subagent");
    for index in 0..10 {
        env.create(&format!("Filler {index}"));
    }
    assert!(env.send("!s").await);
    let page_one = env.replies.last();
    assert!(page_one.starts_with("Sessions (1/2)"), "{page_one}");
    assert!(page_one.contains("[commands-switch]"));
    assert!(page_one.contains("!s 2"), "page hint");
    assert!(!page_one.contains("Archived Session"));
    assert!(!page_one.contains("Helper Agent") && !page_two_contains_helper(&env).await);
    assert!(!page_one.contains(&env.project_path));
    assert!(env.send("!s 2").await);
    let page_two = env.replies.last();
    assert!(page_two.starts_with("Sessions (2/2)"));

    // Find the target's number on whichever page lists it.
    let (page, listing) = if page_one.contains("Target Session") {
        ("!s", page_one)
    } else {
        ("!s 2", page_two)
    };
    let number = listing
        .lines()
        .find(|line| line.contains("Target Session"))
        .and_then(|line| line.split('.').next())
        .expect("numbered line")
        .to_owned();
    assert!(env.send(page).await);
    // Another peer's digits never act on this peer's menu.
    assert!(!env.send_as(OTHER_PEER, &number).await);
    assert_ne!(env.binding().as_deref(), Some(target.as_str()));
    // An out-of-range number keeps the menu open.
    assert!(env.send("99").await);
    assert!(
        env.replies
            .last()
            .starts_with("Reply with a number from 1 to")
    );
    assert!(env.send(&number).await);
    assert!(env.replies.last().starts_with("Bound to Target Session"));
    assert_eq!(env.binding().as_deref(), Some(target.as_str()));
    // The menu was one-shot: the same digits are no longer a selection.
    assert!(!env.send(&number).await);
}

async fn page_two_contains_helper(env: &Environment) -> bool {
    env.send("!s 2").await;
    let page = env.replies.last();
    env.send("!s").await;
    page.contains("Helper Agent")
}

#[tokio::test]
async fn stale_expired_and_deleted_selections_fail_closed() {
    let env = environment("stale", Duration::from_millis(150)).await;
    let target = env.create("Doomed Session");
    // Expired menu.
    assert!(env.send("!s").await);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(env.send("1").await);
    assert!(env.replies.last().contains("no longer current"));

    // A reply sent before the menu opened is stale (generation fence).
    let env = environment("fence", Duration::from_secs(60)).await;
    assert!(env.send_at(PEER, "!s", 1_800_000_000_000).await);
    assert!(env.send_at(PEER, "1", 1_799_999_999_000).await);
    assert!(env.replies.last().contains("no longer current"));

    // A Session deleted between listing and selection is not bound.
    let env = environment("deleted", Duration::from_secs(60)).await;
    let doomed = env.create("Doomed Session");
    let original = env.binding();
    assert!(env.send("!s").await);
    let number = env
        .replies
        .last()
        .lines()
        .find(|line| line.contains("Doomed Session"))
        .and_then(|line| line.split('.').next())
        .expect("listed")
        .to_owned();
    env.store.delete_conversation(&doomed).expect("delete");
    assert!(env.send(&number).await);
    assert!(env.replies.last().contains("no longer available"));
    assert_eq!(env.binding(), original);
    let _ = target;
}

#[tokio::test]
async fn new_session_creates_with_a_supported_agent_and_binds_or_fails_cleanly() {
    let env = environment("create", Duration::from_secs(60)).await;
    let before = env
        .store
        .list_conversations(&env.project_id)
        .expect("list")
        .len();
    assert!(env.send("!n").await);
    assert!(env.replies.last().contains("1. commands-create"));
    assert!(env.send("1").await);
    let agents = env.replies.last();
    assert!(agents.contains("Codex") && agents.contains("OpenCode"));
    assert!(
        !agents.contains("Claude Code"),
        "unavailable Agents are not offered"
    );
    let opencode = agents
        .lines()
        .find(|line| line.contains("OpenCode"))
        .and_then(|line| line.split('.').next())
        .expect("opencode")
        .to_owned();
    let codex = agents
        .lines()
        .find(|line| line.contains("Codex"))
        .and_then(|line| line.split('.').next())
        .expect("codex")
        .to_owned();
    assert!(env.send(&opencode).await);
    assert!(
        env.replies
            .last()
            .starts_with("Created and bound a new Session: OpenCode"),
        "{}",
        env.replies.last()
    );
    let conversations = env.store.list_conversations(&env.project_id).expect("list");
    assert_eq!(conversations.len(), before + 1);
    let created = env.binding().expect("bound");
    assert_ne!(created, env.conversation_id);

    // A failing Agent leaves no Session behind and keeps the binding.
    assert!(env.send("!n").await);
    assert!(env.send("1").await);
    assert!(env.send(&codex).await);
    assert!(env.replies.last().contains("could not be created"));
    assert_eq!(
        env.store
            .list_conversations(&env.project_id)
            .expect("list")
            .len(),
        before + 1
    );
    assert_eq!(env.binding().as_deref(), Some(created.as_str()));
}

#[tokio::test]
async fn model_menu_changes_only_advertised_options_of_an_idle_session() {
    let env = environment("model", Duration::from_secs(60)).await;
    // Nothing advertised yet.
    assert!(env.send("!m").await);
    assert!(env.replies.last().contains("does not advertise"));
    env.runtime
        .initialize_conversation(&env.conversation_id)
        .await
        .expect("initialize");
    assert!(env.send("!m").await);
    let menu = env.replies.last();
    assert!(menu.contains("[Mode]"), "{menu}");
    assert!(menu.contains("1. Build ✓"));
    assert!(menu.contains("2. Plan"));
    assert!(env.send("2").await);
    assert_eq!(env.replies.last(), "Mode updated.");
    let current = env
        .store
        .session_events_after(&env.conversation_id, 0)
        .expect("events")
        .into_iter()
        .rev()
        .find(|event| event.kind == "current_mode")
        .expect("mode checkpoint");
    assert_eq!(current.payload["currentModeId"], "plan");
    assert!(env.send("!").await);
    assert!(env.replies.last().contains("Mode: Plan"));

    // A busy Session refuses the change.
    assert!(env.send("!m").await);
    env.router
        .route(
            BridgePrompt {
                account_id: ACCOUNT.to_owned(),
                peer_id: PEER.to_owned(),
                message_key: format!("{PEER}:2:1"),
                text: "work".to_owned(),
                images: Vec::new(),
            },
            &*env.replies,
        )
        .await;
    wait_for_status(&env, RunStatus::Running).await;
    // The prompt above closed the menu; reopen it while the run is active.
    let reopened = BridgePrompt {
        account_id: ACCOUNT.to_owned(),
        peer_id: PEER.to_owned(),
        message_key: format!("{PEER}:1760000000000:1"),
        text: "!m".to_owned(),
        images: Vec::new(),
    };
    assert!(env.commands.handle(&reopened, &*env.replies).await);
    // The command interrupted the run; a fresh run makes it busy again.
    wait_for_status(&env, RunStatus::Cancelled).await;
    env.router
        .route(
            BridgePrompt {
                account_id: ACCOUNT.to_owned(),
                peer_id: PEER.to_owned(),
                message_key: format!("{PEER}:3:1"),
                text: "more work".to_owned(),
                images: Vec::new(),
            },
            &Replies::default(),
        )
        .await;
    for _ in 0..400 {
        let running = env
            .store
            .get_conversation(&env.conversation_id)
            .expect("conversation")
            .latest_run_status
            == Some(RunStatus::Running);
        if running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let selection = BridgePrompt {
        message_key: format!("{PEER}:1760000001000:1"),
        text: "1".to_owned(),
        ..reopened
    };
    assert!(env.commands.handle(&selection, &*env.replies).await);
    assert!(
        env.replies.last().contains("busy"),
        "{}",
        env.replies.last()
    );
}

#[tokio::test]
async fn quick_prompts_list_and_admit_through_normal_run_admission() {
    let env = environment("quick", Duration::from_secs(60)).await;
    assert!(env.send("!q").await);
    assert!(env.replies.last().contains("No quick prompts"));
    env.store
        .set_ilink_quick_prompt(ACCOUNT, 2, "Run the test suite and summarize failures")
        .expect("quick prompt");
    assert!(env.send("!q").await);
    let menu = env.replies.last();
    let entry = menu
        .lines()
        .find(|line| line.starts_with("1. "))
        .expect("entry");
    assert!(entry.starts_with("1. Run the test suite"), "{menu}");
    assert!(entry.ends_with('…'), "previews are bounded");
    assert!(entry.chars().count() <= 3 + 40);
    assert!(env.send("1").await);
    assert_eq!(env.replies.last(), "Sent to the Session.");
    let run = env
        .store
        .list_runs(&env.conversation_id)
        .expect("runs")
        .pop()
        .expect("run");
    assert_eq!(run.message, "Run the test suite and summarize failures");
    let client_message_id = run.client_message_id.expect("channel id");
    assert!(client_message_id.starts_with(&format!("ilink:{ACCOUNT}:{PEER}:")));
    // A removed prompt is a stale target.
    assert!(env.send("!q").await);
    env.store
        .remove_ilink_quick_prompt(ACCOUNT, 2)
        .expect("remove");
    assert!(env.send("1").await);
    assert!(env.replies.last().contains("no longer available"));
    let _ = &env.workspace;
}

#[tokio::test]
async fn a_pending_permission_outranks_an_open_menu() {
    let env = environment("precedence", Duration::from_secs(60)).await;
    let other = env.create("Other Session");
    assert!(env.send("!s").await, "menu opens");
    // A permission request arrives for this peer while the menu is open.
    env.router
        .register_interaction(
            ACCOUNT,
            PEER,
            "req-1",
            kubecode_server::ilink::outbound::InteractionKind::Permission,
            vec!["allow_once".to_owned(), "reject".to_owned()],
        )
        .await;
    let before = env.binding();
    // The digit is not consumed by the menu: the router gets it.
    assert!(!env.send("1").await);
    assert_eq!(env.binding(), before, "no Session was bound by the digit");
    assert!(
        env.router.has_pending_interaction(ACCOUNT, PEER).await,
        "the permission request is still answerable"
    );
    // The stale menu closed.
    env.router.clear_peer_requests(ACCOUNT, PEER).await;
    assert!(!env.send("1").await, "no menu remains");
    let _ = other;
}

#[tokio::test]
async fn long_option_lists_page_instead_of_truncating() {
    let env = environment("options-paging", Duration::from_secs(60)).await;
    let options: Vec<serde_json::Value> = (0..23)
        .map(|index| serde_json::json!({"value": format!("model-{index}"), "name": format!("Model {index}")}))
        .collect();
    env.store
        .append_session_event(
            &env.conversation_id,
            "config_options",
            &serde_json::json!({"configOptions": [{
                "id": "model", "name": "Model", "type": "select", "category": "model",
                "currentValue": "model-0", "options": options,
            }]}),
        )
        .expect("options");
    assert!(env.send("!m").await);
    let first = env.replies.last();
    assert!(first.starts_with("Options (1/3)"), "{first}");
    assert!(first.contains("!m 2"));
    assert!(env.send("!m 3").await);
    let last = env.replies.last();
    assert!(last.contains("Model 22"), "{last}");
    assert!(!last.contains("!m 4"));
}
