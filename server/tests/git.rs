use std::fs;
use std::process::Command;
use std::sync::Arc;

use kubecode_server::agents::ExecutionMode;
use kubecode_server::git::{
    GitDiffUnavailableReason, GitMutation, GitService, MAX_GIT_DIFF_CONTEXT_BYTES,
    MAX_GIT_DIFF_FILE_CONTEXT_BYTES, MAX_GIT_UI_DIFF_BYTES,
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
    assert!(diff.diff.expect("text diff").contains("+second"));
    assert_eq!(diff.unavailable_reason, None);
    git.mutate(&project.id, GitMutation::Discard, &["README.md".into()])
        .await
        .expect("discard tracked modification");
    assert_eq!(
        fs::read_to_string(root.join("git-project/README.md")).expect("read restored file"),
        "first\n",
    );
}

#[cfg(unix)]
#[tokio::test]
async fn preserves_unix_backslashes_as_distinct_git_paths() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace
        .create_project(".", "backslash-paths")
        .expect("project");
    let repository = root.join("backslash-paths");
    let git = GitService::new(Arc::clone(&workspace));
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&repository);

    fs::create_dir(repository.join("a")).expect("directory");
    fs::write(repository.join("a/b.txt"), "slash base\n").expect("slash file");
    fs::write(repository.join("a\\b.txt"), "backslash base\n").expect("backslash file");
    run_git(&repository, &["add", "."]);
    run_git(&repository, &["commit", "-m", "initial"]);

    fs::write(repository.join("a/b.txt"), "slash base\nslash change\n").expect("slash change");
    fs::write(
        repository.join("a\\b.txt"),
        "backslash base\nbackslash change\n",
    )
    .expect("backslash change");

    let status = git.status(&project.id).await.expect("status");
    assert!(status.files.iter().any(|change| change.path == "a/b.txt"));
    assert!(status.files.iter().any(|change| change.path == "a\\b.txt"));

    let slash_diff = git
        .diff(&project.id, "a/b.txt", false)
        .await
        .expect("slash diff")
        .diff
        .expect("slash text diff");
    let backslash_diff = git
        .diff(&project.id, "a\\b.txt", false)
        .await
        .expect("backslash diff")
        .diff
        .expect("backslash text diff");
    assert!(slash_diff.contains("+slash change"));
    assert!(!slash_diff.contains("+backslash change"));
    assert!(backslash_diff.contains("+backslash change"));
    assert!(!backslash_diff.contains("+slash change"));
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_untracked_final_and_ancestor_symlink_ui_diffs() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace
        .create_project(".", "symlink-diffs")
        .expect("project");
    let repository = root.join("symlink-diffs");
    let outside = temp.path().join("outside");
    let git = GitService::new(Arc::clone(&workspace));
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&repository);

    fs::create_dir_all(&outside).expect("outside directory");
    fs::write(outside.join("secret.txt"), "outside secret content\n").expect("outside file");
    symlink(
        outside.join("secret.txt"),
        repository.join("final-link.txt"),
    )
    .expect("final symlink");
    symlink(&outside, repository.join("ancestor-link")).expect("ancestor symlink");
    assert!(
        workspace
            .project_relative_path_contains_symlink(&project.id, "final-link.txt")
            .expect("final symlink check")
    );
    assert!(
        workspace
            .project_relative_path_contains_symlink(&project.id, "ancestor-link/secret.txt")
            .expect("ancestor symlink check")
    );

    for path in ["final-link.txt", "ancestor-link/secret.txt"] {
        let diff = git
            .diff(&project.id, path, false)
            .await
            .expect("symlink diff result");
        assert_eq!(diff.diff, None, "{path} must not return outside content");
        assert_eq!(
            diff.unavailable_reason,
            Some(GitDiffUnavailableReason::Unsupported),
            "{path} must be unsupported"
        );
    }
}

