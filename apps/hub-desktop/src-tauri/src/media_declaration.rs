//! 作者の宣言（docs/hub-p2p-redesign/DESIGN.md §9, §11, §12）。音楽に限らない：`kind`（audio | video | file）と、確認書を出した
//! サービス（`service`＝起点＋パス接頭辞。音楽なら Music）を持つ。
//!
//! 作者の端末が、サービスの確認書の要約に自分の根鍵（P-256, did:key）で署名して「この版を配ってよい」と宣言する。
//! 取り消しも作者の鍵で署名する。秘密鍵はこの端末の外に出ず、サービスにも Hub にも送らない。
//! 端末側の取り込みは `decide`：確認書・宣言（フォロー中の作者）が揃い、作者の取り消しもサービスの tombstone も無いときだけ通す。
//! 種類ごとの上限は呼ぶ側が渡す（`kind_limit`：音声は 64 MiB、動画・ファイルは後の段）。
//! 以前の `hub.music.declaration`（trackId を持つ形）は、端末に残っている分だけ読んで kind=audio として扱う（新しくは作らない・出さない）。

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::artifact_store::sha256_hex;
use crate::media_manifest::{canonical_json, verify_attestation, Attestation, KeySet, TombstoneTable, CHUNK_SIZE, MAX_TRACK_BYTES};
use crate::portable_identity::{did_key_from_jwk, sign_document, verify_document};

pub const DECLARATION_TYPE: &str = "hub.media.declaration";
pub const DECLARATION_TOMBSTONE_TYPE: &str = "hub.media.declaration.tombstone";
/// 旧形（音楽だけの頃）。読むだけ。
pub const LEGACY_DECLARATION_TYPE: &str = "hub.music.declaration";
pub const LEGACY_DECLARATION_TOMBSTONE_TYPE: &str = "hub.music.declaration.tombstone";
pub const KINDS: [&str; 3] = ["audio", "video", "file"];

type Check<T> = Result<T, &'static str>;

/// 種類ごとの上限（バイト）。None は今は配らない種類。
pub fn kind_limit(kind: &str) -> Option<u64> {
    match kind {
        "audio" => Some(MAX_TRACK_BYTES),
        _ => None,
    }
}

/// 音楽サービスの識別（起点＋パス接頭辞）。
pub fn music_service(origin: &str) -> String {
    format!("{}/music", origin.trim_end_matches('/'))
}

fn service_ok(value: &str) -> bool {
    let local = value.starts_with("http://127.0.0.1") || value.starts_with("http://localhost");
    (value.starts_with("https://") || local)
        && value.len() <= 256
        && !value.ends_with('/')
        && !value.contains(['?', '#', '@', ' '])
}

fn item_id_ok(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-'))
}

/// 確認書（署名を含む全体）の正準JSONの SHA-256。宣言が指す対象。
pub fn attestation_digest(attestation: &Value) -> Check<String> {
    Ok(sha256_hex(canonical_json(attestation)?.as_bytes()))
}

pub fn declaration_statement(kind: &str, service: &str, item_id: &str, revision: u64, digest: &str, author: &str, issued_at: &str) -> Value {
    json!({
        "v": 1,
        "type": DECLARATION_TYPE,
        "kind": kind,
        "service": service,
        "attestation": digest,
        "itemId": item_id,
        "revision": revision,
        "author": author,
        "issuedAt": issued_at,
    })
}

