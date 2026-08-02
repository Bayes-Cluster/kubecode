use std::fs;
use std::path::Path;
use std::process::Command;

use kubecode_server::agents::ExecutionMode;
use kubecode_server::workspace::{
    EntryKind, MAX_SESSION_DIRECTORY_ENTRIES, WorkspaceError, WorkspaceService,
};
use tempfile::TempDir;

fn service() -> (TempDir, WorkspaceService) {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let state = root.join(".state/kubecode");
    fs::create_dir_all(&state).expect("state directory");
    let service =
        WorkspaceService::open(&root, state.join("kubecode.sqlite3")).expect("workspace service");
    (temp, service)
}

#[test]
fn creates_imports_lists_and_unregisters_projects_without_deleting_files() {
    let (_temp, service) = service();

    let created_path = service.root().join("teams/compiler");
    let created = service
        .create_project_at(&created_path)
        .expect("create project");
    assert_eq!(created.name, "compiler");
    assert_eq!(created.path, created_path.to_string_lossy());
    assert!(!created.workspaces_enabled);

    fs::create_dir_all(service.root().join("existing/api")).expect("existing project");
    let imported = service
        .import_project_at(service.root().join("existing/api"))
        .expect("import project");
    assert_eq!(imported.name, "api");

    let projects = service.list_projects().expect("list projects");
    assert_eq!(projects.len(), 2);
    assert!(projects.iter().any(|project| project.id == imported.id));

    service
        .unregister_project(&created.id)
        .expect("unregister project");
    assert!(service.root().join("teams/compiler").is_dir());
    assert_eq!(service.list_projects().expect("list projects").len(), 1);
}

#[test]
fn verifies_a_user_selected_path_against_one_registered_project() {
    let (_temp, service) = service();
    let project_path = service.root().join("authorization-target");
    let project = service
        .create_project_at(&project_path)
        .expect("create project");
    let other_path = service.root().join("other-project");
    fs::create_dir_all(&other_path).expect("other directory");

    service
        .authorize_project_path(&project.id, &project_path)
        .expect("matching selected path");
    assert!(matches!(
        service.authorize_project_path(&project.id, &other_path),
        Err(WorkspaceError::InvalidPath(_))
    ));
    assert!(matches!(
        service.authorize_project_path("missing", &project_path),
        Err(WorkspaceError::ProjectNotFound(_))
    ));
}

#[test]
fn persists_the_project_workspaces_preference() {
    let temp = TempDir::new().expect("tempdir");
    let root = temp.path().join("srv");
    let database_path = root.join(".state/kubecode/kubecode.sqlite3");
    fs::create_dir_all(database_path.parent().expect("database parent")).expect("state directory");

    let service = WorkspaceService::open(&root, &database_path).expect("workspace service");
    let project = service
        .create_project_at(root.join("workspaces"))
        .expect("project");
    let enabled = service
        .set_workspaces_enabled(&project.id, true)
        .expect("enable workspaces");
    assert!(enabled.workspaces_enabled);
    drop(service);

    let reopened = WorkspaceService::open(&root, &database_path).expect("reopen workspace service");
    let persisted = reopened
        .list_projects()
        .expect("list projects")
        .into_iter()
        .find(|candidate| candidate.id == project.id)
        .expect("persisted project");
    assert!(persisted.workspaces_enabled);
}

