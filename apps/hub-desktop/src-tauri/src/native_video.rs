//! Hub self-made videos from the desktop (docs/hub-video/PLAN.md lane V6).
//!
//! The bundled window cannot fetch, so everything goes through here:
//!   * `native_video_request`   closed table of Hub calls under `/api/client/videos/native` (no free paths)
//!   * `native_video_pick_file` OS file dialog; the path stays in Rust, the window gets an opaque id
//!   * `native_video_upload`    ticket -> Video Worker multipart upload -> complete, file read here
//!   * `native_video_play`      play ticket -> playlist text (what the web player gets, nothing more)
//!
//! Hub receives metadata only; the video bytes go straight to the Video Worker. The upload secret
//! and the play ticket never leave this module. Hub-side auth note: these Hub routes currently
//! accept the web session cookie; they must also accept the desktop assertion (bearer) before this
//! works end to end.
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};

const NATIVE: &str = "/api/client/videos/native";
const MAX_PICKED: usize = 8;
const MAX_PART_BYTES: u64 = 128 * 1024 * 1024;
const MAX_JSON: usize = 256 * 1024;
const MAX_PLAYLIST: usize = 1024 * 1024;
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv"];

struct Picked {
    path: std::path::PathBuf,
    size: u64,
}
static PICKED: Mutex<Option<HashMap<String, Picked>>> = Mutex::new(None);

// ---------------------------------------------------------------- allowlist

/// 識別子の形。英数字と `-` `_` だけ、1〜128字。区切り・クエリ・百分符号・空白は通さない。
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 窓から来る操作名 → (メソッド, パス)。この表に無いものは作れない。
/// create と play は専用の命令の中でだけ組み立てる（窓からは呼べない）。
pub fn request_for(op: &str, id: Option<&str>) -> Result<(Method, String), String> {
    let id_path = |suffix: &str| -> Result<String, String> {
        let id = id.filter(|id| valid_id(id)).ok_or("native_video_bad_id")?;
        Ok(format!("{NATIVE}/{id}{suffix}"))
    };
    match op {
        "list" => {
            if id.is_some() { return Err("native_video_bad_id".into()); }
            Ok((Method::GET, NATIVE.to_owned()))
        }
        "get" => Ok((Method::GET, id_path("")?)),
        "update" => Ok((Method::PATCH, id_path("")?)),
        "delete" => Ok((Method::DELETE, id_path("")?)),
        "publish" => Ok((Method::POST, id_path("/publish")?)),
        "unpublish" => Ok((Method::POST, id_path("/unpublish")?)),
        _ => Err("native_video_op_not_allowed".into()),
    }
}

const VISIBILITIES: &[&str] = &["public", "unlisted", "followers", "gated"];

/// update の本文。許す項目だけを型付きで取り出す（窓のJSONをそのまま流さない）。
pub fn update_body(patch: &Value) -> Result<Value, String> {
    let object = patch.as_object().ok_or("native_video_bad_input")?;
    let mut out = serde_json::Map::new();
    for (key, value) in object {
        match key.as_str() {
            "title" => { let t = value.as_str().ok_or("native_video_bad_input")?.trim(); if t.is_empty() || t.chars().count() > 100 { return Err("native_video_bad_input".into()); } out.insert(key.clone(), json!(t)); }
            "description" => { let t = value.as_str().ok_or("native_video_bad_input")?.trim(); if t.chars().count() > 5000 { return Err("native_video_bad_input".into()); } out.insert(key.clone(), json!(t)); }
            "visibility" => { let t = value.as_str().filter(|t| VISIBILITIES.contains(t)).ok_or("native_video_bad_input")?; out.insert(key.clone(), json!(t)); }
            "ageRestricted" | "commentsEnabled" => { out.insert(key.clone(), json!(value.as_bool().ok_or("native_video_bad_input")?)); }
            _ => return Err("native_video_bad_input".into()),
        }
    }
    if out.is_empty() { return Err("native_video_bad_input".into()); }
    Ok(Value::Object(out))
}

