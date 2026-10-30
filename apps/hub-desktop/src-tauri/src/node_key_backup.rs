//! Password-protected copy of the Personal Node keys (INVENTORY.md decision 6, 2026-10-18).
//!
//! Both node keys sit encrypted under one key in the credential store
//! (`checkpoint-key-v1`); losing that key loses the node identity. This file lets
//! the owner keep a copy elsewhere. The key is derived from the password with
//! PBKDF2-HMAC-SHA256 (the `hmac` and `sha2` crates this app already uses) and the
//! keys are sealed with AES-256-GCM, as the local checkpoint records are.
//! Anyone with the file and the password can act as this node. Keys and the
//! password are never logged or returned to the window.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const FORMAT: &str = "jkamma-hub-node-key-backup";
const VERSION: u8 = 1;
const KDF: &str = "pbkdf2-hmac-sha256";
const CIPHER: &str = "aes-256-gcm";
/// OWASP's 2023 floor for PBKDF2-HMAC-SHA256.
pub(crate) const ITERATIONS: u32 = 600_000;
const MAX_ITERATIONS: u32 = 10_000_000;
const MIN_PASSWORD_CHARS: usize = 12;
const MAX_PASSWORD_BYTES: usize = 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupFile {
    format: String,
    version: u8,
    kdf: KdfParams,
    cipher: CipherParams,
    ciphertext: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KdfParams {
    name: String,
    iterations: u32,
    salt: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CipherParams {
    name: String,
    nonce: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sealed {
    identity_pkcs8_pem: String,
    encryption_pkcs8_pem: String,
}

/// PBKDF2 (RFC 8018) with HMAC-SHA256, one 32-byte block.
pub(crate) fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let prf = <Hmac<Sha256> as Mac>::new_from_slice(password).expect("HMAC takes any key length");
    let mut first = prf.clone();
    first.update(salt);
    first.update(&1u32.to_be_bytes());
    let mut u: [u8; 32] = first.finalize().into_bytes().into();
    let mut out = u;
    for _ in 1..iterations {
        let mut next = prf.clone();
        next.update(&u);
        u = next.finalize().into_bytes().into();
        for (byte, value) in out.iter_mut().zip(u.iter()) { *byte ^= value; }
    }
    out
}

fn check_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_CHARS { return Err("backup_password_too_short".into()); }
    if password.len() > MAX_PASSWORD_BYTES { return Err("backup_password_too_long".into()); }
    Ok(())
}

/// Binds every parameter to the ciphertext, so none can be changed unnoticed.
fn associated_data(iterations: u32, salt: &str) -> Vec<u8> {
    format!("{FORMAT}/{VERSION}/{KDF}/{iterations}/{salt}/{CIPHER}").into_bytes()
}

pub(crate) fn seal(identity: &str, encryption: &str, password: &str, iterations: u32) -> Result<Vec<u8>, String> {
    check_password(password)?;
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let salt_text = STANDARD.encode(salt);
    let key = pbkdf2_sha256(password.as_bytes(), &salt, iterations);
    let plaintext = serde_json::to_vec(&Sealed { identity_pkcs8_pem: identity.into(), encryption_pkcs8_pem: encryption.into() })
        .map_err(|_| "backup_encode_failed")?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "backup_encrypt_failed")?;
    let aad = associated_data(iterations, &salt_text);
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: &plaintext, aad: &aad })
        .map_err(|_| "backup_encrypt_failed")?;
    let file = BackupFile {
        format: FORMAT.into(),
        version: VERSION,
        kdf: KdfParams { name: KDF.into(), iterations, salt: salt_text },
        cipher: CipherParams { name: CIPHER.into(), nonce: STANDARD.encode(nonce) },
        ciphertext: STANDARD.encode(ciphertext),
    };
    serde_json::to_vec_pretty(&file).map_err(|_| "backup_encode_failed".into())
}

/// Returns (identity PEM, encryption PEM). A wrong password and a damaged file
/// give the same answer.
pub(crate) fn open(bytes: &[u8], password: &str, min_iterations: u32) -> Result<(String, String), String> {
    if password.is_empty() || password.len() > MAX_PASSWORD_BYTES { return Err("backup_password_wrong".into()); }
    let file: BackupFile = serde_json::from_slice(bytes).map_err(|_| "backup_file_invalid")?;
    if file.format != FORMAT || file.version != VERSION || file.kdf.name != KDF || file.cipher.name != CIPHER
        || !(min_iterations..=MAX_ITERATIONS).contains(&file.kdf.iterations) {
        return Err("backup_file_invalid".into());
    }
    let salt = STANDARD.decode(&file.kdf.salt).map_err(|_| "backup_file_invalid")?;
    let nonce = STANDARD.decode(&file.cipher.nonce).map_err(|_| "backup_file_invalid")?;
    let ciphertext = STANDARD.decode(&file.ciphertext).map_err(|_| "backup_file_invalid")?;
    if salt.len() != 16 || nonce.len() != 12 { return Err("backup_file_invalid".into()); }
    let key = pbkdf2_sha256(password.as_bytes(), &salt, file.kdf.iterations);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "backup_file_invalid")?;
    let aad = associated_data(file.kdf.iterations, &file.kdf.salt);
    let plaintext = cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: &ciphertext, aad: &aad })
        .map_err(|_| "backup_password_wrong")?;
    let sealed: Sealed = serde_json::from_slice(&plaintext).map_err(|_| "backup_file_invalid")?;
    Ok((sealed.identity_pkcs8_pem, sealed.encryption_pkcs8_pem))
}

