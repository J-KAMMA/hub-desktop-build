//! "AIの接続": the owner's own API keys (Anthropic, OpenAI, Google Gemini, any OpenAI-compatible
//! endpoint) and installed AI CLIs, used directly from this app. 2026-10-15, owner-approved.
//!
//! Rules this module keeps:
//! - Keys live only in the OS credential store (one entry per connection id). Settings hold
//!   metadata. No command ever returns a key, and nothing here is logged.
//! - Requests go from Rust straight to the provider. Hub (server) is never involved.
//! - https only (http only for loopback custom endpoints), no redirects, bounded time and size.
//! - Provider error bodies are classified into codes and never echoed.
//! - Only the bundled `main` window may call these commands.
//! - Prompts and replies are not stored or logged.
//! - The owner's phone may use a connection only through `byok_remote_*` (see `remote.rs`):
//!   per-connection "スマホから使える" switch (default off), a live paired session, tighter limits.

mod anthropic;
mod cli;
mod gemini;
mod http;
mod openai;
mod remote;
pub(crate) mod store;
pub mod pi;
mod proxy;

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use store::{CliSetting, Connection, Kind, OsKeys, SaveInput};
use tauri::Emitter;

pub const FAILED_CLI: &str = "byok_cli_failed";
pub const NOT_LOGGED_IN: &str = "byok_cli_not_logged_in";
const EVENT: &str = "byok-chat";
const MAX_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_MESSAGES: usize = 60;
const MAX_MESSAGE_CHARS: usize = 20_000;
const MAX_TOTAL_CHARS: usize = 400_000;
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_INFLIGHT: usize = 4;

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, PartialEq)]
pub enum Event {
    Text(String),
    Done,
    Skip,
    Failed(&'static str),
}

fn valid_messages(messages: &[ChatMessage]) -> bool {
    !messages.is_empty()
        && messages.len() <= MAX_MESSAGES
        && messages.last().is_some_and(|m| m.role == "user")
        && messages.iter().all(|m| {
            matches!(m.role.as_str(), "user" | "assistant")
                && !m.content.trim().is_empty()
                && m.content.chars().count() <= MAX_MESSAGE_CHARS
        })
        && messages.iter().map(|m| m.content.chars().count()).sum::<usize>() <= MAX_TOTAL_CHARS
}

fn main_only(window: &tauri::Webview) -> Result<(), String> {
    if window.label() != "main" {
        return Err("native_window_required".into());
    }
    crate::native_pi(window)
}

fn path() -> Result<std::path::PathBuf, &'static str> {
    store::default_path().ok_or("byok_store_unavailable")
}

// ------------------------------------------------------------------ provider access

struct Plan {
    kind: Kind,
    base: String,
    key: Option<String>,
}

fn plan_for(connection: &Connection) -> Result<Plan, &'static str> {
    let base = http::base_url(connection.kind, connection.base_url.as_deref())?;
    let key = store::KeyStore::get(&OsKeys, &connection.id)?;
    if key.is_none() && store::needs_key(connection.kind, &base) {
        return Err("byok_key_missing");
    }
    Ok(Plan { kind: connection.kind, base, key })
}

fn client(base: &str, total: Option<Duration>) -> Result<reqwest::Client, &'static str> {
    let local = http::is_loopback_base(base);
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .https_only(!local)
        .user_agent("JKammaHubDesktop/1");
    if let Some(total) = total {
        builder = builder.timeout(total);
    }
    if local {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|_| "byok_unreachable")
}

fn authorize(plan: &Plan, request: reqwest::RequestBuilder) -> Result<reqwest::RequestBuilder, &'static str> {
    let Some(key) = plan.key.as_deref() else { return Ok(request) };
    let secret = |text: &str| -> Result<reqwest::header::HeaderValue, &'static str> {
        let mut value = reqwest::header::HeaderValue::from_str(text).map_err(|_| "byok_invalid_request")?;
        value.set_sensitive(true);
        Ok(value)
    };
    Ok(match plan.kind {
        Kind::Anthropic => request.header("x-api-key", secret(key)?).header("anthropic-version", anthropic::VERSION),
        Kind::Google => request.header("x-goog-api-key", secret(key)?),
        Kind::Openai | Kind::OpenaiCompatible => request.header(reqwest::header::AUTHORIZATION, secret(&format!("Bearer {key}"))?),
    })
}