/// Worker 側の絶対でないパス。Hub が札と一緒に返す。`/video/api/v1/` の下の安全な文字だけ。
pub fn valid_worker_path(path: &str) -> bool {
    path.starts_with("/video/api/v1/")
        && path.len() <= 256
        && !path.contains("//")
        && !path.split('/').any(|part| part == "." || part == "..")
        && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

// ---------------------------------------------------------------- MP4 probe

#[derive(Debug, PartialEq)]
pub struct Probe { pub seconds: Option<f64>, pub width: Option<u32>, pub height: Option<u32> }

fn be32(b: &[u8], at: usize) -> Option<u32> { b.get(at..at + 4).map(|s| u32::from_be_bytes(s.try_into().unwrap())) }
fn be64(b: &[u8], at: usize) -> Option<u64> { b.get(at..at + 8).map(|s| u64::from_be_bytes(s.try_into().unwrap())) }

fn children(data: &[u8]) -> Vec<(&[u8], &[u8])> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at + 8 <= data.len() {
        let Some(mut size) = be32(data, at).map(u64::from) else { break };
        let kind = &data[at + 4..at + 8];
        let mut header = 8usize;
        if size == 1 { let Some(big) = be64(data, at + 8) else { break }; size = big; header = 16; }
        if size == 0 { size = (data.len() - at) as u64; }
        if size < header as u64 || at as u64 + size > data.len() as u64 { break; }
        out.push((kind, &data[at + header..at + size as usize]));
        at += size as usize;
    }
    out
}

/// MP4 / MOV の moov から長さと寸法（回転を反映）を読む。読めない形式は None を返す。
pub fn probe_mp4<R: Read + Seek>(reader: &mut R) -> Probe {
    let none = Probe { seconds: None, width: None, height: None };
    let Ok(total) = reader.seek(SeekFrom::End(0)) else { return none };
    let mut at = 0u64;
    while at + 8 <= total {
        let mut head = [0u8; 16];
        if reader.seek(SeekFrom::Start(at)).is_err() { return none; }
        let Ok(read) = reader.read(&mut head) else { return none };
        if read < 8 { return none; }
        let mut size = u64::from(u32::from_be_bytes(head[0..4].try_into().unwrap()));
        let mut header = 8u64;
        if size == 1 { if read < 16 { return none; } size = u64::from_be_bytes(head[8..16].try_into().unwrap()); header = 16; }
        if size == 0 { size = total - at; }
        if size < header { return none; }
        if &head[4..8] == b"moov" {
            let body = size - header;
            if body > 32 * 1024 * 1024 || reader.seek(SeekFrom::Start(at + header)).is_err() { return none; }
            let mut buffer = vec![0u8; body as usize];
            if reader.read_exact(&mut buffer).is_err() { return none; }
            return probe_moov(&buffer);
        }
        at += size;
    }
    none
}

fn probe_moov(moov: &[u8]) -> Probe {
    let mut seconds = None;
    let (mut width, mut height) = (None, None);
    for (kind, body) in children(moov) {
        if kind == b"mvhd" {
            let version = body.first().copied().unwrap_or(0);
            let (scale, duration) = if version == 1 { (be32(body, 20).map(u64::from), be64(body, 24)) } else { (be32(body, 12).map(u64::from), be32(body, 16).map(u64::from)) };
            if let (Some(scale), Some(duration)) = (scale, duration) { if scale > 0 { seconds = Some(duration as f64 / scale as f64); } }
        } else if kind == b"trak" {
            for (inner, tkhd) in children(body) {
                if inner != b"tkhd" { continue; }
                let version = tkhd.first().copied().unwrap_or(0);
                let matrix = if version == 1 { 52 } else { 40 };
                let (Some(a), Some(b), Some(w), Some(h)) = (be32(tkhd, matrix), be32(tkhd, matrix + 4), be32(tkhd, matrix + 36), be32(tkhd, matrix + 40)) else { continue };
                let (w, h) = (w >> 16, h >> 16);
                if w == 0 || h == 0 { continue; }
                let rotated = a == 0 && (b == 0x0001_0000 || b == 0xFFFF_0000);
                let (w, h) = if rotated { (h, w) } else { (w, h) };
                if width.is_none() { width = Some(w); height = Some(h); }
            }
        }
    }
    Probe { seconds, width, height }
}

