use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const SERVICE: &str = "com.jkamma.hub-local-runner";
const ACCOUNT: &str = "checkpoint-key-v1";
const FORMAT_VERSION: u8 = 1;

#[derive(Clone)]
pub struct CheckpointStore {
    directory: PathBuf,
    key: [u8; 32],
}

impl CheckpointStore {
    pub fn system() -> Result<Self, String> {
        Self::named("checkpoints")
    }

    /// A separate directory for a separate kind of record.
    ///
    /// load_all deserializes every file it finds, so two kinds in one directory
    /// silently read each other whenever their shapes happen to overlap.
    pub fn named(folder: &str) -> Result<Self, String> {
        Self::with_key(folder, ACCOUNT)
    }

    /// Hold across key lookup and every read/update of a shared record. This
    /// permanent empty file carries no data; the OS releases its lock on drop.
    pub(crate) fn lock_named(folder: &str) -> Result<fs::File, String> {
        lock_directory(&app_data_directory()?.join(folder))
    }

    /// Like lock_named, but waits for the holder instead of failing at once.
    pub(crate) fn lock_named_wait(folder: &str) -> Result<fs::File, String> {
        let directory = app_data_directory()?.join(folder);
        fs::create_dir_all(&directory).map_err(|_| "checkpoint_directory_unavailable")?;
        let file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("journal.lock"))
            .map_err(|_| "checkpoint_unavailable")?;
        file.lock().map_err(|_| "checkpoint_lock_busy")?;
        Ok(file)
    }

    pub(crate) fn with_key(folder: &str, account: &str) -> Result<Self, String> {
        let directory = app_data_directory()?.join(folder);
        fs::create_dir_all(&directory).map_err(|_| "checkpoint_directory_unavailable")?;
        #[cfg(not(test))]
        let entry =
            keyring::Entry::new(SERVICE, account).map_err(|_| "credential_store_unavailable")?;
        #[cfg(test)]
        let entry = test_credential_entry(account)?;
        let key = match entry.get_password() {
            Ok(encoded) => decode_key(&encoded)?,
            Err(keyring::Error::NoEntry) => {
                let mut key = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                entry
                    .set_password(&STANDARD.encode(key))
                    .map_err(|_| "credential_store_unavailable")?;
                key
            }
            Err(_) => return Err("credential_store_unavailable".into()),
        };
        Ok(Self { directory, key })
    }

    /// Recovery may read an existing encryption key, but must not create one.
    pub(crate) fn with_existing_key(folder: &str, account: &str) -> Result<Self, String> {
        #[cfg(not(test))]
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|_| "credential_store_unavailable")?;
        #[cfg(test)]
        let entry = test_credential_entry(account)?;
        let encoded = entry.get_password().map_err(|_| "credential_store_unavailable")?;
        Ok(Self { directory: app_data_directory()?.join(folder), key: decode_key(&encoded)? })
    }

    #[cfg(test)]
    pub fn test(directory: PathBuf, key: [u8; 32]) -> Self {
        fs::create_dir_all(&directory).unwrap();
        Self { directory, key }
    }

    pub fn save<T: Serialize>(&self, id: &str, value: &T) -> Result<(), String> {
        validate_id(id)?;
        let plaintext = serde_json::to_vec(value).map_err(|_| "checkpoint_encode_failed")?;
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| "checkpoint_key_invalid")?;
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .map_err(|_| "checkpoint_encrypt_failed")?;
        let mut envelope = Vec::with_capacity(13 + encrypted.len());
        envelope.push(FORMAT_VERSION);
        envelope.extend_from_slice(&nonce);
        envelope.extend_from_slice(&encrypted);
        atomic_write(&self.path(id), &envelope)
    }

    /// idを指して1つ読む。
    ///
    /// 「どれか1つ」で足りない場面がある。ノードの身元鍵のように、**必ず
    /// 1つでなければならないもの**は、名前で指して読む。並びに任せると、
    /// 同時に作られたときに別の身元を掴む。
    pub fn load<T: DeserializeOwned>(&self, id: &str) -> Option<T> {
        validate_id(id).ok()?;
        self.load_path(&self.path(id)).ok()
    }

    /// Only a missing record is empty. Bound ciphertext reads as well as the
    /// decrypted JSON; unreadable, corrupt and oversized records stay errors.
    pub(crate) fn load_optional_bounded<T: DeserializeOwned>(
        &self,
        id: &str,
        max_bytes: usize,
    ) -> Result<Option<T>, String> {
        validate_id(id)?;
        let max_read = max_bytes.checked_add(30).ok_or("checkpoint_too_large")?;
        let max_envelope = max_read - 1;
        let file = match fs::File::open(self.path(id)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("checkpoint_unavailable".into()),
        };
        if file.metadata().map_err(|_| "checkpoint_unavailable")?.len() > max_envelope as u64 {
            return Err("checkpoint_too_large".into());
        }
        let mut envelope = Vec::new();
        file.take(max_read as u64)
            .read_to_end(&mut envelope)
            .map_err(|_| "checkpoint_unavailable")?;
        if envelope.len() > max_envelope {
            return Err("checkpoint_too_large".into());
        }
        if envelope.len() < 29 || envelope[0] != FORMAT_VERSION {
            return Err("checkpoint_format_invalid".into());
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| "checkpoint_key_invalid")?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&envelope[1..13]), &envelope[13..])
            .map_err(|_| "checkpoint_authentication_failed")?;
        if plaintext.len() > max_bytes {
            return Err("checkpoint_too_large".into());
        }
        serde_json::from_slice(&plaintext)
            .map(Some)
            .map_err(|_| "checkpoint_decode_failed".into())
    }

    pub fn load_all<T: DeserializeOwned>(&self) -> Vec<T> {
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| self.load_path(&entry.path()).ok())
            .collect()
    }

    pub fn remove(&self, id: &str) {
        if validate_id(id).is_ok() {
            let _ = fs::remove_file(self.path(id));
        }
    }

    /// Move an unreadable record into `unreadable/` instead of overwriting it, so a
    /// replacement never destroys the only copy. load_all skips the subdirectory.
    pub(crate) fn set_aside(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let aside = self.directory.join("unreadable");
        fs::create_dir_all(&aside).map_err(|_| "checkpoint_directory_unavailable")?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or_default();
        fs::rename(self.path(id), aside.join(format!("{id}.{stamp}.jkcp")))
            .map_err(|_| "checkpoint_unavailable".into())
    }

    fn load_path<T: DeserializeOwned>(&self, path: &Path) -> Result<T, String> {
        let envelope = fs::read(path).map_err(|_| "checkpoint_unavailable")?;
        if envelope.len() < 29 || envelope[0] != FORMAT_VERSION {
            return Err("checkpoint_format_invalid".into());
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| "checkpoint_key_invalid")?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&envelope[1..13]), &envelope[13..])
            .map_err(|_| "checkpoint_authentication_failed")?;
        serde_json::from_slice(&plaintext).map_err(|_| "checkpoint_decode_failed".into())
    }

    fn path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.jkcp"))
    }
    /// The folder this store reads and writes.
    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }
}

