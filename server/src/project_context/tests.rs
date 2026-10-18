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
}

fn world() -> World {
    let f = Fixture::new();
    let context = ProjectContext::new(
        Arc::clone(&f.agents),
        Arc::clone(&f.teams),
        Arc::clone(&f.research),
        Arc::clone(&f.experiments),
        Arc::clone(&f.workspace),
    );
    World { f, context }
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
    let page = w.search("");
    let kinds: std::collections::HashSet<_> = page.items.iter().map(|i| i.reference.kind).collect();
    for kind in [
        ContextKind::Research,
        ContextKind::Round,
        ContextKind::Session,
        ContextKind::Team,
        ContextKind::TeamTask,
    ] {
        assert!(kinds.contains(&kind), "missing {kind:?}");
    }
    let research = w.kinds(ContextKind::Research);
    assert_eq!(research.len(), 1);
    assert_eq!(research[0].title, "Pruning");
    assert_eq!(research[0].reference.revision.as_deref(), Some("1"));
    let task = &w.kinds(ContextKind::TeamTask)[0];
    assert_eq!(
        task.provenance.parent.as_ref().unwrap().kind,
        ContextKind::Team
    );
}

#[test]
fn search_matches_whole_words_and_prefers_titles() {
    let w = world();
    assert_eq!(
        w.search("pruning").items[0].reference.kind,
        ContextKind::Research
    );
    assert!(w.search("zzzunmatched").items.is_empty());
    let baseline = w.search("baseline");
    assert!(
        baseline
            .items
            .iter()
            .all(|i| i.title.to_lowercase().contains("baseline")
                || i.summary.to_lowercase().contains("baseline"))
    );
}

#[test]
fn search_pages_with_an_opaque_cursor_and_caps_the_page() {
    let w = world();
    let first = w
        .context
        .search(&w.f.project_id, None, &[], Some(2), None)
        .unwrap();
    assert_eq!(first.items.len(), 2);
    let cursor = first.next_cursor.clone().expect("more results");
    let second = w
        .context
        .search(&w.f.project_id, None, &[], Some(2), Some(&cursor))
        .unwrap();
    assert!(second.items.iter().all(|i| !first.items.contains(i)));
    let huge = w
        .context
        .search(&w.f.project_id, None, &[], Some(10_000), None)
        .unwrap();
    assert!(huge.items.len() <= MAX_PAGE);
    assert!(matches!(
        w.context
            .search(&w.f.project_id, None, &[], None, Some("%%%")),
        Err(ContextError::Invalid(_))
    ));
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
