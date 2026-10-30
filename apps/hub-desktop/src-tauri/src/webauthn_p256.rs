//! WebAuthn P-256 の署名を、スマートウォレットの検証器が受け取る形に包む。
//!
//! 第0段の試作（`spikes/passkey-spike`）と第1段の `smart_wallet.rs` が共に使う。
//! 形は `apps/smart-wallet-contracts/src/webauthn-userop.ts` の
//! `encodeWebAuthnAssertion` と同じで、`abi.encode(r, s, challengeIndex,
//! typeIndex, authenticatorData, clientDataJSON)` になる。検証器
//! （`HubWebAuthnP256Validator`）は OpenZeppelin 5.7 の `WebAuthn.verify` を
//! 使い、rpId と origin は見ない。`verify_like_validator` はその検査を手元で
//! なぞり、送る前に落とすために使う。
//!
//! この模組は秘密鍵を扱わない。署名は Windows Hello などの認証器が作る。
//! 自前で依存を増やさないよう、試作の別 crate からも `#[path]` で読み込める
//! ように `p256`・`sha2`・`sha3`・`base64` だけを使う。

use base64::Engine as _;
use p256::ecdsa::signature::hazmat::PrehashVerifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::EncodedPoint;
use sha2::{Digest, Sha256};
use sha3::Keccak256;

/// Desktop の主の鍵に使う専用の rpId（計画の 3.3、2026-10-18 決定）。
pub const DESKTOP_WALLET_RP_ID: &str = "desktop-wallet.hub.jkamma.com";

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;

/// P-256 の位数 n の半分（OpenZeppelin `P256.HALF_N`）。これより大きい s は検証器が拒む。
const HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
];
const N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
];

#[derive(Debug, PartialEq, Eq)]
pub enum WebAuthnEncodingError {
    InvalidDerSignature,
    InvalidClientDataJson,
    InvalidAuthenticatorData,
    InvalidCoseKey,
}

/// 認証器が返した1回分の署名。
pub struct WebAuthnAssertion<'a> {
    pub authenticator_data: &'a [u8],
    pub client_data_json: &'a str,
    pub signature_der: &'a [u8],
}

pub fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 署名用の clientDataJSON。challenge は検証器へ渡す 32 バイトのハッシュそのもの。
pub fn client_data_json_for_get(challenge: &[u8; 32], rp_id: &str) -> String {
    format!(
        "{{\"type\":\"webauthn.get\",\"challenge\":\"{}\",\"origin\":\"https://{}\",\"crossOrigin\":false}}",
        base64url(challenge),
        rp_id
    )
}

pub fn client_data_json_for_create(challenge: &[u8; 32], rp_id: &str) -> String {
    format!(
        "{{\"type\":\"webauthn.create\",\"challenge\":\"{}\",\"origin\":\"https://{}\",\"crossOrigin\":false}}",
        base64url(challenge),
        rp_id
    )
}

fn fixed32(value: &[u8]) -> Result<[u8; 32], WebAuthnEncodingError> {
    let mut start = 0;
    while start + 1 < value.len() && value[start] == 0 {
        start += 1;
    }
    let trimmed = &value[start..];
    if trimmed.is_empty() || trimmed.len() > 32 {
        return Err(WebAuthnEncodingError::InvalidDerSignature);
    }
    let mut out = [0u8; 32];
    out[32 - trimmed.len()..].copy_from_slice(trimmed);
    Ok(out)
}

fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut v = a[i] as i16 - b[i] as i16 - borrow;
        borrow = if v < 0 {
            v += 256;
            1
        } else {
            0
        };
        out[i] = v as u8;
    }
    out
}

