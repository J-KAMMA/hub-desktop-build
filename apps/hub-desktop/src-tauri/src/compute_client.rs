//! Compute の窓口。API は {hub}/compute/api/v1/*（Hubオリジン経由の
//! プロキシ）で、認証は `jkamma-compute` audience の assertion——
//! desktop_assertions の service=compute で発行する。
//!
//! 予約作成は資金枠を要る3段: compute assertion（funding_reference入り）
//! → payment assertion（compute_funding）→ commerce funding-grant →
//! 予約POST。窓から渡せるのはオファーIDと時間数だけで、金額や資産は
//! ここでオファーから組み立てる——窓が金額を作ることはない。

use serde_json::{json, Value};

/// 応答の上限。ジョブの出力テキスト程度なら十分。
const MAX_BYTES: usize = 1024 * 1024;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "接続を組み立てられません".to_owned())
}

/// パス区切りの識別子。compute の id 規則（英数_-）だけを通す。
fn ident(raw: &str, label: &str) -> Result<String, String> {
    let value = raw.trim();
    if !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(value.to_owned())
    } else {
        Err(format!("{label}の指定が正しくありません"))
    }
}

/// エラー応答の error フィールドを拾う。compute は {error:"code"} 形。
fn api_error(body: &Value) -> String {
    body.get("error")
        .and_then(|e| e.as_str())
        .unwrap_or("compute_error")
        .to_owned()
}

async fn send(
    request: reqwest::RequestBuilder,
) -> Result<Value, String> {
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "compute が応答しません".to_owned()
        } else {
            "compute へ届きません".to_owned()
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
    let value: Value =
        serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Default::default()));
    if !status.is_success() {
        return Err(api_error(&value));
    }
    Ok(value)
}

/// compute assertion を発行する。funding_reference は予約用のときだけ。
async fn compute_assertion(
    base: &str,
    funding_reference: Option<&str>,
) -> Result<String, String> {
    let mut extra = json!({ "service": "compute" });
    if let Some(reference) = funding_reference {
        extra["fundingReference"] = Value::String(reference.to_owned());
    }
    crate::desktop_account::assertion_with(base, extra).await
}

async fn authed(
    base: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    funding_grant: Option<&str>,
    funding_reference: Option<&str>,
) -> Result<Value, String> {
    let assertion = compute_assertion(base, funding_reference).await?;
    let url = format!("{}/compute/api/v1{}", base.trim_end_matches('/'), path);
    let mut request = client()?.request(method, url).bearer_auth(assertion);
    if let Some(grant) = funding_grant {
        request = request.header("x-compute-funding", grant);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    send(request).await
}

async fn public_get(base: &str, path: &str) -> Result<Value, String> {
    let url = format!("{}/compute/api/v1{}", base.trim_end_matches('/'), path);
    send(client()?.get(url)).await
}

/// 面の一覧用。公開情報（health・offers）と本人の予約をまとめて返す。
/// 未接続でも公開分だけ返し、reservations は空＋connected:false にする。
pub async fn status(base: &str) -> Result<Value, String> {
    let health = public_get(base, "/health").await.unwrap_or_else(|_| json!({}));
    let offers = public_get(base, "/offers").await.unwrap_or_else(|_| json!({ "offers": [] }));
    let reservations = match authed(base, reqwest::Method::GET, "/reservations", None, None, None).await
    {
        Ok(value) => Some(value),
        Err(_) => None,
    };
    Ok(json!({
        "health": health,
        "offers": offers.get("offers").cloned().unwrap_or(json!([])),
        "reservations": reservations
            .as_ref()
            .and_then(|v| v.get("reservations").cloned())
            .unwrap_or(json!([])),
        "connected": reservations.is_some(),
    }))
}

/// 無料デモ（大文字/小文字変換）。assertionだけで走る。
pub async fn demo(base: &str, text: &str, operation: &str) -> Result<Value, String> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 4000 {
        return Err("テキストは1〜4000字で入れてください".to_owned());
    }
    let operation = match operation {
        "lowercase" => "lowercase",
        _ => "uppercase",
    };
    authed(
        base,
        reqwest::Method::POST,
        "/demo/text",
        Some(json!({ "text": text, "operation": operation })),
        None,
        None,
    )
    .await
}

