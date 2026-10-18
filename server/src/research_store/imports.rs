//! Imported discussion (ADR 0214 §8). Text a researcher brainstormed outside
//! Kubecode is kept as attributed, immutable *source material* for one research
//! question: it is not a finding, it never edits the brief, and importing it
//! starts nothing. Its identity is the import id plus the digest of the exact
//! normalized text, so a later reference can tell whether it is the same words.
//! Candidate questions, decisions, constraints and the like are derived from the
//! stored text on demand; nothing is persisted twice.

use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::models::*;
use super::{Change, ResearchStore, load_question};

pub const MAX_IMPORT_BYTES: usize = 64 * 1024;
pub const MAX_IMPORT_LABEL_CHARS: usize = 200;
pub const MAX_IMPORTS_PER_QUESTION: usize = 50;
pub const MAX_IMPORT_CANDIDATES: usize = 100;

/// An imported discussion without its text.
#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct ResearchImport {
    pub id: String,
    pub research_id: String,
    pub origin: ImportOrigin,
    /// Where the researcher says it came from (a chat title, a document name).
    pub label: String,
    /// The brief revision the discussion was about, as the researcher stated it.
    pub based_on_revision: u64,
    /// SHA-256 of the normalized text: the import's revision.
    pub digest: String,
    pub byte_count: usize,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct NewImport<'a> {
    pub origin: ImportOrigin,
    pub label: &'a str,
    pub content: &'a str,
    pub based_on_revision: u64,
    pub client_request_id: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, Eq, Hash, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateKind {
    Question,
    Hypothesis,
    Decision,
    Constraint,
    EvaluationCriterion,
    OpenQuestion,
}

/// Something in the text that looks like a question, decision, constraint, ...
/// It is a suggestion for the researcher to review, never an approved change.
#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct ImportCandidate {
    pub kind: CandidateKind,
    pub text: String,
    /// 1-based line in the imported text.
    pub line: usize,
}

/// Line endings normalized, NULs removed, outer whitespace trimmed.
pub fn normalize_import_text(content: &str) -> String {
    content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\0', "")
        .trim()
        .to_owned()
}

pub fn import_digest(normalized: &str) -> String {
    hex::encode(Sha256::digest(normalized.as_bytes()))
}

fn section_kind(heading: &str) -> Option<CandidateKind> {
    let heading = heading.to_lowercase();
    if heading.contains("open question") || heading.contains("unresolved") {
        Some(CandidateKind::OpenQuestion)
    } else if heading.contains("question") {
        Some(CandidateKind::Question)
    } else if heading.contains("decision") || heading.contains("decided") {
        Some(CandidateKind::Decision)
    } else if heading.contains("constraint") || heading.contains("requirement") {
        Some(CandidateKind::Constraint)
    } else if heading.contains("hypothes") {
        Some(CandidateKind::Hypothesis)
    } else if heading.contains("evaluation")
        || heading.contains("criteria")
        || heading.contains("metric")
    {
        Some(CandidateKind::EvaluationCriterion)
    } else {
        None
    }
}

fn prefixed_kind(line: &str) -> Option<(CandidateKind, &str)> {
    let lower = line.to_lowercase();
    for (prefix, kind) in [
        ("open question:", CandidateKind::OpenQuestion),
        ("question:", CandidateKind::Question),
        ("decision:", CandidateKind::Decision),
        ("decided:", CandidateKind::Decision),
        ("constraint:", CandidateKind::Constraint),
        ("hypothesis:", CandidateKind::Hypothesis),
        ("evaluation:", CandidateKind::EvaluationCriterion),
        ("metric:", CandidateKind::EvaluationCriterion),
    ] {
        if lower.starts_with(prefix) {
            return Some((kind, line[prefix.len()..].trim()));
        }
    }
    None
}

fn list_item(line: &str) -> Option<&str> {
    let line = line.trim_start();
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return Some(rest.trim());
        }
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && digits <= 3 {
        let rest = &line[digits..];
        for marker in [". ", ") "] {
            if let Some(rest) = rest.strip_prefix(marker) {
                return Some(rest.trim());
            }
        }
    }
    None
}

fn heading_text(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes > 0 && hashes <= 6 && trimmed[hashes..].starts_with(' ') {
        return Some(
            trimmed[hashes..]
                .trim()
                .trim_end_matches('#')
                .trim()
                .to_owned(),
        );
    }
    // `**Decisions**` or `Decisions:` on a line of its own.
    let bare = trimmed.trim_matches('*').trim();
    if let Some(label) = bare.strip_suffix(':')
        && !label.is_empty()
        && label.chars().count() <= 60
        && section_kind(label).is_some()
    {
        return Some(label.to_owned());
    }
    None
}

fn clean_candidate(text: &str) -> Option<String> {
    let text = text.trim().trim_matches('*').trim();
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() < 4 {
        return None;
    }
    Some(flat.chars().take(MAX_ITEM_CHARS).collect())
}

