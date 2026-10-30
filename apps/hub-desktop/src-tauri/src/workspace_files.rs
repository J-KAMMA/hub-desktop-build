use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

const MAX_READ_BYTES: u64 = 1_048_576;
const MAX_VISITED_FILES: usize = 5_000;
const MAX_RESULTS: usize = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadResult {
    pub relative_path: String,
    pub content: String,
    pub size_bytes: u64,
    pub sha256: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub relative_path: String,
    pub excerpt: String,
    pub size_bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffPreview {
    pub relative_path: String,
    pub previous_sha256: Option<String>,
    pub next_sha256: String,
    pub previous_lines: usize,
    pub next_lines: usize,
    pub changed: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRevision {
    pub id: String,
    pub relative_path: String,
    pub sha256: Option<String>,
    pub created_at_ms: u128,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub relative_path: String,
    pub sha256: String,
    pub revision: FileRevision,
}

pub fn read(root: &Path, relative: &str) -> Result<FileReadResult, &'static str> {
    let path = resolve_existing_file(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|_| "file_unavailable")?;
    if metadata.len() > MAX_READ_BYTES {
        return Err("file_too_large");
    }
    let bytes = fs::read(&path).map_err(|_| "file_unavailable")?;
    let sha256 = hash(&bytes);
    let content = String::from_utf8(bytes).map_err(|_| "text_file_required")?;
    Ok(FileReadResult {
        relative_path: relative_string(root, &path)?,
        content,
        size_bytes: metadata.len(),
        sha256,
    })
}

pub fn search(root: &Path, query: &str) -> Result<Vec<FileSearchResult>, &'static str> {
    let query = query.trim().to_lowercase();
    if query.is_empty() || query.chars().count() > 200 {
        return Err("invalid_query");
    }
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0usize;
    let mut results = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|_| "workspace_unavailable")? {
            let entry = entry.map_err(|_| "workspace_unavailable")?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| "workspace_unavailable")?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if path
                    .file_name()
                    .is_some_and(|name| name == ".hub-local-runner")
                {
                    continue;
                }
                pending.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            visited += 1;
            if visited > MAX_VISITED_FILES {
                return Err("workspace_too_large");
            }
            if metadata.len() > MAX_READ_BYTES {
                continue;
            }
            let relative = relative_string(root, &path)?;
            let name_match = relative.to_lowercase().contains(&query);
            let bytes = fs::read(&path).map_err(|_| "file_unavailable")?;
            let Ok(content) = String::from_utf8(bytes) else {
                continue;
            };
            let lower = content.to_lowercase();
            let position = lower.find(&query);
            if name_match || position.is_some() {
                let start = position.unwrap_or(0).saturating_sub(120);
                let excerpt: String = content.chars().skip(start).take(360).collect();
                results.push(FileSearchResult {
                    relative_path: relative,
                    excerpt,
                    size_bytes: metadata.len(),
                });
                if results.len() >= MAX_RESULTS {
                    return Ok(results);
                }
            }
        }
    }
    Ok(results)
}

pub fn preview(root: &Path, relative: &str, next: &str) -> Result<FileDiffPreview, &'static str> {
    if next.len() as u64 > MAX_READ_BYTES {
        return Err("file_too_large");
    }
    let candidate = resolve_candidate(root, relative)?;
    let previous = if candidate.exists() {
        Some(read(root, relative)?)
    } else {
        None
    };
    let next_hash = hash(next.as_bytes());
    Ok(FileDiffPreview {
        relative_path: normalize_relative(relative)?,
        previous_sha256: previous.as_ref().map(|item| item.sha256.clone()),
        next_sha256: next_hash.clone(),
        previous_lines: previous
            .as_ref()
            .map(|item| item.content.lines().count())
            .unwrap_or(0),
        next_lines: next.lines().count(),
        changed: previous
            .as_ref()
            .is_none_or(|item| item.sha256 != next_hash),
    })
}

