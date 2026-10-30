//! Remembered per-site permission decisions for normal browser tabs.
//!
//! A decision is keyed by the top-level origin and the WebView2 permission kind. It is applied only
//! to later requests of a normal (non-private) tab, never persisted from a private tab. The store is
//! a small JSON file in the app data directory (atomic temp + rename, size-limited, strict parse).
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::{Path, PathBuf}, sync::Mutex};

const ERROR: &str = "browser_site_permissions_unavailable";
pub(crate) const INVALID_ORIGIN: &str = "browser_site_permission_origin_invalid";
const FILE: &str = "browser-site-permissions.json";
const LIMIT: u64 = 256 * 1024;
pub(crate) const MAX_ENTRIES: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Entry { pub origin: String, pub kind: i32, pub decision: String, pub updated_at: i64 }

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Stored { version: u8, entries: Vec<Entry> }

static STORE: Mutex<Option<Vec<Entry>>> = Mutex::new(None);

/// A canonical http(s) origin (`scheme://host[:port]`) and nothing else.
pub(crate) fn valid_origin(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > 300 || raw.chars().any(char::is_control) { return false; }
    let Ok(url) = tauri::Url::parse(raw) else { return false };
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
        && url.username().is_empty() && url.password().is_none()
        && url.origin().ascii_serialization() == raw
}

fn valid_entry(entry: &Entry) -> bool {
    valid_origin(&entry.origin) && (1..=12).contains(&entry.kind) && matches!(entry.decision.as_str(), "allow" | "deny")
}

fn valid_all(entries: &[Entry]) -> bool {
    entries.len() <= MAX_ENTRIES && entries.iter().enumerate().all(|(index, entry)| valid_entry(entry)
        && !entries[..index].iter().any(|other| other.origin == entry.origin && other.kind == entry.kind))
}

/// Insert or replace one decision, then drop the oldest entries beyond the bound.
pub(crate) fn upsert(entries: &mut Vec<Entry>, origin: &str, kind: i32, decision: &str, now: i64) -> Result<(), String> {
    let entry = Entry { origin: origin.to_owned(), kind, decision: decision.to_owned(), updated_at: now };
    if !valid_entry(&entry) { return Err(INVALID_ORIGIN.into()); }
    entries.retain(|existing| !(existing.origin == entry.origin && existing.kind == entry.kind));
    entries.push(entry);
    if entries.len() > MAX_ENTRIES {
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
        entries.truncate(MAX_ENTRIES);
    }
    Ok(())
}

/// Remove one kind (or every kind when `kind` is None) for an origin. Returns the removed count.
pub(crate) fn forget_from(entries: &mut Vec<Entry>, origin: &str, kind: Option<i32>) -> usize {
    let before = entries.len();
    entries.retain(|entry| !(entry.origin == origin && kind.is_none_or(|kind| entry.kind == kind)));
    before - entries.len()
}

pub(crate) fn lookup_in<'a>(entries: &'a [Entry], origin: &str, kind: i32) -> Option<&'a str> {
    entries.iter().find(|entry| entry.origin == origin && entry.kind == kind).map(|entry| entry.decision.as_str())
}

fn path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(base).join("jkamma-hub").join(FILE))
}

pub(crate) fn read(path: &Path) -> Result<Vec<Entry>, String> {
    let input = match fs::File::open(path) {
        Ok(input) => input,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(ERROR.into()),
    };
    if !input.metadata().map_err(|_| ERROR)?.is_file() { return Err(ERROR.into()); }
    let mut bytes = Vec::new();
    input.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    if bytes.len() as u64 > LIMIT { return Err(ERROR.into()); }
    let stored: Stored = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if stored.version != 1 || !valid_all(&stored.entries) { return Err(ERROR.into()); }
    Ok(stored.entries)
}

pub(crate) fn write(path: &Path, entries: &[Entry]) -> Result<(), String> {
    if !valid_all(entries) { return Err(ERROR.into()); }
    let bytes = serde_json::to_vec(&Stored { version: 1, entries: entries.to_vec() }).map_err(|_| ERROR)?;
    crate::browser_bookmarks::write_atomic(path, &bytes).map_err(|_| ERROR.into())
}

fn with_store<T>(change: impl FnOnce(&mut Vec<Entry>) -> Result<(T, bool), String>) -> Result<T, String> {
    let mut slot = STORE.lock().map_err(|_| ERROR)?;
    let path = path().ok_or(ERROR)?;
    if slot.is_none() {
        // A corrupt file is treated as empty in memory and replaced on the next change.
        *slot = Some(read(&path).unwrap_or_default());
    }
    let entries = slot.as_mut().ok_or(ERROR)?;
    let mut next = entries.clone();
    let (value, changed) = change(&mut next)?;
    if changed {
        write(&path, &next)?;
        *entries = next;
    }
    Ok(value)
}

