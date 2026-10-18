//! Source references for research records (ADR 0212 §5). A resolver borrows
//! only the stores it needs, so both the HTTP API and the Team MCP tools can
//! validate and resolve sources without depending on `AppState`.

use crate::agent_store::AgentStore;
use crate::research_store::{ResearchStore, SourceAvailability, SourceKind, SourceRef};
use crate::teams::TeamStore;
use crate::workspace::WorkspaceService;

pub(crate) struct SourceResolver<'a> {
    pub agents: &'a AgentStore,
    pub teams: &'a TeamStore,
    pub workspace: &'a WorkspaceService,
    /// Needed to cite imported discussions; `None` where none can be cited.
    pub research: Option<&'a ResearchStore>,
}

/// Why a source could not be accepted.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SourceError {
    /// Malformed reference (empty, oversized, or a bad path).
    Invalid,
    /// Well-formed, but not found in this Project.
    Missing,
}

impl SourceResolver<'_> {
    /// Validates a source and records the revision a `file` was selected at.
    /// Everything must exist inside `project_id`; another Project's record
    /// is reported exactly like a missing one.
    pub(crate) fn validate(
        &self,
        project_id: &str,
        source: &SourceRef,
    ) -> Result<SourceRef, SourceError> {
        let id = source.id.trim();
        if id.is_empty() || id.chars().count() > 512 {
            return Err(SourceError::Invalid);
        }
        let mut validated = SourceRef {
            kind: source.kind,
            id: id.to_owned(),
            revision: None,
        };
        if source.kind == SourceKind::File {
            let normalized = self
                .workspace
                .validate_project_relative_path(project_id, id)
                .map_err(|_| SourceError::Invalid)?;
            validated.revision = Some(
                self.workspace
                    .file_revision(project_id, &normalized)
                    .map_err(|_| SourceError::Missing)?,
            );
            validated.id = normalized;
            return Ok(validated);
        }
        if self.record_in_project(project_id, source.kind, id) {
            if source.kind == SourceKind::Import {
                // An import is immutable; record the digest it was cited at.
                validated.revision = self
                    .research
                    .and_then(|research| research.import_by_id(project_id, id).ok())
                    .map(|(import, _)| import.digest.chars().take(16).collect());
            }
            Ok(validated)
        } else {
            Err(SourceError::Missing)
        }
    }

    /// The current state of a source: `removed` when its record or file is
    /// gone (or belongs to another Project), `changed` when a file's content
    /// differs from the revision recorded, otherwise `available`.
    pub(crate) fn resolve(&self, project_id: &str, source: &SourceRef) -> SourceAvailability {
        if source.kind == SourceKind::File {
            return match self.workspace.file_revision(project_id, &source.id) {
                Ok(current) => match &source.revision {
                    Some(recorded) if *recorded != current => SourceAvailability::Changed,
                    _ => SourceAvailability::Available,
                },
                Err(_) => SourceAvailability::Removed,
            };
        }
        if self.record_in_project(project_id, source.kind, &source.id) {
            SourceAvailability::Available
        } else {
            SourceAvailability::Removed
        }
    }

    fn record_in_project(&self, project_id: &str, kind: SourceKind, id: &str) -> bool {
        match kind {
            SourceKind::Session => self
                .agents
                .get_conversation(id)
                .is_ok_and(|conversation| conversation.project_id == project_id),
            SourceKind::Run => self
                .agents
                .get_run(id)
                .is_ok_and(|run| run.project_id == project_id),
            SourceKind::Team => self
                .teams
                .get_team(id)
                .is_ok_and(|team| team.project_id == project_id),
            SourceKind::TeamTask => self
                .teams
                .get_task(id)
                .ok()
                .and_then(|task| self.teams.get_team(&task.team_id).ok())
                .is_some_and(|team| team.project_id == project_id),
            SourceKind::Import => self
                .research
                .is_some_and(|research| research.import_by_id(project_id, id).is_ok()),
            SourceKind::File => false,
        }
    }
}
