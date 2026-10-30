//! Opt-in stdin/stdout control. No listener, page scripts, or service credentials.
use std::{io::{self, Write}, sync::{mpsc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use crate::{browser_window as browser, desktop_control_protocol::{read_request, write_reply, Action, Reply}};

const UI_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const UI_SELECT_TIMEOUT: Duration = Duration::from_secs(10);
static UI_SELECT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static UI_SELECT_PENDING: Mutex<Option<PendingUiSelect>> = Mutex::new(None);
static PROBE_ENABLED: AtomicBool = AtomicBool::new(false);
static PROBE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static PROBE_PENDING: Mutex<Option<PendingProbe>> = Mutex::new(None);
static UI_REFRESH_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static UI_REFRESH_PENDING: Mutex<Option<PendingUiRefresh>> = Mutex::new(None);

struct PendingUiRefresh {
    request_id: u64,
    tab_id: u64,
    profile: u8,
    deadline: Instant,
    sender: Option<mpsc::SyncSender<Result<(), String>>>,
}
struct UiRefreshTicket<'a> {
    slot: &'a Mutex<Option<PendingUiRefresh>>,
    request_id: u64,
    deadline: Instant,
    receiver: mpsc::Receiver<Result<(), String>>,
}
impl Drop for UiRefreshTicket<'_> {
    fn drop(&mut self) {
        let mut pending = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        if pending.as_ref().is_some_and(|entry| entry.request_id == self.request_id) { *pending = None; }
    }
}
fn begin_ui_refresh<'a>(slot: &'a Mutex<Option<PendingUiRefresh>>, sequence: &AtomicU64, enabled: bool, busy: bool, tab_id: u64, profile: u8, deadline: Instant) -> Result<UiRefreshTicket<'a>, String> {
    if !enabled { return Err("ui_refresh_forbidden".into()); }
    if tab_id == 0 || tab_id > UI_SAFE_INTEGER || profile > 1 { return Err("ui_refresh_invalid".into()); }
    if Instant::now() >= deadline { return Err("ui_refresh_timeout".into()); }
    if busy { return Err("ui_refresh_busy".into()); }
    let mut pending = slot.lock().map_err(|_| "ui_refresh_unavailable")?;
    if pending.is_some() { return Err("ui_refresh_busy".into()); }
    let request_id = allocate_ui_select(sequence).map_err(|_| "ui_refresh_exhausted")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    *pending = Some(PendingUiRefresh {request_id,tab_id,profile,deadline,sender:Some(sender)});
    Ok(UiRefreshTicket {slot,request_id,deadline,receiver})
}
fn complete_ui_refresh(slot: &Mutex<Option<PendingUiRefresh>>, enabled: bool, label: &str, request_id: u64, tab_id: u64, profile: u8, outcome: UiSelectOutcome, now: Instant) -> Result<(), String> {
    if !enabled || label != "main" { return Err("ui_refresh_forbidden".into()); }
    if request_id == 0 || request_id > UI_SAFE_INTEGER || tab_id == 0 || tab_id > UI_SAFE_INTEGER || profile > 1 { return Err("ui_refresh_invalid".into()); }
    let mut pending = slot.lock().map_err(|_| "ui_refresh_unavailable")?;
    let entry = pending.as_mut().filter(|entry| entry.request_id == request_id && entry.tab_id == tab_id && entry.profile == profile).ok_or("ui_refresh_invalid")?;
    if now >= entry.deadline { *pending = None; return Err("ui_refresh_expired".into()); }
    let sender = entry.sender.take().ok_or("ui_refresh_invalid")?;
    let result = match outcome {
        UiSelectOutcome::Applied => Ok(()),
        UiSelectOutcome::Failed => Err("ui_refresh_failed".into()),
        UiSelectOutcome::Superseded => Err("ui_refresh_superseded".into()),
    };
    sender.try_send(result).map_err(|_| "ui_refresh_unavailable".into())
}
#[tauri::command]
pub fn browser_control_refresh_ack(webview: tauri::Webview, request_id: u64, tab_id: u64, profile: u8, outcome: UiSelectOutcome) -> Result<(), String> {
    complete_ui_refresh(&UI_REFRESH_PENDING, PROBE_ENABLED.load(Ordering::SeqCst), webview.label(), request_id, tab_id, profile, outcome, Instant::now())
}
fn wait_ui_refresh(ticket: &UiRefreshTicket<'_>) -> Result<(), String> {
    let remaining = ticket.deadline.checked_duration_since(Instant::now()).ok_or("ui_refresh_timeout")?;
    let result = ticket.receiver.recv_timeout(remaining);
    if Instant::now() >= ticket.deadline { return Err("ui_refresh_timeout".into()); }
    result.map_err(|_| "ui_refresh_unavailable")?
}
fn emit_ui_refresh(app: &AppHandle, request_id: u64, tab_id: u64, profile: u8, deadline: Instant) -> Result<(), String> {
    on_main(app, move |handle| {
        let expires_at = probe_expiry(Instant::now(), SystemTime::now(), deadline)
            .map_err(|error| if error == "probe_profile_timeout" { "ui_refresh_timeout" } else { "ui_refresh_invalid" })?;
        if Instant::now() >= deadline { return Err("ui_refresh_timeout".into()); }
        handle.emit_to("main", "browser-control-refresh", json!({"requestId":request_id,"tabId":tab_id,"profile":profile,"expiresAt":expires_at})).map_err(|_| "dispatch_failed".into())
    })
}

