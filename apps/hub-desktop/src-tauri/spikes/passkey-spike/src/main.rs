//! 第0段の試作: Windows の WebAuthn API（webauthn.dll）でパスキーを作り、署名し、
//! その署名がスマートウォレットの検証器の形で通るかを確かめる。
//!
//! テスト網の読み出し（eth_call）だけを行う。送金も配備もしない。資産のある鍵には触れない。
//! 作るパスキーは試作専用で、どの口座の鍵にもならない。
//!
//! 使い方（apps/hub-desktop/src-tauri/spikes/passkey-spike で）:
//!   cargo run -- run            Windows Hello で作って署名する（2回確認が出る）
//!   cargo run -- run --phone    スマートフォン（QR のハイブリッド）で作って署名する
//!   cargo run -- sign [--phone] 前回作ったパスキーでもう一度署名する
//!   cargo run -- info           API の版と Windows Hello の有無だけを見る
//!   cargo run -- delete         前回 Windows Hello に作った試作のパスキーを消す
//!   cargo run -- kairos-selftest  合成の鍵で作った署名を Kairos の検証器へ eth_call する
//!   オプション --rp-id <id>     rpId を差し替える（既定 desktop-wallet.hub.jkamma.com）

#[path = "../../../src/webauthn_p256.rs"]
#[allow(dead_code)]
mod webauthn_p256;

use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use webauthn_p256::*;

const KAIROS_RPC: &str = "https://public-en-kairos.node.kaia.io";
/// deployments/kairos/HubSignatureAgileAccountFactory.json の validator。
const KAIROS_VALIDATOR: &str = "0x1D981460D0244dB3fff3Fcb56d6b2437Bd38D81D";

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::from("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn from_hex32(s: &str) -> Option<[u8; 32]> {
    let s = s.strip_prefix("0x")?;
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn flags_text(flags: u8) -> String {
    let names = [(0x01, "UP"), (0x04, "UV"), (0x08, "BE"), (0x10, "BS"), (0x40, "AT"), (0x80, "ED")];
    let set: Vec<&str> = names.iter().filter(|(bit, _)| flags & bit != 0).map(|(_, n)| *n).collect();
    format!("0x{flags:02x} [{}]", set.join(" "))
}

/// Kairos の検証器へ読み出しだけを送る。curl.exe（Windows 10 以降に同梱）を使う。
fn kairos_validate(hash: &[u8; 32], signature: &[u8], qx: &[u8; 32], qy: &[u8; 32]) -> String {
    let data = validate_signature_calldata(hash, signature, &encode_public_key(qx, qy));
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{ "to": KAIROS_VALIDATOR, "data": to_hex(&data) }, "latest"]
    })
    .to_string();
    let child = Command::new("curl")
        .args(["-s", "--max-time", "20", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", KAIROS_RPC])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn();
    let Ok(mut child) = child else { return "unavailable (curl not found)".into() };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(body.as_bytes());
    }
    let Ok(output) = child.wait_with_output() else { return "unavailable".into() };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else { return "unavailable (no JSON)".into() };
    match value.get("result").and_then(|v| v.as_str()) {
        Some(r) if r.ends_with('1') && r.len() == 66 => "true".into(),
        Some(r) if r.len() == 66 => "false".into(),
        _ => format!("unavailable ({value})"),
    }
}

