//! Windows tab controls owned by the main UI thread. Webviews render pages only.
use crate::browser_window::BrowserRect;
use tauri::AppHandle;
#[cfg(not(windows))]
use tauri::Emitter;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChromePalette { pub panel: [u8; 3], pub surface: [u8; 3], pub text: [u8; 3], pub muted: [u8; 3], pub line: [u8; 3], pub focus: [u8; 3] }
#[derive(Clone, Copy)]
struct ChromeLayout { rect: BrowserRect, palette: ChromePalette, font_size: f64 }
static LAYOUT: std::sync::Mutex<Option<ChromeLayout>> = std::sync::Mutex::new(None);
const MAX_ADDRESS: usize = 8192;
const SAFE_ID: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Row { pub id: u64, pub label: String, pub url: String, pub active: bool, pub pinned: bool, pub can_back: bool, pub can_forward: bool, pub loading: bool }

fn label(title: &str, url: &str, pinned: bool) -> String {
    let text = if title.is_empty() { if url.is_empty() { "新しいタブ" } else { url } } else { title };
    format!("{}{}", if pinned { "固定 · " } else { "" }, text.chars().filter(|c| !c.is_control()).take(100).collect::<String>())
}

pub(crate) fn row(id: u64, title: &str, url: &str, active: bool, pinned: bool, can_back: bool, can_forward: bool, loading: bool) -> Row {
    Row { id, label: label(title, url, pinned), url: url.into(), active, pinned, can_back, can_forward, loading }
}

fn address_value(units: &[u16]) -> Option<String> {
    if units.is_empty() || units.len() > MAX_ADDRESS { return None; }
    String::from_utf16(units).ok().filter(|text| !text.trim().is_empty() && !text.chars().any(char::is_control))
}

fn address_width(width: f64) -> f64 { width - 116.0 }
fn first_key_down(message: isize) -> bool { message & (1 << 30) == 0 }

fn fits(rect: BrowserRect) -> bool {
    [rect.x, rect.y, rect.w, rect.h].iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 32767.0)
        && rect.w >= 240.0 && (32.0..=48.0).contains(&rect.h)
        && rect.x + rect.w <= 32767.0 && rect.y + rect.h <= 32767.0
}
fn valid_font(size: f64) -> bool { size.is_finite() && (12.0..=16.0).contains(&size) }

// Native chrome overlays DOM controls; the entire stage belongs to the page.
pub(crate) fn content_rect(rect: BrowserRect) -> BrowserRect { rect }

#[tauri::command]
pub fn native_browser_chrome_layout(app: AppHandle, webview: tauri::Webview, rect: Option<BrowserRect>, palette: Option<ChromePalette>, font_size: f64) -> Result<(), String> {
    if webview.label() != "main" { return Err("browser_unavailable".into()); }
    let valid = valid_font(font_size) && rect.is_none_or(|rect| fits(rect) && palette.is_some());
    *LAYOUT.lock().map_err(|_| "browser_unavailable")? = if valid { rect.zip(palette).map(|(rect, palette)| ChromeLayout { rect, palette, font_size }) } else { None };
    sync(&app, rect.unwrap_or(BrowserRect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }), crate::browser_window::native_tabs_interactive(), crate::browser_window::native_tab_rows());
    if valid { Ok(()) } else { Err("browser_chrome_invalid".into()) }
}

pub(crate) fn sync(app: &AppHandle, rect: BrowserRect, visible: bool, rows: Vec<Row>) {
    #[cfg(windows)] windows::sync(app, rect, visible, rows);
    #[cfg(not(windows))] { let _ = (rect, visible, rows); let _ = app.emit_to("main", "browser-native-chrome", serde_json::json!({"enabled":false})); }
}

