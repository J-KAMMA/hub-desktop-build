//! Autoplay policy for browser tabs: media waits for the first user interaction in its document,
//! except on sites the user allowed. A document-created script enforces it in every frame, so a
//! change applies from the next page load without restarting the browser.
//!
//! This is a convenience and resource-saving measure, not a security boundary: the script runs in
//! the page's own world and a page can work around it.
use serde::{Deserialize, Serialize};
use std::{fs, io::{Read, Write}, path::Path, sync::RwLock};

const ERROR: &str = "browser_autoplay_preferences_unavailable";
pub(crate) const INVALID_SITE: &str = "browser_autoplay_site_invalid";
const LIMIT: u64 = 16 * 1024;
pub(crate) const MAX_SITES: usize = 200;
/// Sites people open to watch video. The user can remove them.
const DEFAULT_SITES: [&str; 3] = ["youtube.com", "nicovideo.jp", "twitch.tv"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Policy { pub version: u8, pub block: bool, pub allowed_sites: Vec<String> }

impl Default for Policy {
    fn default() -> Self { Self { version: 1, block: true, allowed_sites: DEFAULT_SITES.iter().map(|site| (*site).to_owned()).collect() } }
}

static POLICY: RwLock<Option<Policy>> = RwLock::new(None);

/// The policy in force. Before the first read from disk this is the default (block).
pub(crate) fn current() -> Policy { POLICY.read().ok().and_then(|policy| policy.clone()).unwrap_or_default() }
pub(crate) fn install(policy: Policy) { if let Ok(mut slot) = POLICY.write() { *slot = Some(policy); } }

/// A host the user typed or the address of the current page, reduced to the site to match:
/// lowercase, punycode, no `www.`, no port, path or credentials.
pub(crate) fn normalize_site(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 2048 || raw.chars().any(char::is_control) { return Err(INVALID_SITE.into()); }
    let url = if raw.contains("://") { tauri::Url::parse(raw) } else { tauri::Url::parse(&format!("https://{raw}/")) }.map_err(|_| INVALID_SITE)?;
    if !matches!(url.scheme(), "http" | "https") { return Err(INVALID_SITE.into()); }
    let Some(host) = url.host_str() else { return Err(INVALID_SITE.into()) };
    if host.starts_with('[') || host.parse::<std::net::IpAddr>().is_ok() { return Err(INVALID_SITE.into()); }
    let host = host.trim_end_matches('.');
    let host = host.strip_prefix("www.").unwrap_or(host);
    // Hub's own pages (tauri.localhost) and loopback names are not web sites.
    let valid = host.len() <= 253 && host.contains('.') && host != "localhost" && !host.ends_with(".localhost")
        && host.split('.').all(|label| !label.is_empty() && label.len() <= 63 && !label.starts_with('-') && !label.ends_with('-')
            && label.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
    if !valid { return Err(INVALID_SITE.into()); }
    Ok(host.to_owned())
}

fn valid(policy: &Policy) -> bool {
    policy.version == 1 && policy.allowed_sites.len() <= MAX_SITES
        && policy.allowed_sites.iter().enumerate().all(|(index, site)| normalize_site(site).as_deref() == Ok(site.as_str())
            && !policy.allowed_sites[..index].contains(site))
}

pub(crate) fn read(path: &Path) -> Result<Policy, String> {
    let input = match fs::File::open(path) {
        Ok(input) => input,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Policy::default()),
        Err(_) => return Err(ERROR.into()),
    };
    if !input.metadata().map_err(|_| ERROR)?.is_file() { return Err(ERROR.into()); }
    let mut bytes = Vec::new();
    input.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    if bytes.len() as u64 > LIMIT { return Err(ERROR.into()); }
    let policy: Policy = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
    if !valid(&policy) { return Err(ERROR.into()); }
    Ok(policy)
}

pub(crate) fn write(path: &Path, policy: &Policy) -> Result<(), String> {
    if !valid(policy) { return Err(ERROR.into()); }
    let parent = path.parent().ok_or(ERROR)?;
    fs::create_dir_all(parent).map_err(|_| ERROR)?;
    let temporary = parent.join(format!("browser-autoplay-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(policy).map_err(|_| ERROR)?;
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| ERROR)?;
    let outcome = output.write_all(&bytes).and_then(|_| output.sync_all());
    drop(output);
    let outcome = outcome.and_then(|_| fs::rename(&temporary, path));
    if outcome.is_err() { let _ = fs::remove_file(&temporary); return Err(ERROR.into()); }
    Ok(())
}

/// Add or remove one allowed site. Adding keeps the newest first; the list never exceeds MAX_SITES.
pub(crate) fn with_site(policy: &Policy, site: &str, allowed: bool) -> Result<Policy, String> {
    let site = normalize_site(site)?;
    let mut next = policy.clone();
    next.allowed_sites.retain(|existing| existing != &site);
    if allowed {
        if next.allowed_sites.len() >= MAX_SITES { return Err("browser_autoplay_site_limit".into()); }
        next.allowed_sites.insert(0, site);
    }
    Ok(next)
}

/// The script registered for every document of a tab, or None when nothing is blocked.
/// The site match uses the top-level page (`location.ancestorOrigins`), so a video frame embedded in
/// an allowed site plays, and an ad frame on another site waits.
pub(crate) fn document_script(policy: &Policy) -> Option<String> {
    if !policy.block { return None; }
    let sites = serde_json::to_string(&policy.allowed_sites).ok()?;
    Some(format!(r#"(()=>{{'use strict';
const sites={sites};
const allowed=host=>{{host=String(host||'').toLowerCase().replace(/\.$/,'');return host!==''&&sites.some(s=>host===s||host.endsWith('.'+s));}};
// The frame's own site counts too: a click on the top page does not activate a cross-origin player
// frame, so an embedded player from an allowed site must be allowed to start on its own.
if(allowed(location.hostname))return;
try{{const a=location.ancestorOrigins;if(a&&a.length&&allowed(new URL(a[a.length-1]).hostname))return;}}catch{{}}
const active=()=>{{try{{return navigator.userActivation.hasBeenActive===true;}}catch{{return false;}}}};
const proto=globalThis.HTMLMediaElement&&HTMLMediaElement.prototype;if(!proto)return;
const play=proto.play;
Object.defineProperty(proto,'play',{{configurable:true,writable:true,value:function(){{
if(active())return Reflect.apply(play,this,arguments);
try{{this.pause();}}catch{{}}
return Promise.reject(new DOMException('Playback waits for a user interaction','NotAllowedError'));}}}});
const stop=event=>{{const media=event.composedPath()[0];if(!active()&&media instanceof HTMLMediaElement)media.pause();}};
addEventListener('play',stop,true);
// Media events are not composed, so an autoplaying element inside a shadow root never reaches window.
const attach=Element.prototype.attachShadow;
if(attach)Object.defineProperty(Element.prototype,'attachShadow',{{configurable:true,writable:true,value:function(){{
const root=Reflect.apply(attach,this,arguments);try{{root.addEventListener('play',stop,true);}}catch{{}}return root;}}}});
}})();"#))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Folder(std::path::PathBuf);
    impl Folder { fn new() -> Self { Self(std::env::temp_dir().join(format!("hub-autoplay-test-{}", uuid::Uuid::new_v4()))) } }
    impl Drop for Folder { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn default_blocks_and_allows_video_sites() {
        let folder = Folder::new(); let path = folder.0.join("browser-autoplay.json");
        let policy = read(&path).unwrap();
        assert!(policy.block); assert!(policy.allowed_sites.contains(&"youtube.com".to_owned()));
        let script = document_script(&policy).unwrap();
        assert!(script.contains(r#"["youtube.com","nicovideo.jp","twitch.tv"]"#));
    }
    #[test]
    fn round_trip_and_turning_off_removes_the_script() {
        let folder = Folder::new(); let path = folder.0.join("browser-autoplay.json");
        let policy = Policy { version: 1, block: false, allowed_sites: vec!["example.org".into()] };
        write(&path, &policy).unwrap(); assert_eq!(read(&path).unwrap(), policy);
        assert_eq!(fs::read_dir(&folder.0).unwrap().count(), 1);
        assert!(document_script(&policy).is_none());
    }
    #[test]
    fn sites_are_normalized_and_hostile_input_is_refused() {
        for (raw, site) in [("YouTube.com", "youtube.com"), ("https://www.nicovideo.jp/watch/sm9?x=1", "nicovideo.jp"),
            ("http://sub.example.org:8080/a", "sub.example.org"), ("例え.jp", "xn--r8jz45g.jp"), ("example.org.", "example.org")] {
            assert_eq!(normalize_site(raw).as_deref(), Ok(site), "{raw}");
        }
        for raw in ["", "localhost", "tauri.localhost", "127.0.0.1", "[::1]", "file:///c:/x", "javascript:alert(1)", "a\nb.com", "\"];alert(1);//.com",
            "exa mple.com", "https://u:p@", &"a".repeat(2049)] {
            assert!(normalize_site(raw).is_err(), "{raw}");
        }
    }
    #[test]
    fn malformed_duplicate_unnormalized_or_oversized_files_are_errors() {
        let folder = Folder::new(); fs::create_dir_all(&folder.0).unwrap(); let path = folder.0.join("p.json");
        for bytes in [b"null".to_vec(), br#"{"version":2,"block":true,"allowedSites":[]}"#.to_vec(),
            br#"{"version":1,"block":true,"allowedSites":["WWW.Example.org"]}"#.to_vec(),
            br#"{"version":1,"block":true,"allowedSites":["a.org","a.org"]}"#.to_vec(),
            br#"{"version":1,"block":true,"allowedSites":["</script>"]}"#.to_vec(),
            br#"{"version":1,"block":true,"allowedSites":[],"extra":1}"#.to_vec(), vec![b' '; LIMIT as usize + 1]] {
            fs::write(&path, bytes).unwrap(); assert!(read(&path).is_err());
        }
    }
    #[test]
    fn adding_and_removing_sites_is_idempotent_and_bounded() {
        let base = Policy { version: 1, block: true, allowed_sites: vec![] };
        let added = with_site(&base, "https://www.example.org/x", true).unwrap();
        assert_eq!(added.allowed_sites, vec!["example.org"]);
        assert_eq!(with_site(&added, "example.org", true).unwrap(), added);
        assert!(with_site(&added, "example.org", false).unwrap().allowed_sites.is_empty());
        let full = Policy { version: 1, block: true, allowed_sites: (0..MAX_SITES).map(|i| format!("s{i}.example")).collect() };
        assert!(with_site(&full, "new.example", true).is_err());
        assert_eq!(with_site(&full, "s3.example", true).unwrap().allowed_sites[0], "s3.example");
    }
}