// ---------------------------------------------------------------- HTTP

fn base() -> String { crate::hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref()) }

fn require_main(window: &tauri::Webview) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("native_video_rejected".into()) }
}

fn client(seconds: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(seconds)).redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "native_video_unavailable".to_owned())
}

async fn read_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let bytes = response.bytes().await.map_err(|_| "native_video_unavailable".to_owned())?;
    if bytes.len() > MAX_JSON { return Err("native_video_unavailable".into()); }
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status.is_success() { return Ok(body); }
    // Hub's error code (a short snake_case word) is safe to pass on; the free text is not.
    let code = body.get("code").and_then(Value::as_str).filter(|c| c.len() <= 48 && c.chars().all(|c| c.is_ascii_lowercase() || c == '_'));
    Err(match (status.as_u16(), code) {
        (401, _) => "desktop_not_connected".to_owned(),
        (_, Some(code)) => format!("native_video:{code}"),
        (status, None) => format!("native_video_http_{status}"),
    })
}

async fn hub_call(method: Method, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let base = base();
    let url = reqwest::Url::parse(&format!("{}{}", base.trim_end_matches('/'), path)).map_err(|_| "native_video_unavailable".to_owned())?;
    let token = crate::desktop_account::assertion_if_registered(&base).await?.ok_or("desktop_not_connected")?;
    let mut request = client(20)?.request(method, url).bearer_auth(token);
    if let Some(body) = body { request = request.json(body); }
    read_json(request.send().await.map_err(|_| "native_video_unavailable".to_owned())?).await
}

#[tauri::command]
pub async fn native_video_request(window: tauri::Webview, op: String, id: Option<String>, patch: Option<Value>) -> Result<Value, String> {
    require_main(&window)?;
    let (method, path) = request_for(&op, id.as_deref())?;
    let body = if op == "update" { Some(update_body(patch.as_ref().ok_or("native_video_bad_input")?)?) } else { None };
    hub_call(method, &path, body.as_ref()).await
}

// ---------------------------------------------------------------- file pick

#[tauri::command]
pub async fn native_video_pick_file(window: tauri::Webview, app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    require_main(&window)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("動画", VIDEO_EXTENSIONS).pick_file(move |chosen| { let _ = tx.send(chosen); });
    let Some(chosen) = rx.await.map_err(|_| "native_video_dialog_failed".to_owned())? else { return Ok(Value::Null) };
    let path = chosen.as_path().ok_or("native_video_file_unavailable")?.to_path_buf();
    let extension = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !VIDEO_EXTENSIONS.contains(&extension.as_str()) { return Err("native_video_unsupported".into()); }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("video").chars().take(120).collect::<String>();
    let probe_path = path.clone();
    let (size, probe) = tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&probe_path).map_err(|_| "native_video_file_unavailable".to_owned())?;
        let metadata = file.metadata().map_err(|_| "native_video_file_unavailable".to_owned())?;
        if !metadata.is_file() || metadata.len() == 0 { return Err("native_video_file_unavailable".to_owned()); }
        let mut reader = std::io::BufReader::new(file);
        Ok::<_, String>((metadata.len(), probe_mp4(&mut reader)))
    }).await.map_err(|_| "native_video_file_unavailable".to_owned())??;
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut guard = PICKED.lock().map_err(|_| "native_video_unavailable".to_owned())?;
        let map = guard.get_or_insert_with(HashMap::new);
        if map.len() >= MAX_PICKED { map.clear(); }
        map.insert(id.clone(), Picked { path, size });
    }
    Ok(json!({"fileId": id, "name": name, "size": size, "durationSeconds": probe.seconds, "width": probe.width, "height": probe.height}))
}

