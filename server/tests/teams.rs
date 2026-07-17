use kubecode_server::teams::{
    MemberManagementPolicy, MemberWorkspaceMode, NewTeam, NewTeamPermissionRequest,
    NewTeamProposal, NewTeamTask, NewTeammate, TeamMessageDeliveryStatus, TeamPermissionStatus,
    TeamProposalStatus, TeamRole, TeamStore, TeamTaskStatus, TeamWorkspace,
};
use tempfile::TempDir;

fn store() -> (TempDir, TeamStore) {
    let temp = TempDir::new().expect("tempdir");
    let store = TeamStore::open(temp.path().join("kubecode.sqlite3")).expect("team store");
    (temp, store)
}

#[test]
fn routes_teammate_permissions_through_the_leader_before_the_user() {
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
    let permission = store
        .create_permission_request(NewTeamPermissionRequest {
            id: "permission-1",
            team_id: &team.id,
            member_id: &teammate.id,
            conversation_id: &teammate.conversation_id,
            run_id: "run-1",
            tool: "Write file",
            input_json: r#"{"path":"README.md"}"#,
            options_json: r#"[{"id":"allow_once"},{"id":"reject_once"}]"#,
        })
        .expect("permission");

    assert_eq!(permission.status, TeamPermissionStatus::PendingLeader);
    assert!(
        store
            .resolve_permission_as_leader(&permission.id, &teammate.id, "allow_once", None,)
            .is_err(),
    );
    let escalated = store
        .escalate_permission(
            &permission.id,
            &leader.id,
            Some("The requested command needs human review"),
        )
        .expect("escalate");
    assert_eq!(escalated.status, TeamPermissionStatus::WaitingUser);
    let resolved = store
        .resolve_permission_as_user(&permission.id, "allow_once")
        .expect("user decision")
        .expect("team permission");
    assert_eq!(resolved.status, TeamPermissionStatus::Resolved);
    assert_eq!(resolved.decided_by.as_deref(), Some("user"));
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

#[test]
fn team_runtime_settings_are_persistent_and_bounded() {
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

    assert_eq!(team.member_management_policy, MemberManagementPolicy::Ask);
    assert_eq!(team.max_parallel_runs, 3);
    let updated = store
        .update_team_settings(&team.id, MemberManagementPolicy::Auto, 8)
        .expect("settings");
    assert_eq!(
        updated.member_management_policy,
        MemberManagementPolicy::Auto
    );
    assert_eq!(updated.max_parallel_runs, 8);
    assert!(
        store
            .update_team_settings(&team.id, MemberManagementPolicy::Ask, 0)
            .is_err()
    );
}

#[test]
fn delegation_assigns_the_task_and_enqueues_one_message_atomically() {
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
            conversation_id: "conversation-worker",
            name: "worker",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("teammate");
    let task = store
        .create_task(NewTeamTask {
            team_id: &team.id,
            creator_member_id: &leader.id,
            title: "Implement runtime",
            description: "Implement the durable scheduler",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: true,
        })
        .expect("task");

    let delegated = store
        .delegate_task(&task.id, &leader.id, &teammate.id)
        .expect("delegate");
    assert_eq!(delegated.status, TeamTaskStatus::InProgress);
    assert_eq!(
        delegated.assignee_member_id.as_deref(),
        Some(teammate.id.as_str())
    );
    let messages = store
        .pending_messages(&teammate.id)
        .expect("pending messages");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].task_id.as_deref(), Some(task.id.as_str()));
    assert_eq!(
        messages[0].delivery_status,
        TeamMessageDeliveryStatus::Pending
    );

    store
        .mark_message_delivered(&messages[0].id)
        .expect("delivered");
    assert!(
        store
            .pending_messages(&teammate.id)
            .expect("pending")
            .is_empty()
    );
    let inbox = store.unread_messages(&teammate.id).expect("inbox");
    assert_eq!(
        inbox[0].delivery_status,
        TeamMessageDeliveryStatus::Delivered
    );
    let read = store.read_messages(&teammate.id).expect("read inbox");
    assert_eq!(read.len(), 1);
    assert!(
        store
            .unread_messages(&teammate.id)
            .expect("unread")
            .is_empty()
    );
}

#[test]
fn lineup_proposals_and_activity_survive_reopening_the_store() {
    let temp = TempDir::new().expect("tempdir");
    let database = temp.path().join("kubecode.sqlite3");
    let store = TeamStore::open(&database).expect("store");
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
    let proposal = store
        .create_proposal(NewTeamProposal {
            team_id: &team.id,
            summary: "Use two complementary reviewers",
            members_json: r#"[{"agent_id":"codex","purpose":"backend"}]"#,
        })
        .expect("proposal");
    store
        .resolve_proposal(&team.id, &proposal.id, TeamProposalStatus::Approved)
        .expect("approve");
    store
        .append_activity(
            &team.id,
            None,
            None,
            "proposal_approved",
            "Lineup approved",
            None,
        )
        .expect("activity");
    drop(store);

    let reopened = TeamStore::open(&database).expect("reopened");
    assert_eq!(
        reopened
            .latest_proposal(&team.id)
            .expect("proposal")
            .expect("proposal")
            .status,
        TeamProposalStatus::Approved,
    );
    assert_eq!(
        reopened
            .list_activity(&team.id, 20)
            .expect("activity")
            .len(),
        1
    );
}

#[test]
fn proposals_cannot_be_resolved_through_another_team() {
    let (_temp, store) = store();
    let first = store
        .create_team(NewTeam {
            project_id: "project-1",
            leader_conversation_id: "conversation-first",
            agent_session_id: "session-first",
            leader_name: "first",
            title: None,
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("first team");
    let second = store
        .create_team(NewTeam {
            project_id: "project-1",
            leader_conversation_id: "conversation-second",
            agent_session_id: "session-second",
            leader_name: "second",
            title: None,
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("second team");
    let proposal = store
        .create_proposal(NewTeamProposal {
            team_id: &first.id,
            summary: "Use one reviewer",
            members_json: "[]",
        })
        .expect("proposal");

    assert!(
        store
            .resolve_proposal(&second.id, &proposal.id, TeamProposalStatus::Approved)
            .is_err()
    );
    assert_eq!(
        store
            .latest_proposal(&first.id)
            .expect("proposal lookup")
            .expect("proposal")
            .status,
        TeamProposalStatus::Pending,
    );
}

#[test]
fn failed_message_delivery_stops_retrying_after_three_attempts() {
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
            conversation_id: "conversation-worker",
            name: "worker",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("teammate");
    let message = store
        .send_message(
            &team.id,
            &leader.id,
            &teammate.id,
            kubecode_server::teams::TeamMessageKind::Direct,
            None,
            "Please review the parser",
        )
        .expect("message");

    for _ in 0..3 {
        store
            .mark_message_failed(&message.id, "offline")
            .expect("failed delivery");
    }

    assert!(
        store
            .pending_messages(&teammate.id)
            .expect("pending")
            .is_empty()
    );
    let unread = store.unread_messages(&teammate.id).expect("unread");
    assert_eq!(unread[0].delivery_attempts, 3);
    assert_eq!(unread[0].delivery_status, TeamMessageDeliveryStatus::Failed);
}
