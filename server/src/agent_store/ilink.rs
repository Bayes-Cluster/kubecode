//! Durable iLink channel state (issue #126, ADR 0211 §2/§3/§6/§7/§13).
//!
//! One linked WeChat account per instance, keyed by a stable `account_id`
//! so a future multi-account ADR needs no migration. All secret material —
//! the bot token, session cookies, and per-peer context tokens — is stored
//! only in AES-256-GCM sealed blobs (see [`crate::ilink::seal`]); no
//! plaintext credential column exists, and no public projection or
//! workspace event carries secrets, message bodies, filenames, or paths.
//!
//! Crash-boundary contract (§6): an inbound message is admitted first
//! (run admission is idempotent via the message-key-derived
//! `client_message_id`), then [`AgentStore::commit_ilink_inbound_message`]
//! inserts the dedupe key and advances the sync cursor in one
//! transaction. A replay therefore lands either on the dedupe key or on
//! run/queue idempotence — delivered exactly once, never skipped.

use std::str::FromStr;

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use super::AgentStore;
use super::events::append_workspace_event_transaction;
use super::models::{IlinkAccountStatus, StoreError};

/// Bounded dedupe retention. Cursor replay safety rests on the committed
/// `get_updates_buf`, not on dedupe rows, so old rows can be pruned.
pub const ILINK_DEDUPE_KEEP: usize = 1024;
/// Bounded quick-prompt slots (1..=9, matching the numbered keyboard).
pub const ILINK_QUICK_PROMPT_SLOTS: u8 = 9;

/// Safe account projection: identifiers and status only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IlinkAccount {
    pub account_id: String,
    pub display_name: String,
    pub status: IlinkAccountStatus,
}

/// Credential metadata plus the sealed credential blob. `sealed_blob` is
/// ciphertext (AES-256-GCM over the credential JSON) — never plaintext.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IlinkCredentialRecord {
    pub account_id: String,
    pub device_id: String,
    pub committed_cursor: i64,
    pub get_updates_buf: String,
    pub api_origin: String,
    pub cdn_origin: String,
    pub sealed_blob: Vec<u8>,
}

/// Safe peer projection. The context token stays sealed at rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IlinkPeer {
    pub peer_id: String,
    pub display_name: String,
    pub authorized: bool,
}

impl AgentStore {
    // -- Accounts ----------------------------------------------------------

