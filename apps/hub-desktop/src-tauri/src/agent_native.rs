//! Thin engine: Pi runs its own native tools (read, edit, write, ls, bash), but
//! every filesystem operation those tools make arrives here as a `hub_fs` /
//! `hub_fs_write` call and every shell command as an ordinary `hub_exec`. The
//! sidecar performs no file IO of its own. This module is the outer safety
//! layer for that mode: the path Pi resolved must lie inside the workspace (no
//! `..` escape, no other drive or UNC share, no link or junction component, no
//! hidden or private name), writes keep Hub's approvals, revisions and undo,
//! and results stay bounded.
use crate::agent_tools::{checked, read_text, relative, Change, Files, MAX_FILE_BYTES};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, Prefix},
};

const MAX_DIR_ENTRIES: usize = 1_000;

fn lexical(path: &Path) -> Result<(String, Vec<String>), String> {
    let mut prefix = None;
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(value) => {
                prefix = Some(match value.kind() {
                    Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => {
                        format!("{}:", (drive as char).to_ascii_lowercase())
                    }
                    _ => return Err("path_not_allowed".into()),
                })
            }
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                parts.pop().ok_or("path_not_allowed")?;
            }
            Component::Normal(part) => parts.push(part.to_str().ok_or("path_not_allowed")?.to_owned()),
        }
    }
    Ok((prefix.unwrap_or_default(), parts))
}

fn same(left: &str, right: &str) -> bool {
    if cfg!(windows) { left.eq_ignore_ascii_case(right) } else { left == right }
}

/// Maps the absolute path Pi resolved to a workspace-relative one ("" is the
/// root), or refuses it. Lexical first (so `..` cannot climb out), then every
/// existing component is checked for links by `agent_tools::checked`.
pub fn workspace_relative(root: &Path, raw: &str, missing_leaf: bool) -> Result<String, String> {
    let rest = lexical_relative(root, raw)?;
    checked(root, Path::new(&rest), missing_leaf)?;
    Ok(rest)
}

/// The lexical half of `workspace_relative`: inside the root and allowed names, with no
/// filesystem check yet (`mkdir` checks each existing component itself).
fn lexical_relative(root: &Path, raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.len() > 1_024 || raw.contains('\0') {
        return Err("path_not_allowed".into());
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("path_not_allowed".into());
    }
    let (root_prefix, root_parts) = lexical(root)?;
    let (prefix, parts) = lexical(path)?;
    if !same(&prefix, &root_prefix)
        || parts.len() < root_parts.len()
        || !root_parts.iter().zip(&parts).all(|(a, b)| same(a, b))
    {
        return Err("path_not_allowed".into());
    }
    let rest = parts[root_parts.len()..].join("/");
    if !rest.is_empty() {
        relative(&rest)?;
    }
    Ok(rest)
}

fn text(details: Value) -> crate::pi_sidecar::ToolAnswer {
    crate::pi_sidecar::ToolAnswer::new(json!([{ "type": "text", "text": "ok" }]), details)
}

/// Read-only operations: `access`, `exists`, `stat`, `readdir`, `read`.
pub fn read_op(root: &Path, args: &Value) -> Result<crate::pi_sidecar::ToolAnswer, String> {
    let op = args.get("op").and_then(Value::as_str).ok_or("invalid_action")?;
    let raw = args.get("path").and_then(Value::as_str).ok_or("invalid_action")?;
    if args.as_object().is_some_and(|map| map.keys().any(|key| key != "op" && key != "path")) {
        return Err("invalid_action".into());
    }
    let missing_ok = op == "exists";
    let rel = workspace_relative(root, raw, missing_ok)?;
    let target = root.join(&rel);
    let metadata = fs::symlink_metadata(&target);
    match op {
        "exists" => Ok(text(json!({"exists": metadata.is_ok()}))),
        "access" | "stat" => {
            let metadata = metadata.map_err(|_| "path_unavailable")?;
            Ok(text(json!({"exists": true, "directory": metadata.is_dir(), "size": metadata.len()})))
        }
        "readdir" => {
            if !metadata.map_err(|_| "path_unavailable")?.is_dir() {
                return Err("directory_unavailable".into());
            }
            let mut names: Vec<String> = fs::read_dir(&target)
                .map_err(|_| "directory_unavailable")?
                .filter_map(Result::ok)
                .take(MAX_DIR_ENTRIES * 4)
                .filter_map(|entry| {
                    let name = entry.file_name().into_string().ok()?;
                    let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                    relative(&path).ok()?;
                    checked(root, Path::new(&path), false).ok()?;
                    Some(name)
                })
                .collect();
            names.sort();
            let truncated = names.len() > MAX_DIR_ENTRIES;
            names.truncate(MAX_DIR_ENTRIES);
            Ok(text(json!({"entries": names, "truncated": truncated})))
        }
        "read" => {
            if rel.is_empty() {
                return Err("text_file_required".into());
            }
            let result = read_text(root, &rel, MAX_FILE_BYTES)?;
            Ok(text(json!({"content": result.content, "sizeBytes": result.size_bytes, "relativePath": rel})))
        }
        _ => Err("invalid_action".into()),
    }
}

