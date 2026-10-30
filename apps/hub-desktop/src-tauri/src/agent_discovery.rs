//! Read-only code discovery. Search/range results never count as an observed
//! full-file read for editing or Docker snapshots.
use crate::agent_tools::{checked, digest, relative, MAX_RESULT_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};

const MAX_READ_BYTES: usize = 1_048_576;
const MAX_ENTRIES: usize = 5_000;
const MAX_SEARCH_BYTES: usize = 16 * MAX_READ_BYTES;

/// A small initial path map helps the model discover real filenames instead of
/// guessing them from task terminology. No file contents or edit observations.
pub fn project_map(root: &Path) -> Result<Value, String> {
    let mut pending = std::collections::VecDeque::from([String::new()]);
    let (mut visited, mut skipped, mut bytes) = (0, 0, 0);
    let mut files = Vec::new();
    let mut truncated = false;
    'scan: while let Some(directory) = pending.pop_front() {
        let path = checked(root, Path::new(&directory), false)?;
        let mut entries = fs::read_dir(path)
            .map_err(|_| "directory_unavailable")?
            .take(513 - visited)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "directory_unavailable")?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if visited == 512 {
                truncated = true;
                break 'scan;
            }
            visited += 1;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                skipped += 1;
                continue;
            };
            let path = if directory.is_empty() {
                name
            } else {
                format!("{directory}/{name}")
            };
            if relative(&path).is_err() || checked(root, Path::new(&path), false).is_err() {
                skipped += 1;
                continue;
            }
            let metadata = entry.metadata().map_err(|_| "file_unavailable")?;
            if metadata.is_dir() {
                pending.push_back(path);
                continue;
            }
            let extension = Path::new(&path)
                .extension()
                .and_then(|part| part.to_str())
                .unwrap_or("");
            if !metadata.is_file()
                || !matches!(
                    extension,
                    "rs" | "js"
                        | "mjs"
                        | "cjs"
                        | "jsx"
                        | "ts"
                        | "tsx"
                        | "py"
                        | "go"
                        | "java"
                        | "c"
                        | "cpp"
                        | "h"
                        | "hpp"
                        | "cs"
                        | "rb"
                        | "php"
                        | "swift"
                        | "kt"
                        | "md"
                        | "toml"
                        | "json"
                )
            {
                skipped += 1;
                continue;
            }
            if files.len() == 128 || bytes + path.len() > 8192 {
                truncated = true;
                break 'scan;
            }
            bytes += path.len();
            files.push(path);
        }
    }
    Ok(json!({"files":files,"truncated":truncated,"skippedEntries":skipped,
        "topLevel":top_level(root),"readOnly":true}))
}

/// Allowed names directly under the root (directories end in "/"), at most 64,
/// so a large repository can be summarised without listing deep paths.
fn top_level(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .take(1_000)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            relative(&name).ok()?;
            let metadata = entry.metadata().ok()?;
            if metadata.file_type().is_symlink() || checked(root, Path::new(&name), false).is_err() {
                return None;
            }
            if metadata.is_dir() { Some(format!("{name}/")) } else { metadata.is_file().then_some(name) }
        })
        .collect();
    names.sort();
    names.truncate(64);
    names
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Search {
    query: String,
    #[serde(default)]
    path: String,
    #[serde(default = "search_limit")]
    limit: usize,
}

fn search_limit() -> usize {
    50
}
fn first_line() -> usize {
    1
}
fn line_count() -> usize {
    200
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRange {
    path: String,
    #[serde(default = "first_line")]
    start_line: usize,
    #[serde(default = "line_count")]
    line_count: usize,
}

fn text_file(root: &Path, path: &str, limit: usize) -> Result<String, String> {
    relative(path)?;
    let path = checked(root, Path::new(path), false)?;
    let file = fs::File::open(path).map_err(|_| "file_unavailable")?;
    let metadata = file.metadata().map_err(|_| "file_unavailable")?;
    if !metadata.is_file() {
        return Err("text_file_required".into());
    }
    if metadata.len() > limit as u64 {
        return Err("file_too_large".into());
    }
    let mut bytes = Vec::new();
    // The file can grow after stat; the read itself must also be bounded.
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "file_unavailable")?;
    if bytes.len() > limit {
        return Err("file_too_large".into());
    }
    if bytes.contains(&0) {
        return Err("text_file_required".into());
    }
    String::from_utf8(bytes).map_err(|_| "text_file_required".into())
}

