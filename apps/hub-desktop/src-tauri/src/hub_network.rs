use serde::{Deserialize, Serialize};
const MAX_BYTES: usize = 1024 * 1024;

pub fn origin(raw: &str) -> Result<String, String> {
    if raw.len() > 2048 { return Err("接続先が長すぎます".into()); }
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "HubのURLを確認してください")?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || url.path() != "/" || url.host_str().is_none() || !(url.scheme()=="https" || (local && url.scheme()=="http")) {
        return Err("HTTPSのHub URLを指定してください。ローカルHubはHTTPも使えます".into());
    }
    Ok(url.origin().ascii_serialization())
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Item {
    pub id:String, pub title:String, pub summary:String, pub path:String, pub updated_at:String,
    // Only the "music" kind may carry media; validated strictly in read_query.
    #[serde(default, skip_serializing_if="Option::is_none")]
    pub media:Option<Media>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Media {
    #[serde(default, skip_serializing_if="Option::is_none")] pub youtube_id:Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub audio_path:Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub artist:Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub artwork_path:Option<String>,
    // "video" kind only (external-platform reference): never bytes or paths.
    #[serde(default, skip_serializing_if="Option::is_none")] pub channel:Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub duration:Option<String>,
}
fn token_ok(s:&str,min:usize,max:usize)->bool { (min..=max).contains(&s.len())&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-') }
/// "/music/api/tracks/<id>/<tail>" -> id, with the id restricted to URL-safe token characters.
fn track_path_id<'a>(path:&'a str,tail:&str)->Option<&'a str> {
    let rest=path.strip_prefix("/music/api/tracks/")?.strip_suffix(tail)?;
    token_ok(rest,1,128).then_some(rest)
}
fn music_item_ok(item:&Item)->bool {
    let Some(media)=&item.media else {return false};
    if media.channel.is_some()||media.duration.is_some() {return false;}
    if media.artist.as_ref().is_some_and(|a|a.chars().count()>160||a.chars().any(|c|c.is_control())) {return false;}
    let audio=media.audio_path.as_deref().map(|p|track_path_id(p,"/audio"));
    if let Some(art)=media.artwork_path.as_deref() {
        // Artwork is only meaningful for Worker tracks and must name the same track.
        if audio.flatten().is_none()||track_path_id(art,"/artwork")!=audio.flatten() {return false;}
    }
    match (&media.youtube_id,audio) {
        (Some(y),None)=>y.len()==11&&token_ok(y,11,11)&&item.path==format!("/v2/music/works/{}",item.id),
        (None,Some(Some(id)))=>id==item.id&&item.path==format!("/v2/music/works/music:{}",item.id),
        _=>false,
    }
}
/// A video item is only a reference to an external platform: optional YouTube id, channel and duration text.
fn video_item_ok(item:&Item)->bool {
    if item.path!=format!("/v2/videos/{}",item.id) {return false;}
    let Some(media)=&item.media else {return true};
    if media.audio_path.is_some()||media.artwork_path.is_some()||media.artist.is_some() {return false;}
    if media.youtube_id.as_ref().is_some_and(|y|!token_ok(y,11,11)) {return false;}
    let text_ok=|v:&Option<String>,max:usize|v.as_ref().is_none_or(|t|t.chars().count()<=max&&!t.chars().any(|c|c.is_control()));
    text_ok(&media.channel,160)&&text_ok(&media.duration,16)
}
// Peer tracks whose audio the user may fetch: only (origin,path) pairs a validated music catalog just named.
fn seen_audio()->&'static std::sync::Mutex<std::collections::VecDeque<(String,String)>> {
    static SEEN:std::sync::OnceLock<std::sync::Mutex<std::collections::VecDeque<(String,String)>>>=std::sync::OnceLock::new();
    SEEN.get_or_init(Default::default)
}
fn remember_audio(base:&str,catalog:&Catalog) {
    let mut seen=seen_audio().lock().unwrap_or_else(|e|e.into_inner());
    for path in catalog.items.iter().filter_map(|i|i.media.as_ref()?.audio_path.clone()) {
        let key=(base.to_string(),path);
        seen.retain(|k|k!=&key);seen.push_back(key);
        while seen.len()>512 {seen.pop_front();}
    }
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Catalog {
    pub protocol:String, pub kind:String, pub items:Vec<Item>,
    #[serde(default, deserialize_with="optional_query", skip_serializing_if="Option::is_none")]
    pub query:Option<String>,
}
fn optional_query<'de,D:serde::Deserializer<'de>>(deserializer:D)->Result<Option<String>,D::Error> {
    String::deserialize(deserializer).map(Some)
}
fn query_whitespace(c:char)->bool {
    matches!(c, '\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn research_query(raw:&str)->Result<&str,String> {
    if raw.encode_utf16().count()>100 || raw.chars().any(|c|c<='\u{001f}'||('\u{007f}'..='\u{009f}').contains(&c)) {return Err("検索語は100文字・8語以内で、制御文字を含めず指定してください".into());}
    let query=raw.trim_matches(query_whitespace);
    if query.split(query_whitespace).filter(|term|!term.is_empty()).count()>8 {return Err("検索語は100文字・8語以内で指定してください".into());}
    Ok(query)
}
fn prefix(kind:&str) -> Result<&'static str,String> {
    match kind { "post"=>Ok("/v2/posts/"), "research"=>Ok("/v2/research/"), "music"=>Ok("/v2/music/works/"), "video"=>Ok("/v2/videos/"), _=>Err("対象の種類が不正です".into()) }
}
// Retry only anonymous, idempotent reads; preserve the per-attempt deadline and redirect policy.
async fn public_response(client:&reqwest::Client,url:&str)->Result<reqwest::Response,String>{
    for attempt in 0..2 {
        let result=client.get(url).send().await;
        let transient=match &result {
            Ok(response)=>matches!(response.status().as_u16(),502|503|504),
            Err(error)=>error.is_timeout()||error.is_connect(),
        };
        if transient&&attempt==0 {tokio::time::sleep(std::time::Duration::from_millis(400)).await;continue;}
        let response=result.map_err(|error|if error.is_timeout(){"network_timeout"}else{"network_unavailable"})?;
        if matches!(response.status().as_u16(),502|503|504){return Err("service_unavailable".into());}
        return Ok(response);
    }
    unreachable!()
}
pub async fn read(raw:&str, kind:&str) -> Result<Catalog,String> {
    read_query(raw,kind,"").await
}
pub async fn read_query(raw:&str, kind:&str, query:&str) -> Result<Catalog,String> {
    let base=origin(raw)?; let path=prefix(kind)?;
    let term=research_query(query)?;
    if kind!="research"&&!term.is_empty() {return Err("検索語を指定できるのは研究だけです".into());}
    // No assertion, cookie, user identity, redirect, or caller-selected API path.
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"接続を開始できません")?;
    let mut url=reqwest::Url::parse(&format!("{base}/api/network/v1/catalog")).map_err(|_|"接続を開始できません")?;
    url.query_pairs_mut().append_pair("kind",kind);
    if kind=="research"&&!term.is_empty() {url.query_pairs_mut().append_pair("q",term);}
    let mut response=public_response(&client,url.as_str()).await?;
    if !response.status().is_success() {return Err("Hubが一覧を返せませんでした".into());}
    if response.content_length().unwrap_or(0)>MAX_BYTES as u64 {return Err("Hubの応答が大きすぎます".into());}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"一覧を受信できません")? {
        if bytes.len()+chunk.len()>MAX_BYTES {return Err("Hubの応答が大きすぎます".into());} bytes.extend_from_slice(&chunk);
    }
    let catalog:Catalog=serde_json::from_slice(&bytes).map_err(|_|"対応するHubの一覧ではありません")?;
    let max_items=if kind=="music"||kind=="video"{100}else{30};
    if catalog.protocol!="hub.catalog.v1"||catalog.kind!=kind||catalog.items.len()>max_items {return Err("Hubの形式が対応していません".into());}
    if kind=="research"&&catalog.query.as_deref().unwrap_or("")!=term {return Err("このHubは指定した研究検索に対応していません".into());}
    for item in &catalog.items {
        if !(!item.id.is_empty()&&item.id.len()<=128&&item.id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-'))
            ||item.title.chars().count()>240||item.summary.chars().count()>5000||item.updated_at.len()>40
            ||(if kind=="music"{!music_item_ok(item)}else if kind=="video"{!video_item_ok(item)}else{item.media.is_some()||item.path!=format!("{path}{}",item.id)}) {
            return Err("Hubの一覧に不正な項目があります".into());
        }
    }
    if kind=="music"||kind=="video" {
        let mut ids=std::collections::HashSet::new();
        if !catalog.items.iter().all(|i|ids.insert(i.id.as_str())) {return Err("Hubの一覧に不正な項目があります".into());}
        if kind=="music" {remember_audio(&base,&catalog);}
    }
    Ok(catalog)
}
/// Anonymous audio for a peer's public Worker track. No credentials, no redirects, 64 MiB cap, audio/* only,
/// and only for an (origin, path) pair that origin's validated music catalog named in this session.
pub async fn audio(raw:&str,path:&str)->Result<Vec<u8>,String> {
    const MAX_AUDIO:u64=64*1024*1024;
    let base=origin(raw)?;
    if path.len()>200||track_path_id(path,"/audio").is_none() {return Err("音声の場所が不正です".into());}
    let known=seen_audio().lock().unwrap_or_else(|e|e.into_inner()).iter().any(|(o,p)|o==&base&&p==path);
    if !known {return Err("このHubの音楽一覧に無い音声です".into());}
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"接続を開始できません")?;
    let mut response=public_response(&client,&format!("{base}{path}")).await?;
    if !response.status().is_success() {return Err("Hubが音声を返せませんでした".into());}
    let audio_type=response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v|v.to_str().ok())
        .is_some_and(|v|v.trim_start().to_ascii_lowercase().starts_with("audio/"));
    if !audio_type {return Err("音声ではない応答です".into());}
    if response.content_length().unwrap_or(0)>MAX_AUDIO {return Err("音声が大きすぎます".into());}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"音声を受信できません")? {
        if bytes.len() as u64+chunk.len() as u64>MAX_AUDIO {return Err("音声が大きすぎます".into());} bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn research_terms_use_raw_utf16_limits_js_whitespace_and_no_controls() {
        assert_eq!(research_query("\u{feff} Ａ + & 日本語 \u{00a0}").unwrap(),"Ａ + & 日本語");
        assert_eq!(research_query(&"😀".repeat(50)).unwrap(),"😀".repeat(50));
        assert!(research_query(&"😀".repeat(51)).is_err());
        for raw in [format!(" {}", "a".repeat(100)),"a a a a a a a a a".into(),"a\nquery".into(),"a\u{7f}".into(),"a\u{85}".into()] {assert!(research_query(&raw).is_err());}
        assert_eq!(research_query("a\u{feff}b\u{202f}c").unwrap(),"a\u{feff}b\u{202f}c");
        assert!(research_query(&["a";9].join("\u{feff}")).is_err());
        assert!(serde_json::from_str::<Catalog>(r#"{"protocol":"hub.catalog.v1","kind":"research","items":[],"query":null}"#).is_err());
        assert!(serde_json::from_str::<Catalog>(r#"{"protocol":"hub.catalog.v1","kind":"research","items":[],"query":"\ud800"}"#).is_err());
    }
    async fn catalog_server(body:String, status:u16, extra:String)->(String,tokio::task::JoinHandle<String>) {
        use tokio::{net::TcpListener,io::{AsyncReadExt,AsyncWriteExt}};
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}",listener.local_addr().unwrap());
        let server=tokio::spawn(async move {
            let (mut stream,_)=listener.accept().await.unwrap();let mut request=Vec::new();let mut buf=[0u8;4096];
            while !request.windows(4).any(|w|w==b"\r\n\r\n") {let n=stream.read(&mut buf).await.unwrap();assert!(n>0);request.extend_from_slice(&buf[..n]);assert!(request.len()<16384);}
            let request=String::from_utf8(request).unwrap();let headers=request.to_ascii_lowercase();assert!(!headers.contains("authorization:"));assert!(!headers.contains("cookie:"));assert!(!headers.contains("x-hub-"));
            let reply=format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",body.len());
            let _=stream.write_all(reply.as_bytes()).await;request
        });(base,server)
    }
    #[tokio::test] async fn research_transport_encodes_exact_query_only_at_fixed_public_path_and_sends_no_credentials() {
        let term="Ａ + & 日本語";
        let body=serde_json::json!({"protocol":"hub.catalog.v1","kind":"research","query":term,"items":[{"id":"older","title":"Old result","summary":"public only","path":"/v2/research/older","updatedAt":"2026-10-04"}]}).to_string();
        let (base,server)=catalog_server(body,200,String::new()).await;
        let catalog=read_query(&base,"research",&format!("\u{feff} {term} \u{feff}")).await.unwrap();assert_eq!(catalog.items[0].id,"older");assert_eq!(catalog.query.as_deref(),Some(term));
        let request=server.await.unwrap();let target=request.lines().next().unwrap().split_whitespace().nth(1).unwrap();let url=reqwest::Url::parse(&format!("{base}{target}")).unwrap();
        assert_eq!(url.path(),"/api/network/v1/catalog");assert_eq!(url.query_pairs().collect::<Vec<_>>(),vec![("kind".into(),"research".into()),("q".into(),term.into())]);assert!(!target.contains("日本語"));assert!(target.contains("%2B"));assert!(target.contains("%26"));
    }
    #[tokio::test] async fn nonempty_research_requires_exact_echo_and_empty_research_keeps_legacy_latest30() {
        for echo in [None,Some(serde_json::json!("other")),Some(serde_json::json!(null)),Some(serde_json::json!(42))] {
            let mut body=serde_json::json!({"protocol":"hub.catalog.v1","kind":"research","items":[]});if let Some(value)=echo {body["query"]=value;}
            let (base,server)=catalog_server(body.to_string(),200,String::new()).await;assert!(read_query(&base,"research","old").await.is_err());server.await.unwrap();
        }
        let items:Vec<_>=(0..30).map(|i|serde_json::json!({"id":i.to_string(),"title":"Latest","summary":"","path":format!("/v2/research/{i}"),"updatedAt":"2026-10-04"})).collect();
        let body=serde_json::json!({"protocol":"hub.catalog.v1","kind":"research","items":items}).to_string();let (base,server)=catalog_server(body,200,String::new()).await;
        assert_eq!(read(&base,"research").await.unwrap().items.len(),30);let request=server.await.unwrap();assert!(request.starts_with("GET /api/network/v1/catalog?kind=research "));assert!(!request.contains("&q="));
        assert!(read_query("http://127.0.0.1:1","post","query").await.is_err());assert!(read_query("http://127.0.0.1:1","research",&"a".repeat(101)).await.is_err());
    }
    #[tokio::test] async fn public_catalog_does_not_follow_redirects_and_caps_declared_and_streamed_bytes() {
        use tokio::{net::TcpListener,io::{AsyncReadExt,AsyncWriteExt}};
        let destination=TcpListener::bind("127.0.0.1:0").await.unwrap();let (base,server)=catalog_server(String::new(),302,format!("Location: http://{}/steal\r\n",destination.local_addr().unwrap())).await;
        assert!(read_query(&base,"research","private terms").await.is_err());server.await.unwrap();assert!(tokio::time::timeout(std::time::Duration::from_millis(40),destination.accept()).await.is_err());
        let (base,server)=catalog_server("x".repeat(MAX_BYTES+1),200,String::new()).await;assert_eq!(read(&base,"research").await.unwrap_err(),"Hubの応答が大きすぎます");server.await.unwrap();
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}",listener.local_addr().unwrap());
        let server=tokio::spawn(async move {let (mut stream,_)=listener.accept().await.unwrap();let mut buf=[0;4096];stream.read(&mut buf).await.unwrap();stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
            let chunk=vec![b'x';MAX_BYTES+1];let _=stream.write_all(format!("{:x}\r\n",chunk.len()).as_bytes()).await;let _=stream.write_all(&chunk).await;let _=stream.write_all(b"\r\n0\r\n\r\n").await;});
        assert_eq!(read(&base,"research").await.unwrap_err(),"Hubの応答が大きすぎます");server.await.unwrap();
        let items:Vec<_>=(0..31).map(|i|serde_json::json!({"id":i.to_string(),"title":"Latest","summary":"","path":format!("/v2/research/{i}"),"updatedAt":"2026-10-04"})).collect();let (base,server)=catalog_server(serde_json::json!({"protocol":"hub.catalog.v1","kind":"research","items":items}).to_string(),200,String::new()).await;assert!(read(&base,"research").await.is_err());server.await.unwrap();
    }
    #[test] fn assertion_failures_distinguish_identity_from_connectivity() {
        for error in ["desktop_account_signed_out","desktop_account_not_registered","desktop_account_unauthorized","desktop_account_key_invalid","desktop_account_request_expired","device_proof_rejected"] {
            assert_eq!(assertion_error(error.into()),"account_required");
        }
        for error in ["desktop_account_network_unavailable","desktop_account_request_failed"] {
            assert_eq!(assertion_error(error.into()),"network_unavailable");
        }
    }
    #[tokio::test] async fn anonymous_reads_retry_only_transient_failures_and_stop_after_two_attempts() {
        use tokio::{net::TcpListener,io::{AsyncReadExt,AsyncWriteExt}};
        use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
        for (statuses,expected,count) in [(vec![0,200],200,2),(vec![503,200],200,2),(vec![503,503],0,2),(vec![401],401,1),(vec![404],404,1),(vec![302],302,1)] {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}/public",listener.local_addr().unwrap());
            let calls=Arc::new(AtomicUsize::new(0));let recorded=calls.clone();
            let server=tokio::spawn(async move {for status in statuses {let (mut stream,_)=listener.accept().await.unwrap();let mut bytes=[0;4096];let n=stream.read(&mut bytes).await.unwrap();let request=String::from_utf8_lossy(&bytes[..n]).to_lowercase();
                assert!(request.starts_with("get /public "));assert!(!request.contains("authorization:"));assert!(!request.contains("cookie:"));recorded.fetch_add(1,Ordering::SeqCst);
                if status==0 {tokio::time::sleep(std::time::Duration::from_millis(150)).await;continue;}
                stream.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nLocation: /redirected\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            }});
            let client=reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_millis(100)).redirect(reqwest::redirect::Policy::none()).build().unwrap();
            let response=public_response(&client,&url).await;
            if expected==0 {assert_eq!(response.unwrap_err(),"service_unavailable");}else {assert_eq!(response.unwrap().status().as_u16(),expected);}
            server.await.unwrap();assert_eq!(calls.load(Ordering::SeqCst),count);
        }
    }
    #[test] fn origins_are_explicit_and_never_fall_back_to_the_official_hub() {
        assert_eq!(origin("https://community.example/").unwrap(),"https://community.example");
        assert!(origin("https://community.example/other").is_err());
        assert!(origin("https://user:password@community.example/").is_err());
        assert!(origin("http://community.example").is_err());
        assert!(origin("https://community.example/?target=other").is_err());
        assert!(prefix("admin").is_err());
    }
    #[tokio::test] async fn independent_hubs_remain_readable_when_one_stops() {
        use tokio::{net::TcpListener,io::{AsyncReadExt,AsyncWriteExt}};
        async fn serve(title:&'static str)->(String,tokio::task::JoinHandle<()>) {
            let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let address=format!("http://{}",listener.local_addr().unwrap());
            let task=tokio::spawn(async move {loop {let (mut stream,_)=listener.accept().await.unwrap();let mut request=[0u8;8192];let count=stream.read(&mut request).await.unwrap();let headers=String::from_utf8_lossy(&request[..count]).to_lowercase();assert!(!headers.contains("authorization:"));assert!(!headers.contains("cookie:"));
                let body=serde_json::json!({"protocol":"hub.catalog.v1","kind":"post","items":[{"id":"same-id","title":title,"summary":"public","path":"/v2/posts/same-id","updatedAt":"2026-09-30"}]}).to_string();
                let reply=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);stream.write_all(reply.as_bytes()).await.unwrap();
            }});(address,task)
        }
        let (a,first)=serve("A").await;let (b,second)=serve("B").await;
        let (one,two)=tokio::join!(read(&a,"post"),read(&b,"post"));assert_eq!(one.unwrap().items[0].title,"A");assert_eq!(two.unwrap().items[0].title,"B");
        first.abort();let _=first.await;assert!(read(&a,"post").await.is_err());assert_eq!(read(&b,"post").await.unwrap().items[0].title,"B");second.abort();
    }
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Sources { pub sources: Vec<String> }