pub enum WriteOp {
    /// Directory creation (each new component checked) or nothing to do.
    Mkdir { rel: String, needed: bool },
    Write(Change),
}

/// Validates a `hub_fs_write` request and builds the preview, before any
/// approval. Nothing is changed here.
pub fn plan_write(root: &Path, files: &Files, args: &Value) -> Result<WriteOp, String> {
    let op = args.get("op").and_then(Value::as_str).ok_or("invalid_action")?;
    let raw = args.get("path").and_then(Value::as_str).ok_or("invalid_action")?;
    let allowed = if op == "write" { &["op", "path", "content"][..] } else { &["op", "path"][..] };
    if args.as_object().is_some_and(|map| map.keys().any(|key| !allowed.contains(&key.as_str()))) {
        return Err("invalid_action".into());
    }
    match op {
        "mkdir" => {
            // Every missing component must still pass the name and link rules.
            let rel = lexical_relative(root, raw)?;
            checked(root, Path::new(""), false)?;
            let mut prefix = std::path::PathBuf::new();
            let mut needed = false;
            for part in Path::new(&rel).components() {
                prefix.push(part);
                match fs::symlink_metadata(root.join(&prefix)) {
                    Ok(metadata) if metadata.is_dir() => checked(root, &prefix, false).map(|_| ())?,
                    Ok(_) => return Err("directory_unavailable".into()),
                    Err(_) => {
                        needed = true;
                        break;
                    }
                }
            }
            Ok(WriteOp::Mkdir { rel, needed })
        }
        "write" => {
            let content = args.get("content").and_then(Value::as_str).ok_or("invalid_action")?;
            let rel = workspace_relative(root, raw, true)?;
            if rel.is_empty() {
                return Err("text_file_required".into());
            }
            files.native_write_allowed(&rel)?;
            Ok(WriteOp::Write(files.preview_native(root, &rel, content)?))
        }
        _ => Err("invalid_action".into()),
    }
}

