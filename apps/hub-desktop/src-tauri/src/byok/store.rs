//! Connection metadata (no keys) in a settings file, keys in the OS credential store
//! (one entry per connection id). The UI never receives a key back.

use super::http;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const KEY_SERVICE: &str = "jkamma-hub-ai-connection";
const MAX_CONNECTIONS: usize = 20;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Anthropic,
    Openai,
    Google,
    OpenaiCompatible,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub enabled: bool,
    /// Last four characters of the saved key, if the key was long enough to show them safely.
    pub key_hint: Option<String>,
    pub has_key: bool,
    /// "スマホから使える". Off until the owner switches it on; only the paired phone path reads it.
    #[serde(default)]
    pub remote_allowed: bool,
}

/// Installed-CLI settings. Only a switch and a model; the CLI keeps its own login.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliSetting {
    pub id: String,
    pub enabled: bool,
    pub default_model: Option<String>,
    #[serde(default)]
    pub remote_allowed: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StoreFile {
    pub connections: Vec<Connection>,
    pub cli: Vec<CliSetting>,
}

pub trait KeyStore {
    fn set(&self, id: &str, key: &str) -> Result<(), &'static str>;
    fn get(&self, id: &str) -> Result<Option<String>, &'static str>;
    fn delete(&self, id: &str) -> Result<(), &'static str>;
}

/// Windows Credential Manager (keyring's `windows-native` feature is named in Cargo.toml;
/// without it keyring silently uses a throwaway in-memory store).
pub struct OsKeys;

impl OsKeys {
    fn entry(id: &str) -> Result<keyring::Entry, &'static str> {
        keyring::Entry::new(KEY_SERVICE, id).map_err(|_| "byok_store_unavailable")
    }
}

impl KeyStore for OsKeys {
    fn set(&self, id: &str, key: &str) -> Result<(), &'static str> {
        let entry = Self::entry(id)?;
        entry.set_password(key).map_err(|_| "byok_store_unavailable")?;
        // Read it back: a fake store would accept the write and lose it on restart.
        match entry.get_password() {
            Ok(stored) if stored == key => Ok(()),
            _ => Err("byok_store_unavailable"),
        }
    }
    fn get(&self, id: &str) -> Result<Option<String>, &'static str> {
        match Self::entry(id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("byok_store_unavailable"),
        }
    }
    fn delete(&self, id: &str) -> Result<(), &'static str> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("byok_store_unavailable"),
        }
    }
}

pub fn default_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(base).join("jkamma-hub").join("ai-connections.json"))
}

pub fn load(path: &Path) -> StoreFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<StoreFile>(&text).ok())
        .unwrap_or_default()
}

/// Before a change: a file that exists but cannot be read must not be replaced by an
/// empty list, which would drop every connection and orphan its stored key.
pub(super) fn load_existing(path: &Path) -> Result<StoreFile, &'static str> {
    load_for_update(path)
}

fn load_for_update(path: &Path) -> Result<StoreFile, &'static str> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| "byok_store_unreadable"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StoreFile::default()),
        Err(_) => Err("byok_store_unavailable"),
    }
}

fn write(path: &Path, file: &StoreFile) -> Result<(), &'static str> {
    let directory = path.parent().ok_or("byok_store_unavailable")?;
    std::fs::create_dir_all(directory).map_err(|_| "byok_store_unavailable")?;
    let temporary = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(file).map_err(|_| "byok_store_unavailable")?;
    std::fs::write(&temporary, text).map_err(|_| "byok_store_unavailable")?;
    std::fs::rename(&temporary, path).map_err(|_| "byok_store_unavailable")
}

fn plain(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control)
}

pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub(super) fn valid_key(key: &str) -> bool {
    (1..=512).contains(&key.len()) && key.chars().all(|c| c.is_ascii_graphic())
}

fn hint(key: &str) -> Option<String> {
    (key.len() >= 12).then(|| key[key.len() - 4..].to_owned())
}

/// `SaveInput` has no `Debug` on purpose: it carries a key.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveInput {
    pub id: Option<String>,
    pub kind: Kind,
    pub name: String,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub enabled: Option<bool>,
    pub api_key: Option<String>,
}

pub fn needs_key(kind: Kind, base: &str) -> bool {
    !(kind == Kind::OpenaiCompatible && http::is_loopback_base(base))
}

