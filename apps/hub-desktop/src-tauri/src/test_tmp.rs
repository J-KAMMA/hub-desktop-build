//! Test-only temp directory guard. Dropping it removes the directory, also when the test panics.
//! Tests must never leave folders in %TEMP% and never allocate real model sizes (disk filled up on 2026-11-06).
use std::path::{Path, PathBuf};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl std::ops::Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path { &self.0 }
}
impl AsRef<Path> for TempDir {
    fn as_ref(&self) -> &Path { &self.0 }
}
impl Drop for TempDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}
