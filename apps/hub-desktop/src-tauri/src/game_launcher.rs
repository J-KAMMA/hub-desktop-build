use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone)]
pub struct GameLibrary {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEntry {
    pub id: String,
    pub title: String,
    pub executable_path: String,
    pub added_at: u64,
    pub last_launched_at: Option<u64>,
}

#[derive(Default, Deserialize, Serialize)]
struct StoredLibrary {
    games: Vec<GameEntry>,
}

impl GameLibrary {
    pub fn load(app_data_dir: PathBuf) -> Result<Self, &'static str> {
        fs::create_dir_all(&app_data_dir).map_err(|_| "game_library_unavailable")?;
        let path = app_data_dir.join("games.json");
        if path.is_file() {
            read_library(&path)?;
        } else {
            save_library(&path, &StoredLibrary::default())?;
        }
        Ok(Self {
            path,
            lock: Arc::new(Mutex::new(())),
        })
    }

    pub async fn list(&self) -> Result<Vec<GameEntry>, &'static str> {
        let _guard = self.lock.lock().await;
        let mut games = read_library(&self.path)?.games;
        games.sort_by(|left, right| {
            right
                .last_launched_at
                .cmp(&left.last_launched_at)
                .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
        });
        Ok(games)
    }

    pub async fn add(&self, executable: &str) -> Result<GameEntry, &'static str> {
        let path = valid_executable(Path::new(executable))?;
        let _guard = self.lock.lock().await;
        let mut library = read_library(&self.path)?;
        let normalized = path.to_string_lossy().into_owned();
        if let Some(existing) = library
            .games
            .iter()
            .find(|game| same_path(&game.executable_path, &normalized))
        {
            return Ok(existing.clone());
        }
        let title = path
            .file_stem()
            .and_then(|name| name.to_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or("invalid_game_title")?
            .to_owned();
        let entry = GameEntry {
            id: Uuid::new_v4().to_string(),
            title,
            executable_path: normalized,
            added_at: now(),
            last_launched_at: None,
        };
        library.games.push(entry.clone());
        save_library(&self.path, &library)?;
        Ok(entry)
    }

    pub async fn rename(&self, id: &str, title: &str) -> Result<GameEntry, &'static str> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) {
            return Err("invalid_game_title");
        }
        let _guard = self.lock.lock().await;
        let mut library = read_library(&self.path)?;
        let game = library
            .games
            .iter_mut()
            .find(|game| game.id == id)
            .ok_or("game_not_found")?;
        game.title = title.to_owned();
        let result = game.clone();
        save_library(&self.path, &library)?;
        Ok(result)
    }

    pub async fn remove(&self, id: &str) -> Result<(), &'static str> {
        let _guard = self.lock.lock().await;
        let mut library = read_library(&self.path)?;
        let before = library.games.len();
        library.games.retain(|game| game.id != id);
        if library.games.len() == before {
            return Err("game_not_found");
        }
        save_library(&self.path, &library)
    }

    pub async fn launch(&self, id: &str) -> Result<GameEntry, &'static str> {
        let _guard = self.lock.lock().await;
        let mut library = read_library(&self.path)?;
        let game = library
            .games
            .iter_mut()
            .find(|game| game.id == id)
            .ok_or("game_not_found")?;
        let executable = valid_executable(Path::new(&game.executable_path))?;
        let parent = executable.parent().ok_or("invalid_game_path")?;
        Command::new(&executable)
            .current_dir(parent)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "game_launch_failed")?;
        game.last_launched_at = Some(now());
        let result = game.clone();
        save_library(&self.path, &library)?;
        Ok(result)
    }
}

fn valid_executable(path: &Path) -> Result<PathBuf, &'static str> {
    let canonical = fs::canonicalize(path).map_err(|_| "game_executable_missing")?;
    if !canonical.is_file() {
        return Err("game_executable_missing");
    }
    #[cfg(windows)]
    if !canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("game_executable_must_be_exe");
    }
    Ok(canonical)
}

fn same_path(left: &str, right: &str) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn read_library(path: &Path) -> Result<StoredLibrary, &'static str> {
    let bytes = fs::read(path).map_err(|_| "game_library_unavailable")?;
    let library: StoredLibrary =
        serde_json::from_slice(&bytes).map_err(|_| "game_library_invalid")?;
    if library.games.len() > 500
        || library.games.iter().any(|game| {
            game.id.is_empty()
                || game.title.is_empty()
                || game.title.chars().count() > 80
                || game.executable_path.is_empty()
        })
    {
        return Err("game_library_invalid");
    }
    Ok(library)
}

fn save_library(path: &Path, library: &StoredLibrary) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec_pretty(library).map_err(|_| "game_library_invalid")?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "game_library_unavailable")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "game_library_unavailable")?;
    atomic_replace(&temporary, path)
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), &'static str> {
    fs::rename(source, target).map_err(|_| "game_library_unavailable")
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), &'static str> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err("game_library_unavailable")
    } else {
        Ok(())
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("hub-games-test-{}", Uuid::new_v4()))
    }

    #[tokio::test]
    async fn persists_renames_and_removes_a_game_without_touching_the_executable() {
        let root = test_root();
        let executable = root.join(if cfg!(windows) {
            "sample.exe"
        } else {
            "sample"
        });
        fs::create_dir_all(&root).unwrap();
        fs::write(&executable, b"not actually launched").unwrap();
        let library = GameLibrary::load(root.clone()).unwrap();
        let added = library.add(executable.to_str().unwrap()).await.unwrap();
        assert_eq!(added.title, "sample");
        assert_eq!(
            library.add(executable.to_str().unwrap()).await.unwrap().id,
            added.id
        );
        assert_eq!(
            library.rename(&added.id, "My Game").await.unwrap().title,
            "My Game"
        );
        library.remove(&added.id).await.unwrap();
        assert!(library.list().await.unwrap().is_empty());
        assert!(executable.is_file(), "登録解除でゲーム本体を削除しないこと");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn rejects_missing_files_and_bad_titles() {
        let root = test_root();
        let library = GameLibrary::load(root.clone()).unwrap();
        assert_eq!(
            library
                .add(root.join("missing.exe").to_str().unwrap())
                .await
                .unwrap_err(),
            "game_executable_missing"
        );
        assert_eq!(
            library.rename("missing", "").await.unwrap_err(),
            "invalid_game_title"
        );
        let _ = fs::remove_dir_all(root);
    }
}
