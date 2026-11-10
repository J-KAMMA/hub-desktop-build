//! この PC のゲーム（2026-11-06）。Steam と Epic が端末に置いた記録を読むだけで、起動台の設定やファイルは書き換えない。
//! 一覧は端末の外へ出さない（Hub へ送らない）。起動はランチャーのプロトコル（steam:// / com.epicgames.launcher://）だけ。
//! 画面が渡せるのは一覧で返した id だけで、パスや URL は渡せない。起動時にもう一度読んで id を引く。
use std::path::{Path, PathBuf};

// ---------- 一覧の型 ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source { Steam, Epic }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledGame {
    pub id: String,
    pub source: Source,
    pub name: String,
    pub install_dir: PathBuf,
    /// Steam の appid、Epic の AppName。
    pub native_id: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct GameRow { pub id: String, pub source: Source, pub name: String }

#[derive(Debug, Default, serde::Serialize)]
pub struct Library { pub games: Vec<GameRow>, pub notes: Vec<&'static str> }

// ---------- Valve の KeyValues（vdf / acf） ----------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Vdf { Str(String), Map(Vec<(String, Vdf)>) }

impl Vdf {
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self { Vdf::Map(items) => items.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v), Vdf::Str(_) => None }
    }
    pub fn text(&self) -> Option<&str> { match self { Vdf::Str(s) => Some(s), Vdf::Map(_) => None } }
    pub fn text_of(&self, key: &str) -> Option<&str> { self.get(key).and_then(Vdf::text) }
    pub fn entries(&self) -> &[(String, Vdf)] { match self { Vdf::Map(items) => items, Vdf::Str(_) => &[] } }
}

struct Lexer<'a> { bytes: &'a [u8], at: usize }

enum Token { Text(String), Open, Close }

impl<'a> Lexer<'a> {
    fn skip(&mut self) {
        loop {
            while self.at < self.bytes.len() && self.bytes[self.at].is_ascii_whitespace() { self.at += 1; }
            if self.bytes.get(self.at) == Some(&b'/') && self.bytes.get(self.at + 1) == Some(&b'/') {
                while self.at < self.bytes.len() && self.bytes[self.at] != b'\n' { self.at += 1; }
            } else { return; }
        }
    }
    fn next(&mut self) -> Option<Result<Token, ()>> {
        self.skip();
        let byte = *self.bytes.get(self.at)?;
        match byte {
            b'{' => { self.at += 1; Some(Ok(Token::Open)) }
            b'}' => { self.at += 1; Some(Ok(Token::Close)) }
            b'"' => {
                self.at += 1;
                let mut out = Vec::new();
                while let Some(&b) = self.bytes.get(self.at) {
                    self.at += 1;
                    match b {
                        b'"' => return Some(Ok(Token::Text(String::from_utf8_lossy(&out).into_owned()))),
                        b'\\' => {
                            let escaped = *self.bytes.get(self.at)?; self.at += 1;
                            out.push(match escaped { b'n' => b'\n', b't' => b'\t', other => other });
                        }
                        other => out.push(other),
                    }
                }
                Some(Err(())) // 閉じていない引用符
            }
            _ => Some(Err(())), // 引用符なしの語は Steam の記録には現れない。壊れた入力として退ける。
        }
    }
}

const MAX_DEPTH: usize = 16;

fn parse_map(lexer: &mut Lexer, depth: usize, top: bool) -> Result<Vec<(String, Vdf)>, ()> {
    if depth > MAX_DEPTH { return Err(()); }
    let mut items = Vec::new();
    loop {
        match lexer.next() {
            None => return if top { Ok(items) } else { Err(()) },
            Some(Err(())) => return Err(()),
            Some(Ok(Token::Close)) => return if top { Err(()) } else { Ok(items) },
            Some(Ok(Token::Open)) => return Err(()),
            Some(Ok(Token::Text(key))) => match lexer.next() {
                Some(Ok(Token::Text(value))) => items.push((key, Vdf::Str(value))),
                Some(Ok(Token::Open)) => items.push((key, Vdf::Map(parse_map(lexer, depth + 1, false)?))),
                _ => return Err(()),
            },
        }
    }
}

