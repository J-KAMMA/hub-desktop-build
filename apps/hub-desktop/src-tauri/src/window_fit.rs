//! Sizes the main window from the monitor it is on instead of fixed numbers.
//! The math is pure (physical pixels in, physical pixels out) so it can be tested
//! without a display; `fit_main_window` / `refit_main_window` only read the monitor
//! and apply the result.
use tauri::{Manager, PhysicalPosition, PhysicalSize};

/// Physical-pixel rectangle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect { pub x: i32, pub y: i32, pub w: u32, pub h: u32 }

/// Share of the work area a freshly placed window takes, in percent.
const FILL_PERCENT: u64 = 85;
/// Smallest usable window in logical pixels (matches tauri.conf.json minWidth/minHeight).
pub const MIN_LOGICAL: (f64, f64) = (720.0, 520.0);

fn scaled_min(scale: f64) -> (u32, u32) {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    ((MIN_LOGICAL.0 * s).ceil() as u32, (MIN_LOGICAL.1 * s).ceil() as u32)
}

/// A window of ~85% of the work area, centred, never below the minimum and never larger than the area.
pub fn fit_to_work_area(work: Rect, scale: f64) -> Rect {
    let (min_w, min_h) = scaled_min(scale);
    let w = ((u64::from(work.w) * FILL_PERCENT / 100) as u32).max(min_w).min(work.w);
    let h = ((u64::from(work.h) * FILL_PERCENT / 100) as u32).max(min_h).min(work.h);
    Rect { x: work.x + ((work.w - w) / 2) as i32, y: work.y + ((work.h - h) / 2) as i32, w, h }
}

#[cfg(test)]
fn contains(work: Rect, r: Rect) -> bool {
    i64::from(r.x) >= i64::from(work.x) && i64::from(r.y) >= i64::from(work.y)
        && i64::from(r.x) + i64::from(r.w) <= i64::from(work.x) + i64::from(work.w)
        && i64::from(r.y) + i64::from(r.h) <= i64::from(work.y) + i64::from(work.h)
}

fn overlap(a: Rect, b: Rect) -> i64 {
    let w = (i64::from(a.x) + i64::from(a.w)).min(i64::from(b.x) + i64::from(b.w)) - i64::from(a.x).max(i64::from(b.x));
    let h = (i64::from(a.y) + i64::from(a.h)).min(i64::from(b.y) + i64::from(b.h)) - i64::from(a.y).max(i64::from(b.y));
    if w > 0 && h > 0 { w * h } else { 0 }
}

/// The work area the window is actually on: the one it overlaps most, or the first (primary)
/// when it overlaps none.
pub fn home_area(r: Rect, work_areas: &[Rect]) -> Option<Rect> {
    let first = *work_areas.first()?;
    Some(work_areas.iter().copied().fold((first, 0), |best, work| {
        let area = overlap(r, work);
        if area > best.1 { (work, area) } else { best }
    }).0)
}

/// After a scale or monitor change (for instance dragging between a 150% and a 100% monitor).
/// A window that straddles two monitors is where the user is putting it, so it is left alone;
/// only a window larger than the monitor it is on is shrunk to that work area and moved inside
/// it, and a window on no monitor at all is re-fitted onto the primary one. Returns None when
/// nothing changes.
pub fn settle_after_scale_change(cur: Rect, work_areas: &[Rect], scale: f64) -> Option<Rect> {
    let first = *work_areas.first()?;
    if cur.w == 0 || cur.h == 0 || work_areas.iter().all(|work| overlap(cur, *work) == 0) {
        return Some(fit_to_work_area(first, scale)).filter(|next| *next != cur);
    }
    let work = home_area(cur, work_areas)?;
    if cur.w <= work.w && cur.h <= work.h { return None; }
    let (w, h) = (cur.w.min(work.w), cur.h.min(work.h));
    let max_x = i64::from(work.x) + i64::from(work.w - w);
    let max_y = i64::from(work.y) + i64::from(work.h - h);
    let x = i64::from(cur.x).clamp(i64::from(work.x), max_x) as i32;
    let y = i64::from(cur.y).clamp(i64::from(work.y), max_y) as i32;
    Some(Rect { x, y, w, h })
}

/// Size of a child webview that must cover the whole window while a page is full screen.
/// `inner` is the window client area as last reported; during a transition (for example
/// maximized to full screen) it can lag, so the monitor size wins when it is larger.
pub fn fullscreen_extent(inner: (u32, u32), monitor: Option<(u32, u32)>, window_is_fullscreen: bool) -> (u32, u32) {
    match monitor {
        Some((mw, mh)) if window_is_fullscreen => (mw.max(inner.0), mh.max(inner.1)),
        _ => inner,
    }
}