fn main_window(window: &tauri::Webview) -> Result<(), String> {
    if window.label() != "main" { return Err("native_window_required".into()); }
    crate::native_pi(window)
}

/// Write the node keys into a password-protected file the owner picks.
#[tauri::command]
pub async fn node_key_backup_export(window: tauri::Webview, app: tauri::AppHandle, password: String) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    main_window(&window)?;
    check_password(&password)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file()
        .set_file_name("hub-node-keys.jkkey")
        .add_filter("Node の鍵の控え", &["jkkey"])
        .save_file(move |chosen| { let _ = tx.send(chosen); });
    let Some(chosen) = rx.await.map_err(|_| "backup_path_unavailable")? else {
        return Ok(serde_json::json!({ "saved": false }));
    };
    let path = chosen.as_path().map(std::path::Path::to_path_buf).ok_or("backup_path_unavailable")?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let (identity, encryption) = crate::personal_node::read_key_pems()?;
        let bytes = seal(&identity, &encryption, &password, ITERATIONS)?;
        std::fs::write(&path, bytes).map_err(|_| "backup_write_failed".to_owned())
    }).await.map_err(|_| "backup_write_failed")??;
    Ok(serde_json::json!({ "saved": true }))
}

/// Read a backup file and replace the node keys. They take effect at the next start.
#[tauri::command]
pub async fn node_key_backup_import(window: tauri::Webview, app: tauri::AppHandle, password: String) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    main_window(&window)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file()
        .add_filter("Node の鍵の控え", &["jkkey"])
        .pick_file(move |chosen| { let _ = tx.send(chosen); });
    let Some(chosen) = rx.await.map_err(|_| "backup_path_unavailable")? else {
        return Ok(serde_json::json!({ "imported": false }));
    };
    let path = chosen.as_path().map(std::path::Path::to_path_buf).ok_or("backup_path_unavailable")?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if std::fs::metadata(&path).map_err(|_| "backup_file_unavailable")?.len() > MAX_FILE_BYTES {
            return Err("backup_file_invalid".into());
        }
        let bytes = std::fs::read(&path).map_err(|_| "backup_file_unavailable")?;
        let (identity, encryption) = open(&bytes, &password, ITERATIONS)?;
        crate::personal_node::replace_key_pems(&identity, &encryption)
    }).await.map_err(|_| "backup_import_failed")??;
    Ok(serde_json::json!({ "imported": true, "restartRequired": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }

    #[test]
    fn pbkdf2_matches_published_vectors() {
        assert_eq!(hex(&pbkdf2_sha256(b"password", b"salt", 1)), "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
        assert_eq!(hex(&pbkdf2_sha256(b"password", b"salt", 2)), "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43");
        assert_eq!(hex(&pbkdf2_sha256(b"password", b"salt", 4096)), "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
    }

    #[test]
    fn sealed_backup_opens_only_with_its_password_and_hides_the_keys() {
        let identity = crate::node_identity::NodeKey::create().to_pkcs8_pem().unwrap();
        let encryption = crate::content_e2ee::NodeEncryptionKey::create().to_pkcs8_pem().unwrap();
        let bytes = seal(&identity, &encryption, "correct horse battery", 1000).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(!text.contains("PRIVATE KEY") && !text.contains(&identity[40..80]));
        assert_eq!(open(&bytes, "correct horse battery", 1000).unwrap(), (identity, encryption));
        assert_eq!(open(&bytes, "correct horse batterx", 1000).unwrap_err(), "backup_password_wrong");
        // A file with fewer rounds than required is refused before any work.
        assert_eq!(open(&bytes, "correct horse battery", 2000).unwrap_err(), "backup_file_invalid");
        // Lowering the stored rounds breaks the binding.
        let mut file: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        file["kdf"]["iterations"] = serde_json::json!(999);
        assert!(open(&serde_json::to_vec(&file).unwrap(), "correct horse battery", 1).is_err());
    }

    #[test]
    fn short_passwords_are_refused() {
        assert_eq!(seal("a", "b", "short", 1).unwrap_err(), "backup_password_too_short");
    }

    #[test]
    fn imported_keys_replace_the_stored_ones_and_keep_the_old_copy() {
        let identity = crate::node_identity::NodeKey::create().to_pkcs8_pem().unwrap();
        let encryption = crate::content_e2ee::NodeEncryptionKey::create().to_pkcs8_pem().unwrap();
        crate::personal_node::replace_key_pems(&identity, &encryption).unwrap();
        assert_eq!(crate::personal_node::read_key_pems().unwrap(), (identity.clone(), encryption.clone()));
        let other = crate::node_identity::NodeKey::create().to_pkcs8_pem().unwrap();
        crate::personal_node::replace_key_pems(&other, &encryption).unwrap();
        assert_eq!(crate::personal_node::read_key_pems().unwrap().0, other);
        let aside = crate::checkpoint::folder_path("node-identity").unwrap().join("unreadable");
        assert!(std::fs::read_dir(aside).unwrap().count() >= 1);
        assert!(crate::personal_node::replace_key_pems("not a key", &encryption).is_err());
    }
}
