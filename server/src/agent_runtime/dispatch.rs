use tokio::sync::oneshot;

use crate::agents::{AgentRun, PermissionMode, StoreError};
use crate::composer_catalog::{
    ComposerCatalogError, ComposerContextSelector, ComposerDraftSegment, ComposerPreflightContext,
    opaque_git_diff_context_id, validate_structured_composer_segments,
};
use crate::workspace::WorkspaceError;

use super::actor::{AgentCommand, SessionCommand};
use super::{AgentRuntime, AgentSessionConfig, RuntimeError};

#[derive(Clone, Debug)]
pub struct StartAgentRun {
    pub conversation_id: String,
    pub project_id: String,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct StartComposerCommand {
    pub conversation_id: String,
    pub project_id: String,
    pub item_id: String,
    pub catalog_revision: u64,
    pub arguments: String,
}

#[derive(Clone, Debug)]
pub struct StartStructuredComposerRun {
    pub conversation_id: String,
    pub project_id: String,
    pub item_id: Option<String>,
    pub catalog_revision: u64,
    pub segments: Vec<ComposerDraftSegment>,
}

impl AgentRuntime {
    pub fn start(&self, request: StartAgentRun) -> Result<AgentRun, RuntimeError> {
        self.start_with_visibility(request, false)
    }

    pub fn start_acp_command(&self, request: StartAgentRun) -> Result<AgentRun, RuntimeError> {
        self.start_with_visibility(request, true)
    }

    pub fn start_composer_command(
        &self,
        request: StartComposerCommand,
    ) -> Result<AgentRun, RuntimeError> {
        let conversation = self.store.get_conversation(&request.conversation_id)?;
        if conversation.project_id != request.project_id {
            return Err(StoreError::ConversationNotFound(request.conversation_id).into());
        }
        let descriptor = self
            .agents
            .descriptor(conversation.agent_id)
            .filter(|agent| agent.available)
            .ok_or(RuntimeError::AgentUnavailable(conversation.agent_id))?;
        let cwd = self
            .workspace
            .execution_path(&request.project_id, conversation.workspace_path.as_deref())?;
        let dispatch = self.store.start_typed_composer_command_dispatch(
            &request.conversation_id,
            &request.project_id,
            &request.item_id,
            request.catalog_revision,
            &request.arguments,
            PermissionMode::Safe,
        )?;
        let run = dispatch.run;
        if let Ok(Some(tree)) = self
            .workspace
            .capture_git_tree(&cwd, &format!("{}-before", run.id))
        {
            let _ = self.store.set_run_checkpoint(&run.id, Some(&tree), None);
        }
        let (cancel, cancelled) = oneshot::channel();
        self.cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .insert(run.id.clone(), cancel);
        let agent_message = conversation
            .context_prefix
            .as_deref()
            .filter(|_| conversation.provider_session_id.is_none())
            .map(|context| {
                format!(
                    "{context}\n\nContinue with this user request:\n{}",
                    dispatch.prompt_message
                )
            })
            .unwrap_or(dispatch.prompt_message);
        let command = AgentCommand {
            run: run.clone(),
            message: agent_message,
            provider_input: dispatch.provider_input.map(Box::new),
            cancelled,
        };
        let config = AgentSessionConfig {
            conversation_id: conversation.id,
            agent_id: conversation.agent_id,
            descriptor,
            provider_session_id: conversation.provider_session_id,
            cwd,
            permission_profile: self.permission_profile(&request.conversation_id),
        };
        self.dispatch(config, SessionCommand::Prompt(command));
        Ok(run)
    }

    pub fn start_structured_composer(
        &self,
        request: StartStructuredComposerRun,
    ) -> Result<AgentRun, RuntimeError> {
        self.start_structured_composer_before_store(request, || {})
    }

