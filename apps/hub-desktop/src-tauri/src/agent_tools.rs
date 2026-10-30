//! Tools operate on an explicitly chosen directory; model output is never a host command.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

/// Largest file Hub reads, observes, edits or writes.
pub const MAX_FILE_BYTES: usize = 1_048_576;
/// Largest file text one read hands back. A larger file, or a requested line
/// range, comes back as a page; Hub still reads and observes the whole file.
pub const MAX_RESULT_BYTES: usize = 32_768;
const MAX_PAGE_LINES: usize = 2_000;
const MAX_FILES: usize = 16;
/// Thin-engine read records (path + SHA-256 only, no content) kept for resume.
const MAX_NATIVE_READS: usize = 1_024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    List,
    Read,
    Write,
    Edit,
    Test,
    Finish,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub kind: Kind,
    pub path: String,
    pub content: String,
    pub summary: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditContent {
    old_text: String,
    new_text: String,
}

fn edit_content(content: &str) -> Result<EditContent, String> {
    let edit: EditContent = serde_json::from_str(content).map_err(|_| "edit_invalid")?;
    if edit.old_text.is_empty()
        || edit.old_text.len() > MAX_FILE_BYTES
        || edit.new_text.len() > MAX_FILE_BYTES
    {
        return Err("edit_invalid".into());
    }
    Ok(edit)
}

impl Action {
    pub fn parse(value: Value) -> Result<Self, String> {
        let mut action: Self = serde_json::from_value(value).map_err(|_| "invalid_action")?;
        if action.path.len() > 240
            || action.content.len() > MAX_FILE_BYTES
            || action.summary.len() > 8_000
        {
            return Err("action_limit_exceeded".into());
        }
        if action.kind == Kind::Test && !matches!(action.path.as_str(), "python" | "javascript") {
            return Err("unsupported_test_language".into());
        }
        if action.kind == Kind::Edit {
            action.content = serde_json::to_string(&edit_content(&action.content)?)
                .map_err(|_| "edit_invalid")?;
        }
        // A read proposal is not an observation, and a finish does not carry
        // file content. Reject replies that put output in the wrong field so
        // the model is told where the answer belongs instead of having it
        // silently dropped. A read summary is still cleared: models annotate
        // reads harmlessly and must not have the annotation replayed as history.
        match action.kind {
            Kind::List | Kind::Read => {
                if !action.content.is_empty() {
                    return Err("unexpected_action_fields".into());
                }
                action.summary.clear();
            }
            Kind::Finish => {
                if !action.path.is_empty() || !action.content.is_empty() {
                    return Err("unexpected_action_fields".into());
                }
            }
            Kind::Write | Kind::Edit | Kind::Test => {}
        }
        Ok(action)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[cfg_attr(test, derive(Debug))]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub before: String,
    pub after: String,
    pub previous_sha256: Option<String>,
    pub sha256: String,
}

#[derive(Default)]
pub struct Files {
    observed: BTreeMap<String, String>,
    /// Thin engine (2026-10-18): path -> SHA-256 of the last full content Hub read or wrote
    /// through `hub_fs`/`hub_fs_write`. Checkpointed as `readObservations`; grants nothing.
    native_reads: BTreeMap<String, String>,
    /// Thin resume: paths the resumed conversation read whose file has changed on disk since.
    /// A native whole-file write to one is refused until a fresh `hub_fs` read.
    stale: BTreeSet<String>,
    change_observer: Option<Arc<dyn Fn(Change) + Send + Sync>>,
}

fn blocked_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with('.')
        || name.ends_with(['.', ' '])
        || matches!(
            name.as_str(),
            "node_modules" | "target" | "credentials" | "secrets" | "id_rsa" | "id_ed25519"
        )
        || [
            ".pem",
            ".key",
            ".p12",
            ".pfx",
            ".keystore",
            ".sqlite",
            ".db",
        ]
        .iter()
        .any(|suffix| name.ends_with(suffix))
        || matches!(
            name.split('.').next().unwrap_or(""),
            "con"
                | "prn"
                | "aux"
                | "nul"
                | "com1"
                | "com2"
                | "com3"
                | "com4"
                | "com5"
                | "com6"
                | "com7"
                | "com8"
                | "com9"
                | "lpt1"
                | "lpt2"
                | "lpt3"
                | "lpt4"
                | "lpt5"
                | "lpt6"
                | "lpt7"
                | "lpt8"
                | "lpt9"
        )
}

pub(crate) fn relative(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 240
        || value.contains(['\\', ':'])
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .any(|part| part.is_empty() || blocked_name(part))
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("path_not_allowed".into());
    }
    Ok(())
}

fn link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

// Check every existing component, including junctions on Windows. Missing parents are not created.
pub(crate) fn checked(root: &Path, value: &Path, missing_leaf: bool) -> Result<PathBuf, String> {
    if root.canonicalize().map_err(|_| "workspace_unavailable")? != root {
        return Err("workspace_changed".into());
    }
    let mut path = root.to_owned();
    for part in value.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err("path_not_allowed".into());
        }
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if link(&metadata) => return Err("linked_path_not_allowed".into()),
            Ok(_) => (),
            Err(error)
                if missing_leaf
                    && error.kind() == std::io::ErrorKind::NotFound
                    && path == root.join(value) =>
            {
                ()
            }
            Err(_) => return Err("path_unavailable".into()),
        }
    }
    Ok(path)
}