pub fn read_range(root: &Path, args: Value) -> Result<Value, String> {
    let request: ReadRange = serde_json::from_value(args).map_err(|_| "invalid_read_range")?;
    if request.start_line == 0 || !(1..=400).contains(&request.line_count) {
        return Err("invalid_read_range".into());
    }
    let text = text_file(root, &request.path, MAX_READ_BYTES)?;
    let total_lines = text.lines().count();
    if request.start_line > total_lines.max(1) {
        return Err("line_out_of_range".into());
    }
    let mut content = String::new();
    let mut count = 0;
    for line in text
        .lines()
        .skip(request.start_line - 1)
        .take(request.line_count)
    {
        let separator = usize::from(count > 0);
        if content.len() + separator + line.len() > MAX_RESULT_BYTES {
            if count == 0 {
                return Err("line_too_large".into());
            }
            break;
        }
        if separator > 0 {
            content.push('\n');
        }
        content.push_str(line);
        count += 1;
    }
    let next = request.start_line + count;
    Ok(json!({
        "path": request.path, "content": content, "startLine": request.start_line,
        "lineCount": count, "totalLines": total_lines,
        "nextLine": (next <= total_lines).then_some(next),
        "sha256": digest(text.as_bytes()), "readOnly": true,
    }))
}

pub fn search(root: &Path, args: Value) -> Result<Value, String> {
    let request: Search = serde_json::from_value(args).map_err(|_| "invalid_search")?;
    if request.query.trim().is_empty()
        || request.query.chars().count() > 200
        || request.query.chars().any(char::is_control)
        || !(1..=100).contains(&request.limit)
    {
        return Err("invalid_search".into());
    }
    if !request.path.is_empty() {
        relative(&request.path)?;
    }
    let target = checked(root, Path::new(&request.path), false)?;
    // A file path searches just that file (models often narrow a search this way).
    if !request.path.is_empty() && fs::metadata(&target).is_ok_and(|metadata| metadata.is_file()) {
        let text = text_file(root, &request.path, MAX_READ_BYTES)?;
        let mut matches = Vec::new();
        for (index, line) in text.lines().enumerate() {
            if let Some(position) = line.find(&request.query) {
                if matches.len() == request.limit {
                    return Ok(json!({"matches": matches, "truncated": true,
                        "scannedFiles": 1, "skippedEntries": 0, "readOnly": true}));
                }
                let start = line[..position].chars().count().saturating_sub(80);
                let excerpt: String = line.chars().skip(start).take(320).collect();
                matches.push(json!({"path": request.path, "line": index + 1, "excerpt": excerpt}));
            }
        }
        return Ok(json!({"matches": matches, "truncated": false,
            "scannedFiles": 1, "skippedEntries": 0, "readOnly": true}));
    }
    let mut pending = vec![request.path];
    let (mut visited, mut scanned, mut skipped, mut bytes) = (0, 0, 0, 0);
    let mut matches = Vec::new();
    let mut truncated = false;
    'scan: while let Some(directory) = pending.pop() {
        let directory_path = checked(root, Path::new(&directory), false)?;
        let mut entries = fs::read_dir(directory_path)
            .map_err(|_| "directory_unavailable")?
            .take(MAX_ENTRIES - visited + 1)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "directory_unavailable")?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if visited == MAX_ENTRIES {
                truncated = true;
                break 'scan;
            }
            visited += 1;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                skipped += 1;
                continue;
            };
            let path = if directory.is_empty() {
                name
            } else {
                format!("{directory}/{name}")
            };
            if relative(&path).is_err() || checked(root, Path::new(&path), false).is_err() {
                skipped += 1;
                continue;
            }
            let metadata = entry.metadata().map_err(|_| "file_unavailable")?;
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if !metadata.is_file() || metadata.len() > MAX_READ_BYTES as u64 {
                skipped += 1;
                continue;
            }
            if metadata.len() > (MAX_SEARCH_BYTES - bytes) as u64 {
                truncated = true;
                break 'scan;
            }
            // Charge even binary/unreadable files to the budget; a directory of
            // invalid UTF-8 files must not allow unbounded reads.
            let limit = (MAX_SEARCH_BYTES - bytes).min(MAX_READ_BYTES);
            bytes += metadata.len() as usize;
            let text = match text_file(root, &path, limit) {
                Ok(text) => text,
                Err(_) => {
                    bytes += limit.saturating_sub(metadata.len() as usize);
                    skipped += 1;
                    continue;
                }
            };
            bytes += text.len().saturating_sub(metadata.len() as usize);
            scanned += 1;
            for (index, line) in text.lines().enumerate() {
                if let Some(position) = line.find(&request.query) {
                    let start = line[..position].chars().count().saturating_sub(80);
                    let excerpt: String = line.chars().skip(start).take(320).collect();
                    matches.push(json!({"path": path, "line": index + 1, "excerpt": excerpt}));
                    if matches.len() == request.limit {
                        truncated = true;
                        break 'scan;
                    }
                }
            }
        }
    }
    Ok(json!({"matches": matches, "truncated": truncated,
        "scannedFiles": scanned, "skippedEntries": skipped, "readOnly": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_tools::TestWorkspace;

    fn workspace() -> TestWorkspace {
        let path = std::env::temp_dir().join(format!("hub-discovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        TestWorkspace {
            path: path.canonicalize().unwrap(),
        }
    }

    #[test]
    fn search_finds_nested_unicode_lines_and_skips_private_and_binary_files() {
        let root = workspace();
        fs::create_dir(root.path.join("src")).unwrap();
        fs::create_dir(root.path.join(".git")).unwrap();
        fs::create_dir(root.path.join("node_modules")).unwrap();
        fs::write(root.path.join("src/a.rs"), "前置き\n値 = 42\n別の値 = 7\n").unwrap();
        for name in [".env", ".git/config", "node_modules/a.js", "private.key"] {
            fs::write(root.path.join(name), "値 = secret").unwrap();
        }
        fs::write(root.path.join("binary.bin"), b"\0value").unwrap();
        let report = search(&root.path, json!({"query": "値"})).unwrap();
        assert_eq!(
            report["matches"],
            json!([
                {"path":"src/a.rs", "line":2, "excerpt":"値 = 42"},
                {"path":"src/a.rs", "line":3, "excerpt":"別の値 = 7"},
            ])
        );
        assert_eq!(report["truncated"], false);
        assert_eq!(report["scannedFiles"], 1);
        assert_eq!(
            search(&root.path, json!({"query":"値", "limit":1})).unwrap()["truncated"],
            true
        );
        assert_eq!(
            search(&root.path, json!({"query":"absent"})).unwrap()["matches"],
            json!([])
        );
        // A file path searches only that file; private files stay refused.
        let one = search(&root.path, json!({"query":"値", "path":"src/a.rs"})).unwrap();
        assert_eq!(one["matches"].as_array().unwrap().len(), 2);
        assert_eq!(one["truncated"], false);
        let capped = search(&root.path, json!({"query":"値", "path":"src/a.rs", "limit":1})).unwrap();
        assert_eq!((capped["matches"][0]["line"].as_u64(), capped["truncated"].as_bool()), (Some(2), Some(true)));
        assert!(search(&root.path, json!({"query":"値", "path":"private.key"})).is_err());
        assert!(search(&root.path, json!({"query":"値", "path":"binary.bin"})).is_err());
    }

    #[test]
    fn map_uses_real_nested_paths_and_bounds_metadata_without_reading_contents() {
        let root = workspace();
        fs::create_dir_all(root.path.join("src")).unwrap();
        fs::create_dir(root.path.join(".pi")).unwrap();
        fs::write(root.path.join("src/metrics.cjs"), "private fixture body").unwrap();
        fs::write(root.path.join(".pi/auth.json"), "never include").unwrap();
        let report = project_map(&root.path).unwrap();
        assert_eq!(report["files"], json!(["src/metrics.cjs"]));
        assert!(!report.to_string().contains("fixture body"));
        for index in 0..140 {
            fs::write(root.path.join(format!("src/{index:03}.rs")), "").unwrap();
        }
        let report = project_map(&root.path).unwrap();
        assert_eq!(report["files"].as_array().unwrap().len(), 128);
        assert_eq!(report["truncated"], true);
        assert_eq!(report["topLevel"], json!(["src/"]), "hidden entries never appear");
    }

    #[test]
    fn map_bounds_unicode_path_bytes_and_directory_enumeration() {
        let root = workspace();
        for index in 0..50 {
            fs::write(
                root.path.join(format!("{index:03}{}.rs", "長".repeat(60))),
                "",
            )
            .unwrap();
        }
        let report = project_map(&root.path).unwrap();
        assert_eq!(report["truncated"], true);
        assert!(
            report["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|path| path.as_str().unwrap().len())
                .sum::<usize>()
                <= 8192
        );
        let root = workspace();
        for index in 0..513 {
            fs::create_dir(root.path.join(format!("{index:04}"))).unwrap();
        }
        let report = project_map(&root.path).unwrap();
        assert_eq!(report["truncated"], true);
        assert_eq!(report["files"], json!([]));
    }

    #[test]
    fn ranges_read_large_files_with_correct_lines_and_continuation_without_truncating_utf8() {
        let root = workspace();
        let text = "あいうえお\r\n".repeat(3000);
        fs::write(root.path.join("large.txt"), &text).unwrap();
        let report = read_range(
            &root.path,
            json!({"path":"large.txt", "startLine":2999, "lineCount":2}),
        )
        .unwrap();
        assert_eq!(report["content"], "あいうえお\nあいうえお");
        assert_eq!(report["lineCount"], 2);
        assert_eq!(report["nextLine"], Value::Null);
        assert_eq!(report["totalLines"], 3000);
        assert_eq!(report["sha256"], digest(text.as_bytes()));
        assert_eq!(
            read_range(&root.path, json!({"path":"large.txt", "lineCount":1})).unwrap()["nextLine"],
            2
        );
        let long = "界".repeat(6000);
        fs::write(root.path.join("long.txt"), format!("{long}\n{long}\n")).unwrap();
        let page = read_range(&root.path, json!({"path":"long.txt"})).unwrap();
        assert_eq!(page["content"], long);
        assert_eq!(page["nextLine"], 2);
        fs::write(
            root.path.join("long.txt"),
            "界".repeat(MAX_RESULT_BYTES / 3 + 1),
        )
        .unwrap();
        assert_eq!(
            read_range(&root.path, json!({"path":"long.txt"})).unwrap_err(),
            "line_too_large"
        );
    }

    #[test]
    fn discovery_rejects_bad_paths_ranges_types_and_unknown_fields() {
        let root = workspace();
        fs::write(root.path.join("a.txt"), "first\nsecond").unwrap();
        for path in ["../a", ".env", "secrets/a", "C:/a", "a:stream", "a\\b"] {
            assert!(read_range(&root.path, json!({"path":path})).is_err());
            assert!(search(&root.path, json!({"path":path,"query":"a"})).is_err());
        }
        for args in [
            json!({"path":"a.txt","startLine":0}),
            json!({"path":"a.txt","startLine":usize::MAX}),
            json!({"path":"a.txt","lineCount":0}),
            json!({"path":"a.txt","lineCount":401}),
            json!({"path":"a.txt","lineCount":1.5}),
            json!({"path":"a.txt","extra":true}),
        ] {
            assert!(read_range(&root.path, args).is_err());
        }
        for args in [
            json!({"query":""}),
            json!({"query":"x\ny"}),
            json!({"query":"界".repeat(201)}),
            json!({"query":"a","limit":0}),
            json!({"query":"a","limit":101}),
            json!({"query":"a","limit":-1}),
            json!({"query":"a","extra":true}),
        ] {
            assert!(search(&root.path, args).is_err());
        }
        fs::write(root.path.join("empty.txt"), "").unwrap();
        let empty = read_range(&root.path, json!({"path":"empty.txt"})).unwrap();
        assert_eq!(empty["content"], "");
        assert_eq!(empty["nextLine"], Value::Null);
        fs::write(
            root.path.join("oversize.txt"),
            vec![b'x'; MAX_READ_BYTES + 1],
        )
        .unwrap();
        assert_eq!(
            read_range(&root.path, json!({"path":"oversize.txt"})).unwrap_err(),
            "file_too_large"
        );
    }

    #[test]
    fn search_reports_budget_exhaustion_instead_of_claiming_no_matches() {
        let root = workspace();
        for i in 0..17 {
            fs::write(
                root.path.join(format!("{i:02}.txt")),
                vec![b'x'; MAX_READ_BYTES],
            )
            .unwrap();
        }
        let report = search(&root.path, json!({"query":"absent"})).unwrap();
        assert_eq!(report["truncated"], true);
        assert_eq!(report["scannedFiles"], 16);
    }

    #[test]
    fn search_bounds_directory_enumeration_even_for_empty_files() {
        let root = workspace();
        for i in 0..=MAX_ENTRIES {
            fs::write(root.path.join(format!("{i:05}.txt")), "").unwrap();
        }
        let report = search(&root.path, json!({"query":"absent"})).unwrap();
        assert_eq!(report["truncated"], true);
        assert_eq!(report["scannedFiles"], MAX_ENTRIES);
    }

    #[cfg(windows)]
    #[test]
    fn discovery_cannot_follow_a_windows_junction_outside_the_workspace() {
        use std::os::windows::process::CommandExt;
        let root = workspace();
        let outside = workspace();
        fs::write(outside.path.join("outside.txt"), "outside-marker").unwrap();
        fs::write(outside.path.join("outside.rs"), "outside-marker").unwrap();
        let link = root.path.join("linked");
        let status = std::process::Command::new("cmd")
            .creation_flags(0x08000000)
            .args(["/c", "mklink", "/J"])
            .arg(crate::pi_work::non_verbatim(link.clone()))
            .arg(crate::pi_work::non_verbatim(outside.path.clone()))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            read_range(&root.path, json!({"path":"linked/outside.txt"})).unwrap_err(),
            "linked_path_not_allowed"
        );
        assert_eq!(
            search(&root.path, json!({"query":"outside-marker"})).unwrap()["matches"],
            json!([])
        );
        assert_eq!(project_map(&root.path).unwrap()["files"], json!([]));
        fs::remove_dir(link).unwrap();
    }
}
