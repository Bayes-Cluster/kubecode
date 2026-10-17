//! Project-scoped research questions (ADR 0212): the durable home for a
//! research brief and its immutable revisions, the attributed entry log, and
//! associations to Sessions and Teams. The store shares the Runtime's single
//! SQLite owner (ADR 0200) and commits every `research_updated` workspace
//! event in the same transaction as the change it announces (ADR 0205), so a
//! browser that reloads or reconnects converges by refetching.
//!
//! Nothing here starts an Agent: saving, editing, discussing, or linking is
//! pure persistence. Every lookup is scoped by Project id, so a research
//! question in another Project is indistinguishable from a missing one.

mod models;

pub use models::*;

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::json;
use uuid::Uuid;

use crate::agent_store::AgentStore;
use crate::database::Database;

pub struct ResearchStore {
    database: Arc<Database>,
    agents: Arc<AgentStore>,
}

/// What changed, for the content-free `research_updated` event payload.
#[derive(Clone, Copy, Debug)]
enum Change {
    Created,
    Brief,
    Status,
    Archived,
    Restored,
    Entry,
    Link,
    Unlink,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Brief => "brief",
            Self::Status => "status",
            Self::Archived => "archived",
            Self::Restored => "restored",
            Self::Entry => "entry",
            Self::Link => "link",
            Self::Unlink => "unlink",
        }
    }
}