pub fn list(root: &Path, directory: &str) -> Result<Value, String> {
    if !directory.is_empty() {
        relative(directory)?;
    }
    let path = checked(root, Path::new(directory), false)?;
    let mut entries: Vec<Value> = fs::read_dir(path)
        .map_err(|_| "directory_unavailable")?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let path = if directory.is_empty() {
                name
            } else {
                format!("{directory}/{name}")
            };
            relative(&path).ok()?;
            // DirEntry::metadata never follows links, same as
            // symlink_metadata, but the enumeration already fetched it.
            let metadata = entry.metadata().ok()?;
            (!link(&metadata) && (metadata.is_dir() || metadata.is_file())).then(|| {
                json!({
                    "path":path, "directory":metadata.is_dir(), "bytes":metadata.len()
                })
            })
        })
        .take(101)
        .collect();
    let truncated = entries.len() > 100;
    entries.truncate(100);
    entries.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(json!({"entries":entries,"truncated":truncated}))
}

pub(crate) fn read_text(
    root: &Path,
    path: &str,
    max_bytes: usize,
) -> Result<crate::workspace_files::FileReadResult, String> {
    relative(path)?;
    let candidate = checked(root, Path::new(path), false)?;
    if fs::metadata(candidate)
        .map_err(|_| "file_unavailable")?
        .len()
        > max_bytes as u64
    {
        return Err("file_too_large".into());
    }
    let result = crate::workspace_files::read(root, path)?;
    if result.content.len() > max_bytes {
        return Err("file_too_large".into());
    }
    Ok(result)
}

impl Files {
    pub fn with_change_observer(observer: Arc<dyn Fn(Change) + Send + Sync>) -> Self {
        Self { change_observer: Some(observer), ..Self::default() }
    }

    fn capacity(&self, path: &str) -> Result<(), String> {
        if self.observed.len() >= MAX_FILES && !self.observed.contains_key(path) {
            return Err("file_count_limit".into());
        }
        Ok(())
    }

    pub fn read(&mut self, root: &Path, path: &str) -> Result<Value, String> {
        self.read_page(root, path, None, None)
    }

    /// Reads and observes the whole file. The answer carries the whole text
    /// when it fits in `MAX_RESULT_BYTES` and no range was asked for;
    /// otherwise one page of lines (`partial: true`, no full content). Either
    /// way the observation is the full file Hub read, so the usual
    /// exact-match edit and staleness checks apply to it unchanged.
    pub fn read_page(
        &mut self,
        root: &Path,
        path: &str,
        start_line: Option<usize>,
        line_count: Option<usize>,
    ) -> Result<Value, String> {
        relative(path)?;
        self.capacity(path)?;
        let result = read_text(root, path, MAX_FILE_BYTES)?;
        let value = if start_line.is_none()
            && line_count.is_none()
            && result.content.len() <= MAX_RESULT_BYTES
        {
            serde_json::to_value(&result).map_err(|_| "file_encoding_failed".to_owned())?
        } else {
            page(&result, start_line.unwrap_or(1), line_count)?
        };
        self.observed.insert(path.to_owned(), result.content);
        Ok(value)
    }

    pub fn preview(&self, root: &Path, path: &str, content: &str) -> Result<Change, String> {
        relative(path)?;
        self.capacity(path)?;
        checked(root, Path::new(path), true)?;
        if content.len() > MAX_FILE_BYTES {
            return Err("file_too_large".into());
        }
        let preview = crate::workspace_files::preview(root, path, content)?;
        let before = match &preview.previous_sha256 {
            Some(hash) => {
                let previous = self
                    .observed
                    .get(path)
                    .ok_or("read_before_write_required")?;
                if &digest(previous.as_bytes()) != hash {
                    return Err("file_changed_since_read".into());
                }
                previous.clone()
            }
            None if self.observed.contains_key(path) => {
                return Err("file_changed_since_read".into())
            }
            None => String::new(),
        };
        Ok(Change {
            path: path.into(),
            before,
            after: content.into(),
            previous_sha256: preview.previous_sha256,
            sha256: preview.next_sha256,
        })
    }

    pub fn preview_edit(&self, root: &Path, path: &str, content: &str) -> Result<Change, String> {
        relative(path)?;
        let edit = edit_content(content)?;
        let before = self
            .observed
            .get(path)
            .ok_or("read_before_write_required")?;
        // Models often send LF text for a CRLF file (or the reverse). When the
        // observed file uses one line ending throughout, both texts are matched
        // and written in that ending; a mixed file keeps exact matching only.
        let (old_text, new_text) = match line_ending(before) {
            Some(ending) => (
                with_line_ending(&edit.old_text, ending),
                with_line_ending(&edit.new_text, ending),
            ),
            None => (edit.old_text.clone(), edit.new_text.clone()),
        };
        // The `preview` below already re-reads the file and refuses a stale
        // observation; a second pass over `before` would only re-check it.
        let Some(first) = before.find(&old_text) else {
            return Err("edit_not_found".into());
        };
        if before.rfind(&old_text) != Some(first) {
            return Err("edit_ambiguous".into());
        }
        if old_text == new_text {
            return Err("edit_no_change".into());
        }
        let edit = EditContent { old_text, new_text };
        let size = before
            .len()
            .checked_sub(edit.old_text.len())
            .and_then(|size| size.checked_add(edit.new_text.len()))
            .ok_or("edit_too_large")?;
        if size > MAX_FILE_BYTES {
            return Err("edit_too_large".into());
        }
        let after = format!(
            "{}{}{}",
            &before[..first],
            edit.new_text,
            &before[first + edit.old_text.len()..]
        );
        self.preview(root, path, &after)
    }

