use std::collections::BTreeMap;
use std::str::FromStr;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};

use crate::composer_catalog::{
    ComposerCatalogError, ComposerCatalogSnapshot, ComposerContextKind, ComposerContextRecord,
    ComposerContextRegistration, ComposerContextSelector, ComposerContextSummary,
    ComposerContextValidationResponse, ComposerContextValidationResult, ComposerDraftSegment,
    ComposerPreflightContext, ComposerSessionTurnRole, ComposerSessionTurnSnapshot,
    MAX_COMPOSER_CONTEXTS, MAX_COMPOSER_TEXT_BYTES, MAX_COMPOSER_VALIDATION_ROWS,
    MAX_SESSION_TURN_CONTEXT_BYTES, MAX_SESSION_TURN_CONTEXT_LINES, ResolvedComposerDispatch,
    context_kind_key, opaque_context_id, opaque_git_diff_context_id,
    opaque_session_turn_context_id, opaque_terminal_context_id, parse_context_kind,
    parse_session_turn_selector, project_acp_catalog_with_contexts,
    resolve_composer_catalog_dispatch, session_turn_source_revision,
    validate_structured_composer_segments,
};

use super::AgentStore;
use super::events::{
    append_session_event_transaction, append_workspace_event_transaction,
    deserialize_stored_session_event, latest_workspace_event_id, stored_session_event_row,
};
use super::models::{AgentId, AgentRun, ComposerRunDispatch, PermissionMode, StoreError};
use super::runs::insert_run_transaction;

impl AgentStore {
    pub fn start_typed_composer_command(
        &self,
        conversation_id: &str,
        project_id: &str,
        item_id: &str,
        catalog_revision: u64,
        arguments: &str,
        permission_mode: PermissionMode,
    ) -> Result<AgentRun, StoreError> {
        self.start_typed_composer_command_dispatch(
            conversation_id,
            project_id,
            item_id,
            catalog_revision,
            arguments,
            permission_mode,
        )
        .map(|dispatch| dispatch.run)
    }

