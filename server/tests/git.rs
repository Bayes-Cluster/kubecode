use std::fs;
use std::process::Command;
use std::sync::Arc;

use kubecode_server::agents::ExecutionMode;
use kubecode_server::git::{
    GitMutation, GitService, MAX_GIT_DIFF_CONTEXT_BYTES, MAX_GIT_DIFF_FILE_CONTEXT_BYTES,
};
use kubecode_server::workspace::WorkspaceService;
use tempfile::TempDir;

#[tokio::test]
async fn supports_local_review_stage_diff_and_commit() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace
        .create_project(".", "git-project")
        .expect("project");
    let git = GitService::new(Arc::clone(&workspace));

    assert!(!git.status(&project.id).await.expect("status").is_repository);
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&root.join("git-project"));

    let scratch_path = root.join("git-project/scratch.txt");
    fs::write(&scratch_path, "temporary\n").expect("write scratch file");
    git.mutate(&project.id, GitMutation::Stage, &["scratch.txt".into()])
        .await
        .expect("stage before first commit");
    let unstaged = git
        .mutate(&project.id, GitMutation::Unstage, &["scratch.txt".into()])
        .await
        .expect("unstage before first commit");
    assert_eq!(unstaged.files[0].worktree_status, Some('?'));
    git.mutate(&project.id, GitMutation::Discard, &["scratch.txt".into()])
        .await
        .expect("discard untracked file");
    assert!(!scratch_path.exists());

    fs::write(root.join("git-project/README.md"), "first\n").expect("write file");
    let untracked = git.status(&project.id).await.expect("untracked status");
    assert_eq!(untracked.files[0].path, "README.md");

    git.mutate(&project.id, GitMutation::Stage, &["README.md".into()])
        .await
        .expect("stage");
    git.commit(&project.id, "Initial commit")
        .await
        .expect("commit");
    assert!(
        git.status(&project.id)
            .await
            .expect("clean status")
            .files
            .is_empty()
    );

    fs::write(root.join("git-project/README.md"), "first\nsecond\n").expect("modify");
    let diff = git
        .diff(&project.id, "README.md", false)
        .await
        .expect("diff");
    assert!(diff.contains("+second"));
    git.mutate(&project.id, GitMutation::Discard, &["README.md".into()])
        .await
        .expect("discard tracked modification");
    assert_eq!(
        fs::read_to_string(root.join("git-project/README.md")).expect("read restored file"),
        "first\n",
    );
}

#[tokio::test]
async fn resolves_bounded_diff_context_against_the_exact_session_workspace() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace
        .create_project(".", "diff-project")
        .expect("project");
    let repository = root.join("diff-project");
    let git = GitService::new(Arc::clone(&workspace));
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&repository);
    fs::write(repository.join("README.md"), "base\n").expect("fixture");
    run_git(&repository, &["add", "README.md"]);
    run_git(&repository, &["commit", "-m", "initial"]);

    workspace
        .set_workspaces_enabled(&project.id, true)
        .expect("workspaces");
    let worktree = workspace
        .create_session_worktree(&project.id, "session-worktree")
        .expect("worktree");
    fs::write(repository.join("README.md"), "base\nshared\n").expect("shared change");
    fs::write(worktree.join("README.md"), "base\nisolated\n").expect("worktree change");

    let shared = git
        .composer_diff_candidates(&project.id, "session-shared", ExecutionMode::Shared, None)
        .await
        .expect("shared candidates");
    let isolated = git
        .composer_diff_candidates(
            &project.id,
            "session-worktree",
            ExecutionMode::Worktree,
            Some(worktree.to_str().expect("worktree path")),
        )
        .await
        .expect("worktree candidates");
    assert!(shared.is_repository);
    assert_eq!(shared.candidates[0].file_count, 1);
    assert_eq!(shared.candidates[1].path.as_deref(), Some("README.md"));
    assert_ne!(
        shared.candidates[0].source_revision,
        isolated.candidates[0].source_revision
    );

    let snapshot = git
        .resolve_composer_diff(
            &project.id,
            "session-worktree",
            ExecutionMode::Worktree,
            Some(worktree.to_str().expect("worktree path")),
            None,
        )
        .await
        .expect("worktree snapshot");
    assert!(snapshot.content.contains("+isolated"));
    assert!(!snapshot.content.contains("+shared"));
    assert_eq!(
        snapshot.source_revision,
        isolated.candidates[0].source_revision
    );

    fs::write(worktree.join("README.md"), "base\nchanged again\n").expect("mutate");
    let changed = git
        .resolve_composer_diff(
            &project.id,
            "session-worktree",
            ExecutionMode::Worktree,
            Some(worktree.to_str().expect("worktree path")),
            None,
        )
        .await
        .expect("changed snapshot");
    assert_ne!(snapshot.source_revision, changed.source_revision);
}

