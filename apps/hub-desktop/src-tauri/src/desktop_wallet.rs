//! Desktop EVM wallet. A secp256k1 key generated on this machine and kept in
//! the OS keyring — Hub never sees the private half, so the wallet stays
//! non-custodial. This is a separate entry from the agent session key: the
//! wallet signs user-approved money movement, the session key signs machine
//! grants, and mixing the two would blur both boundaries.
//!
//! The bundled main window (native wallet / tip / link actions) reaches this
//! core through the wallet_* commands in lib.rs. Web版Hubはアプリ内ブラウザで
//! 開けないので、ページ向けのウォレットブリッジは持たない——署名・送金は
//! すべてネイティブ面からの明示操作だけ。
//!
//! Every operation that signs or sends waits for an explicit approve/deny in
//! the main window.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use k256::ecdsa::SigningKey;
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};
use tauri::{AppHandle, Emitter};

const SERVICE: &str = "jkamma-hub";
const KEY_ENTRY: &str = "evm-wallet-key";
const CONFIRM_TTL: Duration = Duration::from_secs(120);
const MAX_CONFIRM_SUMMARY_BYTES: usize = 8192;
const MAX_CONFIRM_DETAIL_BYTES: usize = 131072;
const MAX_CALLDATA_BYTES: usize = 32768;

/// 対応チェーン。Hub側の wallet-balance-verification.ts と同じ表——
/// 公開RPCを既定にして `HUB_WALLET_RPC_<chainId>` で上書きできる。
/// 本番網（mainnet）が既定の選択肢。テスト網は開発者設定がオンのときだけ選べる。
struct ChainInfo {
    id: u64,
    name: &'static str,
    symbol: &'static str,
    mainnet: bool,
    rpc: &'static str,
    /// 予備のRPC。読み取りだけが使い、送金は検証済みの1本に固定する。
    fallback_rpc: Option<&'static str>,
}

const DEFAULT_CHAIN: u64 = 43_114;

const CHAINS: &[ChainInfo] = &[
    ChainInfo { id: 43_114, name: "Avalanche C-Chain", symbol: "AVAX", mainnet: true, rpc: "https://api.avax.network/ext/bc/C/rpc", fallback_rpc: Some("https://avalanche.drpc.org") },
    ChainInfo { id: 137, name: "Polygon", symbol: "POL", mainnet: true, rpc: "https://polygon.drpc.org", fallback_rpc: None },
    ChainInfo { id: 1, name: "Ethereum", symbol: "ETH", mainnet: true, rpc: "https://ethereum.reth.rs/rpc", fallback_rpc: None },
    ChainInfo { id: 8_453, name: "Base", symbol: "ETH", mainnet: true, rpc: "https://mainnet.base.org", fallback_rpc: None },
    ChainInfo { id: 42_161, name: "Arbitrum One", symbol: "ETH", mainnet: true, rpc: "https://arb1.arbitrum.io/rpc", fallback_rpc: None },
    ChainInfo { id: 10, name: "OP Mainnet", symbol: "ETH", mainnet: true, rpc: "https://mainnet.optimism.io", fallback_rpc: None },
    ChainInfo { id: 43_113, name: "Avalanche Fuji", symbol: "AVAX", mainnet: false, rpc: "https://api.avax-test.network/ext/bc/C/rpc", fallback_rpc: None },
    ChainInfo { id: 1_001, name: "Kaia Kairos", symbol: "KAIA", mainnet: false, rpc: "https://public-en-kairos.node.kaia.io", fallback_rpc: None },
    // rpc-amoy.polygon.technology は廃止されDNSが引けない（2026-10-15確認）。Hubサーバー側の
    // wallet-balance-verification.ts と同じ publicnode を既定にする。
    ChainInfo { id: 80_002, name: "Polygon Amoy", symbol: "POL", mainnet: false, rpc: "https://polygon-amoy-bor-rpc.publicnode.com", fallback_rpc: None },
    ChainInfo { id: 84_532, name: "Base Sepolia", symbol: "ETH", mainnet: false, rpc: "https://sepolia.base.org", fallback_rpc: None },
];

/// 残高を表示する既知トークン。アドレスは本番網でeth_callにより
/// symbol()=JPYC・decimals()=18 を確認したもの（2026-10-15）。
struct KnownToken { chain_id: u64, symbol: &'static str, address: &'static str, decimals: u32 }

const KNOWN_TOKENS: &[KnownToken] = &[
    KnownToken { chain_id: 43_114, symbol: "JPYC", address: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29", decimals: 18 },
    KnownToken { chain_id: 137, symbol: "JPYC", address: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29", decimals: 18 },
    KnownToken { chain_id: 1, symbol: "JPYC", address: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29", decimals: 18 },
];

/// 端末ごとのウォレット設定。選択中のネットワークと、テスト網を出す開発者設定。
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WalletSettings {
    #[serde(rename = "chainId")]
    chain_id: u64,
    developer: bool,
}

impl WalletSettings {
    const DEFAULT: WalletSettings = WalletSettings { chain_id: DEFAULT_CHAIN, developer: false };

    /// 許可リストに無い・開発者設定が無いのにテスト網、は既定へ戻す。
    fn normalized(self) -> WalletSettings {
        match chain_info(self.chain_id) {
            Some(chain) if chain.mainnet || self.developer => self,
            _ => WalletSettings { chain_id: DEFAULT_CHAIN, developer: self.developer },
        }
    }

    fn parse(text: &str) -> WalletSettings {
        serde_json::from_str::<WalletSettings>(text).map(WalletSettings::normalized).unwrap_or(WalletSettings::DEFAULT)
    }

    /// 明示的なネットワーク切り替え。選べないチェーンは拒否する。
    fn select(self, chain_id: u64) -> Result<WalletSettings, String> {
        let chain = chain_info(chain_id).ok_or("wallet_chain_unsupported")?;
        if !chain.mainnet && !self.developer { return Err("wallet_chain_unsupported".into()); }
        Ok(WalletSettings { chain_id, developer: self.developer })
    }

    fn with_developer(self, developer: bool) -> WalletSettings {
        WalletSettings { chain_id: self.chain_id, developer }.normalized()
    }
}

fn chain_info(chain_id: u64) -> Option<&'static ChainInfo> {
    CHAINS.iter().find(|chain| chain.id == chain_id)
}

struct Pending {
    id: String,
    deadline: Instant,
    responder: Option<tokio::sync::oneshot::Sender<Decision>>,
}

#[derive(Debug, PartialEq)]
enum Decision { Approved, Denied, Expired }

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static CONFIRMED_OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SETTINGS: Mutex<Option<WalletSettings>> = Mutex::new(None);

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, KEY_ENTRY)
        .map_err(|_| "credential_store_unavailable".to_owned())
}

fn load_key() -> Result<Option<SigningKey>, String> {
    match keyring_entry()?.get_password() {
        Ok(secret) => SigningKey::from_slice(
            &hex_decode_fixed::<32>(&secret).ok_or("wallet_key_state_invalid")?,
        )
        .map(Some)
        .map_err(|_| "wallet_key_state_invalid".to_owned()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("credential_store_unavailable".to_owned()),
    }
}

fn require_key() -> Result<SigningKey, String> {
    if let Some(key) = load_key()? {
        return Ok(key);
    }
    let key = SigningKey::random(&mut rand::rngs::OsRng);
    keyring_entry()?
        .set_password(&hex_encode(&key.to_bytes()))
        .map_err(|_| "credential_store_unavailable".to_owned())?;
    Ok(key)
}

/// 鍵を消す。リンクや履歴は残るが、この端末ではもう署名できない。
pub fn destroy_wallet() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("credential_store_unavailable".to_owned()),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2 + 2);
    out.push_str("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex_decode(input: &str) -> Option<Vec<u8>> {
    let body = input.strip_prefix("0x").unwrap_or(input);
    if body.len() % 2 != 0 || !body.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(
        (0..body.len() / 2)
            .map(|i| u8::from_str_radix(&body[i * 2..i * 2 + 2], 16).unwrap())
            .collect(),
    )
}

fn hex_decode_fixed<const N: usize>(input: &str) -> Option<[u8; N]> {
    hex_decode(input)?.try_into().ok()
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().into()
}

fn address_of(key: &SigningKey) -> String {
    let public = key.verifying_key().to_encoded_point(false);
    let digest = keccak256(&public.as_bytes()[1..]);
    format!("0x{}", &hex_encode(&digest[12..])[2..])
}

/// この端末のウォレットアドレス。未作成なら鍵を生成する——アドレスを見る
/// だけで鍵ができるのはモバイル版と同じ振る舞い。
pub fn wallet_address() -> Result<String, String> {
    Ok(address_of(&require_key()?))
}

// ----------------------------------------------------- ネットワーク選択

#[cfg(not(test))]
fn settings_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(std::path::PathBuf::from(base).join("jkamma-hub").join("wallet-settings.json"))
}

/// テストは実機の設定ファイルを読み書きしない。
#[cfg(test)]
fn settings_path() -> Option<std::path::PathBuf> { None }

fn load_settings_from(path: &std::path::Path) -> WalletSettings {
    std::fs::read_to_string(path).map(|text| WalletSettings::parse(&text)).unwrap_or(WalletSettings::DEFAULT)
}

fn save_settings_to(path: &std::path::Path, settings: &WalletSettings) -> Result<(), String> {
    let directory = path.parent().ok_or("wallet_settings_unavailable")?;
    std::fs::create_dir_all(directory).map_err(|_| "wallet_settings_unavailable".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    let text = serde_json::to_string(settings).map_err(|_| "wallet_settings_unavailable".to_owned())?;
    std::fs::write(&temporary, text).map_err(|_| "wallet_settings_unavailable".to_owned())?;
    std::fs::rename(&temporary, path).map_err(|_| "wallet_settings_unavailable".to_owned())
}

fn settings() -> WalletSettings {
    let mut slot = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    *slot.get_or_insert_with(|| settings_path().map(|path| load_settings_from(&path)).unwrap_or(WalletSettings::DEFAULT))
}

/// 設定を変える。保存に失敗したときはメモリも変えない。
fn update_settings(change: impl FnOnce(WalletSettings) -> Result<WalletSettings, String>) -> Result<WalletSettings, String> {
    let mut slot = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    let current = *slot.get_or_insert_with(|| settings_path().map(|path| load_settings_from(&path)).unwrap_or(WalletSettings::DEFAULT));
    let next = change(current)?;
    if next != current {
        if let Some(path) = settings_path() { save_settings_to(&path, &next)?; }
    }
    *slot = Some(next);
    Ok(next)
}

fn current_chain() -> u64 {
    settings().chain_id
}

fn chain_name(chain_id: u64) -> Option<&'static str> {
    chain_info(chain_id).map(|chain| chain.name)
}

/// 呼び出し側が示したチェーンが、選択中のチェーンと同じことを要求する。
/// 違うときは黙って切り替えず、UIが確認を取れるよう要求チェーンを返す。
fn require_chain_selected(selected: u64, requested: u64) -> Result<(), String> {
    chain_info(requested).ok_or("wallet_chain_unsupported")?;
    if selected == requested { Ok(()) } else { Err(format!("wallet_chain_switch_required:{requested}")) }
}

fn ensure_selected(chain_id: u64) -> Result<(), String> {
    require_chain_selected(current_chain(), chain_id)
}

/// 型付きデータの domain.chainId（あれば）。選択中のチェーンと違う署名は作らない。
fn typed_data_chain(typed_data: &Value) -> Result<Option<u64>, String> {
    let Some(raw) = typed_data.get("domain").and_then(|domain| domain.get("chainId")) else { return Ok(None); };
    let word = abi_uint(raw).map_err(|_| "typed_data_invalid".to_owned())?;
    if word[..24].iter().any(|byte| *byte != 0) { return Err("wallet_chain_unsupported".into()); }
    Ok(Some(u64::from_be_bytes(word[24..].try_into().expect("8 bytes"))))
}

fn ensure_typed_data_chain(typed_data: &Value) -> Result<(), String> {
    match typed_data_chain(typed_data)? {
        Some(chain_id) => ensure_selected(chain_id),
        None => Ok(()),
    }
}

/// 接続先の候補。環境変数で上書きしたときはその1本だけを使う。
fn chain_rpcs(chain_id: u64) -> Result<Vec<String>, String> {
    let chain = chain_info(chain_id).ok_or("wallet_chain_unsupported")?;
    if let Ok(value) = std::env::var(format!("HUB_WALLET_RPC_{chain_id}")) {
        if !value.trim().is_empty() {
            return Ok(vec![value.trim().to_owned()]);
        }
    }
    Ok(std::iter::once(chain.rpc).chain(chain.fallback_rpc).map(str::to_owned).collect())
}

fn chain_rpc(chain_id: u64) -> Result<String, String> {
    chain_rpcs(chain_id)?.into_iter().next().ok_or_else(|| "wallet_chain_unsupported".to_owned())
}

/// 候補のうち eth_chainId が一致した最初の1本。どれも一致しなければ失敗する。
async fn verified_endpoint(chain_id: u64) -> Result<String, String> {
    let mut last = "rpc_unreachable".to_owned();
    for endpoint in chain_rpcs(chain_id)? {
        match rpc_call_at(&endpoint, "eth_chainId", json!([])).await {
            Ok(value) if fee_quantity_u64(&value).ok() == Some(chain_id) => return Ok(endpoint),
            Ok(_) => last = "wallet_chain_mismatch".to_owned(),
            Err(error) => last = error,
        }
    }
    Err(last)
}

// ---------------------------------------------------------------- 署名

fn sign_digest(key: &SigningKey, digest: &[u8; 32]) -> String {
    let (signature, recovery) = key
        .sign_prehash_recoverable(digest)
        .expect("signing a digest cannot fail");
    let mut bytes = signature.to_bytes().to_vec();
    bytes.push(27 + recovery.is_y_odd() as u8);
    hex_encode(&bytes)
}

// ---------------------------------------------------------------- EIP-712

fn abi_word(bytes: &[u8]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[32 - bytes.len()..].copy_from_slice(bytes);
    word
}

/// 10進文字列を256bit符号なし整数へ。桁ごとの乗算加算で溢れは弾く。
fn dec_to_word(text: &str) -> Option<[u8; 32]> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut word = [0u8; 32];
    for digit in text.bytes() {
        let mut carry = (digit - b'0') as u16;
        for byte in word.iter_mut().rev() {
            let value = (*byte as u16) * 10 + carry;
            *byte = value as u8;
            carry = value >> 8;
        }
        if carry > 0 {
            return None;
        }
    }
    Some(word)
}

fn abi_uint(value: &Value) -> Result<[u8; 32], String> {
    let word = match value {
        Value::String(s) => {
            if let Some(hex) = s.strip_prefix("0x") {
                let raw = hex_decode(hex).ok_or("typed_data_invalid")?;
                if raw.len() > 32 {
                    return Err("typed_data_invalid".to_owned());
                }
                abi_word(&raw)
            } else {
                dec_to_word(s).ok_or("typed_data_invalid")?
            }
        }
        Value::Number(n) => abi_word(
            &n.as_u64()
                .ok_or("typed_data_invalid")?
                .to_be_bytes(),
        ),
        _ => return Err("typed_data_invalid".to_owned()),
    };
    Ok(word)
}

fn encode_atomic(
    type_name: &str,
    value: &Value,
    types: &Value,
    primary: &str,
) -> Result<Vec<u8>, String> {
    if let Some(inner) = type_name.strip_suffix("[]") {
        let items = value
            .as_array()
            .ok_or_else(|| "typed_data_invalid".to_owned())?;
        let mut concat = Vec::new();
        for item in items {
            concat.extend(encode_atomic(inner, item, types, primary)?);
        }
        return Ok(keccak256(&concat).to_vec());
    }
    if let Some(fields) = types.get(type_name) {
        return Ok(hash_struct(type_name, fields, value, types, primary)?.to_vec());
    }
    if type_name == "string" {
        return Ok(keccak256(
            value
                .as_str()
                .ok_or_else(|| "typed_data_invalid".to_owned())?
                .as_bytes(),
        )
        .to_vec());
    }
    if type_name == "bytes" {
        let raw = hex_decode(
            value
                .as_str()
                .ok_or_else(|| "typed_data_invalid".to_owned())?,
        )
        .ok_or_else(|| "typed_data_invalid".to_owned())?;
        return Ok(keccak256(&raw).to_vec());
    }
    if let Some(fixed) = type_name
        .strip_prefix("bytes")
        .filter(|n| !n.is_empty() && !n.starts_with(|c: char| c == 'x'))
    {
        let size: usize = fixed.parse().map_err(|_| "typed_data_invalid")?;
        if size == 0 || size > 32 {
            return Err("typed_data_invalid".to_owned());
        }
        let raw = hex_decode(
            value
                .as_str()
                .ok_or_else(|| "typed_data_invalid".to_owned())?,
        )
        .ok_or_else(|| "typed_data_invalid".to_owned())?;
        if raw.len() != size {
            return Err("typed_data_invalid".to_owned());
        }
        let mut word = [0u8; 32];
        word[..size].copy_from_slice(&raw);
        return Ok(word.to_vec());
    }
    if type_name == "address" {
        let raw = hex_decode_fixed::<20>(
            value
                .as_str()
                .ok_or_else(|| "typed_data_invalid".to_owned())?,
        )
        .ok_or_else(|| "typed_data_invalid".to_owned())?;
        return Ok(abi_word(&raw).to_vec());
    }
    if type_name == "bool" {
        let flag = value
            .as_bool()
            .ok_or_else(|| "typed_data_invalid".to_owned())?;
        return Ok(abi_word(&[flag as u8]).to_vec());
    }
    if type_name
        .strip_prefix("uint")
        .is_some_and(|bits| bits.is_empty() || bits.parse::<u16>().is_ok_and(|b| b >= 8 && b <= 256 && b % 8 == 0))
    {
        return Ok(abi_uint(value)?.to_vec());
    }
    if type_name
        .strip_prefix("int")
        .is_some_and(|bits| bits.is_empty() || bits.parse::<u16>().is_ok_and(|b| b >= 8 && b <= 256 && b % 8 == 0))
    {
        let parsed = match value {
            Value::String(s) => s.parse::<i128>().map_err(|_| "typed_data_invalid")?,
            Value::Number(n) => n.as_i64().map(|v| v as i128).ok_or_else(|| "typed_data_invalid".to_owned())?,
            _ => return Err("typed_data_invalid".to_owned()),
        };
        // 負数は0xffで符号拡張——abi_wordは左を0で埋めるのでそのまま使えない。
        let mut word = if parsed < 0 { [0xffu8; 32] } else { [0u8; 32] };
        word[16..].copy_from_slice(&parsed.to_be_bytes());
        return Ok(word.to_vec());
    }
    Err("typed_data_invalid".to_owned())
}

