//! Research store tests (#149): durability across a restart, immutable
//! revisions, optimistic concurrency (including a real race), idempotent
//! creates and entries, Project scoping, non-destructive archive and unlink,
//! single-RQ link cardinality, and same-transaction content-free events.

use std::sync::Arc;

use kubecode_server::agent_store::AgentStore;
use kubecode_server::database::Database;
use kubecode_server::research_store::*;
use tempfile::TempDir;

struct Env {
    root: TempDir,
    agents: Arc<AgentStore>,
    store: Arc<ResearchStore>,
}

fn open(root: &TempDir) -> (Arc<AgentStore>, Arc<ResearchStore>) {
    let path = root.path().join("state/kubecode.sqlite3");
    let database = Arc::new(Database::open(&path).expect("database"));
    let agents = Arc::new(AgentStore::from_database(Arc::clone(&database)).expect("agents"));
    let store = Arc::new(
        ResearchStore::from_database(database, Arc::clone(&agents)).expect("research store"),
    );
    (agents, store)
}

fn env() -> Env {
    let root = TempDir::new().expect("tempdir");
    let (agents, store) = open(&root);
    Env {
        root,
        agents,
        store,
    }
}

fn brief(title: &str) -> ResearchBrief {
    ResearchBrief {
        title: title.to_owned(),
        question: "Does structured pruning keep accuracy within one point?".to_owned(),
        motivation: "Inference cost dominates.".to_owned(),
        hypotheses: vec!["Late layers tolerate pruning".to_owned()],
        constraints: vec!["Single GPU".to_owned()],
        evaluation_criteria: vec!["Top-1 accuracy".to_owned()],
    }
}

fn note(body: &str) -> NewEntry {
    NewEntry {
        kind: EntryKind::Note,
        author_kind: AuthorKind::Researcher,
        author_ref: None,
        body: body.to_owned(),
        client_request_id: None,
    }
}

fn patch_title(title: &str) -> BriefPatch {
    BriefPatch {
        title: Some(title.to_owned()),
        ..BriefPatch::default()
    }
}

#[test]
fn questions_revisions_entries_and_links_survive_a_restart() {
    let env = env();
    let (question, created) = env
        .store
        .create("p1", brief("Pruning"), None)
        .expect("create");
    assert!(created);
    assert_eq!(
        (question.revision, question.status, question.archived),
        (1, ResearchStatus::Open, false)
    );
    env.store
        .update_brief(
            "p1",
            &question.id,
            1,
            &patch_title("Pruning, revised"),
            Some("tighten"),
        )
        .expect("edit");
    env.store
        .add_entry("p1", &question.id, note("First thoughts"))
        .expect("entry");
    env.store
        .link(
            "p1",
            &question.id,
            LinkKind::Session,
            "session-1",
            LinkRole::Discussion,
        )
        .expect("link");
    let id = question.id.clone();
    let Env {
        root,
        agents,
        store,
    } = env;
    drop((agents, store));

    // A fresh process opens the same file.
    let (_agents, store) = open(&root);
    let reloaded = store.get("p1", &id).expect("reload");
    assert_eq!(reloaded.revision, 2);
    assert_eq!(reloaded.brief.title, "Pruning, revised");
    let revisions = store.revisions("p1", &id).expect("revisions");
    assert_eq!(
        revisions.iter().map(|r| r.revision).collect::<Vec<_>>(),
        vec![2, 1]
    );
    assert_eq!(revisions[0].note.as_deref(), Some("tighten"));
    assert_eq!(
        store.revision("p1", &id, 1).expect("rev 1").brief.title,
        "Pruning"
    );
    assert_eq!(store.entries("p1", &id, 0, None).expect("entries").len(), 1);
    assert_eq!(store.links("p1", &id).expect("links").len(), 1);
}

#[test]
fn stale_edits_are_reported_and_never_overwrite() {
    let env = env();
    let (question, _) = env
        .store
        .create("p1", brief("Original"), None)
        .expect("create");
    env.store
        .update_brief("p1", &question.id, 1, &patch_title("Edit A"), None)
        .expect("first edit wins");
    let error = env
        .store
        .update_brief("p1", &question.id, 1, &patch_title("Edit B"), None)
        .expect_err("stale expected revision");
    assert!(matches!(
        error,
        ResearchError::RevisionConflict { current: 2 }
    ));
    let current = env.store.get("p1", &question.id).expect("get");
    assert_eq!(
        (current.revision, current.brief.title.as_str()),
        (2, "Edit A")
    );
    // The loser's text was not stored anywhere.
    assert_eq!(
        env.store.revisions("p1", &question.id).expect("revs").len(),
        2
    );
}

