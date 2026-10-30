//! Anonymous public research snapshot and explicit OS JSON export; no Hub mutation.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri_plugin_dialog::DialogExt;
const MAX_BYTES: usize = 1_000_000;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const INVALID: &str = "research_public_export_invalid_request";
const BAD_REPLY: &str = "research_public_export_invalid_response";
const TOO_LARGE: &str = "research_public_export_too_large";
const UNAVAILABLE: &str = "research_public_export_unavailable";
const SAVE_UNKNOWN: &str = "research_public_export_save_unknown";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Packet {
    protocol: String,
    project: Project,
    href: String,
    pub(crate) snapshot_hash: String,
    documents: Vec<Document>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Project {
    id: String,
    title: String,
    description: String,
    license: Value,
    status: String,
    updated_at: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    id: String,
    title: String,
    kind: String,
    #[serde(deserialize_with = "head")]
    head: u64,
    body: String,
    content_hash: String,
}
fn head<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = serde_json::Number::deserialize(deserializer)?;
    let parsed = value
        .as_u64()
        .filter(|v| (1..=MAX_SAFE).contains(v))
        .or_else(|| {
            value
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 1.0 && *v <= MAX_SAFE as f64 && v.fract() == 0.0)
                .map(|v| v as u64)
        });
    parsed.ok_or_else(|| serde::de::Error::custom(BAD_REPLY))
}
fn project_id(value: &str) -> bool {
    value.len() == 35
        && value.strip_prefix("rp_").is_some_and(|v| {
            v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn origin(raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.len() > 512 || raw.chars().any(char::is_control) {
        return Err(INVALID.into());
    }
    let url = tauri::Url::parse(raw).map_err(|_| INVALID)?;
    if url.origin().ascii_serialization() != raw
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(
                    url.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                )))
    {
        return Err(INVALID.into());
    }
    Ok(raw.into())
}
fn route(origin_value: &str, id: &str) -> Result<String, String> {
    let origin = origin(origin_value)?;
    if !project_id(id) {
        return Err(INVALID.into());
    }
    Ok(format!("{origin}/api/network/v1/research/{id}/fork"))
}
fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn width(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.encode_utf16().count())
}
fn nonblank(value: &str) -> bool {
    !value.trim_matches(whitespace).is_empty()
}
fn hash(value: &str) -> bool {
    value.len() == 71
        && value.strip_prefix("sha256:").is_some_and(|v| {
            v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn date(value: &str) -> bool {
    if !width(value, 1, 64) {
        return false;
    }
    if let Ok(value) = chrono::DateTime::parse_from_rfc3339(value) {
        return value.timestamp_subsec_nanos() < 1_000_000_000;
    }
    if value.len() == 10
        && value.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        return chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok();
    }
    value.len() == 19
        && chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
            .is_ok_and(|v| v.and_utc().timestamp_subsec_nanos() < 1_000_000_000)
}
fn validate(packet: &Packet, origin_value: &str, id: &str) -> Result<(), String> {
    let origin = origin(origin_value)?;
    if !project_id(id) {
        return Err(INVALID.into());
    }
    let p = &packet.project;
    if packet.protocol != "hub.research-fork.v1"
        || p.id != id
        || packet.href != format!("{origin}/v2/research/{id}")
        || !hash(&packet.snapshot_hash)
        || packet.documents.len() > 20
        || !width(&p.title, 3, 240)
        || !nonblank(&p.title)
        || !width(&p.description, 0, 5000)
        || !matches!(
            p.status.as_str(),
            "draft" | "active" | "paused" | "completed"
        )
        || !date(&p.updated_at)
        || !(p.license.is_null() || p.license.as_str().is_some_and(|v| width(v, 1, 200)))
    {
        return Err(BAD_REPLY.into());
    }
    let mut previous = "";
    for document in &packet.documents {
        if !width(&document.id, 1, 128)
            || !document
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            || document.id.as_str() <= previous
            || !width(&document.title, 1, 240)
            || !nonblank(&document.title)
            || !matches!(
                document.kind.as_str(),
                "paper" | "software" | "dataset" | "notebook"
            )
            || !(1..=MAX_SAFE).contains(&document.head)
            || !width(&document.body, 1, 100000)
            || !nonblank(&document.body)
            || !hash(&document.content_hash)
            || document.content_hash != digest(document.body.as_bytes())
        {
            return Err(BAD_REPLY.into());
        }
        previous = &document.id;
    }
    let snapshot = serde_json::to_vec(&(
        &packet.href,
        &p.title,
        &p.description,
        &p.license,
        &p.status,
        &p.updated_at,
        &packet.documents,
    ))
    .map_err(|_| BAD_REPLY)?;
    if packet.snapshot_hash != digest(&snapshot) {
        return Err(BAD_REPLY.into());
    }
    Ok(())
}
fn packet_bytes(packet: &Packet) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(packet).map_err(|_| BAD_REPLY)?;
    if bytes.len() > MAX_BYTES {
        return Err(TOO_LARGE.into());
    }
    Ok(bytes)
}
fn decode(bytes: &[u8], origin_value: &str, id: &str) -> Result<Packet, String> {
    if bytes.len() > MAX_BYTES {
        return Err(TOO_LARGE.into());
    }
    // Struct deserialization rejects duplicate members, unknown fields and missing nullable license.
    let packet = serde_json::from_slice::<Packet>(bytes).map_err(|_| BAD_REPLY)?;
    validate(&packet, origin_value, id)?;
    packet_bytes(&packet)?;
    Ok(packet)
}
fn append(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BYTES || chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
        return Err(TOO_LARGE.into());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
fn response_status(status: u16) -> Result<(), String> {
    match status {
        200 => Ok(()),
        404 => Err("research_public_export_not_found".into()),
        409 => Err("research_public_export_changed".into()),
        413 => Err(TOO_LARGE.into()),
        _ => Err(UNAVAILABLE.into()),
    }
}
pub(crate) async fn read(origin_value: &str, id: &str) -> Result<Packet, String> {
    let url = route(origin_value, id)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| UNAVAILABLE)?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| UNAVAILABLE)?;
    response_status(response.status().as_u16())?;
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
    if response
        .content_length()
        .is_some_and(|v| v > MAX_BYTES as u64)
    {
        return Err(TOO_LARGE.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        append(&mut bytes, &chunk)?;
    }
    decode(&bytes, origin_value, id)
}
struct Temporary {
    path: PathBuf,
    owned: bool,
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if self.owned {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
fn atomic_write_at(path: &Path, temp: PathBuf, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BYTES
        || path.file_name().is_none()
        || temp.parent() != path.parent()
        || temp == path
    {
        return Err(INVALID.into());
    }
    let mut temporary = Temporary {
        path: temp,
        owned: false,
    };
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary.path)
        .map_err(|_| SAVE_UNKNOWN)?;
    temporary.owned = true;
    file.write_all(bytes).map_err(|_| SAVE_UNKNOWN)?;
    file.sync_all().map_err(|_| SAVE_UNKNOWN)?;
    drop(file);
    std::fs::rename(&temporary.path, path).map_err(|_| SAVE_UNKNOWN)?;
    temporary.owned = false;
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_at(
        path,
        path.with_file_name(format!(".hub-research-public-{}.tmp", uuid::Uuid::new_v4())),
        bytes,
    )
}
fn cancellation() -> Value {
    json!({"cancelled":true})
}
fn save_bytes(
    origin_value: &str,
    id: &str,
    snapshot_hash: &str,
    packet: Value,
) -> Result<Vec<u8>, String> {
    route(origin_value, id)?;
    if !hash(snapshot_hash) {
        return Err(INVALID.into());
    }
    let raw = serde_json::to_vec(&packet).map_err(|_| BAD_REPLY)?;
    let packet = decode(&raw, origin_value, id)?;
    if packet.snapshot_hash != snapshot_hash {
        return Err(BAD_REPLY.into());
    }
    packet_bytes(&packet)
}
/// Root supplies the bundled-main gate; selected OS path and content never appear in the receipt.
pub(crate) async fn save(
    app: tauri::AppHandle,
    origin_value: String,
    id: String,
    snapshot_hash: String,
    packet: Value,
) -> Result<Value, String> {
    let bytes = save_bytes(&origin_value, &id, &snapshot_hash, packet)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(format!("{id}.hub-research.json"))
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });
    let Some(chosen) = rx.await.map_err(|_| SAVE_UNKNOWN)? else {
        return Ok(cancellation());
    };
    let path = chosen.as_path().ok_or(SAVE_UNKNOWN)?.to_path_buf();
    // The validated immutable public packet is intentionally saveable without network access.
    tokio::task::spawn_blocking(move || atomic_write(&path, &bytes))
        .await
        .map_err(|_| SAVE_UNKNOWN)??;
    Ok(json!({"saved":true,"snapshotHash":snapshot_hash}))
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGIN: &str = "http://127.0.0.1:3020";
    const ID: &str = "rp_11111111111111111111111111111111";
    const SHARED: &str = r#####"{"protocol":"hub.research-fork.v1","project":{"id":"rp_11111111111111111111111111111111","title":"Public project","description":"Shared Web/Desktop contract","license":null,"status":"active","updatedAt":"2026-10-03"},"href":"http://127.0.0.1:3020/v2/research/rp_11111111111111111111111111111111","snapshotHash":"sha256:680f334ec6fc5a074848a010c9f4a3edd6849f0380358087d2d1155fd115a40f","documents":[{"id":"doc-a","title":"Code","kind":"software","head":9007199254740991,"body":"公開されたコード\r\n<script>literal</script> 😀\u0000","contentHash":"sha256:19834d8ab7768e92a39495a6889ab254eb59d47c55222e2eab8d671213e397ec"},{"id":"doc-z","title":"Paper","kind":"paper","head":1,"body":"Second document","contentHash":"sha256:51b35e2f46d0bcafbaeec1998bbd69da0abdf945c709c07cc3b61caa5dbc2c12"}]}"#####;
    fn fixture() -> Value {
        serde_json::from_str(SHARED).unwrap()
    }
    fn rehash(value: Value) -> Value {
        let mut packet: Packet = serde_json::from_value(value).unwrap();
        for document in &mut packet.documents {
            document.content_hash = digest(document.body.as_bytes());
        }
        let p = &packet.project;
        packet.snapshot_hash = digest(
            &serde_json::to_vec(&(
                &packet.href,
                &p.title,
                &p.description,
                &p.license,
                &p.status,
                &p.updated_at,
                &packet.documents,
            ))
            .unwrap(),
        );
        serde_json::to_value(packet).unwrap()
    }
    fn parse(value: &Value) -> Result<Packet, String> {
        decode(&serde_json::to_vec(value).unwrap(), ORIGIN, ID)
    }
    #[test]
    fn actual_shared_js_reference_matches_snapshot_body_bytes_and_canonical_document_order() {
        let packet = decode(SHARED.as_bytes(), ORIGIN, ID).unwrap();
        assert_eq!(
            packet.snapshot_hash,
            "sha256:680f334ec6fc5a074848a010c9f4a3edd6849f0380358087d2d1155fd115a40f"
        );
        assert_eq!(packet.documents[0].head, MAX_SAFE);
        assert!(packet.documents[0].body.contains('\0'));
        assert!(packet.documents[0].body.contains("\r\n"));
        let rendered = String::from_utf8(packet_bytes(&packet).unwrap()).unwrap();
        assert!(rendered.contains("\"id\":\"doc-a\",\"title\":\"Code\",\"kind\":\"software\",\"head\":9007199254740991,\"body\":"));
        assert_eq!(
            decode(rendered.as_bytes(), ORIGIN, ID)
                .unwrap()
                .snapshot_hash,
            packet.snapshot_hash
        );
    }
    #[test]
    fn shared_protocol_integral_json_float_and_exponent_head_canonicalize_like_js() {
        let canonical = SHARED.replace("\"head\":1,", "\"head\":1.0,");
        let exponent = SHARED.replace("\"head\":1,", "\"head\":1e0,");
        for raw in [canonical, exponent] {
            let packet = decode(raw.as_bytes(), ORIGIN, ID).unwrap();
            assert_eq!(packet.documents[1].head, 1);
        }
        for number in ["0.5", "0", "-1", "9007199254740992", "1e100", "\"1\""] {
            let raw = SHARED.replace("\"head\":1,", &format!("\"head\":{number},"));
            assert!(decode(raw.as_bytes(), ORIGIN, ID).is_err());
        }
    }
    #[test]
    fn origin_project_id_are_canonical_closed_public_get_only() {
        assert_eq!(
            route(ORIGIN, ID).unwrap(),
            format!("{ORIGIN}/api/network/v1/research/{ID}/fork")
        );
        for valid in [
            "https://example.org",
            "http://localhost:3020",
            "http://[::1]:3020",
        ] {
            assert!(origin(valid).is_ok());
        }
        for raw in [
            "https://user:private@example.org",
            "https://example.org/",
            "https://example.org/path",
            "https://example.org?q=secret",
            "https://example.org#fragment",
            "http://example.org",
            "https://EXAMPLE.org",
            "file:///private",
            "https://example.org\n",
        ] {
            assert!(origin(raw).is_err());
        }
        for id in [
            ID.to_ascii_uppercase(),
            format!("{ID}\n"),
            "../private".into(),
        ] {
            assert!(route(ORIGIN, &id).is_err());
        }
    }
    #[test]
    fn duplicate_unknown_and_missing_fields_and_invalid_unicode_fail_before_adoption() {
        for (key,insertion) in [("protocol","\"protocol\":\"hub.research-fork.v1\","),("title","\"title\":\"Public project\","),("contentHash","\"contentHash\":\"sha256:19834d8ab7768e92a39495a6889ab254eb59d47c55222e2eab8d671213e397ec\",")] {
            let raw=SHARED.replacen(&format!("\"{key}\":"),&format!("{insertion}\"{key}\":"),1);assert!(decode(raw.as_bytes(),ORIGIN,ID).is_err());
        }
        let mut value = fixture();
        value["project"].as_object_mut().unwrap().remove("license");
        assert!(parse(&value).is_err());
        value = fixture();
        value["privateActor"] = json!("not permitted");
        assert!(parse(&value).is_err());
        value = fixture();
        value["documents"][0]["owner"] = json!("not permitted");
        assert!(parse(&value).is_err());
        let raw = SHARED.replace("Public project", "\\ud800");
        assert!(decode(raw.as_bytes(), ORIGIN, ID).is_err());
        assert!(decode(&[0xff], ORIGIN, ID).is_err());
    }
    #[test]
    fn widths_use_utf16_and_js_nonblank_without_mutating_unicode_or_nul() {
        let mut value = fixture();
        value["project"]["title"] = json!("😀x");
        assert!(parse(&rehash(value)).is_ok());
        for title in ["😀", "\u{feff}\u{feff}\u{feff}"] {
            let mut value = fixture();
            value["project"]["title"] = json!(title);
            assert!(parse(&rehash(value)).is_err());
        }
        let mut value = fixture();
        value["documents"][0]["body"] = json!("😀".repeat(50000));
        assert!(parse(&rehash(value.clone())).is_ok());
        value["documents"][0]["body"] = json!("😀".repeat(50000) + "x");
        assert!(parse(&rehash(value)).is_err());
        let mut value = fixture();
        value["documents"][0]["body"] = json!("\u{feff}");
        assert!(parse(&rehash(value)).is_err());
        let mut value = fixture();
        value["documents"][0]["body"] = json!("\u{85}\0");
        assert!(parse(&rehash(value)).is_ok());
        let mut value = fixture();
        value["project"]["license"] = json!("");
        assert!(parse(&rehash(value)).is_err());
    }
    #[test]
    fn ids_order_twenty_limit_hash_changes_and_date_calendar_are_independent_guards() {
        let mut value = fixture();
        value["documents"].as_array_mut().unwrap().reverse();
        assert!(parse(&rehash(value)).is_err());
        let mut value = fixture();
        value["documents"][1]["id"] = json!("doc-a");
        assert!(parse(&rehash(value)).is_err());
        for id in ["doc-a\n", "doc/a", "日本語"] {
            let mut value = fixture();
            value["documents"][0]["id"] = json!(id);
            assert!(parse(&rehash(value)).is_err());
        }
        let mut value = fixture();
        let sample = value["documents"][0].clone();
        value["documents"] = json!((0..20)
            .map(|n| {
                let mut doc = sample.clone();
                doc["id"] = json!(format!("doc-{n:02}"));
                doc
            })
            .collect::<Vec<_>>());
        assert!(parse(&rehash(value.clone())).is_ok());
        let mut extra = value["documents"][0].clone();
        extra["id"] = json!("doc-z");
        value["documents"].as_array_mut().unwrap().push(extra);
        assert!(parse(&rehash(value)).is_err());
        let mut value = fixture();
        value["documents"][0]["body"] = json!("changed");
        assert!(parse(&value).is_err());
        value = fixture();
        value["snapshotHash"] = json!(format!("sha256:{}", "0".repeat(64)));
        assert!(parse(&value).is_err());
        for date in [
            "2026-10-03",
            "2026-10-03T00:00:00.000Z",
            "2026-10-03 00:00:00",
        ] {
            assert!(super::date(date));
        }
        for date in [
            "2026-02-30",
            "2026-13-03",
            "2026-10-03T00:00:60Z",
            "invalid",
        ] {
            assert!(!super::date(date));
        }
    }
    #[test]
    fn actual_transport_and_reconstructed_json_bytes_are_bounded_without_slicing() {
        let mut bytes = vec![0; MAX_BYTES - 1];
        append(&mut bytes, &[1]).unwrap();
        assert_eq!(bytes.len(), MAX_BYTES);
        assert!(append(&mut bytes, &[1]).is_err());
        assert_eq!(bytes.len(), MAX_BYTES);
        assert_eq!(
            decode(&vec![b' '; MAX_BYTES + 1], ORIGIN, ID)
                .err()
                .unwrap(),
            TOO_LARGE
        );
        let mut value = fixture();
        for doc in value["documents"].as_array_mut().unwrap() {
            doc["body"] = json!("\u{1}".repeat(100000));
        }
        let value = rehash(value);
        assert!(serde_json::to_vec(&value).unwrap().len() > MAX_BYTES);
        assert_eq!(parse(&value).err().unwrap(), TOO_LARGE);
    }
    #[test]
    fn save_revalidates_package_and_hash_cancellation_is_one_key_without_path() {
        let value = fixture();
        let hash = value["snapshotHash"].as_str().unwrap();
        assert!(save_bytes(ORIGIN, ID, hash, value.clone()).is_ok());
        assert!(save_bytes(ORIGIN, ID, &format!("sha256:{}", "0".repeat(64)), value).is_err());
        assert_eq!(cancellation(), json!({"cancelled":true}));
        assert_eq!(cancellation().as_object().unwrap().len(), 1);
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "hub-public-export-fixture-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn atomic_owned_temp_success_collision_and_rename_failure_preserve_existing_content() {
        let fixture = Fixture::new();
        let destination = fixture.0.join("export.json");
        atomic_write(&destination, b"synthetic public JSON").unwrap();
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"synthetic public JSON"
        );
        let collision = fixture.0.join(".own-existing.tmp");
        std::fs::write(&collision, b"preexisting unrelated").unwrap();
        assert!(atomic_write_at(&destination, collision.clone(), b"new").is_err());
        assert_eq!(std::fs::read(&collision).unwrap(), b"preexisting unrelated");
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"synthetic public JSON"
        );
        let directory = fixture.0.join("existing-dir");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("preserved"), b"old").unwrap();
        let temporary = fixture.0.join(".owned.tmp");
        assert!(atomic_write_at(&directory, temporary.clone(), b"new").is_err());
        assert!(!temporary.exists());
        assert_eq!(std::fs::read(directory.join("preserved")).unwrap(), b"old");
        assert!(atomic_write(&destination, &vec![0; MAX_BYTES + 1]).is_err());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"synthetic public JSON"
        );
    }
    fn accept(listener: &std::net::TcpListener) -> std::net::TcpStream {
        listener.set_nonblocking(true).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        loop {
            match listener.accept() {
                Ok((stream, _)) => return stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "fixture_accept_timeout"
                    );
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(_) => panic!("fixture_accept_failed"),
            }
        }
    }
    fn serve(mut stream: std::net::TcpStream, status: &str, extra: &str, body: &[u8]) -> String {
        use std::io::Read;
        // Windows hands out accepted sockets with the listener's non-blocking mode.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0; 512];
        while !bytes.windows(4).any(|v| v == b"\r\n\r\n") {
            let n = stream.read(&mut chunk).unwrap();
            assert!(n > 0 && bytes.len() + n <= 8192, "fixture_header_boundary");
            bytes.extend_from_slice(&chunk[..n]);
        }
        let header=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",body.len());
        stream.write_all(header.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
        String::from_utf8(bytes).unwrap()
    }
    #[tokio::test]
    async fn actual_read_loopback_has_fixed_get_and_no_authorization_or_cookies() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mut value = fixture();
        value["href"] = json!(format!("{origin}/v2/research/{ID}"));
        let value = rehash(value);
        let expected = value["snapshotHash"].as_str().unwrap().to_owned();
        let bytes = serde_json::to_vec(&value).unwrap();
        let server = std::thread::spawn(move || serve(accept(&listener), "200 OK", "", &bytes));
        let result = read(&origin, ID).await.unwrap();
        let received = server.join().unwrap();
        assert_eq!(result.snapshot_hash, expected);
        assert!(
            received.starts_with(&format!(
                "GET /api/network/v1/research/{ID}/fork HTTP/1.1\r\n"
            )),
            "fixed_get_required"
        );
        let received = received.to_ascii_lowercase();
        assert!(
            !received.contains("authorization:"),
            "anonymous_authorization_required"
        );
        assert!(!received.contains("cookie:"), "anonymous_cookie_required");
    }
    #[tokio::test]
    async fn actual_read_never_follows_redirect_to_other_loopback_endpoint() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let main = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", main.local_addr().unwrap());
        let trap = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target = format!("http://{}/redirected", trap.local_addr().unwrap());
        trap.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let trapped = Arc::new(AtomicBool::new(false));
        let ending = Arc::clone(&stop);
        let called = Arc::clone(&trapped);
        let mut value = fixture();
        value["href"] = json!(format!("{origin}/v2/research/{ID}"));
        let bytes = serde_json::to_vec(&rehash(value)).unwrap();
        let trap_server = std::thread::spawn(move || {
            while !ending.load(Ordering::SeqCst) {
                match trap.accept() {
                    Ok((stream, _)) => {
                        called.store(true, Ordering::SeqCst);
                        serve(stream, "200 OK", "", &bytes);
                        return;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => panic!("fixture_trap_failed"),
                }
            }
        });
        let server = std::thread::spawn(move || {
            serve(
                accept(&main),
                "302 Found",
                &format!("Location: {target}\r\n"),
                b"",
            )
        });
        let result = read(&origin, ID).await;
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
        trap_server.join().unwrap();
        assert_eq!(result.err().unwrap(), UNAVAILABLE);
        assert!(!trapped.load(Ordering::SeqCst));
    }
}
