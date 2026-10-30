//! 右列ブラウザ（2026-10-15 ユーザー指示「右列だけでスマホのブラウザみたいに動かしたい」）。
//!
//! 右列に専用の子webviewを1枚だけ置く。作り方は通常のブラウザタブと同じ
//! `build_tab_webview`（広告・トラッカー遮断の `protection`、自動再生の規則、
//! http/https 以外の遷移拒否、IPCなし）を通し、違いは次の3点だけ。
//!   * モバイルのUserAgentを名乗る（サイトとHubが縦長の画面を返す）。
//!   * Hubのページは開けない（2026-10-15 所有者決定「ブラウザでハブ見れないほうが良い」）。
//!     通常のタブと同じく Web版Hub は止め、右列では止めた宛先を同梱UIへ渡して、
//!     アプリに同じ画面があれば中央のその画面を開く（無ければ短い通知で断る）。
//!     外部ページに Tauri の IPC は届かない（capabilities に remote が無い。下のテストが固定する）。
//!   * タブ一覧・履歴・セッション保存・メモリセーバーの対象にしない。
//!     `TABS` には入れず、ここの `SHARED` だけが状態を持つ。
//!
//! 位置は同梱UIが測った右列の枠（CSS px）と現在の倍率から物理pxで決める。
//! 畳んだとき・別の右列画面のとき・ダイアログ中・中央ページの全画面中・
//! 買い物モーダル中は webview を破棄せず隠す（再生は続く）。
use super::*;
use serde::Serialize;

/// タブidは1から増え、上限は64。衝突しない大きな固定値で右列を識別する。
pub(super) const ID: u64 = 9_007_199_254_000_000;
pub(super) const LABEL: &str = "browser-rail";
pub(super) const STATE_EVENT: &str = "rail-browser-state";
const OFFSCREEN: f64 = -10_000.0;
/// スマホの Chrome として振る舞う。端末名やWebView2の版を渡さない固定の文字列。
pub(super) const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
/// これより小さい枠は表示しない（CSS px）。
const MIN_CSS: (f64, f64) = (120.0, 80.0);
const MAX_CSS: f64 = 32767.0;

pub(super) fn is_rail_id(id: u64) -> bool { id == ID }

// ---- 配置の計算（純粋。表示がなくても試せる） ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PhysRect { pub x: i32, pub y: i32, pub w: u32, pub h: u32 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Plan { Show(PhysRect), Hide }

/// 同梱UIが測った枠（CSS px）を、窓のクライアント領域（物理px）の中の物理pxにする。
/// 左右・上下の端を別々に丸めるので、隣り合う面との間に隙間も重なりもできない。
/// 非有限・極端に小さい・領域の外へ出てほぼ残らない枠は None（隠す）。
pub(super) fn physical_bounds(rect: BrowserRect, scale: f64, client: (u32, u32)) -> Option<PhysRect> {
    if !(scale.is_finite() && scale > 0.0) { return None; }
    let values = [rect.x, rect.y, rect.w, rect.h];
    if !values.iter().all(|v| v.is_finite()) || rect.x.abs() > MAX_CSS || rect.y.abs() > MAX_CSS || rect.w > MAX_CSS || rect.h > MAX_CSS { return None; }
    if rect.w < MIN_CSS.0 || rect.h < MIN_CSS.1 { return None; }
    let edge = |css: f64| (css * scale).round() as i64;
    let x0 = edge(rect.x).max(0);
    let y0 = edge(rect.y).max(0);
    let x1 = edge(rect.x + rect.w).min(i64::from(client.0));
    let y1 = edge(rect.y + rect.h).min(i64::from(client.1));
    if x1 <= x0 || y1 <= y0 { return None; }
    let (w, h) = ((x1 - x0) as f64, (y1 - y0) as f64);
    if w < MIN_CSS.0 * scale * 0.5 || h < MIN_CSS.1 * scale * 0.5 { return None; }
    Some(PhysRect { x: x0 as i32, y: y0 as i32, w: (x1 - x0) as u32, h: (y1 - y0) as u32 })
}