#[test]
fn concurrent_edits_from_the_same_revision_have_exactly_one_winner() {
    let env = env();
    let (question, _) = env.store.create("p1", brief("Race"), None).expect("create");
    let outcomes: Vec<bool> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let store = Arc::clone(&env.store);
                let id = question.id.clone();
                scope.spawn(move || {
                    store
                        .update_brief("p1", &id, 1, &patch_title(&format!("Writer {index}")), None)
                        .is_ok()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("thread"))
            .collect()
    });
    assert_eq!(outcomes.iter().filter(|won| **won).count(), 1);
    assert_eq!(env.store.get("p1", &question.id).expect("get").revision, 2);
    assert_eq!(
        env.store.revisions("p1", &question.id).expect("revs").len(),
        2
    );
}

#[test]
fn unchanged_edits_write_no_revision_and_no_event() {
    let env = env();
    let (question, _) = env.store.create("p1", brief("Same"), None).expect("create");
    let before = env.agents.latest_workspace_event_id().expect("cursor");
    let (unchanged, changed) = env
        .store
        .update_brief("p1", &question.id, 1, &patch_title("  Same  "), None)
        .expect("noop");
    assert!(!changed);
    assert_eq!(unchanged.revision, 1);
    assert_eq!(
        env.agents.latest_workspace_event_id().expect("cursor"),
        before
    );
}

#[test]
fn invalid_briefs_and_notes_are_rejected_without_side_effects() {
    let env = env();
    assert!(matches!(
        env.store.create("p1", brief("  "), None),
        Err(ResearchError::Invalid(_))
    ));
    let (question, _) = env.store.create("p1", brief("Fine"), None).expect("create");
    assert!(
        env.store
            .update_brief("p1", &question.id, 1, &patch_title(&"t".repeat(201)), None)
            .is_err()
    );
    assert!(
        env.store
            .update_brief(
                "p1",
                &question.id,
                1,
                &patch_title("Ok"),
                Some(&"n".repeat(501))
            )
            .is_err()
    );
    assert_eq!(env.store.get("p1", &question.id).expect("get").revision, 1);
}

#[test]
fn creates_are_idempotent_per_project_by_client_request_id() {
    let env = env();
    let (first, created) = env
        .store
        .create("p1", brief("Once"), Some("req-1"))
        .expect("create");
    assert!(created);
    let (replay, created_again) = env
        .store
        .create("p1", brief("Ignored"), Some("req-1"))
        .expect("replay");
    assert!(!created_again);
    assert_eq!(replay.id, first.id);
    assert_eq!(replay.brief.title, "Once");
    // The same key in another Project is a different request.
    let (other, created_other) = env
        .store
        .create("p2", brief("Other"), Some("req-1"))
        .expect("other");
    assert!(created_other);
    assert_ne!(other.id, first.id);
    assert_eq!(env.store.list("p1", false).expect("list").len(), 1);
}

#[test]
fn every_lookup_is_scoped_to_its_project() {
    let env = env();
    let (question, _) = env
        .store
        .create("p1", brief("Private"), None)
        .expect("create");
    assert!(matches!(
        env.store.get("p2", &question.id),
        Err(ResearchError::NotFound)
    ));
    assert!(matches!(
        env.store
            .update_brief("p2", &question.id, 1, &patch_title("Hijack"), None),
        Err(ResearchError::NotFound)
    ));
    assert!(matches!(
        env.store.entries("p2", &question.id, 0, None),
        Err(ResearchError::NotFound)
    ));
    assert!(matches!(
        env.store.revisions("p2", &question.id),
        Err(ResearchError::NotFound)
    ));
    assert!(matches!(
        env.store.link(
            "p2",
            &question.id,
            LinkKind::Session,
            "s",
            LinkRole::Discussion
        ),
        Err(ResearchError::NotFound)
    ));
    assert!(env.store.list("p2", true).expect("list").is_empty());
}