fn send_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() { "byok_timeout" } else { "byok_unreachable" }
}

async fn failure(mut response: reqwest::Response) -> &'static str {
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while body.len() < http::BODY_PEEK_LIMIT {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            _ => break,
        }
    }
    http::classify(status, &String::from_utf8_lossy(&body))
}

fn chat_request(plan: &Plan, model: &str, messages: &[ChatMessage], stream: bool, max_tokens: Option<u32>) -> (String, Value) {
    match plan.kind {
        Kind::Anthropic => (anthropic::chat_url(&plan.base), anthropic::chat_body(model, messages, stream, max_tokens)),
        Kind::Google => (gemini::chat_url(&plan.base, model, stream), gemini::chat_body(messages, max_tokens)),
        Kind::Openai | Kind::OpenaiCompatible => (openai::chat_url(&plan.base), openai::chat_body(model, messages, stream, max_tokens)),
    }
}

fn parse_event(kind: Kind, data: &str) -> Event {
    match kind {
        Kind::Anthropic => anthropic::parse_event(data),
        Kind::Google => gemini::parse_event(data),
        Kind::Openai | Kind::OpenaiCompatible => openai::parse_event(data),
    }
}

async fn list_models(plan: &Plan) -> Result<Vec<String>, &'static str> {
    let url = match plan.kind {
        Kind::Anthropic => anthropic::models_url(&plan.base),
        Kind::Google => gemini::models_url(&plan.base),
        Kind::Openai | Kind::OpenaiCompatible => openai::models_url(&plan.base),
    };
    let request = authorize(plan, client(&plan.base, Some(Duration::from_secs(12)))?.get(url))?;
    let response = request.send().await.map_err(|e| send_error(&e))?;
    if !response.status().is_success() {
        return Err(failure(response).await);
    }
    let body: Value = response.json().await.map_err(|_| "byok_provider_failed")?;
    let mut models = match plan.kind {
        Kind::Anthropic => anthropic::parse_models(&body),
        Kind::Google => gemini::parse_models(&body),
        Kind::Openai => openai::parse_models(&body, true),
        Kind::OpenaiCompatible => openai::parse_models(&body, false),
    };
    models.retain(|m| http::valid_model(plan.kind, m));
    models.sort();
    models.dedup();
    models.truncate(300);
    Ok(models)
}

/// Lists models; an OpenAI-compatible server without `/models` is tried with a one-token request.
async fn probe(connection: &Connection) -> Result<usize, &'static str> {
    let plan = plan_for(connection)?;
    match list_models(&plan).await {
        Ok(models) => Ok(models.len()),
        Err("byok_model_not_found" | "byok_bad_request") if plan.kind == Kind::OpenaiCompatible => {
            let model = connection.default_model.as_deref().ok_or("byok_model_not_found")?;
            let ping = [ChatMessage { role: "user".into(), content: "ping".into() }];
            let (url, body) = chat_request(&plan, model, &ping, false, Some(1));
            let request = authorize(&plan, client(&plan.base, Some(Duration::from_secs(30)))?.post(url).json(&body))?;
            let response = request.send().await.map_err(|e| send_error(&e))?;
            if response.status().is_success() { Ok(0) } else { Err(failure(response).await) }
        }
        Err(code) => Err(code),
    }
}

