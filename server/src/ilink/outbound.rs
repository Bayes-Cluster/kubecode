//! Outbound WeChat bridge (issue #131, ADR 0211 §8): projects the
//! authoritative workspace event stream of the bound Session into ordered
//! WeChat text replies, typing state, interactive menus, and typed
//! terminal notices. Nothing here is a second transcript — buffers are
//! bounded, transient, per-run state dropped on completion, cancellation,
//! binding change, logout, Session removal, peer-context expiry, or
//! Runtime shutdown.
//!
//! The pure halves ([`MarkdownFilter`], [`split_text`], [`ReplyProjector`])
//! are deterministic and network-free. [`OutboundBridge`] drives them from
//! the workspace event bus and executes the resulting actions one at a
//! time through an [`OutboundTransport`], so chunks reach the peer in
//! event order. Replayed events (cursor ≤ last observed) and repeated
//! terminal events never produce a second send: every chunk carries a
//! stable `kubecode-{run}-{n}` client id and the bridge remembers the ids
//! it already delivered.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::agent_store::{AgentStore, WorkspaceEvent};
use crate::workspace::SharedMediaFile;

use super::error::IlinkError;
use super::inbound::{ChannelLanguage, ChannelReply, ResponseChannel};
use super::router::SessionRouter;

/// WeChat's practical text limit per message, in characters.
pub const WECHAT_TEXT_LIMIT: usize = 2_000;
/// Total characters one run may send before further output is truncated
/// (the browser keeps the full reply).
pub const RUN_OUTPUT_LIMIT: usize = 16_000;
/// Concurrently tracked WeChat-originated runs.
pub const MAX_TRACKED_RUNS: usize = 8;
/// Bounded queue of localized acknowledgements waiting for delivery.
pub const REPLY_QUEUE_CAPACITY: usize = 256;
/// Typing refresh cadence while a WeChat-originated run is active.
pub const TYPING_KEEPALIVE: Duration = Duration::from_secs(5);
/// Typing never outlives this, even for very long runs.
pub const TYPING_MAX: Duration = Duration::from_secs(15 * 60);

/// Characters kept free in every chunk so a split inside a code fence
/// can close and reopen the fence without exceeding the limit.
const FENCE_RESERVE: usize = 32;
/// Longest fence info string carried into a reopened fence.
const FENCE_INFO_LIMIT: usize = 16;
/// Recently finished/ignored run ids remembered for replay suppression.
const RUN_MEMORY: usize = 128;
/// Delivered client ids remembered by the bridge.
const SENT_MEMORY: usize = 512;
/// Bounds for provider-supplied strings rendered into menus.
const MENU_TITLE_LIMIT: usize = 120;
const MENU_LABEL_LIMIT: usize = 60;
const MENU_OPTION_LIMIT: usize = 9;

// -- Markdown filter -----------------------------------------------------------

/// A streaming Markdown → WeChat plain-text filter. WeChat renders no
/// Markdown, so headings, emphasis markers, links, and table rules are
/// simplified while code fences pass through untouched. The fence state
/// survives across calls, so a flush that ends inside a code block does
/// not mangle the rest of the block on the next flush.
#[derive(Clone, Debug, Default)]
pub struct MarkdownFilter {
    fence: Option<String>,
}

impl MarkdownFilter {
    pub fn in_fence(&self) -> bool {
        self.fence.is_some()
    }

    pub fn filter(&mut self, text: &str) -> String {
        let mut lines: Vec<String> = Vec::new();
        for line in text.split('\n') {
            let trimmed = line.trim_start();
            if let Some(marker) = &self.fence {
                if closes_fence(trimmed, marker) {
                    self.fence = None;
                }
                lines.push(line.to_owned());
                continue;
            }
            if let Some(marker) = fence_marker(trimmed) {
                self.fence = Some(marker.to_owned());
                lines.push(line.to_owned());
                continue;
            }
            if let Some(rendered) = render_line(line) {
                lines.push(rendered);
            }
        }
        // Collapse runs of blank lines to a single paragraph break.
        let mut collapsed: Vec<String> = Vec::with_capacity(lines.len());
        let mut blanks = 0usize;
        for line in lines {
            if line.trim().is_empty() {
                blanks += 1;
                if blanks > 2 {
                    continue;
                }
            } else {
                blanks = 0;
            }
            collapsed.push(line);
        }
        collapsed.join("\n")
    }
}

/// The run of backticks or tildes opening a fence, if `line` opens one.
fn fence_marker(line: &str) -> Option<&str> {
    let first = line.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let count = line.chars().take_while(|c| *c == first).count();
    (count >= 3).then(|| &line[..count])
}

fn closes_fence(line: &str, marker: &str) -> bool {
    line.starts_with(marker)
        && line[marker.len()..]
            .trim_matches(marker.as_bytes()[0] as char)
            .trim()
            .is_empty()
}

fn render_line(line: &str) -> Option<String> {
    let body = line.trim_start();
    let indent = &line[..line.len() - body.len()];
    if body.is_empty() {
        return Some(String::new());
    }
    // ATX headings lose their markers.
    let hashes = body.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && body[hashes..].starts_with(' ') {
        let content = body[hashes..].trim().trim_end_matches('#').trim_end();
        return Some(render_inline(content));
    }
    // Thematic breaks become a plain rule.
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.len() >= 3
        && (compact.chars().all(|c| c == '-')
            || compact.chars().all(|c| c == '*')
            || compact.chars().all(|c| c == '_'))
    {
        return Some("──────".to_owned());
    }
    // Table delimiter rows carry no content.
    if body.starts_with('|')
        && body.contains('-')
        && body.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
    {
        return None;
    }
    // Bullets (and task items) become typographic bullets.
    for bullet in ["- ", "* ", "+ "] {
        if let Some(rest) = body.strip_prefix(bullet) {
            if let Some(rest) = rest.strip_prefix("[ ] ") {
                return Some(format!("{indent}☐ {}", render_inline(rest)));
            }
            if let Some(rest) = rest
                .strip_prefix("[x] ")
                .or_else(|| rest.strip_prefix("[X] "))
            {
                return Some(format!("{indent}☑ {}", render_inline(rest)));
            }
            return Some(format!("{indent}• {}", render_inline(rest)));
        }
    }
    Some(format!("{indent}{}", render_inline(body)))
}

/// Inline simplification: strong markers drop, links show their target,
/// images show their alt text, and code spans stay verbatim.
fn render_inline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(ch) = rest.chars().next() {
        if ch == '`' {
            let ticks = rest.chars().take_while(|c| *c == '`').count();
            let marker = &rest[..ticks];
            match rest[ticks..].find(marker) {
                Some(end) => {
                    let stop = ticks + end + ticks;
                    out.push_str(&rest[..stop]);
                    rest = &rest[stop..];
                }
                None => {
                    out.push_str(rest);
                    rest = "";
                }
            }
            continue;
        }
        if let Some(stripped) = rest.strip_prefix("**") {
            rest = stripped;
            continue;
        }
        if let Some((rendered, consumed)) = link_at(rest) {
            out.push_str(&rendered);
            rest = &rest[consumed..];
            continue;
        }
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    out
}

fn link_at(text: &str) -> Option<(String, usize)> {
    let (image, start) = if text.starts_with("![") {
        (true, 2)
    } else if text.starts_with('[') {
        (false, 1)
    } else {
        return None;
    };
    let close = text[start..].find("](")? + start;
    let label = &text[start..close];
    if label.contains(['[', ']', '\n']) {
        return None;
    }
    let url_start = close + 2;
    let url_end = text[url_start..].find(')')? + url_start;
    let url = text[url_start..url_end].trim();
    if url.is_empty() || url.contains(char::is_whitespace) {
        return None;
    }
    let label = render_inline(label);
    let rendered = if image {
        label
    } else if label.is_empty() || label == url {
        url.to_owned()
    } else {
        format!("{label} ({url})")
    };
    Some((rendered, url_end + 1))
}

// -- Splitting -------------------------------------------------------------------

/// Splits `text` into chunks of at most `limit` characters, preferring
/// paragraph, newline, sentence (CJK and ASCII), clause, then space
/// boundaries; a chunk that ends inside a code fence closes it and the
/// next chunk reopens it. Ordering is preserved.
pub fn split_text(text: &str, limit: usize) -> Vec<String> {
    split_text_from(text, limit, None).0
}