pub fn save(path: &Path, keys: &dyn KeyStore, input: SaveInput) -> Result<Connection, &'static str> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_for_update(path)?;
    if !plain(&input.name, 60) {
        return Err("byok_invalid_request");
    }
    let base = http::base_url(input.kind, input.base_url.as_deref())?;
    let default_model = input.default_model.as_deref().map(str::trim).filter(|m| !m.is_empty());
    if default_model.is_some_and(|m| !http::valid_model(input.kind, m)) {
        return Err("byok_invalid_request");
    }
    let new_key = input.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty());
    if new_key.is_some_and(|k| !valid_key(k)) {
        return Err("byok_invalid_request");
    }
    let stored_base = (input.kind == Kind::OpenaiCompatible).then(|| base.clone());
    match input.id {
        Some(id) => {
            if !valid_id(&id) {
                return Err("byok_invalid_request");
            }
            let index = file.connections.iter().position(|c| c.id == id).ok_or("byok_connection_not_found")?;
            if file.connections[index].kind != input.kind {
                return Err("byok_invalid_request");
            }
            let mut next = file.connections[index].clone();
            next.name = input.name.trim().to_owned();
            next.base_url = stored_base;
            next.default_model = default_model.map(str::to_owned);
            if let Some(enabled) = input.enabled {
                next.enabled = enabled;
            }
            if let Some(key) = new_key {
                keys.set(&id, key)?;
                next.key_hint = hint(key);
                next.has_key = true;
            }
            if next.enabled && next.has_key.eq(&false) && needs_key(next.kind, &base) {
                next.enabled = false;
            }
            file.connections[index] = next.clone();
            write(path, &file)?;
            Ok(next)
        }
        None => {
            if file.connections.len() >= MAX_CONNECTIONS {
                return Err("byok_too_many_connections");
            }
            if new_key.is_none() && needs_key(input.kind, &base) {
                return Err("byok_key_missing");
            }
            let id = uuid::Uuid::new_v4().to_string();
            if let Some(key) = new_key {
                keys.set(&id, key)?;
            }
            let connection = Connection {
                id: id.clone(),
                kind: input.kind,
                name: input.name.trim().to_owned(),
                base_url: stored_base,
                default_model: default_model.map(str::to_owned),
                enabled: input.enabled.unwrap_or(true),
                key_hint: new_key.and_then(hint),
                has_key: new_key.is_some(),
                remote_allowed: false,
            };
            file.connections.push(connection.clone());
            if let Err(error) = write(path, &file) {
                let _ = keys.delete(&id);
                return Err(error);
            }
            Ok(connection)
        }
    }
}

pub fn remove(path: &Path, keys: &dyn KeyStore, id: &str) -> Result<(), &'static str> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !valid_id(id) {
        return Err("byok_invalid_request");
    }
    let mut file = load_for_update(path)?;
    keys.delete(id)?;
    file.connections.retain(|c| c.id != id);
    write(path, &file)
}

pub fn set_enabled(path: &Path, id: &str, enabled: bool) -> Result<Connection, &'static str> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_for_update(path)?;
    let item = file.connections.iter_mut().find(|c| c.id == id).ok_or("byok_connection_not_found")?;
    if enabled && !item.has_key && needs_key(item.kind, item.base_url.as_deref().unwrap_or("https://x")) {
        return Err("byok_key_missing");
    }
    item.enabled = enabled;
    let out = item.clone();
    write(path, &file)?;
    Ok(out)
}

pub fn set_cli(path: &Path, setting: CliSetting) -> Result<CliSetting, &'static str> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !super::cli::known(&setting.id)
        || setting.default_model.as_deref().is_some_and(|m| !super::cli::model_allowed(&setting.id, m))
    {
        return Err("byok_invalid_request");
    }
    let mut file = load_for_update(path)?;
    // The phone switch is its own control: saving the CLI's model or on/off never changes it.
    let remote_allowed = file.cli.iter().find(|c| c.id == setting.id).is_some_and(|c| c.remote_allowed);
    let setting = CliSetting { remote_allowed, ..setting };
    file.cli.retain(|c| c.id != setting.id);
    file.cli.push(setting.clone());
    write(path, &file)?;
    Ok(setting)
}