/// 見せるか隠すか。`wanted` は同梱UIが「右列が開いていて、この画面で、覆うものが無い」と
/// 判断したとき。`suppressed` はRust側の理由（モーダル・全画面・読書ビュー）。
pub(super) fn plan(rect: Option<BrowserRect>, wanted: bool, suppressed: bool, scale: f64, client: (u32, u32)) -> Plan {
    if !wanted || suppressed { return Plan::Hide; }
    rect.and_then(|rect| physical_bounds(rect, scale, client)).map_or(Plan::Hide, Plan::Show)
}

// ---- URLの方針（純粋） ----

/// 右列へ渡してよい宛先。http/https だけ（ループバック補完は通常ブラウザと同じ）で、
/// アプリ自身の同梱オリジン（tauri.localhost / tauri:）と Web版Hub は渡さない。
pub(super) fn open_target(raw: &str) -> Option<tauri::Url> {
    let url = parse_target(raw)?;
    (!is_internal_url(&url, None) && !is_hub_page(&url)).then_some(url)
}

/// 右列webviewの遷移を許すか。通常タブと同じ規則：同梱ページは newtab.html
/// （新規タブ画面）以外を許さず、Web版Hub・資格情報つきURL・http/https 以外
/// （file: data: blob: javascript: about: など）は拒否する。
pub(super) fn navigation_allowed(url: &tauri::Url, dev_origin: Option<&str>) -> bool {
    if is_internal_url(url, dev_origin) { return internal_page_allowed(url, dev_origin); }
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some() && url.username().is_empty() && url.password().is_none() && !is_hub_page(url)
}

// ---- 状態 ----

/// 同梱UIへ送る右列の様子。URLとタイトルは右列の中のものだけで、履歴には残さない。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_back: bool,
    pub can_forward: bool,
    pub playing_audio: bool,
    pub ready: bool,
}

struct Shared { rect: Option<BrowserRect>, wanted: bool, creating: bool, dark: Option<bool>, info: Info }

static SHARED: Mutex<Shared> = Mutex::new(Shared {
    rect: None, wanted: false, creating: false, dark: None,
    info: Info { url: String::new(), title: String::new(), loading: false, can_back: false, can_forward: false, playing_audio: false, ready: false },
});
static WINDOW_HOOKED: AtomicBool = AtomicBool::new(false);

fn with_shared<R>(f: impl FnOnce(&mut Shared) -> R) -> R {
    let mut guard = SHARED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut guard)
}

pub(super) fn info() -> Info { with_shared(|s| s.info.clone()) }

fn emit(app: &AppHandle) {
    let _ = app.emit_to(MAIN_LABEL, STATE_EVENT, info());
}

/// 生成中の初期位置（論理px）。すぐ `layout_now` が置き直す。
pub(super) fn spawn_rect() -> BrowserRect {
    let (w, h) = with_shared(|s| s.rect.map(|r| (r.w, r.h))).unwrap_or((360.0, 640.0));
    BrowserRect { x: OFFSCREEN, y: OFFSCREEN, w: w.clamp(MIN_CSS.0, MAX_CSS), h: h.clamp(MIN_CSS.1, MAX_CSS) }
}

pub(super) fn on_title(app: &AppHandle, title: String) {
    with_shared(|s| s.info.title = title);
    emit(app);
}

pub(super) fn on_load(app: &AppHandle, view: &tauri::Webview, started: bool) {
    with_shared(|s| s.info.loading = started);
    emit(app);
    refresh(app, view);
}

/// 遷移の開始時点で呼ばれる。許した宛先だけをバーへ見せる。
pub(super) fn on_navigation(app: &AppHandle, url: &tauri::Url, dev_origin: Option<&str>) -> bool {
    // Hub宛は右列では開かない。同梱UIが中央の同じ画面へ振り分ける（無ければ通知で断る）。
    if !is_internal_url(url, dev_origin) && is_hub_page(url) {
        let _ = app.emit_to(MAIN_LABEL, "rail-browser-open-center", serde_json::json!({ "url": url.as_str() }));
        return false;
    }
    let allowed = navigation_allowed(url, dev_origin);
    if allowed && !is_internal_url(url, dev_origin) {
        with_shared(|s| { s.info.url = url.to_string(); s.info.title.clear(); });
        emit(app);
    }
    allowed
}