/// [`split_text`] continuing from an already-open fence (the opening
/// fence line), returning the fence still open after the last chunk.
pub fn split_text_from(
    text: &str,
    limit: usize,
    open_fence: Option<String>,
) -> (Vec<String>, Option<String>) {
    let limit = limit.max(1);
    let budget = if limit > FENCE_RESERVE * 2 {
        limit - FENCE_RESERVE
    } else {
        limit
    };
    let mut pieces: Vec<String> = Vec::new();
    let mut rest = text.trim_matches('\n');
    while rest.chars().count() > budget {
        let window_end = rest
            .char_indices()
            .nth(budget)
            .map_or(rest.len(), |(index, _)| index);
        let window = &rest[..window_end];
        let (head_end, tail_start) = best_cut(window);
        let head = rest[..head_end].trim_end();
        if !head.is_empty() {
            pieces.push(head.to_owned());
        }
        rest = rest[tail_start..].trim_start_matches('\n');
    }
    if !rest.trim().is_empty() {
        pieces.push(rest.trim_end().to_owned());
    }
    let (chunks, open) = balance_fences(pieces, open_fence);
    // Pathological fence markers could still overflow: hard-cut as a
    // last resort so no chunk ever exceeds the channel limit.
    let mut bounded = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        if chunk.chars().count() <= limit {
            bounded.push(chunk);
            continue;
        }
        let chars: Vec<char> = chunk.chars().collect();
        for part in chars.chunks(limit) {
            bounded.push(part.iter().collect());
        }
    }
    (bounded, open)
}

/// Picks `(head_end, tail_start)` byte offsets inside `window`.
fn best_cut(window: &str) -> (usize, usize) {
    let floor = window.len() / 4;
    if let Some(index) = window.rfind("\n\n").filter(|index| *index >= floor) {
        return (index, index);
    }
    if let Some(index) = window.rfind('\n').filter(|index| *index >= floor) {
        return (index, index);
    }
    let sentence = |c: char| matches!(c, '。' | '！' | '？' | '；' | '…');
    let clause = |c: char| matches!(c, '，' | '、' | '：');
    let mut last_sentence = None;
    let mut last_clause = None;
    let mut last_space = None;
    let mut previous: Option<(usize, char)> = None;
    for (index, ch) in window.char_indices() {
        if sentence(ch) {
            last_sentence = Some(index + ch.len_utf8());
        } else if clause(ch) {
            last_clause = Some(index + ch.len_utf8());
        } else if ch == ' ' {
            if let Some((_, before)) = previous
                && matches!(before, '.' | '!' | '?' | ';')
            {
                last_sentence = Some(index);
            }
            last_space = Some(index);
        }
        previous = Some((index, ch));
    }
    if let Some(index) = last_sentence.filter(|index| *index >= floor) {
        return (index, skip_space(window, index));
    }
    if let Some(index) = last_clause.filter(|index| *index >= floor) {
        return (index, index);
    }
    if let Some(index) = last_space.filter(|index| *index >= floor) {
        return (index, index + 1);
    }
    (window.len(), window.len())
}

fn skip_space(window: &str, index: usize) -> usize {
    if window[index..].starts_with(' ') {
        index + 1
    } else {
        index
    }
}

fn balance_fences(pieces: Vec<String>, mut open: Option<String>) -> (Vec<String>, Option<String>) {
    let mut chunks = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let mut chunk = String::with_capacity(piece.len() + FENCE_RESERVE);
        if let Some(fence_line) = &open {
            chunk.push_str(fence_line);
            chunk.push('\n');
        }
        chunk.push_str(&piece);
        for line in piece.split('\n') {
            let trimmed = line.trim_start();
            match &open {
                Some(fence_line) => {
                    let marker = fence_marker(fence_line).unwrap_or("```");
                    if closes_fence(trimmed, marker) {
                        open = None;
                    }
                }
                None => {
                    if let Some(marker) = fence_marker(trimmed) {
                        let info: String = trimmed[marker.len()..]
                            .trim()
                            .chars()
                            .take(FENCE_INFO_LIMIT)
                            .collect();
                        open = Some(format!("{marker}{info}"));
                    }
                }
            }
        }
        if let Some(fence_line) = &open {
            chunk.push('\n');
            chunk.push_str(fence_marker(fence_line).unwrap_or("```"));
        }
        chunks.push(chunk);
    }
    (chunks, open)
}

// -- Projection ----------------------------------------------------------------

/// Kind of interactive request surfaced to the peer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InteractionKind {
    Permission,
    Elicitation,
}

/// One outbound effect, executed in order by the bridge.
#[derive(Clone, PartialEq, Eq)]
pub enum OutboundAction {
    Text {
        peer_id: String,
        text: String,
        client_id: String,
    },
    Typing {
        peer_id: String,
        typing: bool,
    },
    /// Registers a pending request with the router *before* its menu is
    /// sent, so an immediate numeric reply resolves.
    Interaction {
        peer_id: String,
        request_id: String,
        kind: InteractionKind,
        option_ids: Vec<String>,
    },
    /// Drops the peer's pending interactive state.
    ClearInteractions {
        peer_id: String,
    },
    /// Delivers one Agent-shared file, resolved by opaque id (#132).
    Media {
        peer_id: String,
        conversation_id: String,
        media_id: String,
        client_id: String,
    },
}

/// Content-free rendering: never prints reply text or peer ids.
impl std::fmt::Debug for OutboundAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Text {
                text, client_id, ..
            } => write!(
                formatter,
                "Text({client_id}, {} chars)",
                text.chars().count()
            ),
            Self::Typing { typing, .. } => write!(formatter, "Typing({typing})"),
            Self::Interaction {
                kind, option_ids, ..
            } => write!(
                formatter,
                "Interaction({kind:?}, {} options)",
                option_ids.len()
            ),
            Self::ClearInteractions { .. } => write!(formatter, "ClearInteractions"),
            Self::Media { client_id, .. } => write!(formatter, "Media({client_id})"),
        }
    }
}

/// Parses the originating peer out of a channel `client_message_id`
/// (`ilink:{account}:{sender}:{timestamp}:{sequence}`, issue #130).
/// Returns `(account_id, peer_id)`.
pub fn parse_channel_client_id(client_message_id: &str) -> Option<(String, String)> {
    let mut parts = client_message_id.rsplitn(4, ':');
    let _sequence = parts.next()?;
    let _timestamp = parts.next()?;
    let peer = parts.next()?.trim();
    let account = parts.next()?.strip_prefix("ilink:")?;
    if peer.is_empty() || account.is_empty() {
        return None;
    }
    Some((account.to_owned(), peer.to_owned()))
}

struct RunReply {
    peer_id: String,
    conversation_id: String,
    buffer: String,
    filter: MarkdownFilter,
    fence: Option<String>,
    next_chunk: u32,
    next_media: u32,
    sent_chars: usize,
    sent_text: bool,
    truncated: bool,
    typing: bool,
    started: Instant,
}

/// The pure event → action state machine for one linked account.
pub struct ReplyProjector {
    language: ChannelLanguage,
    limit: usize,
    output_limit: usize,
    bound_conversation: Option<String>,
    runs: HashMap<String, RunReply>,
    /// Run ids that finished or were classified as not ours.
    settled_runs: VecDeque<String>,
    settled_set: HashSet<String>,
    seen_requests: VecDeque<String>,
    last_event_id: u64,
    pub truncations: u64,
}

impl ReplyProjector {
    pub fn new(language: ChannelLanguage, bound_conversation: Option<String>) -> Self {
        Self {
            language,
            limit: WECHAT_TEXT_LIMIT,
            output_limit: RUN_OUTPUT_LIMIT,
            bound_conversation,
            runs: HashMap::new(),
            settled_runs: VecDeque::new(),
            settled_set: HashSet::new(),
            seen_requests: VecDeque::new(),
            last_event_id: 0,
            truncations: 0,
        }
    }

    /// Overrides the per-message and per-run limits (tests).
    pub fn with_limits(mut self, limit: usize, output_limit: usize) -> Self {
        self.limit = limit;
        self.output_limit = output_limit;
        self
    }