/// DER の署名を (r, s) へほどき、s を小さい側へ寄せる。
/// `webauthn-userop.ts` の `parseP256DerSignature` と同じ厳しさで読む。
pub fn parse_der_signature(der: &[u8]) -> Result<([u8; 32], [u8; 32]), WebAuthnEncodingError> {
    let bad = WebAuthnEncodingError::InvalidDerSignature;
    if der.len() < 8 || der[0] != 0x30 || der[1] as usize != der.len() - 2 || der[2] != 0x02 {
        return Err(bad);
    }
    let r_len = der[3] as usize;
    let s_tag = 4 + r_len;
    if r_len == 0 || s_tag + 2 > der.len() || der[s_tag] != 0x02 {
        return Err(bad);
    }
    let s_len = der[s_tag + 1] as usize;
    let s_start = s_tag + 2;
    if s_len == 0 || s_start + s_len != der.len() {
        return Err(bad);
    }
    let r = fixed32(&der[4..s_tag])?;
    let s = fixed32(&der[s_start..])?;
    let s = if s > HALF_N { sub_be(&N, &s) } else { s };
    Ok((r, s))
}

fn word(value: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&(value as u64).to_be_bytes());
    out
}

fn padded(bytes: &[u8]) -> Vec<u8> {
    let mut out = word(bytes.len()).to_vec();
    out.extend_from_slice(bytes);
    out.resize(32 + bytes.len().div_ceil(32) * 32, 0);
    out
}

/// 検証器へ渡す署名のバイト列（`encodeWebAuthnAssertion` と同じ）。
pub fn encode_assertion(assertion: &WebAuthnAssertion<'_>) -> Result<Vec<u8>, WebAuthnEncodingError> {
    let (r, s) = parse_der_signature(assertion.signature_der)?;
    let json = assertion.client_data_json;
    let challenge_index = json
        .find("\"challenge\":\"")
        .ok_or(WebAuthnEncodingError::InvalidClientDataJson)?;
    let type_index = json
        .find("\"type\":\"webauthn.get\"")
        .ok_or(WebAuthnEncodingError::InvalidClientDataJson)?;
    let auth_tail = padded(assertion.authenticator_data);
    let json_tail = padded(json.as_bytes());
    let mut out = Vec::with_capacity(192 + auth_tail.len() + json_tail.len());
    out.extend_from_slice(&r);
    out.extend_from_slice(&s);
    out.extend_from_slice(&word(challenge_index));
    out.extend_from_slice(&word(type_index));
    out.extend_from_slice(&word(0xc0));
    out.extend_from_slice(&word(0xc0 + auth_tail.len()));
    out.extend_from_slice(&auth_tail);
    out.extend_from_slice(&json_tail);
    Ok(out)
}

/// 検証器の公開鍵の形 `abi.encode(bytes32 qx, bytes32 qy)`。
pub fn encode_public_key(qx: &[u8; 32], qy: &[u8; 32]) -> Vec<u8> {
    let mut out = qx.to_vec();
    out.extend_from_slice(qy);
    out
}

fn read_word_usize(input: &[u8], at: usize) -> Option<usize> {
    let w = input.get(at..at.checked_add(32)?)?;
    if w[..24].iter().any(|b| *b != 0) {
        return None;
    }
    usize::try_from(u64::from_be_bytes(w[24..].try_into().ok()?)).ok()
}

fn read_dynamic(input: &[u8], offset: usize) -> Option<&[u8]> {
    let len = read_word_usize(input, offset)?;
    let start = offset.checked_add(32)?;
    input.get(start..start.checked_add(len)?)
}

