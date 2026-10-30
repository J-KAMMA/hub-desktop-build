use aes::cipher::{generic_array::GenericArray, BlockDecrypt, BlockEncrypt, KeyInit};
use aes::Aes256;
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use p256::{
    ecdh::diffie_hellman,
    pkcs8::{DecodePrivateKey, EncodePrivateKey},
    PublicKey, SecretKey,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{node_identity::PublicKeyJwk, node_log::canonical_json};

pub const SUITE: &str = "ECDH-P256+HKDF-SHA256+A256KW+A256GCM";
const AES_KW_IV: [u8; 8] = [0xA6; 8];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WrappedRecipient {
    pub recipient_id: String,
    pub key_id: String,
    pub wrapped_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionMetadata {
    pub suite: String,
    pub iv: String,
    pub salt: String,
    pub ephemeral_public_key_jwk: PublicKeyJwk,
    pub recipients: Vec<WrappedRecipient>,
}

#[derive(Clone)]
pub struct RecipientSpec {
    pub recipient_id: String,
    pub key_id: String,
    pub public_key_jwk: PublicKeyJwk,
}

pub struct EncryptedRepresentation {
    pub ciphertext: Vec<u8>,
    pub metadata: EncryptionMetadata,
}

pub struct NodeEncryptionKey {
    secret: SecretKey,
}

impl NodeEncryptionKey {
    pub fn create() -> Self {
        Self {
            secret: SecretKey::random(&mut rand::rngs::OsRng),
        }
    }

    pub fn from_pkcs8_pem(pem: &str) -> Result<Self, &'static str> {
        SecretKey::from_pkcs8_pem(pem)
            .map(|secret| Self { secret })
            .map_err(|_| "暗号鍵を読めません")
    }

    pub fn to_pkcs8_pem(&self) -> Result<String, &'static str> {
        self.secret
            .to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
            .map(|pem| pem.to_string())
            .map_err(|_| "暗号鍵を保存できません")
    }

    pub fn public_jwk(&self) -> PublicKeyJwk {
        public_jwk(&self.secret.public_key())
    }

    pub fn thumbprint(&self) -> String {
        let jwk = self.public_jwk();
        let canonical = format!(
            r#"{{"crv":"{}","kty":"{}","x":"{}","y":"{}"}}"#,
            jwk.crv, jwk.kty, jwk.x, jwk.y
        );
        URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()))
    }

    pub fn decrypt(
        &self,
        content_id: &str,
        representation_id: &str,
        media_type: &str,
        visibility: &str,
        recipient_id: &str,
        key_id: &str,
        ciphertext: &[u8],
        metadata: &EncryptionMetadata,
    ) -> Result<Vec<u8>, String> {
        if metadata.suite != SUITE {
            return Err("未対応の暗号方式です".into());
        }
        let recipient = metadata
            .recipients
            .iter()
            .find(|entry| entry.recipient_id == recipient_id && entry.key_id == key_id)
            .ok_or_else(|| "この端末は受信者ではありません".to_owned())?;
        let ephemeral = public_key(&metadata.ephemeral_public_key_jwk)?;
        let shared = diffie_hellman(self.secret.to_nonzero_scalar(), ephemeral.as_affine());
        let salt = decode_exact::<16>(&metadata.salt, "salt")?;
        let wrapping_key = hkdf_sha256(
            shared.raw_secret_bytes().as_slice(),
            &salt,
            encryption_info(content_id, representation_id, recipient_id, key_id).as_bytes(),
            32,
        );
        let wrapped = URL_SAFE_NO_PAD
            .decode(&recipient.wrapped_key)
            .map_err(|_| "wrapped keyが不正です")?;
        let content_key = aes_kw_unwrap(&wrapping_key, &wrapped)?;
        let iv = decode_exact::<12>(&metadata.iv, "iv")?;
        Aes256Gcm::new_from_slice(&content_key)
            .map_err(|_| "content keyが不正です")?
            .decrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: ciphertext,
                    aad: encryption_aad(content_id, representation_id, media_type, visibility)
                        .as_bytes(),
                },
            )
            .map_err(|_| "暗号文の認証に失敗しました".into())
    }
}

