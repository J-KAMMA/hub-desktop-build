use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_REPLY: usize = 256 * 1024;
const MAX_REQUEST: usize = 4096;
fn invalid() -> String { "owned_settings_invalid_request".into() }
fn id(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn text(value: &str, max: usize) -> bool { value.encode_utf16().count() <= max && !value.contains('\0') }
fn date(value: &str) -> bool {
    value.len() <= 40 && (chrono::DateTime::parse_from_rfc3339(value).is_ok()
        || chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").is_ok())
}
fn address(value: &str) -> bool {
    value.len() == 42 && value.starts_with("0x") && value[2..].bytes().all(|b| b.is_ascii_hexdigit())
}
fn symbol(chain: u64) -> Option<&'static str> {
    match chain { 137 | 80002 => Some("POL"), 1 | 8453 | 42161 | 10 => Some("ETH"), _ => None }
}
fn amount(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 100 { return None; }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit())
        || fraction.len() > 18 || !fraction.bytes().all(|b| b.is_ascii_digit()) { return None; }
    let wei = format!("{whole}{fraction:0<18}").trim_start_matches('0').to_owned();
    let maximum = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    if wei.len() > maximum.len() || wei.len() == maximum.len() && wei.as_str() > maximum { return None; }
    Some(if wei.is_empty() { "0".into() } else { wei })
}
fn scope(device: &str, origin: &str, viewer: Option<&str>) -> Result<(), String> {
    super::article_publication_scope(device, origin).map_err(|_| invalid())?;
    if viewer.is_some_and(|v| !id(v, 128)) { return Err(invalid()); }
    Ok(())
}
fn options_scope(options: &serde_json::Map<String, Value>) -> Result<(&str, &str, &str), String> {
    let s = |key| options.get(key).and_then(Value::as_str).ok_or_else(invalid);
    let (device, origin, viewer) = (s("expectedDeviceId")?, s("expectedOrigin")?, s("expectedViewerId")?);
    scope(device, origin, Some(viewer))?;
    Ok((device, origin, viewer))
}
fn closed(options: &serde_json::Map<String, Value>, required: &[&str], allowed: &[&str]) -> Result<(), String> {
    if required.iter().any(|key| !options.contains_key(*key)) || options.keys().any(|key| !allowed.contains(&key.as_str())) { return Err(invalid()); }
    Ok(())
}
pub(super) fn action(action: &str, target: Option<&str>, raw: Option<&str>, request_id: Option<&str>, options: Option<&Value>)
    -> Result<(reqwest::Method, String, Value), String> {
    if request_id.is_some() { return Err(invalid()); }
    let options = options.and_then(Value::as_object).ok_or_else(invalid)?;
    options_scope(options)?;
    let (path, body) = if action == "tip_settings" {
        if target.is_some() || raw.is_some() { return Err(invalid()); }
        closed(options, &["address","chainId","expectedDeviceId","expectedOrigin","expectedViewerId"],
            &["address","chainId","enabled","minimumAmount","publishAddress","expectedDeviceId","expectedOrigin","expectedViewerId"])?;
        let addr = options["address"].as_str().filter(|v| address(v)).ok_or_else(invalid)?;
        let chain = options["chainId"].as_u64().filter(|v| symbol(*v).is_some()).ok_or_else(invalid)?;
        if !options.contains_key("enabled") && !options.contains_key("minimumAmount") { return Err(invalid()); }
        let mut body = serde_json::Map::from_iter([("address".into(), json!(addr)),("chainId".into(),json!(chain))]);
        if let Some(value) = options.get("enabled") {
            let enabled = value.as_bool().ok_or_else(invalid)?;
            if enabled && options.get("publishAddress") != Some(&json!(true)) { return Err(invalid()); }
            body.insert("enabled".into(), json!(enabled));
        }
        if let Some(value) = options.get("publishAddress") { body.insert("publishAddress".into(), json!(value.as_bool().ok_or_else(invalid)?)); }
        if let Some(value) = options.get("minimumAmount") {
            let value = value.as_str().filter(|v| amount(v).is_some()).ok_or_else(invalid)?;
            body.insert("minimumAmount".into(), json!(value));
        }
        ("/api/client/tips/settings".to_owned(), Value::Object(body))
    } else {
        if action != "cancel_event_listing" { return Err(invalid()); }
        closed(options, &["expectedDeviceId","expectedOrigin","expectedViewerId"], &["expectedDeviceId","expectedOrigin","expectedViewerId"])?;
        let target = target.filter(|v| id(v,160)).ok_or_else(invalid)?;
        let raw = raw.filter(|v| v.len()<=MAX_REQUEST && !v.contains('\0')).ok_or_else(invalid)?;
        let reason = raw.split(|c:char| c!='\u{0085}' && (c.is_whitespace() || c=='\u{FEFF}'))
            .filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
        if reason.is_empty() || !text(&reason,500) { return Err(invalid()); }
        (format!("/api/client/listings/events/{target}"), json!({"reason":reason}))
    };
    if serde_json::to_vec(&body).map_err(|_| invalid())?.len() > MAX_REQUEST { return Err(invalid()); }
    Ok((reqwest::Method::PATCH, path, body))
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Cursor { updated_at: String, id: String }
fn cursor(raw: &str) -> Result<Cursor, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    if raw.is_empty() || raw.len() > 512 { return Err(invalid()); }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
    if URL_SAFE_NO_PAD.encode(&bytes) != raw { return Err(invalid()); }
    let value: Cursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if !date(&value.updated_at) || !id(&value.id,160) { return Err(invalid()); }
    Ok(value)
}
pub(super) fn read_path(name: &str, ids: &[String]) -> Result<String,String> {
    let path = match name {
        "wallet_tip_settings" if ids.len()==2 => { scope(&ids[0], &ids[1], None)?; "/api/client/tips/settings".into() }
        "owned_event_listings" if matches!(ids.len(),2|3) => {
            scope(&ids[0], &ids[1], None)?;
            let mut url = reqwest::Url::parse("https://hub.invalid/api/client/listings/events").map_err(|_| invalid())?;
            if let Some(after) = ids.get(2) { cursor(after)?; url.query_pairs_mut().append_pair("after", after); }
            format!("{}{}", url.path(), url.query().map(|q| format!("?{q}")).unwrap_or_default())
        }
        "owned_event_listing" if ids.len()==4 && id(&ids[0],160) => {
            scope(&ids[2], &ids[3], Some(&ids[1]))?; format!("/api/client/listings/events/{}",ids[0])
        }
        _ => return Err(invalid()),
    };
    Ok(path)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct TipLink { address: String, chain_id: u64, network: String, symbol: String, tips_enabled: bool, minimum_amount: String, visibility: String }
#[derive(Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct TipSettings { viewer_id: String, links: Vec<TipLink> }
#[derive(Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct TipSaved { viewer_id: String, address: String, chain_id: u64, symbol: String, tips_enabled: bool, minimum_amount: String, visibility: String }
#[derive(Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Listing { id: String, title: String, kind: String, status: String, provider_label: String, provider_url: String,
    starts_at: Option<String>, updated_at: String, cancelled_at: Option<String>, cancellation_reason: Option<String> }
