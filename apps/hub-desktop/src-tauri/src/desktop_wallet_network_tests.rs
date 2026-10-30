//! Network selection tests. They use generated or fixed in-memory keys only,
//! never the OS keyring, and never touch the network or the real settings file.

use super::*;
use std::{cell::Cell, future::ready};

const RECIPIENT: &str = "0x1111111111111111111111111111111111111111";
const MAINNETS: [u64; 6] = [43_114, 137, 1, 8_453, 42_161, 10];
const TESTNETS: [u64; 4] = [43_113, 1_001, 80_002, 84_532];

fn throwaway_key() -> SigningKey {
    SigningKey::random(&mut rand::rngs::OsRng)
}

fn prepared_on(chain_id: u64) -> PreparedTransaction {
    PreparedTransaction {
        chain_id, endpoint: "https://frozen.invalid".into(), from: RECIPIENT.into(), nonce: 3,
        to: RECIPIENT.into(), to_bytes: [0x11; 20], value: 1_000, data_hex: "0x".into(), data: vec![],
        fees: execution_fees(21_000, 20_000_000_000, 2_000_000_000, 1_000).unwrap(),
        deadline: Instant::now() + CONFIRM_TTL,
    }
}

/// Minimal RLP reader for the flat signed transaction: returns the list items.
fn rlp_flat_items(raw: &[u8]) -> Vec<Vec<u8>> {
    assert_eq!(raw[0], 0x02);
    let body = &raw[1..];
    let (header, length) = if body[0] <= 0xf7 {
        (1, usize::from(body[0] - 0xc0))
    } else {
        let width = usize::from(body[0] - 0xf7);
        (1 + width, body[1..1 + width].iter().fold(0usize, |total, byte| total * 256 + usize::from(*byte)))
    };
    assert_eq!(body.len(), header + length);
    let mut items = Vec::new();
    let mut at = header;
    while at < body.len() {
        let first = body[at];
        let (start, size) = if first < 0x80 {
            (at, 1)
        } else if first <= 0xb7 {
            (at + 1, usize::from(first - 0x80))
        } else if first <= 0xbf {
            let width = usize::from(first - 0xb7);
            (at + 1 + width, body[at + 1..at + 1 + width].iter().fold(0usize, |total, byte| total * 256 + usize::from(*byte)))
        } else {
            // The access list is the only nested item; keep it opaque.
            (at + 1, usize::from(first - 0xc0))
        };
        items.push(body[start..start + size].to_vec());
        at = start + size;
    }
    items
}

fn temporary_file(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("hub-wallet-network-{}", uuid::Uuid::new_v4())).join(name)
}

#[test]
fn allowlist_has_the_requested_mainnets_with_avalanche_as_default() {
    assert_eq!(DEFAULT_CHAIN, 43_114);
    assert_eq!(WalletSettings::DEFAULT, WalletSettings { chain_id: 43_114, developer: false });
    for id in MAINNETS { assert!(chain_info(id).unwrap().mainnet, "{id}"); }
    for id in TESTNETS { assert!(!chain_info(id).unwrap().mainnet, "{id}"); }
    assert_eq!(CHAINS.len(), MAINNETS.len() + TESTNETS.len());
    let mut ids = CHAINS.iter().map(|chain| chain.id).collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), CHAINS.len());
    assert_eq!(chain_info(43_114).unwrap().symbol, "AVAX");
    assert_eq!(chain_info(137).unwrap().symbol, "POL");
    assert!(chain_info(56).is_none());
    assert!(chain_info(0).is_none());
}

#[test]
fn only_mainnets_are_selectable_until_the_developer_setting_is_on() {
    let off = WalletSettings::DEFAULT;
    assert_eq!(selectable_chains(off).map(|chain| chain.id).collect::<Vec<_>>(), MAINNETS);
    let on = off.with_developer(true);
    assert_eq!(selectable_chains(on).count(), CHAINS.len());
    let listed = status_value(RECIPIENT, off);
    assert_eq!(listed["chains"].as_array().unwrap().len(), MAINNETS.len());
    assert_eq!(listed["chainId"], 43_114);
    assert_eq!(listed["mainnet"], true);
    assert_eq!(listed["developer"], false);
    assert!(listed["tokens"].as_array().unwrap().iter().any(|token| token["symbol"] == "JPYC"));
}

