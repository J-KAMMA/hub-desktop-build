//! ゲーム窓を Hub の中央の領域に重ねる（2026-11-06）。右のレールは隠さない。
//! 使う Win32 は窓の位置・大きさ・最小化・前面化だけ（SetWindowPos / ShowWindow）。SetParent・注入・入力フックは使わない。
//! 動かす窓は、利用者が起動または選んだゲームの、導入先フォルダ配下の実行ファイルが持つ窓だけ。
//! 計算と追従は `WindowApi` の裏で動くので、偽の窓で試せる。

use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect { pub x: i32, pub y: i32, pub w: i32, pub h: i32 }

/// 窓の外枠と見える枠の差（Windows 10 以降の透明な拡大縁）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Insets { pub l: i32, pub t: i32, pub r: i32, pub b: i32 }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WinInfo {
    pub hwnd: u64,
    pub pid: u32,
    pub exe: String,
    pub rect: Rect,
    pub insets: Insets,
    pub minimized: bool,
    pub maximized: bool,
}

impl WinInfo {
    /// 見える枠（外枠から透明な縁を引いたもの）。
    pub fn visible(&self) -> Rect {
        Rect { x: self.rect.x + self.insets.l, y: self.rect.y + self.insets.t, w: self.rect.w - self.insets.l - self.insets.r, h: self.rect.h - self.insets.t - self.insets.b }
    }
}

pub trait WindowApi {
    /// 見えている最上位窓（所有されていない・道具窓でない）。
    fn windows(&self) -> Vec<WinInfo>;
    fn info(&self, hwnd: u64) -> Option<WinInfo>;
    fn set_rect(&self, hwnd: u64, rect: Rect) -> bool;
    fn set_maximized(&self, hwnd: u64, maximized: bool);
    fn set_minimized(&self, hwnd: u64, minimized: bool);
    /// 活性化せず、他の窓の上へ。
    fn raise(&self, hwnd: u64);
    fn foreground(&self) -> Option<u64>;
    /// OS が「全画面専用（D3D）で動作中」と答えているか。
    fn exclusive_fullscreen(&self) -> bool;
    fn own_pid(&self) -> u32;
}

/// 画面が送る中央の領域。ウェブ画面の左上を原点とする CSS 画素。
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
pub struct CssRect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HubView {
    pub hwnd: u64,
    /// Hub 窓の描画領域の左上（画面の物理画素）。
    pub client_origin: (i32, i32),
    /// CSS 画素 → 物理画素の倍率（devicePixelRatio。拡大率の設定を含む）。
    pub dpr: f64,
    pub content: CssRect,
    pub minimized: bool,
}

/// 中央の領域の画面上の物理画素。端を丸めてから幅を引くので、隙間も重なりも出ない。
pub fn target_rect(view: &HubView) -> Rect {
    let dpr = if view.dpr.is_finite() && view.dpr > 0.0 { view.dpr } else { 1.0 };
    let left = (view.content.x * dpr).round() as i32;
    let top = (view.content.y * dpr).round() as i32;
    let right = ((view.content.x + view.content.w) * dpr).round() as i32;
    let bottom = ((view.content.y + view.content.h) * dpr).round() as i32;
    Rect { x: view.client_origin.0 + left, y: view.client_origin.1 + top, w: (right - left).max(1), h: (bottom - top).max(1) }
}

/// 見える枠が target に一致するための外枠。
pub fn outer_for(target: Rect, insets: Insets) -> Rect {
    Rect { x: target.x - insets.l, y: target.y - insets.t, w: target.w + insets.l + insets.r, h: target.h + insets.t + insets.b }
}

const TOLERANCE: i32 = 2;

fn close_enough(a: Rect, b: Rect) -> bool {
    (a.x - b.x).abs() <= TOLERANCE && (a.y - b.y).abs() <= TOLERANCE && (a.w - b.w).abs() <= TOLERANCE && (a.h - b.h).abs() <= TOLERANCE
}

fn normalize(path: &str) -> String {
    let mut text = path.replace('/', "\\").to_lowercase();
    if let Some(rest) = text.strip_prefix("\\\\?\\") { text = rest.to_owned(); }
    text.trim_end_matches('\\').to_owned()
}