/// 壊れた記録は None。パニックしない。
pub fn parse_vdf(text: &str) -> Option<Vdf> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lexer = Lexer { bytes: text.as_bytes(), at: 0 };
    parse_map(&mut lexer, 0, true).ok().map(Vdf::Map)
}

/// `libraryfolders.vdf` からライブラリの場所を返す。新形式（"0" { "path" ... }）と旧形式（"1" "D:\\..."）の両方。
pub fn parse_library_folders(text: &str) -> Vec<String> {
    let Some(root) = parse_vdf(text) else { return Vec::new() };
    let Some(folders) = root.get("libraryfolders") else { return Vec::new() };
    let mut out = Vec::new();
    for (key, value) in folders.entries() {
        if !key.bytes().all(|b| b.is_ascii_digit()) || key.is_empty() { continue; }
        let path = match value { Vdf::Str(s) => Some(s.as_str()), Vdf::Map(_) => value.text_of("path") };
        if let Some(path) = path.map(str::trim).filter(|p| !p.is_empty()) { out.push(path.to_owned()); }
    }
    out
}

const TOOL_APP_IDS: &[&str] = &["228980", "1070560", "1391110", "1493710", "1628350", "250820"];

fn steam_app_id_ok(id: &str) -> bool { !id.is_empty() && id.len() <= 12 && id.bytes().all(|b| b.is_ascii_digit()) }

/// `appmanifest_*.acf`。入りきっていない・道具（共通再頒布物や Proton）は None。
pub fn parse_steam_manifest(text: &str, library: &Path) -> Option<InstalledGame> {
    let root = parse_vdf(text)?;
    let state = root.get("AppState")?;
    let appid = state.text_of("appid")?.trim();
    if !steam_app_id_ok(appid) || TOOL_APP_IDS.contains(&appid) { return None; }
    let name = state.text_of("name")?.trim();
    let installdir = state.text_of("installdir")?.trim();
    if name.is_empty() || installdir.is_empty() || installdir.contains(['/', '\\']) || installdir == ".." || installdir == "." { return None; }
    if name.starts_with("Proton ") || name.starts_with("Steam Linux Runtime") || name.starts_with("Steamworks Common") { return None; }
    let flags: u64 = state.text_of("StateFlags").and_then(|f| f.trim().parse().ok()).unwrap_or(0);
    if flags & 4 == 0 { return None; } // 4 = 完全に入っている
    Some(InstalledGame {
        id: format!("steam:{appid}"), source: Source::Steam, name: name.to_owned(), native_id: appid.to_owned(),
        install_dir: library.join("steamapps").join("common").join(installdir),
    })
}

// ---------- Epic ----------

fn epic_app_name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':'))
}

pub fn parse_epic_manifest(text: &str) -> Option<InstalledGame> {
    let value: serde_json::Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text)).ok()?;
    let name = value.get("DisplayName")?.as_str()?.trim();
    let app = value.get("AppName")?.as_str()?.trim();
    let dir = value.get("InstallLocation")?.as_str()?.trim();
    if name.is_empty() || dir.is_empty() || !epic_app_name_ok(app) { return None; }
    if value.get("bIsIncompleteInstall").and_then(serde_json::Value::as_bool) == Some(true) { return None; }
    if let Some(categories) = value.get("AppCategories").and_then(serde_json::Value::as_array) {
        if !categories.iter().any(|c| c.as_str() == Some("games")) { return None; }
    }
    Some(InstalledGame { id: format!("epic:{app}"), source: Source::Epic, name: name.to_owned(), native_id: app.to_owned(), install_dir: PathBuf::from(dir) })
}

// ---------- 起動 URL ----------

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') { out.push(b as char); } else { out.push_str(&format!("%{b:02X}")); }
    }
    out
}

/// 起動 URL。許す文字を外れる id は None（URL を組み立てない）。
pub fn launch_url(game: &InstalledGame) -> Option<String> {
    match game.source {
        Source::Steam => steam_app_id_ok(&game.native_id).then(|| format!("steam://rungameid/{}", game.native_id)),
        Source::Epic => epic_app_name_ok(&game.native_id).then(|| format!("com.epicgames.launcher://apps/{}?action=launch&silent=true", percent_encode(&game.native_id))),
    }
}

// ---------- 端末を読む ----------

#[derive(Clone, Debug, Default)]
pub struct Roots { pub steam: Option<PathBuf>, pub epic_manifests: Option<PathBuf> }

