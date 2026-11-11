use crate::node_identity::{NodeKey, PublicKeyJwk};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.jkamma.hub.desktop-account";
const ACCOUNT: &str = "device-key-v1";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingEnrollment {
    request_id: String,
    poll_secret: String,
    user_code: String,
    expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDevice {
    private_key_pkcs8: String,
    device_id: Option<String>,
    pending: Option<PendingEnrollment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAccountStatus {
    pub state: &'static str,
    pub device_id: Option<String>,
    pub key_thumbprint: Option<String>,
    pub user_code: Option<String>,
    pub approval_url: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest {
    public_key: PublicKeyJwk,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentResponse {
    request_id: String,
    poll_secret: String,
    user_code: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PollResponse {
    status: String,
    device_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeResponse {
    challenge_id: String,
    challenge: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssertionResponse {
    assertion: String,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| "credential_store_unavailable".into())
}

fn load() -> Result<Option<StoredDevice>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "desktop_account_state_invalid".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("credential_store_unavailable".into()),
    }
}

fn save(value: &StoredDevice) -> Result<(), String> {
    let encoded = serde_json::to_string(value).map_err(|_| "desktop_account_state_invalid")?;
    entry()?
        .set_password(&encoded)
        .map_err(|_| "credential_store_unavailable".into())
}

fn account_api(hub_origin: &str) -> String {
    format!("{}/account/api/v1", hub_origin.trim_end_matches('/'))
}

fn approval_url(hub_origin: &str, request_id: &str) -> String {
    let base = format!(
        "{}/account/desktop?request={request_id}",
        hub_origin.trim_end_matches('/')
    );
    match APPROVAL_PORT.load(std::sync::atomic::Ordering::SeqCst) {
        0 => base,
        port => format!("{base}#port={port}"),
    }
}

// ── 承認ページへ確認コードを手渡す受け口 ──────────────────────────────
// 利用者が4桁を手で写さなくて済むように、承認ページ（Hub の Web）がこのPCの中の
// Hub Desktop へ直接コードを取りに来る。守ること：
//   ・127.0.0.1 にだけ開く（外のPCからは届かない）。
//   ・Origin が、この Desktop がつないでいる Hub と完全に一致する要求にだけ答える
//     （ほかのサイトのページからは読めない）。
//   ・Host がこの受け口そのものであること（名前を付け替えて届く要求を断る）。
//   ・要求の番号が、いま承認待ちのものと一致し、期限内であること。
// 送りつけられた承認リンクは、開いた人のPCに承認待ちが無いのでコードを取れず、承認に進めない。
static APPROVAL_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
const APPROVAL_REQUEST_BYTES: usize = 4096;

fn web_origin(hub_origin: &str) -> Option<String> {
    let url = reqwest::Url::parse(hub_origin).ok()?;
    match url.scheme() {
        "https" | "http" => Some(url.origin().ascii_serialization()),
        _ => None,
    }
}

fn approval_http(status: &str, cors_origin: Option<&str>, body: &str) -> String {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(origin) = cors_origin {
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 60\r\n"
        ));
    }
    format!("{head}\r\n{body}")
}

/// 受け口の応答を決める。通信も保管庫も触らない（テストできる形）。
/// `pending` は、いま承認待ちで期限内の（要求の番号, 確認コード）。
fn approval_response(
    request: &str,
    allowed_origin: &str,
    port: u16,
    pending: Option<(&str, &str)>,
) -> String {
    use subtle::ConstantTimeEq;
    let mut lines = request.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let header = |name: &str| {
        request.split("\r\n").skip(1).take_while(|line| !line.is_empty()).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
        })
    };
    if header("host") != Some(format!("127.0.0.1:{port}").as_str()) {
        return approval_http("403 Forbidden", None, "{}");
    }
    if header("origin") != Some(allowed_origin) {
        return approval_http("403 Forbidden", None, "{}");
    }
    let Some(query) = target.strip_prefix("/desktop-approval?request=") else {
        return approval_http("404 Not Found", Some(allowed_origin), "{}");
    };
    if method == "OPTIONS" {
        return approval_http("204 No Content", Some(allowed_origin), "");
    }
    if method != "GET" {
        return approval_http("405 Method Not Allowed", Some(allowed_origin), "{}");
    }
    match pending {
        Some((request_id, user_code))
            if bool::from(query.as_bytes().ct_eq(request_id.as_bytes()))
                && user_code.len() == 4
                && user_code.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            approval_http(
                "200 OK",
                Some(allowed_origin),
                &format!("{{\"userCode\":\"{user_code}\"}}"),
            )
        }
        _ => approval_http("404 Not Found", Some(allowed_origin), "{}"),
    }
}

