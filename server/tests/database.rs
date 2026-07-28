use std::sync::{Arc, Barrier};

use kubecode_server::agents::AgentStore;
use kubecode_server::database::{Database, DatabaseError};
use kubecode_server::teams::{
    MemberWorkspaceMode, NewTeam, NewTeamTask, NewTeammate, TeamStore, TeamTaskStatus,
    TeamWorkspace,
};
use rusqlite::Connection;
use serde_json::json;
use tempfile::tempdir;

#[test]
fn opens_existing_wal_database_in_rollback_mode_without_losing_data() {
    let temp = tempdir().expect("tempdir");
    let path = temp.path().join("kubecode.sqlite3");
    let legacy = Connection::open(&path).expect("legacy database");
    assert_eq!(
        legacy
            .query_row("PRAGMA journal_mode = WAL", [], |row| row
                .get::<_, String>(0))
            .expect("enable WAL"),
        "wal"
    );
    legacy
        .execute_batch(
            "CREATE TABLE legacy_state(value TEXT NOT NULL);
             INSERT INTO legacy_state VALUES ('preserved');",
        )
        .expect("legacy data");
    drop(legacy);

    let database = Database::open(&path).expect("database");
    let connection = database.lock().expect("database mutex");
    assert_eq!(
        connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .expect("journal mode"),
        "delete"
    );
    assert_eq!(
        connection
            .query_row("SELECT value FROM legacy_state", [], |row| row
                .get::<_, String>(0))
            .expect("legacy value"),
        "preserved"
    );
    assert_eq!(
        connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
            .expect("foreign keys"),
        1
    );
    assert_eq!(
        connection
            .query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))
            .expect("synchronous"),
        2
    );
}

#[test]
fn only_one_server_owner_can_claim_a_state_database() {
    let temp = tempdir().expect("tempdir");
    let path = temp.path().join("kubecode.sqlite3");
    let first = Database::open_owned(&path).expect("first owner");
    assert!(matches!(
        Database::open_owned(&path),
        Err(DatabaseError::AlreadyOwned { .. })
    ));
    drop(first);
    Database::open_owned(&path).expect("replacement owner");
}

#[test]
fn shared_agent_and_team_stores_serialize_concurrent_writes() {
    let temp = tempdir().expect("tempdir");
    let database =
        Arc::new(Database::open(temp.path().join("kubecode.sqlite3")).expect("database"));
    let agents = Arc::new(AgentStore::from_database(Arc::clone(&database)).expect("agents"));
    let teams = Arc::new(TeamStore::from_database(database).expect("teams"));
    let team = teams
        .create_team(NewTeam {
            project_id: "project-1",
            leader_conversation_id: "leader-conversation",
            agent_session_id: "leader-session",
            leader_name: "Leader",
            title: Some("Contention test"),
            workspace: TeamWorkspace::Shared,
            workspace_path: None,
        })
        .expect("team");
    let leader = teams.list_members(&team.id).expect("members")[0].clone();
    let teammate = teams
        .add_teammate(NewTeammate {
            team_id: &team.id,
            caller_member_id: &leader.id,
            conversation_id: "worker-conversation",
            name: "Worker",
            workspace_mode: MemberWorkspaceMode::Shared,
            base_tree: None,
        })
        .expect("teammate");
    let task = teams
        .create_task(NewTeamTask {
            team_id: &team.id,
            creator_member_id: &leader.id,
            title: "Review under contention",
            description: "Exercise the former WAL upgrade path",
            dependencies: &[],
            owned_paths: &[],
            requires_plan_approval: false,
            mutates_files: false,
        })
        .expect("task");
    teams
        .claim_task(&task.id, &teammate.id)
        .expect("claim task");
    teams
        .submit_result(&task.id, &teammate.id, "done", "checked")
        .expect("submit result");

    let barrier = Arc::new(Barrier::new(2));
    let event_barrier = Arc::clone(&barrier);
    let event_agents = Arc::clone(&agents);
    let event_writer = std::thread::spawn(move || {
        event_barrier.wait();
        for index in 0..100 {
            event_agents
                .append_workspace_event(
                    "contention_test",
                    Some("project-1"),
                    None,
                    None,
                    &json!({"index": index}),
                )
                .expect("workspace event");
        }
    });

    barrier.wait();
    let reviewed = teams
        .review_result(&task.id, &leader.id, true, None)
        .expect("review result");
    event_writer.join().expect("event writer");

    assert_eq!(reviewed.status, TeamTaskStatus::Accepted);
}