pub fn write(
    root: &Path,
    relative: &str,
    next: &str,
    expected_previous: Option<&str>,
    expected_next: &str,
) -> Result<FileWriteResult, &'static str> {
    let preview = preview(root, relative, next)?;
    if preview.previous_sha256.as_deref() != expected_previous
        || preview.next_sha256 != expected_next
    {
        return Err("file_changed_since_preview");
    }
    let candidate = resolve_candidate(root, relative)?;
    let revision = archive_current(root, relative, &candidate, preview.previous_sha256.clone())?;
    let temporary = candidate.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "file_write_failed")?;
    file.write_all(next.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "file_write_failed")?;
    atomic_replace(&temporary, &candidate)?;
    Ok(FileWriteResult {
        relative_path: normalize_relative(relative)?,
        sha256: expected_next.to_owned(),
        revision,
    })
}

pub fn revisions(root: &Path, relative: &str) -> Result<Vec<FileRevision>, &'static str> {
    let normalized = normalize_relative(relative)?;
    let directory = revision_directory(root, &normalized);
    let Ok(entries) = fs::read_dir(directory) else {
        return Ok(Vec::new());
    };
    let mut items = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let (milliseconds, id) = name.strip_suffix(".json")?.split_once('-')?;
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(entry.path()).ok()?).ok()?;
            Some(FileRevision {
                id: id.into(),
                relative_path: normalized.clone(),
                sha256: value
                    .get("sha256")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned),
                created_at_ms: milliseconds.parse().ok()?,
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    items.truncate(20);
    Ok(items)
}

pub fn restore(
    root: &Path,
    relative: &str,
    revision_id: &str,
    expected_current: Option<&str>,
) -> Result<FileWriteResult, &'static str> {
    let content = revision_content(root, relative, revision_id)?;
    let normalized = normalize_relative(relative)?;
    let next_hash = hash(content.as_bytes());
    write(root, &normalized, &content, expected_current, &next_hash)
}

pub fn revision_content(
    root: &Path,
    relative: &str,
    revision_id: &str,
) -> Result<String, &'static str> {
    uuid::Uuid::parse_str(revision_id).map_err(|_| "invalid_revision")?;
    let normalized = normalize_relative(relative)?;
    let directory = revision_directory(root, &normalized);
    let entry = fs::read_dir(&directory)
        .map_err(|_| "revision_unavailable")?
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(&format!("-{revision_id}.json"))
        })
        .ok_or("revision_unavailable")?;
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(entry.path()).map_err(|_| "revision_unavailable")?)
            .map_err(|_| "revision_unavailable")?;
    Ok(value
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned())
}

fn archive_current(
    root: &Path,
    relative: &str,
    candidate: &Path,
    sha256: Option<String>,
) -> Result<FileRevision, &'static str> {
    let id = uuid::Uuid::new_v4().to_string();
    let created_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "clock_unavailable")?
        .as_millis();
    let content = if candidate.exists() {
        String::from_utf8(fs::read(candidate).map_err(|_| "file_unavailable")?)
            .map_err(|_| "text_file_required")?
    } else {
        String::new()
    };
    let directory = revision_directory(root, relative);
    fs::create_dir_all(&directory).map_err(|_| "revision_write_failed")?;
    let data = serde_json::to_vec(&serde_json::json!({"sha256":sha256,"content":content}))
        .map_err(|_| "revision_write_failed")?;
    fs::write(directory.join(format!("{created_at_ms}-{id}.json")), data)
        .map_err(|_| "revision_write_failed")?;
    prune_revisions(&directory, MAX_REVISIONS_PER_FILE);
    exclude_revisions_from_git(root);
    Ok(FileRevision {
        id,
        relative_path: relative.into(),
        sha256,
        created_at_ms,
    })
}

/// Earlier versions kept per file (decided 2026-10-18); the oldest go first.
pub(crate) const MAX_REVISIONS_PER_FILE: usize = 20;

