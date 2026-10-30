//! Where this PC keeps Hub data, and the parts of "手元のデータを消す" that run here.
//! See docs/hub-desktop-local-data/INVENTORY.md (decisions of 2026-10-18).
//!
//! - Browser history, the previous session and site zoom live in `%LOCALAPPDATA%\jkamma-hub`.
//!   Older versions kept them in Roaming; `startup` moves them once (copy, verify, delete).
//! - Personal Node data is deleted at the next start, before the node opens its files.
//!   A running node holds its state in memory and would write it back.
//! - The wallet key is deleted only through its own command, never as part of "all".

use std::path::{Path, PathBuf};

/// Files moved from Roaming to Local. Contents and format do not change.
pub(crate) const MOVED_TO_LOCAL: &[&str] = &["browser-history.json", "browser-session.json", "browser-site-zoom.json"];
const PENDING_WIPE: &str = "pending-local-data-wipe.json";
/// The word typed to delete the wallet key.
pub(crate) const WALLET_CONFIRMATION: &str = "ウォレットを消す";
/// Personal Node entries in a storage folder the user chose; nothing else there is touched.
const NODE_ENTRIES: &[&str] = &["chain.json", "events", "receipts", "previews", "peers", "artifacts", "media-cache"];

fn roaming_hub_dir() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(base).join("jkamma-hub"))
}

/// `%LOCALAPPDATA%\jkamma-hub`; where LOCALAPPDATA is missing, the same folder as before.
pub(crate) fn local_hub_dir() -> Option<PathBuf> {
    match std::env::var_os("LOCALAPPDATA") {
        Some(base) => Some(PathBuf::from(base).join("jkamma-hub")),
        None => roaming_hub_dir(),
    }
}

/// Runs once per start, before any store is opened.
pub(crate) fn startup() {
    if let (Some(from), Some(to)) = (roaming_hub_dir(), local_hub_dir()) {
        if from != to {
            for (name, result) in move_files(&from, &to, MOVED_TO_LOCAL) {
                if let Err(error) = result { eprintln!("local_data: {name} not moved: {error}"); }
            }
        }
    }
    if let Some(roaming) = roaming_hub_dir() {
        if let Err(error) = run_pending_wipe(&roaming) { eprintln!("local_data: wipe failed: {error}"); }
    }
}

/// Move each file from `from` to `to`: copy to a temporary name, compare the bytes,
/// rename into place, then delete the old file. Safe to repeat after a crash at any
/// step. When the new place already has the file, it is the one in use and wins.
pub(crate) fn move_files<'a>(from: &Path, to: &Path, names: &[&'a str]) -> Vec<(&'a str, Result<bool, &'static str>)> {
    names.iter().map(|name| (*name, move_file(&from.join(name), &to.join(name)))).collect()
}

fn move_file(old: &Path, new: &Path) -> Result<bool, &'static str> {
    let Ok(meta) = std::fs::symlink_metadata(old) else { return Ok(false) };
    if !meta.is_file() { return Err("not_a_file"); }
    if std::fs::symlink_metadata(new).is_err() {
        let bytes = std::fs::read(old).map_err(|_| "read_failed")?;
        std::fs::create_dir_all(new.parent().ok_or("no_parent")?).map_err(|_| "create_failed")?;
        let temporary = new.with_extension(format!("{}.moving", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, &bytes).map_err(|_| "write_failed")?;
        if std::fs::read(&temporary).ok().as_deref() != Some(bytes.as_slice()) {
            let _ = std::fs::remove_file(&temporary);
            return Err("verify_failed");
        }
        std::fs::rename(&temporary, new).map_err(|_| "rename_failed")?;
    }
    std::fs::remove_file(old).map_err(|_| "delete_failed")?;
    Ok(true)
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return true; } // FILE_ATTRIBUTE_REPARSE_POINT
    }
    meta.file_type().is_symlink()
}

/// Remove a file or folder without following links. A link itself is refused.
fn remove_entry(path: &Path) -> Result<(), &'static str> {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Ok(()) };
    if is_link(&meta) { return Err("reparse_point"); }
    if meta.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) }.map_err(|_| "delete_failed")
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PendingWipe {
    #[serde(default)]
    node: bool,
}

/// Delete what an earlier session asked for. The marker goes only after every step worked.
fn run_pending_wipe(roaming: &Path) -> Result<(), &'static str> {
    let marker = roaming.join(PENDING_WIPE);
    let Ok(raw) = std::fs::read(&marker) else { return Ok(()) };
    let wipe: PendingWipe = serde_json::from_slice(&raw).unwrap_or_default();
    if wipe.node {
        let node_folders = ["node-identity", "node-encryption"]
            .iter()
            .filter_map(|name| crate::checkpoint::folder_path(name).ok())
            .collect::<Vec<_>>();
        wipe_node(roaming, &node_folders)?;
    }
    std::fs::remove_file(&marker).map_err(|_| "delete_failed")
}

/// Personal Node records, works, received music and the node keys.
fn wipe_node(roaming: &Path, key_folders: &[PathBuf]) -> Result<(), &'static str> {
    let state = roaming.join("personal-node.json");
    let default_storage = roaming.join("data");
    let storage = std::fs::read(&state).ok()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.get("storagePath")?.as_str().map(PathBuf::from))
        .unwrap_or_else(|| default_storage.clone());
    if storage == default_storage {
        remove_entry(&default_storage)?;
    } else if std::fs::symlink_metadata(&storage).is_ok_and(|meta| meta.is_dir() && !is_link(&meta)) {
        for name in NODE_ENTRIES { remove_entry(&storage.join(name))?; }
    }
    for folder in key_folders { remove_entry(folder)?; }
    remove_entry(&state)
}