#[tokio::test]
async fn exposes_binary_generated_and_oversized_diff_limits_without_truncation() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace
        .create_project(".", "bounded-diff")
        .expect("project");
    let repository = root.join("bounded-diff");
    let git = GitService::new(Arc::clone(&workspace));
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&repository);
    fs::create_dir(repository.join("dist")).expect("dist");
    fs::write(repository.join("binary.dat"), [0, 159, 146, 150]).expect("binary");
    fs::write(repository.join("dist/generated.js"), "old\n").expect("generated");
    fs::write(repository.join("large.txt"), "small\n").expect("large fixture");
    run_git(&repository, &["add", "."]);
    run_git(&repository, &["commit", "-m", "initial"]);
    fs::write(repository.join("binary.dat"), [0, 159, 146, 151]).expect("binary change");
    fs::write(repository.join("dist/generated.js"), "new\n").expect("generated change");
    fs::write(
        repository.join("large.txt"),
        "x".repeat(MAX_GIT_DIFF_CONTEXT_BYTES + 1),
    )
    .expect("oversized change");

    let candidates = git
        .composer_diff_candidates(&project.id, "session", ExecutionMode::Shared, None)
        .await
        .expect("candidates");
    let reason = |path: &str| {
        candidates
            .candidates
            .iter()
            .find(|candidate| candidate.path.as_deref() == Some(path))
            .and_then(|candidate| candidate.disabled_reason.as_deref())
    };
    assert_eq!(reason("binary.dat"), Some("git_diff_binary"));
    assert_eq!(reason("dist/generated.js"), Some("git_diff_generated"));
    assert_eq!(reason("large.txt"), Some("git_diff_too_large"));
    assert_eq!(
        candidates.candidates[0].disabled_reason.as_deref(),
        Some("git_diff_contains_unsupported")
    );
}

#[tokio::test]
async fn applies_full_and_selected_file_diff_bounds_independently() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace
        .create_project(".", "independent-bounds")
        .expect("project");
    let repository = root.join("independent-bounds");
    let git = GitService::new(Arc::clone(&workspace));
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&repository);
    fs::write(repository.join("large.txt"), "small\n").expect("fixture");
    run_git(&repository, &["add", "large.txt"]);
    run_git(&repository, &["commit", "-m", "initial"]);
    fs::write(
        repository.join("large.txt"),
        format!("{}\n", "x".repeat(MAX_GIT_DIFF_FILE_CONTEXT_BYTES + 1024)),
    )
    .expect("bounded full diff");

    let candidates = git
        .composer_diff_candidates(&project.id, "session", ExecutionMode::Shared, None)
        .await
        .expect("candidates");
    assert!(candidates.candidates[0].enabled);
    assert!(candidates.candidates[0].byte_count > MAX_GIT_DIFF_FILE_CONTEXT_BYTES);
    assert!(candidates.candidates[0].byte_count < MAX_GIT_DIFF_CONTEXT_BYTES);
    assert_eq!(
        candidates.candidates[1].disabled_reason.as_deref(),
        Some("git_diff_too_large")
    );
}

fn configure_identity(repository: &std::path::Path) {
    for (key, value) in [
        ("user.name", "Kubecode Test"),
        ("user.email", "test@kubecode.local"),
    ] {
        let status = Command::new("git")
            .args(["config", key, value])
            .current_dir(repository)
            .status()
            .expect("git config");
        assert!(status.success());
    }
}

fn run_git(repository: &std::path::Path, arguments: &[&str]) {
    let status = Command::new("git")
        .args(arguments)
        .current_dir(repository)
        .status()
        .expect("git command");
    assert!(status.success(), "git {arguments:?}");
}