    fn start_structured_composer_before_store(
        &self,
        request: StartStructuredComposerRun,
        before_store: impl FnOnce(),
    ) -> Result<AgentRun, RuntimeError> {
        let conversation = self.store.get_conversation(&request.conversation_id)?;
        if conversation.project_id != request.project_id {
            return Err(StoreError::ConversationNotFound(request.conversation_id).into());
        }
        validate_structured_composer_segments(&request.segments).map_err(StoreError::Composer)?;
        let descriptor = self
            .agents
            .descriptor(conversation.agent_id)
            .filter(|agent| agent.available)
            .ok_or(RuntimeError::AgentUnavailable(conversation.agent_id))?;
        let cwd = self.workspace.session_execution_path(
            &request.project_id,
            &conversation.agent_session_id,
            conversation.execution_mode,
            conversation.workspace_path.as_deref(),
        )?;
        let selectors = request
            .segments
            .iter()
            .filter_map(|segment| match segment {
                ComposerDraftSegment::ContextRef {
                    id,
                    catalog_revision,
                    context_kind,
                } => Some(ComposerContextSelector {
                    id: id.clone(),
                    catalog_revision: *catalog_revision,
                    context_kind: *context_kind,
                }),
                ComposerDraftSegment::Text { .. } | ComposerDraftSegment::CapabilityRef { .. } => {
                    None
                }
            })
            .collect::<Vec<_>>();
        before_store();
        let records = self.store.composer_context_records_for_preflight(
            &conversation.id,
            &conversation.project_id,
            &selectors,
        )?;
        let mut preflight = Vec::with_capacity(records.len());
        for (selector, record) in selectors.iter().zip(records) {
            let record = record.ok_or(StoreError::Composer(ComposerCatalogError::ContextStale))?;
            if record.kind != selector.context_kind {
                return Err(StoreError::Composer(ComposerCatalogError::ContextStale).into());
            }
            let expected_kind = match record.kind {
                crate::composer_catalog::ComposerContextKind::File => {
                    Some(crate::workspace::EntryKind::File)
                }
                crate::composer_catalog::ComposerContextKind::Directory => {
                    Some(crate::workspace::EntryKind::Directory)
                }
                crate::composer_catalog::ComposerContextKind::GitDiff
                | crate::composer_catalog::ComposerContextKind::Terminal
                | crate::composer_catalog::ComposerContextKind::SessionTurn => None,
                _ => return Err(StoreError::Composer(ComposerCatalogError::ItemUnsupported).into()),
            };
            if let Some(expected_kind) = expected_kind {
                let resolved = match self.workspace.resolve_session_context_entry(
                    &conversation.project_id,
                    &conversation.agent_session_id,
                    conversation.execution_mode,
                    conversation.workspace_path.as_deref(),
                    &record.path,
                    expected_kind,
                ) {
                    Ok(resolved) => resolved,
                    Err(error @ WorkspaceError::ProjectNotFound(_)) => return Err(error.into()),
                    Err(_) => {
                        return Err(StoreError::Composer(ComposerCatalogError::ContextStale).into());
                    }
                };
                preflight.push(ComposerPreflightContext {
                    id: record.id,
                    kind: record.kind,
                    path: resolved.path,
                    content: None,
                });
            } else if record.kind == crate::composer_catalog::ComposerContextKind::GitDiff {
                let path = (record.path != ".").then_some(record.path.as_str());
                let snapshot = self
                    .git
                    .resolve_composer_diff_blocking(
                        &conversation.project_id,
                        &conversation.agent_session_id,
                        conversation.execution_mode,
                        conversation.workspace_path.as_deref(),
                        path,
                    )
                    .map_err(|_| StoreError::Composer(ComposerCatalogError::ContextStale))?;
                let expected_id = opaque_git_diff_context_id(
                    &conversation.project_id,
                    &conversation.id,
                    &record.path,
                    &snapshot.source_revision,
                );
                if expected_id != record.id
                    || record.source_revision.as_deref() != Some(snapshot.source_revision.as_str())
                {
                    return Err(StoreError::Composer(ComposerCatalogError::ContextStale).into());
                }
                preflight.push(ComposerPreflightContext {
                    id: record.id,
                    kind: record.kind,
                    path: record.path,
                    content: Some(snapshot.content),
                });
            } else if record.kind == crate::composer_catalog::ComposerContextKind::Terminal {
                let resolved = self
                    .resolve_terminal_composer_context(&conversation.id, &record)?
                    .ok_or(StoreError::Composer(ComposerCatalogError::ContextStale))?;
                preflight.push(resolved);
            } else {
                let resolved = self
                    .resolve_session_turn_composer_context(
                        &conversation.id,
                        &conversation.project_id,
                        &record,
                    )?
                    .ok_or(StoreError::Composer(ComposerCatalogError::ContextStale))?;
                preflight.push(resolved);
            }
        }
        let dispatch = self.store.start_structured_composer_run_dispatch(
            &conversation.id,
            &conversation.project_id,
            request.item_id.as_deref(),
            request.catalog_revision,
            &request.segments,
            &preflight,
            PermissionMode::Safe,
        )?;
        let run = dispatch.run;
        if let Ok(Some(tree)) = self
            .workspace
            .capture_git_tree(&cwd, &format!("{}-before", run.id))
        {
            let _ = self.store.set_run_checkpoint(&run.id, Some(&tree), None);
        }
        let (cancel, cancelled) = oneshot::channel();
        self.cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .insert(run.id.clone(), cancel);
        let agent_message = conversation
            .context_prefix
            .as_deref()
            .filter(|_| conversation.provider_session_id.is_none())
            .map(|context| {
                format!(
                    "{context}\n\nContinue with this user request:\n{}",
                    dispatch.prompt_message
                )
            })
            .unwrap_or(dispatch.prompt_message);
        let command = AgentCommand {
            run: run.clone(),
            message: agent_message,
            provider_input: dispatch.provider_input.map(Box::new),
            cancelled,
        };
        let config = AgentSessionConfig {
            conversation_id: conversation.id,
            agent_id: conversation.agent_id,
            descriptor,
            provider_session_id: conversation.provider_session_id,
            cwd,
            permission_profile: self.permission_profile(&request.conversation_id),
        };
        self.dispatch(config, SessionCommand::Prompt(command));
        Ok(run)
    }