/// exe が dir の中にあるか（区切りを境に比べる。"game" は "game2" を含まない）。
pub fn path_under(dir: &str, exe: &str) -> bool {
    let dir = normalize(dir);
    if dir.is_empty() { return false; }
    normalize(exe).strip_prefix(&dir).is_some_and(|rest| rest.starts_with('\\'))
}

const MIN_W: i32 = 200;
const MIN_H: i32 = 150;

/// 導入先フォルダ配下の実行ファイルが持つ窓のうち、いちばん大きいもの。Hub 自身の窓は選ばない。
pub fn pick_window(windows: &[WinInfo], install_dir: &str, own_pid: u32) -> Option<WinInfo> {
    windows.iter()
        .filter(|w| w.pid != own_pid && !w.minimized && path_under(install_dir, &w.exe) && w.rect.w >= MIN_W && w.rect.h >= MIN_H)
        .max_by_key(|w| i64::from(w.rect.w) * i64::from(w.rect.h))
        .cloned()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Note {
    /// 窓が見つからないまま時間切れ。
    Timeout,
    /// 全画面専用のため並べられない。
    Exclusive,
    /// 窓が大きさを受け付けない。
    Refused,
    /// 窓が閉じた。
    Gone,
    /// Hub の窓が閉じた。
    HubClosed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome { Searching, Docked, Stopped(Note) }

struct Attached { hwnd: u64, original: Rect, was_maximized: bool, minimized_by_us: bool }

pub struct Dock {
    install_dir: String,
    timeout: Duration,
    attached: Option<Attached>,
    finished: bool,
}

impl Dock {
    pub fn new(install_dir: String, timeout: Duration) -> Self { Dock { install_dir, timeout, attached: None, finished: false } }

    /// 一歩進める。elapsed は dock を始めてからの時間（窓を探す期限に使う）。
    pub fn step(&mut self, api: &dyn WindowApi, view: &HubView, elapsed: Duration) -> Outcome {
        if self.finished { return Outcome::Stopped(Note::Gone); }
        let outcome = if self.attached.is_some() { self.follow(api, view) } else { self.search(api, view, elapsed) };
        if matches!(outcome, Outcome::Stopped(_)) { self.finished = true; }
        outcome
    }

    fn search(&mut self, api: &dyn WindowApi, view: &HubView, elapsed: Duration) -> Outcome {
        if let Some(found) = pick_window(&api.windows(), &self.install_dir, api.own_pid()) {
            if !view.minimized {
                self.attached = Some(Attached { hwnd: found.hwnd, original: found.rect, was_maximized: found.maximized, minimized_by_us: false });
                if found.maximized { api.set_maximized(found.hwnd, false); }
                return self.apply(api, view);
            }
        }
        if elapsed >= self.timeout { Outcome::Stopped(Note::Timeout) } else { Outcome::Searching }
    }

    fn follow(&mut self, api: &dyn WindowApi, view: &HubView) -> Outcome {
        let hwnd = self.attached.as_ref().map(|a| a.hwnd).unwrap_or_default();
        let Some(info) = api.info(hwnd) else { self.attached = None; return Outcome::Stopped(Note::Gone) };
        if view.minimized {
            if !info.minimized {
                api.set_minimized(hwnd, true);
                if let Some(a) = self.attached.as_mut() { a.minimized_by_us = true; }
            }
            return Outcome::Docked;
        }
        let by_us = self.attached.as_ref().is_some_and(|a| a.minimized_by_us);
        if info.minimized {
            if !by_us { return Outcome::Docked; } // 利用者が自分で最小化した窓には触らない
            api.set_minimized(hwnd, false);
        }
        if let Some(a) = self.attached.as_mut() { a.minimized_by_us = false; }
        let fresh = api.info(hwnd).unwrap_or(info);
        let want = outer_for(target_rect(view), fresh.insets);
        if fresh.rect != want { return self.apply(api, view); }
        if api.foreground() == Some(view.hwnd) { api.raise(hwnd); }
        Outcome::Docked
    }

    fn apply(&mut self, api: &dyn WindowApi, view: &HubView) -> Outcome {
        let Some(hwnd) = self.attached.as_ref().map(|a| a.hwnd) else { return Outcome::Stopped(Note::Gone) };
        let Some(before) = api.info(hwnd) else { self.attached = None; return Outcome::Stopped(Note::Gone) };
        let target = target_rect(view);
        let accepted = api.set_rect(hwnd, outer_for(target, before.insets));
        let after = api.info(hwnd);
        let landed = accepted && after.as_ref().is_some_and(|w| close_enough(w.visible(), target));
        if !landed {
            let note = if api.exclusive_fullscreen() { Note::Exclusive } else { Note::Refused };
            self.restore(api);
            return Outcome::Stopped(note);
        }
        api.raise(hwnd);
        Outcome::Docked
    }

    /// 元の位置と大きさへ戻す。窓がもう無ければ何もしない。
    pub fn restore(&mut self, api: &dyn WindowApi) {
        let Some(a) = self.attached.take() else { return };
        if api.info(a.hwnd).is_none() { return; }
        if a.minimized_by_us { api.set_minimized(a.hwnd, false); }
        api.set_rect(a.hwnd, a.original);
        if a.was_maximized { api.set_maximized(a.hwnd, true); }
    }

    pub fn stop(&mut self, api: &dyn WindowApi) { self.restore(api); self.finished = true; }
}

// ---------- 実装（Windows） ----------

#[cfg(windows)]
mod win32 {
    use super::{Insets, Rect, WinInfo, WindowApi};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT},
        Graphics::Dwm::DwmGetWindowAttribute,
        System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
        UI::{Shell::SHQueryUserNotificationState, WindowsAndMessaging::*},
    };

    pub struct Win32Api;

    fn h(hwnd: u64) -> HWND { hwnd as usize as HWND }
    fn id(hwnd: HWND) -> u64 { hwnd as usize as u64 }

    fn exe_of(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() { return None; }
            let mut buffer = vec![0u16; 1024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size);
            CloseHandle(process);
            (ok != 0).then(|| String::from_utf16_lossy(&buffer[..size as usize]))
        }
    }

    fn describe(hwnd: HWND) -> Option<WinInfo> {
        unsafe {
            if IsWindow(hwnd) == 0 { return None; }
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rect) == 0 { return None; }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let mut frame: RECT = std::mem::zeroed();
            let framed = DwmGetWindowAttribute(hwnd, 9, (&mut frame as *mut RECT).cast(), std::mem::size_of::<RECT>() as u32) == 0;
            let insets = if framed {
                Insets { l: (frame.left - rect.left).max(0), t: (frame.top - rect.top).max(0), r: (rect.right - frame.right).max(0), b: (rect.bottom - frame.bottom).max(0) }
            } else { Insets::default() };
            Some(WinInfo {
                hwnd: id(hwnd), pid, exe: exe_of(pid).unwrap_or_default(),
                rect: Rect { x: rect.left, y: rect.top, w: rect.right - rect.left, h: rect.bottom - rect.top },
                insets, minimized: IsIconic(hwnd) != 0, maximized: IsZoomed(hwnd) != 0,
            })
        }
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam as *mut Vec<HWND>);
        if IsWindowVisible(hwnd) != 0 && GetWindow(hwnd, GW_OWNER).is_null() && (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW) == 0 {
            list.push(hwnd);
        }
        1
    }

    impl WindowApi for Win32Api {
        fn windows(&self) -> Vec<WinInfo> {
            let mut handles: Vec<HWND> = Vec::new();
            unsafe { EnumWindows(Some(collect), (&mut handles as *mut Vec<HWND>) as LPARAM); }
            handles.into_iter().filter_map(describe).filter(|w| !w.exe.is_empty()).collect()
        }
        fn info(&self, hwnd: u64) -> Option<WinInfo> { describe(h(hwnd)) }
        fn set_rect(&self, hwnd: u64, r: Rect) -> bool {
            unsafe { SetWindowPos(h(hwnd), std::ptr::null_mut(), r.x, r.y, r.w, r.h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER) != 0 }
        }
        fn set_maximized(&self, hwnd: u64, maximized: bool) {
            unsafe { ShowWindow(h(hwnd), if maximized { SW_MAXIMIZE } else { SW_RESTORE }); }
        }
        fn set_minimized(&self, hwnd: u64, minimized: bool) {
            unsafe { ShowWindow(h(hwnd), if minimized { SW_SHOWMINNOACTIVE } else { SW_RESTORE }); }
        }
        fn raise(&self, hwnd: u64) {
            unsafe { SetWindowPos(h(hwnd), HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); }
        }
        fn foreground(&self) -> Option<u64> {
            let top = unsafe { GetForegroundWindow() };
            (!top.is_null()).then(|| id(top))
        }
        fn exclusive_fullscreen(&self) -> bool {
            let mut state = 0;
            unsafe { SHQueryUserNotificationState(&mut state) == 0 && state == 3 } // QUNS_RUNNING_D3D_FULL_SCREEN
        }
        fn own_pid(&self) -> u32 { std::process::id() }
    }
}

