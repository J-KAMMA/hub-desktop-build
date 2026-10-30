//! 持ち運べる身元（docs/hub-decentralization/DESIGN.md 2.3）の Desktop 側。
//!
//! 根鍵は Personal Node の身元鍵（P-256、`node_identity.rs`）そのもの。端末の保管庫から出ない。
//! このモジュールが外へ出すのは **公開鍵（did:key）と、鍵が署名した文書だけ**。秘密鍵は返さない。
//!
//! 署名は W3C Data Integrity の `ecdsa-jcs-2019`（RFC 8785 の正規化 JSON）。`apps/hub/lib/portable-identity.ts` と
//! `apps/federation/src/identity.ts` が同じ文書を検証する。互換は下の試験ベクトルで縛る。
//!
//! 根鍵はログイン資格にも、ウォレット鍵にも、Identity の assertion にも使わない（AGENTS.md）。
//! 署名するのは次の2種類の文書だけで、任意の文書への署名は受け付けない。
//!   - 公開鍵の登録文（`HubRootKeyRegistration`）
//!   - 移転宣言（`Move`、actor = object = 旧 actor）
//!
//! lib.rs への登録（このモジュールでは編集しない）:
//!   mod portable_identity;
//!   .invoke_handler の一覧に
//!     portable_identity::portable_identity_public,
//!     portable_identity::portable_identity_sign_registration,
//!     portable_identity::portable_identity_sign_move,

use crate::node_identity::PublicKeyJwk;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DID_KEY_PREFIX: &str = "did:key:";
const MULTICODEC_P256_PUB: [u8; 2] = [0x80, 0x24];
const AS_CONTEXT: &str = "https://www.w3.org/ns/activitystreams";
const DATA_INTEGRITY_CONTEXT: &str = "https://w3id.org/security/data-integrity/v2";
const CRYPTOSUITE: &str = "ecdsa-jcs-2019";

/* ---------------------------------------------------------------- base58btc / did:key */