fn kairos_selftest() {
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    use p256::ecdsa::{Signature, SigningKey};
    use sha2::{Digest, Sha256};
    // 合成の試験用の鍵。どの口座の鍵でもない。
    let key = SigningKey::from_bytes(&[0x24u8; 32].into()).expect("test key");
    let point = key.verifying_key().to_encoded_point(false);
    let qx: [u8; 32] = point.x().unwrap().as_slice().try_into().unwrap();
    let qy: [u8; 32] = point.y().unwrap().as_slice().try_into().unwrap();
    let hash = [0x5a; 32];
    let mut auth = Sha256::digest(DESKTOP_WALLET_RP_ID.as_bytes()).to_vec();
    auth.extend_from_slice(&[0x05, 0, 0, 0, 1]);
    let json = client_data_json_for_get(&hash, DESKTOP_WALLET_RP_ID);
    let mut signed = auth.clone();
    signed.extend_from_slice(&Sha256::digest(json.as_bytes()));
    let sig: Signature = key.sign_prehash(&Sha256::digest(&signed)).expect("sign");
    let der = sig.to_der();
    let encoded = encode_assertion(&WebAuthnAssertion { authenticator_data: &auth, client_data_json: &json, signature_der: der.as_bytes() }).expect("encode");
    println!("local_validator={}", verify_like_validator(&hash, &encoded, &qx, &qy));
    println!("kairos_validator={}", kairos_validate(&hash, &encoded, &qx, &qy));
    let mut wrong = hash;
    wrong[0] ^= 1;
    println!("kairos_validator_wrong_hash={} (expected false)", kairos_validate(&wrong, &encoded, &qx, &qy));
}

struct Options {
    phone: bool,
    rp_id: String,
}

fn credential_file(phone: bool) -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("JKammaHubPasskeySpike").join(if phone { "credential-phone.json" } else { "credential-platform.json" })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("run");
    let mut options = Options { phone: false, rp_id: DESKTOP_WALLET_RP_ID.to_string() };
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--phone" => options.phone = true,
            "--rp-id" if i + 1 < args.len() => {
                i += 1;
                options.rp_id = args[i].clone();
            }
            other => {
                eprintln!("unknown option: {other}");
                std::process::exit(2);
            }
        }
        i += 1;
    }
    if command == "kairos-selftest" {
        kairos_selftest();
        return;
    }
    #[cfg(windows)]
    {
        let code = windows_hello::dispatch(command, &options);
        std::process::exit(code);
    }
    #[cfg(not(windows))]
    {
        let _ = options;
        eprintln!("this spike calls webauthn.dll and runs on Windows only");
        std::process::exit(2);
    }
}

#[cfg(windows)]
mod windows_hello {
    use super::*;
    use rand::RngCore;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Networking::WindowsWebServices::*;
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    use windows_core::PCWSTR;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn describe(error: &windows_core::Error) -> String {
        let name = unsafe { WebAuthNGetErrorName(error.code()).to_string() }.unwrap_or_default();
        format!("{:#010x} {name} {}", error.code().0 as u32, error.message())
    }

    fn transport_text(t: u32) -> String {
        let names = [(WEBAUTHN_CTAP_TRANSPORT_USB, "usb"), (WEBAUTHN_CTAP_TRANSPORT_NFC, "nfc"), (WEBAUTHN_CTAP_TRANSPORT_BLE, "ble"), (WEBAUTHN_CTAP_TRANSPORT_INTERNAL, "internal"), (WEBAUTHN_CTAP_TRANSPORT_HYBRID, "hybrid")];
        let set: Vec<&str> = names.iter().filter(|(bit, _)| t & bit != 0).map(|(_, n)| *n).collect();
        if set.is_empty() { format!("unknown({t:#x})") } else { set.join("|") }
    }

    fn window() -> HWND {
        unsafe { GetForegroundWindow() }
    }

