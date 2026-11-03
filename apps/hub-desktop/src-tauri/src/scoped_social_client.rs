//! Fixed managed notification/community-post requests. Scope is a precondition, not authentication.
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, time::Duration};
const MAX_REPLY: usize = 2 * 1024 * 1024;
/// Hub cuts notification excerpts to 80 characters; leave room for surrogate pairs and the ellipsis.
const MAX_EXCERPT: usize = 400;
const MAX_REQUEST: usize = 16 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const UNKNOWN: &str = "notification_unknown";
const CONFLICT: &str = "notification_scope_conflict";
const INVALID: &str = "notification_rejected:400";

fn identity(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn canonical_origin(value: &str) -> Result<String, String> {
    if value.len() > 512 || value.chars().any(char::is_control) {
        return Err(INVALID.into());
    }
    let normalized = crate::hub_network::origin(value).map_err(|_| INVALID)?;
    if normalized != value {
        return Err(INVALID.into());
    }
    Ok(normalized)
}
fn same_origin(raw: &str, expected: &str) -> bool {
    crate::hub_network::origin(raw).is_ok_and(|origin| origin == expected)
}
#[derive(Clone)]
pub(super) struct Scope {
    pub(super) device: String,
    pub(super) origin: String,
    pub(super) viewer: String,
}
impl Scope {
    pub(super) fn from_options(value: &Value) -> Result<Self, String> {
        let object = value.as_object().ok_or(INVALID)?;
        let device = object
            .get("expectedDeviceId")
            .and_then(Value::as_str)
            .ok_or(INVALID)?;
        let origin = object
            .get("expectedOrigin")
            .and_then(Value::as_str)
            .ok_or(INVALID)?;
        let viewer = object
            .get("expectedViewerId")
            .and_then(Value::as_str)
            .ok_or(INVALID)?;
        if !identity(device, 128) || !identity(viewer, 128) {
            return Err(INVALID.into());
        }
        Ok(Self {
            device: device.into(),
            origin: canonical_origin(origin)?,
            viewer: viewer.into(),
        })
    }
    pub(super) fn check(&self, base: &str) -> Result<(), String> {
        if !same_origin(base, &self.origin) || !same_origin(&crate::hub_origin(), &self.origin)
        {
            return Err(CONFLICT.into());
        }
        super::require_article_publication_owner(base, &self.device, &self.origin).map_err(
            |error| {
                if error == "desktop_not_connected" {
                    error
                } else {
                    CONFLICT.into()
                }
            },
        )
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
fn scalar(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|v| v.encode_utf16().count() <= max && !v.contains('\0'))
}
fn valid_id(value: &Value) -> bool {
    value.as_str().is_some_and(|v| identity(v, 128))
}
fn nullable_id(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.is_null() || valid_id(v))
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
fn safe_count(value: &Value) -> bool {
    value.as_u64().is_some_and(|v| v <= MAX_SAFE)
}
fn array(value: &Value, max: usize) -> Result<&Vec<Value>, String> {
    value
        .as_array()
        .filter(|a| a.len() <= max)
        .ok_or_else(|| UNKNOWN.into())
}
fn metadata_map(value: &Value, community: bool) -> Result<(), String> {
    let object = value
        .as_object()
        .filter(|v| v.len() <= 200)
        .ok_or(UNKNOWN)?;
    if object.iter().any(|(key, value)| {
        !(if community {
            message_id(key)
        } else {
            identity(key, 128)
        }) || !scalar(value, 2048)
    }) {
        return Err(UNKNOWN.into());
    }
    Ok(())
}
fn validate_notifications(value: &Value, viewer: Option<&str>) -> Result<(), String> {
    let object = closed(
        value,
        &[
            "viewerId",
            "notifications",
            "unreadCount",
            "actors",
            "threadPostDestinations",
            "communityMessageDestinations",
        ],
        &[],
    )?;
    let actual = object["viewerId"]
        .as_str()
        .filter(|v| identity(v, 128))
        .ok_or(UNKNOWN)?;
    if viewer.is_some_and(|v| v != actual) {
        return Err(CONFLICT.into());
    }
    if !safe_count(&object["unreadCount"]) {
        return Err(UNKNOWN.into());
    }
    let mut ids = HashSet::new();
    for item in array(&object["notifications"], 200)? {
        let n = closed(
            item,
            &[
                "id",
                "receiverProfileId",
                "actorProfileId",
                "type",
                "targetType",
                "targetId",
                "text",
                "isRead",
                "createdAt",
            ],
            &["context", "excerpt"],
        )?;
        let kind = n["targetType"].as_str().ok_or(UNKNOWN)?;
        if !valid_id(&n["id"])
            || !ids.insert(n["id"].as_str().ok_or(UNKNOWN)?)
            || n["receiverProfileId"].as_str() != Some(actual)
            || !nullable_id(n.get("actorProfileId"))
            || !matches!(
                n["type"].as_str(),
                Some(
                    "social_reply"
                        | "social_repost"
                        | "social_reaction"
                        | "social_bookmark"
                        | "thread_reply"
                        | "message_received"
                        | "followed"
                        | "system"
                )
            )
            || !matches!(
                kind,
                "social_post"
                    | "vault_content"
                    | "profile"
                    | "thread"
                    | "thread_post"
                    | "community_message"
                    | "message_conversation"
                    | "system"
            )
            || (kind == "community_message" && !n["targetId"].as_str().is_some_and(message_id))
            || (!matches!(kind, "system" | "community_message") && !valid_id(&n["targetId"]))
            || (kind == "system" && !scalar(&n["targetId"], 2048))
            || !scalar(&n["text"], MAX_REPLY)
            || !n["isRead"].is_boolean()
            || !timestamp(&n["createdAt"])
            || n.get("context")
                .is_some_and(|v| !v.is_null() && v.as_str() != Some("mention"))
            || n.get("excerpt").is_some_and(|v| !scalar(v, MAX_EXCERPT))
        {
            return Err(UNKNOWN.into());
        }
    }
    let mut ids = HashSet::new();
    for item in array(&object["actors"], 200)? {
        let actor = closed(
            item,
            &["id", "handle", "displayName", "bio", "joinedAt"],
            &["avatarUrl", "isCurrentUser"],
        )?;
        let handle = actor["handle"].as_str().ok_or(UNKNOWN)?;
        if !valid_id(&actor["id"])
            || !ids.insert(actor["id"].as_str().ok_or(UNKNOWN)?)
            || handle.is_empty()
            || handle.len() > 64
            || !handle
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            || !scalar(&actor["displayName"], MAX_REPLY)
            || !scalar(&actor["bio"], MAX_REPLY)
            || !timestamp(&actor["joinedAt"])
            || actor
                .get("avatarUrl")
                .is_some_and(|v| !v.is_null() && !scalar(v, 2048))
            || actor.get("isCurrentUser").is_some_and(|v| !v.is_boolean())
        {
            return Err(UNKNOWN.into());
        }
    }
    metadata_map(&object["threadPostDestinations"], false)?;
    metadata_map(&object["communityMessageDestinations"], true)
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.split('-').map(str::len).eq([8, 4, 4, 4, 12])
        && value.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}
fn message_id(value: &str) -> bool {
    identity(value, 80)
        || (value.len() == 46
            && value
                .get(..10)
                .is_some_and(|v| v.eq_ignore_ascii_case("scheduled:"))
            && value.get(10..).is_some_and(uuid))
}
fn nullable_message(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.is_null() || v.as_str().is_some_and(message_id))
}
fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
/// `/api/client/communities/{id}/posts` の `{id}`。コミュニティは1本のストリームで、チャンネルは無い。
fn post_path(path: &str) -> Option<&str> {
    let parts = path.split('/').collect::<Vec<_>>();
    (parts.len() == 6
        && parts[..4] == ["", "api", "client", "communities"]
        && identity(parts[4], 80)
        && parts[5] == "posts")
        .then(|| parts[4])
}
fn request_bytes(action: &str, path: &str, body: &Value) -> Result<Vec<u8>, String> {
    match action {
        "read_notification" => {
            let v = closed(body, &["id"], &[]).map_err(|_| INVALID)?;
            if path != "/api/client/notifications" || !valid_id(&v["id"]) {
                return Err(INVALID.into());
            }
        }
        "read_all_notifications" => {
            let v = closed(body, &["readAll"], &[]).map_err(|_| INVALID)?;
            if path != "/api/client/notifications" || v["readAll"] != true {
                return Err(INVALID.into());
            }
        }
        "community_post" => {
            if post_path(path).is_none() {
                return Err(INVALID.into());
            }
            let v = closed(
                body,
                &["body"],
                &["replyToMessageId", "kind", "imageIds", "clientRequestId"],
            )
            .map_err(|_| INVALID)?;
            let text = v["body"].as_str().ok_or(INVALID)?;
            let images = v
                .get("imageIds")
                .map(|v| array(v, 4))
                .transpose()
                .map_err(|_| INVALID)?;
            let mut ids = HashSet::new();
            if text.encode_utf16().count() > 2000
                || !nullable_message(v.get("replyToMessageId"))
                || v.get("kind").is_some_and(|v| {
                    !matches!(v.as_str(), Some("chat" | "guide" | "question" | "party"))
                })
                || v.get("clientRequestId")
                    .is_some_and(|v| !v.as_str().is_some_and(uuid))
                || images.is_some_and(|a| {
                    a.iter()
                        .any(|v| !v.as_str().is_some_and(|v| uuid(v) && ids.insert(v)))
                })
                || (text.trim_matches(whitespace).is_empty() && images.is_none_or(Vec::is_empty))
            {
                return Err(INVALID.into());
            }
        }
        _ => return Err(INVALID.into()),
    }
    let bytes = serde_json::to_vec(body).map_err(|_| INVALID)?;
    if bytes.len() > MAX_REQUEST {
        return Err(INVALID.into());
    }
    Ok(bytes)
}
fn validate_ack(
    value: &Value,
    action: &str,
    path: &str,
    body: &Value,
    viewer: &str,
) -> Result<(), String> {
    if action != "community_post" {
        let v = closed(value, &["viewerId", "unreadCount"], &[])?;
        if v["viewerId"].as_str() != Some(viewer) {
            return Err(CONFLICT.into());
        }
        return if safe_count(&v["unreadCount"]) {
            Ok(())
        } else {
            Err(UNKNOWN.into())
        };
    }
    let v = closed(value, &["message"], &[])?;
    let message = closed(
        &v["message"],
        &["id", "communityId", "authorProfileId", "body", "createdAt"],
        &[
            "botId",
            "botName",
            "replyToMessageId",
            "editedAt",
            "kind",
            "pinnedAt",
            "pinnedByProfileId",
            "workflowStatus",
            "images",
        ],
    )?;
    let actual_kind = message
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("chat");
    let desired_kind = body.get("kind").and_then(Value::as_str).unwrap_or("chat");
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() != 6 {
        return Err(UNKNOWN.into());
    }
    if let Some(request_id) = body.get("clientRequestId").and_then(Value::as_str) {
        let identity = serde_json::json!([
            "hub-community-message-v1",
            viewer,
            parts[4],
            request_id.to_ascii_lowercase()
        ]);
        let expected = format!(
            "cm-{:x}",
            Sha256::digest(serde_json::to_vec(&identity).map_err(|_| UNKNOWN)?)
        );
        if message["id"].as_str() != Some(expected.as_str()) {
            return Err(UNKNOWN.into());
        }
    }
    if !valid_id(&message["id"])
        || message["authorProfileId"].as_str() != Some(viewer)
        || message["communityId"].as_str() != post_path(path)
        || message["body"].as_str() != body["body"].as_str().map(|v| v.trim_matches(whitespace))
        || !timestamp(&message["createdAt"])
        || actual_kind != desired_kind
        || !matches!(actual_kind, "chat" | "guide" | "question" | "party")
        || message.get("kind").is_some_and(|v| !v.is_string())
        || message.get("replyToMessageId").and_then(Value::as_str)
            != body.get("replyToMessageId").and_then(Value::as_str)
        || !nullable_message(message.get("replyToMessageId"))
        || !nullable_id(message.get("botId"))
        || !nullable_id(message.get("pinnedByProfileId"))
        || message
            .get("botName")
            .is_some_and(|v| !v.is_null() && !scalar(v, MAX_REPLY))
        || ["editedAt", "pinnedAt"].iter().any(|key| {
            message
                .get(*key)
                .is_some_and(|v| !v.is_null() && !timestamp(v))
        })
        || message
            .get("workflowStatus")
            .is_some_and(|v| !matches!(v.as_str(), Some("open" | "resolved" | "closed")))
    {
        return Err(UNKNOWN.into());
    }
    let mut actual = HashSet::new();
    if let Some(images) = message.get("images") {
        for image in array(images, 4)? {
            let i = closed(
                image,
                &["id", "url", "width", "height", "altText"],
                &["fullUrl"],
            )?;
            let image_id = i["id"].as_str().filter(|v| uuid(v)).ok_or(UNKNOWN)?;
            if !actual.insert(image_id)
                || i["width"].as_u64().is_none_or(|v| !(1..=1600).contains(&v))
                || i["height"]
                    .as_u64()
                    .is_none_or(|v| !(1..=1600).contains(&v))
                || i["url"].as_str()
                    != Some(&format!("/api/media/images/{image_id}?variant=thumbnail"))
                || i.get("fullUrl").is_some_and(|v| {
                    v.as_str() != Some(&format!("/api/media/images/{image_id}?variant=full"))
                })
                || !scalar(&i["altText"], MAX_REPLY)
            {
                return Err(UNKNOWN.into());
            }
        }
    }
    let desired = body
        .get("imageIds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect::<HashSet<_>>())
        .unwrap_or_default();
    if actual != desired {
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
fn channel_error(error: String, channel: bool) -> String {
    if channel {
        error.replacen("notification_", "community_post_", 1)
    } else {
        error
    }
}
fn status_error(status: u16, channel: bool, body: Option<&Value>) -> String {
    if status == 401 {
        return "desktop_not_connected".into();
    }
    if status == 409
        && (!channel
            || body
                .filter(|v| closed(v, &["error"], &[]).is_ok())
                .and_then(|v| v.get("error"))
                .and_then(Value::as_str)
                == Some("post_scope_changed"))
    {
        return channel_error(CONFLICT.into(), channel);
    }
    if !channel && matches!(status, 400 | 403 | 404 | 413 | 429) {
        return format!("notification_rejected:{status}");
    }
    channel_error(UNKNOWN.into(), channel)
}
async fn response(
    mut response: reqwest::Response,
    scope: &Scope,
    base: &str,
    success: u16,
    channel: bool,
) -> Result<Value, String> {
    scope.check(base)?;
    let status = response.status().as_u16();
    if status != success && !(channel && status == 409) {
        return Err(status_error(status, channel, None));
    }
    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
        })
        || response
            .content_length()
            .is_some_and(|v| v > MAX_REPLY as u64)
    {
        return Err(UNKNOWN.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNKNOWN)? {
        append(&mut bytes, &chunk)?;
    }
    scope.check(base)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| UNKNOWN)?;
    if status != success {
        return Err(status_error(status, channel, Some(&value)));
    }
    Ok(value)
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| UNKNOWN.into())
}
fn read_scope(ids: &[String]) -> Result<Scope, String> {
    if !matches!(ids.len(), 2 | 3) || !identity(&ids[0], 128) {
        return Err(INVALID.into());
    }
    let scope = Scope {
        device: ids[0].clone(),
        origin: canonical_origin(&ids[1])?,
        viewer: ids.get(2).cloned().unwrap_or_default(),
    };
    if ids.get(2).is_some_and(|v| !identity(v, 128)) {
        return Err(INVALID.into());
    }
    Ok(scope)
}
pub(super) async fn read_notifications(base: &str, ids: &[String]) -> Result<Value, String> {
    let scope = read_scope(ids)?;
    scope.check(base)?;
    let assertion = crate::desktop_account::assertion(base)
        .await
        .map_err(|code| crate::desktop_account::scoped_auth_error(&code))?;
    scope.check(base)?;
    let mut request = client()?
        // excerpts=1 opts in to the short quote of the target post (never sent for gated posts).
        .get(format!("{base}/api/client/notifications?excerpts=1"))
        .bearer_auth(assertion)
        .header(reqwest::header::ORIGIN, &scope.origin);
    if !scope.viewer.is_empty() {
        request = request.header("X-Hub-Expected-Viewer", &scope.viewer);
    }
    let value = response(
        request.send().await.map_err(|_| UNKNOWN)?,
        &scope,
        base,
        200,
        false,
    )
    .await?;
    validate_notifications(
        &value,
        (!scope.viewer.is_empty()).then_some(scope.viewer.as_str()),
    )?;
    scope.check(base)?;
    Ok(value)
}
pub(super) async fn send(
    base: &str,
    action: &str,
    path: &str,
    body: &Value,
    options: &Value,
) -> Result<Value, String> {
    let channel = action == "community_post";
    async {
        let scope = Scope::from_options(options)?;
        let bytes = request_bytes(action, path, body)?;
        scope.check(base)?;
        let assertion = crate::desktop_account::assertion(base)
            .await
            .map_err(|code| crate::desktop_account::scoped_auth_error(&code))?;
        scope.check(base)?;
        let request = client()?
            .post(format!("{base}{path}"))
            .bearer_auth(assertion)
            .header(reqwest::header::ORIGIN, &scope.origin)
            .header("X-Hub-Expected-Viewer", &scope.viewer)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes);
        let value = response(
            request.send().await.map_err(|_| UNKNOWN)?,
            &scope,
            base,
            if channel { 201 } else { 200 },
            channel,
        )
        .await?;
        validate_ack(&value, action, path, body, &scope.viewer)?;
        scope.check(base)?;
        Ok(value)
    }
    .await
    .map_err(|error| channel_error(error, channel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const PATH: &str = "/api/client/communities/community/posts";
    const UUID: &str = "00000000-0000-4000-8000-000000000001";
    // Independent Node SHA256(JSON.stringify(primary API identity tuple)).
    const MESSAGE: &str = "cm-81f94a10755fe6d3df8b2497633ec524221a60c91d1130ff8de3e0907431bca5";
    fn options() -> Value {
        json!({"expectedDeviceId":"device","expectedOrigin":"https://hub.example","expectedViewerId":"viewer"})
    }
    fn notification(index: usize) -> Value {
        json!({"id":format!("n{index}"),"receiverProfileId":"viewer","actorProfileId":null,"type":"system","targetType":"system","targetId":"/community#event=example","text":"日本語の通知","isRead":false,"createdAt":"2026-10-07T00:00:00Z"})
    }
    fn snapshot(count: usize) -> Value {
        json!({"viewerId":"viewer","unreadCount":count,"notifications":(0..count).map(notification).collect::<Vec<_>>(),"actors":[],"threadPostDestinations":{},"communityMessageDestinations":{}})
    }
    fn body() -> Value {
        json!({"body":" original 日本語 ","replyToMessageId":null,"kind":"chat","imageIds":[],"clientRequestId":UUID})
    }
    fn ack() -> Value {
        json!({"message":{"id":MESSAGE,"communityId":"community","authorProfileId":"viewer","body":"original 日本語","createdAt":"2026-10-07T00:00:00Z","replyToMessageId":null,"kind":"chat","botId":null,"botName":null,"editedAt":null,"pinnedAt":null,"pinnedByProfileId":null,"workflowStatus":"open","images":[]}})
    }

    #[test]
    fn scope_parser_is_static_strict_and_does_not_consume_authentication() {
        let value = options();
        let scope = Scope::from_options(&value).unwrap();
        assert_eq!(scope.viewer, "viewer");
        assert_eq!(scope.device, "device");
        assert_eq!(scope.origin, "https://hub.example");
        let mut value = value.clone();
        value["channelId"] = json!("existing-option");
        assert!(Scope::from_options(&value).is_ok());
        for key in ["expectedDeviceId", "expectedViewerId"] {
            for invalid in [
                json!(null),
                json!(1),
                json!(""),
                json!("a".repeat(129)),
                json!("a\n"),
                json!("a\r"),
                json!("a\u{2028}"),
                json!("a\u{0085}"),
            ] {
                let mut value = options();
                value[key] = invalid;
                assert!(Scope::from_options(&value).is_err());
            }
            let mut value = options();
            value[key] = json!("a".repeat(128));
            assert!(Scope::from_options(&value).is_ok());
        }
        for key in ["expectedDeviceId", "expectedOrigin", "expectedViewerId"] {
            let mut value = options();
            value.as_object_mut().unwrap().remove(key);
            assert!(Scope::from_options(&value).is_err());
        }
        for invalid in [
            "http://public.example",
            "https://hub.example/",
            "https://hub.example/path",
            "https://user@hub.example",
            "https://hub.example?secret=1",
            "https://hub.example#fragment",
            "https://hub.example\n",
        ] {
            let mut value = options();
            value["expectedOrigin"] = json!(invalid);
            assert!(Scope::from_options(&value).is_err());
        }
        for valid in [
            "http://localhost:3020",
            "http://127.0.0.1:3020",
            "http://[::1]:3020",
        ] {
            let mut value = options();
            value["expectedOrigin"] = json!(valid);
            assert!(Scope::from_options(&value).is_ok());
        }
    }

    #[test]
    fn read_scope_allows_absent_viewer_but_never_empty_or_extra_ids() {
        let ids = vec!["device".into(), "https://hub.example".into()];
        assert_eq!(read_scope(&ids).unwrap().viewer, "");
        let mut ids = ids.clone();
        ids.push("viewer".into());
        assert_eq!(read_scope(&ids).unwrap().viewer, "viewer");
        ids[2] = "".into();
        assert!(read_scope(&ids).is_err());
        ids[2] = "viewer".into();
        ids.push("extra".into());
        assert!(read_scope(&ids).is_err());
        assert!(read_scope(&[]).is_err());
    }

    #[test]
    fn notification_snapshot_keeps_all_200_and_rejects_201_without_truncating() {
        let value = snapshot(200);
        assert!(validate_notifications(&value, Some("viewer")).is_ok());
        assert_eq!(value["notifications"].as_array().unwrap().len(), 200);
        assert!(validate_notifications(&snapshot(201), Some("viewer")).is_err());
        assert_eq!(
            validate_notifications(&value, Some("another")).unwrap_err(),
            CONFLICT
        );
        let mut value = snapshot(1);
        value["notifications"][0]["text"] = json!("日本語\n".repeat(1000));
        assert!(validate_notifications(&value, None).is_ok());
        value["notifications"][0]["receiverProfileId"] = json!("another");
        assert!(validate_notifications(&value, None).is_err());
    }

    #[test]
    fn notification_excerpt_is_optional_text_and_bounded() {
        let mut value = snapshot(1);
        value["notifications"][0]["excerpt"] = json!("元の投稿の本文の頭…");
        assert!(validate_notifications(&value, None).is_ok());
        for invalid in [json!(1), json!(null), json!("nul\0excerpt"), json!("a".repeat(MAX_EXCERPT + 1))] {
            value["notifications"][0]["excerpt"] = invalid;
            assert!(validate_notifications(&value, None).is_err());
        }
    }

    #[test]
    fn notification_metadata_flags_shapes_counts_and_duplicate_ids_are_not_coerced() {
        for invalid in [json!(-1), json!(1.5), json!(MAX_SAFE + 1), json!("1")] {
            let mut value = snapshot(1);
            value["unreadCount"] = invalid;
            assert!(validate_notifications(&value, None).is_err());
        }
        let mut value = snapshot(1);
        value["unreadCount"] = json!(MAX_SAFE);
        assert!(validate_notifications(&value, None).is_ok());
        for (key, invalid) in [
            ("isRead", json!(0)),
            ("context", json!("other")),
            ("createdAt", json!("2026-02-30")),
            ("targetId", json!(null)),
            ("text", json!("nul\0body")),
            ("actorProfileId", json!("a\n")),
        ] {
            let mut value = snapshot(1);
            value["notifications"][0][key] = invalid;
            assert!(validate_notifications(&value, None).is_err());
        }
        let mut value = snapshot(2);
        value["notifications"][1] = value["notifications"][0].clone();
        assert!(validate_notifications(&value, None).is_err());
        let mut value = snapshot(1);
        value["notifications"][0]["privateKey"] = json!("not allowed");
        assert!(validate_notifications(&value, None).is_err());
        let mut value = snapshot(1);
        value["privateBody"] = json!("not allowed");
        assert!(validate_notifications(&value, None).is_err());
        assert!(serde_json::from_slice::<Value>(b"{\"text\":\"\\ud800\"}").is_err());
    }

    #[test]
    fn actors_and_destination_maps_preserve_legacy_optional_fields_and_unicode() {
        let mut value = snapshot(1);
        value["actors"] = json!([{"id":"actor","handle":"name.test","displayName":"日本語","bio":"旧本文\n","joinedAt":"2026-10-07","avatarUrl":null,"isCurrentUser":false}]);
        value["threadPostDestinations"] = json!({"post1":"/threads/t?replies=post1#post-2"});
        assert!(validate_notifications(&value, None).is_ok());
        value["actors"][0]["email"] = json!("not allowed");
        assert!(validate_notifications(&value, None).is_err());
        let mut value = snapshot(0);
        value["actors"]=json!((0..201).map(|n|json!({"id":format!("actor{n}"),"handle":"actor","displayName":"Actor","bio":"","joinedAt":"2026-10-07"})).collect::<Vec<_>>());
        assert!(validate_notifications(&value, None).is_err());
        let mut value = snapshot(0);
        value["communityMessageDestinations"] = json!({});
        value["communityMessageDestinations"].as_object_mut().unwrap().insert(format!("scheduled:{UUID}"),json!(format!("/community?community=c&post=scheduled%3A{UUID}#scheduled%3A{UUID}")));
        assert!(validate_notifications(&value, None).is_ok());
        value["communityMessageDestinations"] = json!({"unknown:message":"/community"});
        assert!(validate_notifications(&value, None).is_err());
    }

    #[test]
    fn fixed_notification_requests_are_closed_and_unknown_actions_never_passthrough() {
        assert!(request_bytes(
            "read_notification",
            "/api/client/notifications",
            &json!({"id":"n".repeat(128)})
        )
        .is_ok());
        for body in [
            json!({"id":"n".repeat(129)}),
            json!({"id":"n\n"}),
            json!({"id":"n","expectedViewerId":"other"}),
            json!({"readAll":true}),
        ] {
            assert!(
                request_bytes("read_notification", "/api/client/notifications", &body).is_err()
            );
        }
        assert!(request_bytes(
            "read_all_notifications",
            "/api/client/notifications",
            &json!({"readAll":true})
        )
        .is_ok());
        assert!(request_bytes(
            "read_all_notifications",
            "/api/client/notifications",
            &json!({"readAll":false})
        )
        .is_err());
        for path in [
            "https://evil.example/api/client/notifications",
            "/api/client/notifications?other=true",
            "/api/client/notifications/../other",
        ] {
            assert!(
                request_bytes("read_all_notifications", path, &json!({"readAll":true})).is_err()
            );
        }
        assert!(request_bytes(
            "arbitrary_action",
            "/api/client/notifications",
            &json!({"readAll":true})
        )
        .is_err());
    }

    #[test]
    fn channel_request_uses_utf16_bound_and_never_truncates_or_adds_authority() {
        let mut value = body();
        value["body"] = json!("😀".repeat(1000));
        assert!(request_bytes("community_post", PATH, &value).is_ok());
        value["body"] = json!(format!("{}a", "😀".repeat(1000)));
        assert!(request_bytes("community_post", PATH, &value).is_err());
        value["body"] = json!("a".repeat(2001));
        assert!(request_bytes("community_post", PATH, &value).is_err());
        let mut value = body();
        value["expectedViewerId"] = json!("another");
        assert!(request_bytes("community_post", PATH, &value).is_err());
        for path in [
            "/api/client/communities/c/posts/extra",
            "/api/client/communities/%2e%2e/posts",
            "/api/client/communities/c/posts?x=y",
            "/api/client/communities/c/channels/ch/messages",
        ] {
            assert!(request_bytes("community_post", path, &body()).is_err());
        }
        let mut value = body();
        value["body"] = json!("\0".repeat(2000));
        assert!(
            request_bytes("community_post", PATH, &value)
                .unwrap()
                .len()
                < MAX_REQUEST
        );
    }

    #[test]
    fn images_scheduled_reply_and_request_id_are_closed_bounded_and_unique() {
        let mut value = body();
        value["replyToMessageId"] = json!(format!("scheduled:{UUID}"));
        assert!(request_bytes("community_post", PATH, &value).is_ok());
        for invalid in [
            format!("unknown:{UUID}"),
            format!("scheduled:{UUID}\n"),
            "é".repeat(23),
        ] {
            assert!(!message_id(&invalid));
        }
        let mut value = body();
        value["imageIds"] = json!([UUID, UUID]);
        assert!(request_bytes("community_post", PATH, &value).is_err());
        value["imageIds"] = json!([UUID, "bad"]);
        assert!(request_bytes("community_post", PATH, &value).is_err());
        value["imageIds"] = json!([UUID]);
        value["body"] = json!("");
        assert!(request_bytes("community_post", PATH, &value).is_ok());
        value["imageIds"] = json!([]);
        assert!(request_bytes("community_post", PATH, &value).is_err());
        let mut value = body();
        value["clientRequestId"] = json!("00000000-0000-4000-8000-00000000000x");
        assert!(request_bytes("community_post", PATH, &value).is_err());
    }

    #[test]
    fn mark_receipt_requires_exact_viewer_and_safe_count() {
        assert!(validate_ack(
            &json!({"viewerId":"viewer","unreadCount":0}),
            "read_notification",
            "/api/client/notifications",
            &json!({"id":"n"}),
            "viewer"
        )
        .is_ok());
        for value in [
            json!({"viewerId":"other","unreadCount":0}),
            json!({"viewerId":"viewer","unreadCount":"0"}),
            json!({"viewerId":"viewer","unreadCount":0,"private":true}),
        ] {
            assert!(validate_ack(
                &value,
                "read_all_notifications",
                "/api/client/notifications",
                &json!({"readAll":true}),
                "viewer"
            )
            .is_err());
        }
    }

    #[test]
    fn channel_receipt_is_bound_to_actual_request_and_independent_primary_identity_hash() {
        assert!(validate_ack(&ack(), "community_post", PATH, &body(), "viewer").is_ok());
        for (key, invalid) in [
            ("id", json!("wrong-request")),
            ("authorProfileId", json!("another")),
            ("communityId", json!("another")),
            ("body", json!("different")),
            ("kind", json!(null)),
            ("replyToMessageId", json!("unexpected")),
        ] {
            let mut value = ack();
            value["message"][key] = invalid;
            assert!(validate_ack(&value, "community_post", PATH, &body(), "viewer").is_err());
        }
        let mut value = ack();
        value["extra"] = json!("not allowed");
        assert!(validate_ack(&value, "community_post", PATH, &body(), "viewer").is_err());
        let mut value = ack();
        value["message"]["sourceBody"] = json!("not allowed");
        assert!(validate_ack(&value, "community_post", PATH, &body(), "viewer").is_err());
    }

    #[test]
    fn channel_receipt_requires_exact_image_set_and_existing_service_urls() {
        let mut request = body();
        request["imageIds"] = json!([UUID]);
        let mut value = ack();
        value["message"]["images"] = json!([{"id":UUID,"url":format!("/api/media/images/{UUID}?variant=thumbnail"),"fullUrl":format!("/api/media/images/{UUID}?variant=full"),"width":1600,"height":1,"altText":"<script>literal</script>"}]);
        assert!(validate_ack(&value, "community_post", PATH, &request, "viewer").is_ok());
        let mut changed = value.clone();
        changed["message"]["images"][0]["url"] = json!("https://external.example/image");
        assert!(validate_ack(&changed, "community_post", PATH, &request, "viewer").is_err());
        let mut changed = value.clone();
        changed["message"]["images"][0]["width"] = json!(1601);
        assert!(validate_ack(&changed, "community_post", PATH, &request, "viewer").is_err());
        let mut changed = value.clone();
        changed["message"]["images"] = json!([]);
        assert!(validate_ack(&changed, "community_post", PATH, &request, "viewer").is_err());
        let mut changed = value.clone();
        changed["message"]["images"]
            .as_array_mut()
            .unwrap()
            .push(value["message"]["images"][0].clone());
        assert!(validate_ack(&changed, "community_post", PATH, &request, "viewer").is_err());
    }

    #[test]
    fn response_real_byte_limit_is_checked_before_append_and_utf8_is_not_replaced() {
        let mut bytes = vec![0; MAX_REPLY - 1];
        append(&mut bytes, &[1]).unwrap();
        assert_eq!(bytes.len(), MAX_REPLY);
        assert!(append(&mut bytes, &[2]).is_err());
        assert_eq!(bytes.len(), MAX_REPLY);
        let mut oversized = vec![0; MAX_REPLY + 1];
        assert!(append(&mut oversized, &[]).is_err());
        assert!(serde_json::from_slice::<Value>(&[0xff]).is_err());
    }

    #[test]
    fn channel_http_failures_never_claim_no_effect_without_closed_scope_receipt() {
        for status in [400, 403, 404, 413, 429, 500, 503, 302, 307] {
            assert_eq!(status_error(status, true, None), "community_post_unknown");
        }
        assert_eq!(status_error(401, true, None), "desktop_not_connected");
        assert_eq!(
            status_error(
                409,
                true,
                Some(&json!({"error":"post_scope_changed"}))
            ),
            "community_post_scope_conflict"
        );
        for value in [
            json!({"error":"other"}),
            json!({"error":"post_scope_changed","extra":true}),
            json!(null),
        ] {
            assert_eq!(
                status_error(409, true, Some(&value)),
                "community_post_unknown"
            );
        }
        assert_eq!(status_error(409, true, None), "community_post_unknown");
        for status in [400, 403, 404, 413, 429] {
            assert_eq!(
                status_error(status, false, None),
                format!("notification_rejected:{status}")
            );
        }
        assert_eq!(status_error(409, false, None), CONFLICT);
        assert_eq!(
            channel_error(INVALID.into(), true),
            "community_post_rejected:400"
        );
    }
}

#[cfg(test)] mod configured_origin_tests {
 #[test] fn accepted_configured_url_normalizes_before_scope_comparison() {
  for base in ["https://hub.example", "https://hub.example/", "https://HUB.example:443/"] {
   assert!(super::same_origin(base, "https://hub.example"));
   assert!(!super::same_origin(base, "https://other.example"));
  }
  for base in ["https://hub.example/path", "https://user:pass@hub.example/", "https://hub.example/?q=x"] {
   assert!(!super::same_origin(base, "https://hub.example"));
  }
 }
}
