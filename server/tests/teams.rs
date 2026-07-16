use kubecode_server::teams::{
    MemberWorkspaceMode, NewTeam, NewTeamTask, NewTeammate, TeamRole, TeamStore, TeamTaskStatus,
    TeamWorkspace,
};
use tempfile::TempDir;

fn store() -> (TempDir, TeamStore) {
    let temp = TempDir::new().expect("tempdir");
    let store = TeamStore::open(temp.path().join("kubecode.sqlite3")).expect("team store");
    (temp, store)
}

#[test]
fn creates_a_team_with_a_fixed_leader() {
    let (_temp, store) = store();
    let team = store
        .create_team(NewTeam {
            project_id: "project-1",
            leader_conversation_id: "conversation-lead",
            agent_session_id: "session-lead",
            leader_name: "lead",
            title: Some("Terminal polish"),
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    let members = store.list_members(&team.id).expect("members");

    assert_eq!(members.len(), 1);
    assert_eq!(members[0].role, TeamRole::Leader);
    assert_eq!(members[0].conversation_id, "conversation-lead");
    assert_eq!(team.leader_member_id, members[0].id);
    assert_eq!(
        store
            .team_for_conversation("conversation-lead")
            .expect("lookup")
            .expect("team membership")
            .id,
        team.id,
    );
}

#[test]
fn only_the_leader_can_add_and_review_teammates() {
    let (_temp, store) = store();
    let team = store
        .create_team(NewTeam {
            project_id: "project-1",
            leader_conversation_id: "conversation-lead",
            agent_session_id: "session-lead",
            leader_name: "lead",
            title: None,
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    let leader = store.list_members(&team.id).expect("members")[0].clone();
    let teammate = store
        .add_teammate(NewTeammate {
            team_id: &team.id,
            caller_member_id: &leader.id,
            conversation_id: "conversation-reviewer",
            name: "reviewer",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("teammate");

    assert_eq!(teammate.role, TeamRole::Teammate);
    assert!(
        store
            .add_teammate(NewTeammate {
                team_id: &team.id,
                caller_member_id: &teammate.id,
                conversation_id: "conversation-illegal",
                name: "illegal",
                workspace_mode: MemberWorkspaceMode::Shared,
                base_tree: None,
            })
            .is_err(),
    );

    let task = store
        .create_task(NewTeamTask {
            team_id: &team.id,
            creator_member_id: &leader.id,
            title: "Review terminal cleanup",
            description: "Inspect the PTY exit path",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: false,
        })
        .expect("task");
    let claimed = store
        .claim_task(&task.id, &teammate.id)
        .expect("claim task");
    store
        .submit_result(&claimed.id, &teammate.id, "No races found", "cargo test")
        .expect("submit result");
    assert!(
        store
            .review_result(&claimed.id, &teammate.id, true, None)
            .is_err(),
    );
    assert_eq!(
        store
            .review_result(&claimed.id, &leader.id, true, None)
            .expect("leader accepts")
            .status,
        TeamTaskStatus::Accepted,
    );
}

#[test]
fn claiming_is_atomic_and_waits_for_dependencies() {
    let (_temp, store) = store();
    let team = store
        .create_team(NewTeam {
            project_id: "project-1",
            leader_conversation_id: "conversation-lead",
            agent_session_id: "session-lead",
            leader_name: "lead",
            title: None,
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    let leader = store.list_members(&team.id).expect("members")[0].clone();
    let first_member = store
        .add_teammate(NewTeammate {
            team_id: &team.id,
            caller_member_id: &leader.id,
            conversation_id: "conversation-first",
            name: "first",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("first member");
    let second_member = store
        .add_teammate(NewTeammate {
            team_id: &team.id,
            caller_member_id: &leader.id,
            conversation_id: "conversation-second",
            name: "second",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("second member");
    let prerequisite = store
        .create_task(NewTeamTask {
            team_id: &team.id,
            creator_member_id: &leader.id,
            title: "Explore",
            description: "Find the relevant code",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: false,
        })
        .expect("prerequisite");
    let dependent = store
        .create_task(NewTeamTask {
            team_id: &team.id,
            creator_member_id: &leader.id,
            title: "Implement",
            description: "Implement the selected approach",
            dependencies: std::slice::from_ref(&prerequisite.id),
            owned_paths: &["server/src".into()],
            requires_plan_approval: false,
            mutates_files: true,
        })
        .expect("dependent");

    assert_eq!(dependent.status, TeamTaskStatus::Blocked);
    assert!(store.claim_task(&dependent.id, &first_member.id).is_err());
    assert!(store.claim_task(&prerequisite.id, &first_member.id).is_ok());
    assert!(
        store
            .claim_task(&prerequisite.id, &second_member.id)
            .is_err()
    );
    store
        .submit_result(&prerequisite.id, &first_member.id, "Found it", "rg")
        .expect("submit prerequisite");
    store
        .review_result(&prerequisite.id, &leader.id, true, None)
        .expect("accept prerequisite");

    let tasks = store.list_tasks(&team.id).expect("tasks");
    let dependent = tasks
        .into_iter()
        .find(|task| task.id == dependent.id)
        .expect("dependent task");
    assert_eq!(dependent.status, TeamTaskStatus::Pending);
    assert!(store.claim_task(&dependent.id, &second_member.id).is_ok());
}
