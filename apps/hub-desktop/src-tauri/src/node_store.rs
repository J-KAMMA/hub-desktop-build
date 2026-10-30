use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::node_log::{build_event, event_hash};
use chrono::{SecondsFormat, Utc};

/// このノードが持つ原本と、その連なり。
///
/// Personal Node は「公開原本を保管して配信する」側（docs/HUB_PROTOCOL.md）。
/// **原本はここにある。** ゲートウェイへ送るのは署名付きの出来事で、原本そのもの
/// ではない。ハブが消えても、持ち主の手元には残る。
///
/// 連鎖の位置（次の番号と前のhash）は**必ず1つ**でなければならない。二重に
/// 採番すると、ゲートウェイはどちらか一方しか受け取らず、落ちたほうは黙って
/// 消える。だから位置はファイルに持ち、書いてから送る。

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChainState {
    /// 次に出す番号。最初は1。
    pub next_sequence: u64,
    /// 直前の出来事の hash。最初は無い。
    pub previous_hash: Option<String>,
    /// まだ送れていない出来事の数。
    pub pending: u64,
}

impl ChainState {
    pub fn start() -> Self {
        Self {
            next_sequence: 1,
            previous_hash: None,
            pending: 0,
        }
    }
}

pub struct NodeStore {
    root: PathBuf,
}

/// One interrupted queue decrement. No event body or independent delivery history.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryCommit { version:u8, sequence:u64, hash:String, before:ChainState, after:ChainState }

/// 出来事1つと、その署名。送る前も後もこの形で残す。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub sequence: u64,
    pub hash: String,
    pub event: Value,
    pub signature: String,
    /// ゲートウェイが受け取ったか。**送れていないものを消さない。**
    pub delivered: bool,
}

