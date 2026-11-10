//! AI market endpoint call (docs/hub-ai-market/DESIGN.md, slice 1). TESTNET ONLY.
//!
//! The device calls a listed OpenAI-compatible endpoint directly on the BYOK HTTP path (https, no redirects,
//! the same chat body). Hub never sees the prompt or the answer. The seller's 402 quote is judged here:
//! only the testnet network, never more than the listed maximum, only the listed splitter as payee. The
//! wallet confirmation shows the maximum charge, the payee and the 1% / 99% split; after the user agrees the
//! device signs the EIP-3009 authorization locally and retries once. Any failure ends the call (fail closed).
//!
//! Mainnet needs an external audit of the splitter and a separate explicit owner instruction.

use serde_json::{json, Value};

use super::{http, openai, ChatMessage, Kind};
use base64::{engine::general_purpose::STANDARD as B64, Engine};

/// The only network a market payment may use in this slice (Base Sepolia).
const TESTNET: &str = "eip155:84532";
const FEE_BPS: u128 = 100;
const MAX_PRICE_ATOMIC: u128 = 10_000_000;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_MESSAGES: usize = 50;
const MAX_CHARS: usize = 100_000;

/// Pinned testnet AiEndpointSplitterFactoryV1. A placeholder (zero) until it is deployed: while it is zero every
/// market call fails closed. Same address as AI_SPLITTER_FACTORY_TESTNET on the Hub.
pub const SPLITTER_FACTORY_TESTNET: &str = "0x0000000000000000000000000000000000000000";
/// keccak256 of the AiEndpointSplitterV1 creation code (no constructor arguments), from the Foundry build.
/// Must equal SPLITTER_INIT_CODE_HASH in apps/hub/lib/ai-endpoint-splitter.ts and the pinned value in the Solidity test.
const SPLITTER_INIT_CODE_HASH: [u8; 32] = [
    0xb9, 0x66, 0xa7, 0x9c, 0x91, 0x1c, 0x55, 0x7f, 0x7d, 0x6a, 0x4f, 0x15, 0x75, 0x1b, 0x3a, 0x0a,
    0x62, 0x16, 0xa4, 0x92, 0x3b, 0xb8, 0x4a, 0x00, 0x9e, 0x1b, 0x0e, 0xf1, 0xce, 0xe5, 0xf7, 0x6c,
];

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub provider_name: String,
    pub base_url: String,
    pub network: String,
    pub max_price_atomic: u64,
    pub payee_address: String,
    pub seller_address: String,
}

/// What the transport hands back: status, the `payment-required` header if any, and the JSON body.
pub struct Reply {
    pub status: u16,
    pub payment_required: Option<String>,
    pub body: Value,
}

#[allow(async_fn_in_trait)]
pub trait Transport {
    async fn post(&self, url: &str, body: &Value, payment_signature: Option<&str>) -> Result<Reply, String>;
}

/// Signs typed data after showing the wallet confirmation. The real one is the Desktop wallet.
#[allow(async_fn_in_trait)]
pub trait Signer {
    async fn from_address(&self) -> Result<String, String>;
    async fn sign(&self, detail: &str, typed_data: &Value) -> Result<String, String>;
}

fn address_bytes(value: &str) -> Option<[u8; 20]> {
    if value.len() != 42 || !value.starts_with("0x") {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[2 + 2 * i..4 + 2 * i], 16).ok()?;
    }
    Some(out)
}