#[tokio::test]
async fn projects_porcelain_v2_status_for_index_worktree_renames_and_unusual_paths() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace
        .create_project(".", "status-cases")
        .expect("project");
    let repository = root.join("status-cases");
    let git = GitService::new(Arc::clone(&workspace));
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&repository);
    for (path, content) in [
        ("modified.txt", "base\n"),
        ("deleted.txt", "base\n"),
        ("old name.txt", "rename me\n"),
        ("partial.txt", "base\n"),
    ] {
        fs::write(repository.join(path), content).expect("fixture");
    }
    run_git(&repository, &["add", "."]);
    run_git(&repository, &["commit", "-m", "initial"]);

    fs::write(repository.join("modified.txt"), "changed\n").expect("modify");
    fs::remove_file(repository.join("deleted.txt")).expect("delete");
    fs::rename(
        repository.join("old name.txt"),
        repository.join("renamed name.txt"),
    )
    .expect("rename");
    fs::write(repository.join("added.txt"), "added\n").expect("add");
    fs::write(repository.join("partial.txt"), "staged\n").expect("partial staged");
    run_git(
        &repository,
        &[
            "add",
            "added.txt",
            "partial.txt",
            "old name.txt",
            "renamed name.txt",
        ],
    );
    fs::write(repository.join("partial.txt"), "staged\nunstaged\n").expect("partial unstaged");
    fs::write(repository.join("white space.txt"), "space\n").expect("space path");
    let unicode_path = "na\u{00ef}ve.txt";
    fs::write(repository.join(unicode_path), "unicode\n").expect("unicode path");
    fs::create_dir_all(repository.join("nested/untracked")).expect("nested directory");
    fs::write(
        repository.join("nested/untracked/file.txt"),
        "nested untracked\n",
    )
    .expect("nested untracked path");

    let status = git.status(&project.id).await.expect("status");
    assert!(status.is_repository);
    assert!(!status.truncated);
    let change = |path: &str| {
        status
            .files
            .iter()
            .find(|change| change.path == path)
            .unwrap_or_else(|| panic!("missing {path:?} in {:?}", status.files))
    };
    assert_eq!(change("modified.txt").worktree_status, Some('M'));
    assert_eq!(change("deleted.txt").worktree_status, Some('D'));
    assert_eq!(change("added.txt").index_status, Some('A'));
    assert_eq!(change("partial.txt").index_status, Some('M'));
    assert_eq!(change("partial.txt").worktree_status, Some('M'));
    assert_eq!(
        change("renamed name.txt").original_path.as_deref(),
        Some("old name.txt")
    );
    assert_eq!(change("white space.txt").worktree_status, Some('?'));
    assert_eq!(change(unicode_path).worktree_status, Some('?'));
    assert_eq!(
        change("nested/untracked/file.txt").worktree_status,
        Some('?')
    );
    assert!(status.files.iter().all(|change| !change.conflict));
}

#[tokio::test]
async fn projects_conflicts_and_submodule_worktree_changes() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace
        .create_project(".", "conflict-cases")
        .expect("project");
    let repository = root.join("conflict-cases");
    let git = GitService::new(Arc::clone(&workspace));
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&repository);
    fs::write(repository.join("conflict.txt"), "base\n").expect("fixture");
    run_git(&repository, &["add", "conflict.txt"]);
    run_git(&repository, &["commit", "-m", "initial"]);
    run_git(&repository, &["checkout", "-b", "other"]);
    fs::write(repository.join("conflict.txt"), "other\n").expect("other change");
    run_git(&repository, &["commit", "-am", "other"]);
    run_git(&repository, &["checkout", "master"]);
    fs::write(repository.join("conflict.txt"), "master\n").expect("master change");
    run_git(&repository, &["commit", "-am", "master"]);
    let merge = Command::new("git")
        .args(["merge", "other"])
        .current_dir(&repository)
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .expect("merge");
    assert!(!merge.success());

    let status = git.status(&project.id).await.expect("conflict status");
    let conflict = status
        .files
        .iter()
        .find(|change| change.path == "conflict.txt")
        .expect("conflict projection");
    assert!(conflict.conflict);
    assert_eq!(conflict.index_status, Some('U'));
    assert_eq!(conflict.worktree_status, Some('U'));

    run_git(&repository, &["merge", "--abort"]);
    let submodule = root.join("submodule-source");
    fs::create_dir(&submodule).expect("submodule source");
    run_git(&submodule, &["init"]);
    configure_identity(&submodule);
    fs::write(submodule.join("tracked.txt"), "base\n").expect("submodule fixture");
    run_git(&submodule, &["add", "tracked.txt"]);
    run_git(&submodule, &["commit", "-m", "initial"]);
    run_git(
        &repository,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            submodule.to_str().expect("submodule path"),
            "vendor/sub",
        ],
    );
    run_git(&repository, &["commit", "-am", "add submodule"]);
    fs::write(repository.join("vendor/sub/tracked.txt"), "changed\n").expect("submodule change");

    let status = git.status(&project.id).await.expect("submodule status");
    let submodule = status
        .files
        .iter()
        .find(|change| change.path == "vendor/sub")
        .expect("submodule projection");
    assert_eq!(submodule.index_status, None);
    assert_eq!(submodule.worktree_status, Some('M'));
    assert!(!submodule.conflict);
}

