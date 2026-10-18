//! Imported discussion and the discussion packet (ADR 0214 §8, issue #177).
//! Importing stores attributed source material and starts nothing. Reviewing
//! only lists candidates; a change to the brief still goes through the
//! revision-checked brief update (which can name the import it came from).
//! Exporting builds a bounded packet the researcher previews before anything
//! leaves the workspace.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::{ResearchApiError, check_project};
use crate::app_state::AppState;
use crate::research_store::{
    ImportCandidate, ImportOrigin, NewImport, ResearchError, ResearchImport, extract_candidates,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{project_id}/research/{research_id}/imports",
            get(list_imports).post(create_import),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/imports/{import_id}",
            get(get_import),
        )
        .route(
            "/projects/{project_id}/research/{research_id}/export",
            get(export_packet),
        )
}

/// An import with whether the brief has moved on since it was written.
#[derive(Debug, Serialize)]
struct ImportView {
    #[serde(flatten)]
    import: ResearchImport,
    current_revision: u64,
    /// The discussion was about an older brief than the one now approved.
    stale: bool,
}

fn view(import: ResearchImport, current_revision: u64) -> ImportView {
    ImportView {
        stale: import.based_on_revision < current_revision,
        import,
        current_revision,
    }
}

async fn list_imports(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
) -> Result<Json<Vec<ImportView>>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state.research.get(&project_id, &research_id)?;
    Ok(Json(
        state
            .research
            .imports(&project_id, &research_id)?
            .into_iter()
            .map(|import| view(import, question.revision))
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
struct CreateImportRequest {
    origin: ImportOrigin,
    label: String,
    content: String,
    /// Defaults to the brief revision that is current now.
    based_on_revision: Option<u64>,
    client_request_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateImportResponse {
    #[serde(flatten)]
    import: ImportView,
    created: bool,
}

async fn create_import(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Json(request): Json<CreateImportRequest>,
) -> Result<Response, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state.research.get(&project_id, &research_id)?;
    let (import, created) = state.research.import_source(
        &project_id,
        &research_id,
        NewImport {
            origin: request.origin,
            label: &request.label,
            content: &request.content,
            based_on_revision: request.based_on_revision.unwrap_or(question.revision),
            client_request_id: request.client_request_id.as_deref(),
        },
    )?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(CreateImportResponse {
            import: view(import, question.revision),
            created,
        }),
    )
        .into_response())
}

#[derive(Debug, Serialize)]
struct ImportDetail {
    #[serde(flatten)]
    import: ImportView,
    content: String,
    /// Suggestions for the researcher to review; none is an approved change.
    candidates: Vec<ImportCandidate>,
}

async fn get_import(
    State(state): State<AppState>,
    Path((project_id, research_id, import_id)): Path<(String, String, String)>,
) -> Result<Json<ImportDetail>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let question = state.research.get(&project_id, &research_id)?;
    let (import, content) = state.research.import_by_id(&project_id, &import_id)?;
    if import.research_id != research_id {
        return Err(ResearchError::ImportNotFound.into());
    }
    let candidates = extract_candidates(&content);
    Ok(Json(ImportDetail {
        import: view(import, question.revision),
        content,
        candidates,
    }))
}

// -- Export ------------------------------------------------------------------------------------------------

/// Largest packet, so a preview is always something a person can read.
pub const MAX_PACKET_BYTES: usize = 32 * 1024;
/// Each section has its own budget, so a long one cannot push out the rest.
const SECTION_BUDGET_BYTES: usize = 6 * 1024;
const PACKET_FINDINGS: usize = 30;
const PACKET_ROUNDS: usize = 20;
const PACKET_EXPERIMENTS_PER_ROUND: usize = 5;
const PACKET_EVIDENCE: usize = 40;
const PACKET_IMPORT_QUESTIONS: usize = 10;
const PACKET_IMPORT_QUESTIONS_TOTAL: usize = 30;
const PACKET_STATEMENT_CHARS: usize = 600;

