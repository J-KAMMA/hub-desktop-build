use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use tauri::webview::{WebviewBuilder, PageLoadEvent};

use crate::hub_window;
use crate::browser_bookmarks::{self, Favorite};
pub(crate) mod reading;
mod menu;
#[path = "browser_tab_overlay.rs"]
mod browser_tab_overlay;
/// 右列ブラウザ（スマホ幅の専用webview）。タブ一覧には入れない。
#[path = "browser_rail.rs"]
mod rail;

/// Desktopのブラウザ。ワークスペース型:タブと操作面はメイン窓の同梱UIが
/// 持ち（サイドバーのタブ欄と画面上部のストリップ）、子webviewはタブごとの
/// 外部ページだけを載せる。タブは1枚だけ表示し、残りは hide() で隠す。
/// 別の行き先へ移ると browser_exit で子webviewを隠す。
///
/// 内容webviewは外部サイト専用。`on_navigation` で http/https 以外の遷移と
/// Web版Hubのページを拒否し（Hubは既定ブラウザで開くものとして分ける）、
/// 許可した遷移だけを履歴へ記録してメイン窓へ反映する。
/// capabilities に remote 許可を持たせていないので、すべての外部ページへ
/// Tauri の invoke/event は届かない。
const MAIN_LABEL: &str = "main";
/// ＋新規タブが最初に開くローカルページ。ネットワークを待たずに即時表示し、
/// そこからの遷移だけが外部ページを読み込む（軽いタブ生成）。
const NEW_TAB_PAGE: &str = "newtab.html";
static BROWSER_VISIBLE: AtomicBool = AtomicBool::new(false);
static MODAL_OCCLUDED: AtomicBool = AtomicBool::new(false);
static BROWSER_EPOCH: AtomicU64 = AtomicU64::new(0);
// An AI draft must not outlive tab changes, including away-and-back transitions.
static BROWSER_AI_EPOCH: AtomicU64 = AtomicU64::new(0);
// Document/tab context only; layout and popup changes must not invalidate a print preview.
static BROWSER_PRINT_CONTEXT_EPOCH: AtomicU64 = AtomicU64::new(0);
const HISTORY_LIMIT: usize = 200;
static FAVORITES_WRITE: Mutex<()> = Mutex::new(());
static HISTORY_WRITE: Mutex<()> = Mutex::new(());
/// この時間を超えて隠れているタブのwebviewを破棄する（メモリセーバー）。
/// タブとURLは残るので、選択時に作り直して同じページへ戻る。
/// HUB_BROWSER_DISCARD_SECS で検証用に短縮できる。
const DISCARD_AFTER: Duration = Duration::from_secs(300);
const REAP_INTERVAL: Duration = Duration::from_secs(30);

/// 空きメモリが少ないあいだは、隠れたタブを早めに休ませる（ユーザー決定 2026-10-11）。
/// 3タブの実測で、隠れた2タブを休ませると全体が約1,000MBから約570MBへ下がった。
const LOW_MEMORY_DISCARD_AFTER: Duration = Duration::from_secs(30);
const LOW_MEMORY_BYTES: u64 = 3 * 1024 * 1024 * 1024;

fn discard_after() -> Duration {
    std::env::var("HUB_BROWSER_DISCARD_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or_else(|| discard_after_for(available_memory()))
}

fn discard_after_for(available: Option<u64>) -> Duration {
    if available.is_some_and(|bytes| bytes < LOW_MEMORY_BYTES) { LOW_MEMORY_DISCARD_AFTER } else { DISCARD_AFTER }
}

#[cfg(windows)]
fn available_memory() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.ullAvailPhys)
}

#[cfg(not(windows))]
fn available_memory() -> Option<u64> {
    None
}

/// 操作バーやURL入力から受け取った宛先を http/https だけに絞る。
/// スキーム無しの入力は https を補う（ループバックだけ http）。
fn parse_target(raw: &str) -> Option<tauri::Url> {
    let trimmed = raw.trim();
    if trimmed.len() > 32768 || trimmed.encode_utf16().count() > 8192 || trimmed.chars().any(char::is_control) { return None; }
    if let Ok(url) = tauri::Url::parse(trimmed) {
        if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() && url.username().is_empty() && url.password().is_none() {
            return Some(url);
        }
        // "://" を書いた入力のスキームはそのまま信じる（file:, javascript: は拒否）。
        // そうでない入力は "localhost:3020" のようにホスト名がスキームとして
        // 読まれただけなので、下の補完へ回す（":port" がスキームを騙る）。
        if trimmed.contains("://") {
            return None;
        }
    }
    // 明示したスキームのURLが壊れている場合は、ホスト名として補完しない。
    if trimmed.contains("://") {
        return None;
    }
    // スキーム無しの入力へ補う。ループバックの開発サーバは大抵平文なので、
    // 補完後のホストが本当にループバックの時だけ http にする
    // （"127.0.0.1.evil.example" のような名前は降格しない）。
    let url = tauri::Url::parse(&format!("https://{trimmed}")).ok()?;
    if !url.username().is_empty() || url.password().is_some() { return None; }
    let loopback = url.host_str() == Some("localhost")
        || url
            .host_str()
            .and_then(|host| host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
    if loopback {
        tauri::Url::parse(&format!("http://{trimmed}")).ok()
    } else {
        Some(url)
    }
}

/// アプリ同梱ページ（新規タブ画面など）のナビゲーションか。
/// Windows では WebviewUrl::App が http://tauri.localhost として解決される。
fn is_internal_url(url: &tauri::Url, dev_origin: Option<&str>) -> bool {
    url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || dev_origin.is_some_and(|origin| url.origin().ascii_serialization() == origin)
}

fn internal_page_allowed(url: &tauri::Url, dev_origin: Option<&str>) -> bool {
    !is_internal_url(url, dev_origin) || url.path() == "/newtab.html"
}

/// このアプリが接続しているHubのオリジン（HUB_APP_URL 考慮済み）。
fn configured_hub_origin() -> String {
    let raw = hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    tauri::Url::parse(&raw)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| raw.trim_end_matches('/').to_owned())
}

/// Web版Hubのページか。アプリ内ブラウザは外部サイト専用で、Web版は
/// 既定ブラウザで開くもの——アプリとWeb版は別製品として分ける。
/// 接続先のオリジンに加えて本番 origin は常にHubとして扱う。
fn is_hub_page(url: &tauri::Url) -> bool {
    let origin = url.origin().ascii_serialization();
    origin == "https://hub.jkamma.com" || origin == configured_hub_origin()
}

/// Hub宛の遷移を止めたことをメイン窓へ告げる。UI側が案内を出す。
fn emit_hub_blocked(app: &AppHandle, url: &tauri::Url) {
    let _ = app.emit_to(
        MAIN_LABEL,
        "browser-hub-blocked",
        serde_json::json!({ "url": url.as_str() }),
    );
}

// Opt-in hook counts only; neither navigation success nor page paint.
const PAGE_LOAD_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
static CHILD_LIFETIME_SEQUENCE: AtomicU64 = AtomicU64::new(0);
fn allocate_child_lifetime(sequence: &AtomicU64) -> Option<u64> {
    sequence.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current|
        current.checked_add(1).filter(|next| *next <= PAGE_LOAD_SAFE_INTEGER)).ok().map(|previous| previous + 1)
}
struct PageLoadObservation {
    child: Arc<()>,
    counts: Option<(u64, u64)>,
    lifetime: Option<u64>,
}
impl PageLoadObservation {
    fn new(enabled: bool) -> Option<Self> {
        enabled.then(|| Self { child: Arc::new(()), counts: Some((0, 0)), lifetime: allocate_child_lifetime(&CHILD_LIFETIME_SEQUENCE) })
    }
    fn current_lifetime(&self) -> Option<u64> { self.counts.and(self.lifetime) }
    fn clear_failed(observation: &mut Option<Self>, child: Option<&Arc<()>>) {
        if child.is_some_and(|child| observation.as_ref().is_some_and(|current| Arc::ptr_eq(&current.child, child))) {
            *observation = None;
        }
    }
    fn observe(&mut self, child: &Arc<()>, started: bool) {
        if !Arc::ptr_eq(&self.child, child) { return; }
        self.counts = self.counts.and_then(|(starts, finishes)| {
            if started {
                starts.checked_add(1).filter(|count| *count <= PAGE_LOAD_SAFE_INTEGER).map(|count| (count, finishes))
            } else {
                finishes.checked_add(1).filter(|count| *count <= PAGE_LOAD_SAFE_INTEGER).map(|count| (starts, count))
            }
        });
    }
}

struct Tab {
    id: u64,
    label: String,
    /// 最後に許可した遷移先。webview.url() はコミット前に about:blank を
    /// 返すことがあるので、表示の正はこちらで持つ。廃棄後の復元にも使う。
    url: String,
    /// 子webviewを破棄済み。タブとURLだけ残り、選択時に作り直す。
    discarded: bool,
    title: String,
    loading: bool,
    page_load: Option<PageLoadObservation>,
    desired_muted: bool,
    media: Option<BrowserMediaObservation>,
    pinned: bool,
    zoom: f64,
    can_back: bool,
    can_forward: bool,
    group: Option<String>,
    private: bool,
    private_ready: bool,
    /// 隠れ始めた時刻。DISCARD_AFTER を超えると reaper が破棄する。
    /// 表示中と廃棄済みは None。
    hidden_since: Option<Instant>,
    /// WebView2 が読み込んだファビコン（data:image/png;base64,）。メモリのみ。
    favicon: Option<String>,
}

#[derive(Default)]
struct TabState {
    tabs: Vec<Tab>,
    active: u64,
    next: u64,
    closed: Vec<ClosedTab>,
}

#[derive(Clone)]
struct ClosedTab { url: String, title: String, zoom: f64, position: usize, group: Option<String>, muted: bool }

static TABS: Mutex<Option<TabState>> = Mutex::new(None);

/// Hubページが実測して渡した、ブラウザが占める領域（論理px）。
/// getBoundingClientRect() の CSS px は scale_factor で割った論理pxと一致する。
static BOUNDS: Mutex<Option<BrowserRect>> = Mutex::new(None);

#[derive(Deserialize, Clone, Copy)]
pub struct BrowserRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct FullscreenSession { id: u64, restore_fullscreen: bool }

#[derive(Default)]
struct FullscreenState(Option<FullscreenSession>);

impl FullscreenState {
    fn enter(&mut self, id: u64, visible: bool, active: Option<u64>, was_fullscreen: bool) -> bool {
        if !visible || active != Some(id) || self.0.is_some() { return false; }
        self.0 = Some(FullscreenSession { id, restore_fullscreen: was_fullscreen });
        true
    }

    fn leave(&mut self, id: Option<u64>) -> Option<FullscreenSession> {
        if id.is_some_and(|id| self.0.is_none_or(|session| session.id != id)) { return None; }
        self.0.take()
    }
}

static FULLSCREEN: Mutex<FullscreenState> = Mutex::new(FullscreenState(None));

fn fullscreen_owner() -> Option<u64> {
    FULLSCREEN.lock().ok()?.0.map(|session| session.id)
}

// Native events supply the state; external pages receive no Hub IPC capability.
fn sync_fullscreen(app: &AppHandle, id: u64, contains: bool) {
    if !contains { leave_fullscreen(app, Some(id), false); return; }
    let Some(window) = app.get_window(MAIN_LABEL) else { return };
    let Ok(was_fullscreen) = window.is_fullscreen() else { return };
    let active = with_tabs(|state| state.active);
    let entered = FULLSCREEN.lock().ok().is_some_and(|mut state| {
        state.enter(id, BROWSER_VISIBLE.load(Ordering::SeqCst), active, was_fullscreen)
    });
    if !entered { return; }
    if window.set_fullscreen(true).is_err() {
        leave_fullscreen(app, Some(id), true);
        let _ = app.emit_to(MAIN_LABEL, "browser-operation-error", "fullscreen_failed");
        return;
    }
    layout(app);
    relayout_after_transition(app);
}

/// A window moving into or out of full screen (especially from a maximized state) finishes
/// its resize asynchronously, and a Resized event can arrive before the final client area is
/// in place. Re-apply the layout once the transition has settled so no strip of the window
/// background is left uncovered.
fn relayout_after_transition(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        for ms in [80u64, 250, 700] {
            std::thread::sleep(Duration::from_millis(ms));
            layout(&handle);
        }
    });
}

/// True while the main window is full screen because the user pressed F11 (or called
/// browser_toggle_fullscreen) in the browser. Esc leaves only this kind of full screen.
static F11_FULLSCREEN: AtomicBool = AtomicBool::new(false);

fn toggle_f11_fullscreen(app: &AppHandle) {
    if !BROWSER_VISIBLE.load(Ordering::SeqCst) { return; }
    if fullscreen_owner().is_some() { leave_fullscreen(app, None, true); return; }
    if F11_FULLSCREEN.load(Ordering::SeqCst) { leave_f11_fullscreen(app); return; }
    let Some(window) = app.get_window(MAIN_LABEL) else { return };
    let Ok(was_fullscreen) = window.is_fullscreen() else { return };
    if was_fullscreen {
        // Fullscreen that F11 did not start: F11 leaves it, like other browsers.
        if window.set_fullscreen(false).is_err() { let _ = app.emit_to(MAIN_LABEL, "browser-operation-error", "fullscreen_restore_failed"); }
    } else if window.set_fullscreen(true).is_ok() {
        F11_FULLSCREEN.store(true, Ordering::SeqCst);
    } else {
        let _ = app.emit_to(MAIN_LABEL, "browser-operation-error", "fullscreen_failed");
        return;
    }
    layout(app); relayout_after_transition(app);
}

fn leave_f11_fullscreen(app: &AppHandle) {
    if !F11_FULLSCREEN.swap(false, Ordering::SeqCst) { return; }
    if let Some(window) = app.get_window(MAIN_LABEL) {
        if window.set_fullscreen(false).is_err() { let _ = app.emit_to(MAIN_LABEL, "browser-operation-error", "fullscreen_restore_failed"); }
    }
    layout(app); relayout_after_transition(app);
}

/// For the bundled UI: F11 pressed while the main webview (not a page) has focus.
#[tauri::command]
pub fn browser_toggle_fullscreen(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    if !BROWSER_VISIBLE.load(Ordering::SeqCst) { return Err("browser_unavailable".into()); }
    toggle_f11_fullscreen(&app); Ok(())
}

fn leave_fullscreen(app: &AppHandle, id: Option<u64>, exit_page: bool) {
    let session = FULLSCREEN.lock().ok().and_then(|mut state| state.leave(id));
    let Some(session) = session else { return };
    // Release the state lock before native calls: resizing can reenter layout.
    if exit_page {
        if let Some(view) = app.get_webview(&format!("browser-tab-{}", session.id)) {
            exit_page_fullscreen(&view);
        }
    }
    if let Some(window) = app.get_window(MAIN_LABEL) {
        if window.set_fullscreen(session.restore_fullscreen).is_err() {
            let _ = app.emit_to(MAIN_LABEL, "browser-operation-error", "fullscreen_restore_failed");
        }
    }
    layout(app); relayout_after_transition(app);
}

#[cfg(windows)]
fn exit_page_fullscreen(view: &tauri::Webview) {
    let _ = view.with_webview(move |platform| unsafe {
        if let Ok(core) = platform.controller().CoreWebView2() {
            let callback = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
            let _ = core.ExecuteScript(&windows_core::HSTRING::from(
                "if (document.fullscreenElement) document.exitFullscreen().catch(() => {});"
            ), &callback);
        }
    });
}

#[cfg(not(windows))]
fn exit_page_fullscreen(view: &tauri::Webview) {
    let _ = view.eval("if (document.fullscreenElement) document.exitFullscreen().catch(() => {});");
}

#[cfg(windows)]
fn hook_fullscreen(app: &AppHandle, view: &tauri::Webview, id: u64) {
    let handle = app.clone();
    let _ = view.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        let callback = webview2_com::ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(core) = sender else { return Ok(()) };
            let mut contains = windows_core::BOOL(0);
            core.ContainsFullScreenElement(&mut contains)?;
            sync_fullscreen(&handle, id, contains.as_bool());
            Ok(())
        }));
        let _ = core.add_ContainsFullScreenElementChanged(&callback, &mut 0);
    });
}

#[cfg(not(windows))]
fn hook_fullscreen(_app: &AppHandle, _view: &tauri::Webview, _id: u64) {}

/// Where a page lives; an icon belongs to the tab only while the tab stays on this origin.
fn origin_of(url: &str) -> Option<String> {
    let origin = tauri::Url::parse(url).ok()?.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

/// Set or clear a tab's icon. `origin` is the page the icon was requested for: a reply for a page the
/// tab has since left, or an icon for a page without an origin, is dropped. Returns the URL to refresh
/// a bookmark for (never for private tabs) when the icon changed.
fn apply_favicon(state: &mut TabState, id: u64, origin: Option<String>, icon: Option<String>) -> Option<Option<String>> {
    let tab = state.tabs.iter_mut().find(|tab| tab.id == id)?;
    if origin_of(&tab.url) != origin || (icon.is_some() && origin.is_none()) || tab.favicon == icon { return None; }
    tab.favicon = icon;
    Some((!tab.private && tab.favicon.is_some()).then(|| tab.url.clone()))
}

fn set_tab_favicon(app: &AppHandle, id: u64, origin: Option<String>, icon: Option<String>) {
    let stored = icon.clone();
    let Some(bookmark) = with_tabs(|state| apply_favicon(state, id, origin, icon)).flatten() else { return };
    // Only the sidebar needs to redraw: not a navigation, so no session save or AI context reset.
    let _ = app.emit_to(MAIN_LABEL, "browser-tabs-changed", ());
    if let (Some(url), Some(icon)) = (bookmark, stored) { refresh_favorite_icon(app, url, icon); }
}

/// A bookmarked page that shows a newer icon gets it stored; off the UI thread, and only written when it changed.
fn refresh_favorite_icon(app: &AppHandle, url: String, icon: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(_serial) = FAVORITES_WRITE.lock() else { return };
        let Ok(path) = favorites_path() else { return };
        let Ok(mut items) = browser_bookmarks::read(&path) else { return };
        if browser_bookmarks::set_icon(&mut items, &url, &icon).unwrap_or(false) && browser_bookmarks::write(&path, &items).is_ok() {
            let _ = app.emit_to(MAIN_LABEL, "browser-tabs-changed", ());
        }
    });
}

#[cfg(windows)]
fn read_icon_stream(stream: &windows::Win32::System::Com::IStream) -> Option<Vec<u8>> {
    let (mut bytes, mut chunk) = (Vec::new(), [0u8; 4096]);
    loop {
        let mut read = 0u32;
        unsafe { stream.Read(chunk.as_mut_ptr().cast(), chunk.len() as u32, Some(&mut read)) }.ok().ok()?;
        if read == 0 { return Some(bytes); }
        bytes.extend_from_slice(&chunk[..read as usize]);
        if bytes.len() > crate::browser_favicon::MAX_ICON_BYTES { return None; }
    }
}

/// WebView2 hands over the icon the page already loaded (FaviconChanged, then GetFavicon as PNG);
/// this code makes no network request of its own.
#[cfg(windows)]
fn hook_favicon(app: &AppHandle, view: &tauri::Webview, id: u64) {
    use webview2_com::{FaviconChangedEventHandler, GetFaviconCompletedHandler, Microsoft::Web::WebView2::Win32::{ICoreWebView2_15, COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG}};
    use windows_core::Interface;
    let handle = app.clone();
    let _ = view.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        let Ok(core15) = core.cast::<ICoreWebView2_15>() else { return };
        let callback = FaviconChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(core15) = sender.and_then(|core| core.cast::<ICoreWebView2_15>().ok()) else { return Ok(()) };
            let mut uri = windows_core::PWSTR::null();
            let has_icon = core15.FaviconUri(&mut uri).is_ok() && !webview2_com::take_pwstr(uri).is_empty();
            let origin = with_tabs(|state| state.tabs.iter().find(|tab| tab.id == id).and_then(|tab| origin_of(&tab.url))).flatten();
            if !has_icon { set_tab_favicon(&handle, id, origin, None); return Ok(()); }
            let done = handle.clone();
            let reply = GetFaviconCompletedHandler::create(Box::new(move |result, stream| {
                let icon = result.ok().and(stream).and_then(|stream| read_icon_stream(&stream)).and_then(|bytes| crate::browser_favicon::png_data_url(&bytes));
                set_tab_favicon(&done, id, origin, icon);
                Ok(())
            }));
            let _ = core15.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, &reply);
            Ok(())
        }));
        let _ = core15.add_FaviconChanged(&callback, &mut 0);
    });
}

#[cfg(not(windows))]
fn hook_favicon(_app: &AppHandle, _view: &tauri::Webview, _id: u64) {}

fn bounds() -> BrowserRect {
    crate::native_browser_tabs::content_rect(raw_bounds())
}

fn raw_bounds() -> BrowserRect {
    BOUNDS.lock().ok().and_then(|b| *b).unwrap_or(BrowserRect {
        x: 0.0,
        y: 0.0,
        w: 1100.0,
        h: 760.0,
    })
}

fn set_bounds(rect: BrowserRect) {
    if let Ok(mut guard) = BOUNDS.lock() {
        *guard = Some(rect);
    }
}

fn with_tabs<R>(f: impl FnOnce(&mut TabState) -> R) -> Option<R> {
    TABS.lock().ok()?.as_mut().map(f)
}

/// アクティブタブの最後に許可した遷移先。webview.url() はコミット前の
/// about:blank を返すことがあるので、状態側の記録を使う。
fn active_tab_url() -> Option<String> {
    with_tabs(|state| {
        state
            .tabs
            .iter()
            .find(|tab| tab.id == state.active)
            .map(|tab| tab.url.clone())
            // 新規タブページでは表示URLを持たない（"" が記録される）。
            .filter(|url| !url.is_empty())
    })
    .flatten()
}

fn active_webview(app: &AppHandle) -> Option<tauri::Webview> {
    let label = with_tabs(|state| {
        state
            .tabs
            .iter()
            .find(|tab| tab.id == state.active)
            .map(|tab| tab.label.clone())
    })??;
    app.get_webview(&label)
}

#[derive(Serialize)]
pub struct TabInfo {
    id: u64,
    url: String,
    active: bool,
    /// メモリ解放済み。操作バーはタブを薄く表示し、選択で復元する。
    discarded: bool,
    title: String,
    loading: bool,
    pinned: bool,
    zoom: f64,
    #[serde(rename = "canBack")]
    can_back: bool,
    #[serde(rename = "canForward")]
    can_forward: bool,
    group: Option<String>,
    r#private: bool,
    muted: Option<bool>,
    #[serde(rename = "playingAudio")]
    playing_audio: Option<bool>,
    #[serde(rename = "canMute")]
    can_mute: bool,
    #[serde(rename = "canPrint")]
    can_print: bool,
    #[serde(rename = "printContextToken")]
    print_context_token: Option<String>,
    /// data:image/png;base64,… only; absent until the page's own icon has been read.
    #[serde(skip_serializing_if = "Option::is_none")]
    favicon: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct HistoryEntry {
    url: String,
    at: i64,
    #[serde(default)]
    title: String,
}

#[derive(Serialize)]
pub struct BrowserWorkspaceSnapshot {
    version: u8,
    tabs: Vec<TabInfo>,
    favorites: Vec<Favorite>,
    history: Vec<HistoryEntry>,
}

fn data_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(std::path::PathBuf::from(base).join("jkamma-hub"))
}

/// History, the previous session and site zoom stay on this PC (`%LOCALAPPDATA%`),
/// so a roaming profile does not copy them to other PCs (decided 2026-10-18).
fn local_data_dir() -> Option<std::path::PathBuf> {
    let dir = crate::local_data::local_hub_dir()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// サイトごとの拡大率（Chrome/Edgeと同じ）。本人が拡大・縮小したホストだけを、
/// 通常タブのときだけ覚える。100%へ戻したホストは消す。プライベートタブは読むだけで書かない。
const SITE_ZOOM_FILE: &str = "browser-site-zoom.json";
const SITE_ZOOM_LIMIT: usize = 300;
static SITE_ZOOM: std::sync::LazyLock<Mutex<Vec<(String, f64)>>> =
    std::sync::LazyLock::new(|| Mutex::new(read_list::<(String, f64)>(SITE_ZOOM_FILE).into_iter().filter(|(host, zoom)| !host.is_empty() && valid_zoom(*zoom)).take(SITE_ZOOM_LIMIT).collect()));

fn site_zoom_key(url: &str) -> Option<String> {
    let url = tauri::Url::parse(url).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.host_str().map(str::to_ascii_lowercase)).flatten()
}

fn site_zoom_of(list: &[(String, f64)], host: &str) -> f64 {
    list.iter().find(|(saved, _)| saved == host).map_or(1.0, |(_, zoom)| *zoom)
}

/// 先頭が最新。100%は覚えない。上限を超えた古いホストから捨てる。
fn remember_site_zoom(list: &mut Vec<(String, f64)>, host: &str, zoom: f64) {
    list.retain(|(saved, _)| saved != host);
    if (zoom - 1.0).abs() >= 0.001 { list.insert(0, (host.to_owned(), zoom)); }
    list.truncate(SITE_ZOOM_LIMIT);
}

fn saved_site_zoom(url: &str) -> Option<f64> {
    let host = site_zoom_key(url)?;
    SITE_ZOOM.lock().ok().map(|list| site_zoom_of(&list, &host))
}

fn save_site_zoom(url: &str, zoom: f64) {
    let Some(host) = site_zoom_key(url) else { return };
    let Ok(mut list) = SITE_ZOOM.lock() else { return };
    remember_site_zoom(&mut list, &host, zoom);
    write_list(SITE_ZOOM_FILE, &list);
}

fn clear_site_zoom() {
    if let Ok(mut list) = SITE_ZOOM.lock() { list.clear(); }
    write_list::<(String, f64)>(SITE_ZOOM_FILE, &[]);
}

fn read_list<T: for<'a> Deserialize<'a>>(name: &str) -> Vec<T> {
    let Some(dir) = local_data_dir() else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(dir.join(name)) else { return Vec::new() };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_list<T: Serialize>(name: &str, list: &[T]) {
    let Some(dir) = local_data_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    // Atomic: a crash mid-write must not truncate history or zoom to an empty list.
    if let Ok(json) = serde_json::to_vec(list) {
        let _ = browser_bookmarks::write_atomic(&dir.join(name), &json);
    }
}

/// 履歴の先頭へ入れ直す。同じURLは重複させず、上限を超えた古い方から捨てる。
/// ファイルI/Oを持たない純粋な更新なので、テストはこれを直接検査する
/// （APPDATAを書き換えるテストは他の並行ケースと衝突する）。
fn upsert_history(history: &mut Vec<HistoryEntry>, url: &str, at: i64) {
    history.retain(|entry| entry.url != url);
    history.insert(
        0,
        HistoryEntry {
            url: url.to_owned(),
            at,
            title: String::new(),
        },
    );
    history.truncate(HISTORY_LIMIT);
}

fn record_history(url: &str) {
    let Ok(_serial) = HISTORY_WRITE.lock() else { return };
    let mut history = read_list::<HistoryEntry>("browser-history.json");
    upsert_history(&mut history, url, chrono::Utc::now().timestamp());
    write_list("browser-history.json", &history);
}

fn notify_tabs(app: &AppHandle) {
    close_download_history_if_stale(app);
    reading::reconcile(app);
    BROWSER_AI_EPOCH.fetch_add(1, Ordering::SeqCst);
    sync_native_tabs(app, true);
    save_session();
    let _ = app.emit_to(MAIN_LABEL, "browser-tabs-changed", ());
}

/// タブwebviewを1枚作ってメイン窓に載せる。id/label は呼び出し側が決めるので、
/// 新規作成と廃棄タブの復元の両方から使える。置き場所はBOUNDSに従う。
fn build_tab_webview(
    app: &AppHandle,
    window: &tauri::Window,
    id: u64,
    label: &str,
    target: WebviewUrl,
) -> Option<tauri::Webview> {
    // 右列ブラウザも同じ作り方（遮断・自動再生・遷移の絞り込み・IPCなし）を通す。違いは
    // モバイルのUA、Hubの通過、タブ一覧に載せないことだけ（browser_rail.rs）。
    let rail = rail::is_rail_id(id);
    let rect = if rail { rail::spawn_rect() } else { bounds() };
    let handle = app.clone();
    let zoom_label = label.to_owned();
    // tauri dev serves bundled pages from a loopback origin instead of tauri.localhost.
    let dev_origin = if cfg!(debug_assertions) {
        app.get_webview(MAIN_LABEL)
            .and_then(|view| view.url().ok())
            .filter(|url| {
                url.scheme() == "http"
                    && url.host_str().is_some_and(|host| {
                        host == "localhost"
                            || host
                                .parse::<std::net::IpAddr>()
                                .is_ok_and(|ip| ip.is_loopback())
                    })
            })
            .map(|url| url.origin().ascii_serialization())
    } else {
        None
    };
    let title_handle = app.clone();
    let load_handle = app.clone();
    let observe_load = crate::desktop_metrics::enabled();
    let load_observation = PageLoadObservation::new(observe_load);
    let load_child = with_tabs(|state| {
        let tab = state.tabs.iter_mut().find(|tab| tab.id == id)?;
        tab.page_load = load_observation;
        tab.page_load.as_ref().map(|observation| Arc::clone(&observation.child))
    }).flatten();
    let callback_child = load_child.clone();
    let (private, desired_muted) = with_tabs(|state| state.tabs.iter().find(|tab| tab.id == id).map(|tab| (tab.private, tab.desired_muted))).flatten().unwrap_or_default();
    let requested = target.clone();
    let target = if cfg!(windows) || private || desired_muted { WebviewUrl::App(NEW_TAB_PAGE.into()) } else { target };
    let builder = WebviewBuilder::new(label, target).incognito(private).background_color(tauri::window::Color(10, 10, 12, 255));
    let builder = if rail { builder.user_agent(rail::MOBILE_UA) } else { builder };
    let builder = builder
        .on_document_title_changed(move |view, title| {
            let title: String = title.chars().filter(|c| !c.is_control()).take(300).collect();
            if rail { rail::on_title(&title_handle, title); return; }
            let current = view.url().ok().map(|url| url.to_string());
            let url = with_tabs(|state| {
                let tab = state.tabs.iter_mut().find(|tab| tab.id == id)?;
                if !tab.url.is_empty() && current.as_deref() != Some(tab.url.as_str()) { return None; }
                tab.title = title.clone();
                (!tab.private).then(|| tab.url.clone())
            }).flatten();
            if let Some(url) = url.filter(|url| !url.is_empty()) {
                let Ok(_serial) = HISTORY_WRITE.lock() else { return };
                let mut history = read_list::<HistoryEntry>("browser-history.json");
                if let Some(entry) = history.iter_mut().find(|entry| entry.url == url) { entry.title = title; }
                write_list("browser-history.json", &history);
            }
            notify_tabs(&title_handle);
        })
        .on_page_load(move |view, payload| {
            if rail { rail::on_load(&load_handle, &view, payload.event() == PageLoadEvent::Started); return; }
            if payload.event() == PageLoadEvent::Started {
                BROWSER_PRINT_CONTEXT_EPOCH.fetch_add(1, Ordering::SeqCst);
                reading::reconcile(&load_handle);
                leave_fullscreen(&load_handle, Some(id), false);
            }
            with_tabs(|state| {
                if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) {
                    tab.loading = payload.event() == PageLoadEvent::Started;
                    if let (Some(observation), Some(child)) = (&mut tab.page_load, &callback_child) {
                        observation.observe(child, payload.event() == PageLoadEvent::Started);
                    }
                }
            });
            update_navigation_state(&load_handle, &view, id);
            notify_tabs(&load_handle);
        })
        .on_navigation(move |target| {
        if rail { return rail::on_navigation(&handle, &target, dev_origin.as_deref()); }
        // Web版Hubはアプリ内ブラウザでは開かない。遷移を止めて
        // 既定ブラウザへの案内はメイン窓へ通知する。
        let internal = is_internal_url(&target, dev_origin.as_deref());
        if !internal_page_allowed(&target, dev_origin.as_deref()) {
            return false;
        }
        if !internal && is_hub_page(&target) {
            emit_hub_blocked(&handle, &target);
            return false;
        }
        // http/https と同梱ページ（tauri.localhost）以外
        // （data:, javascript:, file: など）は拒否し、外部への遷移だけを
        // 履歴へ記録して操作バーへ反映する。
        let allowed = internal || matches!(target.scheme(), "http" | "https") && target.username().is_empty() && target.password().is_none();
        let ready = with_tabs(|state| state.tabs.iter().find(|tab| tab.id == id).is_some_and(|tab| !tab.private || tab.private_ready)).unwrap_or(false);
        if !internal && !ready { return false; }
        if allowed {
            BROWSER_PRINT_CONTEXT_EPOCH.fetch_add(1, Ordering::SeqCst);
            reading::reconcile(&handle);
            close_download_history(&handle);
            BROWSER_AI_EPOCH.fetch_add(1, Ordering::SeqCst);
            let shown = if internal { "" } else { target.as_str() };
            if !internal && !private {
                record_history(shown);
            }
            // on_navigation は遷移開始時点で発火し、その間 webview.url() は
            // まだ古い値を返す。バー側はこのイベントの url を正とする。
            // 別のホストへ移ったら、そのサイトで覚えた拡大率（無ければ100%）へ合わせる。
            let site_zoom = if internal { None } else { saved_site_zoom(shown) };
            let (active, rezoom) = with_tabs(|state| {
                let mut rezoom = None;
                if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) {
                    if origin_of(&tab.url) != origin_of(shown) { tab.favicon = None; }
                    let moved = site_zoom_key(&tab.url) != site_zoom_key(shown);
                    if let Some(zoom) = site_zoom.filter(|zoom| (moved || (*zoom - 1.0).abs() >= 0.001) && (*zoom - tab.zoom).abs() >= 0.001) {
                        tab.zoom = zoom;
                        rezoom = Some(zoom);
                    }
                    tab.url = shown.to_owned();
                }
                (state.active == id, rezoom)
            })
            .unwrap_or((false, None));
            if let Some(zoom) = rezoom {
                if let Some(view) = handle.get_webview(&zoom_label) { let _ = view.set_zoom(zoom); }
                notify_tabs(&handle);
            }
            save_session();
            let _ = handle.emit_to(
                MAIN_LABEL,
                "browser-url-changed",
                serde_json::json!({ "id": id, "url": shown, "active": active }),
            );
        }
        allowed
    });
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(rect.x, rect.y),
            LogicalSize::new(rect.w, rect.h),
        )
        .ok();
    let view = view.and_then(|view| {
        if private {
            // Creation runs on the main thread. A missing or deferred verification fails closed.
            if !verified_private_view(&view) { let _ = protection::close(&view); return None; }
            with_tabs(|state| { if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) { tab.private_ready = true; } });
        }
        if desired_muted && !apply_restored_mute(&view) {
            let _ = protection::close(&view);
            let _ = app.emit_to(MAIN_LABEL, "browser-operation-error", "browser_audio_unavailable");
            return None;
        }
        #[cfg(windows)]
        if let Err(error) = initialize_protection().and_then(|_| protection::install(&view)) {
            let _ = protection::close(&view);
            eprintln!("{error}"); let _ = app.emit_to(MAIN_LABEL, "browser-operation-error", error);
            return None;
        }
        // Registered before the first real navigation below, so the opening page already obeys it.
        apply_autoplay(&view);
        if cfg!(windows) || private || desired_muted {
            if let WebviewUrl::External(url) = requested {
                if view.navigate(url).is_err() { let _ = protection::close(&view); return None; }
            }
        }
        Some(view)
    });
    if view.is_none() {
        with_tabs(|state| {
            if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) {
                PageLoadObservation::clear_failed(&mut tab.page_load, load_child.as_ref());
            }
        });
    }
    view
}