#[test]
fn archive_is_reversible_blocks_writes_and_deletes_nothing() {
    let env = env();
    let (question, _) = env
        .store
        .create("p1", brief("Archive me"), None)
        .expect("create");
    env.store
        .add_entry("p1", &question.id, note("keep"))
        .expect("entry");
    env.store
        .link(
            "p1",
            &question.id,
            LinkKind::Session,
            "s1",
            LinkRole::Discussion,
        )
        .expect("link");
    let archived = env
        .store
        .set_archived("p1", &question.id, true)
        .expect("archive");
    assert!(archived.archived);
    assert!(env.store.list("p1", false).expect("list").is_empty());
    assert_eq!(env.store.list("p1", true).expect("list all").len(), 1);
    // Reads still work; writes are refused until restored.
    assert_eq!(
        env.store
            .entries("p1", &question.id, 0, None)
            .expect("entries")
            .len(),
        1
    );
    assert!(matches!(
        env.store
            .update_brief("p1", &question.id, 1, &patch_title("No"), None),
        Err(ResearchError::Archived)
    ));
    assert!(matches!(
        env.store.add_entry("p1", &question.id, note("no")),
        Err(ResearchError::Archived)
    ));
    assert!(matches!(
        env.store.link(
            "p1",
            &question.id,
            LinkKind::Team,
            "t1",
            LinkRole::Execution
        ),
        Err(ResearchError::Archived)
    ));
    // Unlinking stays possible so a Session can be released.
    assert!(
        env.store
            .unlink("p1", &question.id, LinkKind::Session, "s1")
            .expect("unlink")
    );
    let restored = env
        .store
        .set_archived("p1", &question.id, false)
        .expect("restore");
    assert!(!restored.archived);
    assert_eq!(
        env.store
            .entries("p1", &question.id, 0, None)
            .expect("entries")
            .len(),
        1
    );
}

#[test]
fn status_changes_are_researcher_commands_and_idempotent() {
    let env = env();
    let (question, _) = env
        .store
        .create("p1", brief("Decide"), None)
        .expect("create");
    let resolved = env
        .store
        .set_status("p1", &question.id, ResearchStatus::Resolved)
        .expect("resolve");
    assert_eq!(resolved.status, ResearchStatus::Resolved);
    assert!(resolved.resolved_at.is_some());
    let before = env.agents.latest_workspace_event_id().expect("cursor");
    env.store
        .set_status("p1", &question.id, ResearchStatus::Resolved)
        .expect("again");
    assert_eq!(
        env.agents.latest_workspace_event_id().expect("cursor"),
        before
    );
    let reopened = env
        .store
        .set_status("p1", &question.id, ResearchStatus::Open)
        .expect("reopen");
    assert_eq!(
        (reopened.status, reopened.resolved_at),
        (ResearchStatus::Open, None)
    );
    // Status changes never create a brief revision.
    assert_eq!(env.store.get("p1", &question.id).expect("get").revision, 1);
}

#[test]
fn entries_are_sequenced_attributed_idempotent_and_paged() {
    let env = env();
    let (question, _) = env.store.create("p1", brief("Log"), None).expect("create");
    env.store
        .add_entry("p1", &question.id, note("one"))
        .expect("one");
    env.store
        .update_brief("p1", &question.id, 1, &patch_title("Log v2"), None)
        .expect("edit");
    let decision = env
        .store
        .add_entry(
            "p1",
            &question.id,
            NewEntry {
                kind: EntryKind::Decision,
                client_request_id: Some("dec-1".into()),
                ..note("  Drop approach B  ")
            },
        )
        .expect("decision");
    assert_eq!(
        (
            decision.seq,
            decision.brief_revision,
            decision.body.as_str()
        ),
        (2, 2, "Drop approach B")
    );
    assert_eq!(decision.author_kind, AuthorKind::Researcher);
    let replay = env
        .store
        .add_entry(
            "p1",
            &question.id,
            NewEntry {
                kind: EntryKind::Decision,
                client_request_id: Some("dec-1".into()),
                ..note("ignored")
            },
        )
        .expect("replay");
    assert_eq!(replay.id, decision.id);
    assert_eq!(
        env.store
            .entries("p1", &question.id, 0, None)
            .expect("all")
            .len(),
        2
    );
    assert_eq!(
        env.store
            .entries("p1", &question.id, 1, None)
            .expect("after 1")[0]
            .seq,
        2
    );
    assert_eq!(
        env.store
            .entries("p1", &question.id, 0, Some(1))
            .expect("limit")
            .len(),
        1
    );
    assert!(
        env.store
            .add_entry("p1", &question.id, note("   "))
            .is_err()
    );
    assert!(
        env.store
            .add_entry("p1", &question.id, note(&"x".repeat(8_193)))
            .is_err()
    );
}