    pub fn bound_conversation(&self) -> Option<&str> {
        self.bound_conversation.as_deref()
    }

    pub fn tracked_runs(&self) -> usize {
        self.runs.len()
    }

    /// Feeds one workspace event. `origin` resolves a run id to the WeChat
    /// peer that admitted it (or `None` for browser/other runs).
    pub fn observe(
        &mut self,
        event: &WorkspaceEvent,
        origin: &dyn Fn(&str) -> Option<String>,
    ) -> Vec<OutboundAction> {
        if event.id != 0 && event.id <= self.last_event_id {
            // Cursor replay: already projected.
            return Vec::new();
        }
        self.last_event_id = self.last_event_id.max(event.id);
        match event.kind.as_str() {
            "ilink_status_changed" => return self.on_status(&event.payload),
            "session_removed" => {
                return match event.conversation_id.as_deref() {
                    Some(conversation_id) => self.drop_conversation(conversation_id),
                    None => Vec::new(),
                };
            }
            _ => {}
        }
        let (Some(run_id), Some(conversation_id)) =
            (event.run_id.as_deref(), event.conversation_id.as_deref())
        else {
            return Vec::new();
        };
        let mut actions = Vec::new();
        if !self.runs.contains_key(run_id) {
            if self.settled_set.contains(run_id)
                || self.bound_conversation.as_deref() != Some(conversation_id)
                || !is_run_event(&event.kind)
            {
                return actions;
            }
            match origin(run_id) {
                Some(peer_id) if self.runs.len() < MAX_TRACKED_RUNS => {
                    self.runs.insert(
                        run_id.to_owned(),
                        RunReply {
                            peer_id: peer_id.clone(),
                            conversation_id: conversation_id.to_owned(),
                            buffer: String::new(),
                            filter: MarkdownFilter::default(),
                            fence: None,
                            next_chunk: 0,
                            next_media: 0,
                            sent_chars: 0,
                            sent_text: false,
                            truncated: false,
                            typing: true,
                            started: Instant::now(),
                        },
                    );
                    actions.push(OutboundAction::Typing {
                        peer_id,
                        typing: true,
                    });
                }
                _ => {
                    self.settle(run_id);
                    return actions;
                }
            }
        }
        match event.kind.as_str() {
            "text_delta" => {
                if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                    actions.extend(self.append(run_id, text));
                }
            }
            // Tool persistence is coalesced (#110): a started/completed
            // pair in one batch persists as `tool_completed` alone, so any
            // tool event is a flush boundary.
            "tool_started" | "tool_updated" | "tool_completed" => {
                actions.extend(self.flush(run_id))
            }
            "permission_requested" => actions.extend(self.permission_menu(run_id, &event.payload)),
            "elicitation_requested" => {
                actions.extend(self.elicitation_notice(run_id, &event.payload))
            }
            "media_shared" => actions.extend(self.media(run_id, &event.payload)),
            "run_completed" => actions.extend(self.complete(run_id, &event.payload)),
            _ => {}
        }
        actions
    }

    /// Typing refresh: active runs re-announce typing; runs past
    /// `typing_max` stop typing for good.
    pub fn keepalive(&mut self, now: Instant, typing_max: Duration) -> Vec<OutboundAction> {
        let mut actions = Vec::new();
        let mut peers = HashSet::new();
        for run in self.runs.values_mut() {
            if !run.typing {
                continue;
            }
            if now.duration_since(run.started) >= typing_max {
                run.typing = false;
                actions.push(OutboundAction::Typing {
                    peer_id: run.peer_id.clone(),
                    typing: false,
                });
            } else if peers.insert(run.peer_id.clone()) {
                actions.push(OutboundAction::Typing {
                    peer_id: run.peer_id.clone(),
                    typing: true,
                });
            }
        }
        actions
    }

    /// The peer's context is gone (expired/missing): every run for that
    /// peer is dropped silently — nothing more can be delivered to it.
    pub fn drop_peer(&mut self, peer_id: &str) {
        let doomed: Vec<String> = self
            .runs
            .iter()
            .filter(|(_, run)| run.peer_id == peer_id)
            .map(|(run_id, _)| run_id.clone())
            .collect();
        for run_id in doomed {
            self.runs.remove(&run_id);
            self.settle(&run_id);
        }
    }

    /// Runtime shutdown: stop typing everywhere, abandon buffers.
    pub fn shutdown(&mut self) -> Vec<OutboundAction> {
        let run_ids: Vec<String> = self.runs.keys().cloned().collect();
        let mut actions = Vec::new();
        for run_id in run_ids {
            actions.extend(self.abandon(&run_id));
        }
        actions
    }

    fn on_status(&mut self, payload: &Value) -> Vec<OutboundAction> {
        let status = payload.get("status").and_then(Value::as_str).unwrap_or("");
        let conversation = payload
            .get("conversation_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let connected = matches!(status, "connected" | "connecting");
        self.bound_conversation = if connected { conversation } else { None };
        let stale: Vec<String> = self
            .runs
            .iter()
            .filter(|(_, run)| self.bound_conversation.as_deref() != Some(&run.conversation_id))
            .map(|(run_id, _)| run_id.clone())
            .collect();
        let mut actions = Vec::new();
        for run_id in stale {
            actions.extend(self.abandon(&run_id));
        }
        actions
    }

    fn drop_conversation(&mut self, conversation_id: &str) -> Vec<OutboundAction> {
        if self.bound_conversation.as_deref() == Some(conversation_id) {
            self.bound_conversation = None;
        }
        let doomed: Vec<String> = self
            .runs
            .iter()
            .filter(|(_, run)| run.conversation_id == conversation_id)
            .map(|(run_id, _)| run_id.clone())
            .collect();
        let mut actions = Vec::new();
        for run_id in doomed {
            actions.extend(self.abandon(&run_id));
        }
        actions
    }

    /// Clears a run without flushing: typing stops, buffers are dropped,
    /// and its pending interactions are forgotten.
    fn abandon(&mut self, run_id: &str) -> Vec<OutboundAction> {
        let Some(run) = self.runs.remove(run_id) else {
            return Vec::new();
        };
        self.settle(run_id);
        let mut actions = vec![OutboundAction::ClearInteractions {
            peer_id: run.peer_id.clone(),
        }];
        if run.typing {
            actions.push(OutboundAction::Typing {
                peer_id: run.peer_id,
                typing: false,
            });
        }
        actions
    }

    fn settle(&mut self, run_id: &str) {
        if self.settled_set.insert(run_id.to_owned()) {
            self.settled_runs.push_back(run_id.to_owned());
            while self.settled_runs.len() > RUN_MEMORY {
                if let Some(evicted) = self.settled_runs.pop_front() {
                    self.settled_set.remove(&evicted);
                }
            }
        }
    }

    fn append(&mut self, run_id: &str, text: &str) -> Vec<OutboundAction> {
        let limit = self.limit;
        let Some(run) = self.runs.get_mut(run_id) else {
            return Vec::new();
        };
        if run.truncated {
            return Vec::new();
        }
        run.buffer.push_str(text);
        if run.buffer.chars().count() < limit {
            return Vec::new();
        }
        // Size flush: everything up to the last newline; one oversized
        // line flushes whole.
        let cut = match run.buffer.rfind('\n') {
            Some(index) if run.buffer[index + 1..].chars().count() < limit => index + 1,
            _ => run.buffer.len(),
        };
        let head: String = run.buffer.drain(..cut).collect();
        self.emit(run_id, &head)
    }

    fn flush(&mut self, run_id: &str) -> Vec<OutboundAction> {
        let Some(run) = self.runs.get_mut(run_id) else {
            return Vec::new();
        };
        let head = std::mem::take(&mut run.buffer);
        self.emit(run_id, &head)
    }

    fn emit(&mut self, run_id: &str, raw: &str) -> Vec<OutboundAction> {
        let limit = self.limit;
        let output_limit = self.output_limit;
        let Some(run) = self.runs.get_mut(run_id) else {
            return Vec::new();
        };
        if raw.trim().is_empty() || run.truncated {
            return Vec::new();
        }
        let filtered = run.filter.filter(raw);
        let (chunks, fence) = split_text_from(&filtered, limit, run.fence.take());
        run.fence = fence;
        let mut actions = Vec::new();
        for chunk in chunks {
            let size = chunk.chars().count();
            if run.sent_chars + size > output_limit {
                run.truncated = true;
                run.buffer.clear();
                self.truncations += 1;
                break;
            }
            run.sent_chars += size;
            run.sent_text = true;
            actions.push(OutboundAction::Text {
                peer_id: run.peer_id.clone(),
                text: chunk,
                client_id: format!("kubecode-{run_id}-{}", run.next_chunk),
            });
            run.next_chunk += 1;
        }
        actions
    }

    fn permission_menu(&mut self, run_id: &str, payload: &Value) -> Vec<OutboundAction> {
        let Some(request_id) = payload.get("request_id").and_then(Value::as_str) else {
            return Vec::new();
        };
        if !self.first_sighting(request_id) {
            return Vec::new();
        }
        let mut actions = self.flush(run_id);
        let Some(run) = self.runs.get(run_id) else {
            return actions;
        };
        let options: Vec<(String, String)> = payload
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let id = option.get("id").and_then(Value::as_str)?;
                        let label = option.get("label").and_then(Value::as_str).unwrap_or(id);
                        Some((id.to_owned(), bounded(label, MENU_LABEL_LIMIT)))
                    })
                    .take(MENU_OPTION_LIMIT)
                    .collect()
            })
            .unwrap_or_default();
        if options.is_empty() {
            return actions;
        }
        let tool = payload
            .get("tool")
            .and_then(Value::as_str)
            .map(|tool| bounded(tool, MENU_TITLE_LIMIT));
        let mut text = match (&tool, self.language) {
            (Some(tool), ChannelLanguage::En) => format!("Permission needed: {tool}"),
            (Some(tool), ChannelLanguage::ZhCn) => format!("需要授权：{tool}"),
            (None, language) => language_pick(language, "Permission needed", "需要授权").to_owned(),
        };
        for (index, (_, label)) in options.iter().enumerate() {
            text.push_str(&format!("\n{}. {label}", index + 1));
        }
        text.push('\n');
        text.push_str(language_pick(
            self.language,
            "Reply with a number to choose.",
            "回复数字进行选择。",
        ));
        actions.push(OutboundAction::Interaction {
            peer_id: run.peer_id.clone(),
            request_id: request_id.to_owned(),
            kind: InteractionKind::Permission,
            option_ids: options.into_iter().map(|(id, _)| id).collect(),
        });
        actions.push(OutboundAction::Text {
            peer_id: run.peer_id.clone(),
            text,
            client_id: format!("kubecode-{request_id}"),
        });
        actions
    }

    fn elicitation_notice(&mut self, run_id: &str, payload: &Value) -> Vec<OutboundAction> {
        let Some(request_id) = payload.get("request_id").and_then(Value::as_str) else {
            return Vec::new();
        };
        if !self.first_sighting(request_id) {
            return Vec::new();
        }
        let mut actions = self.flush(run_id);
        let Some(run) = self.runs.get(run_id) else {
            return actions;
        };
        actions.push(OutboundAction::Interaction {
            peer_id: run.peer_id.clone(),
            request_id: request_id.to_owned(),
            kind: InteractionKind::Elicitation,
            option_ids: vec!["decline".to_owned()],
        });
        actions.push(OutboundAction::Text {
            peer_id: run.peer_id.clone(),
            text: language_pick(
                self.language,
                "The Agent is asking for input WeChat cannot fill in.\n1. Decline\nReply 1 to decline, or answer in Kubecode.",
                "Agent 需要填写微信无法提供的信息。\n1. 拒绝\n回复 1 拒绝，或前往 Kubecode 作答。",
            )
            .to_owned(),
            client_id: format!("kubecode-{request_id}"),
        });
        actions
    }

    fn complete(&mut self, run_id: &str, payload: &Value) -> Vec<OutboundAction> {
        let mut actions = self.flush(run_id);
        let Some(run) = self.runs.remove(run_id) else {
            return actions;
        };
        self.settle(run_id);
        let status = payload.get("status").and_then(Value::as_str).unwrap_or("");
        let cause = payload.get("cause").and_then(Value::as_str);
        let mut notices: Vec<&'static str> = Vec::new();
        if run.truncated {
            notices.push(language_pick(
                self.language,
                "(Reply truncated — open Kubecode for the full output.)",
                "（回复过长已截断，请在 Kubecode 中查看完整内容。）",
            ));
        }
        if let Some(notice) = terminal_notice(self.language, status, cause, run.sent_text) {
            notices.push(notice);
        }
        for (index, notice) in notices.into_iter().enumerate() {
            actions.push(OutboundAction::Text {
                peer_id: run.peer_id.clone(),
                text: notice.to_owned(),
                client_id: format!("kubecode-{run_id}-end{index}"),
            });
        }
        actions.push(OutboundAction::ClearInteractions {
            peer_id: run.peer_id.clone(),
        });
        if run.typing {
            actions.push(OutboundAction::Typing {
                peer_id: run.peer_id,
                typing: false,
            });
        }
        actions
    }

    /// Text before a shared file reaches the peer first; the file itself
    /// is resolved by opaque id at delivery time.
    fn media(&mut self, run_id: &str, payload: &Value) -> Vec<OutboundAction> {
        let Some(media_id) = payload.get("media_id").and_then(Value::as_str) else {
            return Vec::new();
        };
        let mut actions = self.flush(run_id);
        let Some(run) = self.runs.get_mut(run_id) else {
            return actions;
        };
        if run.truncated {
            return actions;
        }
        actions.push(OutboundAction::Media {
            peer_id: run.peer_id.clone(),
            conversation_id: run.conversation_id.clone(),
            media_id: media_id.to_owned(),
            client_id: format!("kubecode-{run_id}-m{}", run.next_media),
        });
        run.next_media += 1;
        actions
    }

    fn first_sighting(&mut self, request_id: &str) -> bool {
        if self.seen_requests.iter().any(|seen| seen == request_id) {
            return false;
        }
        self.seen_requests.push_back(request_id.to_owned());
        while self.seen_requests.len() > RUN_MEMORY {
            self.seen_requests.pop_front();
        }
        true
    }
}