pub fn encrypt(
    content_id: &str,
    representation_id: &str,
    media_type: &str,
    visibility: &str,
    plaintext: &[u8],
    recipients: &[RecipientSpec],
) -> Result<EncryptedRepresentation, String> {
    if recipients.is_empty() || recipients.len() > 256 {
        return Err("受信者は1から256件にしてください".into());
    }
    let mut unique = std::collections::HashSet::new();
    if recipients
        .iter()
        .any(|entry| !unique.insert(format!("{}\0{}", entry.recipient_id, entry.key_id)))
    {
        return Err("受信者が重複しています".into());
    }
    let mut content_key = [0_u8; 32];
    let mut salt = [0_u8; 16];
    let mut iv = [0_u8; 12];
    rand::thread_rng().fill_bytes(&mut content_key);
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut iv);
    let ephemeral = SecretKey::random(&mut rand::rngs::OsRng);
    let mut wrapped_recipients = Vec::with_capacity(recipients.len());
    for recipient in recipients {
        let public = public_key(&recipient.public_key_jwk)?;
        let shared = diffie_hellman(ephemeral.to_nonzero_scalar(), public.as_affine());
        let wrapping_key = hkdf_sha256(
            shared.raw_secret_bytes().as_slice(),
            &salt,
            encryption_info(
                content_id,
                representation_id,
                &recipient.recipient_id,
                &recipient.key_id,
            )
            .as_bytes(),
            32,
        );
        wrapped_recipients.push(WrappedRecipient {
            recipient_id: recipient.recipient_id.clone(),
            key_id: recipient.key_id.clone(),
            wrapped_key: URL_SAFE_NO_PAD.encode(aes_kw_wrap(&wrapping_key, &content_key)?),
        });
    }
    let ciphertext = Aes256Gcm::new_from_slice(&content_key)
        .map_err(|_| "content keyが不正です")?
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plaintext,
                aad: encryption_aad(content_id, representation_id, media_type, visibility)
                    .as_bytes(),
            },
        )
        .map_err(|_| "暗号化できません")?;
    Ok(EncryptedRepresentation {
        ciphertext,
        metadata: EncryptionMetadata {
            suite: SUITE.into(),
            iv: URL_SAFE_NO_PAD.encode(iv),
            salt: URL_SAFE_NO_PAD.encode(salt),
            ephemeral_public_key_jwk: public_jwk(&ephemeral.public_key()),
            recipients: wrapped_recipients,
        },
    })
}

fn public_jwk(public: &PublicKey) -> PublicKeyJwk {
    let point = public.to_sec1_bytes();
    PublicKeyJwk {
        kty: "EC".into(),
        crv: "P-256".into(),
        x: URL_SAFE_NO_PAD.encode(&point[1..33]),
        y: URL_SAFE_NO_PAD.encode(&point[33..65]),
    }
}

fn public_key(jwk: &PublicKeyJwk) -> Result<PublicKey, String> {
    if jwk.kty != "EC" || jwk.crv != "P-256" {
        return Err("受信者公開鍵がP-256ではありません".into());
    }
    let x = decode_exact::<32>(&jwk.x, "x")?;
    let y = decode_exact::<32>(&jwk.y, "y")?;
    let mut encoded = [0_u8; 65];
    encoded[0] = 4;
    encoded[1..33].copy_from_slice(&x);
    encoded[33..65].copy_from_slice(&y);
    PublicKey::from_sec1_bytes(&encoded).map_err(|_| "受信者公開鍵が不正です".into())
}

fn decode_exact<const N: usize>(value: &str, name: &str) -> Result<[u8; N], String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("{name}がbase64urlではありません"))?
        .try_into()
        .map_err(|_| format!("{name}の長さが不正です"))
}

fn encryption_info(
    content_id: &str,
    representation_id: &str,
    recipient_id: &str,
    key_id: &str,
) -> String {
    canonical_json(&serde_json::json!({
        "protocol": "https://hub.jkamma.com/spec/content-envelope/v1",
        "purpose": "content-key-wrap",
        "contentId": content_id,
        "representationId": representation_id,
        "recipientId": recipient_id,
        "keyId": key_id
    }))
}

fn encryption_aad(
    content_id: &str,
    representation_id: &str,
    media_type: &str,
    visibility: &str,
) -> String {
    canonical_json(&serde_json::json!({
        "protocol": "https://hub.jkamma.com/spec/content-envelope/v1",
        "purpose": "content-representation",
        "contentId": content_id,
        "representationId": representation_id,
        "mediaType": media_type,
        "visibility": visibility
    }))
}

fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], length: usize) -> Vec<u8> {
    type HmacSha256 = Hmac<Sha256>;
    let mut extract = <HmacSha256 as Mac>::new_from_slice(salt).expect("HMAC key");
    extract.update(ikm);
    let prk = extract.finalize().into_bytes();
    let mut output = Vec::with_capacity(length);
    let mut previous = Vec::new();
    let mut counter = 1_u8;
    while output.len() < length {
        let mut expand = <HmacSha256 as Mac>::new_from_slice(&prk).expect("HMAC key");
        expand.update(&previous);
        expand.update(info);
        expand.update(&[counter]);
        previous = expand.finalize().into_bytes().to_vec();
        output.extend_from_slice(&previous);
        counter = counter.checked_add(1).expect("HKDF output bounded");
    }
    output.truncate(length);
    output
}