fn source_body(base: &str, action: &str, raw: Option<&str>) -> Result<Option<serde_json::Value>, String> {
    match action {
        "list" if raw.is_none() => Ok(None),
        "add" | "remove" => {
            let raw = raw.ok_or("invalid_source")?;
            if raw.len() > 512 { return Err("invalid_source".into()); }
            let source = origin(raw)?;
            if source == base { return Err("invalid_source".into()); }
            Ok(Some(serde_json::json!({"action":action,"origin":source})))
        }
        _ => Err("invalid_action".into()),
    }
}

fn decode_sources(bytes: &[u8], base: &str) -> Result<Sources, String> {
    let result: Sources = serde_json::from_slice(bytes).map_err(|_| "invalid_response")?;
    if result.sources.len() > 8 || result.sources.iter().any(|s| s.len() > 512 || s == base || origin(s).as_ref() != Ok(s)) {
        return Err("invalid_response".into());
    }
    Ok(result)
}

pub(crate) fn require_source_owner(base: &str, expected: &str) -> Result<(), String> {
    let status = crate::desktop_account::status(base).map_err(|_| "account_required")?;
    if expected.is_empty() || status.state != "registered" || status.device_id.as_deref() != Some(expected) {
        return Err("account_changed".into());
    }
    Ok(())
}

