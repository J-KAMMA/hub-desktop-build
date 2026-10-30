//! Read-only filename candidates for the native-selected workspace. No file bodies.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const MAX_PATH_BYTES: usize = 8192;
const INVALID: &str = "pi_work_paths_invalid_request";
const UNAVAILABLE: &str = "pi_work_paths_unavailable";
const CHANGED: &str = "pi_work_paths_workspace_changed";

/// `cwd` confirms the current selection; it never grants filesystem authority.
/// Matching is ASCII case-insensitive substring matching, without Unicode folding/NFKC.
pub fn query(
    cwd: &str,
    query: &str,
    limit: usize,
    kind: Option<&str>,
    image_only: Option<bool>,
) -> Result<Value, String> {
    query_selected(
        cwd,
        query,
        limit,
        kind,
        image_only,
        crate::dev_cli::workspace,
    )
}

fn query_selected(
    cwd: &str,
    query: &str,
    limit: usize,
    kind: Option<&str>,
    image_only: Option<bool>,
    mut selected: impl FnMut() -> Option<PathBuf>,
) -> Result<Value, String> {
    validate(cwd, query, limit, kind, image_only)?;
    let root = selected().ok_or("pi_work_paths_workspace_unavailable")?;
    let display = crate::pi_work::non_verbatim(root.clone());
    if Path::new(cwd) != display {
        return Err(CHANGED.into());
    }
    let workspace_path = display
        .to_str()
        .filter(|value| !value.chars().any(char::is_control))
        .ok_or(UNAVAILABLE)?;
    let map = crate::agent_discovery::project_map(&root).map_err(|_| UNAVAILABLE)?;
    let result = candidates(&root, workspace_path, map, query.trim(), limit, kind)?;
    if selected().as_ref() != Some(&root) {
        return Err(CHANGED.into());
    }
    Ok(result)
}

fn validate(
    cwd: &str,
    query: &str,
    limit: usize,
    kind: Option<&str>,
    image_only: Option<bool>,
) -> Result<(), String> {
    let needle = query.trim();
    if cwd.is_empty()
        || cwd.encode_utf16().count() > 32768
        || cwd.chars().any(char::is_control)
        || query.encode_utf16().count() > 256
        || query.chars().any(char::is_control)
        || needle.starts_with('/')
        || needle.contains(['\\', ':'])
        || needle.split('/').any(|part| matches!(part, "." | ".."))
        || !(1..=200).contains(&limit)
        || !matches!(kind, None | Some("file" | "directory"))
    {
        return Err(INVALID.into());
    }
    if image_only == Some(true) {
        return Err("pi_work_paths_unsupported".into());
    }
    // Rust strings are valid Unicode; invalid UTF-16 is rejected by IPC JSON decoding.
    Ok(())
}

fn checked_kind(root: &Path, path: &str, directory: bool) -> bool {
    crate::agent_tools::relative(path).is_ok()
        && crate::agent_tools::checked(root, Path::new(path), false)
            .ok()
            .and_then(|path| fs::symlink_metadata(path).ok())
            .is_some_and(|metadata| {
                if directory {
                    metadata.is_dir()
                } else {
                    metadata.is_file()
                }
            })
}