/// 取り消しの文書。取り消す宣言が旧形なら、旧形の取り消しを作る（新しい型の service を持たないため）。
pub fn tombstone_statement(declaration: &Declaration, author: &str, issued_at: &str) -> Value {
    if declaration.legacy {
        return json!({
            "v": 1,
            "type": LEGACY_DECLARATION_TOMBSTONE_TYPE,
            "attestation": declaration.attestation,
            "trackId": declaration.item_id,
            "revision": declaration.revision,
            "author": author,
            "issuedAt": issued_at,
        });
    }
    json!({
        "v": 1,
        "type": DECLARATION_TOMBSTONE_TYPE,
        "kind": declaration.kind,
        "service": declaration.service,
        "attestation": declaration.attestation,
        "itemId": declaration.item_id,
        "revision": declaration.revision,
        "author": author,
        "issuedAt": issued_at,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declaration {
    pub kind: String,
    /// 確認書を出したサービス。旧形は空。
    pub service: String,
    pub attestation: String,
    pub item_id: String,
    pub revision: u64,
    pub author: String,
    pub issued_at: String,
    /// 旧形（hub.music.*）から読んだ物。
    pub legacy: bool,
}

fn fields(doc: &Value, expected_type: &str, legacy_type: &str) -> Check<Declaration> {
    let object = doc.as_object().ok_or("declaration_malformed")?;
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    let doc_type = text("type").ok_or("declaration_malformed")?;
    let legacy = doc_type == legacy_type;
    if !legacy && doc_type != expected_type {
        return Err("declaration_malformed");
    }
    let allowed: &[&str] = if legacy {
        &["v", "type", "attestation", "trackId", "revision", "author", "issuedAt", "proof"]
    } else {
        &["v", "type", "kind", "service", "attestation", "itemId", "revision", "author", "issuedAt", "proof"]
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) || object.get("v").and_then(Value::as_u64) != Some(1) {
        return Err("declaration_malformed");
    }
    let attestation = text("attestation").filter(|d| d.len() == 64 && d.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())).ok_or("declaration_malformed")?;
    let (kind, service, item_id) = if legacy {
        ("audio".to_owned(), String::new(), text("trackId").ok_or("declaration_malformed")?)
    } else {
        (
            text("kind").filter(|k| KINDS.contains(&k.as_str())).ok_or("declaration_malformed")?,
            text("service").filter(|s| service_ok(s)).ok_or("declaration_malformed")?,
            text("itemId").filter(|id| item_id_ok(id)).ok_or("declaration_malformed")?,
        )
    };
    let revision = object.get("revision").and_then(Value::as_u64).filter(|r| *r >= 1).ok_or("declaration_malformed")?;
    let author = text("author").filter(|a| a.starts_with("did:key:")).ok_or("declaration_malformed")?;
    let issued_at = text("issuedAt").ok_or("declaration_malformed")?;
    DateTime::parse_from_rfc3339(&issued_at).map_err(|_| "declaration_malformed")?;
    Ok(Declaration { kind, service, attestation, item_id, revision, author, issued_at, legacy })
}

/// 宣言の形と、`author` の鍵による署名を検査する。
pub fn verify_declaration(doc: &Value) -> Check<Declaration> {
    let declaration = fields(doc, DECLARATION_TYPE, LEGACY_DECLARATION_TYPE)?;
    if !verify_document(doc, Some(&declaration.author)) {
        return Err("declaration_bad_signature");
    }
    Ok(declaration)
}

pub fn verify_declaration_tombstone(doc: &Value) -> Check<Declaration> {
    let tombstone = fields(doc, DECLARATION_TOMBSTONE_TYPE, LEGACY_DECLARATION_TOMBSTONE_TYPE)?;
    if !verify_document(doc, Some(&tombstone.author)) {
        return Err("declaration_bad_signature");
    }
    Ok(tombstone)
}

// ---------------------------------------------------------------------------
// 端末の取り込み
// ---------------------------------------------------------------------------

pub struct Intake<'a> {
    pub origin: &'a str,
    /// 受け取る種類と、その確認書を出したサービス（起点＋パス接頭辞）。
    pub kind: &'a str,
    pub service: &'a str,
    /// この種類の上限（`kind_limit`）。None の種類は通さない。
    pub max_bytes: Option<u64>,
    pub keys: &'a KeySet,
    /// サービスの tombstone（購読する遮断リスト）。
    pub service_tombstones: &'a TombstoneTable,
    /// サービスの確認書（署名付きの生の値）。今は音声（Music）の形。他の種類の確認書は後の段で足す。無ければ None。
    pub attestation: Option<&'a Value>,
    pub declarations: &'a [Value],
    pub author_tombstones: &'a [Value],
    /// フォロー中の作者の根鍵（did:key）。フォロー先 actor の assertionMethod から集めたもの。
    pub followed_keys: &'a BTreeSet<String>,
    pub now: DateTime<Utc>,
}

/// 通ったときの中身。断片は `attestation.verify_piece` で一覧の SHA-256 と照合する。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admitted {
    pub attestation: Attestation,
    pub author: String,
}