fn type_head(type_name: &str, types: &Value) -> Result<String, String> {
    let fields = types
        .get(type_name)
        .and_then(|f| f.as_array())
        .ok_or_else(|| "typed_data_invalid".to_owned())?;
    Ok(format!(
        "{}({})",
        type_name,
        fields
            .iter()
            .map(|f| format!("{} {}", f["type"].as_str().unwrap_or(""), f["name"].as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join(",")
    ))
}

/// encodeType: "Name(f1 t1,f2 t2)" に依存structの頭部を名前順で足す。
/// seen で自身とprimaryを除き、循環参照（A→B→A）でも止まる。
fn encode_type(type_name: &str, types: &Value, primary: &str) -> Result<String, String> {
    let head = type_head(type_name, types)?;
    let mut seen = std::collections::HashSet::from([
        type_name.to_owned(),
        primary.to_owned(),
    ]);
    let mut names = Vec::new();
    collect_type_refs(type_name, types, &mut seen, &mut names);
    names.sort();
    let deps = names
        .iter()
        .map(|name| type_head(name, types))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(format!("{}{}", head, deps.concat()))
}

fn collect_type_refs(
    type_name: &str,
    types: &Value,
    seen: &mut std::collections::HashSet<String>,
    out: &mut Vec<String>,
) {
    let Some(fields) = types.get(type_name).and_then(|f| f.as_array()) else {
        return;
    };
    for field in fields {
        let Some(t) = field.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        let base = t.strip_suffix("[]").unwrap_or(t);
        if types.get(base).is_some() && seen.insert(base.to_owned()) {
            out.push(base.to_owned());
            collect_type_refs(base, types, seen, out);
        }
    }
}

fn hash_struct(
    type_name: &str,
    fields: &Value,
    data: &Value,
    types: &Value,
    primary: &str,
) -> Result<[u8; 32], String> {
    let mut encoded = keccak256(encode_type(type_name, types, primary)?.as_bytes()).to_vec();
    for field in fields.as_array().ok_or_else(|| "typed_data_invalid".to_owned())? {
        let name = field
            .get("name")
            .and_then(|n| n.as_str())
            .ok_or_else(|| "typed_data_invalid".to_owned())?;
        let ftype = field
            .get("type")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "typed_data_invalid".to_owned())?;
        let value = data
            .get(name)
            .ok_or_else(|| "typed_data_invalid".to_owned())?;
        encoded.extend(encode_atomic(ftype, value, types, primary)?);
    }
    Ok(keccak256(&encoded))
}

/// EIP-712 ドメイン。存在するキーだけで EIP712Domain の型を組む。
fn domain_separator(typed: &Value) -> Result<[u8; 32], String> {
    let domain = typed
        .get("domain")
        .ok_or_else(|| "typed_data_invalid".to_owned())?;
    let mut fields = Vec::new();
    for (key, tname) in [
        ("name", "string"),
        ("version", "string"),
        ("chainId", "uint256"),
        ("verifyingContract", "address"),
        ("salt", "bytes32"),
    ] {
        if domain.get(key).is_some() {
            fields.push((key, tname));
        }
    }
    let type_decl = format!(
        "EIP712Domain({})",
        fields
            .iter()
            .map(|(k, t)| format!("{t} {k}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut encoded = keccak256(type_decl.as_bytes()).to_vec();
    for (key, tname) in &fields {
        let value = domain.get(*key).ok_or_else(|| "typed_data_invalid".to_owned())?;
        let empty = json!({});
        encoded.extend(encode_atomic(tname, value, &empty, "")?);
    }
    Ok(keccak256(&encoded))
}

/// EIP-712 typedData 全体を署名。types は challenge から来た宣言をそのまま
/// 使う——ハブ側が typedData の形を厳密に照合するので、ここで改変されると
/// 検証側が落とす。
pub fn sign_typed_data(typed_data: &Value) -> Result<String, String> {
    let digest = typed_data_digest(typed_data)?;
    Ok(sign_digest(&require_key()?, &digest))
}

fn typed_data_digest(typed_data: &Value) -> Result<[u8; 32], String> {
    let primary = typed_data
        .get("primaryType")
        .and_then(|p| p.as_str())
        .ok_or_else(|| "typed_data_invalid".to_owned())?;
    let types = typed_data
        .get("types")
        .ok_or_else(|| "typed_data_invalid".to_owned())?;
    let message = typed_data
        .get("message")
        .ok_or_else(|| "typed_data_invalid".to_owned())?;
    let fields = types
        .get(primary)
        .ok_or_else(|| "typed_data_invalid".to_owned())?;
    let mut digest_input = vec![0x19, 0x01];
    digest_input.extend(domain_separator(typed_data)?);
    digest_input.extend(hash_struct(primary, fields, message, types, primary)?);
    Ok(keccak256(&digest_input))
}

/// EIP-191 personal_sign。販売者登録のウォレット所有確認など、
/// サーバが発行したメッセージをそのまま署名する——ここで内容を
/// 書き換えると検証側が落とすので、文字列は一切触らない。
pub fn sign_message(message: &str) -> Result<String, String> {
    let body = message.as_bytes();
    if body.is_empty() || body.len() > 64 * 1024 {
        return Err("wallet_params_invalid".to_owned());
    }
    let mut digest_input =
        format!("\x19Ethereum Signed Message:\n{}", body.len()).into_bytes();
    digest_input.extend_from_slice(body);
    Ok(sign_digest(&require_key()?, &keccak256(&digest_input)))
}

// ------------------------------------------------------------------- RPC

/// 読み取り専用の呼び出し。候補を順に試し、eth_chainId が一致した接続先の答えだけを
/// 返す。別チェーンの残高を選択中のチェーンのものとして見せないため、どれも一致しない
/// ときは失敗にする（fail closed）。
async fn read_rpc(chain_id: u64, method: &str, params: Value) -> Result<Value, String> {
    let mut last = "rpc_unreachable".to_owned();
    for endpoint in chain_rpcs(chain_id)? {
        match rpc_call_at(&endpoint, "eth_chainId", json!([])).await {
            Ok(value) if fee_quantity_u64(&value).ok() == Some(chain_id) => {}
            Ok(_) => { last = "wallet_chain_mismatch".to_owned(); continue; }
            Err(error) => { last = error; continue; }
        }
        match rpc_call_at(&endpoint, method, params.clone()).await {
            Ok(value) => return Ok(value),
            Err(error) => last = error,
        }
    }
    Err(last)
}

async fn rpc_call_at(endpoint: &str, method: &str, params: Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "rpc_unavailable".to_owned())?;
    let response = client
        .post(endpoint)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .map_err(|_| "rpc_unreachable".to_owned())?;
    let body: Value = response
        .json()
        .await
        .map_err(|_| "rpc_bad_response".to_owned())?;
    if let Some(error) = body.get("error") {
        let message = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("rpc_error");
        return Err(format!("rpc:{message}"));
    }
    body.get("result")
        .cloned()
        .ok_or_else(|| "rpc_bad_response".to_owned())
}

// -------------------------------------------------------------- RLP/tx

fn rlp_item(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        return bytes.to_vec();
    }
    if bytes.len() <= 55 {
        let mut out = vec![0x80 + bytes.len() as u8];
        out.extend_from_slice(bytes);
        return out;
    }
    let len = bytes.len().to_be_bytes();
    let len = &len[len.iter().position(|b| *b != 0).unwrap_or(len.len() - 1)..];
    let mut out = vec![0xb7 + len.len() as u8];
    out.extend_from_slice(len);
    out.extend_from_slice(bytes);
    out
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.concat();
    if payload.len() <= 55 {
        let mut out = vec![0xc0 + payload.len() as u8];
        out.extend_from_slice(&payload);
        return out;
    }
    let len = payload.len().to_be_bytes();
    let len = &len[len.iter().position(|b| *b != 0).unwrap_or(len.len() - 1)..];
    let mut out = vec![0xf7 + len.len() as u8];
    out.extend_from_slice(len);
    out.extend_from_slice(&payload);
    out
}

fn rlp_uint(value: u128) -> Vec<u8> {
    if value == 0 {
        return rlp_item(&[]);
    }
    let bytes = value.to_be_bytes();
    let start = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len() - 1);
    rlp_item(&bytes[start..])
}

fn validate_confirmation_text(summary: &str, detail: &str) -> Result<(), String> {
    if summary.len() > MAX_CONFIRM_SUMMARY_BYTES || detail.len() > MAX_CONFIRM_DETAIL_BYTES {
        return Err("wallet_params_invalid".into());
    }
    Ok(())
}

fn validate_transaction(chain_id: u64, to: &str, value_hex: &str, data_hex: &str) -> Result<([u8; 20], u128, Vec<u8>), String> {
    chain_name(chain_id).ok_or("wallet_chain_unsupported")?;
    let to_bytes = to.strip_prefix("0x").filter(|value| value.len() == 40)
        .and_then(hex_decode_fixed::<20>).ok_or("wallet_params_invalid")?;
    let value = value_hex.strip_prefix("0x")
        .filter(|value| !value.is_empty() && value.len() <= 32 && (*value == "0" || !value.starts_with('0')) && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .and_then(|value| u128::from_str_radix(value, 16).ok()).ok_or("wallet_params_invalid")?;
    let data = data_hex.strip_prefix("0x")
        .filter(|data| data.len() <= MAX_CALLDATA_BYTES * 2 && data.len() % 2 == 0 && data.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .and_then(hex_decode).ok_or("wallet_params_invalid")?;
    Ok((to_bytes, value, data))
}

fn transaction_detail(chain_id: u64, to: &str, value: &str, data: &str, explanation: &str) -> Result<String, String> {
    validate_confirmation_text(explanation, "")?;
    let (_, wei, bytes) = validate_transaction(chain_id, to, value, data)?;
    let chain = chain_info(chain_id).ok_or("wallet_chain_unsupported")?;
    let name = chain.name;
    // 本物のお金かどうかの警告は呼び出し側の文面より前に置く。呼び出し側の説明では押し下げられない。
    let kind = if chain.mainnet {
        "【メインネット】本物のお金が動きます。ネットワーク・宛先・数量を確かめてから承認してください。\n"
    } else {
        "【テストネット】価値のないテスト用トークンのネットワークです。\n"
    };
    let explanation = if explanation.is_empty() { String::new() } else { format!("呼び出し側の説明:\n{explanation}\n\n") };
    let detail = format!("{kind}{explanation}ネットワーク {name} (chain ID {chain_id})\n宛先 {to}\n数量 {wei} wei ({} {})\ncalldata {} bytes:\n{data}", native_amount(wei), chain.symbol, bytes.len());
    validate_confirmation_text("", &detail)?;
    Ok(detail)
}

fn typed_data_detail(summary: &str, detail: &str, typed_data: &Value) -> Result<String, String> {
    validate_confirmation_text(summary, detail)?;
    let encoded = serde_json::to_string_pretty(typed_data).map_err(|_| "typed_data_invalid")?;
    let text = format!("呼び出し側の説明:\n{summary}\n{detail}\n\n署名する型付きデータ:\n{encoded}");
    validate_confirmation_text("", &text)?;
    typed_data_digest(typed_data)?;
    Ok(text)
}

fn message_detail(summary: &str, message: &str) -> Result<String, String> {
    validate_confirmation_text(summary, "")?;
    if message.is_empty() || message.len() > 64 * 1024 {
        return Err("wallet_params_invalid".into());
    }
    let detail = format!("呼び出し側の説明:\n{summary}\n\n署名する内容:\n{message}");
    validate_confirmation_text("", &detail)?;
    Ok(detail)
}

// Private snapshot: preview and signing consume these exact immutable fields.
struct PreparedTransaction {
    chain_id: u64,
    endpoint: String,
    from: String,
    nonce: u64,
    to: String,
    to_bytes: [u8; 20],
    value: u128,
    data_hex: String,
    data: Vec<u8>,
    fees: ExecutionFees,
    deadline: Instant,
}

#[derive(Debug, PartialEq)]
struct ExecutionFees {
    gas_limit: u64,
    priority: u128,
    max_fee: u128,
    execution_cap: u128,
    value_and_execution_cap: u128,
}

fn fee_quantity(value: &Value) -> Result<u128, String> {
    value.as_str().and_then(|value| value.strip_prefix("0x"))
        .filter(|value| !value.is_empty() && value.len() <= 32 && (*value == "0" || !value.starts_with('0')) && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .and_then(|value| u128::from_str_radix(value, 16).ok()).ok_or_else(|| "wallet_fee_unavailable".into())
}

fn fee_quantity_u64(value: &Value) -> Result<u64, String> {
    u64::try_from(fee_quantity(value)?).map_err(|_| "wallet_fee_unavailable".into())
}

fn execution_fees(estimate: u64, gas_price: u128, priority: u128, value: u128) -> Result<ExecutionFees, String> {
    let unavailable = || "wallet_fee_unavailable".to_owned();
    if estimate == 0 || gas_price == 0 { return Err(unavailable()); }
    // u64 estimate is widened before padding; the final u64 limit is checked.
    let gas_limit = u64::try_from((u128::from(estimate) * 6 + 4) / 5).map_err(|_| unavailable())?;
    let max_fee = gas_price.checked_mul(2).and_then(|fee| fee.checked_add(priority)).ok_or_else(unavailable)?;
    let execution_cap = u128::from(gas_limit).checked_mul(max_fee).ok_or_else(unavailable)?;
    let value_and_execution_cap = value.checked_add(execution_cap).ok_or_else(unavailable)?;
    Ok(ExecutionFees { gas_limit, priority, max_fee, execution_cap, value_and_execution_cap })
}

fn native_amount(wei: u128) -> String {
    format!("{}.{:018}", wei / 1_000_000_000_000_000_000, wei % 1_000_000_000_000_000_000)
}

fn prepared_detail(prepared: &PreparedTransaction, explanation: &str) -> Result<String, String> {
    let detail = transaction_detail(prepared.chain_id, &prepared.to, &format!("0x{:x}", prepared.value), &prepared.data_hex, explanation)?;
    let (header, calldata) = detail.rsplit_once("\ncalldata ").ok_or("wallet_params_invalid")?;
    let fees = &prepared.fees;
    let detail = format!("{header}\n送信元 {}\nnonce {}\nガス上限 {}\n優先手数料 {} wei/gas\n最大手数料 {} wei/gas\n実行ガス代の上限 {} wei ({} native)\n数量と実行ガス代の合計上限 {} wei ({} native)\nこの上限は実行ガス代のみです。実際のガス代は低くなる場合があります。L1データ料・運営手数料・その他の追加料金は含まず、支払総額の上限を保証しません。\ncalldata {calldata}", prepared.from, prepared.nonce, fees.gas_limit, fees.priority, fees.max_fee, fees.execution_cap, native_amount(fees.execution_cap), fees.value_and_execution_cap, native_amount(fees.value_and_execution_cap));
    validate_confirmation_text("", &detail)?;
    Ok(detail)
}

async fn prepare_transaction_with<R, F, N>(chain_id: u64, to: &str, value_hex: &str, data_hex: &str, endpoint: String, from: String, mut rpc: R, now: N) -> Result<PreparedTransaction, String>
where R: FnMut(&'static str, Value) -> F, F: std::future::Future<Output = Result<Value, String>>, N: FnOnce() -> Instant {
    let (to_bytes, value, data) = validate_transaction(chain_id, to, value_hex, data_hex)?;
    let unavailable = |_| "wallet_fee_unavailable".to_owned();
    let rpc_chain = fee_quantity_u64(&rpc("eth_chainId", json!([])).await.map_err(unavailable)?)?;
    if rpc_chain != chain_id { return Err("wallet_fee_unavailable".into()); }
    let nonce = fee_quantity_u64(&rpc("eth_getTransactionCount", json!([from.as_str(), "pending"])).await.map_err(unavailable)?)?;
    let gas_price = fee_quantity(&rpc("eth_gasPrice", json!([])).await.map_err(unavailable)?)?;
    if gas_price == 0 { return Err("wallet_fee_unavailable".into()); }
    let priority = rpc("eth_maxPriorityFeePerGas", json!([])).await.ok().and_then(|value| fee_quantity(&value).ok()).unwrap_or(gas_price / 5);
    let max_fee = gas_price.checked_mul(2).and_then(|fee| fee.checked_add(priority)).ok_or("wallet_fee_unavailable")?;
    let estimate = json!({ "from": from.as_str(), "to": to, "value": value_hex, "data": data_hex, "nonce": format!("0x{nonce:x}"), "type": "0x2", "maxFeePerGas": format!("0x{max_fee:x}"), "maxPriorityFeePerGas": format!("0x{priority:x}") });
    let gas = fee_quantity_u64(&rpc("eth_estimateGas", json!([estimate])).await.map_err(unavailable)?)?;
    let fees = execution_fees(gas, gas_price, priority, value)?;
    let deadline = now().checked_add(CONFIRM_TTL).ok_or("wallet_fee_unavailable")?;
    Ok(PreparedTransaction { chain_id, endpoint, from, nonce, to: to.to_owned(), to_bytes, value, data_hex: data_hex.to_owned(), data, fees, deadline })
}

async fn prepare_transaction(chain_id: u64, to: &str, value_hex: &str, data_hex: &str) -> Result<(PreparedTransaction, SigningKey), String> {
    validate_transaction(chain_id, to, value_hex, data_hex)?;
    let key = load_key().map_err(|_| "wallet_fee_unavailable")?.ok_or("wallet_fee_unavailable")?;
    ensure_selected(chain_id)?;
    let endpoint = verified_endpoint(chain_id).await.map_err(|_| "wallet_fee_unavailable")?;
    let rpc_endpoint = endpoint.clone();
    let prepared = prepare_transaction_with(chain_id, to, value_hex, data_hex, endpoint, address_of(&key), |method, params| rpc_call_at(&rpc_endpoint, method, params), Instant::now).await?;
    Ok((prepared, key))
}

fn prepared_fields(prepared: &PreparedTransaction) -> Vec<Vec<u8>> {
    vec![rlp_uint(prepared.chain_id as u128), rlp_uint(prepared.nonce as u128), rlp_uint(prepared.fees.priority), rlp_uint(prepared.fees.max_fee), rlp_uint(prepared.fees.gas_limit as u128), rlp_item(&prepared.to_bytes), rlp_uint(prepared.value), rlp_item(&prepared.data), rlp_list(&[])]
}

fn unsigned_prepared(prepared: &PreparedTransaction) -> Vec<u8> {
    [vec![0x02], rlp_list(&prepared_fields(prepared))].concat()
}

fn rlp_integer_bytes(bytes: &[u8]) -> Vec<u8> {
    rlp_item(&bytes[bytes.iter().position(|byte| *byte != 0).unwrap_or(bytes.len())..])
}

fn signed_prepared_fields(prepared: &PreparedTransaction, r: &[u8], s: &[u8], odd: bool) -> Vec<Vec<u8>> {
    let mut fields = prepared_fields(prepared);
    fields.extend([rlp_uint(odd as u128), rlp_integer_bytes(r), rlp_integer_bytes(s)]);
    fields
}

fn sign_prepared(prepared: &PreparedTransaction, key: &SigningKey) -> Vec<u8> {
    let (signature, recovery) = key.sign_prehash_recoverable(&keccak256(&unsigned_prepared(prepared))).expect("signing cannot fail");
    let bytes = signature.to_bytes();
    let fields = signed_prepared_fields(prepared, &bytes[..32], &bytes[32..], recovery.is_y_odd());
    [vec![0x02], rlp_list(&fields)].concat()
}

async fn execute_prepared<R, RF, S, T, TF, N>(prepared: &PreparedTransaction, read: R, sign: S, submit: T, now: N) -> Result<String, String>
where R: FnOnce() -> RF, RF: std::future::Future<Output = Result<(String, u64), String>>, S: FnOnce(&PreparedTransaction) -> Vec<u8>, T: FnOnce(Vec<u8>) -> TF, TF: std::future::Future<Output = Result<String, String>>, N: Fn() -> Instant {
    if now() >= prepared.deadline { return Err("wallet_fee_expired".into()); }
    let (from, nonce) = read().await.map_err(|_| "wallet_fee_unavailable")?;
    // RPC may consume the remaining window. Recheck immediately before signing.
    if now() >= prepared.deadline { return Err("wallet_fee_expired".into()); }
    if from != prepared.from || nonce != prepared.nonce { return Err("wallet_fee_stale".into()); }
    let raw = sign(prepared);
    submit(raw).await.map_err(|error| if matches!(error.as_str(), "wallet_fee_unavailable" | "wallet_fee_expired" | "wallet_fee_stale") { "rpc_unavailable".into() } else { error })
}

async fn send_prepared(prepared: &PreparedTransaction, key: &SigningKey) -> Result<String, String> {
    execute_prepared(prepared, || async {
        let current_key = load_key()?.ok_or("wallet_fee_unavailable")?;
        let from = address_of(&current_key);
        let nonce = fee_quantity_u64(&rpc_call_at(&prepared.endpoint, "eth_getTransactionCount", json!([from.as_str(), "pending"])).await?)?;
        Ok((from, nonce))
    }, |prepared| sign_prepared(prepared, key), |raw| async move {
        rpc_call_at(&prepared.endpoint, "eth_sendRawTransaction", json!([hex_encode(&raw)])).await?
            .as_str().map(str::to_owned).ok_or_else(|| "rpc_bad_response".to_owned())
    }, Instant::now).await
}

// ------------------------------------------------------------ 承認の待機

fn confirmation_admission(lock: &tokio::sync::Mutex<()>) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
    lock.try_lock().map_err(|_| "wallet_confirm_busy".into())
}

fn confirmation_deadline(now: Instant, epoch_ms: u64) -> Result<(Instant, u64), String> {
    let expires_at = epoch_ms.checked_add(CONFIRM_TTL.as_millis() as u64)
        .filter(|value| *value <= 9_007_199_254_740_991).ok_or("wallet_confirm_unavailable")?;
    let deadline = now.checked_add(CONFIRM_TTL).ok_or("wallet_confirm_unavailable")?;
    Ok((deadline, expires_at))
}

fn register_confirmation(slot: &Mutex<Option<Pending>>, id: &str, deadline: Instant) -> Result<tokio::sync::oneshot::Receiver<Decision>, String> {
    let mut pending = slot.lock().map_err(|_| "wallet_confirm_unavailable")?;
    if pending.is_some() {
        return Err("wallet_confirm_busy".into());
    }
    let (responder, receiver) = tokio::sync::oneshot::channel();
    *pending = Some(Pending { id: id.to_owned(), deadline, responder: Some(responder) });
    Ok(receiver)
}

fn resolve_pending(slot: &Mutex<Option<Pending>>, id: &str, approved: bool, now: Instant) {
    let Ok(mut pending) = slot.lock() else { return; };
    let Some(pending) = pending.as_mut().filter(|pending| pending.id == id) else { return; };
    let Some(responder) = pending.responder.take() else { return; };
    let decision = if now >= pending.deadline { Decision::Expired }
        else if approved { Decision::Approved } else { Decision::Denied };
    let _ = responder.send(decision);
}

struct ConfirmationCleanup<'a, F: FnOnce(&str, &'static str, bool)> {
    slot: &'a Mutex<Option<Pending>>,
    id: String,
    reason: &'static str,
    occluded: bool,
    closed: Option<F>,
}

impl<F: FnOnce(&str, &'static str, bool)> Drop for ConfirmationCleanup<'_, F> {
    fn drop(&mut self) {
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        let owned = slot.as_ref().is_some_and(|pending| pending.id == self.id);
        if owned {
            if let Some(responder) = slot.take().and_then(|pending| pending.responder) {
                let _ = responder.send(Decision::Denied);
            }
        }
        drop(slot);
        if let Some(closed) = self.closed.take() {
            closed(&self.id, self.reason, self.occluded && owned);
        }
    }
}

/// メイン窓の確認モーダルへ。approved が返るまで待つ（TTL 120秒）。
/// モーダルが応答しなければ否決扱い——握りつぶしはしない。
pub async fn request_confirmation(
    app: &AppHandle,
    summary: &str,
    detail: &str,
) -> Result<bool, String> {
    validate_confirmation_text(summary, detail)?;
    let epoch_ms = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| "wallet_confirm_unavailable")?.as_millis();
    let (deadline, expires_at) = confirmation_deadline(Instant::now(), u64::try_from(epoch_ms).map_err(|_| "wallet_confirm_unavailable")?)?;
    let id = uuid::Uuid::new_v4().to_string();
    let rx = register_confirmation(&PENDING, &id, deadline)?;
    let mut cleanup = ConfirmationCleanup {
        slot: &PENDING, id: id.clone(), reason: "cancelled", occluded: false,
        closed: Some(|id: &str, reason: &'static str, occluded: bool| {
            let _ = app.emit_to("main", "wallet-confirm-closed", json!({"id": id, "reason": reason}));
            if occluded { crate::browser_window::occlude_for_modal(app, false); }
        }),
    };
    // Hide child webviews before emitting so they cannot cover a fast response.
    crate::browser_window::occlude_for_modal(app, true);
    cleanup.occluded = true;
    let emitted = app.emit_to(
        "main",
        "wallet-confirm-request",
        json!({ "id": id, "summary": summary, "detail": detail, "expiresAt": expires_at }),
    );
    if emitted.is_err() {
        cleanup.reason = "unavailable";
        return Err("wallet_confirm_unavailable".to_owned());
    }
    let answer = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), rx).await;
    let now = Instant::now();
    let approved = matches!(&answer, Ok(Ok(Decision::Approved))) && now < deadline;
    cleanup.reason = if now >= deadline || matches!(&answer, Ok(Ok(Decision::Expired)) | Err(_)) {
        "expired"
    } else if matches!(&answer, Ok(Err(_))) {
        "unavailable"
    } else if approved { "completed" } else { "cancelled" };
    if cleanup.reason == "unavailable" { return Err("wallet_confirm_unavailable".into()); }
    Ok(approved)
}

/// モーダルの応答。両方向（UIボタン・タイムアウト）から来るので一度だけ効く。
pub fn resolve_confirmation(id: &str, approved: bool) {
    resolve_pending(&PENDING, id, approved, Instant::now());
}

// ------------------------------------------------------------- ネイティブ

/// ネイティブUIからの型付き署名（ウォレット連携）。確認モーダルを挟む。
pub async fn sign_typed_data_confirmed(
    app: &AppHandle,
    typed_data: &Value,
) -> Result<String, String> {
    ensure_typed_data_chain(typed_data)?;
    let _operation = confirmation_admission(&CONFIRMED_OPERATION)?;
    let detail = typed_data_detail("ウォレット連携の署名", "この端末のウォレットアドレスをHubプロフィールへ紐づけます", typed_data)?;
    if !request_confirmation(
        app,
        "ウォレット連携の署名",
        &detail,
    )
    .await?
    {
        return Err("wallet_user_rejected".to_owned());
    }
    sign_typed_data(typed_data)
}

/// 用途を呼び出し側が示す型付き署名。ウォレット紐づけ以外（AI の x402
/// 支払いなど）が使う。確認モーダルには対価の人間向け表示と、署名に
/// 縛られる実値をそのまま出す。
pub async fn sign_typed_data_purpose(
    app: &AppHandle,
    summary: &str,
    detail: &str,
    typed_data: &Value,
) -> Result<String, String> {
    ensure_typed_data_chain(typed_data)?;
    let _operation = confirmation_admission(&CONFIRMED_OPERATION)?;
    let text = typed_data_detail(summary, detail, typed_data)?;
    if !request_confirmation(app, "署名の確認", &text).await? {
        return Err("wallet_user_rejected".to_owned());
    }
    sign_typed_data(typed_data)
}

/// ネイティブUIからのメッセージ署名（販売者登録の所有確認など）。
/// 確認モーダルには人間向けの概要と、署名する本文をそのまま見せる。
pub async fn sign_message_confirmed(
    app: &AppHandle,
    summary: &str,
    message: &str,
) -> Result<String, String> {
    let _operation = confirmation_admission(&CONFIRMED_OPERATION)?;
    let detail = message_detail(summary, message)?;
    if !request_confirmation(app, "メッセージ署名の確認", &detail).await? {
        return Err("wallet_user_rejected".to_owned());
    }
    sign_message(message)
}

/// ネイティブUIからのネイティブトークン送金（チップ用）。確認モーダルを挟む。
pub async fn send_native_confirmed(
    app: &AppHandle,
    chain_id: u64,
    to: &str,
    amount_wei_hex: &str,
) -> Result<String, String> {
    ensure_selected(chain_id)?;
    let _operation = confirmation_admission(&CONFIRMED_OPERATION)?;
    let (prepared, key) = prepare_transaction(chain_id, to, amount_wei_hex, "0x").await?;
    let detail = prepared_detail(&prepared, "")?;
    let chain = chain_info(chain_id).ok_or("wallet_chain_unsupported")?;
    let title = format!("{}の送金（{}）", chain.symbol, chain.name);
    if !request_confirmation(app, &title, &detail).await? {
        return Err("wallet_user_rejected".to_owned());
    }
    send_prepared(&prepared, &key).await
}

/// ネイティブUIからのコントラクト呼出し（ECのエスクロー入金など）。
/// 確認モーダルには人間向けの概要と、実際のcalldataを両方見せる。
/// 窓はcalldataを組み立てない——Commerceが返したものをそのまま通す。
pub async fn send_contract_confirmed(
    app: &AppHandle,
    chain_id: u64,
    to: &str,
    value_wei_hex: &str,
    data_hex: &str,
    summary: &str,
) -> Result<String, String> {
    ensure_selected(chain_id)?;
    let _operation = confirmation_admission(&CONFIRMED_OPERATION)?;
    validate_confirmation_text(summary, "")?;
    let (prepared, key) = prepare_transaction(chain_id, to, value_wei_hex, data_hex).await?;
    let detail = prepared_detail(&prepared, summary)?;
    if !request_confirmation(app, "コントラクト操作の確認", &detail).await? {
        return Err("wallet_user_rejected".to_owned());
    }
    send_prepared(&prepared, &key).await
}

// Commerce recovery stores identifiers only, never signed bytes or payment authority.
const TRANSACTION_INDEX_ID: &str = "83596faa-9e7d-4c32-8b79-c7625d3eb717";
const TRANSACTION_MAX_RECORDS: usize = 100;
const TRANSACTION_MAX_BYTES: usize = 256 * 1024;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionIndex {
    version: u8,
    records: Vec<TransactionRecord>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionRecord {
    scope: String,
    order_id: String,
    phase: String,
    chain_id: u64,
    from: String,
    nonce: u64,
    target: String,
    value_hex: String,
    calldata_hash: String,
    transaction_hash: String,
    #[serde(default, skip_serializing_if = "is_false")]
    resolved: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    reverted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    escrow_split: Option<[String; 2]>,
}

fn is_false(value: &bool) -> bool { !value }

fn escrow_phase(phase: &str) -> Result<(&'static str, &'static str), String> {
    let parts: Vec<_> = phase.splitn(5, ':').collect();
    if parts.len() != 4 || parts[0] != "escrow" || uuid::Uuid::parse_str(parts[3]).ok().is_none_or(|id| id.get_version_num() != 4 || id.get_variant() != uuid::Variant::RFC4122 || id.to_string() != parts[3]) {
        return Err("wallet_escrow_invalid".into());
    }
    let role = match parts[1] { "buyer" => "buyer", "seller" => "seller", _ => return Err("wallet_escrow_invalid".into()) };
    let action = match (role, parts[2]) {
        ("buyer", "confirm") => "confirm", ("buyer", "refund_unshipped") => "refund_unshipped",
        ("seller", "ship") => "ship", ("seller", "refund_by_seller") => "refund_by_seller",
        (_, "release") => "release", (_, "dispute") => "dispute", (_, "propose_resolution") => "propose_resolution",
        (_, "accept_resolution") => "accept_resolution", (_, "finalize_expired_dispute") => "finalize_expired_dispute",
        _ => return Err("wallet_escrow_invalid".into()),
    };
    Ok((role, action))
}

pub fn escrow_role(phase: &str) -> Result<&'static str, String> { escrow_phase(phase).map(|parts| parts.0) }

fn escrow_selector(action: &str) -> &'static str {
    match action { "confirm" => "34539694", "release" => "a42f2b0c", "refund_unshipped" => "9006b145", "dispute" => "f08ef6cb",
        "propose_resolution" => "878d683d", "accept_resolution" => "2739489e", "finalize_expired_dispute" => "9d63a591",
        "ship" => "93ef8d21", "refund_by_seller" => "6c5be2a8", _ => unreachable!("validated escrow action") }
}

fn escrow_split_amount(value: &str) -> Result<u128, String> {
    value.parse::<u128>().ok().filter(|number| number.to_string() == value).ok_or_else(|| "wallet_escrow_invalid".into())
}

fn validate_escrow_split(split: &[String; 2]) -> Result<(), String> {
    escrow_split_amount(&split[0])?.checked_add(escrow_split_amount(&split[1])?).filter(|sum| *sum > 0).ok_or("wallet_escrow_invalid")?;
    Ok(())
}