async fn stream_api(plan: &Plan, model: &str, messages: &[ChatMessage], mut emit: impl FnMut(Value)) -> Result<(), &'static str> {
    let (url, body) = chat_request(plan, model, messages, true, None);
    let request = authorize(plan, client(&plan.base, None)?.post(url).json(&body))?;
    let mut response = request.send().await.map_err(|e| send_error(&e))?;
    if !response.status().is_success() {
        return Err(failure(response).await);
    }
    let (mut sse, mut pending, mut total, mut flushed) = (http::SseBuffer::default(), String::new(), 0usize, Instant::now());
    let mut flush = |pending: &mut String, force: bool, flushed: &mut Instant| {
        if !pending.is_empty() && (force || flushed.elapsed() >= Duration::from_millis(30)) {
            emit(json!({"type": "delta", "text": std::mem::take(pending)}));
            *flushed = Instant::now();
        }
    };
    loop {
        let chunk = match tokio::time::timeout(IDLE_TIMEOUT, response.chunk()).await {
            Err(_) => return Err("byok_timeout"),
            Ok(Err(_)) => return Err("byok_connection_lost"),
            Ok(Ok(chunk)) => chunk,
        };
        let Some(chunk) = chunk else { break };
        for data in sse.push(&chunk)? {
            match parse_event(plan.kind, &data) {
                Event::Text(text) => {
                    total += text.len();
                    if total > MAX_OUTPUT {
                        flush(&mut pending, true, &mut flushed);
                        return Err("byok_response_too_large");
                    }
                    pending.push_str(&text);
                    flush(&mut pending, false, &mut flushed);
                }
                Event::Done => {
                    flush(&mut pending, true, &mut flushed);
                    return Ok(());
                }
                Event::Failed(code) => {
                    flush(&mut pending, true, &mut flushed);
                    return Err(code);
                }
                Event::Skip => {}
            }
        }
    }
    flush(&mut pending, true, &mut flushed);
    Ok(())
}

// ------------------------------------------------------------------ commands

fn text(error: &'static str) -> String {
    error.to_owned()
}

#[tauri::command]
pub async fn byok_list(window: tauri::Webview) -> Result<Value, String> {
    main_only(&window)?;
    let file = store::load(&path().map_err(text)?);
    let detected = cli::detect().await;
    let cli_rows: Vec<Value> = detected
        .iter()
        .map(|info| {
            let setting = file.cli.iter().find(|s| s.id == info.id);
            json!({
                "id": info.id, "label": info.label, "state": info.state, "suggestedModels": info.suggested_models,
                "enabled": setting.is_some_and(|s| s.enabled), "defaultModel": setting.and_then(|s| s.default_model.clone()),
                "remoteAllowed": setting.is_some_and(|s| s.remote_allowed),
            })
        })
        .collect();
    Ok(json!({"connections": file.connections, "cli": cli_rows}))
}

/// API connections a Pi run may name (enabled, usable key state). Names and default models only.
#[tauri::command]
pub fn pi_work_connections(window: tauri::Webview) -> Result<Value, String> {
    main_only(&window)?;
    Ok(Value::Array(pi::run_choices(&path().map_err(text)?)))
}

#[tauri::command]
pub fn byok_save(window: tauri::Webview, input: SaveInput) -> Result<Connection, String> {
    main_only(&window)?;
    store::save(&path().map_err(text)?, &OsKeys, input).map_err(text)
}

#[tauri::command]
pub fn byok_remove(window: tauri::Webview, id: String) -> Result<(), String> {
    main_only(&window)?;
    store::remove(&path().map_err(text)?, &OsKeys, &id).map_err(text)
}

#[tauri::command]
pub fn byok_set_enabled(window: tauri::Webview, id: String, enabled: bool) -> Result<Connection, String> {
    main_only(&window)?;
    store::set_enabled(&path().map_err(text)?, &id, enabled).map_err(text)
}

#[tauri::command]
pub fn byok_cli_set(window: tauri::Webview, id: String, enabled: bool, default_model: Option<String>) -> Result<CliSetting, String> {
    main_only(&window)?;
    let default_model = default_model.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty());
    // `remote_allowed` is ignored here; `set_cli` keeps whatever the owner set with `byok_remote_set`.
    store::set_cli(&path().map_err(text)?, CliSetting { id, enabled, default_model, remote_allowed: false }).map_err(text)
}

/// "接続を試す". Expected failures come back as `{ok:false, code}`, never as a thrown error.
#[tauri::command]
pub async fn byok_test(window: tauri::Webview, id: String) -> Result<Value, String> {
    main_only(&window)?;
    let file = store::load(&path().map_err(text)?);
    let connection = file.connections.into_iter().find(|c| c.id == id).ok_or("byok_connection_not_found")?;
    Ok(match probe(&connection).await {
        Ok(count) => json!({"ok": true, "modelCount": count}),
        Err(code) => json!({"ok": false, "code": code}),
    })
}