#[test]
fn annotates_hidden_git_ignored_and_generated_project_entries() {
    let (_temp, service) = service();
    let project = service
        .create_project_at(service.root().join("filtered-project"))
        .expect("project");
    let root = Path::new(&project.path);
    run_git(root, &["init"]);
    fs::write(root.join(".gitignore"), "build/\n").expect("gitignore");
    fs::write(root.join(".env"), "TOKEN=test\n").expect("hidden fixture");
    fs::create_dir(root.join("build")).expect("ignored directory");
    fs::create_dir(root.join("node_modules")).expect("generated directory");
    fs::create_dir(root.join("src")).expect("visible directory");

    let entries = service.list_entries(&project.id, "").expect("entries");
    let hidden = entries
        .iter()
        .find(|entry| entry.name == ".env")
        .expect("hidden entry");
    let ignored = entries
        .iter()
        .find(|entry| entry.name == "build")
        .expect("ignored entry");
    let visible = entries
        .iter()
        .find(|entry| entry.name == "src")
        .expect("visible entry");
    let generated = entries
        .iter()
        .find(|entry| entry.name == "node_modules")
        .expect("generated entry");

    assert!(hidden.hidden);
    assert!(!hidden.ignored);
    assert!(!hidden.generated);
    assert!(!ignored.hidden);
    assert!(ignored.ignored);
    assert!(ignored.generated);
    assert!(generated.generated);
    assert!(!generated.hidden);
    assert!(!generated.ignored);
    assert!(!visible.hidden);
    assert!(!visible.ignored);
    assert!(!visible.generated);
}

#[cfg(unix)]
#[test]
fn project_entries_do_not_follow_symbolic_links() {
    use std::os::unix::fs::symlink;

    let (_temp, service) = service();
    let project = service
        .create_project_at(service.root().join("symlink-project"))
        .expect("project");
    let root = Path::new(&project.path);
    fs::create_dir(root.join("real-directory")).expect("real directory");
    symlink(root.join("real-directory"), root.join("linked-directory")).expect("symlink");

    let entries = service.list_entries(&project.id, "").expect("entries");

    assert!(entries.iter().any(|entry| entry.name == "real-directory"));
    assert!(!entries.iter().any(|entry| entry.name == "linked-directory"));
}

#[test]
fn creates_an_isolated_git_worktree_for_an_agent_session() {
    let (_temp, service) = service();
    let project = service
        .create_project_at(service.root().join("worktree-project"))
        .expect("project");
    run_git(&project.path, &["init"]);
    run_git(&project.path, &["config", "user.email", "test@example.com"]);
    run_git(&project.path, &["config", "user.name", "Kubecode Test"]);
    fs::write(Path::new(&project.path).join("README.md"), "root\n").expect("fixture");
    run_git(&project.path, &["add", "README.md"]);
    run_git(&project.path, &["commit", "-m", "initial"]);
    service
        .set_workspaces_enabled(&project.id, true)
        .expect("enable workspaces");

    let workspace = service
        .create_session_worktree(&project.id, "session-12345678")
        .expect("session worktree");

    assert!(workspace.is_dir());
    assert_eq!(
        fs::read_to_string(workspace.join("README.md")).expect("worktree content"),
        "root\n",
    );
    assert_eq!(
        git_output(&workspace, &["branch", "--show-current"]),
        "kubecode/session-12345678",
    );
}

#[test]
fn captures_and_restores_a_git_tree_without_touching_the_real_index() {
    let (_temp, service) = service();
    let project = service
        .create_project_at(service.root().join("checkpoint-project"))
        .expect("project");
    run_git(&project.path, &["init"]);
    run_git(&project.path, &["config", "user.email", "test@example.com"]);
    run_git(&project.path, &["config", "user.name", "Kubecode Test"]);
    fs::write(Path::new(&project.path).join("README.md"), "root\n").expect("fixture");
    run_git(&project.path, &["add", "README.md"]);
    run_git(&project.path, &["commit", "-m", "initial"]);
    fs::write(Path::new(&project.path).join("README.md"), "checkpoint\n")
        .expect("checkpoint content");
    fs::write(Path::new(&project.path).join("staged.txt"), "staged\n").expect("staged file");
    run_git(&project.path, &["add", "staged.txt"]);
    let staged_before = git_output(&project.path, &["diff", "--cached", "--name-only"]);

    let checkpoint = service
        .capture_git_tree(Path::new(&project.path), "run-1-before")
        .expect("capture tree")
        .expect("git tree");
    fs::write(Path::new(&project.path).join("README.md"), "later\n").expect("later content");
    let current = service
        .capture_git_tree(Path::new(&project.path), "run-1-current")
        .expect("capture current")
        .expect("current tree");
    service
        .restore_git_tree(Path::new(&project.path), &checkpoint, Some(&current))
        .expect("restore checkpoint");

    assert_eq!(
        fs::read_to_string(Path::new(&project.path).join("README.md")).expect("restored file"),
        "checkpoint\n",
    );
    assert_eq!(
        git_output(&project.path, &["diff", "--cached", "--name-only"]),
        staged_before,
    );
}

