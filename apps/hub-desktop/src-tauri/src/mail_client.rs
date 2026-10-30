//! Mail の窓口。API は {hub}/mail/api/*（Hub オリジン経由で Mail ワーカーへ
//! rewrite される。next.config.mjs の /mail/api/:path* 参照）。
//! 認証は `jkamma-mail` audience の assertion——desktop assertions の
//! service=mail で発行する。ワーカーは jti の使い回しを禁じている
//! （MailAssertionReplay）ので、要求ごとに新しい assertion を取る。
//!
//! 窓の CSP は緩めない。URL・本文・認証ヘッダは全部ここで組み立て、
//! 窓から来るのはフォルダ名・UUID形の識別子・本文テキストだけ。
//! メールの中身はディスクへ置かない——例外は本人が保存先を選んだ
//! 添付の書き出しだけ（lib.rs の mail_attachment_download）。

use serde_json::{json, Value};

/// 応答の上限。一覧・本文・確認応答はワーカー側でも切られている。
const MAX_BYTES: usize = 2 * 1024 * 1024;
/// 添付の上限。ワーカーの生メール上限（25MB）に揃える。
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
/// 本文の上限。ワーカーの MAX_BODY_CHARS と同じ。
const MAX_BODY_CHARS: usize = 100_000;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "接続を組み立てられません".to_owned())
}

/// パス区切りの識別子。メール系の id は全部 UUID 形——それ以外は
/// テンプレートへ入れないので、窓がURLを組み立てる余地はない。
fn mail_id(raw: &str, label: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.len() == 36 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        Ok(value.to_owned())
    } else {
        Err(format!("{label}の指定が正しくありません"))
    }
}

/// フォルダ名は閉じた5つだけ。知らない名前は受けない。
fn folder_name(raw: &str) -> Result<&'static str, String> {
    match raw {
        "inbox" => Ok("inbox"),
        "sent" => Ok("sent"),
        "archive" => Ok("archive"),
        "trash" => Ok("trash"),
        "spam" => Ok("spam"),
        _ => Err("フォルダの指定が正しくありません".to_owned()),
    }
}

/// メッセージ操作も閉じた集合。ワーカーの PATCH 動詞と同じ6つ。
fn message_action_name(raw: &str) -> Result<&'static str, String> {
    match raw {
        "read" => Ok("read"),
        "unread" => Ok("unread"),
        "archive" => Ok("archive"),
        "trash" => Ok("trash"),
        "spam" => Ok("spam"),
        "inbox" => Ok("inbox"),
        _ => Err("操作の指定が正しくありません".to_owned()),
    }
}

/// ローカル部はワーカーの LOCAL_PART と同じ形。小文字化はワーカー側も
/// やるので、ここでも揃えてから形を見る。
fn local_part(raw: &str) -> Result<String, String> {
    let value = raw.trim().to_lowercase();
    let bytes = value.as_bytes();
    let body_ok = bytes.iter().all(|b| {
        b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(*b, b'.' | b'_' | b'-')
    });
    let edge_ok = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    // ワーカーの LOCAL_PART は ^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$ ——
    // 1文字か3文字以上だけを通す（2文字は正規表現上あり得ない）。
    if !value.is_empty()
        && bytes.len() != 2
        && bytes.len() <= 32
        && body_ok
        && edge_ok(bytes[0])
        && edge_ok(bytes[bytes.len() - 1])
    {
        Ok(value)
    } else {
        Err("アドレスの指定が正しくありません".to_owned())
    }
}

/// 宛先の外形だけを見る。最終判定はワーカーの EMAIL 正規表現——
/// ここでは制御文字・空白の混入と異常な長さを止める。
fn recipient(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.len() >= 3
        && value.len() <= 320
        && value.contains('@')
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        Ok(value.to_owned())
    } else {
        Err("宛先の指定が正しくありません".to_owned())
    }
}

/// 件名・本文は長さだけ揃える（ワーカーの cleanText が最終形を作る）。
fn trimmed(raw: &str, label: &str, max: usize) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(format!("{label}が正しくありません"));
    }
    Ok(value.chars().take(max).collect())
}

/// エラー応答の error フィールドを拾う。mail は {error:"code"} 形——
/// mail_link_required や mailbox_required を窓が区別できるよう、
/// コードをそのまま返す。
fn api_error(body: &Value) -> String {
    body.get("error")
        .and_then(|e| e.as_str())
        .filter(|code| !code.is_empty() && code.len() <= 64)
        .unwrap_or("mail_request_failed")
        .to_owned()
}

