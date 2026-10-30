use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const CHUNK_SIZE: usize = 512 * 1024;
pub const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
const UPLOAD_TTL_MINUTES: i64 = 60;
/// A directory without a readable `upload.json` has no expiry of its own.
const UNREADABLE_UPLOAD_AGE_HOURS: i64 = 24;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginArtifactUpload {
    pub file_name: String,
    pub media_type: String,
    pub byte_length: u64,
    pub kind: String,
    pub title: String,
    pub language: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactUpload {
    pub upload_id: String,
    pub file_name: String,
    pub media_type: String,
    pub byte_length: u64,
    pub chunk_size: usize,
    pub total_chunks: u32,
    pub kind: String,
    pub title: String,
    pub language: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactChunkInput {
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactChunkReceipt {
    pub upload_id: String,
    pub index: u32,
    pub byte_length: usize,
    pub digest: String,
    pub status: &'static str,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactChunkManifest {
    pub index: u32,
    pub byte_length: usize,
    pub digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactManifest {
    pub version: u8,
    pub blob_uri: String,
    pub file_name: String,
    pub media_type: String,
    pub byte_length: u64,
    pub digest: String,
    pub chunk_size: usize,
    pub chunks: Vec<ArtifactChunkManifest>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublishedBlob {
    pub digest: String,
    pub content_id: String,
    pub visibility: String,
    pub recipient_ids: Vec<String>,
    pub published_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactFinalization {
    upload: ArtifactUpload,
    manifest: ArtifactManifest,
}

#[derive(Clone)]
pub struct ArtifactStore {
    root: PathBuf,
}

impl ArtifactStore {
    pub fn open(storage_path: &str) -> Result<Self, &'static str> {
        let root = PathBuf::from(storage_path).join("artifacts");
        std::fs::create_dir_all(root.join("uploads"))
            .map_err(|_| "artifact_storage_unavailable")?;
        std::fs::create_dir_all(root.join("blobs")).map_err(|_| "artifact_storage_unavailable")?;
        std::fs::create_dir_all(root.join("finalized"))
            .map_err(|_| "artifact_storage_unavailable")?;
        std::fs::create_dir_all(root.join("published"))
            .map_err(|_| "artifact_storage_unavailable")?;
        Ok(Self { root })
    }

    pub fn begin(&self, input: BeginArtifactUpload) -> Result<ArtifactUpload, String> {
        let file_name = clean_file_name(&input.file_name)?;
        let media_type = clean_media_type(&input.media_type)?;
        if input.byte_length == 0 || input.byte_length > MAX_ARTIFACT_BYTES {
            return Err("ファイルは1バイト以上256MiB以下にしてください".into());
        }
        let kind = clean_kind(&input.kind, &media_type)?;
        let title = clean_text(&input.title, 240, false)?;
        let language = clean_language(&input.language)?;
        let total_chunks = input.byte_length.div_ceil(CHUNK_SIZE as u64) as u32;
        let now = Utc::now();
        let upload = ArtifactUpload {
            upload_id: format!("upload-{}", uuid::Uuid::new_v4().simple()),
            file_name,
            media_type,
            byte_length: input.byte_length,
            chunk_size: CHUNK_SIZE,
            total_chunks,
            kind,
            title,
            language,
            created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: (now + Duration::minutes(UPLOAD_TTL_MINUTES))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        let directory = self.upload_path(&upload.upload_id)?;
        std::fs::create_dir_all(directory.join("chunks"))
            .map_err(|_| "アップロードを準備できません")?;
        write_json_atomic(&directory.join("upload.json"), &upload).map_err(str::to_owned)?;
        Ok(upload)
    }

    pub fn put_chunk(
        &self,
        upload_id: &str,
        index: u32,
        input: ArtifactChunkInput,
    ) -> Result<ArtifactChunkReceipt, String> {
        let upload = self.read_upload(upload_id)?;
        ensure_fresh(&upload)?;
        if index >= upload.total_chunks {
            return Err("チャンク番号が範囲外です".into());
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(input.data.as_bytes())
            .map_err(|_| "チャンクがbase64urlではありません")?;
        let expected = if index + 1 == upload.total_chunks {
            (upload.byte_length - index as u64 * upload.chunk_size as u64) as usize
        } else {
            upload.chunk_size
        };
        if bytes.len() != expected {
            return Err("チャンク長が宣言と一致しません".into());
        }
        let path = self
            .upload_path(upload_id)?
            .join("chunks")
            .join(format!("{index:08}.bin"));
        if let Ok(existing) = std::fs::read(&path) {
            if existing != bytes {
                return Err("同じチャンク番号へ異なる内容は再送できません".into());
            }
        } else {
            write_bytes_atomic(&path, &bytes).map_err(str::to_owned)?;
        }
        Ok(ArtifactChunkReceipt {
            upload_id: upload_id.to_owned(),
            index,
            byte_length: bytes.len(),
            digest: sha256_hex(&bytes),
            status: "stored",
        })
    }

    pub fn finalize(&self, upload_id: &str) -> Result<(ArtifactUpload, ArtifactManifest), String> {
        let finalization_path = self.finalization_path(upload_id)?;
        if let Ok(bytes) = std::fs::read(&finalization_path) {
            let saved: ArtifactFinalization =
                serde_json::from_slice(&bytes).map_err(|_| "artifact確定情報が壊れています")?;
            return Ok((saved.upload, saved.manifest));
        }
        let upload = self.read_upload(upload_id)?;
        ensure_fresh(&upload)?;
        let upload_path = self.upload_path(upload_id)?;
        let mut full = Sha256::new();
        let mut chunks = Vec::with_capacity(upload.total_chunks as usize);
        let mut observed = 0_u64;
        for index in 0..upload.total_chunks {
            let bytes = std::fs::read(upload_path.join("chunks").join(format!("{index:08}.bin")))
                .map_err(|_| "未受信のチャンクがあります")?;
            observed += bytes.len() as u64;
            full.update(&bytes);
            chunks.push(ArtifactChunkManifest {
                index,
                byte_length: bytes.len(),
                digest: sha256_hex(&bytes),
            });
        }
        if observed != upload.byte_length {
            return Err("受信した総バイト数が宣言と一致しません".into());
        }
        let digest = hex_digest(full.finalize().as_slice());
        let manifest = ArtifactManifest {
            version: 1,
            blob_uri: format!("urn:hub:blob:{digest}"),
            file_name: upload.file_name.clone(),
            media_type: upload.media_type.clone(),
            byte_length: upload.byte_length,
            digest: digest.clone(),
            chunk_size: upload.chunk_size,
            chunks,
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        let blob_path = self.blob_path(&digest)?;
        if !blob_path.is_dir() {
            let temporary = self
                .root
                .join("blobs")
                .join(format!(".{digest}-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(temporary.join("chunks"))
                .map_err(|_| "artifactを確定できません")?;
            for chunk in &manifest.chunks {
                std::fs::copy(
                    upload_path
                        .join("chunks")
                        .join(format!("{:08}.bin", chunk.index)),
                    temporary
                        .join("chunks")
                        .join(format!("{:08}.bin", chunk.index)),
                )
                .map_err(|_| "artifactを確定できません")?;
            }
            write_json_atomic(&temporary.join("manifest.json"), &manifest)
                .map_err(str::to_owned)?;
            std::fs::rename(&temporary, &blob_path).map_err(|_| "artifactを確定できません")?;
        }
        write_json_atomic(
            &finalization_path,
            &ArtifactFinalization {
                upload: upload.clone(),
                manifest: manifest.clone(),
            },
        )
        .map_err(str::to_owned)?;
        // 確定結果は先に保存済み。掃除だけ失敗しても再試行結果は変えない。
        std::fs::remove_dir_all(&upload_path).ok();
        Ok((upload, manifest))
    }

    pub fn manifest(&self, digest: &str) -> Option<ArtifactManifest> {
        let path = self.blob_path(digest).ok()?.join("manifest.json");
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    pub fn chunk(&self, digest: &str, index: u32) -> Option<Vec<u8>> {
        let manifest = self.manifest(digest)?;
        if index >= manifest.chunks.len() as u32 {
            return None;
        }
        let bytes = std::fs::read(
            self.blob_path(digest)
                .ok()?
                .join("chunks")
                .join(format!("{index:08}.bin")),
        )
        .ok()?;
        let expected = &manifest.chunks[index as usize];
        (bytes.len() == expected.byte_length && sha256_hex(&bytes) == expected.digest)
            .then_some(bytes)
    }

    pub fn read_blob(&self, digest: &str) -> Result<(ArtifactManifest, Vec<u8>), String> {
        let manifest = self
            .manifest(digest)
            .ok_or_else(|| "artifactが見つかりません".to_owned())?;
        let mut bytes = Vec::with_capacity(manifest.byte_length as usize);
        for chunk in &manifest.chunks {
            bytes.extend_from_slice(
                &self
                    .chunk(digest, chunk.index)
                    .ok_or_else(|| "artifact chunkの検証に失敗しました".to_owned())?,
            );
        }
        if bytes.len() as u64 != manifest.byte_length || sha256_hex(&bytes) != manifest.digest {
            return Err("artifact全体の検証に失敗しました".into());
        }
        Ok((manifest, bytes))
    }

    pub fn store_bytes(
        &self,
        file_name: &str,
        media_type: &str,
        bytes: &[u8],
    ) -> Result<ArtifactManifest, String> {
        let file_name = clean_file_name(file_name)?;
        let media_type = clean_media_type(media_type)?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_ARTIFACT_BYTES + 16 {
            return Err("artifactの長さが不正です".into());
        }
        let digest = sha256_hex(bytes);
        let chunks = bytes
            .chunks(CHUNK_SIZE)
            .enumerate()
            .map(|(index, chunk)| ArtifactChunkManifest {
                index: index as u32,
                byte_length: chunk.len(),
                digest: sha256_hex(chunk),
            })
            .collect::<Vec<_>>();
        let manifest = ArtifactManifest {
            version: 1,
            blob_uri: format!("urn:hub:blob:{digest}"),
            file_name,
            media_type,
            byte_length: bytes.len() as u64,
            digest: digest.clone(),
            chunk_size: CHUNK_SIZE,
            chunks,
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        let path = self.blob_path(&digest)?;
        if !path.is_dir() {
            let temporary = self
                .root
                .join("blobs")
                .join(format!(".{digest}-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(temporary.join("chunks"))
                .map_err(|_| "artifactを保存できません")?;
            for (index, chunk) in bytes.chunks(CHUNK_SIZE).enumerate() {
                write_bytes_atomic(
                    &temporary.join("chunks").join(format!("{index:08}.bin")),
                    chunk,
                )
                .map_err(str::to_owned)?;
            }
            write_json_atomic(&temporary.join("manifest.json"), &manifest)
                .map_err(str::to_owned)?;
            std::fs::rename(temporary, path).map_err(|_| "artifactを保存できません")?;
        }
        self.read_blob(&digest)?;
        Ok(manifest)
    }

    pub fn publish(
        &self,
        digest: &str,
        content_id: &str,
        visibility: &str,
        recipient_ids: Vec<String>,
    ) -> Result<PublishedBlob, String> {
        self.read_blob(digest)?;
        let path = self.published_path(digest)?;
        if let Some(existing) = read_json::<PublishedBlob>(&path) {
            // 同じ公開bytesは複数の公開Envelopeから参照してよい。一度publicにした
            // bytesを、別のcontentIdだからという理由で再び非公開扱いにはしない。
            if existing.visibility == "public" && visibility == "public" {
                return Ok(existing);
            }
            if existing.content_id == content_id
                && existing.visibility == visibility
                && existing.recipient_ids == recipient_ids
            {
                return Ok(existing);
            }
            return Err("同じBlobの公開条件が既存記録と一致しません".into());
        }
        let marker = PublishedBlob {
            digest: digest.into(),
            content_id: content_id.into(),
            visibility: visibility.into(),
            recipient_ids,
            published_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        write_json_atomic(&path, &marker).map_err(str::to_owned)?;
        Ok(marker)
    }

    pub fn published_manifest(&self, digest: &str) -> Option<(PublishedBlob, ArtifactManifest)> {
        let marker = read_json(&self.published_path(digest).ok()?)?;
        let manifest = self.manifest(digest)?;
        Some((marker, manifest))
    }

    pub fn published_chunk(&self, digest: &str, index: u32) -> Option<Vec<u8>> {
        self.published_manifest(digest)?;
        self.chunk(digest, index)
    }

    /// Startup cleanup of uploads that can no longer be finalized: the upload's
    /// own `expiresAt` has passed (finalize refuses it), or `upload.json` is
    /// missing/unreadable and the directory is older than `UNREADABLE_UPLOAD_AGE`.
    /// Only `uploads/` is touched; blobs, finalized records and published
    /// artifacts are never removed. Returns the number of directories removed.
    pub fn purge_abandoned_uploads(&self, now: DateTime<Utc>) -> usize {
        let Ok(entries) = std::fs::read_dir(self.root.join("uploads")) else {
            return 0;
        };
        let mut removed = 0;
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() || safe_id(&entry.file_name().to_string_lossy()).is_err() {
                continue;
            }
            let abandoned = match read_json::<ArtifactUpload>(&path.join("upload.json")) {
                Some(upload) => DateTime::parse_from_rfc3339(&upload.expires_at)
                    .is_ok_and(|expiry| expiry <= now),
                None => std::fs::metadata(&path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .is_some_and(|modified| {
                        now.signed_duration_since(DateTime::<Utc>::from(modified))
                            >= Duration::hours(UNREADABLE_UPLOAD_AGE_HOURS)
                    }),
            };
            if abandoned && std::fs::remove_dir_all(&path).is_ok() {
                removed += 1;
            }
        }
        removed
    }

    fn read_upload(&self, upload_id: &str) -> Result<ArtifactUpload, String> {
        serde_json::from_slice(
            &std::fs::read(self.upload_path(upload_id)?.join("upload.json"))
                .map_err(|_| "アップロードが見つかりません")?,
        )
        .map_err(|_| "アップロード情報が壊れています".into())
    }

    fn upload_path(&self, id: &str) -> Result<PathBuf, String> {
        safe_id(id).map(|_| self.root.join("uploads").join(id))
    }

    fn finalization_path(&self, upload_id: &str) -> Result<PathBuf, String> {
        safe_id(upload_id).map(|_| {
            self.root
                .join("finalized")
                .join(format!("{upload_id}.json"))
        })
    }

    fn blob_path(&self, digest: &str) -> Result<PathBuf, String> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("artifact digestが不正です".into());
        }
        Ok(self.root.join("blobs").join(digest))
    }

    fn published_path(&self, digest: &str) -> Result<PathBuf, String> {
        self.blob_path(digest)?;
        Ok(self.root.join("published").join(format!("{digest}.json")))
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn ensure_fresh(upload: &ArtifactUpload) -> Result<(), String> {
    let expiry = DateTime::parse_from_rfc3339(&upload.expires_at)
        .map_err(|_| "アップロード期限が不正です")?;
    if expiry <= Utc::now() {
        return Err("アップロード期限が切れました".into());
    }
    Ok(())
}

fn safe_id(value: &str) -> Result<&str, String> {
    if value.len() < 8
        || value.len() > 100
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("識別子が不正です".into());
    }
    Ok(value)
}

fn clean_file_name(value: &str) -> Result<String, String> {
    let value = clean_text(value, 255, true)?;
    if value == "."
        || value == ".."
        || value
            .chars()
            .any(|character| matches!(character, '/' | '\\' | ':'))
    {
        return Err("ファイル名が不正です".into());
    }
    Ok(value)
}

fn clean_media_type(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() > 160 || !value.contains('/') || !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("メディア種別が不正です".into());
    }
    Ok(value)
}

fn clean_kind(value: &str, media_type: &str) -> Result<String, String> {
    let kind = value.trim().to_ascii_lowercase();
    let allowed = [
        "image", "audio", "video", "book", "document", "file", "game", "software", "product",
        "catalog",
    ];
    if !allowed.contains(&kind.as_str()) {
        return Err("artifactの種類が不正です".into());
    }
    if (kind == "image" && !media_type.starts_with("image/"))
        || (kind == "audio" && !media_type.starts_with("audio/"))
        || (kind == "video" && !media_type.starts_with("video/"))
    {
        return Err("種類とメディア種別が一致しません".into());
    }
    Ok(kind)
}

fn clean_language(value: &str) -> Result<String, String> {
    let language = value.trim().to_ascii_lowercase();
    if language.is_empty()
        || language.len() > 35
        || !language
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("言語タグが不正です".into());
    }
    Ok(language)
}

fn clean_text(value: &str, max: usize, required: bool) -> Result<String, String> {
    use unicode_normalization::UnicodeNormalization;
    let value = value.nfc().collect::<String>().trim().to_owned();
    if (required && value.is_empty())
        || value.chars().count() > max
        || value.chars().any(char::is_control)
    {
        return Err("入力が長すぎるか不正です".into());
    }
    Ok(value)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes).as_slice())
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes).map_err(|_| "書けません")?;
    std::fs::rename(temporary, path).map_err(|_| "書けません")
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "書けません")?;
    write_bytes_atomic(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (ArtifactStore, PathBuf) {
        let root = std::env::temp_dir().join(format!("hub-artifact-{}", uuid::Uuid::new_v4()));
        (ArtifactStore::open(&root.to_string_lossy()).unwrap(), root)
    }

    fn begin(store: &ArtifactStore, bytes: usize) -> ArtifactUpload {
        store
            .begin(BeginArtifactUpload {
                file_name: "sample.bin".into(),
                media_type: "application/octet-stream".into(),
                byte_length: bytes as u64,
                kind: "file".into(),
                title: "標本".into(),
                language: "ja".into(),
            })
            .unwrap()
    }

    #[test]
    fn chunks_are_idempotent_and_finalize_to_a_content_addressed_manifest() {
        let (store, root) = store();
        let data = vec![7_u8; CHUNK_SIZE + 3];
        let upload = begin(&store, data.len());
        for (index, chunk) in data.chunks(CHUNK_SIZE).enumerate() {
            let input = ArtifactChunkInput {
                data: URL_SAFE_NO_PAD.encode(chunk),
            };
            store
                .put_chunk(&upload.upload_id, index as u32, input.clone())
                .unwrap();
            store
                .put_chunk(&upload.upload_id, index as u32, input)
                .unwrap();
        }
        let (saved_upload, manifest) = store.finalize(&upload.upload_id).unwrap();
        let retry = store.finalize(&upload.upload_id).unwrap();
        assert_eq!(retry.0.upload_id, saved_upload.upload_id);
        assert_eq!(retry.1.digest, manifest.digest);
        assert_eq!(manifest.digest, sha256_hex(&data));
        assert_eq!(manifest.chunks.len(), 2);
        assert_eq!(store.chunk(&manifest.digest, 1).unwrap(), vec![7_u8; 3]);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn conflicting_retry_and_missing_chunk_fail_closed() {
        let (store, root) = store();
        let upload = begin(&store, CHUNK_SIZE + 1);
        store
            .put_chunk(
                &upload.upload_id,
                0,
                ArtifactChunkInput {
                    data: URL_SAFE_NO_PAD.encode(vec![1; CHUNK_SIZE]),
                },
            )
            .unwrap();
        assert!(store
            .put_chunk(
                &upload.upload_id,
                0,
                ArtifactChunkInput {
                    data: URL_SAFE_NO_PAD.encode(vec![2; CHUNK_SIZE])
                }
            )
            .is_err());
        assert!(store.finalize(&upload.upload_id).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn paths_and_mime_mismatches_are_rejected() {
        let (store, root) = store();
        assert!(store
            .begin(BeginArtifactUpload {
                file_name: "../secret".into(),
                media_type: "image/png".into(),
                byte_length: 1,
                kind: "image".into(),
                title: "".into(),
                language: "ja".into(),
            })
            .is_err());
        assert!(store
            .begin(BeginArtifactUpload {
                file_name: "x.png".into(),
                media_type: "audio/mpeg".into(),
                byte_length: 1,
                kind: "image".into(),
                title: "".into(),
                language: "ja".into(),
            })
            .is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn unpublished_bytes_are_not_visible_through_the_peer_gate() {
        let (store, root) = store();
        let manifest = store
            .store_bytes("private.bin", "application/octet-stream", b"ciphertext")
            .unwrap();
        assert!(store.published_manifest(&manifest.digest).is_none());
        assert!(store.published_chunk(&manifest.digest, 0).is_none());
        store
            .publish(
                &manifest.digest,
                "urn:hub:content:12345678",
                "private",
                vec!["peer-b".into()],
            )
            .unwrap();
        assert_eq!(
            store.published_chunk(&manifest.digest, 0).unwrap(),
            b"ciphertext"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn purge_removes_only_expired_unfinished_uploads() {
        let (store, root) = store();
        let live = begin(&store, 10);
        let old = begin(&store, 10);
        let finished = begin(&store, 10);
        store
            .put_chunk(&finished.upload_id, 0, ArtifactChunkInput { data: URL_SAFE_NO_PAD.encode([1u8; 10]) })
            .unwrap();
        let (_, manifest) = store.finalize(&finished.upload_id).unwrap();
        // Age the second upload past its own expiry.
        let path = store.upload_path(&old.upload_id).unwrap().join("upload.json");
        let mut aged: ArtifactUpload = read_json(&path).unwrap();
        aged.expires_at = "2020-01-01T00:00:00.000Z".into();
        write_json_atomic(&path, &aged).unwrap();
        // An unreadable upload.json is kept while young.
        let broken = store.upload_path("upload-broken1").unwrap();
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("upload.json"), b"{").unwrap();

        assert_eq!(store.purge_abandoned_uploads(Utc::now()), 1);
        assert!(store.upload_path(&live.upload_id).unwrap().is_dir());
        assert!(!store.upload_path(&old.upload_id).unwrap().exists());
        assert!(broken.is_dir());
        assert!(store.manifest(&manifest.digest).is_some());
        // A day later the unreadable one goes too; the live one has expired by then.
        assert_eq!(store.purge_abandoned_uploads(Utc::now() + Duration::hours(25)), 2);
        assert!(store.manifest(&manifest.digest).is_some());
        assert!(store.finalize(&finished.upload_id).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }
}
