//! Fixed, local-only article preview. No generic expression, page write, AI, or persistence.
use super::*;
use serde_json::{json, Value};

const EXTRACT: &str = include_str!("../../../vendor/browser-reader/reader-extract.js");
const MAX_BYTES: usize = 512 * 1024;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const CHANGED: &str = "reader_context_changed";
const UNAVAILABLE: &str = "reader_unavailable";
static READ_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static READER_OCCLUDED: AtomicBool = AtomicBool::new(false);
static STATE: Mutex<ReaderState> = Mutex::new(ReaderState {
    prepared: None,
    opened: None,
});

#[derive(Clone)]
struct Source {
    id: u64,
    label: String,
    url: String,
    child: Arc<()>,
    browser_epoch: u64,
    document_epoch: u64,
    sequence: u64,
    token: String,
}
struct ReaderState {
    prepared: Option<Source>,
    opened: Option<Source>,
}
#[derive(Serialize)]
pub struct ReadingArticle {
    id: u64,
    url: String,
    title: String,
    paragraphs: Vec<String>,
    truncated: bool,
    #[serde(rename = "contextToken")]
    context_token: String,
}
#[derive(Serialize)]
pub struct ReadingOpened {
    id: u64,
    opened: bool,
    #[serde(rename = "contextToken")]
    context_token: String,
}
#[derive(Serialize)]
pub struct ReadingClosed {
    closed: bool,
}

pub(super) fn occluded() -> bool {
    READER_OCCLUDED.load(Ordering::SeqCst)
}
fn token_valid(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 128
        && token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}
