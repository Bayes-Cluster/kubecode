use std::fs;
use std::process::Command;
use std::sync::Arc;

use kubecode_server::git::{GitMutation, GitService};
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