fn active_pending() -> Option<PendingEnrollment> {
    let stored = load().ok()??;
    if stored.device_id.is_some() {
        return None;
    }
    stored.pending.filter(pending_is_active)
}

/// 承認待ちの間だけ受け口を開く。すでに開いていれば何もしない。開けなくても接続は続けられる
/// （承認ページが手入力に切り替わる）ので、失敗は返さない。
pub async fn ensure_approval_responder(hub_origin: &str) {
    use std::sync::atomic::Ordering;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    if APPROVAL_PORT.load(Ordering::SeqCst) != 0 || active_pending().is_none() {
        return;
    }
    let Some(allowed_origin) = web_origin(hub_origin) else {
        return;
    };
    let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await else {
        return;
    };
    let Ok(port) = listener.local_addr().map(|address| address.port()) else {
        return;
    };
    if APPROVAL_PORT.compare_exchange(0, port, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }
    tokio::spawn(async move {
        loop {
            let accepted = tokio::time::timeout(std::time::Duration::from_secs(20), listener.accept()).await;
            let Some(pending) = active_pending() else {
                break;
            };
            let Ok(Ok((mut stream, _))) = accepted else {
                continue;
            };
            let mut buffer = vec![0u8; APPROVAL_REQUEST_BYTES];
            let mut filled = 0;
            let complete = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while filled < buffer.len() {
                    match stream.read(&mut buffer[filled..]).await {
                        Ok(0) | Err(_) => return false,
                        Ok(read) => filled += read,
                    }
                    if buffer[..filled].windows(4).any(|window| window == b"\r\n\r\n") {
                        return true;
                    }
                }
                false
            })
            .await
            .unwrap_or(false);
            if !complete {
                continue;
            }
            let request = String::from_utf8_lossy(&buffer[..filled]);
            let response = approval_response(
                &request,
                &allowed_origin,
                port,
                Some((&pending.request_id, &pending.user_code)),
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
        APPROVAL_PORT.store(0, Ordering::SeqCst);
    });
}

fn pending_is_active(pending: &PendingEnrollment) -> bool {
    chrono::DateTime::parse_from_rfc3339(&pending.expires_at)
        .map(|expires| expires > chrono::Utc::now())
        .unwrap_or(false)
}

fn is_unavailable_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 502..=504)
}

/// Account が落ちている間の連打を止める遮断器。assertion は jti を持ち再利用できない
/// ので、キャッシュはせず「落ちている間は challenge を撃たない」だけを行う。
/// 失敗のたびに待ちを 2s → 4s → … → 60s と倍にし（±20% の揺らぎ）、成功で戻す。
const BREAKER_BASE_MS: u64 = 2_000;
const BREAKER_MAX_MS: u64 = 60_000;
const UNAVAILABLE: &str = "desktop_account_unavailable";

#[derive(Debug, Default)]
struct Breaker {
    failures: u32,
    open_until_ms: u64,
}

impl Breaker {
    /// 開いている間は残り待ち(ms)を返す。
    fn remaining(&self, now_ms: u64) -> Option<u64> {
        (self.failures > 0 && now_ms < self.open_until_ms).then(|| self.open_until_ms - now_ms)
    }

    /// `jitter` は 0.0..=1.0。待ち = 基準 × (0.8 + 0.4 × jitter)、上限 60s。
    fn record_failure(&mut self, now_ms: u64, jitter: f64) {
        self.failures = self.failures.saturating_add(1);
        let exp = (self.failures - 1).min(16);
        let base = BREAKER_BASE_MS.saturating_mul(1u64 << exp).min(BREAKER_MAX_MS);
        let factor = 0.8 + 0.4 * jitter.clamp(0.0, 1.0);
        let wait = ((base as f64 * factor) as u64).min(BREAKER_MAX_MS);
        self.open_until_ms = now_ms.saturating_add(wait);
    }