/// Where a named store keeps its records, without touching the key.
pub(crate) fn folder_path(folder: &str) -> Result<PathBuf, String> {
    Ok(app_data_directory()?.join(folder))
}

/// Record ids (UUID file stems) directly in `directory`, with their modified times.
pub(crate) fn record_ids(directory: &Path) -> Vec<(String, std::time::SystemTime)> {
    let Ok(entries) = fs::read_dir(directory) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jkcp") { return None; }
            let id = path.file_stem()?.to_str()?.to_owned();
            validate_id(&id).ok()?;
            let metadata = fs::symlink_metadata(&path).ok()?;
            metadata.is_file().then_some(())?;
            Some((id, metadata.modified().ok()?))
        })
        .collect()
}

/// Remove one record by id from `directory`. Only UUID ids are accepted.
pub(crate) fn remove_record(directory: &Path, id: &str) -> bool {
    validate_id(id).is_ok() && fs::remove_file(directory.join(format!("{id}.jkcp"))).is_ok()
}

/// Remove records last written before `cutoff`, except ids in `keep`; also
/// clears set-aside copies in `unreadable/` that are older than `cutoff`.
/// Returns the removed ids.
pub(crate) fn remove_records_older_than(
    directory: &Path,
    cutoff: std::time::SystemTime,
    keep: &std::collections::HashSet<String>,
) -> Vec<String> {
    let mut removed = Vec::new();
    for (id, modified) in record_ids(directory) {
        if modified < cutoff && !keep.contains(&id) && remove_record(directory, &id) {
            removed.push(id);
        }
    }
    if let Ok(entries) = fs::read_dir(directory.join("unreadable")) {
        for entry in entries.filter_map(Result::ok) {
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else { continue };
            if metadata.is_file() && metadata.modified().is_ok_and(|modified| modified < cutoff) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    removed
}

fn lock_directory(directory: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(directory).map_err(|_| "checkpoint_directory_unavailable")?;
    let file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("journal.lock"))
        .map_err(|_| "checkpoint_unavailable")?;
    file.try_lock().map_err(|_| "checkpoint_lock_busy")?;
    Ok(file)
}

fn decode_key(encoded: &str) -> Result<[u8; 32], String> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "checkpoint_key_invalid")?;
    bytes
        .try_into()
        .map_err(|_| "checkpoint_key_invalid".into())
}

