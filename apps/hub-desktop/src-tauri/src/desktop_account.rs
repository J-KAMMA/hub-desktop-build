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
    format!(
        "{}/account/desktop?request={request_id}",
        hub_origin.trim_end_matches('/')
    )
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