/// タブwebviewを1枚作ってメイン窓に載せる。失敗時はタブを登録しない。
/// 置き場所はHubページが測ったコンテンツ領域（BOUNDS）に従う。
fn spawn_tab(
    app: &AppHandle,
    window: &tauri::Window,
    target: WebviewUrl,
    shown_url: &str,
) -> Option<tauri::Webview> {
    spawn_tab_mode(app, window, target, shown_url, false, false)
}

fn spawn_tab_mode(app: &AppHandle, window: &tauri::Window, target: WebviewUrl, shown_url: &str, private: bool, desired_muted: bool) -> Option<tauri::Webview> {
    let (id, label) = {
        let mut guard = TABS.lock().ok()?;
        let state = guard.get_or_insert_with(TabState::default);
        if state.tabs.len() >= 64 { return None; }
        state.next += 1;
        let id = state.next; let label = format!("browser-tab-{id}");
        // WebView2 creation pumps messages; reserve the tab before any reentrant restore.
        state.tabs.push(Tab { id, label: label.clone(), url: shown_url.to_owned(), discarded: false,
            title: String::new(), loading: true, page_load: None, desired_muted, media: None, pinned: false, zoom: 1.0, can_back: false, can_forward: false, group: None, private, private_ready: false, hidden_since: None, favicon: None });
        (id, label)
    };
    let Some(webview) = build_tab_webview(app, window, id, &label, target) else {
        with_tabs(|state| state.tabs.retain(|tab| tab.id != id));
        return None;
    };
    if !with_tabs(|state| state.tabs.iter().any(|tab| tab.id == id)).unwrap_or(false) {
        let _ = protection::close(&webview);
        return None;
    }
    hook_tab_media(app, &webview, id);
    hook_browser_shortcuts(app, &webview, id);
    hook_fullscreen(app, &webview, id);
    hook_favicon(app, &webview, id);
    menu::hook(app, &webview, id);
    #[cfg(windows)] browser_access::hook(app, &webview, id);
    // Creation pumps messages; apply the current stage and modal directive after it returns.
    layout(app);
    Some(webview)
}

/// 隠れているタブへ隠蔽開始時刻を刻む。shown のタブ（表示側）は時刻を消す。
/// 既に刻まれているタブはその時刻を維持する（隠れ続けている正確な起点）。
fn stamp_hidden_tabs(state: &mut TabState, shown: Option<u64>) {
    let now = Instant::now();
    for tab in state.tabs.iter_mut() {
        if Some(tab.id) == shown {
            tab.hidden_since = None;
        } else if !tab.discarded && tab.hidden_since.is_none() {
            tab.hidden_since = Some(now);
        }
    }
}

fn mark_tab_discarded(state: &mut TabState, id: u64, view_closed: bool) {
    if !view_closed { return; }
    if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) {
        tab.discarded = true;
        tab.page_load = None;
        tab.media = None;
        tab.hidden_since = None;
    }
}

/// 廃棄済みタブを同じid・同じラベルで作り直し、記録したURLへ戻す。
/// 新規タブページ（URLなし）はローカルページへ戻る。生きているタブは何もしない。
/// 呼び出し元はバーのタブ切替など WebView2 のコールバック内側になり得るので、
/// add_child は browser_new_tab と同じくイベントループの後続へ積み直す
/// （内側で CreateCoreWebView2Controller すると再入デッドロックになる）。
fn revive_tab(app: &AppHandle, id: u64) -> bool {
    let revive = with_tabs(|state| {
        state
            .tabs
            .iter_mut()
            .find(|tab| tab.id == id && tab.discarded)
            .map(|tab| {
                tab.discarded = false;
                tab.hidden_since = None;
                (tab.label.clone(), tab.url.clone())
            })
    })
    .flatten();
    let Some((label, url)) = revive else { return false };
    let target = match tauri::Url::parse(&url) {
        Ok(parsed) => WebviewUrl::External(parsed),
        Err(_) => WebviewUrl::App(NEW_TAB_PAGE.into()),
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        let failed = handle.clone();
        let failed_label = label.clone();
        if handle.clone().run_on_main_thread(move || {
            if !BROWSER_VISIBLE.load(Ordering::SeqCst) {
                with_tabs(|state| {
                    if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) {
                        tab.discarded = true;
                    }
                });
                return;
            }
            // 実体化のあいだにタブが閉じられたら孤児webviewになるので作らない。
            let exists = with_tabs(|state| state.tabs.iter().any(|tab| tab.id == id))
                .unwrap_or(false);
            if !exists {
                return;
            }
            let Some(window) = handle.get_window(MAIN_LABEL) else {
                let absent = handle.get_webview(&label).is_none();
                with_tabs(|state| mark_tab_discarded(state, id, absent));
                notify_tabs(&handle);
                return;
            };
            if build_tab_webview(&handle, &window, id, &label, target).is_some() {
                if let Some(view) = handle.get_webview(&label) {
                    hook_tab_media(&handle, &view, id);
                    hook_browser_shortcuts(&handle, &view, id);
                    hook_fullscreen(&handle, &view, id);
                    hook_favicon(&handle, &view, id);
                    menu::hook(&handle, &view, id);
                    #[cfg(windows)] browser_access::hook(&handle, &view, id);
                    let zoom = with_tabs(|state| state.tabs.iter().find(|tab| tab.id == id).map(|tab| tab.zoom)).flatten().unwrap_or(1.0);
                    let _ = view.set_zoom(zoom);
                }
                // activate 側の表示切替より後に実体ができるので、
                // 生成中のメニュー開閉でBOUNDSが更新されるので、配置も実体化後に張り直す。
                layout(&handle);
                // 表示・フォーカス・メモリレベルはここで張り直す。
                // その間に別タブへ切り替わっていたら隠したままにする。
                let active = BROWSER_VISIBLE.load(Ordering::SeqCst)
                    && with_tabs(|state| state.active == id).unwrap_or(false);
                if let Some(webview) = handle.get_webview(&label) {
                    let _ = if active {
                        webview.show().and_then(|_| crate::no_activate::guard(|| webview.set_focus()))
                    } else {
                        webview.hide()
                    };
                    set_tab_memory_level(&webview, !active);
                }
                notify_tabs(&handle);
            } else {
                let absent = handle.get_webview(&label).is_none();
                with_tabs(|state| mark_tab_discarded(state, id, absent));
                notify_tabs(&handle);
            }
        }).is_err() {
            let absent = failed.get_webview(&failed_label).is_none();
            with_tabs(|state| mark_tab_discarded(state, id, absent));
            notify_tabs(&failed);
        }
    });
    true
}

/// 非表示タブのメモリを寝かせる（スリーピングタブ）。見えないタブの
/// レンダラを LOW に落とし、表示へ戻すタブだけ NORMAL に戻す。
#[cfg(windows)]
fn set_tab_memory_level(webview: &tauri::Webview, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    let _ = webview.with_webview(move |platform| unsafe {
        if let Ok(core) = platform.controller().CoreWebView2() {
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let _ = core19.SetMemoryUsageTargetLevel(if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                });
            }
        }
    });
}

#[cfg(not(windows))]
fn set_tab_memory_level(_webview: &tauri::Webview, _low: bool) {}

fn activate(app: &AppHandle, id: u64) {
    if with_tabs(|state| state.active != id || state.tabs.iter().find(|tab| tab.id == id).is_none_or(|tab| tab.discarded)).unwrap_or(true) { close_download_history(app); }
    reading::before_activate(app, id);
    let mut probe = crate::desktop_metrics::begin_native_activation();
    if fullscreen_owner().is_some_and(|owner| owner != id) {
        leave_fullscreen(app, None, true);
    }
    let labels = with_tabs(|state| {
        if state.active != id { BROWSER_PRINT_CONTEXT_EPOCH.fetch_add(1, Ordering::SeqCst); }
        state.active = id;
        stamp_hidden_tabs(state, Some(id));
        state
            .tabs
            .iter()
            .map(|tab| (tab.id, tab.label.clone()))
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    // 廃棄済みなら作り直してから表示する（生成は遅延で実体化される）。
    revive_tab(app, id);
    for (tab_id, label) in labels {
        if let Some(webview) = app.get_webview(&label) {
            if tab_id == id && BROWSER_VISIBLE.load(Ordering::SeqCst) {
                if let Some(probe) = probe.as_mut() {
                    probe.memory(|| set_tab_memory_level(&webview, false));
                    let _ = probe.show(|| webview.show());
                    let _ = probe.focus(|| crate::no_activate::guard(|| webview.set_focus()));
                } else {
                    set_tab_memory_level(&webview, false);
                    let _ = webview.show();
                    let _ = crate::no_activate::guard(|| webview.set_focus());
                }
            } else {
                if let Some(probe) = probe.as_mut() {
                    let _ = probe.hide(|| webview.hide());
                    probe.memory(|| set_tab_memory_level(&webview, true));
                } else {
                    let _ = webview.hide();
                    set_tab_memory_level(&webview, true);
                }
            }
        }
    }
    notify_tabs(app);
    if let Some(probe) = probe { probe.finish(); }
}

/// タブをまとめて表示/非表示にする。表示時はアクティブタブだけ出し、
/// それが廃棄済みなら作り直す。隠す間は全タブへ隠蔽開始時刻を刻み、
/// 長く戻らなければ reaper が廃棄する。
fn set_visible(app: &AppHandle, visible: bool) {
    if !visible { close_download_history(app); }
    sync_native_tabs(app, visible);
    let visible = visible && BROWSER_VISIBLE.load(Ordering::SeqCst);
    if !visible { leave_fullscreen(app, None, true); }
    let items = with_tabs(|state| {
        let shown = visible.then_some(state.active);
        stamp_hidden_tabs(state, shown);
        (
            state.active,
            state
                .tabs
                .iter()
                .map(|tab| (tab.id, tab.label.clone()))
                .collect::<Vec<_>>(),
        )
    })
    .unwrap_or_default();
    if visible {
        revive_tab(app, items.0);
    }
    for (id, label) in items.1 {
        if let Some(webview) = app.get_webview(&label) {
            let _ = if visible && id == items.0 {
                webview.show()
            } else {
                webview.hide()
            };
            set_tab_memory_level(&webview, !(visible && id == items.0));
        }
    }
}

pub(crate) fn native_tabs_interactive() -> bool {
    BROWSER_VISIBLE.load(Ordering::SeqCst) && !MODAL_OCCLUDED.load(Ordering::SeqCst) && fullscreen_owner().is_none()
}

pub(crate) fn native_tab_rows() -> Vec<crate::native_browser_tabs::Row> {
    browser_tabs().iter().map(|tab| crate::native_browser_tabs::row(tab.id, &tab.title, &tab.url, tab.active, tab.pinned, tab.can_back, tab.can_forward, tab.loading)).collect()
}

fn sync_native_tabs(app: &AppHandle, visible: bool) {
    let rows = native_tab_rows();
    crate::native_browser_tabs::sync(app, raw_bounds(), visible && !rows.is_empty(), rows);
}

/// 通常は同梱UIのステージへ、全画面中のタブだけは窓のクライアント領域へ合わせる。
/// BOUNDS は通常表示用に保持し、全画面の解除時に同じ配置へ戻す。
fn layout(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || layout_main(&handle));
}

fn layout_main(app: &AppHandle) {
    if !native_tabs_interactive() || reading::occluded() { close_download_history(app); }
    sync_native_tabs(app, true);
    let mut probe = crate::desktop_metrics::begin_native_layout();
    let normal = bounds();
    // Physical pixels throughout: when the window is going full screen (for instance from a
    // maximized state) inner_size() can still report the old client area, so the monitor's
    // physical size is the target; the window's own client area is never smaller than it
    // once the transition finishes.
    let fullscreen = fullscreen_owner().and_then(|id| {
        let window = app.get_window(MAIN_LABEL)?;
        let inner = window.inner_size().ok()?;
        let monitor = window.current_monitor().ok().flatten().map(|m| (m.size().width, m.size().height));
        let (w, h) = crate::window_fit::fullscreen_extent((inner.width, inner.height), monitor, window.is_fullscreen().unwrap_or(false));
        Some((id, (w, h)))
    });
    let labels = with_tabs(|state| {
        state.tabs.iter().map(|tab| (tab.id, tab.label.clone())).collect::<Vec<_>>()
    }).unwrap_or_default();
    for (id, label) in labels {
        let physical = fullscreen.filter(|(owner, _)| *owner == id).map(|(_, size)| size);
        if let Some(webview) = app.get_webview(&label) {
            let hidden = MODAL_OCCLUDED.load(Ordering::SeqCst) || reading::occluded();
            let (position, size): (tauri::Position, tauri::Size) = match physical {
                Some((w, h)) => (
                    if hidden { LogicalPosition::new(-10_000.0, -10_000.0).into() } else { tauri::PhysicalPosition::new(0, 0).into() },
                    tauri::PhysicalSize::new(w, h).into(),
                ),
                None => (
                    if hidden { LogicalPosition::new(-10_000.0, -10_000.0).into() } else { LogicalPosition::new(normal.x, normal.y).into() },
                    LogicalSize::new(normal.w, normal.h).into(),
                ),
            };
            if let Some(probe) = probe.as_mut() {
                let _ = probe.position(|| webview.set_position(position));
                let _ = probe.size(|| webview.set_size(size));
            } else {
                let _ = webview.set_position(position);
                let _ = webview.set_size(size);
            }
        }
    }
    if let Some(probe) = probe { probe.finish(); }
    // 右列ブラウザは別の枠に置く。モーダル・全画面・読書ビューの切り替えもここで追従する。
    rail::layout_now(app);
    if sync_tab_overlay_main(app).is_err() { let _ = app.emit_to(MAIN_LABEL, "browser-tab-overlay-unavailable", ()); }
}

fn sync_tab_overlay_main(app: &AppHandle) -> Result<(), String> {
    let tabs = with_tabs(|state| state.tabs.iter().map(|tab| (tab.id, tab.label.clone())).collect::<Vec<_>>()).unwrap_or_default();
    for (id, label) in tabs { if let Some(view) = app.get_webview(&label) { browser_tab_overlay::apply(app, &view, id)?; } }
    Ok(())
}

#[tauri::command]
pub async fn browser_tab_overlay(app: AppHandle, webview: tauri::Webview, left: f64) -> Result<(), String> {
    crate::native_pi(&webview)?;
    if webview.label() != MAIN_LABEL { return Err("native_window_required".into()); }
    if !browser_tab_overlay::valid(left) { return Err("browser_tab_overlay_unavailable".into()); }
    let epoch = BROWSER_EPOCH.load(Ordering::SeqCst); let deadline = Instant::now() + Duration::from_secs(2);
    let active = Arc::new(AtomicBool::new(true)); let queued = Arc::clone(&active);
    let (tx, rx) = tokio::sync::oneshot::channel(); let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = if !queued.load(Ordering::SeqCst) || Instant::now() >= deadline || BROWSER_EPOCH.load(Ordering::SeqCst) != epoch { Err("browser_tab_overlay_unavailable".into()) }
        else { browser_tab_overlay::set(left).and_then(|_| sync_tab_overlay_main(&handle)) };
        let _ = tx.send(result);
    }).map_err(|_| "browser_tab_overlay_unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(2), rx).await; active.store(false, Ordering::SeqCst);
    result.map_err(|_| "browser_tab_overlay_unavailable")?.map_err(|_| "browser_tab_overlay_unavailable")?
}

/// ページの上に重なる同梱UIのHTML（メニュー、ツールチップ、候補一覧など）の矩形（ページ左上が原点の CSS px）。
/// その矩形だけページを切り抜いてHTMLを見せる。空の一覧で戻す。
#[tauri::command]
pub async fn browser_page_holes(app: AppHandle, webview: tauri::Webview, rects: Vec<[f64; 4]>) -> Result<(), String> {
    crate::native_pi(&webview)?;
    if webview.label() != MAIN_LABEL { return Err("native_window_required".into()); }
    if !browser_tab_overlay::valid_holes(&rects) { return Err("browser_tab_overlay_unavailable".into()); }
    let (tx, rx) = tokio::sync::oneshot::channel(); let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(browser_tab_overlay::set_holes(rects).and_then(|_| sync_tab_overlay_main(&handle)));
    }).map_err(|_| "browser_tab_overlay_unavailable")?;
    tokio::time::timeout(Duration::from_secs(2), rx).await.map_err(|_| "browser_tab_overlay_unavailable")?.map_err(|_| "browser_tab_overlay_unavailable")?
}

/// 動画・音楽の小窓の位置と大きさ（ページ左上が原点の CSS px）。その矩形だけページを切り抜いて小窓を見せる。0 で消す。
#[tauri::command]
pub async fn browser_mini_overlay(app: AppHandle, webview: tauri::Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    crate::native_pi(&webview)?;
    if webview.label() != MAIN_LABEL { return Err("native_window_required".into()); }
    if !browser_tab_overlay::valid_mini(x, y, width, height) { return Err("browser_tab_overlay_unavailable".into()); }
    let (tx, rx) = tokio::sync::oneshot::channel(); let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(browser_tab_overlay::set_mini(x, y, width, height).and_then(|_| sync_tab_overlay_main(&handle)));
    }).map_err(|_| "browser_tab_overlay_unavailable")?;
    tokio::time::timeout(Duration::from_secs(2), rx).await.map_err(|_| "browser_tab_overlay_unavailable")?.map_err(|_| "browser_tab_overlay_unavailable")?
}

/// ウォレット確認モーダルのあいだ、子webviewを画面外へ退ける。
/// モーダルはメイン窓のDOMにあり、子webviewが全面を覆っていると
/// 押せない・見えない。応答後に layout で元へ戻す。
pub fn occlude_for_modal(app: &AppHandle, occluded: bool) {
    if occluded { close_download_history(app); }
    MODAL_OCCLUDED.store(occluded, Ordering::SeqCst);
    if !occluded {
        layout(app);
        return;
    }
    leave_fullscreen(app, None, true);
    layout(app);
}

/// 窓のリサイズにブラウザのレイアウトを追従させる。一度だけ登録する。
/// 合わせ先はページが最後に通知した領域（BOUNDS）なので、窓をリサイズしても
/// ページ側の ResizeObserver からの更新が届くまで旧領域のままになる。
static RESIZE_HOOKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn hook_resize(app: &AppHandle, window: &tauri::Window) {
    if RESIZE_HOOKED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    window.on_window_event(move |event| {
        // The window refit after a scale change is registered at startup (window_fit::watch_main_window).
        // Resized, a scale change and a move to another monitor all change the physical client area.
        if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Moved(_)) {
            layout(&handle);
        }
    });
}

/// 「ブラウザ」行き先の中へ入る。初回だけ最初のタブを作り、以後は
/// 再表示する。rect はページ側が測ったステージ領域（タブwebviewの置き場）。
/// add_child は WebView2 の WebResourceRequested コールバック内側で呼ぶと
/// 再入デッドロックになるので、イベントループの後続タスクとして積み直す。
fn enter(app: &AppHandle, rect: BrowserRect, initial: Option<tauri::Url>) {
    set_bounds(rect);
    let epoch = BROWSER_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    BROWSER_VISIBLE.store(true, Ordering::SeqCst);
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = handle.clone().run_on_main_thread(move || {
            if !BROWSER_VISIBLE.load(Ordering::SeqCst)
                || BROWSER_EPOCH.load(Ordering::SeqCst) != epoch
            {
                return;
            }
            let Some(window) = handle.get_window(MAIN_LABEL) else {
                return;
            };
            hook_resize(&handle, &window);
            // Web版Hub宛の初期URLは開かない。アプリとWeb版は分けるので、
            // ブロック通知だけ出して新規タブページへ落とす。
            let initial = match initial {
                Some(url) if is_hub_page(&url) => {
                    emit_hub_blocked(&handle, &url);
                    None
                }
                other => other,
            };
            let spawned = with_tabs(|state| state.tabs.is_empty()).unwrap_or(true);
            if spawned {
                let (target, shown) = match &initial {
                    Some(url) => (WebviewUrl::External(url.clone()), url.to_string()),
                    None => (WebviewUrl::App(NEW_TAB_PAGE.into()), String::new()),
                };
                if spawn_tab(&handle, &window, target, &shown).is_none() {
                    return;
                }
                if let Some(id) = with_tabs(|state| state.tabs.first().map(|tab| tab.id)).flatten()
                {
                    activate(&handle, id);
                }
            }
            layout(&handle);
            // アクティブタブが廃棄済みなら、指定URLをそのまま復元先にする
            // （revive は遅延で実体化するので、ここで登録しておく）。
            if !spawned {
                if let Some(url) = &initial {
                    with_tabs(|state| {
                        if let Some(tab) = state
                            .tabs
                            .iter_mut()
                            .find(|tab| tab.id == state.active && tab.discarded)
                        {
                            tab.url = url.to_string();
                        }
                    });
                }
            }
            if BROWSER_EPOCH.load(Ordering::SeqCst) != epoch {
                set_visible(&handle, BROWSER_VISIBLE.load(Ordering::SeqCst));
                return;
            }
            set_visible(&handle, true);
            if !spawned {
                if let Some(url) = initial {
                    if let Some(webview) = active_webview(&handle) {
                        let _ = webview.navigate(url);
                    }
                }
            }
            notify_tabs(&handle);
        });
    });
}

#[tauri::command]
pub fn browser_enter(app: AppHandle, rect: BrowserRect, url: Option<String>) {
    enter(&app, rect, url.as_deref().and_then(parse_target));
}

static REAPER_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 隠れて DISCARD_AFTER を超えたタブのwebviewを定期的に破棄する。
/// webviewの操作はメインスレッド必須なので、検査と破棄は run_on_main_thread
/// へ積み直す。終了したアプリへは積めないので失敗したらループを抜ける。
fn start_reaper(app: &AppHandle) {
    if REAPER_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(REAP_INTERVAL);
        let inner = handle.clone();
        if handle
            .run_on_main_thread(move || discard_stale(&inner))
            .is_err()
        {
            break;
        }
    });
}

/// 破棄対象かどうか。表示中（hidden_since なし）と廃棄済みは対象外なので、
/// アクティブタブは絶対に破棄されない。
/// 音を出している隠れたタブ（裏で流している音楽など）は自動では休ませない（Chrome/Edgeと同じ）。
fn tab_can_sleep(tab: &Tab) -> bool {
    !tab.private && !tab.discarded && tab.hidden_since.is_some()
}

fn tab_is_playing_audio(tab: &Tab) -> bool {
    tab.media.as_ref().and_then(|media| media.playing_audio) == Some(true)
}

fn tab_is_stale(tab: &Tab, now: Instant) -> bool {
    tab_can_sleep(tab)
        && !tab_is_playing_audio(tab)
        && tab
            .hidden_since
            .is_some_and(|since| now.duration_since(since) >= discard_after())
}

/// 隠れ続けているタブを探してwebviewを閉じ、タブとURLだけ残す。
/// アクティブタブと表示中のタブは hidden_since を持たないので対象外。
fn discard_stale(app: &AppHandle) {
    let now = Instant::now();
    discard_where(app, |tab| tab_is_stale(tab, now));
}

/// 条件に合うタブのwebviewを閉じて「休止中」にし、休ませた数を返す。
fn discard_where(app: &AppHandle, pick: impl Fn(&Tab) -> bool) -> usize {
    let targets = with_tabs(|state| {
        state
            .tabs
            .iter()
            .filter(|tab| pick(tab))
            .map(|tab| (tab.id, tab.label.clone()))
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    if targets.is_empty() {
        return 0;
    }
    let mut slept = 0;
    for (id, label) in targets {
        let closed = app.get_webview(&label).is_none_or(|webview| protection::close(&webview).is_ok());
        if closed { slept += 1; }
        with_tabs(|state| mark_tab_discarded(state, id, closed));
    }
    // 休止をタブ一覧の表示（「休止中」）へ反映する。
    notify_tabs(app);
    slept
}

/// 手動で休ませてよいタブか。表示中・プライベート・休止済みは除く。
/// 一括のときは音を出しているタブも残す。
fn tab_can_sleep_now(tab: &Tab, bulk: bool) -> bool {
    tab_can_sleep(tab) && !(bulk && tab_is_playing_audio(tab))
}

/// タブを今すぐ休ませる（Edgeの「タブをスリープ状態にする」）。選ぶとすぐ再開する。
#[tauri::command]
pub fn browser_sleep_tab(app: AppHandle, webview: tauri::Webview, id: u64) -> Result<(), String> {
    rail_from_main(&webview)?;
    let ok = with_tabs(|state| state.tabs.iter().any(|tab| tab.id == id && tab_can_sleep_now(tab, false))).unwrap_or(false);
    if !ok { return Err("tab_not_sleepable".into()); }
    if discard_where(&app, |tab| tab.id == id && tab_can_sleep_now(tab, false)) == 0 { return Err("tab_not_sleepable".into()); }
    Ok(())
}

/// 隠れているタブをまとめて休ませる。音を出しているタブとプライベートは残す。
#[tauri::command]
pub fn browser_sleep_background_tabs(app: AppHandle, webview: tauri::Webview) -> Result<usize, String> {
    rail_from_main(&webview)?;
    Ok(discard_where(&app, |tab| tab_can_sleep_now(tab, true)))
}

/// ブラウザ面のバックグラウンド処理を起こす。進入/追従/退出は同梱UIが
/// browser_enter/browser_layout/browser_exit コマンドで行う。リモートの
/// ページがイベントで子webviewを生やす経路は持たない（2026-10-05、
/// Web側の「ブラウザ」行き先の撤去に合わせて閉じた）。
pub fn start_browser_background(app: &AppHandle) {
    std::sync::LazyLock::force(&PREVIOUS_SESSION);
    start_reaper(app);
}

/// 別の行き先へ移った。子webviewを隠すだけでタブは残り、
/// ブラウザへ戻ると続きから再開する。
#[tauri::command]
pub fn browser_exit(app: AppHandle) {
    leave_f11_fullscreen(&app);
    browser_tab_overlay::clear();
    close_download_history(&app);
    BROWSER_VISIBLE.store(false, Ordering::SeqCst);
    BROWSER_EPOCH.fetch_add(1, Ordering::SeqCst);
    reading::reconcile(&app);
    set_visible(&app, false);
}

#[tauri::command]
pub fn browser_layout(app: AppHandle, rect: BrowserRect) {
    set_bounds(rect);
    layout(&app);
}

// 右列ブラウザ。操作できるのは同梱UI（main）だけで、外部ページからは届かない。
fn rail_from_main(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() == MAIN_LABEL { Ok(()) } else { Err("rail_browser_unavailable".into()) }
}

/// 右列の枠（CSS px）と、見せるかどうか。rect が無い・visible が偽なら隠す（破棄はしない）。
#[tauri::command]
pub async fn rail_browser_layout(app: AppHandle, webview: tauri::Webview, rect: Option<BrowserRect>, visible: bool) -> Result<(), String> {
    rail_from_main(&webview)?;
    rail::set_layout(&app, rect, visible);
    Ok(())
}

/// 右列webviewを（無ければ）作り、url があればそこへ移る。http/https だけ。
#[tauri::command]
pub async fn rail_browser_open(app: AppHandle, webview: tauri::Webview, url: Option<String>, home: Option<bool>) -> Result<(), String> {
    rail_from_main(&webview)?;
    let target = match url { Some(raw) => Some(rail::open_target(&raw).ok_or("invalid_url")?), None => None };
    rail::open(&app, target, home.unwrap_or(false));
    Ok(())
}

#[tauri::command]
pub async fn rail_browser_back(app: AppHandle, webview: tauri::Webview) -> Result<(), String> { rail_from_main(&webview)?; rail::back(&app) }
#[tauri::command]
pub async fn rail_browser_forward(app: AppHandle, webview: tauri::Webview) -> Result<(), String> { rail_from_main(&webview)?; rail::forward(&app) }
#[tauri::command]
pub async fn rail_browser_reload(app: AppHandle, webview: tauri::Webview) -> Result<(), String> { rail_from_main(&webview)?; rail::reload(&app) }
#[tauri::command]
pub async fn rail_browser_stop(app: AppHandle, webview: tauri::Webview) -> Result<(), String> { rail_from_main(&webview)?; rail::stop(&app) }
/// 右列のページへアプリの配色（ダークか）を伝える。この webview の prefers-color-scheme だけを変える。
#[tauri::command]
pub async fn rail_browser_scheme(app: AppHandle, webview: tauri::Webview, dark: bool) -> Result<(), String> { rail_from_main(&webview)?; rail::set_scheme(&app, dark) }
/// 中央のプレーヤーが鳴り始めたとき、右列のページの再生を止める。
#[tauri::command]
pub async fn rail_browser_pause_media(app: AppHandle, webview: tauri::Webview) -> Result<(), String> { rail_from_main(&webview)?; rail::pause_media(&app) }
#[tauri::command]
pub async fn rail_browser_state(webview: tauri::Webview) -> Result<rail::Info, String> { rail_from_main(&webview)?; Ok(rail::info()) }

/// 「ブラウザを開く」の入口。窓を前面に出したうえで、同梱UIへ
/// browser-open-request を届ける。UI側がブラウザ面へ切り替えて
/// 実測領域で browser_enter を呼ぶ。
pub fn show_browser(initial: Option<String>) {
    let Some(app) = hub_window::app_handle() else { return };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(main) = handle.get_window(MAIN_LABEL) {
            let _ = main.show();
            let _ = crate::no_activate::guard(|| main.unminimize());
            let _ = crate::no_activate::guard(|| main.set_focus());
        }
        let _ = handle.emit_to(
            MAIN_LABEL,
            "browser-open-request",
            serde_json::json!({ "url": initial }),
        );
    });
}