/// True means available and scheduled; the main closure rechecks availability.
pub(crate) fn focus_address(app: &AppHandle) -> bool {
    #[cfg(windows)] { windows::focus_address(app) }
    #[cfg(not(windows))] { let _ = app; false }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{cell::{Cell, RefCell}, ptr::null_mut, rc::Rc, sync::{Arc, atomic::{AtomicBool, Ordering}}};
    use tauri::{Emitter, Manager};
    use windows_sys::Win32::{Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Gdi::*,
        UI::{Input::KeyboardAndMouse::{EnableWindow, GetFocus, GetKeyState, IsWindowEnabled, SetFocus, TrackMouseEvent, TRACKMOUSEEVENT, TME_LEAVE}, Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass}, WindowsAndMessaging::*}};

    pub(super) static READY: AtomicBool = AtomicBool::new(false);
    static VISIBLE: AtomicBool = AtomicBool::new(false);
    thread_local! { static BAR: Cell<*const Bar> = const { Cell::new(std::ptr::null()) }; }
    const SELECT: usize = 4101;
    const NEW: usize = 4102;
    const CLOSE: usize = 4103;
    const BACK: usize = 4104;
    const FORWARD: usize = 4105;
    const RELOAD: usize = 4106;
    const ADDRESS: usize = 4107;
    // windows-sys 0.59 Controls message values; no additional crate feature.
    const EM_SETSEL: u32 = 177;
    const EM_SETLIMITTEXT: u32 = 197;
    const EM_SETMARGINS: u32 = 211;
    const EC_LEFTMARGIN: u32 = 1;
    const EC_RIGHTMARGIN: u32 = 2;
    const SUBCLASS: usize = 0x485542;
    const WM_MOUSELEAVE: u32 = 0x02a3;
    #[repr(C)]
    struct DrawItem { control_type: u32, id: u32, item_id: u32, action: u32, state: u32, hwnd: HWND, dc: HDC, rect: windows_sys::Win32::Foundation::RECT, data: usize }
    struct Bar { palette: Cell<ChromePalette>, font: Cell<HFONT>, font_height: Cell<i32>, surface: Cell<HBRUSH>, hover: Cell<HWND>, app: AppHandle, hwnd: HWND, select: HWND, new: HWND, close: HWND, back: HWND, forward: HWND, reload: HWND, address: HWND, rows: RefCell<Vec<Row>>, alive: Arc<AtomicBool>, composing: Cell<bool>, ime_return: Cell<bool> }
    impl Drop for Bar {
        fn drop(&mut self) { unsafe { if !self.font.get().is_null() { DeleteObject(self.font.get()); } if !self.surface.get().is_null() { DeleteObject(self.surface.get()); } } }
    }
    fn rgb(color: [u8; 3]) -> u32 { u32::from(color[0]) | u32::from(color[1]) << 8 | u32::from(color[2]) << 16 }
    unsafe fn fill(dc: HDC, rect: &windows_sys::Win32::Foundation::RECT, color: [u8; 3], frame: bool) {
        let brush = CreateSolidBrush(rgb(color));
        if !brush.is_null() { if frame { FrameRect(dc, rect, brush); } else { FillRect(dc, rect, brush); } DeleteObject(brush); }
    }
    unsafe fn paint_bar(bar: &Bar, dc: HDC) {
        let mut rect = std::mem::zeroed(); GetClientRect(bar.hwnd, &mut rect);
        fill(dc, &rect, bar.palette.get().panel, false);
        let mut address = std::mem::zeroed(); GetWindowRect(bar.address, &mut address);
        MapWindowPoints(std::ptr::null_mut(), bar.hwnd, &mut address as *mut _ as *mut _, 2);
        address.left -= 1; address.top -= 1; address.right += 1; address.bottom += 1;
        fill(dc, &address, if GetFocus() == bar.address { bar.palette.get().focus } else { bar.palette.get().line }, true);
    }
    unsafe fn paint_button(bar: &Bar, item: &DrawItem) {
        let palette = bar.palette.get();
        let disabled = item.state & 4 != 0;
        fill(item.dc, &item.rect, if item.state & 1 != 0 || bar.hover.get() == item.hwnd { palette.surface } else { palette.panel }, false);
        if item.state & 16 != 0 { fill(item.dc, &item.rect, palette.focus, true); }
        SetBkMode(item.dc, TRANSPARENT as i32); SetTextColor(item.dc, rgb(if disabled { palette.muted } else { palette.text }));
        let old = SelectObject(item.dc, bar.font.get());
        let glyph = if item.hwnd == bar.back { "←" } else if item.hwnd == bar.forward { "→" } else if crate::browser_window::native_tab_rows().iter().any(|r| r.active && r.loading) { "■" } else { "↻" };
        let mut rect = item.rect; DrawTextW(item.dc, wide(glyph).as_ptr(), -1, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        SelectObject(item.dc, old);
    }
    unsafe fn apply_style(bar: &Bar, layout: ChromeLayout, scale: f64) -> bool {
        let height = -(layout.font_size * scale).round() as i32;
        let brush = CreateSolidBrush(rgb(layout.palette.surface));
        if brush.is_null() { return false; }
        if bar.font_height.get() != height {
            let font = CreateFontW(height, 0, 0, 0, 400, 0, 0, 0, DEFAULT_CHARSET as u32, 0, 0, CLEARTYPE_QUALITY as u32, 0, wide("Segoe UI").as_ptr());
            if font.is_null() { DeleteObject(brush); return false; }
            let old = bar.font.replace(font); bar.font_height.set(height);
            for control in controls(bar) { if current(bar) { SendMessageW(control, WM_SETFONT, font as usize, 1); } }
            if !old.is_null() { DeleteObject(old); }
        }
        let old = bar.surface.replace(brush); bar.palette.set(layout.palette);
        if !old.is_null() { DeleteObject(old); }
        InvalidateRect(bar.hwnd, std::ptr::null(), 1);
        for control in controls(bar) { InvalidateRect(control, std::ptr::null(), 1); }
        current(bar)
    }
    enum Action { Select(u64), New, Close(u64), Back(u64), Forward(u64), Reload(u64, bool), Address(u64, String) }
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain([0]).collect() }

    // Rc is used only on the main UI thread. The window owns one raw Rc until
    // WM_NCDESTROY; callbacks and sync keep a temporary owner across Win32 calls.
    unsafe fn retain(ptr: *const Bar) -> Rc<Bar> {
        Rc::increment_strong_count(ptr);
        Rc::from_raw(ptr)
    }

    fn controls(bar: &Bar) -> [HWND; 7] { [bar.select, bar.new, bar.close, bar.back, bar.forward, bar.reload, bar.address] }
    fn current(bar: &Bar) -> bool { bar.alive.load(Ordering::SeqCst) && BAR.with(|slot| slot.get() == bar as *const Bar) }
    unsafe fn interactive(bar: &Bar) -> bool { current(bar) && IsWindowVisible(bar.hwnd) != 0 && crate::browser_window::native_tabs_interactive() }
    unsafe fn focus(bar: &Bar) {
        if !interactive(bar) || IsWindowEnabled(bar.address) == 0 { return; }
        SetFocus(bar.address);
        if interactive(bar) && GetFocus() == bar.address { SendMessageW(bar.address, EM_SETSEL, 0, -1); }
    }
    fn chrome(app: &AppHandle, enabled: bool) {
        READY.store(enabled, Ordering::SeqCst);
        VISIBLE.store(enabled, Ordering::SeqCst);
        let _ = app.emit_to("main", "browser-native-chrome", serde_json::json!({"enabled":enabled}));
    }
    unsafe fn edit(bar: &Bar) {
        if !interactive(bar) || GetFocus() != bar.address || bar.composing.get() { return; }
        let id = crate::browser_window::native_tab_rows().iter().find(|r| r.active).map(|r| r.id);
        let length = GetWindowTextLengthW(bar.address);
        if length < 0 || length as usize > MAX_ADDRESS { return; }
        let mut buffer = vec![0; length as usize + 1];
        let read = GetWindowTextW(bar.address, buffer.as_mut_ptr(), buffer.len() as i32);
        if read != length || !interactive(bar) || GetFocus() != bar.address || crate::browser_window::native_tab_rows().iter().find(|r| r.active).map(|r| r.id) != id { return; }
        let value = if length == 0 { Some(String::new()) } else { address_value(&buffer[..read as usize]) };
        if let (Some(id), Some(value)) = (id.filter(|id| *id > 0 && *id <= SAFE_ID), value) { let _ = bar.app.emit_to("main", "browser-native-address-edit", serde_json::json!({"tabId":id,"value":value})); }
    }
    fn address_key(bar: &Bar, key: &str) {
        if let Some(id) = crate::browser_window::native_tab_rows().iter().find(|r| r.active).map(|r| r.id).filter(|id| *id > 0 && *id <= SAFE_ID) { let _ = bar.app.emit_to("main", "browser-native-address-key", serde_json::json!({"tabId":id,"key":key})); }
    }
    unsafe fn submit(bar: &Bar) {
        if !interactive(bar) || GetFocus() != bar.address { return; }
        let id = crate::browser_window::native_tab_rows().iter().find(|r| r.active).map(|r| r.id);
        let length = GetWindowTextLengthW(bar.address);
        if !interactive(bar) || GetFocus() != bar.address { return; }
        if length <= 0 || length as usize > MAX_ADDRESS { let _ = bar.app.emit_to("main", "browser-operation-error", "address_invalid"); return; }
        let mut buffer = vec![0; length as usize + 1];
        let read = GetWindowTextW(bar.address, buffer.as_mut_ptr(), buffer.len() as i32);
        if !interactive(bar) || GetFocus() != bar.address || crate::browser_window::native_tab_rows().iter().find(|r| r.active).map(|r| r.id) != id { return; }
        let value = usize::try_from(read).ok().and_then(|length| buffer.get(..length)).and_then(address_value);
        if let (Some(id), Some(value)) = (id.filter(|id| *id > 0 && *id <= SAFE_ID), value) {
            dispatch(bar, Action::Address(id, value));
        } else { let _ = bar.app.emit_to("main", "browser-operation-error", "address_invalid"); }
    }

    unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _: usize, data: usize) -> LRESULT {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| procedure_inner(hwnd, msg, wp, lp, data)))
            .unwrap_or_else(|_| DefSubclassProc(hwnd, msg, wp, lp))
    }

    unsafe fn procedure_inner(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, data: usize) -> LRESULT {
        let ptr = data as *const Bar;
        if ptr.is_null() { return DefSubclassProc(hwnd, msg, wp, lp); }
        let bar = retain(ptr);
        if msg == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(procedure), SUBCLASS);
            if hwnd != bar.hwnd { return DefSubclassProc(hwnd, msg, wp, lp); }
            bar.alive.store(false, Ordering::SeqCst);
            BAR.with(|slot| { if slot.get() == ptr { slot.set(std::ptr::null()); READY.store(false, Ordering::SeqCst); chrome(&bar.app, false); } });
            let result = DefSubclassProc(hwnd, msg, wp, lp);
            drop(Rc::from_raw(ptr));
            return result;
        }
        if !current(&bar) { return DefSubclassProc(hwnd, msg, wp, lp); }
        if hwnd == bar.hwnd {
            if msg == WM_DRAWITEM && lp != 0 { let item = &*(lp as *const DrawItem); if [bar.back, bar.forward, bar.reload].contains(&item.hwnd) { paint_button(&bar, item); return 1; } }
            if (msg == WM_CTLCOLOREDIT || msg == WM_CTLCOLORSTATIC) && lp as HWND == bar.address { SetTextColor(wp as HDC, rgb(if IsWindowEnabled(bar.address) != 0 { bar.palette.get().text } else { bar.palette.get().muted })); SetBkColor(wp as HDC, rgb(bar.palette.get().surface)); return bar.surface.get() as isize; }
            if msg == WM_ERASEBKGND { paint_bar(&bar, wp as HDC); return 1; }
            if msg == WM_PAINT { let mut paint = std::mem::zeroed(); let dc = BeginPaint(hwnd, &mut paint); paint_bar(&bar, dc); EndPaint(hwnd, &paint); return 0; }
        }
        if [bar.back, bar.forward, bar.reload].contains(&hwnd) {
            if msg == WM_MOUSEMOVE { if bar.hover.replace(hwnd) != hwnd { InvalidateRect(hwnd, std::ptr::null(), 1); } let mut track = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: hwnd, dwHoverTime: 0 }; TrackMouseEvent(&mut track); }
            if msg == WM_MOUSELEAVE { if bar.hover.get() == hwnd { bar.hover.set(std::ptr::null_mut()); InvalidateRect(hwnd, std::ptr::null(), 1); } }
        }
        if msg == WM_SETFOCUS || msg == WM_KILLFOCUS { InvalidateRect(hwnd, std::ptr::null(), 1); InvalidateRect(bar.hwnd, std::ptr::null(), 1); }
        if hwnd == bar.address {
            if msg == WM_SETFOCUS { edit(&bar); }
            if msg == WM_IME_STARTCOMPOSITION { bar.composing.set(true); }
            if msg == WM_IME_ENDCOMPOSITION { bar.composing.set(false); bar.ime_return.set(GetKeyState(13) < 0); edit(&bar); }
            if msg == WM_KILLFOCUS { bar.composing.set(false); bar.ime_return.set(false); address_key(&bar, "blur"); }
            if msg == WM_KEYDOWN && !bar.composing.get() && [0x26, 0x28, 0x1b].contains(&wp) {
                if wp == 0x1b { if let Some(row) = crate::browser_window::native_tab_rows().iter().find(|r| r.active) { SetWindowTextW(bar.address, wide(&row.url).as_ptr()); SendMessageW(bar.address, EM_SETSEL, 0, -1); } }
                address_key(&bar, if wp == 0x26 { "ArrowUp" } else if wp == 0x28 { "ArrowDown" } else { "Escape" }); return 0;
            }
            if msg == WM_KEYUP && wp == 13 { bar.ime_return.set(false); }
            if msg == WM_KEYDOWN && wp == 13 {
                if bar.composing.get() { return DefSubclassProc(hwnd, msg, wp, lp); }
                if first_key_down(lp) && !bar.ime_return.get() { submit(&bar); }
                return 0;
            }
            if msg == WM_CHAR && wp == 13 { return 0; }
        }
        if controls(&bar).contains(&hwnd) {
            if msg == WM_GETDLGCODE { return DefSubclassProc(hwnd, msg, wp, lp) | DLGC_WANTTAB as isize; }
            if msg == WM_KEYDOWN && wp == 0x4c && GetKeyState(17) < 0 { focus(&bar); return 0; }
            if msg == WM_KEYDOWN && wp == 9 && interactive(&bar) && !bar.composing.get() {
                let enabled = controls(&bar).into_iter().filter(|h| IsWindowEnabled(*h) != 0 && IsWindowVisible(*h) != 0).collect::<Vec<_>>();
                if let Some(index) = enabled.iter().position(|h| *h == hwnd) {
                    let next = if GetKeyState(16) < 0 { (index + enabled.len() - 1) % enabled.len() } else { (index + 1) % enabled.len() };
                    SetFocus(enabled[next]);
                }
                return 0;
            }
        }
        if msg == WM_COMMAND {
            // Notifications must come from one of this bar's actual controls.
            let code = ((wp >> 16) & 0xffff) as u32;
            let source = lp as HWND;
            if !interactive(&bar) || !controls(&bar).contains(&source) || IsWindowEnabled(source) == 0 { return 0; }
            if source == bar.address && wp & 0xffff == ADDRESS && code == 0x0300 { edit(&bar); return 0; } // EN_CHANGE
            let active = crate::browser_window::native_tab_rows().into_iter().find(|r| r.active);
            let action = match wp & 0xffff {
                SELECT if source == bar.select && code == CBN_SELCHANGE => {
                    let index = SendMessageW(bar.select, CB_GETCURSEL, 0, 0);
                    usize::try_from(index).ok().and_then(|i| bar.rows.borrow().get(i).map(|r| Action::Select(r.id)))
                }
                NEW if source == bar.new && code == BN_CLICKED => Some(Action::New),
                CLOSE if source == bar.close && code == BN_CLICKED => active.filter(|r| !r.pinned).map(|r| Action::Close(r.id)),
                BACK if source == bar.back && code == BN_CLICKED => active.filter(|r| r.can_back).map(|r| Action::Back(r.id)),
                FORWARD if source == bar.forward && code == BN_CLICKED => active.filter(|r| r.can_forward).map(|r| Action::Forward(r.id)),
                RELOAD if source == bar.reload && code == BN_CLICKED => active.map(|r| Action::Reload(r.id, r.loading)),
                _ => None,
            };
            if let Some(action) = action { dispatch(&bar, action); return 0; }
        }
        DefSubclassProc(hwnd, msg, wp, lp)
    }

    fn dispatch(bar: &Bar, action: Action) {
        let app = bar.app.clone(); let alive = bar.alive.clone();
        // Leave WM_COMMAND before WebView2 creates/closes/focuses a controller.
        std::thread::spawn(move || {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let bar = BAR.with(|slot| { let ptr = slot.get(); (!ptr.is_null()).then(|| unsafe { retain(ptr) }) });
                let Some(_bar) = bar.filter(|bar| Arc::ptr_eq(&bar.alive, &alive) && unsafe { interactive(bar) }) else { return; };
                let tabs = crate::browser_window::native_tab_rows();
                let active = tabs.iter().find(|tab| tab.active);
                let result = match action {
                    Action::Select(id) if tabs.iter().any(|tab| tab.id == id) => crate::browser_window::browser_activate_tab(handle.clone(), id),
                    Action::New if tabs.len() < 64 => crate::browser_window::browser_new_tab(handle.clone(), None),
                    Action::Close(id) if active.is_some_and(|t| t.id == id && !t.pinned) => crate::browser_window::browser_close_tab(handle.clone(), id),
                    Action::Back(id) if active.is_some_and(|t| t.id == id && t.can_back) => crate::browser_window::browser_back(handle.clone()),
                    Action::Forward(id) if active.is_some_and(|t| t.id == id && t.can_forward) => crate::browser_window::browser_forward(handle.clone()),
                    Action::Reload(id, loading) if active.is_some_and(|t| t.id == id && t.loading == loading) => if loading { crate::browser_window::browser_stop(handle.clone()) } else { crate::browser_window::browser_reload(handle.clone()) },
                    Action::Address(id, value) if active.is_some_and(|t| t.id == id) => handle.emit_to("main", "browser-native-address-submit", serde_json::json!({"value":value,"tabId":id})).map_err(|_| "address_submit_failed".into()),
                    _ => return,
                };
                if let Err(reason) = result { let _ = handle.emit_to("main", "browser-operation-error", reason); }
            });
        });
    }

    pub(super) fn focus_address(app: &AppHandle) -> bool {
        if !READY.load(Ordering::SeqCst) || !VISIBLE.load(Ordering::SeqCst) || !crate::browser_window::native_tabs_interactive() { return false; }
        app.run_on_main_thread(|| unsafe { BAR.with(|slot| { let ptr = slot.get(); if !ptr.is_null() { focus(&retain(ptr)); } }); }).is_ok()
    }

    unsafe fn create(app: &AppHandle, palette: ChromePalette) -> Option<Rc<Bar>> {
        let parent = app.get_window("main")?.hwnd().ok()?.0 as HWND;
        // A layered child keeps GDI chrome visible above the WebView2 compositor.
        let hwnd = CreateWindowExW(WS_EX_LAYERED, wide("STATIC").as_ptr(), wide("").as_ptr(), WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0, 0, 0, 0, parent, null_mut(), null_mut(), null_mut());
        if hwnd.is_null() { return None; }
        if SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) == 0 { DestroyWindow(hwnd); return None; }
        let child = |class: &str, text: &str, style: u32, id: usize| CreateWindowExW(0, wide(class).as_ptr(), wide(text).as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | style, 0, 0, 0, 0, hwnd, id as HMENU, null_mut(), null_mut());
        let select = child("COMBOBOX", "タブ", CBS_DROPDOWNLIST as u32 | WS_VSCROLL, SELECT);
        let new = child("BUTTON", "新規", BS_PUSHBUTTON as u32, NEW);
        let close = child("BUTTON", "閉じる", BS_PUSHBUTTON as u32, CLOSE);
        let back = child("BUTTON", "戻る", BS_OWNERDRAW as u32, BACK);
        let forward = child("BUTTON", "進む", BS_OWNERDRAW as u32, FORWARD);
        let reload = child("BUTTON", "再読込", BS_OWNERDRAW as u32, RELOAD);
        let address = child("EDIT", "", ES_AUTOHSCROLL as u32, ADDRESS);
        if [select, new, close, back, forward, reload, address].iter().any(|h| h.is_null()) { DestroyWindow(hwnd); return None; }
        for control in [select, new, close, back, forward, reload, address] { SendMessageW(control, WM_SETFONT, GetStockObject(DEFAULT_GUI_FONT) as usize, 1); }
        // An over-limit sentinel keeps a clipped paste from becoming a valid URL.
        SendMessageW(address, EM_SETLIMITTEXT, MAX_ADDRESS + 1, 0);
        // EM_SETCUEBANNER: the Native EDIT accepts both URLs and search terms.
        SendMessageW(address, 0x1501, 1, wide("Webアドレス または Web検索").as_ptr() as isize);
        SendMessageW(address, EM_SETMARGINS, EC_LEFTMARGIN as usize | EC_RIGHTMARGIN as usize, 8 | (8 << 16));
        let bar = Rc::new(Bar { palette: Cell::new(palette), font: Cell::new(std::ptr::null_mut()), font_height: Cell::new(0), surface: Cell::new(std::ptr::null_mut()), hover: Cell::new(std::ptr::null_mut()), app: app.clone(), hwnd, select, new, close, back, forward, reload, address, rows: RefCell::new(Vec::new()), alive: Arc::new(AtomicBool::new(true)), composing: Cell::new(false), ime_return: Cell::new(false) });
        let ptr = Rc::into_raw(bar.clone());
        if SetWindowSubclass(hwnd, Some(procedure), SUBCLASS, ptr as usize) == 0 {
            drop(Rc::from_raw(ptr)); DestroyWindow(hwnd); return None;
        }
        BAR.with(|slot| slot.set(ptr));
        for control in controls(&bar) {
            if SetWindowSubclass(control, Some(procedure), SUBCLASS, ptr as usize) == 0 { DestroyWindow(hwnd); return None; }
        }
        Some(bar)
    }

    pub(super) fn sync(app: &AppHandle, _stage_rect: BrowserRect, visible: bool, rows: Vec<Row>) {
        let app = app.clone();
        let scheduler = app.clone();
        let _ = scheduler.run_on_main_thread(move || unsafe {
            let layout = LAYOUT.lock().ok().and_then(|layout| *layout);
            let visible = visible && layout.is_some() && crate::browser_window::native_tabs_interactive();
            let existing = BAR.with(|slot| { let ptr = slot.get(); (!ptr.is_null()).then(|| retain(ptr)) });
            let Some(bar) = existing.or_else(|| visible.then(|| layout.and_then(|layout| create(&app, layout.palette))).flatten()) else { chrome(&app, false); return; };
            if !current(&bar) { chrome(&app, false); return; }
            if !visible { ShowWindow(bar.hwnd, SW_HIDE); chrome(&app, false); return; }
            let scale = app.get_window("main").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
            if !scale.is_finite() || scale <= 0.0 || scale > 16.0 { ShowWindow(bar.hwnd, SW_HIDE); chrome(&app, false); return; }
            let Some(layout) = layout else { ShowWindow(bar.hwnd, SW_HIDE); chrome(&app, false); return; };
            let rect = layout.rect;
            if !apply_style(&bar, layout, scale) { ShowWindow(bar.hwnd, SW_HIDE); chrome(&app, false); return; }
            let px = |v: f64| (v * scale).round() as i32;
            if SetWindowPos(bar.hwnd, HWND_TOP, px(rect.x), px(rect.y), px(rect.w), px(rect.h), SWP_NOACTIVATE | SWP_SHOWWINDOW) == 0 { if current(&bar) { ShowWindow(bar.hwnd, SW_HIDE); chrome(&app, false); } return; }
            for hidden in [bar.select, bar.new, bar.close] { ShowWindow(hidden, SW_HIDE); }
            let y = (rect.h - 32.0) / 2.0;
            for (control, x, width, height, top) in [(bar.back, 4.0, 32.0, 32.0, y), (bar.forward, 40.0, 32.0, 32.0, y), (bar.reload, 76.0, 32.0, 32.0, y), (bar.address, 112.0, address_width(rect.w), rect.h - 4.0, 2.0)] {
                if !current(&bar) { return; }
                if MoveWindow(control, px(x), px(top), px(width), px(height), 1) == 0 { ShowWindow(bar.hwnd, SW_HIDE); chrome(&app, false); return; }
                ShowWindow(control, SW_SHOWNA);
            }
            let active = rows.iter().find(|r| r.active).cloned();
            // Do not rebuild an open dropdown: its indices remain bound to the
            // stored IDs, even if a title event or another close arrives.
            let stored_rows = bar.rows.borrow().clone();
            let active_changed = stored_rows.iter().find(|r| r.active).map(|r| r.id) != active.as_ref().map(|r| r.id);
            if SendMessageW(bar.select, CB_GETDROPPEDSTATE, 0, 0) == 0 && stored_rows != rows {
                if !current(&bar) { return; }
                SendMessageW(bar.select, WM_SETREDRAW, 0, 0);
                if !current(&bar) { return; }
                SendMessageW(bar.select, CB_RESETCONTENT, 0, 0);
                let mut accepted = Vec::new();
                for row in rows {
                    if !current(&bar) { return; }
                    let result = SendMessageW(bar.select, CB_ADDSTRING, 0, wide(&row.label).as_ptr() as isize);
                    if result < 0 { break; }
                    accepted.push(row);
                }
                let active = accepted.iter().position(|r| r.active).map_or(usize::MAX, |i| i);
                if !current(&bar) { return; }
                *bar.rows.borrow_mut() = accepted;
                SendMessageW(bar.select, CB_SETCURSEL, active, 0);
                if !current(&bar) { return; }
                SendMessageW(bar.select, WM_SETREDRAW, 1, 0);
                if !current(&bar) { return; }
                InvalidateRect(bar.select, std::ptr::null(), 1);
            }
            if !interactive(&bar) { chrome(&app, false); return; }
            for (control, enabled) in [(bar.new, crate::browser_window::native_tab_rows().len() < 64), (bar.close, active.as_ref().is_some_and(|r| !r.pinned)), (bar.back, active.as_ref().is_some_and(|r| r.can_back)), (bar.forward, active.as_ref().is_some_and(|r| r.can_forward)), (bar.reload, active.is_some()), (bar.address, active.is_some())] {
                if !current(&bar) { return; }
                EnableWindow(control, enabled as i32);
            }
            if let Some(active) = active {
                if !current(&bar) { return; }
                SetWindowTextW(bar.reload, wide(if active.loading { "停止" } else { "再読込" }).as_ptr());
                if active_changed { bar.composing.set(false); bar.ime_return.set(false); }
                if current(&bar) && (active_changed || GetFocus() != bar.address) && !bar.composing.get() { SetWindowTextW(bar.address, wide(&active.url).as_ptr()); }
            }
            if interactive(&bar) { chrome(&app, true); }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn labels_are_plain_bounded_unicode_and_keep_empty_tabs() {
        assert_eq!(label("", "", false), "新しいタブ");
        assert_eq!(label("a\0\nb", "", true), "固定 · ab");
        assert_eq!(label(&"鳥".repeat(101), "", false).chars().count(), 100);
        assert_eq!(row(9, "same", "", false, false, false, true, true).id, 9);
    }
    #[test] fn overlay_requires_a_finite_bounded_dom_region() {
        let good = BrowserRect { x: 2.0, y: 3.0, w: 240.0, h: 32.0 };
        assert!(fits(good));
        for bad in [BrowserRect { w: 239.0, ..good }, BrowserRect { h: 31.0, ..good }, BrowserRect { x: f64::NAN, ..good }, BrowserRect { y: -1.0, ..good }, BrowserRect { w: f64::INFINITY, ..good }] { assert!(!fits(bad)); }
    }
    #[test] fn address_boundaries_use_utf16_not_scalar_count() {
        assert!(first_key_down(0)); assert!(first_key_down(1 << 31)); assert!(!first_key_down(1 << 30)); assert!(!first_key_down(-1));
        assert_eq!(address_value(&"😀".repeat(4096).encode_utf16().collect::<Vec<_>>()).unwrap().chars().count(), 4096);
        for units in [vec![0xd800], vec![0xdc00], vec![97;8193], vec![10], vec![0], vec![0x85], vec![32]] { assert!(address_value(&units).is_none()); }
        assert_eq!(address_value(&" 日本語 example.com ".encode_utf16().collect::<Vec<_>>()), Some(" 日本語 example.com ".into()));
    }
    #[test] fn rows_keep_url_navigation_flags_and_narrow_address_space() {
        let item = row(1,"title","https://example.com/",true,false,true,false,true);
        assert_eq!(item.url,"https://example.com/"); assert!(item.can_back && item.loading && !item.can_forward);
        for width in [240.0,400.0,720.0,1280.0] { assert!(address_width(width) >=124.0); }
    }
    #[test] fn overlay_does_not_reserve_page_height_and_bounds_font() {
        let rect = BrowserRect { x: 3.0, y: 9.0, w: 240.0, h: 48.0 };
        let page = content_rect(rect);
        assert_eq!((page.x, page.y, page.w, page.h), (rect.x, rect.y, rect.w, rect.h));
        for size in [12.0, 13.0, 16.0] { assert!(valid_font(size)); }
        for size in [11.99, 16.01, f64::NAN, f64::INFINITY] { assert!(!valid_font(size)); }
        for bad in [BrowserRect { h: 48.01, ..rect }, BrowserRect { x: 32700.0, ..rect }, BrowserRect { y: 32740.0, ..rect }] { assert!(!fits(bad)); }
    }

    #[test] fn palette_rejects_non_rgb_extra_and_missing_fields() {
        let value = serde_json::json!({"panel":[1,2,3],"surface":[4,5,6],"text":[7,8,9],"muted":[10,11,12],"line":[13,14,15],"focus":[16,17,18]});
        let palette: ChromePalette = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(palette.surface, [4,5,6]);
        for invalid in [serde_json::json!([1,2]), serde_json::json!([1,2,3,4]), serde_json::json!([256,2,3]), serde_json::json!([-1,2,3]), serde_json::json!([1.5,2,3])] {
            let mut altered = value.clone(); altered["panel"] = invalid;
            assert!(serde_json::from_value::<ChromePalette>(altered).is_err());
        }
        let mut extra = value.clone(); extra["url"] = serde_json::json!("unused");
        assert!(serde_json::from_value::<ChromePalette>(extra).is_err());
        let mut missing = value; missing.as_object_mut().unwrap().remove("focus");
        assert!(serde_json::from_value::<ChromePalette>(missing).is_err());
    }

}
