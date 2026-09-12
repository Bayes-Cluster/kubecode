//! Credential-at-rest sealing (ADR 0211 §3): AES-256-GCM over a JSON
//! credential snapshot, keyed from a machine-local secret file at
//! `<state>/ilink/secret.key` (0600, created on first login, deleted on
//! logout, never transmitted or backed up). The store persists only the
//! sealed bytes; it never sees plaintext credential material.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;
use sha2::{Digest, Sha256};

use super::error::IlinkError;

/// Version tag framing the sealed payload format.
const SEAL_VERSION: u8 = 1;
/// AES-GCM nonce length (bytes).
const NONCE_LEN: usize = 12;

/// A machine-local sealing key derived from the secret file.
pub struct SecretKeyring {
    /// Directory holding `secret.key` — `<database state dir>/ilink/`.
    directory: PathBuf,
    key: [u8; 32],
}

impl SecretKeyring {
    /// Loads or creates the secret file with restrictive permissions and
    /// derives the sealing key. The state directory is created 0700 and
    /// the key file 0600; existing over-permissive files are repaired.
    pub fn open(state_directory: impl AsRef<Path>) -> Result<Self, IlinkError> {
        let directory = state_directory.as_ref().to_path_buf();
        std::fs::create_dir_all(&directory).map_err(|error| {
            IlinkError::Crypto(format!("cannot create iLink state directory: {error}"))
        })?;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| IlinkError::Crypto(format!("cannot restrict iLink state directory: {error}")),
        )?;
        let key_path = directory.join("secret.key");
        let secret: [u8; 32] = match File::open(&key_path) {
            Ok(mut file) => {
                let mut secret = [0u8; 32];
                file.read_exact(&mut secret).map_err(|error| {
                    IlinkError::Crypto(format!("iLink secret file is unreadable: {error}"))
                })?;
                secret
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let secret = generate_secret()?;
                write_secret_atomically(&key_path, &secret)?;
                secret
            }
            Err(error) => {
                return Err(IlinkError::Crypto(format!(
                    "cannot open iLink secret file: {error}"
                )));
            }
        };
        // Repair over-permissive pre-existing files.
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| IlinkError::Crypto(format!("cannot restrict iLink secret file: {error}")),
        )?;
        let mut key = [0u8; 32];
        let mut hasher = Sha256::new();
        hasher.update(secret);
        hasher.update(b"kubecode-ilink-v1");
        key.copy_from_slice(&hasher.finalize());
        Ok(Self { directory, key })
    }

    /// The directory holding the secret file (for logout cleanup).
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Deletes the secret file atomically before any dependent state is
    /// removed (logout order per ADR 0211 §3). The keyring becomes
    /// unusable for further sealing afterwards.
    pub fn destroy(self) -> Result<(), IlinkError> {
        match std::fs::remove_file(self.directory.join("secret.key")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(IlinkError::Crypto(format!(
                "cannot delete iLink secret file: {error}"
            ))),
        }
    }

    /// Encrypts `plaintext` into a versioned sealed blob.
    pub fn seal(&self, plaintext: &[u8]) -> Result<Vec<u8>, IlinkError> {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key));
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad: b"kubecode-ilink",
                },
            )
            .map_err(|_| IlinkError::Crypto("sealing failed".into()))?;
        let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
        out.push(SEAL_VERSION);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// Opens a sealed blob produced by [`SecretKeyring::seal`]. A key or
    /// blob mismatch (e.g. a restored database on another machine) is a
    /// typed error, never a panic.
    pub fn unseal(&self, blob: &[u8]) -> Result<Vec<u8>, IlinkError> {
        let Some(&version) = blob.first() else {
            return Err(IlinkError::Crypto("sealed blob is empty".into()));
        };
        if version != SEAL_VERSION {
            return Err(IlinkError::Crypto("sealed blob version mismatch".into()));
        }
        if blob.len() < 1 + NONCE_LEN + 16 {
            return Err(IlinkError::Crypto("sealed blob is truncated".into()));
        }
        let nonce = Nonce::from_slice(&blob[1..1 + NONCE_LEN]);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key));
        cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &blob[1 + NONCE_LEN..],
                    aad: b"kubecode-ilink",
                },
            )
            .map_err(|_| IlinkError::Crypto("sealed blob failed authentication".into()))
    }
}

fn generate_secret() -> Result<[u8; 32], IlinkError> {
    let mut secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    Ok(secret)
}

/// Writes the secret with an exclusive create so two racing keyrings never
/// diverge, then tightens permissions to 0600.
fn write_secret_atomically(key_path: &Path, secret: &[u8]) -> Result<(), IlinkError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(key_path)
        .map_err(|error| IlinkError::Crypto(format!("cannot create iLink secret file: {error}")))?;
    file.write_all(secret)
        .map_err(|error| IlinkError::Crypto(format!("cannot write iLink secret file: {error}")))?;
    file.sync_all()
        .map_err(|error| IlinkError::Crypto(format!("cannot flush iLink secret file: {error}")))?;
    Ok(())
}

/// A monotonic-ish wall-clock stamp for diagnostics ordering.
pub fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_state(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "kubecode-ilink-seal-{tag}-{}-{}",
            std::process::id(),
            unix_millis()
        ));
        std::fs::create_dir_all(&base).expect("mkdir");
        base
    }

    #[test]
    fn seal_round_trips_and_rejects_tampering() {
        let dir = temp_state("roundtrip");
        let keyring = SecretKeyring::open(&dir).expect("keyring");
        let plaintext = br#"{"bot_token":"synthetic"}"#;
        let blob = keyring.seal(plaintext).expect("seal");
        assert_ne!(blob, plaintext);
        assert_eq!(keyring.unseal(&blob).expect("unseal"), plaintext.to_vec());
        // Tampering fails authentication.
        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(keyring.unseal(&tampered).is_err());
        // A different machine key cannot open the blob.
        let other = SecretKeyring::open(temp_state("other")).expect("other keyring");
        assert!(other.unseal(&blob).is_err());
        std::fs::remove_dir_all(&dir).expect("cleanup");
        std::fs::remove_dir_all(other.directory()).expect("cleanup");
    }

    #[test]
    fn secret_file_permissions_are_restrictive_and_repaired() {
        let dir = temp_state("perms");
        let key_path = dir.join("secret.key");
        let keyring = SecretKeyring::open(&dir).expect("keyring");
        let _ = keyring;
        let mode = std::fs::metadata(&key_path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let dir_mode = std::fs::metadata(&dir)
            .expect("dir metadata")
            .permissions()
            .mode();
        assert_eq!(dir_mode & 0o777, 0o700);
        // An over-permissive legacy file is repaired on open.
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o644))
            .expect("loosen");
        let reopened = SecretKeyring::open(&dir).expect("reopen");
        let repaired = std::fs::metadata(&key_path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(repaired & 0o777, 0o600);
        drop(reopened);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn destroy_removes_the_secret_file_and_survives_absence() {
        let dir = temp_state("destroy");
        let keyring = SecretKeyring::open(&dir).expect("keyring");
        assert!(dir.join("secret.key").exists());
        keyring.destroy().expect("destroy");
        assert!(!dir.join("secret.key").exists());
        // Destroying twice is idempotent.
        let again = SecretKeyring::open(&dir).expect("recreate");
        again.destroy().expect("destroy again");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
