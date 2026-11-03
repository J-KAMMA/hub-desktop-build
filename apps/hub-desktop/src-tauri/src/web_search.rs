//! Built-in web search for Hub Desktop's AI (`hub_web_search`, and the chat
//! 「Web検索」 toggle). A minimal own module, SearXNG-style but in-process:
//! no server, no Docker, no new crate.
//!
//! Boundaries (see docs/hub-desktop-websearch/DECISION.md):
//! - Fixed engines on fixed https hosts only: Wikipedia ja/en API (default)
//!   and Brave through its official API with the user's own key (OS
//!   credential store). No DuckDuckGo (removed 2026-11-03: its terms forbid
//!   displaying its service inside another service), Google, Bing or Yandex.
//! - No redirects, per-engine timeout, response size cap, results capped.
//! - Every search needs an individual approval showing query and engines. A
//!   missing approver fails closed. Nothing here logs a query.
//! - Result text is untrusted model input; parsers keep plain text only.

use reqwest::Url;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub const MAX_RESULTS: usize = 10;
pub const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_QUERY_CHARS: usize = 200;
const MAX_TITLE_CHARS: usize = 200;
const MAX_SNIPPET_CHARS: usize = 400;
const MAX_URL_CHARS: usize = 2000;
const PER_ENGINE_TIMEOUT: Duration = Duration::from_secs(12);
const USER_AGENT: &str = concat!("JKammaHubDesktop/", env!("CARGO_PKG_VERSION"), " (built-in web search; +https://hub.jkamma.com)");
const KEY_SERVICE: &str = "jkamma-hub-web-search";
const KEY_USER: &str = "brave";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    WikipediaJa,
    WikipediaEn,
    Brave,
}

impl Engine {
    pub const ALL: [Engine; 3] = [Engine::WikipediaJa, Engine::WikipediaEn, Engine::Brave];

    pub fn id(self) -> &'static str {
        match self {
            Engine::WikipediaJa => "wikipedia_ja",
            Engine::WikipediaEn => "wikipedia_en",
            Engine::Brave => "brave",
        }
    }
    pub fn host(self) -> &'static str {
        match self {
            Engine::WikipediaJa => "ja.wikipedia.org",
            Engine::WikipediaEn => "en.wikipedia.org",
            Engine::Brave => "api.search.brave.com",
        }
    }
    pub fn from_id(id: &str) -> Option<Engine> {
        Engine::ALL.into_iter().find(|engine| engine.id() == id)
    }
}

/// The only hosts a search may contact.
pub fn host_allowed(host: &str) -> bool {
    Engine::ALL.iter().any(|engine| engine.host() == host)
}

/// Refuses anything but `https://<fixed host>/…` with no userinfo or port.
pub fn ensure_fixed(url: &Url) -> Result<(), String> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.host_str().is_some_and(host_allowed)
    {
        return Err("host_not_allowed".into());
    }
    Ok(())
}

pub fn request_url(engine: Engine, query: &str, limit: usize) -> Result<Url, String> {
    let base = match engine {
        Engine::WikipediaJa => "https://ja.wikipedia.org/w/api.php",
        Engine::WikipediaEn => "https://en.wikipedia.org/w/api.php",
        Engine::Brave => "https://api.search.brave.com/res/v1/web/search",
    };
    let mut url = Url::parse(base).map_err(|_| "url_invalid".to_owned())?;
    {
        let mut pairs = url.query_pairs_mut();
        match engine {
            Engine::WikipediaJa | Engine::WikipediaEn => {
                pairs
                    .append_pair("action", "query")
                    .append_pair("list", "search")
                    .append_pair("format", "json")
                    .append_pair("srlimit", &limit.to_string())
                    .append_pair("srsearch", query);
            }
            Engine::Brave => {
                pairs.append_pair("q", query).append_pair("count", &limit.to_string());
            }
        }
    }
    ensure_fixed(&url)?;
    Ok(url)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub engine: String,
}

