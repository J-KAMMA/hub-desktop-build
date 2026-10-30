//! Commerce（`apps/commerce` Worker）と Identity への読み書き。
//!
//! 窓の CSP は `connect-src ipc:` だけなので、EC の通信は全部ここで畳む。
//! 宛先は env で変えられるが https かこの端末のループバックしか通さない。
//! ウォレットアドレスは窓の入力を信用せず、端末のキー保管庫から取る。
//! 生の配送先は Identity に留まり、このプロセスも窓も受け取らない——
//! 回ってくるのは署名済みの fulfillment assertion とマスク済みの宛先帯だけ。

use crate::checkpoint::CheckpointStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn commerce_base() -> Result<String, String> {
    let configured = std::env::var("HUB_COMMERCE_API_URL")
        .ok()
        .unwrap_or_else(|| "https://hub.jkamma.com/shopping/api/commerce".to_owned());
    checked_origin(&configured)
}

/// Commerce は Hub の下の `/shopping/api/commerce` でも提供される。許すパスはこれと空だけ。
const COMMERCE_PATH_PREFIX: &str = "/shopping/api/commerce";

fn identity_base() -> Result<String, String> {
    let configured = std::env::var("HUB_IDENTITY_API_URL")
        .ok()
        .unwrap_or_else(|| "http://127.0.0.1:8123".to_owned());
    checked_origin(&configured)
}

/// https またはループバック http 以外の宛先は拒否する。
fn checked_origin(raw: &str) -> Result<String, String> {
    let url =
        reqwest::Url::parse(raw.trim()).map_err(|_| "commerce_origin_invalid".to_owned())?;
    let https = url.scheme() == "https";
    let loopback = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !https && !loopback {
        return Err("commerce_origin_invalid".to_owned());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("commerce_origin_invalid".to_owned());
    }
    let path = url.path().trim_end_matches('/');
    let prefix = match path {
        "" => "",
        COMMERCE_PATH_PREFIX => COMMERCE_PATH_PREFIX,
        _ => return Err("commerce_origin_invalid".to_owned()),
    };
    Ok(format!("{}{prefix}", url.origin().ascii_serialization()))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "commerce_unavailable".to_owned())
}

async fn send_full(
    request: reqwest::RequestBuilder,
) -> Result<(reqwest::StatusCode, reqwest::header::HeaderMap, Value), String> {
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "commerce_timeout".to_owned()
        } else if error.is_connect() {
            "commerce_unreachable".to_owned()
        } else {
            "commerce_unavailable".to_owned()
        }
    })?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .bytes()
        .await
        .map_err(|_| "commerce_unavailable".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("commerce_response_too_large".to_owned());
    }
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Ok((status, headers, json))
}

async fn send(
    request: reqwest::RequestBuilder,
) -> Result<(reqwest::StatusCode, Value), String> {
    let (status, _, json) = send_full(request).await?;
    Ok((status, json))
}

/// CSVなどJSONでない応答をテキストで返す。MAX_BYTES上限は send_full と同じ。
async fn send_text(
    request: reqwest::RequestBuilder,
) -> Result<(reqwest::StatusCode, String), String> {
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "commerce_timeout".to_owned()
        } else if error.is_connect() {
            "commerce_unreachable".to_owned()
        } else {
            "commerce_unavailable".to_owned()
        }
    })?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "commerce_unavailable".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("commerce_response_too_large".to_owned());
    }
    Ok((status, body))
}

/// Commerceの書き込み経路は Origin を必須とする（CSRFゲート＋CORS許可）。
/// 名乗るのはクライアントの面——このアプリはHubのネイティブ面なので
/// Hubのオリジンを送る。Commerce自身のオリジンを送ってもCORS許可リストに
/// 無く403になる（Originは宛先ではなく出自を示すヘッダ）。
fn write_origin() -> String {
    crate::hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref())
}

fn post_json(url: String, body: Value) -> Result<reqwest::RequestBuilder, String> {
    Ok(client()?.post(url).header("origin", write_origin()).json(&body))
}

fn api_error(body: &Value) -> String {
    body.get("error")
        .and_then(Value::as_str)
        .unwrap_or("commerce_request_failed")
        .to_owned()
}

/// 商品一覧・支払い資産・決済状態をまとめて返す（全て公開読み取り）。
/// Query values the catalog list accepts. Anything else is refused before a request is made.
fn catalog_sort(value: Option<&str>) -> Result<Option<&'static str>, String> {
    match value.filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some("new") => Ok(Some("new")),
        Some("price_asc") => Ok(Some("price_asc")),
        Some("price_desc") => Ok(Some("price_desc")),
        Some(_) => Err("commerce_query_invalid".to_owned()),
    }
}
fn catalog_kind(value: Option<&str>) -> Result<Option<&'static str>, String> {
    match value.filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some("physical") => Ok(Some("physical")),
        Some("digital") => Ok(Some("digital")),
        Some("pickup") => Ok(Some("pickup")),
        Some(_) => Err("commerce_query_invalid".to_owned()),
    }
}

pub async fn catalog(
    query: Option<&str>,
    seller_id: Option<&str>,
    before: Option<&str>,
) -> Result<Value, String> {
    catalog_filtered(query, seller_id, before, None, None, None, None).await
}

pub async fn catalog_filtered(
    query: Option<&str>,
    seller_id: Option<&str>,
    before: Option<&str>,
    sort: Option<&str>,
    kind: Option<&str>,
    in_stock: Option<bool>,
    free_shipping: Option<bool>,
) -> Result<Value, String> {
    let sort = catalog_sort(sort)?;
    let kind = catalog_kind(kind)?;
    let base = commerce_base()?;
    let http = client()?;
    let mut request = http.get(format!("{base}/api/v1/products"));
    let mut params: Vec<(&str, &str)> = Vec::new();
    if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
        params.push(("q", q.trim()));
    }
    if let Some(id) = seller_id.filter(|id| !id.is_empty()) {
        params.push(("sellerId", id));
    }
    if let Some(cursor) = before.filter(|c| !c.is_empty()) {
        params.push(("before", cursor));
    }
    if let Some(sort) = sort {
        params.push(("sort", sort));
    }
    if let Some(kind) = kind {
        params.push(("kind", kind));
    }
    if in_stock == Some(true) {
        params.push(("inStock", "1"));
    }
    if free_shipping == Some(true) {
        params.push(("freeShipping", "1"));
    }
    if !params.is_empty() {
        request = request.query(&params);
    }
    let (status, products) = send(request).await?;
    if !status.is_success() {
        return Err(api_error(&products));
    }
    if !products.get("products").is_some_and(Value::is_array) {
        return Err("commerce_response_invalid".to_owned());
    }
    let available = |response: Result<(reqwest::StatusCode, Value), String>| {
        response
            .ok()
            .filter(|(status, _)| status.is_success())
            .map(|(_, body)| body)
    };
    let health = available(send(http.get(format!("{base}/api/v1/health"))).await);
    let assets = if health.as_ref().and_then(|body| body.get("paymentsEnabled"))
        == Some(&Value::Bool(true))
    {
        available(send(http.get(format!("{base}/api/v1/payment/assets"))).await)
    } else {
        None
    };
    Ok(catalog_payload(
        &products,
        health.as_ref(),
        assets.as_ref(),
    ))
}

fn product_offers_url(base: &str, id: &str, before: Option<&str>) -> Result<reqwest::Url, String> {
    if !crate::hub_client::catalog_product_id(id) {
        return Err("commerce_product_invalid".into());
    }
    let mut url=reqwest::Url::parse(&format!("{}/api/v1/products",checked_origin(base)?)).map_err(|_|"commerce_product_invalid")?;
    url.query_pairs_mut().append_pair("hubProductId",id);
    if let Some(cursor)=before {
        if cursor.is_empty()||cursor.len()>256||cursor.chars().any(char::is_control){return Err("commerce_product_invalid".into());}
        url.query_pairs_mut().append_pair("before",cursor);
    }
    Ok(url)
}
/// Fixed anonymous single-public-product read; the supplied ID is not a catalog ID.
pub async fn public_product(id: &str) -> Result<Value,String> {
    if id.is_empty()||id.len()>128||!id.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b)){return Err("commerce_product_invalid".into());}
    let base=commerce_base()?;
    let mut response=client()?.get(format!("{base}/api/v1/products/{id}")).send().await.map_err(|_|"commerce_unavailable")?;
    if !response.status().is_success(){return Err("commerce_unavailable".into());}
    let mut body=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"commerce_unavailable")? {
        if chunk.len()>MAX_BYTES-body.len(){return Err("commerce_response_too_large".into());}
        body.extend_from_slice(&chunk);
    }
    let value:Value=serde_json::from_slice(&body).map_err(|_|"commerce_response_invalid")?;
    if commerce_base()?!=base||value.get("product").and_then(|v|v.get("id")).and_then(Value::as_str)!=Some(id){return Err("commerce_response_invalid".into());}
    Ok(json!({"product":value["product"]}))
}
fn product_offers_payload(value: Value, id: &str) -> Result<Value,String> {
    let rows=value.get("products").and_then(Value::as_array).filter(|rows|rows.len()<=100).ok_or("commerce_response_invalid")?;
    let cursor=value.get("nextCursor").filter(|cursor|cursor.is_null()||cursor.as_str().is_some_and(|s|!s.is_empty()&&s.len()<=256&&!s.chars().any(char::is_control))).ok_or("commerce_response_invalid")?;
    if value.get("hubProductId").and_then(Value::as_str)!=Some(id){return Err("commerce_response_invalid".into());}
    Ok(json!({"hubProductId":id,"products":rows,"nextCursor":cursor}))
}
/// Public metadata only: no checkout, assertion, wallet or payment request.
pub async fn product_offers(id: &str, before: Option<&str>) -> Result<Value,String> {
    let base=commerce_base()?;
    let url=product_offers_url(&base,id,before)?;
    let mut response=client()?.get(url).send().await.map_err(|_|"commerce_unavailable")?;
    if !response.status().is_success(){return Err("commerce_unavailable".into());}
    let mut body=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"commerce_unavailable")? {
        if chunk.len()>MAX_BYTES-body.len(){return Err("commerce_response_too_large".into());}
        body.extend_from_slice(&chunk);
    }
    if commerce_base()?!=base{return Err("commerce_origin_changed".into());}
    let value=serde_json::from_slice(&body).map_err(|_|"commerce_response_invalid")?;
    product_offers_payload(value,id)
}
fn catalog_payload(products: &Value, health: Option<&Value>, assets: Option<&Value>) -> Value {
    let payment_assets = assets
        .and_then(|body| body.get("assets"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    json!({
        "products": products["products"],
        "nextCursor": products.get("nextCursor").cloned().unwrap_or(Value::Null),
        "sort": products.get("sort").cloned().unwrap_or(Value::Null),
        "paymentsEnabled": health.and_then(|body| body.get("paymentsEnabled")) == Some(&Value::Bool(true))
            && !payment_assets.is_empty(),
        "paymentAssets": payment_assets,
    })
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    #[test]
    fn catalog_query_values_are_allowlisted() {
        assert_eq!(catalog_sort(None), Ok(None));
        assert_eq!(catalog_sort(Some("")), Ok(None));
        assert_eq!(catalog_sort(Some("price_asc")), Ok(Some("price_asc")));
        assert_eq!(catalog_sort(Some("price_desc")), Ok(Some("price_desc")));
        assert_eq!(catalog_sort(Some("new")), Ok(Some("new")));
        assert_eq!(catalog_sort(Some("popular")), Err("commerce_query_invalid".to_owned()));
        assert_eq!(catalog_kind(Some("physical")), Ok(Some("physical")));
        assert_eq!(catalog_kind(Some("digital")), Ok(Some("digital")));
        assert_eq!(catalog_kind(Some("pickup")), Ok(Some("pickup")));
        assert_eq!(catalog_kind(Some("a&b=1")), Err("commerce_query_invalid".to_owned()));
    }

    #[test]
    fn product_browsing_survives_payment_status_failure() {
        let products = json!({"products": [{"id": "item-1"}], "nextCursor": "page-2"});
        let health = json!({"paymentsEnabled": true});
        let assets = json!({"assets": [{"networkKey": "amoy"}]});
        for result in [
            catalog_payload(&products, None, Some(&assets)),
            catalog_payload(&products, Some(&health), None),
        ] {
            assert_eq!(result["products"], products["products"]);
            assert_eq!(result["nextCursor"], "page-2");
            assert_eq!(result["paymentsEnabled"], false);
        }
        assert_eq!(
            catalog_payload(&products, Some(&health), Some(&assets))["paymentsEnabled"],
            true
        );
    }
}

/// Identity のデモ連携で配送先を確認し、Commerce 用の fulfillment
/// assertion を受け取る。窓にはアサーションと宛先帯だけを返す。
pub async fn fulfillment_quote(
    product_id: &str,
    fulfillment_mode: &str,
) -> Result<Value, String> {
    if !matches!(fulfillment_mode, "seller_shipping" | "platform_3pl") {
        return Err("invalid_fulfillment_mode".to_owned());
    }
    let base = identity_base()?;
    let http = client()?;
    let (status, demo) = send(http.get(format!("{base}/demo"))).await?;
    if !status.is_success() {
        return Err("identity_demo_unavailable".to_owned());
    }
    let commerce = demo.get("commerce").cloned().unwrap_or(Value::Null);
    let get = |key: &str| {
        commerce
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "identity_demo_unavailable".to_owned())
    };
    let (buyer, seller, address) = (
        get("buyer_account_id")?,
        get("seller_account_id")?,
        get("address_id")?,
    );
    let (status, quote) = send(
        http.post(format!("{base}/orders/quote"))
            .json(&json!({
                "buyer_account_id": buyer,
                "seller_account_id": seller,
                "product_id": product_id,
                "address_id": address,
                "payment_method": "JPYC",
                "fulfillment_mode": fulfillment_mode,
            })),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&quote));
    }
    if quote.get("decision").and_then(Value::as_str) != Some("allow") {
        return Err(quote
            .get("reason_code")
            .and_then(Value::as_str)
            .unwrap_or("identity_quote_blocked")
            .to_owned());
    }
    let assertion = quote
        .get("commerce_fulfillment_assertion")
        .and_then(Value::as_str)
        .ok_or_else(|| "identity_quote_unavailable".to_owned())?;
    Ok(json!({
        "assertion": assertion,
        "destinationZone": quote.get("destination_zone").and_then(Value::as_str).unwrap_or(""),
        "fulfillmentMode": quote.get("fulfillment_mode").and_then(Value::as_str).unwrap_or(""),
    }))
}

