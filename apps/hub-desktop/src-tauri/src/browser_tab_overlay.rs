//! Clip only the tab's child host; its position and controller Bounds stay intact.
use std::sync::atomic::{AtomicU64, Ordering};
const ERROR: &str = "browser_tab_overlay_unavailable";
static LEFT: AtomicU64 = AtomicU64::new(0);
// メイン窓のHTMLのうちページの上に重なるもの（ブラウザのメニュー、ツールチップ、候補一覧など）。
// ページ（子webviewの左上）を原点にした CSS px の矩形。その矩形だけページを切り抜き、HTMLを見せる。
// 位置は同梱UIが実測した値をそのまま使う（右上に寄せる等の推測をしない）。物理pxへは切り抜く時点の倍率で直す。
pub(super) const MAX_HOLES: usize = 16;
static HOLES: std::sync::Mutex<Vec<[f64; 4]>> = std::sync::Mutex::new(Vec::new());
pub(super) fn valid_holes(rects: &[[f64; 4]]) -> bool {
    rects.len() <= MAX_HOLES && rects.iter().all(|r| r.iter().all(|v| v.is_finite()) && (-2000.0..=8000.0).contains(&r[0]) && (-2000.0..=8000.0).contains(&r[1]) && (0.0..=8000.0).contains(&r[2]) && (0.0..=8000.0).contains(&r[3]))
}
pub(super) fn set_holes(rects: Vec<[f64; 4]>) -> Result<(), String> {
    if !valid_holes(&rects) { return Err(ERROR.into()); }
    *HOLES.lock().map_err(|_| ERROR)? = rects; Ok(())
}
fn holes() -> Vec<[f64; 4]> { HOLES.lock().map(|h| h.clone()).unwrap_or_default() }

// 動画・音楽の小窓（ミニプレーヤー）。ページの中の好きな位置にあり、利用者が動かせる。
// 位置と大きさはページ（子webviewの左上）を原点にした CSS px。その矩形だけページを切り抜く。
static MINI: [AtomicU64; 4] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
pub(super) fn valid_mini(x: f64, y: f64, width: f64, height: f64) -> bool {
    [x, y, width, height].iter().all(|v| v.is_finite()) && (-2000.0..=8000.0).contains(&x) && (-2000.0..=8000.0).contains(&y) && (0.0..=1600.0).contains(&width) && (0.0..=1200.0).contains(&height)
}
pub(super) fn set_mini(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if !valid_mini(x, y, width, height) { return Err(ERROR.into()); }
    for (slot, value) in MINI.iter().zip([x, y, width, height]) { slot.store(value.to_bits(), Ordering::SeqCst); }
    Ok(())
}
fn mini_rect() -> (f64, f64, f64, f64) {
    let [x, y, w, h] = [0, 1, 2, 3].map(|i| f64::from_bits(MINI[i].load(Ordering::SeqCst)));
    (x, y, w, h)
}
/// A page-relative CSS rect (mini player or an HTML overlay) as a hole in physical pixels, rounded outward and
/// clipped to the host, or None when it is empty or entirely outside.
fn mini_hole(x: f64, y: f64, width: f64, height: f64, scale: f64, host_w: i32, host_h: i32) -> Option<(i32, i32, i32, i32)> {
    if width <= 0.0 || height <= 0.0 || !scale.is_finite() || !(0.5..=8.0).contains(&scale) || host_w <= 0 || host_h <= 0 { return None; }
    let x0 = ((x * scale).floor() as i32).clamp(0, host_w); let y0 = ((y * scale).floor() as i32).clamp(0, host_h);
    let x1 = (((x + width) * scale).ceil() as i32).clamp(0, host_w); let y1 = (((y + height) * scale).ceil() as i32).clamp(0, host_h);
    (x1 > x0 && y1 > y0).then_some((x0, y0, x1, y1))
}

pub(super) fn valid(left: f64) -> bool { left.is_finite() && (0.0..=480.0).contains(&left) }
pub(super) fn set(left: f64) -> Result<(), String> {
    if !valid(left) { return Err(ERROR.into()); }
    LEFT.store(left.to_bits(), Ordering::SeqCst); Ok(())
}
pub(super) fn clear() { LEFT.store(0, Ordering::SeqCst); if let Ok(mut h) = HOLES.lock() { h.clear(); } for slot in &MINI { slot.store(0, Ordering::SeqCst); } }
fn edge(left: f64, scale: f64, width: i32) -> Result<i32, String> {
    if !left.is_finite() || !(0.0..=480.0).contains(&left) || !scale.is_finite() || !(0.5..=8.0).contains(&scale) || width <= 0 { return Err(ERROR.into()); }
    Ok((left * scale).ceil().min(f64::from(width)) as i32)
}

