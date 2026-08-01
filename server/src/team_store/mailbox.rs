use rusqlite::{OptionalExtension, TransactionBehavior, params};
use uuid::Uuid;

use super::TeamStore;
use super::members::require_team_member;
use super::models::{
    TeamError, TeamMessage, TeamMessageDeliveryStatus, TeamMessageKind, sql_value_error,
};

impl TeamStore {
    pub fn send_message(
        &self,
        team_id: &str,
        from_member_id: &str,
        to_member_id: &str,
        kind: TeamMessageKind,
        task_id: Option<&str>,
        body: &str,
    ) -> Result<TeamMessage, TeamError> {
        let message_id = Uuid::new_v4().to_string();
        let database = self.database.lock().expect("team database mutex poisoned");
        require_team_member(&database, team_id, from_member_id)?;
        require_team_member(&database, team_id, to_member_id)?;
        if let Some(task_id) = task_id {
            let task_team = database
                .query_row(
                    "SELECT team_id FROM team_tasks WHERE id = ?1",
                    [task_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or_else(|| TeamError::TaskNotFound(task_id.to_owned()))?;
            if task_team != team_id {
                return Err(TeamError::WrongTeam);
            }
        }
        database.execute(
            "INSERT INTO team_messages
             (id, team_id, from_member_id, to_member_id, kind, task_id, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                message_id,
                team_id,
                from_member_id,
                to_member_id,
                kind.as_str(),
                task_id,
                body.trim(),
            ],
        )?;
        database
            .query_row(
                "SELECT id, team_id, from_member_id, to_member_id, kind, task_id,
                        body, read_at, delivery_status, delivery_attempts, delivered_at,
                        last_error, created_at
                 FROM team_messages WHERE id = ?1",
                [message_id],
                team_message_from_row,
            )
            .map_err(TeamError::from)
    }

    pub fn unread_messages(&self, member_id: &str) -> Result<Vec<TeamMessage>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, from_member_id, to_member_id, kind, task_id,
                    body, read_at, delivery_status, delivery_attempts, delivered_at,
                    last_error, created_at
             FROM team_messages
             WHERE to_member_id = ?1 AND read_at IS NULL
             ORDER BY created_at, id",
        )?;
        statement
            .query_map([member_id], team_message_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn read_messages(&self, member_id: &str) -> Result<Vec<TeamMessage>, TeamError> {
        let mut database = self.database.lock().expect("team database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let messages = {
            let mut statement = transaction.prepare(
                "SELECT id, team_id, from_member_id, to_member_id, kind, task_id,
                        body, read_at, delivery_status, delivery_attempts, delivered_at,
                        last_error, created_at
                 FROM team_messages
                 WHERE to_member_id = ?1 AND read_at IS NULL
                 ORDER BY created_at, id",
            )?;
            statement
                .query_map([member_id], team_message_from_row)?
                .collect::<Result<Vec<_>, _>>()?
        };
        transaction.execute(
            "UPDATE team_messages SET read_at = CURRENT_TIMESTAMP,
             delivery_status = 'acknowledged'
             WHERE to_member_id = ?1 AND read_at IS NULL",
            [member_id],
        )?;
        transaction.commit()?;
        Ok(messages)
    }

    pub fn pending_messages(&self, member_id: &str) -> Result<Vec<TeamMessage>, TeamError> {
        let database = self.database.lock().expect("team database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT id, team_id, from_member_id, to_member_id, kind, task_id,
                    body, read_at, delivery_status, delivery_attempts, delivered_at,
                    last_error, created_at
             FROM team_messages
             WHERE to_member_id = ?1 AND delivery_status IN ('pending', 'failed')
                   AND delivery_attempts < 3
             ORDER BY created_at, id",
        )?;
        statement
            .query_map([member_id], team_message_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(TeamError::from)
    }

    pub fn requeue_expired_deliveries(&self, lease_seconds: u64) -> Result<usize, TeamError> {
        let modifier = format!("-{} seconds", lease_seconds.min(i64::MAX as u64));
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_messages
                 SET delivery_status = 'pending', delivered_at = NULL,
                     last_error = 'delivery acknowledgement lease expired'
                 WHERE delivery_status = 'delivered'
                   AND read_at IS NULL
                   AND delivery_attempts < 3
                   AND delivered_at <= datetime('now', ?1)",
                [modifier],
            )
            .map_err(TeamError::from)
    }

    pub fn mark_message_delivered(&self, message_id: &str) -> Result<(), TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_messages
                 SET delivery_status = 'delivered', delivered_at = CURRENT_TIMESTAMP,
                     delivery_attempts = delivery_attempts + 1, last_error = NULL
                 WHERE id = ?1 AND delivery_status IN ('pending', 'failed')",
                [message_id],
            )?;
        Ok(())
    }

    pub fn mark_message_failed(&self, message_id: &str, error: &str) -> Result<(), TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_messages
                 SET delivery_status = 'failed', delivery_attempts = delivery_attempts + 1,
                     last_error = ?2
                 WHERE id = ?1 AND delivery_status NOT IN ('acknowledged', 'cancelled')",
                params![message_id, error],
            )?;
        Ok(())
    }

    pub fn mark_messages_read(&self, member_id: &str) -> Result<usize, TeamError> {
        self.database
            .lock()
            .expect("team database mutex poisoned")
            .execute(
                "UPDATE team_messages SET read_at = CURRENT_TIMESTAMP,
                 delivery_status = 'acknowledged'
                 WHERE to_member_id = ?1 AND read_at IS NULL
                   AND delivery_status != 'cancelled'",
                [member_id],
            )
            .map_err(TeamError::from)
    }
}

fn team_message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TeamMessage> {
    Ok(TeamMessage {
        id: row.get(0)?,
        team_id: row.get(1)?,
        from_member_id: row.get(2)?,
        to_member_id: row.get(3)?,
        kind: TeamMessageKind::parse(&row.get::<_, String>(4)?).map_err(sql_value_error)?,
        task_id: row.get(5)?,
        body: row.get(6)?,
        read_at: row.get(7)?,
        delivery_status: TeamMessageDeliveryStatus::parse(&row.get::<_, String>(8)?)
            .map_err(sql_value_error)?,
        delivery_attempts: row.get(9)?,
        delivered_at: row.get(10)?,
        last_error: row.get(11)?,
        created_at: row.get(12)?,
    })
}
