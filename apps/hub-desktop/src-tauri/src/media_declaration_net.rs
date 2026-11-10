//! 作者の宣言・取り消し（音声・動画・ファイル共通の hub.media.declaration）を世界網へ出し、フォロー中の作者の物を取り戻す（docs/hub-p2p-redesign/DESIGN.md §12）。
//!
//! 経路は既存の Hub 窓口と同じ：端末の Rust → Hub（Desktop の assertion）→ Federation の object 層。署名は端末で済んでいて、
//! Hub と Federation は検査と中継だけをする。Music へは何も送らない。窓から来るのは曲の UUID と版だけで、宛先と本文は全部ここで組む。
//!
//! フォロー中の作者の根鍵は Hub が答える（ローカルのプロフィールは登録済みの根鍵、外部 actor は Federation が既に取得済みの
//! assertionMethod）。端末はそれをメモリにだけ置く（10 分）。ディスクには書かない。

use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::artifact_store::sha256_hex;
use crate::media_manifest::canonical_json;
use crate::media_declaration::{verify_declaration, verify_declaration_tombstone, LocalStore};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_KEYS: usize = 4000;
const MAX_FETCHED: usize = 2000;
const AUTHORS_PER_REQUEST: usize = 100;
pub const KEY_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

type Check<T> = Result<T, &'static str>;

// ---------------------------------------------------------------------------
// 純粋な部分（試験の対象）
// ---------------------------------------------------------------------------

pub fn statements_url(base: &str) -> String {
    format!("{}/api/client/network/media-declarations", base.trim_end_matches('/'))
}

pub fn followed_keys_url(base: &str) -> String {
    format!("{}/api/client/network/followed-keys", base.trim_end_matches('/'))
}

fn did_key_ok(value: &str) -> bool {
    value.starts_with("did:key:zDn") && value.len() <= 120 && value[8..].bytes().all(|c| c.is_ascii_alphanumeric())
}

/// Hub の答え `{ "keys": [...] }` から did:key だけを取り出す。形の違う物は黙って捨てる。
pub fn parse_followed_keys(body: &Value) -> BTreeSet<String> {
    body.get("keys")
        .and_then(Value::as_array)
        .map(|keys| keys.iter().filter_map(Value::as_str).filter(|key| did_key_ok(key)).take(MAX_KEYS).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// 宣言・取り消しの識別（署名込みの正準JSONの SHA-256）。公開済みの印に使う。
pub fn document_digest(doc: &Value) -> Check<String> {
    Ok(sha256_hex(canonical_json(doc).map_err(|_| "declaration_malformed")?.as_bytes()))
}

/// まだ Hub へ出していない、端末の署名済み文書（宣言・取り消しの順）。
pub fn unpublished(store: &LocalStore) -> Vec<Value> {
    let done: BTreeSet<&str> = store.published.iter().map(String::as_str).collect();
    store
        .declarations
        .iter()
        .chain(store.tombstones.iter())
        // 旧形（hub.music.*）は世界網の型ではないので出さない。
        .filter(|doc| matches!(doc.get("type").and_then(Value::as_str), Some(crate::media_declaration::DECLARATION_TYPE | crate::media_declaration::DECLARATION_TOMBSTONE_TYPE)))
        .filter(|doc| document_digest(doc).is_ok_and(|digest| !done.contains(digest.as_str())))
        .cloned()
        .collect()
}

pub fn publish_body(doc: &Value) -> Value {
    json!({ "document": doc })
}

/// 取り戻した答えを検査して取り込む：署名が通り、頼んだ作者の物だけ。取り込んだ件数を返す。
pub fn absorb_fetched(store: &mut LocalStore, body: &Value, authors: &BTreeSet<String>) -> usize {
    let mut taken = 0;
    let mut keep = |list: &mut Vec<Value>, docs: Option<&Vec<Value>>, ok: fn(&Value) -> Check<crate::media_declaration::Declaration>| {
        for doc in docs.into_iter().flatten().take(MAX_FETCHED) {
            let Ok(declaration) = ok(doc) else { continue };
            if !authors.contains(&declaration.author) {
                continue;
            }
            let Ok(digest) = document_digest(doc) else { continue };
            if list.iter().any(|known| document_digest(known).is_ok_and(|d| d == digest)) {
                continue;
            }
            list.push(doc.clone());
            taken += 1;
        }
    };
    let declarations = body.get("declarations").and_then(Value::as_array);
    let tombstones = body.get("tombstones").and_then(Value::as_array);
    keep(&mut store.fetched_declarations, declarations, verify_declaration);
    keep(&mut store.fetched_tombstones, tombstones, verify_declaration_tombstone);
    let cap = MAX_FETCHED;
    if store.fetched_declarations.len() > cap {
        let excess = store.fetched_declarations.len() - cap;
        store.fetched_declarations.drain(..excess);
    }
    if store.fetched_tombstones.len() > cap {
        let excess = store.fetched_tombstones.len() - cap;
        store.fetched_tombstones.drain(..excess);
    }
    taken
}

/// 取り込み（`decide`）に渡す宣言と取り消し：自分のと、フォロー中の作者から取り戻したもの。
pub fn intake_documents(store: &LocalStore) -> (Vec<Value>, Vec<Value>) {
    (
        store.declarations.iter().chain(store.fetched_declarations.iter()).cloned().collect(),
        store.tombstones.iter().chain(store.fetched_tombstones.iter()).cloned().collect(),
    )
}

/// メモリだけの写し。時刻は呼ぶ側が渡す（試験で進められる）。
#[derive(Default)]
pub struct KeyCache {
    entry: Option<(Instant, BTreeSet<String>)>,
}

impl KeyCache {
    pub fn get(&self, now: Instant) -> Option<BTreeSet<String>> {
        self.entry.as_ref().filter(|(at, _)| now.duration_since(*at) < KEY_CACHE_TTL).map(|(_, keys)| keys.clone())
    }
    pub fn put(&mut self, now: Instant, keys: BTreeSet<String>) {
        self.entry = Some((now, keys));
    }
    pub fn clear(&mut self) {
        self.entry = None;
    }
}

fn cache() -> &'static Mutex<KeyCache> {
    static CACHE: OnceLock<Mutex<KeyCache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

// ---------------------------------------------------------------------------
// Hub との通信
// ---------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|_| "接続を組み立てられません".to_owned())
}

async fn send(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|_| "ハブへ届きません".to_owned())?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("desktop_not_connected".into());
    }
    let bytes = response.bytes().await.map_err(|_| "受け取れませんでした".to_owned())?;
    if bytes.len() > MAX_BYTES {
        return Err("応答が大きすぎます".into());
    }
    if !status.is_success() {
        let code = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned));
        return Err(format!("media_declaration_hub:{}", code.unwrap_or_else(|| status.as_u16().to_string())));
    }
    serde_json::from_slice(&bytes).map_err(|_| "読めない形で返ってきました".to_owned())
}