#[test]
fn three_way_merges_an_isolated_tree_into_the_leader_workspace() {
    let (_temp, service) = service();
    let project = service
        .create_project_at(service.root().join("team-merge-project"))
        .expect("project");
    run_git(&project.path, &["init"]);
    run_git(&project.path, &["config", "user.email", "test@example.com"]);
    run_git(&project.path, &["config", "user.name", "Kubecode Test"]);
    fs::write(Path::new(&project.path).join("README.md"), "root\n").expect("fixture");
    run_git(&project.path, &["add", "README.md"]);
    run_git(&project.path, &["commit", "-m", "initial"]);
    service
        .set_workspaces_enabled(&project.id, true)
        .expect("enable workspaces");
    let base = service
        .capture_git_tree(Path::new(&project.path), "team-base")
        .unwrap()
        .unwrap();
    let isolated = service
        .create_session_worktree(&project.id, "isolated-member")
        .expect("isolated worktree");
    fs::write(isolated.join("member.txt"), "member change\n").expect("member change");
    let member_tree = service
        .capture_git_tree(&isolated, "team-member")
        .unwrap()
        .unwrap();
    fs::write(
        Path::new(&project.path).join("leader.txt"),
        "leader change\n",
    )
    .expect("leader change");

    service
        .merge_isolated_tree(Path::new(&project.path), &base, &member_tree)
        .expect("three-way merge");

    assert_eq!(
        fs::read_to_string(Path::new(&project.path).join("member.txt")).unwrap(),
        "member change\n"
    );
    assert_eq!(
        fs::read_to_string(Path::new(&project.path).join("leader.txt")).unwrap(),
        "leader change\n"
    );
}

fn run_git(cwd: impl AsRef<Path>, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
}

fn git_output(cwd: impl AsRef<Path>, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("run git");
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .expect("utf8 git output")
        .trim()
        .to_owned()
}

