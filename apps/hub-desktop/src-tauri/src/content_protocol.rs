use base64::Engine;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::{
    artifact_store::{ArtifactManifest, ArtifactUpload},
    content_e2ee::{EncryptedRepresentation, EncryptionMetadata},
    node_identity::NodeKey,
    node_log::canonical_json,
    node_store::NodeStore,
    personal_node::NodeState,
};

const ENVELOPE_TYPE: &str = "https://hub.jkamma.com/spec/content-envelope/v1";
const EVENT_TYPE: &str = "https://hub.jkamma.com/spec/content-event/v1";
const PREVIEW_TTL_MINUTES: i64 = 15;
const MAX_BODY_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicContentDraft {
    pub kind: String,
    pub title: String,
    pub body: String,
    pub language: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateContentDraft {
    pub kind: String,
    pub title: String,
    pub body: String,
    pub language: String,
    pub recipient_peer_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateArtifactFinalize {
    pub recipient_peer_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedPublicContent {
    preview_id: String,
    content_id: String,
    event_id: String,
    node_url: String,
    key_id: String,
    kind: String,
    title: String,
    body: String,
    language: String,
    #[serde(default = "default_public_visibility")]
    visibility: String,
    #[serde(default)]
    scope_id: Option<String>,
    #[serde(default)]
    encrypted_inline: Option<PreparedEncryptedInline>,
    #[serde(default)]
    artifact: Option<PreparedArtifact>,
    created_at: String,
    expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedArtifact {
    file_name: String,
    media_type: String,
    byte_length: u64,
    digest: String,
    blob_uri: String,
    chunk_count: usize,
    #[serde(default)]
    encryption: Option<EncryptionMetadata>,
    #[serde(default)]
    recipient_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedEncryptedInline {
    media_type: String,
    ciphertext: String,
    byte_length: usize,
    digest: String,
    encryption: EncryptionMetadata,
    recipient_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicContentPreview {
    pub preview_id: String,
    pub content_id: String,
    pub node_url: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub language: String,
    pub character_count: usize,
    pub byte_length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<PublicArtifactPreview>,
    pub visibility: String,
    pub recipient_ids: Vec<String>,
    pub cache_policy: String,
    pub mirror_policy: String,
    pub ai_training_policy: String,
    pub derivatives_policy: String,
    pub expires_at: String,
}

fn default_public_visibility() -> String {
    "public".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicArtifactPreview {
    pub file_name: String,
    pub media_type: String,
    pub byte_length: u64,
    pub digest: String,
    pub blob_uri: String,
    pub chunk_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPublicContent {
    pub preview_id: String,
    pub confirmed_public: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicContentReceipt {
    pub status: String,
    pub preview_id: String,
    pub content_id: String,
    pub content_event_id: String,
    pub portable_event_id: String,
    pub sequence: u64,
    pub event_hash: String,
    pub queued_at: String,
}

fn sha256_hex(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn clean_text(value: &str, max_chars: usize, required: bool) -> Result<String, String> {
    // JavaScript側の Content Protocol `text()` と同じく NFC に揃えてから署名する。
    let normalized = value.nfc().collect::<String>().trim().to_owned();
    if (required && normalized.is_empty()) || normalized.chars().count() > max_chars {
        return Err("入力が長すぎるか空です".into());
    }
    if normalized
        .chars()
        .any(|c| matches!(c, '\0'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'))
    {
        return Err("入力に使用できない制御文字があります".into());
    }
    Ok(normalized)
}

pub fn public_node_origin(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "公開ノードURLが不正です")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("公開ノードURLはパスやポートのない公開HTTPS URLにしてください".into());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.parse::<std::net::IpAddr>().is_ok()
    {
        return Err("ローカルアドレスは公開ノードURLにできません".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn validate_draft(input: PublicContentDraft) -> Result<(String, String, String, String), String> {
    let kind = input.kind.trim().to_ascii_lowercase();
    if !matches!(kind.as_str(), "post" | "memory" | "article" | "document") {
        return Err("この画面では投稿・記憶・記事・文書だけを作成できます".into());
    }
    let title = clean_text(&input.title, 240, false)?;
    let body = clean_text(&input.body, MAX_BODY_BYTES, true)?;
    if body.as_bytes().len() > MAX_BODY_BYTES {
        return Err("本文は1MiB以下にしてください".into());
    }
    let language = clean_text(&input.language, 35, true)?;
    if !language
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("言語タグが不正です".into());
    }
    Ok((kind, title, body, language))
}

pub fn prepare(
    input: PublicContentDraft,
    state: &NodeState,
    store: &NodeStore,
) -> Result<PublicContentPreview, String> {
    // Content ProtocolのURL正規化は URL.toString() なので、origin直下にも `/` が付く。
    // 登録APIはoriginだけを保存するため、署名対象へ入れる前に形を合わせる。
    let node_url = format!("{}/", public_node_origin(&state.hub_url)?);
    let (kind, title, body, language) = validate_draft(input)?;
    let now = Utc::now();
    let created_at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let expires_at =
        (now + Duration::minutes(PREVIEW_TTL_MINUTES)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let prepared = PreparedPublicContent {
        preview_id: format!("preview-{}", uuid::Uuid::new_v4().simple()),
        content_id: format!("urn:hub:content:{}", uuid::Uuid::new_v4().simple()),
        event_id: format!("content-event:{}", uuid::Uuid::new_v4().simple()),
        node_url,
        key_id: "root".into(),
        kind,
        title,
        body,
        language,
        visibility: "public".into(),
        scope_id: None,
        encrypted_inline: None,
        artifact: None,
        created_at,
        expires_at,
    };
    store
        .save_preview(&prepared.preview_id, &prepared)
        .map_err(str::to_owned)?;
    Ok(preview_of(&prepared))
}

pub fn prepare_artifact(
    upload: ArtifactUpload,
    manifest: ArtifactManifest,
    state: &NodeState,
    store: &NodeStore,
) -> Result<PublicContentPreview, String> {
    if upload.file_name != manifest.file_name
        || upload.media_type != manifest.media_type
        || upload.byte_length != manifest.byte_length
    {
        return Err("artifact manifestがアップロード宣言と一致しません".into());
    }
    let node_url = format!("{}/", public_node_origin(&state.hub_url)?);
    let now = Utc::now();
    let created_at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let prepared = PreparedPublicContent {
        preview_id: format!("preview-{}", uuid::Uuid::new_v4().simple()),
        content_id: format!("urn:hub:content:{}", uuid::Uuid::new_v4().simple()),
        event_id: format!("content-event:{}", uuid::Uuid::new_v4().simple()),
        node_url,
        key_id: "root".into(),
        kind: upload.kind,
        title: upload.title,
        body: String::new(),
        language: upload.language,
        artifact: Some(PreparedArtifact {
            file_name: manifest.file_name,
            media_type: manifest.media_type,
            byte_length: manifest.byte_length,
            digest: manifest.digest,
            blob_uri: manifest.blob_uri,
            chunk_count: manifest.chunks.len(),
            encryption: None,
            recipient_ids: Vec::new(),
        }),
        visibility: "public".into(),
        scope_id: None,
        encrypted_inline: None,
        created_at,
        expires_at: (now + Duration::minutes(PREVIEW_TTL_MINUTES))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    store
        .save_preview(&prepared.preview_id, &prepared)
        .map_err(str::to_owned)?;
    Ok(preview_of(&prepared))
}

pub fn new_content_id() -> String {
    format!("urn:hub:content:{}", uuid::Uuid::new_v4().simple())
}

pub fn prepare_private_inline(
    input: PublicContentDraft,
    content_id: String,
    encrypted: EncryptedRepresentation,
    recipient_ids: Vec<String>,
    state: &NodeState,
    store: &NodeStore,
) -> Result<PublicContentPreview, String> {
    let (kind, title, body, language) = validate_draft(input)?;
    if encrypted.ciphertext.len() > MAX_BODY_BYTES + 16 {
        return Err("暗号文が長すぎます".into());
    }
    let node_url = format!("{}/", public_node_origin(&state.hub_url)?);
    let now = Utc::now();
    let prepared = PreparedPublicContent {
        preview_id: format!("preview-{}", uuid::Uuid::new_v4().simple()),
        content_id,
        event_id: format!("content-event:{}", uuid::Uuid::new_v4().simple()),
        node_url,
        key_id: "root".into(),
        kind,
        title,
        body: String::new(),
        language,
        visibility: "private".into(),
        scope_id: Some(format!("urn:hub:scope:{}", uuid::Uuid::new_v4().simple())),
        encrypted_inline: Some(PreparedEncryptedInline {
            media_type: "text/plain; charset=utf-8".into(),
            ciphertext: base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(&encrypted.ciphertext),
            byte_length: encrypted.ciphertext.len(),
            digest: sha256_hex(&encrypted.ciphertext),
            encryption: encrypted.metadata,
            recipient_ids,
        }),
        artifact: None,
        created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: (now + Duration::minutes(PREVIEW_TTL_MINUTES))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    store
        .save_preview(&prepared.preview_id, &prepared)
        .map_err(str::to_owned)?;
    let mut preview = preview_of(&prepared);
    preview.body = body;
    preview.character_count = preview.body.chars().count();
    preview.byte_length = preview.body.len();
    Ok(preview)
}

pub fn prepare_private_artifact(
    content_id: String,
    upload: ArtifactUpload,
    encrypted_manifest: ArtifactManifest,
    encrypted: EncryptedRepresentation,
    recipient_ids: Vec<String>,
    state: &NodeState,
    store: &NodeStore,
) -> Result<PublicContentPreview, String> {
    if encrypted_manifest.digest != sha256_hex(&encrypted.ciphertext)
        || encrypted_manifest.byte_length != encrypted.ciphertext.len() as u64
    {
        return Err("暗号文manifestが実データと一致しません".into());
    }
    let node_url = format!("{}/", public_node_origin(&state.hub_url)?);
    let now = Utc::now();
    let prepared = PreparedPublicContent {
        preview_id: format!("preview-{}", uuid::Uuid::new_v4().simple()),
        content_id,
        event_id: format!("content-event:{}", uuid::Uuid::new_v4().simple()),
        node_url,
        key_id: "root".into(),
        kind: upload.kind,
        title: upload.title,
        body: String::new(),
        language: upload.language,
        visibility: "private".into(),
        scope_id: Some(format!("urn:hub:scope:{}", uuid::Uuid::new_v4().simple())),
        encrypted_inline: None,
        artifact: Some(PreparedArtifact {
            file_name: upload.file_name,
            media_type: upload.media_type,
            byte_length: encrypted_manifest.byte_length,
            digest: encrypted_manifest.digest,
            blob_uri: encrypted_manifest.blob_uri,
            chunk_count: encrypted_manifest.chunks.len(),
            encryption: Some(encrypted.metadata),
            recipient_ids,
        }),
        created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: (now + Duration::minutes(PREVIEW_TTL_MINUTES))
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    store
        .save_preview(&prepared.preview_id, &prepared)
        .map_err(str::to_owned)?;
    Ok(preview_of(&prepared))
}

fn preview_of(value: &PreparedPublicContent) -> PublicContentPreview {
    PublicContentPreview {
        preview_id: value.preview_id.clone(),
        content_id: value.content_id.clone(),
        node_url: value.node_url.clone(),
        kind: value.kind.clone(),
        title: value.title.clone(),
        body: value.body.clone(),
        language: value.language.clone(),
        character_count: value.body.chars().count(),
        byte_length: value.body.as_bytes().len(),
        artifact: value
            .artifact
            .as_ref()
            .map(|artifact| PublicArtifactPreview {
                file_name: artifact.file_name.clone(),
                media_type: artifact.media_type.clone(),
                byte_length: artifact.byte_length,
                digest: artifact.digest.clone(),
                blob_uri: artifact.blob_uri.clone(),
                chunk_count: artifact.chunk_count,
            }),
        visibility: value.visibility.clone(),
        recipient_ids: value
            .artifact
            .as_ref()
            .map(|artifact| artifact.recipient_ids.clone())
            .or_else(|| {
                value
                    .encrypted_inline
                    .as_ref()
                    .map(|inline| inline.recipient_ids.clone())
            })
            .unwrap_or_default(),
        cache_policy: if value.visibility == "public" {
            "allowed"
        } else {
            "denied"
        }
        .into(),
        mirror_policy: if value.visibility == "public" {
            "allowed"
        } else {
            "denied"
        }
        .into(),
        ai_training_policy: if value.visibility == "public" {
            "consent-required"
        } else {
            "denied"
        }
        .into(),
        derivatives_policy: if value.visibility == "public" {
            "license-only"
        } else {
            "denied"
        }
        .into(),
        expires_at: value.expires_at.clone(),
    }
}

fn signed_envelope(prepared: &PreparedPublicContent, key: &NodeKey) -> Value {
    let representation = if let Some(artifact) = &prepared.artifact {
        let mut representation = json!({
            "id": "primary",
            "role": "primary",
            "mediaType": artifact.media_type,
            "byteLength": artifact.byte_length,
            "digest": { "algorithm": "sha-256", "value": artifact.digest },
            "source": { "type": "p2p", "uri": artifact.blob_uri }
        });
        if let Some(encryption) = &artifact.encryption {
            representation["encryption"] = serde_json::to_value(encryption).expect("encryption");
        }
        representation
    } else if let Some(inline) = &prepared.encrypted_inline {
        json!({
            "id": "primary",
            "role": "primary",
            "mediaType": inline.media_type,
            "byteLength": inline.byte_length,
            "digest": { "algorithm": "sha-256", "value": inline.digest },
            "source": { "type": "inline", "encoding": "base64url", "data": inline.ciphertext },
            "encryption": inline.encryption
        })
    } else {
        json!({
            "id": "primary",
            "role": "primary",
            "mediaType": "text/plain; charset=utf-8",
            "byteLength": prepared.body.len(),
            "digest": { "algorithm": "sha-256", "value": sha256_hex(prepared.body.as_bytes()) },
            "source": { "type": "inline", "encoding": "utf-8", "data": prepared.body }
        })
    };
    let mut envelope = json!({
        "type": ENVELOPE_TYPE,
        "version": 1,
        "contentId": prepared.content_id,
        "kind": prepared.kind,
        "schema": format!("urn:hub:schema:{}.v1", prepared.kind),
        "issuer": { "nodeId": prepared.node_url, "keyId": prepared.key_id },
        "revision": { "number": 1 },
        "createdAt": prepared.created_at,
        "updatedAt": prepared.created_at,
        "visibility": if let Some(scope_id) = &prepared.scope_id {
            json!({ "mode": prepared.visibility, "scopeId": scope_id })
        } else {
            json!({ "mode": prepared.visibility })
        },
        "language": prepared.language,
        "capabilities": if prepared.visibility == "public" {
            json!(["read", "cite", "mirror"])
        } else {
            json!(["read"])
        },
        "representations": [representation],
        "relations": [],
        "policies": {
            "cache": if prepared.visibility == "public" { "allowed" } else { "denied" },
            "mirror": if prepared.visibility == "public" { "allowed" } else { "denied" },
            "aiTraining": if prepared.visibility == "public" { "consent-required" } else { "denied" },
            "derivatives": if prepared.visibility == "public" { "license-only" } else { "denied" }
        }
    });
    if !prepared.title.is_empty() {
        envelope["title"] = Value::String(prepared.title.clone());
    }
    let signature = key.sign(&canonical_json(&envelope));
    envelope["signature"] = json!({
        "algorithm": "ES256",
        "keyId": prepared.key_id,
        "value": signature
    });
    envelope
}

pub struct ArtifactPublishDetails {
    pub digest: String,
    pub content_id: String,
    pub visibility: String,
    pub recipient_ids: Vec<String>,
}

pub fn artifact_publish_details(
    preview_id: &str,
    store: &NodeStore,
) -> Option<ArtifactPublishDetails> {
    let prepared = store.read_preview::<PreparedPublicContent>(preview_id)?;
    let artifact = prepared.artifact?;
    Some(ArtifactPublishDetails {
        digest: artifact.digest,
        content_id: prepared.content_id,
        visibility: prepared.visibility,
        recipient_ids: artifact.recipient_ids,
    })
}

fn signed_content_event(prepared: &PreparedPublicContent, key: &NodeKey) -> Value {
    let envelope = signed_envelope(prepared, key);
    let mut unsigned_envelope = envelope.clone();
    unsigned_envelope
        .as_object_mut()
        .expect("envelope object")
        .remove("signature");
    let event = json!({
        "type": EVENT_TYPE,
        "version": 1,
        "eventId": prepared.event_id,
        "contentId": prepared.content_id,
        "action": "publish",
        "sequence": 1,
        "occurredAt": prepared.created_at,
        "issuer": { "nodeId": prepared.node_url, "keyId": prepared.key_id },
        "envelope": envelope
    });
    let mut signing_value = event.clone();
    signing_value["envelope"] = unsigned_envelope;
    let signature = key.sign(&canonical_json(&signing_value));
    let mut signed = event;
    signed["signature"] = json!({
        "algorithm": "ES256",
        "keyId": prepared.key_id,
        "value": signature
    });
    signed
}

pub fn commit(
    input: ConfirmPublicContent,
    state: &NodeState,
    store: &NodeStore,
    key: &NodeKey,
) -> Result<PublicContentReceipt, String> {
    if !input.confirmed_public {
        return Err("公開への明示確認が必要です".into());
    }
    if let Some(receipt) = store.read_receipt::<PublicContentReceipt>(&input.preview_id) {
        return Ok(receipt);
    }
    let prepared = store
        .read_preview::<PreparedPublicContent>(&input.preview_id)
        .ok_or_else(|| "プレビューが見つかりません。もう一度確認してください".to_owned())?;
    let expires_at = DateTime::parse_from_rfc3339(&prepared.expires_at)
        .map_err(|_| "プレビューの期限が不正です")?;
    if expires_at <= Utc::now() {
        return Err("プレビューの期限が切れました。もう一度確認してください".into());
    }
    if prepared.node_url != format!("{}/", public_node_origin(&state.hub_url)?) {
        return Err("公開ノードURLがプレビュー後に変わりました。もう一度確認してください".into());
    }
    if let Some(stored) = store.find_content_event(&prepared.event_id) {
        let receipt = receipt_from_stored(&prepared, stored);
        store
            .save_receipt(&receipt.preview_id, &receipt)
            .map_err(str::to_owned)?;
        return Ok(receipt);
    }
    let content_event = signed_content_event(&prepared, key);
    let stored = store
        .append("hub.content.publish", content_event, |message| {
            Some(key.sign(message))
        })
        .map_err(str::to_owned)?;
    let receipt = receipt_from_stored(&prepared, stored);
    store
        .save_receipt(&receipt.preview_id, &receipt)
        .map_err(str::to_owned)?;
    Ok(receipt)
}

fn receipt_from_stored(
    prepared: &PreparedPublicContent,
    stored: crate::node_store::StoredEvent,
) -> PublicContentReceipt {
    PublicContentReceipt {
        status: "queued".into(),
        preview_id: prepared.preview_id.clone(),
        content_id: prepared.content_id.clone(),
        content_event_id: prepared.event_id.clone(),
        portable_event_id: stored.event["id"].as_str().unwrap_or_default().to_owned(),
        sequence: stored.sequence,
        event_hash: stored.hash,
        queued_at: stored.event["createdAt"]
            .as_str()
            .unwrap_or(&prepared.created_at)
            .to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(root: &std::path::Path) -> NodeState {
        NodeState {
            node_id: "node-1".into(),
            device_name: "test".into(),
            enabled: true,
            launch_at_login: false,
            storage_path: root.to_string_lossy().into_owned(),
            hub_url: "https://node.example".into(),
            sync_state: "ready".into(),
            public_key_jwk: None,
            key_thumbprint: None,
            last_sync_at: None,
            last_sync_confirmed: false,
            queued_items: 0,
        }
    }

    #[test]
    fn preview_then_confirmation_writes_one_idempotent_portable_event() {
        let root = std::env::temp_dir().join(format!("hub-content-{}", uuid::Uuid::new_v4()));
        let store = NodeStore::open(&root.to_string_lossy()).unwrap();
        let node = state(&root);
        let key = NodeKey::create();
        let preview = prepare(
            PublicContentDraft {
                kind: "memory".into(),
                title: "共通記憶".into(),
                body: "人とAIが共有する原本。".into(),
                language: "ja".into(),
            },
            &node,
            &store,
        )
        .unwrap();
        assert_eq!(
            store.chain().pending,
            0,
            "プレビューだけではキューへ積まない"
        );

        let input = ConfirmPublicContent {
            preview_id: preview.preview_id,
            confirmed_public: true,
        };
        let first = commit(input.clone(), &node, &store, &key).unwrap();
        // 追記後・receipt保存前のクラッシュを模擬する。再試行は内側eventIdから
        // 既存イベントを見つけ、2件目を積まずreceiptを復元する。
        std::fs::remove_file(
            root.join("receipts")
                .join(format!("{}.json", input.preview_id)),
        )
        .unwrap();
        let retry = commit(input, &node, &store, &key).unwrap();
        assert_eq!(first, retry);
        assert_eq!(store.chain().pending, 1, "再試行で二重作成しない");
        let event = store.read(1).unwrap().event;
        assert_eq!(event["type"], "hub.content.publish");
        assert!(event["id"].as_str().is_some());
        assert!(event["createdAt"].as_str().is_some());
        assert_eq!(
            event["payload"]["envelope"]["representations"][0]["source"]["data"],
            "人とAIが共有する原本。"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn artifact_envelope_points_to_the_verified_blob_without_inlining_bytes() {
        let root = std::env::temp_dir().join(format!("hub-content-{}", uuid::Uuid::new_v4()));
        let store = NodeStore::open(&root.to_string_lossy()).unwrap();
        let node = state(&root);
        let digest = "ab".repeat(32);
        let preview = prepare_artifact(
            ArtifactUpload {
                upload_id: "upload-12345678".into(),
                file_name: "shared.png".into(),
                media_type: "image/png".into(),
                byte_length: 4,
                chunk_size: 512 * 1024,
                total_chunks: 1,
                kind: "image".into(),
                title: "共有画像".into(),
                language: "ja".into(),
                created_at: "2026-08-28T00:00:00.000Z".into(),
                expires_at: "2099-08-28T01:00:00.000Z".into(),
            },
            ArtifactManifest {
                version: 1,
                blob_uri: format!("urn:hub:blob:{digest}"),
                file_name: "shared.png".into(),
                media_type: "image/png".into(),
                byte_length: 4,
                digest: digest.clone(),
                chunk_size: 512 * 1024,
                chunks: vec![crate::artifact_store::ArtifactChunkManifest {
                    index: 0,
                    byte_length: 4,
                    digest: digest.clone(),
                }],
                created_at: "2026-08-28T00:00:00.000Z".into(),
            },
            &node,
            &store,
        )
        .unwrap();
        assert_eq!(store.chain().pending, 0, "確定保存だけでは公開しない");
        assert_eq!(preview.artifact.as_ref().unwrap().digest, digest);

        commit(
            ConfirmPublicContent {
                preview_id: preview.preview_id,
                confirmed_public: true,
            },
            &node,
            &store,
            &NodeKey::create(),
        )
        .unwrap();
        let representation =
            &store.read(1).unwrap().event["payload"]["envelope"]["representations"][0];
        assert_eq!(representation["source"]["type"], "p2p");
        assert_eq!(
            representation["source"]["uri"],
            format!("urn:hub:blob:{digest}")
        );
        assert!(representation["source"].get("data").is_none());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn no_confirmation_no_public_event() {
        let root = std::env::temp_dir().join(format!("hub-content-{}", uuid::Uuid::new_v4()));
        let store = NodeStore::open(&root.to_string_lossy()).unwrap();
        let node = state(&root);
        let preview = prepare(
            PublicContentDraft {
                kind: "post".into(),
                title: "".into(),
                body: "本文".into(),
                language: "ja".into(),
            },
            &node,
            &store,
        )
        .unwrap();
        let result = commit(
            ConfirmPublicContent {
                preview_id: preview.preview_id,
                confirmed_public: false,
            },
            &node,
            &store,
            &NodeKey::create(),
        );
        assert!(result.is_err());
        assert_eq!(store.chain().pending, 0);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn private_preview_persists_and_signs_ciphertext_without_plaintext() {
        let root = std::env::temp_dir().join(format!("hub-private-{}", uuid::Uuid::new_v4()));
        let store = NodeStore::open(&root.to_string_lossy()).unwrap();
        let recipient = crate::content_e2ee::NodeEncryptionKey::create();
        let content_id = new_content_id();
        let encrypted = crate::content_e2ee::encrypt(
            &content_id,
            "primary",
            "text/plain; charset=utf-8",
            "private",
            "秘密の共通記憶".as_bytes(),
            &[crate::content_e2ee::RecipientSpec {
                recipient_id: "https://node-b.example/".into(),
                key_id: "e2ee-v1".into(),
                public_key_jwk: recipient.public_jwk(),
            }],
        )
        .unwrap();
        let preview = prepare_private_inline(
            PublicContentDraft {
                kind: "memory".into(),
                title: "限定".into(),
                body: "秘密の共通記憶".into(),
                language: "ja".into(),
            },
            content_id,
            encrypted,
            vec!["https://node-b.example/".into()],
            &state(&root),
            &store,
        )
        .unwrap();
        assert_eq!(preview.body, "秘密の共通記憶");
        let preview_file = std::fs::read_to_string(
            root.join("previews")
                .join(format!("{}.json", preview.preview_id)),
        )
        .unwrap();
        assert!(!preview_file.contains("秘密の共通記憶"));
        commit(
            ConfirmPublicContent {
                preview_id: preview.preview_id,
                confirmed_public: true,
            },
            &state(&root),
            &store,
            &NodeKey::create(),
        )
        .unwrap();
        let event_text = serde_json::to_string(&store.read(1).unwrap().event).unwrap();
        assert!(!event_text.contains("秘密の共通記憶"));
        assert!(event_text.contains("base64url"));
        assert!(event_text.contains(crate::content_e2ee::SUITE));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn local_or_pathful_node_urls_are_rejected() {
        assert!(public_node_origin("http://localhost:3020").is_err());
        assert!(public_node_origin("https://node.example/path").is_err());
        assert_eq!(
            public_node_origin("https://node.example/").unwrap(),
            "https://node.example"
        );
    }

    #[test]
    fn draft_text_is_nfc_normalized_before_preview_and_signing() {
        let root = std::env::temp_dir().join(format!("hub-content-{}", uuid::Uuid::new_v4()));
        let store = NodeStore::open(&root.to_string_lossy()).unwrap();
        let preview = prepare(
            PublicContentDraft {
                kind: "memory".into(),
                title: "Cafe\u{301}".into(),
                body: "共有するe\u{301}".into(),
                language: "ja".into(),
            },
            &state(&root),
            &store,
        )
        .unwrap();
        assert_eq!(preview.title, "Café");
        assert_eq!(preview.body, "共有するé");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn envelope_and_content_event_signatures_cover_the_gateway_targets() {
        let prepared = PreparedPublicContent {
            preview_id: "preview-12345678".into(),
            content_id: "urn:hub:content:12345678".into(),
            event_id: "content-event:12345678".into(),
            node_url: "https://node.example/".into(),
            key_id: "root".into(),
            kind: "memory".into(),
            title: "署名対象".into(),
            body: "本文".into(),
            language: "ja".into(),
            visibility: "public".into(),
            scope_id: None,
            encrypted_inline: None,
            artifact: None,
            created_at: "2026-08-28T00:00:00.000Z".into(),
            expires_at: "2026-08-28T00:15:00.000Z".into(),
        };
        let key = NodeKey::create();
        let event = signed_content_event(&prepared, &key);
        let mut envelope = event["envelope"].clone();
        let envelope_signature = envelope["signature"]["value"].as_str().unwrap().to_owned();
        envelope.as_object_mut().unwrap().remove("signature");
        assert!(key.verify(&canonical_json(&envelope), &envelope_signature));

        let mut signing_target = event.clone();
        let event_signature = signing_target["signature"]["value"]
            .as_str()
            .unwrap()
            .to_owned();
        signing_target.as_object_mut().unwrap().remove("signature");
        signing_target["envelope"] = envelope;
        assert!(key.verify(&canonical_json(&signing_target), &event_signature));
    }

    /// JavaScript実装との相互運用確認用。
    /// `cargo test emit_signed_content_material -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn emit_signed_content_material() {
        let prepared = PreparedPublicContent {
            preview_id: "preview-12345678".into(),
            content_id: "urn:hub:content:12345678".into(),
            event_id: "content-event:12345678".into(),
            node_url: "https://node.example/".into(),
            key_id: "root".into(),
            kind: "memory".into(),
            title: "Rustからの共通記憶".into(),
            body: "人とAIが同じ署名済み原本を検証する。".into(),
            language: "ja".into(),
            visibility: "public".into(),
            scope_id: None,
            encrypted_inline: None,
            artifact: None,
            created_at: "2026-08-28T00:00:00.000Z".into(),
            expires_at: "2026-08-28T00:15:00.000Z".into(),
        };
        let key = NodeKey::create();
        let content_event = signed_content_event(&prepared, &key);
        let artifact_content_event = signed_content_event(
            &PreparedPublicContent {
                preview_id: "preview-artifact".into(),
                content_id: "urn:hub:content:artifact".into(),
                event_id: "content-event:artifact".into(),
                node_url: prepared.node_url.clone(),
                key_id: prepared.key_id.clone(),
                kind: "image".into(),
                title: "Rustからのartifact".into(),
                body: String::new(),
                language: "ja".into(),
                visibility: "public".into(),
                scope_id: None,
                encrypted_inline: None,
                artifact: Some(PreparedArtifact {
                    file_name: "interop.png".into(),
                    media_type: "image/png".into(),
                    byte_length: 4,
                    digest: "ab".repeat(32),
                    blob_uri: format!("urn:hub:blob:{}", "ab".repeat(32)),
                    chunk_count: 1,
                    encryption: None,
                    recipient_ids: Vec::new(),
                }),
                created_at: prepared.created_at.clone(),
                expires_at: prepared.expires_at.clone(),
            },
            &key,
        );
        let root = std::env::temp_dir().join(format!("hub-interop-{}", uuid::Uuid::new_v4()));
        let store = NodeStore::open(&root.to_string_lossy()).unwrap();
        let portable = store
            .append("hub.content.publish", content_event.clone(), |message| {
                Some(key.sign(message))
            })
            .unwrap();
        println!(
            "INTEROP_JSON={}",
            json!({
                "jwk": key.public_jwk(),
                "contentEvent": content_event,
                "artifactContentEvent": artifact_content_event,
                "portableEvent": portable.event,
                "portableSignature": portable.signature,
                "portableHash": portable.hash
            })
        );
        std::fs::remove_dir_all(root).ok();
    }
}
