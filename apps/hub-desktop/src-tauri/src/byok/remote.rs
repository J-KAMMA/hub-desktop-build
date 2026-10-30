//! Runs asked for by the owner's own phone over the paired WebRTC channel (2026-10-15,
//! owner-approved). This file holds only the pure rules; `mod.rs` owns the commands.
//!
//! - A connection is usable from the phone only when it is enabled AND the owner switched on its
//!   "スマホから使える" switch (default off). Anything else is `byok_remote_not_allowed`.
//! - A remote CLI run uses the same fixed argument list as a local one: the app-owned empty
//!   scratch folder, read-only, no file-editing tools. The phone cannot add permissions.
//! - Limits are tighter than local chat: one run at a time, a run budget per window, small
//!   prompts, a capped reply and a wall-clock cap.
//! - Nothing here returns a key, a base URL, a path or an environment variable.

use super::store::{CliSetting, Connection, StoreFile};
use super::{cli, http, ChatMessage};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub const MAX_MESSAGES: usize = 20;
pub const MAX_MESSAGE_CHARS: usize = 8_000;
pub const MAX_TOTAL_CHARS: usize = 30_000;
pub const MAX_OUTPUT_CHARS: usize = 100_000;
pub const MAX_RUN: Duration = Duration::from_secs(180);
pub const MAX_CONCURRENT: usize = 1;
pub const RATE_WINDOW: Duration = Duration::from_secs(600);
pub const RATE_MAX: usize = 12;
pub const MAX_MODELS: usize = 30;
const MAX_MODEL_CHARS: usize = 80;

pub const OFF: &str = "byok_remote_off";
pub const NOT_ALLOWED: &str = "byok_remote_not_allowed";
pub const RATE_LIMITED: &str = "byok_remote_rate";
pub const TOO_LARGE: &str = "byok_remote_too_large";

pub fn valid_messages(messages: &[ChatMessage]) -> bool {
    !messages.is_empty()
        && messages.len() <= MAX_MESSAGES
        && messages.last().is_some_and(|m| m.role == "user")
        && messages.iter().all(|m| {
            matches!(m.role.as_str(), "user" | "assistant")
                && !m.content.trim().is_empty()
                && m.content.chars().count() <= MAX_MESSAGE_CHARS
        })
        && messages.iter().map(|m| m.content.chars().count()).sum::<usize>() <= MAX_TOTAL_CHARS
}

/// Admits a new remote run: at most `MAX_CONCURRENT` at once and `RATE_MAX` starts per window.
#[derive(Default)]
pub struct Limiter {
    starts: VecDeque<Instant>,
}

impl Limiter {
    pub fn admit(&mut self, now: Instant, active: usize) -> Result<(), &'static str> {
        while self.starts.front().is_some_and(|t| now.duration_since(*t) >= RATE_WINDOW) {
            self.starts.pop_front();
        }
        if active >= MAX_CONCURRENT {
            return Err("byok_busy");
        }
        if self.starts.len() >= RATE_MAX {
            return Err(RATE_LIMITED);
        }
        self.starts.push_back(now);
        Ok(())
    }
}

pub enum Pick<'a> {
    Api(&'a Connection, String),
    Cli(String, Option<String>),
}

/// The only place that decides whether the phone may use a source.
pub fn authorize<'a>(file: &'a StoreFile, source: &str, id: &str, model: Option<&str>) -> Result<Pick<'a>, &'static str> {
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    match source {
        "api" => {
            let connection = file.connections.iter().find(|c| c.id == id).ok_or(NOT_ALLOWED)?;
            if !connection.enabled || !connection.remote_allowed {
                return Err(NOT_ALLOWED);
            }
            let model = model.map(str::to_owned).or_else(|| connection.default_model.clone()).ok_or("byok_invalid_request")?;
            if !http::valid_model(connection.kind, &model) {
                return Err("byok_invalid_request");
            }
            Ok(Pick::Api(connection, model))
        }
        "cli" => {
            let setting: &CliSetting = file.cli.iter().find(|s| s.id == id).ok_or(NOT_ALLOWED)?;
            if !cli::known(id) || !setting.enabled || !setting.remote_allowed {
                return Err(NOT_ALLOWED);
            }
            let model = model.map(str::to_owned).or_else(|| setting.default_model.clone());
            if model.as_deref().is_some_and(|m| !cli::model_allowed(id, m)) {
                return Err("byok_invalid_request");
            }
            Ok(Pick::Cli(id.to_owned(), model))
        }
        _ => Err("byok_invalid_request"),
    }
}

