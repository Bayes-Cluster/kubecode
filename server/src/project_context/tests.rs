use std::fs;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::agent_store::AgentEventKind;
use crate::agents::{AgentId, PermissionMode};
use crate::experiment_store::testing::Fixture;
use crate::experiment_store::{ArtifactRevision, Outcome};
use crate::research_store::{
    AuthorKind, BriefPatch, FindingKind, NewFinding, NewPublication, Producer, SourceKind,
    SourceRef,
};

struct World {
    f: Fixture,
    context: ProjectContext,
    channels: Arc<crate::channel_store::ChannelStore>,
    work: Arc<crate::work_store::WorkStore>,
}

fn world() -> World {
    let f = Fixture::new();
    let work = Arc::new(
        crate::work_store::WorkStore::from_database(f.agents.database(), Arc::clone(&f.agents))
            .expect("work store"),
    );
    let channels = Arc::new(
        crate::channel_store::ChannelStore::from_database(
            f.agents.database(),
            Arc::clone(&f.agents),
        )
        .expect("channel store"),
    );
    let context = ProjectContext::new(
        Arc::clone(&f.agents),
        Arc::clone(&f.teams),
        Arc::clone(&f.research),
        Arc::clone(&f.experiments),
        Arc::clone(&work),
        Arc::clone(&channels),
        Arc::clone(&f.workspace),
    );
    World {
        f,
        context,
        channels,
        work,
    }
}

impl World {
    fn search(&self, query: &str) -> ContextPage {
        self.context
            .search(&self.f.project_id, Some(query), &[], Some(50), None)
            .expect("search")
    }

    fn kinds(&self, kind: ContextKind) -> Vec<ContextItem> {
        self.context
            .search(&self.f.project_id, None, &[kind], Some(50), None)
            .expect("search")
            .items
    }

    fn read(&self, reference: &ContextRef, detail: Detail) -> ContextDocument {
        self.context
            .read(&self.f.project_id, reference, detail, None)
            .expect("read")
    }