/// The per-connection "スマホから使える" switch. `source` is "api" (a saved connection) or "cli".
/// Turning a connection off for the phone is always allowed; turning one on needs it to be usable.
pub fn set_remote(path: &Path, source: &str, id: &str, allowed: bool) -> Result<(), &'static str> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_for_update(path)?;
    match source {
        "api" => {
            let item = file.connections.iter_mut().find(|c| c.id == id).ok_or("byok_connection_not_found")?;
            if allowed && !item.enabled {
                return Err("byok_disabled");
            }
            item.remote_allowed = allowed;
        }
        "cli" => {
            if !super::cli::known(id) {
                return Err("byok_invalid_request");
            }
            match file.cli.iter_mut().find(|c| c.id == id) {
                Some(item) => {
                    if allowed && !item.enabled {
                        return Err("byok_disabled");
                    }
                    item.remote_allowed = allowed;
                }
                None if allowed => return Err("byok_disabled"),
                None => return Ok(()),
            }
        }
        _ => return Err("byok_invalid_request"),
    }
    write(path, &file)
}

#[cfg(test)]
pub struct MemKeys(pub Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl MemKeys {
    pub fn new() -> Self {
        Self(Mutex::new(Default::default()))
    }
}

#[cfg(test)]
impl KeyStore for MemKeys {
    fn set(&self, id: &str, key: &str) -> Result<(), &'static str> {
        self.0.lock().unwrap().insert(id.into(), key.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<Option<String>, &'static str> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn delete(&self, id: &str) -> Result<(), &'static str> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hub-byok-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn input(kind: Kind, key: Option<&str>) -> SaveInput {
        SaveInput {
            id: None,
            kind,
            name: "テスト".into(),
            base_url: (kind == Kind::OpenaiCompatible).then(|| "https://openrouter.ai/api/v1".into()),
            default_model: Some("m-1".into()),
            enabled: None,
            api_key: key.map(str::to_owned),
        }
    }

    #[test]
    fn an_unreadable_settings_file_is_not_replaced_by_an_empty_one() {
        let path = temp("corrupt.json");
        std::fs::write(&path, "{not json").unwrap();
        let keys = MemKeys::new();
        assert_eq!(save(&path, &keys, input(Kind::Openai, Some("sk-test-key-1234"))).err(), Some("byok_store_unreadable"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
        assert!(keys.0.lock().unwrap().is_empty(), "no key is stored for a connection that was not saved");
    }

    #[test]
    fn key_goes_to_the_key_store_and_never_into_the_settings_file() {
        let path = temp("c.json");
        let keys = MemKeys::new();
        let secret = "sk-test-SECRET-1234";
        let saved = save(&path, &keys, input(Kind::Openai, Some(secret))).unwrap();
        assert_eq!(saved.key_hint.as_deref(), Some("1234"));
        assert!(saved.has_key && saved.enabled);
        assert_eq!(keys.get(&saved.id).unwrap().as_deref(), Some(secret));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("SECRET") && !text.contains("apiKey"));
        assert_eq!(load(&path).connections.len(), 1);
    }

    #[test]
    fn editing_without_a_key_keeps_the_stored_key_and_kind_cannot_change() {
        let path = temp("c.json");
        let keys = MemKeys::new();
        let saved = save(&path, &keys, input(Kind::Anthropic, Some("sk-ant-abcdefgh1111"))).unwrap();
        let mut edit = input(Kind::Anthropic, None);
        edit.id = Some(saved.id.clone());
        edit.name = "名前変更".into();
        let edited = save(&path, &keys, edit).unwrap();
        assert_eq!(edited.name, "名前変更");
        assert_eq!(edited.key_hint.as_deref(), Some("1111"));
        assert_eq!(keys.get(&saved.id).unwrap().as_deref(), Some("sk-ant-abcdefgh1111"));
        let mut wrong = input(Kind::Google, None);
        wrong.id = Some(saved.id);
        assert_eq!(save(&path, &keys, wrong), Err("byok_invalid_request"));
    }

    #[test]
    fn remote_connections_need_a_key_but_loopback_servers_do_not() {
        let path = temp("c.json");
        let keys = MemKeys::new();
        assert_eq!(save(&path, &keys, input(Kind::Google, None)), Err("byok_key_missing"));
        assert_eq!(save(&path, &keys, input(Kind::OpenaiCompatible, None)), Err("byok_key_missing"));
        let mut local = input(Kind::OpenaiCompatible, None);
        local.base_url = Some("http://localhost:1234/v1".into());
        assert!(save(&path, &keys, local).is_ok());
    }

    #[test]
    fn remove_deletes_key_and_metadata_and_bad_input_is_rejected() {
        let path = temp("c.json");
        let keys = MemKeys::new();
        let saved = save(&path, &keys, input(Kind::Openai, Some("sk-abcdefghij"))).unwrap();
        remove(&path, &keys, &saved.id).unwrap();
        assert!(keys.get(&saved.id).unwrap().is_none());
        assert!(load(&path).connections.is_empty());
        assert_eq!(remove(&path, &keys, "../x"), Err("byok_invalid_request"));
        assert_eq!(save(&path, &keys, input(Kind::Openai, Some("bad key"))), Err("byok_invalid_request"));
        let mut long = input(Kind::Openai, Some("sk-abcdefghij"));
        long.name = "x".repeat(61);
        assert_eq!(save(&path, &keys, long), Err("byok_invalid_request"));
    }

    #[test]
    fn the_phone_switch_defaults_off_and_survives_edits() {
        let path = temp("c.json");
        let keys = MemKeys::new();
        let saved = save(&path, &keys, input(Kind::Openai, Some("sk-abcdefghij"))).unwrap();
        assert!(!saved.remote_allowed);
        set_remote(&path, "api", &saved.id, true).unwrap();
        assert!(load(&path).connections[0].remote_allowed);
        let mut edit = input(Kind::Openai, None);
        edit.id = Some(saved.id.clone());
        edit.name = "名前変更".into();
        assert!(save(&path, &keys, edit).unwrap().remote_allowed);
        set_remote(&path, "api", &saved.id, false).unwrap();
        assert!(!load(&path).connections[0].remote_allowed);
        // An older settings file without the field reads as "off".
        let old = r#"{"connections":[{"id":"11111111-1111-4111-8111-111111111111","kind":"openai","name":"x","baseUrl":null,"defaultModel":null,"enabled":true,"keyHint":null,"hasKey":true}],"cli":[{"id":"claude","enabled":true,"defaultModel":null}]}"#;
        std::fs::write(&path, old).unwrap();
        let file = load(&path);
        assert!(!file.connections[0].remote_allowed && !file.cli[0].remote_allowed);
    }

    #[test]
    fn the_phone_switch_needs_a_usable_connection_and_cli_saves_keep_it() {
        let path = temp("c.json");
        let keys = MemKeys::new();
        let saved = save(&path, &keys, input(Kind::Openai, Some("sk-abcdefghij"))).unwrap();
        set_enabled(&path, &saved.id, false).unwrap();
        assert_eq!(set_remote(&path, "api", &saved.id, true), Err("byok_disabled"));
        assert_eq!(set_remote(&path, "api", "nope", true), Err("byok_connection_not_found"));
        assert_eq!(set_remote(&path, "cli", "claude", true), Err("byok_disabled"));
        assert_eq!(set_remote(&path, "cli", "rm -rf", true), Err("byok_invalid_request"));
        assert_eq!(set_remote(&path, "other", "claude", false), Err("byok_invalid_request"));
        set_cli(&path, CliSetting { id: "claude".into(), enabled: true, default_model: None, remote_allowed: false }).unwrap();
        set_remote(&path, "cli", "claude", true).unwrap();
        // Saving the CLI's model or on/off through the ordinary control cannot flip the phone switch.
        set_cli(&path, CliSetting { id: "claude".into(), enabled: true, default_model: Some("sonnet".into()), remote_allowed: false }).unwrap();
        assert!(load(&path).cli[0].remote_allowed);
        set_remote(&path, "cli", "claude", false).unwrap();
        assert!(!load(&path).cli[0].remote_allowed);
    }

    #[test]
    fn short_keys_show_no_hint_and_enable_requires_a_key() {
        assert_eq!(hint("short"), None);
        let path = temp("c.json");
        let keys = MemKeys::new();
        let saved = save(&path, &keys, input(Kind::Openai, Some("sk-abcdefghij"))).unwrap();
        assert!(set_enabled(&path, &saved.id, false).is_ok());
        assert!(!load(&path).connections[0].enabled);
        assert_eq!(set_enabled(&path, "nope", true), Err("byok_connection_not_found"));
    }
}