/// CREATE2 address of a seller's splitter, computed offline: keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12..],
/// salt = the seller address left-padded to 32 bytes. Returns the lowercase 0x address. A zero factory is refused.
pub fn splitter_for(factory: &str, seller: &str) -> Result<String, String> {
    use sha3::{Digest, Keccak256};
    let factory = address_bytes(factory).filter(|a| a.iter().any(|b| *b != 0)).ok_or("market_factory_unset")?;
    let seller = address_bytes(seller).ok_or("market_listing_invalid")?;
    let mut input = Vec::with_capacity(85);
    input.push(0xff);
    input.extend_from_slice(&factory);
    input.extend_from_slice(&[0u8; 12]);
    input.extend_from_slice(&seller);
    input.extend_from_slice(&SPLITTER_INIT_CODE_HASH);
    let digest = Keccak256::digest(&input);
    Ok(format!("0x{}", digest[12..].iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

fn address_ok(value: &str) -> bool {
    value.len() == 42 && value.starts_with("0x") && value[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// https only (a market endpoint is a third party), on top of the BYOK custom-endpoint rules.
pub fn market_base(listing: &Listing) -> Result<String, &'static str> {
    let base = http::base_url(Kind::OpenaiCompatible, Some(&listing.base_url))?;
    if !base.starts_with("https://") || http::is_loopback_base(&base) {
        return Err("market_endpoint_not_allowed");
    }
    Ok(base)
}

fn check_listing(listing: &Listing, factory: &str) -> Result<String, String> {
    if listing.network != TESTNET {
        return Err("market_network_not_testnet".into());
    }
    if listing.max_price_atomic == 0 || u128::from(listing.max_price_atomic) > MAX_PRICE_ATOMIC {
        return Err("market_listing_invalid".into());
    }
    if !address_ok(&listing.payee_address) || !address_ok(&listing.seller_address) {
        return Err("market_listing_invalid".into());
    }
    // The payee is recomputed from the factory and the seller; the listing's own field is never trusted.
    if splitter_for(factory, &listing.seller_address)? != listing.payee_address.to_lowercase() {
        return Err("market_payee_mismatch".into());
    }
    market_base(listing).map_err(str::to_owned)
}

fn check_messages(messages: &[ChatMessage]) -> Result<(), String> {
    let chars: usize = messages.iter().map(|m| m.content.chars().count()).sum();
    let roles = messages.iter().all(|m| matches!(m.role.as_str(), "system" | "user" | "assistant"));
    if messages.is_empty() || messages.len() > MAX_MESSAGES || chars > MAX_CHARS || !roles {
        return Err("market_request_invalid".into());
    }
    Ok(())
}

/// 1% to the Hub fee address, the rest to the seller (rounded down fee, as the splitter contract does).
pub fn split(amount: u128) -> (u128, u128) {
    let fee = amount * FEE_BPS / 10_000;
    (fee, amount - fee)
}

/// Judges one `accepts` entry against the listing. Returns the parsed requirement and its amount.
fn judge(accepts: &Value, listing: &Listing) -> Result<(crate::ai_client::Accepted, u128), String> {
    let list = accepts.as_array().ok_or("market_quote_unsupported")?;
    let mut mainnet_seen = false;
    for entry in list {
        if entry.get("scheme").and_then(Value::as_str) != Some("exact") {
            continue;
        }
        let network = entry.get("network").and_then(Value::as_str).unwrap_or("");
        if network != TESTNET {
            mainnet_seen |= network.starts_with("eip155:");
            continue;
        }
        let req = crate::ai_client::accepted_requirements(entry).map_err(|_| "market_quote_invalid".to_owned())?;
        let amount: u128 = req.amount.parse().map_err(|_| "market_quote_invalid".to_owned())?;
        if amount == 0 {
            return Err("market_quote_invalid".into());
        }
        if amount > u128::from(listing.max_price_atomic) {
            return Err("market_over_listed_max".into());
        }
        if req.pay_to != listing.payee_address.to_lowercase() {
            return Err("market_payee_mismatch".into());
        }
        return Ok((req, amount));
    }
    Err(if mainnet_seen { "market_network_not_testnet" } else { "market_quote_unsupported" }.into())
}

/// The text the wallet confirmation shows next to the typed data.
pub fn confirmation_detail(listing: &Listing, req: &crate::ai_client::Accepted, amount: u128, from: &str) -> String {
    let (fee, seller) = split(amount);
    format!(
        "AI市場（テスト用ネットワーク）\n提供者: {}\n最大の請求額（原子単位）: {amount}\n支払い先（スプリッター）: {}\n内訳: Hub手数料 1% = {fee} / 売り手 {} への分配 = {seller}\n資産: {}\nネットワーク: {}\n送る側: {from}",
        listing.provider_name.chars().take(80).collect::<String>(),
        req.pay_to,
        listing.seller_address.to_lowercase(),
        req.asset,
        req.network,
    )
}

fn quote_of(reply: &Reply) -> Option<Value> {
    reply
        .payment_required
        .as_deref()
        .and_then(|v| B64.decode(v).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .or_else(|| reply.body.get("accepts").map(|_| reply.body.clone()))
}

fn answer(body: &Value) -> Result<String, String> {
    body.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "byok_provider_failed".to_owned())
}

/// One call: ask, and if the endpoint wants payment, judge the quote, confirm, sign, retry once.
/// `private` content never goes to a market endpoint in this slice (no attestation exists yet).
pub async fn run<T: Transport, S: Signer>(
    factory: &str,
    transport: &T,
    signer: &S,
    listing: &Listing,
    model: &str,
    messages: &[ChatMessage],
    private: bool,
) -> Result<Value, String> {
    if private {
        return Err("market_private_blocked".into());
    }
    let base = check_listing(listing, factory)?;
    if !http::valid_model(Kind::OpenaiCompatible, model) {
        return Err("byok_invalid_request".into());
    }
    check_messages(messages)?;
    let url = openai::chat_url(&base);
    let body = openai::chat_body(model, messages, false, None);

    let first = transport.post(&url, &body, None).await?;
    if (200..300).contains(&first.status) {
        return Ok(json!({ "status": "ok", "text": answer(&first.body)?, "paidAtomic": "0" }));
    }
    if first.status != 402 {
        return Err(http::classify(first.status, "").to_owned());
    }
    let quote = quote_of(&first).ok_or("market_quote_invalid")?;
    let (req, amount) = judge(quote.get("accepts").unwrap_or(&Value::Null), listing)?;

    let from = signer.from_address().await?;
    let nonce = crate::ai_client::hex_nonce();
    let valid_before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        + req.timeout;
    let typed = crate::ai_client::payment_typed_data(&req, &from, &nonce, valid_before);
    let signature = signer.sign(&confirmation_detail(listing, &req, amount, &from), &typed).await?;
    let payload = json!({
        "x402Version": 2,
        "accepted": req.raw,
        "payload": { "signature": signature, "authorization": {
            "from": from, "to": req.pay_to, "value": req.amount,
            "validAfter": "0", "validBefore": valid_before.to_string(), "nonce": nonce } }
    });
    let header = B64.encode(payload.to_string());
    let second = transport.post(&url, &body, Some(&header)).await?;
    if second.status == 402 {
        return Err("market_payment_rejected".into());
    }
    if !(200..300).contains(&second.status) {
        return Err(http::classify(second.status, "").to_owned());
    }
    Ok(json!({ "status": "ok", "text": answer(&second.body)?, "paidAtomic": amount.to_string() }))
}

/// Real transport: the BYOK client (https, no redirects), no credentials of any kind.
pub struct HttpTransport {
    pub base: String,
}

impl Transport for HttpTransport {
    async fn post(&self, url: &str, body: &Value, payment_signature: Option<&str>) -> Result<Reply, String> {
        let client = super::client(&self.base, Some(std::time::Duration::from_secs(120))).map_err(str::to_owned)?;
        let mut request = client.post(url).header("content-type", "application/json").body(body.to_string());
        if let Some(signature) = payment_signature {
            request = request.header("payment-signature", signature);
        }
        let response = request.send().await.map_err(|_| "byok_unreachable".to_owned())?;
        let status = response.status().as_u16();
        let payment_required = response.headers().get("payment-required").and_then(|v| v.to_str().ok()).map(str::to_owned);
        let bytes = response.bytes().await.map_err(|_| "byok_connection_lost".to_owned())?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err("byok_response_too_large".into());
        }
        Ok(Reply { status, payment_required, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) })
    }
}

/// Real signer: the Desktop wallet confirmation, then a local signature.
pub struct WalletSigner<'a> {
    pub app: &'a tauri::AppHandle,
}

impl Signer for WalletSigner<'_> {
    async fn from_address(&self) -> Result<String, String> {
        crate::desktop_wallet::wallet_address()
    }
    async fn sign(&self, detail: &str, typed_data: &Value) -> Result<String, String> {
        crate::desktop_wallet::sign_typed_data_purpose(self.app, "AI市場への支払い（テスト用）", detail, typed_data).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const SELLER: &str = "0x1234567890abcdef1234567890abcdef12345678";
    const FACTORY: &str = "0x00000000000000000000000000000000000f4c70";
    const SPLITTER: &str = "0x0667fab5fdf0c9771dc03b057ce6af2f5a341061";
    const ASSET: &str = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    fn listing() -> Listing {
        Listing {
            provider_name: "Example".into(),
            base_url: "https://api.example.com/v1".into(),
            network: TESTNET.into(),
            max_price_atomic: 10_000,
            payee_address: SPLITTER.into(),
            seller_address: SELLER.into(),
        }
    }

    fn accept(over: Value) -> Value {
        let mut base = json!({ "scheme": "exact", "network": TESTNET, "amount": "10000", "asset": ASSET, "payTo": SPLITTER,
            "maxTimeoutSeconds": 300, "extra": { "name": "USDC", "version": "2" } });
        for (k, v) in over.as_object().cloned().unwrap_or_default() {
            base[k] = v;
        }
        base
    }

    fn quote_reply(entry: Value) -> Reply {
        let quote = json!({ "x402Version": 2, "accepts": [entry] });
        Reply { status: 402, payment_required: Some(B64.encode(quote.to_string())), body: Value::Null }
    }

    fn ok_reply(text: &str) -> Reply {
        Reply { status: 200, payment_required: None, body: json!({ "choices": [{ "message": { "content": text } }] }) }
    }

    struct Mock {
        replies: Mutex<Vec<Reply>>,
        seen: Mutex<Vec<(String, Option<String>)>>,
    }
    impl Mock {
        fn new(mut replies: Vec<Reply>) -> Self {
            replies.reverse();
            Mock { replies: Mutex::new(replies), seen: Mutex::new(vec![]) }
        }
    }
    impl Transport for Mock {
        async fn post(&self, url: &str, _: &Value, sig: Option<&str>) -> Result<Reply, String> {
            self.seen.lock().unwrap().push((url.to_owned(), sig.map(str::to_owned)));
            self.replies.lock().unwrap().pop().ok_or_else(|| "mock_exhausted".to_owned())
        }
    }

    /// A wallet that records what it was asked to confirm. It never signs anything real.
    struct MockWallet {
        agree: bool,
        asked: Mutex<Vec<(String, Value)>>,
    }
    impl MockWallet {
        fn new(agree: bool) -> Self {
            MockWallet { agree, asked: Mutex::new(vec![]) }
        }
    }
    impl Signer for MockWallet {
        async fn from_address(&self) -> Result<String, String> {
            Ok("0x9999999999999999999999999999999999999999".into())
        }
        async fn sign(&self, detail: &str, typed: &Value) -> Result<String, String> {
            self.asked.lock().unwrap().push((detail.to_owned(), typed.clone()));
            if self.agree { Ok("0xmocksignature".into()) } else { Err("wallet_user_rejected".into()) }
        }
    }

    fn hi() -> Vec<ChatMessage> {
        vec![ChatMessage { role: "user".into(), content: "hi".into() }]
    }
    fn block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn splitter_address_matches_the_solidity_and_typescript_vectors() {
        assert_eq!(splitter_for(FACTORY, "0x1234567890abcdef1234567890abcdef12345678").unwrap(), "0x0667fab5fdf0c9771dc03b057ce6af2f5a341061");
        assert_eq!(splitter_for(FACTORY, "0x00000000000000000000000000000000000000a1").unwrap(), "0xa520a7e78139fe4b45e31822ecfa56b9145e0ccd");
        assert_eq!(splitter_for(FACTORY, "0x1234567890ABCDEF1234567890ABCDEF12345678").unwrap(), "0x0667fab5fdf0c9771dc03b057ce6af2f5a341061");
        assert!(splitter_for(SPLITTER_FACTORY_TESTNET, SELLER).is_err());
    }

    #[test]
    fn split_is_one_percent_rounded_down_and_conserves_the_total() {
        assert_eq!(split(10_000), (100, 9_900));
        assert_eq!(split(99), (0, 99));
        for n in [1u128, 100, 101, 12_345, 10_000_000] {
            let (f, s) = split(n);
            assert_eq!(f + s, n);
        }
    }

    #[test]
    fn a_free_answer_needs_no_wallet() {
        let t = Mock::new(vec![ok_reply("hello")]);
        let w = MockWallet::new(true);
        let out = block(run(FACTORY, &t, &w, &listing(), "m", &hi(), false)).unwrap();
        assert_eq!(out["text"], "hello");
        assert!(w.asked.lock().unwrap().is_empty());
        assert_eq!(t.seen.lock().unwrap()[0].0, "https://api.example.com/v1/chat/completions");
    }

    #[test]
    fn a_402_is_confirmed_signed_locally_and_retried_once_with_the_split_shown() {
        let t = Mock::new(vec![quote_reply(accept(json!({}))), ok_reply("paid answer")]);
        let w = MockWallet::new(true);
        let out = block(run(FACTORY, &t, &w, &listing(), "m", &hi(), false)).unwrap();
        assert_eq!(out["text"], "paid answer");
        assert_eq!(out["paidAtomic"], "10000");
        let asked = w.asked.lock().unwrap();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].0.contains("10000") && asked[0].0.contains(SPLITTER) && asked[0].0.contains("= 100") && asked[0].0.contains("= 9900"));
        assert_eq!(asked[0].1["message"]["to"], SPLITTER);
        assert_eq!(asked[0].1["message"]["value"], "10000");
        let seen = t.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].1.is_none() && seen[1].1.is_some());
    }

    #[test]
    fn over_the_listed_max_mainnet_and_wrong_payee_are_refused_before_the_wallet() {
        for (entry, code) in [
            (accept(json!({ "amount": "10001" })), "market_over_listed_max"),
            (accept(json!({ "network": "eip155:8453" })), "market_network_not_testnet"),
            (accept(json!({ "network": "eip155:1" })), "market_network_not_testnet"),
            (accept(json!({ "payTo": SELLER })), "market_payee_mismatch"),
            (accept(json!({ "amount": "0" })), "market_quote_invalid"),
            (accept(json!({ "scheme": "upto" })), "market_quote_unsupported"),
        ] {
            let t = Mock::new(vec![quote_reply(entry)]);
            let w = MockWallet::new(true);
            assert_eq!(block(run(FACTORY, &t, &w, &listing(), "m", &hi(), false)).unwrap_err(), code);
            assert!(w.asked.lock().unwrap().is_empty(), "{code}: the wallet must not be asked");
            assert_eq!(t.seen.lock().unwrap().len(), 1, "{code}: no retry");
        }
    }

    #[test]
    fn declining_the_confirmation_sends_nothing_more() {
        let t = Mock::new(vec![quote_reply(accept(json!({})))]);
        let w = MockWallet::new(false);
        assert_eq!(block(run(FACTORY, &t, &w, &listing(), "m", &hi(), false)).unwrap_err(), "wallet_user_rejected");
        assert_eq!(t.seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_second_402_ends_the_call_after_a_single_signature() {
        let t = Mock::new(vec![quote_reply(accept(json!({}))), quote_reply(accept(json!({})))]);
        let w = MockWallet::new(true);
        assert_eq!(block(run(FACTORY, &t, &w, &listing(), "m", &hi(), false)).unwrap_err(), "market_payment_rejected");
        assert_eq!(w.asked.lock().unwrap().len(), 1);
    }

    #[test]
    fn private_content_and_unsafe_listings_never_reach_the_network() {
        let t = Mock::new(vec![ok_reply("x")]);
        let w = MockWallet::new(true);
        assert_eq!(block(run(FACTORY, &t, &w, &listing(), "m", &hi(), true)).unwrap_err(), "market_private_blocked");
        let mut http = listing();
        http.base_url = "http://api.example.com/v1".into();
        assert!(block(run(FACTORY, &t, &w, &http, "m", &hi(), false)).is_err());
        let mut local = listing();
        local.base_url = "https://localhost/v1".into();
        assert!(block(run(FACTORY, &t, &w, &local, "m", &hi(), false)).is_err());
        let mut main = listing();
        main.network = "eip155:8453".into();
        assert_eq!(block(run(FACTORY, &t, &w, &main, "m", &hi(), false)).unwrap_err(), "market_network_not_testnet");
        let mut same = listing();
        same.payee_address = SELLER.into();
        assert_eq!(block(run(FACTORY, &t, &w, &same, "m", &hi(), false)).unwrap_err(), "market_payee_mismatch");
        let mut forged = listing();
        forged.payee_address = "0x9999999999999999999999999999999999999999".into();
        assert_eq!(block(run(FACTORY, &t, &w, &forged, "m", &hi(), false)).unwrap_err(), "market_payee_mismatch");
        assert_eq!(block(run("0x0000000000000000000000000000000000000000", &t, &w, &listing(), "m", &hi(), false)).unwrap_err(), "market_factory_unset");
        assert!(t.seen.lock().unwrap().is_empty());
    }
}
