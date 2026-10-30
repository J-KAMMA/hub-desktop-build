//! Installed AI CLIs (Claude Code, Codex, Gemini CLI) used on the operator's own login.
//!
//! Reuses `local_cli` for program lookup and window-less spawning and `cli_auth` for the login
//! probe. Hub never reads, copies or forwards a CLI's credentials: login state is derived from the
//! CLI's own status output (claude, codex) or from the mere presence of its credential file
//! (gemini, whose CLI has no status command). The prompt travels on stdin, never in an argument.

use super::{ChatMessage, FAILED_CLI, NOT_LOGGED_IN};
use crate::cli_auth::AuthState;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(240);
const TRANSCRIPT_LIMIT: usize = 100_000;
const GEMINI_PROMPT: &str = "Reply to the conversation given on standard input.";

pub const IDS: [&str; 3] = ["claude", "codex", "gemini"];

pub fn known(id: &str) -> bool {
    IDS.contains(&id)
}

fn label(id: &str) -> &'static str {
    match id {
        "claude" => "Claude Code",
        "codex" => "OpenAI Codex",
        _ => "Gemini CLI",
    }
}

/// Models offered for each CLI. Gemini accepts a free (plain) model name; the other two only the
/// aliases the existing relay already allows.
pub fn suggested_models(id: &str) -> Vec<&'static str> {
    match id {
        "claude" => vec!["haiku", "sonnet", "opus"],
        "codex" => vec!["gpt-5.6-luna", "gpt-5.6-sol"],
        _ => vec!["gemini-2.5-pro", "gemini-2.5-flash"],
    }
}

pub fn model_allowed(id: &str, model: &str) -> bool {
    match id {
        "claude" | "codex" => suggested_models(id).contains(&model),
        "gemini" => !model.is_empty() && model.len() <= 64 && model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')),
        _ => false,
    }
}

#[derive(Debug, PartialEq, Eq, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum LoginState {
    NotInstalled,
    LoggedIn,
    NotLoggedIn,
    Unknown,
}

pub fn login_state(auth: AuthState) -> LoginState {
    match auth {
        AuthState::Configured => LoginState::LoggedIn,
        AuthState::Missing => LoginState::NotLoggedIn,
        AuthState::Unavailable => LoginState::NotInstalled,
        AuthState::Unknown | AuthState::Unsupported => LoginState::Unknown,
    }
}

/// Gemini has no status command. A credential file or an API-key variable counts as "has a
/// login"; nothing else can be known without reading it, which we do not do.
pub fn gemini_auth(credential_file: bool, key_variable: bool) -> AuthState {
    if credential_file || key_variable {
        AuthState::Configured
    } else {
        AuthState::Unknown
    }
}