fn shown_url(raw: &str) -> bool { open_target(raw).is_some() }

// ---- 作成・配置 ----

fn hook_window(app: &AppHandle, window: &tauri::Window) {
    if WINDOW_HOOKED.swap(true, Ordering::SeqCst) { return; }
    let handle = app.clone();
    window.on_window_event(move |event| {
        // 大きさ・倍率の変更も別のモニターへの移動も、物理のクライアント領域を変える。
        if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Moved(_)) {
            layout(&handle);
        }
    });
}

pub(super) fn layout(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || layout_now(&handle));
}

/// メインスレッドで呼ぶ。webview がまだ無ければ何もしない。
pub(super) fn layout_now(app: &AppHandle) {
    let Some(view) = app.get_webview(LABEL) else { return };
    let Some(window) = app.get_window(MAIN_LABEL) else { return };
    let (rect, wanted) = with_shared(|s| (s.rect, s.wanted));
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(inner) = window.inner_size() else { return };
    let monitor = window.current_monitor().ok().flatten().map(|m| (m.size().width, m.size().height));
    let client = crate::window_fit::fullscreen_extent((inner.width, inner.height), monitor, window.is_fullscreen().unwrap_or(false));
    let suppressed = MODAL_OCCLUDED.load(Ordering::SeqCst) || reading::occluded() || fullscreen_owner().is_some();
    match plan(rect, wanted, suppressed, scale, client) {
        Plan::Show(p) => {
            let _ = view.set_position(tauri::PhysicalPosition::new(p.x, p.y));
            let _ = view.set_size(tauri::PhysicalSize::new(p.w, p.h));
            let _ = view.show();
        }
        Plan::Hide => {
            let _ = view.hide();
            let _ = view.set_position(LogicalPosition::new(OFFSCREEN, OFFSCREEN));
        }
    }
}

pub(super) fn set_layout(app: &AppHandle, rect: Option<BrowserRect>, wanted: bool) {
    with_shared(|s| { s.rect = rect; s.wanted = wanted && rect.is_some(); });
    layout(app);
}

/// 右列webviewを（無ければ）作り、`url` があればそこへ移る。
pub(super) fn open(app: &AppHandle, url: Option<tauri::Url>, home: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(view) = handle.get_webview(LABEL) {
            if let Some(url) = url { let _ = view.navigate(url); }
            else if home {
                // 新規タブ画面へ戻る。同梱ページの場所は中央の窓（main）と同じオリジン。
                let page = handle.get_webview(MAIN_LABEL).and_then(|main| main.url().ok()).and_then(|base| base.join(&format!("/{NEW_TAB_PAGE}")).ok());
                if let Some(page) = page {
                    let _ = view.navigate(page);
                    with_shared(|s| { s.info.url.clear(); s.info.title.clear(); });
                    emit(&handle);
                }
            }
            layout_now(&handle);
            return;
        }
        let Some(window) = handle.get_window(MAIN_LABEL) else { return };
        if !with_shared(|s| if s.creating { false } else { s.creating = true; true }) { return; }
        hook_window(&handle, &window);
        let target = match &url {
            Some(url) => WebviewUrl::External(url.clone()),
            None => WebviewUrl::App(NEW_TAB_PAGE.into()),
        };
        let shown = url.as_ref().map(ToString::to_string).unwrap_or_default();
        with_shared(|s| { s.info.url = shown; s.info.title.clear(); });
        let built = build_tab_webview(&handle, &window, ID, LABEL, target);
        with_shared(|s| s.creating = false);
        let Some(view) = built else {
            with_shared(|s| s.info.ready = false);
            emit(&handle);
            return;
        };
        hook(&handle, &view);
        if let Some(dark) = with_shared(|s| s.dark) { let _ = apply_scheme(&view, dark); }
        #[cfg(windows)] browser_access::hook(&handle, &view, ID);
        menu::hook(&handle, &view, ID);
        with_shared(|s| s.info.ready = true);
        layout_now(&handle);
        emit(&handle);
    });
}