#[test]
fn selection_is_validated_against_the_allowlist() {
    let settings = WalletSettings::DEFAULT;
    for id in MAINNETS { assert_eq!(settings.select(id).unwrap().chain_id, id); }
    for id in [0u64, 56, 999, 80_002, 43_113, u64::MAX] {
        assert_eq!(settings.select(id).unwrap_err(), "wallet_chain_unsupported", "{id}");
    }
    let developer = settings.with_developer(true);
    for id in TESTNETS { assert_eq!(developer.select(id).unwrap().chain_id, id); }
    assert_eq!(developer.select(999).unwrap_err(), "wallet_chain_unsupported");
    // Turning the developer setting off cannot leave a testnet selected.
    let on_testnet = developer.select(80_002).unwrap();
    assert_eq!(on_testnet.with_developer(false), WalletSettings::DEFAULT);
    assert_eq!(developer.select(137).unwrap().with_developer(false).chain_id, 137);
}

#[test]
fn stored_settings_are_normalized_when_read() {
    assert_eq!(WalletSettings::parse(r#"{"chainId":137,"developer":false}"#).chain_id, 137);
    assert_eq!(WalletSettings::parse(r#"{"chainId":80002,"developer":true}"#).chain_id, 80_002);
    // A testnet without the developer setting, an unknown chain, junk and extra fields all fall back.
    for text in [r#"{"chainId":80002,"developer":false}"#, r#"{"chainId":56,"developer":true}"#, "not json", "", "{}",
        r#"{"chainId":137,"developer":false,"rpc":"https://evil.invalid"}"#, r#"{"chainId":"137","developer":false}"#] {
        assert_eq!(WalletSettings::parse(text).chain_id, DEFAULT_CHAIN, "{text}");
    }
}

#[test]
fn selection_persists_across_reads_of_the_settings_file() {
    let path = temporary_file("wallet-settings.json");
    assert_eq!(load_settings_from(&path), WalletSettings::DEFAULT);
    let chosen = WalletSettings::DEFAULT.select(137).unwrap();
    save_settings_to(&path, &chosen).unwrap();
    assert_eq!(load_settings_from(&path), chosen);
    let developer = chosen.with_developer(true).select(43_113).unwrap();
    save_settings_to(&path, &developer).unwrap();
    assert_eq!(load_settings_from(&path), developer);
    std::fs::write(&path, "corrupt").unwrap();
    assert_eq!(load_settings_from(&path), WalletSettings::DEFAULT);
    // A file edited to name a testnet while the developer setting is off cannot select it.
    std::fs::write(&path, r#"{"chainId":43113,"developer":false}"#).unwrap();
    assert_eq!(load_settings_from(&path).chain_id, DEFAULT_CHAIN);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn in_memory_selection_follows_update_and_failure_does_not_change_it() {
    // Tests have no settings file; the in-memory value starts at the default.
    assert_eq!(current_chain(), DEFAULT_CHAIN);
    assert!(update_settings(|current| current.select(80_002)).is_err());
    assert_eq!(current_chain(), DEFAULT_CHAIN);
    assert_eq!(select_chain(137).unwrap()["chainId"], 137);
    assert_eq!(current_chain(), 137);
    assert_eq!(select_chain(56).unwrap_err(), "wallet_chain_unsupported");
    assert_eq!(current_chain(), 137);
    assert_eq!(set_developer(true).unwrap()["developer"], true);
    assert_eq!(select_chain(80_002).unwrap()["chainId"], 80_002);
    assert_eq!(set_developer(false).unwrap()["chainId"], DEFAULT_CHAIN);
    assert_eq!(select_chain(DEFAULT_CHAIN).unwrap()["chainId"], DEFAULT_CHAIN);
}

#[test]
fn a_request_for_another_chain_is_never_switched_silently() {
    assert!(require_chain_selected(43_114, 43_114).is_ok());
    assert_eq!(require_chain_selected(43_114, 137).unwrap_err(), "wallet_chain_switch_required:137");
    assert_eq!(require_chain_selected(137, 43_114).unwrap_err(), "wallet_chain_switch_required:43114");
    assert_eq!(require_chain_selected(43_114, 56).unwrap_err(), "wallet_chain_unsupported");
    assert_eq!(require_chain_selected(43_114, 0).unwrap_err(), "wallet_chain_unsupported");
}

#[test]
fn typed_data_domain_chain_must_match_the_selected_chain() {
    let typed = |chain: Value| json!({"domain": {"name": "x", "chainId": chain}});
    assert_eq!(typed_data_chain(&typed(json!(137))).unwrap(), Some(137));
    assert_eq!(typed_data_chain(&typed(json!("137"))).unwrap(), Some(137));
    assert_eq!(typed_data_chain(&typed(json!("0xa86a"))).unwrap(), Some(43_114));
    assert_eq!(typed_data_chain(&json!({"domain": {"name": "x"}})).unwrap(), None);
    assert!(typed_data_chain(&typed(json!("not a number"))).is_err());
    assert_eq!(typed_data_chain(&typed(json!("0x010000000000000000"))).unwrap_err(), "wallet_chain_unsupported");
    assert_eq!(ensure_typed_data_chain(&typed(json!(56))).unwrap_err(), "wallet_chain_unsupported");
}

#[test]
fn rpc_candidates_are_ordered_and_the_environment_override_is_exclusive() {
    let avalanche = chain_rpcs(43_114).unwrap();
    assert_eq!(avalanche.len(), 2);
    assert!(avalanche[0].contains("api.avax.network"));
    assert_eq!(chain_rpcs(137).unwrap().len(), 1);
    assert_eq!(chain_rpcs(56).unwrap_err(), "wallet_chain_unsupported");
}

#[tokio::test]
async fn an_rpc_that_reports_another_chain_id_fails_closed_for_every_mainnet() {
    for id in MAINNETS {
        let other = MAINNETS.iter().copied().find(|candidate| *candidate != id).unwrap();
        let calls = Cell::new(0);
        let result = prepare_transaction_with(id, RECIPIENT, "0x64", "0x", "fixed".into(), RECIPIENT.into(), |method, _| {
            calls.set(calls.get() + 1);
            assert_eq!(method, "eth_chainId");
            ready(Ok(json!(format!("0x{other:x}"))))
        }, Instant::now).await;
        assert_eq!(result.err().unwrap(), "wallet_fee_unavailable", "{id}");
        assert_eq!(calls.get(), 1, "{id}: nothing is read after a chain mismatch");
    }
}

#[tokio::test]
async fn preparation_succeeds_only_when_the_rpc_chain_matches_on_a_mainnet() {
    let prepared = prepare_transaction_with(43_114, RECIPIENT, "0x64", "0x", "fixed".into(), RECIPIENT.into(), |method, _| ready(Ok(json!(match method {
        "eth_chainId" => "0xa86a",
        "eth_getTransactionCount" => "0x3",
        "eth_gasPrice" => "0x4a817c800",
        "eth_maxPriorityFeePerGas" => "0x77359400",
        "eth_estimateGas" => "0x5208",
        _ => panic!("unexpected RPC {method}"),
    }))), Instant::now).await.unwrap();
    assert_eq!(prepared.chain_id, 43_114);
    let detail = prepared_detail(&prepared, "").unwrap();
    assert!(detail.starts_with("【メインネット】本物のお金が動きます"));
    assert!(detail.contains("ネットワーク Avalanche C-Chain (chain ID 43114)"));
    assert!(detail.contains(&format!("宛先 {RECIPIENT}")));
    assert!(detail.contains("数量 100 wei (0.000000000000000100 AVAX)"));
    assert!(detail.contains("実行ガス代の上限"));
}

#[test]
fn confirmation_text_states_network_chain_recipient_amount_fee_and_mainnet_warning() {
    for chain in CHAINS {
        let detail = transaction_detail(chain.id, RECIPIENT, "0xde0b6b3a7640000", "0x", "caller says this is harmless").unwrap();
        assert!(detail.contains(&format!("ネットワーク {} (chain ID {})", chain.name, chain.id)));
        assert!(detail.contains(RECIPIENT));
        assert!(detail.contains(&format!("1.000000000000000000 {}", chain.symbol)));
        if chain.mainnet {
            assert!(detail.starts_with("【メインネット】本物のお金が動きます"), "{}", chain.id);
            assert!(!detail.contains("テストネット"));
        } else {
            assert!(detail.starts_with("【テストネット】"), "{}", chain.id);
            assert!(!detail.contains("本物のお金"));
        }
        // The trusted warning always precedes caller-supplied text.
        assert!(detail.find("呼び出し側の説明").unwrap() > detail.find("【").unwrap());
    }
}

#[test]
fn eip155_chain_id_is_signed_into_every_transaction() {
    let key = throwaway_key();
    let mut raws = Vec::new();
    for id in MAINNETS {
        let prepared = prepared_on(id);
        let unsigned = unsigned_prepared(&prepared);
        let raw = sign_prepared(&prepared, &key);
        let items = rlp_flat_items(&raw);
        // chain id is the first field and is part of the signed digest.
        assert_eq!(items[0], rlp_uint(u128::from(id))[if id < 0x80 { 0 } else { 1 }..].to_vec(), "{id}");
        let digest = keccak256(&unsigned);
        let pad = |scalar: &Vec<u8>| { let mut word = vec![0u8; 32 - scalar.len()]; word.extend_from_slice(scalar); word };
        let signature = k256::ecdsa::Signature::from_slice(&[pad(&items[10]), pad(&items[11])].concat()).unwrap();
        let recovery = k256::ecdsa::RecoveryId::from_byte(u8::from(!items[9].is_empty())).unwrap();
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(&digest, &signature, recovery).unwrap();
        assert_eq!(format!("0x{}", &hex_encode(&keccak256(&recovered.to_encoded_point(false).as_bytes()[1..])[12..])[2..]), address_of(&key), "{id}");
        raws.push((unsigned, raw));
    }
    for (index, left) in raws.iter().enumerate() {
        for right in &raws[index + 1..] {
            assert_ne!(left.0, right.0, "replay across chains would be possible");
            assert_ne!(left.1, right.1);
        }
    }
}

#[test]
fn balance_helpers_reject_malformed_chain_answers() {
    assert_eq!(quantity_decimal(&json!("0x0")).unwrap(), "0");
    assert_eq!(quantity_decimal(&json!("0xde0b6b3a7640000")).unwrap(), "1000000000000000000");
    for bad in [json!(null), json!("0x"), json!("0x01"), json!("12"), json!(5), json!(format!("0x{}", "f".repeat(33)))] {
        assert_eq!(quantity_decimal(&bad).unwrap_err(), "rpc_bad_response", "{bad}");
    }
    let word = |value: u128| format!("0x{}{:032x}", "0".repeat(32), value);
    assert_eq!(token_amount(&json!(word(5_000_000_000_000_000_000))).unwrap(), "5000000000000000000");
    assert!(token_amount(&json!("0x01")).is_err());
    assert!(token_amount(&json!(format!("0x{}", "f".repeat(64)))).is_err());
    assert!(token_amount(&Value::Null).is_err());
    let data = balance_of_data("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf").unwrap();
    assert_eq!(data, "0x70a082310000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf");
    assert!(balance_of_data("0x1234").is_err());
}

#[test]
fn known_tokens_are_only_on_allowlisted_mainnets_with_well_formed_addresses() {
    for token in KNOWN_TOKENS {
        assert!(chain_info(token.chain_id).is_some_and(|chain| chain.mainnet), "{}", token.chain_id);
        assert_eq!(token.address.len(), 42);
        assert!(hex_decode_fixed::<20>(token.address).is_some());
        assert_eq!(token.decimals, 18);
    }
    let on = |id: u64| KNOWN_TOKENS.iter().filter(|token| token.chain_id == id).map(|token| token.symbol).collect::<Vec<_>>();
    assert_eq!(on(43_114), ["JPYC"]);
    assert_eq!(on(137), ["JPYC"]);
    assert_eq!(on(1), ["JPYC"]);
    assert!(on(8_453).is_empty());
}