#[derive(Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Listings { viewer_id: String, listings: Vec<Listing>, next_cursor: Value }
#[derive(Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct ListingSaved { viewer_id: String, listing: Listing }
fn valid_tip(addr: &str, chain: u64, unit: &str, minimum: &str, visibility: &str) -> bool {
    address(addr) && symbol(chain)==Some(unit) && amount(minimum).is_some() && matches!(visibility,"public"|"private")
}
fn valid_listing(row: &Listing) -> bool {
    let url = reqwest::Url::parse(&row.provider_url).ok();
    id(&row.id,160) && text(&row.title,160) && !row.title.trim().is_empty() && row.kind=="events"
        && matches!(row.status.as_str(),"draft"|"pending"|"published"|"paused"|"rejected")
        && text(&row.provider_label,120) && !row.provider_label.trim().is_empty() && text(&row.provider_url,2048)
        && !row.provider_url.chars().any(char::is_control)
        && url.is_some_and(|u| u.scheme()=="https" && u.username().is_empty() && u.password().is_none() && u.host_str().is_some())
        && date(&row.updated_at) && row.starts_at.as_ref().is_none_or(|v| date(v))
        && row.cancelled_at.as_ref().is_none_or(|v| date(v))
        && row.cancellation_reason.as_ref().is_none_or(|v| text(v,500) && !v.trim().is_empty())
        && row.cancelled_at.is_some()==row.cancellation_reason.is_some()
}
fn after(row: &Listing, previous: &Cursor) -> bool {
    row.updated_at < previous.updated_at || row.updated_at == previous.updated_at && row.id > previous.id
}
fn decode<T: serde::de::DeserializeOwned + Serialize>(bytes: &[u8]) -> Result<T,()> {
    let value: T=serde_json::from_slice(bytes).map_err(|_|())?;
    if serde_json::from_slice::<Value>(bytes).map_err(|_|())?!=serde_json::to_value(&value).map_err(|_|())? { return Err(()); }
    Ok(value)
}
fn receipt(bytes: &[u8], name: &str, ids: &[String], desired: Option<&Value>) -> Result<Value,String> {
    let prefix = if name=="wallet_tip_settings" { "wallet_tip" } else { "event_listing" };
    let unknown = || format!("{prefix}_unknown");
    if bytes.len()>MAX_REPLY { return Err(unknown()); }
    let expected_viewer = if let Some(body)=desired { body.get("expectedViewerId").and_then(Value::as_str) }
        else if name=="owned_event_listing" { ids.get(1).map(String::as_str) } else { None };
    let viewer_ok = |value: &str| id(value,128) && expected_viewer.is_none_or(|v| v==value);
    if name=="wallet_tip_settings" {
        if let Some(desired)=desired {
            let row: TipSaved = decode(bytes).map_err(|_| unknown())?;
            if !viewer_ok(&row.viewer_id) || !valid_tip(&row.address,row.chain_id,&row.symbol,&row.minimum_amount,&row.visibility)
                || !desired["address"].as_str().is_some_and(|a| a.eq_ignore_ascii_case(&row.address)) || desired["chainId"].as_u64()!=Some(row.chain_id)
                || desired.get("enabled").is_some_and(|v| v.as_bool()!=Some(row.tips_enabled) || row.visibility!=if row.tips_enabled{"public"}else{"private"})
                || desired.get("minimumAmount").is_some_and(|v| v.as_str().and_then(amount)!=amount(&row.minimum_amount)) { return Err(unknown()); }
            return serde_json::to_value(row).map_err(|_| unknown());
        }
        let receipt: TipSettings = decode(bytes).map_err(|_| unknown())?;
        let mut unique = std::collections::HashSet::new();
        if !viewer_ok(&receipt.viewer_id) || receipt.links.len()>100 || receipt.links.iter().any(|r|
            !valid_tip(&r.address,r.chain_id,&r.symbol,&r.minimum_amount,&r.visibility) || !text(&r.network,120) || r.network.trim().is_empty()
                || r.network.chars().any(char::is_control) || !unique.insert((r.address.to_lowercase(),r.chain_id))) { return Err(unknown()); }
        return serde_json::to_value(receipt).map_err(|_| unknown());
    }
    if name=="owned_event_listing" {
        let result: ListingSaved = decode(bytes).map_err(|_| unknown())?;
        if !viewer_ok(&result.viewer_id) || !valid_listing(&result.listing) || ids.first()!=Some(&result.listing.id)
            || desired.is_some_and(|v| result.listing.cancelled_at.is_none() || v["reason"].as_str()!=result.listing.cancellation_reason.as_deref()) { return Err(unknown()); }
        return serde_json::to_value(result).map_err(|_| unknown());
    }
    let result: Listings = decode(bytes).map_err(|_| unknown())?;
    let previous=ids.get(2).map(|v|cursor(v)).transpose().map_err(|_|unknown())?;
    let mut unique=std::collections::HashSet::new();
    if !viewer_ok(&result.viewer_id) || result.listings.len()>20 || result.listings.iter().any(|r| !valid_listing(r)
        || !unique.insert(&r.id) || previous.as_ref().is_some_and(|p| !after(r,p)))
        || result.listings.windows(2).any(|r| !after(&r[1],&Cursor{updated_at:r[0].updated_at.clone(),id:r[0].id.clone()})) { return Err(unknown()); }
    if !result.next_cursor.is_null() {
        let next=cursor(result.next_cursor.as_str().ok_or_else(unknown)?).map_err(|_|unknown())?;
        if !result.listings.last().is_some_and(|r| r.id==next.id && r.updated_at==next.updated_at) { return Err(unknown()); }
    }
    serde_json::to_value(result).map_err(|_|unknown())
}

