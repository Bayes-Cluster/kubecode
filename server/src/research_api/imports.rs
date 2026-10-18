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
const PACKET_FINDINGS: usize = 30;
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
    bytes: usize,
}

#[derive(Debug, Serialize)]
struct ExportPacket {
    research_id: String,
    /// The approved brief revision the packet describes; a reply should name it.
    brief_revision: u64,
    sections: Vec<PacketSection>,
    markdown: String,
    total_bytes: usize,
    /// The packet was cut at its size limit.
    truncated: bool,
    /// Plain statements of what is and is not in the packet.
    contents: Vec<&'static str>,
}

const SECTION_IDS: [&str; 5] = [
    "brief",
    "progress",
    "findings",
    "evidence",
    "open_questions",
];

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
            chosen
        }
    };
    let question = state.research.get(&project_id, &research_id)?;
    let resolver = super::rounds::resolver(&state);
    let findings = state.research.findings(&project_id, &research_id)?;
    let mut newest_first: Vec<_> = findings.iter().rev().take(PACKET_FINDINGS).collect();
    newest_first.sort_by_key(|finding| std::cmp::Reverse(finding.seq));
    let clip = |text: &str, max: usize| -> String {
        let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if flat.chars().count() <= max {
            flat
        } else {
            format!("{}…", flat.chars().take(max).collect::<String>())
        }
    };
    let brief = &question.brief;
    let mut bodies: Vec<(&'static str, String)> = Vec::new();

    let mut text = format!("## Approved brief (revision {})\n\n", question.revision);
    text.push_str(&format!("**{}**\n\n{}\n", brief.title, brief.question));
    if !brief.motivation.is_empty() {
        text.push_str(&format!("\nMotivation: {}\n", brief.motivation));
    }
    for (heading, items) in [
        ("Hypotheses", &brief.hypotheses),
        ("Constraints", &brief.constraints),
        ("Evaluation criteria", &brief.evaluation_criteria),
    ] {
        if !items.is_empty() {
            text.push_str(&format!("\n{heading}:\n"));
            for item in items {
                text.push_str(&format!("- {item}\n"));
            }
        }
    }
    bodies.push(("brief", text));

    let mut text = String::from("## Progress\n\n");
    let rounds = state.research.rounds(&project_id, &research_id)?;
    if rounds.is_empty() {
        text.push_str("No work has been requested yet.\n");
    }
    for round in rounds.iter().rev() {
        text.push_str(&format!(
            "- Round {} ({}, {}), brief revision {}\n",
            round.round,
            round.kind.as_str(),
            round.phase.as_str(),
            round.brief_revision
        ));
        if let Ok(experiments) = state
            .experiments
            .experiments(&project_id, &research_id, &round.id)
        {
            for experiment in experiments.iter().take(10) {
                let label = if experiment.label.is_empty() {
                    "experiment"
                } else {
                    &experiment.label
                };
                let state_text = serde_json::to_value(experiment.state)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_default();
                text.push_str(&format!("  - {}: {state_text}\n", clip(label, 80)));
            }
        }
    }
    bodies.push(("progress", text));

    let mut text =
        String::from("## Findings\n\nThese are attributed records, not verified results.\n\n");
    let recorded: Vec<_> = newest_first
        .iter()
        .filter(|finding| finding.kind != crate::research_store::FindingKind::OpenQuestion)
        .collect();
    if recorded.is_empty() {
        text.push_str("None recorded.\n");
    }
    for finding in &recorded {
        text.push_str(&format!(
            "- [{} / {}] by {} at brief revision {}: {}\n",
            finding.kind.as_str(),
            finding.basis.as_str(),
            finding.author_kind.as_str(),
            finding.brief_revision,
            clip(&finding.statement, PACKET_STATEMENT_CHARS)
        ));
    }
    bodies.push(("findings", text));

    // Evidence is named, never included: kinds, short ids or Project-relative
    // paths, and whether each still stands.
    let mut text = String::from(
        "## Evidence references\n\nNames only; no file contents, transcripts, or logs are included.\n\n",
    );
    let mut any = false;
    for finding in &recorded {
        for source in &finding.evidence {
            any = true;
            let name = if source.kind == crate::research_store::SourceKind::File {
                source.id.clone()
            } else {
                source.id.chars().take(8).collect()
            };
            text.push_str(&format!(
                "- {} {} ({})\n",
                source.kind.as_str(),
                name,
                resolver.resolve(&project_id, source).as_str()
            ));
        }
    }
    if !any {
        text.push_str("None cited.\n");
    }
    bodies.push(("evidence", text));

    let mut text = String::from("## Limitations and open questions\n\n");
    let mut any = false;
    for finding in &newest_first {
        if matches!(
            finding.kind,
            crate::research_store::FindingKind::Limitation
                | crate::research_store::FindingKind::OpenQuestion
        ) {
            any = true;
            text.push_str(&format!(
                "- ({}) {}\n",
                finding.kind.as_str().replace('_', " "),
                clip(&finding.statement, PACKET_STATEMENT_CHARS)
            ));
        }
    }
    for proposal in state.research.proposals(&project_id, &research_id)? {
        if proposal.review.is_none() {
            any = true;
            text.push_str(&format!(
                "- (proposal awaiting a decision) {}\n",
                clip(&proposal.entry.body, PACKET_STATEMENT_CHARS)
            ));
        }
    }
    for import in state.research.imports(&project_id, &research_id)? {
        if let Ok((_, content)) = state.research.import_by_id(&project_id, &import.id) {
            for candidate in extract_candidates(&content)
                .into_iter()
                .filter(|candidate| {
                    candidate.kind == crate::research_store::CandidateKind::OpenQuestion
                })
            {
                any = true;
                text.push_str(&format!(
                    "- (from imported discussion \"{}\") {}\n",
                    clip(&import.label, 80),
                    candidate.text
                ));
            }
        }
    }
    if !any {
        text.push_str("None recorded.\n");
    }
    bodies.push(("open_questions", text));

    let mut markdown = format!(
        "# Research discussion packet\n\nQuestion: {} (brief revision {}). When you reply, say which revision your notes are about.\n\n",
        clip(&brief.title, 200),
        question.revision
    );
    let mut sections = Vec::new();
    for (id, body) in &bodies {
        let included = wanted.contains(id);
        sections.push(PacketSection {
            id,
            included,
            bytes: if included { body.len() } else { 0 },
        });
        if included {
            markdown.push_str(body);
            markdown.push('\n');
        }
    }
    let mut truncated = false;
    if markdown.len() > MAX_PACKET_BYTES {
        let cut = (0..=MAX_PACKET_BYTES)
            .rev()
            .find(|index| markdown.is_char_boundary(*index))
            .unwrap_or(0);
        markdown.truncate(cut);
        markdown.push_str("\n[packet cut at its size limit]\n");
        truncated = true;
    }
    Ok(Json(ExportPacket {
        research_id,
        brief_revision: question.revision,
        sections,
        total_bytes: markdown.len(),
        markdown,
        truncated,
        contents: vec![
            "The approved brief and its revision number",
            "Round and experiment status, without commands or logs",
            "Attributed findings, limitations, and open questions (claims, not verified)",
            "Names of evidence (Project-relative file paths, short ids), never their contents",
            "No transcripts, prompts, credentials, or server paths",
        ],
    }))
}
