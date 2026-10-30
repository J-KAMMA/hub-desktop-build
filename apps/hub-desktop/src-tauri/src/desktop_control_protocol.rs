use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Payload bytes before LF; CR in a CRLF frame counts toward this limit.
pub const MAX_LINE_BYTES: usize = 16 * 1024;
pub const MAX_REPLY_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub action: Action,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Status {},
    UiMetrics {},
    ShellInspect {},
    WorkspaceSelect { path: String },
    ShellLayout { view: crate::shell_control::ShellView, #[serde(rename = "sidebarOpen")] sidebar_open: bool, #[serde(rename = "railOpen")] rail_open: bool },
    BrowserOpen {},
    BrowserDownloadHistory { #[serde(rename = "tabId")] tab_id: u64, open: bool },
    TabNew {},
    TabNewPrivate {},
    TabActivate { #[serde(rename = "tabId")] tab_id: u64 },
    TabSelect { #[serde(rename = "tabId")] tab_id: u64 },
    TabClose { #[serde(rename = "tabId")] tab_id: u64 },
    TabMediaStatus { #[serde(rename = "tabId")] tab_id: u64 },
    TabSetMuted { #[serde(rename = "tabId")] tab_id: u64, muted: bool },
    WorkspacePaths { query: String, limit: usize, #[serde(default, deserialize_with = "workspace_kind")] kind: Option<String> },
    BrowserReaderFixture { port: u16 },
    BrowserAiFixture { port: u16 },
    SessionRestore {},
    TabsMenuOpen {},
    TabsMenuClose {},
    BrowserProbeProfile { profile: u8 },
    BrowserUiRefresh { #[serde(rename = "tabId")] tab_id: u64, profile: u8 },
    AppFocus {},
    AppClose {},
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    Io,
    LineTooLong,
    Truncated,
    InvalidUtf8,
    InvalidJson,
    InvalidRequest,
    InvalidId,
}

impl ProtocolError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Io => "io_error",
            Self::LineTooLong => "line_too_long",
            Self::Truncated => "truncated",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::InvalidJson => "invalid_json",
            Self::InvalidRequest => "invalid_request",
            Self::InvalidId => "invalid_id",
        }
    }
}

fn workspace_kind<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn valid_workspace_query(query: &str, limit: usize, kind: Option<&str>) -> bool {
    let needle = query.trim();
    query.encode_utf16().count() <= 256 && !query.chars().any(char::is_control)
        && !needle.starts_with('/') && !needle.contains(['\\', ':'])
        && !needle.split('/').any(|part| matches!(part, "." | ".."))
        && (1..=200).contains(&limit) && matches!(kind, None | Some("file" | "directory"))
}

fn parse_request(payload: &[u8]) -> Result<Request, ProtocolError> {
    let text = std::str::from_utf8(payload).map_err(|_| ProtocolError::InvalidUtf8)?;
    let request: Request = serde_json::from_str(text).map_err(|error| {
        if error.is_data() { ProtocolError::InvalidRequest } else { ProtocolError::InvalidJson }
    })?;
    if request.id == 0 || matches!(request.action, Action::TabActivate { tab_id: 0 } | Action::TabSelect { tab_id: 0 } | Action::TabClose { tab_id: 0 }) {
        return Err(ProtocolError::InvalidId);
    }
    if matches!(request.action, Action::BrowserProbeProfile { profile: 2..=u8::MAX }) { return Err(ProtocolError::InvalidRequest); }
    if matches!(request.action, Action::BrowserUiRefresh { tab_id: 0 | 9_007_199_254_740_992..=u64::MAX, .. }) { return Err(ProtocolError::InvalidId); }
    if matches!(request.action, Action::BrowserUiRefresh { profile: 2..=u8::MAX, .. }) { return Err(ProtocolError::InvalidRequest); }
    if matches!(request.action, Action::TabMediaStatus { tab_id: 0 | 9_007_199_254_740_992..=u64::MAX }
        | Action::TabSetMuted { tab_id: 0 | 9_007_199_254_740_992..=u64::MAX, .. }
        | Action::BrowserDownloadHistory { tab_id: 0 | 9_007_199_254_740_992..=u64::MAX, .. }) { return Err(ProtocolError::InvalidId); }
    if let Action::WorkspacePaths { query, limit, kind } = &request.action {
        if !valid_workspace_query(query, *limit, kind.as_deref()) { return Err(ProtocolError::InvalidRequest); }
    }
    if matches!(request.action,Action::BrowserReaderFixture{port:0..=1023|3020}|Action::BrowserAiFixture{port:0..=1023|3020}) {return Err(ProtocolError::InvalidRequest);}
    if let Action::WorkspaceSelect { path } = &request.action {
        if path.trim().is_empty() || path.chars().count() > 8192 || path.chars().any(char::is_control) {
            return Err(ProtocolError::InvalidRequest);
        }
    }
    Ok(request)
}

/// Reads one frame with bounded allocation. Oversized frames are drained through
/// their LF, retaining any next frame in the reader. EOF requires a final LF.
pub fn read_request(reader: &mut impl BufRead) -> Result<Option<Request>, ProtocolError> {
    let mut payload = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().map_err(|_| ProtocolError::Io)?;
        if available.is_empty() {
            return if oversized { Err(ProtocolError::LineTooLong) }
                else if payload.is_empty() { Ok(None) }
                else { Err(ProtocolError::Truncated) };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let bytes = newline.unwrap_or(available.len());
        if !oversized {
            if bytes > MAX_LINE_BYTES - payload.len() { oversized = true; payload.clear(); }
            else { payload.extend_from_slice(&available[..bytes]); }
        }
        reader.consume(newline.map_or(bytes, |position| position + 1));
        if newline.is_some() {
            return if oversized { Err(ProtocolError::LineTooLong) }
                else { parse_request(&payload).map(Some) };
        }
    }
}

/// Only the adapter assembles result data. No arbitrary input JSON reaches this
/// value; browser results contain sanitized metadata without URLs or page text.
#[derive(Debug, Serialize)]
pub struct Reply {
    id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Reply {
    pub fn success(id: u64, result: Value) -> Self {
        if id == 0 { return Self::error(None, ProtocolError::InvalidId.code()); }
        Self { id: Some(id), result: Some(result), error: None }
    }

    pub fn error(id: Option<u64>, error: &str) -> Self {
        Self { id: id.filter(|value| *value > 0), result: None, error: Some(error.to_owned()) }
    }
}

/// Serialize before writing to avoid partially emitting an oversized frame.
pub fn write_reply(writer: &mut impl Write, reply: &Reply) -> io::Result<()> {
    let payload = serde_json::to_vec(reply).map_err(io::Error::other)?;
    if payload.len() > MAX_REPLY_BYTES { return Err(io::Error::other("reply_too_large")); }
    writer.write_all(&payload)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor, Read};
    use serde_json::json;

    fn read(payload: &str) -> Result<Option<Request>, ProtocolError> {
        read_request(&mut Cursor::new(format!("{payload}\n").into_bytes()))
    }

    #[test]
    fn closed_actions_have_only_fixed_arguments() {
        for (name, action) in [
            ("status", Action::Status {}), ("ui_metrics", Action::UiMetrics {}), ("browser_open", Action::BrowserOpen {}),
            ("tab_new", Action::TabNew {}), ("tab_new_private", Action::TabNewPrivate {}), ("session_restore", Action::SessionRestore {}),
            ("tabs_menu_open", Action::TabsMenuOpen {}), ("tabs_menu_close", Action::TabsMenuClose {}),
            ("app_focus", Action::AppFocus {}), ("app_close", Action::AppClose {}),
        ] {
            assert_eq!(read(&format!(r#"{{"id":1,"action":{{"type":"{name}"}}}}"#)), Ok(Some(Request { id: 1, action })));
            assert_eq!(read(&format!(r#"{{"id":1,"action":{{"type":"{name}","url":"https://example.com"}}}}"#)), Err(ProtocolError::InvalidRequest));
        }
        assert_eq!(read(r#"{"id":2,"action":{"type":"tab_activate","tabId":3}}"#), Ok(Some(Request { id: 2, action: Action::TabActivate { tab_id: 3 } })));
        assert_eq!(read(r#"{"id":2,"action":{"type":"tab_select","tabId":3}}"#), Ok(Some(Request { id: 2, action: Action::TabSelect { tab_id: 3 } })));
        assert_eq!(read(r#"{"id":2,"action":{"type":"tab_close","tabId":3}}"#), Ok(Some(Request { id: 2, action: Action::TabClose { tab_id: 3 } })));
    }
    #[test]
    fn workspace_select_is_a_closed_typed_configuration_action() {
        for path in ["C:/synthetic/project".to_owned(), " C:/synthetic/project ".to_owned(), "x".repeat(8192)] {
            let payload=json!({"id":1,"action":{"type":"workspace_select","path":&path}}).to_string();
            assert_eq!(read(&payload),Ok(Some(Request{id:1,action:Action::WorkspaceSelect{path}})));
        }
        for path in ["".to_owned()," \t ".to_owned(),"x".repeat(8193),"C:/bad\0path".into(),"C:/bad\npath".into(),"C:/bad\rpath".into(),"C:/bad\u{85}path".into()] {
            assert_eq!(read(&json!({"id":1,"action":{"type":"workspace_select","path":path}}).to_string()),Err(ProtocolError::InvalidRequest));
        }
        for path in [Value::Null,json!(1),json!(true),json!([]),json!({})] {
            assert_eq!(read(&json!({"id":1,"action":{"type":"workspace_select","path":path}}).to_string()),Err(ProtocolError::InvalidRequest));
        }
        assert_eq!(read(r#"{"id":1,"action":{"type":"workspace_select"}}"#),Err(ProtocolError::InvalidRequest));
        for key in ["program","script","env","start","model","clear","token","url"] {
            assert_eq!(read(&json!({"id":1,"action":{"type":"workspace_select","path":"C:/synthetic/project",key:"not allowed"}}).to_string()),Err(ProtocolError::InvalidRequest));
        }
    }
    #[test]
    fn workspace_select_char_limit_does_not_expand_the_existing_frame_byte_limit() {
        let multibyte=json!({"id":1,"action":{"type":"workspace_select","path":"日".repeat(8192)}}).to_string();
        assert!(parse_request(multibyte.as_bytes()).is_ok());
        assert_eq!(read(&multibyte),Err(ProtocolError::LineTooLong));
        let mut oversized=json!({"id":1,"action":{"type":"workspace_select","path":"synthetic"}}).to_string();oversized.push_str(&" ".repeat(MAX_LINE_BYTES));
        let mut frames=Cursor::new(format!("{oversized}\n{{\"id\":2,\"action\":{{\"type\":\"status\"}}}}\n").into_bytes());
        assert_eq!(read_request(&mut frames),Err(ProtocolError::LineTooLong));
        assert_eq!(read_request(&mut frames),Ok(Some(Request{id:2,action:Action::Status{}})));
    }

    #[test]
    fn zero_negative_float_string_unicode_and_overflow_ids_reject() {
        assert_eq!(read(r#"{"id":0,"action":{"type":"status"}}"#), Err(ProtocolError::InvalidId));
        for value in ["-1", "1.0", "1e0", "18446744073709551616", "\"1\"", "\"１\"", "true", "null"] {
            assert_eq!(read(&format!(r#"{{"id":{value},"action":{{"type":"status"}}}}"#)), Err(ProtocolError::InvalidRequest));
            for name in ["tab_activate", "tab_select", "tab_close"] {
                assert_eq!(read(&format!(r#"{{"id":1,"action":{{"type":"{name}","tabId":{value}}}}}"#)), Err(ProtocolError::InvalidRequest));
            }
        }
        for name in ["tab_activate", "tab_select", "tab_close"] {
            assert_eq!(read(&format!(r#"{{"id":1,"action":{{"type":"{name}","tabId":0}}}}"#)), Err(ProtocolError::InvalidId));
        }
        assert_eq!(read(r#"{"id":18446744073709551615,"action":{"type":"tab_activate","tabId":18446744073709551615}}"#).unwrap().unwrap().id, u64::MAX);
    }

    #[test]
    fn unknown_fields_duplicate_fields_and_unexpected_commands_reject() {
        for payload in [
            r#"{"id":1,"action":{"type":"status"},"command":"shell"}"#,
            r#"{"id":1,"action":{"type":"tab_activate","tabId":1,"script":"x"}}"#,
            r#"{"id":1,"action":{"type":"tab_activate","tab_id":1}}"#,
            r#"{"id":1,"action":{"type":"status","__proto__":{}}}"#,
            r#"{"id":1,"id":2,"action":{"type":"status"}}"#,
            r#"{"id":1,"action":{"type":"tab_close","tabId":1,"tabId":2}}"#,
            r#"{"id":1,"action":{"type":"status","type":"app_close"}}"#,
            r#"{"id":1,"action":"status"}"#,
            r#"{"id":1,"action":{"type":"browser_open","url":null}}"#,
        ] { assert_eq!(read(payload), Err(ProtocolError::InvalidRequest)); }
        for name in ["eval", "shell", "http", "history", "browser_text", "wallet_status", "constructor", "__proto__", "Status", "status\0"] {
            let payload = json!({"id":1,"action":{"type":name}}).to_string();
            assert_eq!(read(&payload), Err(ProtocolError::InvalidRequest));
        }
    }

    #[test]
    fn malformed_utf8_json_and_unterminated_eof_are_distinct() {
        for payload in ["", "{", "[]", "null", "{}", "{\"id\":1} trailing"] {
            assert!(matches!(read(payload), Err(ProtocolError::InvalidJson | ProtocolError::InvalidRequest)));
        }
        assert_eq!(read_request(&mut Cursor::new([0xff, b'\n'])), Err(ProtocolError::InvalidUtf8));
        assert_eq!(read_request(&mut Cursor::new(b"{\"id\":1}")), Err(ProtocolError::Truncated));
        assert_eq!(read_request(&mut Cursor::new(b"")), Ok(None));
        assert_eq!(read(r#"{"id":1,"action":{"type":"status"}}"#).unwrap().unwrap().id, 1);
        assert_eq!(read(r#"{"id":1,"action":{"type":"status"}}"#), read_request(&mut Cursor::new(b"{\"id\":1,\"action\":{\"type\":\"status\"}}\r\n")));
    }

    #[test]
    fn exact_byte_limit_and_oversized_frame_recover_without_eating_next() {
        let valid = r#"{"id":1,"action":{"type":"status"}}"#;
        let exact = format!("{valid}{}\n", " ".repeat(MAX_LINE_BYTES - valid.len()));
        assert_eq!(read_request(&mut Cursor::new(exact.as_bytes())).unwrap().unwrap().id, 1);
        let oversized = format!("{valid}{}\n{{\"id\":2,\"action\":{{\"type\":\"status\"}}}}\n", " ".repeat(MAX_LINE_BYTES + 1 - valid.len()));
        for size in [1, 7, 4096, 65536] {
            let mut reader = BufReader::with_capacity(size, Cursor::new(oversized.as_bytes()));
            assert_eq!(read_request(&mut reader), Err(ProtocolError::LineTooLong));
            assert_eq!(read_request(&mut reader).unwrap().unwrap().id, 2);
            assert_eq!(read_request(&mut reader), Ok(None));
        }
        assert_eq!(read_request(&mut Cursor::new(vec![b'a'; MAX_LINE_BYTES + 1])), Err(ProtocolError::LineTooLong));
        assert_eq!(read_request(&mut Cursor::new(vec![b'a'; MAX_LINE_BYTES])), Err(ProtocolError::Truncated));
    }

    #[test]
    fn unicode_byte_limits_and_invalid_frame_recovery() {
        // Multi-byte UTF8 in unknown data counts as bytes and never becomes an action.
        let prefix = r#"{"id":1,"action":{"type":"status"},"extra":""#;
        let tail = "\"}";
        let count = (MAX_LINE_BYTES - prefix.len() - tail.len()) / 3;
        let exact = format!("{prefix}{}{tail}", "界".repeat(count));
        assert!(exact.len() <= MAX_LINE_BYTES);
        assert_eq!(read(&exact), Err(ProtocolError::InvalidRequest));
        assert_eq!(read(&format!("{prefix}{}{tail}", "界".repeat(count + 1))), Err(ProtocolError::LineTooLong));
        let mut reader = BufReader::with_capacity(1, Cursor::new(b"\xff\n{\"id\":4,\"action\":{\"type\":\"status\"}}\n"));
        assert_eq!(read_request(&mut reader), Err(ProtocolError::InvalidUtf8));
        assert_eq!(read_request(&mut reader).unwrap().unwrap().id, 4);
    }

    #[test]
    fn io_failure_is_static_and_never_serializes_raw_details() {
        struct Broken;
        impl Read for Broken { fn read(&mut self, _: &mut [u8]) -> io::Result<usize> { Err(io::Error::other("private detail")) } }
        impl BufRead for Broken { fn fill_buf(&mut self) -> io::Result<&[u8]> { Err(io::Error::other("private detail")) } fn consume(&mut self, _: usize) {} }
        assert_eq!(read_request(&mut Broken), Err(ProtocolError::Io));
        assert_eq!(ProtocolError::Io.code(), "io_error");
    }

    #[test]
    fn replies_have_one_result_or_static_error_and_one_terminated_frame() {
        let mut output = Vec::new();
        write_reply(&mut output, &Reply::success(1, json!({"visible":false,"tabs":[]}))).unwrap();
        assert_eq!(output.last(), Some(&b'\n'));
        assert_eq!(serde_json::from_slice::<Value>(&output).unwrap(), json!({"id":1,"result":{"visible":false,"tabs":[]}}));
        output.clear();
        write_reply(&mut output, &Reply::error(None, ProtocolError::InvalidJson.code())).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&output).unwrap(), json!({"id":null,"error":"invalid_json"}));
        assert_eq!(serde_json::to_value(Reply::success(0, Value::Null)).unwrap(), json!({"id":null,"error":"invalid_id"}));
        assert_eq!(serde_json::to_value(Reply::error(Some(0), "invalid_id")).unwrap(), json!({"id":null,"error":"invalid_id"}));
        output.clear();
        assert!(write_reply(&mut output, &Reply::success(1, json!("x".repeat(MAX_REPLY_BYTES)))).is_err());
        assert!(output.is_empty());
    }

    #[test]
    fn reply_limit_is_independent_64_kib_with_no_partial_overflow_frame() {
        let overhead = serde_json::to_vec(&Reply::success(1, json!(""))).unwrap().len();
        let mut output = Vec::new();
        write_reply(&mut output, &Reply::success(1, json!("x".repeat(MAX_REPLY_BYTES - overhead)))).unwrap();
        assert_eq!(output.len(), MAX_REPLY_BYTES + 1);
        assert_eq!(output.last(), Some(&b'\n'));
        output.clear();
        assert!(write_reply(&mut output, &Reply::success(1, json!("x".repeat(MAX_REPLY_BYTES - overhead + 1)))).is_err());
        assert!(output.is_empty());
        write_reply(&mut output, &Reply::success(1, json!("界".repeat(MAX_LINE_BYTES)))).unwrap();
        assert!(output.len() > MAX_LINE_BYTES && output.len() <= MAX_REPLY_BYTES + 1);
    }
}

#[cfg(test)]
mod app_focus_protocol_tests {
    use super::*;
    use std::io::Cursor;
    use serde_json::json;
    #[test]
    fn app_focus_has_no_external_target_or_parameters() {
        for key in ["window", "label", "pid", "hwnd", "target", "url", "script", "tabId", "accepted"] {
            let payload = format!("{}\n", json!({"id":1,"action":{"type":"app_focus",key:"arbitrary"}}));
            assert_eq!(read_request(&mut Cursor::new(payload)), Err(ProtocolError::InvalidRequest));
        }
        assert_eq!(read_request(&mut Cursor::new(b"{\"id\":1,\"action\":{\"type\":\"app_focus\"}}\n")), Ok(Some(Request { id:1, action:Action::AppFocus {} })));
    }
}

#[cfg(test)]
mod ui_refresh_protocol_tests {
    use super::*;
    use std::io::Cursor;
    use serde_json::json;
    #[test]
    fn refresh_is_closed_typed_and_safe_at_numeric_boundaries() {
        for profile in [0,1] {
            let payload=format!("{}\n",json!({"id":1,"action":{"type":"browser_ui_refresh","tabId":9_007_199_254_740_991u64,"profile":profile}}));
            assert_eq!(read_request(&mut Cursor::new(payload)),Ok(Some(Request{id:1,action:Action::BrowserUiRefresh{tab_id:9_007_199_254_740_991,profile}})));
        }
        for action in [json!({"type":"browser_ui_refresh","tabId":0,"profile":0}),json!({"type":"browser_ui_refresh","tabId":9_007_199_254_740_992u64,"profile":0}),json!({"type":"browser_ui_refresh","tabId":u64::MAX,"profile":0})] {
            assert_eq!(read_request(&mut Cursor::new(format!("{}\n",json!({"id":1,"action":action})))),Err(ProtocolError::InvalidId));
        }
        for action in [json!({"type":"browser_ui_refresh","tabId":1,"profile":2}),json!({"type":"browser_ui_refresh","tabId":1,"profile":"0"}),json!({"type":"browser_ui_refresh","tabId":"1","profile":0}),json!({"type":"browser_ui_refresh","tabId":1.5,"profile":0}),json!({"type":"browser_ui_refresh","tabId":1,"profile":null}),json!({"type":"browser_ui_refresh","tabId":1}),json!({"type":"browser_ui_refresh","profile":0}),json!({"type":"browser_ui_refresh","tabId":1,"profile":0,"url":"forbidden"})] {
            assert_eq!(read_request(&mut Cursor::new(format!("{}\n",json!({"id":1,"action":action})))),Err(ProtocolError::InvalidRequest));
        }
    }
}

#[cfg(test)]
mod shell_protocol_tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    #[test]
    fn shell_actions_are_closed_typed_and_have_no_external_targets() {
        let read = |action| read_request(&mut Cursor::new(format!("{}\n", json!({"id":1,"action":action}))));
        assert!(read(json!({"type":"shell_inspect"})).is_ok());
        for view in ["feed","notifications","market","settings","music","node","saved_articles","video_library","music_library"] {
            for left in [false,true] { for right in [false,true] {
                assert!(read(json!({"type":"shell_layout","view":view,"sidebarOpen":left,"railOpen":right})).is_ok());
            }}
        }
        for action in [json!({"type":"shell_inspect","script":"x"}),json!({"type":"shell_layout","view":"browser","sidebarOpen":true,"railOpen":true}),json!({"type":"shell_layout","view":"feed","sidebarOpen":1,"railOpen":true}),json!({"type":"shell_layout","view":"feed","sidebarOpen":true}),json!({"type":"shell_layout","view":"feed","sidebarOpen":true,"railOpen":true,"pid":1})] {
            assert_eq!(read(action),Err(ProtocolError::InvalidRequest));
        }
    }
}

#[cfg(test)]
mod media_paths_protocol_tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    fn read(action: Value) -> Result<Option<Request>, ProtocolError> {
        read_request(&mut Cursor::new(format!(
            "{}\n",
            json!({"id":1,"action":action})
        )))
    }
    #[test]
    fn new_tab_actions_are_typed_closed_and_use_safe_integer_ids() {
        for id in [1, 9_007_199_254_740_991u64] {
            assert_eq!(
                read(json!({"type":"tab_media_status","tabId":id})),
                Ok(Some(Request {
                    id: 1,
                    action: Action::TabMediaStatus { tab_id: id }
                }))
            );
            for muted in [false, true] {
                assert_eq!(
                    read(json!({"type":"tab_set_muted","tabId":id,"muted":muted})),
                    Ok(Some(Request {
                        id: 1,
                        action: Action::TabSetMuted { tab_id: id, muted }
                    }))
                );
            }
        }
        for id in [0, 9_007_199_254_740_992u64, u64::MAX] {
            assert_eq!(
                read(json!({"type":"tab_media_status","tabId":id})),
                Err(ProtocolError::InvalidId)
            );
            assert_eq!(
                read(json!({"type":"tab_set_muted","tabId":id,"muted":true})),
                Err(ProtocolError::InvalidId)
            );
        }
        for id in [json!(null), json!("1"), json!(-1), json!(1.5)] {
            assert_eq!(
                read(json!({"type":"tab_media_status","tabId":id})),
                Err(ProtocolError::InvalidRequest)
            );
        }
        for value in [json!(null), json!("true"), json!(1)] {
            assert_eq!(
                read(json!({"type":"tab_set_muted","tabId":1,"muted":value})),
                Err(ProtocolError::InvalidRequest)
            );
        }
        assert_eq!(
            read(json!({"type":"tab_set_muted","tabId":1})),
            Err(ProtocolError::InvalidRequest)
        );
        for key in [
            "url",
            "body",
            "script",
            "env",
            "contextToken",
            "printer",
            "path",
        ] {
            assert_eq!(
                read(json!({"type":"tab_media_status","tabId":1,key:"forbidden"})),
                Err(ProtocolError::InvalidRequest)
            );
            assert_eq!(
                read(json!({"type":"tab_set_muted","tabId":1,"muted":true,key:"forbidden"})),
                Err(ProtocolError::InvalidRequest)
            );
        }
        assert_eq!(
            read(json!({"type":"tab_show_print","tabId":1})),
            Err(ProtocolError::InvalidRequest)
        );
    }
    #[test]
    fn paths_request_has_no_cwd_or_execution_arguments_and_checks_raw_query_width() {
        for query in [
            "".to_owned(),
            "src/file".to_owned(),
            "x".repeat(256),
            "😀".repeat(128),
        ] {
            for limit in [1, 200] {
                assert_eq!(
                    read(json!({"type":"workspace_paths","query":query,"limit":limit})),
                    Ok(Some(Request {
                        id: 1,
                        action: Action::WorkspacePaths {
                            query: query.clone(),
                            limit,
                            kind: None
                        }
                    }))
                );
            }
        }
        for kind in ["file", "directory"] {
            assert_eq!(
                read(json!({"type":"workspace_paths","query":"src","limit":2,"kind":kind})),
                Ok(Some(Request {
                    id: 1,
                    action: Action::WorkspacePaths {
                        query: "src".into(),
                        limit: 2,
                        kind: Some(kind.into())
                    }
                }))
            );
        }
        for query in [
            "x".repeat(257),
            "😀".repeat(129),
            "../x".into(),
            "src/../x".into(),
            "./src".into(),
            "/root".into(),
            "C:/root".into(),
            "src\\file".into(),
            "src\0x".into(),
            "src\nx".into(),
            "src\u{85}x".into(),
        ] {
            assert_eq!(
                read(json!({"type":"workspace_paths","query":query,"limit":1})),
                Err(ProtocolError::InvalidRequest)
            );
        }
        for limit in [
            json!(0),
            json!(201),
            json!(1.5),
            json!("1"),
            json!(null),
            json!(-1),
        ] {
            assert_eq!(
                read(json!({"type":"workspace_paths","query":"src","limit":limit})),
                Err(ProtocolError::InvalidRequest)
            );
        }
        for kind in [
            json!(null),
            json!(true),
            json!(1),
            json!("FILE"),
            json!("unknown"),
        ] {
            assert_eq!(
                read(json!({"type":"workspace_paths","query":"src","limit":1,"kind":kind})),
                Err(ProtocolError::InvalidRequest)
            );
        }
        for key in [
            "cwd",
            "path",
            "url",
            "script",
            "env",
            "imageOnly",
            "readOnly",
            "provider",
            "body",
        ] {
            assert_eq!(
                read(json!({"type":"workspace_paths","query":"src","limit":1,key:"forbidden"})),
                Err(ProtocolError::InvalidRequest)
            );
        }
        assert_eq!(
            read(json!({"type":"workspace_paths","query":"src"})),
            Err(ProtocolError::InvalidRequest)
        );
    }
    #[test]
    fn duplicate_fields_and_invalid_unicode_cannot_reach_new_handlers() {
        for line in [
            r#"{"id":1,"action":{"type":"tab_media_status","tabId":1,"tabId":2}}"#,
            r#"{"id":1,"action":{"type":"tab_set_muted","tabId":1,"muted":true,"muted":false}}"#,
            r#"{"id":1,"action":{"type":"workspace_paths","query":"a","query":"b","limit":1}}"#,
            r#"{"id":1,"action":{"type":"workspace_paths","query":"a","limit":1,"limit":2}}"#,
            r#"{"id":1,"action":{"type":"workspace_paths","query":"a","limit":1,"kind":"file","kind":"directory"}}"#,
        ] {
            assert_eq!(
                read_request(&mut Cursor::new(format!("{line}\n"))),
                Err(ProtocolError::InvalidRequest)
            );
        }
        assert!(read_request(&mut Cursor::new(b"{\"id\":1,\"action\":{\"type\":\"workspace_paths\",\"query\":\"\\uD800\",\"limit\":1}}\n")).is_err());
    }
}

#[cfg(test)]
mod reader_fixture_protocol_tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    #[test]
    fn fixture_port_is_typed_bounded_and_has_no_external_targets_or_scripts() {
        let read = |action| {
            read_request(&mut Cursor::new(format!(
                "{}\n",
                json!({"id":1,"action":action})
            )))
        };
        for port in [1024, 3021, 65535] {
            assert_eq!(
                read(json!({"type":"browser_reader_fixture","port":port})),
                Ok(Some(Request {
                    id: 1,
                    action: Action::BrowserReaderFixture { port }
                }))
            );
        }
        for port in [
            json!(0),
            json!(1023),
            json!(3020),
            json!(65536),
            json!(-1),
            json!(1024.5),
            json!("1024"),
            json!(null),
            json!(true),
        ] {
            assert_eq!(
                read(json!({"type":"browser_reader_fixture","port":port})),
                Err(ProtocolError::InvalidRequest)
            );
        }
        for key in [
            "url",
            "script",
            "path",
            "env",
            "tabId",
            "private",
            "body",
            "contextToken",
        ] {
            assert_eq!(
                read(json!({"type":"browser_reader_fixture","port":1024,key:"forbidden"})),
                Err(ProtocolError::InvalidRequest)
            );
        }
        assert_eq!(
            read(json!({"type":"browser_reader_fixture"})),
            Err(ProtocolError::InvalidRequest)
        );
        assert_eq!(read_request(&mut Cursor::new(b"{\"id\":1,\"action\":{\"type\":\"browser_reader_fixture\",\"port\":1024,\"port\":1025}}\n")),Err(ProtocolError::InvalidRequest));
    }
}

#[cfg(test)]
mod download_history_protocol_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn history_controls_have_only_safe_tab_id_and_boolean_open_without_private_data() {
        for id in [1,9_007_199_254_740_991] {
            for open in [true,false] {
                let bytes=serde_json::to_vec(&json!({"id":1,"action":{"type":"browser_download_history","tabId":id,"open":open}})).unwrap();
                assert_eq!(parse_request(&bytes).unwrap().action,Action::BrowserDownloadHistory{tab_id:id,open});
            }
        }
        for id in [0,9_007_199_254_740_992,u64::MAX] {
            let bytes=serde_json::to_vec(&json!({"id":1,"action":{"type":"browser_download_history","tabId":id,"open":true}})).unwrap();
            assert_eq!(parse_request(&bytes),Err(ProtocolError::InvalidId));
        }
        for action in [json!({"type":"browser_download_history","tabId":1,"open":"true"}),
            json!({"type":"browser_download_history","tabId":1,"open":true,"url":"https://example.invalid"}),
            json!({"type":"browser_download_history","tabId":1,"open":true,"path":"private"})] {
            assert_eq!(parse_request(&serde_json::to_vec(&json!({"id":1,"action":action})).unwrap()),Err(ProtocolError::InvalidRequest));
        }
    }
}
#[cfg(test)]
mod browser_ai_fixture_protocol_tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    #[test]
    fn browser_ai_fixture_is_only_one_typed_local_port() {
        let read=|action|read_request(&mut Cursor::new(format!("{}\n",json!({"id":1,"action":action}))));
        for port in [1024,3021,65535] {assert_eq!(read(json!({"type":"browser_ai_fixture","port":port})),Ok(Some(Request{id:1,action:Action::BrowserAiFixture{port}})));}
        for port in [json!(0),json!(1023),json!(3020),json!(65536),json!(-1),json!(1024.5),json!("1024"),json!(null),json!(true)] {assert_eq!(read(json!({"type":"browser_ai_fixture","port":port})),Err(ProtocolError::InvalidRequest));}
        for key in ["url","script","path","tabId","body","draftId","env","private"] {assert_eq!(read(json!({"type":"browser_ai_fixture","port":1024,key:"forbidden"})),Err(ProtocolError::InvalidRequest));}
        assert_eq!(read(json!({"type":"browser_ai_fixture"})),Err(ProtocolError::InvalidRequest));
        assert_eq!(read_request(&mut Cursor::new(b"{\"id\":1,\"action\":{\"type\":\"browser_ai_fixture\",\"port\":1024,\"port\":1025}}\n")),Err(ProtocolError::InvalidRequest));
    }
}