// ---------------------------------------------------------------- upload

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadInput {
    file_id: String,
    title: String,
    #[serde(default)] description: String,
    visibility: String,
    license: String,
    #[serde(default)] age_restricted: bool,
    #[serde(default = "yes")] comments_enabled: bool,
    duration_seconds: f64,
    #[serde(default)] kind: Option<String>,
}
fn yes() -> bool { true }

/// 札を発行する本文。source は常に desktop。
pub fn create_body(input: &UploadInput, size: u64) -> Result<Value, String> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 100 || input.description.chars().count() > 5000 { return Err("native_video_bad_input".into()); }
    if !VISIBILITIES.contains(&input.visibility.as_str()) { return Err("native_video_bad_input".into()); }
    if !(input.license.len() <= 16 && input.license.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')) { return Err("native_video_bad_input".into()); }
    if !input.duration_seconds.is_finite() || input.duration_seconds <= 0.0 || input.duration_seconds > 24.0 * 3600.0 { return Err("native_video_bad_input".into()); }
    let kind = match input.kind.as_deref() { None | Some("normal") => "normal", Some("short") => "short", _ => return Err("native_video_bad_input".into()) };
    Ok(json!({"title": title, "description": input.description.trim(), "visibility": input.visibility, "source": "desktop", "sizeBytes": size,
        "durationSeconds": input.duration_seconds, "kind": kind, "license": input.license, "ageRestricted": input.age_restricted, "commentsEnabled": input.comments_enabled}))
}

fn worker_url(path: &str) -> Result<reqwest::Url, String> {
    if !valid_worker_path(path) { return Err("native_video_bad_response".into()); }
    reqwest::Url::parse(&format!("{}{}", base().trim_end_matches('/'), path)).map_err(|_| "native_video_bad_response".to_owned())
}

fn read_part(path: &std::path::Path, start: u64, length: u64) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path).map_err(|_| "native_video_file_unavailable".to_owned())?;
    file.seek(SeekFrom::Start(start)).map_err(|_| "native_video_file_unavailable".to_owned())?;
    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer).map_err(|_| "native_video_file_unavailable".to_owned())?;
    Ok(buffer)
}