#[test]
fn a_session_or_team_is_linked_to_at_most_one_question() {
    let env = env();
    let (first, _) = env.store.create("p1", brief("First"), None).expect("first");
    let (second, _) = env
        .store
        .create("p1", brief("Second"), None)
        .expect("second");
    let link = env
        .store
        .link(
            "p1",
            &first.id,
            LinkKind::Session,
            "s1",
            LinkRole::Discussion,
        )
        .expect("link");
    assert_eq!(link.role, LinkRole::Discussion);
    // Idempotent for the same target; a new role updates it.
    env.store
        .link(
            "p1",
            &first.id,
            LinkKind::Session,
            "s1",
            LinkRole::Discussion,
        )
        .expect("same");
    let upgraded = env
        .store
        .link(
            "p1",
            &first.id,
            LinkKind::Session,
            "s1",
            LinkRole::Execution,
        )
        .expect("role change");
    assert_eq!(upgraded.role, LinkRole::Execution);
    // Never a silent move to another question.
    assert!(matches!(
        env.store.link(
            "p1",
            &second.id,
            LinkKind::Session,
            "s1",
            LinkRole::Discussion
        ),
        Err(ResearchError::LinkConflict { .. })
    ));
    // A Session and a Team with the same id string are different targets.
    env.store
        .link("p1", &second.id, LinkKind::Team, "s1", LinkRole::Execution)
        .expect("team with same id");
    let (project, found) = env
        .store
        .link_for(LinkKind::Session, "s1")
        .expect("link_for")
        .expect("found");
    assert_eq!(
        (project.as_str(), found.research_id.as_str()),
        ("p1", first.id.as_str())
    );
    assert!(
        env.store
            .link_for(LinkKind::Session, "nope")
            .expect("none")
            .is_none()
    );
    // After unlinking, the other question can claim it.
    assert!(
        env.store
            .unlink("p1", &first.id, LinkKind::Session, "s1")
            .expect("unlink")
    );
    assert!(
        !env.store
            .unlink("p1", &first.id, LinkKind::Session, "s1")
            .expect("repeat")
    );
    env.store
        .link(
            "p1",
            &second.id,
            LinkKind::Session,
            "s1",
            LinkRole::Discussion,
        )
        .expect("claimed");
}

#[test]
fn mutations_publish_content_free_events_in_the_same_transaction() {
    let env = env();
    let start = env.agents.latest_workspace_event_id().expect("cursor");
    let (question, _) = env
        .store
        .create("p1", brief("Secret hypothesis"), None)
        .expect("create");
    env.store
        .update_brief("p1", &question.id, 1, &patch_title("Another secret"), None)
        .expect("edit");
    env.store
        .add_entry("p1", &question.id, note("private reasoning"))
        .expect("entry");
    env.store
        .link(
            "p1",
            &question.id,
            LinkKind::Session,
            "s1",
            LinkRole::Discussion,
        )
        .expect("link");
    env.store
        .unlink("p1", &question.id, LinkKind::Session, "s1")
        .expect("unlink");
    env.store
        .set_archived("p1", &question.id, true)
        .expect("archive");
    env.store
        .set_archived("p1", &question.id, false)
        .expect("restore");
    env.store
        .set_status("p1", &question.id, ResearchStatus::Resolved)
        .expect("resolve");
    let events = env.agents.workspace_events_after(start).expect("events");
    let changes: Vec<&str> = events
        .iter()
        .map(|event| event.payload["change"].as_str().expect("change"))
        .collect();
    assert_eq!(
        changes,
        vec![
            "created", "brief", "entry", "link", "unlink", "archived", "restored", "status"
        ]
    );
    for event in &events {
        assert_eq!(event.kind, "research_updated");
        assert_eq!(event.project_id.as_deref(), Some("p1"));
        assert_eq!(event.payload["research_id"], question.id.as_str());
        let rendered = event.payload.to_string();
        assert!(!rendered.contains("secret") && !rendered.contains("private"));
    }
    // A failed write publishes nothing.
    let cursor = env.agents.latest_workspace_event_id().expect("cursor");
    let _ = env
        .store
        .update_brief("p1", &question.id, 99, &patch_title("x"), None);
    assert_eq!(
        env.agents.latest_workspace_event_id().expect("cursor"),
        cursor
    );
}

