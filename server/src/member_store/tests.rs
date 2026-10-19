use std::sync::Arc;

use super::*;
use crate::experiment_store::testing::Fixture;

struct Rig {
    f: Fixture,
    members: MemberStore,
    work: crate::work_store::WorkStore,
}

fn rig() -> Rig {
    let f = Fixture::new();
    let members = MemberStore::from_database(f.agents.database(), Arc::clone(&f.agents)).unwrap();
    let work =
        crate::work_store::WorkStore::from_database(f.agents.database(), Arc::clone(&f.agents))
            .unwrap();
    Rig { f, members, work }
}

impl Rig {
    /// A native task in the Fixture's round, assigned to `session`.
    fn assigned_to(&self, session: &str) -> String {
        use crate::work_store::{Actor, CoordinatorAuth, NewWork};
        let current = self
            .work
            .coordinator(&self.f.project_id, &self.f.round_id)
            .unwrap()
            .expect("the Leader coordinates the round");
        let coordinator = Actor::Coordinator(CoordinatorAuth {
            round_id: self.f.round_id.clone(),
            holder: current.holder,
            epoch: current.epoch,
        });
        let (item, _) = self
            .work
            .create(
                &self.f.project_id,
                NewWork {
                    title: "Task",
                    description: "do it",
                    round_id: Some(&self.f.round_id),
                    ..Default::default()
                },
                &coordinator,
            )
            .unwrap();
        self.work
            .assign(
                &self.f.project_id,
                &item.id,
                session,
                None,
                "",
                &coordinator,
            )
            .unwrap();
        item.id
    }
}

const YES: &dyn Fn(AgentId) -> bool = &|_| true;
const NO: &dyn Fn(AgentId) -> bool = &|_| false;

fn conversations(r: &Rig) -> usize {
    r.f.agents
        .list_conversations(&r.f.project_id)
        .map(|list| list.len())
        .unwrap_or(0)
}

#[test]
fn a_workspace_gets_exactly_one_general_agent_however_often_it_is_asked() {
    let r = rig();
    let before = conversations(&r);
    let first = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    let again = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    assert_eq!(first.id, again.id);
    assert_eq!(first.state, MemberState::Active);
    assert_eq!(first.role, MemberRole::General);
    assert_eq!(first.handle, "general");
    assert_eq!(
        first.public_conversation_id, again.public_conversation_id,
        "a retry does not make a second Session"
    );
    assert_eq!(conversations(&r), before + 1);
    assert_eq!(r.members.list(&r.f.project_id, false).unwrap().len(), 1);
    // Another Workspace has its own.
    let other = r
        .members
        .ensure_general("other-project", YES, AgentId::OpenCode)
        .unwrap();
    assert_ne!(other.id, first.id);
}

#[test]
fn a_crash_between_the_steps_converges_and_an_unavailable_provider_is_recoverable() {
    let r = rig();
    // The provider is missing: the member exists, waiting on setup, with no Session.
    let waiting = r
        .members
        .ensure_general(&r.f.project_id, NO, AgentId::OpenCode)
        .unwrap();
    assert_eq!(waiting.state, MemberState::SetupRequired);
    assert!(waiting.public_conversation_id.is_none());
    assert!(waiting.setup_error.as_deref().unwrap().contains("opencode"));
    // The provider is fixed; the same member completes, no duplicate.
    let ready = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    assert_eq!(ready.id, waiting.id);
    assert_eq!(ready.state, MemberState::Active);
    assert!(ready.setup_error.is_none());
    // Changed defaults reach a manager that is still waiting, not an active one.
    let other = r
        .members
        .ensure_general("p2", NO, AgentId::OpenCode)
        .unwrap();
    let mut defaults = r.members.defaults(AgentId::OpenCode).unwrap();
    defaults.general.agent_id = AgentId::Codex;
    r.members.set_defaults(0, defaults).unwrap();
    let adopted = r
        .members
        .ensure_general("p2", &|agent| agent == AgentId::Codex, AgentId::OpenCode)
        .unwrap();
    assert_eq!(
        (adopted.id.as_str(), adopted.state),
        (other.id.as_str(), MemberState::Active)
    );
    assert_eq!(adopted.spec.agent_id, AgentId::Codex);
    let untouched = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    assert_eq!(untouched.spec.agent_id, AgentId::OpenCode);
}