fn candidates(
    root: &Path,
    workspace_path: &str,
    map: Value,
    query: &str,
    limit: usize,
    kind: Option<&str>,
) -> Result<Value, String> {
    let files = map
        .get("files")
        .and_then(Value::as_array)
        .ok_or(UNAVAILABLE)?;
    let mut truncated = map
        .get("truncated")
        .and_then(Value::as_bool)
        .ok_or(UNAVAILABLE)?;
    if map.get("readOnly") != Some(&Value::Bool(true)) {
        return Err(UNAVAILABLE.into());
    }
    let mut paths = BTreeMap::new();
    for file in files {
        let path = file.as_str().ok_or(UNAVAILABLE)?;
        if !checked_kind(root, path, false) {
            continue;
        }
        paths.insert(path.to_owned(), "file");
        // Only parents of allowed existing text-file paths become directory candidates.
        for parent in Path::new(path)
            .ancestors()
            .skip(1)
            .filter_map(Path::to_str)
            .filter(|path| !path.is_empty())
        {
            if !paths.contains_key(parent) && checked_kind(root, parent, true) {
                paths.insert(parent.to_owned(), "directory");
            }
        }
    }
    let needle = query.to_ascii_lowercase();
    let mut entries = Vec::new();
    let mut bytes = 0;
    for (path, entry_kind) in paths {
        if kind.is_some_and(|wanted| wanted != entry_kind)
            || !path.to_ascii_lowercase().contains(&needle)
        {
            continue;
        }
        if entries.len() == limit || bytes + path.len() > MAX_PATH_BYTES {
            truncated = true;
            break;
        }
        bytes += path.len();
        entries.push(json!({"path":path,"kind":entry_kind}));
    }
    Ok(
        json!({"workspacePath":workspace_path,"entries":entries,"truncated":truncated,"readOnly":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> crate::agent_tools::TestWorkspace {
        let path =
            std::env::temp_dir().join(format!("hub-workspace-paths-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        crate::agent_tools::TestWorkspace {
            path: path.canonicalize().unwrap(),
        }
    }
    fn cwd(root: &Path) -> String {
        crate::pi_work::non_verbatim(root.to_owned())
            .to_str()
            .unwrap()
            .to_owned()
    }
    fn lookup(root: &Path, query: &str, limit: usize, kind: Option<&str>) -> Value {
        query_selected(&cwd(root), query, limit, kind, None, || {
            Some(root.to_owned())
        })
        .unwrap()
    }
    fn write(root: &Path, path: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![255; 65536]).unwrap();
    }
    #[test]
    fn metadata_only_map_and_checked_parents_exclude_secrets_hidden_and_nontext_paths() {
        let root = workspace();
        for path in [
            "src/Nested/Metrics.rs",
            "src/日本語.ts",
            ".hidden/a.json",
            "secrets/key.rs",
            "credentials/data.json",
            "src/key.pem",
            "src/account.db",
            "src/.env",
            "images/picture.png",
        ] {
            write(&root.path, path);
        }
        fs::create_dir(root.path.join("empty")).unwrap();
        let result = lookup(&root.path, "", 200, None);
        assert_eq!(
            result["entries"],
            json!([
                {"path":"src","kind":"directory"}, {"path":"src/Nested","kind":"directory"},
                {"path":"src/Nested/Metrics.rs","kind":"file"}, {"path":"src/日本語.ts","kind":"file"}
            ])
        );
        assert_eq!(result["readOnly"], true);
        assert_eq!(result["workspacePath"], cwd(&root.path));
        assert_eq!(result.as_object().unwrap().len(), 4);
        assert!(result.get("ignored").is_none());
        // Invalid UTF-8, oversized bodies are deliberately present: filenames require no reads.
        assert!(!result.to_string().contains("contents"));
    }
    #[test]
    fn substring_kind_and_ascii_case_rules_preserve_original_paths() {
        let root = workspace();
        for path in ["src/Metrics.rs", "src/Ä.ts", "src/日本語.ts"] {
            write(&root.path, path);
        }
        assert_eq!(
            lookup(&root.path, "METRICS", 200, Some("file"))["entries"],
            json!([{"path":"src/Metrics.rs","kind":"file"}])
        );
        assert_eq!(
            lookup(&root.path, "src/", 200, Some("directory"))["entries"],
            json!([])
        );
        assert_eq!(
            lookup(&root.path, "SRC", 200, Some("directory"))["entries"],
            json!([{"path":"src","kind":"directory"}])
        );
        assert_eq!(lookup(&root.path, "ä", 200, None)["entries"], json!([]));
        assert_eq!(
            lookup(&root.path, "日本", 200, None)["entries"],
            json!([{"path":"src/日本語.ts","kind":"file"}])
        );
    }
    #[test]
    fn invalid_requests_are_rejected_before_workspace_resolution_or_scanning() {
        for query in [
            "/absolute",
            "../outside",
            "src/../outside",
            "src/./file",
            "C:/outside",
            "\\\\host\\share",
            "nul\0",
            "line\nfeed",
        ] {
            assert_eq!(
                query_selected("scope", query, 10, None, None, || panic!(
                    "must not resolve workspace"
                ))
                .unwrap_err(),
                INVALID
            );
        }
        for (limit, kind, image_only) in [
            (0, None, None),
            (201, None, None),
            (1, Some("unknown"), None),
            (1, None, Some(true)),
        ] {
            assert!(
                query_selected("scope", "", limit, kind, image_only, || panic!(
                    "must not resolve workspace"
                ))
                .is_err()
            );
        }
        assert_eq!(
            query_selected("scope", &"🧪".repeat(129), 1, None, None, || panic!(
                "must not resolve workspace"
            ))
            .unwrap_err(),
            INVALID
        );
        assert!(serde_json::from_str::<String>(r#""\ud800""#).is_err());
        let root = workspace();
        assert_eq!(
            lookup(&root.path, &"🧪".repeat(128), 1, None)["entries"],
            json!([])
        );
    }
    #[test]
    fn current_selection_is_authority_and_old_cwd_or_changed_selection_never_returns_candidates() {
        let root = workspace();
        let next = workspace();
        write(&root.path, "valid.rs");
        assert_eq!(
            query_selected(&cwd(&root.path), "", 10, None, None, || None).unwrap_err(),
            "pi_work_paths_workspace_unavailable"
        );
        assert_eq!(
            query_selected(&cwd(&next.path), "", 10, None, None, || Some(
                root.path.clone()
            ))
            .unwrap_err(),
            CHANGED
        );
        let mut calls = 0;
        assert_eq!(
            query_selected(&cwd(&root.path), "", 10, None, None, || {
                calls += 1;
                Some(if calls == 1 {
                    root.path.clone()
                } else {
                    next.path.clone()
                })
            })
            .unwrap_err(),
            CHANGED
        );
        assert_eq!(calls, 2);
    }
    #[test]
    fn real_map_truncation_and_requested_limit_are_never_hidden() {
        let root = workspace();
        for i in 0..140 {
            write(&root.path, &format!("{i:03}.rs"));
        }
        let result = lookup(&root.path, "", 200, None);
        assert_eq!(result["entries"].as_array().unwrap().len(), 128);
        assert_eq!(result["truncated"], true);
        assert_eq!(
            lookup(&root.path, "does-not-match", 200, None)["truncated"],
            true
        );
        let small = workspace();
        for path in ["a.rs", "b.rs"] {
            write(&small.path, path);
        }
        assert_eq!(lookup(&small.path, "", 1, None)["truncated"], true);
        assert_eq!(lookup(&small.path, "a.rs", 1, None)["truncated"], false);
    }
    #[test]
    fn utf8_path_bytes_and_derived_directories_have_their_own_total_budget() {
        let root = workspace();
        for i in 0..50 {
            write(&root.path, &format!("{i:03}{}.rs", "長".repeat(60)));
        }
        let result = lookup(&root.path, "", 200, None);
        assert_eq!(result["truncated"], true);
        assert!(
            result["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["path"].as_str().unwrap().len())
                .sum::<usize>()
                <= MAX_PATH_BYTES
        );
        let derived = workspace();
        for i in 0..50 {
            write(
                &derived.path,
                &format!("dir-{i:02}-{}/file.rs", "a".repeat(80)),
            );
        }
        assert_eq!(
            crate::agent_discovery::project_map(&derived.path).unwrap()["truncated"],
            false
        );
        let result = lookup(&derived.path, "", 200, None);
        assert_eq!(result["truncated"], true);
        assert!(
            result["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["path"].as_str().unwrap().len())
                .sum::<usize>()
                <= MAX_PATH_BYTES
        );
    }
    #[test]
    fn relative_240_byte_gate_does_not_expose_overwidth_filenames() {
        let root = workspace();
        write(&root.path, &format!("{}.rs", "a".repeat(237)));
        write(&root.path, &format!("{}.rs", "b".repeat(238)));
        let result = lookup(&root.path, "", 200, None);
        assert_eq!(result["entries"].as_array().unwrap().len(), 1);
        assert_eq!(result["entries"][0]["path"].as_str().unwrap().len(), 240);
    }
    #[cfg(unix)]
    #[test]
    fn symlink_file_and_directory_candidates_are_excluded() {
        let root = workspace();
        let outside = workspace();
        write(&outside.path, "external.rs");
        std::os::unix::fs::symlink(
            outside.path.join("external.rs"),
            root.path.join("linked.rs"),
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside.path, root.path.join("linked")).unwrap();
        assert_eq!(lookup(&root.path, "", 200, None)["entries"], json!([]));
    }
    #[cfg(windows)]
    #[test]
    fn synthetic_junction_is_excluded_without_scanning_its_target() {
        use std::os::windows::process::CommandExt;
        let root = workspace();
        let outside = workspace();
        write(&outside.path, "external.rs");
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
        assert_eq!(lookup(&root.path, "", 200, None)["entries"], json!([]));
        fs::remove_dir(link).unwrap();
    }
}
