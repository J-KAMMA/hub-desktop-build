//! Local bookmark lists; callers serialize mutations and publish them only after `write` succeeds.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub const MAX_ITEMS: usize = 1000;
pub const MAX_BYTES: usize = 1024 * 1024;
/// Local store only (icons included); export/import stay at MAX_BYTES and carry no icons.
pub const STORE_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Icon budget inside the store so a full library of icons cannot make writes fail.
const ICON_BUDGET: usize = 6 * 1024 * 1024;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Favorite {
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub folder: String,
    /// WebView2 が読み込んだファビコン（bounded PNG data URL）。旧ファイルには無い。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Library {
    pub version: u8,
    pub items: Vec<Favorite>,
}

impl Favorite {
    pub fn new(url: &str, title: &str, folder: &str) -> Result<Self, String> {
        if url.len() > 4096 || url.chars().any(char::is_control) {
            return Err("bookmark_url_invalid".into());
        }
        let raw = url.trim();
        let parsed = tauri::Url::parse(raw).map_err(|_| "bookmark_url_invalid")?;
        let authority = raw
            .split_once("://")
            .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default());
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || authority.map_or(true, |value| value.contains('@'))
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.as_str().len() > 4096
        {
            return Err("bookmark_url_invalid".into());
        }
        Ok(Self {
            url: parsed.to_string(),
            title: text(title, 300, "bookmark_title_invalid")?,
            folder: text(folder, 80, "bookmark_folder_invalid")?,
            icon: None,
        })
    }

    /// Keep an icon only if it is a bounded PNG data URL; anything else is dropped silently.
    pub fn with_icon(mut self, icon: Option<&str>) -> Self {
        self.icon = icon.filter(|value| crate::browser_favicon::is_valid_data_url(value)).map(str::to_owned);
        self
    }
}

fn text(value: &str, limit: usize, error: &str) -> Result<String, String> {
    if value.chars().count() > limit || value.chars().any(char::is_control) {
        return Err(error.into());
    }
    Ok(value.trim().to_owned())
}

fn validated(items: &[Favorite]) -> Result<Vec<Favorite>, String> {
    if items.len() > MAX_ITEMS {
        return Err("bookmark_limit_exceeded".into());
    }
    items
        .iter()
        .map(|item| Favorite::new(&item.url, &item.title, &item.folder).map(|clean| clean.with_icon(item.icon.as_deref())))
        .collect()
}

/// Update metadata without changing order; prepend a new URL. Errors leave the list unchanged.
pub fn update(
    items: &mut Vec<Favorite>,
    url: &str,
    title: &str,
    folder: &str,
) -> Result<(), String> {
    let mut item = Favorite::new(url, title, folder)?;
    let mut next = validated(items)?;
    if let Some(existing) = next.iter_mut().find(|entry| entry.url == item.url) {
        item.icon = existing.icon.take();
        *existing = item;
    } else {
        if next.len() == MAX_ITEMS {
            return Err("bookmark_limit_exceeded".into());
        }
        next.insert(0, item);
    }
    *items = next;
    Ok(())
}

/// Attach a newer icon to the bookmark at `url`. Ok(true) only when the stored icon changed;
/// an invalid icon, an unknown URL or an exhausted icon budget leaves the list as it was.
pub fn set_icon(items: &mut [Favorite], url: &str, icon: &str) -> Result<bool, String> {
    let url = Favorite::new(url, "", "")?.url;
    if !crate::browser_favicon::is_valid_data_url(icon) { return Ok(false); }
    let used: usize = items.iter().filter(|item| item.url != url).filter_map(|item| item.icon.as_ref()).map(String::len).sum();
    if used + icon.len() > ICON_BUDGET { return Ok(false); }
    let Some(item) = items.iter_mut().find(|item| item.url == url) else { return Ok(false) };
    if item.icon.as_deref() == Some(icon) { return Ok(false); }
    item.icon = Some(icon.to_owned());
    Ok(true)
}

/// Position is a zero-based index in the resulting list, never a clamped insertion offset.
pub fn move_item(items: &mut Vec<Favorite>, url: &str, position: usize) -> Result<(), String> {
    let url = Favorite::new(url, "", "")?.url;
    let mut next = validated(items)?;
    if position >= next.len() {
        return Err("bookmark_position_invalid".into());
    }
    let index = next
        .iter()
        .position(|item| item.url == url)
        .ok_or("bookmark_not_found")?;
    let item = next.remove(index);
    next.insert(position, item);
    *items = next;
    Ok(())
}