    /// Registers (or refreshes the display name of) the linked account.
    pub fn upsert_ilink_account(
        &self,
        account_id: &str,
        display_name: &str,
    ) -> Result<IlinkAccount, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database.execute(
            "INSERT INTO ilink_accounts (account_id, display_name)
             VALUES (?1, ?2)
             ON CONFLICT(account_id) DO UPDATE SET
               display_name = CASE WHEN ?2 <> '' THEN ?2 ELSE ilink_accounts.display_name END,
               updated_at = CURRENT_TIMESTAMP",
            params![account_id, display_name],
        )?;
        drop(database);
        self.ilink_account(account_id)?
            .ok_or_else(|| StoreError::IlinkStateRejected("account row vanished".to_owned()))
    }

    pub fn ilink_account(&self, account_id: &str) -> Result<Option<IlinkAccount>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let row = database
            .query_row(
                "SELECT account_id, display_name, status FROM ilink_accounts WHERE account_id = ?1",
                [account_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(StoreError::from)?;
        let Some((account_id, display_name, status)) = row else {
            return Ok(None);
        };
        Ok(Some(IlinkAccount {
            account_id,
            display_name,
            status: IlinkAccountStatus::from_str(&status)?,
        }))
    }

    /// Transitions the account status and broadcasts the safe status event
    /// (state + display name + binding; never credentials or content).
    pub fn set_ilink_account_status(
        &self,
        account_id: &str,
        status: IlinkAccountStatus,
    ) -> Result<(), StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE ilink_accounts SET status = ?2, updated_at = CURRENT_TIMESTAMP
             WHERE account_id = ?1",
            params![account_id, status.as_str()],
        )?;
        if changed == 0 {
            return Err(StoreError::IlinkStateRejected(format!(
                "unknown account {account_id}"
            )));
        }
        publish_ilink_status_transaction(&transaction, account_id)?;
        let cursor = u64::try_from(transaction.last_insert_rowid())
            .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))?;
        transaction.commit()?;
        drop(database);
        self.workspace_event_bus.publish_committed(cursor);
        Ok(())
    }

    // -- Credentials -------------------------------------------------------

    /// Persists credential metadata and the sealed credential blob.
    /// Reconnection after restart reads exactly this row.
    pub fn save_ilink_credentials(&self, record: &IlinkCredentialRecord) -> Result<(), StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database.execute(
            "INSERT INTO ilink_credentials
               (account_id, device_id, committed_cursor, get_updates_buf,
                api_origin, cdn_origin, sealed_blob)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(account_id) DO UPDATE SET
               device_id = ?2,
               committed_cursor = ?3,
               get_updates_buf = ?4,
               api_origin = ?5,
               cdn_origin = ?6,
               sealed_blob = ?7,
               updated_at = CURRENT_TIMESTAMP",
            params![
                record.account_id,
                record.device_id,
                record.committed_cursor,
                record.get_updates_buf,
                record.api_origin,
                record.cdn_origin,
                record.sealed_blob,
            ],
        )?;
        Ok(())
    }

    /// The single stored credentials row, if any (one linked account
    /// per instance, ADR 0211 §2).
    pub fn first_ilink_credentials(&self) -> Option<IlinkCredentialRecord> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                "SELECT account_id, device_id, committed_cursor, get_updates_buf,
                        api_origin, cdn_origin, sealed_blob
                 FROM ilink_credentials LIMIT 1",
                [],
                |row| {
                    Ok(IlinkCredentialRecord {
                        account_id: row.get(0)?,
                        device_id: row.get(1)?,
                        committed_cursor: row.get(2)?,
                        get_updates_buf: row.get(3)?,
                        api_origin: row.get(4)?,
                        cdn_origin: row.get(5)?,
                        sealed_blob: row.get(6)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn ilink_credentials(
        &self,
        account_id: &str,
    ) -> Result<Option<IlinkCredentialRecord>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                "SELECT account_id, device_id, committed_cursor, get_updates_buf,
                        api_origin, cdn_origin, sealed_blob
                 FROM ilink_credentials WHERE account_id = ?1",
                [account_id],
                |row| {
                    Ok(IlinkCredentialRecord {
                        account_id: row.get(0)?,
                        device_id: row.get(1)?,
                        committed_cursor: row.get(2)?,
                        get_updates_buf: row.get(3)?,
                        api_origin: row.get(4)?,
                        cdn_origin: row.get(5)?,
                        sealed_blob: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Atomically advances the sync cursor after a message is fully
    /// processed (paired with the dedupe insert in
    /// [`AgentStore::commit_ilink_inbound_message`]).
    pub fn advance_ilink_cursor(
        &self,
        account_id: &str,
        get_updates_buf: &str,
        committed_cursor: i64,
    ) -> Result<(), StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let changed = database.execute(
            "UPDATE ilink_credentials
             SET get_updates_buf = ?2, committed_cursor = ?3, updated_at = CURRENT_TIMESTAMP
             WHERE account_id = ?1",
            params![account_id, get_updates_buf, committed_cursor],
        )?;
        if changed == 0 {
            return Err(StoreError::IlinkStateRejected(format!(
                "no credentials stored for account {account_id}"
            )));
        }
        Ok(())
    }

    /// Removes the credential row only (logout deletes the secret file and
    /// channel state around it; ordinary shutdown never calls this).
    pub fn clear_ilink_credentials(&self, account_id: &str) -> Result<(), StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database.execute(
            "DELETE FROM ilink_credentials WHERE account_id = ?1",
            [account_id],
        )?;
        Ok(())
    }

    // -- Peers ---------------------------------------------------------------

    /// Registers a peer. The first peer to message the linked account is
    /// authorized automatically (ADR 0211 §7); later peers start
    /// unauthorized and need explicit Settings approval.
    pub fn upsert_ilink_peer(
        &self,
        account_id: &str,
        peer_id: &str,
        display_name: &str,
        authorized: bool,
    ) -> Result<IlinkPeer, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database.execute(
            "INSERT INTO ilink_peers (account_id, peer_id, display_name, authorized)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_id, peer_id) DO UPDATE SET
               display_name = CASE WHEN ?3 <> '' THEN ?3 ELSE ilink_peers.display_name END,
               authorized = MAX(ilink_peers.authorized, ?4),
               updated_at = CURRENT_TIMESTAMP",
            params![account_id, peer_id, display_name, authorized],
        )?;
        drop(database);
        self.ilink_peer(account_id, peer_id)?
            .ok_or_else(|| StoreError::IlinkStateRejected("peer row vanished".to_owned()))
    }

    pub fn ilink_peer(
        &self,
        account_id: &str,
        peer_id: &str,
    ) -> Result<Option<IlinkPeer>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                "SELECT peer_id, display_name, authorized FROM ilink_peers
                 WHERE account_id = ?1 AND peer_id = ?2",
                params![account_id, peer_id],
                |row| {
                    Ok(IlinkPeer {
                        peer_id: row.get(0)?,
                        display_name: row.get(1)?,
                        authorized: row.get::<_, i64>(2)? != 0,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn ilink_peers(&self, account_id: &str) -> Result<Vec<IlinkPeer>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT peer_id, display_name, authorized FROM ilink_peers
             WHERE account_id = ?1 ORDER BY id",
        )?;
        let rows = statement.query_map([account_id], |row| {
            Ok(IlinkPeer {
                peer_id: row.get(0)?,
                display_name: row.get(1)?,
                authorized: row.get::<_, i64>(2)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn authorize_ilink_peer(
        &self,
        account_id: &str,
        peer_id: &str,
    ) -> Result<IlinkPeer, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let changed = database.execute(
            "UPDATE ilink_peers SET authorized = 1, updated_at = CURRENT_TIMESTAMP
             WHERE account_id = ?1 AND peer_id = ?2",
            params![account_id, peer_id],
        )?;
        if changed == 0 {
            return Err(StoreError::IlinkStateRejected(format!(
                "unknown peer {peer_id}"
            )));
        }
        drop(database);
        let mut peer = self
            .ilink_peer(account_id, peer_id)?
            .ok_or_else(|| StoreError::IlinkStateRejected("peer row vanished".to_owned()))?;
        peer.authorized = true;
        Ok(peer)
    }

    /// Stores a peer context token (sealed by the caller; ADR 0211 §7 —
    /// never shared across peers, never in plaintext).
    pub fn remember_ilink_peer_context_token(
        &self,
        account_id: &str,
        peer_id: &str,
        sealed_context_token: &[u8],
    ) -> Result<(), StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let changed = database.execute(
            "UPDATE ilink_peers SET sealed_context_token = ?3, updated_at = CURRENT_TIMESTAMP
             WHERE account_id = ?1 AND peer_id = ?2",
            params![account_id, peer_id, sealed_context_token],
        )?;
        if changed == 0 {
            return Err(StoreError::IlinkStateRejected(format!(
                "unknown peer {peer_id}"
            )));
        }
        Ok(())
    }

    pub fn ilink_peer_context_token(
        &self,
        account_id: &str,
        peer_id: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                "SELECT sealed_context_token FROM ilink_peers
                 WHERE account_id = ?1 AND peer_id = ?2",
                params![account_id, peer_id],
                |row| row.get::<_, Option<Vec<u8>>>(0),
            )
            .optional()
            .map(|value| value.flatten())
            .map_err(StoreError::from)
    }

    // -- Inbound dedupe and cursor commit ---------------------------------

    /// Point check before processing (ADR 0211 §6 step 1).
    pub fn ilink_message_seen(
        &self,
        account_id: &str,
        message_key: &str,
    ) -> Result<bool, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                "SELECT 1 FROM ilink_inbound_dedupe
                 WHERE account_id = ?1 AND message_key = ?2",
                params![account_id, message_key],
                |_| Ok(()),
            )
            .optional()
            .map(|found: Option<()>| found.is_some())
            .map_err(StoreError::from)
    }

    /// Commits a processed inbound message: dedupe insert and cursor
    /// advance in one transaction. Returns `false` (no-op) when the key is
    /// already committed, so a retried delivery cannot double-apply.
    pub fn commit_ilink_inbound_message(
        &self,
        account_id: &str,
        message_key: &str,
        get_updates_buf: &str,
        cursor_advance: i64,
    ) -> Result<bool, StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO ilink_inbound_dedupe (account_id, message_key)
             VALUES (?1, ?2)",
            params![account_id, message_key],
        )?;
        if inserted == 0 {
            return Ok(false);
        }
        transaction.execute(
            "UPDATE ilink_credentials
             SET get_updates_buf = ?2,
                 committed_cursor = committed_cursor + ?3,
                 updated_at = CURRENT_TIMESTAMP
             WHERE account_id = ?1",
            params![account_id, get_updates_buf, cursor_advance],
        )?;
        // Bound retention while preserving recent replay safety.
        transaction.execute(
            "DELETE FROM ilink_inbound_dedupe
             WHERE account_id = ?1 AND message_key NOT IN (
               SELECT message_key FROM ilink_inbound_dedupe
               WHERE account_id = ?1 ORDER BY seen_at DESC, message_key DESC LIMIT ?2
             )",
            params![account_id, ILINK_DEDUPE_KEEP as i64],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    // -- Session binding ----------------------------------------------------

    /// Binds the account to a writable Session, validating the target in
    /// the same transaction (ADR 0211 §13). Atomic replace semantics make
    /// rebinding safe.
    pub fn bind_ilink_session(
        &self,
        account_id: &str,
        conversation_id: &str,
    ) -> Result<(), StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let writable = transaction
            .query_row(
                "SELECT 1 FROM conversations c
                 WHERE c.id = ?1
                   AND c.archived = 0
                   AND c.read_only = 0
                   AND (c.relationship IS NULL OR c.relationship <> 'subagent')
                   AND c.project_id IN (SELECT id FROM projects)",
                [conversation_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !writable {
            return Err(StoreError::IlinkStateRejected(
                "session binding target must be a writable, registered, non-subagent Session"
                    .to_owned(),
            ));
        }
        transaction.execute(
            "INSERT INTO ilink_session_binding (account_id, conversation_id)
             VALUES (?1, ?2)
             ON CONFLICT(account_id) DO UPDATE SET
               conversation_id = ?2, bound_at = CURRENT_TIMESTAMP",
            params![account_id, conversation_id],
        )?;
        publish_ilink_status_transaction(&transaction, account_id)?;
        let cursor = u64::try_from(transaction.last_insert_rowid())
            .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))?;
        transaction.commit()?;
        drop(database);
        self.workspace_event_bus.publish_committed(cursor);
        Ok(())
    }

    pub fn unbind_ilink_session(&self, account_id: &str) -> Result<(), StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM ilink_session_binding WHERE account_id = ?1",
            [account_id],
        )?;
        publish_ilink_status_transaction(&transaction, account_id)?;
        let cursor = u64::try_from(transaction.last_insert_rowid())
            .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))?;
        transaction.commit()?;
        drop(database);
        self.workspace_event_bus.publish_committed(cursor);
        Ok(())
    }

    /// The bound conversation id, if any.
    pub fn ilink_session_binding(&self, account_id: &str) -> Result<Option<String>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database
            .query_row(
                "SELECT conversation_id FROM ilink_session_binding WHERE account_id = ?1",
                [account_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(StoreError::from)
    }

    // -- Quick prompts -------------------------------------------------------

    /// Stores a bounded quick prompt in slot 1..=[`ILINK_QUICK_PROMPT_SLOTS`].
    pub fn set_ilink_quick_prompt(
        &self,
        account_id: &str,
        slot: u8,
        content: &str,
    ) -> Result<(), StoreError> {
        if slot == 0 || slot > ILINK_QUICK_PROMPT_SLOTS {
            return Err(StoreError::IlinkStateRejected(format!(
                "quick prompt slot must be 1..={ILINK_QUICK_PROMPT_SLOTS}"
            )));
        }
        let database = self.database.lock().expect("agent database mutex poisoned");
        database.execute(
            "INSERT INTO ilink_quick_prompts (account_id, slot, content)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id, slot) DO UPDATE SET
               content = ?3, updated_at = CURRENT_TIMESTAMP",
            params![account_id, slot, content],
        )?;
        Ok(())
    }

    pub fn remove_ilink_quick_prompt(&self, account_id: &str, slot: u8) -> Result<(), StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database.execute(
            "DELETE FROM ilink_quick_prompts WHERE account_id = ?1 AND slot = ?2",
            params![account_id, slot],
        )?;
        Ok(())
    }

    pub fn ilink_quick_prompts(&self, account_id: &str) -> Result<Vec<(u8, String)>, StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        let mut statement = database.prepare(
            "SELECT slot, content FROM ilink_quick_prompts
             WHERE account_id = ?1 ORDER BY slot",
        )?;
        let rows = statement.query_map([account_id], |row| {
            Ok((row.get::<_, i64>(0)? as u8, row.get(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    // -- Logout and startup repair -------------------------------------------

    /// Removes all channel-specific state for the account — credentials,
    /// cursor, peer contexts, dedupe keys, quick prompts, and the Session
    /// binding — while preserving provider-native Session history and
    /// Project files. The secret file is destroyed by the caller.
    pub fn ilink_logout(&self, account_id: &str) -> Result<(), StoreError> {
        let mut database = self.database.lock().expect("agent database mutex poisoned");
        let transaction = database.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM ilink_credentials WHERE account_id = ?1",
            [account_id],
        )?;
        transaction.execute(
            "DELETE FROM ilink_peers WHERE account_id = ?1",
            [account_id],
        )?;
        transaction.execute(
            "DELETE FROM ilink_inbound_dedupe WHERE account_id = ?1",
            [account_id],
        )?;
        transaction.execute(
            "DELETE FROM ilink_quick_prompts WHERE account_id = ?1",
            [account_id],
        )?;
        transaction.execute(
            "DELETE FROM ilink_session_binding WHERE account_id = ?1",
            [account_id],
        )?;
        transaction.execute(
            "UPDATE ilink_accounts SET status = 'disconnected', updated_at = CURRENT_TIMESTAMP
             WHERE account_id = ?1",
            [account_id],
        )?;
        publish_ilink_status_transaction(&transaction, account_id)?;
        let cursor = u64::try_from(transaction.last_insert_rowid())
            .map_err(|_| StoreError::InvalidStoredValue("negative workspace event id".into()))?;
        transaction.commit()?;
        drop(database);
        self.workspace_event_bus.publish_committed(cursor);
        Ok(())
    }

    /// Startup repair: clears bindings whose Session no longer exists.
    /// Idempotent; never touches Project files or provider-native history.
    pub fn repair_ilink_state(&self) -> Result<(), StoreError> {
        let database = self.database.lock().expect("agent database mutex poisoned");
        database.execute(
            "DELETE FROM ilink_session_binding
             WHERE conversation_id NOT IN (SELECT id FROM conversations)",
            [],
        )?;
        Ok(())
    }
}

/// Broadcasts the safe `ilink_status_changed` event inside a transaction:
/// connection status, display name, and binding — never secrets or content.
fn publish_ilink_status_transaction(
    transaction: &rusqlite::Transaction<'_>,
    account_id: &str,
) -> Result<(), StoreError> {
    let payload = transaction
        .query_row(
            "SELECT a.display_name, a.status, b.conversation_id
             FROM ilink_accounts a
             LEFT JOIN ilink_session_binding b ON b.account_id = a.account_id
             WHERE a.account_id = ?1",
            [account_id],
            |row| {
                Ok(serde_json::json!({
                    "account_id": account_id,
                    "display_name": row.get::<_, String>(0)?,
                    "status": row.get::<_, String>(1)?,
                    "conversation_id": row.get::<_, Option<String>>(2)?,
                }))
            },
        )
        .optional()?
        .unwrap_or_else(|| {
            serde_json::json!({
                "account_id": account_id,
                "display_name": "",
                "status": "disconnected",
                "conversation_id": null,
            })
        });
    append_workspace_event_transaction(
        transaction,
        "ilink_status_changed",
        None,
        payload
            .get("conversation_id")
            .and_then(serde_json::Value::as_str),
        None,
        &payload,
    )?;
    Ok(())
}