#[test]
fn defaults_are_server_state_checked_by_revision() {
    let r = rig();
    let builtin = r.members.defaults(AgentId::OpenCode).unwrap();
    assert_eq!(builtin.revision, 0);
    assert!(builtin.general.instructions.contains("project manager"));
    let mut edited = builtin.clone();
    edited.general.config.insert("model".into(), "fast".into());
    let saved = r.members.set_defaults(0, edited.clone()).unwrap();
    assert_eq!(saved.revision, 1);
    assert!(matches!(
        r.members.set_defaults(0, edited.clone()),
        Err(MemberError::DefaultsStale { current: 1 })
    ));
    assert_eq!(
        r.members.defaults(AgentId::Codex).unwrap().general.config["model"],
        "fast"
    );
    edited.general.instructions = "x".repeat(MAX_INSTRUCTIONS_CHARS + 1);
    assert!(matches!(
        r.members.set_defaults(1, edited),
        Err(MemberError::Invalid(_))
    ));
    // The new defaults reach new Workspaces only.
    let general = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    assert_eq!(general.spec.config["model"], "fast");
}

#[test]
fn specialists_are_added_edited_and_removed_with_distinct_handles_and_replayable_requests() {
    let r = rig();
    r.members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    let new = |name: &str, key: Option<&str>| NewMember {
        name: name.into(),
        template: Some(MemberTemplate::Analysis),
        client_request_id: key.map(str::to_owned),
        ..Default::default()
    };
    let analyst = r
        .members
        .create_specialist(
            &r.f.project_id,
            new("Data Analyst", Some("k1")),
            YES,
            AgentId::OpenCode,
        )
        .unwrap();
    assert_eq!(
        (analyst.handle.as_str(), analyst.role),
        ("data-analyst", MemberRole::Specialist)
    );
    assert!(analyst.spec.instructions.contains("analysis specialist"));
    let replay = r
        .members
        .create_specialist(
            &r.f.project_id,
            new("Data Analyst", Some("k1")),
            YES,
            AgentId::OpenCode,
        )
        .unwrap();
    assert_eq!(replay.id, analyst.id, "a retried request is one member");
    for name in ["data analyst", "General", "  "] {
        assert!(
            r.members
                .create_specialist(&r.f.project_id, new(name, None), YES, AgentId::OpenCode)
                .is_err(),
            "{name}"
        );
    }
    // Responsibility and specification are separate: changing one leaves the other.
    let writer = r
        .members
        .update(
            &r.f.project_id,
            &analyst.id,
            analyst.revision,
            MemberPatch {
                template: Some(MemberTemplate::Writing),
                ..Default::default()
            },
            YES,
        )
        .unwrap();
    assert_eq!(writer.template, MemberTemplate::Writing);
    assert_eq!(writer.spec, analyst.spec);
    assert!(matches!(
        r.members.update(
            &r.f.project_id,
            &analyst.id,
            analyst.revision,
            MemberPatch::default(),
            YES
        ),
        Err(MemberError::Stale { .. })
    ));
    // Removal keeps the row, the Session history, and attribution.
    let session = writer.public_conversation_id.clone().unwrap();
    let removed = r.members.remove(&r.f.project_id, &analyst.id).unwrap();
    assert_eq!(removed.state, MemberState::Removed);
    let resolved = r
        .members
        .by_conversation(&r.f.project_id, &session)
        .unwrap()
        .unwrap();
    assert_eq!(
        (resolved.member.name.as_str(), resolved.current),
        ("Data Analyst", false)
    );
    assert_eq!(
        r.members.active_role(&r.f.project_id, &session).unwrap(),
        None
    );
    assert!(
        r.members
            .list(&r.f.project_id, false)
            .unwrap()
            .iter()
            .all(|m| m.id != analyst.id)
    );
    assert!(
        r.members
            .list(&r.f.project_id, true)
            .unwrap()
            .iter()
            .any(|m| m.id == analyst.id)
    );
    // The name can be reused by a new member; the old one stays separate.
    let again = r
        .members
        .create_specialist(
            &r.f.project_id,
            new("Data Analyst", None),
            YES,
            AgentId::OpenCode,
        )
        .unwrap();
    assert_ne!(again.id, analyst.id);
}

