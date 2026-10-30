//! Opens only the native-selected workspace. `cwd` is an equality guard.
use serde::Serialize;
use std::path::{Path, PathBuf};

const INVALID: &str = "pi_work_open_workspace_invalid_request";
const UNAVAILABLE: &str = "pi_work_open_workspace_workspace_unavailable";
const CHANGED: &str = "pi_work_open_workspace_workspace_changed";
const FAILED: &str = "pi_work_open_workspace_open_failed";
const UNSUPPORTED: &str = "pi_work_open_workspace_unsupported";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened { accepted: bool, workspace_path: String }

pub fn open(cwd: &str) -> Result<Opened, String> {
    open_selected(cwd, crate::dev_cli::workspace, launch)
}

fn open_selected(cwd: &str, mut selected: impl FnMut() -> Option<PathBuf>,
    launch: impl FnOnce(&Path) -> Result<(), &'static str>) -> Result<Opened, String> {
    if cwd.is_empty() || cwd.encode_utf16().count() > 32767 || cwd.chars().any(char::is_control)
        || cwd.contains('"') || !Path::new(cwd).is_absolute() { return Err(INVALID.into()); }
    let root = selected().ok_or(UNAVAILABLE)?;
    let display = crate::pi_work::non_verbatim(root.clone());
    if Path::new(cwd) != display { return Err(CHANGED.into()); }
    let workspace_path = display.to_str().filter(|path| !path.chars().any(char::is_control) && !path.contains('"'))
        .ok_or(UNAVAILABLE)?.to_owned();
    #[cfg(windows)]
    if !matches!(display.components().next(), Some(std::path::Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_))) { return Err(UNAVAILABLE.into()); }
    if !root.is_dir() || root.canonicalize().map_err(|_| UNAVAILABLE)? != root { return Err(UNAVAILABLE.into()); }
    if selected().as_ref() != Some(&root) { return Err(CHANGED.into()); }
    launch(&display).map_err(str::to_owned)?;
    Ok(Opened { accepted: true, workspace_path })
}

#[cfg(all(windows, not(test)))]
fn launch(path: &Path) -> Result<(), &'static str> {
    use windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW;
    let mut buffer = [0u16; 32768];
    let size = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if size == 0 || size >= buffer.len() { return Err(FAILED); }
    let directory = String::from_utf16(&buffer[..size]).map_err(|_| FAILED)?;
    let explorer = Path::new(&directory).join("explorer.exe");
    if !explorer.is_absolute() || !explorer.is_file() { return Err(FAILED); }
    std::process::Command::new(explorer).arg(path).stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map(|_| ()).map_err(|_| FAILED)
}

#[cfg(any(not(windows), test))]
fn launch(_: &Path) -> Result<(), &'static str> { Err(UNSUPPORTED) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, fs};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hub-workspace-open-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap(); Self(path.canonicalize().unwrap())
        }
        fn cwd(&self) -> String { crate::pi_work::non_verbatim(self.0.clone()).to_str().unwrap().into() }
    }
    impl Drop for Fixture { fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); } }

    #[test]
    fn selected_directory_is_opened_once_with_literal_unicode_spaces_and_ampersand() {
        let f = Fixture::new(); let nested = f.0.join("日本語 & folder"); fs::create_dir(&nested).unwrap();
        let root = nested.canonicalize().unwrap(); let cwd = crate::pi_work::non_verbatim(root.clone());
        let calls = Cell::new(0);
        let result = open_selected(cwd.to_str().unwrap(), || Some(root.clone()), |path| {
            calls.set(calls.get()+1); assert_eq!(path, cwd); Ok(())
        }).unwrap();
        assert_eq!(calls.get(),1); assert!(result.accepted); assert_eq!(result.workspace_path,cwd.to_str().unwrap());
    }

    #[test]
    fn invalid_input_never_resolves_or_launches() {
        for cwd in ["", "relative", "https://example.com", "C:\\folder\0", "C:\\folder\n", "C:\\folder\"bad"] {
            assert_eq!(open_selected(cwd, || panic!("invalid request resolved"), |_| panic!("invalid request launched")).unwrap_err(),INVALID);
        }
        assert_eq!(open_selected(&"x".repeat(32768), || panic!("long request resolved"), |_| panic!("long request launched")).unwrap_err(),INVALID);
    }

    #[test]
    fn missing_stale_and_changed_selection_never_launch() {
        let f = Fixture::new(); let other = Fixture::new();
        assert_eq!(open_selected(&f.cwd(), || None, |_| panic!("missing launched")).unwrap_err(),UNAVAILABLE);
        assert_eq!(open_selected(&other.cwd(), || Some(f.0.clone()), |_| panic!("stale launched")).unwrap_err(),CHANGED);
        let reads = Cell::new(0);
        assert_eq!(open_selected(&f.cwd(), || { reads.set(reads.get()+1); if reads.get()==1 { Some(f.0.clone()) } else { Some(other.0.clone()) } },
            |_| panic!("changed launched")).unwrap_err(),CHANGED);
    }

    #[test]
    fn a_selected_file_is_not_opened_as_a_workspace() {
        let f = Fixture::new(); let file = f.0.join("file"); fs::write(&file,b"x").unwrap();
        let file = file.canonicalize().unwrap(); let cwd = crate::pi_work::non_verbatim(file.clone());
        assert_eq!(open_selected(cwd.to_str().unwrap(), || Some(file.clone()), |_| panic!("file launched")).unwrap_err(),UNAVAILABLE);
    }

    #[test]
    fn os_failure_is_not_reported_as_accepted() {
        let f=Fixture::new(); assert_eq!(open_selected(&f.cwd(), || Some(f.0.clone()), |_| Err(FAILED)).unwrap_err(),FAILED);
    }
}