fn validate_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "checkpoint_id_invalid".into())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "checkpoint_write_failed")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "checkpoint_write_failed")?;
    fs::rename(&temporary, path).map_err(|_| "checkpoint_replace_failed".to_owned())
}

#[cfg(not(test))]
fn app_data_directory() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .map(|base| base.join("JKamma").join("HubLocalRunner"))
        .ok_or_else(|| "app_data_unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_checkpoints_round_trip_and_reject_tampering() {
        let directory =
            std::env::temp_dir().join(format!("hub-checkpoint-{}", uuid::Uuid::new_v4()));
        let store = CheckpointStore::test(directory.clone(), [7; 32]);
        let id = uuid::Uuid::new_v4().to_string();
        store
            .save(&id, &serde_json::json!({"status":"completed"}))
            .unwrap();
        let raw = fs::read(store.path(&id)).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("completed"));
        assert_eq!(store.load_all::<serde_json::Value>().len(), 1);
        let mut damaged = raw;
        damaged[20] ^= 1;
        fs::write(store.path(&id), damaged).unwrap();
        assert!(store.load_all::<serde_json::Value>().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
    /// The existing round-trip test hands the key in, so it passes even when
    /// the key is not actually kept anywhere. This one takes the key from the
    /// same place the app does, twice, in the way a restart would. It failed
    /// before the credential backend was named: keyring builds a throwaway
    /// in-memory store when no platform feature is enabled, so every launch
    /// invented a new key and nothing saved could ever be read back.
    #[test]
    fn a_restart_can_still_read_what_the_last_run_saved() {
        let folder = format!("hub-key-{}", uuid::Uuid::new_v4());
        let writer = CheckpointStore::named(&folder).expect("credential store");
        let id = uuid::Uuid::new_v4().to_string();
        writer
            .save(&id, &serde_json::json!({ "kept": "この値" }))
            .unwrap();

        let reader = CheckpointStore::named(&folder).expect("credential store");
        let found = reader.load_all::<serde_json::Value>();
        let directory = reader.directory.clone();
        fs::remove_dir_all(directory).ok();

        assert_eq!(
            found.len(),
            1,
            "保存した記録が読み戻せない。鍵が保たれていない"
        );
        assert_eq!(found[0]["kept"], "この値");
    }
}

