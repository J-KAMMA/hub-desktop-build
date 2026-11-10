//! 端末どうしの音声の受け渡し（docs/hub-p2p-redesign/DESIGN.md §9–§14、docs/hub-distributed-media/DESIGN.md §4–§6）。
//!
//! 通すのは作者が宣言し、フォロー中の作者の集合が認めた曲だけ（`media_declaration::decide`）。
//! 通信の二つの口（群れの Worker = `Tracker`、相手との直接の転送 = `PeerTransport`）は特性にしてあり、
//! 試験では偽物に差し替える。本物の転送は窓の WebRTC（`hub-media-v1`）にあり、窓との橋はまだ無いので
//! アプリでは `Unwired`（`available()` が偽）が入る。その間は群れの Worker にも一切つながず、
//! 断片は元 HTTP（Music の Range）から取って検証・保管するだけになる。
//!
//! 守ること（AGENTS.md）:
//! - 受け取り・配布は別々の任意参加で既定オフ。両方オフなら群れの Worker に触れない（`tracker_connect`）。
//! - 群れは確認書の要約で決まる。peer ID は (端末, 曲, 起動) ごとの乱数で、何からも導かない。
//! - 受け取った断片は確認書の SHA-256 で照合し、合わなければ捨てて、その相手を今回は使わない。
//! - 写しは `media-cache/peer/` に別に置く。Personal Node の原本には混ぜない。
//! - 作者・Music の取り消しで写しを消し、告知をやめる。アプリを閉じれば告知は終わる。

use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::artifact_store::sha256_hex;
use crate::media_cache::{
    ensure_keyset, get, json_body, poll_revocations, write_atomic, HttpSource, MaintainReport, MediaCache, MediaError,
    MediaSource, MAX_JSON_BYTES,
};
use crate::media_declaration::{attestation_digest, decide, kind_limit, music_service, Admitted, Intake};
use crate::media_manifest::{
    normalize_origin, origin_key, track_uuid, verify_tombstone, Attestation, CHUNK_SIZE,
};

type Check<T> = Result<T, &'static str>;

// ---------------------------------------------------------------------------
// 通信の口
// ---------------------------------------------------------------------------

/// 群れの Worker（Media Tracker）。呼ぶ前に必ず `MediaCache::tracker_connect` を通す。
pub trait Tracker: Sync {
    fn peers(&self, swarm: &str, own_peer: &str) -> impl Future<Output = Check<Vec<String>>> + Send;
    fn announce(&self, swarm: &str, own_peer: &str) -> impl Future<Output = Check<()>> + Send;
    fn withdraw(&self, swarm: &str, own_peer: &str) -> impl Future<Output = Check<()>> + Send;
}

/// 相手の端末との直接の転送（`hub-media-v1` のデータチャネル）。
pub trait PeerTransport: Sync {
    /// 実際に相手へ届く経路があるか。偽なら群れの Worker にも触れない。
    fn available(&self) -> bool;
    fn fetch_piece(&self, peer: &str, swarm: &str, index: usize, relay_only: bool) -> impl Future<Output = Check<Vec<u8>>> + Send;
}

/// 窓の WebRTC との橋ができるまでの入れ物。何も運ばず、何もしない。
pub struct Unwired;

impl Tracker for Unwired {
    async fn peers(&self, _: &str, _: &str) -> Check<Vec<String>> {
        Err("tracker_unwired")
    }
    async fn announce(&self, _: &str, _: &str) -> Check<()> {
        Err("tracker_unwired")
    }
    async fn withdraw(&self, _: &str, _: &str) -> Check<()> {
        Err("tracker_unwired")
    }
}

impl PeerTransport for Unwired {
    fn available(&self) -> bool {
        false
    }
    async fn fetch_piece(&self, _: &str, _: &str, _: usize, _: bool) -> Check<Vec<u8>> {
        Err("transport_unwired")
    }
}

// ---------------------------------------------------------------------------
// 群れの識別子と peer ID
// ---------------------------------------------------------------------------

/// 群れは確認書の要約で決まる（曲 ID・版・断片の一覧がそのまま入っている）。origin や作者は入れない。
pub fn swarm_id(attestation: &Value) -> Check<String> {
    let digest = attestation_digest(attestation)?;
    Ok(sha256_hex(format!("hub.media.swarm.v1\n{digest}").as_bytes()))
}

/// 起動ごとの peer ID の表。群れごとに別の乱数で、永続しない。
#[derive(Default)]
pub struct Session {
    ids: Mutex<HashMap<String, String>>,
}

impl Session {
    pub fn peer_id(&self, swarm: &str) -> String {
        let mut ids = self.ids.lock().unwrap_or_else(|p| p.into_inner());
        ids.entry(swarm.to_owned())
            .or_insert_with(|| {
                let mut bytes = [0u8; 16];
                rand::rngs::OsRng.fill_bytes(&mut bytes);
                bytes.iter().map(|b| format!("{b:02x}")).collect()
            })
            .clone()
    }
}

pub fn session() -> &'static Session {
    static SESSION: OnceLock<Session> = OnceLock::new();
    SESSION.get_or_init(Session::default)
}

pub fn seeder() -> &'static Seeder {
    static SEEDER: OnceLock<Seeder> = OnceLock::new();
    SEEDER.get_or_init(Seeder::default)
}

// ---------------------------------------------------------------------------
// 別置きの写し（media-cache/peer/<originKey>/<trackId>/<revision>/）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct StoredTrack {
    pub origin: String,
    pub raw: Value,
    pub attestation: Attestation,
}

#[derive(Serialize, Deserialize)]
struct StoredDoc {
    origin: String,
    attestation: Value,
}

pub struct PeerStore {
    root: PathBuf,
}

impl PeerStore {
    pub fn new(cache: &MediaCache) -> Self {
        Self { root: cache.root().join("peer") }
    }

    fn track_dir(&self, origin: &str, track_id: &str) -> PathBuf {
        self.root.join(origin_key(origin)).join(track_id)
    }