async fn send(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "メールが応答しません".to_owned()
        } else {
            "メールへ届きません".to_owned()
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
    // PATCH 等は 204 の空応答で返る。空は Null として扱い、
    // JSONでない異常な本文も読み込み失敗ではなく既定値に退ける。
    let value: Value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Default::default()))
    };
    if !status.is_success() {
        return Err(api_error(&value));
    }
    Ok(value)
}

/// 要求ごとに新しい mail assertion。jti が一度しか使えないので
/// 使い回しはできない——この往復自体がワーカーの設計。
async fn mail_assertion(base: &str) -> Result<String, String> {
    crate::desktop_account::assertion_with(base, json!({ "service": "mail" })).await
}

async fn authed(
    base: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let assertion = mail_assertion(base).await?;
    let url = format!("{}/mail/api{}", base.trim_end_matches('/'), path);
    let mut request = client()?.request(method, url).bearer_auth(assertion);
    if let Some(body) = body {
        request = request.json(&body);
    }
    send(request).await
}

/// このアカウントのメールボックス。無いときは mailbox:null で返し、
/// 窓が「作成カードを出す」と判断できるようにする。
pub async fn mailbox(base: &str) -> Result<Value, String> {
    let value = authed(base, reqwest::Method::GET, "/mailboxes", None).await?;
    let first = value
        .get("mailboxes")
        .and_then(|m| m.as_array())
        .and_then(|list| list.first())
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({ "mailbox": first }))
}

/// メールボックスの作成。localPart はここでも形を見てから送る。
pub async fn create_mailbox(base: &str, raw_local_part: &str) -> Result<Value, String> {
    let local_part = local_part(raw_local_part)?;
    authed(
        base,
        reqwest::Method::POST,
        "/mailboxes",
        Some(json!({ "localPart": local_part })),
    )
    .await
}

/// 一覧。ページングのキーはワーカーでは before（createdAt の境界値）。
/// 窓の引数名は cursor のまま、載せる名前だけここで before に写す。
pub async fn messages(
    base: &str,
    folder: &str,
    cursor: Option<&str>,
) -> Result<Value, String> {
    let folder = folder_name(folder)?;
    let mut url = reqwest::Url::parse(&format!(
        "{}/mail/api/messages",
        base.trim_end_matches('/')
    ))
    .map_err(|_| "メールの接続先が正しくありません".to_owned())?;
    url.query_pairs_mut().append_pair("folder", folder);
    if let Some(before) = cursor
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 200)
    {
        url.query_pairs_mut().append_pair("before", before);
    }
    let assertion = mail_assertion(base).await?;
    send(client()?.get(url).bearer_auth(assertion)).await
}

/// 1件の本文＋添付の一覧。
pub async fn message(base: &str, message_id: &str) -> Result<Value, String> {
    let id = mail_id(message_id, "メール")?;
    authed(base, reqwest::Method::GET, &format!("/messages/{id}"), None).await
}

/// 既読化・移動。action は閉じた6動詞だけ。
pub async fn message_action(
    base: &str,
    message_id: &str,
    action: &str,
) -> Result<Value, String> {
    let id = mail_id(message_id, "メール")?;
    let action = message_action_name(action)?;
    authed(
        base,
        reqwest::Method::PATCH,
        &format!("/messages/{id}"),
        Some(json!({ "action": action })),
    )
    .await
}

/// 新規メールの送信前確認。preview は送る内容の人向け提示で、
/// これ自体はまだ送らない（ワーカーの send intent）。
pub async fn compose_preview(
    base: &str,
    to: &str,
    subject: &str,
    text: &str,
) -> Result<Value, String> {
    authed(
        base,
        reqwest::Method::POST,
        "/messages/preview",
        Some(json!({
            "to": recipient(to)?,
            "subject": trimmed(subject, "件名", 998)?,
            "text": trimmed(text, "本文", MAX_BODY_CHARS)?,
        })),
    )
    .await
}