impl ResearchStore {
    pub fn from_database(
        database: Arc<Database>,
        agents: Arc<AgentStore>,
    ) -> Result<Self, ResearchError> {
        {
            let connection = database.lock().expect("research database mutex poisoned");
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS research_questions (
                   id                TEXT PRIMARY KEY,
                   project_id        TEXT NOT NULL,
                   client_request_id TEXT,
                   status            TEXT NOT NULL DEFAULT 'open',
                   archived          INTEGER NOT NULL DEFAULT 0,
                   revision          INTEGER NOT NULL DEFAULT 1,
                   title             TEXT NOT NULL,
                   brief_json        TEXT NOT NULL,
                   resolved_at       TEXT,
                   created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 CREATE INDEX IF NOT EXISTS research_questions_project
                   ON research_questions(project_id, archived, updated_at);
                 CREATE UNIQUE INDEX IF NOT EXISTS research_questions_request
                   ON research_questions(project_id, client_request_id)
                   WHERE client_request_id IS NOT NULL;
                 -- Immutable: revisions are never updated or pruned, because
                 -- rounds and findings cite them by number (ADR 0212 §2).
                 CREATE TABLE IF NOT EXISTS research_brief_revisions (
                   research_id TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   revision    INTEGER NOT NULL,
                   brief_json  TEXT NOT NULL,
                   author_kind TEXT NOT NULL,
                   author_ref  TEXT,
                   note        TEXT,
                   created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   PRIMARY KEY (research_id, revision)
                 );
                 -- Append-only, per-RQ sequenced log of attributed entries.
                 CREATE TABLE IF NOT EXISTS research_entries (
                   id                TEXT PRIMARY KEY,
                   research_id       TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   seq               INTEGER NOT NULL,
                   kind              TEXT NOT NULL,
                   author_kind       TEXT NOT NULL,
                   author_ref        TEXT,
                   body              TEXT NOT NULL,
                   brief_revision    INTEGER NOT NULL,
                   client_request_id TEXT,
                   created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   UNIQUE (research_id, seq)
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS research_entries_request
                   ON research_entries(research_id, client_request_id)
                   WHERE client_request_id IS NOT NULL;
                 -- A Session or Team is linked to at most one RQ.
                 CREATE TABLE IF NOT EXISTS research_links (
                   research_id TEXT NOT NULL REFERENCES research_questions(id) ON DELETE CASCADE,
                   kind        TEXT NOT NULL,
                   ref_id      TEXT NOT NULL,
                   role        TEXT NOT NULL,
                   created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                   PRIMARY KEY (research_id, kind, ref_id),
                   UNIQUE (kind, ref_id)
                 );",
            )?;
        }
        Ok(Self { database, agents })
    }

    // -- Questions -----------------------------------------------------------

    /// Creates a question with revision 1. A repeated `client_request_id` in
    /// the same Project returns the original and reports `created = false`.
    pub fn create(
        &self,
        project_id: &str,
        brief: ResearchBrief,
        client_request_id: Option<&str>,
    ) -> Result<(ResearchQuestion, bool), ResearchError> {
        let brief = brief.normalized()?;
        let request_id = normalize_client_request_id(client_request_id)?;
        self.write(|tx| {
            if let Some(request_id) = &request_id
                && let Some(existing) = tx
                    .query_row(
                        "SELECT id FROM research_questions
                         WHERE project_id = ?1 AND client_request_id = ?2",
                        params![project_id, request_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
            {
                return Ok(((load_question(tx, project_id, &existing)?, false), None));
            }
            let id = Uuid::new_v4().to_string();
            let brief_json = serde_json::to_string(&brief)?;
            tx.execute(
                "INSERT INTO research_questions
                   (id, project_id, client_request_id, title, brief_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, project_id, request_id, brief.title, brief_json],
            )?;
            tx.execute(
                "INSERT INTO research_brief_revisions
                   (research_id, revision, brief_json, author_kind)
                 VALUES (?1, 1, ?2, 'researcher')",
                params![id, brief_json],
            )?;
            let question = load_question(tx, project_id, &id)?;
            Ok((
                (question, true),
                Some((project_id.to_owned(), id, Change::Created)),
            ))
        })
    }

    pub fn get(&self, project_id: &str, id: &str) -> Result<ResearchQuestion, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)
    }

    pub fn list(
        &self,
        project_id: &str,
        include_archived: bool,
    ) -> Result<Vec<ResearchSummary>, ResearchError> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT q.id, q.project_id, q.title, q.status, q.archived, q.revision,
                    (SELECT COUNT(*) FROM research_entries e WHERE e.research_id = q.id),
                    (SELECT COUNT(*) FROM research_links l WHERE l.research_id = q.id),
                    q.updated_at
             FROM research_questions q
             WHERE q.project_id = ?1 AND (?2 OR q.archived = 0)
             ORDER BY q.archived, q.updated_at DESC, q.id",
        )?;
        let rows = statement.query_map(params![project_id, include_archived], |row| {
            let status: String = row.get(3)?;
            Ok(ResearchSummary {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                status: ResearchStatus::parse(&status).unwrap_or(ResearchStatus::Open),
                archived: row.get::<_, i64>(4)? != 0,
                revision: row.get::<_, i64>(5)? as u64,
                entry_count: row.get::<_, i64>(6)? as u64,
                link_count: row.get::<_, i64>(7)? as u64,
                updated_at: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Applies a brief edit under optimistic concurrency. Returns the
    /// question and whether a new revision was written; an edit that changes
    /// nothing writes nothing.
    pub fn update_brief(
        &self,
        project_id: &str,
        id: &str,
        expected_revision: u64,
        patch: &BriefPatch,
        note: Option<&str>,
    ) -> Result<(ResearchQuestion, bool), ResearchError> {
        let note = note
            .map(str::trim)
            .filter(|note| !note.is_empty())
            .map(str::to_owned);
        if note
            .as_deref()
            .is_some_and(|note| note.chars().count() > MAX_NOTE_CHARS)
        {
            return Err(ResearchError::Invalid("the revision note is too long"));
        }
        self.write(|tx| {
            let current = load_question(tx, project_id, id)?;
            if current.archived {
                return Err(ResearchError::Archived);
            }
            if current.revision != expected_revision {
                return Err(ResearchError::RevisionConflict {
                    current: current.revision,
                });
            }
            let next = current.brief.patched(patch)?;
            if next == current.brief {
                return Ok(((current, false), None));
            }
            let brief_json = serde_json::to_string(&next)?;
            let revision = current.revision + 1;
            tx.execute(
                "UPDATE research_questions
                 SET revision = ?2, title = ?3, brief_json = ?4, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, revision as i64, next.title, brief_json],
            )?;
            tx.execute(
                "INSERT INTO research_brief_revisions
                   (research_id, revision, brief_json, author_kind, note)
                 VALUES (?1, ?2, ?3, 'researcher', ?4)",
                params![id, revision as i64, brief_json, note],
            )?;
            let question = load_question(tx, project_id, id)?;
            Ok((
                (question, true),
                Some((project_id.to_owned(), id.to_owned(), Change::Brief)),
            ))
        })
    }

    /// Idempotent: archiving an archived question (or restoring a live one)
    /// succeeds without effect and publishes nothing.
    pub fn set_archived(
        &self,
        project_id: &str,
        id: &str,
        archived: bool,
    ) -> Result<ResearchQuestion, ResearchError> {
        self.write(|tx| {
            let current = load_question(tx, project_id, id)?;
            if current.archived == archived {
                return Ok((current, None));
            }
            tx.execute(
                "UPDATE research_questions
                 SET archived = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![id, archived],
            )?;
            let change = if archived {
                Change::Archived
            } else {
                Change::Restored
            };
            Ok((
                load_question(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), change)),
            ))
        })
    }

    /// Idempotent researcher decision; never a side effect of Team
    /// completion (ADR 0212 §1).
    pub fn set_status(
        &self,
        project_id: &str,
        id: &str,
        status: ResearchStatus,
    ) -> Result<ResearchQuestion, ResearchError> {
        self.write(|tx| {
            let current = load_question(tx, project_id, id)?;
            if current.archived {
                return Err(ResearchError::Archived);
            }
            if current.status == status {
                return Ok((current, None));
            }
            tx.execute(
                "UPDATE research_questions
                 SET status = ?2,
                     resolved_at = CASE WHEN ?2 = 'resolved' THEN CURRENT_TIMESTAMP ELSE NULL END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, status.as_str()],
            )?;
            Ok((
                load_question(tx, project_id, id)?,
                Some((project_id.to_owned(), id.to_owned(), Change::Status)),
            ))
        })
    }

