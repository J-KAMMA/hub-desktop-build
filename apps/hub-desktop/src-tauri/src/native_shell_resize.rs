//! Main-window pointer splitters. DOM separators retain keyboard navigation.
#![deny(unreachable_patterns)]
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use std::sync::atomic::{AtomicU64, Ordering};

const SAFE_SESSION: u64 = 9_007_199_254_740_991;
static SESSION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }
#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Colors { pub background: [u8; 3], pub divider: [u8; 3], pub active: [u8; 3] }

fn valid(rect: Rect) -> bool {
    [rect.x, rect.y, rect.w, rect.h].iter().all(|n| n.is_finite() && *n >= 0.0 && *n <= 32767.0)
        && (1.0..=24.0).contains(&rect.w) && rect.h >= 1.0
}
fn next_session(counter: &AtomicU64) -> Option<u64> {
    counter.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1).filter(|n| *n <= SAFE_SESSION)).ok().map(|n| n + 1)
}
fn pointer_x(message: isize) -> i32 { message as u16 as i16 as i32 }
fn pointer_y(message: isize) -> i32 { (message >> 16) as u16 as i16 as i32 }
fn primary_button(flags: usize) -> bool { flags & 1 != 0 }
fn valid_x(value: f64) -> bool { value.is_finite() && value.abs() <= 32767.0 }
fn color(value: [u8; 3]) -> u32 { value[0] as u32 | (value[1] as u32) << 8 | (value[2] as u32) << 16 }
fn ready(app: &AppHandle, sidebar: bool, rail: bool) {
    let _ = app.emit_to("main", "native-shell-resize-ready", serde_json::json!({"sidebar":sidebar,"rail":rail}));
}

#[tauri::command]
pub fn native_shell_resize_sync(app: AppHandle, webview: tauri::Webview, sidebar: Option<Rect>, rail: Option<Rect>, colors: Colors) -> Result<(), String> {
    if webview.label() != "main" { return Err("native_resize_unavailable".into()); }
    if sidebar.is_some_and(|r| !valid(r)) || rail.is_some_and(|r| !valid(r)) { return Err("native_resize_invalid".into()); }
    #[cfg(windows)] { windows::sync(app, [sidebar, rail], colors) }
    #[cfg(not(windows))] { let _ = (sidebar, rail, colors); ready(&app, false, false); Ok(()) }
}