impl NodeStore {
    pub fn open_readonly(storage_path: &str) -> Result<Self, &'static str> {
        if storage_path.is_empty() { return Err("node_storage_unavailable"); }
        Ok(Self { root: PathBuf::from(storage_path) })
    }

    pub fn read_bounded(&self, sequence: u64) -> Result<Option<StoredEvent>, &'static str> {
        read_bounded_json(&self.event_path(sequence), 2 * 1024 * 1024)
    }

    pub fn chain_bounded(&self) -> Result<ChainState, &'static str> {
        let chain = match read_bounded_json::<ChainState>(&self.chain_path(), 64 * 1024)? {
            Some(chain) => chain,
            None => {
                let has_events = match std::fs::read_dir(self.root.join("events")) {
                    Ok(mut entries) => entries.next().is_some(),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                    Err(_) => return Err("node_record_unavailable"),
                };
                if has_events { return Err("node_record_invalid"); }
                ChainState::start()
            }
        };
        if chain.next_sequence == 0 || chain.next_sequence > 9_007_199_254_740_992
            || chain.pending > chain.next_sequence - 1 { return Err("node_record_invalid"); }
        Ok(chain)
    }

    pub fn read_receipt_bounded<T: for<'de> Deserialize<'de>>(&self, id: &str) -> Result<Option<T>, &'static str> {
        read_bounded_json(&self.safe_record_path("receipts", id)?, 16 * 1024)
    }

    pub fn open(storage_path: &str) -> Result<Self, &'static str> {
        let root = PathBuf::from(storage_path);
        std::fs::create_dir_all(root.join("events")).map_err(|_| "保管先を作れません")?;
        std::fs::create_dir_all(root.join("previews")).map_err(|_| "保管先を作れません")?;
        std::fs::create_dir_all(root.join("receipts")).map_err(|_| "保管先を作れません")?;
        Ok(Self { root })
    }

    fn chain_path(&self) -> PathBuf {
        self.root.join("chain.json")
    }

    pub fn chain(&self) -> ChainState {
        std::fs::read(self.chain_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_else(ChainState::start)
    }

    /// 出来事を1つ足す。
    ///
    /// **署名してから、位置を進めて、書く。** 途中で落ちても、書けていなければ
    /// 番号は進まない。逆順にすると、番号だけ進んで中身の無い穴ができる。
    pub fn append(
        &self,
        kind: &str,
        payload: Value,
        sign: impl FnOnce(&str) -> Option<String>,
    ) -> Result<StoredEvent, &'static str> {
        self.recover_pending_delivery()?;
        let chain = self.chain_bounded()?;
        let event_id = format!("event:{}", uuid::Uuid::new_v4().simple());
        let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let event = build_event(
            &event_id,
            kind,
            chain.next_sequence,
            chain.previous_hash.as_deref(),
            payload,
            &created_at,
        );
        let hash = event_hash(&event);
        let signature = sign(&crate::node_log::canonical_json(&event)).ok_or("署名できません")?;

        let stored = StoredEvent {
            sequence: chain.next_sequence,
            hash: hash.clone(),
            event,
            signature,
            delivered: false,
        };
        write_atomic(&self.event_path(chain.next_sequence), &stored)?;
        write_atomic(
            &self.chain_path(),
            &ChainState {
                next_sequence: chain.next_sequence + 1,
                previous_hash: Some(hash),
                pending: chain.pending + 1,
            },
        )?;
        Ok(stored)
    }

    fn safe_record_path(&self, directory: &str, id: &str) -> Result<PathBuf, &'static str> {
        if id.len() < 8
            || id.len() > 100
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err("識別子が不正です");
        }
        Ok(self.root.join(directory).join(format!("{id}.json")))
    }

    pub fn save_preview<T: Serialize>(&self, id: &str, value: &T) -> Result<(), &'static str> {
        write_atomic(&self.safe_record_path("previews", id)?, value)
    }

    pub fn read_preview<T: for<'de> Deserialize<'de>>(&self, id: &str) -> Option<T> {
        let path = self.safe_record_path("previews", id).ok()?;
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    pub fn save_receipt<T: Serialize>(&self, id: &str, value: &T) -> Result<(), &'static str> {
        write_atomic(&self.safe_record_path("receipts", id)?, value)
    }

    pub fn has_receipt(&self, id: &str) -> Result<bool, &'static str> {
        self.safe_record_path("receipts", id)?.try_exists().map_err(|_| "記録を確認できません")
    }

    pub fn read_receipt<T: for<'de> Deserialize<'de>>(&self, id: &str) -> Option<T> {
        let path = self.safe_record_path("receipts", id).ok()?;
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    fn event_path(&self, sequence: u64) -> PathBuf {
        // 番号で並ぶように0埋めする。人が眺めるときに順番が読める。
        self.root
            .join("events")
            .join(format!("{sequence:012}.json"))
    }

    pub fn read(&self, sequence: u64) -> Option<StoredEvent> {
        let bytes = std::fs::read(self.event_path(sequence)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// まだ送れていないものを、古い順に。
    pub fn undelivered(&self, limit: usize) -> Vec<StoredEvent> {
        let chain = self.chain();
        let mut found = Vec::new();
        for sequence in 1..chain.next_sequence {
            if found.len() >= limit {
                break;
            }
            if let Some(stored) = self.read(sequence) {
                if !stored.delivered {
                    found.push(stored);
                }
            }
        }
        found
    }

    /// receipt保存直前にプロセスが落ちても、内側のeventIdから同じ追記を見つける。
    pub fn find_content_event(&self, content_event_id: &str) -> Option<StoredEvent> {
        let chain = self.chain();
        for sequence in 1..chain.next_sequence {
            let stored = self.read(sequence)?;
            if stored.event["payload"]["eventId"].as_str() == Some(content_event_id) {
                return Some(stored);
            }
        }
        None
    }

    /// 送れたことを記録する。**受け取られてから呼ぶ。**
    pub fn mark_delivered(&self, sequence: u64) -> Result<(), &'static str> {
        self.recover_pending_delivery()?;
        let chain = self.chain_bounded()?;
        let mut stored = self.read_bounded(sequence)?.ok_or("その出来事がありません")?;
        if stored.sequence!=sequence || sequence==0 || sequence>=chain.next_sequence
            || stored.hash!=event_hash(&stored.event) { return Err("node_record_invalid"); }
        if stored.delivered {
            return Ok(());
        }
        if chain.pending==0 { return Err("node_record_invalid"); }
        let after=ChainState { pending:chain.pending-1,..chain.clone() };
        write_atomic(&self.commit_path(),&DeliveryCommit { version:1,sequence,hash:stored.hash.clone(),before:chain,after })?;
        stored.delivered = true;
        write_atomic(&self.event_path(sequence), &stored)?;
        self.recover_pending_delivery().map(|_|())
    }

    fn commit_path(&self)->PathBuf { self.root.join("delivery-commit.json") }

    fn checked_commit(&self)->Result<Option<DeliveryCommit>, &'static str> {
        let Some(commit)=read_bounded_json::<DeliveryCommit>(&self.commit_path(),128*1024)? else { return Ok(None); };
        let chain=self.chain_bounded()?;
        let event=self.read_bounded(commit.sequence)?.ok_or("node_queue_recovery_invalid")?;
        if commit.version!=1 || commit.sequence==0 || commit.sequence>=commit.before.next_sequence
            || commit.before.next_sequence>9_007_199_254_740_992 || commit.before.pending==0
            || commit.before.pending>commit.before.next_sequence-1
            || commit.after!= (ChainState { pending:commit.before.pending-1,..commit.before.clone() })
            || chain!=commit.before && chain!=commit.after
            || event.sequence!=commit.sequence || event.hash!=commit.hash || event.hash!=event_hash(&event.event) {
            return Err("node_queue_recovery_invalid");
        }
        Ok(Some(commit))
    }

    pub fn pending_delivery_sequence(&self)->Result<Option<u64>, &'static str> {
        self.chain_bounded()?;
        self.checked_commit().map(|commit|commit.map(|commit|commit.sequence))
    }

    pub fn recover_pending_delivery(&self)->Result<bool, &'static str> {
        let Some(commit)=self.checked_commit()? else { return Ok(false); };
        let mut event=self.read_bounded(commit.sequence)?.ok_or("node_queue_recovery_invalid")?;
        if !event.delivered { event.delivered=true; write_atomic(&self.event_path(commit.sequence),&event)?; }
        if self.chain_bounded()?!=commit.after { write_atomic(&self.chain_path(),&commit.after)?; }
        std::fs::remove_file(self.commit_path()).map_err(|_|"node_queue_recovery_unavailable")?;
        Ok(true)
    }
}