#[tauri::command]
pub async fn native_video_upload(window: tauri::Webview, input: Value) -> Result<Value, String> {
    require_main(&window)?;
    let input: UploadInput = serde_json::from_value(input).map_err(|_| "native_video_bad_input".to_owned())?;
    let (path, size) = {
        let guard = PICKED.lock().map_err(|_| "native_video_unavailable".to_owned())?;
        let picked = guard.as_ref().and_then(|map| map.get(&input.file_id)).ok_or("native_video_file_unavailable")?;
        (picked.path.clone(), picked.size)
    };
    // The file must still be the one that was picked.
    let current = std::fs::metadata(&path).map_err(|_| "native_video_file_unavailable".to_owned())?;
    if !current.is_file() || current.len() != size { return Err("native_video_file_changed".into()); }

    let issued = hub_call(Method::POST, NATIVE, Some(&create_body(&input, size)?)).await?;
    let ticket = issued.get("upload").ok_or("native_video_bad_response")?;
    let video_id = ticket.get("videoId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("native_video_bad_response")?.to_owned();
    let ticket_path = ticket.get("path").and_then(Value::as_str).ok_or("native_video_bad_response")?;
    let ticket_header = ticket.get("header").and_then(Value::as_str).filter(|h| valid_header_name(h)).ok_or("native_video_bad_response")?;
    let ticket_value = ticket.get("ticket").and_then(Value::as_str).filter(|t| t.len() <= 4096).ok_or("native_video_bad_response")?;
    let max_bytes = ticket.get("maxBytes").and_then(Value::as_u64).ok_or("native_video_bad_response")?;
    if size > max_bytes { return Err("native_video:file_too_large".into()); }
    let upload_path = ticket_path.to_owned();

    let worker = client(60)?;
    let started = read_json(worker.post(worker_url(&upload_path)?).header(ticket_header, ticket_value)
        .json(&json!({"source": "desktop", "files": [{"variant": "main", "bytes": size}]})).send().await.map_err(|_| "native_video_unavailable".to_owned())?).await?;
    let upload = started.get("upload").ok_or("native_video_bad_response")?;
    let token = upload.get("token").and_then(Value::as_str).filter(|t| t.len() <= 4096).ok_or("native_video_bad_response")?.to_owned();
    let header = upload.get("header").and_then(Value::as_str).filter(|h| valid_header_name(h)).ok_or("native_video_bad_response")?.to_owned();
    let part_size = upload.get("partSizeBytes").and_then(Value::as_u64).filter(|n| *n > 0 && *n <= MAX_PART_BYTES).ok_or("native_video_bad_response")?;
    let part_count = upload.get("files").and_then(Value::as_array).and_then(|files| files.iter().find(|f| f.get("variant").and_then(Value::as_str) == Some("main")))
        .and_then(|f| f.get("partCount")).and_then(Value::as_u64).ok_or("native_video_bad_response")?;
    if part_count == 0 || part_count != size.div_ceil(part_size) { return Err("native_video_bad_response".into()); }

    let part_client = client(300)?;
    for part in 1..=part_count {
        let start = (part - 1) * part_size;
        let length = part_size.min(size - start);
        let read_from = path.clone();
        let body = tokio::task::spawn_blocking(move || read_part(&read_from, start, length)).await.map_err(|_| "native_video_file_unavailable".to_owned())??;
        let url = worker_url(&format!("{upload_path}/main/parts/{part}"))?;
        let mut last = "native_video_unavailable".to_owned();
        let mut sent = false;
        for attempt in 0..4u32 {
            if attempt > 0 { tokio::time::sleep(std::time::Duration::from_millis(500 * 2u64.pow(attempt - 1))).await; }
            match part_client.put(url.clone()).header(header.as_str(), token.as_str()).body(body.clone()).send().await {
                Ok(response) if response.status().is_success() => { sent = true; break; }
                Ok(response) => {
                    let status = response.status().as_u16();
                    last = match status { 401 => "native_video:upload_token_invalid".to_owned(), 410 => "native_video:upload_expired".to_owned(), _ => format!("native_video_http_{status}") };
                    if !matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504) { return Err(last); }
                }
                Err(_) => {}
            }
        }
        if !sent { return Err(last); }
    }
    read_json(worker.post(worker_url(&format!("{upload_path}/complete"))?).header(header.as_str(), token.as_str()).send().await.map_err(|_| "native_video_unavailable".to_owned())?).await?;
    Ok(json!({"videoId": video_id}))
}

// ---------------------------------------------------------------- playback

/// プレイリスト中の URI 行を、プレイリスト自身の URL に対する絶対 URL にする。
pub fn absolutize_playlist(playlist: &str, base: &reqwest::Url) -> Result<String, String> {
    let mut lines = Vec::new();
    for raw in playlist.lines() {
        let line = raw.trim();
        if line.is_empty() { lines.push(String::new()); continue; }
        if let Some(rest) = line.strip_prefix('#') {
            if let Some(start) = line.find("URI=\"") {
                let after = &line[start + 5..];
                if let Some(end) = after.find('"') {
                    let joined = base.join(&after[..end]).map_err(|_| "native_video_bad_response".to_owned())?;
                    lines.push(format!("#{}{}{}", &rest[..start - 1], format!("URI=\"{joined}\""), &after[end + 1..]));
                    continue;
                }
            }
            lines.push(line.to_owned());
            continue;
        }
        lines.push(base.join(line).map_err(|_| "native_video_bad_response".to_owned())?.to_string());
    }
    Ok(lines.join("\n"))
}