fn is_run_event(kind: &str) -> bool {
    matches!(
        kind,
        "run_started"
            | "text_delta"
            | "tool_started"
            | "tool_updated"
            | "tool_completed"
            | "permission_requested"
            | "elicitation_requested"
            | "media_shared"
            | "run_completed"
    )
}

fn language_pick(language: ChannelLanguage, en: &'static str, zh: &'static str) -> &'static str {
    match language {
        ChannelLanguage::En => en,
        ChannelLanguage::ZhCn => zh,
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

/// Localized typed terminal outcome, sent after pending text flushes.
/// Raw error text never reaches the peer (it may carry paths).
pub fn terminal_notice(
    language: ChannelLanguage,
    status: &str,
    cause: Option<&str>,
    sent_text: bool,
) -> Option<&'static str> {
    let pick = |en, zh| Some(language_pick(language, en, zh));
    match (cause, status) {
        (Some("cancelled"), _) | (_, "cancelled") => pick("Run cancelled.", "本轮运行已取消。"),
        (Some("max_tokens"), _) => pick(
            "Reply stopped: the Agent hit its token limit.",
            "回复中止：Agent 达到了 token 上限。",
        ),
        (Some("max_turn_requests"), _) => pick(
            "Run stopped: the Agent hit its turn request limit.",
            "运行中止：Agent 达到了单轮请求上限。",
        ),
        (Some("refusal"), _) => pick("The Agent declined to continue.", "Agent 拒绝继续执行。"),
        (Some("interrupted"), _) | (_, "interrupted") => pick(
            "Run interrupted — the Runtime restarted or the Agent disconnected.",
            "运行被中断：Runtime 已重启或 Agent 已断开。",
        ),
        (_, "timed_out") => pick("Run timed out.", "运行超时。"),
        (Some("error"), _) | (_, "failed") => pick(
            "Run failed. Open Kubecode for details.",
            "运行失败，请在 Kubecode 中查看详情。",
        ),
        _ if !sent_text => pick(
            "Done — the Agent finished without a text reply.",
            "已完成，Agent 没有文本回复。",
        ),
        _ => None,
    }
}

// -- Media --------------------------------------------------------------------