// ---------- Tauri ----------

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

const SEARCH_TIMEOUT: Duration = Duration::from_secs(45);

struct Session { rect: CssRect, dpr: f64, stop: Arc<AtomicBool> }

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn valid_rect(r: &CssRect, dpr: f64) -> bool {
    [r.x, r.y, r.w, r.h, dpr].iter().all(|v| v.is_finite()) && r.w >= 1.0 && r.h >= 1.0 && r.x.abs() < 100_000.0 && r.y.abs() < 100_000.0 && r.w < 100_000.0 && r.h < 100_000.0 && dpr > 0.25 && dpr <= 8.0
}

#[cfg(windows)]
fn hub_view(app: &tauri::AppHandle, rect: CssRect, dpr: f64) -> Option<HubView> {
    use tauri::Manager;
    let window = app.get_webview_window("main")?;
    let origin = window.inner_position().ok()?;
    let hwnd = window.hwnd().ok()?.0 as usize as u64;
    Some(HubView { hwnd, client_origin: (origin.x, origin.y), dpr, content: rect, minimized: window.is_minimized().unwrap_or(false) })
}

#[cfg(windows)]
fn emit(app: &tauri::AppHandle, state: &str, note: Option<Note>) {
    use tauri::Emitter;
    let _ = app.emit("pc-game-dock", serde_json::json!({ "state": state, "note": note }));
}