fn escrow_data(phase: &str, value: u128, data: &[u8]) -> Result<Option<[String; 2]>, String> {
    if matches!(phase, "approval" | "payment") { return Ok(None); }
    if refund_quote_id(phase).is_ok() { refund_data(value,data)?; return Ok(None); }
    let (_, action) = escrow_phase(phase)?;
    let length = match action { "propose_resolution" => 100, "accept_resolution" => 164, _ => 36 };
    if value != 0 || data.len() != length || &hex_encode(&data[..4])[2..] != escrow_selector(action) { return Err("wallet_escrow_invalid".into()); }
    if matches!(action, "propose_resolution" | "accept_resolution") {
        if data[36..52].iter().chain(&data[68..84]).any(|byte| *byte != 0) { return Err("wallet_escrow_invalid".into()); }
        let buyer = u128::from_be_bytes(data[52..68].try_into().unwrap());
        let seller = u128::from_be_bytes(data[84..100].try_into().unwrap());
        if action == "propose_resolution" {
            let split = [buyer.to_string(), seller.to_string()]; validate_escrow_split(&split)?; return Ok(Some(split));
        }
        if data[100..124].iter().any(|byte| *byte != 0) { return Err("wallet_escrow_invalid".into()); }
    }
    Ok(None)
}

fn escrow_record_valid(record: &TransactionRecord) -> bool {
    if matches!(record.phase.as_str(), "approval" | "payment") { return !record.resolved && !record.reverted && record.escrow_split.is_none(); }
    if refund_quote_id(&record.phase).is_ok() {
        let Ok(value) = fee_quantity(&json!(record.value_hex)) else { return false; };
        let empty_hash=hex_encode(&keccak256(&[]));
        return !record.reverted && record.escrow_split.is_none() && ((value>0 && record.calldata_hash==empty_hash) || (value==0 && record.calldata_hash!=empty_hash));
    }
    let Ok((_, action)) = escrow_phase(&record.phase) else { return false; };
    (!record.reverted || record.resolved) && record.value_hex == "0x0" && match (&record.escrow_split, action) {
        (Some(split), "propose_resolution") => validate_escrow_split(split).is_ok(), (None, action) => action != "propose_resolution", _ => false,
    }
}

fn unresolved_order_operation(index: &TransactionIndex, scope: &str, from: &str, order_id: &str) -> bool {
    index.records.iter().any(|record| record.scope == scope && record.from == from && record.order_id == order_id && !record.resolved && order_operation_phase(&record.phase))
}

fn refund_quote_id(phase: &str) -> Result<&str, String> {
    let quote = phase.strip_prefix("refund:").ok_or("wallet_refund_invalid")?;
    if uuid::Uuid::parse_str(quote).ok().is_none_or(|id| id.get_version_num() != 4 || id.get_variant() != uuid::Variant::RFC4122 || id.to_string() != quote) { return Err("wallet_refund_invalid".into()); }
    Ok(quote)
}

fn refund_data(value: u128, data: &[u8]) -> Result<(), String> {
    if data.is_empty() { return if value > 0 { Ok(()) } else { Err("wallet_refund_invalid".into()) }; }
    if value != 0 || data.len() != 68 || data[..4] != [0xa9,0x05,0x9c,0xbb]
        || data[4..16].iter().chain(&data[36..52]).any(|byte| *byte != 0)
        || u128::from_be_bytes(data[52..68].try_into().unwrap()) == 0 { return Err("wallet_refund_invalid".into()); }
    Ok(())
}

fn order_operation_phase(phase: &str) -> bool { phase.starts_with("escrow:") || phase.starts_with("refund:") }

fn resolution_bytes(phase: &str) -> usize {
    if phase.starts_with("escrow:") { b",\"resolved\":true".len()+b",\"reverted\":true".len() }
    else if phase.starts_with("refund:") { b",\"resolved\":true".len() } else { 0 }
}

fn recovery_context(scope: &str, order_id: &str, phase: &str) -> Result<(), String> {
    let origin = reqwest::Url::parse(scope).map_err(|_| "wallet_recovery_invalid")?;
    let local = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let bare = origin.origin().ascii_serialization();
    if scope.len() > 2048 || (bare != scope && format!("{bare}/shopping/api/commerce") != scope)
        || !(origin.scheme() == "https" || origin.scheme() == "http" && local)
        || order_id.is_empty() || order_id.len() > 200
        || !order_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || !(matches!(phase, "approval" | "payment") || escrow_phase(phase).is_ok() || refund_quote_id(phase).is_ok()) {
        return Err("wallet_recovery_invalid".into());
    }
    Ok(())
}

