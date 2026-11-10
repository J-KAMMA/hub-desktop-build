//! 端末の音声キャッシュ（`<storage>/media-cache/`）と、元 Hub の Music からの取得・再検証。
//!
//! docs/hub-distributed-media/DESIGN.md 6章・3.3 に対応。`artifacts/published/`（Personal Node の
//! 公開原本）とは根を分け、キャッシュした他人の曲が原本として再公開される経路を作らない。
//! 段階1なので P2P はまだ使わない: 断片は元 HTTP の Range で取り、署名と失効の仕組みを通す。
//! 通信先は選ばれた Hub origin の `/music/api/...` だけ。群れの Worker（tracker）には、
//! 設定が両方オフの間は一切つながない（`tracker_connect` が拒否する）。
//!
//! 時刻は全部 `now` 引数で受ける（試験で動かせるように）。

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::media_manifest::{
    evaluate_explicit_repin, evaluate_keyset, normalize_origin, origin_key, parse_stored_manifest,
    track_uuid, verify_manifest, verify_tombstone, KeySet, Manifest, PinOutcome, Tombstone,
    TombstoneTable, CHUNK_SIZE, MAX_TRACK_BYTES,
};

pub const DEFAULT_CACHE_MIB: u64 = 2048;
pub const MIN_CACHE_MIB: u64 = 256;
pub const MAX_CACHE_MIB: u64 = 20 * 1024;
pub const MAX_TRACKS: usize = 2000;
/// 再生の直前にキャッシュの manifest がこれ以内に検証済みでなければ取り直す（6.4）。
pub const PLAY_FRESH_MINUTES: i64 = 30;
/// 配布中の曲の再検証間隔（6.4）。
pub const SEED_REVALIDATE_MINUTES: i64 = 60;
/// 配布していないキャッシュの再検証間隔（6.4）。
pub const IDLE_REVALIDATE_HOURS: i64 = 6;
/// 最後の検証からの再生猶予（6.7）。
pub const OFFLINE_GRACE_HOURS: i64 = 72;
/// これだけ検証できていない曲は tombstone が無くても消す（6.5）。
pub const PURGE_UNVERIFIED_DAYS: i64 = 30;

pub(crate) const MAX_JSON_BYTES: usize = 512 * 1024;
const NET_LOG_CAP: usize = 500;

type Check<T> = Result<T, &'static str>;

// ---------------------------------------------------------------------------
// エラー: 呼び出し側（lib.rs）が元 HTTP へ退避してよいかを区別する
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaError {
    /// YouTube など Music の曲でないもの・不正な入力。何も取りに行かない。退避もしない。
    Refused(&'static str),
    /// 失効した曲。キャッシュは消した。退避しない。
    Revoked(&'static str),
    /// 取れなかった（鍵集合・容量・通信・Range 非対応など）。元 HTTP 再生へ退避してよい。
    Unavailable(&'static str),
}

impl MediaError {
    pub fn allows_http_fallback(&self) -> bool {
        matches!(self, MediaError::Unavailable(_))
    }
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaError::Refused(why) => write!(f, "media_refused:{why}"),
            MediaError::Revoked(why) => write!(f, "media_revoked:{why}"),
            MediaError::Unavailable(why) => write!(f, "media_unavailable:{why}"),
        }
    }
}

// ---------------------------------------------------------------------------
// 設定（どちらも既定オフ）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaP2pSettings {
    /// 他の端末から受け取る。
    pub receive_from_peers: bool,
    /// この端末から配る（シード）。
    pub seed: bool,
    /// 中継（TURN）のみで接続する。
    pub relay_only: bool,
    /// 自 Hub 以外で、この端末が扱ってよい origin。
    pub allowed_origins: Vec<String>,
    pub upload_kib_per_sec: u32,
    pub cache_limit_mib: u64,
}

impl Default for MediaP2pSettings {
    fn default() -> Self {
        Self {
            receive_from_peers: false,
            seed: false,
            relay_only: true,
            allowed_origins: Vec::new(),
            upload_kib_per_sec: 512,
            cache_limit_mib: DEFAULT_CACHE_MIB,
        }
    }
}

impl MediaP2pSettings {
    fn sanitized(mut self) -> Check<Self> {
        self.upload_kib_per_sec = self.upload_kib_per_sec.clamp(128, 8192);
        self.cache_limit_mib = self.cache_limit_mib.clamp(MIN_CACHE_MIB, MAX_CACHE_MIB);
        let mut origins = Vec::new();
        for origin in &self.allowed_origins {
            let origin = normalize_origin(origin).map_err(|_| "settings_origin")?;
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        if origins.len() > 32 {
            return Err("settings_origin");
        }
        self.allowed_origins = origins;
        Ok(self)
    }

    /// 群れの Worker へつないでよいか。両方オフなら偽。
    pub fn tracker_allowed(&self) -> bool {
        self.receive_from_peers || self.seed
    }
}

// ---------------------------------------------------------------------------
// 通信の口。試験では偽物に差し替える。
// ---------------------------------------------------------------------------

pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait MediaSource: Sync {
    /// `range` は両端を含む `(start, end)`。リダイレクトは追わない。
    fn get(
        &self,
        url: &str,
        range: Option<(u64, u64)>,
        max_bytes: usize,
    ) -> impl Future<Output = Result<Reply, &'static str>> + Send;
}

pub struct HttpSource {
    client: reqwest::Client,
}

impl HttpSource {
    pub fn new() -> Check<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| "media_client")?;
        Ok(Self { client })
    }
}

impl MediaSource for HttpSource {
    async fn get(&self, url: &str, range: Option<(u64, u64)>, max_bytes: usize) -> Result<Reply, &'static str> {
        let mut request = self.client.get(url);
        if let Some((start, end)) = range {
            request = request.header(reqwest::header::RANGE, format!("bytes={start}-{end}"));
        }
        let response = request.send().await.map_err(|_| "media_network")?;
        if response.content_length().unwrap_or(0) > max_bytes as u64 {
            return Err("media_response_too_large");
        }
        let status = response.status().as_u16();
        let body = response.bytes().await.map_err(|_| "media_network")?;
        if body.len() > max_bytes {
            return Err("media_response_too_large");
        }
        Ok(Reply { status, body: body.to_vec() })
    }
}

// ---------------------------------------------------------------------------
// キャッシュ本体
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub origin: String,
    pub track_id: String,
    pub revision: u64,
    pub size: u64,
    pub sha256: String,
    pub last_verified_at: String,
    pub last_played_at: String,
    pub not_after: String,
    pub complete: bool,
    /// 「オフラインで保存」した曲。追い出さない。
    pub pinned: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    #[serde(default)]
    entries: BTreeMap<String, CacheEntry>,
}

static INDEX_LOCK: Mutex<()> = Mutex::new(());
static GLOBAL_LOG: OnceLock<Arc<Mutex<Vec<String>>>> = OnceLock::new();

