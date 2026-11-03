//! 自分の Music トラックを Hub のプロフィールに表示するための窓口（2026-11-03、docs/hub-music-attribution/DESIGN.md）。
//! 認証は `jkamma-music` audience の `music_manage` assertion——desktop assertions の service=music で発行する
//! （jkamma-music のサービスリンクが既にあるときだけ。無ければ music_link_required）。Music は jti の使い回しを禁じるので、
//! 要求ごとに新しい assertion を取る。assertion は変数に持つだけで、ログにもディスクにも出さない。
//! Hub を通らない：窓 → この Rust → `{hub}/music/api/*`（エッジで Music ワーカーへ）。
//! 窓から来るのはトラックID（UUID）と Hub の問いかけ（22字）だけで、URL もヘッダも全部ここで組み立てる。

use serde_json::{json, Value};

const MAX_BYTES: usize = 2 * 1024 * 1024;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "接続を組み立てられません".to_owned())
}

/// 問いかけは Hub が出す 22 字の base64url。それ以外は送らない。
pub fn challenge_valid(challenge: &str) -> bool {
    challenge.len() == 22
        && challenge
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

/// トラックIDは UUID（36字・ハイフン区切り）だけ。
pub fn track_id_valid(track_id: &str) -> bool {
    track_id.len() == 36 && uuid::Uuid::parse_str(track_id).is_ok()
}

pub fn uploads_url(base: &str) -> String {
    format!("{}/music/api/uploads", base.trim_end_matches('/'))
}

pub fn proof_url(base: &str) -> String {
    format!("{}/music/api/attribution/v1/proof", base.trim_end_matches('/'))
}

/// 証明の要求本文。キーは Music が求める trackId と challenge の2つだけ。
pub fn proof_body(track_id: &str, challenge: &str) -> Result<Value, String> {
    if !track_id_valid(track_id) || !challenge_valid(challenge) {
        return Err("attribution_input_invalid".to_owned());
    }
    Ok(json!({ "trackId": track_id, "challenge": challenge }))
}

/// 自分のアップロード一覧から「公開中でスキャン済み」のIDだけ取り出す。
/// 最終判断（処理済み・非表示でない）は証明を出す Music が行う——これは表示の出し分け用。
pub fn eligible_ids(uploads: &Value) -> Vec<String> {
    uploads
        .get("uploads")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|row| {
                    row.get("publicationStatus").and_then(Value::as_str) == Some("published")
                        && row.get("scanStatus").and_then(Value::as_str) == Some("clean")
                })
                .filter_map(|row| row.get("id").and_then(Value::as_str))
                .filter(|id| track_id_valid(id))
                .map(str::to_owned)
                .take(100)
                .collect()
        })
        .unwrap_or_default()
}

/// 証明（JWS 風の3区画）だけを取り出す。形が違えば渡さない。
pub fn proof_from(body: &Value) -> Result<String, String> {
    let proof = body
        .get("proof")
        .and_then(Value::as_str)
        .filter(|proof| {
            !proof.is_empty()
                && proof.len() <= 4096
                && proof.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
                && proof.bytes().filter(|c| *c == b'.').count() == 2
        })
        .ok_or("attribution_proof_missing")?;
    Ok(proof.to_owned())
}

fn api_error(body: &Value) -> String {
    body.get("error")
        .and_then(Value::as_str)
        .filter(|code| !code.is_empty() && code.len() <= 64)
        .unwrap_or("music_request_failed")
        .to_owned()
}

async fn music_assertion(base: &str) -> Result<String, String> {
    crate::desktop_account::assertion_with(base, json!({ "service": "music" })).await
}

async fn send(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "Music が応答しません".to_owned()
        } else {
            "Music へ届きません".to_owned()
        }
    })?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|_| "受け取れませんでした".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    let value: Value = serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Default::default()));
    if !status.is_success() {
        return Err(api_error(&value));
    }
    Ok(value)
}