#[tauri::command]
pub fn browser_tabs() -> Vec<TabInfo> {
    let state = match TABS.lock() {
        Ok(guard) => guard,
        Err(_) => return Vec::new(),
    };
    let Some(state) = state.as_ref() else { return Vec::new() };
    state
        .tabs
        .iter()
        .map(|tab| TabInfo {
            id: tab.id,
            url: tab.url.clone(),
            active: tab.id == state.active,
            discarded: tab.discarded,
            title: tab.title.clone(), loading: tab.loading, pinned: tab.pinned, zoom: tab.zoom, can_back: tab.can_back, can_forward: tab.can_forward, group: tab.group.clone(), r#private: tab.private,
            muted: tab.media.as_ref().filter(|_| !tab.discarded).and_then(|media| media.muted),
            playing_audio: tab.media.as_ref().filter(|_| !tab.discarded).and_then(|media| media.playing_audio),
            can_mute: !tab.discarded && tab.media.as_ref().is_some_and(BrowserMediaObservation::can_mute),
            can_print: !tab.discarded && tab.media.as_ref().is_some_and(|media| media.can_print && media.context_identity.is_some()),
            print_context_token: media_print_context_token(tab, BROWSER_EPOCH.load(Ordering::SeqCst), BROWSER_PRINT_CONTEXT_EPOCH.load(Ordering::SeqCst)),
            favicon: tab.favicon.clone(),
        })
        .collect()
}

#[tauri::command]
pub fn browser_workspace_snapshot(webview: tauri::Webview) -> Result<BrowserWorkspaceSnapshot, String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    Ok(BrowserWorkspaceSnapshot {
        version: 1,
        tabs: browser_tabs(),
        favorites: browser_favorites()?,
        history: browser_history(),
    })
}

/// Metadata-only diagnostics for the opt-in process controller. Never return
/// URLs, titles, document content, history, permissions, or session credentials.
pub(crate) fn control_status(app: &AppHandle) -> serde_json::Value {
    let tabs = browser_tabs();
    let scale = app.get_window(MAIN_LABEL).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
    let rows: Vec<_> = tabs.iter().map(|tab| {
        let view = app.get_webview(&format!("browser-tab-{}", tab.id));
        let rect = view.as_ref().and_then(|v| {
            let position = v.position().ok()?.to_logical::<f64>(scale);
            let size = v.size().ok()?.to_logical::<f64>(scale);
            Some(serde_json::json!({"x":position.x,"y":position.y,"w":size.width,"h":size.height}))
        });
        let (page_load, child_lifetime) = if view.is_some() && !tab.discarded {
            with_tabs(|state| state.tabs.iter().find(|current| current.id == tab.id)
                .filter(|current| !current.discarded).and_then(|current| current.page_load.as_ref())
                .map(|observation| (observation.counts, observation.current_lifetime())))
                .flatten().unwrap_or((None, None))
        } else { (None, None) };
        let page_load = page_load.map(|(started, finished)| serde_json::json!({"started":started,"finished":finished}))
            .unwrap_or(serde_json::Value::Null);
        serde_json::json!({"id":tab.id,"active":tab.active,"blank":tab.url.is_empty(),
            "discarded":tab.discarded,"pinned":tab.pinned,"viewExists":view.is_some(),"rect":rect,
            "private":tab.r#private && with_tabs(|state| state.tabs.iter().find(|current| current.id == tab.id).is_some_and(|current| current.private_ready)).unwrap_or(false),
            "loading":tab.loading,"pageLoad":page_load,"childLifetime":child_lifetime})
    }).collect();
    let rect = bounds();
    serde_json::json!({"visible":BROWSER_VISIBLE.load(Ordering::SeqCst),"tabs":rows,
        "activeTabId":tabs.iter().find(|t| t.active).map(|t| t.id),
        "stageRect":{"x":rect.x,"y":rect.y,"w":rect.w,"h":rect.h},
        "previousSessionTabs":browser_session_status()})
}

#[tauri::command]
pub fn browser_new_tab(app: AppHandle, url: Option<String>) -> Result<(), String> {
    new_tab_mode(app, url, false)
}

#[tauri::command]
pub async fn browser_new_private_tab(app: AppHandle, webview: tauri::Webview, url: Option<String>) -> Result<(), String> {
    if webview.label() != MAIN_LABEL || !cfg!(windows) { return Err("private_unavailable".into()); }
    let (tx, rx) = std::sync::mpsc::channel();
    queue_new_tab(app, url, true, Some(tx))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(30))).await.map_err(|_| "private_unavailable")?.map_err(|_| "private_unavailable")?
}

pub(crate) fn control_new_private_tab(app: AppHandle) -> Result<(), String> {
    if !cfg!(windows) { return Err("private_unavailable".into()); }
    new_tab_mode(app, None, true)
}
fn new_tab_mode(app: AppHandle, url: Option<String>, private: bool) -> Result<(), String> { queue_new_tab(app, url, private, None) }
fn queue_new_tab(app: AppHandle, url: Option<String>, private: bool, completion: Option<std::sync::mpsc::Sender<Result<(), String>>>) -> Result<(), String> {
    queue_tab_open(app, url, private, true, None, completion)
}

fn link_source(state: &TabState, id: u64) -> Option<&Tab> {
    state.tabs.iter().find(|tab| tab.id == id && state.active == id && !tab.discarded && (!tab.private || tab.private_ready))
}

fn popup_target(raw: &str) -> Option<tauri::Url> {
    if raw.len() > 32768 || raw.encode_utf16().count() > 8192 || raw.chars().any(char::is_control) { return None; }
    tauri::Url::parse(raw).ok().filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some() && url.username().is_empty() && url.password().is_none() && !is_hub_page(url) && !is_internal_url(url, None))
}

fn place_link_tab(state: &mut TabState, id: u64, source: u64) -> bool {
    let Some(position) = state.tabs.iter().position(|tab| tab.id == source) else { return false };
    let parent = &state.tabs[position];
    let group = parent.group.clone(); let private = parent.private;
    let position = if parent.pinned { state.tabs.iter().take_while(|tab| tab.pinned).count() } else { position + 1 };
    let Some(child) = state.tabs.iter_mut().find(|tab| tab.id == id && tab.private == private && !tab.pinned) else { return false };
    child.group = group;
    move_tab(state, id, position.min(state.tabs.len().saturating_sub(1))).is_ok()
}

#[tauri::command]
pub async fn browser_open_tab(app: AppHandle, webview: tauri::Webview, url: String, foreground: bool) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    let (source, private) = with_tabs(|state| link_source(state, state.active).map(|tab| (tab.id, tab.private))).flatten().ok_or("tab_not_found")?;
    let (tx, rx) = std::sync::mpsc::channel();
    queue_tab_open(app, Some(url), private, foreground, Some(source), Some(tx))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(30))).await.map_err(|_| "tab_creation_failed")?.map_err(|_| "tab_creation_failed")?
}

fn queue_tab_open(app: AppHandle, url: Option<String>, private: bool, foreground: bool, source: Option<u64>, completion: Option<std::sync::mpsc::Sender<Result<(), String>>>) -> Result<(), String> {
    let target = url.as_deref().map(|raw| parse_target(raw).ok_or("invalid_url")).transpose()?;
    if let Some(url) = target.as_ref().filter(|url| is_hub_page(url)) { emit_hub_blocked(&app, url); return Err("hub_origin_blocked".into()); }
    if with_tabs(|state| state.tabs.len() >= 64).unwrap_or(false) { return Err("tab_limit".into()); }
    // 子webviewからのinvokeはWebView2のWebResourceRequestedコールバック内側で
    // メインスレッド上に同期実行される。その内側で CreateCoreWebView2Controller
    // を呼ぶと完了コールバックが同じイベントを抜けるまで配信されず、
    // wryのwait_with_pumpが永久待ちになる（再入デッドロック）。
    // いったん別スレッドへ逃がし、そこからイベントループへ新規タスクとして
    // 積み直すと、コールバックを抜けた後の通常処理として生成できる。
    std::thread::spawn(move || {
        let _ = app.clone().run_on_main_thread(move || {
            if !BROWSER_VISIBLE.load(Ordering::SeqCst) {
                if let Some(tx) = completion { let _ = tx.send(Err("browser_unavailable".into())); }
                return;
            }
            let Some(window) = app.get_window(MAIN_LABEL) else { if let Some(tx) = completion { let _ = tx.send(Err("browser_unavailable".into())); } return };
            let group = source.and_then(|id| with_tabs(|state| link_source(state, id).map(|tab| tab.group.clone())).flatten());
            if source.is_some() && group.is_none() {
                if let Some(tx) = completion { let _ = tx.send(Err("tab_not_found".into())); }
                return;
            }
            // 宛先指定が無ければローカルの新規タブページを開く。
            // ネットワークを待たないのでタブ生成が軽く、実際のページ読込は
            // そこからの遷移だけになる。
            if let Some(url) = target.as_ref().filter(|url| is_hub_page(url)) {
                emit_hub_blocked(&app, url);
                if let Some(tx) = completion { let _ = tx.send(Err("hub_origin_blocked".into())); }
                return;
            }
            let (target, shown) = match target {
                Some(url) => (WebviewUrl::External(url.clone()), url.to_string()),
                None => (WebviewUrl::App(NEW_TAB_PAGE.into()), String::new()),
            };
            if let Some(webview) = spawn_tab_mode(&app, &window, target, &shown, private, false) {
                let id = webview
                    .label()
                    .trim_start_matches("browser-tab-")
                    .parse()
                    .unwrap_or(0);
                if source.is_some_and(|source| !with_tabs(|state| place_link_tab(state, id, source)).unwrap_or(false)) {
                    let _ = protection::close(&webview); with_tabs(|state| state.tabs.retain(|tab| tab.id != id)); notify_tabs(&app);
                    if let Some(tx) = completion { let _ = tx.send(Err("tab_not_found".into())); }
                    return;
                }
                let current = with_tabs(|state| state.active).unwrap_or(id);
                // Creation pumps messages. A later user selection must keep its focus.
                if foreground && source.is_none_or(|source| current == source) { activate(&app, id); }
                else { let _ = webview.hide(); activate(&app, current); }
                if let Some(tx) = completion { let _ = tx.send(Ok(())); }
            } else {
                let code = if private { "private_unavailable" } else { "tab_creation_failed" };
                let _ = app.emit_to(MAIN_LABEL, "browser-operation-error", code);
                if let Some(tx) = completion { let _ = tx.send(Err(code.into())); }
            }
        });
    });
    Ok(())
}

#[tauri::command]
pub fn browser_close_tab(app: AppHandle, id: u64) -> Result<(), String> {
    let label = with_tabs(|state| {
        state
            .tabs
            .iter()
            .find(|tab| tab.id == id)
            .map(|tab| if tab.pinned { Err("tab_pinned") } else { Ok(tab.label.clone()) })
    })
    .flatten()
    .ok_or("tab_not_found")??;
    leave_fullscreen(&app, Some(id), true);
    if let Some(webview) = app.get_webview(&label) {
        let _ = protection::close(&webview);
    }
    let remaining = with_tabs(|state| {
        let position = state.tabs.iter().position(|tab| tab.id == id).unwrap_or(0);
        if let Some(tab) = state.tabs.get(position).filter(|tab| !tab.url.is_empty() && !tab.private) {
            state.closed.push(ClosedTab { url: tab.url.clone(), title: tab.title.clone(), zoom: tab.zoom, position, group: tab.group.clone(), muted: tab.desired_muted });
            if state.closed.len() > 20 { state.closed.remove(0); }
        }
        state.tabs.retain(|tab| tab.id != id);
        (state.active == id, state.tabs.get(position.min(state.tabs.len().saturating_sub(1))).map(|tab| tab.id))
    })
    .unwrap_or((false, None));
    match remaining {
        // 最後のタブを閉じたら子webviewを畳む。行き先ページは browser-closed
        // を受けて再開の導線を出す。
        (_, None) => {
            save_session();
            set_visible(&app, false);
            let _ = app.emit_to(MAIN_LABEL, "browser-closed", ());
        }
        (true, Some(next)) => activate(&app, next),
        _ => notify_tabs(&app),
    }
    Ok(())
}

/// 指定タブ以外を閉じる（ピン留めは残す）。閉じたタブは「閉じたタブを開く」の履歴に積まれる。
#[tauri::command]
pub fn browser_close_other_tabs(app: AppHandle, id: u64) -> Result<(), String> {
    menu::close_many(&app, id, false)
}

/// 指定タブより右のタブを閉じる（ピン留めは残す）。
#[tauri::command]
pub fn browser_close_tabs_to_right(app: AppHandle, id: u64) -> Result<(), String> {
    menu::close_many(&app, id, true)
}

#[tauri::command]
pub fn browser_activate_tab(app: AppHandle, id: u64) -> Result<(), String> {
    if !with_tabs(|state| state.tabs.iter().any(|tab| tab.id == id)).unwrap_or(false) {
        return Err("tab_not_found".to_owned());
    }
    activate(&app, id);
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let target = parse_target(&url).ok_or("invalid_url")?;
    if is_hub_page(&target) {
        emit_hub_blocked(&app, &target);
        return Err("hub_origin_blocked".to_owned());
    }
    active_webview(&app)
        .ok_or("browser_unavailable")?
        .navigate(target)
        .map_err(|_| "navigation_failed".to_owned())
}

// A delayed address submission must never follow a newly selected tab.
fn address_tab_label(state: &TabState, id: u64) -> Result<String, String> {
    if id == 0 || id > 9_007_199_254_740_991 || state.active != id { return Err("tab_not_active".into()); }
    state.tabs.iter().find(|tab| tab.id == id).map(|tab| tab.label.clone()).ok_or_else(|| "tab_not_found".into())
}

#[tauri::command]
pub fn browser_navigate_from_address(app: AppHandle, webview: tauri::Webview, id: u64, url: String) -> Result<(), String> {
    if webview.label() != MAIN_LABEL || !native_tabs_interactive() { return Err("browser_unavailable".into()); }
    let target = parse_target(&url).ok_or("invalid_url")?;
    if is_hub_page(&target) {
        emit_hub_blocked(&app, &target);
        return Err("hub_origin_blocked".into());
    }
    let label = with_tabs(|state| address_tab_label(state, id)).ok_or("browser_unavailable")??;
    app.get_webview(&label).ok_or("browser_unavailable")?.navigate(target).map_err(|_| "navigation_failed".into())
}

/// WebView2 のネイティブ履歴操作をアクティブタブへ届ける。
/// wry の eval() は子webviewでは実行されないので、Windows では
/// ICoreWebView2Controller 経由で直接呼ぶ。
#[cfg(windows)]
fn with_active_core(
    app: &AppHandle,
    action: impl FnOnce(
            webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
        ) + Send
        + 'static,
) -> Result<(), String> {
    active_webview(app)
        .ok_or("browser_unavailable")?
        .with_webview(move |platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                action(core);
            }
        })
        .map_err(|_| "navigation_failed".to_owned())
}

#[tauri::command]
pub fn browser_back(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        with_active_core(&app, |core| unsafe {
            let _ = core.GoBack();
        })
    }
    #[cfg(not(windows))]
    {
        active_webview(&app)
            .ok_or("browser_unavailable")?
            .eval("history.back()")
            .map_err(|_| "navigation_failed".to_owned())
    }
}

#[tauri::command]
pub fn browser_forward(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        with_active_core(&app, |core| unsafe {
            let _ = core.GoForward();
        })
    }
    #[cfg(not(windows))]
    {
        active_webview(&app)
            .ok_or("browser_unavailable")?
            .eval("history.forward()")
            .map_err(|_| "navigation_failed".to_owned())
    }
}

#[tauri::command]
pub fn browser_reload(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        with_active_core(&app, |core| unsafe {
            let _ = core.Reload();
        })
    }
    #[cfg(not(windows))]
    {
        active_webview(&app)
            .ok_or("browser_unavailable")?
            .eval("location.reload()")
            .map_err(|_| "navigation_failed".to_owned())
    }
}

/// キャッシュを使わない再読み込み（Ctrl+F5 / Ctrl+Shift+R）。DevTools の Page.reload を
/// 固定の引数で呼ぶだけで、ページの内容は読まない。呼べなければ普通の再読み込みに落とす。
#[tauri::command]
pub fn browser_hard_reload(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        with_active_core(&app, |core| unsafe {
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            use windows_core::HSTRING;
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
            if core.CallDevToolsProtocolMethod(&HSTRING::from("Page.reload"), &HSTRING::from(r#"{"ignoreCache":true}"#), &handler).is_err() {
                let _ = core.Reload();
            }
        })
    }
    #[cfg(not(windows))]
    {
        browser_reload(app)
    }
}

#[tauri::command]
pub fn browser_history() -> Vec<HistoryEntry> {
    read_list("browser-history.json")
}

/// 新しいタブのブロック数の表示用。この起動中にブロックした数だけを返す（読み取りのみ）。
#[tauri::command]
pub fn browser_newtab_stats() -> serde_json::Value {
    let status = protection::status();
    serde_json::json!({ "blockedCount": status.blocked_count, "enabled": status.enabled })
}

fn favorites_path() -> Result<std::path::PathBuf, String> { data_dir().map(|dir| dir.join("browser-favorites.json")).ok_or("bookmark_path_unavailable".into()) }

#[tauri::command]
pub fn browser_favorites() -> Result<Vec<Favorite>, String> { browser_bookmarks::read(&favorites_path()?) }

fn change_favorites<T>(change: impl FnOnce(&mut Vec<Favorite>) -> Result<T, String>) -> Result<T, String> {
    let _serial = FAVORITES_WRITE.lock().map_err(|_| "bookmark_unavailable")?;
    let path = favorites_path()?;
    let mut items = browser_bookmarks::read(&path)?;
    let result = change(&mut items)?;
    browser_bookmarks::write(&path, &items)?;
    Ok(result)
}
#[tauri::command]
pub fn browser_add_favorite() -> Result<(), String> {
    let url = active_tab_url().ok_or("browser_unavailable")?;
    let title = with_tabs(|state| state.tabs.iter().find(|tab| tab.id == state.active).map(|tab| tab.title.clone())).flatten().filter(|title| !title.is_empty()).unwrap_or_else(|| tauri::Url::parse(&url).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_default());
    let icon = with_tabs(|state| state.tabs.iter().find(|tab| tab.id == state.active && !tab.private && tab.url == url).and_then(|tab| tab.favicon.clone())).flatten();
    change_favorites(|items| { let item = Favorite::new(&url, &title, "")?.with_icon(icon.as_deref()); browser_bookmarks::merge(items, &[item]).map(|_| ()) })
}
#[tauri::command]
pub fn browser_remove_favorite(url: String) -> Result<(), String> {
    let url = Favorite::new(&url, "", "")?.url;
    change_favorites(|items| { items.retain(|item| item.url != url); Ok(()) })
}
#[tauri::command]
pub fn browser_update_favorite(url: String, title: String, folder: String) -> Result<(), String> {
    change_favorites(|items| { if !items.iter().any(|item| item.url == url) { return Err("bookmark_not_found".into()); } browser_bookmarks::update(items, &url, &title, &folder) })
}
#[tauri::command]
pub fn browser_move_favorite(url: String, position: usize) -> Result<(), String> { change_favorites(|items| browser_bookmarks::move_item(items, &url, position)) }
#[tauri::command]
pub fn browser_import_favorites(input: String) -> Result<usize, String> {
    let incoming = browser_bookmarks::parse_import(&input)?;
    change_favorites(|items| browser_bookmarks::merge(items, &incoming))
}
#[tauri::command]
pub fn browser_export_favorites() -> Result<String, String> { browser_bookmarks::encode_export(&browser_favorites()?) }

struct BrowserAiSource { id: u64, url: String, browser_epoch: u64, tab_epoch: u64 }

fn browser_ai_current(source: &BrowserAiSource, visible: bool, active: Option<(u64, &str)>, browser_epoch: u64, tab_epoch: u64) -> bool {
    visible && browser_epoch == source.browser_epoch && tab_epoch == source.tab_epoch
        && active == Some((source.id, source.url.as_str()))
}

fn browser_ai_prompt(url: &str, observed: Option<(&str, &str, &str)>) -> Result<String, &'static str> {
    let prompt = if let Some((observed_url, title, text)) = observed {
        if observed_url != url { return Err("browser_ai_source_changed"); }
        let excerpt: String = text.chars().take(2000).collect();
        if excerpt.is_empty() { url.to_owned() } else { format!("{url}\n{title}\n\n{excerpt}") }
    } else { url.to_owned() };
    Ok(prompt.chars().take(4000).collect())
}

#[cfg(test)]
mod browser_ai_tests {
    use super::*;
    fn source() -> BrowserAiSource { BrowserAiSource { id: 1, url: "https://one.example/".into(), browser_epoch: 3, tab_epoch: 7 } }
    #[test]
    fn draft_source_requires_the_visible_same_tab_url_and_both_generations() {
        let source = source();
        assert!(browser_ai_current(&source, true, Some((1, &source.url)), 3, 7));
        for active in [None, Some((2, source.url.as_str())), Some((1, "https://two.example/"))] {
            assert!(!browser_ai_current(&source, true, active, 3, 7));
        }
        assert!(!browser_ai_current(&source, false, Some((1, &source.url)), 3, 7));
        // Leaving and returning, or navigating/switching away and back, cannot revive a draft.
        assert!(!browser_ai_current(&source, true, Some((1, &source.url)), 5, 7));
        assert!(!browser_ai_current(&source, true, Some((1, &source.url)), 3, 9));
    }
    #[test]
    fn observed_body_must_belong_to_the_captured_url_even_if_title_and_text_are_empty() {
        let url = "https://one.example/";
        for other in ["", "https://two.example/", "https://one.example/#new", "https://one.example/?new"] {
            assert_eq!(browser_ai_prompt(url, Some((other, "", ""))), Err("browser_ai_source_changed"));
        }
        assert_eq!(browser_ai_prompt(url, Some((url, "title", "text"))).unwrap(), format!("{url}\ntitle\n\ntext"));
    }
    #[test]
    fn extraction_failure_or_empty_body_keeps_only_the_original_url() {
        let url = "https://one.example/";
        assert_eq!(browser_ai_prompt(url, None).unwrap(), url);
        assert_eq!(browser_ai_prompt(url, Some((url, "title", ""))).unwrap(), url);
        assert_eq!(browser_ai_prompt(url, Some((url, "", "body"))).unwrap(), format!("{url}\n\n\nbody"));
    }
    #[test]
    fn excerpt_and_total_caps_count_unicode_characters_without_cutting_codepoints() {
        let url = "https://one.example/";
        let body = "😀".repeat(2001);
        let draft = browser_ai_prompt(url, Some((url, "title", &body))).unwrap();
        assert_eq!(draft.strip_prefix(&format!("{url}\ntitle\n\n")).unwrap().chars().count(), 2000);
        let title = "あ".repeat(4000);
        assert_eq!(browser_ai_prompt(url, Some((url, &title, &body))).unwrap().chars().count(), 4000);
        assert_eq!(browser_ai_prompt(&"😀".repeat(4001), None).unwrap().chars().count(), 4000);
    }
}

fn browser_ai_source_current(source: &BrowserAiSource) -> bool {
    with_tabs(|state| {
        let active = state.tabs.iter().find(|tab| tab.id == state.active && !tab.discarded && (!tab.private || tab.private_ready));
        browser_ai_current(source, BROWSER_VISIBLE.load(Ordering::SeqCst), active.map(|tab| (tab.id, tab.url.as_str())),
            BROWSER_EPOCH.load(Ordering::SeqCst), BROWSER_AI_EPOCH.load(Ordering::SeqCst))
    }).unwrap_or(false)
}

#[tauri::command]
pub async fn browser_send_to_ai(webview: tauri::Webview, app: AppHandle, id: u64, url: String) -> Result<String, String> {
    browser_media_guard(&webview)?;
    if id == 0 || parse_target(&url).is_none() { return Err("browser_unavailable".into()); }
    let source = BrowserAiSource { id, url, browser_epoch: BROWSER_EPOCH.load(Ordering::SeqCst), tab_epoch: BROWSER_AI_EPOCH.load(Ordering::SeqCst) };
    if !browser_ai_source_current(&source) { return Err("browser_ai_source_changed".into()); }
    let observed = observe_page(&app, Some(source.id)).await;
    if !browser_ai_source_current(&source) { return Err("browser_ai_source_changed".into()); }
    // Extraction failure may keep the captured URL, but never a changed source.
    let fields = match &observed {
        Ok(page) => Some((page.get("url").and_then(|value| value.as_str()).ok_or("browser_ai_source_changed")?,
            page.get("title").and_then(|value| value.as_str()).unwrap_or_default(),
            page.get("text").and_then(|value| value.as_str()).unwrap_or_default())),
        Err(_) => None,
    };
    browser_ai_prompt(&source.url, fields).map_err(str::to_owned)
}

/// CDP (Chrome DevTools Protocol) の呼び出しをタブのwebviewへ中継する。
/// 完了ハンドラはイベントループへ配信されるので、呼び出しだけを
/// `with_webview` 経由でメインスレッドへ積み、結果はチャネルで受け取る。
/// ここで受信待ちはしない（待つ側はメインスレッドを止めてはいけない）。
#[cfg(windows)]
fn call_devtools(
    webview: &tauri::Webview,
    method: String,
    params: String,
    tx: std::sync::mpsc::Sender<Result<String, String>>,
) {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;
    let _ = webview.with_webview(move |platform| unsafe {
        let sync_tx = tx.clone();
        let outcome = (|| -> windows_core::Result<()> {
            let core = platform.controller().CoreWebView2()?;
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |result, json| {
                    let _ = tx.send(match result {
                        Ok(()) => Ok(json),
                        Err(err) => Err(err.to_string()),
                    });
                    Ok(())
                },
            ));
            core.CallDevToolsProtocolMethod(
                &HSTRING::from(method.as_str()),
                &HSTRING::from(params.as_str()),
                &handler,
            )
        })();
        // 呼び出し自体の失敗（webview死亡・不正メソッド等）は即時に返す。
        // 成功時は完了ハンドラが結果を送る。
        if let Err(err) = outcome {
            let _ = sync_tx.send(Err(err.to_string()));
        }
    });
}

#[cfg(not(windows))]
fn call_devtools(
    _webview: &tauri::Webview,
    _method: String,
    _params: String,
    tx: std::sync::mpsc::Sender<Result<String, String>>,
) {
    let _ = tx.send(Err("devtools_unsupported".to_owned()));
}

/// タブIDまたはアクティブタブのwebviewラベルと廃棄状態を引く。
fn devtools_tab_target(state: &TabState, tab: Option<u64>) -> Option<(String, bool)> {
    let id = tab.unwrap_or(state.active);
    state
        .tabs
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| (entry.label.clone(), entry.discarded))
}

/// CDPの生メソッド呼び出し。browser_send_to_ai がページ本文を取る内部経路。
/// 外部ページへは invoke が一切届かない（capabilities に remote 許可なし）。
/// 廃棄済みタブは実体が無いので、先に activate で復元させる。
async fn browser_devtools(
    app: AppHandle,
    tab: Option<u64>,
    method: String,
    params: Option<String>,
) -> Result<String, String> {
    let (label, discarded) = with_tabs(|state| devtools_tab_target(state, tab))
        .flatten()
        .ok_or_else(|| "tab_not_found".to_owned())?;
    if discarded {
        return Err("tab_discarded".to_owned());
    }
    let Some(webview) = app.get_webview(&label) else {
        return Err("browser_unavailable".to_owned());
    };
    let (tx, rx) = std::sync::mpsc::channel();
    call_devtools(&webview, method, params.unwrap_or_else(|| "{}".into()), tx);
    // 完了ハンドラはメインスレッドのポンプで動くので、受信は別スレッドで
    // ブロックして待つ。ここで素直に recv するとasyncワーカーを占有する。
    match tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10))).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("devtools_dropped".to_owned()),
        Err(_) => Err("devtools_join_failed".to_owned()),
    }
}

/// `Runtime.evaluate` の糖衣。式を評価してCDP結果のJSONをそのまま返す。
async fn browser_eval(
    app: AppHandle,
    tab: Option<u64>,
    expression: String,
) -> Result<String, String> {
    let params = serde_json::json!({
        "expression": expression,
        "returnByValue": true,
        "awaitPromise": true,
    })
    .to_string();
    browser_devtools(app, tab, "Runtime.evaluate".into(), Some(params)).await
}

/// Runtime.evaluate の応答から内側の値を取り出す。
/// resultAsJson はメソッド戻り値そのまま（{result:RemoteObject, exceptionDetails?}）
/// なので RemoteObject は .result、例外詳細は .exceptionDetails にある。
fn eval_value(json: &str) -> Result<serde_json::Value, String> {
    let outer: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "devtools_bad_json".to_owned())?;
    if let Some(exception) = outer.get("exceptionDetails") {
        let text = exception
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("page_exception");
        return Err(text.to_owned());
    }
    Ok(outer
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// ページの見えている内容を取る。URL・タイトル・本文先頭・リンク一覧を
/// 1回の評価で。本文は8,000文字・リンクは50件まで。browser_send_to_ai が
/// 内容をAIへ載せるために使う。
async fn observe_page(
    app: &AppHandle,
    tab: Option<u64>,
) -> Result<serde_json::Value, String> {
    const EXTRACT: &str = r#"JSON.stringify({
        url: location.href,
        title: document.title,
        text: (document.body ? document.body.innerText : '').slice(0, 8000),
        links: [...document.querySelectorAll('a[href]')].slice(0, 50).map(a => ({
            text: (a.innerText || '').trim().slice(0, 80),
            href: a.href
        }))
    })"#;
    let raw = browser_eval(app.clone(), tab, EXTRACT.into()).await?;
    match eval_value(&raw)? {
        serde_json::Value::String(json) => serde_json::from_str(&json)
            .map_err(|_| "observe_bad_json".to_owned()),
        other => Ok(other),
    }
}

#[cfg(windows)]
fn update_navigation_state(app: &AppHandle, view: &tauri::Webview, id: u64) {
    let handle = app.clone();
    let _ = view.with_webview(move |platform| unsafe {
        if let Ok(core) = platform.controller().CoreWebView2() {
            let mut back = windows_core::BOOL(0); let mut forward = windows_core::BOOL(0);
            let _ = core.CanGoBack(&mut back); let _ = core.CanGoForward(&mut forward);
            with_tabs(|state| { if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) { tab.can_back = back.as_bool(); tab.can_forward = forward.as_bool(); } });
            notify_tabs(&handle);
        }
    });
}
#[cfg(not(windows))]
fn update_navigation_state(_app: &AppHandle, _view: &tauri::Webview, _id: u64) {}

fn accelerator_action(key: u32, ctrl: bool, shift: bool, alt: bool) -> Option<String> {
    // Chrome / Edge と同じ割り当て。Alt+D・F6 はアドレス欄、Ctrl+F5・Ctrl+Shift+R はキャッシュを使わない再読み込み。
    if alt && !ctrl && !shift { return match key { 37 => Some("back".into()), 39 => Some("forward".into()), 68 => Some("address".into()), _ => None }; }
    if key == 116 && !alt { return Some(if ctrl { "hard-reload" } else { "reload" }.into()); }
    if key == 117 && !ctrl && !shift && !alt { return Some("address".into()); }
    if key == 122 && !ctrl && !shift && !alt { return Some("fullscreen".into()); }
    if !ctrl || alt { return None; }
    if matches!(key, 107 | 187) { return Some("zoom-in".into()); }
    if matches!(key, 109 | 189) { return Some("zoom-out".into()); }
    if shift { return match key { 78 => Some("private-new".into()), 84 => Some("restore".into()), 9 => Some("previous".into()), 65 => Some("tabs".into()), 66 => Some("bookmarks-toggle".into()), 79 => Some("favorites".into()), 82 => Some("hard-reload".into()), _ => None }; }
    Some(match key {
        76 => "address", 84 => "new", 87 => "close", 9 | 34 => "next", 33 => "previous", 70 => "find", 80 => "print", 82 => "reload", 48 => "zoom-reset",
        72 => "history", 74 => "downloads", 68 => "favorite",
        49..=57 => return Some(format!("tab-{}", key - 48)), _ => return None,
    }.into())
}

