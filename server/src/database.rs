use std::fs::{File, OpenOptions};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;
use thiserror::Error;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("Kubecode state database is already owned: {path} ({reason})")]
    AlreadyOwned { path: String, reason: String },
    #[error("SQLite refused rollback journal mode and returned {0}")]
    UnexpectedJournalMode(String),
}

pub struct Database {
    path: PathBuf,
    connection: Mutex<Connection>,
    _ownership: Option<File>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DatabaseError> {
        Self::open_inner(path.as_ref(), false)
    }

    pub fn open_owned(path: impl AsRef<Path>) -> Result<Self, DatabaseError> {
        Self::open_inner(path.as_ref(), true)
    }

    fn open_inner(path: &Path, acquire_ownership: bool) -> Result<Self, DatabaseError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let ownership = acquire_ownership
            .then(|| acquire_owner_lock(path))
            .transpose()?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(BUSY_TIMEOUT)?;

        let journal_mode = connection.query_row("PRAGMA journal_mode = DELETE", [], |row| {
            row.get::<_, String>(0)
        })?;
        if !journal_mode.eq_ignore_ascii_case("delete") {
            return Err(DatabaseError::UnexpectedJournalMode(journal_mode));
        }
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA synchronous = FULL;",
        )?;

        Ok(Self {
            path: path.to_path_buf(),
            connection: Mutex::new(connection),
            _ownership: ownership,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Deref for Database {
    type Target = Mutex<Connection>;

    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

fn acquire_owner_lock(database_path: &Path) -> Result<File, DatabaseError> {
    let lock_path = database_path.with_extension("sqlite3.owner");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    lock.try_lock()
        .map_err(|error| DatabaseError::AlreadyOwned {
            path: database_path.display().to_string(),
            reason: error.to_string(),
        })?;
    Ok(lock)
}
