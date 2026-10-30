//! Network blocking for external children only. No request data is logged or retained.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

const UNAVAILABLE: &str = "browser_protection_unavailable";
const UNSUPPORTED: &str = "browser_protection_unsupported";
const INSTALL_FAILED: &str = "browser_protection_install_failed";
const UNINSTALL_FAILED: &str = "browser_protection_uninstall_failed";
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const LISTS_VERSION: &str = "2026-10-07";
const MAX_URI_BYTES: usize = 65_536;
static ENABLED: AtomicBool = AtomicBool::new(true);
static SUPPORTED: AtomicBool = AtomicBool::new(false);
static BLOCKED: AtomicU64 = AtomicU64::new(0);
static HOOKS: AtomicU64 = AtomicU64::new(0);
static MODE_REVISION: AtomicU64 = AtomicU64::new(0);
static DOCUMENT_PENDING: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
#[path = "browser_youtube_protection.rs"]
mod youtube;
#[cfg(windows)]
fn youtube_url(raw: &str) -> bool { youtube::youtube_url(raw) }
#[cfg(windows)]
fn youtube_document_scripts(enabled: bool) -> Result<(String, String), String> { youtube::youtube_document_scripts(enabled) }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub version: u8,
    pub supported: bool,
    pub enabled: bool,
    pub ready: bool,
    pub blocked_count: u64,
    pub lists_version: &'static str,
}

fn increment(counter: &AtomicU64) {
    let _ = counter.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
        Some(n.saturating_add(1).min(MAX_SAFE))
    });
}
fn decrement(counter: &AtomicU64) {
    let _ = counter.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
        Some(n.saturating_sub(1))
    });
}
pub(crate) fn status() -> Status {
    let supported = SUPPORTED.load(Ordering::SeqCst);
    compose_status(
        ENABLED.load(Ordering::SeqCst),
        supported,
        engine_ready() && DOCUMENT_PENDING.load(Ordering::SeqCst) == 0,
        HOOKS.load(Ordering::SeqCst),
        BLOCKED.load(Ordering::SeqCst),
    )
}
fn compose_status(enabled: bool, supported: bool, engine: bool, hooks: u64, count: u64) -> Status {
    Status {
        version: 1,
        supported,
        enabled,
        ready: supported && engine && hooks > 0,
        blocked_count: count.min(MAX_SAFE),
        lists_version: LISTS_VERSION,
    }
}
pub(crate) fn set_enabled(enabled: bool) -> Status {
    if ENABLED.swap(enabled, Ordering::SeqCst) != enabled {
        if MODE_REVISION.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1)).is_err() { SUPPORTED.store(false, Ordering::SeqCst); }
    }
    status()
}

#[cfg(windows)]
static ENGINE: std::sync::OnceLock<Result<adblock::Engine, String>> = std::sync::OnceLock::new();
#[cfg(windows)]
pub(crate) fn initialize() -> Result<(), String> {
    ENGINE
        .get_or_init(|| {
            use adblock::lists::{FilterSet, ParseOptions, RuleTypes};
            let mut filters = FilterSet::new(false);
            let options = ParseOptions {
                rule_types: RuleTypes::NetworkOnly,
                ..ParseOptions::default()
            };
            filters.add_filter_list(
                include_str!("../assets/adblock/easylist.txt").to_owned(),
                options,
            );
            filters.add_filter_list(
                include_str!("../assets/adblock/easyprivacy.txt").to_owned(),
                options,
            );
            Ok(adblock::Engine::new_with_filter_set(filters))
        })
        .as_ref()
        .map(|_| ())
        .map_err(Clone::clone)
}
#[cfg(not(windows))]
pub(crate) fn initialize() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
#[cfg(windows)]
fn engine_ready() -> bool {
    ENGINE.get().is_some_and(Result::is_ok)
}
#[cfg(not(windows))]
fn engine_ready() -> bool {
    false
}

fn http_url(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > MAX_URI_BYTES || raw.chars().any(char::is_control) {
        return None;
    }
    let mut url = tauri::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_fragment(None);
    Some(url.into())
}
fn source_url(
    request: &str,
    referer: Option<&str>,
    origin: Option<&str>,
    top: Option<&str>,
    worker: bool,
) -> Option<String> {
    referer
        .and_then(http_url)
        .or_else(|| worker.then(|| origin.and_then(http_url)).flatten())
        .or_else(|| (!worker).then(|| top.and_then(http_url)).flatten())
        .or_else(|| http_url(request))
}
fn request_method(raw: &str) -> Option<&str> {
    (!raw.is_empty()
        && raw.len() <= 32
        && raw
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&c)))
    .then_some(raw)
}
fn successor(
    entries: impl Iterator<Item = (usize, usize, bool)>,
    environment: usize,
) -> Option<usize> {
    entries
        .filter(|(_, env, active)| *env == environment && *active)
        .map(|(id, _, _)| id)
        .next()
}