fn assertion_error(error:String)->String {
    match error.as_str() {
        "desktop_account_signed_out"|"desktop_account_not_registered"|"desktop_account_unauthorized"|"desktop_account_key_invalid"|"desktop_account_request_expired"|"device_proof_rejected"=>"account_required",
        _=>"network_unavailable",
    }.into()
}
pub async fn account_sources(base: &str, expected: &str, action: &str, raw: Option<&str>) -> Result<Sources, String> {
    let base = origin(base)?;
    let body = source_body(&base, action, raw)?;
    require_source_owner(&base, expected)?;
    let assertion = crate::desktop_account::assertion(&base).await.map_err(assertion_error)?;
    // Account lookup and assertion issuance await network I/O; never use a different local owner.
    require_source_owner(&base, expected)?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "network_unavailable")?;
    let url = format!("{base}/api/client/network/sources");
    let request = match body { Some(body) => client.post(url).json(&body), None => client.get(url) };
    let mut response = request.bearer_auth(assertion).send().await.map_err(|_| "network_unavailable")?;
    match response.status().as_u16() {
        200 => (),
        401 | 403 => return Err("account_required".into()),
        409 => return Err("source_limit".into()),
        _ => return Err("network_unavailable".into()),
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "network_unavailable")? {
        if bytes.len() + chunk.len() > 16 * 1024 { return Err("invalid_response".into()); }
        bytes.extend_from_slice(&chunk);
    }
    require_source_owner(&base, expected)?;
    decode_sources(&bytes, &base)
}

