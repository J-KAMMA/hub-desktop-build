//! Managed feed create/lookup only. Claims are preconditions; Desktop assertion is authority.
use super::scoped_social_client::Scope;
use serde_json::{json, Map, Value};
use std::{collections::HashSet, time::Duration};
use unicode_normalization::UnicodeNormalization;
const INVALID: &str = "feed_operation_rejected:400";
const UNKNOWN: &str = "feed_operation_unknown";
const CONFLICT: &str = "feed_operation_scope_conflict";
const MAX_REPLY: usize = 2 * 1024 * 1024;
const MAX_REQUEST: usize = 16 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

fn closed<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    let value = value.as_object().ok_or(UNKNOWN)?;
    if required.iter().any(|key| !value.contains_key(*key))
        || value
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(UNKNOWN.into());
    }
    Ok(value)
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && uuid::Uuid::parse_str(value)
            .is_ok_and(|id| id.hyphenated().to_string() == value.to_ascii_lowercase())
}
fn request_uuid(value: &str) -> bool {
    uuid(value) && uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil())
}
fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn identity(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        !v.is_empty()
            && v.len() <= 128
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    })
}
fn text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|v| !v.contains('\0') && v.encode_utf16().count() <= max)
}
fn nullable_text(value: &Value, max: usize) -> bool {
    value.is_null() || text(value, max)
}
fn count(value: &Value) -> bool {
    value.as_u64().is_some_and(|v| v <= MAX_SAFE)
}
fn normalized(value: &Value) -> Result<String, String> {
    let raw = value.as_str().ok_or(INVALID)?;
    if raw.contains('\0') || raw.encode_utf16().count() > 500 {
        return Err(INVALID.into());
    }
    let body = raw
        .nfkc()
        .collect::<String>()
        .replace("\r\n", "\n")
        .trim_matches(whitespace)
        .to_owned();
    if body.encode_utf16().count() > 500 {
        return Err(INVALID.into());
    }
    Ok(body)
}
fn audience(value: Option<&Value>) -> Result<&str, String> {
    match value {
        None => Ok("public"),
        Some(Value::String(value)) if matches!(value.as_str(), "public" | "followers") => Ok(value),
        _ => Err(INVALID.into()),
    }
}
fn time(value: &Value) -> Option<i64> {
    let raw = value.as_str()?;
    if raw.is_empty() || raw.len() > 64 || !raw.is_ascii() || raw.chars().any(char::is_control) {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|v| v.timestamp_millis())
}
fn timestamp(value: &Value) -> bool {
    time(value).is_some()
        || value.as_str().is_some_and(|v| {
            v.len() == 19 && chrono::NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S").is_ok()
        })
}
fn input_images(value: Option<&Value>) -> Result<HashSet<String>, String> {
    let Some(value) = value else {
        return Ok(HashSet::new());
    };
    let images = value.as_array().filter(|v| v.len() <= 4).ok_or(INVALID)?;
    let mut seen = HashSet::new();
    for image in images {
        let id = image.as_str().filter(|v| uuid(v)).ok_or(INVALID)?;
        if !seen.insert(id.to_ascii_lowercase()) {
            return Err(INVALID.into());
        }
    }
    Ok(seen)
}
pub(super) fn managed(options: Option<&Value>) -> Result<bool, String> {
    let Some(options) = options else {
        return Ok(false);
    };
    let options = options.as_object().ok_or(INVALID)?;
    let count = ["expectedDeviceId", "expectedOrigin", "expectedViewerId"]
        .iter()
        .filter(|key| options.contains_key(**key))
        .count();
    match count {
        0 => Ok(false),
        3 => {
            Scope::from_options(&Value::Object(options.clone())).map_err(mapped)?;
            Ok(true)
        }
        _ => Err(INVALID.into()),
    }
}
fn request_bytes(path: &str, body: &Value) -> Result<Vec<u8>, String> {
    if path != "/api/client/posts" {
        return Err(INVALID.into());
    }
    let value = closed(
        body,
        &["body", "clientRequestId"],
        &["imageIds", "audience", "scheduledAt"],
    )
    .map_err(|_| INVALID)?;
    if !value["clientRequestId"].as_str().is_some_and(request_uuid) {
        return Err(INVALID.into());
    }
    let body_text = normalized(&value["body"])?;
    let images = input_images(value.get("imageIds"))?;
    audience(value.get("audience"))?;
    if body_text.is_empty() && images.is_empty() {
        return Err(INVALID.into());
    }
    if let Some(at) = value.get("scheduledAt") {
        if time(at).is_none() || body_text.is_empty() || !images.is_empty() {
            return Err(INVALID.into());
        }
    }
    let bytes = serde_json::to_vec(body).map_err(|_| INVALID)?;
    if bytes.len() > MAX_REQUEST {
        return Err(INVALID.into());
    }
    Ok(bytes)
}
fn post(value: &Value, viewer: &str, intent: Option<&Value>) -> Result<(), String> {
    let p = closed(
        value,
        &[
            "id",
            "body",
            "createdAt",
            "authorName",
            "authorHandle",
            "authorProfileId",
            "avatarUrl",
            "replyCount",
            "repostCount",
            "likeCount",
            "likedByViewer",
            "bookmarkedByViewer",
            "viewerRepostId",
            "images",
            "tags",
            "referenced",
            "audience",
        ],
        &[],
    )?;
    if !p["id"].as_str().is_some_and(uuid)
        || p["authorProfileId"].as_str() != Some(viewer)
        || !text(&p["body"], 500)
        || !timestamp(&p["createdAt"])
        || !text(&p["authorName"], 4096)
        || !nullable_text(&p["authorHandle"], 4096)
        || !nullable_text(&p["avatarUrl"], 4096)
        || ["replyCount", "repostCount", "likeCount"]
            .iter()
            .any(|key| !count(&p[*key]))
        || !p["likedByViewer"].is_boolean()
        || !p["bookmarkedByViewer"].is_boolean()
        || !p["viewerRepostId"].is_null()
        || !p["referenced"].is_null()
        || audience(Some(&p["audience"])).is_err()
    {
        return Err(UNKNOWN.into());
    }
    let tags = p["tags"]
        .as_array()
        .filter(|v| v.len() <= 256)
        .ok_or(UNKNOWN)?;
    if tags
        .iter()
        .any(|v| !text(v, 500) || v.as_str().is_none_or(str::is_empty))
    {
        return Err(UNKNOWN.into());
    }
    let images = p["images"]
        .as_array()
        .filter(|v| v.len() <= 4)
        .ok_or(UNKNOWN)?;
    let mut ids = HashSet::new();
    for image in images {
        let image = closed(image, &["id", "url", "width", "height", "altText"], &[])?;
        let id = image["id"].as_str().filter(|v| uuid(v)).ok_or(UNKNOWN)?;
        if !ids.insert(id.to_ascii_lowercase())
            || !text(&image["url"], 4096)
            || image["url"].as_str().is_none_or(str::is_empty)
            || !count(&image["width"])
            || !count(&image["height"])
            || !text(&image["altText"], 4096)
        {
            return Err(UNKNOWN.into());
        }
    }
    if let Some(intent) = intent {
        if p["body"].as_str() != Some(normalized(&intent["body"]).map_err(|_| UNKNOWN)?.as_str())
            || p["audience"].as_str()
                != Some(audience(intent.get("audience")).map_err(|_| UNKNOWN)?)
            || ids != input_images(intent.get("imageIds")).map_err(|_| UNKNOWN)?
        {
            return Err(UNKNOWN.into());
        }
    }
    Ok(())
}
fn scheduled(value: &Value, intent: Option<&Value>) -> Result<(), String> {
    let value = closed(
        value,
        &["id", "scheduledAt", "status", "body", "audience"],
        &[],
    )?;
    if !value["id"].as_str().is_some_and(uuid)
        || time(&value["scheduledAt"]).is_none()
        || !text(&value["body"], 500)
        || value["body"].as_str().is_none_or(|v| v.trim().is_empty())
        || !matches!(
            value["status"].as_str(),
            Some("scheduled" | "published" | "cancelled" | "failed")
        )
        || audience(Some(&value["audience"])).is_err()
    {
        return Err(UNKNOWN.into());
    }
    if let Some(intent) = intent {
        if value["body"].as_str()
            != Some(normalized(&intent["body"]).map_err(|_| UNKNOWN)?.as_str())
            || value["audience"].as_str()
                != Some(audience(intent.get("audience")).map_err(|_| UNKNOWN)?)
            || time(&value["scheduledAt"]) != time(&intent["scheduledAt"])
        {
            return Err(UNKNOWN.into());
        }
    }
    Ok(())
}
fn ack(
    value: &Value,
    viewer: &str,
    request_id: &str,
    kind: &str,
    intent: Option<&Value>,
    lookup: bool,
) -> Result<(), String> {
    let value = closed(
        value,
        &["viewerId", "clientRequestId", "post", "scheduled"],
        &[],
    )?;
    if value["viewerId"].as_str() != Some(viewer)
        || !value["clientRequestId"]
            .as_str()
            .is_some_and(|v| request_uuid(v) && v.eq_ignore_ascii_case(request_id))
    {
        return Err(UNKNOWN.into());
    }
    if value["post"].is_null() && value["scheduled"].is_null() {
        return if lookup { Ok(()) } else { Err(UNKNOWN.into()) };
    }
    match kind {
        "post" if value["scheduled"].is_null() && !value["post"].is_null() => {
            post(&value["post"], viewer, intent)
        }
        "scheduled" if value["post"].is_null() && !value["scheduled"].is_null() => {
            scheduled(&value["scheduled"], intent)
        }
        _ => Err(UNKNOWN.into()),
    }
}
fn mapped(error: String) -> String {
    match error.as_str() {
        "notification_scope_conflict" => CONFLICT.into(),
        "desktop_not_connected" => error,
        "notification_rejected:400" => INVALID.into(),
        _ => UNKNOWN.into(),
    }
}
fn response_error(status: u16, value: Option<&Value>, lookup: bool) -> String {
    if status == 401 {
        return "desktop_not_connected".into();
    }
    let error = value
        .filter(|v| closed(v, &["error"], &[]).is_ok())
        .and_then(|v| v["error"].as_str());
    if status == 409 && error == Some("feed_operation_scope_changed") {
        return CONFLICT.into();
    }
    if status == 409 && error == Some("feed_operation_request_conflict") {
        return "feed_operation_rejected:409".into();
    }
    if lookup && matches!(status, 400 | 403 | 404 | 413 | 429) {
        return format!("feed_operation_rejected:{status}");
    }
    UNKNOWN.into()
}
fn append(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if chunk.len() > MAX_REPLY.saturating_sub(bytes.len()) || bytes.len() > MAX_REPLY {
        return Err(UNKNOWN.into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
async fn request(
    base: &str,
    scope: &Scope,
    path: &str,
    body: Option<Vec<u8>>,
) -> Result<(u16, Value), String> {
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
    let lookup = body.is_none();
    let mut request = client
        .request(
            if lookup {
                reqwest::Method::GET
            } else {
                reqwest::Method::POST
            },
            format!("{}{path}", scope.origin),
        )
        .bearer_auth(assertion)
        .header(reqwest::header::ORIGIN, &scope.origin)
        .header("X-Hub-Expected-Viewer", &scope.viewer);
    if let Some(bytes) = body {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes);
    }
    let mut response = request.send().await.map_err(|_| UNKNOWN)?;
    scope.check(base).map_err(mapped)?;
    let status = response.status().as_u16();
    if !matches!(status, 200 | 201 | 202 | 409) {
        return Err(response_error(status, None, lookup));
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
        return Err(response_error(status, Some(&value), lookup));
    }
    Ok((status, value))
}
pub(super) async fn send(
    base: &str,
    path: &str,
    body: &Value,
    options: &Value,
) -> Result<Value, String> {
    let scope = Scope::from_options(options).map_err(mapped)?;
    let bytes = request_bytes(path, body)?;
    let id = body["clientRequestId"].as_str().ok_or(INVALID)?;
    let kind = if body.get("scheduledAt").is_some() {
        "scheduled"
    } else {
        "post"
    };
    let (status, value) = request(base, &scope, path, Some(bytes)).await?;
    if !match kind {
        "post" => matches!(status, 200 | 201),
        _ => matches!(status, 200 | 202),
    } {
        return Err(UNKNOWN.into());
    }
    ack(&value, &scope.viewer, id, kind, Some(body), false)?;
    scope.check(base).map_err(mapped)?;
    Ok(value)
}
fn read_scope(ids: &[String]) -> Result<(Scope, String), String> {
    if ids.len() != 5 || !request_uuid(&ids[3]) || !matches!(ids[4].as_str(), "post" | "scheduled")
    {
        return Err(INVALID.into());
    }
    let scope = Scope::from_options(
        &json!({"expectedDeviceId":ids[0],"expectedOrigin":ids[1],"expectedViewerId":ids[2]}),
    )
    .map_err(mapped)?;
    Ok((
        scope,
        format!("/api/client/posts/request/{}?kind={}", ids[3], ids[4]),
    ))
}
pub(super) async fn read(base: &str, ids: &[String]) -> Result<Value, String> {
    let (scope, path) = read_scope(ids)?;
    let (status, value) = request(base, &scope, &path, None).await?;
    if status != 200 {
        return Err(UNKNOWN.into());
    }
    ack(&value, &scope.viewer, &ids[3], &ids[4], None, true)?;
    scope.check(base).map_err(mapped)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    const REQUEST: &str = "11111111-2222-4333-8444-555555555555";
    const POST: &str = "11111111-2222-4333-8444-666666666666";
    const IMAGE: &str = "11111111-2222-4333-8444-777777777777";
    fn scope() -> Value {
        json!({"expectedDeviceId":"device-1","expectedOrigin":"https://hub.example","expectedViewerId":"viewer-1"})
    }
    fn intent() -> Value {
        json!({"body":" Ａ <script>literal</script> ","clientRequestId":REQUEST,"audience":"followers"})
    }
    fn post_ack() -> Value {
        json!({"viewerId":"viewer-1","clientRequestId":REQUEST,"scheduled":null,"post":{"id":POST,"body":"A <script>literal</script>","createdAt":"2026-10-07T00:00:00.000Z","authorName":"Author","authorHandle":null,"authorProfileId":"viewer-1","avatarUrl":null,"replyCount":0,"repostCount":0,"likeCount":0,"likedByViewer":false,"bookmarkedByViewer":false,"viewerRepostId":null,"images":[],"tags":[],"referenced":null,"audience":"followers"}})
    }
    fn scheduled_intent() -> Value {
        json!({"body":"予定本文","clientRequestId":REQUEST,"scheduledAt":"2026-10-08T09:00:00+09:00"})
    }
    fn scheduled_ack() -> Value {
        json!({"viewerId":"viewer-1","clientRequestId":REQUEST,"post":null,"scheduled":{"id":POST,"scheduledAt":"2026-10-08T00:00:00.000Z","status":"scheduled","body":"予定本文","audience":"public"}})
    }
    #[test]
    fn managed_detection_preserves_legacy_and_rejects_partial_or_invalid_claims() {
        assert_eq!(managed(None).unwrap(), false);
        assert_eq!(managed(Some(&json!({"audience":"public"}))).unwrap(), false);
        assert_eq!(managed(Some(&scope())).unwrap(), true);
        for key in ["expectedDeviceId", "expectedOrigin", "expectedViewerId"] {
            let mut value = scope();
            value.as_object_mut().unwrap().remove(key);
            assert!(managed(Some(&value)).is_err());
        }
        let mut value = scope();
        value["expectedViewerId"] = json!("viewer-1\n");
        assert!(managed(Some(&value)).is_err());
        value = scope();
        value["expectedOrigin"] = json!("https://hub.example/path");
        assert!(managed(Some(&value)).is_err());
        value = scope();
        value["expectedDeviceId"] = Value::Null;
        assert!(managed(Some(&value)).is_err());
    }
    #[test]
    fn fixed_body_and_path_are_closed_with_authority_fields_never_transmitted() {
        assert!(request_bytes("/api/client/posts", &intent()).is_ok());
        for path in [
            "https://outside.example/api/client/posts",
            "/api/client/posts?actor=x",
            "/api/client/posts/../images",
        ] {
            assert!(request_bytes(path, &intent()).is_err());
        }
        for key in [
            "viewerId",
            "hubSubject",
            "expectedOrigin",
            "replyToPostId",
            "access",
        ] {
            let mut value = intent();
            value[key] = json!("untrusted");
            assert!(request_bytes("/api/client/posts", &value).is_err());
        }
        for value in [json!(null), json!([]), json!({"body":"text"})] {
            assert!(request_bytes("/api/client/posts", &value).is_err());
        }
    }
    #[test]
    fn raw_and_nfkc_utf16_bounds_are_inclusive_and_never_cut_text() {
        let mut value = intent();
        value["body"] = json!("😀".repeat(250));
        assert!(request_bytes("/api/client/posts", &value).is_ok());
        for body in [
            "😀".repeat(250) + "x",
            "x".repeat(501),
            "㍿".repeat(126),
            "a\0b".into(),
            " ".into(),
        ] {
            value["body"] = json!(body);
            assert!(request_bytes("/api/client/posts", &value).is_err());
        }
        value["body"] = json!("\u{1}".repeat(500));
        let bytes = request_bytes("/api/client/posts", &value).unwrap();
        assert!(bytes.len() > 3000 && bytes.len() < MAX_REQUEST);
        let decoded: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded["body"], value["body"]);
    }
    #[test]
    fn image_only_posts_four_image_boundary_duplicates_and_text_only_schedule() {
        let mut value = intent();
        value["body"] = json!("");
        value["imageIds"] = json!([IMAGE]);
        assert!(request_bytes("/api/client/posts", &value).is_ok());
        value["imageIds"] = json!([IMAGE, IMAGE.to_ascii_uppercase()]);
        assert!(request_bytes("/api/client/posts", &value).is_err());
        let ids = (0..4)
            .map(|n| format!("11111111-2222-4333-8444-{n:012}"))
            .collect::<Vec<_>>();
        value["imageIds"] = json!(ids);
        assert!(request_bytes("/api/client/posts", &value).is_ok());
        value["imageIds"].as_array_mut().unwrap().push(json!(POST));
        assert!(request_bytes("/api/client/posts", &value).is_err());
        value = scheduled_intent();
        value["imageIds"] = json!([IMAGE]);
        assert!(request_bytes("/api/client/posts", &value).is_err());
        value["imageIds"] = json!([]);
        assert!(request_bytes("/api/client/posts", &value).is_ok());
        for date in [Value::Null, json!("bad"), json!("2026-10-08T00:00:00Z\n")] {
            value["scheduledAt"] = date;
            assert!(request_bytes("/api/client/posts", &value).is_err());
        }
    }
    #[test]
    fn post_ack_actual_seventeen_field_shape_actor_uuid_body_audience_and_images_match() {
        let value = post_ack();
        assert_eq!(value["post"].as_object().unwrap().len(), 17);
        ack(&value, "viewer-1", REQUEST, "post", Some(&intent()), false).unwrap();
        for (key, value) in [
            ("authorProfileId", json!("other")),
            ("body", json!("changed")),
            ("audience", json!("public")),
            ("author", json!({"id":"viewer-1"})),
            ("id", json!("invalid")),
            ("createdAt", json!("invalid")),
            ("likeCount", json!(-1)),
            ("likedByViewer", json!(1)),
            ("viewerRepostId", json!(POST)),
            ("referenced", json!({"body":"other"})),
        ] {
            let mut wrong = post_ack();
            wrong["post"][key] = value;
            assert!(ack(&wrong, "viewer-1", REQUEST, "post", Some(&intent()), false).is_err());
        }
        let mut input = intent();
        input["imageIds"] = json!([IMAGE]);
        let mut result = post_ack();
        assert!(ack(&result, "viewer-1", REQUEST, "post", Some(&input), false).is_err());
        result["post"]["images"] = json!([{"id":IMAGE,"url":format!("/api/images/{IMAGE}"),"width":640,"height":480,"altText":"literal <img>"}]);
        ack(&result, "viewer-1", REQUEST, "post", Some(&input), false).unwrap();
        result["post"]["images"][0]["id"] = json!(POST);
        assert!(ack(&result, "viewer-1", REQUEST, "post", Some(&input), false).is_err());
    }
    #[test]
    fn scheduled_receipt_time_is_js_millis_equivalent_and_preserves_terminal_status() {
        let input = scheduled_intent();
        let result = scheduled_ack();
        ack(
            &result,
            "viewer-1",
            REQUEST,
            "scheduled",
            Some(&input),
            false,
        )
        .unwrap();
        for status in ["scheduled", "published", "cancelled", "failed"] {
            let mut result = scheduled_ack();
            result["scheduled"]["status"] = json!(status);
            ack(
                &result,
                "viewer-1",
                REQUEST,
                "scheduled",
                Some(&input),
                true,
            )
            .unwrap();
        }
        for (key, value) in [
            ("body", json!("different")),
            ("audience", json!("followers")),
            ("scheduledAt", json!("2026-10-08T00:00:00.001Z")),
            ("status", json!("accepted")),
            ("authorProfileId", json!("claim")),
        ] {
            let mut wrong = scheduled_ack();
            wrong["scheduled"][key] = value;
            assert!(ack(
                &wrong,
                "viewer-1",
                REQUEST,
                "scheduled",
                Some(&input),
                false
            )
            .is_err());
        }
    }
    #[test]
    fn lookup_grammar_is_fixed_actor_request_kind_and_only_lookup_allows_both_null() {
        let ids = [
            "device-1",
            "https://hub.example",
            "viewer-1",
            REQUEST,
            "post",
        ]
        .map(String::from);
        let (_, path) = read_scope(&ids).unwrap();
        assert_eq!(
            path,
            format!("/api/client/posts/request/{REQUEST}?kind=post")
        );
        for (index, value) in [
            (3, format!("{REQUEST}\n")),
            (3, "../outside".into()),
            (4, "post&actor=other".into()),
            (2, "".into()),
        ] {
            let mut wrong = ids.clone();
            wrong[index] = value;
            assert!(read_scope(&wrong).is_err());
        }
        let result =
            json!({"viewerId":"viewer-1","clientRequestId":REQUEST,"post":null,"scheduled":null});
        assert!(ack(&result, "viewer-1", REQUEST, "post", None, true).is_ok());
        assert!(ack(&result, "viewer-1", REQUEST, "post", None, false).is_err());
        assert!(ack(&post_ack(), "other", REQUEST, "post", None, true).is_err());
        assert!(ack(&post_ack(), "viewer-1", POST, "post", None, true).is_err());
        assert!(ack(&post_ack(), "viewer-1", REQUEST, "scheduled", None, true).is_err());
        let mut result = post_ack();
        result["scheduled"] = scheduled_ack()["scheduled"].clone();
        assert!(ack(&result, "viewer-1", REQUEST, "post", None, true).is_err());
    }
    #[test]
    fn postwrite_errors_are_unknown_except_closed_scope_or_immutable_conflict_or_auth() {
        for status in [400, 403, 404, 413, 429, 500] {
            assert_eq!(response_error(status, None, false), UNKNOWN);
        }
        assert_eq!(
            response_error(
                409,
                Some(&json!({"error":"feed_operation_scope_changed"})),
                false
            ),
            CONFLICT
        );
        assert_eq!(
            response_error(
                409,
                Some(&json!({"error":"feed_operation_request_conflict"})),
                false
            ),
            "feed_operation_rejected:409"
        );
        assert_eq!(
            response_error(
                409,
                Some(&json!({"error":"feed_operation_scope_changed","raw":"private"})),
                false
            ),
            UNKNOWN
        );
        assert_eq!(response_error(401, None, false), "desktop_not_connected");
        assert_eq!(
            response_error(404, None, true),
            "feed_operation_rejected:404"
        );
    }
    #[test]
    fn actual_reply_bytes_are_inclusive_and_overflow_does_not_append() {
        let mut bytes = vec![0; MAX_REPLY - 1];
        append(&mut bytes, &[1]).unwrap();
        assert_eq!(bytes.len(), MAX_REPLY);
        assert!(append(&mut bytes, &[1]).is_err());
        assert_eq!(bytes.len(), MAX_REPLY);
    }
    #[test]
    fn canonical_body_nfkc_crlf_lf_and_js_trim_match_ack_without_relaxing_raw_bound() {
        assert_eq!(
            normalized(&json!("\u{feff} Ａ\r\nＢ \u{feff}")).unwrap(),
            "A\nB"
        );
        assert_eq!(
            normalized(&json!("\u{85}value\u{85}")).unwrap(),
            "\u{85}value\u{85}"
        );
        let mut input = intent();
        input["body"] = json!(" Ａ\r\nＢ ");
        let mut result = post_ack();
        result["post"]["body"] = json!("A\nB");
        ack(&result, "viewer-1", REQUEST, "post", Some(&input), false).unwrap();
        let raw = "A\r\n".repeat(166) + "aa";
        assert_eq!(raw.encode_utf16().count(), 500);
        input["body"] = json!(raw);
        assert!(request_bytes("/api/client/posts", &input).is_ok());
        input["body"] = json!(input["body"].as_str().unwrap().to_owned() + "a");
        assert!(request_bytes("/api/client/posts", &input).is_err());
    }
    #[test]
    fn request_uuid_nil_and_noncanonical_shape_are_rejected_in_send_lookup_and_ack() {
        const NIL: &str = "00000000-0000-0000-0000-000000000000";
        assert!(request_uuid(REQUEST));
        assert!(request_uuid(&REQUEST.to_ascii_uppercase()));
        for value in [
            NIL,
            "11111111222243338444555555555555",
            "{11111111-2222-4333-8444-555555555555}",
            "11111111-2222-4333-8444-555555555555\n",
        ] {
            assert!(!request_uuid(value));
        }
        let mut input = intent();
        input["clientRequestId"] = json!(NIL);
        assert!(request_bytes("/api/client/posts", &input).is_err());
        let ids = ["device-1", "https://hub.example", "viewer-1", NIL, "post"].map(String::from);
        assert!(read_scope(&ids).is_err());
        let mut result = post_ack();
        result["clientRequestId"] = json!(NIL);
        assert!(ack(&result, "viewer-1", NIL, "post", None, true).is_err());
    }
}