    pub(super) fn start_internal(&self, request: StartAgentRun) -> Result<AgentRun, RuntimeError> {
        self.start_with_visibility(request, true)
    }

    fn start_with_visibility(
        &self,
        request: StartAgentRun,
        internal: bool,
    ) -> Result<AgentRun, RuntimeError> {
        let conversation = self.store.get_conversation(&request.conversation_id)?;
        if conversation.project_id != request.project_id {
            return Err(StoreError::ConversationNotFound(request.conversation_id).into());
        }
        let descriptor = self
            .agents
            .descriptor(conversation.agent_id)
            .filter(|agent| agent.available)
            .ok_or(RuntimeError::AgentUnavailable(conversation.agent_id))?;
        let cwd = self
            .workspace
            .execution_path(&request.project_id, conversation.workspace_path.as_deref())?;
        let run = if internal {
            self.store.start_internal_run(
                &request.conversation_id,
                &request.project_id,
                &request.message,
                PermissionMode::Safe,
            )?
        } else {
            self.store.start_run(
                &request.conversation_id,
                &request.project_id,
                &request.message,
                PermissionMode::Safe,
            )?
        };
        if let Ok(Some(tree)) = self
            .workspace
            .capture_git_tree(&cwd, &format!("{}-before", run.id))
        {
            let _ = self.store.set_run_checkpoint(&run.id, Some(&tree), None);
        }
        let (cancel, cancelled) = oneshot::channel();
        self.cancellations
            .lock()
            .expect("agent cancellation mutex poisoned")
            .insert(run.id.clone(), cancel);

        let agent_message = conversation
            .context_prefix
            .as_deref()
            .filter(|_| conversation.provider_session_id.is_none())
            .map(|context| {
                format!(
                    "{context}\n\nContinue with this user request:\n{}",
                    request.message
                )
            })
            .unwrap_or_else(|| request.message.clone());
        let command = AgentCommand {
            run: run.clone(),
            message: agent_message,
            provider_input: None,
            cancelled,
        };
        let config = AgentSessionConfig {
            conversation_id: conversation.id,
            agent_id: conversation.agent_id,
            descriptor,
            provider_session_id: conversation.provider_session_id,
            cwd,
            permission_profile: self.permission_profile(&request.conversation_id),
        };
        self.dispatch(config, SessionCommand::Prompt(command));
        Ok(run)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::agent_discovery::AgentDescriptor;
    use crate::agent_runtime::{AgentRuntimeSessionCounts, run_git};
    use crate::agents::{AgentId, AgentStore};
    use crate::workspace::WorkspaceService;

    #[test]
    fn structured_catalog_replacement_after_preflight_never_dispatches_a_provider() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project = workspace
            .create_project_at(temp.path().join("structured-race"))
            .expect("project");
        std::fs::create_dir_all(temp.path().join("structured-race/src")).expect("source directory");
        std::fs::write(
            temp.path().join("structured-race/src/main.rs"),
            "fn main() {}\n",
        )
        .expect("context file");
        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let conversation = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("conversation");
        let registration = store
            .register_composer_context(
                &conversation.id,
                &project.id,
                crate::composer_catalog::ComposerContextKind::File,
                "src/main.rs",
            )
            .expect("registration");
        let runtime = AgentRuntime::new(
            workspace,
            Arc::clone(&store),
            vec![AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: "/bin/false".into(),
                error: None,
            }],
        );
        let committed_counts = Arc::new(Mutex::new(None));
        let observed_counts = Arc::clone(&committed_counts);
        let update_store = Arc::clone(&store);
        let update_conversation = conversation.id.clone();
        let error = runtime
            .start_structured_composer_before_store(
                StartStructuredComposerRun {
                    conversation_id: conversation.id.clone(),
                    project_id: project.id.clone(),
                    item_id: None,
                    catalog_revision: registration.catalog.revision,
                    segments: vec![ComposerDraftSegment::ContextRef {
                        id: registration.context.id,
                        catalog_revision: registration.catalog.revision,
                        context_kind: crate::composer_catalog::ComposerContextKind::File,
                    }],
                },
                move || {
                    update_store
                        .append_runtime_update(
                            &update_conversation,
                            "available_commands",
                            &json!({"availableCommands":[{
                                "name":"review", "description":"Review"
                            }]}),
                            None,
                        )
                        .expect("commit catalog replacement after preflight");
                    *observed_counts.lock().expect("observed counts") = Some((
                        update_store
                            .session_events_after(&update_conversation, 0)
                            .expect("session events after replacement")
                            .len(),
                        update_store
                            .latest_workspace_event_id()
                            .expect("workspace cursor after replacement"),
                    ));
                },
            )
            .expect_err("post-preflight replacement must stale the request");