// -- Rounds (#150) ---------------------------------------------------------------

fn new_round<'a>(key: &'a str, expected: u64, request: serde_json::Value) -> NewRound<'a> {
    NewRound {
        kind: RoundKind::Team,
        idempotency_key: key,
        expected_revision: expected,
        request,
        sources: vec![SourceRef {
            kind: SourceKind::Session,
            id: "s1".into(),
            revision: None,
        }],
    }
}

#[test]
fn rounds_pin_the_brief_revision_and_replay_by_key() {
    let env = env();
    let (question, _) = env
        .store
        .create("p1", brief("Rounds"), None)
        .expect("create");
    let request = serde_json::json!({"fingerprint": "a", "instruction": "run the baseline"});
    let (first, created) = env
        .store
        .begin_round("p1", &question.id, new_round("k1", 1, request.clone()))
        .expect("begin");
    assert!(created);
    assert_eq!(
        (first.round, first.brief_revision, first.phase),
        (1, 1, RoundPhase::Created)
    );

    // The brief changes afterwards; the round still names the revision it
    // consumed, and the immutable revision keeps the old text.
    env.store
        .update_brief("p1", &question.id, 1, &patch_title("Rounds, edited"), None)
        .expect("edit");
    let pinned = env
        .store
        .revision("p1", &question.id, first.brief_revision)
        .expect("pinned");
    assert_eq!(pinned.brief.title, "Rounds");

    // A replay returns the original round even though the brief moved on.
    let (replay, created_again) = env
        .store
        .begin_round("p1", &question.id, new_round("k1", 1, request.clone()))
        .expect("replay");
    assert!(!created_again);
    assert_eq!(
        (replay.id.as_str(), replay.brief_revision),
        (first.id.as_str(), 1)
    );

    // The same key for a different request is refused.
    assert!(matches!(
        env.store.begin_round(
            "p1",
            &question.id,
            new_round(
                "k1",
                1,
                serde_json::json!({"fingerprint": "b", "instruction": "something else"})
            )
        ),
        Err(ResearchError::KeyReuse)
    ));

    // A new round must be created against the revision the researcher saw.
    assert!(matches!(
        env.store
            .begin_round("p1", &question.id, new_round("k2", 1, request.clone())),
        Err(ResearchError::RevisionConflict { current: 2 })
    ));
    let (second, _) = env
        .store
        .begin_round("p1", &question.id, new_round("k2", 2, request))
        .expect("second round");
    assert_eq!((second.round, second.brief_revision), (2, 2));
    assert_eq!(env.store.rounds("p1", &question.id).expect("list").len(), 2);
}