pub fn decide(input: &Intake<'_>) -> Check<Admitted> {
    let raw = input.attestation.ok_or("intake_no_attestation")?;
    let max_bytes = input.max_bytes.ok_or("intake_kind_unsupported")?;
    let attestation = verify_attestation(input.keys, raw, input.now).map_err(|_| "intake_attestation_invalid")?;
    if (attestation.pieces.len() as u64).saturating_mul(CHUNK_SIZE) > max_bytes.div_ceil(CHUNK_SIZE).saturating_mul(CHUNK_SIZE) {
        return Err("intake_too_large");
    }
    if input.service_tombstones.blocks(input.origin, &attestation.track_id, attestation.revision) {
        return Err("intake_service_tombstone");
    }
    let digest = attestation_digest(raw).map_err(|_| "intake_attestation_invalid")?;
    // 署名の通る、この確認書への宣言のうち、フォロー中の作者のもの。
    let mut declared_by: Vec<Declaration> = Vec::new();
    let mut any_declaration = false;
    for doc in input.declarations {
        let Ok(declaration) = verify_declaration(doc) else { continue };
        let same_service = declaration.legacy || declaration.service == input.service;
        if declaration.attestation != digest
            || declaration.kind != input.kind
            || !same_service
            || declaration.item_id != attestation.track_id
            || declaration.revision != attestation.revision
        {
            continue;
        }
        any_declaration = true;
        if input.followed_keys.contains(&declaration.author) {
            declared_by.push(declaration);
        }
    }
    if !any_declaration {
        return Err("intake_no_declaration");
    }
    if declared_by.is_empty() {
        return Err("intake_author_not_followed");
    }
    let tombstones: Vec<Declaration> = input.author_tombstones.iter().filter_map(|doc| verify_declaration_tombstone(doc).ok()).collect();
    let live = declared_by.into_iter().find(|declaration| {
        !tombstones.iter().any(|t| t.author == declaration.author && t.kind == declaration.kind && t.item_id == declaration.item_id && t.revision >= declaration.revision)
    });
    match live {
        Some(declaration) => Ok(Admitted { attestation, author: declaration.author }),
        None => Err("intake_author_tombstone"),
    }
}

// ---------------------------------------------------------------------------
// 端末内の保管（作った宣言と取り消し。世界網へは media_declaration_net が出す）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStore {
    #[serde(default)]
    pub declarations: Vec<Value>,
    #[serde(default)]
    pub tombstones: Vec<Value>,
    /// Hub へ出し終えた自分の文書の印（正準JSONの SHA-256）。
    #[serde(default)]
    pub published: Vec<String>,
    /// フォロー中の作者の宣言・取り消しを Hub から取り戻して、署名を検査した物（取り込みの入力）。
    #[serde(default)]
    pub fetched_declarations: Vec<Value>,
    #[serde(default)]
    pub fetched_tombstones: Vec<Value>,
}

impl LocalStore {
    pub fn load(storage: &str) -> Self {
        std::fs::read(path(storage)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, storage: &str) -> Result<(), String> {
        let target = path(storage);
        let tmp = target.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "declaration_write")?;
        std::fs::write(&tmp, bytes).map_err(|_| "declaration_write")?;
        std::fs::rename(&tmp, &target).map_err(|_| "declaration_write".to_owned())
    }