const CHECKOUT_INDEX_ID: &str = "650fbafa-7439-4ecb-9830-cd937f9fb2bf";
const CHECKOUT_MAX_ENTRIES: usize = 20;
const CHECKOUT_MAX_BYTES: usize = 1024 * 1024;
static CHECKOUT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CheckoutIndex {
    version: u8,
    requests: Vec<CheckoutRequest>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckoutRequest {
    operation_id: String,
    origin: String,
    body: String,
    order_id: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckoutBody {
    product_id: String,
    quantity: u64,
    buyer_wallet: String,
    billing_country: String,
    customer_type: String,
    payment_currency: String,
    payment_chain_id: u64,
    fulfillment_assertion: String,
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn canonical_operation_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.to_string() == value
            && id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
    })
}

fn valid_checkout_wallet(value: &str) -> bool {
    value.len() == 42
        && value.starts_with("0x")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
        && value.to_ascii_lowercase() == value
}

fn checked_checkout_body(body: &str) -> Result<CheckoutBody, String> {
    let value: CheckoutBody = serde_json::from_str(body).map_err(|_| "invalid_request")?;
    if !canonical_uuid(&value.product_id)
        || !(1..=20).contains(&value.quantity)
        || !valid_checkout_wallet(&value.buyer_wallet)
        || value.billing_country.len() != 2
        || !value
            .billing_country
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic())
        || value.customer_type != "consumer"
        || value.payment_currency.is_empty()
        || value.payment_currency.len() > 32
        || !value
            .payment_currency
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        || value.payment_chain_id == 0
        || value.payment_chain_id > 9_007_199_254_740_991
        || value.fulfillment_assertion.is_empty()
        || body.len() > CHECKOUT_MAX_BYTES
    {
        return Err("invalid_request".into());
    }
    if serde_json::to_string(&value).map_err(|_| "invalid_request")? != body {
        return Err("invalid_request".into());
    }
    Ok(value)
}

fn checkout_body(params: &Value, wallet: &str) -> Result<String, String> {
    let map = params.as_object().ok_or("invalid_request")?;
    if map.len() != 7
        || map.keys().any(|key| {
            !matches!(
                key.as_str(),
                "operationId"
                    | "productId"
                    | "quantity"
                    | "billingCountry"
                    | "paymentCurrency"
                    | "paymentChainId"
                    | "fulfillmentAssertion"
            )
        })
    {
        return Err("invalid_request".into());
    }
    let text = |key: &str| {
        map.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or("invalid_request")
    };
    let body = CheckoutBody {
        product_id: text("productId")?,
        quantity: map
            .get("quantity")
            .and_then(Value::as_u64)
            .ok_or("invalid_request")?,
        buyer_wallet: wallet.to_owned(),
        billing_country: text("billingCountry")?,
        customer_type: "consumer".into(),
        payment_currency: text("paymentCurrency")?,
        payment_chain_id: map
            .get("paymentChainId")
            .and_then(Value::as_u64)
            .ok_or("invalid_request")?,
        fulfillment_assertion: text("fulfillmentAssertion")?,
    };
    let encoded = serde_json::to_string(&body).map_err(|_| "invalid_request")?;
    checked_checkout_body(&encoded)?;
    Ok(encoded)
}

fn checkout_store() -> Result<(std::fs::File, CheckpointStore), String> {
    let guard = CheckpointStore::lock_named("commerce-checkouts").map_err(|error| {
        if error == "checkpoint_lock_busy" {
            "checkout_store_busy"
        } else {
            "checkout_store_unavailable"
        }
    })?;
    let store = CheckpointStore::with_key("commerce-checkouts", "commerce-checkout-key-v1")
        .map_err(|_| "checkout_store_unavailable")?;
    Ok((guard, store))
}

fn load_checkouts(store: &CheckpointStore) -> Result<CheckoutIndex, String> {
    let index: CheckoutIndex = store
        .load_optional_bounded(CHECKOUT_INDEX_ID, CHECKOUT_MAX_BYTES)
        .map_err(|_| "checkout_store_invalid")?
        .unwrap_or(CheckoutIndex {
            version: 1,
            requests: Vec::new(),
        });
    if index.version != 1 || index.requests.len() > CHECKOUT_MAX_ENTRIES {
        return Err("checkout_store_invalid".into());
    }
    let mut seen = std::collections::HashSet::new();
    for request in &index.requests {
        if !canonical_operation_uuid(&request.operation_id)
            || !seen.insert(&request.operation_id)
            || checked_origin(&request.origin).as_ref() != Ok(&request.origin)
            || request
                .order_id
                .as_deref()
                .is_some_and(|id| !canonical_uuid(id))
            || request
                .access_token
                .as_deref()
                .is_some_and(|token| !valid_checkout_token(token) || request.order_id.is_none())
            || checked_checkout_body(&request.body).is_err()
        {
            return Err("checkout_store_invalid".into());
        }
    }
    Ok(index)
}

fn save_checkouts(store: &CheckpointStore, index: &CheckoutIndex) -> Result<(), String> {
    let encoded = serde_json::to_vec(index).map_err(|_| "checkout_store_invalid")?;
    if index.requests.len() > CHECKOUT_MAX_ENTRIES || encoded.len() > CHECKOUT_MAX_BYTES {
        return Err("checkout_store_limit".into());
    }
    store
        .save(CHECKOUT_INDEX_ID, index)
        .map_err(|_| "checkout_store_unavailable".into())
}

fn checkout_binding(index: &CheckoutIndex, origin: &str, wallet: &str) -> Result<(), String> {
    if checked_origin(origin).ok().as_deref() != Some(origin) || !valid_checkout_wallet(wallet) {
        return Err("checkout_binding_mismatch".into());
    }
    for request in &index.requests {
        let body = checked_checkout_body(&request.body).map_err(|_| "checkout_store_invalid")?;
        if request.origin != origin || body.buyer_wallet != wallet {
            return Err("checkout_binding_mismatch".into());
        }
    }
    Ok(())
}

fn prepare_checkout(
    store: &CheckpointStore,
    index: &mut CheckoutIndex,
    params: &Value,
    origin: &str,
    wallet: &str,
) -> Result<CheckoutRequest, String> {
    let map = params.as_object().ok_or("invalid_request")?;
    let operation_id = map
        .get("operationId")
        .and_then(Value::as_str)
        .ok_or("invalid_request")?;
    if !canonical_operation_uuid(operation_id) {
        return Err("invalid_request".into());
    }
    checkout_binding(index, origin, wallet)?;
    if let Some(saved) = index
        .requests
        .iter()
        .find(|request| request.operation_id == operation_id)
    {
        if map.len() != 1 && checkout_body(params, wallet)? != saved.body {
            return Err("checkout_request_conflict".into());
        }
        return Ok(saved.clone());
    }
    if map.len() == 1 {
        return Err("checkout_operation_unknown".into());
    }
    let body = checkout_body(params, wallet)?;
    let product = checked_checkout_body(&body)?.product_id;
    if index.requests.iter().any(|saved| {
        checked_checkout_body(&saved.body).is_ok_and(|body| body.product_id == product)
    }) {
        return Err("checkout_pending_exists".into());
    }
    let request = CheckoutRequest {
        operation_id: operation_id.to_owned(),
        origin: origin.to_owned(),
        body,
        order_id: None,
        access_token: None,
    };
    let mut next = index.clone();
    next.requests.push(request.clone());
    save_checkouts(store, &next)?;
    *index = next;
    Ok(request)
}