    fn rev_dir(&self, origin: &str, att: &Attestation) -> PathBuf {
        self.track_dir(origin, &att.track_id).join(att.revision.to_string())
    }

    /// 確認書を保存して曲の置き場を作る。別の版の写しは消す。
    pub fn begin(&self, origin: &str, raw: &Value, att: &Attestation) -> Check<()> {
        let dir = self.rev_dir(origin, att);
        if let Ok(read) = std::fs::read_dir(self.track_dir(origin, &att.track_id)) {
            for entry in read.flatten() {
                if entry.path() != dir {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        let bytes = serde_json::to_vec(&StoredDoc { origin: origin.to_owned(), attestation: raw.clone() }).map_err(|_| "cache_write")?;
        write_atomic(&dir.join("attestation.json"), &bytes)
    }

    fn piece_path(&self, origin: &str, att: &Attestation, index: usize) -> PathBuf {
        self.rev_dir(origin, att).join("chunks").join(format!("{index:08}.bin"))
    }

    /// 確認書の SHA-256 に合う断片だけ保存する。
    pub fn put_piece(&self, origin: &str, att: &Attestation, index: usize, bytes: &[u8]) -> Check<()> {
        if !att.verify_piece(index, bytes) {
            return Err("piece_rejected");
        }
        write_atomic(&self.piece_path(origin, att, index), bytes)
    }

    /// 読み出しのたびに照合する。合わない断片は消す。
    pub fn read_piece(&self, origin: &str, att: &Attestation, index: usize) -> Option<Vec<u8>> {
        let path = self.piece_path(origin, att, index);
        let bytes = std::fs::read(&path).ok()?;
        if att.verify_piece(index, &bytes) {
            Some(bytes)
        } else {
            let _ = std::fs::remove_file(&path);
            None
        }
    }

    pub fn assemble(&self, origin: &str, att: &Attestation) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        for index in 0..att.pieces.len() {
            out.extend_from_slice(&self.read_piece(origin, att, index)?);
        }
        Some(out)
    }

    pub fn is_complete(&self, origin: &str, att: &Attestation) -> bool {
        (0..att.pieces.len()).all(|index| self.read_piece(origin, att, index).is_some())
    }

    pub fn delete(&self, origin: &str, track_id: &str) -> Check<bool> {
        let dir = self.track_dir(origin, track_id);
        let existed = dir.exists();
        if existed {
            std::fs::remove_dir_all(&dir).map_err(|_| "cache_delete_failed")?;
            if dir.exists() {
                return Err("cache_delete_failed");
            }
        }
        Ok(existed)
    }

    pub fn tracks(&self) -> Vec<StoredTrack> {
        let mut out = Vec::new();
        let Ok(origins) = std::fs::read_dir(&self.root) else { return out };
        for origin_dir in origins.flatten() {
            let Ok(tracks) = std::fs::read_dir(origin_dir.path()) else { continue };
            for track_dir in tracks.flatten() {
                let Ok(revisions) = std::fs::read_dir(track_dir.path()) else { continue };
                for revision in revisions.flatten() {
                    let Some(doc) = std::fs::read(revision.path().join("attestation.json"))
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<StoredDoc>(&bytes).ok())
                    else {
                        continue;
                    };
                    if let Ok(attestation) = serde_json::from_value::<Attestation>(doc.attestation.clone()) {
                        out.push(StoredTrack { origin: doc.origin, raw: doc.attestation, attestation });
                    }
                }
            }
        }
        out
    }

    pub fn usage_bytes(&self) -> u64 {
        fn walk(dir: &std::path::Path) -> u64 {
            std::fs::read_dir(dir)
                .map(|rd| rd.flatten().map(|e| if e.path().is_dir() { walk(&e.path()) } else { e.metadata().map(|m| m.len()).unwrap_or(0) }).sum())
                .unwrap_or(0)
        }
        walk(&self.root)
    }
}

// ---------------------------------------------------------------------------
// 取り込みの入力と判定
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct Documents {
    pub declarations: Vec<Value>,
    pub tombstones: Vec<Value>,
    pub followed: BTreeSet<String>,
}

/// 固定済みの鍵集合・購読する Music の tombstone・宣言・フォロー中の作者の鍵で `decide` に掛ける。
pub fn admit(cache: &MediaCache, origin: &str, raw: &Value, docs: &Documents, now: DateTime<Utc>) -> Check<Admitted> {
    let keys = cache.keyset(origin).ok_or("intake_no_keyset")?;
    let table = cache.tombstones();
    let service = music_service(origin);
    decide(&Intake {
        origin,
        kind: "audio",
        service: &service,
        max_bytes: kind_limit("audio"),
        keys: &keys,
        service_tombstones: &table,
        attestation: Some(raw),
        declarations: &docs.declarations,
        author_tombstones: &docs.tombstones,
        followed_keys: &docs.followed,
        now,
    })
}

/// 取り消し系の拒否（写しを消し、告知をやめる）。フォローを外した・宣言が無いだけなら消さず、告知だけやめる。
fn revokes(code: &str) -> bool {
    matches!(code, "intake_service_tombstone" | "intake_author_tombstone")
}

// ---------------------------------------------------------------------------
// 配る側の状態（メモリだけ。アプリを閉じれば終わる）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Announced {
    origin: String,
    track_id: String,
    peer_id: String,
}

#[derive(Default)]
pub struct Seeder {
    announced: Mutex<HashMap<String, Announced>>,
}

