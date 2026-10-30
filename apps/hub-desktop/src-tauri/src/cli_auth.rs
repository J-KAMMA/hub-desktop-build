//! Local credential presence only. Never return CLI output or claim remote access.
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};

const OUTPUT_LIMIT: usize = 64 * 1024;
static PROBES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    Configured,
    Missing,
    Unknown,
    Unsupported,
    Unavailable,
}

#[derive(Serialize)]
pub struct AuthStatus {
    pub state: AuthState,
}

fn parse(program: &str, code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> AuthState {
    match program {
        "codex" => {
            // Codex writes status to stderr. Do not parse key suffixes or errors.
            let output = [stdout, stderr]
                .into_iter()
                .filter_map(|bytes| std::str::from_utf8(bytes).ok())
                .flat_map(str::lines)
                .map(str::trim)
                .collect::<Vec<_>>();
            let configured = output.iter().any(|line| {
                *line == "Logged in using ChatGPT"
                    || *line == "Logged in using an API key"
                    || line.starts_with("Logged in using an API key - ")
            });
            let missing = output.contains(&"Not logged in");
            match (code, configured, missing) {
                (Some(0), true, false) => AuthState::Configured,
                (Some(1), false, true) => AuthState::Missing,
                _ => AuthState::Unknown,
            }
        }
        "claude" => {
            let logged_in = serde_json::from_slice::<serde_json::Value>(stdout)
                .ok()
                .and_then(|value| value.get("loggedIn").and_then(|v| v.as_bool()));
            match (code, logged_in) {
                (Some(0), Some(true)) => AuthState::Configured,
                (Some(0 | 1), Some(false)) => AuthState::Missing,
                _ => AuthState::Unknown,
            }
        }
        _ => AuthState::Unsupported,
    }
}

async fn read_bounded(stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    stream
        .take((OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ())?;
    (bytes.len() <= OUTPUT_LIMIT).then_some(bytes).ok_or(())
}

async fn run(
    program: &str,
    command: &mut tokio::process::Command,
    deadline: Duration,
) -> AuthState {
    let Ok(mut child) = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    else {
        return AuthState::Unknown;
    };
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = tokio::time::timeout(deadline, async {
        tokio::try_join!(read_bounded(stdout), read_bounded(stderr), async {
            child.wait().await.map_err(|_| ())
        })
    })
    .await;
    match result {
        Ok(Ok((stdout, stderr, status))) => parse(program, status.code(), &stdout, &stderr),
        _ => {
            crate::dev_cli::terminate_process_tree(&mut child).await;
            let _ = child.wait().await;
            AuthState::Unknown
        }
    }
}

pub async fn probe(program: &str) -> AuthState {
    use crate::local_cli::{claude_binary, codex_command, quiet_command};
    // These fixed subcommands inspect local login state; no prompt, login, or logout.
    let mut command = match program {
        "codex" => {
            let Some((path, prefix)) = codex_command() else {
                return AuthState::Unavailable;
            };
            let mut command = quiet_command(path);
            command.args(prefix).args(["login", "status"]);
            command
        }
        "claude" => {
            let Some(path) = claude_binary() else {
                return AuthState::Unavailable;
            };
            let mut command = quiet_command(path);
            command.args(["auth", "status", "--json"]);
            command
        }
        _ => return AuthState::Unsupported,
    };
    let Ok(_permit) = PROBES.try_acquire() else {
        return AuthState::Unknown;
    };
    run(program, &mut command, Duration::from_secs(5)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_known_status_and_exit_combinations() {
        for (program, code, stdout, stderr, expected) in [
            (
                "codex",
                Some(0),
                "",
                "Logged in using ChatGPT\n",
                AuthState::Configured,
            ),
            (
                "codex",
                Some(0),
                "Logged in using an API key - fake-secret\n",
                "",
                AuthState::Configured,
            ),
            ("codex", Some(1), "", "Not logged in\n", AuthState::Missing),
            ("codex", Some(0), "", "", AuthState::Unknown),
            ("codex", Some(0), "", "Not logged in", AuthState::Unknown),
            (
                "codex",
                Some(1),
                "",
                "Logged in using ChatGPT",
                AuthState::Unknown,
            ),
            (
                "codex",
                Some(0),
                "Logged in using ChatGPT",
                "Not logged in",
                AuthState::Unknown,
            ),
            (
                "codex",
                None,
                "",
                "Logged in using ChatGPT",
                AuthState::Unknown,
            ),
            (
                "claude",
                Some(0),
                r#"{"loggedIn":true,"email":"private@example.test"}"#,
                "",
                AuthState::Configured,
            ),
            (
                "claude",
                Some(1),
                r#"{"loggedIn":false}"#,
                "",
                AuthState::Missing,
            ),
            (
                "claude",
                Some(0),
                r#"{"loggedIn":false}"#,
                "",
                AuthState::Missing,
            ),
            (
                "claude",
                Some(2),
                r#"{"loggedIn":false}"#,
                "",
                AuthState::Unknown,
            ),
            (
                "claude",
                Some(1),
                r#"{"loggedIn":true}"#,
                "",
                AuthState::Unknown,
            ),
            (
                "claude",
                Some(0),
                r#"{"loggedIn":"true"}"#,
                "",
                AuthState::Unknown,
            ),
            ("claude", Some(0), "{}", "", AuthState::Unknown),
            ("claude", Some(0), "{", "", AuthState::Unknown),
            (
                "custom",
                Some(0),
                "Logged in using ChatGPT",
                "",
                AuthState::Unsupported,
            ),
        ] {
            let state = parse(program, code, stdout.as_bytes(), stderr.as_bytes());
            assert_eq!(state, expected);
            let safe = serde_json::to_string(&AuthStatus { state }).unwrap();
            assert!(!safe.contains("private") && !safe.contains("secret"));
        }
        assert_eq!(parse("claude", Some(0), &[255], &[]), AuthState::Unknown);
    }

    #[tokio::test]
    async fn output_limit_includes_exact_boundary_and_rejects_overflow() {
        assert_eq!(
            read_bounded(&vec![0; OUTPUT_LIMIT][..])
                .await
                .unwrap()
                .len(),
            OUTPUT_LIMIT
        );
        assert!(read_bounded(&vec![0; OUTPUT_LIMIT + 1][..]).await.is_err());
    }

    #[tokio::test]
    async fn process_errors_timeout_and_both_output_limits_are_unknown() {
        for script in [
            "console.log(JSON.stringify({loggedIn:true})); process.exitCode=1",
            "process.stdout.write('x'.repeat(65537)); setInterval(()=>{},1000)",
            "process.stderr.write('x'.repeat(65537)); setInterval(()=>{},1000)",
            "setInterval(()=>{},1000)",
        ] {
            let mut command = crate::local_cli::quiet_command("node");
            command.args(["-e", script]);
            assert_eq!(
                run("claude", &mut command, Duration::from_millis(500)).await,
                AuthState::Unknown
            );
        }
        let mut command = crate::local_cli::quiet_command("node");
        command.args([
            "-e",
            "console.log(JSON.stringify({loggedIn:true,email:'hidden'}))",
        ]);
        assert_eq!(
            run("claude", &mut command, Duration::from_secs(5)).await,
            AuthState::Configured
        );
        let mut missing = crate::local_cli::quiet_command("hub-nonexistent-auth-probe-binary");
        assert_eq!(
            run("codex", &mut missing, Duration::from_secs(1)).await,
            AuthState::Unknown
        );
        assert_eq!(probe("custom-do-not-run").await, AuthState::Unsupported);
    }

    #[tokio::test]
    #[ignore = "reads installed CLI local auth status; emits only normalized state"]
    async fn installed_cli_auth_status_is_sanitized() {
        for program in ["codex", "claude"] {
            let state = probe(program).await;
            println!(
                "{program}: {}",
                serde_json::to_string(&AuthStatus { state }).unwrap()
            );
        }
    }
}