    // -- Revisions -----------------------------------------------------------

    pub fn revisions(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Vec<RevisionSummary>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let mut statement = connection.prepare(
            "SELECT revision, brief_json, author_kind, note, created_at
             FROM research_brief_revisions WHERE research_id = ?1 ORDER BY revision DESC",
        )?;
        let rows = statement.query_map([id], |row| {
            let brief_json: String = row.get(1)?;
            let author: String = row.get(2)?;
            Ok((
                row.get::<_, i64>(0)?,
                brief_json,
                author,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut summaries = Vec::new();
        for row in rows {
            let (revision, brief_json, author, note, created_at) = row?;
            let brief: ResearchBrief = serde_json::from_str(&brief_json)?;
            summaries.push(RevisionSummary {
                revision: revision as u64,
                title: brief.title,
                author_kind: AuthorKind::parse(&author).unwrap_or(AuthorKind::Researcher),
                note,
                created_at,
            });
        }
        Ok(summaries)
    }

    pub fn revision(
        &self,
        project_id: &str,
        id: &str,
        revision: u64,
    ) -> Result<BriefRevision, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        load_revision(&connection, id, revision)
    }

    // -- Entries -------------------------------------------------------------

    /// Appends an entry. A repeated `client_request_id` returns the original.
    /// Callers decide which kinds and authors are permitted; the browser API
    /// only passes researcher `note` / `decision` entries.
    pub fn add_entry(
        &self,
        project_id: &str,
        id: &str,
        entry: NewEntry,
    ) -> Result<ResearchEntry, ResearchError> {
        let body = entry.body.trim().to_owned();
        if body.is_empty() {
            return Err(ResearchError::Invalid("an entry body is required"));
        }
        if body.chars().count() > MAX_ENTRY_CHARS {
            return Err(ResearchError::Invalid("the entry is too long"));
        }
        let request_id = normalize_client_request_id(entry.client_request_id.as_deref())?;
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            if question.archived {
                return Err(ResearchError::Archived);
            }
            if let Some(request_id) = &request_id
                && let Some(existing) = tx
                    .query_row(
                        &format!(
                            "{ENTRY_SELECT} WHERE research_id = ?1 AND client_request_id = ?2"
                        ),
                        params![id, request_id],
                        entry_from_row,
                    )
                    .optional()?
            {
                return Ok((existing, None));
            }
            let seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM research_entries WHERE research_id = ?1",
                [id],
                |row| row.get(0),
            )?;
            let entry_id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO research_entries
                   (id, research_id, seq, kind, author_kind, author_ref, body,
                    brief_revision, client_request_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    entry_id,
                    id,
                    seq,
                    entry.kind.as_str(),
                    entry.author_kind.as_str(),
                    entry.author_ref,
                    body,
                    question.revision as i64,
                    request_id,
                ],
            )?;
            tx.execute(
                "UPDATE research_questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id],
            )?;
            let stored = tx.query_row(
                &format!("{ENTRY_SELECT} WHERE id = ?1"),
                [&entry_id],
                entry_from_row,
            )?;
            Ok((
                stored,
                Some((project_id.to_owned(), id.to_owned(), Change::Entry)),
            ))
        })
    }

    /// Entries after `after_seq` in sequence order, at most `limit`
    /// (default 100, maximum 500).
    pub fn entries(
        &self,
        project_id: &str,
        id: &str,
        after_seq: u64,
        limit: Option<usize>,
    ) -> Result<Vec<ResearchEntry>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let limit = limit.unwrap_or(DEFAULT_ENTRY_PAGE).clamp(1, MAX_ENTRY_PAGE);
        let mut statement = connection.prepare(&format!(
            "{ENTRY_SELECT} WHERE research_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3"
        ))?;
        let rows =
            statement.query_map(params![id, after_seq as i64, limit as i64], entry_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    // -- Links ---------------------------------------------------------------

    /// Associates a Session or Team with the question. The caller has
    /// already verified the target exists in the same Project. Idempotent for
    /// the same target; a different role on the same target updates the role;
    /// a target linked to another question is a conflict, never a move.
    pub fn link(
        &self,
        project_id: &str,
        id: &str,
        kind: LinkKind,
        ref_id: &str,
        role: LinkRole,
    ) -> Result<ResearchLink, ResearchError> {
        let ref_id = ref_id.trim();
        if ref_id.is_empty() || ref_id.chars().count() > MAX_CLIENT_REQUEST_ID_CHARS {
            return Err(ResearchError::InvalidLinkTarget);
        }
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            if question.archived {
                return Err(ResearchError::Archived);
            }
            let existing = tx
                .query_row(
                    "SELECT research_id, role FROM research_links WHERE kind = ?1 AND ref_id = ?2",
                    params![kind.as_str(), ref_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let change = match existing {
                Some((owner, _)) if owner != id => {
                    return Err(ResearchError::LinkConflict {
                        kind: kind.as_str(),
                    });
                }
                Some((_, current_role)) if current_role == role.as_str() => None,
                Some(_) => {
                    tx.execute(
                        "UPDATE research_links SET role = ?4
                         WHERE research_id = ?1 AND kind = ?2 AND ref_id = ?3",
                        params![id, kind.as_str(), ref_id, role.as_str()],
                    )?;
                    Some((project_id.to_owned(), id.to_owned(), Change::Link))
                }
                None => {
                    tx.execute(
                        "INSERT INTO research_links (research_id, kind, ref_id, role)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![id, kind.as_str(), ref_id, role.as_str()],
                    )?;
                    Some((project_id.to_owned(), id.to_owned(), Change::Link))
                }
            };
            if change.is_some() {
                tx.execute(
                    "UPDATE research_questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                    [id],
                )?;
            }
            let link = tx.query_row(
                &format!("{LINK_SELECT} WHERE research_id = ?1 AND kind = ?2 AND ref_id = ?3"),
                params![id, kind.as_str(), ref_id],
                link_from_row,
            )?;
            Ok((link, change))
        })
    }

    /// Removes the association only. Allowed on archived questions so a
    /// Session or Team can be released for another question.
    pub fn unlink(
        &self,
        project_id: &str,
        id: &str,
        kind: LinkKind,
        ref_id: &str,
    ) -> Result<bool, ResearchError> {
        self.write(|tx| {
            load_question(tx, project_id, id)?;
            let removed = tx.execute(
                "DELETE FROM research_links WHERE research_id = ?1 AND kind = ?2 AND ref_id = ?3",
                params![id, kind.as_str(), ref_id],
            )?;
            if removed == 0 {
                return Ok((false, None));
            }
            tx.execute(
                "UPDATE research_questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id],
            )?;
            Ok((
                true,
                Some((project_id.to_owned(), id.to_owned(), Change::Unlink)),
            ))
        })
    }

    pub fn links(&self, project_id: &str, id: &str) -> Result<Vec<ResearchLink>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let mut statement = connection.prepare(&format!(
            "{LINK_SELECT} WHERE research_id = ?1 ORDER BY created_at, kind, ref_id"
        ))?;
        let rows = statement.query_map([id], link_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The question (and Project) a Session or Team is linked to, if any.
    pub fn link_for(
        &self,
        kind: LinkKind,
        ref_id: &str,
    ) -> Result<Option<(String, ResearchLink)>, ResearchError> {
        let connection = self.connection();
        let row = connection
            .query_row(
                "SELECT q.project_id, l.research_id, l.kind, l.ref_id, l.role, l.created_at
                 FROM research_links l JOIN research_questions q ON q.id = l.research_id
                 WHERE l.kind = ?1 AND l.ref_id = ?2",
                params![kind.as_str(), ref_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        ResearchLink {
                            research_id: row.get(1)?,
                            kind: LinkKind::parse(&row.get::<_, String>(2)?)
                                .unwrap_or(LinkKind::Session),
                            ref_id: row.get(3)?,
                            role: LinkRole::parse(&row.get::<_, String>(4)?)
                                .unwrap_or(LinkRole::Discussion),
                            created_at: row.get(5)?,
                        },
                    ))
                },
            )
            .optional()?;
        Ok(row)
    }

    // -- Plumbing --------------------------------------------------------------

    fn connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.database
            .lock()
            .expect("research database mutex poisoned")
    }

    /// Runs `operation` in one immediate transaction. When it names a change,
    /// the `research_updated` event commits with it and is published after.
    fn write<T>(
        &self,
        operation: impl FnOnce(
            &Transaction<'_>,
        ) -> Result<(T, Option<(String, String, Change)>), ResearchError>,
    ) -> Result<T, ResearchError> {
        let mut connection = self.connection();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (value, change) = operation(&transaction)?;
        let cursor = match change {
            Some((project_id, research_id, change)) => {
                transaction.execute(
                    "INSERT INTO workspace_events (kind, project_id, payload)
                     VALUES ('research_updated', ?1, ?2)",
                    params![
                        project_id,
                        json!({"research_id": research_id, "change": change.as_str()}).to_string()
                    ],
                )?;
                Some(transaction.last_insert_rowid() as u64)
            }
            None => None,
        };
        transaction.commit()?;
        drop(connection);
        if let Some(cursor) = cursor {
            self.agents.workspace_event_bus().publish_committed(cursor);
        }
        Ok(value)
    }
}