async fn assertion(base: &str) -> Result<String, String> {
    crate::desktop_account::assertion_if_registered(base).await?.ok_or_else(|| "desktop_not_connected".to_owned())
}

/// まだ出していない文書を Hub へ出す。返すのは (出せた件数, 残った件数)。1 件でも出せなければ残りの印は付けない。
pub async fn publish_pending(storage: &str, base: &str) -> Result<(usize, usize), String> {
    let store = LocalStore::load(storage);
    let pending = unpublished(&store);
    if pending.is_empty() {
        return Ok((0, 0));
    }
    let mut done: Vec<String> = Vec::new();
    let mut first_error: Option<String> = None;
    for doc in &pending {
        // 要求ごとに新しい assertion を取る（同じ jti は使い回せない）。
        let result = async { send(client()?.post(statements_url(base)).bearer_auth(assertion(base).await?).json(&publish_body(doc))).await }.await;
        match result {
            Ok(_) => {
                if let Ok(digest) = document_digest(doc) {
                    done.push(digest);
                }
            }
            Err(error) => {
                first_error.get_or_insert(error);
                break;
            }
        }
    }
    if !done.is_empty() {
        let mut store = LocalStore::load(storage);
        store.published.extend(done.iter().cloned());
        store.save(storage)?;
    }
    match first_error {
        Some(error) if done.is_empty() => Err(error),
        _ => Ok((done.len(), pending.len() - done.len())),
    }
}

/// フォロー中の作者の根鍵。メモリの写しが新しければそれを返す。
pub async fn followed_keys(base: &str, force: bool) -> Result<BTreeSet<String>, String> {
    if !force {
        if let Some(keys) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(Instant::now()) {
            return Ok(keys);
        }
    }
    let body = send(client()?.get(followed_keys_url(base)).bearer_auth(assertion(base).await?)).await?;
    let keys = parse_followed_keys(&body);
    cache().lock().unwrap_or_else(|e| e.into_inner()).put(Instant::now(), keys.clone());
    Ok(keys)
}