/// A shared file resolved for delivery, with its optional caption.
pub struct LoadedMedia {
    pub file: SharedMediaFile,
    pub caption: Option<String>,
}

/// Why a shared file cannot be delivered. Content-free by construction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaRejection {
    /// Unknown id, another Session's media, or the Session is gone.
    Unavailable,
    /// Outside the execution root, symlinked, hidden, not a regular file,
    /// unsupported type, or content that does not match its type.
    Ineligible,
    /// Changed or missing since it was shared.
    Changed,
    /// Above the delivery bound.
    TooLarge,
}

/// Resolves shared media by opaque id within one conversation. Production
/// reads through `WorkspaceService`; the call is blocking file I/O and runs
/// on the blocking pool.
pub trait MediaSource: Send + Sync {
    fn load(&self, conversation_id: &str, media_id: &str) -> Result<LoadedMedia, MediaRejection>;
}

// -- Transport and bridge ------------------------------------------------------

/// Delivery surface for outbound actions. Production delivers through
/// [`super::service::ILinkService`]; tests capture.
pub trait OutboundTransport: Send + Sync {
    fn send_text<'a>(
        &'a self,
        peer_id: &'a str,
        text: &'a str,
        client_id: &'a str,
    ) -> BoxFuture<'a, Result<(), IlinkError>>;

    fn set_typing<'a>(
        &'a self,
        peer_id: &'a str,
        typing: bool,
    ) -> BoxFuture<'a, Result<(), IlinkError>>;

    fn send_media<'a>(
        &'a self,
        peer_id: &'a str,
        media: &'a SharedMediaFile,
        client_id: &'a str,
    ) -> BoxFuture<'a, Result<(), IlinkError>>;
}

/// Errors that mean the peer cannot be reached until it writes again (or
/// the channel is re-linked): further sends for it are pointless.
fn is_peer_unreachable(error: &IlinkError) -> bool {
    matches!(
        error,
        IlinkError::SessionExpired { .. } | IlinkError::PeerContextUnavailable
    )
}

/// A localized acknowledgement queued by the inbound side.
struct QueuedReply {
    peer_id: String,
    text: String,
}

/// [`ResponseChannel`] that enqueues into the bridge's ordered delivery
/// loop. Bounded: a full queue drops the reply (counted, never logged).
#[derive(Clone)]
pub struct QueuedResponses {
    sender: mpsc::Sender<QueuedReply>,
    counters: Arc<OutboundCounters>,
}

impl ResponseChannel for QueuedResponses {
    fn send_reply(
        &self,
        _account_id: &str,
        peer_id: &str,
        reply: &ChannelReply,
    ) -> Result<(), IlinkError> {
        self.sender
            .try_send(QueuedReply {
                peer_id: peer_id.to_owned(),
                text: reply.text.clone(),
            })
            .map_err(|_| {
                self.counters.dropped.fetch_add(1, Ordering::Relaxed);
                IlinkError::PayloadTooLarge {
                    limit: REPLY_QUEUE_CAPACITY,
                }
            })
    }
}

/// Safe operational counters — never carry content.
#[derive(Debug, Default)]
pub struct OutboundCounters {
    pub sent: AtomicU64,
    pub failed: AtomicU64,
    pub dropped: AtomicU64,
    pub duplicates: AtomicU64,
    pub media_rejected: AtomicU64,
}

/// Tunables; production uses the defaults.
#[derive(Clone, Copy, Debug)]
pub struct OutboundConfig {
    pub language: ChannelLanguage,
    pub keepalive: Duration,
    pub typing_max: Duration,
    /// Delay before the single retry of a transient send failure.
    pub retry_delay: Duration,
}

impl Default for OutboundConfig {
    fn default() -> Self {
        Self {
            language: ChannelLanguage::En,
            keepalive: TYPING_KEEPALIVE,
            typing_max: TYPING_MAX,
            retry_delay: Duration::from_millis(500),
        }
    }
}

/// Drives a [`ReplyProjector`] from the workspace event bus.
pub struct OutboundBridge {
    store: Arc<AgentStore>,
    transport: Arc<dyn OutboundTransport>,
    router: Option<Arc<SessionRouter>>,
    media: Option<Arc<dyn MediaSource>>,
    config: OutboundConfig,
    replies: mpsc::Sender<QueuedReply>,
    inbox: std::sync::Mutex<Option<mpsc::Receiver<QueuedReply>>>,
    pub counters: Arc<OutboundCounters>,
}

impl OutboundBridge {
    pub fn new(
        store: Arc<AgentStore>,
        transport: Arc<dyn OutboundTransport>,
        router: Option<Arc<SessionRouter>>,
        media: Option<Arc<dyn MediaSource>>,
        config: OutboundConfig,
    ) -> Arc<Self> {
        let (replies, inbox) = mpsc::channel(REPLY_QUEUE_CAPACITY);
        Arc::new(Self {
            store,
            transport,
            router,
            media,
            config,
            replies,
            inbox: std::sync::Mutex::new(Some(inbox)),
            counters: Arc::new(OutboundCounters::default()),
        })
    }

    /// The ordered acknowledgement channel for the inbound bridge and the
    /// Session router.
    pub fn responses(&self) -> QueuedResponses {
        QueuedResponses {
            sender: self.replies.clone(),
            counters: Arc::clone(&self.counters),
        }
    }

    /// Starts the delivery loop. Events committed after this call are
    /// projected; older history is never replayed to WeChat.
    pub fn spawn(self: &Arc<Self>, cancel: CancellationToken) -> JoinHandle<()> {
        let bridge = Arc::clone(self);
        let cursor = self.store.latest_workspace_event_id().unwrap_or(0);
        let bus = self.store.workspace_event_bus().subscribe();
        tokio::spawn(async move { bridge.run(cancel, cursor, bus).await })
    }