#[cfg(test)]
mod source_tests {
    use super::*;
    #[test]
    fn source_actions_are_bounded_and_cannot_choose_the_authenticated_endpoint() {
        let base = "https://main.example";
        assert!(source_body(base,"list",None).unwrap().is_none());
        assert!(source_body(base,"list",Some("https://other.example")).is_err());
        assert!(source_body(base,"delete_profile",None).is_err());
        assert!(source_body(base,"add",Some(base)).is_err());
        assert!(source_body(base,"add",Some(&format!("https://{}.example", "x".repeat(512)))).is_err());
        assert!(source_body(base,"add",Some("https://other.example/api/admin")).is_err());
        assert_eq!(source_body(base,"remove",Some("https://OTHER.example/")).unwrap().unwrap(),serde_json::json!({"action":"remove","origin":"https://other.example"}));
    }
    #[test]
    fn account_source_responses_reject_oversized_lists_and_invalid_origins() {
        let base="https://main.example";
        assert_eq!(decode_sources(br#"{"sources":["https://other.example"]}"#,base).unwrap().sources.len(),1);
        for value in [serde_json::json!({"sources":vec!["https://other.example";9]}),serde_json::json!({"sources":[base]}),serde_json::json!({"sources":["https://other.example/private"]}),serde_json::json!({"sources":null})] {
            assert!(decode_sources(&serde_json::to_vec(&value).unwrap(),base).is_err());
        }
    }
}

pub async fn post_manifest(raw: &str) -> Result<serde_json::Value, String> {
    let base=origin(raw)?;
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"network_unavailable")?;
    let response=public_response(&client,&format!("{base}/api/network/v1/catalog?kind=post&manifest=1")).await?;
    let body=bounded_peer_json(response,4096).await?;
    if body["protocol"]!="hub.post-manifest.v1" || body["origin"]!=base
        || !body["digest"].as_str().is_some_and(|s|s.len()==64&&s.bytes().all(|c|c.is_ascii_hexdigit()))
        || !body["bytes"].as_u64().is_some_and(|n|(1..=1048576).contains(&n)) {return Err("invalid_manifest".into());}
    Ok(body)
}
fn peer_control_body(input:&serde_json::Value)->Result<serde_json::Value,String>{
    let action=input["action"].as_str().ok_or("invalid_action")?;
    let mut body=serde_json::json!({"action":action});
    let id=|field:&str|->Result<String,String>{let value=input[field].as_str().ok_or("invalid_peer")?;let parsed=uuid::Uuid::parse_str(value).map_err(|_|"invalid_peer")?;if parsed.get_version_num()!=4{return Err("invalid_peer".into());}Ok(parsed.to_string())};
    if action=="identity" {return Ok(body);}
    if action=="register" {
        if input["consent"]!=true||input["scope"]!="public-posts-v1"{return Err("consent_required".into());}
        let key=&input["publicKey"];
        if key["kty"]!="EC"||key["crv"]!="P-256"||!key["d"].is_null() {return Err("invalid_peer_key".into());}
        for field in ["x","y"] {if !key[field].as_str().is_some_and(|s|s.len()==43&&s.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b'-')) {return Err("invalid_peer_key".into());}}
        body["consent"]=true.into();body["scope"]="public-posts-v1".into();body["label"]="Hub Desktop".into();
        body["publicKey"]=serde_json::json!({"kty":"EC","crv":"P-256","x":key["x"],"y":key["y"]});return Ok(body);
    }
    body["deviceId"]=id("deviceId")?.into();
    match action {
        "poll"|"remove"=>(),
        "ack"=>{
            let ids=input["ids"].as_array().ok_or("invalid_peer")?;
            if ids.len()>16||ids.iter().any(|v|v.as_str().and_then(|s|uuid::Uuid::parse_str(s).ok()).is_none()){return Err("invalid_peer".into());}
            body["ids"]=serde_json::Value::Array(ids.clone());
        },
        "signal"=>{
            body["id"]=id("id")?.into();body["toPeer"]=id("toPeer")?.into();
            let cipher=input["ciphertext"].as_str().ok_or("invalid_signal")?;
            if !(40..=100000).contains(&cipher.len())||!cipher.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'+'||c==b'/'||c==b'='){return Err("invalid_signal".into());}
            body["ciphertext"]=cipher.into();
        },
        _=>return Err("invalid_action".into()),
    }
    Ok(body)
}
async fn bounded_peer_json(mut response:reqwest::Response,max:usize)->Result<serde_json::Value,String>{
    match response.status().as_u16(){200=>(),401|403=>return Err("account_required".into()),_=>return Err("network_unavailable".into())}
    let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"network_unavailable")? {
        if bytes.len()+chunk.len()>max{return Err("invalid_response".into());}bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_|"invalid_response".into())
}
pub async fn peer_control(base:&str,expected:&str,input:&serde_json::Value)->Result<serde_json::Value,String>{
    let base=origin(base)?;let body=peer_control_body(input)?;
    require_source_owner(&base,expected)?;
    let assertion=crate::desktop_account::assertion(&base).await.map_err(assertion_error)?;
    require_source_owner(&base,expected)?;
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"network_unavailable")?;
    let response=client.post(format!("{base}/api/client/network/peers")).bearer_auth(assertion).json(&body).send().await.map_err(|_|"network_unavailable")?;
    let result=bounded_peer_json(response,2*1024*1024).await?;
    require_source_owner(&base,expected)?;Ok(result)
}
#[cfg(test)]
mod peer_control_tests {
    use super::*;
    #[test] fn public_post_control_is_a_closed_protocol_without_forwarded_extras(){
        assert_eq!(peer_control_body(&serde_json::json!({"action":"identity","url":"https://other.example","profileId":"other"})).unwrap(),serde_json::json!({"action":"identity"}));
        assert!(peer_control_body(&serde_json::json!({"action":"register","consent":false})).is_err());
        assert!(peer_control_body(&serde_json::json!({"action":"read_file","deviceId":uuid::Uuid::new_v4().to_string()})).is_err());
        assert!(peer_control_body(&serde_json::json!({"action":"signal","deviceId":uuid::Uuid::new_v4().to_string(),"id":uuid::Uuid::new_v4().to_string(),"toPeer":uuid::Uuid::new_v4().to_string(),"ciphertext":"a".repeat(100001)})).is_err());
    }
}

