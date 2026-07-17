use kubecode_server::teams::{
    MemberManagementPolicy, MemberWorkspaceMode, NewDiscriminator, NewTeam,
    NewTeamPermissionRequest, NewTeamProposal, NewTeamTask, NewTeammate, StartTeam,
    TeamLifecycleOperationKind, TeamLifecycleOperationStatus, TeamMessageDeliveryStatus, TeamMode,
    TeamPermissionStatus, TeamProposalStatus, TeamRole, TeamStatus, TeamStore,
    TeamTaskAttemptStatus, TeamTaskFailureKind, TeamTaskStatus, TeamWorkspace,
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
    assert_eq!(team.status, TeamStatus::Draft);
    assert_eq!(team.requested_mode, TeamMode::Standard);
    assert_eq!(team.mode, TeamMode::Standard);
    assert!(team.mode_fallback.is_none());
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
fn starts_a_draft_with_an_explicit_goal_and_bounded_autonomy() {
    let (temp, store) = store();
    let team = store
        .create_team(NewTeam {
            project_id: "project-1",
            leader_conversation_id: "conversation-lead",
            agent_session_id: "session-lead",
            leader_name: "lead",
            title: Some("Reproduce the paper"),
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    let leader = store.list_members(&team.id).expect("members")[0].clone();
    let criteria = vec![
        "Tests pass".to_owned(),
        "Results are reproducible".to_owned(),
    ];
    let agents = vec!["codex".to_owned(), "claude_code".to_owned()];

    let started = store
        .start_team(StartTeam {
            team_id: &team.id,
            leader_member_id: &leader.id,
            goal: "Reproduce the published experiment",
            acceptance_criteria: &criteria,
            allowed_agent_ids: &agents,
            mode: TeamMode::Yolo,
            max_teammates: 3,
            max_parallel_runs: 2,
            max_review_rounds: 4,
        })
        .expect("start team");

    assert_eq!(started.status, TeamStatus::Starting);
    assert_eq!(started.requested_mode, TeamMode::Yolo);
    assert_eq!(started.mode, TeamMode::Yolo);
    assert_eq!(started.goal, "Reproduce the published experiment");
    assert_eq!(started.acceptance_criteria, criteria);
    assert_eq!(started.allowed_agent_ids, agents);
    assert_eq!(started.max_teammates, 3);
    assert_eq!(started.max_parallel_runs, 2);
    assert_eq!(started.max_review_rounds, 4);
    assert!(started.started_at.is_some());
    assert_eq!(
        store.activate_team(&team.id).expect("activate").status,
        TeamStatus::Active
    );

    let marked = store
        .mark_permission_profile_applied(&leader.id, Some("agent"))
        .expect("mark native profile");
    assert!(marked.permission_profile_applied);
    assert_eq!(marked.previous_permission_mode.as_deref(), Some("agent"));

    let fallback = store
        .downgrade_to_standard(
            &team.id,
            "claude_code",
            "native_permission_unavailable",
            "Bypass permissions is disabled by the host policy",
        )
        .expect("fallback");
    assert_eq!(fallback.requested_mode, TeamMode::Yolo);
    assert_eq!(fallback.mode, TeamMode::Standard);
    let fallback_reason = fallback.mode_fallback.expect("fallback metadata");
    assert_eq!(fallback_reason.agent_id, "claude_code");
    assert_eq!(fallback_reason.reason_code, "native_permission_unavailable");

    let restored = store
        .clear_permission_profile(&leader.id)
        .expect("clear native profile");
    assert!(!restored.permission_profile_applied);
    assert!(restored.previous_permission_mode.is_none());

    drop(store);
    let reopened =
        TeamStore::open(temp.path().join("kubecode.sqlite3")).expect("reopen team store");
    let persisted = reopened.get_team(&team.id).expect("persisted team");
    assert_eq!(persisted.requested_mode, TeamMode::Yolo);
    assert_eq!(persisted.mode, TeamMode::Standard);
    assert_eq!(
        persisted
            .mode_fallback
            .expect("persisted fallback")
            .reason_code,
        "native_permission_unavailable"
    );
    assert!(
        !reopened
            .get_member(&leader.id)
            .expect("persisted leader")
            .permission_profile_applied
    );
}

#[test]
fn leader_and_discriminator_cannot_claim_concrete_tasks() {
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
    store
        .start_team(StartTeam {
            team_id: &team.id,
            leader_member_id: &leader.id,
            goal: "Implement and independently verify the fix",
            acceptance_criteria: &["The fix is verified".to_owned()],
            allowed_agent_ids: &["codex".to_owned()],
            mode: TeamMode::Yolo,
            max_teammates: 3,
            max_parallel_runs: 2,
            max_review_rounds: 3,
        })
        .expect("start");
    store.activate_team(&team.id).expect("activate");
    let discriminator = store
        .add_discriminator(NewDiscriminator {
            team_id: &team.id,
            caller_member_id: &leader.id,
            conversation_id: "conversation-discriminator",
            name: "Verifier",
        })
        .expect("discriminator");
    let task = store
        .create_task(NewTeamTask {
            team_id: &team.id,
            creator_member_id: &leader.id,
            title: "Implement the fix",
            description: "Make the concrete code change",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: true,
        })
        .expect("task");

    assert_eq!(discriminator.role, TeamRole::Discriminator);
    assert!(store.claim_task(&task.id, &leader.id).is_err());
    assert!(store.claim_task(&task.id, &discriminator.id).is_err());
    assert!(
        store
            .delegate_task(&task.id, &leader.id, &discriminator.id)
            .is_err()
    );
}

#[test]
fn explicit_completion_requires_accepted_work_and_a_yolo_verdict() {
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
    let criteria = vec!["The regression is fixed".to_owned()];
    let agents = vec!["codex".to_owned()];
    store
        .start_team(StartTeam {
            team_id: &team.id,
            leader_member_id: &leader.id,
            goal: "Fix the regression",
            acceptance_criteria: &criteria,
            allowed_agent_ids: &agents,
            mode: TeamMode::Yolo,
            max_teammates: 3,
            max_parallel_runs: 2,
            max_review_rounds: 3,
        })
        .expect("start");
    store.activate_team(&team.id).expect("activate");

    assert!(
        store
            .complete_team(&team.id, &leader.id, "Done", "tree-a")
            .is_err()
    );
    assert!(
        store
            .validate_discrimination_request(&team.id, &leader.id)
            .is_err(),
        "verification must not create a Discriminator before required work is accepted",
    );
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
            title: "Fix it",
            description: "Implement and test",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: true,
        })
        .expect("task");
    store.claim_task(&task.id, &teammate.id).expect("claim");
    store
        .submit_result(&task.id, &teammate.id, "Fixed", "cargo test")
        .expect("result");
    store
        .review_result(&task.id, &leader.id, true, None)
        .expect("accept");
    assert!(
        store
            .complete_team(&team.id, &leader.id, "Done", "tree-a")
            .is_err()
    );
    store
        .validate_discrimination_request(&team.id, &leader.id)
        .expect("verification preflight");

    let discriminator = store
        .add_discriminator(NewDiscriminator {
            team_id: &team.id,
            caller_member_id: &leader.id,
            conversation_id: "conversation-verifier",
            name: "Verifier",
        })
        .expect("discriminator");
    let round = store
        .request_discrimination(&team.id, &leader.id, &discriminator.id, "tree-a")
        .expect("request review");
    store
        .submit_discrimination_verdict(
            &round.id,
            &discriminator.id,
            true,
            "All criteria passed",
            "cargo test passed",
        )
        .expect("pass");
    let completed = store
        .complete_team(&team.id, &leader.id, "Integrated and verified", "tree-a")
        .expect("complete");
    assert_eq!(completed.status, TeamStatus::Completed);
    assert_eq!(
        completed.final_summary.as_deref(),
        Some("Integrated and verified")
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
fn task_attempts_expose_missing_reports_and_structured_retryable_failures() {
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
            title: "Run the experiment",
            description: "Execute and report the result",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: false,
        })
        .expect("task");
    store
        .delegate_task(&task.id, &leader.id, &teammate.id)
        .expect("delegate");
    let queued = store
        .active_attempt_for_member(&teammate.id)
        .expect("attempt")
        .expect("queued attempt");
    assert_eq!(queued.status, TeamTaskAttemptStatus::Queued);

    let running = store
        .bind_task_attempt_run(&teammate.id, "run-1")
        .expect("bind")
        .expect("running attempt");
    assert_eq!(running.status, TeamTaskAttemptStatus::Running);
    assert_eq!(running.run_id.as_deref(), Some("run-1"));
    let needs_report = store
        .mark_attempt_needs_report(&teammate.id)
        .expect("missing report")
        .expect("attempt");
    assert_eq!(needs_report.status, TeamTaskAttemptStatus::NeedsReport);
    let failed = store
        .fail_active_attempt(
            &teammate.id,
            TeamTaskFailureKind::RateLimit,
            "429 rate limit",
        )
        .expect("failure")
        .expect("failed attempt");
    assert_eq!(failed.status, TeamTaskAttemptStatus::Failed);
    assert_eq!(failed.failure_kind, Some(TeamTaskFailureKind::RateLimit));
    assert_eq!(
        store.get_task(&task.id).expect("task").status,
        TeamTaskStatus::Failed
    );
    assert_eq!(
        store
            .retry_task(&task.id, &leader.id)
            .expect("retry")
            .status,
        TeamTaskStatus::Pending
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

#[test]
fn delivered_but_unacknowledged_messages_return_after_the_delivery_lease() {
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
            "Review the result",
        )
        .expect("message");
    store
        .mark_message_delivered(&message.id)
        .expect("delivery lease");

    assert!(
        store
            .pending_messages(&teammate.id)
            .expect("leased message")
            .is_empty()
    );
    store
        .requeue_expired_deliveries(0)
        .expect("expire delivery lease");
    let retry = store
        .pending_messages(&teammate.id)
        .expect("message available for retry");
    assert_eq!(retry.len(), 1);
    assert_eq!(retry[0].id, message.id);
    assert_eq!(retry[0].delivery_attempts, 1);
    store.read_messages(&teammate.id).expect("acknowledge");
    store
        .mark_message_delivered(&message.id)
        .expect("late delivery update");
    store
        .requeue_expired_deliveries(0)
        .expect("second lease scan");
    assert!(
        store
            .pending_messages(&teammate.id)
            .expect("acknowledged message")
            .is_empty()
    );
}

#[test]
fn lifecycle_operations_survive_member_removal_and_retry_provider_cleanup() {
    let (temp, store) = store();
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
    let operation = store
        .create_lifecycle_operation(
            &team.id,
            "project-1",
            TeamLifecycleOperationKind::ProviderCleanup,
            Some("member-removed"),
            Some("conversation-removed"),
            r#"{"agent_id":"opencode","provider_session_id":"provider-1"}"#,
        )
        .expect("cleanup operation");
    let running = store
        .mark_lifecycle_operation_running(&operation.id)
        .expect("running cleanup");
    assert_eq!(running.attempt_count, 1);
    let retrying = store
        .mark_lifecycle_operation_failed(&operation.id, "directory service unavailable")
        .expect("scheduled retry");
    assert_eq!(
        retrying.status,
        TeamLifecycleOperationStatus::RetryScheduled
    );
    assert!(retrying.next_attempt_at.is_some());
    assert_eq!(
        store
            .list_lifecycle_operations(&team.id)
            .expect("durable operations")
            .len(),
        1
    );
    let interrupted = store
        .create_lifecycle_operation(
            &team.id,
            "project-1",
            TeamLifecycleOperationKind::ProviderCleanup,
            None,
            Some("conversation-interrupted"),
            r#"{"agent_id":"codex","provider_session_id":"provider-2"}"#,
        )
        .expect("interrupted operation");
    store
        .mark_lifecycle_operation_running(&interrupted.id)
        .expect("operation in progress");
    drop(store);

    let reopened =
        TeamStore::open(temp.path().join("kubecode.sqlite3")).expect("reopen team store");
    let recovered = reopened
        .get_lifecycle_operation(&interrupted.id)
        .expect("recovered cleanup");
    assert_eq!(recovered.status, TeamLifecycleOperationStatus::Pending);
    assert!(
        reopened
            .due_lifecycle_operations()
            .expect("due cleanup")
            .iter()
            .any(|operation| operation.id == interrupted.id)
    );
}

#[test]
fn leader_user_input_requests_pause_and_resume_the_team_durably() {
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
    store
        .start_team(StartTeam {
            team_id: &team.id,
            leader_member_id: &leader.id,
            goal: "Resolve an ambiguous requirement",
            acceptance_criteria: &["The user confirms the target".to_owned()],
            allowed_agent_ids: &["codex".to_owned()],
            mode: TeamMode::Standard,
            max_teammates: 1,
            max_parallel_runs: 1,
            max_review_rounds: 1,
        })
        .expect("start");
    store.activate_team(&team.id).expect("activate");

    let request = store
        .request_user_input(
            &team.id,
            &leader.id,
            "Choose a dataset",
            "Should the Team use the public or private dataset?",
        )
        .expect("request input");
    assert_eq!(
        store.get_team(&team.id).expect("paused Team").status,
        TeamStatus::NeedsAttention
    );
    assert_eq!(
        store
            .pending_user_input_requests(&team.id)
            .expect("pending requests"),
        vec![request.clone()]
    );

    let resolved = store
        .resolve_user_input(&team.id, &request.id, "Use the public dataset")
        .expect("resolve input");
    assert_eq!(resolved.answer.as_deref(), Some("Use the public dataset"));
    assert_eq!(
        store.get_team(&team.id).expect("resumed Team").status,
        TeamStatus::Active
    );
}

#[test]
fn leader_can_cancel_concrete_work_without_assigning_the_task_to_itself() {
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
    let task = store
        .create_task(NewTeamTask {
            team_id: &team.id,
            creator_member_id: &leader.id,
            title: "Discarded direction",
            description: "This work is no longer needed",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: false,
        })
        .expect("task");

    let cancelled = store
        .cancel_task(
            &task.id,
            &leader.id,
            Some("The Leader selected another approach"),
        )
        .expect("cancel task");
    assert_eq!(cancelled.status, TeamTaskStatus::Cancelled);
    assert!(cancelled.assignee_member_id.is_none());
}