#[cfg(windows)]
fn run(app: tauri::AppHandle, install_dir: String, stop: Arc<AtomicBool>) {
    let api = win32::Win32Api;
    let mut dock = Dock::new(install_dir, SEARCH_TIMEOUT);
    let started = std::time::Instant::now();
    let mut last: Option<Outcome> = None;
    emit(&app, "searching", None);
    loop {
        if stop.load(Ordering::SeqCst) { dock.stop(&api); emit(&app, "stopped", None); return; }
        let (rect, dpr) = match SESSION.lock().ok().and_then(|g| g.as_ref().map(|s| (s.rect, s.dpr))) { Some(v) => v, None => { dock.stop(&api); return; } };
        let Some(view) = hub_view(&app, rect, dpr) else { dock.stop(&api); emit(&app, "stopped", Some(Note::HubClosed)); return; };
        let outcome = dock.step(&api, &view, started.elapsed());
        if last != Some(outcome) {
            last = Some(outcome);
            match outcome {
                Outcome::Searching => {}
                Outcome::Docked => emit(&app, "docked", None),
                Outcome::Stopped(note) => { emit(&app, "stopped", Some(note)); if let Ok(mut g) = SESSION.lock() { if g.as_ref().is_some_and(|s| Arc::ptr_eq(&s.stop, &stop)) { *g = None; } } return; }
            }
        }
        std::thread::sleep(Duration::from_millis(if matches!(outcome, Outcome::Docked) { 100 } else { 400 }));
    }
}

fn end_session() {
    if let Ok(mut g) = SESSION.lock() { if let Some(s) = g.take() { s.stop.store(true, Ordering::SeqCst); } }
}

/// 起動（任意）してから、そのゲームの窓を探して中央の領域へ重ねる。
#[tauri::command]
pub async fn game_dock_start(app: tauri::AppHandle, id: String, rect: CssRect, dpr: f64, launch: bool) -> Result<(), String> {
    if !valid_rect(&rect, dpr) { return Err("invalid_rect".into()); }
    #[cfg(not(windows))]
    { let _ = (&app, &id, launch); Err("unsupported".to_owned()) }
    #[cfg(windows)]
    {
        let roots = crate::pc_games::system_roots();
        let game = tokio::task::spawn_blocking(move || crate::pc_games::find(&roots, &id)).await.map_err(|_| "scan_failed".to_owned())?.ok_or_else(|| "game_not_found".to_owned())?;
        if launch {
            let url = crate::pc_games::launch_url(&game).ok_or_else(|| "invalid_launch_url".to_owned())?;
            crate::pc_games::open_protocol(&url)?;
        }
        end_session();
        let stop = Arc::new(AtomicBool::new(false));
        *SESSION.lock().map_err(|_| "busy".to_owned())? = Some(Session { rect, dpr, stop: stop.clone() });
        let dir = game.install_dir.to_string_lossy().into_owned();
        std::thread::Builder::new().name("game-dock".into()).spawn(move || run(app, dir, stop)).map_err(|_| "spawn_failed".to_owned())?;
        Ok(())
    }
}