/// WebView2 側で変わった拡大率をタブに写す。範囲外や変化なしは何もしない。
/// 戻り値: 変わったとき Some(記憶するURL。プライベートは None)。
fn zoom_apply(state: &mut TabState, id: u64, factor: f64) -> Option<Option<String>> {
    if !valid_zoom(factor) { return None; }
    let tab = state.tabs.iter_mut().find(|tab| tab.id == id)?;
    if (tab.zoom - factor).abs() < 0.005 { return None; }
    tab.zoom = factor;
    Some((!tab.private && !tab.url.is_empty()).then(|| tab.url.clone()))
}
fn zoom_changed(id: u64, factor: f64) -> Option<Option<String>> {
    with_tabs(|state| zoom_apply(state, id, factor)).flatten()
}

/// 修飾キーなしの Esc で、読み込み中のときだけ止める。
fn escape_stops_loading(key: u32, ctrl: bool, shift: bool, alt: bool, loading: bool) -> bool {
    key == 27 && loading && !ctrl && !shift && !alt
}

/// ページから開く新しいタブを前面にするか（Chrome と同じ）。
/// target=_blank の普通のクリックは前面、Ctrl+クリック・中クリックは背面、Shift が付けば前面。
fn link_opens_in_foreground(shift: bool, ctrl: bool, middle: bool) -> bool {
    shift || !(ctrl || middle)
}

fn private_accelerator_current(state: &TabState, id: u64, child: Option<&Arc<()>>,
    expected_epoch: u64, current_epoch: u64, visible: bool, occluded: bool, repeated: bool, ime: bool) -> bool {
    visible && !occluded && !repeated && !ime && expected_epoch == current_epoch && state.active == id
        && state.tabs.iter().any(|tab| tab.id == id && !tab.discarded && (!tab.private || tab.private_ready)
            && child.is_some_and(|child| tab.media.as_ref().is_some_and(|media| Arc::ptr_eq(child, &media.child))))
}

#[cfg(windows)]
fn hook_browser_shortcuts(app: &AppHandle, view: &tauri::Webview, id: u64) {
    use webview2_com::{AcceleratorKeyPressedEventHandler, Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS}};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState;
    let handle = app.clone();
    let handle_for_zoom = app.clone();
    let child = with_tabs(|state| state.tabs.iter().find(|tab| tab.id == id)
        .and_then(|tab| tab.media.as_ref().map(|media| media.child.clone()))).flatten();
    let _ = view.with_webview(move |platform| unsafe {
        let callback = AcceleratorKeyPressedEventHandler::create(Box::new(move |controller, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN; args.KeyEventKind(&mut kind)?;
            if !matches!(kind, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN | COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN)
                || !BROWSER_VISIBLE.load(Ordering::SeqCst) || !with_tabs(|state| state.active == id).unwrap_or(false) { return Ok(()); }
            let mut key = 0; args.VirtualKey(&mut key)?;
            if key == 27 && fullscreen_owner() == Some(id) {
                args.SetHandled(true)?;
                leave_fullscreen(&handle, Some(id), true);
                return Ok(());
            }
            if key == 27 && F11_FULLSCREEN.load(Ordering::SeqCst) {
                args.SetHandled(true)?;
                leave_f11_fullscreen(&handle);
                return Ok(());
            }
            // 読み込み中の Esc は読み込みを止める（Chrome と同じ）。ページ側の Esc 処理は奪わない。
            let loading = with_tabs(|state| state.tabs.iter().any(|tab| tab.id == id && tab.loading)).unwrap_or(false);
            if escape_stops_loading(key, GetKeyState(0x11) < 0, GetKeyState(0x10) < 0, GetKeyState(0x12) < 0, loading) {
                if let Some(core) = controller.and_then(|controller| controller.CoreWebView2().ok()) { let _ = core.Stop(); }
                return Ok(());
            }
            if let Some(action) = accelerator_action(key, GetKeyState(0x11) < 0, GetKeyState(0x10) < 0, GetKeyState(0x12) < 0) {
                if action == "fullscreen" {
                    // F11 is handled natively; a held key must not flip the window repeatedly.
                    args.SetHandled(true)?;
                    let mut physical = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    if args.PhysicalKeyStatus(&mut physical).is_ok() && physical.RepeatCount == 1 && !physical.WasKeyDown.as_bool() && !physical.IsKeyReleased.as_bool() {
                        toggle_f11_fullscreen(&handle);
                    }
                    return Ok(());
                }
                if matches!(action.as_str(), "private-new" | "bookmarks-toggle") {
                    let epoch = BROWSER_EPOCH.load(Ordering::SeqCst);
                    let mut physical = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    if args.PhysicalKeyStatus(&mut physical).is_err() || !with_tabs(|state| private_accelerator_current(
                        state, id, child.as_ref(), epoch, BROWSER_EPOCH.load(Ordering::SeqCst),
                        BROWSER_VISIBLE.load(Ordering::SeqCst), MODAL_OCCLUDED.load(Ordering::SeqCst),
                        physical.RepeatCount != 1 || physical.WasKeyDown.as_bool() || physical.IsKeyReleased.as_bool(),
                        key == 229 || GetKeyState(0xe5) < 0)).unwrap_or(false) { return Ok(()); }
                }
                args.SetHandled(true)?;
                let print_context = if action == "print" {
                    with_tabs(|state| state.tabs.iter().find(|tab| tab.id == id)
                        .and_then(|tab| media_print_context_token(tab, BROWSER_EPOCH.load(Ordering::SeqCst), BROWSER_PRINT_CONTEXT_EPOCH.load(Ordering::SeqCst)))).flatten()
                } else { None };
                leave_fullscreen(&handle, Some(id), true);
                if action == "print" {
                    if let Some(context) = print_context {
                        let _ = handle.emit_to(MAIN_LABEL, "browser-print-request", serde_json::json!({"tabId":id,"contextToken":context}));
                    } else {
                        let _ = handle.emit_to(MAIN_LABEL, "browser-operation-error", "browser_print_unavailable");
                    }
                } else {
                    let _ = handle.emit_to(MAIN_LABEL, "browser-shortcut", action);
                }
            }
            Ok(())
        }));
        let mut token = 0;
        let _ = platform.controller().add_AcceleratorKeyPressed(&callback, &mut token);
        // Ctrl+ホイール・ピンチの拡大は WebView2 が自前で行う。値だけ受け取り、表示と記憶を揃える。
        let zoom_handle = handle_for_zoom;
        let zoom = webview2_com::ZoomFactorChangedEventHandler::create(Box::new(move |controller, _| {
            let Some(controller) = controller else { return Ok(()) };
            let mut factor = 1.0; controller.ZoomFactor(&mut factor)?;
            if let Some(remember) = zoom_changed(id, factor) {
                if let Some(url) = remember { save_site_zoom(&url, factor); }
                notify_tabs(&zoom_handle);
            }
            Ok(())
        }));
        let _ = platform.controller().add_ZoomFactorChanged(&zoom, &mut 0);
    });
}
#[cfg(not(windows))]
fn hook_browser_shortcuts(_app: &AppHandle, _view: &tauri::Webview, _id: u64) {}

#[tauri::command]
pub fn browser_focus_controls(app: AppHandle) -> Result<(), String> {
    leave_fullscreen(&app, None, true);
    app.get_webview(MAIN_LABEL).ok_or("browser_unavailable")?.set_focus().map_err(|_| "focus_failed".into())
}

#[tauri::command]
pub fn browser_focus_address(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    leave_fullscreen(&app, None, true);
    if crate::native_browser_tabs::focus_address(&app) { Ok(()) } else { Err("browser_unavailable".into()) }
}

#[tauri::command]
pub fn browser_pin_tab(app: AppHandle, id: u64, pinned: bool) -> Result<(), String> {
    with_tabs(|state| {
        state.tabs.iter_mut().find(|tab| tab.id == id).ok_or("tab_not_found")?.pinned = pinned;
        state.tabs.sort_by_key(|tab| !tab.pinned);
        Ok::<_, String>(())
    }).ok_or("browser_unavailable")??;
    notify_tabs(&app); Ok(())
}

fn move_tab(state: &mut TabState, id: u64, position: usize) -> Result<(), String> {
    let old = state.tabs.iter().position(|tab| tab.id == id).ok_or("tab_not_found")?;
    if position >= state.tabs.len() || state.tabs[position].pinned != state.tabs[old].pinned { return Err("invalid_tab_position".into()); }
    let tab = state.tabs.remove(old); state.tabs.insert(position, tab); Ok(())
}

#[tauri::command]
pub fn browser_move_tab(app: AppHandle, id: u64, position: usize) -> Result<(), String> {
    with_tabs(|state| move_tab(state, id, position)).ok_or("browser_unavailable")??;
    notify_tabs(&app); Ok(())
}

#[tauri::command]
pub fn browser_duplicate_tab(app: AppHandle, id: u64) -> Result<(), String> {
    let (url, private) = with_tabs(|state| state.tabs.iter().find(|tab| tab.id == id).map(|tab| (tab.url.clone(), tab.private))).flatten().ok_or("tab_not_found")?;
    new_tab_mode(app, (!url.is_empty()).then_some(url), private)
}

#[tauri::command]
pub fn browser_restore_tab(app: AppHandle) -> Result<(), String> {
    if with_tabs(|state| state.closed.is_empty()).unwrap_or(true) { return Err("no_closed_tab".into()); }
    if with_tabs(|state| state.tabs.len() >= 64).unwrap_or(false) { return Err("tab_limit".into()); }
    std::thread::spawn(move || {
        let _ = app.clone().run_on_main_thread(move || {
            if !BROWSER_VISIBLE.load(Ordering::SeqCst) { return; }
            let Some(window) = app.get_window(MAIN_LABEL) else { return };
            let Some(saved) = with_tabs(|state| state.closed.pop()).flatten() else { return };
            let Some(url) = parse_target(&saved.url).filter(|url| !is_hub_page(url)) else { return };
            let blank = with_tabs(|state| (state.tabs.len() == 1).then(|| state.tabs.first().filter(|tab| tab.url.is_empty() && !tab.pinned).map(|tab| tab.id)).flatten()).flatten();
            if let Some(view) = spawn_tab_mode(&app, &window, WebviewUrl::External(url), &saved.url, false, saved.muted) {
                let _ = view.set_zoom(saved.zoom);
                let id = with_tabs(|state| {
                    let tab = state.tabs.last_mut()?; tab.title = saved.title; tab.zoom = saved.zoom; tab.group = saved.group; let id = tab.id;
                    let pinned = state.tabs.iter().filter(|tab| tab.pinned).count();
                    let position = saved.position.max(pinned).min(state.tabs.len() - 1);
                    let _ = move_tab(state, id, position); Some(id)
                }).flatten();
                if let Some(id) = id { activate(&app, id); }
                if let Some(id) = blank { let _ = browser_close_tab(app.clone(), id); }
            } else {
                with_tabs(|state| state.closed.push(saved));
                let _ = app.emit_to(MAIN_LABEL, "browser-operation-error", "restore_failed");
            }
        });
    });
    Ok(())
}

fn valid_zoom(factor: f64) -> bool { factor.is_finite() && (0.5..=3.0).contains(&factor) }

#[tauri::command]
pub fn browser_zoom(app: AppHandle, factor: f64) -> Result<(), String> {
    if !valid_zoom(factor) { return Err("invalid_zoom".into()); }
    active_webview(&app).ok_or("browser_unavailable")?.set_zoom(factor).map_err(|_| "zoom_failed")?;
    let remember = with_tabs(|state| {
        let tab = state.tabs.iter_mut().find(|tab| tab.id == state.active)?;
        tab.zoom = factor;
        (!tab.private).then(|| tab.url.clone())
    }).flatten();
    if let Some(url) = remember { save_site_zoom(&url, factor); }
    notify_tabs(&app); Ok(())
}

fn find_expected_context(target: &BrowserMediaTarget, expected_url: &str, expected_context_token: &str) -> bool {
    target.print && valid_print_context_token(expected_context_token)
        && target.url == expected_url && target.context_token == expected_context_token
}
fn find_result(raw: &str) -> Result<bool, String> {
    if raw.len() > 65536 { return Err("find_unavailable".into()); }
    eval_value(raw).map_err(|_| "find_unavailable".to_owned())?.as_bool().ok_or_else(|| "find_unavailable".into())
}
#[cfg(windows)]
fn send_find_reply(sender: &Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<bool, String>>>>>, result: Result<bool, String>) {
    if let Some(tx) = sender.lock().ok().and_then(|mut slot| slot.take()) { let _ = tx.send(result); }
}
#[cfg(windows)]
fn dispatch_find(view: &tauri::Webview, app: AppHandle, target: Arc<BrowserMediaTarget>, expression: String,
    tx: tokio::sync::oneshot::Sender<Result<bool, String>>) {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;
    let sender = Arc::new(Mutex::new(Some(tx))); let failed = Arc::clone(&sender);
    if view.with_webview(move |platform| unsafe {
        if sender.lock().ok().is_none_or(|slot| slot.as_ref().is_none_or(|tx| tx.is_closed())) { return; }
        let result = (|| -> Result<(), String> {
            let main = app.get_webview(MAIN_LABEL).ok_or("browser_tab_context_changed")?;
            browser_media_guard(&main).map_err(|_| "browser_tab_context_changed")?;
            if !current_media_target(&target) { return Err("browser_tab_context_changed".into()); }
            let core = platform.controller().CoreWebView2().map_err(|_| "find_unavailable")?;
            if !committed_media_source(&core, &target) { return Err("browser_tab_context_changed".into()); }
            let completed_sender = Arc::clone(&sender); let completed_target = Arc::clone(&target);
            let completed_core = core.clone(); let completed_app = app.clone();
            let completed = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, raw| {
                let main_current = completed_app.get_webview(MAIN_LABEL).is_some_and(|main| browser_media_guard(&main).is_ok());
                let reply = if !main_current || !current_media_target(&completed_target) || !committed_media_source(&completed_core, &completed_target) {
                    Err("browser_tab_context_changed".into())
                } else if result.is_err() { Err("find_unavailable".into()) } else { find_result(&raw) };
                send_find_reply(&completed_sender, reply); Ok(())
            }));
            let params = serde_json::json!({"expression":expression,"returnByValue":true,"awaitPromise":true});
            core.CallDevToolsProtocolMethod(&HSTRING::from("Runtime.evaluate"), &HSTRING::from(params.to_string()), &completed)
                .map_err(|_| "find_unavailable")?;
            Ok(())
        })();
        if let Err(error) = result { send_find_reply(&sender, Err(error)); }
    }).is_err() { send_find_reply(&failed, Err("find_unavailable".into())); }
}
#[cfg(not(windows))]
fn dispatch_find(_view: &tauri::Webview, _app: AppHandle, _target: Arc<BrowserMediaTarget>, _expression: String,
    tx: tokio::sync::oneshot::Sender<Result<bool, String>>) {
    let _ = tx.send(Err("find_unavailable".into()));
}
#[tauri::command]
pub async fn browser_find(app: AppHandle, window: tauri::Webview, id: u64, query: String, backwards: bool,
    expected_url: String, expected_context_token: String) -> Result<bool, String> {
    browser_media_guard(&window)?;
    if query.encode_utf16().count() > 200 || query.chars().any(char::is_control) { return Err("invalid_find_query".into()); }
    if !(1..=PAGE_LOAD_SAFE_INTEGER).contains(&id) || popup_target(&expected_url).is_none() || !valid_print_context_token(&expected_context_token) {
        return Err("browser_tab_context_changed".into());
    }
    let (view, target) = capture_media_target(&app, id, true, Some(&expected_context_token))
        .map_err(|error| if error == "browser_print_unavailable" { "find_unavailable".to_owned() } else { "browser_tab_context_changed".to_owned() })?;
    if !find_expected_context(&target, &expected_url, &expected_context_token) { return Err("browser_tab_context_changed".into()); }
    if query.is_empty() { return Ok(false); }
    let query = serde_json::to_string(&query).map_err(|_| "invalid_find_query")?;
    let expression = format!("window.find({query}, false, {backwards}, true, false, false, false)");
    let target = Arc::new(target); let (tx, rx) = tokio::sync::oneshot::channel();
    dispatch_find(&view, app, Arc::clone(&target), expression, tx);
    let found = tokio::time::timeout(Duration::from_secs(10), rx).await.map_err(|_| "find_unavailable")?.map_err(|_| "find_unavailable")??;
    browser_media_guard(&window).map_err(|_| "browser_tab_context_changed")?;
    if !current_media_target(&target) || view.url().ok().as_ref().map(tauri::Url::as_str) != Some(target.committed_url.as_str()) {
        return Err("browser_tab_context_changed".into());
    }
    Ok(found)
}
#[tauri::command]
pub fn browser_stop(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)] { with_active_core(&app, |core| unsafe { let _ = core.Stop(); }) }
    #[cfg(not(windows))] { active_webview(&app).ok_or("browser_unavailable")?.eval("window.stop()").map_err(|_| "stop_failed".into()) }
}

#[cfg(test)]
mod browser_quality_tests {
    use super::*;
    #[test]
    fn fullscreen_requires_the_visible_active_tab_and_preserves_original_window_state() {
        let mut state = FullscreenState::default();
        assert!(!state.enter(1, false, Some(1), false));
        assert!(!state.enter(1, true, Some(2), false));
        assert!(!state.enter(1, true, None, false));
        assert!(state.enter(1, true, Some(1), false));
        assert!(!state.enter(1, true, Some(1), true));
        assert!(!state.enter(2, true, Some(2), true));
        assert_eq!(state.leave(Some(2)), None);
        assert_eq!(state.leave(Some(1)), Some(FullscreenSession { id: 1, restore_fullscreen: false }));
        assert_eq!(state.leave(None), None);
        assert!(state.enter(2, true, Some(2), true));
        assert_eq!(state.leave(Some(1)), None);
        assert_eq!(state.leave(None), Some(FullscreenSession { id: 2, restore_fullscreen: true }));
    }