#[cfg(test)]
mod strict_tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn journal_lock_serializes_two_stores_and_releases_on_drop() {
        let directory =
            std::env::temp_dir().join(format!("hub-checkpoint-lock-{}", uuid::Uuid::new_v4()));
        let first = lock_directory(&directory).unwrap();
        assert_eq!(
            lock_directory(&directory).err().unwrap(),
            "checkpoint_lock_busy"
        );
        let writer = CheckpointStore::test(directory.clone(), [16; 32]);
        let id = uuid::Uuid::new_v4().to_string();
        writer.save(&id, &json!({"kept": true})).unwrap();
        drop(first);
        let second = lock_directory(&directory).unwrap();
        let reader = CheckpointStore::test(directory.clone(), [16; 32]);
        assert_eq!(
            reader.load_optional_bounded::<Value>(&id, 100).unwrap(),
            Some(json!({"kept":true}))
        );
        assert_eq!(
            fs::metadata(directory.join("journal.lock")).unwrap().len(),
            0
        );
        drop(second);
        assert!(directory.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn optional_bounded_load_distinguishes_missing_corrupt_and_wrong_key() {
        let directory =
            std::env::temp_dir().join(format!("hub-checkpoint-strict-{}", uuid::Uuid::new_v4()));
        let store = CheckpointStore::test(directory.clone(), [11; 32]);
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            store.load_optional_bounded::<Value>(&id, 100).unwrap(),
            None
        );
        assert!(store
            .load_optional_bounded::<Value>("invalid", 100)
            .is_err());
        store.save(&id, &json!({"kept":"境界"})).unwrap();
        assert_eq!(
            store.load_optional_bounded::<Value>(&id, 100).unwrap(),
            Some(json!({"kept":"境界"}))
        );
        let other = CheckpointStore::test(directory.clone(), [12; 32]);
        assert_eq!(
            other.load_optional_bounded::<Value>(&id, 100).unwrap_err(),
            "checkpoint_authentication_failed"
        );
        fs::write(store.path(&id), [FORMAT_VERSION; 28]).unwrap();
        assert_eq!(
            store.load_optional_bounded::<Value>(&id, 100).unwrap_err(),
            "checkpoint_format_invalid"
        );
        fs::remove_file(store.path(&id)).unwrap();
        fs::create_dir(store.path(&id)).unwrap();
        assert!(store.load_optional_bounded::<Value>(&id, 100).is_err());
        assert!(directory.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn optional_bounded_load_enforces_exact_serialized_byte_limit() {
        let directory =
            std::env::temp_dir().join(format!("hub-checkpoint-size-{}", uuid::Uuid::new_v4()));
        let store = CheckpointStore::test(directory.clone(), [13; 32]);
        let id = uuid::Uuid::new_v4().to_string();
        let value = json!("🧪\n末尾");
        let size = serde_json::to_vec(&value).unwrap().len();
        store.save(&id, &value).unwrap();
        assert_eq!(
            store.load_optional_bounded::<Value>(&id, size).unwrap(),
            Some(value)
        );
        assert_eq!(
            store
                .load_optional_bounded::<Value>(&id, size - 1)
                .unwrap_err(),
            "checkpoint_too_large"
        );
        assert_eq!(
            store
                .load_optional_bounded::<Value>(&id, usize::MAX)
                .unwrap_err(),
            "checkpoint_too_large"
        );
        assert_eq!(
            store
                .load_optional_bounded::<Value>(&id, usize::MAX - 29)
                .unwrap_err(),
            "checkpoint_too_large"
        );
        assert!(directory.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn optional_bounded_load_rejects_bad_version_and_invalid_json() {
        let directory =
            std::env::temp_dir().join(format!("hub-checkpoint-format-{}", uuid::Uuid::new_v4()));
        let store = CheckpointStore::test(directory.clone(), [14; 32]);
        let id = uuid::Uuid::new_v4().to_string();
        store.save(&id, &json!({"value":1})).unwrap();
        let mut raw = fs::read(store.path(&id)).unwrap();
        raw[0] = FORMAT_VERSION + 1;
        fs::write(store.path(&id), raw).unwrap();
        assert_eq!(
            store.load_optional_bounded::<Value>(&id, 100).unwrap_err(),
            "checkpoint_format_invalid"
        );
        store.save(&id, &json!({"value":1})).unwrap();
        assert_eq!(
            store
                .load_optional_bounded::<Vec<Value>>(&id, 100)
                .unwrap_err(),
            "checkpoint_decode_failed"
        );
        assert!(directory.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(directory).unwrap();
    }
}


#[cfg(test)]
fn test_credential_entry(account: &str) -> Result<std::sync::Arc<keyring::Entry>, String> {
    static INIT: std::sync::Once = std::sync::Once::new();
    static ENTRIES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<keyring::Entry>>>> = std::sync::OnceLock::new();
    INIT.call_once(|| keyring::set_default_credential_builder(keyring::mock::default_credential_builder()));
    let mut entries = ENTRIES.get_or_init(Default::default).lock().map_err(|_| "credential_store_unavailable")?;
    if let Some(entry) = entries.get(account) { return Ok(entry.clone()); }
    let entry = std::sync::Arc::new(keyring::Entry::new(SERVICE, account).map_err(|_| "credential_store_unavailable")?);
    entries.insert(account.to_owned(), entry.clone());
    Ok(entry)
}

#[cfg(test)]
fn app_data_directory() -> Result<PathBuf, String> {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    let root = ROOT.get_or_init(|| std::env::temp_dir().join(format!("hub-native-fixture-{}", uuid::Uuid::new_v4()))).clone();
    fs::create_dir_all(&root).map_err(|_| "app_data_unavailable")?;
    Ok(root)
}