    fn record_success(&mut self) {
        *self = Self::default();
    }
}

static BREAKER: std::sync::Mutex<Breaker> = std::sync::Mutex::new(Breaker {
    failures: 0,
    open_until_ms: 0,
});

fn monotonic_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "desktop_account_network_unavailable".into())
}

async fn bounded_json<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(match response.status() {
            StatusCode::UNAUTHORIZED => "desktop_account_unauthorized",
            StatusCode::GONE => "desktop_account_request_expired",
            s if is_unavailable_status(s) => "desktop_account_unavailable",
            _ => "desktop_account_request_failed",
        }
        .into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "desktop_account_response_invalid")?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("desktop_account_response_too_large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "desktop_account_response_invalid".into())
}

/// assertion 発行専用の受け取り口。サービス別の失敗語（mail_link_required
/// など）を {error:"code"} から拾って窓へ透過する——そうでないと窓は
/// 「メールの有効化が要る」のと「通信が切れた」のを区別できない。
/// 拾えるのは snake_case の短いコードだけ——文や記号は通さない。
async fn bounded_json_detailed<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "desktop_account_response_invalid")?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("desktop_account_response_too_large".into());
    }
    if !status.is_success() {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(code) = value.get("error").and_then(|e| e.as_str()) {
                if !code.is_empty()
                    && code.len() <= 64
                    && code
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                {
                    return Err(code.to_owned());
                }
            }
        }
        return Err(match status {
            StatusCode::UNAUTHORIZED => "desktop_account_unauthorized",
            StatusCode::GONE => "desktop_account_request_expired",
            s if is_unavailable_status(s) => "desktop_account_unavailable",
            _ => "desktop_account_request_failed",
        }
        .into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "desktop_account_response_invalid".into())
}

pub fn status(hub_origin: &str) -> Result<DesktopAccountStatus, String> {
    let Some(stored) = load()? else {
        return Ok(DesktopAccountStatus {
            state: "signed_out",
            device_id: None,
            key_thumbprint: None,
            user_code: None,
            approval_url: None,
            expires_at: None,
        });
    };
    let key = NodeKey::from_pkcs8_pem(&stored.private_key_pkcs8)
        .map_err(|_| "desktop_account_key_invalid")?;
    if let Some(device_id) = stored.device_id {
        return Ok(DesktopAccountStatus {
            state: "registered",
            device_id: Some(device_id),
            key_thumbprint: Some(key.thumbprint()),
            user_code: None,
            approval_url: None,
            expires_at: None,
        });
    }
    let pending = stored.pending.ok_or("desktop_account_state_invalid")?;
    if !pending_is_active(&pending) {
        return Ok(DesktopAccountStatus {
            state: "expired",
            device_id: None,
            key_thumbprint: Some(key.thumbprint()),
            user_code: None,
            approval_url: None,
            expires_at: Some(pending.expires_at),
        });
    }
    Ok(DesktopAccountStatus {
        state: "pending",
        device_id: None,
        key_thumbprint: Some(key.thumbprint()),
        user_code: Some(pending.user_code),
        approval_url: Some(approval_url(hub_origin, &pending.request_id)),
        expires_at: Some(pending.expires_at),
    })
}

pub async fn begin(hub_origin: &str, label: &str) -> Result<DesktopAccountStatus, String> {
    if let Some(existing) = load()? {
        if existing.device_id.is_some() || existing.pending.as_ref().is_some_and(pending_is_active)
        {
            return status(hub_origin);
        }
    }
    let key = NodeKey::create();
    let label = label.trim().chars().take(48).collect::<String>();
    let response = client()?
        .post(format!(
            "{}/desktop/device-requests",
            account_api(hub_origin)
        ))
        .json(&EnrollmentRequest {
            public_key: key.public_jwk(),
            label: if label.is_empty() {
                "Hub Desktop".into()
            } else {
                label
            },
        })
        .send()
        .await
        .map_err(|_| "desktop_account_network_unavailable")?;
    let created: EnrollmentResponse = bounded_json(response).await?;
    save(&StoredDevice {
        private_key_pkcs8: key
            .to_pkcs8_pem()
            .map_err(|_| "desktop_account_key_invalid")?,
        device_id: None,
        pending: Some(PendingEnrollment {
            request_id: created.request_id,
            poll_secret: created.poll_secret,
            user_code: created.user_code,
            expires_at: created.expires_at,
        }),
    })?;
    status(hub_origin)
}

