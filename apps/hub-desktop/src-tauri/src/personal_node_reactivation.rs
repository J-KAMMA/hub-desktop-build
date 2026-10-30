//! One-use approval to reactivate the same revoked node/key. No key creation or rotation.
use crate::node_identity::{NodeKey, PublicKeyJwk};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;
const MAX_RESPONSE: usize = 8192;
const MAX_METADATA: usize = 256 * 1024;
const ENDPOINT: &str = "/api/client/personal-node/reactivation";
fn error(code: &str) -> String {
    format!("personal_node_reactivation_{code}")
}
fn now() -> i64 {
    Utc::now().timestamp_millis()
}
#[derive(Default)]
pub struct ReactivationState {
    pending: Mutex<PreviewSlot>,
}
#[derive(Default)]
struct PreviewSlot {
    generation: u64,
    pending: Option<Pending>,
}
impl PreviewSlot {
    fn replace(&mut self) -> Result<u64, String> {
        self.pending = None;
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| error("invalid_preview"))?;
        Ok(self.generation)
    }
    fn store(&mut self, generation: u64, pending: Pending) -> Result<(), String> {
        if self.generation != generation {
            return Err(error("invalid_preview"));
        }
        self.pending = Some(pending);
        Ok(())
    }
    fn take(&mut self, id: &str, confirmed: bool) -> Result<Option<Pending>, String> {
        if self
            .pending
            .as_ref()
            .is_none_or(|pending| pending.preview_id != id)
        {
            return Err(error("invalid_preview"));
        }
        let pending = self
            .pending
            .take()
            .ok_or_else(|| error("invalid_preview"))?;
        Ok(confirmed.then_some(pending))
    }
}
#[derive(Clone, PartialEq, Eq)]
struct AccountBinding {
    device_id: String,
    key_thumbprint: String,
}
#[derive(Clone, PartialEq, Eq)]
struct Revoked {
    viewer: String,
    node: String,
    thumbprint: String,
    revoked_at: String,
}
struct Pending {
    preview_id: String,
    base: String,
    account: AccountBinding,
    public_key: PublicKeyJwk,
    local_thumbprint: String,
    revoked: Revoked,
    challenge_id: String,
    challenge: String,
    expires_at: String,
    expires_ms: i64,
}
fn opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn canonical32(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}
fn thumb(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.hyphenated().to_string() == value
            && id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
    })
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|value| {
        value.len() == keys.len() && keys.iter().all(|key| value.contains_key(*key))
    })
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| error("invalid_challenge"))
}
fn iso(value: &str) -> Option<i64> {
    if value.len() != 24 {
        return None;
    }
    let date = DateTime::parse_from_rfc3339(value).ok()?;
    (date.to_rfc3339_opts(SecondsFormat::Millis, true) == value
        && date.timestamp_subsec_nanos() < 1_000_000_000)
        .then_some(date.timestamp_millis())
}
fn node_url(raw: &str) -> Result<String, String> {
    if raw.is_empty()
        || raw.len() > 2048
        || raw.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(error("invalid_request"));
    }
    let url = reqwest::Url::parse(raw).map_err(|_| error("invalid_request"))?;
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let private_ipv4 = host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| {
        let [a, b, _, _] = ip.octets();
        a == 0
            || a == 10
            || a == 127
            || a == 169 && b == 254
            || a == 172 && (16..=31).contains(&b)
            || a == 192 && b == 168
    });
    // Same public-origin grammar as the existing registration/Federation protocol.
    if url.origin().ascii_serialization() != raw
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !host.contains('.')
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.starts_with("fc")
        || host.starts_with("fd")
        || host.starts_with("fe80:")
        || private_ipv4
    {
        return Err(error("invalid_request"));
    }
    Ok(raw.into())
}
fn configured_base() -> Result<String, String> {
    let configured = crate::hub_origin();
    let url = reqwest::Url::parse(&configured).map_err(|_| error("origin_changed"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return Err(error("origin_changed"));
    }
    Ok(url.origin().ascii_serialization())
}
fn account(base: &str) -> Result<AccountBinding, String> {
    let status = crate::desktop_account::status(base).map_err(|_| error("account_required"))?;
    match (status.state, status.device_id, status.key_thumbprint) {
        ("registered", Some(device_id), Some(key_thumbprint))
            if opaque(&device_id) && canonical32(&key_thumbprint) =>
        {
            Ok(AccountBinding {
                device_id,
                key_thumbprint,
            })
        }
        _ => Err(error("account_required")),
    }
}
fn federation_thumbprint(key: &PublicKeyJwk) -> Result<String, String> {
    if key.kty != "EC" || key.crv != "P-256" || !canonical32(&key.x) || !canonical32(&key.y) {
        return Err(error("identity_changed"));
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(
            format!(
                r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
                key.x, key.y
            )
            .as_bytes()
        )
    ))
}
fn identity(
    node: &crate::personal_node::PersonalNodeService,
) -> Result<(PublicKeyJwk, String, String), String> {
    let (key, local) = node
        .public_identity()
        .ok_or_else(|| error("identity_changed"))?;
    let thumbprint = federation_thumbprint(&key)?;
    if NodeKey::thumbprint_jwk(&key).as_deref() != Some(local.as_str()) {
        return Err(error("identity_changed"));
    }
    Ok((key, local, thumbprint))
}
fn revoked_metadata(
    value: &Value,
    viewer: &str,
    node: &str,
    thumbprint: &str,
) -> Result<Revoked, String> {
    if !exact(value, &["viewerId", "node", "relays", "devices"])
        || !value["relays"].as_array().is_some_and(|a| a.len() <= 3)
        || !value["devices"].as_array().is_some_and(|a| a.len() <= 256)
    {
        return Err(error("invalid_challenge"));
    }
    if field(value, "viewerId")? != viewer {
        return Err(error("account_changed"));
    }
    let n = &value["node"];
    if n.is_null() || n["status"] != "revoked" {
        return Err(error("node_changed"));
    }
    if !exact(
        n,
        &[
            "nodeUrl",
            "keyThumbprint",
            "status",
            "registeredAt",
            "updatedAt",
        ],
    ) || field(n, "nodeUrl")? != node
        || field(n, "keyThumbprint")? != thumbprint
    {
        return Err(error("node_changed"));
    }
    let marker = field(n, "updatedAt")?;
    if iso(marker).is_none()
        || !opaque(viewer)
        || node_url(node).is_err()
        || !thumb(thumbprint)
        || !n["registeredAt"]
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.len() <= 64 && !v.chars().any(char::is_control))
    {
        return Err(error("invalid_challenge"));
    }
    Ok(Revoked {
        viewer: viewer.into(),
        node: node.into(),
        thumbprint: thumbprint.into(),
        revoked_at: marker.into(),
    })
}
fn validate_challenge(
    value: &Value,
    revoked: &Revoked,
    at: i64,
) -> Result<(String, String, String, i64), String> {
    if !exact(
        value,
        &[
            "viewerId",
            "nodeUrl",
            "keyThumbprint",
            "revokedAt",
            "challengeId",
            "challenge",
            "expiresAt",
        ],
    ) || field(value, "viewerId")? != revoked.viewer
        || field(value, "nodeUrl")? != revoked.node
        || field(value, "keyThumbprint")? != revoked.thumbprint
        || field(value, "revokedAt")? != revoked.revoked_at
        || !opaque(&revoked.viewer)
        || node_url(&revoked.node).is_err()
        || !thumb(&revoked.thumbprint)
        || iso(&revoked.revoked_at).is_none()
    {
        return Err(error("invalid_challenge"));
    }
    let id = field(value, "challengeId")?;
    let challenge = field(value, "challenge")?;
    let expires = field(value, "expiresAt")?;
    let ms = iso(expires).ok_or_else(|| error("invalid_challenge"))?;
    if !uuid(id) || ms <= at || ms > at.saturating_add(600_000) {
        return Err(error("invalid_challenge"));
    }
    let nonce = challenge
        .split('\n')
        .nth(5)
        .and_then(|line| line.strip_prefix("nonce="))
        .ok_or_else(|| error("invalid_challenge"))?;
    if !canonical32(nonce)||challenge!=format!("hub.personal-node.reactivate.v1\nprofile={}\nnode={}\nkey={}\nrevoked={}\nnonce={nonce}\nexpires={expires}",revoked.viewer,revoked.node,revoked.thumbprint,revoked.revoked_at){return Err(error("invalid_challenge"));}
    Ok((id.into(), challenge.into(), expires.into(), ms))
}
fn challenge_value(p: &Pending) -> Value {
    json!({"viewerId":p.revoked.viewer,"nodeUrl":p.revoked.node,"keyThumbprint":p.revoked.thumbprint,"revokedAt":p.revoked.revoked_at,"challengeId":p.challenge_id,"challenge":p.challenge,"expiresAt":p.expires_at})
}
fn check_binding(
    p: &Pending,
    a: &AccountBinding,
    i: &(PublicKeyJwk, String, String),
) -> Result<(), String> {
    if a != &p.account {
        return Err(error("account_changed"));
    }
    if i.0 != p.public_key || i.1 != p.local_thumbprint || i.2 != p.revoked.thumbprint {
        return Err(error("identity_changed"));
    }
    Ok(())
}
fn check_origin(expected: &str, current: &str) -> Result<(), String> {
    if current != expected {
        return Err(error("origin_changed"));
    }
    Ok(())
}
fn recheck(p: &Pending, node: &crate::personal_node::PersonalNodeService) -> Result<(), String> {
    check_origin(&p.base, &configured_base()?)?;
    check_binding(
        p,
        &account(&p.base).map_err(|_| error("account_changed"))?,
        &identity(node)?,
    )
}
fn sign_guarded(
    p: &Pending,
    a: &AccountBinding,
    i: &(PublicKeyJwk, String, String),
    revoked: &Revoked,
    at: i64,
    sign: impl FnOnce(&str) -> Option<String>,
) -> Result<String, String> {
    check_binding(p, a, i)?;
    if revoked != &p.revoked {
        return Err(error("node_changed"));
    }
    if at >= p.expires_ms {
        return Err(error("expired"));
    }
    validate_challenge(&challenge_value(p), &p.revoked, at)?;
    let signature = sign(&p.challenge).ok_or_else(|| error("identity_changed"))?;
    if signature.len() != 86
        || !URL_SAFE_NO_PAD
            .decode(&signature)
            .is_ok_and(|bytes| bytes.len() == 64 && URL_SAFE_NO_PAD.encode(bytes) == signature)
        || !NodeKey::verify_with_jwk(&p.public_key, &p.challenge, &signature)
    {
        return Err(error("identity_changed"));
    }
    Ok(signature)
}
fn preview(p: &Pending) -> Value {
    json!({"previewId":p.preview_id,"viewerId":p.revoked.viewer,"nodeUrl":p.revoked.node,"keyThumbprint":p.revoked.thumbprint,"revokedAt":p.revoked.revoked_at,"expiresAt":p.expires_at,"hubOrigin":p.base})
}
fn ack(value: &Value, p: &Pending) -> Result<Value, String> {
    if !exact(
        value,
        &["viewerId", "reactivated", "nodeUrl", "keyThumbprint"],
    ) || value["reactivated"] != true
        || value["viewerId"] != p.revoked.viewer
        || value["nodeUrl"] != p.revoked.node
        || value["keyThumbprint"] != p.revoked.thumbprint
    {
        return Err(error("unknown"));
    }
    Ok(
        json!({"viewerId":p.revoked.viewer,"reactivated":true,"nodeUrl":p.revoked.node,"keyThumbprint":p.revoked.thumbprint}),
    )
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| error("unavailable"))
}
async fn assertion(base: &str) -> Result<String, String> {
    tokio::time::timeout(
        Duration::from_secs(12),
        crate::desktop_account::assertion(base),
    )
    .await
    .map_err(|_| error("unavailable"))?
    .map_err(|_| error("unavailable"))
}
fn append(bytes: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), String> {
    if !matches!(limit, MAX_RESPONSE | MAX_METADATA)
        || bytes.len() > limit
        || chunk.len() > limit.saturating_sub(bytes.len())
    {
        return Err(error("unavailable"));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
async fn response(mut response: reqwest::Response, limit: usize) -> Result<Value, String> {
    if !response.status().is_success()
        || response.content_length().is_some_and(|n| n > limit as u64)
        || !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
            })
    {
        return Err(error("unavailable"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| error("unavailable"))? {
        append(&mut bytes, &chunk, limit)?;
    }
    serde_json::from_slice(&bytes).map_err(|_| error("invalid_challenge"))
}
async fn metadata(client: &reqwest::Client, p: &Pending, token: &str) -> Result<Revoked, String> {
    let value = response(
        client
            .get(format!("{}/api/client/personal-node", p.base))
            .bearer_auth(token)
            .header(reqwest::header::ORIGIN, &p.base)
            .header("X-Hub-Expected-Viewer", &p.revoked.viewer)
            .send()
            .await
            .map_err(|_| error("unavailable"))?,
        MAX_METADATA,
    )
    .await?;
    revoked_metadata(
        &value,
        &p.revoked.viewer,
        &p.revoked.node,
        &p.revoked.thumbprint,
    )
}
fn guard(window: &tauri::Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if window.label() != "main" || !crate::local_pairing_address(window.label(), &url) {
        return Err("native_window_required".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn personal_node_reactivation_prepare(
    window: tauri::Webview,
    runner: tauri::State<'_, Arc<crate::RunnerState>>,
    reactivation: tauri::State<'_, ReactivationState>,
    expected_viewer_id: String,
    expected_node_url: String,
    expected_key_thumbprint: String,
) -> Result<Value, String> {
    guard(&window)?;
    let mut slot = reactivation.pending.lock().await;
    let generation = slot.replace()?;
    if !opaque(&expected_viewer_id) || !thumb(&expected_key_thumbprint) {
        return Err(error("invalid_request"));
    }
    let node_url = node_url(&expected_node_url)?;
    let base = configured_base()?;
    let account = account(&base)?;
    let node = runner
        .node
        .as_ref()
        .ok_or_else(|| error("identity_changed"))?;
    let (public_key, local_thumbprint, actual_thumbprint) = identity(node)?;
    if actual_thumbprint != expected_key_thumbprint {
        return Err(error("identity_changed"));
    }
    let mut pending = Pending {
        preview_id: uuid::Uuid::new_v4().to_string(),
        base,
        account,
        public_key,
        local_thumbprint,
        revoked: Revoked {
            viewer: expected_viewer_id,
            node: node_url,
            thumbprint: expected_key_thumbprint,
            revoked_at: String::new(),
        },
        challenge_id: String::new(),
        challenge: String::new(),
        expires_at: String::new(),
        expires_ms: 0,
    };
    let client = client()?;
    let token = assertion(&pending.base).await?;
    recheck(&pending, node)?;
    let fetched = metadata(&client, &pending, &token).await?;
    pending.revoked = fetched;
    recheck(&pending, node)?;
    let value=response(client.post(format!("{}{ENDPOINT}",pending.base)).bearer_auth(&token).header(reqwest::header::ORIGIN,&pending.base).header("X-Hub-Expected-Viewer",&pending.revoked.viewer)
        .json(&json!({"action":"challenge","nodeUrl":pending.revoked.node,"publicKeyJwk":pending.public_key})).send().await.map_err(|_|error("unavailable"))?,MAX_RESPONSE).await?;
    recheck(&pending, node)?;
    let (id, challenge, expires, ms) = validate_challenge(&value, &pending.revoked, now())?;
    pending.challenge_id = id;
    pending.challenge = challenge;
    pending.expires_at = expires;
    pending.expires_ms = ms;
    let preview = preview(&pending);
    slot.store(generation, pending)?;
    Ok(preview)
}
#[tauri::command]
pub async fn personal_node_reactivation_complete(
    window: tauri::Webview,
    runner: tauri::State<'_, Arc<crate::RunnerState>>,
    reactivation: tauri::State<'_, ReactivationState>,
    preview_id: String,
    confirmed: bool,
) -> Result<Value, String> {
    guard(&window)?;
    if !uuid(&preview_id) {
        return Err(error("invalid_preview"));
    }
    let mut slot = reactivation.pending.lock().await;
    let Some(pending) = slot.take(&preview_id, confirmed)? else {
        return Ok(json!({"cancelled":true}));
    };
    let node = runner
        .node
        .as_ref()
        .ok_or_else(|| error("identity_changed"))?;
    recheck(&pending, node)?;
    let client = client()?;
    let token = assertion(&pending.base).await?;
    recheck(&pending, node)?;
    let current = metadata(&client, &pending, &token).await?;
    recheck(&pending, node)?;
    let signature = sign_guarded(
        &pending,
        &account(&pending.base)?,
        &identity(node)?,
        &current,
        now(),
        |message| node.sign(message),
    )?;
    recheck(&pending, node)?;
    // The preview has already been consumed. Every ambiguous result after this POST is unknown.
    let received=client.post(format!("{}{ENDPOINT}",pending.base)).bearer_auth(token).header(reqwest::header::ORIGIN,&pending.base).header("X-Hub-Expected-Viewer",&pending.revoked.viewer)
        .json(&json!({"action":"reactivate","challengeId":pending.challenge_id,"signature":signature})).send().await.map_err(|_|error("unknown"))?;
    recheck(&pending, node).map_err(|_| error("unknown"))?;
    let value = response(received, MAX_RESPONSE)
        .await
        .map_err(|_| error("unknown"))?;
    recheck(&pending, node).map_err(|_| error("unknown"))?;
    ack(&value, &pending)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    const REVOKED: &str = "2026-10-07T00:00:00.000Z";
    const EXPIRES: &str = "2026-10-07T00:10:00.000Z";
    const ID: &str = "11111111-2222-4333-8444-555555555555";
    fn fixture() -> (NodeKey, Pending) {
        let key = NodeKey::create();
        let public_key = key.public_jwk();
        let revoked = Revoked {
            viewer: "viewer-1".into(),
            node: "https://node.example".into(),
            thumbprint: federation_thumbprint(&public_key).unwrap(),
            revoked_at: REVOKED.into(),
        };
        let nonce = URL_SAFE_NO_PAD.encode([7u8; 32]);
        let challenge=format!("hub.personal-node.reactivate.v1\nprofile={}\nnode={}\nkey={}\nrevoked={}\nnonce={nonce}\nexpires={EXPIRES}",revoked.viewer,revoked.node,revoked.thumbprint,revoked.revoked_at);
        let pending = Pending {
            preview_id: ID.into(),
            base: "https://hub.example".into(),
            account: AccountBinding {
                device_id: "device-1".into(),
                key_thumbprint: URL_SAFE_NO_PAD.encode([8u8; 32]),
            },
            public_key,
            local_thumbprint: key.thumbprint(),
            revoked,
            challenge_id: uuid::Uuid::new_v4().to_string(),
            challenge,
            expires_at: EXPIRES.into(),
            expires_ms: iso(EXPIRES).unwrap(),
        };
        (key, pending)
    }
    fn current_identity(p: &Pending) -> (PublicKeyJwk, String, String) {
        (
            p.public_key.clone(),
            p.local_thumbprint.clone(),
            p.revoked.thumbprint.clone(),
        )
    }
    fn meta(p: &Pending) -> Value {
        json!({"viewerId":p.revoked.viewer,"node":{"nodeUrl":p.revoked.node,"keyThumbprint":p.revoked.thumbprint,"status":"revoked","registeredAt":REVOKED,"updatedAt":p.revoked.revoked_at},"relays":[],"devices":[]})
    }
    #[test]
    fn purpose_is_exact_seven_lines_and_registration_scope_or_epoch_cannot_be_signed() {
        let (_, p) = fixture();
        let at = iso(REVOKED).unwrap();
        let value = challenge_value(&p);
        assert!(validate_challenge(&value, &p.revoked, at).is_ok());
        assert_eq!(p.challenge.split('\n').count(), 7);
        for field in ["viewerId", "nodeUrl", "keyThumbprint", "revokedAt"] {
            let mut wrong = value.clone();
            wrong[field] = json!("changed");
            assert!(validate_challenge(&wrong, &p.revoked, at).is_err());
        }
        for challenge in [
            p.challenge.replace("reactivate.v1", "register.v1"),
            p.challenge.clone() + "\n",
            p.challenge.replace("key=", "other="),
        ] {
            let mut wrong = value.clone();
            wrong["challenge"] = json!(challenge);
            assert!(validate_challenge(&wrong, &p.revoked, at).is_err());
        }
    }
    #[test]
    fn challenge_schema_uuid_nonce_iso_and_inclusive_ten_minute_bound_are_closed() {
        let (_, p) = fixture();
        let at = iso(REVOKED).unwrap();
        let mut value = challenge_value(&p);
        assert!(validate_challenge(&value, &p.revoked, at).is_ok());
        value["privateKey"] = json!("forbidden");
        assert!(validate_challenge(&value, &p.revoked, at).is_err());
        value = challenge_value(&p);
        value.as_object_mut().unwrap().remove("revokedAt");
        assert!(validate_challenge(&value, &p.revoked, at).is_err());
        for id in [
            "11111111-2222-1333-8444-555555555555",
            "11111111-2222-4333-c444-555555555555",
            "11111111-2222-4333-8444-555555555555\n",
        ] {
            value = challenge_value(&p);
            value["challengeId"] = json!(id);
            assert!(validate_challenge(&value, &p.revoked, at).is_err());
        }
        assert!(validate_challenge(&challenge_value(&p), &p.revoked, p.expires_ms).is_err());
        assert!(validate_challenge(&challenge_value(&p), &p.revoked, at - 1).is_err());
        for iso in [
            "2026-10-07T00:10:00Z",
            "2026-10-07T00:10:00.000+00:00",
            "2026-10-07T00:10:60.000Z",
        ] {
            assert!(super::iso(iso).is_none());
        }
        let nonce = p.challenge.split('\n').nth(5).unwrap();
        value = challenge_value(&p);
        value["challenge"] = json!(p.challenge.replace(nonce, &format!("{nonce}=")));
        assert!(validate_challenge(&value, &p.revoked, at).is_err());
    }
    #[test]
    fn metadata_requires_same_actual_viewer_original_revoked_node_and_raw_updated_marker() {
        let (_, p) = fixture();
        assert!(
            revoked_metadata(
                &meta(&p),
                &p.revoked.viewer,
                &p.revoked.node,
                &p.revoked.thumbprint
            )
            .unwrap()
                == p.revoked
        );
        for (field, content) in [
            ("nodeUrl", json!("https://other.example")),
            ("keyThumbprint", json!("0".repeat(64))),
            ("status", json!("active")),
            ("updatedAt", json!("2026-10-07T00:00:00Z")),
        ] {
            let mut value = meta(&p);
            value["node"][field] = content;
            assert!(revoked_metadata(
                &value,
                &p.revoked.viewer,
                &p.revoked.node,
                &p.revoked.thumbprint
            )
            .is_err());
        }
        let mut value = meta(&p);
        value["viewerId"] = json!("other");
        assert_eq!(
            revoked_metadata(
                &value,
                &p.revoked.viewer,
                &p.revoked.node,
                &p.revoked.thumbprint
            )
            .err()
            .unwrap(),
            error("account_changed")
        );
        value = meta(&p);
        value["node"] = Value::Null;
        assert!(revoked_metadata(
            &value,
            &p.revoked.viewer,
            &p.revoked.node,
            &p.revoked.thumbprint
        )
        .is_err());
        for key in ["privateKey", "recovery", "publicKeyJwk"] {
            value = meta(&p);
            value[key] = json!({});
            assert!(revoked_metadata(
                &value,
                &p.revoked.viewer,
                &p.revoked.node,
                &p.revoked.thumbprint
            )
            .is_err());
        }
    }
    #[test]
    fn opaque_node_original_url_thumb_and_public_jwk_boundaries_reject_without_new_keys() {
        assert!(opaque(&"a".repeat(160)));
        assert!(!opaque(&"a".repeat(161)));
        for value in ["viewer\n", "viewer\0", "_viewer", "", "日本語"] {
            assert!(!opaque(value));
        }
        assert!(node_url("https://node.example").is_ok());
        for value in [
            "https://node.example/",
            "https://node.example/path",
            "https://private@node.example",
            "http://node.example",
            "https://127.0.0.1",
            "https://node.example:444",
            "https://node.example\n",
        ] {
            assert!(node_url(value).is_err());
        }
        let (_, p) = fixture();
        assert!(thumb(&p.revoked.thumbprint));
        assert!(!thumb(&"A".repeat(64)));
        let mut key = p.public_key.clone();
        key.x += "=";
        assert!(federation_thumbprint(&key).is_err());
        key = p.public_key.clone();
        key.crv = "P-384".into();
        assert!(federation_thumbprint(&key).is_err());
    }
    #[test]
    fn same_key_signature_has_raw_p256_width_and_verifies_only_the_frozen_purpose() {
        let (key, p) = fixture();
        let signature = sign_guarded(
            &p,
            &p.account,
            &current_identity(&p),
            &p.revoked,
            iso(REVOKED).unwrap(),
            |text| Some(key.sign(text)),
        )
        .unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(&signature).unwrap().len(), 64);
        assert!(key.verify(&p.challenge, &signature));
        assert!(!key.verify(
            &p.challenge.replace("reactivate.v1", "register.v1"),
            &signature
        ));
        let other = NodeKey::create();
        assert!(sign_guarded(
            &p,
            &p.account,
            &current_identity(&p),
            &p.revoked,
            iso(REVOKED).unwrap(),
            |text| Some(other.sign(text))
        )
        .is_err());
    }
    #[test]
    fn account_key_origin_revocation_epoch_expiry_and_bad_purpose_guards_have_zero_signatures() {
        let (key, mut p) = fixture();
        let count = Cell::new(0);
        let signed = |text: &str| {
            count.set(count.get() + 1);
            Some(key.sign(text))
        };
        let at = iso(REVOKED).unwrap();
        let mut account = p.account.clone();
        account.device_id = "other".into();
        assert!(
            sign_guarded(&p, &account, &current_identity(&p), &p.revoked, at, &signed).is_err()
        );
        account = p.account.clone();
        account.key_thumbprint = URL_SAFE_NO_PAD.encode([9u8; 32]);
        assert!(
            sign_guarded(&p, &account, &current_identity(&p), &p.revoked, at, &signed).is_err()
        );
        let mut identity = current_identity(&p);
        identity.2 = "0".repeat(64);
        assert!(sign_guarded(&p, &p.account, &identity, &p.revoked, at, &signed).is_err());
        let mut revoked = p.revoked.clone();
        revoked.revoked_at = "2026-10-07T00:00:00.001Z".into();
        assert!(
            sign_guarded(&p, &p.account, &current_identity(&p), &revoked, at, &signed).is_err()
        );
        assert!(check_origin(&p.base, "https://changed.example")
            .and_then(|_| sign_guarded(
                &p,
                &p.account,
                &current_identity(&p),
                &p.revoked,
                at,
                &signed
            ))
            .is_err());
        assert!(sign_guarded(
            &p,
            &p.account,
            &current_identity(&p),
            &p.revoked,
            p.expires_ms,
            &signed
        )
        .is_err());
        p.challenge = p.challenge.replace("reactivate.v1", "register.v1");
        assert!(sign_guarded(
            &p,
            &p.account,
            &current_identity(&p),
            &p.revoked,
            at,
            &signed
        )
        .is_err());
        assert_eq!(count.get(), 0);
    }
    #[test]
    fn one_use_generation_and_stale_cancel_preserve_the_new_preview_without_signing() {
        let mut slot = PreviewSlot::default();
        let (_, old) = fixture();
        let old_id = old.preview_id.clone();
        let generation = slot.replace().unwrap();
        slot.store(generation, old).unwrap();
        let next = slot.replace().unwrap();
        let (_, mut new) = fixture();
        new.preview_id = uuid::Uuid::new_v4().to_string();
        let new_id = new.preview_id.clone();
        slot.store(next, new).unwrap();
        assert!(slot.take(&old_id, false).is_err());
        assert_eq!(slot.pending.as_ref().unwrap().preview_id, new_id);
        let signed = Cell::new(0);
        if let Some(pending) = slot.take(&new_id, false).unwrap() {
            signed.set(signed.get() + 1);
            drop(pending);
        }
        assert_eq!(signed.get(), 0);
        assert!(slot.take(&new_id, true).is_err());
        let (_, pending) = fixture();
        let id = pending.preview_id.clone();
        let generation = slot.replace().unwrap();
        slot.store(generation, pending).unwrap();
        assert!(slot.take(&id, true).unwrap().is_some());
        assert!(slot.take(&id, true).is_err());
        let (_, pending) = fixture();
        assert!(slot.store(generation - 1, pending).is_err());
        slot.generation = u64::MAX;
        assert!(slot.replace().is_err());
        assert!(slot.pending.is_none());
    }
    #[test]
    fn preview_is_metadata_only_and_ack_closed_actor_original_url_key_exact_even_after_ttl() {
        let (_, p) = fixture();
        let value = preview(&p);
        assert_eq!(value.as_object().unwrap().len(), 7);
        for key in [
            "challenge",
            "challengeId",
            "signature",
            "publicKeyJwk",
            "privateKey",
        ] {
            assert!(value.get(key).is_none());
        }
        let value = json!({"viewerId":p.revoked.viewer,"reactivated":true,"nodeUrl":p.revoked.node,"keyThumbprint":p.revoked.thumbprint});
        assert!(ack(&value, &p).is_ok());
        for (key, content) in [
            ("viewerId", json!("other")),
            ("reactivated", json!(false)),
            ("nodeUrl", json!("https://other.example")),
            ("keyThumbprint", json!("0".repeat(64))),
            ("extra", json!(true)),
        ] {
            let mut wrong = value.clone();
            wrong[key] = content;
            assert_eq!(ack(&wrong, &p).err().unwrap(), error("unknown"));
        }
    }
    #[test]
    fn actual_control_and_metadata_bytes_are_independently_inclusive_and_never_truncated() {
        for limit in [MAX_RESPONSE, MAX_METADATA] {
            let mut bytes = vec![0; limit - 1];
            append(&mut bytes, &[1], limit).unwrap();
            assert_eq!(bytes.len(), limit);
            assert!(append(&mut bytes, &[2], limit).is_err());
            assert_eq!(bytes.len(), limit);
        }
        let (_, p) = fixture();
        let mut value = meta(&p);
        value["devices"]=json!((0..256).map(|n|json!({"deviceId":format!("device-{n}"),"label":"synthetic","keyThumbprint":"a".repeat(64),"status":"revoked"})).collect::<Vec<_>>());
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(bytes.len() > MAX_RESPONSE && bytes.len() < MAX_METADATA);
        let mut actual = Vec::new();
        append(&mut actual, &bytes, MAX_METADATA).unwrap();
        assert!(revoked_metadata(
            &serde_json::from_slice(&actual).unwrap(),
            &p.revoked.viewer,
            &p.revoked.node,
            &p.revoked.thumbprint
        )
        .is_ok());
        assert!(append(&mut Vec::new(), &bytes, MAX_RESPONSE).is_err());
        value["devices"].as_array_mut().unwrap().push(json!({}));
        assert!(revoked_metadata(
            &value,
            &p.revoked.viewer,
            &p.revoked.node,
            &p.revoked.thumbprint
        )
        .is_err());
        assert!(append(&mut Vec::new(), b"x", usize::MAX).is_err());
    }
}