pub fn apply_write(root: &Path, files: &mut Files, op: WriteOp) -> Result<Value, String> {
    match op {
        WriteOp::Mkdir { rel, needed } => {
            if needed {
                let mut prefix = std::path::PathBuf::new();
                for part in Path::new(&rel).components() {
                    prefix.push(part);
                    let path = root.join(&prefix);
                    match fs::symlink_metadata(&path) {
                        Ok(_) => {
                            checked(root, &prefix, false)?;
                        }
                        Err(_) => fs::create_dir(&path).map_err(|_| "directory_unavailable")?,
                    }
                }
            }
            Ok(json!({"path": rel, "created": needed}))
        }
        WriteOp::Write(change) => files.write_native(root, &change),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_tools::TestWorkspace;

    fn workspace() -> (TestWorkspace, TestWorkspace) {
        let make = |name: &str| {
            let path = std::env::temp_dir().join(format!("hub-native-{name}-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            TestWorkspace { path: path.canonicalize().unwrap() }
        };
        (make("ws"), make("outside"))
    }

    fn plain(path: &Path) -> String {
        path.to_string_lossy().trim_start_matches(r"\\?\").to_owned()
    }

    #[test]
    fn paths_inside_the_workspace_map_to_relative_ones() {
        let (ws, _outside) = workspace();
        fs::create_dir(ws.path.join("src")).unwrap();
        fs::write(ws.path.join("src/a.py"), "x = 1\n").unwrap();
        let root = plain(&ws.path);
        assert_eq!(workspace_relative(&ws.path, &root, false).unwrap(), "");
        assert_eq!(workspace_relative(&ws.path, &format!("{root}/src/a.py"), false).unwrap(), "src/a.py");
        assert_eq!(workspace_relative(&ws.path, &format!("{root}/src/../src/./a.py"), false).unwrap(), "src/a.py");
        if cfg!(windows) {
            assert_eq!(workspace_relative(&ws.path, &format!("{}\\src\\a.py", root.to_uppercase()), false).unwrap(), "src/a.py");
            assert_eq!(workspace_relative(&ws.path, &format!(r"\\?\{root}\src\a.py"), false).unwrap(), "src/a.py");
        }
        assert_eq!(workspace_relative(&ws.path, &format!("{root}/src/new.py"), true).unwrap(), "src/new.py");
    }

    #[test]
    fn every_native_operation_refuses_escapes() {
        let (ws, outside) = workspace();
        fs::write(outside.path.join("secret.txt"), "outside").unwrap();
        fs::write(ws.path.join(".env"), "hidden").unwrap();
        let root = plain(&ws.path);
        let escapes = [
            format!("{root}/../{}/secret.txt", outside.path.file_name().unwrap().to_string_lossy()),
            plain(&outside.path.join("secret.txt")),
            format!("{root}/../.."),
            r"\\server\share\x.txt".to_owned(),
            "relative.txt".to_owned(),
            format!("{root}/.env"),
            format!("{root}/x\0y"),
        ];
        let files = Files::default();
        for raw in &escapes {
            for op in ["read", "access", "stat", "readdir", "exists"] {
                assert!(read_op(&ws.path, &json!({"op":op,"path":raw})).is_err(), "{op} {raw}");
            }
            assert!(plan_write(&ws.path, &files, &json!({"op":"write","path":raw,"content":"x"})).is_err(), "write {raw}");
            assert!(plan_write(&ws.path, &files, &json!({"op":"mkdir","path":raw})).is_err(), "mkdir {raw}");
        }
        assert_eq!(fs::read_to_string(outside.path.join("secret.txt")).unwrap(), "outside");
        assert!(read_op(&ws.path, &json!({"op":"read","path":format!("{root}/a"),"extra":1})).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_inside_the_workspace_cannot_reach_outside() {
        let (ws, outside) = workspace();
        fs::write(outside.path.join("secret.txt"), "outside").unwrap();
        let link = ws.path.join("linked");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &plain(&link), &plain(&outside.path)])
            .output()
            .unwrap();
        assert!(status.status.success());
        let raw = format!("{}/linked/secret.txt", plain(&ws.path));
        let files = Files::default();
        assert_eq!(read_op(&ws.path, &json!({"op":"read","path":raw})).err().as_deref(), Some("linked_path_not_allowed"));
        assert!(plan_write(&ws.path, &files, &json!({"op":"write","path":raw,"content":"x"})).is_err());
        assert!(plan_write(&ws.path, &files, &json!({"op":"mkdir","path":format!("{}/linked/sub", plain(&ws.path))})).is_err());
        let listing = read_op(&ws.path, &json!({"op":"readdir","path":plain(&ws.path)})).unwrap();
        assert_eq!(listing.details["entries"], json!([]), "the junction is not listed");
        assert_eq!(fs::read_to_string(outside.path.join("secret.txt")).unwrap(), "outside");
        fs::remove_dir(&link).unwrap();
    }

    #[test]
    fn writes_create_directories_and_keep_previous_content_for_undo() {
        let (ws, _outside) = workspace();
        let root = plain(&ws.path);
        let mut files = Files::default();
        let mkdir = plan_write(&ws.path, &files, &json!({"op":"mkdir","path":format!("{root}/a/b")})).unwrap();
        apply_write(&ws.path, &mut files, mkdir).unwrap();
        assert!(ws.path.join("a/b").is_dir());
        let raw = format!("{root}/a/b/c.py");
        let WriteOp::Write(change) = plan_write(&ws.path, &files, &json!({"op":"write","path":raw,"content":"one\n"})).unwrap() else { panic!() };
        assert_eq!(change.before, "");
        apply_write(&ws.path, &mut files, WriteOp::Write(change)).unwrap();
        let WriteOp::Write(change) = plan_write(&ws.path, &files, &json!({"op":"write","path":raw,"content":"two\n"})).unwrap() else { panic!() };
        assert_eq!(change.before, "one\n", "the preview shows the real previous content");
        fs::write(ws.path.join("a/b/c.py"), "changed meanwhile\n").unwrap();
        assert_eq!(apply_write(&ws.path, &mut files, WriteOp::Write(change)).unwrap_err(), "file_changed_since_approval");
        assert_eq!(fs::read_to_string(ws.path.join("a/b/c.py")).unwrap(), "changed meanwhile\n");
        let read = read_op(&ws.path, &json!({"op":"read","path":raw})).unwrap();
        assert_eq!(read.details["content"], "changed meanwhile\n");
        let listing = read_op(&ws.path, &json!({"op":"readdir","path":format!("{root}/a/b")})).unwrap();
        assert_eq!(listing.details["entries"], json!(["c.py"]));
        assert_eq!(read_op(&ws.path, &json!({"op":"exists","path":format!("{root}/nope")})).unwrap().details["exists"], false);
    }
}