        assert!(matches!(
            error,
            RuntimeError::Store(StoreError::Composer(ComposerCatalogError::StaleRevision))
        ));
        let (session_events, workspace_cursor) = committed_counts
            .lock()
            .expect("committed counts")
            .expect("replacement counts");
        assert!(store.list_runs(&conversation.id).expect("runs").is_empty());
        assert_eq!(
            store
                .session_events_after(&conversation.id, 0)
                .expect("session events after rejection")
                .len(),
            session_events
        );
        assert_eq!(
            store
                .latest_workspace_event_id()
                .expect("workspace cursor after rejection"),
            workspace_cursor
        );
        assert_eq!(
            runtime.session_counts(),
            AgentRuntimeSessionCounts { active: 0, idle: 0 }
        );
    }

    #[tokio::test]
    async fn structured_context_uses_the_shared_agent_session_worktree() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let database = temp.path().join("kubecode.sqlite3");
        let workspace =
            Arc::new(WorkspaceService::open(temp.path(), &database).expect("workspace service"));
        let project_root = temp.path().join("structured-shared-session");
        let project = workspace.create_project_at(&project_root).expect("project");
        run_git(&project_root, &["init"]);
        run_git(&project_root, &["config", "user.email", "test@example.com"]);
        run_git(&project_root, &["config", "user.name", "Kubecode Test"]);
        std::fs::write(project_root.join("README.md"), "root\n").expect("fixture");
        run_git(&project_root, &["add", "README.md"]);
        run_git(&project_root, &["commit", "-m", "initial"]);
        workspace
            .set_workspaces_enabled(&project.id, true)
            .expect("enable workspaces");

        let store = Arc::new(AgentStore::open(&database).expect("agent store"));
        let parent = store
            .create_conversation(&project.id, AgentId::OpenCode, None)
            .expect("parent conversation");
        let worktree = workspace
            .create_session_worktree(&project.id, &parent.agent_session_id)
            .expect("worktree");
        std::fs::write(worktree.join("context.txt"), "worktree\n").expect("context fixture");
        store
            .assign_execution_workspace(
                &parent.id,
                crate::agents::ExecutionMode::Worktree,
                Some(worktree.to_str().expect("worktree path")),
            )
            .expect("parent workspace");
        let child = store
            .create_team_member(&parent.id, AgentId::OpenCode, false)
            .expect("shared child conversation");
        assert_ne!(child.id, child.agent_session_id);
        assert_eq!(child.agent_session_id, parent.agent_session_id);
        let registration = store
            .register_composer_context(
                &child.id,
                &project.id,
                crate::composer_catalog::ComposerContextKind::File,
                "context.txt",
            )
            .expect("registration");
        let runtime = AgentRuntime::new(
            Arc::clone(&workspace),
            Arc::clone(&store),
            vec![AgentDescriptor {
                id: AgentId::OpenCode,
                available: true,
                version: Some("test".into()),
                executable: "/bin/false".into(),
                error: None,
            }],
        );

        let run = runtime
            .start_structured_composer(StartStructuredComposerRun {
                conversation_id: child.id.clone(),
                project_id: project.id,
                item_id: None,
                catalog_revision: registration.catalog.revision,
                segments: vec![ComposerDraftSegment::ContextRef {
                    id: registration.context.id,
                    catalog_revision: registration.catalog.revision,
                    context_kind: crate::composer_catalog::ComposerContextKind::File,
                }],
            })
            .expect("shared Agent Session context should resolve in its worktree");

        assert_eq!(run.message, "@context.txt");
    }
}