/// Accept the version 1 export or the original array of `{url,title}` objects.
pub fn parse_import(input: &str) -> Result<Vec<Favorite>, String> {
    let mut items = parse(input, MAX_BYTES)?;
    items.iter_mut().for_each(|item| item.icon = None);
    Ok(items)
}

fn parse(input: &str, limit: usize) -> Result<Vec<Favorite>, String> {
    if input.len() > limit {
        return Err("bookmark_file_too_large".into());
    }
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Import {
        Library(Library),
        Legacy(Vec<Favorite>),
    }
    let items = match serde_json::from_str::<Import>(input).map_err(|_| "bookmark_file_invalid")? {
        Import::Library(library) if library.version == 1 => library.items,
        Import::Library(_) => return Err("bookmark_version_unsupported".into()),
        Import::Legacy(items) => items,
    };
    validated(&items)
}

/// Keep existing metadata and order, appending only new canonical URLs; validate before mutation.
pub fn merge(items: &mut Vec<Favorite>, incoming: &[Favorite]) -> Result<usize, String> {
    let mut next = validated(items)?;
    let incoming = validated(incoming)?;
    let before = next.len();
    let mut known: HashSet<String> = next.iter().map(|item| item.url.clone()).collect();
    next.extend(
        incoming
            .into_iter()
            .filter(|item| known.insert(item.url.clone())),
    );
    if next.len() > MAX_ITEMS {
        return Err("bookmark_limit_exceeded".into());
    }
    let added = next.len() - before;
    *items = next;
    Ok(added)
}

/// Export carries no icons: they are a local cache of what the webview already loaded.
pub fn encode_export(items: &[Favorite]) -> Result<String, String> {
    let mut items = validated(items)?;
    items.iter_mut().for_each(|item| item.icon = None);
    encode(items, MAX_BYTES)
}

fn encode(items: Vec<Favorite>, limit: usize) -> Result<String, String> {
    let library = Library { version: 1, items };
    let encoded = serde_json::to_string(&library).map_err(|_| "bookmark_encode_failed")?;
    if encoded.len() > limit {
        return Err("bookmark_file_too_large".into());
    }
    Ok(encoded)
}

/// A missing file is an empty library. Other I/O errors and malformed data fail closed.
pub fn read(path: &Path) -> Result<Vec<Favorite>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("bookmark_read_failed".into()),
    };
    let mut input = String::new();
    file.take(STORE_MAX_BYTES as u64 + 1)
        .read_to_string(&mut input)
        .map_err(|_| "bookmark_read_failed")?;
    parse(&input, STORE_MAX_BYTES)
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Flush a fresh sibling, then atomically replace the destination without deleting it first.
pub fn write(path: &Path, items: &[Favorite]) -> Result<(), String> {
    let encoded = encode(validated(items)?, STORE_MAX_BYTES)?;
    write_atomic(path, encoded.as_bytes())
}