/// `HubWebAuthnP256Validator.validateSignature` と同じ判定を手元で行う。
/// 認証器が返したものを送る前に、ここで落とす。真の判定はチェーンの検証器が行う。
pub fn verify_like_validator(hash: &[u8; 32], signature: &[u8], qx: &[u8; 32], qy: &[u8; 32]) -> bool {
    if signature.len() < 0xc0 {
        return false;
    }
    let (Some(ci), Some(ti), Some(ad_off), Some(cd_off)) = (
        read_word_usize(signature, 0x40),
        read_word_usize(signature, 0x60),
        read_word_usize(signature, 0x80),
        read_word_usize(signature, 0xa0),
    ) else {
        return false;
    };
    let (Some(auth_data), Some(client_data)) = (read_dynamic(signature, ad_off), read_dynamic(signature, cd_off)) else {
        return false;
    };
    let r: [u8; 32] = signature[..32].try_into().unwrap();
    let s: [u8; 32] = signature[32..64].try_into().unwrap();
    if auth_data.len() <= 36 {
        return false;
    }
    let type_marker = b"\"type\":\"webauthn.get\"";
    if client_data.get(ti..ti.saturating_add(type_marker.len())) != Some(&type_marker[..]) {
        return false;
    }
    let expected_challenge = format!("\"challenge\":\"{}\"", base64url(hash));
    if client_data.get(ci..ci.saturating_add(expected_challenge.len())) != Some(expected_challenge.as_bytes()) {
        return false;
    }
    let flags = auth_data[32];
    if flags & FLAG_UP == 0 || flags & FLAG_UV == 0 {
        return false;
    }
    if flags & FLAG_BE == 0 && flags & FLAG_BS != 0 {
        return false;
    }
    if s > HALF_N {
        return false;
    }
    let Ok(signature) = Signature::from_scalars(r, s) else {
        return false;
    };
    let point = EncodedPoint::from_affine_coordinates(qx.into(), qy.into(), false);
    let Ok(key) = VerifyingKey::from_encoded_point(&point) else {
        return false;
    };
    let mut signed = auth_data.to_vec();
    signed.extend_from_slice(&Sha256::digest(client_data));
    let digest = Sha256::digest(&signed);
    key.verify_prehash(&digest, &signature).is_ok()
}

/// eth_call 用の `validateSignature(bytes32,bytes,bytes)` の呼び出しデータ。
pub fn validate_signature_calldata(hash: &[u8; 32], signature: &[u8], public_key: &[u8]) -> Vec<u8> {
    let selector = &Keccak256::digest(b"validateSignature(bytes32,bytes,bytes)")[..4];
    let sig_tail = padded(signature);
    let mut out = selector.to_vec();
    out.extend_from_slice(hash);
    out.extend_from_slice(&word(0x60));
    out.extend_from_slice(&word(0x60 + sig_tail.len()));
    out.extend_from_slice(&sig_tail);
    out.extend_from_slice(&padded(public_key));
    out
}

/// 作成時の authenticatorData から（credential ID, qx, qy）を取り出す。
/// COSE の EC2 / ES256 / P-256 だけを受け、ほかは拒む。
pub fn parse_attested_p256_key(
    authenticator_data: &[u8],
    rp_id: &str,
) -> Result<(Vec<u8>, [u8; 32], [u8; 32]), WebAuthnEncodingError> {
    let bad = WebAuthnEncodingError::InvalidAuthenticatorData;
    if authenticator_data.len() < 55 || authenticator_data[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        return Err(bad);
    }
    if authenticator_data[32] & FLAG_AT == 0 {
        return Err(bad);
    }
    let id_len = u16::from_be_bytes([authenticator_data[53], authenticator_data[54]]) as usize;
    let id = authenticator_data.get(55..55 + id_len).ok_or(bad)?.to_vec();
    let (qx, qy) = parse_cose_p256(&authenticator_data[55 + id_len..])?;
    Ok((id, qx, qy))
}

fn cbor_head(input: &[u8], pos: &mut usize) -> Option<(u8, u64)> {
    let first = *input.get(*pos)?;
    *pos += 1;
    let major = first >> 5;
    let info = first & 0x1f;
    let value = match info {
        0..=23 => info as u64,
        24 => {
            let v = *input.get(*pos)? as u64;
            *pos += 1;
            v
        }
        25 => {
            let v = u16::from_be_bytes(input.get(*pos..*pos + 2)?.try_into().ok()?) as u64;
            *pos += 2;
            v
        }
        _ => return None,
    };
    Some((major, value))
}