/// What the phone is told about an allowed source: a name and models. Never a key, URL or path.
#[derive(Debug, PartialEq)]
pub struct Row {
    pub source: &'static str,
    pub id: String,
    pub name: String,
    pub default_model: Option<String>,
}

pub fn allowed_rows(file: &StoreFile) -> Vec<Row> {
    let mut rows: Vec<Row> = file
        .connections
        .iter()
        .filter(|c| c.enabled && c.remote_allowed)
        .map(|c| Row { source: "api", id: c.id.clone(), name: c.name.clone(), default_model: c.default_model.clone() })
        .collect();
    rows.extend(file.cli.iter().filter(|s| cli::known(&s.id) && s.enabled && s.remote_allowed).map(|s| Row {
        source: "cli",
        id: s.id.clone(),
        name: String::new(),
        default_model: s.default_model.clone(),
    }));
    rows
}

/// Short, printable model names only, default first, bounded.
pub fn clean_models(models: Vec<String>, default: Option<&str>) -> Vec<String> {
    let ok = |m: &String| !m.is_empty() && m.chars().count() <= MAX_MODEL_CHARS && !m.chars().any(char::is_control);
    let mut out: Vec<String> = Vec::new();
    for model in default.map(str::to_owned).into_iter().chain(models) {
        if ok(&model) && !out.contains(&model) {
            out.push(model);
        }
    }
    out.truncate(MAX_MODELS);
    out
}

#[cfg(test)]
mod tests {
    use super::super::store::Kind;
    use super::*;