fn checkout_response_identity(request: &CheckoutRequest, body: &Value) -> Result<String, String> {
    let expected = checked_checkout_body(&request.body).map_err(|_| "checkout_store_invalid")?;
    let order = body.get("order").ok_or("checkout_response_invalid")?;
    let id = order
        .get("id")
        .and_then(Value::as_str)
        .ok_or("checkout_response_invalid")?;
    if !canonical_uuid(id)
        || request.order_id.as_deref().is_some_and(|known| known != id)
        || order.get("productId").and_then(Value::as_str) != Some(expected.product_id.as_str())
        || order.get("quantity").and_then(Value::as_u64) != Some(expected.quantity)
        || order.get("chainId").and_then(Value::as_u64) != Some(expected.payment_chain_id)
        || order.get("currency").and_then(Value::as_str) != Some(expected.payment_currency.as_str())
        || order
            .get("buyerWallet")
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase)
            != Some(expected.buyer_wallet)
        || order.get("status").and_then(Value::as_str).is_none()
    {
        return Err("checkout_response_invalid".into());
    }
    Ok(id.to_owned())
}

fn valid_checkout_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 4096 && !token.chars().any(char::is_control)
}

fn checkout_token(body: &Value) -> Result<&str, String> {
    body.pointer("/order/accessToken")
        .and_then(Value::as_str)
        .filter(|token| valid_checkout_token(token))
        .ok_or_else(|| "checkout_response_invalid".into())
}

fn checkout_terminal(status: &str) -> bool {
    matches!(
        status,
        "submitted"
            | "paid"
            | "partially_refunded"
            | "refunded"
            | "payment_failed"
            | "expired"
            | "cancelled"
    )
}

fn checkout_expired_read(body: &Value, now_ms: i64) -> bool {
    body.pointer("/order/status").and_then(Value::as_str) == Some("awaiting_payment")
        && body.pointer("/order/transactionHash") == Some(&Value::Null)
        && body
            .pointer("/order/expiresAt")
            .and_then(Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_some_and(|value| value.timestamp_millis() <= now_ms)
}

fn checkout_is_expired_response(status: reqwest::StatusCode, body: &Value) -> bool {
    status == reqwest::StatusCode::CONFLICT
        && body.get("error").and_then(Value::as_str) == Some("checkout_expired")
        && body.get("paymentActionAvailable") == Some(&Value::Bool(false))
        && body.pointer("/order/status").and_then(Value::as_str) == Some("expired")
}

fn checked_checkout_result(
    request: &CheckoutRequest,
    status: reqwest::StatusCode,
    mut body: Value,
    expired: bool,
    now_ms: i64,
) -> Result<(String, Value), String> {
    let id = checkout_response_identity(request, &body)?;
    if expired && checkout_expired_read(&body, now_ms) {
        body["order"]["status"] = json!("expired");
    }
    let order_status = body
        .pointer("/order/status")
        .and_then(Value::as_str)
        .ok_or("checkout_response_invalid")?;
    let status_only = expired || body.get("paymentActionAvailable") == Some(&Value::Bool(false));
    if (status_only && !checkout_terminal(order_status) && order_status != "confirming")
        || (!status_only && order_status != "awaiting_payment")
        || (!status_only
            && status != reqwest::StatusCode::CREATED
            && body.get("paymentActionAvailable") != Some(&Value::Bool(true)))
        || body
            .get("paymentActionAvailable")
            .is_some_and(|flag| !flag.is_boolean())
    {
        return Err("checkout_response_invalid".into());
    }
    Ok((
        id,
        if status_only {
            checkout_status_only(&body)
        } else {
            body
        },
    ))
}

fn checkout_status_only(body: &Value) -> Value {
    let mut order = serde_json::Map::new();
    for key in [
        "id",
        "productId",
        "quantity",
        "status",
        "chainId",
        "currency",
        "amountJpyc",
        "taxJpyc",
        "expiresAt",
        "paidAt",
        "accessToken",
    ] {
        if let Some(value) = body["order"].get(key) {
            order.insert(key.to_owned(), value.clone());
        }
    }
    json!({"order": order, "replayed": true, "paymentActionAvailable": false})
}

fn record_checkout_order(
    store: &CheckpointStore,
    index: &mut CheckoutIndex,
    operation_id: &str,
    id: &str,
    token: &str,
) -> Result<(), String> {
    if !canonical_uuid(id) || !valid_checkout_token(token) {
        return Err("checkout_response_invalid".into());
    }
    let mut next = index.clone();
    let record = next
        .requests
        .iter_mut()
        .find(|request| request.operation_id == operation_id)
        .ok_or("checkout_operation_unknown")?;
    if record.order_id.as_deref().is_some_and(|known| known != id) {
        return Err("checkout_response_invalid".into());
    }
    record.order_id = Some(id.to_owned());
    record.access_token = Some(token.to_owned());
    save_checkouts(store, &next)?;
    *index = next;
    Ok(())
}

fn checkout_post(request: &CheckoutRequest) -> Result<reqwest::RequestBuilder, String> {
    Ok(client()?
        .post(format!("{}/api/v1/orders", request.origin))
        .header("origin", write_origin())
        .header("idempotency-key", &request.operation_id)
        .header("content-type", "application/json")
        .body(request.body.clone()))
}

/// Save the exact native-bound request before sending. An uncertain response
/// never deletes it or retries automatically; replay uses its original bytes.
pub async fn order_create(params: &Value) -> Result<Value, String> {
    let _guard = CHECKOUT_LOCK.lock().await;
    let (_store_guard, store) = checkout_store()?;
    let mut index = load_checkouts(&store)?;
    let wallet = crate::desktop_wallet::wallet_address()?;
    let origin = commerce_base()?;
    let request = prepare_checkout(&store, &mut index, params, &origin, &wallet)?;
    let (status, mut body) = send(checkout_post(&request)?).await?;
    let expired = checkout_is_expired_response(status, &body);
    if !status.is_success() && !expired {
        return Err("commerce_request_failed".into());
    }
    let token = checkout_token(&body)?.to_owned();
    if expired {
        let id = body
            .pointer("/order/id")
            .and_then(Value::as_str)
            .filter(|id| canonical_uuid(id))
            .ok_or("checkout_response_invalid")?;
        if request.order_id.as_deref().is_some_and(|known| known != id) {
            return Err("checkout_response_invalid".into());
        }
        let (checked_status, mut checked) = send(
            client()?
                .get(format!("{}/api/v1/orders/{id}", request.origin))
                .bearer_auth(&token),
        )
        .await?;
        if !checked_status.is_success()
            || checked.pointer("/order/id").and_then(Value::as_str) != Some(id)
        {
            return Err("checkout_response_invalid".into());
        }
        checked["order"]["accessToken"] = json!(token);
        body = checked;
    }
    let (id, result) = checked_checkout_result(
        &request,
        status,
        body,
        expired,
        chrono::Utc::now().timestamp_millis(),
    )?;
    record_checkout_order(&store, &mut index, &request.operation_id, &id, &token)?;
    put_order_token(&store, &id, &token, chrono::Utc::now().timestamp_millis())?;
    Ok(result)
}

/// Public metadata only. An unreadable index or another wallet/origin cannot
/// appear as an empty checkout list and permit an accidental fresh checkout.
pub async fn checkout_pending() -> Result<Value, String> {
    let _guard = CHECKOUT_LOCK.lock().await;
    let (_store_guard, store) = checkout_store()?;
    let index = load_checkouts(&store)?;
    if index.requests.is_empty() {
        return Ok(json!({"requests": []}));
    }
    checkout_binding(
        &index,
        &commerce_base()?,
        &crate::desktop_wallet::wallet_address()?,
    )?;
    pending_checkout_payload(&index)
}

fn pending_checkout_payload(index: &CheckoutIndex) -> Result<Value, String> {
    let requests = index
        .requests
        .iter()
        .map(|request| {
            let body =
                checked_checkout_body(&request.body).map_err(|_| "checkout_store_invalid")?;
            Ok(
                json!({"operationId": request.operation_id, "productId": body.product_id,
            "quantity": body.quantity, "billingCountry": body.billing_country,
            "paymentCurrency": body.payment_currency, "paymentChainId": body.payment_chain_id,
            "orderId": request.order_id}),
            )
        })
        .collect::<Result<Vec<Value>, String>>()?;
    Ok(json!({"requests": requests}))
}

fn finish_checkout(
    store: &CheckpointStore,
    index: &mut CheckoutIndex,
    operation_id: &str,
    body: &Value,
    now_ms: i64,
) -> Result<Value, String> {
    if !canonical_operation_uuid(operation_id) {
        return Err("invalid_request".into());
    }
    let record = index
        .requests
        .iter()
        .find(|request| request.operation_id == operation_id)
        .ok_or("checkout_operation_unknown")?;
    if record.order_id.is_none() {
        return Err("checkout_order_unresolved".into());
    }
    checkout_response_identity(record, body)?;
    if !body
        .pointer("/order/status")
        .and_then(Value::as_str)
        .is_some_and(checkout_terminal)
        && !checkout_expired_read(body, now_ms)
    {
        return Err("checkout_not_finished".into());
    }
    let mut next = index.clone();
    next.requests
        .retain(|request| request.operation_id != operation_id);
    save_checkouts(store, &next)?;
    *index = next;
    Ok(json!({"finished": true}))
}

/// Explicit cleanup requires an authoritative GET and the native order token.
pub async fn checkout_finish(operation_id: &str) -> Result<Value, String> {
    if !canonical_operation_uuid(operation_id) {
        return Err("invalid_request".into());
    }
    let _guard = CHECKOUT_LOCK.lock().await;
    let (_store_guard, store) = checkout_store()?;
    let mut index = load_checkouts(&store)?;
    checkout_binding(
        &index,
        &commerce_base()?,
        &crate::desktop_wallet::wallet_address()?,
    )?;
    let record = index
        .requests
        .iter()
        .find(|request| request.operation_id == operation_id)
        .ok_or("checkout_operation_unknown")?;
    let id = record
        .order_id
        .as_deref()
        .ok_or("checkout_order_unresolved")?;
    let token = match &record.access_token {
        Some(token) => token.clone(),
        None => order_access_token_in(&store, id, "")?,
    };
    let (status, body) = send(
        client()?
            .get(format!("{}/api/v1/orders/{id}", record.origin))
            .bearer_auth(token),
    )
    .await?;
    if !status.is_success() {
        return Err("commerce_request_failed".into());
    }
    finish_checkout(
        &store,
        &mut index,
        operation_id,
        &body,
        chrono::Utc::now().timestamp_millis(),
    )
}

// -------------------------------------------------- 注文トークンの保管庫
// 注文ごとの閲覧・操作トークン。暗号化済みの `commerce-checkouts` に、
// 決済の途中経過とは別のレコードとして置く（鍵はAES-256-GCM、鍵束の
// `commerce-checkout-key-v1`）。以前は鍵束の1項目に50件をまとめており、
// 資格情報マネージャーの上限（約2.5 KB）を超えると保存が黙って失敗した。

const ORDER_TOKENS_ID: &str = "3b1c6f0e-5a7d-4e19-9c42-8d0f2a6b7e31";
const ORDER_TOKENS_MAX_ENTRIES: usize = 50;
const ORDER_TOKENS_MAX_BYTES: usize = 256 * 1024;
static ORDER_TOKENS_MIGRATED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrderTokenEntry {
    order_id: String,
    token: String,
    saved_at_ms: i64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct OrderTokenIndex {
    version: u8,
    entries: Vec<OrderTokenEntry>,
}

fn load_order_tokens(store: &CheckpointStore) -> Result<OrderTokenIndex, String> {
    let index: OrderTokenIndex = store
        .load_optional_bounded(ORDER_TOKENS_ID, ORDER_TOKENS_MAX_BYTES)
        .map_err(|_| "order_token_store_invalid")?
        .unwrap_or(OrderTokenIndex {
            version: 1,
            entries: Vec::new(),
        });
    if index.version != 1 || index.entries.len() > ORDER_TOKENS_MAX_ENTRIES {
        return Err("order_token_store_invalid".into());
    }
    Ok(index)
}

fn save_order_tokens(store: &CheckpointStore, index: &OrderTokenIndex) -> Result<(), String> {
    store
        .save(ORDER_TOKENS_ID, index)
        .map_err(|_| "order_token_store_unavailable".to_owned())
}

/// Oldest `saved_at_ms` first; the entry for `keep` is never a candidate, so a
/// token saved just now cannot be dropped even if its clock stamp is oldest.
fn trim_order_tokens(index: &mut OrderTokenIndex, keep: Option<&str>) {
    while index.entries.len() > ORDER_TOKENS_MAX_ENTRIES {
        let oldest = index
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| Some(entry.order_id.as_str()) != keep)
            .min_by_key(|(_, entry)| entry.saved_at_ms)
            .map(|(position, _)| position);
        match oldest {
            Some(position) => {
                index.entries.remove(position);
            }
            None => break,
        }
    }
}

fn put_order_token(
    store: &CheckpointStore,
    order_id: &str,
    token: &str,
    now_ms: i64,
) -> Result<(), String> {
    let mut index = load_order_tokens(store)?;
    index.entries.retain(|entry| entry.order_id != order_id);
    index.entries.push(OrderTokenEntry {
        order_id: order_id.to_owned(),
        token: token.to_owned(),
        saved_at_ms: now_ms,
    });
    trim_order_tokens(&mut index, Some(order_id));
    save_order_tokens(store, &index)
}

fn get_order_token(store: &CheckpointStore, order_id: &str) -> Result<Option<String>, String> {
    Ok(load_order_tokens(store)?
        .entries
        .into_iter()
        .find(|entry| entry.order_id == order_id)
        .map(|entry| entry.token))
}

/// One-time move of the old keyring blob. The keyring entry is deleted only
/// after the new record was written; any failure leaves it for the next try.
/// `legacy` returns None when the entry does not exist.
fn migrate_order_tokens(
    store: &CheckpointStore,
    legacy: impl FnOnce() -> Result<Option<String>, String>,
    delete_legacy: impl FnOnce() -> Result<(), String>,
    now_ms: i64,
) -> Result<(), String> {
    let Some(raw) = legacy()? else {
        return Ok(());
    };
    let map = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or("order_token_migration_invalid")?;
    let mut index = load_order_tokens(store)?;
    for (order_id, token) in &map {
        let Some(token) = token.as_str() else { continue };
        if !canonical_uuid(order_id)
            || !valid_checkout_token(token)
            || index.entries.iter().any(|entry| &entry.order_id == order_id)
        {
            continue;
        }
        // The old blob kept no times; stamp them older than anything new.
        index.entries.push(OrderTokenEntry {
            order_id: order_id.clone(),
            token: token.to_owned(),
            saved_at_ms: now_ms.min(0),
        });
    }
    trim_order_tokens(&mut index, None);
    save_order_tokens(store, &index)?;
    delete_legacy()
}

fn legacy_order_tokens_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("jkamma-hub", "commerce-order-tokens")
        .map_err(|_| "credential_store_unavailable".to_owned())
}