/// 自分の曲のうち、プロフィールに表示できる候補のID。
pub async fn own_eligible_ids(base: &str) -> Result<Value, String> {
    let assertion = music_assertion(base).await?;
    let value = send(client()?.get(uploads_url(base)).bearer_auth(assertion)).await?;
    Ok(json!({ "ids": eligible_ids(&value) }))
}

/// 証明を取る。Origin は付けない（Music はネイティブの Bearer をこの経路だけ受ける）。
pub async fn attribution_proof(base: &str, track_id: &str, challenge: &str) -> Result<Value, String> {
    let body = proof_body(track_id, challenge)?;
    let assertion = music_assertion(base).await?;
    let value = send(client()?.post(proof_url(base)).bearer_auth(assertion).json(&body)).await?;
    Ok(json!({ "proof": proof_from(&value)? }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "11111111-1111-4111-8111-111111111111";
    const CHALLENGE: &str = "AAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn urls_are_fixed_music_paths() {
        assert_eq!(uploads_url("https://hub.example/"), "https://hub.example/music/api/uploads");
        assert_eq!(
            proof_url("https://hub.example"),
            "https://hub.example/music/api/attribution/v1/proof"
        );
    }

    #[test]
    fn proof_body_has_exactly_two_keys_and_closed_inputs() {
        let body = proof_body(ID, CHALLENGE).unwrap();
        let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["challenge", "trackId"]);
        for bad_id in ["", "music:x", "../x", &format!("{ID}/x"), "11111111111141118111111111111111"] {
            assert!(proof_body(bad_id, CHALLENGE).is_err(), "{bad_id}");
        }
        for bad in ["", "short", "AAAAAAAAAAAAAAAAAAAAA=", "AAAAAAAAAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAA/AA"] {
            assert!(proof_body(ID, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn eligible_ids_keep_only_published_clean_uuid_rows() {
        let other = "22222222-2222-4222-8222-222222222222";
        let list = json!({ "uploads": [
            { "id": ID, "publicationStatus": "published", "scanStatus": "clean" },
            { "id": other, "publicationStatus": "draft", "scanStatus": "clean" },
            { "id": "33333333-3333-4333-8333-333333333333", "publicationStatus": "published", "scanStatus": "pending" },
            { "id": "not-a-uuid", "publicationStatus": "published", "scanStatus": "clean" },
            { "publicationStatus": "published", "scanStatus": "clean" },
        ] });
        assert_eq!(eligible_ids(&list), [ID]);
        assert!(eligible_ids(&json!({})).is_empty());
        assert!(eligible_ids(&json!({ "uploads": "x" })).is_empty());
    }

    #[test]
    fn proof_must_be_three_dotted_segments() {
        assert_eq!(proof_from(&json!({ "proof": "a.b.c", "expiresAt": 1 })).unwrap(), "a.b.c");
        for bad in [json!({}), json!({ "proof": "" }), json!({ "proof": "a.b" }), json!({ "proof": "a.b.c.d" }),
            json!({ "proof": "a b.c.d" }), json!({ "proof": 3 }), json!({ "proof": "a.".repeat(3000) })] {
            assert!(proof_from(&bad).is_err());
        }
    }

    #[test]
    fn errors_are_codes_and_never_the_body() {
        assert_eq!(api_error(&json!({ "error": "music_link_required" })), "music_link_required");
        assert_eq!(api_error(&json!({ "error": "x".repeat(65) })), "music_request_failed");
        assert_eq!(api_error(&json!({ "message": "token abc" })), "music_request_failed");
    }

    #[test]
    fn source_never_logs_or_stores_the_assertion() {
        let source = include_str!("music_attribution.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["println!", "eprintln!", "log::", "tracing::", "std::fs", "dbg!"] {
            assert!(!production.contains(forbidden), "{forbidden}");
        }
    }
}