#[test]
fn rejects_state_paths_traversal_and_duplicate_projects() {
    let (_temp, service) = service();

    assert!(
        service
            .import_project_at(service.root().join(".state"))
            .is_err()
    );
    assert!(service.import_project_at("relative/project").is_err());
    assert!(service.create_project_at("relative/project").is_err());

    fs::create_dir_all(service.root().join("project")).expect("project directory");
    service
        .import_project_at(service.root().join("project"))
        .expect("first import");
    assert!(
        service
            .import_project_at(service.root().join("project"))
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn canonicalizes_projects_outside_the_persistent_root() {
    use std::os::unix::fs::symlink;

    let (temp, service) = service();
    let outside = temp.path().join("outside");
    fs::create_dir_all(&outside).expect("outside directory");
    symlink(&outside, service.root().join("escaped")).expect("symlink");

    let project = service
        .import_project_at(service.root().join("escaped"))
        .expect("outside project through symlink");
    assert_eq!(
        project.path,
        outside
            .canonicalize()
            .expect("canonical outside")
            .to_string_lossy()
    );
}

#[test]
fn lists_server_directories_with_absolute_paths_and_hides_state() {
    let (_temp, service) = service();
    fs::create_dir_all(service.root().join("visible/nested")).expect("visible directories");

    let listing = service
        .list_directories(Some(service.root()))
        .expect("directory listing");

    assert_eq!(listing.path, service.root().to_string_lossy());
    assert!(listing.entries.iter().any(|entry| entry.name == "visible"));
    assert!(!listing.entries.iter().any(|entry| entry.name == ".state"));
}

#[test]
fn writes_text_atomically_and_detects_stale_revisions() {
    let (_temp, service) = service();
    let project = service.create_project(".", "editor").expect("project");

    service
        .create_entry(&project.id, "src", EntryKind::Directory)
        .expect("create directory");
    service
        .create_entry(&project.id, "src/main.rs", EntryKind::File)
        .expect("create file");

    let initial = service
        .read_text(&project.id, "src/main.rs")
        .expect("read initial file");
    let saved = service
        .write_text(
            &project.id,
            "src/main.rs",
            "fn main() {}\n",
            &initial.revision,
        )
        .expect("save file");
    assert_ne!(saved.revision, initial.revision);

    let error = service
        .write_text(&project.id, "src/main.rs", "stale\n", &initial.revision)
        .expect_err("stale write must fail");
    assert!(matches!(error, WorkspaceError::Conflict { .. }));
    assert_eq!(
        service
            .read_text(&project.id, "src/main.rs")
            .expect("read saved file")
            .content,
        "fn main() {}\n"
    );
}

#[test]
fn reads_bounded_binary_assets_inside_registered_projects() {
    let (_temp, service) = service();
    let project = service.create_project(".", "assets").expect("project");
    fs::write(
        service.root().join("assets/diagram.png"),
        [0x89, 0x50, 0x4e, 0x47],
    )
    .expect("binary fixture");

    assert_eq!(
        service
            .read_asset(&project.id, "diagram.png")
            .expect("read project asset"),
        [0x89, 0x50, 0x4e, 0x47]
    );
    assert!(matches!(
        service.read_asset(&project.id, "../diagram.png"),
        Err(WorkspaceError::InvalidPath(_))
    ));

    fs::write(
        service.root().join("assets/oversized.png"),
        vec![0; 8 * 1024 * 1024 + 1],
    )
    .expect("oversized fixture");
    assert!(matches!(
        service.read_asset(&project.id, "oversized.png"),
        Err(WorkspaceError::AssetTooLarge)
    ));
}

#[test]
fn renames_and_deletes_entries_inside_the_project_only() {
    let (_temp, service) = service();
    let project = service.create_project(".", "crud").expect("project");
    service
        .create_entry(&project.id, "old.txt", EntryKind::File)
        .expect("create file");
    service
        .rename_entry(&project.id, "old.txt", "nested/new.txt")
        .expect("rename file and create parent");

    assert!(service.root().join("crud/nested/new.txt").is_file());
    service
        .delete_entry(&project.id, "nested/new.txt")
        .expect("delete file");
    assert!(!service.root().join("crud/nested/new.txt").exists());

    assert!(service.delete_entry(&project.id, "../outside").is_err());
}

fn worktree_project(service: &WorkspaceService, name: &str) -> kubecode_server::workspace::Project {
    let project = service
        .create_project_at(service.root().join(name))
        .expect("project");
    run_git(&project.path, &["init"]);
    run_git(&project.path, &["config", "user.email", "test@example.com"]);
    run_git(&project.path, &["config", "user.name", "Kubecode Test"]);
    fs::write(Path::new(&project.path).join("README.md"), "root\n").expect("fixture");
    run_git(&project.path, &["add", "README.md"]);
    run_git(&project.path, &["commit", "-m", "initial"]);
    service
        .set_workspaces_enabled(&project.id, true)
        .expect("enable workspaces");
    project
}

#[test]
fn list_session_entries_shared_matches_project_entries() {
    let (_temp, service) = service();
    let project = worktree_project(&service, "shared-project");
    fs::create_dir(Path::new(&project.path).join("src")).expect("src");

    let project_entries = service
        .list_entries(&project.id, "")
        .expect("project entries");
    let session_entries = service
        .list_session_entries(
            &project.id,
            "session-shared",
            ExecutionMode::Shared,
            None,
            "",
        )
        .expect("shared session entries");

    assert_eq!(project_entries, session_entries);
}

#[test]
fn list_session_entries_worktree_lists_worktree_not_shared_root() {
    let (_temp, service) = service();
    let project = worktree_project(&service, "session-worktree-project");
    let worktree = service
        .create_session_worktree(&project.id, "session-12345678")
        .expect("session worktree");

    // A file that exists only in the worktree.
    fs::write(worktree.join("only-in-worktree.txt"), "wt\n").expect("worktree-only file");

    let entries = service
        .list_session_entries(
            &project.id,
            "session-12345678",
            ExecutionMode::Worktree,
            worktree.to_str(),
            "",
        )
        .expect("worktree entries");
    let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    assert!(names.contains(&"only-in-worktree.txt"));

    // Sanity: the shared project root does not contain that file.
    let shared = service
        .list_entries(&project.id, "")
        .expect("shared entries");
    let shared_names: Vec<&str> = shared.iter().map(|entry| entry.name.as_str()).collect();
    assert!(!shared_names.contains(&"only-in-worktree.txt"));
}

#[test]
fn list_session_entries_bounds_each_directory_listing() {
    let (_temp, service) = service();
    let project = worktree_project(&service, "bounded-session-entries");
    let project_root = Path::new(&project.path);
    for index in 0..(MAX_SESSION_DIRECTORY_ENTRIES + 20) {
        fs::write(
            project_root.join(format!("entry-{index:04}.txt")),
            "fixture\n",
        )
        .expect("fixture");
    }

    let entries = service
        .list_session_entries(
            &project.id,
            "agent-session-bounded",
            ExecutionMode::Shared,
            None,
            "",
        )
        .expect("bounded entries");

    assert_eq!(entries.len(), MAX_SESSION_DIRECTORY_ENTRIES);
}

#[test]
fn list_session_entries_rejects_escaped_relative_path() {
    let (_temp, service) = service();
    let project = worktree_project(&service, "escape-project");

    let result = service.list_session_entries(
        &project.id,
        "session-shared",
        ExecutionMode::Shared,
        None,
        "../outside",
    );
    assert!(matches!(result, Err(WorkspaceError::InvalidPath(_))));
}

#[test]
fn list_session_entries_rejects_another_conversations_worktree() {
    let (_temp, service) = service();
    let project = worktree_project(&service, "cross-conversation-project");
    let other_worktree = service
        .create_session_worktree(&project.id, "session-aaaaaaaa")
        .expect("other session worktree");

    // Pointing conversation B at conversation A's worktree must fail.
    let result = service.list_session_entries(
        &project.id,
        "session-bbbbbbbb",
        ExecutionMode::Worktree,
        other_worktree.to_str(),
        "",
    );
    assert!(matches!(
        result,
        Err(WorkspaceError::SessionWorkspaceUnavailable)
    ));
}

#[test]
fn list_session_entries_rejects_inconsistent_mode_and_path() {
    let (_temp, service) = service();
    let project = worktree_project(&service, "consistency-project");
    let worktree = service
        .create_session_worktree(&project.id, "session-12345678")
        .expect("session worktree");

    // Shared must carry no workspace_path.
    let shared_with_path = service.list_session_entries(
        &project.id,
        "session-12345678",
        ExecutionMode::Shared,
        worktree.to_str(),
        "",
    );
    assert!(matches!(
        shared_with_path,
        Err(WorkspaceError::SessionWorkspaceUnavailable)
    ));

    // Worktree must carry a workspace_path.
    let worktree_without_path = service.list_session_entries(
        &project.id,
        "session-12345678",
        ExecutionMode::Worktree,
        None,
        "",
    );
    assert!(matches!(
        worktree_without_path,
        Err(WorkspaceError::SessionWorkspaceUnavailable)
    ));
}

#[test]
fn list_session_entries_rejects_stale_worktree_root() {
    let (_temp, service) = service();
    let project = worktree_project(&service, "stale-worktree-project");
    let worktree = service
        .create_session_worktree(&project.id, "session-12345678")
        .expect("session worktree");
    let stale_path = worktree.to_path_buf();
    service
        .discard_session_worktree(
            &project.id,
            "session-12345678",
            stale_path.to_str().expect("stale path"),
        )
        .expect("discard worktree");

    let result = service.list_session_entries(
        &project.id,
        "session-12345678",
        ExecutionMode::Worktree,
        stale_path.to_str(),
        "",
    );
    assert!(matches!(
        result,
        Err(WorkspaceError::SessionWorkspaceUnavailable)
    ));
}

#[test]
fn list_session_entries_rejects_a_worktree_whose_project_was_unregistered() {
    let (_temp, service) = service();
    let project = worktree_project(&service, "unregistered-worktree-project");
    let worktree = service
        .create_session_worktree(&project.id, "session-12345678")
        .expect("session worktree");
    fs::write(worktree.join("only-in-worktree.txt"), "wt\n").expect("worktree-only file");

    // Unregistering the Project removes only the registration; files and the
    // retained worktree directory remain on disk.
    service
        .unregister_project(&project.id)
        .expect("unregister project");
    assert!(worktree.is_dir(), "worktree directory is preserved on disk");

    // A retained worktree cannot be listed once its Project is unregistered.
    let result = service.list_session_entries(
        &project.id,
        "session-12345678",
        ExecutionMode::Worktree,
        worktree.to_str(),
        "",
    );
    assert!(matches!(result, Err(WorkspaceError::ProjectNotFound(_))));

    // The shared mode is already gated by project_root and stays rejected too.
    let shared_result = service.list_session_entries(
        &project.id,
        "session-12345678",
        ExecutionMode::Shared,
        None,
        "",
    );
    assert!(matches!(
        shared_result,
        Err(WorkspaceError::ProjectNotFound(_))
    ));
}

#[test]
fn resolves_only_eligible_exact_session_context_entries() {
    let (_temp, service) = service();
    let project = worktree_project(&service, "context-resolution-project");
    let root = Path::new(&project.path);
    fs::create_dir(root.join("src")).expect("src");
    fs::write(root.join("src/main.rs"), "fn main() {}\n").expect("file");

    let resolved = service
        .resolve_session_context_entry(
            &project.id,
            "session-shared",
            ExecutionMode::Shared,
            None,
            "src/main.rs",
            kubecode_server::workspace::EntryKind::File,
        )
        .expect("eligible file");

    assert_eq!(resolved.path, "src/main.rs");
    assert_eq!(resolved.kind, kubecode_server::workspace::EntryKind::File);
    assert!(
        service
            .resolve_session_context_entry(
                &project.id,
                "session-shared",
                ExecutionMode::Shared,
                None,
                "src/main.rs",
                kubecode_server::workspace::EntryKind::Directory,
            )
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn session_context_resolution_rejects_ancestor_and_final_symlinks() {
    use std::os::unix::fs::symlink;

    let (_temp, service) = service();
    let project = worktree_project(&service, "context-symlink-project");
    let root = Path::new(&project.path);
    fs::create_dir(root.join("real")).expect("real");
    fs::write(root.join("real/file.txt"), "safe\n").expect("file");
    symlink(root.join("real"), root.join("linked-dir")).expect("ancestor symlink");
    symlink(root.join("real/file.txt"), root.join("linked-file.txt")).expect("final symlink");

    for path in ["linked-dir/file.txt", "linked-file.txt"] {
        assert!(
            service
                .resolve_session_context_entry(
                    &project.id,
                    "session-shared",
                    ExecutionMode::Shared,
                    None,
                    path,
                    kubecode_server::workspace::EntryKind::File,
                )
                .is_err(),
            "{path} must be rejected"
        );
    }
}