    fn random32() -> [u8; 32] {
        let mut out = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut out);
        out
    }

    fn info() {
        let version = unsafe { WebAuthNGetApiVersionNumber() };
        let uvpaa = unsafe { WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable() }.map(|b| b.as_bool());
        println!("api_version={version}");
        println!("windows_hello_available={uvpaa:?}");
    }

    struct Created {
        id: Vec<u8>,
        qx: [u8; 32],
        qy: [u8; 32],
    }

    fn create(options: &Options) -> Result<Created, String> {
        let rp_id = wide(&options.rp_id);
        let rp_name = wide("JKamma Hub Wallet (Phase 0 spike)");
        let user_name = wide("hub-wallet-spike");
        let user_display = wide("Hub Wallet spike (test only)");
        let mut user_id = random32();
        let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
            pwszId: PCWSTR(rp_id.as_ptr()),
            pwszName: PCWSTR(rp_name.as_ptr()),
            pwszIcon: PCWSTR::null(),
        };
        let user = WEBAUTHN_USER_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
            cbId: 32,
            pbId: user_id.as_mut_ptr(),
            pwszName: PCWSTR(user_name.as_ptr()),
            pwszIcon: PCWSTR::null(),
            pwszDisplayName: PCWSTR(user_display.as_ptr()),
        };
        let mut param = WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
            dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
            pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
            lAlg: WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256,
        };
        let params = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS { cCredentialParameters: 1, pCredentialParameters: &mut param };
        let mut json = client_data_json_for_create(&random32(), &options.rp_id).into_bytes();
        let client = WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: json.len() as u32,
            pbClientDataJSON: json.as_mut_ptr(),
            pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
        };
        // 版3は API 版1からある。足りない欄は使わない。
        let mut opts = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS::default();
        opts.dwVersion = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_VERSION_3;
        opts.dwTimeoutMilliseconds = 120_000;
        opts.dwAuthenticatorAttachment = if options.phone { WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM } else { WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM };
        opts.bRequireResidentKey = true.into();
        opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
        opts.dwAttestationConveyancePreference = WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE;
        let attestation = unsafe { WebAuthNAuthenticatorMakeCredential(window(), &rp, &user, &params, &client, Some(&opts)) }
            .map_err(|e| describe(&e))?;
        let result = unsafe {
            let a = &*attestation;
            let auth = std::slice::from_raw_parts(a.pbAuthenticatorData, a.cbAuthenticatorData as usize).to_vec();
            let id = std::slice::from_raw_parts(a.pbCredentialId, a.cbCredentialId as usize).to_vec();
            let format = a.pwszFormatType.to_string().unwrap_or_default();
            let transport = if a.dwVersion >= 3 { transport_text(a.dwUsedTransport) } else { "not reported".into() };
            (auth, id, format, transport, a.dwVersion)
        };
        unsafe { WebAuthNFreeCredentialAttestation(Some(attestation)) };
        let (auth, id, format, transport, version) = result;
        println!("create=ok attestation_version={version} format={format} transport={transport} flags={}", flags_text(*auth.get(32).unwrap_or(&0)));
        let (parsed_id, qx, qy) = parse_attested_p256_key(&auth, &options.rp_id).map_err(|e| format!("attested key: {e:?}"))?;
        if parsed_id != id {
            return Err("credential id in authenticatorData differs from the returned id".into());
        }
        println!("credential_id={}", base64url(&id));
        println!("qx={}\nqy={}", to_hex(&qx), to_hex(&qy));
        Ok(Created { id, qx, qy })
    }

    fn sign(options: &Options, created: &Created) -> Result<(), String> {
        let rp_id = wide(&options.rp_id);
        // 実際の口座では UserOperation のハッシュが入る。試作では乱数で代える。
        let hash = random32();
        let json = client_data_json_for_get(&hash, &options.rp_id);
        let mut json_bytes = json.clone().into_bytes();
        let client = WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: json_bytes.len() as u32,
            pbClientDataJSON: json_bytes.as_mut_ptr(),
            pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
        };
        let mut id = created.id.clone();
        let mut credential = WEBAUTHN_CREDENTIAL_EX {
            dwVersion: WEBAUTHN_CREDENTIAL_EX_CURRENT_VERSION,
            cbId: id.len() as u32,
            pbId: id.as_mut_ptr(),
            pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
            dwTransports: if options.phone { WEBAUTHN_CTAP_TRANSPORT_HYBRID } else { WEBAUTHN_CTAP_TRANSPORT_INTERNAL },
        };
        let mut pointers = [&mut credential as *mut WEBAUTHN_CREDENTIAL_EX];
        let mut allow = WEBAUTHN_CREDENTIAL_LIST { cCredentials: 1, ppCredentials: pointers.as_mut_ptr() };
        // 版4（pAllowCredentialList）は API 版1からある。
        let mut opts = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS::default();
        opts.dwVersion = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_VERSION_4;
        opts.dwTimeoutMilliseconds = 120_000;
        opts.dwAuthenticatorAttachment = if options.phone { WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM } else { WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM };
        opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
        opts.pAllowCredentialList = &mut allow;
        let assertion = unsafe { WebAuthNAuthenticatorGetAssertion(window(), PCWSTR(rp_id.as_ptr()), &client, Some(&opts)) }
            .map_err(|e| describe(&e))?;
        let (auth, signature, used_id, transport, version) = unsafe {
            let a = &*assertion;
            let auth = std::slice::from_raw_parts(a.pbAuthenticatorData, a.cbAuthenticatorData as usize).to_vec();
            let sig = std::slice::from_raw_parts(a.pbSignature, a.cbSignature as usize).to_vec();
            let used = std::slice::from_raw_parts(a.Credential.pbId, a.Credential.cbId as usize).to_vec();
            let transport = if a.dwVersion >= 4 { transport_text(a.dwUsedTransport) } else { "not reported".into() };
            (auth, sig, used, transport, a.dwVersion)
        };
        unsafe { WebAuthNFreeAssertion(assertion) };
        println!("sign=ok assertion_version={version} transport={transport} flags={}", flags_text(*auth.get(32).unwrap_or(&0)));
        if used_id != created.id {
            return Err("the authenticator signed with a different credential".into());
        }
        let encoded = encode_assertion(&WebAuthnAssertion { authenticator_data: &auth, client_data_json: &json, signature_der: &signature })
            .map_err(|e| format!("encode: {e:?}"))?;
        println!("encoded_signature_bytes={}", encoded.len());
        println!("local_validator={}", verify_like_validator(&hash, &encoded, &created.qx, &created.qy));
        println!("kairos_validator={}", kairos_validate(&hash, &encoded, &created.qx, &created.qy));
        Ok(())
    }

    fn save(options: &Options, created: &Created) {
        let path = credential_file(options.phone);
        let body = serde_json::json!({
            "rpId": options.rp_id, "credentialId": base64url(&created.id),
            "qx": to_hex(&created.qx), "qy": to_hex(&created.qy), "phone": options.phone,
        });
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match std::fs::write(&path, serde_json::to_vec_pretty(&body).unwrap()) {
            Ok(()) => println!("saved_public_info={}", path.display()),
            Err(e) => println!("saved_public_info=failed ({e})"),
        }
    }

    fn load(options: &Options) -> Result<Created, String> {
        use base64::Engine as _;
        let path = credential_file(options.phone);
        let raw = std::fs::read(&path).map_err(|e| format!("{}: {e} (run `run` first)", path.display()))?;
        let v: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        if v["rpId"].as_str() != Some(options.rp_id.as_str()) {
            return Err(format!("saved credential is for rpId {}", v["rpId"]));
        }
        let id = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(v["credentialId"].as_str().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let qx = v["qx"].as_str().and_then(from_hex32).ok_or("bad qx")?;
        let qy = v["qy"].as_str().and_then(from_hex32).ok_or("bad qy")?;
        Ok(Created { id, qx, qy })
    }

    pub fn dispatch(command: &str, options: &Options) -> i32 {
        println!("rp_id={} mode={}", options.rp_id, if options.phone { "phone (cross-device)" } else { "platform (Windows Hello)" });
        info();
        let outcome = match command {
            "info" => Ok(()),
            "run" => {
                println!("step 1/2: create a test passkey (a Windows prompt opens)");
                create(options).and_then(|created| {
                    save(options, &created);
                    println!("step 2/2: sign a random 32-byte hash with it (a second prompt opens)");
                    sign(options, &created)
                })
            }
            "sign" => load(options).and_then(|created| sign(options, &created)),
            "delete" => load(options).and_then(|created| {
                if options.phone {
                    return Err("a phone passkey is deleted on the phone".into());
                }
                unsafe { WebAuthNDeletePlatformCredential(&created.id) }.map_err(|e| describe(&e))?;
                let _ = std::fs::remove_file(credential_file(false));
                println!("delete=ok");
                Ok(())
            }),
            other => Err(format!("unknown command: {other}")),
        };
        match outcome {
            Ok(()) => 0,
            Err(message) => {
                println!("error={message}");
                1
            }
        }
    }
}