    /// 取り消されていない音声の宣言の itemId（曲の ID）→ revision。
    pub fn active(&self) -> Vec<(String, u64)> {
        let tombs: Vec<Declaration> = self.tombstones.iter().filter_map(|t| verify_declaration_tombstone(t).ok()).collect();
        self.declarations
            .iter()
            .filter_map(|d| verify_declaration(d).ok())
            .filter(|d| d.kind == "audio")
            .filter(|d| !tombs.iter().any(|t| t.author == d.author && t.kind == d.kind && t.item_id == d.item_id && t.revision >= d.revision))
            .map(|d| (d.item_id, d.revision))
            .collect()
    }
}

fn path(storage: &str) -> std::path::PathBuf {
    std::path::Path::new(storage).join("music-declarations.json")
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn own_did(node: &crate::personal_node::PersonalNodeService) -> Result<String, String> {
    let (jwk, _) = node.public_identity().ok_or("portable_identity_unavailable")?;
    did_key_from_jwk(&jwk).ok_or_else(|| "portable_identity_unavailable".into())
}

/// 確認書を取って検査し、宣言に署名して端末に保管する。確認画面を通った版（`revision`）と食い違えば作らない。
pub async fn declare(
    node: &crate::personal_node::PersonalNodeService,
    storage: &str,
    origin: &str,
    track_id: &str,
    revision: u64,
) -> Result<Value, String> {
    let raw = crate::media_cache::command_attestation(storage, origin, track_id).await?;
    let now = Utc::now();
    let keys = crate::media_cache::MediaCache::open(storage).map_err(String::from)?.keyset(origin).ok_or("media_unavailable:keyset")?;
    let attestation = verify_attestation(&keys, &raw, now).map_err(String::from)?;
    if attestation.revision != revision {
        return Err("declaration_revision_changed".into());
    }
    let did = own_did(node)?;
    let issued = now_iso();
    let digest = attestation_digest(&raw)?;
    let statement = declaration_statement("audio", &music_service(origin), &attestation.track_id, attestation.revision, &digest, &did, &issued);
    let signed = sign_document(&|data| node.sign_bytes(data), &did, statement, &issued).ok_or("portable_identity_unavailable")?;
    let mut store = LocalStore::load(storage);
    store.declarations.retain(|d| verify_declaration(d).map(|x| !(x.kind == "audio" && x.item_id == track_id && x.revision == revision)).unwrap_or(false));
    store.declarations.push(signed.clone());
    store.save(storage)?;
    Ok(signed)
}

/// その曲の有効な宣言すべてに、作者署名の取り消しを作って保管する。
pub fn withdraw(node: &crate::personal_node::PersonalNodeService, storage: &str, track_id: &str) -> Result<usize, String> {
    let did = own_did(node)?;
    let mut store = LocalStore::load(storage);
    let live: Vec<Declaration> = store
        .declarations
        .iter()
        .filter_map(|d| verify_declaration(d).ok())
        .filter(|d| d.kind == "audio" && d.item_id == track_id && d.author == did)
        .collect();
    let mut made = 0;
    for declaration in live {
        let issued = now_iso();
        let statement = tombstone_statement(&declaration, &did, &issued);
        let signed = sign_document(&|data| node.sign_bytes(data), &did, statement, &issued).ok_or("portable_identity_unavailable")?;
        store.tombstones.push(signed);
        made += 1;
    }
    store.save(storage)?;
    Ok(made)
}

// ---------------------------------------------------------------------------
// Tauri コマンド（窓から来るのは曲の UUID と版だけ）
// ---------------------------------------------------------------------------

fn guard(window: &tauri::Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "native_window_required")?;
    if !crate::local_pairing_address(window.label(), &url) {
        return Err("native_window_required".into());
    }
    Ok(())
}

