use base64::Engine;
use p256::ecdsa::{signature::Signer, signature::Verifier, Signature, SigningKey, VerifyingKey};
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use serde::{Deserialize, Serialize};
use sha2::Digest;

/// このノードの身元鍵。
///
/// Personal Node は「利用者が自分で持つ基盤」で、公開原本を保管して配信する側
/// （docs/HUB_PROTOCOL.md）。名乗るには鍵が要る。今まで `nodeId` は乱数16バイトの
/// 文字列でしかなく、**誰でも同じ文字列を名乗れた**。鍵があって初めて、
/// 「この投稿を出したのはこのノードだ」と示せる。
///
/// 種類はハブの Federation Gateway に合わせる。ECDSA P-256、SHA-256、署名は
/// base64url、公開鍵は JWK（`apps/federation/src/personal-node.ts` が
/// `crypto.subtle.importKey("jwk", …, {name:"ECDSA", namedCurve:"P-256"})` で
/// 検証している）。ここを推測で決めると、登録の最後まで行ってから弾かれる。

const B64URL: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// 外へ出してよい公開鍵。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PublicKeyJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
}

pub struct NodeKey {
    signing: SigningKey,
}

impl NodeKey {
    /// 新しく作る。
    pub fn create() -> Self {
        Self {
            signing: SigningKey::random(&mut rand::rngs::OsRng),
        }
    }