/// Deterministic, text-only extraction: headings and labels that name a kind,
/// list items beneath them, `Kind: text` lines, and standalone questions.
pub fn extract_candidates(content: &str) -> Vec<ImportCandidate> {
    let mut candidates: Vec<ImportCandidate> = Vec::new();
    let mut section: Option<CandidateKind> = None;
    let push = |kind: CandidateKind, text: &str, line: usize, out: &mut Vec<ImportCandidate>| {
        if out.len() >= MAX_IMPORT_CANDIDATES {
            return;
        }
        let Some(text) = clean_candidate(text) else {
            return;
        };
        if out
            .iter()
            .any(|existing| existing.kind == kind && existing.text == text)
        {
            return;
        }
        out.push(ImportCandidate { kind, text, line });
    };
    for (index, raw) in content.lines().enumerate() {
        let line = index + 1;
        if raw.trim().is_empty() {
            continue;
        }
        if let Some(heading) = heading_text(raw) {
            section = section_kind(&heading);
            continue;
        }
        if let Some(item) = list_item(raw) {
            if let Some((kind, rest)) = prefixed_kind(item) {
                push(kind, rest, line, &mut candidates);
            } else if let Some(kind) = section {
                push(kind, item, line, &mut candidates);
            } else if item.ends_with('?') {
                push(CandidateKind::Question, item, line, &mut candidates);
            }
            continue;
        }
        let text = raw.trim();
        if let Some((kind, rest)) = prefixed_kind(text) {
            push(kind, rest, line, &mut candidates);
        } else if text.ends_with('?') && text.chars().count() <= 300 {
            // A question stays a question even under another section's heading.
            let kind = match section {
                Some(CandidateKind::OpenQuestion) => CandidateKind::OpenQuestion,
                _ => CandidateKind::Question,
            };
            push(kind, text, line, &mut candidates);
        }
    }
    candidates
}

impl ResearchStore {
    /// Stores a discussion as source material. Repeating a `client_request_id`
    /// returns the original (`created = false`). Importing changes no brief
    /// and starts no Agent; it only publishes a `research_updated` event.
    pub fn import_source(
        &self,
        project_id: &str,
        id: &str,
        new: NewImport<'_>,
    ) -> Result<(ResearchImport, bool), ResearchError> {
        let content = normalize_import_text(new.content);
        if content.is_empty() {
            return Err(ResearchError::Invalid("the imported text is empty"));
        }
        if content.len() > MAX_IMPORT_BYTES {
            return Err(ResearchError::Invalid("the imported text is too large"));
        }
        let label = new.label.split_whitespace().collect::<Vec<_>>().join(" ");
        if label.is_empty() || label.chars().count() > MAX_IMPORT_LABEL_CHARS {
            return Err(ResearchError::Invalid(
                "an origin label is required (200 characters at most)",
            ));
        }
        let request_id = normalize_client_request_id(new.client_request_id)?;
        let digest = import_digest(&content);
        self.write(|tx| {
            let question = load_question(tx, project_id, id)?;
            if question.archived {
                return Err(ResearchError::Archived);
            }
            if let Some(request_id) = &request_id
                && let Some(existing) = tx
                    .query_row(
                        &format!(
                            "{IMPORT_SELECT} WHERE research_id = ?1 AND client_request_id = ?2"
                        ),
                        params![id, request_id],
                        import_from_row,
                    )
                    .optional()?
            {
                // The same request id must carry the same text.
                if existing.digest != digest {
                    return Err(ResearchError::KeyReuse);
                }
                return Ok(((existing, false), None));
            }
            if new.based_on_revision == 0 || new.based_on_revision > question.revision {
                return Err(ResearchError::Invalid(
                    "the stated brief revision does not exist",
                ));
            }
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM research_imports WHERE research_id = ?1",
                [id],
                |row| row.get(0),
            )?;
            if count as usize >= MAX_IMPORTS_PER_QUESTION {
                return Err(ResearchError::Invalid(
                    "too many imported discussions for this question",
                ));
            }
            let import_id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO research_imports
                   (id, research_id, origin, label, based_on_revision, digest, content,
                    byte_count, client_request_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    import_id,
                    id,
                    new.origin.as_str(),
                    label,
                    new.based_on_revision as i64,
                    digest,
                    content,
                    content.len() as i64,
                    request_id,
                ],
            )?;
            let stored = tx.query_row(
                &format!("{IMPORT_SELECT} WHERE id = ?1"),
                [&import_id],
                import_from_row,
            )?;
            Ok((
                (stored, true),
                Some((project_id.to_owned(), id.to_owned(), Change::Import)),
            ))
        })
    }

    /// Imports of a question, newest first, without their text.
    pub fn imports(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<Vec<ResearchImport>, ResearchError> {
        let connection = self.connection();
        load_question(&connection, project_id, id)?;
        let mut statement = connection.prepare(&format!(
            "{IMPORT_SELECT} WHERE research_id = ?1 ORDER BY created_at DESC, rowid DESC"
        ))?;
        let rows = statement.query_map([id], import_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// One import with its stored text, inside a Project. Another Project's
    /// import is indistinguishable from a missing one.
    pub fn import_by_id(
        &self,
        project_id: &str,
        import_id: &str,
    ) -> Result<(ResearchImport, String), ResearchError> {
        let connection = self.connection();
        connection
            .query_row(
                &format!("{IMPORT_SELECT_JOINED} WHERE i.id = ?1 AND q.project_id = ?2"),
                params![import_id, project_id],
                |row| Ok((import_from_row(row)?, row.get::<_, String>(9)?)),
            )
            .optional()?
            .ok_or(ResearchError::ImportNotFound)
    }
}

const IMPORT_SELECT: &str = "SELECT id, research_id, origin, label, based_on_revision, digest,
        byte_count, created_at, client_request_id FROM research_imports";

const IMPORT_SELECT_JOINED: &str = "SELECT i.id, i.research_id, i.origin, i.label,
        i.based_on_revision, i.digest, i.byte_count, i.created_at, i.client_request_id, i.content
    FROM research_imports i JOIN research_questions q ON q.id = i.research_id";

fn import_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResearchImport> {
    let origin: String = row.get(2)?;
    Ok(ResearchImport {
        id: row.get(0)?,
        research_id: row.get(1)?,
        origin: ImportOrigin::parse(&origin).unwrap_or(ImportOrigin::Paste),
        label: row.get(3)?,
        based_on_revision: row.get::<_, i64>(4)? as u64,
        digest: row.get(5)?,
        byte_count: row.get::<_, i64>(6)? as usize,
        created_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests;