fn gemini_binary() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["gemini.exe", "gemini.cmd"] } else { &["gemini"] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .filter(|d| d.is_absolute())
        .collect();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

fn gemini_state() -> AuthState {
    if gemini_binary().is_none() {
        return AuthState::Unavailable;
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    let file = home.is_some_and(|h| h.join(".gemini").join("oauth_creds.json").is_file());
    let variable = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].iter().any(|n| std::env::var_os(n).is_some_and(|v| !v.is_empty()));
    gemini_auth(file, variable)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub state: LoginState,
    pub suggested_models: Vec<&'static str>,
}

pub async fn detect() -> Vec<CliInfo> {
    let mut out = Vec::new();
    for id in IDS {
        let auth = match id {
            "gemini" => gemini_state(),
            _ => crate::cli_auth::probe(id).await,
        };
        out.push(CliInfo { id, label: label(id), state: login_state(auth), suggested_models: suggested_models(id) });
    }
    out
}

/// Fixed argument lists. Nothing the user typed appears here except a model name that has
/// already passed `model_allowed`.
pub fn build_args(id: &str, model: Option<&str>) -> Result<Vec<String>, &'static str> {
    if let Some(m) = model {
        if !model_allowed(id, m) {
            return Err("byok_invalid_request");
        }
    }
    let mut args: Vec<String> = Vec::new();
    match id {
        "claude" => {
            args.extend(["-p", "--output-format", "text", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,Task,Agent"].map(String::from));
            if let Some(m) = model {
                args.extend(["--model".into(), m.into()]);
            }
        }
        "codex" => {
            args.extend(["exec", "-", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--color", "never"].map(String::from));
            if let Some(m) = model {
                args.extend(["-m".into(), m.into()]);
            }
        }
        "gemini" => {
            args.extend(["-p".into(), GEMINI_PROMPT.into()]);
            if let Some(m) = model {
                args.extend(["-m".into(), m.into()]);
            }
        }
        _ => return Err("byok_invalid_request"),
    }
    Ok(args)
}

fn program(id: &str) -> Option<(PathBuf, Vec<String>)> {
    match id {
        "claude" => crate::local_cli::claude_binary().map(|p| (p, vec![])),
        "codex" => crate::local_cli::codex_command(),
        "gemini" => gemini_binary().map(|p| (p, vec![])),
        _ => None,
    }
}

/// One user message goes through as it is; a longer conversation becomes a labelled transcript,
/// trimmed from the oldest end.
pub fn transcript(messages: &[ChatMessage]) -> String {
    let text = if messages.len() == 1 {
        messages[0].content.clone()
    } else {
        let mut parts: Vec<String> = messages
            .iter()
            .map(|m| format!("{}:\n{}", if m.role == "assistant" { "Assistant" } else { "User" }, m.content))
            .collect();
        parts.push("Assistant:".into());
        parts.join("\n\n")
    };
    let count = text.chars().count();
    if count <= TRANSCRIPT_LIMIT {
        text
    } else {
        text.chars().skip(count - TRANSCRIPT_LIMIT).collect()
    }
}

/// App-owned scratch directory, so a CLI started for chat has no project to read or write.
pub fn scratch_dir() -> Result<PathBuf, &'static str> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = base.join("jkamma-hub").join("cli-scratch");
    std::fs::create_dir_all(&dir).map_err(|_| FAILED_CLI)?;
    Ok(dir)
}

/// Moves the longest valid UTF-8 prefix out of `pending`, keeping an incomplete tail.
pub fn take_valid_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(text) => {
            let out = text.to_owned();
            pending.clear();
            out
        }
        Err(error) => {
            let valid = error.valid_up_to();
            let tail_incomplete = error.error_len().is_none();
            let end = if tail_incomplete { valid } else { pending.len() };
            let out = String::from_utf8_lossy(&pending[..end]).into_owned();
            pending.drain(..end);
            out
        }
    }
}

pub fn failure_code(stderr: &str) -> &'static str {
    let lower = stderr.to_lowercase();
    if ["not logged in", "login", "log in", "authenticate", "unauthorized", "api key"].iter().any(|w| lower.contains(w)) {
        NOT_LOGGED_IN
    } else {
        FAILED_CLI
    }
}

