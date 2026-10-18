//! The server-owned orchestrator (ADR 0217). It turns recorded intents of the
//! Workspace conversation into durable *routes* and delivers them to Sessions:
//! a researcher's request goes to the coordinator of an admitted round, a
//! targeted question to the Session it names, a dispatched attempt to its
//! executor, and a result back to the coordinator and the originating Thread.
//!
//! Everything here is idempotent and restartable. A route is identified by
//! (source, target), so routing the same message twice makes one route. A route
//! is claimed with a lease before delivery, resolved to its recipient *at
//! delivery time* (so a coordinator handoff retargets pending routes), and
//! handed to the Session under a delivery key the runtime de-duplicates on. The
//! researcher's authorization is never implied by a message: a request in a
//! Thread with no admitted round is answered, not acted on.

mod models;
mod sink;
#[cfg(test)]
mod tests;

pub use models::*;
pub use sink::RuntimeSink;

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

use crate::agent_store::AgentStore;
use crate::channel_store::{AuthorKind, ChannelStore, Claim, Intent, Message, NewMessage};
use crate::database::Database;
use crate::research_store::ResearchStore;
use crate::work_store::{Actor, WorkItem, WorkStore};

pub const ORCHESTRATOR: &str = "orchestrator";

pub struct Orchestrator {
    database: Arc<Database>,
    agents: Arc<AgentStore>,
    channels: Arc<ChannelStore>,
    work: Arc<WorkStore>,
    research: Arc<ResearchStore>,
    wake: tokio::sync::Notify,
}

pub fn ensure_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS message_routes (
           id              TEXT PRIMARY KEY,
           project_id      TEXT NOT NULL,
           kind            TEXT NOT NULL,
           source_kind     TEXT NOT NULL,
           source_id       TEXT NOT NULL,
           target_kind     TEXT NOT NULL,
           target_key      TEXT NOT NULL,
           target_ref      TEXT NOT NULL,
           channel_id      TEXT,
           thread_id       TEXT,
           body            TEXT NOT NULL,
           state           TEXT NOT NULL DEFAULT 'pending',
           attempts        INTEGER NOT NULL DEFAULT 0,
           busy            INTEGER NOT NULL DEFAULT 0,
           next_attempt_at INTEGER NOT NULL DEFAULT 0,
           lease_until     INTEGER NOT NULL DEFAULT 0,
           last_error      TEXT,
           recipient       TEXT,
           created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           delivered_at    TEXT,
           -- One source reaches one target once, however often it is routed.
           UNIQUE (source_kind, source_id, target_key)
         );
         CREATE INDEX IF NOT EXISTS message_routes_due
           ON message_routes(state, next_attempt_at);",
    )
}

const ROUTE_SELECT: &str = "SELECT id, project_id, kind, source_kind, source_id, target_kind,
        target_ref, thread_id, body, state, attempts, busy, last_error, recipient, created_at,
        delivered_at
    FROM message_routes";

