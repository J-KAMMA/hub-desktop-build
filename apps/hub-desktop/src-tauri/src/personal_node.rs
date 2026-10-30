use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, RwLock};
#[path = "personal_node_read.rs"]
mod peer_read;

#[derive(Clone)]
pub struct PersonalNodeService {
    path: PathBuf,
    state: Arc<RwLock<NodeState>>,
    /// このノードの身元鍵。**秘密鍵は状態に混ぜない。** 状態は画面へ渡り、
    /// ファイルにも書かれる。混ぜた時点で、出すつもりのないものが出る。
    key: Option<Arc<crate::node_identity::NodeKey>>,
    encryption_key: Option<Arc<crate::content_e2ee::NodeEncryptionKey>>,
    append_lock: Arc<Mutex<()>>,
    artifact_lock: Arc<Mutex<()>>,
    delivery_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeState {
    pub node_id: String,
    pub device_name: String,
    pub enabled: bool,
    pub launch_at_login: bool,
    pub storage_path: String,
    pub hub_url: String,
    pub sync_state: String,
    /// 外へ出してよい公開鍵。ハブの登録はこれを受け取る。
    #[serde(skip_deserializing, default)]
    pub public_key_jwk: Option<crate::node_identity::PublicKeyJwk>,
    /// どの鍵で名乗っているか。**公開鍵からだけ作る。**
    #[serde(skip_deserializing, default)]
    pub key_thumbprint: Option<String>,
    pub last_sync_at: Option<u64>,
    #[serde(default)]
    pub last_sync_confirmed: bool,
    pub queued_items: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateNodeSettings {
    pub device_name: String,
    pub enabled: bool,
    pub launch_at_login: bool,
    pub storage_path: String,
    pub hub_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInboxItem {
    pub delivery_id: String,
    pub status: String,
    pub sender_node_id: String,
    pub content_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub media_type: String,
    pub byte_length: u64,
    pub received_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptedPeerContent {
    pub delivery_id: String,
    pub content_id: String,
    pub media_type: String,
    pub data: String,
    pub text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicPostTarget { peer_id: String, node_id: String, signing_key_thumbprint: String }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicPostPlan { portable_event_id: String, targets: Vec<PublicPostTarget> }

impl PersonalNodeService {
    pub fn load(app_data_dir: PathBuf) -> Result<Self, &'static str> {
        fs::create_dir_all(&app_data_dir).map_err(|_| "node_storage_unavailable")?;
        let path = app_data_dir.join("personal-node.json");
        let state = if path.is_file() {
            let bytes = fs::read(&path).map_err(|_| "node_state_unavailable")?;
            serde_json::from_slice(&bytes).map_err(|_| "node_state_invalid")?
        } else {
            let state = NodeState::new(&app_data_dir);
            save_atomic(&path, &state)?;
            state
        };
        purge_stale_node_files(&state.storage_path);
        Ok(Self {
            path,
            state: Arc::new(RwLock::new(state)),
            key: load_or_create_key(),
            encryption_key: load_or_create_encryption_key(),
            append_lock: Arc::new(Mutex::new(())),
            artifact_lock: Arc::new(Mutex::new(())),
            delivery_lock: Arc::new(Mutex::new(())),
        })
    }

    /// 外へ出してよい身元。
    pub fn public_identity(&self) -> Option<(crate::node_identity::PublicKeyJwk, String)> {
        self.key
            .as_ref()
            .map(|key| (key.public_jwk(), key.thumbprint()))
    }

    pub fn public_encryption_identity(
        &self,
    ) -> Option<(crate::node_identity::PublicKeyJwk, String)> {
        self.encryption_key
            .as_ref()
            .map(|key| (key.public_jwk(), key.thumbprint()))
    }

    /// ハブの組み合わせ確認に答える。**署名するのはここだけ。**
    pub fn sign(&self, message: &str) -> Option<String> {
        self.key.as_ref().map(|key| key.sign(message))
    }

    /// 持ち運べる身元（portable_identity.rs）用。バイト列に署名して 64 バイト（r||s）を返す。
    /// 秘密鍵は渡さない。署名の依頼を受けるだけ。
    pub fn sign_bytes(&self, message: &[u8]) -> Option<[u8; 64]> {
        self.key.as_ref().map(|key| key.sign_bytes(message))
    }

    /// 原本の置き場。設定で保管先を変えられるので、その都度開く。
    async fn store(&self) -> Result<crate::node_store::NodeStore, &'static str> {
        let path = self.state.read().await.storage_path.clone();
        crate::node_store::NodeStore::open(&path)
    }

    async fn artifact_store(&self) -> Result<crate::artifact_store::ArtifactStore, &'static str> {
        let path = self.state.read().await.storage_path.clone();
        crate::artifact_store::ArtifactStore::open(&path)
    }

    async fn peer_store(&self) -> Result<crate::peer_node::PeerStore, &'static str> {
        let path = self.state.read().await.storage_path.clone();
        crate::peer_node::PeerStore::open(&path)
    }

    pub async fn peer_identity(&self) -> Result<crate::peer_node::PeerIdentity, String> {
        let state = self.state.read().await.clone();
        let signing = self.key.as_ref().ok_or("身元鍵がありません")?;
        let (encryption_jwk, encryption_thumbprint) = self
            .public_encryption_identity()
            .ok_or("暗号鍵がありません")?;
        crate::peer_node::identity(
            &state.hub_url,
            signing,
            encryption_jwk,
            encryption_thumbprint,
        )
    }

    pub async fn preview_peer(
        &self,
        node_url: &str,
    ) -> Result<crate::peer_node::PeerPreview, String> {
        let origin = crate::content_protocol::public_node_origin(node_url)?;
        let parsed = reqwest::Url::parse(&origin).map_err(|_| "ピアURLが不正です")?;
        let host = parsed.host_str().ok_or("ピアhostがありません")?.to_owned();
        let addresses = tokio::net::lookup_host((host.as_str(), 443))
            .await
            .map_err(|_| "ピアhostを解決できません")?
            .collect::<Vec<_>>();
        if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
            return Err("公開ネットワークではないピアへ接続しません".into());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addresses[0])
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|_| "ピア接続を準備できません")?;
        let identity = client
            .get(format!("{origin}/p2p/v1/identity"))
            .send()
            .await
            .map_err(|_| "ピア身元を取得できません")?
            .error_for_status()
            .map_err(|_| "ピア身元が拒否されました")?
            .json::<crate::peer_node::PeerIdentity>()
            .await
            .map_err(|_| "ピア身元形式が不正です")?;
        self.peer_store()
            .await
            .map_err(str::to_owned)?
            .prepare(&origin, identity)
    }

    pub async fn confirm_peer(
        &self,
        input: crate::peer_node::ConfirmPeer,
    ) -> Result<crate::peer_node::PinnedPeer, String> {
        let _guard = self.delivery_lock.lock().await;
        self.peer_store()
            .await
            .map_err(str::to_owned)?
            .confirm(input)
    }

    pub async fn peers(&self) -> Vec<crate::peer_node::PinnedPeer> {
        self.peer_store()
            .await
            .map(|store| store.list())
            .unwrap_or_default()
    }

    pub async fn peer_inbox(&self) -> Vec<PeerInboxItem> {
        let Ok(store) = self.peer_store().await else {
            return Vec::new();
        };
        store
            .inbox()
            .into_iter()
            .filter_map(|(delivery, receipt)| {
                let envelope = delivery.portable_event.pointer("/payload/envelope")?;
                let representation = envelope.get("representations")?.as_array()?.first()?;
                Some(PeerInboxItem {
                    delivery_id: delivery.delivery_id,
                    status: receipt.status,
                    sender_node_id: delivery.sender_node_id,
                    content_id: envelope.get("contentId")?.as_str()?.to_owned(),
                    kind: envelope.get("kind")?.as_str()?.to_owned(),
                    title: envelope
                        .get("title")
                        .and_then(|value| value.as_str())
                        .map(str::to_owned),
                    media_type: representation.get("mediaType")?.as_str()?.to_owned(),
                    byte_length: representation.get("byteLength")?.as_u64()?,
                    received_at: receipt.received_at,
                })
            })
            .collect()
    }

    pub async fn decrypt_peer_content(
        &self,
        delivery_id: &str,
    ) -> Result<DecryptedPeerContent, String> {
        self.decrypt_peer_content_with_limit(delivery_id, None).await
    }

    pub(crate) async fn decrypt_peer_content_with_limit(
        &self,
        delivery_id: &str,
        source_limit: Option<usize>,
    ) -> Result<DecryptedPeerContent, String> {
        if let Some(limit) = source_limit {
            return peer_read::decrypt_bounded(self, delivery_id, limit).await;
        }
        let state = self.state.read().await.clone();
        let local_node_id = format!(
            "{}/",
            crate::content_protocol::public_node_origin(&state.hub_url)?
        );
        let delivery = self
            .peer_store()
            .await
            .map_err(str::to_owned)?
            .inbox_delivery(delivery_id)
            .ok_or("受信配送が見つかりません")?;
        let envelope = delivery
            .portable_event
            .pointer("/payload/envelope")
            .ok_or("Content Envelopeがありません")?;
        let representation = envelope
            .get("representations")
            .and_then(|value| value.as_array())
            .and_then(|values| values.first())
            .ok_or("representationがありません")?;
        let source = representation.get("source").ok_or("sourceがありません")?;
        let encrypted = match source.get("type").and_then(|value| value.as_str()) {
            Some("inline") => URL_SAFE_NO_PAD
                .decode(
                    source
                        .get("data")
                        .and_then(|value| value.as_str())
                        .ok_or("inline暗号文がありません")?,
                )
                .map_err(|_| "inline暗号文が不正です")?,
            Some("p2p") => {
                let digest = representation
                    .pointer("/digest/value")
                    .and_then(|value| value.as_str())
                    .ok_or("digestがありません")?;
                self.artifact_store()
                    .await
                    .map_err(str::to_owned)?
                    .read_blob(digest)?
                    .1
            }
            _ => return Err("暗号化sourceに対応していません".into()),
        };
        self.decrypt_saved_representation(&local_node_id, delivery_id, envelope, representation, &encrypted)
    }

    fn decrypt_saved_representation(
        &self,
        local_node_id: &str,
        delivery_id: &str,
        envelope: &serde_json::Value,
        representation: &serde_json::Value,
        encrypted: &[u8],
    ) -> Result<DecryptedPeerContent, String> {
        let metadata: crate::content_e2ee::EncryptionMetadata = serde_json::from_value(
            representation
                .get("encryption")
                .cloned()
                .ok_or("暗号化されていません")?,
        )
        .map_err(|_| "暗号メタデータが不正です")?;
        let content_id = envelope
            .get("contentId")
            .and_then(|value| value.as_str())
            .ok_or("contentIdがありません")?;
        let media_type = representation
            .get("mediaType")
            .and_then(|value| value.as_str())
            .ok_or("mediaTypeがありません")?;
        let plaintext = self
            .encryption_key
            .as_ref()
            .ok_or("暗号鍵がありません")?
            .decrypt(
                content_id,
                representation
                    .get("id")
                    .and_then(|value| value.as_str())
                    .ok_or("representation idがありません")?,
                media_type,
                envelope
                    .pointer("/visibility/mode")
                    .and_then(|value| value.as_str())
                    .ok_or("visibilityがありません")?,
                local_node_id,
                "e2ee-v1",
                encrypted,
                &metadata,
            )?;
        let text = media_type
            .starts_with("text/")
            .then(|| String::from_utf8(plaintext.clone()).ok())
            .flatten();
        Ok(DecryptedPeerContent {
            delivery_id: delivery_id.into(),
            content_id: content_id.into(),
            media_type: media_type.into(),
            data: URL_SAFE_NO_PAD.encode(plaintext),
            text,
        })
    }

    pub async fn receive_peer_delivery(
        &self,
        delivery: crate::peer_node::PeerDelivery,
    ) -> Result<crate::peer_node::PeerDeliveryReceipt, String> {
        let state = self.state.read().await.clone();
        let node_id = format!(
            "{}/",
            crate::content_protocol::public_node_origin(&state.hub_url)?
        );
        let store = self.peer_store().await.map_err(str::to_owned)?;
        let delivery_id = delivery.delivery_id.clone();
        store.receive(&node_id, delivery)?;
        self.stage_received_content(&delivery_id, &node_id).await?;
        store.mark_ready(&delivery_id)
    }

    async fn stage_received_content(
        &self,
        delivery_id: &str,
        local_node_id: &str,
    ) -> Result<(), String> {
        let delivery = self
            .peer_store()
            .await
            .map_err(str::to_owned)?
            .inbox_delivery(delivery_id)
            .ok_or("受信配送が見つかりません")?;
        let envelope = delivery
            .portable_event
            .pointer("/payload/envelope")
            .ok_or("Content Envelopeがありません")?;
        let representation = envelope
            .get("representations")
            .and_then(|value| value.as_array())
            .and_then(|values| values.first())
            .ok_or("representationがありません")?;
        let expected_digest = representation
            .pointer("/digest/value")
            .and_then(|value| value.as_str())
            .ok_or("representation digestがありません")?;
        let expected_length = representation
            .get("byteLength")
            .and_then(|value| value.as_u64())
            .ok_or("representation byteLengthがありません")?;
        let source = representation.get("source").ok_or("sourceがありません")?;
        let ciphertext = match source.get("type").and_then(|value| value.as_str()) {
            Some("inline") => {
                let data = source
                    .get("data")
                    .and_then(|value| value.as_str())
                    .ok_or("inline本文がありません")?;
                match source.get("encoding").and_then(|value| value.as_str()) {
                    Some("base64url") => URL_SAFE_NO_PAD
                        .decode(data)
                        .map_err(|_| "inline暗号文が不正です")?,
                    Some("utf-8") if representation.get("encryption").is_none() => {
                        data.as_bytes().to_vec()
                    }
                    _ => return Err("inline encodingが不正です".into()),
                }
            }
            Some("p2p") => {
                self.fetch_peer_blob(&delivery.sender_node_id, expected_digest)
                    .await?
            }
            _ => return Err("受信source形式に対応していません".into()),
        };
        if ciphertext.len() as u64 != expected_length || sha256_hex(&ciphertext) != expected_digest
        {
            return Err("受信データがContent Envelopeと一致しません".into());
        }
        if let Some(encryption) = representation.get("encryption") {
            let metadata: crate::content_e2ee::EncryptionMetadata =
                serde_json::from_value(encryption.clone())
                    .map_err(|_| "暗号メタデータが不正です")?;
            let key = self.encryption_key.as_ref().ok_or("暗号鍵がありません")?;
            let content_id = envelope
                .get("contentId")
                .and_then(|value| value.as_str())
                .ok_or("contentIdがありません")?;
            let representation_id = representation
                .get("id")
                .and_then(|value| value.as_str())
                .ok_or("representation idがありません")?;
            let media_type = representation
                .get("mediaType")
                .and_then(|value| value.as_str())
                .ok_or("mediaTypeがありません")?;
            let visibility = envelope
                .pointer("/visibility/mode")
                .and_then(|value| value.as_str())
                .ok_or("visibilityがありません")?;
            key.decrypt(
                content_id,
                representation_id,
                media_type,
                visibility,
                local_node_id,
                "e2ee-v1",
                &ciphertext,
                &metadata,
            )?;
        }
        if source.get("type").and_then(|value| value.as_str()) == Some("p2p") {
            self.artifact_store()
                .await
                .map_err(str::to_owned)?
                .store_bytes("received.hub", "application/octet-stream", &ciphertext)?;
        }
        Ok(())
    }

    async fn fetch_peer_blob(&self, sender_node_id: &str, digest: &str) -> Result<Vec<u8>, String> {
        let (client, origin) = public_peer_client(sender_node_id).await?;
        let manifest = client
            .get(format!("{origin}/p2p/v1/blobs/{digest}/manifest"))
            .send()
            .await
            .map_err(|_| "暗号文manifestを取得できません")?
            .error_for_status()
            .map_err(|_| "暗号文manifestが拒否されました")?
            .json::<PeerBlobManifest>()
            .await
            .map_err(|_| "暗号文manifestが不正です")?;
        if manifest.version != 1
            || manifest.digest != digest
            || manifest.blob_uri != format!("urn:hub:blob:{digest}")
            || manifest.byte_length > crate::artifact_store::MAX_ARTIFACT_BYTES
        {
            return Err("暗号文manifestが要求と一致しません".into());
        }
        let mut bytes = Vec::with_capacity(manifest.byte_length as usize);
        for expected in &manifest.chunks {
            let chunk = client
                .get(format!(
                    "{origin}/p2p/v1/blobs/{digest}/chunks/{}",
                    expected.index
                ))
                .send()
                .await
                .map_err(|_| "暗号文断片を取得できません")?
                .error_for_status()
                .map_err(|_| "暗号文断片が拒否されました")?
                .json::<PeerBlobChunk>()
                .await
                .map_err(|_| "暗号文断片が不正です")?;
            let decoded = URL_SAFE_NO_PAD
                .decode(&chunk.data)
                .map_err(|_| "暗号文断片がbase64urlではありません")?;
            if chunk.index != expected.index
                || chunk.byte_length != expected.byte_length
                || decoded.len() != expected.byte_length
                || chunk.digest != expected.digest
                || sha256_hex(&decoded) != expected.digest
            {
                return Err("暗号文断片のdigestが一致しません".into());
            }
            bytes.extend_from_slice(&decoded);
        }
        if bytes.len() as u64 != manifest.byte_length || sha256_hex(&bytes) != manifest.digest {
            return Err("暗号文全体のdigestが一致しません".into());
        }
        Ok(bytes)
    }

    pub async fn deliver_event_to_peer(
        &self,
        peer_id: &str,
        sequence: u64,
    ) -> Result<crate::peer_node::PeerDeliveryReceipt, String> {
        let _guard = self.delivery_lock.lock().await;
        self.deliver_event_locked(peer_id, sequence).await
    }

    async fn deliver_event_locked(&self, peer_id: &str, sequence: u64)
        -> Result<crate::peer_node::PeerDeliveryReceipt, String> {
        let state = self.state.read().await.clone();
        let sender_node_id = format!(
            "{}/",
            crate::content_protocol::public_node_origin(&state.hub_url)?
        );
        let signing = self.key.as_ref().ok_or("身元鍵がありません")?;
        let store = self.peer_store().await.map_err(str::to_owned)?;
        let peer = store.get(peer_id).ok_or("ピアが見つかりません")?;
        let event = self
            .store()
            .await
            .map_err(str::to_owned)?
            .read(sequence)
            .ok_or("イベントが見つかりません")?;
        let delivery = store.prepare_delivery(&sender_node_id, &peer, event, signing)?;
        if let Some(receipt) = store.delivery_receipt(&delivery.delivery_id) {
            if receipt.delivery_id == delivery.delivery_id
                && Some(receipt.portable_event_id.as_str()) == delivery.portable_event["id"].as_str()
                && matches!(receipt.status.as_str(), "accepted" | "ready") { return Ok(receipt); }
            return Err("保存済みの受領応答が原本と一致しません".into());
        }
        let (client, origin) = public_peer_client(&peer.node_id).await?;
        let endpoint = format!("{origin}/p2p/v1/inbox");
        let mut last_error = "ピアへ配送できません".to_owned();
        for _ in 0..3 {
            match client.post(&endpoint).json(&delivery).send().await {
                Ok(response) if response.status().is_success() => {
                    let receipt = response
                        .json::<crate::peer_node::PeerDeliveryReceipt>()
                        .await
                        .map_err(|_| "ピアreceiptが不正です")?;
                    if receipt.delivery_id != delivery.delivery_id
                        || Some(receipt.portable_event_id.as_str()) != delivery.portable_event["id"].as_str()
                        || !matches!(receipt.status.as_str(), "accepted" | "ready") {
                        return Err("ピアの受領応答が配送・原本と一致しません".into());
                    }
                    store.save_delivery_receipt(&receipt)?;
                    return Ok(receipt);
                }
                Ok(response) if response.status().is_client_error() => {
                    return Err(format!("ピアが配送を拒否しました ({})", response.status()));
                }
                Ok(response) => {
                    last_error = format!("ピアが一時失敗を返しました ({})", response.status())
                }
                Err(_) => last_error = "ピアへ接続できません".into(),
            }
        }
        Err(last_error)
    }

    pub async fn begin_artifact_upload(
        &self,
        input: crate::artifact_store::BeginArtifactUpload,
    ) -> Result<crate::artifact_store::ArtifactUpload, String> {
        if !self.state.read().await.enabled {
            return Err("Personal Nodeを有効にしてください".into());
        }
        self.artifact_store()
            .await
            .map_err(str::to_owned)?
            .begin(input)
    }

    pub async fn put_artifact_chunk(
        &self,
        upload_id: &str,
        index: u32,
        input: crate::artifact_store::ArtifactChunkInput,
    ) -> Result<crate::artifact_store::ArtifactChunkReceipt, String> {
        if !self.state.read().await.enabled {
            return Err("Personal Nodeを有効にしてください".into());
        }
        self.artifact_store()
            .await
            .map_err(str::to_owned)?
            .put_chunk(upload_id, index, input)
    }

    pub async fn finalize_artifact_upload(
        &self,
        upload_id: &str,
    ) -> Result<crate::content_protocol::PublicContentPreview, String> {
        let _guard = self.artifact_lock.lock().await;
        let state = self.state.read().await.clone();
        if !state.enabled {
            return Err("Personal Nodeを有効にしてください".into());
        }
        if self.key.is_none() {
            return Err("身元鍵がありません".into());
        }
        let content_store = self.store().await.map_err(str::to_owned)?;
        let receipt_id = format!("artifact-finalize-{upload_id}");
        if let Some(preview) =
            content_store.read_receipt::<crate::content_protocol::PublicContentPreview>(&receipt_id)
        {
            return Ok(preview);
        }
        let (upload, manifest) = self
            .artifact_store()
            .await
            .map_err(str::to_owned)?
            .finalize(upload_id)?;
        let preview =
            crate::content_protocol::prepare_artifact(upload, manifest, &state, &content_store)?;
        content_store
            .save_receipt(&receipt_id, &preview)
            .map_err(str::to_owned)?;
        Ok(preview)
    }

    pub async fn finalize_private_artifact_upload(
        &self,
        upload_id: &str,
        input: crate::content_protocol::PrivateArtifactFinalize,
    ) -> Result<crate::content_protocol::PublicContentPreview, String> {
        let _guard = self.artifact_lock.lock().await;
        let state = self.state.read().await.clone();
        if !state.enabled {
            return Err("Personal Nodeを有効にしてください".into());
        }
        if self.encryption_key.is_none() {
            return Err("暗号鍵がありません".into());
        }
        let (recipients, recipient_ids) =
            self.resolve_recipients(&input.recipient_peer_ids).await?;
        let recipient_key = input.recipient_peer_ids.join("\0");
        let receipt_id = format!(
            "private-finalize-{}-{}",
            upload_id,
            sha256_short(recipient_key.as_bytes())
        );
        let content_store = self.store().await.map_err(str::to_owned)?;
        if let Some(preview) =
            content_store.read_receipt::<crate::content_protocol::PublicContentPreview>(&receipt_id)
        {
            return Ok(preview);
        }
        let artifact_store = self.artifact_store().await.map_err(str::to_owned)?;
        let (upload, plaintext_manifest) = artifact_store.finalize(upload_id)?;
        let (_, plaintext) = artifact_store.read_blob(&plaintext_manifest.digest)?;
        let content_id = crate::content_protocol::new_content_id();
        let encrypted = crate::content_e2ee::encrypt(
            &content_id,
            "primary",
            &upload.media_type,
            "private",
            &plaintext,
            &recipients,
        )?;
        let encrypted_manifest = artifact_store.store_bytes(
            "encrypted.hub",
            "application/octet-stream",
            &encrypted.ciphertext,
        )?;
        let preview = crate::content_protocol::prepare_private_artifact(
            content_id,
            upload,
            encrypted_manifest,
            encrypted,
            recipient_ids,
            &state,
            &content_store,
        )?;
        content_store
            .save_receipt(&receipt_id, &preview)
            .map_err(str::to_owned)?;
        Ok(preview)
    }

    pub async fn artifact_manifest(
        &self,
        digest: &str,
    ) -> Option<crate::artifact_store::ArtifactManifest> {
        self.artifact_store().await.ok()?.manifest(digest)
    }

    pub async fn artifact_chunk(&self, digest: &str, index: u32) -> Option<Vec<u8>> {
        self.artifact_store().await.ok()?.chunk(digest, index)
    }

    pub async fn published_artifact_manifest(
        &self,
        digest: &str,
    ) -> Option<(
        crate::artifact_store::PublishedBlob,
        crate::artifact_store::ArtifactManifest,
    )> {
        self.artifact_store().await.ok()?.published_manifest(digest)
    }

    pub async fn published_artifact_chunk(&self, digest: &str, index: u32) -> Option<Vec<u8>> {
        self.artifact_store()
            .await
            .ok()?
            .published_chunk(digest, index)
    }

    /// 出したものを1つ積む。**ここで署名まで済ませる。**
    ///
    /// 送るのは後でよいが、署名は出した時点でしかできない。後から署名すると、
    /// 積んだ順と署名した順がずれ、連鎖の意味が薄れる。
    pub async fn append_event(
        &self,
        kind: &str,
        payload: serde_json::Value,
    ) -> Result<crate::node_store::StoredEvent, &'static str> {
        let _guard = self.append_lock.lock().await;
        let key = self.key.clone().ok_or("身元鍵がありません")?;
        let stored = self
            .store()
            .await?
            .append(kind, payload, |message| Some(key.sign(message)))?;
        let pending = self.store().await?.chain().pending;
        let mut state = self.state.write().await;
        state.queued_items = pending;
        save_atomic(&self.path, &state)?;
        Ok(stored)
    }

    pub async fn preview_public_content(
        &self,
        input: crate::content_protocol::PublicContentDraft,
    ) -> Result<crate::content_protocol::PublicContentPreview, String> {
        let state = self.state.read().await.clone();
        if !state.enabled {
            return Err("Personal Nodeを有効にしてください".into());
        }
        if self.key.is_none() {
            return Err("身元鍵がありません".into());
        }
        crate::content_protocol::prepare(input, &state, &self.store().await.map_err(str::to_owned)?)
    }

    pub async fn preview_private_content(
        &self,
        input: crate::content_protocol::PrivateContentDraft,
    ) -> Result<crate::content_protocol::PublicContentPreview, String> {
        let state = self.state.read().await.clone();
        if !state.enabled {
            return Err("Personal Nodeを有効にしてください".into());
        }
        if self.encryption_key.is_none() {
            return Err("暗号鍵がありません".into());
        }
        let (recipients, recipient_ids) =
            self.resolve_recipients(&input.recipient_peer_ids).await?;
        let content_id = crate::content_protocol::new_content_id();
        let encrypted = crate::content_e2ee::encrypt(
            &content_id,
            "primary",
            "text/plain; charset=utf-8",
            "private",
            input.body.as_bytes(),
            &recipients,
        )?;
        crate::content_protocol::prepare_private_inline(
            crate::content_protocol::PublicContentDraft {
                kind: input.kind,
                title: input.title,
                body: input.body,
                language: input.language,
            },
            content_id,
            encrypted,
            recipient_ids,
            &state,
            &self.store().await.map_err(str::to_owned)?,
        )
    }

    async fn resolve_recipients(
        &self,
        peer_ids: &[String],
    ) -> Result<(Vec<crate::content_e2ee::RecipientSpec>, Vec<String>), String> {
        if peer_ids.is_empty() || peer_ids.len() > 256 {
            return Err("受信ピアを1から256件選んでください".into());
        }
        let peer_store = self.peer_store().await.map_err(str::to_owned)?;
        let mut seen = std::collections::HashSet::new();
        let mut specs = Vec::with_capacity(peer_ids.len());
        let mut recipient_ids = Vec::with_capacity(peer_ids.len());
        for peer_id in peer_ids {
            if !seen.insert(peer_id) {
                return Err("受信ピアが重複しています".into());
            }
            let peer = peer_store.get(peer_id).ok_or("受信ピアが見つかりません")?;
            recipient_ids.push(peer.node_id.clone());
            specs.push(crate::content_e2ee::RecipientSpec {
                recipient_id: peer.node_id,
                key_id: peer.encryption_key_id,
                public_key_jwk: peer.encryption_key_jwk,
            });
        }
        Ok((specs, recipient_ids))
    }

    pub async fn publish_public_content(
        &self,
        input: crate::content_protocol::ConfirmPublicContent,
    ) -> Result<crate::content_protocol::PublicContentReceipt, String> {
        let _guard = self.append_lock.lock().await;
        let state = self.state.read().await.clone();
        if !state.enabled {
            return Err("Personal Nodeを有効にしてください".into());
        }
        let key = self.key.as_ref().ok_or("身元鍵がありません")?;
        let store = self.store().await.map_err(str::to_owned)?;
        let artifact = crate::content_protocol::artifact_publish_details(&input.preview_id, &store);
        let receipt = crate::content_protocol::commit(input, &state, &store, key)?;
        if let Some(artifact) = artifact {
            self.artifact_store()
                .await
                .map_err(str::to_owned)?
                .publish(
                    &artifact.digest,
                    &artifact.content_id,
                    &artifact.visibility,
                    artifact.recipient_ids,
                )?;
        }
        let mut current = self.state.write().await;
        current.queued_items = store.chain().pending;
        save_atomic(&self.path, &current).map_err(str::to_owned)?;
        Ok(receipt)
    }

    pub async fn is_pending_public_event(&self, sequence: u64) -> bool {
        let Some(key) = self.key.as_ref() else { return false; };
        let Ok(store) = self.store().await else { return false; };
        let Some(stored) = store.read(sequence) else { return false; };
        !stored.delivered && stored.event["payload"]["envelope"]["visibility"]["mode"] == "public"
            && stored.hash == crate::node_log::event_hash(&stored.event)
            && key.verify(&crate::node_log::canonical_json(&stored.event), &stored.signature)
    }

    fn public_post_body<'a>(&self, stored: &'a crate::node_store::StoredEvent) -> Option<&'a str> {
        let key = self.key.as_ref()?;
        let envelope = &stored.event["payload"]["envelope"];
        let representation = &envelope["representations"][0];
        if stored.sequence == 0 || stored.event["type"] != "hub.content.publish"
            || stored.hash != crate::node_log::event_hash(&stored.event)
            || !key.verify(&crate::node_log::canonical_json(&stored.event), &stored.signature)
            || envelope["kind"] != "post" || envelope["visibility"]["mode"] != "public"
            || representation["source"]["type"] != "inline" || representation["source"]["encoding"] != "utf-8"
            || representation["encryption"].is_object() { return None; }
        representation["source"]["data"].as_str().filter(|body| body.len() <= 1_048_576)
    }

    async fn public_post(&self, sequence: u64) -> Result<crate::node_store::StoredEvent, String> {
        if sequence == 0 || sequence > 9_007_199_254_740_991 { return Err("原本番号が不正です".into()); }
        let stored = self.store().await.map_err(str::to_owned)?.read(sequence).ok_or("原本が見つかりません")?;
        if stored.sequence != sequence || self.public_post_body(&stored).is_none() { return Err("公開原本を検証できません".into()); }
        Ok(stored)
    }

    /// Owned, signed public text posts remain readable after delivery and without Hub I/O.
    pub async fn public_posts(&self, limit: usize) -> Result<Vec<serde_json::Value>, String> {
        if !(1..=30).contains(&limit) { return Err("件数は1〜30件です".into()); }
        let store = self.store().await.map_err(str::to_owned)?;
        let end = store.chain().next_sequence;
        Ok((end.saturating_sub(1000).max(1)..end).rev().filter_map(|sequence| {
            let stored = store.read(sequence)?;
            if stored.sequence != sequence { return None; }
            let body = self.public_post_body(&stored)?;
            let envelope = &stored.event["payload"]["envelope"];
            Some(serde_json::json!({"sequence":sequence,"contentId":envelope["contentId"],"title":envelope["title"],
                "body":body.chars().take(500).collect::<String>(),"truncated":body.chars().count()>500,
                "createdAt":envelope["createdAt"],"nodeUrl":envelope["issuer"]["nodeId"]}))
        }).take(limit).collect())
    }

    async fn public_post_plan(&self, stored: &crate::node_store::StoredEvent) -> Result<PublicPostPlan, String> {
        let event_id = stored.event["id"].as_str().ok_or("原本IDがありません")?;
        let store = self.store().await.map_err(str::to_owned)?;
        let id = format!("public-post-plan-{}", stored.sequence);
        if let Some(plan) = store.read_receipt::<PublicPostPlan>(&id) {
            if plan.portable_event_id != event_id || plan.targets.len() > 8 { return Err("配信先の記録が原本と一致しません".into()); }
            return Ok(plan);
        }
        if store.has_receipt(&id).map_err(str::to_owned)? { return Err("配信先の記録を読み出せません".into()); }
        // Older composer attempts already persist their approved recipients in the signed outbox.
        let peers = self.peer_store().await.map_err(str::to_owned)?;
        let key = self.key.as_ref().ok_or("身元鍵がありません")?;
        let targets = peers.list().into_iter().filter(|peer| peers.valid_prepared_delivery(&peer.peer_id, stored, key).is_some())
            .take(8).map(|peer| PublicPostTarget { peer_id:peer.peer_id, node_id:peer.node_id, signing_key_thumbprint:peer.signing_key_thumbprint }).collect();
        Ok(PublicPostPlan { portable_event_id:event_id.into(), targets })
    }

    pub async fn plan_public_post(&self, sequence: u64, peer_ids: Vec<String>) -> Result<(), String> {
        if peer_ids.len() > 8 || peer_ids.iter().collect::<std::collections::HashSet<_>>().len() != peer_ids.len() {
            return Err("配信先は重複のない8件までです".into());
        }
        let _delivery = self.delivery_lock.lock().await;
        let _guard = self.append_lock.lock().await;
        let stored = self.public_post(sequence).await?;
        let existing = self.public_post_plan(&stored).await?;
        let store = self.store().await.map_err(str::to_owned)?;
        let id = format!("public-post-plan-{sequence}");
        if store.read_receipt::<PublicPostPlan>(&id).is_some() || !existing.targets.is_empty() {
            let old = existing.targets.iter().map(|target| &target.peer_id).collect::<std::collections::HashSet<_>>();
            if old != peer_ids.iter().collect() { return Err("保存済み原本の配信先は変更できません".into()); }
            return Ok(());
        }
        let peers = self.peer_store().await.map_err(str::to_owned)?;
        let targets = peer_ids.into_iter().map(|id| {
            let peer = peers.get(&id).ok_or("登録済みの配信先が見つかりません")?;
            Ok(PublicPostTarget { peer_id:peer.peer_id, node_id:peer.node_id, signing_key_thumbprint:peer.signing_key_thumbprint })
        }).collect::<Result<Vec<_>, String>>()?;
        store.save_receipt(&id, &PublicPostPlan { targets, ..existing }).map_err(str::to_owned)
    }

    pub async fn public_post_detail(&self, sequence: u64) -> Result<serde_json::Value, String> {
        let stored = self.public_post(sequence).await?;
        let envelope = &stored.event["payload"]["envelope"];
        let plan = self.public_post_plan(&stored).await?;
        let peers = self.peer_store().await.map_err(str::to_owned)?;
        let key = self.key.as_ref().ok_or("身元鍵がありません")?;
        let deliveries = plan.targets.iter().map(|target| {
            let available = peers.get(&target.peer_id).is_some_and(|peer|
                peer.node_id == target.node_id && peer.signing_key_thumbprint == target.signing_key_thumbprint);
            let delivery = peers.valid_prepared_delivery(&target.peer_id, &stored, key);
            let receipt = delivery.as_ref().and_then(|delivery| peers.delivery_receipt(&delivery.delivery_id))
                .filter(|receipt| receipt.portable_event_id == plan.portable_event_id
                    && delivery.as_ref().is_some_and(|delivery| delivery.delivery_id == receipt.delivery_id)
                    && matches!(receipt.status.as_str(), "accepted" | "ready"));
            let status = if receipt.is_some() { "accepted" } else if !available { "unavailable" }
                else if delivery.is_some() { "unconfirmed" } else { "waiting" };
            serde_json::json!({"peerId":target.peer_id,"nodeUrl":target.node_id,"status":status,
                "retryable":available && receipt.is_none(),"receivedAt":receipt.map(|receipt|receipt.received_at)})
        }).collect::<Vec<_>>();
        Ok(serde_json::json!({"sequence":sequence,"contentId":envelope["contentId"],"portableEventId":plan.portable_event_id,
            "body":self.public_post_body(&stored),"createdAt":envelope["createdAt"],"nodeUrl":envelope["issuer"]["nodeId"],"deliveries":deliveries}))
    }

    pub async fn retry_public_post(&self, sequence: u64, peer_id: &str) -> Result<serde_json::Value, String> {
        let _guard = self.delivery_lock.lock().await;
        let stored = self.public_post(sequence).await?;
        let plan = self.public_post_plan(&stored).await?;
        let target = plan.targets.iter().find(|target|target.peer_id == peer_id).ok_or("この原本の配信先ではありません")?;
        let peer = self.peer_store().await.map_err(str::to_owned)?.get(peer_id).ok_or("配信先の登録がありません")?;
        if peer.node_id != target.node_id || peer.signing_key_thumbprint != target.signing_key_thumbprint { return Err("配信先の鍵を再確認してください".into()); }
        self.deliver_event_locked(peer_id, sequence).await?;
        self.public_post_detail(sequence).await
    }

    /// まだ送れていないもの。**古い順。** 連鎖なので順番を崩せない。
    pub async fn pending_events(&self, limit: usize) -> Vec<crate::node_store::StoredEvent> {
        match self.store().await {
            Ok(store) => store.undelivered(limit),
            Err(_) => Vec::new(),
        }
    }

    /// 受け取られたことを記録する。**受け取られてから呼ぶ。**
    pub async fn mark_delivered(&self, sequence: u64) -> Result<(), &'static str> {
        let _delivery = self.delivery_lock.lock().await;
        let _append = self.append_lock.lock().await;
        self.store().await?.mark_delivered(sequence)?;
        let pending = self.store().await.map(|s| s.chain().pending).unwrap_or(0);
        let mut state = self.state.write().await;
        state.queued_items = pending;
        save_atomic(&self.path, &state)
    }

    /// 今の状態。**読むたびに公開鍵を載せ直す。**
    ///
    /// 鍵はファイルではなく暗号化された保管庫にあるので、保存された状態には
    /// 入っていない。載せ忘れると、画面には「鍵が無いノード」として出る。
    pub async fn status(&self) -> NodeState {
        let mut state = self.state.read().await.clone();
        if let Ok(chain)=crate::node_store::NodeStore::open_readonly(&state.storage_path).and_then(|store|store.chain_bounded()) {
            state.queued_items=chain.pending;
        }
        if let Some((jwk, thumbprint)) = self.public_identity() {
            state.public_key_jwk = Some(jwk);
            state.key_thumbprint = Some(thumbprint);
        }
        state
    }

    /// Paired HTTP may edit node settings, but never Windows startup registration.
    pub async fn update(&self, update: UpdateNodeSettings) -> Result<NodeState, &'static str> {
        self.update_using(update,false,|candidate|save_atomic(&self.path,candidate)).await
    }

    pub async fn update_native(&self, update: UpdateNodeSettings) -> Result<NodeState, &'static str> {
        self.update_using(update,true,|candidate|crate::windows_startup::set_with(candidate.launch_at_login,
            ||save_atomic(&self.path,candidate))).await
    }

    async fn update_using(&self, update: UpdateNodeSettings, startup:bool,
        persist:impl FnOnce(&NodeState)->Result<(), &'static str>) -> Result<NodeState, &'static str> {
        let device_name=update.device_name.trim();
        let storage_path=update.storage_path.trim();
        let hub_url=if update.hub_url.trim().is_empty() { String::new() } else {
            crate::content_protocol::public_node_origin(&update.hub_url).map_err(|_|"invalid_hub_url")?
        };
        if device_name.is_empty() || device_name.chars().count()>80 { return Err("invalid_device_name"); }
        if storage_path.is_empty() || storage_path.chars().count()>1024 { return Err("invalid_storage_path"); }
        let _delivery=self.delivery_lock.lock().await;
        let _append=self.append_lock.lock().await;
        let mut state=self.state.write().await;
        if !startup && update.launch_at_login!=state.launch_at_login { return Err("node_startup_native_required"); }
        let mut candidate=state.clone();
        candidate.device_name=device_name.into(); candidate.enabled=update.enabled;
        candidate.launch_at_login=update.launch_at_login; candidate.storage_path=storage_path.into(); candidate.hub_url=hub_url;
        persist(&candidate)?;
        *state=candidate; drop(state);
        Ok(self.status().await)
    }

    pub async fn mark_sync(&self) -> Result<NodeState, &'static str> {
        Err("node_sync_confirmation_required")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerBlobManifest {
    version: u8,
    blob_uri: String,
    byte_length: u64,
    digest: String,
    chunks: Vec<crate::artifact_store::ArtifactChunkManifest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerBlobChunk {
    index: u32,
    byte_length: usize,
    digest: String,
    data: String,
}

async fn public_peer_client(node_url: &str) -> Result<(reqwest::Client, String), String> {
    let origin = crate::content_protocol::public_node_origin(node_url)?;
    let parsed = reqwest::Url::parse(&origin).map_err(|_| "ピアURLが不正です")?;
    let host = parsed.host_str().ok_or("ピアhostがありません")?.to_owned();
    let addresses = tokio::net::lookup_host((host.as_str(), 443))
        .await
        .map_err(|_| "ピアhostを解決できません")?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("公開ネットワークではないピアへ接続しません".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .resolve(&host, addresses[0])
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "ピア接続を準備できません")?;
    Ok((client, origin))
}

fn sha256_hex(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(value) => {
            !(value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_multicast()
                || value.is_broadcast()
                || value.is_unspecified()
                || value.octets()[0] == 0)
        }
        std::net::IpAddr::V6(value) => {
            !(value.is_loopback()
                || value.is_multicast()
                || value.is_unspecified()
                || (value.segments()[0] & 0xfe00) == 0xfc00
                || (value.segments()[0] & 0xffc0) == 0xfe80)
        }
    }
}

fn sha256_short(value: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(value)[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl NodeState {
    fn new(app_data_dir: &Path) -> Self {
        let mut random = [0_u8; 16];
        rand::thread_rng().fill_bytes(&mut random);
        let node_id = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let device_name = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "Personal Node".into());
        Self {
            node_id,
            device_name,
            enabled: true,
            launch_at_login: false,
            storage_path: app_data_dir.join("data").to_string_lossy().into_owned(),
            hub_url: String::new(),
            sync_state: "ready".into(),
            // 鍵は状態と別に持つ。ここは外へ出す形だけを載せる場所で、
            // 読むときに埋める。
            public_key_jwk: None,
            key_thumbprint: None,
            last_sync_at: None,
            last_sync_confirmed: false,
            queued_items: 0,
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn save_atomic(path: &Path, state: &NodeState) -> Result<(), &'static str> {
    let parent = path.parent().ok_or("node_storage_unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "node_storage_unavailable")?;
    fs::create_dir_all(&state.storage_path).map_err(|_| "storage_path_unavailable")?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(state).map_err(|_| "node_state_invalid")?;
    fs::write(&temporary, bytes).map_err(|_| "node_state_unavailable")?;
    fs::rename(temporary, path).map_err(|_| "node_state_unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { node:PersonalNodeService,root:PathBuf }
    impl Fixture {
        fn new()->Self {
            let root=std::env::temp_dir().join(format!("hub-node-settings-{}",uuid::Uuid::new_v4()));
            let state=NodeState::new(&root); let path=root.join("personal-node.json"); save_atomic(&path,&state).unwrap();
            let node=PersonalNodeService {path,state:Arc::new(RwLock::new(state)),key:None,encryption_key:None,
                append_lock:Arc::new(Mutex::new(())),artifact_lock:Arc::new(Mutex::new(())),delivery_lock:Arc::new(Mutex::new(()))};
            Self {node,root}
        }
        fn settings(&self,launch:bool)->UpdateNodeSettings {UpdateNodeSettings {device_name:"Desk node".into(),enabled:true,
            launch_at_login:launch,storage_path:self.root.join("owned-data").to_string_lossy().into_owned(),hub_url:"https://node.example".into()}}
    }
    impl Drop for Fixture {fn drop(&mut self) {fs::remove_dir_all(&self.root).unwrap();}}

    #[tokio::test]
    async fn persists_node_identity_and_settings_without_os_credentials() {
        let f=Fixture::new(); let first=f.node.status().await;
        let updated=f.node.update(f.settings(false)).await.unwrap();
        let reloaded:NodeState=serde_json::from_slice(&fs::read(&f.node.path).unwrap()).unwrap();
        assert_eq!(first.node_id.len(),32); assert_eq!(reloaded.node_id,first.node_id);
        assert_eq!(updated.device_name,"Desk node"); assert_eq!(reloaded.device_name,"Desk node"); assert!(!reloaded.launch_at_login);
    }

    #[tokio::test]
    async fn paired_startup_change_is_rejected_before_persistence_or_directory_creation() {
        let f=Fixture::new(); let before=fs::read(&f.node.path).unwrap();
        assert_eq!(f.node.update(f.settings(true)).await.unwrap_err(),"node_startup_native_required");
        assert_eq!(fs::read(&f.node.path).unwrap(),before); assert!(!f.root.join("owned-data").exists());
        assert!(!f.node.status().await.launch_at_login);
    }

    #[tokio::test]
    async fn failed_json_save_never_commits_new_in_memory_settings() {
        let f=Fixture::new(); let before=fs::read(&f.node.path).unwrap(); let name=f.node.status().await.device_name;
        fs::create_dir(f.node.path.with_extension("json.tmp")).unwrap();
        assert_eq!(f.node.update(f.settings(false)).await.unwrap_err(),"node_state_unavailable");
        assert_eq!(f.node.status().await.device_name,name); assert_eq!(fs::read(&f.node.path).unwrap(),before);
    }

    #[tokio::test]
    async fn failed_native_registration_does_not_commit_file_or_memory() {
        let f=Fixture::new(); let before=fs::read(&f.node.path).unwrap();
        assert_eq!(f.node.update_using(f.settings(true),true,|_|Err("startup_access_denied")).await.unwrap_err(),"startup_access_denied");
        assert_eq!(fs::read(&f.node.path).unwrap(),before); assert!(!f.node.status().await.launch_at_login);
    }

    #[tokio::test]
    async fn confirmed_native_callback_persists_before_memory_and_keeps_legacy_pref_for_http() {
        let f=Fixture::new();
        f.node.update_using(f.settings(true),true,|candidate| {assert!(!f.node.state.try_read().is_ok()); save_atomic(&f.node.path,candidate)}).await.unwrap();
        assert!(f.node.status().await.launch_at_login);
        assert!(serde_json::from_slice::<NodeState>(&fs::read(&f.node.path).unwrap()).unwrap().launch_at_login);
        f.node.update(f.settings(true)).await.unwrap();
        assert_eq!(f.node.update(f.settings(false)).await.unwrap_err(),"node_startup_native_required");
    }

    #[tokio::test]
    async fn invalid_settings_never_call_startup_or_persistence() {
        let f=Fixture::new(); let mut update=f.settings(true); update.device_name=" ".into();
        assert_eq!(f.node.update_using(update,true,|_|panic!("invalid settings persisted")).await.unwrap_err(),"invalid_device_name");
        let mut update=f.settings(true); update.storage_path="x".repeat(1025);
        assert_eq!(f.node.update_using(update,true,|_|panic!("long settings persisted")).await.unwrap_err(),"invalid_storage_path");
        let mut update=f.settings(true); update.hub_url="https://name:credential@example.com".into();
        assert_eq!(f.node.update_using(update,true,|_|panic!("unsafe URL persisted")).await.unwrap_err(),"invalid_hub_url");
    }
}

/// 身元鍵を読む。無ければ作って保存する。
///
/// 平文でディスクに置かない。既にある暗号化された保管庫へ入れる——鍵はOSの
/// 資格情報ストアが持っている（checkpoint.rs）。秘密鍵をそのまま置くと、
/// 端末のファイルを読めた誰でもこのノードを名乗れる。
///
/// 保管庫が使えない端末では鍵を持たない。**その場合はノードとして名乗らない。**
/// 守れない鍵で名乗るより、名乗らないほうがよい。
fn load_or_create_key() -> Option<Arc<crate::node_identity::NodeKey>> {
    // 保管庫は id が UUID であることを求める。ここが1文字ずれていたせいで
    // 保存が黙って失敗し、鍵の無いノードになっていた。
    const KEY_ID: &str = IDENTITY_KEY_ID;
    // 作成と読み取りを1つずつ通す。同時に作ると別々の鍵が上書きし合う。
    let _lock = crate::checkpoint::CheckpointStore::lock_named_wait("node-identity").ok()?;
    let store = crate::checkpoint::CheckpointStore::named("node-identity").ok()?;

    // 名前で指して読む。「どれか1つ」だと、同時に作られたときに別の身元を掴む。
    let pem = load_or_create_key_pem(
        &store,
        KEY_ID,
        |pem| crate::node_identity::NodeKey::from_pkcs8_pem(pem).is_ok(),
        || crate::node_identity::NodeKey::create().to_pkcs8_pem().ok(),
    )?;
    crate::node_identity::NodeKey::from_pkcs8_pem(&pem).ok().map(Arc::new)
}

/// 鍵の記録を読み、**本当に無いときだけ**新しく作る。
///
/// 以前は読めない理由を区別せず、一時的な読み取り失敗でも新しい鍵で同じ記録を
/// 上書きしていた。そうなるとノードの身元と暗号鍵が黙って入れ替わり、戻せない。
/// - 一時的に読めない（ファイルを開けない等）: 何も書かず、今回は名乗らない。
/// - 壊れている・復号できない: 古い記録を `unreadable/` へ退避してから作る。
const IDENTITY_KEY_ID: &str = "6e6f6465-6964-4000-8000-6b6579000001";
const ENCRYPTION_KEY_ID: &str = "656e6372-7970-4000-8000-6b6579000001";
const MAX_KEY_RECORD: usize = 16 * 1024;
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredKey {
    pkcs8_pem: String,
}

/// 書き出し用に、今の身元鍵と暗号鍵を読む。無ければ作らずに失敗する。
pub(crate) fn read_key_pems() -> Result<(String, String), String> {
    let read = |folder: &str, id: &str| -> Result<String, String> {
        let _lock = crate::checkpoint::CheckpointStore::lock_named_wait(folder)?;
        let store = crate::checkpoint::CheckpointStore::with_existing_key(folder, "checkpoint-key-v1")?;
        store.load_optional_bounded::<StoredKey>(id, MAX_KEY_RECORD)?
            .map(|found| found.pkcs8_pem)
            .ok_or_else(|| "node_key_missing".to_owned())
    };
    let identity = read("node-identity", IDENTITY_KEY_ID)?;
    let encryption = read("node-encryption", ENCRYPTION_KEY_ID)?;
    crate::node_identity::NodeKey::from_pkcs8_pem(&identity).map_err(|_| "node_key_invalid")?;
    crate::content_e2ee::NodeEncryptionKey::from_pkcs8_pem(&encryption).map_err(|_| "node_key_invalid")?;
    Ok((identity, encryption))
}

/// 取り込み: 鍵を確かめてから入れ替える。前の鍵は消さず `unreadable/` へ退避する。
/// 動いているノードは起動時に読んだ鍵を持ち続けるので、使うのは次の起動から。
pub(crate) fn replace_key_pems(identity: &str, encryption: &str) -> Result<(), String> {
    crate::node_identity::NodeKey::from_pkcs8_pem(identity).map_err(|_| "node_key_invalid")?;
    crate::content_e2ee::NodeEncryptionKey::from_pkcs8_pem(encryption).map_err(|_| "node_key_invalid")?;
    for (folder, id, pem) in [("node-identity", IDENTITY_KEY_ID, identity), ("node-encryption", ENCRYPTION_KEY_ID, encryption)] {
        let _lock = crate::checkpoint::CheckpointStore::lock_named_wait(folder)?;
        let store = crate::checkpoint::CheckpointStore::named(folder)?;
        match store.load_optional_bounded::<StoredKey>(id, MAX_KEY_RECORD) {
            Ok(Some(found)) if found.pkcs8_pem == pem => continue,
            Ok(None) => {}
            Ok(Some(_)) | Err(_) => store.set_aside(id)?,
        }
        store.save(id, &StoredKey { pkcs8_pem: pem.to_owned() })?;
    }
    Ok(())
}

fn load_or_create_key_pem(
    store: &crate::checkpoint::CheckpointStore,
    id: &str,
    valid: impl Fn(&str) -> bool,
    create: impl FnOnce() -> Option<String>,
) -> Option<String> {
    match store.load_optional_bounded::<StoredKey>(id, MAX_KEY_RECORD) {
        Ok(Some(found)) if valid(&found.pkcs8_pem) => return Some(found.pkcs8_pem),
        Ok(None) => {}
        Err(error) if error == "checkpoint_unavailable" => return None,
        // 中身が鍵でない・復号できない・壊れている。上書きせず退避する。
        Ok(Some(_)) | Err(_) => store.set_aside(id).ok()?,
    }
    let pem = create()?;
    store.save(id, &StoredKey { pkcs8_pem: pem.clone() }).ok()?;
    Some(pem)
}

fn load_or_create_encryption_key() -> Option<Arc<crate::content_e2ee::NodeEncryptionKey>> {
    const KEY_ID: &str = ENCRYPTION_KEY_ID;
    // 作成と読み取りを1つずつ通す。同時に作ると別々の鍵が上書きし合う。
    let _lock = crate::checkpoint::CheckpointStore::lock_named_wait("node-encryption").ok()?;
    let store = crate::checkpoint::CheckpointStore::named("node-encryption").ok()?;
    let pem = load_or_create_key_pem(
        &store,
        KEY_ID,
        |pem| crate::content_e2ee::NodeEncryptionKey::from_pkcs8_pem(pem).is_ok(),
        || crate::content_e2ee::NodeEncryptionKey::create().to_pkcs8_pem().ok(),
    )?;
    crate::content_e2ee::NodeEncryptionKey::from_pkcs8_pem(&pem).ok().map(Arc::new)
}

#[cfg(test)]
mod key_record_tests {
    use super::load_or_create_key_pem;
    use crate::checkpoint::CheckpointStore;

    const ID: &str = "6e6f6465-6964-4000-8000-6b6579000001";
    fn store(dir: &std::path::Path, key: u8) -> CheckpointStore { CheckpointStore::test(dir.to_path_buf(), [key; 32]) }
    fn created(name: &'static str) -> impl FnOnce() -> Option<String> { move || Some(name.to_owned()) }
    fn ok(pem: &str) -> bool { pem.starts_with("pem-") }

    #[test]
    fn creates_once_then_keeps_the_same_key() {
        let dir = std::env::temp_dir().join(format!("hub-key-{}", uuid::Uuid::new_v4()));
        let s = store(&dir, 1);
        assert_eq!(load_or_create_key_pem(&s, ID, ok, created("pem-a")).as_deref(), Some("pem-a"));
        assert_eq!(load_or_create_key_pem(&s, ID, ok, created("pem-b")).as_deref(), Some("pem-a"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_unreadable_record_is_set_aside_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("hub-key-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_or_create_key_pem(&store(&dir, 1), ID, ok, created("pem-a")).as_deref(), Some("pem-a"));
        let original = std::fs::read(dir.join(format!("{ID}.jkcp"))).unwrap();
        // 別の鍵で開く＝復号できない。新しい鍵は作るが、元の記録は残す。
        assert_eq!(load_or_create_key_pem(&store(&dir, 2), ID, ok, created("pem-b")).as_deref(), Some("pem-b"));
        let aside: Vec<_> = std::fs::read_dir(dir.join("unreadable")).unwrap().map(|e| std::fs::read(e.unwrap().path()).unwrap()).collect();
        assert_eq!(aside, vec![original]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_transient_read_failure_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("hub-key-{}", uuid::Uuid::new_v4()));
        let s = store(&dir, 1);
        // 記録の場所がディレクトリ＝開けない。新しい鍵で埋めてはならない。
        std::fs::create_dir_all(dir.join(format!("{ID}.jkcp"))).unwrap();
        assert_eq!(load_or_create_key_pem(&s, ID, ok, created("pem-b")), None);
        assert!(dir.join(format!("{ID}.jkcp")).is_dir());
        assert!(!dir.join("unreadable").exists());
        std::fs::remove_dir_all(dir).ok();
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;

    /// 状態は画面へ渡り、ファイルにも書かれる。**秘密鍵が混ざっていたら、
    /// その両方から漏れる。**
    #[tokio::test]
    async fn the_state_carries_the_public_half_only() {
        let dir = std::env::temp_dir().join(format!("hub-node-{}", uuid::Uuid::new_v4()));
        let service = PersonalNodeService::load(dir.clone()).expect("読める");
        let state = service.status().await;

        let serialised = serde_json::to_string(&state).unwrap();
        assert!(
            !serialised.contains("PRIVATE KEY"),
            "秘密鍵が状態に混ざっている"
        );
        assert!(!serialised.contains("pkcs8"), "秘密鍵が状態に混ざっている");

        // **鍵を持っていることまで確かめる。** 「無くてもよい」と書いていた
        // せいで、保存が失敗しても通ってしまい、実機で初めて気付いた。
        let (jwk, thumbprint) = service.public_identity().expect("鍵を持つこと");
        assert_eq!(jwk.kty, "EC");
        assert_eq!(jwk.crv, "P-256");
        assert_eq!(state.key_thumbprint.as_deref(), Some(thumbprint.as_str()));
        assert!(state.public_key_jwk.is_some());
        std::fs::remove_dir_all(dir).ok();
    }

    /// 起動のたびに鍵が変わると、ノードは毎回別人になる。登録も署名も無意味になる。
    #[tokio::test]
    async fn the_node_keeps_the_same_key_across_restarts() {
        let dir = std::env::temp_dir().join(format!("hub-node-{}", uuid::Uuid::new_v4()));
        let first = PersonalNodeService::load(dir.clone()).expect("読める");
        let (_, thumbprint) = first.public_identity().expect("鍵を持つこと");
        drop(first);

        let again = PersonalNodeService::load(dir.clone()).expect("読める");
        assert_eq!(again.public_identity().map(|(_, t)| t), Some(thumbprint));
        std::fs::remove_dir_all(dir).ok();
    }

    /// 署名できるのは鍵を持っているときだけ。持たないなら黙って何も返さない。
    #[tokio::test]
    async fn it_signs_only_with_a_key_it_actually_has() {
        let dir = std::env::temp_dir().join(format!("hub-node-{}", uuid::Uuid::new_v4()));
        let service = PersonalNodeService::load(dir.clone()).expect("読める");
        service.public_identity().expect("鍵を持つこと");
        let signature = service.sign("challenge").expect("署名できる");
        assert!(!signature.is_empty());
        assert!(!signature.contains('='), "base64url なので詰め物は付かない");
        std::fs::remove_dir_all(dir).ok();
    }
}


#[cfg(test)]
mod public_post_reader_tests {
    use super::*;
    #[tokio::test]
    async fn public_originals_survive_restart_and_delivery_and_exclude_private_or_tampered_events() {
        let root=std::env::temp_dir().join(format!("hub-public-posts-{}",uuid::Uuid::new_v4()));
        let node=PersonalNodeService::load(root.clone()).unwrap();
        node.update(UpdateNodeSettings{device_name:"Node".into(),enabled:true,launch_at_login:false,storage_path:root.join("data").to_string_lossy().into_owned(),hub_url:"https://node.example".into()}).await.unwrap();
        for _ in 0..100 { node.append_event("private.fixture", serde_json::json!({"body":"private"})).await.unwrap(); }
        let preview=node.preview_public_content(crate::content_protocol::PublicContentDraft{kind:"post".into(),title:"".into(),body:"公開の原本".into(),language:"ja".into()}).await.unwrap();
        assert!(node.public_posts(30).await.unwrap().is_empty());
        let receipt=node.publish_public_content(crate::content_protocol::ConfirmPublicContent{preview_id:preview.preview_id,confirmed_public:true}).await.unwrap();
        assert_eq!(receipt.sequence,101);assert!(node.is_pending_public_event(receipt.sequence).await);assert!(!node.is_pending_public_event(0).await);
        node.store().await.unwrap().mark_delivered(receipt.sequence).unwrap();assert!(!node.is_pending_public_event(receipt.sequence).await);
        node.append_event("hub.content.publish",serde_json::json!({"envelope":{"kind":"post","visibility":{"mode":"private"},"representations":[{"source":{"type":"inline","encoding":"utf-8","data":"private"}}]}})).await.unwrap();
        let reopened=PersonalNodeService::load(root.clone()).unwrap();
        let posts=reopened.public_posts(30).await.unwrap();assert_eq!(posts.len(),1);assert_eq!(posts[0]["body"],"公開の原本");assert_eq!(posts[0]["sequence"],receipt.sequence);
        assert!(reopened.public_post_detail(102).await.is_err());
        assert!(reopened.public_posts(0).await.is_err());assert!(reopened.public_posts(31).await.is_err());
        let path=root.join("data/events").join(format!("{:012}.json",receipt.sequence));
        let mut stored=reopened.store().await.unwrap().read(receipt.sequence).unwrap();stored.event["payload"]["envelope"]["representations"][0]["source"]["data"]=serde_json::json!("tampered");
        fs::write(path,serde_json::to_vec(&stored).unwrap()).unwrap();assert!(reopened.public_posts(30).await.unwrap().is_empty());
        assert!(reopened.public_post_detail(receipt.sequence).await.is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod public_post_detail_tests {
    use super::*;
    use crate::peer_node::{ConfirmPeer, PeerDeliveryReceipt};

    #[tokio::test]
    async fn public_post_details_restore_full_body_targets_and_acknowledgements_without_sending() {
        let root=std::env::temp_dir().join(format!("hub-post-detail-{}",uuid::Uuid::new_v4()));
        let node=PersonalNodeService::load(root.clone()).unwrap();
        node.update(UpdateNodeSettings{device_name:"Node".into(),enabled:true,launch_at_login:false,storage_path:root.join("data").to_string_lossy().into_owned(),hub_url:"https://node.example".into()}).await.unwrap();
        let body="🌿原本\n".repeat(300);
        let preview=node.preview_public_content(crate::content_protocol::PublicContentDraft{kind:"post".into(),title:"".into(),body:body.clone(),language:"ja".into()}).await.unwrap();
        let receipt=node.publish_public_content(crate::content_protocol::ConfirmPublicContent{preview_id:preview.preview_id,confirmed_public:true}).await.unwrap();
        let peers=node.peer_store().await.unwrap();
        let pinned=["https://one.example","https://two.example"].map(|url|{
            let key=crate::node_identity::NodeKey::create();let encryption=crate::content_e2ee::NodeEncryptionKey::create();
            let preview=peers.prepare(url,crate::peer_node::identity(url,&key,encryption.public_jwk(),encryption.thumbprint()).unwrap()).unwrap();
            peers.confirm(ConfirmPeer{preview_id:preview.preview_id,confirmed_fingerprints:true}).unwrap()
        });
        let ids=pinned.iter().map(|peer|peer.peer_id.clone()).collect::<Vec<_>>();
        assert!(node.plan_public_post(1,vec![ids[0].clone();9]).await.is_err());
        assert!(node.plan_public_post(1,vec![ids[0].clone();2]).await.is_err());
        node.plan_public_post(1,ids.clone()).await.unwrap();
        assert!(node.plan_public_post(1,vec![ids[0].clone()]).await.is_err());
        let reopened=PersonalNodeService::load(root.clone()).unwrap();
        let detail=reopened.public_post_detail(1).await.unwrap();
        assert_eq!(detail["body"],body.trim_end());assert_eq!(detail["deliveries"].as_array().unwrap().len(),2);
        assert!(detail["deliveries"].as_array().unwrap().iter().all(|row|row["status"]=="waiting"));
        let list=reopened.public_posts(30).await.unwrap();assert_eq!(list[0]["body"].as_str().unwrap().chars().count(),500);assert_eq!(list[0]["truncated"],true);
        for sequence in [0,u64::MAX,2] {assert!(reopened.public_post_detail(sequence).await.is_err());}
        assert!(reopened.retry_public_post(1,"peer-not-approved").await.is_err());
        let stored=reopened.store().await.unwrap().read(1).unwrap();
        let delivery=peers.prepare_delivery("https://node.example/",&pinned[0],stored.clone(),reopened.key.as_ref().unwrap()).unwrap();
        let detail=reopened.public_post_detail(1).await.unwrap();assert_eq!(detail["deliveries"][0]["status"],"unconfirmed");
        peers.save_delivery_receipt(&PeerDeliveryReceipt{status:"accepted".into(),delivery_id:delivery.delivery_id.clone(),portable_event_id:"wrong-event".into(),received_at:"2026-10-01T00:00:00Z".into()}).unwrap();
        assert_eq!(reopened.public_post_detail(1).await.unwrap()["deliveries"][0]["status"],"unconfirmed");
        peers.save_delivery_receipt(&PeerDeliveryReceipt{status:"accepted".into(),delivery_id:delivery.delivery_id,portable_event_id:receipt.portable_event_id,received_at:"2026-10-01T00:00:00Z".into()}).unwrap();
        reopened.store().await.unwrap().mark_delivered(1).unwrap();
        let restarted=PersonalNodeService::load(root.clone()).unwrap();
        let detail=restarted.retry_public_post(1,&ids[0]).await.unwrap(); // cached ACK: no network request
        assert_eq!(detail["deliveries"][0]["status"],"accepted");assert_eq!(detail["deliveries"][1]["status"],"waiting");
        assert_eq!(restarted.store().await.unwrap().chain().next_sequence,2);
        fs::write(root.join("data/receipts/public-post-plan-1.json"),"broken").unwrap();
        assert!(restarted.public_post_detail(1).await.is_err());assert!(restarted.plan_public_post(1,ids).await.is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod public_reply_tests {
    use super::*;
    struct Fixture { root: PathBuf, service: PersonalNodeService }
    impl Fixture {
        fn new(key: bool) -> Self {
            let root = std::env::temp_dir().join(format!("hub-node-public-reply-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let service = PersonalNodeService {
                path: root.join("node.json"), state: Arc::new(RwLock::new(NodeState::new(&root))),
                key: key.then(|| Arc::new(crate::node_identity::NodeKey::create())), encryption_key: None,
                append_lock: Arc::new(Mutex::new(())), artifact_lock: Arc::new(Mutex::new(())), delivery_lock: Arc::new(Mutex::new(())),
            };
            Self { root, service }
        }
        fn settings(&self, enabled: bool) -> UpdateNodeSettings {
            UpdateNodeSettings { device_name: "Fixture node".into(), enabled, launch_at_login: false,
                storage_path: self.root.join("data").to_string_lossy().into_owned(), hub_url: String::new() }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
            assert!(self.root.file_name().unwrap().to_string_lossy().starts_with("hub-node-public-reply-test-"));
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[tokio::test]
    async fn update_returns_public_identity_and_legacy_sync_is_fail_closed() {
        let fixture = Fixture::new(true);
        let before = fixture.service.status().await;
        let expected = serde_json::to_value(before.public_key_jwk.as_ref().unwrap()).unwrap();
        for reply in [fixture.service.update(fixture.settings(true)).await.unwrap()] {
            assert_eq!(serde_json::to_value(reply.public_key_jwk).unwrap(), expected);
            assert_eq!(reply.key_thumbprint, before.key_thumbprint);
            assert_eq!(reply.device_name, "Fixture node");
            let value: serde_json::Value = serde_json::from_slice(&fs::read(&fixture.service.path).unwrap()).unwrap();
            assert!(value["publicKeyJwk"].is_null());
            assert!(value["keyThumbprint"].is_null());
            assert!(!value.as_object().unwrap().contains_key("privateKey"));
        }
        assert!(!expected.as_object().unwrap().contains_key("d"));
        assert_eq!(fixture.service.mark_sync().await.unwrap_err(), "node_sync_confirmation_required");
        assert_eq!(fixture.service.status().await.last_sync_at, before.last_sync_at);
    }
    #[tokio::test]
    async fn an_unavailable_identity_is_not_invented_and_disabled_sync_remains_rejected() {
        let fixture = Fixture::new(false);
        let reply = fixture.service.update(fixture.settings(false)).await.unwrap();
        assert!(reply.public_key_jwk.is_none());
        assert!(reply.key_thumbprint.is_none());
        assert_eq!(fixture.service.mark_sync().await.unwrap_err(), "node_sync_confirmation_required");
    }
    #[tokio::test]
    async fn failed_settings_do_not_replace_or_hide_the_current_identity() {
        let fixture = Fixture::new(true);
        let before = fixture.service.status().await;
        let file = fixture.root.join("not-a-directory"); fs::write(&file, b"fixture").unwrap();
        let mut settings = fixture.settings(true); settings.storage_path = file.to_string_lossy().into_owned();
        assert_eq!(fixture.service.update(settings).await.unwrap_err(), "storage_path_unavailable");
        let after = fixture.service.status().await;
        assert_eq!(after.device_name, before.device_name);
        assert_eq!(after.key_thumbprint, before.key_thumbprint);
        assert_eq!(serde_json::to_value(after.public_key_jwk).unwrap(), serde_json::to_value(before.public_key_jwk).unwrap());
    }
}


#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct NodeSyncPreview { pub context:String, pub items:Vec<NodeSyncItem>, pub page:NodeSyncPage, pub queued:u64, pub excluded:u64 }
#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct NodeSyncPage { pub cursor:u64, pub next_cursor:Option<u64>, pub truncated:bool, pub scanned:u64 }
#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct NodeSyncItem { pub sequence:u64, pub content_id:String, pub portable_event_id:String, pub body_preview:String, pub truncated:bool, pub targets:Vec<NodeSyncTarget> }
#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct NodeSyncTarget { pub peer_id:String, pub node_url:String, pub key_thumbprint:String, pub status:&'static str }
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct NodeSyncDelivery { pub context:String, pub sequence:u64, pub portable_event_id:String, pub peer_id:String, pub node_url:String, pub key_thumbprint:String, pub confirmed:bool }
#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct NodeSyncDeliveryResult { pub context:String, pub sequence:u64, pub portable_event_id:String, pub peer_id:String, pub status:NodeSyncDeliveryStatus, pub complete:bool, pub state:NodeState }
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all="snake_case")]
pub enum NodeSyncDeliveryStatus { Accepted, AlreadyAccepted, Unknown }

fn sync_hex(value:&str, prefix:&str, width:usize)->bool {
    value.strip_prefix(prefix).is_some_and(|rest| rest.len()==width && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}
fn sync_thumb(value:&str)->bool { value.len()==43 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'-'|b'_')) }
fn sync_url(value:&str)->bool {
    value.encode_utf16().count()<=2048 && crate::content_protocol::public_node_origin(value)
        .is_ok_and(|origin| format!("{origin}/")==value)
}
impl NodeSyncDelivery {
    pub fn validate(&self)->Result<(),String> {
        if !self.confirmed { return Err("node_sync_confirmation_required".into()); }
        if !sync_hex(&self.context,"",64) || !(1..=9_007_199_254_740_991).contains(&self.sequence)
            || !sync_hex(&self.portable_event_id,"event:",32) || !sync_hex(&self.peer_id,"peer-",64)
            || !sync_thumb(&self.key_thumbprint) || !sync_url(&self.node_url) {
            return Err("node_sync_invalid_request".into());
        }
        Ok(())
    }
}
fn sync_receipt(receipt:&crate::peer_node::PeerDeliveryReceipt, delivery:&crate::peer_node::PeerDelivery)->bool {
    receipt.delivery_id==delivery.delivery_id && receipt.portable_event_id==delivery.portable_event["id"]
        && matches!(receipt.status.as_str(),"accepted"|"ready") && receipt.received_at.len()<=64
        && chrono::DateTime::parse_from_rfc3339(&receipt.received_at).is_ok()
}
fn sync_peer_record<T:for<'de> Deserialize<'de>>(state:&NodeState, directory:&str, id:&str, limit:u64)->Result<Option<T>,String> {
    if id.len()>100 || id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'-'|b'_')) {
        return Err("node_sync_unavailable".into());
    }
    crate::node_store::read_bounded_json(&PathBuf::from(&state.storage_path).join("peers").join(directory).join(format!("{id}.json")),limit)
        .map_err(|_| "node_sync_unavailable".into())
}

impl PersonalNodeService {
    fn sync_context(&self,state:&NodeState)->Result<String,String> {
        let key=self.key.as_ref().ok_or("node_sync_unavailable")?;
        let bytes=serde_json::to_vec(&(&state.node_id,&state.hub_url,&state.storage_path,key.thumbprint(),state.enabled))
            .map_err(|_| "node_sync_unavailable")?;
        Ok(sha256_hex(&bytes))
    }
    fn sync_owned(&self,state:&NodeState,stored:&crate::node_store::StoredEvent)->bool {
        let Ok(origin)=crate::content_protocol::public_node_origin(&state.hub_url) else { return false; };
        let sender=format!("{origin}/");
        self.public_post_body(stored).is_some() && stored.event["sequence"].as_u64()==Some(stored.sequence)
            && stored.event["payload"]["issuer"]["nodeId"]==sender
            && stored.event["payload"]["envelope"]["issuer"]["nodeId"]==sender
            && stored.event["payload"]["contentId"]==stored.event["payload"]["envelope"]["contentId"]
            && stored.event["id"].as_str().is_some_and(|id| sync_hex(id,"event:",32))
            && stored.event["payload"]["envelope"]["contentId"].as_str().is_some_and(|id|sync_hex(id,"urn:hub:content:",32))
    }
    fn sync_plan(&self,store:&crate::node_store::NodeStore,stored:&crate::node_store::StoredEvent)->Result<Option<PublicPostPlan>,String> {
        let plan=store.read_receipt_bounded::<PublicPostPlan>(&format!("public-post-plan-{}",stored.sequence))
            .map_err(|_| "node_sync_unavailable")?;
        if let Some(plan)=&plan {
            let mut seen=std::collections::HashSet::new();
            if plan.portable_event_id!=stored.event["id"] || plan.targets.is_empty() || plan.targets.len()>8
                || plan.targets.iter().any(|target| !seen.insert(&target.peer_id) || !sync_hex(&target.peer_id,"peer-",64)
                    || !sync_url(&target.node_id) || !sync_thumb(&target.signing_key_thumbprint)) {
                return Err("node_sync_unavailable".into());
            }
        }
        Ok(plan)
    }
    fn sync_target(&self,state:&NodeState,stored:&crate::node_store::StoredEvent,target:&PublicPostTarget)
        ->Result<(&'static str,Option<crate::peer_node::PinnedPeer>),String> {
        let peer=sync_peer_record::<crate::peer_node::PinnedPeer>(state,"pinned",&target.peer_id,16*1024)?;
        let available=peer.as_ref().is_some_and(|peer| peer.peer_id==target.peer_id && peer.node_id==target.node_id
            && peer.signing_key_thumbprint==target.signing_key_thumbprint
            && crate::node_identity::NodeKey::thumbprint_jwk(&peer.signing_key_jwk).as_deref()==Some(target.signing_key_thumbprint.as_str()));
        if !available { return Ok(("unavailable",None)); }
        let event_id=stored.event["id"].as_str().ok_or("node_sync_unavailable")?;
        let id=format!("delivery-{}",sha256_hex(format!("{}\0{event_id}",target.peer_id).as_bytes()));
        let delivery=sync_peer_record::<crate::peer_node::PeerDelivery>(state,"outbox",&id,2*1024*1024)?;
        let accepted=if let Some(delivery)=delivery.as_ref() {
            if delivery.portable_event!=stored.event || delivery.portable_signature!=stored.signature
                || delivery.recipient_node_id!=target.node_id
                || delivery.sender_node_id!=stored.event["payload"]["envelope"]["issuer"]["nodeId"]
                || !sync_hex(&delivery.delivery_id,"delivery-",64) { return Err("node_sync_unavailable".into()); }
            let mut unsigned=serde_json::to_value(delivery).map_err(|_|"node_sync_unavailable")?;
            unsigned.as_object_mut().unwrap().remove("signature");
            if !self.key.as_ref().is_some_and(|key|key.verify(&crate::node_log::canonical_json(&unsigned),&delivery.signature)) { return Err("node_sync_unavailable".into()); }
            if let Some(receipt)=sync_peer_record::<crate::peer_node::PeerDeliveryReceipt>(state,"receipts",&delivery.delivery_id,16*1024)? {
                if !sync_receipt(&receipt,delivery) { return Err("node_sync_unavailable".into()); }
                true
            } else { false }
        } else { false };
        Ok((if accepted { "accepted" } else if delivery.is_some() { "unconfirmed" } else { "waiting" },peer))
    }
    pub async fn sync_preview(&self,cursor:u64)->Result<NodeSyncPreview,String> {
        if cursor>9_007_199_254_740_991 { return Err("node_sync_invalid_request".into()); }
        let _guard=self.delivery_lock.lock().await;
        let _append=self.append_lock.lock().await;
        let state=self.state.read().await.clone();
        let context=self.sync_context(&state)?;
        let store=crate::node_store::NodeStore::open_readonly(&state.storage_path).map_err(|_|"node_sync_unavailable")?;
        let chain=store.chain_bounded().map_err(|_|"node_sync_unavailable")?;
        let pending_commit=store.pending_delivery_sequence().map_err(|_|"node_sync_unavailable")?;
        let mut sequence=cursor.max(1); let mut scanned=0; let mut excluded=0; let mut items=Vec::new();
        while sequence<chain.next_sequence && scanned<512 && items.len()<16 {
            let current=sequence; sequence+=1; scanned+=1;
            let item=(|| {
                let stored=store.read_bounded(current).ok().flatten()?;
                if stored.sequence!=current || stored.delivered && pending_commit!=Some(current) || !self.sync_owned(&state,&stored) { return None; }
                let plan=self.sync_plan(&store,&stored).ok().flatten()?;
                let targets=plan.targets.iter().map(|target|NodeSyncTarget { peer_id:target.peer_id.clone(),node_url:target.node_id.clone(),
                    key_thumbprint:target.signing_key_thumbprint.clone(),status:self.sync_target(&state,&stored,target).map(|row|row.0).unwrap_or("unavailable") }).collect::<Vec<_>>();
                let body=self.public_post_body(&stored)?;
                Some(NodeSyncItem { sequence:current,content_id:stored.event["payload"]["envelope"]["contentId"].as_str()?.into(),
                    portable_event_id:plan.portable_event_id,body_preview:body.chars().take(300).collect(),truncated:body.chars().count()>300,targets })
            })();
            if let Some(item)=item { items.push(item); } else { excluded+=1; }
        }
        let next_cursor=(sequence<chain.next_sequence).then_some(sequence);
        Ok(NodeSyncPreview { context,items,page:NodeSyncPage { cursor,next_cursor,truncated:next_cursor.is_some(),scanned },queued:chain.pending,excluded })
    }
    async fn sync_result(&self,input:&NodeSyncDelivery,status:NodeSyncDeliveryStatus,complete:bool)->NodeSyncDeliveryResult {
        NodeSyncDeliveryResult { context:input.context.clone(),sequence:input.sequence,portable_event_id:input.portable_event_id.clone(),
            peer_id:input.peer_id.clone(),status,complete,state:self.status().await }
    }
    pub async fn sync_receipt(&self,input:NodeSyncDelivery)->Result<NodeSyncDeliveryResult,String> {
        if input.confirmed { return Err("node_sync_invalid_request".into()); }
        let mut identity=input.clone(); identity.confirmed=true; identity.validate()?;
        let _guard=self.delivery_lock.lock().await;
        let _append=self.append_lock.lock().await;
        let state=self.state.read().await.clone();
        if self.sync_context(&state)?!=input.context { return Err("node_sync_context_changed".into()); }
        let store=crate::node_store::NodeStore::open_readonly(&state.storage_path).map_err(|_|"node_sync_unavailable")?;
        let pending_commit=store.pending_delivery_sequence().map_err(|_|"node_sync_unavailable")?;
        let stored=store.read_bounded(input.sequence).map_err(|_|"node_sync_unavailable")?.ok_or("node_sync_unavailable")?;
        if stored.sequence!=input.sequence || !self.sync_owned(&state,&stored) || stored.event["id"]!=input.portable_event_id {
            return Err("node_sync_context_changed".into());
        }
        let plan=self.sync_plan(&store,&stored)?.ok_or("node_sync_context_changed")?;
        let target=plan.targets.iter().find(|target|target.peer_id==input.peer_id).ok_or("node_sync_context_changed")?;
        if target.node_id!=input.node_url || target.signing_key_thumbprint!=input.key_thumbprint { return Err("node_sync_context_changed".into()); }
        let (status,peer)=self.sync_target(&state,&stored,target)?;
        if peer.is_none() { return Err("node_sync_context_changed".into()); }
        let complete=stored.delivered && pending_commit!=Some(input.sequence)
            && plan.targets.iter().all(|target|self.sync_target(&state,&stored,target).is_ok_and(|row|row.0=="accepted"));
        Ok(self.sync_result(&input,if status=="accepted" { NodeSyncDeliveryStatus::AlreadyAccepted } else { NodeSyncDeliveryStatus::Unknown },complete).await)
    }
    pub async fn sync_delivery(&self,input:NodeSyncDelivery)->Result<NodeSyncDeliveryResult,String> {
        input.validate()?;
        match tokio::time::timeout(std::time::Duration::from_secs(20),
            self.sync_delivery_with(&input,sync_send,std::time::Duration::from_secs(20))).await {
            Ok(result)=>result,
            Err(_)=>Ok(self.sync_result(&input,NodeSyncDeliveryStatus::Unknown,false).await),
        }
    }
    async fn sync_delivery_with<F,Fut>(&self,input:&NodeSyncDelivery,send:F,timeout:std::time::Duration)->Result<NodeSyncDeliveryResult,String>
        where F:FnOnce(crate::peer_node::PeerDelivery,crate::peer_node::PinnedPeer)->Fut,
        Fut:std::future::Future<Output=Result<crate::peer_node::PeerDeliveryReceipt,()>> {
        input.validate()?;
        let _guard=self.delivery_lock.lock().await;
        let state=self.state.read().await.clone();
        if !state.enabled { return Err("node_disabled".into()); }
        if self.sync_context(&state)?!=input.context { return Err("node_sync_context_changed".into()); }
        let store=crate::node_store::NodeStore::open_readonly(&state.storage_path).map_err(|_|"node_sync_unavailable")?;
        {
            let _append=self.append_lock.lock().await;
            store.pending_delivery_sequence().map_err(|_|"node_sync_unavailable")?;
        }
        let stored=store.read_bounded(input.sequence).map_err(|_|"node_sync_unavailable")?.ok_or("node_sync_unavailable")?;
        if stored.sequence!=input.sequence || !self.sync_owned(&state,&stored) || stored.event["id"]!=input.portable_event_id {
            return Err("node_sync_context_changed".into());
        }
        let plan=self.sync_plan(&store,&stored)?.ok_or("node_sync_context_changed")?;
        let target=plan.targets.iter().find(|target|target.peer_id==input.peer_id).ok_or("node_sync_context_changed")?;
        if target.node_id!=input.node_url || target.signing_key_thumbprint!=input.key_thumbprint { return Err("node_sync_context_changed".into()); }
        let (status,peer)=self.sync_target(&state,&stored,target)?;
        let peer=peer.ok_or("node_sync_context_changed")?;
        let peers=crate::peer_node::PeerStore::open(&state.storage_path).map_err(|_|"node_sync_unavailable")?;
        let key=self.key.as_ref().ok_or("node_sync_unavailable")?;
        let sender=format!("{}/",crate::content_protocol::public_node_origin(&state.hub_url).map_err(|_|"node_sync_unavailable")?);
        let mut fresh=false;
        let result_status=if status=="accepted" { NodeSyncDeliveryStatus::AlreadyAccepted } else {
            if stored.delivered { return Err("node_sync_context_changed".into()); }
            let delivery=peers.prepare_delivery(&sender,&peer,stored.clone(),key).map_err(|_|"node_sync_unavailable")?;
            let result=tokio::time::timeout(timeout,send(delivery.clone(),peer)).await;
            let Ok(Ok(receipt))=result else { return Ok(self.sync_result(input,NodeSyncDeliveryStatus::Unknown,false).await); };
            if !sync_receipt(&receipt,&delivery) || peers.save_delivery_receipt(&receipt).is_err() {
                return Ok(self.sync_result(input,NodeSyncDeliveryStatus::Unknown,false).await);
            }
            fresh=true; NodeSyncDeliveryStatus::Accepted
        };
        let complete=plan.targets.iter().all(|target|self.sync_target(&state,&stored,target).is_ok_and(|row|row.0=="accepted"));
        let _append=self.append_lock.lock().await;
        store.chain_bounded().map_err(|_|"node_sync_unavailable")?;
        let reconciled=if complete { store.mark_delivered(input.sequence).map_err(|_|"node_sync_unavailable")?; true }
            else { store.recover_pending_delivery().map_err(|_|"node_sync_unavailable")? };
        if fresh || reconciled {
            let pending=store.chain_bounded().map_err(|_|"node_sync_unavailable")?.pending;
            let mut current=self.state.write().await;
            current.queued_items=pending;
            if fresh { current.last_sync_at=Some(now()); current.last_sync_confirmed=true; current.sync_state="ready".into(); }
            save_atomic(&self.path,&current).map_err(|_|"node_sync_unavailable")?;
        }
        Ok(self.sync_result(input,result_status,complete).await)
    }
}

async fn sync_send(delivery:crate::peer_node::PeerDelivery,peer:crate::peer_node::PinnedPeer)->Result<crate::peer_node::PeerDeliveryReceipt,()> {
    let (client,origin)=public_peer_client(&peer.node_id).await.map_err(|_|())?;
    let mut response=client.post(format!("{origin}/p2p/v1/inbox")).json(&delivery).send().await.map_err(|_|())?;
    if !response.status().is_success() { return Err(()); }
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|())? {
        if bytes.len().saturating_add(chunk.len())>16*1024 { return Err(()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_|())
}


#[cfg(test)]
mod confirmed_sync_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize,Ordering};
    struct Fixture { root:PathBuf, node:PersonalNodeService }
    impl Fixture {
        async fn new()->Self {
            let root=std::env::temp_dir().join(format!("hub-confirmed-sync-{}",uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let mut state=NodeState::new(&root); state.device_name="Synthetic node".into(); state.hub_url="https://node.example".into();
            state.last_sync_at=Some(3); state.last_sync_confirmed=false;
            let node=PersonalNodeService { path:root.join("node.json"),state:Arc::new(RwLock::new(state)),
                key:Some(Arc::new(crate::node_identity::NodeKey::create())),encryption_key:None,
                append_lock:Arc::new(Mutex::new(())),artifact_lock:Arc::new(Mutex::new(())),delivery_lock:Arc::new(Mutex::new(())) };
            let peers=node.peer_store().await.unwrap();
            for url in ["https://one.example","https://two.example"] {
                let key=crate::node_identity::NodeKey::create(); let encryption=crate::content_e2ee::NodeEncryptionKey::create();
                let preview=peers.prepare(url,crate::peer_node::identity(url,&key,encryption.public_jwk(),encryption.thumbprint()).unwrap()).unwrap();
                node.confirm_peer(crate::peer_node::ConfirmPeer { preview_id:preview.preview_id,confirmed_fingerprints:true }).await.unwrap();
            }
            Self { root,node }
        }
        async fn post(&self,body:&str,planned:bool)->u64 {
            let preview=self.node.preview_public_content(crate::content_protocol::PublicContentDraft {kind:"post".into(),title:"".into(),body:body.into(),language:"ja".into()}).await.unwrap();
            let receipt=self.node.publish_public_content(crate::content_protocol::ConfirmPublicContent {preview_id:preview.preview_id,confirmed_public:true}).await.unwrap();
            if planned { self.node.plan_public_post(receipt.sequence,self.node.peers().await.into_iter().map(|peer|peer.peer_id).collect()).await.unwrap(); }
            receipt.sequence
        }
        async fn input(&self,sequence:u64,target:usize)->NodeSyncDelivery {
            let preview=self.node.sync_preview(sequence).await.unwrap(); let item=&preview.items[0]; let peer=&item.targets[target];
            NodeSyncDelivery { context:preview.context,sequence,portable_event_id:item.portable_event_id.clone(),peer_id:peer.peer_id.clone(),
                node_url:peer.node_url.clone(),key_thumbprint:peer.key_thumbprint.clone(),confirmed:true }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.root.parent()==Some(std::env::temp_dir().as_path()) && self.root.file_name().unwrap().to_string_lossy().starts_with("hub-confirmed-sync-") { let _=fs::remove_dir_all(&self.root); }
        }
    }
    fn ack(delivery:&crate::peer_node::PeerDelivery)->crate::peer_node::PeerDeliveryReceipt {
        crate::peer_node::PeerDeliveryReceipt { status:"accepted".into(),delivery_id:delivery.delivery_id.clone(),
            portable_event_id:delivery.portable_event["id"].as_str().unwrap().into(),received_at:"2026-10-01T00:00:00Z".into() }
    }
    async fn deliver(node:&PersonalNodeService,input:&NodeSyncDelivery,calls:&AtomicUsize)->NodeSyncDeliveryResult {
        node.sync_delivery_with(input,|delivery,peer| async move {
            assert_eq!(peer.node_id,input.node_url); calls.fetch_add(1,Ordering::SeqCst); Ok(ack(&delivery))
        },std::time::Duration::from_secs(1)).await.unwrap()
    }
    #[tokio::test]
    async fn preview_is_readonly_and_pages_bound_generic_exclusions_and_unicode_body() {
        let fixture=Fixture::new().await;
        for _ in 0..512 { fixture.node.append_event("generic.fixture",serde_json::json!({"body":"excluded"})).await.unwrap(); }
        for _ in 0..17 { fixture.post(&"🌿".repeat(301),true).await; }
        let before=fixture.node.status().await;
        let first=fixture.node.sync_preview(0).await.unwrap();
        assert!(first.items.is_empty()); assert_eq!(first.page.scanned,512); assert_eq!(first.excluded,512);
        assert_eq!(first.page.next_cursor,Some(513)); assert_eq!(first.queued,529);
        let second=fixture.node.sync_preview(513).await.unwrap();
        assert_eq!(second.items.len(),16); assert_eq!(second.page.next_cursor,Some(529));
        assert!(second.items.iter().all(|item|item.body_preview.chars().count()==300 && item.truncated && item.targets.len()==2));
        let last=fixture.node.sync_preview(529).await.unwrap(); assert_eq!(last.items.len(),1); assert_eq!(last.page.next_cursor,None);
        assert!(fixture.node.sync_preview(u64::MAX).await.is_err());
        let after=fixture.node.status().await; assert_eq!(before.last_sync_at,after.last_sync_at); assert!(!after.last_sync_confirmed);
        assert_eq!(fixture.node.store().await.unwrap().chain().pending,529);
    }
    #[tokio::test]
    async fn empty_preview_never_initializes_event_storage_or_state() {
        let fixture=Fixture::new().await;
        let before=fixture.node.status().await;
        assert!(!fixture.node.path.exists());
        for path in ["events","previews","receipts","chain.json"] { assert!(!fixture.root.join("data").join(path).exists()); }
        let preview=fixture.node.sync_preview(0).await.unwrap();
        assert!(preview.items.is_empty()); assert_eq!(preview.queued,0); assert_eq!(preview.page.next_cursor,None);
        for path in ["events","previews","receipts","chain.json"] { assert!(!fixture.root.join("data").join(path).exists()); }
        assert!(!fixture.node.path.exists());
        assert_eq!(fixture.node.status().await.last_sync_at,before.last_sync_at);
    }
    #[tokio::test]
    async fn missing_chain_with_existing_event_fails_without_reset_or_mutation() {
        let fixture=Fixture::new().await;
        let event=fixture.node.append_event("generic.fixture",serde_json::json!({"body":"synthetic event"})).await.unwrap();
        let event_path=fixture.root.join("data/events").join(format!("{:012}.json",event.sequence));
        let event_before=fs::read(&event_path).unwrap(); let state_before=fs::read(&fixture.node.path).unwrap();
        let chain_path=fixture.root.join("data/chain.json"); fs::remove_file(&chain_path).unwrap();
        assert_eq!(fixture.node.sync_preview(0).await.unwrap_err(),"node_sync_unavailable");
        assert!(!chain_path.exists()); assert_eq!(fs::read(event_path).unwrap(),event_before);
        assert_eq!(fs::read(&fixture.node.path).unwrap(),state_before);
        assert!(!fixture.node.store().await.unwrap().read(event.sequence).unwrap().delivered);
    }
    #[tokio::test]
    async fn corrupt_chain_after_preview_blocks_send_and_mark_without_reset() {
        for missing in [false,true] {
            let fixture=Fixture::new().await; let sequence=fixture.post("chain guard text",true).await;
            fixture.node.append_event("generic.fixture",serde_json::json!({})).await.unwrap(); fixture.post("unplanned text",false).await;
            let input=fixture.input(sequence,0).await;
            let event_path=fixture.root.join("data/events").join(format!("{sequence:012}.json"));
            let event_before=fs::read(&event_path).unwrap(); let state_before=fs::read(&fixture.node.path).unwrap();
            let chain=fixture.root.join("data/chain.json");
            if missing { fs::remove_file(&chain).unwrap(); } else { fs::write(&chain,b"invalid").unwrap(); }
            assert_eq!(fixture.node.sync_delivery_with(&input,|_,_|async {panic!("must not dispatch")},std::time::Duration::from_secs(1)).await.unwrap_err(),"node_sync_unavailable");
            assert_eq!(fs::read(event_path).unwrap(),event_before); assert_eq!(fs::read(&fixture.node.path).unwrap(),state_before);
            if missing { assert!(!chain.exists()); } else { assert_eq!(fs::read(chain).unwrap(),b"invalid"); }
            assert!(!fixture.root.join("data/delivery-commit.json").exists());
        }
    }
    #[tokio::test]
    async fn event_written_chain_save_failure_is_visible_and_cached_retry_decrements_once() {
        let fixture=Fixture::new().await; let sequence=fixture.post("interrupted text",true).await;
        fixture.node.append_event("generic.fixture",serde_json::json!({})).await.unwrap(); let unplanned=fixture.post("unplanned text",false).await;
        let a=fixture.input(sequence,0).await; let b=fixture.input(sequence,1).await; let calls=AtomicUsize::new(0);
        deliver(&fixture.node,&a,&calls).await;
        let blocker=fixture.root.join("data/chain.tmp"); fs::create_dir(&blocker).unwrap();
        let counter=&calls;
        let failed=fixture.node.sync_delivery_with(&b,|delivery,_|async move {counter.fetch_add(1,Ordering::SeqCst);Ok(ack(&delivery))},std::time::Duration::from_secs(1)).await;
        assert_eq!(failed.unwrap_err(),"node_sync_unavailable");
        let store=fixture.node.store().await.unwrap(); assert!(store.read(sequence).unwrap().delivered);
        assert_eq!(store.chain_bounded().unwrap().pending,3); assert_eq!(store.pending_delivery_sequence().unwrap(),Some(sequence));
        let event_bytes=fs::read(fixture.root.join("data/events").join(format!("{sequence:012}.json"))).unwrap();
        let chain_bytes=fs::read(fixture.root.join("data/chain.json")).unwrap();
        let preview=fixture.node.sync_preview(0).await.unwrap(); assert_eq!(preview.items.len(),1); assert_eq!(preview.queued,3);
        let mut proof_input=b.clone(); proof_input.confirmed=false;
        let proof=fixture.node.sync_receipt(proof_input).await.unwrap(); assert_eq!(proof.status,NodeSyncDeliveryStatus::AlreadyAccepted); assert!(!proof.complete);
        assert_eq!(fs::read(fixture.root.join("data/chain.json")).unwrap(),chain_bytes);
        assert_eq!(fs::read(fixture.root.join("data/events").join(format!("{sequence:012}.json"))).unwrap(),event_bytes);
        fs::remove_dir(blocker).unwrap();
        let fixed=deliver(&fixture.node,&b,&calls).await; assert_eq!(fixed.status,NodeSyncDeliveryStatus::AlreadyAccepted); assert!(fixed.complete);
        assert_eq!(fixed.state.queued_items,2); assert_eq!(calls.load(Ordering::SeqCst),2);
        assert_eq!(store.pending_delivery_sequence().unwrap(),None); assert_eq!(store.chain_bounded().unwrap().pending,2);
        assert!(!store.read(2).unwrap().delivered); assert!(!store.read(unplanned).unwrap().delivered);
        deliver(&fixture.node,&b,&calls).await; assert_eq!(store.chain_bounded().unwrap().pending,2); assert_eq!(calls.load(Ordering::SeqCst),2);
    }
    #[tokio::test]
    async fn after_chain_saved_before_intent_cleanup_keeps_zero_queue_reconciliation_visible() {
        let fixture=Fixture::new().await; let sequence=fixture.post("cleanup text",true).await;
        let a=fixture.input(sequence,0).await; let b=fixture.input(sequence,1).await; let calls=AtomicUsize::new(0);
        let store=fixture.node.store().await.unwrap(); let before=store.chain_bounded().unwrap(); let event=store.read(sequence).unwrap();
        deliver(&fixture.node,&a,&calls).await; deliver(&fixture.node,&b,&calls).await;
        let after=store.chain_bounded().unwrap(); assert_eq!(after.pending,0);
        // Exact durable state at the interruption between chain write and intent removal.
        fs::write(fixture.root.join("data/delivery-commit.json"),serde_json::to_vec(&serde_json::json!({"version":1,"sequence":sequence,"hash":event.hash,"before":before,"after":after})).unwrap()).unwrap();
        let preview=fixture.node.sync_preview(0).await.unwrap(); assert_eq!(preview.queued,0); assert_eq!(preview.items.len(),1);
        assert!(preview.items[0].targets.iter().all(|target|target.status=="accepted"));
        let mut read=b.clone(); read.confirmed=false; assert!(!fixture.node.sync_receipt(read).await.unwrap().complete);
        let fixed=deliver(&fixture.node,&b,&calls).await; assert!(fixed.complete); assert_eq!(fixed.state.queued_items,0);
        assert_eq!(store.pending_delivery_sequence().unwrap(),None); assert_eq!(store.chain_bounded().unwrap().pending,0);
        deliver(&fixture.node,&b,&calls).await; assert_eq!(store.chain_bounded().unwrap().pending,0); assert_eq!(calls.load(Ordering::SeqCst),2);
    }
    #[tokio::test]
    async fn partial_ack_replay_and_completion_preserve_generic_and_unplanned_queue() {
        let fixture=Fixture::new().await; let sequence=fixture.post("owned public text",true).await;
        fixture.node.append_event("generic.fixture",serde_json::json!({})).await.unwrap(); fixture.post("unplanned public text",false).await;
        let a=fixture.input(sequence,0).await; let b=fixture.input(sequence,1).await; let calls=AtomicUsize::new(0);
        let first=deliver(&fixture.node,&a,&calls).await;
        assert_eq!(first.status,NodeSyncDeliveryStatus::Accepted); assert!(!first.complete); assert!(first.state.last_sync_confirmed);
        assert!(first.state.public_key_jwk.is_some()); assert_eq!(first.state.queued_items,3);
        let repeat=deliver(&fixture.node,&a,&calls).await;
        assert_eq!(repeat.status,NodeSyncDeliveryStatus::AlreadyAccepted); assert!(!repeat.complete);
        assert_eq!(repeat.state.last_sync_at,first.state.last_sync_at); assert_eq!(calls.load(Ordering::SeqCst),1);
        let second=deliver(&fixture.node,&b,&calls).await;
        assert!(second.complete); assert_eq!(second.state.queued_items,2); assert_eq!(calls.load(Ordering::SeqCst),2);
        assert!(fixture.node.store().await.unwrap().read(sequence).unwrap().delivered);
        let preview=fixture.node.sync_preview(0).await.unwrap(); assert!(preview.items.is_empty()); assert_eq!(preview.queued,2); assert_eq!(preview.excluded,3);
    }
    #[tokio::test]
    async fn cached_manual_ack_finishes_only_owned_plan_without_fake_current_time() {
        let fixture=Fixture::new().await; let sequence=fixture.post("cached text",true).await;
        let stored=fixture.node.store().await.unwrap().read(sequence).unwrap(); let peers=fixture.node.peer_store().await.unwrap();
        for peer in peers.list() {
            let delivery=peers.prepare_delivery("https://node.example/",&peer,stored.clone(),fixture.node.key.as_ref().unwrap()).unwrap();
            peers.save_delivery_receipt(&ack(&delivery)).unwrap();
        }
        let readonly=fixture.node.sync_preview(0).await.unwrap(); assert_eq!(readonly.items.len(),1); assert_eq!(readonly.queued,1);
        assert!(readonly.items[0].targets.iter().all(|target|target.status=="accepted"));
        assert!(!fixture.node.store().await.unwrap().read(sequence).unwrap().delivered);
        let input=fixture.input(sequence,0).await;
        let calls=AtomicUsize::new(0); let result=deliver(&fixture.node,&input,&calls).await;
        assert_eq!(result.status,NodeSyncDeliveryStatus::AlreadyAccepted); assert!(result.complete); assert_eq!(calls.load(Ordering::SeqCst),0);
        assert_eq!(result.state.last_sync_at,Some(3)); assert!(!result.state.last_sync_confirmed); assert_eq!(result.state.queued_items,0);
        let repeat=deliver(&fixture.node,&input,&calls).await;
        assert_eq!(repeat.status,NodeSyncDeliveryStatus::AlreadyAccepted); assert!(repeat.complete);
        assert_eq!(repeat.state.queued_items,0); assert_eq!(calls.load(Ordering::SeqCst),0);
        assert_eq!(fixture.node.store().await.unwrap().chain().pending,0);
        assert!(fixture.node.store().await.unwrap().read(sequence).unwrap().delivered);
    }
    #[tokio::test]
    async fn lost_reply_can_be_proved_readonly_after_delivered_post_disappears() {
        let fixture=Fixture::new().await; let sequence=fixture.post("reply loss text",true).await;
        let a=fixture.input(sequence,0).await; let b=fixture.input(sequence,1).await; let calls=AtomicUsize::new(0);
        let mut read=a.clone(); read.confirmed=false;
        assert_eq!(fixture.node.sync_receipt(read.clone()).await.unwrap().status,NodeSyncDeliveryStatus::Unknown);
        deliver(&fixture.node,&a,&calls).await; let last=deliver(&fixture.node,&b,&calls).await;
        assert!(last.complete); assert!(fixture.node.sync_preview(0).await.unwrap().items.is_empty());
        let before=fixture.node.status().await;
        let proof=fixture.node.sync_receipt(read).await.unwrap();
        assert_eq!(proof.status,NodeSyncDeliveryStatus::AlreadyAccepted); assert!(proof.complete);
        assert_eq!(proof.context,a.context); assert_eq!(proof.sequence,a.sequence); assert_eq!(proof.portable_event_id,a.portable_event_id); assert_eq!(proof.peer_id,a.peer_id);
        assert_eq!(proof.state.last_sync_at,before.last_sync_at); assert_eq!(calls.load(Ordering::SeqCst),2);
        assert_eq!(fixture.node.sync_receipt(a).await.unwrap_err(),"node_sync_invalid_request");
    }
    #[tokio::test]
    async fn timeout_and_invalid_ack_remain_unknown_without_receipt_or_timestamp() {
        let fixture=Fixture::new().await; let sequence=fixture.post("timeout text",true).await; let input=fixture.input(sequence,0).await;
        let calls=AtomicUsize::new(0);
        let result=fixture.node.sync_delivery_with(&input,|delivery,_| {
            let counter=&calls;
            async move { counter.fetch_add(1,Ordering::SeqCst); tokio::time::sleep(std::time::Duration::from_secs(1)).await; Ok(ack(&delivery)) }
        },std::time::Duration::from_millis(1)).await.unwrap();
        assert_eq!(result.status,NodeSyncDeliveryStatus::Unknown); assert_eq!(calls.load(Ordering::SeqCst),1);
        assert_eq!(result.state.last_sync_at,Some(3)); assert!(!result.state.last_sync_confirmed); assert!(!result.complete);
        assert_eq!(fixture.node.sync_preview(0).await.unwrap().items[0].targets[0].status,"unconfirmed");
        let result=fixture.node.sync_delivery_with(&input,|delivery,_| async move {
            let mut receipt=ack(&delivery); receipt.portable_event_id="event:wrong".into(); Ok(receipt)
        },std::time::Duration::from_secs(1)).await.unwrap();
        assert_eq!(result.status,NodeSyncDeliveryStatus::Unknown); assert_eq!(result.state.last_sync_at,Some(3));
    }
    #[tokio::test]
    async fn changed_context_key_or_peer_never_dispatches_and_settings_serialize_with_delivery() {
        let fixture=Fixture::new().await; let sequence=fixture.post("race text",true).await; let input=fixture.input(sequence,0).await;
        let mut changed_key=fixture.node.clone(); changed_key.key=Some(Arc::new(crate::node_identity::NodeKey::create()));
        assert_eq!(changed_key.sync_delivery_with(&input,|_,_| async { panic!("must not send") },std::time::Duration::from_secs(1)).await.unwrap_err(),"node_sync_context_changed");
        let (entered_tx,entered)=tokio::sync::oneshot::channel(); let (release,ready)=tokio::sync::oneshot::channel();
        let sending=fixture.node.clone(); let copied=input.clone();
        let task=tokio::spawn(async move { sending.sync_delivery_with(&copied,|delivery,_| async move {
            entered_tx.send(()).unwrap(); ready.await.unwrap(); Ok(ack(&delivery))
        },std::time::Duration::from_secs(2)).await });
        entered.await.unwrap(); let updating=fixture.node.clone(); let path=fixture.root.join("data").to_string_lossy().into_owned();
        let update=tokio::spawn(async move { updating.update(UpdateNodeSettings { device_name:"Changed".into(),enabled:false,launch_at_login:false,storage_path:path,hub_url:"https://node.example".into() }).await });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await; assert!(!update.is_finished());
        release.send(()).unwrap(); assert_eq!(task.await.unwrap().unwrap().status,NodeSyncDeliveryStatus::Accepted);
        update.await.unwrap().unwrap();
        assert_eq!(fixture.node.sync_delivery_with(&input,|_,_| async { panic!("must not send") },std::time::Duration::from_secs(1)).await.unwrap_err(),"node_disabled");
        fixture.node.state.write().await.enabled=true;
        let peers=fixture.node.peer_store().await.unwrap(); let mut peer=peers.get(&input.peer_id).unwrap();
        let changed=crate::node_identity::NodeKey::create(); peer.signing_key_jwk=changed.public_jwk(); peer.signing_key_thumbprint=changed.thumbprint();
        fs::write(fixture.root.join("data/peers/pinned").join(format!("{}.json",input.peer_id)),serde_json::to_vec(&peer).unwrap()).unwrap();
        assert_eq!(fixture.node.sync_delivery_with(&input,|_,_| async { panic!("must not send") },std::time::Duration::from_secs(1)).await.unwrap_err(),"node_sync_context_changed");
    }
    #[tokio::test]
    async fn corrupted_or_oversized_records_are_excluded_and_broken_chain_fails_closed() {
        let fixture=Fixture::new().await; let sequence=fixture.post("bounded text",true).await;
        fs::write(fixture.root.join("data/receipts").join(format!("public-post-plan-{sequence}.json")),"invalid").unwrap();
        let preview=fixture.node.sync_preview(0).await.unwrap(); assert!(preview.items.is_empty()); assert_eq!(preview.excluded,1); assert_eq!(preview.queued,1);
        fs::write(fixture.root.join("data/receipts").join(format!("public-post-plan-{sequence}.json")),vec![b' ';16*1024+1]).unwrap();
        assert_eq!(fixture.node.sync_preview(0).await.unwrap().excluded,1);
        fs::write(fixture.root.join("data/events").join(format!("{sequence:012}.json")),vec![b' ';2*1024*1024+1]).unwrap();
        assert_eq!(fixture.node.sync_preview(0).await.unwrap().excluded,1);
        fs::write(fixture.root.join("data/chain.json"),vec![b' ';64*1024+1]).unwrap();
        assert_eq!(fixture.node.sync_preview(0).await.unwrap_err(),"node_sync_unavailable");
    }
    #[tokio::test]
    async fn input_is_closed_and_legacy_timestamp_is_not_delivery_evidence() {
        let fixture=Fixture::new().await; let sequence=fixture.post("input text",true).await; let mut input=fixture.input(sequence,0).await;
        let value=serde_json::json!({"context":input.context,"sequence":input.sequence,"portableEventId":input.portable_event_id,
            "peerId":input.peer_id,"nodeUrl":input.node_url,"keyThumbprint":input.key_thumbprint,"confirmed":true});
        assert!(serde_json::from_value::<NodeSyncDelivery>(value.clone()).unwrap().validate().is_ok());
        let mut unknown=value.clone(); unknown["script"]=serde_json::json!("not allowed"); assert!(serde_json::from_value::<NodeSyncDelivery>(unknown).is_err());
        let mut missing=value; missing.as_object_mut().unwrap().remove("confirmed"); assert!(serde_json::from_value::<NodeSyncDelivery>(missing).is_err());
        input.sequence=u64::MAX; assert!(input.validate().is_err()); input.sequence=sequence; input.confirmed=false; assert!(input.validate().is_err());
        input.confirmed=true; input.node_url="https://user:secret@one.example/".into(); assert!(input.validate().is_err());
        assert_eq!(fixture.node.mark_sync().await.unwrap_err(),"node_sync_confirmation_required");
        let state=fixture.node.status().await; assert_eq!(state.last_sync_at,Some(3)); assert!(!state.last_sync_confirmed);
        let mut legacy=serde_json::to_value(state).unwrap(); legacy.as_object_mut().unwrap().remove("lastSyncConfirmed");
        assert!(!serde_json::from_value::<NodeState>(legacy).unwrap().last_sync_confirmed);
    }
}

/// Startup housekeeping for transient files only: expired peer deliveries and
/// abandoned artifact uploads. Artifacts, blobs and the peer-media cache are
/// never touched. Failures are ignored; the next start tries again.
pub(crate) fn purge_stale_node_files(storage_path: &str) {
    let now = chrono::Utc::now();
    if let Ok(peers) = crate::peer_node::PeerStore::open(storage_path) {
        peers.purge_expired(now);
    }
    if let Ok(artifacts) = crate::artifact_store::ArtifactStore::open(storage_path) {
        artifacts.purge_abandoned_uploads(now);
    }
}
