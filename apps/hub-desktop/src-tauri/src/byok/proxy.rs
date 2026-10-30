//! Per-run model proxy for "AIの接続" (docs/hub-harness-swap/PLAN.md, decision 3, 2026-10-18).
//!
//! The engine never holds the API key. Each Pi run that names a connection gets its own proxy on
//! `127.0.0.1` and a random one-time token. The engine sends the token where a provider expects
//! its key; the proxy checks it in constant time, replaces it with the key read from the OS
//! credential store, and forwards the request to that connection's upstream only:
//! - one upstream origin, fixed per run (the connection's base URL), no redirects followed;
//! - only the request paths the run's API needs (`POST` to the messages / responses /
//!   chat-completions / generateContent endpoint), only allowlisted request headers;
//! - bounded request size, response size and idle time;
//! - alive only while the run is: dropping the [`ProxyHandle`] (run end or cancel) stops the
//!   listener and every in-flight connection, and the token dies with it.
//! Nothing here logs requests, responses, tokens or keys.

use super::store::Kind;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::task::{AbortHandle, JoinSet};

const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;
const MAX_RESPONSE: usize = 64 * 1024 * 1024;
const IDLE: Duration = Duration::from_secs(120);
const MAX_CONNECTIONS: usize = 8;
const FORWARDED_HEADERS: [&str; 4] = ["content-type", "accept", "anthropic-version", "anthropic-beta"];

/// What the proxy forwards to. No `Debug`: it carries the key.
pub(super) struct Upstream {
    pub kind: Kind,
    /// Base URL without a trailing slash, already validated by `http::base_url` (or, in tests,
    /// a loopback fixture).
    pub base: String,
    pub model: String,
    /// Empty for a keyless loopback endpoint.
    pub key: String,
}

/// Owning this keeps the run's proxy alive; dropping it stops the proxy.
pub struct ProxyHandle {
    addr: SocketAddr,
    token: String,
    accept: AbortHandle,
}

impl ProxyHandle {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
    /// The one-time token the engine presents. Not the API key.
    pub fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for ProxyHandle {
    fn drop(&mut self) {
        // Aborting the accept task drops its JoinSet, which aborts every in-flight connection.
        self.accept.abort();
    }
}

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Starts the proxy for one run. Must be called inside a Tokio runtime.
pub(super) fn start(upstream: Upstream) -> Result<ProxyHandle, &'static str> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "byok_proxy_unavailable")?;
    listener.set_nonblocking(true).map_err(|_| "byok_proxy_unavailable")?;
    let addr = listener.local_addr().map_err(|_| "byok_proxy_unavailable")?;
    let listener = TcpListener::from_std(listener).map_err(|_| "byok_proxy_unavailable")?;
    let token = random_token();
    let local = super::http::is_loopback_base(&upstream.base);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .https_only(!local)
        .user_agent("JKammaHubDesktop/1")
        .build()
        .map_err(|_| "byok_proxy_unavailable")?;
    let shared = Arc::new((upstream, token.clone(), client));
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let accept = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            let Ok((stream, peer)) = listener.accept().await else { continue };
            while connections.try_join_next().is_some() {}
            if !peer.ip().is_loopback() {
                continue;
            }
            let Ok(permit) = Arc::clone(&slots).try_acquire_owned() else {
                let _ = respond_status(stream, 503).await;
                continue;
            };
            let shared = Arc::clone(&shared);
            connections.spawn(async move {
                let _permit = permit;
                let (upstream, token, client) = &*shared;
                let _ = tokio::time::timeout(IDLE * 4, serve(stream, upstream, token, client)).await;
            });
        }
    })
    .abort_handle();
    Ok(ProxyHandle { addr, token, accept })
}

