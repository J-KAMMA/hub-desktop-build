//! Dev/test switch: `HUB_DESKTOP_NO_ACTIVATE=1` (read once at startup) keeps the app from
//! taking the foreground. Automatic focus/activation is skipped and the main window is shown
//! without activation at the bottom of the z-order. It is still a normal, rendering window
//! (not minimized), so CDP screenshots work. Normal launches are unaffected.
use std::sync::OnceLock;

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("HUB_DESKTOP_NO_ACTIVATE").is_ok_and(|v| v == "1"))
}

/// Runs an activating call (`set_focus`, `unminimize`) unless the switch is on.
pub fn guard(call: impl FnOnce() -> tauri::Result<()>) -> tauri::Result<()> {
    if enabled() { Ok(()) } else { call() }
}

/// Shows the main window. With the switch on: no activation, placed behind other windows.
pub fn show(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    if !enabled() { return window.show(); }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE};
        let hwnd = window.hwnd()?.0 as windows_sys::Win32::Foundation::HWND;
        unsafe {
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        // The window toolkit must also record the window as shown. Otherwise its next state
        // change (maximize, full screen) re-applies its own "hidden" flag and the window vanishes
        // (the maximize button made the app disappear). The window is already visible, so this
        // only updates that flag; while it is not focusable the call cannot activate it.
        let _ = window.set_focusable(false);
        let shown = window.show();
        let _ = window.set_focusable(true);
        unsafe {
            SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        shown
    }
    #[cfg(not(windows))]
    { window.show() }
}

#[cfg(test)]
mod tests {
    #[test]
    fn guard_runs_the_call_when_the_switch_is_off() {
        if super::enabled() { return; }
        let mut ran = false;
        super::guard(|| { ran = true; Ok(()) }).unwrap();
        assert!(ran);
    }
}