    const ID: &str = "11111111-1111-4111-8111-111111111111";

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage { role: role.into(), content: content.into() }
    }

    fn connection(enabled: bool, remote_allowed: bool) -> Connection {
        Connection {
            id: ID.into(),
            kind: Kind::Openai,
            name: "OpenAI".into(),
            base_url: None,
            default_model: Some("gpt-5".into()),
            enabled,
            key_hint: Some("1234".into()),
            has_key: true,
            remote_allowed,
        }
    }

    fn file(enabled: bool, remote_allowed: bool, cli_on: bool, cli_remote: bool) -> StoreFile {
        StoreFile {
            connections: vec![connection(enabled, remote_allowed)],
            cli: vec![CliSetting { id: "claude".into(), enabled: cli_on, default_model: Some("sonnet".into()), remote_allowed: cli_remote }],
        }
    }

    #[test]
    fn a_source_is_usable_from_the_phone_only_when_enabled_and_switched_on() {
        for (enabled, remote, ok) in [(true, true, true), (true, false, false), (false, true, false), (false, false, false)] {
            let f = file(enabled, remote, enabled, remote);
            assert_eq!(authorize(&f, "api", ID, None).is_ok(), ok, "api {enabled} {remote}");
            assert_eq!(authorize(&f, "cli", "claude", None).is_ok(), ok, "cli {enabled} {remote}");
        }
        let f = file(true, false, true, false);
        assert_eq!(authorize(&f, "api", ID, None).err(), Some(NOT_ALLOWED));
        assert_eq!(authorize(&f, "cli", "claude", None).err(), Some(NOT_ALLOWED));
    }

    #[test]
    fn unknown_sources_ids_models_and_kinds_are_refused() {
        let f = file(true, true, true, true);
        assert_eq!(authorize(&f, "api", "other", None).err(), Some(NOT_ALLOWED));
        assert_eq!(authorize(&f, "cli", "codex", None).err(), Some(NOT_ALLOWED));
        assert_eq!(authorize(&f, "cli", "claude", Some("not a model!")).err(), Some("byok_invalid_request"));
        assert_eq!(authorize(&f, "api", ID, Some("bad model")).err(), Some("byok_invalid_request"));
        assert_eq!(authorize(&f, "shell", "claude", None).err(), Some("byok_invalid_request"));
        match authorize(&f, "api", ID, None).unwrap() {
            Pick::Api(_, model) => assert_eq!(model, "gpt-5"),
            Pick::Cli(..) => panic!("expected api"),
        }
        match authorize(&f, "cli", "claude", None).unwrap() {
            Pick::Cli(id, model) => assert_eq!((id.as_str(), model.as_deref()), ("claude", Some("sonnet"))),
            Pick::Api(..) => panic!("expected cli"),
        }
    }

    #[test]
    fn the_phone_is_only_told_about_allowed_sources() {
        let rows = allowed_rows(&file(true, true, true, false));
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].source, rows[0].id.as_str(), rows[0].name.as_str()), ("api", ID, "OpenAI"));
        assert!(allowed_rows(&file(true, false, false, false)).is_empty());
        assert_eq!(allowed_rows(&file(false, true, true, true)).iter().filter(|r| r.source == "api").count(), 0);
        let debug = format!("{:?}", allowed_rows(&file(true, true, true, true)));
        assert!(!debug.contains("1234") && !debug.contains("key_hint"));
    }

    #[test]
    fn remote_prompts_are_smaller_than_local_chat() {
        assert!(valid_messages(&[msg("user", "a")]));
        assert!(!valid_messages(&[msg("user", "a"), msg("assistant", "b")]));
        assert!(!valid_messages(&[msg("system", "a")]));
        assert!(!valid_messages(&[msg("user", &"あ".repeat(MAX_MESSAGE_CHARS + 1))]));
        let many: Vec<_> = (0..MAX_MESSAGES + 1).map(|i| msg(if i % 2 == 0 { "user" } else { "assistant" }, "x")).collect();
        assert!(!valid_messages(&many));
        let big: Vec<_> = (0..5).map(|i| msg(if i % 2 == 0 { "user" } else { "assistant" }, &"x".repeat(MAX_MESSAGE_CHARS))).collect();
        assert!(!valid_messages(&big), "total {} must exceed {MAX_TOTAL_CHARS}", 5 * MAX_MESSAGE_CHARS);
        assert!(MAX_MESSAGE_CHARS < 20_000 && MAX_TOTAL_CHARS < 400_000);
    }

    #[test]
    fn one_run_at_a_time_and_a_bounded_number_per_window() {
        let mut limiter = Limiter::default();
        let t0 = Instant::now();
        assert_eq!(limiter.admit(t0, 1), Err("byok_busy"));
        for i in 0..RATE_MAX {
            assert!(limiter.admit(t0 + Duration::from_secs(i as u64), 0).is_ok());
        }
        assert_eq!(limiter.admit(t0 + Duration::from_secs(30), 0), Err(RATE_LIMITED));
        // A busy refusal does not use up a slot; the oldest start leaves the window later.
        assert!(limiter.admit(t0 + RATE_WINDOW + Duration::from_secs(1), 0).is_ok());
    }

    #[test]
    fn model_lists_are_short_printable_and_default_first() {
        let long = "m".repeat(200);
        let models = clean_models(vec!["b".into(), "a".into(), "b".into(), long, "x\ny".into(), String::new()], Some("z"));
        assert_eq!(models, ["z", "b", "a"]);
        let many: Vec<String> = (0..100).map(|i| format!("m{i}")).collect();
        assert_eq!(clean_models(many, None).len(), MAX_MODELS);
    }

    #[test]
    fn remote_cli_arguments_are_the_same_read_only_list_as_local() {
        let claude = cli::build_args("claude", Some("sonnet")).unwrap();
        assert!(claude.contains(&"--disallowedTools".to_string()));
        let codex = cli::build_args("codex", None).unwrap();
        assert!(codex.contains(&"read-only".to_string()));
        assert!(cli::scratch_dir().unwrap().ends_with("cli-scratch"));
    }
}