struct PendingProbe {
    request_id: u64,
    profile: u8,
    deadline: Instant,
    sender: Option<mpsc::SyncSender<Result<u64, String>>>,
}
struct ProbeTicket<'a> {
    slot: &'a Mutex<Option<PendingProbe>>,
    request_id: u64,
    deadline: Instant,
    receiver: mpsc::Receiver<Result<u64, String>>,
}
impl Drop for ProbeTicket<'_> {
    fn drop(&mut self) {
        let mut pending = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        if pending.as_ref().is_some_and(|entry| entry.request_id == self.request_id) { *pending = None; }
    }
}
fn begin_probe<'a>(slot: &'a Mutex<Option<PendingProbe>>, sequence: &AtomicU64, enabled: bool, selection_pending: bool, profile: u8, deadline: Instant) -> Result<ProbeTicket<'a>, String> {
    if !enabled { return Err("probe_profile_forbidden".into()); }
    if profile > 1 { return Err("probe_profile_invalid".into()); }
    if selection_pending { return Err("probe_profile_busy".into()); }
    let mut pending = slot.lock().map_err(|_| "probe_profile_unavailable")?;
    if pending.is_some() { return Err("probe_profile_busy".into()); }
    let request_id = sequence.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current|
        current.checked_add(1).filter(|next| *next <= UI_SAFE_INTEGER))
        .map(|previous| previous + 1).map_err(|_| "probe_profile_exhausted")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    *pending = Some(PendingProbe { request_id, profile, deadline, sender: Some(sender) });
    Ok(ProbeTicket { slot, request_id, deadline, receiver })
}
fn complete_probe(slot: &Mutex<Option<PendingProbe>>, enabled: bool, label: &str, request_id: u64, profile: u8, accepted: bool, fallback_count: u64, now: Instant) -> Result<(), String> {
    if !enabled || label != "main" { return Err("probe_profile_forbidden".into()); }
    if request_id == 0 || request_id > UI_SAFE_INTEGER || profile > 1 || fallback_count > UI_SAFE_INTEGER { return Err("probe_profile_invalid".into()); }
    let mut pending = slot.lock().map_err(|_| "probe_profile_unavailable")?;
    let entry = pending.as_mut().filter(|entry| entry.request_id == request_id && entry.profile == profile).ok_or("probe_profile_invalid")?;
    if now >= entry.deadline { *pending = None; return Err("probe_profile_expired".into()); }
    let sender = entry.sender.take().ok_or("probe_profile_invalid")?;
    let result = if !accepted { Err("probe_profile_rejected".into()) }
        else if fallback_count == UI_SAFE_INTEGER { Err("probe_profile_exhausted".into()) }
        else { Ok(fallback_count) };
    sender.try_send(result).map_err(|_| "probe_profile_unavailable".into())
}
#[tauri::command]
pub fn browser_probe_profile_ack(webview: tauri::Webview, request_id: u64, profile: u8, accepted: bool, fallback_count: u64) -> Result<(), String> {
    complete_probe(&PROBE_PENDING, PROBE_ENABLED.load(Ordering::SeqCst), webview.label(), request_id, profile, accepted, fallback_count, Instant::now())
}
fn wait_probe(ticket: &ProbeTicket<'_>) -> Result<u64, String> {
    let remaining = ticket.deadline.checked_duration_since(Instant::now()).ok_or("probe_profile_timeout")?;
    let result = ticket.receiver.recv_timeout(remaining);
    if Instant::now() >= ticket.deadline { return Err("probe_profile_timeout".into()); }
    result.map_err(|_| "probe_profile_unavailable")?
}
fn probe_expiry(now: Instant, epoch: SystemTime, deadline: Instant) -> Result<u64, String> {
    if now >= deadline { return Err("probe_profile_timeout".into()); }
    let remaining = deadline.duration_since(now);
    let millis = epoch.checked_add(remaining).ok_or("probe_profile_invalid")?
        .duration_since(UNIX_EPOCH).map_err(|_| "probe_profile_invalid")?.as_millis();
    u64::try_from(millis).ok().filter(|value| *value > 0 && *value <= UI_SAFE_INTEGER).ok_or_else(|| "probe_profile_invalid".into())
}
fn emit_probe(app: &AppHandle, request_id: u64, profile: u8, deadline: Instant) -> Result<(), String> {
    on_main(app, move |handle| {
        let expires_at = probe_expiry(Instant::now(), SystemTime::now(), deadline)?;
        if Instant::now() >= deadline { return Err("probe_profile_timeout".into()); }
        handle.emit_to("main", "hub:browser-probe-profile", json!({"requestId":request_id,"profile":profile,"expiresAt":expires_at})).map_err(|_| "dispatch_failed".into())
    })
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiSelectOutcome { Applied, Failed, Superseded }

struct PendingUiSelect {
    request_id: u64,
    tab_id: u64,
    deadline: Instant,
    sender: Option<mpsc::SyncSender<Result<(), String>>>,
}

struct UiSelectTicket<'a> {
    slot: &'a Mutex<Option<PendingUiSelect>>,
    request_id: u64,
    deadline: Instant,
    receiver: mpsc::Receiver<Result<(), String>>,
}

impl Drop for UiSelectTicket<'_> {
    fn drop(&mut self) {
        let mut pending = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        if pending.as_ref().is_some_and(|entry| entry.request_id == self.request_id) { *pending = None; }
    }
}

fn allocate_ui_select(sequence: &AtomicU64) -> Result<u64, String> {
    sequence.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current|
        current.checked_add(1).filter(|next| *next <= UI_SAFE_INTEGER))
        .map(|previous| previous + 1).map_err(|_| "ui_select_exhausted".into())
}

fn begin_ui_select<'a>(slot: &'a Mutex<Option<PendingUiSelect>>, sequence: &AtomicU64, tab_id: u64, deadline: Instant) -> Result<UiSelectTicket<'a>, String> {
    if tab_id == 0 || tab_id > UI_SAFE_INTEGER { return Err("invalid_id".into()); }
    let mut pending = slot.lock().map_err(|_| "ui_select_unavailable")?;
    if pending.is_some() { return Err("ui_select_busy".into()); }
    let request_id = allocate_ui_select(sequence)?;
    let (sender, receiver) = mpsc::sync_channel(1);
    *pending = Some(PendingUiSelect { request_id, tab_id, deadline, sender: Some(sender) });
    Ok(UiSelectTicket { slot, request_id, deadline, receiver })
}

fn complete_ui_select(slot: &Mutex<Option<PendingUiSelect>>, label: &str, request_id: u64, tab_id: u64, outcome: UiSelectOutcome, now: Instant) -> Result<(), String> {
    if label != "main" { return Err("ui_select_forbidden".into()); }
    if request_id == 0 || request_id > UI_SAFE_INTEGER || tab_id == 0 || tab_id > UI_SAFE_INTEGER { return Err("ui_select_invalid".into()); }
    let mut pending = slot.lock().map_err(|_| "ui_select_unavailable")?;
    let entry = pending.as_mut().filter(|entry| entry.request_id == request_id && entry.tab_id == tab_id).ok_or("ui_select_invalid")?;
    if now >= entry.deadline { *pending = None; return Err("ui_select_expired".into()); }
    let sender = entry.sender.take().ok_or("ui_select_invalid")?;
    let result = match outcome {
        UiSelectOutcome::Applied => Ok(()),
        UiSelectOutcome::Failed => Err("ui_select_failed".into()),
        UiSelectOutcome::Superseded => Err("ui_select_superseded".into()),
    };
    sender.try_send(result).map_err(|_| "ui_select_unavailable".into())
}

#[tauri::command]
pub fn browser_control_select_ack(webview: tauri::Webview, request_id: u64, tab_id: u64, outcome: UiSelectOutcome) -> Result<(), String> {
    complete_ui_select(&UI_SELECT_PENDING, webview.label(), request_id, tab_id, outcome, Instant::now())
}

fn wait_ui_select(ticket: &UiSelectTicket<'_>) -> Result<(), String> {
    let remaining = ticket.deadline.checked_duration_since(Instant::now()).ok_or("operation_timeout")?;
    let result = ticket.receiver.recv_timeout(remaining);
    if Instant::now() >= ticket.deadline { return Err("operation_timeout".into()); }
    result.map_err(|_| "ui_select_unavailable")?
}

fn wait_selected_after_ui(app: &AppHandle, tab_id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let remaining = deadline.checked_duration_since(Instant::now()).ok_or("operation_timeout")?;
        let (tx, rx) = mpsc::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result: Result<Value, String> = if Instant::now() >= deadline { Err("operation_timeout".into()) } else { Ok(browser::control_status(&handle)) };
            let _ = tx.send(result);
        }).map_err(|_| "dispatch_failed")?;
        let value = rx.recv_timeout(remaining).map_err(|_| "operation_timeout")??;
        if Instant::now() >= deadline { return Err("operation_timeout".into()); }
        if value["visible"] != true || value["activeTabId"].as_u64() != Some(tab_id) { return Err("ui_select_superseded".into()); }
        if active_ready(&value) { return Ok(value); }
        std::thread::sleep(Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())));
    }
}

fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || { let _ = tx.send(f(handle)); }).map_err(|_| "dispatch_failed")?;
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "dispatch_timeout")?
}

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn SetForegroundWindow(window: *mut std::ffi::c_void) -> i32;
    fn GetForegroundWindow() -> *mut std::ffi::c_void;
}

#[cfg(windows)]
fn confirm_owned_foreground(window: *mut std::ffi::c_void, request: impl FnOnce(*mut std::ffi::c_void) -> bool, current: impl FnOnce() -> *mut std::ffi::c_void) -> bool {
    !window.is_null() && request(window) && current() == window
}

