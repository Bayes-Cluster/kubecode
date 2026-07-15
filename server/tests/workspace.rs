use std::fs;

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

    fs::create_dir_all(service.root().join("existing/api")).expect("existing project");
    let imported = service
        .import_project_at(&service.root().join("existing/api"))
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
fn rejects_state_paths_traversal_and_duplicate_projects() {
    let (_temp, service) = service();

    assert!(
        service
            .import_project_at(&service.root().join(".state"))
            .is_err()
    );
    assert!(service.import_project_at("relative/project").is_err());
    assert!(service.create_project_at("relative/project").is_err());

    fs::create_dir_all(service.root().join("project")).expect("project directory");
    service
        .import_project_at(&service.root().join("project"))
        .expect("first import");
    assert!(
        service
            .import_project_at(&service.root().join("project"))
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
        .import_project_at(&service.root().join("escaped"))
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