    pub fn write(&mut self, root: &Path, change: &Change) -> Result<Value, String> {
        let current = self.preview(root, &change.path, &change.after)?;
        if current.previous_sha256 != change.previous_sha256
            || current.before != change.before
            || current.sha256 != change.sha256
        {
            return Err("file_changed_since_approval".into());
        }
        check_archive(root, &change.path)?;
        let result = crate::workspace_files::write(
            root,
            &change.path,
            &change.after,
            change.previous_sha256.as_deref(),
            &change.sha256,
        )?;
        self.observed
            .insert(change.path.clone(), change.after.clone());
        if let Some(observer) = &self.change_observer {
            // Observation cannot turn a completed write into a failed tool call
            // or poison the executor's file mutex. Observers only record changes.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(change.clone())));
        }
        Ok(json!({"path":result.relative_path,"sha256":result.sha256}))
    }

    /// Thin engine (Pi's native write/edit): a whole-file write without the
    /// read-before-write observation. The current file is read from disk now,
    /// so the approval preview, the revision archive and undo still see the real
    /// previous content, and the write re-checks that hash (compare-and-swap).
    pub fn preview_native(&self, root: &Path, path: &str, content: &str) -> Result<Change, String> {
        relative(path)?;
        checked(root, Path::new(path), true)?;
        if content.len() > MAX_FILE_BYTES {
            return Err("file_too_large".into());
        }
        let preview = crate::workspace_files::preview(root, path, content)?;
        let before = match &preview.previous_sha256 {
            Some(hash) => {
                let current = read_text(root, path, MAX_FILE_BYTES)?.content;
                if &digest(current.as_bytes()) != hash {
                    return Err("file_changed_since_read".into());
                }
                current
            }
            None => String::new(),
        };
        Ok(Change {
            path: path.into(),
            before,
            after: content.into(),
            previous_sha256: preview.previous_sha256,
            sha256: preview.next_sha256,
        })
    }