    pub fn start_typed_composer_command_dispatch(
        &self,
        conversation_id: &str,
        project_id: &str,
        item_id: &str,
        catalog_revision: u64,
        arguments: &str,
        permission_mode: PermissionMode,
    ) -> Result<ComposerRunDispatch, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (conversation_project, agent_id) = conversation_scope(&transaction, conversation_id)?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let snapshot = latest_catalog_transaction(&transaction, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
        let raw = latest_session_payload_transaction(
            &transaction,
            conversation_id,
            "available_commands",
        )?
        .ok_or(ComposerCatalogError::ItemMissing)?;
        let expected = authoritative_catalog_transaction(
            &transaction,
            project_id,
            conversation_id,
            agent_id,
            snapshot.revision,
        )?;
        if !snapshot.same_contents(&expected) {
            return Err(StoreError::InvalidStoredValue(
                "composer catalog does not match its authoritative sources".into(),
            ));
        }
        let dispatch = resolve_composer_catalog_dispatch(
            project_id,
            conversation_id,
            agent_id,
            &snapshot,
            &raw,
            catalog_revision,
            item_id,
            arguments,
        )?;
        let active = transaction
            .query_row(
                "SELECT id FROM agent_runs
                 WHERE conversation_id = ?1 AND status IN ('running', 'waiting_permission')
                 LIMIT 1",
                [conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if active.is_some() {
            return Err(StoreError::ActiveRun(project_id.to_owned()));
        }
        let run = insert_run_transaction(
            &transaction,
            conversation_id,
            project_id,
            &dispatch.display_message,
            permission_mode,
            true,
        )?;
        let workspace_cursor = latest_workspace_event_id(&transaction)?;
        transaction.commit()?;
        self.workspace_event_bus.publish_committed(workspace_cursor);
        drop(database);
        self.append_session_event(
            conversation_id,
            "user_message",
            &json!({"run_id":run.id, "text":dispatch.display_message, "internal":true}),
        )?;
        Ok(ComposerRunDispatch {
            run,
            prompt_message: dispatch.prompt_message,
            provider_input: dispatch.provider_input,
        })
    }

    pub fn composer_catalog_snapshot(
        &self,
        conversation_id: &str,
    ) -> Result<ComposerCatalogSnapshot, StoreError> {
        self.get_conversation(conversation_id)?;
        let database = self.database.lock().expect("agent database mutex poisoned");
        Ok(latest_catalog_connection(&database, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id)))
    }

    pub fn register_composer_context(
        &self,
        conversation_id: &str,
        project_id: &str,
        kind: ComposerContextKind,
        normalized_relative_path: &str,
    ) -> Result<ComposerContextRegistration, StoreError> {
        if !matches!(
            kind,
            ComposerContextKind::File | ComposerContextKind::Directory
        ) || normalized_relative_path.is_empty()
        {
            return Err(ComposerCatalogError::InvalidDraft.into());
        }
        let id = opaque_context_id(project_id, conversation_id, kind, normalized_relative_path);
        self.register_composer_context_record(
            conversation_id,
            project_id,
            kind,
            normalized_relative_path,
            id,
            None,
            None,
            false,
        )
    }

    pub fn register_composer_git_diff_context(
        &self,
        conversation_id: &str,
        project_id: &str,
        selector: &str,
        source_revision: &str,
        summary: ComposerContextSummary,
    ) -> Result<ComposerContextRegistration, StoreError> {
        if selector.is_empty() || source_revision.len() != 64 {
            return Err(ComposerCatalogError::InvalidDraft.into());
        }
        let id = opaque_git_diff_context_id(project_id, conversation_id, selector, source_revision);
        self.register_composer_context_record(
            conversation_id,
            project_id,
            ComposerContextKind::GitDiff,
            selector,
            id,
            Some(source_revision),
            Some(summary),
            true,
        )
    }

    pub fn register_composer_terminal_context(
        &self,
        conversation_id: &str,
        project_id: &str,
        selector: &str,
        source_revision: &str,
        summary: ComposerContextSummary,
    ) -> Result<ComposerContextRegistration, StoreError> {
        if selector.is_empty() || source_revision.len() != 64 {
            return Err(ComposerCatalogError::InvalidDraft.into());
        }
        let id = opaque_terminal_context_id(project_id, conversation_id, selector, source_revision);
        self.register_composer_context_record(
            conversation_id,
            project_id,
            ComposerContextKind::Terminal,
            selector,
            id,
            Some(source_revision),
            Some(summary),
            true,
        )
    }

    pub fn register_composer_session_turn_context(
        &self,
        conversation_id: &str,
        project_id: &str,
        selector: &str,
        source_revision: &str,
        summary: ComposerContextSummary,
    ) -> Result<ComposerContextRegistration, StoreError> {
        let role = parse_session_turn_selector(selector).map(|(role, _)| role);
        let summary_is_valid = matches!(
            &summary,
            ComposerContextSummary::SessionTurn {
                role: summary_role,
                line_count,
                byte_count,
            } if Some(*summary_role) == role
                && *line_count > 0
                && *line_count <= MAX_SESSION_TURN_CONTEXT_LINES
                && *byte_count > 0
                && *byte_count <= MAX_SESSION_TURN_CONTEXT_BYTES
        );
        if role.is_none() || source_revision.len() != 64 || !summary_is_valid {
            return Err(ComposerCatalogError::InvalidDraft.into());
        }
        let id =
            opaque_session_turn_context_id(project_id, conversation_id, selector, source_revision);
        self.register_composer_context_record(
            conversation_id,
            project_id,
            ComposerContextKind::SessionTurn,
            selector,
            id,
            Some(source_revision),
            Some(summary),
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn register_composer_context_record(
        &self,
        conversation_id: &str,
        project_id: &str,
        kind: ComposerContextKind,
        normalized_relative_path: &str,
        id: String,
        source_revision: Option<&str>,
        summary: Option<ComposerContextSummary>,
        replace_selector: bool,
    ) -> Result<ComposerContextRegistration, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (conversation_project, agent_id) = conversation_scope(&transaction, conversation_id)?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        if replace_selector {
            transaction.execute(
                "DELETE FROM composer_contexts
                 WHERE conversation_id = ?1 AND kind = ?2 AND relative_path = ?3
                   AND opaque_id <> ?4",
                params![
                    conversation_id,
                    context_kind_key(kind),
                    normalized_relative_path,
                    id
                ],
            )?;
        }
        let existing = context_record_transaction(&transaction, conversation_id, &id)?;
        if let Some(existing) = &existing {
            if existing.project_id != project_id
                || existing.conversation_id != conversation_id
                || existing.kind != kind
                || existing.path != normalized_relative_path
                || existing.source_revision.as_deref() != source_revision
                || existing.summary != summary
            {
                return Err(StoreError::InvalidStoredValue(
                    "composer context identity tuple mismatch".into(),
                ));
            }
            transaction.execute(
                "UPDATE composer_contexts
                 SET available = 1, source_revision = ?3, metadata = ?4,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE conversation_id = ?1 AND opaque_id = ?2",
                params![
                    conversation_id,
                    id,
                    source_revision,
                    summary.as_ref().map(serde_json::to_string).transpose()?,
                ],
            )?;
        } else {
            let count = transaction.query_row(
                "SELECT COUNT(*) FROM composer_contexts WHERE conversation_id = ?1",
                [conversation_id],
                |row| row.get::<_, i64>(0),
            )?;
            if usize::try_from(count).unwrap_or(usize::MAX) >= MAX_COMPOSER_CONTEXTS {
                return Err(ComposerCatalogError::ContextOverLimit.into());
            }
            transaction.execute(
                "INSERT INTO composer_contexts
                 (conversation_id, opaque_id, project_id, kind, relative_path, available,
                  source_revision, metadata)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
                params![
                    conversation_id,
                    id,
                    project_id,
                    context_kind_key(kind),
                    normalized_relative_path,
                    source_revision,
                    summary.as_ref().map(serde_json::to_string).transpose()?,
                ],
            )?;
        }
        let previous = latest_catalog_transaction(&transaction, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
        let mut catalog = authoritative_catalog_transaction(
            &transaction,
            project_id,
            conversation_id,
            agent_id,
            previous.revision,
        )?;
        let mut workspace_cursor = None;
        if !previous.same_contents(&catalog) {
            let revision = next_catalog_revision_transaction(&transaction, conversation_id)?;
            catalog = authoritative_catalog_transaction(
                &transaction,
                project_id,
                conversation_id,
                agent_id,
                revision,
            )?;
            workspace_cursor = Some(issue_catalog_snapshot_transaction(
                &transaction,
                project_id,
                conversation_id,
                &catalog,
            )?);
        }
        let context = catalog
            .contexts
            .iter()
            .find(|context| context.id == id)
            .cloned()
            .ok_or_else(|| StoreError::InvalidStoredValue("registered context missing".into()))?;
        transaction.commit()?;
        if let Some(cursor) = workspace_cursor {
            self.workspace_event_bus.publish_committed(cursor);
        }
        Ok(ComposerContextRegistration { context, catalog })
    }

    pub fn composer_context_records_for_preflight(
        &self,
        conversation_id: &str,
        project_id: &str,
        selectors: &[ComposerContextSelector],
    ) -> Result<Vec<Option<ComposerContextRecord>>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let conversation_project = database
            .query_row(
                "SELECT project_id FROM conversations WHERE id = ?1",
                [conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        selectors
            .iter()
            .map(|selector| context_record_connection(&database, conversation_id, &selector.id))
            .collect()
    }

    pub fn validate_composer_contexts(
        &self,
        conversation_id: &str,
        project_id: &str,
        selectors: &[ComposerContextSelector],
        preflight: &[Option<ComposerPreflightContext>],
    ) -> Result<ComposerContextValidationResponse, StoreError> {
        if selectors.len() > MAX_COMPOSER_VALIDATION_ROWS || selectors.len() != preflight.len() {
            return Err(ComposerCatalogError::ContextOverLimit.into());
        }
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (conversation_project, agent_id) = conversation_scope(&transaction, conversation_id)?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let mut results = Vec::with_capacity(selectors.len());
        for (selector, preflight) in selectors.iter().zip(preflight) {
            let record = context_record_transaction(&transaction, conversation_id, &selector.id)?;
            let historical = catalog_snapshot_at_transaction(
                &transaction,
                conversation_id,
                selector.catalog_revision,
            )?;
            let historically_valid = historical.as_ref().is_some_and(|snapshot| {
                snapshot.contexts.iter().any(|context| {
                    context.id == selector.id
                        && context.kind == selector.context_kind
                        && context.enabled
                })
            });
            let available = match (&record, preflight) {
                (Some(record), Some(preflight)) => {
                    record.project_id == project_id
                        && record.conversation_id == conversation_id
                        && record.kind == selector.context_kind
                        && preflight.id == record.id
                        && preflight.kind == record.kind
                        && preflight.path == record.path
                        && historically_valid
                }
                _ => false,
            };
            if let Some(record) = &record {
                transaction.execute(
                    "UPDATE composer_contexts
                     SET available = ?3, updated_at = CURRENT_TIMESTAMP
                     WHERE conversation_id = ?1 AND opaque_id = ?2",
                    params![conversation_id, record.id, available],
                )?;
            }
            results.push(ComposerContextValidationResult {
                id: selector.id.clone(),
                catalog_revision: selector.catalog_revision,
                context_kind: selector.context_kind,
                available,
            });
        }
        let previous = latest_catalog_transaction(&transaction, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
        let mut catalog = authoritative_catalog_transaction(
            &transaction,
            project_id,
            conversation_id,
            agent_id,
            previous.revision,
        )?;
        let mut workspace_cursor = None;
        if !previous.same_contents(&catalog) {
            let revision = next_catalog_revision_transaction(&transaction, conversation_id)?;
            catalog = authoritative_catalog_transaction(
                &transaction,
                project_id,
                conversation_id,
                agent_id,
                revision,
            )?;
            workspace_cursor = Some(issue_catalog_snapshot_transaction(
                &transaction,
                project_id,
                conversation_id,
                &catalog,
            )?);
        }
        transaction.commit()?;
        if let Some(cursor) = workspace_cursor {
            self.workspace_event_bus.publish_committed(cursor);
        }
        Ok(ComposerContextValidationResponse {
            references: results,
            catalog,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_structured_composer_run(
        &self,
        conversation_id: &str,
        project_id: &str,
        item_id: Option<&str>,
        catalog_revision: u64,
        segments: &[ComposerDraftSegment],
        preflight: &[ComposerPreflightContext],
        permission_mode: PermissionMode,
    ) -> Result<AgentRun, StoreError> {
        self.start_structured_composer_run_dispatch(
            conversation_id,
            project_id,
            item_id,
            catalog_revision,
            segments,
            preflight,
            permission_mode,
        )
        .map(|dispatch| dispatch.run)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_structured_composer_run_dispatch(
        &self,
        conversation_id: &str,
        project_id: &str,
        item_id: Option<&str>,
        catalog_revision: u64,
        segments: &[ComposerDraftSegment],
        preflight: &[ComposerPreflightContext],
        permission_mode: PermissionMode,
    ) -> Result<ComposerRunDispatch, StoreError> {
        validate_structured_composer_segments(segments)?;
        let preflight = preflight
            .iter()
            .map(|context| (context.id.as_str(), context))
            .collect::<BTreeMap<_, _>>();
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (conversation_project, agent_id) = conversation_scope(&transaction, conversation_id)?;
        if conversation_project != project_id {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let current = latest_catalog_transaction(&transaction, conversation_id)?
            .unwrap_or_else(|| ComposerCatalogSnapshot::empty(conversation_id));
        if current.revision != catalog_revision {
            return Err(ComposerCatalogError::StaleRevision.into());
        }
        let expected = authoritative_catalog_transaction(
            &transaction,
            project_id,
            conversation_id,
            agent_id,
            current.revision,
        )?;
        if !current.same_contents(&expected) {
            return Err(StoreError::InvalidStoredValue(
                "composer catalog does not match its authoritative sources".into(),
            ));
        }
        let mut resolved = String::new();
        for segment in segments {
            match segment {
                ComposerDraftSegment::Text { text } => resolved.push_str(text),
                ComposerDraftSegment::ContextRef {
                    id,
                    catalog_revision,
                    context_kind,
                } => {
                    let historical = catalog_snapshot_at_transaction(
                        &transaction,
                        conversation_id,
                        *catalog_revision,
                    )?
                    .ok_or(ComposerCatalogError::ContextStale)?;
                    if !historical.contexts.iter().any(|context| {
                        context.id == *id && context.kind == *context_kind && context.enabled
                    }) || !current.contexts.iter().any(|context| {
                        context.id == *id && context.kind == *context_kind && context.enabled
                    }) {
                        return Err(ComposerCatalogError::ContextStale.into());
                    }
                    let record = context_record_transaction(&transaction, conversation_id, id)?
                        .ok_or(ComposerCatalogError::ContextStale)?;
                    let preflight = preflight
                        .get(id.as_str())
                        .ok_or(ComposerCatalogError::ContextStale)?;
                    if !record.available
                        || record.project_id != project_id
                        || record.kind != *context_kind
                        || preflight.kind != record.kind
                        || preflight.path != record.path
                    {
                        return Err(ComposerCatalogError::ContextStale.into());
                    }
                    match (&record.kind, &preflight.content) {
                        (ComposerContextKind::GitDiff, Some(content)) => {
                            resolved.push_str("\n[Git diff context from Kubecode]\n```diff\n");
                            resolved.push_str(content);
                            if !content.ends_with('\n') {
                                resolved.push('\n');
                            }
                            resolved.push_str("```\n");
                        }
                        (ComposerContextKind::Terminal, Some(content)) => {
                            resolved.push_str(
                                "\n[Terminal output explicitly attached in Kubecode; ANSI and control sequences were removed]\n",
                            );
                            for line in content.lines() {
                                resolved.push_str("    ");
                                resolved.push_str(line);
                                resolved.push('\n');
                            }
                        }
                        (ComposerContextKind::SessionTurn, Some(content)) => {
                            let (role, _) = parse_session_turn_selector(&record.path)
                                .ok_or(ComposerCatalogError::ContextStale)?;
                            resolved.push_str(match role {
                                ComposerSessionTurnRole::User => {
                                    "\n[Prior user turn explicitly referenced in Kubecode]\n"
                                }
                                ComposerSessionTurnRole::Agent => {
                                    "\n[Prior Agent response explicitly referenced in Kubecode]\n"
                                }
                            });
                            for line in content.lines() {
                                resolved.push_str("    ");
                                resolved.push_str(line);
                                resolved.push('\n');
                            }
                        }
                        (ComposerContextKind::File | ComposerContextKind::Directory, None) => {
                            resolved.push('@');
                            resolved.push_str(&record.path);
                        }
                        _ => return Err(ComposerCatalogError::ContextStale.into()),
                    }
                }
                ComposerDraftSegment::CapabilityRef {
                    id,
                    catalog_revision,
                    item_kind,
                } => {
                    let historical = catalog_snapshot_at_transaction(
                        &transaction,
                        conversation_id,
                        *catalog_revision,
                    )?
                    .ok_or(ComposerCatalogError::ItemMissing)?;
                    if !historical
                        .items
                        .iter()
                        .any(|item| item.id == *id && item.kind == *item_kind && item.enabled)
                        || !current
                            .items
                            .iter()
                            .any(|item| item.id == *id && item.kind == *item_kind && item.enabled)
                    {
                        return Err(ComposerCatalogError::ItemMissing.into());
                    }
                    return Err(ComposerCatalogError::ItemUnsupported.into());
                }
            }
        }
        if resolved.len() > MAX_COMPOSER_TEXT_BYTES {
            return Err(ComposerCatalogError::TextTooLong.into());
        }
        let (dispatch, internal) = if let Some(item_id) = item_id {
            let raw = latest_session_payload_transaction(
                &transaction,
                conversation_id,
                "available_commands",
            )?
            .ok_or(ComposerCatalogError::ItemMissing)?;
            (
                resolve_composer_catalog_dispatch(
                    project_id,
                    conversation_id,
                    agent_id,
                    &current,
                    &raw,
                    catalog_revision,
                    item_id,
                    &resolved,
                )?,
                true,
            )
        } else {
            if resolved.trim().is_empty() {
                return Err(ComposerCatalogError::InvalidDraft.into());
            }
            (
                ResolvedComposerDispatch {
                    display_message: resolved.clone(),
                    prompt_message: resolved,
                    provider_input: None,
                },
                false,
            )
        };
        let active = transaction
            .query_row(
                "SELECT id FROM agent_runs
                 WHERE conversation_id = ?1 AND status IN ('running', 'waiting_permission')
                 LIMIT 1",
                [conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if active.is_some() {
            return Err(StoreError::ActiveRun(project_id.to_owned()));
        }
        let run = insert_run_transaction(
            &transaction,
            conversation_id,
            project_id,
            &dispatch.display_message,
            permission_mode,
            internal,
        )?;
        append_session_event_transaction(
            &transaction,
            conversation_id,
            "user_message",
            &json!({"run_id":run.id, "text":dispatch.display_message, "internal":internal}),
        )?;
        let workspace_cursor = latest_workspace_event_id(&transaction)?;
        transaction.commit()?;
        self.workspace_event_bus.publish_committed(workspace_cursor);
        drop(database);
        if !internal {
            self.set_agent_title_if_untitled(conversation_id, &dispatch.display_message)?;
        }
        Ok(ComposerRunDispatch {
            run,
            prompt_message: dispatch.prompt_message,
            provider_input: dispatch.provider_input,
        })
    }

    pub fn resolve_composer_session_turn(
        &self,
        conversation_id: &str,
        selector: &str,
        role: ComposerSessionTurnRole,
    ) -> Result<ComposerSessionTurnSnapshot, StoreError> {
        const MAX_SELECTOR_BYTES: usize = 256;
        const MAX_TURN_EVENTS: usize = 512;
        if selector.is_empty() || selector.len() > MAX_SELECTOR_BYTES {
            return Err(ComposerCatalogError::ContextStale.into());
        }
        let conversation = self.get_conversation(conversation_id)?;
        if conversation.read_only {
            return Err(ComposerCatalogError::ContextStale.into());
        }
        let database = self.database.lock().expect("agent database mutex poisoned");
        let native_sequence = selector
            .strip_prefix("native-")
            .map(|sequence| {
                sequence
                    .parse::<i64>()
                    .map_err(|_| ComposerCatalogError::ContextStale)
            })
            .transpose()?;
        let stored_anchor = if let Some(sequence) = native_sequence {
            database
                .query_row(
                    "SELECT conversation_id, seq, kind, payload, created_at
                     FROM session_events WHERE conversation_id = ?1 AND seq = ?2",
                    params![conversation_id, sequence],
                    stored_session_event_row,
                )
                .optional()?
        } else {
            database
                .query_row(
                    "SELECT conversation_id, seq, kind, payload, created_at
                     FROM session_events
                     WHERE conversation_id = ?1 AND kind = 'user_message'
                       AND json_extract(payload, '$.run_id') = ?2
                     LIMIT 1",
                    params![conversation_id, selector],
                    stored_session_event_row,
                )
                .optional()?
        }
        .ok_or(ComposerCatalogError::ContextStale)?;
        let anchor = deserialize_stored_session_event(stored_anchor)?;
        let previous_kind = if anchor.kind == "user_message_delta" {
            database
                .query_row(
                    "SELECT kind FROM session_events
                     WHERE conversation_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT 1",
                    params![
                        conversation_id,
                        i64::try_from(anchor.seq).map_err(|_| {
                            StoreError::InvalidStoredValue(
                                "session event sequence exceeds SQLite range".into(),
                            )
                        })?
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else {
            None
        };
        let is_native_delta_anchor = native_sequence.is_some()
            && anchor.kind == "user_message_delta"
            && previous_kind.as_deref() != Some("user_message_delta");
        if (anchor.kind != "user_message" && !is_native_delta_anchor)
            || anchor.payload.get("internal").and_then(Value::as_bool) == Some(true)
        {
            return Err(ComposerCatalogError::ContextStale.into());
        }
        if let Some(run_id) = anchor.payload.get("run_id").and_then(Value::as_str) {
            let active = database
                .query_row(
                    "SELECT 1 FROM agent_runs
                     WHERE id = ?1 AND conversation_id = ?2
                       AND status IN ('running', 'waiting_permission')",
                    params![run_id, conversation_id],
                    |_| Ok(()),
                )
                .optional()?;
            if active.is_some() {
                return Err(ComposerCatalogError::ContextStale.into());
            }
        }
        let event_limit =
            i64::try_from(MAX_TURN_EVENTS + 1).expect("session turn event limit fits SQLite range");
        let mut statement = database.prepare(
            "SELECT conversation_id, seq, kind, payload, created_at
             FROM session_events
             WHERE conversation_id = ?1 AND seq >= ?2 ORDER BY seq LIMIT ?3",
        )?;
        let anchor_sequence = i64::try_from(anchor.seq).map_err(|_| {
            StoreError::InvalidStoredValue("session event sequence exceeds SQLite range".into())
        })?;
        let stored_events = statement
            .query_map(
                params![conversation_id, anchor_sequence, event_limit],
                stored_session_event_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let events = stored_events
            .into_iter()
            .map(deserialize_stored_session_event)
            .collect::<Result<Vec<_>, _>>()?;
        let end = events
            .iter()
            .enumerate()
            .skip(1)
            .find(|(index, event)| {
                event.kind == "user_message"
                    || (event.kind == "user_message_delta"
                        && events
                            .get(index.saturating_sub(1))
                            .is_none_or(|previous| previous.kind != "user_message_delta"))
            })
            .map(|(index, _)| index)
            .unwrap_or(events.len());
        if end > MAX_TURN_EVENTS || (end == events.len() && events.len() > MAX_TURN_EVENTS) {
            return Err(ComposerCatalogError::ContextOverLimit.into());
        }
        let turn = &events[..end];
        let mut content = String::new();
        match role {
            ComposerSessionTurnRole::User if anchor.kind == "user_message" => {
                append_session_turn_content(
                    &mut content,
                    anchor
                        .payload
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )?;
            }
            ComposerSessionTurnRole::User => {
                for event in turn
                    .iter()
                    .take_while(|event| event.kind == "user_message_delta")
                {
                    if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                        append_session_turn_content(&mut content, text)?;
                    }
                }
            }
            ComposerSessionTurnRole::Agent => {
                for event in turn.iter().filter(|event| event.kind == "text_delta") {
                    if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                        append_session_turn_content(&mut content, text)?;
                    }
                }
            }
        }
        if content.is_empty() {
            return Err(ComposerCatalogError::ContextStale.into());
        }
        let line_count = content.split('\n').count();
        if line_count > MAX_SESSION_TURN_CONTEXT_LINES {
            return Err(ComposerCatalogError::ContextOverLimit.into());
        }
        Ok(ComposerSessionTurnSnapshot {
            selector: selector.to_owned(),
            role,
            source_revision: session_turn_source_revision(
                conversation_id,
                selector,
                role,
                &content,
            ),
            line_count,
            byte_count: content.len(),
            content,
        })
    }
}

fn append_session_turn_content(content: &mut String, text: &str) -> Result<(), StoreError> {
    if content
        .len()
        .checked_add(text.len())
        .is_none_or(|length| length > MAX_SESSION_TURN_CONTEXT_BYTES)
    {
        return Err(ComposerCatalogError::ContextOverLimit.into());
    }
    content.push_str(text);
    Ok(())
}

fn conversation_scope(
    transaction: &Transaction<'_>,
    conversation_id: &str,
) -> Result<(String, AgentId), StoreError> {
    let (project_id, agent_id) = transaction
        .query_row(
            "SELECT project_id, agent_id FROM conversations WHERE id = ?1",
            [conversation_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))?;
    Ok((project_id, AgentId::from_str(&agent_id)?))
}

fn latest_session_payload_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    kind: &str,
) -> Result<Option<Value>, StoreError> {
    let payload = transaction
        .query_row(
            "SELECT payload FROM session_events
             WHERE conversation_id = ?1 AND kind = ?2
             ORDER BY seq DESC LIMIT 1",
            params![conversation_id, kind],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    payload
        .map(|payload| serde_json::from_str(&payload).map_err(StoreError::from))
        .transpose()
}

pub(super) fn latest_catalog_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
) -> Result<Option<ComposerCatalogSnapshot>, StoreError> {
    let snapshot =
        latest_session_payload_transaction(transaction, conversation_id, "composer_catalog")?
            .map(serde_json::from_value)
            .transpose()
            .map_err(StoreError::from)?;
    Ok(snapshot
        .filter(|snapshot: &ComposerCatalogSnapshot| snapshot.conversation_id == conversation_id))
}

fn catalog_snapshot_at_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    revision: u64,
) -> Result<Option<ComposerCatalogSnapshot>, StoreError> {
    let revision = i64::try_from(revision)
        .map_err(|error| StoreError::InvalidStoredValue(error.to_string()))?;
    let payload = transaction
        .query_row(
            "SELECT payload FROM composer_catalog_snapshots
             WHERE conversation_id = ?1 AND revision = ?2",
            params![conversation_id, revision],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let snapshot = payload
        .map(|payload| serde_json::from_str::<ComposerCatalogSnapshot>(&payload))
        .transpose()?;
    Ok(snapshot.filter(|snapshot| {
        snapshot.conversation_id == conversation_id && snapshot.revision == revision as u64
    }))
}

fn context_record_connection(
    database: &Connection,
    conversation_id: &str,
    opaque_id: &str,
) -> Result<Option<ComposerContextRecord>, StoreError> {
    let stored = database
        .query_row(
            "SELECT project_id, kind, relative_path, available, source_revision, metadata
             FROM composer_contexts
             WHERE conversation_id = ?1 AND opaque_id = ?2",
            params![conversation_id, opaque_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?;
    stored
        .map(
            |(project_id, kind, path, available, source_revision, metadata)| {
                let kind = parse_context_kind(&kind).ok_or_else(|| {
                    StoreError::InvalidStoredValue("unknown composer context kind".into())
                })?;
                let summary = metadata
                    .map(|metadata| serde_json::from_str::<ComposerContextSummary>(&metadata))
                    .transpose()?;
                Ok(ComposerContextRecord {
                    id: opaque_id.to_owned(),
                    project_id,
                    conversation_id: conversation_id.to_owned(),
                    kind,
                    path,
                    available,
                    source_revision,
                    summary,
                })
            },
        )
        .transpose()
}

fn context_record_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
    opaque_id: &str,
) -> Result<Option<ComposerContextRecord>, StoreError> {
    context_record_connection(transaction, conversation_id, opaque_id)
}

fn composer_contexts_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
) -> Result<Vec<crate::composer_catalog::ComposerContextMeta>, StoreError> {
    let mut statement = transaction.prepare(
        "SELECT opaque_id, project_id, kind, relative_path, available, source_revision, metadata
         FROM composer_contexts WHERE conversation_id = ?1
         ORDER BY relative_path, kind, opaque_id",
    )?;
    let rows = statement
        .query_map([conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(
            |(id, project_id, kind, path, available, source_revision, metadata)| {
                let kind = parse_context_kind(&kind).ok_or_else(|| {
                    StoreError::InvalidStoredValue("unknown composer context kind".into())
                })?;
                let summary = metadata
                    .map(|metadata| serde_json::from_str::<ComposerContextSummary>(&metadata))
                    .transpose()?;
                Ok(ComposerContextRecord {
                    id,
                    project_id,
                    conversation_id: conversation_id.to_owned(),
                    kind,
                    path,
                    available,
                    source_revision,
                    summary,
                }
                .safe_meta())
            },
        )
        .collect()
}

pub(super) fn authoritative_catalog_transaction(
    transaction: &Transaction<'_>,
    project_id: &str,
    conversation_id: &str,
    agent_id: AgentId,
    revision: u64,
) -> Result<ComposerCatalogSnapshot, StoreError> {
    let raw =
        latest_session_payload_transaction(transaction, conversation_id, "available_commands")?
            .unwrap_or_else(|| json!({"availableCommands":[]}));
    Ok(project_acp_catalog_with_contexts(
        project_id,
        conversation_id,
        agent_id,
        revision,
        &raw,
        composer_contexts_transaction(transaction, conversation_id)?,
    ))
}

pub(super) fn issue_catalog_snapshot_transaction(
    transaction: &Transaction<'_>,
    project_id: &str,
    conversation_id: &str,
    snapshot: &ComposerCatalogSnapshot,
) -> Result<u64, StoreError> {
    let payload = serde_json::to_value(snapshot)?;
    append_session_event_transaction(transaction, conversation_id, "composer_catalog", &payload)?;
    transaction.execute(
        "INSERT INTO composer_catalog_snapshots (conversation_id, revision, payload)
         VALUES (?1, ?2, ?3)",
        params![
            conversation_id,
            i64::try_from(snapshot.revision)
                .map_err(|error| StoreError::InvalidStoredValue(error.to_string()))?,
            serde_json::to_string(snapshot)?,
        ],
    )?;
    append_workspace_event_transaction(
        transaction,
        "composer_catalog_snapshot",
        Some(project_id),
        Some(conversation_id),
        None,
        &json!({
            "conversation_id": conversation_id,
            "revision": snapshot.revision,
            "snapshot": snapshot,
        }),
    )
}

fn latest_catalog_connection(
    database: &Connection,
    conversation_id: &str,
) -> Result<Option<ComposerCatalogSnapshot>, StoreError> {
    let payload = database
        .query_row(
            "SELECT payload FROM session_events
             WHERE conversation_id = ?1 AND kind = 'composer_catalog'
             ORDER BY seq DESC LIMIT 1",
            [conversation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let snapshot = payload
        .map(|payload| serde_json::from_str(&payload).map_err(StoreError::from))
        .transpose()?;
    Ok(snapshot
        .filter(|snapshot: &ComposerCatalogSnapshot| snapshot.conversation_id == conversation_id))
}

pub(super) fn next_catalog_revision_transaction(
    transaction: &Transaction<'_>,
    conversation_id: &str,
) -> Result<u64, StoreError> {
    let current = transaction
        .query_row(
            "SELECT composer_catalog_revision FROM conversations WHERE id = ?1",
            [conversation_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))?;
    let next = current.checked_add(1).ok_or_else(|| {
        StoreError::InvalidStoredValue("composer catalog revision overflow".into())
    })?;
    transaction.execute(
        "UPDATE conversations SET composer_catalog_revision = ?2 WHERE id = ?1",
        params![conversation_id, next],
    )?;
    u64::try_from(next)
        .map_err(|_| StoreError::InvalidStoredValue("negative composer catalog revision".into()))
}

pub(super) fn backfill_catalog_revision_high_water(
    database: &Connection,
) -> Result<(), StoreError> {
    let stored = {
        let mut statement = database.prepare(
            "SELECT se.conversation_id, se.payload
             FROM session_events se
             JOIN conversations c ON c.id = se.conversation_id
             WHERE se.kind = 'composer_catalog' AND c.composer_catalog_revision = 0",
        )?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut high_water = BTreeMap::<String, u64>::new();
    for (conversation_id, payload) in stored {
        let Ok(snapshot) = serde_json::from_str::<ComposerCatalogSnapshot>(&payload) else {
            continue;
        };
        if snapshot.conversation_id != conversation_id {
            continue;
        }
        high_water
            .entry(conversation_id)
            .and_modify(|revision| *revision = (*revision).max(snapshot.revision))
            .or_insert(snapshot.revision);
    }
    for (conversation_id, revision) in high_water {
        let revision = i64::try_from(revision).map_err(|_| {
            StoreError::InvalidStoredValue("composer catalog revision exceeds SQLite range".into())
        })?;
        database.execute(
            "UPDATE conversations SET composer_catalog_revision = ?2 WHERE id = ?1",
            params![conversation_id, revision],
        )?;
    }
    Ok(())
}

pub(super) fn backfill_catalog_snapshots(database: &Connection) -> Result<(), StoreError> {
    let stored = {
        let mut statement = database.prepare(
            "SELECT conversation_id, payload, created_at
             FROM session_events WHERE kind = 'composer_catalog'
             ORDER BY conversation_id, seq",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (conversation_id, payload, created_at) in stored {
        let Ok(snapshot) = serde_json::from_str::<ComposerCatalogSnapshot>(&payload) else {
            continue;
        };
        if snapshot.conversation_id != conversation_id || snapshot.revision == 0 {
            continue;
        }
        let revision = i64::try_from(snapshot.revision).map_err(|_| {
            StoreError::InvalidStoredValue("composer catalog revision exceeds SQLite range".into())
        })?;
        let existing = database
            .query_row(
                "SELECT payload FROM composer_catalog_snapshots
                 WHERE conversation_id = ?1 AND revision = ?2",
                params![conversation_id, revision],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            if serde_json::from_str::<ComposerCatalogSnapshot>(&existing)? != snapshot {
                return Err(StoreError::InvalidStoredValue(
                    "composer catalog revision maps to multiple snapshots".into(),
                ));
            }
            continue;
        }
        database.execute(
            "INSERT INTO composer_catalog_snapshots
             (conversation_id, revision, payload, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![conversation_id, revision, payload, created_at],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn catalog_replacement_committing_before_typed_critical_section_wins() {
        let temp = TempDir::new().expect("tempdir");
        let store =
            Arc::new(AgentStore::open(temp.path().join("kubecode.sqlite3")).expect("agent store"));
        let conversation = store
            .create_conversation("project", AgentId::Codex, None)
            .expect("conversation");
        store
            .append_runtime_update(
                &conversation.id,
                "available_commands",
                &json!({"availableCommands":[{
                    "name":"status", "description":"Status"
                }]}),
                None,
            )
            .expect("initial catalog");
        let initial = store
            .composer_catalog_snapshot(&conversation.id)
            .expect("initial snapshot");
        let item_id = initial.items[0].id.clone();
        let gate = Arc::new(Barrier::new(2));

        let mut database = store.database.lock().expect("agent database mutex");
        let transaction = database
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("replacement transaction");
        let replacement = json!({"availableCommands":[]});
        append_session_event_transaction(
            &transaction,
            &conversation.id,
            "available_commands",
            &replacement,
        )
        .expect("raw replacement");
        let revision = next_catalog_revision_transaction(&transaction, &conversation.id)
            .expect("replacement revision");
        let candidate = crate::composer_catalog::project_acp_catalog(
            "project",
            &conversation.id,
            AgentId::Codex,
            revision,
            &replacement,
        );
        append_session_event_transaction(
            &transaction,
            &conversation.id,
            "composer_catalog",
            &serde_json::to_value(&candidate).expect("catalog JSON"),
        )
        .expect("safe replacement");

        let request_store = Arc::clone(&store);
        let request_conversation = conversation.id.clone();
        let request_gate = Arc::clone(&gate);
        let request = std::thread::spawn(move || {
            request_gate.wait();
            request_store.start_typed_composer_command(
                &request_conversation,
                "project",
                &item_id,
                initial.revision,
                "",
                PermissionMode::Safe,
            )
        });
        gate.wait();
        transaction.commit().expect("commit replacement");
        drop(database);

        let error = request
            .join()
            .expect("typed request thread")
            .expect_err("stale request");
        assert!(matches!(
            error,
            StoreError::Composer(ComposerCatalogError::StaleRevision)
        ));
        assert!(store.list_runs(&conversation.id).expect("runs").is_empty());
    }
}
