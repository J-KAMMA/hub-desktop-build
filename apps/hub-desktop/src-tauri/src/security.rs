use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use subtle::ConstantTimeEq;

pub const MAX_CODE_BYTES: usize = 256 * 1024;
pub const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    #[error("invalid_request")]
    InvalidRequest,
    #[error("invalid_workspace")]
    InvalidWorkspace,
    #[error("unauthorized")]
    Unauthorized,
    #[error("capacity_exceeded")]
    CapacityExceeded,
}

pub fn secure_equals(expected: &str, supplied: &str) -> bool {
    expected.as_bytes().ct_eq(supplied.as_bytes()).into()
}

pub fn canonical_workspace_root(raw: &str) -> Result<PathBuf, SecurityError> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(SecurityError::InvalidWorkspace);
    }
    let result = path
        .canonicalize()
        .map_err(|_| SecurityError::InvalidWorkspace)?;
    if !result.is_dir() {
        return Err(SecurityError::InvalidWorkspace);
    }
    Ok(result)
}

pub fn contained_path(root: &Path, candidate: &Path) -> Result<PathBuf, SecurityError> {
    let root = root
        .canonicalize()
        .map_err(|_| SecurityError::InvalidWorkspace)?;
    let candidate = candidate
        .canonicalize()
        .map_err(|_| SecurityError::InvalidWorkspace)?;
    if candidate.starts_with(root) {
        Ok(candidate)
    } else {
        Err(SecurityError::InvalidWorkspace)
    }
}

pub fn allowed_origins() -> Result<HashSet<String>, SecurityError> {
    // 3030 is the port .claude/launch.json starts Hub on, so leaving it out
    // meant every panel that talks to this runner failed CORS during local
    // development while working in production.
    let raw = std::env::var("HUB_LOCAL_RUNNER_ORIGINS").unwrap_or_else(|_| "https://hub.jkamma.com,https://jkamma-hub-staging.jammakamma0.workers.dev,http://localhost:3020,http://127.0.0.1:3020,http://127.0.0.1:3021,http://localhost:3030,http://127.0.0.1:3030".into());
    let origins: HashSet<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(str::to_owned)
        .collect();
    if origins.is_empty()
        || origins.iter().any(|x| {
            x.contains('*')
                || !(x.starts_with("https://")
                    || x.starts_with("http://localhost:")
                    || x.starts_with("http://127.0.0.1:"))
        })
    {
        return Err(SecurityError::InvalidRequest);
    }
    Ok(origins)
}

pub fn validate_run(
    language: &str,
    code: &str,
    network: bool,
    timeout_ms: u64,
) -> Result<(), SecurityError> {
    if !matches!(language, "python" | "javascript")
        || code.is_empty()
        || code.len() > MAX_CODE_BYTES
        || network
        || timeout_ms == 0
        || timeout_ms > MAX_TIMEOUT_MS
    {
        return Err(SecurityError::InvalidRequest);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn rejects_parent_escape_after_canonicalization() {
        let base = std::env::temp_dir().join(format!("runner-path-{}", uuid::Uuid::new_v4()));
        let child = base.join("child");
        fs::create_dir_all(&child).unwrap();
        assert!(contained_path(&child, &base).is_err());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn validates_only_non_networked_supported_requests() {
        assert!(validate_run("python", "print(1)", false, 1).is_ok());
        assert!(validate_run("bash", "echo", false, 1).is_err());
        assert!(validate_run("python", "x", true, 1).is_err());
    }
    #[test]
    fn constant_time_check_requires_full_match() {
        assert!(secure_equals("abc", "abc"));
        assert!(!secure_equals("abc", "abcd"));
    }
}
