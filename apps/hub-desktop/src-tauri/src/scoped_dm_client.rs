//! Managed DM adapter. Scope pins authentication context; it never authenticates a caller.
use super::scoped_social_client::Scope;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
const PATH: &str = "/api/client/conversations";
const MAX_REPLY: usize = 2 * 1024 * 1024;
const MAX_REQUEST: usize = 16 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const INVALID: &str = "dm_rejected:400";
const UNKNOWN: &str = "dm_unknown";
const CONFLICT: &str = "dm_scope_conflict";
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.split('-').map(str::len).eq([8, 4, 4, 4, 12])
        && value.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}
fn count(value: &Value) -> bool {
    value.as_u64().is_some_and(|v| v <= MAX_SAFE)
}
fn scalar(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|v| v.encode_utf16().count() <= max && !v.contains('\0'))
}
fn timestamp(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        !v.is_empty()
            && v.len() <= 64
            && v.is_ascii()
            && !v.chars().any(char::is_control)
            && (chrono::DateTime::parse_from_rfc3339(v).is_ok()
                || chrono::NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S").is_ok()
                || chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").is_ok())
    })
}
fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn mapped(error: String) -> String {
    if error.starts_with("notification_") {
        error.replacen("notification_", "dm_", 1)
    } else {
        error
    }
}
fn closed<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    let object = value.as_object().ok_or(UNKNOWN)?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(UNKNOWN.into());
    }
    Ok(object)
}
fn array(value: &Value, max: usize) -> Result<&Vec<Value>, String> {
    value
        .as_array()
        .filter(|v| v.len() <= max)
        .ok_or_else(|| UNKNOWN.into())
}
fn image_ids(value: Option<&Value>, metadata: bool) -> Result<HashSet<&str>, String> {
    let Some(value) = value else {
        return Ok(HashSet::new());
    };
    let mut ids = HashSet::new();
    for item in array(value, 4)? {
        let image_id = if metadata {
            let image = closed(
                item,
                &["id", "url", "fullUrl", "width", "height", "altText"],
                &[],
            )?;
            let image_id = image["id"].as_str().filter(|v| uuid(v)).ok_or(UNKNOWN)?;
            if image["url"].as_str()
                != Some(&format!(
                    "/api/media/dm-images/{image_id}?variant=thumbnail"
                ))
                || image["fullUrl"].as_str()
                    != Some(&format!("/api/media/dm-images/{image_id}?variant=full"))
                || ["width", "height"].iter().any(|key| {
                    image[*key]
                        .as_u64()
                        .is_none_or(|v| !(1..=1600).contains(&v))
                })
                || !scalar(&image["altText"], MAX_REPLY)
            {
                return Err(UNKNOWN.into());
            }
            image_id
        } else {
            item.as_str().filter(|v| uuid(v)).ok_or(UNKNOWN)?
        };
        if !ids.insert(image_id) {
            return Err(UNKNOWN.into());
        }
    }
    Ok(ids)
}
fn message<'a>(value: &'a Value) -> Result<&'a Map<String, Value>, String> {
    let m = closed(
        value,
        &[
            "id",
            "conversationId",
            "senderProfileId",
            "encryptedPayload",
            "previewText",
            "encryptionVersion",
            "encryptionState",
            "createdAt",
        ],
        &["images"],
    )?;
    if ["id", "conversationId", "senderProfileId"]
        .iter()
        .any(|key| !m[*key].as_str().is_some_and(id))
        || m["encryptedPayload"].as_str() != Some("")
        || !scalar(&m["previewText"], MAX_REPLY)
        || !m["encryptionVersion"]
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.len() <= 64 && !v.chars().any(char::is_control))
        || m["encryptionState"].as_str() != Some("sealed")
        || !timestamp(&m["createdAt"])
    {
        return Err(UNKNOWN.into());
    }
    image_ids(m.get("images"), true)?;
    Ok(m)
}
fn validate_page(
    value: &Value,
    expected: Option<&str>,
    selected: Option<&str>,
) -> Result<(), String> {
    let page = closed(
        value,
        &[
            "currentProfileId",
            "conversations",
            "messages",
            "profiles",
            "messageCount",
        ],
        &[],
    )?;
    let viewer = page["currentProfileId"]
        .as_str()
        .filter(|v| id(v))
        .ok_or(UNKNOWN)?;
    if expected.is_some_and(|v| v != viewer) {
        return Err(CONFLICT.into());
    }
    if !count(&page["messageCount"]) {
        return Err(UNKNOWN.into());
    }
    let mut conversations = HashMap::new();
    for value in array(&page["conversations"], 100)? {
        let c = closed(
            value,
            &[
                "id",
                "participantIds",
                "isE2ee",
                "verificationStatus",
                "fingerprint",
                "unreadCountByProfileId",
                "lastMessageAt",
            ],
            &[],
        )?;
        let conversation_id = c["id"].as_str().filter(|v| id(v)).ok_or(UNKNOWN)?;
        let participants = array(&c["participantIds"], 200)?;
        let mut members = HashSet::new();
        for participant in participants {
            if !participant
                .as_str()
                .is_some_and(|v| id(v) && members.insert(v))
            {
                return Err(UNKNOWN.into());
            }
        }
        if !members.contains(viewer)
            || !c["isE2ee"].is_boolean()
            || !matches!(
                c["verificationStatus"].as_str(),
                Some("verified" | "unverified")
            )
            || !scalar(&c["fingerprint"], MAX_REPLY)
            || !timestamp(&c["lastMessageAt"])
        {
            return Err(UNKNOWN.into());
        }
        let unread = c["unreadCountByProfileId"].as_object().ok_or(UNKNOWN)?;
        if unread.len() != members.len()
            || unread
                .iter()
                .any(|(key, value)| !members.contains(key.as_str()) || !count(value))
            || conversations.insert(conversation_id, members).is_some()
        {
            return Err(UNKNOWN.into());
        }
    }
    if selected.is_some_and(|v| !conversations.contains_key(v)) {
        return Err("dm_rejected:404".into());
    }
    let mut message_ids = HashSet::new();
    let mut per_conversation = HashMap::<&str, usize>::new();
    let active = selected.or_else(|| {
        page["conversations"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
    });
    for value in array(&page["messages"], 299)? {
        let m = message(value)?;
        let conversation = m["conversationId"].as_str().ok_or(UNKNOWN)?;
        if !message_ids.insert(m["id"].as_str().ok_or(UNKNOWN)?)
            || !conversations.get(conversation).is_some_and(|members| {
                members.contains(m["senderProfileId"].as_str().unwrap_or(""))
            })
        {
            return Err(UNKNOWN.into());
        }
        let quantity = per_conversation.entry(conversation).or_default();
        *quantity += 1;
        if *quantity > if Some(conversation) == active { 200 } else { 1 } {
            return Err(UNKNOWN.into());
        }
    }
    let mut profile_ids = HashSet::new();
    for value in array(&page["profiles"], 200)? {
        let profile = closed(
            value,
            &["id", "handle", "displayName", "bio", "joinedAt"],
            &["avatarUrl", "isCurrentUser"],
        )?;
        let profile_id = profile["id"].as_str().filter(|v| id(v)).ok_or(UNKNOWN)?;
        let handle = profile["handle"].as_str().ok_or(UNKNOWN)?;
        if !profile_ids.insert(profile_id)
            || !conversations
                .values()
                .any(|members| members.contains(profile_id))
            || handle.is_empty()
            || handle.len() > 64
            || !handle
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            || !scalar(&profile["displayName"], MAX_REPLY)
            || !scalar(&profile["bio"], MAX_REPLY)
            || !timestamp(&profile["joinedAt"])
            || profile
                .get("avatarUrl")
                .is_some_and(|v| !v.is_null() && !scalar(v, 2048))
            || profile
                .get("isCurrentUser")
                .is_some_and(|v| !v.is_boolean())
        {
            return Err(UNKNOWN.into());
        }
    }
    Ok(())
}
fn read_scope(ids: &[String]) -> Result<(Scope, Option<&str>), String> {
    if !matches!(ids.len(), 3 | 4)
        || !id(&ids[0])
        || (!ids[2].is_empty() && !id(&ids[2]))
        || ids.get(3).is_some_and(|v| !id(v))
    {
        return Err(INVALID.into());
    }
    let origin = &ids[1];
    if origin.len() > 512
        || origin.chars().any(char::is_control)
        || crate::hub_network::origin(origin).map_err(|_| INVALID)? != *origin
    {
        return Err(INVALID.into());
    }
    Ok((
        Scope {
            device: ids[0].clone(),
            origin: origin.clone(),
            viewer: ids.get(3).cloned().unwrap_or_default(),
        },
        (!ids[2].is_empty()).then_some(ids[2].as_str()),
    ))
}
fn request_bytes(action: &str, path: &str, body: &Value) -> Result<Vec<u8>, String> {
    if path != PATH {
        return Err(INVALID.into());
    }
    let input = match action {
        "read_conversation" => {
            closed(body, &["conversation", "markRead"], &[]).map_err(|_| INVALID)?
        }
        "send_message" => closed(body, &["conversation", "text", "requestId"], &["imageIds"])
            .map_err(|_| INVALID)?,
        _ => return Err(INVALID.into()),
    };
    if !input["conversation"].as_str().is_some_and(id) {
        return Err(INVALID.into());
    }
    if action == "read_conversation" {
        if input["markRead"] != true {
            return Err(INVALID.into());
        }
    } else {
        let text = input["text"]
            .as_str()
            .ok_or(INVALID)?
            .trim_matches(whitespace);
        let ids = image_ids(input.get("imageIds"), false).map_err(|_| INVALID)?;
        if text.contains('\0')
            || text.encode_utf16().count() > 280
            || (text.is_empty() && ids.is_empty())
            || !input["requestId"].as_str().is_some_and(uuid)
        {
            return Err(INVALID.into());
        }
    }
    let bytes = serde_json::to_vec(body).map_err(|_| INVALID)?;
    if bytes.len() > MAX_REQUEST {
        return Err(INVALID.into());
    }
    Ok(bytes)
}
fn validate_ack(value: &Value, action: &str, body: &Value, viewer: &str) -> Result<(), String> {
    if action == "read_conversation" {
        let ack = closed(value, &["viewerId", "conversationId", "unreadCount"], &[])?;
        if ack["viewerId"].as_str() != Some(viewer) {
            return Err(CONFLICT.into());
        }
        if ack["conversationId"] != body["conversation"]
            || !count(&ack["unreadCount"])
            || ack["unreadCount"] != 0
        {
            return Err(UNKNOWN.into());
        }
        return Ok(());
    }
    let ack = closed(value, &["viewerId", "message"], &[])?;
    if ack["viewerId"].as_str() != Some(viewer) {
        return Err(UNKNOWN.into());
    }
    let m = message(&ack["message"])?;
    let nonce = body["requestId"].as_str().ok_or(UNKNOWN)?;
    let identity = serde_json::json!([
        "hub-dm-send-v1",
        viewer,
        body["conversation"].as_str().ok_or(UNKNOWN)?,
        nonce.to_ascii_lowercase()
    ]);
    let expected = format!(
        "dm-{:x}",
        Sha256::digest(serde_json::to_vec(&identity).map_err(|_| UNKNOWN)?)
    );
    if m["id"].as_str() != Some(expected.as_str())
        || m["senderProfileId"].as_str() != Some(viewer)
        || m["conversationId"] != body["conversation"]
        || m["previewText"].as_str() != body["text"].as_str().map(|v| v.trim_matches(whitespace))
        || m["encryptionVersion"].as_str() != Some("plaintext-v1")
        || image_ids(m.get("images"), true)? != image_ids(body.get("imageIds"), false)?
    {
        return Err(UNKNOWN.into());
    }
    Ok(())
}
fn append(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_REPLY || chunk.len() > MAX_REPLY.saturating_sub(bytes.len()) {
        return Err(UNKNOWN.into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
fn status_error(status: u16, sending: bool, value: Option<&Value>) -> String {
    if status == 401 {
        return "desktop_not_connected".into();
    }
    if status == 409
        && value
            .filter(|v| closed(v, &["error"], &[]).is_ok())
            .and_then(|v| v.get("error"))
            .and_then(Value::as_str)
            == Some("dm_scope_changed")
    {
        return CONFLICT.into();
    }
    if !sending && matches!(status, 400 | 403 | 404 | 413 | 429) {
        return format!("dm_rejected:{status}");
    }
    UNKNOWN.into()
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| UNKNOWN.into())
}
async fn response(
    mut response: reqwest::Response,
    scope: &Scope,
    base: &str,
    sending: bool,
) -> Result<Value, String> {
    scope.check(base).map_err(mapped)?;
    let status = response.status().as_u16();
    if status != 200 && status != 409 {
        return Err(status_error(status, sending, None));
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
    if status != 200 {
        return Err(status_error(status, sending, Some(&value)));
    }
    Ok(value)
}
pub(super) async fn read(base: &str, ids: &[String]) -> Result<Value, String> {
    let (scope, selected) = read_scope(ids)?;
    scope.check(base).map_err(mapped)?;
    let assertion = crate::desktop_account::assertion(base)
        .await
        .map_err(|code| crate::desktop_account::scoped_auth_error(&code))?;
    scope.check(base).map_err(mapped)?;
    let mut url = reqwest::Url::parse(&format!("{}{PATH}", scope.origin)).map_err(|_| INVALID)?;
    if let Some(id) = selected {
        url.query_pairs_mut().append_pair("conversation", id);
    }
    let mut request = client()?
        .get(url)
        .bearer_auth(assertion)
        .header(reqwest::header::ORIGIN, &scope.origin);
    if !scope.viewer.is_empty() {
        request = request.header("X-Hub-Expected-Viewer", &scope.viewer);
    }
    let value = response(
        request.send().await.map_err(|_| UNKNOWN)?,
        &scope,
        base,
        false,
    )
    .await?;
    validate_page(
        &value,
        (!scope.viewer.is_empty()).then_some(scope.viewer.as_str()),
        selected,
    )?;
    scope.check(base).map_err(mapped)?;
    Ok(value)
}
pub(super) async fn send(
    base: &str,
    action: &str,
    path: &str,
    body: &Value,
    options: &Value,
) -> Result<Value, String> {
    let scope = Scope::from_options(options).map_err(mapped)?;
    let bytes = request_bytes(action, path, body)?;
    scope.check(base).map_err(mapped)?;
    let assertion = crate::desktop_account::assertion(base)
        .await
        .map_err(|code| crate::desktop_account::scoped_auth_error(&code))?;
    scope.check(base).map_err(mapped)?;
    let request = client()?
        .post(format!("{}{PATH}", scope.origin))
        .bearer_auth(assertion)
        .header(reqwest::header::ORIGIN, &scope.origin)
        .header("X-Hub-Expected-Viewer", &scope.viewer)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(bytes);
    let value = response(
        request.send().await.map_err(|_| UNKNOWN)?,
        &scope,
        base,
        action == "send_message",
    )
    .await?;
    validate_ack(&value, action, body, &scope.viewer)?;
    scope.check(base).map_err(mapped)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const UUID: &str = "00000000-0000-4000-8000-000000000001";
    // Independent Node SHA256 of the primary API JSON identity tuple.
    const MESSAGE: &str = "dm-69670aaf82829417454332d8b118cfb2cd8fe14b0b933599aca5882ef8420d2d";
    fn body() -> Value {
        json!({"conversation":"conversation","text":" 日本語 literal <script> ","requestId":UUID,"imageIds":[]})
    }
    fn message(id: &str, conversation: &str, sender: &str) -> Value {
        json!({"id":id,"conversationId":conversation,"senderProfileId":sender,"encryptedPayload":"","previewText":"日本語 literal <script>","encryptionVersion":"plaintext-v1","encryptionState":"sealed","createdAt":"2026-10-07T00:00:00Z","images":[]})
    }
    fn ack() -> Value {
        json!({"viewerId":"viewer","message":message(MESSAGE,"conversation","viewer")})
    }
    fn conversation(id: &str, other: &str) -> Value {
        json!({"id":id,"participantIds":["viewer",other],"isE2ee":false,"verificationStatus":"unverified","fingerprint":"legacy metadata","unreadCountByProfileId":{"viewer":0,other:0},"lastMessageAt":"2026-10-07"})
    }
    fn page() -> Value {
        json!({"currentProfileId":"viewer","conversations":[conversation("conversation","other")],"messages":[message("m1","conversation","other")],"profiles":[{"id":"viewer","handle":"viewer","displayName":"Viewer","bio":"","joinedAt":"2026-10-07"},{"id":"other","handle":"other","displayName":"Other","bio":"日本語\n","joinedAt":"2026-10-07","avatarUrl":null}],"messageCount":1})
    }
    fn image() -> Value {
        json!({"id":UUID,"url":format!("/api/media/dm-images/{UUID}?variant=thumbnail"),"fullUrl":format!("/api/media/dm-images/{UUID}?variant=full"),"width":1600,"height":1,"altText":"literal <img>"})
    }

    #[test]
    fn read_grammar_is_unambiguous_and_only_third_field_can_be_empty() {
        let ids = vec!["device".into(), "https://hub.example".into(), "".into()];
        let (scope, selected) = read_scope(&ids).unwrap();
        assert_eq!(scope.viewer, "");
        assert!(selected.is_none());
        let mut ids = ids.clone();
        ids[2] = "conversation".into();
        ids.push("viewer".into());
        let (scope, selected) = read_scope(&ids).unwrap();
        assert_eq!(scope.viewer, "viewer");
        assert_eq!(selected, Some("conversation"));
        ids[3] = "".into();
        assert!(read_scope(&ids).is_err());
        ids[3] = "viewer".into();
        ids.push("extra".into());
        assert!(read_scope(&ids).is_err());
        assert!(read_scope(&[]).is_err());
        assert!(read_scope(&["device".into(), "https://hub.example".into()]).is_err());
        for invalid in ["c\n", "c\r", "c\u{2028}", "c\u{0085}", "c/../x"]
            .map(String::from)
            .into_iter()
            .chain(["c".repeat(129)])
        {
            let ids = vec![
                "device".into(),
                "https://hub.example".into(),
                invalid.into(),
            ];
            assert!(read_scope(&ids).is_err());
        }
        let ids = vec![
            "d".repeat(128),
            "http://127.0.0.1:3020".into(),
            "c".repeat(128),
            "v".repeat(128),
        ];
        assert!(read_scope(&ids).is_ok());
        let ids = vec!["device".into(), "https://hub.example/".into(), "".into()];
        assert!(read_scope(&ids).is_err());
    }

    #[test]
    fn page_keeps_five_fields_and_binds_all_message_senders_to_actual_members() {
        let value = page();
        assert!(validate_page(&value, Some("viewer"), Some("conversation")).is_ok());
        assert_eq!(
            validate_page(&value, Some("wrong"), None).unwrap_err(),
            CONFLICT
        );
        assert_eq!(
            validate_page(&value, None, Some("absent")).unwrap_err(),
            "dm_rejected:404"
        );
        for (key, invalid) in [
            ("senderProfileId", json!("outsider")),
            ("conversationId", json!("another")),
            ("encryptedPayload", json!("private cipher")),
            ("encryptionState", json!("draft")),
        ] {
            let mut value = page();
            value["messages"][0][key] = invalid;
            assert!(validate_page(&value, None, None).is_err());
        }
        let mut value = page();
        value["privateExtra"] = json!(true);
        assert!(validate_page(&value, None, None).is_err());
    }

    #[test]
    fn existing_100_conversations_200_selected_and_99_latest_are_not_silently_capped() {
        let mut value = page();
        value["conversations"] = json!((0..100)
            .map(|i| conversation(&format!("c{i}"), "other"))
            .collect::<Vec<_>>());
        let mut messages = (0..200)
            .map(|i| message(&format!("m{i}"), "c0", "other"))
            .collect::<Vec<_>>();
        messages
            .extend((1..100).map(|i| message(&format!("latest{i}"), &format!("c{i}"), "other")));
        value["messages"] = json!(messages);
        assert!(validate_page(&value, Some("viewer"), Some("c0")).is_ok());
        assert_eq!(value["messages"].as_array().unwrap().len(), 299);
        let mut extra = value.clone();
        extra["conversations"]
            .as_array_mut()
            .unwrap()
            .push(conversation("c100", "other"));
        assert!(validate_page(&extra, None, Some("c0")).is_err());
        let mut extra = value.clone();
        extra["messages"]
            .as_array_mut()
            .unwrap()
            .push(message("extra", "c0", "other"));
        assert!(validate_page(&extra, None, Some("c0")).is_err());
        value["messages"] = json!([
            message("latest1", "c1", "other"),
            message("second", "c1", "other")
        ]);
        assert!(validate_page(&value, None, Some("c0")).is_err());
    }

    #[test]
    fn getter_keeps_legacy_encryption_metadata_but_never_returns_cipher_body_or_claims_e2ee() {
        let mut value = page();
        value["conversations"][0]["isE2ee"] = json!(true);
        value["messages"][0]["encryptionVersion"] = json!("legacy-box-v1");
        assert!(validate_page(&value, None, None).is_ok());
        value["messages"][0]["encryptedPayload"] = json!("encrypted body must not cross this DTO");
        assert!(validate_page(&value, None, None).is_err());
        let mut value = ack();
        value["message"]["encryptionVersion"] = json!("legacy-box-v1");
        assert!(validate_ack(&value, "send_message", &body(), "viewer").is_err());
    }

    #[test]
    fn profiles_counts_flags_duplicate_ids_and_unknown_fields_are_closed() {
        for (key, invalid) in [
            ("isE2ee", json!(1)),
            ("participantIds", json!(["other"])),
            ("verificationStatus", json!("unknown")),
            ("unreadCountByProfileId", json!({"viewer":"0","other":0})),
            ("lastMessageAt", json!("2026-02-30")),
        ] {
            let mut value = page();
            value["conversations"][0][key] = invalid;
            assert!(validate_page(&value, None, None).is_err());
        }
        let mut value = page();
        value["messageCount"] = json!(MAX_SAFE);
        assert!(validate_page(&value, None, None).is_ok());
        value["messageCount"] = json!(MAX_SAFE + 1);
        assert!(validate_page(&value, None, None).is_err());
        let mut value = page();
        value["profiles"][0]["email"] = json!("not allowed");
        assert!(validate_page(&value, None, None).is_err());
        let mut value = page();
        let duplicate = value["messages"][0].clone();
        value["messages"].as_array_mut().unwrap().push(duplicate);
        assert!(validate_page(&value, None, None).is_err());
        let mut value = page();
        value["profiles"] = json!((0..201).map(|n|json!({"id":format!("p{n}"),"handle":"profile","displayName":"Name","bio":"","joinedAt":"2026-10-07"})).collect::<Vec<_>>());
        assert!(validate_page(&value, None, None).is_err());
        assert!(serde_json::from_slice::<Value>(b"{\"body\":\"\\ud800\"}").is_err());
    }

    #[test]
    fn managed_send_requires_uuid_and_closes_scope_fields_and_arbitrary_paths() {
        assert!(request_bytes("send_message", PATH, &body()).is_ok());
        let mut value = body();
        value.as_object_mut().unwrap().remove("requestId");
        assert!(request_bytes("send_message", PATH, &value).is_err());
        for invalid in [
            json!(null),
            json!("bad"),
            json!("00000000-0000-4000-8000-00000000000x"),
        ] {
            let mut value = body();
            value["requestId"] = invalid;
            assert!(request_bytes("send_message", PATH, &value).is_err());
        }
        let mut value = body();
        value["expectedViewerId"] = json!("other");
        assert!(request_bytes("send_message", PATH, &value).is_err());
        for path in [
            "https://external.example/api/client/conversations",
            "/api/client/conversations?conversation=another",
            "/api/client/conversations/../other",
        ] {
            assert!(request_bytes("send_message", path, &body()).is_err());
        }
        assert!(request_bytes("unknown", PATH, &body()).is_err());
    }

    #[test]
    fn body_bound_is_javascript_trimmed_utf16_and_serialized_request_bytes_are_bounded() {
        let mut value = body();
        value["text"] = json!(format!(" \u{feff}{}\r\n", "😀".repeat(140)));
        assert!(request_bytes("send_message", PATH, &value).is_ok());
        value["text"] = json!(format!("{}a", "😀".repeat(140)));
        assert!(request_bytes("send_message", PATH, &value).is_err());
        for text in ["", " \u{feff}\r\n", "invalid\0"] {
            value["text"] = json!(text);
            assert!(request_bytes("send_message", PATH, &value).is_err());
        }
        value["text"] = json!(format!("{}a", " ".repeat(MAX_REQUEST)));
        assert!(request_bytes("send_message", PATH, &value).is_err());
        value["text"] = json!("a");
        let initial = serde_json::to_vec(&value).unwrap().len();
        value["text"] = json!(format!("{}a", " ".repeat(MAX_REQUEST - initial)));
        assert_eq!(
            request_bytes("send_message", PATH, &value).unwrap().len(),
            MAX_REQUEST
        );
        value["text"] = json!(format!("{} ", value["text"].as_str().unwrap()));
        assert_eq!(serde_json::to_vec(&value).unwrap().len(), MAX_REQUEST + 1);
        assert!(request_bytes("send_message", PATH, &value).is_err());
        let mut value = body();
        value["text"] = json!("a".repeat(281));
        assert!(request_bytes("send_message", PATH, &value).is_err());
    }

    #[test]
    fn image_only_send_accepts_four_unique_uuid_refs_and_rejects_fifth_or_duplicate() {
        let mut value = body();
        value["text"] = json!("");
        value["imageIds"] = json!([UUID]);
        assert!(request_bytes("send_message", PATH, &value).is_ok());
        value["imageIds"] = json!([UUID, UUID]);
        assert!(request_bytes("send_message", PATH, &value).is_err());
        value["imageIds"] = json!(["bad"]);
        assert!(request_bytes("send_message", PATH, &value).is_err());
        value["imageIds"] = json!((1..=4)
            .map(|n| format!("00000000-0000-4000-8000-{n:012}"))
            .collect::<Vec<_>>());
        assert!(request_bytes("send_message", PATH, &value).is_ok());
        value["imageIds"]
            .as_array_mut()
            .unwrap()
            .push(json!("00000000-0000-4000-8000-000000000005"));
        assert!(request_bytes("send_message", PATH, &value).is_err());
    }

    #[test]
    fn send_ack_matches_independent_primary_id_actual_actor_conversation_body_and_image_set() {
        assert!(validate_ack(&ack(), "send_message", &body(), "viewer").is_ok());
        for (key, invalid) in [
            ("id", json!("wrong-operation")),
            ("senderProfileId", json!("other")),
            ("conversationId", json!("other")),
            ("previewText", json!("different")),
            ("encryptedPayload", json!("cipher")),
            ("encryptionState", json!("draft")),
        ] {
            let mut value = ack();
            value["message"][key] = invalid;
            assert!(validate_ack(&value, "send_message", &body(), "viewer").is_err());
        }
        let mut value = ack();
        value["viewerId"] = json!("other");
        assert!(validate_ack(&value, "send_message", &body(), "viewer").is_err());
        let mut value = ack();
        value["message"]["images"] = json!([image()]);
        assert!(validate_ack(&value, "send_message", &body(), "viewer").is_err());
        let mut input = body();
        input["imageIds"] = json!([UUID]);
        assert!(validate_ack(&value, "send_message", &input, "viewer").is_ok());
        value["message"]["images"][0]["url"] =
            json!(format!("/api/media/images/{UUID}?variant=thumbnail"));
        assert!(validate_ack(&value, "send_message", &input, "viewer").is_err());
    }

    #[test]
    fn mark_read_body_and_receipt_are_exact_and_viewer_bound() {
        let body = json!({"conversation":"conversation","markRead":true});
        assert!(request_bytes("read_conversation", PATH, &body).is_ok());
        assert!(request_bytes(
            "read_conversation",
            PATH,
            &json!({"conversation":"conversation","markRead":false})
        )
        .is_err());
        assert!(validate_ack(
            &json!({"viewerId":"viewer","conversationId":"conversation","unreadCount":0}),
            "read_conversation",
            &body,
            "viewer"
        )
        .is_ok());
        for value in [
            json!({"viewerId":"other","conversationId":"conversation","unreadCount":0}),
            json!({"viewerId":"viewer","conversationId":"other","unreadCount":0}),
            json!({"viewerId":"viewer","conversationId":"conversation","unreadCount":1}),
            json!({"viewerId":"viewer","conversationId":"conversation","unreadCount":0,"extra":true}),
        ] {
            assert!(validate_ack(&value, "read_conversation", &body, "viewer").is_err());
        }
    }

    #[test]
    fn actual_reply_chunks_stop_before_two_mebibyte_growth_and_invalid_utf8_is_rejected() {
        let mut bytes = vec![0; MAX_REPLY - 1];
        append(&mut bytes, &[1]).unwrap();
        assert_eq!(bytes.len(), MAX_REPLY);
        assert!(append(&mut bytes, &[2]).is_err());
        assert_eq!(bytes.len(), MAX_REPLY);
        let mut bytes = vec![0; MAX_REPLY + 1];
        assert!(append(&mut bytes, &[]).is_err());
        assert!(serde_json::from_slice::<Value>(&[0xff]).is_err());
    }

    #[test]
    fn send_failures_are_unknown_except_authentication_and_closed_scope_receipts() {
        for status in [400, 403, 404, 413, 429, 500, 503, 302, 307] {
            assert_eq!(status_error(status, true, None), UNKNOWN);
        }
        assert_eq!(status_error(401, true, None), "desktop_not_connected");
        assert_eq!(
            status_error(409, true, Some(&json!({"error":"dm_scope_changed"}))),
            CONFLICT
        );
        for value in [
            json!({"error":"e2ee_not_available"}),
            json!({"error":"dm_scope_changed","extra":true}),
            json!({"error":"dm_scope_changed","code":"request_conflict"}),
        ] {
            assert_eq!(status_error(409, true, Some(&value)), UNKNOWN);
        }
        for status in [400, 403, 404, 413, 429] {
            assert_eq!(
                status_error(status, false, None),
                format!("dm_rejected:{status}")
            );
        }
        assert_eq!(mapped("notification_scope_conflict".into()), CONFLICT);
        assert_eq!(
            mapped("desktop_not_connected".into()),
            "desktop_not_connected"
        );
    }
}
