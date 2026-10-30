//! Opt-in, one-shot synthetic browser-to-AI fixture. Never returns page or draft data.
use crate::{
    browser_window as browser,
    desktop_control::{control_main_webview, fixture_main, fixture_snapshot, fixture_tab},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

const SAFE: u64 = 9_007_199_254_740_991;
const TIMEOUT: Duration = Duration::from_secs(20);
static ENABLED: AtomicBool = AtomicBool::new(false);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static OWNED_TAB: AtomicU64 = AtomicU64::new(0);
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

pub(crate) fn enable_control() {
    ENABLED.store(true, Ordering::SeqCst);
}
pub(crate) fn record_private_tab(id: u64) {
    OWNED_TAB.store(id, Ordering::SeqCst);
}
fn consume_owned_tab(slot: &AtomicU64, id: u64) -> Result<(), String> {
    if id == 0 || id > SAFE {
        return Err("browser_ai_control_source_changed".into());
    }
    slot.compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst)
        .map(|_| ())
        .map_err(|_| "browser_ai_control_source_changed".into())
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Applied,
    Failed,
    NotReady,
    SourceChanged,
    ExtractFailed,
    DraftFailed,
    DraftRefused,
    DraftNotReady,
    DraftSnapshotFailed,
    DraftNavigationChanged,
    DraftHistoryChanged,
    DraftContextInvalid,
    ReferenceUnavailable,
    Superseded,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AckResult {
    accepted: bool,
    reference: bool,
    surface: Surface,
}
#[derive(Debug, Deserialize)]
pub enum Surface {
    #[serde(rename = "pi")]
    Pi,
}

struct Pending {
    request_id: u64,
    tab_id: u64,
    deadline: Instant,
    sender: Option<oneshot::Sender<Result<(), String>>>,
}
struct Ticket<'a> {
    slot: &'a Mutex<Option<Pending>>,
    request_id: u64,
    deadline: Instant,
    receiver: Option<oneshot::Receiver<Result<(), String>>>,
}
impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        let mut pending = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        if pending
            .as_ref()
            .is_some_and(|entry| entry.request_id == self.request_id)
        {
            *pending = None;
        }
    }
}
fn begin<'a>(
    slot: &'a Mutex<Option<Pending>>,
    sequence: &AtomicU64,
    enabled: bool,
    busy: bool,
    tab_id: u64,
    deadline: Instant,
) -> Result<Ticket<'a>, String> {
    if !enabled {
        return Err("browser_ai_control_forbidden".into());
    }
    if tab_id == 0 || tab_id > SAFE {
        return Err("browser_ai_control_invalid".into());
    }
    if Instant::now() >= deadline {
        return Err("browser_ai_control_timeout".into());
    }
    let mut pending = slot.lock().map_err(|_| "browser_ai_control_unavailable")?;
    if busy || pending.is_some() {
        return Err("browser_ai_control_busy".into());
    }
    let request_id = sequence
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |id| {
            id.checked_add(1).filter(|id| *id <= SAFE)
        })
        .map(|id| id + 1)
        .map_err(|_| "browser_ai_control_exhausted")?;
    let (sender, receiver) = oneshot::channel();
    *pending = Some(Pending {
        request_id,
        tab_id,
        deadline,
        sender: Some(sender),
    });
    Ok(Ticket {
        slot,
        request_id,
        deadline,
        receiver: Some(receiver),
    })
}
fn complete(
    slot: &Mutex<Option<Pending>>,
    enabled: bool,
    label: &str,
    request_id: u64,
    tab_id: u64,
    outcome: Outcome,
    result: Option<AckResult>,
    now: Instant,
) -> Result<(), String> {
    if !enabled || label != "main" {
        return Err("browser_ai_control_forbidden".into());
    }
    if request_id == 0 || request_id > SAFE || tab_id == 0 || tab_id > SAFE {
        return Err("browser_ai_control_invalid".into());
    }
    let valid = match (&outcome, &result) {
        (
            Outcome::Applied,
            Some(AckResult {
                accepted: true,
                reference: true,
                surface: Surface::Pi,
            }),
        ) => true,
        (
            Outcome::Failed
            | Outcome::NotReady
            | Outcome::SourceChanged
            | Outcome::ExtractFailed
            | Outcome::DraftFailed
            | Outcome::DraftRefused
            | Outcome::DraftNotReady
            | Outcome::DraftSnapshotFailed
            | Outcome::DraftNavigationChanged
            | Outcome::DraftHistoryChanged
            | Outcome::DraftContextInvalid
            | Outcome::ReferenceUnavailable
            | Outcome::Superseded,
            None,
        ) => true,
        _ => false,
    };
    if !valid {
        return Err("browser_ai_control_invalid".into());
    }
    let mut pending = slot.lock().map_err(|_| "browser_ai_control_unavailable")?;
    let entry = pending
        .as_mut()
        .filter(|entry| entry.request_id == request_id && entry.tab_id == tab_id)
        .ok_or("browser_ai_control_invalid")?;
    if now >= entry.deadline {
        *pending = None;
        return Err("browser_ai_control_expired".into());
    }
    let sender = entry.sender.take().ok_or("browser_ai_control_invalid")?;
    let value = match outcome {
        Outcome::Applied => Ok(()),
        Outcome::DraftNotReady => Err("browser_ai_control_draft_not_ready".into()),
        Outcome::DraftSnapshotFailed => Err("browser_ai_control_draft_snapshot_failed".into()),
        Outcome::DraftNavigationChanged => {
            Err("browser_ai_control_draft_navigation_changed".into())
        }
        Outcome::DraftContextInvalid => Err("browser_ai_control_draft_context_invalid".into()),
        Outcome::DraftHistoryChanged => Err("browser_ai_control_draft_history_changed".into()),
        Outcome::Failed => Err("browser_ai_control_failed".into()),
        Outcome::NotReady => Err("browser_ai_control_not_ready".into()),
        Outcome::SourceChanged => Err("browser_ai_control_source_changed".into()),
        Outcome::ExtractFailed => Err("browser_ai_control_extract_failed".into()),
        Outcome::DraftFailed => Err("browser_ai_control_draft_failed".into()),
        Outcome::DraftRefused => Err("browser_ai_control_draft_refused".into()),
        Outcome::ReferenceUnavailable => Err("browser_ai_control_reference_unavailable".into()),
        Outcome::Superseded => Err("browser_ai_control_superseded".into()),
    };
    sender
        .send(value)
        .map_err(|_| "browser_ai_control_unknown".into())
}
#[tauri::command]
pub fn browser_ai_control_ack(
    webview: tauri::Webview,
    request_id: u64,
    tab_id: u64,
    outcome: Outcome,
    result: Option<AckResult>,
) -> Result<(), String> {
    let main = webview
        .url()
        .is_ok_and(|url| crate::local_pairing_address(webview.label(), &url));
    complete(
        &PENDING,
        ENABLED.load(Ordering::SeqCst) && main,
        webview.label(),
        request_id,
        tab_id,
        outcome,
        result,
        Instant::now(),
    )
}
fn fixture_url(port: u16) -> Result<String, String> {
    if port < 1024 || port == 3020 {
        return Err("browser_ai_control_invalid".into());
    }
    Ok(format!("http://127.0.0.1:{port}/__hub_ai_fixture"))
}
fn source_matches(tabs: &Value, status: &Value, id: u64, url: &str, visible: bool) -> bool {
    if id == 0
        || id > SAFE
        || status["activeTabId"].as_u64() != Some(id)
        || visible && status["visible"] != true
    {
        return false;
    }
    let rows = |value: &Value| {
        value.as_array().is_some_and(|rows| {
            rows.iter()
                .filter(|row| row["id"].as_u64() == Some(id))
                .count()
                == 1
        })
    };
    if !rows(tabs) || !rows(&status["tabs"]) {
        return false;
    }
    let raw = tabs
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"].as_u64() == Some(id)))
        .unwrap();
    let row = status["tabs"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"].as_u64() == Some(id)))
        .unwrap();
    raw["url"].as_str() == Some(url)
        && raw["active"] == true
        && raw["private"] == true
        && raw["discarded"] == false
        && row["active"] == true
        && row["private"] == true
        && row["viewExists"] == true
        && row["discarded"] == false
}
#[derive(Debug, PartialEq, Eq)]
enum LoadState {
    Waiting,
    Ready,
}
fn load_state(
    tabs: &Value,
    status: &Value,
    id: u64,
    url: &str,
    old_blank: &str,
    newtab: &str,
) -> Result<LoadState, String> {
    let raw = tabs
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["id"].as_u64() == Some(id)))
        .ok_or("browser_ai_control_loaded_source")?;
    let current = raw["url"]
        .as_str()
        .ok_or("browser_ai_control_loaded_source")?;
    if !source_matches(tabs, status, id, current, true) {
        return Err("browser_ai_control_loaded_source".into());
    }
    let loading = raw["loading"]
        .as_bool()
        .ok_or("browser_ai_control_loaded_source")?;
    if current == url {
        return Ok(if loading {
            LoadState::Waiting
        } else {
            LoadState::Ready
        });
    }
    if ["", "about:blank", old_blank, newtab].contains(&current) {
        return Ok(LoadState::Waiting);
    }
    Err("browser_ai_control_loaded_source".into())
}
fn load_observation(status: &Value, id: u64) -> Option<(u64, u64, u64)> {
    let row = status["tabs"]
        .as_array()?
        .iter()
        .find(|row| row["id"].as_u64() == Some(id))?;
    let values = (
        row["childLifetime"].as_u64()?,
        row["pageLoad"]["started"].as_u64()?,
        row["pageLoad"]["finished"].as_u64()?,
    );
    (values.0 > 0 && values.0 <= SAFE && values.1 <= SAFE && values.2 <= SAFE).then_some(values)
}
fn completed_load(before: (u64, u64, u64), after: Option<(u64, u64, u64)>) -> Result<bool, String> {
    let after = after.ok_or("browser_ai_control_loaded_source")?;
    if after.0 != before.0 || after.1 < before.1 || after.2 < before.2 {
        return Err("browser_ai_control_loaded_source".into());
    }
    Ok(after.1 > before.1 && after.2 > before.2 && after.2 >= after.1)
}
fn validate_article(article: &Value, id: u64, url: &str) -> Result<(), String> {
    let paragraphs = article["paragraphs"]
        .as_array()
        .ok_or("browser_ai_control_source_changed")?;
    let text = paragraphs
        .iter()
        .map(|p| p.as_str())
        .collect::<Option<Vec<_>>>()
        .ok_or("browser_ai_control_source_changed")?
        .join("\n");
    if article["id"].as_u64() != Some(id)
        || article["url"].as_str() != Some(url)
        || article["title"] != "Hub AI fixture"
        || article["truncated"] != false
        || text.chars().count() > 1024
        || !text.contains("hub-ai-fixture-v1")
        || text.chars().any(|c| c == '\0')
    {
        return Err("browser_ai_control_source_changed".into());
    }
    Ok(())
}
fn expires_at(now: SystemTime, remaining: Duration) -> Result<u64, String> {
    let now = u64::try_from(
        now.duration_since(UNIX_EPOCH)
            .map_err(|_| "browser_ai_control_invalid")?
            .as_millis(),
    )
    .map_err(|_| "browser_ai_control_invalid")?;
    expiry_millis(
        now,
        u64::try_from(remaining.as_millis()).map_err(|_| "browser_ai_control_invalid")?,
    )
}
fn expiry_millis(now: u64, remaining: u64) -> Result<u64, String> {
    now.checked_add(remaining)
        .filter(|value| *value <= SAFE)
        .ok_or_else(|| "browser_ai_control_invalid".into())
}
fn validate_prompt(prompt: &str, url: &str) -> Result<(), String> {
    let text = prompt
        .strip_prefix(&format!("{url}\nHub AI fixture\n\n"))
        .ok_or("browser_ai_control_source_changed")?;
    if text.chars().count() > 1024 || !text.contains("hub-ai-fixture-v1") || text.contains('\0') {
        return Err("browser_ai_control_source_changed".into());
    }
    Ok(())
}
fn response(id: u64) -> Value {
    json!({"tabId":id,"private":true,"accepted":true,"reference":true,"surface":"pi"})
}
async fn recheck(app: &AppHandle, id: u64, url: &str, visible: bool) -> Result<(), String> {
    let (_, tabs, status) = fixture_snapshot(app)
        .await
        .map_err(|_| "browser_ai_control_source_changed")?;
    if !source_matches(&tabs, &status, id, url, visible) {
        return Err("browser_ai_control_source_changed".into());
    }
    let expected = url.to_owned();
    fixture_main(app, move |handle| {
        let actual = handle
            .get_webview(&format!("browser-tab-{id}"))
            .and_then(|view| view.url().ok())
            .ok_or("browser_ai_control_source_changed")?;
        if actual.as_str() != expected {
            return Err("browser_ai_control_source_changed".into());
        }
        Ok(())
    })
    .await
    .map_err(|_| "browser_ai_control_source_changed".into())
}
#[derive(Clone, Copy)]
enum Extraction {
    Reader,
    Ai,
}
fn extraction_error(extraction: Extraction, error: &str) -> &'static str {
    match (extraction, error) {
        (Extraction::Reader, "reader_context_changed") => "browser_ai_control_reader_source",
        (Extraction::Ai, "browser_ai_source_changed") => "browser_ai_control_ai_source",
        (Extraction::Reader, _) => "browser_ai_control_reader_read",
        (Extraction::Ai, _) => "browser_ai_control_ai_extract",
    }
}
async fn run(app: AppHandle, port: u16) -> Result<Value, String> {
    let url = fixture_url(port)?;
    let (main, tabs, status) = fixture_snapshot(&app)
        .await
        .map_err(|_| "browser_ai_control_blank_source")?;
    let (id, private) =
        fixture_tab(&tabs, &status, None, "").map_err(|_| "browser_ai_control_blank_source")?;
    if !private {
        return Err("browser_ai_control_blank_source".into());
    }
    consume_owned_tab(&OWNED_TAB, id).map_err(|_| "browser_ai_control_ownership")?;
    let deadline = Instant::now() + TIMEOUT;
    let mut ticket = begin(
        &PENDING,
        &SEQUENCE,
        ENABLED.load(Ordering::SeqCst),
        crate::desktop_control::ai_control_busy(),
        id,
        deadline,
    )?;
    let (old_blank, newtab, before_load) = fixture_main(&app, move |handle| {
        let _ = control_main_webview(&handle)?;
        let tabs = serde_json::to_value(browser::browser_tabs())
            .map_err(|_| "browser_ai_control_navigate")?;
        let status = browser::control_status(&handle);
        let (_, private) = fixture_tab(&tabs, &status, Some(id), "")?;
        if !private {
            return Err("browser_ai_control_navigate".into());
        }
        let view = handle
            .get_webview(&format!("browser-tab-{id}"))
            .ok_or("browser_ai_control_navigate")?;
        let actual = view.url().map_err(|_| "browser_ai_control_navigate")?;
        let origin = control_main_webview(&handle)?
            .url()
            .map_err(|_| "browser_ai_control_navigate")?;
        if actual.as_str() != "about:blank"
            && !(actual.path() == "/newtab.html" && actual.origin() == origin.origin())
        {
            return Err("browser_ai_control_navigate".into());
        }
        let newtab = origin
            .join("/newtab.html")
            .map_err(|_| "browser_ai_control_navigate")?;
        let before_load = load_observation(&status, id).ok_or("browser_ai_control_navigate")?;
        browser::browser_navigate(handle, fixture_url(port)?)?;
        Ok((actual.to_string(), newtab.to_string(), before_load))
    })
    .await
    .map_err(|_| "browser_ai_control_navigate")?;
    loop {
        let (_, tabs, status) = fixture_snapshot(&app)
            .await
            .map_err(|_| "browser_ai_control_loaded_source")?;
        let state = load_state(&tabs, &status, id, &url, &old_blank, &newtab)?;
        let completed = completed_load(before_load, load_observation(&status, id))?;
        let actual = fixture_main(&app, move |handle| {
            handle
                .get_webview(&format!("browser-tab-{id}"))
                .and_then(|view| view.url().ok())
                .map(|url| url.to_string())
                .ok_or("browser_ai_control_child_source".to_owned())
        })
        .await
        .map_err(|_| "browser_ai_control_child_source")?;
        if state == LoadState::Ready && completed && actual == url {
            break;
        }
        if ![
            url.as_str(),
            "about:blank",
            old_blank.as_str(),
            newtab.as_str(),
        ]
        .contains(&actual.as_str())
        {
            return Err("browser_ai_control_child_source".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    recheck(&app, id, &url, true)
        .await
        .map_err(|_| "browser_ai_control_loaded_source")?;
    let article = serde_json::to_value(
        browser::reading::read(app.clone(), main.clone(), id, url.clone())
            .await
            .map_err(|error| extraction_error(Extraction::Reader, &error))?,
    )
    .map_err(|_| "browser_ai_control_reader_validation")?;
    validate_article(&article, id, &url).map_err(|_| "browser_ai_control_reader_validation")?;
    recheck(&app, id, &url, true)
        .await
        .map_err(|_| "browser_ai_control_loaded_source")?;
    let prompt = browser::browser_send_to_ai(main, app.clone(), id, url.clone())
        .await
        .map_err(|error| extraction_error(Extraction::Ai, &error))?;
    validate_prompt(&prompt, &url).map_err(|_| "browser_ai_control_ai_validation")?;
    recheck(&app, id, &url, true)
        .await
        .map_err(|_| "browser_ai_control_loaded_source")?;
    let expires = expires_at(
        SystemTime::now(),
        ticket
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or("browser_ai_control_timeout")?,
    )?;
    app.emit_to(
        "main",
        "browser-ai-control",
        json!({"requestId":ticket.request_id,"expiresAt":expires,"tabId":id,"port":port}),
    )
    .map_err(|_| "browser_ai_control_unknown")?;
    let remaining = ticket
        .deadline
        .checked_duration_since(Instant::now())
        .ok_or("browser_ai_control_unknown")?;
    tokio::time::timeout(
        remaining,
        ticket.receiver.take().ok_or("browser_ai_control_unknown")?,
    )
    .await
    .map_err(|_| "browser_ai_control_unknown")?
    .map_err(|_| "browser_ai_control_unknown")??;
    recheck(&app, id, &url, false)
        .await
        .map_err(|_| "browser_ai_control_post_ack_source")?;
    Ok(response(id))
}
pub(crate) async fn fixture(app: AppHandle, port: u16) -> Result<Value, String> {
    if !ENABLED.load(Ordering::SeqCst) {
        return Err("browser_ai_control_forbidden".into());
    }
    tokio::time::timeout(TIMEOUT, run(app, port))
        .await
        .map_err(|_| "browser_ai_control_unknown".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn result() -> Option<AckResult> {
        Some(AckResult {
            accepted: true,
            reference: true,
            surface: Surface::Pi,
        })
    }
    fn source() -> (Value, Value, String) {
        let url = fixture_url(1024).unwrap();
        (
            json!([{"id":1,"url":url,"active":true,"private":true,"discarded":false}]),
            json!({"visible":true,"activeTabId":1,"tabs":[{"id":1,"active":true,"private":true,"discarded":false,"viewExists":true}]}),
            url,
        )
    }
    #[test]
    fn port_and_result_are_closed() {
        for port in [1024, 3021, 65535] {
            assert_eq!(
                fixture_url(port).unwrap(),
                format!("http://127.0.0.1:{port}/__hub_ai_fixture")
            );
        }
        for port in [0, 1023, 3020] {
            assert!(fixture_url(port).is_err());
        }
        let value = response(SAFE);
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert_eq!(value["surface"], "pi");
        for value in [
            json!({"accepted":true,"reference":true,"surface":"pi","draftId":"private"}),
            json!({"accepted":true,"reference":true,"surface":"t3"}),
            json!({"accepted":true,"reference":true,"surface":"legacy"}),
            json!({"accepted":true,"surface":"pi"}),
        ] {
            assert!(serde_json::from_value::<AckResult>(value).is_err());
        }
    }
    #[test]
    fn source_requires_exact_owned_private_active_fixed_url() {
        let (tabs, status, url) = source();
        assert!(source_matches(&tabs, &status, 1, &url, true));
        let mut hidden = status.clone();
        hidden["visible"] = json!(false);
        assert!(!source_matches(&tabs, &hidden, 1, &url, true));
        assert!(source_matches(&tabs, &hidden, 1, &url, false));
        for key in ["active", "private"] {
            let mut bad = tabs.clone();
            bad[0][key] = json!(false);
            assert!(!source_matches(&bad, &status, 1, &url, false));
        }
        for key in ["discarded", "viewExists", "private"] {
            let mut bad = status.clone();
            bad["tabs"][0][key] = json!(key == "discarded");
            assert!(!source_matches(&tabs, &bad, 1, &url, false));
        }
        assert!(!source_matches(
            &tabs,
            &status,
            1,
            &format!("{url}?x=1"),
            false
        ));
        assert!(!source_matches(&tabs, &status, 0, &url, false));
        let mut duplicate = tabs.clone();
        duplicate.as_array_mut().unwrap().push(tabs[0].clone());
        assert!(!source_matches(&duplicate, &status, 1, &url, false));
    }
    #[test]
    fn article_is_verified_and_bounded() {
        let url = fixture_url(1024).unwrap();
        let article = json!({"id":1,"url":url,"title":"Hub AI fixture","paragraphs":["hub-ai-fixture-v1"],"truncated":false});
        assert!(validate_article(&article, 1, &url).is_ok());
        for (key, value) in [
            ("title", json!("Private")),
            ("url", json!("https://other.invalid")),
            ("id", json!(2)),
            ("truncated", json!(true)),
            ("paragraphs", json!(["x".repeat(1025)])),
            ("paragraphs", json!(["hub-ai-fixture-v1\0"])),
            ("paragraphs", json!([null])),
        ] {
            let mut bad = article.clone();
            bad[key] = value;
            assert!(validate_article(&bad, 1, &url).is_err());
        }
        let mut boundary = article;
        boundary["paragraphs"] = json!([format!("hub-ai-fixture-v1{}", "😀".repeat(1024 - 17))]);
        assert!(validate_article(&boundary, 1, &url).is_ok());
    }
    #[test]
    fn ticket_is_disabled_bounded_busy_and_drop_cleans() {
        let slot = Mutex::new(None);
        let seq = AtomicU64::new(0);
        let deadline = Instant::now() + TIMEOUT;
        assert!(begin(&slot, &seq, false, false, 1, deadline).is_err());
        for id in [0, SAFE + 1, u64::MAX] {
            assert!(begin(&slot, &seq, true, false, id, deadline).is_err());
        }
        assert!(begin(&slot, &seq, true, true, 1, deadline).is_err());
        assert!(begin(&slot, &seq, true, false, 1, Instant::now()).is_err());
        let ticket = begin(&slot, &seq, true, false, 1, deadline).unwrap();
        assert!(begin(&slot, &seq, true, false, 1, deadline).is_err());
        drop(ticket);
        assert!(slot.lock().unwrap().is_none());
        seq.store(SAFE, Ordering::SeqCst);
        assert!(begin(&slot, &seq, true, false, 1, deadline).is_err());
    }
    #[tokio::test]
    async fn ack_is_main_exact_one_shot_and_unknown_is_not_success() {
        let slot = Mutex::new(None);
        let seq = AtomicU64::new(0);
        let now = Instant::now();
        let mut ticket = begin(&slot, &seq, true, false, 1, now + TIMEOUT).unwrap();
        for label in ["", "browser-tab-1", "Main"] {
            assert!(complete(&slot, true, label, 1, 1, Outcome::Applied, result(), now).is_err());
        }
        assert!(complete(&slot, false, "main", 1, 1, Outcome::Applied, result(), now).is_err());
        assert!(complete(&slot, true, "main", 2, 1, Outcome::Applied, result(), now).is_err());
        assert!(complete(&slot, true, "main", 1, 2, Outcome::Applied, result(), now).is_err());
        assert!(complete(&slot, true, "main", 1, 1, Outcome::Applied, None, now).is_err());
        assert!(complete(&slot, true, "main", 1, 1, Outcome::Failed, result(), now).is_err());
        complete(&slot, true, "main", 1, 1, Outcome::Applied, result(), now).unwrap();
        assert!(ticket.receiver.take().unwrap().await.unwrap().is_ok());
        assert!(complete(&slot, true, "main", 1, 1, Outcome::Applied, result(), now).is_err());
        drop(ticket);
        assert!(slot.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn negative_ack_expiry_and_cancel_are_not_acceptance() {
        for outcome in [Outcome::Failed, Outcome::Superseded] {
            let slot = Mutex::new(None);
            let seq = AtomicU64::new(0);
            let mut ticket = begin(&slot, &seq, true, false, 1, Instant::now() + TIMEOUT).unwrap();
            complete(&slot, true, "main", 1, 1, outcome, None, Instant::now()).unwrap();
            assert!(ticket.receiver.take().unwrap().await.unwrap().is_err());
        }
        let slot = Mutex::new(None);
        let seq = AtomicU64::new(0);
        let deadline = Instant::now() + TIMEOUT;
        let mut ticket = begin(&slot, &seq, true, false, 1, deadline).unwrap();
        assert!(complete(
            &slot,
            true,
            "main",
            1,
            1,
            Outcome::Applied,
            result(),
            deadline
        )
        .is_err());
        assert!(ticket.receiver.take().unwrap().await.is_err());
        assert!(slot.lock().unwrap().is_none());
    }
    #[test]
    fn expiry_cannot_overflow_js_or_unix_time() {
        assert_eq!(expiry_millis(SAFE - 1, 1), Ok(SAFE));
        assert!(expiry_millis(SAFE, 1).is_err());
        assert!(expiry_millis(u64::MAX, 1).is_err());
        assert!(expires_at(UNIX_EPOCH - Duration::from_millis(1), Duration::ZERO).is_err());
    }
    #[test]
    fn owned_tab_is_exact_and_consumed_once() {
        let slot = AtomicU64::new(7);
        for id in [0, SAFE + 1, 8] {
            assert!(consume_owned_tab(&slot, id).is_err());
            assert_eq!(slot.load(Ordering::SeqCst), 7);
        }
        assert!(consume_owned_tab(&slot, 7).is_ok());
        assert!(consume_owned_tab(&slot, 7).is_err());
    }
    #[test]
    fn actual_ai_extraction_is_fixed_title_url_and_body_bounded() {
        let url = fixture_url(1024).unwrap();
        let prefix = format!("{url}\nHub AI fixture\n\n");
        let valid = format!("{prefix}hub-ai-fixture-v1{}", "😀".repeat(1024 - 17));
        assert!(validate_prompt(&valid, &url).is_ok());
        assert!(validate_prompt(&format!("{valid}x"), &url).is_err());
        for prompt in [
            url.clone(),
            format!("{url}\nOther\n\nhub-ai-fixture-v1"),
            format!("{prefix}wrong marker"),
            format!("{prefix}hub-ai-fixture-v1\0"),
        ] {
            assert!(validate_prompt(&prompt, &url).is_err());
        }
    }
    #[test]
    fn extraction_failures_preserve_source_change_and_redact_other_causes() {
        let changed = extraction_error(Extraction::Reader, "reader_context_changed");
        assert_ne!(
            changed,
            extraction_error(Extraction::Ai, "browser_ai_source_changed")
        );
        assert_ne!(
            changed,
            extraction_error(Extraction::Reader, "reader_unavailable")
        );
        assert_ne!(
            changed,
            extraction_error(Extraction::Ai, "browser_unavailable")
        );
        for private_cause in [
            "internal credentials",
            "page exception synthetic",
            "browser_ai_control_source_changed",
        ] {
            assert_eq!(
                extraction_error(Extraction::Reader, private_cause),
                extraction_error(Extraction::Reader, "reader_unavailable")
            );
            assert_eq!(
                extraction_error(Extraction::Ai, private_cause),
                extraction_error(Extraction::Ai, "browser_unavailable")
            );
            assert!(!extraction_error(Extraction::Reader, private_cause).contains(private_cause));
        }
    }
    #[test]
    fn load_wait_accepts_only_verified_old_blank_until_exact_target_completes() {
        let (mut tabs, status, url) = source();
        let newtab = "http://tauri.localhost/newtab.html";
        for old in ["about:blank", newtab] {
            for current in ["", "about:blank", old, newtab] {
                for loading in [true, false] {
                    tabs[0]["url"] = json!(current);
                    tabs[0]["loading"] = json!(loading);
                    assert_eq!(
                        load_state(&tabs, &status, 1, &url, old, newtab),
                        Ok(LoadState::Waiting)
                    );
                }
            }
        }
        tabs[0]["url"] = json!(url);
        tabs[0]["loading"] = json!(true);
        assert_eq!(
            load_state(&tabs, &status, 1, &url, "about:blank", newtab),
            Ok(LoadState::Waiting)
        );
        tabs[0]["loading"] = json!(false);
        assert_eq!(
            load_state(&tabs, &status, 1, &url, "about:blank", newtab),
            Ok(LoadState::Ready)
        );
        for other in [
            "https://other.invalid/",
            "http://other.invalid/newtab.html",
            "http://tauri.localhost/other.html",
            "about:blank#other",
        ] {
            tabs[0]["url"] = json!(other);
            assert!(load_state(&tabs, &status, 1, &url, "about:blank", newtab).is_err());
        }
        tabs[0]["url"] = json!(format!("{url}?other=1"));
        assert!(load_state(&tabs, &status, 1, &url, "about:blank", newtab).is_err());
    }
    #[test]
    fn load_wait_rejects_private_active_child_and_shape_changes_even_for_old_blank() {
        let (mut tabs, status, url) = source();
        let newtab = "http://tauri.localhost/newtab.html";
        for current in ["", newtab, url.as_str()] {
            tabs[0]["url"] = json!(current);
            tabs[0]["loading"] = json!(false);
            for key in ["active", "private", "discarded"] {
                let mut changed = tabs.clone();
                changed[0][key] = json!(key == "discarded");
                assert!(load_state(&changed, &status, 1, &url, newtab, newtab).is_err());
            }
            for key in ["active", "private", "viewExists", "discarded"] {
                let mut changed = status.clone();
                changed["tabs"][0][key] = json!(key == "discarded");
                assert!(load_state(&tabs, &changed, 1, &url, newtab, newtab).is_err());
            }
            for key in ["visible", "activeTabId"] {
                let mut changed = status.clone();
                changed[key] = json!(false);
                assert!(load_state(&tabs, &changed, 1, &url, newtab, newtab).is_err());
            }
        }
        for loading in [json!(null), json!("false"), json!(0)] {
            tabs[0]["loading"] = loading;
            assert!(load_state(&tabs, &status, 1, &url, newtab, newtab).is_err());
        }
        tabs[0]["loading"] = json!(false);
        let mut duplicate = tabs.clone();
        duplicate.as_array_mut().unwrap().push(tabs[0].clone());
        assert!(load_state(&duplicate, &status, 1, &url, newtab, newtab).is_err());
    }
    #[test]
    fn navigation_completion_requires_same_child_and_new_finished_load() {
        let before = (3, 1, 1);
        assert_eq!(completed_load(before, Some(before)), Ok(false));
        assert_eq!(completed_load(before, Some((3, 2, 1))), Ok(false));
        assert_eq!(completed_load(before, Some((3, 2, 2))), Ok(true));
        for after in [None, Some((4, 2, 2)), Some((3, 0, 2)), Some((3, 2, 0))] {
            assert!(completed_load(before, after).is_err());
        }
        let (_, mut status, _) = source();
        status["tabs"][0]["childLifetime"] = json!(3);
        status["tabs"][0]["pageLoad"] = json!({"started":2,"finished":2});
        assert_eq!(load_observation(&status, 1), Some((3, 2, 2)));
        for invalid in [json!(null), json!("2"), json!(SAFE + 1)] {
            status["tabs"][0]["pageLoad"]["started"] = invalid;
            assert!(load_observation(&status, 1).is_none());
        }
    }
    #[test]
    fn main_failure_categories_are_closed_negative_receipts() {
        let cases = [
            (Outcome::DraftHistoryChanged, "draft_history_changed"),
            (Outcome::DraftNotReady, "draft_not_ready"),
            (Outcome::DraftSnapshotFailed, "draft_snapshot_failed"),
            (Outcome::DraftNavigationChanged, "draft_navigation_changed"),
            (Outcome::DraftContextInvalid, "draft_context_invalid"),
            (Outcome::NotReady, "not_ready"),
            (Outcome::SourceChanged, "source_changed"),
            (Outcome::ExtractFailed, "extract_failed"),
            (Outcome::DraftFailed, "draft_failed"),
            (Outcome::DraftRefused, "draft_refused"),
            (Outcome::ReferenceUnavailable, "reference_unavailable"),
        ];
        for (outcome, code) in cases {
            let slot = Mutex::new(None);
            let sequence = AtomicU64::new(0);
            let mut ticket =
                begin(&slot, &sequence, true, false, 1, Instant::now() + TIMEOUT).unwrap();
            assert!(complete(
                &slot,
                true,
                "main",
                ticket.request_id,
                1,
                outcome,
                result(),
                Instant::now()
            )
            .is_err());
            complete(
                &slot,
                true,
                "main",
                ticket.request_id,
                1,
                outcome,
                None,
                Instant::now(),
            )
            .unwrap();
            assert_eq!(
                ticket.receiver.take().unwrap().blocking_recv().unwrap(),
                Err(format!("browser_ai_control_{code}"))
            );
            assert!(complete(
                &slot,
                true,
                "main",
                ticket.request_id,
                1,
                outcome,
                None,
                Instant::now()
            )
            .is_err());
        }
        assert!(serde_json::from_str::<Outcome>(r#""secret-or-arbitrary-error""#).is_err());
    }
}