    fn entry(id: u64, pinned: bool) -> Tab {
        Tab { id, label: format!("browser-tab-{id}"), url: "https://example.com/".into(), title: String::new(), loading: false, page_load: None, desired_muted: false, media: None, pinned, zoom: 1.0, can_back: false, can_forward: false, discarded: false, group: None, private: false, private_ready: false, hidden_since: None, favicon: None }
    }
    #[test]
    fn pointer_source_never_escapes_active_or_verified_private_context() {
        let mut state=TabState {tabs:vec![entry(1,false),entry(2,false)],active:1,..TabState::default()};
        assert!(link_source(&state,1).is_some());
        for id in [0,2,3,u64::MAX] { assert!(link_source(&state,id).is_none()); }
        state.tabs[0].discarded=true; assert!(link_source(&state,1).is_none());
        state.tabs[0].discarded=false; state.tabs[0].private=true; assert!(link_source(&state,1).is_none());
        state.tabs[0].private_ready=true; assert!(link_source(&state,1).unwrap().private);
        state.active=2; assert!(link_source(&state,1).is_none());
    }
    #[test]
    fn pointer_children_keep_the_parent_group_and_pin_boundary_without_mixing_privacy() {
        let mut state=TabState {tabs:vec![entry(1,true),entry(2,true),entry(3,false),entry(4,false)],active:3,..TabState::default()};
        state.tabs[0].group=Some("Research".into());
        assert!(place_link_tab(&mut state,4,1));assert_eq!(state.tabs.iter().map(|tab|tab.id).collect::<Vec<_>>(),vec![1,2,4,3]);
        assert_eq!(state.tabs[2].group.as_deref(),Some("Research"));assert_eq!(state.active,3);
        assert!(place_link_tab(&mut state,4,3));assert_eq!(state.tabs.iter().map(|tab|tab.id).collect::<Vec<_>>(),vec![1,2,3,4]);
        assert!(!place_link_tab(&mut state,4,99));state.tabs[3].private=true;assert!(!place_link_tab(&mut state,4,3));
    }
    #[test]
    fn pointer_window_requests_accept_only_credential_free_external_web_urls() {
        assert_eq!(popup_target("https://example.com/path?q=1").unwrap().as_str(),"https://example.com/path?q=1");
        for value in ["", "example.com", "javascript:alert(1)", "data:text/html,x", "file:///C:/x", "about:blank", "https://user:pass@example.com", "http://tauri.localhost/newtab.html", "tauri://localhost/newtab.html", "https://hub.jkamma.com/", "https://example.com/\npath"] { assert!(popup_target(value).is_none(),"{value}"); }
        assert!(popup_target(&format!("https://example.com/{}","x".repeat(8192))).is_none());
    }
    #[test]
    fn address_submission_stays_bound_to_its_captured_tab() {
        let mut state = TabState::default(); state.tabs = vec![entry(1, false), entry(2, false)]; state.active = 1;
        assert_eq!(address_tab_label(&state, 1).unwrap(), "browser-tab-1");
        for id in [0, 2, 3, u64::MAX] { assert!(address_tab_label(&state, id).is_err()); }
        state.active = 2;
        assert!(address_tab_label(&state, 1).is_err());
        assert_eq!(address_tab_label(&state, 2).unwrap(), "browser-tab-2");
        state.tabs.clear(); assert!(address_tab_label(&state, 2).is_err());
    }
    #[test]
    fn tab_order_stays_inside_pin_group_and_rejects_missing_bounds() {
        let mut state = TabState::default(); state.tabs = vec![entry(1, true), entry(2, false), entry(3, false)];
        assert!(move_tab(&mut state, 2, 0).is_err()); assert!(move_tab(&mut state, 2, 3).is_err()); assert!(move_tab(&mut state, 9, 1).is_err());
        move_tab(&mut state, 3, 1).unwrap(); assert_eq!(state.tabs.iter().map(|tab| tab.id).collect::<Vec<_>>(), vec![1, 3, 2]);
        assert!(valid_zoom(0.5)); assert!(valid_zoom(3.0));
        for value in [0.0, 0.49, 3.01, f64::NAN, f64::INFINITY] { assert!(!valid_zoom(value)); }
    }
    #[test]
    fn input_credentials_and_controls_never_enter_saved_navigation() {
        for raw in ["https://user:secret@example.com", "user:secret@example.com", "https://example.com\0", "https://example.com\n/a"] { assert!(parse_target(raw).is_none()); }
        assert!(parse_target(&"a".repeat(8193)).is_none());
        let old: HistoryEntry = serde_json::from_str(r#"{"url":"https://example.com/","at":1}"#).unwrap(); assert!(old.title.is_empty());
    }
    #[test]
    fn browser_accelerators_are_closed_and_shift_aware() {
        assert_eq!(accelerator_action(65, true, true, false).as_deref(), Some("tabs"));
        assert_eq!(accelerator_action(79, true, true, false).as_deref(), Some("favorites"));
        assert_eq!(accelerator_action(72, true, false, false).as_deref(), Some("history"));
        assert_eq!(accelerator_action(74, true, false, false).as_deref(), Some("downloads"));
        for (ctrl, shift, alt) in [(true, false, false), (false, true, false), (false, false, false), (true, true, true), (false, true, true)] {
            assert_eq!(accelerator_action(65, ctrl, shift, alt), None);
        }
        for key in [0, 64, 67, u32::MAX] { assert_eq!(accelerator_action(key, true, true, false), None); }
        assert_eq!(accelerator_action(66, true, true, false).as_deref(), Some("bookmarks-toggle"));
        assert_eq!(accelerator_action(84, true, true, false).as_deref(), Some("restore"));
        assert_eq!(accelerator_action(9, true, true, false).as_deref(), Some("previous"));
        assert_eq!(accelerator_action(87, true, true, false), None);
        assert_eq!(accelerator_action(49, true, false, false).as_deref(), Some("tab-1"));
        assert_eq!(accelerator_action(37, false, false, true).as_deref(), Some("back"));
        assert_eq!(accelerator_action(70, false, false, false), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_are_valid_targets() {
        assert_eq!(parse_target("example.com").unwrap().as_str(), "https://example.com/");
        assert_eq!(parse_target(" http://localhost:3020 ").unwrap().as_str(), "http://localhost:3020/");
        assert!(parse_target("javascript:alert(1)").is_none());
        assert!(parse_target("file:///C:/windows").is_none());
        assert!(parse_target("data:text/html,<b>x</b>").is_none());
        assert!(parse_target("http://").is_none());
        assert!(parse_target("https://").is_none());
        assert!(parse_target("").is_none());
    }

    #[test]
    fn browser_child_cannot_open_the_desktop_shell() {
        assert!(internal_page_allowed(
            &tauri::Url::parse("http://tauri.localhost/newtab.html").unwrap(), None
        ));
        assert!(!internal_page_allowed(
            &tauri::Url::parse("http://tauri.localhost/index.html").unwrap(), None
        ));
        assert!(!internal_page_allowed(
            &tauri::Url::parse("tauri://localhost/").unwrap(), None
        ));
        let dev_origin = Some("http://127.0.0.1:1420");
        assert!(internal_page_allowed(
            &tauri::Url::parse("http://127.0.0.1:1420/newtab.html").unwrap(), dev_origin
        ));
        assert!(!internal_page_allowed(
            &tauri::Url::parse("http://127.0.0.1:1420/index.html").unwrap(), dev_origin
        ));
        assert!(!is_internal_url(
            &tauri::Url::parse("http://127.0.0.1:3020/newtab.html").unwrap(), dev_origin
        ));
    }

    #[test]
    fn bare_host_port_and_loopback_become_navigable_urls() {
        // "host:port" は Url::parse がホスト部をスキームとして読むので、
        // 補完へ回さないと「invalid_url」で弾かれていた。
        assert_eq!(
            parse_target("localhost:3020").unwrap().as_str(),
            "http://localhost:3020/"
        );
        assert_eq!(
            parse_target("example.com:8080/path").unwrap().as_str(),
            "https://example.com:8080/path"
        );
        assert_eq!(
            parse_target("127.0.0.1:8788").unwrap().as_str(),
            "http://127.0.0.1:8788/"
        );
        assert_eq!(parse_target("localhost").unwrap().as_str(), "http://localhost/");
        // ループバックに見せかけた名前は http へ降格しない。
        assert_eq!(
            parse_target("127.0.0.1.evil.example").unwrap().as_str(),
            "https://127.0.0.1.evil.example/"
        );
        // スキームを騙る入力は補完しても http/https にならず拒否される。
        assert!(parse_target("javascript:alert(1)").is_none());
        assert!(parse_target("foo:bar").is_none());
        // "://" を書いた非Webスキームは補完せず拒否する。
        assert!(parse_target("ftp://example.com").is_none());
    }

    #[test]
    fn history_upsert_dedups_to_front_and_enforces_the_limit() {
        let mut history = vec![
            HistoryEntry { url: "https://a.example".into(), at: 1, title: String::new() },
            HistoryEntry { url: "https://b.example".into(), at: 2, title: String::new() },
        ];
        // 再訪は重複させず先頭へ移す。
        upsert_history(&mut history, "https://b.example", 3);
        assert_eq!(
            history.iter().map(|e| e.url.as_str()).collect::<Vec<_>>(),
            ["https://b.example", "https://a.example"]
        );
        assert_eq!(history[0].at, 3);
        // 上限を超えると一番古い方から捨てる。
        let mut full: Vec<HistoryEntry> = (0..HISTORY_LIMIT)
            .map(|i| HistoryEntry { url: format!("https://{i}.example"), at: i as i64, title: String::new() })
            .collect();
        upsert_history(&mut full, "https://new.example", 999);
        assert_eq!(full.len(), HISTORY_LIMIT);
        assert_eq!(full[0].url, "https://new.example");
        assert_eq!(full.last().unwrap().url, "https://198.example");
        assert!(!full.iter().any(|e| e.url == "https://199.example"));
    }

    #[test]
    fn history_entries_round_trip_through_json() {
        let entries = vec![
            HistoryEntry { url: "https://a.example".into(), at: 1, title: String::new() },
            HistoryEntry { url: "https://b.example".into(), at: 2, title: String::new() },
        ];
        let loaded: Vec<HistoryEntry> =
            serde_json::from_str(&serde_json::to_string(&entries).unwrap()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].url, "https://a.example");
        // 壊れたJSONは履歴を消さず空として扱う。
        assert!(read_list::<HistoryEntry>("missing-file-that-never-exists.json").is_empty());
    }

    fn tab(id: u64, discarded: bool, hidden_since: Option<Instant>) -> Tab {
        Tab {
            id,
            label: format!("browser-tab-{id}"),
            url: String::new(),
            discarded,
            title: String::new(), loading: false, page_load: None, desired_muted: false, media: None, pinned: false, zoom: 1.0, can_back: false, can_forward: false, group: None, private: false, private_ready: false,
            hidden_since,
            favicon: None,
        }
    }

    #[test]
    fn site_zoom_is_per_host_forgets_100_percent_and_is_bounded() {
        assert_eq!(site_zoom_key("https://JA.Wikipedia.org/wiki/x?y=1").as_deref(), Some("ja.wikipedia.org"));
        assert_eq!(site_zoom_key("tauri://localhost/newtab.html"), None);
        assert_eq!(site_zoom_key("not a url"), None);
        let mut list = Vec::new();
        remember_site_zoom(&mut list, "ja.wikipedia.org", 1.25);
        remember_site_zoom(&mut list, "tver.jp", 0.9);
        assert_eq!(site_zoom_of(&list, "ja.wikipedia.org"), 1.25);
        assert_eq!(site_zoom_of(&list, "duckduckgo.com"), 1.0);
        assert_eq!(list[0].0, "tver.jp");
        remember_site_zoom(&mut list, "ja.wikipedia.org", 1.0);
        assert_eq!(site_zoom_of(&list, "ja.wikipedia.org"), 1.0);
        assert_eq!(list.len(), 1);
        for index in 0..SITE_ZOOM_LIMIT + 5 { remember_site_zoom(&mut list, &format!("h{index}.example"), 1.1); }
        assert_eq!(list.len(), SITE_ZOOM_LIMIT);
        assert_eq!(list[0].0, format!("h{}.example", SITE_ZOOM_LIMIT + 4));
    }

    #[test]
    fn audible_hidden_tabs_are_never_slept_automatically() {
        let now = Instant::now();
        let mut playing = tab(1, false, Some(now - DISCARD_AFTER - Duration::from_secs(5)));
        playing.media = Some(BrowserMediaObservation { playing_audio: Some(true), ..BrowserMediaObservation::new() });
        assert!(!tab_is_stale(&playing, now));
        assert!(!tab_can_sleep_now(&playing, true));
        // 手動で1枚選んだときは本人の操作なので休ませられる。
        assert!(tab_can_sleep_now(&playing, false));
        playing.media.as_mut().unwrap().playing_audio = Some(false);
        assert!(tab_is_stale(&playing, now));
        assert!(tab_can_sleep_now(&playing, true));
    }

    #[test]
    fn shown_private_and_slept_tabs_cannot_be_slept_now() {
        let now = Instant::now();
        assert!(!tab_can_sleep_now(&tab(1, false, None), false));
        assert!(!tab_can_sleep_now(&tab(2, true, Some(now)), false));
        let mut private = tab(3, false, Some(now));
        private.private = true;
        assert!(!tab_can_sleep_now(&private, false));
        assert!(tab_can_sleep_now(&tab(4, false, Some(now)), true));
    }

    #[test]
    fn low_free_memory_discards_hidden_tabs_sooner() {
        let gib = 1024 * 1024 * 1024;
        assert_eq!(discard_after_for(Some(2 * gib)), LOW_MEMORY_DISCARD_AFTER);
        assert_eq!(discard_after_for(Some(LOW_MEMORY_BYTES - 1)), LOW_MEMORY_DISCARD_AFTER);
        assert_eq!(discard_after_for(Some(LOW_MEMORY_BYTES)), DISCARD_AFTER);
        assert_eq!(discard_after_for(Some(8 * gib)), DISCARD_AFTER);
        // Unknown free memory keeps the previous, longer behaviour.
        assert_eq!(discard_after_for(None), DISCARD_AFTER);
        assert!(available_memory().is_some_and(|bytes| bytes > 0));
    }

    #[test]
    fn only_long_hidden_tabs_are_stale() {
        let now = Instant::now();
        // 十分に隠れていたタブだけが破棄対象。
        assert!(tab_is_stale(&tab(1, false, Some(now - DISCARD_AFTER)), now));
        assert!(tab_is_stale(
            &tab(1, false, Some(now - DISCARD_AFTER - Duration::from_secs(1))),
            now
        ));
        // 隠れ始めて間もないタブ・表示中のタブ・廃棄済みは残る。
        assert!(!tab_is_stale(&tab(1, false, Some(now)), now));
        assert!(!tab_is_stale(&tab(1, false, None), now));
        assert!(!tab_is_stale(
            &tab(1, true, Some(now - DISCARD_AFTER - Duration::from_secs(1))),
            now
        ));
    }

    #[test]
    fn hidden_stamps_track_shown_tab_and_preserve_first_stamp() {
        let mut state = TabState::default();
        state.tabs.push(tab(1, false, None));
        state.tabs.push(tab(2, false, None));
        state.tabs.push(tab(3, true, None));
        // タブ1を表示 → タブ2だけ刻まれ、廃棄済みのタブ3は刻まれない。
        stamp_hidden_tabs(&mut state, Some(1));
        assert!(state.tabs[0].hidden_since.is_none());
        let first = state.tabs[1].hidden_since.unwrap();
        assert!(state.tabs[2].hidden_since.is_none());
        // 隠れ続けたタブは最初の時刻を保つ（起点が後ろへずれない）。
        std::thread::sleep(Duration::from_millis(5));
        stamp_hidden_tabs(&mut state, Some(1));
        assert_eq!(state.tabs[1].hidden_since, Some(first));
        // タブ2へ切替えるとタブ1が刻まれ、タブ2の時刻は消える。
        stamp_hidden_tabs(&mut state, Some(2));
        assert!(state.tabs[0].hidden_since.is_some());
        assert!(state.tabs[1].hidden_since.is_none());
    }

    #[test]
    fn failed_close_keeps_live_tab_and_hidden_stamp_for_next_reap() {
        let since = Instant::now() - DISCARD_AFTER;
        let mut state = TabState::default();
        state.tabs.push(tab(1, false, Some(since)));
        mark_tab_discarded(&mut state, 1, false);
        assert!(!state.tabs[0].discarded);
        assert_eq!(state.tabs[0].hidden_since, Some(since));
        assert!(tab_is_stale(&state.tabs[0], Instant::now()));
        mark_tab_discarded(&mut state, 1, true);
        assert!(state.tabs[0].discarded);
        assert!(state.tabs[0].hidden_since.is_none());
    }

    #[test]
    fn failed_revive_without_view_restores_retry_and_preserves_metadata() {
        let mut state = TabState::default();
        let mut retry = tab(7, false, None);
        retry.url = "https://example.com/saved".into();
        retry.title = "Saved".into(); retry.pinned = true; retry.zoom = 1.5;
        state.tabs.push(retry); state.active = 7;
        mark_tab_discarded(&mut state, 7, true);
        let kept = &state.tabs[0];
        assert!(kept.discarded); assert!(kept.hidden_since.is_none());
        assert_eq!(kept.id, 7); assert_eq!(kept.label, "browser-tab-7");
        assert_eq!(kept.url, "https://example.com/saved");
        assert_eq!(kept.title, "Saved"); assert!(kept.pinned); assert_eq!(kept.zoom, 1.5);
        assert_eq!(state.active, 7);
        // A closed/removed tab is never recreated by failure cleanup.
        state.tabs.clear(); mark_tab_discarded(&mut state, 7, true);
        assert!(state.tabs.is_empty());
    }

    #[test]
    fn failed_creation_with_existing_view_does_not_mark_live_tab_discarded() {
        let mut state = TabState::default();
        state.tabs.push(tab(1, false, None));
        mark_tab_discarded(&mut state, 1, false);
        assert!(!state.tabs[0].discarded);
        assert!(state.tabs[0].hidden_since.is_none());
    }

    #[test]
    fn devtools_target_resolves_tab_and_discard_state() {
        let mut state = TabState::default();
        state.tabs.push(tab(1, false, None));
        state.tabs.push(tab(2, true, None));
        state.active = 1;
        // 未指定はアクティブタブ。
        assert_eq!(
            devtools_tab_target(&state, None),
            Some(("browser-tab-1".to_owned(), false))
        );
        // 明示指定は廃棄状態も返す。
        assert_eq!(
            devtools_tab_target(&state, Some(2)),
            Some(("browser-tab-2".to_owned(), true))
        );
        // 存在しないタブは拒否。
        assert_eq!(devtools_tab_target(&state, Some(9)), None);
    }

    #[test]
    fn eval_value_reads_method_result_shape() {
        // CallDevToolsProtocolMethod の戻り値はメソッドの結果そのまま。
        // Runtime.evaluate なら {result: RemoteObject, exceptionDetails?}。
        let ok = r#"{"result":{"type":"string","value":"hello"}}"#;
        assert_eq!(
            eval_value(ok).unwrap(),
            serde_json::Value::String("hello".into())
        );
        // 値を返さない式は Null。
        let undef = r#"{"result":{"type":"undefined"}}"#;
        assert_eq!(eval_value(undef).unwrap(), serde_json::Value::Null);
        // ページ側の例外は exceptionDetails（result の兄弟）に来る。
        let boom = r#"{"result":{"type":"object","subtype":"error"},"exceptionDetails":{"text":"ReferenceError: x is not defined"}}"#;
        assert_eq!(
            eval_value(boom).unwrap_err(),
            "ReferenceError: x is not defined"
        );
        // 壊れたJSONはコマンドエラー。
        assert_eq!(eval_value("{").unwrap_err(), "devtools_bad_json");
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedTab { url: String, title: String, pinned: bool, zoom: f64, #[serde(default, skip_serializing_if = "Option::is_none")] group: Option<String>, #[serde(default)] muted: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedSession { version: u8, active: usize, tabs: Vec<SavedTab> }
static PREVIOUS_SESSION: std::sync::LazyLock<Mutex<Option<SavedSession>>> = std::sync::LazyLock::new(|| Mutex::new(read_session()));
static SESSION_WRITE: Mutex<()> = Mutex::new(());

fn decode_session(raw: &str) -> Option<SavedSession> {
    if raw.len() > 2_200_000 { return None; }
    let saved: SavedSession = serde_json::from_str(raw).ok()?;
    if saved.tabs.iter().filter_map(|tab| tab.group.as_deref()).collect::<std::collections::HashSet<_>>().len() > 16 { return None; }
    if saved.version != 1 || saved.tabs.is_empty() || saved.tabs.len() > 64 || saved.active >= saved.tabs.len() { return None; }
    let mut unpinned = false;
    for tab in &saved.tabs {
        if validate_group(tab.group.clone()).ok() != Some(tab.group.clone()) { return None; }
        if !valid_zoom(tab.zoom) || tab.title.chars().count() > 300 || tab.title.chars().any(char::is_control) { return None; }
        if !tab.url.is_empty() && !parse_target(&tab.url).is_some_and(|url| !is_hub_page(&url) && url.as_str() == tab.url) { return None; }
        if unpinned && tab.pinned { return None; }
        unpinned |= !tab.pinned;
    }
    Some(saved)
}
fn read_session() -> Option<SavedSession> {
    let path = local_data_dir()?.join("browser-session.json");
    if std::fs::metadata(&path).ok()?.len() > 2_200_000 { return None; }
    decode_session(&std::fs::read_to_string(path).ok()?)
}
fn save_session() { let _ = save_session_checked(); }
/// After "clear all history" the previous launch's tabs must not come back from
/// browser-session.json; the file is rewritten from the tabs open right now.
fn forget_previous_session() {
    std::sync::LazyLock::force(&PREVIOUS_SESSION);
    if let Ok(mut previous) = PREVIOUS_SESSION.lock() { *previous = None; }
    if let Some(dir) = local_data_dir() {
        let _serial = SESSION_WRITE.lock();
        let _ = std::fs::remove_file(dir.join("browser-session.json"));
    }
    save_session();
}
fn save_session_checked() -> Result<(), String> {
    // Capture the previous launch before the first new blank tab can replace its file.
    std::sync::LazyLock::force(&PREVIOUS_SESSION);
    let _serial = SESSION_WRITE.lock().map_err(|_| "session_unavailable")?;
    let saved = with_tabs(|state| snapshot_session(state));
    let saved = saved.ok_or("session_unavailable")?;
    // Keep a recoverable previous session until the user actually visits a page.
    if !saved.tabs.is_empty() && saved.tabs.iter().all(|tab| tab.url.is_empty()) && PREVIOUS_SESSION.lock().ok().is_some_and(|s| s.is_some()) { return Ok(()); }
    let dir = local_data_dir().ok_or("session_unavailable")?;
    let raw = serde_json::to_vec(&saved).map_err(|_| "session_write_failed")?;
    browser_bookmarks::write_atomic(&dir.join("browser-session.json"), &raw).map_err(|_| "session_write_failed".into())
}
pub(crate) fn save_session_on_close() -> Result<(), String> {
    std::sync::LazyLock::force(&PREVIOUS_SESSION);
    save_session_on_close_to(&TABS, &PREVIOUS_SESSION, &SESSION_WRITE, |raw| {
        let dir = local_data_dir().ok_or("session_unavailable")?;
        browser_bookmarks::write_atomic(&dir.join("browser-session.json"), raw)
            .map_err(|_| "session_write_failed".into())
    })
}
fn save_session_on_close_to(
    tabs: &Mutex<Option<TabState>>,
    previous: &Mutex<Option<SavedSession>>,
    serial: &Mutex<()>,
    write: impl FnOnce(&[u8]) -> Result<(), String>,
) -> Result<(), String> {
    let _serial = serial.lock().map_err(|_| "session_unavailable")?;
    let saved = tabs.lock().map_err(|_| "session_unavailable")?.as_ref().map(snapshot_session);
    let has_previous = previous.lock().map_err(|_| "session_unavailable")?.is_some();
    let Some(saved) = saved else { return Ok(()); };
    if !saved.tabs.is_empty() && has_previous && saved.tabs.iter().all(|tab| tab.url.is_empty()) {
        return Ok(());
    }
    // Initialized empty/private-only sessions stay empty; removed public tabs must not return.
    let raw = serde_json::to_vec(&saved).map_err(|_| "session_write_failed")?;
    write(&raw)
}
#[tauri::command]
pub fn browser_session_status() -> usize {
    PREVIOUS_SESSION.lock().ok().and_then(|s| s.as_ref().map(|s| s.tabs.len())).unwrap_or(0)
}
#[tauri::command]
pub fn browser_restore_session(app: AppHandle) -> Result<(), String> {
    // Restoration replaces only a sole empty start tab; never discard current work.
    let empty = with_tabs(|s| s.tabs.len() <= 1 && s.tabs.iter().all(|t| t.url.is_empty() && !t.pinned)).unwrap_or(true);
    if !empty { return Err("session_workspace_not_empty".into()); }
    let mut previous = PREVIOUS_SESSION.lock().map_err(|_| "session_unavailable")?;
    let saved = previous.take().ok_or("no_saved_session")?;
    drop(previous);
    let old_labels = {
        let mut guard = TABS.lock().map_err(|_| "session_unavailable")?;
        let state = guard.get_or_insert_with(TabState::default);
        let labels = state.tabs.iter().map(|t| t.label.clone()).collect::<Vec<_>>();
        state.tabs.clear();
        for tab in saved.tabs {
            state.next += 1;
            state.tabs.push(Tab { id: state.next, label: format!("browser-tab-{}", state.next), url: tab.url, title: tab.title, pinned: tab.pinned, zoom: tab.zoom,
                discarded: true, loading: false, page_load: None, desired_muted: tab.muted, media: None, can_back: false, can_forward: false, group: tab.group, private: false, private_ready: false, hidden_since: None, favicon: None });
        }
        state.active = state.tabs[saved.active].id;
        labels
    };
    for label in old_labels { if let Some(view) = app.get_webview(&label) { let _ = protection::close(&view); } }
    if BROWSER_VISIBLE.load(Ordering::SeqCst) { set_visible(&app, true); }
    notify_tabs(&app);
    Ok(())
}
#[cfg(test)]
mod session_tests {
    use super::*;
    #[test]
    fn session_bounds_and_untrusted_fields() {
        let raw = r#"{"version":1,"active":0,"tabs":[{"url":"https://example.com/","title":"Example","pinned":true,"zoom":1.5}]}"#;
        assert!(decode_session(raw).is_some());
        for bad in [raw.replace("\"version\":1", "\"version\":2"), raw.replace("\"active\":0", "\"active\":1"), raw.replace("1.5", "0.49"), raw.replace("https://example.com/", "file:///secret"), raw.replace("https://example.com/", "https://u:p@example.com/"), raw.replace("https://example.com/", "https://hub.jkamma.com/"), raw.replace("\"title\":\"Example\"", "\"title\":\"Example\",\"script\":\"x\"")] { assert!(decode_session(&bad).is_none(), "{bad}"); }
        let tab = SavedTab { url: "".into(), title: "".into(), pinned: false, zoom: 1.0, group: None, muted: false };
        let mut s = SavedSession { version: 1, active: 0, tabs: vec![tab.clone(); 64] };
        assert!(decode_session(&serde_json::to_string(&s).unwrap()).is_some());
        s.tabs.push(tab); assert!(decode_session(&serde_json::to_string(&s).unwrap()).is_none());
        s.tabs.truncate(2); s.tabs[1].pinned = true; assert!(decode_session(&serde_json::to_string(&s).unwrap()).is_none());
        assert!(decode_session(&" ".repeat(2_200_001)).is_none());
    }
}

#[derive(Clone, Serialize)]
pub struct SiteRequest { id: u64, tab: u64, origin: String, kind: i32, status: String, top_origin: String }
#[derive(Clone, Serialize)]
pub struct BrowserDownload {
    id: u64, name: String, received: i64, total: i64, status: String, path: Option<String>,
    #[serde(rename = "canResume")]
    can_resume: bool,
    #[serde(rename = "choosingDestination")]
    choosing_destination: bool,
    #[serde(rename = "interruptReason")]
    interrupt_reason: Option<i32>,
}
static SITE_REQUESTS: Mutex<Vec<SiteRequest>> = Mutex::new(Vec::new());
static DOWNLOADS: Mutex<Vec<BrowserDownload>> = Mutex::new(Vec::new());
static REQUEST_ID: AtomicU64 = AtomicU64::new(0);
static DOWNLOAD_ID: AtomicU64 = AtomicU64::new(0);

// BEGIN DOWNLOAD POLICY
#[derive(Clone, Copy, Debug, PartialEq)]
enum DownloadAction { Pause, Resume, Cancel }
fn download_terminal(status: &str) -> bool { matches!(status, "complete" | "failed" | "cancelled") }
fn download_defer_update(action: Option<DownloadAction>) -> bool { action == Some(DownloadAction::Cancel) }
fn download_cancel_status(previous: &str, succeeded: bool) -> &str {
    if succeeded && !download_terminal(previous) { "cancelled" } else { previous }
}
fn download_resume_reason(reason: Option<i32>) -> bool { matches!(reason, Some(12..=15 | 28)) }
fn download_capacity(retained: usize, rows: usize, has_terminal: bool) -> bool {
    retained < 16 && (rows < 100 || rows == 100 && has_terminal)
}
fn download_status(previous: &str, state: Option<i32>, reason: Option<i32>, pending: bool, unexpected_restart: bool) -> &'static str {
    match previous {
        "cancelled" => return "cancelled", "complete" => return "complete", "failed" => return "failed", _ => {}
    }
    if unexpected_restart { return "failed"; }
    match state {
        Some(0) => if pending { "choosing" } else { "active" },
        Some(1) if !pending && download_resume_reason(reason) => if reason == Some(28) { "paused" } else { "interrupted" },
        Some(2) if !pending => "complete",
        _ => "failed",
    }
}
fn download_restart(previous: &str, state: Option<i32>, previous_bytes: i64, bytes: Option<i64>, resuming: bool, restart_allowed: bool) -> bool {
    state == Some(0) && matches!(previous, "paused" | "interrupted") && !resuming
        || matches!(state, Some(0 | 1)) && matches!(previous, "active" | "paused" | "interrupted") && bytes.is_some_and(|bytes| previous_bytes > bytes.max(0)) && !restart_allowed
}
fn download_consume_restart(previous_bytes: i64, bytes: Option<i64>, state: i32, resuming: bool) -> bool {
    bytes.is_some_and(|bytes| bytes.max(0) != previous_bytes) || state != 0 && !resuming
}
fn download_resumable(status: &str, pending: bool, native_can_resume: bool, reason: Option<i32>) -> bool {
    matches!(status, "paused" | "interrupted") && !pending && native_can_resume && download_resume_reason(reason)
}
fn download_action_allowed(action: DownloadAction, status: &str, pending: bool, native_state: Option<i32>, can_resume: bool) -> bool {
    match action {
        DownloadAction::Pause => status == "active" && !pending && native_state == Some(0),
        DownloadAction::Resume => matches!(status, "paused" | "interrupted") && !pending && native_state == Some(1) && can_resume,
        DownloadAction::Cancel => matches!(status, "choosing" | "active" | "paused" | "interrupted") && matches!(native_state, Some(0 | 1)),
    }
}

#[derive(Serialize)]
pub struct DownloadDestinationQueued { id: u64, queued: bool }
fn download_destination_current(row: &BrowserDownload) -> bool {
    row.status == "choosing" && row.choosing_destination
}
fn reserve_download_destination(rows: &mut [BrowserDownload], id: u64) -> Result<String, &'static str> {
    if !(1..=PAGE_LOAD_SAFE_INTEGER).contains(&id) { return Err("download_not_pending"); }
    let row = rows.iter_mut().find(|row| row.id == id && row.status == "choosing").ok_or("download_not_pending")?;
    if row.choosing_destination { return Err("download_destination_busy"); }
    row.choosing_destination = true;
    Ok(row.name.clone())
}
fn release_download_destination(rows: &mut [BrowserDownload], id: u64) {
    if let Some(row) = rows.iter_mut().find(|row| row.id == id) { row.choosing_destination = false; }
}
fn finish_download_destination(row: &mut BrowserDownload, success: bool) -> bool {
    if !download_destination_current(row) { return false; }
    row.choosing_destination = false;
    row.status = if success { "active" } else { "cancelled" }.into();
    row.can_resume = false; row.interrupt_reason = None;
    if success { row.received = 0; }
    success
}
// END DOWNLOAD POLICY

// BEGIN DOWNLOAD POLICY TESTS
#[cfg(test)]
mod download_control_tests {
    use super::*;
    #[test]
    fn only_the_five_native_reasons_are_recoverable() {
        for reason in (-1..=50).chain([i32::MIN,i32::MAX]) {
            let allowed = [12,13,14,15,28].contains(&reason);
            assert_eq!(download_resume_reason(Some(reason)),allowed,"reason {reason}");
            assert_eq!(download_resumable("interrupted",false,true,Some(reason)),allowed);
            assert_eq!(download_status("active",Some(1),Some(reason),false,false),if reason == 28 { "paused" } else if allowed { "interrupted" } else { "failed" });
        }
        assert!(!download_resume_reason(None));
        for status in ["paused","interrupted"] {
            assert!(!download_resumable(status,false,false,Some(12)));
            assert!(!download_resumable(status,true,true,Some(12)));
            assert!(!download_resumable(status,false,true,None));
        }
    }
    #[test]
    fn pause_resume_cancel_require_the_exact_live_state() {
        let statuses = ["choosing","active","paused","interrupted","complete","failed","cancelled","unknown"];
        for status in statuses {
            for state in [None,Some(-1),Some(0),Some(1),Some(2),Some(i32::MAX)] {
                for pending in [false,true] {
                    assert_eq!(download_action_allowed(DownloadAction::Pause,status,pending,state,true),status == "active" && !pending && state == Some(0));
                    assert_eq!(download_action_allowed(DownloadAction::Resume,status,pending,state,true),matches!(status,"paused" | "interrupted") && !pending && state == Some(1));
                    assert!(!download_action_allowed(DownloadAction::Resume,status,pending,state,false));
                    assert_eq!(download_action_allowed(DownloadAction::Cancel,status,pending,state,false),matches!(status,"choosing" | "active" | "paused" | "interrupted") && matches!(state,Some(0 | 1)));
                }
            }
        }
    }
    #[test]
    fn terminal_rows_win_over_late_native_callbacks() {
        for terminal in ["complete","failed","cancelled"] {
            for state in [None,Some(0),Some(1),Some(2),Some(3)] {
                assert_eq!(download_status(terminal,state,Some(28),false,true),terminal);
                assert!(!download_resumable(terminal,false,true,Some(28)));
            }
        }
        assert_eq!(download_status("choosing",Some(0),None,true,false),"choosing");
        for state in [None,Some(1),Some(2),Some(3)] { assert_eq!(download_status("choosing",state,Some(12),true,false),"failed"); }
        assert_eq!(download_status("active",None,None,false,false),"failed");
        assert_eq!(download_status("active",Some(0),None,false,false),"active");
        assert_eq!(download_status("active",Some(2),None,false,false),"complete");
        assert_eq!(download_status("active",Some(0),None,false,true),"failed");
    }
    #[test]
    fn failed_cancel_preserves_the_operation_until_actual_state_is_refreshed() {
        for previous in ["choosing","active","paused","interrupted"] {
            assert!(download_defer_update(Some(DownloadAction::Cancel)));
            let failed = download_cancel_status(previous,false);
            assert_eq!(failed,previous);
            assert!(!download_terminal(failed));
            assert!(!download_defer_update(None));
            let native = if matches!(previous,"paused" | "interrupted") { 1 } else { 0 };
            let reason = if previous == "paused" { Some(28) } else { Some(12) };
            assert_eq!(download_status(failed,Some(native),reason,previous == "choosing",false),previous);
            let cancelled = download_cancel_status(previous,true);
            assert_eq!(cancelled,"cancelled");
            assert_eq!(download_status(cancelled,Some(0),None,false,false),"cancelled");
            assert!(!download_action_allowed(DownloadAction::Resume,cancelled,false,Some(1),true));
        }
        for terminal in ["complete","failed","cancelled"] { assert_eq!(download_cancel_status(terminal,true),terminal); }
        assert!(!download_defer_update(Some(DownloadAction::Resume)));
    }
    #[test]
    fn capacity_never_evicts_a_retained_download() {
        for retained in 0..=17 {
            for rows in [0,99,100,101,usize::MAX] {
                for terminal in [false,true] {
                    assert_eq!(download_capacity(retained,rows,terminal),retained < 16 && (rows < 100 || rows == 100 && terminal));
                }
            }
        }
        assert!(download_capacity(15,100,true));
        assert!(!download_capacity(16,100,true));
        assert!(!download_capacity(15,100,false));
        for status in ["choosing","active","paused","interrupted"] { assert!(!download_terminal(status)); }
    }
    #[test]
    fn explicit_resume_accepts_state_before_bytes_and_bytes_before_state_once() {
        // StateChanged reports IN_PROGRESS with the old bytes; the first byte event can reset.
        assert!(!download_restart("paused",Some(0),100,Some(100),true,true));
        assert!(!download_consume_restart(100,Some(100),0,true));
        assert!(!download_restart("active",Some(0),100,Some(0),false,true));
        assert!(download_consume_restart(100,Some(0),0,false));
        assert!(download_restart("active",Some(0),100,Some(0),false,false));
        // BytesReceivedChanged resets while State still says INTERRUPTED; next state uses those bytes.
        assert!(!download_restart("paused",Some(1),100,Some(0),true,true));
        assert!(download_consume_restart(100,Some(0),1,true));
        assert!(!download_restart("paused",Some(0),0,Some(0),true,false));
        // A partial continuation's first progress consumes the allowance too.
        assert!(!download_restart("active",Some(0),100,Some(101),false,true));
        assert!(download_consume_restart(100,Some(101),0,false));
        assert!(download_restart("active",Some(0),101,Some(0),false,false));
        assert!(download_restart("interrupted",Some(0),100,Some(100),false,false));
        assert!(download_restart("paused",Some(0),100,Some(0),true,false));
        assert!(download_restart("paused",Some(1),100,Some(0),true,false));
        assert!(download_consume_restart(100,Some(100),1,false));
        assert!(download_restart("active",Some(0),i64::MAX,Some(i64::MIN),false,false));
        assert!(!download_restart("active",Some(0),0,Some(i64::MIN),false,false));
        assert!(!download_restart("active",Some(0),100,None,false,false));
    }
    #[test]
    fn delayed_reset_survives_repeated_unchanged_native_callbacks() {
        let mut allowance = true;
        // Arbitrary network delay supplies no progress; neither callback consumes permission.
        for _ in 0..1000 {
            for _event in ["StateChanged","BytesReceivedChanged"] {
                assert!(!download_restart("active",Some(0),100,Some(100),false,allowance));
                if download_consume_restart(100,Some(100),0,false) { allowance = false; }
            }
        }
        assert!(allowance);
        assert!(!download_restart("active",Some(0),100,Some(0),false,allowance));
        if download_consume_restart(100,Some(0),0,false) { allowance = false; }
        assert!(!allowance);
        assert!(download_restart("active",Some(0),100,Some(0),false,allowance));
        assert!(!download_consume_restart(100,None,0,false));
        assert!(download_consume_restart(100,Some(101),0,false));
        assert!(download_consume_restart(100,Some(100),1,false));
    }
}
// END DOWNLOAD POLICY TESTS

#[cfg(test)]
mod download_destination_tests {
    use super::*;
    fn row(id: u64) -> BrowserDownload {
        BrowserDownload { id, name: "fixture.zip".into(), received: 0, total: 0,
            status: "choosing".into(), path: None, can_resume: false, choosing_destination: false, interrupt_reason: None }
    }
    #[test]
    fn same_id_is_reserved_once_and_other_downloads_are_independent() {
        let mut rows = vec![row(1), row(2)];
        assert_eq!(reserve_download_destination(&mut rows, 1), Ok("fixture.zip".into()));
        assert_eq!(reserve_download_destination(&mut rows, 1), Err("download_destination_busy"));
        assert_eq!(reserve_download_destination(&mut rows, 2), Ok("fixture.zip".into()));
        assert!(rows.iter().all(download_destination_current));
    }
    #[test]
    fn only_an_unreserved_choosing_row_can_start_a_destination() {
        for status in ["active", "paused", "interrupted", "complete", "failed", "cancelled", "unknown"] {
            let mut rows = vec![row(1)]; rows[0].status = status.into();
            assert_eq!(reserve_download_destination(&mut rows, 1), Err("download_not_pending"));
            assert!(!rows[0].choosing_destination);
        }
        assert_eq!(reserve_download_destination(&mut [row(1)], 0), Err("download_not_pending"));
        assert_eq!(reserve_download_destination(&mut [row(PAGE_LOAD_SAFE_INTEGER + 1)], PAGE_LOAD_SAFE_INTEGER + 1), Err("download_not_pending"));
        assert!(reserve_download_destination(&mut [row(PAGE_LOAD_SAFE_INTEGER)], PAGE_LOAD_SAFE_INTEGER).is_ok());
    }
    #[test]
    fn scheduling_failure_releases_only_its_reservation_and_allows_explicit_retry() {
        let mut rows = vec![row(1), row(2)];
        reserve_download_destination(&mut rows, 1).unwrap(); reserve_download_destination(&mut rows, 2).unwrap();
        release_download_destination(&mut rows, 1);
        assert!(!rows[0].choosing_destination); assert_eq!(rows[0].status, "choosing");
        assert!(rows[1].choosing_destination); reserve_download_destination(&mut rows, 1).unwrap();
    }
    #[test]
    fn completion_and_dialog_cancel_release_and_late_cancelled_callback_is_inert() {
        for success in [true, false] {
            let mut rows = vec![row(1)]; reserve_download_destination(&mut rows, 1).unwrap();
            assert_eq!(finish_download_destination(&mut rows[0], success), success);
            assert!(!rows[0].choosing_destination);
            assert_eq!(rows[0].status, if success { "active" } else { "cancelled" });
            assert!(!finish_download_destination(&mut rows[0], true));
        }
        let mut rows = vec![row(1)]; reserve_download_destination(&mut rows, 1).unwrap();
        rows[0].status = download_cancel_status(&rows[0].status, true).into();
        release_download_destination(&mut rows, 1);
        assert!(!download_destination_current(&rows[0]));
        assert!(!finish_download_destination(&mut rows[0], true)); assert_eq!(rows[0].status, "cancelled");
    }
    #[test]
    fn early_ack_means_queued_and_fresh_metadata_still_reports_destination_busy() {
        let mut rows = vec![row(1)]; reserve_download_destination(&mut rows, 1).unwrap();
        assert_eq!(serde_json::to_value(DownloadDestinationQueued { id: 1, queued: true }).unwrap(), serde_json::json!({"id":1,"queued":true}));
        let value = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(value["status"], "choosing"); assert_eq!(value["choosingDestination"], true);
        assert!(value.get("choosing_destination").is_none());
        assert_eq!(reserve_download_destination(&mut rows, 1), Err("download_destination_busy"));
    }
}


#[tauri::command]
pub fn browser_site_requests() -> Vec<SiteRequest> { SITE_REQUESTS.lock().map(|s| s.clone()).unwrap_or_default() }
#[tauri::command]
pub async fn browser_downloads(app: AppHandle) -> Result<Vec<BrowserDownload>, String> {
    #[cfg(windows)] {
        let (send, receive) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = send.send(browser_access::refresh_downloads(&handle).and_then(|()| DOWNLOADS.lock().map(|rows| rows.clone()).map_err(|_| "download_unavailable".into())));
        }).map_err(|_| "download_unavailable")?;
        tokio::time::timeout(Duration::from_secs(2), receive).await
            .map_err(|_| "download_unavailable".to_string())?
            .map_err(|_| "download_unavailable".to_string())?
    }
    #[cfg(not(windows))] { let _ = app; Ok(DOWNLOADS.lock().map(|rows| rows.clone()).unwrap_or_default()) }
}
fn access_changed(app: &AppHandle) { let _ = app.emit_to(MAIN_LABEL, "browser-access-changed", ()); }

#[cfg(windows)]
mod browser_access {
    use super::*;
    use std::{cell::RefCell, collections::{HashMap,HashSet}};
    use windows_core::{Interface, PWSTR, HSTRING};
    use webview2_com::{PermissionRequestedEventHandler, DownloadStartingEventHandler, BytesReceivedChangedEventHandler, StateChangedEventHandler, take_pwstr, Microsoft::Web::WebView2::Win32::*};
    use tauri_plugin_dialog::DialogExt;