#[cfg(test)]
mod music_tests {
    use super::*;
    const TRACK:&str="0f8fad5b-d9cb-469f-a165-70867728950c";
    fn music_body(items:serde_json::Value)->String { serde_json::json!({"protocol":"hub.catalog.v1","kind":"music","items":items}).to_string() }
    fn work(id:&str,yt:&str)->serde_json::Value { serde_json::json!({"id":id,"title":"T","summary":"","path":format!("/v2/music/works/{id}"),"updatedAt":"2026-10-01","media":{"youtubeId":yt,"artist":"A"}}) }
    fn track(id:&str)->serde_json::Value { serde_json::json!({"id":id,"title":"T","summary":"","path":format!("/v2/music/works/music:{id}"),"updatedAt":"2026-10-01","media":{"audioPath":format!("/music/api/tracks/{id}/audio"),"artworkPath":format!("/music/api/tracks/{id}/artwork"),"artist":"A"}}) }
    async fn serve_once(body:Vec<u8>,content_type:&'static str)->String {
        use tokio::{net::TcpListener,io::{AsyncReadExt,AsyncWriteExt}};
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}",listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut stream,_)=listener.accept().await.unwrap();let mut buf=[0u8;4096];let n=stream.read(&mut buf).await.unwrap();
            let request=String::from_utf8_lossy(&buf[..n]).to_lowercase();assert!(!request.contains("authorization:")&&!request.contains("cookie:"));
            let head=format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            let _=stream.write_all(head.as_bytes()).await;let _=stream.write_all(&body).await;
        });base
    }
    #[tokio::test] async fn music_catalog_accepts_works_and_worker_tracks_up_to_100() {
        let items:Vec<_>=(0..98).map(|i|work(&format!("w{i}"),"dQw4w9WgXcQ")).chain([track(TRACK)]).collect();
        let base=serve_once(music_body(serde_json::Value::Array(items)).into_bytes(),"application/json").await;
        let catalog=read(&base,"music").await.unwrap();assert_eq!(catalog.items.len(),99);
        assert_eq!(catalog.items[0].media.as_ref().unwrap().youtube_id.as_deref(),Some("dQw4w9WgXcQ"));
        let many:Vec<_>=(0..101).map(|i|work(&format!("w{i}"),"dQw4w9WgXcQ")).collect();
        let base=serve_once(music_body(serde_json::Value::Array(many)).into_bytes(),"application/json").await;assert!(read(&base,"music").await.is_err());
    }
    #[tokio::test] async fn music_media_is_validated_strictly() {
        let mut bad=Vec::new();
        bad.push(work("w","short"));                                  // youtubeId not 11 chars
        bad.push(work("w","dQw4w9WgXc!"));                            // bad character
        let mut nomedia=work("w","dQw4w9WgXcQ");nomedia.as_object_mut().unwrap().remove("media");bad.push(nomedia);
        let mut extra=work("w","dQw4w9WgXcQ");extra["media"]["url"]="https://evil.example/x".into();bad.push(extra);
        let mut both=track(TRACK);both["media"]["youtubeId"]="dQw4w9WgXcQ".into();bad.push(both);
        for audio in ["/music/api/tracks/../audio","/music/api/tracks/a/b/audio","/music/api/tracks//audio","/music/api/tracks/x/audio?y=1","https://evil.example/music/api/tracks/x/audio","/music/api/tracks/other/audio"] {
            let mut t=track(TRACK);t["media"]["audioPath"]=audio.into();bad.push(t);
        }
        let mut art=track(TRACK);art["media"]["artworkPath"]="/music/api/tracks/other/artwork".into();bad.push(art);
        let mut wrongpath=track(TRACK);wrongpath["path"]=format!("/v2/music/works/{TRACK}").into();bad.push(wrongpath);
        for item in bad {
            let base=serve_once(music_body(serde_json::json!([item.clone()])).into_bytes(),"application/json").await;
            assert!(read(&base,"music").await.is_err(),"{item}");
        }
        let dup=music_body(serde_json::json!([work("w","dQw4w9WgXcQ"),work("w","dQw4w9WgXcQ")]));
        let base=serve_once(dup.into_bytes(),"application/json").await;assert!(read(&base,"music").await.is_err());
    }
    #[tokio::test] async fn media_is_refused_on_other_kinds() {
        let body=serde_json::json!({"protocol":"hub.catalog.v1","kind":"post","items":[{"id":"p","title":"T","summary":"","path":"/v2/posts/p","updatedAt":"x","media":{"youtubeId":"dQw4w9WgXcQ"}}]}).to_string();
        let base=serve_once(body.into_bytes(),"application/json").await;assert!(read(&base,"post").await.is_err());
        assert_eq!(prefix("music").unwrap(),"/v2/music/works/");
    }
    #[tokio::test] async fn peer_audio_is_limited_to_paths_the_catalog_named_and_audio_content() {
        use tokio::{net::TcpListener,io::{AsyncReadExt,AsyncWriteExt}};
        // Unknown origin/path pairs are refused before any request is made.
        assert!(audio("http://127.0.0.1:1",&format!("/music/api/tracks/{TRACK}/audio")).await.is_err());
        assert!(audio("http://127.0.0.1:1","/api/client/me").await.is_err());
        // One server answers the catalog request, then audio requests.
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}",listener.local_addr().unwrap());
        let catalog=music_body(serde_json::json!([track(TRACK)]));
        tokio::spawn(async move {for n in 0..3 {
            let (mut stream,_)=listener.accept().await.unwrap();let mut buf=[0u8;4096];let c=stream.read(&mut buf).await.unwrap();
            let line=String::from_utf8_lossy(&buf[..c]).lines().next().unwrap().to_string();
            let (ct,body)=if line.contains("catalog") {("application/json",catalog.clone().into_bytes())} else if n==1 {("audio/mpeg",b"ID3audio".to_vec())} else {("text/html",b"<html>".to_vec())};
            let head=format!("HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            let _=stream.write_all(head.as_bytes()).await;let _=stream.write_all(&body).await;
        }});
        read(&base,"music").await.unwrap();
        // A path the catalog did not name is refused even though the origin is known.
        assert!(audio(&base,"/music/api/tracks/other/audio").await.is_err());
        assert_eq!(audio(&base,&format!("/music/api/tracks/{TRACK}/audio")).await.unwrap(),b"ID3audio");
        assert!(audio(&base,&format!("/music/api/tracks/{TRACK}/audio")).await.is_err()); // text/html
    }
    fn video_body(items:serde_json::Value)->String { serde_json::json!({"protocol":"hub.catalog.v1","kind":"video","items":items}).to_string() }
    fn video(id:&str,media:serde_json::Value)->serde_json::Value { serde_json::json!({"id":id,"title":"V","summary":"","path":format!("/v2/videos/{id}"),"updatedAt":"2026-10-01","media":media}) }
    #[tokio::test] async fn video_catalog_accepts_references_only() {
        let mut ok=vec![video("a",serde_json::json!({"youtubeId":"dQw4w9WgXcQ","channel":"C","duration":"3:32"})),video("b",serde_json::json!({"channel":"C"}))];
        let mut bare=video("c",serde_json::json!(null));bare.as_object_mut().unwrap().remove("media");ok.push(bare);
        let base=serve_once(video_body(serde_json::Value::Array(ok)).into_bytes(),"application/json").await;
        let catalog=read(&base,"video").await.unwrap();assert_eq!(catalog.items.len(),3);
        assert_eq!(catalog.items[0].media.as_ref().unwrap().youtube_id.as_deref(),Some("dQw4w9WgXcQ"));
        let many:Vec<_>=(0..101).map(|i|video(&format!("v{i}"),serde_json::json!({}))).collect();
        let base=serve_once(video_body(serde_json::Value::Array(many)).into_bytes(),"application/json").await;assert!(read(&base,"video").await.is_err());
    }
    #[tokio::test] async fn video_media_is_validated_strictly() {
        let mut bad=vec![
            video("a",serde_json::json!({"youtubeId":"short"})),
            video("a",serde_json::json!({"audioPath":"/music/api/tracks/a/audio"})),
            video("a",serde_json::json!({"artworkPath":"/music/api/tracks/a/artwork"})),
            video("a",serde_json::json!({"artist":"A"})),
            video("a",serde_json::json!({"p2p":{"manifestPath":"/x"}})),
            video("a",serde_json::json!({"url":"https://evil.example/v.mp4"})),
            video("a",serde_json::json!({"channel":"bad\nname"})),
            video("a",serde_json::json!({"duration":"x".repeat(17)})),
        ];
        let mut wrongpath=video("a",serde_json::json!({}));wrongpath["path"]="/v2/music/works/a".into();bad.push(wrongpath);
        for item in &bad {
            let base=serve_once(video_body(serde_json::json!([item.clone()])).into_bytes(),"application/json").await;
            assert!(read(&base,"video").await.is_err(),"{item}");
        }
        let dup=video_body(serde_json::json!([video("a",serde_json::json!({})),video("a",serde_json::json!({}))]));
        let base=serve_once(dup.into_bytes(),"application/json").await;assert!(read(&base,"video").await.is_err());
        // video-only fields are refused on music items
        let mut m=track(TRACK);m["media"]["channel"]="C".into();
        let base=serve_once(music_body(serde_json::json!([m])).into_bytes(),"application/json").await;assert!(read(&base,"music").await.is_err());
        assert_eq!(prefix("video").unwrap(),"/v2/videos/");
    }
}