    fn text(&self, doc: &ContextDocument) -> String {
        doc.sections
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Runs an experiment to completion, declaring one artifact that exists.
    fn finished_experiment(
        &self,
        artifact: &str,
        content: &str,
    ) -> crate::experiment_store::Experiment {
        let root = self.f.workspace.project_path(&self.f.project_id).unwrap();
        fs::write(root.join(artifact), content).unwrap();
        let mut request = crate::experiment_store::testing::launch(
            &self.f.round_id,
            &self.f.team,
            "k1",
            &["echo", "hi"],
        );
        request.label = "baseline".into();
        request.artifacts = vec![artifact.to_owned()];
        let (experiment, _) = self
            .f
            .experiments
            .reserve(&self.f.project_id, &self.f.research_id, request)
            .unwrap();
        self.f.experiments.mark_launching(&experiment.id).unwrap();
        let revision = self
            .f
            .workspace
            .execution_file_revision(&self.f.project_id, None, artifact)
            .ok();
        self.f
            .experiments
            .observe(
                &experiment.id,
                Outcome {
                    state: Some(crate::experiment_store::ExperimentState::Exited),
                    exit_code: Some(0),
                    artifact_revisions: vec![ArtifactRevision {
                        path: artifact.to_owned(),
                        revision,
                    }],
                    ..Outcome::default()
                },
            )
            .unwrap();
        self.f
            .experiments
            .experiment(&self.f.project_id, &experiment.id)
            .unwrap()
    }

    fn publish(&self, statement: &str, evidence: Vec<SourceRef>) -> String {
        let outcome = self
            .f
            .research
            .publish(
                &self.f.project_id,
                &self.f.research_id,
                NewPublication {
                    key: "p1".into(),
                    author_kind: AuthorKind::Agent,
                    author_ref: Some("worker".into()),
                    producer: Producer::default(),
                    round_id: Some(self.f.round_id.clone()),
                    findings: vec![NewFinding {
                        kind: FindingKind::Finding,
                        statement: statement.into(),
                        evidence,
                    }],
                    proposals: Vec::new(),
                },
            )
            .unwrap();
        outcome.findings[0].id.clone()
    }
}

#[test]
fn search_discovers_every_kind_with_provenance() {
    let w = world();
    w.finished_experiment("kinds.txt", "x");
    w.publish("A finding to discover", Vec::new());
    let page = w.search("");
    let kinds: std::collections::HashSet<_> = page.items.iter().map(|i| i.reference.kind).collect();
    for kind in [
        ContextKind::Research,
        ContextKind::Round,
        ContextKind::Finding,
        ContextKind::Session,
        ContextKind::Team,
        ContextKind::TeamTask,
        ContextKind::Experiment,
        ContextKind::Artifact,
    ] {
        assert!(kinds.contains(&kind), "missing {kind:?}");
    }
    let research = w.kinds(ContextKind::Research);
    assert_eq!(research.len(), 1);
    assert_eq!(research[0].title, "Pruning");
    assert_eq!(research[0].reference.revision.as_deref(), Some("1"));
    let finding = &w.kinds(ContextKind::Finding)[0];
    assert_eq!(finding.provenance.author.as_deref(), Some("agent"));
    assert_eq!(
        finding.provenance.parent.as_ref().map(|p| p.kind),
        Some(ContextKind::Research)
    );
    let experiment = &w.kinds(ContextKind::Experiment)[0];
    assert_eq!(
        experiment.provenance.research_id.as_deref(),
        Some(w.f.research_id.as_str())
    );
    assert_eq!(
        experiment.provenance.parent.as_ref().unwrap().kind,
        ContextKind::Round
    );
    let task = &w.kinds(ContextKind::TeamTask)[0];
    assert_eq!(
        task.provenance.parent.as_ref().unwrap().kind,
        ContextKind::Team
    );
}

#[test]
fn search_pages_to_exhaustion_without_gaps_or_duplicates() {
    let w = world();
    for n in 0..60 {
        w.f.agents
            .create_conversation(
                &w.f.project_id,
                AgentId::OpenCode,
                Some(&format!("s{n:02}")),
            )
            .unwrap();
    }
    let everything = w
        .context
        .search(
            &w.f.project_id,
            None,
            &[ContextKind::Session],
            Some(10_000),
            None,
        )
        .unwrap();
    assert_eq!(everything.items.len(), MAX_PAGE, "the page is clamped");
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = w
            .context
            .search(
                &w.f.project_id,
                None,
                &[ContextKind::Session],
                Some(7),
                cursor.as_deref(),
            )
            .unwrap();
        assert!(
            !page.items.is_empty(),
            "a page must not be empty while a cursor is returned"
        );
        seen.extend(page.items.iter().map(|i| i.reference.id.clone()));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    let unique: std::collections::HashSet<_> = seen.iter().collect();
    assert_eq!(unique.len(), seen.len(), "no duplicates across pages");
    // 60 new Sessions plus the two the fixture created.
    assert_eq!(seen.len(), 62);
    assert!(matches!(
        w.context
            .search(&w.f.project_id, None, &[], None, Some("%%%")),
        Err(ContextError::Invalid(_))
    ));
}

#[test]
fn a_capped_search_keeps_the_newest_candidates_and_says_so() {
    let w = world();
    for n in 0..(SCAN_CAP + 5) {
        let session =
            w.f.agents
                .create_conversation(
                    &w.f.project_id,
                    AgentId::OpenCode,
                    Some(&format!("bulk-{n:03}")),
                )
                .unwrap();
        // created_at has one-second resolution; make the order explicit.
        w.f.agents
            .database()
            .lock()
            .unwrap()
            .execute(
                "UPDATE conversations SET created_at = datetime('2030-01-01', ?1) WHERE id = ?2",
                rusqlite::params![format!("+{n} seconds"), session.id],
            )
            .unwrap();
    }
    let newest = format!("bulk-{:03}", SCAN_CAP + 4);
    let found = w
        .context
        .search(
            &w.f.project_id,
            Some(&newest),
            &[ContextKind::Session],
            Some(5),
            None,
        )
        .unwrap();
    assert!(found.truncated);
    assert!(
        found.items.iter().any(|i| i.title == newest),
        "the newest Session must survive the cap"
    );
    let oldest = w
        .context
        .search(
            &w.f.project_id,
            Some("bulk-000"),
            &[ContextKind::Session],
            Some(5),
            None,
        )
        .unwrap();
    assert!(
        oldest.truncated && oldest.items.is_empty(),
        "the oldest falls outside the scan"
    );
}

#[test]
fn hidden_revision_snapshots_are_never_readable() {
    let w = world();
    let snapshot =
        w.f.agents
            .create_conversation(&w.f.project_id, AgentId::OpenCode, Some("rewind copy"))
            .unwrap();
    {
        let database = w.f.agents.database();
        database
            .lock()
            .unwrap()
            .execute(
                "UPDATE conversations SET internal_revision = 1 WHERE id = ?1",
                [&snapshot.id],
            )
            .unwrap();
    }
    let session = ContextRef::new(ContextKind::Session, &snapshot.id);
    let turn = ContextRef::new(
        ContextKind::SessionTurn,
        format!("{}/anything", snapshot.id),
    );
    assert!(w.search("rewind").items.is_empty());
    for reference in [&session, &turn] {
        assert!(matches!(
            w.context
                .read(&w.f.project_id, reference, Detail::Evidence, None),
            Err(ContextError::NotFound)
        ));
    }
    let resolved = w
        .context
        .resolve(&w.f.project_id, &[session, turn])
        .unwrap();
    assert!(
        resolved
            .iter()
            .all(|r| r.availability == Availability::Removed)
    );
}

#[test]
fn search_matches_parts_of_words_and_orders_title_hits_first() {
    let w = world();
    let page = w.search("prun");
    assert!(
        page.items
            .iter()
            .any(|i| i.reference.kind == ContextKind::Research)
    );
    // Every title hit precedes every summary-only hit.
    let is_title_hit = |i: &ContextItem| i.title.to_lowercase().contains("prun");
    let first_other = page.items.iter().position(|i| !is_title_hit(i));
    if let Some(index) = first_other {
        assert!(page.items[index..].iter().all(|i| !is_title_hit(i)));
    }
    assert!(
        w.search("PRUNING")
            .items
            .iter()
            .any(|i| i.title == "Pruning")
    );
    assert!(
        w.search("pruning zzz").items.is_empty(),
        "every word must match"
    );
}

#[test]
fn every_kind_is_denied_across_projects() {
    let w = world();
    let other = w.f.workspace.create_project(".", "gamma").unwrap();
    let experiment = w.finished_experiment("r.txt", "x");
    let finding = w.publish("A claim", Vec::new());
    let session =
        w.f.agents
            .create_conversation(&w.f.project_id, AgentId::OpenCode, Some("mine"))
            .unwrap();
    let run =
        w.f.agents
            .start_run(&session.id, &w.f.project_id, "hello", PermissionMode::Safe)
            .unwrap();
    let refs = vec![
        ContextRef::new(ContextKind::Finding, finding),
        ContextRef::new(ContextKind::Experiment, &experiment.id),
        ContextRef::new(ContextKind::Artifact, format!("{}/r.txt", experiment.id)),
        ContextRef::new(
            ContextKind::SessionTurn,
            format!("{}/{}", session.id, run.id),
        ),
        ContextRef::new(ContextKind::Session, &session.id),
        ContextRef::new(ContextKind::Round, &w.f.round_id),
    ];
    for reference in &refs {
        assert!(
            w.context
                .read(&w.f.project_id, reference, Detail::Summary, None)
                .is_ok(),
            "{:?} must be readable in its own Project",
            reference.kind
        );
        assert!(
            matches!(
                w.context.read(&other.id, reference, Detail::Evidence, None),
                Err(ContextError::NotFound)
            ),
            "{:?} leaked across Projects",
            reference.kind
        );
    }
    let resolved = w.context.resolve(&other.id, &refs).unwrap();
    assert!(
        resolved
            .iter()
            .all(|r| r.availability == Availability::Removed)
    );
}

#[test]
fn deleted_sources_are_removed_and_changes_are_detected_for_every_kind() {
    let w = world();
    // Session: a new turn changes its fingerprint; deleting the record removes it.
    let session =
        w.f.agents
            .create_conversation(&w.f.project_id, AgentId::OpenCode, Some("evolving"))
            .unwrap();
    let pinned = |w: &World, kind, id: &str| {
        let item = w
            .context
            .lookup(&w.f.project_id, &ContextRef::new(kind, id))
            .unwrap()
            .expect("exists");
        item.reference
    };
    let session_ref = pinned(&w, ContextKind::Session, &session.id);
    w.f.agents
        .start_run(&session.id, &w.f.project_id, "go", PermissionMode::Safe)
        .unwrap();
    let experiment = w.finished_experiment("e.txt", "1");
    let experiment_ref = pinned(&w, ContextKind::Experiment, &experiment.id);
    w.f.experiments.mark_analyzed(&experiment.id).unwrap();
    let resolved = w
        .context
        .resolve(
            &w.f.project_id,
            &[session_ref.clone(), experiment_ref.clone()],
        )
        .unwrap();
    assert_eq!(
        resolved[0].availability,
        Availability::Changed,
        "a new turn changes a Session"
    );
    assert_eq!(
        resolved[1].availability,
        Availability::Changed,
        "analysis changes an experiment"
    );
    // Deleting a record that existed makes it removed, not an error.
    w.f.teams.delete_team(&w.f.team.id).unwrap();
    let gone = w
        .context
        .resolve(
            &w.f.project_id,
            &[
                ContextRef::new(ContextKind::Team, &w.f.team.id),
                ContextRef::new(ContextKind::TeamTask, &w.f.task_id),
            ],
        )
        .unwrap();
    assert!(gone.iter().all(|r| r.availability == Availability::Removed));
}

#[test]
fn a_research_revision_must_be_numeric_everywhere() {
    let w = world();
    let bad = ContextRef::at(ContextKind::Research, &w.f.research_id, "abc");
    assert!(matches!(
        w.context
            .resolve(&w.f.project_id, std::slice::from_ref(&bad)),
        Err(ContextError::Invalid(_))
    ));
    assert!(matches!(
        w.context.read(&w.f.project_id, &bad, Detail::Summary, None),
        Err(ContextError::Invalid(_))
    ));
    let missing = ContextRef::at(ContextKind::Research, &w.f.research_id, "0");
    assert!(matches!(
        w.context
            .read(&w.f.project_id, &missing, Detail::Content, None),
        Err(ContextError::NotFound)
    ));
}

#[test]
fn a_pinned_read_summarizes_the_pinned_brief() {
    let w = world();
    w.f.research
        .update_brief(
            &w.f.project_id,
            &w.f.research_id,
            1,
            &BriefPatch {
                question: Some("A completely different question?".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let doc = w.read(
        &ContextRef::at(ContextKind::Research, &w.f.research_id, "1"),
        Detail::Summary,
    );
    assert_eq!(doc.sections[0].text, "Does it hold?");
}

#[test]
fn a_cited_session_that_changed_is_reported_changed() {
    let w = world();
    let session =
        w.f.agents
            .create_conversation(&w.f.project_id, AgentId::OpenCode, Some("cited"))
            .unwrap();
    let before = w
        .context
        .lookup(
            &w.f.project_id,
            &ContextRef::new(ContextKind::Session, &session.id),
        )
        .unwrap()
        .unwrap()
        .reference
        .revision;
    let finding = w.publish(
        "Cites a Session",
        vec![SourceRef {
            kind: SourceKind::Session,
            id: session.id.clone(),
            revision: before,
        }],
    );
    let reference = ContextRef::new(ContextKind::Finding, finding);
    assert!(
        w.text(&w.read(&reference, Detail::Evidence))
            .contains("(available)")
    );
    w.f.agents
        .start_run(&session.id, &w.f.project_id, "more", PermissionMode::Safe)
        .unwrap();
    assert!(
        w.text(&w.read(&reference, Detail::Evidence))
            .contains("(changed)")
    );
}

#[test]
fn a_whole_document_is_bounded() {
    let mut doc = ContextDocument::new(
        &ContextItem {
            reference: ContextRef::new(ContextKind::Research, "r"),
            title: "t".into(),
            summary: String::new(),
            provenance: Provenance::default(),
            availability: Availability::Available,
        },
        Detail::Evidence,
        Availability::Available,
    );
    for n in 0..8 {
        doc.section(&format!("s{n}"), &"y".repeat(SECTION_CHARS * 2));
    }
    assert!(
        doc.sections
            .iter()
            .all(|s| s.text.chars().count() <= SECTION_CHARS)
    );
    doc.bound();
    let total: usize = doc.sections.iter().map(|s| s.text.chars().count()).sum();
    assert!(total <= MAX_DOCUMENT_CHARS);
    assert!(doc.sections.iter().any(|s| s.truncated));
    assert!(doc.notes.iter().any(|n| n.contains("size limit")));
}

#[test]
fn a_deleted_team_makes_its_worktree_artifacts_unavailable_not_the_project_copy() {
    let w = world();
    let state_root = w.f.agents.database_directory().canonicalize().unwrap();
    let worktree = state_root
        .join("worktrees")
        .join(&w.f.project_id)
        .join("gone");
    fs::create_dir_all(&worktree).unwrap();
    {
        let database = w.f.agents.database();
        database
            .lock()
            .unwrap()
            .execute(
                "UPDATE teams SET workspace_path = ?1 WHERE id = ?2",
                rusqlite::params![worktree.to_string_lossy(), w.f.team.id],
            )
            .unwrap();
    }
    let root = w.f.workspace.project_path(&w.f.project_id).unwrap();
    fs::write(root.join("m.txt"), "project decoy").unwrap();
    fs::write(worktree.join("m.txt"), "worktree").unwrap();
    let mut request =
        crate::experiment_store::testing::launch(&w.f.round_id, &w.f.team, "gone", &["echo"]);
    request.artifacts = vec!["m.txt".into()];
    let (experiment, _) =
        w.f.experiments
            .reserve(&w.f.project_id, &w.f.research_id, request)
            .unwrap();
    w.f.experiments.mark_launching(&experiment.id).unwrap();
    w.f.experiments
        .observe(
            &experiment.id,
            Outcome {
                state: Some(crate::experiment_store::ExperimentState::Exited),
                exit_code: Some(0),
                ..Outcome::default()
            },
        )
        .unwrap();
    let reference = ContextRef::new(ContextKind::Artifact, format!("{}/m.txt", experiment.id));
    w.f.teams.delete_team(&w.f.team.id).ok();
    let resolved = w
        .context
        .resolve(&w.f.project_id, std::slice::from_ref(&reference))
        .unwrap();
    // Either the experiment went with its Team (removed), or it is kept and the
    // artifact must not fall back to the Project's same-named file.
    assert_eq!(resolved[0].availability, Availability::Removed);
    if let Ok(doc) = w
        .context
        .read(&w.f.project_id, &reference, Detail::Content, None)
    {
        assert!(!w.text(&doc).contains("project decoy"));
    }
}

#[test]
fn artifacts_behind_a_symlinked_directory_or_a_fifo_are_not_read() {
    let w = world();
    let root = w.f.workspace.project_path(&w.f.project_id).unwrap();
    let outside = root.parent().unwrap().join("outside-dir");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "top secret").unwrap();
    fs::create_dir_all(root.join("real")).unwrap();
    fs::write(root.join("real/secret.txt"), "fine").unwrap();
    let experiment = w.finished_experiment("real/secret.txt", "fine");
    fs::remove_dir_all(root.join("real")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("real")).unwrap();
    let reference = ContextRef::new(
        ContextKind::Artifact,
        format!("{}/real/secret.txt", experiment.id),
    );
    let resolved = w
        .context
        .resolve(&w.f.project_id, std::slice::from_ref(&reference))
        .unwrap();
    assert_eq!(resolved[0].availability, Availability::Removed);
    let doc = w.read(&reference, Detail::Content);
    assert!(!w.text(&doc).contains("top secret"));
    assert!(doc.notes.iter().any(|n| n.contains("could not be read")));

    // A FIFO must neither block the reader nor be read.
    fs::remove_file(root.join("real")).unwrap();
    fs::create_dir_all(root.join("real")).unwrap();
    let fifo = std::ffi::CString::new(root.join("real/secret.txt").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let doc = w.read(&reference, Detail::Content);
    assert!(doc.sections.iter().all(|s| s.heading != "Content"));
}
#[test]
fn another_project_cannot_see_or_resolve_records() {
    let w = world();
    let other = w.f.workspace.create_project(".", "beta").unwrap();
    assert!(
        w.context
            .search(&other.id, None, &[], Some(50), None)
            .unwrap()
            .items
            .is_empty()
    );
    let session = w.kinds(ContextKind::Session)[0].reference.clone();
    let team = ContextRef::new(ContextKind::Team, &w.f.team.id);
    let research = ContextRef::new(ContextKind::Research, &w.f.research_id);
    let round = ContextRef::new(ContextKind::Round, &w.f.round_id);
    let task = ContextRef::new(ContextKind::TeamTask, &w.f.task_id);
    for reference in [&session, &team, &research, &round, &task] {
        assert!(
            matches!(
                w.context.read(&other.id, reference, Detail::Evidence, None),
                Err(ContextError::NotFound)
            ),
            "{:?} leaked across Projects",
            reference.kind
        );
    }
    let resolved = w
        .context
        .resolve(&other.id, &[session, team, research, round, task])
        .unwrap();
    assert!(
        resolved
            .iter()
            .all(|r| r.availability == Availability::Removed)
    );
    assert!(resolved.iter().all(|r| r.current_revision.is_none()));
}

#[test]
fn resolve_reports_changed_and_removed_sources() {
    let w = world();
    let pinned = ContextRef::at(ContextKind::Research, &w.f.research_id, "1");
    let resolved = w
        .context
        .resolve(&w.f.project_id, std::slice::from_ref(&pinned))
        .unwrap();
    assert_eq!(resolved[0].availability, Availability::Available);
    w.f.research
        .update_brief(
            &w.f.project_id,
            &w.f.research_id,
            1,
            &BriefPatch {
                question: Some("A sharper question?".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let resolved = w.context.resolve(&w.f.project_id, &[pinned]).unwrap();
    assert_eq!(resolved[0].availability, Availability::Changed);
    assert_eq!(resolved[0].current_revision.as_deref(), Some("2"));
    let gone = w
        .context
        .resolve(
            &w.f.project_id,
            &[ContextRef::new(ContextKind::Session, "nope")],
        )
        .unwrap();
    assert_eq!(gone[0].availability, Availability::Removed);
    let too_many: Vec<_> = (0..=MAX_RESOLVE)
        .map(|i| ContextRef::new(ContextKind::Session, i.to_string()))
        .collect();
    assert!(matches!(
        w.context.resolve(&w.f.project_id, &too_many),
        Err(ContextError::Invalid(_))
    ));
}

#[test]
fn a_pinned_research_revision_reads_the_pinned_brief_and_says_a_newer_one_exists() {
    let w = world();
    w.f.research
        .update_brief(
            &w.f.project_id,
            &w.f.research_id,
            1,
            &BriefPatch {
                question: Some("A sharper question?".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let pinned = w.read(
        &ContextRef::at(ContextKind::Research, &w.f.research_id, "1"),
        Detail::Content,
    );
    assert_eq!(pinned.availability, Availability::Changed);
    assert!(w.text(&pinned).contains("Does it hold?"));
    assert!(pinned.notes.iter().any(|n| n.contains("revision 2")));
    let live = w.read(
        &ContextRef::new(ContextKind::Research, &w.f.research_id),
        Detail::Content,
    );
    assert_eq!(live.availability, Availability::Available);
    assert!(w.text(&live).contains("A sharper question?"));
    assert!(matches!(
        w.context.read(
            &w.f.project_id,
            &ContextRef::at(ContextKind::Research, &w.f.research_id, "abc"),
            Detail::Content,
            None
        ),
        Err(ContextError::Invalid(_))
    ));
}

#[test]
fn reads_are_progressive() {
    let w = world();
    let reference = ContextRef::new(ContextKind::Research, &w.f.research_id);
    let summary = w.read(&reference, Detail::Summary);
    let content = w.read(&reference, Detail::Content);
    let evidence = w.read(&reference, Detail::Evidence);
    assert_eq!(summary.sections.len(), 1);
    assert!(content.sections.len() > summary.sections.len());
    assert!(summary.related.is_empty());
    assert!(!evidence.related.is_empty());
}

#[test]
fn finding_evidence_shows_changed_and_removed_files() {
    let w = world();
    let root = w.f.workspace.project_path(&w.f.project_id).unwrap();
    fs::write(root.join("notes.md"), "v1").unwrap();
    let revision =
        w.f.workspace
            .file_revision(&w.f.project_id, "notes.md")
            .unwrap();
    let id = w.publish(
        "Pruning keeps accuracy",
        vec![SourceRef {
            kind: SourceKind::File,
            id: "notes.md".into(),
            revision: Some(revision),
        }],
    );
    let reference = ContextRef::new(ContextKind::Finding, &id);
    let doc = w.read(&reference, Detail::Evidence);
    assert!(w.text(&doc).contains("notes.md (available)"));
    assert!(
        doc.notes
            .iter()
            .any(|n| n.contains("not a verified result"))
    );
    fs::write(root.join("notes.md"), "v2").unwrap();
    assert!(
        w.text(&w.read(&reference, Detail::Evidence))
            .contains("notes.md (changed)")
    );
    fs::remove_file(root.join("notes.md")).unwrap();
    assert!(
        w.text(&w.read(&reference, Detail::Evidence))
            .contains("notes.md (removed)")
    );
    let parent = &doc.related[0];
    assert_eq!(parent.reference.kind, ContextKind::Research);
}

#[test]
fn round_reads_note_a_newer_brief() {
    let w = world();
    w.f.research
        .update_brief(
            &w.f.project_id,
            &w.f.research_id,
            1,
            &BriefPatch {
                title: Some("Pruning v2".into()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    let doc = w.read(
        &ContextRef::new(ContextKind::Round, &w.f.round_id),
        Detail::Evidence,
    );
    assert!(doc.notes.iter().any(|n| n.contains("brief revision 1")));
    assert!(
        doc.related
            .iter()
            .any(|i| i.reference.kind == ContextKind::Research)
    );
    assert!(
        doc.related
            .iter()
            .any(|i| i.reference.kind == ContextKind::Team)
    );
}

#[test]
fn session_turns_are_listed_and_readable_with_partial_marking() {
    let w = world();
    let session =
        w.f.agents
            .create_conversation(&w.f.project_id, AgentId::OpenCode, Some("Prior work"))
            .unwrap();
    let run =
        w.f.agents
            .start_run(
                &session.id,
                &w.f.project_id,
                "How did the sweep go?",
                PermissionMode::Safe,
            )
            .unwrap();
    w.f.agents
        .append_runtime_update(
            &session.id,
            "text_delta",
            &json!({"message_id": "m1", "text": "Accuracy held at 91%."}),
            Some((
                &run.id,
                AgentEventKind::TextDelta,
                &json!({"message_id": "m1", "text": "Accuracy held at 91%."}),
            )),
        )
        .unwrap();
    let listing = w.read(
        &ContextRef::new(ContextKind::Session, &session.id),
        Detail::Content,
    );
    assert_eq!(listing.related.len(), 1);
    assert!(listing.notes.iter().any(|n| n.contains("still running")));
    let turn_ref = listing.related[0].reference.clone();
    assert_eq!(turn_ref.id, format!("{}/{}", session.id, run.id));
    let turn = w.read(&turn_ref, Detail::Content);
    let text = w.text(&turn);
    assert!(text.contains("How did the sweep go?"));
    assert!(text.contains("Accuracy held at 91%."));
    assert!(turn.notes.iter().any(|n| n.contains("partial")));
    let before = w
        .context
        .resolve(&w.f.project_id, std::slice::from_ref(&turn_ref))
        .unwrap();
    assert_eq!(before[0].availability, Availability::Available);
    w.f.agents
        .append_runtime_update(
            &session.id,
            "text_delta",
            &json!({"message_id": "m1", "text": " More."}),
            Some((
                &run.id,
                AgentEventKind::TextDelta,
                &json!({"message_id": "m1", "text": " More."}),
            )),
        )
        .unwrap();
    let after = w.context.resolve(&w.f.project_id, &[turn_ref]).unwrap();
    assert_eq!(after[0].availability, Availability::Changed);
    // A turn id for another Session's run is not a turn of this Session.
    let other =
        w.f.agents
            .create_conversation(&w.f.project_id, AgentId::OpenCode, None)
            .unwrap();
    let forged = ContextRef::new(ContextKind::SessionTurn, format!("{}/{}", other.id, run.id));
    assert!(matches!(
        w.context
            .read(&w.f.project_id, &forged, Detail::Content, None),
        Err(ContextError::NotFound)
    ));
}

#[test]
fn long_sessions_paginate_their_turns() {
    let w = world();
    let session =
        w.f.agents
            .create_conversation(&w.f.project_id, AgentId::OpenCode, Some("Long"))
            .unwrap();
    for n in 0..(TURN_PAGE + 3) {
        let run =
            w.f.agents
                .start_run(
                    &session.id,
                    &w.f.project_id,
                    &format!("turn {n}"),
                    PermissionMode::Safe,
                )
                .unwrap();
        w.f.agents
            .set_run_status(&run.id, crate::agent_store::RunStatus::Completed)
            .unwrap();
    }
    let reference = ContextRef::new(ContextKind::Session, &session.id);
    let first = w.read(&reference, Detail::Content);
    assert_eq!(first.related.len(), TURN_PAGE);
    let cursor = first.next_cursor.clone().expect("older turns remain");
    let second = w
        .context
        .read(&w.f.project_id, &reference, Detail::Content, Some(&cursor))
        .unwrap();
    assert_eq!(second.related.len(), 3);
    assert!(second.next_cursor.is_none());
    assert!(matches!(
        w.context
            .read(&w.f.project_id, &reference, Detail::Content, Some("!!")),
        Err(ContextError::Invalid(_))
    ));
}

#[test]
fn experiments_and_artifacts_resolve_under_the_execution_root() {
    let w = world();
    let experiment = w.finished_experiment(
        "out/result.txt".trim_start_matches("out/"),
        "accuracy=0.91\n",
    );
    let items = w.kinds(ContextKind::Experiment);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].title, "baseline");
    let doc = w.read(&items[0].reference, Detail::Evidence);
    let text = w.text(&doc);
    assert!(text.contains("exit code 0"));
    assert!(text.contains("result.txt (unchanged)"));
    let artifact = ContextRef::new(
        ContextKind::Artifact,
        format!("{}/result.txt", experiment.id),
    );
    let doc = w.read(&artifact, Detail::Content);
    assert!(w.text(&doc).contains("accuracy=0.91"));
    let recorded = w.kinds(ContextKind::Artifact);
    assert_eq!(recorded.len(), 1);
    let root = w.f.workspace.project_path(&w.f.project_id).unwrap();
    // Changed content is reported against the recorded revision.
    fs::write(root.join("result.txt"), "accuracy=0.50\n").unwrap();
    let pinned = recorded[0].reference.clone();
    let resolved = w
        .context
        .resolve(&w.f.project_id, std::slice::from_ref(&pinned))
        .unwrap();
    assert_eq!(resolved[0].availability, Availability::Changed);
    assert!(
        w.text(&w.read(&pinned, Detail::Content))
            .contains("accuracy=0.50")
    );
    fs::remove_file(root.join("result.txt")).unwrap();
    let resolved = w.context.resolve(&w.f.project_id, &[pinned]).unwrap();
    assert_eq!(resolved[0].availability, Availability::Removed);
}

#[test]
fn artifact_reads_are_bounded_and_cannot_escape() {
    let w = world();
    let experiment = w.finished_experiment("big.txt", &"x".repeat(100_000));
    let reference = ContextRef::new(ContextKind::Artifact, format!("{}/big.txt", experiment.id));
    let doc = w.read(&reference, Detail::Content);
    let content = doc
        .sections
        .iter()
        .find(|s| s.heading == "Content")
        .unwrap();
    assert!(content.truncated);
    assert!(content.text.len() <= TEXT_READ_BYTES);
    assert!(doc.notes.iter().any(|n| n.contains("cut")));
    for escape in ["../outside.txt", "/etc/passwd", "big.txt/../../x"] {
        let reference =
            ContextRef::new(ContextKind::Artifact, format!("{}/{escape}", experiment.id));
        assert!(matches!(
            w.context
                .read(&w.f.project_id, &reference, Detail::Content, None),
            Err(ContextError::NotFound)
        ));
    }
    // Only declared artifacts are readable, even if the file exists.
    let root = w.f.workspace.project_path(&w.f.project_id).unwrap();
    fs::write(root.join("secret.txt"), "nope").unwrap();
    let undeclared = ContextRef::new(
        ContextKind::Artifact,
        format!("{}/secret.txt", experiment.id),
    );
    assert!(matches!(
        w.context
            .read(&w.f.project_id, &undeclared, Detail::Content, None),
        Err(ContextError::NotFound)
    ));
}

#[test]
fn a_symlinked_artifact_is_not_read() {
    let w = world();
    let root = w.f.workspace.project_path(&w.f.project_id).unwrap();
    let outside = root.parent().unwrap().join("outside-secret.txt");
    fs::write(&outside, "secret").unwrap();
    let experiment = w.finished_experiment("link.txt", "real");
    fs::remove_file(root.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link.txt")).unwrap();
    let reference = ContextRef::new(ContextKind::Artifact, format!("{}/link.txt", experiment.id));
    let resolved = w
        .context
        .resolve(&w.f.project_id, std::slice::from_ref(&reference))
        .unwrap();
    assert_eq!(resolved[0].availability, Availability::Removed);
    let doc = w
        .context
        .read(&w.f.project_id, &reference, Detail::Content, None);
    assert!(!matches!(&doc, Ok(d) if w.text(d).contains("secret")));
}

#[test]
fn task_and_team_reads_expose_results_without_paths() {
    let w = world();
    let team = w.read(
        &ContextRef::new(ContextKind::Team, &w.f.team.id),
        Detail::Evidence,
    );
    let text = w.text(&team);
    assert!(text.contains("Run experiments"));
    assert!(text.contains("worker"));
    assert!(
        team.related
            .iter()
            .any(|i| i.reference.kind == ContextKind::TeamTask)
    );
    let task = w.read(
        &ContextRef::new(ContextKind::TeamTask, &w.f.task_id),
        Detail::Evidence,
    );
    assert!(w.text(&task).contains("Run and report"));
    assert_eq!(task.related[0].reference.kind, ContextKind::Team);
    let root = w.f.workspace.project_path(&w.f.project_id).unwrap();
    let everything = serde_json::to_string(&(team, task)).unwrap();
    assert!(!everything.contains(root.to_str().unwrap()));
}

#[test]
fn reading_never_changes_stored_state() {
    let w = world();
    let before = (
        w.f.research.get(&w.f.project_id, &w.f.research_id).unwrap(),
        w.f.teams.get_team(&w.f.team.id).unwrap(),
        w.f.teams.get_task(&w.f.task_id).unwrap(),
    );
    for item in w.search("").items {
        let _ = w
            .context
            .read(&w.f.project_id, &item.reference, Detail::Evidence, None);
    }
    let after = (
        w.f.research.get(&w.f.project_id, &w.f.research_id).unwrap(),
        w.f.teams.get_team(&w.f.team.id).unwrap(),
        w.f.teams.get_task(&w.f.task_id).unwrap(),
    );
    assert_eq!(before, after);
}

#[test]
fn text_limits_are_enforced() {
    assert_eq!(clip("héllo", 2), ("hé".to_owned(), true));
    assert_eq!(clip("hi", 5), ("hi".to_owned(), false));
    let long = "word ".repeat(200);
    assert!(summarize(&long).chars().count() <= SUMMARY_CHARS + 1);
    assert!(ContextKind::parse("session_turn").is_some());
    assert!(ContextKind::parse("unknown").is_none());
}

#[test]
fn artifacts_of_a_worktree_team_resolve_in_its_worktree_not_the_project() {
    let w = world();
    let state_root = w.f.agents.database_directory().canonicalize().unwrap();
    let worktree = state_root
        .join("worktrees")
        .join(&w.f.project_id)
        .join("team-wt");
    fs::create_dir_all(&worktree).unwrap();
    {
        let database = w.f.agents.database();
        let connection = database.lock().unwrap();
        connection
            .execute(
                "UPDATE teams SET workspace_path = ?1 WHERE id = ?2",
                rusqlite::params![worktree.to_string_lossy(), w.f.team.id],
            )
            .unwrap();
    }
    // The Project has a decoy with the same name but different content.
    let root = w.f.workspace.project_path(&w.f.project_id).unwrap();
    fs::write(root.join("metrics.txt"), "project copy").unwrap();
    fs::write(worktree.join("metrics.txt"), "worktree copy").unwrap();
    let mut request =
        crate::experiment_store::testing::launch(&w.f.round_id, &w.f.team, "wt", &["echo", "hi"]);
    request.artifacts = vec!["metrics.txt".into()];
    let (experiment, _) =
        w.f.experiments
            .reserve(&w.f.project_id, &w.f.research_id, request)
            .unwrap();
    w.f.experiments.mark_launching(&experiment.id).unwrap();
    let revision =
        w.f.workspace
            .execution_file_revision(
                &w.f.project_id,
                Some(&worktree.to_string_lossy()),
                "metrics.txt",
            )
            .ok();
    w.f.experiments
        .observe(
            &experiment.id,
            Outcome {
                state: Some(crate::experiment_store::ExperimentState::Exited),
                exit_code: Some(0),
                artifact_revisions: vec![ArtifactRevision {
                    path: "metrics.txt".into(),
                    revision,
                }],
                ..Outcome::default()
            },
        )
        .unwrap();
    let reference = ContextRef::new(
        ContextKind::Artifact,
        format!("{}/metrics.txt", experiment.id),
    );
    let doc = w.read(&reference, Detail::Content);
    assert!(w.text(&doc).contains("worktree copy"));
    assert!(!w.text(&doc).contains("project copy"));
    let recorded = w.kinds(ContextKind::Artifact).remove(0).reference;
    let resolved = w.context.resolve(&w.f.project_id, &[recorded]).unwrap();
    assert_eq!(resolved[0].availability, Availability::Available);
}

#[test]
fn a_long_import_is_readable_in_full_one_section_at_a_time() {
    use crate::research_store::{ImportOrigin, NewImport};
    let w = world();
    // Roughly 40 KiB, with the scientifically important line at the very end.
    let filler: String = (0..800)
        .map(|n| format!("Discussion line {n:04} about the sweep.\n"))
        .collect();
    let text = format!("{filler}Limitation: results only hold below sparsity 0.7\n");
    assert!(text.chars().count() > SECTION_CHARS * 3);
    let (import, _) =
        w.f.research
            .import_source(
                &w.f.project_id,
                &w.f.research_id,
                NewImport {
                    origin: ImportOrigin::Paste,
                    label: "Long call",
                    content: &text,
                    based_on_revision: 1,
                    client_request_id: None,
                },
            )
            .unwrap();
    let reference = ContextRef::new(ContextKind::Import, &import.id);
    let mut seen = String::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let doc = w
            .context
            .read(
                &w.f.project_id,
                &reference,
                Detail::Content,
                cursor.as_deref(),
            )
            .unwrap();
        pages += 1;
        let section = doc
            .sections
            .iter()
            .find(|s| s.heading.starts_with("Imported text"))
            .expect("text section");
        assert!(section.text.chars().count() <= SECTION_CHARS);
        assert!(!section.truncated, "each page is complete, not clipped");
        seen.push_str(&section.text);
        match doc.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
        assert!(pages < 20, "pagination must terminate");
    }
    assert!(pages >= 4, "{pages}");
    // Every character of the import was delivered exactly once, in order.
    assert_eq!(seen, text.trim());
    assert!(seen.contains("results only hold below sparsity 0.7"));
    // A bad or out-of-range cursor is refused, not guessed.
    assert!(matches!(
        w.context
            .read(&w.f.project_id, &reference, Detail::Content, Some("%%%")),
        Err(ContextError::Invalid(_))
    ));
    let beyond = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        "999999999",
    );
    assert!(matches!(
        w.context
            .read(&w.f.project_id, &reference, Detail::Content, Some(&beyond)),
        Err(ContextError::Invalid(_))
    ));
}

#[test]
fn paged_import_text_keeps_every_boundary_character() {
    use crate::research_store::{ImportOrigin, NewImport};
    let w = world();
    // Page boundaries land on a newline followed by an indent, on trailing
    // spaces, and on a blank line: all of it is structure in Markdown or code.
    let first = format!("{}\n", "a".repeat(SECTION_CHARS - 1));
    let second = format!("    indented();\n{}   ", "b".repeat(SECTION_CHARS - 30));
    let third = format!("\n\n    - nested item\n{}", "c".repeat(100));
    let text = format!("{first}{second}{third}");
    let (import, _) =
        w.f.research
            .import_source(
                &w.f.project_id,
                &w.f.research_id,
                NewImport {
                    origin: ImportOrigin::Markdown,
                    label: "Boundary whitespace",
                    content: &text,
                    based_on_revision: 1,
                    client_request_id: None,
                },
            )
            .unwrap();
    let reference = ContextRef::new(ContextKind::Import, &import.id);
    let mut joined = String::new();
    let mut cursor: Option<String> = None;
    let mut starts_with_space = 0;
    let mut ends_with_space = 0;
    loop {
        let doc = w
            .context
            .read(
                &w.f.project_id,
                &reference,
                Detail::Content,
                cursor.as_deref(),
            )
            .unwrap();
        let section = doc
            .sections
            .iter()
            .find(|s| s.heading.starts_with("Imported text"))
            .unwrap();
        starts_with_space += usize::from(section.text.starts_with(char::is_whitespace));
        ends_with_space += usize::from(section.text.ends_with(char::is_whitespace));
        joined.push_str(&section.text);
        match doc.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    // Character for character: nothing at a page edge was trimmed away.
    assert_eq!(joined, text);
    assert!(
        starts_with_space >= 1 && ends_with_space >= 1,
        "the fixture must exercise page edges"
    );
}

// -- Workspace conversation and work (ADR 0216) ---------------------------------------------------

#[test]
fn a_thread_is_read_a_page_at_a_time_with_attribution_and_its_own_question() {
    use crate::channel_store::NewMessage;
    let w = world();
    let channel = w.channels.default_channel(&w.f.project_id).unwrap();
    let root = w
        .channels
        .post(
            &w.f.project_id,
            &channel.id,
            NewMessage {
                body: "Should we prune the attention heads?",
                ..Default::default()
            },
        )
        .unwrap()
        .0;
    let (thread, _) = w
        .channels
        .start_thread(&w.f.project_id, &channel.id, &root.id, None, None)
        .unwrap();
    for n in 1..=25 {
        w.channels
            .post(
                &w.f.project_id,
                &channel.id,
                NewMessage {
                    thread_id: Some(&thread.id),
                    body: &format!("reply number {n}"),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    // Other topics in the channel never leak into the Thread's context.
    w.channels
        .post(
            &w.f.project_id,
            &channel.id,
            NewMessage {
                body: "completely unrelated topic",
                ..Default::default()
            },
        )
        .unwrap();
    let reference = ContextRef::new(ContextKind::Thread, &thread.id);
    let first = w
        .context
        .read(&w.f.project_id, &reference, Detail::Content, None)
        .unwrap();
    let text = &first
        .sections
        .iter()
        .find(|s| s.heading.starts_with("Messages"))
        .unwrap()
        .text;
    assert!(text.contains("researcher: reply number 25"));
    assert!(!text.contains("unrelated"));
    assert!(first.next_cursor.is_some(), "older messages are reachable");
    assert!(first.notes.iter().any(|n| n.contains("not linked")));
    let older = w
        .context
        .read(
            &w.f.project_id,
            &reference,
            Detail::Content,
            first.next_cursor.as_deref(),
        )
        .unwrap();
    let older_text = &older
        .sections
        .iter()
        .find(|s| s.heading.starts_with("Messages"))
        .unwrap()
        .text;
    assert!(older_text.contains("Should we prune the attention heads?"));
    assert!(!older_text.contains("reply number 25"));

    // Linking carries the question into the provenance and the related items.
    w.channels
        .link_thread(&w.f.project_id, &thread.id, 1, Some(&w.f.research_id), None)
        .unwrap();
    let linked = w
        .context
        .read(&w.f.project_id, &reference, Detail::Summary, None)
        .unwrap();
    assert_eq!(
        linked.provenance.research_id.as_deref(),
        Some(w.f.research_id.as_str())
    );
    assert!(
        linked
            .related
            .iter()
            .any(|item| item.reference.kind == ContextKind::Research)
    );

    // A reference pinned before the last reply reports that it changed.
    let pinned = ContextRef::at(ContextKind::Thread, &thread.id, "stale");
    let resolved = w.context.resolve(&w.f.project_id, &[pinned]).unwrap();
    assert_eq!(resolved[0].availability, Availability::Changed);

    // Another Project cannot read it.
    let other = w.f.workspace.create_project(".", "beta").unwrap();
    assert!(matches!(
        w.context.read(&other.id, &reference, Detail::Summary, None),
        Err(ContextError::NotFound)
    ));
    // It is discoverable by search, with the channel.
    let found = w.kinds(ContextKind::Thread);
    assert_eq!(found.len(), 1);
    assert_eq!(w.kinds(ContextKind::Channel).len(), 1);
}

#[test]
fn work_is_readable_as_a_source_with_its_state_and_evidence() {
    use crate::work_store::{Actor, NewWork};
    let w = world();
    let (item, _) = w
        .work
        .create(
            &w.f.project_id,
            NewWork {
                title: "Ablate heads",
                description: "Remove each head in turn",
                plan: Some("1. baseline\n2. ablate"),
                ..Default::default()
            },
            &Actor::Researcher,
        )
        .unwrap();
    let reference = ContextRef::new(ContextKind::Work, &item.id);
    let doc = w
        .context
        .read(&w.f.project_id, &reference, Detail::Evidence, None)
        .unwrap();
    assert_eq!(doc.title, "Ablate heads");
    let headings: Vec<_> = doc.sections.iter().map(|s| s.heading.as_str()).collect();
    assert!(headings.contains(&"State"));
    assert!(headings.contains(&"Plan"));
    let found = w.kinds(ContextKind::Work);
    assert!(
        found
            .iter()
            .any(|candidate| candidate.reference.id == item.id)
    );
    let other = w.f.workspace.create_project(".", "beta").unwrap();
    assert!(matches!(
        w.context.read(&other.id, &reference, Detail::Summary, None),
        Err(ContextError::NotFound)
    ));
}
