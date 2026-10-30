//! Read-only Hub Market tools for the Pi loop. Public catalog data only: no
//! orders, tokens or account identifiers. Everything returned is untrusted
//! text for the model and never feeds a permission decision.
use serde_json::{json, Map, Value};
use std::time::Duration;

const MAX_QUERY_CHARS: usize = 100;
const MAX_LIMIT: u64 = 20;
const DEFAULT_LIMIT: usize = 10;
const MAX_TITLE_CHARS: usize = 200;
const MAX_NAME_CHARS: usize = 100;
const MAX_SUMMARY_CHARS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 4_000;
const MAX_OFFERS: usize = 5;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, PartialEq)]
pub struct SearchRequest {
    pub query: String,
    pub limit: usize,
}

impl SearchRequest {
    pub fn parse(value: Value) -> Result<Self, String> {
        let map = value.as_object().ok_or("invalid_market_search")?;
        let query = map
            .get("query")
            .and_then(Value::as_str)
            .ok_or("query_required")?
            .trim();
        if query.is_empty()
            || query.chars().count() > MAX_QUERY_CHARS
            || query.chars().any(char::is_control)
        {
            return Err("query_invalid".into());
        }
        let limit = match map.get("limit") {
            None | Some(Value::Null) => DEFAULT_LIMIT,
            Some(Value::Number(n)) => match n.as_u64() {
                Some(v) if (1..=MAX_LIMIT).contains(&v) => v as usize,
                _ => return Err("limit_invalid".into()),
            },
            _ => return Err("limit_invalid".into()),
        };
        Ok(Self { query: query.to_owned(), limit })
    }
}

pub fn parse_product_id(value: Value) -> Result<String, String> {
    let id = value
        .as_object()
        .ok_or("invalid_market_read")?
        .get("productId")
        .and_then(Value::as_str)
        .ok_or("product_id_required")?;
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "product_id_invalid")?;
    Ok(parsed.to_string())
}