#[test]
fn the_general_agent_cannot_be_removed_retemplated_or_duplicated() {
    let r = rig();
    let general = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    assert!(matches!(
        r.members.remove(&r.f.project_id, &general.id),
        Err(MemberError::GeneralProtected)
    ));
    assert!(matches!(
        r.members.update(
            &r.f.project_id,
            &general.id,
            general.revision,
            MemberPatch {
                template: Some(MemberTemplate::Custom),
                ..Default::default()
            },
            YES
        ),
        Err(MemberError::GeneralProtected)
    ));
    // Its name and instructions may change; its handle and role do not.
    let renamed = r
        .members
        .update(
            &r.f.project_id,
            &general.id,
            general.revision,
            MemberPatch {
                name: Some("Project Lead".into()),
                ..Default::default()
            },
            YES,
        )
        .unwrap();
    assert_eq!(
        (renamed.handle.as_str(), renamed.role),
        ("general", MemberRole::General)
    );
    // The database itself refuses a second live General Agent.
    let duplicate = r.f.agents.database().lock().unwrap().execute(
        "INSERT INTO workspace_members (id, project_id, role, template, name, handle, spec_json)
         VALUES ('x', ?1, 'general', 'general', 'Two', 'two', '{}')",
        [&r.f.project_id],
    );
    assert!(duplicate.is_err());
}

#[test]
fn authority_is_read_from_the_roster_and_old_sessions_lose_it() {
    let r = rig();
    let general = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    let session = general.public_conversation_id.clone().unwrap();
    assert!(r.members.is_general(&r.f.project_id, &session).unwrap());
    // A stranger's Session and another Workspace's view have no role.
    let stranger =
        r.f.agents
            .create_conversation(&r.f.project_id, AgentId::OpenCode, Some("chat"))
            .unwrap()
            .id;
    assert_eq!(
        r.members.active_role(&r.f.project_id, &stranger).unwrap(),
        None
    );
    assert!(!r.members.is_general("other", &session).unwrap());
    // A replaced Session keeps its attribution and loses its authority.
    let replaced = r
        .members
        .replace_session(&r.f.project_id, &general.id, Binding::Public, None, YES)
        .unwrap();
    assert_ne!(
        replaced.public_conversation_id.as_deref(),
        Some(session.as_str())
    );
    assert!(!r.members.is_general(&r.f.project_id, &session).unwrap());
    assert!(
        r.members
            .is_general(
                &r.f.project_id,
                replaced.public_conversation_id.as_deref().unwrap()
            )
            .unwrap()
    );
    let old = r
        .members
        .by_conversation(&r.f.project_id, &session)
        .unwrap()
        .unwrap();
    assert_eq!(
        (old.member.id.as_str(), old.current),
        (general.id.as_str(), false)
    );
}

#[test]
fn a_dm_session_is_separate_from_the_public_one() {
    let r = rig();
    let general = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    let with_dm = r
        .members
        .ensure_dm_session(&r.f.project_id, &general.id, YES)
        .unwrap();
    let dm = with_dm.dm_conversation_id.clone().unwrap();
    assert_ne!(Some(&dm), with_dm.public_conversation_id.as_ref());
    assert_eq!(
        r.members
            .ensure_dm_session(&r.f.project_id, &general.id, YES)
            .unwrap()
            .dm_conversation_id,
        Some(dm.clone()),
        "asking again does not make another"
    );
    let resolved = r
        .members
        .by_conversation(&r.f.project_id, &dm)
        .unwrap()
        .unwrap();
    assert_eq!(resolved.binding, Binding::Dm);
    assert_eq!(resolved.member.id, general.id);
}