#[test]
fn round_phases_advance_once_and_attach_exactly_one_team() {
    let env = env();
    let (question, _) = env
        .store
        .create("p1", brief("Phases"), None)
        .expect("create");
    let (round, _) = env
        .store
        .begin_round(
            "p1",
            &question.id,
            new_round("k1", 1, serde_json::json!({})),
        )
        .expect("begin");
    let ready = env
        .store
        .round_set_session("p1", &question.id, &round.id, "leader-1")
        .expect("session");
    assert_eq!(ready.phase, RoundPhase::SessionReady);
    // Idempotent for the same Session; a different Session is refused.
    env.store
        .round_set_session("p1", &question.id, &round.id, "leader-1")
        .expect("same");
    assert!(matches!(
        env.store
            .round_set_session("p1", &question.id, &round.id, "other"),
        Err(ResearchError::RoundState(_))
    ));
    let attached = env
        .store
        .round_attach_team("p1", &question.id, &round.id, "team-1")
        .expect("team");
    assert_eq!(
        (attached.phase, attached.team_id.as_deref()),
        (RoundPhase::TeamCreated, Some("team-1"))
    );
    env.store
        .round_attach_team("p1", &question.id, &round.id, "team-1")
        .expect("same team");
    assert!(matches!(
        env.store
            .round_attach_team("p1", &question.id, &round.id, "team-2"),
        Err(ResearchError::RoundState(_))
    ));
    // The Team is linked as execution and findable by the Team id.
    let links = env.store.links("p1", &question.id).expect("links");
    assert_eq!(
        (links[0].kind, links[0].role),
        (LinkKind::Team, LinkRole::Execution)
    );
    let (project, owner) = env
        .store
        .round_for_team("team-1")
        .expect("lookup")
        .expect("owner");
    assert_eq!(
        (project.as_str(), owner.id.as_str()),
        ("p1", round.id.as_str())
    );

    // Starting is recorded once and logged once.
    let before = env.agents.latest_workspace_event_id().expect("cursor");
    let started = env
        .store
        .round_mark_started("p1", &question.id, &round.id)
        .expect("start");
    assert_eq!(started.phase, RoundPhase::Started);
    env.store
        .round_mark_started("p1", &question.id, &round.id)
        .expect("again");
    let entries = env
        .store
        .entries("p1", &question.id, 0, None)
        .expect("entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].author_kind, AuthorKind::System);
    assert_eq!(entries[0].body, "Round 1 started with brief revision 1.");
    assert_eq!(
        env.agents
            .workspace_events_after(before)
            .expect("events")
            .len(),
        1
    );
    // Once started, a round takes no more Teams.
    assert!(
        env.store
            .round_attach_team("p1", &question.id, &round.id, "team-3")
            .is_err()
    );
}

#[test]
fn solo_rounds_link_their_session_without_stealing_existing_roles() {
    let env = env();
    let (question, _) = env.store.create("p1", brief("Solo"), None).expect("create");
    env.store
        .link(
            "p1",
            &question.id,
            LinkKind::Session,
            "discussion-1",
            LinkRole::Discussion,
        )
        .expect("link");
    let solo = |key: &'static str| NewRound {
        kind: RoundKind::Solo,
        idempotency_key: key,
        expected_revision: 1,
        request: serde_json::json!({}),
        sources: Vec::new(),
    };
    let (existing, _) = env
        .store
        .begin_round("p1", &question.id, solo("a"))
        .expect("a");
    env.store
        .round_set_session("p1", &question.id, &existing.id, "discussion-1")
        .expect("existing");
    let (fresh, _) = env
        .store
        .begin_round("p1", &question.id, solo("b"))
        .expect("b");
    env.store
        .round_set_session("p1", &question.id, &fresh.id, "new-solo")
        .expect("fresh");
    let links = env.store.links("p1", &question.id).expect("links");
    let role = |id: &str| links.iter().find(|l| l.ref_id == id).map(|l| l.role);
    assert_eq!(
        role("discussion-1"),
        Some(LinkRole::Discussion),
        "an existing role is kept"
    );
    assert_eq!(role("new-solo"), Some(LinkRole::Execution));
    // A Solo round cannot take a Team.
    assert!(
        env.store
            .round_attach_team("p1", &question.id, &fresh.id, "t")
            .is_err()
    );
}

#[test]
fn archived_and_foreign_questions_take_no_new_rounds() {
    let env = env();
    let (question, _) = env
        .store
        .create("p1", brief("Closed"), None)
        .expect("create");
    let (round, _) = env
        .store
        .begin_round(
            "p1",
            &question.id,
            new_round("k1", 1, serde_json::json!({})),
        )
        .expect("begin");
    env.store
        .set_archived("p1", &question.id, true)
        .expect("archive");
    assert!(matches!(
        env.store.begin_round(
            "p1",
            &question.id,
            new_round("k2", 1, serde_json::json!({}))
        ),
        Err(ResearchError::Archived)
    ));
    // An existing round can still be replayed while archived.
    assert!(
        !env.store
            .begin_round(
                "p1",
                &question.id,
                new_round("k1", 1, serde_json::json!({}))
            )
            .expect("replay")
            .1
    );
    assert!(matches!(
        env.store.round("p2", &question.id, &round.id),
        Err(ResearchError::NotFound)
    ));
    assert!(matches!(
        env.store.round("p1", &question.id, "missing"),
        Err(ResearchError::RoundNotFound)
    ));
}