/// 子webviewのポップアップ（target=_blank・window.open）は、スマホのブラウザと同じく右列の中で開く。
pub(super) fn popup(app: &AppHandle, raw: &str) {
    if let Some(url) = open_target(raw) { open(app, Some(url), false); }
}

// ---- 配色 ----

/// 右列のページが見る prefers-color-scheme。アプリの配色（ダーク既定）に合わせるため、OSの設定ではなく
/// この webview だけに DevTools の Emulation で伝える（プロファイルは通常タブと共有なので変えない）。
pub(super) fn scheme_params(dark: bool) -> String {
    format!("{{\"features\":[{{\"name\":\"prefers-color-scheme\",\"value\":\"{}\"}}]}}", if dark { "dark" } else { "light" })
}

fn apply_scheme(view: &tauri::Webview, dark: bool) -> Result<(), String> {
    // 結果は待たない（メインスレッドを止めない）。失敗してもページが見た目を戻すだけ。
    let (tx, _rx) = std::sync::mpsc::channel();
    call_devtools(view, "Emulation.setEmulatedMedia".to_owned(), scheme_params(dark), tx);
    Ok(())
}

pub(super) fn set_scheme(app: &AppHandle, dark: bool) -> Result<(), String> {
    with_shared(|s| s.dark = Some(dark));
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(view) = handle.get_webview(LABEL) { let _ = apply_scheme(&view, dark); }
    }).map_err(|_| "rail_browser_unavailable".to_owned())
}

// ---- 操作 ----

#[cfg(windows)]
fn with_core(app: &AppHandle, action: impl FnOnce(webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) + Send + 'static) -> Result<(), String> {
    app.get_webview(LABEL)
        .ok_or("rail_browser_unavailable")?
        .with_webview(move |platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() { action(core); }
        })
        .map_err(|_| "navigation_failed".to_owned())
}

pub(super) fn back(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)] { with_core(app, |core| unsafe { let _ = core.GoBack(); }) }
    #[cfg(not(windows))] { app.get_webview(LABEL).ok_or("rail_browser_unavailable")?.eval("history.back()").map_err(|_| "navigation_failed".to_owned()) }
}

pub(super) fn forward(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)] { with_core(app, |core| unsafe { let _ = core.GoForward(); }) }
    #[cfg(not(windows))] { app.get_webview(LABEL).ok_or("rail_browser_unavailable")?.eval("history.forward()").map_err(|_| "navigation_failed".to_owned()) }
}

pub(super) fn reload(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)] { with_core(app, |core| unsafe { let _ = core.Reload(); }) }
    #[cfg(not(windows))] { app.get_webview(LABEL).ok_or("rail_browser_unavailable")?.eval("location.reload()").map_err(|_| "navigation_failed".to_owned()) }
}

pub(super) fn stop(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)] { with_core(app, |core| unsafe { let _ = core.Stop(); }) }
    #[cfg(not(windows))] { app.get_webview(LABEL).ok_or("rail_browser_unavailable")?.eval("window.stop()").map_err(|_| "navigation_failed".to_owned()) }
}

/// 中央のプレーヤーが鳴り始めたとき、右列のページの再生を止める。
/// audio/video 要素と、同じ文書の YouTube 埋め込み（enablejsapi のとき）だけが対象。
const PAUSE_SCRIPT: &str = "(()=>{try{for(const m of document.querySelectorAll('audio,video')){try{m.pause()}catch(e){}}for(const f of document.querySelectorAll('iframe')){try{f.contentWindow.postMessage(JSON.stringify({event:'command',func:'pauseVideo',args:[]}),'*')}catch(e){}}}catch(e){}})()";

