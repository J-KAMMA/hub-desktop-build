//! Windows 11 Mica behind the title bar and the side columns.
//!
//! The material is applied only when the OS supports it (the effect call fails on
//! Windows 10 and older builds) and when the user's "Transparency effects" setting is on.
//! The UI sets `html[data-material="mica"]` only when this returns `true`; otherwise the
//! columns keep their solid fallback colours.
use tauri::{window::{Color, Effect, EffectsBuilder}, Manager, Theme, Window};

/// What the window must be told so the backdrop matches the app theme.
/// Mica follows the window's immersive-dark-mode attribute, and tao resets that attribute to the OS
/// app mode whenever the OS settings change unless the window has a preferred theme. So an explicit
/// app theme pins the window theme; "system" leaves it to follow the OS (the UI resolves it from
/// `prefers-color-scheme`, which must keep reporting the OS value).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plan { pub window_theme: Option<Theme>, pub dark: bool }

/// `mode` is the app's theme setting ("dark" | "light" | "system"); `dark` is the resolved app theme.
/// Any unknown mode is treated as an explicit choice of the resolved theme.
pub fn plan(mode: &str, dark: bool) -> Plan {
    let window_theme = match mode {
        "system" => None,
        _ => Some(if dark { Theme::Dark } else { Theme::Light }),
    };
    Plan { window_theme, dark }
}

fn effect_for(dark: bool) -> Effect { if dark { Effect::MicaDark } else { Effect::MicaLight } }

/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` `EnableTransparency`.
/// A missing value means the OS default, which is on.
#[cfg(windows)]
fn transparency_effects_on() -> bool {
    // Test-only: lets a capture session exercise the material without changing the OS setting.
    if std::env::var("HUB_DESKTOP_FORCE_MICA").is_ok_and(|v| v == "1") { return true; }
    use windows_sys::Win32::{Foundation::ERROR_SUCCESS, System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, REG_DWORD}};
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }
    let path = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let name = wide("EnableTransparency");
    let mut key: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_QUERY_VALUE, &mut key) } != ERROR_SUCCESS { return true; }
    let mut kind = 0u32;
    let mut data = [0u8; 4];
    let mut length = 4u32;
    let status = unsafe { RegQueryValueExW(key, name.as_ptr(), std::ptr::null_mut(), &mut kind, data.as_mut_ptr(), &mut length) };
    unsafe { RegCloseKey(key); }
    if status != ERROR_SUCCESS || kind != REG_DWORD || length != 4 { return true; }
    u32::from_le_bytes(data) != 0
}
#[cfg(not(windows))]
fn transparency_effects_on() -> bool { false }

fn set_page_background(window: &Window, color: Option<Color>) -> Result<(), String> {
    let page = window.get_webview("main").ok_or("page_webview_missing")?;
    page.set_background_color(color).map_err(|e| format!("page_background:{e}"))?;
    window.set_background_color(color).map_err(|e| format!("window_background:{e}"))
}

fn clear(window: &Window) {
    let _ = window.set_effects(EffectsBuilder::new().build());
    let _ = set_page_background(window, None);
}

/// Applies (or removes) Mica on the main window. `Ok(true)` means it is active; `Ok(false)` means
/// the OS setting is off; `Err` carries the reason the material could not be applied.
pub fn apply(window: &Window, mode: &str, dark: bool) -> Result<bool, String> {
    let plan = plan(mode, dark);
    // Theme first: the effect call below sets the dark-mode attribute again, to the same value.
    #[cfg(windows)]
    let _ = window.set_theme(plan.window_theme);
    if cfg!(not(windows)) || !transparency_effects_on() { clear(window); return Ok(false); }
    let effect = effect_for(plan.dark);
    if let Err(error) = window.set_effects(EffectsBuilder::new().effect(effect).build()) { clear(window); return Err(format!("effects:{error}")); }
    // The page must be transparent where the material should show through.
    if let Err(error) = set_page_background(window, Some(Color(0, 0, 0, 0))) { clear(window); return Err(error); }
    Ok(true)
}

#[tauri::command]
pub fn window_material(window: Window, dark: bool, mode: Option<String>) -> Result<bool, String> {
    if window.label() != "main" { return Err("window_material_main_only".into()); }
    apply(&window, mode.as_deref().unwrap_or("dark"), dark)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_theme_pins_window_theme_and_material() {
        assert_eq!(plan("dark", true), Plan { window_theme: Some(Theme::Dark), dark: true });
        assert_eq!(plan("light", false), Plan { window_theme: Some(Theme::Light), dark: false });
        assert!(matches!(effect_for(true), Effect::MicaDark));
        assert!(matches!(effect_for(false), Effect::MicaLight));
    }

    #[test]
    fn system_mode_follows_os_but_material_follows_resolved_app_theme() {
        assert_eq!(plan("system", true), Plan { window_theme: None, dark: true });
        assert_eq!(plan("system", false), Plan { window_theme: None, dark: false });
    }

    #[test]
    fn unknown_mode_is_an_explicit_choice_of_the_resolved_theme() {
        assert_eq!(plan("", false).window_theme, Some(Theme::Light));
        assert_eq!(plan("nonsense", true).window_theme, Some(Theme::Dark));
    }

    #[test]
    fn registry_read_does_not_panic() {
        // The value depends on the machine; the read itself must always succeed.
        let _ = super::transparency_effects_on();
    }
}
