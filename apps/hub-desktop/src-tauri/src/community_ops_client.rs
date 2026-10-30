//! Fixed poll/scheduled operations with selected-origin and actual-viewer preconditions.
use super::scoped_social_client::Scope;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, time::Duration};
use unicode_normalization::UnicodeNormalization;
const INVALID: &str = "community_operation_rejected:400";
const UNKNOWN: &str = "community_operation_unknown";
const CHANGED: &str = "community_operation_scope_conflict";
const MAX_REPLY: usize = 2 * 1024 * 1024;
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.split('-').map(str::len).eq([8, 4, 4, 4, 12])
        && value.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}
fn normalize(value: &str) -> String {
    value.nfkc().collect::<String>().trim().to_owned()
}
fn text(value: &Value, max: usize) -> Result<String, String> {
    let raw = value.as_str().ok_or(INVALID)?;
    let normalized = normalize(raw);
    if raw.contains('\0')
        || raw.encode_utf16().count() > max
        || normalized.is_empty()
        || normalized.encode_utf16().count() > max
    {
        return Err(INVALID.into());
    }
    Ok(normalized)
}
fn closed<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let value = value.as_object().ok_or(UNKNOWN)?;
    if value.len() != keys.len() || keys.iter().any(|k| !value.contains_key(*k)) {
        return Err(UNKNOWN.into());
    }
    Ok(value)
}
fn target<'a>(action: &str, path: &'a str) -> Result<&'a str, String> {
    let parts = path.split('/').collect::<Vec<_>>();
    let suffix = match action {
        "community_poll_create" | "community_poll_vote" => "polls",
        "community_message_schedule" => "scheduled",
        _ => return Err(INVALID.into()),
    };
    if parts.len() != 6
        || parts[..4] != ["", "api", "client", "communities"]
        || !id(parts[4])
        || parts[5] != suffix
    {
        return Err(INVALID.into());
    }
    Ok(parts[4])
}
fn request_bytes(
    action: &str,
    method: &reqwest::Method,
    path: &str,
    body: &Value,
) -> Result<Vec<u8>, String> {
    target(action, path)?;
    if *method
        != if action == "community_poll_vote" {
            reqwest::Method::PATCH
        } else {
            reqwest::Method::POST
        }
    {
        return Err(INVALID.into());
    }
    match action {
        "community_poll_create" => {
            let value = closed(
                body,
                &[
                    "channelId",
                    "question",
                    "options",
                    "closesInHours",
                    "clientRequestId",
                ],
            )
            .map_err(|_| INVALID)?;
            if !value["channelId"].as_str().is_some_and(id)
                || !value["clientRequestId"].as_str().is_some_and(uuid)
                || !value["closesInHours"]
                    .as_u64()
                    .is_some_and(|v| (1..=720).contains(&v))
            {
                return Err(INVALID.into());
            }
            text(&value["question"], 200)?;
            let options = value["options"]
                .as_array()
                .filter(|v| (2..=10).contains(&v.len()))
                .ok_or(INVALID)?;
            let mut seen = HashSet::new();
            for option in options {
                if !seen.insert(text(option, 100)?) {
                    return Err(INVALID.into());
                }
            }
        }
        "community_poll_vote" => {
            let value = closed(body, &["optionId"]).map_err(|_| INVALID)?;
            if !value["optionId"].as_str().is_some_and(id) {
                return Err(INVALID.into());
            }
        }
        "community_message_schedule" => {
            let value = closed(
                body,
                &[
                    "channelId",
                    "body",
                    "kind",
                    "scheduledAt",
                    "clientRequestId",
                ],
            )
            .map_err(|_| INVALID)?;
            if !value["channelId"].as_str().is_some_and(id)
                || !value["clientRequestId"].as_str().is_some_and(uuid)
                || !matches!(
                    value["kind"].as_str(),
                    Some("chat" | "guide" | "question" | "party")
                )
            {
                return Err(INVALID.into());
            }
            text(&value["body"], 2000)?;
            let date = value["scheduledAt"]
                .as_str()
                .filter(|v| v.len() <= 64 && v.is_ascii() && !v.chars().any(char::is_control))
                .ok_or(INVALID)?;
            if chrono::DateTime::parse_from_rfc3339(date).is_err() {
                return Err(INVALID.into());
            }
        }
        _ => return Err(INVALID.into()),
    }
    let bytes = serde_json::to_vec(body).map_err(|_| INVALID)?;
    if bytes.len() > 16384 {
        return Err(INVALID.into());
    }
    Ok(bytes)
}
fn ack(value: &Value, action: &str, path: &str, body: &Value, viewer: &str) -> Result<(), String> {
    let field = match action {
        "community_poll_create" => "message",
        "community_poll_vote" => "voted",
        "community_message_schedule" => "scheduled",
        _ => return Err(UNKNOWN.into()),
    };
    let value = closed(value, &["viewerId", field])?;
    if value["viewerId"].as_str() != Some(viewer) {
        return Err(UNKNOWN.into());
    }
    if field != "message" {
        return if value[field] == true {
            Ok(())
        } else {
            Err(UNKNOWN.into())
        };
    }
    let message = value[field].as_object().ok_or(UNKNOWN)?;
    let required = ["id", "channelId", "authorProfileId", "body", "createdAt"];
    let optional = [
        "botId",
        "botName",
        "replyToMessageId",
        "editedAt",
        "kind",
        "pinnedAt",
        "pinnedByProfileId",
        "workflowStatus",
        "images",
    ];
    if required.iter().any(|k| !message.contains_key(*k))
        || message
            .keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
        || !message["createdAt"].as_str().is_some_and(|v| {
            v.len() <= 64
                && v.is_ascii()
                && !v.chars().any(char::is_control)
                && (chrono::DateTime::parse_from_rfc3339(v).is_ok()
                    || chrono::NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S").is_ok())
        })
    {
        return Err(UNKNOWN.into());
    }
    let community = target(action, path).map_err(|_| UNKNOWN)?;
    let nonce = body["clientRequestId"].as_str().ok_or(UNKNOWN)?;
    let identity = serde_json::json!([
        "hub-community-message-v1",
        viewer,
        community,
        body["channelId"].as_str().ok_or(UNKNOWN)?,
        nonce.to_ascii_lowercase()
    ]);
    let expected = format!(
        "cm-{:x}",
        Sha256::digest(serde_json::to_vec(&identity).map_err(|_| UNKNOWN)?)
    );
    if message.get("id").and_then(Value::as_str) != Some(expected.as_str())
        || message.get("authorProfileId").and_then(Value::as_str) != Some(viewer)
        || message.get("channelId") != body.get("channelId")
        || message.get("body").and_then(Value::as_str)
            != Some(text(&body["question"], 200).map_err(|_| UNKNOWN)?.as_str())
        || message.get("kind").and_then(Value::as_str) != Some("chat")
        || message
            .get("replyToMessageId")
            .is_some_and(|v| !v.is_null())
        || message
            .get("images")
            .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty))
    {
        return Err(UNKNOWN.into());
    }
    Ok(())
}
fn mapped(error: String) -> String {
    if error == "notification_scope_conflict" {
        CHANGED.into()
    } else if error == "notification_rejected:400" {
        INVALID.into()
    } else {
        error
    }
}
fn append(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_REPLY || chunk.len() > MAX_REPLY.saturating_sub(bytes.len()) {
        return Err(UNKNOWN.into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
fn rejected(status: u16, value: Option<&Value>) -> String {
    if status == 401 {
        return "desktop_not_connected".into();
    }
    if status == 409
        && value
            .filter(|v| closed(v, &["error"]).is_ok())
            .and_then(|v| v.get("error"))
            .and_then(Value::as_str)
            == Some("community_operation_scope_changed")
    {
        return CHANGED.into();
    }
    UNKNOWN.into()
}
pub(super) async fn send(
    base: &str,
    action: &str,
    method: reqwest::Method,
    path: &str,
    body: &Value,
    options: &Value,
) -> Result<Value, String> {
    let scope = Scope::from_options(options).map_err(mapped)?;
    let bytes = request_bytes(action, &method, path, body)?;
    scope.check(base).map_err(mapped)?;
    let assertion = crate::desktop_account::assertion(base)
        .await
        .map_err(|code| crate::desktop_account::scoped_auth_error(&code))?;
    scope.check(base).map_err(mapped)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| UNKNOWN)?;
    let mut response = client
        .request(method, format!("{}{path}", scope.origin))
        .bearer_auth(assertion)
        .header(reqwest::header::ORIGIN, &scope.origin)
        .header("X-Hub-Expected-Viewer", &scope.viewer)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(bytes)
        .send()
        .await
        .map_err(|_| UNKNOWN)?;
    scope.check(base).map_err(mapped)?;
    let status = response.status().as_u16();
    if !matches!(status, 200 | 201 | 409) {
        return Err(rejected(status, None));
    }
    if response
        .content_length()
        .is_some_and(|v| v > MAX_REPLY as u64)
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
        return Err(UNKNOWN.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNKNOWN)? {
        append(&mut bytes, &chunk)?;
    }
    scope.check(base).map_err(mapped)?;
    let value = serde_json::from_slice::<Value>(&bytes).map_err(|_| UNKNOWN)?;
    if status == 409 {
        return Err(rejected(status, Some(&value)));
    }
    if action == "community_poll_vote" && status != 200 {
        return Err(UNKNOWN.into());
    }
    ack(&value, action, path, body, &scope.viewer)?;
    scope.check(base).map_err(mapped)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const CREATE: &str = "community_poll_create";
    const POLLS: &str = "/api/client/communities/c-1/polls";
    const NONCE: &str = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    fn poll() -> Value {
        json!({"channelId":"ch-1","question":"  Ａ質問  ","options":["Yes","No"],"closesInHours":24,"clientRequestId":NONCE})
    }
    fn message() -> Value {
        let identity = json!([
            "hub-community-message-v1",
            "viewer-1",
            "c-1",
            "ch-1",
            NONCE.to_ascii_lowercase()
        ]);
        json!({"viewerId":"viewer-1","message":{"id":format!("cm-{:x}",Sha256::digest(serde_json::to_vec(&identity).unwrap())),"channelId":"ch-1","authorProfileId":"viewer-1","body":"A質問","kind":"chat","createdAt":"2026-10-07T00:00:00.000Z","images":[],"replyToMessageId":null}})
    }
    #[test]
    fn fixed_action_paths_methods_and_closed_body_reject_unrelated_requests() {
        assert!(request_bytes(CREATE, &reqwest::Method::POST, POLLS, &poll()).is_ok());
        for path in [
            "https://outside.example/api/client/communities/c-1/polls",
            "/api/client/communities/../polls",
            "/api/client/communities/c-1/polls?secret=x",
            "/api/client/communities/c-1/scheduled",
        ] {
            assert!(request_bytes(CREATE, &reqwest::Method::POST, path, &poll()).is_err());
        }
        assert!(request_bytes(CREATE, &reqwest::Method::PATCH, POLLS, &poll()).is_err());
        let mut body = poll();
        body["viewerId"] = json!("claim");
        assert!(request_bytes(CREATE, &reqwest::Method::POST, POLLS, &body).is_err());
        for invalid in [
            json!(null),
            json!([]),
            json!({"optionId":"valid","extra":true}),
            json!({"optionId":"valid\n"}),
        ] {
            assert!(request_bytes(
                "community_poll_vote",
                &reqwest::Method::PATCH,
                POLLS,
                &invalid
            )
            .is_err());
        }
        assert!(request_bytes(
            "community_poll_vote",
            &reqwest::Method::PATCH,
            POLLS,
            &json!({"optionId":"option-1"})
        )
        .is_ok());
    }
    #[test]
    fn question_options_raw_and_nfkc_utf16_limits_reject_without_truncating() {
        let mut body = poll();
        body["question"] = json!("😀".repeat(100));
        assert!(request_bytes(CREATE, &reqwest::Method::POST, POLLS, &body).is_ok());
        for value in [
            "😀".repeat(100) + "a",
            "a".repeat(201),
            " ".into(),
            "a\0b".into(),
            "㍿".repeat(51),
        ] {
            body["question"] = json!(value);
            assert!(request_bytes(CREATE, &reqwest::Method::POST, POLLS, &body).is_err());
        }
        body = poll();
        body["options"] = json!([" A ", "Ａ"]);
        assert!(request_bytes(CREATE, &reqwest::Method::POST, POLLS, &body).is_err());
        for n in [1, 11] {
            body["options"] = json!((0..n).map(|n| format!("v{n}")).collect::<Vec<_>>());
            assert!(request_bytes(CREATE, &reqwest::Method::POST, POLLS, &body).is_err());
        }
        body = poll();
        body["options"] = json!(["😀".repeat(50), "No"]);
        assert!(request_bytes(CREATE, &reqwest::Method::POST, POLLS, &body).is_ok());
        body["options"] = json!(["😀".repeat(51), "No"]);
        assert!(request_bytes(CREATE, &reqwest::Method::POST, POLLS, &body).is_err());
        for hours in [json!(0), json!(721), json!(1.5), json!("24")] {
            body = poll();
            body["closesInHours"] = hours;
            assert!(request_bytes(CREATE, &reqwest::Method::POST, POLLS, &body).is_err());
        }
    }
    #[test]
    fn schedule_inclusive_utf16_kind_date_and_actual_json_escaping_bounds() {
        let path = "/api/client/communities/c-1/scheduled";
        let mut value = json!({"channelId":"ch-1","body":"😀".repeat(1000),"kind":"chat","scheduledAt":"2026-10-08T00:00:00.000Z","clientRequestId":NONCE});
        assert!(request_bytes(
            "community_message_schedule",
            &reqwest::Method::POST,
            path,
            &value
        )
        .is_ok());
        for body in ["😀".repeat(1000) + "a", " ".into(), "a\0b".into()] {
            value["body"] = json!(body);
            assert!(request_bytes(
                "community_message_schedule",
                &reqwest::Method::POST,
                path,
                &value
            )
            .is_err());
        }
        value["body"] = json!("\u{1}".repeat(2000));
        let bytes = request_bytes(
            "community_message_schedule",
            &reqwest::Method::POST,
            path,
            &value,
        )
        .unwrap();
        assert!(bytes.len() > 12000 && bytes.len() <= 16384);
        value["kind"] = json!("admin");
        assert!(request_bytes(
            "community_message_schedule",
            &reqwest::Method::POST,
            path,
            &value
        )
        .is_err());
        value["kind"] = json!("guide");
        for date in [
            "not-a-date",
            "2026-10-08T00:00:00Z\n",
            "2026-13-08T00:00:00Z",
        ] {
            value["scheduledAt"] = json!(date);
            assert!(request_bytes(
                "community_message_schedule",
                &reqwest::Method::POST,
                path,
                &value
            )
            .is_err());
        }
    }
    #[test]
    fn poll_ack_matches_actual_actor_official_message_identity_and_normalized_question() {
        let value = message();
        assert!(ack(&value, CREATE, POLLS, &poll(), "viewer-1").is_ok());
        for (key, value) in [
            ("authorProfileId", json!("other")),
            ("channelId", json!("other")),
            ("body", json!("different")),
            ("id", json!("cm-fake")),
            ("kind", json!("guide")),
            ("createdAt", json!("invalid")),
            ("images", json!([{"id":"x"}])),
            ("replyToMessageId", json!("cm-other")),
            ("data", json!("private")),
        ] {
            let mut wrong = message();
            wrong["message"][key] = value;
            assert!(ack(&wrong, CREATE, POLLS, &poll(), "viewer-1").is_err());
        }
        let mut wrong = message();
        wrong["viewerId"] = json!("other");
        assert!(ack(&wrong, CREATE, POLLS, &poll(), "viewer-1").is_err());
        wrong = message();
        wrong["extra"] = json!(true);
        assert!(ack(&wrong, CREATE, POLLS, &poll(), "viewer-1").is_err());
    }
    #[test]
    fn managed_vote_schedule_ack_is_closed_true_and_actor_bound() {
        for (action, field) in [
            ("community_poll_vote", "voted"),
            ("community_message_schedule", "scheduled"),
        ] {
            let mut value = json!({"viewerId":"viewer-1"});
            value[field] = json!(true);
            assert!(ack(&value, action, "unused", &Value::Null, "viewer-1").is_ok());
            value[field] = json!(false);
            assert!(ack(&value, action, "unused", &Value::Null, "viewer-1").is_err());
            value[field] = json!(true);
            value["viewerId"] = json!("other");
            assert!(ack(&value, action, "unused", &Value::Null, "viewer-1").is_err());
        }
    }
    #[test]
    fn post_errors_are_unknown_except_explicit_closed_scope_mismatch_and_prewrite_auth() {
        assert_eq!(
            rejected(
                409,
                Some(&json!({"error":"community_operation_scope_changed"}))
            ),
            CHANGED
        );
        for status in [400, 403, 404, 413, 429, 500] {
            assert_eq!(rejected(status, None), UNKNOWN);
        }
        assert_eq!(
            rejected(
                409,
                Some(&json!({"error":"community_operation_scope_changed","raw":"private"}))
            ),
            UNKNOWN
        );
        assert_eq!(rejected(409, Some(&json!({"error":"conflict"}))), UNKNOWN);
        assert_eq!(rejected(401, None), "desktop_not_connected");
        assert_eq!(mapped("notification_scope_conflict".into()), CHANGED);
    }
    #[test]
    fn actual_reply_bytes_limit_is_inclusive_with_no_partial_append() {
        let mut bytes = vec![0; MAX_REPLY - 1];
        append(&mut bytes, &[1]).unwrap();
        assert_eq!(bytes.len(), MAX_REPLY);
        assert!(append(&mut bytes, &[2]).is_err());
        assert_eq!(bytes.len(), MAX_REPLY);
    }
}