    // COM objects never leave the UI thread. Worker/dialog callbacks carry numeric IDs only.
    thread_local! {
        static PERMISSIONS: RefCell<HashMap<u64, (ICoreWebView2PermissionRequestedEventArgs, ICoreWebView2Deferral)>> = RefCell::new(HashMap::new());
        static SAVES: RefCell<HashMap<u64, (ICoreWebView2DownloadStartingEventArgs, ICoreWebView2Deferral)>> = RefCell::new(HashMap::new());
        static OPERATIONS: RefCell<HashMap<u64, ICoreWebView2DownloadOperation>> = RefCell::new(HashMap::new());
        static ACTIONS: RefCell<HashMap<u64, DownloadAction>> = RefCell::new(HashMap::new());
        static RESTART_ALLOWED: RefCell<HashSet<u64>> = RefCell::new(HashSet::new());
    }
    pub(super) fn download_history_allowed() -> Result<bool, String> {
        let rows = DOWNLOADS.lock().map_err(|_| "download_history_unavailable")?;
        let retained = OPERATIONS.with(|items| items.try_borrow().map(|items| !items.is_empty()).map_err(|_| "download_history_unavailable"))?;
        Ok(super::download_history::managed_open_allowed(rows.iter().map(|row| row.status.as_str()), retained))
    }
    fn clear_action(id: u64) {
        ACTIONS.with(|items| items.borrow_mut().remove(&id));
        RESTART_ALLOWED.with(|items| items.borrow_mut().remove(&id));
    }
    pub fn finish_permission(app: &AppHandle, id: u64, allow: bool, remember: bool) {
        let request = SITE_REQUESTS.lock().ok().and_then(|s| s.iter().find(|s| s.id == id).cloned());
        let valid = BROWSER_VISIBLE.load(Ordering::SeqCst) && request.as_ref().is_some_and(|r| with_tabs(|s| s.active == r.tab && s.tabs.iter().any(|t| t.id == r.tab && parse_target(&t.url).is_some_and(|url| url.origin().ascii_serialization() == r.top_origin))).unwrap_or(false));
        let allow = allow && valid;
        // Remember only a valid, answered request from a normal tab whose requester is the top-level origin.
        if remember && valid {
            if let Some(r) = request.as_ref().filter(|r| r.origin == r.top_origin) {
                let private = with_tabs(|s| s.tabs.iter().find(|t| t.id == r.tab).is_none_or(|t| t.private)).unwrap_or(true);
                if !private { let _ = crate::browser_site_permissions::remember(&r.top_origin, r.kind, allow); }
            }
        }
        let done = PERMISSIONS.with(|p| p.borrow_mut().remove(&id));
        if let Some((args, deferral)) = done {
            unsafe { let _ = args.SetState(if allow { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY }); let _ = deferral.Complete(); }
            if let Ok(mut s) = SITE_REQUESTS.lock() { if let Some(r) = s.iter_mut().find(|r| r.id == id) { r.status = if allow { "allowed" } else { "denied" }.into(); } }
            access_changed(app);
        }
    }
    pub fn release_destination(app: &AppHandle, id: u64) {
        if let Ok(mut rows) = DOWNLOADS.lock() { release_download_destination(&mut rows, id); }
        access_changed(app);
    }
    fn finish_save(app: &AppHandle, id: u64, path: Option<std::path::PathBuf>) {
        // Cancel/terminal paths own their deferral. A late dialog callback cannot consume it.
        if !DOWNLOADS.lock().ok().is_some_and(|rows| rows.iter().any(|row| row.id == id && download_destination_current(row))) { return; }
        let pending = SAVES.with(|s| s.borrow_mut().remove(&id));
        let Some((args, deferral)) = pending else { release_destination(app, id); return };
        unsafe {
            let choosing = DOWNLOADS.lock().ok().is_some_and(|rows| rows.iter().any(|row| row.id == id && download_destination_current(row)));
            let success = choosing && path.filter(|p| p.is_absolute()).is_some_and(|path| args.SetResultFilePath(&HSTRING::from(path.as_os_str())).is_ok());
            let accepted = DOWNLOADS.lock().ok().is_some_and(|mut rows| {
                rows.iter_mut().find(|row| row.id == id).is_some_and(|row| finish_download_destination(row, success))
            });
            if !accepted { clear_action(id); OPERATIONS.with(|items| items.borrow_mut().remove(&id)); }
            // Completing a deferral can deliver progress/state callbacks; publish the choice first.
            let _ = args.SetCancel(!accepted); let _ = deferral.Complete();
        }
        access_changed(app);
    }
    fn download_changed(app: &AppHandle, id: u64, operation: &ICoreWebView2DownloadOperation, notify: bool) -> windows_core::Result<()> {
        if ACTIONS.with(|items| download_defer_update(items.borrow().get(&id).copied())) { return Ok(()); }
        let previous = DOWNLOADS.lock().ok().and_then(|rows| rows.iter().find(|row| row.id == id).cloned());
        let Some(previous) = previous.filter(|row| !download_terminal(&row.status)) else { return Ok(()) };
        unsafe {
            let mut received = 0; let mut total = 0; let mut state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
            if let Err(error) = operation.State(&mut state) {
                clear_action(id);
                if let Ok(mut rows) = DOWNLOADS.lock() { if let Some(row) = rows.iter_mut().find(|row| row.id == id) { row.can_resume = false; row.interrupt_reason = None; } }
                if notify { access_changed(app); }
                return Err(error);
            }
            let received_known = operation.BytesReceived(&mut received).is_ok(); let _ = operation.TotalBytesToReceive(&mut total);
            let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE;
            let reason = (state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED && operation.InterruptReason(&mut reason).is_ok()).then_some(reason.0);
            let mut native_can_resume = windows_core::BOOL(0);
            let native_can_resume = operation.CanResume(&mut native_can_resume).is_ok() && native_can_resume.as_bool();
            let pending = SAVES.with(|s| s.borrow().contains_key(&id));
            if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED && (previous.status == "active" || previous.interrupt_reason != reason) { clear_action(id); }
            let resuming = ACTIONS.with(|items| items.borrow().get(&id) == Some(&DownloadAction::Resume));
            let restart_allowed = RESTART_ALLOWED.with(|items| items.borrow().contains(&id));
            let unexpected_restart = download_restart(&previous.status,Some(state.0),previous.received,received_known.then_some(received),resuming,restart_allowed);
            let status = download_status(&previous.status,Some(state.0),reason,pending,unexpected_restart);
            // Only an explicit resume may reset bytes once. Unchanged byte counts preserve
            // permission until real progress/reset; a new interruption removes it.
            if download_consume_restart(previous.received,received_known.then_some(received),state.0,resuming) {
                RESTART_ALLOWED.with(|items| items.borrow_mut().remove(&id));
            }
            ACTIONS.with(|items| {
                let finished = matches!((items.borrow().get(&id),status),(Some(DownloadAction::Pause),"paused") | (Some(DownloadAction::Resume),"active"));
                if finished { items.borrow_mut().remove(&id); }
            });
            let can_resume = download_resumable(status,pending,native_can_resume,reason) && !ACTIONS.with(|items| items.borrow().contains_key(&id));
            let path = if status == "complete" {
                let mut raw = PWSTR::null();
                operation.ResultFilePath(&mut raw).ok().map(|_| take_pwstr(raw))
            } else { None };
            if let Ok(mut rows) = DOWNLOADS.lock() { if let Some(row) = rows.iter_mut().find(|r| r.id == id) {
                if !download_terminal(&row.status) {
                    if received_known { row.received = received.max(0); } row.total = total.max(0);
                    row.status = status.into(); row.can_resume = can_resume; row.interrupt_reason = reason;
                    if status != "choosing" { row.choosing_destination = false; }
                    if status == "complete" { row.path = path; }
                }
            } }
            if download_terminal(status) {
                clear_action(id);
                OPERATIONS.with(|items| items.borrow_mut().remove(&id));
                let pending_save = SAVES.with(|items| items.borrow_mut().remove(&id));
                if let Some((args, deferral)) = pending_save { let _ = args.SetCancel(true); let _ = deferral.Complete(); }
                if status != "complete" { let _ = operation.Cancel(); }
            }
            if notify { access_changed(app); } Ok(())
        }
    }
    pub fn refresh_downloads(app: &AppHandle) -> Result<(), String> {
        // Query native state on the UI thread as well as handling events. Never infer failure from elapsed time.
        let operations = OPERATIONS.with(|items| items.borrow().iter().map(|(id, operation)| (*id, operation.clone())).collect::<Vec<_>>());
        for (id, operation) in operations { download_changed(app, id, &operation, false).map_err(|_| "download_unavailable")?; }
        Ok(())
    }
    pub fn save_download(app: &AppHandle, id: u64, name: String, location: String) {
        if !DOWNLOADS.lock().ok().is_some_and(|rows| rows.iter().any(|row| row.id == id && download_destination_current(row))) { return; }
        if !SAVES.with(|s| s.borrow().contains_key(&id)) { release_destination(app, id); return; }
        if location == "downloads" {
            let path = app.path().download_dir().ok().and_then(|dir| {
                if !dir.is_dir() { return None; }
                let raw = dir.join(safe_download_name(&name));
                if !raw.exists() { return Some(raw); }
                let stem = raw.file_stem()?.to_string_lossy();
                let suffix = raw.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
                Some(dir.join(format!("{stem} (Hub {}){suffix}", uuid::Uuid::new_v4())))
            });
            finish_save(app, id, path);
        } else {
            let callback_app = app.clone();
            app.dialog().file().set_title("ダウンロードの保存先").set_file_name(name).save_file(move |path| {
                let path = path.and_then(|p| p.into_path().ok()); let inner = callback_app.clone();
                if callback_app.run_on_main_thread(move || finish_save(&inner, id, path)).is_err() { release_destination(&callback_app, id); }
            });
        }
    }
    pub fn control_download(app: &AppHandle, id: u64, action: DownloadAction) -> Result<(), String> {
        let operation = OPERATIONS.with(|items| items.borrow().get(&id).cloned()).ok_or("download_not_active")?;
        download_changed(app,id,&operation,false).map_err(|_| "download_unavailable")?;
        let row = DOWNLOADS.lock().map_err(|_| "download_unavailable")?.iter().find(|row| row.id == id).cloned().ok_or("download_not_active")?;
        let pending = SAVES.with(|items| items.borrow().contains_key(&id));
        let mut state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
        unsafe { operation.State(&mut state).map_err(|_| "download_unavailable")?; }
        let can_resume = if action == DownloadAction::Resume {
            let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE;
            let mut can_resume = windows_core::BOOL(0);
            unsafe { operation.InterruptReason(&mut reason).is_ok() && operation.CanResume(&mut can_resume).is_ok() && download_resumable(&row.status,pending,can_resume.as_bool(),Some(reason.0)) }
        } else { false };
        let error = if action == DownloadAction::Resume { "download_not_resumable" } else { "download_not_active" };
        if !download_action_allowed(action,&row.status,pending,Some(state.0),can_resume) || action != DownloadAction::Cancel && ACTIONS.with(|items| items.borrow().contains_key(&id)) { return Err(error.into()); }
        // Defer reentrant cancellation callbacks until its actual HRESULT is known.
        // Failure retains the operation and pending destination, then refreshes native state.
        if action == DownloadAction::Cancel { clear_action(id); }
        if action == DownloadAction::Pause { RESTART_ALLOWED.with(|items| items.borrow_mut().remove(&id)); }
        ACTIONS.with(|items| items.borrow_mut().insert(id,action));
        if action == DownloadAction::Resume { RESTART_ALLOWED.with(|items| items.borrow_mut().insert(id)); }
        let result = unsafe { match action { DownloadAction::Pause => operation.Pause(), DownloadAction::Resume => operation.Resume(), DownloadAction::Cancel => operation.Cancel() } };
        let mut cancelled_save = Ok(());
        if action == DownloadAction::Cancel && result.is_ok() {
            if let Ok(mut rows) = DOWNLOADS.lock() { if let Some(row) = rows.iter_mut().find(|row| row.id == id) { row.status = download_cancel_status(&row.status,true).into(); row.choosing_destination = false; row.can_resume = false; row.interrupt_reason = None; } }
            clear_action(id);
            OPERATIONS.with(|items| items.borrow_mut().remove(&id));
            if let Some((args,deferral)) = SAVES.with(|items| items.borrow_mut().remove(&id)) {
                unsafe {
                    let cancel = args.SetCancel(true);
                    let complete = deferral.Complete();
                    cancelled_save = cancel.and(complete);
                }
            }
        }
        if result.is_err() { clear_action(id); }
        let refreshed = download_changed(app,id,&operation,false);
        access_changed(app);
        result.map_err(|_| "download_operation_failed".to_owned())?;
        cancelled_save.map_err(|_| "download_operation_failed".to_owned())?;
        refreshed.map_err(|_| "download_outcome_unknown".to_owned())
    }
    pub fn hook(app: &AppHandle, view: &tauri::Webview, tab: u64) {
        let app = app.clone();
        let _ = view.with_webview(move |platform| unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else { return };
            let popup_handle = app.clone();
            let popup = webview2_com::NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                args.SetHandled(true)?;
                let mut user = windows_core::BOOL(0); args.IsUserInitiated(&mut user)?;
                // 右列のポップアップはスマホのブラウザと同じく右列の中で開く（新しい中央タブにはしない）。
                if rail::is_rail_id(tab) {
                    if user.as_bool() { let mut uri = PWSTR::null(); args.Uri(&mut uri)?; rail::popup(&popup_handle, &take_pwstr(uri)); }
                    return Ok(());
                }
                if !user.as_bool() || !native_tabs_interactive() { return Ok(()) }
                let Some(private) = with_tabs(|state| link_source(state, tab).map(|tab| tab.private)).flatten() else { return Ok(()) };
                let mut uri = PWSTR::null(); args.Uri(&mut uri)?; let uri = take_pwstr(uri);
                // Native window requests are untrusted destinations, never app IPC.
                if popup_target(&uri).is_none() { return Ok(()) }
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState;
                // 中ボタンは押した直後に離されていることがあるため、取れたときだけ背面扱いにする。
                let foreground = link_opens_in_foreground(GetKeyState(0x10) < 0, GetKeyState(0x11) < 0, GetKeyState(0x04) < 0);
                if let Err(code) = queue_tab_open(popup_handle.clone(), Some(uri), private, foreground, Some(tab), None) {
                    let _ = popup_handle.emit_to(MAIN_LABEL, "browser-operation-error", code);
                }
                Ok(())
            }));
            let _ = core.add_NewWindowRequested(&popup, &mut 0);
            let handle = app.clone();
            let callback = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                // No profile persistence: permission applies only to this request.
                let Ok(a3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() else { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?; return Ok(()) };
                a3.SetSavesInProfile(false)?;
                let mut uri = PWSTR::null(); args.Uri(&mut uri)?; let uri = take_pwstr(uri);
                let origin = parse_target(&uri).filter(|url| !is_hub_page(url)).map(|url| url.origin().ascii_serialization());
                let top = with_tabs(|s| s.tabs.iter().find(|t| t.id == tab).and_then(|t| parse_target(&t.url)).map(|url| url.origin().ascii_serialization())).flatten();
                let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION; args.PermissionKind(&mut kind)?;
                let visible = BROWSER_VISIBLE.load(Ordering::SeqCst) && with_tabs(|s| s.active == tab).unwrap_or(false);
                let capacity = PERMISSIONS.with(|p| p.borrow().len() < 16);
                if !visible || !capacity || origin.is_none() || top.is_none() || !(1..=12).contains(&kind.0) { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?; return Ok(()); }
                // Stored decisions apply to normal tabs only; a stored allow needs the requester to be the top-level origin.
                let private = with_tabs(|s| s.tabs.iter().find(|t| t.id == tab).is_none_or(|t| t.private)).unwrap_or(true);
                if !private {
                    if let (Some(origin), Some(top)) = (origin.as_deref(), top.as_deref()) {
                        match crate::browser_site_permissions::lookup(top, kind.0).as_deref() {
                            Some("deny") => { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?; return Ok(()); }
                            Some("allow") if origin == top => { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?; return Ok(()); }
                            _ => {}
                        }
                    }
                }
                let id = REQUEST_ID.fetch_add(1, Ordering::SeqCst) + 1;
                let deferral = args.GetDeferral()?;
                PERMISSIONS.with(|p| p.borrow_mut().insert(id, (args.clone(), deferral)));
                if let Ok(mut rows) = SITE_REQUESTS.lock() {
                    if rows.len() >= 100 { if let Some(i) = rows.iter().position(|r| r.status != "pending") { rows.remove(i); } }
                    rows.push(SiteRequest { id, tab, origin: origin.unwrap(), top_origin: top.unwrap(), kind: kind.0, status: "pending".into() });
                }
                access_changed(&handle);
                let timeout = handle.clone(); std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(60)); let inner = timeout.clone(); let _ = timeout.run_on_main_thread(move || finish_permission(&inner, id, false, false)); });
                Ok(())
            }));
            let _ = core.add_PermissionRequested(&callback, &mut 0);
            let Ok(core4) = core.cast::<ICoreWebView2_4>() else { return };
            let handle = app.clone();
            let callback = DownloadStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                // Close the standard dialog on any profile before managed download state is touched.
                if super::download_history::close_owned_history().is_err() {
                    args.SetHandled(true)?; args.SetCancel(true)?; return Ok(());
                }
                let retained = OPERATIONS.with(|items| items.borrow().len());
                let capacity = DOWNLOADS.lock().ok().is_some_and(|rows| download_capacity(retained,rows.len(),rows.iter().any(|row| download_terminal(&row.status))));
                let operation = args.DownloadOperation()?;
                // WebView2 may raise DownloadStarting again for the same operation after a destination change.
                // A second deferral would leave the already accepted operation waiting indefinitely.
                if OPERATIONS.with(|items| items.borrow().values().any(|existing| existing == &operation)) {
                    args.SetHandled(true)?;
                    return Ok(());
                }
                if !capacity || !BROWSER_VISIBLE.load(Ordering::SeqCst) { args.SetCancel(true)?; return Ok(()); }
                let id = DOWNLOAD_ID.fetch_add(1, Ordering::SeqCst) + 1;
                let mut raw = PWSTR::null(); args.ResultFilePath(&mut raw)?; let path = take_pwstr(raw);
                let name = std::path::Path::new(&path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
                args.SetHandled(true)?;
                let deferral = args.GetDeferral()?;
                let added = DOWNLOADS.lock().ok().is_some_and(|mut rows| {
                    if rows.len() >= 100 {
                        let Some(i) = rows.iter().position(|row| download_terminal(&row.status)) else { return false };
                        rows.remove(i);
                    }
                    rows.push(BrowserDownload { id, name: name.clone(), received: 0, total: 0, status: "choosing".into(), path: None, can_resume: false, choosing_destination: false, interrupt_reason: None });
                    true
                });
                if !added { args.SetCancel(true)?; deferral.Complete()?; return Ok(()); }
                SAVES.with(|s| s.borrow_mut().insert(id, (args.clone(), deferral)));
                OPERATIONS.with(|o| o.borrow_mut().insert(id, operation.clone()));
                for state_event in [false, true] {
                    let event_app = handle.clone();
                    if state_event {
                        operation.add_StateChanged(&StateChangedEventHandler::create(Box::new(move |op, _| { if let Some(op) = op { download_changed(&event_app, id, &op, true)?; } Ok(()) })), &mut 0)?;
                    } else {
                        operation.add_BytesReceivedChanged(&BytesReceivedChangedEventHandler::create(Box::new(move |op, _| { if let Some(op) = op { download_changed(&event_app, id, &op, true)?; } Ok(()) })), &mut 0)?;
                    }
                }
                access_changed(&handle);
                Ok(())
            }));
            let _ = core4.add_DownloadStarting(&callback, &mut 0);
        });
    }
}

#[tauri::command]
pub fn browser_permission_reply(app: AppHandle, id: u64, allow: bool, remember: Option<bool>) -> Result<(), String> {
    let remember = remember.unwrap_or(false);
    if !SITE_REQUESTS.lock().map_err(|_| "permission_unavailable")?.iter().any(|r| r.id == id && r.status == "pending") { return Err("permission_expired".into()); }
    #[cfg(windows)] { let inner = app.clone(); app.run_on_main_thread(move || browser_access::finish_permission(&inner, id, allow, remember)).map_err(|_| "permission_unavailable")?; }
    #[cfg(not(windows))] { let _ = remember; }
    Ok(())
}
#[tauri::command]
pub fn browser_site_permissions() -> Vec<crate::browser_site_permissions::Entry> { crate::browser_site_permissions::list() }
#[tauri::command]
pub fn browser_forget_site_permission(webview: tauri::Webview, origin: String, kind: Option<i32>) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    crate::browser_site_permissions::forget(&origin, kind)
}
#[tauri::command]
pub fn browser_save_download(app: AppHandle, window: tauri::Webview, id: u64, location: String) -> Result<DownloadDestinationQueued, String> {
    if !crate::local_pairing_address(window.label(), &window.url().map_err(|_| "native_window_required")?) { return Err("native_window_required".into()); }
    if !matches!(location.as_str(), "downloads" | "choose") { return Err("invalid_download_location".into()); }
    #[cfg(windows)] {
        let name = reserve_download_destination(&mut DOWNLOADS.lock().map_err(|_| "download_unavailable")?, id).map_err(str::to_owned)?;
        access_changed(&app);
        let handle = app.clone();
        if app.run_on_main_thread(move || {
            let valid = window.url().ok().is_some_and(|url| crate::local_pairing_address(window.label(), &url));
            if valid { browser_access::save_download(&handle, id, name, location); }
            else { browser_access::release_destination(&handle, id); }
        }).is_err() {
            browser_access::release_destination(&app, id);
            return Err("download_unavailable".into());
        }
        // The chooser/download has only been dispatched; no file-save success is inferred.
        Ok(DownloadDestinationQueued { id, queued: true })
    }
    #[cfg(not(windows))] { let _ = (app, window, id, location); Err("download_unavailable".into()) }
}
#[tauri::command]
pub async fn browser_cancel_download(app: AppHandle, window: tauri::Webview, id: u64) -> Result<(), String> {
    control_download(app,window,id,DownloadAction::Cancel).await
}
#[tauri::command]
pub async fn browser_pause_download(app: AppHandle, window: tauri::Webview, id: u64) -> Result<(), String> {
    control_download(app,window,id,DownloadAction::Pause).await
}
#[tauri::command]
pub async fn browser_resume_download(app: AppHandle, window: tauri::Webview, id: u64) -> Result<(), String> {
    control_download(app,window,id,DownloadAction::Resume).await
}
async fn control_download(app: AppHandle, window: tauri::Webview, id: u64, action: DownloadAction) -> Result<(), String> {
    if !crate::local_pairing_address(window.label(), &window.url().map_err(|_| "native_window_required")?) { return Err("native_window_required".into()); }
    #[cfg(windows)] {
        let (send,receive) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = window.url().map_err(|_| "native_window_required".to_owned()).and_then(|url| {
                if !crate::local_pairing_address(window.label(), &url) { return Err("native_window_required".into()); }
                browser_access::control_download(&handle,id,action)
            });
            let _ = send.send(result);
        }).map_err(|_| "download_unavailable")?;
        tokio::time::timeout(Duration::from_secs(2),receive).await.map_err(|_| "download_outcome_unknown".to_owned())?.map_err(|_| "download_outcome_unknown".to_owned())?
    }
    #[cfg(not(windows))] { let _ = (app,window,id,action); Err("download_unavailable".into()) }
}
#[tauri::command]
pub fn browser_reveal_download(id: u64) -> Result<(), String> {
    let path = DOWNLOADS.lock().map_err(|_| "download_unavailable")?.iter().find(|r| r.id == id && r.status == "complete").and_then(|r| r.path.clone()).ok_or("download_not_complete")?;
    if !std::path::Path::new(&path).is_file() { return Err("download_file_missing".into()); }
    #[cfg(windows)] { std::process::Command::new("explorer.exe").arg(format!("/select,{path}")).spawn().map_err(|_| "download_reveal_failed")?; }
    Ok(())
}

/// Files whose "open" would run code or change the system are never opened from the browser.
fn download_open_blocked(path: &str) -> bool {
    const BLOCKED: [&str; 50] = ["exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "jse", "wsf", "hta", "lnk", "reg", "cpl", "msc", "jar", "appx", "msix", "dll", "sys", "pif", "application", "gadget",
        "vbe", "wsh", "wsc", "ws", "scf", "url", "inf", "ins", "isp", "msp", "mst", "msh", "msh1", "msh2", "mshxml", "ps1xml", "ps2", "psc1", "psc2", "psm1", "appxbundle", "msixbundle", "appinstaller", "jnlp", "cab", "drv"];
    // Windows ignores trailing dots and spaces, so "a.exe. " is still an .exe.
    let name = path.rsplit(['\\', '/']).next().unwrap_or(path).trim_end_matches(['.', ' ']);
    // No extension at all: the shell would ask which program to use, so it is not opened either.
    let Some((_, ext)) = name.rsplit_once('.') else { return true };
    BLOCKED.contains(&ext.trim().to_ascii_lowercase().as_str())
}
#[tauri::command]
pub fn browser_open_download(webview: tauri::Webview, id: u64) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    let path = DOWNLOADS.lock().map_err(|_| "download_unavailable")?.iter().find(|r| r.id == id && r.status == "complete").and_then(|r| r.path.clone()).ok_or("download_not_complete")?;
    if download_open_blocked(&path) { return Err("download_open_blocked".into()); }
    if !std::path::Path::new(&path).is_file() { return Err("download_file_missing".into()); }
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        let wide = |text: &std::ffi::OsStr| text.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let verb = wide(std::ffi::OsStr::new("open"));
        let file = wide(std::ffi::OsStr::new(&path));
        // Shell "open" on the exact recorded path; values above 32 mean success.
        let code = unsafe { windows_sys::Win32::UI::Shell::ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1) } as isize;
        if code <= 32 { return Err("download_open_failed".into()); }
        Ok(())
    }
    #[cfg(not(windows))] { Err("download_unavailable".into()) }
}
#[cfg(test)]
mod download_open_policy_tests {
    use super::*;
    #[test]
    fn executable_and_script_downloads_are_not_opened() {
        for name in ["a.exe", "A.EXE", "setup.msi", "x.bat", "x.cmd", "x.com", "x.scr", "x.ps1", "x.vbs", "x.js", "x.jse", "x.wsf", "x.hta", "x.lnk", "x.reg", "x.cpl", "x.msc", "x.jar", "x.appx", "x.msix", "x.dll", "x.sys", "x.pif", "x.application", "x.gadget",
            "a.exe.", "a.exe ", "a.pdf.exe", "C:\\Users\\me\\Downloads\\run.Exe", "noextension", ".exe", "C:/d/x.ps1"] {
            assert!(download_open_blocked(name), "{name}");
        }
        for name in ["a.pdf", "photo.JPG", "notes.txt", "C:\\Users\\me\\Downloads\\a.exe\\b.pdf", "archive.zip", "研究.docx", "a.exe.pdf"] {
            assert!(!download_open_blocked(name), "{name}");
        }
    }
}

fn safe_download_name(raw: &str) -> String {
    let name: String = raw.chars().scan(0, |size, c| {
        *size += c.len_utf16();
        (*size <= 160).then_some(if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
    }).collect();
    let name = name.trim_end_matches(['.', ' ']);
    if name.is_empty() { return "download".into(); }
    let stem = name.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if reserved { format!("_{name}") } else { name.into() }
}
#[cfg(test)]
mod download_name_tests {
    use super::*;
    #[test]
    fn download_names_do_not_escape_or_exceed_windows_limits() {
        assert_eq!(safe_download_name("a/../b\\c:<x>?.txt"), "a_.._b_c__x__.txt");
        assert_eq!(safe_download_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_download_name("LPT1"), "_LPT1");
        assert_eq!(safe_download_name("... "), "download");
        assert!(safe_download_name(&"😀".repeat(200)).encode_utf16().count() <= 160);
        assert_eq!(safe_download_name("研究.pdf"), "研究.pdf");
    }
}

#[cfg(test)]
mod page_load_tests {
    use super::*;

    #[test]
    fn failed_build_clears_its_own_observation() {
        let mut observation = PageLoadObservation::new(true);
        let child = Arc::clone(&observation.as_ref().unwrap().child);
        observation.as_mut().unwrap().observe(&child, true);
        PageLoadObservation::clear_failed(&mut observation, Some(&child));
        assert!(observation.is_none());
    }

    #[test]
    fn failed_build_preserves_reentrant_newer_child() {
        let old_child = PageLoadObservation::new(true).unwrap().child;
        let mut observation = PageLoadObservation::new(true);
        let newer_child = Arc::clone(&observation.as_ref().unwrap().child);
        observation.as_mut().unwrap().observe(&newer_child, true);
        PageLoadObservation::clear_failed(&mut observation, Some(&old_child));
        assert_eq!(observation.as_ref().unwrap().counts, Some((1, 0)));
        assert!(Arc::ptr_eq(&observation.unwrap().child, &newer_child));
    }

    #[test]
    fn failed_build_without_enabled_token_cannot_clear_observation() {
        let mut disabled = PageLoadObservation::new(false);
        PageLoadObservation::clear_failed(&mut disabled, None);
        assert!(disabled.is_none());
        let mut observation = PageLoadObservation::new(true);
        PageLoadObservation::clear_failed(&mut observation, None);
        assert_eq!(observation.unwrap().counts, Some((0, 0)));
    }

    #[test]
    fn disabled_has_no_observation() {
        assert!(PageLoadObservation::new(false).is_none());
    }

    #[test]
    fn hook_counts_are_independent_not_completion() {
        let mut observation = PageLoadObservation::new(true).unwrap();
        let child = Arc::clone(&observation.child);
        observation.observe(&child, false);
        assert_eq!(observation.counts, Some((0, 1)));
        observation.observe(&child, true);
        observation.observe(&child, true);
        assert_eq!(observation.counts, Some((2, 1)));
        observation.observe(&child, false);
        observation.observe(&child, false);
        assert_eq!(observation.counts, Some((2, 3)));
    }

    #[test]
    fn both_events_between_snapshots_remain_observable() {
        let mut observation = PageLoadObservation::new(true).unwrap();
        let child = Arc::clone(&observation.child);
        let before = observation.counts;
        observation.observe(&child, true);
        observation.observe(&child, false);
        assert_ne!(before, observation.counts);
        assert_eq!(observation.counts, Some((1, 1)));
    }

    #[test]
    fn replacement_child_rejects_old_callback_even_with_same_tab_id() {
        let mut observation = PageLoadObservation::new(true).unwrap();
        let old_child = Arc::clone(&observation.child);
        observation.observe(&old_child, true);
        // Failed/retried builds also allocate a distinct lifetime; label/id do not identify it.
        observation = PageLoadObservation::new(true).unwrap();
        let new_child = Arc::clone(&observation.child);
        observation.observe(&old_child, false);
        observation.observe(&old_child, true);
        assert_eq!(observation.counts, Some((0, 0)));
        observation.observe(&new_child, true);
        assert_eq!(observation.counts, Some((1, 0)));
    }

    #[test]
    fn discard_clears_observation_and_failed_close_retains_it() {
        let mut state = TabState::default();
        state.tabs.push(Tab { id:1, label:String::new(), url:String::new(), title:String::new(),
            discarded:false, loading:false, page_load:PageLoadObservation::new(true),desired_muted:false,media:None, pinned:false,
            zoom:1.0, can_back:false, can_forward:false, group:None, private:false, private_ready:false, hidden_since:None, favicon:None });
        let old_child = Arc::clone(&state.tabs[0].page_load.as_ref().unwrap().child);
        mark_tab_discarded(&mut state, 1, false);
        assert!(state.tabs[0].page_load.is_some());
        mark_tab_discarded(&mut state, 1, true);
        assert!(state.tabs[0].page_load.is_none());
        state.tabs[0].page_load = PageLoadObservation::new(true);
        state.tabs[0].page_load.as_mut().unwrap().observe(&old_child, false);
        assert_eq!(state.tabs[0].page_load.as_ref().unwrap().counts, Some((0, 0)));
    }

    #[test]
    fn safe_integer_boundary_is_exact_and_overflow_stays_unavailable() {
        for started in [true, false] {
            let mut observation = PageLoadObservation::new(true).unwrap();
            let child = Arc::clone(&observation.child);
            observation.counts = Some((PAGE_LOAD_SAFE_INTEGER - 1, PAGE_LOAD_SAFE_INTEGER - 1));
            observation.observe(&child, started);
            let expected = if started { (PAGE_LOAD_SAFE_INTEGER, PAGE_LOAD_SAFE_INTEGER - 1) }
                else { (PAGE_LOAD_SAFE_INTEGER - 1, PAGE_LOAD_SAFE_INTEGER) };
            assert_eq!(observation.counts, Some(expected));
            observation.observe(&child, started);
            assert!(observation.counts.is_none());
            observation.observe(&child, !started);
            assert!(observation.counts.is_none());
            observation.counts = Some((u64::MAX, u64::MAX));
            observation.observe(&child, started);
            assert!(observation.counts.is_none());
        }
    }
}

// Verify the actual WebView2 profile: older environments may ignore incognito.
#[cfg(windows)]
fn verified_private_view(view: &tauri::Webview) -> bool {
    use windows_core::Interface;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_13;
    let verified = Arc::new(AtomicBool::new(false));
    let result = Arc::clone(&verified);
    if view.with_webview(move |platform| unsafe {
        let checked = (|| -> windows_core::Result<bool> {
            let profile = platform.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?.Profile()?;
            let mut private = windows_core::BOOL(0);
            profile.IsInPrivateModeEnabled(&mut private)?;
            Ok(private.as_bool())
        })();
        result.store(checked.unwrap_or(false), Ordering::SeqCst);
    }).is_err() { return false; }
    verified.load(Ordering::SeqCst)
}
#[cfg(not(windows))]
fn verified_private_view(_view: &tauri::Webview) -> bool { false }

fn validate_group(group: Option<String>) -> Result<Option<String>, String> {
    group.map(|name| {
        if name.chars().count() > 80 || name.chars().any(char::is_control) { return Err("invalid_tab_group".into()); }
        let name = name.trim().to_owned(); Ok((!name.is_empty()).then_some(name))
    }).transpose().map(Option::flatten)
}
fn set_tab_group(state: &mut TabState, id: u64, group: Option<String>) -> Result<Option<String>, String> {
    let group = validate_group(group)?;
    let groups: std::collections::HashSet<&str> = state.tabs.iter().filter(|tab| tab.id != id).filter_map(|tab| tab.group.as_deref()).chain(group.as_deref()).collect();
    if groups.len() > 16 { return Err("tab_group_limit".into()); }
    let tab = state.tabs.iter_mut().find(|tab| tab.id == id).ok_or("tab_not_found")?;
    Ok(std::mem::replace(&mut tab.group, group))
}
#[tauri::command]
pub fn browser_set_tab_group(app: AppHandle, webview: tauri::Webview, id: u64, group: Option<String>) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    let old = with_tabs(|state| set_tab_group(state, id, group)).ok_or("browser_unavailable")??;
    if let Err(error) = save_session_checked() {
        with_tabs(|state| { if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == id) { tab.group = old; } });
        return Err(error);
    }
    notify_tabs(&app); Ok(())
}
fn snapshot_session(state: &TabState) -> SavedSession {
    let normal: Vec<&Tab> = state.tabs.iter().filter(|tab| !tab.private).collect();
    SavedSession { version:1, active:normal.iter().position(|tab| tab.id == state.active).unwrap_or(0),
        tabs:normal.into_iter().map(|tab| SavedTab { url:tab.url.clone(), title:tab.title.clone(), pinned:tab.pinned, zoom:tab.zoom, group:tab.group.clone(), muted:tab.desired_muted }).collect() }
}