/// 中央の領域が変わったときに画面が送る。
#[tauri::command]
pub fn game_dock_rect(rect: CssRect, dpr: f64) -> Result<(), String> {
    if !valid_rect(&rect, dpr) { return Err("invalid_rect".into()); }
    if let Ok(mut g) = SESSION.lock() { if let Some(s) = g.as_mut() { s.rect = rect; s.dpr = dpr; } }
    Ok(())
}

/// 並べるのをやめて、窓を元の位置へ戻す。
#[tauri::command]
pub fn game_dock_stop() { end_session(); }

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        windows: RefCell<Vec<WinInfo>>,
        foreground: RefCell<Option<u64>>,
        exclusive: RefCell<bool>,
        /// 窓が受け付ける最小の幅（大きさを拒む窓を作る）。
        min_width: i32,
        refuse_move: bool,
        log: RefCell<Vec<String>>,
    }

    impl Fake {
        fn new(windows: Vec<WinInfo>) -> Self {
            Fake { windows: RefCell::new(windows), foreground: RefCell::new(None), exclusive: RefCell::new(false), min_width: 0, refuse_move: false, log: RefCell::new(vec![]) }
        }
        fn rect_of(&self, hwnd: u64) -> Rect { self.windows.borrow().iter().find(|w| w.hwnd == hwnd).unwrap().rect }
        fn logged(&self, text: &str) -> usize { self.log.borrow().iter().filter(|l| l.starts_with(text)).count() }
    }

    impl WindowApi for Fake {
        fn windows(&self) -> Vec<WinInfo> { self.windows.borrow().clone() }
        fn info(&self, hwnd: u64) -> Option<WinInfo> { self.windows.borrow().iter().find(|w| w.hwnd == hwnd).cloned() }
        fn set_rect(&self, hwnd: u64, rect: Rect) -> bool {
            self.log.borrow_mut().push(format!("set_rect {hwnd}"));
            if self.refuse_move { return false; }
            let mut list = self.windows.borrow_mut();
            let Some(w) = list.iter_mut().find(|w| w.hwnd == hwnd) else { return false };
            let mut rect = rect;
            if rect.w < self.min_width { rect.w = self.min_width; }
            w.rect = rect;
            true
        }
        fn set_maximized(&self, hwnd: u64, maximized: bool) {
            self.log.borrow_mut().push(format!("maximize {hwnd} {maximized}"));
            if let Some(w) = self.windows.borrow_mut().iter_mut().find(|w| w.hwnd == hwnd) { w.maximized = maximized; }
        }
        fn set_minimized(&self, hwnd: u64, minimized: bool) {
            self.log.borrow_mut().push(format!("minimize {hwnd} {minimized}"));
            if let Some(w) = self.windows.borrow_mut().iter_mut().find(|w| w.hwnd == hwnd) { w.minimized = minimized; }
        }
        fn raise(&self, hwnd: u64) { self.log.borrow_mut().push(format!("raise {hwnd}")); }
        fn foreground(&self) -> Option<u64> { *self.foreground.borrow() }
        fn exclusive_fullscreen(&self) -> bool { *self.exclusive.borrow() }
        fn own_pid(&self) -> u32 { 1 }
    }

    const GAME_DIR: &str = r"X:\Fixture\Steam\steamapps\common\Fixture Quest";
    const HUB: u64 = 10;
    const GAME: u64 = 20;

    fn game_window(rect: Rect) -> WinInfo {
        WinInfo { hwnd: GAME, pid: 500, exe: format!(r"{GAME_DIR}\quest.exe"), rect, insets: Insets::default(), minimized: false, maximized: false }
    }
    fn view(origin: (i32, i32), dpr: f64, content: CssRect, minimized: bool) -> HubView {
        HubView { hwnd: HUB, client_origin: origin, dpr, content, minimized }
    }
    fn css(x: f64, y: f64, w: f64, h: f64) -> CssRect { CssRect { x, y, w, h } }
    const NOW: Duration = Duration::ZERO;

    #[test]
    fn target_rect_accounts_for_origin_and_dpi() {
        let v = view((100, 50), 1.0, css(60.0, 40.0, 800.0, 600.0), false);
        assert_eq!(target_rect(&v), Rect { x: 160, y: 90, w: 800, h: 600 });
        // 150%：論理 1280x800 の画面。中央領域の端を物理画素に直す。
        let v = view((-1920, 30), 1.5, css(60.0, 40.0, 801.0, 601.0), false);
        assert_eq!(target_rect(&v), Rect { x: -1920 + 90, y: 30 + 60, w: 1202, h: 902 }); // 右端 (861*1.5=1291.5→1292)、左端 90
        // 隣の領域との隙間・重なりが出ない：右端は (x+w)*dpr を丸める
        let a = target_rect(&view((0, 0), 1.25, css(10.3, 0.0, 100.3, 10.0), false));
        assert_eq!(a.x + a.w, ((10.3 + 100.3) * 1.25_f64).round() as i32);
        // 異常な倍率は 1 とみなす。0 幅にもしない
        assert_eq!(target_rect(&view((0, 0), f64::NAN, css(0.0, 0.0, 10.0, 10.0), false)).w, 10);
        assert_eq!(target_rect(&view((0, 0), 2.0, css(0.0, 0.0, 0.1, 0.1), false)).w, 1);
    }

    #[test]
    fn outer_rect_compensates_invisible_borders() {
        let target = Rect { x: 100, y: 100, w: 800, h: 600 };
        let insets = Insets { l: 7, t: 0, r: 7, b: 7 };
        let outer = outer_for(target, insets);
        assert_eq!(outer, Rect { x: 93, y: 100, w: 814, h: 607 });
        let w = WinInfo { rect: outer, insets, ..game_window(outer) };
        assert_eq!(w.visible(), target);
    }

    #[test]
    fn path_under_respects_boundaries_and_case() {
        assert!(path_under(GAME_DIR, &format!(r"{GAME_DIR}\bin\quest.exe")));
        assert!(path_under(r"X:/Fixture/Steam/steamapps/common/Fixture Quest/", r"x:\fixture\steam\steamapps\common\fixture quest\Quest.EXE"));
        assert!(path_under(GAME_DIR, &format!(r"\\?\{GAME_DIR}\q.exe")));
        assert!(!path_under(GAME_DIR, &format!(r"{GAME_DIR} 2\q.exe")));
        assert!(!path_under(GAME_DIR, GAME_DIR));
        assert!(!path_under("", r"X:\a.exe"));
        assert!(!path_under(GAME_DIR, r"X:\Other\q.exe"));
    }

    #[test]
    fn pick_window_only_the_games_own_biggest_window() {
        let rect = |w, h| Rect { x: 0, y: 0, w, h };
        let mk = |hwnd, pid, exe: &str, r| WinInfo { hwnd, pid, exe: exe.to_owned(), rect: r, insets: Insets::default(), minimized: false, maximized: false };
        let list = vec![
            mk(1, 1, &format!(r"{GAME_DIR}\hub.exe"), rect(900, 900)),      // 自分の pid
            mk(2, 5, r"X:\Elsewhere\browser.exe", rect(1900, 1000)),         // 別のプロセス
            mk(3, 6, &format!(r"{GAME_DIR}\splash.exe"), rect(300, 200)),
            mk(4, 7, &format!(r"{GAME_DIR}\quest.exe"), rect(1280, 720)),
            mk(5, 8, &format!(r"{GAME_DIR}\tiny.exe"), rect(100, 100)),      // 小さすぎる
            WinInfo { minimized: true, ..mk(6, 9, &format!(r"{GAME_DIR}\min.exe"), rect(1600, 900)) },
        ];
        assert_eq!(pick_window(&list, GAME_DIR, 1).unwrap().hwnd, 4);
        assert!(pick_window(&list, r"X:\Nothing", 1).is_none());
    }

    #[test]
    fn docks_covers_centre_and_restores_original_rect() {
        let original = Rect { x: 300, y: 200, w: 1000, h: 700 };
        let api = Fake::new(vec![game_window(original)]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let v = view((100, 50), 1.5, css(60.0, 40.0, 800.0, 600.0), false);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        assert_eq!(api.rect_of(GAME), target_rect(&v));
        dock.stop(&api);
        assert_eq!(api.rect_of(GAME), original);
        // 止めた後は何もしない
        let before = api.logged("set_rect");
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Stopped(Note::Gone));
        assert_eq!(api.logged("set_rect"), before);
    }

    #[test]
    fn invisible_border_windows_land_exactly() {
        let mut w = game_window(Rect { x: 0, y: 0, w: 1000, h: 700 });
        w.insets = Insets { l: 8, t: 0, r: 8, b: 8 };
        let api = Fake::new(vec![w]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let v = view((0, 0), 1.0, css(100.0, 100.0, 800.0, 500.0), false);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        let landed = api.info(GAME).unwrap().visible();
        assert_eq!(landed, Rect { x: 100, y: 100, w: 800, h: 500 });
    }

    #[test]
    fn follows_hub_move_resize_and_content_changes() {
        let api = Fake::new(vec![game_window(Rect { x: 0, y: 0, w: 1000, h: 700 })]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let mut v = view((100, 100), 1.0, css(60.0, 40.0, 800.0, 600.0), false);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        // 変わらない間は動かさない
        let sets = api.logged("set_rect");
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        assert_eq!(api.logged("set_rect"), sets);
        // Hub 窓の移動
        v.client_origin = (400, 250);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        assert_eq!(api.rect_of(GAME), Rect { x: 460, y: 290, w: 800, h: 600 });
        // 最大化（中央領域が広がる）
        v.content = css(60.0, 40.0, 1400.0, 900.0);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        assert_eq!(api.rect_of(GAME).w, 1400);
        // Hub が前面なら、活性化せず前へ出す
        *api.foreground.borrow_mut() = Some(HUB);
        let raises = api.logged("raise");
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        assert_eq!(api.logged("raise"), raises + 1);
    }

    #[test]
    fn minimize_follows_hub_but_not_the_users_own_minimize() {
        let api = Fake::new(vec![game_window(Rect { x: 0, y: 0, w: 1000, h: 700 })]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let mut v = view((0, 0), 1.0, css(10.0, 10.0, 800.0, 600.0), false);
        dock.step(&api, &v, NOW);
        v.minimized = true;
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        assert!(api.info(GAME).unwrap().minimized);
        v.minimized = false;
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        assert!(!api.info(GAME).unwrap().minimized);
        assert_eq!(api.rect_of(GAME), target_rect(&v));
        // 利用者が自分で最小化した窓は戻さない
        api.windows.borrow_mut()[0].minimized = true;
        let sets = api.logged("set_rect");
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        assert!(api.info(GAME).unwrap().minimized);
        assert_eq!(api.logged("set_rect"), sets);
    }

    #[test]
    fn waits_for_the_window_then_times_out() {
        let api = Fake::new(vec![]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let v = view((0, 0), 1.0, css(0.0, 0.0, 800.0, 600.0), false);
        assert_eq!(dock.step(&api, &v, Duration::from_secs(5)), Outcome::Searching);
        api.windows.borrow_mut().push(game_window(Rect { x: 0, y: 0, w: 640, h: 480 }));
        assert_eq!(dock.step(&api, &v, Duration::from_secs(6)), Outcome::Docked);
        let api = Fake::new(vec![]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        assert_eq!(dock.step(&api, &v, Duration::from_secs(30)), Outcome::Stopped(Note::Timeout));
        assert_eq!(api.logged("set_rect"), 0);
    }

    #[test]
    fn never_touches_other_processes_windows() {
        let mut other = game_window(Rect { x: 5, y: 5, w: 900, h: 700 });
        other.exe = r"X:\Elsewhere\other.exe".into();
        other.pid = 77;
        let api = Fake::new(vec![other]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(1));
        let v = view((0, 0), 1.0, css(0.0, 0.0, 800.0, 600.0), false);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Searching);
        assert_eq!(dock.step(&api, &v, Duration::from_secs(2)), Outcome::Stopped(Note::Timeout));
        assert!(api.log.borrow().is_empty());
    }

    #[test]
    fn refuses_a_window_that_will_not_resize_and_restores_it() {
        let original = Rect { x: 40, y: 40, w: 1000, h: 700 };
        let mut api = Fake::new(vec![game_window(original)]);
        api.min_width = 1100; // 幅 800 を受け付けない
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let v = view((0, 0), 1.0, css(0.0, 0.0, 800.0, 600.0), false);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Stopped(Note::Refused));
        api.windows.borrow_mut()[0].rect = original; // 偽の窓の最小幅は戻すときも効くので、元の大きさに戻ったことは set_rect の呼び出しで見る
        assert!(api.logged("set_rect") >= 2);
        // 止まった後は触らない
        let n = api.logged("set_rect");
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Stopped(Note::Gone));
        assert_eq!(api.logged("set_rect"), n);
    }

    #[test]
    fn refusal_to_move_and_exclusive_fullscreen_are_told_apart() {
        let mut api = Fake::new(vec![game_window(Rect { x: 0, y: 0, w: 1000, h: 700 })]);
        api.refuse_move = true;
        let v = view((0, 0), 1.0, css(0.0, 0.0, 800.0, 600.0), false);
        assert_eq!(Dock::new(GAME_DIR.into(), Duration::from_secs(9)).step(&api, &v, NOW), Outcome::Stopped(Note::Refused));
        *api.exclusive.borrow_mut() = true;
        assert_eq!(Dock::new(GAME_DIR.into(), Duration::from_secs(9)).step(&api, &v, NOW), Outcome::Stopped(Note::Exclusive));
    }

    #[test]
    fn game_entering_fullscreen_later_stops_the_dock() {
        let api = Fake::new(vec![game_window(Rect { x: 0, y: 0, w: 1000, h: 700 })]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let v = view((0, 0), 1.0, css(100.0, 100.0, 800.0, 600.0), false);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        // 窓が画面いっぱいへ動き、こちらの指定を受け付けなくなる
        api.windows.borrow_mut()[0].rect = Rect { x: 0, y: 0, w: 1920, h: 1200 };
        let mut api = api;
        api.refuse_move = true;
        *api.exclusive.borrow_mut() = true;
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Stopped(Note::Exclusive));
    }

    #[test]
    fn window_closing_ends_the_dock_without_touching_anything() {
        let api = Fake::new(vec![game_window(Rect { x: 0, y: 0, w: 1000, h: 700 })]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let v = view((0, 0), 1.0, css(0.0, 0.0, 800.0, 600.0), false);
        dock.step(&api, &v, NOW);
        api.windows.borrow_mut().clear();
        let n = api.log.borrow().len();
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Stopped(Note::Gone));
        dock.restore(&api);
        assert_eq!(api.log.borrow().len(), n);
    }

    #[test]
    fn maximized_game_is_restored_to_maximized() {
        let mut w = game_window(Rect { x: 0, y: 0, w: 1920, h: 1200 });
        w.maximized = true;
        let api = Fake::new(vec![w]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let v = view((0, 0), 1.0, css(100.0, 100.0, 800.0, 600.0), false);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
        assert!(!api.info(GAME).unwrap().maximized);
        dock.stop(&api);
        let back = api.info(GAME).unwrap();
        assert!(back.maximized);
        assert_eq!(back.rect, Rect { x: 0, y: 0, w: 1920, h: 1200 });
    }

    #[test]
    fn hub_minimized_while_searching_waits_instead_of_docking() {
        let api = Fake::new(vec![game_window(Rect { x: 0, y: 0, w: 1000, h: 700 })]);
        let mut dock = Dock::new(GAME_DIR.into(), Duration::from_secs(30));
        let mut v = view((0, 0), 1.0, css(0.0, 0.0, 800.0, 600.0), true);
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Searching);
        assert_eq!(api.logged("set_rect"), 0);
        v.minimized = false;
        assert_eq!(dock.step(&api, &v, NOW), Outcome::Docked);
    }

    #[test]
    fn rect_validation_rejects_nonsense() {
        assert!(valid_rect(&css(0.0, 0.0, 800.0, 600.0), 1.5));
        assert!(!valid_rect(&css(f64::NAN, 0.0, 800.0, 600.0), 1.0));
        assert!(!valid_rect(&css(0.0, 0.0, 0.0, 600.0), 1.0));
        assert!(!valid_rect(&css(0.0, 0.0, 800.0, 600.0), 0.0));
        assert!(!valid_rect(&css(0.0, 0.0, 800.0, 600.0), 50.0));
    }
}