/// 確認済み preview の送信。previewId と idempotencyKey は
/// サーバー発行・窓発行の UUID だけを通す。
pub async fn compose_send(
    base: &str,
    preview_id: &str,
    idempotency_key: &str,
) -> Result<Value, String> {
    authed(
        base,
        reqwest::Method::POST,
        "/messages/send",
        Some(json!({
            "previewId": mail_id(preview_id, "確認内容")?,
            "idempotencyKey": mail_id(idempotency_key, "送信キー")?,
        })),
    )
    .await
}

/// 返信の送信前確認。宛先・件名・スレッドはワーカーが元メールから
/// 組み立てるので、窓から送るのは本文だけ。
pub async fn reply_preview(base: &str, message_id: &str, text: &str) -> Result<Value, String> {
    let id = mail_id(message_id, "メール")?;
    authed(
        base,
        reqwest::Method::POST,
        &format!("/messages/{id}/reply/preview"),
        Some(json!({ "text": trimmed(text, "本文", MAX_BODY_CHARS)? })),
    )
    .await
}

/// 返信の送信。パスの id が preview の replyToMessageId と
/// 一致することはワーカー側で照合される（preview_mismatch）。
pub async fn reply_send(
    base: &str,
    message_id: &str,
    preview_id: &str,
    idempotency_key: &str,
) -> Result<Value, String> {
    let id = mail_id(message_id, "メール")?;
    authed(
        base,
        reqwest::Method::POST,
        &format!("/messages/{id}/reply"),
        Some(json!({
            "previewId": mail_id(preview_id, "確認内容")?,
            "idempotencyKey": mail_id(idempotency_key, "送信キー")?,
        })),
    )
    .await
}

/// 下書きは未確定の入力——宛先・件名・本文は空のまま保存できる。
/// 空でない宛先だけ形を見て、空なら空文字を送る（ワーカーも同じ受け方）。
fn draft_recipient(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        Ok(String::new())
    } else {
        recipient(value)
    }
}

/// 下書き一覧。新しい順でワーカーが切る（最大100件）。
pub async fn drafts(base: &str) -> Result<Value, String> {
    authed(base, reqwest::Method::GET, "/drafts", None).await
}

/// 下書きの新規保存・上書き。id は窓発行のUUID——同じidへのPUTが更新。
/// in_reply_to を持つ下書きは返信として保存される。
pub async fn draft_save(
    base: &str,
    draft_id: &str,
    to: &str,
    subject: &str,
    text: &str,
    in_reply_to: Option<&str>,
) -> Result<Value, String> {
    let id = mail_id(draft_id, "下書き")?;
    let in_reply_to = in_reply_to
        .map(|value| mail_id(value, "返信先"))
        .transpose()?;
    authed(
        base,
        reqwest::Method::PUT,
        &format!("/drafts/{id}"),
        Some(json!({
            "to": draft_recipient(to)?,
            "subject": subject.trim().chars().take(998).collect::<String>(),
            "text": text.trim().chars().take(MAX_BODY_CHARS).collect::<String>(),
            "inReplyTo": in_reply_to,
        })),
    )
    .await
}

/// 下書きの削除。他者の下書きはワーカーが存在ごと隠す（404）。
pub async fn draft_delete(base: &str, draft_id: &str) -> Result<Value, String> {
    let id = mail_id(draft_id, "下書き")?;
    authed(base, reqwest::Method::DELETE, &format!("/drafts/{id}"), None).await
}

/// 送信結果の確かめ直し。「届いたか不明」のとき窓が問い直す口。
pub async fn send_status(base: &str, intent_id: &str) -> Result<Value, String> {
    let id = mail_id(intent_id, "送信")?;
    authed(
        base,
        reqwest::Method::GET,
        &format!("/send-intents/{id}/status"),
        None,
    )
    .await
}

/// 添付の実体。検査済み（clean）なものだけがワーカーから返る。
/// content-disposition の filename* から既定の保存名を取る——
/// 窓からファイル名を受け取らない。
pub struct MailAttachment {
    pub filename: String,
    pub bytes: Vec<u8>,
}