#[cfg(any(windows, test))]
type DocumentMode = (u64, bool);
#[cfg(any(windows, test))]
#[derive(Default)]
struct DocumentScripts {
    active: bool,
    navigation: u64,
    serial: u64,
    installed: Option<DocumentMode>,
    pending: Option<(u64, DocumentMode)>,
    target: Option<(u64, String)>,
    tokens: std::collections::BTreeSet<String>,
    failed: bool,
}
#[cfg(any(windows, test))]
impl DocumentScripts {
    fn new() -> Self { Self { active: true, ..Self::default() } }
    fn navigate(&mut self, target: Option<String>, mode: DocumentMode) -> Result<bool, ()> {
        if !self.active { return Ok(false); }
        self.navigation = self.navigation.checked_add(1).ok_or(())?;
        self.target = None;
        let Some(target) = target else { return Ok(false); };
        if self.failed { return Err(()); }
        if self.pending.is_none() && self.installed == Some(mode) { return Ok(false); }
        self.target = Some((self.navigation, target));
        Ok(true)
    }
    fn begin(&mut self, mode: DocumentMode) -> Result<Option<u64>, ()> {
        if !self.active || self.pending.is_some() || self.target.is_none() { return Ok(None); }
        if self.failed { return Err(()); }
        self.serial = self.serial.checked_add(1).ok_or(())?;
        self.pending = Some((self.serial, mode));
        self.installed = None;
        Ok(Some(self.serial))
    }
    fn current(&self, serial: u64) -> bool {
        self.active && self.pending.is_some_and(|(id, _)| id == serial)
    }
    fn finish(&mut self, serial: u64, mode: DocumentMode) -> Result<Option<String>, ()> {
        if !self.current(serial) { return Ok(None); }
        let (_, registered) = self.pending.take().unwrap();
        if registered != mode { return Err(()); }
        self.installed = Some(mode);
        Ok(self.target.take().filter(|(generation, _)| *generation == self.navigation).map(|(_, target)| target))
    }
    fn fail(&mut self, serial: u64) -> bool {
        if !self.current(serial) { return false; }
        self.pending = None; self.installed = None; self.target = None; self.failed = true;
        true
    }
    fn dispose(&mut self) -> bool {
        self.active = false; self.target = None; self.installed = None;
        self.pending.take().is_some()
    }
}

#[cfg(test)]
mod youtube_document_lifecycle_tests {
    use super::{DocumentScripts, DocumentMode};
    fn target(value: &str) -> Option<String> { Some(value.to_owned()) }
    #[test]
    fn first_document_waits_then_normal_navigation_uses_registered_mode() {
        let mut state = DocumentScripts::new(); let mode = (0, true);
        assert!(state.navigate(target("https://www.youtube.com/watch?v=first"), mode).unwrap());
        let id = state.begin(mode).unwrap().unwrap();
        assert_eq!(state.finish(id, mode).unwrap().as_deref(), Some("https://www.youtube.com/watch?v=first"));
        assert!(!state.navigate(target("https://m.youtube.com/watch?v=next"), mode).unwrap());
    }
    #[test]
    fn deferred_navigation_and_redirect_resume_only_the_latest_exact_target() {
        let mut state = DocumentScripts::new(); let mode = (0, true);
        state.navigate(target("https://youtube.com/start#original"), mode).unwrap();
        let id = state.begin(mode).unwrap().unwrap();
        state.navigate(target("https://www.youtube.com/redirected?video=next#position"), mode).unwrap();
        assert!(state.begin(mode).unwrap().is_none());
        assert_eq!(state.finish(id, mode).unwrap().as_deref(), Some("https://www.youtube.com/redirected?video=next#position"));
    }
    #[test]
    fn leaving_youtube_never_revives_an_old_target() {
        let mut state = DocumentScripts::new(); let mode = (0, true);
        state.navigate(target("https://youtube.com/watch?v=first"), mode).unwrap();
        let id = state.begin(mode).unwrap().unwrap();
        assert!(!state.navigate(None, mode).unwrap());
        assert_eq!(state.finish(id, mode).unwrap(), None);
    }
    #[test]
    fn toggle_round_trip_and_pending_mode_change_require_fresh_registration() {
        let mut state = DocumentScripts::new(); let enabled: DocumentMode = (0, true);
        state.navigate(target("https://youtube.com/watch?v=first"), enabled).unwrap();
        let id = state.begin(enabled).unwrap().unwrap(); state.finish(id, enabled).unwrap();
        let newer = (2, true);
        assert!(state.navigate(target("https://youtube.com/watch?v=next"), newer).unwrap());
        let id = state.begin(newer).unwrap().unwrap();
        let disabled = (3, false);
        assert!(state.finish(id, disabled).is_err());
        let next = state.begin(disabled).unwrap().unwrap();
        assert_eq!(state.finish(next, disabled).unwrap().as_deref(), Some("https://youtube.com/watch?v=next"));
    }
    #[test]
    fn failure_is_unavailable_and_disposal_never_resumes() {
        let mut failed = DocumentScripts::new(); let mode = (0, true);
        failed.navigate(target("https://youtube.com/watch?v=first"), mode).unwrap();
        let id = failed.begin(mode).unwrap().unwrap(); assert!(failed.fail(id));
        assert!(failed.navigate(target("https://youtube.com/watch?v=next"), mode).is_err());
        let mut closed = DocumentScripts::new();
        closed.navigate(target("https://youtube.com/watch?v=first"), mode).unwrap();
        let id = closed.begin(mode).unwrap().unwrap(); assert!(closed.dispose());
        assert_eq!(closed.finish(id, mode).unwrap(), None);
        assert!(!closed.navigate(target("https://youtube.com/watch?v=next"), mode).unwrap());
    }
    #[test]
    fn generations_do_not_wrap_into_a_live_old_operation() {
        let mut state = DocumentScripts::new(); state.navigation = u64::MAX;
        assert!(state.navigate(target("https://youtube.com/"), (0, true)).is_err());
        let mut state = DocumentScripts::new();
        state.navigate(target("https://youtube.com/"), (0, true)).unwrap(); state.serial = u64::MAX;
        assert!(state.begin((0, true)).is_err());
    }
}

