//! "AIの接続" for Hub AI work (Pi harness), 2026-10-18 owner-approved.
//!
//! A run may name an API connection as `byok:<connection id>/<model>` (an empty model means the
//! connection's default model). Rust resolves it here: the connection must exist and be enabled,
//! the endpoint passes the same rules as BYOK chat (fixed hosts, https, http only on loopback for
//! OpenAI-compatible endpoints), and the key is read from the OS credential store at start.
//!
//! The key never reaches the engine (docs/hub-harness-swap/PLAN.md, decision 3): [`start`] opens
//! a per-run proxy on 127.0.0.1 (`proxy.rs`) and the sidecar gets only that proxy's URL and a
//! one-time token. The key is never written to the settings file, run state, history,
//! checkpoints, logs or the sidecar's environment, and never reaches Hub. A missing or invalid
//! key, a disabled or unknown connection, or an unreadable store fails closed.

use super::http;
pub use super::proxy::ProxyHandle;
use super::proxy::{self, Upstream};
use super::store::{self, KeyStore, Kind};
use serde_json::json;
use std::path::Path;

pub const PREFIX: &str = "byok:";
/// The sidecar registers the connection under this provider name for the run only.
pub const PROVIDER: &str = "hub-byok";
pub const ENV_CONNECTION: &str = "PI_SIDECAR_BYOK";
/// The per-run proxy token. It is not the API key and is useless once the run ends.
pub const ENV_TOKEN: &str = "PI_SIDECAR_BYOK_TOKEN";

/// A resolved connection. No `Debug`: it carries the key until [`start`] moves it into the proxy.
pub struct PiConnection {
    /// Display and record value, `byok:<id>/<model>`; holds no key.
    pub reference: String,
    /// The sidecar's model argument, `hub-byok/<model>`.
    pub sidecar_model: String,
    kind: Kind,
    base: String,
    model: String,
    key: String,
}

/// What a run holds: the sidecar environment (proxy URL and token only) and the proxy itself,
/// which stops when this is dropped.

pub struct PiRunConnection {
    pub reference: String,
    pub sidecar_model: String,
    pub env: Vec<(String, String)>,
    pub proxy: ProxyHandle,
}

pub fn is_reference(value: &str) -> bool {
    value.trim().starts_with(PREFIX)
}

fn api(kind: Kind) -> &'static str {
    match kind {
        Kind::Anthropic => "anthropic-messages",
        Kind::Openai => "openai-responses",
        Kind::Google => "google-generative-ai",
        Kind::OpenaiCompatible => "openai-completions",
    }
}

/// The path part of the base URL Pi's adapter expects (Gemini takes the versioned root).
fn pi_base_path(kind: Kind, base: &str) -> String {
    let path = reqwest::Url::parse(base).map(|url| url.path().trim_end_matches('/').to_owned()).unwrap_or_default();
    match kind {
        Kind::Google => format!("{path}/v1beta"),
        _ => path,
    }
}

pub fn resolve(reference: &str, settings: &Path, keys: &dyn KeyStore) -> Result<PiConnection, &'static str> {
    let rest = reference.trim().strip_prefix(PREFIX).ok_or("byok_invalid_request")?;
    let (id, model) = rest.split_once('/').unwrap_or((rest, ""));
    if !store::valid_id(id) {
        return Err("byok_invalid_request");
    }
    let file = store::load_existing(settings)?;
    let connection = file.connections.iter().find(|c| c.id == id).ok_or("byok_connection_not_found")?;
    if !connection.enabled {
        return Err("byok_disabled");
    }
    let model = match model.trim() {
        "" => connection.default_model.clone().ok_or("byok_model_missing")?,
        chosen => chosen.to_owned(),
    };
    if !http::valid_model(connection.kind, &model) {
        return Err("byok_invalid_request");
    }
    let base = http::base_url(connection.kind, connection.base_url.as_deref())?;
    let key = match keys.get(id)? {
        Some(key) if store::valid_key(&key) => key,
        Some(_) => return Err("byok_key_invalid"),
        None if store::needs_key(connection.kind, &base) => return Err("byok_key_missing"),
        None => String::new(),
    };
    Ok(PiConnection {
        reference: format!("{PREFIX}{id}/{model}"),
        sidecar_model: format!("{PROVIDER}/{model}"),
        kind: connection.kind,
        base,
        model,
        key,
    })
}