pub(crate) fn read_bounded_json<T: for<'de> Deserialize<'de>>(path: &Path, limit: u64) -> Result<Option<T>, &'static str> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("node_record_unavailable"),
    };
    let mut bytes = Vec::new();
    file.take(limit.checked_add(1).ok_or("node_record_too_large")?).read_to_end(&mut bytes).map_err(|_| "node_record_unavailable")?;
    if bytes.len() as u64 > limit { return Err("node_record_too_large"); }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "node_record_invalid")
}

/// 書き切れなかったものを残さない。途中で落ちた連鎖は直せない。
fn write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "書けません")?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, &bytes).map_err(|_| "書けません")?;
    std::fs::rename(&temporary, path).map_err(|_| "書けません")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> (NodeStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("hub-store-{}", uuid::Uuid::new_v4()));
        (NodeStore::open(&dir.to_string_lossy()).unwrap(), dir)
    }

    #[test]
    fn queue_recovery_completes_before_append_without_losing_other_events() {
        let (store,dir)=store();
        let first=store.append("owned.fixture",json!({}),|_|Some("signature".into())).unwrap();
        store.append("generic.fixture",json!({}),|_|Some("signature".into())).unwrap();
        store.append("unplanned.fixture",json!({}),|_|Some("signature".into())).unwrap();
        let before=store.chain_bounded().unwrap(); let after=ChainState {pending:before.pending-1,..before.clone()};
        write_atomic(&store.commit_path(),&DeliveryCommit {version:1,sequence:first.sequence,hash:first.hash,before,after}).unwrap();
        let added=store.append("next.fixture",json!({}),|_|Some("signature".into())).unwrap();
        assert_eq!(added.sequence,4); assert_eq!(store.chain_bounded().unwrap().pending,3);
        assert!(store.read(1).unwrap().delivered);
        assert!(!store.read(2).unwrap().delivered && !store.read(3).unwrap().delivered);
        assert_eq!(store.pending_delivery_sequence().unwrap(),None);
        store.mark_delivered(1).unwrap(); assert_eq!(store.chain_bounded().unwrap().pending,3);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn divergent_or_corrupt_queue_intent_never_overwrites_intervening_state() {
        let (store,dir)=store();
        let first=store.append("owned.fixture",json!({}),|_|Some("signature".into())).unwrap();
        store.append("generic.fixture",json!({}),|_|Some("signature".into())).unwrap();
        let before=store.chain_bounded().unwrap(); let after=ChainState {pending:before.pending-1,..before.clone()};
        write_atomic(&store.commit_path(),&DeliveryCommit {version:1,sequence:first.sequence,hash:first.hash,before:before.clone(),after}).unwrap();
        let intervening=ChainState {next_sequence:before.next_sequence+1,pending:before.pending+1,previous_hash:Some("b".repeat(64))};
        write_atomic(&store.chain_path(),&intervening).unwrap();
        let chain_bytes=std::fs::read(store.chain_path()).unwrap(); let event_bytes=std::fs::read(store.event_path(1)).unwrap();
        assert_eq!(store.recover_pending_delivery().unwrap_err(),"node_queue_recovery_invalid");
        assert!(store.append("next.fixture",json!({}),|_|Some("signature".into())).is_err());
        assert!(store.mark_delivered(2).is_err());
        assert_eq!(std::fs::read(store.chain_path()).unwrap(),chain_bytes); assert_eq!(std::fs::read(store.event_path(1)).unwrap(),event_bytes);
        std::fs::write(store.commit_path(),b"invalid").unwrap();
        assert!(store.recover_pending_delivery().is_err()); assert!(store.pending_delivery_sequence().is_err());
        assert_eq!(std::fs::read(store.chain_path()).unwrap(),chain_bytes); assert_eq!(std::fs::read(store.event_path(1)).unwrap(),event_bytes);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_chain_starts_at_one_with_nothing_before_it() {
        let (store, dir) = store();
        let chain = store.chain();
        assert_eq!(chain.next_sequence, 1);
        assert_eq!(chain.previous_hash, None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn each_event_points_at_the_one_before_it() {
        // ゲートウェイは前+1 と 前のhash を確かめる。ここが合わないと受け取られない。
        let (store, dir) = store();
        let first = store
            .append("post.created", json!({ "id": "p1" }), |_| {
                Some("sig1".into())
            })
            .unwrap();
        let second = store
            .append("post.created", json!({ "id": "p2" }), |_| {
                Some("sig2".into())
            })
            .unwrap();

        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert_eq!(
            second.event["previousHash"],
            Value::String(first.hash.clone())
        );
        assert_eq!(store.chain().next_sequence, 3);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_number_is_never_handed_out_twice() {
        // 二重に採番すると、ゲートウェイはどちらか一方しか受け取らず、
        // 落ちたほうは黙って消える。
        let (store, dir) = store();
        let mut seen = std::collections::HashSet::new();
        for index in 0..20 {
            let stored = store
                .append("post.created", json!({ "index": index }), |_| {
                    Some("sig".into())
                })
                .unwrap();
            assert!(seen.insert(stored.sequence), "同じ番号が二度出た");
        }
        assert_eq!(store.chain().next_sequence, 21);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn nothing_is_written_when_it_cannot_be_signed() {
        // 番号だけ進んで中身の無い穴ができると、連鎖はそこで終わる。
        let (store, dir) = store();
        assert!(store.append("post.created", json!({}), |_| None).is_err());
        assert_eq!(
            store.chain().next_sequence,
            1,
            "署名できなければ番号は進まない"
        );
        assert!(store.read(1).is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn what_has_not_been_delivered_is_kept() {
        let (store, dir) = store();
        store
            .append("post.created", json!({ "id": "p1" }), |_| {
                Some("sig".into())
            })
            .unwrap();
        store
            .append("post.created", json!({ "id": "p2" }), |_| {
                Some("sig".into())
            })
            .unwrap();
        assert_eq!(store.undelivered(10).len(), 2);
        assert_eq!(store.chain().pending, 2);

        store.mark_delivered(1).unwrap();
        let left = store.undelivered(10);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].sequence, 2);
        assert_eq!(store.chain().pending, 1);

        // 二度呼んでも数が狂わない。送信の再試行で普通に起きる。
        store.mark_delivered(1).unwrap();
        assert_eq!(store.chain().pending, 1);
        std::fs::remove_dir_all(dir).ok();
    }

    /// 実際の鍵で1件書き、ゲートウェイと同じ検証に掛けるための材料を出す。
    ///   cargo test emit_a_real_signed_event -- --ignored --nocapture
    #[test]
    #[ignore]
    fn emit_a_real_signed_event() {
        let key = crate::node_identity::NodeKey::create();
        let dir = std::env::temp_dir().join(format!("hub-store-{}", uuid::Uuid::new_v4()));
        let store = NodeStore::open(&dir.to_string_lossy()).unwrap();
        let first = store
            .append(
                "post.created",
                json!({ "id": "p1", "body": "はじめまして" }),
                |message| Some(key.sign(message)),
            )
            .unwrap();
        let second = store
            .append(
                "post.created",
                json!({ "id": "p2", "body": "ふたつめ" }),
                |message| Some(key.sign(message)),
            )
            .unwrap();
        let jwk = key.public_jwk();
        println!(
            "{}",
            json!({
                "jwk": { "kty": jwk.kty, "crv": jwk.crv, "x": jwk.x, "y": jwk.y },
                "events": [
                    { "event": first.event, "signature": first.signature, "hash": first.hash },
                    { "event": second.event, "signature": second.signature, "hash": second.hash }
                ]
            })
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_originals_survive_being_reopened() {
        // ハブが消えても持ち主の手元には残る、が Personal Node の意味。
        let dir = std::env::temp_dir().join(format!("hub-store-{}", uuid::Uuid::new_v4()));
        let first = NodeStore::open(&dir.to_string_lossy()).unwrap();
        let written = first
            .append(
                "post.created",
                json!({ "id": "p1", "body": "はじめまして" }),
                |_| Some("sig".into()),
            )
            .unwrap();
        drop(first);

        let again = NodeStore::open(&dir.to_string_lossy()).unwrap();
        let read = again.read(1).expect("残っている");
        assert_eq!(read.hash, written.hash);
        assert_eq!(read.event["payload"]["body"], "はじめまして");
        assert_eq!(again.chain().next_sequence, 2);
        std::fs::remove_dir_all(dir).ok();
    }
}