pub async fn poll(hub_origin: &str) -> Result<DesktopAccountStatus, String> {
    let Some(mut stored) = load()? else {
        return status(hub_origin);
    };
    if stored.device_id.is_some() {
        return status(hub_origin);
    }
    let pending = stored
        .pending
        .clone()
        .ok_or("desktop_account_state_invalid")?;
    let response = client()?
        .get(format!(
            "{}/desktop/device-requests/{}",
            account_api(hub_origin),
            pending.request_id
        ))
        .header(
            "authorization",
            format!("Desktop-Poll {}", pending.poll_secret),
        )
        .send()
        .await
        .map_err(|_| "desktop_account_network_unavailable")?;
    let polled: PollResponse = bounded_json(response).await?;
    if polled.status == "approved" {
        stored.device_id = polled.device_id;
        stored.pending = None;
        if stored.device_id.is_none() {
            return Err("desktop_account_response_invalid".into());
        }
        save(&stored)?;
    }
    status(hub_origin)
}

pub async fn assertion(hub_origin: &str) -> Result<String, String> {
    assertion_with(hub_origin, serde_json::json!({})).await
}

/// 追加フィールド付きの assertion 発行。service を変えると別audienceの
/// assertion が発行される（compute 等）。窓からの任意フィールドは
/// 呼び出し側が組み立てた固定形だけが来る。
pub async fn assertion_with(
    hub_origin: &str,
    extra: serde_json::Value,
) -> Result<String, String> {
    if BREAKER
        .lock()
        .map(|b| b.remaining(monotonic_ms()).is_some())
        .unwrap_or(false)
    {
        return Err(UNAVAILABLE.into());
    }
    let result = issue_assertion(hub_origin, extra).await;
    if let Ok(mut breaker) = BREAKER.lock() {
        match &result {
            Ok(_) => breaker.record_success(),
            Err(code) if code == UNAVAILABLE || code == "desktop_account_network_unavailable" => {
                breaker.record_failure(monotonic_ms(), rand::random::<f64>())
            }
            Err(_) => {}
        }
    }
    result.map_err(|code| {
        if code == "desktop_account_network_unavailable" {
            UNAVAILABLE.into()
        } else {
            code
        }
    })
}

async fn issue_assertion(
    hub_origin: &str,
    extra: serde_json::Value,
) -> Result<String, String> {
    let stored = load()?.ok_or("desktop_account_signed_out")?;
    let device_id = stored.device_id.ok_or("desktop_account_not_registered")?;
    let key = NodeKey::from_pkcs8_pem(&stored.private_key_pkcs8)
        .map_err(|_| "desktop_account_key_invalid")?;
    let challenge: ChallengeResponse = bounded_json(
        client()?
            .post(format!(
                "{}/desktop/devices/{device_id}/challenges",
                account_api(hub_origin),
            ))
            .send()
            .await
            .map_err(|_| "desktop_account_network_unavailable")?,
    )
    .await?;
    let message = proof_message(&device_id, &challenge.challenge_id, &challenge.challenge);
    let mut body = serde_json::json!({ "deviceId": device_id, "challengeId": challenge.challenge_id,
        "signature": key.sign(&message) });
    if let (Some(object), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            object.insert(key.clone(), value.clone());
        }
    }
    let response = client()?
        .post(format!("{}/desktop/assertions", account_api(hub_origin)))
        .json(&body)
        .send()
        .await
        .map_err(|_| "desktop_account_network_unavailable")?;
    let issued: AssertionResponse = bounded_json_detailed(response).await?;
    if issued.assertion.len() > 4096 || issued.assertion.split('.').count() != 3 {
        return Err("desktop_account_response_invalid".into());
    }
    Ok(issued.assertion)
}

/// Collapse an assertion failure for a scoped client. Only "this device is not
/// enrolled / not authorised" means the user must connect; an unreachable or
/// failing Account service must not be reported as "not connected".
pub fn scoped_auth_error(code: &str) -> String {
    match code {
        "desktop_account_signed_out"
        | "desktop_account_not_registered"
        | "desktop_account_unauthorized"
        | "desktop_account_key_invalid"
        | "desktop_account_state_invalid"
        | "desktop_account_request_expired" => "desktop_not_connected".into(),
        _ => UNAVAILABLE.into(),
    }
}