/// Starts the run's proxy and builds the sidecar environment. Call inside the Tokio runtime.
pub fn start(connection: PiConnection) -> Result<PiRunConnection, &'static str> {
    let PiConnection { reference, sidecar_model, kind, base, model, key } = connection;
    let path = pi_base_path(kind, &base);
    let proxy = proxy::start(Upstream { kind, base, model: model.clone(), key })?;
    let descriptor = json!({
        "kind": kind,
        "api": api(kind),
        "baseUrl": format!("http://{}{path}", proxy.addr()),
        "model": model,
        "proxy": true,
    });
    let env = vec![(ENV_CONNECTION.into(), descriptor.to_string()), (ENV_TOKEN.into(), proxy.token().to_owned())];
    Ok(PiRunConnection { reference, sidecar_model, env, proxy })
}

/// Resolves against the app's own settings file and the OS credential store.
pub fn resolve_installed(reference: &str) -> Result<PiConnection, &'static str> {
    let settings = store::default_path().ok_or("byok_store_unavailable")?;
    resolve(reference, &settings, &store::OsKeys)
}

/// Connections a Pi run may name: enabled, and either holding a key or not needing one.
/// Names and default models only.
pub fn run_choices(settings: &Path) -> Vec<serde_json::Value> {
    store::load(settings)
        .connections
        .iter()
        .filter(|c| c.enabled)
        .filter(|c| {
            c.has_key
                || http::base_url(c.kind, c.base_url.as_deref()).is_ok_and(|base| !store::needs_key(c.kind, &base))
        })
        .map(|c| json!({"id": c.id, "name": c.name, "kind": c.kind, "defaultModel": c.default_model}))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::byok::store::{save, MemKeys, SaveInput};

    const SECRET: &str = "sk-ant-fixture-SECRET-0123456789";

    fn connection(dir: &Path, keys: &MemKeys, kind: Kind, base: Option<&str>, key: Option<&str>, model: Option<&str>) -> String {
        save(&dir.join("ai-connections.json"), keys, SaveInput {
            id: None, kind, name: "hub-bench".into(), base_url: base.map(str::to_owned),
            default_model: model.map(str::to_owned), enabled: Some(true), api_key: key.map(str::to_owned),
        }).unwrap().id
    }

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hub-byok-pi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn the_sidecar_gets_only_the_proxy_url_and_a_run_token_never_the_key() {
        let dir = temp();
        let keys = MemKeys::new();
        let id = connection(&dir, &keys, Kind::Anthropic, None, Some(SECRET), Some("claude-haiku-5-5"));
        let settings = dir.join("ai-connections.json");
        let run = start(resolve(&format!("byok:{id}/"), &settings, &keys).unwrap()).unwrap();
        assert_eq!(run.reference, format!("byok:{id}/claude-haiku-5-5"));
        assert_eq!(run.sidecar_model, "hub-byok/claude-haiku-5-5");
        let descriptor: serde_json::Value = serde_json::from_str(&run.env[0].1).unwrap();
        assert_eq!(descriptor["api"], "anthropic-messages");
        assert_eq!(descriptor["proxy"], true);
        assert_eq!(descriptor["baseUrl"], format!("http://{}", run.proxy.addr()));
        assert!(run.proxy.addr().ip().is_loopback());
        assert_eq!(run.env[1], (ENV_TOKEN.to_owned(), run.proxy.token().to_owned()));
        assert_eq!(run.env.len(), 2);
        for public in [&run.reference, &run.sidecar_model, &run.env[0].1, &run.env[1].1, &std::fs::read_to_string(&settings).unwrap()] {
            assert!(!public.contains(SECRET), "the key is in nothing the sidecar or disk receives");
        }
        let chosen = resolve(&format!("byok:{id}/claude-sonnet-5"), &settings, &keys).unwrap();
        assert_eq!(chosen.sidecar_model, "hub-byok/claude-sonnet-5");
        let openai = connection(&dir, &keys, Kind::Openai, None, Some(SECRET), Some("gpt-6"));
        let run = start(resolve(&format!("byok:{openai}/"), &settings, &keys).unwrap()).unwrap();
        let descriptor: serde_json::Value = serde_json::from_str(&run.env[0].1).unwrap();
        assert_eq!(descriptor["baseUrl"], format!("http://{}/v1", run.proxy.addr()));
        let google = connection(&dir, &keys, Kind::Google, None, Some(SECRET), Some("gemini-3-pro"));
        let run = start(resolve(&format!("byok:{google}/"), &settings, &keys).unwrap()).unwrap();
        let descriptor: serde_json::Value = serde_json::from_str(&run.env[0].1).unwrap();
        assert_eq!(descriptor["baseUrl"], format!("http://{}/v1beta", run.proxy.addr()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_invalid_or_unusable_connections_fail_closed() {
        let dir = temp();
        let keys = MemKeys::new();
        let settings = dir.join("ai-connections.json");
        let id = connection(&dir, &keys, Kind::Anthropic, None, Some(SECRET), None);
        assert_eq!(resolve(&format!("byok:{id}/"), &settings, &keys).err(), Some("byok_model_missing"));
        keys.0.lock().unwrap().remove(&id);
        assert_eq!(resolve(&format!("byok:{id}/m"), &settings, &keys).err(), Some("byok_key_missing"));
        keys.0.lock().unwrap().insert(id.clone(), "bad key\n".into());
        assert_eq!(resolve(&format!("byok:{id}/m"), &settings, &keys).err(), Some("byok_key_invalid"));
        let unknown = uuid::Uuid::new_v4();
        assert_eq!(resolve(&format!("byok:{unknown}/m"), &settings, &keys).err(), Some("byok_connection_not_found"));
        for bad in ["byok:", "byok:not-an-id/m", "openai/gpt"] {
            assert_eq!(resolve(bad, &settings, &keys).err(), Some("byok_invalid_request"), "{bad}");
        }
        keys.0.lock().unwrap().insert(id.clone(), SECRET.into());
        assert_eq!(resolve(&format!("byok:{id}/a..b"), &settings, &keys).err(), Some("byok_invalid_request"));
        crate::byok::store::set_enabled(&settings, &id, false).unwrap();
        assert_eq!(resolve(&format!("byok:{id}/m"), &settings, &keys).err(), Some("byok_disabled"));
        std::fs::write(&settings, "{not json").unwrap();
        assert_eq!(resolve(&format!("byok:{id}/m"), &settings, &keys).err(), Some("byok_store_unreadable"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn loopback_compatible_endpoints_need_no_key_and_remote_http_is_refused() {
        let dir = temp();
        let keys = MemKeys::new();
        let settings = dir.join("ai-connections.json");
        let local = connection(&dir, &keys, Kind::OpenaiCompatible, Some("http://127.0.0.1:8080/v1"), None, Some("qwen3"));
        let run = start(resolve(&format!("byok:{local}/"), &settings, &keys).unwrap()).unwrap();
        assert_eq!(run.env[1].1.len(), 64, "even a keyless endpoint is reached only through the run token");
        let descriptor: serde_json::Value = serde_json::from_str(&run.env[0].1).unwrap();
        assert_eq!(descriptor["baseUrl"], format!("http://{}/v1", run.proxy.addr()));
        // A stored base edited to remote http must not pass at run time either.
        let mut file = crate::byok::store::load(&settings);
        file.connections[0].base_url = Some("http://example.com/v1".into());
        std::fs::write(&settings, serde_json::to_string(&file).unwrap()).unwrap();
        assert_eq!(resolve(&format!("byok:{local}/"), &settings, &keys).err(), Some("byok_endpoint_not_allowed"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// End to end through the vendored sidecar: the engine talks only to the run's proxy with the
    /// run token, the provider receives the real key, and nothing the engine prints holds the key.
    #[tokio::test]
    async fn the_real_sidecar_reaches_the_provider_only_through_the_proxy() {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let record = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = upstream.accept().await else { break };
                let record = record.clone();
                tokio::spawn(async move {
                    let mut buffer = Vec::new();
                    let mut chunk = [0u8; 16384];
                    loop {
                        let count = stream.read(&mut chunk).await.unwrap_or(0);
                        if count == 0 { break; }
                        buffer.extend_from_slice(&chunk[..count]);
                        let text = String::from_utf8_lossy(&buffer).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end].lines().find_map(|line| line.to_ascii_lowercase()
                                .strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                            if buffer.len() >= end + 4 + length { record.lock().unwrap().push(text[..end].to_owned()); break; }
                        }
                    }
                    let chunk = |delta: &str, finish: &str| format!("data: {{\"id\":\"f\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture-model\",\"choices\":[{{\"index\":0,\"delta\":{delta},\"finish_reason\":{finish}}}]}}\n\n");
                    let body = format!("{}{}data: [DONE]\n\n", chunk("{\"role\":\"assistant\",\"content\":\"OK\"}", "null"), chunk("{}", "\"stop\""));
                    let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(reply.as_bytes()).await;
                });
            }
        });
        let dir = temp();
        let keys = MemKeys::new();
        let id = connection(&dir, &keys, Kind::OpenaiCompatible, Some(&format!("http://{upstream_addr}/v1")), Some(SECRET), Some("fixture-model"));
        let run = start(resolve(&format!("byok:{id}/"), &dir.join("ai-connections.json"), &keys).unwrap()).unwrap();
        let bundle = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/pi-sidecar/pi-sidecar.mjs");
        let agent_dir = dir.join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let mut command = tokio::process::Command::new("node");
        command.arg(&bundle).arg(&run.sidecar_model).arg("Say OK.")
            .current_dir(&dir)
            .env("PI_CODING_AGENT_DIR", &agent_dir).env("PI_SIDECAR_SESSION", "1").env("PI_SIDECAR_CAPS", "").env("PI_WORK_ENGINE", "thin")
            .envs(run.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        assert!(!format!("{:?}", command).contains(SECRET), "argv and environment of the engine hold no key");
        let mut child = command.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"{\"type\":\"session\",\"entries\":[]}\n").await.unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut stdout = String::new();
        let mut ok = None;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Ok(Some(line)) = lines.next_line().await {
                stdout.push_str(&line);
                if line.contains("\"type\":\"agent_done\"") { ok = Some(line.contains("\"ok\":true")); drop(stdin); break; }
            }
        }).await;
        let mut stderr = String::new();
        let _ = child.stderr.take().unwrap().read_to_string(&mut stderr).await;
        assert_eq!(ok, Some(true), "{stderr}");
        let requests = seen.lock().unwrap().clone();
        assert!(!requests.is_empty() && requests.iter().all(|head| head.contains(&format!("authorization: Bearer {SECRET}"))),
            "the provider got the real key: {requests:?}");
        assert!(requests.iter().all(|head| !head.contains(run.proxy.token())), "the run token stays between engine and proxy");
        assert!(!stdout.contains(SECRET) && !stderr.contains(SECRET));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Benchmark harness only (`runner/run_pi_hub.py`, `PI_BENCH_BYOK_FILE`): starts the real
    /// proxy for the named installed connection, writes the sidecar environment (proxy URL and
    /// run token, never the key) to `BYOK_BENCH_OUT`, and keeps the proxy alive until
    /// `BYOK_BENCH_OUT.stop` appears. Run with
    /// `cargo test --lib byok_bench_proxy -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "benchmark helper; reads the owner's installed connection"]
    async fn byok_bench_proxy() {
        let name = std::env::var("BYOK_BENCH_CONNECTION").expect("BYOK_BENCH_CONNECTION");
        let out = std::path::PathBuf::from(std::env::var("BYOK_BENCH_OUT").expect("BYOK_BENCH_OUT"));
        let settings = store::default_path().unwrap();
        let file = store::load(&settings);
        let matches: Vec<_> = file.connections.iter().filter(|c| c.name == name).collect();
        assert_eq!(matches.len(), 1, "exactly one connection named {name}");
        let model = std::env::var("BYOK_BENCH_MODEL").unwrap_or_default();
        let run = start(resolve_installed(&format!("{PREFIX}{}/{model}", matches[0].id)).unwrap()).unwrap();
        let env: serde_json::Map<String, serde_json::Value> =
            run.env.iter().map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone()))).collect();
        std::fs::write(&out, json!({"sidecarModel": run.sidecar_model, "env": env}).to_string()).unwrap();
        let stop = out.with_extension("stop");
        while !stop.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        drop(run);
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&stop);
    }

    #[test]
    fn run_choices_list_only_configured_usable_connections_without_keys() {
        let dir = temp();
        let keys = MemKeys::new();
        let settings = dir.join("ai-connections.json");
        assert!(run_choices(&settings).is_empty(), "no settings file, no choices");
        let ready = connection(&dir, &keys, Kind::Anthropic, None, Some(SECRET), Some("claude-haiku-5-5"));
        let off = connection(&dir, &keys, Kind::Openai, None, Some(SECRET), None);
        crate::byok::store::set_enabled(&settings, &off, false).unwrap();
        let local = connection(&dir, &keys, Kind::OpenaiCompatible, Some("http://localhost:11434/v1"), None, None);
        let choices = run_choices(&settings);
        let ids: Vec<_> = choices.iter().map(|c| c["id"].as_str().unwrap().to_owned()).collect();
        assert_eq!(ids, vec![ready.clone(), local]);
        assert_eq!(choices[0]["defaultModel"], "claude-haiku-5-5");
        assert!(!serde_json::to_string(&choices).unwrap().contains(SECRET));
        let _ = std::fs::remove_dir_all(dir);
    }
}
