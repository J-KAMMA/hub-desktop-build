//! Fixed read-only social stream. Never accepts caller URLs, headers or assertions.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, SecondsFormat};
use serde_json::{Map, Value};
use std::{collections::HashSet, time::Duration};
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const INVALID: &str = "social_stream_invalid_request";
const BAD_CURSOR: &str = "social_stream_invalid_cursor";
const BAD_REPLY: &str = "social_stream_invalid_response";
const DENIED: &str = "social_stream_access_denied";
const CHANGED: &str = "social_stream_scope_changed";
const UNAVAILABLE: &str = "social_stream_unavailable";
const AUTH_UNAVAILABLE: &str = "social_stream_auth_unavailable";
const KINDS: [&str; 3] = ["post", "thread", "community_post"];
fn exact<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    let value = value.as_object().ok_or(BAD_REPLY)?;
    if required.iter().any(|k| !value.contains_key(*k))
        || value
            .keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err(BAD_REPLY.into());
    }
    Ok(value)
}
fn id(raw: &str, max: usize) -> bool {
    !raw.is_empty()
        && raw.len() <= max
        && raw.as_bytes()[0].is_ascii_alphanumeric()
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn string(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|v| v.encode_utf16().count() <= max && !v.contains('\0'))
}
fn identifier(value: &Value) -> bool {
    value.as_str().is_some_and(|v| id(v, 200))
}
fn nullable_id(value: &Value) -> bool {
    value.is_null() || identifier(value)
}
fn nullable_string(value: &Value, max: usize) -> bool {
    value.is_null() || string(value, max)
}
fn integer(value: &Value, max: u64) -> Option<u64> {
    value.as_u64().filter(|v| *v <= max).or_else(|| {
        value
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0 && *v <= max as f64 && v.fract() == 0.0)
            .map(|v| v as u64)
    })
}
fn timestamp(raw: &str, canonical: bool) -> bool {
    if raw.len() > 40 || !raw.is_ascii() { return false; }
    let source = raw.replace(' ', "T");
    let source = source.strip_suffix('Z').unwrap_or(&source);
    let (head, fraction) = source.split_once('.').unwrap_or((source, ""));
    if fraction.len() > 9 || !fraction.bytes().all(|b| b.is_ascii_digit()) || source.contains('.') && fraction.is_empty() { return false; }
    if head.len() == 10 && raw.len() != 10 { return false; }
    let head = if head.len() == 10 { format!("{head}T00:00:00") } else if head.len() == 19 { head.into() } else { return false; };
    let millis = format!("{fraction}000")[..3].to_owned();
    let normalized = format!("{head}.{millis}Z");
    if canonical && normalized != raw { return false; }
    DateTime::parse_from_rfc3339(&normalized).is_ok_and(|date| date.timestamp_subsec_nanos() < 1_000_000_000 && date.to_rfc3339_opts(SecondsFormat::Millis, true) == normalized)
}