const ENTRY_SELECT: &str = "SELECT id, research_id, seq, kind, author_kind, author_ref, body,
                                   brief_revision, created_at FROM research_entries";
const LINK_SELECT: &str = "SELECT research_id, kind, ref_id, role, created_at FROM research_links";

fn entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResearchEntry> {
    Ok(ResearchEntry {
        id: row.get(0)?,
        research_id: row.get(1)?,
        seq: row.get::<_, i64>(2)? as u64,
        kind: EntryKind::parse(&row.get::<_, String>(3)?).unwrap_or(EntryKind::Note),
        author_kind: AuthorKind::parse(&row.get::<_, String>(4)?).unwrap_or(AuthorKind::Researcher),
        author_ref: row.get(5)?,
        body: row.get(6)?,
        brief_revision: row.get::<_, i64>(7)? as u64,
        created_at: row.get(8)?,
    })
}

fn link_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResearchLink> {
    Ok(ResearchLink {
        research_id: row.get(0)?,
        kind: LinkKind::parse(&row.get::<_, String>(1)?).unwrap_or(LinkKind::Session),
        ref_id: row.get(2)?,
        role: LinkRole::parse(&row.get::<_, String>(3)?).unwrap_or(LinkRole::Discussion),
        created_at: row.get(4)?,
    })
}

