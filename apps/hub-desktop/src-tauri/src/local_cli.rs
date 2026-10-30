// Relay to the coding CLIs this machine is already signed in to.
//
// This is the one place the Runner starts a host process rather than a
// container. Docker isolation exists to contain *generated code*; these are the
// operator's own installed tools, invoked with a fixed argument list and given
// the prompt on stdin, so nothing from the request reaches a shell. The
// executables are resolved from their install paths rather than PATH, and any
// other value of `agent` is rejected before a process is created.
//
// Subscriptions are personal. The Runner listens on loopback and requires a
// pairing session, so a request can only originate from this machine's own
// browser session.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const MAX_PROMPT_CHARS: usize = 12_000;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(240);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAgent {
    pub id: &'static str,
    pub label: &'static str,
    pub available: bool,
    pub models: Vec<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRequest {
    pub agent: String,
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResponse {
    pub agent: String,
    pub model: String,
    pub text: String,
    pub elapsed_ms: u64,
}

fn app_data() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

/// Environment variables are process-global, so a test that redirects APPDATA
/// races every other test resolving tools through it. Serialise those tests on
/// this lock; poisoning means a sibling test already failed, so ignore it.
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Start a console program without giving it a console.
///
/// The CLIs are console applications, so Windows hands each one a window unless
/// told otherwise. From a desktop app that means a black box appearing on the
/// operator's screen for every call, and during a development run, one per tool
/// invocation. Shared with dev_cli so both spawn paths behave the same.
pub(crate) fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        // tokio's Command carries creation_flags itself on Windows; the std
        // CommandExt trait is not the one in play here.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The same, for the blocking `std` Command.
///
/// Without this every `git` and `docker` call opens a console window. The app
/// asks about isolation once a second, so on Windows that is a window flashing
/// on the operator's screen once a second, forever.
pub(crate) fn quiet_std_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

// Shared with dev_cli. Duplicating these lookups is how the development route
// first shipped reporting "claude not installed" on a machine that had it: the
// copy guessed a different install path.
pub(crate) fn claude_binary() -> Option<PathBuf> {
    if cfg!(windows) {
        let path = app_data()?.join("npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe");
        path.exists().then_some(path)
    } else {
        Some(PathBuf::from("claude"))
    }
}

/// Codex can be installed as the npm package or as the desktop app. Return the
/// actual program plus any prefix arguments instead of pretending every install
/// is a JavaScript file that must be passed to Node.
pub(crate) fn codex_command() -> Option<(PathBuf, Vec<String>)> {
    if let Some(path) = app_data()
        .map(|base| base.join("npm/node_modules/@openai/codex/bin/codex.js"))
        .filter(|path| path.is_file())
    {
        return Some((
            PathBuf::from("node"),
            vec![path.to_string_lossy().into_owned()],
        ));
    }
    let path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join(if cfg!(windows) { "codex.exe" } else { "codex" }))
        .find(|path| path.is_file())?;
    Some((path, Vec::new()))
}

pub fn agents() -> Vec<CliAgent> {
    vec![
        CliAgent {
            id: "claude",
            label: "Claude Code",
            available: claude_binary().is_some(),
            models: vec!["haiku", "sonnet", "opus"],
        },
        CliAgent {
            id: "codex",
            label: "Codex",
            available: codex_command().is_some(),
            models: vec!["gpt-5.6-luna", "gpt-5.6-sol"],
        },
    ]
}

fn claude_model(requested: Option<&str>) -> &'static str {
    match requested {
        Some("opus") => "opus",
        Some("haiku") => "haiku",
        _ => "sonnet",
    }
}

fn codex_model(requested: Option<&str>) -> &'static str {
    match requested {
        Some("gpt-5.6-sol") => "gpt-5.6-sol",
        _ => "gpt-5.6-luna",
    }
}

fn effort(requested: Option<&str>) -> &'static str {
    match requested {
        Some("low") => "low",
        Some("high") => "high",
        _ => "medium",
    }
}

pub async fn run(input: CliRequest) -> Result<CliResponse, &'static str> {
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() || prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("invalid prompt");
    }

    let model_requested = input.model.as_deref();
    let (program, args, model): (PathBuf, Vec<String>, String) = match input.agent.as_str() {
        "claude" => {
            let binary = claude_binary().ok_or("claude not installed")?;
            let model = claude_model(model_requested);
            (
                binary,
                vec![
                    "-p".into(),
                    "--model".into(),
                    model.into(),
                    "--output-format".into(),
                    "text".into(),
                    // Read-only by construction: the relay answers questions, it
                    // does not let a browser edit this machine.
                    "--disallowedTools".into(),
                    "Bash,Edit,Write,NotebookEdit,Task,Agent".into(),
                ],
                model.to_string(),
            )
        }
        "codex" => {
            let (program, mut args) = codex_command().ok_or("codex not installed")?;
            let model = codex_model(model_requested);
            args.extend([
                "exec".into(),
                "-".into(),
                "--sandbox".into(),
                "read-only".into(),
                "--ephemeral".into(),
                "--skip-git-repo-check".into(),
                "--color".into(),
                "never".into(),
                "-m".into(),
                model.into(),
                "-c".into(),
                format!(
                    "model_reasoning_effort=\"{}\"",
                    effort(input.effort.as_deref())
                ),
            ]);
            (program, args, model.to_string())
        }
        _ => return Err("unknown agent"),
    };

    let started = std::time::Instant::now();
    let mut child = quiet_command(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "spawn failed")?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    let output = timeout(RUN_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "timed out")?
        .map_err(|_| "agent failed")?;

    let mut text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        // Codex writes its transcript to stderr; the banner alone is not an answer.
        text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    }
    if text.is_empty() {
        return Err("agent returned nothing");
    }
    if text.len() > MAX_OUTPUT_BYTES {
        text.truncate(MAX_OUTPUT_BYTES);
    }

    Ok(CliResponse {
        agent: input.agent,
        model,
        text,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_agents_before_spawning() {
        let request = CliRequest {
            agent: "sh".into(),
            prompt: "ok".into(),
            model: None,
            effort: None,
        };
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(run(request));
        assert_eq!(result.err(), Some("unknown agent"));
    }

    #[test]
    fn rejects_empty_and_oversized_prompts() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        for prompt in ["   ".to_string(), "あ".repeat(MAX_PROMPT_CHARS + 1)] {
            let request = CliRequest {
                agent: "claude".into(),
                prompt,
                model: None,
                effort: None,
            };
            assert_eq!(runtime.block_on(run(request)).err(), Some("invalid prompt"));
        }
    }

    #[test]
    fn only_known_models_and_efforts_are_passed_through() {
        assert_eq!(claude_model(Some("rm -rf /")), "sonnet");
        assert_eq!(codex_model(Some("../../etc/passwd")), "gpt-5.6-luna");
        assert_eq!(effort(Some("; shutdown")), "medium");
    }
}
