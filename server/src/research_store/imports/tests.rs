use std::sync::Arc;

use tempfile::TempDir;

use super::*;
use crate::agent_store::AgentStore;
use crate::workspace::WorkspaceService;

struct Rig {
    _root: TempDir,
    store: ResearchStore,
    workspace: Arc<WorkspaceService>,
    project_id: String,
    research_id: String,
}

fn rig() -> Rig {
    let root = TempDir::new().unwrap();
    let database = root.path().join("state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(root.path(), &database).unwrap());
    let project = workspace.create_project(".", "alpha").unwrap();
    let agents = Arc::new(AgentStore::open(&database).unwrap());
    let store = ResearchStore::from_database(agents.database(), agents).unwrap();
    let (question, _) = store
        .create(
            &project.id,
            ResearchBrief {
                title: "Pruning".into(),
                question: "Does it hold?".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
    Rig {
        _root: root,
        store,
        workspace,
        project_id: project.id,
        research_id: question.id,
    }
}

fn new_import<'a>(text: &'a str, request: Option<&'a str>) -> NewImport<'a> {
    NewImport {
        origin: ImportOrigin::Markdown,
        label: "Chat with a colleague",
        content: text,
        based_on_revision: 1,
        client_request_id: request,
    }
}

#[test]
fn candidates_come_from_headings_labels_lists_and_standalone_questions() {
    let text = "\
# Notes from the call

## Decisions
- Use structured pruning only
- Keep the baseline frozen

## Constraints
1. No more than 4 GPUs
2) Finish by Friday

### Open questions
- Does the effect survive a different seed?

**Hypotheses:**
* Sparsity 0.5 keeps accuracy within 1 percent

Evaluation: top-1 accuracy on the held-out split
Should we also try magnitude pruning?
Some unrelated chatter without structure.
";
    let found = extract_candidates(text);
    let of = |kind: CandidateKind| -> Vec<&str> {
        found
            .iter()
            .filter(|candidate| candidate.kind == kind)
            .map(|candidate| candidate.text.as_str())
            .collect()
    };
    assert_eq!(
        of(CandidateKind::Decision),
        vec!["Use structured pruning only", "Keep the baseline frozen"]
    );
    assert_eq!(
        of(CandidateKind::Constraint),
        vec!["No more than 4 GPUs", "Finish by Friday"]
    );
    assert_eq!(
        of(CandidateKind::OpenQuestion),
        vec!["Does the effect survive a different seed?"]
    );
    assert_eq!(
        of(CandidateKind::Hypothesis),
        vec!["Sparsity 0.5 keeps accuracy within 1 percent"]
    );
    assert_eq!(
        of(CandidateKind::EvaluationCriterion),
        vec!["top-1 accuracy on the held-out split"]
    );
    assert_eq!(
        of(CandidateKind::Question),
        vec!["Should we also try magnitude pruning?"]
    );
    // Chatter without structure suggests nothing, and lines are 1-based.
    assert!(
        !found
            .iter()
            .any(|candidate| candidate.text.contains("chatter"))
    );
    assert_eq!(found[0].line, 4);
}

#[test]
fn extraction_is_deterministic_deduplicated_and_bounded() {
    let text = "- Decision: ship it\n- Decision: ship it\n".repeat(3);
    assert_eq!(extract_candidates(&text), extract_candidates(&text));
    assert_eq!(extract_candidates(&text).len(), 1);
    let many: String = (0..500)
        .map(|n| format!("- Constraint: limit number {n}\n"))
        .collect();
    assert_eq!(extract_candidates(&many).len(), MAX_IMPORT_CANDIDATES);
    assert!(extract_candidates("").is_empty());
    let long = format!("- Decision: {}", "x".repeat(5_000));
    assert!(extract_candidates(&long)[0].text.chars().count() <= MAX_ITEM_CHARS);
}

#[test]
fn an_import_is_attributed_immutable_text_with_a_content_digest() {
    let r = rig();
    let (import, created) = r
        .store
        .import_source(
            &r.project_id,
            &r.research_id,
            new_import("  Hello\r\nworld  ", Some("req-1")),
        )
        .unwrap();
    assert!(created);
    assert_eq!(import.origin, ImportOrigin::Markdown);
    assert_eq!(import.based_on_revision, 1);
    let (stored, text) = r.store.import_by_id(&r.project_id, &import.id).unwrap();
    // Line endings are normalized and the digest is of exactly the stored text.
    assert_eq!(text, "Hello\nworld");
    assert_eq!(stored.digest, import_digest(&text));
    assert_eq!(stored.byte_count, text.len());
    // Importing changes neither the brief nor starts anything.
    let question = r.store.get(&r.project_id, &r.research_id).unwrap();
    assert_eq!(question.revision, 1);
    assert!(
        r.store
            .findings(&r.project_id, &r.research_id)
            .unwrap()
            .is_empty()
    );
    assert!(
        r.store
            .rounds(&r.project_id, &r.research_id)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_repeated_request_returns_the_original_and_a_different_text_under_it_is_refused() {
    let r = rig();
    let (first, _) = r
        .store
        .import_source(
            &r.project_id,
            &r.research_id,
            new_import("same words", Some("req-1")),
        )
        .unwrap();
    let (again, created) = r
        .store
        .import_source(
            &r.project_id,
            &r.research_id,
            new_import("same words", Some("req-1")),
        )
        .unwrap();
    assert!(!created);
    assert_eq!(first, again);
    assert!(matches!(
        r.store.import_source(
            &r.project_id,
            &r.research_id,
            new_import("other words", Some("req-1"))
        ),
        Err(ResearchError::KeyReuse)
    ));
    assert_eq!(
        r.store
            .imports(&r.project_id, &r.research_id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn imports_are_validated_bounded_and_scoped_to_their_project() {
    let r = rig();
    for bad in ["", "   \n ", "\0\0"] {
        assert!(matches!(
            r.store
                .import_source(&r.project_id, &r.research_id, new_import(bad, None)),
            Err(ResearchError::Invalid(_))
        ));
    }
    let huge = "x".repeat(MAX_IMPORT_BYTES + 1);
    assert!(matches!(
        r.store
            .import_source(&r.project_id, &r.research_id, new_import(&huge, None)),
        Err(ResearchError::Invalid(_))
    ));
    let mut no_label = new_import("text", None);
    no_label.label = "   ";
    assert!(
        r.store
            .import_source(&r.project_id, &r.research_id, no_label)
            .is_err()
    );
    let mut future = new_import("text", None);
    future.based_on_revision = 9;
    assert!(
        r.store
            .import_source(&r.project_id, &r.research_id, future)
            .is_err()
    );
    let mut zero = new_import("text", None);
    zero.based_on_revision = 0;
    assert!(
        r.store
            .import_source(&r.project_id, &r.research_id, zero)
            .is_err()
    );

    let (import, _) = r
        .store
        .import_source(&r.project_id, &r.research_id, new_import("text", None))
        .unwrap();
    let other = r.workspace.create_project(".", "beta").unwrap();
    assert!(matches!(
        r.store.import_by_id(&other.id, &import.id),
        Err(ResearchError::ImportNotFound)
    ));
    assert!(matches!(
        r.store
            .import_source(&other.id, &r.research_id, new_import("text", None)),
        Err(ResearchError::NotFound)
    ));
    r.store
        .set_archived(&r.project_id, &r.research_id, true)
        .unwrap();
    assert!(matches!(
        r.store
            .import_source(&r.project_id, &r.research_id, new_import("more", None)),
        Err(ResearchError::Archived)
    ));
}

#[test]
fn the_number_of_imports_per_question_is_capped() {
    let r = rig();
    for n in 0..MAX_IMPORTS_PER_QUESTION {
        r.store
            .import_source(
                &r.project_id,
                &r.research_id,
                new_import(&format!("text {n}"), None),
            )
            .unwrap();
    }
    assert!(matches!(
        r.store
            .import_source(&r.project_id, &r.research_id, new_import("one more", None)),
        Err(ResearchError::Invalid(_))
    ));
}