async fn storage(state: &tauri::State<'_, std::sync::Arc<crate::RunnerState>>) -> Result<(String, String), String> {
    let node = state.node.as_ref().ok_or("media_unavailable:node_storage")?;
    let path = node.status().await.storage_path;
    if path.is_empty() {
        return Err("media_unavailable:node_storage".into());
    }
    Ok((path, crate::hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref())))
}

/// 確認画面に出す版。Music の確認書を取って検査するだけで、何も署名しない。
#[tauri::command]
pub async fn music_p2p_prepare(
    window: tauri::Webview,
    state: tauri::State<'_, std::sync::Arc<crate::RunnerState>>,
    track_id: String,
) -> Result<Value, String> {
    guard(&window)?;
    let (storage, origin) = storage(&state).await?;
    let raw = crate::media_cache::command_attestation(&storage, &origin, &track_id).await?;
    Ok(json!({ "trackId": track_id, "revision": raw.get("revision").cloned().unwrap_or(Value::Null) }))
}

#[tauri::command]
pub async fn music_p2p_declare(
    window: tauri::Webview,
    state: tauri::State<'_, std::sync::Arc<crate::RunnerState>>,
    track_id: String,
    revision: u64,
) -> Result<Value, String> {
    guard(&window)?;
    let (storage, origin) = storage(&state).await?;
    let node = state.node.as_ref().ok_or("portable_identity_unavailable")?;
    declare(node, &storage, &origin, &track_id, revision).await?;
    // 世界網へ出す。出せなくても宣言は端末に残り、次の `music_p2p_publish` で出る。
    let _ = crate::media_declaration_net::publish_pending(&storage, &origin).await;
    Ok(json!({ "trackId": track_id, "revision": revision }))
}

#[tauri::command]
pub async fn music_p2p_withdraw(
    window: tauri::Webview,
    state: tauri::State<'_, std::sync::Arc<crate::RunnerState>>,
    track_id: String,
) -> Result<Value, String> {
    guard(&window)?;
    let (storage, origin) = storage(&state).await?;
    let node = state.node.as_ref().ok_or("portable_identity_unavailable")?;
    let made = withdraw(node, &storage, &track_id)?;
    let _ = crate::media_declaration_net::publish_pending(&storage, &origin).await;
    Ok(json!({ "trackId": track_id, "withdrawn": made }))
}

