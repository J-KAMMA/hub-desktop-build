//! AI Tools の窓口。API は {hub}/ai/api/*（Hub オリジン経由で AI ワーカーへ
//! rewrite される）。カタログは公開 GET。実行系は x402 の exact 支払い:
//!
//!   初回 POST                  → 402 + PAYMENT-REQUIRED（base64 の JSON）
//!   窓が金額・宛先・内容を表示 → 本人が支払いを選ぶ
//!   pay_and_call               → Rust が EIP-3009 の typedData を組み、
//!                                desktop_wallet の確認モーダル経由で署名、
//!                                payment-signature を付けて同じ要求を再送
//!
//! 支払い要件（accepted）は形を検めてそのままエコーする——窓の入力は
//! 支払い文面に入らない。金額・資産・宛先・ネットワークはモーダルに実値で
//! 出す。バッチ決済（USDC の時間枠セッション）は未対応——ここでは exact
//! 方式だけを受け、それ以外の scheme は支払いに進めない。

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use tauri::AppHandle;

/// 応答の上限。画像生成は PNG の base64 が JSON で返る。
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// AI ワーカー側のプロンプト上限（MAX_PROMPT_CHARACTERS）に合わせる。
const MAX_PROMPT_CHARS: usize = 8_000;
/// 署名の有効窓。サーバ提示の maxTimeoutSeconds を上限として使う。
const MAX_TIMEOUT_SECONDS: i64 = 3_600;

fn client(seconds: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(seconds))
        .build()
        .map_err(|_| "取りに行けません".to_owned())
}

fn map_send(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "AIが応答しません".to_owned()
    } else if error.is_connect() {
        "AIへ接続できません".to_owned()
    } else {
        "AIへ届きません".to_owned()
    }
}

fn ai_url(base: &str, path: &str) -> String {
    format!("{}/ai/api{}", base.trim_end_matches('/'), path)
}

/// パスに載せてよい provider/tool id の形。カタログの id は小英字と -。
fn slug(value: &str) -> Option<&str> {
    let ok = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && value.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric());
    ok.then_some(value)
}

/// 動画トークンは `base64url.base64url` の署名付き形。
fn video_token(value: &str) -> Option<&str> {
    let ok = value.len() >= 16
        && value.len() <= 512
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    ok.then_some(value)
}

fn prompt(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_PROMPT_CHARS {
        return Err("プロンプトが不正です".to_owned());
    }
    Ok(trimmed.to_owned())
}

/// 実行対象から固定パスと本文を組む。kind 以外の形はここへ来られない。
enum Target {
    Tool { provider: String, tool: String },
    Image,
    Video,
    PaymentTest,
}

impl Target {
    fn path(&self) -> String {
        match self {
            Target::Tool { provider, tool } => {
                format!("/providers/{provider}/tools/{tool}")
            }
            Target::Image => "/media/image".to_owned(),
            Target::Video => "/media/video".to_owned(),
            Target::PaymentTest => "/payment-test".to_owned(),
        }
    }
}

fn target(
    kind: &str,
    provider_id: Option<&str>,
    tool_id: Option<&str>,
) -> Result<Target, String> {
    match kind {
        "tool" => Ok(Target::Tool {
            provider: slug(provider_id.unwrap_or(""))
                .ok_or_else(|| "プロバイダが不正です".to_owned())?
                .to_owned(),
            tool: slug(tool_id.unwrap_or(""))
                .ok_or_else(|| "ツールが不正です".to_owned())?
                .to_owned(),
        }),
        "image" => Ok(Target::Image),
        "video" => Ok(Target::Video),
        "payment_test" => Ok(Target::PaymentTest),
        _ => Err("実行対象が不正です".to_owned()),
    }
}