pub(super) fn pause_media(app: &AppHandle) -> Result<(), String> {
    let view = app.get_webview(LABEL).ok_or("rail_browser_unavailable")?;
    #[cfg(windows)]
    {
        view.with_webview(move |platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                let callback = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
                let _ = core.ExecuteScript(&windows_core::HSTRING::from(PAUSE_SCRIPT), &callback);
            }
        }).map_err(|_| "navigation_failed".to_owned())
    }
    #[cfg(not(windows))]
    { view.eval(PAUSE_SCRIPT).map_err(|_| "navigation_failed".to_owned()) }
}

// ---- WebView2 の状態の読み取り ----

#[cfg(windows)]
unsafe fn apply_core(app: &AppHandle, core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows_core::Interface;
    let mut source = windows_core::PWSTR::null();
    let url = core.Source(&mut source).ok().map(|_| webview2_com::take_pwstr(source)).filter(|url| shown_url(url));
    let (mut back, mut forward) = (windows_core::BOOL(0), windows_core::BOOL(0));
    let _ = core.CanGoBack(&mut back);
    let _ = core.CanGoForward(&mut forward);
    let playing = core.cast::<ICoreWebView2_8>().ok().is_some_and(|audio| {
        let mut playing = windows_core::BOOL(0);
        audio.IsDocumentPlayingAudio(&mut playing).is_ok() && playing.as_bool()
    });
    let changed = with_shared(|s| {
        let before = s.info.clone();
        if let Some(url) = url { s.info.url = url; }
        s.info.can_back = back.as_bool();
        s.info.can_forward = forward.as_bool();
        s.info.playing_audio = playing;
        s.info != before
    });
    if changed { emit(app); }
}

#[cfg(windows)]
fn refresh(app: &AppHandle, view: &tauri::Webview) {
    let handle = app.clone();
    let _ = view.with_webview(move |platform| unsafe {
        if let Ok(core) = platform.controller().CoreWebView2() { apply_core(&handle, &core); }
    });
}
#[cfg(not(windows))]
fn refresh(_app: &AppHandle, _view: &tauri::Webview) {}

