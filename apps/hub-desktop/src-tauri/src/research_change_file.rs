//! Fixed readonly fork context and user-selected JSON export. No remote-original fetch.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Write, path::{Path, PathBuf}, time::Duration};
use tauri_plugin_dialog::DialogExt;

const INVALID: &str = "research_change_invalid_request";
const CONFLICT: &str = "research_change_conflict";
const UNKNOWN: &str = "research_change_unknown";
const MAX_PACKET_JSON: usize = 500_000;
const MAX_CONTEXT_JSON: usize = 1024 * 1024;
const MAX_VERSION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    pub origin: String,
    pub project_id: String,
    pub document_id: String,
    pub base_version: u64,
    pub base_hash: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Context {
    pub viewer_id: String,
    pub project_id: String,
    pub document_id: String,
    pub version: u64,
    pub body: String,
    pub content_hash: String,
    pub source: Target,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextRefs {
    pub project_id: String,
    pub document_id: String,
    pub version: u64,
    pub viewer_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Packet {
    pub protocol: String,
    pub target: Target,
    pub body: String,
    pub summary: String,
    pub content_hash: String,
}
fn project(value: &str) -> bool {
    value.len() == 35 && value.starts_with("rp_")
        && value[3..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn document_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}
fn identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}
fn hash(value: &str) -> bool {
    value.len() == 71 && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn digest(body: &str) -> String { format!("sha256:{:x}", Sha256::digest(body.as_bytes())) }
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn nonblank(value: &str, max: usize) -> bool {
    value.encode_utf16().count() <= max && !value.trim_matches(js_whitespace).is_empty()
}
fn origin(value: &str) -> Result<String, String> {
    if value.len() > 512 || value.chars().any(char::is_control) { return Err(INVALID.into()); }
    crate::hub_network::origin(value).map_err(|_| INVALID.into())
}
fn target(value: &Target) -> Result<(), String> {
    if origin(&value.origin)? != value.origin || !project(&value.project_id)
        || !document_id(&value.document_id) || value.base_version == 0
        || value.base_version > MAX_VERSION || !hash(&value.base_hash) { return Err(INVALID.into()); }
    Ok(())
}
fn refs(value: &ContextRefs) -> Result<(), String> {
    if !project(&value.project_id) || !document_id(&value.document_id) || value.version == 0
        || value.version > MAX_VERSION || !identity(&value.viewer_id) { return Err(INVALID.into()); }
    Ok(())
}
fn packet_bytes(packet: &Packet) -> Result<Vec<u8>, String> {
    target(&packet.target)?;
    if packet.protocol != "hub.research-change.v1" || !nonblank(&packet.body, 100_000)
        || !nonblank(&packet.summary, 500) || packet.summary.trim_matches(js_whitespace) != packet.summary
        || !hash(&packet.content_hash) || digest(&packet.body) != packet.content_hash { return Err(INVALID.into()); }
    let bytes = serde_json::to_vec(packet).map_err(|_| INVALID)?;
    if bytes.len() > MAX_PACKET_JSON { return Err(INVALID.into()); }
    Ok(bytes)
}
fn decode_context(bytes: &[u8], project_id: &str, doc: &str, version: u64, expected_viewer: Option<&str>) -> Result<Context, String> {
    if bytes.len() > MAX_CONTEXT_JSON { return Err(UNKNOWN.into()); }
    let context: Context = serde_json::from_slice(bytes).map_err(|_| UNKNOWN)?;
    if !identity(&context.viewer_id) || context.project_id != project_id || context.document_id != doc
        || context.version != version || !nonblank(&context.body, 100_000)
        || !hash(&context.content_hash) || digest(&context.body) != context.content_hash
        || target(&context.source).is_err() { return Err(UNKNOWN.into()); }
    if expected_viewer.is_some_and(|viewer| viewer != context.viewer_id) { return Err(CONFLICT.into()); }
    Ok(context)
}
fn bind(context: &Context, reference: &ContextRefs, packet: &Packet) -> Result<(), String> {
    refs(reference)?;
    if context.viewer_id != reference.viewer_id || context.project_id != reference.project_id
        || context.document_id != reference.document_id || context.version != reference.version
        || context.body != packet.body || context.content_hash != packet.content_hash || context.source != packet.target {
        return Err(CONFLICT.into());
    }
    Ok(())
}
struct Scope { base: String, device: String }
impl Scope {
    fn capture(base: &str, device: &str, expected_origin: &str) -> Result<Self, String> {
        if !identity(device) { return Err(INVALID.into()); }
        let scope = Self { base: origin(base)?, device: device.into() };
        if origin(expected_origin)? != scope.base { return Err(CONFLICT.into()); }
        scope.check()?; Ok(scope)
    }
    fn check(&self) -> Result<(), String> {
        if origin(&crate::hub_origin())? != self.base { return Err(CONFLICT.into()); }
        crate::hub_network::require_source_owner(&self.base, &self.device).map_err(|_| CONFLICT.into())
    }
}
fn location(base: &str, local_project: &str, doc: &str, version: u64) -> Result<reqwest::Url, String> {
    if !project(local_project) || !document_id(doc) || version == 0 || version > MAX_VERSION { return Err(INVALID.into()); }
    let mut url = reqwest::Url::parse(&format!("{base}/api/client/research/{local_project}/change-context")).map_err(|_| INVALID)?;
    url.query_pairs_mut().append_pair("documentId", doc).append_pair("version", &version.to_string()); Ok(url)
}
fn append_response(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_CONTEXT_JSON || chunk.len() > MAX_CONTEXT_JSON.saturating_sub(bytes.len()) { return Err(UNKNOWN.into()); }
    bytes.extend_from_slice(chunk); Ok(())
}
fn response_status(status: u16) -> Result<(), String> {
    match status { 200 => Ok(()), 404 => Err("research_change_not_found".into()), 409 => Err(CONFLICT.into()),
        400 | 401 | 403 | 413 | 429 => Err(format!("research_change_rejected:{status}")), _ => Err(UNKNOWN.into()) }
}
async fn fetch(scope: &Scope, local_project: &str, doc: &str, version: u64, viewer: Option<&str>) -> Result<Context, String> {
    let url = location(&scope.base, local_project, doc, version)?;
    if viewer.is_some_and(|viewer| !identity(viewer)) { return Err(INVALID.into()); }
    scope.check()?;
    let assertion = crate::desktop_account::assertion(&scope.base).await.map_err(|_| UNKNOWN)?;
    scope.check()?;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12)).build().map_err(|_| UNKNOWN)?;
    let mut request = client.get(url).bearer_auth(assertion);
    if let Some(viewer) = viewer { request = request.header("X-Hub-Expected-Viewer", viewer); }
    let mut response = request.send().await.map_err(|_| UNKNOWN)?;
    scope.check()?; response_status(response.status().as_u16())?;
    if response.content_length().is_some_and(|length| length > MAX_CONTEXT_JSON as u64) { return Err(UNKNOWN.into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNKNOWN)? { append_response(&mut bytes, &chunk)?; }
    scope.check()?; decode_context(&bytes, local_project, doc, version, viewer)
}
pub(crate) async fn read(base: &str, ids: &[String]) -> Result<Context, String> {
    if !matches!(ids.len(), 5 | 6) { return Err(INVALID.into()); }
    let version: u64 = ids[2].parse().map_err(|_| INVALID)?;
    if ids[2] != version.to_string() { return Err(INVALID.into()); }
    let scope = Scope::capture(base, &ids[3], &ids[4])?;
    fetch(&scope, &ids[0], &ids[1], version, ids.get(5).map(String::as_str)).await
}

struct Temporary { path: PathBuf, owned: bool }
impl Drop for Temporary { fn drop(&mut self) { if self.owned { let _ = std::fs::remove_file(&self.path); } } }
fn atomic_write(path: &Path, bytes: &[u8], check: impl Fn() -> Result<(), String>) -> Result<(), String> {
    if bytes.len() > MAX_PACKET_JSON || path.file_name().is_none() { return Err(INVALID.into()); }
    check()?;
    let mut temporary = Temporary { path: path.with_file_name(format!(".hub-research-change-{}.tmp", uuid::Uuid::new_v4())), owned: false };
    // The file drops before the guard on write failures, including Windows sharing rules.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary.path).map_err(|_| UNKNOWN)?;
    temporary.owned = true;
    file.write_all(bytes).map_err(|_| UNKNOWN)?; file.sync_all().map_err(|_| UNKNOWN)?; drop(file);
    check()?; std::fs::rename(&temporary.path, path).map_err(|_| UNKNOWN)?; temporary.owned = false; Ok(())
}
/// Root retains the bundled-main command gate. The chosen OS path never crosses IPC.
pub(crate) async fn save(app: tauri::AppHandle, reference: ContextRefs, packet: Packet, expected_device_id: String, current_origin: String) -> Result<Value, String> {
    refs(&reference)?; let bytes = packet_bytes(&packet)?;
    let scope = Scope::capture(&crate::hub_origin(), &expected_device_id, &current_origin)?;
    let before = fetch(&scope, &reference.project_id, &reference.document_id, reference.version, Some(&reference.viewer_id)).await?;
    bind(&before, &reference, &packet)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("JSON", &["json"]).set_file_name("hub-research-change.json")
        .save_file(move |chosen| { let _ = tx.send(chosen); });
    let Some(chosen) = rx.await.map_err(|_| UNKNOWN)? else { return Ok(json!({"cancelled": true})); };
    let path = chosen.as_path().ok_or(UNKNOWN)?.to_path_buf();
    scope.check()?;
    let after = fetch(&scope, &reference.project_id, &reference.document_id, reference.version, Some(&reference.viewer_id)).await?;
    bind(&after, &reference, &packet)?; scope.check()?;
    tokio::task::spawn_blocking(move || atomic_write(&path, &bytes, || scope.check())).await.map_err(|_| UNKNOWN)??;
    Ok(json!({"saved": true, "contentHash": packet.content_hash}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const LOCAL: &str = "rp_11111111111111111111111111111111";
    const ORIGINAL: &str = "rp_22222222222222222222222222222222";
    fn packet(body: &str) -> Packet {
        Packet { protocol: "hub.research-change.v1".into(),
            target: Target { origin: "https://original.example".into(), project_id: ORIGINAL.into(),
                document_id: "original-document".into(), base_version: 7, base_hash: digest("original") },
            body: body.into(), summary: "変更内容".into(), content_hash: digest(body) }
    }
    fn reference() -> ContextRefs {
        ContextRefs { project_id: LOCAL.into(), document_id: "fork-document".into(), version: 2, viewer_id: "viewer_one".into() }
    }
    fn context(packet: &Packet) -> Context {
        let reference = reference();
        Context { viewer_id: reference.viewer_id, project_id: reference.project_id, document_id: reference.document_id,
            version: reference.version, body: packet.body.clone(), content_hash: packet.content_hash.clone(), source: packet.target.clone() }
    }
    fn decode(value: &Value, viewer: Option<&str>) -> Result<Context, String> {
        decode_context(&serde_json::to_vec(value).unwrap(), LOCAL, "fork-document", 2, viewer)
    }

    #[test]
    fn identifiers_versions_and_origins_have_exact_bounds() {
        assert!(project(LOCAL));
        for bad in ["rp_1111111111111111111111111111111", "rp_A1111111111111111111111111111111", "rp_11111111111111111111111111111111\n"] { assert!(!project(bad)); }
        assert!(document_id(&"a".repeat(100))); assert!(!document_id(&"a".repeat(101)));
        for bad in ["", "a/../b", "a\n", "a\r", "a\u{2028}", "a\u{0085}", "日本語"] { assert!(!document_id(bad)); }
        assert!(identity(&"a".repeat(128))); assert!(!identity(&"a".repeat(129)));
        for bad in ["", "a\n", "a.", "a\0"] { assert!(!identity(bad)); }
        let mut value = reference();
        value.version = MAX_VERSION; assert!(refs(&value).is_ok());
        for bad in [0, MAX_VERSION + 1, u64::MAX] { value.version = bad; assert!(refs(&value).is_err()); }
        for good in ["https://original.example", "http://localhost:3020", "http://127.0.0.1:3020", "http://[::1]:3020"] { assert_eq!(origin(good).unwrap(), good); }
        for bad in ["http://original.example", "https://user:password@original.example", "https://original.example/page", "https://original.example?x=1", "https://original.example#x", "https://original.example\n"] { assert!(origin(bad).is_err()); }
        let mut value = packet("body"); value.target.origin += "/"; assert!(packet_bytes(&value).is_err());
    }

    #[test]
    fn fixed_url_has_only_local_document_and_canonical_revision() {
        let url = location("https://hub.example", LOCAL, "doc_.-", MAX_VERSION).unwrap();
        assert_eq!(url.path(), format!("/api/client/research/{LOCAL}/change-context"));
        assert_eq!(url.query(), Some("documentId=doc_.-&version=9007199254740991"));
        for bad in [0, MAX_VERSION + 1] { assert!(location("https://hub.example", LOCAL, "doc", bad).is_err()); }
        assert!(location("https://hub.example", LOCAL, "a&version=9", 2).is_err());
    }

    #[test]
    fn packet_and_context_are_closed_and_reject_malformed_unicode() {
        let value = packet("body");
        let raw = serde_json::to_value(&value).unwrap();
        let mut extra = raw.clone(); extra["path"] = json!("not allowed"); assert!(serde_json::from_value::<Packet>(extra).is_err());
        let mut extra = raw.clone(); extra["target"]["viewerId"] = json!("not authority"); assert!(serde_json::from_value::<Packet>(extra).is_err());
        let serialized = String::from_utf8(serde_json::to_vec(&value).unwrap()).unwrap();
        let duplicate = serialized.replacen("\"protocol\":", "\"protocol\":\"hub.research-change.v1\",\"protocol\":", 1);
        assert!(serde_json::from_str::<Packet>(&duplicate).is_err());
        let broken = serialized.replacen("\"body\":\"body\"", "\"body\":\"\\ud800\"", 1);
        assert!(serde_json::from_str::<Packet>(&broken).is_err());
        let mut value = serde_json::to_value(context(&value)).unwrap();
        value["source"]["body"] = json!("no original body"); assert!(decode(&value, None).is_err());
        let mut value = serde_json::to_value(context(&packet("body"))).unwrap();
        value["cookie"] = json!("not allowed"); assert!(decode(&value, None).is_err());
        assert!(decode_context(b"\xff", LOCAL, "fork-document", 2, None).is_err());
    }

    #[test]
    fn body_utf16_width_and_summary_trim_match_javascript_contract() {
        assert!(packet_bytes(&packet(&"a".repeat(100_000))).is_ok());
        assert!(packet_bytes(&packet(&"a".repeat(100_001))).is_err());
        assert!(packet_bytes(&packet(&"😀".repeat(50_000))).is_ok());
        assert!(packet_bytes(&packet(&format!("{}a", "😀".repeat(50_000)))).is_err());
        for blank in ["", " \t\r\n", "\u{feff}"] { assert!(packet_bytes(&packet(blank)).is_err()); }
        let mut value = packet("body"); value.summary = "s".repeat(500); assert!(packet_bytes(&value).is_ok());
        value.summary.push('s'); assert!(packet_bytes(&value).is_err());
        for invalid in ["", " summary", "summary\u{feff}", "\u{feff}"] { value.summary = invalid.into(); assert!(packet_bytes(&value).is_err()); }
    }

    #[test]
    fn original_body_nul_line_endings_and_serialization_order_are_preserved() {
        let body = " first\0\r\n日本語😀\nlast ";
        let value = packet(body);
        let bytes = packet_bytes(&value).unwrap();
        let roundtrip: Packet = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(roundtrip.body, body); assert_eq!(roundtrip.content_hash, digest(body));
        let raw = String::from_utf8(bytes).unwrap();
        assert!(raw.starts_with("{\"protocol\":\"hub.research-change.v1\",\"target\":{\"origin\":"));
        assert!(raw.contains("\"baseHash\":")); assert!(raw.contains("first\\u0000\\r\\n日本語😀\\nlast"));
        assert!(raw.find("\"body\":").unwrap() < raw.find("\"summary\":").unwrap());
        assert!(raw.find("\"summary\":").unwrap() < raw.rfind("\"contentHash\":").unwrap());
        let mut tampered = value.clone(); tampered.body.push('x'); assert!(packet_bytes(&tampered).is_err());
    }

    #[test]
    fn escaped_json_real_byte_limit_is_inclusive_without_slicing() {
        let mut value = packet(&format!("a{}", "\0".repeat(83_000)));
        let initial = packet_bytes(&value).unwrap().len();
        value.body += &"x".repeat(MAX_PACKET_JSON - initial); value.content_hash = digest(&value.body);
        assert_eq!(packet_bytes(&value).unwrap().len(), MAX_PACKET_JSON);
        assert!(value.body.encode_utf16().count() < 100_000);
        value.body.push('x'); value.content_hash = digest(&value.body);
        assert_eq!(serde_json::to_vec(&value).unwrap().len(), MAX_PACKET_JSON + 1);
        assert!(packet_bytes(&value).is_err());
    }

    #[test]
    fn selected_old_revision_binds_to_original_base_not_local_revision() {
        let packet = packet("old selected local revision"); let context = context(&packet); let reference = reference();
        assert_ne!(context.version, context.source.base_version);
        assert!(bind(&context, &reference, &packet).is_ok());
        let value = serde_json::to_value(&context).unwrap();
        assert!(decode(&value, Some("viewer_one")).is_ok());
        assert!(matches!(decode(&value, Some("viewer_two")), Err(error) if error == CONFLICT));
        let mut changed = context.clone(); changed.viewer_id = "viewer_two".into(); assert!(bind(&changed, &reference, &packet).is_err());
        let mut changed = context.clone(); changed.body.push('x'); assert!(bind(&changed, &reference, &packet).is_err());
        let mut changed = packet.clone(); changed.target.base_version += 1; assert!(bind(&context, &reference, &changed).is_err());
        let mut changed = value.clone(); changed["version"] = json!(3); assert!(decode(&changed, None).is_err());
        let mut changed = value.clone(); changed["contentHash"] = json!(digest("different")); assert!(decode(&changed, None).is_err());
        let mut changed = value; changed["source"]["origin"] = json!("https://original.example/path"); assert!(decode(&changed, None).is_err());
    }

    #[test]
    fn response_real_chunks_are_checked_before_growth_and_errors_are_static() {
        let mut bytes = vec![0; MAX_CONTEXT_JSON - 1];
        append_response(&mut bytes, &[1]).unwrap(); assert_eq!(bytes.len(), MAX_CONTEXT_JSON);
        assert_eq!(append_response(&mut bytes, &[2]).unwrap_err(), UNKNOWN); assert_eq!(bytes.len(), MAX_CONTEXT_JSON);
        let mut bytes = vec![0; MAX_CONTEXT_JSON + 1]; assert!(append_response(&mut bytes, &[]).is_err());
        assert!(response_status(200).is_ok()); assert_eq!(response_status(404).unwrap_err(), "research_change_not_found");
        assert_eq!(response_status(409).unwrap_err(), CONFLICT);
        for code in [301, 302, 307, 308, 204, 500, 503] { assert_eq!(response_status(code).unwrap_err(), UNKNOWN); }
        for code in [400, 401, 403, 413, 429] { assert_eq!(response_status(code).unwrap_err(), format!("research_change_rejected:{code}")); }
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hub-research-change-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap(); Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn atomic_export_preserves_all_bytes_and_rechecks_before_commit() {
        let fixture = Fixture::new(); let path = fixture.0.join("hub-research-change.json");
        let bytes = vec![b'a'; MAX_PACKET_JSON];
        atomic_write(&path, &bytes, || Ok(())).unwrap(); assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let unrelated = fixture.0.join(".hub-research-change-unrelated.tmp"); std::fs::write(&unrelated, b"keep").unwrap();
        let checks = Cell::new(0);
        let error = atomic_write(&path, b"changed", || { checks.set(checks.get() + 1); if checks.get() == 2 { Err(CONFLICT.into()) } else { Ok(()) } });
        assert_eq!(error.unwrap_err(), CONFLICT); assert_eq!(checks.get(), 2);
        assert_eq!(std::fs::read(&path).unwrap(), bytes); assert_eq!(std::fs::read(&unrelated).unwrap(), b"keep");
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 2);
        atomic_write(&path, b"replacement\0\r\n", || Ok(())).unwrap(); assert_eq!(std::fs::read(&path).unwrap(), b"replacement\0\r\n");
    }

    #[test]
    fn failed_export_cleans_only_its_created_temp_and_never_truncates_target() {
        let fixture = Fixture::new(); let directory = fixture.0.join("target-directory"); std::fs::create_dir(&directory).unwrap();
        assert_eq!(atomic_write(&directory, b"body", || Ok(())).unwrap_err(), UNKNOWN);
        assert!(directory.is_dir()); assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
        let path = fixture.0.join("not-created.json");
        assert_eq!(atomic_write(&path, &vec![0; MAX_PACKET_JSON + 1], || Ok(())).unwrap_err(), INVALID); assert!(!path.exists());
        assert_eq!(atomic_write(&path, b"body", || Err(CONFLICT.into())).unwrap_err(), CONFLICT); assert!(!path.exists());
        let unowned = fixture.0.join("unowned.tmp"); std::fs::write(&unowned, b"keep").unwrap();
        drop(Temporary { path: unowned.clone(), owned: false }); assert_eq!(std::fs::read(unowned).unwrap(), b"keep");
    }
}
