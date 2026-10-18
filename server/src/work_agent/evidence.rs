//! Whether what a task cites still says what it did. A result reference
//! carries the revision it was attached at; evidence that changed or was
//! removed since no longer proves what it once did, and acceptance refuses it
//! until someone re-pins it on purpose.

use std::sync::Arc;

use serde::Serialize;

use crate::project_context::{Availability, ContextKind, ContextRef, ProjectContext};
use crate::research_store::{SourceKind, SourceRef};
use crate::work_store::ResultRef;
use crate::workspace::WorkspaceService;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct StaleEvidence {
    pub result_id: String,
    pub kind: String,
    pub ref_id: String,
    /// `changed` or `removed`.
    pub status: &'static str,
}

#[derive(Clone)]
pub struct Evidence {
    context: Arc<ProjectContext>,
    workspace: Arc<WorkspaceService>,
}

impl Evidence {
    pub fn new(context: Arc<ProjectContext>, workspace: Arc<WorkspaceService>) -> Self {
        Self { context, workspace }
    }

    /// The revision a reference has *now*, or `None` if it is gone or has none.
    pub fn current_revision(&self, project_id: &str, kind: &str, id: &str) -> Option<String> {
        if kind == "file" {
            return self.workspace.file_revision(project_id, id).ok();
        }
        let kind = ContextKind::parse(kind)?;
        let resolved = self
            .context
            .resolve(project_id, &[ContextRef::new(kind, id)])
            .ok()?
            .into_iter()
            .next()?;
        (resolved.availability != Availability::Removed)
            .then_some(resolved.current_revision)
            .flatten()
    }

    /// Cited evidence that no longer matches the revision it was pinned at.
    pub fn stale(&self, project_id: &str, results: &[ResultRef]) -> Vec<StaleEvidence> {
        results
            .iter()
            .filter_map(|result| {
                let pinned = result.revision.as_deref()?;
                let status = match self.current_revision(project_id, &result.kind, &result.ref_id) {
                    None => "removed",
                    Some(current) if current != pinned => "changed",
                    Some(_) => return None,
                };
                Some(StaleEvidence {
                    result_id: result.id.clone(),
                    kind: result.kind.clone(),
                    ref_id: result.ref_id.clone(),
                    status,
                })
            })
            .collect()
    }

    /// A citation checked against the Project and pinned to what it is now, or
    /// `None` when it does not exist here.
    pub fn source_ref(&self, project_id: &str, kind: &str, id: &str) -> Option<SourceRef> {
        let kind = SourceKind::parse(kind)?;
        // A run cannot be checked from here, so it is not accepted as evidence.
        if kind == SourceKind::Run {
            return None;
        }
        let mut source = SourceRef {
            kind,
            id: id.to_owned(),
            revision: None,
        };
        if self.source_status(project_id, &source) == "removed" {
            return None;
        }
        if kind == SourceKind::File {
            source.revision = self.workspace.file_revision(project_id, id).ok();
        }
        Some(source)
    }

    /// Availability of a source a round cites, as words for a brief.
    pub fn source_status(&self, project_id: &str, source: &SourceRef) -> &'static str {
        let kind = match source.kind {
            SourceKind::File => {
                return match self.workspace.file_revision(project_id, &source.id) {
                    Ok(current) if source.revision.as_deref().is_none_or(|r| r == current) => {
                        "available"
                    }
                    Ok(_) => "changed",
                    Err(_) => "removed",
                };
            }
            SourceKind::Import => ContextKind::Import,
            SourceKind::Session => ContextKind::Session,
            SourceKind::Team => ContextKind::Team,
            SourceKind::TeamTask => ContextKind::TeamTask,
            SourceKind::Run => return "available",
        };
        match self.context.resolve(
            project_id,
            &[ContextRef {
                kind,
                id: source.id.clone(),
                revision: source.revision.clone(),
            }],
        ) {
            Ok(resolved) => match resolved.first().map(|r| r.availability) {
                Some(Availability::Available) => "available",
                Some(Availability::Changed) => "changed",
                _ => "removed",
            },
            Err(_) => "removed",
        }
    }
}