fn history_after_clear(mut history: Vec<HistoryEntry>, since: Option<i64>, now: i64) -> Result<Vec<HistoryEntry>, String> {
    if since.is_some_and(|since| since < 0 || since > now) { return Err("invalid_history_range".into()); }
    // Existing history timestamps are Unix seconds; preserve that file/UI contract.
    history.retain(|item| since.is_some_and(|since| item.at < since / 1000)); Ok(history)
}
#[tauri::command]
pub async fn browser_clear_history(app: AppHandle, webview: tauri::Webview, since: Option<i64>) -> Result<(), String> {
    // Same path as the "history" category: Hub's list and WebView2's own history database.
    if since.is_some_and(|since| since < 0) { return Err("invalid_history_range".into()); }
    browser_clear_browsing_data(app, webview, vec!["history".into()], since.map(|since| since as u64)).await
}
fn clear_history_file(since: Option<i64>) -> Result<(), String> {
    let _serial = HISTORY_WRITE.lock().map_err(|_| "history_unavailable")?;
    let path = local_data_dir().ok_or("history_unavailable")?.join("browser-history.json");
    let history = match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| "history_read_failed")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err("history_read_failed".into()),
    };
    let history = history_after_clear(history, since, chrono::Utc::now().timestamp_millis())?;
    let encoded = serde_json::to_vec(&history).map_err(|_| "history_write_failed")?;
    browser_bookmarks::write_atomic(&path, &encoded).map_err(|_| "history_write_failed".into())
}
/// All entries with exactly this URL removed; everything else keeps its order.
fn history_without_url(mut history: Vec<HistoryEntry>, url: &str) -> Vec<HistoryEntry> { history.retain(|item| item.url != url); history }
#[tauri::command]
pub fn browser_delete_history_entry(webview: tauri::Webview, url: String) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    if url.is_empty() || url.len() > 8192 { return Err("invalid_history_url".into()); }
    let _serial = HISTORY_WRITE.lock().map_err(|_| "history_unavailable")?;
    let path = local_data_dir().ok_or("history_unavailable")?.join("browser-history.json");
    let history: Vec<HistoryEntry> = match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| "history_read_failed")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("history_read_failed".into()),
    };
    let before = history.len();
    let history = history_without_url(history, &url);
    if history.len() == before { return Ok(()); }
    let encoded = serde_json::to_vec(&history).map_err(|_| "history_write_failed")?;
    browser_bookmarks::write_atomic(&path, &encoded).map_err(|_| "history_write_failed".into())
}

// WebView2 COREWEBVIEW2_BROWSING_DATA_KINDS bits used by the categories below.
const DATA_COOKIES: i32 = 64;
const DATA_DISK_CACHE: i32 = 256;
const DATA_DOWNLOAD_HISTORY: i32 = 512;
const DATA_SITE_STORAGE: i32 = 32 | 32768; // ALL_DOM_STORAGE | SERVICE_WORKERS (not cookies)
const DATA_BROWSING_HISTORY: i32 = 4096; // WebView2's own visit database, not only browser-history.json
/// Category names to (WebView2 flag bits, also clear Hub's browser-history.json).
fn browsing_data_plan(kinds: &[String]) -> Result<(i32, bool), String> {
    if kinds.is_empty() || kinds.len() > 8 { return Err("browsing_data_kinds_invalid".into()); }
    let (mut flags, mut history) = (0, false);
    for kind in kinds {
        match kind.as_str() {
            "cookies" => flags |= DATA_COOKIES,
            "cache" => flags |= DATA_DISK_CACHE,
            "site_storage" => flags |= DATA_SITE_STORAGE,
            "downloads_history" => flags |= DATA_DOWNLOAD_HISTORY,
            "history" => { flags |= DATA_BROWSING_HISTORY; history = true }
            _ => return Err("browsing_data_kind_unknown".into()),
        }
    }
    Ok((flags, history))
}
#[tauri::command]
pub async fn browser_clear_browsing_data(app: AppHandle, webview: tauri::Webview, kinds: Vec<String>, since_ms: Option<u64>) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    let (flags, history) = browsing_data_plan(&kinds)?;
    let now = chrono::Utc::now().timestamp_millis();
    if since_ms.is_some_and(|since| since > now as u64) { return Err("invalid_clear_range".into()); }
    if flags != 0 {
        let view = app.get_webview(MAIN_LABEL).ok_or("browser_unavailable")?;
        let (tx, rx) = std::sync::mpsc::channel();
        call_clear_browsing_data(&view, flags, since_ms, now, tx);
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(30))).await
            .map_err(|_| "browsing_data_unavailable")?.map_err(|_| "browsing_data_unavailable")??;
    }
    if history { clear_history_file(since_ms.map(|since| since as i64))?; if since_ms.is_none() { clear_site_zoom(); forget_previous_session(); } }
    Ok(())
}
#[cfg(windows)]
fn call_clear_browsing_data(view: &tauri::Webview, flags: i32, since_ms: Option<u64>, now_ms: i64, tx: std::sync::mpsc::Sender<Result<(), String>>) {
    use windows_core::Interface;
    use webview2_com::{ClearBrowsingDataCompletedHandler, Microsoft::Web::WebView2::Win32::{ICoreWebView2_13, ICoreWebView2Profile2, COREWEBVIEW2_BROWSING_DATA_KINDS}};
    let failure = tx.clone();
    if view.with_webview(move |platform| unsafe {
        let result = (|| -> Result<(), String> {
            let profile = platform.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_13>()).and_then(|core| core.Profile())
                .map_err(|_| "browsing_data_unavailable")?;
            // Only the normal profile: a private profile is separate and never cleared here.
            let mut private = windows_core::BOOL(0);
            profile.IsInPrivateModeEnabled(&mut private).map_err(|_| "browsing_data_unavailable")?;
            if private.as_bool() { return Err("browsing_data_unavailable".into()); }
            let profile = profile.cast::<ICoreWebView2Profile2>().map_err(|_| "browsing_data_unsupported")?;
            let completed = tx.clone();
            let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                let _ = completed.send(result.map_err(|_| "browsing_data_clear_failed".to_owned())); Ok(())
            }));
            let kinds = COREWEBVIEW2_BROWSING_DATA_KINDS(flags);
            match since_ms {
                Some(since) => profile.ClearBrowsingDataInTimeRange(kinds, since as f64 / 1000.0, now_ms as f64 / 1000.0 + 1.0, &handler),
                None => profile.ClearBrowsingData(kinds, &handler),
            }.map_err(|_| "browsing_data_clear_failed")?;
            Ok(())
        })();
        if let Err(error) = result { let _ = tx.send(Err(error)); }
    }).is_err() { let _ = failure.send(Err("browsing_data_unavailable".into())); }
}
#[cfg(not(windows))]
fn call_clear_browsing_data(_view: &tauri::Webview, _flags: i32, _since_ms: Option<u64>, _now_ms: i64, tx: std::sync::mpsc::Sender<Result<(), String>>) { let _ = tx.send(Err("browsing_data_unavailable".into())); }

#[cfg(test)]
mod browsing_data_tests {
    use super::*;
    fn kinds(list: &[&str]) -> Vec<String> { list.iter().map(|k| (*k).to_owned()).collect() }
    #[test]
    fn categories_map_to_flags_and_reject_unknowns() {
        assert_eq!(browsing_data_plan(&kinds(&["cookies"])).unwrap(), (64, false));
        assert_eq!(browsing_data_plan(&kinds(&["history"])).unwrap(), (4096, true));
        assert_eq!(browsing_data_plan(&kinds(&["cache", "cookies", "site_storage", "downloads_history", "history"])).unwrap(), (64 | 256 | 512 | 32 | 32768 | 4096, true));
        for bad in [kinds(&[]), kinds(&["cookies", "passwords"]), kinds(&["all"]), kinds(&["Cookies"]), kinds(&[""])] { assert!(browsing_data_plan(&bad).is_err()); }
    }
    #[test]
    fn history_entry_deletion_is_exact_url_only() {
        let entry = |url: &str, at| HistoryEntry { url: url.into(), at, title: String::new() };
        let history = vec![entry("https://a.example/", 3), entry("https://a.example/x", 2), entry("https://a.example/", 1)];
        let kept = history_without_url(history, "https://a.example/");
        assert_eq!(kept.len(), 1); assert_eq!(kept[0].url, "https://a.example/x");
        assert_eq!(history_without_url(kept, "https://a.example").len(), 1);
    }
}

fn site_data_target(state: &TabState, origin: &str) -> Result<u64, String> {
    let url = parse_target(origin).ok_or("invalid_site_origin")?;
    let host = url.host_str().ok_or("invalid_site_origin")?;
    if url.origin().ascii_serialization() != origin || host == "jkamma.com" || host.ends_with(".jkamma.com") || host == "tauri.localhost" { return Err("invalid_site_origin".into()); }
    let tab = state.tabs.iter().find(|tab| tab.id == state.active && !tab.private && !tab.discarded).ok_or("site_data_unavailable")?;
    if !parse_target(&tab.url).is_some_and(|current| current.origin() == url.origin()) { return Err("site_data_target_changed".into()); }
    Ok(tab.id)
}
#[tauri::command]
pub async fn browser_clear_site_data(app: AppHandle, webview: tauri::Webview, origin: String) -> Result<(), String> {
    if webview.label() != MAIN_LABEL { return Err("browser_unavailable".into()); }
    if app.get_webview(MAIN_LABEL).and_then(|view| view.url().ok()).is_some_and(|url| url.origin().ascii_serialization() == origin) { return Err("invalid_site_origin".into()); }
    let id = with_tabs(|state| site_data_target(state, &origin)).ok_or("browser_unavailable")??;
    let target = app.get_webview(&format!("browser-tab-{id}")).ok_or("site_data_unavailable")?;
    if !target.url().ok().is_some_and(|url| url.origin().ascii_serialization() == origin) { return Err("site_data_target_changed".into()); }
    let (tx, rx) = std::sync::mpsc::channel();
    call_site_clear(&target, id, origin, tx);
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10))).await.map_err(|_| "site_data_unavailable")?.map_err(|_| "site_data_unavailable")?

}

#[cfg(test)]
mod daily_browser_tests {
    use super::*;
    fn tab(id:u64, private:bool) -> Tab { Tab { id,label:format!("browser-tab-{id}"),url:"https://example.org/".into(),discarded:false,title:"fixture".into(),loading:false,page_load:None,desired_muted:false,media:None,pinned:false,zoom:1.0,can_back:false,can_forward:false,group:None,private,private_ready:private,hidden_since:None,favicon:None } }
    #[test]
    fn private_session_never_serializes_private_tabs_and_rebases_active() {
        let mut state=TabState {tabs:vec![tab(1,true),tab(2,false),tab(3,false)],active:3,..TabState::default()};
        state.tabs[1].group=Some("研究".into());
        let saved=snapshot_session(&state); assert_eq!(saved.active,1); assert_eq!(saved.tabs.len(),2);
        let encoded=serde_json::to_string(&saved).unwrap(); assert!(!encoded.contains("private"));
        assert_eq!(decode_session(&encoded).unwrap().tabs[0].group.as_deref(),Some("研究"));
        state.active=1; assert_eq!(snapshot_session(&state).active,0);
        state.tabs.retain(|tab| tab.private); assert!(snapshot_session(&state).tabs.is_empty());
        state.tabs[0].hidden_since=Some(Instant::now()-DISCARD_AFTER); assert!(!tab_is_stale(&state.tabs[0],Instant::now()));
    }
    #[test]
    fn group_bounds_and_limit_do_not_change_tab_order() {
        let mut state=TabState {tabs:(1..=17).map(|id| tab(id,false)).collect(),..TabState::default()};
        for id in 1..=16 { set_tab_group(&mut state,id,Some(id.to_string())).unwrap(); }
        assert!(set_tab_group(&mut state,17,Some("extra".into())).is_err());
        assert!(set_tab_group(&mut state,17,Some("1".into())).is_ok());
        for bad in ["x".repeat(81),"bad\n".into(),"\u{0085}".into()] { assert!(validate_group(Some(bad)).is_err()); }
        assert_eq!(validate_group(Some(" ".into())).unwrap(),None);
        assert_eq!(state.tabs.iter().map(|tab| tab.id).collect::<Vec<_>>(),(1..=17).collect::<Vec<_>>());
    }
    #[test]
    fn history_range_inclusive_and_invalid_inputs() {
        let history=|| vec![HistoryEntry{url:"a".into(),at:9,title:String::new()},HistoryEntry{url:"b".into(),at:10,title:String::new()}];
        assert_eq!(history_after_clear(history(),Some(10_000),20_000).unwrap().len(),1);
        assert!(history_after_clear(history(),None,20).unwrap().is_empty());
        for bad in [-1,21,i64::MAX] { assert!(history_after_clear(history(),Some(bad),20).is_err()); }
    }
    #[test]
    fn clear_site_is_bound_to_normal_active_canonical_external_origin() {
        let mut state=TabState{tabs:vec![tab(1,false)],active:1,..TabState::default()};
        assert_eq!(site_data_target(&state,"https://example.org").unwrap(),1);
        for bad in ["https://example.org/","https://example.org/path","https://user:pass@example.org","http://example.org","https://hub.jkamma.com","https://account.jkamma.com","https://tauri.localhost","file:///x"] { assert!(site_data_target(&state,bad).is_err()); }
        state.tabs[0].private=true; assert!(site_data_target(&state,"https://example.org").is_err());
        state.tabs[0].private=false; state.tabs[0].discarded=true; assert!(site_data_target(&state,"https://example.org").is_err());
    }
}

#[cfg(windows)]
fn call_site_clear(view: &tauri::Webview, id: u64, origin: String, tx: std::sync::mpsc::Sender<Result<(), String>>) {
    use windows_core::{HSTRING, PWSTR};
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, take_pwstr};
    let failure = tx.clone();
    if view.with_webview(move |platform| unsafe {
        let result = (|| -> Result<(), String> {
            if with_tabs(|state| site_data_target(state, &origin)).and_then(Result::ok) != Some(id) { return Err("site_data_target_changed".into()); }
            let core = platform.controller().CoreWebView2().map_err(|_| "site_data_unavailable")?;
            let mut raw = PWSTR::null(); core.Source(&mut raw).map_err(|_| "site_data_unavailable")?;
            let source = take_pwstr(raw);
            if !parse_target(&source).is_some_and(|url| url.origin().ascii_serialization() == origin) { return Err("site_data_target_changed".into()); }
            let completed = tx.clone();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
                let _ = completed.send(result.map(|_| ()).map_err(|_| "site_data_clear_failed".into())); Ok(())
            }));
            // Domain cookies may be shared; the preview explains related-site logout.
            core.CallDevToolsProtocolMethod(&HSTRING::from("Storage.clearDataForOrigin"), &HSTRING::from(serde_json::json!({"origin":origin,"storageTypes":"all"}).to_string()), &handler).map_err(|_| "site_data_clear_failed")?;
            Ok(())
        })();
        if let Err(error) = result { let _ = tx.send(Err(error)); }
    }).is_err() { let _ = failure.send(Err("site_data_unavailable".into())); }
}
#[cfg(not(windows))]
fn call_site_clear(_view: &tauri::Webview, _id: u64, _origin: String, tx: std::sync::mpsc::Sender<Result<(), String>>) { let _ = tx.send(Err("site_data_unavailable".into())); }

struct BrowserMediaObservation {
    child: Arc<()>,
    context_identity: Option<u64>,
    tracking: bool,
    muted: Option<bool>,
    playing_audio: Option<bool>,
    can_print: bool,
}
impl BrowserMediaObservation {
    fn new() -> Self {
        Self {
            child: Arc::new(()),
            context_identity: allocate_child_lifetime(&BROWSER_MEDIA_CONTEXT_SEQUENCE),
            tracking: false,
            muted: None,
            playing_audio: None,
            can_print: false,
        }
    }
    fn can_mute(&self) -> bool {
        self.tracking && self.muted.is_some() && self.playing_audio.is_some()
    }
}
struct BrowserMediaTarget {
    id: u64,
    label: String,
    url: String,
    committed_url: String,
    child: Arc<()>,
    browser_epoch: u64,
    tab_epoch: u64,
    print: bool,
    context_token: String,
}
static BROWSER_MEDIA_CONTEXT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
fn valid_print_context_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}
// This is a stale-context comparison, never a permission or a print destination.
fn media_print_context_token(
    tab: &Tab,
    browser_epoch: u64,
    navigation_epoch: u64,
) -> Option<String> {
    use sha2::{Digest, Sha256};
    let media = tab.media.as_ref()?;
    if !media.can_print || !media_child_current(tab, &media.child) {
        return None;
    }
    let identity = media.context_identity?;
    let scope = format!(
        "browser.print.context.v1:{}:{identity}:{browser_epoch}:{navigation_epoch}",
        tab.id
    );
    Some(
        Sha256::digest(scope.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}
fn media_child_current(tab: &Tab, child: &Arc<()>) -> bool {
    !tab.discarded
        && (!tab.private || tab.private_ready)
        && tab
            .media
            .as_ref()
            .is_some_and(|media| Arc::ptr_eq(&media.child, child))
}
fn media_target_current(
    state: &TabState,
    target: &BrowserMediaTarget,
    visible: bool,
    interactive: bool,
    browser_epoch: u64,
    tab_epoch: u64,
) -> bool {
    visible
        && target.browser_epoch == browser_epoch
        && (!target.print
            || (interactive && state.active == target.id && target.tab_epoch == tab_epoch))
        && state.tabs.iter().any(|tab| {
            tab.id == target.id
                && tab.label == target.label
                && tab.url == target.url
                && media_child_current(tab, &target.child)
                && (!target.print
                    || media_print_context_token(tab, browser_epoch, tab_epoch).as_deref()
                        == Some(target.context_token.as_str()))
        })
}
fn current_media_target(target: &BrowserMediaTarget) -> bool {
    with_tabs(|state| {
        media_target_current(
            state,
            target,
            BROWSER_VISIBLE.load(Ordering::SeqCst),
            native_tabs_interactive() && !reading::occluded(),
            BROWSER_EPOCH.load(Ordering::SeqCst),
            BROWSER_PRINT_CONTEXT_EPOCH.load(Ordering::SeqCst),
        )
    })
    .unwrap_or(false)
}
fn browser_media_guard(webview: &tauri::Webview) -> Result<(), String> {
    let url = webview.url().map_err(|_| "native_window_required")?;
    if !crate::local_pairing_address(webview.label(), &url) {
        return Err("native_window_required".to_owned());
    }
    Ok(())
}
fn capture_media_target(
    app: &AppHandle,
    id: u64,
    print: bool,
    context_token: Option<&str>,
) -> Result<(tauri::Webview, BrowserMediaTarget), String> {
    let target = with_tabs(|state| {
        let tab = state
            .tabs
            .iter()
            .find(|tab| tab.id == id)
            .ok_or("browser_tab_not_found")?;
        let media = tab
            .media
            .as_ref()
            .filter(|media| media_child_current(tab, &media.child))
            .ok_or("browser_tab_context_changed")?;
        if if print {
            !media.can_print
        } else {
            !media.can_mute()
        } {
            return Err(if print {
                "browser_print_unavailable"
            } else {
                "browser_audio_unavailable"
            });
        }
        let browser_epoch = BROWSER_EPOCH.load(Ordering::SeqCst);
        let tab_epoch = BROWSER_PRINT_CONTEXT_EPOCH.load(Ordering::SeqCst);
        let expected_token = if print {
            media_print_context_token(tab, browser_epoch, tab_epoch)
                .ok_or("browser_print_unavailable")?
        } else {
            String::new()
        };
        if print && context_token != Some(expected_token.as_str()) {
            return Err("browser_tab_context_changed");
        }
        Ok(BrowserMediaTarget {
            id,
            label: tab.label.clone(),
            url: tab.url.clone(),
            committed_url: String::new(),
            child: Arc::clone(&media.child),
            browser_epoch,
            tab_epoch,
            print,
            context_token: expected_token,
        })
    })
    .ok_or("browser_tab_not_found")?
    .map_err(str::to_owned)?;
    let view = app
        .get_webview(&target.label)
        .ok_or("browser_tab_context_changed")?;
    if view.window().label() != MAIN_LABEL {
        return Err("browser_tab_context_changed".to_owned());
    }
    let committed = view.url().map_err(|_| "browser_tab_context_changed")?;
    if (!target.url.is_empty() && committed.as_str() != target.url)
        || !current_media_target(&target)
    {
        return Err("browser_tab_context_changed".to_owned());
    }
    let mut target = target;
    target.committed_url = committed.to_string();
    Ok((view, target))
}
fn notify_media_tabs(app: &AppHandle) {
    sync_native_tabs(app, true);
    let _ = app.emit_to(MAIN_LABEL, "browser-tabs-changed", ());
}
fn commit_media_read(
    state: &mut TabState,
    id: u64,
    child: &Arc<()>,
    muted: Option<bool>,
    playing: Option<bool>,
    can_print: bool,
) -> bool {
    let Some(tab) = state
        .tabs
        .iter_mut()
        .find(|tab| tab.id == id && media_child_current(tab, child))
    else {
        return false;
    };
    let Some(media) = tab.media.as_mut() else {
        return false;
    };
    let values = if media.tracking {
        (muted, playing)
    } else {
        (None, None)
    };
    let changed =
        (media.muted, media.playing_audio, media.can_print) != (values.0, values.1, can_print);
    media.muted = values.0;
    media.playing_audio = values.1;
    media.can_print = can_print;
    changed
}
#[cfg(windows)]
unsafe fn read_media_core(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> (Option<bool>, Option<bool>, bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_16, ICoreWebView2_8};
    use windows_core::Interface;
    let values = core.cast::<ICoreWebView2_8>().ok().and_then(|audio| {
        let mut muted = windows_core::BOOL(0);
        let mut playing = windows_core::BOOL(0);
        (audio.IsMuted(&mut muted).is_ok() && audio.IsDocumentPlayingAudio(&mut playing).is_ok())
            .then_some((muted.as_bool(), playing.as_bool()))
    });
    (
        values.map(|value| value.0),
        values.map(|value| value.1),
        core.cast::<ICoreWebView2_16>().is_ok(),
    )
}
#[cfg(windows)]
unsafe fn refresh_media_core(
    app: &AppHandle,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    id: u64,
    child: &Arc<()>,
) {
    if !with_tabs(|state| {
        state
            .tabs
            .iter()
            .any(|tab| tab.id == id && media_child_current(tab, child))
    })
    .unwrap_or(false)
    {
        return;
    }
    let (muted, playing, can_print) = read_media_core(core);
    if with_tabs(|state| commit_media_read(state, id, child, muted, playing, can_print))
        .unwrap_or(false)
    {
        notify_media_tabs(app);
    }
}
#[cfg(windows)]
fn hook_tab_media(app: &AppHandle, view: &tauri::Webview, id: u64) {
    use webview2_com::{
        IsDocumentPlayingAudioChangedEventHandler, IsMutedChangedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2_8,
    };
    use windows_core::Interface;
    let child = with_tabs(|state| {
        let tab = state.tabs.iter_mut().find(|tab| tab.id == id)?;
        tab.media = Some(BrowserMediaObservation::new());
        tab.media.as_ref().map(|media| Arc::clone(&media.child))
    })
    .flatten();
    let Some(child) = child else {
        return;
    };
    reading::reconcile(app);
    let handle = app.clone();
    let _ = view.with_webview(move |platform| unsafe {
        if !with_tabs(|state| {
            state
                .tabs
                .iter()
                .any(|tab| tab.id == id && media_child_current(tab, &child))
        })
        .unwrap_or(false)
        {
            return;
        }
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        if let Ok(audio) = core.cast::<ICoreWebView2_8>() {
            let muted_app = handle.clone();
            let muted_child = Arc::clone(&child);
            let muted = IsMutedChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(core) = sender {
                    refresh_media_core(&muted_app, &core, id, &muted_child);
                }
                Ok(())
            }));
            let playing_app = handle.clone();
            let playing_child = Arc::clone(&child);
            let playing =
                IsDocumentPlayingAudioChangedEventHandler::create(Box::new(move |sender, _| {
                    if let Some(core) = sender {
                        refresh_media_core(&playing_app, &core, id, &playing_child);
                    }
                    Ok(())
                }));
            let mut muted_token = 0;
            let mut playing_token = 0;
            let tracking = audio.add_IsMutedChanged(&muted, &mut muted_token).is_ok()
                && audio
                    .add_IsDocumentPlayingAudioChanged(&playing, &mut playing_token)
                    .is_ok();
            with_tabs(|state| {
                if let Some(tab) = state
                    .tabs
                    .iter_mut()
                    .find(|tab| tab.id == id && media_child_current(tab, &child))
                {
                    if let Some(media) = tab.media.as_mut() {
                        media.tracking = tracking;
                    }
                }
            });
        }
        refresh_media_core(&handle, &core, id, &child);
    });
}
#[cfg(not(windows))]
fn hook_tab_media(_app: &AppHandle, _view: &tauri::Webview, _id: u64) {}
// Muted restoration starts on the bundled page and verifies the actual property before external navigation.
#[cfg(windows)]
fn apply_restored_mute(view: &tauri::Webview) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows_core::Interface;
    let (tx, rx) = std::sync::mpsc::channel();
    if view
        .with_webview(move |platform| unsafe {
            let confirmed = platform
                .controller()
                .CoreWebView2()
                .ok()
                .and_then(|core| core.cast::<ICoreWebView2_8>().ok())
                .is_some_and(|audio| {
                    let mut actual = windows_core::BOOL(0);
                    audio.SetIsMuted(true).is_ok()
                        && audio.IsMuted(&mut actual).is_ok()
                        && actual.as_bool()
                });
            let _ = tx.send(confirmed);
        })
        .is_err()
    {
        return false;
    }
    rx.try_recv() == Ok(true)
}
#[cfg(not(windows))]
fn apply_restored_mute(_view: &tauri::Webview) -> bool {
    false
}
#[cfg(windows)]
unsafe fn committed_media_source(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    target: &BrowserMediaTarget,
) -> bool {
    let mut raw = windows_core::PWSTR::null();
    core.Source(&mut raw).is_ok() && webview2_com::take_pwstr(raw) == target.committed_url
}
#[cfg(windows)]
fn dispatch_tab_media(
    view: &tauri::Webview,
    app: AppHandle,
    target: BrowserMediaTarget,
    muted: Option<bool>,
    tx: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, ICoreWebView2_8, COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER,
    };
    use windows_core::Interface;
    let failure = if target.print {
        "browser_print_unavailable"
    } else {
        "browser_audio_unavailable"
    };
    let tx = Arc::new(Mutex::new(Some(tx)));
    let failed = Arc::clone(&tx);
    if view
        .with_webview(move |platform| unsafe {
            let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) else {
                return;
            };
            if tx.is_closed() {
                return;
            }
            let result = (|| -> Result<(), String> {
                let main = app
                    .get_webview(MAIN_LABEL)
                    .ok_or("browser_tab_context_changed")?;
                browser_media_guard(&main).map_err(|_| "browser_tab_context_changed")?;
                if !current_media_target(&target) {
                    return Err("browser_tab_context_changed".to_owned());
                }
                let core = platform.controller().CoreWebView2().map_err(|_| failure)?;
                if !committed_media_source(&core, &target) {
                    return Err("browser_tab_context_changed".to_owned());
                }
                if let Some(requested) = muted {
                    let audio = core.cast::<ICoreWebView2_8>().map_err(|_| failure)?;
                    audio.SetIsMuted(requested).map_err(|_| failure)?;
                    let (actual, playing, can_print) = read_media_core(&core);
                    if actual != Some(requested) || playing.is_none() {
                        return Err(failure.to_owned());
                    }
                    if !current_media_target(&target) || !committed_media_source(&core, &target) {
                        return Err("browser_tab_context_changed".to_owned());
                    }
                    with_tabs(|state| {
                        commit_media_read(
                            state,
                            target.id,
                            &target.child,
                            actual,
                            playing,
                            can_print,
                        );
                        if let Some(tab) = state.tabs.iter_mut().find(|tab| {
                            tab.id == target.id && media_child_current(tab, &target.child)
                        }) {
                            tab.desired_muted = requested;
                        }
                    });
                    if with_tabs(|state| {
                        state
                            .tabs
                            .iter()
                            .any(|tab| tab.id == target.id && !tab.private)
                    })
                    .unwrap_or(false)
                    {
                        save_session_checked().map_err(|_| failure)?;
                    }
                    notify_media_tabs(&app);
                } else {
                    core.cast::<ICoreWebView2_16>()
                        .map_err(|_| failure)?
                        .ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER)
                        .map_err(|_| failure)?;
                    if !current_media_target(&target) || !committed_media_source(&core, &target) {
                        return Err("browser_tab_context_changed".to_owned());
                    }
                }
                Ok(())
            })();
            if result
                .as_ref()
                .err()
                .is_some_and(|error| error == "browser_audio_unavailable")
            {
                let changed = with_tabs(|state| {
                    let can_print = state
                        .tabs
                        .iter()
                        .find(|tab| tab.id == target.id)
                        .and_then(|tab| tab.media.as_ref())
                        .is_some_and(|media| media.can_print);
                    commit_media_read(state, target.id, &target.child, None, None, can_print)
                })
                .unwrap_or(false);
                if changed {
                    notify_media_tabs(&app);
                }
            }
            let _ = tx.send(result);
        })
        .is_err()
    {
        if let Some(tx) = failed.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(Err(failure.to_owned()));
        }
    }
}
#[cfg(not(windows))]
fn dispatch_tab_media(
    _view: &tauri::Webview,
    _app: AppHandle,
    target: BrowserMediaTarget,
    _muted: Option<bool>,
    tx: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    let _ = tx.send(Err(if target.print {
        "browser_print_unavailable"
    } else {
        "browser_audio_unavailable"
    }
    .to_owned()));
}
static BROWSER_PRINT_BUSY: AtomicBool = AtomicBool::new(false);
struct BrowserPrintLease<'a>(&'a AtomicBool);
impl Drop for BrowserPrintLease<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn browser_print_lease(busy: &AtomicBool) -> Result<BrowserPrintLease<'_>, String> {
    busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map(|_| BrowserPrintLease(busy))
        .map_err(|_| "browser_print_busy".to_owned())
}
#[derive(Serialize)]
pub struct BrowserPrintReceipt {
    #[serde(rename = "tabId")]
    tab_id: u64,
    #[serde(rename = "dialogShown")]
    dialog_shown: bool,
}
#[tauri::command]
pub async fn browser_set_muted(
    app: AppHandle,
    webview: tauri::Webview,
    id: u64,
    muted: bool,
) -> Result<BrowserWorkspaceSnapshot, String> {
    browser_media_guard(&webview)?;
    let (view, target) = capture_media_target(&app, id, false, None)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    dispatch_tab_media(&view, app, target, Some(muted), tx);
    tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .map_err(|_| "browser_audio_unavailable")?
        .map_err(|_| "browser_audio_unavailable")??;
    browser_workspace_snapshot(webview).map_err(|_| "browser_audio_unavailable".to_owned())
}
#[tauri::command]
pub async fn browser_show_print(
    app: AppHandle,
    webview: tauri::Webview,
    id: u64,
    context_token: String,
) -> Result<BrowserPrintReceipt, String> {
    browser_media_guard(&webview)?;
    if !valid_print_context_token(&context_token) {
        return Err("browser_tab_context_changed".to_owned());
    }
    let _busy = browser_print_lease(&BROWSER_PRINT_BUSY)?;
    let (view, target) = capture_media_target(&app, id, true, Some(&context_token))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    dispatch_tab_media(&view, app, target, None, tx);
    tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .map_err(|_| "browser_print_unavailable")?
        .map_err(|_| "browser_print_unavailable")??;
    Ok(BrowserPrintReceipt {
        tab_id: id,
        dialog_shown: true,
    })
}