/// Models of every enabled source: API connections and CLIs. Local AI is added by the caller.
#[tauri::command]
pub async fn byok_models(window: tauri::Webview) -> Result<Value, String> {
    main_only(&window)?;
    let file = store::load(&path().map_err(text)?);
    let mut set = tokio::task::JoinSet::new();
    for connection in file.connections.iter().filter(|c| c.enabled).cloned() {
        set.spawn(async move {
            let listed = match plan_for(&connection) {
                Ok(plan) => list_models(&plan).await,
                Err(code) => Err(code),
            };
            let (mut models, error) = match listed {
                Ok(models) => (models, None),
                Err(code) => (Vec::new(), Some(code)),
            };
            if let Some(default) = connection.default_model.clone().filter(|m| !models.contains(m)) {
                models.insert(0, default);
            }
            (connection.id.clone(), json!({
                "kind": "api", "id": connection.id, "name": connection.name, "provider": connection.kind,
                "models": models, "defaultModel": connection.default_model, "error": error,
            }))
        });
    }
    let mut api = HashMap::new();
    while let Some(Ok((id, row))) = set.join_next().await {
        api.insert(id, row);
    }
    let mut sources: Vec<Value> = file.connections.iter().filter_map(|c| api.remove(&c.id)).collect();
    for info in cli::detect().await {
        let setting = file.cli.iter().find(|s| s.id == info.id);
        if setting.is_some_and(|s| s.enabled) && info.state != cli::LoginState::NotInstalled {
            sources.push(json!({
                "kind": "cli", "id": info.id, "name": info.label, "state": info.state,
                "models": info.suggested_models, "defaultModel": setting.and_then(|s| s.default_model.clone()),
            }));
        }
    }
    Ok(json!({"sources": sources}))
}

static INFLIGHT: Mutex<Option<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> = Mutex::new(None);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInput {
    /// "api" (a saved connection) or "cli" (an installed CLI).
    pub source: String,
    pub id: String,
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
}

fn announce(app: &tauri::AppHandle, label: &str, request_id: &str, mut payload: Value) {
    payload["requestId"] = json!(request_id);
    let _ = app.emit_to(label, EVENT, payload);
}

enum Target {
    Api(Plan, String),
    Cli(String, Option<String>),
}

async fn drive(target: Target, messages: &[ChatMessage], emit: &impl Fn(Value)) -> Result<(), &'static str> {
    match target {
        Target::Api(plan, model) => stream_api(&plan, &model, messages, |p| emit(p)).await,
        Target::Cli(id, model) => cli::run(&id, model.as_deref(), messages, |t| emit(json!({"type": "delta", "text": t}))).await,
    }
}

#[tauri::command]
pub async fn byok_chat_start(window: tauri::Webview, app: tauri::AppHandle, input: ChatInput) -> Result<String, String> {
    main_only(&window)?;
    if !valid_messages(&input.messages) {
        return Err(text("byok_invalid_request"));
    }
    let file = store::load(&path().map_err(text)?);
    let model = input.model.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(str::to_owned);
    let target = match input.source.as_str() {
        "api" => {
            let connection = file.connections.iter().find(|c| c.id == input.id).ok_or(text("byok_connection_not_found"))?;
            if !connection.enabled {
                return Err(text("byok_disabled"));
            }
            let model = model.or_else(|| connection.default_model.clone()).ok_or(text("byok_invalid_request"))?;
            if !http::valid_model(connection.kind, &model) {
                return Err(text("byok_invalid_request"));
            }
            Target::Api(plan_for(connection).map_err(text)?, model)
        }
        "cli" => {
            let setting = file.cli.iter().find(|s| s.id == input.id);
            if !cli::known(&input.id) || !setting.is_some_and(|s| s.enabled) {
                return Err(text("byok_disabled"));
            }
            let model = model.or_else(|| setting.and_then(|s| s.default_model.clone()));
            if model.as_deref().is_some_and(|m| !cli::model_allowed(&input.id, m)) {
                return Err(text("byok_invalid_request"));
            }
            Target::Cli(input.id.clone(), model)
        }
        _ => return Err(text("byok_invalid_request")),
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let label = window.label().to_owned();
    let messages = input.messages;
    let mut guard = INFLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() >= MAX_INFLIGHT {
        return Err(text("byok_busy"));
    }
    let (task_app, task_label, task_id) = (app, label, request_id.clone());
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |payload: Value| announce(&task_app, &task_label, &task_id, payload);
        let result = drive(target, &messages, &emit).await;
        match result {
            Ok(()) => emit(json!({"type": "done"})),
            Err(code) => emit(json!({"type": "error", "code": code})),
        }
        if let Some(map) = INFLIGHT.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            map.remove(&task_id);
        }
    });
    map.insert(request_id.clone(), handle);
    Ok(request_id)
}