// ------------------------------------------------------------------ text helpers

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let decoded = tail.find(';').filter(|end| *end <= 10).and_then(|end| {
            let name = &tail[1..end];
            let ch = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                    .or_else(|| name.strip_prefix('#').and_then(|dec| dec.parse::<u32>().ok()))
                    .and_then(char::from_u32),
            };
            ch.map(|c| (c, end + 1))
        });
        match decoded {
            Some((ch, used)) => {
                out.push(ch);
                rest = &tail[used..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Drops tags, decodes entities, removes control characters, collapses space.
pub fn plain_text(html: &str, max_chars: usize) -> String {
    let mut stripped = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                stripped.push(' ');
            }
            _ if !in_tag => stripped.push(ch),
            _ => {}
        }
    }
    let decoded = decode_entities(&stripped);
    let cleaned: String = decoded.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max_chars).collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(value) = hex {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn attr(tag: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!(" {name}={quote}");
        if let Some(start) = tag.find(&needle) {
            let rest = &tag[start + needle.len()..];
            if let Some(end) = rest.find(quote) {
                return Some(decode_entities(&rest[..end]));
            }
        }
    }
    None
}

fn has_class(tag: &str, class: &str) -> bool {
    attr(tag, "class").is_some_and(|value| value.split_whitespace().any(|c| c == class))
}