    async fn run(
        self: Arc<Self>,
        cancel: CancellationToken,
        mut cursor: u64,
        mut bus: tokio::sync::watch::Receiver<u64>,
    ) {
        let Some(mut inbox) = self.inbox.lock().expect("outbound inbox poisoned").take() else {
            return;
        };
        let bound = self
            .current_account()
            .and_then(|account_id| self.store.ilink_session_binding(&account_id).ok().flatten());
        let mut projector = ReplyProjector::new(self.config.language, bound);
        let mut sent = SentLedger::default();
        let mut keepalive = tokio::time::interval(self.config.keepalive);
        keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        keepalive.tick().await;
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                Some(reply) = inbox.recv() => {
                    self.deliver_text(&mut projector, &mut sent, &reply.peer_id, &reply.text, None).await;
                }
                changed = bus.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    loop {
                        let Ok(events) = self.store.workspace_events_after(cursor) else {
                            break;
                        };
                        let page = events.len();
                        for event in events {
                            cursor = cursor.max(event.id);
                            let actions = projector.observe(&event, &|run_id| self.run_origin(run_id));
                            self.execute(&mut projector, &mut sent, actions).await;
                        }
                        if page < 512 {
                            break;
                        }
                    }
                }
                _ = keepalive.tick() => {
                    let actions = projector.keepalive(Instant::now(), self.config.typing_max);
                    self.execute(&mut projector, &mut sent, actions).await;
                }
            }
        }
        // Shutdown: abandon buffers, stop typing best-effort, never wait
        // on a slow upstream.
        let actions = projector.shutdown();
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            self.execute(&mut projector, &mut sent, actions),
        )
        .await;
    }

    fn current_account(&self) -> Option<String> {
        self.store
            .first_ilink_credentials()
            .map(|credentials| credentials.account_id)
    }

    /// The WeChat peer that admitted `run_id`, when the run belongs to the
    /// currently linked account.
    fn run_origin(&self, run_id: &str) -> Option<String> {
        let run = self.store.get_run(run_id).ok()?;
        let (account_id, peer_id) = parse_channel_client_id(run.client_message_id.as_deref()?)?;
        (Some(account_id) == self.current_account()).then_some(peer_id)
    }

    async fn execute(
        &self,
        projector: &mut ReplyProjector,
        sent: &mut SentLedger,
        actions: Vec<OutboundAction>,
    ) {
        let mut unreachable: HashSet<String> = HashSet::new();
        for action in actions {
            match action {
                OutboundAction::Text {
                    peer_id,
                    text,
                    client_id,
                } => {
                    if unreachable.contains(&peer_id) {
                        continue;
                    }
                    if !self
                        .deliver_text(projector, sent, &peer_id, &text, Some(client_id))
                        .await
                    {
                        unreachable.insert(peer_id);
                    }
                }
                OutboundAction::Typing { peer_id, typing } => {
                    if unreachable.contains(&peer_id) {
                        continue;
                    }
                    // Typing is advisory: failures never block text.
                    let _ = self.transport.set_typing(&peer_id, typing).await;
                }
                OutboundAction::Interaction {
                    peer_id,
                    request_id,
                    kind,
                    option_ids,
                } => {
                    let (Some(router), Some(account_id)) = (&self.router, self.current_account())
                    else {
                        continue;
                    };
                    router
                        .register_interaction(&account_id, &peer_id, &request_id, kind, option_ids)
                        .await;
                }
                OutboundAction::ClearInteractions { peer_id } => {
                    if let (Some(router), Some(account_id)) = (&self.router, self.current_account())
                    {
                        router.clear_peer_requests(&account_id, &peer_id).await;
                    }
                }
                OutboundAction::Media {
                    peer_id,
                    conversation_id,
                    media_id,
                    client_id,
                } => {
                    if unreachable.contains(&peer_id) {
                        continue;
                    }
                    if !self
                        .deliver_media(
                            projector,
                            sent,
                            &peer_id,
                            &conversation_id,
                            &media_id,
                            client_id,
                        )
                        .await
                    {
                        unreachable.insert(peer_id);
                    }
                }
            }
        }
    }

    /// Resolves and delivers one shared file: optional caption first, then
    /// the media. Any rejection or failed upload becomes one bounded,
    /// localized notice. The file buffer is dropped when this returns.
    /// Returns `false` when the peer is unreachable.
    async fn deliver_media(
        &self,
        projector: &mut ReplyProjector,
        sent: &mut SentLedger,
        peer_id: &str,
        conversation_id: &str,
        media_id: &str,
        client_id: String,
    ) -> bool {
        if sent.contains(&client_id) {
            self.counters.duplicates.fetch_add(1, Ordering::Relaxed);
            return true;
        }
        let loaded = match &self.media {
            Some(source) => {
                let source = Arc::clone(source);
                let conversation_id = conversation_id.to_owned();
                let media_id = media_id.to_owned();
                tokio::task::spawn_blocking(move || source.load(&conversation_id, &media_id))
                    .await
                    .unwrap_or(Err(MediaRejection::Unavailable))
            }
            None => Err(MediaRejection::Unavailable),
        };
        let failure_notice = format!("{client_id}-failed");
        let loaded = match loaded {
            Ok(loaded) => loaded,
            Err(_) => {
                self.counters.media_rejected.fetch_add(1, Ordering::Relaxed);
                return self
                    .deliver_text(
                        projector,
                        sent,
                        peer_id,
                        media_failure_notice(self.config.language),
                        Some(failure_notice),
                    )
                    .await;
            }
        };
        if let Some(caption) = loaded.caption.as_deref()
            && !self
                .deliver_text(
                    projector,
                    sent,
                    peer_id,
                    caption,
                    Some(format!("{client_id}-caption")),
                )
                .await
        {
            return false;
        }
        match self
            .transport
            .send_media(peer_id, &loaded.file, &client_id)
            .await
        {
            Ok(()) => {
                sent.insert(client_id);
                self.counters.sent.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(error) if is_peer_unreachable(&error) => {
                self.counters.failed.fetch_add(1, Ordering::Relaxed);
                projector.drop_peer(peer_id);
                false
            }
            Err(_) => {
                self.counters.failed.fetch_add(1, Ordering::Relaxed);
                self.deliver_text(
                    projector,
                    sent,
                    peer_id,
                    media_failure_notice(self.config.language),
                    Some(failure_notice),
                )
                .await
            }
        }
    }

    /// Sends one text with a single bounded retry for transient failures.
    /// Returns `false` when the peer is unreachable (its runs are dropped).
    async fn deliver_text(
        &self,
        projector: &mut ReplyProjector,
        sent: &mut SentLedger,
        peer_id: &str,
        text: &str,
        client_id: Option<String>,
    ) -> bool {
        let client_id =
            client_id.unwrap_or_else(|| format!("kubecode-ack-{}", uuid::Uuid::new_v4()));
        if sent.contains(&client_id) {
            self.counters.duplicates.fetch_add(1, Ordering::Relaxed);
            return true;
        }
        let mut attempt = 0;
        loop {
            match self.transport.send_text(peer_id, text, &client_id).await {
                Ok(()) => {
                    sent.insert(client_id);
                    self.counters.sent.fetch_add(1, Ordering::Relaxed);
                    return true;
                }
                Err(error) if is_peer_unreachable(&error) => {
                    self.counters.failed.fetch_add(1, Ordering::Relaxed);
                    projector.drop_peer(peer_id);
                    return false;
                }
                Err(_) if attempt == 0 => {
                    attempt += 1;
                    tokio::time::sleep(self.config.retry_delay).await;
                }
                Err(_) => {
                    self.counters.failed.fetch_add(1, Ordering::Relaxed);
                    return true;
                }
            }
        }
    }
}

fn media_failure_notice(language: ChannelLanguage) -> &'static str {
    language_pick(
        language,
        "A shared file could not be sent. Open Kubecode to get it.",
        "共享文件发送失败，请在 Kubecode 中查看。",
    )
}

/// Bounded memory of delivered client ids (replay suppression).
#[derive(Default)]
struct SentLedger {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl SentLedger {
    fn contains(&self, client_id: &str) -> bool {
        self.ids.contains(client_id)
    }