pub async fn assertion_if_registered(hub_origin: &str) -> Result<Option<String>, String> {
    match load()? {
        Some(stored) if stored.device_id.is_some() => assertion(hub_origin).await.map(Some),
        _ => Ok(None),
    }
}

pub fn logout() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("credential_store_unavailable".into()),
    }
}

pub fn proof_message(device_id: &str, challenge_id: &str, challenge: &str) -> String {
    format!("jkamma-desktop-proof-v1\n{device_id}\n{challenge_id}\n{challenge}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_auth_error_separates_unenrolled_from_unavailable() {
        assert_eq!(scoped_auth_error("desktop_account_not_registered"), "desktop_not_connected");
        assert_eq!(scoped_auth_error("desktop_account_unauthorized"), "desktop_not_connected");
        assert_eq!(scoped_auth_error("desktop_account_unavailable"), "desktop_account_unavailable");
        assert_eq!(scoped_auth_error("desktop_account_network_unavailable"), "desktop_account_unavailable");
        assert_eq!(scoped_auth_error("desktop_account_request_failed"), "desktop_account_unavailable");
    }

    const HUB: &str = "https://hub.example";
    fn ask(method: &str, target: &str, host: &str, origin: Option<&str>) -> String {
        let origin = origin.map(|value| format!("Origin: {value}\r\n")).unwrap_or_default();
        format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\n{origin}\r\n")
    }
    const PENDING: Option<(&str, &str)> = Some(("request-1", "4821"));

    #[test]
    fn the_approval_page_of_this_hub_gets_the_code_for_the_pending_request() {
        let reply = approval_response(
            &ask("GET", "/desktop-approval?request=request-1", "127.0.0.1:5000", Some(HUB)),
            HUB, 5000, PENDING,
        );
        assert!(reply.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(reply.ends_with("\r\n\r\n{\"userCode\":\"4821\"}"));
        assert!(reply.contains("Access-Control-Allow-Origin: https://hub.example\r\n"));
        assert!(reply.contains("Cache-Control: no-store\r\n"));
    }

    #[test]
    fn another_site_or_no_origin_never_gets_the_code() {
        for origin in [Some("https://evil.example"), Some("https://hub.example.evil.test"), Some("null"), None] {
            let reply = approval_response(
                &ask("GET", "/desktop-approval?request=request-1", "127.0.0.1:5000", origin),
                HUB, 5000, PENDING,
            );
            assert!(reply.starts_with("HTTP/1.1 403 "), "{origin:?}");
            assert!(!reply.contains("4821"), "{origin:?}");
            assert!(!reply.contains("Access-Control-Allow-Origin"), "{origin:?}");
        }
    }

    #[test]
    fn a_request_that_reached_the_port_under_another_name_is_refused() {
        for host in ["rebind.evil.test:5000", "localhost:5000", "127.0.0.1:5001", "127.0.0.1"] {
            let reply = approval_response(
                &ask("GET", "/desktop-approval?request=request-1", host, Some(HUB)),
                HUB, 5000, PENDING,
            );
            assert!(reply.starts_with("HTTP/1.1 403 "), "{host}");
            assert!(!reply.contains("4821"), "{host}");
        }
    }

    #[test]
    fn a_link_for_someone_elses_request_gets_no_code() {
        for (target, pending) in [
            ("/desktop-approval?request=request-2", PENDING),
            ("/desktop-approval?request=request-1x", PENDING),
            ("/desktop-approval?request=", PENDING),
            ("/desktop-approval?request=request-1", None),
            ("/other?request=request-1", PENDING),
            ("/", PENDING),
        ] {
            let reply = approval_response(&ask("GET", target, "127.0.0.1:5000", Some(HUB)), HUB, 5000, pending);
            assert!(reply.starts_with("HTTP/1.1 404 "), "{target}");
            assert!(!reply.contains("4821"), "{target}");
        }
    }

    #[test]
    fn the_browser_preflight_is_answered_and_other_methods_are_not() {
        let preflight = approval_response(
            &ask("OPTIONS", "/desktop-approval?request=request-1", "127.0.0.1:5000", Some(HUB)),
            HUB, 5000, PENDING,
        );
        assert!(preflight.starts_with("HTTP/1.1 204 "));
        assert!(preflight.contains("Access-Control-Allow-Private-Network: true\r\n"));
        assert!(!preflight.contains("4821"));
        let post = approval_response(
            &ask("POST", "/desktop-approval?request=request-1", "127.0.0.1:5000", Some(HUB)),
            HUB, 5000, PENDING,
        );
        assert!(post.starts_with("HTTP/1.1 405 "));
        assert!(!post.contains("4821"));
    }

    #[test]
    fn a_stored_code_that_is_not_four_digits_is_never_written_into_the_reply() {
        let reply = approval_response(
            &ask("GET", "/desktop-approval?request=request-1", "127.0.0.1:5000", Some(HUB)),
            HUB, 5000, Some(("request-1", "12\"}")),
        );
        assert!(reply.starts_with("HTTP/1.1 404 "));
    }

    #[test]
    fn the_allowed_origin_is_the_hub_origin_without_its_path() {
        assert_eq!(web_origin("https://hub.example/v2/").as_deref(), Some("https://hub.example"));
        assert_eq!(web_origin("http://localhost:3020").as_deref(), Some("http://localhost:3020"));
        assert_eq!(web_origin("file:///c:/x"), None);
    }

    #[test]
    fn account_paths_cannot_be_supplied_by_the_window() {
        assert_eq!(
            account_api("https://hub.example/"),
            "https://hub.example/account/api/v1"
        );
        assert_eq!(
            approval_url("https://hub.example", "request-id"),
            "https://hub.example/account/desktop?request=request-id"
        );
    }

    #[test]
    fn proof_context_binds_every_server_nonce_and_the_device() {
        assert_eq!(
            proof_message("device", "challenge-id", "nonce"),
            "jkamma-desktop-proof-v1\ndevice\nchallenge-id\nnonce"
        );
        assert_ne!(
            proof_message("other", "challenge-id", "nonce"),
            proof_message("device", "challenge-id", "nonce")
        );
    }

    #[test]
    fn breaker_opens_after_a_failure_and_backs_off_to_the_cap() {
        let mut b = Breaker::default();
        assert_eq!(b.remaining(0), None);
        b.record_failure(1_000, 0.5); // 2s, jitter 1.0x
        assert_eq!(b.remaining(1_000), Some(2_000));
        assert_eq!(b.remaining(2_999), Some(1));
        assert_eq!(b.remaining(3_000), None);
        b.record_failure(3_000, 0.5); // 4s
        assert_eq!(b.remaining(3_000), Some(4_000));
        for _ in 0..10 {
            b.record_failure(0, 1.0);
        }
        assert!(b.remaining(0).unwrap() <= BREAKER_MAX_MS);
        assert_eq!(b.remaining(BREAKER_MAX_MS), None);
    }

    #[test]
    fn breaker_jitter_stays_within_twenty_percent() {
        let mut low = Breaker::default();
        low.record_failure(0, 0.0);
        assert_eq!(low.remaining(0), Some(1_600));
        let mut high = Breaker::default();
        high.record_failure(0, 1.0);
        assert_eq!(high.remaining(0), Some(2_400));
    }

    #[test]
    fn breaker_resets_on_success() {
        let mut b = Breaker::default();
        b.record_failure(0, 0.5);
        b.record_failure(0, 0.5);
        b.record_success();
        assert_eq!(b.remaining(0), None);
        b.record_failure(0, 0.5);
        assert_eq!(b.remaining(0), Some(2_000));
    }

    #[test]
    fn gateway_statuses_count_as_unavailable() {
        assert!(is_unavailable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(is_unavailable_status(StatusCode::BAD_GATEWAY));
        assert!(!is_unavailable_status(StatusCode::UNAUTHORIZED));
        assert!(!is_unavailable_status(StatusCode::INTERNAL_SERVER_ERROR));
    }

    #[test]
    fn expired_enrollment_cannot_trap_the_desktop_in_an_old_code() {
        assert!(!pending_is_active(&PendingEnrollment {
            request_id: "request".into(),
            poll_secret: "secret".into(),
            user_code: "1234".into(),
            expires_at: "2020-01-01T00:00:00.000Z".into(),
        }));
    }
}