fn rect_of(m: &tauri::Monitor) -> Rect {
    let a = m.work_area();
    Rect { x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height }
}

fn apply(window: &tauri::WebviewWindow, r: Rect) {
    let _ = window.set_size(PhysicalSize::new(r.w, r.h));
    let _ = window.set_position(PhysicalPosition::new(r.x, r.y));
}

/// Startup: place the (normal-state) window from the current monitor. The window is configured
/// maximized, so this only decides the size it restores to; the maximized state is kept.
pub fn fit_main_window(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) else { return };
    let scale = monitor.scale_factor();
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized { let _ = window.unmaximize(); }
    apply(window, fit_to_work_area(rect_of(&monitor), scale));
    if maximized { let _ = window.maximize(); }
}

/// After a scale or monitor change: see `settle_after_scale_change`. Runs on the main thread.
/// The main window is looked up with `get_window`: once the browser or the rail has added child
/// webviews it is no longer a single-webview window and `get_webview_window("main")` returns None,
/// which silently skipped the earlier refit.
pub fn refit_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    // Never touch a window that is hidden, maximized, minimized or full screen: Windows places those.
    if !window.is_visible().unwrap_or(false) || window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) || window.is_minimized().unwrap_or(false) { return; }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else { return };
    let Ok(monitors) = window.available_monitors() else { return };
    let areas: Vec<Rect> = monitors.iter().map(rect_of).collect();
    let scale = window.scale_factor().unwrap_or(1.0);
    let cur = Rect { x: pos.x, y: pos.y, w: size.width, h: size.height };
    if let Some(next) = settle_after_scale_change(cur, &areas, scale) {
        // set_size takes the client size; the outer rect also holds the invisible resize border.
        let inner = window.inner_size().unwrap_or(size);
        let (frame_w, frame_h) = (size.width.saturating_sub(inner.width), size.height.saturating_sub(inner.height));
        let _ = window.set_size(PhysicalSize::new(next.w.saturating_sub(frame_w).max(1), next.h.saturating_sub(frame_h).max(1)));
        let _ = window.set_position(PhysicalPosition::new(next.x, next.y));
    }
}