#[cfg(windows)]
fn focus_main_window(window: &tauri::Window) -> Result<(), String> {
    let handle = window.hwnd().map_err(|_| "app_focus_failed")?.0;
    if confirm_owned_foreground(handle, |handle| unsafe { SetForegroundWindow(handle) != 0 }, || unsafe { GetForegroundWindow() }) {
        Ok(())
    } else {
        Err("app_focus_failed".into())
    }
}

fn status(app: &AppHandle) -> Result<Value, String> {
    on_main(app, |handle| Ok(browser::control_status(&handle)))
}

fn wait_for(app: &AppHandle, test: impl Fn(&Value) -> bool) -> Result<Value, String> {
    let start = Instant::now();
    loop {
        let value = status(app)?;
        if test(&value) { return Ok(value); }
        if start.elapsed() >= Duration::from_secs(10) { return Err("operation_timeout".into()); }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn active_ready(value: &Value) -> bool {
    value["visible"] == true && value["tabs"].as_array().is_some_and(|tabs| tabs.iter().any(|tab|
        tab["active"] == true && tab["viewExists"] == true && tab["discarded"] == false))
}

fn perform(app: &AppHandle, action: Action) -> Result<Value, String> {
    match action {
        Action::Status {} => status(app),
        Action::UiMetrics {} => crate::desktop_metrics::observe(app),
        Action::ShellInspect {} => crate::shell_control::dispatch(app, None, UI_SELECT_PENDING.lock().map_err(|_| "shell_control_unavailable")?.is_some() || UI_REFRESH_PENDING.lock().map_err(|_| "shell_control_unavailable")?.is_some() || PROBE_PENDING.lock().map_err(|_| "shell_control_unavailable")?.is_some()),
        Action::WorkspaceSelect { path } => {
            crate::dev_cli::set_workspace(&path).map_err(|_| "workspace_select_failed".to_owned())?;
            Ok(json!({"workspaceSelected":true}))
        }
        Action::TabMediaStatus { tab_id } => on_main(app, move |handle| {
            let main=control_main_webview(&handle)?;
            let snapshot=browser::browser_workspace_snapshot(main)?;
            media_metadata_from_snapshot(serde_json::to_value(snapshot).map_err(|_|"tab_media_unavailable")?,tab_id)
        }).map_err(|error| control_media_error(&error)),
        Action::TabSetMuted { tab_id, muted } => {
            // perform runs on the stdin-owned thread. Keep the UI event loop free for with_webview callbacks.
            let snapshot=tauri::async_runtime::block_on(async {
                control_media_timeout(control_set_muted(app.clone(),tab_id,muted),CONTROL_MEDIA_TIMEOUT).await
            })
                .map_err(|error|control_media_error(&error))?;
            media_metadata_from_snapshot(serde_json::to_value(snapshot).map_err(|_|"tab_media_unavailable")?,tab_id)
        }
        Action::WorkspacePaths { query, limit, kind } => {
            on_main(app, |handle| control_main_webview(&handle).map(|_|())).map_err(|_|"native_window_required")?;
            let root=crate::dev_cli::workspace().ok_or("pi_work_paths_workspace_unavailable")?;
            let display=crate::pi_work::non_verbatim(root);
            let cwd=display.to_str().ok_or("pi_work_paths_unavailable")?;
            let value=crate::workspace_paths::query(cwd,&query,limit,kind.as_deref(),None).map_err(|error|control_paths_error(&error))?;
            control_paths_reply(value)
        }
        Action::BrowserDownloadHistory {tab_id,open} => {
            let window=on_main(app,|handle|control_main_webview(&handle))?;
            if open { tauri::async_runtime::block_on(crate::browser_window::browser_download_history(app.clone(),window,tab_id)) }
            else { tauri::async_runtime::block_on(crate::browser_window::browser_download_history_close(app.clone(),window,tab_id)) }
        }
        Action::BrowserReaderFixture {port}=>tauri::async_runtime::block_on(reader_fixture(app.clone(),port)),
        Action::BrowserAiFixture {port}=>tauri::async_runtime::block_on(crate::browser_ai_control::fixture(app.clone(),port)),
        Action::ShellLayout { view, sidebar_open, rail_open } => crate::shell_control::dispatch(app, Some(crate::shell_control::ShellLayout { view, sidebar_open, rail_open }), UI_SELECT_PENDING.lock().map_err(|_| "shell_control_unavailable")?.is_some() || UI_REFRESH_PENDING.lock().map_err(|_| "shell_control_unavailable")?.is_some() || PROBE_PENDING.lock().map_err(|_| "shell_control_unavailable")?.is_some()),
        Action::BrowserProbeProfile { profile } => {
            let deadline = Instant::now() + UI_SELECT_TIMEOUT;
            let selection_pending = UI_SELECT_PENDING.lock().map_err(|_| "probe_profile_unavailable")?.is_some()
                || UI_REFRESH_PENDING.lock().map_err(|_| "probe_profile_unavailable")?.is_some() || crate::shell_control::is_pending();
            let ticket = begin_probe(&PROBE_PENDING, &PROBE_SEQUENCE, PROBE_ENABLED.load(Ordering::SeqCst), selection_pending, profile, deadline)?;
            emit_probe(app, ticket.request_id, profile, deadline)?;
            let fallback_count = wait_probe(&ticket)?;
            Ok(json!({"accepted":true,"profile":profile,"fallbackCount":fallback_count}))
        }
        Action::BrowserOpen {} => {
            // An early launch request can precede the bundled UI's event listener.
            // Repeat only until that UI reports browser entry, never create tabs here.
            app.emit_to("main", "browser-open-request", json!({})).map_err(|_| "dispatch_failed")?;
            let start = Instant::now();
            while status(app)?["visible"] != true {
                app.emit_to("main", "browser-open-request", json!({})).map_err(|_| "dispatch_failed")?;
                if start.elapsed() >= Duration::from_secs(10) { return Err("ui_not_ready".into()); }
                std::thread::sleep(Duration::from_millis(100));
            }
            wait_for(app, active_ready)
        }
        Action::TabNew {} | Action::TabNewPrivate {} => {
            let private = matches!(action, Action::TabNewPrivate {});
            let before = status(app)?;
            if before["visible"] != true { return Err("browser_not_visible".into()); }
            let ids: Vec<u64> = before["tabs"].as_array().ok_or("status_unavailable")?.iter().filter_map(|t| t["id"].as_u64()).collect();
            on_main(app, move |handle| if private { browser::control_new_private_tab(handle) } else { browser::browser_new_tab(handle, None) })?;
            let value = wait_for(app, |s| active_ready(s) && s["tabs"].as_array().is_some_and(|tabs|
                tabs.iter().any(|t| t["id"].as_u64().is_some_and(|id| !ids.contains(&id)) && t["private"] == private)))?;
            let new: Vec<_> = value["tabs"].as_array().ok_or("status_unavailable")?.iter()
                .filter(|t| t["id"].as_u64().is_some_and(|id| !ids.contains(&id))).collect();
            if new.len() != 1 || new[0]["blank"] != true || new[0]["private"] != private { return Err("concurrent_change".into()); }
            if private { crate::browser_ai_control::record_private_tab(new[0]["id"].as_u64().ok_or("status_unavailable")?); }
            Ok(json!({"tabId": new[0]["id"], "state": value}))
        }
        Action::TabActivate { tab_id } => {
            if status(app)?["visible"] != true { return Err("browser_not_visible".into()); }
            on_main(app, move |handle| browser::browser_activate_tab(handle, tab_id))?;
            wait_for(app, |s| active_ready(s) && s["activeTabId"].as_u64() == Some(tab_id))
        }
        Action::TabSelect { tab_id } => {
            if UI_REFRESH_PENDING.lock().map_err(|_| "ui_select_unavailable")?.is_some() || crate::shell_control::is_pending() { return Err("ui_select_busy".into()); }
            if tab_id == 0 || tab_id > UI_SAFE_INTEGER { return Err("invalid_id".into()); }
            let before = status(app)?;
            if before["visible"] != true { return Err("browser_not_visible".into()); }
            if !before["tabs"].as_array().is_some_and(|tabs| tabs.iter().any(|t| t["id"].as_u64() == Some(tab_id))) {
                return Err("tab_not_found".into());
            }
            let deadline = Instant::now().checked_add(UI_SELECT_TIMEOUT).ok_or("ui_select_unavailable")?;
            let expires_at = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "ui_select_unavailable")?.as_millis())
                .ok().and_then(|now| now.checked_add(10_000)).filter(|expires| *expires <= UI_SAFE_INTEGER).ok_or("ui_select_unavailable")?;
            let ticket = begin_ui_select(&UI_SELECT_PENDING, &UI_SELECT_SEQUENCE, tab_id, deadline)?;
            app.emit_to("main", "browser-control-select", json!({"requestId":ticket.request_id,"tabId":tab_id,"expiresAt":expires_at})).map_err(|_| "dispatch_failed")?;
            wait_ui_select(&ticket)?;
            wait_selected_after_ui(app, tab_id, deadline)
        }
        Action::BrowserUiRefresh { tab_id, profile } => {
            let before = status(app)?;
            if !active_ready(&before) || before["activeTabId"].as_u64() != Some(tab_id) { return Err("ui_refresh_context_changed".into()); }
            let deadline = Instant::now().checked_add(UI_SELECT_TIMEOUT).ok_or("ui_refresh_unavailable")?;
            let busy = UI_SELECT_PENDING.lock().map_err(|_| "ui_refresh_unavailable")?.is_some()
                || PROBE_PENDING.lock().map_err(|_| "ui_refresh_unavailable")?.is_some() || crate::shell_control::is_pending();
            let ticket = begin_ui_refresh(&UI_REFRESH_PENDING, &UI_REFRESH_SEQUENCE, PROBE_ENABLED.load(Ordering::SeqCst), busy, tab_id, profile, deadline)?;
            emit_ui_refresh(app, ticket.request_id, tab_id, profile, deadline)?;
            wait_ui_refresh(&ticket)?;
            wait_selected_after_ui(app, tab_id, deadline)
        }
        Action::TabClose { tab_id } => {
            on_main(app, move |handle| browser::browser_close_tab(handle, tab_id))?;
            wait_for(app, |s| s["tabs"].as_array().is_some_and(|tabs| tabs.iter().all(|t| t["id"].as_u64() != Some(tab_id))))
        }
        Action::SessionRestore {} => {
            if status(app)?["visible"] != true { return Err("browser_not_visible".into()); }
            on_main(app, browser::browser_restore_session)?;
            wait_for(app, active_ready)
        }
        Action::TabsMenuOpen {} | Action::TabsMenuClose {} => {
            if status(app)?["visible"] != true { return Err("browser_not_visible".into()); }
            let shortcut = if matches!(action, Action::TabsMenuOpen {}) { "tabs" } else { "tabs-close" };
            app.emit_to("main", "browser-shortcut", shortcut).map_err(|_| "dispatch_failed")?;
            Ok(json!({"accepted": true}))
        }
        Action::AppFocus {} => on_main(app, |handle| {
            let window = handle.get_window("main").ok_or("app_window_unavailable")?;
            #[cfg(windows)]
            focus_main_window(&window)?;
            #[cfg(not(windows))]
            window.set_focus().map_err(|_| "app_focus_failed")?;
            Ok(json!({"accepted": true}))
        }),
        Action::AppClose {} => Ok(json!({"accepted": true})),
    }
}

