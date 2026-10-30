use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use crate::{
    content_protocol::public_node_origin,
    node_identity::{NodeKey, PublicKeyJwk},
    node_log::canonical_json,
    node_store::StoredEvent,
};

const IDENTITY_TYPE: &str = "hub.personal-node.peer-identity.v1";
const DELIVERY_TYPE: &str = "hub.personal-node.delivery.v1";
const PREVIEW_TTL_MINUTES: i64 = 15;
const DELIVERY_TTL_MINUTES: i64 = 5;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerIdentity {
    pub r#type: String,
    pub version: u8,
    pub node_id: String,
    pub signing_key_jwk: PublicKeyJwk,
    pub signing_key_thumbprint: String,
    pub encryption_key_jwk: PublicKeyJwk,
    pub encryption_key_thumbprint: String,
    pub encryption_key_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerPreview {
    pub preview_id: String,
    pub node_id: String,
    pub signing_key_jwk: PublicKeyJwk,
    pub signing_key_thumbprint: String,
    pub encryption_key_jwk: PublicKeyJwk,
    pub encryption_key_thumbprint: String,
    pub encryption_key_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPeer {
    pub preview_id: String,
    pub confirmed_fingerprints: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedPeer {
    pub peer_id: String,
    pub node_id: String,
    pub signing_key_jwk: PublicKeyJwk,
    pub signing_key_thumbprint: String,
    pub encryption_key_jwk: PublicKeyJwk,
    pub encryption_key_thumbprint: String,
    pub encryption_key_id: String,
    pub pinned_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerDelivery {
    pub r#type: String,
    pub version: u8,
    pub delivery_id: String,
    pub sender_node_id: String,
    pub recipient_node_id: String,
    pub expires_at: String,
    pub portable_event: Value,
    pub portable_signature: String,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerDeliveryReceipt {
    pub status: String,
    pub delivery_id: String,
    pub portable_event_id: String,
    pub received_at: String,
}

#[derive(Clone)]
pub struct PeerStore {
    root: PathBuf,
}

impl PeerStore {
    pub fn open(storage_path: &str) -> Result<Self, &'static str> {
        let root = PathBuf::from(storage_path).join("peers");
        for directory in ["previews", "pinned", "inbox", "outbox", "receipts"] {
            std::fs::create_dir_all(root.join(directory))
                .map_err(|_| "peer_storage_unavailable")?;
        }
        Ok(Self { root })
    }

    pub fn prepare(
        &self,
        expected_url: &str,
        identity: PeerIdentity,
    ) -> Result<PeerPreview, String> {
        verify_identity(&identity)?;
        let expected = format!("{}/", public_node_origin(expected_url)?);
        if identity.node_id != expected {
            return Err("取得先URLとピアのnodeIdが一致しません".into());
        }
        let now = Utc::now();
        let preview = PeerPreview {
            preview_id: format!("peer-preview-{}", uuid::Uuid::new_v4().simple()),
            node_id: identity.node_id,
            signing_key_jwk: identity.signing_key_jwk,
            signing_key_thumbprint: identity.signing_key_thumbprint,
            encryption_key_jwk: identity.encryption_key_jwk,
            encryption_key_thumbprint: identity.encryption_key_thumbprint,
            encryption_key_id: identity.encryption_key_id,
            expires_at: (now + Duration::minutes(PREVIEW_TTL_MINUTES))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        write_json_atomic(&self.path("previews", &preview.preview_id)?, &preview)?;
        Ok(preview)
    }

    pub fn confirm(&self, input: ConfirmPeer) -> Result<PinnedPeer, String> {
        if !input.confirmed_fingerprints {
            return Err("鍵指紋の明示確認が必要です".into());
        }
        let preview: PeerPreview = read_json(&self.path("previews", &input.preview_id)?)
            .ok_or_else(|| "ピアプレビューが見つかりません".to_owned())?;
        if DateTime::parse_from_rfc3339(&preview.expires_at)
            .map_err(|_| "ピアプレビュー期限が不正です")?
            <= Utc::now()
        {
            return Err("ピアプレビューの期限が切れました".into());
        }
        let peer_id = peer_id(&preview.node_id);
        if let Some(existing) = self.get(&peer_id) {
            if existing.signing_key_thumbprint != preview.signing_key_thumbprint
                || existing.encryption_key_thumbprint != preview.encryption_key_thumbprint
            {
                return Err("既存ピアの鍵が変わっています。自動更新しません".into());
            }
            return Ok(existing);
        }
        let pinned = PinnedPeer {
            peer_id: peer_id.clone(),
            node_id: preview.node_id,
            signing_key_jwk: preview.signing_key_jwk,
            signing_key_thumbprint: preview.signing_key_thumbprint,
            encryption_key_jwk: preview.encryption_key_jwk,
            encryption_key_thumbprint: preview.encryption_key_thumbprint,
            encryption_key_id: preview.encryption_key_id,
            pinned_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        write_json_atomic(&self.path("pinned", &peer_id)?, &pinned)?;
        Ok(pinned)
    }

    pub fn list(&self) -> Vec<PinnedPeer> {
        read_directory(self.root.join("pinned"))
    }

    pub fn get(&self, peer_id: &str) -> Option<PinnedPeer> {
        read_json(&self.path("pinned", peer_id).ok()?)
    }

    pub fn by_node_id(&self, node_id: &str) -> Option<PinnedPeer> {
        self.list().into_iter().find(|peer| peer.node_id == node_id)
    }

    pub fn receive(
        &self,
        local_node_id: &str,
        delivery: PeerDelivery,
    ) -> Result<PeerDeliveryReceipt, String> {
        if delivery.r#type != DELIVERY_TYPE || delivery.version != 1 {
            return Err("配送形式が不正です".into());
        }
        if delivery.recipient_node_id != local_node_id {
            return Err("配送先がこのノードではありません".into());
        }
        let expires =
            DateTime::parse_from_rfc3339(&delivery.expires_at).map_err(|_| "配送期限が不正です")?;
        if expires <= Utc::now()
            || expires > Utc::now() + Duration::minutes(DELIVERY_TTL_MINUTES + 1)
        {
            return Err("配送期限が切れているか長すぎます".into());
        }
        let sender = self
            .by_node_id(&delivery.sender_node_id)
            .ok_or_else(|| "未確認のピアからは受信しません".to_owned())?;
        if !NodeKey::verify_with_jwk(
            &sender.signing_key_jwk,
            &canonical_json(&delivery_unsigned(&delivery)),
            &delivery.signature,
        ) {
            return Err("配送署名が不正です".into());
        }
        if !NodeKey::verify_with_jwk(
            &sender.signing_key_jwk,
            &canonical_json(&delivery.portable_event),
            &delivery.portable_signature,
        ) || !verify_content_event(&delivery.portable_event, &sender)?
        {
            return Err("コンテンツイベント署名が不正です".into());
        }
        let path = self.path("inbox", &delivery.delivery_id)?;
        let fingerprint =
            sha256_hex(canonical_json(&serde_json::to_value(&delivery).unwrap()).as_bytes());
        if let Some(existing) = read_json::<Value>(&path) {
            if existing["fingerprint"].as_str() != Some(&fingerprint) {
                return Err("同じ配送IDの内容が変わっています".into());
            }
            return serde_json::from_value(existing["receipt"].clone())
                .map_err(|_| "保存済みreceiptが壊れています".into());
        }
        let receipt = PeerDeliveryReceipt {
            status: "accepted".into(),
            delivery_id: delivery.delivery_id.clone(),
            portable_event_id: delivery.portable_event["id"]
                .as_str()
                .ok_or_else(|| "portable event idがありません".to_owned())?
                .to_owned(),
            received_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        write_json_atomic(
            &path,
            &serde_json::json!({ "fingerprint": fingerprint, "delivery": delivery, "receipt": receipt }),
        )?;
        Ok(receipt)
    }

    /// Startup cleanup. An inbox item goes once its delivery's own `expiresAt`
    /// has passed (a replay would be refused as expired anyway). An outbox item
    /// goes only when it has also been acknowledged (receipt accepted/ready):
    /// an unacknowledged one keeps the attempt lineage, so a later resend can
    /// never reuse its delivery ID with a different expiry. Previews, pinned
    /// peers and receipts are left alone. Returns the number removed.
    pub fn purge_expired(&self, now: DateTime<Utc>) -> usize {
        let mut removed = 0;
        for (directory, enveloped) in [("inbox", true), ("outbox", false)] {
            let Ok(entries) = std::fs::read_dir(self.root.join(directory)) else {
                continue;
            };
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(saved) = read_json::<Value>(&path) else { continue };
                let delivery = if enveloped { saved.get("delivery") } else { Some(&saved) };
                let Some(delivery) = delivery else { continue };
                let expired = delivery
                    .get("expiresAt")
                    .and_then(Value::as_str)
                    .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
                    .is_some_and(|expiry| expiry <= now);
                if !expired {
                    continue;
                }
                if !enveloped {
                    let acknowledged = delivery
                        .get("deliveryId")
                        .and_then(Value::as_str)
                        .and_then(|id| self.delivery_receipt(id))
                        .is_some_and(|receipt| {
                            matches!(receipt.status.as_str(), "accepted" | "ready")
                        });
                    if !acknowledged {
                        continue;
                    }
                }
                if std::fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
        }
        removed
    }


    pub fn inbox_delivery(&self, delivery_id: &str) -> Option<PeerDelivery> {
        let saved: Value = read_json(&self.path("inbox", delivery_id).ok()?)?;
        serde_json::from_value(saved.get("delivery")?.clone()).ok()
    }

    pub fn inbox(&self) -> Vec<(PeerDelivery, PeerDeliveryReceipt)> {
        read_directory::<Value>(self.root.join("inbox"))
            .into_iter()
            .filter_map(|saved| {
                Some((
                    serde_json::from_value(saved.get("delivery")?.clone()).ok()?,
                    serde_json::from_value(saved.get("receipt")?.clone()).ok()?,
                ))
            })
            .collect()
    }

    pub fn mark_ready(&self, delivery_id: &str) -> Result<PeerDeliveryReceipt, String> {
        let path = self.path("inbox", delivery_id)?;
        let mut saved: Value =
            read_json(&path).ok_or_else(|| "受信配送が見つかりません".to_owned())?;
        let mut receipt: PeerDeliveryReceipt = serde_json::from_value(
            saved
                .get("receipt")
                .cloned()
                .ok_or_else(|| "受信receiptがありません".to_owned())?,
        )
        .map_err(|_| "受信receiptが壊れています".to_owned())?;
        receipt.status = "ready".into();
        saved["receipt"] =
            serde_json::to_value(&receipt).map_err(|_| "受信receiptを保存できません".to_owned())?;
        write_json_atomic(&path, &saved)?;
        Ok(receipt)
    }

    pub fn prepare_delivery(
        &self,
        sender_node_id: &str,
        peer: &PinnedPeer,
        stored: StoredEvent,
        signing: &NodeKey,
    ) -> Result<PeerDelivery, String> {
        let event_id = stored.event["id"]
            .as_str()
            .ok_or_else(|| "portable event idがありません".to_owned())?;
        let delivery_id = format!(
            "delivery-{}",
            sha256_hex(format!("{}\0{event_id}", peer.peer_id).as_bytes())
        );
        let path = self.path("outbox", &delivery_id)?;
        let mut attempt_id = delivery_id;
        if let Some(saved) = read_json::<PeerDelivery>(&path) {
            if saved.portable_event != stored.event || saved.portable_signature != stored.signature
                || saved.recipient_node_id != peer.node_id || saved.sender_node_id != sender_node_id
                || !signing.verify(&canonical_json(&delivery_unsigned(&saved)), &saved.signature) {
                return Err("保存済みの配送と原本が一致しません".into());
            }
            if self.delivery_receipt(&saved.delivery_id).is_some_and(|receipt|
                receipt.delivery_id == saved.delivery_id && receipt.portable_event_id == event_id
                    && matches!(receipt.status.as_str(), "accepted" | "ready"))
                || DateTime::parse_from_rfc3339(&saved.expires_at).is_ok_and(|expires| expires > Utc::now()) {
                return Ok(saved);
            }
            // A new transport attempt keeps the original event and signature unchanged.
            // Changing an expired request under the same ID would violate replay protection.
            attempt_id = format!("delivery-{}", sha256_hex(format!("{}\0{}", saved.delivery_id, saved.expires_at).as_bytes()));
        }
        let value = delivery_with_id(attempt_id, sender_node_id, &peer.node_id, stored, signing);
        write_json_atomic(&path, &value)?;
        Ok(value)
    }

    pub fn prepared_delivery(&self, peer_id: &str, event_id: &str) -> Option<PeerDelivery> {
        let id = format!("delivery-{}", sha256_hex(format!("{peer_id}\0{event_id}").as_bytes()));
        read_json(&self.path("outbox", &id).ok()?)
    }

    pub fn valid_prepared_delivery(&self, peer_id: &str, stored: &StoredEvent, key: &NodeKey) -> Option<PeerDelivery> {
        let delivery = self.prepared_delivery(peer_id, stored.event["id"].as_str()?)?;
        let peer = self.get(peer_id)?;
        (delivery.portable_event == stored.event && delivery.portable_signature == stored.signature
            && delivery.recipient_node_id == peer.node_id
            && delivery.sender_node_id == stored.event["payload"]["envelope"]["issuer"]["nodeId"]
            && key.verify(&canonical_json(&delivery_unsigned(&delivery)), &delivery.signature)).then_some(delivery)
    }

    pub fn save_delivery_receipt(&self, receipt: &PeerDeliveryReceipt) -> Result<(), String> {
        write_json_atomic(&self.path("receipts", &receipt.delivery_id)?, receipt)
    }

    pub fn delivery_receipt(&self, delivery_id: &str) -> Option<PeerDeliveryReceipt> {
        read_json(&self.path("receipts", delivery_id).ok()?)
    }
}

pub fn identity(
    node_url: &str,
    signing: &NodeKey,
    encryption_jwk: PublicKeyJwk,
    encryption_thumbprint: String,
) -> Result<PeerIdentity, String> {
    let node_id = format!("{}/", public_node_origin(node_url)?);
    let signing_key_jwk = signing.public_jwk();
    let signing_key_thumbprint = signing.thumbprint();
    let mut value = PeerIdentity {
        r#type: IDENTITY_TYPE.into(),
        version: 1,
        node_id,
        signing_key_jwk,
        signing_key_thumbprint,
        encryption_key_jwk: encryption_jwk,
        encryption_key_thumbprint: encryption_thumbprint,
        encryption_key_id: "e2ee-v1".into(),
        signature: String::new(),
    };
    value.signature = signing.sign(&canonical_json(&identity_unsigned(&value)));
    Ok(value)
}

pub fn delivery(
    sender_node_id: &str,
    recipient_node_id: &str,
    stored: StoredEvent,
    signing: &NodeKey,
) -> PeerDelivery {
    delivery_with_id(
        format!("delivery-{}", uuid::Uuid::new_v4().simple()),
        sender_node_id,
        recipient_node_id,
        stored,
        signing,
    )
}

fn delivery_with_id(
    delivery_id: String,
    sender_node_id: &str,
    recipient_node_id: &str,
    stored: StoredEvent,
    signing: &NodeKey,
) -> PeerDelivery {
    let mut value = PeerDelivery {
        r#type: DELIVERY_TYPE.into(),
        version: 1,
        delivery_id,
        sender_node_id: sender_node_id.into(),
        recipient_node_id: recipient_node_id.into(),
        expires_at: (Utc::now() + Duration::minutes(DELIVERY_TTL_MINUTES))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        portable_event: stored.event,
        portable_signature: stored.signature,
        signature: String::new(),
    };
    value.signature = signing.sign(&canonical_json(&delivery_unsigned(&value)));
    value
}

fn verify_identity(identity: &PeerIdentity) -> Result<(), String> {
    if identity.r#type != IDENTITY_TYPE
        || identity.version != 1
        || identity.encryption_key_id != "e2ee-v1"
    {
        return Err("ピア身元形式が不正です".into());
    }
    if NodeKey::thumbprint_jwk(&identity.signing_key_jwk).as_deref()
        != Some(identity.signing_key_thumbprint.as_str())
        || NodeKey::thumbprint_jwk(&identity.encryption_key_jwk).as_deref()
            != Some(identity.encryption_key_thumbprint.as_str())
    {
        return Err("ピア鍵指紋が一致しません".into());
    }
    if !NodeKey::verify_with_jwk(
        &identity.signing_key_jwk,
        &canonical_json(&identity_unsigned(identity)),
        &identity.signature,
    ) {
        return Err("ピア身元署名が不正です".into());
    }
    Ok(())
}

fn verify_content_event(portable: &Value, sender: &PinnedPeer) -> Result<bool, String> {
    if portable["type"] != "hub.content.publish" {
        return Err("受信できるのはpublishイベントだけです".into());
    }
    let event = &portable["payload"];
    if event["issuer"]["nodeId"].as_str() != Some(sender.node_id.as_str()) {
        return Ok(false);
    }
    let envelope = &event["envelope"];
    if envelope["issuer"]["nodeId"].as_str() != Some(sender.node_id.as_str()) {
        return Ok(false);
    }
    let envelope_signature = envelope["signature"]["value"]
        .as_str()
        .ok_or_else(|| "Envelope署名がありません".to_owned())?;
    let mut unsigned_envelope = envelope.clone();
    unsigned_envelope
        .as_object_mut()
        .ok_or("Envelopeが不正です")?
        .remove("signature");
    if !NodeKey::verify_with_jwk(
        &sender.signing_key_jwk,
        &canonical_json(&unsigned_envelope),
        envelope_signature,
    ) {
        return Ok(false);
    }
    let event_signature = event["signature"]["value"]
        .as_str()
        .ok_or_else(|| "Content Event署名がありません".to_owned())?;
    let mut unsigned_event = event.clone();
    unsigned_event
        .as_object_mut()
        .ok_or("Content Eventが不正です")?
        .remove("signature");
    unsigned_event["envelope"] = unsigned_envelope;
    Ok(NodeKey::verify_with_jwk(
        &sender.signing_key_jwk,
        &canonical_json(&unsigned_event),
        event_signature,
    ))
}

fn identity_unsigned(value: &PeerIdentity) -> Value {
    let mut unsigned = serde_json::to_value(value).expect("identity");
    unsigned.as_object_mut().unwrap().remove("signature");
    unsigned
}

fn delivery_unsigned(value: &PeerDelivery) -> Value {
    let mut unsigned = serde_json::to_value(value).expect("delivery");
    unsigned.as_object_mut().unwrap().remove("signature");
    unsigned
}

fn peer_id(node_id: &str) -> String {
    format!("peer-{}", sha256_hex(node_id.as_bytes()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn path_id(id: &str) -> Result<(), String> {
    if id.len() < 8
        || id.len() > 100
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("ピア識別子が不正です".into());
    }
    Ok(())
}

impl PeerStore {
    fn path(&self, directory: &str, id: &str) -> Result<PathBuf, String> {
        path_id(id)?;
        Ok(self.root.join(directory).join(format!("{id}.json")))
    }
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(value).map_err(|_| "peer encode failed")?,
    )
    .map_err(|_| "peer write failed")?;
    std::fs::rename(temporary, path).map_err(|_| "peer write failed".into())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn read_directory<T: for<'de> Deserialize<'de>>(path: PathBuf) -> Vec<T> {
    let Ok(entries) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| read_json(&entry.path()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        content_e2ee::NodeEncryptionKey,
        content_protocol::{commit, prepare, ConfirmPublicContent, PublicContentDraft},
        node_store::NodeStore,
        personal_node::NodeState,
    };

    #[test]
    fn identity_preview_requires_explicit_pin_and_rejects_key_change() {
        let root = std::env::temp_dir().join(format!("hub-peer-{}", uuid::Uuid::new_v4()));
        let store = PeerStore::open(&root.to_string_lossy()).unwrap();
        let signing = NodeKey::create();
        let encryption = NodeEncryptionKey::create();
        let peer_identity = identity(
            "https://peer.example",
            &signing,
            encryption.public_jwk(),
            encryption.thumbprint(),
        )
        .unwrap();
        let preview = store
            .prepare("https://peer.example", peer_identity)
            .unwrap();
        assert!(store
            .confirm(ConfirmPeer {
                preview_id: preview.preview_id.clone(),
                confirmed_fingerprints: false
            })
            .is_err());
        let pinned = store
            .confirm(ConfirmPeer {
                preview_id: preview.preview_id,
                confirmed_fingerprints: true,
            })
            .unwrap();
        assert_eq!(store.list().len(), 1);
        let other = NodeEncryptionKey::create();
        let changed = identity(
            "https://peer.example",
            &signing,
            other.public_jwk(),
            other.thumbprint(),
        )
        .unwrap();
        let changed_preview = store.prepare("https://peer.example", changed).unwrap();
        assert!(store
            .confirm(ConfirmPeer {
                preview_id: changed_preview.preview_id,
                confirmed_fingerprints: true
            })
            .is_err());
        assert_eq!(
            store
                .get(&pinned.peer_id)
                .unwrap()
                .encryption_key_thumbprint,
            pinned.encryption_key_thumbprint
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn two_pinned_nodes_accept_once_and_reject_replay_mutation() {
        let root = std::env::temp_dir().join(format!("hub-peer-{}", uuid::Uuid::new_v4()));
        let receiver = PeerStore::open(&root.to_string_lossy()).unwrap();
        let sender_key = NodeKey::create();
        let sender_encryption = NodeEncryptionKey::create();
        let preview = receiver
            .prepare(
                "https://sender.example",
                identity(
                    "https://sender.example",
                    &sender_key,
                    sender_encryption.public_jwk(),
                    sender_encryption.thumbprint(),
                )
                .unwrap(),
            )
            .unwrap();
        receiver
            .confirm(ConfirmPeer {
                preview_id: preview.preview_id,
                confirmed_fingerprints: true,
            })
            .unwrap();

        let event_root = root.join("events");
        let event_store = NodeStore::open(&event_root.to_string_lossy()).unwrap();
        let state = NodeState {
            node_id: "sender".into(),
            device_name: "sender".into(),
            enabled: true,
            launch_at_login: false,
            storage_path: event_root.to_string_lossy().into_owned(),
            hub_url: "https://sender.example".into(),
            sync_state: "ready".into(),
            public_key_jwk: None,
            key_thumbprint: None,
            last_sync_at: None,
            last_sync_confirmed: false,
            queued_items: 0,
        };
        let preview = prepare(
            PublicContentDraft {
                kind: "memory".into(),
                title: "共有".into(),
                body: "二つのノード".into(),
                language: "ja".into(),
            },
            &state,
            &event_store,
        )
        .unwrap();
        let receipt = commit(
            ConfirmPublicContent {
                preview_id: preview.preview_id,
                confirmed_public: true,
            },
            &state,
            &event_store,
            &sender_key,
        )
        .unwrap();
        let stored = event_store.read(receipt.sequence).unwrap();
        let delivery = delivery(
            "https://sender.example/",
            "https://receiver.example/",
            stored,
            &sender_key,
        );
        let first = receiver
            .receive("https://receiver.example/", delivery.clone())
            .unwrap();
        assert_eq!(
            receiver
                .receive("https://receiver.example/", delivery.clone())
                .unwrap(),
            first,
            "同じ配送の再試行は同じreceipt"
        );
        let mut changed = delivery;
        changed.expires_at =
            (Utc::now() + Duration::minutes(4)).to_rfc3339_opts(SecondsFormat::Millis, true);
        changed.signature = sender_key.sign(&canonical_json(&delivery_unsigned(&changed)));
        assert!(receiver
            .receive("https://receiver.example/", changed)
            .is_err());
        std::fs::remove_dir_all(root).ok();
    }
}

#[cfg(test)]
mod delivery_retry_tests {
    use super::*;
    #[test]
    fn expired_delivery_gets_a_new_transport_id_but_keeps_the_exact_original() {
        let root=std::env::temp_dir().join(format!("hub-expired-peer-{}",uuid::Uuid::new_v4()));
        let peers=PeerStore::open(&root.to_string_lossy()).unwrap();let key=NodeKey::create();
        let encryption=crate::content_e2ee::NodeEncryptionKey::create();
        let preview=peers.prepare("https://peer.example",identity("https://peer.example",&key,encryption.public_jwk(),encryption.thumbprint()).unwrap()).unwrap();
        let peer=peers.confirm(ConfirmPeer{preview_id:preview.preview_id,confirmed_fingerprints:true}).unwrap();
        let store=crate::node_store::NodeStore::open(&root.join("data").to_string_lossy()).unwrap();
        let stored=store.append("hub.content.publish",serde_json::json!({"envelope":{"issuer":{"nodeId":"https://sender.example/"}}}),|value|Some(key.sign(value))).unwrap();
        let first=peers.prepare_delivery("https://sender.example/",&peer,stored.clone(),&key).unwrap();
        let mut expired=first.clone();expired.expires_at=(Utc::now()-Duration::minutes(1)).to_rfc3339();expired.signature=key.sign(&canonical_json(&delivery_unsigned(&expired)));
        write_json_atomic(&peers.path("outbox",&first.delivery_id).unwrap(),&expired).unwrap();
        let next=peers.prepare_delivery("https://sender.example/",&peer,stored.clone(),&key).unwrap();
        assert_ne!(next.delivery_id,first.delivery_id);assert_eq!(next.portable_event,first.portable_event);assert_eq!(next.portable_signature,first.portable_signature);
        assert_eq!(peers.prepare_delivery("https://sender.example/",&peer,stored.clone(),&key).unwrap().delivery_id,next.delivery_id);
        let mut expired=next.clone();expired.expires_at=(Utc::now()-Duration::minutes(1)).to_rfc3339();expired.signature=key.sign(&canonical_json(&delivery_unsigned(&expired)));
        write_json_atomic(&peers.path("outbox",&first.delivery_id).unwrap(),&expired).unwrap();
        peers.save_delivery_receipt(&PeerDeliveryReceipt{status:"accepted".into(),delivery_id:next.delivery_id.clone(),portable_event_id:stored.event["id"].as_str().unwrap().into(),received_at:Utc::now().to_rfc3339()}).unwrap();
        assert_eq!(peers.prepare_delivery("https://sender.example/",&peer,stored.clone(),&key).unwrap().delivery_id,next.delivery_id);
        let mut changed=stored;changed.event["payload"]=serde_json::json!({"changed":true});
        assert!(peers.prepare_delivery("https://sender.example/",&peer,changed,&key).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn purge_removes_only_expired_inbox_and_acknowledged_outbox_items() {
        let root = std::env::temp_dir().join(format!("hub-peer-purge-{}", uuid::Uuid::new_v4()));
        let peers = PeerStore::open(&root.to_string_lossy()).unwrap();
        let now = Utc::now();
        let stamp = |minutes: i64| (now + Duration::minutes(minutes)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let put = |dir: &str, id: &str, value: Value| {
            write_json_atomic(&peers.path(dir, id).unwrap(), &value).unwrap();
        };
        put("inbox", "in-expired-1", serde_json::json!({"delivery": {"expiresAt": stamp(-5)}, "receipt": {}}));
        put("inbox", "in-live-0001", serde_json::json!({"delivery": {"expiresAt": stamp(5)}, "receipt": {}}));
        put("inbox", "in-broken-01", serde_json::json!({"no": "delivery"}));
        put("outbox", "out-acked-01", serde_json::json!({"deliveryId": "out-acked-01", "expiresAt": stamp(-5)}));
        put("outbox", "out-noack-01", serde_json::json!({"deliveryId": "out-noack-01", "expiresAt": stamp(-5)}));
        put("outbox", "out-live-001", serde_json::json!({"deliveryId": "out-live-001", "expiresAt": stamp(5)}));
        for id in ["out-acked-01", "out-live-001"] {
            peers
                .save_delivery_receipt(&PeerDeliveryReceipt {
                    status: "accepted".into(),
                    delivery_id: id.into(),
                    portable_event_id: "e".into(),
                    received_at: stamp(-6),
                })
                .unwrap();
        }
        put("pinned", "pinned-0001", serde_json::json!({"expiresAt": stamp(-500)}));
        assert_eq!(peers.purge_expired(now), 2);
        let exists = |dir: &str, id: &str| peers.path(dir, id).unwrap().exists();
        assert!(!exists("inbox", "in-expired-1") && !exists("outbox", "out-acked-01"));
        assert!(exists("inbox", "in-live-0001") && exists("inbox", "in-broken-01"));
        assert!(exists("outbox", "out-noack-01") && exists("outbox", "out-live-001"));
        assert!(exists("pinned", "pinned-0001") && exists("receipts", "out-acked-01"));
        assert_eq!(peers.purge_expired(now), 0);
        let _ = std::fs::remove_dir_all(root);
    }
}