/// SPA（Hubは Next.js）の画面遷移は on_navigation にも page load にも出ないので、
/// SourceChanged / HistoryChanged / 再生状態の変化を見て URL と戻る・進むを追う。
#[cfg(windows)]
fn hook(app: &AppHandle, view: &tauri::Webview) {
    use webview2_com::{HistoryChangedEventHandler, IsDocumentPlayingAudioChangedEventHandler, SourceChangedEventHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2_8};
    use windows_core::Interface;
    let handle = app.clone();
    let _ = view.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        let source_app = handle.clone();
        let source = SourceChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(core) = sender { apply_core(&source_app, &core); }
            Ok(())
        }));
        let _ = core.add_SourceChanged(&source, &mut 0);
        let history_app = handle.clone();
        let history = HistoryChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(core) = sender { apply_core(&history_app, &core); }
            Ok(())
        }));
        let _ = core.add_HistoryChanged(&history, &mut 0);
        if let Ok(audio) = core.cast::<ICoreWebView2_8>() {
            let playing_app = handle.clone();
            let playing = IsDocumentPlayingAudioChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(core) = sender { apply_core(&playing_app, &core); }
                Ok(())
            }));
            let _ = audio.add_IsDocumentPlayingAudioChanged(&playing, &mut 0);
        }
        apply_core(&handle, &core);
    });
}
#[cfg(not(windows))]
fn hook(_app: &AppHandle, _view: &tauri::Webview) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> BrowserRect { BrowserRect { x, y, w, h } }
    fn url(raw: &str) -> tauri::Url { tauri::Url::parse(raw).unwrap() }

    #[test]
    fn bounds_follow_the_scale_factor() {
        // 1280x752 logical at 150%: the client area is 1920x1128 physical.
        let p = physical_bounds(rect(860.0, 56.0, 420.0, 640.0), 1.5, (1920, 1128)).unwrap();
        assert_eq!(p, PhysRect { x: 1290, y: 84, w: 630, h: 960 });
        let p = physical_bounds(rect(860.0, 56.0, 420.0, 640.0), 1.0, (1280, 752)).unwrap();
        assert_eq!(p, PhysRect { x: 860, y: 56, w: 420, h: 640 });
    }

    #[test]
    fn edges_are_rounded_separately_so_neighbours_never_gap_or_overlap() {
        // 100.4 + 33.3 = 133.7 css; at 1.25 the left edge is 125.5 -> 126 and the right 167.125 -> 167.
        let p = physical_bounds(rect(100.4, 10.0, 33.3 + 200.0, 200.0), 1.25, (4000, 4000)).unwrap();
        assert_eq!(i64::from(p.x) + i64::from(p.w), ((100.4_f64 + 233.3) * 1.25).round() as i64);
        assert_eq!(i64::from(p.x), (100.4_f64 * 1.25).round() as i64);
    }

    #[test]
    fn bounds_are_clamped_to_the_client_area() {
        let p = physical_bounds(rect(1000.0, 0.0, 400.0, 800.0), 1.0, (1280, 752)).unwrap();
        assert_eq!((p.x, p.y, p.w, p.h), (1000, 0, 280, 752));
        let p = physical_bounds(rect(-20.0, -10.0, 400.0, 400.0), 1.0, (1280, 752)).unwrap();
        assert_eq!((p.x, p.y, p.w, p.h), (0, 0, 380, 390));
        // Almost entirely outside: not worth showing.
        assert_eq!(physical_bounds(rect(1270.0, 0.0, 400.0, 400.0), 1.0, (1280, 752)), None);
        assert_eq!(physical_bounds(rect(2000.0, 0.0, 400.0, 400.0), 1.0, (1280, 752)), None);
    }

    #[test]
    fn bad_numbers_and_tiny_rects_hide_the_view() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(physical_bounds(rect(bad, 0.0, 400.0, 400.0), 1.0, (1280, 752)), None);
            assert_eq!(physical_bounds(rect(0.0, 0.0, bad, 400.0), 1.0, (1280, 752)), None);
        }
        assert_eq!(physical_bounds(rect(0.0, 0.0, 400.0, 400.0), 0.0, (1280, 752)), None);
        assert_eq!(physical_bounds(rect(0.0, 0.0, 400.0, 400.0), f64::NAN, (1280, 752)), None);
        assert_eq!(physical_bounds(rect(0.0, 0.0, 100.0, 400.0), 1.0, (1280, 752)), None);
        assert_eq!(physical_bounds(rect(0.0, 0.0, 400.0, 60.0), 1.0, (1280, 752)), None);
        assert_eq!(physical_bounds(rect(0.0, 0.0, 99_999.0, 400.0), 1.0, (1280, 752)), None);
    }

    #[test]
    fn the_fullscreen_client_area_comes_from_the_shared_window_fit_helper() {
        // While the window is going full screen the monitor wins over a stale client area.
        let client = crate::window_fit::fullscreen_extent((1920, 1128), Some((1920, 1200)), true);
        let p = physical_bounds(rect(1500.0, 0.0, 420.0, 800.0), 1.0, client).unwrap();
        assert_eq!((p.x, p.y, p.w, p.h), (1500, 0, 420, 800));
    }

    #[test]
    fn plan_hides_for_every_suppressing_reason() {
        let r = Some(rect(860.0, 56.0, 420.0, 640.0));
        assert!(matches!(plan(r, true, false, 1.0, (1280, 752)), Plan::Show(_)));
        assert_eq!(plan(r, false, false, 1.0, (1280, 752)), Plan::Hide); // collapsed / another rail view / dialog
        assert_eq!(plan(r, true, true, 1.0, (1280, 752)), Plan::Hide); // modal, reading view, centre page full screen
        assert_eq!(plan(None, true, false, 1.0, (1280, 752)), Plan::Hide);
    }

    #[test]
    fn open_target_takes_only_web_pages_and_never_the_app_origin() {
        assert!(open_target("https://example.com/music").is_some());
        assert!(open_target("example.com/a").is_some());
        for bad in ["", "file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,hi", "about:blank", "blob:https://a/b",
            "http://tauri.localhost/index.html", "tauri://localhost/index.html", "https://user:pw@example.com/", "https://example.com/\u{7}", "https://hub.jkamma.com/music", "hub.jkamma.com"] {
            assert!(open_target(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn navigation_refuses_hub_exactly_like_normal_tabs() {
        // 2026-10-15: Hub is never shown inside the desktop browser, rail included.
        assert!(is_hub_page(&url("https://hub.jkamma.com/music")));
        assert!(!navigation_allowed(&url("https://hub.jkamma.com/music"), None));
        assert!(!navigation_allowed(&url("https://hub.jkamma.com/"), None));
        assert!(navigation_allowed(&url("http://localhost:3020/music"), None) == !is_hub_page(&url("http://localhost:3020/music")));
        assert!(navigation_allowed(&url("https://example.com/a?b=c#d"), None));
        // The bundled scaffold page is allowed; no other bundled page is.
        assert!(navigation_allowed(&url("http://tauri.localhost/newtab.html"), None));
        assert!(!navigation_allowed(&url("http://tauri.localhost/index.html"), None));
        assert!(!navigation_allowed(&url("tauri://localhost/index.html"), None));
        assert!(!navigation_allowed(&url("http://localhost:1420/index.html"), Some("http://localhost:1420")));
        for bad in ["file:///C:/Windows/win.ini", "data:text/html,hi", "javascript:alert(1)", "about:blank", "blob:https://a/b", "ftp://example.com/", "https://user:pw@example.com/", "https://:pw@example.com/"] {
            assert!(!navigation_allowed(&url(bad), None), "{bad}");
        }
    }

    #[test]
    fn the_rail_is_a_phone_and_not_a_tab() {
        assert!(MOBILE_UA.contains("Android") && MOBILE_UA.contains("Mobile Safari"));
        assert!(!MOBILE_UA.contains("Windows"));
        assert!(is_rail_id(ID) && !is_rail_id(1) && !is_rail_id(64));
        // Tab ids start at 1 and are capped at 64 live tabs; a long session still stays far below the rail id.
        assert!(ID > 1_000_000_000_000 && ID < 9_007_199_254_740_991);
        assert_ne!(LABEL, "main");
        assert!(!LABEL.starts_with("browser-tab-"));
    }

    #[test]
    fn no_capability_reaches_the_rail_or_grants_remote_pages_ipc() {
        // Pages in the rail are remote origins. They stay IPC-free only because no
        // capability lists remote URLs and none names the rail webview.
        for (name, text) in [
            ("default", include_str!("../capabilities/default.json")),
            ("main-window-chrome", include_str!("../capabilities/main-window-chrome.json")),
        ] {
            let json: serde_json::Value = serde_json::from_str(text).unwrap();
            assert!(json.get("remote").is_none(), "{name} must not grant remote origins IPC");
            assert!(!text.contains(LABEL), "{name} must not name the rail webview");
            assert!(json.get("webviews").is_none(), "{name} must not scope by webview");
        }
        let conf = include_str!("../tauri.conf.json");
        assert!(!conf.contains("dangerousRemoteDomainIpcAccess"));
    }

    #[test]
    fn the_colour_scheme_is_a_per_view_media_override() {
        for (dark, word) in [(true, "dark"), (false, "light")] {
            let json: serde_json::Value = serde_json::from_str(&scheme_params(dark)).unwrap();
            assert_eq!(json["features"][0]["name"], "prefers-color-scheme");
            assert_eq!(json["features"][0]["value"], word);
            assert_eq!(json["features"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn state_events_carry_only_what_the_toolbar_needs() {
        let json = serde_json::to_value(Info { url: "https://example.com/".into(), title: "t".into(), ..Info::default() }).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["canBack", "canForward", "loading", "playingAudio", "ready", "title", "url"]);
    }
}