#[cfg(windows)]
pub(super) fn apply(app: &tauri::AppHandle, view: &tauri::Webview, id: u64) -> Result<(), String> {
    use tauri::Manager;
    use windows_sys::Win32::{Foundation::{HWND, RECT}, Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF}, UI::WindowsAndMessaging::{GetClientRect, GetParent, GetWindowRect, GetWindowThreadProcessId}};
    let window = app.get_window(super::MAIN_LABEL).ok_or(ERROR)?;
    let main = window.hwnd().map_err(|_| ERROR)?.0 as isize;
    let scale = window.scale_factor().map_err(|_| ERROR)?;
    let label = view.label().to_owned();
    let epoch = super::BROWSER_EPOCH.load(Ordering::SeqCst);
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |platform| {
        let result = (|| unsafe {
            if super::BROWSER_EPOCH.load(Ordering::SeqCst) != epoch || !super::with_tabs(|state| state.tabs.iter().any(|tab| tab.id == id && tab.label == label)).unwrap_or(false) { return Ok(()); }
            let core = platform.controller();
            let mut parent = windows::Win32::Foundation::HWND::default(); core.ParentWindow(&mut parent).map_err(|_| ERROR)?;
            let child = parent.0 as HWND; let main = main as HWND;
            let mut process = 0;
            GetWindowThreadProcessId(child, &mut process);
            if child.is_null() || child == main || GetParent(child) != main || process != std::process::id() { return Err(ERROR.to_owned()); }
            let left = if super::fullscreen_owner() == Some(id) || super::MODAL_OCCLUDED.load(Ordering::SeqCst) || super::reading::occluded() { 0.0 } else { f64::from_bits(LEFT.load(Ordering::SeqCst)) };
            let hidden = super::fullscreen_owner() == Some(id) || super::MODAL_OCCLUDED.load(Ordering::SeqCst) || super::reading::occluded();
            let overlays = if hidden { Vec::new() } else { holes() };
            let (mini_x, mini_y, mini_w, mini_h) = if hidden { (0.0, 0.0, 0.0, 0.0) } else { mini_rect() };
            if left == 0.0 && overlays.iter().all(|r| r[2] == 0.0 || r[3] == 0.0) && (mini_w == 0.0 || mini_h == 0.0) { return if SetWindowRgn(child, std::ptr::null_mut(), 1) != 0 { Ok(()) } else { Err(ERROR.to_owned()) }; }
            let mut client: RECT = std::mem::zeroed(); let mut outer: RECT = std::mem::zeroed();
            if GetClientRect(child, &mut client) == 0 || GetWindowRect(child, &mut outer) == 0 { return Err(ERROR.to_owned()); }
            let width = client.right.checked_sub(client.left).ok_or(ERROR)?;
            let height = client.bottom.checked_sub(client.top).ok_or(ERROR)?;
            if height <= 0 || outer.right.checked_sub(outer.left) != Some(width) || outer.bottom.checked_sub(outer.top) != Some(height) { return Err(ERROR.to_owned()); }
            let region = CreateRectRgn(edge(left, scale, width)?, 0, width, height);
            if region.is_null() { return Err(ERROR.to_owned()); }
            for (x0, y0, x1, y1) in overlays.iter().filter_map(|r| mini_hole(r[0], r[1], r[2], r[3], scale, width, height)) {
                let hole = CreateRectRgn(x0, y0, x1, y1);
                if hole.is_null() { DeleteObject(region); return Err(ERROR.to_owned()); }
                let combined = CombineRgn(region, region, hole, RGN_DIFF);
                DeleteObject(hole);
                if combined == 0 { DeleteObject(region); return Err(ERROR.to_owned()); }
            }
            if let Some((x0, y0, x1, y1)) = mini_hole(mini_x, mini_y, mini_w, mini_h, scale, width, height) {
                let hole = CreateRectRgn(x0, y0, x1, y1);
                if hole.is_null() { DeleteObject(region); return Err(ERROR.to_owned()); }
                let combined = CombineRgn(region, region, hole, RGN_DIFF);
                DeleteObject(hole);
                if combined == 0 { DeleteObject(region); return Err(ERROR.to_owned()); }
            }
            if SetWindowRgn(child, region, 1) == 0 { DeleteObject(region); return Err(ERROR.to_owned()); }
            // Windows owns the region after success, including replacing/removing it.
            Ok(())
        })();
        let _ = tx.send(result);
    }).map_err(|_| ERROR.to_owned())?;
    rx.try_recv().map_err(|_| ERROR.to_owned())?
}
#[cfg(not(windows))]
pub(super) fn apply(_: &tauri::AppHandle, _: &tauri::Webview, _: u64) -> Result<(), String> {
    if LEFT.load(Ordering::SeqCst) == 0 { Ok(()) } else { Err(ERROR.into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn physical_clip_rounds_outward_and_never_exceeds_the_host() {
        assert_eq!(edge(178.0, 1.25, 1000).unwrap(), 223);
        assert_eq!(edge(0.0, 1.0, 1000).unwrap(), 0);
        assert_eq!(edge(480.0, 8.0, 7).unwrap(), 7);
        assert_eq!(edge(480.0, 8.0, i32::MAX).unwrap(), 3840);
    }
    #[test] fn overlay_holes_follow_the_measured_rect_across_a_scale_change() {
        // The browser menu as measured on a maximized 1920x1080 window: stage 1764x988 CSS px, menu at 1396,6 (370x543).
        // The same CSS rect must cover the same part of the page at 100% and at 150%; the host is the stage size times the scale.
        let menu = [1396.0, 6.0, 370.0, 543.0];
        assert_eq!(mini_hole(menu[0], menu[1], menu[2], menu[3], 1.0, 1764, 988), Some((1396, 6, 1764, 549)));
        assert_eq!(mini_hole(menu[0], menu[1], menu[2], menu[3], 1.5, 2646, 1482), Some((2094, 9, 2646, 824)));
        // A rail tooltip that pokes 40 px into the page from the left edge.
        assert_eq!(mini_hole(-30.0, 10.0, 70.0, 30.0, 1.25, 1000, 700), Some((0, 12, 50, 50)));
        // Not anchored to the top-right: a hole stays where the HTML element is.
        assert_eq!(mini_hole(100.0, 200.0, 50.0, 20.0, 1.0, 1000, 700), Some((100, 200, 150, 220)));
    }
    #[test] fn overlay_hole_lists_are_bounded_and_finite() {
        assert!(valid_holes(&[])); assert!(valid_holes(&[[0.0, 0.0, 0.0, 0.0]; MAX_HOLES]));
        assert!(!valid_holes(&[[0.0, 0.0, 1.0, 1.0]; MAX_HOLES + 1]));
        for bad in [[f64::NAN, 0.0, 1.0, 1.0], [0.0, 0.0, -1.0, 1.0], [0.0, 0.0, 1.0, 8001.0], [-2001.0, 0.0, 1.0, 1.0], [0.0, f64::INFINITY, 1.0, 1.0]] { assert!(!valid_holes(&[bad])); assert!(set_holes(vec![bad]).is_err()); }
    }
    #[test] fn mini_hole_is_clipped_to_the_host_and_empty_when_outside() {
        assert_eq!(mini_hole(100.0, 50.0, 320.0, 180.0, 1.5, 1600, 900), Some((150, 75, 630, 345)));
        assert_eq!(mini_hole(-50.0, 800.0, 320.0, 180.0, 1.0, 1000, 900), Some((0, 800, 270, 900)));
        assert_eq!(mini_hole(2000.0, 0.0, 320.0, 180.0, 1.0, 1000, 700), None);
        assert_eq!(mini_hole(10.0, 10.0, 0.0, 180.0, 1.0, 1000, 700), None);
        assert!(valid_mini(0.0, 0.0, 0.0, 0.0)); assert!(!valid_mini(f64::NAN, 0.0, 10.0, 10.0)); assert!(!valid_mini(0.0, 0.0, 1601.0, 10.0)); assert!(!valid_mini(-2001.0, 0.0, 10.0, 10.0));
    }
    #[test] fn invalid_coordinates_and_empty_hosts_are_rejected() {
        for left in [f64::NAN, f64::INFINITY, -1.0, 480.01] { assert!(edge(left, 1.0, 100).is_err()); assert!(set(left).is_err()); }
        for scale in [f64::NAN, 0.0, 0.49, 8.01] { assert!(edge(1.0, scale, 100).is_err()); }
        for width in [0, -1, i32::MIN] { assert!(edge(1.0, 1.0, width).is_err()); }
    }
}
