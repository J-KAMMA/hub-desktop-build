//! Fixed native Git bundle transport. No caller URL, path, credential or redirect.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{header::HeaderMap, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeBody, Request, Response};

const MAX_BUNDLE: usize = 50 * 1024 * 1024;
const MAX_METADATA: usize = 1024;
const MAX_JSON: usize = 4096;
const INPUT: &str = "invalid_git_import";
const INVALID_RESPONSE: &str = "invalid_git_import_response";
const UNKNOWN: &str = "research_git_import_result_unknown";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    request_id: String,
    branch: String,
    base_oid: String,
    head_oid: String,
    bundle_sha256: String,
}
fn hex(value: &str, width: usize) -> bool {
    value.len() == width && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn oid(value: &str) -> bool { (value.len() == 40 || value.len() == 64) && hex(value, value.len()) }
fn project(value: &str) -> bool { value.len() == 35 && value.starts_with("rp_") && hex(&value[3..], 32) }
fn branch(value: &str) -> bool {
    !value.is_empty() && value.len() <= 200 && value != "@" && !value.ends_with('.')
        && !value.contains("..") && !value.contains("@{")
        && !value.chars().any(|c| c <= '\u{20}' || ('\u{7f}'..='\u{9f}').contains(&c) || "\\~^:?*[".contains(c))
        && value.split('/').all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}
impl Metadata {
    fn validate(&self) -> Result<(), String> {
        if self.request_id.len() != 36 || uuid::Uuid::parse_str(&self.request_id).map(|id| id.to_string() != self.request_id).unwrap_or(true)
            || !branch(&self.branch) || !oid(&self.base_oid) || !oid(&self.head_oid)
            || self.base_oid.len() != self.head_oid.len() || self.base_oid == self.head_oid || !hex(&self.bundle_sha256, 64)
            || serde_json::to_vec(self).map_err(|_| INPUT)?.len() > MAX_METADATA { return Err(INPUT.into()); }
        Ok(())
    }
    fn header(&self) -> Result<String, String> {
        self.validate()?;
        Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).map_err(|_| INPUT)?))
    }
}
fn metadata_header(value: &str) -> Result<Metadata, String> {
    if value.is_empty() || value.len() > 2048 { return Err(INPUT.into()); }
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| INPUT)?;
    if bytes.len() > MAX_METADATA { return Err(INPUT.into()); }
    let metadata: Metadata = serde_json::from_slice(&bytes).map_err(|_| INPUT)?;
    if metadata.header()? != value { return Err(INPUT.into()); }
    Ok(metadata)
}
fn closed<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let row = value.as_object().ok_or(INPUT)?;
    if row.len() != fields.len() || row.keys().any(|key| !fields.contains(&key.as_str())) { return Err(INPUT.into()); }
    Ok(row)
}
fn text<'a>(row: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> { row.get(key).and_then(Value::as_str).ok_or_else(|| INPUT.into()) }
fn json_args(body: &InvokeBody, fields: &[&str]) -> Result<Value, String> {
    let InvokeBody::Json(value) = body else { return Err(INPUT.into()) };
    if serde_json::to_vec(value).map_err(|_| INPUT)?.len() > MAX_JSON { return Err(INPUT.into()); }
    closed(value, fields)?;
    if !project(value["projectId"].as_str().ok_or(INPUT)?) { return Err(INPUT.into()); }
    Ok(value.clone())
}
fn main_url(label: &str, url: &Url) -> bool {
    label == "main" && url.query().is_none() && url.fragment().is_none() && url.username().is_empty() && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost") && url.port().is_none())
            || (cfg!(debug_assertions) && url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && url.port() == Some(1430)))
}
fn native(window: &tauri::Webview) -> Result<(), String> {
    if !main_url(window.label(), &window.url().map_err(|_| "native_window_required")?) { return Err("native_window_required".into()); }
    Ok(())
}
fn origin(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| INPUT)?;
    if !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() || url.query().is_some() || url.fragment().is_some() || url.path() != "/"
        || !(url.scheme() == "https" || (url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))) { return Err(INPUT.into()); }
    Ok(url)
}
fn endpoint(base: &str, project_id: &str, operation: Option<&str>) -> Result<Url, String> {
    if !project(project_id) || operation.is_some_and(|op| !matches!(op, "preview" | "save" | "check")) { return Err(INPUT.into()); }
    let path = operation.map(|op| format!("/api/client/research/{project_id}/git/import/{op}")).unwrap_or_else(|| format!("/api/client/research/{project_id}/git/bundle"));
    origin(base)?.join(&path).map_err(|_| INPUT.into())
}
#[derive(Clone, PartialEq, Debug)]
struct Identity { state: String, device: Option<String>, key: Option<String> }
fn identity(base: &str) -> Result<Identity, String> {
    let status = crate::desktop_account::status(base)?;
    Ok(Identity { state: status.state.into(), device: status.device_id, key: status.key_thumbprint })
}
fn context_matches(base: &str, now: &str, captured: &Identity, latest: &Identity) -> bool { base == now && captured == latest }
fn current(window: &tauri::Webview, base: &str, captured: &Identity) -> Result<(), String> {
    native(window)?;
    if !context_matches(base, &crate::hub_origin(), captured, &identity(base)?) { return Err("research_git_identity_changed".into()); }
    Ok(())
}
fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, String> {
    if headers.get_all(name).iter().count() > 1 { return Err(INPUT.into()); }
    headers.get(name).map(|value| value.to_str().map_err(|_| INPUT.into())).transpose()
}
fn ipc_headers(headers: &HeaderMap, importing: bool) -> Result<(), String> {
    // Tauri's custom-protocol Request includes fixed HTTP transport headers.
    const TRANSPORT: &[&str] = &["content-type", "content-length", "accept", "accept-encoding", "accept-language", "connection", "host", "origin", "referer", "user-agent", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "tauri-invoke-key", "tauri-callback", "tauri-error"];
    const IMPORT: &[&str] = &["x-hub-project-id", "x-hub-git-import", "x-hub-git-import-operation"];
    if headers.keys().any(|key| !TRANSPORT.contains(&key.as_str()) && !(importing && IMPORT.contains(&key.as_str()))) { return Err(INPUT.into()); }
    for name in IMPORT { let value = header(headers, name)?; if importing && value.is_none() { return Err(INPUT.into()); } }
    Ok(())
}
fn length(actual: usize, declared: Option<&str>, max: usize) -> Result<(), String> {
    if actual == 0 || actual > max { return Err(INPUT.into()); }
    if let Some(raw) = declared {
        let size: usize = raw.parse().map_err(|_| INPUT)?;
        if size.to_string() != raw || size != actual || size > max { return Err(INPUT.into()); }
    }
    Ok(())
}
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn import_args<'a>(body: &'a InvokeBody, headers: &HeaderMap) -> Result<(&'a [u8], String, Metadata, String), String> {
    let InvokeBody::Raw(bytes) = body else { return Err(INPUT.into()) };
    ipc_headers(headers, true)?;
    length(bytes.len(), header(headers, "content-length")?, MAX_BUNDLE)?;
    if header(headers, "content-type")?.is_some_and(|mime| mime != "application/octet-stream") { return Err(INPUT.into()); }
    let project_id = header(headers, "x-hub-project-id")?.ok_or(INPUT)?;
    let operation = header(headers, "x-hub-git-import-operation")?.ok_or(INPUT)?;
    if !project(project_id) || !matches!(operation, "preview" | "save") { return Err(INPUT.into()); }
    let metadata = metadata_header(header(headers, "x-hub-git-import")?.ok_or(INPUT)?)?;
    if digest(bytes) != metadata.bundle_sha256 { return Err(INPUT.into()); }
    Ok((bytes, project_id.into(), metadata, operation.into()))
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(60)).build().map_err(|_| "research_git_network_unavailable".into())
}
async fn receive(mut response: reqwest::Response, mime: &str, max: usize) -> Result<Vec<u8>, String> {
    if response.status() != reqwest::StatusCode::OK { return Err(format!("research_git_import_rejected:{}", response.status().as_u16())); }
    if header(response.headers(), "content-type")?.is_none_or(|value| !value.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case(mime))
        || header(response.headers(), "content-encoding")?.is_some_and(|value| value != "identity") { return Err(INVALID_RESPONSE.into()); }
    let declared = header(response.headers(), "content-length")?.map(str::to_owned);
    if let Some(raw) = &declared { let size: usize = raw.parse().map_err(|_| INVALID_RESPONSE)?; if size == 0 || size > max || size.to_string() != *raw { return Err(INVALID_RESPONSE.into()); } }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNKNOWN)? {
        if chunk.len() > max.saturating_sub(bytes.len()) { return Err(INVALID_RESPONSE.into()); }
        bytes.extend_from_slice(&chunk);
    }
    length(bytes.len(), declared.as_deref(), max).map_err(|_| INVALID_RESPONSE)?;
    Ok(bytes)
}
fn result(value: Value, project_id: &str, metadata: &Metadata, operation: &str, bytes: Option<usize>) -> Result<Value, String> {
    let check = operation == "check";
    let fields: &[&str] = if check { &["projectId", "requestId", "branch", "baseOid", "headOid", "candidateBranch", "currentOid", "outcome"] }
        else { &["projectId", "requestId", "branch", "baseOid", "headOid", "bundleSha256", "bundleBytes", "baseTreeOid", "headTreeOid", "objectFormat", "candidateBranch", "outcome"] };
    let row = closed(&value, fields)?;
    if !project(project_id) || text(row, "projectId")? != project_id || text(row, "requestId")? != metadata.request_id || text(row, "branch")? != metadata.branch
        || text(row, "baseOid")? != metadata.base_oid || text(row, "headOid")? != metadata.head_oid || text(row, "candidateBranch")? != format!("hub-import/{}", metadata.request_id) { return Err(INVALID_RESPONSE.into()); }
    let outcome = text(row, "outcome")?;
    if check {
        let tip = row.get("currentOid").ok_or(INVALID_RESPONSE)?;
        if !tip.is_null() && !tip.as_str().is_some_and(|oid_value| oid(oid_value) && oid_value.len() == metadata.head_oid.len()) { return Err(INVALID_RESPONSE.into()); }
        if outcome != if tip.as_str() == Some(metadata.head_oid.as_str()) { "imported" } else { "not_imported" } { return Err(INVALID_RESPONSE.into()); }
    } else {
        let width = metadata.head_oid.len();
        if text(row, "bundleSha256")? != metadata.bundle_sha256 || row.get("bundleBytes").and_then(Value::as_u64) != bytes.map(|n| n as u64)
            || bytes.is_none_or(|n| n == 0 || n > MAX_BUNDLE) || !["baseTreeOid", "headTreeOid"].iter().all(|key| text(row, key).is_ok_and(|oid_value| hex(oid_value, width)))
            || text(row, "objectFormat")? != if width == 40 { "sha1" } else { "sha256" }
            || !(operation == "preview" && outcome == "preview" || operation == "save" && matches!(outcome, "imported" | "already_imported")) { return Err(INVALID_RESPONSE.into()); }
    }
    Ok(value)
}

