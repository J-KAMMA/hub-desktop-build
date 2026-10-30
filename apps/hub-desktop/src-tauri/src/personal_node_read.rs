//! Stored encrypted inbox text only. No fetch, stage, delivery, key export or persistence.
use super::{DecryptedPeerContent, NodeState, PersonalNodeService};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};
const INVALID: &str = "node_peer_read_invalid_request";
const CHANGED: &str = "node_peer_read_context_changed";
const UNAVAILABLE: &str = "node_peer_read_unavailable";
const NOT_FOUND: &str = "node_peer_read_not_found";
const UNSUPPORTED: &str = "node_peer_read_unsupported";
const TOO_LARGE: &str = "node_peer_read_too_large";
const MAX_TEXT: usize = 256 * 1024;
const MAX_SAVED: usize = 1024 * 1024;
const MAX_REPLY: usize = 768 * 1024;
fn hex(value: &str, width: usize) -> bool {
    value.len() == width
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn delivery_id(value: &str) -> bool {
    value
        .strip_prefix("delivery-")
        .is_some_and(|v| hex(v, 32) || hex(v, 64))
}
fn content_id(value: &str) -> bool {
    value
        .strip_prefix("urn:hub:content:")
        .is_some_and(|v| hex(v, 32))
}
fn media(value: &str) -> bool {
    matches!(value, "text/plain" | "text/markdown" | "application/json")
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn local_node(state: &NodeState) -> Result<String, String> {
    crate::content_protocol::public_node_origin(&state.hub_url)
        .map(|v| format!("{v}/"))
        .map_err(|_| UNAVAILABLE.into())
}
fn bounded_reader(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let limit_plus = limit.checked_add(1).ok_or(INVALID)?;
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(limit_plus as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    if bytes.len() > limit {
        return Err(TOO_LARGE.into());
    }
    Ok(bytes)
}
fn file(root: &Path, path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let root = root.canonicalize().map_err(|_| UNAVAILABLE)?;
    let path = path.canonicalize().map_err(|_| NOT_FOUND)?;
    if !path.starts_with(&root) {
        return Err(INVALID.into());
    }
    let input = std::fs::File::open(path).map_err(|_| UNAVAILABLE)?;
    let metadata = input.metadata().map_err(|_| UNAVAILABLE)?;
    if !metadata.is_file() {
        return Err(INVALID.into());
    }
    if metadata.len() > limit as u64 {
        return Err(TOO_LARGE.into());
    }
    bounded_reader(input, limit)
}
fn saved(root: &Path, id: &str) -> Result<Value, String> {
    if !delivery_id(id) {
        return Err(INVALID.into());
    }
    let bytes = file(
        root,
        &root.join("peers/inbox").join(format!("{id}.json")),
        MAX_SAVED,
    )?;
    serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE.into())
}
fn representation<'a>(
    saved: &'a Value,
    id: &str,
    recipient: &str,
    limit: usize,
) -> Result<(&'a Value, &'a Value), String> {
    if limit == 0 || limit > MAX_TEXT || !delivery_id(id) {
        return Err(INVALID.into());
    }
    let d = saved.get("delivery").ok_or(UNAVAILABLE)?;
    let receipt = saved.get("receipt").ok_or(UNAVAILABLE)?;
    if d["deliveryId"] != id
        || receipt["deliveryId"] != id
        || receipt["status"] != "ready"
        || d["recipientNodeId"] != recipient
        || receipt["portableEventId"] != d["portableEvent"]["id"]
        || !d["portableEvent"]["id"]
            .as_str()
            .is_some_and(|v| v.strip_prefix("event:").is_some_and(|v| hex(v, 32)))
    {
        return Err(UNAVAILABLE.into());
    }
    let envelope = d
        .pointer("/portableEvent/payload/envelope")
        .ok_or(UNAVAILABLE)?;
    if !envelope["contentId"].as_str().is_some_and(content_id) {
        return Err(UNAVAILABLE.into());
    }
    let rep = envelope["representations"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or(UNAVAILABLE)?;
    if !rep["mediaType"].as_str().is_some_and(media) || rep.get("encryption").is_none() {
        return Err(UNSUPPORTED.into());
    }
    let byte_length = rep["byteLength"].as_u64().ok_or(UNAVAILABLE)?;
    if byte_length > limit as u64 + 16 {
        return Err(TOO_LARGE.into());
    }
    Ok((envelope, rep))
}
fn decode_inline(rep: &Value, limit: usize) -> Result<Vec<u8>, String> {
    let source = &rep["source"];
    if source["encoding"] != "base64url" {
        return Err(UNSUPPORTED.into());
    }
    let data = source["data"].as_str().ok_or(UNAVAILABLE)?;
    if data.len() > ((limit + 16 + 2) / 3) * 4 {
        return Err(TOO_LARGE.into());
    }
    let bytes = URL_SAFE_NO_PAD.decode(data).map_err(|_| UNAVAILABLE)?;
    if bytes.len() > limit + 16 {
        return Err(TOO_LARGE.into());
    }
    if URL_SAFE_NO_PAD.encode(&bytes) != data {
        return Err(UNAVAILABLE.into());
    }
    Ok(bytes)
}
fn validate_manifest(
    manifest: &crate::artifact_store::ArtifactManifest,
    expected: &str,
    limit: usize,
) -> Result<(), String> {
    if !hex(expected, 64) || limit == 0 || limit > MAX_TEXT {
        return Err(INVALID.into());
    }
    if manifest.version != 1
        || manifest.digest != expected
        || manifest.blob_uri != format!("urn:hub:blob:{expected}")
        || manifest.chunk_size != crate::artifact_store::CHUNK_SIZE
    {
        return Err(UNAVAILABLE.into());
    }
    if manifest.byte_length > limit as u64 + 16 || manifest.chunks.len() > 16 {
        return Err(TOO_LARGE.into());
    }
    let mut total = 0usize;
    for (index, chunk) in manifest.chunks.iter().enumerate() {
        if chunk.index as usize != index || !hex(&chunk.digest, 64) {
            return Err(UNAVAILABLE.into());
        }
        total = total
            .checked_add(chunk.byte_length)
            .filter(|v| *v <= limit + 16)
            .ok_or(TOO_LARGE)?;
    }
    if total as u64 != manifest.byte_length {
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}
fn verified_chunk(
    bytes: &mut Vec<u8>,
    data: &[u8],
    chunk: &crate::artifact_store::ArtifactChunkManifest,
    limit: usize,
) -> Result<(), String> {
    if limit == 0 || limit > MAX_TEXT {
        return Err(INVALID.into());
    }
    if data.len() > (limit + 16).saturating_sub(bytes.len()) {
        return Err(TOO_LARGE.into());
    }
    if data.len() != chunk.byte_length || digest(data) != chunk.digest {
        return Err(UNAVAILABLE.into());
    }
    bytes.extend_from_slice(data);
    Ok(())
}
fn blob(root: &Path, expected: &str, limit: usize) -> Result<Vec<u8>, String> {
    if !hex(expected, 64) {
        return Err(INVALID.into());
    }
    let folder = root.join("artifacts/blobs").join(expected);
    let manifest: crate::artifact_store::ArtifactManifest =
        serde_json::from_slice(&file(root, &folder.join("manifest.json"), 16 * 1024)?)
            .map_err(|_| UNAVAILABLE)?;
    validate_manifest(&manifest, expected, limit)?;
    let mut bytes = Vec::new();
    for chunk in &manifest.chunks {
        let data = file(
            root,
            &folder
                .join("chunks")
                .join(format!("{:08}.bin", chunk.index)),
            chunk.byte_length,
        )?;
        verified_chunk(&mut bytes, &data, chunk, limit)?;
    }
    if bytes.len() as u64 != manifest.byte_length || digest(&bytes) != expected {
        return Err(UNAVAILABLE.into());
    }
    Ok(bytes)
}
pub(super) async fn decrypt_bounded(
    node: &PersonalNodeService,
    id: &str,
    limit: usize,
) -> Result<DecryptedPeerContent, String> {
    let state = node.state.read().await.clone();
    let root = PathBuf::from(&state.storage_path);
    let recipient = local_node(&state)?;
    let record = saved(&root, id)?;
    let (envelope, rep) = representation(&record, id, &recipient, limit)?;
    let expected = rep
        .pointer("/digest/value")
        .and_then(Value::as_str)
        .filter(|v| hex(v, 64))
        .ok_or(UNAVAILABLE)?;
    let encrypted = match rep.pointer("/source/type").and_then(Value::as_str) {
        Some("inline") => decode_inline(rep, limit)?,
        Some("p2p") => blob(&root, expected, limit)?,
        _ => return Err(UNSUPPORTED.into()),
    };
    if encrypted.len() as u64 != rep["byteLength"].as_u64().ok_or(UNAVAILABLE)?
        || digest(&encrypted) != expected
    {
        return Err(UNAVAILABLE.into());
    }
    let result = node
        .decrypt_saved_representation(&recipient, id, envelope, rep, &encrypted)
        .map_err(|_| UNAVAILABLE)?;
    if saved(&root, id)? != record {
        return Err(CHANGED.into());
    }
    Ok(result)
}
struct Scope {
    context: String,
    base: String,
    device: String,
    node: String,
}
impl Scope {
    async fn capture(service: &PersonalNodeService) -> Result<Self, String> {
        let base = crate::hub_network::origin(&crate::hub_origin()).map_err(|_| UNAVAILABLE)?;
        let status = crate::desktop_account::status(&base).map_err(|_| UNAVAILABLE)?;
        let device = status
            .device_id
            .filter(|v| {
                !v.is_empty()
                    && v.len() <= 128
                    && v.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            })
            .filter(|_| status.state == "registered")
            .ok_or(UNAVAILABLE)?;
        crate::hub_network::require_source_owner(&base, &device).map_err(|_| CHANGED)?;
        let state = service.state.read().await.clone();
        let node = service.sync_context(&state).map_err(|_| UNAVAILABLE)?;
        let context = digest(
            &serde_json::to_vec(&(&base, &device, &node, status.key_thumbprint))
                .map_err(|_| UNAVAILABLE)?,
        );
        Ok(Self {
            context,
            base,
            device,
            node,
        })
    }
    async fn check(&self, service: &PersonalNodeService) -> Result<(), String> {
        let current = Self::capture(service).await.map_err(|_| CHANGED)?;
        if current.context != self.context
            || current.base != self.base
            || current.device != self.device
            || current.node != self.node
        {
            return Err(CHANGED.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const DELIVERY: &str =
        "delivery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const CONTENT: &str = "urn:hub:content:11111111111111111111111111111111";
    const CONTEXT: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    fn output(bytes: &[u8], media: &str) -> DecryptedPeerContent {
        DecryptedPeerContent {
            delivery_id: DELIVERY.into(),
            content_id: CONTENT.into(),
            media_type: media.into(),
            data: URL_SAFE_NO_PAD.encode(bytes),
            text: None,
        }
    }
    fn record() -> Value {
        json!({"delivery":{"deliveryId":DELIVERY,"recipientNodeId":"https://node.example/","portableEvent":{"id":"event:33333333333333333333333333333333","payload":{"envelope":{"contentId":CONTENT,"representations":[{"id":"rep","mediaType":"text/plain","byteLength":17,"encryption":{},"digest":{"value":digest(&[0;17])},"source":{"type":"inline","encoding":"base64url","data":URL_SAFE_NO_PAD.encode([0;17])}}]}}}},"receipt":{"deliveryId":DELIVERY,"portableEventId":"event:33333333333333333333333333333333","status":"ready"}})
    }
    #[test]
    fn delivery_and_content_ids_preserve_both_legacy_shapes_without_path_or_control() {
        assert!(delivery_id(DELIVERY));
        assert!(delivery_id("delivery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        for id in [
            "delivery-../secret",
            "delivery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
            "delivery-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "",
        ] {
            assert!(!delivery_id(id));
        }
        assert!(content_id(CONTENT));
        assert!(!content_id(&format!("{CONTENT}\0")));
    }
    #[test]
    fn bounded_actual_reader_is_inclusive_and_never_slices_overflow() {
        assert_eq!(
            bounded_reader(std::io::Cursor::new(vec![1; MAX_TEXT]), MAX_TEXT)
                .unwrap()
                .len(),
            MAX_TEXT
        );
        assert_eq!(
            bounded_reader(std::io::Cursor::new(vec![1; MAX_TEXT + 1]), MAX_TEXT)
                .err()
                .unwrap(),
            TOO_LARGE
        );
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("synthetic private error"))
            }
        }
        assert_eq!(bounded_reader(Broken, 1).err().unwrap(), UNAVAILABLE);
    }
    #[test]
    fn saved_receipt_recipient_event_and_supported_media_are_rechecked_before_decode() {
        let value = record();
        assert!(representation(&value, DELIVERY, "https://node.example/", MAX_TEXT).is_ok());
        for key in ["status", "deliveryId", "portableEventId"] {
            let mut value = record();
            value["receipt"][key] = json!("wrong");
            assert!(representation(&value, DELIVERY, "https://node.example/", MAX_TEXT).is_err());
        }
        assert!(representation(&value, DELIVERY, "https://other.example/", MAX_TEXT).is_err());
        let mut value = record();
        value["delivery"]["portableEvent"]["payload"]["envelope"]["representations"][0]
            .as_object_mut()
            .unwrap()
            .remove("encryption");
        assert_eq!(
            representation(&value, DELIVERY, "https://node.example/", MAX_TEXT)
                .err()
                .unwrap(),
            UNSUPPORTED
        );
        for media in ["text/html", "text/plain; charset=utf-8", "image/png"] {
            let mut value = record();
            value["delivery"]["portableEvent"]["payload"]["envelope"]["representations"][0]
                ["mediaType"] = json!(media);
            assert_eq!(
                representation(&value, DELIVERY, "https://node.example/", MAX_TEXT)
                    .err()
                    .unwrap(),
                UNSUPPORTED
            );
        }
    }
    #[test]
    fn ciphertext_limit_and_encoding_are_checked_before_large_decode() {
        let value = record();
        let rep = &value["delivery"]["portableEvent"]["payload"]["envelope"]["representations"][0];
        assert_eq!(decode_inline(rep, MAX_TEXT).unwrap().len(), 17);
        let mut rep = rep.clone();
        rep["source"]["data"] = json!("a".repeat(((MAX_TEXT + 18) / 3) * 4 + 1));
        assert_eq!(decode_inline(&rep, MAX_TEXT).err().unwrap(), TOO_LARGE);
        rep["source"]["data"] = json!("bad==");
        assert!(decode_inline(&rep, MAX_TEXT).is_err());
        let mut value = record();
        value["delivery"]["portableEvent"]["payload"]["envelope"]["representations"][0]
            ["byteLength"] = json!(MAX_TEXT + 17);
        assert_eq!(
            representation(&value, DELIVERY, "https://node.example/", MAX_TEXT)
                .err()
                .unwrap(),
            TOO_LARGE
        );
    }
    #[test]
    fn plaintext_dto_has_six_fields_literal_text_and_exact_plaintext_byte_count() {
        for media in ["text/plain", "text/markdown", "application/json"] {
            let text = "日本語\n<script>literal</script>";
            let result = body(output(text.as_bytes(), media), CONTEXT, DELIVERY).unwrap();
            assert_eq!(result.as_object().unwrap().len(), 6);
            assert_eq!(result["text"], text);
            assert_eq!(result["byteLength"], text.len());
            assert!(result.get("data").is_none());
        }
        let empty = body(output(b"", "text/plain"), CONTEXT, DELIVERY).unwrap();
        assert_eq!(empty["byteLength"], 0);
        let mut data = output(b"value", "text/plain");
        data.text = Some("different".into());
        assert!(body(data, CONTEXT, DELIVERY).is_err());
        assert!(body(
            output(b"value", "text/plain"),
            CONTEXT,
            "delivery-11111111111111111111111111111111"
        )
        .is_err());
    }
    #[test]
    fn plaintext_actual_utf8_utf16_nul_and_fatal_decode_limits_are_independent() {
        assert!(body(output(&vec![b'a'; 100000], "text/plain"), CONTEXT, DELIVERY).is_ok());
        assert_eq!(
            body(output(&vec![b'a'; 100001], "text/plain"), CONTEXT, DELIVERY)
                .err()
                .unwrap(),
            TOO_LARGE
        );
        assert!(body(
            output("😀".repeat(50000).as_bytes(), "text/plain"),
            CONTEXT,
            DELIVERY
        )
        .is_ok());
        assert_eq!(
            body(
                output(format!("{}a", "😀".repeat(50000)).as_bytes(), "text/plain"),
                CONTEXT,
                DELIVERY
            )
            .err()
            .unwrap(),
            TOO_LARGE
        );
        assert_eq!(
            body(
                output(&vec![0xff; MAX_TEXT + 1], "text/plain"),
                CONTEXT,
                DELIVERY
            )
            .err()
            .unwrap(),
            TOO_LARGE
        );
        assert_eq!(
            body(output(&[0xff], "text/plain"), CONTEXT, DELIVERY)
                .err()
                .unwrap(),
            UNSUPPORTED
        );
        assert_eq!(
            body(output(b"nul\0body", "text/plain"), CONTEXT, DELIVERY)
                .err()
                .unwrap(),
            UNSUPPORTED
        );
    }
    #[test]
    fn manifest_and_chunk_actual_lengths_and_hashes_are_checked_before_accumulation() {
        let data = b"encrypted synthetic";
        let expected = digest(data);
        let mut manifest = crate::artifact_store::ArtifactManifest {
            version: 1,
            blob_uri: format!("urn:hub:blob:{expected}"),
            file_name: "fixture".into(),
            media_type: "application/octet-stream".into(),
            byte_length: data.len() as u64,
            digest: expected.clone(),
            chunk_size: crate::artifact_store::CHUNK_SIZE,
            chunks: vec![crate::artifact_store::ArtifactChunkManifest {
                index: 0,
                byte_length: data.len(),
                digest: expected.clone(),
            }],
            created_at: "synthetic".into(),
        };
        assert!(validate_manifest(&manifest, &expected, MAX_TEXT).is_ok());
        let mut bytes = Vec::new();
        verified_chunk(&mut bytes, data, &manifest.chunks[0], MAX_TEXT).unwrap();
        assert_eq!(bytes, data);
        assert_eq!(
            verified_chunk(&mut Vec::new(), b"wrong", &manifest.chunks[0], MAX_TEXT).unwrap_err(),
            UNAVAILABLE
        );
        manifest.byte_length = u64::MAX;
        assert_eq!(
            validate_manifest(&manifest, &expected, MAX_TEXT).unwrap_err(),
            TOO_LARGE
        );
        manifest.byte_length = data.len() as u64;
        manifest.chunks[0].byte_length = usize::MAX;
        assert_eq!(
            validate_manifest(&manifest, &expected, MAX_TEXT).unwrap_err(),
            TOO_LARGE
        );
        manifest.chunks[0].byte_length = data.len();
        manifest.chunks[0].index = 1;
        assert_eq!(
            validate_manifest(&manifest, &expected, MAX_TEXT).unwrap_err(),
            UNAVAILABLE
        );
        manifest.chunks[0].index = 0;
        manifest.chunks[0].digest = "../secret".into();
        assert_eq!(
            validate_manifest(&manifest, &expected, MAX_TEXT).unwrap_err(),
            UNAVAILABLE
        );
    }
}
fn body(value: DecryptedPeerContent, context: &str, id: &str) -> Result<Value, String> {
    if !hex(context, 64)
        || !delivery_id(id)
        || value.delivery_id != id
        || !content_id(&value.content_id)
    {
        return Err(UNAVAILABLE.into());
    }
    if !media(&value.media_type) {
        return Err(UNSUPPORTED.into());
    }
    if value.data.len() > ((MAX_TEXT + 2) / 3) * 4 {
        return Err(TOO_LARGE.into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(&value.data)
        .map_err(|_| UNAVAILABLE)?;
    if bytes.len() > MAX_TEXT {
        return Err(TOO_LARGE.into());
    }
    if URL_SAFE_NO_PAD.encode(&bytes) != value.data {
        return Err(UNAVAILABLE.into());
    }
    let text = String::from_utf8(bytes).map_err(|_| UNSUPPORTED)?;
    if text.contains('\0') {
        return Err(UNSUPPORTED.into());
    }
    if text.encode_utf16().count() > 100000 {
        return Err(TOO_LARGE.into());
    }
    if value.text.as_ref().is_some_and(|v| v != &text) {
        return Err(UNAVAILABLE.into());
    }
    let value = json!({"context":context,"deliveryId":id,"contentId":value.content_id,"mediaType":value.media_type,"byteLength":text.len(),"text":text});
    if serde_json::to_vec(&value).map_err(|_| UNAVAILABLE)?.len() > MAX_REPLY {
        return Err(TOO_LARGE.into());
    }
    Ok(value)
}
impl PersonalNodeService {
    pub(crate) async fn peer_read_context(&self) -> Result<String, String> {
        Ok(Scope::capture(self).await?.context)
    }
    pub(crate) async fn read_received_content(
        &self,
        delivery_id: &str,
        expected_context: &str,
    ) -> Result<Value, String> {
        if !super::peer_read::delivery_id(delivery_id) || !hex(expected_context, 64) {
            return Err(INVALID.into());
        }
        let scope = Scope::capture(self).await?;
        if scope.context != expected_context {
            return Err(CHANGED.into());
        }
        let result = self
            .decrypt_peer_content_with_limit(delivery_id, Some(MAX_TEXT))
            .await?;
        scope.check(self).await?;
        let result = body(result, &scope.context, delivery_id)?;
        scope.check(self).await?;
        Ok(result)
    }
}