/// Only plain http(s) links without userinfo become results.
fn clean_result_url(raw: &str) -> Option<String> {
    if raw.chars().count() > MAX_URL_CHARS {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.host_str()?;
    Some(url.to_string())
}

// ------------------------------------------------------------------ parsers

/// MediaWiki `action=query&list=search&format=json`.
pub fn parse_wikipedia(json_text: &str, engine: Engine) -> Vec<Hit> {
    let Ok(value) = serde_json::from_str::<Value>(json_text) else { return Vec::new() };
    let Some(rows) = value.pointer("/query/search").and_then(Value::as_array) else { return Vec::new() };
    let host = engine.host();
    rows.iter()
        .filter_map(|row| {
            let title = row.get("title")?.as_str()?;
            let mut url = Url::parse(&format!("https://{host}/wiki/")).ok()?;
            url.path_segments_mut().ok()?.pop_if_empty().push(&title.replace(' ', "_"));
            Some(Hit {
                title: plain_text(title, MAX_TITLE_CHARS),
                url: url.to_string(),
                snippet: plain_text(row.get("snippet").and_then(Value::as_str).unwrap_or(""), MAX_SNIPPET_CHARS),
                engine: engine.id().into(),
            })
        })
        .collect()
}

/// Brave Search API `web.results`.
pub fn parse_brave(json_text: &str) -> Vec<Hit> {
    let Ok(value) = serde_json::from_str::<Value>(json_text) else { return Vec::new() };
    let Some(rows) = value.pointer("/web/results").and_then(Value::as_array) else { return Vec::new() };
    rows.iter()
        .filter_map(|row| {
            let url = clean_result_url(row.get("url")?.as_str()?)?;
            let title = plain_text(row.get("title")?.as_str()?, MAX_TITLE_CHARS);
            (!title.is_empty()).then(|| Hit {
                title,
                url,
                snippet: plain_text(row.get("description").and_then(Value::as_str).unwrap_or(""), MAX_SNIPPET_CHARS),
                engine: Engine::Brave.id().into(),
            })
        })
        .collect()
}

pub fn parse_engine(engine: Engine, body: &str) -> Vec<Hit> {
    match engine {
        Engine::WikipediaJa | Engine::WikipediaEn => parse_wikipedia(body, engine),
        Engine::Brave => parse_brave(body),
    }
}

// ------------------------------------------------------------------ merge

fn dedupe_key(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else { return url.to_owned() };
    let host = parsed.host_str().unwrap_or("").trim_start_matches("www.").to_ascii_lowercase();
    let path = parsed.path().trim_end_matches('/');
    let query = parsed.query().map(|q| format!("?{q}")).unwrap_or_default();
    format!("{host}{path}{query}")
}

/// Interleaves the engines' lists (best of each first), drops duplicate URLs
/// (the same page seen by several engines lists them all in `engine`), and caps
/// the total.
pub fn merge(lists: Vec<Vec<Hit>>, limit: usize) -> Vec<Hit> {
    let limit = limit.clamp(1, MAX_RESULTS);
    let mut merged: Vec<Hit> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    let longest = lists.iter().map(Vec::len).max().unwrap_or(0);
    for rank in 0..longest {
        for list in &lists {
            let Some(hit) = list.get(rank) else { continue };
            let key = dedupe_key(&hit.url);
            if let Some(index) = keys.iter().position(|seen| *seen == key) {
                let known = &mut merged[index];
                if !known.engine.split('+').any(|e| e == hit.engine) {
                    known.engine = format!("{}+{}", known.engine, hit.engine);
                }
                if known.snippet.is_empty() {
                    known.snippet = hit.snippet.clone();
                }
            } else {
                keys.push(key);
                merged.push(hit.clone());
            }
        }
    }
    merged.truncate(limit);
    merged
}

// ------------------------------------------------------------------ request

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchRequest {
    pub query: String,
    pub engines: Vec<Engine>,
    pub limit: usize,
}

impl SearchRequest {
    /// `brave_available`: the user has saved a Brave key. Brave joins the
    /// default engines only then; naming it without a key is refused.
    pub fn parse(args: &Value, brave_available: bool) -> Result<Self, String> {
        let map = args.as_object().ok_or("invalid_search")?;
        let query = map.get("query").and_then(Value::as_str).ok_or("query_invalid")?;
        let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
        if query.is_empty() || query.chars().count() > MAX_QUERY_CHARS || query.chars().any(char::is_control) {
            return Err("query_invalid".into());
        }
        let engines = match map.get("engines") {
            None | Some(Value::Null) => {
                let mut list = vec![Engine::WikipediaJa, Engine::WikipediaEn];
                if brave_available {
                    list.push(Engine::Brave);
                }
                list
            }
            Some(Value::Array(ids)) => {
                let mut list = Vec::new();
                for id in ids {
                    let id = id.as_str().ok_or("engine_unknown")?;
                    // A removed engine id (2026-11-03) migrates to the default
                    // Wikipedia pair instead of failing the call.
                    let named: Vec<Engine> = if id == "duckduckgo" {
                        vec![Engine::WikipediaJa, Engine::WikipediaEn]
                    } else {
                        vec![Engine::from_id(id).ok_or("engine_unknown")?]
                    };
                    for engine in named {
                        if !list.contains(&engine) {
                            list.push(engine);
                        }
                    }
                }
                if list.is_empty() {
                    return Err("engine_unknown".into());
                }
                if list.contains(&Engine::Brave) && !brave_available {
                    return Err("brave_key_missing".into());
                }
                list
            }
            _ => return Err("engine_unknown".into()),
        };
        let limit = match map.get("limit") {
            None | Some(Value::Null) => MAX_RESULTS,
            Some(value) => value.as_u64().filter(|n| (1..=MAX_RESULTS as u64).contains(n)).ok_or("limit_invalid")? as usize,
        };
        Ok(Self { query, engines, limit })
    }

    /// What the approval prompt shows.
    pub fn describe(&self) -> String {
        let engines: Vec<&str> = self.engines.iter().map(|e| e.id()).collect();
        format!("Web検索: 「{}」 / 検索先: {}", self.query, engines.join(", "))
    }

    pub fn detail(&self) -> Value {
        json!({
            "kind": "web_search",
            "query": self.query,
            "engines": self.engines.iter().map(|e| e.id()).collect::<Vec<_>>(),
            "hosts": self.engines.iter().map(|e| e.host()).collect::<Vec<_>>(),
            "limit": self.limit,
        })
    }
}

// ------------------------------------------------------------------ fetching

pub type FetchFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
/// `(engine, fixed url, extra headers)` → body text, capped. Injected so tests
/// never touch the network.
pub type Fetcher = Arc<dyn Fn(Engine, Url, Vec<(&'static str, String)>) -> FetchFuture + Send + Sync>;

/// Appends a chunk unless the body would pass `cap`.
pub fn append_capped(body: &mut Vec<u8>, chunk: &[u8], cap: usize) -> Result<(), String> {
    if body.len() + chunk.len() > cap {
        return Err("response_too_large".into());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(USER_AGENT)
                .build()
                .map_err(|_| "http_client_unavailable".to_owned())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The real network path. Re-checks the host, never follows a redirect, caps
/// the body, and reports only codes (never the URL or query).
pub fn network_fetcher() -> Fetcher {
    Arc::new(|_engine, url, headers| {
        Box::pin(async move {
            ensure_fixed(&url)?;
            let mut request = client()?.get(url).timeout(PER_ENGINE_TIMEOUT).header("Accept", "text/html,application/json");
            for (name, value) in headers {
                request = request.header(name, value);
            }
            let mut response = request.send().await.map_err(|error| {
                if error.is_timeout() { "timeout".to_owned() } else { "unreachable".to_owned() }
            })?;
            let status = response.status();
            if status.is_redirection() {
                return Err("redirect_refused".into());
            }
            if status.as_u16() == 429 {
                return Err("rate_limited".into());
            }
            if !status.is_success() {
                return Err(format!("http_{}", status.as_u16()));
            }
            if response.content_length().is_some_and(|n| n as usize > MAX_RESPONSE_BYTES) {
                return Err("response_too_large".into());
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "connection_lost".to_owned())? {
                append_capped(&mut body, &chunk, MAX_RESPONSE_BYTES)?;
            }
            Ok(String::from_utf8_lossy(&body).into_owned())
        })
    })
}

/// Runs every requested engine concurrently. One engine failing does not fail
/// the search; all failing does.
pub async fn run_search(request: &SearchRequest, brave_key: Option<String>, fetch: Fetcher) -> Result<Value, String> {
    let mut set = tokio::task::JoinSet::new();
    for (index, engine) in request.engines.iter().copied().enumerate() {
        let url = request_url(engine, &request.query, request.limit)?;
        let mut headers: Vec<(&'static str, String)> = Vec::new();
        if engine == Engine::Brave {
            headers.push(("X-Subscription-Token", brave_key.clone().ok_or("brave_key_missing")?));
            headers.push(("Accept-Encoding", "identity".into()));
        }
        let fetch = Arc::clone(&fetch);
        set.spawn(async move {
            let result = fetch(engine, url, headers).await;
            (index, engine, result.map(|body| parse_engine(engine, &body)))
        });
    }
    let mut slots: Vec<Option<Vec<Hit>>> = vec![None; request.engines.len()];
    let mut errors = serde_json::Map::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((index, _, Ok(hits))) => slots[index] = Some(hits),
            Ok((_, engine, Err(code))) => {
                errors.insert(engine.id().to_owned(), Value::String(code));
            }
            Err(_) => {}
        }
    }
    if slots.iter().all(Option::is_none) {
        return Err("search_failed".into());
    }
    let hits = merge(slots.into_iter().flatten().collect(), request.limit);
    Ok(json!({
        "results": hits.iter().map(hit_json).collect::<Vec<_>>(),
        "engineErrors": errors,
    }))
}

/// A Wikipedia result carries its article title and URL (already in `title`
/// and `url`) plus an explicit source and licence line for display.
fn hit_json(hit: &Hit) -> Value {
    let mut row = json!({"title": hit.title, "url": hit.url, "snippet": hit.snippet, "engine": hit.engine});
    if hit.engine.split('+').any(|e| e.starts_with("wikipedia_")) {
        row["attribution"] = Value::String(format!("Wikipedia「{}」 {} (CC BY-SA 4.0)", hit.title, hit.url));
    }
    row
}

/// Approval gate. `approver` receives the summary and detail and answers yes
/// or no. No approver means refusal; the network is touched only after a yes.
pub async fn approved_search<A, AF>(
    request: SearchRequest,
    approver: Option<A>,
    brave_key: Option<String>,
    fetch: Fetcher,
) -> Result<Value, String>
where
    A: FnOnce(String, Value) -> AF,
    AF: Future<Output = bool>,
{
    let Some(approver) = approver else { return Err("approval_required".into()) };
    if !approver(request.describe(), request.detail()).await {
        return Err("approval_denied".into());
    }
    run_search(&request, brave_key, fetch).await
}

// ------------------------------------------------------------------ Brave key (OS credential store)

fn key_entry() -> Result<keyring::Entry, &'static str> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|_| "web_search_store_unavailable")
}

pub fn brave_key() -> Option<String> {
    key_entry().ok()?.get_password().ok().filter(|key| !key.is_empty())
}

pub fn brave_key_hint() -> Option<String> {
    let key = brave_key()?;
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    (key.chars().count() >= 12).then(|| format!("••••{tail}"))
}

pub fn set_brave_key(key: &str) -> Result<(), &'static str> {
    let key = key.trim();
    if key.is_empty() || key.len() > 256 || key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("web_search_key_invalid");
    }
    let entry = key_entry()?;
    entry.set_password(key).map_err(|_| "web_search_store_unavailable")?;
    match entry.get_password() {
        Ok(stored) if stored == key => Ok(()),
        _ => Err("web_search_store_unavailable"),
    }
}

pub fn clear_brave_key() -> Result<(), &'static str> {
    match key_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("web_search_store_unavailable"),
    }
}