#[cfg(windows)]
fn steam_path_from_registry() -> Option<PathBuf> {
    use windows_sys::Win32::{Foundation::ERROR_SUCCESS, System::Registry::{RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, REG_SZ}};
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }
    let path = wide(r"Software\Valve\Steam");
    let name = wide("SteamPath");
    let mut key: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_QUERY_VALUE, &mut key) } != ERROR_SUCCESS { return None; }
    let mut kind = 0u32;
    let mut buffer = vec![0u16; 1024];
    let mut length = (buffer.len() * 2) as u32;
    let status = unsafe { RegQueryValueExW(key, name.as_ptr(), std::ptr::null_mut(), &mut kind, buffer.as_mut_ptr().cast(), &mut length) };
    unsafe { RegCloseKey(key); }
    if status != ERROR_SUCCESS || kind != REG_SZ { return None; }
    let units = (length as usize / 2).min(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..units]);
    let text = text.trim_end_matches('\0').trim();
    (!text.is_empty()).then(|| PathBuf::from(text))
}
#[cfg(not(windows))]
fn steam_path_from_registry() -> Option<PathBuf> { None }

pub fn system_roots() -> Roots {
    Roots {
        steam: steam_path_from_registry(),
        epic_manifests: std::env::var_os("ProgramData").map(|d| PathBuf::from(d).join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests")),
    }
}

fn read_limited(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > 2 * 1024 * 1024 { return None; }
    std::fs::read_to_string(path).ok()
}

pub fn scan_steam(steam: &Path) -> Vec<InstalledGame> {
    let mut libraries: Vec<PathBuf> = vec![steam.to_path_buf()];
    if let Some(text) = read_limited(&steam.join("steamapps").join("libraryfolders.vdf")) {
        for folder in parse_library_folders(&text) {
            let folder = PathBuf::from(folder);
            if !libraries.contains(&folder) { libraries.push(folder); }
        }
    }
    let mut out = Vec::new();
    for library in libraries {
        let Ok(entries) = std::fs::read_dir(library.join("steamapps")) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) { continue; }
            if let Some(game) = read_limited(&entry.path()).and_then(|text| parse_steam_manifest(&text, &library)) {
                if !out.iter().any(|g: &InstalledGame| g.id == game.id) { out.push(game); }
            }
        }
    }
    out
}

pub fn scan_epic(manifests: &Path) -> Vec<InstalledGame> {
    let Ok(entries) = std::fs::read_dir(manifests) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("item") { continue; }
        if let Some(game) = read_limited(&entry.path()).and_then(|text| parse_epic_manifest(&text)) {
            if !out.iter().any(|g: &InstalledGame| g.id == game.id) { out.push(game); }
        }
    }
    out
}

pub fn scan(roots: &Roots) -> Vec<InstalledGame> {
    let mut games = Vec::new();
    if let Some(steam) = &roots.steam { games.extend(scan_steam(steam)); }
    if let Some(epic) = &roots.epic_manifests { games.extend(scan_epic(epic)); }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    games
}

/// Xbox / Microsoft Store のゲームは、管理者権限なしでは確実に読めない（WindowsApps は一般利用者に閉じている）ので対象外。
pub const NOTE_XBOX_OMITTED: &str = "xbox_not_supported";

pub fn library(roots: &Roots) -> Library {
    let games = scan(roots).into_iter().map(|g| GameRow { id: g.id, source: g.source, name: g.name }).collect();
    Library { games, notes: vec![NOTE_XBOX_OMITTED] }
}

pub fn find(roots: &Roots, id: &str) -> Option<InstalledGame> { scan(roots).into_iter().find(|g| g.id == id) }

// ---------- 絵（端末の中だけ） ----------

fn is_image(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("jpg" | "jpeg" | "png"))
}

fn art_rank(name: &str) -> Option<u8> {
    let lower = name.to_ascii_lowercase();
    if lower.contains("library_600x900") { Some(0) }
    else if lower.contains("library_capsule") || lower.contains("capsule_616x353") { Some(1) }
    else if lower.contains("header") { Some(2) }
    else if lower.contains("library_hero") { Some(4) }
    else if lower.contains("logo") || lower.contains("icon") { None }
    else { Some(5) }
}