/// The window's scale factor changed (moved to a monitor with another DPI): keep the splitters
/// over their DOM handles.
pub fn rescale(app: &AppHandle) {
    #[cfg(windows)] windows::rescale(app);
    #[cfg(not(windows))] let _ = app;
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{cell::{Cell, RefCell}, ptr::null_mut, rc::Rc};
    use tauri::Manager;
    use windows_sys::Win32::{Foundation::{GetLastError, SetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::{BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, InvalidateRect, MapWindowPoints, PAINTSTRUCT},
        UI::{Input::KeyboardAndMouse::{GetCapture, IsWindowEnabled, ReleaseCapture, SetCapture, TrackMouseEvent, TRACKMOUSEEVENT, TME_LEAVE},
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass}, WindowsAndMessaging::*}};

    const SUBCLASS: usize = 0x485553;
    // Win32 STATIC style; cached windows-sys declares it in SystemServices.
    const SS_NOTIFY: u32 = 0x100;
    // WM_MOUSELEAVE lives in Controls in the cached bindings.
    const WM_MOUSELEAVE: u32 = 0x02A3;
    thread_local! { static HANDLES: RefCell<[Option<Rc<Handle>>; 2]> = const { RefCell::new([None, None]) }; }
    #[derive(Clone, Copy)]
    struct Drag { session: u64, x: f64 }
    struct Handle { app: AppHandle, parent: HWND, hwnd: HWND, index: usize, alive: Cell<bool>, scale: Cell<f64>, rect: Cell<Option<Rect>>, colors: Cell<Colors>, hover: Cell<bool>, drag: Cell<Option<Drag>> }

    unsafe fn retain(ptr: *const Handle) -> Rc<Handle> { Rc::increment_strong_count(ptr); Rc::from_raw(ptr) }
    fn current(handle: &Handle) -> bool {
        handle.alive.get() && HANDLES.with(|slots| slots.borrow()[handle.index].as_ref().is_some_and(|h| Rc::as_ptr(h) == handle as *const Handle))
    }
    unsafe fn interactive(handle: &Handle) -> bool {
        current(handle) && IsWindow(handle.hwnd) != 0 && GetParent(handle.hwnd) == handle.parent
            && IsWindowVisible(handle.hwnd) != 0 && IsWindowVisible(handle.parent) != 0 && IsWindowEnabled(handle.parent) != 0
    }
    fn event(handle: &Handle, phase: &str, drag: Drag) {
        if crate::desktop_metrics::enabled() && matches!(phase, "start" | "move" | "end" | "cancel") {
            eprintln!("hub_native_resize_diag {}", serde_json::json!({
                "side":if handle.index == 0 { "sidebar" } else { "rail" }, "phase":phase, "session":drag.session, "x":drag.x
            }));
        }
        let _ = handle.app.emit_to("main", "native-shell-resize", serde_json::json!({
            "side":if handle.index == 0 { "sidebar" } else { "rail" }, "phase":phase, "session":drag.session, "x":drag.x
        }));
    }
    unsafe fn cancel(handle: &Handle) {
        // Take before releasing capture: WM_CAPTURECHANGED must not emit twice.
        if let Some(drag) = handle.drag.take() {
            if GetCapture() == handle.hwnd { ReleaseCapture(); }
            event(handle, "cancel", drag);
        }
        handle.hover.set(false);
        if current(handle) { InvalidateRect(handle.hwnd, std::ptr::null(), 0); }
    }
    unsafe fn x(handle: &Handle, message: LPARAM) -> Option<f64> {
        if !interactive(handle) { return None; }
        let mut point = POINT { x: pointer_x(message), y: pointer_y(message) };
        // Zero can mean a valid zero offset; distinguish a reported API error.
        SetLastError(0);
        if MapWindowPoints(handle.hwnd, handle.parent, &mut point, 1) == 0 && GetLastError() != 0 { return None; }
        let result = point.x as f64 / handle.scale.get();
        (interactive(handle) && valid_x(result)).then_some(result)
    }
    unsafe fn fill(dc: windows_sys::Win32::Graphics::Gdi::HDC, rect: &RECT, rgb: [u8; 3]) {
        let brush = CreateSolidBrush(color(rgb));
        if !brush.is_null() { FillRect(dc, rect, brush); DeleteObject(brush); }
    }
    unsafe fn paint(handle: &Handle) {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let dc = BeginPaint(handle.hwnd, &mut ps);
        if !dc.is_null() {
            let mut bounds: RECT = std::mem::zeroed();
            if GetClientRect(handle.hwnd, &mut bounds) != 0 {
                let colors = handle.colors.get();
                fill(dc, &bounds, colors.background);
                let active = handle.hover.get() || handle.drag.get().is_some();
                let width = ((if active { 3.0 } else { 2.0 }) * handle.scale.get()).round() as i32;
                let width = width.max(1).min(bounds.right.max(1));
                let left = (bounds.right - width) / 2;
                fill(dc, &RECT { left, right:left + width, ..bounds }, if active { colors.active } else { colors.divider });
            }
        }
        EndPaint(handle.hwnd, &ps);
    }
    unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _: usize, data: usize) -> LRESULT {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| procedure_inner(hwnd, msg, wp, lp, data)))
            .unwrap_or_else(|_| DefSubclassProc(hwnd, msg, wp, lp))
    }
    unsafe fn procedure_inner(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, data: usize) -> LRESULT {
        let ptr = data as *const Handle;
        if ptr.is_null() { return DefSubclassProc(hwnd, msg, wp, lp); }
        let handle = retain(ptr);
        if msg == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(procedure), SUBCLASS);
            cancel(&handle); handle.alive.set(false);
            HANDLES.with(|slots| { let mut slots = slots.borrow_mut(); if slots[handle.index].as_ref().is_some_and(|h| Rc::as_ptr(h) == ptr) { slots[handle.index] = None; } });
            let result = DefSubclassProc(hwnd, msg, wp, lp);
            drop(Rc::from_raw(ptr));
            return result;
        }
        if !current(&handle) { return DefSubclassProc(hwnd, msg, wp, lp); }
        match msg {
            WM_PAINT => { paint(&handle); return 0; }
            WM_ERASEBKGND => return 1,
            WM_MOUSEACTIVATE => return MA_NOACTIVATE as isize,
            WM_SETCURSOR if interactive(&handle) => { let cursor = LoadCursorW(null_mut(), IDC_SIZEWE); if !cursor.is_null() { SetCursor(cursor); return 1; } }
            WM_LBUTTONDOWN => {
                cancel(&handle);
                if let (Some(x), Some(session)) = (x(&handle, lp), next_session(&SESSION)) {
                    SetCapture(hwnd);
                    if interactive(&handle) && GetCapture() == hwnd {
                        let drag = Drag { session, x }; handle.drag.set(Some(drag)); event(&handle, "start", drag); InvalidateRect(hwnd, std::ptr::null(), 0);
                    }
                }
                return 0; // Do not let STATIC steal the existing keyboard focus.
            }
            WM_MOUSEMOVE => {
                if let Some(mut drag) = handle.drag.get() {
                    if crate::desktop_metrics::enabled() {
                        eprintln!("hub_native_resize_diag {}", serde_json::json!({
                            "side":if handle.index == 0 { "sidebar" } else { "rail" }, "phase":"pointer_move", "session":drag.session,
                            "wp":wp, "rawx":pointer_x(lp), "rawy":pointer_y(lp)
                        }));
                    }
                    if GetCapture() != hwnd { cancel(&handle); return 0; }
                    if !primary_button(wp) { return 0; }
                    if let Some(x) = x(&handle, lp) { drag.x = x; handle.drag.set(Some(drag)); event(&handle, "move", drag); } else { cancel(&handle); }
                } else if interactive(&handle) && !handle.hover.replace(true) {
                    let mut track = TRACKMOUSEEVENT { cbSize:std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags:TME_LEAVE, hwndTrack:hwnd, dwHoverTime:0 };
                    if TrackMouseEvent(&mut track) == 0 { handle.hover.set(false); }
                    InvalidateRect(hwnd, std::ptr::null(), 0);
                }
                return 0;
            }
            WM_LBUTTONUP => {
                if let Some(mut drag) = handle.drag.take() {
                    let position = x(&handle, lp);
                    let owned = GetCapture() == hwnd;
                    if owned { ReleaseCapture(); }
                    if let Some(x) = position.filter(|_| owned && interactive(&handle)) { drag.x = x; event(&handle, "end", drag); } else { event(&handle, "cancel", drag); }
                    if current(&handle) { InvalidateRect(hwnd, std::ptr::null(), 0); }
                }
                return 0;
            }
            WM_LBUTTONDBLCLK => {
                cancel(&handle);
                if let (Some(x), Some(session)) = (x(&handle, lp), next_session(&SESSION)) { event(&handle, "reset", Drag { session, x }); }
                return 0;
            }
            WM_MOUSELEAVE => { handle.hover.set(false); InvalidateRect(hwnd, std::ptr::null(), 0); return 0; }
            WM_CANCELMODE | WM_CAPTURECHANGED => { cancel(&handle); return 0; }
            WM_KEYDOWN if wp == 27 => { cancel(&handle); return 0; }
            WM_SHOWWINDOW if wp == 0 => cancel(&handle),
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wp, lp)
    }
    unsafe fn create(app: &AppHandle, parent: HWND, index: usize, colors: Colors, scale: f64) -> Option<Rc<Handle>> {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let hwnd = CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_CHILD | WS_CLIPSIBLINGS | SS_NOTIFY as u32,
            0,0,0,0,parent,(4201 + index) as HMENU,null_mut(),null_mut());
        if hwnd.is_null() { return None; }
        let handle = Rc::new(Handle { app:app.clone(),parent,hwnd,index,alive:Cell::new(true),scale:Cell::new(scale),rect:Cell::new(None),colors:Cell::new(colors),hover:Cell::new(false),drag:Cell::new(None) });
        let ptr = Rc::into_raw(handle.clone());
        if SetWindowSubclass(hwnd, Some(procedure), SUBCLASS, ptr as usize) == 0 { drop(Rc::from_raw(ptr)); DestroyWindow(hwnd); return None; }
        HANDLES.with(|slots| slots.borrow_mut()[index] = Some(handle.clone()));
        Some(handle)
    }
    /// Re-place the shown splitters with the window's current scale (the CSS rects are unchanged).
    pub(super) fn rescale(app: &AppHandle) {
        let app = app.clone(); let scheduler = app.clone();
        let _ = scheduler.run_on_main_thread(move || unsafe {
            let Some(scale) = app.get_window("main").and_then(|w| w.scale_factor().ok()) else { return };
            let handles = HANDLES.with(|slots| slots.borrow().iter().flatten().cloned().collect::<Vec<_>>());
            for handle in handles {
                if !current(&handle) || IsWindowVisible(handle.hwnd) == 0 || handle.scale.get() == scale { continue; }
                let Some(rect) = handle.rect.get() else { continue };
                let Some((x, y, w, h)) = crate::window_fit::physical_child(rect.x, rect.y, rect.w, rect.h, scale) else { continue };
                cancel(&handle);
                if SetWindowPos(handle.hwnd, HWND_TOP, x, y, w, h, SWP_NOACTIVATE) != 0 { handle.scale.set(scale); InvalidateRect(handle.hwnd, std::ptr::null(), 0); }
            }
        });
    }
    pub(super) fn sync(app: AppHandle, rects: [Option<Rect>; 2], colors: Colors) -> Result<(), String> {
        let scheduler = app.clone();
        scheduler.run_on_main_thread(move || unsafe {
            let main = app.get_window("main");
            let parent = main.as_ref().and_then(|w| w.hwnd().ok()).map(|h| h.0 as HWND);
            let scale = main.as_ref().and_then(|w| w.scale_factor().ok()).unwrap_or(f64::NAN);
            let usable = parent.is_some_and(|h| !h.is_null() && IsWindow(h) != 0 && IsWindowEnabled(h) != 0) && scale.is_finite() && scale > 0.0 && scale <= 16.0;
            let mut available = [false; 2];
            for (index, rect) in rects.into_iter().enumerate() {
                let existing = HANDLES.with(|slots| slots.borrow()[index].clone());
                let requested = rect.filter(|_| usable);
                let handle = existing.or_else(|| requested.and_then(|_| create(&app, parent.unwrap(), index, colors, scale)));
                if let Some(handle) = handle {
                    if !current(&handle) { continue; }
                    let Some(rect) = requested.filter(|_| Some(handle.parent) == parent) else { cancel(&handle); if current(&handle) { ShowWindow(handle.hwnd, SW_HIDE); } continue; };
                    handle.scale.set(scale); handle.rect.set(Some(rect)); handle.colors.set(colors);
                    let px = |v:f64| (v * scale).round() as i32;
                    if SetWindowPos(handle.hwnd, HWND_TOP, px(rect.x), px(rect.y), px(rect.w).max(1), px(rect.h).max(1), SWP_NOACTIVATE | SWP_SHOWWINDOW) == 0 {
                        cancel(&handle); if current(&handle) { ShowWindow(handle.hwnd, SW_HIDE); } continue;
                    }
                    if interactive(&handle) { InvalidateRect(handle.hwnd, std::ptr::null(), 0); available[index] = true; } else { cancel(&handle); }
                }
            }
            ready(&app, available[0], available[1]);
        }).map_err(|_| "native_resize_unavailable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn geometry_is_bounded_and_does_not_accept_missing_space() {
        let rect = Rect { x:0.0,y:0.0,w:1.0,h:1.0 };
        assert!(valid(rect)); assert!(valid(Rect {x:32767.0,y:32767.0,w:24.0,h:32767.0}));
        for bad in [Rect {x:f64::NAN,..rect},Rect {y:f64::INFINITY,..rect},Rect {x:-1.0,..rect},Rect {w:0.999,..rect},Rect {w:24.001,..rect},Rect {h:0.0,..rect},Rect {h:32768.0,..rect}] { assert!(!valid(bad)); }
    }
    #[test] fn sessions_are_positive_nonreused_and_fail_closed_at_js_limit() {
        let counter = AtomicU64::new(0);
        assert_eq!(next_session(&counter),Some(1)); assert_eq!(next_session(&counter),Some(2));
        counter.store(SAFE_SESSION-1,Ordering::SeqCst);
        assert_eq!(next_session(&counter),Some(SAFE_SESSION)); assert_eq!(next_session(&counter),None); assert_eq!(counter.load(Ordering::SeqCst),SAFE_SESSION);
        counter.store(u64::MAX,Ordering::SeqCst); assert_eq!(next_session(&counter),None);
    }
    #[test] fn message_coordinates_are_signed_and_colors_preserve_rgb_order() {
        assert_eq!(pointer_x(0x7fff),32767); assert_eq!(pointer_x(0x8000),-32768); assert_eq!(pointer_x(0xffff),-1);
        assert_eq!(pointer_y(0xffff0000u32 as isize),-1); assert_eq!(pointer_y(0x80000000u32 as isize),-32768);
        assert_eq!(color([0x12,0x34,0x56]),0x563412);
    }
    #[test] fn logical_pointer_event_matches_ui_absolute_bound() {
        for x in [-32767.0, 0.0, 32767.0] { assert!(valid_x(x)); }
        for x in [-32767.001, 32767.001, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] { assert!(!valid_x(x)); }
    }
    #[test] fn primary_button_requires_the_left_button_bit() {
        for flags in [1, 3, usize::MAX] { assert!(primary_button(flags)); }
        for flags in [0, 2, 4, 8, 16, 32, 64, usize::MAX - 1] { assert!(!primary_button(flags)); }
    }
}
