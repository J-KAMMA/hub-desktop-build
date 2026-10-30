//! Native-only, one-use approval for the fixed personal-node registration purpose.
use crate::node_identity::{NodeKey, PublicKeyJwk};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;

const PREFIX: &str = "personal_node_registration_";
const MAX_RESPONSE: usize = 8192;
const REGISTRATION: &str = "/api/client/personal-node/registration";
fn error(code: &str) -> String {
    format!("{PREFIX}{code}")
}
fn now() -> i64 {
    Utc::now().timestamp_millis()
}

#[derive(Default)]
pub struct RegistrationState {
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
        let pending = self
            .pending
            .take()
            .ok_or_else(|| error("invalid_preview"))?;
        if pending.preview_id != id {
            return Err(error("invalid_preview"));
        }
        Ok(confirmed.then_some(pending))
    }
}
#[derive(Clone, PartialEq, Eq)]
struct AccountBinding {
    device_id: String,
    key_thumbprint: String,
}
struct Pending {
    preview_id: String,
    base: String,
    account: AccountBinding,
    public_key: PublicKeyJwk,
    local_thumbprint: String,
    viewer_id: String,
    node_url: String,
    thumbprint: String,
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
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
}
fn canonical_32(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.hyphenated().to_string() == value
            && id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
    })
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| error("invalid_challenge"))
}
fn normalized_node(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 2048
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(error("invalid_node_url"));
    }
    let url = reqwest::Url::parse(value).map_err(|_| error("invalid_node_url"))?;
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
    if url.scheme() != "https"
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
        return Err(error("invalid_node_url"));
    }
    Ok(url.origin().ascii_serialization())
}
fn configured_base() -> Result<String, String> {
    let configured = crate::hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    let url = reqwest::Url::parse(&configured).map_err(|_| error("origin_changed"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
    {
        return Err(error("origin_changed"));
    }
    Ok(url.origin().ascii_serialization())
}
fn account(base: &str) -> Result<AccountBinding, String> {
    let status = crate::desktop_account::status(base).map_err(|_| error("account_required"))?;
    match (status.state, status.device_id, status.key_thumbprint) {
        ("registered", Some(device_id), Some(key_thumbprint))
            if opaque(&device_id) && canonical_32(&key_thumbprint) =>
        {
            Ok(AccountBinding {
                device_id,
                key_thumbprint,
            })
        }
        _ => Err(error("account_required")),
    }
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
fn federation_thumbprint(key: &PublicKeyJwk) -> Result<String, String> {
    if key.kty != "EC" || key.crv != "P-256" || !canonical_32(&key.x) || !canonical_32(&key.y) {
        return Err(error("identity_changed"));
    }
    let canonical = format!(
        r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
        key.x, key.y
    );
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}
fn unregistered_viewer(value: &Value) -> Result<String, String> {
    if !exact(value, &["viewerId", "node", "relays", "devices"])
        || !value["relays"].as_array().is_some_and(|a| a.len() <= 3)
        || !value["devices"].as_array().is_some_and(|a| a.len() <= 256)
    {
        return Err(error("invalid_challenge"));
    }
    let viewer = field(value, "viewerId")?;
    if !opaque(viewer) {
        return Err(error("invalid_challenge"));
    }
    if !value["node"].is_null() {
        return Err(error("existing"));
    }
    Ok(viewer.into())
}
fn validate_challenge(
    value: &Value,
    viewer: &str,
    node: &str,
    thumbprint: &str,
    at: i64,
) -> Result<(String, String, String, i64), String> {
    if !exact(
        value,
        &[
            "viewerId",
            "nodeUrl",
            "keyThumbprint",
            "challengeId",
            "challenge",
            "expiresAt",
        ],
    ) || !opaque(viewer)
        || field(value, "viewerId")? != viewer
        || field(value, "nodeUrl")? != node
        || field(value, "keyThumbprint")? != thumbprint
        || thumbprint.len() != 64
        || !thumbprint
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(error("invalid_challenge"));
    }
    let id = field(value, "challengeId")?;
    let challenge = field(value, "challenge")?;
    let expires = field(value, "expiresAt")?;
    let date = DateTime::parse_from_rfc3339(expires).map_err(|_| error("invalid_challenge"))?;
    let ms = date.timestamp_millis();
    if !uuid(id)
        || expires.len() != 24
        || date.to_rfc3339_opts(SecondsFormat::Millis, true) != expires
        || ms <= at
        || ms > at.saturating_add(600_000)
    {
        return Err(error("invalid_challenge"));
    }
    let lines: Vec<_> = challenge.split('\n').collect();
    let nonce = lines
        .get(3)
        .and_then(|line| line.strip_prefix("nonce="))
        .ok_or_else(|| error("invalid_challenge"))?;
    if !canonical_32(nonce) || challenge != format!("hub.personal-node.register.v1\nprofile={viewer}\nnode={node}\nnonce={nonce}\nexpires={expires}") {
        return Err(error("invalid_challenge"));
    }
    Ok((id.into(), challenge.into(), expires.into(), ms))
}
fn recheck(
    pending: &Pending,
    node: &crate::personal_node::PersonalNodeService,
) -> Result<(), String> {
    if configured_base()? != pending.base {
        return Err(error("origin_changed"));
    }
    check_snapshot(
        pending,
        &account(&pending.base).map_err(|_| error("account_changed"))?,
        &identity(node)?,
        now(),
    )
}
fn check_snapshot(
    pending: &Pending,
    account: &AccountBinding,
    identity: &(PublicKeyJwk, String, String),
    at: i64,
) -> Result<(), String> {
    if account != &pending.account {
        return Err(error("account_changed"));
    }
    let (key, local, thumbprint) = identity;
    if key != &pending.public_key
        || local != &pending.local_thumbprint
        || thumbprint != &pending.thumbprint
    {
        return Err(error("identity_changed"));
    }
    if at >= pending.expires_ms {
        return Err(error("expired"));
    }
    Ok(())
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| error("unavailable"))
}
async fn assertion(base: &str) -> Result<String, String> {
    tokio::time::timeout(
        Duration::from_secs(10),
        crate::desktop_account::assertion(base),
    )
    .await
    .map_err(|_| error("unavailable"))?
    .map_err(|_| error("unavailable"))
}
async fn response(mut response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE as u64)
        || response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::trim)
            != Some("application/json")
    {
        return Err(error("unavailable"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| error("unavailable"))? {
        append_response(&mut bytes, &chunk)?;
    }
    serde_json::from_slice(&bytes).map_err(|_| error("invalid_challenge"))
}
fn append_response(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_RESPONSE || chunk.len() > MAX_RESPONSE - bytes.len() {
        return Err(error("unavailable"));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
async fn metadata(client: &reqwest::Client, base: &str, token: &str) -> Result<String, String> {
    unregistered_viewer(
        &response(
            client
                .get(format!("{base}/api/client/personal-node"))
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| error("unavailable"))?,
        )
        .await?,
    )
}
fn guard(window: &tauri::Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !crate::local_pairing_address(window.label(), &url) {
        return Err("native_window_required".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn personal_node_registration_prepare(
    window: tauri::Webview,
    runner: tauri::State<'_, Arc<crate::RunnerState>>,
    registration: tauri::State<'_, RegistrationState>,
    node_url: String,
) -> Result<Value, String> {
    guard(&window)?;
    // Hold the same mutex across network awaits: replacement and completion are serialized.
    let mut slot = registration.pending.lock().await;
    let generation = slot.replace()?;
    let base = configured_base()?;
    let node_url = normalized_node(&node_url)?;
    let account = account(&base)?;
    let node = runner
        .node
        .as_ref()
        .ok_or_else(|| error("identity_changed"))?;
    let (public_key, local_thumbprint, thumbprint) = identity(node)?;
    let client = client()?;
    let token = assertion(&base).await?;
    let viewer_id = metadata(&client, &base, &token).await?;
    let value = response(
        client
            .post(format!("{base}{REGISTRATION}"))
            .bearer_auth(&token)
            .json(&json!({"action":"challenge","nodeUrl":node_url,"publicKeyJwk":public_key}))
            .send()
            .await
            .map_err(|_| error("unavailable"))?,
    )
    .await?;
    let (challenge_id, challenge, expires_at, expires_ms) =
        validate_challenge(&value, &viewer_id, &node_url, &thumbprint, now())?;
    let pending = Pending {
        preview_id: uuid::Uuid::new_v4().to_string(),
        base,
        account,
        public_key,
        local_thumbprint,
        viewer_id,
        node_url,
        thumbprint,
        challenge_id,
        challenge,
        expires_at,
        expires_ms,
    };
    recheck(&pending, node)?;
    let preview = json!({"previewId":pending.preview_id,"viewerId":pending.viewer_id,"nodeUrl":pending.node_url,"keyThumbprint":pending.thumbprint,"expiresAt":pending.expires_at,"hubOrigin":pending.base});
    slot.store(generation, pending)?;
    Ok(preview)
}

#[tauri::command]
pub async fn personal_node_registration_complete(
    window: tauri::Webview,
    runner: tauri::State<'_, Arc<crate::RunnerState>>,
    registration: tauri::State<'_, RegistrationState>,
    preview_id: String,
    confirmed: bool,
) -> Result<Value, String> {
    guard(&window)?;
    let mut slot = registration.pending.lock().await;
    let Some(pending) = slot.take(&preview_id, confirmed)? else {
        return Ok(json!({"cancelled":true}));
    };
    let node = runner
        .node
        .as_ref()
        .ok_or_else(|| error("identity_changed"))?;
    recheck(&pending, node)?;
    validate_challenge(
        &json!({"viewerId":pending.viewer_id,"nodeUrl":pending.node_url,"keyThumbprint":pending.thumbprint,"challengeId":pending.challenge_id,"challenge":pending.challenge,"expiresAt":pending.expires_at}),
        &pending.viewer_id,
        &pending.node_url,
        &pending.thumbprint,
        now(),
    )?;
    let client = client()?;
    let token = assertion(&pending.base).await?;
    if metadata(&client, &pending.base, &token).await? != pending.viewer_id {
        return Err(error("account_changed"));
    }
    recheck(&pending, node)?;
    let signature = node
        .sign(&pending.challenge)
        .ok_or_else(|| error("identity_changed"))?;
    if !NodeKey::verify_with_jwk(&pending.public_key, &pending.challenge, &signature) {
        return Err(error("identity_changed"));
    }
    let response = client
        .post(format!("{}{REGISTRATION}", pending.base))
        .bearer_auth(token)
        .json(
            &json!({"action":"register","challengeId":pending.challenge_id,"signature":signature}),
        )
        .send()
        .await
        .map_err(|_| error("unknown"))?;
    let value = self::response(response)
        .await
        .map_err(|_| error("unknown"))?;
    if !exact(
        &value,
        &["viewerId", "registered", "nodeUrl", "keyThumbprint"],
    ) || value["registered"] != true
        || value["viewerId"] != pending.viewer_id
        || value["nodeUrl"] != pending.node_url
        || value["keyThumbprint"] != pending.thumbprint
    {
        return Err(error("unknown"));
    }
    Ok(
        json!({"viewerId":pending.viewer_id,"registered":true,"nodeUrl":pending.node_url,"keyThumbprint":pending.thumbprint}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Pending {
        let key = NodeKey::create();
        let public_key = key.public_jwk();
        let thumbprint = federation_thumbprint(&public_key).unwrap();
        let expires_at = "2026-10-06T00:05:00.000Z".to_string();
        let node_url = "https://node.example".to_string();
        let viewer_id = "profile_1".to_string();
        let challenge = format!("hub.personal-node.register.v1\nprofile={viewer_id}\nnode={node_url}\nnonce={}\nexpires={expires_at}",URL_SAFE_NO_PAD.encode([7u8;32]));
        Pending {
            preview_id: uuid::Uuid::new_v4().to_string(),
            base: "https://hub.example".into(),
            account: AccountBinding {
                device_id: "device_1".into(),
                key_thumbprint: key.thumbprint(),
            },
            public_key,
            local_thumbprint: key.thumbprint(),
            viewer_id,
            node_url,
            thumbprint,
            challenge_id: uuid::Uuid::new_v4().to_string(),
            challenge,
            expires_at,
            expires_ms: 0,
        }
    }
    fn value(p: &Pending) -> Value {
        json!({"viewerId":p.viewer_id,"nodeUrl":p.node_url,"keyThumbprint":p.thumbprint,"challengeId":p.challenge_id,"challenge":p.challenge,"expiresAt":p.expires_at})
    }
    #[test]
    fn external_origin_and_opaque_boundaries() {
        assert_eq!(
            normalized_node("https://NODE.example:443/").unwrap(),
            "https://node.example"
        );
        for url in [
            "http://node.example",
            "https://user@node.example",
            "https://node.example:444",
            "https://node.example/path",
            "https://node.example/?x",
            "https://node.example/#x",
            "https://localhost",
            "https://node.local",
            "https://127.0.0.1",
            "https://10.1.2.3",
            "https://172.31.2.3",
            "https://192.168.1.1",
            "https://[::1]",
            "https://node.example\n",
        ] {
            assert!(normalized_node(url).is_err(), "{url}");
        }
        assert!(opaque(&"a".repeat(160)));
        for id in ["", "_a", "a\n", "a/", "é"] {
            assert!(!opaque(id));
        }
        assert!(!opaque(&"a".repeat(161)));
    }
    #[test]
    fn challenge_is_only_the_exact_registration_purpose() {
        let p = fixture();
        let at = DateTime::parse_from_rfc3339("2026-10-06T00:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        let valid = value(&p);
        assert!(validate_challenge(&valid, &p.viewer_id, &p.node_url, &p.thumbprint, at).is_ok());
        for (key, change) in [
            ("viewerId", json!("other")),
            ("nodeUrl", json!("https://other.example")),
            ("keyThumbprint", json!("a".repeat(64))),
            ("challengeId", json!("bad")),
            ("challengeId", json!("00000000-0000-1000-8000-000000000001")),
            ("challengeId", json!("00000000-0000-4000-0000-000000000001")),
            ("expiresAt", json!("2026-10-06T00:11:00.000Z")),
            ("expiresAt", json!("2026-10-06T00:00:00.000Z")),
            ("expiresAt", json!("2026-10-06T00:05:00Z")),
            ("challenge", json!(p.challenge.clone() + "\n")),
            (
                "challenge",
                json!(p.challenge.replace("register.v1", "device.v1")),
            ),
            (
                "challenge",
                json!(p.challenge.replace("profile=profile_1", "profile=other")),
            ),
            ("challenge", json!(p.challenge.replace("nonce=", "nonce=="))),
        ] {
            let mut v = valid.clone();
            v[key] = change;
            assert!(
                validate_challenge(&v, &p.viewer_id, &p.node_url, &p.thumbprint, at).is_err(),
                "{key}"
            );
        }
        let mut extra = valid.clone();
        extra["secret"] = json!("hidden");
        assert!(validate_challenge(&extra, &p.viewer_id, &p.node_url, &p.thumbprint, at).is_err());
        assert!(validate_challenge(
            &valid,
            &p.viewer_id,
            &p.node_url,
            &p.thumbprint,
            at - 300_000
        )
        .is_ok());
        assert!(validate_challenge(
            &valid,
            &p.viewer_id,
            &p.node_url,
            &p.thumbprint,
            at - 300_001
        )
        .is_err());
    }
    #[test]
    fn metadata_rejects_existing_active_or_revoked_and_missing_auth() {
        let mut v = json!({"viewerId":"profile_1","node":null,"relays":[],"devices":[]});
        assert_eq!(unregistered_viewer(&v).unwrap(), "profile_1");
        for status in ["active", "revoked"] {
            v["node"] = json!({"status":status});
            assert_eq!(unregistered_viewer(&v).unwrap_err(), error("existing"));
        }
        v["node"] = Value::Null;
        v["viewerId"] = json!("a\n");
        assert!(unregistered_viewer(&v).is_err());
        assert!(unregistered_viewer(&json!({"node":null})).is_err());
    }
    #[test]
    fn previews_are_replaced_taken_once_and_cancelled_without_effects() {
        let mut slot = PreviewSlot::default();
        let first = slot.replace().unwrap();
        let p = fixture();
        let id = p.preview_id.clone();
        slot.store(first, p).unwrap();
        let second = slot.replace().unwrap();
        assert!(slot.take(&id, true).is_err());
        assert!(slot.store(first, fixture()).is_err());
        let p = fixture();
        let id = p.preview_id.clone();
        slot.store(second, p).unwrap();
        assert!(slot.take(&id, false).unwrap().is_none());
        assert!(slot.take(&id, true).is_err());
        let generation = slot.replace().unwrap();
        slot.store(generation, fixture()).unwrap();
        assert!(slot.take("wrong", true).is_err());
        assert!(slot.pending.is_none());
        slot.generation = u64::MAX;
        assert!(slot.replace().is_err());
        assert!(slot.pending.is_none());
    }
    #[test]
    fn raw_p256_signature_and_federation_hex_thumbprint_interoperate() {
        use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
        let key = NodeKey::create();
        let jwk = key.public_jwk();
        let p = fixture();
        let signature = key.sign(&p.challenge);
        let raw = URL_SAFE_NO_PAD.decode(&signature).unwrap();
        assert_eq!(raw.len(), 64);
        assert_eq!(URL_SAFE_NO_PAD.encode(&raw), signature);
        let mut point = vec![4];
        point.extend(URL_SAFE_NO_PAD.decode(&jwk.x).unwrap());
        point.extend(URL_SAFE_NO_PAD.decode(&jwk.y).unwrap());
        let verifier = VerifyingKey::from_sec1_bytes(&point).unwrap();
        let parsed = Signature::from_slice(&raw).unwrap();
        assert!(verifier.verify(p.challenge.as_bytes(), &parsed).is_ok());
        assert!(verifier
            .verify((p.challenge + "\n").as_bytes(), &parsed)
            .is_err());
        let hex = federation_thumbprint(&jwk).unwrap();
        assert_eq!(hex.len(), 64);
        let local = URL_SAFE_NO_PAD.decode(key.thumbprint()).unwrap();
        assert_eq!(
            hex,
            local
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert_ne!(hex, key.thumbprint());
        let mut invalid = jwk;
        invalid.x.push('=');
        assert!(federation_thumbprint(&invalid).is_err());
    }
    #[test]
    fn independent_webcrypto_fixture_verifies_with_the_native_key_contract() {
        // Synthetic scalar 1; public JWK, hash and signature produced by Node WebCrypto.
        let jwk = PublicKeyJwk {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY".into(),
            y: "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU".into(),
        };
        assert_eq!(
            federation_thumbprint(&jwk).unwrap(),
            "c71d01700fb0328870f1ab580c939eea9786328764946db04470655c732f9743"
        );
        let message = fixture().challenge;
        let signature="na47o99kOf8pSE44UfXURyrDyxkqvUixtp7UO02lCGcn7cqYPTH3u_RV8z0Gv1q1TyKWurxbvB0vcGcyGnE3zg";
        assert!(NodeKey::verify_with_jwk(&jwk, &message, signature));
        assert!(!NodeKey::verify_with_jwk(
            &jwk,
            &(message + "\n"),
            signature
        ));
    }
    #[test]
    fn account_key_identity_and_exact_expiry_must_match_the_preview() {
        let mut p = fixture();
        p.expires_ms = 100;
        let binding = p.account.clone();
        let identity = (
            p.public_key.clone(),
            p.local_thumbprint.clone(),
            p.thumbprint.clone(),
        );
        assert!(check_snapshot(&p, &binding, &identity, 99).is_ok());
        assert_eq!(
            check_snapshot(&p, &binding, &identity, 100).unwrap_err(),
            error("expired")
        );
        for change in [
            AccountBinding {
                device_id: "other".into(),
                ..binding.clone()
            },
            AccountBinding {
                key_thumbprint: "other".into(),
                ..binding.clone()
            },
        ] {
            assert_eq!(
                check_snapshot(&p, &change, &identity, 99).unwrap_err(),
                error("account_changed")
            );
        }
        for change in [
            (
                NodeKey::create().public_jwk(),
                identity.1.clone(),
                identity.2.clone(),
            ),
            (identity.0.clone(), "other".into(), identity.2.clone()),
            (identity.0.clone(), identity.1.clone(), "other".into()),
        ] {
            assert_eq!(
                check_snapshot(&p, &binding, &change, 99).unwrap_err(),
                error("identity_changed")
            );
        }
    }
    #[test]
    fn streamed_response_limit_checks_whole_accumulation_without_mutation_on_error() {
        let mut bytes = vec![];
        append_response(&mut bytes, &vec![1; MAX_RESPONSE - 1]).unwrap();
        append_response(&mut bytes, &[2]).unwrap();
        let before = bytes.clone();
        assert!(append_response(&mut bytes, &[3]).is_err());
        assert_eq!(bytes, before);
        assert!(append_response(&mut vec![], &vec![0; MAX_RESPONSE + 1]).is_err());
        assert!(append_response(&mut vec![0; MAX_RESPONSE + 1], &[]).is_err());
    }
}