fn cbor_int(input: &[u8], pos: &mut usize) -> Option<i64> {
    match cbor_head(input, pos)? {
        (0, v) => Some(v as i64),
        (1, v) => Some(-1 - v as i64),
        _ => None,
    }
}

fn parse_cose_p256(input: &[u8]) -> Result<([u8; 32], [u8; 32]), WebAuthnEncodingError> {
    let bad = WebAuthnEncodingError::InvalidCoseKey;
    let mut pos = 0;
    let (major, entries) = cbor_head(input, &mut pos).ok_or(bad)?;
    if major != 5 || entries > 16 {
        return Err(WebAuthnEncodingError::InvalidCoseKey);
    }
    let (mut kty, mut alg, mut crv, mut x, mut y) = (None, None, None, None, None);
    for _ in 0..entries {
        let key = cbor_int(input, &mut pos).ok_or(WebAuthnEncodingError::InvalidCoseKey)?;
        let save = pos;
        match cbor_head(input, &mut pos).ok_or(WebAuthnEncodingError::InvalidCoseKey)? {
            (0, _) | (1, _) => {
                pos = save;
                let v = cbor_int(input, &mut pos).ok_or(WebAuthnEncodingError::InvalidCoseKey)?;
                match key {
                    1 => kty = Some(v),
                    3 => alg = Some(v),
                    -1 => crv = Some(v),
                    _ => {}
                }
            }
            (2, len) => {
                let len = len as usize;
                let bytes = input.get(pos..pos + len).ok_or(WebAuthnEncodingError::InvalidCoseKey)?;
                pos += len;
                match key {
                    -2 => x = Some(bytes),
                    -3 => y = Some(bytes),
                    _ => {}
                }
            }
            _ => return Err(WebAuthnEncodingError::InvalidCoseKey),
        }
    }
    if kty != Some(2) || alg != Some(-7) || crv != Some(1) {
        return Err(WebAuthnEncodingError::InvalidCoseKey);
    }
    let qx: [u8; 32] = x.and_then(|v| v.try_into().ok()).ok_or(WebAuthnEncodingError::InvalidCoseKey)?;
    let qy: [u8; 32] = y.and_then(|v| v.try_into().ok()).ok_or(WebAuthnEncodingError::InvalidCoseKey)?;
    let point = EncodedPoint::from_affine_coordinates(&qx.into(), &qy.into(), false);
    VerifyingKey::from_encoded_point(&point).map_err(|_| WebAuthnEncodingError::InvalidCoseKey)?;
    Ok((qx, qy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    use p256::ecdsa::SigningKey;

    fn hex(s: &str) -> Vec<u8> {
        let s = s.trim_start_matches("0x");
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn h32(s: &str) -> [u8; 32] {
        hex(s).try_into().unwrap()
    }

    // 黄金値は `spikes/passkey-spike/golden/generate.mts` が `webauthn-userop.ts` の
    // `encodeWebAuthnAssertion` と @noble/curves で作った。同じ calldata を Kairos の
    // HubWebAuthnP256Validator（0x1D98…D81D）へ eth_call すると true が返る（2026-10-17）。
    const QX: &str = "0x3ad3861a95621392516bb593ef05583ed2e5866f5cb6260a3017237fd89b90af";
    const QY: &str = "0xd0961c7e37075a6791a39c61f56295b02b6d26567b615e60aa41ee1c8e83388d";
    const AUTH: &str = "0x7f057dda48ae8632457b75b9f0205be82fff54a72d279e73a0dd574f625fb3e10500000001";
    const DER: &str = "0x3045022100a0db2a906e4d1fb95b170d63b8bce2a75ae5b7a0f82d38873f39ef89fc606ea1022028ad896bb1d8089ce208cfa6286a08b4035a58a867b6e9d4e666818469d6f84a";
    const HIGH_DER: &str = "0x3046022100a0db2a906e4d1fb95b170d63b8bce2a75ae5b7a0f82d38873f39ef89fc606ea1022100d75276934e27f7641df73059d795f74bb98ca2053f60b4b00d53493e928c2d07";
    const ENC: &str = "0xa0db2a906e4d1fb95b170d63b8bce2a75ae5b7a0f82d38873f39ef89fc606ea128ad896bb1d8089ce208cfa6286a08b4035a58a867b6e9d4e666818469d6f84a0000000000000000000000000000000000000000000000000000000000000017000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000257f057dda48ae8632457b75b9f0205be82fff54a72d279e73a0dd574f625fb3e1050000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000967b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a2245524552455245524552455245524552455245524552455245524552455245524552455245524552455245222c226f726967696e223a2268747470733a2f2f6465736b746f702d77616c6c65742e6875622e6a6b616d6d612e636f6d222c2263726f73734f726967696e223a66616c73657d00000000000000000000";
    const CALLDATA_PREFIX: &str = "0xae7e17f0";

    fn golden_client_data() -> String {
        client_data_json_for_get(&[0x11; 32], DESKTOP_WALLET_RP_ID)
    }

    #[test]
    fn encoding_matches_the_typescript_encoder() {
        let json = golden_client_data();
        let auth = hex(AUTH);
        for der in [DER, HIGH_DER] {
            let der = hex(der);
            let encoded = encode_assertion(&WebAuthnAssertion { authenticator_data: &auth, client_data_json: &json, signature_der: &der }).unwrap();
            assert_eq!(encoded, hex(ENC), "high-s must be normalised to the same bytes");
        }
    }

    #[test]
    fn golden_vector_passes_the_local_validator_check() {
        let enc = hex(ENC);
        assert!(verify_like_validator(&[0x11; 32], &enc, &h32(QX), &h32(QY)));
        assert!(!verify_like_validator(&[0x12; 32], &enc, &h32(QX), &h32(QY)));
        let calldata = validate_signature_calldata(&[0x11; 32], &enc, &encode_public_key(&h32(QX), &h32(QY)));
        assert_eq!(&calldata[..4], &hex(CALLDATA_PREFIX)[..]);
    }

    fn sign(flags: u8, hash: &[u8; 32], high_s: bool) -> (Vec<u8>, [u8; 32], [u8; 32]) {
        let key = SigningKey::from_bytes(&[0x24u8; 32].into()).unwrap();
        let point = key.verifying_key().to_encoded_point(false);
        let mut auth = Sha256::digest(DESKTOP_WALLET_RP_ID.as_bytes()).to_vec();
        auth.push(flags);
        auth.extend_from_slice(&[0, 0, 0, 7]);
        let json = client_data_json_for_get(hash, DESKTOP_WALLET_RP_ID);
        let mut signed = auth.clone();
        signed.extend_from_slice(&Sha256::digest(json.as_bytes()));
        let sig: Signature = key.sign_prehash(&Sha256::digest(&signed)).unwrap();
        let sig = match (high_s, sig.normalize_s()) {
            (true, Some(_)) | (false, None) => sig,
            (true, None) => Signature::from_scalars(sig.r(), -*sig.s()).unwrap(),
            (false, Some(low)) => low,
        };
        let der = sig.to_der();
        let encoded = encode_assertion(&WebAuthnAssertion { authenticator_data: &auth, client_data_json: &json, signature_der: der.as_bytes() }).unwrap();
        (encoded, point.x().unwrap().as_slice().try_into().unwrap(), point.y().unwrap().as_slice().try_into().unwrap())
    }

    #[test]
    fn flags_and_challenge_are_checked_like_the_validator() {
        let hash = [0xab; 32];
        let (ok, qx, qy) = sign(FLAG_UP | FLAG_UV, &hash, false);
        assert!(verify_like_validator(&hash, &ok, &qx, &qy));
        let (synced, qx, qy) = sign(FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS, &hash, false);
        assert!(verify_like_validator(&hash, &synced, &qx, &qy), "phone passkeys are backed up (BE|BS)");
        let (high, qx, qy) = sign(FLAG_UP | FLAG_UV, &hash, true);
        assert!(verify_like_validator(&hash, &high, &qx, &qy), "encoder lowers s");
        let (no_uv, qx, qy) = sign(FLAG_UP, &hash, false);
        assert!(!verify_like_validator(&hash, &no_uv, &qx, &qy));
        let (bs_only, qx, qy) = sign(FLAG_UP | FLAG_UV | FLAG_BS, &hash, false);
        assert!(!verify_like_validator(&hash, &bs_only, &qx, &qy));
        assert!(!verify_like_validator(&[0xac; 32], &ok, &qx, &qy));
        assert!(!verify_like_validator(&hash, &ok, &qy, &qx));
        let mut tampered = ok.clone();
        tampered[0xc0 + 32 + 33] ^= 1; // 署名カウンタの1バイト
        assert!(!verify_like_validator(&hash, &tampered, &qx, &qy));
        assert!(!verify_like_validator(&hash, &ok[..0xbf], &qx, &qy));
    }

    #[test]
    fn rejects_malformed_der_and_client_data() {
        let auth = hex(AUTH);
        let json = golden_client_data();
        let mut der = hex(DER);
        der[1] ^= 1;
        assert_eq!(
            encode_assertion(&WebAuthnAssertion { authenticator_data: &auth, client_data_json: &json, signature_der: &der }).unwrap_err(),
            WebAuthnEncodingError::InvalidDerSignature
        );
        let create_json = client_data_json_for_create(&[0x11; 32], DESKTOP_WALLET_RP_ID);
        assert_eq!(
            encode_assertion(&WebAuthnAssertion { authenticator_data: &auth, client_data_json: &create_json, signature_der: &hex(DER) }).unwrap_err(),
            WebAuthnEncodingError::InvalidClientDataJson
        );
    }

    fn attested(rp_id: &str, alg: u8) -> Vec<u8> {
        let (qx, qy) = (h32(QX), h32(QY));
        let mut out = Sha256::digest(rp_id.as_bytes()).to_vec();
        out.push(FLAG_UP | FLAG_UV | FLAG_AT);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&[0u8; 16]);
        out.extend_from_slice(&[0, 3, 9, 8, 7]);
        // {1: 2, 3: -7, -1: 1, -2: x, -3: y}
        out.extend_from_slice(&[0xa5, 0x01, 0x02, 0x03, alg, 0x20, 0x01, 0x21, 0x58, 0x20]);
        out.extend_from_slice(&qx);
        out.extend_from_slice(&[0x22, 0x58, 0x20]);
        out.extend_from_slice(&qy);
        out
    }

    #[test]
    fn parses_the_attested_cose_key() {
        let (id, qx, qy) = parse_attested_p256_key(&attested(DESKTOP_WALLET_RP_ID, 0x26), DESKTOP_WALLET_RP_ID).unwrap();
        assert_eq!((id, qx, qy), (vec![9, 8, 7], h32(QX), h32(QY)));
        assert_eq!(
            parse_attested_p256_key(&attested("hub.jkamma.com", 0x26), DESKTOP_WALLET_RP_ID).unwrap_err(),
            WebAuthnEncodingError::InvalidAuthenticatorData
        );
        // alg -8 (EdDSA) は受けない
        assert_eq!(
            parse_attested_p256_key(&attested(DESKTOP_WALLET_RP_ID, 0x27), DESKTOP_WALLET_RP_ID).unwrap_err(),
            WebAuthnEncodingError::InvalidCoseKey
        );
    }
}