fn body_for(target: &Target, prompt_text: Option<String>, aspect: Option<&str>) -> Value {
    match target {
        Target::Tool { .. } => json!({ "prompt": prompt_text.unwrap_or_default() }),
        Target::Image | Target::Video => json!({
            "prompt": prompt_text.unwrap_or_default(),
            "aspectRatio": aspect.unwrap_or(if matches!(target, Target::Image) { "1:1" } else { "16:9" }),
        }),
        Target::PaymentTest => json!({}),
    }
}

/// POST を投げて結果を仕分ける。成功は result、402 は PAYMENT-REQUIRED を
/// 復号して渡し、それ以外は {error} を拾う。
async fn post(
    base: &str,
    target: &Target,
    body: Value,
    payment_signature: Option<&str>,
) -> Result<Value, String> {
    let mut request = client(120)?
        .post(ai_url(base, &target.path()))
        .header("content-type", "application/json")
        .body(body.to_string());
    if let Some(signature) = payment_signature {
        request = request.header("payment-signature", signature);
    }
    let response = request.send().await.map_err(map_send)?;
    let status = response.status();
    if status == reqwest::StatusCode::PAYMENT_REQUIRED {
        let required = response
            .headers()
            .get("payment-required")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| B64.decode(v).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        return Ok(json!({
            "status": "payment_required",
            "required": required.unwrap_or(Value::Null),
        }));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "読み取れませんでした".to_owned())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    let parsed = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(json!({ "status": "ok", "result": parsed }));
    }
    Ok(json!({
        "status": "error",
        "code": status.as_u16(),
        "error": parsed.get("error").and_then(|e| e.as_str()).unwrap_or("request_failed"),
    }))
}