/// Keep the newest `keep` revisions (`<created_at_ms>-<uuid>.json`) in one file's folder.
fn prune_revisions(directory: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(directory) else { return };
    let mut revisions: Vec<(u128, String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_owned();
            let (stamp, rest) = name.strip_suffix(".json")?.split_once('-')?;
            uuid::Uuid::parse_str(rest).ok()?;
            let metadata = fs::symlink_metadata(entry.path()).ok()?;
            metadata.is_file().then_some(())?;
            Some((stamp.parse().ok()?, name, entry.path()))
        })
        .collect();
    if revisions.len() <= keep { return; }
    revisions.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, _, path) in revisions.split_off(keep) {
        let _ = fs::remove_file(path);
    }
}

/// Add `.hub-local-runner/` to the workspace's `.git/info/exclude` so earlier
/// versions are never committed. Only a real `.git` folder is changed: a `.git`
/// file or a link could point anywhere, so those are left alone.
pub(crate) fn exclude_revisions_from_git(root: &Path) {
    const LINE: &str = ".hub-local-runner/";
    let git = root.join(".git");
    let info = git.join("info");
    let exclude = info.join("exclude");
    let real_dir = |path: &Path| fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink());
    if !real_dir(&git) { return; }
    if fs::symlink_metadata(&info).is_ok() && !real_dir(&info) { return; }
    let existing = match fs::symlink_metadata(&exclude) {
        Ok(meta) if meta.is_file() && meta.len() <= 1024 * 1024 => fs::read_to_string(&exclude).unwrap_or_default(),
        Ok(_) => return,
        Err(_) => String::new(),
    };
    if existing.lines().any(|line| matches!(line.trim(), ".hub-local-runner/" | ".hub-local-runner" | "/.hub-local-runner/" | "/.hub-local-runner")) { return; }
    if fs::create_dir_all(&info).is_err() { return; }
    let separator = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    let _ = fs::OpenOptions::new().create(true).append(true).open(&exclude)
        .and_then(|mut file| std::io::Write::write_all(&mut file, format!("{separator}# Hub: earlier versions of files the AI changed\n{LINE}\n").as_bytes()));
}

fn revision_directory(root: &Path, relative: &str) -> PathBuf {
    root.join(".hub-local-runner")
        .join("revisions")
        .join(hash(relative.as_bytes()))
}
#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), &'static str> {
    fs::rename(source, target).map_err(|_| "file_replace_failed")
}
#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), &'static str> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target_wide = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err("file_replace_failed")
    } else {
        Ok(())
    }
}