fn aes_kw_wrap(kek: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if plaintext.len() < 16 || plaintext.len() % 8 != 0 {
        return Err("wrap対象の長さが不正です".into());
    }
    let cipher = Aes256::new_from_slice(kek).map_err(|_| "wrapping keyが不正です")?;
    let n = plaintext.len() / 8;
    let mut a = AES_KW_IV;
    let mut r = plaintext
        .chunks_exact(8)
        .map(|part| part.try_into().unwrap())
        .collect::<Vec<[u8; 8]>>();
    for round in 0..6 {
        for index in 0..n {
            let mut block = [0_u8; 16];
            block[..8].copy_from_slice(&a);
            block[8..].copy_from_slice(&r[index]);
            cipher.encrypt_block(GenericArray::from_mut_slice(&mut block));
            let t = (n * round + index + 1) as u64;
            a.copy_from_slice(&block[..8]);
            for (byte, mask) in a.iter_mut().zip(t.to_be_bytes()) {
                *byte ^= mask;
            }
            r[index].copy_from_slice(&block[8..]);
        }
    }
    Ok([a.to_vec(), r.into_iter().flatten().collect()].concat())
}

fn aes_kw_unwrap(kek: &[u8], wrapped: &[u8]) -> Result<Vec<u8>, String> {
    if wrapped.len() < 24 || wrapped.len() % 8 != 0 {
        return Err("wrapped keyの長さが不正です".into());
    }
    let cipher = Aes256::new_from_slice(kek).map_err(|_| "wrapping keyが不正です")?;
    let n = wrapped.len() / 8 - 1;
    let mut a: [u8; 8] = wrapped[..8].try_into().unwrap();
    let mut r = wrapped[8..]
        .chunks_exact(8)
        .map(|part| part.try_into().unwrap())
        .collect::<Vec<[u8; 8]>>();
    for round in (0..6).rev() {
        for index in (0..n).rev() {
            let t = (n * round + index + 1) as u64;
            let mut block = [0_u8; 16];
            let mut adjusted = a;
            for (byte, mask) in adjusted.iter_mut().zip(t.to_be_bytes()) {
                *byte ^= mask;
            }
            block[..8].copy_from_slice(&adjusted);
            block[8..].copy_from_slice(&r[index]);
            cipher.decrypt_block(GenericArray::from_mut_slice(&mut block));
            a.copy_from_slice(&block[..8]);
            r[index].copy_from_slice(&block[8..]);
        }
    }
    if a != AES_KW_IV {
        return Err("wrapped keyの認証に失敗しました".into());
    }
    Ok(r.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_nodes_encrypt_and_decrypt_but_an_outsider_cannot() {
        let recipient = NodeEncryptionKey::create();
        let outsider = NodeEncryptionKey::create();
        let encrypted = encrypt(
            "urn:hub:content:12345678",
            "primary",
            "application/octet-stream",
            "private",
            b"shared memory",
            &[RecipientSpec {
                recipient_id: "node-b".into(),
                key_id: "e2ee-v1".into(),
                public_key_jwk: recipient.public_jwk(),
            }],
        )
        .unwrap();
        assert_ne!(encrypted.ciphertext, b"shared memory");
        assert_eq!(
            recipient
                .decrypt(
                    "urn:hub:content:12345678",
                    "primary",
                    "application/octet-stream",
                    "private",
                    "node-b",
                    "e2ee-v1",
                    &encrypted.ciphertext,
                    &encrypted.metadata,
                )
                .unwrap(),
            b"shared memory"
        );
        assert!(outsider
            .decrypt(
                "urn:hub:content:12345678",
                "primary",
                "application/octet-stream",
                "private",
                "node-x",
                "e2ee-v1",
                &encrypted.ciphertext,
                &encrypted.metadata,
            )
            .is_err());
    }

    #[test]
    fn tampering_and_wrong_aad_fail_closed() {
        let recipient = NodeEncryptionKey::create();
        let encrypted = encrypt(
            "urn:hub:content:12345678",
            "primary",
            "text/plain",
            "private",
            b"secret",
            &[RecipientSpec {
                recipient_id: "node-b".into(),
                key_id: "e2ee-v1".into(),
                public_key_jwk: recipient.public_jwk(),
            }],
        )
        .unwrap();
        let mut tampered = encrypted.ciphertext.clone();
        tampered[0] ^= 1;
        assert!(recipient
            .decrypt(
                "urn:hub:content:12345678",
                "primary",
                "text/plain",
                "private",
                "node-b",
                "e2ee-v1",
                &tampered,
                &encrypted.metadata,
            )
            .is_err());
        assert!(recipient
            .decrypt(
                "urn:hub:content:changed",
                "primary",
                "text/plain",
                "private",
                "node-b",
                "e2ee-v1",
                &encrypted.ciphertext,
                &encrypted.metadata,
            )
            .is_err());
    }

    #[test]
    fn encryption_key_round_trips_without_exposing_the_private_half() {
        let key = NodeEncryptionKey::create();
        let pem = key.to_pkcs8_pem().unwrap();
        let restored = NodeEncryptionKey::from_pkcs8_pem(&pem).unwrap();
        assert_eq!(restored.public_jwk(), key.public_jwk());
        assert_eq!(restored.thumbprint(), key.thumbprint());
        assert!(!serde_json::to_string(&key.public_jwk())
            .unwrap()
            .contains("PRIVATE"));
    }
}