#[derive(Debug, Deserialize)]
struct ExportQuery {
    /// Comma-separated section ids; absent means every section.
    sections: Option<String>,
}

#[derive(Debug, Serialize)]
struct PacketSection {
    id: &'static str,
    included: bool,
    /// Bytes after the section's own budget was applied.
    bytes: usize,
    /// The section was cut at its budget.
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct ExportPacket {
    research_id: String,
    /// The approved brief revision the packet describes; a reply should name it.
    brief_revision: u64,
    sections: Vec<PacketSection>,
    markdown: String,
    total_bytes: usize,
    /// At least one section was cut at its budget.
    truncated: bool,
}

const SECTION_IDS: [&str; 5] = [
    "brief",
    "progress",
    "findings",
    "evidence",
    "open_questions",
];

/// One line: whitespace collapsed (so free text cannot start a new markdown
/// block) and cut at `max` characters.
fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max).collect::<String>())
    }
}

fn cut_to_budget(mut text: String) -> (String, bool) {
    if text.len() <= SECTION_BUDGET_BYTES {
        return (text, false);
    }
    let cut = (0..=SECTION_BUDGET_BYTES)
        .rev()
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(0);
    text.truncate(cut);
    text.push_str("\n[section cut at its size limit]\n");
    (text, true)
}

async fn export_packet(
    State(state): State<AppState>,
    Path((project_id, research_id)): Path<(String, String)>,
    Query(query): Query<ExportQuery>,
) -> Result<Json<ExportPacket>, ResearchApiError> {
    check_project(&state, &project_id)?;
    let wanted: Vec<&str> = match query.sections.as_deref() {
        None => SECTION_IDS.to_vec(),
        Some(list) => {
            let mut chosen = Vec::new();
            for part in list
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
            {
                let id = SECTION_IDS
                    .iter()
                    .find(|id| **id == part)
                    .ok_or(ResearchError::Invalid("unknown packet section"))?;
                if !chosen.contains(id) {
                    chosen.push(*id);
                }
            }
            if chosen.is_empty() {
                return Err(ResearchError::Invalid("choose at least one packet section").into());
            }
            chosen
        }
    };
    // Store and file reads are synchronous; keep them off the async workers.
    let packet = tokio::task::spawn_blocking(move || {
        build_packet(&state, &project_id, &research_id, &wanted)
    })
    .await
    .map_err(|_| ResearchError::Invalid("the packet could not be built"))??;
    Ok(Json(packet))
}