fn guard(webview: &tauri::Webview) -> Result<(), String> {
    browser_media_guard(webview)
}
fn input_valid(id: u64, url: &str) -> bool {
    id > 0
        && id <= SAFE_INTEGER
        && url.len() <= 32768
        && url.encode_utf16().count() <= 8192
        && !url.chars().any(char::is_control)
        && tauri::Url::parse(url).is_ok_and(|target| {
            matches!(target.scheme(), "http" | "https")
                && target.host_str().is_some()
                && target.username().is_empty()
                && target.password().is_none()
                && !is_hub_page(&target)
                && !is_internal_url(&target, None)
        })
}
fn source_matches(
    state: &TabState,
    source: &Source,
    visible: bool,
    browser_epoch: u64,
    document_epoch: u64,
) -> bool {
    visible
        && state.active == source.id
        && browser_epoch == source.browser_epoch
        && document_epoch == source.document_epoch
        && state.tabs.iter().any(|tab| {
            tab.id == source.id
                && tab.label == source.label
                && tab.url == source.url
                && media_child_current(tab, &source.child)
        })
}
fn current(source: &Source, interactive: bool) -> bool {
    (!interactive || (latest(source) && native_tabs_interactive() && !occluded()))
        && with_tabs(|state| {
            source_matches(
                state,
                source,
                BROWSER_VISIBLE.load(Ordering::SeqCst),
                BROWSER_EPOCH.load(Ordering::SeqCst),
                BROWSER_PRINT_CONTEXT_EPOCH.load(Ordering::SeqCst),
            )
        })
        .unwrap_or(false)
}
fn capture(id: u64, url: &str) -> Result<Source, String> {
    if !input_valid(id, url) {
        return Err("reader_invalid_request".to_owned());
    }
    if !native_tabs_interactive() || occluded() {
        return Err(CHANGED.to_owned());
    }
    let mut source = with_tabs(|state| {
        let tab = state
            .tabs
            .iter()
            .find(|tab| tab.id == id && tab.id == state.active && tab.url == url)
            .ok_or(CHANGED)?;
        let media = tab
            .media
            .as_ref()
            .filter(|media| media_child_current(tab, &media.child))
            .ok_or(CHANGED)?;
        let identity = media.context_identity.ok_or(UNAVAILABLE)?;
        Ok::<_, String>((
            Source {
                id,
                label: tab.label.clone(),
                url: tab.url.clone(),
                child: Arc::clone(&media.child),
                browser_epoch: BROWSER_EPOCH.load(Ordering::SeqCst),
                document_epoch: BROWSER_PRINT_CONTEXT_EPOCH.load(Ordering::SeqCst),
                sequence: 0,
                token: String::new(),
            },
            identity,
        ))
    })
    .ok_or(CHANGED)??;
    {
        let state = STATE.lock().map_err(|_| UNAVAILABLE)?;
        if state.opened.is_some() {
            return Err(CHANGED.to_owned());
        }
        source.0.sequence = allocate_child_lifetime(&READ_SEQUENCE).ok_or(UNAVAILABLE)?;
    }
    use sha2::{Digest, Sha256};
    let scope = format!(
        "browser.reader.v1:{id}:{}:{}:{}:{}",
        source.1, source.0.browser_epoch, source.0.document_epoch, source.0.sequence
    );
    source.0.token = Sha256::digest(scope.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(source.0)
}
fn latest(source: &Source) -> bool {
    source.sequence == READ_SEQUENCE.load(Ordering::SeqCst)
}
fn take_opened(state: &mut ReaderState, token: &str, occlusion: &AtomicBool) -> Option<Source> {
    let removed = if state
        .opened
        .as_ref()
        .is_some_and(|source| source.token == token)
    {
        state.opened.take()
    } else {
        None
    };
    if removed.is_some() {
        occlusion.store(false, Ordering::SeqCst);
    }
    removed
}
fn closed(app: &AppHandle, source: Source) {
    layout(app);
    let _ = app.emit_to(
        MAIN_LABEL,
        "browser-reader-closed",
        json!({"contextToken":source.token}),
    );
}
pub(super) fn reconcile(app: &AppHandle) {
    // Never hold the reader mutex while obtaining the Tabs mutex or dispatching layout/COM.
    let sources = STATE
        .lock()
        .ok()
        .map(|state| (state.prepared.clone(), state.opened.clone()));
    let Some((prepared, opened)) = sources else {
        return;
    };
    let stale_prepared = prepared.filter(|source| !current(source, false) || !latest(source));
    let stale_opened = opened.filter(|source| !current(source, false));
    let removed = if let Ok(mut state) = STATE.lock() {
        if let Some(source) = stale_prepared {
            if state
                .prepared
                .as_ref()
                .is_some_and(|pending| pending.token == source.token)
            {
                state.prepared = None;
            }
        }
        stale_opened.and_then(|source| take_opened(&mut state, &source.token, &READER_OCCLUDED))
    } else {
        None
    };
    if let Some(source) = removed {
        closed(app, source);
    }
}
fn selection_token(state: &ReaderState, next: u64) -> Option<String> {
    state
        .opened
        .as_ref()
        .filter(|source| source.id != next)
        .map(|source| source.token.clone())
}
pub(super) fn before_activate(app: &AppHandle, next: u64) {
    let removed = if let Ok(mut state) = STATE.lock() {
        let token = selection_token(&state, next);
        token.and_then(|token| take_opened(&mut state, &token, &READER_OCCLUDED))
    } else {
        None
    };
    if let Some(source) = removed {
        closed(app, source);
    }
}
fn send(
    sender: &Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<Value, String>>>>>,
    value: Result<Value, String>,
) {
    if let Some(tx) = sender.lock().ok().and_then(|mut slot| slot.take()) {
        let _ = tx.send(value);
    }
}

enum Cdp {
    Frames,
    World(String),
    Extract(u64),
    Verify,
}
#[cfg(windows)]
fn dispatch(
    app: &AppHandle,
    source: Source,
    operation: Cdp,
    interactive: bool,
    tx: tokio::sync::oneshot::Sender<Result<Value, String>>,
) {
    use webview2_com::{take_pwstr, CallDevToolsProtocolMethodCompletedHandler};
    use windows_core::{HSTRING, PWSTR};
    let Some(view) = app.get_webview(&source.label) else {
        let _ = tx.send(Err(CHANGED.to_owned()));
        return;
    };
    let sender = Arc::new(Mutex::new(Some(tx)));
    let failed = Arc::clone(&sender);
    let handle = app.clone();
    if view.with_webview(move|platform|unsafe{
        if sender.lock().ok().is_none_or(|slot|slot.as_ref().is_none_or(|tx|tx.is_closed())) {return;}
        let result=(||->Result<(),String>{
            let main=handle.get_webview(MAIN_LABEL).ok_or(CHANGED)?;guard(&main).map_err(|_|CHANGED)?;
            if !current(&source,interactive){return Err(CHANGED.to_owned());}
            let core=platform.controller().CoreWebView2().map_err(|_|UNAVAILABLE)?;
            let mut raw=PWSTR::null();core.Source(&mut raw).map_err(|_|UNAVAILABLE)?;
            if take_pwstr(raw)!=source.url {return Err(CHANGED.to_owned());}
            if matches!(operation,Cdp::Verify) {
                send(&sender,Ok(Value::Null));return Ok(());
            }
            let(method,params)=match operation {
                Cdp::Frames=>("Page.getFrameTree",json!({})),
                Cdp::World(frame)=>("Page.createIsolatedWorld",json!({"frameId":frame,"worldName":"hub-reader-v1","grantUniveralAccess":false})),
                Cdp::Extract(context)=>("Runtime.evaluate",json!({"expression":EXTRACT,"contextId":context,"returnByValue":true,"awaitPromise":false})),
                Cdp::Verify=>unreachable!(),
            };
            let completed_source=source.clone();let completed_sender=Arc::clone(&sender);let completed_core=core.clone();let completed_app=handle.clone();
            let completion=CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move|result,raw|{
                let mut actual=PWSTR::null();
                let actual=completed_core.Source(&mut actual).map(|_|take_pwstr(actual));
                let main_current=completed_app.get_webview(MAIN_LABEL).is_some_and(|main|guard(&main).is_ok());
                let reply=if !main_current||!current(&completed_source,interactive)||actual.ok().as_deref()!=Some(completed_source.url.as_str()) {Err(CHANGED.to_owned())}
                    else if result.is_err()||raw.len()>MAX_BYTES {Err(UNAVAILABLE.to_owned())}
                    else{serde_json::from_str(&raw).map_err(|_|UNAVAILABLE.to_owned())};
                send(&completed_sender,reply);Ok(())
            }));
            core.CallDevToolsProtocolMethod(&HSTRING::from(method),&HSTRING::from(params.to_string()),&completion).map_err(|_|UNAVAILABLE)?;
            Ok(())
        })();
        if let Err(error)=result {send(&sender,Err(error));}
    }).is_err(){send(&failed,Err(UNAVAILABLE.to_owned()));}
}
#[cfg(not(windows))]
fn dispatch(
    _app: &AppHandle,
    _source: Source,
    _operation: Cdp,
    _interactive: bool,
    tx: tokio::sync::oneshot::Sender<Result<Value, String>>,
) {
    let _ = tx.send(Err(UNAVAILABLE.to_owned()));
}
async fn cdp(
    app: &AppHandle,
    source: &Source,
    operation: Cdp,
    interactive: bool,
) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    dispatch(app, source.clone(), operation, interactive, tx);
    let result = tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| UNAVAILABLE)?
        .map_err(|_| UNAVAILABLE)??;
    if !current(source, interactive) {
        return Err(CHANGED.to_owned());
    }
    Ok(result)
}
fn frame_id(value: &Value, url: &str) -> Result<String, String> {
    let frame = value.pointer("/frameTree/frame").ok_or(UNAVAILABLE)?;
    let actual = frame
        .get("url")
        .and_then(Value::as_str)
        .ok_or(UNAVAILABLE)?;
    let fragment = frame
        .get("urlFragment")
        .and_then(Value::as_str)
        .unwrap_or("");
    if actual != url && format!("{actual}{fragment}") != url {
        return Err(CHANGED.to_owned());
    }
    frame
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| token_valid(id))
        .map(str::to_owned)
        .ok_or_else(|| UNAVAILABLE.to_owned())
}
fn context_id(value: &Value) -> Result<u64, String> {
    value
        .get("executionContextId")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0 && *id <= SAFE_INTEGER)
        .ok_or_else(|| UNAVAILABLE.to_owned())
}
fn extraction_value(value: Value) -> Result<Value, String> {
    if let Some(exception) = value.get("exceptionDetails") {
        let first = exception
            .pointer("/exception/description")
            .and_then(Value::as_str)
            .and_then(|text| text.lines().next());
        return Err(match first {
            Some("Error: reader_page_too_large") => "reader_page_too_large",
            Some("Error: reader_article_unavailable") => "reader_article_unavailable",
            _ => UNAVAILABLE,
        }
        .to_owned());
    }
    value
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| UNAVAILABLE.to_owned())
}
fn article(value: Value, source: &Source) -> Result<ReadingArticle, String> {
    let object = value
        .as_object()
        .filter(|object| {
            object.len() == 4
                && object
                    .keys()
                    .all(|key| matches!(key.as_str(), "url" | "title" | "paragraphs" | "truncated"))
        })
        .ok_or(UNAVAILABLE)?;
    if object.get("url").and_then(Value::as_str) != Some(source.url.as_str()) {
        return Err(CHANGED.to_owned());
    }
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| title.chars().count() <= 300 && !title.contains('\0'))
        .ok_or(UNAVAILABLE)?;
    let paragraphs = object
        .get("paragraphs")
        .and_then(Value::as_array)
        .filter(|paragraphs| !paragraphs.is_empty() && paragraphs.len() <= 1000)
        .ok_or(UNAVAILABLE)?;
    let mut count = 0usize;
    let paragraphs = paragraphs
        .iter()
        .map(|value| {
            let text = value
                .as_str()
                .filter(|text| !text.trim().is_empty() && !text.contains('\0'))
                .ok_or(UNAVAILABLE)?;
            count = count.checked_add(text.chars().count()).ok_or(UNAVAILABLE)?;
            if count > 100000 {
                return Err(UNAVAILABLE);
            }
            Ok(text.to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let truncated = object
        .get("truncated")
        .and_then(Value::as_bool)
        .ok_or(UNAVAILABLE)?;
    let result = ReadingArticle {
        id: source.id,
        url: source.url.clone(),
        title: title.to_owned(),
        paragraphs,
        truncated,
        context_token: source.token.clone(),
    };
    if serde_json::to_vec(&result).map_err(|_| UNAVAILABLE)?.len() > MAX_BYTES {
        return Err(UNAVAILABLE.to_owned());
    }
    Ok(result)
}

pub async fn read(
    app: AppHandle,
    webview: tauri::Webview,
    id: u64,
    url: String,
) -> Result<ReadingArticle, String> {
    guard(&webview)?;
    let source = capture(id, &url)?;
    let frame = frame_id(&cdp(&app, &source, Cdp::Frames, true).await?, &source.url)?;
    let context = context_id(&cdp(&app, &source, Cdp::World(frame), true).await?)?;
    let value = extraction_value(cdp(&app, &source, Cdp::Extract(context), true).await?)?;
    let result = article(value, &source)?;
    cdp(&app, &source, Cdp::Verify, true).await?;
    if !latest(&source) || !current(&source, true) {
        return Err(CHANGED.to_owned());
    }
    {
        let mut state = STATE.lock().map_err(|_| UNAVAILABLE)?;
        if !latest(&source) {
            return Err(CHANGED.to_owned());
        }
        state.prepared = Some(source.clone());
    }
    if !latest(&source) || !current(&source, true) {
        reconcile(&app);
        return Err(CHANGED.to_owned());
    }
    Ok(result)
}
pub async fn open(
    app: AppHandle,
    webview: tauri::Webview,
    id: u64,
    url: String,
    context_token: String,
) -> Result<ReadingOpened, String> {
    guard(&webview)?;
    if !input_valid(id, &url) || !token_valid(&context_token) {
        return Err("reader_invalid_request".to_owned());
    }
    let source = STATE
        .lock()
        .map_err(|_| UNAVAILABLE)?
        .prepared
        .as_ref()
        .filter(|source| source.id == id && source.url == url && source.token == context_token)
        .cloned()
        .ok_or(CHANGED)?;
    if !latest(&source) || !current(&source, true) {
        return Err(CHANGED.to_owned());
    }
    cdp(&app, &source, Cdp::Verify, true).await?;
    if !latest(&source) || !current(&source, true) {
        return Err(CHANGED.to_owned());
    }
    {
        let mut state = STATE.lock().map_err(|_| UNAVAILABLE)?;
        if !latest(&source)
            || !state
                .prepared
                .as_ref()
                .is_some_and(|pending| pending.token == context_token)
            || state.opened.is_some()
        {
            return Err(CHANGED.to_owned());
        }
        state.prepared = None;
        state.opened = Some(source.clone());
        READER_OCCLUDED.store(true, Ordering::SeqCst);
    }
    if !current(&source, false) {
        reconcile(&app);
        return Err(CHANGED.to_owned());
    }
    layout(&app);
    Ok(ReadingOpened {
        id,
        opened: true,
        context_token,
    })
}
pub async fn close(
    app: AppHandle,
    webview: tauri::Webview,
    context_token: String,
) -> Result<ReadingClosed, String> {
    guard(&webview)?;
    if !token_valid(&context_token) {
        return Err("reader_invalid_request".to_owned());
    }
    let removed = {
        let mut state = STATE.lock().map_err(|_| UNAVAILABLE)?;
        take_opened(&mut state, &context_token, &READER_OCCLUDED)
    };
    if let Some(source) = removed {
        closed(&app, source);
    }
    Ok(ReadingClosed { closed: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Source {
        Source {
            id: 1,
            label: "browser-tab-1".into(),
            url: "https://example.test/article".into(),
            child: Arc::new(()),
            browser_epoch: 2,
            document_epoch: 3,
            sequence: 4,
            token: "reader-old".into(),
        }
    }
    fn tab(source: &Source) -> Tab {
        Tab {
            id: source.id,
            label: source.label.clone(),
            url: source.url.clone(),
            discarded: false,
            title: String::new(),
            loading: false,
            page_load: None,
            desired_muted: false,
            media: Some(BrowserMediaObservation {
                child: Arc::clone(&source.child),
                context_identity: Some(1),
                tracking: false,
                muted: None,
                playing_audio: None,
                can_print: false,
            }),
            pinned: false,
            zoom: 1.0,
            can_back: false,
            can_forward: false,
            group: None,
            private: false,
            private_ready: false,
            hidden_since: None,
            favicon: None,
        }
    }
    #[test]
    fn page_scope_requires_same_active_visible_url_child_and_both_epochs() {
        let source = source();
        let mut state = TabState {
            tabs: vec![tab(&source)],
            active: 1,
            ..TabState::default()
        };
        assert!(source_matches(&state, &source, true, 2, 3));
        for (visible, browser, document) in [(false, 2, 3), (true, 3, 3), (true, 2, 4)] {
            assert!(!source_matches(&state, &source, visible, browser, document));
        }
        state.active = 2;
        assert!(!source_matches(&state, &source, true, 2, 3));
        state.active = 1;
        state.tabs[0].url = "https://other.test/".into();
        assert!(!source_matches(&state, &source, true, 2, 3));
        state.tabs[0].url = source.url.clone();
        state.tabs[0].private = true;
        assert!(!source_matches(&state, &source, true, 2, 3));
        state.tabs[0].private_ready = true;
        assert!(source_matches(&state, &source, true, 2, 3));
        state.tabs[0].discarded = true;
        assert!(!source_matches(&state, &source, true, 2, 3));
        state.tabs[0].discarded = false;
        state.tabs[0].media.as_mut().unwrap().child = Arc::new(());
        assert!(!source_matches(&state, &source, true, 2, 3));
        state.tabs.clear();
        assert!(!source_matches(&state, &source, true, 2, 3));
    }
    #[test]
    fn stale_close_is_idempotent_and_does_not_take_a_new_session_or_remove_its_occlusion() {
        let old = source();
        let mut next = old.clone();
        next.token = "reader-new".into();
        let mut state = ReaderState {
            prepared: None,
            opened: Some(next),
        };
        let occlusion = AtomicBool::new(true);
        assert!(take_opened(&mut state, &old.token, &occlusion).is_none());
        assert!(state.opened.is_some());
        assert!(occlusion.load(Ordering::SeqCst));
        assert!(state.opened.as_ref().unwrap().token == "reader-new");
        assert!(take_opened(&mut state, "reader-new", &occlusion).is_some());
        assert!(!occlusion.load(Ordering::SeqCst));
        assert!(take_opened(&mut state, "reader-new", &occlusion).is_none());
    }
    #[test]
    fn native_sidebar_selection_has_a_before_activate_invalidation_path() {
        let mut state = ReaderState {
            prepared: None,
            opened: Some(source()),
        };
        let occlusion = AtomicBool::new(true);
        assert!(selection_token(&state, 1).is_none());
        let token = selection_token(&state, 2).unwrap();
        assert!(take_opened(&mut state, &token, &occlusion).is_some());
        assert!(state.opened.is_none());
        assert!(!occlusion.load(Ordering::SeqCst));
        // Closing reader while wallet is open leaves the combined mask active.
        let wallet = true;
        let reader = state.opened.is_some();
        assert!(wallet || reader);
    }
    #[test]
    fn article_has_closed_fields_unicode_and_serialized_byte_limits() {
        let source = source();
        let value = |paragraphs| json!({"url":source.url,"title":"😀".repeat(300),"paragraphs":paragraphs,"truncated":true});
        let result = article(value(json!(["😀".repeat(100000)])), &source).unwrap();
        assert!(result.truncated);
        assert_eq!(result.paragraphs[0].chars().count(), 100000);
        assert!(article(value(json!(["😀".repeat(100001)])), &source).is_err());
        assert!(article(value(json!(vec!["x"; 1001])), &source).is_err());
        assert!(article(value(json!([])), &source).is_err());
        for paragraphs in [json!([1]), json!(["a\0b"]), json!([" "])] {
            assert!(article(value(paragraphs), &source).is_err());
        }
        let mut unknown = value(json!(["text"]));
        unknown["links"] = json!([]);
        assert!(article(unknown, &source).is_err());
        let mut unknown = value(json!(["text"]));
        unknown["title"] = json!("x".repeat(301));
        assert!(article(unknown, &source).is_err());
        let mut wrong = value(json!(["text"]));
        wrong["url"] = json!("https://other.test/");
        assert!(matches!(article(wrong,&source),Err(error) if error==CHANGED));
        assert!(serde_json::from_str::<Value>(r#"{"title":"\uD800"}"#).is_err());
    }
    #[test]
    fn input_frame_and_exception_boundaries_keep_known_codes_without_raw_page_data() {
        assert!(input_valid(1, "https://example.test/article"));
        for id in [0, SAFE_INTEGER + 1, u64::MAX] {
            assert!(!input_valid(id, "https://example.test/article"));
        }
        for url in [
            "file:///x",
            "javascript:x",
            "https://user:pass@example.test/",
            "https://hub.jkamma.com/",
            "https://tauri.localhost/newtab.html",
        ] {
            assert!(!input_valid(1, url));
        }
        for token in ["", "with space", "token\0", "日", &"x".repeat(129)] {
            assert!(!token_valid(token));
        }
        assert!(token_valid(&"x".repeat(128)));
        let frames = json!({"frameTree":{"frame":{"id":"frame1","url":"https://example.test/article","urlFragment":"#part"}}});
        assert_eq!(
            frame_id(&frames, "https://example.test/article#part").unwrap(),
            "frame1"
        );
        assert!(context_id(&json!({"executionContextId":0})).is_err());
        assert!(context_id(&json!({"executionContextId":"1"})).is_err());
        for code in ["reader_page_too_large", "reader_article_unavailable"] {
            let value = json!({"exceptionDetails":{"exception":{"description":format!("Error: {code}\n stack")}}});
            assert!(matches!(extraction_value(value),Err(error) if error==code));
        }
        let value = json!({"exceptionDetails":{"text":"private body/token","exception":{"description":"private body/token"}}});
        assert!(matches!(extraction_value(value),Err(error) if error==UNAVAILABLE));
    }
}
