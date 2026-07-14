use std::fs;
use std::path::PathBuf;

fn repository_file(path: &str) -> String {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    fs::read_to_string(repository.join(path)).expect("deployment file")
}

#[test]
fn image_pins_all_three_supported_agents_and_uses_s6() {
    let dockerfile = repository_file("deploy/Dockerfile");
    assert!(dockerfile.contains("CLAUDE_CODE_VERSION=2.1.205"));
    assert!(dockerfile.contains("CODEX_VERSION=0.144.3"));
    assert!(dockerfile.contains("OPENCODE_VERSION=1.17.20"));
    assert!(dockerfile.contains("ENTRYPOINT [\"/init\"]"));
    assert!(!dockerfile.contains("ollama"));
    assert!(!dockerfile.contains("lm-studio"));
}

#[test]
fn service_preserves_cli_state_and_forwards_kubeflow_prefix() {
    let init = repository_file("deploy/s6/init-persistent-home");
    let run = repository_file("deploy/s6/services.d/kubecode/run");
    assert!(init.contains("${PERSISTENT_DIR}/.state/claude"));
    assert!(init.contains("${PERSISTENT_DIR}/.state/codex"));
    assert!(init.contains("${PERSISTENT_DIR}/.state/opencode"));
    assert!(run.contains("NB_PREFIX"));
    assert!(run.contains("PORT=8888"));
}