pub fn start(app: AppHandle) {
    PROBE_ENABLED.store(true, Ordering::SeqCst);
    crate::shell_control::enable_control();
    crate::browser_ai_control::enable_control();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let stdout = io::stdout();
        {
            let mut output = stdout.lock();
            if writeln!(output, "{}", json!({"protocol":1,"ready":true,"pid":std::process::id()})).and_then(|_| output.flush()).is_err() { return; }
        }
        loop {
            let request = match read_request(&mut input) {
                Ok(Some(request)) => request,
                Ok(None) => break,
                Err(error) => {
                    if write_reply(&mut stdout.lock(), &Reply::error(None, error.code())).is_err() { break; }
                    if error.code() == "io_error" { break; }
                    continue;
                }
            };
            let close = matches!(request.action, Action::AppClose {});
            let reply = match perform(&app, request.action) {
                Ok(value) => Reply::success(request.id, value),
                Err(error) => Reply::error(Some(request.id), &error),
            };
            if write_reply(&mut stdout.lock(), &reply).is_err() { break; }
            if close {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || { if let Some(window) = handle.get_window("main") { let _ = window.close(); } });
                break;
            }
        }
        // EOF detaches the controller; it never closes the user's app or work.
    });
}

#[cfg(test)]
mod ui_select_ack_tests {
    use super::*;

    fn deadline() -> Instant { Instant::now() + UI_SELECT_TIMEOUT }

    #[test]
    fn request_sequence_is_exact_safe_and_never_wraps_or_reuses() {
        let sequence = AtomicU64::new(0);
        assert_eq!(allocate_ui_select(&sequence), Ok(1));
        sequence.store(UI_SAFE_INTEGER - 1, Ordering::SeqCst);
        assert_eq!(allocate_ui_select(&sequence), Ok(UI_SAFE_INTEGER));
        assert_eq!(allocate_ui_select(&sequence), Err("ui_select_exhausted".into()));
        assert_eq!(sequence.load(Ordering::SeqCst), UI_SAFE_INTEGER);
        sequence.store(u64::MAX, Ordering::SeqCst);
        assert_eq!(allocate_ui_select(&sequence), Err("ui_select_exhausted".into()));
        assert_eq!(sequence.load(Ordering::SeqCst), u64::MAX);
    }