struct Request {
    method: String,
    path: String,
    query: Option<String>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

async fn read_request(stream: &mut TcpStream) -> Result<Request, u16> {
    let mut buffer = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let count = tokio::time::timeout(IDLE, stream.read(&mut chunk)).await.map_err(|_| 408u16)?.map_err(|_| 400u16)?;
        if count == 0 {
            return Err(400);
        }
        buffer.extend_from_slice(&chunk[..count]);
        if let Some(end) = buffer.windows(4).position(|part| part == b"\r\n\r\n") {
            break end;
        }
        if buffer.len() > MAX_HEAD {
            return Err(431);
        }
    };
    let head = std::str::from_utf8(&buffer[..head_end]).map_err(|_| 400u16)?;
    let mut lines = head.split("\r\n");
    let mut start = lines.next().ok_or(400u16)?.split(' ');
    let method = start.next().ok_or(400u16)?.to_owned();
    let target = start.next().ok_or(400u16)?;
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_owned(), Some(query.to_owned())),
        None => (target.to_owned(), None),
    };
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
    }
    if headers.iter().any(|(name, _)| name == "transfer-encoding") {
        return Err(411);
    }
    let length = match headers.iter().find(|(name, _)| name == "content-length") {
        Some((_, value)) => value.parse::<usize>().map_err(|_| 400u16)?,
        None => 0,
    };
    if length > MAX_BODY {
        return Err(413);
    }
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let count = tokio::time::timeout(IDLE, stream.read(&mut chunk)).await.map_err(|_| 408u16)?.map_err(|_| 400u16)?;
        if count == 0 {
            return Err(400);
        }
        body.extend_from_slice(&chunk[..count]);
    }
    body.truncate(length);
    Ok(Request { method, path, query, headers, body })
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
}

/// The token wherever the run's SDK puts a key: `x-api-key`, `Authorization: Bearer`,
/// `x-goog-api-key`, or Gemini's `key=` query parameter.
fn presented_token(request: &Request) -> Option<String> {
    header(request, "x-api-key")
        .or_else(|| header(request, "authorization").and_then(|value| value.strip_prefix("Bearer ")))
        .or_else(|| header(request, "x-goog-api-key"))
        .map(str::to_owned)
        .or_else(|| {
            request.query.as_deref().and_then(|query| {
                query.split('&').find_map(|pair| pair.strip_prefix("key=").map(str::to_owned))
            })
        })
}

fn base_path(base: &str) -> String {
    reqwest::Url::parse(base).map(|url| url.path().trim_end_matches('/').to_owned()).unwrap_or_default()
}