/// Flush and replace a caller-validated local browser file. Does not parse or truncate bytes.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path.file_name().ok_or("bookmark_path_invalid")?;
    fs::create_dir_all(parent).map_err(|_| "bookmark_write_failed")?;
    let (temporary, mut file) = (0..16)
        .find_map(|_| {
            let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let mut temp_name = name.to_os_string();
            temp_name.push(format!(".{}.{}.tmp", std::process::id(), id));
            let temporary = parent.join(temp_name);
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
            {
                Ok(file) => Some(Ok((Temporary(temporary), file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(_) => Some(Err("bookmark_write_failed")),
            }
        })
        .unwrap_or(Err("bookmark_write_failed"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "bookmark_write_failed")?;
    drop(file);
    replace(&temporary.0, path).map_err(|_| "bookmark_replace_failed")?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "bookmark_sync_failed")?;
    Ok(())
}

#[cfg(not(windows))]
fn replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(index: usize) -> Favorite {
        Favorite::new(&format!("https://example.org/{index}"), "title", "folder").unwrap()
    }
    fn full() -> Vec<Favorite> {
        (0..MAX_ITEMS).map(item).collect()
    }

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "hub-bookmark-test-{}-{}-{}",
                std::process::id(),
                timestamp,
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> PathBuf {
            self.0.join("bookmarks.json")
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn canonical_urls_and_legacy_round_trip() {
        let parsed =
            parse_import(r#"[{"url":"HTTPS://EXAMPLE.ORG:443","title":" old "}]"#).unwrap();
        assert_eq!(
            parsed[0],
            Favorite::new("https://example.org/", "old", "").unwrap()
        );
        let encoded = encode_export(&parsed).unwrap();
        assert_eq!(
            serde_json::from_str::<Library>(&encoded).unwrap().version,
            1
        );
        assert_eq!(parse_import(&encoded).unwrap(), parsed);
        assert!(Favorite::new("http://[::1]:3020/path?q=x#hash", "", "").is_ok());
    }

    #[test]
    fn credentials_controls_and_non_network_urls_fail() {
        for url in [
            "https://user@example.org",
            "https://user:password@example.org",
            "https://@example.org",
            "https://:password@example.org",
            "file:///tmp/a",
            "javascript:alert(1)",
            "https:example.org",
            "https://",
            "https://exa\nmple.org",
        ] {
            assert!(Favorite::new(url, "", "").is_err(), "{url}");
        }
        for control in ['\0', '\n', '\t', '\u{7f}', '\u{85}'] {
            assert!(Favorite::new("https://example.org", &format!("a{control}"), "").is_err());
            assert!(Favorite::new("https://example.org", "", &format!("a{control}")).is_err());
        }
    }

    #[test]
    fn character_and_byte_boundaries() {
        assert!(Favorite::new("https://example.org", &"あ".repeat(300), &"あ".repeat(80)).is_ok());
        assert!(Favorite::new("https://example.org", &"a".repeat(301), "").is_err());
        assert!(Favorite::new("https://example.org", "", &"a".repeat(81)).is_err());
        let prefix = "https://example.org/";
        assert!(Favorite::new(
            &format!("{prefix}{}", "a".repeat(4096 - prefix.len())),
            "",
            ""
        )
        .is_ok());
        assert!(Favorite::new(
            &format!("{prefix}{}", "a".repeat(4097 - prefix.len())),
            "",
            ""
        )
        .is_err());
        assert!(Favorite::new(&format!("{prefix}{}", "あ".repeat(1000)), "", "").is_err());
    }

    #[test]
    fn import_limits_versions_and_full_validation() {
        assert_eq!(
            parse_import(&format!("[]{}", " ".repeat(MAX_BYTES - 2))).unwrap(),
            Vec::new()
        );
        assert!(parse_import(&format!("[]{}", " ".repeat(MAX_BYTES - 1))).is_err());
        assert!(parse_import(r#"{"version":2,"items":[]}"#).is_err());
        assert!(parse_import(r#"{"version":1,"items":null}"#).is_err());
        assert!(parse_import("[] trailing").is_err());
        assert!(parse_import(
            r#"[{"url":"https://example.org","title":"ok"},{"url":"file:///secret","title":"bad"}]"#
        )
        .is_err());
        assert_eq!(
            parse_import(&serde_json::to_string(&full()).unwrap())
                .unwrap()
                .len(),
            MAX_ITEMS
        );
        assert!(parse_import(
            &serde_json::to_string(&(0..=MAX_ITEMS).map(item).collect::<Vec<_>>()).unwrap()
        )
        .is_err());
    }

    #[test]
    fn update_and_move_are_bounded_and_preserve_order() {
        let mut items = vec![item(0), item(1), item(2)];
        update(&mut items, &item(1).url, "renamed", "new folder").unwrap();
        assert_eq!(
            items
                .iter()
                .map(|entry| entry.url.clone())
                .collect::<Vec<_>>(),
            (0..3).map(|i| item(i).url).collect::<Vec<_>>()
        );
        assert_eq!(items[1].title, "renamed");
        move_item(&mut items, &item(0).url, 2).unwrap();
        assert_eq!(items[2].url, item(0).url);
        move_item(&mut items, &item(0).url, 0).unwrap();
        assert_eq!(items[0].url, item(0).url);
        let before = items.clone();
        for position in [items.len(), usize::MAX] {
            assert!(move_item(&mut items, &item(0).url, position).is_err());
        }
        assert!(move_item(&mut items, &item(99).url, 0).is_err());
        assert!(update(&mut items, "https://example.org", "bad\n", "").is_err());
        assert_eq!(items, before);
        assert!(move_item(&mut Vec::new(), &item(0).url, 0).is_err());
        let mut items = full();
        update(&mut items, &item(0).url, "changed", "").unwrap();
        let before = items.clone();
        assert!(update(&mut items, &item(MAX_ITEMS).url, "", "").is_err());
        assert_eq!(items, before);
    }

    #[test]
    fn merge_preserves_existing_and_rejects_partial_mutation() {
        let mut items = vec![item(0)];
        let changed = Favorite::new(&item(0).url, "replace?", "replace?").unwrap();
        assert_eq!(merge(&mut items, &[changed, item(1), item(1)]).unwrap(), 1);
        assert_eq!(items, vec![item(0), item(1)]);
        let before = items.clone();
        let invalid = Favorite {
            url: "file:///bad".into(),
            title: "".into(),
            folder: "".into(),
            icon: None,
        };
        assert!(merge(&mut items, &[item(2), invalid]).is_err());
        assert_eq!(items, before);
        let mut items = full();
        let before = items.clone();
        assert_eq!(merge(&mut items, &[item(0)]).unwrap(), 0);
        assert!(merge(&mut items, &[item(MAX_ITEMS), item(MAX_ITEMS + 1)]).is_err());
        assert_eq!(items, before);
    }

    fn icon() -> String {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend([1, 2, 3, 4]);
        crate::browser_favicon::png_data_url(&bytes).unwrap()
    }

    #[test]
    fn old_files_without_icon_load_and_icons_round_trip_in_the_store() {
        let dir = TestDirectory::new();
        let path = dir.path();
        fs::write(&path, r#"{"version":1,"items":[{"url":"https://example.org/","title":"old","folder":"f"}]}"#).unwrap();
        let mut items = read(&path).unwrap();
        assert_eq!(items, vec![Favorite::new("https://example.org/", "old", "f").unwrap()]);
        assert!(items[0].icon.is_none());
        assert!(set_icon(&mut items, "https://example.org/", &icon()).unwrap());
        assert!(!set_icon(&mut items, "https://example.org/", &icon()).unwrap());
        write(&path, &items).unwrap();
        assert_eq!(read(&path).unwrap()[0].icon.as_deref(), Some(icon().as_str()));
        update(&mut items, "https://example.org/", "renamed", "f").unwrap();
        assert_eq!(items[0].icon.as_deref(), Some(icon().as_str()));
        let mut legacy = vec![Favorite::new("https://example.org/", "old", "").unwrap()];
        write(&path, &legacy).unwrap();
        assert!(!fs::read_to_string(&path).unwrap().contains("icon"));
        legacy.clear();
    }

    #[test]
    fn invalid_icons_are_dropped_and_export_import_carry_none() {
        let mut items = vec![Favorite::new("https://example.org/", "t", "").unwrap()];
        for bad in ["data:image/svg+xml;base64,PHN2Zy8+", "https://example.org/i.png", "data:image/png;base64,bm90IGEgcG5n"] {
            assert!(!set_icon(&mut items, "https://example.org/", bad).unwrap());
        }
        assert!(!set_icon(&mut items, "https://other.example/", &icon()).unwrap());
        assert!(items[0].icon.is_none());
        let tainted = Favorite { icon: Some("javascript:alert(1)".into()), ..items[0].clone() };
        assert!(merge(&mut items, &[tainted.clone()]).is_ok() && items[0].icon.is_none());
        assert!(validated(&[tainted]).unwrap()[0].icon.is_none());
        items[0].icon = Some(icon());
        assert!(!encode_export(&items).unwrap().contains("icon"));
        let imported = parse_import(&format!(r#"{{"version":1,"items":[{{"url":"https://example.org/","title":"","icon":"{}"}}]}}"#, icon())).unwrap();
        assert!(imported[0].icon.is_none());
    }

    #[test]
    fn oversized_export_is_rejected() {
        let items: Vec<_> = (0..MAX_ITEMS)
            .map(|i| {
                Favorite::new(
                    &format!("https://example.org/{i}/{}", "a".repeat(1500)),
                    "",
                    "",
                )
                .unwrap()
            })
            .collect();
        assert!(encode_export(&items).is_err());
    }

    #[test]
    fn durable_write_replaces_legacy_and_corruption_fails_closed() {
        let dir = TestDirectory::new();
        let path = dir.path();
        assert!(read(&path).unwrap().is_empty());
        fs::write(&path, r#"[{"url":"https://example.org","title":"legacy"}]"#).unwrap();
        assert_eq!(read(&path).unwrap()[0].folder, "");
        write(&path, &[item(0)]).unwrap();
        write(&path, &[item(1), item(2)]).unwrap();
        assert_eq!(read(&path).unwrap(), vec![item(1), item(2)]);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        let before = fs::read(&path).unwrap();
        let invalid = Favorite {
            url: "file:///bad".into(),
            title: "".into(),
            folder: "".into(),
            icon: None,
        };
        assert!(write(&path, &[invalid]).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::write(&path, b"broken").unwrap();
        assert!(read(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::write(&path, vec![b' '; MAX_BYTES + 1]).unwrap();
        assert!(read(&path).is_err());
    }

    #[test]
    fn failed_replacement_cleans_owned_temporary_only() {
        let dir = TestDirectory::new();
        let path = dir.path();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), "original").unwrap();
        assert!(write(&path, &[item(0)]).is_err());
        assert_eq!(fs::read_to_string(path.join("keep")).unwrap(), "original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        assert!(read(&path).is_err());
    }
}