fn ensure_order_tokens_migrated(store: &CheckpointStore) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if ORDER_TOKENS_MIGRATED.load(Ordering::Relaxed) {
        return Ok(());
    }
    migrate_order_tokens(
        store,
        || match legacy_order_tokens_entry()?.get_password() {
            Ok(raw) => Ok(Some(raw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("credential_store_unavailable".to_owned()),
        },
        || match legacy_order_tokens_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("credential_store_unavailable".to_owned()),
        },
        0,
    )?;
    ORDER_TOKENS_MIGRATED.store(true, Ordering::Relaxed);
    Ok(())
}

/// Store-held variant for callers that already hold the checkout lock.
fn order_access_token_in(
    store: &CheckpointStore,
    order_id: &str,
    provided: &str,
) -> Result<String, String> {
    ensure_order_tokens_migrated(store)?;
    if !provided.is_empty() {
        put_order_token(store, order_id, provided, chrono::Utc::now().timestamp_millis())?;
        return Ok(provided.to_owned());
    }
    get_order_token(store, order_id)?.ok_or_else(|| "order_token_unavailable".to_owned())
}

/// 窓から来たトークンがあればそれを使い、無ければ保管庫から引く。
/// 引けたトークンは保管庫へも入れる（セッション保持分の永続化）。
async fn order_access_token(order_id: &str, provided: &str) -> Result<String, String> {
    let _guard = CHECKOUT_LOCK.lock().await;
    let (_store_guard, store) = checkout_store()?;
    order_access_token_in(&store, order_id, provided)
}