fn resolve_existing_file(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    let candidate = resolve_candidate(root, relative)?;
    let path = candidate.canonicalize().map_err(|_| "file_unavailable")?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("invalid_path");
    }
    Ok(path)
}
fn resolve_candidate(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    let normalized = normalize_relative(relative)?;
    let parent = root
        .join(&normalized)
        .parent()
        .ok_or("invalid_path")?
        .canonicalize()
        .map_err(|_| "invalid_path")?;
    if !parent.starts_with(root) {
        return Err("invalid_path");
    }
    Ok(root.join(normalized))
}
fn normalize_relative(value: &str) -> Result<String, &'static str> {
    let path = Path::new(value);
    let windows_absolute = value.starts_with("\\\\")
        || value.as_bytes().get(1) == Some(&b':')
            && matches!(value.as_bytes().get(2), Some(b'\\') | Some(b'/'));
    if value.is_empty()
        || path.is_absolute()
        || windows_absolute
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("invalid_path");
    }
    Ok(path.to_string_lossy().replace('\\', "/"))
}
fn relative_string(root: &Path, path: &Path) -> Result<String, &'static str> {
    Ok(path
        .strip_prefix(root)
        .map_err(|_| "invalid_path")?
        .to_string_lossy()
        .replace('\\', "/"))
}
fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revisions_keep_the_newest_twenty_per_file() {
        let root = std::env::temp_dir().join(format!("hub-revisions-{}", uuid::Uuid::new_v4()));
        let directory = root.join("one");
        fs::create_dir_all(&directory).unwrap();
        for stamp in 1..=25u128 {
            fs::write(directory.join(format!("{stamp}-{}.json", uuid::Uuid::new_v4())), b"{}").unwrap();
        }
        fs::write(directory.join("notes.txt"), b"keep").unwrap();
        prune_revisions(&directory, MAX_REVISIONS_PER_FILE);
        let mut stamps: Vec<u128> = fs::read_dir(&directory).unwrap().filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.split_once('-')?.0.parse().ok()).collect();
        stamps.sort();
        assert_eq!(stamps, (6..=25).collect::<Vec<_>>());
        assert!(directory.join("notes.txt").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn writes_cap_revisions_and_exclude_them_from_git() {
        let root = std::env::temp_dir().join(format!("hub-revisions-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".git").join("info")).unwrap();
        fs::write(root.join(".git").join("info").join("exclude"), "# existing\n*.log").unwrap();
        fs::write(root.join("a.txt"), "0").unwrap();
        let root = root.canonicalize().unwrap();
        for step in 1..=23 {
            let current = read(&root, "a.txt").unwrap();
            write(&root, "a.txt", &step.to_string(), Some(&current.sha256), &hash(step.to_string().as_bytes())).unwrap();
        }
        assert_eq!(fs::read_dir(revision_directory(&root, "a.txt")).unwrap().count(), MAX_REVISIONS_PER_FILE);
        let exclude = fs::read_to_string(root.join(".git").join("info").join("exclude")).unwrap();
        assert!(exclude.starts_with("# existing\n*.log\n"));
        assert_eq!(exclude.matches(".hub-local-runner/").count(), 1);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn git_exclude_is_left_alone_without_a_real_git_folder() {
        let root = std::env::temp_dir().join(format!("hub-revisions-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".git"), "gitdir: ../elsewhere").unwrap();
        exclude_revisions_from_git(&root);
        assert_eq!(fs::read_to_string(root.join(".git")).unwrap(), "gitdir: ../elsewhere");
        assert!(!root.join("..").join("elsewhere").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_parent_and_absolute_paths() {
        assert!(normalize_relative("../secret").is_err());
        assert!(normalize_relative("C:\\secret").is_err());
        assert!(normalize_relative("C:/secret").is_err());
        assert!(normalize_relative("\\\\server\\share\\secret").is_err());
        assert!(normalize_relative("src/main.ts").is_ok());
    }
    #[test]
    fn reads_searches_and_previews_inside_workspace() {
        let root = std::env::temp_dir().join(format!("hub-files-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.txt"), "hello world").unwrap();
        let root = root.canonicalize().unwrap();
        assert_eq!(read(&root, "src/a.txt").unwrap().content, "hello world");
        assert_eq!(search(&root, "world").unwrap().len(), 1);
        assert!(preview(&root, "src/a.txt", "changed").unwrap().changed);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn writes_with_hash_recheck_and_restores_revision() {
        let root = std::env::temp_dir().join(format!("hub-write-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.txt"), "before").unwrap();
        let root = root.canonicalize().unwrap();
        let before = hash(b"before");
        let after = hash(b"after");
        let saved = write(&root, "src/a.txt", "after", Some(&before), &after).unwrap();
        assert_eq!(read(&root, "src/a.txt").unwrap().content, "after");
        assert!(write(&root, "src/a.txt", "bad", Some(&before), &hash(b"bad")).is_err());
        restore(&root, "src/a.txt", &saved.revision.id, Some(&after)).unwrap();
        assert_eq!(read(&root, "src/a.txt").unwrap().content, "before");
        fs::remove_dir_all(root).unwrap();
    }
}