// ------------------------------------------------------------------ chat commands

fn main_only(window: &tauri::Webview) -> Result<(), String> {
    if window.label() != "main" {
        return Err("native_window_required".into());
    }
    crate::native_pi(window)
}

#[tauri::command]
pub fn web_search_brave_status(window: tauri::Webview) -> Result<Value, String> {
    main_only(&window)?;
    Ok(json!({"hasKey": brave_key().is_some(), "keyHint": brave_key_hint()}))
}

#[tauri::command]
pub fn web_search_brave_set(window: tauri::Webview, key: String) -> Result<(), String> {
    main_only(&window)?;
    set_brave_key(&key).map_err(str::to_owned)
}

#[tauri::command]
pub fn web_search_brave_clear(window: tauri::Webview) -> Result<(), String> {
    main_only(&window)?;
    clear_brave_key().map_err(str::to_owned)
}

/// Chat 「Web検索」: the same search, the same individual approval (a native
/// dialog showing query and engines). Returns `{results, engineErrors}`.
#[tauri::command]
pub async fn web_search_chat(window: tauri::Webview, app: tauri::AppHandle, query: String) -> Result<Value, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    main_only(&window)?;
    let key = brave_key();
    let request = SearchRequest::parse(&json!({"query": query}), key.is_some())?;
    let approver = move |summary: String, _detail: Value| async move {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(format!("{summary}\n\nこの語句が上の検索先に送られます。"))
            .title("Web検索の確認")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("検索する".into(), "やめる".into()))
            .show(move |confirmed| {
                let _ = sender.send(confirmed);
            });
        receiver.await.unwrap_or(false)
    };
    approved_search(request, Some(approver), key, network_fetcher()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const WIKI_JA: &str = include_str!("../tests/fixtures/web_search/wikipedia_ja.json");
    const WIKI_EN: &str = include_str!("../tests/fixtures/web_search/wikipedia_en.json");
    const BRAVE: &str = include_str!("../tests/fixtures/web_search/brave.json");

    fn hit(engine: &str, url: &str) -> Hit {
        Hit { title: "t".into(), url: url.into(), snippet: String::new(), engine: engine.into() }
    }

    #[test]
    fn wikipedia_parsers_build_article_urls_and_strip_markup() {
        let ja = parse_wikipedia(WIKI_JA, Engine::WikipediaJa);
        assert_eq!(ja.len(), 2);
        assert_eq!(ja[0].title, "東京タワー");
        assert!(ja[0].url.starts_with("https://ja.wikipedia.org/wiki/"));
        assert!(ja[0].url.contains("%E6%9D%B1%E4%BA%AC"));
        assert!(!ja[0].snippet.contains('<'));
        assert!(ja[0].snippet.contains("東京"));
        let en = parse_wikipedia(WIKI_EN, Engine::WikipediaEn);
        assert_eq!(en[0].url, "https://en.wikipedia.org/wiki/Rust_(programming_language)");
        assert_eq!(en[0].engine, "wikipedia_en");
        assert!(parse_wikipedia("not json", Engine::WikipediaEn).is_empty());
        assert!(parse_wikipedia("{\"query\":{}}", Engine::WikipediaEn).is_empty());
    }

    #[test]
    fn brave_parser_keeps_only_http_links() {
        let hits = parse_brave(BRAVE);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!(hits[0].url, "https://www.rust-lang.org/");
        assert_eq!(hits[0].snippet, "A language empowering everyone.");
        assert!(hits.iter().all(|h| h.engine == "brave"));
        assert!(parse_brave("{}").is_empty());
    }

    #[test]
    fn merge_interleaves_dedupes_and_caps() {
        let a = vec![hit("wikipedia_en", "https://www.rust-lang.org/"), hit("wikipedia_en", "https://a.example/1")];
        let b = vec![hit("brave", "https://rust-lang.org"), hit("brave", "https://b.example/1#frag")];
        let merged = merge(vec![a, b], 10);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].engine, "wikipedia_en+brave");
        assert_eq!(merged[1].url, "https://a.example/1");
        assert_eq!(merge(vec![vec![hit("x", "https://a.example/1"), hit("x", "https://a.example/2")]], 1).len(), 1);
        let many: Vec<Hit> = (0..40).map(|i| hit("x", &format!("https://a.example/{i}"))).collect();
        assert_eq!(merge(vec![many], 99).len(), MAX_RESULTS);
    }

    #[test]
    fn only_fixed_https_hosts_are_allowed() {
        for engine in Engine::ALL {
            assert!(ensure_fixed(&request_url(engine, "rust 言語", 5).unwrap()).is_ok());
        }
        for bad in [
            "http://ja.wikipedia.org/w/api.php?q=x",
            "https://www.google.com/search?q=x",
            "https://www.bing.com/search?q=x",
            "https://html.duckduckgo.com/html/?q=x",
            "https://ja.wikipedia.org.evil.example/w/api.php",
            "https://user:pw@ja.wikipedia.org/w/api.php",
            "https://ja.wikipedia.org:8443/w/api.php",
            "https://evil.example/ja.wikipedia.org",
        ] {
            assert_eq!(ensure_fixed(&Url::parse(bad).unwrap()), Err("host_not_allowed".to_owned()), "{bad}");
        }
        assert!(Engine::from_id("duckduckgo").is_none() && Engine::from_id("google").is_none() && Engine::from_id("bing").is_none() && Engine::from_id("yandex").is_none());
        assert_eq!(SearchRequest::parse(&json!({"query": "x", "engines": ["google"]}), true), Err("engine_unknown".to_owned()));
    }

    #[test]
    fn request_parsing_bounds_query_engines_and_brave_key() {
        let ok = SearchRequest::parse(&json!({"query": "  rust   言語 "}), false).unwrap();
        assert_eq!(ok.query, "rust 言語");
        assert_eq!(ok.engines, vec![Engine::WikipediaJa, Engine::WikipediaEn]);
        let legacy = SearchRequest::parse(&json!({"query": "x", "engines": ["duckduckgo", "wikipedia_ja"]}), false).unwrap();
        assert_eq!(legacy.engines, vec![Engine::WikipediaJa, Engine::WikipediaEn]);
        assert!(SearchRequest::parse(&json!({"query": "x"}), true).unwrap().engines.contains(&Engine::Brave));
        assert!(SearchRequest::parse(&json!({"query": ""}), false).is_err());
        assert!(SearchRequest::parse(&json!({"query": "a".repeat(201)}), false).is_err());
        assert!(SearchRequest::parse(&json!({"query": "a\u{0}b"}), false).is_err());
        assert!(SearchRequest::parse(&json!({"query": "x", "limit": 11}), false).is_err());
        assert_eq!(SearchRequest::parse(&json!({"query": "x", "engines": ["brave"]}), false), Err("brave_key_missing".to_owned()));
        let described = ok.describe();
        assert!(described.contains("rust 言語") && !described.contains("duckduckgo") && described.contains("wikipedia_ja"));
    }

    #[test]
    fn body_size_cap_refuses_the_chunk_that_crosses_it() {
        let mut body = Vec::new();
        assert!(append_capped(&mut body, &[0u8; 6], 10).is_ok());
        assert_eq!(append_capped(&mut body, &[0u8; 5], 10), Err("response_too_large".to_owned()));
        assert_eq!(body.len(), 6);
        assert!(append_capped(&mut body, &[0u8; 4], 10).is_ok());
    }

    fn counting_fetcher(calls: Arc<AtomicUsize>) -> Fetcher {
        Arc::new(move |engine, url, _headers| {
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                assert!(ensure_fixed(&url).is_ok());
                match engine {
                    Engine::WikipediaJa => Ok(WIKI_JA.to_owned()),
                    Engine::WikipediaEn => Err("timeout".into()),
                    Engine::Brave => Ok(BRAVE.to_owned()),
                }
            })
        })
    }

    #[tokio::test]
    async fn search_merges_engines_and_reports_a_failed_engine() {
        let calls = Arc::new(AtomicUsize::new(0));
        let request = SearchRequest::parse(&json!({"query": "rust"}), true).unwrap();
        let out = run_search(&request, Some("test-key".into()), counting_fetcher(calls.clone())).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(out["engineErrors"]["wikipedia_en"], "timeout");
        let results = out["results"].as_array().unwrap();
        assert!(!results.is_empty() && results.len() <= MAX_RESULTS);
        let rust_lang: Vec<_> = results.iter().filter(|r| r["url"] == "https://www.rust-lang.org/").collect();
        assert_eq!(rust_lang.len(), 1);
        assert_eq!(rust_lang[0]["engine"], "brave");
        let wiki = results.iter().find(|r| r["engine"] == "wikipedia_ja").unwrap();
        assert!(wiki["attribution"].as_str().unwrap().contains(wiki["url"].as_str().unwrap()));
        assert!(rust_lang[0].get("attribution").is_none());
        for key in ["title", "url", "snippet", "engine"] {
            assert!(results[0].get(key).is_some());
        }
    }

    #[tokio::test]
    async fn all_engines_failing_is_an_error() {
        let fetch: Fetcher = Arc::new(|_, _, _| Box::pin(async { Err("unreachable".to_owned()) }));
        let request = SearchRequest::parse(&json!({"query": "x"}), false).unwrap();
        assert_eq!(run_search(&request, None, fetch).await, Err("search_failed".to_owned()));
    }

    #[tokio::test]
    async fn approval_is_required_and_denial_never_reaches_the_network() {
        let request = SearchRequest::parse(&json!({"query": "rust"}), false).unwrap();

        let calls = Arc::new(AtomicUsize::new(0));
        let none: Option<fn(String, Value) -> std::future::Ready<bool>> = None;
        assert_eq!(
            approved_search(request.clone(), none, None, counting_fetcher(calls.clone())).await,
            Err("approval_required".to_owned())
        );

        let seen = Arc::new(std::sync::Mutex::new(String::new()));
        let seen_in = seen.clone();
        let deny = move |summary: String, detail: Value| {
            *seen_in.lock().unwrap() = format!("{summary}|{}", detail["engines"]);
            std::future::ready(false)
        };
        assert_eq!(
            approved_search(request.clone(), Some(deny), None, counting_fetcher(calls.clone())).await,
            Err("approval_denied".to_owned())
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let shown = seen.lock().unwrap().clone();
        assert!(shown.contains("rust") && shown.contains("wikipedia_ja") && !shown.contains("duckduckgo"), "{shown}");

        let approve = |_: String, _: Value| std::future::ready(true);
        let out = approved_search(request, Some(approve), None, counting_fetcher(calls.clone())).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(out["results"].as_array().is_some_and(|r| !r.is_empty()));
    }

    #[test]
    fn user_agent_names_app_version_and_contact_url() {
        assert!(USER_AGENT.starts_with("JKammaHubDesktop/") && USER_AGENT.contains(env!("CARGO_PKG_VERSION")));
        assert!(USER_AGENT.contains("https://hub.jkamma.com") && !USER_AGENT.contains('@'));
        let url = request_url(Engine::WikipediaJa, "x", 5).unwrap();
        assert!(url.path() == "/w/api.php" && url.query().unwrap().contains("format=json"));
    }

    #[test]
    fn plain_text_strips_markup_and_decodes_entities() {
        assert_eq!(plain_text("a <b>bold</b> &amp; &#x65E5;&#26412; &unknown; x", 100), "a bold & 日本 &unknown; x");
        assert_eq!(plain_text("abcdef", 3), "abc");
    }
}
