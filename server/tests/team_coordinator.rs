use std::fs;
use std::sync::Arc;

use kubecode_server::agents::{AgentId, AgentStore};
use kubecode_server::team_coordinator::{CoordinatorError, SpawnTeammate, TeamCoordinator};
use kubecode_server::teams::{
    MemberWorkspaceMode, NewTeam, NewTeamTask, TeamError, TeamMessageKind, TeamStore, TeamWorkspace,
};
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    coordinator: TeamCoordinator,
    teams: Arc<TeamStore>,
    team_id: String,
    leader_id: String,
}

fn fixture() -> Fixture {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let database_path = state.join("kubecode.sqlite3");
    let workspace =
        Arc::new(WorkspaceService::open(&root, &database_path).expect("workspace service"));
    let agents = Arc::new(AgentStore::open(&database_path).expect("agent store"));
    let teams = Arc::new(TeamStore::open(&database_path).expect("team store"));
    let project = workspace
        .create_project_at(root.join("project"))
        .expect("project");
    let leader = agents
        .create_conversation(&project.id, AgentId::Codex, Some("Lead"))
        .expect("leader conversation");
    let team = teams
        .create_team(NewTeam {
            project_id: &project.id,
            leader_conversation_id: &leader.id,
            agent_session_id: &leader.agent_session_id,
            leader_name: "Lead",
            title: Some("Team"),
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    let coordinator = TeamCoordinator::new(
        Arc::clone(&workspace),
        Arc::clone(&agents),
        Arc::clone(&teams),
    );
    Fixture {
        _temp: temp,
        coordinator,
        teams,
        team_id: team.id,
        leader_id: team.leader_member_id,
    }
}

#[test]
fn leader_spawns_a_teammate_with_an_independent_agent_session() {
    let fixture = fixture();
    let member = fixture
        .coordinator
        .spawn_teammate(SpawnTeammate {
            team_id: &fixture.team_id,
            caller_member_id: &fixture.leader_id,
            agent_id: AgentId::ClaudeCode,
            name: "Researcher",
            workspace_mode: MemberWorkspaceMode::Shared,
        })
        .expect("spawn teammate");

    assert_eq!(member.name, "Researcher");
    let conversation = fixture
        .coordinator
        .agent_store()
        .get_conversation(&member.conversation_id)
        .expect("teammate conversation");
    assert_eq!(conversation.agent_id, AgentId::ClaudeCode);
    assert_ne!(conversation.agent_session_id, fixture.team_id);

    let denied = fixture.coordinator.spawn_teammate(SpawnTeammate {
        team_id: &fixture.team_id,
        caller_member_id: &member.id,
        agent_id: AgentId::OpenCode,
        name: "Unauthorized",
        workspace_mode: MemberWorkspaceMode::Shared,
    });
    assert!(matches!(
        denied,
        Err(CoordinatorError::Team(TeamError::LeaderRequired))
    ));
}

#[test]
fn result_submission_wakes_the_leader_through_a_persistent_mailbox() {
    let fixture = fixture();
    let member = fixture
        .coordinator
        .spawn_teammate(SpawnTeammate {
            team_id: &fixture.team_id,
            caller_member_id: &fixture.leader_id,
            agent_id: AgentId::OpenCode,
            name: "Implementer",
            workspace_mode: MemberWorkspaceMode::Shared,
        })
        .expect("spawn teammate");
    let task = fixture
        .teams
        .create_task(NewTeamTask {
            team_id: &fixture.team_id,
            creator_member_id: &fixture.leader_id,
            title: "Implement parser",
            description: "Add the parser and tests",
            dependencies: &[],
            owned_paths: &["server/src/parser.rs".into()],
            requires_plan_approval: false,
            mutates_files: true,
        })
        .expect("task");
    fixture
        .teams
        .claim_task(&task.id, &member.id)
        .expect("claim task");

    fixture
        .coordinator
        .submit_result(
            &task.id,
            &member.id,
            "Parser and tests are complete",
            Some("cargo test parser"),
        )
        .expect("submit result");

    let inbox = fixture
        .teams
        .unread_messages(&fixture.leader_id)
        .expect("leader inbox");
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].kind, TeamMessageKind::ResultReady);
    assert_eq!(inbox[0].task_id.as_deref(), Some(task.id.as_str()));
    assert_eq!(inbox[0].from_member_id, member.id);
}

#[test]
fn members_can_message_each_other_without_changing_final_authority() {
    let fixture = fixture();
    let member = fixture
        .coordinator
        .spawn_teammate(SpawnTeammate {
            team_id: &fixture.team_id,
            caller_member_id: &fixture.leader_id,
            agent_id: AgentId::ClaudeCode,
            name: "Reviewer",
            workspace_mode: MemberWorkspaceMode::Shared,
        })
        .expect("spawn teammate");

    fixture
        .teams
        .send_message(
            &fixture.team_id,
            &fixture.leader_id,
            &member.id,
            TeamMessageKind::Direct,
            None,
            "Review the API contract",
        )
        .expect("send message");

    let inbox = fixture
        .teams
        .unread_messages(&member.id)
        .expect("member inbox");
    assert_eq!(inbox.len(), 1);
    assert_eq!(inbox[0].body, "Review the API contract");
    assert_eq!(
        fixture
            .teams
            .get_team(&fixture.team_id)
            .unwrap()
            .leader_member_id,
        fixture.leader_id
    );
}

#[test]
fn leader_removes_a_teammate_and_releases_its_task() {
    let fixture = fixture();
    let member = fixture
        .coordinator
        .spawn_teammate(SpawnTeammate {
            team_id: &fixture.team_id,
            caller_member_id: &fixture.leader_id,
            agent_id: AgentId::OpenCode,
            name: "Backend Reviewer",
            workspace_mode: MemberWorkspaceMode::Shared,
        })
        .expect("spawn teammate");
    let task = fixture
        .teams
        .create_task(NewTeamTask {
            team_id: &fixture.team_id,
            creator_member_id: &fixture.leader_id,
            title: "Review backend",
            description: "Review the backend implementation",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: false,
        })
        .expect("task");
    fixture
        .teams
        .claim_task(&task.id, &member.id)
        .expect("claim task");

    fixture
        .coordinator
        .remove_teammate(&fixture.team_id, &fixture.leader_id, &member.id)
        .expect("remove teammate");

    assert!(matches!(
        fixture.teams.get_member(&member.id),
        Err(TeamError::MemberNotFound(_))
    ));
    assert!(
        fixture
            .coordinator
            .agent_store()
            .get_conversation(&member.conversation_id)
            .is_err()
    );
    let released = fixture.teams.get_task(&task.id).expect("released task");
    assert_eq!(
        released.status,
        kubecode_server::teams::TeamTaskStatus::Pending
    );
    assert_eq!(released.assignee_member_id, None);
}