fn build_packet(
    state: &AppState,
    project_id: &str,
    research_id: &str,
    wanted: &[&str],
) -> Result<ExportPacket, ResearchApiError> {
    let question = state.research.get(project_id, research_id)?;
    let brief = &question.brief;
    // Only what was asked for is built: a brief-only packet reads nothing else.
    let mut bodies: Vec<(&'static str, Option<String>)> = Vec::new();
    for id in SECTION_IDS {
        let body = wanted.contains(&id).then(|| match id {
            "brief" => brief_section(&question),
            "progress" => progress_section(state, project_id, research_id),
            "findings" => findings_section(state, project_id, research_id),
            "evidence" => evidence_section(state, project_id, research_id),
            _ => open_questions_section(state, project_id, research_id),
        });
        bodies.push((id, body.transpose()?));
    }

    let mut markdown = format!(
        "# Research discussion packet\n\nQuestion: {} (brief revision {}). When you reply, say which revision your notes are about.\n\n",
        one_line(&brief.title, 200),
        question.revision
    );
    let mut sections = Vec::new();
    let mut truncated = false;
    for (id, body) in bodies {
        match body {
            Some(body) => {
                let (body, cut) = cut_to_budget(body);
                truncated |= cut;
                sections.push(PacketSection {
                    id,
                    included: true,
                    bytes: body.len(),
                    truncated: cut,
                });
                markdown.push_str(&body);
                markdown.push('\n');
            }
            None => sections.push(PacketSection {
                id,
                included: false,
                bytes: 0,
                truncated: false,
            }),
        }
    }
    // Five budgeted sections and the header always fit; this only guards the bound.
    if markdown.len() > MAX_PACKET_BYTES {
        let cut = (0..=MAX_PACKET_BYTES)
            .rev()
            .find(|index| markdown.is_char_boundary(*index))
            .unwrap_or(0);
        markdown.truncate(cut);
        truncated = true;
    }
    Ok(ExportPacket {
        research_id: research_id.to_owned(),
        brief_revision: question.revision,
        sections,
        total_bytes: markdown.len(),
        markdown,
        truncated,
    })
}

fn brief_section(
    question: &crate::research_store::ResearchQuestion,
) -> Result<String, ResearchApiError> {
    let brief = &question.brief;
    let mut text = format!("## Approved brief (revision {})\n\n", question.revision);
    text.push_str(&format!(
        "**{}**\n\n{}\n",
        one_line(&brief.title, 200),
        one_line(&brief.question, 4_000)
    ));
    if !brief.motivation.is_empty() {
        text.push_str(&format!(
            "\nMotivation: {}\n",
            one_line(&brief.motivation, 4_000)
        ));
    }
    for (heading, items) in [
        ("Hypotheses", &brief.hypotheses),
        ("Constraints", &brief.constraints),
        ("Evaluation criteria", &brief.evaluation_criteria),
    ] {
        if !items.is_empty() {
            text.push_str(&format!("\n{heading}:\n"));
            for item in items {
                text.push_str(&format!("- {}\n", one_line(item, 1_000)));
            }
        }
    }
    Ok(text)
}

fn progress_section(
    state: &AppState,
    project_id: &str,
    research_id: &str,
) -> Result<String, ResearchApiError> {
    let mut text = String::from("## Progress\n\n");
    // Newest first, and only the most recent rounds.
    let rounds = state.research.rounds(project_id, research_id)?;
    if rounds.is_empty() {
        text.push_str("No work has been requested yet.\n");
    }
    for round in rounds.iter().take(PACKET_ROUNDS) {
        text.push_str(&format!(
            "- Round {} ({}, {}), brief revision {}\n",
            round.round,
            round.kind.as_str(),
            round.phase.as_str(),
            round.brief_revision
        ));
        if let Ok(experiments) = state
            .experiments
            .experiments(project_id, research_id, &round.id)
        {
            for experiment in experiments.iter().take(PACKET_EXPERIMENTS_PER_ROUND) {
                let label = if experiment.label.is_empty() {
                    "experiment"
                } else {
                    &experiment.label
                };
                let state_text = serde_json::to_value(experiment.state)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_default();
                text.push_str(&format!("  - {}: {state_text}\n", one_line(label, 80)));
            }
        }
    }
    if rounds.len() > PACKET_ROUNDS {
        text.push_str(&format!(
            "- … and {} earlier rounds\n",
            rounds.len() - PACKET_ROUNDS
        ));
    }
    Ok(text)
}

fn findings_section(
    state: &AppState,
    project_id: &str,
    research_id: &str,
) -> Result<String, ResearchApiError> {
    let mut text =
        String::from("## Findings\n\nThese are attributed records, not verified results.\n\n");
    let findings = state.research.findings(project_id, research_id)?;
    let recorded: Vec<_> = findings
        .iter()
        .rev()
        .filter(|finding| finding.kind != crate::research_store::FindingKind::OpenQuestion)
        .take(PACKET_FINDINGS)
        .collect();
    if recorded.is_empty() {
        text.push_str("None recorded.\n");
    }
    for finding in recorded {
        text.push_str(&format!(
            "- [{} / {}] by {} at brief revision {}: {}\n",
            finding.kind.as_str(),
            finding.basis.as_str(),
            finding.author_kind.as_str(),
            finding.brief_revision,
            one_line(&finding.statement, PACKET_STATEMENT_CHARS)
        ));
    }
    Ok(text)
}

/// Evidence is named, never included. A file shows its Project-relative path
/// only (no read, no hash); other records show a short id and whether they
/// still exist. Repeated references are listed once.
fn evidence_section(
    state: &AppState,
    project_id: &str,
    research_id: &str,
) -> Result<String, ResearchApiError> {
    let resolver = super::rounds::resolver(state);
    let mut text = String::from(
        "## Evidence references\n\nNames only; no file contents, transcripts, or logs are included.\n\n",
    );
    let findings = state.research.findings(project_id, research_id)?;
    let mut seen: Vec<(crate::research_store::SourceKind, String)> = Vec::new();
    for finding in findings
        .iter()
        .rev()
        .filter(|finding| finding.kind != crate::research_store::FindingKind::OpenQuestion)
        .take(PACKET_FINDINGS)
    {
        for source in &finding.evidence {
            if seen.len() >= PACKET_EVIDENCE
                || seen
                    .iter()
                    .any(|(kind, id)| *kind == source.kind && *id == source.id)
            {
                continue;
            }
            seen.push((source.kind, source.id.clone()));
            if source.kind == crate::research_store::SourceKind::File {
                text.push_str(&format!("- file {}\n", one_line(&source.id, 300)));
            } else {
                let short: String = source.id.chars().take(8).collect();
                text.push_str(&format!(
                    "- {} {} ({})\n",
                    source.kind.as_str(),
                    one_line(&short, 8),
                    resolver.resolve(project_id, source).as_str()
                ));
            }
        }
    }
    if seen.is_empty() {
        text.push_str("None cited.\n");
    }
    Ok(text)
}

fn open_questions_section(
    state: &AppState,
    project_id: &str,
    research_id: &str,
) -> Result<String, ResearchApiError> {
    let mut text = String::from("## Limitations and open questions\n\n");
    let mut any = false;
    let findings = state.research.findings(project_id, research_id)?;
    for finding in findings.iter().rev().take(PACKET_FINDINGS) {
        if matches!(
            finding.kind,
            crate::research_store::FindingKind::Limitation
                | crate::research_store::FindingKind::OpenQuestion
        ) {
            any = true;
            text.push_str(&format!(
                "- ({}) {}\n",
                finding.kind.as_str().replace('_', " "),
                one_line(&finding.statement, PACKET_STATEMENT_CHARS)
            ));
        }
    }
    for proposal in state.research.proposals(project_id, research_id)? {
        if proposal.review.is_none() {
            any = true;
            text.push_str(&format!(
                "- (proposal awaiting a decision) {}\n",
                one_line(&proposal.entry.body, PACKET_STATEMENT_CHARS)
            ));
        }
    }
    // Open questions found in imported discussions: a few per import, a few
    // overall, each as written by the researcher.
    let mut from_imports = 0;
    for import in state.research.imports(project_id, research_id)? {
        if from_imports >= PACKET_IMPORT_QUESTIONS_TOTAL {
            break;
        }
        let Ok((_, content)) = state.research.import_by_id(project_id, &import.id) else {
            continue;
        };
        for candidate in extract_candidates(&content)
            .into_iter()
            .filter(|candidate| {
                candidate.kind == crate::research_store::CandidateKind::OpenQuestion
            })
            .take(PACKET_IMPORT_QUESTIONS)
        {
            if from_imports >= PACKET_IMPORT_QUESTIONS_TOTAL {
                break;
            }
            from_imports += 1;
            any = true;
            text.push_str(&format!(
                "- (from imported discussion \"{}\") {}\n",
                one_line(&import.label, 80),
                one_line(&candidate.text, PACKET_STATEMENT_CHARS)
            ));
        }
    }
    if !any {
        text.push_str("None recorded.\n");
    }
    Ok(text)
}