    #[test]
    fn unsafe_tab_ids_never_allocate_and_only_one_request_can_be_pending() {
        let slot = Mutex::new(None); let sequence = AtomicU64::new(0);
        for tab_id in [0, UI_SAFE_INTEGER + 1, u64::MAX] {
            assert!(matches!(begin_ui_select(&slot, &sequence, tab_id, deadline()), Err(error) if error == "invalid_id"));
        }
        assert_eq!(sequence.load(Ordering::SeqCst), 0);
        let ticket = begin_ui_select(&slot, &sequence, UI_SAFE_INTEGER, deadline()).unwrap();
        assert!(matches!(begin_ui_select(&slot, &sequence, 2, deadline()), Err(error) if error == "ui_select_busy"));
        assert_eq!(sequence.load(Ordering::SeqCst), 1);
        drop(ticket); assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn ack_requires_exact_main_nonce_id_and_rejects_duplicate() {
        let slot = Mutex::new(None); let sequence = AtomicU64::new(0);
        let ticket = begin_ui_select(&slot, &sequence, 7, deadline()).unwrap();
        for label in ["", "Main", "main-child", "browser-tab-1", "harness", "browser", "games"] {
            assert_eq!(complete_ui_select(&slot, label, ticket.request_id, 7, UiSelectOutcome::Applied, Instant::now()), Err("ui_select_forbidden".into()));
        }
        for (request_id, tab_id) in [(0,7),(2,7),(1,8),(UI_SAFE_INTEGER+1,7),(1,u64::MAX)] {
            assert_eq!(complete_ui_select(&slot, "main", request_id, tab_id, UiSelectOutcome::Applied, Instant::now()), Err("ui_select_invalid".into()));
        }
        assert_eq!(complete_ui_select(&slot, "main", ticket.request_id, 7, UiSelectOutcome::Applied, Instant::now()), Ok(()));
        assert_eq!(complete_ui_select(&slot, "main", ticket.request_id, 7, UiSelectOutcome::Applied, Instant::now()), Err("ui_select_invalid".into()));
        assert_eq!(wait_ui_select(&ticket), Ok(()));
        drop(ticket); assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn known_negative_completion_is_immediate_and_never_positive() {
        for (outcome, error) in [(UiSelectOutcome::Failed,"ui_select_failed"),(UiSelectOutcome::Superseded,"ui_select_superseded")] {
            let slot = Mutex::new(None); let sequence = AtomicU64::new(0);
            let ticket = begin_ui_select(&slot, &sequence, 1, deadline()).unwrap();
            assert_eq!(complete_ui_select(&slot, "main", ticket.request_id, 1, outcome, Instant::now()), Ok(()));
            assert_eq!(wait_ui_select(&ticket), Err(error.into()));
            drop(ticket); assert!(slot.lock().unwrap().is_none());
        }
    }

    #[test]
    fn deadline_timeout_and_late_completion_clear_and_cannot_complete_next_request() {
        let slot = Mutex::new(None); let sequence = AtomicU64::new(0);
        let expired = Instant::now() - Duration::from_millis(1);
        let ticket = begin_ui_select(&slot, &sequence, 1, expired).unwrap();
        assert_eq!(wait_ui_select(&ticket), Err("operation_timeout".into()));
        assert_eq!(complete_ui_select(&slot, "main", 1, 1, UiSelectOutcome::Applied, Instant::now()), Err("ui_select_expired".into()));
        drop(ticket); assert!(slot.lock().unwrap().is_none());
        let next = begin_ui_select(&slot, &sequence, 1, deadline()).unwrap();
        assert_eq!(next.request_id, 2);
        assert_eq!(complete_ui_select(&slot, "main", 1, 1, UiSelectOutcome::Applied, Instant::now()), Err("ui_select_invalid".into()));
        assert_eq!(complete_ui_select(&slot, "main", 2, 1, UiSelectOutcome::Applied, Instant::now()), Ok(()));
        assert_eq!(wait_ui_select(&next), Ok(()));
    }

    #[test]
    fn missing_ack_times_out_without_a_native_ready_fallback() {
        let slot = Mutex::new(None); let sequence = AtomicU64::new(0);
        let ticket = begin_ui_select(&slot, &sequence, 1, Instant::now() + Duration::from_millis(3)).unwrap();
        assert_eq!(wait_ui_select(&ticket), Err("operation_timeout".into()));
        drop(ticket); assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn outcome_enum_is_closed_and_drop_only_clears_its_own_request() {
        for value in ["\"applied\"","\"failed\"","\"superseded\""] { assert!(serde_json::from_str::<UiSelectOutcome>(value).is_ok()); }
        for value in ["\"Applied\"","\"completed\"","\"unknown\"","null","true","0","{}"] { assert!(serde_json::from_str::<UiSelectOutcome>(value).is_err()); }
        let slot = Mutex::new(None); let sequence = AtomicU64::new(0);
        let ticket = begin_ui_select(&slot, &sequence, 1, deadline()).unwrap();
        let (sender, _receiver) = mpsc::sync_channel(1);
        *slot.lock().unwrap() = Some(PendingUiSelect {request_id:2,tab_id:1,deadline:deadline(),sender:Some(sender)});
        drop(ticket); assert_eq!(slot.lock().unwrap().as_ref().unwrap().request_id, 2);
    }
}

#[cfg(test)]
mod ui_refresh_ack_tests {
    use super::*;
    fn deadline() -> Instant { Instant::now() + UI_SELECT_TIMEOUT }
    #[test]
    fn forbidden_invalid_busy_and_expired_never_allocate() {
        let slot = Mutex::new(None); let sequence = AtomicU64::new(0);
        for (enabled,busy,id,profile,end,code) in [(false,false,1,0,deadline(),"ui_refresh_forbidden"),(true,true,1,0,deadline(),"ui_refresh_busy"),(true,false,0,0,deadline(),"ui_refresh_invalid"),(true,false,UI_SAFE_INTEGER+1,0,deadline(),"ui_refresh_invalid"),(true,false,1,2,deadline(),"ui_refresh_invalid"),(true,false,1,0,Instant::now(),"ui_refresh_timeout")] {
            assert!(matches!(begin_ui_refresh(&slot,&sequence,enabled,busy,id,profile,end),Err(error) if error==code));
        }
        assert_eq!(sequence.load(Ordering::SeqCst),0);
        let ticket=begin_ui_refresh(&slot,&sequence,true,false,UI_SAFE_INTEGER,1,deadline()).unwrap();
        assert!(matches!(begin_ui_refresh(&slot,&sequence,true,false,1,0,deadline()),Err(error) if error=="ui_refresh_busy"));
        drop(ticket); assert!(slot.lock().unwrap().is_none());
    }
    #[test]
    fn main_enabled_and_exact_nonce_tab_profile_are_required() {
        let slot=Mutex::new(None);let sequence=AtomicU64::new(0);let ticket=begin_ui_refresh(&slot,&sequence,true,false,7,1,deadline()).unwrap();
        for (enabled,label,nonce,id,profile,code) in [(false,"main",1,7,1,"ui_refresh_forbidden"),(true,"browser-tab-7",1,7,1,"ui_refresh_forbidden"),(true,"Main",1,7,1,"ui_refresh_forbidden"),(true,"main",0,7,1,"ui_refresh_invalid"),(true,"main",2,7,1,"ui_refresh_invalid"),(true,"main",1,8,1,"ui_refresh_invalid"),(true,"main",1,7,0,"ui_refresh_invalid"),(true,"main",UI_SAFE_INTEGER+1,7,1,"ui_refresh_invalid"),(true,"main",1,7,2,"ui_refresh_invalid")] {
            assert_eq!(complete_ui_refresh(&slot,enabled,label,nonce,id,profile,UiSelectOutcome::Applied,Instant::now()),Err(code.into()));
        }
        assert_eq!(complete_ui_refresh(&slot,true,"main",1,7,1,UiSelectOutcome::Applied,Instant::now()),Ok(()));
        assert_eq!(complete_ui_refresh(&slot,true,"main",1,7,1,UiSelectOutcome::Applied,Instant::now()),Err("ui_refresh_invalid".into()));
        assert_eq!(wait_ui_refresh(&ticket),Ok(()));
    }
    #[test]
    fn negative_is_immediate_and_late_nonce_cannot_complete_next() {
        for (outcome,error) in [(UiSelectOutcome::Failed,"ui_refresh_failed"),(UiSelectOutcome::Superseded,"ui_refresh_superseded")] {
            let slot=Mutex::new(None);let sequence=AtomicU64::new(0);let ticket=begin_ui_refresh(&slot,&sequence,true,false,1,0,deadline()).unwrap();
            assert_eq!(complete_ui_refresh(&slot,true,"main",ticket.request_id,1,0,outcome,Instant::now()),Ok(()));assert_eq!(wait_ui_refresh(&ticket),Err(error.into()));drop(ticket);
            let next=begin_ui_refresh(&slot,&sequence,true,false,1,0,deadline()).unwrap();assert_eq!(next.request_id,2);
            assert_eq!(complete_ui_refresh(&slot,true,"main",1,1,0,UiSelectOutcome::Applied,Instant::now()),Err("ui_refresh_invalid".into()));
        }
    }
    #[test]
    fn deadline_equality_clears_and_received_positive_after_deadline_fails() {
        let slot=Mutex::new(None);let sequence=AtomicU64::new(0);let end=deadline();let ticket=begin_ui_refresh(&slot,&sequence,true,false,1,0,end).unwrap();
        assert_eq!(complete_ui_refresh(&slot,true,"main",1,1,0,UiSelectOutcome::Applied,end),Err("ui_refresh_expired".into()));assert!(slot.lock().unwrap().is_none());drop(ticket);
        let end=Instant::now()+Duration::from_millis(3);let ticket=begin_ui_refresh(&slot,&sequence,true,false,1,0,end).unwrap();
        assert_eq!(complete_ui_refresh(&slot,true,"main",2,1,0,UiSelectOutcome::Applied,Instant::now()),Ok(()));std::thread::sleep(Duration::from_millis(5));assert_eq!(wait_ui_refresh(&ticket),Err("ui_refresh_timeout".into()));
    }
    #[test]
    fn missing_ack_and_drop_cannot_clear_an_unrelated_ticket() {
        let slot=Mutex::new(None);let sequence=AtomicU64::new(0);let ticket=begin_ui_refresh(&slot,&sequence,true,false,1,0,Instant::now()+Duration::from_millis(3)).unwrap();assert_eq!(wait_ui_refresh(&ticket),Err("ui_refresh_timeout".into()));drop(ticket);assert!(slot.lock().unwrap().is_none());
        let ticket=begin_ui_refresh(&slot,&sequence,true,false,1,0,deadline()).unwrap();let(sender,_receiver)=mpsc::sync_channel(1);*slot.lock().unwrap()=Some(PendingUiRefresh{request_id:3,tab_id:1,profile:0,deadline:deadline(),sender:Some(sender)});drop(ticket);assert_eq!(slot.lock().unwrap().as_ref().unwrap().request_id,3);
    }
    #[test]
    fn last_safe_nonce_is_valid_and_exhaustion_never_wraps() {
        let slot=Mutex::new(None);let sequence=AtomicU64::new(UI_SAFE_INTEGER-1);let ticket=begin_ui_refresh(&slot,&sequence,true,false,1,0,deadline()).unwrap();assert_eq!(ticket.request_id,UI_SAFE_INTEGER);drop(ticket);
        assert!(matches!(begin_ui_refresh(&slot,&sequence,true,false,1,0,deadline()),Err(error) if error=="ui_refresh_exhausted"));assert_eq!(sequence.load(Ordering::SeqCst),UI_SAFE_INTEGER);
    }
}

pub(crate) fn control_main_webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    let main = app.get_webview("main").ok_or("native_window_required")?;
    let url = main.url().map_err(|_| "native_window_required")?;
    if !crate::local_pairing_address(main.label(), &url) {
        return Err("native_window_required".to_owned());
    }
    Ok(main)
}
const CONTROL_MEDIA_TIMEOUT: Duration = Duration::from_secs(20);
async fn control_media_timeout<T>(
    future: impl std::future::Future<Output = Result<T, String>>,
    duration: Duration,
) -> Result<T, String> {
    tokio::time::timeout(duration, future)
        .await
        .map_err(|_| "tab_media_unavailable".to_owned())?
}
async fn control_set_muted(
    app: AppHandle,
    tab_id: u64,
    muted: bool,
) -> Result<browser::BrowserWorkspaceSnapshot, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if !tx.is_closed() {
            let _ = tx.send(control_main_webview(&handle));
        }
    })
    .map_err(|_| "dispatch_failed")?;
    let main = rx.await.map_err(|_| "tab_media_unavailable")??;
    // The controller deadline drops this future, including the native command receiver.
    // The existing browser callback's tx.is_closed guard prevents execution after that drop.
    browser::browser_set_muted(app, main, tab_id, muted).await
}
fn control_media_error(error: &str) -> String {
    match error {
        "native_window_required"
        | "browser_tab_not_found"
        | "browser_tab_context_changed"
        | "browser_audio_unavailable"
        | "tab_media_unavailable"
        | "tab_not_found"
        | "dispatch_failed"
        | "dispatch_timeout" => error.to_owned(),
        _ => "tab_media_unavailable".to_owned(),
    }
}
fn control_paths_error(error: &str) -> String {
    match error {
        "pi_work_paths_invalid_request"
        | "pi_work_paths_unavailable"
        | "pi_work_paths_workspace_changed"
        | "pi_work_paths_workspace_unavailable"
        | "pi_work_paths_unsupported" => error.to_owned(),
        _ => "pi_work_paths_unavailable".to_owned(),
    }
}
fn control_paths_reply(value: Value) -> Result<Value, String> {
    let bytes = serde_json::to_vec(&value).map_err(|_| "pi_work_paths_unavailable")?;
    if bytes.len() > crate::desktop_control_protocol::MAX_REPLY_BYTES - 128 {
        return Err("pi_work_paths_unavailable".to_owned());
    }
    Ok(value)
}
fn media_metadata_from_snapshot(snapshot: Value, tab_id: u64) -> Result<Value, String> {
    if tab_id == 0 || tab_id > UI_SAFE_INTEGER {
        return Err("invalid_id".to_owned());
    }
    let tabs = snapshot
        .get("tabs")
        .and_then(Value::as_array)
        .ok_or("tab_media_unavailable")?;
    let mut matches = tabs
        .iter()
        .filter(|tab| tab.get("id").and_then(Value::as_u64) == Some(tab_id));
    let tab = matches.next().ok_or("browser_tab_not_found")?;
    if matches.next().is_some() {
        return Err("tab_media_unavailable".to_owned());
    }
    for field in ["muted", "playingAudio"] {
        if !tab
            .get(field)
            .is_some_and(|value| value.is_null() || value.is_boolean())
        {
            return Err("tab_media_unavailable".to_owned());
        }
    }
    if !["canMute", "canPrint"]
        .iter()
        .all(|field| tab.get(*field).is_some_and(Value::is_boolean))
    {
        return Err("tab_media_unavailable".to_owned());
    }
    let token = tab
        .get("printContextToken")
        .ok_or("tab_media_unavailable")?;
    if !token.is_null()
        && !token.as_str().is_some_and(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        })
    {
        return Err("tab_media_unavailable".to_owned());
    }
    if (tab["canMute"] == true && (tab["muted"].is_null() || tab["playingAudio"].is_null()))
        || (tab["canPrint"] == true && token.is_null())
    {
        return Err("tab_media_unavailable".to_owned());
    }
    // Never return the full snapshot: URLs, titles, history, favorites and bodies stay out of stdio.
    Ok(
        json!({"tabId":tab_id,"muted":tab["muted"],"playingAudio":tab["playingAudio"],
        "canMute":tab["canMute"],"canPrint":tab["canPrint"],"printContextToken":token}),
    )
}