/// フォロー中の作者の宣言・取り消しを Hub から取り戻し、署名を検査して端末に置く。返すのは取り込んだ件数。
pub async fn fetch_followed(storage: &str, base: &str) -> Result<usize, String> {
    let keys = followed_keys(base, false).await?;
    let authors: Vec<&String> = keys.iter().collect();
    let mut taken = 0;
    for chunk in authors.chunks(AUTHORS_PER_REQUEST) {
        let query = chunk.iter().map(|key| key.as_str()).collect::<Vec<_>>().join(",");
        let mut url = reqwest::Url::parse(&statements_url(base)).map_err(|_| "ハブの接続先が正しくありません".to_owned())?;
        url.query_pairs_mut().append_pair("authors", &query);
        let body = send(client()?.get(url).bearer_auth(assertion(base).await?)).await?;
        let mut store = LocalStore::load(storage);
        taken += absorb_fetched(&mut store, &body, &keys);
        store.save(storage)?;
    }
    Ok(taken)
}

// ---------------------------------------------------------------------------
// Tauri コマンド
// ---------------------------------------------------------------------------

fn guard(window: &tauri::Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !crate::local_pairing_address(window.label(), &url) {
        return Err("native_window_required".into());
    }
    Ok(())
}

async fn paths(state: &tauri::State<'_, std::sync::Arc<crate::RunnerState>>) -> Result<(String, String), String> {
    let node = state.node.as_ref().ok_or("media_unavailable:node_storage")?;
    let path = node.status().await.storage_path;
    if path.is_empty() {
        return Err("media_unavailable:node_storage".into());
    }
    Ok((path, crate::hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref())))
}

/// 端末にある宣言・取り消しのうち、Hub へまだ出していない物を出す。
#[tauri::command]
pub async fn media_p2p_publish(window: tauri::Webview, state: tauri::State<'_, std::sync::Arc<crate::RunnerState>>) -> Result<Value, String> {
    guard(&window)?;
    let (storage, base) = paths(&state).await?;
    let (published, remaining) = publish_pending(&storage, &base).await?;
    Ok(json!({ "published": published, "remaining": remaining }))
}

/// フォロー中の作者の根鍵の数（鍵そのものは窓へ渡さない）。
#[tauri::command]
pub async fn media_p2p_followed_keys(window: tauri::Webview, state: tauri::State<'_, std::sync::Arc<crate::RunnerState>>, refresh: Option<bool>) -> Result<Value, String> {
    guard(&window)?;
    let (_, base) = paths(&state).await?;
    let keys = followed_keys(&base, refresh.unwrap_or(false)).await?;
    Ok(json!({ "count": keys.len() }))
}

