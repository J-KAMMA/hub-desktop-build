//! Music Worker が署名した曲の manifest・tombstone・鍵集合の検証。
//!
//! docs/hub-distributed-media/DESIGN.md 2.2〜2.5, 3.1 に対応する。ここは純粋な検証だけで、
//! ネットワークにもディスクにも触れない（保存は media_cache.rs）。検証に失敗したものは
//! 呼び出し側が捨てる。署名者は Music Worker だけで、端末は署名しない。
//!
//! 署名対象は `"<domain>\n" + 正準JSON(signature を除いた本体)`。正準JSONはキーを再帰的に
//! 辞書順に並べ、空白なし。数値は整数だけ、文字列は ASCII だけを受け付け、それ以外は
//! 検証以前に拒否する（TS と Rust で正規化の解釈が割れるのを防ぐため）。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::artifact_store::sha256_hex;

pub const MANIFEST_TYPE: &str = "hub.music.manifest.v1";
pub const TOMBSTONE_TYPE: &str = "hub.music.tombstone.v1";
pub const KEYSET_TYPE: &str = "hub.music.keyset.v1";
/// 鍵集合の署名ドメイン。DESIGN は鍵集合の署名対象を明記していないので、manifest と同じ
/// 形式（型名 + 改行 + signatures を除いた正準JSON）に揃えた。Music 側と要照合。
pub const KEYSET_DOMAIN: &str = "hub.music.keyset.v1\n";
pub const MANIFEST_DOMAIN: &str = "hub.music.manifest.v1\n";
pub const TOMBSTONE_DOMAIN: &str = "hub.music.tombstone.v1\n";

pub const CHUNK_SIZE: u64 = 524_288;
pub const MAX_TRACK_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_LIFETIME_SECONDS: i64 = 6 * 3600;
const CLOCK_SKEW_SECONDS: i64 = 60;
pub const TOMBSTONE_RETENTION_DAYS: i64 = 400;
const MAX_KEYS: usize = 8;

type Check<T> = Result<T, &'static str>;

// ---------------------------------------------------------------------------
// 正準JSON
// ---------------------------------------------------------------------------

pub fn canonical_json(value: &Value) -> Check<String> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String) -> Check<()> {
    match value {
        Value::Null => return Err("canonical_null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            if !(number.is_i64() || number.is_u64()) {
                return Err("canonical_non_integer");
            }
            out.push_str(&number.to_string());
        }
        Value::String(text) => write_string(text, out)?,
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out)?;
                out.push(':');
                write_canonical(&map[key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_string(text: &str, out: &mut String) -> Check<()> {
    // 印字可能な ASCII (0x20-0x7e) だけ。エスケープは二重引用符とバックスラッシュのみ。
    if !text.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return Err("canonical_non_ascii");
    }
    out.push('"');
    for c in text.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    Ok(())
}

/// `domain` + `signature` を除いた本体の正準JSON。
fn signed_payload(domain: &str, value: &Value, signature_field: &str) -> Check<Vec<u8>> {
    let mut body = value.clone();
    body.as_object_mut()
        .ok_or("signed_object_expected")?
        .remove(signature_field);
    let mut payload = domain.as_bytes().to_vec();
    payload.extend_from_slice(canonical_json(&body)?.as_bytes());
    Ok(payload)
}

// ---------------------------------------------------------------------------
// 小さな検査
// ---------------------------------------------------------------------------

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn parse_time(value: &str) -> Check<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|_| "time_invalid")
}

/// `<uuid>` の形（小文字へ正規化して返す）。YouTube の11文字IDなどはここで落ちる。
pub fn track_uuid(value: &str) -> Option<String> {
    let value = value.to_ascii_lowercase();
    let ok = value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        });
    ok.then_some(value)
}

/// 接続先 origin の正規形。https か、この端末のループバックの http だけ。
pub fn normalize_origin(raw: &str) -> Check<String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "origin_invalid")?;
    let host = url.host_str().ok_or("origin_invalid")?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    let bare = matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    if !scheme_ok || !bare {
        return Err("origin_invalid");
    }
    Ok(url.origin().ascii_serialization())
}

/// origin を表すディレクトリ名。origin の文字列をパスに使わない。
pub fn origin_key(origin: &str) -> String {
    sha256_hex(origin.as_bytes())[..32].to_owned()
}

fn verify_ed25519(public_key: &VerifyingKey, payload: &[u8], signature_b64: &str) -> bool {
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(signature_b64) else {
        return false;
    };
    let Ok(array) = <[u8; 64]>::try_from(bytes.as_slice()) else {
        return false;
    };
    public_key
        .verify(payload, &Signature::from_bytes(&array))
        .is_ok()
}