fn recovery_hash(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn validate_transactions(index: &TransactionIndex) -> Result<(), String> {
    if index.version != 1 || index.records.len() > TRANSACTION_MAX_RECORDS { return Err("wallet_recovery_invalid".into()); }
    let mut operations = std::collections::HashSet::new();
    let mut nonces = std::collections::HashSet::new();
    let mut unresolved = std::collections::HashSet::new();
    for record in &index.records {
        if recovery_context(&record.scope, &record.order_id, &record.phase).is_err()
            || validate_transaction(record.chain_id, &record.from, "0x0", "0x").is_err()
            || record.from != record.from.to_ascii_lowercase()
            || validate_transaction(record.chain_id, &record.target, &record.value_hex, "0x").is_err()
            || !recovery_hash(&record.calldata_hash) || !recovery_hash(&record.transaction_hash)
            || !escrow_record_valid(record)
            || order_operation_phase(&record.phase) && !record.resolved && !unresolved.insert((&record.scope, &record.from, &record.order_id))
            || !operations.insert((&record.scope, &record.from, &record.order_id, &record.phase))
            || !nonces.insert((&record.from, record.chain_id, record.nonce)) {
            return Err("wallet_recovery_invalid".into());
        }
    }
    Ok(())
}

fn transaction_store(create_key: bool) -> Result<(std::fs::File, crate::checkpoint::CheckpointStore), String> {
    let guard = crate::checkpoint::CheckpointStore::lock_named("wallet-transactions")
        .map_err(|error| if error == "checkpoint_lock_busy" { "wallet_recovery_busy" } else { "wallet_recovery_unavailable" })?;
    let store = if create_key {
        crate::checkpoint::CheckpointStore::with_key("wallet-transactions", "wallet-transactions-key-v1")
    } else {
        crate::checkpoint::CheckpointStore::with_existing_key("wallet-transactions", "wallet-transactions-key-v1")
    }.map_err(|_| "wallet_recovery_unavailable")?;
    Ok((guard, store))
}

fn load_transactions(store: &crate::checkpoint::CheckpointStore) -> Result<TransactionIndex, String> {
    let index = store.load_optional_bounded(TRANSACTION_INDEX_ID, TRANSACTION_MAX_BYTES)
        .map_err(|_| "wallet_recovery_invalid")?.unwrap_or(TransactionIndex { version: 1, records: Vec::new() });
    validate_transactions(&index)?;
    Ok(index)
}

fn save_transactions(store: &crate::checkpoint::CheckpointStore, index: &TransactionIndex) -> Result<(), String> {
    validate_transactions(index)?;
    if serde_json::to_vec(index).map_err(|_| "wallet_recovery_invalid")?.len() > TRANSACTION_MAX_BYTES {
        return Err("wallet_recovery_limit".into());
    }
    store.save(TRANSACTION_INDEX_ID, index).map_err(|_| "wallet_recovery_unavailable".into())
}

fn recovery_lookup(index: &TransactionIndex, scope: &str, from: &str, order_id: &str, phase: &str) -> Value {
    let record = index.records.iter().find(|record| record.scope == scope && record.from == from && record.order_id == order_id && record.phase == phase);
    json!({ "orderId": order_id, "phase": phase, "chainId": record.map(|record| record.chain_id), "transactionHash": record.map(|record| &record.transaction_hash) })
}

fn transaction_record(prepared: &PreparedTransaction, scope: &str, order_id: &str, phase: &str, hash: String) -> Result<TransactionRecord, String> {
    Ok(TransactionRecord {
        scope: scope.into(), order_id: order_id.into(), phase: phase.into(), chain_id: prepared.chain_id,
        from: prepared.from.clone(), nonce: prepared.nonce, target: prepared.to.clone(), value_hex: format!("0x{:x}", prepared.value),
        calldata_hash: hex_encode(&keccak256(&prepared.data)), transaction_hash: hash,
        resolved: false, reverted: false, escrow_split: escrow_data(phase, prepared.value, &prepared.data)?,
    })
}

fn recovery_admission(index: &TransactionIndex, prepared: &PreparedTransaction, scope: &str, order_id: &str, phase: &str) -> Result<(), String> {
    recovery_context(scope, order_id, phase)?;
    validate_transactions(index)?;
    escrow_data(phase, prepared.value, &prepared.data)?;
    if order_operation_phase(phase) && unresolved_order_operation(index, scope, &prepared.from, order_id) { return Err("wallet_recovery_pending".into()); }
    if index.records.iter().any(|record|
        record.from == prepared.from && (record.scope == scope && record.order_id == order_id && record.phase == phase
            || record.chain_id == prepared.chain_id && record.nonce == prepared.nonce)) {
        return Err("wallet_recovery_pending".into());
    }
    let bytes = serde_json::to_vec(index).map_err(|_| "wallet_recovery_invalid")?.len();
    let record_bytes = serde_json::to_vec(&transaction_record(prepared, scope, order_id, phase, format!("0x{}", "0".repeat(64)))?).map_err(|_| "wallet_recovery_invalid")?.len();
    if index.records.len() >= TRANSACTION_MAX_RECORDS
        || bytes.checked_add(record_bytes).and_then(|bytes| bytes.checked_add(usize::from(!index.records.is_empty())))
            .and_then(|bytes| bytes.checked_add(index.records.iter().filter(|record| !record.resolved).map(|record| resolution_bytes(&record.phase)).sum::<usize>() + resolution_bytes(phase))).is_none_or(|bytes| bytes > TRANSACTION_MAX_BYTES) {
        return Err("wallet_recovery_limit".into());
    }
    Ok(())
}

async fn execute_recoverable<R, RF, S, P, T, TF, N>(index: &mut TransactionIndex, prepared: &PreparedTransaction, scope: &str, order_id: &str, phase: &str, read: R, sign: S, persist: P, broadcast: T, now: N) -> Result<String, String>
where R: FnOnce() -> RF, RF: std::future::Future<Output = Result<(String, u64), String>>, S: FnOnce(&PreparedTransaction) -> Vec<u8>, P: FnOnce(&TransactionIndex) -> Result<(), String>, T: FnOnce(Vec<u8>) -> TF, TF: std::future::Future<Output = Result<String, String>>, N: Fn() -> Instant {
    recovery_admission(index, prepared, scope, order_id, phase)?;
    execute_prepared(prepared, read, sign, |raw| async move {
        let hash = hex_encode(&keccak256(&raw));
        index.records.push(transaction_record(prepared, scope, order_id, phase, hash.clone())?);
        persist(index).map_err(|_| "wallet_recovery_unavailable")?;
        let result = broadcast(raw).await?;
        if result.strip_prefix("0x").is_none_or(|payload| payload.len() != 64 || !payload.eq_ignore_ascii_case(&hash[2..])) { return Err("wallet_recovery_hash_mismatch".into()); }
        Ok(hash)
    }, now).await
}

pub fn recover_contract(scope: &str, order_id: &str, phase: &str) -> Result<Value, String> {
    recovery_context(scope, order_id, phase)?;
    let (_guard, store) = transaction_store(false)?;
    let index = load_transactions(&store)?;
    let key = load_key().map_err(|_| "wallet_recovery_unavailable")?.ok_or("wallet_recovery_unavailable")?;
    Ok(recovery_lookup(&index, scope, &address_of(&key), order_id, phase))
}

fn refund_send_gate(expected_sender: Option<[u8; 20]>, from: &str, expires_at: Option<i64>, now: i64) -> Result<(), String> {
    if let Some(expected) = expected_sender {
        let actual = approval_hex::<20>(&json!(from)).map_err(|_| "wallet_fee_unavailable")?;
        if actual != expected { return Err("wallet_fee_stale".into()); }
    }
    if expires_at.is_some_and(|expiry| now >= expiry) { return Err("wallet_fee_expired".into()); }
    Ok(())
}

pub async fn send_contract_confirmed_recoverable(app: &AppHandle, chain_id: u64, to: &str, value_hex: &str, data_hex: &str, summary: &str, scope: &str, order_id: &str, phase: &str, expected_sender: Option<&str>, refund_expires_at: Option<i64>) -> Result<String, String> {
    ensure_selected(chain_id)?;
    let _operation = confirmation_admission(&CONFIRMED_OPERATION)?;
    recovery_context(scope, order_id, phase)?;
    let expected_sender = expected_sender.map(|sender| approval_hex::<20>(&json!(sender)).map_err(|_| "wallet_params_invalid".to_owned())).transpose()?;
    let (_, value, data) = validate_transaction(chain_id, to, value_hex, data_hex)?;
    escrow_data(phase, value, &data)?;
    validate_confirmation_text(summary, "")?;
    let (_store_guard, store) = transaction_store(true)?;
    let mut index = load_transactions(&store)?;
    let key = load_key().map_err(|_| "wallet_recovery_unavailable")?.ok_or("wallet_recovery_unavailable")?;
    let from = address_of(&key);
    refund_send_gate(expected_sender, &from, refund_expires_at, chrono::Utc::now().timestamp_millis())?;
    if recovery_lookup(&index, scope, &from, order_id, phase)["transactionHash"].is_string() || order_operation_phase(phase) && unresolved_order_operation(&index, scope, &from, order_id) { return Err("wallet_recovery_pending".into()); }
    if index.records.len() >= TRANSACTION_MAX_RECORDS { return Err("wallet_recovery_limit".into()); }
    let (prepared, signing_key) = prepare_transaction(chain_id, to, value_hex, data_hex).await?;
    if prepared.from != from { return Err("wallet_fee_stale".into()); }
    refund_send_gate(expected_sender, &prepared.from, refund_expires_at, chrono::Utc::now().timestamp_millis())?;
    recovery_admission(&index, &prepared, scope, order_id, phase)?;
    let detail = prepared_detail(&prepared, summary)?;
    if !request_confirmation(app, "コントラクト操作の確認", &detail).await? { return Err("wallet_user_rejected".into()); }
    refund_send_gate(expected_sender, &prepared.from, refund_expires_at, chrono::Utc::now().timestamp_millis())?;
    let endpoint = &prepared.endpoint;
    execute_recoverable(&mut index, &prepared, scope, order_id, phase, || async {
        let current_key = load_key()?.ok_or("wallet_fee_unavailable")?;
        let from = address_of(&current_key);
        let nonce = fee_quantity_u64(&rpc_call_at(endpoint, "eth_getTransactionCount", json!([from.as_str(), "pending"])).await?)?;
        refund_send_gate(expected_sender, &from, refund_expires_at, chrono::Utc::now().timestamp_millis())?;
        Ok((from, nonce))
    }, |prepared| sign_prepared(prepared, &signing_key), |index| save_transactions(&store, index), |raw| async move {
        rpc_call_at(endpoint, "eth_sendRawTransaction", json!([hex_encode(&raw)])).await?
            .as_str().map(str::to_owned).ok_or_else(|| "rpc_bad_response".to_owned())
    }, Instant::now).await
}

fn escrow_operation_value(record: &TransactionRecord) -> Result<Value, String> {
    let (role, action) = escrow_phase(&record.phase)?;
    let extra = record.escrow_split.as_ref().map_or(json!({}), |split| json!({ "buyerAmountAtomic": split[0], "sellerAmountAtomic": split[1] }));
    Ok(json!({ "phase": record.phase, "role": role, "action": action, "chainId": record.chain_id, "transactionHash": record.transaction_hash, "extra": extra }))
}

fn escrow_pending_value(index: &TransactionIndex, scope: &str, order_id: &str, owner: &str) -> Result<Value, String> {
    recovery_context(scope, order_id, "approval")?;
    validate_transactions(index)?;
    let operations = index.records.iter().filter(|record| record.scope == scope && record.from == owner && record.order_id == order_id && record.phase.starts_with("escrow:") && !record.resolved)
        .map(escrow_operation_value).collect::<Result<Vec<Value>, String>>()?;
    Ok(json!({ "orderId": order_id, "operations": operations }))
}

fn escrow_open(scope: &str, order_id: &str, create_key: bool) -> Result<Value, String> {
    recovery_context(scope, order_id, "approval")?;
    let (_guard, store) = transaction_store(create_key)?;
    let index = load_transactions(&store)?;
    let key = load_key().map_err(|_| "wallet_escrow_unavailable")?.ok_or("wallet_escrow_unavailable")?;
    let owner=address_of(&key);
    if create_key && index.records.iter().any(|record| record.scope==scope && record.from==owner && record.order_id==order_id && !record.resolved && record.phase.starts_with("refund:")) { return Err("wallet_recovery_pending".into()); }
    escrow_pending_value(&index, scope, order_id, &owner)
}

pub fn escrow_begin(scope: &str, order_id: &str) -> Result<Value, String> { escrow_open(scope, order_id, true) }
pub fn escrow_pending(scope: &str, order_id: &str) -> Result<Value, String> { escrow_open(scope, order_id, false) }

fn escrow_confirmation(record: &TransactionRecord, detail: &Value) -> Result<(), String> {
    let (role, action) = escrow_phase(&record.phase)?;
    if detail["order"]["id"].as_str() != Some(record.order_id.as_str()) || detail["order"]["chainId"].as_u64() != Some(record.chain_id)
        || approval_hex::<20>(&detail["physicalEscrow"]["contractAddress"]).map_err(|_| "wallet_escrow_mismatch")?
            != approval_hex::<20>(&json!(record.target)).map_err(|_| "wallet_escrow_mismatch")? { return Err("wallet_escrow_mismatch".into()); }
    let submissions = detail["escrowSubmissions"].as_array().filter(|rows| rows.len() <= 20).ok_or("wallet_escrow_mismatch")?;
    let hash = approval_hex::<32>(&json!(record.transaction_hash)).map_err(|_| "wallet_escrow_mismatch")?;
    let matches = submissions.iter().map(|row| {
        if approval_hex::<32>(&row["transactionHash"]).map_err(|_| "wallet_escrow_mismatch")? != hash { return Ok(None); }
        if row["actorRole"].as_str() != Some(role) || row["action"].as_str() != Some(action) { return Err("wallet_escrow_mismatch".into()); }
        match row["status"].as_str() { Some(status @ ("confirmed" | "submitted" | "failed")) => Ok(Some(status)), _ => Err("wallet_escrow_mismatch".into()) }
    }).collect::<Result<Vec<Option<&str>>, String>>()?;
    let mut matches = matches.into_iter().flatten();
    let status = matches.next().ok_or("wallet_escrow_not_confirmed")?;
    if matches.next().is_some() { return Err("wallet_escrow_mismatch".into()); }
    if status != "confirmed" { return Err("wallet_escrow_not_confirmed".into()); }
    Ok(())
}

async fn finish_escrow_with<R, F, W, P>(index: &mut TransactionIndex, scope: &str, order_id: &str, phase: &str, owner: &str, read: R, current_wallet: W, persist: P) -> Result<Value, String>
where R: FnOnce() -> F, F: std::future::Future<Output = Result<Value, String>>, W: FnOnce() -> Result<String, String>, P: FnOnce(&TransactionIndex) -> Result<(), String> {
    recovery_context(scope, order_id, phase)?;
    escrow_phase(phase)?;
    validate_transactions(index)?;
    let position = index.records.iter().position(|record| record.scope == scope && record.from == owner && record.order_id == order_id && record.phase == phase).ok_or("wallet_escrow_invalid")?;
    if index.records[position].reverted { return Err("wallet_escrow_reverted".into()); }
    let detail = read().await.map_err(|_| "wallet_escrow_unavailable")?;
    let proof = escrow_confirmation(&index.records[position], &detail);
    if current_wallet().map_err(|_| "wallet_escrow_unavailable")? != owner { return Err("wallet_escrow_mismatch".into()); }
    proof?;
    let was_resolved = index.records[position].resolved;
    index.records[position].resolved = true;
    if persist(index).is_err() { index.records[position].resolved = was_resolved; return Err("wallet_escrow_unavailable".into()); }
    Ok(json!({ "orderId": order_id, "phase": phase, "transactionHash": index.records[position].transaction_hash, "resolved": true }))
}

pub async fn finish_escrow<R, F>(scope: &str, order_id: &str, phase: &str, read: R) -> Result<Value, String>
where R: FnOnce() -> F, F: std::future::Future<Output = Result<Value, String>> {
    recovery_context(scope, order_id, phase)?;
    escrow_phase(phase)?;
    let (_guard, store) = transaction_store(false)?;
    let mut index = load_transactions(&store)?;
    let key = load_key().map_err(|_| "wallet_escrow_unavailable")?.ok_or("wallet_escrow_unavailable")?;
    finish_escrow_with(&mut index, scope, order_id, phase, &address_of(&key), read,
        || load_key().map_err(|_| "wallet_escrow_unavailable".to_owned())?.map(|key| address_of(&key)).ok_or_else(|| "wallet_escrow_unavailable".into()),
        |index| save_transactions(&store, index)).await
}

const MAX_BLOCK_TRANSACTIONS: usize = 10_000;

#[derive(Debug, PartialEq)]
struct FailedInclusion { number: u64, hash: [u8; 32], index: usize }

fn escrow_rpc_hex<const N: usize>(value: &Value) -> Result<[u8; N], String> {
    approval_hex(value).map_err(|_| "wallet_escrow_mismatch".into())
}

fn escrow_rpc_quantity(value: &Value) -> Result<u64, String> {
    fee_quantity_u64(value).map_err(|_| "wallet_escrow_mismatch".into())
}

fn failure_receipt(record: &TransactionRecord, receipt: &Value) -> Result<FailedInclusion, String> {
    if receipt.is_null() { return Err("wallet_escrow_unavailable".into()); }
    let status = fee_quantity(&receipt["status"]).map_err(|_| "wallet_escrow_mismatch")?;
    if status != 0 { return Err("wallet_escrow_not_reverted".into()); }
    if escrow_rpc_hex::<32>(&receipt["transactionHash"])? != escrow_rpc_hex::<32>(&json!(record.transaction_hash))?
        || escrow_rpc_hex::<20>(&receipt["from"])? != escrow_rpc_hex::<20>(&json!(record.from))?
        || escrow_rpc_hex::<20>(&receipt["to"])? != escrow_rpc_hex::<20>(&json!(record.target))? { return Err("wallet_escrow_mismatch".into()); }
    let index = usize::try_from(escrow_rpc_quantity(&receipt["transactionIndex"])?).map_err(|_| "wallet_escrow_mismatch")?;
    if index >= MAX_BLOCK_TRANSACTIONS { return Err("wallet_escrow_mismatch".into()); }
    Ok(FailedInclusion { number: escrow_rpc_quantity(&receipt["blockNumber"])?, hash: escrow_rpc_hex(&receipt["blockHash"])?, index })
}

fn failure_header(block: &Value) -> Result<(u64, [u8; 32]), String> {
    Ok((escrow_rpc_quantity(&block["number"])?, escrow_rpc_hex(&block["hash"])?))
}

fn failure_block(record: &TransactionRecord, inclusion: &FailedInclusion, block: &Value) -> Result<(), String> {
    if failure_header(block)? != (inclusion.number, inclusion.hash) { return Err("wallet_escrow_mismatch".into()); }
    let hashes = block["transactions"].as_array().filter(|hashes| hashes.len() <= MAX_BLOCK_TRANSACTIONS).ok_or("wallet_escrow_mismatch")?;
    let mut seen = std::collections::HashSet::new();
    hashes.iter().try_for_each(|hash| if seen.insert(escrow_rpc_hex::<32>(hash)?) { Ok(()) } else { Err("wallet_escrow_mismatch".to_owned()) })?;
    if escrow_rpc_hex::<32>(hashes.get(inclusion.index).ok_or("wallet_escrow_mismatch")?)? != escrow_rpc_hex::<32>(&json!(record.transaction_hash))? { return Err("wallet_escrow_mismatch".into()); }
    Ok(())
}

async fn failure_proof_with<R, F>(record: &TransactionRecord, rpc: &mut R) -> Result<(), String>
where R: FnMut(&'static str, Value) -> F, F: std::future::Future<Output = Result<Value, String>> {
    let unavailable = |_| "wallet_escrow_unavailable".to_owned();
    if escrow_rpc_quantity(&rpc("eth_chainId", json!([])).await.map_err(unavailable)?)? != record.chain_id { return Err("wallet_escrow_mismatch".into()); }
    let transaction = rpc("eth_getTransactionByHash", json!([record.transaction_hash])).await.map_err(unavailable)?;
    let data = transaction["input"].as_str().and_then(|hex| hex.strip_prefix("0x"))
        .filter(|hex| hex.len() <= MAX_CALLDATA_BYTES * 2).and_then(hex_decode).ok_or("wallet_escrow_mismatch")?;
    if escrow_rpc_hex::<32>(&transaction["hash"])? != escrow_rpc_hex::<32>(&json!(record.transaction_hash))?
        || escrow_rpc_hex::<20>(&transaction["from"])? != escrow_rpc_hex::<20>(&json!(record.from))?
        || escrow_rpc_hex::<20>(&transaction["to"])? != escrow_rpc_hex::<20>(&json!(record.target))?
        || escrow_rpc_quantity(&transaction["value"])? != 0 || escrow_rpc_quantity(&transaction["nonce"])? != record.nonce
        || hex_encode(&keccak256(&data)) != record.calldata_hash
        || escrow_data(&record.phase, 0, &data)? != record.escrow_split { return Err("wallet_escrow_mismatch".into()); }
    let receipt = rpc("eth_getTransactionReceipt", json!([record.transaction_hash])).await.map_err(unavailable)?;
    let inclusion = failure_receipt(record, &receipt)?;
    let number = format!("0x{:x}", inclusion.number);
    let block = rpc("eth_getBlockByNumber", json!([number, false])).await.map_err(unavailable)?;
    failure_block(record, &inclusion, &block)?;
    let finalized = failure_header(&rpc("eth_getBlockByNumber", json!(["finalized", false])).await.map_err(unavailable)?)?;
    if finalized.0 < inclusion.number { return Err("wallet_escrow_unavailable".into()); }
    if finalized.0 == inclusion.number && finalized.1 != inclusion.hash { return Err("wallet_escrow_mismatch".into()); }
    let canonical = failure_header(&rpc("eth_getBlockByNumber", json!([format!("0x{:x}", finalized.0), false])).await.map_err(unavailable)?)?;
    if canonical != finalized { return Err("wallet_escrow_mismatch".into()); }
    let again = rpc("eth_getTransactionReceipt", json!([record.transaction_hash])).await.map_err(unavailable)?;
    if failure_receipt(record, &again)? != inclusion { return Err("wallet_escrow_mismatch".into()); }
    let block = rpc("eth_getBlockByNumber", json!([number, false])).await.map_err(unavailable)?;
    failure_block(record, &inclusion, &block)?;
    let head = failure_header(&rpc("eth_getBlockByNumber", json!(["finalized", false])).await.map_err(unavailable)?)?;
    if head.0 < finalized.0 || head.0 == finalized.0 && head.1 != finalized.1 || head.0 == inclusion.number && head.1 != inclusion.hash { return Err("wallet_escrow_mismatch".into()); }
    let canonical = failure_header(&rpc("eth_getBlockByNumber", json!([format!("0x{:x}", head.0), false])).await.map_err(unavailable)?)?;
    if canonical != head || escrow_rpc_quantity(&rpc("eth_chainId", json!([])).await.map_err(unavailable)?)? != record.chain_id { return Err("wallet_escrow_mismatch".into()); }
    Ok(())
}

async fn check_escrow_failure_with<R, RF, Q, QF, W, P>(index: &mut TransactionIndex, scope: &str, order_id: &str, phase: &str, owner: &str, read: R, mut rpc: Q, current_wallet: W, persist: P) -> Result<Value, String>
where R: FnOnce() -> RF, RF: std::future::Future<Output = Result<Value, String>>, Q: FnMut(&'static str, Value) -> QF, QF: std::future::Future<Output = Result<Value, String>>, W: FnOnce() -> Result<String, String>, P: FnOnce(&TransactionIndex) -> Result<(), String> {
    recovery_context(scope, order_id, phase)?; escrow_phase(phase)?; validate_transactions(index)?;
    let position = index.records.iter().position(|record| record.scope == scope && record.from == owner && record.order_id == order_id && record.phase == phase).ok_or("wallet_escrow_invalid")?;
    if index.records[position].resolved && !index.records[position].reverted { return Err("wallet_escrow_mismatch".into()); }
    let detail = read().await.map_err(|_| "wallet_escrow_unavailable")?;
    match escrow_confirmation(&index.records[position], &detail) {
        Err(error) if error == "wallet_escrow_not_confirmed" => (),
        _ => return Err("wallet_escrow_mismatch".into()),
    }
    failure_proof_with(&index.records[position], &mut rpc).await?;
    if current_wallet().map_err(|_| "wallet_escrow_unavailable")? != owner { return Err("wallet_escrow_mismatch".into()); }
    let old = (index.records[position].resolved, index.records[position].reverted);
    index.records[position].resolved = true; index.records[position].reverted = true;
    if persist(index).is_err() { index.records[position].resolved = old.0; index.records[position].reverted = old.1; return Err("wallet_escrow_unavailable".into()); }
    Ok(json!({ "orderId": order_id, "phase": phase, "transactionHash": index.records[position].transaction_hash, "status": "reverted" }))
}

pub async fn check_escrow_failure<R, F>(scope: &str, order_id: &str, phase: &str, read: R) -> Result<Value, String>
where R: FnOnce() -> F, F: std::future::Future<Output = Result<Value, String>> {
    recovery_context(scope, order_id, phase)?; escrow_phase(phase)?;
    let (_guard, store) = transaction_store(false)?;
    let mut index = load_transactions(&store)?;
    let key = load_key().map_err(|_| "wallet_escrow_unavailable")?.ok_or("wallet_escrow_unavailable")?;
    let owner = address_of(&key);
    let record = index.records.iter().find(|record| record.scope == scope && record.from == owner && record.order_id == order_id && record.phase == phase).ok_or("wallet_escrow_invalid")?;
    let endpoint = chain_rpc(record.chain_id).map_err(|_| "wallet_escrow_unavailable")?;
    check_escrow_failure_with(&mut index, scope, order_id, phase, &owner, read, |method, params| rpc_call_at(&endpoint, method, params),
        || load_key().map_err(|_| "wallet_escrow_unavailable".to_owned())?.map(|key| address_of(&key)).ok_or_else(|| "wallet_escrow_unavailable".into()),
        |index| save_transactions(&store, index)).await
}

pub fn escrow_history(scope: &str, order_id: &str) -> Result<Value, String> {
    recovery_context(scope, order_id, "approval")?;
    let (_guard, store) = transaction_store(false)?;
    let index = load_transactions(&store)?;
    let key = load_key().map_err(|_| "wallet_escrow_unavailable")?.ok_or("wallet_escrow_unavailable")?;
    escrow_history_value(&index, scope, order_id, &address_of(&key))
}

fn escrow_history_value(index: &TransactionIndex, scope: &str, order_id: &str, owner: &str) -> Result<Value, String> {
    recovery_context(scope, order_id, "approval")?; validate_transactions(index)?;
    let operations = index.records.iter().filter(|record| record.scope == scope && record.from == owner && record.order_id == order_id && record.resolved && record.reverted)
        .map(escrow_operation_value).collect::<Result<Vec<Value>, String>>()?;
    Ok(json!({ "orderId": order_id, "verifiedReverted": operations }))
}

fn refund_pending_value(index: &TransactionIndex, scope: &str, order_id: &str, owner: &str) -> Result<Value,String> {
    recovery_context(scope,order_id,"payment")?; validate_transactions(index)?;
    let operations=index.records.iter().filter(|record|record.scope==scope && record.from==owner && record.order_id==order_id && !record.resolved && record.phase.starts_with("refund:"))
        .map(|record|Ok(json!({"phase":record.phase,"quoteId":refund_quote_id(&record.phase)?,"chainId":record.chain_id,"transactionHash":record.transaction_hash}))).collect::<Result<Vec<Value>,String>>()?;
    Ok(json!({"orderId":order_id,"operations":operations}))
}

fn refund_open(scope: &str, order_id: &str, create_key: bool) -> Result<Value,String> {
    recovery_context(scope,order_id,"payment")?;
    let (_guard,store)=transaction_store(create_key)?; let index=load_transactions(&store)?;
    let key=load_key().map_err(|_|"wallet_refund_unavailable")?.ok_or("wallet_refund_unavailable")?; let owner=address_of(&key);
    if create_key && index.records.iter().any(|record|record.scope==scope && record.from==owner && record.order_id==order_id && !record.resolved && record.phase.starts_with("escrow:")) {return Err("wallet_recovery_pending".into());}
    refund_pending_value(&index,scope,order_id,&owner)
}

pub fn refund_begin(scope: &str, order_id: &str) -> Result<Value,String> {refund_open(scope,order_id,true)}
pub fn refund_pending(scope: &str, order_id: &str) -> Result<Value,String> {refund_open(scope,order_id,false)}

fn refund_id(value: &Value) -> Result<&str,String> {
    value.as_str().filter(|id|!id.is_empty() && id.len()<=200 && id.bytes().all(|byte|byte.is_ascii_alphanumeric() || matches!(byte,b'_'|b'-'))).ok_or_else(||"wallet_refund_mismatch".into())
}

fn refund_confirmation(record: &TransactionRecord, detail: &Value) -> Result<(),String> {
    refund_quote_id(&record.phase)?;
    let order=&detail["order"];
    if order["id"].as_str()!=Some(record.order_id.as_str()) || order["chainId"].as_u64()!=Some(record.chain_id)
        || detail.get("physicalEscrow")!=Some(&Value::Null)
        || escrow_rpc_hex::<20>(&order["payoutWallet"]).map_err(|_|"wallet_refund_mismatch")? != escrow_rpc_hex::<20>(&json!(record.from)).map_err(|_|"wallet_refund_mismatch")? {return Err("wallet_refund_mismatch".into());}
    let buyer=escrow_rpc_hex::<20>(&order["buyerWallet"]).map_err(|_|"wallet_refund_mismatch")?;
    let target=escrow_rpc_hex::<20>(&json!(record.target)).map_err(|_|"wallet_refund_mismatch")?;
    let value=fee_quantity(&json!(record.value_hex)).map_err(|_|"wallet_refund_mismatch")?;
    match order["assetKind"].as_str() {
        Some("native") if value>0 && target==buyer && record.calldata_hash==hex_encode(&keccak256(&[]))=>(),
        Some("erc20") if value==0 && target==escrow_rpc_hex::<20>(&order["tokenContract"]).map_err(|_|"wallet_refund_mismatch")? && record.calldata_hash!=hex_encode(&keccak256(&[]))=>(),
        _=>return Err("wallet_refund_mismatch".into()),
    }
    let refunds=detail["refunds"].as_array().filter(|rows|rows.len()<=100).ok_or("wallet_refund_mismatch")?;
    let attempts=detail["refundAttempts"].as_array().filter(|rows|rows.len()<=100).ok_or("wallet_refund_mismatch")?;
    let hash=escrow_rpc_hex::<32>(&json!(record.transaction_hash)).map_err(|_|"wallet_refund_mismatch")?;
    let mut ids=std::collections::HashSet::new();let mut hashes=std::collections::HashSet::new();let mut matched=None;
    for row in refunds {
        let id=refund_id(&row["id"])?; let row_hash=escrow_rpc_hex::<32>(&row["sellerRefundTransactionHash"]).map_err(|_|"wallet_refund_mismatch")?;
        let amount=row["amountAtomic"].as_str().and_then(|amount|escrow_split_amount(amount).ok()).filter(|amount|*amount>0).ok_or("wallet_refund_mismatch")?;
        let status=row["status"].as_str().filter(|status|matches!(*status,"submitted"|"confirmed"|"rejected")).ok_or("wallet_refund_mismatch")?;
        if !ids.insert(id) || !hashes.insert(row_hash) {return Err("wallet_refund_mismatch".into());}
        if row_hash==hash { if value>amount{return Err("wallet_refund_mismatch".into());} matched=Some((id,status)); }
    }
    let matched_id=matched.map(|entry|entry.0);
    let mut hashes=std::collections::HashSet::new();let mut confirmed=None;
    for row in attempts {
        let id=refund_id(&row["refundId"])?;
        let row_hash=escrow_rpc_hex::<32>(&row["transactionHash"]).map_err(|_|"wallet_refund_mismatch")?;
        let role=row["role"].as_str().filter(|role|matches!(*role,"seller"|"hub_fee")).ok_or("wallet_refund_mismatch")?;
        let state=row["status"].as_str().filter(|status|matches!(*status,"submitted"|"confirmed"|"rejected")).ok_or("wallet_refund_mismatch")?;
        if !ids.contains(id) || !hashes.insert(row_hash) {return Err("wallet_refund_mismatch".into());}
        if row_hash==hash {if Some(id)!=matched_id || role!="seller" {return Err("wallet_refund_mismatch".into());}confirmed=Some(state);}
    }
    let (_,status)=matched.ok_or("wallet_refund_not_confirmed")?;
    if status=="rejected" || confirmed!=Some("confirmed") {return Err("wallet_refund_not_confirmed".into());}
    // ERC20 recipient/amount were checked before signing. Commerce confirms the
    // saved exact hash; its detail does not expose the seller amount to rebuild it.
    Ok(())
}

async fn finish_refund_with<R,F,W,P>(index: &mut TransactionIndex, scope: &str, order_id: &str, phase: &str, owner: &str, read:R, current_wallet:W, persist:P)->Result<Value,String>
where R:FnOnce()->F,F:std::future::Future<Output=Result<Value,String>>,W:FnOnce()->Result<String,String>,P:FnOnce(&TransactionIndex)->Result<(),String>{
    recovery_context(scope,order_id,phase)?;refund_quote_id(phase)?;validate_transactions(index)?;
    let position=index.records.iter().position(|record|record.scope==scope && record.from==owner && record.order_id==order_id && record.phase==phase).ok_or("wallet_refund_invalid")?;
    let detail=read().await.map_err(|_|"wallet_refund_unavailable")?;let proof=refund_confirmation(&index.records[position],&detail);
    if current_wallet().map_err(|_|"wallet_refund_unavailable")?!=owner {return Err("wallet_refund_mismatch".into());}proof?;
    let old=index.records[position].resolved;index.records[position].resolved=true;
    if persist(index).is_err(){index.records[position].resolved=old;return Err("wallet_refund_unavailable".into());}
    Ok(json!({"orderId":order_id,"phase":phase,"transactionHash":index.records[position].transaction_hash,"resolved":true,"sellerTransferConfirmed":true}))
}

pub async fn finish_refund<R,F>(scope: &str, order_id: &str, phase: &str, read:R)->Result<Value,String>
where R:FnOnce()->F,F:std::future::Future<Output=Result<Value,String>>{
    recovery_context(scope,order_id,phase)?;refund_quote_id(phase)?;
    let (_guard,store)=transaction_store(false)?;let mut index=load_transactions(&store)?;
    let key=load_key().map_err(|_|"wallet_refund_unavailable")?.ok_or("wallet_refund_unavailable")?;
    finish_refund_with(&mut index,scope,order_id,phase,&address_of(&key),read,||load_key().map_err(|_|"wallet_refund_unavailable".to_owned())?.map(|key|address_of(&key)).ok_or_else(||"wallet_refund_unavailable".into()),|index|save_transactions(&store,index)).await
}

struct ApprovalInput {
    token: [u8; 20],
    spender: [u8; 20],
    amount: [u8; 32],
    data: Vec<u8>,
}

fn approval_hex<const N: usize>(value: &Value) -> Result<[u8; N], String> {
    value.as_str().and_then(|text| text.strip_prefix("0x"))
        .filter(|hex| hex.len() == N * 2).and_then(hex_decode_fixed::<N>).ok_or_else(|| "wallet_approval_invalid".into())
}

fn approval_input(chain_id: u64, token: &str, spender: &str, amount: &str, data: &str) -> Result<ApprovalInput, String> {
    let (token, value, data) = validate_transaction(chain_id, token, "0x0", data)?;
    let spender = approval_hex::<20>(&json!(spender))?;
    let amount = amount.parse::<u128>().ok().filter(|value| *value > 0 && value.to_string() == amount).ok_or("wallet_approval_invalid")?;
    let mut word = [0; 32];
    word[16..].copy_from_slice(&amount.to_be_bytes());
    let expected = [vec![0x09, 0x5e, 0xa7, 0xb3], vec![0; 12], spender.to_vec(), word.to_vec()].concat();
    if value != 0 || data != expected { return Err("wallet_approval_invalid".into()); }
    Ok(ApprovalInput { token, spender, amount: word, data })
}

fn approval_receipt(receipt: &Value, record: &TransactionRecord, input: &ApprovalInput) -> Result<(u64, [u8; 32], u128), String> {
    let hash = approval_hex::<32>(&receipt["transactionHash"])?;
    let from = approval_hex::<20>(&receipt["from"])?;
    let to = approval_hex::<20>(&receipt["to"])?;
    let block_hash = approval_hex::<32>(&receipt["blockHash"])?;
    let block = fee_quantity_u64(&receipt["blockNumber"]).map_err(|_| "wallet_approval_invalid")?;
    let status = fee_quantity(&receipt["status"]).map_err(|_| "wallet_approval_invalid")?;
    if hash != approval_hex::<32>(&json!(record.transaction_hash))? || from != approval_hex::<20>(&json!(record.from))?
        || to != input.token || status > 1 { return Err("wallet_approval_mismatch".into()); }
    Ok((block, block_hash, status))
}

async fn approval_proof_with<R, F>(record: &TransactionRecord, input: &ApprovalInput, rpc: &mut R) -> Result<&'static str, String>
where R: FnMut(&'static str, Value) -> F, F: std::future::Future<Output = Result<Value, String>> {
    let unavailable = |_| "wallet_approval_unavailable".to_owned();
    let chain = fee_quantity_u64(&rpc("eth_chainId", json!([])).await.map_err(unavailable)?).map_err(|_| "wallet_approval_invalid")?;
    if chain != record.chain_id { return Err("wallet_approval_mismatch".into()); }
    let transaction = rpc("eth_getTransactionByHash", json!([record.transaction_hash])).await.map_err(unavailable)?;
    let data = transaction["input"].as_str().and_then(|hex| hex.strip_prefix("0x"))
        .filter(|hex| hex.len() == input.data.len() * 2).and_then(hex_decode).ok_or("wallet_approval_invalid")?;
    if approval_hex::<32>(&transaction["hash"])? != approval_hex::<32>(&json!(record.transaction_hash))?
        || approval_hex::<20>(&transaction["from"])? != approval_hex::<20>(&json!(record.from))?
        || approval_hex::<20>(&transaction["to"])? != input.token
        || fee_quantity(&transaction["value"]).map_err(|_| "wallet_approval_invalid")? != 0
        || fee_quantity_u64(&transaction["nonce"]).map_err(|_| "wallet_approval_invalid")? != record.nonce
        || data != input.data { return Err("wallet_approval_mismatch".into()); }
    let receipt = rpc("eth_getTransactionReceipt", json!([record.transaction_hash])).await.map_err(unavailable)?;
    if receipt.is_null() { return Ok("pending"); }
    let included = approval_receipt(&receipt, record, input)?;
    if included.2 == 0 { return Ok("failed"); }
    let block = rpc("eth_getBlockByNumber", json!([format!("0x{:x}", included.0), false])).await.map_err(unavailable)?;
    if approval_hex::<32>(&block["hash"])? != included.1
        || fee_quantity_u64(&block["number"]).map_err(|_| "wallet_approval_invalid")? != included.0 { return Err("wallet_approval_mismatch".into()); }
    let owner = approval_hex::<20>(&json!(record.from))?;
    let call_data = hex_encode(&[vec![0xdd, 0x62, 0xed, 0x3e], vec![0; 12], owner.to_vec(), vec![0; 12], input.spender.to_vec()].concat());
    let allowance = approval_hex::<32>(&rpc("eth_call", json!([{"to": hex_encode(&input.token), "data": call_data}, "latest"])).await.map_err(unavailable)?)?;
    let again = rpc("eth_getTransactionReceipt", json!([record.transaction_hash])).await.map_err(unavailable)?;
    if approval_receipt(&again, record, input)? != included { return Err("wallet_approval_mismatch".into()); }
    Ok(if allowance >= input.amount { "ready" } else { "insufficient" })
}

async fn check_approval_with<R, F, W>(index: &TransactionIndex, scope: &str, order_id: &str, chain_id: u64, token: &str, spender: &str, amount: &str, data: &str, owner: &str, mut rpc: R, current_wallet: W) -> Result<Value, String>
where R: FnMut(&'static str, Value) -> F, F: std::future::Future<Output = Result<Value, String>>, W: FnOnce() -> Result<String, String> {
    recovery_context(scope, order_id, "approval")?;
    let input = approval_input(chain_id, token, spender, amount, data)?;
    validate_transactions(index)?;
    if index.records.iter().any(|record| record.scope == scope && record.from == owner && record.order_id == order_id && record.phase == "payment") { return Err("wallet_approval_payment_pending".into()); }
    let record = index.records.iter().find(|record| record.scope == scope && record.from == owner && record.order_id == order_id && record.phase == "approval");
    let status = if let Some(record) = record {
        if record.chain_id != chain_id || approval_hex::<20>(&json!(record.target))? != input.token
            || fee_quantity(&json!(record.value_hex)).map_err(|_| "wallet_approval_invalid")? != 0
            || record.calldata_hash != hex_encode(&keccak256(&input.data)) { return Err("wallet_approval_mismatch".into()); }
        approval_proof_with(record, &input, &mut rpc).await?
    } else { "missing" };
    if current_wallet().map_err(|_| "wallet_approval_unavailable")? != owner { return Err("wallet_approval_mismatch".into()); }
    Ok(json!({ "orderId": order_id, "chainId": chain_id, "approvalHash": record.map(|record| &record.transaction_hash), "status": status }))
}

pub async fn check_approval(scope: &str, order_id: &str, chain_id: u64, token_contract: &str, spender: &str, amount_atomic: &str, approval_data: &str) -> Result<Value, String> {
    recovery_context(scope, order_id, "approval")?;
    approval_input(chain_id, token_contract, spender, amount_atomic, approval_data)?;
    let (_guard, store) = transaction_store(false)?;
    let index = load_transactions(&store)?;
    let key = load_key().map_err(|_| "wallet_approval_unavailable")?.ok_or("wallet_approval_unavailable")?;
    let owner = address_of(&key);
    let endpoint = chain_rpc(chain_id).map_err(|_| "wallet_approval_unavailable")?;
    check_approval_with(&index, scope, order_id, chain_id, token_contract, spender, amount_atomic, approval_data, &owner,
        |method, params| rpc_call_at(&endpoint, method, params),
        || load_key().map_err(|_| "wallet_approval_unavailable".to_owned())?.map(|key| address_of(&key)).ok_or_else(|| "wallet_approval_unavailable".into())).await
}

/// ウォレット面の状態表示用。
pub fn status() -> Result<Value, String> {
    Ok(status_value(&wallet_address()?, settings()))
}

/// 選べるネットワーク。テスト網は開発者設定がオンのときだけ並ぶ。
fn selectable_chains(settings: WalletSettings) -> impl Iterator<Item = &'static ChainInfo> {
    CHAINS.iter().filter(move |chain| chain.mainnet || settings.developer)
}

fn status_value(address: &str, settings: WalletSettings) -> Value {
    let selected = chain_info(settings.chain_id).unwrap_or(&CHAINS[0]);
    json!({
        "address": address,
        "chainId": selected.id,
        "chainName": selected.name,
        "symbol": selected.symbol,
        "mainnet": selected.mainnet,
        "developer": settings.developer,
        "chains": selectable_chains(settings)
            .map(|chain| json!({"chainId": chain.id, "name": chain.name, "symbol": chain.symbol, "mainnet": chain.mainnet}))
            .collect::<Vec<_>>(),
        "tokens": KNOWN_TOKENS.iter().filter(|token| token.chain_id == selected.id)
            .map(|token| json!({"symbol": token.symbol, "address": token.address, "decimals": token.decimals}))
            .collect::<Vec<_>>(),
    })
}

/// ネットワークの切り替え。窓からの明示操作だけが呼ぶ。許可リスト外、
/// および開発者設定の無いテスト網は拒否する。
pub fn select_chain(chain_id: u64) -> Result<Value, String> {
    let next = update_settings(|current| current.select(chain_id))?;
    Ok(json!({"chainId": next.chain_id, "developer": next.developer}))
}

/// 開発者設定（テスト網を選べるようにする）。切るとテスト網の選択は既定へ戻る。
pub fn set_developer(enabled: bool) -> Result<Value, String> {
    let next = update_settings(|current| Ok(current.with_developer(enabled)))?;
    Ok(json!({"chainId": next.chain_id, "developer": next.developer}))
}

/// 選択中チェーンのネイティブ残高（wei、10進文字列）と、そのチェーンID。
/// 窓は返ったチェーンIDが表示中のものと同じときだけ表示する。
/// RPCが落ちているときは呼び出し側で「取得できません」表示にする。
pub async fn native_balance_wei() -> Result<(u64, String), String> {
    let chain = current_chain();
    let address = wallet_address()?;
    let value = read_rpc(chain, "eth_getBalance", json!([address, "latest"])).await?;
    Ok((chain, quantity_decimal(&value)?))
}

fn quantity_decimal(value: &Value) -> Result<String, String> {
    let hex = value.as_str().ok_or_else(|| "rpc_bad_response".to_owned())?;
    fee_quantity(&json!(hex)).map(|wei| wei.to_string()).map_err(|_| "rpc_bad_response".to_owned())
}

/// ERC-20 balanceOf(address) の呼び出しデータ。
fn balance_of_data(address: &str) -> Result<String, String> {
    let bytes = address.strip_prefix("0x").filter(|body| body.len() == 40)
        .and_then(hex_decode_fixed::<20>).ok_or("wallet_params_invalid")?;
    Ok(format!("0x70a08231{}{}", "0".repeat(24), &hex_encode(&bytes)[2..]))
}

/// eth_call が返す32バイトの数量を10進文字列にする。幅が違えば失敗。
fn token_amount(value: &Value) -> Result<String, String> {
    let word = value.as_str().and_then(hex_decode_fixed::<32>).ok_or("rpc_bad_response")?;
    let (high, low) = word.split_at(16);
    if high.iter().any(|byte| *byte != 0) { return Err("rpc_bad_response".into()); }
    Ok(u128::from_be_bytes(low.try_into().expect("16 bytes")).to_string())
}