/// フォロー中の作者の宣言・取り消しを取り戻す。
#[tauri::command]
pub async fn media_p2p_fetch_declarations(window: tauri::Webview, state: tauri::State<'_, std::sync::Arc<crate::RunnerState>>) -> Result<Value, String> {
    guard(&window)?;
    let (storage, base) = paths(&state).await?;
    let taken = fetch_followed(&storage, &base).await?;
    Ok(json!({ "taken": taken }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_manifest::testkit::*;
    use crate::node_identity::NodeKey;
    use crate::portable_identity::{did_key_from_jwk, sign_document};

    fn author() -> (NodeKey, String) {
        let key = NodeKey::create();
        let did = did_key_from_jwk(&key.public_jwk()).expect("did");
        (key, did)
    }

    fn sign(key: &NodeKey, did: &str, statement: Value) -> Value {
        sign_document(&|data| Some(key.sign_bytes(data)), did, statement, "2026-11-05T00:00:00.000Z").expect("signed")
    }

    fn declared(key: &NodeKey, did: &str, revision: u64) -> Value {
        sign(key, did, json!({ "v": 1, "type": crate::media_declaration::DECLARATION_TYPE, "kind": "audio", "service": "https://hub.example/music", "attestation": "a".repeat(64), "itemId": "7c0e3a52-1b5d-4f6e-9a8b-0c1d2e3f4a5b", "revision": revision, "author": did, "issuedAt": "2026-11-05T00:00:00.000Z" }))
    }

    #[test]
    fn urls_are_built_here_from_the_hub_origin_only() {
        assert_eq!(statements_url("https://hub.example/"), "https://hub.example/api/client/network/media-declarations");
        assert_eq!(followed_keys_url("https://hub.example"), "https://hub.example/api/client/network/followed-keys");
    }

    #[test]
    fn followed_keys_keep_only_well_formed_did_keys() {
        let (_, did) = author();
        let body = json!({ "keys": [did, "did:web:evil.example", 7, "did:key:zDn bad", "did:key:z6Mk123"] });
        assert_eq!(parse_followed_keys(&body), BTreeSet::from([did]));
        assert!(parse_followed_keys(&json!({ "keys": "x" })).is_empty());
        assert!(parse_followed_keys(&json!({})).is_empty());
    }

    #[test]
    fn unpublished_lists_signed_documents_not_yet_marked_and_publishing_marks_them() {
        let (key, did) = author();
        let doc = declared(&key, &did, 3);
        let mut store = LocalStore { declarations: vec![doc.clone()], ..Default::default() };
        assert_eq!(unpublished(&store), vec![doc.clone()]);
        store.published.push(document_digest(&doc).unwrap());
        assert!(unpublished(&store).is_empty());
        assert_eq!(publish_body(&doc), json!({ "document": doc }));
        // 旧形の宣言は端末に残るだけで、世界網へは出さない。
        let old = sign(&key, &did, json!({ "v": 1, "type": crate::media_declaration::LEGACY_DECLARATION_TYPE, "attestation": "a".repeat(64), "trackId": "7c0e3a52-1b5d-4f6e-9a8b-0c1d2e3f4a5b", "revision": 1, "author": did, "issuedAt": "2026-11-05T00:00:00.000Z" }));
        let store = LocalStore { declarations: vec![old], ..Default::default() };
        assert!(unpublished(&store).is_empty());
    }

    #[test]
    fn fetched_documents_are_kept_only_with_a_valid_proof_by_a_followed_author() {
        let (key, did) = author();
        let (other_key, other_did) = author();
        let followed = BTreeSet::from([did.clone()]);
        let good = declared(&key, &did, 2);
        let mut tampered = declared(&key, &did, 2);
        tampered["revision"] = json!(9);
        let not_followed = declared(&other_key, &other_did, 2);
        let mut store = LocalStore::default();
        let body = json!({ "declarations": [good.clone(), tampered, not_followed, good.clone()], "tombstones": [] });
        assert_eq!(absorb_fetched(&mut store, &body, &followed), 1);
        assert_eq!(store.fetched_declarations, vec![good.clone()]);
        // 二度目は重複を数えない。
        assert_eq!(absorb_fetched(&mut store, &body, &followed), 0);
        let (decls, tombs) = intake_documents(&store);
        assert_eq!(decls, vec![good]);
        assert!(tombs.is_empty());
    }

    #[test]
    fn a_followed_authors_tombstone_is_taken_and_stops_intake() {
        use crate::media_manifest::TombstoneTable;
        use crate::media_declaration::{decide, Intake};
        let (key, did) = author();
        let decl = declared(&key, &did, 2);
        let stone = sign(&key, &did, json!({ "v": 1, "type": crate::media_declaration::DECLARATION_TOMBSTONE_TYPE, "kind": "audio", "service": "https://hub.example/music", "attestation": "a".repeat(64), "itemId": "7c0e3a52-1b5d-4f6e-9a8b-0c1d2e3f4a5b", "revision": 2, "author": did, "issuedAt": "2026-11-05T01:00:00.000Z" }));
        let followed = BTreeSet::from([did.clone()]);
        let mut store = LocalStore::default();
        assert_eq!(absorb_fetched(&mut store, &json!({ "declarations": [decl], "tombstones": [stone] }), &followed), 2);
        let (decls, tombs) = intake_documents(&store);
        let keys = parsed_default_keyset();
        let table = TombstoneTable::default();
        let input = Intake { origin: "https://hub.example", kind: "audio", service: "https://hub.example/music", max_bytes: crate::media_declaration::kind_limit("audio"), keys: &keys, service_tombstones: &table, attestation: None, declarations: &decls, author_tombstones: &tombs, followed_keys: &followed, now: chrono::Utc::now() };
        // 確認書が無いので通らない（取り込みの判定は `decide` の試験が受け持つ）。ここでは文書が届いていることだけ見る。
        assert_eq!(decide(&input), Err("intake_no_attestation"));
        assert_eq!((decls.len(), tombs.len()), (1, 1));
    }

    #[test]
    fn the_key_cache_is_memory_only_and_expires() {
        let mut cache = KeyCache::default();
        let start = Instant::now();
        assert!(cache.get(start).is_none());
        let keys = BTreeSet::from(["did:key:zDnabc".to_owned()]);
        cache.put(start, keys.clone());
        assert_eq!(cache.get(start + Duration::from_secs(60)), Some(keys));
        assert!(cache.get(start + KEY_CACHE_TTL + Duration::from_secs(1)).is_none());
        cache.put(start, BTreeSet::new());
        cache.clear();
        assert!(cache.get(start).is_none());
    }

    #[test]
    fn source_never_logs_or_stores_the_assertion() {
        let source = include_str!("media_declaration_net.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or_default();
        assert!(!production.contains("println!") && !production.contains("eprintln!") && !production.contains("log::"));
        assert!(!production.contains("fs::write"));
    }
}
