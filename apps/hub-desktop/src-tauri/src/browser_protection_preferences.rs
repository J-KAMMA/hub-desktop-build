//! Browser-local preference. Persist before changing the running matcher.
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::Path};
const ERROR: &str = "browser_protection_preferences_unavailable";
const LIMIT: u64 = 4096;
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Preference { version: u8, enabled: bool }

pub(super) fn read(path: &Path) -> Result<bool, String> {
    let input = match fs::File::open(path) {
        Ok(input) => input,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(_) => return Err(ERROR.into()),
    };
    if !input.metadata().map_err(|_| ERROR)?.is_file() { return Err(ERROR.into()); }
    let mut bytes = Vec::new();
    input.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    if bytes.len() as u64 > LIMIT { return Err(ERROR.into()); }
    let preference: Preference = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if preference.version != 1 { return Err(ERROR.into()); }
    Ok(preference.enabled)
}

pub(super) fn write(path: &Path, enabled: bool) -> Result<(), String> {
    let parent = path.parent().ok_or(ERROR)?;
    fs::create_dir_all(parent).map_err(|_| ERROR)?;
    let temporary = parent.join(format!("browser-protection-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(&Preference { version: 1, enabled }).map_err(|_| ERROR)?;
    let mut input = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| ERROR)?;
    let outcome = input.write_all(&bytes).and_then(|_| input.sync_all());
    drop(input);
    let outcome = outcome.and_then(|_| fs::rename(&temporary, path));
    if outcome.is_err() { let _ = fs::remove_file(&temporary); return Err(ERROR.into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Folder(std::path::PathBuf);
    impl Folder { fn new() -> Self { Self(std::env::temp_dir().join(format!("hub-protection-test-{}",uuid::Uuid::new_v4()))) } }
    impl Drop for Folder { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn default_enabled_and_round_trip_replacement() {
        let folder = Folder::new(); let path = folder.0.join("preference.json");
        assert_eq!(read(&path), Ok(true)); write(&path,false).unwrap(); assert_eq!(read(&path),Ok(false));
        write(&path,true).unwrap(); assert_eq!(read(&path),Ok(true));
        assert_eq!(fs::read_dir(&folder.0).unwrap().count(),1);
    }
    #[test]
    fn malformed_unknown_duplicate_and_oversized_never_disable() {
        let folder = Folder::new(); fs::create_dir_all(&folder.0).unwrap(); let path=folder.0.join("preference.json");
        for bytes in [b"null".to_vec(), br#"{"version":1,"enabled":"false"}"#.to_vec(),
            br#"{"version":2,"enabled":false}"#.to_vec(),br#"{"version":1,"enabled":false,"extra":true}"#.to_vec(),
            br#"{"version":1,"enabled":true,"enabled":false}"#.to_vec(),vec![b' ';LIMIT as usize+1],vec![0xff]] {
            fs::write(&path,bytes).unwrap(); assert!(read(&path).is_err());
        }
    }
    #[test]
    fn failed_replace_leaves_original_and_cleans_only_own_temporary() {
        let folder = Folder::new(); let path=folder.0.join("preference.json"); fs::create_dir_all(&path).unwrap();
        fs::write(path.join("keep"),b"original").unwrap();
        assert!(write(&path,false).is_err()); assert_eq!(fs::read(path.join("keep")).unwrap(),b"original");
        assert_eq!(fs::read_dir(&folder.0).unwrap().count(),1);
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SitePreference { version: u8, sites: Vec<String> }

/// Sites where blocking is off. A missing file means none; a broken file is an error (and blocking stays on).
pub(super) fn read_sites(path: &Path) -> Result<Vec<String>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(ERROR.into()),
    };
    if bytes.len() as u64 > 64 * 1024 { return Err(ERROR.into()); }
    let preference: SitePreference = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if preference.version != 1 || preference.sites.len() > 200 { return Err(ERROR.into()); }
    Ok(preference.sites)
}

pub(super) fn write_sites(path: &Path, sites: &[String]) -> Result<(), String> {
    let parent = path.parent().ok_or(ERROR)?;
    fs::create_dir_all(parent).map_err(|_| ERROR)?;
    let temporary = parent.join(format!("browser-protection-sites-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(&SitePreference { version: 1, sites: sites.to_vec() }).map_err(|_| ERROR)?;
    let outcome = fs::write(&temporary, bytes).and_then(|_| fs::rename(&temporary, path));
    if outcome.is_err() { let _ = fs::remove_file(&temporary); return Err(ERROR.into()); }
    Ok(())
}