#[tokio::test]
async fn returns_bounded_staged_unstaged_and_server_generated_untracked_diffs() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace.create_project(".", "ui-diffs").expect("project");
    let repository = root.join("ui-diffs");
    let git = GitService::new(Arc::clone(&workspace));
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&repository);
    fs::write(repository.join("mixed.txt"), "base\n").expect("fixture");
    run_git(&repository, &["add", "mixed.txt"]);
    run_git(&repository, &["commit", "-m", "initial"]);
    fs::write(repository.join("mixed.txt"), "base\nstaged\n").expect("staged change");
    run_git(&repository, &["add", "mixed.txt"]);
    fs::write(repository.join("mixed.txt"), "base\nstaged\nunstaged\n").expect("unstaged change");
    let untracked_path = "new file-na\u{00ef}ve.txt";
    fs::write(repository.join(untracked_path), "first\nsecond\n").expect("untracked");

    let staged = git
        .diff(&project.id, "mixed.txt", true)
        .await
        .expect("staged diff")
        .diff
        .expect("staged text");
    assert!(staged.contains("+staged"));
    assert!(!staged.contains("+unstaged"));
    let unstaged = git
        .diff(&project.id, "mixed.txt", false)
        .await
        .expect("unstaged diff")
        .diff
        .expect("unstaged text");
    assert!(unstaged.contains("+unstaged"));
    assert!(!unstaged.contains("+staged"));
    let untracked = git
        .diff(&project.id, untracked_path, false)
        .await
        .expect("untracked diff")
        .diff
        .expect("untracked text");
    assert!(untracked.contains("diff --git"));
    assert!(untracked.contains("+first"));
    assert!(untracked.contains("+second"));
}

#[tokio::test]
async fn exposes_stable_ui_diff_unavailable_reasons() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode.sqlite3");
    let workspace = Arc::new(WorkspaceService::open(&root, state).expect("workspace"));
    let project = workspace
        .create_project(".", "ui-diff-reasons")
        .expect("project");
    let repository = root.join("ui-diff-reasons");
    let git = GitService::new(Arc::clone(&workspace));
    git.initialize(&project.id).await.expect("initialize");
    configure_identity(&repository);
    fs::write(repository.join("clean.txt"), "clean\n").expect("clean fixture");
    fs::write(repository.join("binary.dat"), [0, 159, 146, 150]).expect("binary fixture");
    fs::write(repository.join("marker-words.txt"), "base\n").expect("marker fixture");
    fs::write(repository.join("large.txt"), "small\n").expect("large fixture");
    run_git(&repository, &["add", "."]);
    run_git(&repository, &["commit", "-m", "initial"]);
    fs::write(repository.join("binary.dat"), [0, 159, 146, 151]).expect("binary change");
    fs::write(
        repository.join("marker-words.txt"),
        "base\nBinary files a/file and b/file differ\nGIT binary patch\n",
    )
    .expect("marker text change");
    fs::write(
        repository.join("large.txt"),
        format!("{}\n", "x".repeat(MAX_GIT_UI_DIFF_BYTES + 1024)),
    )
    .expect("large change");

    let binary = git
        .diff(&project.id, "binary.dat", false)
        .await
        .expect("binary result");
    assert_eq!(binary.diff, None);
    assert_eq!(
        binary.unavailable_reason,
        Some(GitDiffUnavailableReason::Binary)
    );
    let marker_words = git
        .diff(&project.id, "marker-words.txt", false)
        .await
        .expect("marker words result");
    assert!(marker_words.diff.is_some());
    assert_eq!(marker_words.unavailable_reason, None);
    let oversized = git
        .diff(&project.id, "large.txt", false)
        .await
        .expect("oversized result");
    assert_eq!(oversized.diff, None);
    assert_eq!(
        oversized.unavailable_reason,
        Some(GitDiffUnavailableReason::Oversized)
    );
    let unsupported = git
        .diff(&project.id, "clean.txt", false)
        .await
        .expect("unsupported result");
    assert_eq!(unsupported.diff, None);
    assert_eq!(
        unsupported.unavailable_reason,
        Some(GitDiffUnavailableReason::Unsupported)
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
            .env("GIT_TERMINAL_PROMPT", "0")
            .status()
            .expect("git config");
        assert!(status.success());
    }
}

fn run_git(repository: &std::path::Path, arguments: &[&str]) {
    let status = Command::new("git")
        .args(arguments)
        .current_dir(repository)
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .expect("git command");
    assert!(status.success(), "git {arguments:?}");
}