#[test]
fn a_session_is_briefed_and_configured_once_per_specification_revision() {
    let r = rig();
    let mut defaults = r.members.defaults(AgentId::OpenCode).unwrap();
    defaults
        .general
        .config
        .insert("model".into(), "fast".into());
    r.members.set_defaults(0, defaults).unwrap();
    let general = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    let session = general.public_conversation_id.clone().unwrap();
    let brief = r.members.pending_brief(&session).unwrap().unwrap();
    assert!(brief.text.contains("project manager") && brief.text.contains("@general"));
    assert!(brief.text.contains("do not perform research"));
    r.members.mark_briefed(&brief).unwrap();
    assert!(r.members.pending_brief(&session).unwrap().is_none());
    let config = r.members.pending_config(&session).unwrap().unwrap();
    assert_eq!(config.values, vec![("model".to_owned(), "fast".to_owned())]);
    r.members.mark_config_applied(&config).unwrap();
    assert!(r.members.pending_config(&session).unwrap().is_none());
    // A change to the specification asks for both again.
    r.members
        .update(
            &r.f.project_id,
            &general.id,
            general.revision,
            MemberPatch {
                spec: Some(MemberSpec {
                    instructions: "Be brief.".into(),
                    ..general.spec.clone()
                }),
                ..Default::default()
            },
            YES,
        )
        .unwrap();
    assert!(
        r.members
            .pending_brief(&session)
            .unwrap()
            .unwrap()
            .text
            .contains("Be brief.")
    );
    assert!(r.members.pending_config(&session).unwrap().is_some());
    // A private Session is told it is private.
    let with_dm = r
        .members
        .ensure_dm_session(&r.f.project_id, &general.id, YES)
        .unwrap();
    let dm_brief = r
        .members
        .pending_brief(with_dm.dm_conversation_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    assert!(dm_brief.text.contains("private conversation"));
}

#[test]
fn handles_are_ascii_slugs() {
    assert_eq!(handle_for("Data Analyst"), "data-analyst");
    assert_eq!(handle_for("  Écrivain 2 "), "crivain-2");
    assert_eq!(handle_for("??"), "");
    assert_eq!(handle_for(&"a".repeat(80)).len(), MAX_HANDLE_CHARS);
}

#[test]
fn removal_and_replacement_are_refused_while_the_member_holds_work_or_runs_an_attempt() {
    let r = rig();
    r.members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    let analyst = r
        .members
        .create_specialist(
            &r.f.project_id,
            NewMember {
                name: "Analyst".into(),
                template: Some(MemberTemplate::Analysis),
                ..Default::default()
            },
            YES,
            AgentId::OpenCode,
        )
        .unwrap();
    let session = analyst.public_conversation_id.clone().unwrap();
    let work = r.assigned_to(&session);

    let held = r.members.remove(&r.f.project_id, &analyst.id);
    assert!(matches!(held, Err(MemberError::HoldsWork)), "{held:?}");
    let before = conversations(&r);
    assert!(matches!(
        r.members
            .replace_session(&r.f.project_id, &analyst.id, Binding::Public, None, YES),
        Err(MemberError::HoldsWork)
    ));
    assert_eq!(
        conversations(&r),
        before,
        "a refused replacement leaves no Session behind"
    );

    // A running attempt is named as such.
    let attempt = r
        .work
        .begin_attempt(
            &r.f.project_id,
            &work,
            Some("k"),
            &crate::work_store::Actor::Researcher,
        )
        .unwrap();
    assert!(matches!(
        r.members
            .replace_session(&r.f.project_id, &analyst.id, Binding::Public, None, YES),
        Err(MemberError::Running)
    ));

    // Once the work ends, the member can go, with its history intact.
    r.work
        .finish_attempt(
            &r.f.project_id,
            &attempt.id,
            crate::work_store::AttemptOutcome::Failed {
                kind: None,
                error: None,
            },
            &crate::work_store::Actor::Executor {
                conversation_id: session.clone(),
            },
        )
        .unwrap();
    let current = r.work.get(&r.f.project_id, &work).unwrap();
    r.work
        .close(
            &r.f.project_id,
            &work,
            current.revision,
            crate::work_store::Closure {
                lifecycle: crate::work_store::WorkLifecycle::Canceled,
                reason: "done",
                superseded_by: None,
            },
            &crate::work_store::Actor::Researcher,
        )
        .unwrap();
    let removed = r.members.remove(&r.f.project_id, &analyst.id).unwrap();
    assert_eq!(removed.state, MemberState::Removed);
}

#[test]
fn a_member_is_limited_and_a_replacement_can_change_the_provider_and_the_old_session_stays_bound_by_the_boundary()
 {
    let r = rig();
    let general = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    let old = general.public_conversation_id.clone().unwrap();
    let replaced = r
        .members
        .replace_session(
            &r.f.project_id,
            &general.id,
            Binding::Public,
            Some(MemberSpec {
                agent_id: AgentId::Codex,
                ..general.spec.clone()
            }),
            YES,
        )
        .unwrap();
    assert_eq!(replaced.spec.agent_id, AgentId::Codex);
    assert_eq!(replaced.revision, general.revision + 1);
    assert_ne!(
        replaced.public_conversation_id.as_deref(),
        Some(old.as_str())
    );
    // The replaced Session lost the manager's authority but is still bound by its limits.
    assert!(!r.members.is_general(&r.f.project_id, &old).unwrap());
    assert!(r.members.was_general(&r.f.project_id, &old).unwrap());
    // It cannot coordinate or be assigned; the new one can coordinate.
    use crate::work_store::AssignmentGuard;
    assert!(r.members.may_coordinate(&r.f.project_id, &old).is_err());
    assert!(r.members.may_execute(&r.f.project_id, &old).is_err());
    assert!(
        r.members
            .may_coordinate(
                &r.f.project_id,
                replaced.public_conversation_id.as_deref().unwrap()
            )
            .is_ok()
    );
    assert!(
        r.members
            .may_coordinate(&r.f.project_id, "legacy-session")
            .is_ok()
    );
    // A provider that is not available is refused and leaves no Session behind.
    let count = conversations(&r);
    assert!(
        r.members
            .replace_session(&r.f.project_id, &general.id, Binding::Public, None, NO)
            .is_err()
    );
    assert_eq!(conversations(&r), count);
}

#[test]
fn a_specialist_and_a_private_session_never_coordinate_and_the_member_limit_holds() {
    use crate::work_store::AssignmentGuard;
    let r = rig();
    r.members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    let analyst = r
        .members
        .create_specialist(
            &r.f.project_id,
            NewMember {
                name: "Analyst".into(),
                ..Default::default()
            },
            YES,
            AgentId::OpenCode,
        )
        .unwrap();
    let with_dm = r
        .members
        .ensure_dm_session(&r.f.project_id, &analyst.id, YES)
        .unwrap();
    assert!(
        r.members
            .may_coordinate(
                &r.f.project_id,
                analyst.public_conversation_id.as_deref().unwrap()
            )
            .is_err()
    );
    assert!(
        r.members
            .may_coordinate(
                &r.f.project_id,
                with_dm.dm_conversation_id.as_deref().unwrap()
            )
            .is_err()
    );
    for index in 0..(MAX_MEMBERS - 2) {
        r.members
            .create_specialist(
                &r.f.project_id,
                NewMember {
                    name: format!("Member {index}"),
                    ..Default::default()
                },
                YES,
                AgentId::OpenCode,
            )
            .unwrap();
    }
    let over = r.members.create_specialist(
        &r.f.project_id,
        NewMember {
            name: "One too many".into(),
            ..Default::default()
        },
        YES,
        AgentId::OpenCode,
    );
    assert!(matches!(over, Err(MemberError::TooMany)), "{over:?}");
}

#[test]
fn a_rejected_configuration_is_a_setup_problem_that_clears_when_it_applies_and_an_edited_manager_keeps_its_edit()
 {
    let r = rig();
    let waiting = r
        .members
        .ensure_general(&r.f.project_id, NO, AgentId::OpenCode)
        .unwrap();
    // The researcher fixes the waiting manager by hand; the defaults do not overwrite that.
    let edited = r
        .members
        .update(
            &r.f.project_id,
            &waiting.id,
            waiting.revision,
            MemberPatch {
                spec: Some(MemberSpec {
                    agent_id: AgentId::Codex,
                    ..waiting.spec.clone()
                }),
                ..Default::default()
            },
            NO,
        )
        .unwrap();
    let again = r
        .members
        .ensure_general(&r.f.project_id, NO, AgentId::OpenCode)
        .unwrap();
    assert_eq!(again.spec.agent_id, AgentId::Codex, "{edited:?}");
    assert_eq!(again.setup_code.as_deref(), Some("provider_unavailable"));

    let ready = r
        .members
        .ensure_general(&r.f.project_id, YES, AgentId::OpenCode)
        .unwrap();
    assert_eq!(ready.state, MemberState::Active);
    r.members
        .record_setup_error(&ready.id, "could not set model to x: no such model\nstack")
        .unwrap();
    let flagged = r.members.get(&r.f.project_id, &ready.id).unwrap();
    assert_eq!(flagged.state, MemberState::SetupRequired);
    assert_eq!(flagged.setup_code.as_deref(), Some("config_rejected"));
    assert!(!flagged.setup_error.as_deref().unwrap().contains('\n'));
    // A configuration that later applies clears it.
    r.members
        .update(
            &r.f.project_id,
            &ready.id,
            flagged.revision,
            MemberPatch {
                spec: Some(MemberSpec {
                    config: [("model".to_owned(), "fast".to_owned())].into(),
                    ..flagged.spec.clone()
                }),
                ..Default::default()
            },
            YES,
        )
        .unwrap();
    let session = flagged.public_conversation_id.clone().unwrap();
    let pending = r.members.pending_config(&session).unwrap().unwrap();
    r.members.mark_config_applied(&pending).unwrap();
    let healed = r.members.get(&r.f.project_id, &ready.id).unwrap();
    assert_eq!(
        (healed.state, healed.setup_error, healed.setup_code),
        (MemberState::Active, None, None)
    );
}
