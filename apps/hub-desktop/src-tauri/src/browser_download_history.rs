//! Explicit standard profile download UI only. Never read history names, URLs or paths.
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Manager};
const MAX_SAFE: u64 = 9_007_199_254_740_991;
static PENDING: AtomicBool = AtomicBool::new(false);
fn error(code: &str) -> String {
    format!("download_history_{code}")
}
struct Pending;
impl Pending {
    fn claim() -> Result<Self, String> {
        PENDING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| error("busy"))?;
        Ok(Self)
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        PENDING.store(false, Ordering::SeqCst);
    }
}
#[derive(Clone)]
struct Snapshot {
    id: u64,
    label: String,
    private: bool,
    private_ready: bool,
    discarded: bool,
    child: Option<Arc<()>>,
    browser_epoch: u64,
    document_epoch: u64,
    visible: bool,
    occluded: bool,
    interactive: bool,
    reader: bool,
}
#[derive(Clone)]
struct Target {
    id: u64,
    label: String,
    private: bool,
    child: Arc<()>,
    document_epoch: u64,
    browser_epoch: Option<u64>,
}
fn valid_id(id: u64) -> bool {
    (1..=MAX_SAFE).contains(&id)
}
pub(super) fn managed_open_allowed<'a>(
    statuses: impl Iterator<Item = &'a str>,
    retained: bool,
) -> bool {
    !retained && statuses.into_iter().all(super::download_terminal)
}
fn main_guard(label: &str, local: bool) -> Result<(), String> {
    if label != super::MAIN_LABEL || !local {
        return Err(error("main_required"));
    }
    Ok(())
}
fn capture(value: &Snapshot, expected: u64) -> Result<Target, String> {
    if !valid_id(expected) {
        return Err(error("invalid_request"));
    }
    if value.id != expected
        || !valid_id(value.id)
        || value.label != format!("browser-tab-{}", value.id)
        || value.discarded
        || (value.private && !value.private_ready)
    {
        return Err(error("scope_changed"));
    }
    Ok(Target {
        id: value.id,
        label: value.label.clone(),
        private: value.private,
        child: Arc::clone(value.child.as_ref().ok_or_else(|| error("scope_changed"))?),
        document_epoch: value.document_epoch,
        browser_epoch: None,
    })
}
fn same_document(value: &Snapshot, target: &Target) -> bool {
    value.id == target.id
        && value.label == target.label
        && value.private == target.private
        && !value.discarded
        && (!value.private || value.private_ready)
        && value.document_epoch == target.document_epoch
        && value
            .child
            .as_ref()
            .is_some_and(|child| Arc::ptr_eq(child, &target.child))
        && target
            .browser_epoch
            .is_none_or(|epoch| epoch == value.browser_epoch)
}
fn exposed(value: &Snapshot) -> bool {
    value.visible && !value.occluded && value.interactive && !value.reader
}
fn owned_current(value: &Snapshot, target: &Target) -> bool {
    // Print-context epoch changes on actual page/tab changes, not title/audio metadata.
    value.id == target.id
        && value.label == target.label
        && value.private == target.private
        && !value.discarded
        && (!value.private || value.private_ready)
        && value.document_epoch == target.document_epoch
        && value
            .child
            .as_ref()
            .is_some_and(|child| Arc::ptr_eq(child, &target.child))
        && exposed(value)
}
fn validate_current(value: &Snapshot, target: &Target) -> Result<(), String> {
    if !same_document(value, target) {
        return Err(error("scope_changed"));
    }
    if !exposed(value) {
        return Err(error("not_visible"));
    }
    Ok(())
}
fn profile(expected: bool, actual: Option<bool>) -> Result<(), String> {
    match actual {
        Some(actual) if actual == expected => Ok(()),
        Some(_) => Err(error("profile_mismatch")),
        None => Err(error("unavailable")),
    }
}
fn receipt(target: &Target, wanted: bool, actual: Option<bool>) -> Result<Value, String> {
    if actual != Some(wanted) {
        return Err(error("unavailable"));
    }
    Ok(json!({"tabId":target.id,"open":wanted,"private":target.private}))
}
fn snapshot() -> Option<Snapshot> {
    let visible = super::BROWSER_VISIBLE.load(Ordering::SeqCst);
    let occluded = super::MODAL_OCCLUDED.load(Ordering::SeqCst);
    let interactive = super::native_tabs_interactive();
    let reader = super::reading::occluded();
    super::with_tabs(|state| {
        let tab = state.tabs.iter().find(|tab| tab.id == state.active)?;
        Some(Snapshot {
            id: tab.id,
            label: tab.label.clone(),
            private: tab.private,
            private_ready: tab.private_ready,
            discarded: tab.discarded,
            child: tab.media.as_ref().map(|media| Arc::clone(&media.child)),
            browser_epoch: super::BROWSER_EPOCH.load(Ordering::SeqCst),
            document_epoch: super::BROWSER_PRINT_CONTEXT_EPOCH.load(Ordering::SeqCst),
            visible,
            occluded,
            interactive,
            reader,
        })
    })
    .flatten()
}
fn current(target: &Target) -> Result<(), String> {
    validate_current(&snapshot().ok_or_else(|| error("scope_changed"))?, target)
}
async fn settle(target: &mut Target) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let state = snapshot().ok_or_else(|| error("scope_changed"))?;
        if !same_document(&state, target) {
            return Err(error("scope_changed"));
        }
        if !state.visible {
            return Err(error("not_visible"));
        }
        if exposed(&state) {
            target.browser_epoch = Some(state.browser_epoch);
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(error("not_visible"));
        }
        tokio::time::sleep(Duration::from_millis(16)).await;
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::cell::RefCell;
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_13, ICoreWebView2_9};
    use windows_core::Interface;
    struct Owned {
        dialog: ICoreWebView2_9,
        target: Target,
    }
    thread_local! {static OWNED:RefCell<Option<Owned>>=const{RefCell::new(None)};}
    /// Must be called on the UI thread; direct COM only, no reentrant Tauri dispatch.
    pub(super) fn close_owned_history() -> Result<(), String> {
        let owned = OWNED.with(|state| {
            state
                .try_borrow_mut()
                .map(|mut state| state.take())
                .map_err(|_| error("unavailable"))
        })?;
        let Some(owned) = owned else {
            return Ok(());
        };
        let result = unsafe {
            owned
                .dialog
                .CloseDefaultDownloadDialog()
                .map_err(|_| error("unavailable"))
                .and_then(|_| {
                    let mut actual = windows_core::BOOL(0);
                    owned
                        .dialog
                        .IsDefaultDownloadDialogOpen(&mut actual)
                        .map_err(|_| error("unavailable"))?;
                    if actual.as_bool() {
                        Err(error("unavailable"))
                    } else {
                        Ok(())
                    }
                })
        };
        if result.is_err() {
            let _ = OWNED.with(|state| {
                state.try_borrow_mut().map(|mut state| {
                    if state.is_none() {
                        *state = Some(owned);
                    }
                })
            });
        }
        result
    }
    pub(super) fn close_if_stale() -> Result<(), String> {
        let target = OWNED.with(|state| {
            state
                .try_borrow()
                .map(|state| state.as_ref().map(|owned| owned.target.clone()))
                .map_err(|_| error("unavailable"))
        })?;
        if let Some(target) = target {
            if snapshot().is_none_or(|state| !owned_current(&state, &target)) {
                return close_owned_history();
            }
        }
        Ok(())
    }
    pub(super) fn close_target(target: &Target) -> Result<(), String> {
        let matching = OWNED.with(|state| state.try_borrow().map(|state| state.as_ref().is_some_and(|owned|
            owned.target.id == target.id && owned.target.document_epoch == target.document_epoch && Arc::ptr_eq(&owned.target.child, &target.child)
        )).map_err(|_| error("unavailable")))?;
        if matching { close_owned_history()?; }
        Ok(())
    }
    fn keep(dialog: ICoreWebView2_9, target: Target) -> Result<(), String> {
        OWNED.with(|state| {
            let mut state = state.try_borrow_mut().map_err(|_| error("unavailable"))?;
            *state = Some(Owned { dialog, target });
            Ok(())
        })
    }
    fn clear_matching(target: &Target) {
        let _ = OWNED.with(|state| {
            state.try_borrow_mut().map(|mut state| {
                if state.as_ref().is_some_and(|owned| {
                    owned.target.id == target.id && Arc::ptr_eq(&owned.target.child, &target.child)
                }) {
                    state.take();
                }
            })
        });
    }
    pub(super) fn dispatch(
        view: tauri::Webview,
        target: Target,
        open: bool,
        apply: bool,
        tx: tokio::sync::oneshot::Sender<Result<Value, String>>,
        pending: Arc<Pending>,
    ) {
        let sender = Arc::new(Mutex::new(Some(tx)));
        let failed = Arc::clone(&sender);
        if view
            .with_webview(move |platform| unsafe {
                let _pending = pending;
                let Some(tx) = sender.lock().ok().and_then(|mut sender| sender.take()) else {
                    return;
                };
                if tx.is_closed() {
                    return;
                }
                let result = (|| -> Result<Value, String> {
                    current(&target)?;
                    if open && !super::super::browser_access::download_history_allowed()? {
                        return Err(error("busy"));
                    }
                    let core = platform
                        .controller()
                        .CoreWebView2()
                        .map_err(|_| error("unavailable"))?;
                    let private_profile = core
                        .cast::<ICoreWebView2_13>()
                        .map_err(|_| error("unsupported"))?
                        .Profile()
                        .map_err(|_| error("unavailable"))?;
                    let mut actual_private = windows_core::BOOL(0);
                    private_profile
                        .IsInPrivateModeEnabled(&mut actual_private)
                        .map_err(|_| error("unavailable"))?;
                    profile(target.private, Some(actual_private.as_bool()))?;
                    let dialog = core
                        .cast::<ICoreWebView2_9>()
                        .map_err(|_| error("unsupported"))?;
                    current(&target)?;
                    if tx.is_closed() {
                        return Err(error("scope_changed"));
                    }
                    if apply && open {
                        close_owned_history()?;
                        keep(dialog.clone(), target.clone())?;
                        if dialog.OpenDefaultDownloadDialog().is_err() {
                            let _ = close_owned_history();
                            return Err(error("unknown"));
                        }
                    } else if apply {
                        dialog
                            .CloseDefaultDownloadDialog()
                            .map_err(|_| error("unavailable"))?;
                    }
                    let mut actual = windows_core::BOOL(0);
                    let observed = dialog
                        .IsDefaultDownloadDialogOpen(&mut actual)
                        .is_ok()
                        .then(|| actual.as_bool());
                    let guarded = current(&target).and_then(|_| {
                        if open && !super::super::browser_access::download_history_allowed()? {
                            Err(error("busy"))
                        } else {
                            Ok(())
                        }
                    });
                    if guarded.is_err() || tx.is_closed() || observed.is_none() {
                        if open {
                            // A reentrant parent lifecycle hook may already have taken OWNED.
                            // Still close this exact captured core, never another tab's dialog.
                            if dialog.CloseDefaultDownloadDialog().is_ok() {
                                clear_matching(&target);
                            }
                        }
                        return Err(if open { error("unknown") } else { guarded.err().unwrap_or_else(|| error("unavailable")) });
                    }
                    if !open && observed == Some(false) {
                        clear_matching(&target);
                    }
                    receipt(&target, observed.unwrap(), observed)
                })();
                let _ = tx.send(result);
            })
            .is_err()
        {
            if let Some(tx) = failed.lock().ok().and_then(|mut sender| sender.take()) {
                let _ = tx.send(Err(error("unavailable")));
            }
        }
    }
}
#[cfg(windows)]
pub(super) fn close_owned_history() -> Result<(), String> {
    native::close_owned_history()
}
#[cfg(windows)]
pub(super) fn close_if_stale() -> Result<(), String> {
    native::close_if_stale()
}
#[cfg(not(windows))]
pub(super) fn close_if_stale() -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
pub(super) fn close_owned_history() -> Result<(), String> {
    Ok(())
}
pub(super) async fn change(
    app: AppHandle,
    window: tauri::Webview,
    expected_tab_id: u64,
    open: bool,
) -> Result<Value, String> {
    let url = window.url().map_err(|_| error("main_required"))?;
    main_guard(
        window.label(),
        crate::local_pairing_address(window.label(), &url),
    )?;
    if !valid_id(expected_tab_id) {
        return Err(error("invalid_request"));
    }
    let pending = Arc::new(Pending::claim()?);
    let mut target = capture(
        &snapshot().ok_or_else(|| error("scope_changed"))?,
        expected_tab_id,
    )?;
    settle(&mut target).await?;
    current(&target)?;
    let view = app
        .get_webview(&target.label)
        .ok_or_else(|| error("scope_changed"))?;
    if view.window().label() != super::MAIN_LABEL {
        return Err(error("scope_changed"));
    }
    #[cfg(windows)]
    {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let result = async {
            let mut apply = true;
            loop {
                current(&target).map_err(|e| if open && !apply { error("unknown") } else { e })?;
                let (tx, rx) = tokio::sync::oneshot::channel();
                let initial = apply;
                native::dispatch(view.clone(), target.clone(), open, initial, tx, Arc::clone(&pending));
                apply = false; // Apply exactly once; later callbacks only observe the SDK property.
                let value = tokio::time::timeout_at(deadline, rx).await
                    .map_err(|_| error(if open { "unknown" } else { "unavailable" }))?
                    .map_err(|_| error(if open { "unknown" } else { "unavailable" }))?
                    .map_err(|e| if open && !initial { error("unknown") } else { e })?;
                current(&target).map_err(|e| if open { error("unknown") } else { e })?;
                if value.get("open").and_then(Value::as_bool) == Some(open) { return Ok(value); }
                if tokio::time::Instant::now() >= deadline { return Err(error(if open { "unknown" } else { "unavailable" })); }
                // WebView2 acknowledges Open before its dialog state changes. Never block its UI thread.
                tokio::time::sleep(Duration::from_millis(16)).await;
            }
        }.await;
        if result.is_err() && open {
            let cleanup = target.clone();
            let claim = Arc::clone(&pending);
            let _ = app.run_on_main_thread(move || { let _claim = claim; let _ = native::close_target(&cleanup); });
        }
        result
    }
    #[cfg(not(windows))]
    {
        let _ = (view, open);
        Err(error("unsupported"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> Snapshot {
        Snapshot {
            id: 1,
            label: "browser-tab-1".into(),
            private: false,
            private_ready: false,
            discarded: false,
            child: Some(Arc::new(())),
            browser_epoch: 4,
            document_epoch: 7,
            visible: true,
            occluded: false,
            interactive: true,
            reader: false,
        }
    }
    #[test]
    fn main_id_label_discard_and_private_ready_are_closed_native_boundaries() {
        assert!(main_guard("main", true).is_ok());
        assert!(main_guard("main", false).is_err());
        assert!(main_guard("harness", true).is_err());
        let mut value = state();
        for id in [0, MAX_SAFE + 1, u64::MAX] {
            assert_eq!(capture(&value, id).err().unwrap(), error("invalid_request"));
        }
        value.id = MAX_SAFE;
        value.label = format!("browser-tab-{MAX_SAFE}");
        assert!(capture(&value, MAX_SAFE).is_ok());
        for changed in 0..4 {
            let mut value = state();
            match changed {
                0 => value.label = "another-view".into(),
                1 => value.discarded = true,
                2 => value.child = None,
                _ => value.private = true,
            };
            assert!(capture(&value, 1).is_err());
        }
        let mut value = state();
        value.private = true;
        value.private_ready = true;
        assert!(capture(&value, 1).is_ok());
        assert!(capture(&value, 2).is_err());
    }
    #[test]
    fn view_tab_private_document_and_child_replacement_reject_old_scope() {
        let value = state();
        let target = capture(&value, 1).unwrap();
        assert!(same_document(&value, &target));
        for changed in 0..5 {
            let mut value = value.clone();
            match changed {
                0 => value.id = 2,
                1 => value.label = "browser-tab-2".into(),
                2 => value.private = true,
                3 => value.document_epoch += 1,
                _ => value.child = Some(Arc::new(())),
            };
            assert!(!same_document(&value, &target));
        }
    }
    #[test]
    fn layout_epoch_is_captured_only_after_overlay_settles_then_exact() {
        let mut value = state();
        value.occluded = true;
        let mut target = capture(&value, 1).unwrap();
        value.browser_epoch += 1;
        assert!(same_document(&value, &target));
        assert!(!exposed(&value));
        value.occluded = false;
        target.browser_epoch = Some(value.browser_epoch);
        assert!(validate_current(&value, &target).is_ok());
        value.browser_epoch += 1;
        assert_eq!(
            validate_current(&value, &target).err().unwrap(),
            error("scope_changed")
        );
    }
    #[test]
    fn visibility_modal_fullscreen_and_reader_never_force_unocclusion() {
        let value = state();
        let target = capture(&value, 1).unwrap();
        for changed in 0..4 {
            let mut value = value.clone();
            match changed {
                0 => value.visible = false,
                1 => value.occluded = true,
                2 => value.interactive = false,
                _ => value.reader = true,
            };
            assert_eq!(
                validate_current(&value, &target).err().unwrap(),
                error("not_visible")
            );
        }
    }
    #[test]
    fn actual_profile_verification_and_confirmed_open_close_return_only_three_metadata_fields() {
        assert!(profile(false, Some(false)).is_ok());
        assert!(profile(true, Some(true)).is_ok());
        assert_eq!(
            profile(true, Some(false)).err().unwrap(),
            error("profile_mismatch")
        );
        assert_eq!(
            profile(false, Some(true)).err().unwrap(),
            error("profile_mismatch")
        );
        assert!(profile(false, None).is_err());
        let value = state();
        let target = capture(&value, 1).unwrap();
        for open in [true, false] {
            let value = receipt(&target, open, Some(open)).unwrap();
            assert_eq!(value, json!({"tabId":1,"open":open,"private":false}));
            assert_eq!(value.as_object().unwrap().len(), 3);
            assert!(receipt(&target, open, Some(!open)).is_err());
            assert!(receipt(&target, open, None).is_err());
        }
    }
    #[test]
    fn managed_nonterminal_retained_and_unknown_operations_block_standard_resume_surface() {
        assert!(managed_open_allowed([].into_iter(), false));
        assert!(managed_open_allowed(
            ["complete", "failed", "cancelled"].into_iter(),
            false
        ));
        for status in ["choosing", "active", "paused", "interrupted", "", "unknown"] {
            assert!(!managed_open_allowed([status].into_iter(), false));
        }
        assert!(!managed_open_allowed(["complete"].into_iter(), true));
        assert!(!managed_open_allowed([].into_iter(), true));
    }
    #[test]
    fn pending_duplicate_and_timeout_keep_callback_claim_until_dispatch_finishes() {
        let pending = Arc::new(Pending::claim().unwrap());
        assert_eq!(Pending::claim().err().unwrap(), error("busy"));
        let callback = Arc::clone(&pending);
        drop(pending);
        assert!(Pending::claim().is_err());
        drop(callback);
        let next = Pending::claim().unwrap();
        drop(next);
        assert!(!PENDING.load(Ordering::SeqCst));
    }
    #[test]
    fn unchanged_metadata_refresh_keeps_owned_dialog_but_document_or_child_change_closes() {
        let mut value = state();
        let target = capture(&value, 1).unwrap();
        value.browser_epoch += 1;
        assert!(owned_current(&value, &target));
        value.document_epoch += 1;
        assert!(!owned_current(&value, &target));
        value.document_epoch -= 1;
        value.child = Some(Arc::new(()));
        assert!(!owned_current(&value, &target));
    }
}