#[tauri::command]
pub async fn research_git_bundle(window: tauri::Webview, request: Request<'_>) -> Result<Response, String> {
    native(&window)?;
    ipc_headers(request.headers(), false)?;
    let args = json_args(request.body(), &["projectId"])?;
    let base = crate::hub_origin();
    let url = endpoint(&base, args["projectId"].as_str().ok_or(INPUT)?, None)?;
    let captured = identity(&base)?;
    let assertion = crate::desktop_account::assertion_if_registered(&base).await?;
    current(&window, &base, &captured)?;
    let mut outbound = client()?.get(url).header("Accept", "application/octet-stream").header("Accept-Encoding", "identity");
    if let Some(assertion) = assertion { outbound = outbound.bearer_auth(assertion); }
    let response = outbound.send().await.map_err(|_| "research_git_network_unavailable")?;
    let hash = header(response.headers(), "x-hub-bundle-sha256")?.ok_or(INVALID_RESPONSE)?.to_owned();
    if !hex(&hash, 64) { return Err(INVALID_RESPONSE.into()); }
    let bytes = receive(response, "application/octet-stream", MAX_BUNDLE).await?;
    if digest(&bytes) != hash { return Err(INVALID_RESPONSE.into()); }
    current(&window, &base, &captured)?;
    Ok(Response::new(bytes))
}
#[tauri::command]
pub async fn research_git_bundle_import(window: tauri::Webview, request: Request<'_>) -> Result<Value, String> {
    native(&window)?;
    let (bytes, project_id, metadata, operation) = import_args(request.body(), request.headers())?;
    let base = crate::hub_origin();
    let url = endpoint(&base, &project_id, Some(&operation))?;
    let captured = identity(&base)?;
    if captured.state != "registered" { return Err("desktop_not_connected".into()); }
    let assertion = crate::desktop_account::assertion(&base).await?;
    current(&window, &base, &captured)?;
    let response = client()?.post(url).bearer_auth(assertion).header("Content-Type", "application/octet-stream").header("Accept-Encoding", "identity")
        .header("X-Hub-Git-Import", metadata.header()?).body(bytes.to_vec()).send().await.map_err(|_| UNKNOWN)?;
    let response_bytes = receive(response, "application/json", MAX_JSON).await?;
    let value = result(serde_json::from_slice(&response_bytes).map_err(|_| INVALID_RESPONSE)?, &project_id, &metadata, &operation, Some(bytes.len()))?;
    current(&window, &base, &captured)?;
    Ok(value)
}
#[tauri::command]
pub async fn research_git_bundle_check(window: tauri::Webview, request: Request<'_>) -> Result<Value, String> {
    native(&window)?;
    ipc_headers(request.headers(), false)?;
    let args = json_args(request.body(), &["projectId", "metadata"])?;
    let metadata: Metadata = serde_json::from_value(args["metadata"].clone()).map_err(|_| INPUT)?;
    metadata.validate()?;
    let project_id = args["projectId"].as_str().ok_or(INPUT)?;
    let base = crate::hub_origin();
    let url = endpoint(&base, project_id, Some("check"))?;
    let captured = identity(&base)?;
    if captured.state != "registered" { return Err("desktop_not_connected".into()); }
    let assertion = crate::desktop_account::assertion(&base).await?;
    current(&window, &base, &captured)?;
    let response = client()?.post(url).bearer_auth(assertion).header("Accept-Encoding", "identity").json(&metadata).send().await.map_err(|_| "research_git_network_unavailable")?;
    let response_bytes = receive(response, "application/json", MAX_JSON).await?;
    let value = result(serde_json::from_slice(&response_bytes).map_err(|_| INVALID_RESPONSE)?, project_id, &metadata, "check", None)?;
    current(&window, &base, &captured)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn metadata(width: usize) -> Metadata { Metadata { request_id: "12345678-abcd-1234-abcd-123456789abc".into(), branch: "main".into(), base_oid: "a".repeat(width), head_oid: "b".repeat(width), bundle_sha256: "c".repeat(64) } }
    fn project_id() -> String { format!("rp_{}", "a".repeat(32)) }
    #[test]
    fn metadata_bounds_and_canonical_browser_header() {
        for width in [40, 64] { let m = metadata(width); assert_eq!(metadata_header(&m.header().unwrap()).unwrap(), m); }
        for bad in ["", "@", "a..b", "a@{b", ".main", "foo/.bar", "foo.lock/x", "a\\b", "a\n", "a\u{80}", "a\u{9f}", "a?b", "a/b/", "a."] { assert!(!branch(bad), "{bad:?}"); }
        assert!(branch(&format!("{}ab", "あ".repeat(66)))); assert!(!branch(&"あ".repeat(67)));
        assert!(branch(&"😀".repeat(50))); assert!(!branch(&format!("{}x", "😀".repeat(50))));
        for field in ["requestId", "baseOid", "headOid", "bundleSha256"] { let mut v=serde_json::to_value(metadata(40)).unwrap(); v[field]=format!("{}\n",v[field].as_str().unwrap()).into(); assert!(serde_json::from_value::<Metadata>(v).unwrap().validate().is_err()); }
        let json=serde_json::to_string(&metadata(40)).unwrap(); assert!(metadata_header(&URL_SAFE_NO_PAD.encode(format!("{json} "))).is_err());
        assert!(metadata_header(&"a".repeat(2049)).is_err()); assert!(metadata_header("_w").is_err());
        let invalid = json.replace("main", "bad\\ud800"); assert!(metadata_header(&URL_SAFE_NO_PAD.encode(invalid)).is_err());
        let mut extra=serde_json::to_value(metadata(40)).unwrap(); extra["url"]="https://bad.invalid".into(); assert!(serde_json::from_value::<Metadata>(extra).is_err());
        assert!(!project(&(project_id()+"\n"))); assert!(!oid(&("a".repeat(40)+"\n")));
    }
    #[test]
    fn raw_ipc_and_closed_headers() {
        let bytes=b"bundle fixture".to_vec(); let mut m=metadata(40); m.bundle_sha256=digest(&bytes);
        let mut h=HeaderMap::new(); h.insert("x-hub-project-id",project_id().parse().unwrap()); h.insert("x-hub-git-import",m.header().unwrap().parse().unwrap()); h.insert("x-hub-git-import-operation","preview".parse().unwrap());
        assert!(import_args(&InvokeBody::Raw(bytes.clone()),&h).is_ok());
        assert!(import_args(&InvokeBody::Json(serde_json::json!([1,2])),&h).is_err());
        assert!(import_args(&InvokeBody::Raw(vec![]),&h).is_err());
        assert!(import_args(&InvokeBody::Raw(b"changed".to_vec()),&h).is_err());
        for name in ["authorization","cookie","x-url","x-hub-credentials"] { let mut extra=h.clone(); extra.insert(name,"refused".parse().unwrap()); assert!(import_args(&InvokeBody::Raw(bytes.clone()),&extra).is_err()); }
        let mut repeated=h.clone(); repeated.append("x-hub-git-import-operation","save".parse().unwrap()); assert!(import_args(&InvokeBody::Raw(bytes.clone()),&repeated).is_err());
        h.insert("x-hub-git-import-operation","check".parse().unwrap()); assert!(import_args(&InvokeBody::Raw(bytes),&h).is_err());
        let p=project_id(); assert!(json_args(&InvokeBody::Json(serde_json::json!({"projectId":p})), &["projectId"]).is_ok());
        assert!(json_args(&InvokeBody::Json(serde_json::json!({"projectId":p,"url":"https://bad.invalid"})), &["projectId"]).is_err());
        assert!(json_args(&InvokeBody::Raw(vec![1]), &["projectId"]).is_err());
    }
    #[test]
    fn length_boundary_and_declared_count() {
        for size in [1,16*1024*1024,16*1024*1024+1,MAX_BUNDLE] { assert!(length(size,Some(&size.to_string()),MAX_BUNDLE).is_ok()); }
        for size in [0, MAX_BUNDLE+1] { assert!(length(size,None,MAX_BUNDLE).is_err()); }
        for declared in ["", "01", "+1", "1\n", "1.0", "184467440737095516160", "2"] { assert!(length(1,Some(declared),MAX_BUNDLE).is_err()); }
    }
    #[test]
    fn context_identity_changes_fail_closed() {
        let captured=Identity { state:"registered".into(),device:Some("device-one".into()),key:Some("thumbprint-one".into()) };
        assert!(context_matches("https://hub.invalid","https://hub.invalid",&captured,&captured));
        assert!(!context_matches("https://hub.invalid","https://other.invalid",&captured,&captured));
        for changed in [Identity { state:"signed_out".into(),device:None,key:None },Identity {device:Some("device-two".into()),..captured.clone()},Identity {key:Some("thumbprint-two".into()),..captured.clone()}] { assert!(!context_matches("https://hub.invalid","https://hub.invalid",&captured,&changed)); }
    }
    #[test]
    fn response_mime_encoding_declared_actual_and_json_caps() {
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let make=|mime:&str,encoding:Option<&str>,declared:Option<&str>,bytes:Vec<u8>| {
            let mut builder=tauri::http::Response::builder().status(200).header("content-type",mime);
            if let Some(value)=encoding { builder=builder.header("content-encoding",value); }
            if let Some(value)=declared { builder=builder.header("content-length",value); }
            reqwest::Response::from(builder.body(bytes).unwrap())
        };
        assert!(runtime.block_on(receive(make("application/json; charset=utf-8",Some("identity"),Some("4096"),vec![b' ';4096]),"application/json",MAX_JSON)).is_ok());
        for response in [make("text/plain",None,None,vec![1]),make("application/json",Some("gzip"),None,vec![1]),make("application/json",None,Some("2"),vec![1]),make("application/json",None,Some("01"),vec![1]),make("application/json",None,None,vec![]),make("application/json",None,None,vec![1;4097])] { assert!(runtime.block_on(receive(response,"application/json",MAX_JSON)).is_err()); }
        let mut duplicated=tauri::http::Response::builder().status(200).header("content-type","application/json").body(vec![1]).unwrap();
        duplicated.headers_mut().append("content-type","application/json".parse().unwrap());
        assert!(runtime.block_on(receive(reqwest::Response::from(duplicated),"application/json",MAX_JSON)).is_err());
        assert!(runtime.block_on(receive(reqwest::Response::from(tauri::http::Response::builder().status(302).header("location","https://other.invalid").body(vec![1]).unwrap()),"application/json",MAX_JSON)).is_err());
    }
    #[test]
    fn destinations_and_main_window_are_closed() {
        let p=project_id(); assert_eq!(endpoint("http://localhost:3020",&p,Some("preview")).unwrap().path(), format!("/api/client/research/{p}/git/import/preview"));
        assert_eq!(Url::parse("http://[::1]:3020").unwrap().host_str(), Some("[::1]"));
        assert!(endpoint("http://[::1]:3020",&p,None).is_ok());
        for base in ["https://user@hub.invalid", "https://hub.invalid/path", "https://hub.invalid/?x=1", "https://hub.invalid/#x", "http://remote.invalid", "file:///tmp"] { assert!(endpoint(base,&p,None).is_err()); }
        assert!(endpoint("https://hub.invalid", &p, Some("../save")).is_err());
        for url in ["tauri://localhost/index.html", "http://tauri.localhost/", "https://tauri.localhost/index.html"] { assert!(main_url("main",&Url::parse(url).unwrap())); assert!(!main_url("harness",&Url::parse(url).unwrap())); }
        for url in ["tauri://localhost/index.html?tool=games", "tauri://localhost/index.html#x", "https://hub.invalid/", "https://tauri.localhost:444/index.html", "tauri://other/index.html"] { assert!(!main_url("main",&Url::parse(url).unwrap())); }
    }
    #[test]
    fn result_binding_format_and_current_equality() {
        for width in [40,64] {
            let m=metadata(width); let p=project_id(); let value=serde_json::json!({"projectId":p,"requestId":m.request_id,"branch":m.branch,"baseOid":m.base_oid,"headOid":m.head_oid,"bundleSha256":m.bundle_sha256,"bundleBytes":12,"baseTreeOid":"d".repeat(width),"headTreeOid":"e".repeat(width),"objectFormat":if width==40{"sha1"}else{"sha256"},"candidateBranch":format!("hub-import/{}",m.request_id),"outcome":"preview"});
            assert!(result(value.clone(),&p,&m,"preview",Some(12)).is_ok()); assert!(result(value.clone(),&p,&m,"save",Some(12)).is_err()); assert!(result(value.clone(),&p,&m,"unknown",Some(12)).is_err());
            for (key,bad) in [("projectId",Value::from("rp_bad")),("headOid",Value::from("f".repeat(width))),("bundleSha256",Value::from("f".repeat(64))),("bundleBytes",Value::from(13)),("baseTreeOid",Value::from("D".repeat(width))),("objectFormat",Value::from("unknown")),("candidateBranch",Value::from("main")),("url",Value::from("extra"))] { let mut changed=value.clone(); changed[key]=bad; assert!(result(changed,&p,&m,"preview",Some(12)).is_err()); }
            for tip in [Value::Null,Value::from("f".repeat(width)),Value::from(m.head_oid.clone())] { let c=serde_json::json!({"projectId":p,"requestId":m.request_id,"branch":m.branch,"baseOid":m.base_oid,"headOid":m.head_oid,"candidateBranch":format!("hub-import/{}",m.request_id),"currentOid":tip,"outcome":if tip.as_str()==Some(&m.head_oid){"imported"}else{"not_imported"}}); assert!(result(c.clone(),&p,&m,"check",None).is_ok()); let mut bad=c; bad["outcome"]="already_imported".into(); assert!(result(bad,&p,&m,"check",None).is_err()); }
        }
    }
}