#[cfg(test)]
mod media_paths_control_tests {
    use super::*;
    fn snapshot() -> Value {
        json!({"tabs":[{"id":7,"url":"https://private.invalid/","title":"private title","body":"page body",
        "muted":true,"playingAudio":false,"canMute":true,"canPrint":true,"printContextToken":"opaque-context"}],"history":["private history"],"favorites":["private favorite"]})
    }
    #[test]
    fn media_projection_is_closed_and_never_exposes_url_title_body_or_full_snapshot() {
        let metadata = media_metadata_from_snapshot(snapshot(), 7).unwrap();
        assert_eq!(
            metadata,
            json!({"tabId":7,"muted":true,"playingAudio":false,"canMute":true,"canPrint":true,"printContextToken":"opaque-context"})
        );
        let raw = serde_json::to_string(&metadata).unwrap();
        assert!(!raw.contains("private"));
        assert!(!raw.contains("body"));
        assert_eq!(metadata.as_object().unwrap().len(), 6);
        assert_eq!(
            media_metadata_from_snapshot(snapshot(), 8).unwrap_err(),
            "browser_tab_not_found"
        );
        for id in [0, UI_SAFE_INTEGER + 1, u64::MAX] {
            assert_eq!(
                media_metadata_from_snapshot(snapshot(), id).unwrap_err(),
                "invalid_id"
            );
        }
    }
    #[test]
    fn unsupported_media_stays_unknown_and_malformed_metadata_is_not_a_positive_result() {
        let unknown = json!({"tabs":[{"id":7,"muted":null,"playingAudio":null,"canMute":false,"canPrint":false,"printContextToken":null}]});
        let value = media_metadata_from_snapshot(unknown, 7).unwrap();
        assert!(value["muted"].is_null());
        assert_eq!(value["canMute"], false);
        for (key, value) in [
            ("muted", json!("true")),
            ("playingAudio", json!(1)),
            ("canMute", json!(null)),
            ("canPrint", json!(1)),
            ("printContextToken", json!(null)),
            ("printContextToken", json!("with space")),
            ("printContextToken", json!("日")),
            ("printContextToken", json!("a".repeat(129))),
        ] {
            let mut malformed = snapshot();
            malformed["tabs"][0][key] = value;
            assert!(media_metadata_from_snapshot(malformed, 7).is_err());
        }
        let mut duplicate = snapshot();
        let first = duplicate["tabs"][0].clone();
        duplicate["tabs"].as_array_mut().unwrap().push(first);
        assert!(media_metadata_from_snapshot(duplicate, 7).is_err());
        assert!(media_metadata_from_snapshot(json!({"tabs":[]}), 7).is_err());
        assert!(media_metadata_from_snapshot(json!({"tabs":[{"id":7}]}), 7).is_err());
    }
    #[tokio::test]
    async fn bounded_media_timeout_drops_unfinished_work_and_never_returns_success() {
        struct Pending(std::sync::Arc<AtomicBool>);
        impl std::future::Future for Pending {
            type Output = Result<Value, String>;
            fn poll(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Self::Output> {
                std::task::Poll::Pending
            }
        }
        impl Drop for Pending {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        assert_eq!(CONTROL_MEDIA_TIMEOUT, Duration::from_secs(20));
        let dropped = std::sync::Arc::new(AtomicBool::new(false));
        let result =
            control_media_timeout(Pending(std::sync::Arc::clone(&dropped)), Duration::ZERO).await;
        assert_eq!(result, Err("tab_media_unavailable".to_owned()));
        assert!(dropped.load(Ordering::SeqCst));
    }
    #[test]
    fn oversized_paths_become_a_fixed_error_reply_and_keep_the_controller_frame_writable() {
        let limit = crate::desktop_control_protocol::MAX_REPLY_BYTES - 128;
        let exact = json!("x".repeat(limit - 2));
        assert_eq!(serde_json::to_vec(&exact).unwrap().len(), limit);
        let value = control_paths_reply(exact).unwrap();
        let mut bytes = Vec::new();
        write_reply(&mut bytes, &Reply::success(u64::MAX, value)).unwrap();
        assert!(bytes.len() <= crate::desktop_control_protocol::MAX_REPLY_BYTES + 1);
        let oversized = json!({"workspacePath":"日".repeat(32768),"entries":[],"readOnly":true,"truncated":false});
        let error = control_paths_reply(oversized).unwrap_err();
        assert_eq!(error, "pi_work_paths_unavailable");
        let mut bytes = Vec::new();
        write_reply(&mut bytes, &Reply::error(Some(1), &error)).unwrap();
        write_reply(&mut bytes, &Reply::success(2, json!({"ready":true}))).unwrap();
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 2);
        assert_eq!(
            control_paths_reply(json!("x".repeat(limit - 1))).unwrap_err(),
            "pi_work_paths_unavailable"
        );
    }
    #[test]
    fn new_action_errors_have_only_static_codes_and_reply_budget_is_unchanged() {
        assert_eq!(
            control_media_error("SDK private URL /path token"),
            "tab_media_unavailable"
        );
        assert_eq!(
            control_paths_error("filesystem private /path"),
            "pi_work_paths_unavailable"
        );
        assert_eq!(
            control_media_error("browser_tab_context_changed"),
            "browser_tab_context_changed"
        );
        assert_eq!(
            control_paths_error("pi_work_paths_workspace_changed"),
            "pi_work_paths_workspace_changed"
        );
        let result = json!({"workspacePath":"synthetic","entries":[{"path":"src/a.rs","kind":"file"}],"truncated":false,"readOnly":true});
        let mut bytes = Vec::new();
        write_reply(&mut bytes, &Reply::success(1, result)).unwrap();
        assert!(bytes.len() <= crate::desktop_control_protocol::MAX_REPLY_BYTES + 1);
        let mut bytes = Vec::new();
        assert!(write_reply(&mut bytes,&Reply::success(1,json!({"workspacePath":"x".repeat(crate::desktop_control_protocol::MAX_REPLY_BYTES)}))).is_err());
        assert!(bytes.is_empty());
    }
}

const READER_FIXTURE_FAILED: &str = "reader_fixture_failed";
pub(crate) async fn fixture_main<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if !tx.is_closed() {
            let _ = tx.send(action(handle));
        }
    })
    .map_err(|_| READER_FIXTURE_FAILED)?;
    rx.await.map_err(|_| READER_FIXTURE_FAILED)?
}
pub(crate) fn fixture_tab(
    tabs: &Value,
    status: &Value,
    id: Option<u64>,
    url: &str,
) -> Result<(u64, bool), String> {
    let active = status
        .get("activeTabId")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0 && *id <= UI_SAFE_INTEGER)
        .ok_or(READER_FIXTURE_FAILED)?;
    if status["visible"] != true || id.is_some_and(|id| id != active) {
        return Err(READER_FIXTURE_FAILED.to_owned());
    }
    let raw = tabs
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["id"].as_u64() == Some(active)))
        .ok_or(READER_FIXTURE_FAILED)?;
    let row = status["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["id"].as_u64() == Some(active)))
        .ok_or(READER_FIXTURE_FAILED)?;
    let private = raw["private"].as_bool().ok_or(READER_FIXTURE_FAILED)?;
    if raw["url"].as_str() != Some(url)
        || raw["active"] != true
        || raw["discarded"] != false
        || row["active"] != true
        || row["discarded"] != false
        || row["viewExists"] != true
        || row["private"].as_bool() != Some(private)
    {
        return Err(READER_FIXTURE_FAILED.to_owned());
    }
    Ok((active, private))
}
fn fixture_mask(status: &Value, id: u64, occluded: bool) -> bool {
    let Some(row) = status["tabs"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"].as_u64() == Some(id)))
    else {
        return false;
    };
    let Some(rect) = row.get("rect") else {
        return false;
    };
    if occluded {
        return ["x", "y"].iter().all(|field| {
            rect[*field]
                .as_f64()
                .is_some_and(|value| value.is_finite() && value <= -9999.0)
        });
    }
    ["x", "y", "w", "h"].iter().all(|field| {
        match (rect[*field].as_f64(), status["stageRect"][*field].as_f64()) {
            (Some(actual), Some(expected)) => {
                actual.is_finite() && expected.is_finite() && (actual - expected).abs() <= 1.0
            }
            _ => false,
        }
    })
}
pub(crate) async fn fixture_snapshot(app: &AppHandle) -> Result<(tauri::Webview, Value, Value), String> {
    fixture_main(app, |handle| {
        let main = control_main_webview(&handle)?;
        let tabs =
            serde_json::to_value(browser::browser_tabs()).map_err(|_| READER_FIXTURE_FAILED)?;
        Ok((main, tabs, browser::control_status(&handle)))
    })
    .await
}
async fn fixture_run(
    app: &AppHandle,
    port: u16,
    token: &Mutex<Option<(tauri::Webview, String)>>,
) -> Result<(u64, bool, usize, usize, String), String> {
    if port < 1024 || port == 3020 {
        return Err(READER_FIXTURE_FAILED.to_owned());
    }
    let url = format!("http://127.0.0.1:{port}/__hub_reader_fixture");
    let (main, before, status) = fixture_snapshot(app).await?;
    let (id, private) = fixture_tab(&before, &status, None, "")?;
    fixture_main(app, move |handle| {
        let main = control_main_webview(&handle)?;
        if !browser::native_tabs_interactive() {
            return Err(READER_FIXTURE_FAILED.to_owned());
        }
        let tabs =
            serde_json::to_value(browser::browser_tabs()).map_err(|_| READER_FIXTURE_FAILED)?;
        let current = browser::control_status(&handle);
        fixture_tab(&tabs, &current, Some(id), "")?;
        let actual = handle
            .get_webview(&format!("browser-tab-{id}"))
            .and_then(|view| view.url().ok())
            .ok_or(READER_FIXTURE_FAILED)?;
        let main_url = main.url().map_err(|_| READER_FIXTURE_FAILED)?;
        if actual.as_str() != "about:blank"
            && !(actual.path() == "/newtab.html" && actual.origin() == main_url.origin())
        {
            return Err(READER_FIXTURE_FAILED.to_owned());
        }
        browser::browser_navigate(
            handle,
            format!("http://127.0.0.1:{port}/__hub_reader_fixture"),
        )
    })
    .await?;
    loop {
        let (_, tabs, status) = fixture_snapshot(app).await?;
        if status["activeTabId"].as_u64() != Some(id) || status["visible"] != true {
            return Err(READER_FIXTURE_FAILED.to_owned());
        }
        let raw = tabs
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"].as_u64() == Some(id)))
            .ok_or(READER_FIXTURE_FAILED)?;
        let actual = fixture_main(app, move |handle| {
            handle
                .get_webview(&format!("browser-tab-{id}"))
                .and_then(|view| view.url().ok())
                .map(|url| url.to_string())
                .ok_or(READER_FIXTURE_FAILED.to_owned())
        })
        .await?;
        if raw["url"].as_str() == Some(url.as_str()) && raw["loading"] == false && actual == url {
            fixture_tab(&tabs, &status, Some(id), &url)?;
            break;
        }
        if raw["url"]
            .as_str()
            .is_some_and(|current| !current.is_empty() && current != url)
        {
            return Err(READER_FIXTURE_FAILED.to_owned());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let article = serde_json::to_value(
        browser::reading::read(app.clone(), main.clone(), id, url.clone()).await?,
    )
    .map_err(|_| READER_FIXTURE_FAILED)?;
    if article["id"].as_u64() != Some(id)
        || article["url"].as_str() != Some(url.as_str())
        || article["title"] != "Hub reader fixture"
    {
        return Err(READER_FIXTURE_FAILED.to_owned());
    }
    let paragraphs = article["paragraphs"]
        .as_array()
        .ok_or(READER_FIXTURE_FAILED)?;
    if !paragraphs.iter().any(|value| {
        value
            .as_str()
            .is_some_and(|text| text.contains("hub-reader-fixture-v1"))
    }) {
        return Err(READER_FIXTURE_FAILED.to_owned());
    }
    let characters = paragraphs
        .iter()
        .try_fold(0usize, |count, value| {
            value
                .as_str()
                .and_then(|text| count.checked_add(text.chars().count()))
        })
        .ok_or(READER_FIXTURE_FAILED)?;
    let count = paragraphs.len();
    let context = article["contextToken"]
        .as_str()
        .ok_or(READER_FIXTURE_FAILED)?
        .to_owned();
    *token.lock().map_err(|_| READER_FIXTURE_FAILED)? = Some((main.clone(), context.clone()));
    let opened = serde_json::to_value(
        browser::reading::open(app.clone(), main, id, url.clone(), context.clone()).await?,
    )
    .map_err(|_| READER_FIXTURE_FAILED)?;
    if opened["opened"] != true
        || opened["id"].as_u64() != Some(id)
        || opened["contextToken"].as_str() != Some(context.as_str())
    {
        return Err(READER_FIXTURE_FAILED.to_owned());
    }
    loop {
        let (_, tabs, status) = fixture_snapshot(app).await?;
        fixture_tab(&tabs, &status, Some(id), &url)?;
        if fixture_mask(&status, id, true) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok((id, private, count, characters, url))
}
async fn reader_fixture(app: AppHandle, port: u16) -> Result<Value, String> {
    let cleanup = Mutex::new(None);
    let deadline = Instant::now() + Duration::from_secs(20);
    let result =
        tokio::time::timeout(Duration::from_secs(18), fixture_run(&app, port, &cleanup)).await;
    let pending = cleanup.lock().map_err(|_| READER_FIXTURE_FAILED)?.take();
    let close_result = if let Some((main, token)) = pending {
        tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            browser::reading::close(app.clone(), main, token),
        )
        .await
        .is_ok_and(|result| result.is_ok())
    } else {
        false
    };
    let (id, private, paragraphs, characters, url) = result
        .map_err(|_| READER_FIXTURE_FAILED)?
        .map_err(|_| READER_FIXTURE_FAILED)?;
    if !close_result {
        return Err(READER_FIXTURE_FAILED.to_owned());
    }
    let restored =
        tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), async {
            loop {
                let (_, tabs, status) = fixture_snapshot(&app).await?;
                fixture_tab(&tabs, &status, Some(id), &url)?;
                if fixture_mask(&status, id, false) {
                    return Ok::<_, String>(());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await;
    if !restored.is_ok_and(|result| result.is_ok()) {
        return Err(READER_FIXTURE_FAILED.to_owned());
    }
    Ok(
        json!({"tabId":id,"private":private,"read":true,"opened":true,"occluded":true,"restored":true,"paragraphs":paragraphs,"characters":characters}),
    )
}

#[cfg(test)]
mod reader_fixture_control_tests {
    use super::*;
    #[test]
    fn fixture_context_is_only_selected_blank_or_its_fixed_target_and_private_requires_verification(
    ) {
        let tabs = json!([{"id":1,"active":true,"discarded":false,"url":"","private":true}]);
        let status = json!({"visible":true,"activeTabId":1,"tabs":[{"id":1,"active":true,"discarded":false,"viewExists":true,"private":true,"rect":{"x":-10000,"y":-10000,"w":300,"h":200}}],"stageRect":{"x":20,"y":40,"w":300,"h":200}});
        assert_eq!(fixture_tab(&tabs, &status, None, "").unwrap(), (1, true));
        assert!(fixture_mask(&status, 1, true));
        let mut unverified = status.clone();
        unverified["tabs"][0]["private"] = json!(false);
        assert!(fixture_tab(&tabs, &unverified, None, "").is_err());
        let mut occupied = tabs.clone();
        occupied[0]["url"] = json!("https://user-page.invalid/");
        assert!(fixture_tab(&occupied, &status, None, "").is_err());
        assert!(fixture_tab(&tabs, &status, Some(2), "").is_err());
        let mut restored = status.clone();
        restored["tabs"][0]["rect"] = restored["stageRect"].clone();
        assert!(fixture_mask(&restored, 1, false));
        assert!(!fixture_mask(&restored, 1, true));
    }
}

pub(crate) fn ai_control_busy()->bool {
    UI_SELECT_PENDING.lock().map_or(true,|slot|slot.is_some())
        ||UI_REFRESH_PENDING.lock().map_or(true,|slot|slot.is_some())
        ||PROBE_PENDING.lock().map_or(true,|slot|slot.is_some())||crate::shell_control::is_pending()
}
