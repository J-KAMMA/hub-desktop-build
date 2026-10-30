use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub id: String,
    pub workspace: String,
    pub git_root: String,
    pub git_head: Option<String>,
    pub baseline_fingerprint: String,
    pub dirty_paths: Vec<String>,
    pub created_at_ms: u128,
}

fn git_output(directory: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = crate::local_cli::quiet_std_command("git")
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

pub fn capture(
    workspace: &Path,
    run_id: &str,
    now_ms: u128,
) -> Result<WorkspaceSnapshot, &'static str> {
    let workspace = workspace
        .canonicalize()
        .map_err(|_| "workspace unavailable")?;
    let root = crate::dev_cli::git_root(&workspace).ok_or("git workspace required")?;
    let head = git_output(&root, &["rev-parse", "HEAD"])
        .and_then(|value| String::from_utf8(value).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let status = git_output(
        &workspace,
        &["status", "--porcelain", "--untracked-files=all", "--", "."],
    )
    .ok_or("workspace snapshot unavailable")?;
    let dirty_paths = String::from_utf8_lossy(&status)
        .lines()
        .filter_map(|line| {
            line.get(3..)
                .map(|path| path.trim().trim_matches('"').to_owned())
        })
        .collect::<Vec<_>>();
    let mut fingerprint_source = head.clone().unwrap_or_default().into_bytes();
    fingerprint_source.extend_from_slice(&status);
    Ok(WorkspaceSnapshot {
        id: format!("snapshot-{run_id}"),
        workspace: workspace.to_string_lossy().into_owned(),
        git_root: root.to_string_lossy().into_owned(),
        git_head: head,
        baseline_fingerprint: format!("{:x}", Sha256::digest(fingerprint_source)),
        dirty_paths,
        created_at_ms: now_ms,
    })
}

fn safe_root(snapshot: &WorkspaceSnapshot) -> Option<PathBuf> {
    let root = PathBuf::from(&snapshot.git_root).canonicalize().ok()?;
    let workspace = PathBuf::from(&snapshot.workspace).canonicalize().ok()?;
    workspace.starts_with(&root).then_some(root)
}

fn safe_relative(snapshot: &WorkspaceSnapshot, relative: &str) -> Option<(PathBuf, PathBuf)> {
    if relative.is_empty() || relative.contains(" -> ") || Path::new(relative).is_absolute() {
        return None;
    }
    let root = safe_root(snapshot)?;
    let target = root.join(relative);
    let parent = target.parent()?;
    let existing_parent = parent
        .ancestors()
        .find(|item| item.exists())?
        .canonicalize()
        .ok()?;
    existing_parent.starts_with(&root).then_some((root, target))
}

pub fn baseline_bytes(snapshot: &WorkspaceSnapshot, relative: &str) -> Option<Vec<u8>> {
    let (root, _) = safe_relative(snapshot, relative)?;
    let head = snapshot.git_head.as_deref()?;
    git_output(&root, &["show", &format!("{head}:{relative}")])
}

pub fn remove_created(snapshot: &WorkspaceSnapshot, relative: &str) -> bool {
    let Some((_, target)) = safe_relative(snapshot, relative) else {
        return false;
    };
    if !target.is_file() {
        return false;
    }
    std::fs::remove_file(target).is_ok()
}

pub fn restore_tracked(snapshot: &WorkspaceSnapshot, relative: &str) -> bool {
    let Some((root, target)) = safe_relative(snapshot, relative) else {
        return false;
    };
    if std::fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return false;
    }
    if target.exists()
        && !target
            .canonicalize()
            .is_ok_and(|path| path.starts_with(&root))
    {
        return false;
    }
    let Some(bytes) = baseline_bytes(snapshot, relative) else {
        return false;
    };
    let Some(parent) = target.parent() else {
        return false;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    std::fs::write(target, bytes).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_and_renamed_paths() {
        let snapshot = WorkspaceSnapshot::default();
        assert!(safe_relative(&snapshot, "C:/outside.txt").is_none());
        assert!(safe_relative(&snapshot, "a -> b").is_none());
    }
}