/// 送金txをCommerceへ提出して照合させる。
pub async fn order_submit(
    order_id: &str,
    access_token: &str,
    transaction_hash: &str,
) -> Result<Value, String> {
    let token = order_access_token(order_id, access_token).await?;
    let base = commerce_base()?;
    let (status, body) = send(
        client()?
            .post(format!("{base}/api/v1/orders/{order_id}/submit"))
            .header("origin", write_origin())
            .bearer_auth(token)
            .json(&json!({ "transactionHash": transaction_hash })),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 注文状態の読み戻し（access token必須）。注文・履歴・エスクロー・
/// 返品の全てがここへ返る。
pub async fn order_status(order_id: &str, access_token: &str) -> Result<Value, String> {
    let token = order_access_token(order_id, access_token).await?;
    let base = commerce_base()?;
    let (status, body) = send(
        client()?
            .get(format!("{base}/api/v1/orders/{order_id}"))
            .bearer_auth(token),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 未確定注文のキャンセル（作成したが払わなかった場合の掃除）。
pub async fn order_cancel(order_id: &str, access_token: &str) -> Result<Value, String> {
    let token = order_access_token(order_id, access_token).await?;
    let base = commerce_base()?;
    let (status, body) = send(
        client()?
            .delete(format!("{base}/api/v1/orders/{order_id}"))
            .header("origin", write_origin())
            .bearer_auth(token),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// Commerce発行の領収書JSON。窓はそのまま表示・コピーに使う。
pub async fn order_receipt(order_id: &str, access_token: &str) -> Result<Value, String> {
    let token = order_access_token(order_id, access_token).await?;
    let base = commerce_base()?;
    let (status, body) = send(
        client()?
            .get(format!("{base}/api/v1/orders/{order_id}/receipt"))
            .bearer_auth(token),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

// ------------------------------------------------------------- エスクロー
// 受取確認・未発送返金・異議・解決案の合意。操作のcalldataはCommerceが
// 組み立て、送信はウォレットの確認モーダルを通す——ここは準備と照合だけ。

pub async fn escrow_action_prepare(
    order_id: &str,
    access_token: &str,
    params: &Value,
) -> Result<Value, String> {
    let token = order_access_token(order_id, access_token).await?;
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid_escrow_action".to_owned())?;
    let mut payload = json!({ "action": action });
    for key in ["buyerAmountAtomic", "sellerAmountAtomic"] {
        if let Some(value) = params.get(key).and_then(Value::as_str) {
            payload[key] = json!(value);
        }
    }
    let base = commerce_base()?;
    let (status, body) = send(
        post_json(
            format!("{base}/api/v1/orders/{order_id}/escrow/actions"),
            payload,
        )?
        .bearer_auth(token),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

pub async fn escrow_action_submit(
    order_id: &str,
    access_token: &str,
    params: &Value,
) -> Result<Value, String> {
    let token = order_access_token(order_id, access_token).await?;
    let tx = params
        .get("transactionHash")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid_transaction_hash".to_owned())?;
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid_escrow_action".to_owned())?;
    let mut payload = json!({ "action": action, "transactionHash": tx });
    for key in ["buyerAmountAtomic", "sellerAmountAtomic"] {
        if let Some(value) = params.get(key).and_then(Value::as_str) {
            payload[key] = json!(value);
        }
    }
    let base = commerce_base()?;
    let (status, body) = send(
        post_json(
            format!("{base}/api/v1/orders/{order_id}/escrow/actions/submit"),
            payload,
        )?
        .bearer_auth(token),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

// ----------------------------------------------------------------- 返品

pub async fn return_request(
    order_id: &str,
    access_token: &str,
    reason_code: &str,
    detail: &str,
) -> Result<Value, String> {
    let token = order_access_token(order_id, access_token).await?;
    if reason_code.trim().is_empty() || detail.chars().count() > 1000 {
        return Err("invalid_request".to_owned());
    }
    let base = commerce_base()?;
    let (status, body) = send(
        post_json(
            format!("{base}/api/v1/orders/{order_id}/returns"),
            json!({
                "reasonCode": reason_code,
                "detail": if detail.trim().is_empty() { Value::Null } else { json!(detail.trim()) },
            }),
        )?
        .bearer_auth(token),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

pub async fn return_shipment(
    order_id: &str,
    access_token: &str,
    carrier: &str,
    tracking_number: &str,
) -> Result<Value, String> {
    let token = order_access_token(order_id, access_token).await?;
    if carrier.trim().is_empty() || tracking_number.trim().is_empty() {
        return Err("invalid_request".to_owned());
    }
    let base = commerce_base()?;
    let (status, body) = send(
        client()?
            .patch(format!("{base}/api/v1/orders/{order_id}/returns/shipment"))
            .header("origin", write_origin())
            .bearer_auth(token)
            .json(&json!({ "shippingCarrier": carrier.trim(), "trackingNumber": tracking_number.trim() })),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

// ------------------------------------------------------------- 出品者面
// 販売者セッションはCommerceのCookieトークン。資格情報保管庫へ置き、
// 窓へは出さない。 Identity の出品者アサーションは開発環境のデモ経路
// （ループバック限定）から取得する——本番の出品者登録はAccount認証と
// 審査が要るため、Web版へ手渡す。

const SELLER_COOKIE: &str = "jkamma_commerce_seller";

fn seller_session_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("jkamma-hub", "commerce-seller-session")
        .map_err(|_| "credential_store_unavailable".to_owned())
}

fn store_seller_session(token: &str, seller: &Value, expires_at: &str) {
    let _ = seller_session_entry().and_then(|entry| {
        entry
            .set_password(
                &json!({ "token": token, "seller": seller, "expiresAt": expires_at }).to_string(),
            )
            .map_err(|_| "x".to_owned())
    });
}

fn seller_session() -> Result<Value, String> {
    let raw = seller_session_entry()?
        .get_password()
        .map_err(|_| "seller_unauthorized".to_owned())?;
    let session: Value = serde_json::from_str(&raw).map_err(|_| "seller_unauthorized".to_owned())?;
    if session
        .get("expiresAt")
        .and_then(Value::as_str)
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.timestamp_millis() <= chrono::Utc::now().timestamp_millis())
        .unwrap_or(true)
    {
        return Err("seller_session_expired".to_owned());
    }
    Ok(session)
}

fn seller_session_token() -> Result<String, String> {
    seller_session()?
        .get("token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "seller_unauthorized".to_owned())
}

fn seller_cookie(request: reqwest::RequestBuilder) -> Result<reqwest::RequestBuilder, String> {
    Ok(request.header("cookie", format!("{SELLER_COOKIE}={}", seller_session_token()?)))
}

/// Set-Cookie ヘッダからセッショントークンを取り出す。
fn seller_token_from_headers(headers: &reqwest::header::HeaderMap) -> Result<String, String> {
    for value in headers.get_all(reqwest::header::SET_COOKIE).iter() {
        let Ok(text) = value.to_str() else { continue };
        if let Some(rest) = text.split(';').next() {
            if let Some(token) = rest.trim().strip_prefix(&format!("{SELLER_COOKIE}=")) {
                let token = token.trim();
                if !token.is_empty() {
                    return Ok(percent_decode(token));
                }
            }
        }
    }
    Err("seller_session_unavailable".to_owned())
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = bytes[i] == b'%'
            && i + 2 < bytes.len()
            && u8::from_str_radix(&input[i + 1..i + 3], 16).is_ok();
        if decoded {
            out.push(u8::from_str_radix(&input[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_owned())
}

/// Identity の開発用デモ出品者アサーション。本番や未seed環境では404。
async fn dev_seller_assertion() -> Result<String, String> {
    let base = identity_base()?;
    let (status, body) = send(
        client()?.post(format!("{base}/dev/commerce/seller-assertion")),
    )
    .await?;
    if !status.is_success() {
        return Err("seller_assertion_unavailable".to_owned());
    }
    body.get("assertion")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "seller_assertion_unavailable".to_owned())
}

/// 出品者状態。ログイン済みなら店舗情報を返す。
pub fn seller_state() -> Result<Value, String> {
    match seller_session() {
        Ok(session) => Ok(json!({
            "loggedIn": true,
            "seller": session.get("seller").cloned().unwrap_or(Value::Null),
            "expiresAt": session.get("expiresAt").cloned().unwrap_or(Value::Null),
        })),
        Err(_) => Ok(json!({ "loggedIn": false })),
    }
}

/// 既登録の出品者としてログイン（seller assertion → session）。
pub async fn seller_login() -> Result<Value, String> {
    let assertion = dev_seller_assertion().await?;
    let base = commerce_base()?;
    let (status, headers, body) = send_full(
        post_json(
            format!("{base}/api/v1/seller/session"),
            json!({ "identityAssertion": assertion }),
        )?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    let token = seller_token_from_headers(&headers)?;
    store_seller_session(
        &token,
        body.get("seller").unwrap_or(&Value::Null),
        body.get("expiresAt").and_then(Value::as_str).unwrap_or(""),
    );
    Ok(json!({
        "seller": body.get("seller").cloned().unwrap_or(Value::Null),
        "expiresAt": body.get("expiresAt").cloned().unwrap_or(Value::Null),
    }))
}

/// 出品者登録の challenge。返す message をウォレット署名へ回す。
/// 受取ウォレットは窓の入力ではなく端末の鍵から引く。
pub async fn seller_onboarding_challenge(params: &Value) -> Result<Value, String> {
    let public_name = params
        .get("publicName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let legal_url = params
        .get("legalDisplayUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if public_name.is_empty()
        || public_name.chars().count() > 100
        || !legal_url.starts_with("https://")
    {
        return Err("invalid_request".to_owned());
    }
    let wallet = crate::desktop_wallet::wallet_address()?;
    let assertion = dev_seller_assertion().await?;
    let base = commerce_base()?;
    let (status, body) = send(
        post_json(
            format!("{base}/api/v1/seller/onboarding/challenge"),
            json!({
                "identityAssertion": assertion,
                "publicName": public_name,
                "payoutWallet": wallet,
                "legalDisplayUrl": legal_url,
            }),
        )?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 出品者登録の完了。challenge message を確認モーダル経由で署名する。
pub async fn seller_onboarding_complete(
    app: &tauri::AppHandle,
    challenge_id: &str,
    message: &str,
) -> Result<Value, String> {
    let signature = crate::desktop_wallet::sign_message_confirmed(
        app,
        "販売者登録: 受取ウォレットの所有確認",
        message,
    )
    .await?;
    let base = commerce_base()?;
    let (status, headers, body) = send_full(
        post_json(
            format!("{base}/api/v1/seller/onboarding/complete"),
            json!({ "challengeId": challenge_id, "signature": signature }),
        )?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    let token = seller_token_from_headers(&headers)?;
    store_seller_session(
        &token,
        body.get("seller").unwrap_or(&Value::Null),
        body.get("expiresAt").and_then(Value::as_str).unwrap_or(""),
    );
    Ok(json!({
        "seller": body.get("seller").cloned().unwrap_or(Value::Null),
        "expiresAt": body.get("expiresAt").cloned().unwrap_or(Value::Null),
    }))
}

/// 出品者ログアウト。サーバ側のセッションも無効化する。
pub async fn seller_logout() -> Result<(), String> {
    if let Ok(token) = seller_session_token() {
        let base = commerce_base()?;
        let _ = send(
            client()?
                .delete(format!("{base}/api/v1/seller/session"))
                .header("origin", write_origin())
                .header("cookie", format!("{SELLER_COOKIE}={token}")),
        )
        .await;
    }
    if let Ok(entry) = seller_session_entry() {
        let _ = entry.delete_credential();
    }
    Ok(())
}

/// 出品者の商品一覧。
pub async fn seller_products(before: Option<&str>) -> Result<Value, String> {
    let base = commerce_base()?;
    let mut request =
        client()?.get(format!("{base}/api/v1/seller/products"));
    if let Some(cursor) = before {
        request = request.query(&[("before", cursor)]);
    }
    let (status, body) = send(seller_cookie(request)?).await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 出品者の商品作成/更新。id があれば PATCH、無ければ POST。
pub async fn seller_product_save(params: &Value) -> Result<Value, String> {
    let base = commerce_base()?;
    let product_id = params.get("id").and_then(Value::as_str).unwrap_or("");
    let mut fields = params.clone();
    if let Some(map) = fields.as_object_mut() {
        map.remove("id");
    }
    let (status, body) = if product_id.is_empty() {
        send(seller_cookie(post_json(
            format!("{base}/api/v1/seller/products"),
            fields,
        )?)?)
        .await?
    } else {
        send(seller_cookie(
            client()?
                .patch(format!("{base}/api/v1/seller/products/{product_id}"))
                .header("origin", write_origin())
                .json(&fields),
        )?)
        .await?
    };
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 出品者の注文一覧（発送登録待ちを含む）。200件ごとに before カーソルで辿る。
/// purpose は Commerce の公開値だけを通す——既定は発送管理向けの物理注文、
/// "refunds" は返金対象となった全注文、"digital" はデジタル売上。
pub async fn seller_orders(before: Option<&str>, purpose: Option<&str>) -> Result<Value, String> {
    let base = commerce_base()?;
    let url = format!("{base}/api/v1/seller/orders");
    let mut request = client()?.get(url);
    let mut params: Vec<(&str, &str)> = Vec::new();
    if let Some(cursor) = before {
        params.push(("before", cursor));
    }
    if let Some(scope) = purpose.filter(|p| !p.is_empty()) {
        if !matches!(scope, "digital" | "refunds") {
            return Err("invalid_request".to_owned());
        }
        params.push(("purpose", scope));
    }
    if !params.is_empty() {
        request = request.query(&params);
    }
    let (status, body) = send(seller_cookie(request)?).await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 出品者向け注文CSVエクスポート。全注文をテキストで返す。
pub async fn seller_orders_csv() -> Result<String, String> {
    let base = commerce_base()?;
    let (status, body) = send_text(
        seller_cookie(client()?.get(format!("{base}/api/v1/seller/orders.csv")))?,
    )
    .await?;
    if !status.is_success() {
        return Err(if body.is_empty() {
            "commerce_request_failed".to_owned()
        } else {
            body
        });
    }
    Ok(body)
}

/// 出品者向け注文詳細。異議中の解決期限・配分案・イベントを含む。
pub async fn seller_order_detail(order_id: &str) -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(
            client()?.get(format!("{base}/api/v1/seller/orders/{order_id}")))?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 発送・追跡番号の登録。
pub async fn seller_ship(
    order_id: &str,
    carrier: &str,
    tracking_number: &str,
) -> Result<Value, String> {
    if carrier.trim().is_empty() || tracking_number.trim().is_empty() {
        return Err("invalid_request".to_owned());
    }
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(
            client()?
                .patch(format!("{base}/api/v1/seller/orders/{order_id}/fulfillment"))
                .header("origin", write_origin())
                .json(&json!({
                    "fulfillmentStatus": "shipped",
                    "shippingCarrier": carrier.trim(),
                    "trackingNumber": tracking_number.trim(),
                })),
        )?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 受け取り(POS)注文の引き渡し済み記録。配送物は持たず追跡番号も要らない。
pub async fn seller_mark_delivered(order_id: &str) -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(
            client()?
                .patch(format!("{base}/api/v1/seller/orders/{order_id}/fulfillment"))
                .header("origin", write_origin())
                .json(&json!({ "fulfillmentStatus": "delivered" })),
        )?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 返品申請の裁定（承認/却下/受領）。
pub async fn seller_return_review(order_id: &str, decision: &str) -> Result<Value, String> {
    if !matches!(decision, "approved" | "rejected" | "received") {
        return Err("invalid_request".to_owned());
    }
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(
            client()?
                .patch(format!("{base}/api/v1/seller/orders/{order_id}/returns"))
                .header("origin", write_origin())
                .json(&json!({ "status": decision })),
        )?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

// 出品者側のエスクロー操作（発送確定・自主返金・異議・配分）。calldataは
// Commerceが組み立て、送信はウォレットの確認モーダルを通る。受取ウォレットが
// 端末の鍵と一致しない登録では escrow_transaction_mismatch で落ちる——
// これは意図どおり（他人のpayout walletをこの端末が名乗れない設計）。
pub async fn seller_escrow(
    order_id: &str,
    submit: bool,
    params: &Value,
) -> Result<Value, String> {
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid_escrow_action".to_owned())?;
    let mut payload = json!({ "action": action });
    for key in ["buyerAmountAtomic", "sellerAmountAtomic", "transactionHash"] {
        if let Some(value) = params.get(key).and_then(Value::as_str) {
            payload[key] = json!(value);
        }
    }
    let suffix = if submit { "/escrow/actions/submit" } else { "/escrow/actions" };
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(post_json(
            format!("{base}/api/v1/seller/orders/{order_id}{suffix}"),
            payload,
        )?)?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 返金見積。amountAtomic は省略可——省略なら残額全額。返る
/// sellerTransfer の calldata をウォレット送信へ回す。
pub async fn seller_refund_quote(order_id: &str, amount_atomic: &str) -> Result<Value, String> {
    let base = commerce_base()?;
    let payload = if amount_atomic.is_empty() {
        json!({})
    } else {
        json!({ "amountAtomic": amount_atomic })
    };
    let (status, body) = send(
        seller_cookie(post_json(
            format!("{base}/api/v1/seller/orders/{order_id}/refunds/quote"),
            payload,
        )?)?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// Reuse an unconsumed seller refund quote without creating another quote.
pub async fn seller_refund_active_quote(order_id: &str) -> Result<Value, String> {
    if order_id.is_empty() || order_id.len() > 200 || !order_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) {
        return Err("invalid_request".into());
    }
    let base = commerce_base()?;
    let (status, body) = send(seller_cookie(client()?.get(format!("{base}/api/v1/seller/orders/{order_id}/refunds/quote")))?).await?;
    if commerce_base()? != base { return Err("commerce_request_failed".into()); }
    if !status.is_success() { return Err(api_error(&body)); }
    Ok(body)
}

/// 返金txの照合（sellerTransfer送信後に呼ぶ）。
pub async fn seller_refund_submit(
    order_id: &str,
    refund_quote_id: &str,
    transaction_hash: &str,
) -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(post_json(
            format!("{base}/api/v1/seller/orders/{order_id}/refunds"),
            json!({ "refundQuoteId": refund_quote_id, "transactionHash": transaction_hash }),
        )?)?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 公開のチェーンカタログ（受取先フォームの選択肢）。認証不要。
pub async fn payment_chain_catalog() -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(client()?.get(format!("{base}/api/v1/payment/chain-catalog"))).await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 加盟店ウォレットの状態（アドレス・上限・メンバー・出金予定）。
/// 読み取りのみ——出金の作成や承認は多シグのUX設計が別途要る。
pub async fn seller_wallet() -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(client()?.get(format!("{base}/api/v1/seller/wallet")))?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// チェーン別の受取先一覧。
pub async fn seller_chain_destinations() -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(client()?.get(format!("{base}/api/v1/seller/chain-destinations")))?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// チェーン別受取先の登録・更新。キーとアドレスの実検証はサーバー側の
/// カタログに任せ、ここでは形状だけ見る。
pub async fn seller_chain_destination_put(
    network_key: &str,
    address: &str,
    address_tag: Option<&str>,
) -> Result<Value, String> {
    if !network_key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'.' | b'_'))
        || network_key.len() > 64
        || address.trim().is_empty()
        || address.len() > 160
    {
        return Err("invalid_request".to_owned());
    }
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(
            client()?
                .put(format!("{base}/api/v1/seller/chain-destinations"))
                .header("origin", write_origin())
                .json(&json!({
                    "networkKey": network_key,
                    "address": address.trim(),
                    "addressTag": address_tag,
                })),
        )?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// チェーン別受取先の無効化。
pub async fn seller_chain_destination_disable(network_key: &str) -> Result<Value, String> {
    if !network_key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'.' | b'_'))
        || network_key.len() > 64
    {
        return Err("invalid_request".to_owned());
    }
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(
            client()?
                .delete(format!(
                    "{base}/api/v1/seller/chain-destinations/{network_key}"
                ))
                .header("origin", write_origin()),
        )?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 支払い例外の一覧（過少/過払い）。overpaidには解決用のtx specが
/// resolutionTransferとして付く——サーバーが転送先と額を定めている。
pub async fn seller_payment_exceptions() -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(client()?.get(format!("{base}/api/v1/seller/payment-exceptions")))?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 支払い例外の解決照合。txはウォレット確認モーダルで送信済みのもの。
pub async fn seller_payment_exception_resolve(
    exception_id: &str,
    transaction_hash: &str,
) -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(post_json(
            format!("{base}/api/v1/seller/payment-exceptions/{exception_id}/resolve"),
            json!({ "transactionHash": transaction_hash }),
        )?)?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 購入者側の支払い例外解決。不足分を送金したtxをCommerceが
/// オンチェーン照合して注文を確定する。アクセストークンは保管庫から。
pub async fn order_payment_exception_resolve(
    order_id: &str,
    access_token: &str,
    transaction_hash: &str,
) -> Result<Value, String> {
    let token = order_access_token(order_id, access_token).await?;
    let base = commerce_base()?;
    let (status, body) = send(
        client()?
            .post(format!(
                "{base}/api/v1/orders/{order_id}/payment-exception/resolve"
            ))
            .header("origin", write_origin())
            .bearer_auth(token)
            .json(&json!({ "transactionHash": transaction_hash })),
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 商品画像の削除。quarantine/cleanの両方のR2オブジェクトを消す。
pub async fn seller_media_delete(media_id: &str) -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(
            client()?
                .delete(format!("{base}/api/v1/seller/media/{media_id}"))
                .header("origin", write_origin()),
        )?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 商品画像のアップロード。ファイル選択は窓、読み取りと送信はここ——
/// 画像のバイト列は窓へ渡さない。Commerce側は検疫預かりで、審査を
/// 通ったものだけが配信URLを持つ。
pub async fn seller_media_upload(path: &std::path::Path) -> Result<Value, String> {
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => return Err("invalid_media".to_owned()),
    };
    let bytes = std::fs::read(path).map_err(|_| "media_read_failed".to_owned())?;
    if bytes.is_empty() || bytes.len() > 5 * 1024 * 1024 {
        return Err("invalid_media".to_owned());
    }
    let base = commerce_base()?;
    let request = client()?
        .post(format!("{base}/api/v1/seller/media"))
        .header("origin", write_origin())
        .header("content-type", mime)
        .body(bytes);
    let (status, body) = send(seller_cookie(request)?).await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

/// 出品者のメディア一覧（検疫・審査の状態つき）。url は相対で返るので
/// ここで絶対化する——窓が接続先を意識する必要はない。
pub async fn seller_media(before: Option<&str>) -> Result<Value, String> {
    let base = commerce_base()?;
    let mut request = client()?.get(format!("{base}/api/v1/seller/media"));
    if let Some(cursor) = before {
        request = request.query(&[("before", cursor)]);
    }
    let (status, mut body) = send(seller_cookie(request)?).await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    if let Some(items) = body.get_mut("media").and_then(Value::as_array_mut) {
        for item in items {
            if let Some(url) = item.get("url").and_then(Value::as_str) {
                if url.starts_with('/') {
                    item["url"] = json!(format!("{base}{url}"));
                }
            }
        }
    }
    Ok(body)
}

/// 売上の概要（注文数・総額・返金額・商品別）。
pub async fn seller_analytics() -> Result<Value, String> {
    let base = commerce_base()?;
    let (status, body) = send(
        seller_cookie(client()?.get(format!("{base}/api/v1/seller/analytics")))?,
    )
    .await?;
    if !status.is_success() {
        return Err(api_error(&body));
    }
    Ok(body)
}

#[cfg(test)]
mod checkout_tests {
    use super::*;
    const ORIGIN: &str = "https://shop.example";
    const WALLET: &str = "0x1111111111111111111111111111111111111111";
    const ORDER_ID: &str = "12345678-1234-4234-8234-123456789abc";

    struct Fixture {
        directory: std::path::PathBuf,
        store: CheckpointStore,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir()
                .join(format!("hub-commerce-checkout-{}", uuid::Uuid::new_v4()));
            Self {
                store: CheckpointStore::test(directory.clone(), [17; 32]),
                directory,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert!(self.directory.starts_with(std::env::temp_dir()));
            std::fs::remove_dir_all(&self.directory).unwrap();
        }
    }
    fn params() -> Value {
        json!({"operationId":uuid::Uuid::new_v4().to_string(), "productId":uuid::Uuid::new_v4().to_string(),
            "quantity":2, "billingCountry":"JP", "paymentCurrency":"JPYC", "paymentChainId":80002,
            "fulfillmentAssertion":"fixture-proof-🧪\n\"\\tail"})
    }
    fn response(request: &CheckoutRequest, status: &str) -> Value {
        let input = checked_checkout_body(&request.body).unwrap();
        json!({"order":{"id":ORDER_ID,"productId":input.product_id,"quantity":input.quantity,
            "chainId":input.payment_chain_id,"currency":input.payment_currency,"buyerWallet":WALLET,
            "status":status,"accessToken":"fixture-token","amountJpyc":123,"taxJpyc":12,
            "transactionHash":null,"expiresAt":"2020-01-01T00:00:00Z"}})
    }

    #[test]
    fn checkout_requires_v4_operations_but_keeps_product_and_order_uuid_rules() {
        let fixture = Fixture::new();
        let mut index = load_checkouts(&fixture.store).unwrap();
        let mut input = params();
        input["productId"] = json!("12345678-1234-1234-8234-123456789abc");
        let saved = prepare_checkout(&fixture.store, &mut index, &input, ORIGIN, WALLET).unwrap();
        let order_id = "12345678-1234-5234-8234-123456789abc";
        record_checkout_order(&fixture.store, &mut index, &saved.operation_id, order_id, "fixture-token").unwrap();
        for operation in ["00000000-0000-0000-0000-000000000000", "12345678-1234-1234-8234-123456789abc", "12345678-1234-5234-8234-123456789abc", "12345678-1234-4234-7234-123456789abc"] {
            assert!(canonical_uuid(operation));
            assert!(!canonical_operation_uuid(operation));
            input["operationId"] = json!(operation);
            assert_eq!(prepare_checkout(&fixture.store, &mut index, &input, ORIGIN, WALLET).err().unwrap(), "invalid_request");
            assert_eq!(finish_checkout(&fixture.store, &mut index, operation, &Value::Null, 0).unwrap_err(), "invalid_request");
            let mut invalid = index.clone();
            invalid.requests[0].operation_id = operation.to_owned();
            fixture.store.save(CHECKOUT_INDEX_ID, &invalid).unwrap();
            assert_eq!(load_checkouts(&fixture.store).err().unwrap(), "checkout_store_invalid");
        }
    }

    #[test]
    fn checkout_post_has_origin_same_id_and_exact_saved_bytes_without_sending() {
        let fixture = Fixture::new();
        let mut index = load_checkouts(&fixture.store).unwrap();
        let saved = prepare_checkout(&fixture.store, &mut index, &params(), ORIGIN, WALLET).unwrap();
        let request = checkout_post(&saved).unwrap().build().unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url().as_str(), format!("{ORIGIN}/api/v1/orders"));
        assert_eq!(request.headers()["origin"].to_str().unwrap(), write_origin());
        assert_eq!(request.headers()["idempotency-key"].to_str().unwrap(), saved.operation_id);
        assert_eq!(request.headers()["content-type"], "application/json");
        assert_eq!(request.body().unwrap().as_bytes().unwrap(), saved.body.as_bytes());
    }

    #[test]
    fn checkout_restart_replays_exact_body_and_exposes_only_public_metadata() {
        let fixture = Fixture::new();
        let input = params();
        let mut index = load_checkouts(&fixture.store).unwrap();
        let saved = prepare_checkout(&fixture.store, &mut index, &input, ORIGIN, WALLET).unwrap();
        let reopened = CheckpointStore::test(fixture.directory.clone(), [17; 32]);
        let mut restarted = load_checkouts(&reopened).unwrap();
        let retry = prepare_checkout(
            &reopened,
            &mut restarted,
            &json!({"operationId":saved.operation_id}),
            ORIGIN,
            WALLET,
        )
        .unwrap();
        assert_eq!(retry.body, saved.body);
        assert_eq!(retry.origin, ORIGIN);
        assert_eq!(retry.operation_id, input["operationId"]);
        assert!(retry.order_id.is_none());
        assert_eq!(
            prepare_checkout(&reopened, &mut restarted, &input, ORIGIN, WALLET)
                .unwrap()
                .body,
            saved.body
        );
        let pending = pending_checkout_payload(&restarted).unwrap();
        assert_eq!(
            pending["requests"][0],
            json!({"operationId":saved.operation_id,"productId":input["productId"],
            "quantity":2,"billingCountry":"JP","paymentCurrency":"JPYC","paymentChainId":80002,"orderId":null})
        );
        let raw =
            std::fs::read(fixture.directory.join(format!("{CHECKOUT_INDEX_ID}.jkcp"))).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("fixture-proof"));
        assert!(!pending.to_string().contains("fixture-proof"));
        assert!(!pending.to_string().contains(WALLET));
    }

    #[test]
    fn checkout_changed_fields_wallet_origin_and_new_matching_product_fail_closed() {
        let fixture = Fixture::new();
        let input = params();
        let mut index = load_checkouts(&fixture.store).unwrap();
        prepare_checkout(&fixture.store, &mut index, &input, ORIGIN, WALLET).unwrap();
        for (field, value) in [
            ("productId", json!(uuid::Uuid::new_v4().to_string())),
            ("quantity", json!(3)),
            ("billingCountry", json!("US")),
            ("paymentCurrency", json!("USDC")),
            ("paymentChainId", json!(137)),
            ("fulfillmentAssertion", json!("changed")),
        ] {
            let mut changed = input.clone();
            changed[field] = value;
            assert_eq!(
                prepare_checkout(&fixture.store, &mut index, &changed, ORIGIN, WALLET)
                    .err()
                    .unwrap(),
                "checkout_request_conflict"
            );
        }
        let retry = json!({"operationId":input["operationId"]});
        for (origin, wallet) in [
            ("https://different.example", WALLET),
            (ORIGIN, "0x2222222222222222222222222222222222222222"),
        ] {
            assert_eq!(
                prepare_checkout(&fixture.store, &mut index, &retry, origin, wallet)
                    .err()
                    .unwrap(),
                "checkout_binding_mismatch"
            );
        }
        let mut duplicate = input.clone();
        duplicate["operationId"] = json!(uuid::Uuid::new_v4().to_string());
        assert_eq!(
            prepare_checkout(&fixture.store, &mut index, &duplicate, ORIGIN, WALLET)
                .err()
                .unwrap(),
            "checkout_pending_exists"
        );
        let mut supplied = input.clone();
        supplied["buyerWallet"] = json!(WALLET);
        assert_eq!(
            prepare_checkout(&fixture.store, &mut index, &supplied, ORIGIN, WALLET)
                .err()
                .unwrap(),
            "invalid_request"
        );
        assert_eq!(load_checkouts(&fixture.store).unwrap().requests.len(), 1);
    }

    #[test]
    fn checkout_canonical_ids_unknown_replays_and_corrupt_index_never_become_empty() {
        let fixture = Fixture::new();
        let mut index = load_checkouts(&fixture.store).unwrap();
        let input = params();
        assert!(!canonical_uuid("12345678-1234-4234-8234-123456789ABC"));
        assert!(!canonical_uuid("12345678123442348234123456789abc"));
        assert_eq!(
            prepare_checkout(
                &fixture.store,
                &mut index,
                &json!({"operationId":input["operationId"]}),
                ORIGIN,
                WALLET
            )
            .err()
            .unwrap(),
            "checkout_operation_unknown"
        );
        let mut bad = input.clone();
        bad["operationId"] = json!("INVALID");
        assert_eq!(
            prepare_checkout(&fixture.store, &mut index, &bad, ORIGIN, WALLET)
                .err()
                .unwrap(),
            "invalid_request"
        );
        prepare_checkout(&fixture.store, &mut index, &input, ORIGIN, WALLET).unwrap();
        let mut duplicate = index.clone();
        duplicate.requests.push(duplicate.requests[0].clone());
        fixture.store.save(CHECKOUT_INDEX_ID, &duplicate).unwrap();
        assert_eq!(
            load_checkouts(&fixture.store).err().unwrap(),
            "checkout_store_invalid"
        );
        fixture
            .store
            .save(CHECKOUT_INDEX_ID, &json!({"version":2,"requests":[]}))
            .unwrap();
        assert_eq!(
            load_checkouts(&fixture.store).err().unwrap(),
            "checkout_store_invalid"
        );
        fixture
            .store
            .save(
                CHECKOUT_INDEX_ID,
                &json!({"version":1,"requests":[],"unexpected":true}),
            )
            .unwrap();
        assert_eq!(
            load_checkouts(&fixture.store).err().unwrap(),
            "checkout_store_invalid"
        );
        std::fs::write(
            fixture.directory.join(format!("{CHECKOUT_INDEX_ID}.jkcp")),
            [1; 28],
        )
        .unwrap();
        assert_eq!(
            load_checkouts(&fixture.store).err().unwrap(),
            "checkout_store_invalid"
        );
    }

    #[test]
    fn checkout_entry_limit_preserves_all_twenty_unresolved_requests() {
        let fixture = Fixture::new();
        let mut index = load_checkouts(&fixture.store).unwrap();
        for _ in 0..CHECKOUT_MAX_ENTRIES {
            prepare_checkout(&fixture.store, &mut index, &params(), ORIGIN, WALLET).unwrap();
        }
        assert_eq!(
            prepare_checkout(&fixture.store, &mut index, &params(), ORIGIN, WALLET)
                .err()
                .unwrap(),
            "checkout_store_limit"
        );
        assert_eq!(index.requests.len(), 20);
        assert_eq!(load_checkouts(&fixture.store).unwrap().requests.len(), 20);
    }

    #[test]
    fn checkout_exact_megabyte_limit_and_failed_response_save_keep_previous_record() {
        let fixture = Fixture::new();
        let input = params();
        let mut index = load_checkouts(&fixture.store).unwrap();
        let request = prepare_checkout(&fixture.store, &mut index, &input, ORIGIN, WALLET).unwrap();
        let mut body: CheckoutBody = serde_json::from_str(&request.body).unwrap();
        let remaining = CHECKOUT_MAX_BYTES - serde_json::to_vec(&index).unwrap().len();
        body.fulfillment_assertion.push_str(&"x".repeat(remaining));
        index.requests[0].body = serde_json::to_string(&body).unwrap();
        assert_eq!(
            serde_json::to_vec(&index).unwrap().len(),
            CHECKOUT_MAX_BYTES
        );
        save_checkouts(&fixture.store, &index).unwrap();
        let kept = index.requests[0].body.clone();
        body.fulfillment_assertion.push('x');
        index.requests[0].body = serde_json::to_string(&body).unwrap();
        assert_eq!(
            save_checkouts(&fixture.store, &index).unwrap_err(),
            "checkout_store_limit"
        );
        index = load_checkouts(&fixture.store).unwrap();
        assert_eq!(index.requests[0].body, kept);
        assert_eq!(
            record_checkout_order(
                &fixture.store,
                &mut index,
                &request.operation_id,
                ORDER_ID,
                "fixture-token"
            )
            .unwrap_err(),
            "checkout_store_limit"
        );
        assert!(index.requests[0].order_id.is_none());
        assert!(load_checkouts(&fixture.store).unwrap().requests[0]
            .order_id
            .is_none());
    }

    #[test]
    fn checkout_save_failure_retains_empty_memory_and_surfaces_unreadable_disk() {
        let fixture = Fixture::new();
        let mut index = load_checkouts(&fixture.store).unwrap();
        std::fs::create_dir(fixture.directory.join(format!("{CHECKOUT_INDEX_ID}.jkcp"))).unwrap();
        assert_eq!(
            prepare_checkout(&fixture.store, &mut index, &params(), ORIGIN, WALLET)
                .err()
                .unwrap(),
            "checkout_store_unavailable"
        );
        assert!(index.requests.is_empty());
        assert_eq!(
            load_checkouts(&fixture.store).err().unwrap(),
            "checkout_store_invalid"
        );
    }

    #[test]
    fn checkout_response_identity_and_flags_prevent_wrong_binding_or_terminal_payment_actions() {
        let fixture = Fixture::new();
        let mut index = load_checkouts(&fixture.store).unwrap();
        let request =
            prepare_checkout(&fixture.store, &mut index, &params(), ORIGIN, WALLET).unwrap();
        let first = response(&request, "awaiting_payment");
        assert!(checked_checkout_result(
            &request,
            reqwest::StatusCode::CREATED,
            first.clone(),
            false,
            0
        )
        .is_ok());
        assert!(
            checked_checkout_result(&request, reqwest::StatusCode::OK, first, false, 0).is_err()
        );
        for field in [
            "id",
            "productId",
            "quantity",
            "chainId",
            "currency",
            "buyerWallet",
        ] {
            let mut wrong = response(&request, "paid");
            wrong["order"][field] = Value::Null;
            assert!(checkout_response_identity(&request, &wrong).is_err());
        }
        let mut terminal = response(&request, "paid");
        terminal["paymentActionAvailable"] = json!(false);
        terminal["order"]["transferData"] = json!("0xdead");
        terminal["order"]["payment"] = json!({"data":"0xdead"});
        let (_, checked) = checked_checkout_result(
            &request,
            reqwest::StatusCode::OK,
            terminal.clone(),
            false,
            0,
        )
        .unwrap();
        assert_eq!(checked["paymentActionAvailable"], false);
        assert!(checked["order"].get("transferData").is_none());
        assert!(checked["order"].get("payment").is_none());
        assert_eq!(checked["order"]["amountJpyc"], 123);
        terminal["paymentActionAvailable"] = json!(true);
        assert!(
            checked_checkout_result(&request, reqwest::StatusCode::OK, terminal, false, 0).is_err()
        );
        let ordinary = json!({"error":"idempotency_key_conflict","order":{"status":"expired"},"paymentActionAvailable":false});
        assert!(!checkout_is_expired_response(
            reqwest::StatusCode::CONFLICT,
            &ordinary
        ));
    }

    #[test]
    fn checkout_synthetic_expiry_requires_authoritative_null_transaction_and_past_timestamp() {
        let fixture = Fixture::new();
        let mut index = load_checkouts(&fixture.store).unwrap();
        let request =
            prepare_checkout(&fixture.store, &mut index, &params(), ORIGIN, WALLET).unwrap();
        let now = 1_577_836_800_000;
        let authoritative = response(&request, "awaiting_payment");
        let minimal = json!({"error":"checkout_expired","order":{"id":ORDER_ID,"status":"expired","accessToken":"fixture-token"},"paymentActionAvailable":false});
        assert!(checkout_is_expired_response(
            reqwest::StatusCode::CONFLICT,
            &minimal
        ));
        assert!(checkout_response_identity(&request, &minimal).is_err());
        let (_, checked) = checked_checkout_result(
            &request,
            reqwest::StatusCode::CONFLICT,
            authoritative.clone(),
            true,
            now,
        )
        .unwrap();
        assert_eq!(checked["order"]["status"], "expired");
        assert_eq!(checked["paymentActionAvailable"], false);
        for value in [json!("bad"), json!("2030-01-01T00:00:00Z"), Value::Null] {
            let mut invalid = authoritative.clone();
            invalid["order"]["expiresAt"] = value;
            assert!(!checkout_expired_read(&invalid, now));
        }
        for value in [json!("0xknown"), json!("")] {
            let mut invalid = authoritative.clone();
            invalid["order"]["transactionHash"] = value;
            assert!(!checkout_expired_read(&invalid, now));
        }
        let mut absent = authoritative.clone();
        absent["order"]
            .as_object_mut()
            .unwrap()
            .remove("transactionHash");
        assert!(!checkout_expired_read(&absent, now));
        record_checkout_order(
            &fixture.store,
            &mut index,
            &request.operation_id,
            ORDER_ID,
            "fixture-token",
        )
        .unwrap();
        assert_eq!(
            finish_checkout(
                &fixture.store,
                &mut index,
                &request.operation_id,
                &authoritative,
                now
            )
            .unwrap(),
            json!({"finished":true})
        );
    }

    #[test]
    fn checkout_finish_requires_known_matching_order_and_authoritative_terminal_status() {
        let fixture = Fixture::new();
        let mut index = load_checkouts(&fixture.store).unwrap();
        let request =
            prepare_checkout(&fixture.store, &mut index, &params(), ORIGIN, WALLET).unwrap();
        assert_eq!(
            finish_checkout(
                &fixture.store,
                &mut index,
                &request.operation_id,
                &response(&request, "paid"),
                0
            )
            .unwrap_err(),
            "checkout_order_unresolved"
        );
        record_checkout_order(
            &fixture.store,
            &mut index,
            &request.operation_id,
            ORDER_ID,
            "fixture-token",
        )
        .unwrap();
        index = load_checkouts(&fixture.store).unwrap();
        assert_eq!(
            index.requests[0].access_token.as_deref(),
            Some("fixture-token")
        );
        assert_eq!(index.requests[0].body, request.body);
        assert!(!pending_checkout_payload(&index)
            .unwrap()
            .to_string()
            .contains("fixture-token"));
        for state in ["awaiting_payment", "confirming", "unknown"] {
            assert_eq!(
                finish_checkout(
                    &fixture.store,
                    &mut index,
                    &request.operation_id,
                    &response(&request, state),
                    0
                )
                .unwrap_err(),
                "checkout_not_finished"
            );
            assert_eq!(load_checkouts(&fixture.store).unwrap().requests.len(), 1);
        }
        let mut wrong = response(&request, "paid");
        wrong["order"]["id"] = json!(uuid::Uuid::new_v4().to_string());
        assert_eq!(
            finish_checkout(&fixture.store, &mut index, &request.operation_id, &wrong, 0)
                .unwrap_err(),
            "checkout_response_invalid"
        );
        assert_eq!(
            finish_checkout(
                &fixture.store,
                &mut index,
                &request.operation_id,
                &response(&request, "paid"),
                0
            )
            .unwrap(),
            json!({"finished":true})
        );
        assert!(load_checkouts(&fixture.store).unwrap().requests.is_empty());
        assert!(finish_checkout(
            &fixture.store,
            &mut index,
            &request.operation_id,
            &response(&request, "paid"),
            0
        )
        .is_err());
    }
}

#[cfg(test)]
mod product_offers_tests {
 use super::*;
 #[test]
 fn commerce_base_keeps_only_the_hub_commerce_path(){
  assert_eq!(checked_origin("https://hub.jkamma.com/shopping/api/commerce").unwrap(),"https://hub.jkamma.com/shopping/api/commerce");
  assert_eq!(checked_origin("https://hub.jkamma.com/shopping/api/commerce/").unwrap(),"https://hub.jkamma.com/shopping/api/commerce");
  assert_eq!(checked_origin("http://127.0.0.1:8122").unwrap(),"http://127.0.0.1:8122");
  for bad in ["https://hub.jkamma.com/other","https://hub.jkamma.com/shopping/api/commerce?x=1","http://hub.jkamma.com/shopping/api/commerce","https://hub.jkamma.com/shopping/api/commerce/../x"]{
   assert!(checked_origin(bad).is_err(),"{bad}");
  }
 }
 #[test]
 fn public_catalog_paths_are_fixed_and_parameters_are_bounded(){
  assert_eq!(product_offers_url("http://127.0.0.1:8122","catalog",None).unwrap().as_str(),"http://127.0.0.1:8122/api/v1/products?hubProductId=catalog");
  assert_eq!(product_offers_url("https://shop.invalid","catalog",Some("2026-10-08T00:00:00Z|sale")).unwrap().query(),Some("hubProductId=catalog&before=2026-10-08T00%3A00%3A00Z%7Csale"));
  assert!(product_offers_url("https://shop.invalid",&"x".repeat(128),None).is_ok());
  assert!(product_offers_url("https://shop.invalid",&"x".repeat(180),None).is_ok());
  for id in ["", "../x", "x?order=private", "x\n", &"x".repeat(181)]{assert!(product_offers_url("https://shop.invalid",id,None).is_err());}
  for cursor in ["", "cursor\n", &"x".repeat(257)]{assert!(product_offers_url("https://shop.invalid","p",Some(cursor)).is_err());}
 }
 #[test]
 fn public_response_requires_echo_and_closed_cursor_bounds(){
  let value=json!({"hubProductId":"p","products":[],"nextCursor":null,"private":"discarded"});let result=product_offers_payload(value,"p").unwrap();assert_eq!(result.as_object().unwrap().len(),3);
  for value in [json!({"products":[],"nextCursor":null}),json!({"hubProductId":"other","products":[],"nextCursor":null}),json!({"hubProductId":"p","products":vec![json!({});101],"nextCursor":null}),json!({"hubProductId":"p","products":[],"nextCursor":"x\n"})]{assert!(product_offers_payload(value,"p").is_err());}
 }
}
#[cfg(test)]
mod order_token_tests {
    use super::*;

    fn order(n: u32) -> String {
        format!("12345678-1234-4234-8234-{n:012}")
    }
    fn token(n: u32) -> String {
        format!("tok_{n:04}_{}", "x".repeat(60))
    }
    fn fixture() -> (std::path::PathBuf, CheckpointStore) {
        let directory =
            std::env::temp_dir().join(format!("hub-order-tokens-{}", uuid::Uuid::new_v4()));
        let store = CheckpointStore::test(directory.clone(), [23; 32]);
        (directory, store)
    }

    #[test]
    fn fifty_tokens_exceed_the_keyring_limit_and_still_round_trip() {
        let (directory, store) = fixture();
        for n in 1..=50 {
            put_order_token(&store, &order(n), &token(n), i64::from(n)).unwrap();
        }
        let size: usize = (1..=50).map(|n| order(n).len() + token(n).len() + 8).sum();
        assert!(size > 2560);
        for n in 1..=50 {
            assert_eq!(get_order_token(&store, &order(n)).unwrap(), Some(token(n)));
        }
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn trim_drops_the_oldest_by_time_and_keeps_the_newest() {
        let (directory, store) = fixture();
        // IDs descend while times ascend, so id order and time order disagree.
        for n in 1..=50 {
            put_order_token(&store, &order(100 - n), &token(n), i64::from(n) * 10).unwrap();
        }
        put_order_token(&store, &order(1), "newest", 5).unwrap(); // older stamp than all
        assert_eq!(get_order_token(&store, &order(1)).unwrap().as_deref(), Some("newest"));
        // The oldest by time (n = 1) went, nothing else.
        assert_eq!(get_order_token(&store, &order(99)).unwrap(), None);
        assert!(get_order_token(&store, &order(98)).unwrap().is_some());
        assert_eq!(load_order_tokens(&store).unwrap().entries.len(), 50);
        // Saving an existing order again replaces it and does not grow the list.
        put_order_token(&store, &order(98), "again", 9_999).unwrap();
        assert_eq!(get_order_token(&store, &order(98)).unwrap().as_deref(), Some("again"));
        assert_eq!(load_order_tokens(&store).unwrap().entries.len(), 50);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_failed_write_is_an_error() {
        let (directory, store) = fixture();
        std::fs::remove_dir_all(&directory).unwrap();
        assert!(put_order_token(&store, &order(1), &token(1), 1).is_err());
    }

    #[test]
    fn migration_is_idempotent_and_deletes_only_after_a_good_write() {
        let (directory, store) = fixture();
        let raw = json!({ order(1): token(1), order(2): token(2), "not-a-uuid": token(3) })
            .to_string();
        let deleted = std::cell::Cell::new(0);
        migrate_order_tokens(
            &store,
            || Ok(Some(raw.clone())),
            || {
                deleted.set(deleted.get() + 1);
                Ok(())
            },
            1,
        )
        .unwrap();
        assert_eq!(deleted.get(), 1);
        assert_eq!(get_order_token(&store, &order(2)).unwrap(), Some(token(2)));
        assert_eq!(load_order_tokens(&store).unwrap().entries.len(), 2);
        // Second run: the keyring entry is gone, nothing changes.
        migrate_order_tokens(&store, || Ok(None), || panic!("no delete"), 2).unwrap();
        assert_eq!(load_order_tokens(&store).unwrap().entries.len(), 2);
        // A run that sees the blob again does not duplicate or overwrite.
        put_order_token(&store, &order(1), "fresh", 5).unwrap();
        migrate_order_tokens(&store, || Ok(Some(raw.clone())), || Ok(()), 3).unwrap();
        assert_eq!(get_order_token(&store, &order(1)).unwrap().as_deref(), Some("fresh"));
        assert_eq!(load_order_tokens(&store).unwrap().entries.len(), 2);
        // A failed write keeps the keyring entry.
        std::fs::remove_dir_all(&directory).unwrap();
        let kept = std::cell::Cell::new(false);
        let result = migrate_order_tokens(
            &store,
            || Ok(Some(raw.clone())),
            || {
                kept.set(true);
                Ok(())
            },
            4,
        );
        assert!(result.is_err() && !kept.get());
    }
}