fn attachment_filename(response: &reqwest::Response) -> String {
    let header = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let encoded = header
        .split("filename*=UTF-8''")
        .nth(1)
        .map(str::trim)
        .unwrap_or("");
    let decoded = percent_decode(encoded);
    let cleaned: String = decoded
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().chars().take(255).collect::<String>();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "attachment".to_owned()
    } else {
        cleaned
    }
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&raw[index + 1..index + 3], 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub async fn attachment(
    base: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<MailAttachment, String> {
    let message_id = mail_id(message_id, "メール")?;
    let attachment_id = mail_id(attachment_id, "添付")?;
    let assertion = mail_assertion(base).await?;
    let url = format!(
        "{}/mail/api/messages/{message_id}/attachments/{attachment_id}",
        base.trim_end_matches('/')
    );
    let response = client()?
        .get(url)
        .bearer_auth(assertion)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "メールが応答しません".to_owned()
            } else {
                "メールへ届きません".to_owned()
            }
        })?;
    let status = response.status();
    let filename = attachment_filename(&response);
    let body = response
        .bytes()
        .await
        .map_err(|_| "受け取れませんでした".to_owned())?;
    if !status.is_success() {
        let value: Value =
            serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Default::default()));
        return Err(api_error(&value));
    }
    if body.len() > MAX_ATTACHMENT_BYTES {
        return Err("添付が大きすぎます".to_owned());
    }
    Ok(MailAttachment {
        filename,
        bytes: body.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_are_a_closed_set() {
        assert_eq!(folder_name("inbox").unwrap(), "inbox");
        assert_eq!(folder_name("sent").unwrap(), "sent");
        assert_eq!(folder_name("archive").unwrap(), "archive");
        assert_eq!(folder_name("trash").unwrap(), "trash");
        assert_eq!(folder_name("spam").unwrap(), "spam");
        assert!(folder_name("../admin").is_err());
        assert!(folder_name("inbox&folder=sent").is_err());
        assert!(folder_name("").is_err());
        assert!(folder_name("INBOX").is_err());
    }

    #[test]
    fn ids_are_uuid_shaped_before_they_touch_a_path() {
        assert_eq!(
            mail_id("00000000-0000-4000-8000-000000000001", "x").unwrap(),
            "00000000-0000-4000-8000-000000000001"
        );
        assert!(mail_id("00000000000040008000000000000001", "x").is_err());
        assert!(mail_id("../messages", "x").is_err());
        assert!(mail_id("00000000-0000-4000-8000-000000000001/extra", "x").is_err());
        assert!(mail_id("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", "x").is_err());
        assert!(mail_id("", "x").is_err());
    }

    #[test]
    fn actions_are_a_closed_set() {
        for action in ["read", "unread", "archive", "trash", "spam", "inbox"] {
            assert_eq!(message_action_name(action).unwrap(), action);
        }
        assert!(message_action_name("delete").is_err());
        assert!(message_action_name("read,bulk").is_err());
        assert!(message_action_name("").is_err());
    }

    #[test]
    fn local_part_matches_the_worker_rule() {
        assert_eq!(local_part("jkamma").unwrap(), "jkamma");
        assert_eq!(local_part("JKamma").unwrap(), "jkamma");
        assert_eq!(local_part("a.b-c_d9").unwrap(), "a.b-c_d9");
        assert!(local_part("a").is_ok());
        assert!(local_part("ab").is_err());
        assert!(local_part("-lead").is_err());
        assert!(local_part("trail-").is_err());
        assert!(local_part("has space").is_err());
        assert!(local_part("has/slash").is_err());
        assert!(local_part(&"a".repeat(33)).is_err());
        assert!(local_part("").is_err());
    }

    #[test]
    fn recipients_are_bounded_without_bending_structure() {
        assert_eq!(recipient("someone@example.com").unwrap(), "someone@example.com");
        assert!(recipient("not-an-address").is_err());
        assert!(recipient("a b@example.com").is_err());
        assert!(recipient("a@b\r\nBcc: x").is_err());
        assert!(recipient(&format!("{}@x", "a".repeat(400))).is_err());
    }

    #[test]
    fn drafts_take_an_empty_recipient_but_not_a_malformed_one() {
        assert_eq!(draft_recipient("").unwrap(), "");
        assert_eq!(draft_recipient("   ").unwrap(), "");
        assert_eq!(draft_recipient("someone@example.com").unwrap(), "someone@example.com");
        assert!(draft_recipient("not-an-address").is_err());
        assert!(draft_recipient("a b@example.com").is_err());
    }

    #[test]
    fn attachment_names_cannot_carry_paths() {
        assert_eq!(percent_decode("hello%20world.txt"), "hello world.txt");
        assert_eq!(percent_decode("%2Fetc%2Fpasswd"), "/etc/passwd");
    }
}