    /// 保存された鍵から戻す。
    pub fn from_pkcs8_pem(pem: &str) -> Result<Self, &'static str> {
        SigningKey::from_pkcs8_pem(pem)
            .map(|signing| Self { signing })
            .map_err(|_| "鍵を読めません")
    }

    /// 保存する形。**秘密鍵なので、これを外へ出さない。**
    pub fn to_pkcs8_pem(&self) -> Result<String, &'static str> {
        self.signing
            .to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
            .map(|pem| pem.to_string())
            .map_err(|_| "鍵を保存できません")
    }

    /// 外へ出す形。
    ///
    /// 座標は左詰め32バイトのまま base64url にする。前の0を落とすと、
    /// 相手の `importKey` が拒む。
    pub fn public_jwk(&self) -> PublicKeyJwk {
        let verifying = VerifyingKey::from(&self.signing);
        let point = verifying.to_encoded_point(false);
        PublicKeyJwk {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: B64URL.encode(point.x().expect("uncompressed point")),
            y: B64URL.encode(point.y().expect("uncompressed point")),
        }
    }

    /// 署名する。ハブは base64url の文字列として受け取る。
    pub fn sign(&self, message: &str) -> String {
        let signature: Signature = self.signing.sign(message.as_bytes());
        B64URL.encode(signature.to_bytes())
    }

    /// バイト列に署名する（r||s の 64 バイト）。Data Integrity（ecdsa-jcs-2019）の署名はバイナリの
    /// ハッシュ列に対して行うため、文字列版の `sign` では足りない。
    pub fn sign_bytes(&self, message: &[u8]) -> [u8; 64] {
        let signature: Signature = self.signing.sign(message);
        let mut out = [0_u8; 64];
        out.copy_from_slice(&signature.to_bytes());
        out
    }

    /// 自分の署名を確かめる。組み合わせ違いを早く見つけるためだけに使う。
    pub fn verify(&self, message: &str, signature: &str) -> bool {
        let Ok(raw) = B64URL.decode(signature) else {
            return false;
        };
        let Ok(parsed) = Signature::from_slice(&raw) else {
            return false;
        };
        VerifyingKey::from(&self.signing)
            .verify(message.as_bytes(), &parsed)
            .is_ok()
    }

    pub fn verify_with_jwk(jwk: &PublicKeyJwk, message: &str, signature: &str) -> bool {
        if jwk.kty != "EC" || jwk.crv != "P-256" {
            return false;
        }
        let (Ok(x), Ok(y), Ok(raw_signature)) = (
            B64URL.decode(&jwk.x),
            B64URL.decode(&jwk.y),
            B64URL.decode(signature),
        ) else {
            return false;
        };
        if x.len() != 32 || y.len() != 32 {
            return false;
        }
        let mut point = [0_u8; 65];
        point[0] = 4;
        point[1..33].copy_from_slice(&x);
        point[33..].copy_from_slice(&y);
        let (Ok(verifying), Ok(parsed)) = (
            VerifyingKey::from_sec1_bytes(&point),
            Signature::from_slice(&raw_signature),
        ) else {
            return false;
        };
        verifying.verify(message.as_bytes(), &parsed).is_ok()
    }

    /// 鍵の指紋。どの鍵で名乗っているかを画面に出すため。
    ///
    /// **公開鍵からだけ作る。** 秘密鍵を混ぜると、表示した時点で漏れの元になる。
    pub fn thumbprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let jwk = self.public_jwk();
        // JWK Thumbprint (RFC 7638) と同じ並び。鍵の名前は相手と揃える必要がある。
        let canonical = format!(
            r#"{{"crv":"{}","kty":"{}","x":"{}","y":"{}"}}"#,
            jwk.crv, jwk.kty, jwk.x, jwk.y
        );
        B64URL.encode(Sha256::digest(canonical.as_bytes()))
    }

    pub fn thumbprint_jwk(jwk: &PublicKeyJwk) -> Option<String> {
        if jwk.kty != "EC" || jwk.crv != "P-256" {
            return None;
        }
        let canonical = format!(
            r#"{{"crv":"{}","kty":"{}","x":"{}","y":"{}"}}"#,
            jwk.crv, jwk.kty, jwk.x, jwk.y
        );
        Some(B64URL.encode(sha2::Sha256::digest(canonical.as_bytes())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_survives_being_saved_and_read_back() {
        // 起動のたびに鍵が変わると、ノードは毎回別人になる。
        let key = NodeKey::create();
        let pem = key.to_pkcs8_pem().unwrap();
        let same = NodeKey::from_pkcs8_pem(&pem).unwrap();
        assert_eq!(same.public_jwk(), key.public_jwk());
        assert_eq!(same.thumbprint(), key.thumbprint());
    }

    #[test]
    fn the_public_part_is_the_shape_the_gateway_verifies_with() {
        // ECDSA P-256 の JWK。ここを推測で決めると、登録の最後まで行ってから弾かれる。
        let jwk = NodeKey::create().public_jwk();
        assert_eq!(jwk.kty, "EC");
        assert_eq!(jwk.crv, "P-256");
        // 座標は32バイト。base64url（詰め物なし）で43文字になる。
        assert_eq!(B64URL.decode(&jwk.x).unwrap().len(), 32);
        assert_eq!(B64URL.decode(&jwk.y).unwrap().len(), 32);
        assert!(!jwk.x.contains('=') && !jwk.x.contains('+') && !jwk.x.contains('/'));
    }

    #[test]
    fn it_signs_what_it_is_given_and_nothing_else() {
        let key = NodeKey::create();
        let signature = key.sign("challenge-1");
        assert!(key.verify("challenge-1", &signature));
        assert!(
            !key.verify("challenge-2", &signature),
            "別の文字列で通ってはいけない"
        );
        assert!(!key.verify("challenge-1", "not-base64url!!"));
        // 他の鍵の署名で通らない。
        assert!(!NodeKey::create().verify("challenge-1", &signature));
    }

    /// ハブ側の検証に本当に通るかを、実際に確かめるための材料を出す。
    /// 形が合っているつもりで最後まで行って弾かれるのがいちばん高くつく。
    ///   cargo test emit_material_for_the_gateway -- --ignored --nocapture
    #[test]
    #[ignore]
    fn emit_material_for_the_gateway() {
        let key = NodeKey::create();
        let jwk = key.public_jwk();
        let message = "personal-node-challenge-2026";
        println!(
            "{}",
            serde_json::json!({
                "jwk": { "kty": jwk.kty, "crv": jwk.crv, "x": jwk.x, "y": jwk.y },
                "message": message,
                "signature": key.sign(message)
            })
        );
    }

    #[test]
    fn two_keys_are_never_the_same_node() {
        let a = NodeKey::create();
        let b = NodeKey::create();
        assert_ne!(a.thumbprint(), b.thumbprint());
        assert_ne!(a.public_jwk(), b.public_jwk());
    }

    #[test]
    fn the_thumbprint_says_nothing_about_the_private_key() {
        // 指紋は画面に出す。秘密が混ざっていたら、出した時点で漏れる。
        let key = NodeKey::create();
        let pem = key.to_pkcs8_pem().unwrap();
        let secret = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        assert!(!secret.is_empty());
        assert!(!key.thumbprint().contains(&secret[..16]));
        assert_eq!(B64URL.decode(key.thumbprint()).unwrap().len(), 32);
    }
}