/// 公開カタログ。プロバイダ・ツール・支払いオプションをそのまま渡す。
pub async fn catalog(base: &str) -> Result<Value, String> {
    let response = client(15)?
        .get(ai_url(base, "/catalog"))
        .send()
        .await
        .map_err(map_send)?;
    if !response.status().is_success() {
        return Err(format!("AIが {} を返しています", response.status().as_u16()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "読み取れませんでした".to_owned())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    serde_json::from_slice::<Value>(&bytes).map_err(|_| "読み取れませんでした".to_owned())
}

/// 支払いなしの実行。402 なら payment_required と要件を返す。
pub async fn call(
    base: &str,
    kind: &str,
    provider_id: Option<&str>,
    tool_id: Option<&str>,
    prompt_text: &str,
    aspect_ratio: Option<&str>,
) -> Result<Value, String> {
    let target = target(kind, provider_id, tool_id)?;
    let prompt_value = match target {
        Target::PaymentTest => None,
        _ => Some(prompt(prompt_text)?),
    };
    let aspect = match aspect_ratio {
        Some("1:1") | Some("16:9") | Some("9:16") => aspect_ratio,
        _ => None,
    };
    post(base, &target, body_for(&target, prompt_value, aspect), None).await
}

/// 動画の進行確認。トークンは支払い済みの結果としてサーバが発行する。
pub async fn video_status(base: &str, token: &str) -> Result<Value, String> {
    let token = video_token(token).ok_or_else(|| "トークンが不正です".to_owned())?;
    let response = client(15)?
        .get(ai_url(base, &format!("/media/video/{token}")))
        .send()
        .await
        .map_err(map_send)?;
    if !response.status().is_success() {
        return Err(format!("AIが {} を返しています", response.status().as_u16()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "読み取れませんでした".to_owned())?;
    serde_json::from_slice::<Value>(&bytes).map_err(|_| "読み取れませんでした".to_owned())
}

/// 完成した動画の中身。生バイトを返し、窓は blob: の <video> に乗せる。
const MAX_VIDEO_BYTES: u64 = 128 * 1024 * 1024;
pub async fn video_content(base: &str, token: &str) -> Result<Vec<u8>, String> {
    let token = video_token(token).ok_or_else(|| "トークンが不正です".to_owned())?;
    let response = client(120)?
        .get(ai_url(base, &format!("/media/video/{token}/content")))
        .send()
        .await
        .map_err(map_send)?;
    if !response.status().is_success() {
        return Err(format!("AIが {} を返しています", response.status().as_u16()));
    }
    if response.content_length().unwrap_or(0) > MAX_VIDEO_BYTES {
        return Err("動画が大きすぎます".to_owned());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "読み取れませんでした".to_owned())?;
    if bytes.len() as u64 > MAX_VIDEO_BYTES {
        return Err("動画が大きすぎます".to_owned());
    }
    Ok(bytes.to_vec())
}

// ---------------------------------------------------------------- 支払い

struct Accepted {
    raw: Value,
    network: String,
    chain_id: u64,
    asset: String,
    amount: String,
    pay_to: String,
    timeout: i64,
    domain_name: String,
    domain_version: String,
}

fn address(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (text.len() == 42
        && text.starts_with("0x")
        && text[2..].bytes().all(|b| b.is_ascii_hexdigit()))
    .then(|| text.to_lowercase())
}

/// 402 の accepts 1件を検める。exact の EIP-3009 に必要な項目だけを受け、
/// それ以外の scheme・壊れた形はここで捨てる。extra.name/version は
/// EIP-712 ドメインに必須なので無いものは支払えない。
fn accepted_requirements(value: &Value) -> Result<Accepted, String> {
    let invalid = || "payment_requirements_invalid".to_owned();
    let obj = value.as_object().ok_or_else(invalid)?;
    if obj.get("scheme").and_then(|s| s.as_str()) != Some("exact") {
        return Err("payment_scheme_unsupported".to_owned());
    }
    let network = obj
        .get("network")
        .and_then(|n| n.as_str())
        .filter(|n| n.len() <= 20)
        .ok_or_else(invalid)?;
    let chain_id = network
        .strip_prefix("eip155:")
        .and_then(|id| id.parse::<u64>().ok())
        .ok_or_else(invalid)?;
    let amount = obj
        .get("amount")
        .and_then(|a| a.as_str())
        .filter(|a| !a.is_empty() && a.len() <= 30 && a.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(invalid)?;
    let timeout = obj
        .get("maxTimeoutSeconds")
        .and_then(|t| t.as_i64())
        .filter(|t| *t > 0 && *t <= MAX_TIMEOUT_SECONDS)
        .ok_or_else(invalid)?;
    let extra = obj.get("extra").and_then(|e| e.as_object()).ok_or_else(invalid)?;
    let domain_name = extra
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(invalid)?;
    let domain_version = extra
        .get("version")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(invalid)?;
    Ok(Accepted {
        raw: value.clone(),
        network: network.to_owned(),
        chain_id,
        asset: address(obj.get("asset").ok_or_else(invalid)?).ok_or_else(invalid)?,
        amount: amount.to_owned(),
        pay_to: address(obj.get("payTo").ok_or_else(invalid)?).ok_or_else(invalid)?,
        timeout,
        domain_name: domain_name.to_owned(),
        domain_version: domain_version.to_owned(),
    })
}

fn hex_nonce() -> String {
    let bytes: [u8; 32] = rand::random();
    let mut out = String::with_capacity(66);
    out.push_str("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// TransferWithAuthorization の typedData。authorizationTypes と同じ宣言順。
fn payment_typed_data(req: &Accepted, from: &str, nonce: &str, valid_before: i64) -> Value {
    json!({
        "types": {
            "EIP712Domain": [
                { "name": "name", "type": "string" },
                { "name": "version", "type": "string" },
                { "name": "chainId", "type": "uint256" },
                { "name": "verifyingContract", "type": "address" }
            ],
            "TransferWithAuthorization": [
                { "name": "from", "type": "address" },
                { "name": "to", "type": "address" },
                { "name": "value", "type": "uint256" },
                { "name": "validAfter", "type": "uint256" },
                { "name": "validBefore", "type": "uint256" },
                { "name": "nonce", "type": "bytes32" }
            ]
        },
        "primaryType": "TransferWithAuthorization",
        "domain": {
            "name": req.domain_name,
            "version": req.domain_version,
            "chainId": req.chain_id,
            "verifyingContract": req.asset,
        },
        "message": {
            "from": from,
            "to": req.pay_to,
            "value": req.amount,
            "validAfter": "0",
            "validBefore": valid_before.to_string(),
            "nonce": nonce,
        }
    })
}

/// 支払い付き実行。accepted は 402 の requirements をそのまま受け取る。
/// 確認モーダルに実値を出し、承認で EIP-3009 に署名して再送する。
/// display は窓がカタログの decimals から組んだ人間向け表記（表示専用）。
pub async fn pay_and_call(
    app: &AppHandle,
    base: &str,
    kind: &str,
    provider_id: Option<&str>,
    tool_id: Option<&str>,
    prompt_text: &str,
    aspect_ratio: Option<&str>,
    accepted: &Value,
    display: &str,
    description: &str,
) -> Result<Value, String> {
    let requirement = accepted_requirements(accepted)?;
    let target = target(kind, provider_id, tool_id)?;
    let prompt_value = match target {
        Target::PaymentTest => None,
        _ => Some(prompt(prompt_text)?),
    };
    let aspect = match aspect_ratio {
        Some("1:1") | Some("16:9") | Some("9:16") => aspect_ratio,
        _ => None,
    };
    let from = crate::desktop_wallet::wallet_address()?;
    let nonce = hex_nonce();
    let valid_before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        + requirement.timeout;
    let typed_data = payment_typed_data(&requirement, &from, &nonce, valid_before);
    // モーダルに載る任意文字列は切る——表示専用で署名の対象には入らない。
    let clip = |value: &str, max: usize| value.chars().take(max).collect::<String>();
    let detail = format!(
        "内容: {}\n支払額: {}\n資産: {}\nネットワーク: {}\n支払い先: {}\n送る側: {from}\n金額（原子単位）: {}",
        clip(description, 200), clip(display, 64),
        requirement.asset, requirement.network, requirement.pay_to, requirement.amount,
    );
    let signature = crate::desktop_wallet::sign_typed_data_purpose(
        app,
        "AI 利用料の支払い",
        &detail,
        &typed_data,
    )
    .await?;
    let payload = json!({
        "x402Version": 2,
        "accepted": requirement.raw,
        "payload": {
            "signature": signature,
            "authorization": {
                "from": from,
                "to": requirement.pay_to,
                "value": requirement.amount,
                "validAfter": "0",
                "validBefore": valid_before.to_string(),
                "nonce": nonce,
            }
        }
    });
    let header = B64.encode(payload.to_string());
    let outcome = post(base, &target, body_for(&target, prompt_value, aspect), Some(&header)).await?;
    // 再送も 402 なら検収・決済が拒否された——理由をそのまま窓へ返す。
    if outcome.get("status").and_then(|s| s.as_str()) == Some("payment_required") {
        let reason = outcome
            .pointer("/required/error")
            .and_then(|e| e.as_str())
            .unwrap_or("payment_rejected");
        return Ok(json!({ "status": "error", "code": 402, "error": reason }));
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn exact_requirements() -> Value {
        json!({
            "scheme": "exact",
            "network": "eip155:1001",
            "asset": "0x5B0a04F03D5f3Be9B53E1ab0A82e7b97Cb111111",
            "amount": "150000000000000000000",
            "payTo": "0x2222222222222222222222222222222222222222",
            "maxTimeoutSeconds": 300,
            "extra": { "name": "JPY Coin", "version": "1" }
        })
    }

    #[test]
    fn accepted_requirements_takes_exact_eip3009() {
        let req = accepted_requirements(&exact_requirements()).expect("valid");
        assert_eq!(req.chain_id, 1001);
        assert_eq!(req.network, "eip155:1001");
        assert_eq!(req.pay_to, "0x2222222222222222222222222222222222222222");
        assert_eq!(req.amount, "150000000000000000000");
    }

    #[test]
    fn accepted_requirements_rejects_other_schemes() {
        for scheme in ["batch-settlement", "upto", "deferred"] {
            let mut value = exact_requirements();
            value["scheme"] = json!(scheme);
            assert_eq!(
                accepted_requirements(&value).err().as_deref(),
                Some("payment_scheme_unsupported")
            );
        }
    }

    #[test]
    fn accepted_requirements_rejects_bad_shape() {
        let mut missing_name = exact_requirements();
        missing_name["extra"] = json!({ "version": "1" });
        assert!(accepted_requirements(&missing_name).is_err());

        let mut bad_asset = exact_requirements();
        bad_asset["asset"] = json!("not-an-address");
        assert!(accepted_requirements(&bad_asset).is_err());

        let mut bad_payto = exact_requirements();
        bad_payto["payTo"] = json!("0x1234");
        assert!(accepted_requirements(&bad_payto).is_err());

        let mut bad_amount = exact_requirements();
        bad_amount["amount"] = json!("-5");
        assert!(accepted_requirements(&bad_amount).is_err());
        bad_amount["amount"] = json!("1e18");
        assert!(accepted_requirements(&bad_amount).is_err());

        let mut bad_network = exact_requirements();
        bad_network["network"] = json!("ethereum:mainnet");
        assert!(accepted_requirements(&bad_network).is_err());

        let mut bad_timeout = exact_requirements();
        bad_timeout["maxTimeoutSeconds"] = json!(0);
        assert!(accepted_requirements(&bad_timeout).is_err());
        bad_timeout["maxTimeoutSeconds"] = json!(MAX_TIMEOUT_SECONDS + 1);
        assert!(accepted_requirements(&bad_timeout).is_err());
    }

    #[test]
    fn slug_validates_path_segments() {
        assert!(slug("openai").is_some());
        assert!(slug("workers-ai").is_some());
        assert!(slug("").is_none());
        assert!(slug("../admin").is_none());
        assert!(slug("UPPER").is_none());
        assert!(slug(&"a".repeat(65)).is_none());
    }

    #[test]
    fn prompt_enforces_bounds() {
        assert!(prompt("  hello  ").is_ok());
        assert_eq!(prompt("hello").unwrap(), "hello");
        assert!(prompt("   ").is_err());
        assert!(prompt(&"x".repeat(MAX_PROMPT_CHARS + 1)).is_err());
        assert!(prompt(&"x".repeat(MAX_PROMPT_CHARS)).is_ok());
    }

    #[test]
    fn payment_typed_data_matches_eip3009_shape() {
        let req = accepted_requirements(&exact_requirements()).unwrap();
        let typed = payment_typed_data(&req, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0x11", 1_700_000_000);
        assert_eq!(typed["primaryType"], "TransferWithAuthorization");
        assert_eq!(typed["domain"]["chainId"], json!(1001u64));
        assert_eq!(typed["domain"]["verifyingContract"], json!(req.asset));
        assert_eq!(typed["domain"]["name"], json!("JPY Coin"));
        let message = &typed["message"];
        assert_eq!(message["to"], json!(req.pay_to));
        assert_eq!(message["value"], json!(req.amount));
        assert_eq!(message["validAfter"], json!("0"));
        assert_eq!(message["validBefore"], json!("1700000000"));
        assert_eq!(typed["types"]["TransferWithAuthorization"].as_array().map(Vec::len), Some(6));
    }

    #[test]
    fn video_token_shape() {
        assert!(video_token("abcDEF123_-abc.XYZ_789-def").is_some());
        assert!(video_token("").is_none());
        assert!(video_token("short").is_none());
        assert!(video_token("has space.token").is_none());
        assert!(video_token(&"a".repeat(513)).is_none());
    }
}