#[cfg(windows)]
fn blocked(url: &str, source: &str, kind: &str, method: &str) -> bool {
    if !ENABLED.load(Ordering::SeqCst) {
        return false;
    }
    let Some(Ok(engine)) = ENGINE.get() else {
        return false;
    };
    let Ok(request) = adblock::request::Request::new(url, source, kind, method) else {
        return false;
    };
    engine.check_network_request(&request).should_block()
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::BTreeMap,
        rc::Rc,
    };
    use webview2_com::{
        take_pwstr, Microsoft::Web::WebView2::Win32::*, NavigationStartingEventHandler,
        CallDevToolsProtocolMethodCompletedHandler,
        WebResourceRequestedEventHandler,
    };
    use windows_core::{IUnknown, Interface, PCWSTR, PWSTR};

    const DOCUMENT: COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS =
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT;
    const WORKERS: COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS =
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS(
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_SERVICE_WORKER.0
                | COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_SHARED_WORKER.0,
        );

const YOUTUBE_UNAVAILABLE: &str = "browser_youtube_protection_unavailable";
    type DocumentState = Rc<RefCell<DocumentScripts>>;
    type ProtocolCallback = Box<dyn FnOnce(windows_core::Result<()>, String) -> windows_core::Result<()>>;
    fn mode() -> DocumentMode { (MODE_REVISION.load(Ordering::SeqCst), ENABLED.load(Ordering::SeqCst)) }
    unsafe fn protocol(core: &ICoreWebView2, method: &'static str, params: serde_json::Value, callback: ProtocolCallback) -> windows_core::Result<()> {
        let method: Vec<u16> = method.encode_utf16().chain(Some(0)).collect();
        let params: Vec<u16> = params.to_string().encode_utf16().chain(Some(0)).collect();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(callback);
        core.CallDevToolsProtocolMethod(PCWSTR(method.as_ptr()), PCWSTR(params.as_ptr()), &handler)
    }
    fn acknowledged(status: windows_core::Result<()>, response: &str) -> bool {
        status.is_ok() && response.len() <= 4096 && serde_json::from_str::<serde_json::Value>(response)
            .ok().is_some_and(|value| value.is_object() && value.get("error").is_none())
    }
    unsafe fn remove_documents(core: ICoreWebView2, state: DocumentState, mut ids: Vec<String>, complete: Box<dyn FnOnce(bool)>) {
        let Some(id) = ids.pop() else { complete(true); return; };
        let next_core = core.clone(); let next_state = Rc::clone(&state); let removed = id.clone();
        let done = Rc::new(RefCell::new(Some(complete))); let callback_done = Rc::clone(&done);
        let result = protocol(&core, "Page.removeScriptToEvaluateOnNewDocument", serde_json::json!({"identifier": id}), Box::new(move |status, body| {
            let Some(done) = callback_done.borrow_mut().take() else { return Ok(()); };
            if acknowledged(status, &body) {
                next_state.borrow_mut().tokens.remove(&removed);
                remove_documents(next_core, next_state, ids, done);
            } else { done(false); }
            Ok(())
        }));
        if result.is_err() { if let Some(done) = done.borrow_mut().take() { done(false); } }
    }
    unsafe fn document_failure(core: ICoreWebView2, state: DocumentState, serial: u64) {
        if state.borrow_mut().fail(serial) { decrement(&DOCUMENT_PENDING); }
        SUPPORTED.store(false, Ordering::SeqCst);
        let ids = state.borrow().tokens.iter().cloned().collect();
        remove_documents(core, state, ids, Box::new(|_| {}));
    }
    unsafe fn register_world(core: ICoreWebView2, state: DocumentState, serial: u64, registered: DocumentMode, sources: (String, String), isolated: bool) {
        if !state.borrow().current(serial) { return; }
        let mut params = serde_json::json!({"source": if isolated { &sources.1 } else { &sources.0 }});
        if isolated { params["worldName"] = serde_json::json!("hub.adblock.youtube"); }
        let next_core = core.clone(); let next_state = Rc::clone(&state);
        let result = protocol(&core, "Page.addScriptToEvaluateOnNewDocument", params, Box::new(move |status, body| {
            let id = acknowledged(status, &body).then(|| serde_json::from_str::<serde_json::Value>(&body).ok())
                .flatten().and_then(|value| value["identifier"].as_str().map(str::to_owned))
                .filter(|id| !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control));
            let Some(id) = id else { document_failure(next_core, next_state, serial); return Ok(()); };
            next_state.borrow_mut().tokens.insert(id.clone());
            if !next_state.borrow().current(serial) {
                remove_documents(next_core, next_state, vec![id], Box::new(|_| {})); return Ok(());
            }
            if !isolated { register_world(next_core, next_state, serial, registered, sources, true); return Ok(()); }
            let action = next_state.borrow_mut().finish(serial, mode());
            decrement(&DOCUMENT_PENDING);
            match action {
                Ok(Some(target)) => {
                    if !next_state.borrow().active { return Ok(()); }
                    let target: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
                    if next_core.Navigate(PCWSTR(target.as_ptr())).is_err() { SUPPORTED.store(false, Ordering::SeqCst); }
                }
                Err(()) => register_documents(next_core, next_state),
                Ok(None) => {}
            }
            Ok(())
        }));
        if result.is_err() { document_failure(core, state, serial); }
    }
    unsafe fn register_documents(core: ICoreWebView2, state: DocumentState) {
        let registered = mode();
        let serial = match state.borrow_mut().begin(registered) {
            Ok(Some(serial)) => serial, Ok(None) => return,
            Err(()) => { SUPPORTED.store(false, Ordering::SeqCst); return; }
        };
        increment(&DOCUMENT_PENDING);
        let sources = match super::youtube_document_scripts(registered.1) {
            Ok(sources) => sources, Err(_) => { document_failure(core, state, serial); return; }
        };
        let ids = state.borrow().tokens.iter().cloned().collect();
        let failed_core = core.clone(); let failed_state = Rc::clone(&state);
        remove_documents(core, state, ids, Box::new(move |removed| {
            if !failed_state.borrow().current(serial) { return; }
            if !removed { document_failure(failed_core, failed_state, serial); return; }
            let next_core = failed_core.clone(); let next_state = Rc::clone(&failed_state);
            let result = protocol(&failed_core, "Page.enable", serde_json::json!({}), Box::new(move |status, body| {
                if !next_state.borrow().current(serial) { return Ok(()); }
                if acknowledged(status, &body) { register_world(next_core, next_state, serial, registered, sources, false); }
                else { document_failure(next_core, next_state, serial); }
                Ok(())
            }));
            if result.is_err() { document_failure(failed_core, failed_state, serial); }
        }));
    }

    struct Hook {
        _identity: IUnknown,
        environment_identity: IUnknown,
        core: ICoreWebView2,
        modern: ICoreWebView2_22,
        request_token: i64,
        navigation_token: i64,
        active: Rc<Cell<bool>>,
        worker_owner: Rc<Cell<bool>>,
        documents: DocumentState,
    }
    thread_local! { static REGISTRY: RefCell<BTreeMap<usize, Hook>> = RefCell::new(BTreeMap::new()); }
    fn identity(value: &impl Interface) -> windows_core::Result<IUnknown> {
        value.cast()
    }
    fn key(value: &IUnknown) -> usize {
        value.as_raw() as usize
    }
    unsafe fn add_filter(
        core: &ICoreWebView2_22,
        kinds: COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS,
    ) -> windows_core::Result<()> {
        core.AddWebResourceRequestedFilterWithRequestSourceKinds(
            windows_core::w!("*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            kinds,
        )
    }
    unsafe fn remove_filter(
        core: &ICoreWebView2_22,
        kinds: COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS,
    ) -> windows_core::Result<()> {
        core.RemoveWebResourceRequestedFilterWithRequestSourceKinds(
            windows_core::w!("*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            kinds,
        )
    }
    unsafe fn header(request: &ICoreWebView2WebResourceRequest, name: PCWSTR) -> Option<String> {
        let mut raw = PWSTR::null();
        request.Headers().ok()?.GetHeader(name, &mut raw).ok()?;
        Some(take_pwstr(raw))
    }
    fn resource_type(
        context: COREWEBVIEW2_WEB_RESOURCE_CONTEXT,
        top_document: bool,
    ) -> &'static str {
        match context {
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => {
                if top_document {
                    "document"
                } else {
                    "subdocument"
                }
            }
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA
            | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_TEXT_TRACK => "media",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST
            | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH
            | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_EVENT_SOURCE => "xmlhttprequest",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT => "csp_report",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL
            | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MANIFEST
            | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SIGNED_EXCHANGE
            | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER => "other",
            _ => "other",
        }
    }
    fn source_kind(
        kind: COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS,
        owner: bool,
    ) -> Option<bool> {
        if kind == DOCUMENT {
            Some(false)
        } else if owner
            && matches!(
                kind,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_SERVICE_WORKER
                    | COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_SHARED_WORKER
            )
        {
            Some(true)
        } else {
            None
        }
    }
    unsafe fn respond(
        sender: &ICoreWebView2,
        args: &ICoreWebView2WebResourceRequestedEventArgs,
        environment: &ICoreWebView2Environment,
        active: bool,
        worker_owner: bool,
        top_navigation: &RefCell<Option<String>>,
    ) -> windows_core::Result<()> {
        if !active || args.Response().is_ok() {
            return Ok(());
        }
        let mut kind = COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL;
        args.cast::<ICoreWebView2WebResourceRequestedEventArgs2>()?
            .RequestedSourceKind(&mut kind)?;
        let Some(worker) = source_kind(kind, worker_owner) else {
            return Ok(());
        };
        let request = args.Request()?;
        let mut raw = PWSTR::null();
        request.Uri(&mut raw)?;
        let Some(url) = http_url(&take_pwstr(raw)) else {
            return Ok(());
        };
        raw = PWSTR::null();
        request.Method(&mut raw)?;
        let method = take_pwstr(raw);
        let Some(method) = request_method(&method) else {
            return Ok(());
        };
        let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER;
        args.ResourceContext(&mut context)?;
        let top_document = !worker
            && context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT
            && top_navigation
                .try_borrow_mut()
                .ok()
                .is_some_and(|mut pending| {
                    if pending.as_deref() == Some(url.as_str()) {
                        pending.take();
                        true
                    } else {
                        false
                    }
                });
        raw = PWSTR::null();
        let top = (!worker && sender.Source(&mut raw).is_ok()).then(|| take_pwstr(raw));
        let referer = header(&request, windows_core::w!("Referer"));
        let origin = worker
            .then(|| header(&request, windows_core::w!("Origin")))
            .flatten();
        let source = source_url(
            &url,
            referer.as_deref(),
            origin.as_deref(),
            top.as_deref(),
            worker,
        )
        .unwrap_or_else(|| url.clone());
        if !blocked(&url, &source, resource_type(context, top_document), method) {
            return Ok(());
        }
        let response = environment.CreateWebResourceResponse(
            None::<&windows::Win32::System::Com::IStream>,
            403,
            windows_core::w!("Blocked"),
            windows_core::w!("Cache-Control: no-store\r\nContent-Length: 0\r\n"),
        )?;
        args.SetResponse(&response)?;
        increment(&BLOCKED); // actual successful response replacement only.
        Ok(())
    }
    unsafe fn install_core(core: ICoreWebView2) -> Result<(), String> {
        if !engine_ready() {
            return Err(UNAVAILABLE.into());
        }
        let core_identity = identity(&core).map_err(|_| INSTALL_FAILED)?;
        let id = key(&core_identity);
        let modern = core.cast::<ICoreWebView2_22>().map_err(|_| {
            SUPPORTED.store(false, Ordering::SeqCst);
            UNSUPPORTED
        })?;
        let environment = core
            .cast::<ICoreWebView2_2>()
            .and_then(|v| v.Environment())
            .map_err(|_| INSTALL_FAILED)?;
        let environment_identity = identity(&environment).map_err(|_| INSTALL_FAILED)?;
        REGISTRY.with(|registry| {
            let mut hooks = registry.try_borrow_mut().map_err(|_| INSTALL_FAILED)?;
            if hooks.contains_key(&id) {
                return Ok(());
            }
            let worker_owner = Rc::new(Cell::new(!hooks.values().any(|h| {
                key(&h.environment_identity) == key(&environment_identity) && h.worker_owner.get()
            })));
            let active = Rc::new(Cell::new(true));
            let top_navigation = Rc::new(RefCell::new(None::<String>));
            let navigation_pending = Rc::clone(&top_navigation);
            let navigation_active = Rc::clone(&active);
            let documents = Rc::new(RefCell::new(DocumentScripts::new()));
            let navigation_documents = Rc::clone(&documents);
            let navigation_core = core.clone();
            let navigation = NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if !navigation_active.get() {
                    return Ok(());
                }
                if let Some(args) = args {
                    let mut raw = PWSTR::null();
                    args.Uri(&mut raw)?;
                    let raw = take_pwstr(raw);
                    if let Ok(mut value) = navigation_pending.try_borrow_mut() { *value = http_url(&raw); }
                    let eligible = super::youtube_url(&raw);
                    let target = eligible.then_some(raw);
                    let desired = mode();
                    let decision = if eligible && desired.0 == u64::MAX { Err(()) } else { navigation_documents.borrow_mut().navigate(target, desired) };
                    match decision {
                        Ok(true) => { args.SetCancel(true)?; register_documents(navigation_core.clone(), Rc::clone(&navigation_documents)); }
                        Err(()) => { SUPPORTED.store(false, Ordering::SeqCst); if eligible { args.SetCancel(true)?; return Err(windows_core::Error::new(windows_core::HRESULT(0x80004005u32 as i32), YOUTUBE_UNAVAILABLE)); } }
                        Ok(false) => {}
                    }
                }
                Ok(())
            }));
            let mut navigation_token = 0;
            core.add_NavigationStarting(&navigation, &mut navigation_token)
                .map_err(|_| INSTALL_FAILED)?;
            let request_active = Rc::clone(&active);
            let request_owner = Rc::clone(&worker_owner);
            let requested =
                WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
                    let (Some(sender), Some(args)) = (sender, args) else {
                        return Ok(());
                    };
                    let result = respond(
                        &sender,
                        &args,
                        &environment,
                        request_active.get(),
                        request_owner.get(),
                        &top_navigation,
                    );
                    if result.is_err() {
                        SUPPORTED.store(false, Ordering::SeqCst);
                    }
                    result
                }));
            let mut request_token = 0;
            if core
                .add_WebResourceRequested(&requested, &mut request_token)
                .is_err()
            {
                active.set(false);
                let _ = core.remove_NavigationStarting(navigation_token);
                return Err(INSTALL_FAILED.into());
            }
            if add_filter(&modern, DOCUMENT).is_err() {
                active.set(false);
                let _ = core.remove_WebResourceRequested(request_token);
                let _ = core.remove_NavigationStarting(navigation_token);
                return Err(INSTALL_FAILED.into());
            }
            if worker_owner.get() && add_filter(&modern, WORKERS).is_err() {
                active.set(false);
                let _ = remove_filter(&modern, DOCUMENT);
                let _ = core.remove_WebResourceRequested(request_token);
                let _ = core.remove_NavigationStarting(navigation_token);
                return Err(INSTALL_FAILED.into());
            }
            hooks.insert(
                id,
                Hook {
                    _identity: core_identity,
                    environment_identity,
                    core,
                    modern,
                    request_token,
                    navigation_token,
                    active,
                    worker_owner,
                    documents,
                },
            );
            increment(&HOOKS);
            let covered = hooks.values().all(|hook| {
                !hook.documents.borrow().failed && hooks
                    .values()
                    .filter(|candidate| {
                        key(&candidate.environment_identity) == key(&hook.environment_identity)
                            && candidate.worker_owner.get()
                    })
                    .count()
                    == 1
            });
            SUPPORTED.store(covered, Ordering::SeqCst);
            Ok(())
        })
    }
    unsafe fn uninstall_core(core: ICoreWebView2) -> Result<(), String> {
        let id = key(&identity(&core).map_err(|_| UNINSTALL_FAILED)?);
        REGISTRY.with(|registry| {
            let mut hooks = registry.try_borrow_mut().map_err(|_| UNINSTALL_FAILED)?;
            let Some(hook) = hooks.remove(&id) else {
                return Ok(());
            };
            hook.active.set(false);
            if hook.documents.borrow_mut().dispose() { decrement(&DOCUMENT_PENDING); }
            let ids = hook.documents.borrow().tokens.iter().cloned().collect();
            remove_documents(hook.core.clone(), Rc::clone(&hook.documents), ids, Box::new(|ok| { if !ok { SUPPORTED.store(false, Ordering::SeqCst); } }));
            let mut failed = false;
            if hook.worker_owner.replace(false) {
                // Transfer the only worker filter to a live child in the same COM environment.
                let replacement = successor(
                    hooks
                        .iter()
                        .map(|(id, h)| (*id, key(&h.environment_identity), h.active.get())),
                    key(&hook.environment_identity),
                );
                if let Some(next) = replacement.and_then(|id| hooks.get(&id)) {
                    if add_filter(&next.modern, WORKERS).is_ok() {
                        next.worker_owner.set(true);
                    } else {
                        failed = true;
                    }
                }
                failed |= remove_filter(&hook.modern, WORKERS).is_err();
            }
            failed |= remove_filter(&hook.modern, DOCUMENT).is_err();
            failed |= hook
                .core
                .remove_WebResourceRequested(hook.request_token)
                .is_err();
            failed |= hook
                .core
                .remove_NavigationStarting(hook.navigation_token)
                .is_err();
            decrement(&HOOKS);
            if failed {
                SUPPORTED.store(false, Ordering::SeqCst);
                Err(UNINSTALL_FAILED.into())
            } else {
                Ok(())
            }
        })
    }
    pub(super) fn close(view: &tauri::Webview) -> Result<(), String> {
        let closing = view.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        view.with_webview(move |platform| unsafe {
            let removed = platform.controller().CoreWebView2().ok()
                .is_some_and(|core| uninstall_core(core).is_ok());
            if !removed { SUPPORTED.store(false, Ordering::SeqCst); }
            let _ = tx.send(());
        }).map_err(|_| UNINSTALL_FAILED.to_owned())?;
        // with_webview retains the runtime's window-id mutex during its callback.
        // A separate sender waits for COM cleanup; any mutex wait stays off the UI thread.
        std::thread::spawn(move || {
            let _ = rx.recv();
            if closing.close().is_err() {
                SUPPORTED.store(false, Ordering::SeqCst);
                let _ = closing.with_webview(move |platform| unsafe {
                    if let Ok(core) = platform.controller().CoreWebView2() { let _ = install_core(core); }
                    SUPPORTED.store(false, Ordering::SeqCst);
                });
            }
        });
        Ok(())
    }
    pub(super) fn operation(view: &tauri::Webview, remove: bool) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let current = std::sync::Arc::new(AtomicBool::new(true));
        let executing = std::sync::Arc::clone(&current);
        view.with_webview(move |platform| unsafe {
            if !executing.load(Ordering::SeqCst) {
                return;
            }
            let result = platform
                .controller()
                .CoreWebView2()
                .map_err(|_| {
                    (if remove {
                        UNINSTALL_FAILED
                    } else {
                        INSTALL_FAILED
                    })
                    .to_owned()
                })
                .and_then(|core| {
                    if !executing.load(Ordering::SeqCst) {
                        return Err(INSTALL_FAILED.into());
                    }
                    let result = if remove {
                        uninstall_core(core.clone())
                    } else {
                        install_core(core.clone())
                    };
                    if !remove && !executing.load(Ordering::SeqCst) {
                        let _ = uninstall_core(core);
                        return Err(INSTALL_FAILED.into());
                    }
                    result
                });
            let _ = tx.send(result);
        })
        .map_err(|_| {
            if remove {
                UNINSTALL_FAILED
            } else {
                INSTALL_FAILED
            }
        })?;
        // The caller must already be on the UI thread. Never navigate on a deferred installation.
        match rx.try_recv() {
            Ok(value) => value,
            Err(_) => {
                current.store(false, Ordering::SeqCst);
                Err((if remove {
                    UNINSTALL_FAILED
                } else {
                    INSTALL_FAILED
                })
                .into())
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn sdk_context_mapping_keeps_top_document_iframe_and_network_types_distinct() {
            assert_eq!(
                resource_type(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, true),
                "document"
            );
            assert_eq!(
                resource_type(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, false),
                "subdocument"
            );
            for (context, expected) in [
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET, "stylesheet"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE, "image"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA, "media"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_TEXT_TRACK, "media"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT, "font"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT, "script"),
                (
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
                    "xmlhttprequest",
                ),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH, "xmlhttprequest"),
                (
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_EVENT_SOURCE,
                    "xmlhttprequest",
                ),
                (
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT,
                    "csp_report",
                ),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, "other"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MANIFEST, "other"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SIGNED_EXCHANGE, "other"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING, "ping"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET, "websocket"),
                (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER, "other"),
            ] {
                assert_eq!(resource_type(context, false), expected);
            }
        }
        #[test]
        fn document_source_is_per_child_but_worker_source_is_only_owner_once() {
            assert_eq!(source_kind(DOCUMENT, false), Some(false));
            assert_eq!(source_kind(DOCUMENT, true), Some(false));
            for kind in [
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_SERVICE_WORKER,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_SHARED_WORKER,
            ] {
                assert_eq!(source_kind(kind, false), None);
                assert_eq!(source_kind(kind, true), Some(true));
            }
            assert_eq!(
                source_kind(COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL, true),
                None
            );
            assert_eq!(
                source_kind(COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS(0), true),
                None
            );
        }
    }
}

