//! Pinned YouTube page rules. No request/body, settings or browsing data is retained.
use adblock::{Engine, lists::{FilterSet, ParseOptions}, resources::{PermissionMask, Resource}};
use std::sync::OnceLock;

const ERROR: &str = "browser_youtube_protection_unavailable";
const HOSTS: [&str; 3] = ["www.youtube.com", "m.youtube.com", "youtube.com"];
const MAX_SCRIPT_BYTES: usize = 512 * 1024;
struct Engines { main: Engine, isolated: Engine }
static ENGINES: OnceLock<Result<Engines, String>> = OnceLock::new();

pub(super) fn youtube_url(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > 65_536 || raw.chars().any(char::is_control) { return false; }
    tauri::Url::parse(raw).ok().is_some_and(|url| url.scheme() == "https"
        && url.username().is_empty() && url.password().is_none() && url.port().is_none()
        && url.host_str().is_some_and(|host| HOSTS.contains(&host)))
}
fn engines() -> Result<&'static Engines, String> {
    ENGINES.get_or_init(|| {
        let resources: Vec<Resource> = serde_json::from_str(include_str!("../assets/adblock/youtube/youtube-resources.json")).map_err(|_| ERROR)?;
        let build = |rules: &str, cosmetic: bool| {
            let mut filters = FilterSet::new(false);
            filters.add_filter_list(rules.to_owned(), ParseOptions { permissions: PermissionMask::from_bits(1), ..Default::default() });
            if cosmetic {
                filters.add_filter_list(include_str!("../assets/adblock/easylist.txt").to_owned(), ParseOptions::default());
                filters.add_filter_list(include_str!("../assets/adblock/youtube/youtube-cosmetic.chromium.txt").to_owned(), ParseOptions::default());
            }
            let mut engine = Engine::new_with_filter_set(filters); engine.use_resources(resources.clone()); engine
        };
        Ok(Engines {
            main: build(include_str!("../assets/adblock/youtube/youtube-scriptlets.main.chromium.txt"), false),
            isolated: build(include_str!("../assets/adblock/youtube/youtube-scriptlets.isolated.chromium.txt"), true),
        })
    }).as_ref().map_err(Clone::clone)
}
fn bootstrap(engine: &Engine, cosmetic: bool) -> Result<String, String> {
    let mut branches = Vec::new();
    for host in HOSTS {
        let resources = engine.url_cosmetic_resources(&format!("https://{host}/"));
        let host_literal = serde_json::to_string(host).map_err(|_| ERROR)?;
        let mut body = resources.injected_script;
        if cosmetic && !resources.hide_selectors.is_empty() {
            let mut selectors: Vec<_> = resources.hide_selectors.into_iter().collect(); selectors.sort_unstable();
            let css = serde_json::to_string(&selectors).map_err(|_| ERROR)?;
            body.push_str(&format!("\n(()=>{{const selectors={css},style=document.createElement('style');const mount=()=>{{if(style.isConnected)return;const target=document.head||document.documentElement;if(!target)return;target.append(style);for(const selector of selectors){{try{{style.sheet.insertRule(selector+'{{display:none!important}}',style.sheet.cssRules.length);}}catch{{}}}}}};mount();const observer=new MutationObserver(mount);observer.observe(document,{{childList:true,subtree:true}});}})();"));
        }
        branches.push(format!("if(location.hostname==={host_literal}){{const scriptletGlobals=new Map();{body}\nreturn;}}"));
    }
    let script=format!("(()=>{{'use strict';if(location.protocol!=='https:'||location.port||/^\\/(?:signin|login|account|t\\/terms)(?:[/?#]|$)/.test(location.pathname))return;{} }})();",branches.join("\n"));
    if script.len() > MAX_SCRIPT_BYTES { return Err(ERROR.into()); }
    Ok(script)
}
pub(super) fn youtube_document_scripts(enabled: bool) -> Result<(String, String), String> {
    if !enabled { return Ok((String::new(), String::new())); }
    let engines=engines()?; Ok((bootstrap(&engines.main, false)?, bootstrap(&engines.isolated, true)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_https_youtube_hosts_only() {
        for host in HOSTS { assert!(youtube_url(&format!("https://{host}/watch?v=synthetic"))); }
        for raw in ["https://consent.youtube.com/", "https://accounts.google.com/", "https://youtube.com.evil.example/", "https://evil.example/?youtube.com", "http://youtube.com/", "https://youtube.com:8443/", "https://u:p@youtube.com/", "tauri://youtube.com/", "https://youtube.com/\n"] { assert!(!youtube_url(raw)); }
        assert!(!youtube_url(&"x".repeat(65_537)));
    }
    #[test]
    fn disabled_payloads_are_empty_and_worlds_are_distinct_bounded() {
        assert_eq!(youtube_document_scripts(false).unwrap(), (String::new(), String::new()));
        let (main, isolated)=youtube_document_scripts(true).unwrap();
        assert!(!main.is_empty() && !isolated.is_empty() && main!=isolated);
        assert!(main.len()<=MAX_SCRIPT_BYTES && isolated.len()<=MAX_SCRIPT_BYTES);
        assert!(main.contains("scriptletGlobals=new Map()")); assert!(!main.contains("style.sheet.insertRule"));
        assert!(isolated.contains("style.sheet.insertRule"));
    }
}