fn origin(raw: &str) -> Result<String, String> {
    if raw.len() > 512 || raw.chars().any(char::is_control) {
        return Err(INVALID.into());
    }
    let value = crate::hub_network::origin(raw).map_err(|_| INVALID)?;
    Ok(value)
}
fn public_origin(raw: &str) -> bool {
    origin(raw).is_ok_and(|value| value == raw)
}
fn url(value: &Value) -> bool {
    let Some(raw) = value.as_str().filter(|_| string(value, 8192)) else {
        return false;
    };
    if raw.is_empty() || raw.chars().any(char::is_control) || raw.contains('\\') {
        return false;
    }
    if raw.starts_with('/') && !raw.starts_with("//") {
        return !raw
            .split(['?', '#'])
            .next()
            .unwrap_or("")
            .split('/')
            .any(|v| matches!(v, "." | ".."));
    }
    reqwest::Url::parse(raw).is_ok_and(|v| {
        matches!(v.scheme(), "https" | "http")
            && v.host_str().is_some()
            && v.username().is_empty()
            && v.password().is_none()
    })
}
fn nullable_url(value: &Value) -> bool {
    value.is_null() || url(value)
}
fn kinds(filter: &str) -> Option<Vec<&'static str>> {
    match filter {
        "all" => Some(KINDS.to_vec()),
        "post" => Some(vec!["post"]),
        "thread" => Some(vec!["thread"]),
        "community" => Some(vec!["community_post"]),
        _ => None,
    }
}
fn cursor(
    raw: &str,
    filter: &str,
    scope: &str,
    viewer: Option<&str>,
    base: &str,
    bind_viewer: bool,
) -> Result<(), String> {
    if raw.is_empty()
        || raw.len() > 4096
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(BAD_CURSOR.into());
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| BAD_CURSOR)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != raw {
        return Err(BAD_CURSOR.into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| BAD_CURSOR)?;
    let v = exact(
        &value,
        &["version", "filter", "scope", "viewerId", "origin", "lanes"],
        &[],
    )
    .map_err(|_| BAD_CURSOR)?;
    if integer(&v["version"], 1) != Some(1)
        || v["filter"] != filter
        || v["scope"] != scope
        || v["origin"] != base
        || !(v["viewerId"].is_null() || v["viewerId"].as_str().is_some_and(|v| id(v, 128)))
        || bind_viewer && v["viewerId"].as_str() != viewer
    {
        return Err(BAD_CURSOR.into());
    }
    let lanes = exact(&v["lanes"], &KINDS, &[]).map_err(|_| BAD_CURSOR)?;
    for kind in KINDS {
        let lane = exact(&lanes[kind], &["after", "done"], &[]).map_err(|_| BAD_CURSOR)?;
        if !lane["done"].is_boolean() {
            return Err(BAD_CURSOR.into());
        }
        if !lane["after"].is_null() {
            let position =
                exact(&lane["after"], &["createdAt", "id"], &[]).map_err(|_| BAD_CURSOR)?;
            if !identifier(&position["id"])
                || !position["createdAt"]
                    .as_str()
                    .is_some_and(|v| timestamp(v, false))
            {
                return Err(BAD_CURSOR.into());
            }
        }
    }
    Ok(())
}
fn request_url(
    base: &str,
    filter: &str,
    scope: &str,
    limit: u32,
    next: Option<&str>,
) -> Result<String, String> {
    if kinds(filter).is_none()
        || !matches!(scope, "latest" | "following")
        || !(1..=40).contains(&limit)
    {
        return Err(INVALID.into());
    }
    let base = origin(base)?;
    if let Some(next) = next {
        cursor(next, filter, scope, None, &base, false)?;
    }
    let mut url =
        reqwest::Url::parse(&format!("{base}/api/client/social-stream")).map_err(|_| INVALID)?;
    let mut query = url.query_pairs_mut();
    query
        .append_pair("filter", filter)
        .append_pair("scope", scope)
        .append_pair("limit", &limit.to_string());
    if let Some(next) = next {
        query.append_pair("cursor", next);
    }
    drop(query);
    Ok(url.into())
}
fn post(value: &Value, item_id: &str, created_at: &str) -> Result<(), String> {
    let p = exact(
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
            "identityMode",
            "replyToPostId",
        ],
        &[],
    )?;
    if p["id"] != item_id
        || p["createdAt"] != created_at
        || !string(&p["body"], 40000)
        || !string(&p["authorName"], 160)
        || !nullable_string(&p["authorHandle"], 64)
        || !nullable_id(&p["authorProfileId"])
        || !nullable_url(&p["avatarUrl"])
        || !nullable_id(&p["viewerRepostId"])
        || !nullable_id(&p["replyToPostId"])
        || ["replyCount", "repostCount", "likeCount"]
            .iter()
            .any(|k| integer(&p[*k], MAX_SAFE).is_none())
        || !p["likedByViewer"].is_boolean()
        || !p["bookmarkedByViewer"].is_boolean()
    {
        return Err(BAD_REPLY.into());
    }
    match p["identityMode"].as_str() {
        Some("account") => {}
        Some("anonymous" | "guest")
            if p["authorProfileId"].is_null()
                && p["authorHandle"].is_null()
                && p["avatarUrl"].is_null() => {}
        _ => return Err(BAD_REPLY.into()),
    }
    let images = p["images"]
        .as_array()
        .filter(|v| v.len() <= 4)
        .ok_or(BAD_REPLY)?;
    let mut image_ids = HashSet::new();
    for image in images {
        let image = exact(image, &["id", "url", "width", "height", "altText"], &[])?;
        if !identifier(&image["id"])
            || !image_ids.insert(image["id"].as_str().unwrap())
            || !url(&image["url"])
            || integer(&image["width"], MAX_SAFE).is_none()
            || integer(&image["height"], MAX_SAFE).is_none()
            || !string(&image["altText"], 1000)
        {
            return Err(BAD_REPLY.into());
        }
    }
    let tags = p["tags"]
        .as_array()
        .filter(|v| v.len() <= 50)
        .ok_or(BAD_REPLY)?;
    if tags
        .iter()
        .any(|v| !string(v, 256) || v.as_str().is_none_or(str::is_empty))
    {
        return Err(BAD_REPLY.into());
    }
    if !p["referenced"].is_null() {
        let reference = exact(
            &p["referenced"],
            &["label", "title", "body", "href"],
            &["contextLabel"],
        )?;
        if !string(&reference["label"], 1000)
            || !string(&reference["title"], 1000)
            || !string(&reference["body"], 40000)
            || !url(&reference["href"])
            || reference
                .get("contextLabel")
                .is_some_and(|v| !string(v, 1000))
        {
            return Err(BAD_REPLY.into());
        }
    }
    Ok(())
}
fn thread(value: &Value, item_id: &str) -> Result<(), String> {
    let p = exact(
        value,
        &[
            "id",
            "title",
            "boardKey",
            "postCount",
            "threadType",
            "status",
            "updatedAt",
        ],
        &[],
    )?;
    if p["id"] != item_id
        || !string(&p["title"], 480)
        || !identifier(&p["boardKey"])
        || integer(&p["postCount"], MAX_SAFE).is_none()
        || !matches!(
            p["threadType"].as_str(),
            Some("question" | "information" | "discussion" | "recruitment" | "issue" | "chat")
        )
        || !matches!(p["status"].as_str(), Some("open" | "closed"))
        || !p["updatedAt"].as_str().is_some_and(|v| timestamp(v, true))
    {
        return Err(BAD_REPLY.into());
    }
    Ok(())
}
fn community(value: &Value, item_id: &str, created_at: &str) -> Result<(), String> {
    let p = exact(
        value,
        &[
            "id",
            "communityId",
            "communityName",
            "body",
            "createdAt",
            "authorName",
            "authorHandle",
            "replyCount",
            "likeCount",
            "kind",
        ],
        &[],
    )?;
    if p["id"] != item_id
        || p["createdAt"] != created_at
        || !identifier(&p["communityId"])
        || !string(&p["communityName"], 200)
        || !string(&p["body"], 4000)
        || !string(&p["authorName"], 160)
        || !nullable_string(&p["authorHandle"], 64)
        || ["replyCount", "likeCount"]
            .iter()
            .any(|k| integer(&p[*k], MAX_SAFE).is_none())
        || !matches!(
            p["kind"].as_str(),
            Some("chat" | "guide" | "question" | "party")
        )
    {
        return Err(BAD_REPLY.into());
    }
    Ok(())
}
fn validate(
    value: &Value,
    base: &str,
    filter: &str,
    scope: &str,
    limit: u32,
    authenticated: bool,
) -> Result<(), String> {
    let r = exact(
        value,
        &[
            "version",
            "filter",
            "scope",
            "viewerId",
            "signedIn",
            "items",
            "hasMore",
            "nextCursor",
            "failures",
        ],
        &[],
    )?;
    if integer(&r["version"], 1) != Some(1)
        || r["filter"] != filter
        || r["scope"] != scope
        || !r["hasMore"].is_boolean()
    {
        return Err(BAD_REPLY.into());
    }
    let signed_in = r["signedIn"].as_bool().ok_or(BAD_REPLY)?;
    if signed_in != authenticated {
        return Err(DENIED.into());
    }
    let viewer = r["viewerId"].as_str();
    if if authenticated {
        !viewer.is_some_and(|v| id(v, 128))
    } else {
        !r["viewerId"].is_null()
    } {
        return Err(DENIED.into());
    }
    let allowed = kinds(filter).ok_or(BAD_REPLY)?;
    let items = r["items"]
        .as_array()
        .filter(|v| v.len() <= limit as usize && v.len() <= 50)
        .ok_or(BAD_REPLY)?;
    let mut seen = HashSet::new();
    let mut previous: Option<(&str, usize, &str)> = None;
    for item in items {
        let item = exact(item, &["kind", "id", "createdAt", "origin", "payload"], &[])?;
        let kind = item["kind"]
            .as_str()
            .filter(|v| allowed.contains(v))
            .ok_or(BAD_REPLY)?;
        let item_id = item["id"]
            .as_str()
            .filter(|v| id(v, 200))
            .ok_or(BAD_REPLY)?;
        let at = item["createdAt"]
            .as_str()
            .filter(|v| timestamp(v, true))
            .ok_or(BAD_REPLY)?;
        if item["origin"].as_str() != Some(base)
            || !public_origin(base)
            || !seen.insert((kind, item_id))
        {
            return Err(BAD_REPLY.into());
        }
        let rank = KINDS.iter().position(|v| *v == kind).ok_or(BAD_REPLY)?;
        if previous.is_some_and(|(p_at, p_rank, p_id)| {
            at > p_at || at == p_at && (rank < p_rank || rank == p_rank && item_id >= p_id)
        }) {
            return Err(BAD_REPLY.into());
        }
        previous = Some((at, rank, item_id));
        match kind {
            "post" => post(&item["payload"], item_id, at)?,
            "thread" => thread(&item["payload"], item_id)?,
            _ => community(&item["payload"], item_id, at)?,
        };
    }
    let failures = r["failures"]
        .as_array()
        .filter(|v| v.len() <= 3)
        .ok_or(BAD_REPLY)?;
    let mut seen = HashSet::new();
    for failure in failures {
        let failure = failure
            .as_str()
            .filter(|v| allowed.contains(v))
            .ok_or(BAD_REPLY)?;
        if !seen.insert(failure) {
            return Err(BAD_REPLY.into());
        }
    }
    match (r["hasMore"].as_bool(), r["nextCursor"].as_str()) {
        (Some(true), Some(next)) => {
            cursor(next, filter, scope, viewer, base, true).map_err(|_| BAD_REPLY)?
        }
        (Some(false), None) if r["nextCursor"].is_null() && failures.is_empty() => {}
        _ => return Err(BAD_REPLY.into()),
    }
    if !authenticated
        && scope == "following"
        && (!items.is_empty() || r["hasMore"] != false || !failures.is_empty())
    {
        return Err(BAD_REPLY.into());
    }
    Ok(())
}
#[derive(Clone, PartialEq, Eq)]
struct Binding {
    base: String,
    registered: bool,
    device: Option<String>,
    thumbprint: Option<String>,
}
fn auth_error(raw: &str) -> String {
    match raw {
        "desktop_account_key_invalid"
        | "desktop_account_state_invalid"
        | "desktop_account_unauthorized"
        | "desktop_account_request_expired"
        | "desktop_account_not_registered"
        | "desktop_account_signed_out"
        | "device_proof_rejected" => DENIED.into(),
        _ => AUTH_UNAVAILABLE.into(),
    }
}
fn binding(
    base: &str,
    state: &str,
    device: Option<String>,
    thumbprint: Option<String>,
) -> Result<Binding, String> {
    let registered = state == "registered";
    if !matches!(state, "registered" | "signed_out" | "pending" | "expired")
        || registered && (!device.as_deref().is_some_and(|v| id(v, 128)) || thumbprint.is_none())
        || !registered && device.is_some()
        || thumbprint.as_ref().is_some_and(|v| {
            v.len() != 43
                || !URL_SAFE_NO_PAD
                    .decode(v)
                    .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == *v)
        })
    {
        return Err(DENIED.into());
    }
    Ok(Binding {
        base: base.into(),
        registered,
        device,
        thumbprint,
    })
}
fn capture(base: &str) -> Result<Binding, String> {
    let base = origin(base)?;
    if origin(&crate::hub_origin())? != base {
        return Err(CHANGED.into());
    }
    let status = crate::desktop_account::status(&base).map_err(|error| auth_error(&error))?;
    binding(&base, status.state, status.device_id, status.key_thumbprint)
}
fn check(before: &Binding) -> Result<(), String> {
    if capture(&before.base)? != *before {
        return Err(CHANGED.into());
    }
    Ok(())
}
fn append(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BYTES || chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
        return Err("social_stream_too_large".into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
pub(super) async fn read(
    base: &str,
    filter: &str,
    scope: &str,
    limit: u32,
    next: Option<&str>,
) -> Result<Value, String> {
    let url = request_url(base, filter, scope, limit, next)?;
    let before = capture(base)?;
    let assertion = crate::desktop_account::assertion_if_registered(&before.base)
        .await
        .map_err(|error| auth_error(&error))?;
    check(&before)?;
    if before.registered != assertion.is_some() {
        return Err(DENIED.into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| UNAVAILABLE)?;
    let mut request = client.get(url).header("X-Hub-Client", "desktop");
    if let Some(assertion) = assertion {
        request = request.bearer_auth(assertion);
    }
    let mut response = request.send().await.map_err(|_| UNAVAILABLE)?;
    check(&before)?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(DENIED.into());
    }
    if response.status().as_u16() == 400 {
        return Err(INVALID.into());
    }
    if response.status().as_u16() != 200 {
        return Err(UNAVAILABLE.into());
    }
    if response
        .content_length()
        .is_some_and(|v| v > MAX_BYTES as u64)
    {
        return Err("social_stream_too_large".into());
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
    {
        return Err(BAD_REPLY.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        append(&mut bytes, &chunk)?;
    }
    check(&before)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| BAD_REPLY)?;
    validate(
        &value,
        &before.base,
        filter,
        scope,
        limit,
        before.registered,
    )?;
    check(&before)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const BASE: &str = "https://hub.example";
    const AT: &str = "2026-10-07T00:00:00.000Z";
    fn page() -> Value {
        json!({"version":1,"filter":"all","scope":"latest","viewerId":null,"signedIn":false,"items":[],"hasMore":false,"nextCursor":null,"failures":[]})
    }
    fn post_item() -> Value {
        json!({"kind":"post","id":"post-1","createdAt":AT,"origin":BASE,"payload":{"id":"post-1","body":"literal <script>内容</script>","createdAt":AT,"authorName":"公開著者","authorHandle":null,"authorProfileId":"author-1","avatarUrl":null,"replyCount":0,"repostCount":0,"likeCount":0,"likedByViewer":false,"bookmarkedByViewer":false,"viewerRepostId":null,"images":[],"tags":[],"referenced":null,"identityMode":"account","replyToPostId":null}})
    }
    fn thread_item() -> Value {
        json!({"kind":"thread","id":"thread-1","createdAt":AT,"origin":BASE,"payload":{"id":"thread-1","title":"議論","boardKey":"general","postCount":1,"threadType":"discussion","status":"open","updatedAt":AT}})
    }
    fn community_item() -> Value {
        json!({"kind":"community_post","id":"scheduled:11111111-2222-4333-8444-555555555555","createdAt":AT,"origin":BASE,"payload":{"id":"scheduled:11111111-2222-4333-8444-555555555555","communityId":"c-1","communityName":"公開community","body":"literal body","createdAt":AT,"authorName":"著者","authorHandle":null,"replyCount":0,"likeCount":0,"kind":"chat"}})
    }
    fn token(viewer: Value) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"version":1,"filter":"all","scope":"latest","viewerId":viewer,"origin":BASE,"lanes":{"post":{"after":null,"done":false},"thread":{"after":null,"done":false},"community_post":{"after":null,"done":false}}})).unwrap())
    }
    #[test]
    fn query_is_fixed_filter_scope_limit_and_never_accepts_urls_or_silently_truncates_cursor() {
        let parsed =
            reqwest::Url::parse(&request_url(BASE, "all", "latest", 40, None).unwrap()).unwrap();
        assert_eq!(parsed.path(), "/api/client/social-stream");
        assert_eq!(parsed.query(), Some("filter=all&scope=latest&limit=40"));
        for limit in [0, 41, u32::MAX] {
            assert!(request_url(BASE, "all", "latest", limit, None).is_err());
        }
        for filter in ["../../admin", "unknown", "all&viewer=other"] {
            assert!(request_url(BASE, filter, "latest", 20, None).is_err());
        }
        assert!(request_url(BASE, "all", "all", 20, None).is_err());
        for cursor in ["", "signed.payload", "a=", "日本語", &"a".repeat(4097)] {
            assert!(request_url(BASE, "all", "latest", 20, Some(cursor)).is_err());
        }
        let next = token(Value::Null);
        assert!(request_url(BASE, "all", "latest", 20, Some(&next))
            .unwrap()
            .contains("cursor="));
    }
    #[test]
    fn public_schema_preserves_all_three_kinds_and_original_payloads_without_private_fields() {
        let mut value = page();
        value["items"] = json!([post_item(), thread_item(), community_item()]);
        validate(&value, BASE, "all", "latest", 20, false).unwrap();
        assert_eq!(value["items"][0]["payload"].as_object().unwrap().len(), 18);
        assert_eq!(value["items"][1]["payload"].as_object().unwrap().len(), 7);
        assert_eq!(value["items"][2]["payload"].as_object().unwrap().len(), 10);
        for depth in 0..3 {
            let mut wrong = value.clone();
            match depth {
                0 => wrong["privateKey"] = json!("private"),
                1 => wrong["items"][0]["cookie"] = json!("private"),
                _ => wrong["items"][0]["payload"]["email"] = json!("private"),
            };
            assert!(validate(&wrong, BASE, "all", "latest", 20, false).is_err());
        }
    }
    #[test]
    fn viewer_signed_state_and_anonymous_identity_privacy_are_never_inferred_or_downgraded() {
        let mut value = page();
        value["viewerId"] = json!("viewer-1");
        value["signedIn"] = json!(true);
        validate(&value, BASE, "all", "latest", 20, true).unwrap();
        assert_eq!(
            validate(&value, BASE, "all", "latest", 20, false)
                .err()
                .unwrap(),
            DENIED
        );
        value = page();
        assert_eq!(
            validate(&value, BASE, "all", "latest", 20, true)
                .err()
                .unwrap(),
            DENIED
        );
        value["viewerId"] = json!("ghost");
        assert!(validate(&value, BASE, "all", "latest", 20, false).is_err());
        value = page();
        value["scope"] = json!("following");
        validate(&value, BASE, "all", "following", 20, false).unwrap();
        value["items"] = json!([post_item()]);
        assert!(validate(&value, BASE, "all", "following", 20, false).is_err());
        let mut item = post_item();
        item["payload"]["identityMode"] = json!("anonymous");
        assert!(post(&item["payload"], "post-1", AT).is_err());
        item["payload"]["authorProfileId"] = Value::Null;
        post(&item["payload"], "post-1", AT).unwrap();
        item["payload"]["authorHandle"] = json!("hidden");
        assert!(post(&item["payload"], "post-1", AT).is_err());
    }
    #[test]
    fn counts_safe_integer_utf16_legacy_bodies_and_array_bounds_are_independent() {
        let mut item = post_item();
        item["payload"]["body"] = json!("😀".repeat(20000));
        item["payload"]["likeCount"] = json!(MAX_SAFE);
        post(&item["payload"], "post-1", AT).unwrap();
        item["payload"]["body"] = json!("😀".repeat(20000) + "a");
        assert!(post(&item["payload"], "post-1", AT).is_err());
        item = post_item();
        item["payload"]["likeCount"] = json!(MAX_SAFE + 1);
        assert!(post(&item["payload"], "post-1", AT).is_err());
        for count in [json!(-1), json!(0.5), json!("1")] {
            item = post_item();
            item["payload"]["replyCount"] = count;
            assert!(post(&item["payload"], "post-1", AT).is_err());
        }
        assert_eq!(integer(&json!(1.0), MAX_SAFE), Some(1));
        let mut item = community_item();
        item["payload"]["body"] = json!("😀".repeat(2000));
        community(&item["payload"], item["id"].as_str().unwrap(), AT).unwrap();
        item["payload"]["body"] = json!("a".repeat(4001));
        assert!(community(&item["payload"], item["id"].as_str().unwrap(), AT).is_err());
        item = post_item();
        item["payload"]["tags"] = json!(vec!["tag"; 50]);
        post(&item["payload"], "post-1", AT).unwrap();
        item["payload"]["tags"]
            .as_array_mut()
            .unwrap()
            .push(json!("tag"));
        assert!(post(&item["payload"], "post-1", AT).is_err());
    }
    #[test]
    fn images_and_reference_unknown_fields_or_unsafe_urls_do_not_get_silently_discarded() {
        let mut item = post_item();
        item["payload"]["images"] = json!([{"id":"image-1","url":"/api/images/image-1","width":0,"height":100,"altText":"literal"}]);
        item["payload"]["referenced"] = json!({"label":"引用","title":"タイトル","body":"a".repeat(40000),"href":"/v2/posts/post-2","contextLabel":"文脈"});
        post(&item["payload"], "post-1", AT).unwrap();
        item["payload"]["images"][0]["privatePath"] = json!("private");
        assert!(post(&item["payload"], "post-1", AT).is_err());
        item["payload"]["images"][0]
            .as_object_mut()
            .unwrap()
            .remove("privatePath");
        item["payload"]["referenced"]["session"] = json!("private");
        assert!(post(&item["payload"], "post-1", AT).is_err());
        for raw in [
            "javascript:evil",
            "//outside.example/path",
            "/../private",
            "https://user:private@example.org/a",
            "data:image/png;base64,body",
        ] {
            assert!(!url(&json!(raw)));
        }
    }
    #[test]
    fn canonical_ids_timestamps_origin_order_and_duplicates_reject_malformed_state() {
        assert!(id(&"a".repeat(200), 200));
        assert!(!id(&"a".repeat(201), 200));
        assert!(!id("post-1\n", 200));
        assert!(timestamp(AT, true));
        assert!(timestamp("2026-10-07 00:00:00", false));
        assert!(!timestamp("2026-02-30T00:00:00.000Z", true));
        let mut value = page();
        value["items"] = json!([post_item(), post_item()]);
        assert!(validate(&value, BASE, "all", "latest", 20, false).is_err());
        value["items"] = json!([thread_item(), post_item()]);
        assert!(validate(&value, BASE, "all", "latest", 20, false).is_err());
        value["items"] = json!([post_item()]);
        value["items"][0]["origin"] = json!("https://other.example");
        assert!(validate(&value, BASE, "all", "latest", 20, false).is_err());
        value["items"][0]["origin"] = json!(BASE);
        value["items"][0]["payload"]["id"] = json!("another");
        assert!(validate(&value, BASE, "all", "latest", 20, false).is_err());
    }
    #[test]
    fn cursor_lanes_pin_filter_scope_viewer_origin_and_validate_resume_positions() {
        let good = token(json!("viewer-1"));
        cursor(&good, "all", "latest", Some("viewer-1"), BASE, true).unwrap();
        assert!(cursor(&good, "all", "latest", Some("other"), BASE, true).is_err());
        assert!(cursor(&good, "post", "latest", None, BASE, false).is_err());
        assert!(cursor(&good, "all", "following", None, BASE, false).is_err());
        let raw = URL_SAFE_NO_PAD.decode(good).unwrap();
        let mut value: Value = serde_json::from_slice(&raw).unwrap();
        value["lanes"]["post"]["after"] = json!({"createdAt":"2026-10-07 00:00:00","id":"post-1"});
        let good = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap());
        cursor(&good, "all", "latest", Some("viewer-1"), BASE, true).unwrap();
        value["lanes"]["post"]["after"]["cookie"] = json!("private");
        assert!(cursor(
            &URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap()),
            "all",
            "latest",
            Some("viewer-1"),
            BASE,
            true
        )
        .is_err());
    }
    #[test]
    fn continuation_and_partial_failure_are_typed_without_hiding_failures() {
        let mut value = page();
        value["hasMore"] = json!(true);
        value["nextCursor"] = json!(token(Value::Null));
        value["failures"] = json!(["thread"]);
        validate(&value, BASE, "all", "latest", 20, false).unwrap();
        value["failures"] = json!(["thread", "thread"]);
        assert!(validate(&value, BASE, "all", "latest", 20, false).is_err());
        value["failures"] = json!([]);
        value["nextCursor"] = Value::Null;
        assert!(validate(&value, BASE, "all", "latest", 20, false).is_err());
        value = page();
        value["nextCursor"] = json!(token(Value::Null));
        assert!(validate(&value, BASE, "all", "latest", 20, false).is_err());
    }
    #[test]
    fn legacy_cursor_dates_and_fractional_seconds_preserve_utc_millisecond_profile() {
        for value in ["2026-10-07", "2026-10-07 12:34:56", "2026-10-07 12:34:56.1", "2026-10-07T12:34:56.123999999Z"] { assert!(timestamp(value,false)); assert!(!timestamp(value,true)); }
        assert!(timestamp("2026-10-07T12:34:56.123Z",true));
        for value in ["2026-10-07Z", "2026-10-07.123", "2026-02-30", "2026-10-07 12:34:60", "2026-10-07T12:34:56.Z", "2026-10-07T12:34:56.1234567890Z", "2026-10-07T12:34:56+09:00"] { assert!(!timestamp(value,false)); }
    }
    #[test]
    fn account_binding_changes_and_auth_errors_never_degrade_registered_to_guest() {
        let guest = binding(BASE, "signed_out", None, None).unwrap();
        assert!(!guest.registered);
        let thumb = URL_SAFE_NO_PAD.encode([1u8; 32]);
        let one = binding(
            BASE,
            "registered",
            Some("device-1".into()),
            Some(thumb.clone()),
        )
        .unwrap();
        let other = binding(BASE, "registered", Some("device-2".into()), Some(thumb)).unwrap();
        assert!(one != other && one != guest);
        assert!(binding(BASE, "registered", None, None).is_err());
        assert!(binding(
            BASE,
            "registered",
            Some("device\n".into()),
            Some("bad".into())
        )
        .is_err());
        assert_eq!(auth_error("desktop_account_key_invalid"), DENIED);
        assert_eq!(auth_error("desktop_account_unauthorized"), DENIED);
        assert_eq!(auth_error("temporary_network"), AUTH_UNAVAILABLE);
        assert_eq!(
            auth_error("desktop_account_request_failed"),
            AUTH_UNAVAILABLE
        );
    }
    #[test]
    fn actual_two_mib_budget_is_checked_before_append_inclusive_no_truncation() {
        let mut bytes = vec![0; MAX_BYTES - 1];
        append(&mut bytes, &[1]).unwrap();
        assert_eq!(bytes.len(), MAX_BYTES);
        assert!(append(&mut bytes, &[1]).is_err());
        assert_eq!(bytes.len(), MAX_BYTES);
        assert!(append(&mut Vec::new(), &vec![0; MAX_BYTES + 1]).is_err());
    }
}
