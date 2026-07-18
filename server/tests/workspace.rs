use std::fs;
use std::path::Path;
use std::process::Command;

use kubecode_server::workspace::{EntryKind, WorkspaceError, WorkspaceService};
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
fn annotates_hidden_and_git_ignored_project_entries() {
    let (_temp, service) = service();
    let project = service
        .create_project_at(service.root().join("filtered-project"))
        .expect("project");
    let root = Path::new(&project.path);
    run_git(root, &["init"]);
    fs::write(root.join(".gitignore"), "build/\n").expect("gitignore");
    fs::write(root.join(".env"), "TOKEN=test\n").expect("hidden fixture");
    fs::create_dir(root.join("build")).expect("ignored directory");
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

    assert!(hidden.hidden);
    assert!(!hidden.ignored);
    assert!(!ignored.hidden);
    assert!(ignored.ignored);
    assert!(!visible.hidden);
    assert!(!visible.ignored);
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