/// The stored decision ("allow" | "deny") for a top-level origin, or None.
pub(crate) fn lookup(origin: &str, kind: i32) -> Option<String> {
    with_store(|entries| Ok((lookup_in(entries, origin, kind).map(str::to_owned), false))).ok().flatten()
}

pub(crate) fn remember(origin: &str, kind: i32, allow: bool) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    with_store(|entries| upsert(entries, origin, kind, if allow { "allow" } else { "deny" }, now).map(|_| ((), true)))
}

pub(crate) fn list() -> Vec<Entry> {
    let mut entries = with_store(|entries| Ok((entries.clone(), false))).unwrap_or_default();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
    entries
}

pub(crate) fn forget(origin: &str, kind: Option<i32>) -> Result<(), String> {
    if !valid_origin(origin) { return Err(INVALID_ORIGIN.into()); }
    with_store(|entries| { let removed = forget_from(entries, origin, kind); Ok(((), removed > 0)) })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Folder(PathBuf);
    impl Folder { fn new() -> Self { Self(std::env::temp_dir().join(format!("hub-site-perm-test-{}", uuid::Uuid::new_v4()))) } }
    impl Drop for Folder { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn origins_must_be_canonical_http_origins() {
        for good in ["https://example.org", "http://example.org:8080", "https://sub.example.org"] { assert!(valid_origin(good), "{good}"); }
        for bad in ["", "example.org", "https://example.org/", "https://example.org/path", "https://u:p@example.org", "file:///x", "ftp://example.org", "javascript:alert(1)", "https://example.org\n", "HTTPS://Example.org"] {
            assert!(!valid_origin(bad), "{bad}");
        }
    }
    #[test]
    fn upsert_replaces_same_key_and_forget_scopes() {
        let mut entries = Vec::new();
        upsert(&mut entries, "https://a.example", 1, "allow", 10).unwrap();
        upsert(&mut entries, "https://a.example", 2, "deny", 11).unwrap();
        upsert(&mut entries, "https://b.example", 1, "allow", 12).unwrap();
        upsert(&mut entries, "https://a.example", 1, "deny", 13).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(lookup_in(&entries, "https://a.example", 1), Some("deny"));
        assert_eq!(lookup_in(&entries, "https://a.example", 3), None);
        assert_eq!(forget_from(&mut entries, "https://a.example", Some(2)), 1);
        assert_eq!(forget_from(&mut entries, "https://a.example", None), 1);
        assert_eq!(entries.len(), 1);
        assert_eq!(forget_from(&mut entries, "https://zzz.example", None), 0);
    }
    #[test]
    fn invalid_input_is_refused_and_store_is_bounded() {
        let mut entries = Vec::new();
        assert!(upsert(&mut entries, "https://a.example/", 1, "allow", 1).is_err());
        assert!(upsert(&mut entries, "https://a.example", 0, "allow", 1).is_err());
        assert!(upsert(&mut entries, "https://a.example", 13, "allow", 1).is_err());
        assert!(upsert(&mut entries, "https://a.example", 1, "maybe", 1).is_err());
        for index in 0..(MAX_ENTRIES + 25) { upsert(&mut entries, &format!("https://h{index}.example"), 1, "allow", index as i64).unwrap(); }
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert!(lookup_in(&entries, "https://h0.example", 1).is_none());
        assert!(lookup_in(&entries, &format!("https://h{}.example", MAX_ENTRIES + 24), 1).is_some());
    }
    #[test]
    fn round_trip_is_strict_and_leaves_no_temporary_file() {
        let folder = Folder::new(); let file = folder.0.join(FILE);
        assert!(read(&file).unwrap().is_empty());
        let mut entries = Vec::new();
        upsert(&mut entries, "https://a.example", 4, "deny", 5).unwrap();
        fs::create_dir_all(&folder.0).unwrap();
        write(&file, &entries).unwrap();
        assert_eq!(read(&file).unwrap(), entries);
        assert_eq!(fs::read_dir(&folder.0).unwrap().count(), 1);
        fs::write(&file, br#"{"version":1,"entries":[{"origin":"https://a.example","kind":4,"decision":"allow","updatedAt":1,"extra":1}]}"#).unwrap();
        assert!(read(&file).is_err());
        fs::write(&file, br#"{"version":1,"entries":[{"origin":"https://a.example/x","kind":4,"decision":"allow","updatedAt":1}]}"#).unwrap();
        assert!(read(&file).is_err());
        fs::write(&file, vec![b' '; LIMIT as usize + 1]).unwrap();
        assert!(read(&file).is_err());
    }
}