    pub fn write_native(&mut self, root: &Path, change: &Change) -> Result<Value, String> {
        let current = self.preview_native(root, &change.path, &change.after)?;
        if current.previous_sha256 != change.previous_sha256 || current.sha256 != change.sha256 {
            return Err("file_changed_since_approval".into());
        }
        check_archive(root, &change.path)?;
        let result = crate::workspace_files::write(
            root,
            &change.path,
            &change.after,
            change.previous_sha256.as_deref(),
            &change.sha256,
        )?;
        if self.observed.contains_key(&change.path) || self.observed.len() < MAX_FILES {
            self.observed.insert(change.path.clone(), change.after.clone());
        }
        self.record_native(&change.path, change.sha256.clone());
        if let Some(observer) = &self.change_observer {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(change.clone())));
        }
        Ok(json!({"path":result.relative_path,"sha256":result.sha256}))
    }

    /// Path → SHA-256 of each full observation, for a resume checkpoint. It
    /// holds no file content and grants nothing by itself.
    pub fn observation_hashes(&self) -> BTreeMap<String, String> {
        let mut hashes = self.native_reads.clone();
        hashes.extend(self.observed.iter().map(|(path, content)| (path.clone(), digest(content.as_bytes()))));
        hashes
    }

    fn record_native(&mut self, path: &str, hash: String) {
        self.stale.remove(path);
        if self.native_reads.contains_key(path) || self.native_reads.len() < MAX_NATIVE_READS {
            self.native_reads.insert(path.to_owned(), hash);
        }
    }

    /// Thin engine: Hub has just read the whole file through `hub_fs`.
    pub fn record_native_read(&mut self, path: &str, content: &str) {
        self.record_native(path, digest(content.as_bytes()));
    }

    /// Thin engine: a native whole-file write must not overwrite a file the resumed
    /// conversation read before it changed on disk; a fresh read clears this.
    pub fn native_write_allowed(&self, path: &str) -> Result<(), String> {
        if self.stale.contains(path) {
            return Err("resume_reread_required".into());
        }
        Ok(())
    }

    /// Thin resume: re-reads each recorded path now. A file with the recorded hash keeps its
    /// record; an existing file whose content changed becomes stale (a native write needs a fresh
    /// read first); a missing, oversized or invalid path is dropped. Returns the kept count.
    pub fn restore_native_reads(&mut self, root: &Path, hashes: &BTreeMap<String, String>) -> usize {
        let mut restored = 0;
        for (path, hash) in hashes.iter().take(MAX_NATIVE_READS) {
            if relative(path).is_err() || checked(root, Path::new(path), false).is_err() {
                continue;
            }
            match read_text(root, path, MAX_FILE_BYTES) {
                Ok(current) if &digest(current.content.as_bytes()) == hash => {
                    self.native_reads.insert(path.clone(), hash.clone());
                    restored += 1;
                }
                Ok(_) => {
                    self.stale.insert(path.clone());
                }
                Err(_) => {}
            }
        }
        restored
    }

    /// Re-establishes observations from a resume checkpoint by reading each
    /// recorded file now. Only a file whose current content still has the
    /// recorded hash counts as observed; a changed, missing, oversized or
    /// invalid path is skipped, so editing it needs a fresh `hub_read`.
    /// Returns how many observations were restored.
    pub fn restore_observations(&mut self, root: &Path, hashes: &BTreeMap<String, String>) -> usize {
        let mut restored = 0;
        for (path, hash) in hashes {
            if self.capacity(path).is_err() {
                break;
            }
            if relative(path).is_err() {
                continue;
            }
            let Ok(current) = read_text(root, path, MAX_FILE_BYTES) else {
                continue;
            };
            if &digest(current.content.as_bytes()) == hash {
                self.observed.insert(path.clone(), current.content);
                restored += 1;
            }
        }
        restored
    }

    pub fn fingerprint(&self) -> String {
        digest(
            serde_json::to_string(&self.observed)
                .expect("string map serializes")
                .as_bytes(),
        )
    }

    pub fn verify(&self, root: &Path) -> Result<(), String> {
        self.observed.iter().try_for_each(|(path, expected)| {
            checked(root, Path::new(path), false)?;
            let current = crate::workspace_files::read(root, path)?;
            if current.content == *expected {
                Ok(())
            } else {
                Err("file_changed_since_read".into())
            }
        })
    }

    pub fn snapshot(&self, root: &Path) -> Result<TestWorkspace, String> {
        if self.observed.is_empty() {
            return Err("read_before_test_required".into());
        }
        let path = std::env::temp_dir().join(format!("hub-agent-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(|_| "test_workspace_unavailable")?;
        let snapshot = TestWorkspace {
            path: path
                .canonicalize()
                .map_err(|_| "test_workspace_unavailable")?,
        };
        for (relative_path, content) in &self.observed {
            checked(root, Path::new(relative_path), false)?;
            let current = crate::workspace_files::read(root, relative_path)?;
            if current.content != *content {
                return Err("file_changed_since_read".into());
            }
            let target = snapshot.path.join(relative_path);
            fs::create_dir_all(target.parent().ok_or("invalid_path")?)
                .map_err(|_| "snapshot_failed")?;
            fs::write(target, content).map_err(|_| "snapshot_failed")?;
        }
        Ok(snapshot)
    }
}

/// One page of a read: whole lines from `start_line`, at most `line_count`
/// (and `MAX_PAGE_LINES`) lines and `MAX_RESULT_BYTES` of text. A single line
/// longer than the cap is cut at a character boundary and marked.
fn page(
    result: &crate::workspace_files::FileReadResult,
    start_line: usize,
    line_count: Option<usize>,
) -> Result<Value, String> {
    if start_line == 0 || line_count == Some(0) {
        return Err("invalid_read_range".into());
    }
    let text = &result.content;
    let total_lines = text.lines().count();
    if start_line > total_lines.max(1) {
        return Err("line_out_of_range".into());
    }
    let wanted = line_count.unwrap_or(MAX_PAGE_LINES).min(MAX_PAGE_LINES);
    let (mut content, mut count, mut line_truncated) = (String::new(), 0, false);
    for line in text.lines().skip(start_line - 1).take(wanted) {
        let separator = usize::from(count > 0);
        if content.len() + separator + line.len() > MAX_RESULT_BYTES {
            if count == 0 {
                let mut end = MAX_RESULT_BYTES;
                while !line.is_char_boundary(end) {
                    end -= 1;
                }
                content.push_str(&line[..end]);
                count = 1;
                line_truncated = true;
            }
            break;
        }
        if separator > 0 {
            content.push('\n');
        }
        content.push_str(line);
        count += 1;
    }
    let next = start_line + count;
    Ok(json!({
        "relativePath": result.relative_path, "content": content, "partial": true,
        "startLine": start_line, "lineCount": count, "totalLines": total_lines,
        "nextLine": (next <= total_lines).then_some(next), "lineTruncated": line_truncated,
        "sizeBytes": result.size_bytes, "sha256": result.sha256,
    }))
}

/// The existing writer keeps revisions here; do not follow a replaced archive directory.
fn check_archive(root: &Path, path: &str) -> Result<(), String> {
    let archive = PathBuf::from(".hub-local-runner")
        .join("revisions")
        .join(digest(path.as_bytes()));
    let mut prefix = PathBuf::new();
    for part in archive.components() {
        prefix.push(part);
        if fs::symlink_metadata(root.join(&prefix)).is_ok() {
            checked(root, &prefix, false)?;
        } else {
            break;
        }
    }
    Ok(())
}

/// The single line ending a text uses, or `None` when it mixes CRLF and bare
/// LF. A text without CRLF counts as LF.
fn line_ending(text: &str) -> Option<&'static str> {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    if crlf == 0 {
        Some("\n")
    } else if crlf == lf {
        Some("\r\n")
    } else {
        None
    }
}

fn with_line_ending(text: &str, ending: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    if ending == "\n" {
        normalized
    } else {
        normalized.replace('\n', ending)
    }
}

pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