#[tauri::command]
pub fn byok_chat_cancel(window: tauri::Webview, app: tauri::AppHandle, request_id: String) -> Result<(), String> {
    main_only(&window)?;
    let handle = INFLIGHT.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|m| m.remove(&request_id));
    if let Some(handle) = handle {
        handle.abort();
        announce(&app, window.label(), &request_id, json!({"type": "done", "cancelled": true}));
    }
    Ok(())
}

// ------------------------------------------------------------------ phone (paired WebRTC) runs

const REMOTE_EVENT: &str = "byok-remote";

struct RemoteRun {
    handle: tauri::async_runtime::JoinHandle<()>,
    name: String,
    started_at_ms: u64,
}

/// True only while a verified phone session is open in the desktop UI. Runs are refused otherwise.
static REMOTE_SESSION: AtomicBool = AtomicBool::new(false);
static REMOTE_RUNS: Mutex<Option<HashMap<String, RemoteRun>>> = Mutex::new(None);
static REMOTE_LIMITER: Mutex<Option<remote::Limiter>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn remote_on() -> Result<(), String> {
    if REMOTE_SESSION.load(Ordering::SeqCst) { Ok(()) } else { Err(text(remote::OFF)) }
}

fn announce_to(app: &tauri::AppHandle, label: &str, request_id: &str, mut payload: Value) {
    payload["requestId"] = json!(request_id);
    let _ = app.emit_to(label, REMOTE_EVENT, payload);
}

fn stop_remote_runs(app: &tauri::AppHandle, label: &str) {
    let runs: Vec<(String, RemoteRun)> = REMOTE_RUNS.lock().unwrap_or_else(|e| e.into_inner()).as_mut().map(|m| m.drain().collect()).unwrap_or_default();
    for (id, run) in runs {
        run.handle.abort();
        announce_to(app, label, &id, json!({"type": "done", "cancelled": true}));
    }
}

/// The per-connection "スマホから使える" switch. `source` is "api" or "cli".
#[tauri::command]
pub fn byok_remote_set(window: tauri::Webview, app: tauri::AppHandle, source: String, id: String, allowed: bool) -> Result<(), String> {
    main_only(&window)?;
    store::set_remote(&path().map_err(text)?, &source, &id, allowed).map_err(text)?;
    if !allowed {
        // Switching a connection off ends any phone run (the one-run limit means it is that one).
        stop_remote_runs(&app, window.label());
    }
    Ok(())
}

/// The desktop UI calls this when the phone session is verified on both sides (true) and when it
/// ends for any reason (false). Ending it stops every phone run.
#[tauri::command]
pub fn byok_remote_session(window: tauri::Webview, app: tauri::AppHandle, active: bool) -> Result<(), String> {
    main_only(&window)?;
    REMOTE_SESSION.store(active, Ordering::SeqCst);
    if !active {
        stop_remote_runs(&app, window.label());
    }
    Ok(())
}