async fn request(base: &str, name: &str, path: &str, ids: &[String], device: &str, origin: &str,
    body: Option<&Value>, desired: Option<&Value>) -> Result<Value,String> {
    let prefix=if name=="wallet_tip_settings"{"wallet_tip"}else{"event_listing"};
    let unknown=||format!("{prefix}_unknown");
    super::require_article_publication_owner(base,device,origin)?;
    let assertion=crate::desktop_account::assertion_if_registered(base).await;
    super::require_article_publication_owner(base,device,origin)?;
    let assertion=assertion.map_err(|_|unknown())?.ok_or("desktop_not_connected")?;
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_|unknown())?;
    let mut request=client.request(if body.is_some(){reqwest::Method::PATCH}else{reqwest::Method::GET},format!("{}{path}",base.trim_end_matches('/')))
        .bearer_auth(assertion).header(reqwest::header::ORIGIN,origin);
    if let Some(body)=body { request=request.json(body); }
    let mut response=request.send().await.map_err(|_|unknown())?;
    super::require_article_publication_owner(base,device,origin)?;
    match response.status().as_u16() {
        200=>{},401=>return Err("desktop_not_connected".into()),409=>return Err(format!("{prefix}_conflict")),
        status @ (400|403|404|413|429)=>return Err(format!("{prefix}_rejected:{status}")),_=>return Err(unknown()),
    }
    if !super::git_application_json_mime(response.headers()) { return Err(unknown()); }
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|unknown())? {
        if chunk.len()>MAX_REPLY.saturating_sub(bytes.len()) { return Err(unknown()); } bytes.extend_from_slice(&chunk);
    }
    super::require_article_publication_owner(base,device,origin)?;
    receipt(&bytes,name,ids,desired)
}
pub(super) async fn read(base: &str,name: &str,ids: &[String]) -> Result<Value,String> {
    let path=read_path(name,ids)?;
    let (device,origin)=if name=="owned_event_listing"{(&ids[2],&ids[3])}else{(&ids[0],&ids[1])};
    request(base,name,&path,ids,device,origin,None,None).await
}
pub(super) async fn write(base: &str,action_name: &str,target: Option<&str>,raw: Option<&str>,request_id: Option<&str>,options: Option<&Value>) -> Result<Value,String> {
    let (_,path,body)=action(action_name,target,raw,request_id,options)?;
    let options=options.and_then(Value::as_object).ok_or_else(invalid)?;
    let (device,origin,viewer)=options_scope(options)?;
    let mut desired=body.clone(); desired["expectedViewerId"]=json!(viewer);
    let name=if action_name=="tip_settings"{"wallet_tip_settings"}else{"owned_event_listing"};
    let ids=target.map(|v|vec![v.to_owned(),viewer.to_owned(),device.to_owned(),origin.to_owned()]).unwrap_or_default();
    request(base,name,&path,&ids,device,origin,Some(&body),Some(&desired)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn opts() -> Value { json!({"expectedDeviceId":"device-27","expectedOrigin":"http://127.0.0.1:3020","expectedViewerId":"viewer-27"}) }
    fn tip() -> Value { let mut v=opts();v["address"]=json!("0x1111111111111111111111111111111111111111");v["chainId"]=json!(80002);v["minimumAmount"]=json!("0.1");v }
    fn listing(n: u32) -> Value { json!({"id":format!("event-{n:03}"),"title":"Event","kind":"events","status":"published","providerLabel":"Provider","providerUrl":"https://example.org/event","startsAt":null,"updatedAt":"2026-10-07 09:00:00","cancelledAt":null,"cancellationReason":null}) }
    fn bytes(v:&Value)->Vec<u8>{serde_json::to_vec(v).unwrap()}
    fn list_ids()->Vec<String>{vec!["device-27".into(),"http://127.0.0.1:3020".into()]}
    #[test]
    fn stage27_tip_omission_and_chain_are_preserved_without_scope_payload() {
        let (_,path,body)=action("tip_settings",None,None,None,Some(&tip())).unwrap();
        assert_eq!(path,"/api/client/tips/settings");assert_eq!(body.as_object().unwrap().len(),3);
        assert!(body.get("enabled").is_none());assert!(body.get("expectedViewerId").is_none());assert_eq!(body["chainId"],80002);
        let mut v=tip();v["enabled"]=json!(true);assert!(action("tip_settings",None,None,None,Some(&v)).is_err());
        v["publishAddress"]=json!(true);assert!(action("tip_settings",None,None,None,Some(&v)).is_ok());
        for (key,value) in [("enabled",Value::Null),("minimumAmount",Value::Null),("chainId",json!(9007199254740992u64)),("owner",json!("other"))] {
            let mut v=tip();v[key]=value;assert!(action("tip_settings",None,None,None,Some(&v)).is_err(),"{key}");
        }
    }
    #[test]
    fn stage27_uint256_decimal_boundary_has_no_float_rounding() {
        let max="115792089237316195423570985008687907853269984665640564039457.584007913129639935";
        assert!(amount(max).is_some());assert!(amount(&max.replace("639935","639936")).is_none());
        for v in ["-1","1e3","NaN","1.0000000000000000001","1..2",".1","1\n"] {assert!(amount(v).is_none(),"{v}");}
        assert_eq!(amount("000.1000"),amount("0.1"));assert_eq!(amount("0."),Some("0".into()));
    }
    #[test]
    fn stage27_event_reason_target_and_scope_are_closed() {
        let (_,path,body)=action("cancel_event_listing",Some("event-1"),Some("  a\n b "),None,Some(&opts())).unwrap();
        assert_eq!(path,"/api/client/listings/events/event-1");assert_eq!(body,json!({"reason":"a b"}));
        let (_,_,nel)=action("cancel_event_listing",Some("event-1"),Some("中止\u{0085}理由"),None,Some(&opts())).unwrap();
        assert_eq!(nel["reason"],"中止\u{0085}理由");
        let (_,_,bom)=action("cancel_event_listing",Some("event-1"),Some("\u{FEFF}中止\u{FEFF}理由\u{FEFF}"),None,Some(&opts())).unwrap();
        assert_eq!(bom["reason"],"中止 理由");
        assert!(action("cancel_event_listing",Some("event-1"),Some(&format!("{}reason"," ".repeat(MAX_REQUEST+1))),None,Some(&opts())).is_err());
        assert!(action("cancel_event_listing",Some("../other"),Some("why"),None,Some(&opts())).is_err());
        for reason in ["".into(),"x".repeat(501),"😀".repeat(251),"a\0b".into()] {
            assert!(action("cancel_event_listing",Some("event-1"),Some(&reason),None,Some(&opts())).is_err());
        }
        assert!(action("cancel_event_listing",Some("event-1"),Some(&"😀".repeat(250)),None,Some(&opts())).is_ok());
        let mut v=opts();v["expectedOrigin"]=json!("https://example.org/path");assert!(action("cancel_event_listing",Some("event-1"),Some("why"),None,Some(&v)).is_err());
    }
    #[test]
    fn stage27_reads_cannot_supply_arbitrary_paths_or_owners() {
        assert!(read_path("wallet_tip_settings",&list_ids()).is_ok());
        assert!(read_path("owned_event_listings",&list_ids()).is_ok());
        assert!(read_path("unknown",&list_ids()).is_err());
        let mut ids=list_ids();ids.push("arbitrary".into());assert!(read_path("wallet_tip_settings",&ids).is_err());assert!(read_path("owned_event_listings",&ids).is_err());
        assert!(read_path("owned_event_listing",&["../x".into(),"viewer-27".into(),"device-27".into(),"http://127.0.0.1:3020".into()]).is_err());
    }
    #[test]
    fn stage27_tip_receipt_matches_viewer_chain_and_optional_desire() {
        let mut desired=tip();let mut saved=json!({"viewerId":"viewer-27","address":desired["address"],"chainId":80002,"symbol":"POL","tipsEnabled":false,"minimumAmount":"0.100","visibility":"private"});
        assert!(receipt(&bytes(&saved),"wallet_tip_settings",&[],Some(&desired)).is_ok());
        for (key,v) in [("viewerId",json!("other")),("chainId",json!(137)),("minimumAmount",json!("0.2")),("extra",json!("x"))] {
            let mut bad=saved.clone();bad[key]=v;assert!(receipt(&bytes(&bad),"wallet_tip_settings",&[],Some(&desired)).is_err());
        }
        desired["enabled"]=json!(true);desired["publishAddress"]=json!(true);saved["tipsEnabled"]=json!(true);
        assert!(receipt(&bytes(&saved),"wallet_tip_settings",&[],Some(&desired)).is_err());saved["visibility"]=json!("public");
        assert!(receipt(&bytes(&saved),"wallet_tip_settings",&[],Some(&desired)).is_ok());
    }
    #[test]
    fn stage27_tip_list_rejects_duplicate_links_missing_fields_and_overflow() {
        let row=json!({"address":tip()["address"],"chainId":80002,"network":"polygon amoy","symbol":"POL","tipsEnabled":false,"minimumAmount":"0","visibility":"private"});
        let valid=json!({"viewerId":"viewer-27","links":[row]});assert!(receipt(&bytes(&valid),"wallet_tip_settings",&list_ids(),None).is_ok());
        let mut duplicate=valid.clone();duplicate["links"]=json!([row,row]);assert!(receipt(&bytes(&duplicate),"wallet_tip_settings",&list_ids(),None).is_err());
        duplicate["links"]=json!(vec![row;101]);assert!(receipt(&bytes(&duplicate),"wallet_tip_settings",&list_ids(),None).is_err());
        assert!(receipt(&vec![b' ';MAX_REPLY+1],"wallet_tip_settings",&[],None).is_err());
    }
    #[test]
    fn stage27_event_pages_require_stable_keysets_and_exact_nullable_fields() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD,Engine};
        let next=URL_SAFE_NO_PAD.encode(bytes(&json!({"updatedAt":"2026-10-07 09:00:00","id":"event-002"})));
        let valid=json!({"viewerId":"viewer-27","listings":[listing(1),listing(2)],"nextCursor":next});
        assert!(receipt(&bytes(&valid),"owned_event_listings",&list_ids(),None).is_ok());
        let mut bad=valid.clone();bad["listings"]=json!([listing(2),listing(1)]);assert!(receipt(&bytes(&bad),"owned_event_listings",&list_ids(),None).is_err());
        bad=valid.clone();bad["listings"][0].as_object_mut().unwrap().remove("startsAt");assert!(receipt(&bytes(&bad),"owned_event_listings",&list_ids(),None).is_err());
        let mut ids=list_ids();ids.push(next);assert!(receipt(&bytes(&valid),"owned_event_listings",&ids,None).is_err());
        for raw in ["e30=","e30","x".repeat(513).as_str()] {assert!(cursor(raw).is_err());}
    }
    #[test]
    fn stage27_event_cancel_ack_is_owned_and_exact_reason_without_payment_data() {
        let ids=vec!["event-001".into(),"viewer-27".into(),"device-27".into(),"http://127.0.0.1:3020".into()];
        let mut row=listing(1);row["cancelledAt"]=json!("2026-10-07T10:00:00.000Z");row["cancellationReason"]=json!("reason");
        let valid=json!({"viewerId":"viewer-27","listing":row});let desired=json!({"reason":"reason","expectedViewerId":"viewer-27"});
        assert!(receipt(&bytes(&valid),"owned_event_listing",&ids,Some(&desired)).is_ok());
        for (key,v) in [("cancellationReason",json!("different")),("cancelledAt",Value::Null),("payment",json!("order"))] {
            let mut bad=valid.clone();bad["listing"][key]=v;assert!(receipt(&bytes(&bad),"owned_event_listing",&ids,Some(&desired)).is_err());
        }
    }
}
