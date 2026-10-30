use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncReadExt;

const MAX: usize = 10 * 1024 * 1024;
fn segment(id: &str) -> Result<&str,String> {
    if id.len()==36 && uuid::Uuid::parse_str(id).is_ok() && id.bytes().all(|c|c==b'-'||c.is_ascii_digit()||(b'a'..=b'f').contains(&c)) {Ok(id)} else {Err("research_pdf_invalid_id".into())}
}
fn pdf(bytes: &[u8]) -> Result<(),String> {
    if bytes.len()>MAX {return Err("research_pdf_too_large".into());}
    if bytes.len()<9 || &bytes[..5]!=b"%PDF-" || !bytes[5].is_ascii_digit() || bytes[6]!=b'.'
        || !bytes[7].is_ascii_digit() || !matches!(bytes[8],b'\r'|b'\n') {return Err("research_pdf_invalid_format".into());}
    Ok(())
}
fn location(base:&str,project:&str) -> Result<reqwest::Url,String> {
    if project.len()<3||project.len()>128||!project.as_bytes()[0].is_ascii_lowercase()&&!project.as_bytes()[0].is_ascii_digit()||!project.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'-'||c==b'_'){return Err("research_pdf_invalid_id".into());}
    reqwest::Url::parse(&format!("{}/api/client/research/{project}/pdfs",base.trim_end_matches('/'))).map_err(|_|"research_pdf_invalid_origin".into())
}
fn title(value:&str) -> Result<(),String> {
    if value.trim().is_empty() || value.encode_utf16().count()>240 || value.chars().any(|c|c<='\u{1f}'||c=='\u{7f}') {Err("research_pdf_invalid_title".into())} else {Ok(())}
}
async fn received(mut response:reqwest::Response,max:usize) -> Result<Vec<u8>,String> {
    if response.content_length().is_some_and(|n|n>max as u64) {return Err("research_pdf_response_too_large".into());}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"research_pdf_receive_failed")? {
        if chunk.len()>max-bytes.len() {return Err("research_pdf_response_too_large".into());}
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn assertion(base:&str)->Result<String,String> {
    crate::desktop_account::assertion_if_registered(base).await?.ok_or("desktop_connection_required".into())
}
fn client()->Result<reqwest::Client,String> {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(70)).build().map_err(|_|"research_pdf_client_unavailable".into())
}
fn rejection(operation:&str,status:reqwest::StatusCode)->String {format!("research_pdf_{operation}_rejected:{}:",status.as_u16())}

#[tauri::command]
pub async fn research_pdf_upload(app:tauri::AppHandle,project_id:String,title_text:String,series_id:Option<String>)->Result<Value,String> {
    title(&title_text)?;
    let base=crate::hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    let mut url=location(&base,&project_id)?;
    url.query_pairs_mut().append_pair("action","upload").append_pair("title",&title_text);
    if let Some(id)=series_id.as_deref() {url.query_pairs_mut().append_pair("series",segment(id)?);}
    let token=assertion(&base).await?;
    let (tx,rx)=tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("PDF",&["pdf"]).pick_file(move |value|{let _=tx.send(value);});
    let Some(chosen)=rx.await.map_err(|_|"research_pdf_dialog_failed")? else{return Ok(json!({"cancelled":true}));};
    let path=chosen.as_path().ok_or("research_pdf_file_unavailable")?;
    let file=tokio::fs::File::open(path).await.map_err(|_|"research_pdf_file_unavailable")?;
    let metadata=file.metadata().await.map_err(|_|"research_pdf_file_unavailable")?;
    if !metadata.is_file() || metadata.len()>MAX as u64 {return Err("research_pdf_too_large".into());}
    let mut bytes=Vec::new(); file.take((MAX+1) as u64).read_to_end(&mut bytes).await.map_err(|_|"research_pdf_read_failed")?; pdf(&bytes)?;
    let response=client()?.post(url).bearer_auth(token).header("Content-Type","application/pdf").body(bytes).send().await.map_err(|_|"research_pdf_upload_unknown")?;
    if !response.status().is_success() {return Err(rejection("upload",response.status()));}
    let value:Value=serde_json::from_slice(&received(response,8192).await?).map_err(|_|"research_pdf_upload_unknown")?;
    let id=value.get("id").and_then(Value::as_str).ok_or("research_pdf_upload_unknown")?;
    segment(id).map_err(|_|"research_pdf_upload_unknown")?;
    let version=value.get("version").and_then(Value::as_u64).filter(|v|*v>0 && *v<=9_007_199_254_740_991).ok_or("research_pdf_upload_unknown")?;
    if value.get("scanStatus").and_then(Value::as_str)!=Some("pending") {return Err("research_pdf_upload_unknown".into());}
    Ok(json!({"id":id,"version":version,"scanStatus":"pending"}))
}

#[tauri::command]
pub async fn research_pdf_download(app:tauri::AppHandle,project_id:String,pdf_id:String)->Result<Value,String> {
    let base=crate::hub_window::hub_url(std::env::var("HUB_APP_URL").ok().as_deref());
    let mut url=location(&base,&project_id)?;url.query_pairs_mut().append_pair("pdf",segment(&pdf_id)?).append_pair("download","1");
    let response=client()?.get(url).bearer_auth(assertion(&base).await?).send().await.map_err(|_|"research_pdf_download_unavailable")?;
    if !response.status().is_success() {return Err(rejection("download",response.status()));}
    if response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v|v.to_str().ok())!=Some("application/pdf") {return Err("research_pdf_invalid_format".into());}
    let bytes=received(response,MAX).await?; pdf(&bytes)?;
    let (tx,rx)=tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("PDF",&["pdf"]).set_file_name("research.pdf").save_file(move |value|{let _=tx.send(value);});
    let Some(chosen)=rx.await.map_err(|_|"research_pdf_dialog_failed")? else{return Ok(json!({"cancelled":true}));};
    let path=chosen.as_path().ok_or("research_pdf_file_unavailable")?;
    use tokio::io::AsyncWriteExt;
    let temporary=path.with_file_name(format!(".hub-pdf-{}.tmp",uuid::Uuid::new_v4()));
    let result=async {let mut file=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).await?;file.write_all(&bytes).await?;file.sync_all().await?;drop(file);tokio::fs::rename(&temporary,path).await}.await;
    if result.is_err(){let _=tokio::fs::remove_file(&temporary).await;return Err("research_pdf_save_failed".into());}
    Ok(json!({"saved":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn file_width_and_format_boundaries() {
        for bytes in [b"".as_slice(),b"%PDF-1.7",b"%PDF-1.x\n",b"%PDF-1.7x"] {assert!(pdf(bytes).is_err());}
        let mut bytes=vec![0;MAX];bytes[..9].copy_from_slice(b"%PDF-1.7\n");assert!(pdf(&bytes).is_ok());bytes.push(0);assert!(pdf(&bytes).is_err());
    }
    #[test] fn closed_paths_and_title_boundaries() {
        for id in ["","../p","x/y","x?q=1","x#fragment","a\0",&"x".repeat(101)] {assert!(segment(id).is_err());}
        assert!(segment("00000000-0000-4000-8000-000000000000").is_ok());assert!(location("http://localhost:3020",&"x".repeat(128)).is_ok());assert!(location("http://localhost:3020",&"x".repeat(129)).is_err());assert!(title(&"😀".repeat(120)).is_ok());assert!(title(&"😀".repeat(121)).is_err());assert!(title("x\n").is_err());
        assert_eq!(location("http://127.0.0.1:3020","project-1").unwrap().as_str(),"http://127.0.0.1:3020/api/client/research/project-1/pdfs");
    }
}