/// 予約作成。オファーから料率・資産・テンプレートをこちらで引くので、
/// 窓が渡すのは offerId・開始時刻・時間数だけ。上限課金額は
/// (予約料率+実行料率)×時間 でWeb版と同じ式。
pub async fn reserve(
    base: &str,
    offer_id: &str,
    starts_at_ms: u64,
    duration_hours: u64,
) -> Result<Value, String> {
    let offer_id = ident(offer_id, "オファー")?;
    if duration_hours == 0 || duration_hours > 24 {
        return Err("利用時間は1〜24時間で入れてください".to_owned());
    }
    let offers = public_get(base, "/offers").await?;
    let offer = offers
        .get("offers")
        .and_then(|o| o.as_array())
        .and_then(|list| list.iter().find(|o| o.get("id").and_then(|i| i.as_str()) == Some(offer_id.as_str())))
        .cloned()
        .ok_or_else(|| "オファーが見つかりません".to_owned())?;
    let reservation_rate = offer
        .get("minimum_reservation_rate_atomic")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u128>().ok())
        .ok_or_else(|| "オファーの料率が読めません".to_owned())?;
    let execution_rate = offer
        .get("minimum_rate_atomic")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u128>().ok())
        .ok_or_else(|| "オファーの料率が読めません".to_owned())?;
    let maximum_charge = (reservation_rate + execution_rate) * duration_hours as u128;
    let asset = offer
        .get("settlement_asset")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "オファーの資産が読めません".to_owned())?;
    let starts = std::time::UNIX_EPOCH + std::time::Duration::from_millis(starts_at_ms);
    let ends = starts + std::time::Duration::from_secs(duration_hours * 3600);
    let iso = |t: std::time::SystemTime| -> String {
        let secs = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        chrono::DateTime::from_timestamp(secs as i64, 0)
            .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
            .unwrap_or_default()
    };
    let ends_at = iso(ends);
    let funding_reference = format!("funding_{}", uuid::Uuid::new_v4().simple());
    // 1) funding_reference 入りの compute assertion
    let identity = compute_assertion(base, Some(&funding_reference)).await?;
    // 2) payment audience の資金枠 assertion
    let payment = crate::desktop_account::assertion_with(
        base,
        json!({
            "service": "compute_funding",
            "fundingReference": funding_reference,
            "maximumChargeAtomic": maximum_charge.to_string(),
            "asset": asset,
            "reservationEndsAt": ends_at,
        }),
    )
    .await?;
    // 3) commerce が grant を発行
    let grant_body = send(
        client()?
            .post(format!(
                "{}/shopping/api/commerce/api/v1/compute/funding-grants",
                base.trim_end_matches('/')
            ))
            .json(&json!({ "authorization": payment })),
    )
    .await?;
    let grant = grant_body
        .get("grant")
        .and_then(|g| g.as_str())
        .ok_or_else(|| api_error(&grant_body))?;
    // 4) 予約本体
    let reservation_id = format!("reservation_{}", uuid::Uuid::new_v4().simple());
    let body = json!({
        "reservationId": reservation_id,
        "offerId": offer_id,
        "templateId": offer.get("template_id").and_then(|v| v.as_str()).unwrap_or(""),
        "resourceClass": "cpu",
        "capacityUnits": 1,
        "startsAt": iso(starts),
        "endsAt": ends_at,
        "dispatchSeconds": offer.get("startup_seconds").and_then(|v| v.as_u64()).unwrap_or(60),
        "maximumReservationRateAtomic": offer.get("minimum_reservation_rate_atomic"),
        "maximumExecutionRateAtomic": offer.get("minimum_rate_atomic"),
        "settlementAsset": asset,
        "fundingReference": funding_reference,
    });
    let url = format!("{}/compute/api/v1/reservations", base.trim_end_matches('/'));
    send(client()?
        .post(url)
        .bearer_auth(identity)
        .header("x-compute-funding", grant)
        .json(&body))
    .await
}

/// 予約へテキストジョブを投げる。jobId はこちらで発行する（冪等キー）。
pub async fn submit_text(
    base: &str,
    reservation_id: &str,
    text: &str,
    operation: &str,
) -> Result<Value, String> {
    let reservation_id = ident(reservation_id, "予約")?;
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 4000 {
        return Err("テキストは1〜4000字で入れてください".to_owned());
    }
    let operation = match operation {
        "lowercase" => "lowercase",
        _ => "uppercase",
    };
    let job_id = format!("job_{}", uuid::Uuid::new_v4().simple());
    authed(
        base,
        reqwest::Method::POST,
        &format!("/reservations/{reservation_id}/jobs/text"),
        Some(json!({ "jobId": job_id, "text": text, "operation": operation })),
        None,
        None,
    )
    .await
}

/// 予約に紐づくジョブの状態と結果。
pub async fn reservation_job(base: &str, reservation_id: &str) -> Result<Value, String> {
    let reservation_id = ident(reservation_id, "予約")?;
    authed(
        base,
        reqwest::Method::GET,
        &format!("/reservations/{reservation_id}/job"),
        None,
        None,
        None,
    )
    .await
}

/// 予約のキャンセル。
pub async fn cancel_reservation(base: &str, reservation_id: &str) -> Result<Value, String> {
    let reservation_id = ident(reservation_id, "予約")?;
    authed(
        base,
        reqwest::Method::POST,
        &format!("/reservations/{reservation_id}/cancel"),
        None,
        None,
        None,
    )
    .await
}

/// ジョブの状態＋結果（認証済み本人のものだけ返る）。
pub async fn job(base: &str, job_id: &str) -> Result<Value, String> {
    let job_id = ident(job_id, "ジョブ")?;
    authed(
        base,
        reqwest::Method::GET,
        &format!("/jobs/{job_id}/result"),
        None,
        None,
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ident_accepts_compute_ids() {
        assert_eq!(ident("reservation_abc-123_x", "x").unwrap(), "reservation_abc-123_x");
        assert!(ident("bad/id", "x").is_err());
        assert!(ident("bad?id", "x").is_err());
        assert!(ident("", "x").is_err());
        assert!(ident(&"a".repeat(129), "x").is_err());
    }
}