/// 再生札 → プレイリスト。窓へ返すのは、Web のプレーヤーが受け取るのと同じ「絶対URLのプレイリスト」と期限だけ。
/// 札・ヘッダ名・R2 のキーは返さない。区切りのトークンはプレイリストの URL に含まれる（Web と同じ）。
#[tauri::command]
pub async fn native_video_play(window: tauri::Webview, id: String) -> Result<Value, String> {
    require_main(&window)?;
    if !valid_id(&id) { return Err("native_video_bad_id".into()); }
    let issued = hub_call(Method::POST, &format!("{NATIVE}/{id}/play"), None).await?;
    let play = issued.get("play").ok_or("native_video_bad_response")?;
    let path = play.get("path").and_then(Value::as_str).ok_or("native_video_bad_response")?;
    let header = play.get("header").and_then(Value::as_str).filter(|h| valid_header_name(h)).ok_or("native_video_bad_response")?;
    let ticket = play.get("ticket").and_then(Value::as_str).filter(|t| t.len() <= 4096).ok_or("native_video_bad_response")?;
    if play.get("method").and_then(Value::as_str) != Some("POST") { return Err("native_video_bad_response".into()); }
    let url = worker_url(path)?;
    let response = client(20)?.post(url.clone()).header(header, ticket).send().await.map_err(|_| "native_video_unavailable".to_owned())?;
    if !response.status().is_success() { return Err(format!("native_video_http_{}", response.status().as_u16())); }
    let bytes = response.bytes().await.map_err(|_| "native_video_unavailable".to_owned())?;
    if bytes.len() > MAX_PLAYLIST { return Err("native_video_bad_response".into()); }
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| "native_video_bad_response".to_owned())?;
    if !text.starts_with("#EXTM3U") { return Err("native_video_bad_response".into()); }
    Ok(json!({"playlist": absolutize_playlist(&text, &url)?, "expiresAt": play.get("expiresAt").and_then(Value::as_str)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_listed_paths_and_methods_exist() {
        assert_eq!(request_for("list", None).unwrap(), (Method::GET, "/api/client/videos/native".to_owned()));
        assert_eq!(request_for("get", Some("v-1_A")).unwrap(), (Method::GET, "/api/client/videos/native/v-1_A".to_owned()));
        assert_eq!(request_for("update", Some("v1")).unwrap().0, Method::PATCH);
        assert_eq!(request_for("delete", Some("v1")).unwrap().0, Method::DELETE);
        assert_eq!(request_for("publish", Some("v1")).unwrap(), (Method::POST, "/api/client/videos/native/v1/publish".to_owned()));
        assert_eq!(request_for("unpublish", Some("v1")).unwrap(), (Method::POST, "/api/client/videos/native/v1/unpublish".to_owned()));
        // create and play are not reachable from the window; neither is anything else.
        for op in ["create", "play", "suspend", "admin", "", "LIST", "list/../x", "get/../../x"] { assert!(request_for(op, Some("v1")).is_err(), "{op}"); }
        assert!(request_for("list", Some("v1")).is_err());
    }

    #[test]
    fn ids_reject_traversal_and_odd_forms() {
        for bad in ["", "../x", "a/b", "a?b=1", "a%2e", "a b", " ", "a#b", "a\\b", "..", ".", "v\n1", "日本語", &"a".repeat(129)] {
            assert!(!valid_id(bad), "{bad:?}");
            for op in ["get", "update", "delete", "publish", "unpublish"] { assert!(request_for(op, Some(bad)).is_err()); }
        }
        for op in ["get", "update", "delete", "publish", "unpublish"] { assert!(request_for(op, None).is_err()); }
        assert!(valid_id(&"a".repeat(128)));
    }

    #[test]
    fn update_body_keeps_only_known_typed_fields() {
        let ok = update_body(&json!({"title": " 題 ", "visibility": "unlisted", "commentsEnabled": false})).unwrap();
        assert_eq!(ok, json!({"title": "題", "visibility": "unlisted", "commentsEnabled": false}));
        for bad in [json!({}), json!({"title": ""}), json!({"visibility": "everyone"}), json!({"ageRestricted": "yes"}), json!({"title": "x", "source": "web"}), json!({"title": "a".repeat(101)}), json!("x"), json!({"license": "arr"})] {
            assert!(update_body(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn worker_paths_must_stay_under_the_video_api() {
        assert!(valid_worker_path("/video/api/v1/assets/0a1b2c3d-0000-4000-8000-000000000000/upload"));
        for bad in ["/other/api", "/video/api/v1/../x", "/video/api/v1//x", "/video/api/v1/x?y=1", "/video/api/v1/x#a", "https://evil.example/video/api/v1/x", "/video/api/v1/x%2e", "video/api/v1/x", "/video/api/v1/a b"] {
            assert!(!valid_worker_path(bad), "{bad}");
        }
    }

    #[test]
    fn create_body_is_desktop_sourced_and_validated() {
        let input = |extra: Value| { let mut v = json!({"fileId": "f", "title": "題名", "visibility": "public", "license": "cc-by", "durationSeconds": 30.0}); for (k, x) in extra.as_object().unwrap() { v[k] = x.clone(); } serde_json::from_value::<UploadInput>(v).unwrap() };
        let body = create_body(&input(json!({"kind": "short"})), 1234).unwrap();
        assert_eq!(body["source"], "desktop");
        assert_eq!(body["sizeBytes"], 1234);
        assert_eq!(body["kind"], "short");
        assert!(create_body(&input(json!({"kind": "live"})), 1).is_err());
        assert!(create_body(&input(json!({"visibility": "x"})), 1).is_err());
        assert!(create_body(&input(json!({"durationSeconds": 0.0})), 1).is_err());
        assert!(create_body(&input(json!({"license": "../x"})), 1).is_err());
        assert!(serde_json::from_value::<UploadInput>(json!({"fileId": "f", "title": "t", "visibility": "public", "license": "arr", "durationSeconds": 1.0, "path": "C:/x"})).is_err());
    }

    fn mp4(w: u32, h: u32, rotate: bool) -> Vec<u8> {
        let bx = |kind: &[u8], body: Vec<u8>| { let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec(); v.extend(kind); v.extend(body); v };
        let mut mvhd = vec![0u8; 100]; mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes()); mvhd[16..20].copy_from_slice(&45_000u32.to_be_bytes());
        let mut tkhd = vec![0u8; 84]; tkhd[40..44].copy_from_slice(&if rotate { 0 } else { 0x10000u32 }.to_be_bytes()); tkhd[44..48].copy_from_slice(&if rotate { 0x10000u32 } else { 0 }.to_be_bytes());
        tkhd[76..80].copy_from_slice(&(w << 16).to_be_bytes()); tkhd[80..84].copy_from_slice(&(h << 16).to_be_bytes());
        let moov = bx(b"moov", [bx(b"mvhd", mvhd), bx(b"trak", bx(b"tkhd", tkhd))].concat());
        [bx(b"ftyp", b"isom0000".to_vec()), bx(b"mdat", vec![0; 10]), moov].concat()
    }

    #[test]
    fn mp4_probe_reads_length_size_and_rotation() {
        let plain = probe_mp4(&mut std::io::Cursor::new(mp4(1920, 1080, false)));
        assert_eq!(plain, Probe { seconds: Some(45.0), width: Some(1920), height: Some(1080) });
        let turned = probe_mp4(&mut std::io::Cursor::new(mp4(1920, 1080, true)));
        assert_eq!((turned.width, turned.height), (Some(1080), Some(1920)));
        assert_eq!(probe_mp4(&mut std::io::Cursor::new(b"not a video at all".to_vec())), Probe { seconds: None, width: None, height: None });
        assert_eq!(probe_mp4(&mut std::io::Cursor::new(Vec::new())).seconds, None);
    }

    #[test]
    fn playlist_uris_become_absolute_against_the_playlist_url() {
        let base = reqwest::Url::parse("https://hub.example/video/api/v1/play").unwrap();
        let out = absolutize_playlist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key?t=1\"\n#EXTINF:4,\nseg/1.ts?t=2\n", &base).unwrap();
        assert!(out.contains("URI=\"https://hub.example/video/api/v1/key?t=1\""));
        assert!(out.contains("\nhttps://hub.example/video/api/v1/seg/1.ts?t=2"));
        assert!(out.starts_with("#EXTM3U"));
    }
}