/// Runs the CLI and hands text to `on_text` as it arrives. Output and time are bounded; the
/// child is killed if this future is dropped (cancel).
pub async fn run(id: &str, model: Option<&str>, messages: &[ChatMessage], mut on_text: impl FnMut(String)) -> Result<(), &'static str> {
    let (program, mut args) = program(id).ok_or("byok_cli_not_installed")?;
    args.extend(build_args(id, model)?);
    let prompt = transcript(messages);
    let mut child = crate::local_cli::quiet_command(program)
        .args(args)
        .current_dir(scratch_dir()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| FAILED_CLI)?;
    let mut stdin = child.stdin.take().ok_or(FAILED_CLI)?;
    tokio::spawn(async move {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });
    let mut stderr = child.stderr.take().ok_or(FAILED_CLI)?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = (&mut stderr).take(STDERR_LIMIT as u64).read_to_end(&mut bytes).await;
        // Keep draining so the child never blocks on a full pipe.
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let mut stdout = child.stdout.take().ok_or(FAILED_CLI)?;
    let read = async {
        let (mut pending, mut buffer, mut total) = (Vec::new(), [0u8; 4096], 0usize);
        loop {
            let n = stdout.read(&mut buffer).await.map_err(|_| FAILED_CLI)?;
            if n == 0 {
                break;
            }
            total += n;
            if total > OUTPUT_LIMIT {
                return Err("byok_response_too_large");
            }
            pending.extend_from_slice(&buffer[..n]);
            let text = take_valid_utf8(&mut pending);
            if !text.is_empty() {
                on_text(text);
            }
        }
        if !pending.is_empty() {
            on_text(String::from_utf8_lossy(&pending).into_owned());
        }
        Ok::<usize, &'static str>(total)
    };
    let total = match tokio::time::timeout(RUN_TIMEOUT, read).await {
        Ok(Ok(total)) => total,
        Ok(Err(code)) => {
            crate::dev_cli::terminate_process_tree(&mut child).await;
            return Err(code);
        }
        Err(_) => {
            crate::dev_cli::terminate_process_tree(&mut child).await;
            return Err("byok_timeout");
        }
    };
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
    let stderr_text = stderr_task.await.unwrap_or_default();
    let success = matches!(status, Ok(Ok(s)) if s.success());
    if total == 0 {
        // Codex writes its answer to stderr when stdout stays empty; any failure maps to a code.
        if success && !stderr_text.trim().is_empty() {
            on_text(stderr_text.trim().to_owned());
            return Ok(());
        }
        return Err(failure_code(&stderr_text));
    }
    if success { Ok(()) } else { Err(FAILED_CLI) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_states_map_to_the_four_shown_to_the_user() {
        assert_eq!(login_state(AuthState::Configured), LoginState::LoggedIn);
        assert_eq!(login_state(AuthState::Missing), LoginState::NotLoggedIn);
        assert_eq!(login_state(AuthState::Unavailable), LoginState::NotInstalled);
        assert_eq!(login_state(AuthState::Unknown), LoginState::Unknown);
        assert_eq!(login_state(AuthState::Unsupported), LoginState::Unknown);
        assert_eq!(serde_json::to_string(&LoginState::NotLoggedIn).unwrap(), "\"not_logged_in\"");
    }

    #[test]
    fn gemini_login_is_inferred_from_presence_only() {
        assert_eq!(gemini_auth(true, false), AuthState::Configured);
        assert_eq!(gemini_auth(false, true), AuthState::Configured);
        assert_eq!(gemini_auth(false, false), AuthState::Unknown);
    }

    #[test]
    fn arguments_are_fixed_lists_and_the_prompt_never_appears_in_them() {
        let claude = build_args("claude", Some("opus")).unwrap();
        assert_eq!(claude[0], "-p");
        assert!(claude.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(claude.contains(&"--disallowedTools".to_string()));
        let codex = build_args("codex", None).unwrap();
        assert_eq!(&codex[..3], ["exec", "-", "--sandbox"]);
        assert!(codex.contains(&"read-only".to_string()) && !codex.contains(&"-m".to_string()));
        let gemini = build_args("gemini", Some("gemini-2.5-pro")).unwrap();
        assert!(gemini.windows(2).any(|w| w == ["-m", "gemini-2.5-pro"]));
        assert_eq!(gemini[1], GEMINI_PROMPT);
    }

    #[test]
    fn models_and_ids_outside_the_allowlist_are_refused() {
        assert_eq!(build_args("claude", Some("sonnet; rm -rf /")), Err("byok_invalid_request"));
        assert_eq!(build_args("codex", Some("../../etc")), Err("byok_invalid_request"));
        assert_eq!(build_args("gemini", Some("a b")), Err("byok_invalid_request"));
        assert_eq!(build_args("sh", None), Err("byok_invalid_request"));
        assert!(!known("sh") && known("gemini"));
    }

    #[test]
    fn transcripts_keep_a_single_message_verbatim_and_trim_the_oldest() {
        let one = vec![ChatMessage { role: "user".into(), content: "そのまま".into() }];
        assert_eq!(transcript(&one), "そのまま");
        let many = vec![
            ChatMessage { role: "user".into(), content: "a".into() },
            ChatMessage { role: "assistant".into(), content: "b".into() },
            ChatMessage { role: "user".into(), content: "c".into() },
        ];
        assert_eq!(transcript(&many), "User:\na\n\nAssistant:\nb\n\nUser:\nc\n\nAssistant:");
        let huge = vec![ChatMessage { role: "user".into(), content: "あ".repeat(TRANSCRIPT_LIMIT + 5) }];
        assert_eq!(transcript(&huge).chars().count(), TRANSCRIPT_LIMIT);
    }

    #[test]
    fn utf8_decoding_keeps_a_split_character_for_the_next_read() {
        let bytes = "あい".as_bytes();
        let mut pending = bytes[..4].to_vec();
        assert_eq!(take_valid_utf8(&mut pending), "あ");
        assert_eq!(pending.len(), 1);
        pending.extend_from_slice(&bytes[4..]);
        assert_eq!(take_valid_utf8(&mut pending), "い");
        assert!(pending.is_empty());
    }

    #[test]
    fn stderr_is_only_classified_never_returned() {
        assert_eq!(failure_code("Error: Not logged in. Run `claude login`"), NOT_LOGGED_IN);
        assert_eq!(failure_code("segfault"), FAILED_CLI);
    }

    #[test]
    fn scratch_directory_is_app_owned() {
        let dir = scratch_dir().unwrap();
        assert!(dir.ends_with("cli-scratch") && dir.is_dir());
    }

    #[tokio::test]
    async fn a_missing_cli_is_reported_without_spawning_anything_else() {
        let messages = vec![ChatMessage { role: "user".into(), content: "x".into() }];
        let result = run("sh", None, &messages, |_| {}).await;
        assert_eq!(result, Err("byok_cli_not_installed"));
    }
}