/// What the phone may see: allowed connections and CLIs by name and model. Nothing else.
#[tauri::command]
pub async fn byok_remote_sources(window: tauri::Webview) -> Result<Value, String> {
    main_only(&window)?;
    remote_on()?;
    let file = store::load(&path().map_err(text)?);
    let rows = remote::allowed_rows(&file);
    let mut set = tokio::task::JoinSet::new();
    for row in rows.iter().filter(|r| r.source == "api") {
        let Some(connection) = file.connections.iter().find(|c| c.id == row.id).cloned() else { continue };
        let id = row.id.clone();
        set.spawn(async move {
            let listed = match plan_for(&connection) {
                Ok(plan) => list_models(&plan).await.unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            (id, listed)
        });
    }
    let mut listed = HashMap::new();
    while let Some(Ok((id, models))) = set.join_next().await {
        listed.insert(id, models);
    }
    let detected = cli::detect().await;
    let mut sources = Vec::new();
    for row in rows {
        if row.source == "api" {
            let models = remote::clean_models(listed.remove(&row.id).unwrap_or_default(), row.default_model.as_deref());
            sources.push(json!({"source": "api", "id": row.id, "name": row.name, "models": models, "defaultModel": row.default_model}));
        } else if let Some(info) = detected.iter().find(|i| i.id == row.id && i.state != cli::LoginState::NotInstalled) {
            let suggested = info.suggested_models.iter().map(|m| m.to_string()).collect();
            let models = remote::clean_models(suggested, row.default_model.as_deref());
            sources.push(json!({"source": "cli", "id": row.id, "name": info.label, "models": models, "defaultModel": row.default_model}));
        }
    }
    Ok(json!({"sources": sources}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRunInput {
    pub source: String,
    pub id: String,
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
}

/// One phone-requested run. Output goes back to the desktop UI as `byok-remote` events, which the
/// UI forwards over the paired channel in small frames.
#[tauri::command]
pub async fn byok_remote_run(window: tauri::Webview, app: tauri::AppHandle, input: RemoteRunInput) -> Result<String, String> {
    main_only(&window)?;
    remote_on()?;
    if !remote::valid_messages(&input.messages) {
        return Err(text(remote::TOO_LARGE));
    }
    let file = store::load(&path().map_err(text)?);
    let (target, name) = match remote::authorize(&file, &input.source, &input.id, input.model.as_deref()).map_err(text)? {
        remote::Pick::Api(connection, model) => (Target::Api(plan_for(connection).map_err(text)?, model), connection.name.clone()),
        remote::Pick::Cli(id, model) => {
            let label = cli::detect().await.into_iter().find(|i| i.id == id).map(|i| i.label.to_owned()).unwrap_or_else(|| id.clone());
            (Target::Cli(id, model), label)
        }
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let label = window.label().to_owned();
    let messages = input.messages;
    let mut guard = REMOTE_RUNS.lock().unwrap_or_else(|e| e.into_inner());
    let runs = guard.get_or_insert_with(HashMap::new);
    REMOTE_LIMITER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(Default::default)
        .admit(Instant::now(), runs.len())
        .map_err(text)?;
    let (task_app, task_label, task_id) = (app, label, request_id.clone());
    let handle = tauri::async_runtime::spawn(async move {
        let sent = Arc::new(AtomicUsize::new(0));
        let over = Arc::new(tokio::sync::Notify::new());
        let emit = {
            let (app, label, id, sent, over) = (task_app.clone(), task_label.clone(), task_id.clone(), sent.clone(), over.clone());
            move |payload: Value| {
                if payload["type"] == "delta" {
                    let n = payload["text"].as_str().map_or(0, |t| t.chars().count());
                    if sent.fetch_add(n, Ordering::SeqCst) + n > remote::MAX_OUTPUT_CHARS {
                        over.notify_one();
                        return;
                    }
                }
                announce_to(&app, &label, &id, payload);
            }
        };
        let result = tokio::select! {
            r = drive(target, &messages, &emit) => r,
            _ = over.notified() => Err("byok_response_too_large"),
            _ = tokio::time::sleep(remote::MAX_RUN) => Err("byok_timeout"),
        };
        let removed = REMOTE_RUNS.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|m| m.remove(&task_id));
        // A cancel removes the entry first and reports "done" itself; do not answer twice.
        if removed.is_some() {
            match result {
                Ok(()) => announce_to(&task_app, &task_label, &task_id, json!({"type": "done"})),
                Err(code) => announce_to(&task_app, &task_label, &task_id, json!({"type": "error", "code": code})),
            }
        }
    });
    runs.insert(request_id.clone(), RemoteRun { handle, name, started_at_ms: now_ms() });
    Ok(request_id)
}

#[tauri::command]
pub fn byok_remote_cancel(window: tauri::Webview, app: tauri::AppHandle, request_id: String) -> Result<(), String> {
    main_only(&window)?;
    let run = REMOTE_RUNS.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|m| m.remove(&request_id));
    if let Some(run) = run {
        run.handle.abort();
        announce_to(&app, window.label(), &request_id, json!({"type": "done", "cancelled": true}));
    }
    Ok(())
}

/// The owner's "停止": ends every phone run at once.
#[tauri::command]
pub fn byok_remote_stop_all(window: tauri::Webview, app: tauri::AppHandle) -> Result<(), String> {
    main_only(&window)?;
    stop_remote_runs(&app, window.label());
    Ok(())
}

/// For the desktop indicator: which phone runs are going, by connection name only.
#[tauri::command]
pub fn byok_remote_active(window: tauri::Webview) -> Result<Value, String> {
    main_only(&window)?;
    let guard = REMOTE_RUNS.lock().unwrap_or_else(|e| e.into_inner());
    let runs: Vec<Value> = guard.iter().flat_map(|m| m.iter()).map(|(id, r)| json!({"requestId": id, "name": r.name, "startedAtMs": r.started_at_ms})).collect();
    Ok(json!({"session": REMOTE_SESSION.load(Ordering::SeqCst), "runs": runs}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage { role: role.into(), content: content.into() }
    }

    #[test]
    fn conversations_must_end_with_a_user_turn_and_stay_bounded() {
        assert!(valid_messages(&[msg("user", "a")]));
        assert!(valid_messages(&[msg("user", "a"), msg("assistant", "b"), msg("user", "c")]));
        assert!(!valid_messages(&[]));
        assert!(!valid_messages(&[msg("user", "a"), msg("assistant", "b")]));
        assert!(!valid_messages(&[msg("system", "a")]));
        assert!(!valid_messages(&[msg("user", "  ")]));
        assert!(!valid_messages(&[msg("user", &"あ".repeat(MAX_MESSAGE_CHARS + 1))]));
        let many: Vec<_> = (0..MAX_MESSAGES + 1).map(|i| msg(if i % 2 == 0 { "user" } else { "assistant" }, "x")).collect();
        assert!(!valid_messages(&many));
    }

    #[test]
    fn each_provider_builds_its_own_request_shape() {
        let messages = [msg("user", "hi")];
        let plan = |kind, base: &str| Plan { kind, base: base.into(), key: None };
        let (url, body) = chat_request(&plan(Kind::Anthropic, anthropic::DEFAULT_BASE), "claude-x", &messages, true, None);
        assert!(url.ends_with("/v1/messages") && body["max_tokens"].is_number());
        let (url, body) = chat_request(&plan(Kind::Google, gemini::DEFAULT_BASE), "gemini-x", &messages, true, None);
        assert!(url.ends_with(":streamGenerateContent?alt=sse") && body.get("contents").is_some() && body.get("model").is_none());
        let (url, body) = chat_request(&plan(Kind::OpenaiCompatible, "https://openrouter.ai/api/v1"), "a/b", &messages, true, None);
        assert!(url.ends_with("/chat/completions") && body["model"] == "a/b");
    }

    #[test]
    fn the_key_goes_only_into_a_sensitive_header_never_the_url_or_body() {
        let messages = [msg("user", "hi")];
        for (kind, base) in [(Kind::Anthropic, anthropic::DEFAULT_BASE), (Kind::Google, gemini::DEFAULT_BASE), (Kind::Openai, openai::DEFAULT_BASE)] {
            let plan = Plan { kind, base: base.into(), key: Some("SECRET-KEY-VALUE".into()) };
            let (url, body) = chat_request(&plan, "m", &messages, true, None);
            assert!(!url.contains("SECRET") && !body.to_string().contains("SECRET"));
            let built = authorize(&plan, reqwest::Client::new().post(&url)).unwrap().build().unwrap();
            let sensitive = built.headers().values().filter(|v| v.is_sensitive()).count();
            assert_eq!(sensitive, 1, "{kind:?}");
            assert!(built.url().query().map_or(true, |q| !q.contains("SECRET")));
        }
    }

    #[test]
    fn loopback_servers_send_no_authorization_without_a_key() {
        let plan = Plan { kind: Kind::OpenaiCompatible, base: "http://localhost:1234/v1".into(), key: None };
        let built = authorize(&plan, reqwest::Client::new().get("http://localhost:1234/v1/models")).unwrap().build().unwrap();
        assert!(built.headers().get(reqwest::header::AUTHORIZATION).is_none());
        assert!(client("http://localhost:1234/v1", None).is_ok());
    }

}