/// Steam の `appcache/librarycache` から絵を選ぶ。旧配置（<appid>_*.jpg）と新配置（<appid>/<hash>/*.jpg）の両方。
pub fn steam_art_path(steam: &Path, appid: &str) -> Option<PathBuf> {
    if !steam_app_id_ok(appid) { return None; }
    let cache = steam.join("appcache").join("librarycache");
    let mut found: Vec<(u8, PathBuf)> = Vec::new();
    let prefix = format!("{appid}_");
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if name.starts_with(&prefix) && is_image(&path) { if let Some(rank) = art_rank(&name) { found.push((rank, path)); } }
        }
    }
    let dir = cache.join(appid);
    let mut stack = vec![(dir, 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() { if depth < 2 { stack.push((path, depth + 1)); } continue; }
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_image(&path) { if let Some(rank) = art_rank(&name) { found.push((rank, path)); } }
        }
    }
    found.sort();
    found.into_iter().next().map(|(_, p)| p)
}

pub fn art_data_url(path: &Path) -> Option<String> {
    use base64::Engine;
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() == 0 || meta.len() > 1_500_000 { return None; }
    let bytes = std::fs::read(path).ok()?;
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "image/png" } else if bytes.starts_with(&[0xFF, 0xD8]) { "image/jpeg" } else { return None; };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

// ---------- 起動 ----------

pub fn open_protocol(url: &str) -> Result<(), String> {
    if !(url.starts_with("steam://rungameid/") || url.starts_with("com.epicgames.launcher://apps/")) { return Err("invalid_launch_url".into()); }
    #[cfg(windows)]
    let spawn = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(target_os = "macos")]
    let spawn = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawn = std::process::Command::new("xdg-open").arg(url).spawn();
    spawn.map(|_| ()).map_err(|_| "launch_failed".to_owned())
}

pub fn launch(roots: &Roots, id: &str) -> Result<InstalledGame, String> {
    let game = find(roots, id).ok_or_else(|| "game_not_found".to_owned())?;
    let url = launch_url(&game).ok_or_else(|| "invalid_launch_url".to_owned())?;
    open_protocol(&url)?;
    Ok(game)
}

// ---------- Tauri ----------

#[tauri::command]
pub async fn pc_games_list() -> Result<Library, String> {
    tokio::task::spawn_blocking(|| library(&system_roots())).await.map_err(|_| "scan_failed".to_owned())
}

#[tauri::command]
pub async fn pc_game_art(id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let roots = system_roots();
        let appid = id.strip_prefix("steam:")?;
        let steam = roots.steam?;
        steam_art_path(&steam, appid).and_then(|p| art_data_url(&p))
    }).await.map_err(|_| "art_failed".to_owned())
}