#[cfg(test)]
mod browser_media_print_tests {
    use super::*;
    fn tab(id: u64, private: bool) -> Tab {
        let mut media = BrowserMediaObservation::new();
        media.tracking = true;
        media.muted = Some(false);
        media.playing_audio = Some(true);
        media.can_print = true;
        Tab {
            id,
            label: format!("browser-tab-{id}"),
            url: "https://example.test/".into(),
            discarded: false,
            title: "Fixture".into(),
            loading: false,
            page_load: None,
            desired_muted: false,
            media: Some(media),
            pinned: false,
            zoom: 1.0,
            can_back: false,
            can_forward: false,
            group: None,
            private,
            private_ready: private,
            hidden_since: None,
            favicon: None,
        }
    }
    fn target(tab: &Tab, print: bool) -> BrowserMediaTarget {
        BrowserMediaTarget {
            id: tab.id,
            label: tab.label.clone(),
            url: tab.url.clone(),
            committed_url: tab.url.clone(),
            child: Arc::clone(&tab.media.as_ref().unwrap().child),
            browser_epoch: 7,
            tab_epoch: 9,
            print,
            context_token: media_print_context_token(tab, 7, 9).unwrap(),
        }
    }
    #[test]
    fn managed_find_requires_exact_url_token_and_current_visible_child() {
        let mut state = TabState { tabs: vec![tab(1, false), tab(2, false)], active: 1, ..TabState::default() };
        let source = target(&state.tabs[0], true);
        assert!(find_expected_context(&source, &source.url, &source.context_token));
        assert!(!find_expected_context(&source, "https://another.test/", &source.context_token));
        for token in ["", "wrong", "has space", "token\n", "é"] { assert!(!find_expected_context(&source, &source.url, token)); }
        assert!(media_target_current(&state, &source, true, true, 7, 9));
        // A same-URL reload changes the existing document epoch/token; old requests cannot dispatch.
        let reloaded = media_print_context_token(&state.tabs[0], 7, 10).unwrap();
        assert!(!find_expected_context(&source, &source.url, &reloaded));
        assert!(!media_target_current(&state, &source, true, true, 7, 10));
        state.active = 2; assert!(!media_target_current(&state, &source, true, true, 7, 9));
        state.active = 1; state.tabs[0].discarded = true; assert!(!media_target_current(&state, &source, true, true, 7, 9));
    }
    #[test]
    fn managed_find_rejects_navigation_replacement_and_hidden_or_occluded_sources() {
        let mut state = TabState { tabs: vec![tab(1, false)], active: 1, ..TabState::default() };
        let source = target(&state.tabs[0], true);
        assert!(!media_target_current(&state, &source, false, true, 7, 9));
        assert!(!media_target_current(&state, &source, true, false, 7, 9));
        state.tabs[0].url = "https://another.test/".into(); assert!(!media_target_current(&state, &source, true, true, 7, 9));
        state.tabs[0] = tab(1, false); assert!(!media_target_current(&state, &source, true, true, 7, 9));
    }
    #[test]
    fn managed_find_returns_only_bounded_boolean_and_fixed_failures() {
        for found in [true, false] { assert_eq!(find_result(&serde_json::json!({"result":{"type":"boolean","value":found}}).to_string()).unwrap(), found); }
        for bad in ["{}".into(), "{broken".into(), serde_json::json!({"exceptionDetails":{"text":"private raw page exception"}}).to_string(),
            serde_json::json!({"result":{"value":"not boolean"}}).to_string(), " ".repeat(65537)] {
            assert_eq!(find_result(&bad).unwrap_err(), "find_unavailable");
        }
    }
    #[test]
    fn mute_is_bound_to_the_actual_background_child_print_to_the_visible_active_child() {
        let mut state = TabState {
            tabs: vec![tab(1, false), tab(2, false)],
            active: 2,
            ..TabState::default()
        };
        let muted = target(&state.tabs[0], false);
        let printed = target(&state.tabs[0], true);
        assert!(media_target_current(&state, &muted, true, true, 7, 10));
        assert!(!media_target_current(&state, &printed, true, true, 7, 9));
        state.active = 1;
        assert!(media_target_current(&state, &printed, true, true, 7, 9));
        for (visible, interactive, browser_epoch, tab_epoch) in [
            (false, true, 7, 9),
            (true, false, 7, 9),
            (true, true, 8, 9),
            (true, true, 7, 10),
        ] {
            assert!(!media_target_current(
                &state,
                &printed,
                visible,
                interactive,
                browser_epoch,
                tab_epoch
            ));
        }
        assert!(!media_target_current(&state, &muted, false, true, 7, 9));
        state.tabs[0].url = "https://changed.example/".into();
        assert!(!media_target_current(&state, &muted, true, true, 7, 9));
        state.tabs[0].url = muted.url.clone();
        state.tabs[0].media = Some(BrowserMediaObservation::new());
        assert!(!media_target_current(&state, &muted, true, true, 7, 9));
        state.tabs.clear();
        assert!(!media_target_current(&state, &muted, true, true, 7, 9));
    }
    #[test]
    fn discarded_replaced_and_unverified_private_children_reject_old_observation() {
        let mut state = TabState {
            tabs: vec![tab(1, true)],
            active: 1,
            ..TabState::default()
        };
        let child = Arc::clone(&state.tabs[0].media.as_ref().unwrap().child);
        state.tabs[0].private_ready = false;
        assert!(!commit_media_read(
            &mut state,
            1,
            &child,
            Some(true),
            Some(false),
            true
        ));
        state.tabs[0].private_ready = true;
        state.tabs[0].desired_muted = true;
        mark_tab_discarded(&mut state, 1, false);
        assert!(state.tabs[0].media.is_some());
        mark_tab_discarded(&mut state, 1, true);
        assert!(state.tabs[0].media.is_none());
        assert!(state.tabs[0].desired_muted);
        assert!(!commit_media_read(
            &mut state,
            1,
            &child,
            Some(false),
            Some(true),
            true
        ));
        state.tabs[0].discarded = false;
        state.tabs[0].media = Some(BrowserMediaObservation::new());
        assert!(!commit_media_read(
            &mut state,
            1,
            &child,
            Some(false),
            Some(true),
            true
        ));
    }
    #[test]
    fn missing_runtime_reads_stay_unknown_and_read_observation_is_not_desired_mute() {
        let unknown = BrowserMediaObservation::new();
        assert!(unknown.muted.is_none());
        assert!(unknown.playing_audio.is_none());
        assert!(!unknown.can_mute());
        assert!(!unknown.can_print);
        let mut state = TabState {
            tabs: vec![tab(1, false)],
            ..TabState::default()
        };
        let child = Arc::clone(&state.tabs[0].media.as_ref().unwrap().child);
        assert!(commit_media_read(
            &mut state,
            1,
            &child,
            Some(true),
            Some(false),
            true
        ));
        assert!(!state.tabs[0].desired_muted);
        assert!(state.tabs[0].media.as_ref().unwrap().can_mute());
        assert!(commit_media_read(&mut state, 1, &child, None, None, true));
        assert!(!state.tabs[0].media.as_ref().unwrap().can_mute());
        assert!(state.tabs[0].media.as_ref().unwrap().can_print);
    }
    #[test]
    fn normal_desired_mute_is_saved_old_sessions_default_false_and_private_state_is_excluded() {
        let mut state = TabState {
            tabs: vec![tab(1, false), tab(2, true)],
            active: 1,
            ..TabState::default()
        };
        state.tabs[0].desired_muted = true;
        state.tabs[1].url = "https://private.invalid/".into();
        state.tabs[1].desired_muted = true;
        let saved = snapshot_session(&state);
        assert_eq!(saved.tabs.len(), 1);
        assert!(saved.tabs[0].muted);
        let raw = serde_json::to_string(&saved).unwrap();
        assert!(!raw.contains("private.invalid"));
        assert!(decode_session(&raw).unwrap().tabs[0].muted);
        let old = r#"{"version":1,"active":0,"tabs":[{"url":"https://example.test/","title":"Fixture","pinned":false,"zoom":1.0}]}"#;
        assert!(!decode_session(old).unwrap().tabs[0].muted);
        for value in ["null", "\"true\"", "1"] {
            assert!(decode_session(
                &old.replace("\"zoom\":1.0", &format!("\"zoom\":1.0,\"muted\":{value}"))
            )
            .is_none());
        }
    }
    #[test]
    fn print_keypress_token_cannot_be_rebound_to_a_later_page_in_the_same_tab() {
        let state = TabState {
            tabs: vec![tab(1, false)],
            active: 1,
            ..TabState::default()
        };
        let keypress = target(&state.tabs[0], true);
        let current_token = media_print_context_token(&state.tabs[0], 7, 10).unwrap();
        assert_ne!(keypress.context_token, current_token);
        // Even a caller whose UI already refreshed to the new page cannot reuse the old event token.
        let mut delayed = target(&state.tabs[0], true);
        delayed.tab_epoch = 10;
        delayed.context_token = keypress.context_token;
        assert!(!media_target_current(&state, &delayed, true, true, 7, 10));
        delayed.context_token = current_token;
        assert!(media_target_current(&state, &delayed, true, true, 7, 10));
        assert!(valid_print_context_token(&delayed.context_token));
        for invalid in [
            "",
            "with space",
            "a\n",
            "a\0",
            "\u{007f}",
            "印刷",
            &"a".repeat(129),
        ] {
            assert!(!valid_print_context_token(invalid));
        }
        assert!(valid_print_context_token("!~"));
        assert!(valid_print_context_token(&"a".repeat(128)));
    }
    #[test]
    fn print_pending_guard_and_ctrl_p_are_purpose_limited() {
        let busy = AtomicBool::new(false);
        let lease = browser_print_lease(&busy).unwrap();
        assert!(browser_print_lease(&busy).is_err());
        drop(lease);
        assert!(browser_print_lease(&busy).is_ok());
        assert_eq!(
            accelerator_action(80, true, false, false),
            Some("print".into())
        );
        for (ctrl, shift, alt) in [
            (false, false, false),
            (true, true, false),
            (true, false, true),
        ] {
            assert_ne!(
                accelerator_action(80, ctrl, shift, alt),
                Some("print".into())
            );
        }
        let receipt = serde_json::to_value(BrowserPrintReceipt {
            tab_id: 1,
            dialog_shown: true,
        })
        .unwrap();
        assert_eq!(receipt, serde_json::json!({"tabId":1,"dialogShown":true}));
    }
}

#[cfg(test)]
mod stage25_private_accelerator_tests {
    use super::*;
    fn tab() -> Tab {
        Tab {id:1,label:"browser-tab-1".into(),url:"https://fixture.invalid/".into(),
            title:String::new(),loading:false,page_load:None,desired_muted:false,
            media:Some(BrowserMediaObservation::new()),pinned:false,zoom:1.0,can_back:false,can_forward:false,
            discarded:false,group:None,private:false,private_ready:false,hidden_since:None,favicon:None}
    }
    #[test]
    fn private_accelerator_is_only_ctrl_shift_n_and_never_normal_new() {
        assert_eq!(accelerator_action(78,true,true,false).as_deref(),Some("private-new"));
        for (ctrl,shift,alt) in [(false,true,false),(true,false,false),(false,false,false),(true,true,true)] {
            assert_eq!(accelerator_action(78,ctrl,shift,alt),None);
        }
        assert_eq!(accelerator_action(229,true,true,false),None);
        assert_eq!(accelerator_action(84,true,false,false).as_deref(),Some("new"));
        assert_eq!(accelerator_action(84,true,true,false).as_deref(),Some("restore"));
    }
    #[test]
    fn private_accelerator_rejects_missing_stale_child_epoch_repeat_ime_and_occlusion() {
        let mut state=TabState::default();state.tabs=vec![tab()];state.active=1;
        let child=state.tabs[0].media.as_ref().unwrap().child.clone();
        let valid=|state:&TabState,child:Option<&Arc<()>>,epoch,visible,occluded,repeat,ime|
            private_accelerator_current(state,1,child,7,epoch,visible,occluded,repeat,ime);
        assert!(valid(&state,Some(&child),7,true,false,false,false));
        assert!(!valid(&state,None,7,true,false,false,false));
        assert!(!valid(&state,Some(&Arc::new(())),7,true,false,false,false));
        for (epoch,visible,occluded,repeat,ime) in [(8,true,false,false,false),(7,false,false,false,false),
            (7,true,true,false,false),(7,true,false,true,false),(7,true,false,false,true)] {
            assert!(!valid(&state,Some(&child),epoch,visible,occluded,repeat,ime));
        }
        state.active=2;assert!(!valid(&state,Some(&child),7,true,false,false,false));state.active=1;
        state.tabs[0].discarded=true;assert!(!valid(&state,Some(&child),7,true,false,false,false));state.tabs[0].discarded=false;
        state.tabs[0].private=true;assert!(!valid(&state,Some(&child),7,true,false,false,false));state.tabs[0].private_ready=true;
        assert!(valid(&state,Some(&child),7,true,false,false,false));
        state.tabs[0].media=Some(BrowserMediaObservation::new());assert!(!valid(&state,Some(&child),7,true,false,false,false));
        state.tabs[0].media=None;assert!(!valid(&state,Some(&child),7,true,false,false,false));
    }
}

#[path = "browser_protection.rs"]
pub(crate) mod protection;
#[path = "browser_protection_preferences.rs"]
mod protection_preferences;
static PROTECTION_PREFERENCE: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
static PROTECTION_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub(crate) fn initialize_protection() -> Result<(), String> {
    PROTECTION_PREFERENCE.get_or_init(|| {
        let enabled = protection_preferences::read(&data_dir().ok_or("browser_protection_preferences_unavailable")?.join("browser-protection.json"))?;
        #[cfg(windows)] protection::initialize()?;
        protection::set_enabled(enabled);
        Ok(())
    }).clone()
}
pub(crate) fn protection_status() -> Result<serde_json::Value, String> {
    initialize_protection()?;
    serde_json::to_value(protection::status()).map_err(|_| "browser_protection_unavailable".into())
}
pub(crate) fn set_protection(enabled: bool) -> Result<serde_json::Value, String> {
    let _serial = PROTECTION_WRITE.lock().map_err(|_| "browser_protection_unavailable")?;
    initialize_protection()?;
    if !protection::status().supported { return Err("browser_protection_unsupported".into()); }
    protection_preferences::write(&data_dir().ok_or("browser_protection_preferences_unavailable")?.join("browser-protection.json"), enabled)?;
    serde_json::to_value(protection::set_enabled(enabled)).map_err(|_| "browser_protection_unavailable".into())
}

#[path = "browser_autoplay.rs"]
pub(crate) mod autoplay;
/// Holds the lock for the file; `true` once the file has been read successfully.
static AUTOPLAY_FILE: std::sync::Mutex<bool> = std::sync::Mutex::new(false);
fn autoplay_path() -> Result<std::path::PathBuf, String> {
    Ok(data_dir().ok_or("browser_autoplay_preferences_unavailable")?.join("browser-autoplay.json"))
}
/// Read the file until one read succeeds. Until then tabs use the default (block), so the feature
/// never silently turns off, and nothing may be written over a file that could not be read.
fn load_autoplay(loaded: &mut bool) -> Result<(), String> {
    if *loaded { return Ok(()); }
    let policy = autoplay_path().and_then(|path| autoplay::read(&path))?;
    autoplay::install(policy);
    *loaded = true;
    Ok(())
}
fn autoplay_policy() -> autoplay::Policy {
    if let Ok(mut loaded) = AUTOPLAY_FILE.lock() {
        if let Err(error) = load_autoplay(&mut loaded) { eprintln!("{error}"); }
    }
    autoplay::current()
}
pub(crate) fn autoplay_status() -> Result<serde_json::Value, String> {
    let mut loaded = AUTOPLAY_FILE.lock().map_err(|_| "browser_autoplay_unavailable")?;
    load_autoplay(&mut loaded)?;
    serde_json::to_value(autoplay::current()).map_err(|_| "browser_autoplay_unavailable".into())
}
/// Persist first, then re-register the script in every live tab. Pages already open keep their
/// current behaviour until they load again.
pub(crate) fn set_autoplay(app: &AppHandle, block: Option<bool>, site: Option<(String, bool)>) -> Result<serde_json::Value, String> {
    let policy = {
        let mut loaded = AUTOPLAY_FILE.lock().map_err(|_| "browser_autoplay_unavailable")?;
        load_autoplay(&mut loaded)?;
        let mut policy = autoplay::current();
        if let Some(block) = block { policy.block = block; }
        if let Some((site, allowed)) = site { policy = autoplay::with_site(&policy, &site, allowed)?; }
        autoplay::write(&autoplay_path()?, &policy)?;
        autoplay::install(policy.clone());
        policy
    };
    let labels = with_tabs(|state| state.tabs.iter().filter(|tab| !tab.discarded).map(|tab| tab.label.clone()).collect::<Vec<_>>()).unwrap_or_default();
    for label in labels { if let Some(view) = app.get_webview(&label) { apply_autoplay(&view); } }
    serde_json::to_value(policy).map_err(|_| "browser_autoplay_unavailable".into())
}

/// Register the current autoplay script for every future document of this tab, replacing the one
/// registered before. Runs on the UI thread; a reply that arrives after a newer registration is removed.
#[cfg(windows)]
fn apply_autoplay(view: &tauri::Webview) {
    use std::{cell::RefCell, collections::HashMap};
    use windows_core::HSTRING;
    thread_local! { static SCRIPTS: RefCell<HashMap<String, (u64, Option<String>)>> = RefCell::new(HashMap::new()); }
    let script = autoplay::document_script(&autoplay_policy());
    let label = view.label().to_owned();
    let _ = view.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        let (revision, previous) = SCRIPTS.with(|map| {
            let mut map = map.borrow_mut();
            let entry = map.entry(label.clone()).or_insert((0, None));
            entry.0 += 1;
            (entry.0, entry.1.take())
        });
        // A revived tab reuses its label on a new webview; removing an id it never had is harmless.
        if let Some(previous) = previous { let _ = core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(previous)); }
        let Some(script) = script else { return };
        let remover = core.clone();
        let reply = webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
            if result.is_err() { return Ok(()); }
            SCRIPTS.with(|map| match map.borrow_mut().get_mut(&label) {
                Some(entry) if entry.0 == revision => entry.1 = Some(id),
                _ => { let _ = remover.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id)); }
            });
            Ok(())
        }));
        let _ = core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &reply);
    });
}
#[cfg(not(windows))]
fn apply_autoplay(_view: &tauri::Webview) {}
#[cfg(test)]
mod protection_shortcut_tests {
    #[test] fn bookmark_bar_shortcut_keeps_other_modifiers_distinct() {
        assert_eq!(super::accelerator_action(66,true,true,false).as_deref(),Some("bookmarks-toggle"));
        for (ctrl,shift,alt) in [(false,true,false),(true,false,false),(true,true,true)] {
            assert_eq!(super::accelerator_action(66,ctrl,shift,alt),None);
        }
    }
}

#[path = "browser_download_history.rs"]
mod download_history;
fn close_download_history(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| { let _ = download_history::close_owned_history(); });
}
#[tauri::command]
pub async fn browser_download_history(app: AppHandle, webview: tauri::Webview, expected_tab_id: u64) -> Result<serde_json::Value, String> {
    download_history::change(app, webview, expected_tab_id, true).await
}
#[tauri::command]
pub async fn browser_download_history_close(app: AppHandle, webview: tauri::Webview, expected_tab_id: u64) -> Result<serde_json::Value, String> {
    download_history::change(app, webview, expected_tab_id, false).await
}

fn close_download_history_if_stale(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| { let _ = download_history::close_if_stale(); });
}

#[cfg(test)]
mod session_close_tests {
    use super::*;
    use std::cell::RefCell;
    fn tab(id: u64, private: bool, url: &str) -> Tab {
        Tab {id,label:format!("browser-tab-{id}"),url:url.into(),discarded:false,title:"Fixture".into(),loading:false,page_load:None,desired_muted:false,media:None,pinned:false,zoom:1.0,can_back:false,can_forward:false,group:None,private,private_ready:private,hidden_since:None,favicon:None}
    }
    fn previous() -> Option<SavedSession> {
        Some(snapshot_session(&TabState {tabs:vec![tab(1,false,"https://previous.invalid/")],active:1,..TabState::default()}))
    }
    #[test]
    fn normal_close_saves_only_public_tabs_and_rebases_the_active_index() {
        let tabs = Mutex::new(Some(TabState {tabs:vec![tab(1,true,"https://private.invalid/"),tab(2,false,"https://public.invalid/a"),tab(3,false,"https://public.invalid/b")],active:3,..TabState::default()}));
        let written = RefCell::new(Vec::new());
        save_session_on_close_to(&tabs,&Mutex::new(previous()),&Mutex::new(()),|raw| {written.replace(raw.to_vec());Ok(())}).unwrap();
        let raw = written.borrow();let saved = decode_session(std::str::from_utf8(&raw).unwrap()).unwrap();
        assert_eq!(saved.tabs.len(),2);assert_eq!(saved.active,1);assert_eq!(saved.tabs[0].url,"https://public.invalid/a");
        assert!(!std::str::from_utf8(&raw).unwrap().contains("private.invalid"));
    }
    #[test]
    fn no_browser_and_fresh_blank_preserve_the_previous_session_without_writing() {
        for state in [None,Some(TabState {tabs:vec![tab(1,false,"")],active:1,..TabState::default()})] {
            let previous = Mutex::new(previous());
            save_session_on_close_to(&Mutex::new(state),&previous,&Mutex::new(()),|_| panic!("Previous session must not be overwritten")).unwrap();
            assert_eq!(previous.lock().unwrap().as_ref().unwrap().tabs[0].url,"https://previous.invalid/");
        }
        save_session_on_close_to(&Mutex::new(None),&Mutex::new(None),&Mutex::new(()),|_| panic!("Uninitialized browser must not write")).unwrap();
    }
    #[test]
    fn initialized_empty_and_private_only_sessions_do_not_revive_removed_public_work() {
        for state in [TabState::default(),TabState {tabs:vec![tab(1,true,"https://private.invalid/")],active:1,..TabState::default()}] {
            let written=RefCell::new(Vec::new());
            save_session_on_close_to(&Mutex::new(Some(state)),&Mutex::new(previous()),&Mutex::new(()),|raw| {written.replace(raw.to_vec());Ok(())}).unwrap();
            let raw=written.borrow();let saved:SavedSession=serde_json::from_slice(&raw).unwrap();assert!(saved.tabs.is_empty());
            assert!(decode_session(std::str::from_utf8(&raw).unwrap()).is_none());assert!(!std::str::from_utf8(&raw).unwrap().contains("private.invalid"));
        }
    }
    #[test]
    fn an_initial_public_blank_without_a_previous_session_keeps_the_existing_format() {
        let tabs=Mutex::new(Some(TabState {tabs:vec![tab(1,false,"")],active:1,..TabState::default()}));
        save_session_on_close_to(&tabs,&Mutex::new(None),&Mutex::new(()),|raw| {let saved=decode_session(std::str::from_utf8(raw).unwrap()).unwrap();assert_eq!(saved.tabs.len(),1);assert!(saved.tabs[0].url.is_empty());Ok(())}).unwrap();
    }
    #[test]
    fn write_and_poisoned_state_fail_instead_of_authorizing_exit() {
        fn poison<T>(lock: &Mutex<T>) {let _=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {let _guard=lock.lock().unwrap();panic!("Injected poison");}));}
        let tabs=Mutex::new(Some(TabState {tabs:vec![tab(1,false,"https://public.invalid/")],active:1,..TabState::default()}));
        assert_eq!(save_session_on_close_to(&tabs,&Mutex::new(None),&Mutex::new(()),|_| Err("session_write_failed".into())).unwrap_err(),"session_write_failed");
        poison(&tabs);assert_eq!(save_session_on_close_to(&tabs,&Mutex::new(None),&Mutex::new(()),|_| panic!("Poisoned state must not write")).unwrap_err(),"session_unavailable");
        let previous=Mutex::new(previous());poison(&previous);assert_eq!(save_session_on_close_to(&Mutex::new(None),&previous,&Mutex::new(()),|_| panic!("Poisoned previous session must not write")).unwrap_err(),"session_unavailable");
        let serial=Mutex::new(());poison(&serial);assert_eq!(save_session_on_close_to(&Mutex::new(None),&Mutex::new(None),&serial,|_| panic!("Poisoned storage must not write")).unwrap_err(),"session_unavailable");
    }
}

#[cfg(test)]
mod favicon_tests {
    use super::*;

    fn icon(tag: u8) -> String {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.push(tag);
        crate::browser_favicon::png_data_url(&bytes).unwrap()
    }
    fn tab(id: u64, private: bool, url: &str) -> Tab {
        Tab { id, label: format!("browser-tab-{id}"), url: url.into(), discarded: false, title: "t".into(), loading: false, page_load: None, desired_muted: false, media: None, pinned: false, zoom: 1.0, can_back: false, can_forward: false, group: None, private, private_ready: private, hidden_since: None, favicon: None }
    }
    fn info(favicon: Option<String>) -> serde_json::Value {
        serde_json::to_value(TabInfo { id: 1, url: "https://example.org/".into(), active: true, discarded: false, title: "t".into(), loading: false, pinned: false, zoom: 1.0, can_back: false, can_forward: false, group: None, r#private: false, muted: None, playing_audio: None, can_mute: false, can_print: false, print_context_token: None, favicon }).unwrap()
    }

    #[test]
    fn dto_carries_favicon_only_when_present() {
        assert!(info(None).get("favicon").is_none());
        let url = icon(1);
        assert_eq!(info(Some(url.clone()))["favicon"], serde_json::Value::String(url));
    }

    #[test]
    fn origin_ignores_path_and_rejects_opaque_urls() {
        assert_eq!(origin_of("https://example.org/a?x#y"), origin_of("https://example.org:443/b"));
        assert_ne!(origin_of("https://example.org/"), origin_of("http://example.org/"));
        assert_ne!(origin_of("https://example.org/"), origin_of("https://other.example/"));
        assert_eq!(origin_of(""), None);
        assert_eq!(origin_of("data:text/plain,x"), None);
    }

    #[test]
    fn icon_applies_only_to_the_page_it_was_requested_for() {
        let mut state = TabState { tabs: vec![tab(1, false, "https://example.org/a"), tab(2, true, "https://private.example/")], ..Default::default() };
        let origin = origin_of("https://example.org/a");
        assert_eq!(apply_favicon(&mut state, 1, origin.clone(), Some(icon(1))), Some(Some("https://example.org/a".into())));
        assert_eq!(state.tabs[0].favicon, Some(icon(1)));
        assert_eq!(apply_favicon(&mut state, 1, origin.clone(), Some(icon(1))), None, "unchanged icon is not re-announced");
        // A reply that arrives after the tab moved to another origin is dropped.
        state.tabs[0].url = "https://elsewhere.example/".into();
        assert_eq!(apply_favicon(&mut state, 1, origin, Some(icon(2))), None);
        assert_eq!(state.tabs[0].favicon, Some(icon(1)));
        // An icon for a page with no origin (new-tab page) is refused; clearing is allowed.
        state.tabs[0].url.clear();
        assert_eq!(apply_favicon(&mut state, 1, None, Some(icon(3))), None);
        assert_eq!(apply_favicon(&mut state, 1, None, None), Some(None));
        assert_eq!(state.tabs[0].favicon, None);
        // Private tabs keep the icon in memory but are never offered for bookmark persistence.
        assert_eq!(apply_favicon(&mut state, 2, origin_of("https://private.example/"), Some(icon(4))), Some(None));
        assert_eq!(state.tabs[1].favicon, Some(icon(4)));
        assert_eq!(apply_favicon(&mut state, 9, None, None), None);
    }
}

#[cfg(test)]
mod browser_convention_tests {
    use super::*;
    fn tab(id: u64, private: bool, url: &str) -> Tab {
        Tab { id, label: format!("browser-tab-{id}"), url: url.into(), discarded: false, title: "t".into(), loading: false, page_load: None, desired_muted: false, media: None, pinned: false, zoom: 1.0, can_back: false, can_forward: false, group: None, private, private_ready: private, hidden_since: None, favicon: None }
    }

    #[test]
    fn chrome_keys_map_to_the_same_actions() {
        assert_eq!(accelerator_action(68, false, false, true).as_deref(), Some("address"));
        assert_eq!(accelerator_action(117, false, false, false).as_deref(), Some("address"));
        assert_eq!(accelerator_action(117, true, false, false), None);
        assert_eq!(accelerator_action(116, false, false, false).as_deref(), Some("reload"));
        assert_eq!(accelerator_action(116, true, false, false).as_deref(), Some("hard-reload"));
        assert_eq!(accelerator_action(82, true, true, false).as_deref(), Some("hard-reload"));
        assert_eq!(accelerator_action(82, true, false, false).as_deref(), Some("reload"));
        assert_eq!(accelerator_action(33, true, false, false).as_deref(), Some("previous"));
        assert_eq!(accelerator_action(34, true, false, false).as_deref(), Some("next"));
        assert_eq!(accelerator_action(33, false, false, false), None);
        assert_eq!(accelerator_action(68, true, false, false).as_deref(), Some("favorite"));
        assert_eq!(accelerator_action(68, true, true, false), None);
        assert_eq!(accelerator_action(57, true, false, false).as_deref(), Some("tab-9"));
        // Backspace は戻るにしない。
        assert_eq!(accelerator_action(8, false, false, false), None);
        assert_eq!(accelerator_action(8, false, false, true), None);
    }

    #[test]
    fn escape_stops_only_a_loading_page_without_modifiers() {
        assert!(escape_stops_loading(27, false, false, false, true));
        assert!(!escape_stops_loading(27, false, false, false, false));
        assert!(!escape_stops_loading(27, true, false, false, true));
        assert!(!escape_stops_loading(27, false, true, false, true));
        assert!(!escape_stops_loading(13, false, false, false, true));
    }

    #[test]
    fn page_links_follow_chrome_foreground_rules() {
        assert!(link_opens_in_foreground(false, false, false));
        assert!(!link_opens_in_foreground(false, true, false));
        assert!(!link_opens_in_foreground(false, false, true));
        assert!(link_opens_in_foreground(true, true, false));
        assert!(link_opens_in_foreground(true, false, true));
    }

    #[test]
    fn native_zoom_is_copied_once_and_private_urls_are_not_remembered() {
        let mut state = TabState { tabs: vec![tab(1, false, "https://a.example/"), tab(2, true, "https://b.example/")], active: 1, ..TabState::default() };
        assert_eq!(zoom_apply(&mut state, 1, 1.25), Some(Some("https://a.example/".into())));
        assert_eq!(state.tabs[0].zoom, 1.25);
        assert_eq!(zoom_apply(&mut state, 1, 1.25), None);
        assert_eq!(zoom_apply(&mut state, 2, 1.5), Some(None));
        assert_eq!(zoom_apply(&mut state, 1, 0.25), None);
        assert_eq!(zoom_apply(&mut state, 1, f64::NAN), None);
        assert_eq!(zoom_apply(&mut state, 9, 1.1), None);
        assert_eq!(state.tabs[0].zoom, 1.25);
    }
}