/// 選択中チェーンの既知トークン残高（読み取りのみ）。トークンごとに失敗しうるので、
/// 取れなかったものは balanceRaw を null にして残す。
pub async fn token_balances() -> Result<Value, String> {
    let chain = current_chain();
    let address = wallet_address()?;
    let data = balance_of_data(&address)?;
    let mut rows = Vec::new();
    for token in KNOWN_TOKENS.iter().filter(|token| token.chain_id == chain) {
        let call = json!([{ "to": token.address, "data": data }, "latest"]);
        let raw = read_rpc(chain, "eth_call", call).await.and_then(|value| token_amount(&value)).ok();
        rows.push(json!({"symbol": token.symbol, "address": token.address, "decimals": token.decimals, "balanceRaw": raw}));
    }
    Ok(json!({"chainId": chain, "tokens": rows}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> SigningKey {
        let mut secret = [0u8; 32];
        secret[31] = 1;
        SigningKey::from_slice(&secret).unwrap()
    }

    #[test]
    fn default_rpc_endpoints_are_not_retired_hosts() {
        // 既定チェーンのRPCが廃止ホストだと、残高も送金も常に失敗する。
        assert_eq!(WalletSettings::DEFAULT.chain_id, DEFAULT_CHAIN);
        for chain in CHAINS {
            for rpc in std::iter::once(chain.rpc).chain(chain.fallback_rpc) {
                assert!(rpc.starts_with("https://"), "{}", chain.id);
                assert!(!rpc.contains("rpc-amoy.polygon.technology"), "{}: retired RPC host", chain.id);
            }
        }
        assert_eq!(chain_rpc(80_002).unwrap_or_default().contains("publicnode.com") || std::env::var("HUB_WALLET_RPC_80002").is_ok(), true);
    }

    #[test]
    fn address_derivation_matches_known_vector() {
        assert_eq!(
            address_of(&test_key()),
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn signature_recovers_to_signer() {
        // keyring ではなく固定鍵で検証（sign_digest のみ）
        let digest = keccak256(b"hello");
        let signature = sign_digest(&test_key(), &digest);
        let raw = hex_decode(&signature).unwrap();
        assert_eq!(raw.len(), 65);
        let sig = k256::ecdsa::Signature::from_slice(&raw[..64]).unwrap();
        let recovery = k256::ecdsa::RecoveryId::from_byte(raw[64] - 27).unwrap();
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(&digest, &sig, recovery)
            .unwrap();
        assert_eq!(
            format!("0x{}", &hex_encode(&keccak256(&recovered.to_encoded_point(false).as_bytes()[1..])[12..])[2..]),
            address_of(&test_key())
        );
    }

    #[test]
    fn eip712_domain_and_struct_hash_known_vector() {
        // "JKamma Hub Wallet Link" ドメイン + ProfileWalletLink の固定値で
        // viem の hashTypedData と照合したい既知ベクトル。
        let typed = json!({
            "domain": {
                "name": "JKamma Hub Wallet Link",
                "version": "1",
                "chainId": 80002,
                "verifyingContract": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
            },
            "primaryType": "ProfileWalletLink",
            "types": {
                "ProfileWalletLink": [
                    { "name": "purpose", "type": "string" },
                    { "name": "audience", "type": "string" },
                    { "name": "profileId", "type": "string" },
                    { "name": "profileHandle", "type": "string" },
                    { "name": "wallet", "type": "address" },
                    { "name": "chainId", "type": "uint256" },
                    { "name": "nonce", "type": "string" },
                    { "name": "issuedAt", "type": "uint64" },
                    { "name": "expiresAt", "type": "uint64" }
                ]
            },
            "message": {
                "purpose": "hub_profile_wallet_link_v1",
                "audience": "hub_desktop",
                "profileId": "profile-1",
                "profileHandle": "noa",
                "wallet": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
                "chainId": "80002",
                "nonce": "nonce-1",
                "issuedAt": "1700000000",
                "expiresAt": "1700000300"
            }
        });
        // sign_typed_data は keyring を読むので、内部のハッシュ手順だけ
        // ドメインと構造体のエンコードで検証する。
        let domain = domain_separator(&typed).unwrap();
        let fields = typed["types"]["ProfileWalletLink"].clone();
        let struct_hash = hash_struct(
            "ProfileWalletLink",
            &fields,
            &typed["message"],
            &typed["types"],
            "ProfileWalletLink",
        )
        .unwrap();
        assert_ne!(domain, [0u8; 32]);
        assert_ne!(struct_hash, [0u8; 32]);
    }

    #[test]
    fn eip712_matches_spec_example() {
        // EIP-712仕様書の "Ether Mail" 例。domain separator・struct hash・
        // 最終ダイジェストが仕様記載値と一致することを確認する。
        let typed = json!({
            "domain": {
                "name": "Ether Mail",
                "version": "1",
                "chainId": 1,
                "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
            },
            "primaryType": "Mail",
            "types": {
                "Mail": [
                    { "name": "from", "type": "Person" },
                    { "name": "to", "type": "Person" },
                    { "name": "contents", "type": "string" }
                ],
                "Person": [
                    { "name": "name", "type": "string" },
                    { "name": "wallet", "type": "address" }
                ]
            },
            "message": {
                "from": { "name": "Cow", "wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
                "to": { "name": "Bob", "wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
                "contents": "Hello, Bob!"
            }
        });
        assert_eq!(
            hex_encode(&domain_separator(&typed).unwrap()),
            "0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f"
        );
        let struct_hash = hash_struct(
            "Mail",
            &typed["types"]["Mail"],
            &typed["message"],
            &typed["types"],
            "Mail",
        )
        .unwrap();
        assert_eq!(
            hex_encode(&struct_hash),
            "0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e"
        );
        let mut input = vec![0x19, 0x01];
        input.extend(domain_separator(&typed).unwrap());
        input.extend(struct_hash);
        assert_eq!(
            hex_encode(&keccak256(&input)),
            "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2"
        );
    }

    #[test]
    fn encode_type_terminates_on_cyclic_types() {
        // A→B→A の循環でも終わること。依存は頭部のみ・名前順。
        let types = json!({
            "A": [{ "name": "next", "type": "B" }],
            "B": [{ "name": "next", "type": "A" }]
        });
        assert_eq!(
            encode_type("A", &types, "A").unwrap(),
            "A(B next)B(A next)"
        );
    }

    #[test]
    fn abi_uint_handles_full_uint256() {
        // u128を超える値も通ること。2^256-1。
        let max = dec_to_word(
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        )
        .unwrap();
        assert_eq!(max, [0xffu8; 32]);
        // 溢れは拒否。
        assert!(dec_to_word(
            "115792089237316195423570985008687907853269984665640564039457584007913129639936",
        )
        .is_none());
        assert_eq!(dec_to_word("0").unwrap(), [0u8; 32]);
        // hex は 32バイト超を弾く。
        assert!(abi_uint(&json!("0x")).is_ok());
        assert!(abi_uint(&json!(format!("0x{}", "ff".repeat(33)))).is_err());
    }

    #[test]
    fn abi_int_sign_extends() {
        let types = json!({});
        // -1 は全ビット1で符号拡張される。
        assert_eq!(
            encode_atomic("int256", &json!(-1), &types, "").unwrap(),
            [0xffu8; 32].to_vec()
        );
        assert_eq!(
            encode_atomic("int8", &json!("-1"), &types, "").unwrap(),
            [0xffu8; 32].to_vec()
        );
    }

    #[test]
    fn rlp_matches_known_encodings() {
        assert_eq!(rlp_item(&[]), vec![0x80]);
        assert_eq!(rlp_item(&[0x05]), vec![0x05]);
        assert_eq!(rlp_item(b"cat"), vec![0x83, b'c', b'a', b't']);
        assert_eq!(
            rlp_list(&[rlp_item(b"cat"), rlp_item(b"dog")]),
            vec![0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']
        );
        assert_eq!(rlp_uint(0), vec![0x80]);
        assert_eq!(rlp_uint(1024), vec![0x82, 0x04, 0x00]);
    }

}

#[cfg(test)]
mod confirmation_tests {
    use super::*;
    const ADDRESS: &str = "0x1234567890aBCDEF1234567890abcdef12345678";
    const ID_A: &str = "12345678-1234-4234-8234-123456789abc";
    const ID_B: &str = "12345678-1234-4234-8234-123456789def";

    fn typed(body: &str) -> Value {
        json!({"domain":{},"primaryType":"Proof","types":{"Proof":[{"name":"body","type":"string"}]},"message":{"body":body}})
    }

    #[test]
    fn transaction_preview_keeps_full_maximum_calldata_and_actual_arguments() {
        let data = format!("0x{}D00D", "ab".repeat(MAX_CALLDATA_BYTES - 2));
        let value = format!("0x{:x}", u128::MAX);
        let (to, wei, decoded) = validate_transaction(80002, ADDRESS, &value, &data).unwrap();
        assert_eq!(to, hex_decode_fixed::<20>(ADDRESS).unwrap());
        assert_eq!(wei, u128::MAX);
        assert_eq!(decoded.len(), MAX_CALLDATA_BYTES);
        assert_eq!(&decoded[MAX_CALLDATA_BYTES - 2..], &[0xd0, 0x0d]);
        let detail = transaction_detail(80002, ADDRESS, &value, &data, "caller context").unwrap();
        assert!(detail.contains("Polygon Amoy (chain ID 80002)"));
        assert!(detail.contains(ADDRESS));
        assert!(detail.contains(&u128::MAX.to_string()));
        assert!(detail.contains("calldata 32768 bytes:"));
        assert!(detail.contains(&data));
        // 本物のお金かどうかの警告が先頭。呼び出し側の説明は警告の後ろに来る。
        assert!(detail.starts_with("【テストネット】"));
        assert!(detail.contains("呼び出し側の説明:\ncaller context\n\n"));
        assert!(detail.ends_with(&data));
        assert!(validate_transaction(80002, ADDRESS, "0x0", "0x").is_ok());
    }

    #[test]
    fn malformed_untrimmed_transaction_inputs_never_reach_confirmation() {
        for to in [ADDRESS[2..].to_owned(), format!(" {ADDRESS}"), format!("{ADDRESS}\n"), "0x1234".into(), format!("0x{}", "ff".repeat(21))] {
            assert!(transaction_detail(80002, &to, "0x1", "0x", "").is_err());
        }
        for value in ["1", "0x", "0x+1", "0x00", "0x01", "0x0x1", " 0x1", "0x1 ", "0x1\n", "0x100000000000000000000000000000000"] {
            assert!(transaction_detail(80002, ADDRESS, value, "0x", "").is_err(), "{value}");
        }
        for data in ["00".to_owned(), "0x0".into(), "0xＦＦ".into(), "0xgg".into(), " 0xab".into(), "0xab ".into(), format!("0x{}", "ab".repeat(MAX_CALLDATA_BYTES + 1))] {
            assert!(transaction_detail(80002, ADDRESS, "0x0", &data, "").is_err());
        }
        assert_eq!(transaction_detail(999, ADDRESS, "0x1", "0x", "").unwrap_err(), "wallet_chain_unsupported");
    }

    #[test]
    fn typed_data_preview_round_trips_full_values_and_validates_before_prompting() {
        let body = format!("{}\n\"\\末尾", "文".repeat(20000));
        let data = typed(&body);
        let before = data.clone();
        let detail = typed_data_detail("purpose", "context", &data).unwrap();
        let encoded = detail.split_once("署名する型付きデータ:\n").unwrap().1;
        assert_eq!(serde_json::from_str::<Value>(encoded).unwrap(), data);
        assert_eq!(data, before);
        assert!(detail.contains("末尾"));
        assert!(typed_data_detail("", "", &typed(&"x".repeat(MAX_CONFIRM_DETAIL_BYTES))).is_err());
        assert!(typed_data_detail("", "", &json!({})).is_err());
    }

    #[test]
    fn confirmation_text_and_message_limits_count_utf8_bytes() {
        let summary = "🧪".repeat(MAX_CONFIRM_SUMMARY_BYTES / 4);
        let detail = "🧪".repeat(MAX_CONFIRM_DETAIL_BYTES / 4);
        assert!(validate_confirmation_text(&summary, &detail).is_ok());
        assert!(validate_confirmation_text(&(summary + "x"), "").is_err());
        assert!(validate_confirmation_text("", &(detail + "x")).is_err());
        let message = format!("{}TAIL", "🧪".repeat((64 * 1024 - 4) / 4));
        assert!(message_detail("context", &message).unwrap().contains(&message));
        assert!(message_detail("", &(message + "x")).is_err());
        assert!(message_detail("", "").is_err());
    }

    #[test]
    fn operation_admission_stays_busy_until_the_whole_operation_drops() {
        let lock = tokio::sync::Mutex::new(());
        let signing_or_sending = confirmation_admission(&lock).unwrap();
        assert_eq!(confirmation_admission(&lock).err().unwrap(), "wallet_confirm_busy");
        drop(signing_or_sending);
        assert!(confirmation_admission(&lock).is_ok());
    }

    #[test]
    fn a_matching_decision_is_once_and_does_not_admit_another_pending_request() {
        let slot = Mutex::new(None);
        let now = Instant::now();
        let mut receiver = register_confirmation(&slot, ID_A, now + CONFIRM_TTL).unwrap();
        assert_eq!(register_confirmation(&slot, ID_B, now + CONFIRM_TTL).err().unwrap(), "wallet_confirm_busy");
        resolve_pending(&slot, ID_B, true, now);
        assert_eq!(receiver.try_recv().unwrap_err(), tokio::sync::oneshot::error::TryRecvError::Empty);
        resolve_pending(&slot, ID_A, false, now);
        resolve_pending(&slot, ID_A, true, now);
        assert_eq!(receiver.try_recv().unwrap(), Decision::Denied);
        assert!(slot.lock().unwrap().as_ref().unwrap().responder.is_none());
        assert_eq!(register_confirmation(&slot, ID_B, now + CONFIRM_TTL).err().unwrap(), "wallet_confirm_busy");
    }

    #[test]
    fn native_deadline_rejects_approvals_at_or_after_expiry() {
        let now = Instant::now();
        let (deadline, expiry) = confirmation_deadline(now, 1700000000000).unwrap();
        assert_eq!(expiry, 1700000120000);
        for (when, expected) in [(deadline - Duration::from_nanos(1), Decision::Approved), (deadline, Decision::Expired), (deadline + Duration::from_nanos(1), Decision::Expired)] {
            let slot = Mutex::new(None);
            let mut receiver = register_confirmation(&slot, ID_A, deadline).unwrap();
            resolve_pending(&slot, ID_A, true, when);
            assert_eq!(receiver.try_recv().unwrap(), expected);
        }
        assert!(confirmation_deadline(now, u64::MAX).is_err());
        assert!(confirmation_deadline(now, 9_007_199_254_740_991 - 120_000).is_ok());
        assert!(confirmation_deadline(now, 9_007_199_254_740_991 - 119_999).is_err());
    }

    #[test]
    fn cleanup_drop_denies_and_closes_and_restores_once_for_each_failure_reason() {
        for reason in ["cancelled", "expired", "unavailable"] {
            let slot = Mutex::new(None);
            let closed = Mutex::new(Vec::new());
            let mut receiver = register_confirmation(&slot, ID_A, Instant::now() + CONFIRM_TTL).unwrap();
            let cleanup = ConfirmationCleanup { slot: &slot, id: ID_A.to_owned(), reason, occluded: true,
                closed: Some(|id: &str, reason, restore| closed.lock().unwrap().push((id.to_owned(), reason, restore))) };
            drop(cleanup);
            assert_eq!(receiver.try_recv().unwrap(), Decision::Denied);
            assert!(slot.lock().unwrap().is_none());
            assert_eq!(*closed.lock().unwrap(), vec![(ID_A.to_owned(), reason, true)]);
            assert!(register_confirmation(&slot, ID_B, Instant::now() + CONFIRM_TTL).is_ok());
        }
    }

    #[test]
    fn completed_cleanup_does_not_duplicate_the_decision_or_leave_pending_state() {
        let slot = Mutex::new(None);
        let closed = Mutex::new(Vec::new());
        let now = Instant::now();
        let mut receiver = register_confirmation(&slot, ID_A, now + CONFIRM_TTL).unwrap();
        let cleanup = ConfirmationCleanup { slot: &slot, id: ID_A.to_owned(), reason: "completed", occluded: true,
            closed: Some(|id: &str, reason, restore| closed.lock().unwrap().push((id.to_owned(), reason, restore))) };
        resolve_pending(&slot, ID_A, true, now);
        assert_eq!(receiver.try_recv().unwrap(), Decision::Approved);
        drop(cleanup);
        assert!(slot.lock().unwrap().is_none());
        assert_eq!(*closed.lock().unwrap(), vec![(ID_A.to_owned(), "completed", true)]);
    }

    #[test]
    fn late_cleanup_and_reply_cannot_remove_or_unocclude_a_new_request() {
        let slot = Mutex::new(None);
        let closed = Mutex::new(Vec::new());
        let now = Instant::now();
        let _old = register_confirmation(&slot, ID_A, now + CONFIRM_TTL).unwrap();
        let cleanup = ConfirmationCleanup { slot: &slot, id: ID_A.to_owned(), reason: "cancelled", occluded: true,
            closed: Some(|id: &str, reason, restore| closed.lock().unwrap().push((id.to_owned(), reason, restore))) };
        *slot.lock().unwrap() = None;
        let mut new = register_confirmation(&slot, ID_B, now + CONFIRM_TTL).unwrap();
        drop(cleanup);
        resolve_pending(&slot, ID_A, true, now);
        assert_eq!(new.try_recv().unwrap_err(), tokio::sync::oneshot::error::TryRecvError::Empty);
        assert_eq!(*closed.lock().unwrap(), vec![(ID_A.to_owned(), "cancelled", false)]);
        resolve_pending(&slot, ID_B, true, now);
        assert_eq!(new.try_recv().unwrap(), Decision::Approved);
    }
}

#[cfg(test)]
mod fee_tests {
    use super::*;
    use std::{cell::Cell, future::ready};

    const ADDRESS: &str = "0x1111111111111111111111111111111111111111";

    fn fixture(now: Instant) -> PreparedTransaction {
        PreparedTransaction {
            chain_id: 80002, endpoint: "https://frozen.invalid".into(), from: ADDRESS.into(), nonce: 7,
            to: ADDRESS.into(), to_bytes: [0x11; 20], value: 100, data_hex: "0x1234".into(), data: vec![0x12, 0x34],
            fees: execution_fees(21000, 20_000_000_000, 2_000_000_000, 100).unwrap(), deadline: now + CONFIRM_TTL,
        }
    }

    fn reply(method: &str) -> Result<Value, String> {
        Ok(json!(match method {
            "eth_chainId" => "0x13882",
            "eth_getTransactionCount" => "0x7",
            "eth_gasPrice" => "0x4a817c800",
            "eth_maxPriorityFeePerGas" => "0x77359400",
            "eth_estimateGas" => "0x5208",
            _ => panic!("unexpected RPC"),
        }))
    }

    #[test]
    fn fees_match_independent_literal_rlp_reference_and_decimal_cap() {
        let prepared = fixture(Instant::now());
        assert_eq!(hex_encode(&unsigned_prepared(&prepared)), "0x02ed830138820784773594008509c765240082627094111111111111111111111111111111111111111164821234c0");
        assert_eq!(prepared.fees.gas_limit, 25200);
        assert_eq!(prepared.fees.max_fee, 42_000_000_000);
        assert_eq!(prepared.fees.execution_cap, 1_058_400_000_000_000);
        assert_eq!(prepared.fees.value_and_execution_cap, 1_058_400_000_000_100);
        assert_eq!(native_amount(prepared.fees.execution_cap), "0.001058400000000000");
        assert_eq!(native_amount(u128::MAX), "340282366920938463463.374607431768211455");
        assert_eq!(native_amount(1), "0.000000000000000001");
    }

    #[test]
    fn signature_scalars_use_canonical_integer_rlp_without_changing_prepared_fields() {
        assert_eq!(rlp_integer_bytes(&[]), vec![0x80]);
        assert_eq!(rlp_integer_bytes(&[0; 32]), vec![0x80]);
        let mut one = [0; 32];
        one[31] = 1;
        assert_eq!(rlp_integer_bytes(&one), vec![1]);
        assert_eq!(rlp_integer_bytes(&[0, 0x80]), vec![0x81, 0x80]);
        assert_eq!(rlp_integer_bytes(&[0xff; 32]), [vec![0xa0], vec![0xff; 32]].concat());
        let prepared = fixture(Instant::now());
        let fields = signed_prepared_fields(&prepared, &[0, 0x80], &one, true);
        assert_eq!(&fields[..9], prepared_fields(&prepared));
        assert_eq!(&fields[9..], &[vec![1], vec![0x81, 0x80], vec![1]]);
        let mut s_scalar = [0; 32];
        s_scalar[31] = 0x80;
        let reference_fields = signed_prepared_fields(&prepared, &one, &s_scalar, true);
        assert_eq!(hex_encode(&[vec![0x02], rlp_list(&reference_fields)].concat()), "0x02f1830138820784773594008509c765240082627094111111111111111111111111111111111111111164821234c001018180");
        let zero_fields = signed_prepared_fields(&prepared, &[0; 32], &[0; 32], false);
        assert_eq!(&zero_fields[..9], prepared_fields(&prepared));
        assert_eq!(&zero_fields[9..], &[vec![0x80], vec![0x80], vec![0x80]]);
    }

    #[test]
    fn fee_widths_rounding_and_all_overflows_fail_closed() {
        assert_eq!(execution_fees(1, 1, 0, 0).unwrap().gas_limit, 2);
        let largest = ((u128::from(u64::MAX) * 5) / 6) as u64;
        assert_eq!(execution_fees(largest, 1, 0, 0).unwrap().gas_limit, u64::MAX);
        for (gas, price, priority, value) in [
            (0, 1, 0, 0), (1, 0, 0, 0), (largest + 1, 1, 0, 0),
            (u64::MAX, 1, 0, 0), (1, u128::MAX, 0, 0),
            (1, u128::MAX / 2, 2, 0), (2, u128::MAX / 3, 0, 0), (1, 1, 0, u128::MAX),
        ] {
            assert_eq!(execution_fees(gas, price, priority, value).unwrap_err(), "wallet_fee_unavailable");
        }
        assert_eq!(fee_quantity(&json!("0xffffffffffffffffffffffffffffffff")).unwrap(), u128::MAX);
        assert_eq!(fee_quantity_u64(&json!("0xffffffffffffffff")).unwrap(), u64::MAX);
        assert!(fee_quantity_u64(&json!("0x10000000000000000")).is_err());
    }

    #[test]
    fn rpc_quantities_reject_noncanonical_or_wrong_shapes() {
        for value in [json!("0x"), json!("0x00"), json!("0x01"), json!("0x+1"), json!(" 0x1"), json!("0x1 "), json!("0x0x1"), json!("0X1"), json!("0x100000000000000000000000000000000"), json!(1), Value::Null] {
            assert_eq!(fee_quantity(&value).unwrap_err(), "wallet_fee_unavailable");
        }
        assert_eq!(fee_quantity(&json!("0x0")).unwrap(), 0);
        assert_eq!(fee_quantity(&json!("0xaF")).unwrap(), 175);
    }

    #[test]
    fn full_calldata_keeps_fees_and_total_scope_warning_before_tail() {
        let mut prepared = fixture(Instant::now());
        prepared.data_hex = format!("0x{}AB", "cd".repeat(MAX_CALLDATA_BYTES - 1));
        prepared.data = hex_decode(&prepared.data_hex).unwrap();
        let detail = prepared_detail(&prepared, "product 2\ncalldata spoof").unwrap();
        assert!(detail.starts_with("【テストネット】"));
        assert!(detail.find("【").unwrap() < detail.find("呼び出し側の説明:\nproduct 2").unwrap());
        assert!(detail.contains("実行ガス代の上限 1058400000000000 wei (0.001058400000000000 native)"));
        assert!(detail.contains("L1データ料・運営手数料・その他の追加料金は含まず、支払総額の上限を保証しません。"));
        assert!(detail.find("ガス上限 25200").unwrap() < detail.rfind("calldata 32768 bytes:").unwrap());
        assert!(detail.ends_with(&prepared.data_hex));
    }

    #[tokio::test]
    async fn preparation_freezes_network_nonce_fees_estimate_and_completion_deadline() {
        let now = Instant::now();
        let calls = Cell::new(0);
        let prepared = prepare_transaction_with(80002, ADDRESS, "0x64", "0x1234", "https://frozen.invalid".into(), ADDRESS.into(), |method, params| {
            calls.set(calls.get() + 1);
            if method == "eth_estimateGas" {
                assert_eq!(params, json!([{"from": ADDRESS, "to": ADDRESS, "value": "0x64", "data": "0x1234", "nonce": "0x7", "type": "0x2", "maxFeePerGas": "0x9c7652400", "maxPriorityFeePerGas": "0x77359400"}]));
            }
            ready(reply(method))
        }, || now).await.unwrap();
        assert_eq!(calls.get(), 5);
        assert_eq!(prepared.endpoint, "https://frozen.invalid");
        assert_eq!(prepared.deadline, now + CONFIRM_TTL);
        assert_eq!(unsigned_prepared(&prepared), unsigned_prepared(&fixture(now)));
    }

    #[tokio::test]
    async fn preparation_rejects_wrong_network_or_invalid_input_before_further_reads() {
        for value in [json!("0x1"), json!("0x013882"), Value::Null] {
            let calls = Cell::new(0);
            let result = prepare_transaction_with(80002, ADDRESS, "0x64", "0x", "fixed".into(), ADDRESS.into(), |method, _| {
                calls.set(calls.get() + 1);
                assert_eq!(method, "eth_chainId");
                ready(Ok(value.clone()))
            }, Instant::now).await;
            assert_eq!(result.err().unwrap(), "wallet_fee_unavailable");
            assert_eq!(calls.get(), 1);
        }
        let calls = Cell::new(0);
        let result = prepare_transaction_with(80002, ADDRESS, "0x01", "0x", "fixed".into(), ADDRESS.into(), |method, _| {
            calls.set(calls.get() + 1); ready(reply(method))
        }, Instant::now).await;
        assert_eq!(result.err().unwrap(), "wallet_params_invalid");
        assert_eq!(calls.get(), 0);
    }

    #[tokio::test]
    async fn unavailable_gas_price_never_reaches_estimation_or_execution() {
        for price in [Err("offline".into()), Ok(json!("0x0")), Ok(json!("0x01"))] {
            let estimate_calls = Cell::new(0);
            let result = prepare_transaction_with(80002, ADDRESS, "0x0", "0x", "fixed".into(), ADDRESS.into(), |method, _| {
                if method == "eth_estimateGas" { estimate_calls.set(estimate_calls.get() + 1); }
                ready(if method == "eth_gasPrice" { price.clone() } else { reply(method) })
            }, Instant::now).await;
            assert_eq!(result.err().unwrap(), "wallet_fee_unavailable");
            assert_eq!(estimate_calls.get(), 0);
        }
        let prepared = prepare_transaction_with(80002, ADDRESS, "0x0", "0x", "fixed".into(), ADDRESS.into(), |method, _| {
            ready(if method == "eth_maxPriorityFeePerGas" { Err("offline".into()) } else { reply(method) })
        }, Instant::now).await.unwrap();
        assert_eq!(prepared.fees.priority, 4_000_000_000);
        assert_eq!(prepared.fees.max_fee, 44_000_000_000);
    }

    #[tokio::test]
    async fn expiration_during_postapproval_read_prevents_sign_and_submit() {
        let start = Instant::now();
        let prepared = fixture(start);
        let reads = Cell::new(0);
        let clocks = Cell::new(0);
        let signs = Cell::new(0);
        let submits = Cell::new(0);
        let result = execute_prepared(&prepared, || {
            reads.set(reads.get() + 1); ready(Ok((ADDRESS.into(), 7)))
        }, |_| { signs.set(signs.get() + 1); vec![] }, |_| {
            submits.set(submits.get() + 1); ready(Ok("hash".into()))
        }, || { let call = clocks.get(); clocks.set(call + 1); if call == 0 { start } else { prepared.deadline } }).await;
        assert_eq!(result.unwrap_err(), "wallet_fee_expired");
        assert_eq!((reads.get(), signs.get(), submits.get()), (1, 0, 0));
    }

    #[tokio::test]
    async fn stale_unavailable_and_already_expired_never_sign_or_submit() {
        let start = Instant::now();
        let prepared = fixture(start);
        for (current, clock, expected, read_count) in [
            (Ok((ADDRESS.into(), 8)), start, "wallet_fee_stale", 1),
            (Ok(("changed sender".into(), 7)), start, "wallet_fee_stale", 1),
            (Err("offline".into()), start, "wallet_fee_unavailable", 1),
            (Ok((ADDRESS.into(), 7)), prepared.deadline, "wallet_fee_expired", 0),
        ] {
            let reads = Cell::new(0);
            let signs = Cell::new(0);
            let submits = Cell::new(0);
            let result = execute_prepared(&prepared, || { reads.set(reads.get() + 1); ready(current) }, |_| { signs.set(signs.get() + 1); vec![] }, |_| { submits.set(submits.get() + 1); ready(Ok("hash".into())) }, || clock).await;
            assert_eq!(result.unwrap_err(), expected);
            assert_eq!((reads.get(), signs.get(), submits.get()), (read_count, 0, 0));
        }
    }

    #[tokio::test]
    async fn successful_gate_uses_snapshot_once_and_postsign_errors_are_never_retry_codes() {
        let start = Instant::now();
        let prepared = fixture(start);
        for error in ["wallet_fee_unavailable", "wallet_fee_expired", "wallet_fee_stale", "rpc:unknown"] {
            let signs = Cell::new(0);
            let submits = Cell::new(0);
            let result = execute_prepared(&prepared, || ready(Ok((ADDRESS.into(), 7))), |snapshot| {
                signs.set(signs.get() + 1);
                assert_eq!(snapshot.endpoint, "https://frozen.invalid");
                unsigned_prepared(snapshot)
            }, |raw| { submits.set(submits.get() + 1); assert_eq!(raw, unsigned_prepared(&prepared)); ready(Err(error.into())) }, || start).await;
            assert_eq!(result.unwrap_err(), if error.starts_with("wallet_fee_") { "rpc_unavailable" } else { error });
            assert_eq!((signs.get(), submits.get()), (1, 1));
        }
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::checkpoint::CheckpointStore;
    use std::{cell::Cell, future::ready, path::PathBuf};

    const SCOPE: &str = "https://commerce.example";
    const ADDRESS: &str = "0x1111111111111111111111111111111111111111";

    struct Fixture { directory: PathBuf, store: CheckpointStore }
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!("hub-wallet-recovery-{}", uuid::Uuid::new_v4()));
            let store = CheckpointStore::test(directory.clone(), [29; 32]);
            Self { directory, store }
        }
        fn path(&self) -> PathBuf { self.directory.join(format!("{TRANSACTION_INDEX_ID}.jkcp")) }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.directory); }
    }

    fn prepared(now: Instant) -> PreparedTransaction {
        PreparedTransaction { chain_id: 80002, endpoint: "https://frozen.invalid".into(), from: ADDRESS.into(), nonce: 7,
            to: ADDRESS.into(), to_bytes: [0x11; 20], value: 100, data_hex: "0x1234".into(), data: vec![0x12, 0x34],
            fees: execution_fees(21000, 20_000_000_000, 2_000_000_000, 100).unwrap(), deadline: now + CONFIRM_TTL }
    }
    fn empty() -> TransactionIndex { TransactionIndex { version: 1, records: Vec::new() } }
    fn raw() -> Vec<u8> { vec![0x02, 0xf1, 0x80, 0x01, 0x81, 0x80] }
    fn saved_record() -> TransactionRecord { transaction_record(&prepared(Instant::now()), SCOPE, "order_1", "payment", hex_encode(&keccak256(&raw()))).unwrap() }

    #[test]
    fn recovery_context_and_minimal_record_are_strict() {
        assert_eq!(hex_encode(&keccak256(&raw())), "0x781332c0195889868bf4fabaf6ab88b25a9fb5eea5af9a44b022019453dcbe6a");
        for scope in [SCOPE, "http://127.0.0.1:3020", "http://localhost:3020", "http://[::1]:3020"] { recovery_context(scope, "a_1-X", "payment").unwrap(); }
        for scope in ["http://remote.example", "https://commerce.example/", "https://commerce.example?q=x", "https://user@commerce.example", "https://commerce.example/path"] { assert!(recovery_context(scope, "order_1", "payment").is_err()); }
        for id in ["", "a b", "a/b", "日本", " x"] { assert!(recovery_context(SCOPE, id, "payment").is_err()); }
        assert!(recovery_context(SCOPE, &"a".repeat(201), "payment").is_err());
        recovery_context(SCOPE, &"a".repeat(200), "approval").unwrap();
        assert!(recovery_context(SCOPE, "order_1", "retry").is_err());
        let encoded = serde_json::to_value(saved_record()).unwrap();
        assert_eq!(encoded.as_object().unwrap().len(), 10);
        assert!(encoded.get("data").is_none() && encoded.get("raw").is_none() && encoded.get("key").is_none());
        assert_eq!(encoded["calldata_hash"], hex_encode(&keccak256(&[0x12, 0x34])));
        assert_eq!(encoded["value_hex"], "0x64");
    }

    #[tokio::test]
    async fn lost_broadcast_response_is_persisted_before_send_and_survives_reopen() {
        let fixture = Fixture::new();
        let now = Instant::now();
        let prepared = prepared(now);
        let mut index = load_transactions(&fixture.store).unwrap();
        let signs = Cell::new(0);
        let sends = Cell::new(0);
        let result = execute_recoverable(&mut index, &prepared, SCOPE, "order_1", "payment", || ready(Ok((ADDRESS.into(), 7))), |_| { signs.set(signs.get() + 1); raw() }, |index| save_transactions(&fixture.store, index), |bytes| {
            sends.set(sends.get() + 1);
            assert_eq!(bytes, raw());
            let durable = load_transactions(&fixture.store).unwrap();
            assert_eq!(durable.records[0].transaction_hash, hex_encode(&keccak256(&bytes)));
            ready(Err("rpc_unreachable".into()))
        }, || now).await;
        assert_eq!(result.unwrap_err(), "rpc_unreachable");
        assert_eq!((signs.get(), sends.get()), (1, 1));
        let reopened = CheckpointStore::test(fixture.directory.clone(), [29; 32]);
        let recovered = recovery_lookup(&load_transactions(&reopened).unwrap(), SCOPE, ADDRESS, "order_1", "payment");
        assert_eq!(recovered, json!({"orderId":"order_1", "phase":"payment", "chainId":80002, "transactionHash":hex_encode(&keccak256(&raw()))}));
        let encrypted = std::fs::read(fixture.path()).unwrap();
        assert!(!String::from_utf8_lossy(&encrypted).contains("order_1"));
    }

    #[tokio::test]
    async fn failed_persistence_prevents_broadcast_and_never_emits_fee_retry_code() {
        let now = Instant::now();
        let prepared = prepared(now);
        let mut index = empty();
        let signs = Cell::new(0);
        let sends = Cell::new(0);
        let result = execute_recoverable(&mut index, &prepared, SCOPE, "order_1", "payment", || ready(Ok((ADDRESS.into(), 7))), |_| { signs.set(signs.get() + 1); raw() }, |_| Err("disk failure".into()), |_| { sends.set(sends.get() + 1); ready(Ok("unused".into())) }, || now).await;
        assert_eq!(result.unwrap_err(), "wallet_recovery_unavailable");
        assert_eq!((signs.get(), sends.get()), (1, 0));
    }

    #[tokio::test]
    async fn mismatch_retains_local_hash_while_matching_response_returns_it() {
        for response in [0, 1, 2, 3] {
            let fixture = Fixture::new();
            let now = Instant::now();
            let prepared = prepared(now);
            let mut index = empty();
            let expected = hex_encode(&keccak256(&raw()));
            let result = execute_recoverable(&mut index, &prepared, SCOPE, "order_1", "payment", || ready(Ok((ADDRESS.into(), 7))), |_| raw(), |index| save_transactions(&fixture.store, index), |_| ready(Ok(match response { 1 => expected.clone(), 2 => format!("0x{}", expected[2..].to_ascii_uppercase()), 3 => format!("0X{}", &expected[2..]), _ => format!("0x{}", "f".repeat(64)) })), || now).await;
            if matches!(response, 1 | 2) { assert_eq!(result.unwrap(), expected); } else { assert_eq!(result.unwrap_err(), "wallet_recovery_hash_mismatch"); }
            assert_eq!(load_transactions(&fixture.store).unwrap().records[0].transaction_hash, expected);
        }
    }

    #[tokio::test]
    async fn existing_order_or_nonce_blocks_all_reads_signing_and_broadcast() {
        let now = Instant::now();
        let prepared = prepared(now);
        for (order, phase) in [("order_1", "payment"), ("different", "approval")] {
            let mut index = TransactionIndex { version: 1, records: vec![saved_record()] };
            let callbacks = Cell::new(0);
            let result = execute_recoverable(&mut index, &prepared, SCOPE, order, phase, || { callbacks.set(callbacks.get() + 1); ready(Ok((ADDRESS.into(), 7))) }, |_| { callbacks.set(callbacks.get() + 1); raw() }, |_| { callbacks.set(callbacks.get() + 1); Ok(()) }, |_| { callbacks.set(callbacks.get() + 1); ready(Ok("unused".into())) }, || now).await;
            assert_eq!(result.unwrap_err(), "wallet_recovery_pending");
            assert_eq!(callbacks.get(), 0);
        }
        let mut different_nonce = prepared;
        different_nonce.nonce = 8;
        assert_eq!(recovery_admission(&TransactionIndex { version: 1, records: vec![saved_record()] }, &different_nonce, SCOPE, "order_1", "payment").unwrap_err(), "wallet_recovery_pending");
    }

    #[test]
    fn lookup_is_origin_wallet_order_and_phase_scoped_and_absence_is_null() {
        let index = TransactionIndex { version: 1, records: vec![saved_record()] };
        for (scope, wallet, order, phase) in [("https://other.example", ADDRESS, "order_1", "payment"), (SCOPE, "0x2222222222222222222222222222222222222222", "order_1", "payment"), (SCOPE, ADDRESS, "other", "payment"), (SCOPE, ADDRESS, "order_1", "approval")] {
            assert_eq!(recovery_lookup(&index, scope, wallet, order, phase), json!({"orderId":order, "phase":phase, "chainId":null, "transactionHash":null}));
        }
        assert!(recovery_lookup(&index, SCOPE, ADDRESS, "order_1", "payment")["transactionHash"].is_string());
    }

    #[test]
    fn encrypted_store_rejects_corruption_wrong_key_oversize_and_unknown_fields() {
        let fixture = Fixture::new();
        let index = TransactionIndex { version: 1, records: vec![saved_record()] };
        save_transactions(&fixture.store, &index).unwrap();
        let wrong_key = CheckpointStore::test(fixture.directory.clone(), [30; 32]);
        assert_eq!(load_transactions(&wrong_key).err().unwrap(), "wallet_recovery_invalid");
        let mut damaged = std::fs::read(fixture.path()).unwrap();
        damaged[20] ^= 1;
        std::fs::write(fixture.path(), damaged).unwrap();
        assert_eq!(load_transactions(&fixture.store).err().unwrap(), "wallet_recovery_invalid");
        std::fs::write(fixture.path(), vec![0; TRANSACTION_MAX_BYTES + 30]).unwrap();
        assert_eq!(load_transactions(&fixture.store).err().unwrap(), "wallet_recovery_invalid");
        let mut encoded = serde_json::to_value(&index).unwrap();
        encoded["records"][0]["raw"] = json!("forbidden");
        fixture.store.save(TRANSACTION_INDEX_ID, &encoded).unwrap();
        assert_eq!(load_transactions(&fixture.store).err().unwrap(), "wallet_recovery_invalid");
    }

    #[test]
    fn invalid_metadata_duplicates_and_capacity_are_closed() {
        let fixture = Fixture::new();
        let valid = TransactionIndex { version: 1, records: vec![saved_record()] };
        for (field, value) in [("transaction_hash", json!("0x1")), ("calldata_hash", json!("0x0")), ("chain_id", json!(999)), ("value_hex", json!("0x00")), ("scope", json!("https://commerce.example/path")), ("nonce", json!(-1))] {
            let mut encoded = serde_json::to_value(&valid).unwrap();
            encoded["records"][0][field] = value;
            fixture.store.save(TRANSACTION_INDEX_ID, &encoded).unwrap();
            assert_eq!(load_transactions(&fixture.store).err().unwrap(), "wallet_recovery_invalid");
        }
        let duplicate = TransactionIndex { version: 1, records: vec![saved_record(), saved_record()] };
        assert_eq!(validate_transactions(&duplicate).unwrap_err(), "wallet_recovery_invalid");
        let records = (0..100).map(|nonce| { let mut record = saved_record(); record.nonce = nonce; record.order_id = format!("order_{nonce}"); record }).collect();
        let full = TransactionIndex { version: 1, records };
        save_transactions(&fixture.store, &full).unwrap();
        let mut prepared = prepared(Instant::now()); prepared.nonce = 101;
        assert_eq!(recovery_admission(&full, &prepared, SCOPE, "new_order", "payment").unwrap_err(), "wallet_recovery_limit");
        let large_scope = format!("https://{}.example", "a".repeat(2032));
        assert_eq!(large_scope.len(), 2048);
        let mut large = TransactionIndex { version: 1, records: (0..99).map(|offset| {
            let mut record = saved_record(); record.nonce = u64::MAX - offset;
            record.order_id = format!("{offset:020}{}", "a".repeat(180));
            record.scope = large_scope.clone(); record.value_hex = format!("0x{:x}", u128::MAX); record
        }).collect() };
        validate_transactions(&large).unwrap();
        assert!(serde_json::to_vec(&large).unwrap().len() > TRANSACTION_MAX_BYTES);
        assert_eq!(save_transactions(&fixture.store, &large).unwrap_err(), "wallet_recovery_limit");
        large.records.pop();
        assert!(serde_json::to_vec(&large).unwrap().len() <= TRANSACTION_MAX_BYTES);
        save_transactions(&fixture.store, &large).unwrap();
        prepared.nonce = 1; prepared.value = u128::MAX;
        assert_eq!(recovery_admission(&large, &prepared, &large_scope, &"b".repeat(200), "payment").unwrap_err(), "wallet_recovery_limit");
        large.version = 2;
        assert_eq!(validate_transactions(&large).unwrap_err(), "wallet_recovery_invalid");
    }

    #[tokio::test]
    async fn fee_expiration_preserves_presign_semantics_without_persist_or_send() {
        let now = Instant::now();
        let prepared = prepared(now);
        let mut index = empty();
        let callbacks = Cell::new(0);
        let result = execute_recoverable(&mut index, &prepared, SCOPE, "order_1", "payment", || { callbacks.set(callbacks.get() + 1); ready(Ok((ADDRESS.into(), 7))) }, |_| { callbacks.set(callbacks.get() + 1); raw() }, |_| { callbacks.set(callbacks.get() + 1); Ok(()) }, |_| { callbacks.set(callbacks.get() + 1); ready(Ok("unused".into())) }, || prepared.deadline).await;
        assert_eq!(result.unwrap_err(), "wallet_fee_expired");
        assert_eq!(callbacks.get(), 0);
        assert!(index.records.is_empty());
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;
    use std::{cell::RefCell, collections::VecDeque, future::ready};

    const SCOPE: &str = "https://commerce.example";
    const TOKEN: &str = "0x5656565656565656565656565656565656565656";
    const SPENDER: &str = "0x1212121212121212121212121212121212121212";
    const OWNER: &str = "0x3434343434343434343434343434343434343434";
    const APPROVE: &str = "0x095ea7b300000000000000000000000012121212121212121212121212121212121212120000000000000000000000000000000000000000000000000000000000000064";
    const ALLOWANCE: &str = "0xdd62ed3e00000000000000000000000034343434343434343434343434343434343434340000000000000000000000001212121212121212121212121212121212121212";

    fn hash() -> String { format!("0x{}", "a".repeat(64)) }
    fn block_hash() -> String { format!("0x{}", "b".repeat(64)) }
    fn index() -> TransactionIndex {
        TransactionIndex { version: 1, records: vec![TransactionRecord {
            scope: SCOPE.into(), order_id: "order_1".into(), phase: "approval".into(), chain_id: 80002,
            from: OWNER.into(), nonce: 7, target: TOKEN.into(), value_hex: "0x0".into(),
            calldata_hash: "0x148f157a199fd784cdcea9c61339ea6ab04562ab590b1bcd05efb72d806b77f6".into(), transaction_hash: hash(), resolved: false, reverted: false, escrow_split: None,
        }] }
    }
    fn receipt() -> Value { json!({"transactionHash":hash(), "from":OWNER, "to":TOKEN, "blockNumber":"0x9", "blockHash":block_hash(), "status":"0x1"}) }
    fn replies() -> Vec<Result<Value, String>> {
        vec![Ok(json!("0x13882")), Ok(json!({"hash":hash(), "from":OWNER, "to":TOKEN, "value":"0x0", "nonce":"0x7", "input":APPROVE})), Ok(receipt()), Ok(json!({"number":"0x9", "hash":block_hash()})), Ok(json!("0x0000000000000000000000000000000000000000000000000000000000000064")), Ok(receipt())]
    }
    async fn inspect(index: &TransactionIndex, responses: Vec<Result<Value, String>>, current: &str) -> (Result<Value, String>, Vec<(&'static str, Value)>) {
        let queue = RefCell::new(VecDeque::from(responses));
        let calls = RefCell::new(Vec::new());
        let result = check_approval_with(index, SCOPE, "order_1", 80002, TOKEN, SPENDER, "100", APPROVE, OWNER, |method, params| {
            calls.borrow_mut().push((method, params));
            ready(queue.borrow_mut().pop_front().expect("unexpected RPC"))
        }, || Ok(current.into())).await;
        (result, calls.into_inner())
    }

    #[test]
    fn canonical_amount_and_abi_match_independent_viem_reference() {
        let input = approval_input(80002, TOKEN, SPENDER, "100", APPROVE).unwrap();
        assert_eq!(hex_encode(&input.data), APPROVE);
        assert_eq!(hex_encode(&keccak256(&input.data)), "0x148f157a199fd784cdcea9c61339ea6ab04562ab590b1bcd05efb72d806b77f6");
        for amount in ["0", "01", "+1", "-1", " 100", "100 ", "１00", "0x64", "340282366920938463463374607431768211456"] { assert!(approval_input(80002, TOKEN, SPENDER, amount, APPROVE).is_err()); }
        let max_data = format!("0x095ea7b3{}{}{}{:032x}", "0".repeat(24), &SPENDER[2..], "0".repeat(32), u128::MAX);
        let max = approval_input(80002, TOKEN, SPENDER, &u128::MAX.to_string(), &max_data).unwrap();
        assert_eq!(&max.amount[..16], &[0; 16]); assert_eq!(&max.amount[16..], &[0xff; 16]);
        for data in [APPROVE.replacen("095ea7b3", "deadbeef", 1), APPROVE.replacen("000000000000000000000000", "100000000000000000000000", 1), format!("{APPROVE}00"), APPROVE[..APPROVE.len()-2].into(), APPROVE.replacen("0x", "0X", 1)] { assert!(approval_input(80002, TOKEN, SPENDER, "100", &data).is_err()); }
        assert!(approval_input(80002, TOKEN, OWNER, "100", APPROVE).is_err());
        assert!(approval_input(999, TOKEN, SPENDER, "100", APPROVE).is_err());
    }

    #[tokio::test]
    async fn ready_uses_exact_read_only_allowance_call_and_full_uint256_comparison() {
        for allowance in [format!("0x{:064x}", 100), format!("0x{}", "f".repeat(64)), format!("0x1{}", "0".repeat(63))] {
            let mut responses = replies(); responses[4] = Ok(json!(allowance));
            let (result, calls) = inspect(&index(), responses, OWNER).await;
            assert_eq!(result.unwrap(), json!({"orderId":"order_1", "chainId":80002, "approvalHash":hash(), "status":"ready"}));
            assert_eq!(calls.iter().map(|call| call.0).collect::<Vec<_>>(), ["eth_chainId", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_call", "eth_getTransactionReceipt"]);
            assert_eq!(calls[4].1, json!([{"to":TOKEN, "data":ALLOWANCE}, "latest"]));
        }
    }

    #[tokio::test]
    async fn pending_failed_insufficient_and_missing_never_claim_ready() {
        let mut pending = replies(); pending[2] = Ok(Value::Null); pending.truncate(3);
        let (result, calls) = inspect(&index(), pending, OWNER).await;
        assert_eq!(result.unwrap()["status"], "pending"); assert_eq!(calls.len(), 3);
        let mut failed = replies(); failed[2].as_mut().unwrap()["status"] = json!("0x0"); failed.truncate(3);
        assert_eq!(inspect(&index(), failed, OWNER).await.0.unwrap()["status"], "failed");
        let mut insufficient = replies(); insufficient[4] = Ok(json!(format!("0x{:064x}", 99)));
        assert_eq!(inspect(&index(), insufficient, OWNER).await.0.unwrap()["status"], "insufficient");
        let (missing, calls) = inspect(&TransactionIndex { version: 1, records: vec![] }, vec![], OWNER).await;
        assert_eq!(missing.unwrap(), json!({"orderId":"order_1", "chainId":80002, "approvalHash":null, "status":"missing"})); assert!(calls.is_empty());
    }

    #[tokio::test]
    async fn payment_and_journal_binding_fail_before_any_rpc() {
        for field in ["payment", "chain", "target", "value", "digest", "duplicate"] {
            let mut journal = index();
            match field { "payment" => journal.records[0].phase = "payment".into(), "chain" => journal.records[0].chain_id = 1, "target" => journal.records[0].target = OWNER.into(), "value" => journal.records[0].value_hex = "0x1".into(), "digest" => journal.records[0].calldata_hash = format!("0x{}", "c".repeat(64)), _ => journal.records.push(index().records.remove(0)) }
            let (result, calls) = inspect(&journal, vec![], OWNER).await;
            assert!(result.is_err(), "{field}"); assert!(calls.is_empty());
        }
        for isolated in ["scope", "wallet", "order"] {
            let mut journal = index();
            match isolated { "scope" => journal.records[0].scope = "https://other.example".into(), "wallet" => journal.records[0].from = TOKEN.into(), _ => journal.records[0].order_id = "other".into() }
            let (result, calls) = inspect(&journal, vec![], OWNER).await;
            assert_eq!(result.unwrap()["status"], "missing"); assert!(calls.is_empty());
        }
    }

    #[tokio::test]
    async fn wrong_rpc_chain_and_transaction_identity_are_rejected() {
        let mut wrong_chain = replies(); wrong_chain[0] = Ok(json!("0x1"));
        assert!(inspect(&index(), wrong_chain, OWNER).await.0.is_err());
        for (field, value) in [("hash", json!(block_hash())), ("from", json!(TOKEN)), ("to", json!(OWNER)), ("value", json!("0x1")), ("nonce", json!("0x8")), ("nonce", json!("0x07")), ("input", json!("0x")), ("input", Value::Null)] {
            let mut responses = replies(); responses[1].as_mut().unwrap()[field] = value;
            let (result, calls) = inspect(&index(), responses, OWNER).await;
            assert!(result.is_err(), "{field}"); assert_eq!(calls.len(), 2);
        }
        let mut absent = replies(); absent[1] = Ok(Value::Null);
        assert!(inspect(&index(), absent, OWNER).await.0.is_err());
    }

    #[tokio::test]
    async fn receipt_fields_and_inclusion_block_must_match() {
        for (field, value) in [("transactionHash", json!(block_hash())), ("from", json!(TOKEN)), ("to", json!(OWNER)), ("blockHash", Value::Null), ("blockNumber", json!("0x09")), ("status", json!("0x2")), ("status", Value::Null)] {
            let mut responses = replies(); responses[2].as_mut().unwrap()[field] = value;
            assert!(inspect(&index(), responses, OWNER).await.0.is_err(), "{field}");
        }
        for (field, value) in [("hash", json!(hash())), ("number", json!("0xa")), ("hash", Value::Null)] {
            let mut responses = replies(); responses[3].as_mut().unwrap()[field] = value;
            assert!(inspect(&index(), responses, OWNER).await.0.is_err(), "block {field}");
        }
    }

    #[tokio::test]
    async fn allowance_is_exactly_32_bytes_without_prefix_or_width_fallback() {
        for value in [json!("0x64"), json!(format!("0x{}", "f".repeat(66))), json!(format!("0X{}", "0".repeat(64))), json!(format!("0x{} ", "0".repeat(64))), Value::Null, json!(100)] {
            let mut responses = replies(); responses[4] = Ok(value);
            assert!(inspect(&index(), responses, OWNER).await.0.is_err());
        }
    }

    #[tokio::test]
    async fn receipt_replacement_and_wallet_switch_after_reads_are_rejected() {
        for (field, value) in [("blockHash", json!(hash())), ("blockNumber", json!("0xa")), ("status", json!("0x0")), ("transactionHash", json!(block_hash()))] {
            let mut responses = replies(); responses[5].as_mut().unwrap()[field] = value;
            assert!(inspect(&index(), responses, OWNER).await.0.is_err());
        }
        let mut vanished = replies(); vanished[5] = Ok(Value::Null);
        assert!(inspect(&index(), vanished, OWNER).await.0.is_err());
        let (changed, calls) = inspect(&index(), replies(), TOKEN).await;
        assert_eq!(changed.unwrap_err(), "wallet_approval_mismatch"); assert_eq!(calls.len(), 6);
    }

    #[tokio::test]
    async fn rpc_failure_at_every_stage_is_unavailable_without_fallback() {
        for position in 0..6 {
            let mut responses = replies(); responses[position] = Err("offline".into());
            let (result, calls) = inspect(&index(), responses, OWNER).await;
            assert_eq!(result.unwrap_err(), "wallet_approval_unavailable"); assert_eq!(calls.len(), position + 1);
        }
    }
}

#[cfg(test)]
mod escrow_tests {
    use super::*;
    use crate::checkpoint::CheckpointStore;
    use std::{cell::Cell, future::ready, path::PathBuf};

    const SCOPE: &str = "https://commerce.example";
    const OWNER: &str = "0x3434343434343434343434343434343434343434";
    const TARGET: &str = "0x5656565656565656565656565656565656565656";
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    const NEXT: &str = "00000000-0000-4000-8000-000000000002";
    fn phase(role: &str, action: &str, id: &str) -> String { format!("escrow:{role}:{action}:{id}") }
    fn word(value: u128) -> Vec<u8> { [vec![0; 16], value.to_be_bytes().to_vec()].concat() }
    fn data(selector: &str, tail: Vec<u8>) -> Vec<u8> { [hex_decode(selector).unwrap(), vec![0x11; 32], tail].concat() }
    fn prepared(data: Vec<u8>, nonce: u64) -> PreparedTransaction {
        PreparedTransaction { chain_id: 80002, endpoint: "https://frozen.invalid".into(), from: OWNER.into(), nonce, to: TARGET.into(), to_bytes: [0x56; 20], value: 0,
            data_hex: hex_encode(&data), data, fees: execution_fees(21000, 20_000_000_000, 2_000_000_000, 0).unwrap(), deadline: Instant::now() + CONFIRM_TTL }
    }
    fn record() -> TransactionRecord { transaction_record(&prepared(data("f08ef6cb", vec![]), 7), SCOPE, "order_1", &phase("buyer", "dispute", ID), format!("0x{}", "a".repeat(64))).unwrap() }
    fn index() -> TransactionIndex { TransactionIndex { version: 1, records: vec![record()] } }
    fn detail(record: &TransactionRecord, status: &str) -> Value {
        let (role, action) = escrow_phase(&record.phase).unwrap();
        json!({"order":{"id":record.order_id,"chainId":record.chain_id},"physicalEscrow":{"contractAddress":record.target},"escrowSubmissions":[{"actorRole":role,"action":action,"transactionHash":record.transaction_hash,"status":status}]})
    }
    struct Fixture { directory: PathBuf, store: CheckpointStore }
    impl Fixture {
        fn new() -> Self { let directory = std::env::temp_dir().join(format!("hub-wallet-escrow-{}", uuid::Uuid::new_v4())); let store = CheckpointStore::test(directory.clone(), [37; 32]); Self { directory, store } }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.directory); } }

    #[test]
    fn all_fourteen_role_actions_use_independent_selector_literals_and_strict_phase() {
        for (role, action, selector) in [("buyer","confirm","34539694"),("buyer","release","a42f2b0c"),("buyer","refund_unshipped","9006b145"),("buyer","dispute","f08ef6cb"),("buyer","propose_resolution","878d683d"),("buyer","accept_resolution","2739489e"),("buyer","finalize_expired_dispute","9d63a591"),("seller","ship","93ef8d21"),("seller","release","a42f2b0c"),("seller","refund_by_seller","6c5be2a8"),("seller","dispute","f08ef6cb"),("seller","propose_resolution","878d683d"),("seller","accept_resolution","2739489e"),("seller","finalize_expired_dispute","9d63a591")] {
            let tail = match action { "propose_resolution" => [word(0), word(100)].concat(), "accept_resolution" => [word(40), word(60), word(u64::MAX as u128), vec![0x22; 32]].concat(), _ => vec![] };
            let phase = phase(role, action, ID);
            assert_eq!(escrow_role(&phase).unwrap(), role);
            escrow_data(&phase, 0, &data(selector, tail)).unwrap();
        }
        for bad in [phase("buyer","ship",ID),phase("seller","confirm",ID),phase("buyer","resolve",ID),phase("Buyer","dispute",ID),format!("{}:extra",phase("buyer","dispute",ID)),phase("buyer","dispute","00000000-0000-1000-8000-000000000001"),phase("buyer","dispute","00000000-0000-4000-7000-000000000001"),phase("buyer","dispute","00000000-0000-4000-c000-000000000001")] { assert!(escrow_role(&bad).is_err(), "{bad}"); }
        for variant in ["8000","9000","a000","b000"] { escrow_role(&phase("buyer","dispute",&format!("00000000-0000-4000-{variant}-000000000001"))).unwrap(); }
    }

    #[test]
    fn abi_size_selector_uint_widths_and_actual_split_are_checked() {
        let propose = phase("buyer", "propose_resolution", ID);
        assert_eq!(escrow_data(&propose, 0, &data("878d683d", [word(3),word(7)].concat())).unwrap(), Some(["3".into(),"7".into()]));
        escrow_data(&propose, 0, &data("878d683d", [word(u128::MAX),word(0)].concat())).unwrap();
        for split in [[word(0),word(0)].concat(), [word(u128::MAX),word(1)].concat()] { assert!(escrow_data(&propose, 0, &data("878d683d",split)).is_err()); }
        let good = data("878d683d",[word(3),word(7)].concat());
        for bad in [vec![],good[..99].to_vec(),[good.clone(),vec![0]].concat(),data("2739489e",[word(3),word(7)].concat())] { assert!(escrow_data(&propose,0,&bad).is_err()); }
        assert!(escrow_data(&propose,1,&good).is_err());
        let mut wide = good; wide[36] = 1; assert!(escrow_data(&propose,0,&wide).is_err());
        let accept = phase("seller","accept_resolution",ID);
        let mut wide_version = data("2739489e",[word(3),word(7),word(u64::MAX as u128),vec![0x22;32]].concat());
        escrow_data(&accept,0,&wide_version).unwrap(); wide_version[123] = 1; assert!(escrow_data(&accept,0,&wide_version).is_err());
        for pair in [["01","1"],["-1","1"],["0","0"],[" 0","1"]] { assert!(validate_escrow_split(&pair.map(String::from)).is_err()); }
    }

    #[test]
    fn legacy_serialization_defaults_and_escrow_pending_shapes_remain_compatible() {
        let legacy = transaction_record(&prepared(vec![],7),SCOPE,"order_1","payment",format!("0x{}","a".repeat(64))).unwrap();
        let encoded = serde_json::to_value(&legacy).unwrap(); assert_eq!(encoded.as_object().unwrap().len(),10);
        let loaded: TransactionRecord = serde_json::from_value(encoded).unwrap(); assert!(!loaded.resolved && loaded.escrow_split.is_none());
        let phase = phase("buyer","propose_resolution",ID);
        let proposal = transaction_record(&prepared(data("878d683d",[word(3),word(7)].concat()),8),SCOPE,"order_1",&phase,format!("0x{}","b".repeat(64))).unwrap();
        let journal = TransactionIndex { version:1, records:vec![proposal] };
        assert_eq!(escrow_pending_value(&journal,SCOPE,"order_1",OWNER).unwrap(),json!({"orderId":"order_1","operations":[{"phase":phase,"role":"buyer","action":"propose_resolution","chainId":80002,"transactionHash":format!("0x{}","b".repeat(64)),"extra":{"buyerAmountAtomic":"3","sellerAmountAtomic":"7"}}]}));
        assert_eq!(escrow_pending_value(&journal,"https://other.example","order_1",OWNER).unwrap()["operations"],json!([]));
        assert_eq!(escrow_pending_value(&journal,SCOPE,"other",OWNER).unwrap()["operations"],json!([]));
        assert_eq!(escrow_pending_value(&journal,SCOPE,"order_1",TARGET).unwrap()["operations"],json!([]));
        let mut legacy = loaded; legacy.resolved=true; assert!(!escrow_record_valid(&legacy));
        legacy.resolved=false; legacy.escrow_split=Some(["0".into(),"1".into()]); assert!(!escrow_record_valid(&legacy));
    }

    #[test]
    fn unresolved_order_blocks_cross_role_action_and_resolved_history_keeps_nonce_and_phase() {
        let mut journal = index();
        let next_phase=phase("seller","ship",NEXT);
        let mut next = prepared(data("93ef8d21",vec![]),8);
        assert_eq!(recovery_admission(&journal,&next,SCOPE,"order_1",&next_phase).unwrap_err(),"wallet_recovery_pending");
        journal.records.push(transaction_record(&next,SCOPE,"order_1",&next_phase,format!("0x{}","b".repeat(64))).unwrap());
        assert!(validate_transactions(&journal).is_err()); journal.records.pop();
        journal.records[0].resolved=true;
        recovery_admission(&journal,&next,SCOPE,"order_1",&next_phase).unwrap();
        next.nonce=7; assert_eq!(recovery_admission(&journal,&next,SCOPE,"order_1",&next_phase).unwrap_err(),"wallet_recovery_pending");
        let old=prepared(data("f08ef6cb",vec![]),8);
        assert_eq!(recovery_admission(&journal,&old,SCOPE,"order_1",&phase("buyer","dispute",ID)).unwrap_err(),"wallet_recovery_pending");
        assert_eq!(escrow_pending_value(&journal,SCOPE,"order_1",OWNER).unwrap()["operations"],json!([]));
    }

    #[tokio::test]
    async fn confirmed_finish_saves_before_return_and_fresh_uuid_can_repeat_after_restart() {
        let fixture=Fixture::new();
        let initial_phase=phase("buyer","propose_resolution",ID);
        let proposal=transaction_record(&prepared(data("878d683d",[word(3),word(7)].concat()),7),SCOPE,"order_1",&initial_phase,format!("0x{}","a".repeat(64))).unwrap();
        let mut journal=TransactionIndex{version:1,records:vec![proposal]}; save_transactions(&fixture.store,&journal).unwrap();
        let current_phase=journal.records[0].phase.clone(); let proof=detail(&journal.records[0],"confirmed");
        for _ in 0..2 {
            let result=finish_escrow_with(&mut journal,SCOPE,"order_1",&current_phase,OWNER,||ready(Ok(proof.clone())),||Ok(OWNER.into()),|index|save_transactions(&fixture.store,index)).await.unwrap();
            assert_eq!(result,json!({"orderId":"order_1","phase":current_phase,"transactionHash":format!("0x{}","a".repeat(64)),"resolved":true}));
            assert!(load_transactions(&fixture.store).unwrap().records[0].resolved);
        }
        let reopened=CheckpointStore::test(fixture.directory.clone(),[37;32]); let journal=load_transactions(&reopened).unwrap();
        recovery_admission(&journal,&prepared(data("878d683d",[word(4),word(6)].concat()),8),SCOPE,"order_1",&phase("buyer","propose_resolution",NEXT)).unwrap();
        assert_eq!(journal.records.len(),1); assert_eq!(journal.records[0].nonce,7);
    }

    #[tokio::test]
    async fn missing_submitted_failed_and_callback_errors_never_resolve_or_claim_safe_retry() {
        for status in ["missing","submitted","failed","callback"] {
            let mut journal=index(); let current_phase=journal.records[0].phase.clone(); let mut proof=detail(&journal.records[0],status);
            if status=="missing" { proof["escrowSubmissions"]=json!([]); }
            let saves=Cell::new(0);
            let result=finish_escrow_with(&mut journal,SCOPE,"order_1",&current_phase,OWNER,||ready(if status=="callback" { Err("wallet_escrow_not_confirmed".into()) } else { Ok(proof) }),||Ok(OWNER.into()),|_|{saves.set(saves.get()+1);Ok(())}).await;
            assert_eq!(result.unwrap_err(),if status=="callback" {"wallet_escrow_unavailable"} else {"wallet_escrow_not_confirmed"});
            assert_eq!(saves.get(),0); assert!(!journal.records[0].resolved);
        }
    }

    #[tokio::test]
    async fn identity_duplicates_wallet_change_and_save_failure_reject_even_resolved_records() {
        for mutation in ["order","chain","contract","role","action","duplicate","contradictory","hash","status","wallet","save"] {
            let mut journal=index(); let current_phase=journal.records[0].phase.clone(); let mut proof=detail(&journal.records[0],"confirmed");
            match mutation {
                "order"=>proof["order"]["id"]=json!("other"), "chain"=>proof["order"]["chainId"]=json!(1), "contract"=>proof["physicalEscrow"]["contractAddress"]=json!(OWNER),
                "role"=>proof["escrowSubmissions"][0]["actorRole"]=json!("seller"), "action"=>proof["escrowSubmissions"][0]["action"]=json!("ship"),
                "duplicate"|"contradictory"=>{let mut duplicate=proof["escrowSubmissions"][0].clone();if mutation=="contradictory"{duplicate["status"]=json!("failed");}proof["escrowSubmissions"].as_array_mut().unwrap().push(duplicate);},
                "hash"=>proof["escrowSubmissions"][0]["transactionHash"]=json!("0x1"), "status"=>proof["escrowSubmissions"][0]["status"]=json!("dropped"), _=>{}
            }
            let saves=Cell::new(0);
            let result=finish_escrow_with(&mut journal,SCOPE,"order_1",&current_phase,OWNER,||ready(Ok(proof)),||Ok(if mutation=="wallet"{TARGET}else{OWNER}.into()),|_|{saves.set(saves.get()+1);if mutation=="save"{Err("disk".into())}else{Ok(())}}).await;
            assert!(result.is_err(),"{mutation}"); assert!(!journal.records[0].resolved); assert_eq!(saves.get(),usize::from(mutation=="save"));
        }
        let mut journal=index(); journal.records[0].resolved=true; let current_phase=journal.records[0].phase.clone(); let proof=detail(&journal.records[0],"failed");
        assert_eq!(finish_escrow_with(&mut journal,SCOPE,"order_1",&current_phase,OWNER,||ready(Ok(proof)),||Ok(OWNER.into()),|_|Ok(())).await.unwrap_err(),"wallet_escrow_not_confirmed");
        let callbacks=Cell::new(0); let wrong=phase("seller","ship",NEXT);
        assert!(finish_escrow_with(&mut journal,SCOPE,"order_1",&wrong,OWNER,||{callbacks.set(callbacks.get()+1);ready(Ok(json!({})))},||Ok(OWNER.into()),|_|Ok(())).await.is_err()); assert_eq!(callbacks.get(),0);
    }

    #[test]
    fn malformed_optional_metadata_is_rejected_and_missing_history_cannot_resolve() {
        let fixture=Fixture::new();
        let valid=index();
        for (key,value) in [("resolved",json!("yes")),("escrow_split",json!(["0","1"])),("value_hex",json!("0x1")),("phase",json!("escrow:buyer:dispute:00000000-0000-4000-c000-000000000001"))] {
            let mut encoded=serde_json::to_value(&valid).unwrap(); encoded["records"][0][key]=value;
            fixture.store.save(TRANSACTION_INDEX_ID,&encoded).unwrap(); assert!(load_transactions(&fixture.store).is_err());
        }
        let mut proof=detail(&valid.records[0],"confirmed");
        proof["escrowSubmissions"]=json!([]);
        assert_eq!(escrow_confirmation(&valid.records[0],&proof).unwrap_err(),"wallet_escrow_not_confirmed");
        proof["escrowSubmissions"]=json!((0..21).map(|_|detail(&valid.records[0],"confirmed")["escrowSubmissions"][0].clone()).collect::<Vec<_>>());
        assert_eq!(escrow_confirmation(&valid.records[0],&proof).unwrap_err(),"wallet_escrow_mismatch");
    }

    #[test]
    fn future_resolved_bytes_are_reserved_before_send_including_existing_unresolved() {
        let mut first=record(); let before=serde_json::to_vec(&first).unwrap().len(); first.resolved=true;
        assert_eq!(serde_json::to_vec(&first).unwrap().len()-before,b",\"resolved\":true".len());
        for existing_unresolved in [false,true] {
            let large_scope=format!("https://{}.example","a".repeat(2032));
            let mut journal=TransactionIndex{version:1,records:(0..98).map(|offset|{let mut record=transaction_record(&prepared(vec![],u64::MAX-offset),&large_scope,&format!("{offset:020}{}","a".repeat(180)),"payment",format!("0x{}","a".repeat(64))).unwrap();record.value_hex=format!("0x{:x}",u128::MAX);record}).collect()};
            if existing_unresolved {
                journal.records[0].scope="https://small.example".into();
                let mut prior=record(); prior.nonce=0; journal.records.push(prior);
            }
            let candidate=prepared(if existing_unresolved {vec![]}else{data("f08ef6cb",vec![])},1);
            let candidate_phase=if existing_unresolved {"payment".into()}else{phase("buyer","dispute",NEXT)};
            let order="b".repeat(200); let base_scope="https://a.example";
            let record=transaction_record(&candidate,base_scope,&order,&candidate_phase,format!("0x{}","a".repeat(64))).unwrap();
            let prospective=serde_json::to_vec(&journal).unwrap().len()+serde_json::to_vec(&record).unwrap().len()+1;
            let target_bytes=TRANSACTION_MAX_BYTES-15; assert!(prospective<target_bytes);
            let scope=format!("https://{}.example","a".repeat(1+target_bytes-prospective));assert!(scope.len()<=2048);
            assert_eq!(recovery_admission(&journal,&candidate,&scope,&order,&candidate_phase).unwrap_err(),"wallet_recovery_limit");
            journal.records.push(transaction_record(&candidate,&scope,&order,&candidate_phase,format!("0x{}","a".repeat(64))).unwrap());
            assert_eq!(serde_json::to_vec(&journal).unwrap().len(),target_bytes);
            let fixture=Fixture::new(); save_transactions(&fixture.store,&journal).unwrap();
        }
    }
}

#[cfg(test)]
mod escrow_failure_tests {
    use super::*;
    use crate::checkpoint::CheckpointStore;
    use std::{cell::{Cell,RefCell},collections::VecDeque,future::ready,path::PathBuf};
    const SCOPE:&str="https://commerce.example";
    const OWNER:&str="0x3434343434343434343434343434343434343434";
    const TARGET:&str="0x5656565656565656565656565656565656565656";
    const PHASE:&str="escrow:buyer:dispute:00000000-0000-4000-8000-000000000001";
    const NEXT:&str="escrow:buyer:dispute:00000000-0000-4000-8000-000000000002";
    fn hash(ch:&str)->String{format!("0x{}",ch.repeat(64))}
    fn calldata()->Vec<u8>{[vec![0xf0,0x8e,0xf6,0xcb],vec![0x11;32]].concat()}
    fn prepared(nonce:u64)->PreparedTransaction{PreparedTransaction{chain_id:80002,endpoint:"https://frozen.invalid".into(),from:OWNER.into(),nonce,to:TARGET.into(),to_bytes:[0x56;20],value:0,data_hex:hex_encode(&calldata()),data:calldata(),fees:execution_fees(21000,20_000_000_000,2_000_000_000,0).unwrap(),deadline:Instant::now()+CONFIRM_TTL}}
    fn index()->TransactionIndex{TransactionIndex{version:1,records:vec![transaction_record(&prepared(7),SCOPE,"order_1",PHASE,hash("a")).unwrap()]}}
    fn detail(status:&str)->Value{json!({"order":{"id":"order_1","chainId":80002},"physicalEscrow":{"contractAddress":TARGET},"escrowSubmissions":[{"actorRole":"buyer","action":"dispute","transactionHash":hash("a"),"status":status}]})}
    fn receipt()->Value{json!({"transactionHash":hash("a"),"from":OWNER,"to":TARGET,"status":"0x0","blockNumber":"0x9","blockHash":hash("b"),"transactionIndex":"0x0"})}
    fn block()->Value{json!({"number":"0x9","hash":hash("b"),"transactions":[hash("a")]})}
    fn replies()->Vec<Result<Value,String>>{let head=json!({"number":"0xa","hash":hash("c")});vec![Ok(json!("0x13882")),Ok(json!({"hash":hash("a"),"from":OWNER,"to":TARGET,"value":"0x0","nonce":"0x7","input":hex_encode(&calldata())})),Ok(receipt()),Ok(block()),Ok(head.clone()),Ok(head.clone()),Ok(receipt()),Ok(block()),Ok(head.clone()),Ok(head),Ok(json!("0x13882"))]}
    async fn inspect(journal:&mut TransactionIndex,responses:Vec<Result<Value,String>>,body:Result<Value,String>,wallet:&str,save_failure:bool)->(Result<Value,String>,Vec<(&'static str,Value)>,usize,usize){
        let queue=RefCell::new(VecDeque::from(responses));let calls=RefCell::new(Vec::new());let saves=Cell::new(0);let reads=Cell::new(0);
        let result=check_escrow_failure_with(journal,SCOPE,"order_1",PHASE,OWNER,||{reads.set(reads.get()+1);ready(body)},|method,params|{calls.borrow_mut().push((method,params));ready(queue.borrow_mut().pop_front().expect("unexpected RPC"))},||Ok(wallet.into()),|_|{saves.set(saves.get()+1);if save_failure{Err("disk".into())}else{Ok(())}}).await;
        (result,calls.into_inner(),saves.get(),reads.get())
    }
    struct Fixture{directory:PathBuf,store:CheckpointStore}
    impl Fixture{fn new()->Self{let directory=std::env::temp_dir().join(format!("hub-wallet-revert-{}",uuid::Uuid::new_v4()));let store=CheckpointStore::test(directory.clone(),[41;32]);Self{directory,store}}}
    impl Drop for Fixture{fn drop(&mut self){let _=std::fs::remove_dir_all(&self.directory);}}

    #[tokio::test]
    async fn finalized_status_zero_is_read_only_and_reinspection_checks_all_evidence(){
        let mut journal=index();
        for progress in [false,true]{
            let mut responses=replies();if progress{responses[8]=Ok(json!({"number":"0xb","hash":hash("d")}));responses[9]=responses[8].clone();}
            let(result,calls,saves,reads)=inspect(&mut journal,responses,Ok(detail("failed")),OWNER,false).await;
            assert_eq!(result.unwrap(),json!({"orderId":"order_1","phase":PHASE,"transactionHash":hash("a"),"status":"reverted"}));
            assert_eq!((calls.len(),saves,reads),(11,1,1));assert!(journal.records[0].resolved&&journal.records[0].reverted);
            assert_eq!(calls[4].1,json!(["finalized",false]));assert_eq!(calls[8].1,json!(["finalized",false]));
            assert!(calls.iter().all(|call|matches!(call.0,"eth_chainId"|"eth_getTransactionByHash"|"eth_getTransactionReceipt"|"eth_getBlockByNumber")));
        }
    }

    #[tokio::test]
    async fn equal_height_finality_must_match_inclusion_in_both_reads(){
        for conflict in [0,1,2]{
            let mut responses=replies();let head=json!({"number":"0x9","hash":hash("b")});
            for position in [4,5,8,9]{responses[position]=Ok(head.clone());}
            if conflict==1{responses[4].as_mut().unwrap()["hash"]=json!(hash("c"));responses[5]=responses[4].clone();}
            if conflict==2{responses[8].as_mut().unwrap()["hash"]=json!(hash("c"));responses[9]=responses[8].clone();}
            let mut journal=index();let(result,_,saves,_)=inspect(&mut journal,responses,Ok(detail("failed")),OWNER,false).await;
            assert_eq!(result.is_ok(),conflict==0);assert_eq!(saves,usize::from(conflict==0));
        }
    }

    #[tokio::test]
    async fn callback_confirmed_identity_duplicates_and_positive_resolution_block_before_rpc(){
        for variant in ["confirmed","duplicate","order","chain","contract","callback","resolved"]{
            let mut journal=index();let mut body=detail("failed");
            match variant{"confirmed"=>body=detail("confirmed"),"duplicate"=>{let row=body["escrowSubmissions"][0].clone();body["escrowSubmissions"].as_array_mut().unwrap().push(row);},"order"=>body["order"]["id"]=json!("other"),"chain"=>body["order"]["chainId"]=json!(1),"contract"=>body["physicalEscrow"]["contractAddress"]=json!(OWNER),"resolved"=>journal.records[0].resolved=true,_=>{}}
            let(result,calls,saves,reads)=inspect(&mut journal,vec![],if variant=="callback"{Err("wallet_escrow_not_confirmed".into())}else{Ok(body)},OWNER,false).await;
            assert_eq!(result.unwrap_err(),if variant=="callback"{"wallet_escrow_unavailable"}else{"wallet_escrow_mismatch"});assert!(calls.is_empty());assert_eq!(saves,0);assert_eq!(reads,usize::from(variant!="resolved"));assert!(!journal.records[0].reverted);
        }
        let mut body=detail("submitted");body["escrowSubmissions"]=json!([]);
        assert!(inspect(&mut index(),replies(),Ok(body),OWNER,false).await.0.is_ok());
    }

    #[tokio::test]
    async fn null_status_one_unfinalized_and_malformed_fields_never_release_operation(){
        for(position,field,value)in[(2,"",Value::Null),(2,"status",json!("0x1")),(2,"status",json!("0x00")),(2,"transactionIndex",json!("0x10000000000000000")),(4,"",Value::Null),(4,"number",json!("0x8")),(4,"number",json!("0x0a")),(4,"hash",Value::Null),(5,"hash",json!(hash("d")))]{
            let mut responses=replies();if field.is_empty(){responses[position]=Ok(value);}else{responses[position].as_mut().unwrap()[field]=value;}
            let mut journal=index();let(result,_,saves,_)=inspect(&mut journal,responses,Ok(detail("failed")),OWNER,false).await;assert!(result.is_err());assert_eq!(saves,0);assert!(!journal.records[0].resolved);
        }
        let mut responses=replies();responses[4]=Ok(json!({"number":"0x9","hash":hash("c")}));responses[5]=responses[4].clone();
        assert!(inspect(&mut index(),responses,Ok(detail("failed")),OWNER,false).await.0.is_err());
    }

    #[tokio::test]
    async fn exact_transaction_hash_address_value_nonce_input_and_phase_are_required(){
        for(field,value)in[("hash",json!(hash("b"))),("from",json!(TARGET)),("to",json!(OWNER)),("value",json!("0x1")),("nonce",json!("0x8")),("nonce",json!("0x07")),("input",json!("0x")),("input",Value::Null)]{
            let mut responses=replies();responses[1].as_mut().unwrap()[field]=value;let mut journal=index();let(result,_,saves,_)=inspect(&mut journal,responses,Ok(detail("failed")),OWNER,false).await;assert!(result.is_err(),"{field}");assert_eq!(saves,0);
        }
        let mut journal=index();journal.records[0].phase="escrow:buyer:confirm:00000000-0000-4000-8000-000000000001".into();let body=json!({"order":{"id":"order_1","chainId":80002},"physicalEscrow":{"contractAddress":TARGET},"escrowSubmissions":[]});
        assert!(check_escrow_failure_with(&mut journal,SCOPE,"order_1","escrow:buyer:confirm:00000000-0000-4000-8000-000000000001",OWNER,||ready(Ok(body)),{let queue=RefCell::new(VecDeque::from(replies()));move|_,_|ready(queue.borrow_mut().pop_front().unwrap())},||Ok(OWNER.into()),|_|Ok(())).await.is_err());
    }

    #[test]
    fn inclusion_index_hash_array_and_u64_boundaries_are_checked_without_overflow(){
        let journal=index();let record=&journal.records[0];let inclusion=failure_receipt(record,&receipt()).unwrap();
        for bad in [json!({"number":"0x9","hash":hash("b"),"transactions":[]}),json!({"number":"0x9","hash":hash("b"),"transactions":[hash("c")]}),json!({"number":"0x9","hash":hash("b"),"transactions":[hash("a"),hash("a")]}),json!({"number":"0x9","hash":hash("b"),"transactions":[{"hash":hash("a")}]}),json!({"number":"0x9","hash":hash("b"),"transactions":vec![hash("a");MAX_BLOCK_TRANSACTIONS+1]})]{assert!(failure_block(record,&inclusion,&bad).is_err());}
        for index in ["0x1","0x2710","0xffffffffffffffff"]{let mut value=receipt();value["transactionIndex"]=json!(index);if let Ok(inclusion)=failure_receipt(record,&value){assert!(failure_block(record,&inclusion,&block()).is_err());}}
        let mut receipt=receipt();receipt["blockNumber"]=json!("0xffffffffffffffff");assert_eq!(failure_receipt(record,&receipt).unwrap().number,u64::MAX);
        assert_eq!(failure_header(&json!({"number":"0xffffffffffffffff","hash":hash("b")})).unwrap().0,u64::MAX);
    }

    #[tokio::test]
    async fn reread_receipt_inclusion_finality_and_chain_changes_are_blocked(){
        for(position,field,value)in[(6,"",Value::Null),(8,"",Value::Null),(9,"",Value::Null),(6,"status",json!("0x1")),(6,"blockHash",json!(hash("c"))),(6,"transactionIndex",json!("0x1")),(6,"transactionHash",json!(hash("b"))),(7,"hash",json!(hash("c"))),(7,"transactions",json!([hash("c")])),(8,"number",json!("0x9")),(8,"hash",json!(hash("d"))),(9,"hash",json!(hash("d"))),(10,"",json!("0x1"))]{
            let mut responses=replies();if field.is_empty(){responses[position]=Ok(value);}else{responses[position].as_mut().unwrap()[field]=value;}
            let mut journal=index();let(result,_,saves,_)=inspect(&mut journal,responses,Ok(detail("failed")),OWNER,false).await;assert!(result.is_err(),"{position}/{field}");assert_eq!(saves,0);assert!(!journal.records[0].reverted);
        }
    }

    #[tokio::test]
    async fn rpc_failure_each_stage_wallet_switch_and_save_failure_keep_flags(){
        for position in 0..11{let mut responses=replies();responses[position]=Err("unsupported".into());let mut journal=index();let(result,calls,saves,_)=inspect(&mut journal,responses,Ok(detail("failed")),OWNER,false).await;assert_eq!(result.unwrap_err(),"wallet_escrow_unavailable");assert_eq!(calls.len(),position+1);assert_eq!(saves,0);assert!(!journal.records[0].resolved);}
        for save_failure in [false,true]{let mut journal=index();let(result,_,saves,_)=inspect(&mut journal,replies(),Ok(detail("failed")),if save_failure{OWNER}else{TARGET},save_failure).await;assert!(result.is_err());assert_eq!(saves,usize::from(save_failure));assert!(!journal.records[0].resolved&&!journal.records[0].reverted);}
    }

    #[tokio::test]
    async fn durable_history_reopens_and_new_uuid_only_is_allowed_positive_finish_is_blocked(){
        let fixture=Fixture::new();let mut journal=index();let queue=RefCell::new(VecDeque::from(replies()));
        check_escrow_failure_with(&mut journal,SCOPE,"order_1",PHASE,OWNER,||ready(Ok(detail("failed"))),|_,_|ready(queue.borrow_mut().pop_front().unwrap()),||Ok(OWNER.into()),|index|save_transactions(&fixture.store,index)).await.unwrap();
        let reopened=CheckpointStore::test(fixture.directory.clone(),[41;32]);let mut journal=load_transactions(&reopened).unwrap();
        assert_eq!(escrow_history_value(&journal,SCOPE,"order_1",OWNER).unwrap(),json!({"orderId":"order_1","verifiedReverted":[{"phase":PHASE,"role":"buyer","action":"dispute","chainId":80002,"transactionHash":hash("a"),"extra":{}}]}));
        for(scope,order,owner)in[("https://other.example","order_1",OWNER),(SCOPE,"other",OWNER),(SCOPE,"order_1",TARGET)]{assert_eq!(escrow_history_value(&journal,scope,order,owner).unwrap()["verifiedReverted"],json!([]));}
        recovery_admission(&journal,&prepared(8),SCOPE,"order_1",NEXT).unwrap();assert!(recovery_admission(&journal,&prepared(7),SCOPE,"order_1",NEXT).is_err());assert!(recovery_admission(&journal,&prepared(8),SCOPE,"order_1",PHASE).is_err());
        let callbacks=Cell::new(0);let result=finish_escrow_with(&mut journal,SCOPE,"order_1",PHASE,OWNER,||{callbacks.set(callbacks.get()+1);ready(Ok(detail("confirmed")))},||Ok(OWNER.into()),|_|Ok(())).await;
        assert_eq!(result.unwrap_err(),"wallet_escrow_reverted");assert_eq!(callbacks.get(),0);assert_eq!(journal.records.len(),1);
    }

    #[test]
    fn old_schema_invalid_reverted_flags_and_two_flag_capacity_are_closed(){
        let mut journal=index();let old=serde_json::to_value(&journal).unwrap();assert!(old["records"][0].get("reverted").is_none());let loaded:TransactionIndex=serde_json::from_value(old).unwrap();assert!(!loaded.records[0].reverted);
        journal.records[0].reverted=true;assert!(validate_transactions(&journal).is_err());journal.records[0].resolved=true;validate_transactions(&journal).unwrap();
        journal.records[0].phase="payment".into();assert!(validate_transactions(&journal).is_err());
        let initial=serde_json::to_vec(&index()).unwrap().len();let mut resolved=index();resolved.records[0].resolved=true;resolved.records[0].reverted=true;assert_eq!(serde_json::to_vec(&resolved).unwrap().len()-initial,32);
        let scope=format!("https://{}.example","a".repeat(2032));let mut journal=TransactionIndex{version:1,records:(0..98).map(|offset|{let mut record=transaction_record(&prepared(u64::MAX-offset),&scope,&format!("{offset:020}{}","a".repeat(180)),"payment",hash("a")).unwrap();record.value_hex=format!("0x{:x}",u128::MAX);record}).collect()};
        let candidate=prepared(1);let order="b".repeat(200);let base=transaction_record(&candidate,"https://a.example",&order,NEXT,hash("a")).unwrap();let prospective=serde_json::to_vec(&journal).unwrap().len()+serde_json::to_vec(&base).unwrap().len()+1;let target=TRANSACTION_MAX_BYTES-31;
        assert!(prospective<target);let candidate_scope=format!("https://{}.example","a".repeat(1+target-prospective));assert_eq!(recovery_admission(&journal,&candidate,&candidate_scope,&order,NEXT).unwrap_err(),"wallet_recovery_limit");
        journal.records.push(transaction_record(&candidate,&candidate_scope,&order,NEXT,hash("a")).unwrap());assert_eq!(serde_json::to_vec(&journal).unwrap().len(),target);
    }
}

#[cfg(test)]
mod refund_tests {
    use super::*;
    use crate::checkpoint::CheckpointStore;
    use std::{cell::Cell,future::ready,path::PathBuf};
    const SCOPE:&str="https://commerce.example";
    const OWNER:&str="0x3434343434343434343434343434343434343434";
    const BUYER:&str="0x7878787878787878787878787878787878787878";
    const TOKEN:&str="0x5656565656565656565656565656565656565656";
    const QUOTE:&str="00000000-0000-4000-8000-000000000001";
    const PHASE:&str="refund:00000000-0000-4000-8000-000000000001";
    const NEXT:&str="refund:00000000-0000-4000-8000-000000000002";
    fn hash()->String{format!("0x{}","a".repeat(64))}
    fn transfer()->Vec<u8>{hex_decode(&format!("a9059cbb{}{}{:064x}","0".repeat(24),&BUYER[2..],90)).unwrap()}
    fn prepared(erc20:bool,nonce:u64)->PreparedTransaction{let data=if erc20{transfer()}else{vec![]};PreparedTransaction{chain_id:80002,endpoint:"https://frozen.invalid".into(),from:OWNER.into(),nonce,to:if erc20{TOKEN}else{BUYER}.into(),to_bytes:if erc20{[0x56;20]}else{[0x78;20]},value:if erc20{0}else{90},data_hex:hex_encode(&data),data,fees:execution_fees(21000,20_000_000_000,2_000_000_000,90).unwrap(),deadline:Instant::now()+CONFIRM_TTL}}
    fn index(erc20:bool)->TransactionIndex{TransactionIndex{version:1,records:vec![transaction_record(&prepared(erc20,7),SCOPE,"order_1",PHASE,hash()).unwrap()]}}
    fn detail(erc20:bool)->Value{json!({"order":{"id":"order_1","chainId":80002,"payoutWallet":OWNER,"buyerWallet":BUYER,"assetKind":if erc20{"erc20"}else{"native"},"tokenContract":if erc20{json!(TOKEN)}else{Value::Null}},"physicalEscrow":null,"refunds":[{"id":"refund_1","status":"submitted","amountAtomic":"100","sellerRefundTransactionHash":hash()}],"refundAttempts":[{"refundId":"refund_1","role":"seller","transactionHash":hash(),"status":"confirmed"}]})}
    struct Fixture{directory:PathBuf,store:CheckpointStore}
    impl Fixture{fn new()->Self{let directory=std::env::temp_dir().join(format!("hub-wallet-refund-{}",uuid::Uuid::new_v4()));let store=CheckpointStore::test(directory.clone(),[43;32]);Self{directory,store}}}
    impl Drop for Fixture{fn drop(&mut self){let _=std::fs::remove_dir_all(&self.directory);}}

    #[test]
    fn native_and_exact_erc20_transfer_validate_before_signing(){
        assert_eq!(refund_quote_id(PHASE).unwrap(),QUOTE);refund_data(u128::MAX,&[]).unwrap();refund_data(0,&transfer()).unwrap();
        assert!(refund_data(0,&[]).is_err());assert!(refund_data(1,&transfer()).is_err());
        for position in [0,4,36]{let mut data=transfer();data[position]=1;assert!(refund_data(0,&data).is_err());}
        let mut zero=transfer();zero[52..68].fill(0);assert!(refund_data(0,&zero).is_err());
        assert!(refund_data(0,&transfer()[..67]).is_err());assert!(refund_data(0,&[transfer(),vec![0]].concat()).is_err());
        for phase in ["refund:00000000-0000-1000-8000-000000000001","refund:00000000-0000-4000-c000-000000000001","refund:00000000-0000-4000-8000-000000000001:more","refund:FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF"]{assert!(refund_quote_id(phase).is_err());}
    }

    #[test]
    fn pending_metadata_and_legacy_flags_remain_strict_and_scoped(){
        let mut journal=index(false);validate_transactions(&journal).unwrap();
        assert_eq!(refund_pending_value(&journal,SCOPE,"order_1",OWNER).unwrap(),json!({"orderId":"order_1","operations":[{"phase":PHASE,"quoteId":QUOTE,"chainId":80002,"transactionHash":hash()}]}));
        for(scope,order,owner)in[("https://other.example","order_1",OWNER),(SCOPE,"other",OWNER),(SCOPE,"order_1",TOKEN)]{assert_eq!(refund_pending_value(&journal,scope,order,owner).unwrap()["operations"],json!([]));}
        let encoded=serde_json::to_value(&journal.records[0]).unwrap();assert_eq!(encoded.as_object().unwrap().len(),10);
        journal.records[0].resolved=true;validate_transactions(&journal).unwrap();assert_eq!(refund_pending_value(&journal,SCOPE,"order_1",OWNER).unwrap()["operations"],json!([]));
        journal.records[0].reverted=true;assert!(validate_transactions(&journal).is_err());journal.records[0].reverted=false;journal.records[0].escrow_split=Some(["1".into(),"1".into()]);assert!(validate_transactions(&journal).is_err());
    }

    #[tokio::test]
    async fn save_before_broadcast_lost_response_and_write_failure_never_resend(){
        for save_failure in [false,true]{let fixture=Fixture::new();let mut journal=TransactionIndex{version:1,records:vec![]};let prepared=prepared(false,7);let now=Instant::now();let sends=Cell::new(0);let signs=Cell::new(0);
            let result=execute_recoverable(&mut journal,&prepared,SCOPE,"order_1",PHASE,||ready(Ok((OWNER.into(),7))),|_|{signs.set(signs.get()+1);vec![2,1]},|index|if save_failure{Err("disk".into())}else{save_transactions(&fixture.store,index)},|raw|{sends.set(sends.get()+1);let saved=load_transactions(&fixture.store).unwrap();assert_eq!(saved.records[0].transaction_hash,hex_encode(&keccak256(&raw)));ready(Err("rpc_unreachable".into()))},||now).await;
            assert!(result.is_err());assert_eq!(signs.get(),1);assert_eq!(sends.get(),usize::from(!save_failure));
            if !save_failure{let reopened=CheckpointStore::test(fixture.directory.clone(),[43;32]);let journal=load_transactions(&reopened).unwrap();assert!(recovery_admission(&journal,&prepared,SCOPE,"order_1",PHASE).is_err());assert!(refund_pending_value(&journal,SCOPE,"order_1",OWNER).unwrap()["operations"][0]["transactionHash"].is_string());}
        }
    }

    #[test]
    fn unresolved_refund_and_escrow_block_each_other_but_resolved_history_keeps_nonce(){
        let mut journal=index(false);let mut escrow=prepared(true,8);escrow.value=0;escrow.data=[vec![0xf0,0x8e,0xf6,0xcb],vec![0x11;32]].concat();escrow.data_hex=hex_encode(&escrow.data);
        let phase="escrow:buyer:dispute:00000000-0000-4000-8000-000000000003";
        assert_eq!(recovery_admission(&journal,&escrow,SCOPE,"order_1",phase).unwrap_err(),"wallet_recovery_pending");
        let other=transaction_record(&escrow,SCOPE,"order_1",phase,format!("0x{}","b".repeat(64))).unwrap();journal.records.push(other);assert!(validate_transactions(&journal).is_err());journal.records.remove(0);
        assert_eq!(recovery_admission(&journal,&prepared(false,9),SCOPE,"order_1",NEXT).unwrap_err(),"wallet_recovery_pending");
        journal.records[0].resolved=true;recovery_admission(&journal,&prepared(false,9),SCOPE,"order_1",NEXT).unwrap();
        let mut journal=index(false);journal.records[0].resolved=true;assert!(recovery_admission(&journal,&prepared(false,7),SCOPE,"order_1",NEXT).is_err());assert!(recovery_admission(&journal,&prepared(false,8),SCOPE,"order_1",PHASE).is_err());
    }

    #[tokio::test]
    async fn seller_transfer_confirmed_with_fee_pending_is_durable_and_idempotent(){
        for erc20 in [false,true]{let fixture=Fixture::new();let mut journal=index(erc20);save_transactions(&fixture.store,&journal).unwrap();
            for _ in 0..2{let result=finish_refund_with(&mut journal,SCOPE,"order_1",PHASE,OWNER,||ready(Ok(detail(erc20))),||Ok(OWNER.into()),|index|save_transactions(&fixture.store,index)).await.unwrap();assert_eq!(result,json!({"orderId":"order_1","phase":PHASE,"transactionHash":hash(),"resolved":true,"sellerTransferConfirmed":true}));assert!(load_transactions(&fixture.store).unwrap().records[0].resolved);}
            let reopened=CheckpointStore::test(fixture.directory.clone(),[43;32]);let journal=load_transactions(&reopened).unwrap();recovery_admission(&journal,&prepared(erc20,8),SCOPE,"order_1",NEXT).unwrap();assert_eq!(journal.records.len(),1);
        }
    }

    #[tokio::test]
    async fn missing_submitted_rejected_callback_and_changed_wallet_never_resolve(){
        for variant in ["missing","submitted","rejected","refund_rejected","callback","wallet","save"]{let mut journal=index(false);let mut body=detail(false);
            match variant{"missing"=>{body["refunds"]=json!([]);body["refundAttempts"]=json!([]);},"submitted"|"rejected"=>body["refundAttempts"][0]["status"]=json!(variant),"refund_rejected"=>body["refunds"][0]["status"]=json!("rejected"),_=>{}}
            let saves=Cell::new(0);let result=finish_refund_with(&mut journal,SCOPE,"order_1",PHASE,OWNER,||ready(if variant=="callback"{Err("wallet_refund_not_confirmed".into())}else{Ok(body)}),||Ok(if variant=="wallet"{TOKEN}else{OWNER}.into()),|_|{saves.set(saves.get()+1);if variant=="save"{Err("disk".into())}else{Ok(())}}).await;
            assert_eq!(result.unwrap_err(),match variant{"callback"|"save"=>"wallet_refund_unavailable","wallet"=>"wallet_refund_mismatch",_=>"wallet_refund_not_confirmed"});assert_eq!(saves.get(),usize::from(variant=="save"));assert!(!journal.records[0].resolved);
        }
    }

    #[test]
    fn order_asset_hash_amount_roles_duplicates_and_limits_are_fail_closed(){
        for erc20 in [false,true]{for variant in ["order","chain","seller","target","escrow","amount","duplicate_refund","duplicate_attempt","role","hash","oversized_refunds","oversized_attempts","malformed","missing_escrow"]{let journal=index(erc20);let mut body=detail(erc20);
            match variant{"order"=>body["order"]["id"]=json!("other"),"chain"=>body["order"]["chainId"]=json!(1),"seller"=>body["order"]["payoutWallet"]=json!(BUYER),"target"=>{body["order"][if erc20{"tokenContract"}else{"buyerWallet"}]=json!(OWNER);},"escrow"=>body["physicalEscrow"]=json!({}),"amount"=>body["refunds"][0]["amountAtomic"]=json!("00"),"duplicate_refund"=>{let row=body["refunds"][0].clone();body["refunds"].as_array_mut().unwrap().push(row);},"duplicate_attempt"=>{let row=body["refundAttempts"][0].clone();body["refundAttempts"].as_array_mut().unwrap().push(row);},"role"=>body["refundAttempts"][0]["role"]=json!("hub_fee"),"hash"=>body["refundAttempts"][0]["transactionHash"]=json!("0x1"),"oversized_refunds"=>{let row=body["refunds"][0].clone();body["refunds"]=json!(vec![row;101]);},"oversized_attempts"=>{let row=body["refundAttempts"][0].clone();body["refundAttempts"]=json!(vec![row;101]);},"malformed"=>body["refundAttempts"][0]["refundId"]=json!("wrong/refund"),_=>{body.as_object_mut().unwrap().remove("physicalEscrow");}}
            assert!(refund_confirmation(&journal.records[0],&body).is_err(),"{erc20}/{variant}");
        }}
        let journal=index(false);let mut body=detail(false);body["refunds"][0]["amountAtomic"]=json!("89");assert!(refund_confirmation(&journal.records[0],&body).is_err());
        body["refunds"]=json!([]);body["refundAttempts"][0]["status"]=json!("invalid");assert_eq!(refund_confirmation(&journal.records[0],&body).unwrap_err(),"wallet_refund_mismatch");
    }

    #[test]
    fn refund_resolution_bytes_are_reserved_without_changing_legacy_or_escrow_budget(){
        assert_eq!(resolution_bytes(PHASE),16);assert_eq!(resolution_bytes("escrow:buyer:dispute:00000000-0000-4000-8000-000000000003"),32);assert_eq!(resolution_bytes("payment"),0);
        let initial=serde_json::to_vec(&index(false)).unwrap().len();let mut finished=index(false);finished.records[0].resolved=true;assert_eq!(serde_json::to_vec(&finished).unwrap().len()-initial,16);
        let large_scope=format!("https://{}.example","a".repeat(2032));let mut journal=TransactionIndex{version:1,records:(0..98).map(|offset|{let mut record=transaction_record(&prepared(false,u64::MAX-offset),&large_scope,&format!("{offset:020}{}","a".repeat(180)),"payment",hash()).unwrap();record.value_hex=format!("0x{:x}",u128::MAX);record}).collect()};
        let candidate=prepared(false,1);let order="b".repeat(200);let base=transaction_record(&candidate,"https://a.example",&order,NEXT,hash()).unwrap();let prospective=serde_json::to_vec(&journal).unwrap().len()+serde_json::to_vec(&base).unwrap().len()+1;let target=TRANSACTION_MAX_BYTES-15;assert!(prospective<target);let scope=format!("https://{}.example","a".repeat(1+target-prospective));assert!(scope.len()<=2048);
        assert_eq!(recovery_admission(&journal,&candidate,&scope,&order,NEXT).unwrap_err(),"wallet_recovery_limit");journal.records.push(transaction_record(&candidate,&scope,&order,NEXT,hash()).unwrap());assert_eq!(serde_json::to_vec(&journal).unwrap().len(),target);
    }
    #[tokio::test]
    async fn trusted_sender_and_quote_deadline_are_checked_before_signing(){
        let expected = Some(approval_hex::<20>(&json!(OWNER)).unwrap());
        refund_send_gate(None, OWNER, None, i64::MAX).unwrap();
        refund_send_gate(expected, OWNER, Some(100), 99).unwrap();
        let mixed = format!("0x{}", "aB".repeat(20));
        refund_send_gate(Some([0xab;20]), &mixed, None, 0).unwrap();
        assert_eq!(refund_send_gate(expected, BUYER, Some(100), 99).unwrap_err(), "wallet_fee_stale");
        for now in [100,101,i64::MAX] { assert_eq!(refund_send_gate(expected, OWNER, Some(100), now).unwrap_err(), "wallet_fee_expired"); }
        for sender in ["0X3434343434343434343434343434343434343434", " 0x3434343434343434343434343434343434343434", "0x34", "0xＧ434343434343434343434343434343434343434"] { assert!(approval_hex::<20>(&json!(sender)).is_err()); }
        for changed in [false,true] {
            let mut journal=TransactionIndex{version:1,records:vec![]};let prepared=prepared(false,7);let signs=Cell::new(0);let sends=Cell::new(0);let saves=Cell::new(0);let now=Instant::now();
            let result=execute_recoverable(&mut journal,&prepared,SCOPE,"order_1",PHASE,||async {
                // The injected postapproval RPC completes after expiry or with a changed wallet.
                refund_send_gate(expected,if changed{BUYER}else{OWNER},Some(100),if changed{99}else{100})?;
                Ok((OWNER.into(),7))
            },|_|{signs.set(signs.get()+1);vec![2,1]},|_|{saves.set(saves.get()+1);Ok(())},|_|{sends.set(sends.get()+1);ready(Ok(hash()))},||now).await;
            // Shared execution normalizes read errors before any signing.
            assert_eq!(result.unwrap_err(),"wallet_fee_unavailable");
            assert_eq!((signs.get(),saves.get(),sends.get()),(0,0,0));assert!(journal.records.is_empty());
        }

    }

}

#[cfg(test)]
#[path = "desktop_wallet_network_tests.rs"]
mod network_tests;