#[cfg(windows)]
pub(crate) fn install(view: &tauri::Webview) -> Result<(), String> {
    native::operation(view, false)
}
#[cfg(windows)]
pub(crate) fn uninstall(view: &tauri::Webview) -> Result<(), String> {
    native::operation(view, true)
}
#[cfg(windows)]
pub(crate) fn close(view: &tauri::Webview) -> Result<(), String> {
    native::close(view)
}
#[cfg(not(windows))]
pub(crate) fn install(_: &tauri::Webview) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
#[cfg(not(windows))]
pub(crate) fn uninstall(_: &tauri::Webview) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
#[cfg(not(windows))]
pub(crate) fn close(view: &tauri::Webview) -> Result<(), String> {
    view.close().map_err(|_| UNINSTALL_FAILED.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_is_closed_and_ready_requires_engine_actual_hook_and_supported_runtime() {
        for (supported, engine, hooks) in [(false, true, 1), (true, false, 1), (true, true, 0)] {
            assert!(!compose_status(true, supported, engine, hooks, 0).ready);
        }
        let value = compose_status(false, true, true, 1, u64::MAX);
        assert!(value.ready);
        assert!(!value.enabled);
        assert_eq!(value.blocked_count, MAX_SAFE);
        let value = serde_json::to_value(value).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert_eq!(value["version"], 1);
        assert_eq!(value["listsVersion"], "2026-10-07");
        assert!(value.get("hookCount").is_none());
    }
    #[test]
    fn counters_saturate_at_safe_integer_without_wrapping_or_underflow() {
        let counter = AtomicU64::new(MAX_SAFE - 1);
        increment(&counter);
        increment(&counter);
        assert_eq!(counter.load(Ordering::SeqCst), MAX_SAFE);
        let counter = AtomicU64::new(0);
        decrement(&counter);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn source_precedence_separates_worker_origin_and_unknown_from_document_top() {
        assert_eq!(
            source_url(
                "https://request.example/a",
                Some("https://frame.example/r"),
                Some("https://origin.example"),
                Some("https://top.example"),
                true
            )
            .unwrap(),
            "https://frame.example/r"
        );
        assert_eq!(
            source_url(
                "https://request.example/a",
                None,
                Some("https://origin.example"),
                Some("https://top.example"),
                true
            )
            .unwrap(),
            "https://origin.example/"
        );
        assert_eq!(
            source_url(
                "https://request.example/a",
                None,
                None,
                Some("https://wrong-tab.example"),
                true
            )
            .unwrap(),
            "https://request.example/a"
        );
        assert_eq!(
            source_url(
                "https://request.example/a",
                None,
                Some("https://ignored.example"),
                Some("https://top.example/page"),
                false
            )
            .unwrap(),
            "https://top.example/page"
        );
        assert_eq!(
            source_url(
                "https://request.example/a",
                Some("data:secret"),
                None,
                Some("about:blank"),
                false
            )
            .unwrap(),
            "https://request.example/a"
        );
    }
    #[test]
    fn source_and_request_urls_are_http_only_bounded_with_no_control_credentials_or_fragment() {
        assert_eq!(
            http_url("https://EXAMPLE.org/a#fragment").unwrap(),
            "https://example.org/a"
        );
        for value in [
            "https://user:private@example.org/",
            "file:///private",
            "tauri://localhost/index.html",
            "data:private",
            "https://example.org/\n",
            "",
        ] {
            assert!(http_url(value).is_none());
        }
        let prefix = "https://example.org/";
        let value = format!("{prefix}{}", "a".repeat(MAX_URI_BYTES - prefix.len()));
        assert!(http_url(&value).is_some());
        assert!(http_url(&(value + "a")).is_none());
    }
    #[test]
    fn method_tokens_preserve_valid_custom_case_and_reject_control_injection() {
        for value in ["GET", "POST", "CUSTOM-method", "PATCH"] {
            assert_eq!(request_method(value), Some(value));
        }
        for value in ["", "GET\r\nSecret: value", "BAD METHOD", "日"] {
            assert!(request_method(value).is_none());
        }
        assert!(request_method(&"A".repeat(32)).is_some());
        assert!(request_method(&"A".repeat(33)).is_none());
    }
    #[test]
    fn worker_successor_never_crosses_environment_or_selects_inactive_child() {
        let entries = [(1, 10, false), (2, 20, true), (3, 10, true), (4, 10, true)];
        assert_eq!(successor(entries.into_iter(), 10), Some(3));
        assert_eq!(successor(entries.into_iter(), 20), Some(2));
        assert_eq!(successor(entries.into_iter(), 30), None);
        assert_eq!(successor([(1, 10, false)].into_iter(), 10), None);
    }
    #[cfg(windows)]
    #[test]
    fn mature_engine_network_rules_preserve_exception_type_and_third_party_semantics() {
        use adblock::{
            lists::{FilterSet, ParseOptions},
            request::Request,
            Engine,
        };
        let mut filters = FilterSet::new(false);
        filters.add_filter_list("||ads.example^$script\n@@||ads.example/allowed.js$script\n||tracker.example^$third-party\n||frame.example^$subdocument".to_owned(),ParseOptions::default());
        let engine = Engine::new_with_filter_set(filters);
        let check = |url, source, kind| {
            engine
                .check_network_request(&Request::new(url, source, kind, "GET").unwrap())
                .should_block()
        };
        assert!(check(
            "https://ads.example/banner.js",
            "https://page.example/",
            "script"
        ));
        assert!(!check(
            "https://ads.example/allowed.js",
            "https://page.example/",
            "script"
        ));
        assert!(!check(
            "https://ads.example/banner.png",
            "https://page.example/",
            "image"
        ));
        assert!(check(
            "https://tracker.example/pixel",
            "https://page.example/",
            "image"
        ));
        assert!(!check(
            "https://tracker.example/pixel",
            "https://tracker.example/",
            "image"
        ));
        assert!(check(
            "https://frame.example/ad",
            "https://page.example/",
            "subdocument"
        ));
        assert!(!check(
            "https://frame.example/ad",
            "https://page.example/",
            "document"
        ));
    }
}