fn main_window(window: &tauri::Webview) -> Result<(), String> {
    if window.label() != "main" { return Err("native_window_required".into()); }
    crate::native_pi(window)
}

/// Ask for a wipe at the next start. Only "node" is deferred; the other kinds are
/// deleted at once by their own commands.
#[tauri::command]
pub fn local_data_schedule_wipe(window: tauri::Webview, kinds: Vec<String>) -> Result<(), String> {
    main_window(&window)?;
    if kinds.is_empty() || kinds.iter().any(|kind| kind != "node") { return Err("local_data_kind_unknown".into()); }
    let roaming = roaming_hub_dir().ok_or("local_data_unavailable")?;
    std::fs::create_dir_all(&roaming).map_err(|_| "local_data_unavailable")?;
    let raw = serde_json::to_vec(&PendingWipe { node: true }).map_err(|_| "local_data_unavailable")?;
    crate::browser_bookmarks::write_atomic(&roaming.join(PENDING_WIPE), &raw).map_err(|_| "local_data_unavailable".into())
}

#[tauri::command]
pub fn local_data_restart(window: tauri::Webview, app: tauri::AppHandle) -> Result<(), String> {
    main_window(&window)?;
    app.restart()
}

/// Delete the wallet key from the credential store. The window shows the backup
/// warning first; this repeats the typed word so no other path can delete it.
#[tauri::command]
pub fn wallet_delete_key(window: tauri::Webview, confirmation: String, backed_up: bool) -> Result<(), String> {
    main_window(&window)?;
    if !backed_up || confirmation.trim() != WALLET_CONFIRMATION { return Err("wallet_delete_not_confirmed".into()); }
    crate::desktop_wallet::destroy_wallet()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hub-local-data-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn moving_copies_verifies_deletes_and_can_repeat() {
        let root = temp();
        let (from, to) = (root.join("Roaming"), root.join("Local"));
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("browser-history.json"), b"[{\"url\":\"https://a.example/\"}]").unwrap();
        std::fs::write(from.join("browser-session.json"), b"old-session").unwrap();
        // A crash after copying the session left the new file; the new one wins.
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(to.join("browser-session.json"), b"new-session").unwrap();
        let results = move_files(&from, &to, MOVED_TO_LOCAL);
        assert!(results.iter().all(|(_, result)| result.is_ok()));
        assert_eq!(std::fs::read(to.join("browser-history.json")).unwrap(), b"[{\"url\":\"https://a.example/\"}]");
        assert_eq!(std::fs::read(to.join("browser-session.json")).unwrap(), b"new-session");
        for name in MOVED_TO_LOCAL { assert!(!from.join(name).exists(), "{name}"); }
        assert!(std::fs::read_dir(&to).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().ends_with(".moving")));
        // Second run: nothing left to move, nothing changes.
        assert!(move_files(&from, &to, MOVED_TO_LOCAL).iter().all(|(_, result)| *result == Ok(false)));
        assert_eq!(std::fs::read(to.join("browser-history.json")).unwrap(), b"[{\"url\":\"https://a.example/\"}]");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn pending_node_wipe_removes_default_storage_keys_and_state_only() {
        let roaming = temp();
        std::fs::create_dir_all(roaming.join("data").join("events")).unwrap();
        std::fs::write(roaming.join("data").join("chain.json"), b"{}").unwrap();
        std::fs::write(roaming.join("personal-node.json"), b"{}").unwrap();
        std::fs::write(roaming.join("browser-favorites.json"), b"[]").unwrap();
        let keys = roaming.join("node-identity");
        std::fs::create_dir_all(&keys).unwrap();
        std::fs::write(roaming.join(PENDING_WIPE), b"{\"node\":false}").unwrap();
        run_pending_wipe(&roaming).unwrap();
        assert!(roaming.join("data").exists(), "a marker without node keeps node data");
        wipe_node(&roaming, std::slice::from_ref(&keys)).unwrap();
        assert!(!roaming.join("data").exists());
        assert!(!roaming.join("personal-node.json").exists());
        assert!(!keys.exists());
        assert!(roaming.join("browser-favorites.json").exists());
        std::fs::remove_dir_all(roaming).ok();
    }

    #[test]
    fn custom_node_storage_loses_only_node_entries() {
        let roaming = temp();
        let custom = temp();
        std::fs::create_dir_all(custom.join("artifacts")).unwrap();
        std::fs::write(custom.join("chain.json"), b"{}").unwrap();
        std::fs::write(custom.join("my-notes.txt"), b"keep").unwrap();
        let state = serde_json::json!({ "storagePath": custom.to_string_lossy() });
        std::fs::write(roaming.join("personal-node.json"), serde_json::to_vec(&state).unwrap()).unwrap();
        wipe_node(&roaming, &[]).unwrap();
        assert!(!custom.join("artifacts").exists() && !custom.join("chain.json").exists());
        assert!(custom.join("my-notes.txt").exists());
        std::fs::remove_dir_all(roaming).ok();
        std::fs::remove_dir_all(custom).ok();
    }
}