#[tauri::command]
pub async fn pc_game_launch(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || launch(&system_roots(), &id).map(|_| ())).await.map_err(|_| "launch_failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pc-games-{tag}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const LIBRARY_NEW: &str = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"X:\\Fixture\\Steam"
		"label"		""
		"apps"
		{
			"111"		"1000"
		}
	}
	"1"
	{
		"path"		"Y:\\Fixture\\Library Two"
	}
	"contentstatsid"	"123"
}
"#;
    const LIBRARY_OLD: &str = "\"LibraryFolders\"\n{\n\t\"TimeNextStatsReport\"\t\"1\"\n\t\"1\"\t\t\"Z:\\\\Fixture\\\\Old\"\n}\n";
    const ACF: &str = "\"AppState\"\n{\n\t\"appid\"\t\t\"111\"\n\t\"name\"\t\t\"Fixture Quest \\\"Deluxe\\\"\"\n\t\"StateFlags\"\t\t\"4\"\n\t\"installdir\"\t\t\"Fixture Quest\"\n\t// comment\n\t\"UserConfig\"\n\t{\n\t\t\"language\"\t\t\"english\"\n\t}\n}\n";

    #[test]
    fn vdf_parses_nested_maps_escapes_and_comments() {
        let root = parse_vdf(ACF).unwrap();
        let state = root.get("AppState").unwrap();
        assert_eq!(state.text_of("name"), Some("Fixture Quest \"Deluxe\""));
        assert_eq!(state.get("UserConfig").unwrap().text_of("language"), Some("english"));
        assert_eq!(state.text_of("APPID"), Some("111")); // 鍵は大文字小文字を区別しない
    }

    #[test]
    fn vdf_rejects_broken_input_without_panicking() {
        for bad in ["\"a\" {", "\"a\" \"b", "}", "bare words", "\"a\" { \"b\" }", "{ }", &"\"a\" {".repeat(40)] {
            assert!(parse_vdf(bad).is_none(), "{bad}");
        }
        assert!(parse_vdf("").is_some());
    }

    #[test]
    fn library_folders_new_and_old_format() {
        assert_eq!(parse_library_folders(LIBRARY_NEW), vec![r"X:\Fixture\Steam", r"Y:\Fixture\Library Two"]);
        assert_eq!(parse_library_folders(LIBRARY_OLD), vec![r"Z:\Fixture\Old"]);
        assert!(parse_library_folders("garbage").is_empty());
    }

    #[test]
    fn steam_manifest_installed_game() {
        let game = parse_steam_manifest(ACF, Path::new(r"X:\Fixture\Steam")).unwrap();
        assert_eq!(game.id, "steam:111");
        assert_eq!(game.name, "Fixture Quest \"Deluxe\"");
        assert_eq!(game.install_dir, Path::new(r"X:\Fixture\Steam").join("steamapps").join("common").join("Fixture Quest"));
    }

    #[test]
    fn steam_manifest_skips_partial_tools_and_traversal() {
        let make = |appid: &str, name: &str, dir: &str, flags: &str| format!("\"AppState\" {{ \"appid\" \"{appid}\" \"name\" \"{name}\" \"installdir\" \"{dir}\" \"StateFlags\" \"{flags}\" }}");
        let lib = Path::new("X:/f");
        assert!(parse_steam_manifest(&make("5", "Half", "Half", "1026"), lib).is_none());
        assert!(parse_steam_manifest(&make("228980", "Steamworks Common Redistributables", "Steamworks Shared", "4"), lib).is_none());
        assert!(parse_steam_manifest(&make("6", "Proton 9.0", "Proton 9.0", "4"), lib).is_none());
        assert!(parse_steam_manifest(&make("7", "Evil", "../../Windows", "4"), lib).is_none());
        assert!(parse_steam_manifest(&make("7", "Evil", "..\\\\..\\\\Windows", "4"), lib).is_none()); // vdf の \\ は \ 1 文字
        assert!(parse_steam_manifest(&make("8x", "BadId", "BadId", "4"), lib).is_none());
        assert!(parse_steam_manifest(&make("9", "Ok", "Ok", "4"), lib).is_some());
    }

    #[test]
    fn epic_manifest_games_only() {
        let game = parse_epic_manifest(r#"{"DisplayName":"Fixture Racer","AppName":"FixtureRacerApp","InstallLocation":"X:\\Fixture\\Epic\\Racer","bIsIncompleteInstall":false,"AppCategories":["public","games","applications"]}"#).unwrap();
        assert_eq!((game.id.as_str(), game.name.as_str()), ("epic:FixtureRacerApp", "Fixture Racer"));
        assert_eq!(game.install_dir, PathBuf::from(r"X:\Fixture\Epic\Racer"));
        assert!(parse_epic_manifest(r#"{"DisplayName":"Dlc","AppName":"Dlc1","InstallLocation":"X:\\d","AppCategories":["public","addons"]}"#).is_none());
        assert!(parse_epic_manifest(r#"{"DisplayName":"Half","AppName":"Half","InstallLocation":"X:\\d","bIsIncompleteInstall":true}"#).is_none());
        assert!(parse_epic_manifest(r#"{"DisplayName":"Bad","AppName":"a b?x=1","InstallLocation":"X:\\d"}"#).is_none());
        assert!(parse_epic_manifest("not json").is_none());
        assert!(parse_epic_manifest(r#"{"DisplayName":"NoDir","AppName":"NoDir"}"#).is_none());
    }

    #[test]
    fn launch_urls_are_built_and_escaped() {
        let steam = InstalledGame { id: "steam:111".into(), source: Source::Steam, name: "n".into(), install_dir: PathBuf::new(), native_id: "111".into() };
        assert_eq!(launch_url(&steam).as_deref(), Some("steam://rungameid/111"));
        let epic = |n: &str| InstalledGame { id: format!("epic:{n}"), source: Source::Epic, name: "n".into(), install_dir: PathBuf::new(), native_id: n.into() };
        assert_eq!(launch_url(&epic("Fixture.App_1-x")).as_deref(), Some("com.epicgames.launcher://apps/Fixture.App_1-x?action=launch&silent=true"));
        assert_eq!(launch_url(&epic("ns:item:App")).as_deref(), Some("com.epicgames.launcher://apps/ns%3Aitem%3AApp?action=launch&silent=true"));
        // 許す文字を外れる id は URL にしない
        assert!(launch_url(&epic("a/b?c=d&e")).is_none());
        let bad_steam = InstalledGame { native_id: "1 2".into(), ..steam.clone() };
        assert!(launch_url(&bad_steam).is_none());
        assert!(open_protocol("https://example.invalid/").is_err());
    }

    #[test]
    fn scan_reads_fixture_libraries_and_dedupes() {
        let root = scratch("scan");
        let steam = root.join("Steam");
        let second = root.join("Second");
        for dir in [steam.join("steamapps"), second.join("steamapps")] { std::fs::create_dir_all(dir).unwrap(); }
        std::fs::write(steam.join("steamapps").join("libraryfolders.vdf"),
            format!("\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}", steam.to_string_lossy().replace('\\', "\\\\"), second.to_string_lossy().replace('\\', "\\\\"))).unwrap();
        std::fs::write(steam.join("steamapps").join("appmanifest_111.acf"), ACF).unwrap();
        std::fs::write(second.join("steamapps").join("appmanifest_111.acf"), ACF).unwrap();
        std::fs::write(second.join("steamapps").join("appmanifest_222.acf"), "\"AppState\" { \"appid\" \"222\" \"name\" \"alpha\" \"installdir\" \"alpha\" \"StateFlags\" \"4\" }").unwrap();
        let epic = root.join("Manifests");
        std::fs::create_dir_all(&epic).unwrap();
        std::fs::write(epic.join("A.item"), r#"{"DisplayName":"Zed","AppName":"Zed","InstallLocation":"X:\\z"}"#).unwrap();
        std::fs::write(epic.join("B.txt"), "{}").unwrap();
        std::fs::write(epic.join("C.item"), "broken").unwrap();
        let roots = Roots { steam: Some(steam), epic_manifests: Some(epic) };
        let games = scan(&roots);
        assert_eq!(games.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), vec!["steam:222", "steam:111", "epic:Zed"]);
        assert!(find(&roots, "steam:222").is_some());
        assert!(find(&roots, "steam:999").is_none());
        let lib = library(&roots);
        assert_eq!(lib.notes, vec![NOTE_XBOX_OMITTED]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn scan_with_nothing_installed_is_empty() {
        assert!(scan(&Roots::default()).is_empty());
        let none = Roots { steam: Some(PathBuf::from("X:/definitely/missing")), epic_manifests: Some(PathBuf::from("X:/definitely/missing2")) };
        assert!(scan(&none).is_empty());
    }

    #[test]
    fn art_prefers_portrait_and_reads_both_layouts() {
        let root = scratch("art");
        let cache = root.join("appcache").join("librarycache");
        std::fs::create_dir_all(cache.join("111").join("abc")).unwrap();
        let png = [0x89u8, b'P', b'N', b'G', 1, 2, 3];
        std::fs::write(cache.join("111_header.jpg"), [0xFFu8, 0xD8, 0]).unwrap();
        std::fs::write(cache.join("111_icon.jpg"), [0xFFu8, 0xD8, 0]).unwrap();
        assert_eq!(steam_art_path(&root, "111").unwrap().file_name().unwrap(), "111_header.jpg");
        std::fs::write(cache.join("111").join("abc").join("library_600x900.png"), png).unwrap();
        let best = steam_art_path(&root, "111").unwrap();
        assert!(best.ends_with("library_600x900.png"));
        assert!(art_data_url(&best).unwrap().starts_with("data:image/png;base64,"));
        assert!(steam_art_path(&root, "../x").is_none());
        assert!(steam_art_path(&root, "999").is_none());
        std::fs::write(cache.join("bad.jpg"), b"text").unwrap();
        assert!(art_data_url(&cache.join("bad.jpg")).is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