pub fn base58_encode(bytes: &[u8]) -> String {
    let zeros = bytes.iter().take_while(|byte| **byte == 0).count();
    // 大きな整数を 58 進に直す（筆算）。
    let mut digits: Vec<u8> = Vec::new();
    for byte in bytes {
        let mut carry = u32::from(*byte);
        for digit in digits.iter_mut() {
            carry += u32::from(*digit) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    out.extend(std::iter::repeat('1').take(zeros));
    out.extend(digits.iter().rev().map(|digit| ALPHABET[usize::from(*digit)] as char));
    out
}

pub fn base58_decode(value: &str) -> Option<Vec<u8>> {
    let ones = value.bytes().take_while(|byte| *byte == b'1').count();
    let mut bytes: Vec<u8> = Vec::new();
    for character in value.bytes() {
        let index = ALPHABET.iter().position(|candidate| *candidate == character)?;
        let mut carry = index as u32;
        for byte in bytes.iter_mut() {
            carry += u32::from(*byte) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let mut out = vec![0_u8; ones];
    out.extend(bytes.iter().rev());
    Some(out)
}

/// 公開鍵 JWK から did:key（P-256、圧縮点）を作る。座標が 32 バイトでなければ None。
pub fn did_key_from_jwk(jwk: &PublicKeyJwk) -> Option<String> {
    if jwk.kty != "EC" || jwk.crv != "P-256" {
        return None;
    }
    let x = URL_SAFE_NO_PAD.decode(&jwk.x).ok()?;
    let y = URL_SAFE_NO_PAD.decode(&jwk.y).ok()?;
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut payload = Vec::with_capacity(35);
    payload.extend_from_slice(&MULTICODEC_P256_PUB);
    payload.push(if y[31] & 1 == 1 { 3 } else { 2 });
    payload.extend_from_slice(&x);
    Some(format!("{DID_KEY_PREFIX}z{}", base58_encode(&payload)))
}

pub fn jwk_from_did_key(did: &str) -> Option<PublicKeyJwk> {
    let multibase = did.strip_prefix(DID_KEY_PREFIX)?.strip_prefix('z')?;
    let bytes = base58_decode(multibase)?;
    if bytes.len() != 35 || bytes[..2] != MULTICODEC_P256_PUB {
        return None;
    }
    // 曲線上にない点は from_sec1_bytes が拒む。
    let verifying = VerifyingKey::from_sec1_bytes(&bytes[2..]).ok()?;
    let point = verifying.to_encoded_point(false);
    Some(PublicKeyJwk {
        kty: "EC".into(),
        crv: "P-256".into(),
        x: URL_SAFE_NO_PAD.encode(point.x()?),
        y: URL_SAFE_NO_PAD.encode(point.y()?),
    })
}

/* ---------------------------------------------------------------- RFC 8785 */

fn utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// 正規化 JSON。キーは UTF-16 コード単位順、空白なし。数値と文字列は serde_json の既定の書き方
/// （ES の JSON.stringify と一致する範囲）。
pub fn jcs(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| utf16_cmp(left, right));
            let parts: Vec<String> = keys
                .into_iter()
                .map(|key| format!("{}:{}", Value::String(key.clone()), jcs(&map[key])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => format!("[{}]", items.iter().map(jcs).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

/* ---------------------------------------------------------------- Data Integrity ecdsa-jcs-2019 */

fn proof_config(document: &Map<String, Value>, did: &str, created: &str) -> Value {
    let mut config = Map::new();
    if let Some(context) = document.get("@context") {
        config.insert("@context".into(), context.clone());
    }
    config.insert("type".into(), json!("DataIntegrityProof"));
    config.insert("cryptosuite".into(), json!(CRYPTOSUITE));
    config.insert("created".into(), json!(created));
    let fragment = did.strip_prefix(DID_KEY_PREFIX).unwrap_or(did);
    config.insert("verificationMethod".into(), json!(format!("{did}#{fragment}")));
    config.insert("proofPurpose".into(), json!("assertionMethod"));
    Value::Object(config)
}

fn hash_data(document: &Map<String, Value>, config: &Value) -> Vec<u8> {
    let mut data = Sha256::digest(jcs(config).as_bytes()).to_vec();
    data.extend_from_slice(&Sha256::digest(jcs(&Value::Object(document.clone())).as_bytes()));
    data
}

/// 文書に proof を付けて返す。署名は `sign`（バイト列 → 64 バイトの r||s）に頼む。秘密鍵はここに来ない。
pub fn sign_document(
    sign: &dyn Fn(&[u8]) -> Option<[u8; 64]>,
    did: &str,
    document: Value,
    created: &str,
) -> Option<Value> {
    let mut plain = document.as_object()?.clone();
    plain.remove("proof");
    let config = proof_config(&plain, did, created);
    let signature = sign(&hash_data(&plain, &config))?;
    let mut proof = config.as_object()?.clone();
    proof.insert("proofValue".into(), json!(format!("z{}", base58_encode(&signature))));
    plain.insert("proof".into(), Value::Object(proof));
    Some(Value::Object(plain))
}

/// 検証する。expected_did を渡すと、その鍵の署名だけを通す。
pub fn verify_document(document: &Value, expected_did: Option<&str>) -> bool {
    let Some(object) = document.as_object() else { return false };
    let mut plain = object.clone();
    let Some(Value::Object(proof)) = plain.remove("proof") else { return false };
    let text = |key: &str| proof.get(key).and_then(Value::as_str);
    if text("type") != Some("DataIntegrityProof")
        || text("cryptosuite") != Some(CRYPTOSUITE)
        || text("proofPurpose") != Some("assertionMethod")
    {
        return false;
    }
    let (Some(method), Some(value), Some(_created)) = (text("verificationMethod"), text("proofValue"), text("created")) else {
        return false;
    };
    let mut parts = method.split('#');
    let did = parts.next().unwrap_or_default();
    let fragment = parts.next();
    if parts.next().is_some() || fragment.is_some_and(|f| Some(f) != did.strip_prefix(DID_KEY_PREFIX)) {
        return false;
    }
    if expected_did.is_some_and(|expected| expected != did) {
        return false;
    }
    let Some(jwk) = jwk_from_did_key(did) else { return false };
    let (Ok(x), Ok(y)) = (URL_SAFE_NO_PAD.decode(&jwk.x), URL_SAFE_NO_PAD.decode(&jwk.y)) else { return false };
    let mut point = [0_u8; 65];
    point[0] = 4;
    point[1..33].copy_from_slice(&x);
    point[33..].copy_from_slice(&y);
    let Ok(verifying) = VerifyingKey::from_sec1_bytes(&point) else { return false };
    let Some(signature_bytes) = value.strip_prefix('z').and_then(base58_decode) else { return false };
    let Ok(signature) = Signature::from_slice(&signature_bytes) else { return false };
    let config = Value::Object(proof.iter().filter(|(key, _)| key.as_str() != "proofValue").map(|(k, v)| (k.clone(), v.clone())).collect());
    verifying.verify(&hash_data(&plain, &config), &signature).is_ok()
}

/* ---------------------------------------------------------------- 署名してよい文書（この 2 種類だけ） */

fn http_url(value: &str) -> bool {
    value.len() <= 2048
        && (value.starts_with("https://") || value.starts_with("http://"))
        && !value.contains(['#', ' ', '\n'])
        && !value[value.find("://").map_or(0, |at| at + 3)..].split('/').next().unwrap_or_default().contains('@')
}

pub fn registration_statement(actor: &str, did: &str, issued_at: &str) -> Option<Value> {
    http_url(actor).then(|| {
        json!({
            "@context": [AS_CONTEXT, DATA_INTEGRITY_CONTEXT],
            "type": "HubRootKeyRegistration",
            "actor": actor,
            "rootKey": did,
            "issuedAt": issued_at,
        })
    })
}

pub fn move_statement(old_actor: &str, new_actor: &str, published: &str, id: &str) -> Option<Value> {
    (http_url(old_actor) && http_url(new_actor) && old_actor != new_actor && http_url(id)).then(|| {
        json!({
            "@context": [AS_CONTEXT, DATA_INTEGRITY_CONTEXT],
            "id": id,
            "type": "Move",
            "actor": old_actor,
            "object": old_actor,
            "target": new_actor,
            "published": published,
        })
    })
}

/* ---------------------------------------------------------------- Tauri コマンド */

fn guard(window: &tauri::Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !crate::local_pairing_address(window.label(), &url) {
        return Err("native_window_required".into());
    }
    Ok(())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 公開してよい根鍵。画面に「公開している根鍵」として出す。
#[tauri::command]
pub async fn portable_identity_public(
    window: tauri::Webview,
    runner: tauri::State<'_, Arc<crate::RunnerState>>,
) -> Result<Value, String> {
    guard(&window)?;
    let node = runner.node.as_ref().ok_or("portable_identity_unavailable")?;
    let (jwk, _) = node.public_identity().ok_or("portable_identity_unavailable")?;
    let did = did_key_from_jwk(&jwk).ok_or("portable_identity_unavailable")?;
    Ok(json!({ "didKey": did, "publicKeyJwk": jwk }))
}

/// 新しい家（または今の Hub）の actor に、この根鍵を公開するための登録文に署名する。
#[tauri::command]
pub async fn portable_identity_sign_registration(
    window: tauri::Webview,
    runner: tauri::State<'_, Arc<crate::RunnerState>>,
    actor_url: String,
) -> Result<Value, String> {
    guard(&window)?;
    let node = runner.node.as_ref().ok_or("portable_identity_unavailable")?;
    let (jwk, _) = node.public_identity().ok_or("portable_identity_unavailable")?;
    let did = did_key_from_jwk(&jwk).ok_or("portable_identity_unavailable")?;
    let issued = now_iso();
    let statement = registration_statement(&actor_url, &did, &issued).ok_or("invalid_actor_url")?;
    sign_document(&|data| node.sign_bytes(data), &did, statement, &issued).ok_or_else(|| "portable_identity_unavailable".into())
}

/// 移転宣言（actor = object = 旧 actor、target = 新 actor）に署名する。
#[tauri::command]
pub async fn portable_identity_sign_move(
    window: tauri::Webview,
    runner: tauri::State<'_, Arc<crate::RunnerState>>,
    old_actor: String,
    new_actor: String,
) -> Result<Value, String> {
    guard(&window)?;
    let node = runner.node.as_ref().ok_or("portable_identity_unavailable")?;
    let (jwk, _) = node.public_identity().ok_or("portable_identity_unavailable")?;
    let did = did_key_from_jwk(&jwk).ok_or("portable_identity_unavailable")?;
    let published = now_iso();
    let id = format!("{old_actor}/moves/{}", uuid::Uuid::new_v4());
    let statement = move_statement(&old_actor, &new_actor, &published, &id).ok_or("invalid_move")?;
    sign_document(&|data| node.sign_bytes(data), &did, statement, &published).ok_or_else(|| "portable_identity_unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node_identity::NodeKey;

    /// apps/hub/lib/portable-identity.test.ts と apps/federation/tests/portable-move.test.ts が検証する、Hub 側の署名ベクトル。
    const HUB_VECTOR: &str = r#"{"@context":["https://www.w3.org/ns/activitystreams","https://w3id.org/security/data-integrity/v2"],"id":"https://old.example/users/alice/moves/vector-1","type":"Move","actor":"https://old.example/users/alice","object":"https://old.example/users/alice","target":"https://new.example/users/alice","published":"2026-10-13T00:00:00.000Z","proof":{"@context":["https://www.w3.org/ns/activitystreams","https://w3id.org/security/data-integrity/v2"],"type":"DataIntegrityProof","cryptosuite":"ecdsa-jcs-2019","created":"2026-10-13T00:00:01.000Z","verificationMethod":"did:key:zDnaetdQB2SnQPcGgPpxPzMBYrbDoFvTZAktv7i3iLp8BtqNJ#zDnaetdQB2SnQPcGgPpxPzMBYrbDoFvTZAktv7i3iLp8BtqNJ","proofPurpose":"assertionMethod","proofValue":"z3y74AyJs9zQbJXNXBrTGtZdssr839bou9RWACBvgFMPtRaeJb3hzC4mZ3pLSvJG3cKWY6Fq1WTJTUdaecYECQZ3H"}}"#;
    const HUB_DID: &str = "did:key:zDnaetdQB2SnQPcGgPpxPzMBYrbDoFvTZAktv7i3iLp8BtqNJ";

    fn signer(key: &NodeKey) -> impl Fn(&[u8]) -> Option<[u8; 64]> + '_ {
        move |data| Some(key.sign_bytes(data))
    }

    #[test]
    fn verifies_a_proof_made_by_the_hub_typescript_signer() {
        let document: Value = serde_json::from_str(HUB_VECTOR).unwrap();
        assert!(verify_document(&document, Some(HUB_DID)));
    }

    #[test]
    fn rejects_the_hub_vector_after_any_change_or_under_another_key() {
        let mut document: Value = serde_json::from_str(HUB_VECTOR).unwrap();
        document["target"] = json!("https://evil.example/users/alice");
        assert!(!verify_document(&document, None));
        let original: Value = serde_json::from_str(HUB_VECTOR).unwrap();
        let other = did_key_from_jwk(&NodeKey::create().public_jwk()).unwrap();
        assert!(!verify_document(&original, Some(&other)));
    }

    #[test]
    fn did_key_round_trips_and_matches_the_published_p256_example() {
        let jwk = jwk_from_did_key("did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169").unwrap();
        assert_eq!(jwk.x, "fyNYMN0976ci7xqiSdag3buk-ZCwgXU4kz9XNkBlNUI");
        assert_eq!(did_key_from_jwk(&jwk).unwrap(), "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169");
        let key = NodeKey::create().public_jwk();
        let did = did_key_from_jwk(&key).unwrap();
        assert!(did.starts_with("did:key:zDn"));
        assert_eq!(jwk_from_did_key(&did).unwrap(), key);
    }

    #[test]
    fn a_document_it_signs_verifies_and_only_under_its_own_key() {
        let key = NodeKey::create();
        let did = did_key_from_jwk(&key.public_jwk()).unwrap();
        let statement = move_statement("https://a.example/users/x", "https://b.example/users/x", "2026-10-13T00:00:00.000Z", "https://a.example/users/x/moves/1").unwrap();
        let signed = sign_document(&signer(&key), &did, statement, "2026-10-13T00:00:01.000Z").unwrap();
        assert!(verify_document(&signed, Some(&did)));
        let other = did_key_from_jwk(&NodeKey::create().public_jwk()).unwrap();
        assert!(!verify_document(&signed, Some(&other)));
        let mut tampered = signed.clone();
        tampered["target"] = json!("https://evil.example/users/x");
        assert!(!verify_document(&tampered, Some(&did)));
    }

    #[test]
    fn prints_a_desktop_signature_for_the_hub_to_verify() {
        // cargo test emit_desktop -- --nocapture の出力を Hub / Federation の試験に貼って、逆向きの互換も縛れる。
        let key = NodeKey::create();
        let did = did_key_from_jwk(&key.public_jwk()).unwrap();
        let statement = registration_statement("https://a.example/users/x", &did, "2026-10-13T00:00:00.000Z").unwrap();
        let signed = sign_document(&signer(&key), &did, statement, "2026-10-13T00:00:00.000Z").unwrap();
        assert!(verify_document(&signed, Some(&did)));
        println!("DESKTOP_VECTOR {}", serde_json::to_string(&json!({ "did": did, "signed": signed })).unwrap());
    }

    #[test]
    fn jcs_sorts_keys_and_has_no_whitespace() {
        let value = json!({"b": 1, "a": [true, null, "x"], "c": {"z": 1, "y": 2}});
        assert_eq!(jcs(&value), r#"{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}"#);
    }

    #[test]
    fn it_only_builds_the_two_documents_it_is_allowed_to_sign() {
        assert!(registration_statement("javascript:alert(1)", "did:key:z", "t").is_none());
        assert!(registration_statement("https://user:pw@evil.example/x", "did:key:z", "t").is_none());
        assert!(move_statement("https://a.example/u", "https://a.example/u", "t", "https://a.example/u/moves/1").is_none());
        assert!(move_statement("https://a.example/u", "ftp://b.example/u", "t", "https://a.example/u/moves/1").is_none());
    }

    #[test]
    fn base58_keeps_leading_zero_bytes() {
        assert_eq!(base58_decode(&base58_encode(&[0, 0, 1, 2, 3])).unwrap(), vec![0, 0, 1, 2, 3]);
        assert_eq!(base58_encode(&[0, 0]), "11");
    }
}