    fn insert(&mut self, client_id: String) {
        if self.ids.insert(client_id.clone()) {
            self.order.push_back(client_id);
            while self.order.len() > SENT_MEMORY {
                if let Some(evicted) = self.order.pop_front() {
                    self.ids.remove(&evicted);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RUN: &str = "run-1";
    const CONVERSATION: &str = "conversation-1";
    const PEER: &str = "wxid_synthetic_owner";

    struct Feed {
        next_id: u64,
        projector: ReplyProjector,
    }

    impl Feed {
        fn new(limit: usize, output_limit: usize) -> Self {
            Self {
                next_id: 0,
                projector: ReplyProjector::new(ChannelLanguage::En, Some(CONVERSATION.into()))
                    .with_limits(limit, output_limit),
            }
        }

        fn event(&mut self, kind: &str, payload: Value) -> WorkspaceEvent {
            self.next_id += 1;
            WorkspaceEvent {
                id: self.next_id,
                kind: kind.to_owned(),
                project_id: Some("project".into()),
                conversation_id: Some(CONVERSATION.into()),
                run_id: Some(RUN.into()),
                payload,
                created_at: String::new(),
            }
        }

        fn push(&mut self, kind: &str, payload: Value) -> Vec<OutboundAction> {
            let event = self.event(kind, payload);
            self.projector.observe(&event, &|_| Some(PEER.to_owned()))
        }
    }

    fn texts(actions: &[OutboundAction]) -> Vec<String> {
        actions
            .iter()
            .filter_map(|action| match action {
                OutboundAction::Text { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn typing(actions: &[OutboundAction]) -> Vec<bool> {
        actions
            .iter()
            .filter_map(|action| match action {
                OutboundAction::Typing { typing, .. } => Some(*typing),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn markdown_filter_simplifies_prose_and_preserves_code_fences() {
        let mut filter = MarkdownFilter::default();
        let rendered = filter.filter(
            "## Plan\n\n- **fix** the [docs](https://example.com)\n- [x] ship\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```rust\n## not a heading\n- **kept**\n```\n---\n![diagram](img.png)",
        );
        assert_eq!(
            rendered,
            "Plan\n\n• fix the docs (https://example.com)\n☑ ship\n\n| a | b |\n| 1 | 2 |\n\n```rust\n## not a heading\n- **kept**\n```\n──────\ndiagram"
        );
        assert!(!filter.in_fence());
        // A flush that ends inside a fence keeps the rest verbatim.
        let first = filter.filter("```\n# inside");
        assert!(filter.in_fence());
        let second = filter.filter("**still code**\n```\n**prose**");
        assert_eq!(first, "```\n# inside");
        assert_eq!(second, "**still code**\n```\nprose");
        // Inline code spans are verbatim.
        assert_eq!(
            MarkdownFilter::default().filter("use `**ptr` and **bold**"),
            "use `**ptr` and bold"
        );
    }

    #[test]
    fn split_respects_the_limit_and_prefers_natural_boundaries() {
        let paragraph = "word ".repeat(60);
        let text = format!("{}\n\n{}", paragraph.trim(), paragraph.trim());
        let chunks = split_text(&text, 400);
        assert_eq!(chunks.len(), 2, "paragraph boundary wins");
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 400));
        assert_eq!(chunks.join("\n\n"), text);

        // CJK sentence punctuation is a boundary when no newline exists.
        let cjk = "这是一个很长的句子。".repeat(60);
        let chunks = split_text(&cjk, 200);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= 200);
            assert!(chunk.ends_with('。'), "cut at a sentence end: {chunk}");
        }
        assert_eq!(chunks.concat(), cjk);

        // No boundary at all: hard cut on a char boundary, never mid-char.
        let dense = "字".repeat(450);
        let chunks = split_text(&dense, 200);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 200));
        assert_eq!(chunks.concat(), dense);

        // The default WeChat limit.
        let long = "a".repeat(5_000);
        assert!(
            split_text(&long, WECHAT_TEXT_LIMIT)
                .iter()
                .all(|chunk| chunk.chars().count() <= WECHAT_TEXT_LIMIT)
        );
    }

    #[test]
    fn split_inside_a_code_fence_closes_and_reopens_it() {
        let code: String = (0..80).map(|n| format!("let value_{n} = {n};\n")).collect();
        let text = format!("Intro\n```rust\n{code}```\nOutro");
        let chunks = split_text(&text, 300);
        assert!(chunks.len() > 2);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= 300, "chunk within limit");
            let fences = chunk.lines().filter(|line| line.starts_with("```")).count();
            assert_eq!(fences % 2, 0, "every chunk has balanced fences: {chunk}");
        }
        assert!(
            chunks[1].starts_with("```rust\n"),
            "fence reopened with its info string"
        );
        assert!(chunks.last().expect("last").ends_with("Outro"));
    }

    #[test]
    fn streaming_accumulates_and_flushes_before_tools_and_at_completion() {
        let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
        let started = feed.push("run_started", json!({}));
        assert_eq!(typing(&started), vec![true], "typing starts with the run");
        assert!(
            feed.push("text_delta", json!({"text": "Looking "}))
                .is_empty()
        );
        assert!(
            feed.push("text_delta", json!({"text": "into it."}))
                .is_empty()
        );
        let tool = feed.push("tool_started", json!({"tool_id": "t1"}));
        assert_eq!(texts(&tool), vec!["Looking into it."], "pre-tool flush");
        assert!(
            feed.push("tool_completed", json!({"tool_id": "t1"}))
                .is_empty()
        );
        assert!(
            feed.push("thinking_delta", json!({"text": "secret"}))
                .is_empty()
        );
        // A coalesced tool call persists only its completion: still a
        // flush boundary.
        feed.push("text_delta", json!({"text": "Second step."}));
        let coalesced = feed.push("tool_completed", json!({"tool_id": "t2"}));
        assert_eq!(texts(&coalesced), vec!["Second step."]);
        feed.push("text_delta", json!({"text": "All done."}));
        let done = feed.push(
            "run_completed",
            json!({"status": "completed", "cause": "end_turn"}),
        );
        assert_eq!(texts(&done), vec!["All done."], "terminal flush, no notice");
        assert_eq!(typing(&done), vec![false], "typing stops at completion");
        // Stable, ordered client ids.
        let ids: Vec<String> = tool
            .iter()
            .chain(done.iter())
            .filter_map(|action| match action {
                OutboundAction::Text { client_id, .. } => Some(client_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            ids,
            vec!["kubecode-run-1-0", "kubecode-run-1-2"],
            "the coalesced flush took id 1"
        );
        assert_eq!(feed.projector.tracked_runs(), 0);
    }

    #[test]
    fn size_flush_keeps_chunks_within_the_limit() {
        let mut feed = Feed::new(100, RUN_OUTPUT_LIMIT);
        feed.push("run_started", json!({}));
        let mut sent = Vec::new();
        for line in 0..20 {
            let actions = feed.push(
                "text_delta",
                json!({"text": format!("line number {line} with some text\n")}),
            );
            sent.extend(texts(&actions));
        }
        assert!(!sent.is_empty(), "size flushes happen mid-run");
        let done = feed.push(
            "run_completed",
            json!({"status": "completed", "cause": "end_turn"}),
        );
        sent.extend(texts(&done));
        assert!(sent.iter().all(|chunk| chunk.chars().count() <= 100));
        let joined = sent.join("\n");
        for line in 0..20 {
            assert!(
                joined.contains(&format!("line number {line} ")),
                "ordered, complete"
            );
        }
    }

    #[test]
    fn every_terminal_cause_has_a_localized_notice() {
        for (status, cause, expected) in [
            ("cancelled", Some("cancelled"), "Run cancelled."),
            (
                "failed",
                Some("error"),
                "Run failed. Open Kubecode for details.",
            ),
            (
                "completed",
                Some("max_tokens"),
                "Reply stopped: the Agent hit its token limit.",
            ),
            (
                "completed",
                Some("max_turn_requests"),
                "Run stopped: the Agent hit its turn request limit.",
            ),
            (
                "completed",
                Some("refusal"),
                "The Agent declined to continue.",
            ),
            (
                "interrupted",
                Some("interrupted"),
                "Run interrupted — the Runtime restarted or the Agent disconnected.",
            ),
            ("timed_out", None, "Run timed out."),
        ] {
            let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
            feed.push("run_started", json!({}));
            feed.push("text_delta", json!({"text": "partial"}));
            let done = feed.push("run_completed", json!({"status": status, "cause": cause}));
            assert_eq!(
                texts(&done),
                vec!["partial".to_owned(), expected.to_owned()],
                "{status}"
            );
            assert_eq!(typing(&done), vec![false]);
            assert!(
                terminal_notice(ChannelLanguage::ZhCn, status, cause, true).is_some(),
                "zh-CN notice for {status}"
            );
        }
        // A silent end_turn says so instead of leaving the peer guessing.
        let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
        feed.push("run_started", json!({}));
        let done = feed.push(
            "run_completed",
            json!({"status": "completed", "cause": "end_turn"}),
        );
        assert_eq!(
            texts(&done),
            vec!["Done — the Agent finished without a text reply."]
        );
        // Raw error text never reaches the peer.
        let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
        feed.push("run_started", json!({}));
        let failed = feed.push(
            "run_completed",
            json!({"status": "failed", "cause": "error", "error": "/home/user/secret.txt missing"}),
        );
        assert!(texts(&failed).iter().all(|text| !text.contains("/home")));
    }

    #[test]
    fn replayed_and_duplicate_terminal_events_send_nothing_twice() {
        let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
        let started = feed.event("run_started", json!({}));
        let delta = feed.event("text_delta", json!({"text": "once"}));
        let done = feed.event(
            "run_completed",
            json!({"status": "completed", "cause": "end_turn"}),
        );
        let origin = |_: &str| Some(PEER.to_owned());
        let mut all = Vec::new();
        for event in [&started, &delta, &done] {
            all.extend(feed.projector.observe(event, &origin));
        }
        // Cursor replay of the same ids.
        for event in [&started, &delta, &done] {
            assert!(feed.projector.observe(event, &origin).is_empty());
        }
        // A second completion with a fresh id for an already-settled run.
        let again = feed.push("run_completed", json!({"status": "completed"}));
        assert!(again.is_empty(), "settled runs never re-track");
        assert_eq!(texts(&all), vec!["once"]);
    }

    #[test]
    fn runs_from_other_origins_or_conversations_are_ignored() {
        let mut projector = ReplyProjector::new(ChannelLanguage::En, Some(CONVERSATION.into()));
        let browser_run = WorkspaceEvent {
            id: 1,
            kind: "run_started".into(),
            project_id: None,
            conversation_id: Some(CONVERSATION.into()),
            run_id: Some("browser-run".into()),
            payload: json!({}),
            created_at: String::new(),
        };
        assert!(projector.observe(&browser_run, &|_| None).is_empty());
        let other_conversation = WorkspaceEvent {
            id: 2,
            conversation_id: Some("other".into()),
            run_id: Some("other-run".into()),
            ..browser_run.clone()
        };
        let lookups = std::cell::Cell::new(0);
        let counting = |_: &str| {
            lookups.set(lookups.get() + 1);
            Some(PEER.to_owned())
        };
        assert!(projector.observe(&other_conversation, &counting).is_empty());
        assert_eq!(
            lookups.get(),
            0,
            "unbound conversations never hit the store"
        );
        // A settled browser run is not looked up again for each delta.
        let delta = WorkspaceEvent {
            id: 3,
            kind: "text_delta".into(),
            payload: json!({"text": "hi"}),
            ..browser_run.clone()
        };
        assert!(projector.observe(&delta, &counting).is_empty());
        assert_eq!(lookups.get(), 0);
    }

    #[test]
    fn binding_change_logout_and_session_removal_stop_typing_and_clear_buffers() {
        for (kind, payload, conversation) in [
            (
                "ilink_status_changed",
                json!({"status": "connected", "conversation_id": "elsewhere"}),
                None,
            ),
            (
                "ilink_status_changed",
                json!({"status": "disconnected", "conversation_id": null}),
                None,
            ),
            (
                "session_removed",
                json!({"scope": "local"}),
                Some(CONVERSATION),
            ),
        ] {
            let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
            feed.push("run_started", json!({}));
            feed.push("text_delta", json!({"text": "buffered"}));
            let mut event = feed.event(kind, payload);
            event.run_id = None;
            event.conversation_id = conversation.map(str::to_owned);
            let actions = feed.projector.observe(&event, &|_| Some(PEER.to_owned()));
            assert!(
                texts(&actions).is_empty(),
                "{kind}: buffers are dropped, not flushed"
            );
            assert_eq!(typing(&actions), vec![false], "{kind}: typing stops");
            assert_eq!(feed.projector.tracked_runs(), 0);
            // Later events for the run send nothing.
            let late = feed.push("text_delta", json!({"text": "late"}));
            assert!(late.is_empty());
        }
    }

    #[test]
    fn peer_context_expiry_and_shutdown_drop_state() {
        let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
        feed.push("run_started", json!({}));
        feed.push("text_delta", json!({"text": "pending"}));
        feed.projector.drop_peer(PEER);
        assert_eq!(feed.projector.tracked_runs(), 0);
        assert!(
            feed.push("run_completed", json!({"status": "completed"}))
                .is_empty(),
            "an expired peer receives nothing more"
        );

        let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
        feed.push("run_started", json!({}));
        feed.push("text_delta", json!({"text": "pending"}));
        let actions = feed.projector.shutdown();
        assert!(texts(&actions).is_empty());
        assert_eq!(typing(&actions), vec![false]);
    }

    #[test]
    fn typing_keepalive_refreshes_then_stops_at_the_cap() {
        let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
        feed.push("run_started", json!({}));
        let now = Instant::now();
        assert_eq!(
            typing(&feed.projector.keepalive(now, Duration::from_secs(60))),
            vec![true]
        );
        let later = now + Duration::from_secs(61);
        assert_eq!(
            typing(&feed.projector.keepalive(later, Duration::from_secs(60))),
            vec![false]
        );
        assert!(
            feed.projector
                .keepalive(later, Duration::from_secs(60))
                .is_empty()
        );
        // Completion does not send a second stop.
        let done = feed.push(
            "run_completed",
            json!({"status": "completed", "cause": "end_turn"}),
        );
        assert!(typing(&done).is_empty());
    }

    #[test]
    fn overflow_truncates_with_a_single_notice() {
        let mut feed = Feed::new(100, 250);
        feed.push("run_started", json!({}));
        let mut sent = Vec::new();
        for _ in 0..20 {
            sent.extend(texts(&feed.push(
                "text_delta",
                json!({"text": "0123456789012345678901234567890123456789\n"}),
            )));
        }
        let done = feed.push(
            "run_completed",
            json!({"status": "completed", "cause": "end_turn"}),
        );
        let done_texts = texts(&done);
        assert_eq!(
            done_texts.last().map(String::as_str),
            Some("(Reply truncated — open Kubecode for the full output.)")
        );
        let total: usize = sent.iter().map(|chunk| chunk.chars().count()).sum();
        assert!(total <= 250, "output bounded per run");
        assert_eq!(feed.projector.truncations, 1);
    }

    #[test]
    fn permission_requests_flush_then_register_then_render_a_numbered_menu_once() {
        let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
        feed.push("run_started", json!({}));
        feed.push("text_delta", json!({"text": "About to run a command."}));
        let payload = json!({
            "request_id": "req-1",
            "tool": "Shell",
            "options": [
                {"id": "allow_once", "label": "Allow once"},
                {"id": "reject", "label": "Reject"}
            ]
        });
        let actions = feed.push("permission_requested", payload.clone());
        assert_eq!(actions.len(), 3);
        assert!(
            matches!(&actions[0], OutboundAction::Text { text, .. } if text == "About to run a command.")
        );
        assert!(matches!(
            &actions[1],
            OutboundAction::Interaction { request_id, option_ids, kind: InteractionKind::Permission, .. }
                if request_id == "req-1" && option_ids == &vec!["allow_once".to_owned(), "reject".to_owned()]
        ));
        assert!(matches!(
            &actions[2],
            OutboundAction::Text { text, .. }
                if text == "Permission needed: Shell\n1. Allow once\n2. Reject\nReply with a number to choose."
        ));
        // The runtime publishes the request on two event paths: once only.
        assert!(feed.push("permission_requested", payload).is_empty());
        let elicitation = feed.push("elicitation_requested", json!({"request_id": "req-2"}));
        assert!(matches!(
            &elicitation[0],
            OutboundAction::Interaction { kind: InteractionKind::Elicitation, option_ids, .. }
                if option_ids == &vec!["decline".to_owned()]
        ));
    }

    #[test]
    fn shared_media_flushes_text_first_and_gets_a_stable_id() {
        let mut feed = Feed::new(WECHAT_TEXT_LIMIT, RUN_OUTPUT_LIMIT);
        feed.push("run_started", json!({}));
        feed.push("text_delta", json!({"text": "Here is the chart."}));
        let actions = feed.push(
            "media_shared",
            json!({"media_id": "media-1", "kind": "image", "mime": "image/png"}),
        );
        assert_eq!(actions.len(), 2);
        assert!(
            matches!(&actions[0], OutboundAction::Text { text, .. } if text == "Here is the chart.")
        );
        assert!(matches!(
            &actions[1],
            OutboundAction::Media { media_id, client_id, conversation_id, .. }
                if media_id == "media-1" && client_id == "kubecode-run-1-m0" && conversation_id == CONVERSATION
        ));
        let second = feed.push("media_shared", json!({"media_id": "media-2"}));
        assert!(matches!(
            &second[0],
            OutboundAction::Media { client_id, .. } if client_id == "kubecode-run-1-m1"
        ));
        assert!(
            feed.push("media_shared", json!({})).is_empty(),
            "no id, no action"
        );
    }

    #[test]
    fn channel_client_ids_parse_back_to_account_and_peer() {
        assert_eq!(
            parse_channel_client_id("ilink:bot@im.bot:wxid_owner@im.wechat:1750000000000:12"),
            Some(("bot@im.bot".to_owned(), "wxid_owner@im.wechat".to_owned()))
        );
        assert_eq!(parse_channel_client_id("browser-uuid"), None);
        assert_eq!(parse_channel_client_id("ilink::1:2"), None);
        assert_eq!(parse_channel_client_id("other:acct:peer:1:2"), None);
    }

    #[test]
    fn debug_output_never_carries_reply_text_or_peer_ids() {
        let action = OutboundAction::Text {
            peer_id: PEER.into(),
            text: "the secret plan".into(),
            client_id: "kubecode-run-1-0".into(),
        };
        let rendered = format!("{action:?}");
        assert!(!rendered.contains("secret"));
        assert!(!rendered.contains(PEER));
    }
}