fn load_question(
    connection: &Connection,
    project_id: &str,
    id: &str,
) -> Result<ResearchQuestion, ResearchError> {
    let row = connection
        .query_row(
            "SELECT id, project_id, status, archived, revision, brief_json,
                    created_at, updated_at, resolved_at
             FROM research_questions WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .optional()?
        .ok_or(ResearchError::NotFound)?;
    Ok(ResearchQuestion {
        id: row.0,
        project_id: row.1,
        status: ResearchStatus::parse(&row.2).unwrap_or(ResearchStatus::Open),
        archived: row.3 != 0,
        revision: row.4 as u64,
        brief: serde_json::from_str(&row.5)?,
        created_at: row.6,
        updated_at: row.7,
        resolved_at: row.8,
    })
}

fn load_revision(
    connection: &Connection,
    research_id: &str,
    revision: u64,
) -> Result<BriefRevision, ResearchError> {
    let row = connection
        .query_row(
            "SELECT brief_json, author_kind, author_ref, note, created_at
             FROM research_brief_revisions WHERE research_id = ?1 AND revision = ?2",
            params![research_id, revision as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or(ResearchError::RevisionNotFound(revision))?;
    Ok(BriefRevision {
        research_id: research_id.to_owned(),
        revision,
        brief: serde_json::from_str(&row.0)?,
        author_kind: AuthorKind::parse(&row.1).unwrap_or(AuthorKind::Researcher),
        author_ref: row.2,
        note: row.3,
        created_at: row.4,
    })
}