/// Registered once at startup, whether or not the browser or the rail was ever opened.
/// The native child controls (sidebar rows, column splitters) are placed in physical pixels from
/// CSS rects; re-place them with the new scale even if the page sends no new rects. The window
/// refit runs shortly after, once the platform has applied its own DPI-change size (applying it
/// inside this event would be overwritten by that size).
pub fn watch_main_window(window: &tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    use std::sync::atomic::{AtomicU64, Ordering};
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. }) {
            crate::native_sidebar::rescale(&app);
            crate::native_shell_resize::rescale(&app);
        }
        // Also after a plain resize: restoring a window that was maximized on another monitor
        // brings back that monitor's physical size without a scale-change event.
        // And after a move, so a window never stays outside every monitor.
        if !matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)) { return; }
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if GENERATION.load(Ordering::SeqCst) != generation { return; }
            let inner = handle.clone();
            let _ = handle.run_on_main_thread(move || refit_main_window(&inner));
        });
    });
}
/// Physical child-window bounds for a CSS rect, rounded the same way as the initial placement.
pub fn physical_child(x: f64, y: f64, w: f64, h: f64, scale: f64) -> Option<(i32, i32, i32, i32)> {
    if !(scale.is_finite() && scale > 0.0 && scale <= 16.0) || ![x, y, w, h].iter().all(|v| v.is_finite()) { return None; }
    let px = |v: f64| (v * scale).round() as i32;
    Some((px(x), px(y), px(w).max(1), px(h).max(1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    const WORK_1920X1200_150: Rect = Rect { x: 0, y: 0, w: 1920, h: 1128 };

    #[test]
    fn fits_85_percent_and_centres() {
        let r = fit_to_work_area(WORK_1920X1200_150, 1.5);
        assert_eq!((r.w, r.h), (1632, 958));
        assert_eq!((r.x, r.y), (144, 85));
    }
    #[test]
    fn small_screens_clamp_to_minimum_then_to_the_area() {
        // 1024x640 logical at 100%: 85% is 870x544, above the 720x520 minimum.
        let r = fit_to_work_area(Rect { x: 0, y: 0, w: 1024, h: 640 }, 1.0);
        assert_eq!((r.w, r.h), (870, 544));
        // 800x560 logical: 85% (680x476) is below the minimum so the minimum applies.
        let r = fit_to_work_area(Rect { x: 0, y: 0, w: 800, h: 560 }, 1.0);
        assert_eq!((r.w, r.h), (720, 520));
        // Area smaller than the minimum: never exceed the area.
        let r = fit_to_work_area(Rect { x: 10, y: 20, w: 600, h: 400 }, 1.0);
        assert_eq!((r.x, r.y, r.w, r.h), (10, 20, 600, 400));
    }
    #[test]
    fn work_area_offset_is_respected() {
        let r = fit_to_work_area(Rect { x: -1920, y: 0, w: 1920, h: 1080 }, 1.0);
        assert!(r.x >= -1920 && r.x + r.w as i32 <= 0);
    }
    // The owner's desk: laptop 1920x1200 at 150% left of a primary 1920x1080 at 100% (physical px).
    const LAPTOP: Rect = Rect { x: -1920, y: -58, w: 1920, h: 1128 };
    const BIG: Rect = Rect { x: 0, y: 0, w: 1920, h: 1032 };

    #[test]
    fn the_home_monitor_is_the_one_the_window_is_on_not_the_primary() {
        // spills off the bottom of the laptop: the laptop is its monitor, not the primary
        assert_eq!(home_area(Rect { x: -1800, y: 400, w: 1500, h: 900 }, &[BIG, LAPTOP]), Some(LAPTOP));
        // mostly on the big monitor
        assert_eq!(home_area(Rect { x: -200, y: 100, w: 1200, h: 800 }, &[BIG, LAPTOP]), Some(BIG));
        // on none: primary
        assert_eq!(home_area(Rect { x: 5000, y: 5000, w: 100, h: 100 }, &[BIG, LAPTOP]), Some(BIG));
    }
    #[test]
    fn a_window_dragged_across_monitors_is_not_snapped_back() {
        // mid-drag from the laptop to the big monitor, after Windows rescaled it 150% -> 100%
        assert_eq!(settle_after_scale_change(Rect { x: -500, y: 100, w: 1088, h: 639 }, &[BIG, LAPTOP], 1.0), None);
        // and back: mid-drag to the laptop, 100% -> 150%
        assert_eq!(settle_after_scale_change(Rect { x: -900, y: 100, w: 1632, h: 958 }, &[BIG, LAPTOP], 1.5), None);
    }
    #[test]
    fn a_window_larger_than_its_monitor_after_a_scale_change_is_shrunk_inside_it() {
        // a near-full big-monitor window grows by 1.5x on the laptop: clamp to the laptop work area
        let r = settle_after_scale_change(Rect { x: -1900, y: -40, w: 2700, h: 1500 }, &[BIG, LAPTOP], 1.5).unwrap();
        assert_eq!(r, LAPTOP);
        let r = settle_after_scale_change(Rect { x: 100, y: 200, w: 1800, h: 1200 }, &[BIG, LAPTOP], 1.0).unwrap();
        assert_eq!(r, Rect { x: 100, y: 0, w: 1800, h: 1032 });
        // off every monitor: fit onto the primary
        let r = settle_after_scale_change(Rect { x: 9000, y: 0, w: 800, h: 600 }, &[BIG, LAPTOP], 1.0).unwrap();
        assert!(contains(BIG, r));
        assert_eq!(settle_after_scale_change(Rect { x: 0, y: 0, w: 800, h: 600 }, &[], 1.0), None);
    }
    #[test]
    fn child_controls_follow_the_new_scale() {
        // a sidebar row measured at CSS (80, 120, 220x36): 150% then 100%
        assert_eq!(physical_child(80.0, 120.0, 220.0, 36.0, 1.5), Some((120, 180, 330, 54)));
        assert_eq!(physical_child(80.0, 120.0, 220.0, 36.0, 1.0), Some((80, 120, 220, 36)));
        assert_eq!(physical_child(0.0, 0.0, 0.2, 0.2, 1.0), Some((0, 0, 1, 1)));
        for scale in [0.0, -1.0, f64::NAN, 17.0] { assert_eq!(physical_child(1.0, 1.0, 1.0, 1.0, scale), None); }
        assert_eq!(physical_child(f64::INFINITY, 1.0, 1.0, 1.0, 1.0), None);
    }
    #[test]
    fn fullscreen_extent_follows_the_monitor_not_a_stale_client_area() {
        // maximized client 1920x1128 while the monitor is 1920x1200 and the window is going full screen
        assert_eq!(fullscreen_extent((1920, 1128), Some((1920, 1200)), true), (1920, 1200));
        // not full screen yet: keep the client area
        assert_eq!(fullscreen_extent((1920, 1128), Some((1920, 1200)), false), (1920, 1128));
        // unknown monitor
        assert_eq!(fullscreen_extent((1280, 720), None, true), (1280, 720));
        // never shrink below the client area
        assert_eq!(fullscreen_extent((2560, 1440), Some((1920, 1080)), true), (2560, 1440));
    }
}