pub struct TestWorkspace {
    pub path: PathBuf,
}
impl Drop for TestWorkspace {
    fn drop(&mut self) {
        if self.path.canonicalize().ok().as_ref() == Some(&self.path)
            && fs::symlink_metadata(&self.path).is_ok_and(|metadata| !link(&metadata))
        {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn change_observer_records_actual_successful_new_empty_and_repeated_writes() {
        let root = fixture();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<Change>::new()));
        let captured = seen.clone();
        let mut files = Files::with_change_observer(Arc::new(move |change| captured.lock().unwrap().push(change)));
        fs::write(root.path.join("empty.txt"), "").unwrap();
        files.read(&root.path, "empty.txt").unwrap();
        for (path, content) in [("new.txt", "created"), ("empty.txt", "first"), ("empty.txt", "second")] {
            let change = files.preview(&root.path, path, content).unwrap();
            assert_eq!(seen.lock().unwrap().len(), if content == "created" { 0 } else if content == "first" { 1 } else { 2 });
            let answer = files.write(&root.path, &change).unwrap();
            assert_eq!(answer, json!({"path":path,"sha256":digest(content.as_bytes())}));
            assert_eq!(fs::read_to_string(root.path.join(path)).unwrap(), content);
            files.verify(&root.path).unwrap();
        }
        let changes = seen.lock().unwrap();
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].before, "");
        assert_eq!(changes[0].previous_sha256, None);
        assert_eq!(changes[1].before, "");
        assert_eq!(changes[1].previous_sha256, Some(digest(b"")));
        assert_eq!(changes[2].before, "first");
        assert_eq!(changes[2].after, "second");
        assert_eq!(changes[2].previous_sha256, Some(changes[1].sha256.clone()));
        assert_eq!(changes[2].sha256, digest(b"second"));
    }

    #[test]
    fn change_observer_is_not_called_for_mismatch_path_or_archive_failures() {
        let root = fixture();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<Change>::new()));
        let captured = seen.clone();
        let mut files = Files::with_change_observer(Arc::new(move |change| captured.lock().unwrap().push(change)));
        let mut change = files.preview(&root.path, "new.txt", "body").unwrap();
        change.before = "invented".into();
        assert_eq!(files.write(&root.path, &change).unwrap_err(), "file_changed_since_approval");
        assert!(files.preview(&root.path, "../escape.txt", "body").is_err());
        let change = files.preview(&root.path, "new.txt", "body").unwrap();
        fs::write(root.path.join(".hub-local-runner"), "archive blocked").unwrap();
        assert!(files.write(&root.path, &change).is_err());
        assert!(!root.path.join("new.txt").exists());
        assert!(files.observed.is_empty());
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn change_observer_panics_do_not_reclassify_success_or_lose_observations() {
        let root = fixture();
        let mut files = Files::with_change_observer(Arc::new(|_| panic!("synthetic observer failure")));
        for content in ["first", "second"] {
            let change = files.preview(&root.path, "new.txt", content).unwrap();
            assert_eq!(files.write(&root.path, &change).unwrap()["path"], "new.txt");
            files.verify(&root.path).unwrap();
        }
        assert_eq!(fs::read_to_string(root.path.join("new.txt")).unwrap(), "second");
    }

    #[test]
    fn output_fields_are_rejected_not_replayed_as_file_observations() {
        for kind in ["list", "read"] {
            // Content on a read/list means the model tried to answer through
            // the wrong field; the reply is refused with a correction rather
            // than silently rewritten.
            assert_eq!(
                Action::parse(json!({"kind":kind,"path":"a.txt","content":"invented","summary":"claimed success"})).unwrap_err(),
                "unexpected_action_fields"
            );
            // A bare summary stays a harmless annotation and is still cleared.
            let parsed = Action::parse(
                json!({"kind":kind,"path":"a.txt","content":"","summary":"checking"}),
            )
            .unwrap();
            assert_eq!(parsed.path, "a.txt");
            assert!(parsed.content.is_empty() && parsed.summary.is_empty());
            assert!(Action::parse(json!({"kind":kind,"path":"a.txt","content":"x".repeat(MAX_FILE_BYTES + 1),"summary":""})).is_err());
        }
        for kind in ["write", "test"] {
            let parsed = Action::parse(
                json!({"kind":kind,"path":"python","content":"real proposal","summary":"reason"}),
            )
            .unwrap();
            assert_eq!(parsed.content, "real proposal");
            assert_eq!(parsed.summary, "reason");
        }
        // The same refusal applies to a finish carrying file fields.
        assert_eq!(
            Action::parse(json!({"kind":"finish","path":"unused","content":"unused","summary":"reported result"})).unwrap_err(),
            "unexpected_action_fields"
        );
        let parsed = Action::parse(
            json!({"kind":"finish","path":"","content":"","summary":"reported result"}),
        )
        .unwrap();
        assert_eq!(parsed.summary, "reported result");
    }
    fn fixture() -> TestWorkspace {
        let path = std::env::temp_dir().join(format!("hub-agent-tools-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        TestWorkspace {
            path: path.canonicalize().unwrap(),
        }
    }
    #[test]
    fn paths_reject_hidden_devices_streams_and_parent_components() {
        for path in [
            "",
            "../a",
            "a/../b",
            "/a",
            "a//b",
            "a/./b",
            "C:/a",
            "a\\b",
            "a:stream",
            ".env",
            "src/.secret",
            "NUL.txt",
            "com1",
            "a.",
            "a ",
            "key.pem",
            "a\n",
        ] {
            assert!(relative(path).is_err(), "accepted {path:?}");
        }
        assert!(relative("src/日本語.rs").is_ok());
    }
    #[test]
    fn changes_require_a_read_and_recheck_the_approved_source() {
        let root = fixture();
        let mut files = Files::default();
        fs::write(root.path.join("a.txt"), "before").unwrap();
        assert!(files.preview(&root.path, "a.txt", "after").is_err());
        files.read(&root.path, "a.txt").unwrap();
        let change = files.preview(&root.path, "a.txt", "after").unwrap();
        fs::write(root.path.join("a.txt"), "another editor").unwrap();
        assert!(files.write(&root.path, &change).is_err());
        assert_eq!(
            fs::read_to_string(root.path.join("a.txt")).unwrap(),
            "another editor"
        );
        files.read(&root.path, "a.txt").unwrap();
        let change = files.preview(&root.path, "a.txt", "after").unwrap();
        files.write(&root.path, &change).unwrap();
        assert_eq!(
            fs::read_to_string(root.path.join("a.txt")).unwrap(),
            "after"
        );
    }

    #[test]
    fn a_new_file_approval_cannot_overwrite_an_empty_file_created_while_waiting() {
        let root = fixture();
        let mut files = Files::default();
        let change = files.preview(&root.path, "new.txt", "proposed").unwrap();
        fs::write(root.path.join("new.txt"), "").unwrap();
        files.read(&root.path, "new.txt").unwrap();
        assert_eq!(
            files.write(&root.path, &change).unwrap_err(),
            "file_changed_since_approval"
        );
        assert_eq!(fs::read_to_string(root.path.join("new.txt")).unwrap(), "");
    }

    fn edit(old_text: &str, new_text: &str) -> String {
        json!({"oldText":old_text,"newText":new_text}).to_string()
    }

    #[test]
    fn edit_previews_exact_japanese_crlf_replacements_without_writing() {
        let root = fixture();
        let mut files = Files::default();
        fs::write(root.path.join("a.txt"), "先頭\r\n対象\r\n末尾").unwrap();
        files.read(&root.path, "a.txt").unwrap();
        let change = files
            .preview_edit(&root.path, "a.txt", &edit("対象", "置換"))
            .unwrap();
        assert_eq!(change.before, "先頭\r\n対象\r\n末尾");
        assert_eq!(change.after, "先頭\r\n置換\r\n末尾");
        assert_eq!(
            fs::read_to_string(root.path.join("a.txt")).unwrap(),
            change.before
        );
        files.write(&root.path, &change).unwrap();
        let change = files
            .preview_edit(&root.path, "a.txt", &edit("先頭", "開始"))
            .unwrap();
        files.write(&root.path, &change).unwrap();
        let change = files
            .preview_edit(&root.path, "a.txt", &edit("\r\n末尾", ""))
            .unwrap();
        files.write(&root.path, &change).unwrap();
        assert_eq!(
            fs::read_to_string(root.path.join("a.txt")).unwrap(),
            "開始\r\n置換"
        );
    }

    #[test]
    fn edit_matches_lf_text_in_a_crlf_file_and_writes_crlf() {
        let root = fixture();
        let mut files = Files::default();
        fs::write(root.path.join("a.py"), "def f():\r\n    return 1\r\n\r\nx = 2\r\n").unwrap();
        files.read(&root.path, "a.py").unwrap();
        let change = files
            .preview_edit(&root.path, "a.py", &edit("def f():\n    return 1\n", "def f():\n    a = 1\n    return a\n"))
            .unwrap();
        assert_eq!(change.after, "def f():\r\n    a = 1\r\n    return a\r\n\r\nx = 2\r\n");
        files.write(&root.path, &change).unwrap();
        assert_eq!(fs::read(root.path.join("a.py")).unwrap(), change.after.as_bytes());
        // Converted texts that end up equal are still a no-op proposal.
        assert_eq!(
            files.preview_edit(&root.path, "a.py", &edit("x = 2\n", "x = 2\r\n")).unwrap_err(),
            "edit_no_change"
        );
    }

    #[test]
    fn edit_matches_crlf_text_in_an_lf_file_and_mixed_files_stay_exact() {
        let root = fixture();
        let mut files = Files::default();
        fs::write(root.path.join("lf.txt"), "one\ntwo\nthree\n").unwrap();
        files.read(&root.path, "lf.txt").unwrap();
        let change = files
            .preview_edit(&root.path, "lf.txt", &edit("one\r\ntwo\r\n", "1\r\n2\r\n"))
            .unwrap();
        assert_eq!(change.after, "1\n2\nthree\n");

        fs::write(root.path.join("mixed.txt"), "a\r\nb\nc\r\n").unwrap();
        files.read(&root.path, "mixed.txt").unwrap();
        assert_eq!(
            files.preview_edit(&root.path, "mixed.txt", &edit("a\nb\n", "z\n")).unwrap_err(),
            "edit_not_found"
        );
        let change = files
            .preview_edit(&root.path, "mixed.txt", &edit("a\r\nb\n", "z\n"))
            .unwrap();
        assert_eq!(change.after, "z\nc\r\n");
        // Ambiguity is judged on the converted text.
        fs::write(root.path.join("dup.txt"), "x\r\ny\r\nx\r\ny\r\n").unwrap();
        files.read(&root.path, "dup.txt").unwrap();
        assert_eq!(
            files.preview_edit(&root.path, "dup.txt", &edit("x\ny", "q")).unwrap_err(),
            "edit_ambiguous"
        );
    }

    #[test]
    fn restored_observations_count_only_for_files_unchanged_on_disk() {
        let root = fixture();
        let mut first = Files::default();
        fs::write(root.path.join("same.txt"), "keep\r\n").unwrap();
        fs::write(root.path.join("moved.txt"), "before").unwrap();
        fs::write(root.path.join("gone.txt"), "x").unwrap();
        for path in ["same.txt", "moved.txt", "gone.txt"] {
            first.read(&root.path, path).unwrap();
        }
        let mut hashes = first.observation_hashes();
        assert_eq!(hashes["same.txt"], digest("keep\r\n".as_bytes()));
        hashes.insert("../escape.txt".into(), digest(b"x"));
        hashes.insert("forged.txt".into(), digest(b"not the content"));
        fs::write(root.path.join("forged.txt"), "real").unwrap();
        fs::write(root.path.join("moved.txt"), "changed on disk").unwrap();
        fs::remove_file(root.path.join("gone.txt")).unwrap();

        let mut resumed = Files::default();
        assert_eq!(resumed.restore_observations(&root.path, &hashes), 1);
        let change = resumed
            .preview_edit(&root.path, "same.txt", &edit("keep\n", "kept\n"))
            .unwrap();
        resumed.write(&root.path, &change).unwrap();
        assert_eq!(fs::read_to_string(root.path.join("same.txt")).unwrap(), "kept\r\n");
        for path in ["moved.txt", "forged.txt"] {
            assert_eq!(
                resumed.preview(&root.path, path, "new").unwrap_err(),
                "read_before_write_required"
            );
        }
        assert_eq!(resumed.preview(&root.path, "gone.txt", "new").unwrap().before, "");
    }

    #[test]
    fn edit_rejects_ambiguous_invalid_stale_and_oversized_proposals() {
        let root = fixture();
        let mut files = Files::default();
        fs::write(root.path.join("a.txt"), "aaa").unwrap();
        assert_eq!(
            files
                .preview_edit(&root.path, "a.txt", &edit("a", "b"))
                .unwrap_err(),
            "read_before_write_required"
        );
        assert_eq!(
            Action::parse(
                json!({"kind":"edit","path":"a.txt","content":edit("", "b"),"summary":""})
            )
            .unwrap_err(),
            "edit_invalid"
        );
        assert_eq!(
            Action::parse(json!({"kind":"edit","path":"a.txt","content":"{\"oldText\":\"a\",\"newText\":\"b\",\"extra\":true}","summary":""}))
                .unwrap_err(),
            "edit_invalid"
        );
        files.read(&root.path, "a.txt").unwrap();
        assert_eq!(
            files
                .preview_edit(&root.path, "a.txt", &edit("missing", "b"))
                .unwrap_err(),
            "edit_not_found"
        );
        assert_eq!(
            files
                .preview_edit(&root.path, "a.txt", &edit("aa", "b"))
                .unwrap_err(),
            "edit_ambiguous"
        );
        assert_eq!(
            files
                .preview_edit(&root.path, "a.txt", &edit("aaa", "aaa"))
                .unwrap_err(),
            "edit_no_change"
        );
        fs::write(root.path.join("a.txt"), "changed elsewhere").unwrap();
        assert_eq!(
            files
                .preview_edit(&root.path, "a.txt", &edit("aaa", "b"))
                .unwrap_err(),
            "file_changed_since_read"
        );
        assert_eq!(
            fs::read_to_string(root.path.join("a.txt")).unwrap(),
            "changed elsewhere"
        );

        let mut large = Files::default();
        let content = format!("{}x", "a".repeat(MAX_FILE_BYTES - 1));
        fs::write(root.path.join("large.txt"), content).unwrap();
        large.read(&root.path, "large.txt").unwrap();
        assert_eq!(
            large
                .preview_edit(&root.path, "large.txt", &edit("x", "xx"))
                .unwrap_err(),
            "edit_too_large"
        );
    }

    #[test]
    fn test_snapshot_contains_only_observed_files_and_detects_stale_reads() {
        let root = fixture();
        let mut files = Files::default();
        fs::write(root.path.join("a.txt"), "one").unwrap();
        fs::write(root.path.join("unread.txt"), "two").unwrap();
        fs::write(root.path.join(".env"), "fixture only").unwrap();
        files.read(&root.path, "a.txt").unwrap();
        let snapshot = files.snapshot(&root.path).unwrap();
        assert_eq!(fs::read_dir(&snapshot.path).unwrap().count(), 1);
        assert!(!snapshot.path.join(".env").exists());
        fs::write(root.path.join("a.txt"), "changed").unwrap();
        assert!(files.snapshot(&root.path).is_err());
        assert!(files.verify(&root.path).is_err());
    }
    #[test]
    fn list_reports_real_entries_and_filters_blocked_names() {
        let root = fixture();
        fs::create_dir(root.path.join("dir")).unwrap();
        fs::write(root.path.join("dir/b.txt"), "b").unwrap();
        fs::write(root.path.join("a.txt"), "aa").unwrap();
        fs::write(root.path.join(".env"), "hidden").unwrap();
        fs::write(root.path.join("key.pem"), "hidden").unwrap();
        let result = list(&root.path, "").unwrap();
        let entries = result["entries"].as_array().unwrap();
        let paths: Vec<&str> = entries
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, ["a.txt", "dir"]);
        assert_eq!(result["truncated"], false);
        assert_eq!(entries[1]["directory"], true);
        assert_eq!(entries[0]["bytes"], 2);
        let nested = list(&root.path, "dir").unwrap();
        assert_eq!(nested["entries"][0]["path"], "dir/b.txt");
    }

    #[test]
    fn edit_reports_proposal_errors_before_the_staleness_recheck() {
        let root = fixture();
        let mut files = Files::default();
        fs::write(root.path.join("a.txt"), "aaa").unwrap();
        files.read(&root.path, "a.txt").unwrap();
        fs::write(root.path.join("a.txt"), "changed elsewhere").unwrap();
        // A bad proposal is answered on its own terms; a good one still hits
        // the freshness re-check inside `preview`.
        assert_eq!(
            files
                .preview_edit(&root.path, "a.txt", &edit("missing", "b"))
                .unwrap_err(),
            "edit_not_found"
        );
        assert_eq!(
            files
                .preview_edit(&root.path, "a.txt", &edit("aaa", "b"))
                .unwrap_err(),
            "file_changed_since_read"
        );
    }

    #[test]
    fn new_files_and_file_limits_are_explicit() {
        let root = fixture();
        let mut files = Files::default();
        let change = files.preview(&root.path, "new.txt", "new").unwrap();
        files.write(&root.path, &change).unwrap();
        fs::write(root.path.join("big.txt"), "x".repeat(MAX_FILE_BYTES + 1)).unwrap();
        assert!(files.read(&root.path, "big.txt").is_err());
        assert!(files
            .preview(&root.path, "new.txt", &"x".repeat(MAX_FILE_BYTES + 1))
            .is_err());
        for n in 0..MAX_FILES - 1 {
            let name = format!("{n}.txt");
            fs::write(root.path.join(&name), "x").unwrap();
            files.read(&root.path, &name).unwrap();
        }
        assert!(files.preview(&root.path, "extra.txt", "x").is_err());
        assert!(files.read(&root.path, "new.txt").is_ok());
    }
    #[test]
    fn large_files_read_in_bounded_pages_and_edit_without_returning_the_file() {
        let root = fixture();
        let mut files = Files::default();
        let body: String = (1..=4000).map(|n| format!("line {n} {}\n", "x".repeat(40))).collect();
        assert!(body.len() > MAX_RESULT_BYTES * 4 && body.len() < MAX_FILE_BYTES);
        fs::write(root.path.join("big.py"), &body).unwrap();
        let first = files.read(&root.path, "big.py").unwrap();
        assert_eq!(first["partial"], true);
        assert_eq!(first["startLine"], 1);
        assert!(first["content"].as_str().unwrap().len() <= MAX_RESULT_BYTES);
        assert_eq!(first["totalLines"], 4000);
        let next = first["nextLine"].as_u64().unwrap() as usize;
        assert!(next > 1 && next < 4000);
        assert_eq!(first["sha256"], digest(body.as_bytes()));
        let range = files.read_page(&root.path, "big.py", Some(3990), Some(50)).unwrap();
        assert_eq!(range["lineCount"], 11);
        assert_eq!(range["nextLine"], Value::Null);
        assert!(range["content"].as_str().unwrap().starts_with("line 3990 "));
        assert_eq!(files.read_page(&root.path, "big.py", Some(4001), None).unwrap_err(), "line_out_of_range");
        assert_eq!(files.read_page(&root.path, "big.py", Some(0), None).unwrap_err(), "invalid_read_range");
        // The page read observed the whole file: an exact-match edit near the end works,
        // and the write result does not carry the file.
        let change = files.preview_edit(&root.path, "big.py", &edit("line 3999 ", "line 3999 edited ")).unwrap();
        let written = files.write(&root.path, &change).unwrap();
        assert!(written.to_string().len() < 200);
        let after = fs::read_to_string(root.path.join("big.py")).unwrap();
        assert!(after.contains("line 3999 edited x") && after.len() == body.len() + 7);
        // A small file read with a range is also a page; without one it stays whole.
        fs::write(root.path.join("small.txt"), "a\nb\nc\n").unwrap();
        assert_eq!(files.read(&root.path, "small.txt").unwrap()["content"], "a\nb\nc\n");
        let small = files.read_page(&root.path, "small.txt", Some(2), Some(1)).unwrap();
        assert_eq!((small["content"].as_str(), small["nextLine"].as_u64()), (Some("b"), Some(3)));
        // One overlong line is cut at a character boundary, never past the cap.
        fs::write(root.path.join("wide.txt"), "界".repeat(MAX_RESULT_BYTES)).unwrap();
        let wide = files.read(&root.path, "wide.txt").unwrap();
        assert_eq!(wide["lineTruncated"], true);
        assert!(wide["content"].as_str().unwrap().len() <= MAX_RESULT_BYTES);
    }

    #[test]
    fn unknown_actions_fields_and_oversize_values_fail_closed() {
        assert!(
            Action::parse(json!({"kind":"shell","path":"","content":"","summary":""})).is_err()
        );
        assert!(Action::parse(
            json!({"kind":"finish","path":"","content":"","summary":"","approved":true})
        )
        .is_err());
        assert!(Action::parse(
            json!({"kind":"test","path":"shell","content":"echo ok","summary":""})
        )
        .is_err());
        assert!(Action::parse(
            json!({"kind":"write","path":"a","content":"x".repeat(MAX_FILE_BYTES+1),"summary":""})
        )
        .is_err());
    }
}