// ---------------------------------------------------------------------------
// 鍵集合
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyEntry {
    pub key_id: String,
    pub alg: String,
    pub public_key: String,
    pub not_before: String,
    pub not_after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeySetSignature {
    pub key_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeySet {
    #[serde(rename = "type")]
    pub kind: String,
    pub origin: String,
    pub tracker: String,
    pub issued_at: String,
    pub keys: Vec<KeyEntry>,
    pub signatures: Vec<KeySetSignature>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinOutcome {
    /// 初回固定（TOFU）。
    Pinned,
    Unchanged,
    /// 固定済みの鍵で署名された更新。
    Rotated,
}

impl KeyEntry {
    fn verifying_key(&self) -> Option<VerifyingKey> {
        let bytes = URL_SAFE_NO_PAD.decode(&self.public_key).ok()?;
        VerifyingKey::from_bytes(&<[u8; 32]>::try_from(bytes.as_slice()).ok()?).ok()
    }

    fn valid_at(&self, now: DateTime<Utc>) -> bool {
        match (parse_time(&self.not_before), parse_time(&self.not_after)) {
            (Ok(from), Ok(to)) => from <= now && now < to,
            _ => false,
        }
    }
}

impl KeySet {
    /// 形の検査。署名の検査は `evaluate_keyset` が行う。
    pub fn parse(raw: &Value, expected_origin: &str) -> Check<KeySet> {
        let set: KeySet = serde_json::from_value(raw.clone()).map_err(|_| "keyset_malformed")?;
        if set.kind != KEYSET_TYPE || set.origin != expected_origin {
            return Err("keyset_origin");
        }
        // 追跡先は同じ origin 上のパスに限る。Hub が利用者の IP を第三者へ流さないため。
        let tracker_ok = set.tracker.starts_with('/')
            && !set.tracker.starts_with("//")
            && !set.tracker.contains('\\')
            && !set.tracker.contains("://")
            && !set.tracker.chars().any(|c| c.is_control() || c.is_whitespace());
        if !tracker_ok {
            return Err("keyset_tracker_foreign");
        }
        parse_time(&set.issued_at)?;
        if set.keys.is_empty() || set.keys.len() > MAX_KEYS || set.signatures.is_empty() || set.signatures.len() > MAX_KEYS {
            return Err("keyset_malformed");
        }
        for key in &set.keys {
            let from = parse_time(&key.not_before)?;
            let to = parse_time(&key.not_after)?;
            if key.alg != "Ed25519"
                || from >= to
                || key.key_id.is_empty()
                || key.key_id.len() > 64
                || !key.key_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
                || key.verifying_key().is_none()
            {
                return Err("keyset_key_invalid");
            }
        }
        let mut ids: Vec<&str> = set.keys.iter().map(|k| k.key_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() != set.keys.len() {
            return Err("keyset_key_invalid");
        }
        Ok(set)
    }

    pub fn key(&self, key_id: &str) -> Option<&KeyEntry> {
        self.keys.iter().find(|key| key.key_id == key_id)
    }

    fn payload(&self) -> Check<Vec<u8>> {
        let value = serde_json::to_value(self).map_err(|_| "keyset_malformed")?;
        signed_payload(KEYSET_DOMAIN, &value, "signatures")
    }

    /// `signers` のうち、この時刻に有効な鍵のどれかがこの鍵集合へ署名していれば真。
    fn signed_by(&self, signers: &[KeyEntry], now: DateTime<Utc>) -> bool {
        let Ok(payload) = self.payload() else {
            return false;
        };
        self.signatures.iter().any(|entry| {
            signers
                .iter()
                .find(|key| key.key_id == entry.key_id)
                .filter(|key| key.valid_at(now))
                .and_then(KeyEntry::verifying_key)
                .is_some_and(|key| verify_ed25519(&key, &payload, &entry.signature))
        })
    }
}

/// 取得した鍵集合を固定済みのものと突き合わせる。
///
/// - 未固定: 自分自身の鍵のどれかで署名されていれば固定する（TOFU）。
/// - 固定済み: 固定済みの鍵のどれかで署名され、発行時刻が戻っていなければ更新として受け入れる。
///   そうでなければ `keyset_changed`。呼び出し側はその origin の P2P を止め、
///   利用者の明示操作でだけ固定し直す。元 HTTP の再生は止めない。
pub fn evaluate_keyset(
    pinned: Option<&KeySet>,
    candidate: &KeySet,
    now: DateTime<Utc>,
) -> Check<PinOutcome> {
    match pinned {
        None => {
            if candidate.signed_by(&candidate.keys, now) {
                Ok(PinOutcome::Pinned)
            } else {
                Err("keyset_unsigned")
            }
        }
        Some(pinned) => {
            if pinned == candidate {
                return Ok(PinOutcome::Unchanged);
            }
            if pinned.origin != candidate.origin || !candidate.signed_by(&pinned.keys, now) {
                return Err("keyset_changed");
            }
            if parse_time(&candidate.issued_at)? < parse_time(&pinned.issued_at)? {
                return Err("keyset_rollback");
            }
            Ok(PinOutcome::Rotated)
        }
    }
}

/// 利用者が「このHubの配信鍵を固定し直す」を明示した場合だけ使う。
/// 新しい鍵集合は少なくとも自分自身の鍵で署名されていなければならない。
pub fn evaluate_explicit_repin(candidate: &KeySet, now: DateTime<Utc>) -> Check<()> {
    evaluate_keyset(None, candidate, now).map(|_| ())
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    #[serde(rename = "type")]
    pub kind: String,
    pub origin: String,
    pub track_id: String,
    pub revision: u64,
    pub content_type: String,
    pub size: u64,
    pub sha256: String,
    pub chunk_size: u64,
    pub chunks: Vec<String>,
    pub published_at: String,
    pub issued_at: String,
    pub not_after: String,
    pub key_id: String,
    pub signature: String,
}

impl Manifest {
    pub fn piece_count(&self) -> usize {
        self.chunks.len()
    }

    /// 断片 `index` の期待される長さ。
    pub fn piece_len(&self, index: usize) -> Option<usize> {
        if index >= self.chunks.len() {
            return None;
        }
        let start = index as u64 * self.chunk_size;
        Some(self.chunk_size.min(self.size - start) as usize)
    }

    /// 2.5 の6。長さと SHA-256 が合わなければ偽。
    pub fn verify_piece(&self, index: usize, bytes: &[u8]) -> bool {
        self.piece_len(index) == Some(bytes.len()) && sha256_hex(bytes) == self.chunks[index]
    }

    /// 2.5 の7。
    pub fn verify_whole(&self, bytes: &[u8]) -> bool {
        bytes.len() as u64 == self.size && sha256_hex(bytes) == self.sha256
    }
}

/// 2.5 の1〜5。tombstone 表との照合（4）も含む。署名つきの生の値で受ける。
pub fn verify_manifest(
    keys: &KeySet,
    tombstones: &TombstoneTable,
    raw: &Value,
    now: DateTime<Utc>,
) -> Check<Manifest> {
    let manifest: Manifest =
        serde_json::from_value(raw.clone()).map_err(|_| "manifest_malformed")?;
    // 1. origin と鍵
    if manifest.kind != MANIFEST_TYPE || manifest.origin != keys.origin {
        return Err("manifest_origin");
    }
    let key = keys.key(&manifest.key_id).ok_or("manifest_unknown_key")?;
    if !key.valid_at(now) {
        return Err("manifest_key_not_valid");
    }
    // 2. 署名
    let payload = signed_payload(MANIFEST_DOMAIN, raw, "signature")?;
    let verifying = key.verifying_key().ok_or("manifest_unknown_key")?;
    if !verify_ed25519(&verifying, &payload, &manifest.signature) {
        return Err("manifest_bad_signature");
    }
    // 3. 時刻
    let issued = parse_time(&manifest.issued_at)?;
    let not_after = parse_time(&manifest.not_after)?;
    parse_time(&manifest.published_at)?;
    if issued > now + Duration::seconds(CLOCK_SKEW_SECONDS) {
        return Err("manifest_from_future");
    }
    if now >= not_after {
        return Err("manifest_expired");
    }
    let lifetime = (not_after - issued).num_milliseconds();
    if lifetime <= 0 || lifetime > MAX_LIFETIME_SECONDS * 1000 {
        return Err("manifest_lifetime");
    }
    // 5. 形（4 の前に形を確かめると track_id が信用できる）
    if track_uuid(&manifest.track_id).as_deref() != Some(manifest.track_id.as_str()) {
        return Err("manifest_track_id");
    }
    if manifest.size == 0
        || manifest.revision < 1
        || manifest.size > MAX_TRACK_BYTES
        || manifest.chunk_size != CHUNK_SIZE
        || manifest.chunks.len() as u64 != manifest.size.div_ceil(manifest.chunk_size)
        || !is_hex64(&manifest.sha256)
        || !manifest.chunks.iter().all(|chunk| is_hex64(chunk))
        || !manifest.content_type.starts_with("audio/")
    {
        return Err("manifest_shape");
    }
    // 4. 失効済みか
    if tombstones.blocks(&manifest.origin, &manifest.track_id, manifest.revision) {
        return Err("manifest_revoked");
    }
    Ok(manifest)
}

/// ディスクに保存した manifest を読み戻すときの検査。署名・origin・鍵 ID だけを見て、
/// 期限と失効表は見ない（期限切れでも手元の再生猶予の間は使えるため。失効は呼び出し側が表で見る）。
pub fn parse_stored_manifest(keys: &KeySet, raw: &Value) -> Check<Manifest> {
    let manifest: Manifest =
        serde_json::from_value(raw.clone()).map_err(|_| "manifest_malformed")?;
    if manifest.kind != MANIFEST_TYPE || manifest.origin != keys.origin {
        return Err("manifest_origin");
    }
    let key = keys.key(&manifest.key_id).ok_or("manifest_unknown_key")?;
    let payload = signed_payload(MANIFEST_DOMAIN, raw, "signature")?;
    let verifying = key.verifying_key().ok_or("manifest_unknown_key")?;
    if !verify_ed25519(&verifying, &payload, &manifest.signature) {
        return Err("manifest_bad_signature");
    }
    if manifest.chunk_size != CHUNK_SIZE
        || manifest.size == 0
        || manifest.size > MAX_TRACK_BYTES
        || manifest.chunks.len() as u64 != manifest.size.div_ceil(manifest.chunk_size)
    {
        return Err("manifest_shape");
    }
    Ok(manifest)
}

// ---------------------------------------------------------------------------
// 確認書（期限なし。docs/hub-p2p-redesign/DESIGN.md §9, §10.1）
// ---------------------------------------------------------------------------

pub const ATTESTATION_TYPE: &str = "hub.music.attestation";
/// Music 側の署名対象は `"<domain>\n" + 正準JSON`。
pub const ATTESTATION_DOMAIN: &str = "hub.music.attestation.v1\n";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attestation {
    pub v: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub track_id: String,
    pub revision: u64,
    pub piece_size: u64,
    pub pieces: Vec<String>,
    pub issued_at: String,
    pub kid: String,
    pub signature: String,
}

impl Attestation {
    /// 断片が一覧の SHA-256 と合うか（最後の断片以外は pieceSize 丁度）。
    pub fn verify_piece(&self, index: usize, bytes: &[u8]) -> bool {
        let Some(expected) = self.pieces.get(index) else { return false };
        let full = bytes.len() as u64 == self.piece_size;
        let last = index + 1 == self.pieces.len() && !bytes.is_empty() && bytes.len() as u64 <= self.piece_size;
        (full || last) && sha256_hex(bytes) == *expected
    }
}

/// 固定済みの鍵集合で確認書を検査する。期限は無く、鍵の有効期間は発行時点で判定する。
pub fn verify_attestation(keys: &KeySet, raw: &Value, now: DateTime<Utc>) -> Check<Attestation> {
    let att: Attestation = serde_json::from_value(raw.clone()).map_err(|_| "attestation_malformed")?;
    if att.v != 1 || att.kind != ATTESTATION_TYPE {
        return Err("attestation_malformed");
    }
    let key = keys.key(&att.kid).ok_or("attestation_unknown_key")?;
    let issued = parse_time(&att.issued_at)?;
    if !key.valid_at(issued) {
        return Err("attestation_key_not_valid");
    }
    if issued > now + Duration::seconds(CLOCK_SKEW_SECONDS) {
        return Err("attestation_from_future");
    }
    let payload = signed_payload(ATTESTATION_DOMAIN, raw, "signature")?;
    let verifying = key.verifying_key().ok_or("attestation_unknown_key")?;
    if !verify_ed25519(&verifying, &payload, &att.signature) {
        return Err("attestation_bad_signature");
    }
    if track_uuid(&att.track_id).as_deref() != Some(att.track_id.as_str())
        || att.revision < 1
        || att.piece_size != CHUNK_SIZE
        || att.pieces.is_empty()
        || att.pieces.len() as u64 > MAX_TRACK_BYTES.div_ceil(CHUNK_SIZE)
        || !att.pieces.iter().all(|piece| is_hex64(piece))
    {
        return Err("attestation_shape");
    }
    Ok(att)
}

// ---------------------------------------------------------------------------
// tombstone と表
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tombstone {
    #[serde(rename = "type")]
    pub kind: String,
    pub origin: String,
    pub track_id: String,
    pub revision: u64,
    pub reason: String,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub revoked_at: String,
    pub key_id: String,
    pub signature: String,
}

pub fn verify_tombstone(keys: &KeySet, raw: &Value, now: DateTime<Utc>) -> Check<Tombstone> {
    let tombstone: Tombstone =
        serde_json::from_value(raw.clone()).map_err(|_| "tombstone_malformed")?;
    if tombstone.kind != TOMBSTONE_TYPE
        || tombstone.origin != keys.origin
        || track_uuid(&tombstone.track_id).as_deref() != Some(tombstone.track_id.as_str())
        || !matches!(tombstone.reason.as_str(), "unpublished" | "hidden" | "deleted")
    {
        return Err("tombstone_malformed");
    }
    let key = keys.key(&tombstone.key_id).ok_or("tombstone_unknown_key")?;
    if !key.valid_at(now) {
        return Err("tombstone_key_not_valid");
    }
    let payload = signed_payload(TOMBSTONE_DOMAIN, raw, "signature")?;
    let verifying = key.verifying_key().ok_or("tombstone_unknown_key")?;
    if !verify_ed25519(&verifying, &payload, &tombstone.signature) {
        return Err("tombstone_bad_signature");
    }
    parse_time(&tombstone.revoked_at)?;
    Ok(tombstone)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TombstoneEntry {
    pub revision: u64,
    pub is_final: bool,
    pub recorded_at: String,
}

/// (origin, trackId) → 最大の失効 revision と final。失効一覧の読み取り位置も持つ。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TombstoneTable {
    #[serde(default)]
    entries: BTreeMap<String, TombstoneEntry>,
    #[serde(default)]
    cursors: BTreeMap<String, u64>,
}

fn table_key(origin: &str, track_id: &str) -> String {
    format!("{}/{}", origin_key(origin), track_id)
}

impl TombstoneTable {
    /// 検証済みの tombstone を記録する。revision は戻さず、final は外せない。
    pub fn record(&mut self, tombstone: &Tombstone, now: DateTime<Utc>) {
        let key = table_key(&tombstone.origin, &tombstone.track_id);
        let entry = self.entries.entry(key).or_insert(TombstoneEntry {
            revision: tombstone.revision,
            is_final: tombstone.is_final,
            recorded_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        entry.revision = entry.revision.max(tombstone.revision);
        entry.is_final |= tombstone.is_final;
    }

    /// その revision の manifest を拒否すべきか。final なら常に拒否。
    pub fn blocks(&self, origin: &str, track_id: &str, revision: u64) -> bool {
        self.entries
            .get(&table_key(origin, track_id))
            .is_some_and(|entry| entry.is_final || revision <= entry.revision)
    }

    pub fn cursor(&self, origin: &str) -> u64 {
        self.cursors.get(&origin_key(origin)).copied().unwrap_or(0)
    }

    pub fn set_cursor(&mut self, origin: &str, seq: u64) {
        let slot = self.cursors.entry(origin_key(origin)).or_insert(0);
        *slot = (*slot).max(seq);
    }

    /// final 以外は 400 日で落とす（6.5）。
    pub fn prune(&mut self, now: DateTime<Utc>) {
        let limit = now - Duration::days(TOMBSTONE_RETENTION_DAYS);
        self.entries.retain(|_, entry| {
            entry.is_final || parse_time(&entry.recorded_at).map(|at| at > limit).unwrap_or(false)
        });
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

// ---------------------------------------------------------------------------
// 試験用の署名器。Music Worker の代わりに manifest などを作る。
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    pub const ORIGIN: &str = "http://127.0.0.1:8787";
    pub const TRACK: &str = "0f8fad5b-d9cb-469f-a165-70867728950c";
    pub const KEY_ID: &str = "music-test";

    pub fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    pub fn now() -> DateTime<Utc> {
        parse_time("2026-10-12T04:00:00.000Z").unwrap()
    }

    pub fn iso(time: DateTime<Utc>) -> String {
        time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    pub fn sign(domain: &str, key: &SigningKey, mut body: Value, field: &str) -> String {
        body.as_object_mut().unwrap().remove(field);
        let mut payload = domain.as_bytes().to_vec();
        payload.extend_from_slice(canonical_json(&body).unwrap().as_bytes());
        URL_SAFE_NO_PAD.encode(key.sign(&payload).to_bytes())
    }

    pub fn key_entry(key_id: &str, key: &SigningKey) -> Value {
        json!({
            "keyId": key_id, "alg": "Ed25519",
            "publicKey": URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
            "notBefore": "2026-10-01T00:00:00.000Z", "notAfter": "2027-04-01T00:00:00.000Z"
        })
    }

    /// `signers` は (keyId, 鍵) の組。`keys` に載せる鍵と署名する鍵を別にできる。
    pub fn keyset(origin: &str, issued_at: &str, keys: &[(&str, &SigningKey)], signers: &[(&str, &SigningKey)]) -> Value {
        let mut body = json!({
            "type": KEYSET_TYPE, "origin": origin, "tracker": "/swarm/api/v1", "issuedAt": issued_at,
            "keys": keys.iter().map(|(id, key)| key_entry(id, key)).collect::<Vec<_>>(),
            "signatures": []
        });
        let signatures: Vec<Value> = signers
            .iter()
            .map(|(id, key)| json!({"keyId": id, "signature": sign(KEYSET_DOMAIN, key, body.clone(), "signatures")}))
            .collect();
        body["signatures"] = Value::Array(signatures);
        body
    }

    pub fn default_keyset() -> Value {
        let key = signing_key(1);
        keyset(ORIGIN, "2026-10-12T00:00:00.000Z", &[(KEY_ID, &key)], &[(KEY_ID, &key)])
    }

    pub fn manifest(audio: &[u8], revision: u64, issued: DateTime<Utc>, lifetime: Duration, key: &SigningKey) -> Value {
        let chunks: Vec<String> = audio.chunks(CHUNK_SIZE as usize).map(sha256_hex).collect();
        let mut body = json!({
            "type": MANIFEST_TYPE, "origin": ORIGIN, "trackId": TRACK, "revision": revision,
            "contentType": "audio/mpeg", "size": audio.len(), "sha256": sha256_hex(audio),
            "chunkSize": CHUNK_SIZE, "chunks": chunks,
            "publishedAt": "2026-10-12T00:00:00.000Z", "issuedAt": iso(issued),
            "notAfter": iso(issued + lifetime), "keyId": KEY_ID, "signature": ""
        });
        let signature = sign(MANIFEST_DOMAIN, key, body.clone(), "signature");
        body["signature"] = Value::String(signature);
        body
    }

    pub fn tombstone(revision: u64, is_final: bool, reason: &str, key: &SigningKey) -> Value {
        let mut body = json!({
            "type": TOMBSTONE_TYPE, "origin": ORIGIN, "trackId": TRACK, "revision": revision,
            "reason": reason, "final": is_final, "revokedAt": "2026-10-12T03:30:00.000Z",
            "keyId": KEY_ID, "signature": ""
        });
        let signature = sign(TOMBSTONE_DOMAIN, key, body.clone(), "signature");
        body["signature"] = Value::String(signature);
        body
    }

    pub fn attestation(track: &str, revision: u64, pieces: &[&[u8]], key: &SigningKey) -> Value {
        let mut body = json!({
            "v": 1, "type": ATTESTATION_TYPE, "trackId": track, "revision": revision,
            "pieceSize": CHUNK_SIZE, "pieces": pieces.iter().map(|p| sha256_hex(p)).collect::<Vec<_>>(),
            "issuedAt": "2026-10-12T03:00:00.000Z", "kid": KEY_ID, "signature": ""
        });
        let signature = sign(ATTESTATION_DOMAIN, key, body.clone(), "signature");
        body["signature"] = Value::String(signature);
        body
    }

    pub fn parsed_default_keyset() -> KeySet {
        KeySet::parse(&default_keyset(), ORIGIN).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use serde_json::json;

    fn audio() -> Vec<u8> {
        (0..(CHUNK_SIZE as usize + 100)).map(|i| (i % 251) as u8).collect()
    }

    fn good() -> Value {
        manifest(&audio(), 3, now() - Duration::minutes(5), Duration::hours(6), &signing_key(1))
    }

    #[test]
    fn media_manifest_accepts_a_good_manifest_and_checks_pieces() {
        let keys = parsed_default_keyset();
        let m = verify_manifest(&keys, &TombstoneTable::default(), &good(), now()).unwrap();
        let data = audio();
        assert_eq!(m.piece_count(), 2);
        assert_eq!(m.piece_len(1), Some(100));
        assert!(m.verify_piece(0, &data[..CHUNK_SIZE as usize]));
        assert!(!m.verify_piece(0, &data[1..=CHUNK_SIZE as usize]));
        assert!(!m.verify_piece(1, &data[CHUNK_SIZE as usize..CHUNK_SIZE as usize + 99]));
        assert!(m.verify_whole(&data));
        let mut broken = data.clone();
        broken[7] ^= 1;
        assert!(!m.verify_whole(&broken));
    }

    #[test]
    fn media_manifest_rejects_every_tampered_field() {
        let keys = parsed_default_keyset();
        let original = good();
        let fields: Vec<String> = original.as_object().unwrap().keys().cloned().collect();
        assert!(fields.len() >= 14);
        for field in &fields {
            let mut tampered = original.clone();
            tampered[field] = match &original[field] {
                Value::String(text) => {
                    let mut chars: Vec<char> = text.chars().collect();
                    match chars.last_mut() {
                        Some(last) => *last = if *last == 'a' { 'b' } else { 'a' },
                        None => chars.push('a'),
                    }
                    Value::String(chars.into_iter().collect())
                }
                Value::Number(number) => json!(number.as_u64().unwrap() + 1),
                Value::Array(items) => {
                    let mut items = items.clone();
                    items.pop();
                    Value::Array(items)
                }
                other => other.clone(),
            };
            assert!(
                verify_manifest(&keys, &TombstoneTable::default(), &tampered, now()).is_err(),
                "tampering {field} must be rejected"
            );
        }
        // chunk hash swapped for another valid-looking hash (same length)
        let mut swapped = original.clone();
        swapped["chunks"][0] = json!("0".repeat(64));
        assert_eq!(
            verify_manifest(&keys, &TombstoneTable::default(), &swapped, now()),
            Err("manifest_bad_signature")
        );
        // extra unknown field
        let mut extra = original.clone();
        extra["title"] = json!("x");
        assert_eq!(verify_manifest(&keys, &TombstoneTable::default(), &extra, now()), Err("manifest_malformed"));
    }

    #[test]
    fn media_manifest_rejects_expiry_unknown_key_lifetime_and_future() {
        let keys = parsed_default_keyset();
        let table = TombstoneTable::default();
        // expired
        let expired = manifest(&audio(), 1, now() - Duration::hours(7), Duration::hours(6), &signing_key(1));
        assert_eq!(verify_manifest(&keys, &table, &expired, now()), Err("manifest_expired"));
        // notAfter exactly now is expired
        let edge = manifest(&audio(), 1, now() - Duration::hours(1), Duration::hours(1), &signing_key(1));
        assert_eq!(verify_manifest(&keys, &table, &edge, now()), Err("manifest_expired"));
        // lifetime > 6h (correctly signed)
        let long = manifest(&audio(), 1, now() - Duration::minutes(1), Duration::hours(6) + Duration::seconds(1), &signing_key(1));
        assert_eq!(verify_manifest(&keys, &table, &long, now()), Err("manifest_lifetime"));
        // issued in the future beyond skew
        let future = manifest(&audio(), 1, now() + Duration::minutes(5), Duration::hours(1), &signing_key(1));
        assert_eq!(verify_manifest(&keys, &table, &future, now()), Err("manifest_from_future"));
        // unknown keyId (signed by a stranger, claiming an id that is not in the set)
        let mut unknown = good();
        unknown["keyId"] = json!("music-other");
        assert_eq!(verify_manifest(&keys, &table, &unknown, now()), Err("manifest_unknown_key"));
        // right keyId, wrong signing key
        let forged = manifest(&audio(), 1, now() - Duration::minutes(1), Duration::hours(1), &signing_key(9));
        assert_eq!(verify_manifest(&keys, &table, &forged, now()), Err("manifest_bad_signature"));
        // key outside its validity window
        let later = parse_time("2027-05-01T00:00:00.000Z").unwrap();
        let ok = manifest(&audio(), 1, later - Duration::minutes(1), Duration::hours(1), &signing_key(1));
        assert_eq!(verify_manifest(&keys, &table, &ok, later), Err("manifest_key_not_valid"));
        // wrong origin
        let other = KeySet::parse(
            &keyset("https://other.example", "2026-10-12T00:00:00.000Z", &[(KEY_ID, &signing_key(1))], &[(KEY_ID, &signing_key(1))]),
            "https://other.example",
        )
        .unwrap();
        assert_eq!(verify_manifest(&other, &table, &good(), now()), Err("manifest_origin"));
    }

    #[test]
    fn media_manifest_rejects_oversize_and_bad_shape() {
        let keys = parsed_default_keyset();
        let table = TombstoneTable::default();
        let key = signing_key(1);
        let mut value = good();
        value["size"] = json!(MAX_TRACK_BYTES + 1);
        value["signature"] = json!(sign(MANIFEST_DOMAIN, &key, value.clone(), "signature"));
        assert_eq!(verify_manifest(&keys, &table, &value, now()), Err("manifest_shape"));
        let mut value = good();
        value["chunks"] = json!(["a".repeat(64)]);
        value["signature"] = json!(sign(MANIFEST_DOMAIN, &key, value.clone(), "signature"));
        assert_eq!(verify_manifest(&keys, &table, &value, now()), Err("manifest_shape"));
        let mut value = good();
        value["trackId"] = json!("dQw4w9WgXcQ");
        value["signature"] = json!(sign(MANIFEST_DOMAIN, &key, value.clone(), "signature"));
        assert_eq!(verify_manifest(&keys, &table, &value, now()), Err("manifest_track_id"));
        // non-ASCII never reaches the signature check
        let mut value = good();
        value["contentType"] = json!("audio/m\u{e9}");
        assert!(verify_manifest(&keys, &table, &value, now()).is_err());
    }

    #[test]
    fn media_manifest_tombstone_table_blocks_by_revision_and_final() {
        let keys = parsed_default_keyset();
        let t = verify_tombstone(&keys, &tombstone(3, false, "unpublished", &signing_key(1)), now()).unwrap();
        let mut table = TombstoneTable::default();
        table.record(&t, now());
        assert!(table.blocks(ORIGIN, TRACK, 3));
        assert!(table.blocks(ORIGIN, TRACK, 1));
        assert!(!table.blocks(ORIGIN, TRACK, 4), "republished revisions are not killed");
        assert_eq!(verify_manifest(&keys, &table, &good(), now()), Err("manifest_revoked"));
        let newer = manifest(&audio(), 4, now() - Duration::minutes(1), Duration::hours(1), &signing_key(1));
        assert!(verify_manifest(&keys, &table, &newer, now()).is_ok());
        // final blocks everything and cannot be undone by a lower non-final one
        let f = verify_tombstone(&keys, &tombstone(4, true, "deleted", &signing_key(1)), now()).unwrap();
        table.record(&f, now());
        table.record(&t, now());
        assert!(table.blocks(ORIGIN, TRACK, 999));
        // retention: final survives pruning, non-final does not
        let mut other = TombstoneTable::default();
        other.record(&t, now());
        other.prune(now() + Duration::days(401));
        assert_eq!(other.len(), 0);
        table.prune(now() + Duration::days(401));
        assert!(table.blocks(ORIGIN, TRACK, 999));
    }

    #[test]
    fn media_manifest_tombstone_signature_and_shape_are_checked() {
        let keys = parsed_default_keyset();
        let original = tombstone(2, false, "hidden", &signing_key(1));
        assert!(verify_tombstone(&keys, &original, now()).is_ok());
        for field in ["origin", "trackId", "revision", "reason", "final", "revokedAt", "keyId"] {
            let mut bad = original.clone();
            bad[field] = match &original[field] {
                Value::String(s) => json!(format!("{s}x")),
                Value::Number(n) => json!(n.as_u64().unwrap() + 1),
                Value::Bool(b) => json!(!b),
                other => other.clone(),
            };
            assert!(verify_tombstone(&keys, &bad, now()).is_err(), "{field}");
        }
        let forged = tombstone(2, false, "hidden", &signing_key(7));
        assert_eq!(verify_tombstone(&keys, &forged, now()), Err("tombstone_bad_signature"));
    }

    #[test]
    fn media_manifest_keyset_is_pinned_and_rotates_only_under_a_pinned_key() {
        let (a, b, stranger) = (signing_key(1), signing_key(2), signing_key(3));
        let first = KeySet::parse(&keyset(ORIGIN, "2026-10-12T00:00:00.000Z", &[("k1", &a)], &[("k1", &a)]), ORIGIN).unwrap();
        assert_eq!(evaluate_keyset(None, &first, now()), Ok(PinOutcome::Pinned));
        assert_eq!(evaluate_keyset(Some(&first), &first, now()), Ok(PinOutcome::Unchanged));
        // unsigned or self-signature by a key not in the set
        let unsigned = KeySet::parse(&keyset(ORIGIN, "2026-10-12T00:00:00.000Z", &[("k1", &a)], &[("k1", &stranger)]), ORIGIN).unwrap();
        assert_eq!(evaluate_keyset(None, &unsigned, now()), Err("keyset_unsigned"));
        // rotation: new set {k1,k2}, signed by pinned k1 (and k2)
        let rotated = KeySet::parse(
            &keyset(ORIGIN, "2026-10-13T00:00:00.000Z", &[("k1", &a), ("k2", &b)], &[("k1", &a), ("k2", &b)]),
            ORIGIN,
        )
        .unwrap();
        assert_eq!(evaluate_keyset(Some(&first), &rotated, now()), Ok(PinOutcome::Rotated));
        // takeover: a different key set signed only by a new key
        let takeover = KeySet::parse(&keyset(ORIGIN, "2026-10-13T00:00:00.000Z", &[("k9", &stranger)], &[("k9", &stranger)]), ORIGIN).unwrap();
        assert_eq!(evaluate_keyset(Some(&first), &takeover, now()), Err("keyset_changed"));
        assert!(evaluate_explicit_repin(&takeover, now()).is_ok());
        // key id claimed by the set but signed with another secret
        let spoof = KeySet::parse(&keyset(ORIGIN, "2026-10-13T00:00:00.000Z", &[("k1", &stranger)], &[("k1", &stranger)]), ORIGIN).unwrap();
        assert_eq!(evaluate_keyset(Some(&first), &spoof, now()), Err("keyset_changed"));
        // rollback to an older issuedAt
        let older = KeySet::parse(&keyset(ORIGIN, "2026-10-01T00:00:00.000Z", &[("k1", &a), ("k2", &b)], &[("k1", &a)]), ORIGIN).unwrap();
        assert_eq!(evaluate_keyset(Some(&first), &older, now()), Err("keyset_rollback"));
    }

    #[test]
    fn media_manifest_keyset_shape_rejects_foreign_tracker_and_origin() {
        let a = signing_key(1);
        for tracker in ["https://evil.example/swarm", "//evil.example/x", "swarm/api", "/a b", "\\\\evil"] {
            let mut value = keyset(ORIGIN, "2026-10-12T00:00:00.000Z", &[("k1", &a)], &[("k1", &a)]);
            value["tracker"] = json!(tracker);
            assert_eq!(KeySet::parse(&value, ORIGIN), Err("keyset_tracker_foreign"), "{tracker}");
        }
        let value = keyset("https://other.example", "2026-10-12T00:00:00.000Z", &[("k1", &a)], &[("k1", &a)]);
        assert_eq!(KeySet::parse(&value, ORIGIN), Err("keyset_origin"));
        let mut value = keyset(ORIGIN, "2026-10-12T00:00:00.000Z", &[("k1", &a)], &[("k1", &a)]);
        value["keys"][0]["publicKey"] = json!("AAAA");
        assert_eq!(KeySet::parse(&value, ORIGIN), Err("keyset_key_invalid"));
    }

    #[test]
    fn media_manifest_canonical_json_is_sorted_compact_and_strict() {
        let value = json!({"b": [1, {"z": true, "a": 2}], "a": "x\"y\\z"});
        assert_eq!(canonical_json(&value).unwrap(), r#"{"a":"x\"y\\z","b":[1,{"a":2,"z":true}]}"#);
        assert_eq!(canonical_json(&json!({"a": null})), Err("canonical_null"));
        assert_eq!(canonical_json(&json!({"a": "x\n"})), Err("canonical_non_ascii"));
        assert_eq!(canonical_json(&json!({"n": 1.5})), Err("canonical_non_integer"));
        assert_eq!(canonical_json(&json!({"s": "caf\u{e9}"})), Err("canonical_non_ascii"));
        assert_eq!(canonical_json(&json!({"k": -3})).unwrap(), r#"{"k":-3}"#);
    }

    /// Music 側 (TS) が生成した共通ベクタ。docs/hub-distributed-media/vectors/manifest-v1.json
    #[test]
    fn media_manifest_shared_vectors_match_music() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../docs/hub-distributed-media/vectors/manifest-v1.json"
        ))
        .unwrap();
        let origin = "https://hub.example";
        let keyset = KeySet::parse(&vectors["keyset"], origin).unwrap();
        assert_eq!(evaluate_keyset(None, &keyset, now()), Ok(PinOutcome::Pinned));
        let table = TombstoneTable::default();
        let at = |case: &Value| parse_time(case["now"].as_str().unwrap()).unwrap();

        for case in vectors["canonicalCases"].as_array().unwrap() {
            assert_eq!(canonical_json(&case["input"]).unwrap(), case["canonical"].as_str().unwrap());
        }
        for case in vectors["canonicalRejects"].as_array().unwrap() {
            let parsed: Result<Value, _> = serde_json::from_str(case["jsonText"].as_str().unwrap());
            let rejected = parsed.map(|v| canonical_json(&v).is_err()).unwrap_or(true);
            assert!(rejected, "canonical must reject {}", case["name"]);
        }
        // 署名対象のバイト列そのものが一致する
        let m = &vectors["manifest"];
        let payload = signed_payload(MANIFEST_DOMAIN, &m["document"], "signature").unwrap();
        assert_eq!(payload, hex_decode(m["signingBytesHex"].as_str().unwrap()));
        assert_eq!(
            keyset.payload().unwrap(),
            vectors["keysetSigningBytesUtf8"].as_str().unwrap().as_bytes()
        );

        let mut manifests = 0;
        for case in vectors["manifestCases"].as_array().unwrap() {
            let result = verify_manifest(&keyset, &table, &case["document"], at(case));
            assert_eq!(result.is_ok(), case["expect"] == "accept", "manifest case {}: {:?}", case["name"], result.err());
            manifests += 1;
        }
        let mut tombstones = 0;
        for case in vectors["tombstoneCases"].as_array().unwrap() {
            let result = verify_tombstone(&keyset, &case["document"], at(case));
            assert_eq!(result.is_ok(), case["expect"] == "accept", "tombstone case {}", case["name"]);
            tombstones += 1;
        }
        for case in vectors["keysetCases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let outcome = KeySet::parse(&case["document"], origin).and_then(|candidate| {
                if name == "tampered public key" {
                    evaluate_keyset(Some(&keyset), &candidate, at(case)).map(|_| ())
                } else {
                    evaluate_keyset(None, &candidate, at(case)).map(|_| ())
                }
            });
            assert_eq!(outcome.is_ok(), case["expect"] == "accept", "keyset case {name}");
        }
        assert!(manifests >= 30 && tombstones >= 10);

        // 断片の実バイト列
        let media = &vectors["media"];
        let size = media["size"].as_u64().unwrap() as usize;
        let bytes: Vec<u8> = (0..size).map(|i| ((i * 31 + 7) & 0xff) as u8).collect();
        let good = verify_manifest(&keyset, &table, &m["document"], parse_time("2026-10-12T04:00:00.000Z").unwrap()).unwrap();
        assert!(good.verify_whole(&bytes));
        assert!(good.verify_piece(0, &bytes[..CHUNK_SIZE as usize]));
        assert!(good.verify_piece(1, &bytes[CHUNK_SIZE as usize..]));
    }

    fn hex_decode(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn media_manifest_origin_and_track_id_shapes() {
        assert_eq!(normalize_origin("https://hub.jkamma.com/").unwrap(), "https://hub.jkamma.com");
        assert_eq!(normalize_origin("http://localhost:3020").unwrap(), "http://localhost:3020");
        for bad in ["http://hub.jkamma.com", "https://hub.jkamma.com/music", "https://u:p@hub.jkamma.com", "https://hub.jkamma.com/?x=1", "ftp://x", ""] {
            assert!(normalize_origin(bad).is_err(), "{bad}");
        }
        assert!(track_uuid(TRACK).is_some());
        assert_eq!(track_uuid("0F8FAD5B-D9CB-469F-A165-70867728950C").as_deref(), Some(TRACK));
        for bad in ["dQw4w9WgXcQ", "", "../etc", "0f8fad5bd9cb469fa16570867728950c0000"] {
            assert!(track_uuid(bad).is_none(), "{bad}");
        }
        assert_eq!(origin_key("https://a.example").len(), 32);
    }
}