fn lock() -> MutexGuard<'static, ()> {
    INDEX_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn read_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc))
}

fn entry_key(origin: &str, track_id: &str) -> String {
    format!("{}/{}", origin_key(origin), track_id)
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Check<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "cache_write")?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes).map_err(|_| "cache_write")?;
    std::fs::rename(&temporary, path).map_err(|_| "cache_write")
}

#[derive(Clone)]
pub struct MediaCache {
    root: PathBuf,
    log: Arc<Mutex<Vec<String>>>,
}

impl MediaCache {
    /// `storage_path` は Personal Node の保管先。`media-cache/` はその下に別の根として作る。
    pub fn open(storage_path: &str) -> Check<Self> {
        let log = GLOBAL_LOG.get_or_init(|| Arc::new(Mutex::new(Vec::new()))).clone();
        Self::open_with_log(storage_path, log)
    }

    pub(crate) fn open_with_log(storage_path: &str, log: Arc<Mutex<Vec<String>>>) -> Check<Self> {
        let root = PathBuf::from(storage_path).join("media-cache");
        std::fs::create_dir_all(root.join("tracks")).map_err(|_| "cache_unavailable")?;
        std::fs::create_dir_all(root.join("keysets")).map_err(|_| "cache_unavailable")?;
        Ok(Self { root, log })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn track_root(&self, origin: &str, track_id: &str) -> PathBuf {
        self.root.join("tracks").join(origin_key(origin)).join(track_id)
    }

    fn revision_dir(&self, origin: &str, track_id: &str, revision: u64) -> PathBuf {
        self.track_root(origin, track_id).join(revision.to_string())
    }

    // ---- 通信先の記録（段階1の試験用の口） ----

    pub(crate) fn log_request(&self, url: &str) {
        let mut log = self.log.lock().unwrap_or_else(|p| p.into_inner());
        if log.len() >= NET_LOG_CAP {
            log.remove(0);
        }
        log.push(url.to_owned());
    }

    /// これまでにメディア層が送った要求の宛先（URL）。
    pub fn net_log(&self) -> Vec<String> {
        self.log.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// 群れの Worker へつなぐ前に必ず通す。両方オフなら何も記録せず拒否する。
    pub fn tracker_connect(&self, url: &str) -> Check<()> {
        if !self.settings().tracker_allowed() {
            return Err("p2p_disabled");
        }
        self.log_request(url);
        Ok(())
    }

    // ---- 設定 ----

    pub fn settings(&self) -> MediaP2pSettings {
        std::fs::read(self.root.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<MediaP2pSettings>(&bytes).ok())
            .and_then(|settings| settings.sanitized().ok())
            .unwrap_or_default()
    }

    pub fn set_settings(&self, settings: MediaP2pSettings) -> Check<MediaP2pSettings> {
        let settings = settings.sanitized()?;
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|_| "cache_write")?;
        let _guard = lock();
        write_atomic(&self.root.join("settings.json"), &bytes)?;
        Ok(settings)
    }

    // ---- 鍵集合（origin ごとの固定） ----

    pub fn keyset(&self, origin: &str) -> Option<KeySet> {
        let bytes = std::fs::read(self.root.join("keysets").join(format!("{}.json", origin_key(origin)))).ok()?;
        let set: KeySet = serde_json::from_slice(&bytes).ok()?;
        (set.origin == origin).then_some(set)
    }

    fn save_keyset(&self, set: &KeySet) -> Check<()> {
        let bytes = serde_json::to_vec_pretty(set).map_err(|_| "cache_write")?;
        let _guard = lock();
        write_atomic(&self.root.join("keysets").join(format!("{}.json", origin_key(&set.origin))), &bytes)
    }

    /// 利用者の明示操作で固定し直す。鍵集合は自分自身の鍵で署名されていなければならない。
    pub fn repin_keyset(&self, set: &KeySet, now: DateTime<Utc>) -> Check<()> {
        evaluate_explicit_repin(set, now)?;
        self.save_keyset(set)
    }

    // ---- tombstone 表 ----

    pub fn tombstones(&self) -> TombstoneTable {
        std::fs::read(self.root.join("tombstones.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save_tombstones(&self, table: &TombstoneTable) -> Check<()> {
        let bytes = serde_json::to_vec_pretty(table).map_err(|_| "cache_write")?;
        write_atomic(&self.root.join("tombstones.json"), &bytes)
    }

    // ---- 索引 ----

    fn load_index(&self) -> Index {
        std::fs::read(self.root.join("index.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save_index(&self, index: &Index) -> Check<()> {
        write_atomic(&self.root.join("index.json"), &serde_json::to_vec_pretty(index).map_err(|_| "cache_write")?)
    }

    pub fn entry(&self, origin: &str, track_id: &str) -> Option<CacheEntry> {
        let _guard = lock();
        self.load_index().entries.get(&entry_key(origin, track_id)).cloned()
    }

    pub fn entries(&self) -> Vec<CacheEntry> {
        let _guard = lock();
        self.load_index().entries.into_values().collect()
    }

    pub fn usage_bytes(&self) -> u64 {
        self.entries().iter().map(|entry| entry.size).sum()
    }

    fn update_entry(&self, origin: &str, track_id: &str, change: impl FnOnce(&mut CacheEntry)) -> Check<()> {
        let _guard = lock();
        let mut index = self.load_index();
        if let Some(entry) = index.entries.get_mut(&entry_key(origin, track_id)) {
            change(entry);
            self.save_index(&index)?;
        }
        Ok(())
    }

    /// 検証済みの manifest を保存し、新しい（未完了の）エントリを作る。
    fn begin_entry(&self, manifest: &Manifest, raw: &Value, now: DateTime<Utc>) -> Check<()> {
        let bytes = serde_json::to_vec(raw).map_err(|_| "cache_write")?;
        let _guard = lock();
        write_atomic(&self.revision_dir(&manifest.origin, &manifest.track_id, manifest.revision).join("manifest.json"), &bytes)?;
        let mut index = self.load_index();
        let key = entry_key(&manifest.origin, &manifest.track_id);
        let previous = index.entries.get(&key);
        let entry = CacheEntry {
            origin: manifest.origin.clone(),
            track_id: manifest.track_id.clone(),
            revision: manifest.revision,
            size: manifest.size,
            sha256: manifest.sha256.clone(),
            last_verified_at: stamp(now),
            last_played_at: previous.map(|p| p.last_played_at.clone()).unwrap_or_else(|| stamp(now)),
            not_after: manifest.not_after.clone(),
            complete: false,
            pinned: previous.is_some_and(|p| p.pinned),
        };
        index.entries.insert(key, entry);
        self.save_index(&index)
    }

    /// 同じ revision の再検証。manifest（署名つき）と有効期限だけを更新し、断片は保持する。
    fn refresh_entry(&self, manifest: &Manifest, raw: &Value, now: DateTime<Utc>) -> Check<()> {
        let bytes = serde_json::to_vec(raw).map_err(|_| "cache_write")?;
        {
            let _guard = lock();
            write_atomic(&self.revision_dir(&manifest.origin, &manifest.track_id, manifest.revision).join("manifest.json"), &bytes)?;
        }
        self.update_entry(&manifest.origin, &manifest.track_id, |entry| {
            entry.last_verified_at = stamp(now);
            entry.not_after = manifest.not_after.clone();
        })
    }

    /// revision が上がり `sha256` が同じ: ディレクトリを新しい revision へ移す。
    fn rekey_entry(&self, old: &CacheEntry, manifest: &Manifest, raw: &Value, now: DateTime<Utc>) -> Check<()> {
        {
            let _guard = lock();
            let from = self.revision_dir(&old.origin, &old.track_id, old.revision);
            let to = self.revision_dir(&old.origin, &old.track_id, manifest.revision);
            if to.exists() {
                std::fs::remove_dir_all(&to).map_err(|_| "cache_write")?;
            }
            std::fs::rename(&from, &to).map_err(|_| "cache_write")?;
        }
        let bytes = serde_json::to_vec(raw).map_err(|_| "cache_write")?;
        {
            let _guard = lock();
            write_atomic(&self.revision_dir(&old.origin, &old.track_id, manifest.revision).join("manifest.json"), &bytes)?;
        }
        self.update_entry(&old.origin, &old.track_id, |entry| {
            entry.revision = manifest.revision;
            entry.last_verified_at = stamp(now);
            entry.not_after = manifest.not_after.clone();
        })
    }

    fn stored_manifest(&self, entry: &CacheEntry) -> Option<Manifest> {
        let keys = self.keyset(&entry.origin)?;
        let bytes = std::fs::read(self.revision_dir(&entry.origin, &entry.track_id, entry.revision).join("manifest.json")).ok()?;
        let raw: Value = serde_json::from_slice(&bytes).ok()?;
        let manifest = parse_stored_manifest(&keys, &raw).ok()?;
        (manifest.track_id == entry.track_id && manifest.revision == entry.revision && manifest.sha256 == entry.sha256).then_some(manifest)
    }

    // ---- 断片 ----

    fn piece_path(&self, manifest: &Manifest, index: usize) -> PathBuf {
        self.revision_dir(&manifest.origin, &manifest.track_id, manifest.revision)
            .join("chunks")
            .join(format!("{index:08}.bin"))
    }

    /// 読み出しのたびに長さと SHA-256 を照合する。合わない断片は消して `None`（取り直す）。
    pub fn read_piece(&self, manifest: &Manifest, index: usize) -> Option<Vec<u8>> {
        let path = self.piece_path(manifest, index);
        let bytes = std::fs::read(&path).ok()?;
        if manifest.verify_piece(index, &bytes) {
            Some(bytes)
        } else {
            let _ = std::fs::remove_file(&path);
            None
        }
    }

    /// 照合に通った断片だけを保存する。
    pub fn put_piece(&self, manifest: &Manifest, index: usize, bytes: &[u8]) -> Check<()> {
        if !manifest.verify_piece(index, bytes) {
            return Err("piece_rejected");
        }
        write_atomic(&self.piece_path(manifest, index), bytes)
    }

    /// 全断片を照合しながら連結し、全体の SHA-256 も確かめる。欠け・破損があれば `None`。
    fn assemble(&self, manifest: &Manifest) -> Option<Vec<u8>> {
        let mut out = Vec::with_capacity(manifest.size as usize);
        for index in 0..manifest.piece_count() {
            out.extend_from_slice(&self.read_piece(manifest, index)?);
        }
        manifest.verify_whole(&out).then_some(out)
    }

    fn mark_complete(&self, manifest: &Manifest, now: DateTime<Utc>) -> Check<()> {
        self.update_entry(&manifest.origin, &manifest.track_id, |entry| {
            entry.complete = true;
            entry.last_played_at = stamp(now);
        })
    }

    // ---- 削除 ----

    /// 曲のディレクトリを丸ごと消す（ゴミ箱は使わない）。消えたことを確かめて記録から外す。
    pub fn delete_track(&self, origin: &str, track_id: &str) -> Check<bool> {
        let _guard = lock();
        let root = self.track_root(origin, track_id);
        let existed = root.exists();
        if existed {
            std::fs::remove_dir_all(&root).map_err(|_| "cache_delete_failed")?;
            if root.exists() {
                return Err("cache_delete_failed");
            }
        }
        let mut index = self.load_index();
        let removed = index.entries.remove(&entry_key(origin, track_id)).is_some();
        if removed {
            self.save_index(&index)?;
        }
        Ok(existed || removed)
    }

    /// 検証済みの tombstone を表に記録し、該当する写しを消す。古い revision の tombstone は
    /// 新しい revision の写しを消さない（final は常に消す）。
    pub fn apply_tombstone(&self, tombstone: &Tombstone, now: DateTime<Utc>) -> Check<bool> {
        {
            let _guard = lock();
            let mut table = self.tombstones();
            table.record(tombstone, now);
            self.save_tombstones(&table)?;
        }
        match self.entry(&tombstone.origin, &tombstone.track_id) {
            Some(entry) if tombstone.is_final || entry.revision <= tombstone.revision => {
                self.delete_track(&tombstone.origin, &tombstone.track_id)
            }
            _ => Ok(false),
        }
    }

    /// 全部消す（設定の「キャッシュを全部消す」）。設定と固定した鍵集合は残す。
    pub fn clear_all(&self) -> Check<()> {
        let _guard = lock();
        let tracks = self.root.join("tracks");
        if tracks.exists() {
            std::fs::remove_dir_all(&tracks).map_err(|_| "cache_delete_failed")?;
        }
        std::fs::create_dir_all(&tracks).map_err(|_| "cache_delete_failed")?;
        // 端末どうしの受け渡しで得た写し（media_swarm）も同じボタンで消す。
        let peer = self.root.join("peer");
        if peer.exists() {
            std::fs::remove_dir_all(&peer).map_err(|_| "cache_delete_failed")?;
        }
        self.save_index(&Index::default())
    }

    /// 30 日以上検証できていない曲と、期限を過ぎた古い tombstone を消す。
    pub fn purge_stale(&self, now: DateTime<Utc>) -> Vec<CacheEntry> {
        let limit = now - Duration::days(PURGE_UNVERIFIED_DAYS);
        let stale: Vec<CacheEntry> = self
            .entries()
            .into_iter()
            .filter(|entry| read_time(&entry.last_verified_at).map(|at| at < limit).unwrap_or(true))
            .collect();
        for entry in &stale {
            let _ = self.delete_track(&entry.origin, &entry.track_id);
        }
        let _guard = lock();
        let mut table = self.tombstones();
        table.prune(now);
        let _ = self.save_tombstones(&table);
        stale
    }

    // ---- 容量 ----

    /// `bytes` を新しく置く空きを作る。最後に再生した時刻が古い順に、固定していない曲を追い出す。
    fn reserve(&self, bytes: u64, keep: &str) -> Check<()> {
        let limit = self.settings().cache_limit_mib * 1024 * 1024;
        let mut candidates: Vec<CacheEntry> = self
            .entries()
            .into_iter()
            .filter(|entry| entry_key(&entry.origin, &entry.track_id) != keep)
            .collect();
        let mut used: u64 = candidates.iter().map(|entry| entry.size).sum();
        let mut count = candidates.len();
        candidates.retain(|entry| !entry.pinned);
        candidates.sort_by(|a, b| a.last_played_at.cmp(&b.last_played_at));
        let mut evict = candidates.into_iter();
        while used + bytes > limit || count + 1 > MAX_TRACKS {
            let Some(victim) = evict.next() else {
                return Err("media_quota");
            };
            self.delete_track(&victim.origin, &victim.track_id)?;
            used -= victim.size;
            count -= 1;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 元 Hub との通信
// ---------------------------------------------------------------------------

pub(crate) async fn get<S: MediaSource>(
    source: &S,
    cache: &MediaCache,
    url: &str,
    range: Option<(u64, u64)>,
    max_bytes: usize,
) -> Option<Reply> {
    cache.log_request(url);
    source.get(url, range, max_bytes).await.ok()
}

pub(crate) fn json_body(reply: &Reply) -> Option<Value> {
    serde_json::from_slice(&reply.body).ok()
}

/// origin の鍵集合を返す。未固定なら取得して固定（TOFU）、`refresh` なら固定済みの鍵で署名された
/// 更新だけを受け入れる。固定済みの鍵で検証できなければその origin の P2P を止める（元 HTTP は続く）。
pub(crate) async fn ensure_keyset<S: MediaSource>(
    source: &S,
    cache: &MediaCache,
    origin: &str,
    now: DateTime<Utc>,
    refresh: bool,
) -> Result<KeySet, MediaError> {
    let pinned = cache.keyset(origin);
    if let (Some(pinned), false) = (&pinned, refresh) {
        return Ok(pinned.clone());
    }
    let reply = get(source, cache, &format!("{origin}/music/api/p2p/v1/keys"), None, MAX_JSON_BYTES)
        .await
        .filter(|r| r.status == 200)
        .ok_or(MediaError::Unavailable("media_keyset_unreachable"))?;
    let raw = json_body(&reply).ok_or(MediaError::Unavailable("media_keyset_invalid"))?;
    let candidate = KeySet::parse(&raw, origin).map_err(|_| MediaError::Unavailable("media_keyset_invalid"))?;
    match evaluate_keyset(pinned.as_ref(), &candidate, now) {
        Ok(PinOutcome::Unchanged) => Ok(candidate),
        Ok(PinOutcome::Pinned | PinOutcome::Rotated) => {
            cache.save_keyset(&candidate).map_err(|_| MediaError::Unavailable("media_cache_write"))?;
            Ok(candidate)
        }
        Err("keyset_changed" | "keyset_rollback") => Err(MediaError::Unavailable("media_keyset_changed")),
        Err(_) => Err(MediaError::Unavailable("media_keyset_invalid")),
    }
}

enum Synced {
    Valid(Manifest),
    Gone,
    NotFound,
    Unreachable,
}

fn tombstone_from_body(body: &Value) -> &Value {
    body.get("tombstone").unwrap_or(body)
}

/// 元 Hub から manifest を取り直し、キャッシュのエントリと突き合わせる（6.4）。
async fn sync_with_origin<S: MediaSource>(
    source: &S,
    cache: &MediaCache,
    origin: &str,
    track_id: &str,
    now: DateTime<Utc>,
) -> Result<Synced, MediaError> {
    let mut keys = ensure_keyset(source, cache, origin, now, false).await?;
    let url = format!("{origin}/music/api/p2p/v1/tracks/{track_id}/manifest");
    let Some(reply) = get(source, cache, &url, None, MAX_JSON_BYTES).await else {
        return Ok(Synced::Unreachable);
    };
    match reply.status {
        200 => {
            let raw = json_body(&reply).ok_or(MediaError::Unavailable("media_manifest_invalid"))?;
            let mut result = verify_manifest(&keys, &cache.tombstones(), &raw, now);
            if result == Err("manifest_unknown_key") {
                keys = ensure_keyset(source, cache, origin, now, true).await?;
                result = verify_manifest(&keys, &cache.tombstones(), &raw, now);
            }
            let manifest = match result {
                Ok(manifest) if manifest.origin == origin && manifest.track_id == track_id => manifest,
                Err("manifest_revoked") => {
                    let _ = cache.delete_track(origin, track_id);
                    return Ok(Synced::Gone);
                }
                _ => return Err(MediaError::Unavailable("media_manifest_invalid")),
            };
            reconcile(cache, &manifest, &raw, now)?;
            Ok(Synced::Valid(manifest))
        }
        410 => {
            // 410 自体が削除の理由になる。同封の tombstone が検証できれば表にも残す。
            let tombstone = json_body(&reply).and_then(|body| verify_tombstone(&keys, tombstone_from_body(&body), now).ok());
            match tombstone {
                Some(tombstone) => {
                    let _ = cache.apply_tombstone(&tombstone, now);
                }
                None => {
                    let _ = cache.delete_track(origin, track_id);
                }
            }
            Ok(Synced::Gone)
        }
        404 => {
            let _ = cache.delete_track(origin, track_id);
            Ok(Synced::NotFound)
        }
        _ => Ok(Synced::Unreachable),
    }
}

fn reconcile(cache: &MediaCache, manifest: &Manifest, raw: &Value, now: DateTime<Utc>) -> Result<(), MediaError> {
    let write_failed = |_| MediaError::Unavailable("media_cache_write");
    let Some(entry) = cache.entry(&manifest.origin, &manifest.track_id) else {
        return Ok(());
    };
    if entry.sha256 == manifest.sha256 && entry.revision == manifest.revision {
        cache.refresh_entry(manifest, raw, now).map_err(write_failed)
    } else if entry.sha256 == manifest.sha256 && entry.revision < manifest.revision {
        cache.rekey_entry(&entry, manifest, raw, now).map_err(write_failed)
    } else {
        cache.delete_track(&manifest.origin, &manifest.track_id).map(|_| ()).map_err(write_failed)
    }
}

/// 曲の音声を返す。キャッシュ → 元 Hub の Range 取得の順（段階1。P2P は段階2）。
///
/// - YouTube などの Music でない ID は、何も取りに行かずに `Refused`（6章・受け入れ試験6）。
/// - `own_origin` 以外の origin は、設定で許可されているものだけ。
pub async fn media_audio<S: MediaSource>(
    source: &S,
    cache: &MediaCache,
    own_origin: &str,
    origin: &str,
    track_id: &str,
    now: DateTime<Utc>,
) -> Result<Vec<u8>, MediaError> {
    let id = track_uuid(track_id).ok_or(MediaError::Refused("media_track_id"))?;
    let origin = normalize_origin(origin).map_err(|_| MediaError::Refused("media_origin"))?;
    let own = normalize_origin(own_origin).map_err(|_| MediaError::Refused("media_origin"))?;
    if origin != own && !cache.settings().allowed_origins.contains(&origin) {
        return Err(MediaError::Unavailable("media_origin_not_allowed"));
    }

    // 1. 30 分以内に検証済みの完全なキャッシュ。
    if let Some(entry) = cache.entry(&origin, &id) {
        let fresh = read_time(&entry.last_verified_at).is_some_and(|at| now - at <= Duration::minutes(PLAY_FRESH_MINUTES));
        if entry.complete && fresh {
            if let Some(bytes) = play_from_cache(cache, &entry, now) {
                return Ok(bytes);
            }
        }
    }

    // 2. 元 Hub で manifest を取り直す。
    let manifest = match sync_with_origin(source, cache, &origin, &id, now).await? {
        Synced::Valid(manifest) => manifest,
        Synced::Gone => return Err(MediaError::Revoked("media_revoked")),
        Synced::NotFound => return Err(MediaError::Unavailable("media_not_deliverable")),
        Synced::Unreachable => {
            // 6.7: 最後に検証できた時刻から 72 時間までは手元の写しで鳴らす。
            let entry = cache.entry(&origin, &id).filter(|e| e.complete);
            let within = entry
                .as_ref()
                .and_then(|e| read_time(&e.last_verified_at))
                .is_some_and(|at| now - at <= Duration::hours(OFFLINE_GRACE_HOURS));
            return match (entry, within) {
                (Some(entry), true) => play_from_cache(cache, &entry, now).ok_or(MediaError::Unavailable("media_unreachable")),
                (Some(_), false) => Err(MediaError::Unavailable("media_offline_expired")),
                _ => Err(MediaError::Unavailable("media_unreachable")),
            };
        }
    };
    gather(source, cache, &manifest, now).await
}

/// 完全な写しを断片ごとに照合しながら返す。失効表に載る revision は返さない。
fn play_from_cache(cache: &MediaCache, entry: &CacheEntry, now: DateTime<Utc>) -> Option<Vec<u8>> {
    if cache.tombstones().blocks(&entry.origin, &entry.track_id, entry.revision) {
        return None;
    }
    let manifest = cache.stored_manifest(entry)?;
    let bytes = cache.assemble(&manifest)?;
    let _ = cache.update_entry(&entry.origin, &entry.track_id, |e| e.last_played_at = stamp(now));
    Some(bytes)
}

async fn gather<S: MediaSource>(
    source: &S,
    cache: &MediaCache,
    manifest: &Manifest,
    now: DateTime<Utc>,
) -> Result<Vec<u8>, MediaError> {
    if manifest.size > MAX_TRACK_BYTES {
        return Err(MediaError::Unavailable("media_too_large"));
    }
    if cache.entry(&manifest.origin, &manifest.track_id).is_none() {
        let key = entry_key(&manifest.origin, &manifest.track_id);
        cache.reserve(manifest.size, &key).map_err(|_| MediaError::Unavailable("media_quota"))?;
        let raw = {
            // sync が返した manifest をそのまま保存する（署名つきの生の値は呼び出し元で再構成）。
            serde_json::to_value(manifest).map_err(|_| MediaError::Unavailable("media_manifest_invalid"))?
        };
        cache.begin_entry(manifest, &raw, now).map_err(|_| MediaError::Unavailable("media_cache_write"))?;
    }
    let url = format!("{}/music/api/tracks/{}/audio", manifest.origin, manifest.track_id);
    for index in 0..manifest.piece_count() {
        if cache.read_piece(manifest, index).is_some() {
            continue;
        }
        let length = manifest.piece_len(index).ok_or(MediaError::Unavailable("media_manifest_invalid"))? as u64;
        let start = index as u64 * CHUNK_SIZE;
        let mut stored = false;
        // 壊れた断片は捨てて 1 回だけ取り直す。
        for _ in 0..2 {
            let reply = get(source, cache, &url, Some((start, start + length - 1)), CHUNK_SIZE as usize + 1024)
                .await
                .ok_or(MediaError::Unavailable("media_network"))?;
            if reply.status != 206 {
                return Err(MediaError::Unavailable("media_range_unsupported"));
            }
            if cache.put_piece(manifest, index, &reply.body).is_ok() {
                stored = true;
                break;
            }
        }
        if !stored {
            return Err(MediaError::Unavailable("media_piece_rejected"));
        }
    }
    let bytes = cache.assemble(manifest).ok_or(MediaError::Unavailable("media_assemble"))?;
    cache.mark_complete(manifest, now).map_err(|_| MediaError::Unavailable("media_cache_write"))?;
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// 定期保守（起動時と 60 分ごと）
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintainReport {
    pub revocations_applied: u32,
    pub revalidated: u32,
    pub dropped: u32,
    pub unreachable: u32,
    pub purged: u32,
}

/// 失効一覧を `after=<seq>` の差分で読み、検証できた tombstone を適用する。
pub(crate) async fn poll_revocations<S: MediaSource>(
    source: &S,
    cache: &MediaCache,
    origin: &str,
    now: DateTime<Utc>,
    report: &mut MaintainReport,
) {
    for _ in 0..5 {
        let cursor = cache.tombstones().cursor(origin);
        let url = format!("{origin}/music/api/p2p/v1/revocations?after={cursor}&limit=200");
        let Some(body) = get(source, cache, &url, None, MAX_JSON_BYTES).await.filter(|r| r.status == 200).and_then(|r| json_body(&r)) else {
            return;
        };
        let Ok(mut keys) = ensure_keyset(source, cache, origin, now, false).await else {
            return;
        };
        let items = body["items"].as_array().cloned().unwrap_or_default();
        for item in &items {
            let mut verified = verify_tombstone(&keys, item, now);
            if verified == Err("tombstone_unknown_key") {
                if let Ok(fresh) = ensure_keyset(source, cache, origin, now, true).await {
                    keys = fresh;
                    verified = verify_tombstone(&keys, item, now);
                }
            }
            // 検証できないものがあれば、そこで止めて読み位置を進めない。
            let Ok(tombstone) = verified else { return };
            if cache.apply_tombstone(&tombstone, now).unwrap_or(false) {
                report.dropped += 1;
            }
            report.revocations_applied += 1;
        }
        let next = body["next"].as_u64().unwrap_or(cursor);
        if next > cursor {
            let _guard = lock();
            let mut table = cache.tombstones();
            table.set_cursor(origin, next);
            let _ = cache.save_tombstones(&table);
        }
        if items.is_empty() || next <= cursor {
            return;
        }
    }
}

/// 失効一覧の取り込み → 期限の来た曲の再検証 → 30 日未検証の削除。
pub async fn maintain<S: MediaSource>(source: &S, cache: &MediaCache, now: DateTime<Utc>) -> MaintainReport {
    let mut report = MaintainReport { purged: cache.purge_stale(now).len() as u32, ..Default::default() };
    let mut origins: Vec<String> = cache.entries().into_iter().map(|e| e.origin).collect();
    origins.sort();
    origins.dedup();
    for origin in &origins {
        poll_revocations(source, cache, origin, now, &mut report).await;
    }
    let interval = if cache.settings().seed {
        Duration::minutes(SEED_REVALIDATE_MINUTES)
    } else {
        Duration::hours(IDLE_REVALIDATE_HOURS)
    };
    for entry in cache.entries() {
        let due = read_time(&entry.last_verified_at).map(|at| now - at >= interval).unwrap_or(true);
        if !due {
            continue;
        }
        match sync_with_origin(source, cache, &entry.origin, &entry.track_id, now).await {
            Ok(Synced::Valid(_)) => report.revalidated += 1,
            Ok(Synced::Gone | Synced::NotFound) => report.dropped += 1,
            Ok(Synced::Unreachable) | Err(_) => report.unreachable += 1,
        }
    }
    report
}

// ---------------------------------------------------------------------------
// lib.rs から呼ぶコマンド本体（Tauri への登録は主担当）
// ---------------------------------------------------------------------------

pub(crate) async fn command_audio(storage_path: &str, own_origin: &str, origin: &str, track_id: &str) -> Result<Vec<u8>, String> {
    // 取りに行く前に形を確かめる。YouTube の ID は、ディスクにもネットワークにも触れずに断る。
    if track_uuid(track_id).is_none() {
        return Err(MediaError::Refused("media_track_id").to_string());
    }
    let cache = MediaCache::open(storage_path).map_err(|e| MediaError::Unavailable(e).to_string())?;
    let source = HttpSource::new().map_err(|e| MediaError::Unavailable(e).to_string())?;
    media_audio(&source, &cache, own_origin, origin, track_id, Utc::now())
        .await
        .map_err(|e| e.to_string())
}

pub(crate) fn command_settings_get(storage_path: &str) -> Result<MediaP2pSettings, String> {
    Ok(MediaCache::open(storage_path).map_err(String::from)?.settings())
}

pub(crate) fn command_settings_set(storage_path: &str, settings: MediaP2pSettings) -> Result<MediaP2pSettings, String> {
    MediaCache::open(storage_path).map_err(String::from)?.set_settings(settings).map_err(String::from)
}

pub(crate) fn command_clear(storage_path: &str) -> Result<(), String> {
    MediaCache::open(storage_path).map_err(String::from)?.clear_all().map_err(String::from)
}

pub(crate) async fn command_maintain(storage_path: &str) -> Result<MaintainReport, String> {
    let cache = MediaCache::open(storage_path).map_err(String::from)?;
    let source = HttpSource::new().map_err(String::from)?;
    Ok(maintain(&source, &cache, Utc::now()).await)
}

/// 確認書を取り、固定済みの鍵集合で検査して返す（作者の宣言を作る前の読み取り。公開 GET のみ）。
pub(crate) async fn command_attestation(storage_path: &str, origin: &str, track_id: &str) -> Result<Value, String> {
    if crate::media_manifest::track_uuid(track_id).as_deref() != Some(track_id) {
        return Err("media_unavailable:track_id".into());
    }
    let cache = MediaCache::open(storage_path).map_err(String::from)?;
    let source = HttpSource::new().map_err(String::from)?;
    let now = Utc::now();
    let url = format!("{origin}/music/api/p2p/v1/tracks/{track_id}/attestation");
    let reply = get(&source, &cache, &url, None, MAX_JSON_BYTES)
        .await
        .filter(|r| r.status == 200)
        .ok_or("media_unavailable:attestation")?;
    let raw = json_body(&reply).ok_or("media_unavailable:attestation_invalid")?;
    let mut keys = ensure_keyset(&source, &cache, origin, now, false).await.map_err(|_| "media_unavailable:keyset")?;
    let mut result = crate::media_manifest::verify_attestation(&keys, &raw, now);
    if result == Err("attestation_unknown_key") {
        keys = ensure_keyset(&source, &cache, origin, now, true).await.map_err(|_| "media_unavailable:keyset")?;
        result = crate::media_manifest::verify_attestation(&keys, &raw, now);
    }
    let att = result.map_err(|code| format!("media_unavailable:{code}"))?;
    if att.track_id != track_id {
        return Err("media_unavailable:attestation_track".into());
    }
    Ok(raw)
}

/// 試験用の口: メディア層が今まで送った要求の宛先。
pub(crate) fn command_net_log() -> Vec<String> {
    GLOBAL_LOG.get().map(|log| log.lock().unwrap_or_else(|p| p.into_inner()).clone()).unwrap_or_default()
}

/// 使用量と曲数（設定画面の表示用）。
pub(crate) fn command_usage(storage_path: &str) -> Result<(u64, usize), String> {
    let cache = MediaCache::open(storage_path).map_err(String::from)?;
    let entries = cache.entries();
    Ok((entries.iter().map(|e| e.size).sum(), entries.len()))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_manifest::testkit::*;
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    /// Music Worker の代役。署名の仕方は本物と同じ。
    struct FakeOrigin {
        key: SigningKey,
        audio: Vec<u8>,
        state: Mutex<FakeState>,
    }
    struct FakeState {
        revision: u64,
        deliverable: bool,
        final_gone: bool,
        online: bool,
        corrupt_next_piece: bool,
        requests: Vec<String>,
        tombstones: Vec<Value>,
        clock: DateTime<Utc>,
    }

    impl FakeOrigin {
        fn new() -> Self {
            let audio: Vec<u8> = (0..(2 * CHUNK_SIZE as usize + 321)).map(|i| ((i * 31 + 7) & 0xff) as u8).collect();
            Self {
                key: signing_key(1),
                audio,
                state: Mutex::new(FakeState {
                    revision: 3,
                    deliverable: true,
                    final_gone: false,
                    online: true,
                    corrupt_next_piece: false,
                    requests: Vec::new(),
                    tombstones: Vec::new(),
                    clock: now(),
                }),
            }
        }
        fn state(&self) -> MutexGuard<'_, FakeState> {
            self.state.lock().unwrap()
        }
        fn unpublish(&self, reason: &str) {
            let mut s = self.state();
            s.deliverable = false;
            let revision = s.revision;
            s.tombstones.push(tombstone(revision, false, reason, &self.key));
        }
        fn count(&self, needle: &str) -> usize {
            self.state().requests.iter().filter(|r| r.contains(needle)).count()
        }
    }

    impl MediaSource for FakeOrigin {
        async fn get(&self, url: &str, range: Option<(u64, u64)>, _max: usize) -> Result<Reply, &'static str> {
            let mut s = self.state();
            s.requests.push(url.to_owned());
            if !s.online {
                return Err("media_network");
            }
            let path = url.strip_prefix(ORIGIN).unwrap();
            let json = |status: u16, value: Value| Ok(Reply { status, body: serde_json::to_vec(&value).unwrap() });
            if path == "/music/api/p2p/v1/keys" {
                return json(200, default_keyset());
            }
            if path.starts_with("/music/api/p2p/v1/revocations") {
                let after: usize = path.split("after=").nth(1).unwrap().split('&').next().unwrap().parse().unwrap();
                let items: Vec<Value> = s.tombstones.iter().skip(after).cloned().collect();
                let next = s.tombstones.len();
                return json(200, json!({"type": "hub.music.revocations.v1", "origin": ORIGIN, "items": items, "next": next}));
            }
            if path == format!("/music/api/p2p/v1/tracks/{TRACK}/manifest") {
                if s.final_gone || !s.deliverable && !s.tombstones.is_empty() {
                    let latest = s.tombstones.last().cloned().unwrap();
                    return json(410, latest);
                }
                if !s.deliverable {
                    return json(404, json!({"error": "not_found"}));
                }
                let issued = s.clock - Duration::minutes(1);
                return json(200, manifest(&self.audio, s.revision, issued, Duration::hours(6), &self.key));
            }
            if path == format!("/music/api/tracks/{TRACK}/audio") {
                let (start, end) = range.ok_or("no range")?;
                let mut body = self.audio[start as usize..=end as usize].to_vec();
                if s.corrupt_next_piece {
                    s.corrupt_next_piece = false;
                    body[0] ^= 0xff;
                }
                return Ok(Reply { status: 206, body });
            }
            json(404, json!({}))
        }
    }

    fn setup() -> (MediaCache, PathBuf, FakeOrigin) {
        let dir = std::env::temp_dir().join(format!("hub-media-{}", uuid::Uuid::new_v4()));
        let cache = MediaCache::open_with_log(&dir.to_string_lossy(), Arc::new(Mutex::new(Vec::new()))).unwrap();
        (cache, dir, FakeOrigin::new())
    }

    async fn play(cache: &MediaCache, origin: &FakeOrigin, at: DateTime<Utc>) -> Result<Vec<u8>, MediaError> {
        origin.state().clock = at;
        media_audio(origin, cache, ORIGIN, ORIGIN, TRACK, at).await
    }

    fn track_dir(cache: &MediaCache) -> PathBuf {
        cache.track_root(ORIGIN, TRACK)
    }

    fn file_count(dir: &Path) -> usize {
        std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| if e.path().is_dir() { file_count(&e.path()) } else { 1 }).sum()).unwrap_or(0)
    }

    #[tokio::test]
    async fn media_cache_fetches_by_range_verifies_stores_and_plays() {
        let (cache, dir, origin) = setup();
        let bytes = play(&cache, &origin, now()).await.unwrap();
        assert_eq!(bytes, origin.audio);
        assert_eq!(origin.count("/audio"), 3, "one Range request per 512 KiB piece");
        let entry = cache.entry(ORIGIN, TRACK).unwrap();
        assert!(entry.complete && entry.revision == 3);
        assert_eq!(file_count(&track_dir(&cache).join("3").join("chunks")), 3);
        // within 30 minutes: served from cache, no network at all
        let before = origin.state().requests.len();
        assert_eq!(play(&cache, &origin, now() + Duration::minutes(10)).await.unwrap(), origin.audio);
        assert_eq!(origin.state().requests.len(), before);
        // stored beside, not inside, artifacts/published
        assert!(cache.root().ends_with("media-cache"));
        assert!(!dir.join("artifacts").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_rewritten_piece_is_rejected_on_read_and_refetched() {
        let (cache, dir, origin) = setup();
        play(&cache, &origin, now()).await.unwrap();
        let victim = track_dir(&cache).join("3").join("chunks").join("00000001.bin");
        let mut data = std::fs::read(&victim).unwrap();
        data[10] ^= 1;
        std::fs::write(&victim, data).unwrap();
        let before = origin.count("/audio");
        let bytes = play(&cache, &origin, now() + Duration::minutes(1)).await.unwrap();
        assert_eq!(bytes, origin.audio, "corrupted piece never reaches playback");
        assert_eq!(origin.count("/audio") - before, 1, "exactly the damaged piece is refetched");
        assert_eq!(std::fs::read(&victim).unwrap(), origin.audio[CHUNK_SIZE as usize..2 * CHUNK_SIZE as usize]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_corrupt_piece_from_origin_is_discarded_and_refetched() {
        let (cache, dir, origin) = setup();
        origin.state().corrupt_next_piece = true;
        let bytes = play(&cache, &origin, now()).await.unwrap();
        assert_eq!(bytes, origin.audio);
        assert_eq!(origin.count("/audio"), 4, "first piece fetched twice");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_unpublish_then_maintain_deletes_directory() {
        let (cache, dir, origin) = setup();
        play(&cache, &origin, now()).await.unwrap();
        assert!(file_count(&track_dir(&cache)) > 0);
        origin.unpublish("unpublished");
        let report = maintain(&origin, &cache, now() + Duration::minutes(2)).await;
        assert_eq!(report.dropped, 1);
        assert!(!track_dir(&cache).exists());
        assert_eq!(file_count(&track_dir(&cache)), 0);
        assert!(cache.entry(ORIGIN, TRACK).is_none());
        assert!(cache.tombstones().blocks(ORIGIN, TRACK, 3));
        // must not be served from cache any more; origin says 410
        let result = play(&cache, &origin, now() + Duration::minutes(3)).await;
        assert!(matches!(result, Err(MediaError::Revoked(_))), "{result:?}");
        assert!(!result.unwrap_err().allows_http_fallback());
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_revalidation_410_without_revocation_poll_also_deletes() {
        let (cache, dir, origin) = setup();
        play(&cache, &origin, now()).await.unwrap();
        origin.unpublish("hidden");
        // 31 minutes later the cache is no longer fresh; revalidation sees 410
        let result = play(&cache, &origin, now() + Duration::minutes(31)).await;
        assert!(matches!(result, Err(MediaError::Revoked(_))));
        assert!(!track_dir(&cache).exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_404_manifest_deletes_and_allows_http_fallback() {
        let (cache, dir, origin) = setup();
        play(&cache, &origin, now()).await.unwrap();
        origin.state().deliverable = false; // no tombstone recorded: plain 404
        let result = play(&cache, &origin, now() + Duration::minutes(31)).await;
        assert_eq!(result, Err(MediaError::Unavailable("media_not_deliverable")));
        assert!(!track_dir(&cache).exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_republished_revision_survives_old_tombstone() {
        let (cache, dir, origin) = setup();
        play(&cache, &origin, now()).await.unwrap();
        origin.unpublish("unpublished");
        maintain(&origin, &cache, now() + Duration::minutes(2)).await;
        {
            let mut s = origin.state();
            s.deliverable = true;
            s.revision = 4;
            s.tombstones.clear();
            s.final_gone = false;
        }
        let bytes = play(&cache, &origin, now() + Duration::minutes(5)).await.unwrap();
        assert_eq!(bytes, origin.audio);
        assert_eq!(cache.entry(ORIGIN, TRACK).unwrap().revision, 4);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_offline_grace_is_72_hours_and_purge_is_30_days() {
        let (cache, dir, origin) = setup();
        play(&cache, &origin, now()).await.unwrap();
        origin.state().online = false;
        let ok = play(&cache, &origin, now() + Duration::hours(71)).await.unwrap();
        assert_eq!(ok, origin.audio);
        let late = play(&cache, &origin, now() + Duration::hours(73)).await;
        assert_eq!(late, Err(MediaError::Unavailable("media_offline_expired")));
        // unrevalidated for 30+ days: purged even with no tombstone
        let report = maintain(&origin, &cache, now() + Duration::days(31)).await;
        assert_eq!(report.purged, 1);
        assert!(!track_dir(&cache).exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_tombstone_blocks_offline_playback_too() {
        let (cache, dir, origin) = setup();
        play(&cache, &origin, now()).await.unwrap();
        let t = verify_tombstone(&cache.keyset(ORIGIN).unwrap(), &tombstone(3, false, "hidden", &origin.key), now()).unwrap();
        // simulate a tombstone learned elsewhere but whose delete was skipped
        {
            let mut table = cache.tombstones();
            table.record(&t, now());
            cache.save_tombstones(&table).unwrap();
        }
        origin.state().online = false;
        assert!(play(&cache, &origin, now() + Duration::hours(1)).await.is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_youtube_and_non_music_ids_are_refused_without_any_request() {
        let (cache, dir, origin) = setup();
        for id in ["dQw4w9WgXcQ", "ext-123", "", "../../etc/passwd", "https://youtu.be/dQw4w9WgXcQ"] {
            let result = media_audio(&origin, &cache, ORIGIN, ORIGIN, id, now()).await;
            assert!(matches!(result, Err(MediaError::Refused(_))), "{id}");
        }
        assert!(origin.state().requests.is_empty(), "no manifest or audio was requested");
        assert!(cache.net_log().is_empty());
        let message = command_audio(&dir.to_string_lossy(), ORIGIN, ORIGIN, "dQw4w9WgXcQ").await.unwrap_err();
        assert!(message.starts_with("media_refused:"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_other_origins_need_permission_and_keyset_change_stops_p2p() {
        let (cache, dir, origin) = setup();
        let result = media_audio(&origin, &cache, "https://hub.jkamma.com", ORIGIN, TRACK, now()).await;
        assert_eq!(result, Err(MediaError::Unavailable("media_origin_not_allowed")));
        assert!(origin.state().requests.is_empty());
        // pinned keyset differs from what the origin now serves -> stop, nothing cached
        let other = signing_key(5);
        let foreign = KeySet::parse(&keyset(ORIGIN, "2026-10-12T00:00:00.000Z", &[("foreign", &other)], &[("foreign", &other)]), ORIGIN).unwrap();
        cache.save_keyset(&foreign).unwrap();
        let result = play(&cache, &origin, now()).await;
        assert!(matches!(result, Err(MediaError::Unavailable(_))), "{result:?}");
        assert!(cache.entry(ORIGIN, TRACK).is_none());
        assert_eq!(cache.keyset(ORIGIN).unwrap(), foreign, "changed key is not silently re-pinned");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_quota_evicts_least_recently_played_and_refuses_when_full() {
        let (cache, dir, origin) = setup();
        play(&cache, &origin, now()).await.unwrap();
        // fake a few other tracks directly in the index
        for (i, pinned) in [(1, false), (2, true)] {
            let id = format!("00000000-0000-4000-8000-00000000000{i}");
            let mut index = cache.load_index();
            index.entries.insert(entry_key(ORIGIN, &id), CacheEntry {
                origin: ORIGIN.into(), track_id: id.clone(), revision: 1, size: 1024 * 1024 * 1024, sha256: "0".repeat(64),
                last_verified_at: stamp(now()), last_played_at: format!("2026-10-0{i}T00:00:00.000Z"), not_after: stamp(now()), complete: true, pinned,
            });
            cache.save_index(&index).unwrap();
        }
        let mut s = cache.settings();
        s.cache_limit_mib = 2048;
        cache.set_settings(s).unwrap();
        // 1 GiB (unpinned, oldest) + 1 GiB (pinned) + ~1 MiB: asking for 64 MiB evicts the unpinned one only
        cache.reserve(64 * 1024 * 1024, "other").unwrap();
        assert!(cache.entry(ORIGIN, "00000000-0000-4000-8000-000000000001").is_none());
        assert!(cache.entry(ORIGIN, "00000000-0000-4000-8000-000000000002").is_some());
        // the pinned one cannot make room for another 1.5 GiB
        assert_eq!(cache.reserve(1536 * 1024 * 1024, "other"), Err("media_quota"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_settings_default_off_and_tracker_is_never_contacted() {
        let (cache, dir, origin) = setup();
        let settings = cache.settings();
        assert!(!settings.receive_from_peers && !settings.seed && settings.relay_only);
        assert_eq!(settings.cache_limit_mib, 2048);
        assert_eq!(settings.upload_kib_per_sec, 512);
        // full playback + maintenance flow, then inspect every destination we contacted
        play(&cache, &origin, now()).await.unwrap();
        maintain(&origin, &cache, now() + Duration::hours(7)).await;
        assert_eq!(cache.tracker_connect(&format!("{ORIGIN}/swarm/api/v1/mailbox")), Err("p2p_disabled"));
        let log = cache.net_log();
        assert!(!log.is_empty());
        assert!(log.iter().all(|url| url.starts_with(&format!("{ORIGIN}/music/api/"))), "{log:?}");
        assert!(!log.iter().any(|url| url.contains("/swarm/")));
        // enabling either setting is what opens the door (phase 2 uses this guard)
        let mut on = settings.clone();
        on.seed = true;
        on.upload_kib_per_sec = 1; // clamped
        let saved = cache.set_settings(on).unwrap();
        assert_eq!(saved.upload_kib_per_sec, 128);
        assert!(cache.tracker_connect(&format!("{ORIGIN}/swarm/api/v1/mailbox")).is_ok());
        // settings persist across reopen
        let again = MediaCache::open_with_log(&dir.to_string_lossy(), cache.log.clone()).unwrap();
        assert!(again.settings().seed);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn media_cache_clear_all_removes_tracks_but_keeps_settings() {
        let (cache, dir, origin) = setup();
        play(&cache, &origin, now()).await.unwrap();
        let mut s = cache.settings();
        s.receive_from_peers = true;
        cache.set_settings(s).unwrap();
        cache.clear_all().unwrap();
        assert_eq!(file_count(&cache.root().join("tracks")), 0);
        assert!(cache.entries().is_empty());
        assert!(cache.settings().receive_from_peers);
        std::fs::remove_dir_all(dir).ok();
    }
}