/// Upstream URL for an allowed request, or `None`.
fn allowed_target(upstream: &Upstream, request: &Request) -> Option<String> {
    if request.method != "POST" {
        return None;
    }
    let prefix = base_path(&upstream.base);
    let origin = upstream.base.strip_suffix(prefix.as_str()).unwrap_or(&upstream.base);
    let path = request.path.as_str();
    let query_ok = |allowed: &[&str]| {
        request.query.as_deref().map_or(true, |query| {
            query.split('&').all(|pair| pair.starts_with("key=") || allowed.contains(&pair))
        })
    };
    let (ok, query) = match upstream.kind {
        // The Anthropic SDK posts beta-capable messages as `/v1/messages?beta=true`.
        Kind::Anthropic => {
            let beta = request.query.as_deref() == Some("beta=true");
            (path == format!("{prefix}/v1/messages") && (request.query.is_none() || beta), beta.then_some("beta=true"))
        }
        Kind::Openai => (path == format!("{prefix}/responses") && request.query.is_none(), None),
        Kind::OpenaiCompatible => (path == format!("{prefix}/chat/completions") && request.query.is_none(), None),
        Kind::Google => {
            let model = format!("{prefix}/v1beta/models/{}", upstream.model);
            let stream = path == format!("{model}:streamGenerateContent");
            let once = path == format!("{model}:generateContent");
            let sse = request.query.as_deref().is_some_and(|query| query.split('&').any(|pair| pair == "alt=sse"));
            ((stream || once) && query_ok(&["alt=sse"]), sse.then_some("alt=sse"))
        }
    };
    ok.then(|| match query {
        Some(query) => format!("{origin}{path}?{query}"),
        None => format!("{origin}{path}"),
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        408 => "Request Timeout",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

async fn respond_status(mut stream: TcpStream, status: u16) -> std::io::Result<()> {
    let head = format!("HTTP/1.1 {status} {}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", reason(status));
    stream.write_all(head.as_bytes()).await?;
    stream.shutdown().await
}

async fn serve(mut stream: TcpStream, upstream: &Upstream, token: &str, client: &reqwest::Client) -> std::io::Result<()> {
    let request = match read_request(&mut stream).await {
        Ok(request) => request,
        Err(status) => return respond_status(stream, status).await,
    };
    let presented = presented_token(&request).unwrap_or_default();
    if presented.len() != token.len() || !bool::from(presented.as_bytes().ct_eq(token.as_bytes())) {
        return respond_status(stream, 401).await;
    }
    let Some(target) = allowed_target(upstream, &request) else {
        return respond_status(stream, 403).await;
    };
    let mut outgoing = client.post(target).body(request.body.clone());
    for name in FORWARDED_HEADERS {
        if let Some(value) = header(&request, name) {
            outgoing = outgoing.header(name, value);
        }
    }
    if !upstream.key.is_empty() {
        outgoing = match upstream.kind {
            Kind::Anthropic => outgoing.header("x-api-key", &upstream.key),
            Kind::Google => outgoing.header("x-goog-api-key", &upstream.key),
            Kind::Openai | Kind::OpenaiCompatible => outgoing.bearer_auth(&upstream.key),
        };
    }
    let mut response = match outgoing.send().await {
        Ok(response) => response,
        Err(_) => return respond_status(stream, 502).await,
    };
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.contains(['\r', '\n']))
        .unwrap_or("application/octet-stream")
        .to_owned();
    let head = format!("HTTP/1.1 {status} {}\r\ncontent-type: {content_type}\r\nconnection: close\r\n\r\n", reason(status));
    stream.write_all(head.as_bytes()).await?;
    let mut sent = 0usize;
    loop {
        let chunk = match tokio::time::timeout(IDLE, response.chunk()).await {
            Ok(Ok(Some(chunk))) => chunk,
            _ => break,
        };
        sent += chunk.len();
        if sent > MAX_RESPONSE {
            break;
        }
        stream.write_all(&chunk).await?;
    }
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const KEY: &str = "sk-ant-fixture-PROXY-KEY-0123456789";

    /// A loopback "provider" that records each request head and answers with a small SSE body.
    async fn fake_upstream() -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { break };
                let record = Arc::clone(&record);
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 65536];
                    let mut total = 0;
                    loop {
                        let count = stream.read(&mut buffer[total..]).await.unwrap_or(0);
                        if count == 0 { break; }
                        total += count;
                        let text = String::from_utf8_lossy(&buffer[..total]).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end].lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                            if total >= end + 4 + length { record.lock().unwrap().push(text); break; }
                        }
                    }
                    let body = "data: {\"ok\":true}\n\n";
                    let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(reply.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    async fn post(addr: SocketAddr, path: &str, auth: Option<(&str, &str)>, body: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let auth = auth.map(|(name, value)| format!("{name}: {value}\r\n")).unwrap_or_default();
        let request = format!("POST {path} HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\n{auth}content-length: {}\r\n\r\n{body}", body.len());
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await.unwrap();
        let status = reply.split(' ').nth(1).unwrap().parse().unwrap();
        (status, reply)
    }

    fn upstream(kind: Kind, base: &str) -> Upstream {
        Upstream { kind, base: base.into(), model: "fixture-model".into(), key: KEY.into() }
    }

    #[tokio::test]
    async fn swaps_the_run_token_for_the_key_and_forwards_only_to_the_connection() {
        let (base, seen) = fake_upstream().await;
        let proxy = start(upstream(Kind::Anthropic, &base)).unwrap();
        assert_eq!(proxy.token().len(), 64);
        assert!(!proxy.token().contains(KEY));
        let (status, reply) = post(proxy.addr(), "/v1/messages", Some(("x-api-key", proxy.token())), "{\"model\":\"m\"}").await;
        assert_eq!(status, 200, "{reply}");
        assert!(reply.contains("data: {\"ok\":true}"));
        let request = seen.lock().unwrap()[0].clone();
        assert!(request.contains(&format!("x-api-key: {KEY}")), "upstream gets the real key");
        assert!(!request.contains(proxy.token()), "the token never leaves the proxy");
        assert!(request.starts_with("POST /v1/messages "));
        assert_eq!(post(proxy.addr(), "/v1/messages?beta=true", Some(("x-api-key", proxy.token())), "{}").await.0, 200);
        assert!(seen.lock().unwrap()[1].starts_with("POST /v1/messages?beta=true "));
        for path in ["/v1/messages?beta=true&x=1", "/v1/messages/count_tokens?beta=true", "/v1/complete"] {
            assert_eq!(post(proxy.addr(), path, Some(("x-api-key", proxy.token())), "{}").await.0, 403, "{path}");
        }
    }

    #[tokio::test]
    async fn wrong_missing_or_other_run_tokens_get_401_and_nothing_is_forwarded() {
        let (base, seen) = fake_upstream().await;
        let first = start(upstream(Kind::Openai, &format!("{base}/v1"))).unwrap();
        let second = start(upstream(Kind::Openai, &format!("{base}/v1"))).unwrap();
        assert_ne!(first.token(), second.token(), "each run gets its own token");
        for auth in [None, Some(("authorization", "Bearer nope")), Some(("authorization", &format!("Bearer {}", second.token())[..])),
            Some(("authorization", &format!("Bearer {KEY}")[..]))] {
            assert_eq!(post(first.addr(), "/v1/responses", auth, "{}").await.0, 401);
        }
        assert_eq!(post(first.addr(), "/v1/responses", Some(("authorization", &format!("Bearer {}", first.token()))), "{}").await.0, 200);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn only_the_run_api_endpoint_is_reachable() {
        let (base, seen) = fake_upstream().await;
        let proxy = start(upstream(Kind::OpenaiCompatible, &format!("{base}/api/v1"))).unwrap();
        let auth = format!("Bearer {}", proxy.token());
        for path in ["/api/v1/models", "/api/v1/chat/completions?x=1", "/v1/chat/completions", "/api/v1/files", "/api/v1/../v1/chat/completions"] {
            assert_eq!(post(proxy.addr(), path, Some(("authorization", &auth)), "{}").await.0, 403, "{path}");
        }
        assert_eq!(post(proxy.addr(), "/api/v1/chat/completions", Some(("authorization", &auth)), "{}").await.0, 200);
        assert_eq!(seen.lock().unwrap().len(), 1);
        let google = start(upstream(Kind::Google, &base)).unwrap();
        let good = format!("/v1beta/models/fixture-model:streamGenerateContent?alt=sse&key={}", google.token());
        assert_eq!(post(google.addr(), &good, None, "{}").await.0, 200);
        let other = format!("/v1beta/models/other-model:streamGenerateContent?alt=sse&key={}", google.token());
        assert_eq!(post(google.addr(), &other, None, "{}").await.0, 403, "another model is not this run's");
        let forwarded = seen.lock().unwrap()[1].clone();
        assert!(forwarded.contains(&format!("x-goog-api-key: {KEY}")) && !forwarded.contains(google.token()));
    }

    #[tokio::test]
    async fn the_proxy_dies_with_its_handle() {
        let (base, _) = fake_upstream().await;
        let proxy = start(upstream(Kind::Anthropic, &base)).unwrap();
        let addr = proxy.addr();
        assert_eq!(post(addr, "/v1/messages", Some(("x-api-key", proxy.token())), "{}").await.0, 200);
        drop(proxy);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(TcpStream::connect(addr).await.is_err(), "no listener after the run ends");
    }
}
