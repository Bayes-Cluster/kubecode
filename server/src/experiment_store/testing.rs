//! Shared fixtures for unit tests that need a research round, an active Team
//! with a delegated task, and an execution envelope on one database.

use std::sync::Arc;

use tempfile::TempDir;

use super::*;
use crate::agent_store::AgentStore;
use crate::agents::AgentId;
use crate::research_store::{NewRound, ResearchBrief, ResearchStore, RoundKind};
use crate::teams::{
    MemberWorkspaceMode, NewTeam, NewTeamTask, NewTeammate, StartTeam, Team, TeamMember, TeamMode,
    TeamStore, TeamWorkspace,
};
use crate::workspace::WorkspaceService;

pub(crate) struct Fixture {
    pub _root: TempDir,
    pub workspace: Arc<WorkspaceService>,
    pub agents: Arc<AgentStore>,
    pub teams: Arc<TeamStore>,
    pub research: Arc<ResearchStore>,
    pub experiments: Arc<ExperimentStore>,
    pub project_id: String,
    pub research_id: String,
    pub round_id: String,
    pub team: Team,
    pub leader: TeamMember,
    pub teammate: TeamMember,
    pub task_id: String,
}

pub(crate) fn limits() -> EnvelopeLimits {
    EnvelopeLimits {
        max_launches: 3,
        max_concurrent: 2,
        deadline_at: None,
        max_runtime_secs: 60,
        max_no_progress: 2,
        allowed_commands: vec![
            vec!["python3".into(), "train.py".into()],
            vec!["echo".into()],
        ],
    }
}

pub(crate) fn launch(round_id: &str, team: &Team, key: &str, argv: &[&str]) -> NewLaunch {
    NewLaunch {
        round_id: round_id.into(),
        launch_key: key.into(),
        team_id: Some(team.id.clone()),
        task_id: None,
        owner_member_id: None,
        label: String::new(),
        argv: argv.iter().map(|token| (*token).to_owned()).collect(),
        cwd: String::new(),
        artifacts: Vec::new(),
        sources: Vec::new(),
        max_runtime_secs: None,
    }
}

impl Fixture {
    pub fn new() -> Self {
        let root = TempDir::new().expect("tempdir");
        let database = root.path().join("state/kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(root.path(), &database).expect("workspace"));
        let project = workspace.create_project(".", "alpha").expect("project");
        let agents = Arc::new(AgentStore::open(&database).expect("agents"));
        let teams = Arc::new(TeamStore::from_database(agents.database()).expect("teams"));
        let research = Arc::new(
            ResearchStore::from_database(agents.database(), Arc::clone(&agents)).expect("research"),
        );
        let experiments = Arc::new(
            ExperimentStore::from_database(agents.database(), Arc::clone(&agents))
                .expect("experiments"),
        );
        let (question, _) = research
            .create(
                &project.id,
                ResearchBrief {
                    title: "Pruning".into(),
                    question: "Does it hold?".into(),
                    ..Default::default()
                },
                None,
            )
            .expect("question");
        let leader_session = agents
            .create_conversation(&project.id, AgentId::OpenCode, Some("Lead"))
            .expect("leader session");
        let team = teams
            .create_team(NewTeam {
                project_id: &project.id,
                leader_conversation_id: &leader_session.id,
                agent_session_id: &leader_session.agent_session_id,
                leader_name: "Lead",
                title: Some("Team"),
                workspace: TeamWorkspace::Shared,
                workspace_path: None,
            })
            .expect("team");
        let leader = teams.list_members(&team.id).expect("members").remove(0);
        teams
            .start_team(StartTeam {
                team_id: &team.id,
                leader_member_id: &leader.id,
                goal: "Run experiments",
                acceptance_criteria: &["done".to_owned()],
                allowed_agent_ids: &["opencode".to_owned()],
                mode: TeamMode::Standard,
                max_teammates: 3,
                max_parallel_runs: 2,
                max_review_rounds: 3,
            })
            .expect("start");
        teams.activate_team(&team.id).expect("activate");
        let worker_session = agents
            .create_conversation(&project.id, AgentId::OpenCode, Some("Worker"))
            .expect("worker session");
        let teammate = teams
            .add_teammate(NewTeammate {
                team_id: &team.id,
                caller_member_id: &leader.id,
                conversation_id: &worker_session.id,
                name: "worker",
                workspace_mode: MemberWorkspaceMode::Shared,
                base_tree: None,
            })
            .expect("teammate");
        let task = teams
            .create_task(NewTeamTask {
                team_id: &team.id,
                creator_member_id: &leader.id,
                title: "Run baseline",
                description: "Run and report",
                dependencies: &[],
                owned_paths: &[],
                requires_plan_approval: false,
                mutates_files: false,
            })
            .expect("task");
        teams
            .delegate_task(&task.id, &leader.id, &teammate.id)
            .expect("delegate");
        let (round, _) = research
            .begin_round(
                &project.id,
                &question.id,
                NewRound {
                    kind: RoundKind::Team,
                    idempotency_key: "r1",
                    expected_revision: 1,
                    request: serde_json::json!({}),
                    sources: Vec::new(),
                },
            )
            .expect("round");
        research
            .round_set_session(&project.id, &question.id, &round.id, &leader_session.id)
            .expect("session");
        research
            .round_attach_team(&project.id, &question.id, &round.id, &team.id)
            .expect("attach");
        experiments
            .set_envelope(
                &project.id,
                &question.id,
                &round.id,
                None,
                limits(),
                Some("test"),
            )
            .expect("envelope");
        Self {
            _root: root,
            workspace,
            agents,
            teams,
            research,
            experiments,
            project_id: project.id,
            research_id: question.id,
            round_id: round.id,
            team,
            leader,
            teammate,
            task_id: task.id,
        }
    }

    /// Reserves an experiment owned by the Teammate (who may wait on it).
    pub fn reserve(&self, key: &str, argv: &[&str]) -> Result<(Experiment, bool), ExperimentError> {
        let mut request = launch(&self.round_id, &self.team, key, argv);
        request.owner_member_id = Some(self.teammate.id.clone());
        self.experiments
            .reserve(&self.project_id, &self.research_id, request)
    }

    /// Reserves an experiment nobody owns.
    pub fn reserve_unowned(
        &self,
        key: &str,
        argv: &[&str],
    ) -> Result<(Experiment, bool), ExperimentError> {
        self.experiments.reserve(
            &self.project_id,
            &self.research_id,
            launch(&self.round_id, &self.team, key, argv),
        )
    }
}
