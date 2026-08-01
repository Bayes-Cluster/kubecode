use std::str::FromStr;

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use uuid::Uuid;

use super::AgentStore;
use super::models::{
    AgentId, Conversation, ConversationRelation, ConversationRelationship, ExecutionMode,
    RunStatus, SessionEvent, StoreError, to_sql_conversion_error,
};

impl AgentStore {
    pub fn create_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        title: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            agent_session_id: String::new(),
            project_id: project_id.to_owned(),
            agent_id,
            provider_session_id: None,
            title: normalized_title(title).unwrap_or_default(),
            manual_title: normalized_title(title),
            agent_title: None,
            created_at: String::new(),
            updated_at: String::new(),
            archived: false,
            parent_conversation_id: None,
            relationship: None,
            read_only: false,
            latest_run_status: None,
            execution_mode: ExecutionMode::Shared,
            workspace_path: None,
            recreated_context: false,
            context_prefix: None,
        };
        let conversation = Conversation {
            agent_session_id: conversation.id.clone(),
            ..conversation
        };
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO conversations
                 (id, agent_session_id, project_id, agent_id, title, manual_title)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conversation.id,
                    conversation.agent_session_id,
                    conversation.project_id,
                    conversation.agent_id.as_str(),
                    conversation.title,
                    conversation.manual_title,
                ],
            )?;
        self.append_workspace_event(
            "session_created",
            Some(project_id),
            Some(&conversation.id),
            None,
            &json!({"agent_id": agent_id, "title": conversation.title}),
        )?;
        self.get_conversation(&conversation.id)
    }

    pub fn create_imported_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        provider_session_id: &str,
        agent_title: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        self.create_related_imported_conversation(
            project_id,
            agent_id,
            provider_session_id,
            agent_title,
            None,
        )
    }

    pub fn create_related_imported_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        provider_session_id: &str,
        agent_title: Option<&str>,
        relation: Option<ConversationRelation>,
    ) -> Result<Conversation, StoreError> {
        let provider_session_id = provider_session_id.trim();
        if provider_session_id.is_empty() {
            return Err(StoreError::InvalidStoredValue(
                "empty provider session id".into(),
            ));
        }
        if let Some(existing) =
            self.find_provider_conversation(project_id, agent_id, provider_session_id)?
        {
            return Ok(existing);
        }
        let agent_title = normalized_title(agent_title);
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            agent_session_id: String::new(),
            project_id: project_id.to_owned(),
            agent_id,
            provider_session_id: Some(provider_session_id.to_owned()),
            title: agent_title.clone().unwrap_or_default(),
            manual_title: None,
            agent_title,
            created_at: String::new(),
            updated_at: String::new(),
            archived: false,
            parent_conversation_id: relation
                .as_ref()
                .map(|value| value.parent_conversation_id.clone()),
            relationship: relation.as_ref().map(|value| value.relationship),
            read_only: relation.is_some_and(|value| value.read_only),
            latest_run_status: None,
            execution_mode: ExecutionMode::Shared,
            workspace_path: None,
            recreated_context: false,
            context_prefix: None,
        };
        let conversation = Conversation {
            agent_session_id: conversation.id.clone(),
            ..conversation
        };
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO conversations
                 (id, agent_session_id, project_id, agent_id, provider_session_id, title, agent_title,
                  parent_conversation_id, relationship, read_only)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    conversation.id,
                    conversation.agent_session_id,
                    conversation.project_id,
                    conversation.agent_id.as_str(),
                    conversation.provider_session_id,
                    conversation.title,
                    conversation.agent_title,
                    conversation.parent_conversation_id,
                    conversation.relationship.map(|value| value.as_str()),
                    conversation.read_only,
                ],
            )?;
        self.append_workspace_event(
            "session_imported",
            Some(project_id),
            Some(&conversation.id),
            None,
            &json!({"agent_id": agent_id, "provider_session_id": provider_session_id}),
        )?;
        self.get_conversation(&conversation.id)
    }

    pub fn get_conversation(&self, conversation_id: &str) -> Result<Conversation, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                &conversation_query("WHERE c.id = ?1"),
                [conversation_id],
                conversation_from_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::ConversationNotFound(conversation_id.to_owned()))
    }

    pub fn list_conversations(&self, project_id: &str) -> Result<Vec<Conversation>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(&conversation_query(
            "WHERE c.project_id = ?1 AND c.internal_revision = 0
             ORDER BY c.created_at, c.id",
        ))?;
        let rows = statement.query_map([project_id], conversation_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_all_conversations(&self) -> Result<Vec<Conversation>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(&conversation_query(
            "WHERE c.internal_revision = 0 ORDER BY c.updated_at DESC, c.id",
        ))?;
        let rows = statement.query_map([], conversation_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn set_archived(
        &self,
        conversation_id: &str,
        archived: bool,
    ) -> Result<Conversation, StoreError> {
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "UPDATE conversations SET archived = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![conversation_id, archived],
            )?;
        if changed == 0 {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let conversation = self.get_conversation(conversation_id)?;
        self.append_workspace_event(
            "session_updated",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({"archived": archived}),
        )?;
        Ok(conversation)
    }

    pub fn assign_execution_workspace(
        &self,
        conversation_id: &str,
        execution_mode: ExecutionMode,
        workspace_path: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        if execution_mode == ExecutionMode::Worktree && workspace_path.is_none() {
            return Err(StoreError::InvalidStoredValue(
                "worktree execution requires a workspace path".into(),
            ));
        }
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "UPDATE conversations
                 SET execution_mode = ?2, workspace_path = ?3, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![conversation_id, execution_mode.as_str(), workspace_path],
            )?;
        if changed == 0 {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let conversation = self.get_conversation(conversation_id)?;
        self.append_workspace_event(
            "session_updated",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({
                "execution_mode": execution_mode,
                "workspace_path": workspace_path,
            }),
        )?;
        Ok(conversation)
    }

    pub fn branch_conversation_at_run(
        &self,
        source_conversation_id: &str,
        run_id: &str,
    ) -> Result<Conversation, StoreError> {
        let source = self.get_conversation(source_conversation_id)?;
        let run = self.get_run(run_id)?;
        if run.conversation_id != source.id {
            return Err(StoreError::RunNotFound(run_id.to_owned()));
        }
        let source_events = self.session_events_after(source_conversation_id, 0)?;
        let retained_events = source_events
            .into_iter()
            .take_while(|event| event.payload.get("run_id").and_then(Value::as_str) != Some(run_id))
            .collect::<Vec<_>>();
        let context_prefix = transcript_context(&retained_events);
        let conversation = Conversation {
            id: Uuid::new_v4().to_string(),
            agent_session_id: source.agent_session_id,
            project_id: source.project_id.clone(),
            agent_id: source.agent_id,
            provider_session_id: None,
            title: source.title.clone(),
            manual_title: None,
            agent_title: normalized_title(Some(&source.title)),
            created_at: String::new(),
            updated_at: String::new(),
            archived: false,
            parent_conversation_id: Some(source.id.clone()),
            relationship: Some(ConversationRelationship::Branch),
            read_only: false,
            latest_run_status: None,
            execution_mode: source.execution_mode,
            workspace_path: source.workspace_path,
            recreated_context: true,
            context_prefix: (!context_prefix.is_empty()).then_some(context_prefix),
        };
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO conversations
             (id, agent_session_id, project_id, agent_id, title, agent_title,
              parent_conversation_id, relationship, read_only, execution_mode,
              workspace_path, recreated_context, context_prefix)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                conversation.id,
                conversation.agent_session_id,
                conversation.project_id,
                conversation.agent_id.as_str(),
                conversation.title,
                conversation.agent_title,
                conversation.parent_conversation_id,
                conversation.relationship.map(|value| value.as_str()),
                conversation.read_only,
                conversation.execution_mode.as_str(),
                conversation.workspace_path,
                conversation.recreated_context,
                conversation.context_prefix,
            ],
        )?;
        for (index, event) in retained_events
            .iter()
            .filter(|event| event.kind != "composer_catalog")
            .enumerate()
        {
            transaction.execute(
                "INSERT INTO session_events
                 (conversation_id, seq, kind, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    conversation.id,
                    i64::try_from(index + 1)
                        .map_err(|error| { StoreError::InvalidStoredValue(error.to_string()) })?,
                    event.kind,
                    serde_json::to_string(&event.payload)?,
                    event.created_at,
                ],
            )?;
        }
        transaction.commit()?;
        drop(database);
        self.append_workspace_event(
            "session_created",
            Some(&source.project_id),
            Some(&conversation.id),
            None,
            &json!({
                "agent_id": source.agent_id,
                "parent_conversation_id": source.id,
                "relationship": "branch",
                "recreated_context": true,
            }),
        )?;
        self.get_conversation(&conversation.id)
    }

    pub fn create_team_member(
        &self,
        parent_conversation_id: &str,
        agent_id: AgentId,
        isolated: bool,
    ) -> Result<Conversation, StoreError> {
        let parent = self.get_conversation(parent_conversation_id)?;
        let id = Uuid::new_v4().to_string();
        let conversation = Conversation {
            agent_session_id: if isolated {
                id.clone()
            } else {
                parent.agent_session_id
            },
            id,
            project_id: parent.project_id.clone(),
            agent_id,
            provider_session_id: None,
            title: String::new(),
            manual_title: None,
            agent_title: None,
            created_at: String::new(),
            updated_at: String::new(),
            archived: false,
            parent_conversation_id: Some(parent.id.clone()),
            relationship: Some(ConversationRelationship::TeamMember),
            read_only: false,
            latest_run_status: None,
            execution_mode: if isolated {
                ExecutionMode::Shared
            } else {
                parent.execution_mode
            },
            workspace_path: if isolated {
                None
            } else {
                parent.workspace_path
            },
            recreated_context: false,
            context_prefix: None,
        };
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "INSERT INTO conversations
                 (id, agent_session_id, project_id, agent_id, title,
                  parent_conversation_id, relationship, read_only, execution_mode,
                  workspace_path, recreated_context)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    conversation.id,
                    conversation.agent_session_id,
                    conversation.project_id,
                    conversation.agent_id.as_str(),
                    conversation.title,
                    conversation.parent_conversation_id,
                    conversation.relationship.map(|value| value.as_str()),
                    conversation.read_only,
                    conversation.execution_mode.as_str(),
                    conversation.workspace_path,
                    conversation.recreated_context,
                ],
            )?;
        self.append_workspace_event(
            "session_created",
            Some(&parent.project_id),
            Some(&conversation.id),
            None,
            &json!({
                "agent_id": agent_id,
                "parent_conversation_id": parent.id,
                "relationship": "team_member",
                "isolated": isolated,
            }),
        )?;
        self.get_conversation(&conversation.id)
    }

    pub fn set_manual_title(
        &self,
        conversation_id: &str,
        title: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        self.set_conversation_title(conversation_id, "manual_title", normalized_title(title))
    }

    pub fn set_agent_title(
        &self,
        conversation_id: &str,
        title: Option<&str>,
    ) -> Result<Conversation, StoreError> {
        self.set_conversation_title(conversation_id, "agent_title", normalized_title(title))
    }

    pub fn set_agent_title_if_untitled(
        &self,
        conversation_id: &str,
        source: &str,
    ) -> Result<Option<Conversation>, StoreError> {
        let Some(title) = fallback_conversation_title(source) else {
            return Ok(None);
        };
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "UPDATE conversations SET agent_title = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND manual_title IS NULL AND agent_title IS NULL",
                params![conversation_id, title],
            )?;
        if changed == 0 {
            self.get_conversation(conversation_id)?;
            return Ok(None);
        }
        let conversation = self.get_conversation(conversation_id)?;
        self.append_workspace_event(
            "session_updated",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({"title":conversation.title}),
        )?;
        Ok(Some(conversation))
    }

    pub fn delete_conversation(&self, conversation_id: &str) -> Result<(), StoreError> {
        self.delete_conversation_with_scope(conversation_id, "local")
    }

    pub fn delete_provider_conversation(&self, conversation_id: &str) -> Result<(), StoreError> {
        self.delete_conversation_with_scope(conversation_id, "provider")
    }

    fn delete_conversation_with_scope(
        &self,
        conversation_id: &str,
        scope: &str,
    ) -> Result<(), StoreError> {
        let conversation = self.get_conversation(conversation_id)?;
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let snapshot_ids = {
            let mut statement = transaction.prepare(
                "SELECT snapshot_conversation_id FROM conversation_revisions
                 WHERE conversation_id = ?1",
            )?;
            statement
                .query_map([conversation_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for snapshot_id in snapshot_ids {
            transaction.execute("DELETE FROM conversations WHERE id = ?1", [snapshot_id])?;
        }
        transaction.execute("DELETE FROM conversations WHERE id = ?1", [conversation_id])?;
        transaction.commit()?;
        drop(database);
        self.append_workspace_event(
            "session_removed",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({"scope":scope}),
        )?;
        Ok(())
    }

    fn find_provider_conversation(
        &self,
        project_id: &str,
        agent_id: AgentId,
        provider_session_id: &str,
    ) -> Result<Option<Conversation>, StoreError> {
        self.database
            .lock()
            .expect("agent database mutex poisoned")
            .query_row(
                &conversation_query(
                    "WHERE c.project_id = ?1 AND c.agent_id = ?2 AND c.provider_session_id = ?3
                     AND c.internal_revision = 0",
                ),
                params![project_id, agent_id.as_str(), provider_session_id],
                conversation_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    fn set_conversation_title(
        &self,
        conversation_id: &str,
        column: &str,
        title: Option<String>,
    ) -> Result<Conversation, StoreError> {
        let query = match column {
            "manual_title" => {
                "UPDATE conversations SET manual_title = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1"
            }
            "agent_title" => {
                "UPDATE conversations SET agent_title = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1"
            }
            _ => return Err(StoreError::InvalidStoredValue(column.to_owned())),
        };
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(query, params![conversation_id, title])?;
        if changed == 0 {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        let conversation = self.get_conversation(conversation_id)?;
        self.append_workspace_event(
            "session_updated",
            Some(&conversation.project_id),
            Some(conversation_id),
            None,
            &json!({"title":conversation.title}),
        )?;
        Ok(conversation)
    }

    pub fn set_provider_session(
        &self,
        conversation_id: &str,
        provider_session_id: &str,
    ) -> Result<(), StoreError> {
        let changed = self
            .database
            .lock()
            .expect("agent database mutex poisoned")
            .execute(
                "UPDATE conversations SET provider_session_id = ?2,
                 updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![conversation_id, provider_session_id],
            )?;
        if changed == 0 {
            return Err(StoreError::ConversationNotFound(conversation_id.to_owned()));
        }
        Ok(())
    }
}

fn conversation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    let agent_id = row.get::<_, String>(2)?;
    let relationship = row
        .get::<_, Option<String>>(11)?
        .map(|value| ConversationRelationship::from_str(&value))
        .transpose()
        .map_err(to_sql_conversion_error)?;
    let latest_run_status = row
        .get::<_, Option<String>>(13)?
        .map(|value| RunStatus::from_str(&value))
        .transpose()
        .map_err(to_sql_conversion_error)?;
    let execution_mode =
        ExecutionMode::from_str(&row.get::<_, String>(15)?).map_err(to_sql_conversion_error)?;
    Ok(Conversation {
        id: row.get(0)?,
        agent_session_id: row.get(14)?,
        project_id: row.get(1)?,
        agent_id: AgentId::from_str(&agent_id).map_err(to_sql_conversion_error)?,
        provider_session_id: row.get(3)?,
        title: row.get(4)?,
        manual_title: row.get(5)?,
        agent_title: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        archived: row.get(9)?,
        parent_conversation_id: row.get(10)?,
        relationship,
        read_only: row.get(12)?,
        latest_run_status,
        execution_mode,
        workspace_path: row.get(16)?,
        recreated_context: row.get(17)?,
        context_prefix: row.get(18)?,
    })
}

fn conversation_query(suffix: &str) -> String {
    format!(
        "SELECT c.id, c.project_id, c.agent_id, c.provider_session_id,
                COALESCE(c.manual_title, c.agent_title, ''), c.manual_title, c.agent_title,
                c.created_at, c.updated_at, c.archived, c.parent_conversation_id,
                c.relationship, c.read_only,
                (SELECT r.status FROM agent_runs r WHERE r.conversation_id = c.id
                 ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1),
                COALESCE(c.agent_session_id, c.id), c.execution_mode, c.workspace_path,
                c.recreated_context, c.context_prefix
         FROM conversations c {suffix}"
    )
}

fn normalized_title(title: Option<&str>) -> Option<String> {
    title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn fallback_conversation_title(source: &str) -> Option<String> {
    const MAX_WORDS: usize = 4;
    const MAX_CHARS: usize = 48;
    const STOP_WORDS: &[&str] = &[
        "a", "an", "can", "could", "for", "help", "me", "please", "the", "to", "would", "you",
    ];

    let line = source.lines().find(|line| !line.trim().is_empty())?.trim();
    if line.starts_with('/') {
        return None;
    }
    let words = line
        .split_whitespace()
        .map(|word| word.trim_matches(|character: char| !character.is_alphanumeric()))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let meaningful = words
        .iter()
        .copied()
        .filter(|word| !STOP_WORDS.contains(&word.to_ascii_lowercase().as_str()))
        .collect::<Vec<_>>();
    let selected = if meaningful.is_empty() {
        &words
    } else {
        &meaningful
    };
    let mut title = selected
        .iter()
        .take(MAX_WORDS)
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_CHARS)
        .collect::<String>();
    let first = title.chars().next()?;
    if first.is_lowercase() {
        title.replace_range(0..first.len_utf8(), &first.to_uppercase().to_string());
    }
    Some(title)
}

pub(super) fn transcript_context(events: &[SessionEvent]) -> String {
    let mut transcript = String::from(
        "The following is immutable context recreated from an earlier Kubecode chat branch:\n",
    );
    let mut assistant_open = false;
    for event in events {
        match event.kind.as_str() {
            "user_message" => {
                if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                    transcript.push_str("\nUser: ");
                    transcript.push_str(text);
                    assistant_open = false;
                }
            }
            "text_delta" => {
                if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                    if !assistant_open {
                        transcript.push_str("\nAssistant: ");
                        assistant_open = true;
                    }
                    transcript.push_str(text);
                }
            }
            _ => {}
        }
    }
    transcript.trim().to_owned()
}