impl Seeder {
    pub fn count(&self) -> usize {
        self.announced.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    fn holds(&self, swarm: &str) -> bool {
        self.announced.lock().unwrap_or_else(|p| p.into_inner()).contains_key(swarm)
    }

    /// 相手の要求に答える。告知していない群れ、失効した曲、無い断片には答えない。
    pub fn serve(&self, cache: &MediaCache, store: &PeerStore, swarm: &str, index: usize) -> Check<Vec<u8>> {
        let item = self.announced.lock().unwrap_or_else(|p| p.into_inner()).get(swarm).cloned().ok_or("missing")?;
        let stored = store
            .tracks()
            .into_iter()
            .find(|t| t.origin == item.origin && t.attestation.track_id == item.track_id)
            .ok_or("missing")?;
        if cache.tombstones().blocks(&stored.origin, &stored.attestation.track_id, stored.attestation.revision) {
            return Err("revoked");
        }
        store.read_piece(&stored.origin, &stored.attestation, index).ok_or("missing")
    }

    /// アプリを閉じるとき。設定で群れに触れない状態なら、メモリを空にするだけ。
    pub async fn shutdown<T: Tracker>(&self, cache: &MediaCache, tracker: &T) {
        let all: Vec<(String, Announced)> = self.announced.lock().unwrap_or_else(|p| p.into_inner()).drain().collect();
        for (swarm, item) in all {
            if cache.tracker_connect("swarm/withdraw").is_ok() {
                let _ = tracker.withdraw(&swarm, &item.peer_id).await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

pub struct Swarm<'a, S, T, X> {
    pub source: &'a S,
    pub cache: &'a MediaCache,
    pub store: &'a PeerStore,
    pub tracker: &'a T,
    pub transport: &'a X,
    pub session: &'a Session,
    pub seeder: &'a Seeder,
}

enum Attested {
    Doc(Value),
    Gone,
    NotFound,
    Unreachable,
}

impl<S: MediaSource, T: Tracker, X: PeerTransport> Swarm<'_, S, T, X> {
    fn live(&self) -> bool {
        self.transport.available()
    }

    async fn announce(&self, swarm: &str, origin: &str, track_id: &str) {
        if !self.cache.settings().seed || !self.live() || self.seeder.holds(swarm) {
            return;
        }
        if self.cache.tracker_connect("swarm/announce").is_err() {
            return;
        }
        let peer = self.session.peer_id(swarm);
        if self.tracker.announce(swarm, &peer).await.is_ok() {
            self.seeder.announced.lock().unwrap_or_else(|p| p.into_inner()).insert(swarm.to_owned(), Announced { origin: origin.to_owned(), track_id: track_id.to_owned(), peer_id: peer });
        }
    }

    /// 告知をやめる（メモリから外し、群れの Worker へ取り下げを送る）。
    async fn stop_announcing(&self, origin: &str, track_id: &str) {
        let hit: Vec<(String, Announced)> = {
            let mut map = self.seeder.announced.lock().unwrap_or_else(|p| p.into_inner());
            let keys: Vec<String> = map.iter().filter(|(_, a)| a.origin == origin && a.track_id == track_id).map(|(k, _)| k.clone()).collect();
            keys.into_iter().filter_map(|k| map.remove(&k).map(|a| (k, a))).collect()
        };
        for (swarm, item) in hit {
            if self.cache.tracker_connect("swarm/withdraw").is_ok() {
                let _ = self.tracker.withdraw(&swarm, &item.peer_id).await;
            }
        }
    }

    async fn drop_track(&self, origin: &str, track_id: &str) {
        self.stop_announcing(origin, track_id).await;
        let _ = self.store.delete(origin, track_id);
    }

    /// Music から確認書を取る。404/410 は写しを消し、告知をやめる。
    async fn fetch_attestation(&self, origin: &str, track_id: &str, now: DateTime<Utc>) -> Attested {
        let url = format!("{origin}/music/api/p2p/v1/tracks/{track_id}/attestation");
        let Some(reply) = get(self.source, self.cache, &url, None, MAX_JSON_BYTES).await else { return Attested::Unreachable };
        match reply.status {
            200 => json_body(&reply).map(Attested::Doc).unwrap_or(Attested::Unreachable),
            410 => {
                if let (Some(body), Ok(keys)) = (json_body(&reply), ensure_keyset(self.source, self.cache, origin, now, false).await) {
                    let doc = body.get("tombstone").unwrap_or(&body);
                    if let Ok(tombstone) = verify_tombstone(&keys, doc, now) {
                        let _ = self.cache.apply_tombstone(&tombstone, now);
                    }
                }
                self.drop_track(origin, track_id).await;
                Attested::Gone
            }
            404 => {
                self.drop_track(origin, track_id).await;
                Attested::NotFound
            }
            _ => Attested::Unreachable,
        }
    }

    /// 判定。鍵が未知で落ちたら、固定済みの鍵で署名された更新があるときだけ一度読み直す。
    async fn admit_with_refresh(&self, origin: &str, raw: &Value, docs: &Documents, now: DateTime<Utc>) -> Check<Admitted> {
        let first = admit(self.cache, origin, raw, docs, now);
        if first == Err("intake_attestation_invalid") && ensure_keyset(self.source, self.cache, origin, now, true).await.is_ok() {
            return admit(self.cache, origin, raw, docs, now);
        }
        first
    }

    /// 再生。`Ok(None)` は「この経路では扱わない」で、呼び出し側が通常の再生へ進む。
    pub async fn play(&self, docs: &Documents, own_origin: &str, origin: &str, track_id: &str, now: DateTime<Utc>) -> Result<Option<Vec<u8>>, MediaError> {
        let settings = self.cache.settings();
        if !settings.receive_from_peers && !settings.seed {
            return Ok(None); // 両方オフ: 何にも触れない
        }
        let id = track_uuid(track_id).ok_or(MediaError::Refused("media_track_id"))?;
        let origin = normalize_origin(origin).map_err(|_| MediaError::Refused("media_origin"))?;
        let own = normalize_origin(own_origin).map_err(|_| MediaError::Refused("media_origin"))?;
        if origin != own && !settings.allowed_origins.contains(&origin) {
            return Ok(None);
        }
        if ensure_keyset(self.source, self.cache, &origin, now, false).await.is_err() {
            return Ok(None);
        }
        let raw = match self.fetch_attestation(&origin, &id, now).await {
            Attested::Doc(raw) => raw,
            Attested::Gone => return Err(MediaError::Revoked("media_revoked")),
            Attested::NotFound | Attested::Unreachable => return Ok(None),
        };
        let admitted = match self.admit_with_refresh(&origin, &raw, docs, now).await {
            Ok(admitted) => admitted,
            Err(code) => {
                if revokes(code) {
                    self.drop_track(&origin, &id).await;
                }
                return Ok(None);
            }
        };
        let att = admitted.attestation;
        if att.track_id != id {
            return Ok(None);
        }
        let swarm = swarm_id(&raw).map_err(|_| MediaError::Unavailable("media_attestation_invalid"))?;
        let limit = settings.cache_limit_mib * 1024 * 1024;
        let need = att.pieces.len() as u64 * CHUNK_SIZE;
        if self.store.usage_bytes() + need > limit && !self.store.tracks().iter().any(|t| t.origin == origin && t.attestation.track_id == id) {
            return Err(MediaError::Unavailable("media_quota"));
        }
        self.store.begin(&origin, &raw, &att).map_err(|_| MediaError::Unavailable("media_cache_write"))?;

        let own_peer = self.session.peer_id(&swarm);
        let mut peers: Option<Vec<String>> = None;
        let mut bad: BTreeSet<String> = BTreeSet::new();
        let url = format!("{origin}/music/api/tracks/{id}/audio");
        for index in 0..att.pieces.len() {
            if self.store.read_piece(&origin, &att, index).is_some() {
                continue;
            }
            let mut stored = false;
            // 1. 相手から（受け取りが有効で、実際に運べるときだけ。群れの Worker にはここでだけ聞く）。
            if settings.receive_from_peers && self.live() {
                if peers.is_none() {
                    peers = Some(if self.cache.tracker_connect("swarm/peers").is_ok() {
                        self.tracker.peers(&swarm, &own_peer).await.unwrap_or_default()
                    } else {
                        Vec::new()
                    });
                }
                for peer in peers.clone().unwrap_or_default() {
                    if bad.contains(&peer) {
                        continue;
                    }
                    match self.transport.fetch_piece(&peer, &swarm, index, settings.relay_only).await {
                        Ok(bytes) if att.verify_piece(index, &bytes) => {
                            if self.store.put_piece(&origin, &att, index, &bytes).is_ok() {
                                stored = true;
                                break;
                            }
                        }
                        Ok(_) => {
                            bad.insert(peer); // 合わない断片は捨て、この相手は今回は使わない
                        }
                        Err(_) => {}
                    }
                }
            }
            // 2. 足りない断片は Music の Range から（これも同じ SHA-256 で照合）。
            if !stored {
                let start = index as u64 * CHUNK_SIZE;
                for _ in 0..2 {
                    let reply = get(self.source, self.cache, &url, Some((start, start + CHUNK_SIZE - 1)), CHUNK_SIZE as usize + 1024)
                        .await
                        .ok_or(MediaError::Unavailable("media_network"))?;
                    if reply.status != 206 {
                        return Err(MediaError::Unavailable("media_range_unsupported"));
                    }
                    if self.store.put_piece(&origin, &att, index, &reply.body).is_ok() {
                        stored = true;
                        break;
                    }
                }
            }
            if !stored {
                return Err(MediaError::Unavailable("media_piece_rejected"));
            }
        }
        let bytes = self.store.assemble(&origin, &att).ok_or(MediaError::Unavailable("media_assemble"))?;
        self.announce(&swarm, &origin, &id).await;
        Ok(Some(bytes))
    }

    /// 起動時と 60 分ごと: 失効を取り込み、写しを確かめ、通る完全な写しだけ告知する。
    pub async fn maintain(&self, docs: &Documents, now: DateTime<Utc>) -> MaintainReport {
        let mut report = MaintainReport::default();
        let tracks = self.store.tracks();
        let mut origins: Vec<String> = tracks.iter().map(|t| t.origin.clone()).collect();
        origins.sort();
        origins.dedup();
        for origin in &origins {
            poll_revocations(self.source, self.cache, origin, now, &mut report).await;
        }
        for track in tracks {
            let (origin, id) = (track.origin.clone(), track.attestation.track_id.clone());
            if self.cache.tombstones().blocks(&origin, &id, track.attestation.revision) {
                self.drop_track(&origin, &id).await;
                report.dropped += 1;
                continue;
            }
            let raw = match self.fetch_attestation(&origin, &id, now).await {
                Attested::Doc(raw) => raw,
                Attested::Gone | Attested::NotFound => {
                    report.dropped += 1;
                    continue;
                }
                Attested::Unreachable => {
                    report.unreachable += 1;
                    self.stop_announcing(&origin, &id).await; // 確かめられない間は配らない
                    continue;
                }
            };
            report.revalidated += 1;
            match self.admit_with_refresh(&origin, &raw, docs, now).await {
                Ok(admitted) => {
                    if admitted.attestation.revision != track.attestation.revision {
                        self.drop_track(&origin, &id).await; // 新しい版は取り直す
                        report.dropped += 1;
                    } else if self.store.is_complete(&origin, &track.attestation) {
                        if let Ok(swarm) = swarm_id(&raw) {
                            self.announce(&swarm, &origin, &id).await;
                        }
                    }
                }
                Err(code) => {
                    if revokes(code) {
                        self.drop_track(&origin, &id).await;
                        report.dropped += 1;
                    } else {
                        self.stop_announcing(&origin, &id).await;
                    }
                }
            }
        }
        report
    }
}

// ---------------------------------------------------------------------------
// コマンドの口（lib.rs から）
// ---------------------------------------------------------------------------

/// 端末内の宣言と、フォロー中の作者の鍵から入力を組む。
pub fn documents(storage: &str, followed: BTreeSet<String>) -> Documents {
    let store = crate::media_declaration::LocalStore::load(storage);
    let (declarations, tombstones) = crate::media_declaration_net::intake_documents(&store);
    Documents { declarations, tombstones, followed }
}

/// 再生の口。受け取りも配布もオフ、または通らない曲なら `Ok(None)`（通常の再生へ）。
pub(crate) async fn command_audio(storage: &str, own_origin: &str, origin: &str, track_id: &str, hub_base: &str) -> Result<Option<Vec<u8>>, String> {
    let cache = MediaCache::open(storage).map_err(String::from)?;
    let settings = cache.settings();
    if !settings.receive_from_peers && !settings.seed {
        return Ok(None);
    }
    let followed = crate::media_declaration_net::followed_keys(hub_base, false).await.unwrap_or_default();
    let docs = documents(storage, followed);
    let source = HttpSource::new().map_err(String::from)?;
    let store = PeerStore::new(&cache);
    let swarm = Swarm { source: &source, cache: &cache, store: &store, tracker: &Unwired, transport: &Unwired, session: session(), seeder: seeder() };
    match swarm.play(&docs, own_origin, origin, track_id, Utc::now()).await {
        Ok(found) => Ok(found),
        Err(MediaError::Unavailable(_)) => Ok(None),
        Err(other) => Err(other.to_string()),
    }
}


/// 試験の補助: 群れに送る本文は swarm と peerId だけ。
#[allow(dead_code)]
pub fn tracker_body(swarm: &str, peer: &str) -> Value {
    json!({ "swarm": swarm, "peerId": peer })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_cache::{MediaP2pSettings, Reply};
    use crate::media_declaration::{declaration_statement, tombstone_statement, verify_declaration};
    use crate::media_manifest::testkit::*;
    use crate::node_identity::NodeKey;
    use crate::portable_identity::{did_key_from_jwk, sign_document};
    use ed25519_dalek::SigningKey;
    use std::path::PathBuf;
    use std::sync::Arc;

    const SIGNED_AT: &str = "2026-10-12T03:30:00.000Z";

    /// Music Worker の代役。確認書・鍵集合・Range・失効一覧を返す。
    struct FakeMusic {
        key: SigningKey,
        audio: Vec<u8>,
        state: Mutex<MusicState>,
    }
    struct MusicState {
        revision: u64,
        status: u16, // 確認書の応答（200 / 404 / 410）
        tombstones: Vec<Value>,
        requests: Vec<String>,
        corrupt_range: bool,
    }

    impl FakeMusic {
        fn new() -> Self {
            let audio: Vec<u8> = (0..(2 * CHUNK_SIZE as usize + 321)).map(|i| ((i * 31 + 7) & 0xff) as u8).collect();
            Self { key: signing_key(1), audio, state: Mutex::new(MusicState { revision: 3, status: 200, tombstones: Vec::new(), requests: Vec::new(), corrupt_range: false }) }
        }
        fn st(&self) -> std::sync::MutexGuard<'_, MusicState> {
            self.state.lock().unwrap()
        }
        fn pieces(&self) -> Vec<&[u8]> {
            self.audio.chunks(CHUNK_SIZE as usize).collect()
        }
        fn attestation(&self) -> Value {
            attestation(TRACK, self.st().revision, &self.pieces(), &self.key)
        }
        fn count(&self, needle: &str) -> usize {
            self.st().requests.iter().filter(|r| r.contains(needle)).count()
        }
    }

    impl MediaSource for FakeMusic {
        async fn get(&self, url: &str, range: Option<(u64, u64)>, _max: usize) -> Result<Reply, &'static str> {
            self.st().requests.push(url.to_owned());
            let path = url.strip_prefix(ORIGIN).unwrap();
            let json = |status: u16, value: Value| Ok(Reply { status, body: serde_json::to_vec(&value).unwrap() });
            if path == "/music/api/p2p/v1/keys" {
                return json(200, default_keyset());
            }
            if path.starts_with("/music/api/p2p/v1/revocations") {
                let after: usize = path.split("after=").nth(1).unwrap().split('&').next().unwrap().parse().unwrap();
                let s = self.st();
                let items: Vec<Value> = s.tombstones.iter().skip(after).cloned().collect();
                return json(200, json!({"type": "hub.music.revocations.v1", "origin": ORIGIN, "items": items, "next": s.tombstones.len()}));
            }
            if path == format!("/music/api/p2p/v1/tracks/{TRACK}/attestation") {
                let status = self.st().status;
                return match status {
                    200 => json(200, self.attestation()),
                    410 => json(410, self.st().tombstones.last().cloned().unwrap_or(json!({}))),
                    other => json(other, json!({"error": "not_found"})),
                };
            }
            if path == format!("/music/api/tracks/{TRACK}/audio") {
                let (start, end) = range.ok_or("no range")?;
                let end = (end as usize).min(self.audio.len() - 1);
                let mut body = self.audio[start as usize..=end].to_vec();
                if self.st().corrupt_range {
                    body[0] ^= 0xff;
                }
                return Ok(Reply { status: 206, body });
            }
            json(404, json!({}))
        }
    }

    #[derive(Default)]
    struct FakeTracker {
        calls: Mutex<Vec<String>>,
        peers: Mutex<Vec<String>>,
    }
    impl FakeTracker {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }
    impl Tracker for FakeTracker {
        async fn peers(&self, _swarm: &str, _own: &str) -> Check<Vec<String>> {
            self.calls.lock().unwrap().push("peers".into());
            Ok(self.peers.lock().unwrap().clone())
        }
        async fn announce(&self, swarm: &str, own: &str) -> Check<()> {
            self.calls.lock().unwrap().push(format!("announce:{swarm}:{own}"));
            Ok(())
        }
        async fn withdraw(&self, swarm: &str, own: &str) -> Check<()> {
            self.calls.lock().unwrap().push(format!("withdraw:{swarm}:{own}"));
            Ok(())
        }
    }

    /// 相手の端末の代役。peer ごとに「正しい曲を返す」「壊して返す」「答えない」を決める。
    struct FakeTransport {
        online: bool,
        audio: Vec<u8>,
        behaviour: Mutex<HashMap<String, &'static str>>,
        served: Mutex<Vec<(String, usize)>>,
        relay_flags: Mutex<Vec<bool>>,
    }
    impl FakeTransport {
        fn new(audio: &[u8], online: bool) -> Self {
            Self { online, audio: audio.to_vec(), behaviour: Mutex::new(HashMap::new()), served: Mutex::new(Vec::new()), relay_flags: Mutex::new(Vec::new()) }
        }
        fn set(&self, peer: &str, how: &'static str) {
            self.behaviour.lock().unwrap().insert(peer.to_owned(), how);
        }
    }
    impl PeerTransport for FakeTransport {
        fn available(&self) -> bool {
            self.online
        }
        async fn fetch_piece(&self, peer: &str, _swarm: &str, index: usize, relay_only: bool) -> Check<Vec<u8>> {
            self.served.lock().unwrap().push((peer.to_owned(), index));
            self.relay_flags.lock().unwrap().push(relay_only);
            let how = self.behaviour.lock().unwrap().get(peer).copied().unwrap_or("good");
            let start = index * CHUNK_SIZE as usize;
            let end = (start + CHUNK_SIZE as usize).min(self.audio.len());
            let mut piece = self.audio[start..end].to_vec();
            match how {
                "good" => Ok(piece),
                "corrupt" => {
                    piece[0] ^= 0xff;
                    Ok(piece)
                }
                _ => Err("peer_silent"),
            }
        }
    }

    struct World {
        cache: MediaCache,
        dir: PathBuf,
        music: FakeMusic,
        tracker: FakeTracker,
        author: NodeKey,
        did: String,
    }

    fn world() -> World {
        let dir = std::env::temp_dir().join(format!("hub-swarm-{}", uuid::Uuid::new_v4()));
        let cache = MediaCache::open_with_log(&dir.to_string_lossy(), Arc::new(Mutex::new(Vec::new()))).unwrap();
        let author = NodeKey::create();
        let did = did_key_from_jwk(&author.public_jwk()).unwrap();
        World { cache, dir, music: FakeMusic::new(), tracker: FakeTracker::default(), author, did }
    }

    fn settings(w: &World, receive: bool, seed: bool) {
        w.cache.set_settings(MediaP2pSettings { receive_from_peers: receive, seed, ..Default::default() }).unwrap();
    }

    fn sign(w: &World, statement: Value) -> Value {
        sign_document(&|data| Some(w.author.sign_bytes(data)), &w.did, statement, SIGNED_AT).unwrap()
    }

    fn declaration(w: &World) -> Value {
        let att = w.music.attestation();
        sign(w, declaration_statement("audio", &music_service(ORIGIN), TRACK, w.music.st().revision, &attestation_digest(&att).unwrap(), &w.did, SIGNED_AT))
    }

    fn docs(w: &World, followed: bool) -> Documents {
        Documents { declarations: vec![declaration(w)], tombstones: vec![], followed: if followed { BTreeSet::from([w.did.clone()]) } else { BTreeSet::new() } }
    }

    fn engine<'a>(w: &'a World, transport: &'a FakeTransport, store: &'a PeerStore, session: &'a Session, seeder: &'a Seeder) -> Swarm<'a, FakeMusic, FakeTracker, FakeTransport> {
        Swarm { source: &w.music, cache: &w.cache, store, tracker: &w.tracker, transport, session, seeder }
    }

    fn clean(w: &World) {
        let _ = std::fs::remove_dir_all(&w.dir);
    }

    #[tokio::test]
    async fn both_settings_off_means_no_request_of_any_kind() {
        let w = world();
        let t = FakeTransport::new(&w.music.audio, true);
        let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
        let result = engine(&w, &t, &store, &session, &seeder).play(&docs(&w, true), ORIGIN, ORIGIN, TRACK, now()).await;
        assert_eq!(result, Ok(None));
        assert!(w.music.st().requests.is_empty(), "not even Music is asked");
        assert!(w.tracker.calls().is_empty(), "the Media Tracker is never contacted");
        assert!(t.served.lock().unwrap().is_empty());
        assert_eq!(w.cache.tracker_connect("swarm/peers"), Err("p2p_disabled"));
        assert!(w.cache.net_log().iter().all(|u| !u.contains("swarm")));
        // 保守も同じ。
        let report = engine(&w, &t, &store, &session, &seeder).maintain(&docs(&w, true), now()).await;
        assert_eq!(report, MaintainReport::default());
        assert!(w.tracker.calls().is_empty());
        clean(&w);
    }

    #[tokio::test]
    async fn receive_admitted_track_from_peer_verifies_stores_and_never_touches_http_audio() {
        let w = world();
        settings(&w, true, false);
        *w.tracker.peers.lock().unwrap() = vec!["peer-a".into()];
        let t = FakeTransport::new(&w.music.audio, true);
        let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
        let bytes = engine(&w, &t, &store, &session, &seeder).play(&docs(&w, true), ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
        assert_eq!(bytes, w.music.audio);
        assert_eq!(w.music.count("/audio"), 0, "all three pieces came from the peer");
        assert_eq!(t.served.lock().unwrap().len(), 3);
        assert_eq!(w.tracker.calls(), vec!["peers".to_string()], "receive-only: no announce");
        assert_eq!(*t.relay_flags.lock().unwrap(), vec![true, true, true], "relay-only default is honoured");
        // 別置きの写しに入り、Personal Node の保管先の artifacts には何も作らない。
        assert!(store.tracks().len() == 1 && w.dir.join("media-cache").join("peer").exists());
        assert!(!w.dir.join("artifacts").exists());
        clean(&w);
    }

    #[tokio::test]
    async fn relay_only_off_is_passed_to_the_transport() {
        let w = world();
        w.cache.set_settings(MediaP2pSettings { receive_from_peers: true, relay_only: false, ..Default::default() }).unwrap();
        *w.tracker.peers.lock().unwrap() = vec!["peer-a".into()];
        let t = FakeTransport::new(&w.music.audio, true);
        let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
        engine(&w, &t, &store, &session, &seeder).play(&docs(&w, true), ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
        assert!(t.relay_flags.lock().unwrap().iter().all(|r| !r));
        clean(&w);
    }

    #[tokio::test]
    async fn refused_tracks_are_not_swarmed_and_make_no_tracker_call() {
        for (name, followed, mutate) in [("not followed", false, 0), ("author tombstone", true, 1), ("no declaration", true, 2)] {
            let w = world();
            settings(&w, true, true);
            let t = FakeTransport::new(&w.music.audio, true);
            let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
            let mut d = docs(&w, followed);
            match mutate {
                1 => {
                    let declared = verify_declaration(&d.declarations[0]).unwrap();
                    d.tombstones.push(sign(&w, tombstone_statement(&declared, &w.did, SIGNED_AT)));
                }
                2 => d.declarations.clear(),
                _ => {}
            }
            let result = engine(&w, &t, &store, &session, &seeder).play(&d, ORIGIN, ORIGIN, TRACK, now()).await;
            assert_eq!(result, Ok(None), "{name}");
            assert_eq!(w.music.count("/audio"), 0, "{name}: no audio bytes fetched");
            assert!(w.tracker.calls().is_empty(), "{name}");
            assert!(store.tracks().is_empty(), "{name}");
            clean(&w);
        }
    }

    #[tokio::test]
    async fn music_tombstone_refuses_and_a_mismatched_piece_is_discarded_and_the_peer_dropped() {
        let w = world();
        settings(&w, true, false);
        *w.tracker.peers.lock().unwrap() = vec!["liar".into(), "honest".into()];
        let t = FakeTransport::new(&w.music.audio, true);
        t.set("liar", "corrupt");
        let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
        let bytes = engine(&w, &t, &store, &session, &seeder).play(&docs(&w, true), ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
        assert_eq!(bytes, w.music.audio, "the corrupt piece never reached the file");
        let served = t.served.lock().unwrap().clone();
        assert_eq!(served.iter().filter(|(p, _)| p == "liar").count(), 1, "the liar is asked once and then not used again");
        assert_eq!(served.iter().filter(|(p, _)| p == "honest").count(), 3);
        // Music の tombstone を購読表に入れると、同じ曲は通らなくなる。
        let keys = w.cache.keyset(ORIGIN).unwrap();
        let tomb = verify_tombstone(&keys, &tombstone(3, false, "hidden", &signing_key(1)), now()).unwrap();
        w.cache.apply_tombstone(&tomb, now()).unwrap();
        let again = engine(&w, &t, &store, &session, &seeder).play(&docs(&w, true), ORIGIN, ORIGIN, TRACK, now()).await;
        assert_eq!(again, Ok(None));
        assert!(store.tracks().is_empty(), "Music tombstone deleted the stored copy");
        clean(&w);
    }

    #[tokio::test]
    async fn missing_pieces_fall_back_to_http_and_are_verified_there_too() {
        let w = world();
        settings(&w, true, false);
        *w.tracker.peers.lock().unwrap() = vec!["silent".into()];
        let t = FakeTransport::new(&w.music.audio, true);
        t.set("silent", "silent");
        let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
        let bytes = engine(&w, &t, &store, &session, &seeder).play(&docs(&w, true), ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
        assert_eq!(bytes, w.music.audio);
        assert_eq!(w.music.count("/audio"), 3, "every piece fell back to the Music Worker Range");
        // HTTP 側が壊れた断片を返しても受け入れない。
        let w2 = world();
        settings(&w2, true, false);
        w2.music.st().corrupt_range = true;
        let t2 = FakeTransport::new(&w2.music.audio, false);
        let (store2, session2, seeder2) = (PeerStore::new(&w2.cache), Session::default(), Seeder::default());
        let failed = engine(&w2, &t2, &store2, &session2, &seeder2).play(&docs(&w2, true), ORIGIN, ORIGIN, TRACK, now()).await;
        assert_eq!(failed, Err(MediaError::Unavailable("media_piece_rejected")));
        clean(&w);
        clean(&w2);
    }

    #[tokio::test]
    async fn seeding_announces_only_admitted_complete_tracks_with_a_random_per_session_peer_id() {
        let w = world();
        settings(&w, false, true);
        let t = FakeTransport::new(&w.music.audio, true);
        let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
        let d = docs(&w, true);
        engine(&w, &t, &store, &session, &seeder).play(&d, ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
        let calls = w.tracker.calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        let swarm = swarm_id(&w.music.attestation()).unwrap();
        let peer = session.peer_id(&swarm);
        assert_eq!(calls[0], format!("announce:{swarm}:{peer}"));
        assert_eq!(peer.len(), 32);
        assert!(!calls[0].contains(TRACK) && !calls[0].contains(&w.did) && !calls[0].contains("127.0.0.1"), "swarm carries no track id, author or origin");
        assert_ne!(Session::default().peer_id(&swarm), peer, "a new app session gets a new peer id");
        assert_ne!(session.peer_id("other-swarm"), peer, "another swarm gets another peer id");
        assert_eq!(seeder.count(), 1);
        // 相手の要求に答える。告知していない群れには答えない。
        assert_eq!(seeder.serve(&w.cache, &store, &swarm, 1).unwrap(), w.music.pieces()[1]);
        assert_eq!(seeder.serve(&w.cache, &store, "nope", 0), Err("missing"));
        // 再度の再生・保守では二重に告知しない。
        engine(&w, &t, &store, &session, &seeder).maintain(&d, now()).await;
        assert_eq!(w.tracker.calls().iter().filter(|c| c.starts_with("announce")).count(), 1);
        // 受け取りだけの設定、または運べない状態では告知しない。
        let w2 = world();
        settings(&w2, true, false);
        let t2 = FakeTransport::new(&w2.music.audio, true);
        let (s2, se2, sd2) = (PeerStore::new(&w2.cache), Session::default(), Seeder::default());
        engine(&w2, &t2, &s2, &se2, &sd2).play(&docs(&w2, true), ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
        assert!(w2.tracker.calls().iter().all(|c| !c.starts_with("announce")));
        let w3 = world();
        settings(&w3, false, true);
        let t3 = FakeTransport::new(&w3.music.audio, false);
        let (s3, se3, sd3) = (PeerStore::new(&w3.cache), Session::default(), Seeder::default());
        engine(&w3, &t3, &s3, &se3, &sd3).play(&docs(&w3, true), ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
        assert!(w3.tracker.calls().is_empty(), "unwired transport: the tracker is left alone");
        clean(&w);
        clean(&w2);
        clean(&w3);
    }

    #[tokio::test]
    async fn music_unpublish_or_410_deletes_the_cache_and_stops_seeding() {
        for status in [404u16, 410] {
            let w = world();
            settings(&w, false, true);
            let t = FakeTransport::new(&w.music.audio, true);
            let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
            let d = docs(&w, true);
            engine(&w, &t, &store, &session, &seeder).play(&d, ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
            assert_eq!((store.tracks().len(), seeder.count()), (1, 1));
            if status == 410 {
                let tomb = tombstone(3, false, "unpublished", &signing_key(1));
                w.music.st().tombstones.push(tomb);
            }
            w.music.st().status = status;
            let report = engine(&w, &t, &store, &session, &seeder).maintain(&d, now()).await;
            assert!(report.dropped >= 1, "{status}: {report:?}");
            assert!(store.tracks().is_empty(), "{status}: cached pieces deleted");
            assert_eq!(seeder.count(), 0, "{status}: no longer announced");
            assert!(w.tracker.calls().iter().any(|c| c.starts_with("withdraw")), "{status}: tracker told to withdraw");
            assert!(!w.dir.join("media-cache").join("peer").join(origin_key(ORIGIN)).join(TRACK).exists());
            assert_eq!(seeder.serve(&w.cache, &store, &swarm_id(&w.music.attestation()).unwrap(), 0), Err("missing"));
            clean(&w);
        }
    }

    #[tokio::test]
    async fn author_tombstone_deletes_and_unfollowing_only_stops_announcing() {
        let w = world();
        settings(&w, false, true);
        let t = FakeTransport::new(&w.music.audio, true);
        let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
        let mut d = docs(&w, true);
        engine(&w, &t, &store, &session, &seeder).play(&d, ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
        // フォローを外した: 告知をやめるが、写しは残す。
        let unfollowed = Documents { followed: BTreeSet::new(), ..d.clone() };
        engine(&w, &t, &store, &session, &seeder).maintain(&unfollowed, now()).await;
        assert_eq!((store.tracks().len(), seeder.count()), (1, 0));
        // 作者が取り消した: 写しを消す。
        let declared = verify_declaration(&d.declarations[0]).unwrap();
        d.tombstones.push(sign(&w, tombstone_statement(&declared, &w.did, SIGNED_AT)));
        engine(&w, &t, &store, &session, &seeder).maintain(&d, now()).await;
        assert!(store.tracks().is_empty());
        clean(&w);
    }

    #[tokio::test]
    async fn shutdown_withdraws_everything_and_serving_stops_on_a_tombstone() {
        let w = world();
        settings(&w, false, true);
        let t = FakeTransport::new(&w.music.audio, true);
        let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
        engine(&w, &t, &store, &session, &seeder).play(&docs(&w, true), ORIGIN, ORIGIN, TRACK, now()).await.unwrap().unwrap();
        let swarm = swarm_id(&w.music.attestation()).unwrap();
        // 失効表に載れば、まだ告知中でも断片は出さない。
        let keys = w.cache.keyset(ORIGIN).unwrap();
        w.cache.apply_tombstone(&verify_tombstone(&keys, &tombstone(3, false, "hidden", &signing_key(1)), now()).unwrap(), now()).unwrap();
        assert_eq!(seeder.serve(&w.cache, &store, &swarm, 0), Err("revoked"));
        seeder.shutdown(&w.cache, &w.tracker).await;
        assert_eq!(seeder.count(), 0);
        assert!(w.tracker.calls().last().unwrap().starts_with("withdraw"));
        clean(&w);
    }

    #[tokio::test]
    async fn other_origins_need_permission_and_youtube_ids_are_refused() {
        let w = world();
        settings(&w, true, true);
        let t = FakeTransport::new(&w.music.audio, true);
        let (store, session, seeder) = (PeerStore::new(&w.cache), Session::default(), Seeder::default());
        let e = engine(&w, &t, &store, &session, &seeder);
        assert_eq!(e.play(&docs(&w, true), "https://hub.jkamma.com", ORIGIN, TRACK, now()).await, Ok(None));
        assert!(w.music.st().requests.is_empty());
        assert_eq!(e.play(&docs(&w, true), ORIGIN, ORIGIN, "dQw4w9WgXcQ", now()).await, Err(MediaError::Refused("media_track_id")));
        assert!(w.music.st().requests.is_empty() && w.tracker.calls().is_empty());
        clean(&w);
    }

    #[test]
    fn clear_all_also_removes_the_peer_copies_and_tracker_body_has_no_identity() {
        let w = world();
        let store = PeerStore::new(&w.cache);
        let raw = w.music.attestation();
        let att: Attestation = serde_json::from_value(raw.clone()).unwrap();
        store.begin(ORIGIN, &raw, &att).unwrap();
        store.put_piece(ORIGIN, &att, 0, w.music.pieces()[0]).unwrap();
        assert_eq!(store.put_piece(ORIGIN, &att, 1, b"wrong"), Err("piece_rejected"));
        assert!(store.usage_bytes() > 0);
        w.cache.clear_all().unwrap();
        assert!(store.tracks().is_empty());
        let body = tracker_body("s", "p").to_string();
        assert!(!body.contains("ip") && !body.contains("sdp") && !body.contains("profile") && !body.contains("trackId"));
        clean(&w);
    }
}