fn route_from_row(row: &Row<'_>) -> rusqlite::Result<Route> {
    let kind: String = row.get(2)?;
    let source_kind: String = row.get(3)?;
    let target_kind: String = row.get(5)?;
    let target_ref: String = row.get(6)?;
    let state: String = row.get(9)?;
    Ok(Route {
        id: row.get(0)?,
        project_id: row.get(1)?,
        kind: RouteKind::parse(&kind).unwrap_or(RouteKind::Request),
        source_kind: SourceKind::parse(&source_kind).unwrap_or(SourceKind::Message),
        source_id: row.get(4)?,
        target: if target_kind == "coordinator" {
            Target::Coordinator {
                round_id: target_ref,
            }
        } else {
            Target::Session {
                session_id: target_ref,
            }
        },
        thread_id: row.get(7)?,
        body: row.get(8)?,
        state: RouteState::parse(&state).unwrap_or(RouteState::Pending),
        attempts: row.get::<_, i64>(10)? as u32,
        busy: row.get::<_, i64>(11)? as u32,
        last_error: row.get(12)?,
        recipient: row.get(13)?,
        created_at: row.get(14)?,
        delivered_at: row.get(15)?,
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Backoff for the nth retry: 5s, 10s, 20s, ... capped at five minutes.
fn backoff(step: u32) -> i64 {
    (5_i64 << step.min(6)).min(300)
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// A new route's identity and payload.
pub struct NewRoute<'a> {
    pub project_id: &'a str,
    pub kind: RouteKind,
    pub source_kind: SourceKind,
    pub source_id: &'a str,
    pub target: Target,
    pub channel_id: Option<&'a str>,
    pub thread_id: Option<&'a str>,
    pub body: &'a str,
}

impl Orchestrator {
    pub fn new(
        database: Arc<Database>,
        agents: Arc<AgentStore>,
        channels: Arc<ChannelStore>,
        work: Arc<WorkStore>,
        research: Arc<ResearchStore>,
    ) -> Result<Self, OrchestratorError> {
        ensure_schema(
            &database
                .lock()
                .expect("orchestrator database mutex poisoned"),
        )?;
        Ok(Self {
            database,
            agents,
            channels,
            work,
            research,
            wake: tokio::sync::Notify::new(),
        })
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.database
            .lock()
            .expect("orchestrator database mutex poisoned")
    }

    /// Asks the background loop to run now (a message with an intent was saved).
    pub fn wake(&self) {
        self.wake.notify_one();
    }

    pub async fn woken(&self) {
        self.wake.notified().await;
    }

    // -- Routes ------------------------------------------------------------------------------------

    /// Records a route. The same (source, target) is the same route: a repeat
    /// returns the stored one with `created = false`.
    pub fn create_route(&self, new: NewRoute<'_>) -> Result<(Route, bool), OrchestratorError> {
        if new.body.trim().is_empty() {
            return Err(OrchestratorError::Invalid("a route needs a body"));
        }
        let (target_kind, target_ref) = match &new.target {
            Target::Coordinator { round_id } => ("coordinator", round_id.as_str()),
            Target::Session { session_id } => ("session", session_id.as_str()),
        };
        let key = new.target.key();
        let id = Uuid::new_v4().to_string();
        let connection = self.connection();
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO message_routes
               (id, project_id, kind, source_kind, source_id, target_kind, target_key, target_ref,
                channel_id, thread_id, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                new.project_id,
                new.kind.as_str(),
                new.source_kind.as_str(),
                new.source_id,
                target_kind,
                key,
                target_ref,
                new.channel_id,
                new.thread_id,
                clip(new.body, MAX_BODY_CHARS),
            ],
        )?;
        let route = connection.query_row(
            &format!(
                "{ROUTE_SELECT} WHERE source_kind = ?1 AND source_id = ?2 AND target_key = ?3
                 AND project_id = ?4"
            ),
            params![new.source_kind.as_str(), new.source_id, key, new.project_id],
            route_from_row,
        )?;
        Ok((route, inserted > 0))
    }

    pub fn route(&self, project_id: &str, route_id: &str) -> Result<Route, OrchestratorError> {
        self.connection()
            .query_row(
                &format!("{ROUTE_SELECT} WHERE id = ?1 AND project_id = ?2"),
                params![route_id, project_id],
                route_from_row,
            )
            .optional()?
            .ok_or(OrchestratorError::NotFound)
    }

    /// A Project's routes, newest first.
    pub fn routes(
        &self,
        project_id: &str,
        state: Option<RouteState>,
        limit: usize,
    ) -> Result<Vec<Route>, OrchestratorError> {
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "{ROUTE_SELECT} WHERE project_id = ?1 AND (?2 IS NULL OR state = ?2)
             ORDER BY created_at DESC, id LIMIT ?3"
        ))?;
        Ok(statement
            .query_map(
                params![
                    project_id,
                    state.map(RouteState::as_str),
                    limit.clamp(1, 200) as i64
                ],
                route_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?)
    }

    // -- Routing intents -----------------------------------------------------------------------------

    /// Routes every unclaimed intent of the conversation. Routes are written
    /// first and the claim last, so a crash in between is repaired by the next
    /// pass (the routes already exist; only the claim is repeated).
    pub fn route_intents(&self) -> Result<RoutingReport, OrchestratorError> {
        let mut report = RoutingReport::default();
        for message in self.channels.all_unclaimed_intents(BATCH)? {
            match message.intent {
                Intent::Ask => {
                    for mention in &message.mentions {
                        self.create_route(NewRoute {
                            project_id: &message.project_id,
                            kind: RouteKind::Ask,
                            source_kind: SourceKind::Message,
                            source_id: &message.id,
                            target: Target::Session {
                                session_id: mention.session_id.clone(),
                            },
                            channel_id: Some(&message.channel_id),
                            thread_id: message.thread_id.as_deref(),
                            body: &self.frame_ask(&message),
                        })?;
                    }
                    self.claim(&message)?;
                    report.routed += 1;
                }
                Intent::Request => match self.admitted_round(&message)? {
                    Some(round_id) => {
                        self.create_route(NewRoute {
                            project_id: &message.project_id,
                            kind: RouteKind::Request,
                            source_kind: SourceKind::Message,
                            source_id: &message.id,
                            target: Target::Coordinator { round_id },
                            channel_id: Some(&message.channel_id),
                            thread_id: message.thread_id.as_deref(),
                            body: &self.frame_request(&message),
                        })?;
                        self.claim(&message)?;
                        report.routed += 1;
                    }
                    None => {
                        self.note(
                            &message.project_id,
                            &message.channel_id,
                            message.thread_id.as_deref(),
                            &format!("route-denied:{}", message.id),
                            "This request was not passed on: there is no approved round to carry \
                             it out. Start a round from the research question, then ask again. \
                             Messages never authorize work or widen a budget.",
                        )?;
                        self.claim(&message)?;
                        report.denied += 1;
                    }
                },
                Intent::Say => {}
            }
        }
        Ok(report)
    }

    fn claim(&self, message: &Message) -> Result<(), OrchestratorError> {
        match self
            .channels
            .claim_intent(&message.project_id, &message.id, ORCHESTRATOR)?
        {
            Claim::Claimed(_) | Claim::AlreadyClaimed { .. } => Ok(()),
        }
    }

    /// The round a request may be carried out in: the Thread's round, else the
    /// newest round of its question, else one the message cites. The round
    /// must have a Session to coordinate it and an open question. A
    /// coordinator is seated from the round's own Session if none is yet.
    fn admitted_round(&self, message: &Message) -> Result<Option<String>, OrchestratorError> {
        let project_id = message.project_id.as_str();
        let thread = match &message.thread_id {
            Some(id) => Some(self.channels.thread(project_id, id)?),
            None => None,
        };
        let mut research_id = thread.as_ref().and_then(|t| t.research_id.clone());
        let mut round_id = thread.as_ref().and_then(|t| t.round_id.clone());
        for reference in &message.references {
            match reference.kind {
                crate::project_context::ContextKind::Round if round_id.is_none() => {
                    round_id = Some(reference.id.clone());
                }
                crate::project_context::ContextKind::Research if research_id.is_none() => {
                    research_id = Some(reference.id.clone());
                }
                _ => {}
            }
        }
        let round = match (round_id, research_id) {
            (Some(round_id), _) => self.research.round_by_id(project_id, &round_id).ok(),
            (None, Some(research_id)) => self
                .research
                .rounds(project_id, &research_id)?
                .into_iter()
                .rev()
                .find(|round| round.session_id.is_some()),
            (None, None) => None,
        };
        let Some(round) = round else {
            return Ok(None);
        };
        let Ok(question) = self.research.get(project_id, &round.research_id) else {
            return Ok(None);
        };
        if question.archived || question.status != crate::research_store::ResearchStatus::Open {
            return Ok(None);
        }
        let Some(session_id) = round.session_id.as_deref() else {
            return Ok(None);
        };
        if self.work.coordinator(project_id, &round.id)?.is_none() {
            // The round's own Session coordinates until a handoff says otherwise.
            self.work
                .assume_coordinator(project_id, &round.id, session_id, &Actor::Researcher)?;
        }
        Ok(Some(round.id))
    }

    fn frame_request(&self, message: &Message) -> String {
        let (_, thread_hint) = self.thread_hint(message);
        format!(
            "The researcher asked for work to be organized in the Workspace conversation{thread_hint}:\n\n{}\n\n\
             You coordinate this round. Decide whether one executor or several are needed, then \
             use the kubecode-work tools to create tasks, assign Sessions, and start attempts \
             within the round's limits (work_policy shows them; you cannot widen them). Read the \
             discussion with kubecode-context. Report material results back with work_post.",
            clip(&message.body, 4_000)
        )
    }

    fn frame_ask(&self, message: &Message) -> String {
        let (_, thread_hint) = self.thread_hint(message);
        format!(
            "The researcher asked you a question in the Workspace conversation{thread_hint}:\n\n{}\n\n\
             Answer with work_post so the answer lands in the same conversation. This question \
             does not authorize starting work.",
            clip(&message.body, 4_000)
        )
    }

    /// `(thread id, " (Thread <id>)")` for a message that belongs to a Thread.
    fn thread_hint(&self, message: &Message) -> (Option<String>, String) {
        match &message.thread_id {
            Some(id) => (Some(id.clone()), format!(" (Thread {id})")),
            None => (None, String::new()),
        }
    }

    /// Posts a system note once per `key` into a Thread or channel.
    fn note(
        &self,
        project_id: &str,
        channel_id: &str,
        thread_id: Option<&str>,
        key: &str,
        text: &str,
    ) -> Result<(), OrchestratorError> {
        self.channels.post(
            project_id,
            channel_id,
            NewMessage {
                thread_id,
                body: text,
                author_kind: Some(AuthorKind::System),
                client_message_id: Some(key),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    // -- Dispatch and results ----------------------------------------------------------------------

    /// Tells an executor that an attempt was started for it. One route per
    /// attempt, however often the coordinator's command is replayed.
    pub fn route_dispatch(
        &self,
        project_id: &str,
        item: &WorkItem,
        attempt_id: &str,
        executor: &str,
    ) -> Result<Route, OrchestratorError> {
        let origin = self.origin_of(project_id, item)?;
        let body = format!(
            "You were assigned a task in a research round.\n\nTask {}: {}\n\n{}\n\n{}\n\
             Attempt {attempt_id}. Do the work, attach evidence with work_attach, and report with \
             work_report. Ask the coordinator through work_post if you are blocked.",
            item.id,
            item.title,
            clip(&item.description, 3_000),
            item.plan
                .as_deref()
                .map(|plan| format!("Plan:\n{}\n", clip(plan, 3_000)))
                .unwrap_or_default(),
        );
        let (route, _) = self.create_route(NewRoute {
            project_id,
            kind: RouteKind::Dispatch,
            source_kind: SourceKind::Attempt,
            source_id: attempt_id,
            target: Target::Session {
                session_id: executor.to_owned(),
            },
            channel_id: origin.as_ref().map(|(channel, _)| channel.as_str()),
            thread_id: origin.as_ref().and_then(|(_, thread)| thread.as_deref()),
            body: &body,
        })?;
        self.wake();
        Ok(route)
    }

    /// Tells the coordinator an attempt reported, and says so in the Thread the
    /// work came from. Receipt of this event is not acceptance: the coordinator
    /// still reviews through the work commands.
    pub fn route_result(
        &self,
        project_id: &str,
        item: &WorkItem,
        attempt_id: &str,
        summary: &str,
    ) -> Result<Option<Route>, OrchestratorError> {
        let origin = self.origin_of(project_id, item)?;
        if let Some((channel_id, thread_id)) = &origin {
            self.note(
                project_id,
                channel_id,
                thread_id.as_deref(),
                &format!("result:{attempt_id}"),
                &format!("Task \"{}\" reported: {}", item.title, clip(summary, 1_500)),
            )?;
        }
        let Some(round_id) = item.round_id.clone() else {
            return Ok(None);
        };
        let body = format!(
            "An executor reported on task {} ({}): {}\n\nReview it with work_review when you are \
             satisfied, or start another attempt.",
            item.id,
            item.title,
            clip(summary, 3_000)
        );
        let (route, _) = self.create_route(NewRoute {
            project_id,
            kind: RouteKind::Result,
            source_kind: SourceKind::Attempt,
            source_id: attempt_id,
            target: Target::Coordinator { round_id },
            channel_id: origin.as_ref().map(|(channel, _)| channel.as_str()),
            thread_id: origin.as_ref().and_then(|(_, thread)| thread.as_deref()),
            body: &body,
        })?;
        self.wake();
        Ok(Some(route))
    }

    /// `(channel id, thread id)` of the conversation a work item came from.
    pub fn origin_of(
        &self,
        project_id: &str,
        item: &WorkItem,
    ) -> Result<Option<(String, Option<String>)>, OrchestratorError> {
        let Some((kind, id)) = item
            .derived_from
            .as_ref()
            .map(|d| (d.kind.as_str(), d.id.as_str()))
        else {
            return Ok(None);
        };
        Ok(match kind {
            "thread" => self
                .channels
                .thread(project_id, id)
                .ok()
                .map(|thread| (thread.channel_id, Some(thread.id))),
            "message" => self
                .channels
                .message(project_id, id)
                .ok()
                .map(|message| (message.channel_id, message.thread_id)),
            _ => None,
        })
    }

    // -- Delivery -------------------------------------------------------------------------------------

    /// Delivers every due route once. Safe to run concurrently and after a
    /// crash: a route is leased before it is tried, and the delivery key
    /// de-duplicates a repeat at the Session.
    pub fn deliver_due(
        &self,
        sink: &dyn RouteSink,
        now: i64,
    ) -> Result<DeliveryReport, OrchestratorError> {
        let due: Vec<String> = {
            let connection = self.connection();
            let mut statement = connection.prepare(
                "SELECT id FROM message_routes
                 WHERE state = 'pending' AND next_attempt_at <= ?1 AND lease_until <= ?1
                 ORDER BY created_at, id LIMIT ?2",
            )?;
            statement
                .query_map(params![now, BATCH as i64], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut report = DeliveryReport::default();
        for id in due {
            // The lease is one conditional write: a second worker loses it.
            let leased = self.connection().execute(
                "UPDATE message_routes SET lease_until = ?2
                 WHERE id = ?1 AND state = 'pending' AND next_attempt_at <= ?3 AND lease_until <= ?3",
                params![id, now + LEASE_SECS, now],
            )?;
            if leased == 0 {
                continue;
            }
            let route = {
                let connection = self.connection();
                connection.query_row(
                    &format!("{ROUTE_SELECT} WHERE id = ?1"),
                    [&id],
                    route_from_row,
                )?
            };
            let outcome = match self.recipient(&route) {
                Ok(recipient) => {
                    let outcome = sink.deliver(&DeliveryRequest {
                        project_id: &route.project_id,
                        conversation_id: &recipient,
                        delivery_key: &route.id,
                        body: &route.body,
                    });
                    (Some(recipient), outcome)
                }
                Err(reason) => (None, DeliveryOutcome::Failed(reason)),
            };
            self.settle(&route, outcome.0.as_deref(), outcome.1, now, &mut report)?;
        }
        Ok(report)
    }

    /// The Session a route is for *now*. A coordinator route follows the
    /// round's current holder, so a handoff retargets what was pending.
    fn recipient(&self, route: &Route) -> Result<String, String> {
        match &route.target {
            Target::Coordinator { round_id } => self
                .work
                .coordinator(&route.project_id, round_id)
                .map_err(|error| error.to_string())?
                .map(|coordinator| coordinator.holder)
                .ok_or_else(|| "the round has no coordinator".to_owned()),
            Target::Session { session_id } => {
                match self
                    .agents
                    .visible_conversation(&route.project_id, session_id)
                {
                    Ok(Some(_)) => Ok(session_id.clone()),
                    Ok(None) => Err("the Session no longer exists".to_owned()),
                    Err(error) => Err(error.to_string()),
                }
            }
        }
    }

    fn settle(
        &self,
        route: &Route,
        recipient: Option<&str>,
        outcome: DeliveryOutcome,
        now: i64,
        report: &mut DeliveryReport,
    ) -> Result<(), OrchestratorError> {
        match outcome {
            DeliveryOutcome::Delivered => {
                self.connection().execute(
                    "UPDATE message_routes SET state = 'delivered', recipient = ?2,
                       delivered_at = CURRENT_TIMESTAMP, lease_until = 0, last_error = NULL
                     WHERE id = ?1",
                    params![route.id, recipient],
                )?;
                report.delivered += 1;
                if route.kind == RouteKind::Request {
                    self.notify(
                        route,
                        &format!("route-delivered:{}", route.id),
                        "The request was passed to the round's coordinator.",
                    )?;
                }
            }
            DeliveryOutcome::Busy => {
                let busy = route.busy + 1;
                if busy > MAX_BUSY {
                    self.fail(route, "the Session stayed busy", report)?;
                } else {
                    self.connection().execute(
                        "UPDATE message_routes SET busy = ?2, next_attempt_at = ?3, lease_until = 0
                         WHERE id = ?1",
                        params![route.id, busy, now + backoff(busy)],
                    )?;
                    report.retried += 1;
                }
            }
            DeliveryOutcome::Failed(reason) => {
                let attempts = route.attempts + 1;
                if attempts >= MAX_ATTEMPTS {
                    self.fail(route, &reason, report)?;
                } else {
                    self.connection().execute(
                        "UPDATE message_routes SET attempts = ?2, last_error = ?3,
                           next_attempt_at = ?4, lease_until = 0 WHERE id = ?1",
                        params![
                            route.id,
                            attempts,
                            clip(&reason, 500),
                            now + backoff(attempts)
                        ],
                    )?;
                    report.retried += 1;
                }
            }
        }
        Ok(())
    }

    fn fail(
        &self,
        route: &Route,
        reason: &str,
        report: &mut DeliveryReport,
    ) -> Result<(), OrchestratorError> {
        self.connection().execute(
            "UPDATE message_routes SET state = 'failed', attempts = attempts + 1, last_error = ?2,
               lease_until = 0 WHERE id = ?1",
            params![route.id, clip(reason, 500)],
        )?;
        report.failed += 1;
        self.notify(
            route,
            &format!("route-failed:{}", route.id),
            &format!("This could not be delivered: {}.", clip(reason, 200)),
        )
    }

    /// A system note in the conversation the route came from, if it has one.
    fn notify(&self, route: &Route, key: &str, text: &str) -> Result<(), OrchestratorError> {
        let channel_id: Option<String> = self.connection().query_row(
            "SELECT channel_id FROM message_routes WHERE id = ?1",
            [&route.id],
            |row| row.get(0),
        )?;
        if let Some(channel_id) = channel_id {
            self.note(
                &route.project_id,
                &channel_id,
                route.thread_id.as_deref(),
                key,
                text,
            )?;
        }
        Ok(())
    }

    /// One orchestration pass: route new intents, then deliver what is due.
    pub fn tick(
        &self,
        sink: &dyn RouteSink,
    ) -> Result<(RoutingReport, DeliveryReport), OrchestratorError> {
        let routed = self.route_intents()?;
        let delivered = self.deliver_due(sink, now_secs())?;
        Ok((routed, delivered))
    }
}