/// 配る設定になっている自分の曲（取り消されていない宣言）と、端末内の宣言・取り消し。
#[tauri::command]
pub async fn music_p2p_declared(
    window: tauri::Webview,
    state: tauri::State<'_, std::sync::Arc<crate::RunnerState>>,
) -> Result<Value, String> {
    guard(&window)?;
    let (storage, _) = storage(&state).await?;
    let store = LocalStore::load(&storage);
    let ids: Vec<String> = store.active().into_iter().map(|(id, _)| id).collect();
    Ok(json!({ "ids": ids, "declarations": store.declarations, "tombstones": store.tombstones }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_manifest::testkit::*;
    use crate::media_manifest::verify_tombstone;
    use crate::node_identity::NodeKey;

    fn signer(key: &NodeKey) -> impl Fn(&[u8]) -> Option<[u8; 64]> + '_ {
        move |data| Some(key.sign_bytes(data))
    }

    struct World {
        keys: KeySet,
        att: Value,
        parsed: Attestation,
        author: NodeKey,
        did: String,
    }

    fn world() -> World {
        let keys = parsed_default_keyset();
        let att = attestation(TRACK, 2, &[b"piece-one"], &signing_key(1));
        let parsed = verify_attestation(&keys, &att, now()).unwrap();
        let author = NodeKey::create();
        let did = did_key_from_jwk(&author.public_jwk()).unwrap();
        World { keys, att, parsed, author, did }
    }

    const SERVICE: &str = "http://127.0.0.1:8787/music";

    fn declare_doc(w: &World, att: &Value, parsed: &Attestation) -> Value {
        declare_with(w, att, parsed, "audio", SERVICE)
    }

    fn declare_with(w: &World, att: &Value, parsed: &Attestation, kind: &str, service: &str) -> Value {
        let statement = declaration_statement(kind, service, &parsed.track_id, parsed.revision, &attestation_digest(att).unwrap(), &w.did, "2026-10-12T03:30:00.000Z");
        sign_document(&signer(&w.author), &w.did, statement, "2026-10-12T03:30:00.000Z").unwrap()
    }

    fn run(w: &World, att: Option<&Value>, decls: &[Value], tombs: &[Value], follows: &[&str], table: &TombstoneTable) -> Check<Admitted> {
        let followed: BTreeSet<String> = follows.iter().map(|s| s.to_string()).collect();
        decide(&Intake { origin: ORIGIN, kind: "audio", service: SERVICE, max_bytes: kind_limit("audio"), keys: &w.keys, service_tombstones: table, attestation: att, declarations: decls, author_tombstones: tombs, followed_keys: &followed, now: now() })
    }

    #[test]
    fn declaration_signs_and_verifies_only_under_its_author() {
        let w = world();
        let doc = declare_doc(&w, &w.att, &w.parsed);
        assert_eq!(verify_declaration(&doc).unwrap().revision, 2);
        let mut tampered = doc.clone();
        tampered["revision"] = json!(3);
        assert_eq!(verify_declaration(&tampered), Err("declaration_bad_signature"));
        // 別の鍵が署名した文書を、author を差し替えて通すことはできない。
        let other = NodeKey::create();
        let other_did = did_key_from_jwk(&other.public_jwk()).unwrap();
        let mut forged = sign_document(&signer(&other), &other_did, declaration_statement("audio", SERVICE, &w.parsed.track_id, w.parsed.revision, &attestation_digest(&w.att).unwrap(), &other_did, "2026-10-12T03:30:00.000Z"), "2026-10-12T03:30:00.000Z").unwrap();
        forged["author"] = json!(w.did);
        assert!(verify_declaration(&forged).is_err());
        // 取り消し用の型は宣言として通らない。
        let tomb = sign_document(&signer(&w.author), &w.did, tombstone_statement(&verify_declaration(&doc).unwrap(), &w.did, "2026-10-12T03:31:00.000Z"), "2026-10-12T03:31:00.000Z").unwrap();
        assert!(verify_declaration(&tomb).is_err());
        assert!(verify_declaration_tombstone(&tomb).is_ok());
    }

    #[test]
    fn followed_author_with_attestation_is_admitted_and_pieces_are_checked() {
        let w = world();
        let doc = declare_doc(&w, &w.att, &w.parsed);
        let admitted = run(&w, Some(&w.att), &[doc], &[], &[&w.did], &TombstoneTable::default()).unwrap();
        assert_eq!(admitted.author, w.did);
        assert!(admitted.attestation.verify_piece(0, b"piece-one"));
        assert!(!admitted.attestation.verify_piece(0, b"piece-oNe"));
        assert!(!admitted.attestation.verify_piece(1, b"piece-one"));
    }

    #[test]
    fn not_followed_missing_attestation_or_wrong_revision_is_refused() {
        let w = world();
        let doc = declare_doc(&w, &w.att, &w.parsed);
        let table = TombstoneTable::default();
        assert_eq!(run(&w, Some(&w.att), &[doc.clone()], &[], &[], &table), Err("intake_author_not_followed"));
        assert_eq!(run(&w, Some(&w.att), &[doc.clone()], &[], &["did:key:zOther"], &table), Err("intake_author_not_followed"));
        assert_eq!(run(&w, None, &[doc.clone()], &[], &[&w.did], &table), Err("intake_no_attestation"));
        assert_eq!(run(&w, Some(&w.att), &[], &[], &[&w.did], &table), Err("intake_no_declaration"));
        // 宣言は別の版の確認書へのもの。
        let newer = attestation(TRACK, 3, &[b"piece-one"], &signing_key(1));
        assert_eq!(run(&w, Some(&newer), &[doc.clone()], &[], &[&w.did], &table), Err("intake_no_declaration"));
        // 確認書の改ざんと、鍵集合に無い署名。
        let mut forged = w.att.clone();
        forged["pieces"][0] = json!("0".repeat(64));
        assert_eq!(run(&w, Some(&forged), &[doc.clone()], &[], &[&w.did], &table), Err("intake_attestation_invalid"));
        let foreign = attestation(TRACK, 2, &[b"piece-one"], &signing_key(9));
        assert_eq!(run(&w, Some(&foreign), &[doc], &[], &[&w.did], &table), Err("intake_attestation_invalid"));
    }

    #[test]
    fn author_tombstone_and_music_tombstone_each_stop_intake() {
        let w = world();
        let doc = declare_doc(&w, &w.att, &w.parsed);
        let declared = verify_declaration(&doc).unwrap();
        let tomb = sign_document(&signer(&w.author), &w.did, tombstone_statement(&declared, &w.did, "2026-10-12T03:40:00.000Z"), "2026-10-12T03:40:00.000Z").unwrap();
        assert_eq!(run(&w, Some(&w.att), &[doc.clone()], &[tomb.clone()], &[&w.did], &TombstoneTable::default()), Err("intake_author_tombstone"));
        // 別の作者の取り消しは効かない。
        let other = NodeKey::create();
        let other_did = did_key_from_jwk(&other.public_jwk()).unwrap();
        let foreign = sign_document(&signer(&other), &other_did, tombstone_statement(&declared, &other_did, "2026-10-12T03:40:00.000Z"), "2026-10-12T03:40:00.000Z").unwrap();
        assert!(run(&w, Some(&w.att), &[doc.clone()], &[foreign], &[&w.did], &TombstoneTable::default()).is_ok());
        // 改ざんした取り消しも効かない。
        let mut broken = tomb;
        broken["revision"] = json!(1);
        assert!(run(&w, Some(&w.att), &[doc.clone()], &[broken], &[&w.did], &TombstoneTable::default()).is_ok());
        // Music の tombstone（購読する遮断リスト）。
        let mut table = TombstoneTable::default();
        let music = verify_tombstone(&w.keys, &tombstone(2, false, "hidden", &signing_key(1)), now()).unwrap();
        table.record(&music, now());
        assert_eq!(run(&w, Some(&w.att), &[doc], &[], &[&w.did], &table), Err("intake_service_tombstone"));
    }

    #[test]
    fn kind_service_and_limits_are_checked_by_the_caller_supplied_values() {
        let w = world();
        let table = TombstoneTable::default();
        let followed: BTreeSet<String> = BTreeSet::from([w.did.clone()]);
        let doc = declare_doc(&w, &w.att, &w.parsed);
        let go = |kind: &str, service: &str, max: Option<u64>, docs: &[Value]| {
            decide(&Intake { origin: ORIGIN, kind, service, max_bytes: max, keys: &w.keys, service_tombstones: &table, attestation: Some(&w.att), declarations: docs, author_tombstones: &[], followed_keys: &followed, now: now() })
        };
        assert!(go("audio", SERVICE, kind_limit("audio"), &[doc.clone()]).is_ok());
        // 種類の違う宣言、別のサービスの宣言は、この確認書への宣言として数えない。
        let video = declare_with(&w, &w.att, &w.parsed, "video", SERVICE);
        assert_eq!(go("audio", SERVICE, kind_limit("audio"), &[video]), Err("intake_no_declaration"));
        assert_eq!(go("audio", "http://127.0.0.1:8787/other", kind_limit("audio"), &[doc.clone()]), Err("intake_no_declaration"));
        // 上限が渡されない種類は通さない。渡された上限を確認書が超えるときも通さない。
        assert_eq!(go("video", SERVICE, kind_limit("video"), &[doc.clone()]), Err("intake_kind_unsupported"));
        assert_eq!(go("audio", SERVICE, Some(0), &[doc.clone()]), Err("intake_too_large"));
        assert_eq!((kind_limit("audio"), kind_limit("video"), kind_limit("file")), (Some(64 * 1024 * 1024), None, None));
    }

    #[test]
    fn new_documents_need_a_known_kind_a_service_and_a_plain_item_id() {
        let w = world();
        let digest = attestation_digest(&w.att).unwrap();
        let sign_it = |statement: Value| sign_document(&signer(&w.author), &w.did, statement, "2026-10-12T03:30:00.000Z").unwrap();
        let good = declaration_statement("audio", SERVICE, TRACK, 2, &digest, &w.did, "2026-10-12T03:30:00.000Z");
        assert!(verify_declaration(&sign_it(good.clone())).is_ok());
        for (key, value) in [("kind", json!("image")), ("service", json!("ftp://x")), ("service", json!("https://a.example/")), ("itemId", json!("../x")), ("title", json!("x"))] {
            let mut bad = good.clone();
            bad[key] = value;
            assert_eq!(verify_declaration(&sign_it(bad)), Err("declaration_malformed"));
        }
        let mut old_key = good.clone();
        old_key.as_object_mut().unwrap().remove("itemId");
        old_key["trackId"] = json!(TRACK);
        assert_eq!(verify_declaration(&sign_it(old_key)), Err("declaration_malformed"));
    }

    #[test]
    fn an_old_music_declaration_already_on_the_device_still_reads_as_audio() {
        let w = world();
        let digest = attestation_digest(&w.att).unwrap();
        let old = sign_document(&signer(&w.author), &w.did, json!({ "v": 1, "type": LEGACY_DECLARATION_TYPE, "attestation": digest, "trackId": TRACK, "revision": 2, "author": w.did, "issuedAt": "2026-10-12T03:30:00.000Z" }), "2026-10-12T03:30:00.000Z").unwrap();
        let read = verify_declaration(&old).unwrap();
        assert_eq!((read.kind.as_str(), read.item_id.as_str(), read.legacy), ("audio", TRACK, true));
        let mut store = LocalStore { declarations: vec![old.clone()], ..Default::default() };
        assert_eq!(store.active(), vec![(TRACK.to_owned(), 2)]);
        // 旧形でも取り込みは通り、取り消しは旧形で作られ、旧形の取り消しも読める。
        assert!(run(&w, Some(&w.att), &[old.clone()], &[], &[&w.did], &TombstoneTable::default()).is_ok());
        let stone = sign_document(&signer(&w.author), &w.did, tombstone_statement(&read, &w.did, "2026-10-12T03:40:00.000Z"), "2026-10-12T03:40:00.000Z").unwrap();
        assert_eq!(stone["type"], json!(LEGACY_DECLARATION_TOMBSTONE_TYPE));
        assert_eq!(run(&w, Some(&w.att), &[old], &[stone.clone()], &[&w.did], &TombstoneTable::default()), Err("intake_author_tombstone"));
        store.tombstones.push(stone);
        assert!(store.active().is_empty());
    }

    #[test]
    fn local_store_lists_active_declarations_until_withdrawn() {
        let w = world();
        let doc = declare_doc(&w, &w.att, &w.parsed);
        let declared = verify_declaration(&doc).unwrap();
        let mut store = LocalStore { declarations: vec![doc], ..Default::default() };
        assert_eq!(store.active(), vec![(TRACK.to_owned(), 2)]);
        store.tombstones.push(sign_document(&signer(&w.author), &w.did, tombstone_statement(&declared, &w.did, "2026-10-12T03:40:00.000Z"), "2026-10-12T03:40:00.000Z").unwrap());
        assert!(store.active().is_empty());
    }
}