/// Strip control and bidi/zero-width characters, then cap by characters.
/// Newlines survive only when `multiline`.
fn clean(value: &Value, max: usize, multiline: bool) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .map(|c| if multiline && c == '\n' { c } else if c.is_control() { ' ' } else { c })
        .filter(|c| !matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'))
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn uuid_of(row: &Value) -> Option<String> {
    let id = row.get("hubProductId")?.as_str()?;
    uuid::Uuid::parse_str(id).ok().map(|u| u.to_string())
}

fn in_stock(row: &Value) -> bool {
    // Commerce checks `stockQuantity ?? 0` at checkout, so a missing figure is not buyable.
    row.get("stockQuantity").and_then(Value::as_u64).is_some_and(|n| n > 0)
}

/// Allowlist projection of one public listing row. Unknown fields (seller
/// ids, wallets, gas policy ...) are never copied.
fn project(row: &Value, product_id: &str, description_chars: usize) -> Value {
    let mut out = Map::new();
    out.insert("productId".into(), json!(product_id));
    out.insert("title".into(), json!(clean(&row["title"], MAX_TITLE_CHARS, false)));
    out.insert(
        "description".into(),
        json!(clean(&row["description"], description_chars, description_chars > MAX_SUMMARY_CHARS)),
    );
    out.insert("price".into(), row.get("priceJpyc").and_then(Value::as_u64).map_or(Value::Null, |p| json!(p)));
    out.insert("currency".into(), json!("JPYC"));
    out.insert("seller".into(), json!(clean(&row["seller"]["publicName"], MAX_NAME_CHARS, false)));
    out.insert("fulfillmentType".into(), json!(clean(&row["fulfillmentType"], 40, false)));
    out.insert("inStock".into(), json!(in_stock(row)));
    out.insert("path".into(), json!(format!("/market/products/{product_id}")));
    Value::Object(out)
}

pub fn search_payload(catalog: &Value, limit: usize) -> Result<Value, String> {
    let rows = catalog
        .get("products")
        .and_then(Value::as_array)
        .ok_or("commerce_response_invalid")?;
    // Only listings with a Hub product UUID are purchasable via hub_pay.
    let products: Vec<Value> = rows
        .iter()
        .filter_map(|row| Some(project(row, &uuid_of(row)?, MAX_SUMMARY_CHARS)))
        .take(limit)
        .collect();
    Ok(json!({ "count": products.len(), "products": products }))
}

pub fn read_payload(offers: &Value, product_id: &str) -> Result<Value, String> {
    let rows = offers
        .get("products")
        .and_then(Value::as_array)
        .ok_or("commerce_response_invalid")?;
    let Some(first) = rows.first() else {
        return Err("product_not_found".into());
    };
    let mut product = project(first, product_id, MAX_DESCRIPTION_CHARS);
    let shipping = |row: &Value| match row.get("shippingJpyc").and_then(Value::as_u64) {
        Some(0) => json!("free"),
        Some(n) => json!(n),
        None => json!("confirmed at checkout"),
    };
    let offers: Vec<Value> = rows
        .iter()
        .take(MAX_OFFERS)
        .map(|row| {
            let seller = &row["seller"];
            json!({
                "price": row.get("priceJpyc").and_then(Value::as_u64),
                "currency": "JPYC",
                "shipping": shipping(row),
                "seller": clean(&seller["publicName"], MAX_NAME_CHARS, false),
                "fulfillmentType": clean(&row["fulfillmentType"], 40, false),
                "inStock": in_stock(row),
                "sellerTermsUrl": clean(&seller["legalDisplayUrl"], 300, false),
            })
        })
        .collect();
    product.as_object_mut().expect("object").insert("offers".into(), json!(offers));
    Ok(product)
}

fn stable_error(error: String) -> String {
    if error.starts_with("commerce_") || error == "product_not_found" {
        error
    } else {
        "market_unavailable".into()
    }
}

async fn bounded<T>(
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout(UPSTREAM_TIMEOUT, future)
        .await
        .map_err(|_| "market_timeout".to_owned())?
        .map_err(stable_error)
}

pub async fn catalog_search(args: Value) -> Result<Value, String> {
    let request = SearchRequest::parse(args)?;
    let catalog = bounded(crate::commerce::catalog(Some(&request.query), None, None)).await?;
    search_payload(&catalog, request.limit)
}

pub async fn product_read(args: Value) -> Result<Value, String> {
    let id = parse_product_id(args)?;
    let offers = bounded(crate::commerce::product_offers(&id, None)).await?;
    read_payload(&offers, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "123e4567-e89b-42d3-a456-426614174000";

    #[test]
    fn search_arguments_are_bounded() {
        assert_eq!(
            SearchRequest::parse(json!({"query": " tea "})).unwrap(),
            SearchRequest { query: "tea".into(), limit: 10 }
        );
        assert_eq!(SearchRequest::parse(json!({"query": "x", "limit": 20})).unwrap().limit, 20);
        for bad in [
            json!({}), json!([]), json!({"query": ""}), json!({"query": "   "}), json!({"query": 5}),
            json!({"query": "a\nb"}), json!({"query": "x".repeat(101)}),
            json!({"query": "x", "limit": 0}), json!({"query": "x", "limit": 21}),
            json!({"query": "x", "limit": 1.5}), json!({"query": "x", "limit": "3"}),
            json!({"query": "x", "limit": -1}),
        ] {
            assert!(SearchRequest::parse(bad.clone()).is_err(), "{bad}");
        }
        assert!(SearchRequest::parse(json!({"query": "x".repeat(100)})).is_ok());
    }

    #[test]
    fn product_id_must_be_a_uuid() {
        assert_eq!(parse_product_id(json!({"productId": ID.to_uppercase()})).unwrap(), ID);
        for bad in [
            json!({}), json!({"productId": "item-1"}), json!({"productId": ""}),
            json!({"productId": 7}), json!("x"), json!({"productId": format!("{ID}/../x")}),
        ] {
            assert!(parse_product_id(bad.clone()).is_err(), "{bad}");
        }
    }

    fn row(extra: Value) -> Value {
        let mut base = json!({
            "id": "sale-1", "sellerId": "secret-seller", "hubProductId": ID, "title": "Tea\u{202E}pot\n",
            "description": "d".repeat(5000), "priceJpyc": 1200, "shippingJpyc": 0, "stockQuantity": 3,
            "fulfillmentType": "seller_shipping", "payoutWallet": "0xabc", "gasPayerPolicy": "x",
            "seller": {"publicName": "Shop", "legalDisplayUrl": "https://seller.example/legal"}
        });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        base
    }

    #[test]
    fn search_projects_only_public_fields_and_caps_text() {
        let catalog = json!({"products": [
            row(json!({})),
            row(json!({"hubProductId": "not-a-uuid"})),
            row(json!({"hubProductId": null})),
            row(json!({"stockQuantity": 0})),
        ]});
        let out = search_payload(&catalog, 10).unwrap();
        assert_eq!(out["count"], 2, "listings without a UUID are not purchasable");
        let first = &out["products"][0];
        assert_eq!(first["title"], "Teapot");
        assert_eq!(first["description"].as_str().unwrap().chars().count(), 300);
        assert_eq!(first["price"], 1200);
        assert_eq!(first["currency"], "JPYC");
        assert_eq!(first["seller"], "Shop");
        assert_eq!(first["inStock"], true);
        assert_eq!(first["path"], format!("/market/products/{ID}"));
        assert_eq!(out["products"][1]["inStock"], false);
        let text = out.to_string();
        for leaked in ["secret-seller", "0xabc", "payoutWallet", "gasPayerPolicy", "sale-1"] {
            assert!(!text.contains(leaked), "{leaked}");
        }
        assert_eq!(search_payload(&catalog, 1).unwrap()["count"], 1);
        assert!(search_payload(&json!({}), 1).is_err());
    }

    #[test]
    fn read_returns_full_description_and_offer_conditions() {
        let rows = json!({"products": [
            row(json!({})),
            row(json!({"shippingJpyc": 300, "stockQuantity": null})),
        ]});
        let out = read_payload(&rows, ID).unwrap();
        assert_eq!(out["description"].as_str().unwrap().chars().count(), 4000);
        assert_eq!(out["offers"][0]["shipping"], "free");
        assert_eq!(out["offers"][1]["shipping"], 300);
        assert_eq!(out["offers"][1]["inStock"], false);
        assert_eq!(out["offers"][0]["sellerTermsUrl"], "https://seller.example/legal");
        assert!(!out.to_string().contains("secret-seller"));
        assert_eq!(read_payload(&json!({"products": []}), ID).unwrap_err(), "product_not_found");
        assert_eq!(read_payload(&json!({}), ID).unwrap_err(), "commerce_response_invalid");
    }

    #[test]
    fn upstream_errors_collapse_to_stable_codes() {
        assert_eq!(stable_error("commerce_timeout".into()), "commerce_timeout");
        assert_eq!(stable_error("<html>boom</html>".into()), "market_unavailable");
    }
}
